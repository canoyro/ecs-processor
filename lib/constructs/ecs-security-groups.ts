import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface EcsSecurityGroupsProps {
  vpc: ec2.IVpc;
}

export class EcsSecurityGroups extends Construct {
  readonly instanceSg: ec2.SecurityGroup;
  readonly endpointSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: EcsSecurityGroupsProps) {
    super(scope, id);

    const { vpc } = props;

    this.instanceSg = new ec2.SecurityGroup(this, 'EcsInstanceSg', {
      vpc,
      securityGroupName: 'ecs-instance-sg',
      description: 'ECS EC2 container instance security group',
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    // Allow inter-task traffic for ECS Service Connect (dynamic ephemeral ports)
    this.instanceSg.addIngressRule(
      ec2.Peer.securityGroupId(this.instanceSg.securityGroupId),
      ec2.Port.allTcp(),
      'Inter-task traffic for ECS Service Connect',
    );

    this.endpointSg = new ec2.SecurityGroup(this, 'EcsVpcEndpointSg', {
      vpc,
      securityGroupName: 'ecs-vpc-endpoint-sg',
      description: 'VPC endpoint security group for ECS private instances',
      allowAllOutbound: true,
      disableInlineRules: true,
    });

    this.endpointSg.addIngressRule(
      this.instanceSg,
      ec2.Port.tcp(443),
      'HTTPS from ECS container instances',
    );
  }
}
