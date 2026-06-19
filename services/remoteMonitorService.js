'use strict';

/**
 * Full monitoring snapshot from a remote Linux server over SSH:
 * metrics (CPU/RAM/disk/load), service statuses, and PM2 apps.
 */

const sshService = require('./sshService');
const cronService = require('./cronService');
const serverRepository = require('../repositories/serverRepository');
const { remoteBash } = require('./shellScript');

const SERVICE_KEYS = [
  { key: 'mysql', label: 'MySQL / MariaDB', units: 'mysql mariadb mysqld' },
  { key: 'redis', label: 'Redis', units: 'redis-server redis' },
  { key: 'nginx', label: 'Nginx', units: 'nginx' },
  { key: 'postfix', label: 'Postfix', units: 'postfix' },
  { key: 'openlitespeed', label: 'OpenLiteSpeed', units: 'lshttpd lsws' },
  { key: 'lscpd', label: 'LSCPD (CyberPanel)', units: 'lscpd' },
];

const MONITOR_SCRIPT = remoteBash(`
hostname=$(hostname 2>/dev/null || echo unknown)
uptime_sec=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
read l1 l5 l15 _ < /proc/loadavg 2>/dev/null || l1=0; l5=0; l15=0
cores=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 1)
mem_total=$(awk '/MemTotal/ {print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
mem_avail=$(awk '/MemAvailable/ {print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)
cpu_line=$(grep '^cpu ' /proc/stat 2>/dev/null)
if [ -n "$cpu_line" ]; then
  set -- $cpu_line
  idle=$5
  total=0
  for v in $2 $3 $4 $5 $6 $7 $8; do total=$((total+v)); done
  used=$((total-idle))
  cpu_pct=$(awk -v u=$used -v t=$total 'BEGIN{if(t>0) printf "%.2f", u/t*100; else print "0"}')
else
  cpu_pct=0
fi
disk_line=$(df -B1 --output=size,used,target 2>/dev/null | awk 'NR>1 && $3=="/" {print $1","$2; exit}')
if [ -z "$disk_line" ]; then
  disk_line=$(df -B1 2>/dev/null | awk 'NR>1 && $6=="/" {print $2","$3; exit}')
fi
dsize=$(echo "$disk_line" | cut -d, -f1)
dused=$(echo "$disk_line" | cut -d, -f2)
distro=$(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')
kernel=$(uname -r 2>/dev/null)
arch=$(uname -m 2>/dev/null)
brand=$(grep -m1 "model name" /proc/cpuinfo 2>/dev/null | cut -d: -f2 | sed 's/^[ \\t]*//')
check_svc(){ key=$1; label=$2; shift 2; st=not-installed; inst=0; ctrl=0; for u in "$@"; do if systemctl cat \${u}.service >/dev/null 2>&1; then inst=1; ctrl=1; active=$(systemctl is-active \${u} 2>/dev/null); if [ "$active" = "active" ]; then st=running; else st=stopped; fi; break; fi; done; printf '"%s":{"label":"%s","status":"%s","installed":%s,"controllable":%s}' "$key" "$label" "$st" "$inst" "$ctrl"; }
svc=$(check_svc mysql 'MySQL / MariaDB' mysql mariadb mysqld)
svc="$svc,$(check_svc redis Redis redis-server redis)"
svc="$svc,$(check_svc nginx Nginx nginx)"
svc="$svc,$(check_svc postfix Postfix postfix)"
svc="$svc,$(check_svc openlitespeed OpenLiteSpeed lshttpd lsws)"
svc="$svc,$(check_svc lscpd 'LSCPD (CyberPanel)' lscpd)"
printf '{"hostname":"%s","uptime":%s,"load1":%s,"load5":%s,"load15":%s,"cores":%s,"cpu":%s,"memTotal":%s,"memUsed":%s,"diskSize":%s,"diskUsed":%s,"distro":"%s","kernel":"%s","arch":"%s","brand":"%s","services":{%s}}' "$hostname" "$uptime_sec" "$l1" "$l5" "$l15" "$cores" "$cpu_pct" "$mem_total" "$((mem_total-mem_avail))" "$dsize" "$dused" "$distro" "$kernel" "$arch" "$brand" "$svc"
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

function parseJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Invalid remote response');
  return JSON.parse(raw.slice(start, end + 1));
}

function mapServices(servicesObj) {
  return SERVICE_KEYS.map((def) => {
    const s = servicesObj && servicesObj[def.key] ? servicesObj[def.key] : {};
    return {
      key: def.key,
      label: s.label || def.label,
      status: s.status || 'not-installed',
      installed: !!s.installed,
      controllable: !!s.controllable && !!s.installed,
    };
  });
}

async function getPm2(serverId) {
  const res = await sshService.exec(serverId, 'command -v pm2 >/dev/null && pm2 jlist 2>/dev/null || echo "[]"', 12000);
  if (!res.stdout || res.stdout.trim() === '[]') {
    return { installed: false, status: 'not-installed', online: 0, total: 0, apps: [] };
  }
  try {
    const parsed = JSON.parse(res.stdout.trim());
    const apps = (Array.isArray(parsed) ? parsed : []).map((p) => ({
      name: p.name,
      pid: p.pid,
      status: p.pm2_env ? p.pm2_env.status : 'unknown',
      restarts: p.pm2_env ? p.pm2_env.restart_time : 0,
      uptime: p.pm2_env ? p.pm2_env.pm_uptime : null,
      cpu: p.monit ? p.monit.cpu : 0,
      memory: p.monit ? p.monit.memory : 0,
    }));
    const online = apps.filter((a) => a.status === 'online').length;
    return {
      installed: true,
      status: apps.length === 0 ? 'idle' : online > 0 ? 'running' : 'stopped',
      online,
      total: apps.length,
      apps,
    };
  } catch (_) {
    return { installed: true, status: 'unknown', online: 0, total: 0, apps: [] };
  }
}

async function getSnapshot(serverId) {
  const server = serverRepository.getById(serverId);
  if (!server) return { ok: false, error: 'Server not found.' };

  const conn = sshService.getStatus(serverId);
  if (!conn.connected) {
    const connect = await sshService.connectServer(serverId);
    if (!connect.ok) {
      return {
        ok: false,
        id: serverId,
        name: server.name,
        host: server.host,
        port: server.port,
        connected: false,
        error: connect.error || 'Not connected',
      };
    }
  }

  const [monRes, pm2, cronRes] = await Promise.all([
    sshService.exec(serverId, MONITOR_SCRIPT, 20000),
    getPm2(serverId),
    cronService.getRemote(serverId),
  ]);

  if (!monRes.ok && !monRes.stdout.includes('{')) {
    return {
      ok: false,
      id: serverId,
      name: server.name,
      host: server.host,
      port: server.port,
      connected: true,
      error: monRes.stderr.trim() || 'Failed to collect data',
    };
  }

  let m;
  try {
    m = parseJson(monRes.stdout);
  } catch (err) {
    return {
      ok: false,
      id: serverId,
      name: server.name,
      host: server.host,
      port: server.port,
      connected: true,
      error: err.message,
    };
  }

  const memUsed = Number(m.memUsed) || 0;
  const memTotal = Number(m.memTotal) || 0;
  const diskUsed = Number(m.diskUsed) || 0;
  const diskSize = Number(m.diskSize) || 0;
  const cores = Number(m.cores) || 1;
  const load1 = Number(m.load1) || 0;

  return {
    ok: true,
    id: serverId,
    name: server.name,
    host: server.host,
    port: server.port,
    connected: true,
    hostname: m.hostname || server.name,
    cpu: {
      usage: Number(m.cpu) || 0,
      cores,
      brand: m.brand || 'Unknown',
    },
    memory: {
      total: memTotal,
      used: memUsed,
      usage: pct(memUsed, memTotal),
    },
    disk: { usage: pct(diskUsed, diskSize), used: diskUsed, size: diskSize },
    load: { one: load1, five: Number(m.load5) || 0, fifteen: Number(m.load15) || 0, percent: Math.round((load1 / cores) * 10000) / 100 },
    uptime: { seconds: Number(m.uptime) || 0, human: fmtUptime(Number(m.uptime) || 0) },
    os: { distro: m.distro || '', kernel: m.kernel || '', arch: m.arch || '' },
    services: mapServices(m.services),
    pm2,
    cron: {
      available: cronRes.available !== false,
      total: cronRes.total || (cronRes.jobs ? cronRes.jobs.length : 0),
      jobs: cronRes.jobs || [],
      error: cronRes.error || null,
    },
  };
}

module.exports = { getSnapshot, SERVICE_KEYS };
