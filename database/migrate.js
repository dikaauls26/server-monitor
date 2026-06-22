'use strict';

/**
 * Database migration: creates all tables if they do not exist.
 * Safe to run repeatedly (idempotent).
 *
 * Usage: node database/migrate.js
 */

require('dotenv').config();
const { getDb, closeDb } = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  threshold REAL NOT NULL,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'warning',
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts (acknowledged);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanner TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  output TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_jobs_status ON scan_jobs (status);

CREATE TABLE IF NOT EXISTS remote_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  password TEXT,
  private_key TEXT,
  auto_connect INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS domain_delete_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL DEFAULT 'local',
  domain TEXT NOT NULL,
  domain_type TEXT NOT NULL DEFAULT 'primary',
  status TEXT NOT NULL DEFAULT 'queued',
  message TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_domain_delete_jobs_status ON domain_delete_jobs (status);

CREATE TABLE IF NOT EXISTS server_backup_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  server_name TEXT,
  job_type TEXT NOT NULL DEFAULT 'backup',
  filename TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  message TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_server_backup_jobs_status ON server_backup_jobs (status);
`;

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateUserTotp(db) {
  ensureColumn(db, 'users', 'totp_secret', 'TEXT');
  ensureColumn(db, 'users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'totp_backup_codes', 'TEXT');
}

function migrate() {
  const db = getDb();
  db.exec(SCHEMA);
  migrateUserTotp(db);
  return true;
}

if (require.main === module) {
  try {
    migrate();
    console.log('[migrate] Database schema is up to date.');
  } catch (err) {
    console.error('[migrate] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

module.exports = migrate;
