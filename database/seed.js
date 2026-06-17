'use strict';

/**
 * Seed the default admin account and base settings.
 *
 * Password handling:
 *   - The plain password comes from ADMIN_PASSWORD (env), never hardcoded.
 *   - It is hashed with bcrypt here and ONLY the hash is stored.
 *   - Re-running will NOT overwrite an existing admin (idempotent),
 *     unless RESEED_ADMIN=true is set (used by update flows / resets).
 *
 * Usage: node database/seed.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getDb, closeDb } = require('./db');
const config = require('../config');

const SALT_ROUNDS = 12;

function seed() {
  const db = getDb();

  const username = config.admin.username;
  const plainPassword = config.admin.password;
  const reseed = ['1', 'true', 'yes'].includes(
    String(process.env.RESEED_ADMIN || '').toLowerCase()
  );

  const existing = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(username);

  if (existing && !reseed) {
    console.log(
      `[seed] Admin user "${username}" already exists. Skipping (set RESEED_ADMIN=true to reset).`
    );
  } else {
    const hash = bcrypt.hashSync(plainPassword, SALT_ROUNDS);
    if (existing) {
      db.prepare(
        "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE username = ?"
      ).run(hash, username);
      console.log(`[seed] Reset password for admin user "${username}".`);
    } else {
      db.prepare(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)'
      ).run(username, hash);
      console.log(`[seed] Created admin user "${username}".`);
    }
  }

  // Base settings (only inserted if missing).
  const defaults = {
    alert_cpu_threshold: String(config.alerts.cpu),
    alert_ram_threshold: String(config.alerts.ram),
    alert_disk_threshold: String(config.alerts.disk),
  };

  const upsertMissing = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  for (const [key, value] of Object.entries(defaults)) {
    upsertMissing.run(key, value);
  }

  console.log('[seed] Settings initialized.');
}

if (require.main === module) {
  try {
    seed();
  } catch (err) {
    console.error('[seed] Failed:', err.message);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}

module.exports = seed;
