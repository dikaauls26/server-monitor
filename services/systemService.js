'use strict';

/**
 * System metrics collector built on top of `systeminformation`.
 * Provides CPU, RAM, disk, uptime, OS info, network traffic and load.
 *
 * All functions are async and resilient: on any failure they return a
 * safe default so the dashboard never crashes because one probe failed.
 */

const os = require('os');
const si = require('systeminformation');

function pct(used, total) {
  if (!total || total <= 0) return 0;
  return Math.round((used / total) * 10000) / 100;
}

function fmtUptime(seconds) {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

async function getCpu() {
  try {
    const [load, temp, cpu] = await Promise.all([
      si.currentLoad(),
      si.cpuTemperature().catch(() => ({ main: null })),
      si.cpu().catch(() => ({})),
    ]);
    return {
      usage: Math.round(load.currentLoad * 100) / 100,
      cores: load.cpus ? load.cpus.length : os.cpus().length,
      perCore: (load.cpus || []).map((c) => Math.round(c.load * 100) / 100),
      temperature: temp && temp.main ? Math.round(temp.main) : null,
      brand: cpu.brand || cpu.manufacturer || os.cpus()[0]?.model || 'Unknown',
      speedGHz: cpu.speed || null,
    };
  } catch (err) {
    return { usage: 0, cores: os.cpus().length, perCore: [], temperature: null, brand: 'Unknown', speedGHz: null, error: err.message };
  }
}

async function getMemory() {
  try {
    const m = await si.mem();
    const used = m.active != null ? m.active : m.used;
    return {
      total: m.total,
      used,
      free: m.total - used,
      usage: pct(used, m.total),
      swapTotal: m.swaptotal,
      swapUsed: m.swapused,
      swapUsage: pct(m.swapused, m.swaptotal),
    };
  } catch (err) {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, used: total - free, free, usage: pct(total - free, total), swapTotal: 0, swapUsed: 0, swapUsage: 0, error: err.message };
  }
}

async function getDisk() {
  try {
    const fs = await si.fsSize();
    const filesystems = fs
      .filter((d) => d.size > 0)
      .map((d) => ({
        fs: d.fs,
        mount: d.mount,
        type: d.type,
        size: d.size,
        used: d.used,
        available: d.available,
        usage: Math.round((d.use || pct(d.used, d.size)) * 100) / 100,
      }));
    const root =
      filesystems.find((d) => d.mount === '/') ||
      filesystems.sort((a, b) => b.size - a.size)[0] ||
      null;
    return {
      filesystems,
      primary: root,
      usage: root ? root.usage : 0,
    };
  } catch (err) {
    return { filesystems: [], primary: null, usage: 0, error: err.message };
  }
}

async function getNetwork() {
  try {
    const stats = await si.networkStats();
    const totals = stats.reduce(
      (acc, s) => {
        acc.rxSec += s.rx_sec || 0;
        acc.txSec += s.tx_sec || 0;
        acc.rxBytes += s.rx_bytes || 0;
        acc.txBytes += s.tx_bytes || 0;
        return acc;
      },
      { rxSec: 0, txSec: 0, rxBytes: 0, txBytes: 0 }
    );
    return {
      interfaces: stats.map((s) => ({
        iface: s.iface,
        rxSec: Math.max(0, Math.round(s.rx_sec || 0)),
        txSec: Math.max(0, Math.round(s.tx_sec || 0)),
        rxBytes: s.rx_bytes || 0,
        txBytes: s.tx_bytes || 0,
      })),
      rxSec: Math.max(0, Math.round(totals.rxSec)),
      txSec: Math.max(0, Math.round(totals.txSec)),
      rxBytes: totals.rxBytes,
      txBytes: totals.txBytes,
    };
  } catch (err) {
    return { interfaces: [], rxSec: 0, txSec: 0, rxBytes: 0, txBytes: 0, error: err.message };
  }
}

async function getOsInfo() {
  try {
    const [osInfo, versions] = await Promise.all([
      si.osInfo(),
      si.versions().catch(() => ({})),
    ]);
    return {
      platform: osInfo.platform,
      distro: osInfo.distro,
      release: osInfo.release,
      codename: osInfo.codename,
      kernel: osInfo.kernel,
      arch: osInfo.arch,
      hostname: osInfo.hostname || os.hostname(),
      nodeVersion: process.version,
      node: versions.node || process.version.replace('v', ''),
    };
  } catch (err) {
    return {
      platform: os.platform(),
      distro: os.type(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      nodeVersion: process.version,
      error: err.message,
    };
  }
}

function getLoad() {
  const [one, five, fifteen] = os.loadavg();
  const cores = os.cpus().length || 1;
  return {
    one: Math.round(one * 100) / 100,
    five: Math.round(five * 100) / 100,
    fifteen: Math.round(fifteen * 100) / 100,
    cores,
    // load relative to cores as percentage (1.0 per core = 100%)
    percent: Math.round((one / cores) * 10000) / 100,
  };
}

function getUptime() {
  const seconds = os.uptime();
  return { seconds, human: fmtUptime(seconds) };
}

/**
 * Aggregate everything needed for the dashboard in one call.
 */
async function getOverview() {
  const [cpu, memory, disk, network, osInfo] = await Promise.all([
    getCpu(),
    getMemory(),
    getDisk(),
    getNetwork(),
    getOsInfo(),
  ]);
  return {
    timestamp: Date.now(),
    cpu,
    memory,
    disk,
    network,
    os: osInfo,
    load: getLoad(),
    uptime: getUptime(),
  };
}

module.exports = {
  getCpu,
  getMemory,
  getDisk,
  getNetwork,
  getOsInfo,
  getLoad,
  getUptime,
  getOverview,
  fmtUptime,
};
