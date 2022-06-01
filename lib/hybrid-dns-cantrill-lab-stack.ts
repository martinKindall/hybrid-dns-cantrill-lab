import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class HybridDnsCantrillLabStack extends Stack {
  private vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, 'onprem_vpc', {
      cidr: '192.168.10.0/24',
      enableDnsSupport: true,
      enableDnsHostnames: true,
      subnetConfiguration: [],
    });
    Tags.of(this.vpc).add('Name', 'a4l-onprem');

    const priv1Subnet = new ec2.CfnSubnet(this, 'priv1Subnet', {
      vpcId: this.vpc.vpcId,
      availabilityZone: this.availabilityZones[0],
      cidrBlock: '192.168.10.0/25',
      tags: [{key: 'Name', value: 'sn-onprem-A'}]
    });

    const priv2Subnet = new ec2.CfnSubnet(this, 'priv2Subnet', {
      vpcId: this.vpc.vpcId,
      availabilityZone: this.availabilityZones[1],
      cidrBlock: '192.168.10.128/25',
      tags: [{key: 'Name', value: 'sn-onprem-B'}]
    });

    const privRT = new ec2.CfnRouteTable(this, 'privRT', {
      vpcId: this.vpc.vpcId,
      tags: [{key: 'Name', value: 'A4L-ONPREM-RT'}]
    });

    const rtToPriv1Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv1Association', {
      subnetId: priv1Subnet.attrSubnetId,
      routeTableId: privRT.attrRouteTableId
    });

    const rtToPriv2Association = new ec2.CfnSubnetRouteTableAssociation(this, 'rtToPriv2Association', {
      subnetId: priv2Subnet.attrSubnetId,
      routeTableId: privRT.attrRouteTableId
    });
  }
}
