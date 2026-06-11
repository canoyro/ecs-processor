import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface EcsServicesProps {
  cluster: ecs.Cluster;
  capacityProviderName: string;
  bucket: s3.Bucket;
  internalApiRepository: ecr.Repository;
  instanceSg: ec2.SecurityGroup;
}

export class EcsServices extends Construct {
  constructor(scope: Construct, id: string, props: EcsServicesProps) {
    super(scope, id);

    const { cluster, capacityProviderName, bucket, internalApiRepository, instanceSg } = props;
    const stackName = cdk.Stack.of(this).stackName;

    const logGroup = new logs.LogGroup(this, 'EcsLogGroup', {
      logGroupName: `/ecs/${stackName}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      retention: logs.RetentionDays.ONE_WEEK,
    });

    const executionRole = new iam.Role(this, 'EcsTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
    }));
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:HeadObject'],
      resources: [`${bucket.bucketArn}/*`],
    }));

    const taskDef = new ecs.Ec2TaskDefinition(this, 'InternalFileApiTaskDef', {
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole,
      taskRole,
    });

    taskDef.addVolume({
      name: 's3-shared',
      host: { sourcePath: '/mnt/s3-shared' },
    });

    const mountpointContainer = taskDef.addContainer('mountpoint-s3', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/mountpoint-s3/mountpoint-s3:latest'),
      command: [bucket.bucketName, '/mnt/s3-shared', '--allow-other', '--allow-delete'],
      essential: false,
      memoryReservationMiB: 128,
      privileged: true,
      linuxParameters: (() => {
        const lp = new ecs.LinuxParameters(scope, 'MountpointLinuxParams');
        lp.addDevices({ hostPath: '/dev/fuse', containerPath: '/dev/fuse' });
        return lp;
      })(),
      healthCheck: {
        command: ['CMD', 'mountpoint', '-q', '/mnt/s3-shared'],
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(15),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'mountpoint-s3',
        logGroup,
      }),
    });

    mountpointContainer.addMountPoints({
      containerPath: '/mnt/s3-shared',
      sourceVolume: 's3-shared',
      readOnly: false,
    });

    // CDK's MountPoint interface does not expose propagation — set it via L1 override.
    // "shared" propagation allows the FUSE mount to propagate from the sidecar to the host,
    // where the app container's bind mount then picks it up.
    const cfnTask = taskDef.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTask.addOverride('Properties.ContainerDefinitions.0.MountPoints.0.Propagation', 'shared');

    const appContainer = taskDef.addContainer('internal-file-api', {
      image: ecs.ContainerImage.fromEcrRepository(internalApiRepository, 'latest'),
      essential: true,
      memoryReservationMiB: 256,
      environment: {
        DATA_FILE: '/mnt/s3-shared/message.txt',
        PORT: '8080',
      },
      portMappings: [
        {
          containerPort: 8080,
          name: 'api',
          appProtocol: ecs.AppProtocol.http,
        },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'internal-file-api',
        logGroup,
      }),
    });

    appContainer.addMountPoints({
      containerPath: '/mnt/s3-shared',
      sourceVolume: 's3-shared',
      readOnly: false,
    });

    appContainer.addContainerDependencies({
      container: mountpointContainer,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    const service = new ecs.Ec2Service(this, 'InternalFileApiService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 2,
      securityGroups: [instanceSg],
      capacityProviderStrategies: [
        { capacityProvider: capacityProviderName, weight: 1 },
      ],
      serviceConnectConfiguration: {
        namespace: 'internal.local',
        services: [
          {
            portMappingName: 'api',
            dnsName: 'internal-file-api',
            port: 8080,
          },
        ],
      },
      placementStrategies: [ecs.PlacementStrategy.spreadAcrossInstances()],
    });

    service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 8 })
      .scaleOnCpuUtilization('InternalFileApiCpuScaling', {
        targetUtilizationPercent: 40,
        scaleInCooldown: cdk.Duration.minutes(5),
        scaleOutCooldown: cdk.Duration.minutes(5),
      });
  }
}
