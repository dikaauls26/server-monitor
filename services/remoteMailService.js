'use strict';

/**
 * Postfix mail queue inspection and actions on remote servers via SSH.
 */

const sshService = require('./sshService');
const mailService = require('./mailService');
const serverRepository = require('../repositories/serverRepository');

async function ensureConnected(serverId) {
  const server = serverRepository.getById(serverId);
  if (!server) return { ok: false, error: 'Server not found.' };

  const conn = sshService.getStatus(serverId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(serverId);
    if (!connect.ok) {
      return { ok: false, error: connect.error || 'Not connected', server };
    }
  }
  return { ok: true, server };
}

async function getRemoteSmtp(serverId) {
  const postfixRes = await sshService.exec(
    serverId,
    'systemctl is-active postfix 2>/dev/null || echo unknown',
    5000
  );
  const out = (postfixRes.stdout || '').trim();
  let postfix = 'unknown';
  if (out === 'active') postfix = 'running';
  else if (out === 'inactive' || out === 'failed') postfix = 'stopped';

  const portRes = await sshService.exec(
    serverId,
    'ss -tln 2>/dev/null | grep -q ":25 " && echo open || echo closed',
    5000
  );
  const port25 = (portRes.stdout || '').trim() === 'open' ? 'open' : 'closed';

  return {
    postfix,
    port25,
    port587: 'unknown',
    listening: postfix === 'running' || port25 === 'open',
  };
}

async function getMail(serverId) {
  const ready = await ensureConnected(serverId);
  if (!ready.ok) return ready;

  const queueRes = await sshService.exec(
    serverId,
    'postqueue -p 2>/dev/null || mailq 2>/dev/null || echo "Mail queue is empty"',
    15000
  );

  if (!queueRes.stdout && queueRes.stderr && !/empty/i.test(queueRes.stderr)) {
    return {
      ok: false,
      error: (queueRes.stderr || 'Failed to read mail queue.').trim(),
    };
  }

  const raw = queueRes.stdout || queueRes.stderr || '';
  const stats = mailService.parseQueue(raw);
  const available = !/not found|command not found/i.test(raw + queueRes.stderr);

  if (!available && !/Mail queue is empty/i.test(raw)) {
    return {
      ok: true,
      data: {
        timestamp: Date.now(),
        queue: {
          available: false,
          reason: 'Postfix tools (postqueue/mailq) not found on this server.',
          stats: { total: 0, active: 0, deferred: 0, hold: 0, failed: 0 },
        },
        smtp: await getRemoteSmtp(serverId),
      },
    };
  }

  const smtp = await getRemoteSmtp(serverId);
  return {
    ok: true,
    data: {
      timestamp: Date.now(),
      queue: {
        available: true,
        stats,
        raw: raw.slice(0, 8000),
      },
      smtp,
    },
  };
}

async function clearDeferred(serverId) {
  const ready = await ensureConnected(serverId);
  if (!ready.ok) return ready;

  const res = await sshService.exec(
    serverId,
    'sudo -n postsuper -d ALL deferred 2>&1 || postsuper -d ALL deferred 2>&1',
    20000
  );
  if (res.ok || /Deleted|deferred/i.test(res.stdout + res.stderr)) {
    return { ok: true, message: 'Deferred mail queue cleared.', output: (res.stdout || res.stderr || '').trim() };
  }
  return {
    ok: false,
    error: (res.stderr || res.stdout || 'Failed to clear deferred queue.').trim(),
  };
}

async function clearPending(serverId) {
  const ready = await ensureConnected(serverId);
  if (!ready.ok) return ready;

  const res = await sshService.exec(
    serverId,
    'sudo -n postsuper -d ALL 2>&1 || postsuper -d ALL 2>&1',
    20000
  );
  if (res.ok || /Deleted/i.test(res.stdout + res.stderr)) {
    return { ok: true, message: 'All pending mail removed from queue.', output: (res.stdout || res.stderr || '').trim() };
  }
  return {
    ok: false,
    error: (res.stderr || res.stdout || 'Failed to clear pending queue.').trim(),
  };
}

module.exports = { getMail, clearDeferred, clearPending };
