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
`;

function migrate() {
  const db = getDb();
  db.exec(SCHEMA);
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
