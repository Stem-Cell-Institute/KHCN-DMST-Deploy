/**
 * Quản lý quyền xem dashboard công bố (chỉ Admin).
 */

(function () {
  const DASH_ID = 'pub_analytics';

  function getToken() {
    return localStorage.getItem('token');
  }

  function authHeaders(json) {
    const h = { Accept: 'application/json' };
    const t = getToken();
    if (t) h.Authorization = 'Bearer ' + t;
    if (json) h['Content-Type'] = 'application/json';
    return h;
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

  function fmtDate(s) {
    if (!s) return '—';
    try {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return s;
      return d.toLocaleDateString('vi-VN');
    } catch (e) {
      return s;
    }
  }

  let searchTimer = null;
  let searchHits = [];

  async function loadList() {
    const res = await fetch('/api/dashboard-perms/' + DASH_ID, { headers: authHeaders() });
    if (!res.ok) {
      toast('Không tải được danh sách quyền', false);
      return;
    }
    const j = await res.json();
    const rows = j.data || [];
    const box = document.getElementById('dp-list');
    box.innerHTML = '';
    if (!rows.length) {
      box.innerHTML = '<div class="dp-row"><span></span><span>Chưa cấp quyền cho ai.</span></div>';
      return;
    }
    rows.forEach(function (r) {
      const div = document.createElement('div');
      div.className = 'dp-row';
      div.innerHTML =
        '<input type="checkbox" data-uid="' +
        r.user_id +
        '" />' +
        '<div><strong>' +
        esc(r.fullname || r.email) +
        '</strong><div class="dp-meta">' +
        esc(r.email) +
        ' · ' +
        esc(r.role) +
        ' · Cấp: ' +
        fmtDate(r.granted_at) +
        ' · Hết hạn: ' +
        (r.expires_at ? fmtDate(r.expires_at) : '—') +
        '</div></div>' +
        '<button type="button" class="pd-btn pd-btn-ghost dp-revoke" data-uid="' +
        r.user_id +
        '">Thu hồi</button>';
      box.appendChild(div);
    });

    box.querySelectorAll('.dp-revoke').forEach(function (btn) {
      btn.addEventListener('click', function () {
        revokeOne(Number(btn.getAttribute('data-uid')));
      });
    });
  }

  function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  async function revokeOne(userId) {
    if (!confirm('Thu hồi quyền user #' + userId + '?')) return;
    const res = await fetch('/api/dashboard-perms/' + DASH_ID + '/' + userId, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    if (!res.ok) {
      toast('Thu hồi thất bại', false);
      return;
    }
    toast('Đã thu hồi', true);
    loadList();
  }

  async function revokeSelected() {
    const box = document.getElementById('dp-list');
    const cbs = box.querySelectorAll('input[type="checkbox"]:checked');
    if (!cbs.length) {
      toast('Chọn ít nhất một dòng', false);
      return;
    }
    if (!confirm('Thu hồi quyền các user đã chọn?')) return;
    for (let i = 0; i < cbs.length; i++) {
      const uid = Number(cbs[i].getAttribute('data-uid'));
      const res = await fetch('/api/dashboard-perms/' + DASH_ID + '/' + uid, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      if (!res.ok) {
        toast('Lỗi thu hồi user ' + uid, false);
        return;
      }
    }
    toast('Đã thu hồi', true);
    loadList();
  }

  async function addUser(userId, expiresAt) {
    const body = { user_ids: [userId], expires_at: expiresAt || null };
    const res = await fetch('/api/dashboard-perms/' + DASH_ID, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      toast('Thêm thất bại: ' + t.slice(0, 120), false);
      return;
    }
    toast('Đã cấp quyền', true);
    document.getElementById('dp-search').value = '';
    document.getElementById('dp-ac-list').innerHTML = '';
    document.getElementById('dp-ac-list').hidden = true;
    loadList();
  }

  async function grantGroup() {
    const sel = document.getElementById('dp-group');
    const g = sel.value;
    if (!g) {
      toast('Chọn nhóm', false);
      return;
    }
    const exp = document.getElementById('dp-expires').value.trim() || null;
    const res = await fetch('/api/dashboard-perms/' + DASH_ID, {
      method: 'POST',
      headers: authHeaders(true),
      body: JSON.stringify({ group: g, expires_at: exp }),
    });
    if (!res.ok) {
      toast('Cấp nhóm thất bại', false);
      return;
    }
    const j = await res.json();
    toast('Đã cấp quyền cho ' + (j.granted || 0) + ' tài khoản', true);
    loadList();
  }

  function runSearch(q) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async function () {
      const list = document.getElementById('dp-ac-list');
      if (q.length < 1) {
        list.innerHTML = '';
        list.hidden = true;
        return;
      }
      const res = await fetch('/api/users/search?q=' + encodeURIComponent(q), {
        headers: authHeaders(),
      });
      if (!res.ok) {
        list.innerHTML = '';
        list.hidden = true;
        return;
      }
      const j = await res.json();
      searchHits = j.data || [];
      list.innerHTML = '';
      searchHits.forEach(function (u) {
        const div = document.createElement('div');
        div.className = 'dp-ac-item';
        div.textContent = (u.fullname || '') + ' · ' + u.email + ' (' + u.role + ')';
        div.addEventListener('click', function () {
          const exp = document.getElementById('dp-expires').value.trim() || null;
          addUser(u.id, exp);
        });
        list.appendChild(div);
      });
      list.hidden = searchHits.length === 0;
    }, 280);
  }

  document.addEventListener('DOMContentLoaded', function () {
    const search = document.getElementById('dp-search');
    if (search) {
      search.addEventListener('input', function () {
        runSearch(search.value.trim());
      });
    }
    const btnRev = document.getElementById('dp-btn-revoke-selected');
    if (btnRev) btnRev.addEventListener('click', revokeSelected);
    const btnGrp = document.getElementById('dp-btn-grant-group');
    if (btnGrp) btnGrp.addEventListener('click', grantGroup);
  });

  window.DashboardPermissions = {
    reload: loadList,
  };
})();
