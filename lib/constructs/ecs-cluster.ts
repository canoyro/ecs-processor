import * as cdk from 'aws-cdk-lib/core';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface EcsClusterProps {
  vpc: ec2.IVpc;
  vpcSubnets: ec2.SubnetSelection;
  instanceSg: ec2.SecurityGroup;
  instanceType: string;
}

export class EcsCluster extends Construct {
  readonly cluster: ecs.Cluster;
  readonly asg: autoscaling.AutoScalingGroup;
  readonly capacityProvider: ecs.AsgCapacityProvider;
  readonly bucket: s3.Bucket;
  readonly internalApiRepository: ecr.Repository;
  readonly sshKeyPairName: string;
  readonly internalApiRepositoryUri: string;
  readonly sharedStorageBucketName: string;

  constructor(scope: Construct, id: string, props: EcsClusterProps) {
    super(scope, id);

    const { vpc, vpcSubnets, instanceSg } = props;
    const stackName = cdk.Stack.of(this).stackName;

    this.bucket = new s3.Bucket(this, 'EcsSharedStorageBucket', {
      bucketName: `${stackName.toLowerCase()}-shared-storage`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
    this.sharedStorageBucketName = this.bucket.bucketName;

    this.internalApiRepository = new ecr.Repository(this, 'EcsInternalApiRepository', {
      repositoryName: 'internal-file-api',
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: 'Expire untagged images after 7 days',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(7),
        },
      ],
    });
    this.internalApiRepositoryUri = this.internalApiRepository.repositoryUri;

    const sshKeyPair = new ec2.KeyPair(this, 'EcsSshKeyPair', {
      keyPairName: `${stackName.toLowerCase()}-ssh-key`,
      format: ec2.KeyPairFormat.PEM,
      type: ec2.KeyPairType.RSA,
    });
    this.sshKeyPairName = sshKeyPair.keyPairName;

    const instanceRole = new iam.Role(this, 'EcsInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonEC2ContainerServiceforEC2Role'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [this.bucket.bucketArn],
    }));
    instanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:HeadObject'],
      resources: [`${this.bucket.bucketArn}/*`],
    }));

    this.cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName: `${stackName}-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    this.cluster.addDefaultCloudMapNamespace({ name: 'internal.local' });

    this.asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
      vpc,
      vpcSubnets,
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2023(),
      securityGroup: instanceSg,
      role: instanceRole,
      keyPair: sshKeyPair,
      minCapacity: 1,
      maxCapacity: 4,
      healthChecks: autoscaling.HealthChecks.ec2({ gracePeriod: cdk.Duration.minutes(5) }),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: 1,
        waitOnResourceSignals: false,
      }),
    });
    this.asg.node.addDependency(sshKeyPair);
    cdk.Tags.of(this.asg).add('Name', `${stackName}-ecs-instance`);

    this.capacityProvider = new ecs.AsgCapacityProvider(this, 'EcsCapacityProvider', {
      autoScalingGroup: this.asg,
      enableManagedScaling: true,
      targetCapacityPercent: 60,
      enableManagedTerminationProtection: false,
    });

    this.cluster.addAsgCapacityProvider(this.capacityProvider);
  }
}
