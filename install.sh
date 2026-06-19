#!/usr/bin/env bash
# ==========================================================
#  Server Monitor - Automated Installer
#  Supports: Ubuntu/Debian (apt) and RHEL/AlmaLinux/Rocky/CentOS/Fedora (dnf/yum)
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

# ---- 1. OS / package manager detection ------------------------------------
log "Checking operating system..."
if [ ! -f /etc/os-release ]; then
  err "Cannot detect OS (no /etc/os-release)."
  exit 1
fi
. /etc/os-release
PRETTY="${PRETTY_NAME:-${ID:-unknown}}"

# Detect available package manager.
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt";
elif command -v dnf >/dev/null 2>&1; then PKG="dnf";
elif command -v yum >/dev/null 2>&1; then PKG="yum";
fi

case "${ID:-}${ID_LIKE:-}" in
  *ubuntu*|*debian*)                         ok "Detected ${PRETTY} (Debian family)" ;;
  *rhel*|*fedora*|*centos*|*almalinux*|*rocky*) ok "Detected ${PRETTY} (RHEL family)" ;;
  *)                                         warn "OS '${PRETTY}' not explicitly supported. Continuing best-effort." ;;
esac

if [ -z "$PKG" ]; then
  err "No supported package manager found (need apt-get, dnf or yum)."
  exit 1
fi
log "Using package manager: ${PKG}"
export DEBIAN_FRONTEND=noninteractive

# ---- 2. Package helpers + base packages -----------------------------------
pm_update() {
  case "$PKG" in
    apt) run_root apt-get update -y >/dev/null 2>&1 || warn "apt-get update reported issues; continuing." ;;
    dnf) run_root dnf makecache -y >/dev/null 2>&1 || true ;;
    yum) run_root yum makecache -y >/dev/null 2>&1 || true ;;
  esac
}
pm_is_installed() {
  case "$PKG" in
    apt) dpkg -s "$1" >/dev/null 2>&1 ;;
    dnf|yum) rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}
pm_install() {
  case "$PKG" in
    apt) run_root apt-get install -y "$@" >/dev/null 2>&1 ;;
    dnf) run_root dnf install -y "$@" >/dev/null 2>&1 ;;
    yum) run_root yum install -y "$@" >/dev/null 2>&1 ;;
  esac
}
ensure_pkg() {
  local pkg="$1"
  if ! pm_is_installed "$pkg"; then
    log "Installing $pkg..."
    pm_install "$pkg" || warn "Could not install $pkg (continuing)."
  fi
}

log "Refreshing package index..."
pm_update

if ! command -v curl >/dev/null 2>&1; then
  log "Installing curl..."
  pm_install curl || pm_install curl-minimal || warn "Could not install curl."
fi
ensure_pkg ca-certificates

if [ "$PKG" = "apt" ]; then
  ensure_pkg gnupg
  ensure_pkg build-essential
  ensure_pkg python3
else
  # RHEL/Alma/Rocky: toolchain for native module fallback builds (better-sqlite3).
  log "Installing build tools (gcc-c++, make, python3)..."
  pm_install gcc-c++ make python3 tar \
    || run_root dnf groupinstall -y "Development Tools" >/dev/null 2>&1 \
    || warn "Could not install build tools (continuing; prebuilt binaries may still work)."
fi
ok "Base packages ready."

# ---- 3. Node.js LTS -------------------------------------------------------
need_node=true
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then
    need_node=false
    ok "Node.js $(node -v) already installed."
  else
    warn "Node.js $(node -v) is too old (need >= 20). Upgrading to LTS."
  fi
fi

if [ "$need_node" = true ]; then
  log "Installing Node.js LTS (v20) via NodeSource..."
  if [ "$PKG" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | run_root bash - >/dev/null 2>&1
    pm_install nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | run_root bash - >/dev/null 2>&1
    pm_install nodejs
  fi
  if command -v node >/dev/null 2>&1; then
    ok "Installed Node.js $(node -v)."
  else
    err "Node.js installation failed. Please install Node.js 20+ manually and re-run."
    exit 1
  fi
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

# Verify the native SQLite module loads against THIS Node.js ABI.
# If Node was just upgraded, a stale prebuilt binary may remain — rebuild it.
log "Verifying native modules (better-sqlite3)..."
if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  warn "Native SQLite binary mismatch. Rebuilding from source..."
  npm rebuild better-sqlite3 --build-from-source >/dev/null 2>&1 \
    || npm install better-sqlite3 --build-from-source >/dev/null 2>&1 || true
  if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
    err "Could not load better-sqlite3. Ensure build-essential & python3 are installed, then re-run."
    exit 1
  fi
fi
ok "Native modules verified."

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

log "Generating encryption key for SSH credentials..."
ENC_KEY="$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))')"
if grep -q '^ENCRYPTION_KEY=' .env; then
  tmpfile="$(mktemp)"
  sed "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${ENC_KEY}|" .env > "$tmpfile" && mv "$tmpfile" .env
else
  echo "ENCRYPTION_KEY=${ENC_KEY}" >> .env
fi
ok "Encryption key set."

# Read configured PORT / admin user from .env WITHOUT sourcing it.
# (Sourcing breaks on values that contain spaces, e.g. log path labels.)
get_env() {
  grep -E "^$1=" .env | head -n1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
PORT="$(get_env PORT)"; PORT="${PORT:-19091}"
ADMIN_USERNAME="$(get_env ADMIN_USERNAME)"; ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"

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
# Do NOT expose the app port publicly — access via Nginx HTTPS after setup-ssl*.sh
if command -v ufw >/dev/null 2>&1 && run_root ufw status >/dev/null 2>&1; then
  log "Ensuring app port ${PORT} is NOT public (use Nginx HTTPS)..."
  while run_root ufw status numbered 2>/dev/null | grep -q "${PORT}/tcp"; do
    NUM="$(run_root ufw status numbered | grep "${PORT}/tcp" | head -n1 | sed -n 's/^\[\s*\([0-9]*\)\].*/\1/p')"
    [ -n "$NUM" ] && run_root ufw --force delete "$NUM" >/dev/null 2>&1 || break
  done
  ok "Port ${PORT} not opened publicly (ufw)."
elif command -v firewall-cmd >/dev/null 2>&1 && run_root firewall-cmd --state >/dev/null 2>&1; then
  warn "firewalld detected — do not expose port ${PORT} publicly. Use Nginx HTTPS."
else
  warn "Configure firewall so port ${PORT} is NOT public. Use Nginx HTTPS to access the panel."
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
