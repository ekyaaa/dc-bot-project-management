#!/usr/bin/env bash
# ==============================================================================
# Script: scripts/deploy/health.sh
# Purpose: Probes /health/live and /health/ready with retry loop until HTTP 200.
# Standards: set -euo pipefail, configurable attempts and interval.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

log_info()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO]  $*" ; }
log_warn()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARN]  $*" >&2 ; }
log_error() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] $*" >&2 ; }

# Defaults
HOST="${BOT_HOST:-127.0.0.1}"
PORT="${PORT:-3000}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-15}"
RETRY_INTERVAL="${RETRY_INTERVAL:-2}"
TIMEOUT="${CURL_TIMEOUT:-3}"

# Read PORT from .env if present
if [ -f "${PROJECT_ROOT}/.env" ]; then
  PARSED_PORT=$(grep -E "^[[:space:]]*PORT=" "${PROJECT_ROOT}/.env" | head -n1 | cut -d'=' -f2- | tr -d '\r ' | sed -e 's/^["'\'']//' -e 's/["'\'']$//' || true)
  if [ -n "$PARSED_PORT" ]; then
    PORT="$PARSED_PORT"
  fi
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --attempts)
      MAX_ATTEMPTS="$2"
      shift 2
      ;;
    --interval)
      RETRY_INTERVAL="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --host)
      HOST="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./health.sh [--attempts 15] [--interval 2] [--port 3000] [--host 127.0.0.1]"
      exit 0
      ;;
    *)
      log_warn "Unknown argument: $1"
      shift
      ;;
  esac
done

BASE_URL="http://${HOST}:${PORT}"
LIVE_URL="${BASE_URL}/health/live"
READY_URL="${BASE_URL}/health/ready"

log_info "=== [HEALTH] Probing Bot Health ==="
log_info "Target: ${BASE_URL} (Max attempts: ${MAX_ATTEMPTS}, Interval: ${RETRY_INTERVAL}s)"

TMP_BODY=$(mktemp /tmp/health_body-XXXXXX.json)
trap 'rm -f "$TMP_BODY"' EXIT

for ((i=1; i<=MAX_ATTEMPTS; i++)); do
  # Probe /health/live
  HTTP_LIVE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$LIVE_URL" || echo "000")

  # Probe /health/ready
  HTTP_READY=$(curl -s -o "$TMP_BODY" -w "%{http_code}" --max-time "$TIMEOUT" "$READY_URL" || echo "000")

  if [ "$HTTP_LIVE" = "200" ] && [ "$HTTP_READY" = "200" ]; then
    log_info "[OK] Health check passed on attempt ${i}/${MAX_ATTEMPTS}:"
    log_info "     Liveness:  HTTP 200 (OK)"
    log_info "     Readiness: HTTP 200 (Database healthy)"
    log_info "=== [HEALTH] Service is fully healthy and ready ==="
    exit 0
  fi

  log_info "Attempt ${i}/${MAX_ATTEMPTS}: live=${HTTP_LIVE}, ready=${HTTP_READY}. Retrying in ${RETRY_INTERVAL}s..."
  sleep "$RETRY_INTERVAL"
done

log_error "=== [HEALTH] Probe FAILED: Service did not become ready within ${MAX_ATTEMPTS} attempts ==="
exit 1
