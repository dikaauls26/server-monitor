'use strict';

const credentialMigrationService = require('../services/credentialMigrationService');

function credentialsStatus(req, res, next) {
  try {
    res.json({ ok: true, data: credentialMigrationService.getStatus() });
  } catch (err) {
    next(err);
  }
}

function encryptCredentials(req, res, next) {
  try {
    const result = credentialMigrationService.encryptAll();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { credentialsStatus, encryptCredentials };
