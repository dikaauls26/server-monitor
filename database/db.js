'use strict';

/**
 * SQLite connection singleton (better-sqlite3).
 * The database file lives in /storage and is created on first run.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db = null;

function getDb() {
  if (db) return db;

  if (!fs.existsSync(config.storageDir)) {
    fs.mkdirSync(config.storageDir, { recursive: true });
  }

  db = new Database(config.databaseFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, closeDb, databaseFile: config.databaseFile };
