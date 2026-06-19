'use strict';

const crypto = require('crypto');

function ensureCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function injectCsrf(req, res, next) {
  if (req.session) {
    res.locals.csrfToken = ensureCsrfToken(req);
  }
  next();
}

function tokensMatch(expected, provided) {
  if (!expected || !provided || typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

function readSubmittedToken(req) {
  if (req.body && req.body._csrf) return String(req.body._csrf);
  if (req.headers['x-csrf-token']) return String(req.headers['x-csrf-token']);
  if (req.headers['xsrf-token']) return String(req.headers['xsrf-token']);
  return '';
}

function csrfProtect(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();

  const expected = req.session ? req.session.csrfToken : null;
  const submitted = readSubmittedToken(req);

  if (tokensMatch(expected, submitted)) return next();

  if (req.path.startsWith('/api') || req.originalUrl.startsWith('/api')) {
    return res.status(403).json({ ok: false, error: 'Invalid or missing CSRF token. Refresh the page.' });
  }

  return res.status(403).send('Invalid or missing CSRF token. Please refresh and try again.');
}

function rotateCsrfToken(req) {
  if (!req.session) return null;
  req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

module.exports = {
  ensureCsrfToken,
  injectCsrf,
  csrfProtect,
  rotateCsrfToken,
};
