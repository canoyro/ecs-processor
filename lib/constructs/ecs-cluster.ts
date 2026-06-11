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
  amiId: string;
}

export class EcsCluster extends Construct {
  readonly cluster: ecs.Cluster;
  readonly asg: autoscaling.AutoScalingGroup;
  readonly capacityProvider: ecs.AsgCapacityProvider;
  readonly bucket: s3.Bucket;
  readonly internalApiRepository: ecr.Repository;
  readonly internalDataRepository: ecr.Repository;
  readonly sshKeyPairName: string;
  readonly internalApiRepositoryUri: string;
  readonly internalDataRepositoryUri: string;
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

    this.internalDataRepository = new ecr.Repository(this, 'EcsInternalDataRepository', {
      repositoryName: 'internal-data-api',
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
    this.internalDataRepositoryUri = this.internalDataRepository.repositoryUri;

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
    });

    this.cluster.addDefaultCloudMapNamespace({ name: 'internal.local' });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      // Allow FUSE mounts to be accessed by non-root users (ECS task containers)
      'echo "user_allow_other" >> /etc/fuse.conf',
      // Install mountpoint-s3 from the AL2023 repo or fall back to the S3 release RPM
      // (the S3 gateway VPC endpoint routes this without internet access)
      'dnf install -y mount-s3 2>/dev/null || ' +
        '(curl -fsSL https://s3.amazonaws.com/mountpoint-s3-release/latest/x86_64/mount-s3.rpm' +
        ' -o /tmp/mount-s3.rpm && dnf install -y /tmp/mount-s3.rpm && rm -f /tmp/mount-s3.rpm)',
      'mkdir -p /mnt/s3-shared',
    );
    userData.addCommands(
      // Systemd service keeps the S3 mount alive across reboots
      `cat > /etc/systemd/system/mountpoint-s3.service <<EOF
[Unit]
Description=S3 Mountpoint shared storage
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/mount-s3 ${this.bucket.bucketName} /mnt/s3-shared --allow-other --allow-delete --foreground
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF`,
      'systemctl daemon-reload',
      'systemctl enable --now mountpoint-s3',
    );

    this.asg = new autoscaling.AutoScalingGroup(this, 'EcsAsg', {
      vpc,
      vpcSubnets,
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.genericLinux({ [cdk.Stack.of(this).region]: props.amiId }),
      securityGroup: instanceSg,
      role: instanceRole,
      keyPair: sshKeyPair,
      userData,
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
