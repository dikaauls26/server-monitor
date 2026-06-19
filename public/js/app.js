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
    var req = Object.assign({ headers: { 'Accept': 'application/json' }, credentials: 'same-origin' }, opts || {});
    if (req.method && req.method.toUpperCase() !== 'GET' && !req.body) {
      req.headers = Object.assign({ 'Content-Type': 'application/json' }, req.headers || {});
      req.body = '{}';
    }
    return fetch(url, req)
      .then(function (r) {
        if (r.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
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

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', function () {
    switch (window.SM_PAGE) {
      case 'dashboard': initDashboard(); break;
      case 'monitoring': initMonitoring(); break;
      case 'mail': initMail(); break;
      case 'antivirus': initAntivirus(); break;
      case 'servers': initServers(); break;
      case 'logs': initLogs(); break;
      case 'alerts': initAlerts(); break;
      default: break;
    }
  });
})();
