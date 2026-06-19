'use strict';

/**
 * Renders the main authenticated pages (shells). Live data is loaded
 * client-side from the JSON API and auto-refreshed.
 */

const alertRepository = require('../repositories/alertRepository');
const logService = require('../services/logService');
const alertService = require('../services/alertService');
const userRepository = require('../repositories/userRepository');
const credentialMigrationService = require('../services/credentialMigrationService');

function dashboard(req, res) {
  res.render('dashboard', {
    title: 'Dashboard',
    activePage: 'dashboard',
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function monitoring(req, res) {
  res.render('monitoring', {
    title: 'Monitoring',
    activePage: 'monitoring',
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function monitoringAll(req, res) {
  res.render('monitoring-all', {
    title: 'Monitoring All',
    activePage: 'monitoring-all',
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function mail(req, res) {
  res.render('mail', {
    title: 'Mail',
    activePage: 'mail',
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function antivirus(req, res) {
  res.render('antivirus', {
    title: 'Antivirus',
    activePage: 'antivirus',
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function servers(req, res) {
  res.render('servers', {
    title: 'Remote Servers',
    activePage: 'servers',
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function logs(req, res) {
  res.render('logs', {
    title: 'Logs',
    activePage: 'logs',
    sources: logService.listLogs(),
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function alerts(req, res) {
  res.render('alerts', {
    title: 'Alerts',
    activePage: 'alerts',
    thresholds: alertService.thresholds(),
    alertCount: alertRepository.countUnacknowledged(),
  });
}

function settings(req, res) {
  const user = userRepository.findById(req.session.userId);
  const backupCodes = req.session.newBackupCodes || null;
  delete req.session.newBackupCodes;
  const credentialStatus = credentialMigrationService.getStatus();

  res.render('settings', {
    title: 'Settings',
    activePage: 'settings',
    thresholds: alertService.thresholds(),
    saved: req.query.saved || null,
    error: null,
    alertCount: alertRepository.countUnacknowledged(),
    totpEnabled: user ? user.totp_enabled : false,
    totpSetup: false,
    qrDataUrl: null,
    backupCodes,
    credentialStatus,
    secureCookie: process.env.SECURE_COOKIE === 'true',
    publicUrl: process.env.PUBLIC_URL || '',
  });
}

module.exports = { dashboard, monitoring, monitoringAll, mail, antivirus, servers, logs, alerts, settings };
