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
    return role ? String(role).trim() : '—';
  }

  /** Nhãn vai trò module có màu riêng (viewer / uploader / manager). */
  function dmsModuleRoleBadgeHtml(role) {
    var r = String(role || '').toLowerCase();
    var pill = 'dms-role-pill';
    if (r === 'manager') pill += ' dms-role-pill--manager';
    else if (r === 'uploader') pill += ' dms-role-pill--uploader';
    else if (r === 'viewer') pill += ' dms-role-pill--viewer';
    else pill += ' dms-role-pill--unknown';
    var text = dmsModuleRoleLabel(role);
    return '<span class="' + pill + '">' + escapeHtml(text) + '</span>';
  }

  var state = {
    me: null,
    categories: [],
    types: [],
    tags: [],
    templates: [],
    moduleUsers: [],
    moduleAccess: [],
    accessIdSet: null,
    allInstituteEnabled: false,
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

  function templateStatusLabel(s) {
    var x = String(s || '').toLowerCase();
    if (x === 'draft') return 'Nháp';
    if (x === 'active') return 'Hiệu hành';
    if (x === 'retired') return 'Ngừng';
    return s || '—';
  }

  function recordKindLabel(k) {
    return String(k || '').toLowerCase() === 'document' ? 'Tài liệu' : 'Hồ sơ';
  }

  function openTplEdit(t) {
    var w = el('tpl-edit-wrap');
    if (!w || !t) return;
    el('tpl-edit-id').value = String(t.id);
    el('tpl-edit-heading').textContent = 'Sửa mẫu #' + t.id + ' — ' + (t.code || '');
    el('tpl-edit-code').value = t.code || '';
    el('tpl-edit-name').value = t.name || '';
    el('tpl-edit-version').value = t.version || '1.0';
    el('tpl-edit-sort').value = t.sort_order != null ? String(t.sort_order) : '0';
    el('tpl-edit-status').value = t.status || 'active';
    el('tpl-edit-record-kind').value = t.record_kind === 'document' ? 'document' : 'record';
    el('tpl-edit-owning').value = t.owning_unit || '';
    el('tpl-edit-superseded').value =
      t.superseded_by_id != null && t.superseded_by_id !== '' ? String(t.superseded_by_id) : '';
    el('tpl-edit-desc').value = t.description || '';
    el('tpl-edit-retention').value = t.retention_policy || '';
    el('tpl-edit-medium').value = t.medium_notes || '';
    el('tpl-edit-eff-from').value = t.effective_from ? String(t.effective_from).slice(0, 10) : '';
    el('tpl-edit-eff-until').value = t.effective_until ? String(t.effective_until).slice(0, 10) : '';
    el('tpl-edit-blank-url').value = t.blank_form_url || '';
    el('tpl-edit-active').checked = !!t.is_active;
    w.hidden = false;
    w.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function closeTplEdit() {
    var w = el('tpl-edit-wrap');
    if (w) w.hidden = true;
    el('tpl-edit-id').value = '';
  }

  async function refreshTemplates() {
    var d = await api('/templates');
    state.templates = d.templates || [];
    var tb = el('tbl-templates');
    if (!tb) return;
    tb.innerHTML = state.templates
      .map(function (t) {
        return (
          '<tr><td>' +
          t.id +
          '</td><td><code>' +
          escapeHtml(t.code || '') +
          '</code></td><td>' +
          escapeHtml(t.name || '') +
          '</td><td>' +
          escapeHtml(t.version || '') +
          '</td><td>' +
          escapeHtml(templateStatusLabel(t.status)) +
          '</td><td>' +
          escapeHtml(recordKindLabel(t.record_kind)) +
          '</td><td>' +
          (t.document_count != null ? t.document_count : '—') +
          '</td><td>' +
          (t.is_active ? 'Có' : 'Ẩn') +
          '</td><td><button type="button" class="adm-btn" data-edit-tpl="' +
          t.id +
          '">Sửa</button> <button type="button" class="adm-btn adm-btn-danger" data-del-tpl="' +
          t.id +
          '">Xóa</button></td></tr>'
        );
      })
      .join('');
    tb.querySelectorAll('[data-edit-tpl]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-edit-tpl'));
        var t = state.templates.filter(function (x) {
          return x.id === id;
        })[0];
        if (t) openTplEdit(t);
      });
    });
    tb.querySelectorAll('[data-del-tpl]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var id = Number(btn.getAttribute('data-del-tpl'));
        if (!confirm('Xóa mẫu #' + id + '? Chỉ xóa được khi không còn tài liệu gắn mẫu.')) return;
        try {
          await api('/templates/' + id, { method: 'DELETE' });
          closeTplEdit();
          await refreshTemplates();
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
    state.allInstituteEnabled = state.moduleAccess.some(function (u) {
      return String((u && u.email) || '').toLowerCase().endsWith('@sci.edu.vn');
    });
    var allBtn = el('btn-access-all-institute');
    if (allBtn) {
      allBtn.textContent = state.allInstituteEnabled ? 'Tắt thêm toàn viện' : 'Thêm toàn viện';
      allBtn.classList.toggle('adm-btn-danger', state.allInstituteEnabled);
      allBtn.classList.toggle('adm-btn--teal', !state.allInstituteEnabled);
    }
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
          dmsModuleRoleBadgeHtml(u.module_role) +
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
          '</td><td>' +
          dmsModuleRoleBadgeHtml(u.role) +
          '</td><td>' +
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
    el('tab-btn-templates').addEventListener('click', function () {
      showTab('templates');
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

    el('form-new-template').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var sup = el('new-tpl-superseded').value.trim();
      var body = {
        code: el('new-tpl-code').value.trim(),
        name: el('new-tpl-name').value.trim(),
        version: el('new-tpl-version').value.trim() || '1.0',
        status: el('new-tpl-status').value,
        record_kind: el('new-tpl-record-kind').value,
        description: el('new-tpl-desc').value,
        retention_policy: el('new-tpl-retention').value,
        medium_notes: el('new-tpl-medium').value,
        owning_unit: el('new-tpl-owning').value,
        effective_from: el('new-tpl-eff-from').value || null,
        effective_until: el('new-tpl-eff-until').value || null,
        blank_form_url: el('new-tpl-blank-url').value,
        sort_order: Number(el('new-tpl-sort').value) || 0,
        is_active: el('new-tpl-active').checked,
      };
      if (sup) {
        var sid = Number(sup);
        if (sid > 0) body.superseded_by_id = sid;
      }
      try {
        await api('/templates', { method: 'POST', headers: authHeaders(true), body: JSON.stringify(body) });
        el('form-new-template').reset();
        el('new-tpl-version').value = '1.0';
        el('new-tpl-sort').value = '0';
        el('new-tpl-active').checked = true;
        await refreshTemplates();
      } catch (e) {
        alert(e.message);
      }
    });

    el('form-edit-template').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var id = Number(el('tpl-edit-id').value);
      if (!id) return;
      var sup = el('tpl-edit-superseded').value.trim();
      var body = {
        code: el('tpl-edit-code').value.trim(),
        name: el('tpl-edit-name').value.trim(),
        version: el('tpl-edit-version').value.trim() || '1.0',
        status: el('tpl-edit-status').value,
        record_kind: el('tpl-edit-record-kind').value,
        description: el('tpl-edit-desc').value,
        retention_policy: el('tpl-edit-retention').value,
        medium_notes: el('tpl-edit-medium').value,
        owning_unit: el('tpl-edit-owning').value,
        effective_from: el('tpl-edit-eff-from').value || null,
        effective_until: el('tpl-edit-eff-until').value || null,
        blank_form_url: el('tpl-edit-blank-url').value,
        sort_order: Number(el('tpl-edit-sort').value) || 0,
        is_active: el('tpl-edit-active').checked,
        superseded_by_id: sup ? Number(sup) : null,
      };
      try {
        await api('/templates/' + id, { method: 'PATCH', headers: authHeaders(true), body: JSON.stringify(body) });
        closeTplEdit();
        await refreshTemplates();
      } catch (e) {
        alert(e.message);
      }
    });

    var tplCancel = el('tpl-edit-cancel');
    if (tplCancel) tplCancel.addEventListener('click', closeTplEdit);

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
      try {
        var r;
        if (state.allInstituteEnabled) {
          if (
            !confirm(
              'Tắt thêm toàn viện? Hệ thống sẽ gỡ toàn bộ tài khoản nội viện (@sci.edu.vn) khỏi danh sách mở truy cập module và xóa luôn vai trò module đã gán bằng cơ chế này.'
            )
          )
            return;
          r = await api('/admin/module-access', {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({ disable_all_institute: true, email_suffix: '@sci.edu.vn' }),
          });
        } else {
          if (
            !confirm(
              'Thêm tất cả tài khoản trong hệ thống (không bị khóa) vào danh sách được mở truy cập module? Mỗi tài khoản mới được mặc định vai trò module «chỉ xem» (có thể nâng quyền ở bước 2).'
            )
          )
            return;
          r = await api('/admin/module-access', {
            method: 'POST',
            headers: authHeaders(true),
            body: JSON.stringify({ all_institute: true }),
          });
        }
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
    await refreshTemplates();
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
