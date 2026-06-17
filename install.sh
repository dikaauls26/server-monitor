#!/usr/bin/env bash
# ==========================================================
#  Server Monitor - Automated Installer (Ubuntu / Debian)
#  Usage:  bash install.sh
# ==========================================================
set -euo pipefail

# ---- Pretty output --------------------------------------------------------
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[*]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[X]${NC} $*" >&2; }

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# ---- sudo helper (works as root or normal user) ---------------------------
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
run_root() { if [ -n "$SUDO" ]; then sudo "$@"; else "$@"; fi; }

echo "=================================================="
echo "        SERVER MONITOR - INSTALLER"
echo "=================================================="

# ---- 1. OS check ----------------------------------------------------------
log "Checking operating system..."
if [ ! -f /etc/os-release ]; then
  err "Cannot detect OS. This installer supports Ubuntu/Debian only."
  exit 1
fi
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
  *ubuntu*|*debian*) ok "Detected ${PRETTY_NAME:-$ID}" ;;
  *) warn "OS '${PRETTY_NAME:-$ID}' is not Ubuntu/Debian. Continuing anyway (best effort)." ;;
esac

export DEBIAN_FRONTEND=noninteractive

# ---- 2. Base packages (curl, ca-certs) ------------------------------------
log "Updating apt index..."
run_root apt-get update -y >/dev/null 2>&1 || warn "apt-get update reported issues; continuing."

ensure_pkg() {
  local pkg="$1"
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    log "Installing $pkg..."
    run_root apt-get install -y "$pkg" >/dev/null 2>&1 || warn "Could not install $pkg."
  fi
}

if ! command -v curl >/dev/null 2>&1; then
  log "curl not found. Installing..."
  run_root apt-get install -y curl >/dev/null 2>&1
fi
ensure_pkg ca-certificates
ensure_pkg gnupg
# build tools help if better-sqlite3 needs to compile (usually prebuilt binaries exist)
ensure_pkg build-essential
ensure_pkg python3
ok "Base packages ready."

# ---- 3. Node.js LTS -------------------------------------------------------
need_node=true
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 18 ]; then
    need_node=false
    ok "Node.js $(node -v) already installed."
  else
    warn "Node.js $(node -v) is too old (need >= 18). Upgrading to LTS."
  fi
fi

if [ "$need_node" = true ]; then
  log "Installing Node.js LTS (v20) via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash - >/dev/null 2>&1
  run_root apt-get install -y nodejs >/dev/null 2>&1
  ok "Installed Node.js $(node -v)."
fi

command -v npm >/dev/null 2>&1 || { err "npm is not available after Node install."; exit 1; }
ok "npm $(npm -v) ready."

# ---- 4. Install dependencies ---------------------------------------------
log "Installing npm dependencies (this may take a minute)..."
if [ -f package-lock.json ]; then
  npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev
else
  npm install --omit=dev
fi
ok "Dependencies installed."

# ---- 5. Generate .env -----------------------------------------------------
if [ ! -f .env ]; then
  log "Creating .env from .env.example..."
  cp .env.example .env
  ok ".env created."
else
  warn ".env already exists. Keeping existing configuration."
fi

# ---- 6. Generate session secret ------------------------------------------
log "Generating session secret..."
SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
if grep -q '^SESSION_SECRET=' .env; then
  # portable in-place edit
  tmpfile="$(mktemp)"
  sed "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env > "$tmpfile" && mv "$tmpfile" .env
else
  echo "SESSION_SECRET=${SECRET}" >> .env
fi
ok "Session secret set."

# Load .env so we know the configured PORT / admin user.
set -a; . ./.env; set +a
PORT="${PORT:-19091}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

# ---- 7. Database: migrate + seed -----------------------------------------
mkdir -p storage logs
log "Creating & migrating SQLite database..."
node database/migrate.js
log "Seeding admin account..."
node database/seed.js
ok "Database ready."

# ---- 8. PM2 ---------------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing PM2 globally..."
  run_root npm install -g pm2 >/dev/null 2>&1
  ok "PM2 installed."
else
  ok "PM2 already installed ($(pm2 -v))."
fi

log "Starting application with PM2..."
pm2 start ecosystem.config.js >/dev/null 2>&1 || pm2 restart server-monitor >/dev/null 2>&1
pm2 save >/dev/null 2>&1 || true

log "Enabling PM2 startup on boot..."
STARTUP_CMD="$(pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null | grep 'sudo' || true)"
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD" >/dev/null 2>&1 || warn "Could not auto-enable startup. Run manually: $STARTUP_CMD"
fi
pm2 save >/dev/null 2>&1 || true
ok "PM2 configured."

# ---- 9. Firewall ----------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  log "Opening port ${PORT} in UFW firewall..."
  run_root ufw allow "${PORT}/tcp" >/dev/null 2>&1 || warn "Could not modify UFW rules."
  ok "Firewall rule added for port ${PORT}."
else
  warn "UFW not installed; skipping firewall configuration."
fi

# ---- 10. Detect server IP -------------------------------------------------
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "${SERVER_IP:-}" ] && SERVER_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || echo 'SERVER_IP')"

# ---- Done -----------------------------------------------------------------
echo ""
echo "=================================="
echo " SERVER MONITOR INSTALLED"
echo ""
echo " URL:"
echo " http://${SERVER_IP}:${PORT}"
echo ""
echo " LOGIN:"
echo " ${ADMIN_USERNAME}"
echo ""
echo " STATUS:"
echo " RUNNING"
echo "=================================="
echo ""
echo "Manage with:  pm2 list | pm2 logs server-monitor | bash stop.sh"
