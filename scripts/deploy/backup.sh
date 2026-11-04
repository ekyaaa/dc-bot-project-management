#!/usr/bin/env bash
# ==============================================================================
# Script: scripts/deploy/backup.sh
# Purpose: Consistent online SQLite backup via VACUUM INTO and retention pruning.
# Standards: set -euo pipefail, non-blocking online snapshot, chmod 600.
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

log_info()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [INFO]  $*" ; }
log_warn()  { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [WARN]  $*" >&2 ; }
log_error() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] [ERROR] $*" >&2 ; }

BACKUP_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/data/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
CUSTOM_DB_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup-dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --retention-days)
      RETENTION_DAYS="$2"
      shift 2
      ;;
    --db-path)
      CUSTOM_DB_PATH="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./backup.sh [--backup-dir <dir>] [--retention-days <N>] [--db-path <file>]"
      exit 0
      ;;
    *)
      log_warn "Unknown parameter: $1"
      shift
      ;;
  esac
done

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
BACKUP_FILENAME="sqlite-backup-${TIMESTAMP}.db"
BACKUP_FILE="${BACKUP_DIR}/${BACKUP_FILENAME}"

log_info "=== [BACKUP] Starting SQLite Consistent Online Backup ==="
log_info "Destination: ${BACKUP_FILE}"

# Identify execution mode: Container vs Host
CONTAINER_RUNNING=false
if command -v docker >/dev/null 2>&1; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^dc-bot$' >/dev/null 2>&1; then
    CONTAINER_RUNNING=true
  fi
fi

if [ "$CONTAINER_RUNNING" = true ] && [ -z "$CUSTOM_DB_PATH" ]; then
  log_info "Executing online backup inside active container 'dc-bot'..."
  # Create directory in container volume if missing
  docker exec -t dc-bot mkdir -p /data/backups
  # Crucial: VACUUM INTO destination string in single quotes
  docker exec -t dc-bot sqlite3 /data/bot.db "VACUUM INTO '/data/backups/${BACKUP_FILENAME}';"

  # Copy snapshot from container volume to host backup directory if host path differs
  if [ ! -f "$BACKUP_FILE" ]; then
    docker cp "dc-bot:/data/backups/${BACKUP_FILENAME}" "$BACKUP_FILE"
  fi
else
  # Direct host database backup
  HOST_DB="${CUSTOM_DB_PATH:-${PROJECT_ROOT}/data/bot.db}"
  if [ ! -f "$HOST_DB" ] && [ -f "${PROJECT_ROOT}/data/bot.sqlite" ]; then
    HOST_DB="${PROJECT_ROOT}/data/bot.sqlite"
  fi

  if [ ! -f "$HOST_DB" ]; then
    log_error "Active SQLite database file not found at ${HOST_DB}"
    exit 1
  fi

  if ! command -v sqlite3 >/dev/null 2>&1; then
    log_error "'sqlite3' command line tool not found on host."
    exit 1
  fi

  log_info "Performing VACUUM INTO from host DB: ${HOST_DB}"
  sqlite3 "$HOST_DB" "VACUUM INTO '${BACKUP_FILE}';"
fi

# 1. Verify Backup Existence & Permissions
if [ ! -f "$BACKUP_FILE" ] || [ ! -s "$BACKUP_FILE" ]; then
  log_error "Backup file was not created or is empty: ${BACKUP_FILE}"
  exit 1
fi
chmod 600 "$BACKUP_FILE"

# 2. Verify Magic Header
MAGIC=$(head -c 15 "$BACKUP_FILE" || true)
if [ "$MAGIC" != "SQLite format 3" ]; then
  log_error "Backup verification failed: Invalid SQLite magic header: '${MAGIC}'"
  rm -f "$BACKUP_FILE"
  exit 1
fi

# 3. Verify SQLite Integrity
INTEG=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>/dev/null || echo "failed")
if [ "$INTEG" != "ok" ]; then
  log_error "Backup verification failed: PRAGMA integrity_check reported: ${INTEG}"
  rm -f "$BACKUP_FILE"
  exit 1
fi

FILE_SIZE=$(wc -c < "$BACKUP_FILE" | tr -d ' ')
log_info "[OK] Backup created and verified successfully (${FILE_SIZE} bytes)."

# 4. Retention Policy Pruning
if [ "$RETENTION_DAYS" -gt 0 ]; then
  log_info "Evaluating backup retention (pruning older than ${RETENTION_DAYS} days)..."
  PRUNED_COUNT=0
  while IFS= read -r old_file; do
    if [ -n "$old_file" ]; then
      rm -f "$old_file"
      log_info "Pruned expired backup: $(basename "$old_file")"
      PRUNED_COUNT=$((PRUNED_COUNT + 1))
    fi
  done < <(find "$BACKUP_DIR" -maxdepth 1 -name "sqlite-backup-*.db" -type f -mtime +"$RETENTION_DAYS" 2>/dev/null || true)

  if [ "$PRUNED_COUNT" -eq 0 ]; then
    log_info "No expired backups needed pruning."
  else
    log_info "Total backups pruned: ${PRUNED_COUNT}"
  fi
fi

log_info "=== [BACKUP] Completed Successfully ==="
