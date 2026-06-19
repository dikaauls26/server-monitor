'use strict';

const express = require('express');
const apiController = require('../controllers/apiController');
const securityController = require('../controllers/securityController');
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
router.post('/monitoring-all/control', apiController.monitoringAllControl);
router.post('/monitoring-all/connect-all', apiController.monitoringAllConnect);

router.get('/security/credentials-status', securityController.credentialsStatus);
router.post('/security/encrypt-credentials', securityController.encryptCredentials);

module.exports = router;
