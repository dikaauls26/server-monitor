'use strict';

/**
 * Data access for the `users` table.
 */

const bcrypt = require('bcryptjs');
const { getDb } = require('../database/db');

const SALT_ROUNDS = 12;

function findByUsername(username) {
  return getDb()
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);
}

function findById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
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

module.exports = {
  findByUsername,
  findById,
  verifyCredentials,
  updatePassword,
};
