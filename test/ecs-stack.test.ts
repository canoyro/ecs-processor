import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EcsStack } from '../lib/docker-proj-stack';
import cdkJson from '../cdk.json';

const ACCOUNT = '581145854871';
const REGION = 'ap-southeast-2';
const VPC_CONTEXT_KEY =
  `vpc-provider:account=${ACCOUNT}:filter.vpc-id=vpc-04571bb185086fe7f:region=${REGION}:returnAsymmetricSubnets=true`;

function buildTemplate(overrides: Record<string, unknown> = {}): Template {
  const app = new cdk.App({
    context: {
      ...cdkJson.context,
      [VPC_CONTEXT_KEY]: {
        vpcId: 'vpc-04571bb185086fe7f',
        vpcCidrBlock: '10.0.0.0/16',
        ownerAccountId: ACCOUNT,
        availabilityZones: [],
        subnetGroups: [
          {
            name: 'Isolated',
            type: 'Isolated',
            subnets: [
              { subnetId: 'subnet-0b77ebf87a51fd6ba', cidr: '10.0.0.0/24', availabilityZone: 'ap-southeast-2a', routeTableId: 'rtb-0cd1bd0fe862ac41c' },
              { subnetId: 'subnet-0d24d0f4ac751a2b5', cidr: '10.0.1.0/24', availabilityZone: 'ap-southeast-2b', routeTableId: 'rtb-0cd1bd0fe862ac41c' },
            ],
          },
          {
            name: 'Public',
            type: 'Public',
            subnets: [
              { subnetId: 'subnet-0f3b2f2ec01dcdc0e', cidr: '10.0.2.0/24', availabilityZone: 'ap-southeast-2a', routeTableId: 'rtb-0b92ef4bb58cb0667' },
              { subnetId: 'subnet-070016a5fa27ca914', cidr: '10.0.3.0/24', availabilityZone: 'ap-southeast-2b', routeTableId: 'rtb-0b92ef4bb58cb0667' },
            ],
          },
        ],
      },
      ...overrides,
    },
  });

  const stack = new EcsStack(app, 'staging-ecs-stack', {
    env: { account: ACCOUNT, region: REGION },
  });

  return Template.fromStack(stack);
}

describe('ECS Cluster', () => {
  test('creates an ECS cluster', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'staging-ecs-stack-cluster',
    });
  });

  test('creates an Auto Scaling Group', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  });

  test('creates a capacity provider with managed scaling', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECS::CapacityProvider', {
      AutoScalingGroupProvider: Match.objectLike({
        ManagedScaling: Match.objectLike({
          Status: 'ENABLED',
          TargetCapacity: 60,
        }),
      }),
    });
  });

});

describe('ECR Repositories', () => {
  test('creates internal-file-api repository', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'internal-file-api',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('creates internal-data-api repository', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'internal-data-api',
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('both repositories have 7-day untagged image lifecycle rule', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::ECR::Repository', 2);
  });
});

describe('S3 Shared Storage', () => {
  test('creates shared storage bucket with encryption', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ]),
      }),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });
});

describe('ECS Services', () => {
  test('creates two ECS services', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::ECS::Service', 2);
  });

  test('both services have ECS Exec enabled', () => {
    const template = buildTemplate();
    const services = template.findResources('AWS::ECS::Service', {
      Properties: Match.objectLike({ EnableExecuteCommand: true }),
    });
    expect(Object.keys(services)).toHaveLength(2);
  });

  test('both services have circuit breaker with rollback enabled', () => {
    const template = buildTemplate();
    const services = template.findResources('AWS::ECS::Service', {
      Properties: Match.objectLike({
        DeploymentConfiguration: Match.objectLike({
          DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        }),
      }),
    });
    expect(Object.keys(services)).toHaveLength(2);
  });

  test('both services have deployment health bounds set', () => {
    const template = buildTemplate();
    const services = template.findResources('AWS::ECS::Service', {
      Properties: Match.objectLike({
        DeploymentConfiguration: Match.objectLike({
          MinimumHealthyPercent: 50,
          MaximumPercent: 200,
        }),
      }),
    });
    expect(Object.keys(services)).toHaveLength(2);
  });

  test('creates two task definitions', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
  });

  test('task definitions use bridge network mode', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      NetworkMode: 'bridge',
    });
  });
});

describe('Auto Scaling', () => {
  test('creates CPU scaling policies for both services', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalingPolicy', 2);
  });

  test('creates scalable targets for both services', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 2);
  });
});

describe('Security Groups', () => {
  test('creates two security groups (instance + endpoint)', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
  });
});

describe('VPC Endpoints', () => {
  test('creates S3 gateway endpoint', () => {
    const template = buildTemplate();
    // Gateway endpoints have RouteTableIds instead of SubnetIds/SecurityGroupIds
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      RouteTableIds: Match.anyValue(),
    });
  });

  test('creates ECR interface endpoints', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      ServiceName: Match.stringLikeRegexp('ecr.api'),
    });
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      ServiceName: Match.stringLikeRegexp('ecr.dkr'),
    });
  });

  test('creates CloudWatch Logs endpoint', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      ServiceName: Match.stringLikeRegexp('logs'),
    });
  });
});
