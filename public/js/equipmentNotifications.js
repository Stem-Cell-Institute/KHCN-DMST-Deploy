(function () {
  function byId(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  function token() {
    try {
      return localStorage.getItem('token');
    } catch (e) {
      return null;
    }
  }

  function isIncidentReportNotification(n) {
    if (!n) return false;
    var eventType = String(n.event_type || '').toLowerCase();
    return eventType === 'equip_incident';
  }

  function mount() {
    var host = byId('eq-equipment-notifications');
    if (!host) return;
    var t = token();
    if (!t) {
      host.innerHTML = '';
      host.classList.add('nav-hidden');
      return;
    }
    host.classList.remove('nav-hidden');
    host.innerHTML =
      '<div class="eq-notif-box">' +
      '<button type="button" class="eq-notif-toggle" id="eq-notif-toggle" aria-expanded="false">' +
      '<span>Thông báo thiết bị</span>' +
      '<span class="eq-notif-badge" id="eq-notif-badge" hidden>0</span>' +
      '</button>' +
      '<div class="eq-notif-panel nav-hidden" id="eq-notif-panel" role="region" aria-label="Thông báo module thiết bị"></div>' +
      '</div>';

    var panel = byId('eq-notif-panel');
    var badge = byId('eq-notif-badge');
    var toggle = byId('eq-notif-toggle');

    function render(rows) {
      var unread = 0;
      (rows || []).forEach(function (r) {
        if (!r.read_at) unread += 1;
      });
      if (unread > 0) {
        badge.hidden = false;
        badge.textContent = String(unread > 99 ? '99+' : unread);
      } else {
        badge.hidden = true;
      }
      if (!rows || !rows.length) {
        panel.innerHTML = '<p class="eq-notif-empty">Chưa có thông báo.</p>';
        return;
      }
      panel.innerHTML = rows
        .map(function (r) {
          var unreadCls = r.read_at ? '' : ' eq-notif-item--unread';
          var link = r.link ? '<a class="eq-notif-link" href="' + esc(r.link) + '">Mở</a>' : '';
          return (
            '<div class="eq-notif-item' +
            unreadCls +
            '" data-nid="' +
            esc(r.id) +
            '">' +
            '<div class="eq-notif-item__title">' +
            esc(r.title) +
            '</div>' +
            '<div class="eq-notif-item__meta">' +
            esc(r.created_at || '') +
            '</div>' +
            (r.body ? '<div class="eq-notif-item__body">' + esc(r.body) + '</div>' : '') +
            '<div class="eq-notif-item__actions">' +
            link +
            (r.read_at
              ? ''
              : ' <button type="button" class="eq-notif-read" data-read="' +
                esc(r.id) +
                '">Đánh dấu đã đọc</button>') +
            '</div></div>'
          );
        })
        .join('');
    }

    function load() {
      if (!window.equipmentApi || !window.equipmentApi.getJson) return;
      window.equipmentApi.getJson('/notifications?limit=30').then(function (r) {
        if (!r.ok || !r.data || !r.data.data) {
          panel.innerHTML = '<p class="eq-notif-empty">Không tải được thông báo.</p>';
          return;
        }
        var filtered = (r.data.data || []).filter(function (n) {
          return isIncidentReportNotification(n) && !n.read_at;
        });
        render(filtered);
      });
    }

    window.equipmentNotifications = window.equipmentNotifications || {};
    window.equipmentNotifications.refresh = load;

    toggle.addEventListener('click', function () {
      var open = panel.classList.contains('nav-hidden');
      panel.classList.toggle('nav-hidden', !open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) load();
    });

    panel.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-read]');
      if (!btn) return;
      var nid = btn.getAttribute('data-read');
      if (!nid) return;
      window.equipmentApi.sendJson('PATCH', '/notifications/' + encodeURIComponent(nid) + '/read', {}).then(function () {
        load();
      });
    });

    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
