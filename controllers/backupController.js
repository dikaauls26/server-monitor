'use strict';

const backupService = require('../services/backupService');

async function listBackups(req, res, next) {
  try {
    res.json(backupService.listBackups());
  } catch (err) {
    next(err);
  }
}

async function createBackup(req, res, next) {
  try {
    const note = req.body && req.body.note ? String(req.body.note) : '';
    const result = await backupService.createBackup({ note });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

function downloadBackup(req, res, next) {
  try {
    const filePath = backupService.getBackupPath(req.params.id);
    if (!filePath) {
      return res.status(404).json({ ok: false, error: 'Backup not found.' });
    }
    res.download(filePath, `${req.params.id}.tar.gz`);
  } catch (err) {
    next(err);
  }
}

async function restoreBackup(req, res, next) {
  try {
    const confirm = req.body && req.body.confirm ? String(req.body.confirm).trim() : '';
    if (confirm !== req.params.id) {
      return res.status(400).json({
        ok: false,
        error: 'Type the backup id exactly to confirm restore.',
      });
    }

    const result = await backupService.restoreBackup(req.params.id);
    if (result.ok && result.restart) {
      res.json(result);
      setTimeout(() => process.exit(0), 800);
      return;
    }
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

function deleteBackup(req, res, next) {
  try {
    const result = backupService.removeBackup(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listBackups,
  createBackup,
  downloadBackup,
  restoreBackup,
  deleteBackup,
};
