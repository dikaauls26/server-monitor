#!/usr/bin/env bash
# ==========================================================
#  Server Monitor - HTTPS with self-signed certificate (IP only)
#  Use when you do NOT have a domain name.
#
#  Usage:  bash setup-ssl-selfsigned.sh [SERVER_IP]
#
#  Result:  https://YOUR_IP/  (browser will show a security warning — expected)
#  App still runs on 127.0.0.1:PORT behind Nginx.
# ==========================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[*]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[X]${NC} $*" >&2; }

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

SERVER_IP="${1:-}"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "$SERVER_IP" ]; then
  err "Could not detect server IP. Usage: bash setup-ssl-selfsigned.sh 159.65.10.186"
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
run_root() { if [ -n "$SUDO" ]; then sudo "$@"; else "$@"; fi; }

get_env() {
  grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
APP_PORT="$(get_env PORT)"; APP_PORT="${APP_PORT:-19091}"

log "Server IP: ${SERVER_IP}"
log "App backend: http://127.0.0.1:${APP_PORT}"

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt";
elif command -v dnf >/dev/null 2>&1; then PKG="dnf";
elif command -v yum >/dev/null 2>&1; then PKG="yum";
fi
if [ -z "$PKG" ]; then
  err "Need apt, dnf, or yum to install Nginx."
  exit 1
fi

pm_install() {
  case "$PKG" in
    apt) run_root apt-get update -y >/dev/null 2>&1; run_root apt-get install -y "$@" ;;
    dnf) run_root dnf install -y "$@" ;;
    yum) run_root yum install -y "$@" ;;
  esac
}

log "Installing Nginx + OpenSSL..."
pm_install nginx openssl

SSL_DIR="/etc/nginx/ssl/server-monitor"
run_root mkdir -p "$SSL_DIR"

if [ ! -f "$SSL_DIR/server-monitor.crt" ]; then
  log "Creating self-signed certificate (valid 2 years)..."
  run_root openssl req -x509 -nodes -days 730 -newkey rsa:2048 \
    -keyout "$SSL_DIR/server-monitor.key" \
    -out "$SSL_DIR/server-monitor.crt" \
    -subj "/CN=${SERVER_IP}" \
    -addext "subjectAltName=IP:${SERVER_IP}" 2>/dev/null \
    || run_root openssl req -x509 -nodes -days 730 -newkey rsa:2048 \
         -keyout "$SSL_DIR/server-monitor.key" \
         -out "$SSL_DIR/server-monitor.crt" \
         -subj "/CN=${SERVER_IP}"
  ok "Certificate created."
else
  warn "Certificate already exists at ${SSL_DIR} — reusing."
fi

NGINX_SITE="/etc/nginx/sites-available/server-monitor-ssl"
NGINX_ENABLED="/etc/nginx/sites-enabled/server-monitor-ssl"

write_site() {
  local dest="$1"
  run_root tee "$dest" >/dev/null <<EOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${SERVER_IP};

    ssl_certificate ${SSL_DIR}/server-monitor.crt;
    ssl_certificate_key ${SSL_DIR}/server-monitor.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name ${SERVER_IP};
    return 301 https://\$host\$request_uri;
}
EOF
}

if [ "$PKG" = "apt" ]; then
  write_site "$NGINX_SITE"
  run_root ln -sf "$NGINX_SITE" "$NGINX_ENABLED"
  run_root rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
else
  write_site "/etc/nginx/conf.d/server-monitor-ssl.conf"
fi

log "Testing Nginx..."
run_root nginx -t
run_root systemctl enable nginx >/dev/null 2>&1 || true
run_root systemctl reload nginx || run_root systemctl restart nginx

update_env() {
  local key="$1"
  local val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    tmpfile="$(mktemp)"
    sed "s|^${key}=.*|${key}=${val}|" .env > "$tmpfile" && mv "$tmpfile" .env
  else
    echo "${key}=${val}" >> .env
  fi
}

update_env "SECURE_COOKIE" "true"
update_env "PUBLIC_URL" "https://${SERVER_IP}"

if command -v ufw >/dev/null 2>&1 && run_root ufw status >/dev/null 2>&1; then
  run_root ufw allow 443/tcp >/dev/null 2>&1 || true
  run_root ufw allow 80/tcp >/dev/null 2>&1 || true
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart server-monitor --update-env >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

echo ""
echo "=================================="
echo " HTTPS (self-signed) ENABLED"
echo ""
echo " URL:  https://${SERVER_IP}/"
echo ""
warn "Browser will show 'Not secure' warning."
echo "      Click Advanced → Proceed (safe if this is your server)."
echo ""
echo " HTTP :19091 still works locally but use HTTPS for login."
echo "=================================="
