#!/usr/bin/env bash
# ==============================================================================
# Script: scripts/deploy/preflight.sh
# Purpose: Idempotent preflight verification for VPS deployment.
# Standards: set -euo pipefail, structured logging, secrets hygiene.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

log_info()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO]  $*" ; }
log_warn()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARN]  $*" >&2 ; }
log_error() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] $*" >&2 ; }

ENV_FILE="${PROJECT_ROOT}/.env"
CHECK_PORT="3000"
SKIP_DAEMON=false

# CLI option parsing
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --port)
      CHECK_PORT="$2"
      shift 2
      ;;
    --skip-daemon)
      SKIP_DAEMON=true
      shift
      ;;
    -h|--help)
      echo "Usage: ./preflight.sh [--env-file <path>] [--port <port>] [--skip-daemon]"
      exit 0
      ;;
    *)
      log_warn "Unknown parameter: $1"
      shift
      ;;
  esac
done

ERRORS=0

log_info "=== [PREFLIGHT] Starting Deployment Validation ==="
log_info "Project root: ${PROJECT_ROOT}"

# 1. Check Docker CLI
if command -v docker >/dev/null 2>&1; then
  DOCKER_VER=$(docker --version | awk '{print $3}' | tr -d ',')
  log_info "[OK] Docker CLI detected (${DOCKER_VER})"
else
  log_error "[FAIL] Docker CLI is not installed or not in PATH."
  ERRORS=$((ERRORS + 1))
fi

# 2. Check Docker Compose (v2 plugin)
if docker compose version >/dev/null 2>&1; then
  COMPOSE_VER=$(docker compose version --short 2>/dev/null || docker compose version)
  log_info "[OK] Docker Compose v2 detected (${COMPOSE_VER})"
else
  log_error "[FAIL] Docker Compose v2 ('docker compose') is not available."
  ERRORS=$((ERRORS + 1))
fi

# 3. Check Docker Daemon
if [ "$SKIP_DAEMON" = false ] && command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    log_info "[OK] Docker daemon is running and accessible."
  else
    log_warn "[WARN] Cannot connect to Docker daemon socket (/var/run/docker.sock)."
    log_warn "       If deploying on VPS, verify 'systemctl status docker'. If in CI/sandbox, pass --skip-daemon."
  fi
elif [ "$SKIP_DAEMON" = true ]; then
  log_info "[INFO] Skipping Docker daemon socket check (--skip-daemon)."
fi

# 4. Check .env file and permissions
if [ ! -f "$ENV_FILE" ]; then
  log_error "[FAIL] Environment file not found: ${ENV_FILE}"
  log_error "       Copy .env.example to .env and configure genuine credentials."
  ERRORS=$((ERRORS + 1))
else
  log_info "[OK] Environment file found: ${ENV_FILE}"

  PERMS=$(stat -c "%a" "$ENV_FILE" 2>/dev/null || stat -f "%Lp" "$ENV_FILE" 2>/dev/null || echo "unknown")
  if [ "$PERMS" != "unknown" ]; then
    if [ "$PERMS" = "600" ] || [ "$PERMS" = "400" ]; then
      log_info "[OK] .env permissions are securely restricted (${PERMS})."
    else
      log_warn "[WARN] .env permissions are ${PERMS} (recommended: 'chmod 600 ${ENV_FILE}')."
    fi
  fi
fi

