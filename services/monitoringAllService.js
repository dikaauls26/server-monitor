'use strict';

/**
 * Aggregate monitoring for local server + all configured remote servers.
 */

const os = require('os');
const serverRepository = require('../repositories/serverRepository');
const systemService = require('./systemService');
const serviceMonitorService = require('./serviceMonitorService');
const controlService = require('./controlService');
const remoteMonitorService = require('./remoteMonitorService');
const remoteControlService = require('./remoteControlService');
const remoteMailService = require('./remoteMailService');
const mailService = require('./mailService');
const cronService = require('./cronService');
const sshService = require('./sshService');
const serverShellService = require('./serverShellService');

function resolveTarget(serverId) {
  const raw = String(serverId);
  if (raw === 'local' || raw === '0') {
    return { local: true, remoteId: null, name: 'Local Server' };
  }
  const id = parseInt(raw, 10);
  if (!Number.isFinite(id)) return null;
  const srv = serverRepository.getById(id);
  if (!srv) return null;
  return { local: false, remoteId: id, name: srv.name };
}

function withOnlineFlag(snap) {
  return {
    ...snap,
    online: !!(snap.connected && snap.ok !== false),
  };
}

async function getLocalSnapshot() {
  const [overview, services] = await Promise.all([
    systemService.getOverview(),
    serviceMonitorService.getAll(),
  ]);
  return withOnlineFlag({
    ok: true,
    id: 'local',
    name: 'Local Server',
    host: overview.os.hostname || os.hostname(),
    port: null,
    connected: true,
    local: true,
    hostname: overview.os.hostname || os.hostname(),
    cpu: overview.cpu,
    memory: overview.memory,
    disk: {
      usage: overview.disk.usage,
      used: overview.disk.primary ? overview.disk.primary.used : 0,
      size: overview.disk.primary ? overview.disk.primary.size : 0,
    },
    load: overview.load,
    uptime: overview.uptime,
    os: {
      distro: `${overview.os.distro || ''} ${overview.os.release || ''}`.trim(),
      kernel: overview.os.kernel || '',
      arch: overview.os.arch || '',
    },
    services: services.services,
    pm2: services.pm2,
  });
}

async function getAll() {
  const remoteList = serverRepository.list();
  const [local, ...remoteSnaps] = await Promise.all([
    getLocalSnapshot(),
    ...remoteList.map((s) => remoteMonitorService.getSnapshot(s.id)),
  ]);

  const servers = [local, ...remoteSnaps.map((snap, i) => withOnlineFlag({
    ...snap,
    name: snap.name || remoteList[i].name,
    host: snap.host || remoteList[i].host,
    port: snap.port || remoteList[i].port,
    autoConnect: remoteList[i].autoConnect,
  }))];

  return {
    timestamp: Date.now(),
    servers,
    connected: servers.filter((s) => s.connected).length,
    online: servers.filter((s) => s.online).length,
    total: servers.length,
  };
}

async function getCron(serverId) {
  const target = resolveTarget(serverId);
  if (!target) return { ok: false, error: 'Invalid server id.' };

  if (target.local) {
    const cron = await cronService.getLocal();
    return { ok: true, data: cron };
  }

  const conn = sshService.getStatus(target.remoteId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(target.remoteId);
    if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
  }

  const cron = await cronService.getRemote(target.remoteId);
  return { ok: true, data: cron };
}

async function getMail(serverId) {
  const target = resolveTarget(serverId);
  if (!target) return { ok: false, error: 'Invalid server id.' };

  if (target.local) {
    const data = await mailService.getAll();
    return { ok: true, data };
  }

  return remoteMailService.getMail(target.remoteId);
}

async function clearMailDeferred(serverId) {
  const target = resolveTarget(serverId);
  if (!target) return { ok: false, error: 'Invalid server id.' };
  if (target.local) return mailService.clearDeferred();
  return remoteMailService.clearDeferred(target.remoteId);
}

async function clearMailPending(serverId) {
  const target = resolveTarget(serverId);
  if (!target) return { ok: false, error: 'Invalid server id.' };
  if (target.local) return mailService.clearPending();
  return remoteMailService.clearPending(target.remoteId);
}

async function reboot(serverId) {
  const target = resolveTarget(serverId);
  if (!target) return { ok: false, error: 'Invalid server id.' };

  if (target.local) {
    return controlService.rebootSystem();
  }

  const conn = sshService.getStatus(target.remoteId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(target.remoteId);
    if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
  }

  return remoteControlService.rebootServer(target.remoteId);
}

async function controlBulk({ targets, service, action }) {
  if (!service || !action) {
    return { ok: false, error: 'Service and action are required.' };
  }

  let local = false;
  let remoteIds = [];

  if (targets === 'all' || !targets || !targets.length) {
    local = true;
    remoteIds = serverRepository.list().map((s) => s.id);
  } else {
    for (const t of targets) {
      if (t === 'local' || t === 0) local = true;
      else {
        const id = parseInt(t, 10);
        if (Number.isFinite(id)) remoteIds.push(id);
      }
    }
  }

  const results = [];

  if (local) {
    const r = await controlService.controlService(service, action);
    results.push({ serverId: 'local', name: 'Local Server', ...r });
  }

  if (remoteIds.length) {
    const remote = await remoteControlService.controlMany(remoteIds, service, action);
    for (const r of remote.results) {
      const srv = serverRepository.getById(r.serverId);
      results.push({ serverId: r.serverId, name: srv ? srv.name : r.serverId, ...r });
    }
  }

  const ok = results.length > 0 && results.every((r) => r.ok);
  return { ok, results, message: ok ? 'Action completed on all targets.' : 'Some targets failed.' };
}

async function connectAll() {
  const list = serverRepository.list();
  const results = await Promise.all(list.map(async (s) => {
    const r = await sshService.connectServer(s.id);
    return { id: s.id, name: s.name, ...r };
  }));
  return { ok: true, results };
}

async function execShell(serverId, command, timeoutMs) {
  return serverShellService.execCommand(serverId, command, timeoutMs);
}

module.exports = {
  getAll,
  getCron,
  getMail,
  clearMailDeferred,
  clearMailPending,
  reboot,
  controlBulk,
  connectAll,
  execShell,
  resolveTarget,
};
