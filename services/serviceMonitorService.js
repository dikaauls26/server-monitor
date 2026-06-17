'use strict';

/**
 * Monitors the health/status of common server daemons:
 * PM2, Node, MySQL/MariaDB, Redis, Nginx, OpenLiteSpeed, Postfix.
 *
 * Strategy (Linux):
 *   1. Prefer `systemctl is-active <unit>` when available.
 *   2. Fall back to process detection via `pgrep`.
 *   3. PM2 is queried via `pm2 jlist` (JSON) for rich per-app info.
 *
 * Every probe is defensive: a missing tool simply yields status "unknown"
 * or "stopped" rather than crashing.
 */

const os = require('os');
const { run, commandExists } = require('./execHelper');

const isLinux = os.platform() === 'linux';

async function systemctlActive(unit) {
  const res = await run(`systemctl is-active ${unit}`, { timeout: 4000 });
  const out = res.stdout.trim();
  if (out === 'active') return 'running';
  if (out === 'inactive' || out === 'failed') return 'stopped';
  return null; // unknown / no systemd
}

async function pgrepRunning(pattern) {
  const res = await run(`pgrep -x ${pattern} || pgrep -f ${pattern}`, { timeout: 4000 });
  return res.ok && res.stdout.trim().length > 0 ? 'running' : 'stopped';
}

async function unitExists(unit) {
  const r = await run(`systemctl cat ${unit}.service`, { timeout: 4000 });
  return r.ok;
}

/**
 * Resolve a service's status AND whether it is installed.
 * - If a systemd unit exists -> installed, status from `is-active`.
 * - Else if a matching process is running -> installed/running (no unit).
 * - Else -> not installed.
 */
async function resolveService({ units = [], procs = [] }) {
  if (!isLinux) return { status: 'unknown', installed: false };
  for (const unit of units) {
    if (await unitExists(unit)) {
      const s = await systemctlActive(unit);
      return { status: s || 'stopped', installed: true, unit };
    }
  }
  for (const proc of procs) {
    const s = await pgrepRunning(proc);
    if (s === 'running') return { status: 'running', installed: true };
  }
  return { status: 'not-installed', installed: false };
}

async function getPm2() {
  const exists = await commandExists('pm2');
  if (!exists) {
    return { installed: false, status: 'not-installed', apps: [] };
  }
  const res = await run('pm2 jlist', { timeout: 8000 });
  let apps = [];
  try {
    const parsed = JSON.parse(res.stdout || '[]');
    apps = parsed.map((p) => ({
      name: p.name,
      pid: p.pid,
      status: p.pm2_env ? p.pm2_env.status : 'unknown',
      restarts: p.pm2_env ? p.pm2_env.restart_time : 0,
      uptime: p.pm2_env ? p.pm2_env.pm_uptime : null,
      cpu: p.monit ? p.monit.cpu : 0,
      memory: p.monit ? p.monit.memory : 0,
      instances: p.pm2_env ? p.pm2_env.instances || 1 : 1,
    }));
  } catch (_e) {
    apps = [];
  }
  const online = apps.filter((a) => a.status === 'online').length;
  return {
    installed: true,
    status: apps.length === 0 ? 'idle' : online > 0 ? 'running' : 'stopped',
    online,
    total: apps.length,
    apps,
  };
}

// `controllable` marks services that expose start/stop/restart buttons
// (must match the whitelist in services/controlService.js).
const SERVICE_DEFS = [
  { key: 'node', label: 'Node.js', units: [], procs: ['node'], controllable: false },
  { key: 'mysql', label: 'MySQL / MariaDB', units: ['mysql', 'mysqld', 'mariadb'], procs: ['mysqld', 'mariadbd'], controllable: true },
  { key: 'redis', label: 'Redis', units: ['redis-server', 'redis'], procs: ['redis-server'], controllable: true },
  { key: 'nginx', label: 'Nginx', units: ['nginx'], procs: ['nginx'], controllable: true },
  { key: 'openlitespeed', label: 'OpenLiteSpeed', units: ['lshttpd', 'lsws'], procs: ['litespeed', 'openlitespeed'], controllable: true },
  { key: 'lscpd', label: 'LSCPD (CyberPanel)', units: ['lscpd'], procs: ['lscpd'], controllable: true },
  { key: 'postfix', label: 'Postfix', units: ['postfix'], procs: ['master'], controllable: true },
];

async function getServiceStatuses() {
  const results = await Promise.all(
    SERVICE_DEFS.map(async (def) => {
      const r = await resolveService({ units: def.units, procs: def.procs });
      return {
        key: def.key,
        label: def.label,
        status: r.status,
        installed: r.installed,
        controllable: def.controllable && r.installed,
      };
    })
  );
  return results;
}

async function getAll() {
  const [pm2, services] = await Promise.all([getPm2(), getServiceStatuses()]);
  return {
    timestamp: Date.now(),
    platform: os.platform(),
    pm2,
    services,
  };
}

module.exports = { getAll, getPm2, getServiceStatuses };
