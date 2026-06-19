'use strict';

const userRepository = require('../repositories/userRepository');
const { rotateCsrfToken } = require('../middleware/csrf');

const PENDING_2FA_MS = 5 * 60 * 1000;

function showLogin(req, res) {
  res.render('login', {
    title: 'Sign in',
    error: null,
    username: '',
    expired: req.query.expired === '1',
    layout: false,
  });
}

function showLogin2fa(req, res) {
  const pending = req.session && req.session.pending2FA;
  if (!pending || !pending.userId) {
    return res.redirect('/login');
  }
  if (Date.now() - pending.startedAt > PENDING_2FA_MS) {
    delete req.session.pending2FA;
    return res.redirect('/login?expired=1');
  }
  res.render('login-2fa', {
    title: 'Two-factor authentication',
    error: null,
    username: pending.username,
    layout: false,
  });
}

function completeLogin(req, res, user) {
  req.session.regenerate((err) => {
    if (err) {
      return res.status(500).render('login', {
        title: 'Sign in',
        error: 'Could not start a session. Please try again.',
        username: user.username,
        layout: false,
      });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.lastActivity = Date.now();
    rotateCsrfToken(req);
    delete req.session.pending2FA;
    delete req.session.totpSetupSecret;
    res.redirect('/');
  });
}

function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).render('login', {
      title: 'Sign in',
      error: 'Please enter both username and password.',
      username: username || '',
      layout: false,
    });
  }

  const user = userRepository.verifyCredentials(username.trim(), password);
  if (!user) {
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Invalid username or password.',
      username: username.trim(),
      layout: false,
    });
  }

  if (user.totp_enabled && user.totp_secret) {
    req.session.pending2FA = {
      userId: user.id,
      username: user.username,
      startedAt: Date.now(),
    };
    return res.redirect('/login/2fa');
  }

  return completeLogin(req, res, user);
}

function login2fa(req, res) {
  const pending = req.session && req.session.pending2FA;
  if (!pending || !pending.userId) {
    return res.redirect('/login');
  }
  if (Date.now() - pending.startedAt > PENDING_2FA_MS) {
    delete req.session.pending2FA;
    return res.redirect('/login?expired=1');
  }

  const user = userRepository.findById(pending.userId);
  if (!user || !user.totp_enabled || !user.totp_secret) {
    delete req.session.pending2FA;
    return res.redirect('/login');
  }

  const code = (req.body.code || '').trim();
  if (!code) {
    return res.status(400).render('login-2fa', {
      title: 'Two-factor authentication',
      error: 'Enter the 6-digit code from your authenticator app.',
      username: user.username,
      layout: false,
    });
  }

  let verified = totpService.verifyToken(user.totp_secret, code);
  if (!verified) {
    const backup = totpService.verifyBackupCode(code, user.totp_backup_codes);
    if (backup.ok) {
      verified = true;
      userRepository.updateBackupCodes(
        user.id,
        totpService.serializeBackupHashes(backup.remaining)
      );
    }
  }

  if (!verified) {
    return res.status(401).render('login-2fa', {
      title: 'Two-factor authentication',
      error: 'Invalid authentication code.',
      username: user.username,
      layout: false,
    });
  }

  return completeLogin(req, res, user);
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie('sm.sid');
    res.redirect('/login');
  });
}

module.exports = { showLogin, showLogin2fa, login, login2fa, logout };
