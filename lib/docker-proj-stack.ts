import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { EcsSecurityGroups } from './constructs/ecs-security-groups.js';
import { EcsVpcEndpoints } from './constructs/ecs-vpc-endpoints.js';
import { EcsCluster } from './constructs/ecs-cluster.js';
import { EcsServices } from './constructs/ecs-services.js';

interface EcsParams {
  prefix: string;
  vpcId: string;
  subnetIds: string[];
  instanceType: string;
  amiId: string;
  desiredCount?: number;
}

const params: EcsParams = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8')
);

export class EcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'EcsVpc', { vpcId: params.vpcId });

    // SubnetFilter.byIds selects the target subnet; CDK resolves its route table
    // from the Vpc.fromLookup context — required for the S3 gateway endpoint to
    // inject its route into the subnet's existing route table.
    const vpcSubnets: ec2.SubnetSelection = {
      subnetFilters: [ec2.SubnetFilter.byIds(params.subnetIds)],
    };

    const sgs = new EcsSecurityGroups(this, 'EcsSgs', { vpc });

    new EcsVpcEndpoints(this, 'EcsEndpoints', {
      vpc,
      vpcSubnets,
      endpointSg: sgs.endpointSg,
    });

    const cluster = new EcsCluster(this, 'EcsCluster', {
      vpc,
      vpcSubnets,
      instanceSg: sgs.instanceSg,
      instanceType: params.instanceType,
      amiId: params.amiId,
    });

    new EcsServices(this, 'EcsServices', {
      cluster: cluster.cluster,
      bucket: cluster.bucket,
      internalApiRepository: cluster.internalApiRepository,
      internalDataRepository: cluster.internalDataRepository,
      desiredCount: params.desiredCount ?? 1,
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: cluster.cluster.clusterName,
      description: 'ECS cluster name',
    });
    new cdk.CfnOutput(this, 'EcsAsgName', {
      value: cluster.asg.autoScalingGroupName,
      description: 'ECS EC2 capacity provider Auto Scaling Group name',
    });
    new cdk.CfnOutput(this, 'EcsSshKeyPairName', {
      value: cluster.sshKeyPairName,
      description: 'SSH key pair name for ECS EC2 instances',
    });
    new cdk.CfnOutput(this, 'EcsInternalApiRepositoryUri', {
      value: cluster.internalApiRepositoryUri,
      description: 'ECR repository URI for the internal file API image',
    });
    new cdk.CfnOutput(this, 'EcsInternalDataRepositoryUri', {
      value: cluster.internalDataRepositoryUri,
      description: 'ECR repository URI for the internal data API image',
    });
    new cdk.CfnOutput(this, 'SharedStorageBucketName', {
      value: cluster.sharedStorageBucketName,
      description: 'S3 bucket name for shared storage via S3 Mountpoint',
    });
  }
}
