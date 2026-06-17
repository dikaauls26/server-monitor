/* Server Monitor — front-end realtime controller */
(function () {
  'use strict';

  // ---------- Helpers ----------
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }

  function fmtBytes(bytes, perSec) {
    if (bytes == null || isNaN(bytes)) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    var i = 0; var n = Number(bytes);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i] + (perSec ? '/s' : '');
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setBar(el, pct) {
    if (!el) return;
    var v = Math.max(0, Math.min(100, pct || 0));
    el.style.width = v + '%';
    el.classList.remove('bg-danger');
    if (v >= 90) el.classList.add('bg-danger');
  }

  function fetchJSON(url, opts) {
    return fetch(url, Object.assign({ headers: { 'Accept': 'application/json' }, credentials: 'same-origin' }, opts || {}))
      .then(function (r) {
        if (r.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
        return r.json();
      });
  }

  function markLive(ok) {
    var el = $('#smLive');
    if (!el) return;
    el.classList.toggle('stale', !ok);
  }

  // ---------- Sidebar (mobile) ----------
  (function sidebar() {
    var toggle = $('#smMenuToggle');
    var sb = $('#smSidebar');
    var backdrop = $('#smBackdrop');
    if (!toggle || !sb) return;
    function open() { sb.classList.add('open'); if (backdrop) backdrop.classList.add('show'); }
    function close() { sb.classList.remove('open'); if (backdrop) backdrop.classList.remove('show'); }
    toggle.addEventListener('click', function () {
      sb.classList.contains('open') ? close() : open();
    });
    if (backdrop) backdrop.addEventListener('click', close);
  })();

  // ---------- Polling manager ----------
  function poller(fn, intervalMs) {
    var stopped = false;
    function tick() {
      if (stopped) return;
      Promise.resolve(fn()).catch(function () {}).then(function () {
        if (!stopped) setTimeout(tick, intervalMs);
      });
    }
    tick();
    document.addEventListener('visibilitychange', function () {
      // pause work when tab hidden is implicit (timers slow), nothing needed
    });
    return function () { stopped = true; };
  }

  function pill(status) {
    var s = String(status || 'unknown').toLowerCase();
    var label = status || 'unknown';
    return '<span class="sm-pill ' + esc(s) + '"><span class="dot"></span>' + esc(label) + '</span>';
  }

  // ===================================================================
  // DASHBOARD
  // ===================================================================
  function initDashboard() {
    var usageChart, netChart;
    var MAX_POINTS = 30;
    var labels = [], cpuData = [], ramData = [], rxData = [], txData = [];

    if (window.Chart) {
      Chart.defaults.color = '#8a95ad';
      Chart.defaults.borderColor = '#232c41';
      var uctx = $('#usageChart');
      if (uctx) {
        usageChart = new Chart(uctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              { label: 'CPU %', data: cpuData, borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,.15)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
              { label: 'RAM %', data: ramData, borderColor: '#2ecc71', backgroundColor: 'rgba(46,204,113,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: { y: { min: 0, max: 100, ticks: { stepSize: 25 } }, x: { display: false } },
            plugins: { legend: { display: true, labels: { boxWidth: 12 } } }
          }
        });
      }
      var nctx = $('#netChart');
      if (nctx) {
        netChart = new Chart(nctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              { label: 'RX', data: rxData, borderColor: '#36c5f0', backgroundColor: 'rgba(54,197,240,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 },
              { label: 'TX', data: txData, borderColor: '#2ecc71', backgroundColor: 'rgba(46,204,113,.12)', fill: true, tension: .35, pointRadius: 0, borderWidth: 2 }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: { y: { beginAtZero: true, ticks: { callback: function (v) { return fmtBytes(v, true); } } }, x: { display: false } },
            plugins: { legend: { display: false } }
          }
        });
      }
    }

    function update(d) {
      // Cards
      $('#cpuValue').textContent = d.cpu.usage.toFixed(1);
      setBar($('#cpuBar'), d.cpu.usage);
      $('#cpuSub').textContent = d.cpu.cores + ' cores' + (d.cpu.temperature ? ' · ' + d.cpu.temperature + '°C' : '');

      $('#ramValue').textContent = d.memory.usage.toFixed(1);
      setBar($('#ramBar'), d.memory.usage);
      $('#ramSub').textContent = fmtBytes(d.memory.used) + ' / ' + fmtBytes(d.memory.total);

      $('#diskValue').textContent = (d.disk.usage || 0).toFixed(1);
      setBar($('#diskBar'), d.disk.usage);
      if (d.disk.primary) $('#diskSub').textContent = fmtBytes(d.disk.primary.used) + ' / ' + fmtBytes(d.disk.primary.size);

      $('#loadValue').textContent = d.load.one.toFixed(2);
      setBar($('#loadBar'), d.load.percent);
      $('#loadSub').textContent = d.load.one + ' / ' + d.load.five + ' / ' + d.load.fifteen;

      // Network
      $('#netRx').textContent = fmtBytes(d.network.rxSec, true);
      $('#netTx').textContent = fmtBytes(d.network.txSec, true);
      $('#netRxTotal').textContent = fmtBytes(d.network.rxBytes);
      $('#netTxTotal').textContent = fmtBytes(d.network.txBytes);

      // OS info
      $('#osHostname').textContent = d.os.hostname || '—';
      $('#osDistro').textContent = ((d.os.distro || '') + ' ' + (d.os.release || '')).trim() || d.os.platform || '—';
      $('#osKernel').textContent = d.os.kernel || '—';
      $('#osArch').textContent = d.os.arch || '—';
      $('#cpuBrand').textContent = d.cpu.brand || '—';
      $('#osNode').textContent = d.os.nodeVersion || '—';
      $('#osUptime').textContent = d.uptime.human || '—';
      var hostEl = $('#smHostname'); if (hostEl) hostEl.textContent = d.os.hostname || '';

      // Filesystems
      var fsBody = $('#fsBody');
      if (fsBody) {
        if (!d.disk.filesystems.length) {
          fsBody.innerHTML = '<tr><td colspan="4" class="text-secondary text-center">No filesystem data</td></tr>';
        } else {
          fsBody.innerHTML = d.disk.filesystems.slice(0, 8).map(function (f) {
            var danger = f.usage >= 90 ? ' bg-danger' : (f.usage >= 75 ? ' bg-warning' : ' bg-info');
            return '<tr><td>' + esc(f.mount) + '</td><td>' + fmtBytes(f.used) + '</td><td>' + fmtBytes(f.size) +
              '</td><td><div class="d-flex align-items-center gap-2"><div class="progress sm-progress flex-grow-1 mb-0"><div class="progress-bar' + danger + '" style="width:' + f.usage + '%"></div></div><span class="small">' + f.usage + '%</span></div></td></tr>';
          }).join('');
        }
      }

      // Charts
      var t = new Date(d.timestamp).toLocaleTimeString();
      labels.push(t); cpuData.push(d.cpu.usage); ramData.push(d.memory.usage);
      rxData.push(d.network.rxSec); txData.push(d.network.txSec);
      if (labels.length > MAX_POINTS) { labels.shift(); cpuData.shift(); ramData.shift(); rxData.shift(); txData.shift(); }
      if (usageChart) usageChart.update();
      if (netChart) netChart.update();

      // Alert badge
      var badge = $('#sidebarAlertBadge');
      if (badge) {
        if (d.alertCount > 0) { badge.textContent = d.alertCount; badge.classList.remove('d-none'); }
        else badge.classList.add('d-none');
      }
    }

    poller(function () {
      return fetchJSON('/api/overview').then(function (res) {
        if (res.ok) { update(res.data); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    }, 3000);
  }

  // ===================================================================
  // MONITORING
  // ===================================================================
  function initMonitoring() {
    var icons = { node: 'bi-node-plus', mysql: 'bi-database', redis: 'bi-database-fill', nginx: 'bi-hdd-rack', openlitespeed: 'bi-lightning-charge', lscpd: 'bi-shield-lock', postfix: 'bi-envelope' };

    function statusPill(s) {
      if (s.status === 'not-installed' || s.installed === false) {
        return '<span class="sm-pill not-installed"><span class="dot"></span>not installed</span>';
      }
      return pill(s.status);
    }

    function ctlButtons(s) {
      if (!s.controllable) return '';
      return '<div class="btn-group btn-group-sm sm-ctl">' +
        '<button class="btn btn-outline-success" data-ctl="start" data-svc="' + s.key + '" title="Start"><i class="bi bi-play-fill"></i></button>' +
        '<button class="btn btn-outline-primary" data-ctl="restart" data-svc="' + s.key + '" title="Restart"><i class="bi bi-arrow-clockwise"></i></button>' +
        '<button class="btn btn-outline-danger" data-ctl="stop" data-svc="' + s.key + '" title="Stop"><i class="bi bi-stop-fill"></i></button>' +
        '</div>';
    }

    function showResult(ok, msg) {
      var el = $('#actionResult');
      if (!el) return;
      el.className = 'alert py-2 mb-3 ' + (ok ? 'alert-success' : 'alert-danger');
      el.innerHTML = '<i class="bi ' + (ok ? 'bi-check-circle' : 'bi-exclamation-triangle') + ' me-1"></i>' + esc(msg);
      el.classList.remove('d-none');
    }

    function render(d) {
      var grid = $('#serviceGrid');
      if (grid) {
        grid.innerHTML = d.services.map(function (s) {
          var icon = icons[s.key] || 'bi-gear';
          return '<div class="col-12 col-md-6 col-xl-4"><div class="sm-service">' +
            '<span class="name"><i class="bi ' + icon + '"></i>' + esc(s.label) + '</span>' +
            '<span class="d-flex align-items-center gap-2">' + statusPill(s) + ctlButtons(s) + '</span>' +
            '</div></div>';
        }).join('');
      }
      $('#svcUpdated').textContent = 'Updated ' + new Date(d.timestamp).toLocaleTimeString();

      var summary = $('#pm2Summary');
      var body = $('#pm2Body');
      if (!d.pm2.installed) {
        if (summary) summary.textContent = 'PM2 not installed';
        if (body) body.innerHTML = '<tr><td colspan="7" class="text-secondary text-center">PM2 is not installed on this server.</td></tr>';
        return;
      }
      if (summary) summary.textContent = d.pm2.online + ' / ' + d.pm2.total + ' online';
      if (body) {
        if (!d.pm2.apps.length) {
          body.innerHTML = '<tr><td colspan="7" class="text-secondary text-center">No PM2 processes running.</td></tr>';
        } else {
          body.innerHTML = d.pm2.apps.map(function (a) {
            var up = a.uptime ? Math.max(0, Math.round((Date.now() - a.uptime) / 60000)) + 'm' : '—';
            return '<tr><td>' + esc(a.name) + '</td><td>' + pill(a.status) + '</td><td>' + (a.pid || '—') +
              '</td><td>' + (a.cpu != null ? a.cpu + '%' : '—') + '</td><td>' + fmtBytes(a.memory) +
              '</td><td>' + (a.restarts || 0) + '</td><td>' + up + '</td></tr>';
          }).join('');
        }
      }
    }

    function refresh() {
      return fetchJSON('/api/services').then(function (res) {
        if (res.ok) { render(res.data); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    }

    function runControl(svc, action, btn) {
      if ((action === 'stop') && !confirm('Stop ' + svc + '? This service will go offline.')) return;
      var original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
      $('#actionResult') && $('#actionResult').classList.add('d-none');
      fetchJSON('/api/control/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ service: svc, action: action })
      }).then(function (res) {
        showResult(res.ok, res.message || res.error || 'Done.');
      }).catch(function () {
        showResult(false, 'Request failed.');
      }).then(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
        setTimeout(refresh, 800);
      });
    }

    function runReboot(btn) {
      if (!confirm('Reboot the ENTIRE server now? All services and this dashboard will go down for a while.')) return;
      var original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Rebooting…'; }
      fetchJSON('/api/control/reboot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      }).then(function (res) {
        showResult(res.ok, res.message || res.error || 'Reboot issued.');
      }).catch(function () {
        showResult(true, 'Reboot issued (connection closed).');
      });
    }

    document.addEventListener('click', function (e) {
      var ctlBtn = e.target.closest ? e.target.closest('[data-ctl]') : null;
      if (ctlBtn) {
        e.preventDefault();
        runControl(ctlBtn.getAttribute('data-svc'), ctlBtn.getAttribute('data-ctl'), ctlBtn);
        return;
      }
      var rb = e.target.closest ? e.target.closest('[data-reboot]') : null;
      if (rb) { e.preventDefault(); runReboot(rb); }
    });

    poller(refresh, 5000);
  }

  // ===================================================================
  // MAIL
  // ===================================================================
  function initMail() {
    function render(d) {
      var q = d.queue.stats || {};
      $('#mailTotal').textContent = q.total || 0;
      $('#mailDeferred').textContent = q.deferred || 0;
      $('#mailActive').textContent = q.active || 0;
      $('#mailFailed').textContent = q.failed || 0;

      var smtp = d.smtp || {};
      $('#smtpPostfix').innerHTML = pill(smtp.postfix);
      $('#smtpPort25').innerHTML = pill(smtp.port25);
      $('#smtpPort587').innerHTML = pill(smtp.port587);

      var raw = $('#mailRaw');
      if (raw) {
        if (!d.queue.available) raw.textContent = d.queue.reason || 'Mail queue not available.';
        else raw.textContent = d.queue.raw && d.queue.raw.trim() ? d.queue.raw : 'Mail queue is empty.';
      }
    }
    poller(function () {
      return fetchJSON('/api/mail').then(function (res) {
        if (res.ok) { render(res.data); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    }, 8000);
  }

  // ===================================================================
  // LOGS
  // ===================================================================
  function initLogs() {
    var select = $('#logSelect'), search = $('#logSearch'), view = $('#logView'), meta = $('#logMeta');
    var refreshBtn = $('#logRefresh'), downloadBtn = $('#logDownload');

    function currentPath() { return select && select.value ? select.value : ''; }

    function load() {
      var p = currentPath();
      if (!p) { view.textContent = 'No log source selected.'; meta.textContent = ''; return Promise.resolve(); }
      var url = '/api/logs?path=' + encodeURIComponent(p) + '&search=' + encodeURIComponent(search.value || '') + '&lines=500';
      return fetchJSON(url).then(function (res) {
        var d = res.data || {};
        if (!res.ok) { view.textContent = d.error || 'Unable to read log.'; meta.textContent = ''; return; }
        meta.textContent = d.label + ' · ' + (d.matched || 0) + ' lines' + (d.search ? ' matching "' + d.search + '"' : '') + ' · ' + fmtBytes(d.size);
        view.textContent = d.lines && d.lines.length ? d.lines.join('\n') : '(no matching lines)';
        view.scrollTop = view.scrollHeight;
      });
    }

    if (select) select.addEventListener('change', load);
    if (refreshBtn) refreshBtn.addEventListener('click', load);
    if (search) {
      var t;
      search.addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 350); });
    }
    if (downloadBtn) downloadBtn.addEventListener('click', function () {
      var p = currentPath(); if (!p) return;
      window.location.href = '/api/logs/download?path=' + encodeURIComponent(p);
    });

    load();
    poller(load, 10000);
  }

  // ===================================================================
  // ALERTS
  // ===================================================================
  function initAlerts() {
    var body = $('#alertBody');

    function render(d) {
      if (!body) return;
      if (!d.alerts.length) {
        body.innerHTML = '<tr><td colspan="5" class="text-secondary text-center">No alerts recorded. All systems normal.</td></tr>';
        return;
      }
      body.innerHTML = d.alerts.map(function (a) {
        var lvl = a.level === 'critical' ? 'text-bg-danger' : 'text-bg-warning';
        var ackBtn = a.acknowledged ? '<span class="text-secondary small">ack</span>'
          : '<button class="btn btn-sm btn-outline-secondary" data-ack="' + a.id + '">Ack</button>';
        var rowCls = a.acknowledged ? ' style="opacity:.55"' : '';
        return '<tr' + rowCls + '><td class="small">' + esc(a.created_at) + '</td><td><span class="badge ' + lvl + '">' + esc(a.level) +
          '</span></td><td>' + esc(a.metric.toUpperCase()) + '</td><td>' + esc(a.message) + '</td><td>' + ackBtn + '</td></tr>';
      }).join('');
      $all('[data-ack]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          fetchJSON('/api/alerts/' + btn.getAttribute('data-ack') + '/ack', { method: 'POST' }).then(load);
        });
      });
    }

    function load() {
      return fetchJSON('/api/alerts').then(function (res) {
        if (res.ok) { render(res.data); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    }

    var ackAll = $('#alertAckAll'), clear = $('#alertClear');
    if (ackAll) ackAll.addEventListener('click', function () {
      fetchJSON('/api/alerts/ack-all', { method: 'POST' }).then(load);
    });
    if (clear) clear.addEventListener('click', function () {
      if (!confirm('Clear all alert history?')) return;
      fetchJSON('/api/alerts/clear', { method: 'POST' }).then(load);
    });

    load();
    poller(load, 8000);
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', function () {
    switch (window.SM_PAGE) {
      case 'dashboard': initDashboard(); break;
      case 'monitoring': initMonitoring(); break;
      case 'mail': initMail(); break;
      case 'logs': initLogs(); break;
      case 'alerts': initAlerts(); break;
      default: break;
    }
  });
})();
