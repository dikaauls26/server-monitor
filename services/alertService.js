'use strict';

/**
 * Background alert engine.
 *
 * Periodically samples CPU, RAM and Disk usage and records an alert in the
 * database when a metric exceeds its configured threshold. Duplicate alerts
 * for the same metric are throttled (default: not more than once per 5 min)
 * to avoid flooding.
 */

const config = require('../config');
const systemService = require('./systemService');
const alertRepository = require('../repositories/alertRepository');
const settingsRepository = require('../repositories/settingsRepository');

const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes between same-metric alerts
let timer = null;

function thresholds() {
  return {
    cpu: settingsRepository.getInt('alert_cpu_threshold', config.alerts.cpu),
    ram: settingsRepository.getInt('alert_ram_threshold', config.alerts.ram),
    disk: settingsRepository.getInt('alert_disk_threshold', config.alerts.disk),
  };
}

function shouldRecord(metric) {
  const last = alertRepository.lastAlertAt(metric);
  if (!last) return true;
  const lastMs = new Date(last.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - lastMs > THROTTLE_MS;
}

async function checkOnce() {
  const t = thresholds();
  const [cpu, mem, disk] = await Promise.all([
    systemService.getCpu(),
    systemService.getMemory(),
    systemService.getDisk(),
  ]);

  const checks = [
    { metric: 'cpu', value: cpu.usage, threshold: t.cpu, label: 'CPU usage' },
    { metric: 'ram', value: mem.usage, threshold: t.ram, label: 'RAM usage' },
    { metric: 'disk', value: disk.usage, threshold: t.disk, label: 'Disk usage' },
  ];

  const fired = [];
  for (const c of checks) {
    if (c.value > c.threshold && shouldRecord(c.metric)) {
      const level = c.value > 97 ? 'critical' : 'warning';
      alertRepository.create({
        type: 'threshold',
        metric: c.metric,
        value: c.value,
        threshold: c.threshold,
        message: `${c.label} is ${c.value}% (threshold ${c.threshold}%)`,
        level,
      });
      fired.push(c.metric);
    }
  }
  return fired;
}

function start() {
  if (timer) return;
  const intervalMs = Math.max(10, config.alerts.pollSeconds) * 1000;
  // Run once shortly after boot, then on interval.
  setTimeout(() => {
    checkOnce().catch((e) => console.error('[alerts] check failed:', e.message));
  }, 5000);
  timer = setInterval(() => {
    checkOnce().catch((e) => console.error('[alerts] check failed:', e.message));
  }, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[alerts] engine started (every ${config.alerts.pollSeconds}s).`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, checkOnce, thresholds };
