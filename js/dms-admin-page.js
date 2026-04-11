/**
 * Quản trị module Tài liệu & hồ sơ — danh mục, loại, thẻ; tab phân quyền chỉ Master Admin.
 */
(function () {
  var apiBase =
    window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')
      ? 'http://localhost:3000'
      : '';

  function getToken() {
    return localStorage.getItem('token') || '';
  }

  function authHeaders(json) {
    var h = { Accept: 'application/json', Authorization: 'Bearer ' + getToken() };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async function api(path, opts) {
    opts = opts || {};
    var r = await fetch(apiBase + '/api/dms' + path, Object.assign({ headers: authHeaders(!!opts.body) }, opts));
    var j = {};
    try {
      j = await r.json();
    } catch (e) {}
    if (!r.ok) throw new Error(j.message || 'Lỗi ' + r.status);
    return j;
  }

  async function apiUsersSearch(q) {
    var r = await fetch(apiBase + '/api/users/search?q=' + encodeURIComponent(q), {
      headers: authHeaders(),
    });
    var j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Lỗi tìm user');
    return j.data || [];
  }

  /**
   * Lấy user id: ưu tiên hidden đã chọn từ gợi ý; nếu trống thì gọi API tìm kiếm và khớp email đúng (không bắt buộc click gợi ý).
   */
  async function resolveUserIdFromSearch(hiddenInput, searchInput) {
    var uid = Number(hiddenInput.value);
    if (uid && !isNaN(uid)) return uid;
    var q = String(searchInput.value || '').trim();
    if (!q) {
      throw new Error('Nhập email hoặc tên người dùng.');
    }
    var rows = await apiUsersSearch(q);
    var qLower = q.toLowerCase();
    var exactEmail = rows.filter(function (u) {
      return (u.email || '').toLowerCase() === qLower;
    });
    if (exactEmail.length === 1) {
      return exactEmail[0].id;
    }
    if (exactEmail.length > 1) {
      throw new Error('Có nhiều tài khoản trùng email — chọn một dòng trong gợi ý tìm kiếm.');
    }
    throw new Error(
      'Không tìm thấy người dùng khớp email «' +
        q +
        '». Kiểm tra chính tả, hoặc gõ vài ký tự rồi chọn từ gợi ý.'
    );
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function dmsModuleRoleLabel(role) {
    var r = String(role || '').toLowerCase();
    if (r === 'manager') return 'Quản lý module';
    if (r === 'uploader') return 'Người tải lên';
    if (r === 'viewer') return 'Chỉ xem';
    return role ? escapeHtml(role) : '—';
  }

  var state = {
    me: null,
    categories: [],
    types: [],
    tags: [],
    moduleUsers: [],
    moduleAccess: [],
    accessIdSet: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  async function refreshCategories() {
    var d = await api('/categories');
    state.categories = d.categories || [];
    renderCatTable();
    fillParentSelects();
  }

  function fillParentSelects() {
    var sel = el('new-cat-parent');
    if (!sel) return;
    sel.innerHTML =
      '<option value="">(Cấp gốc)</option>' +
      state.categories
        .map(function (c) {
          return '<option value="' + c.id + '">' + escapeHtml(c.name) + ' (#' + c.id + ')</option>';
        })
        .join('');
  }

  function renderCatTable() {
    var tb = el('tbl-categories');
    if (!tb) return;
    tb.innerHTML = state.categories
      .map(function (c) {
        return (
          '<tr><td>' +
          c.id +
          '</td><td>' +
          (c.parent_id != null ? '#' + c.parent_id : '—') +
          '</td><td>' +
          escapeHtml(c.name) +
          '</td><td>' +
          (c.is_active ? 'Hiện' : 'Ẩn') +
          '</td><td><button type="button" class="adm-btn" data-del-cat="' +
          c.id +
          '">Xóa</button></td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('[data-del-cat]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = Number(btn.getAttribute('data-del-cat'));
        if (!confirm('Xóa danh mục #' + id + '?')) return;
        try {
          await api('/categories/' + id, { method: 'DELETE' });
          await refreshCategories();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  async function refreshTypes() {
    var d = await api('/document-types');
    state.types = d.types || [];
    var tb = el('tbl-types');
    tb.innerHTML = state.types
      .map(function (t) {
        return (
          '<tr><td>' +
          t.id +
          '</td><td>' +
          escapeHtml(t.name) +
          '</td><td>' +
          escapeHtml(t.code || '') +
          '</td><td>' +
          (t.is_active ? 'Hiện' : 'Ẩn') +
          '</td><td><button type="button" class="adm-btn" data-del-type="' +
          t.id +
          '">Xóa</button></td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('[data-del-type]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = Number(btn.getAttribute('data-del-type'));
        if (!confirm('Xóa loại #' + id + '?')) return;
        try {
          await api('/document-types/' + id, { method: 'DELETE' });
          await refreshTypes();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  async function refreshTags() {
    var d = await api('/tags');
    state.tags = d.tags || [];
    var tb = el('tbl-tags');
    tb.innerHTML = state.tags
      .map(function (t) {
        return (
          '<tr><td>' +
          t.id +
          '</td><td>' +
          escapeHtml(t.name) +
          '</td><td><span style="padding:2px 8px;border-radius:4px;background:' +
          (t.color || '#ccc') +
          '33">' +
          escapeHtml(t.color || '') +
          '</span></td><td><button type="button" class="adm-btn" data-del-tag="' +
          t.id +
          '">Xóa</button></td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('[data-del-tag]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = Number(btn.getAttribute('data-del-tag'));
        if (!confirm('Xóa thẻ #' + id + '?')) return;
        try {
          await api('/tags/' + id, { method: 'DELETE' });
          await refreshTags();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  async function refreshModuleAccess() {
    if (!state.me || !state.me.canAssignRoles) return;
    var d = await api('/admin/module-access');
    state.moduleAccess = d.users || [];
    state.accessIdSet = new Set(state.moduleAccess.map(function (x) { return x.user_id; }));
    var tb = el('tbl-module-access');
    if (!tb) return;
    tb.innerHTML = state.moduleAccess
      .map(function (u) {
        return (
          '<tr><td>' +
          escapeHtml(u.fullname || '') +
          '</td><td>' +
          escapeHtml(u.email || '') +
          '</td><td>' +
          dmsModuleRoleLabel(u.module_role) +
          '</td><td>' +
          escapeHtml(u.granted_at || '') +
          '</td><td><button type="button" class="adm-btn adm-btn-danger" data-del-access="' +
          u.user_id +
          '">Xóa</button></td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('[data-del-access]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = Number(btn.getAttribute('data-del-access'));
        if (
          !confirm(
            'Xóa khỏi danh sách mở truy cập module? Vai trò Quản lý/Tải lên/Chỉ xem của user này cũng sẽ bị gỡ.'
          )
        )
          return;
        try {
          await api('/admin/module-access/' + uid, { method: 'DELETE' });
          await refreshModuleAccess();
          await refreshModuleUsers();
        } catch (e) {
          alert(e.message);
        }
      });
    });
  }

  async function refreshModuleUsers() {
    if (!state.me || !state.me.canAssignRoles) return;
    var d = await api('/admin/module-users');
    state.moduleUsers = d.users || [];
    var tb = el('tbl-mod-users');
    tb.innerHTML = state.moduleUsers
      .map(function (u) {
        return (
          '<tr><td>' +
          escapeHtml(u.fullname || '') +
          '</td><td>' +
          escapeHtml(u.email || '') +
          '</td><td><strong>' +
          escapeHtml(u.role) +
          '</strong></td><td>' +
          escapeHtml(u.granted_at || '') +
          '</td><td><button type="button" class="adm-btn adm-btn-danger" data-del-user="' +
          u.user_id +
          '">Gỡ</button></td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('[data-del-user]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var uid = Number(btn.getAttribute('data-del-user'));
        if (!confirm('Gỡ quyền module cho user #' + uid + '?')) return;
        await api('/admin/module-users/' + uid, { method: 'DELETE' });
        await refreshModuleUsers();
      });
    });
  }

  function showTab(name) {
    document.querySelectorAll('.adm-tab').forEach(function (t) {
      t.style.display = t.getAttribute('data-tab') === name ? 'block' : 'none';
    });
    document.querySelectorAll('.adm-tab-btn').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-go') === name);
    });
  }

  async function init() {
    if (!getToken()) {
      window.location.href = 'dang-nhap.html?returnUrl=' + encodeURIComponent('quan-tri-tai-lieu-hc.html');
      return;
    }
    var me = await api('/me');
    if (!me.canManageCatalog && !me.canAssignRoles) {
      alert('Bạn không có quyền vào trang quản trị module này.');
      window.location.href = 'tai-lieu-hanh-chinh.html';
      return;
    }
    state.me = me;
    if (!me.canAssignRoles) {
      el('tab-btn-roles').style.display = 'none';
    }

    el('tab-btn-cats').addEventListener('click', function () {
      showTab('cats');
    });
    el('tab-btn-types').addEventListener('click', function () {
      showTab('types');
    });
    el('tab-btn-tags').addEventListener('click', function () {
      showTab('tags');
    });
    el('tab-btn-roles').addEventListener('click', function () {
      showTab('roles');
    });

    el('form-new-cat').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      await api('/categories', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          name: el('new-cat-name').value,
          parent_id: el('new-cat-parent').value || null,
        }),
      });
      el('new-cat-name').value = '';
      await refreshCategories();
    });

    el('form-new-type').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      await api('/document-types', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          name: el('new-type-name').value,
          code: el('new-type-code').value,
        }),
      });
      el('new-type-name').value = '';
      el('new-type-code').value = '';
      await refreshTypes();
    });

    el('form-new-tag').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      await api('/tags', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          name: el('new-tag-name').value,
          color: el('new-tag-color').value,
        }),
      });
      el('new-tag-name').value = '';
      await refreshTags();
    });

    el('access-user-search').addEventListener(
      'input',
      debounce(async function () {
        var q = el('access-user-search').value.trim();
        var box = el('access-user-suggest');
        if (q.length < 1) {
          box.innerHTML = '';
          return;
        }
        try {
          var rows = await apiUsersSearch(q);
          box.innerHTML = rows
            .map(function (u) {
              return (
                '<div class="adm-suggest-item" data-access-pick="' +
                u.id +
                '" data-access-email="' +
                escapeHtml(u.email) +
                '">' +
                escapeHtml(u.fullname || u.email) +
                ' <small>' +
                escapeHtml(u.email) +
                '</small></div>'
              );
            })
            .join('');
          box.querySelectorAll('[data-access-pick]').forEach(function (node) {
            node.addEventListener('click', function () {
              el('access-user-id').value = node.getAttribute('data-access-pick');
              el('access-user-search').value = node.getAttribute('data-access-email');
              box.innerHTML = '';
            });
          });
        } catch (e) {
          box.innerHTML = '<div class="adm-err">' + escapeHtml(e.message) + '</div>';
        }
      }, 280)
    );

    el('form-add-access').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      try {
        var uid = await resolveUserIdFromSearch(el('access-user-id'), el('access-user-search'));
        await api('/admin/module-access', {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({ user_id: uid }),
        });
        el('access-user-id').value = '';
        el('access-user-search').value = '';
        await refreshModuleAccess();
        await refreshModuleUsers();
      } catch (e) {
        alert(e.message);
      }
    });

    el('btn-access-all-institute').addEventListener('click', async function () {
      if (
        !confirm(
          'Thêm tất cả tài khoản trong hệ thống (không bị khóa) vào danh sách được mở truy cập module? Mỗi tài khoản mới được mặc định vai trò module «chỉ xem» (có thể nâng quyền ở bước 2).'
        )
      )
        return;
      try {
        var r = await api('/admin/module-access', {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({ all_institute: true }),
        });
        alert(r.message || 'Đã cập nhật.');
        await refreshModuleAccess();
        await refreshModuleUsers();
      } catch (e) {
        alert(e.message);
      }
    });

    el('role-user-search').addEventListener(
      'input',
      debounce(async function () {
        var q = el('role-user-search').value.trim();
        var box = el('role-user-suggest');
        if (q.length < 1) {
          box.innerHTML = '';
          return;
        }
        try {
          var rows = await apiUsersSearch(q);
          var filtered = rows.filter(function (u) {
            return state.accessIdSet && state.accessIdSet.has(u.id);
          });
          if (!filtered.length) {
            box.innerHTML =
              '<div class="adm-err">Không có ai trong danh sách đã mở truy cập khớp tìm kiếm. Thêm người ở bước 1 trước.</div>';
            return;
          }
          box.innerHTML = filtered
            .map(function (u) {
              return (
                '<div class="adm-suggest-item" data-pick-user="' +
                u.id +
                '" data-pick-email="' +
                escapeHtml(u.email) +
                '">' +
                escapeHtml(u.fullname || u.email) +
                ' <small>' +
                escapeHtml(u.email) +
                '</small></div>'
              );
            })
            .join('');
          box.querySelectorAll('[data-pick-user]').forEach(function (node) {
            node.addEventListener('click', function () {
              el('role-user-id').value = node.getAttribute('data-pick-user');
              el('role-user-search').value = node.getAttribute('data-pick-email');
              box.innerHTML = '';
            });
          });
        } catch (e) {
          box.innerHTML = '<div class="adm-err">' + escapeHtml(e.message) + '</div>';
        }
      }, 280)
    );

    el('form-assign-role').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var uid;
      try {
        uid = await resolveUserIdFromSearch(el('role-user-id'), el('role-user-search'));
      } catch (e) {
        alert(e.message);
        return;
      }
      if (!state.accessIdSet || !state.accessIdSet.has(uid)) {
        alert('Chỉ gán vai trò cho tài khoản đã có trong danh sách mở truy cập (bước 1).');
        return;
      }
      try {
        await api('/admin/module-users', {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({
            user_id: uid,
            role: el('role-pick').value,
          }),
        });
        el('role-user-id').value = '';
        el('role-user-search').value = '';
        await refreshModuleUsers();
      } catch (e) {
        alert(e.message);
      }
    });

    await refreshCategories();
    await refreshTypes();
    await refreshTags();
    await refreshModuleAccess();
    await refreshModuleUsers();
    showTab('cats');
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      var a = arguments;
      t = setTimeout(function () {
        fn.apply(null, a);
      }, ms);
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
