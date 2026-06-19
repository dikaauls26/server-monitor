'use strict';

/**
 * Collect cron job entries from the local server or a remote host over SSH.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./execHelper');
const sshService = require('./sshService');
const { remoteBash } = require('./shellScript');

const isLinux = os.platform() === 'linux';

const CRON_REMOTE_SCRIPT = remoteBash(`
if command -v python3 >/dev/null 2>&1; then
python3 - <<'PYEOF'
import json, subprocess, os, glob

jobs = []

def add(user, source, schedule, command):
    cmd = (command or '').strip()
    if not cmd:
        return
    jobs.append({
        'user': user or 'root',
        'source': source,
        'schedule': schedule,
        'command': cmd[:500],
    })

def parse_user_lines(text, user, source):
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line and not line[0].isdigit() and not line.startswith('@'):
            head = line.split('=', 1)[0]
            if head.replace('_', '').isalnum() and len(line.split()) < 6:
                continue
        if line.startswith('@'):
            idx = line.find(' ')
            if idx <= 0:
                continue
            add(user, source, line[:idx], line[idx + 1:])
            continue
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        add(user, source, ' '.join(parts[:5]), parts[5])

def parse_system_lines(text, source):
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line and not line[0].isdigit() and not line.startswith('@'):
            head = line.split('=', 1)[0]
            if head.replace('_', '').isalnum() and len(line.split()) < 6:
                continue
        if line.startswith('@'):
            idx = line.find(' ')
            if idx <= 0:
                continue
            add('root', source, line[:idx], line[idx + 1:])
            continue
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        add(parts[5], source, ' '.join(parts[:5]), parts[6])

user = os.environ.get('USER') or 'root'
try:
    out = subprocess.check_output(['crontab', '-l'], stderr=subprocess.DEVNULL, text=True)
    parse_user_lines(out, user, 'crontab')
except Exception:
    pass

if os.path.isfile('/etc/crontab'):
    with open('/etc/crontab', encoding='utf-8', errors='replace') as fh:
        parse_system_lines(fh.read(), '/etc/crontab')

for fp in sorted(glob.glob('/etc/cron.d/*')):
    if os.path.isfile(fp) and not os.path.basename(fp).startswith('.'):
        with open(fp, encoding='utf-8', errors='replace') as fh:
            parse_system_lines(fh.read(), fp)

print(json.dumps({'jobs': jobs, 'total': len(jobs)}))
PYEOF
else
  echo '{"jobs":[],"total":0}'
fi
`);

function parseUserCrontabLine(line, meta) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) && trimmed.split(/\s+/).length < 6) return null;

  if (trimmed.startsWith('@')) {
    const idx = trimmed.indexOf(' ');
    if (idx <= 0) return null;
    return {
      user: meta.user,
      source: meta.source,
      schedule: trimmed.slice(0, idx),
      command: trimmed.slice(idx + 1).trim(),
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 6) return null;
  return {
    user: meta.user,
    source: meta.source,
    schedule: parts.slice(0, 5).join(' '),
    command: parts.slice(5).join(' '),
  };
}

function parseSystemCrontabLine(line, source) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed) && trimmed.split(/\s+/).length < 6) return null;

  if (trimmed.startsWith('@')) {
    const idx = trimmed.indexOf(' ');
    if (idx <= 0) return null;
    return {
      user: 'root',
      source,
      schedule: trimmed.slice(0, idx),
      command: trimmed.slice(idx + 1).trim(),
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 7) return null;
  return {
    user: parts[5],
    source,
    schedule: parts.slice(0, 5).join(' '),
    command: parts.slice(6).join(' '),
  };
}

function parseCrontabContent(content, meta, systemFile) {
  const jobs = [];
  for (const line of content.split('\n')) {
    const job = systemFile
      ? parseSystemCrontabLine(line, meta.source)
      : parseUserCrontabLine(line, meta);
    if (job && job.command) jobs.push(job);
  }
  return jobs;
}

async function getLocal() {
  if (!isLinux) {
    return { available: false, jobs: [], total: 0, reason: 'Cron listing is only available on Linux.' };
  }

  const jobs = [];
  const user = process.env.USER || 'root';

  const cr = await run('crontab -l 2>/dev/null || true', { timeout: 5000 });
  jobs.push(...parseCrontabContent(cr.stdout, { user, source: 'crontab' }, false));

  try {
    if (fs.existsSync('/etc/crontab')) {
      const content = fs.readFileSync('/etc/crontab', 'utf8');
      jobs.push(...parseCrontabContent(content, { source: '/etc/crontab' }, true));
    }
  } catch (_) { /* ignore permission errors */ }

  try {
    const cronDir = '/etc/cron.d';
    if (fs.existsSync(cronDir)) {
      for (const name of fs.readdirSync(cronDir)) {
        if (name.startsWith('.')) continue;
        const fp = path.join(cronDir, name);
        try {
          if (!fs.statSync(fp).isFile()) continue;
          const content = fs.readFileSync(fp, 'utf8');
          jobs.push(...parseCrontabContent(content, { source: fp }, true));
        } catch (_) { /* skip unreadable files */ }
      }
    }
  } catch (_) { /* ignore */ }

  return { available: true, jobs, total: jobs.length };
}

async function getRemote(serverId) {
  const res = await sshService.exec(serverId, CRON_REMOTE_SCRIPT, 15000);
  if (!res.ok && !res.stdout.includes('{')) {
    return { available: false, jobs: [], total: 0, error: (res.stderr || '').trim() || 'Failed to list cron jobs' };
  }
  try {
    const start = res.stdout.indexOf('{');
    const end = res.stdout.lastIndexOf('}');
    const parsed = JSON.parse(res.stdout.slice(start, end + 1));
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    return { available: true, jobs, total: jobs.length };
  } catch (err) {
    return { available: false, jobs: [], total: 0, error: err.message };
  }
}

module.exports = { getLocal, getRemote };
