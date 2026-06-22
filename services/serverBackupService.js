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
const { resolveTarget } = require('./serverTargetService');
const { remoteBash } = require('./shellScript');
const { run } = require('./execHelper');

const BACKUP_ROOT = path.join(config.storageDir, 'server-backups');
const MAX_IMAGES_PER_SERVER = 5;
const isLinux = os.platform() === 'linux';
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

const CREATE_BACKUP_SCRIPT = remoteBash(`
TS=$(date +%Y%m%d-%H%M%S)
TAG="sm-server-backup-$TS"
STATUS="/tmp/$TAG.status.json"
ARCHIVE="/tmp/$TAG.tar.gz"
WORK="/tmp/$TAG.work.sh"

cat > "$WORK" << 'WORKER'
#!/bin/bash
set -e
TAG="$1"
STATUS="$2"
ARCHIVE="$3"
WORKDIR="/tmp/$TAG"
ION="nice -n 19 ionice -c2 -n7"

write_status() {
  printf '{"state":"%s","phase":"%s","tag":"%s"}\n' "$1" "$2" "$TAG" > "$STATUS"
}

fail() {
  err=$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  printf '{"state":"failed","error":%s,"tag":"%s"}\n' "$err" "$TAG" > "$STATUS"
  exit 1
}

trap 'fail "Backup interrupted"' ERR
write_status running mysql

mkdir -p "$WORKDIR/mysql" "$WORKDIR/cfg" "$WORKDIR/sites" "$WORKDIR/ssl"
PW=""
if [ -f /etc/cyberpanel/mysqlPassword ]; then
  PW=$(cat /etc/cyberpanel/mysqlPassword 2>/dev/null | tr -d '\\r\\n')
fi

dump_db() {
  db="$1"
  [ -n "$db" ] || return 0
  $ION mysqldump -u root -p"$PW" --single-transaction --quick --routines --triggers --events "$db" > "$WORKDIR/mysql/\${db}.sql" 2>/dev/null || true
}

if [ -n "$PW" ]; then
  dump_db cyberpanel
  mysql -u root -p"$PW" cyberpanel -N -e "SELECT dbName FROM websiteFunctions_databases" 2>/dev/null | while read -r db; do
    dump_db "$db"
  done
fi

write_status running files
if [ -d /etc/cyberpanel ]; then
  $ION cp -a /etc/cyberpanel "$WORKDIR/cfg/cyberpanel" 2>/dev/null || true
fi
if [ -d /usr/local/lsws/conf ]; then
  $ION cp -a /usr/local/lsws/conf "$WORKDIR/cfg/lsws-conf" 2>/dev/null || true
fi
if [ -d /etc/letsencrypt ]; then
  $ION cp -a /etc/letsencrypt "$WORKDIR/ssl/letsencrypt" 2>/dev/null || true
fi
if [ -d /home ]; then
  for site in /home/*/public_html; do
    [ -d "$site" ] || continue
    dom=$(basename "$(dirname "$site")")
    mkdir -p "$WORKDIR/sites/$dom"
    if command -v rsync >/dev/null 2>&1; then
      $ION rsync -a "$site/" "$WORKDIR/sites/$dom/public_html/" 2>/dev/null || true
    else
      $ION cp -a "$site" "$WORKDIR/sites/$dom/public_html" 2>/dev/null || true
    fi
  done
fi

write_status running compress
HOST=$(hostname 2>/dev/null || echo unknown)
python3 - << PY
import json, datetime
open("$WORKDIR/manifest.json", "w").write(json.dumps({
  "version": 1,
  "hostname": "$HOST",
  "created": datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
  "tag": "$TAG",
  "mode": "background-low-priority"
}))
PY

$ION tar -czf "$ARCHIVE" -C /tmp "$TAG"
BYTES=$(stat -c%s "$ARCHIVE" 2>/dev/null || wc -c < "$ARCHIVE")
rm -rf "$WORKDIR"
printf '{"state":"done","ok":true,"path":"%s","bytes":%s,"tag":"%s"}\n' "$ARCHIVE" "$BYTES" "$TAG" > "$STATUS"
WORKER

chmod +x "$WORK"
nohup "$WORK" "$TAG" "$STATUS" "$ARCHIVE" > "/tmp/$TAG.log" 2>&1 &

python3 - << PY
import json
print(json.dumps({"ok": True, "started": True, "tag": "$TAG", "statusFile": "$STATUS"}))
PY
`);

