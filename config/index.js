'use strict';

/**
 * Central configuration loader.
 * Reads values from environment (populated by dotenv in server.js / scripts)
 * and exposes a typed, validated config object with sane defaults.
 */

const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse "Label:/path,Label2:/path2" into [{ label, path }].
 */
function parsePathList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1) return { label: path.basename(entry), path: entry };
      return {
        label: entry.slice(0, idx).trim(),
        path: entry.slice(idx + 1).trim(),
      };
    })
    .filter((item) => item.path);
}

const rootDir = path.resolve(__dirname, '..');

const config = {
  rootDir,
  storageDir: path.join(rootDir, 'storage'),
  logsDir: path.join(rootDir, 'logs'),
  databaseFile: path.join(rootDir, 'storage', 'monitor.db'),
  sessionStoreFile: 'sessions.db',

  port: int(process.env.PORT, 19091),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'production',
  isProduction: (process.env.NODE_ENV || 'production') === 'production',

  sessionSecret: process.env.SESSION_SECRET || 'insecure-default-change-me',
  sessionTimeoutMinutes: int(process.env.SESSION_TIMEOUT_MINUTES, 30),
  secureCookie: bool(process.env.SECURE_COOKIE, false),

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'Jakarta1412@@',
  },

  alerts: {
    cpu: int(process.env.ALERT_CPU_THRESHOLD, 90),
    ram: int(process.env.ALERT_RAM_THRESHOLD, 90),
    disk: int(process.env.ALERT_DISK_THRESHOLD, 90),
    pollSeconds: int(process.env.ALERT_POLL_SECONDS, 30),
  },

  logPaths: {
    system: parsePathList(process.env.SYSTEM_LOG_PATHS),
    error: parsePathList(process.env.ERROR_LOG_PATHS),
  },
};

module.exports = config;
