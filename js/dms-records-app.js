/**
 * Giao diện Quản lý tài liệu & hồ sơ — gọi /api/dms/*
 */
(function () {
  var apiBase =
    window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')
      ? 'http://localhost:3000'
      : '';

  function getToken() {
    return localStorage.getItem('token') || '';
  }

  function authHeaders() {
    var t = getToken();
    var h = { Accept: 'application/json' };
    if (t) h.Authorization = 'Bearer ' + t;
    return h;
  }

  var state = {
    me: null,
    stats: null,
    categories: [],
    counts: {},
    types: [],
    tags: [],
    documents: [],
    total: 0,
    page: 1,
    limit: 30,
    selected: {},
    filters: {
      q: '',
      category_id: 'all',
      status: 'all',
      year: new Date().getFullYear(),
      document_type_id: '',
      quick: '',
      tag_ids: [],
      sort: 'uploaded_at',
      duplicates_only: '',
    },
    view: 'list',
  };

  function el(id) {
    return document.getElementById(id);
  }

  function fmtDate(s) {
    if (!s) return '—';
    var x = String(s).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) {
      var p = x.split('-');
      return p[2] + '/' + p[1] + '/' + p[0];
    }
    return s;
  }

  function fmtSize(n, filePath) {
    if (filePath === '__no_file__') return 'Chưa có PDF';
    if (n == null || !Number.isFinite(Number(n)) || Number(n) === 0) return '—';
    var b = Number(n);
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function statusClass(st) {
    var s = String(st || '').toLowerCase();
    if (s === 'active') return 'dms-status dms-status-active';
    if (s === 'draft') return 'dms-status dms-status-draft';
    if (s === 'expired') return 'dms-status dms-status-expired';
    if (s === 'revoked') return 'dms-status dms-status-revoked';
    return 'dms-status';
  }

  function statusLabel(st) {
    var m = {
      active: 'Có hiệu lực',
      draft: 'Dự thảo',
      expired: 'Hết hạn',
      revoked: 'Thu hồi',
    };
    return m[String(st || '').toLowerCase()] || st || '—';
  }

  async function api(path, opts) {
    opts = opts || {};
    var url = apiBase + '/api/dms' + path;
    var r = await fetch(url, Object.assign({ headers: authHeaders() }, opts));
    var j = null;
    try {
      j = await r.json();
    } catch (e) {
      j = {};
    }
    if (!r.ok) {
      var msg = (j && j.message) || 'Lỗi ' + r.status;
      throw new Error(msg);
    }
    return j;
  }

  function renderNoAccess(me) {
    me = me || {};
    var p =
      'Tài khoản của bạn chưa được cấp quyền sử dụng module Tài liệu & hồ sơ theo quy định của đơn vị.';
    if (me.dmsAccessListed && !me.role && !me.isSysAdmin) {
      p =
        'Tài khoản đã được mở truy cập module nhưng chưa được gán vai trò (Quản lý / Tải lên / Chỉ xem). Liên hệ Master Admin.';
    } else if (!me.dmsAccessListed && !me.isSysAdmin) {
      p =
        'Tài khoản chưa nằm trong danh sách được mở truy cập module Tài liệu & hồ sơ. Liên hệ Master Admin.';
    }
    el('dms-app-root').innerHTML =
      '<div class="dms-nope"><h2>Chưa có quyền truy cập</h2><p>' +
      p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</p>' +
      '<p style="margin-top:12px"><a class="dms-link" href="index.html">← Về trang chủ</a></p></div>';
  }

  function setBulkBar() {
    var ids = Object.keys(state.selected).filter(function (k) {
      return state.selected[k];
    });
    var bar = el('dms-bulk-bar');
    if (!bar) return;
    if (ids.length) {
      bar.classList.add('visible');
      el('dms-bulk-count').textContent = ids.length + ' mục đã chọn';
    } else {
      bar.classList.remove('visible');
    }
  }

  function renderStats() {
    if (!state.stats) return;
    el('dms-stat-total').textContent = state.stats.total;
    el('dms-stat-active').textContent = state.stats.active;
    el('dms-stat-soon').textContent = state.stats.expiringSoon;
    el('dms-stat-exp').textContent = state.stats.expired;
    var hint = el('dms-dup-hint');
    if (hint) {
      var g = state.stats.duplicateGroups;
      var r = state.stats.documentsInDuplicateGroups;
      if (g > 0) {
        hint.innerHTML =
          'Phát hiện <strong>' +
          g +
          '</strong> nhóm trùng khóa (Số QĐ + ngày ban hành), gồm <strong>' +
          r +
          '</strong> bản ghi. Dùng bộ lọc «Chỉ bản ghi trùng khóa» để xử lý.';
      } else {
        hint.textContent = '';
      }
    }
  }

  function renderCategoryNav() {
    var root = el('dms-cat-nav');
    if (!root) return;
    var byParent = {};
    state.categories.forEach(function (c) {
      var p = c.parent_id == null ? '_root' : String(c.parent_id);
      if (!byParent[p]) byParent[p] = [];
      byParent[p].push(c);
    });
    function sortFn(a, b) {
      return (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id;
    }
    var html = '';
    html +=
      '<div class="dms-nav-item' +
      (state.filters.category_id === 'all' && !state.filters.quick ? ' active' : '') +
      '" data-cat="all"><span>Tất cả tài liệu</span><span class="cnt">' +
      (state.stats ? state.stats.total : '—') +
      '</span></div>';

    function walk(parentKey, depth) {
      var list = byParent[parentKey] || [];
      list.sort(sortFn);
      list.forEach(function (c) {
        if (!c.is_active) return;
        var cnt = state.counts[c.id] || 0;
        var active = String(state.filters.category_id) === String(c.id);
        var pad = depth ? ' dms-nav-sub' : '';
        html +=
          '<div class="dms-nav-item' +
          (active ? ' active' : '') +
          pad +
          '" data-cat="' +
          c.id +
          '"><span>' +
          escapeHtml(c.name) +
          '</span><span class="cnt">' +
          cnt +
          '</span></div>';
        walk(String(c.id), true);
      });
    }
    walk('_root', false);
    root.innerHTML = html;
    root.querySelectorAll('.dms-nav-item').forEach(function (node) {
      node.addEventListener('click', function () {
        state.filters.category_id = node.getAttribute('data-cat');
        state.filters.quick = '';
        state.page = 1;
        loadDocuments();
        renderCategoryNav();
        renderQuickFilters();
      });
    });
  }

  function renderQuickFilters() {
    var root = el('dms-quick-nav');
    if (!root) return;
    var items = [
      { k: 'active', label: 'Đang có hiệu lực', n: state.stats ? state.stats.active : '—' },
      { k: 'expired_revoked', label: 'Hết hạn / thu hồi', n: state.stats ? state.stats.expired : '—' },
      { k: 'draft', label: 'Dự thảo', n: state.stats ? state.stats.draft : '—' },
    ];
    root.innerHTML = items
      .map(function (it) {
        var on = state.filters.quick === it.k;
        return (
          '<div class="dms-nav-item' +
          (on ? ' active' : '') +
          '" data-quick="' +
          it.k +
          '"><span>' +
          escapeHtml(it.label) +
          '</span><span class="cnt">' +
          it.n +
          '</span></div>'
        );
      })
      .join('');
    root.querySelectorAll('.dms-nav-item').forEach(function (node) {
      node.addEventListener('click', function () {
        var qk = node.getAttribute('data-quick');
        state.filters.quick = state.filters.quick === qk ? '' : qk;
        state.filters.category_id = 'all';
        state.page = 1;
        loadDocuments();
        renderCategoryNav();
        renderQuickFilters();
      });
    });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function docExternalLinksHtml(d) {
    var s = d.external_scan_link && String(d.external_scan_link).trim();
    var w = d.external_word_link && String(d.external_word_link).trim();
    var parts = [];
    if (s) {
      parts.push(
        '<a class="dms-link dms-doc-ext" href="' +
          escapeAttr(s) +
          '" target="_blank" rel="noopener noreferrer">PDF</a>'
      );
    }
    if (w) {
      parts.push(
        '<a class="dms-link dms-doc-ext" href="' +
          escapeAttr(w) +
          '" target="_blank" rel="noopener noreferrer">Word</a>'
      );
    }
    if (!parts.length) return '';
    return '<div class="dms-doc-extlinks">' + parts.join(' · ') + '</div>';
  }

  function renderTags() {
    var root = el('dms-tags-nav');
    if (!root) return;
    root.innerHTML = state.tags
      .map(function (t) {
        var on = state.filters.tag_ids.indexOf(t.id) !== -1;
        return (
          '<span class="dms-tag-pill' +
          (on ? ' on' : '') +
          '" data-tag="' +
          t.id +
          '" style="background:' +
          (t.color || '#64748b') +
          '22;color:' +
          (t.color || '#334155') +
          '">' +
          escapeHtml(t.name) +
          '</span>'
        );
      })
      .join('');
    root.querySelectorAll('.dms-tag-pill').forEach(function (node) {
      node.addEventListener('click', function () {
        var id = Number(node.getAttribute('data-tag'));
        var ix = state.filters.tag_ids.indexOf(id);
        if (ix === -1) state.filters.tag_ids.push(id);
        else state.filters.tag_ids.splice(ix, 1);
        state.page = 1;
        loadDocuments();
        renderTags();
      });
    });
  }

  function renderTypeFilters() {
    var sel = el('filter-doc-type');
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML =
      '<option value="">Loại tài liệu: Tất cả</option>' +
      state.types
        .filter(function (t) {
          return t.is_active;
        })
        .map(function (t) {
          return '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>';
        })
        .join('');
    sel.value = cur || '';
  }

  function canEditRow(doc) {
    if (!state.me) return false;
    if (state.me.canManageAllDocs) return true;
    if (state.me.role === 'uploader' && doc.uploaded_by_id === state.me.userId) return true;
    return false;
  }

  function syncSelectAllHeader() {
    var hdr = el('dms-select-all');
    if (!hdr) return;
    if (!state.documents.length) {
      hdr.checked = false;
      hdr.indeterminate = false;
      hdr.disabled = true;
      return;
    }
    hdr.disabled = false;
    var ids = state.documents.map(function (d) {
      return d.id;
    });
    var nSel = ids.filter(function (id) {
      return state.selected[id];
    }).length;
    hdr.checked = nSel === ids.length;
    hdr.indeterminate = nSel > 0 && nSel < ids.length;
  }

  function renderTable() {
    var tb = el('dms-tbody');
    var sum = el('dms-list-summary');
    if (sum) {
      var dup = state.filters.duplicates_only === '1';
      sum.textContent =
        (dup ? 'Bản ghi trùng khóa — ' : 'Tất cả tài liệu — ') +
        state.total +
        ' mục' +
        (state.filters.category_id !== 'all' || dup ? ' (đã lọc)' : '');
    }
    if (!tb) return;
    if (!state.documents.length) {
      tb.innerHTML =
        '<tr><td colspan="7" class="dms-empty">Không có tài liệu phù hợp. Thử đổi bộ lọc hoặc thêm tài liệu mới.</td></tr>';
      syncSelectAllHeader();
      return;
    }
    tb.innerHTML = state.documents
      .map(function (d) {
        var checked = state.selected[d.id] ? ' checked' : '';
        var tags = (d.tags || [])
          .map(function (t) {
            return '<span style="font-size:10px;margin-right:4px;padding:2px 6px;border-radius:4px;background:' + (t.color || '#ccc') + '22">' + escapeHtml(t.name) + '</span>';
          })
          .join('');
        return (
          '<tr data-id="' +
          d.id +
          '">' +
          '<td><input type="checkbox" class="dms-row-check"' +
          checked +
          ' /></td>' +
          '<td><div class="dms-doc-title">' +
          escapeHtml(d.title) +
          '</div><div class="dms-doc-meta">' +
          fmtDate(d.uploaded_at) +
          ' · ' +
          escapeHtml(d.uploader_name || '') +
          ' · ' +
          fmtSize(d.file_size, d.file_path) +
          (d.issuing_unit ? ' · ĐV: ' + escapeHtml(d.issuing_unit) : '') +
          '</div>' +
          (tags ? '<div style="margin-top:6px">' + tags + '</div>' : '') +
          docExternalLinksHtml(d) +
          '</td>' +
          '<td>' +
          escapeHtml(d.document_type_name || '—') +
          '</td>' +
          '<td>' +
          escapeHtml(d.ref_number || '—') +
          '</td>' +
          '<td>' +
          fmtDate(d.issue_date) +
          '</td>' +
          '<td>' +
          fmtDate(d.valid_until) +
          '</td>' +
          '<td><span class="' +
          statusClass(d.status) +
          '">' +
          statusLabel(d.status) +
          '</span><div class="dms-table-actions">' +
          (canEditRow(d)
            ? '<button type="button" class="dms-btn-table dms-btn-table--edit" data-act="edit">Sửa</button>'
            : '') +
          '<button type="button" class="dms-btn-table dms-btn-table--dl" data-act="dl">Tải</button></div></td>' +
          '</tr>'
        );
      })
      .join('');

    tb.querySelectorAll('tr').forEach(function (row) {
      var id = Number(row.getAttribute('data-id'));
      var chk = row.querySelector('.dms-row-check');
      if (chk) {
        chk.addEventListener('change', function () {
          state.selected[id] = chk.checked;
          syncSelectAllHeader();
          setBulkBar();
        });
      }
      row.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var act = btn.getAttribute('data-act');
          if (act === 'dl') window.open(apiBase + '/api/dms/documents/' + id + '/file?token=' + encodeURIComponent(getToken()), '_blank');
          if (act === 'edit') window.location.href = 'dms-them-tai-lieu.html?id=' + id;
        });
      });
    });
    syncSelectAllHeader();
  }

  function buildQuery() {
    var p = new URLSearchParams();
    if (state.filters.q) p.set('q', state.filters.q);
    if (state.filters.category_id && state.filters.category_id !== 'all') {
      p.set('category_id', state.filters.category_id);
    }
    if (state.filters.status && state.filters.status !== 'all') p.set('status', state.filters.status);
    if (state.filters.year && String(state.filters.year) !== 'all') p.set('year', state.filters.year);
    if (state.filters.document_type_id) p.set('document_type_id', state.filters.document_type_id);
    if (state.filters.quick) p.set('quick', state.filters.quick);
    if (state.filters.tag_ids.length) p.set('tag_ids', state.filters.tag_ids.join(','));
    if (state.filters.duplicates_only === '1') p.set('duplicates_only', '1');
    p.set('sort', state.filters.sort);
    p.set('page', String(state.page));
    p.set('limit', String(state.limit));
    return p.toString();
  }

  async function loadDocuments() {
    var q = buildQuery();
    var data = await api('/documents?' + q);
    state.documents = data.documents || [];
    state.total = data.total || 0;
    renderTable();
  }

  async function loadAll() {
    var me = await api('/me');
    if (!me.canView) {
      renderNoAccess(me);
      return;
    }
    state.me = {
      canView: me.canView,
      canUpload: me.canUpload,
      canManageAllDocs: me.canManageAllDocs,
      canManageCatalog: me.canManageCatalog,
      canAssignRoles: me.canAssignRoles,
      role: me.role,
      userId: me.userId,
      dmsAccessListed: me.dmsAccessListed,
      isSysAdmin: me.isSysAdmin,
    };
    el('dms-admin-link').style.display = me.canManageCatalog || me.canAssignRoles ? 'inline-block' : 'none';
    el('dms-btn-add').style.display = me.canUpload ? 'inline-block' : 'none';
    var bulkDel = el('dms-bulk-del');
    var bulkMv = el('dms-bulk-mv');
    if (bulkDel) bulkDel.style.display = me.canManageAllDocs ? '' : 'none';
    if (bulkMv) bulkMv.style.display = me.canManageAllDocs ? '' : 'none';

    var st = await api('/stats');
    state.stats = st;
    renderStats();

    var cats = await api('/categories');
    state.categories = cats.categories || [];
    state.counts = cats.counts || {};
    renderCategoryNav();

    var types = await api('/document-types');
    state.types = types.types || [];
    renderTypeFilters();

    var tags = await api('/tags');
    state.tags = tags.tags || [];
    renderTags();
    renderQuickFilters();

    await loadDocuments();
  }

  function exportExcel() {
    var q = buildQuery();
    var sep = q ? '&' : '';
    window.open(
      apiBase + '/api/dms/export.xlsx?' + q + sep + 'token=' + encodeURIComponent(getToken()),
      '_blank'
    );
  }

  async function bulkDelete() {
    var ids = Object.keys(state.selected)
      .filter(function (k) {
        return state.selected[k];
      })
      .map(Number);
    if (!ids.length) return;
    if (!confirm('Xóa ' + ids.length + ' tài liệu? Không hoàn tác.')) return;
    await api('/documents/bulk-delete', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ ids: ids }),
    });
    state.selected = {};
    setBulkBar();
    await loadAll();
  }

  async function bulkDownload() {
    var ids = Object.keys(state.selected)
      .filter(function (k) {
        return state.selected[k];
      })
      .map(Number);
    if (!ids.length) return;
    var r = await fetch(apiBase + '/api/dms/documents/bulk-download', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ ids: ids }),
    });
    if (!r.ok) {
      var j = await r.json().catch(function () {
        return {};
      });
      throw new Error(j.message || 'Lỗi tải zip');
    }
    var blob = await r.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tai-lieu-stims.zip';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function bulkMove() {
    var ids = Object.keys(state.selected)
      .filter(function (k) {
        return state.selected[k];
      })
      .map(Number);
    if (!ids.length) return;
    var cid = prompt('Nhập ID danh mục đích (để trống = bỏ gán danh mục):', '');
    if (cid === null) return;
    await api('/documents/bulk-move', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: JSON.stringify({ ids: ids, category_id: cid ? Number(cid) : null }),
    });
    state.selected = {};
    setBulkBar();
    await loadAll();
  }

  function updateSearchChrome() {
    var inp = el('dms-search');
    var clr = el('dms-search-clear');
    var hero = el('dms-search-hero');
    if (!inp || !clr || !hero) return;
    var raw = String(inp.value || '');
    clr.hidden = !raw.length;
    hero.classList.toggle('has-value', !!raw.trim().length);
  }

  function runSearchFromUi() {
    state.filters.q = el('dms-search').value;
    state.page = 1;
    updateSearchChrome();
    loadDocuments();
  }

  function wireUi() {
    var debouncedDocSearch = debounce(function () {
      state.filters.q = el('dms-search').value;
      state.page = 1;
      loadDocuments();
    }, 320);

    el('dms-search').addEventListener('input', function () {
      updateSearchChrome();
      debouncedDocSearch();
    });
    el('dms-search').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        runSearchFromUi();
      }
    });
    el('dms-search-submit').addEventListener('click', function () {
      runSearchFromUi();
    });
    el('dms-search-clear').addEventListener('click', function () {
      el('dms-search').value = '';
      runSearchFromUi();
      el('dms-search').focus();
    });
    updateSearchChrome();
    el('filter-status').addEventListener('change', function () {
      state.filters.status = el('filter-status').value;
      state.page = 1;
      loadDocuments();
    });
    el('filter-year').addEventListener('change', function () {
      state.filters.year = el('filter-year').value;
      state.page = 1;
      loadDocuments();
    });
    el('filter-doc-type').addEventListener('change', function () {
      state.filters.document_type_id = el('filter-doc-type').value;
      state.page = 1;
      loadDocuments();
    });
    el('filter-sort').addEventListener('change', function () {
      state.filters.sort = el('filter-sort').value;
      state.page = 1;
      loadDocuments();
    });
    var fdup = el('filter-dup');
    if (fdup) {
      fdup.addEventListener('change', function () {
        state.filters.duplicates_only = fdup.value;
        state.page = 1;
        loadDocuments();
      });
    }
    el('dms-btn-export').addEventListener('click', exportExcel);
    el('dms-bulk-dl').addEventListener('click', function () {
      bulkDownload().catch(function (e) {
        alert(e.message);
      });
    });
    el('dms-bulk-mv').addEventListener('click', function () {
      bulkMove().catch(function (e) {
        alert(e.message);
      });
    });
    el('dms-bulk-del').addEventListener('click', function () {
      bulkDelete().catch(function (e) {
        alert(e.message);
      });
    });
    el('dms-bulk-clear').addEventListener('click', function () {
      state.selected = {};
      document.querySelectorAll('.dms-row-check').forEach(function (c) {
        c.checked = false;
      });
      syncSelectAllHeader();
      setBulkBar();
    });
    var selAll = el('dms-select-all');
    if (selAll) {
      selAll.addEventListener('change', function () {
        var hdr = el('dms-select-all');
        var on = hdr.checked;
        state.documents.forEach(function (d) {
          if (on) state.selected[d.id] = true;
          else delete state.selected[d.id];
        });
        document.querySelectorAll('.dms-row-check').forEach(function (c) {
          c.checked = on;
        });
        hdr.indeterminate = false;
        setBulkBar();
      });
    }
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

  function init() {
    if (!getToken()) {
      window.location.href = 'dang-nhap.html?returnUrl=' + encodeURIComponent('tai-lieu-hanh-chinh.html');
      return;
    }
    wireUi();
    fillYearSelect();
    loadAll().catch(function (e) {
      if (String(e.message || '').indexOf('401') !== -1 || String(e.message).indexOf('hết hạn') !== -1) {
        window.location.href = 'dang-nhap.html?returnUrl=' + encodeURIComponent('tai-lieu-hanh-chinh.html');
        return;
      }
      el('dms-app-root').innerHTML =
        '<div class="dms-nope"><h2>Không tải được dữ liệu</h2><p>' + escapeHtml(e.message) + '</p></div>';
    });
  }

  function fillYearSelect() {
    var sel = el('filter-year');
    if (!sel) return;
    var y = new Date().getFullYear();
    var h = '<option value="all">Năm: Tất cả</option>';
    for (var i = 0; i < 8; i++) {
      var yy = y - i;
      h += '<option value="' + yy + '">Năm: ' + yy + '</option>';
    }
    sel.innerHTML = h;
    sel.value = String(y);
    state.filters.year = y;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
