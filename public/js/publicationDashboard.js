/**
 * Dashboard phân tích công bố — Chart.js + API /api/pub-analytics
 * Quyền: admin hoặc dashboard_permissions (pub_analytics).
 */

(function () {
  const DASH_ID = 'pub_analytics';

  function getToken() {
    return localStorage.getItem('token');
  }

  function authHeaders() {
    const t = getToken();
    const h = { Accept: 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...authHeaders(), ...(opts && opts.headers) },
    });
    return res;
  }

  function toast(msg, ok) {
    const el = document.createElement('div');
    el.className = 'pd-toast ' + (ok ? 'ok' : 'err');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 3200);
  }

  function getUser() {
    try {
      return JSON.parse(localStorage.getItem('user') || '{}');
    } catch (e) {
      return {};
    }
  }

  function isAdmin() {
    return String(getUser().role || '').toLowerCase() === 'admin';
  }

  let chartBar = null;
  let chartDoughnut = null;
  let chartLine = null;

  function destroyCharts() {
    [chartBar, chartDoughnut, chartLine].forEach(function (c) {
      if (c) {
        try {
          c.destroy();
        } catch (e) {}
      }
    });
    chartBar = chartDoughnut = chartLine = null;
  }

  async function loadDashboard() {
    const fromEl = document.getElementById('pd-filter-from');
    const toEl = document.getElementById('pd-filter-to');
    const from = parseInt(fromEl.value, 10);
    const to = parseInt(toEl.value, 10);
    if (!from || !to || from > to) {
      toast('Chọn khoảng năm hợp lệ', false);
      return;
    }

    const qs = 'from=' + from + '&to=' + to;

    const [kpiR, yearlyR, quartR, ifR, topCitR, topJrR] = await Promise.all([
      api('/api/pub-analytics/kpi-range?' + qs),
      api('/api/pub-analytics/yearly-output?' + qs),
      api('/api/pub-analytics/quartile-distribution?' + qs),
      api('/api/pub-analytics/yearly-if?' + qs),
      api('/api/pub-analytics/citations-ranking?limit=10&' + qs),
      api('/api/pub-analytics/top-journals?limit=10&' + qs),
    ]);

    const checks = [kpiR, yearlyR, quartR, ifR, topCitR, topJrR];
    for (let i = 0; i < checks.length; i++) {
      if (!checks[i].ok) {
        toast('Không tải được dữ liệu (' + checks[i].status + ')', false);
        return;
      }
    }

    const kpiJ = await kpiR.json();
    const yearlyJ = await yearlyR.json();
    const quartJ = await quartR.json();
    const ifJ = await ifR.json();
    const topCitJ = await topCitR.json();
    const topJrJ = await topJrR.json();

    const kpi = kpiJ.data || {};
    document.getElementById('pd-kpi-papers').textContent = kpi.total_papers ?? '0';
    document.getElementById('pd-kpi-tier').textContent = kpi.top_tier_count ?? '0';
    document.getElementById('pd-kpi-if').textContent =
      kpi.avg_if != null ? String(kpi.avg_if) : '—';
    document.getElementById('pd-kpi-cite').textContent = kpi.total_citations ?? '0';

    const yearly = yearlyJ.data || [];
    const labels = yearly.map(function (r) {
      return String(r.year);
    });
    const totals = yearly.map(function (r) {
      return r.total_papers || 0;
    });

    destroyCharts();
    const ctxBar = document.getElementById('pd-chart-bar');
    if (ctxBar && window.Chart) {
      chartBar = new Chart(ctxBar, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Số bài / năm',
              data: totals,
              backgroundColor: 'rgba(28, 79, 138, 0.75)',
            },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true } },
        },
      });
    }

    const qRows = quartJ.data || [];
    let q1 = 0,
      q2 = 0,
      q3 = 0,
      q4 = 0;
    qRows.forEach(function (r) {
      q1 += r.q1 || 0;
      q2 += r.q2 || 0;
      q3 += r.q3 || 0;
      q4 += r.q4 || 0;
    });
    const ctxD = document.getElementById('pd-chart-doughnut');
    if (ctxD && window.Chart) {
      chartDoughnut = new Chart(ctxD, {
        type: 'doughnut',
        data: {
          labels: ['Q1', 'Q2', 'Q3', 'Q4'],
          datasets: [
            {
              data: [q1, q2, q3, q4],
              backgroundColor: ['#1c4f8a', '#2e7d4a', '#c49000', '#8a5a9c'],
            },
          ],
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } },
      });
    }

    const ifRows = ifJ.data || [];
    const ctxL = document.getElementById('pd-chart-line');
    if (ctxL && window.Chart) {
      chartLine = new Chart(ctxL, {
        type: 'line',
        data: {
          labels: ifRows.map(function (r) {
            return String(r.year);
          }),
          datasets: [
            {
              label: 'IF trung bình',
              data: ifRows.map(function (r) {
                return r.avg_if != null ? Number(r.avg_if) : null;
              }),
              borderColor: '#c8490e',
              backgroundColor: 'rgba(200, 73, 14, 0.1)',
              fill: true,
              tension: 0.2,
            },
          ],
        },
        options: {
          responsive: true,
          scales: { y: { beginAtZero: false } },
        },
      });
    }

    const tbody = document.querySelector('#pd-table-top-cited tbody');
    tbody.innerHTML = '';
    (topCitJ.data || []).forEach(function (r, i) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' +
        (i + 1) +
        '</td><td>' +
        esc(r.title) +
        '</td><td>' +
        esc(r.journal_name) +
        '</td><td>' +
        esc(r.pub_year) +
        '</td><td>' +
        esc(r.quartile) +
        '</td><td>' +
        esc(r.impact_factor) +
        '</td><td>' +
        esc(r.citation_count) +
        '</td>';
      tbody.appendChild(tr);
    });

    const tbj = document.querySelector('#pd-table-top-journals tbody');
    tbj.innerHTML = '';
    (topJrJ.data || []).forEach(function (r, i) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' +
        (i + 1) +
        '</td><td>' +
        esc(r.journal_name) +
        '</td><td>' +
        esc(r.paper_count) +
        '</td><td>' +
        esc(r.total_citations) +
        '</td><td>' +
        esc(r.avg_if) +
        '</td>';
      tbj.appendChild(tr);
    });
  }

  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  async function exportWord() {
    const from = document.getElementById('pd-filter-from').value;
    const to = document.getElementById('pd-filter-to').value;
    const uid = getUser().id || '';
    const url =
      '/api/pub-analytics/report/export-word?from=' +
      encodeURIComponent(from) +
      '&to=' +
      encodeURIComponent(to) +
      '&generated_by=' +
      encodeURIComponent(uid);
    await downloadBlob(url, 'word');
  }

  async function exportExcel() {
    const from = document.getElementById('pd-filter-from').value;
    const to = document.getElementById('pd-filter-to').value;
    const url =
      '/api/pub-analytics/report/export-excel?from=' +
      encodeURIComponent(from) +
      '&to=' +
      encodeURIComponent(to);
    await downloadBlob(url, 'excel');
  }

  async function downloadBlob(url, kind) {
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      let err = 'Lỗi xuất file';
      try {
        const j = await res.json();
        if (j.error) err = j.error;
      } catch (e) {}
      toast(err, false);
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    let name = 'export.' + (kind === 'excel' ? 'xlsx' : 'docx');
    const m = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/i.exec(cd);
    if (m) {
      try {
        name = decodeURIComponent(m[1] || m[2] || name);
      } catch (e) {
        name = m[2] || name;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Đã tải xuống', true);
  }

  async function gate() {
    const res = await api('/api/dashboard-perms/' + DASH_ID + '/check');
    const j = await res.json();
    const allowed = res.ok && j.allowed;

    document.getElementById('pd-denied').hidden = allowed;
    document.getElementById('pd-main').hidden = !allowed;

    if (!allowed) return;

    const y = new Date().getFullYear();
    document.getElementById('pd-filter-from').value = y - 5;
    document.getElementById('pd-filter-to').value = y;

    if (isAdmin()) {
      document.getElementById('pd-tab-perms').hidden = false;
    }

    loadDashboard();
  }

  function switchTab(which) {
    document.getElementById('pd-tab-btn-dash').classList.toggle('active', which === 'dash');
    document.getElementById('pd-tab-btn-perms').classList.toggle('active', which === 'perms');
    document.getElementById('pd-panel-dash').hidden = which !== 'dash';
    document.getElementById('pd-panel-perms').hidden = which !== 'perms';
    if (which === 'perms' && window.DashboardPermissions && window.DashboardPermissions.reload) {
      window.DashboardPermissions.reload();
    }
  }

  document.getElementById('pd-btn-apply').addEventListener('click', function () {
    loadDashboard();
  });
  document.getElementById('pd-btn-word').addEventListener('click', exportWord);
  document.getElementById('pd-btn-excel').addEventListener('click', exportExcel);
  document.getElementById('pd-tab-btn-dash').addEventListener('click', function () {
    switchTab('dash');
  });
  document.getElementById('pd-tab-btn-perms').addEventListener('click', function () {
    switchTab('perms');
  });

  window.addEventListener('DOMContentLoaded', gate);
})();
