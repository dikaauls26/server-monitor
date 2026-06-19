'use strict';

/**
 * Collect system metrics from a remote Linux server over SSH.
 * Uses a compact shell script that outputs JSON.
 */

const sshService = require('./sshService');
const { remoteBash } = require('./shellScript');

const METRICS_SCRIPT = remoteBash(`
hostname=$(hostname 2>/dev/null || echo unknown)
uptime_sec=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
read l1 l5 l15 _ < /proc/loadavg 2>/dev/null || l1=0; l5=0; l15=0
cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)
mem_total=$(awk '/MemTotal/ {print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
mem_avail=$(awk '/MemAvailable/ {print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
cpu_line=$(grep '^cpu ' /proc/stat 2>/dev/null)
if [ -n "$cpu_line" ]; then
  set -- $cpu_line
  idle=$5; total=0
  for v in $2 $3 $4 $5 $6 $7 $8; do total=$((total+v)); done
  used=$((total-idle))
  cpu_pct=$(awk -v u=$used -v t=$total 'BEGIN{if(t>0) printf "%.2f", u/t*100; else print "0"}')
else
  cpu_pct=0
fi
disk_line=$(df -B1 --output=size,used,target 2>/dev/null | awk 'NR>1 && $3=="/" {print $1","$2","$3; exit}')
if [ -z "$disk_line" ]; then
  disk_line=$(df -B1 2>/dev/null | awk 'NR>1 && $6=="/" {print $2","$3","$6; exit}')
fi
dsize=$(echo "$disk_line" | cut -d, -f1)
dused=$(echo "$disk_line" | cut -d, -f2)
rx=$(cat /sys/class/net/*/statistics/rx_bytes 2>/dev/null | awk '{s+=$1} END {print s+0}')
tx=$(cat /sys/class/net/*/statistics/tx_bytes 2>/dev/null | awk '{s+=$1} END {print s+0}')
distro=$(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')
kernel=$(uname -r 2>/dev/null)
arch=$(uname -m 2>/dev/null)
brand=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^[ \\t]*//')
printf '{"hostname":"%s","uptime":%s,"load1":%s,"load5":%s,"load15":%s,"cores":%s,"cpu":%s,"memTotal":%s,"memUsed":%s,"diskSize":%s,"diskUsed":%s,"rxBytes":%s,"txBytes":%s,"distro":"%s","kernel":"%s","arch":"%s","brand":"%s"}' "$hostname" "$uptime_sec" "$l1" "$l5" "$l15" "$cores" "$cpu_pct" "$mem_total" "$((mem_total-mem_avail))" "$dsize" "$dused" "$rx" "$tx" "$distro" "$kernel" "$arch" "$brand"
`);

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

function parseMetrics(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Invalid remote metrics response');
  return JSON.parse(raw.slice(start, end + 1));
}

async function getOverview(serverId) {
  const res = await sshService.exec(serverId, METRICS_SCRIPT, 15000);
  if (!res.ok && !res.stdout.includes('{')) {
    return { ok: false, error: res.stderr.trim() || 'Failed to collect remote metrics.' };
  }
  let m;
  try {
    m = parseMetrics(res.stdout);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const memUsed = Number(m.memUsed) || 0;
  const memTotal = Number(m.memTotal) || 0;
  const diskUsed = Number(m.diskUsed) || 0;
  const diskSize = Number(m.diskSize) || 0;
  const cores = Number(m.cores) || 1;
  const load1 = Number(m.load1) || 0;

  return {
    ok: true,
    data: {
      timestamp: Date.now(),
      remote: true,
      serverId,
      cpu: {
        usage: Number(m.cpu) || 0,
        cores,
        brand: m.brand || 'Unknown',
        temperature: null,
      },
      memory: {
        total: memTotal,
        used: memUsed,
        free: memTotal - memUsed,
        usage: pct(memUsed, memTotal),
      },
      disk: {
        usage: pct(diskUsed, diskSize),
        primary: diskSize ? { size: diskSize, used: diskUsed, mount: '/' } : null,
        filesystems: diskSize
          ? [{ mount: '/', size: diskSize, used: diskUsed, usage: pct(diskUsed, diskSize) }]
          : [],
      },
      network: {
        rxSec: 0,
        txSec: 0,
        rxBytes: Number(m.rxBytes) || 0,
        txBytes: Number(m.txBytes) || 0,
      },
      os: {
        hostname: m.hostname || 'unknown',
        distro: m.distro || 'Linux',
        kernel: m.kernel || '',
        arch: m.arch || '',
        nodeVersion: process.version,
      },
      load: {
        one: load1,
        five: Number(m.load5) || 0,
        fifteen: Number(m.load15) || 0,
        cores,
        percent: Math.round((load1 / cores) * 10000) / 100,
      },
      uptime: {
        seconds: Number(m.uptime) || 0,
        human: fmtUptime(Number(m.uptime) || 0),
      },
    },
  };
}

module.exports = { getOverview };
