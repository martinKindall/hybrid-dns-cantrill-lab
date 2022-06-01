import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class HybridDnsCantrillLabStack extends Stack {
  private onPremVpc: ec2.Vpc;

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
    const priv1Subnet = new ec2.CfnSubnet(this, 'priv1Subnet', {
      vpcId: this.onPremVpc.vpcId,
      availabilityZone: priv1SubnetAZ,
      cidrBlock: '192.168.10.0/25',
      tags: [{key: 'Name', value: 'sn-onprem-A'}]
    });

    const priv2SubnetAZ = this.availabilityZones[1];
    const priv2Subnet = new ec2.CfnSubnet(this, 'priv2Subnet', {
      vpcId: this.onPremVpc.vpcId,
      availabilityZone: priv2SubnetAZ,
      cidrBlock: '192.168.10.128/25',
      tags: [{key: 'Name', value: 'sn-onprem-B'}]
    });

    const privRT = new ec2.CfnRouteTable(this, 'privRT', {
      vpcId: this.onPremVpc.vpcId,
      tags: [{key: 'Name', value: 'A4L-ONPREM-RT'}]
    });

    const priv1SubnetImported = ec2.Subnet.fromSubnetAttributes(this, 'priv1SubnetImported', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: privRT.attrRouteTableId,
      availabilityZone: priv1SubnetAZ
    });

    const priv2SubnetImported = ec2.Subnet.fromSubnetAttributes(this, 'priv2SubnetImported', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: privRT.attrRouteTableId,
      availabilityZone: priv2SubnetAZ
    });

    const rtToPriv1Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv1Association', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: privRT.attrRouteTableId
    });

    const rtToPriv2Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv2Association', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: privRT.attrRouteTableId
    });

    const onPremSecurityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: this.onPremVpc,
      description: 'Default ONPREM SG'
    });

    onPremSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH IPv4 IN');
    onPremSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP IPv4 IN');
    onPremSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), new ec2.Port({
      protocol: ec2.Protocol.ALL,
      stringRepresentation: 'Allow DNS IN',
      fromPort: 53,
      toPort: 53,
    }), 'Allow DNS IN');
    onPremSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allIcmp(), 'Allow ICMP IN');

    const securityGroupIngress = new ec2.CfnSecurityGroupIngress(this, 'OnPremSecurityGroupIngress', {
      groupId: onPremSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 0,
      toPort: 65535,
      sourceSecurityGroupId: onPremSecurityGroup.securityGroupId,
      description: 'Self reference rule for On Prem Security Group'
    });

    const ec2Role = this.createEc2Role();
    
    const onPremInstanceApp = this.createServer(
      this.onPremVpc,
      'onPremInstanceApp',
      priv2SubnetImported,
      onPremSecurityGroup,
      ec2Role,
      'A4L-ONPREM-APP');

    const onPremInstanceB = this.createServer(
      this.onPremVpc,
      'onPremInstanceB',
      priv2SubnetImported,
      onPremSecurityGroup,
      ec2Role,
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

    const onPremInstanceA = this.createServer(
      this.onPremVpc,
      'onPremInstanceA',
      priv1SubnetImported,
      onPremSecurityGroup,
      ec2Role,
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
}
