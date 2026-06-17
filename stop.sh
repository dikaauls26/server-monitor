#!/usr/bin/env bash
# Stop Server Monitor (keeps it in the PM2 process list).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[X] PM2 is not installed."
  exit 1
fi

if pm2 describe server-monitor >/dev/null 2>&1; then
  echo "[*] Stopping server-monitor..."
  pm2 stop server-monitor
  pm2 save >/dev/null 2>&1 || true
  echo "[OK] Server Monitor stopped."
else
  echo "[!] server-monitor is not registered with PM2."
fi
