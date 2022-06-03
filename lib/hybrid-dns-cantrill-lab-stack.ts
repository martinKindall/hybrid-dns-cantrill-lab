import { Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class HybridDnsCantrillLabStack extends Stack {
  private onPremVpc: ec2.Vpc;
  private onPremPriv1Subnet: ec2.ISubnet;
  private onPremPriv2Subnet: ec2.ISubnet;
  private onPremSecurityGroup: ec2.SecurityGroup;
  private onPremPrivRT: ec2.CfnRouteTable;

  private ec2Role: iam.Role;

  private awsVpc: ec2.Vpc;
  private awsPriv1Subnet: ec2.ISubnet;
  private awsPriv2Subnet: ec2.ISubnet;
  private awsSecurityGroup: ec2.SecurityGroup;
  private awsPrivRT: ec2.CfnRouteTable;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.onPremVpc = new ec2.Vpc(this, 'onprem_vpc', {
      cidr: '192.168.10.0/24',
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [],
    });
    Tags.of(this.onPremVpc).add('Name', 'a4l-onprem');

    const priv1SubnetAZ = this.availabilityZones[0];
    const priv1Subnet = new ec2.CfnSubnet(this, 'onPremPriv1Subnet', {
      vpcId: this.onPremVpc.vpcId,
      availabilityZone: priv1SubnetAZ,
      cidrBlock: '192.168.10.0/25',
      tags: [{key: 'Name', value: 'sn-onprem-A'}]
    });

    const priv2SubnetAZ = this.availabilityZones[1];
    const priv2Subnet = new ec2.CfnSubnet(this, 'onPremPriv2Subnet', {
      vpcId: this.onPremVpc.vpcId,
      availabilityZone: priv2SubnetAZ,
      cidrBlock: '192.168.10.128/25',
      tags: [{key: 'Name', value: 'sn-onprem-B'}]
    });

    this.onPremPrivRT = new ec2.CfnRouteTable(this, 'onPremPrivRT', {
      vpcId: this.onPremVpc.vpcId,
      tags: [{key: 'Name', value: 'A4L-ONPREM-RT'}]
    });

    this.onPremPriv1Subnet = ec2.Subnet.fromSubnetAttributes(this, 'onPremPriv1SubnetImported', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: this.onPremPrivRT.attrRouteTableId,
      availabilityZone: priv1SubnetAZ
    });

    this.onPremPriv2Subnet = ec2.Subnet.fromSubnetAttributes(this, 'onPremPriv2SubnetImported', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: this.onPremPrivRT.attrRouteTableId,
      availabilityZone: priv2SubnetAZ
    });

    const rtToPriv1Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv1Association', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: this.onPremPrivRT.attrRouteTableId
    });

    const rtToPriv2Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv2Association', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: this.onPremPrivRT.attrRouteTableId
    });

    this.onPremSecurityGroup = this.createSG('onPrem');

    this.ec2Role = this.createEc2Role();

    const ssmInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmEndpoint', {
      vpc: this.onPremVpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.onPremPriv1Subnet, this.onPremPriv2Subnet]
      },
      securityGroups: [this.onPremSecurityGroup]
    });

    const ssmEc2MessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmEc2MessagesEndpoint', {
      vpc: this.onPremVpc,
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.onPremPriv1Subnet, this.onPremPriv2Subnet]
      },
      securityGroups: [this.onPremSecurityGroup]
    });

    const ssmMessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ssmMessagesEndpoint', {
      vpc: this.onPremVpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.onPremPriv1Subnet, this.onPremPriv2Subnet]
      },
      securityGroups: [this.onPremSecurityGroup]
    });

    const s3InterfaceEndpoint = new ec2.CfnVPCEndpoint(this, 's3Endpoint', {
      vpcId: this.onPremVpc.vpcId,
      serviceName: `com.amazonaws.${this.region}.s3`,
      routeTableIds: [this.onPremPrivRT.attrRouteTableId]
    });
    
    const onPremInstanceApp = this.createServer(
      this.onPremVpc,
      'onPremInstanceApp',
      this.onPremPriv2Subnet,
      this.onPremSecurityGroup,
      this.ec2Role,
      'A4L-ONPREM-APP');
    onPremInstanceApp.node.addDependency(
      ssmInterfaceEndpoint,
      ssmEc2MessagesInterfaceEndpoint,
      ssmMessagesInterfaceEndpoint
    );

    const onPremInstanceB = this.createServer(
      this.onPremVpc,
      'onPremInstanceB',
      this.onPremPriv2Subnet,
      this.onPremSecurityGroup,
      this.ec2Role,
      'A4L-ONPREM-DNSB',
`#!/bin/bash -xe
yum update -y
yum install bind bind-utils -y
cat <<EOF > /etc/named.conf
options {
  directory	"/var/named";
  dump-file	"/var/named/data/cache_dump.db";
  statistics-file "/var/named/data/named_stats.txt";
  memstatistics-file "/var/named/data/named_mem_stats.txt";
  allow-query { any; };
  recursion yes;
  forward first;
  forwarders {
    192.168.10.2;
  };
  dnssec-enable yes;
  dnssec-validation yes;
  dnssec-lookaside auto;
  /* Path to ISC DLV key */
  bindkeys-file "/etc/named.iscdlv.key";
  managed-keys-directory "/var/named/dynamic";
};
zone "corp.animals4life.org" IN {
    type master;
    file "corp.animals4life.org.zone";
    allow-update { none; };
};
EOF
cat <<EOF > /var/named/corp.animals4life.org.zone
\$TTL 86400
@   IN  SOA     ns1.mydomain.com. root.mydomain.com. (
        2013042201  ;Serial
        3600        ;Refresh
        1800        ;Retry
        604800      ;Expire
        86400       ;Minimum TTL
)
; Specify our two nameservers
    IN	NS		dnsA.corp.animals4life.org.
    IN	NS		dnsB.corp.animals4life.org.
; Resolve nameserver hostnames to IP, replace with your two droplet IP addresses.
dnsA		IN	A		1.1.1.1
dnsB	  IN	A		8.8.8.8

; Define hostname -> IP pairs which you wish to resolve
@		  IN	A		${onPremInstanceApp.instancePrivateIp}
app		IN	A	  ${onPremInstanceApp.instancePrivateIp}
EOF
service named restart
chkconfig named on`
    );
    onPremInstanceB.node.addDependency(
      ssmInterfaceEndpoint,
      ssmEc2MessagesInterfaceEndpoint,
      ssmMessagesInterfaceEndpoint
    );

    const onPremInstanceA = this.createServer(
      this.onPremVpc,
      'onPremInstanceA',
      this.onPremPriv1Subnet,
      this.onPremSecurityGroup,
      this.ec2Role,
      'A4L-ONPREM-DNSA',
`#!/bin/bash -xe
yum update -y
yum install bind bind-utils -y
cat <<EOF > /etc/named.conf
options {
  directory	"/var/named";
  dump-file	"/var/named/data/cache_dump.db";
  statistics-file "/var/named/data/named_stats.txt";
  memstatistics-file "/var/named/data/named_mem_stats.txt";
  allow-query { any; };
  allow-transfer     { localhost; ${onPremInstanceB.instancePrivateIp}; };
  recursion yes;
  forward first;
  forwarders {
    192.168.10.2;
  };
  dnssec-enable yes;
  dnssec-validation yes;
  dnssec-lookaside auto;
  /* Path to ISC DLV key */
  bindkeys-file "/etc/named.iscdlv.key";
  managed-keys-directory "/var/named/dynamic";
};
zone "corp.animals4life.org" IN {
    type master;
    file "corp.animals4life.org.zone";
    allow-update { none; };
};
EOF
cat <<EOF > /var/named/corp.animals4life.org.zone
\$TTL 86400
@   IN  SOA     ns1.mydomain.com. root.mydomain.com. (
        2013042201  ;Serial
        3600        ;Refresh
        1800        ;Retry
        604800      ;Expire
        86400       ;Minimum TTL
)
; Specify our two nameservers
    IN	NS		dnsA.corp.animals4life.org.
    IN	NS		dnsB.corp.animals4life.org.
; Resolve nameserver hostnames to IP, replace with your two droplet IP addresses.
dnsA		IN	A		1.1.1.1
dnsB	  IN	A		8.8.8.8

; Define hostname -> IP pairs which you wish to resolve
@		  IN	A		${onPremInstanceApp.instancePrivateIp}
app		IN	A	  ${onPremInstanceApp.instancePrivateIp}
EOF
service named restart
chkconfig named on
`
    );
    onPremInstanceA.node.addDependency(
      ssmInterfaceEndpoint,
      ssmEc2MessagesInterfaceEndpoint,
      ssmMessagesInterfaceEndpoint
    );

    this.setupAwsSide();
  }

  private createServer(
    vpc: ec2.Vpc, 
    name: string,
    subnet: ec2.ISubnet,
    securityGroup: ec2.SecurityGroup,
    role: iam.Role,
    tag: string,
    userData?: string): ec2.Instance {

    const server = new ec2.Instance(this, name, {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux(),
      vpcSubnets: {
        subnets: [subnet]
      },
      securityGroup: securityGroup,
      role,
      userData: userData ? ec2.UserData.custom(userData) : undefined
    });

    return server;
  }

  private createEc2Role() {
    const ec2PolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:DescribeAssociation',
        'ssm:GetDeployablePatchSnapshotForInstance',
        'ssm:GetDocument',
        'ssm:DescribeDocument',
        'ssm:GetManifest',
        'ssm:GetParameter',
        'ssm:GetParameters',
        'ssm:ListAssociations',
        'ssm:ListInstanceAssociations',
        'ssm:PutInventory',
        'ssm:PutComplianceItems',
        'ssm:PutConfigurePackageResult',
        'ssm:UpdateAssociationStatus',
        'ssm:UpdateInstanceAssociationStatus',
        'ssm:UpdateInstanceInformation',
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
        'ec2messages:AcknowledgeMessage',
        'ec2messages:DeleteMessage',
        'ec2messages:FailMessage',
        'ec2messages:GetEndpoint',
        'ec2messages:GetMessages',
        'ec2messages:SendReply',
        's3:*'
    ],
      resources: ['*']
    });

    const ec2Policy = new iam.Policy(this, 'Ec2Policy', {policyName: 'root'});
    ec2Policy.addStatements(ec2PolicyStatement);

    const principal = new iam.ServicePrincipal('ec2.amazonaws.com');
    const ec2Role = new iam.Role(this, 'Ec2Role', {
      assumedBy: principal,
      path: '/',
    });
    ec2Role.grant(principal, 'sts:AssumeRole');
    ec2Policy.attachToRole(ec2Role);

    return ec2Role;
  }

  private setupAwsSide() {
    this.awsVpc = new ec2.Vpc(this, 'aws_vpc', {
      cidr: '10.16.0.0/16',
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [],
    });
    Tags.of(this.awsVpc).add('Name', 'a4l-aws');

    const priv1SubnetAZ = this.availabilityZones[0];
    const priv1Subnet = new ec2.CfnSubnet(this, 'awsPriv1Subnet', {
      vpcId: this.awsVpc.vpcId,
      availabilityZone: priv1SubnetAZ,
      cidrBlock: '10.16.32.0/20',
      tags: [{key: 'Name', value: 'sn-private-A'}]
    });

    const priv2SubnetAZ = this.availabilityZones[1];
    const priv2Subnet = new ec2.CfnSubnet(this, 'awsPriv2Subnet', {
      vpcId: this.awsVpc.vpcId,
      availabilityZone: priv2SubnetAZ,
      cidrBlock: '10.16.96.0/20',
      tags: [{key: 'Name', value: 'sn-private-B'}]
    });

    this.awsPrivRT = new ec2.CfnRouteTable(this, 'awsPrivRT', {
      vpcId: this.awsVpc.vpcId,
      tags: [{key: 'Name', value: 'A4L-AWS-RT'}]
    });

    this.awsPriv1Subnet = ec2.Subnet.fromSubnetAttributes(this, 'awsPriv1SubnetImported', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: this.awsPrivRT.attrRouteTableId,
      availabilityZone: priv1SubnetAZ
    });

    this.awsPriv2Subnet = ec2.Subnet.fromSubnetAttributes(this, 'awsPriv2SubnetImported', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: this.awsPrivRT.attrRouteTableId,
      availabilityZone: priv2SubnetAZ
    });

    const rtToPriv1Association = new ec2.CfnSubnetRouteTableAssociation(this, 'awsRtToPriv1Association', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: this.awsPrivRT.attrRouteTableId
    });

    const rtToPriv2Association = new ec2.CfnSubnetRouteTableAssociation(this, 'awsRtToPriv2Association', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: this.awsPrivRT.attrRouteTableId
    });    

    this.awsSecurityGroup = this.createSG('aws');

    const awsSsmInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'awsSsmEndpoint', {
      vpc: this.awsVpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.awsPriv1Subnet, this.awsPriv2Subnet]
      },
      securityGroups: [this.awsSecurityGroup]
    });

    const awsSsmEc2MessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'awsSsmEc2MessagesEndpoint', {
      vpc: this.awsVpc,
      service: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.awsPriv1Subnet, this.awsPriv2Subnet]
      },
      securityGroups: [this.awsSecurityGroup]
    });

    const awsSsmMessagesInterfaceEndpoint = new ec2.InterfaceVpcEndpoint(this, 'awsSsmMessagesEndpoint', {
      vpc: this.awsVpc,
      service: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      privateDnsEnabled: true,
      subnets: {
        subnets: [this.awsPriv1Subnet, this.awsPriv2Subnet]
      },
      securityGroups: [this.awsSecurityGroup]
    });

    const awsInstanceA = this.createServer(
      this.awsVpc,
      'awsInstanceA',
      this.awsPriv1Subnet,
      this.awsSecurityGroup,
      this.ec2Role,
      'A4L-AWS-EC2-A');

    awsInstanceA.node.addDependency(
      awsSsmInterfaceEndpoint,
      awsSsmEc2MessagesInterfaceEndpoint,
      awsSsmMessagesInterfaceEndpoint
    );

    const awsInstanceB = this.createServer(
      this.awsVpc,
      'awsInstanceB',
      this.awsPriv2Subnet,
      this.awsSecurityGroup,
      this.ec2Role,
      'A4L-AWS-EC2-B'); 

    awsInstanceB.node.addDependency(
      awsSsmInterfaceEndpoint,
      awsSsmEc2MessagesInterfaceEndpoint,
      awsSsmMessagesInterfaceEndpoint
    );

    const hostedZone = new route53.HostedZone(this, 'awsHostedZone', {
      zoneName: 'aws.animals4life.org',
      vpcs: [this.awsVpc]
    });

    const recordSet = new route53.RecordSet(this, 'RecordSet', {
      recordType: route53.RecordType.A,
      zone: hostedZone,
      recordName: 'web.aws.animals4life.org',
      ttl: Duration.minutes(60),
      target: route53.RecordTarget.fromIpAddresses(awsInstanceA.instancePrivateIp, awsInstanceB.instancePrivateIp)
    });
  }

  private createSG(name: string): ec2.SecurityGroup {
    const securityGroup = new ec2.SecurityGroup(this, `${name}SecurityGroup`, {
      vpc: this.onPremVpc,
      description: `Default ${name} SG`
    });

    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH IPv4 IN');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP IPv4 IN');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), new ec2.Port({
      protocol: ec2.Protocol.ALL,
      stringRepresentation: 'Allow DNS IN',
      fromPort: 53,
      toPort: 53,
    }), 'Allow DNS IN');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allIcmp(), 'Allow ICMP IN');

    const securityGroupIngress = new ec2.CfnSecurityGroupIngress(this, `${name}SecurityGroupIngress`, {
      groupId: securityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 0,
      toPort: 65535,
      sourceSecurityGroupId: securityGroup.securityGroupId,
      description: 'Self reference rule'
    });

    return securityGroup;
  }
}
