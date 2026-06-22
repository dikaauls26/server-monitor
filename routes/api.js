'use strict';

const express = require('express');
const apiController = require('../controllers/apiController');
const securityController = require('../controllers/securityController');
const backupController = require('../controllers/backupController');
const serverBackupController = require('../controllers/serverBackupController');
const { requireApiAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireApiAuth);

router.get('/overview', apiController.overview);
router.get('/services', apiController.services);
router.get('/mail', apiController.mail);
router.post('/mail/clear-deferred', apiController.clearMailDeferred);
router.post('/mail/clear-pending', apiController.clearMailPending);
router.get('/logs', apiController.logs);
router.get('/logs/download', apiController.downloadLog);

router.get('/alerts', apiController.listAlerts);
router.post('/alerts/ack-all', apiController.acknowledgeAllAlerts);
router.post('/alerts/clear', apiController.clearAlerts);
router.post('/alerts/:id/ack', apiController.acknowledgeAlert);

// Service control (start/stop/restart) and system reboot.
router.post('/control/service', apiController.controlServiceAction);
router.post('/control/reboot', apiController.rebootServer);

router.get('/antivirus/queue', apiController.antivirusQueue);
router.post('/antivirus/scan', apiController.antivirusScan);

router.get('/servers', apiController.listServers);
router.post('/servers', apiController.createServer);
router.post('/servers/:id/connect', apiController.connectServer);
router.post('/servers/:id/disconnect', apiController.disconnectServer);
router.delete('/servers/:id', apiController.deleteServer);

router.get('/monitoring-all', apiController.monitoringAll);
router.get('/monitoring-all/server/:serverId/cron', apiController.monitoringAllServerCron);
router.get('/monitoring-all/server/:serverId/mail', apiController.monitoringAllServerMail);
router.post('/monitoring-all/server/:serverId/mail/clear-deferred', apiController.monitoringAllServerMailClearDeferred);
router.post('/monitoring-all/server/:serverId/mail/clear-pending', apiController.monitoringAllServerMailClearPending);
router.post('/monitoring-all/server/:serverId/reboot', apiController.monitoringAllServerReboot);
router.post('/monitoring-all/server/:serverId/exec', apiController.monitoringAllServerExec);
router.post('/monitoring-all/control', apiController.monitoringAllControl);
router.post('/monitoring-all/connect-all', apiController.monitoringAllConnect);

router.get('/monitoring-all/server/:serverId/backups', serverBackupController.listServerImages);
router.post('/monitoring-all/server/:serverId/backup', serverBackupController.queueServerBackup);
router.post('/monitoring-all/server/:serverId/restore', serverBackupController.queueServerRestore);
router.get('/monitoring-all/server/:serverId/backups/:filename/download', serverBackupController.downloadServerImage);
router.delete('/monitoring-all/server/:serverId/backups/:filename', serverBackupController.deleteServerImage);
router.get('/monitoring-all/backup-queue', serverBackupController.backupQueueStatus);

router.get('/domains', apiController.domainsList);
router.post('/domains/delete', apiController.domainsDelete);
router.post('/domains/delete-queue', apiController.domainsDeleteQueue);
router.get('/domains/delete-queue', apiController.domainsDeleteQueueStatus);

router.get('/cloudflare/status', apiController.cloudflareStatus);
router.post('/cloudflare/test', apiController.cloudflareTest);

router.get('/security/credentials-status', securityController.credentialsStatus);
router.post('/security/encrypt-credentials', securityController.encryptCredentials);

router.get('/backup', backupController.listBackups);
router.post('/backup/create', backupController.createBackup);
router.get('/backup/:id/download', backupController.downloadBackup);
router.post('/backup/:id/restore', backupController.restoreBackup);
router.delete('/backup/:id', backupController.deleteBackup);

module.exports = router;
