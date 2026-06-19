'use strict';

/**
 * Antivirus scan queue — ClamAV (clamscan/clamdscan) and Maldet (maldet).
 * Jobs run one at a time in the background; status is persisted in SQLite.
 */

const os = require('os');
const { getDb } = require('../database/db');
const { run, commandExists } = require('./execHelper');

const isLinux = os.platform() === 'linux';

let workerRunning = false;
let workerTimer = null;

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    scanner: row.scanner,
    path: row.path,
    status: row.status,
    output: row.output || '',
    error: row.error || '',
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function listJobs(limit = 50) {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM scan_jobs ORDER BY id DESC LIMIT ?')
    .all(limit);
  return rows.map(rowToJob);
}

function getJob(id) {
  const db = getDb();
  return rowToJob(db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(id));
}

function getQueueStatus() {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS cnt FROM scan_jobs
       WHERE status IN ('queued','running')
       GROUP BY status`
    )
    .all();
  const map = { queued: 0, running: 0 };
  counts.forEach((c) => { map[c.status] = c.cnt; });
  return {
    queued: map.queued,
    running: map.running,
    workerActive: workerRunning,
    jobs: listJobs(20),
  };
}

function enqueue(scanner, scanPath) {
  const allowed = ['clamav', 'maldet'];
  if (!allowed.includes(scanner)) {
    return { ok: false, error: 'Invalid scanner. Use clamav or maldet.' };
  }
  const p = String(scanPath || '').trim();
  if (!p || !p.startsWith('/')) {
    return { ok: false, error: 'Scan path must be an absolute path (e.g. /home or /var/www).' };
  }
  if (!isLinux) {
    return { ok: false, error: 'Antivirus scans are only available on Linux servers.' };
  }

  const db = getDb();
  const info = db
    .prepare('INSERT INTO scan_jobs (scanner, path, status) VALUES (?, ?, ?)')
    .run(scanner, p, 'queued');
  startWorker();
  return { ok: true, job: getJob(info.lastInsertRowid), message: 'Scan queued.' };
}

async function buildScanCommand(scanner, scanPath) {
  if (scanner === 'clamav') {
    if (await commandExists('clamdscan')) {
      return { cmd: `clamdscan -i --no-summary "${scanPath}"`, tool: 'clamdscan' };
    }
    if (await commandExists('clamscan')) {
      return { cmd: `clamscan -r -i "${scanPath}"`, tool: 'clamscan' };
    }
    return { error: 'ClamAV not found. Install clamav / clamav-daemon.' };
  }
  if (scanner === 'maldet') {
    if (await commandExists('maldet')) {
      return { cmd: `maldet -a "${scanPath}"`, tool: 'maldet' };
    }
    return { error: 'Maldet not found. Install Linux Malware Detect (maldet).' };
  }
  return { error: 'Unknown scanner.' };
}

async function processNextJob() {
  const db = getDb();
  const job = db
    .prepare("SELECT * FROM scan_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
    .get();
  if (!job) {
    workerRunning = false;
    return;
  }

  workerRunning = true;
  db.prepare("UPDATE scan_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?").run(job.id);

  const built = await buildScanCommand(job.scanner, job.path);
  if (built.error) {
    db.prepare(
      "UPDATE scan_jobs SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?"
    ).run(built.error, job.id);
    return;
  }

  const res = await run(built.cmd, { timeout: 3600000 });
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n').slice(0, 50000);
  const infected = /infected|FOUND|{hit\s/i.test(output);
  const status = res.ok || infected ? 'done' : 'failed';
  const errMsg = status === 'failed' ? (res.stderr.trim() || res.error || 'Scan failed') : '';

  db.prepare(
    `UPDATE scan_jobs SET status = ?, output = ?, error = ?, finished_at = datetime('now') WHERE id = ?`
  ).run(status, output, errMsg, job.id);
}

function startWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    try {
      await processNextJob();
      const db = getDb();
      const pending = db.prepare("SELECT COUNT(*) AS c FROM scan_jobs WHERE status = 'queued'").get();
      if (!pending.c) workerRunning = false;
    } catch (err) {
      console.error('[antivirus] worker error:', err.message);
    }
  }, 2000);
  workerTimer.unref();
}

function resumeWorker() {
  const db = getDb();
  const stale = db.prepare("SELECT id FROM scan_jobs WHERE status = 'running'").all();
  stale.forEach((r) => {
    db.prepare("UPDATE scan_jobs SET status = 'queued', started_at = NULL WHERE id = ?").run(r.id);
  });
  startWorker();
}

module.exports = {
  enqueue,
  listJobs,
  getJob,
  getQueueStatus,
  resumeWorker,
};
