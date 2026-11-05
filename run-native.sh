#!/bin/bash
# ==============================================================================
# Native Runner for Discord Project Management Bot on Host
# ==============================================================================
set -e

cd "$(dirname "$0")"

# Ensure PATH includes local bin for npm/npx/node
export PATH="/home/mashupsoat/.local/bin:/usr/local/bin:$PATH"

if [ ! -f ".env" ]; then
  echo "[ERROR] .env file not found in $(pwd)"
  exit 1
fi

if [ ! -d "dist" ]; then
  echo "[INFO] dist/ directory not found. Building project..."
  npm run build
fi

echo "[INFO] Starting Discord Project Management Bot with native Node 22..."
exec /usr/bin/node --env-file=.env dist/main.js
