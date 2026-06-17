'use strict';

/**
 * Data access for the `alerts` table.
 */

const { getDb } = require('../database/db');

function create({ type, metric, value, threshold, message, level = 'warning' }) {
  const info = getDb()
    .prepare(
      `INSERT INTO alerts (type, metric, value, threshold, message, level)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(type, metric, value, threshold, message, level);
  return info.lastInsertRowid;
}

function list({ limit = 100, onlyUnacknowledged = false } = {}) {
  const where = onlyUnacknowledged ? 'WHERE acknowledged = 0' : '';
  return getDb()
    .prepare(
      `SELECT * FROM alerts ${where} ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit);
}

function countUnacknowledged() {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM alerts WHERE acknowledged = 0')
    .get();
  return row.c;
}

/**
 * Returns the timestamp of the most recent alert for a metric, or null.
 * Used to throttle duplicate alerts.
 */
function lastAlertAt(metric) {
  const row = getDb()
    .prepare(
      'SELECT created_at FROM alerts WHERE metric = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(metric);
  return row ? row.created_at : null;
}

function acknowledge(id) {
  getDb().prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

function acknowledgeAll() {
  getDb().prepare('UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0').run();
}

function clearAll() {
  getDb().prepare('DELETE FROM alerts').run();
}

module.exports = {
  create,
  list,
  countUnacknowledged,
  lastAlertAt,
  acknowledge,
  acknowledgeAll,
  clearAll,
};
