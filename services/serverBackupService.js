'use strict';

/**
 * CyberPanel server image backup — archive created on target, pulled to central storage.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const sshService = require('./sshService');
const serverRepository = require('../repositories/serverRepository');
const { resolveTarget } = require('./monitoringAllService');
const { remoteBash } = require('./shellScript');
const { run } = require('./execHelper');

const BACKUP_ROOT = path.join(config.storageDir, 'server-backups');
const MAX_IMAGES_PER_SERVER = 5;
const isLinux = os.platform() === 'linux';
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const CREATE_BACKUP_SCRIPT = remoteBash(`
set -e
TS=$(date +%Y%m%d-%H%M%S)
TAG="sm-server-backup-$TS"
WORKDIR="/tmp/$TAG"
ARCHIVE="/tmp/$TAG.tar.gz"
mkdir -p "$WORKDIR/mysql" "$WORKDIR/cfg" "$WORKDIR/sites" "$WORKDIR/ssl"

PW=""
if [ -f /etc/cyberpanel/mysqlPassword ]; then
  PW=$(cat /etc/cyberpanel/mysqlPassword 2>/dev/null | tr -d '\\r\\n')
fi

dump_db() {
  db="$1"
  [ -n "$db" ] || return 0
  mysql -u root -p"$PW" "$db" > "$WORKDIR/mysql/\${db}.sql" 2>/dev/null || true
}

if [ -n "$PW" ]; then
  dump_db cyberpanel
  mysql -u root -p"$PW" cyberpanel -N -e "SELECT dbName FROM websiteFunctions_databases" 2>/dev/null | while read -r db; do
    dump_db "$db"
  done
fi

if [ -d /etc/cyberpanel ]; then
  cp -a /etc/cyberpanel "$WORKDIR/cfg/cyberpanel" 2>/dev/null || true
fi
if [ -d /usr/local/lsws/conf ]; then
  cp -a /usr/local/lsws/conf "$WORKDIR/cfg/lsws-conf" 2>/dev/null || true
fi
if [ -d /etc/letsencrypt ]; then
  cp -a /etc/letsencrypt "$WORKDIR/ssl/letsencrypt" 2>/dev/null || true
fi

if [ -d /home ]; then
  for site in /home/*/public_html; do
    [ -d "$site" ] || continue
    dom=$(basename "$(dirname "$site")")
    mkdir -p "$WORKDIR/sites/$dom"
    cp -a "$site" "$WORKDIR/sites/$dom/public_html" 2>/dev/null || true
  done
fi

HOST=$(hostname 2>/dev/null || echo unknown)
python3 - << PY
import json, datetime
open("$WORKDIR/manifest.json", "w").write(json.dumps({
  "version": 1,
  "hostname": "$HOST",
  "created": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
  "tag": "$TAG"
}))
PY

tar -czf "$ARCHIVE" -C /tmp "$TAG"
BYTES=$(stat -c%s "$ARCHIVE" 2>/dev/null || wc -c < "$ARCHIVE")
rm -rf "$WORKDIR"
python3 - << PY
import json
print(json.dumps({"ok": True, "path": "$ARCHIVE", "bytes": int("$BYTES" or 0), "tag": "$TAG"}))
PY
`);

const RESTORE_BACKUP_SCRIPT = (remoteArchive) => remoteBash(`
set -e
ARCHIVE=${JSON.stringify(remoteArchive)}
TAG=$(basename "$ARCHIVE" .tar.gz)
WORKDIR="/tmp/$TAG-restore"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
tar -xzf "$ARCHIVE" -C "$WORKDIR"

ROOT="$WORKDIR/$TAG"
if [ ! -d "$ROOT" ]; then
  ROOT=$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -type d | head -1)
fi
if [ ! -f "$ROOT/manifest.json" ]; then
  echo '{"ok":false,"error":"Invalid backup archive"}'
  exit 1
fi

PW=""
if [ -f /etc/cyberpanel/mysqlPassword ]; then
  PW=$(cat /etc/cyberpanel/mysqlPassword 2>/dev/null | tr -d '\\r\\n')
fi

