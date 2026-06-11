# ECS Processor

CDK TypeScript stack that deploys an ECS EC2 cluster on an existing VPC, running a shared-storage file API with S3 Mountpoint.

## Stack Resources

- ECS cluster with Container Insights Enhanced enabled
- EC2 capacity provider (auto-scaling group, min 1 / max 4 instances, 60% target capacity)
- ECS-optimized Amazon Linux 2023 instances
- `internal-file-api` ECS service — 2 tasks desired, CPU auto-scaling at 40% (min 2 / max 8 tasks)
- `mountpoint-s3` sidecar container (128 MiB soft limit) — mounts S3 bucket at `/mnt/s3-shared` via FUSE
- `internal-file-api` container (256 MiB soft limit) — reads/writes `/mnt/s3-shared/message.txt`
- ECS Service Connect on namespace `internal.local`, DNS name `internal-file-api:8080`
- Private VPC endpoints: SSM, EC2 Messages, SSM Messages, ECR API, ECR Docker, ECS, ECS Agent, ECS Telemetry, CloudWatch Logs, S3 (gateway)
- ECR repository: `internal-file-api`
- S3 bucket for shared task storage (retained on stack deletion)
- EC2 key pair for instance access

## Parameters

Edit `parameters.json` before deploying:

```json
{
  "prefix": "",
  "vpcId": "vpc-...",
  "subnetId": "subnet-...",
  "availabilityZone": "ap-southeast-2a",
  "instanceType": "t3.micro"
}
```

`prefix` is optional. When set (e.g. `"staging"`), the stack is named `staging-ECS-stack`. Leave empty for `ECS-stack`.

## Deploy

```bash
npm install
npx cdk diff
npx cdk deploy
```

## Push the API image

The ECR repository is created by CDK. After the first deploy:

```bash
cd docker/internal-file-api
chmod +x push-to-ecr.sh
./push-to-ecr.sh
```

## Test the API

Connect to an ECS instance via SSM Session Manager, then:

```bash
curl http://internal-file-api.internal.local:8080/health
curl "http://internal-file-api.internal.local:8080/write?value=hello"
curl http://internal-file-api.internal.local:8080/read
```

`/read` from any task returns the same value — all tasks share the same S3 mount.

## Internal file API endpoints

| Path | Method | Description |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/read` | GET | Read shared file |
| `/write?value=<val>` | GET | Write shared file |
