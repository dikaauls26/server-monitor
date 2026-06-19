'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { generateSecret, verifySync, generateURI } = require('otplib');
const QRCode = require('qrcode');

const BACKUP_CODE_COUNT = 8;
const BACKUP_SALT_ROUNDS = 10;

function createSecret() {
  return generateSecret();
}

function verifyToken(secret, token) {
  if (!secret || !token) return false;
  const code = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const result = verifySync({ secret, token: code, epochTolerance: 1 });
  return !!(result && result.valid);
}

async function getQrDataUrl(username, secret) {
  const otpauth = generateURI({
    issuer: 'ServerMonitor',
    label: username || 'admin',
    secret,
  });
  return QRCode.toDataURL(otpauth, { width: 220, margin: 1 });
}

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i += 1) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

function hashBackupCodes(codes) {
  return codes.map((code) => bcrypt.hashSync(code, BACKUP_SALT_ROUNDS));
}

function serializeBackupHashes(hashes) {
  return JSON.stringify(hashes || []);
}

function parseBackupHashes(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function verifyBackupCode(plainCode, storedRaw) {
  const code = String(plainCode || '').replace(/\s/g, '').toUpperCase();
  if (!code) return { ok: false };
  const hashes = parseBackupHashes(storedRaw);
  for (let i = 0; i < hashes.length; i += 1) {
    if (bcrypt.compareSync(code, hashes[i])) {
      return { ok: true, index: i, remaining: hashes.filter((_, idx) => idx !== i) };
    }
  }
  return { ok: false };
}

module.exports = {
  generateSecret: createSecret,
  verifyToken,
  getQrDataUrl,
  generateBackupCodes,
  hashBackupCodes,
  serializeBackupHashes,
  parseBackupHashes,
  verifyBackupCode,
};
