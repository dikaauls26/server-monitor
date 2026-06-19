'use strict';

const domainService = require('./domainService');
const remoteDomainService = require('./remoteDomainService');
const cloudflareService = require('./cloudflareService');
const { resolveTarget } = require('./monitoringAllService');
const sshService = require('./sshService');
const serverRepository = require('../repositories/serverRepository');
const { run } = require('./execHelper');

async function getServerIp(target) {
  if (target.local) {
    const res = await run(
      'curl -fsSL --max-time 6 https://api.ipify.org 2>/dev/null || curl -fsSL --max-time 6 https://ifconfig.me/ip 2>/dev/null',
      { timeout: 10000 }
    );
    const ip = (res.stdout || '').trim();
    if (ip) return ip;
    return null;
  }
  const srv = serverRepository.getById(target.remoteId);
  return srv ? srv.host : null;
}

async function list(serverId, options = {}) {
  const target = resolveTarget(serverId || 'local');
  if (!target) return { ok: false, error: 'Invalid server id.' };

  let result;
  if (target.local) {
    result = await domainService.listLocal(options);
  } else {
    const conn = sshService.getStatus(target.remoteId);
    if (!conn.connected) {
      const connect = await sshService.connectServer(target.remoteId);
      if (!connect.ok) return { ok: false, error: connect.error || 'Not connected' };
    }
    result = await remoteDomainService.list(target.remoteId, options);
  }

  if (!result.ok || !result.data) return { ...result, server: { id: target.local ? 'local' : target.remoteId, name: target.name } };

  const serverIp = await getServerIp(target);
  const sites = await cloudflareService.enrichSites(result.data.sites || [], serverIp);
  const moved = sites.filter((s) => s.dns && s.dns.note && ['moved', 'mixed', 'cname'].includes(s.dns.note.status)).length;

  return {
    ...result,
    server: { id: target.local ? 'local' : target.remoteId, name: target.name },
    data: {
      ...result.data,
      sites,
      serverIp,
      cloudflare: cloudflareService.getPublicConfig(),
      summary: {
        ...(result.data.summary || domainService.summarize(sites)),
        moved,
      },
    },
  };
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
