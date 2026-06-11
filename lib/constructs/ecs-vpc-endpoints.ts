import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface EcsVpcEndpointsProps {
  vpc: ec2.IVpc;
  vpcSubnets: ec2.SubnetSelection;
  endpointSg: ec2.SecurityGroup;
}

export class EcsVpcEndpoints extends Construct {
  constructor(scope: Construct, id: string, props: EcsVpcEndpointsProps) {
    super(scope, id);

    const { vpc, vpcSubnets, endpointSg } = props;
    const stackName = cdk.Stack.of(this).stackName;

    const enableDnsSupport = new cr.AwsCustomResource(this, 'EnableEcsVpcDnsSupport', {
      onCreate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: { VpcId: vpc.vpcId, EnableDnsSupport: { Value: true } },
        physicalResourceId: cr.PhysicalResourceId.of(`${vpc.vpcId}-dns-support`),
      },
      onUpdate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: { VpcId: vpc.vpcId, EnableDnsSupport: { Value: true } },
        physicalResourceId: cr.PhysicalResourceId.of(`${vpc.vpcId}-dns-support`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });

    const enableDnsHostnames = new cr.AwsCustomResource(this, 'EnableEcsVpcDnsHostnames', {
      onCreate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: { VpcId: vpc.vpcId, EnableDnsHostnames: { Value: true } },
        physicalResourceId: cr.PhysicalResourceId.of(`${vpc.vpcId}-dns-hostnames`),
      },
      onUpdate: {
        service: 'EC2',
        action: 'modifyVpcAttribute',
        parameters: { VpcId: vpc.vpcId, EnableDnsHostnames: { Value: true } },
        physicalResourceId: cr.PhysicalResourceId.of(`${vpc.vpcId}-dns-hostnames`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
    });

    const interfaceEndpoints: [string, ec2.InterfaceVpcEndpointAwsService, string][] = [
      ['EcsSsmEndpoint', ec2.InterfaceVpcEndpointAwsService.SSM, 'ssm'],
      ['EcsEc2MessagesEndpoint', ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES, 'ec2messages'],
      ['EcsSsmMessagesEndpoint', ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES, 'ssmmessages'],
      ['EcsEcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR, 'ecr-api'],
      ['EcsEcrDockerEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER, 'ecr-docker'],
      ['EcsControlPlaneEndpoint', ec2.InterfaceVpcEndpointAwsService.ECS, 'ecs'],
      ['EcsAgentEndpoint', ec2.InterfaceVpcEndpointAwsService.ECS_AGENT, 'ecs-agent'],
      ['EcsTelemetryEndpoint', ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY, 'ecs-telemetry'],
      ['EcsCloudWatchLogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS, 'logs'],
    ];

    for (const [endpointId, service, tag] of interfaceEndpoints) {
      const endpoint = vpc.addInterfaceEndpoint(endpointId, {
        service,
        subnets: vpcSubnets,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
      cdk.Tags.of(endpoint).add('Name', `${stackName}-${tag}-endpoint`);
      endpoint.node.addDependency(enableDnsSupport);
      endpoint.node.addDependency(enableDnsHostnames);
    }

    const s3Endpoint = vpc.addGatewayEndpoint('EcsS3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [vpcSubnets],
    });
    cdk.Tags.of(s3Endpoint).add('Name', `${stackName}-s3-gateway-endpoint`);
  }
}
