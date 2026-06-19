'use strict';

/**
 * Background queue for CyberPanel domain deletes — one job at a time.
 */

const { getDb } = require('../database/db');
const domainMonitorService = require('./domainMonitorService');
const domainService = require('./domainService');

let workerRunning = false;
let workerTimer = null;

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    domain: row.domain,
    type: row.domain_type,
    status: row.status,
    message: row.message || '',
    error: row.error || '',
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function listJobs(limit = 30) {
  const rows = getDb()
    .prepare('SELECT * FROM domain_delete_jobs ORDER BY id DESC LIMIT ?')
    .all(limit);
  return rows.map(rowToJob);
}

function getQueueStatus() {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS cnt FROM domain_delete_jobs
       WHERE status IN ('queued','running')
       GROUP BY status`
    )
    .all();
  const map = { queued: 0, running: 0 };
  counts.forEach((c) => { map[c.status] = c.cnt; });
  const recentDone = db
    .prepare("SELECT COUNT(*) AS c FROM domain_delete_jobs WHERE status IN ('done','failed') AND finished_at >= datetime('now', '-1 hour')")
    .get();
  return {
    queued: map.queued,
    running: map.running,
    workerActive: workerRunning,
    recentFinished: recentDone ? recentDone.c : 0,
    jobs: listJobs(25),
  };
}

function isDuplicateQueued(serverId, domain) {
  const row = getDb()
    .prepare(
      `SELECT id FROM domain_delete_jobs
       WHERE server_id = ? AND domain = ? AND status IN ('queued','running')
       LIMIT 1`
    )
    .get(String(serverId), domain);
  return !!row;
}

function enqueue(serverId, items) {
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, error: 'No domains selected.' };
  }
  if (items.length > 200) {
    return { ok: false, error: 'Maximum 200 domains per batch.' };
  }

  const sid = String(serverId || 'local');
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO domain_delete_jobs (server_id, domain, domain_type, status)
     VALUES (?, ?, ?, 'queued')`
  );

  const added = [];
  const skipped = [];

  for (const item of items) {
    let domain;
    let type = 'primary';
    try {
      domain = domainService.assertDomain(item.domain || item);
      type = item.type === 'child' ? 'child' : 'primary';
    } catch (err) {
      skipped.push({ domain: item.domain || String(item), reason: err.message });
      continue;
    }
    if (isDuplicateQueued(sid, domain)) {
      skipped.push({ domain, reason: 'Already queued' });
      continue;
    }
    const info = insert.run(sid, domain, type);
    added.push(rowToJob(db.prepare('SELECT * FROM domain_delete_jobs WHERE id = ?').get(info.lastInsertRowid)));
  }

  if (!added.length) {
    return { ok: false, error: 'No new jobs queued.', skipped };
  }

  startWorker();
  return {
    ok: true,
    message: `${added.length} domain(s) queued for delete.`,
    added: added.length,
    skipped,
    queue: getQueueStatus(),
  };
}

async function processNextJob() {
  const db = getDb();
  const job = db
    .prepare("SELECT * FROM domain_delete_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
    .get();
  if (!job) {
    workerRunning = false;
    return;
  }

  workerRunning = true;
  db.prepare("UPDATE domain_delete_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?")
    .run(job.id);

  let result;
  try {
    result = await domainMonitorService.remove(job.server_id, job.domain, job.domain_type);
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  const msg = result.message || '';
  const warn = (result.warnings || []).join(' ');
  const fullMsg = [msg, warn].filter(Boolean).join(' ');
  const success = result.ok === true || result.ok === 1;

  if (success) {
    db.prepare(
      `UPDATE domain_delete_jobs SET status = 'done', message = ?, error = NULL, finished_at = datetime('now') WHERE id = ?`
    ).run(fullMsg || 'Deleted', job.id);
  } else {
    db.prepare(
      `UPDATE domain_delete_jobs SET status = 'failed', message = ?, error = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(fullMsg, result.error || 'Delete failed', job.id);
  }
}

function startWorker() {
  if (workerTimer) return;
  workerTimer = setInterval(async () => {
    try {
      await processNextJob();
      const pending = getDb()
        .prepare("SELECT COUNT(*) AS c FROM domain_delete_jobs WHERE status = 'queued'")
        .get();
      if (!pending.c) workerRunning = false;
    } catch (err) {
      console.error('[domain-delete] worker error:', err.message);
    }
  }, 2500);
  workerTimer.unref();
}

function resumeWorker() {
  const db = getDb();
  db.prepare("UPDATE domain_delete_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'")
    .run();
  // Fix jobs wrongly marked failed when response contained ok:true (parser bug v1.7.0)
  db.prepare(
    `UPDATE domain_delete_jobs SET status = 'done', message = COALESCE(NULLIF(message, ''), 'Domain removed'),
     error = NULL
     WHERE status = 'failed' AND (error LIKE '%"ok": true%' OR error LIKE '%"ok":true%')`
  ).run();
  const pending = db.prepare("SELECT COUNT(*) AS c FROM domain_delete_jobs WHERE status = 'queued'").get();
  if (pending.c) startWorker();
}

module.exports = {
  enqueue,
  listJobs,
  getQueueStatus,
  resumeWorker,
};
