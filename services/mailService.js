'use strict';

/**
 * Mail/Postfix monitoring.
 *
 * Reads the Postfix queue via `postqueue -p` / `mailq` and parses counts for:
 *   - total queued
 *   - active (being delivered)
 *   - deferred / pending
 *   - failed (in the "hold"/bounce sense, derived from deferred reasons)
 *
 * Also reports SMTP listener status by probing port 25 and the postfix service.
 */

const net = require('net');
const os = require('os');
const { run, commandExists } = require('./execHelper');

const isLinux = os.platform() === 'linux';
const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
const SUDO = isRoot ? '' : 'sudo -n ';

/**
 * Probe a TCP port locally to see if an SMTP server is listening.
 */
function probePort(port, host = '127.0.0.1', timeout = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Parse `postqueue -p` output to derive queue stats.
 * Falls back to qshape/mailq when needed.
 */
function parseQueue(output) {
  const stats = { total: 0, active: 0, deferred: 0, hold: 0, failed: 0 };
  if (!output) return stats;

  if (/Mail queue is empty/i.test(output)) {
    return stats;
  }

  // Each queued message starts with a queue id line, e.g.
  // "A1B2C3D4E5*  1234 Wed Jun 17 10:00:00  sender@example.com"
  // A trailing "*" means ACTIVE, "!" means HOLD.
  const lines = output.split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-F0-9]{6,})([*!]?)\s+\d+/i);
    if (m) {
      stats.total += 1;
      const flag = m[2];
      if (flag === '*') stats.active += 1;
      else if (flag === '!') stats.hold += 1;
      else stats.deferred += 1;
    }
    if (/\(.*(said|timed out|connection refused|host not found|bounced).*\)/i.test(line)) {
      stats.failed += 1;
    }
  }

  // A summary line is often present: "-- X Kbytes in N Requests."
  const summary = output.match(/in\s+(\d+)\s+Request/i);
  if (summary && stats.total === 0) {
    stats.total = parseInt(summary[1], 10) || 0;
    stats.deferred = stats.total;
  }
  return stats;
}

async function getQueue() {
  if (!isLinux) {
    return { available: false, reason: 'Mail queue inspection is only available on Linux.', stats: { total: 0, active: 0, deferred: 0, hold: 0, failed: 0 } };
  }
  const hasPostqueue = await commandExists('postqueue');
  const hasMailq = await commandExists('mailq');
  if (!hasPostqueue && !hasMailq) {
    return { available: false, reason: 'Postfix tools (postqueue/mailq) not found.', stats: { total: 0, active: 0, deferred: 0, hold: 0, failed: 0 } };
  }
  const cmd = hasPostqueue ? 'postqueue -p' : 'mailq';
  const res = await run(cmd, { timeout: 6000 });
  const stats = parseQueue(res.stdout);
  return { available: true, raw: res.stdout.slice(0, 4000), stats };
}

async function getSmtpStatus() {
  const [port25, port587, postfixActive] = await Promise.all([
    probePort(25),
    probePort(587),
    (async () => {
      if (!isLinux) return 'unknown';
      const res = await run('systemctl is-active postfix', { timeout: 4000 });
      const out = res.stdout.trim();
      if (out === 'active') return 'running';
      if (out === 'inactive' || out === 'failed') return 'stopped';
      return 'unknown';
    })(),
  ]);
  return {
    postfix: postfixActive,
    port25: port25 ? 'open' : 'closed',
    port587: port587 ? 'open' : 'closed',
    listening: port25 || port587,
  };
}

async function getAll() {
  const [queue, smtp] = await Promise.all([getQueue(), getSmtpStatus()]);
  return {
    timestamp: Date.now(),
    queue,
    smtp,
  };
}

/**
 * Delete all deferred messages from the Postfix queue.
 */
async function clearDeferred() {
  if (!isLinux) {
    return { ok: false, error: 'Postfix queue actions are only available on Linux.' };
  }
  const hasPostsuper = await commandExists('postsuper');
  if (!hasPostsuper) {
    return { ok: false, error: 'postsuper not found. Install Postfix admin tools.' };
  }
  const res = await run(`${SUDO}postsuper -d ALL deferred`, { timeout: 15000 });
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || res.error || '').trim();
    const hint = !isRoot && /password|sudo|permission denied/i.test(detail)
      ? ' Run the app as root or grant passwordless sudo for postsuper.'
      : '';
    return { ok: false, error: (detail || 'Failed to clear deferred queue.') + hint };
  }
  return { ok: true, message: 'Deferred mail queue cleared.', output: (res.stdout || res.stderr || '').trim() };
}

/**
 * Delete all pending (non-active) mail from the Postfix queue.
 */
async function clearPending() {
  if (!isLinux) {
    return { ok: false, error: 'Postfix queue actions are only available on Linux.' };
  }
  const hasPostsuper = await commandExists('postsuper');
  if (!hasPostsuper) {
    return { ok: false, error: 'postsuper not found. Install Postfix admin tools.' };
  }
  const res = await run(`${SUDO}postsuper -d ALL`, { timeout: 15000 });
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || res.error || '').trim();
    const hint = !isRoot && /password|sudo|permission denied/i.test(detail)
      ? ' Run the app as root or grant passwordless sudo for postsuper.'
      : '';
    return { ok: false, error: (detail || 'Failed to clear pending queue.') + hint };
  }
  return { ok: true, message: 'All pending mail removed from queue.', output: (res.stdout || res.stderr || '').trim() };
}

module.exports = { getAll, getQueue, getSmtpStatus, clearDeferred, clearPending };
