'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');
const { redirectIfAuthed } = require('../middleware/auth');

const router = express.Router();

// Throttle brute-force login attempts.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again later.',
});

router.get('/login', redirectIfAuthed, authController.showLogin);
router.post('/login', loginLimiter, redirectIfAuthed, authController.login);
router.get('/login/2fa', authController.showLogin2fa);
router.post('/login/2fa', loginLimiter, authController.login2fa);
router.get('/logout', authController.logout);
router.post('/logout', authController.logout);

module.exports = router;
