# ECS Processor

CDK TypeScript stack that deploys an ECS EC2 cluster on an existing VPC, running two shared-storage APIs backed by S3 Mountpoint.

## Stack Resources

- ECS cluster (basic CloudWatch metrics — no Container Insights)
- EC2 Auto Scaling Group — min 2 / max 4 instances, rolling update (1 at a time)
- EC2 capacity provider — managed scaling, 60% target capacity
- Custom pre-baked AMI (ECS agent + S3 Mountpoint pre-installed)
- S3 Mountpoint mounted on each EC2 host at `/mnt/s3-shared` via systemd service
- `internal-file-api` ECS service — single-value file read/write on port 8080
- `internal-data-api` ECS service — append-only JSON log on port 9090
- Both services: `desiredCount` from `parameters.json`, CPU auto-scaling (min 1 / max 2 tasks), circuit breaker with auto-rollback, 50–200% deployment health bounds
- Both containers bind-mount `/mnt/s3-shared` from the host, sharing the same S3-backed filesystem
- ECS Exec enabled on all tasks (SSM Session Manager)
- Private VPC endpoints: SSM, EC2 Messages, SSM Messages, ECR API, ECR Docker, ECS, ECS Agent, ECS Telemetry, CloudWatch Logs, S3 (gateway)
- ECR repositories: `internal-file-api`, `internal-data-api` (retained on stack deletion)
- S3 bucket for shared task storage (retained on stack deletion)
- EC2 key pair for instance access

## Parameters

Edit `parameters.json` before deploying:

```json
{
  "prefix": "staging",
  "vpcId": "vpc-...",
  "subnetIds": ["subnet-...", "subnet-..."],
  "instanceType": "c7i-flex.large",
  "amiId": "ami-...",
  "desiredCount": 0
}
```

| Field | Description |
|---|---|
| `prefix` | Optional. Stack is named `<prefix>-ecs-stack` (e.g. `staging-ecs-stack`). Leave empty for `ecs-stack`. |
| `vpcId` | Existing VPC ID |
| `subnetIds` | Two subnet IDs across different AZs for HA |
| `instanceType` | EC2 instance type for the ASG |
| `amiId` | Pre-baked AMI ID with ECS agent and S3 Mountpoint installed |
| `desiredCount` | Number of tasks per service. Set to `0` on first deploy (before images are pushed). |

## Bootstrap workflow (first deploy)

ECR repositories are created by the stack. Images must exist before tasks can run.

```
1. Set desiredCount: 0  →  npx cdk deploy   (creates ECR repos, no tasks started)
2. Push images (see below)
3. Set desiredCount: 1  →  npx cdk deploy   (tasks launch and pull from ECR)
```

## Deploy

```bash
npm install
npx cdk diff
npx cdk deploy
```

## Tests

```bash
npm test
```

19 CDK assertion tests covering cluster, services, ECR repos, S3 bucket, auto scaling, security groups, and VPC endpoints.

## Push images to ECR

Use the per-service scripts (handles login, build, tag, and push):

```bash
./docker/internal-file-api/push-to-ecr.sh
./docker/internal-data-api/push-to-ecr.sh
```

Override region or tag:

```bash
REGION=ap-southeast-2 IMAGE_TAG=v1.0 ./docker/internal-file-api/push-to-ecr.sh
```

Or manually:

```bash
REGION=ap-southeast-2
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

docker build -t internal-file-api docker/internal-file-api
docker tag internal-file-api:latest "$ECR_REGISTRY/internal-file-api:latest"
docker push "$ECR_REGISTRY/internal-file-api:latest"

docker build -t internal-data-api docker/internal-data-api
docker tag internal-data-api:latest "$ECR_REGISTRY/internal-data-api:latest"
docker push "$ECR_REGISTRY/internal-data-api:latest"
```

## Test the APIs

Connect to an ECS instance via SSM Session Manager. Tasks use `awsvpc` networking so each task gets its own private IP. Get the task IP then curl directly:

```bash
CLUSTER="staging-ecs-stack-cluster"

# Get task private IPs
aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks $(aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING --query taskArns --output text) \
  --query "tasks[*].{task:taskArn,ip:containers[0].networkInterfaces[0].privateIpv4Address,name:containers[0].name}" \
  --output table
```

### internal-file-api (port 8080)

```bash
TASK_IP=<task-private-ip>
curl http://$TASK_IP:8080/health
curl "http://$TASK_IP:8080/write?value=hello"
curl http://$TASK_IP:8080/read
```

`/read` from any task returns the same value — all tasks share the same S3 mount.

### internal-data-api (port 9090)

```bash
TASK_IP=<task-private-ip>
curl http://$TASK_IP:9090/health
curl "http://$TASK_IP:9090/append?message=first-entry"
curl "http://$TASK_IP:9090/append?message=second-entry"
curl http://$TASK_IP:9090/entries
curl http://$TASK_IP:9090/clear
```

`/entries` returns the full log across all tasks — entries are appended to the shared `log.json` on S3.

## API reference

### internal-file-api

| Path | Method | Description |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/read` | GET | Read `message.txt` from shared S3 mount |
| `/write?value=<val>` | GET | Write `message.txt` to shared S3 mount |

### internal-data-api

| Path | Method | Description |
|---|---|---|
| `/` | GET | Service info |
| `/health` | GET | Health check |
| `/entries` | GET | List all entries in `log.json` |
| `/append?message=<msg>` | GET | Append a timestamped entry to `log.json` |
| `/clear` | GET | Clear all entries in `log.json` |

## ECS Exec (shell into a running container)

```bash
CLUSTER=$(aws cloudformation describe-stacks --stack-name staging-ecs-stack \
  --query "Stacks[0].Outputs[?OutputKey=='EcsClusterName'].OutputValue" --output text)

# List running tasks
aws ecs list-tasks --cluster "$CLUSTER" --desired-status RUNNING

# Shell into a container
aws ecs execute-command \
  --cluster "$CLUSTER" \
  --task <task-id> \
  --container internal-file-api \
  --command "/bin/sh" \
  --interactive
```

## Diagnose stuck or failing tasks

```bash
CLUSTER="staging-ecs-stack-cluster"

# Service events and task counts
aws ecs describe-services \
  --cluster "$CLUSTER" \
  --services internal-file-api internal-data-api \
  --query "services[*].{name:serviceName,running:runningCount,pending:pendingCount,events:events[0:3]}" \
  --output json

# Why did a task stop?
aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks $(aws ecs list-tasks --cluster "$CLUSTER" --desired-status STOPPED --query taskArns[0] --output text) \
  --query "tasks[0].{stopped:stoppedReason,containers:containers[*].{name:name,exitCode:exitCode,reason:reason}}" \
  --output json

# Check container instance registration
aws ecs list-container-instances --cluster "$CLUSTER"
```
