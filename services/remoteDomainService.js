'use strict';

const sshService = require('./sshService');
const serverRepository = require('../repositories/serverRepository');
const domainService = require('./domainService');

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

async function list(serverId, { checkHttp = true } = {}) {
  const ready = await ensureConnected(serverId);
  if (!ready.ok) return ready;

  const cmd = checkHttp
    ? `CHECK_HTTP=1 ${domainService.LIST_SCRIPT}`
    : `CHECK_HTTP=0 ${domainService.LIST_SCRIPT}`;

  const res = await sshService.exec(serverId, cmd, checkHttp ? 180000 : 90000);
  const parsed = domainService.parseListOutput(res.stdout || res.stderr);

  return {
    ok: true,
    data: {
      ...parsed,
      summary: domainService.summarize(parsed.sites),
      timestamp: Date.now(),
      checkHttp,
    },
  };
}

async function deleteDomain(serverId, domain, type) {
  const ready = await ensureConnected(serverId);
  if (!ready.ok) return ready;

  const d = domainService.assertDomain(domain);
  const before = await list(serverId, { checkHttp: false });
  if (!before.ok || !before.data || before.data.available === false) {
    return { ok: false, error: before.error || before.data?.error || 'Could not load domain list before delete.' };
  }
  const sites = before.data.sites || [];
  const found = domainService.findSite(sites, d);
  if (!found) {
    return { ok: true, message: `Domain "${d}" already removed from CyberPanel.` };
  }

  const useType = type === 'child' || found.type === 'child' ? 'child' : 'primary';
  const res = await sshService.exec(
    serverId,
    domainService.DELETE_SCRIPT(d, useType),
    180000
  );
  return domainService.parseDeleteOutput(res.stdout || res.stderr);
}

module.exports = { list, deleteDomain };