# 5. Check Required Variables & Secrets
if [ -f "$ENV_FILE" ]; then
  get_val() {
    local k="$1"
    grep -E "^[[:space:]]*${k}=" "$ENV_FILE" | head -n 1 | cut -d'=' -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\''\(.*\)["'\'']$/\1/'
  }

  has_val() {
    local k="$1"
    local v
    v=$(get_val "$k")
    [ -n "$v" ]
  }

  REQUIRED_SPECS=(
    "PUBLIC_BASE_URL"
    "DISCORD_APPLICATION_ID"
    "DISCORD_GUILD_ID"
    "DISCORD_NOTIFICATION_CHANNEL_ID"
    "DISCORD_BOT_TOKEN:DISCORD_BOT_TOKEN_FILE:DISCORD_BOT_TOKEN_PATH"
    "GITHUB_APP_ID"
    "GITHUB_APP_CLIENT_ID"
    "GITHUB_APP_CLIENT_SECRET:GITHUB_APP_CLIENT_SECRET_FILE:GITHUB_APP_CLIENT_SECRET_PATH"
    "GITHUB_APP_INSTALLATION_ID"
    "GITHUB_WEBHOOK_SECRET:GITHUB_WEBHOOK_SECRET_FILE:GITHUB_WEBHOOK_SECRET_PATH"
    "GITHUB_APP_PRIVATE_KEY:GITHUB_APP_PRIVATE_KEY_PEM:GITHUB_APP_PRIVATE_KEY_FILE:GITHUB_APP_PRIVATE_KEY_PATH:GITHUB_APP_PRIVATE_KEY_PEM_PATH"
    "GITHUB_OWNER"
    "GITHUB_REPOSITORY"
    "GITHUB_PROJECT_NUMBER"
    "TOKEN_ENCRYPTION_KEY:TOKEN_ENCRYPTION_KEY_FILE:TOKEN_ENCRYPTION_KEY_PATH"
  )

  for spec in "${REQUIRED_SPECS[@]}"; do
    IFS=':' read -ra ALIASES <<< "$spec"
    FOUND=false
    NAME="${ALIASES[0]}"
    for candidate in "${ALIASES[@]}"; do
      if has_val "$candidate"; then
        FOUND=true
        # Check referenced file existence if suffix is _FILE or _PATH
        if [[ "$candidate" == *"_FILE" ]] || [[ "$candidate" == *"_PATH" ]]; then
          FPATH=$(get_val "$candidate")
          if [[ "$FPATH" != /* ]]; then
            FPATH="${PROJECT_ROOT}/${FPATH}"
          fi
          # Check container secrets path vs host path
          if [[ "$FPATH" == "/run/secrets/"* ]]; then
            log_info "[OK] Secret configured for container mount: ${candidate}"
          elif [ -f "$FPATH" ] && [ -r "$FPATH" ]; then
            log_info "[OK] Secret file exists and readable: ${candidate} (${FPATH})"
          else
            log_error "[FAIL] Secret file does not exist or unreadable: ${candidate} (${FPATH})"
            ERRORS=$((ERRORS + 1))
          fi
        fi
        break
      fi
    done

    if [ "$FOUND" = true ]; then
      log_info "[OK] Configuration variable present: ${NAME}"
    else
      log_error "[FAIL] Missing required variable: ${NAME} (or candidate: ${spec})"
      ERRORS=$((ERRORS + 1))
    fi
  done

  # Extract PORT if configured in .env
  ENV_PORT=$(get_val "PORT")
  if [ -n "$ENV_PORT" ]; then
    CHECK_PORT="$ENV_PORT"
  fi
fi

# 6. Check Port Availability
log_info "Validating port ${CHECK_PORT} availability..."
PORT_BUSY=false

if command -v ss >/dev/null 2>&1; then
  if ss -tuln 2>/dev/null | grep -E ":${CHECK_PORT}[[:space:]]" >/dev/null 2>&1; then
    PORT_BUSY=true
  fi
elif command -v netstat >/dev/null 2>&1; then
  if netstat -tuln 2>/dev/null | grep -E ":${CHECK_PORT}[[:space:]]" >/dev/null 2>&1; then
    PORT_BUSY=true
  fi
elif command -v lsof >/dev/null 2>&1; then
  if lsof -i ":${CHECK_PORT}" >/dev/null 2>&1; then
    PORT_BUSY=true
  fi
fi

if [ "$PORT_BUSY" = true ]; then
  # Check if owned by our own dc-bot container
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^dc-bot$' >/dev/null 2>&1; then
    log_info "[OK] Port ${CHECK_PORT} is bound by active container 'dc-bot' (safe for update/restart)."
  else
    log_warn "[WARN] Port ${CHECK_PORT} is already bound by another process."
    log_warn "       Verify port forwarding or configure reverse proxy appropriately."
  fi
else
  log_info "[OK] Port ${CHECK_PORT} is available."
fi

# 7. Summary
if [ "$ERRORS" -gt 0 ]; then
  log_error "=== [PREFLIGHT] Validation FAILED with ${ERRORS} error(s) ==="
  exit 1
else
  log_info "=== [PREFLIGHT] Validation PASSED. System is ready ==="
  exit 0
fi
