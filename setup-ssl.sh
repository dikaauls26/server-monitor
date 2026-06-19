#!/usr/bin/env bash
# ==========================================================
#  Server Monitor - HTTPS setup (Nginx + Let's Encrypt)
#  Usage:  bash setup-ssl.sh your-domain.com [email@domain.com]
#
#  Prerequisites:
#    - Domain A record must point to this server's public IP
#    - Port 80 and 443 open in firewall
#    - Server Monitor already installed and running (PM2)
# ==========================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[*]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[X]${NC} $*" >&2; }

DOMAIN="${1:-}"
EMAIL="${2:-}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [ -z "$DOMAIN" ]; then
  err "Usage: bash setup-ssl.sh your-domain.com [admin@your-domain.com]"
  exit 1
fi
if [ -z "$EMAIL" ]; then
  EMAIL="admin@${DOMAIN}"
fi

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
run_root() { if [ -n "$SUDO" ]; then sudo "$@"; else "$@"; fi; }

get_env() {
  grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
APP_PORT="$(get_env PORT)"; APP_PORT="${APP_PORT:-19091}"

log "Domain: ${DOMAIN}"
log "App backend: http://127.0.0.1:${APP_PORT}"

port_busy() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH 2>/dev/null | awk -v p=":${p}" '$4 ~ p"$" {found=1} END{exit !found}'
    return
  fi
  return 1
}

if port_busy 80; then
  echo ""
  warn "Port 80 is already in use (CyberPanel / OpenLiteSpeed / Apache)."
  warn "Let's Encrypt HTTP verification will fail with 404."
  echo ""
  err "Use DuckDNS DNS challenge instead:"
  err "  bash setup-ssl-duckdns.sh ${DOMAIN} YOUR_DUCKDNS_TOKEN ${EMAIL}"
  err "Token: https://www.duckdns.org → login → copy token"
  exit 1
fi

# ---- Detect package manager -----------------------------------------------
PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt";
elif command -v dnf >/dev/null 2>&1; then PKG="dnf";
elif command -v yum >/dev/null 2>&1; then PKG="yum";
fi
if [ -z "$PKG" ]; then
  err "Need apt, dnf, or yum to install Nginx and Certbot."
  exit 1
fi

pm_install() {
  case "$PKG" in
    apt) run_root apt-get update -y >/dev/null 2>&1; run_root apt-get install -y "$@" ;;
    dnf) run_root dnf install -y "$@" ;;
    yum) run_root yum install -y "$@" ;;
  esac
}

log "Installing Nginx..."
pm_install nginx

log "Installing Certbot..."
case "$PKG" in
  apt)
    pm_install certbot python3-certbot-nginx
    ;;
  dnf|yum)
    pm_install certbot python3-certbot-nginx || pm_install certbot
    ;;
esac

NGINX_SITE="/etc/nginx/sites-available/server-monitor"
NGINX_ENABLED="/etc/nginx/sites-enabled/server-monitor"

if [ "$PKG" = "apt" ]; then
  log "Writing Nginx site config..."
  run_root tee "$NGINX_SITE" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

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
EOF
  run_root ln -sf "$NGINX_SITE" "$NGINX_ENABLED"
  run_root rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
else
  NGINX_CONF="/etc/nginx/conf.d/server-monitor.conf"
  run_root tee "$NGINX_CONF" >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

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
EOF
fi

log "Testing Nginx configuration..."
run_root nginx -t
run_root systemctl enable nginx >/dev/null 2>&1 || true
run_root systemctl reload nginx || run_root systemctl restart nginx

log "Requesting SSL certificate from Let's Encrypt..."
run_root certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

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

log "Updating .env for HTTPS..."
update_env "SECURE_COOKIE" "true"
update_env "PUBLIC_URL" "https://${DOMAIN}"

if command -v ufw >/dev/null 2>&1 && run_root ufw status >/dev/null 2>&1; then
  log "Opening ports 80/443 in UFW..."
  run_root ufw allow 80/tcp >/dev/null 2>&1 || true
  run_root ufw allow 443/tcp >/dev/null 2>&1 || true
  ok "Firewall updated (80, 443)."
fi

if command -v pm2 >/dev/null 2>&1; then
  log "Restarting Server Monitor..."
  pm2 restart server-monitor --update-env >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

echo ""
echo "=================================="
echo " HTTPS ENABLED"
echo ""
echo " URL:  https://${DOMAIN}"
echo ""
echo " App still listens on 127.0.0.1:${APP_PORT}"
echo " Nginx terminates SSL on port 443"
echo ""
echo " Renew cert:  certbot renew --dry-run"
echo "=================================="