if [ -n "$PW" ] && [ -d "$ROOT/mysql" ]; then
  for sql in "$ROOT/mysql"/*.sql; do
    [ -f "$sql" ] || continue
    db=$(basename "$sql" .sql)
    mysql -u root -p"$PW" -e "CREATE DATABASE IF NOT EXISTS \\\`$db\\\`;" 2>/dev/null || true
    mysql -u root -p"$PW" "$db" < "$sql" 2>/dev/null || true
  done
fi

if [ -d "$ROOT/sites" ]; then
  for domdir in "$ROOT/sites"/*; do
    [ -d "$domdir" ] || continue
    dom=$(basename "$domdir")
    if [ -d "$domdir/public_html" ] && [ -d "/home/$dom" ]; then
      rm -rf "/home/$dom/public_html"
      cp -a "$domdir/public_html" "/home/$dom/public_html"
    fi
  done
fi

if [ -d "$ROOT/cfg/cyberpanel" ]; then
  cp -a "$ROOT/cfg/cyberpanel/." /etc/cyberpanel/ 2>/dev/null || true
fi
if [ -d "$ROOT/cfg/lsws-conf" ]; then
  cp -a "$ROOT/cfg/lsws-conf/." /usr/local/lsws/conf/ 2>/dev/null || true
fi
if [ -d "$ROOT/ssl/letsencrypt" ]; then
  cp -a "$ROOT/ssl/letsencrypt/." /etc/letsencrypt/ 2>/dev/null || true
fi

systemctl reload lshttpd 2>/dev/null || systemctl reload lsws 2>/dev/null || true
systemctl reload nginx 2>/dev/null || true

rm -rf "$WORKDIR"
rm -f "$ARCHIVE"
python3 - << 'PY'
import json
print(json.dumps({"ok": True, "message": "Server image restored on target."}))
PY
`);

function serverDir(serverId) {
  return path.join(BACKUP_ROOT, String(serverId));
}

function ensureServerDir(serverId) {
  const dir = serverDir(serverId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseJsonLine(stdout) {
  const lines = (stdout || '').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch (_) { /* continue */ }
  }
  return null;
}

function sanitizeFilename(name) {
  const base = path.basename(String(name || ''));
  if (!base || !SAFE_NAME_RE.test(base) || !base.endsWith('.tar.gz')) return null;
  return base;
}

function pruneServerImages(serverId) {
  const dir = serverDir(serverId);
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  files.slice(MAX_IMAGES_PER_SERVER).forEach((f) => {
    try { fs.unlinkSync(path.join(dir, f.name)); } catch (_) { /* ignore */ }
  });
}

