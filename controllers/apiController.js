'use strict';

/**
 * JSON API endpoints consumed by the front-end for realtime updates.
 */

const systemService = require('../services/systemService');
const serviceMonitorService = require('../services/serviceMonitorService');
const mailService = require('../services/mailService');
const logService = require('../services/logService');
const alertRepository = require('../repositories/alertRepository');

async function overview(req, res, next) {
  try {
    const [system, alertsCount] = await Promise.all([
      systemService.getOverview(),
      Promise.resolve(alertRepository.countUnacknowledged()),
    ]);
    res.json({ ok: true, data: { ...system, alertCount: alertsCount } });
  } catch (err) {
    next(err);
  }
}

async function services(req, res, next) {
  try {
    const data = await serviceMonitorService.getAll();
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

async function mail(req, res, next) {
  try {
    const data = await mailService.getAll();
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

function logs(req, res, next) {
  try {
    const { path: logPath, search, lines } = req.query;
    if (!logPath) {
      return res.json({ ok: true, data: { sources: logService.listLogs() } });
    }
    const result = logService.readLog(logPath, {
      search: search || '',
      lines: Math.min(parseInt(lines, 10) || 300, 2000),
    });
    res.json({ ok: result.ok, data: result });
  } catch (err) {
    next(err);
  }
}

function downloadLog(req, res, next) {
  try {
    const { path: logPath } = req.query;
    const dl = logService.getDownloadStream(logPath || '');
    if (!dl) {
      return res.status(404).json({ ok: false, error: 'Log not found or not allowed.' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${dl.filename}"`);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    dl.stream.on('error', () => res.end());
    dl.stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

function listAlerts(req, res, next) {
  try {
    const alerts = alertRepository.list({ limit: 200 });
    res.json({
      ok: true,
      data: { alerts, unacknowledged: alertRepository.countUnacknowledged() },
    });
  } catch (err) {
    next(err);
  }
}

function acknowledgeAlert(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isFinite(id)) alertRepository.acknowledge(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

function acknowledgeAllAlerts(req, res, next) {
  try {
    alertRepository.acknowledgeAll();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

function clearAlerts(req, res, next) {
  try {
    alertRepository.clearAll();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  overview,
  services,
  mail,
  logs,
  downloadLog,
  listAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  clearAlerts,
};
