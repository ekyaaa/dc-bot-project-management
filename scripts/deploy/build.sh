#!/usr/bin/env bash
# ==============================================================================
# Script: scripts/deploy/build.sh
# Purpose: Build container image deterministically with standard tag.
# Standards: set -euo pipefail, idempotent, supports custom tags and cache flags.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

log_info()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO]  $*" ; }
log_warn()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARN]  $*" >&2 ; }
log_error() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] $*" >&2 ; }

IMAGE_TAG="${IMAGE_TAG:-dc-bot:latest}"
BUILD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag|-t)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --no-cache)
      BUILD_ARGS+=("--no-cache")
      shift
      ;;
    --pull)
      BUILD_ARGS+=("--pull")
      shift
      ;;
    -h|--help)
      echo "Usage: ./build.sh [--tag <name:tag>] [--no-cache] [--pull]"
      exit 0
      ;;
    *)
      IMAGE_TAG="$1"
      shift
      ;;
  esac
done

if [ ! -f "${PROJECT_ROOT}/Dockerfile" ]; then
  log_error "Dockerfile not found at ${PROJECT_ROOT}/Dockerfile"
  exit 1
fi

log_info "=== [BUILD] Building Docker image '${IMAGE_TAG}' ==="

docker build \
  --tag "${IMAGE_TAG}" \
  -f "${PROJECT_ROOT}/Dockerfile" \
  "${BUILD_ARGS[@]}" \
  "${PROJECT_ROOT}"

IMAGE_ID=$(docker image inspect --format='{{.Id}}' "${IMAGE_TAG}" 2>/dev/null || echo "unknown")
IMAGE_SIZE=$(docker image inspect --format='{{.Size}}' "${IMAGE_TAG}" 2>/dev/null || echo "0")
IMAGE_SIZE_MB=$((IMAGE_SIZE / 1024 / 1024))

log_info "=== [BUILD] Image build completed successfully ==="
log_info "Tag:  ${IMAGE_TAG}"
log_info "ID:   ${IMAGE_ID:0:19}"
log_info "Size: ${IMAGE_SIZE_MB} MB"
