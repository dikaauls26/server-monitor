'use strict';

/**
 * SSH connection pool for remote server monitoring.
 * Maintains persistent connections for servers with auto_connect enabled.
 */

const { Client } = require('ssh2');
const serverRepository = require('../repositories/serverRepository');

/** @type {Map<number, { client: import('ssh2').Client, connected: boolean, error: string|null, connecting: boolean }>} */
const pool = new Map();

function getStatus(serverId) {
  const entry = pool.get(serverId);
  if (!entry) return { connected: false, error: null };
  return { connected: entry.connected, error: entry.error };
}

function listStatuses() {
  const servers = serverRepository.list();
  return servers.map((s) => ({
    ...s,
    connection: getStatus(s.id),
  }));
}

function connectServer(serverId) {
  return new Promise((resolve) => {
    const creds = serverRepository.getCredentials(serverId);
    if (!creds) {
      return resolve({ ok: false, error: 'Server not found.' });
    }

    const existing = pool.get(serverId);
    if (existing && existing.connected) {
      return resolve({ ok: true, message: 'Already connected.' });
    }
    if (existing && existing.connecting) {
      return resolve({ ok: true, message: 'Connection in progress.' });
    }

    const client = new Client();
    pool.set(serverId, { client, connected: false, error: null, connecting: true });

    const config = {
      host: creds.host,
      port: creds.port || 22,
      username: creds.username,
      readyTimeout: 15000,
    };
    if (creds.private_key) {
      config.privateKey = creds.private_key;
    } else if (creds.password) {
      config.password = creds.password;
    } else {
      pool.delete(serverId);
      return resolve({ ok: false, error: 'No password or private key configured.' });
    }

    client
      .on('ready', () => {
        pool.set(serverId, { client, connected: true, error: null, connecting: false });
        resolve({ ok: true, message: `Connected to ${creds.name}.` });
      })
      .on('error', (err) => {
        pool.set(serverId, { client, connected: false, error: err.message, connecting: false });
        resolve({ ok: false, error: err.message });
      })
      .on('close', () => {
        const cur = pool.get(serverId);
        if (cur) {
          pool.set(serverId, { ...cur, connected: false, connecting: false });
        }
      })
      .connect(config);
  });
}

function disconnectServer(serverId) {
  const entry = pool.get(serverId);
  if (!entry) return { ok: true, message: 'Not connected.' };
  try {
    entry.client.end();
  } catch (_) { /* ignore */ }
  pool.delete(serverId);
  return { ok: true, message: 'Disconnected.' };
}

function exec(serverId, command, timeout = 10000) {
  return new Promise(async (resolve) => {
    let entry = pool.get(serverId);
    if (!entry || !entry.connected) {
      const conn = await connectServer(serverId);
      if (!conn.ok) {
        return resolve({ ok: false, stdout: '', stderr: conn.error || 'Connection failed', code: 1 });
      }
      entry = pool.get(serverId);
    }

    if (!entry || !entry.connected) {
      return resolve({ ok: false, stdout: '', stderr: 'Not connected', code: 1 });
    }

    runExec(entry.client, command, timeout).then(resolve);
  });
}

function runExec(client, command, timeout = 10000) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ ok: false, stdout: '', stderr: 'Command timeout', code: 124 });
    }, timeout);

    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        finished = true;
        return resolve({ ok: false, stdout: '', stderr: err.message, code: 1 });
      }
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({ ok: code === 0, stdout, stderr, code: code || 0 });
        })
        .on('data', (d) => { stdout += d.toString(); })
        .stderr.on('data', (d) => { stderr += d.toString(); });
    });
  });
}

async function ensureClient(serverId) {
  let entry = pool.get(serverId);
  if (!entry || !entry.connected) {
    const conn = await connectServer(serverId);
    if (!conn.ok) return { ok: false, error: conn.error || 'Connection failed' };
    entry = pool.get(serverId);
  }
  if (!entry || !entry.connected) return { ok: false, error: 'Not connected' };
  return { ok: true, client: entry.client };
}

function sftpTransfer(serverId, fn, timeout = 600000) {
  return new Promise(async (resolve) => {
    const ready = await ensureClient(serverId);
    if (!ready.ok) {
      return resolve({ ok: false, error: ready.error || 'Not connected' });
    }

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ ok: false, error: 'SFTP timeout' });
    }, timeout);

    ready.client.sftp((err, sftp) => {
      if (err) {
        clearTimeout(timer);
        finished = true;
        return resolve({ ok: false, error: err.message });
      }
      fn(sftp, (transferErr) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (transferErr) return resolve({ ok: false, error: transferErr.message || String(transferErr) });
        resolve({ ok: true });
      });
    });
  });
}

function downloadFile(serverId, remotePath, localPath, timeout = 600000) {
  return sftpTransfer(serverId, (sftp, cb) => {
    sftp.fastGet(remotePath, localPath, cb);
  }, timeout);
}

function uploadFile(serverId, localPath, remotePath, timeout = 600000) {
  return sftpTransfer(serverId, (sftp, cb) => {
    sftp.fastPut(localPath, remotePath, cb);
  }, timeout);
}

async function autoConnectAll() {
  const servers = serverRepository.listAutoConnect();
  const results = await Promise.all(servers.map((s) => connectServer(s.id)));
  return results;
}

function shutdown() {
  for (const [id] of pool) {
    disconnectServer(id);
  }
}

module.exports = {
  connectServer,
  disconnectServer,
  exec,
  downloadFile,
  uploadFile,
  getStatus,
  listStatuses,
  autoConnectAll,
  shutdown,
};
