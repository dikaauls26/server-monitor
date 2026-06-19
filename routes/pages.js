'use strict';

const express = require('express');
const pageController = require('../controllers/pageController');
const settingsController = require('../controllers/settingsController');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', pageController.dashboard);
router.get('/dashboard', pageController.dashboard);
router.get('/monitoring', pageController.monitoring);
router.get('/mail', pageController.mail);
router.get('/antivirus', pageController.antivirus);
router.get('/servers', pageController.servers);
router.get('/logs', pageController.logs);
router.get('/alerts', pageController.alerts);
router.get('/settings', pageController.settings);

// Settings form actions
router.post('/settings/password', settingsController.changePassword);
router.post('/settings/port', settingsController.changePort);
router.post('/settings/thresholds', settingsController.updateThresholds);

module.exports = router;
