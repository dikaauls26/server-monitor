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

  function csrfHeaders(extra) {
    var h = Object.assign({}, extra || {});
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) h['X-CSRF-Token'] = meta.content;
    return h;
  }

  function fetchJSON(url, opts) {
    var req = Object.assign({ headers: csrfHeaders({ 'Accept': 'application/json' }), credentials: 'same-origin' }, opts || {});
    if (req.method && req.method.toUpperCase() !== 'GET' && !req.body) {
      req.headers = csrfHeaders(Object.assign({ 'Content-Type': 'application/json' }, req.headers || {}));
      req.body = '{}';
    } else if (req.method && req.method.toUpperCase() !== 'GET') {
      req.headers = csrfHeaders(req.headers || {});
    }
    return fetch(url, req)
      .then(function (r) {
        if (r.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
        if (r.status === 403) { throw new Error('csrf'); }
        return r.text().then(function (text) {
          if (!text) return { ok: r.ok, error: r.ok ? null : ('HTTP ' + r.status) };
          try { return JSON.parse(text); }
          catch (e) { return { ok: false, error: text.slice(0, 200) || ('HTTP ' + r.status) }; }
        });
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
    var selectedServer = localStorage.getItem('smSelectedServer') || 'local';
    var serverSelect = $('#serverSelect');
    var connStatus = $('#serverConnStatus');

    function loadServerList() {
      return fetchJSON('/api/servers').then(function (res) {
        if (!res.ok || !serverSelect) return;
        var current = serverSelect.value || selectedServer;
        serverSelect.innerHTML = '<option value="local">Local Server (this machine)</option>';
        (res.data || []).forEach(function (s) {
          var opt = document.createElement('option');
          opt.value = String(s.id);
          opt.textContent = s.name + ' (' + s.host + ')';
          serverSelect.appendChild(opt);
        });
        if (current && serverSelect.querySelector('option[value="' + current + '"]')) {
          serverSelect.value = current;
        }
        selectedServer = serverSelect.value;
        updateConnBadge(res.data || []);
      }).catch(function () {});
    }

    function updateConnBadge(servers) {
      if (!connStatus) return;
      if (selectedServer === 'local') {
        connStatus.className = 'sm-pill running';
        connStatus.innerHTML = '<span class="dot"></span>local';
        return;
      }
      var srv = (servers || []).find(function (s) { return String(s.id) === String(selectedServer); });
      var connected = srv && srv.connection && srv.connection.connected;
      connStatus.className = 'sm-pill ' + (connected ? 'running' : 'stopped');
      connStatus.innerHTML = '<span class="dot"></span>' + (connected ? 'connected' : 'disconnected');
    }

    if (serverSelect) {
      serverSelect.addEventListener('change', function () {
        selectedServer = serverSelect.value;
        localStorage.setItem('smSelectedServer', selectedServer);
        labels.length = 0; cpuData.length = 0; ramData.length = 0; rxData.length = 0; txData.length = 0;
        loadServerList();
      });
      loadServerList();
    }

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
      var url = selectedServer === 'local' ? '/api/overview' : '/api/overview?serverId=' + encodeURIComponent(selectedServer);
      return fetchJSON(url).then(function (res) {
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
      if (window.SM_PAGE !== 'monitoring') return;
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
    function showResult(ok, msg) {
      var el = $('#mailActionResult');
      if (!el) return;
      el.className = 'alert py-2 mb-3 ' + (ok ? 'alert-success' : 'alert-danger');
      el.innerHTML = '<i class="bi ' + (ok ? 'bi-check-circle' : 'bi-exclamation-triangle') + ' me-1"></i>' + esc(msg);
      el.classList.remove('d-none');
    }

    function runMailAction(url, confirmMsg, btn) {
      if (!confirm(confirmMsg)) return;
      var original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
      $('#mailActionResult') && $('#mailActionResult').classList.add('d-none');
      fetchJSON(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      }).then(function (res) {
        showResult(res.ok, res.message || res.error || 'Done.');
      }).catch(function () {
        showResult(false, 'Request failed.');
      }).then(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
        setTimeout(function () { if (refreshMail) refreshMail(); }, 800);
      });
    }

    var refreshMail;
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
    refreshMail = function () {
      return fetchJSON('/api/mail').then(function (res) {
        if (res.ok) { render(res.data); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    };
    poller(refreshMail, 8000);

    document.addEventListener('click', function (e) {
      if (window.SM_PAGE !== 'mail') return;
      var clearBtn = e.target.closest ? e.target.closest('[data-mail-clear]') : null;
      if (!clearBtn) return;
      e.preventDefault();
      var action = clearBtn.getAttribute('data-mail-clear');
      if (action === 'deferred') {
        runMailAction('/api/mail/clear-deferred', 'Delete all DEFERRED mail from the queue?', clearBtn);
      } else if (action === 'pending') {
        runMailAction('/api/mail/clear-pending', 'Delete ALL pending mail from the queue? This cannot be undone.', clearBtn);
      }
    });
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

  // ===================================================================
  // ANTIVIRUS
  // ===================================================================
  function initAntivirus() {
    var body = $('#avJobBody');
    var output = $('#avOutput');
    var form = $('#avScanForm');
    var resultEl = $('#avActionResult');

    function showResult(ok, msg) {
      if (!resultEl) return;
      resultEl.className = 'alert py-2 mb-3 ' + (ok ? 'alert-success' : 'alert-danger');
      resultEl.innerHTML = '<i class="bi ' + (ok ? 'bi-check-circle' : 'bi-exclamation-triangle') + ' me-1"></i>' + esc(msg);
      resultEl.classList.remove('d-none');
    }

    function statusPill(status) {
      var s = String(status || 'unknown').toLowerCase();
      return '<span class="sm-pill ' + esc(s === 'done' ? 'running' : (s === 'failed' ? 'stopped' : s)) + '"><span class="dot"></span>' + esc(status) + '</span>';
    }

    function render(d) {
      $('#avQueued').textContent = d.queued || 0;
      $('#avRunning').textContent = d.running || 0;
      var worker = $('#avWorker');
      if (worker) worker.textContent = d.workerActive || d.running ? 'Active' : 'Idle';
      var badge = $('#avQueueBadge');
      if (badge) badge.textContent = (d.queued || 0) + ' queued · ' + (d.running || 0) + ' running';

      if (!body) return;
      if (!d.jobs || !d.jobs.length) {
        body.innerHTML = '<tr><td colspan="7" class="text-secondary text-center">No scan jobs yet.</td></tr>';
        return;
      }
      body.innerHTML = d.jobs.map(function (j) {
        return '<tr><td>' + j.id + '</td><td>' + esc(j.scanner) + '</td><td><code>' + esc(j.path) + '</code></td><td>' +
          statusPill(j.status) + '</td><td class="small">' + esc(j.startedAt || '—') + '</td><td class="small">' +
          esc(j.finishedAt || '—') + '</td><td><button class="btn btn-sm btn-outline-secondary" data-view="' + j.id + '">View</button></td></tr>';
      }).join('');

      $all('[data-view]', body).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-view');
          var job = d.jobs.find(function (x) { return String(x.id) === String(id); });
          if (output && job) {
            var text = job.output || job.error || '(no output yet)';
            output.textContent = text;
          }
        });
      });
    }

    function load() {
      return fetchJSON('/api/antivirus/queue').then(function (res) {
        if (res.ok) { render(res.data); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var btn = $('#avSubmitBtn');
        var original = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
        if (resultEl) resultEl.classList.add('d-none');
        fetchJSON('/api/antivirus/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scanner: $('#avScanner').value,
            path: $('#avPath').value
          })
        }).then(function (res) {
          showResult(res.ok, res.message || res.error || 'Queued.');
          if (res.ok) load();
        }).catch(function () {
          showResult(false, 'Request failed.');
        }).then(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = original; }
        });
      });
    }

    load();
    poller(load, 4000);
  }

  // ===================================================================
  // REMOTE SERVERS
  // ===================================================================
  function initServers() {
    var body = $('#srvBody');
    var form = $('#srvAddForm');
    var resultEl = $('#srvActionResult');

    function showResult(ok, msg) {
      if (!resultEl) return;
      resultEl.className = 'alert py-2 mb-3 ' + (ok ? 'alert-success' : 'alert-danger');
      resultEl.innerHTML = '<i class="bi ' + (ok ? 'bi-check-circle' : 'bi-exclamation-triangle') + ' me-1"></i>' + esc(msg);
      resultEl.classList.remove('d-none');
    }

    function render(list) {
      if (!body) return;
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="5" class="text-secondary text-center">No remote servers configured.</td></tr>';
        return;
      }
      body.innerHTML = list.map(function (s) {
        var connected = s.connection && s.connection.connected;
        var status = connected ? 'running' : 'stopped';
        var statusLabel = connected ? 'connected' : (s.connection && s.connection.error ? 'error' : 'disconnected');
        return '<tr><td>' + esc(s.name) + '</td><td><code>' + esc(s.host) + ':' + s.port + '</code></td><td>' +
          pill(statusLabel) + '</td><td>' + (s.autoConnect ? '<i class="bi bi-check-lg text-success"></i>' : '—') +
          '</td><td class="text-nowrap">' +
          (connected
            ? '<button class="btn btn-sm btn-outline-warning me-1" data-disconnect="' + s.id + '">Disconnect</button>'
            : '<button class="btn btn-sm btn-outline-success me-1" data-connect="' + s.id + '">Connect</button>') +
          '<button class="btn btn-sm btn-outline-danger" data-delete="' + s.id + '"><i class="bi bi-trash"></i></button></td></tr>';
      }).join('');
    }

    function load() {
      return fetchJSON('/api/servers').then(function (res) {
        if (res.ok) { render(res.data || []); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    }

    function runAction(url, method, confirmMsg) {
      if (confirmMsg && !confirm(confirmMsg)) return Promise.resolve();
      return fetchJSON(url, {
        method: method || 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).then(function (res) {
        showResult(res.ok, res.message || res.error || 'Done.');
        return load();
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        fetchJSON('/api/servers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            host: fd.get('host'),
            port: fd.get('port'),
            username: fd.get('username'),
            password: fd.get('password'),
            privateKey: fd.get('privateKey'),
            autoConnect: fd.get('autoConnect') === 'on'
          })
        }).then(function (res) {
          showResult(res.ok, res.ok ? 'Server saved.' : (res.error || 'Failed.'));
          if (res.ok) { form.reset(); load(); }
        }).catch(function () { showResult(false, 'Request failed.'); });
      });
    }

    document.addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-connect]') : null;
      if (c) { e.preventDefault(); runAction('/api/servers/' + c.getAttribute('data-connect') + '/connect', 'POST'); return; }
      var d = e.target.closest ? e.target.closest('[data-disconnect]') : null;
      if (d) { e.preventDefault(); runAction('/api/servers/' + d.getAttribute('data-disconnect') + '/disconnect', 'POST'); return; }
      var del = e.target.closest ? e.target.closest('[data-delete]') : null;
      if (del) {
        e.preventDefault();
        runAction('/api/servers/' + del.getAttribute('data-delete'), 'DELETE', 'Remove this server?');
      }
    });

    load();
    poller(load, 8000);
  }

  // ===================================================================
  // MONITORING ALL
  // ===================================================================
  function initMonitoringAll() {
    var root = $('#maRoot');
    var grid = $('#maGrid');
    var resultEl = $('#maActionResult');
    var serviceSel = $('#maService');
    var mailModalEl = $('#maModalMail');
    var cronModalEl = $('#maModalCron');
    var mailModal = mailModalEl && window.bootstrap ? bootstrap.Modal.getOrCreateInstance(mailModalEl) : null;
    var cronModal = cronModalEl && window.bootstrap ? bootstrap.Modal.getOrCreateInstance(cronModalEl) : null;
    var activeMailServer = null;
    var activeCronServer = null;

    function handleMaClick(e) {
      var bulk = e.target.closest ? e.target.closest('[data-ma-bulk]') : null;
      if (bulk) {
        e.preventDefault();
        runBulk(bulk.getAttribute('data-ma-bulk'), bulk);
        return;
      }
      var ctl = e.target.closest ? e.target.closest('[data-ma-ctl]') : null;
      if (ctl) {
        e.preventDefault();
        var act = ctl.getAttribute('data-ma-ctl');
        var svc = ctl.getAttribute('data-ma-svc');
        var sid = ctl.getAttribute('data-ma-server');
        var msg = act === 'stop' ? 'Stop ' + svc + ' on this server?' : null;
        runControl(sid, svc, act, msg, ctl);
        return;
      }
      var rebootBtn = e.target.closest ? e.target.closest('[data-ma-reboot]') : null;
      if (rebootBtn) {
        e.preventDefault();
        runReboot(rebootBtn.getAttribute('data-ma-reboot'), rebootBtn.getAttribute('data-ma-name') || 'server', rebootBtn);
        return;
      }
      var mailBtn = e.target.closest ? e.target.closest('[data-ma-mail]') : null;
      if (mailBtn) {
        e.preventDefault();
        loadMailModal(mailBtn.getAttribute('data-ma-mail'), mailBtn.getAttribute('data-ma-name') || 'server');
        return;
      }
      var cronBtn = e.target.closest ? e.target.closest('[data-ma-cron]') : null;
      if (cronBtn) {
        e.preventDefault();
        loadCronModal(cronBtn.getAttribute('data-ma-cron'), cronBtn.getAttribute('data-ma-name') || 'server');
        return;
      }
      var mailClear = e.target.closest ? e.target.closest('[data-ma-mail-clear]') : null;
      if (mailClear) {
        e.preventDefault();
        runMailClear(mailClear.getAttribute('data-ma-mail-clear'), mailClear.getAttribute('data-ma-server'), mailClear);
        return;
      }
      var mailReload = e.target.closest ? e.target.closest('[data-ma-mail-reload]') : null;
      if (mailReload) {
        e.preventDefault();
        if (activeMailServer) loadMailModal(activeMailServer.id, activeMailServer.name);
      }
    }

    function showResult(ok, msg) {
      if (!resultEl) return;
      resultEl.className = 'alert py-2 mb-3 ' + (ok ? 'alert-success' : 'alert-warning');
      resultEl.innerHTML = '<i class="bi ' + (ok ? 'bi-check-circle' : 'bi-exclamation-triangle') + ' me-1"></i>' + msg;
      resultEl.classList.remove('d-none');
    }

    function statusPill(s) {
      if (s.status === 'not-installed' || s.installed === false) {
        return '<span class="sm-pill not-installed"><span class="dot"></span>not installed</span>';
      }
      return pill(s.status);
    }

    function usageBar(pct, cls) {
      var v = Math.max(0, Math.min(100, pct || 0));
      var barCls = v >= 90 ? 'bg-danger' : (v >= 75 ? 'bg-warning' : cls || 'bg-info');
      return '<div class="progress sm-progress mb-0"><div class="progress-bar ' + barCls + '" style="width:' + v + '%"></div></div>';
    }

    function ctlButtons(s, serverId) {
      if (!s.controllable) return '<span class="text-secondary small">—</span>';
      return '<div class="btn-group btn-group-sm sm-ctl" role="group">' +
        '<button type="button" class="btn btn-outline-success" data-ma-ctl="start" data-ma-svc="' + s.key + '" data-ma-server="' + esc(String(serverId)) + '" title="Start"><i class="bi bi-play-fill"></i></button>' +
        '<button type="button" class="btn btn-outline-primary" data-ma-ctl="restart" data-ma-svc="' + s.key + '" data-ma-server="' + esc(String(serverId)) + '" title="Restart"><i class="bi bi-arrow-clockwise"></i></button>' +
        '<button type="button" class="btn btn-outline-danger" data-ma-ctl="stop" data-ma-svc="' + s.key + '" data-ma-server="' + esc(String(serverId)) + '" title="Stop"><i class="bi bi-stop-fill"></i></button>' +
        '</div>';
    }

    function onlinePill(srv) {
      if (srv.online) {
        return '<span class="sm-pill running" title="Server reachable"><span class="dot"></span>online</span>';
      }
      if (srv.connected) {
        return '<span class="sm-pill idle" title="Connected but data incomplete"><span class="dot"></span>partial</span>';
      }
      return '<span class="sm-pill stopped" title="Not connected or unreachable"><span class="dot"></span>offline</span>';
    }

    function serverActions(srv) {
      var sid = esc(String(srv.id));
      var name = esc(srv.name || sid);
      return '<div class="d-flex flex-wrap gap-1 mt-2">' +
        '<button type="button" class="btn btn-sm btn-outline-danger" data-ma-reboot="' + sid + '" data-ma-name="' + name + '" title="Reboot server"><i class="bi bi-power"></i> Reboot</button>' +
        '<button type="button" class="btn btn-sm btn-outline-info" data-ma-mail="' + sid + '" data-ma-name="' + name + '" title="View mail queue"><i class="bi bi-envelope"></i> Mail Queue</button>' +
        '<button type="button" class="btn btn-sm btn-outline-secondary" data-ma-cron="' + sid + '" data-ma-name="' + name + '" title="View cron jobs"><i class="bi bi-calendar-check"></i> Cron</button>' +
        '</div>';
    }

    function renderMailModal(d, serverId, serverName) {
      var body = $('#maModalMailBody');
      var footer = $('#maModalMailFooter');
      var title = $('#maModalMailLabel');
      if (title) title.innerHTML = '<i class="bi bi-envelope me-1"></i> Mail Queue — ' + esc(serverName);
      if (!body) return;

      if (!d) {
        body.innerHTML = '<div class="text-secondary text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>Loading mail queue…</div>';
        if (footer) footer.innerHTML = '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Close</button>';
        return;
      }

      var q = d.queue || {};
      var stats = q.stats || {};
      var smtp = d.smtp || {};
      var updated = d.timestamp ? new Date(d.timestamp).toLocaleString() : '—';

      var statsHtml = '<div class="row g-2 mb-3 ma-stat-grid">' +
        '<div class="col-6 col-md-4"><div class="ma-stat"><div class="ma-stat-label">Total</div><div class="ma-stat-val">' + (stats.total || 0) + '</div></div></div>' +
        '<div class="col-6 col-md-4"><div class="ma-stat"><div class="ma-stat-label">Active</div><div class="ma-stat-val text-info">' + (stats.active || 0) + '</div></div></div>' +
        '<div class="col-6 col-md-4"><div class="ma-stat"><div class="ma-stat-label">Deferred</div><div class="ma-stat-val text-warning">' + (stats.deferred || 0) + '</div></div></div>' +
        '<div class="col-6 col-md-4"><div class="ma-stat"><div class="ma-stat-label">Hold</div><div class="ma-stat-val">' + (stats.hold || 0) + '</div></div></div>' +
        '<div class="col-6 col-md-4"><div class="ma-stat"><div class="ma-stat-label">Failed hints</div><div class="ma-stat-val text-danger">' + (stats.failed || 0) + '</div></div></div>' +
        '</div>';

      var smtpHtml = '<div class="d-flex flex-wrap gap-3 mb-3 small">' +
        '<span>Postfix: ' + pill(smtp.postfix || 'unknown') + '</span>' +
        '<span>Port 25: ' + pill(smtp.port25 || 'unknown') + '</span>' +
        (smtp.port587 ? '<span>Port 587: ' + pill(smtp.port587) + '</span>' : '') +
        '<span class="text-secondary ms-auto"><i class="bi bi-clock"></i> ' + esc(updated) + '</span>' +
        '</div>';

      var rawText = !q.available
        ? (q.reason || 'Mail queue not available on this server.')
        : (q.raw && q.raw.trim() ? q.raw : 'Mail queue is empty.');

      body.innerHTML = statsHtml + smtpHtml +
        '<div class="sm-card-head pt-0 mb-2"><span class="small">Queue output</span></div>' +
        '<pre class="sm-log-view ma-raw">' + esc(rawText) + '</pre>';

      if (footer) {
        var clearBtns = q.available
          ? '<button type="button" class="btn btn-outline-warning" data-ma-mail-clear="deferred" data-ma-server="' + esc(String(serverId)) + '"><i class="bi bi-trash"></i> Clear Deferred</button>' +
            '<button type="button" class="btn btn-outline-danger" data-ma-mail-clear="pending" data-ma-server="' + esc(String(serverId)) + '"><i class="bi bi-trash3"></i> Clear All Pending</button>'
          : '';
        footer.innerHTML = clearBtns +
          '<button type="button" class="btn btn-outline-primary" data-ma-mail-reload="' + esc(String(serverId)) + '"><i class="bi bi-arrow-clockwise"></i> Reload</button>' +
          '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Close</button>';
      }
    }

    function renderCronModal(d, serverName) {
      var body = $('#maModalCronBody');
      var title = $('#maModalCronLabel');
      if (title) title.innerHTML = '<i class="bi bi-calendar-check me-1"></i> Cron Jobs — ' + esc(serverName);
      if (!body) return;

      if (!d) {
        body.innerHTML = '<div class="text-secondary text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>Loading cron jobs…</div>';
        return;
      }

      if (d.available === false) {
        body.innerHTML = '<div class="alert alert-warning mb-0"><i class="bi bi-exclamation-triangle me-1"></i>' +
          esc(d.error || 'Cron listing not available on this server.') + '</div>';
        return;
      }

      var jobs = d.jobs || [];
      var summary = '<div class="d-flex flex-wrap gap-3 mb-3 small text-secondary">' +
        '<span><i class="bi bi-list-task"></i> Total jobs: <strong class="text-light">' + (d.total || jobs.length) + '</strong></span>' +
        (d.user ? '<span><i class="bi bi-person"></i> User context: ' + esc(d.user) + '</span>' : '') +
        '</div>';

      if (!jobs.length) {
        body.innerHTML = summary + '<div class="text-secondary text-center py-3">No cron jobs found.</div>';
        return;
      }

      var rows = jobs.map(function (c) {
        return '<tr><td class="small text-nowrap">' + esc(c.schedule || '—') + '</td>' +
          '<td class="small">' + esc(c.user || '—') + '</td>' +
          '<td class="small text-break">' + esc(c.command || '') + '</td>' +
          '<td class="small text-secondary text-nowrap">' + esc(c.source || '') + '</td></tr>';
      }).join('');

      body.innerHTML = summary +
        '<div class="table-responsive"><table class="table sm-table mb-0"><thead><tr>' +
        '<th>Schedule</th><th>User</th><th>Command</th><th>Source</th></tr></thead><tbody>' +
        rows + '</tbody></table></div>';
    }

    function loadMailModal(serverId, serverName) {
      activeMailServer = { id: serverId, name: serverName };
      renderMailModal(null, serverId, serverName);
      if (mailModal) mailModal.show();
      return fetchJSON('/api/monitoring-all/server/' + encodeURIComponent(serverId) + '/mail').then(function (res) {
        if (!res.ok) {
          $('#maModalMailBody').innerHTML = '<div class="alert alert-danger mb-0">' + esc(res.error || 'Failed to load mail queue.') + '</div>';
          return;
        }
        renderMailModal(res.data, serverId, serverName);
      }).catch(function () {
        $('#maModalMailBody').innerHTML = '<div class="alert alert-danger mb-0">Request failed.</div>';
      });
    }

    function loadCronModal(serverId, serverName) {
      activeCronServer = { id: serverId, name: serverName };
      renderCronModal(null, serverName);
      if (cronModal) cronModal.show();
      return fetchJSON('/api/monitoring-all/server/' + encodeURIComponent(serverId) + '/cron').then(function (res) {
        if (!res.ok) {
          $('#maModalCronBody').innerHTML = '<div class="alert alert-danger mb-0">' + esc(res.error || 'Failed to load cron jobs.') + '</div>';
          return;
        }
        renderCronModal(res.data, serverName);
      }).catch(function () {
        $('#maModalCronBody').innerHTML = '<div class="alert alert-danger mb-0">Request failed.</div>';
      });
    }

    function runMailClear(action, serverId, btn) {
      var msg = action === 'deferred'
        ? 'Delete all DEFERRED mail from the queue on this server?'
        : 'Delete ALL pending mail from the queue? This cannot be undone.';
      if (!confirm(msg)) return;
      var original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
      var path = action === 'deferred' ? 'clear-deferred' : 'clear-pending';
      fetchJSON('/api/monitoring-all/server/' + encodeURIComponent(serverId) + '/mail/' + path, { method: 'POST' })
        .then(function (res) {
          showResult(res.ok, res.message || res.error || 'Done.');
          if (res.ok && activeMailServer) loadMailModal(activeMailServer.id, activeMailServer.name);
        })
        .catch(function () { showResult(false, 'Mail action failed.'); })
        .then(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = original; }
        });
    }

    function runReboot(serverId, serverName, btn) {
      if (!confirm('Reboot "' + serverName + '" now?\n\nAll services will restart. SSH may disconnect briefly.')) return;
      var original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
      if (resultEl) resultEl.classList.add('d-none');
      fetchJSON('/api/monitoring-all/server/' + encodeURIComponent(serverId) + '/reboot', { method: 'POST' })
        .then(function (res) {
          showResult(res.ok, res.message || res.error || (res.ok ? 'Reboot initiated.' : 'Reboot failed.'));
          if (res.ok) setTimeout(load, 3000);
        })
        .catch(function () { showResult(false, 'Reboot request failed.'); })
        .then(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = original; }
        });
    }

    function renderServerCard(srv) {
      var status = onlinePill(srv);
      var actions = serverActions(srv);

      if (srv.ok === false || !srv.connected) {
        return '<div class="col-12 col-xl-6"><div class="sm-card sm-server-card h-100">' +
          '<div class="d-flex justify-content-between align-items-start mb-2">' +
          '<div><h6 class="mb-1"><i class="bi bi-hdd-network me-1"></i>' + esc(srv.name) +
          (srv.local ? ' <span class="badge text-bg-primary">local</span>' : '') + '</h6>' +
          '<div class="text-secondary small">' + esc(srv.host || '') + (srv.port ? ':' + srv.port : '') + '</div></div>' +
          status + '</div>' +
          '<div class="alert alert-danger py-2 mb-2 small">' + esc(srv.error || 'Unable to load data — server offline or not connected.') + '</div>' +
          actions + '</div></div>';
      }

      var cpu = srv.cpu || {};
      var mem = srv.memory || {};
      var disk = srv.disk || {};
      var load = srv.load || {};
      var pm2 = srv.pm2 || { apps: [], online: 0, total: 0, installed: false };

      var svcRows = (srv.services || []).map(function (svc) {
        return '<tr><td>' + esc(svc.label) + '</td><td>' + statusPill(svc) + '</td><td class="text-end">' +
          ctlButtons(svc, srv.id) + '</td></tr>';
      }).join('');

      var pm2Rows = '';
      if (pm2.installed && pm2.apps && pm2.apps.length) {
        pm2Rows = pm2.apps.slice(0, 5).map(function (a) {
          return '<tr><td>' + esc(a.name) + '</td><td>' + pill(a.status) + '</td><td>' +
            (a.cpu != null ? a.cpu + '%' : '—') + '</td><td>' + fmtBytes(a.memory) + '</td></tr>';
        }).join('');
      } else {
        pm2Rows = '<tr><td colspan="4" class="text-secondary text-center small">No PM2 apps</td></tr>';
      }

      return '<div class="col-12 col-xl-6"><div class="sm-card sm-server-card h-100">' +
        '<div class="d-flex justify-content-between align-items-start mb-3">' +
        '<div><h6 class="mb-1"><i class="bi bi-hdd-network me-1"></i>' + esc(srv.name) +
        (srv.local ? ' <span class="badge text-bg-primary">local</span>' : '') + '</h6>' +
        '<div class="text-secondary small">' + esc(srv.hostname || srv.host || '') + ' · ' + esc((srv.os && srv.os.distro) || '') + '</div>' +
        '<div class="text-secondary small">' + esc((cpu.brand || 'CPU')) + ' · ' + (cpu.cores || '?') + ' cores</div></div>' +
        status + '</div>' +
        actions +
        '<div class="row g-2 mb-3 mt-3">' +
        '<div class="col-4"><div class="small text-secondary">CPU</div><div class="fw-semibold">' + (cpu.usage || 0).toFixed(1) + '%</div>' + usageBar(cpu.usage, 'bg-info') + '</div>' +
        '<div class="col-4"><div class="small text-secondary">RAM</div><div class="fw-semibold">' + (mem.usage || 0).toFixed(1) + '%</div>' + usageBar(mem.usage, 'bg-success') + '</div>' +
        '<div class="col-4"><div class="small text-secondary">Disk</div><div class="fw-semibold">' + (disk.usage || 0).toFixed(1) + '%</div>' + usageBar(disk.usage, 'bg-warning') + '</div>' +
        '</div>' +
        '<div class="d-flex flex-wrap gap-3 small text-secondary mb-3">' +
        '<span><i class="bi bi-activity"></i> Load: ' + (load.one || 0) + ' / ' + (load.five || 0) + ' / ' + (load.fifteen || 0) + '</span>' +
        '<span><i class="bi bi-clock"></i> ' + esc((srv.uptime && srv.uptime.human) || '—') + '</span>' +
        '<span><i class="bi bi-boxes"></i> PM2: ' + (pm2.online || 0) + '/' + (pm2.total || 0) + '</span>' +
        '</div>' +
        '<div class="table-responsive mb-2"><table class="table sm-table mb-0"><thead><tr><th>Service</th><th>Status</th><th class="text-end">Action</th></tr></thead><tbody>' +
        svcRows + '</tbody></table></div>' +
        '<div class="sm-card-head pt-0"><span class="small"><i class="bi bi-boxes"></i> PM2</span></div>' +
        '<div class="table-responsive"><table class="table sm-table mb-0"><thead><tr><th>Name</th><th>Status</th><th>CPU</th><th>RAM</th></tr></thead><tbody>' +
        pm2Rows + '</tbody></table></div>' +
        '</div></div>';
    }

    function render(d) {
      var online = d.online != null ? d.online : (d.connected || 0);
      $('#maUpdated').textContent = online + ' / ' + (d.total || 0) + ' online · ' +
        (d.connected || 0) + ' connected · ' + new Date(d.timestamp).toLocaleTimeString();
      if (!grid) return;
      if (!d.servers || !d.servers.length) {
        grid.innerHTML = '<div class="col-12 text-secondary text-center py-4">No servers configured. Add SSH servers in the Servers menu.</div>';
        return;
      }
      grid.innerHTML = d.servers.map(renderServerCard).join('');
    }

    function load() {
      return fetchJSON('/api/monitoring-all').then(function (res) {
        if (res.ok) { render(res.data); markLive(true); } else markLive(false);
      }).catch(function () { markLive(false); });
    }

    function runControl(serverId, service, action, confirmMsg, btn) {
      if (confirmMsg && !confirm(confirmMsg)) return Promise.resolve();
      var original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
      if (resultEl) resultEl.classList.add('d-none');
      return fetchJSON('/api/monitoring-all/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: serverId, service: service, action: action })
      }).then(function (res) {
        var lines = (res.results || []).map(function (r) {
          return esc(r.name || r.serverId) + ': ' + (r.message || r.error || (r.ok ? 'OK' : 'Failed'));
        }).join('<br>');
        showResult(res.ok !== false, res.message || lines || 'Done.');
        return load();
      }).catch(function () {
        showResult(false, 'Request failed.');
      }).then(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
      });
    }

    function runBulk(action, btn) {
      var svc = serviceSel ? serviceSel.value : 'nginx';
      if (!confirm('Run ' + action.toUpperCase() + ' on "' + svc + '" for ALL servers?')) return;
      var original = btn ? btn.innerHTML : '';
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
      if (resultEl) resultEl.classList.add('d-none');
      fetchJSON('/api/monitoring-all/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: 'all', service: svc, action: action })
      }).then(function (res) {
        var lines = (res.results || []).map(function (r) {
          return esc(r.name || r.serverId) + ': ' + (r.message || r.error || (r.ok ? 'OK' : 'Failed'));
        }).join('<br>');
        showResult(res.ok !== false, res.message || lines || 'Done.');
        load();
      }).catch(function () { showResult(false, 'Request failed.'); })
        .then(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = original; }
        });
    }

    if (root) root.addEventListener('click', handleMaClick);

    var connectAll = $('#maConnectAll');
    var refreshBtn = $('#maRefresh');
    if (connectAll) connectAll.addEventListener('click', function () {
      fetchJSON('/api/monitoring-all/connect-all', { method: 'POST' }).then(function (res) {
        showResult(true, 'Connect all completed.');
        load();
      }).catch(function () { showResult(false, 'Connect failed.'); });
    });
    if (refreshBtn) refreshBtn.addEventListener('click', load);

    load();
    poller(load, 10000);
  }

  // ===================================================================
  // DOMAINS (CyberPanel)
  // ===================================================================
  function initDomains() {
    var body = $('#domBody');
    var resultEl = $('#domActionResult');
    var serverSel = $('#domServerSelect');
    var filterSel = $('#domFilter');
    var refreshBtn = $('#domRefresh');
    var fetchBtn = $('#domFetch');
    var selectAllCb = $('#domSelectAll');
    var deleteSelectedBtn = $('#domDeleteSelected');
    var selCountEl = $('#domSelCount');
    var queueBody = $('#domQueueBody');
    var queueBadge = $('#domQueueBadge');
    var selectedServer = localStorage.getItem('smSelectedServer') || 'local';
    var lastSites = [];
    var selected = new Set();
    var queuePoller = null;
    var lastQueueActive = false;
    var hasFetched = false;

    function setActionButtons(enabled) {
      if (filterSel) filterSel.disabled = !enabled;
      var ids = ['domSelect404', 'domSelectMoved', 'domRefresh'];
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.disabled = !enabled;
      });
    }

    function showIdleState() {
      hasFetched = false;
      lastSites = [];
      selected.clear();
      updateSelUi();
      setActionButtons(false);
      if (selectAllCb) selectAllCb.checked = false;
      if (body) {
        body.innerHTML = '<tr><td colspan="8" class="text-secondary text-center py-4">Pilih server lalu klik <strong>Fetch Domains</strong>.</td></tr>';
      }
      $('#domTotal').textContent = '0';
      $('#domActive').textContent = '0';
      $('#dom404').textContent = '0';
      $('#domMoved').textContent = '0';
      $('#domDown').textContent = '0';
      $('#domUpdated').textContent = 'belum di-fetch';
      markLive(false);
    }

    function showResult(ok, msg) {
      if (!resultEl) return;
      resultEl.className = 'alert py-2 mb-3 ' + (ok ? 'alert-success' : 'alert-danger');
      resultEl.innerHTML = '<i class="bi ' + (ok ? 'bi-check-circle' : 'bi-exclamation-triangle') + ' me-1"></i>' + esc(msg);
      resultEl.classList.remove('d-none');
    }

    function updateSelUi() {
      if (selCountEl) selCountEl.textContent = String(selected.size);
      if (deleteSelectedBtn) deleteSelectedBtn.disabled = selected.size === 0;
    }

    function queueStatusPill(st) {
      if (st === 'done') return '<span class="sm-pill running"><span class="dot"></span>done</span>';
      if (st === 'running') return '<span class="sm-pill idle"><span class="dot"></span>running</span>';
      if (st === 'failed') return '<span class="sm-pill stopped"><span class="dot"></span>failed</span>';
      return '<span class="sm-pill not-installed"><span class="dot"></span>queued</span>';
    }

    function statusBadge(s) {
      if (s.status === 'active') return '<span class="sm-pill running"><span class="dot"></span>active</span>';
      if (s.status === '404') return '<span class="sm-pill idle"><span class="dot"></span>404</span>';
      if (s.status === 'down') return '<span class="sm-pill stopped"><span class="dot"></span>down</span>';
      if (s.status === 'unknown') return '<span class="sm-pill not-installed"><span class="dot"></span>unchecked</span>';
      return '<span class="sm-pill not-installed"><span class="dot"></span>' + esc(s.status || 'other') + '</span>';
    }

    function loadServers() {
      return fetchJSON('/api/servers').then(function (res) {
        if (!res.ok || !serverSel) return;
        var current = serverSel.value || selectedServer;
        serverSel.innerHTML = '<option value="local">Local Server (this machine)</option>';
        (res.data || []).forEach(function (s) {
          var opt = document.createElement('option');
          opt.value = String(s.id);
          opt.textContent = s.name + ' (' + s.host + ')';
          serverSel.appendChild(opt);
        });
        if (current && serverSel.querySelector('option[value="' + current + '"]')) {
          serverSel.value = current;
        }
        selectedServer = serverSel.value;
      }).catch(function () {});
    }

    function filteredSites(sites) {
      var f = filterSel ? filterSel.value : 'all';
      if (f === '404') return sites.filter(function (s) { return s.status === '404'; });
      if (f === 'active') return sites.filter(function (s) { return s.status === 'active'; });
      if (f === 'moved') {
        return sites.filter(function (s) {
          return s.dns && s.dns.note && ['moved', 'mixed', 'cname'].indexOf(s.dns.note.status) >= 0;
        });
      }
      return sites;
    }

    function renderDns(s) {
      if (!s.dns || !s.dns.configured) {
        return '<span class="text-secondary small">Configure in Settings</span>';
      }
      if (!s.dns.records || !s.dns.records.length) {
        return '<span class="text-secondary small">—</span>';
      }
      return s.dns.records.map(function (r) {
        return '<div class="small text-nowrap"><code>' + esc(r.type) + '</code> ' +
          esc(r.name === s.domain ? '@' : r.name.replace(s.domain, '').replace(/\.$/, '') || r.name) +
          ' → <strong>' + esc(r.content) + '</strong>' +
          (r.proxied ? ' <i class="bi bi-cloud-fill text-info" title="Proxied"></i>' : '') +
          '</div>';
      }).join('');
    }

    function renderNote(s) {
      if (!s.dns || !s.dns.note) return '<span class="text-secondary small">—</span>';
      var n = s.dns.note;
      var cls = 'text-secondary';
      if (n.status === 'ok') cls = 'text-success';
      else if (n.status === 'moved' || n.status === 'mixed') cls = 'text-warning';
      else if (n.status === 'missing' || n.status === 'error') cls = 'text-danger';
      return '<span class="small ' + cls + '">' + esc(n.text) + '</span>';
    }

    function renderTable(sites) {
      if (!body) return;
      var rows = filteredSites(sites);
      if (!sites.length) {
        body.innerHTML = '<tr><td colspan="8" class="text-secondary text-center py-4">No domains found in CyberPanel on this server.</td></tr>';
        updateSelUi();
        return;
      }
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="8" class="text-secondary text-center py-4">No domains match this filter.</td></tr>';
        updateSelUi();
        return;
      }
      body.innerHTML = rows.map(function (s) {
        var checked = selected.has(s.domain) ? ' checked' : '';
        var delBtn = '<button type="button" class="btn btn-sm btn-outline-danger" data-dom-delete="' + esc(s.domain) + '" data-dom-type="' + esc(s.type || 'primary') + '" data-dom-status="' + esc(s.status || '') + '" title="Queue delete"><i class="bi bi-trash"></i></button>';
        var typeLabel = s.type === 'child'
          ? '<span class="badge text-bg-secondary">child</span>' + (s.master ? ' <span class="text-secondary small">of ' + esc(s.master) + '</span>' : '')
          : '<span class="badge text-bg-primary">primary</span>';
        return '<tr><td><input type="checkbox" class="form-check-input dom-row-cb" data-dom-check="' + esc(s.domain) + '"' + checked + ' /></td>' +
          '<td class="fw-semibold">' + esc(s.domain) + '</td><td>' + typeLabel + '</td><td>' +
          (s.httpCode != null ? esc(String(s.httpCode)) : '—') +
          (s.protocol ? ' <span class="text-secondary small">(' + esc(s.protocol) + ')</span>' : '') +
          '</td><td>' + statusBadge(s) + '</td><td>' + renderDns(s) + '</td><td>' + renderNote(s) + '</td>' +
          '<td class="text-end">' + delBtn + '</td></tr>';
      }).join('');
      updateSelUi();
      if (selectAllCb) {
        selectAllCb.checked = rows.length > 0 && rows.every(function (s) { return selected.has(s.domain); });
      }
    }

    function renderSummary(data) {
      var sum = data.summary || {};
      $('#domTotal').textContent = sum.total || 0;
      $('#domActive').textContent = sum.active || 0;
      $('#dom404').textContent = sum.notFound || 0;
      $('#domMoved').textContent = sum.moved || 0;
      $('#domDown').textContent = (sum.down || 0) + (sum.other || 0);
      if (data.timestamp) {
        $('#domUpdated').textContent = new Date(data.timestamp).toLocaleTimeString();
      }
      var hint = $('#domServerIpHint');
      if (hint && data.serverIp) {
        hint.innerHTML = '<i class="bi bi-hdd-network"></i> Server IP: <strong>' + esc(data.serverIp) + '</strong> · ' +
          (data.cloudflare && data.cloudflare.configured ? '<i class="bi bi-cloud-check"></i> Cloudflare connected' : '<i class="bi bi-cloud-slash"></i> Cloudflare not configured — <a href="/settings">Settings</a>') +
          ' · Bulk delete = background queue (1 domain at a time)';
      }
    }

    function renderQueue(d) {
      if (queueBadge) {
        queueBadge.textContent = (d.queued || 0) + ' queued · ' + (d.running || 0) + ' running';
      }
      if (!queueBody) return;
      if (!d.jobs || !d.jobs.length) {
        queueBody.innerHTML = '<tr><td colspan="5" class="text-secondary text-center py-3 small">No delete jobs yet.</td></tr>';
        return;
      }
      queueBody.innerHTML = d.jobs.map(function (j) {
        var result;
        if (j.status === 'running') {
          result = 'Deleting…';
        } else if (j.status === 'queued') {
          result = 'Waiting…';
        } else if (j.status === 'failed') {
          result = esc(j.message || j.error || 'Failed');
        } else {
          result = esc(j.message || 'Deleted');
        }
        return '<tr><td class="small text-secondary">' + j.id + '</td><td>' + esc(j.domain) + '</td><td class="small">' + esc(j.serverId) + '</td><td>' +
          queueStatusPill(j.status) + '</td><td class="small text-break">' + result + '</td></tr>';
      }).join('');
    }

    function loadQueue() {
      return fetchJSON('/api/domains/delete-queue').then(function (res) {
        if (!res.ok || !res.data) return;
        renderQueue(res.data);
        var active = (res.data.queued || 0) + (res.data.running || 0) > 0;
        if (hasFetched && lastQueueActive && !active) load();
        lastQueueActive = active;
      }).catch(function () {});
    }

    function startQueuePoll() {
      if (queuePoller) return;
      queuePoller = setInterval(loadQueue, 3000);
    }

    function load() {
      if (body) body.innerHTML = '<tr><td colspan="8" class="text-secondary text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>Checking domains &amp; DNS…</td></tr>';
      var url = '/api/domains?serverId=' + encodeURIComponent(selectedServer);
      return fetchJSON(url).then(function (res) {
        if (!res.ok) {
          if (body) body.innerHTML = '<tr><td colspan="8" class="text-danger text-center py-4">' + esc(res.error || 'Failed to load domains.') + '</td></tr>';
          markLive(false);
          return;
        }
        var data = res.data || {};
        if (data.available === false) {
          if (body) body.innerHTML = '<tr><td colspan="8" class="text-warning text-center py-4">' + esc(data.error || 'CyberPanel not available.') + '</td></tr>';
          renderSummary({ summary: {}, timestamp: Date.now() });
          markLive(false);
          return;
        }
        lastSites = data.sites || [];
        selected.forEach(function (d) {
          if (!lastSites.some(function (s) { return s.domain === d; })) selected.delete(d);
        });
        renderSummary(data);
        renderTable(lastSites);
        hasFetched = true;
        setActionButtons(true);
        markLive(true);
      }).catch(function () {
        if (body) body.innerHTML = '<tr><td colspan="8" class="text-danger text-center py-4">Request failed.</td></tr>';
        markLive(false);
      });
    }

    function enqueueDelete(items, confirmMsg) {
      if (!items.length) return;
      if (!confirm(confirmMsg)) return;
      if (resultEl) resultEl.classList.add('d-none');
      fetchJSON('/api/domains/delete-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: selectedServer, items: items })
      }).then(function (res) {
        var msg = res.message || res.error || 'Done.';
        if (res.skipped && res.skipped.length) {
          msg += ' Skipped: ' + res.skipped.map(function (x) { return x.domain; }).join(', ');
        }
        showResult(res.ok, msg);
        if (res.ok) {
          items.forEach(function (it) { selected.delete(it.domain); });
          updateSelUi();
          loadQueue();
          startQueuePoll();
        }
      }).catch(function () { showResult(false, 'Queue request failed.'); });
    }

    function deleteOne(domain, type, siteStatus, btn) {
      var extra = siteStatus === '404' ? 'Domain returns 404.' : 'Site status: ' + siteStatus + '.';
      enqueueDelete([{ domain: domain, type: type }],
        'Queue delete "' + domain + '"?\n\n' + extra + '\n\nRuns in background (one at a time).');
      if (btn) btn.disabled = true;
      setTimeout(function () { if (btn) btn.disabled = false; }, 1500);
    }

    function deleteSelected() {
      var items = [];
      lastSites.forEach(function (s) {
        if (selected.has(s.domain)) items.push({ domain: s.domain, type: s.type || 'primary' });
      });
      enqueueDelete(items,
        'Queue delete for ' + items.length + ' domain(s)?\n\nProcessed one at a time.\nCANNOT be undone.');
    }

    function selectByFilter(fn) {
      filteredSites(lastSites).forEach(function (s) {
        if (fn(s)) selected.add(s.domain);
      });
      renderTable(lastSites);
    }

    if (serverSel) {
      serverSel.addEventListener('change', function () {
        selectedServer = serverSel.value;
        localStorage.setItem('smSelectedServer', selectedServer);
        showIdleState();
      });
    }
    if (filterSel) filterSel.addEventListener('change', function () { if (hasFetched) renderTable(lastSites); });
    if (fetchBtn) fetchBtn.addEventListener('click', load);
    if (refreshBtn) refreshBtn.addEventListener('click', function () { if (hasFetched) load(); });
    if (deleteSelectedBtn) deleteSelectedBtn.addEventListener('click', deleteSelected);
    if ($('#domSelect404')) $('#domSelect404').addEventListener('click', function () {
      selectByFilter(function (s) { return s.status === '404'; });
    });
    if ($('#domSelectMoved')) $('#domSelectMoved').addEventListener('click', function () {
      selectByFilter(function (s) {
        return s.dns && s.dns.note && ['moved', 'mixed', 'cname'].indexOf(s.dns.note.status) >= 0;
      });
    });
    if (selectAllCb) selectAllCb.addEventListener('change', function () {
      var rows = filteredSites(lastSites);
      if (selectAllCb.checked) rows.forEach(function (s) { selected.add(s.domain); });
      else rows.forEach(function (s) { selected.delete(s.domain); });
      renderTable(lastSites);
    });

    if (body) body.addEventListener('change', function (e) {
      if (window.SM_PAGE !== 'domains') return;
      var cb = e.target.closest ? e.target.closest('.dom-row-cb') : null;
      if (!cb) return;
      var d = cb.getAttribute('data-dom-check');
      if (cb.checked) selected.add(d); else selected.delete(d);
      updateSelUi();
    });

    document.addEventListener('click', function (e) {
      if (window.SM_PAGE !== 'domains') return;
      var del = e.target.closest ? e.target.closest('[data-dom-delete]') : null;
      if (!del) return;
      e.preventDefault();
      deleteOne(del.getAttribute('data-dom-delete'), del.getAttribute('data-dom-type'), del.getAttribute('data-dom-status'), del);
    });

    loadServers().then(function () { showIdleState(); loadQueue(); startQueuePoll(); });
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', function () {
    switch (window.SM_PAGE) {
      case 'dashboard': initDashboard(); break;
      case 'monitoring': initMonitoring(); break;
      case 'monitoring-all': initMonitoringAll(); break;
      case 'mail': initMail(); break;
      case 'domains': initDomains(); break;
      case 'antivirus': initAntivirus(); break;
      case 'servers': initServers(); break;
      case 'logs': initLogs(); break;
      case 'alerts': initAlerts(); break;
      default: break;
    }
  });
})();
