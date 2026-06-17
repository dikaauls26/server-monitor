#!/usr/bin/env bash
# Start (or restart) Server Monitor via PM2.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[X] PM2 is not installed. Run: bash install.sh"
  exit 1
fi

if pm2 describe server-monitor >/dev/null 2>&1; then
  echo "[*] Restarting server-monitor..."
  pm2 restart server-monitor --update-env
else
  echo "[*] Starting server-monitor..."
  pm2 start ecosystem.config.js
fi

pm2 save >/dev/null 2>&1 || true

PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 19091)"
PORT="${PORT:-19091}"
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "[OK] Server Monitor running at http://${SERVER_IP:-SERVER_IP}:${PORT}"
