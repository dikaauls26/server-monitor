#!/usr/bin/env bash
# Pull latest code, update dependencies, migrate DB, and restart.
set -euo pipefail

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[*]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [ -d .git ]; then
  log "Pulling latest changes from git..."
  git pull --ff-only || log "git pull skipped (local changes or no remote)."
fi

log "Updating dependencies..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev || npm install --omit=dev
else
  npm install --omit=dev
fi

log "Running database migrations..."
node database/migrate.js

if ! grep -q '^ENCRYPTION_KEY=' .env 2>/dev/null; then
  log "Generating ENCRYPTION_KEY..."
  ENC_KEY="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
  echo "ENCRYPTION_KEY=${ENC_KEY}" >> .env
  ok "ENCRYPTION_KEY added to .env"
fi

log "Encrypting SSH credentials (if any)..."
node -e "const r=require('./services/credentialMigrationService').encryptAll(); console.log(r.message||r.error||'done')" || warn "Credential encryption skipped."

log "Hardening firewall (close public app port)..."
bash scripts/firewall-lock.sh || warn "Firewall lock skipped."

log "Restarting application..."
if command -v pm2 >/dev/null 2>&1 && pm2 describe server-monitor >/dev/null 2>&1; then
  pm2 restart server-monitor --update-env
  pm2 save >/dev/null 2>&1 || true
else
  bash start.sh
fi

ok "Update complete."
