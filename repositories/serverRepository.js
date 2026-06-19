'use strict';

const { getDb } = require('../database/db');
const credentialCrypto = require('../services/credentialCrypto');

function rowToServer(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: Boolean(row.password),
    hasPrivateKey: Boolean(row.private_key),
    passwordEncrypted: row.password ? credentialCrypto.isEncrypted(row.password) : null,
    keyEncrypted: row.private_key ? credentialCrypto.isEncrypted(row.private_key) : null,
    autoConnect: row.auto_connect === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storeSecret(value) {
  if (value === null || value === undefined || value === '') return null;
  if (credentialCrypto.isConfigured()) {
    return credentialCrypto.encrypt(value);
  }
  return value;
}

function list() {
  const db = getDb();
  return db.prepare('SELECT * FROM remote_servers ORDER BY name ASC').all().map(rowToServer);
}

function getById(id) {
  const db = getDb();
  return rowToServer(db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(id));
}

function getCredentials(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(id);
  if (!row) return null;

  let password = row.password;
  let privateKey = row.private_key;

  try {
    if (password) password = credentialCrypto.decrypt(password);
    if (privateKey) privateKey = credentialCrypto.decrypt(privateKey);
  } catch (err) {
    throw new Error(`Failed to decrypt credentials for server #${id}: ${err.message}`);
  }

  return {
    ...row,
    password,
    private_key: privateKey,
  };
}

function create({ name, host, port, username, password, privateKey, autoConnect }) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO remote_servers (name, host, port, username, password, private_key, auto_connect)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name.trim(),
      host.trim(),
      port || 22,
      username.trim(),
      storeSecret(password || null),
      storeSecret(privateKey || null),
      autoConnect ? 1 : 0
    );
  return getById(info.lastInsertRowid);
}

function update(id, { name, host, port, username, password, privateKey, autoConnect }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(id);
  if (!existing) return null;

  let nextPassword = existing.password;
  let nextKey = existing.private_key;

  if (password !== undefined) {
    nextPassword = password ? storeSecret(password) : null;
  }
  if (privateKey !== undefined) {
    nextKey = privateKey ? storeSecret(privateKey) : null;
  }

  db.prepare(
    `UPDATE remote_servers SET
       name = ?, host = ?, port = ?, username = ?,
       password = ?, private_key = ?, auto_connect = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name.trim(),
    host.trim(),
    port || 22,
    username.trim(),
    nextPassword,
    nextKey,
    autoConnect ? 1 : 0,
    id
  );
  return getById(id);
}

function remove(id) {
  const db = getDb();
  return db.prepare('DELETE FROM remote_servers WHERE id = ?').run(id).changes > 0;
}

function listAutoConnect() {
  const db = getDb();
  return db
    .prepare('SELECT * FROM remote_servers WHERE auto_connect = 1 ORDER BY id ASC')
    .all();
}

module.exports = {
  list,
  getById,
  getCredentials,
  create,
  update,
  remove,
  listAutoConnect,
};
