'use strict';

const domainService = require('./domainService');
const remoteDomainService = require('./remoteDomainService');
const { resolveTarget } = require('./monitoringAllService');
const sshService = require('./sshService');

async function list(serverId, options = {}) {
  const target = resolveTarget(serverId || 'local');
  if (!target) return { ok: false, error: 'Invalid server id.' };

  if (target.local) {
    const result = await domainService.listLocal(options);
    return { ...result, server: { id: 'local', name: target.name } };
  }

  const conn = sshService.getStatus(target.remoteId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(target.remoteId);
    if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
  }

  const result = await remoteDomainService.list(target.remoteId, options);
  return { ...result, server: { id: target.remoteId, name: target.name } };
}

async function remove(serverId, domain, type) {
  const target = resolveTarget(serverId || 'local');
  if (!target) return { ok: false, error: 'Invalid server id.' };

  try {
    domainService.assertDomain(domain);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (target.local) {
    return domainService.deleteLocal(domain, type);
  }

  const conn = sshService.getStatus(target.remoteId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(target.remoteId);
    if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
  }

  return remoteDomainService.deleteDomain(target.remoteId, domain, type);
}

module.exports = { list, remove };
