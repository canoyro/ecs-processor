#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-ap-southeast-2}"
REPO_NAME="${REPO_NAME:-internal-file-api}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

ACCOUNT_ID="${ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ECR_IMAGE="${ECR_REGISTRY}/${REPO_NAME}:${IMAGE_TAG}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Logging in to ECR: ${ECR_REGISTRY}"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}"

echo "Building image: ${REPO_NAME}:${IMAGE_TAG}"
docker build -t "${REPO_NAME}:${IMAGE_TAG}" "${SCRIPT_DIR}"

echo "Tagging image: ${ECR_IMAGE}"
docker tag "${REPO_NAME}:${IMAGE_TAG}" "${ECR_IMAGE}"

echo "Pushing image: ${ECR_IMAGE}"
docker push "${ECR_IMAGE}"

echo "Pushed ${ECR_IMAGE}"
