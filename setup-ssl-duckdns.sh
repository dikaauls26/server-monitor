#!/usr/bin/env bash
# ==========================================================
#  Server Monitor - Let's Encrypt via DuckDNS (DNS challenge)
#  Use when port 80/443 are taken by CyberPanel / OpenLiteSpeed.
#
#  Usage:
#    bash setup-ssl-duckdns.sh monitors2.duckdns.org YOUR_DUCKDNS_TOKEN [email] [8443]
#
#  Get token: https://www.duckdns.org → login → copy token on main page
#  Set DuckDNS subdomain IP to this server's public IP first.
#
#  Result: https://monitors2.duckdns.org:8443/  (trusted green padlock)
# ==========================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[*]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[X]${NC} $*" >&2; }

DOMAIN="${1:-}"
DUCKDNS_TOKEN="${2:-}"
EMAIL="${3:-}"
HTTPS_PORT="${4:-8443}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

if [ -z "$DOMAIN" ] || [ -z "$DUCKDNS_TOKEN" ]; then
  err "Usage: bash setup-ssl-duckdns.sh yourname.duckdns.org DUCKDNS_TOKEN [email] [8443]"
  err "Token from https://www.duckdns.org (shown after login)."
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

PUBLIC_URL="https://${DOMAIN}"
if [ "$HTTPS_PORT" != "443" ]; then
  PUBLIC_URL="${PUBLIC_URL}:${HTTPS_PORT}"
fi

log "Domain: ${DOMAIN}"
log "HTTPS port: ${HTTPS_PORT}"
log "Public URL: ${PUBLIC_URL}/"
log "App backend: http://127.0.0.1:${APP_PORT}"

if command -v dig >/dev/null 2>&1; then
  RESOLVED="$(dig +short "$DOMAIN" 2>/dev/null | tail -n1 || true)"
  SERVER_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$RESOLVED" ] && [ -n "$SERVER_IP" ] && [ "$RESOLVED" != "$SERVER_IP" ]; then
    warn "DNS ${DOMAIN} → ${RESOLVED} but this server is ${SERVER_IP}"
    warn "Update DuckDNS IP first, then re-run."
  else
    ok "DNS check: ${DOMAIN} → ${RESOLVED:-unknown}"
  fi
fi

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt";
elif command -v dnf >/dev/null 2>&1; then PKG="dnf";
elif command -v yum >/dev/null 2>&1; then PKG="yum";
fi

pm_install() {
  case "$PKG" in
    apt) run_root apt-get update -y >/dev/null 2>&1; run_root apt-get install -y "$@" ;;
    dnf) run_root dnf install -y "$@" ;;
    yum) run_root yum install -y "$@" ;;
  esac
}

log "Installing Nginx, curl, openssl..."
if [ -n "$PKG" ]; then
  pm_install nginx curl openssl socat ca-certificates || true
fi

ACME="$HOME/.acme.sh/acme.sh"
if [ ! -x "$ACME" ]; then
  log "Installing acme.sh..."
  curl -fsSL https://get.acme.sh | sh -s email="$EMAIL"
fi
if [ ! -x "$ACME" ]; then
  err "Failed to install acme.sh"
  exit 1
fi

SSL_DIR="/etc/nginx/ssl/server-monitor"
run_root mkdir -p "$SSL_DIR"

log "Requesting Let's Encrypt certificate (DNS challenge via DuckDNS)..."
export DuckDNS_Token="$DUCKDNS_TOKEN"
"$ACME" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
"$ACME" --issue --dns dns_duckdns -d "$DOMAIN" --keylength ec-256 --force

log "Installing certificate for Nginx..."
"$ACME" --install-cert -d "$DOMAIN" \
  --key-file "$SSL_DIR/le.key" \
  --fullchain-file "$SSL_DIR/le.crt" \
  --reloadcmd "systemctl reload nginx 2>/dev/null || true"

NGINX_SITE="/etc/nginx/sites-available/server-monitor-le"
NGINX_ENABLED="/etc/nginx/sites-enabled/server-monitor-le"

write_site() {
  local dest="$1"
  run_root tee "$dest" >/dev/null <<EOF
server {
    listen ${HTTPS_PORT} ssl;
    listen [::]:${HTTPS_PORT} ssl;
    server_name ${DOMAIN};

    ssl_certificate ${SSL_DIR}/le.crt;
    ssl_certificate_key ${SSL_DIR}/le.key;
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
EOF
}

if [ "$PKG" = "apt" ]; then
  if [ -f /etc/nginx/sites-enabled/default ]; then
    warn "Disabling nginx default site."
    run_root rm -f /etc/nginx/sites-enabled/default
  fi
  write_site "$NGINX_SITE"
  run_root ln -sf "$NGINX_SITE" "$NGINX_ENABLED"
else
  write_site "/etc/nginx/conf.d/server-monitor-le.conf"
fi

log "Testing Nginx..."
run_root nginx -t
run_root systemctl enable nginx >/dev/null 2>&1 || true
if run_root systemctl is-active nginx >/dev/null 2>&1; then
  run_root systemctl reload nginx
else
  run_root systemctl start nginx
fi

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
update_env "PUBLIC_URL" "${PUBLIC_URL}"

if command -v ufw >/dev/null 2>&1 && run_root ufw status >/dev/null 2>&1; then
  run_root ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart server-monitor --update-env >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

bash scripts/firewall-lock.sh >/dev/null 2>&1 || true

echo ""
echo "=================================="
echo " HTTPS ENABLED (Let's Encrypt)"
echo ""
echo " URL:  ${PUBLIC_URL}/"
echo ""
echo " Trusted certificate — no browser privacy error."
echo " Port 80/443 on CyberPanel are untouched."
echo ""
echo " Renew: ~/.acme.sh/acme.sh --renew -d ${DOMAIN}"
echo "=================================="
