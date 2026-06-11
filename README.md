# ECS Processor

CDK TypeScript stack that deploys an ECS EC2 cluster on an existing VPC, running two shared-storage APIs backed by S3 Mountpoint.

## Stack Resources

- ECS cluster (basic CloudWatch metrics — no Container Insights)
- EC2 capacity provider (auto-scaling group, min 1 / max 4 instances, 60% target capacity)
- ECS-optimized Amazon Linux 2023 instances
- `internal-file-api` ECS service — 2 tasks desired, CPU auto-scaling at 40% (min 2 / max 8 tasks)
- `internal-data-api` ECS service — 2 tasks desired, CPU auto-scaling at 40% (min 2 / max 8 tasks)
- S3 Mountpoint installed on each EC2 host via user data — mounts the shared S3 bucket at `/mnt/s3-shared`
- Both containers bind-mount `/mnt/s3-shared` from the host, sharing the same S3-backed filesystem
- ECS Service Connect on namespace `internal.local`
  - `internal-file-api:8080` — single-value file read/write
  - `internal-data-api:9090` — append-only JSON log
- Private VPC endpoints: SSM, EC2 Messages, SSM Messages, ECR API, ECR Docker, ECS, ECS Agent, ECS Telemetry, CloudWatch Logs, S3 (gateway)
- ECR repositories: `internal-file-api`, `internal-data-api`
- S3 bucket for shared task storage (retained on stack deletion)
- EC2 key pair for instance access

## Parameters

Edit `parameters.json` before deploying:

```json
{
  "prefix": "staging",
  "vpcId": "vpc-...",
  "subnetIds": ["subnet-...", "subnet-..."],
  "instanceType": "t3.micro",
  "amiId": "ami-..."
}
```

`prefix` is optional. When set (e.g. `"staging"`), the stack is named `staging-ecs-stack`. Leave empty for `ecs-stack`.

## Deploy

```bash
npm install
npx cdk diff
npx cdk deploy
```

## Push images to ECR

The ECR repositories are created by CDK. After the first deploy, build and push both images:

```bash
REGION=ap-southeast-2
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

# internal-file-api
docker build -t internal-file-api docker/internal-file-api
docker tag internal-file-api:latest "$ECR_REGISTRY/internal-file-api:latest"
docker push "$ECR_REGISTRY/internal-file-api:latest"

# internal-data-api
docker build -t internal-data-api docker/internal-data-api
docker tag internal-data-api:latest "$ECR_REGISTRY/internal-data-api:latest"
docker push "$ECR_REGISTRY/internal-data-api:latest"
```

## Test the APIs

Connect to an ECS instance via SSM Session Manager, then:

### internal-file-api (port 8080)

```bash
curl http://internal-file-api.internal.local:8080/health
curl "http://internal-file-api.internal.local:8080/write?value=hello"
curl http://internal-file-api.internal.local:8080/read
```

`/read` from any task returns the same value — all tasks share the same S3 mount.

### internal-data-api (port 9090)

```bash
curl http://internal-data-api.internal.local:9090/health
curl "http://internal-data-api.internal.local:9090/append?message=first-entry"
curl "http://internal-data-api.internal.local:9090/append?message=second-entry"
curl http://internal-data-api.internal.local:9090/entries
curl http://internal-data-api.internal.local:9090/clear
```

`/entries` returns the full log across all tasks — entries are appended to the shared `log.json` on S3.

## API reference

### internal-file-api

| Path | Method | Description |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/read` | GET | Read shared file |
| `/write?value=<val>` | GET | Write shared file |

### internal-data-api

| Path | Method | Description |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/entries` | GET | List all log entries |
| `/append?message=<msg>` | GET | Append a new log entry |
| `/clear` | GET | Clear all log entries |

## ECS Exec (shell into a running container)

```bash
CLUSTER=$(aws cloudformation describe-stacks --stack-name staging-ecs-stack \
  --query "Stacks[0].Outputs[?OutputKey=='EcsClusterName'].OutputValue" --output text)

# List tasks
aws ecs list-tasks --cluster "$CLUSTER"

# Shell into a task
aws ecs execute-command \
  --cluster "$CLUSTER" \
  --task <task-id> \
  --container internal-file-api \
  --command "/bin/sh" \
  --interactive
```
