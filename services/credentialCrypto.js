'use strict';

/**
 * AES-256-GCM encryption for SSH credentials at rest in SQLite.
 * Uses ENCRYPTION_KEY from .env (falls back to SESSION_SECRET).
 */

const crypto = require('crypto');
const config = require('../config');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function deriveKey() {
  const source = config.encryptionKey || config.sessionSecret;
  return crypto.createHash('sha256').update(String(source)).digest();
}

function isConfigured() {
  const key = config.encryptionKey;
  if (key && key !== 'change_me_encryption_key') return true;
  return config.sessionSecret !== 'insecure-default-change-me';
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  if (!isConfigured()) {
    throw new Error('ENCRYPTION_KEY is not configured.');
  }
  if (isEncrypted(plaintext)) return plaintext;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  if (!isEncrypted(stored)) return stored;

  const body = stored.slice(PREFIX.length);
  const parts = body.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credential format.');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    ALGO,
    deriveKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = {
  isConfigured,
  isEncrypted,
  encrypt,
  decrypt,
};
