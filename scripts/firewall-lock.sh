#!/usr/bin/env bash
# Lock Server Monitor app port from the public internet.
# Nginx on 443/8443 should be the only public entry point.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

get_env() {
  grep -E "^$1=" .env 2>/dev/null | head -n1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

PORT="$(get_env PORT)"; PORT="${PORT:-19091}"
SECURE="$(get_env SECURE_COOKIE)"
PUBLIC="$(get_env PUBLIC_URL)"

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
run_root() { if [ -n "$SUDO" ]; then sudo "$@"; else "$@"; fi; }

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

echo "[*] Locking app port ${PORT} from public access..."

if command -v ufw >/dev/null 2>&1 && run_root ufw status >/dev/null 2>&1; then
  while run_root ufw status numbered 2>/dev/null | grep -q "${PORT}/tcp"; do
    NUM="$(run_root ufw status numbered | grep "${PORT}/tcp" | head -n1 | sed -n 's/^\[\s*\([0-9]*\)\].*/\1/p')"
    [ -n "$NUM" ] && run_root ufw --force delete "$NUM" >/dev/null 2>&1 || break
  done
  echo "[OK] Removed UFW allow rule for port ${PORT} (if any)."
fi

if command -v firewall-cmd >/dev/null 2>&1 && run_root firewall-cmd --state >/dev/null 2>&1; then
  run_root firewall-cmd --permanent --remove-port="${PORT}/tcp" >/dev/null 2>&1 || true
  run_root firewall-cmd --reload >/dev/null 2>&1 || true
  echo "[OK] Removed firewalld rule for port ${PORT} (if any)."
fi

if [ "$SECURE" = "true" ] || [ -n "$PUBLIC" ]; then
  update_env "HOST" "127.0.0.1"
  echo "[OK] Set HOST=127.0.0.1 — app only reachable via Nginx reverse proxy."
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart server-monitor --update-env >/dev/null 2>&1 || true
  fi
else
  echo "[!] HTTPS not configured yet — HOST left unchanged. Run again after SSL setup."
fi

echo "[OK] Firewall lock complete. Access panel via HTTPS (Nginx), not :${PORT} directly."