function pollBackupStatusScript(tag) {
  if (!/^sm-server-backup-\d{8}-\d{6}$/.test(tag)) {
    throw new Error('Invalid backup tag.');
  }
  return remoteBash(`
if [ ! -f /tmp/${tag}.status.json ]; then
  python3 -c "import json; print(json.dumps({'state':'pending','phase':'starting','tag':'${tag}'}))"
else
  cat /tmp/${tag}.status.json
fi
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_INTERVAL_MS = 15000;
const MAX_BACKUP_WAIT_MS = 7200000;

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

async function launchBackgroundBackup(execFn) {
  const res = await execFn(CREATE_BACKUP_SCRIPT, 120000);
  const parsed = parseJsonLine(res.stdout || res.stderr);
  if (!parsed || !parsed.ok || !parsed.tag) {
    return {
      ok: false,
      error: (parsed && parsed.error) || (res.stderr || res.stdout || 'Failed to start backup.').trim().slice(0, 300),
    };
  }
  return { ok: true, tag: parsed.tag };
}

async function pollBackupStatus(execFn, tag) {
  const res = await execFn(pollBackupStatusScript(tag), 60000);
  return parseJsonLine(res.stdout || res.stderr) || { state: 'pending' };
}

async function waitForBackupArchive(execFn, tag, onProgress) {
  const started = Date.now();
  while (Date.now() - started < MAX_BACKUP_WAIT_MS) {
    const status = await pollBackupStatus(execFn, tag);
    if (status.state === 'failed') {
      return { ok: false, error: status.error || 'Backup failed on server.' };
    }
    if (status.state === 'done' && status.path) {
      return { ok: true, remotePath: status.path, tag: status.tag || tag, bytes: status.bytes || 0 };
    }
    const phase = status.phase || status.state || 'running';
    if (onProgress) onProgress(phase);
    await sleep(POLL_INTERVAL_MS);
  }
  return { ok: false, error: 'Backup timed out waiting for server to finish.' };
}

async function cleanupRemoteBackup(execFn, tag) {
  await execFn(`rm -f /tmp/${tag}.status.json /tmp/${tag}.tar.gz /tmp/${tag}.log 2>/dev/null; rm -rf /tmp/${tag} /tmp/${tag}.work.sh 2>/dev/null`, 30000);
}

async function createRemoteArchive(serverId, onProgress) {
  const execFn = (cmd, timeout) => sshService.exec(serverId, cmd, timeout);
  const launched = await launchBackgroundBackup(execFn);
  if (!launched.ok) return launched;
  if (onProgress) onProgress('started');
  const finished = await waitForBackupArchive(execFn, launched.tag, onProgress);
  if (!finished.ok) {
    await cleanupRemoteBackup(execFn, launched.tag);
    return finished;
  }
  return finished;
}

async function createLocalArchive(onProgress) {
  if (!isLinux) {
    return { ok: false, error: 'Local server backup requires Linux with CyberPanel/MySQL.' };
  }
  const execFn = (cmd, timeout) => run(cmd, { timeout });
  const launched = await launchBackgroundBackup(execFn);
  if (!launched.ok) return launched;
  if (onProgress) onProgress('started');
  const finished = await waitForBackupArchive(execFn, launched.tag, onProgress);
  if (!finished.ok) {
    await cleanupRemoteBackup(execFn, launched.tag);
    return finished;
  }
  return { ...finished, local: true };
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

async function runBackup(serverId, note = '', onProgress) {
  const target = resolveTarget(serverId || 'local');
  if (!target) return { ok: false, error: 'Invalid server id.' };

  const phaseLabel = (phase) => {
    const map = {
      started: 'Background backup started (low priority)…',
      mysql: 'Dumping databases (no table lock)…',
      files: 'Copying website files…',
      compress: 'Compressing archive…',
      pending: 'Waiting for backup worker…',
      starting: 'Starting backup worker…',
      running: 'Backup running in background…',
    };
    return map[phase] || `Backup: ${phase}…`;
  };

  const progress = (phase) => {
    if (onProgress) onProgress(phaseLabel(phase));
  };

  let archive;
  if (target.local) {
    archive = await createLocalArchive(progress);
  } else {
    const conn = sshService.getStatus(target.remoteId);
    if (!conn.connected) {
      const connect = await sshService.connectServer(target.remoteId);
      if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
    }
    archive = await createRemoteArchive(target.remoteId, progress);
  }
  if (!archive.ok) return archive;

  if (onProgress) onProgress('Downloading image to central server…');
  const saved = await pullArchiveToCentral(target, archive.remotePath, archive.tag);
  if (!saved.ok) return saved;

  return {
    ok: true,
    message: `Server image saved to central storage (${formatBytes(saved.size)}). Websites stayed online.`,
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
