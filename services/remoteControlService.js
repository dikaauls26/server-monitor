'use strict';

/**
 * Run whitelisted systemctl actions on remote servers via SSH.
 */

const sshService = require('./sshService');
const { ALLOWED, ACTIONS } = require('./controlService');

const UNIT_MAP = {
  nginx: ['nginx'],
  mysql: ['mysql', 'mariadb', 'mysqld'],
  redis: ['redis-server', 'redis'],
  postfix: ['postfix'],
  openlitespeed: ['lshttpd', 'lsws'],
  lscpd: ['lscpd'],
};

async function resolveRemoteUnit(serverId, key) {
  const units = UNIT_MAP[key] || [];
  for (const unit of units) {
    const res = await sshService.exec(serverId, `systemctl cat ${unit}.service >/dev/null 2>&1 && echo ${unit}`, 5000);
    if (res.ok && res.stdout.trim()) return res.stdout.trim();
  }
  return null;
}

async function controlService(serverId, service, action) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, service)) {
    return { ok: false, serverId, error: 'Unknown or not-allowed service.' };
  }
  if (!ACTIONS.includes(action)) {
    return { ok: false, serverId, error: 'Invalid action.' };
  }

  const unit = await resolveRemoteUnit(serverId, service);
  if (!unit) {
    return { ok: false, serverId, error: `${ALLOWED[service].label} is not installed on this server.` };
  }

  const cmd = `sudo -n systemctl ${action} ${unit} 2>&1 || systemctl ${action} ${unit} 2>&1`;
  const res = await sshService.exec(serverId, cmd, 25000);
  if (res.ok) {
    return { ok: true, serverId, message: `${ALLOWED[service].label}: ${action} succeeded.` };
  }
  return {
    ok: false,
    serverId,
    error: `${ALLOWED[service].label}: ${action} failed. ${(res.stderr || res.stdout || '').trim()}`.trim(),
  };
}

async function controlMany(serverIds, service, action) {
  const results = await Promise.all(
    serverIds.map((id) => controlService(id, service, action))
  );
  const ok = results.every((r) => r.ok);
  return { ok, results };
}

async function rebootServer(serverId) {
  const cmd = 'nohup bash -c "sleep 2 && (sudo -n shutdown -r now || shutdown -r now)" >/dev/null 2>&1 & echo rebooting';
  const res = await sshService.exec(serverId, cmd, 8000);
  if (res.ok || /rebooting/i.test(res.stdout)) {
    return { ok: true, serverId, message: 'Reboot command issued. Server will restart shortly.' };
  }
  return {
    ok: false,
    serverId,
    error: (res.stderr || res.stdout || 'Reboot failed.').trim(),
  };
}

module.exports = { controlService, controlMany, rebootServer };
