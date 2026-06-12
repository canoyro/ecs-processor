#!/bin/bash
# bake-ami.sh
#
# Run this on a base AL2023 instance to prepare it for use as an ECS cluster node AMI.
#
# Requirements:
#   - Instance must have internet access (NAT gateway or public subnet) for this script only
#   - Instance IAM role must include AmazonEC2ContainerServiceforEC2Role
#
# Usage:
#   chmod +x bake-ami.sh
#   sudo ./bake-ami.sh
#
# After this script completes:
#   1. Create AMI from this instance in the AWS console
#   2. Update parameters.json with the new amiId
#   3. npx cdk deploy  (ASG launch template updates)
#   4. Remove NAT / internet access from the baking instance

set -euo pipefail

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ── 1. Verify internet reachability ──────────────────────────────────────────
log "Checking internet connectivity..."
if ! curl -sf --max-time 10 https://dnf.amazonlinux.com > /dev/null 2>&1 && \
   ! curl -sf --max-time 10 https://packages.us-east-1.amazonaws.com > /dev/null 2>&1; then
  log "WARNING: Internet may not be reachable. Continuing anyway..."
fi
log "Connectivity check done"

# ── 2. System update ──────────────────────────────────────────────────────────
log "Updating system packages..."
dnf update -y

# ── 3. Install Docker ─────────────────────────────────────────────────────────
log "Installing Docker..."
dnf install -y docker
systemctl enable docker
systemctl start docker
log "Docker installed: $(docker --version)"

# ── 4. Install ECS agent ──────────────────────────────────────────────────────
log "Installing ecs-init..."
dnf install -y ecs-init
systemctl enable ecs
log "ecs-init installed: $(rpm -q ecs-init)"

# ── 5. Install S3 Mountpoint ──────────────────────────────────────────────────
log "Installing mount-s3..."
dnf install -y mount-s3 || {
  log "dnf install failed, falling back to direct RPM download..."
  ARCH=$(uname -m)
  curl -fsSL "https://s3.amazonaws.com/mountpoint-s3-release/latest/${ARCH}/mount-s3.rpm" \
    -o /tmp/mount-s3.rpm
  dnf install -y /tmp/mount-s3.rpm
  rm -f /tmp/mount-s3.rpm
}
log "mount-s3 installed: $(mount-s3 --version 2>&1 | head -1)"

# ── 6. FUSE configuration ─────────────────────────────────────────────────────
log "Configuring FUSE..."
grep -q "user_allow_other" /etc/fuse.conf 2>/dev/null || echo "user_allow_other" >> /etc/fuse.conf
mkdir -p /mnt/s3-shared
log "FUSE configured"

# ── 7. Prepare ECS config directory (cluster name set at launch via user data) ─
mkdir -p /etc/ecs
> /etc/ecs/ecs.config

# ── 8. Summary ────────────────────────────────────────────────────────────────
log ""
log "=============================="
log " AMI bake complete"
log "=============================="
log ""
log "Installed:"
log "  docker    : $(docker --version)"
log "  ecs-init  : $(rpm -q ecs-init)"
log "  mount-s3  : $(mount-s3 --version 2>&1 | head -1)"
log ""
log "Next steps:"
log "  1. In AWS console: EC2 -> Instances -> this instance"
log "     -> Actions -> Image -> Create Image"
log "  2. Update parameters.json:  \"amiId\": \"<new-ami-id>\""
log "  3. npx cdk deploy"
