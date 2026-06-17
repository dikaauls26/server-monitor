'use strict';

const express = require('express');
const apiController = require('../controllers/apiController');
const { requireApiAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireApiAuth);

router.get('/overview', apiController.overview);
router.get('/services', apiController.services);
router.get('/mail', apiController.mail);
router.get('/logs', apiController.logs);
router.get('/logs/download', apiController.downloadLog);

router.get('/alerts', apiController.listAlerts);
router.post('/alerts/ack-all', apiController.acknowledgeAllAlerts);
router.post('/alerts/clear', apiController.clearAlerts);
router.post('/alerts/:id/ack', apiController.acknowledgeAlert);

module.exports = router;
