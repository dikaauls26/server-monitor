'use strict';

/**
 * Migrate plaintext SSH credentials in SQLite to encrypted storage.
 */

const { getDb } = require('../database/db');
const credentialCrypto = require('./credentialCrypto');

function countSecrets(rows) {
  let plaintext = 0;
  let encrypted = 0;

  for (const row of rows) {
    if (row.password) {
      if (credentialCrypto.isEncrypted(row.password)) encrypted += 1;
      else plaintext += 1;
    }
    if (row.private_key) {
      if (credentialCrypto.isEncrypted(row.private_key)) encrypted += 1;
      else plaintext += 1;
    }
  }

  return { plaintext, encrypted };
}

function getStatus() {
  const db = getDb();
  const rows = db.prepare('SELECT id, password, private_key FROM remote_servers').all();
  const counts = countSecrets(rows);

  return {
    keyConfigured: credentialCrypto.isConfigured(),
    servers: rows.length,
    plaintextSecrets: counts.plaintext,
    encryptedSecrets: counts.encrypted,
    fullyEncrypted: counts.plaintext === 0,
  };
}

function encryptAll() {
  if (!credentialCrypto.isConfigured()) {
    return {
      ok: false,
      error: 'ENCRYPTION_KEY is not set in .env. Run install/update or add ENCRYPTION_KEY manually.',
    };
  }

  const db = getDb();
  const rows = db.prepare('SELECT id, password, private_key FROM remote_servers').all();
  const update = db.prepare(
    'UPDATE remote_servers SET password = ?, private_key = ?, updated_at = datetime(\'now\') WHERE id = ?'
  );

  let migratedServers = 0;
  let migratedSecrets = 0;

  for (const row of rows) {
    let password = row.password;
    let privateKey = row.private_key;
    let changed = false;

    if (password && !credentialCrypto.isEncrypted(password)) {
      password = credentialCrypto.encrypt(password);
      migratedSecrets += 1;
      changed = true;
    }
    if (privateKey && !credentialCrypto.isEncrypted(privateKey)) {
      privateKey = credentialCrypto.encrypt(privateKey);
      migratedSecrets += 1;
      changed = true;
    }

    if (changed) {
      update.run(password, privateKey, row.id);
      migratedServers += 1;
    }
  }

  return {
    ok: true,
    migratedServers,
    migratedSecrets,
    message:
      migratedSecrets > 0
        ? `Encrypted ${migratedSecrets} credential(s) on ${migratedServers} server(s).`
        : 'All SSH credentials are already encrypted.',
    status: getStatus(),
  };
}

module.exports = { getStatus, encryptAll };
