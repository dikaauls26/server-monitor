'use strict';

/**
 * Service control: start / stop / restart / reload system daemons and
 * reboot the server.
 *
 * SECURITY:
 *   - Only services in the ALLOWED whitelist can be controlled.
 *   - Only actions in the ACTIONS whitelist are accepted.
 *   - Nothing from the user is concatenated into the shell except values
 *     that have already been validated against these whitelists, so command
 *     injection is not possible.
 *   - When the app runs as root, systemctl is called directly; otherwise it
 *     is prefixed with `sudo -n` (passwordless sudo required).
 */

const os = require('os');
const { run } = require('./execHelper');

const isLinux = os.platform() === 'linux';
const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
const SUDO = isRoot ? '' : 'sudo -n ';

// service key -> candidate systemd unit names (first existing one is used)
const ALLOWED = {
  nginx: { label: 'Nginx', units: ['nginx'] },
  mysql: { label: 'MySQL / MariaDB', units: ['mysql', 'mariadb', 'mysqld'] },
  redis: { label: 'Redis', units: ['redis-server', 'redis'] },
  postfix: { label: 'Postfix', units: ['postfix'] },
  openlitespeed: { label: 'OpenLiteSpeed', units: ['lshttpd', 'lsws'] },
  lscpd: { label: 'LSCPD (CyberPanel)', units: ['lscpd'] },
};

const ACTIONS = ['start', 'stop', 'restart', 'reload'];

function listControllable() {
  return Object.keys(ALLOWED).map((key) => ({ key, label: ALLOWED[key].label }));
}

async function unitExists(unit) {
  const r = await run(`systemctl cat ${unit}.service`, { timeout: 4000 });
  return r.ok;
}

async function resolveUnit(key) {
  const cands = ALLOWED[key].units;
  for (const u of cands) {
    if (await unitExists(u)) return u;
  }
  return null;
}

async function controlService(key, action) {
  if (!isLinux) return { ok: false, error: 'Service control is only available on Linux.' };
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, key)) {
    return { ok: false, error: 'Unknown or not-allowed service.' };
  }
  if (!ACTIONS.includes(action)) {
    return { ok: false, error: 'Invalid action.' };
  }

  const unit = await resolveUnit(key);
  if (!unit) {
    return { ok: false, error: `${ALLOWED[key].label} is not installed on this server.` };
  }

  const r = await run(`${SUDO}systemctl ${action} ${unit}`, { timeout: 25000 });
  if (r.ok) {
    return { ok: true, unit, action, message: `${ALLOWED[key].label}: ${action} succeeded.` };
  }
  const detail = (r.stderr || r.error || '').trim();
  const hint = !isRoot && /password|sudo/i.test(detail)
    ? ' (passwordless sudo is required when not running as root)'
    : '';
  return { ok: false, unit, action, error: `${ALLOWED[key].label}: ${action} failed.${hint} ${detail}`.trim() };
}

function rebootSystem() {
  if (!isLinux) return { ok: false, error: 'Reboot is only available on Linux.' };
  // Delay slightly so the HTTP response is flushed before the box goes down.
  run(`sleep 2 && ${SUDO}shutdown -r now`, { timeout: 4000 });
  return { ok: true, message: 'Reboot command issued. The server will restart shortly.' };
}

module.exports = { controlService, rebootSystem, listControllable, ALLOWED, ACTIONS };
