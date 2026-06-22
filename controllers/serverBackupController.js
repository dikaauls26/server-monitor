'use strict';

const path = require('path');
const serverBackupService = require('../services/serverBackupService');
const serverBackupQueueService = require('../services/serverBackupQueueService');

async function listServerImages(req, res, next) {
  try {
    const serverId = req.params.serverId || 'local';
    const meta = serverBackupService.getServerMeta(serverId);
    if (!meta) return res.status(400).json({ ok: false, error: 'Invalid server id.' });
    res.json({
      ok: true,
      server: meta,
      images: serverBackupService.listImages(serverId),
    });
  } catch (err) {
    next(err);
  }
}

async function queueServerBackup(req, res, next) {
  try {
    const note = req.body && req.body.note ? String(req.body.note) : '';
    const result = serverBackupQueueService.enqueue(req.params.serverId, 'backup', { note });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function queueServerRestore(req, res, next) {
  try {
    const filename = req.body && req.body.filename ? String(req.body.filename) : '';
    const confirm = req.body && req.body.confirm ? String(req.body.confirm).trim() : '';
    if (confirm !== 'RESTORE') {
      return res.status(400).json({ ok: false, error: 'Type RESTORE to confirm.' });
    }
    const result = serverBackupQueueService.enqueue(req.params.serverId, 'restore', { filename });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

function downloadServerImage(req, res, next) {
  try {
    const fp = serverBackupService.getImagePath(req.params.serverId, req.params.filename);
    if (!fp) return res.status(404).json({ ok: false, error: 'Image not found.' });
    res.download(fp, path.basename(fp));
  } catch (err) {
    next(err);
  }
}

function deleteServerImage(req, res, next) {
  try {
    const result = serverBackupService.deleteImage(req.params.serverId, req.params.filename);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
}

async function backupQueueStatus(req, res, next) {
  try {
    res.json({ ok: true, data: serverBackupQueueService.getQueueStatus() });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listServerImages,
  queueServerBackup,
  queueServerRestore,
  downloadServerImage,
  deleteServerImage,
  backupQueueStatus,
};
