'use strict';

/**
 * Resolve Monitoring All target id (local or remote server row).
 * Kept separate to avoid circular imports with serverShellService.
 */

const serverRepository = require('../repositories/serverRepository');

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

module.exports = { resolveTarget };
