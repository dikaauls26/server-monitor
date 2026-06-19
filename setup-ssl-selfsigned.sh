#!/usr/bin/env bash
# ==========================================================
#  Server Monitor - HTTPS with self-signed certificate (IP only)
#  Use when you do NOT have a domain name.
#
#  Usage:
#    bash setup-ssl-selfsigned.sh [SERVER_IP] [HTTPS_PORT]
#
#  If port 80/443 are already used (CyberPanel/OpenLiteSpeed), the script
#  automatically uses port 8443 unless you specify another HTTPS_PORT.
#
#  Result:  https://YOUR_IP:8443/  (browser warning — expected for self-signed)
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
HTTPS_PORT="${2:-}"

if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || true)"
fi
if [ -z "$SERVER_IP" ]; then
  err "Could not detect server IP. Usage: bash setup-ssl-selfsigned.sh 159.65.10.186 [8443]"
  exit 1
fi

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
run_root() { if [ -n "$SUDO" ]; then sudo "$@"; else "$@"; fi; }

get_env() {
  grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}
APP_PORT="$(get_env PORT)"; APP_PORT="${APP_PORT:-19091}"

port_busy() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH 2>/dev/null | awk -v p=":${p}" '$4 ~ p"$" {found=1} END{exit !found}'
    return
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | grep -q ":${p} "
    return
  fi
  return 1
}

show_port_users() {
  log "Processes listening on 80/443:"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep -E ':80 |:443 ' || echo "  (could not list)"
  else
    netstat -tlnp 2>/dev/null | grep -E ':80 |:443 ' || echo "  (could not list)"
  fi
}

if [ -z "$HTTPS_PORT" ]; then
  if port_busy 80 || port_busy 443; then
    show_port_users
    warn "Port 80 or 443 is already in use (often CyberPanel / OpenLiteSpeed / Apache)."
    HTTPS_PORT=8443
    warn "Using alternate HTTPS port ${HTTPS_PORT} for Server Monitor."
  else
    HTTPS_PORT=443
  fi
fi

PUBLIC_URL="https://${SERVER_IP}"
if [ "$HTTPS_PORT" != "443" ]; then
  PUBLIC_URL="${PUBLIC_URL}:${HTTPS_PORT}"
fi

log "Server IP: ${SERVER_IP}"
log "HTTPS port: ${HTTPS_PORT}"
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

if ! command -v nginx >/dev/null 2>&1; then
  log "Installing Nginx + OpenSSL..."
  pm_install nginx openssl
else
  log "Nginx already installed."
  pm_install openssl || true
fi

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
NGINX_CONF="/etc/nginx/conf.d/server-monitor-ssl.conf"

write_site() {
  local dest="$1"
  if [ "$HTTPS_PORT" = "443" ] && ! port_busy 80; then
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
  else
    run_root tee "$dest" >/dev/null <<EOF
server {
    listen ${HTTPS_PORT} ssl;
    listen [::]:${HTTPS_PORT} ssl;
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
EOF
  fi
}

# Avoid default Debian site binding :80 when something else already uses it.
if [ "$PKG" = "apt" ] && (port_busy 80 || [ "$HTTPS_PORT" != "443" ]); then
  if [ -f /etc/nginx/sites-enabled/default ]; then
    warn "Disabling nginx default site (port 80 conflict)."
    run_root rm -f /etc/nginx/sites-enabled/default
  fi
fi

if [ "$PKG" = "apt" ]; then
  write_site "$NGINX_SITE"
  run_root ln -sf "$NGINX_SITE" "$NGINX_ENABLED"
else
  write_site "$NGINX_CONF"
fi

if port_busy "$HTTPS_PORT"; then
  err "Port ${HTTPS_PORT} is also in use. Pick another port:"
  err "  bash setup-ssl-selfsigned.sh ${SERVER_IP} 8443"
  exit 1
fi

log "Testing Nginx configuration..."
run_root nginx -t

log "Starting / reloading Nginx..."
run_root systemctl enable nginx >/dev/null 2>&1 || true
if run_root systemctl is-active nginx >/dev/null 2>&1; then
  run_root systemctl reload nginx
else
  run_root systemctl start nginx
fi
ok "Nginx is running."

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
  if [ "$HTTPS_PORT" = "443" ]; then
    run_root ufw allow 80/tcp >/dev/null 2>&1 || true
  fi
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart server-monitor --update-env >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
fi

bash scripts/firewall-lock.sh >/dev/null 2>&1 || true

echo ""
echo "=================================="
echo " HTTPS (self-signed) ENABLED"
echo ""
echo " URL:  ${PUBLIC_URL}/"
echo ""
warn "Browser will show 'Not secure' warning."
echo "      Click Advanced → Proceed (safe if this is your server)."
if [ "$HTTPS_PORT" != "443" ]; then
  echo ""
  echo " Port 80/443 were busy — Server Monitor uses port ${HTTPS_PORT} only."
  echo " Your websites on CyberPanel/OpenLiteSpeed are not affected."
fi
echo "=================================="
