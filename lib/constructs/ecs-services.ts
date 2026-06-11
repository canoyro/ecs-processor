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
  internalDataRepository: ecr.Repository;
  instanceSg: ec2.SecurityGroup;
}

export class EcsServices extends Construct {
  constructor(scope: Construct, id: string, props: EcsServicesProps) {
    super(scope, id);

    const { cluster, capacityProviderName, bucket, internalApiRepository, internalDataRepository, instanceSg } = props;
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
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    // ── internal-file-api ──────────────────────────────────────────────────────

    const fileApiTaskDef = new ecs.Ec2TaskDefinition(this, 'InternalFileApiTaskDef', {
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole,
      taskRole,
    });

    // Host path volume — mountpoint-s3 is mounted on the EC2 host at /mnt/s3-shared
    // via user data (see ecs-cluster.ts). The container bind-mounts from there.
    fileApiTaskDef.addVolume({
      name: 's3-shared',
      host: { sourcePath: '/mnt/s3-shared' },
    });

    const fileApiContainer = fileApiTaskDef.addContainer('internal-file-api', {
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

    fileApiContainer.addMountPoints({
      containerPath: '/mnt/s3-shared',
      sourceVolume: 's3-shared',
      readOnly: false,
    });

    const fileApiService = new ecs.Ec2Service(this, 'InternalFileApiService', {
      cluster,
      taskDefinition: fileApiTaskDef,
      desiredCount: 1,
      enableExecuteCommand: true,
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

    fileApiService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 8 })
      .scaleOnCpuUtilization('InternalFileApiCpuScaling', {
        targetUtilizationPercent: 40,
        scaleInCooldown: cdk.Duration.minutes(5),
        scaleOutCooldown: cdk.Duration.minutes(5),
      });

    // ── internal-data-api ──────────────────────────────────────────────────────

    const dataApiTaskDef = new ecs.Ec2TaskDefinition(this, 'InternalDataApiTaskDef', {
      networkMode: ecs.NetworkMode.AWS_VPC,
      executionRole,
      taskRole,
    });

    dataApiTaskDef.addVolume({
      name: 's3-shared',
      host: { sourcePath: '/mnt/s3-shared' },
    });

    const dataApiContainer = dataApiTaskDef.addContainer('internal-data-api', {
      image: ecs.ContainerImage.fromEcrRepository(internalDataRepository, 'latest'),
      essential: true,
      memoryReservationMiB: 256,
      environment: {
        LOG_FILE: '/mnt/s3-shared/log.json',
        PORT: '9090',
      },
      portMappings: [
        {
          containerPort: 9090,
          name: 'data',
          appProtocol: ecs.AppProtocol.http,
        },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'internal-data-api',
        logGroup,
      }),
    });

    dataApiContainer.addMountPoints({
      containerPath: '/mnt/s3-shared',
      sourceVolume: 's3-shared',
      readOnly: false,
    });

    const dataApiService = new ecs.Ec2Service(this, 'InternalDataApiService', {
      cluster,
      taskDefinition: dataApiTaskDef,
      desiredCount: 1,
      enableExecuteCommand: true,
      securityGroups: [instanceSg],
      capacityProviderStrategies: [
        { capacityProvider: capacityProviderName, weight: 1 },
      ],
      serviceConnectConfiguration: {
        namespace: 'internal.local',
        services: [
          {
            portMappingName: 'data',
            dnsName: 'internal-data-api',
            port: 9090,
          },
        ],
      },
      placementStrategies: [ecs.PlacementStrategy.spreadAcrossInstances()],
    });

    dataApiService.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 8 })
      .scaleOnCpuUtilization('InternalDataApiCpuScaling', {
        targetUtilizationPercent: 40,
        scaleInCooldown: cdk.Duration.minutes(5),
        scaleOutCooldown: cdk.Duration.minutes(5),
      });
  }
}
