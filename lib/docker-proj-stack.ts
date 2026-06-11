import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { EcsSecurityGroups } from './constructs/ecs-security-groups.js';
import { EcsVpcEndpoints } from './constructs/ecs-vpc-endpoints.js';
import { EcsCluster } from './constructs/ecs-cluster.js';
import { EcsServices } from './constructs/ecs-services.js';

interface DockerParams {
  vpcId: string;
  subnetId: string;
  availabilityZone: string;
  instanceType: string;
}

const params: DockerParams = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8')
);

export class ECSStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'EcsVpc', { vpcId: params.vpcId });

    const routeTable = new ec2.CfnRouteTable(this, 'EcsRouteTable', {
      vpcId: vpc.vpcId,
      tags: [{ key: 'Name', value: `${this.stackName}-ecs-route-table` }],
    });

    new ec2.CfnSubnetRouteTableAssociation(this, 'EcsSubnetRouteTableAssociation', {
      subnetId: params.subnetId,
      routeTableId: routeTable.ref,
    });

    const subnet = ec2.Subnet.fromSubnetAttributes(this, 'EcsSubnet', {
      subnetId: params.subnetId,
      availabilityZone: params.availabilityZone,
      routeTableId: routeTable.ref,
    });
    const vpcSubnets = { subnets: [subnet] };

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
    });

    new EcsServices(this, 'EcsServices', {
      cluster: cluster.cluster,
      capacityProviderName: cluster.capacityProvider.capacityProviderName,
      bucket: cluster.bucket,
      internalApiRepository: cluster.internalApiRepository,
      instanceSg: sgs.instanceSg,
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
    new cdk.CfnOutput(this, 'SharedStorageBucketName', {
      value: cluster.sharedStorageBucketName,
      description: 'S3 bucket name for shared storage via S3 Mountpoint',
    });
  }
}
