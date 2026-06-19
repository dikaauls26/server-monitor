'use strict';

/**
 * Handles Settings form submissions: change password, change port,
 * and update alert thresholds.
 */

const fs = require('fs');
const path = require('path');
const userRepository = require('../repositories/userRepository');
const settingsRepository = require('../repositories/settingsRepository');
const alertService = require('../services/alertService');
const alertRepository = require('../repositories/alertRepository');
const totpService = require('../services/totpService');
const cloudflareService = require('../services/cloudflareService');
const config = require('../config');

const ENV_PATH = path.join(config.rootDir, '.env');

function renderSettings(res, extra = {}) {
  res.render('settings', {
    title: 'Settings',
    activePage: 'settings',
    thresholds: alertService.thresholds(),
    saved: null,
    error: null,
    alertCount: alertRepository.countUnacknowledged(),
    totpEnabled: false,
    totpSetup: false,
    qrDataUrl: null,
    backupCodes: null,
    credentialStatus: { keyConfigured: false, servers: 0, plaintextSecrets: 0, encryptedSecrets: 0, fullyEncrypted: true },
    secureCookie: process.env.SECURE_COOKIE === 'true',
    publicUrl: process.env.PUBLIC_URL || '',
    cloudflare: cloudflareService.getPublicConfig(),
    ...extra,
  });
}

/**
 * Update (or insert) a single KEY=VALUE pair inside the .env file,
 * preserving other lines and comments.
 */
function updateEnvValue(key, value) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  lines = lines.map((line) => {
    if (re.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
}

function changePassword(req, res) {
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return renderSettings(res, { error: 'All password fields are required.' });
  }
  if (new_password !== confirm_password) {
    return renderSettings(res, { error: 'New password and confirmation do not match.' });
  }
  if (new_password.length < 8) {
    return renderSettings(res, { error: 'New password must be at least 8 characters.' });
  }

  const user = userRepository.verifyCredentials(req.session.username, current_password);
  if (!user) {
    return renderSettings(res, { error: 'Current password is incorrect.' });
  }

  userRepository.updatePassword(user.id, new_password);
  return res.redirect('/settings?saved=password');
}

function changePort(req, res) {
  const portNum = parseInt(req.body.port, 10);
  if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) {
    return renderSettings(res, { error: 'Port must be a number between 1 and 65535.' });
  }
  updateEnvValue('PORT', String(portNum));
  // Takes effect after a restart (pm2 restart server-monitor).
  return res.redirect('/settings?saved=port');
}

function updateThresholds(req, res) {
  const clamp = (v, def) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(100, Math.max(1, n));
  };
  const cpu = clamp(req.body.cpu, config.alerts.cpu);
  const ram = clamp(req.body.ram, config.alerts.ram);
  const disk = clamp(req.body.disk, config.alerts.disk);

  settingsRepository.set('alert_cpu_threshold', cpu);
  settingsRepository.set('alert_ram_threshold', ram);
  settingsRepository.set('alert_disk_threshold', disk);

  return res.redirect('/settings?saved=thresholds');
}

function updateCloudflare(req, res) {
  const { api_token, zone_id } = req.body || {};
  const zoneId = String(zone_id || '').trim();

  if (!api_token && !zoneId && !cloudflareService.getPublicConfig().configured) {
    return renderSettings(res, { error: 'Enter an API token or zone ID to save.' });
  }

  try {
    cloudflareService.saveConfig({
      apiToken: api_token || undefined,
      zoneId,
    });
  } catch (err) {
    return renderSettings(res, { error: err.message || 'Failed to save Cloudflare settings.' });
  }

  return res.redirect('/settings?saved=cloudflare');
}

async function setupTotp(req, res) {
  const user = userRepository.findById(req.session.userId);
  if (!user) return res.redirect('/login');
  if (user.totp_enabled) {
    return renderSettings(res, { totpEnabled: true, error: '2FA is already enabled.' });
  }

  const secret = totpService.generateSecret();
  req.session.totpSetupSecret = secret;
  const qrDataUrl = await totpService.getQrDataUrl(user.username, secret);
  return renderSettings(res, { totpEnabled: false, totpSetup: true, qrDataUrl });
}

async function enableTotp(req, res) {
  const user = userRepository.findById(req.session.userId);
  if (!user) return res.redirect('/login');

  const secret = req.session.totpSetupSecret;
  if (!secret) {
    return renderSettings(res, { totpEnabled: user.totp_enabled, error: 'Start 2FA setup first.' });
  }

  const code = (req.body.code || '').trim();
  if (!totpService.verifyToken(secret, code)) {
    const qrDataUrl = await totpService.getQrDataUrl(user.username, secret);
    return renderSettings(res, {
      totpEnabled: false,
      totpSetup: true,
      qrDataUrl,
      error: 'Invalid code. Enter the current 6-digit code from your authenticator app.',
    });
  }

  const backupCodes = totpService.generateBackupCodes();
  userRepository.enableTotp(
    user.id,
    secret,
    totpService.serializeBackupHashes(totpService.hashBackupCodes(backupCodes))
  );
  delete req.session.totpSetupSecret;
  req.session.newBackupCodes = backupCodes;
  return res.redirect('/settings?saved=2fa-enabled');
}

function disableTotp(req, res) {
  const { current_password, code } = req.body || {};
  const user = userRepository.verifyCredentials(req.session.username, current_password || '');
  if (!user) {
    return renderSettings(res, { totpEnabled: true, error: 'Current password is incorrect.' });
  }
  if (!user.totp_enabled || !user.totp_secret) {
    return renderSettings(res, { totpEnabled: false, error: '2FA is not enabled.' });
  }

  let verified = totpService.verifyToken(user.totp_secret, code);
  if (!verified) {
    const backup = totpService.verifyBackupCode(code, user.totp_backup_codes);
    verified = backup.ok;
    if (backup.ok) {
      userRepository.updateBackupCodes(
        user.id,
        totpService.serializeBackupHashes(backup.remaining)
      );
    }
  }
  if (!verified) {
    return renderSettings(res, { totpEnabled: true, error: 'Invalid authentication code.' });
  }

  userRepository.disableTotp(user.id);
  return res.redirect('/settings?saved=2fa-disabled');
}

module.exports = {
  changePassword,
  changePort,
  updateThresholds,
  updateCloudflare,
  setupTotp,
  enableTotp,
  disableTotp,
};
