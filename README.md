# ECS Processor

CDK TypeScript stack that deploys an ECS EC2 cluster on an existing VPC, running a shared-storage file API with S3 Mountpoint.

## Stack Resources

- ECS cluster (basic CloudWatch metrics — no Container Insights)
- EC2 capacity provider (auto-scaling group, min 1 / max 4 instances, 60% target capacity)
- ECS-optimized Amazon Linux 2023 instances
- `internal-file-api` ECS service — 2 tasks desired, CPU auto-scaling at 40% (min 2 / max 8 tasks)
- S3 Mountpoint installed on each EC2 host via user data — mounts the shared S3 bucket at `/mnt/s3-shared`
- `internal-file-api` container (256 MiB soft limit) — bind-mounts `/mnt/s3-shared` from the host, reads/writes `message.txt`
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

`prefix` is optional. When set (e.g. `"staging"`), the stack is named `staging-ecs-stack`. Leave empty for `ecs-stack`.

## Deploy

```bash
npm install
npx cdk diff
npx cdk deploy
```

## Push the API image

The ECR repository is created by CDK. After the first deploy, build and push the image:

```bash
REGION=ap-southeast-2
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker build -t internal-file-api docker/internal-file-api
docker tag internal-file-api:latest "$ECR_REGISTRY/internal-file-api:latest"
docker push "$ECR_REGISTRY/internal-file-api:latest"
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
