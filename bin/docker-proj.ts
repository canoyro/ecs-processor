#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import * as fs from 'fs';
import * as path from 'path';
import { ECSStack } from '../lib/docker-proj-stack';

const params = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../parameters.json'), 'utf-8')
);

const prefix: string = params.prefix ? `${params.prefix}-` : '';
const stackName = `${prefix}ECS-stack`;

const app = new cdk.App();
new ECSStack(app, stackName, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
