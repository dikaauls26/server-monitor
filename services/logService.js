'use strict';

/**
 * Log file reader with search + download support.
 *
 * Log sources are configured via .env (SYSTEM_LOG_PATHS / ERROR_LOG_PATHS).
 * Each source is "Label:/path". For safety, only configured files can be
 * read or downloaded — arbitrary path access is rejected.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

function getSources() {
  return {
    system: config.logPaths.system,
    error: config.logPaths.error,
  };
}

function allSources() {
  return [
    ...config.logPaths.system.map((s) => ({ ...s, category: 'system' })),
    ...config.logPaths.error.map((s) => ({ ...s, category: 'error' })),
  ];
}

/**
 * Resolve a requested log (by absolute path) only if it is whitelisted.
 */
function resolveSource(requestedPath) {
  const resolved = path.resolve(requestedPath);
  return allSources().find((s) => path.resolve(s.path) === resolved) || null;
}

function fileMeta(source) {
  try {
    const st = fs.statSync(source.path);
    return { exists: true, size: st.size, modified: st.mtime.toISOString() };
  } catch (_e) {
    return { exists: false, size: 0, modified: null };
  }
}

/**
 * List all configured log sources with availability metadata.
 */
function listLogs() {
  return allSources().map((s) => ({
    label: s.label,
    path: s.path,
    category: s.category,
    ...fileMeta(s),
  }));
}

/**
 * Read the tail of a log file (last N lines), optionally filtered by `search`.
 * Reads at most `maxBytes` from the end of the file to stay memory-safe.
 */
function readLog(requestedPath, { lines = 300, search = '', maxBytes = 1024 * 512 } = {}) {
  const source = resolveSource(requestedPath);
  if (!source) {
    return { ok: false, error: 'Log source not allowed or not found.' };
  }
  const meta = fileMeta(source);
  if (!meta.exists) {
    return { ok: false, error: 'Log file does not exist on this server.', label: source.label, path: source.path };
  }

  let content = '';
  try {
    const fd = fs.openSync(source.path, 'r');
    const start = Math.max(0, meta.size - maxBytes);
    const length = meta.size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    content = buffer.toString('utf8');
    if (start > 0) {
      // Drop the first (likely partial) line.
      content = content.slice(content.indexOf('\n') + 1);
    }
  } catch (err) {
    return { ok: false, error: `Unable to read log: ${err.message}`, label: source.label };
  }

  let logLines = content.split('\n');
  if (search && search.trim()) {
    const q = search.trim().toLowerCase();
    logLines = logLines.filter((l) => l.toLowerCase().includes(q));
  }
  logLines = logLines.filter((l) => l.length > 0).slice(-lines);

  return {
    ok: true,
    label: source.label,
    path: source.path,
    category: source.category,
    size: meta.size,
    modified: meta.modified,
    matched: logLines.length,
    search: search || '',
    lines: logLines,
  };
}

/**
 * Return a readable stream + filename for download, or null if not allowed.
 */
function getDownloadStream(requestedPath) {
  const source = resolveSource(requestedPath);
  if (!source) return null;
  if (!fs.existsSync(source.path)) return null;
  return {
    filename: `${source.label.replace(/[^a-z0-9_-]+/gi, '_')}.log`,
    stream: fs.createReadStream(source.path),
  };
}

module.exports = { getSources, listLogs, readLog, getDownloadStream, resolveSource };
