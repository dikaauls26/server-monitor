'use strict';

/**
 * Authentication & session guard middleware.
 */

/**
 * For page routes: redirect unauthenticated users to the login page.
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.redirect('/login');
}

/**
 * For API routes: respond 401 JSON instead of redirecting.
 */
function requireApiAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

/**
 * Redirect already-authenticated users away from the login page.
 */
function redirectIfAuthed(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  return next();
}

/**
 * Expose the current user + a few flags to all views.
 */
function injectLocals(req, res, next) {
  res.locals.currentUser = req.session && req.session.username ? { username: req.session.username } : null;
  res.locals.isAuthenticated = !!(req.session && req.session.userId);
  res.locals.activePage = '';
  res.locals.assetVersion = res.app.locals.assetVersion || '1';
  next();
}

module.exports = { requireAuth, requireApiAuth, redirectIfAuthed, injectLocals };
