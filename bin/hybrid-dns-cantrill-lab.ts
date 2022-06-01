#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { HybridDnsCantrillLabStack } from '../lib/hybrid-dns-cantrill-lab-stack';

const app = new cdk.App();
new HybridDnsCantrillLabStack(app, 'HybridDnsCantrillLabStack');
