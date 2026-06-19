'use strict';

/**
 * JSON API endpoints consumed by the front-end for realtime updates.
 */

const systemService = require('../services/systemService');
const serviceMonitorService = require('../services/serviceMonitorService');
const mailService = require('../services/mailService');
const logService = require('../services/logService');
const controlService = require('../services/controlService');
const alertRepository = require('../repositories/alertRepository');
const antivirusService = require('../services/antivirusService');
const sshService = require('../services/sshService');
const remoteSystemService = require('../services/remoteSystemService');
const serverRepository = require('../repositories/serverRepository');
const monitoringAllService = require('../services/monitoringAllService');
const domainMonitorService = require('../services/domainMonitorService');

async function overview(req, res, next) {
  try {
    const serverId = req.query.serverId;
    if (serverId && serverId !== 'local') {
      const id = parseInt(serverId, 10);
      if (!Number.isFinite(id) || !serverRepository.getById(id)) {
        return res.status(404).json({ ok: false, error: 'Server not found.' });
      }
      const remote = await remoteSystemService.getOverview(id);
      if (!remote.ok) {
        return res.status(502).json({ ok: false, error: remote.error });
      }
      const alertsCount = alertRepository.countUnacknowledged();
      return res.json({ ok: true, data: { ...remote.data, alertCount: alertsCount } });
    }

    const [system, alertsCount] = await Promise.all([
      systemService.getOverview(),
      Promise.resolve(alertRepository.countUnacknowledged()),
    ]);
    res.json({ ok: true, data: { ...system, alertCount: alertsCount, remote: false } });
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

async function clearMailDeferred(req, res, next) {
  try {
    const result = await mailService.clearDeferred();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function clearMailPending(req, res, next) {
  try {
    const result = await mailService.clearPending();
    res.status(result.ok ? 200 : 400).json(result);
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

async function controlServiceAction(req, res, next) {
  try {
    const { service, action } = req.body || {};
    const result = await controlService.controlService(service, action);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

function rebootServer(req, res, next) {
  try {
    const result = controlService.rebootSystem();
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

function antivirusQueue(req, res, next) {
  try {
    res.json({ ok: true, data: antivirusService.getQueueStatus() });
  } catch (err) {
    next(err);
  }
}

function antivirusScan(req, res, next) {
  try {
    const { scanner, path: scanPath } = req.body || {};
    const result = antivirusService.enqueue(scanner, scanPath);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

function listServers(req, res, next) {
  try {
    res.json({ ok: true, data: sshService.listStatuses() });
  } catch (err) {
    next(err);
  }
}

async function createServer(req, res, next) {
  try {
    const { name, host, port, username, password, privateKey, autoConnect } = req.body || {};
    if (!name || !host || !username) {
      return res.status(400).json({ ok: false, error: 'Name, host and username are required.' });
    }
    if (!password && !privateKey) {
      return res.status(400).json({ ok: false, error: 'Password or private key is required.' });
    }
    const server = serverRepository.create({
      name,
      host,
      port: parseInt(port, 10) || 22,
      username,
      password: password || null,
      privateKey: privateKey || null,
      autoConnect: Boolean(autoConnect),
    });
    if (server.autoConnect) {
      await sshService.connectServer(server.id);
    }
    res.json({ ok: true, data: server });
  } catch (err) {
    next(err);
  }
}

async function connectServer(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id.' });
    const result = await sshService.connectServer(id);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

function disconnectServer(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id.' });
    const result = sshService.disconnectServer(id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

function deleteServer(req, res, next) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Invalid id.' });
    sshService.disconnectServer(id);
    const ok = serverRepository.remove(id);
    res.json({ ok, message: ok ? 'Server removed.' : 'Server not found.' });
  } catch (err) {
    next(err);
  }
}

async function monitoringAll(req, res, next) {
  try {
    const data = await monitoringAllService.getAll();
    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
}

async function monitoringAllControl(req, res, next) {
  try {
    const { targets, service, action, serverId } = req.body || {};
    let targetList = targets;
    if (serverId != null && serverId !== '') {
      targetList = [serverId];
    }
    const result = await monitoringAllService.controlBulk({ targets: targetList || 'all', service, action });
    res.status(result.ok ? 200 : 207).json(result);
  } catch (err) {
    next(err);
  }
}

async function monitoringAllConnect(req, res, next) {
  try {
    const result = await monitoringAllService.connectAll();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function monitoringAllServerCron(req, res, next) {
  try {
    const result = await monitoringAllService.getCron(req.params.serverId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function monitoringAllServerMail(req, res, next) {
  try {
    const result = await monitoringAllService.getMail(req.params.serverId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function monitoringAllServerMailClearDeferred(req, res, next) {
  try {
    const result = await monitoringAllService.clearMailDeferred(req.params.serverId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function monitoringAllServerMailClearPending(req, res, next) {
  try {
    const result = await monitoringAllService.clearMailPending(req.params.serverId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function monitoringAllServerReboot(req, res, next) {
  try {
    const result = await monitoringAllService.reboot(req.params.serverId);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function domainsList(req, res, next) {
  try {
    const checkHttp = req.query.check !== '0';
    const result = await domainMonitorService.list(req.query.serverId || 'local', { checkHttp });
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

async function domainsDelete(req, res, next) {
  try {
    const { serverId, domain, type } = req.body || {};
    if (!domain) {
      return res.status(400).json({ ok: false, error: 'Domain is required.' });
    }
    const result = await domainMonitorService.remove(serverId || 'local', domain, type);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  overview,
  services,
  mail,
  clearMailDeferred,
  clearMailPending,
  logs,
  downloadLog,
  listAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  clearAlerts,
  controlServiceAction,
  rebootServer,
  antivirusQueue,
  antivirusScan,
  listServers,
  createServer,
  connectServer,
  disconnectServer,
  deleteServer,
  monitoringAll,
  monitoringAllControl,
  monitoringAllConnect,
  monitoringAllServerCron,
  monitoringAllServerMail,
  monitoringAllServerMailClearDeferred,
  monitoringAllServerMailClearPending,
  monitoringAllServerReboot,
  domainsList,
  domainsDelete,
};