function listImages(serverId) {
  const sid = String(serverId || 'local');
  const dir = serverDir(sid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      return {
        filename: f,
        serverId: sid,
        size: st.size,
        createdAt: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function listAllImages() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  const out = [];
  fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .forEach((d) => {
      listImages(d.name).forEach((img) => out.push(img));
    });
  return out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getImagePath(serverId, filename) {
  const safe = sanitizeFilename(filename);
  if (!safe) return null;
  const fp = path.join(serverDir(serverId), safe);
  if (!fs.existsSync(fp)) return null;
  return fp;
}

function deleteImage(serverId, filename) {
  const fp = getImagePath(serverId, filename);
  if (!fp) return { ok: false, error: 'Backup image not found.' };
  fs.unlinkSync(fp);
  return { ok: true, message: 'Backup image deleted from central storage.' };
}

async function createRemoteArchive(serverId) {
  const res = await sshService.exec(serverId, CREATE_BACKUP_SCRIPT, 3600000);
  const parsed = parseJsonLine(res.stdout || res.stderr);
  if (!parsed || !parsed.ok || !parsed.path) {
    return {
      ok: false,
      error: (parsed && parsed.error) || (res.stderr || res.stdout || 'Backup script failed.').trim().slice(0, 300),
    };
  }
  return { ok: true, remotePath: parsed.path, tag: parsed.tag, bytes: parsed.bytes || 0 };
}

async function createLocalArchive() {
  if (!isLinux) {
    return { ok: false, error: 'Local server backup requires Linux with CyberPanel/MySQL.' };
  }
  const res = await run(CREATE_BACKUP_SCRIPT, { timeout: 3600000 });
  const parsed = parseJsonLine(res.stdout || res.stderr);
  if (!parsed || !parsed.ok || !parsed.path) {
    return {
      ok: false,
      error: (parsed && parsed.error) || (res.stderr || res.stdout || 'Backup script failed.').trim().slice(0, 300),
    };
  }
  return { ok: true, remotePath: parsed.path, tag: parsed.tag, bytes: parsed.bytes || 0, local: true };
}

async function pullArchiveToCentral(target, remotePath, tag) {
  const sid = target.local ? 'local' : String(target.remoteId);
  const dir = ensureServerDir(sid);
  const filename = `${sid}-${tag}.tar.gz`;
  const dest = path.join(dir, filename);

  if (target.local) {
    if (!fs.existsSync(remotePath)) {
      return { ok: false, error: 'Local archive missing after backup.' };
    }
    fs.copyFileSync(remotePath, dest);
    try { fs.unlinkSync(remotePath); } catch (_) { /* ignore */ }
  } else {
    const dl = await sshService.downloadFile(target.remoteId, remotePath, dest, 3600000);
    if (!dl.ok) return { ok: false, error: dl.error || 'Failed to download backup to central server.' };
    await sshService.exec(target.remoteId, `rm -f ${JSON.stringify(remotePath)}`, 30000);
  }

  pruneServerImages(sid);
  const size = fs.statSync(dest).size;
  return { ok: true, filename, size, path: dest };
}

async function runBackup(serverId, note = '') {
  const target = resolveTarget(serverId || 'local');
  if (!target) return { ok: false, error: 'Invalid server id.' };

  let archive;
  if (target.local) {
    archive = await createLocalArchive();
  } else {
    const conn = sshService.getStatus(target.remoteId);
    if (!conn.connected) {
      const connect = await sshService.connectServer(target.remoteId);
      if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
    }
    archive = await createRemoteArchive(target.remoteId);
  }
  if (!archive.ok) return archive;

  const saved = await pullArchiveToCentral(target, archive.remotePath, archive.tag);
  if (!saved.ok) return saved;

  return {
    ok: true,
    message: `Server image saved to central storage (${formatBytes(saved.size)}).`,
    image: {
      serverId: target.local ? 'local' : String(target.remoteId),
      serverName: target.name,
      filename: saved.filename,
      size: saved.size,
      note: String(note || '').slice(0, 200),
    },
  };
}

async function runRestore(serverId, filename) {
  const target = resolveTarget(serverId || 'local');
  if (!target) return { ok: false, error: 'Invalid server id.' };

  const safe = sanitizeFilename(filename);
  if (!safe) return { ok: false, error: 'Invalid filename.' };

  const localPath = getImagePath(target.local ? 'local' : target.remoteId, safe);
  if (!localPath) return { ok: false, error: 'Backup image not found on central server.' };

  if (target.local) {
    const remoteArchive = `/tmp/${safe}`;
    fs.copyFileSync(localPath, remoteArchive);
    const res = await run(RESTORE_BACKUP_SCRIPT(remoteArchive), { timeout: 3600000 });
    const parsed = parseJsonLine(res.stdout || res.stderr);
    try { fs.unlinkSync(remoteArchive); } catch (_) { /* ignore */ }
    if (!parsed || !parsed.ok) {
      return { ok: false, error: (parsed && parsed.error) || (res.stderr || 'Restore failed.').trim().slice(0, 300) };
    }
    return { ok: true, message: parsed.message || 'Server restored from central image.' };
  }

  const conn = sshService.getStatus(target.remoteId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(target.remoteId);
    if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
  }

  const remoteArchive = `/tmp/${safe}`;
  const up = await sshService.uploadFile(target.remoteId, localPath, remoteArchive, 3600000);
  if (!up.ok) return { ok: false, error: up.error || 'Failed to upload image to target server.' };

  const res = await sshService.exec(target.remoteId, RESTORE_BACKUP_SCRIPT(remoteArchive), 3600000);
  const parsed = parseJsonLine(res.stdout || res.stderr);
  if (!parsed || !parsed.ok) {
    return { ok: false, error: (parsed && parsed.error) || (res.stderr || 'Restore failed.').trim().slice(0, 300) };
  }
  return { ok: true, message: parsed.message || 'Server restored from central image.' };
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = Number(bytes);
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function getServerMeta(serverId) {
  const target = resolveTarget(serverId || 'local');
  if (!target) return null;
  if (target.local) {
    return { id: 'local', name: target.name, host: os.hostname() };
  }
  const srv = serverRepository.getById(target.remoteId);
  return srv ? { id: String(srv.id), name: srv.name, host: srv.host } : { id: String(target.remoteId), name: target.name, host: '' };
}

module.exports = {
  runBackup,
  runRestore,
  listImages,
  listAllImages,
  getImagePath,
  deleteImage,
  getServerMeta,
  formatBytes,
  BACKUP_ROOT,
};
