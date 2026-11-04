#!/usr/bin/env bash
# ==============================================================================
# Script: scripts/deploy/up.sh
# Purpose: Idempotently start bot service using Docker Compose.
# Standards: set -euo pipefail, runs preflight first, triggers health check.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

log_info()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO]  $*" ; }
log_warn()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARN]  $*" >&2 ; }
log_error() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] $*" >&2 ; }

SKIP_PREFLIGHT=false
SKIP_HEALTH=false
COMPOSE_FILE="${PROJECT_ROOT}/compose.yaml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-preflight)
      SKIP_PREFLIGHT=true
      shift
      ;;
    --skip-health)
      SKIP_HEALTH=true
      shift
      ;;
    --file|-f)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./up.sh [--skip-preflight] [--skip-health] [--file <compose.yaml>]"
      exit 0
      ;;
    *)
      log_warn "Unknown parameter: $1"
      shift
      ;;
  esac
done

# 1. Run Preflight
if [ "$SKIP_PREFLIGHT" = false ]; then
  log_info "Executing preflight checks prior to startup..."
  "${SCRIPT_DIR}/preflight.sh"
else
  log_warn "Preflight checks skipped via flag."
fi

# 2. Start Service with Compose
log_info "=== [UP] Starting service via Docker Compose ==="
if [ ! -f "$COMPOSE_FILE" ]; then
  log_error "Compose file not found at ${COMPOSE_FILE}"
  exit 1
fi

docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

log_info "Container started. Current service state:"
docker compose -f "$COMPOSE_FILE" ps

# 3. Health Probe
if [ "$SKIP_HEALTH" = false ]; then
  log_info "Probing container health endpoints..."
  "${SCRIPT_DIR}/health.sh"
fi

log_info "=== [UP] Service is up and operational ==="
