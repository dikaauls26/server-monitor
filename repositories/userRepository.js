'use strict';

/**
 * Data access for the `users` table.
 */

const bcrypt = require('bcryptjs');
const { getDb } = require('../database/db');

const SALT_ROUNDS = 12;

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    totp_secret: row.totp_secret || null,
    totp_enabled: row.totp_enabled === 1,
    totp_backup_codes: row.totp_backup_codes || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function findByUsername(username) {
  return mapUser(
    getDb().prepare('SELECT * FROM users WHERE username = ?').get(username)
  );
}

function findById(id) {
  return mapUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id));
}

/**
 * Verify a plaintext password against the stored bcrypt hash.
 * Returns the user row on success, otherwise null.
 */
function verifyCredentials(username, plainPassword) {
  const user = findByUsername(username);
  if (!user) return null;
  const ok = bcrypt.compareSync(plainPassword, user.password_hash);
  return ok ? user : null;
}

function updatePassword(userId, newPlainPassword) {
  const hash = bcrypt.hashSync(newPlainPassword, SALT_ROUNDS);
  getDb()
    .prepare(
      "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(hash, userId);
}

function enableTotp(userId, secret, backupHashesJson) {
  getDb()
    .prepare(
      `UPDATE users SET totp_secret = ?, totp_enabled = 1, totp_backup_codes = ?,
       updated_at = datetime('now') WHERE id = ?`
    )
    .run(secret, backupHashesJson, userId);
}

function disableTotp(userId) {
  getDb()
    .prepare(
      `UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = NULL,
       updated_at = datetime('now') WHERE id = ?`
    )
    .run(userId);
}

function updateBackupCodes(userId, backupHashesJson) {
  getDb()
    .prepare(
      "UPDATE users SET totp_backup_codes = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .run(backupHashesJson, userId);
}

module.exports = {
  findByUsername,
  findById,
  verifyCredentials,
  updatePassword,
  enableTotp,
  disableTotp,
  updateBackupCodes,
};
