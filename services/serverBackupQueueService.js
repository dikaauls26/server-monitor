'use strict';

/**
 * Background queue for server image backup/restore — one job at a time.
 */

const { getDb } = require('../database/db');
const serverBackupService = require('./serverBackupService');

let workerRunning = false;
let workerTimer = null;

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    serverName: row.server_name || '',
    jobType: row.job_type,
    filename: row.filename || '',
    status: row.status,
    message: row.message || '',
    error: row.error || '',
    note: row.note || '',
    fileSize: row.file_size || 0,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function isDuplicateQueued(serverId, jobType) {
  const row = getDb()
    .prepare(
      `SELECT id FROM server_backup_jobs
       WHERE server_id = ? AND job_type = ? AND status IN ('queued','running')
       LIMIT 1`
    )
    .get(String(serverId), jobType);
  return !!row;
}

function enqueue(serverId, jobType, { filename = '', note = '' } = {}) {
  const type = jobType === 'restore' ? 'restore' : 'backup';
  const sid = String(serverId || 'local');
  const meta = serverBackupService.getServerMeta(sid);
  if (!meta) return { ok: false, error: 'Invalid server id.' };

  if (type === 'restore' && !filename) {
    return { ok: false, error: 'Backup filename is required for restore.' };
  }
  if (isDuplicateQueued(sid, type)) {
    return { ok: false, error: 'A backup/restore job is already queued for this server.' };
  }

  const db = getDb();
  const info = db.prepare(
    `INSERT INTO server_backup_jobs (server_id, server_name, job_type, filename, note, status)
     VALUES (?, ?, ?, ?, ?, 'queued')`
  ).run(sid, meta.name, type, filename || null, String(note || '').slice(0, 200));

  startWorker();
  return {
    ok: true,
    message: type === 'restore' ? 'Restore queued.' : 'Backup queued — runs in background on server (websites stay online).',
    job: rowToJob(db.prepare('SELECT * FROM server_backup_jobs WHERE id = ?').get(info.lastInsertRowid)),
    queue: getQueueStatus(),
  };
}

function getQueueStatus(limit = 20) {
  const db = getDb();
  const counts = db.prepare(
    `SELECT status, COUNT(*) AS cnt FROM server_backup_jobs
     WHERE status IN ('queued','running') GROUP BY status`
  ).all();
  const map = { queued: 0, running: 0 };
  counts.forEach((c) => { map[c.status] = c.cnt; });
  const jobs = db.prepare('SELECT * FROM server_backup_jobs ORDER BY id DESC LIMIT ?').all(limit).map(rowToJob);
  return {
    queued: map.queued,
    running: map.running,
    workerActive: workerRunning,
    jobs,
    images: serverBackupService.listAllImages().slice(0, 50),
  };
}

async function processNextJob() {
  const db = getDb();
  const job = db.prepare("SELECT * FROM server_backup_jobs WHERE status = 'queued' ORDER BY id ASC LIMIT 1").get();
  if (!job) {
    workerRunning = false;
    return;
  }

  workerRunning = true;
  db.prepare("UPDATE server_backup_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?").run(job.id);

  let result;
  try {
    if (job.job_type === 'restore') {
      result = await serverBackupService.runRestore(job.server_id, job.filename);
    } else {
      result = await serverBackupService.runBackup(job.server_id, job.note, (msg) => {
        db.prepare('UPDATE server_backup_jobs SET message = ? WHERE id = ?').run(msg, job.id);
      });
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  const success = result.ok === true;
  const msg = result.message || '';
  const fileSize = result.image ? result.image.size : 0;
  const filename = result.image ? result.image.filename : job.filename;

  if (success) {
    db.prepare(
      `UPDATE server_backup_jobs SET status = 'done', message = ?, error = NULL,
       filename = COALESCE(?, filename), file_size = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(msg || 'Completed', filename || null, fileSize || 0, job.id);
  } else {
    db.prepare(
      `UPDATE server_backup_jobs SET status = 'failed', message = ?, error = ?, finished_at = datetime('now') WHERE id = ?`
    ).run(msg, result.error || 'Job failed', job.id);
  }
}

function startWorker() {
  if (workerTimer) {
    process.nextTick(() => processNextJob().catch(() => {}));
    return;
  }
  workerTimer = setInterval(async () => {
    try {
      await processNextJob();
      const pending = getDb().prepare("SELECT COUNT(*) AS c FROM server_backup_jobs WHERE status = 'queued'").get();
      if (!pending.c) workerRunning = false;
    } catch (err) {
      console.error('[server-backup] worker error:', err.message);
    }
  }, 3000);
  workerTimer.unref();
  processNextJob().catch(() => {});
}

function resumeWorker() {
  const db = getDb();
  db.prepare("UPDATE server_backup_jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run();
  const pending = db.prepare("SELECT COUNT(*) AS c FROM server_backup_jobs WHERE status = 'queued'").get();
  if (pending.c) startWorker();
}

module.exports = {
  enqueue,
  getQueueStatus,
  resumeWorker,
};
