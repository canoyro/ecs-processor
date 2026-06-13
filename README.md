# ECS Processor

CDK TypeScript stack that provisions the ECS cluster infrastructure on an existing VPC. ECS services (task definitions, containers, auto-scaling) are deployed separately from the [ecs-services](https://github.com/canoyro/ecs-services) repository.

## Stack Resources

- ECS cluster (basic CloudWatch metrics — no Container Insights)
- EC2 Auto Scaling Group — min 2 / max 4 instances, rolling update (1 at a time)
- EC2 capacity provider — managed scaling, 60% target capacity
- Custom pre-baked AMI (ECS agent + S3 Mountpoint pre-installed)
- S3 Mountpoint mounted on each EC2 host at `/mnt/s3-shared` via systemd service
- Private VPC endpoints: SSM, EC2 Messages, SSM Messages, ECR API, ECR Docker, ECS, ECS Agent, ECS Telemetry, CloudWatch Logs, S3 (gateway)
- ECR repositories: `internal-file-api`, `internal-data-api` (retained on stack deletion)
- S3 bucket for shared task storage (retained on stack deletion)
- EC2 key pair for instance access

## Deployment Order

Deploy this stack first. Its CloudFormation outputs are required inputs for `ecs-services`:

| CloudFormation Output | Purpose |
|---|---|
| `EcsClusterName` | ECS cluster name → `clusterName` in ecs-services |
| `SharedStorageBucketName` | S3 bucket name → `bucketName` in ecs-services |
| `EcsInternalApiRepositoryUri` | ECR URI → `internalFileApiRepositoryUri` in ecs-services |
| `EcsInternalDataRepositoryUri` | ECR URI → `internalDataApiRepositoryUri` in ecs-services |

## Parameters

Edit `parameters.json` before deploying:

```json
{
  "prefix": "staging",
  "vpcId": "vpc-...",
  "subnetIds": ["subnet-...", "subnet-..."],
  "instanceType": "c7i-flex.large",
  "amiId": "ami-..."
}
```

| Field | Description |
|---|---|
| `prefix` | Optional. Stack is named `<prefix>-ecs-stack` (e.g. `staging-ecs-stack`). Leave empty for `ecs-stack`. |
| `vpcId` | Existing VPC ID |
| `subnetIds` | Two subnet IDs across different AZs for HA |
| `instanceType` | EC2 instance type for the ASG |
| `amiId` | Pre-baked AMI ID with ECS agent and S3 Mountpoint installed |

## Bootstrap workflow (first deploy)

ECR repositories are created by this stack. Images must exist before tasks can run in `ecs-services`.

```
1. npx cdk deploy          (creates ECR repos and cluster)
2. Push images (see below)
3. Deploy ecs-services with desiredCount: 1
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

11 CDK assertion tests covering cluster, ECR repos, S3 bucket, security groups, and VPC endpoints.

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
