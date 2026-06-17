'use strict';

/**
 * Key/value settings store backed by the `settings` table.
 */

const { getDb } = require('../database/db');

function get(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function getInt(key, fallback = 0) {
  const v = get(key, null);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function set(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, String(value));
}

function getAll() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

module.exports = { get, getInt, set, getAll };
