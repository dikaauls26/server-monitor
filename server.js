'use strict';

/**
 * Server Monitor — application entrypoint.
 *
 * Boot sequence:
 *   1. Load environment (.env)
 *   2. Ensure DB schema exists (auto-migrate) so first run never 500s
 *   3. Configure Express (security, sessions, views, static)
 *   4. Mount routes
 *   5. Start background alert engine
 *   6. Listen
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const compression = require('compression');

const config = require('./config');
const migrate = require('./database/migrate');
const { injectLocals } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const alertService = require('./services/alertService');

const authRoutes = require('./routes/auth');
const pageRoutes = require('./routes/pages');
const apiRoutes = require('./routes/api');

// --- Ensure runtime directories exist --------------------------------------
for (const dir of [config.storageDir, config.logsDir]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// --- Auto-migrate so the schema is always present --------------------------
try {
  migrate();
} catch (err) {
  console.error('[boot] Migration failed:', err.message);
}

const app = express();
app.disable('x-powered-by');

// Behind Nginx/PM2 we may sit behind a proxy; trust it for secure cookies & IPs.
app.set('trust proxy', 1);

// --- Views ------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Security headers (CSP allows the CDN assets we use) --------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(compression());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Static assets ----------------------------------------------------------
app.use(
  '/static',
  express.static(path.join(__dirname, 'public'), { maxAge: '7d', etag: true })
);

// --- Sessions ---------------------------------------------------------------
app.use(
  session({
    name: 'sm.sid',
    store: new SQLiteStore({
      db: config.sessionStoreFile,
      dir: config.storageDir,
      table: 'sessions',
    }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true, // refresh expiry on activity => idle timeout
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookie,
      maxAge: config.sessionTimeoutMinutes * 60 * 1000,
    },
  })
);

app.use(injectLocals);

// --- Health check (no auth) -------------------------------------------------
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --- Routes -----------------------------------------------------------------
app.use('/', authRoutes);
app.use('/api', apiRoutes);
app.use('/', pageRoutes);

// --- Errors -----------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

// --- Start ------------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  alertService.start();
  console.log('========================================');
  console.log('  Server Monitor is running');
  console.log(`  URL:  http://${config.host === '0.0.0.0' ? '<SERVER_IP>' : config.host}:${config.port}`);
  console.log(`  Env:  ${config.env}`);
  console.log('========================================');
});

function shutdown(signal) {
  console.log(`\n[${signal}] shutting down...`);
  alertService.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
