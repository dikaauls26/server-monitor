'use strict';

/**
 * Centralized 404 and error handling.
 */

function notFound(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  return res.status(404).render('error', {
    title: 'Not Found',
    status: 404,
    message: 'The page you are looking for does not exist.',
    activePage: '',
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error('[error]', err.stack || err.message || err);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({
      ok: false,
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    });
  }
  return res.status(status).render('error', {
    title: 'Error',
    status,
    message:
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong on the server.'
        : err.message,
    activePage: '',
  });
}

module.exports = { notFound, errorHandler };
