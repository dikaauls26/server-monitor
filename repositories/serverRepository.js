'use strict';

const { getDb } = require('../database/db');

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
    autoConnect: row.auto_connect === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  return db.prepare('SELECT * FROM remote_servers WHERE id = ?').get(id);
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
      password || null,
      privateKey || null,
      autoConnect ? 1 : 0
    );
  return getById(info.lastInsertRowid);
}

function update(id, { name, host, port, username, password, privateKey, autoConnect }) {
  const db = getDb();
  const existing = getCredentials(id);
  if (!existing) return null;
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
    password !== undefined ? password : existing.password,
    privateKey !== undefined ? privateKey : existing.private_key,
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
