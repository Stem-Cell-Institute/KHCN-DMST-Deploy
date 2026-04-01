/**
 * Phân tích sử dụng thiết bị — tab Quản trị CRD
 * Phụ thuộc: Chart.js (CDN), public/css/equipmentAnalytics.css
 */
(function () {
  'use strict';

  const API = '/api/equipment-analytics';

  async function eaApi(path, opt) {
    const method = (opt && opt.method ? opt.method : 'GET').toUpperCase();
    const headers = Object.assign(
      {},
      method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      (opt && opt.headers) || {}
    );
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opt || {}, { headers }));
    const text = await r.text();
    var j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!r.ok) throw new Error((j && j.message) || text || String(r.status));
    return j;
  }

  function padDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function monthRangeDefault() {
    var now = new Date();
    var y = now.getFullYear();
    var m = now.getMonth();
    var from = new Date(y, m, 1);
    var to = new Date(y, m + 1, 0);
    return { from: padDate(from), to: padDate(to) };
  }

  function qs(obj) {
    var p = new URLSearchParams();
    Object.keys(obj).forEach(function (k) {
      if (obj[k] != null && obj[k] !== '') p.set(k, String(obj[k]));
    });
    var s = p.toString();
    return s ? '?' + s : '';
  }

  function mergeTrends(equipment) {
    var byDate = {};
    (equipment || []).forEach(function (eq) {
      (eq.trend || []).forEach(function (t) {
        if (!byDate[t.date]) byDate[t.date] = { sum: 0, n: 0 };
        byDate[t.date].sum += Number(t.rate) || 0;
        byDate[t.date].n += 1;
      });
    });
    return Object.keys(byDate)
      .sort()
      .map(function (date) {
        var v = byDate[date];
        return { date: date, rate: v.n ? Math.round((v.sum / v.n) * 100) / 100 : 0 };
      });
  }

  var state = {
    charts: { bar: null, line: null, pie: null },
    bound: false,
    sort: { key: 'total_hours', dir: -1 },
  };

  function destroyCharts() {
    ['bar', 'line', 'pie'].forEach(function (k) {
      if (state.charts[k]) {
        try {
          state.charts[k].destroy();
        } catch (_) {}
        state.charts[k] = null;
      }
    });
  }

  function setLoading(isLoading) {
    var root = document.getElementById('ea-root');
    if (!root) return;
    root.classList.toggle('ea-loading', isLoading);
    var sk = document.getElementById('ea-skeleton');
    var content = document.getElementById('ea-content');
    if (sk) sk.style.display = isLoading ? 'block' : 'none';
    if (content) content.style.display = isLoading ? 'none' : '';
  }

  function heatmapColor(utilPct) {
    var t = Math.max(0, Math.min(1, (utilPct || 0) / 100));
    var r = Math.round(255 - t * 200);
    var g = Math.round(255 - t * 140);
    var b = 255;
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function renderHeatmap(data) {
    var host = document.getElementById('ea-heatmap');
    if (!host || !data || !data.days) return;
    var hours = data.hours || [];
    var days = data.days || [];
    var cells = data.cells || [];

    var thead =
      '<tr><th class="ea-h-day">Ngày \\ Giờ</th>' +
      hours.map(function (h) {
        return '<th>' + String(h).padStart(2, '0') + ':00</th>';
      }).join('') +
      '</tr>';

    var tbody = days
      .map(function (day, ri) {
        var row = cells[ri] || [];
        return (
          '<tr><td class="ea-h-day">' +
          day +
          '</td>' +
          row
            .map(function (cell, ci) {
              var util = typeof cell.utilization === 'number' ? cell.utilization : 0;
              var title =
                'Ngày ' +
                day +
                ' ' +
                String(hours[ci]).padStart(2, '0') +
                ':00–' +
                String(hours[ci] + 1).padStart(2, '0') +
                ':00 | Lịch: ' +
                cell.bookings +
                ' | Giờ: ' +
                cell.hours +
                ' h';
              return (
                '<td class="ea-h-cell" style="background:' +
                heatmapColor(util) +
                '" title="' +
                esc(title) +
                '"></td>'
              );
            })
            .join('') +
          '</tr>'
        );
      })
      .join('');

    host.innerHTML = '<table class="ea-heatmap">' + thead + tbody + '</table>';
  }

  function updateCards(util, behavior, maint) {
    var eq = (util && util.equipment) || [];
    var n = eq.length || 1;
    var avgU =
      eq.length > 0
        ? Math.round((eq.reduce(function (a, e) {
            return a + (Number(e.utilization_rate) || 0);
          }, 0) /
            eq.length) *
            100) /
          100
        : 0;
    var avgBooked =
      eq.length > 0
        ? Math.round((eq.reduce(function (a, e) {
            return a + (Number(e.total_booked_hours) || 0);
          }, 0) /
            eq.length) *
            100) /
          100
        : 0;
    var cancelR = behavior && behavior.cancellation_stats ? behavior.cancellation_stats.cancellation_rate : 0;
    var needMaint = (maint && maint.equipment ? maint.equipment : []).filter(function (e) {
      return e.maintenance_urgency !== 'ok';
    }).length;

    var el = function (id, v) {
      var n = document.getElementById(id);
      if (n) n.textContent = v;
    };
    el('ea-card-util', avgU + '%');
    el('ea-card-hours', String(avgBooked));
    el('ea-card-cancel', String(cancelR) + '%');
    el('ea-card-maint', String(needMaint));
  }

  function renderBarChart(equipment) {
    var canvas = document.getElementById('ea-chart-bar');
    if (!canvas || typeof Chart === 'undefined') return;
    if (state.charts.bar) state.charts.bar.destroy();
    var labels = equipment.map(function (e) {
      return e.name;
    });
    var data = equipment.map(function (e) {
      return Number(e.utilization_rate) || 0;
    });
    state.charts.bar = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Utilization %',
            data: data,
            backgroundColor: 'rgba(102, 126, 234, 0.75)',
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, max: 100, title: { display: true, text: '%' } },
        },
      },
    });
  }

  function renderLineChart(trendPoints) {
    var canvas = document.getElementById('ea-chart-line');
    if (!canvas || typeof Chart === 'undefined') return;
    if (state.charts.line) state.charts.line.destroy();
    state.charts.line = new Chart(canvas, {
      type: 'line',
      data: {
        labels: trendPoints.map(function (t) {
          return t.date;
        }),
        datasets: [
          {
            label: 'TB utilization % (tất cả TB)',
            data: trendPoints.map(function (t) {
              return t.rate;
            }),
            borderColor: '#764ba2',
            backgroundColor: 'rgba(118, 75, 162, 0.1)',
            fill: true,
            tension: 0.25,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        scales: { y: { beginAtZero: true, max: 100 } },
      },
    });
  }

  function renderPieChart(groups) {
    var canvas = document.getElementById('ea-chart-pie');
    if (!canvas || typeof Chart === 'undefined') return;
    if (state.charts.pie) state.charts.pie.destroy();
    var labels = groups.map(function (g) {
      return g.group_name;
    });
    var data = groups.map(function (g) {
      return Number(g.total_hours) || 0;
    });
    state.charts.pie = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: [
              '#667eea',
              '#764ba2',
              '#4caf88',
              '#f5a623',
              '#e05c6a',
              '#42a5f5',
              '#ab47bc',
              '#26a69a',
            ],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right' } },
      },
    });
  }

  function sortUsers(rows) {
    var k = state.sort.key;
    var d = state.sort.dir;
    return rows.slice().sort(function (a, b) {
      var va = a[k];
      var vb = b[k];
      if (typeof va === 'string') {
        va = va.toLowerCase();
        vb = (vb || '').toLowerCase();
      }
      if (va < vb) return d;
      if (va > vb) return -d;
      return 0;
    });
  }

  function renderUsersTable(topUsers) {
    var tbody = document.getElementById('ea-users-tbody');
    if (!tbody) return;
    var rows = sortUsers(topUsers || []);
    tbody.innerHTML = rows
      .map(function (u) {
        return (
          '<tr><td>' +
          esc(u.user_id) +
          '</td><td>' +
          esc(u.full_name) +
          '</td><td>' +
          esc(u.group) +
          '</td><td style="text-align:right;">' +
          u.total_hours +
          '</td><td style="text-align:right;">' +
          u.booking_count +
          '</td><td style="text-align:right;">' +
          u.cancellation_rate +
          '%</td></tr>'
        );
      })
      .join('');
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function bindSortHeaders() {
    document.querySelectorAll('#ea-users-table th[data-sort]').forEach(function (th) {
      th.onclick = function () {
        var k = th.getAttribute('data-sort');
        if (state.sort.key === k) state.sort.dir *= -1;
        else {
          state.sort.key = k;
          state.sort.dir = -1;
        }
        refresh();
      };
    });
  }

  function renderCancelStats(cs) {
    var el = document.getElementById('ea-cancel-stats');
    if (!el || !cs) return;
    el.innerHTML =
      '<table class="data-table" style="width:100%;max-width:560px;"><thead><tr>' +
      '<th>Chỉ số</th><th style="text-align:right;">Giá trị</th></tr></thead><tbody>' +
      '<tr><td>Tổng lịch (trong kỳ)</td><td style="text-align:right;">' +
      cs.total_bookings +
      '</td></tr>' +
      '<tr><td>Tổng hủy</td><td style="text-align:right;">' +
      cs.total_cancelled +
      '</td></tr>' +
      '<tr><td>Tỷ lệ hủy</td><td style="text-align:right;">' +
      cs.cancellation_rate +
      '%</td></tr>' +
      '<tr><td>Hủy muộn (&lt; 2h trước giờ)</td><td style="text-align:right;">' +
      cs.late_cancellations +
      '</td></tr>' +
      '<tr><td>No-show</td><td style="text-align:right;">' +
      cs.no_shows +
      '</td></tr>' +
      '<tr><td>Thời gian đặt trước (TB, giờ)</td><td style="text-align:right;">' +
      (cs.lead_time_avg_hours != null ? cs.lead_time_avg_hours : '—') +
      '</td></tr>' +
      '</tbody></table>';
  }

  function badgeClass(u) {
    if (u === 'overdue') return 'ea-badge ea-badge-over';
    if (u === 'warning') return 'ea-badge ea-badge-warn';
    return 'ea-badge ea-badge-ok';
  }

  function badgeLabel(u) {
    if (u === 'overdue') return '🔴 Quá hạn';
    if (u === 'warning') return '🟡 Sắp đến hạn';
    return '🟢 OK';
  }

  function renderMaintList(equipment) {
    var host = document.getElementById('ea-maint-list');
    if (!host) return;
    host.innerHTML = (equipment || [])
      .map(function (e) {
        var pct = e.maintenance_threshold_hours
          ? Math.min(100, (e.accumulated_hours / e.maintenance_threshold_hours) * 100)
          : 0;
        return (
          '<div class="ea-maint-row">' +
          '<div style="min-width:140px;font-weight:600;">' +
          esc(e.name) +
          '</div>' +
          '<span class="' +
          badgeClass(e.maintenance_urgency) +
          '">' +
          badgeLabel(e.maintenance_urgency) +
          '</span>' +
          '<div class="ea-maint-bar"><i style="width:' +
          pct +
          '%"></i></div>' +
          '<span style="font-size:12px;color:var(--muted);white-space:nowrap;">' +
          e.accumulated_hours +
          ' / ' +
          e.maintenance_threshold_hours +
          ' giờ (tích lũy / ngưỡng)</span>' +
          '<div class="ea-maint-thr">' +
          '<span>Ngưỡng bảo trì</span>' +
          '<input type="number" class="ea-thr-input" min="1" max="100000" step="1" value="' +
          esc(String(e.maintenance_threshold_hours)) +
          '" title="Số giờ sử dụng tích lũy tối đa trước khi cần bảo trì"/>' +
          '<span>giờ</span>' +
          '<button type="button" class="btn btn-ghost btn-sm ea-mt-save-thr" data-ea-save-thr="' +
          esc(e.id) +
          '">Lưu</button>' +
          '</div>' +
          '<button type="button" class="btn btn-primary btn-sm" data-ea-maint="' +
          esc(e.id) +
          '">Ghi nhận bảo trì</button>' +
          '</div>'
        );
      })
      .join('');

    host.querySelectorAll('[data-ea-maint]').forEach(function (btn) {
      btn.onclick = function () {
        openMaintModal(btn.getAttribute('data-ea-maint'));
      };
    });
  }

  function renderMaintLogs(logs) {
    var tbody = document.getElementById('ea-maint-logs-tbody');
    if (!tbody) return;
    tbody.innerHTML = (logs || [])
      .map(function (l) {
        return (
          '<tr><td>' +
          esc(l.equipment_name) +
          '</td><td>' +
          esc(l.maintenance_date) +
          '</td><td style="text-align:right;" title="Giờ tích lũy trong chu kỳ vừa kết thúc (trước khi reset về 0)">' +
          (l.hours_at_maintenance != null ? esc(l.hours_at_maintenance) : '—') +
          '</td><td>' +
          esc(l.type || '—') +
          '</td><td>' +
          esc(l.performed_by || '—') +
          '</td><td style="text-align:right;">' +
          (l.cost != null ? l.cost : '—') +
          '</td><td>' +
          esc(l.notes || '') +
          '</td></tr>'
        );
      })
      .join('');
  }

  function openMaintModal(equipmentId) {
    document.getElementById('ea-mt-eid').value = equipmentId;
    document.getElementById('ea-mt-date').value = padDate(new Date());
    document.getElementById('ea-mt-type').value = 'preventive';
    document.getElementById('ea-mt-by').value = '';
    document.getElementById('ea-mt-cost').value = '';
    document.getElementById('ea-mt-notes').value = '';
    document.getElementById('ea-mt-alert').innerHTML = '';
    var modal = document.getElementById('modal-ea-maint');
    if (modal) {
      modal.classList.add('show');
      if (modal.classList.contains('modal-overlay')) modal.style.display = 'flex';
    }
  }

  window.closeEaMaintModal = function () {
    var modal = document.getElementById('modal-ea-maint');
    if (!modal) return;
    modal.classList.remove('show');
    if (modal.classList.contains('modal-overlay')) modal.style.display = 'none';
  };

  window.submitEaMaint = async function () {
    var alertEl = document.getElementById('ea-mt-alert');
    try {
      await eaApi(API + '/maintenance-log', {
        method: 'POST',
        body: JSON.stringify({
          equipment_id: document.getElementById('ea-mt-eid').value,
          maintenance_date: document.getElementById('ea-mt-date').value,
          type: document.getElementById('ea-mt-type').value,
          performed_by: document.getElementById('ea-mt-by').value.trim(),
          cost: document.getElementById('ea-mt-cost').value,
          notes: document.getElementById('ea-mt-notes').value,
        }),
      });
      closeEaMaintModal();
      await refresh();
    } catch (e) {
      if (alertEl) alertEl.innerHTML = '<div class="alert alert-err">' + esc(e.message) + '</div>';
    }
  };

  function getFilterQuery() {
    var from = document.getElementById('ea-from').value;
    var to = document.getElementById('ea-to').value;
    var equip = document.getElementById('ea-equip').value;
    return { from: from, to: to, equipment_id: equip || '' };
  }

  async function refresh() {
    var q = getFilterQuery();
    if (!q.from || !q.to) return;
    setLoading(true);
    destroyCharts();
    var errEl = document.getElementById('ea-error');
    if (errEl) errEl.innerHTML = '';
    try {
      var qStr = qs({ from: q.from, to: q.to, equipment_id: q.equipment_id || undefined });
      var qUtil = qs({
        from: q.from,
        to: q.to,
        group_by: 'day',
        equipment_id: q.equipment_id || undefined,
      });

      var util = await eaApi(API + '/utilization' + qUtil);
      var beh = await eaApi(API + '/user-behavior' + qStr);
      var maint = await eaApi(API + '/maintenance-status');
      var heat = await eaApi(API + '/usage-heatmap' + qStr);
      var mlogs = await eaApi(API + '/maintenance-logs' + qs({ from: q.from, to: q.to }));

      updateCards(util, beh, maint);
      renderBarChart(util.equipment || []);
      renderLineChart(mergeTrends(util.equipment || []));
      renderPieChart(beh.top_groups || []);
      renderHeatmap(heat);
      renderUsersTable(beh.top_users || []);
      renderCancelStats(beh.cancellation_stats, beh.lead_time_avg_hours);
      renderMaintList(maint.equipment || []);
      renderMaintLogs(mlogs.logs || []);
    } catch (e) {
      console.error(e);
      var err = document.getElementById('ea-error');
      if (err) err.innerHTML = '<div class="alert alert-err">' + esc(e.message) + '</div>';
    } finally {
      setLoading(false);
    }
  }

  function exportFile(fmt) {
    var q = getFilterQuery();
    var url = API + '/report/export?' + new URLSearchParams({ format: fmt, from: q.from, to: q.to }).toString();
    window.location.href = url;
  }

  window.exportEaExcel = function () {
    exportFile('excel');
  };
  window.exportEaWord = function () {
    exportFile('word');
  };

  function switchEaSub(id) {
    document.querySelectorAll('.ea-subtab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-ea-sub') === id);
    });
    document.querySelectorAll('.ea-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'ea-panel-' + id);
    });
  }

  window.switchEaSub = switchEaSub;

  function setMachineOptions(machines) {
    var sel = document.getElementById('ea-equip');
    if (!sel) return;
    sel.innerHTML =
      '<option value="">Tất cả thiết bị</option>' +
      (machines || [])
        .map(function (m) {
          return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
        })
        .join('');
  }

  function init() {
    var dr = monthRangeDefault();
    var fromEl = document.getElementById('ea-from');
    var toEl = document.getElementById('ea-to');
    if (fromEl && !fromEl.value) fromEl.value = dr.from;
    if (toEl && !toEl.value) toEl.value = dr.to;

    if (!state.bound) {
      var apply = document.getElementById('ea-apply');
      if (apply) apply.onclick = function () { refresh(); };
      var x1 = document.getElementById('ea-export-xlsx');
      var x2 = document.getElementById('ea-export-docx');
      if (x1) x1.onclick = exportEaExcel;
      if (x2) x2.onclick = exportEaWord;
      bindSortHeaders();
      state.bound = true;
    }
    switchEaSub('overview');
    refresh();
  }

  window.EquipmentAnalytics = {
    init: init,
    refresh: refresh,
    setMachineOptions: setMachineOptions,
  };
})();
