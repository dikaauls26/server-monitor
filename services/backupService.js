'use strict';

/**
 * Snapshot backup & restore for Server Monitor configuration.
 * Archives SQLite DB, sessions, and .env into storage/backups/*.tar.gz
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb, closeDb, databaseFile } = require('../database/db');
const { run } = require('./execHelper');
const pkg = require('../package.json');

const BACKUP_DIR = path.join(config.storageDir, 'backups');
const ENV_PATH = path.join(config.rootDir, '.env');
const SESSIONS_PATH = path.join(config.storageDir, config.sessionStoreFile);
const MAX_BACKUPS = 15;
const BACKUP_ID_RE = /^backup-\d{8}-\d{6}$/;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function formatBackupId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    'backup',
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('-');
}

function sqliteBackup(destPath) {
  const db = getDb();
  const backup = db.backup(destPath);
  while (backup.remainingPages > 0) {
    backup.step(100);
  }
  backup.finish();
}

function copyIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

function statSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (_) {
    return 0;
  }
}

function pruneOldBackups() {
  ensureBackupDir();
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  files.slice(MAX_BACKUPS).forEach((f) => {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.name));
    } catch (_) { /* ignore */ }
  });
}

function readManifestFromDir(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    return null;
  }
}

async function compressDir(dirName) {
  const archivePath = path.join(BACKUP_DIR, `${dirName}.tar.gz`);
  const tarCmd = `tar -czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(BACKUP_DIR)} ${JSON.stringify(dirName)}`;
  const res = await run(tarCmd, { timeout: 120000 });
  if (!res.ok) {
    throw new Error((res.stderr || res.stdout || 'tar failed').trim() || 'Failed to create archive.');
  }
  return archivePath;
}

async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tarCmd = `tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(destDir)}`;
  const res = await run(tarCmd, { timeout: 120000 });
  if (!res.ok) {
    throw new Error((res.stderr || res.stdout || 'tar extract failed').trim() || 'Failed to extract backup.');
  }
}

function findExtractedRoot(tempDir, id) {
  const direct = path.join(tempDir, id);
  if (fs.existsSync(path.join(direct, 'manifest.json'))) return direct;
  const entries = fs.readdirSync(tempDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(tempDir, entry.name);
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

function rowFromArchive(name) {
  const id = name.replace(/\.tar\.gz$/, '');
  const filePath = path.join(BACKUP_DIR, name);
  const stat = fs.statSync(filePath);
  let manifest = null;
  const sidecar = path.join(BACKUP_DIR, `${id}.json`);
  if (fs.existsSync(sidecar)) {
    try {
      manifest = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    } catch (_) { /* ignore */ }
  }
  return {
    id,
    filename: name,
    size: stat.size,
    createdAt: manifest && manifest.createdAt ? manifest.createdAt : stat.mtime.toISOString(),
    note: manifest && manifest.note ? manifest.note : '',
    appVersion: manifest && manifest.appVersion ? manifest.appVersion : null,
  };
}

async function createBackup({ note = '' } = {}) {
  ensureBackupDir();
  const id = formatBackupId();
  const workDir = path.join(BACKUP_DIR, id);

  if (fs.existsSync(workDir)) {
    return { ok: false, error: 'Backup id collision — try again in one second.' };
  }
  fs.mkdirSync(workDir, { recursive: true });

  try {
    sqliteBackup(path.join(workDir, 'monitor.db'));

    const files = ['monitor.db'];
    if (copyIfExists(SESSIONS_PATH, path.join(workDir, 'sessions.db'))) {
      files.push('sessions.db');
    }
    if (copyIfExists(ENV_PATH, path.join(workDir, 'env.snapshot'))) {
      files.push('env.snapshot');
    }

    const manifest = {
      version: 1,
      appVersion: pkg.version,
      createdAt: new Date().toISOString(),
      note: String(note || '').slice(0, 200),
      files,
    };
    fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(BACKUP_DIR, `${id}.json`), JSON.stringify(manifest));

    const archivePath = await compressDir(id);
    fs.rmSync(workDir, { recursive: true, force: true });
    pruneOldBackups();

    return {
      ok: true,
      message: 'Configuration backup created.',
      backup: {
        id,
        filename: path.basename(archivePath),
        size: statSize(archivePath),
        createdAt: manifest.createdAt,
        note: manifest.note,
        appVersion: manifest.appVersion,
      },
    };
  } catch (err) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
    return { ok: false, error: err.message || 'Backup failed.' };
  }
}

function listBackups() {
  ensureBackupDir();
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.tar.gz'))
    .map(rowFromArchive)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { ok: true, backups };
}

function getBackupPath(id) {
  if (!BACKUP_ID_RE.test(id)) return null;
  const archivePath = path.join(BACKUP_DIR, `${id}.tar.gz`);
  if (!fs.existsSync(archivePath)) return null;
  return archivePath;
}

function removeBackup(id) {
  const archivePath = getBackupPath(id);
  if (!archivePath) return { ok: false, error: 'Backup not found.' };
  fs.unlinkSync(archivePath);
  const sidecar = path.join(BACKUP_DIR, `${id}.json`);
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  return { ok: true, message: 'Backup deleted.' };
}

async function restoreBackup(id) {
  const archivePath = getBackupPath(id);
  if (!archivePath) return { ok: false, error: 'Backup not found.' };

  const tempDir = path.join(BACKUP_DIR, `_restore-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await extractArchive(archivePath, tempDir);
    const root = findExtractedRoot(tempDir, id);
    if (!root) {
      return { ok: false, error: 'Invalid backup archive (manifest missing).' };
    }

    const manifest = readManifestFromDir(root);
    if (!manifest || manifest.version !== 1) {
      return { ok: false, error: 'Unsupported or invalid backup manifest.' };
    }

    const monitorSrc = path.join(root, 'monitor.db');
    if (!fs.existsSync(monitorSrc)) {
      return { ok: false, error: 'Backup is missing monitor.db.' };
    }

    // Safety snapshot before overwrite
    await createBackup({ note: `Auto snapshot before restore ${id}` });

    closeDb();

    fs.copyFileSync(monitorSrc, databaseFile);

    const sessionsSrc = path.join(root, 'sessions.db');
    if (fs.existsSync(sessionsSrc)) {
      fs.copyFileSync(sessionsSrc, SESSIONS_PATH);
    }

    const envSrc = path.join(root, 'env.snapshot');
    if (fs.existsSync(envSrc)) {
      fs.copyFileSync(envSrc, ENV_PATH);
    }

    return {
      ok: true,
      message: 'Configuration restored. Application will restart now.',
      restart: true,
      restored: {
        id,
        appVersion: manifest.appVersion,
        createdAt: manifest.createdAt,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Restore failed.' };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

module.exports = {
  createBackup,
  listBackups,
  getBackupPath,
  removeBackup,
  restoreBackup,
  BACKUP_DIR,
};
