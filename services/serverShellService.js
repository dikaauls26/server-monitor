'use strict';

/**
 * Run shell commands on local or remote servers (Monitoring All terminal).
 */

const os = require('os');
const { run } = require('./execHelper');
const sshService = require('./sshService');
const { resolveTarget } = require('./serverTargetService');

const MAX_COMMAND_LEN = 8000;
const DEFAULT_TIMEOUT = 60000;
const MIN_TIMEOUT = 5000;
const MAX_TIMEOUT = 300000;
const isLinux = os.platform() === 'linux';

function normalizeCommand(raw) {
  const command = String(raw || '').trim();
  if (!command) return { ok: false, error: 'Command is required.' };
  if (command.length > MAX_COMMAND_LEN) {
    return { ok: false, error: `Command too long (max ${MAX_COMMAND_LEN} characters).` };
  }
  if (command.includes('\0')) return { ok: false, error: 'Invalid command.' };
  return { ok: true, command };
}

function clampTimeout(ms) {
  const n = parseInt(ms, 10);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.min(MAX_TIMEOUT, Math.max(MIN_TIMEOUT, n));
}

async function execCommand(serverId, command, timeoutMs = DEFAULT_TIMEOUT) {
  const parsed = normalizeCommand(command);
  if (!parsed.ok) return parsed;

  const target = resolveTarget(serverId || 'local');
  if (!target) return { ok: false, error: 'Invalid server id.' };

  const timeout = clampTimeout(timeoutMs);
  const started = Date.now();

  if (target.local) {
    if (!isLinux) {
      return { ok: false, error: 'Shell commands on local server require Linux.' };
    }
    const res = await run(parsed.command, { timeout });
    return {
      ok: res.ok,
      exitCode: res.code,
      stdout: res.stdout || '',
      stderr: res.stderr || res.error || '',
      durationMs: Date.now() - started,
      serverId: 'local',
      command: parsed.command,
    };
  }

  const conn = sshService.getStatus(target.remoteId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(target.remoteId);
    if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
  }

  const res = await sshService.exec(target.remoteId, parsed.command, timeout);
  return {
    ok: res.ok,
    exitCode: res.code,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    durationMs: Date.now() - started,
    serverId: String(target.remoteId),
    command: parsed.command,
  };
}

module.exports = { execCommand, MAX_COMMAND_LEN, DEFAULT_TIMEOUT, MAX_TIMEOUT };
