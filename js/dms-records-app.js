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
    templates: [],
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
      template_id: '',
      has_template: '',
      quick: '',
      tag_ids: [],
      sort: 'uploaded_at',
      duplicates_only: '',
      file_mode: '',
      compliance: '',
      document_id: '',
    },
    view: 'list',
    physModal: { docId: null, tab: 'place', bundle: null, inventorySessionId: null },
    _highlightRowId: null,
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
    var st = state.stats;
    function setTpl(id, v) {
      var n = el(id);
      if (n) n.textContent = v != null ? v : '—';
    }
    setTpl('dms-stat-tpl-total', st.templatesTotal);
    setTpl('dms-stat-tpl-active', st.templatesActive);
    setTpl('dms-stat-tpl-draft', st.templatesDraft);
    setTpl('dms-stat-tpl-retired', st.templatesRetired);
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
        state.filters.file_mode = '';
        state.filters.compliance = '';
        state.filters.document_id = '';
        state.filters.template_id = '';
        state.filters.has_template = '';
        var fm = el('filter-file-mode');
        var cp = el('filter-compliance');
        var ft = el('filter-template');
        if (fm) fm.value = '';
        if (cp) cp.value = '';
        if (ft) ft.value = '';
        syncFilterSelectsChrome();
        state.page = 1;
        loadDocuments();
        renderCategoryNav();
        renderQuickFilters();
        renderPhysNav();
      });
    });
  }

  function physQuickKey() {
    if (state.filters.file_mode === 'missing_pdf') return 'missing_pdf';
    if (state.filters.file_mode === 'scan_only') return 'scan_only';
    if (state.filters.compliance === 'retention_alert') return 'retention_alert';
    if (state.filters.compliance === 'out_on_loan') return 'out_on_loan';
    return '';
  }

  function setPhysQuick(k) {
    state.filters.file_mode = '';
    state.filters.compliance = '';
    state.filters.document_id = '';
    if (k === 'missing_pdf') state.filters.file_mode = 'missing_pdf';
    else if (k === 'scan_only') state.filters.file_mode = 'scan_only';
    else if (k === 'retention_alert') state.filters.compliance = 'retention_alert';
    else if (k === 'out_on_loan') state.filters.compliance = 'out_on_loan';
    var fm = el('filter-file-mode');
    var cp = el('filter-compliance');
    if (fm) fm.value = state.filters.file_mode || '';
    if (cp) cp.value = state.filters.compliance || '';
    var ft = el('filter-template');
    if (ft) ft.value = '';
    state.filters.template_id = '';
    state.filters.has_template = '';
    syncFilterSelectsChrome();
    state.page = 1;
    loadDocuments();
    renderPhysNav();
    renderCategoryNav();
    renderQuickFilters();
  }

  function renderPhysNav() {
    var root = el('dms-phys-nav');
    if (!root) return;
    var on = physQuickKey();
    var items = [
      { k: '', label: 'Tất cả (bỏ lọc kho)', n: '' },
      { k: 'missing_pdf', label: 'Chưa có PDF', n: state.stats ? state.stats.missingPdf : '—' },
      { k: 'scan_only', label: 'Chỉ link scan', n: state.stats ? state.stats.scanOnly : '—' },
      { k: 'retention_alert', label: 'Cảnh báo tiêu hủy', n: state.stats ? state.stats.destructionAlert : '—' },
      { k: 'out_on_loan', label: 'Đang mượn', n: state.stats ? state.stats.outOnLoan : '—' },
    ];
    root.innerHTML = items
      .map(function (it) {
        var active = on === it.k;
        return (
          '<div class="dms-nav-item' +
          (active ? ' active' : '') +
          '" data-phys="' +
          escapeAttr(it.k) +
          '"><span>' +
          escapeHtml(it.label) +
          '</span>' +
          (it.n !== '' ? '<span class="cnt">' + it.n + '</span>' : '')
        );
      })
      .join('');
    root.querySelectorAll('[data-phys]').forEach(function (node) {
      node.addEventListener('click', function () {
        setPhysQuick(node.getAttribute('data-phys') || '');
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
        state.filters.file_mode = '';
        state.filters.compliance = '';
        state.filters.document_id = '';
        state.filters.template_id = '';
        state.filters.has_template = '';
        var fm = el('filter-file-mode');
        var cp = el('filter-compliance');
        var ft = el('filter-template');
        if (fm) fm.value = '';
        if (cp) cp.value = '';
        if (ft) ft.value = '';
        syncFilterSelectsChrome();
        state.page = 1;
        loadDocuments();
        renderCategoryNav();
        renderQuickFilters();
        renderPhysNav();
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

  function templateBadgeHtml(d) {
    if (!d.template_id || !d.template_code) return '';
    var st = String(d.template_status || '').toLowerCase();
    var cls = 'dms-template-badge';
    if (st === 'retired') cls += ' dms-template-badge--retired';
    if (st === 'draft') cls += ' dms-template-badge--draft';
    var title =
      'ID mẫu: #' +
      d.template_id +
      ' · ' +
      (d.template_name || '') +
      ' · Loại ISO: ' +
      (d.template_record_kind === 'document' ? 'Tài liệu' : 'Hồ sơ');
    return (
      '<div class="' +
      cls +
      '" title="' +
      escapeAttr(title) +
      '"><span class="dms-template-badge__code">' +
      escapeHtml(d.template_code) +
      '</span> v' +
      escapeHtml(String(d.template_version || '?')) +
      '</div>'
    );
  }

  function destructionBadgeHtml(d) {
    if (!d.destruction_eligible_date) return '';
    var x = String(d.destruction_eligible_date).slice(0, 10);
    var t = Date.parse(x + 'T12:00:00');
    if (!Number.isFinite(t)) return '';
    var days = Math.ceil((t - Date.now()) / 86400000);
    if (days < 0) return '<span class="dms-badge dms-badge--danger">Quá hạn TH</span> ';
    if (days <= 90) return '<span class="dms-badge dms-badge--amber">TH ' + days + 'd</span> ';
    return '';
  }

  function docIsPublic(d) {
    return Number(d.is_public) === 1 || d.is_public === true;
  }

  function renderPublicCell(d) {
    var pub = docIsPublic(d);
    if (state.me && state.me.canManageAllDocs) {
      var cur = pub ? '1' : '0';
      return (
        '<td class="dms-public-cell">' +
        '<select class="dms-select dms-select--compact dms-public-select" data-doc-public="' +
        d.id +
        '" data-prev="' +
        cur +
        '" aria-label="Công khai tài liệu">' +
        '<option value="1"' +
        (pub ? ' selected' : '') +
        '>Có</option>' +
        '<option value="0"' +
        (!pub ? ' selected' : '') +
        '>Không</option>' +
        '</select></td>'
      );
    }
    return (
      '<td class="dms-public-cell"><span class="dms-public-readonly">' +
      (pub ? 'Có' : 'Không') +
      '</span></td>'
    );
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
        state.filters.document_id = '';
        state.filters.template_id = '';
        state.filters.has_template = '';
        var ft = el('filter-template');
        if (ft) ft.value = '';
        syncFilterSelectsChrome();
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
    syncFilterSelectsChrome();
  }

  function syncFilterSelectsChrome() {
    var curYear = String(new Date().getFullYear());
    var CLS = 'dms-select--filter-active';

    function toggle(id, active) {
      var s = el(id);
      if (s) s.classList.toggle(CLS, !!active);
    }

    var dt = el('filter-doc-type');
    toggle('filter-doc-type', dt && dt.value && String(dt.value).trim());

    var tpl = el('filter-template');
    toggle('filter-template', tpl && tpl.value && String(tpl.value).trim());

    var st = el('filter-status');
    toggle('filter-status', st && st.value !== 'all');

    var yr = el('filter-year');
    if (yr) {
      var yv = String(yr.value || '');
      toggle('filter-year', yv === 'all' || (yv.length && yv !== curYear));
    }

    var so = el('filter-sort');
    toggle('filter-sort', so && so.value !== 'uploaded_at');

    var dup = el('filter-dup');
    toggle('filter-dup', dup && dup.value && String(dup.value).trim());

    var fm = el('filter-file-mode');
    toggle('filter-file-mode', fm && fm.value && String(fm.value).trim());

    var cp = el('filter-compliance');
    toggle('filter-compliance', cp && cp.value && String(cp.value).trim());
  }

  function renderTemplateFilter() {
    var sel = el('filter-template');
    if (!sel) return;
    var cur = sel.value;
    sel.innerHTML =
      '<option value="">Mẫu biểu: Tất cả</option>' +
      (state.templates || [])
        .filter(function (t) {
          return t.is_active;
        })
        .map(function (t) {
          return (
            '<option value="' +
            t.id +
            '">' +
            escapeHtml(t.code + ' — ' + (t.name || '')) +
            '</option>'
          );
        })
        .join('');
    sel.value = cur && sel.querySelector('option[value="' + cur + '"]') ? cur : '';
    if (cur && !sel.value) state.filters.template_id = '';
    syncFilterSelectsChrome();
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
      var extra =
        dup ||
        state.filters.document_id ||
        physQuickKey() ||
        state.filters.template_id ||
        state.filters.has_template;
      sum.textContent =
        (dup ? 'Bản ghi trùng khóa — ' : 'Tất cả tài liệu — ') +
        state.total +
        ' mục' +
        (state.filters.category_id !== 'all' || extra ? ' (đã lọc)' : '');
    }
    if (!tb) return;
    if (!state.documents.length) {
      tb.innerHTML =
        '<tr><td colspan="9" class="dms-empty">Không có tài liệu phù hợp. Thử đổi bộ lọc hoặc thêm tài liệu mới.</td></tr>';
      syncSelectAllHeader();
      renderPagination();
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
        var loc = d.physical_location ? escapeHtml(String(d.physical_location).slice(0, 56)) : '—';
        var caseRef = d.parent_case_ref
          ? '<div class="dms-doc-meta" style="margin-top:4px">Hồ sơ gốc: ' + escapeHtml(d.parent_case_ref) + '</div>'
          : '';
        var loanB =
          d.open_loan_count > 0
            ? '<span class="dms-badge dms-badge--loan">Đang mượn</span> '
            : '';
        var labelUrl =
          apiBase +
          '/api/dms/documents/' +
          d.id +
          '/label.html?token=' +
          encodeURIComponent(getToken());
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
          'Tải lên ' +
          fmtDate(d.uploaded_at) +
          ' · ' +
          escapeHtml(d.uploader_name || '') +
          ' · ' +
          fmtSize(d.file_size, d.file_path) +
          (d.issuing_unit ? ' · ĐV: ' + escapeHtml(d.issuing_unit) : '') +
          '</div>' +
          (tags ? '<div style="margin-top:6px">' + tags + '</div>' : '') +
          templateBadgeHtml(d) +
          docExternalLinksHtml(d) +
          caseRef +
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
          '<td><div class="dms-kho-cell">' +
          loc +
          '</div><div class="dms-kho-badges">' +
          loanB +
          destructionBadgeHtml(d) +
          '</div></td>' +
          renderPublicCell(d) +
          '<td><span class="' +
          statusClass(d.status) +
          '">' +
          statusLabel(d.status) +
          '</span><div class="dms-table-actions">' +
          (canEditRow(d)
            ? '<button type="button" class="dms-btn-table dms-btn-table--edit" data-act="edit">Sửa</button>'
            : '') +
          '<button type="button" class="dms-btn-table dms-btn-table--muted" data-act="phys">Kho</button>' +
          '<a class="dms-btn-table dms-btn-table--muted" href="' +
          escapeAttr(labelUrl) +
          '" target="_blank" rel="noopener">Nhãn</a>' +
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
          if (act === 'phys') openPhysModal(id);
        });
      });
      row.addEventListener('click', function (ev) {
        var target = ev.target;
        if (
          target &&
          target.closest &&
          target.closest('button, a, input, select, textarea, label, [data-act], .dms-public-select, .dms-row-check')
        ) {
          return;
        }
        window.location.href = 'dms-them-tai-lieu.html?id=' + id + '&mode=view';
      });
      var pubSel = row.querySelector('.dms-public-select');
      if (pubSel) {
        pubSel.addEventListener('change', function () {
          var docId = Number(pubSel.getAttribute('data-doc-public'));
          var want = pubSel.value === '1';
          var rollback = pubSel.getAttribute('data-prev') || '0';
          pubSel.disabled = true;
          api('/documents/' + docId + '/public', {
            method: 'PATCH',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify({ is_public: want }),
          })
            .then(function () {
              pubSel.setAttribute('data-prev', want ? '1' : '0');
              state.documents.forEach(function (x) {
                if (Number(x.id) === docId) x.is_public = want ? 1 : 0;
              });
            })
            .catch(function (err) {
              pubSel.value = rollback;
              alert(err.message || 'Không cập nhật được');
            })
            .finally(function () {
              pubSel.disabled = false;
            });
        });
      }
    });
    syncSelectAllHeader();
    renderPagination();
    if (state._highlightRowId) {
      var hid = state._highlightRowId;
      state._highlightRowId = null;
      setTimeout(function () {
        var row = tb.querySelector('tr[data-id="' + hid + '"]');
        if (row) {
          row.classList.add('dms-row-flash');
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          setTimeout(function () {
            row.classList.remove('dms-row-flash');
          }, 2800);
        }
      }, 120);
    }
  }

  function paginationPageNumbers(page, totalPages) {
    if (totalPages <= 9) {
      var a = [];
      for (var i = 1; i <= totalPages; i++) a.push(i);
      return a;
    }
    var out = [1];
    var start = Math.max(2, page - 2);
    var end = Math.min(totalPages - 1, page + 2);
    if (start > 2) out.push('…');
    for (var j = start; j <= end; j++) out.push(j);
    if (end < totalPages - 1) out.push('…');
    if (totalPages > 1) out.push(totalPages);
    return out;
  }

  function renderPagination() {
    var root = el('dms-pagination');
    var info = el('dms-pagination-info');
    var pagesEl = el('dms-pagination-pages');
    var prev = el('dms-page-prev');
    var next = el('dms-page-next');
    var sizeSel = el('dms-page-size');
    if (!root || !info) return;
    var total = state.total || 0;
    var limit = state.limit || 30;
    var page = state.page || 1;
    if (sizeSel) sizeSel.value = String(limit);
    if (total === 0) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    var totalPages = Math.max(1, Math.ceil(total / limit));
    var from = (page - 1) * limit + 1;
    var to = Math.min(page * limit, total);
    info.textContent =
      'Hiển thị ' + from + '–' + to + ' trong ' + total + ' mục · Trang ' + page + ' / ' + totalPages;
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= totalPages;
    if (!pagesEl) return;
    var nums = paginationPageNumbers(page, totalPages);
    pagesEl.innerHTML = nums
      .map(function (item) {
        if (item === '…') return '<span class="dms-pagination-ellipsis" aria-hidden="true">…</span>';
        var n = item;
        var active = n === page ? ' dms-pagination-num--active' : '';
        return (
          '<button type="button" class="dms-pagination-num' +
          active +
          '" data-dms-page="' +
          n +
          '">' +
          n +
          '</button>'
        );
      })
      .join('');
    pagesEl.querySelectorAll('[data-dms-page]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.page = Number(btn.getAttribute('data-dms-page'));
        loadDocuments();
      });
    });
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
    if (state.filters.template_id) p.set('template_id', state.filters.template_id);
    if (state.filters.has_template === '1' || state.filters.has_template === '0') {
      p.set('has_template', state.filters.has_template);
    }
    if (state.filters.quick) p.set('quick', state.filters.quick);
    if (state.filters.tag_ids.length) p.set('tag_ids', state.filters.tag_ids.join(','));
    if (state.filters.duplicates_only === '1') p.set('duplicates_only', '1');
    if (state.filters.file_mode) p.set('file_mode', state.filters.file_mode);
    if (state.filters.compliance === 'retention_alert') p.set('retention_alert', '1');
    if (state.filters.compliance === 'out_on_loan') p.set('out_on_loan', '1');
    if (state.filters.document_id) p.set('document_id', state.filters.document_id);
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
    var limit = state.limit || 30;
    var totalPages = Math.max(1, Math.ceil(state.total / limit));
    if (state.page > totalPages) {
      state.page = totalPages;
      return loadDocuments();
    }
    renderTable();
    renderTemplateSidebar();
    syncFilterSelectsChrome();
  }

  function renderTemplateSidebar() {
    var inner = el('dms-template-sidebar-inner');
    if (!inner) return;
    var st = state.stats || {};
    var tt = st.templatesTotal != null ? st.templatesTotal : '—';
    var dw = st.documentsWithTemplate != null ? st.documentsWithTemplate : '—';
    var totalDocs = st.total != null ? Number(st.total) : null;
    var dwN = st.documentsWithTemplate != null ? Number(st.documentsWithTemplate) : null;
    var dwo =
      totalDocs != null && dwN != null && Number.isFinite(totalDocs) && Number.isFinite(dwN)
        ? Math.max(0, totalDocs - dwN)
        : '—';
    var adm = state.me && state.me.canManageCatalog;
    var tid = state.filters.template_id;
    var ht = state.filters.has_template;
    var modeAll = !tid && ht !== '1' && ht !== '0';
    var modeLinked = ht === '1';
    var modeUnlinked = ht === '0';

    var html = '';
    html += '<div class="dms-template-hub">';
    html += '<p class="dms-template-hub-title">Mẫu biểu ISO</p>';
    html += '<div class="dms-template-hub-stats">';
    html +=
      '<span class="dms-template-hub-chip" title="Tổng mẫu trong danh mục (Công cụ quản trị)"><strong>' +
      tt +
      '</strong> mẫu</span>';
    html +=
      '<span class="dms-template-hub-chip" title="Hồ sơ đã gắn ít nhất một mẫu"><strong>' +
      dw +
      '</strong> HS có mẫu</span>';
    html += '</div>';
    html +=
      '<button type="button" class="dms-template-hub-cta" data-tpl-action="focus-filter">Chọn mẫu trong bộ lọc</button>';
    if (adm) {
      html +=
        '<a href="quan-tri-tai-lieu-hc.html" class="dms-template-hub-admin">Công cụ quản trị mẫu →</a>';
    }
    html += '</div>';
    html += '<div class="dms-nav-stack dms-template-nav-links">';
    html +=
      '<div class="dms-nav-item dms-nav-item--tpl' +
      (modeAll ? ' active' : '') +
      '" data-tpl-filter="all"><span>Không lọc theo mẫu</span><span class="cnt">' +
      (st.total != null ? st.total : '—') +
      '</span></div>';
    html +=
      '<div class="dms-nav-item dms-nav-item--tpl' +
      (modeLinked ? ' active' : '') +
      '" data-tpl-filter="linked"><span>Đã gắn mẫu</span><span class="cnt">' +
      dw +
      '</span></div>';
    html +=
      '<div class="dms-nav-item dms-nav-item--tpl' +
      (modeUnlinked ? ' active' : '') +
      '" data-tpl-filter="unlinked"><span>Chưa gắn mẫu</span><span class="cnt">' +
      dwo +
      '</span></div>';
    html += '</div>';
    inner.innerHTML = html;
  }

  function setupTemplateSidebarDelegation() {
    var root = el('dms-template-sidebar');
    if (!root || root.dataset.dmsTplDeleg) return;
    root.dataset.dmsTplDeleg = '1';
    root.addEventListener('click', function (ev) {
      var focusBtn = ev.target.closest && ev.target.closest('[data-tpl-action="focus-filter"]');
      if (focusBtn) {
        var wrap = el('dms-toolbar-filters');
        var sel = el('filter-template');
        if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (sel) {
          setTimeout(function () {
            sel.focus();
          }, 300);
        }
        return;
      }
      var nav = ev.target.closest && ev.target.closest('[data-tpl-filter]');
      if (!nav) return;
      var f = nav.getAttribute('data-tpl-filter');
      state.filters.template_id = '';
      var ft = el('filter-template');
      if (ft) ft.value = '';
      syncFilterSelectsChrome();
      if (f === 'linked') state.filters.has_template = '1';
      else if (f === 'unlinked') state.filters.has_template = '0';
      else state.filters.has_template = '';
      state.page = 1;
      loadDocuments();
      renderCategoryNav();
      renderQuickFilters();
      renderPhysNav();
      renderTags();
    });
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

    var tpl = await api('/templates');
    state.templates = tpl.templates || [];
    renderTemplateFilter();

    var tags = await api('/tags');
    state.tags = tags.tags || [];
    renderTags();
    renderQuickFilters();
    renderPhysNav();
    renderTemplateSidebar();

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

  function exportSummaryXlsx() {
    window.open(
      apiBase + '/api/dms/reports/summary.xlsx?token=' + encodeURIComponent(getToken()),
      '_blank'
    );
  }

  function closePhysModal() {
    var m = el('dms-phys-modal');
    if (!m) return;
    m.hidden = true;
    m.setAttribute('aria-hidden', 'true');
    state.physModal = { docId: null, tab: 'place', bundle: null, inventorySessionId: null };
  }

  function physSwitchTab(name) {
    state.physModal.tab = name;
    document.querySelectorAll('#dms-phys-tabs .dms-modal-tab').forEach(function (b) {
      b.classList.toggle('dms-modal-tab--on', b.getAttribute('data-phys-tab') === name);
    });
    physRenderBody();
  }

  function physRenderBody() {
    var box = el('dms-phys-body');
    if (!box || !state.physModal.bundle) return;
    var b = state.physModal.bundle;
    var d = b.document || {};
    var id = state.physModal.docId;
    var canUp = state.me && state.me.canUpload;
    var canInv = state.me && state.me.canManageAllDocs;
    el('dms-phys-tab-inv').style.display = canInv ? '' : 'none';
    if (state.physModal.tab === 'inv' && !canInv) state.physModal.tab = 'place';

    if (state.physModal.tab === 'place') {
      if (canUp) {
        box.innerHTML =
          '<p class="dms-modal-note">Mã kho / kệ / tủ / hộp — để nhân viên lấy đúng bản giấy.</p>' +
          '<div class="dms-modal-grid">' +
          '<label>Vị trí lưu trữ (mã kho)<textarea id="phys-loc" rows="2">' +
          escapeHtml(d.physical_location || '') +
          '</textarea></label>' +
          '<label>Bản giấy<select id="phys-copy">' +
          ['', 'original', 'copy', 'both', 'scan_copy']
            .map(function (v) {
              var labels = {
                '': '— Chọn —',
                original: 'Bản gốc',
                copy: 'Bản sao',
                both: 'Gốc + sao',
                scan_copy: 'Bản scan lưu kho',
              };
              return (
                '<option value="' +
                v +
                '"' +
                (String(d.physical_copy_type || '') === v ? ' selected' : '') +
                '>' +
                labels[v] +
                '</option>'
              );
            })
            .join('') +
          '</select></label>' +
          '<label>Số tờ<input type="number" id="phys-sheets" min="0" value="' +
          escapeAttr(d.physical_sheet_count != null ? String(d.physical_sheet_count) : '') +
          '"></label>' +
          '<label>Số trang<input type="number" id="phys-pages" min="0" value="' +
          escapeAttr(d.physical_page_count != null ? String(d.physical_page_count) : '') +
          '"></label>' +
          '<label>Bảo quản đến<input type="date" id="phys-ret" value="' +
          escapeAttr(d.retention_until ? String(d.retention_until).slice(0, 10) : '') +
          '"></label>' +
          '<label>Ngày đủ ĐK tiêu hủy<input type="date" id="phys-dest" value="' +
          escapeAttr(d.destruction_eligible_date ? String(d.destruction_eligible_date).slice(0, 10) : '') +
          '"></label>' +
          '<label style="grid-column:1/-1">Liên kết hồ sơ / công văn gốc (cùng vụ việc)<input type="text" id="phys-case" value="' +
          escapeAttr(d.parent_case_ref || '') +
          '" placeholder="VD: Số CV 123/2024-HC"></label></div>' +
          '<button type="button" class="dms-btn dms-btn-primary" id="phys-save-place">Lưu vị trí &amp; tuân thủ</button>';
        el('phys-save-place').addEventListener('click', function () {
          api('/documents/' + id, {
            method: 'PATCH',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify({
              physical_location: el('phys-loc').value,
              physical_copy_type: el('phys-copy').value || null,
              physical_sheet_count: el('phys-sheets').value,
              physical_page_count: el('phys-pages').value,
              retention_until: el('phys-ret').value,
              destruction_eligible_date: el('phys-dest').value,
              parent_case_ref: el('phys-case').value,
            }),
          })
            .then(function () {
              return api('/documents/' + id + '/physical-bundle');
            })
            .then(function (j) {
              state.physModal.bundle = j;
              alert('Đã lưu.');
              loadDocuments();
            })
            .catch(function (e) {
              alert(e.message);
            });
        });
      } else {
        box.innerHTML =
          '<dl class="dms-modal-dl">' +
          '<dt>Vị trí kho</dt><dd>' +
          escapeHtml(d.physical_location || '—') +
          '</dd>' +
          '<dt>Bản giấy</dt><dd>' +
          escapeHtml(d.physical_copy_type || '—') +
          '</dd>' +
          '<dt>Số tờ / trang</dt><dd>' +
          escapeHtml(
            [d.physical_sheet_count, d.physical_page_count].filter(function (x) {
              return x != null && x !== '';
            }).join(' / ') || '—'
          ) +
          '</dd>' +
          '<dt>Bảo quản đến</dt><dd>' +
          fmtDate(d.retention_until) +
          '</dd>' +
          '<dt>Đủ ĐK tiêu hủy</dt><dd>' +
          fmtDate(d.destruction_eligible_date) +
          '</dd>' +
          '<dt>Hồ sơ gốc</dt><dd>' +
          escapeHtml(d.parent_case_ref || '—') +
          '</dd></dl>' +
          '<p class="dms-modal-note">Chỉ tài khoản được phép tải lên / quản lý mới sửa được các trường này.</p>';
      }
      return;
    }

    if (state.physModal.tab === 'loan') {
      var active = b.activeLoan;
      var hist = (b.loans || [])
        .map(function (L) {
          return (
            '<tr><td>' +
            escapeHtml(L.borrower_name) +
            '</td><td>' +
            fmtDate(L.borrowed_at) +
            '</td><td>' +
            fmtDate(L.due_at) +
            '</td><td>' +
            (L.returned_at ? fmtDate(L.returned_at) : '<strong>Đang mượn</strong>') +
            '</td><td>' +
            (canUp && !L.returned_at
              ? '<button type="button" class="dms-btn dms-btn-sm" data-ret-loan="' +
                L.id +
                '">Trả</button>'
              : '') +
            '</td></tr>'
          );
        })
        .join('');
      box.innerHTML =
        (active
          ? '<div class="dms-modal-warn">Đang ngoài kho — người mượn: <strong>' +
            escapeHtml(active.borrower_name) +
            '</strong> · hạn trả: ' +
            fmtDate(active.due_at) +
            '</div>'
          : '<p class="dms-modal-note">Không có phiếu mượn đang mở.</p>') +
        (canUp
          ? '<h3 class="dms-modal-h3">Ghi nhận mượn mới</h3>' +
            '<div class="dms-modal-grid">' +
            '<label>Người mượn *<input type="text" id="loan-borrower" placeholder="Họ tên"></label>' +
            '<label>Lý do<input type="text" id="loan-reason"></label>' +
            '<label>Hạn trả<input type="date" id="loan-due"></label>' +
            '<label style="grid-column:1/-1">Ghi chú<textarea id="loan-notes" rows="2"></textarea></label></div>' +
            '<button type="button" class="dms-btn dms-btn-primary" id="loan-submit">Lưu phiếu mượn</button>'
          : '') +
        '<h3 class="dms-modal-h3">Lịch sử mượn</h3><div class="dms-modal-tablewrap"><table class="dms-mini-table"><thead><tr><th>Người mượn</th><th>Ngày mượn</th><th>Hạn</th><th>Trả</th><th></th></tr></thead><tbody>' +
        (hist || '<tr><td colspan="5">Chưa có dữ liệu</td></tr>') +
        '</tbody></table></div>';
      if (canUp) {
        var sub = el('loan-submit');
        if (sub) {
          sub.addEventListener('click', function () {
            var name = el('loan-borrower').value.trim();
            if (!name) {
              alert('Nhập tên người mượn.');
              return;
            }
            api('/documents/' + id + '/loans', {
              method: 'POST',
              headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
              body: JSON.stringify({
                borrower_name: name,
                reason: el('loan-reason').value,
                due_at: el('loan-due').value,
                notes: el('loan-notes').value,
              }),
            })
              .then(function () {
                return api('/documents/' + id + '/physical-bundle');
              })
              .then(function (j) {
                state.physModal.bundle = j;
                physRenderBody();
                loadDocuments();
              })
              .catch(function (e) {
                alert(e.message);
              });
          });
        }
      }
      box.querySelectorAll('[data-ret-loan]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var lid = Number(btn.getAttribute('data-ret-loan'));
          api('/documents/' + id + '/loans/' + lid + '/return', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify({}),
          })
            .then(function () {
              return api('/documents/' + id + '/physical-bundle');
            })
            .then(function (j) {
              state.physModal.bundle = j;
              physRenderBody();
              loadDocuments();
            })
            .catch(function (e) {
              alert(e.message);
            });
        });
      });
      return;
    }

    if (state.physModal.tab === 'hand') {
      var rows = (b.handovers || [])
        .map(function (h) {
          return (
            '<tr><td>' +
            fmtDate(h.handed_at) +
            '</td><td>' +
            escapeHtml(h.from_party) +
            '</td><td>' +
            escapeHtml(h.to_party) +
            '</td><td>' +
            escapeHtml(h.notes || '') +
            '</td><td>' +
            escapeHtml(h.creator_name || '') +
            '</td></tr>'
          );
        })
        .join('');
      box.innerHTML =
        (canUp
          ? '<div class="dms-modal-grid">' +
            '<label>Bên giao *<input type="text" id="hand-from"></label>' +
            '<label>Bên nhận *<input type="text" id="hand-to"></label>' +
            '<label style="grid-column:1/-1">Ghi chú<textarea id="hand-notes" rows="2"></textarea></label></div>' +
            '<button type="button" class="dms-btn dms-btn-primary" id="hand-submit">Ghi nhận bàn giao</button>'
          : '<p class="dms-modal-note">Chỉ tài khoản tải lên / quản lý ghi nhận bàn giao mới.</p>') +
        '<h3 class="dms-modal-h3">Nhật ký bàn giao</h3><div class="dms-modal-tablewrap"><table class="dms-mini-table"><thead><tr><th>Thời điểm</th><th>Giao</th><th>Nhận</th><th>Ghi chú</th><th>Người ghi</th></tr></thead><tbody>' +
        (rows || '<tr><td colspan="5">Chưa có</td></tr>') +
        '</tbody></table></div>';
      var hs = el('hand-submit');
      if (hs) {
        hs.addEventListener('click', function () {
          var fp = el('hand-from').value.trim();
          var tp = el('hand-to').value.trim();
          if (!fp || !tp) {
            alert('Nhập bên giao và bên nhận.');
            return;
          }
          api('/documents/' + id + '/handovers', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify({
              from_party: fp,
              to_party: tp,
              notes: el('hand-notes').value,
            }),
          })
            .then(function () {
              return api('/documents/' + id + '/physical-bundle');
            })
            .then(function (j) {
              state.physModal.bundle = j;
              physRenderBody();
            })
            .catch(function (e) {
              alert(e.message);
            });
        });
      }
      return;
    }

    if (state.physModal.tab === 'inv') {
      var sid = state.physModal.inventorySessionId || '';
      box.innerHTML =
        '<p class="dms-modal-note">Kiểm kê định kỳ: đối chiếu thực tế với hệ thống (đủ / thiếu / sai vị trí).</p>' +
        '<button type="button" class="dms-btn dms-btn-primary" id="inv-new">Tạo phiên kiểm kê mới</button>' +
        '<div class="dms-modal-grid" style="margin-top:12px">' +
        '<label>ID phiên hiện tại<input type="number" id="inv-sid" value="' +
        escapeAttr(sid ? String(sid) : '') +
        '" placeholder="Bấm «Tạo phiên» hoặc nhập ID"></label>' +
        '<label>ID tài liệu (mặc định hồ sơ đang mở)<input type="number" id="inv-doc" value="' +
        String(id) +
        '"></label>' +
        '<label>Kết quả<select id="inv-st"><option value="ok">Đủ — đúng vị trí</option><option value="missing">Thiếu trong kho</option><option value="wrong_location">Sai vị trí</option></select></label>' +
        '<label>Vị trí thực tế ghi nhận<input type="text" id="inv-loc" placeholder="Nếu khác trên hệ thống"></label>' +
        '<label style="grid-column:1/-1">Ghi chú<textarea id="inv-notes" rows="2"></textarea></label></div>' +
        '<button type="button" class="dms-btn dms-btn-primary" id="inv-save">Ghi nhận kiểm đếm</button>';
      el('inv-new').addEventListener('click', function () {
        api('/inventory/sessions', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ name: '' }),
        })
          .then(function (r) {
            state.physModal.inventorySessionId = r.id;
            el('inv-sid').value = String(r.id);
            alert('Đã tạo phiên #' + r.id);
          })
          .catch(function (e) {
            alert(e.message);
          });
      });
      el('inv-save').addEventListener('click', function () {
        var s = parseInt(el('inv-sid').value, 10);
        var doc = parseInt(el('inv-doc').value, 10);
        if (!Number.isFinite(s) || s <= 0) {
          alert('Nhập ID phiên kiểm kê (hoặc tạo phiên mới).');
          return;
        }
        if (!Number.isFinite(doc) || doc <= 0) {
          alert('ID tài liệu không hợp lệ.');
          return;
        }
        api('/inventory/sessions/' + s + '/items', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({
            document_id: doc,
            status: el('inv-st').value,
            physical_location_found: el('inv-loc').value,
            notes: el('inv-notes').value,
          }),
        })
          .then(function () {
            alert('Đã ghi nhận.');
            state.physModal.inventorySessionId = s;
          })
          .catch(function (e) {
            alert(e.message);
          });
      });
    }
  }

  function openPhysModal(docId) {
    var m = el('dms-phys-modal');
    if (!m) return;
    state.physModal.docId = docId;
    state.physModal.tab = 'place';
    state.physModal.inventorySessionId = null;
    m.hidden = false;
    m.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('#dms-phys-tabs .dms-modal-tab').forEach(function (b) {
      b.classList.toggle('dms-modal-tab--on', b.getAttribute('data-phys-tab') === 'place');
    });
    el('dms-phys-body').innerHTML = '<p class="dms-modal-note">Đang tải…</p>';
    api('/documents/' + docId + '/physical-bundle')
      .then(function (j) {
        state.physModal.bundle = j;
        physRenderBody();
      })
      .catch(function (e) {
        el('dms-phys-body').innerHTML =
          '<p class="dms-modal-warn">' + escapeHtml(e.message) + '</p>';
      });
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
      syncFilterSelectsChrome();
      loadDocuments();
    });
    el('filter-year').addEventListener('change', function () {
      state.filters.year = el('filter-year').value;
      state.page = 1;
      syncFilterSelectsChrome();
      loadDocuments();
    });
    el('filter-doc-type').addEventListener('change', function () {
      state.filters.document_type_id = el('filter-doc-type').value;
      state.page = 1;
      syncFilterSelectsChrome();
      loadDocuments();
    });
    var fTpl = el('filter-template');
    if (fTpl) {
      fTpl.addEventListener('change', function () {
        state.filters.template_id = fTpl.value;
        state.filters.has_template = '';
        state.page = 1;
        syncFilterSelectsChrome();
        loadDocuments();
      });
    }
    el('filter-sort').addEventListener('change', function () {
      state.filters.sort = el('filter-sort').value;
      state.page = 1;
      syncFilterSelectsChrome();
      loadDocuments();
    });
    var ff = el('filter-file-mode');
    if (ff) {
      ff.addEventListener('change', function () {
        state.filters.file_mode = ff.value;
        state.filters.compliance = '';
        var cp = el('filter-compliance');
        if (cp) cp.value = '';
        state.filters.document_id = '';
        state.filters.has_template = '';
        state.page = 1;
        syncFilterSelectsChrome();
        loadDocuments();
        renderPhysNav();
      });
    }
    var fc = el('filter-compliance');
    if (fc) {
      fc.addEventListener('change', function () {
        state.filters.compliance = fc.value;
        state.filters.file_mode = '';
        if (ff) ff.value = '';
        state.filters.document_id = '';
        state.filters.has_template = '';
        state.page = 1;
        syncFilterSelectsChrome();
        loadDocuments();
        renderPhysNav();
      });
    }
    var sumBtn = el('dms-btn-summary');
    if (sumBtn) sumBtn.addEventListener('click', exportSummaryXlsx);
    var pmodal = el('dms-phys-modal');
    if (pmodal) {
      pmodal.querySelectorAll('[data-phys-close]').forEach(function (n) {
        n.addEventListener('click', closePhysModal);
      });
      document.querySelectorAll('#dms-phys-tabs [data-phys-tab]').forEach(function (b) {
        b.addEventListener('click', function () {
          physSwitchTab(b.getAttribute('data-phys-tab'));
        });
      });
    }
    var fdup = el('filter-dup');
    if (fdup) {
      fdup.addEventListener('change', function () {
        state.filters.duplicates_only = fdup.value;
        state.filters.has_template = '';
        state.page = 1;
        syncFilterSelectsChrome();
        loadDocuments();
        renderPhysNav();
      });
    }
    setupTemplateSidebarDelegation();
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
    var pagePrev = el('dms-page-prev');
    var pageNext = el('dms-page-next');
    var pageSize = el('dms-page-size');
    if (pagePrev) {
      pagePrev.addEventListener('click', function () {
        if (state.page > 1) {
          state.page--;
          loadDocuments();
        }
      });
    }
    if (pageNext) {
      pageNext.addEventListener('click', function () {
        var lim = state.limit || 30;
        var tp = Math.max(1, Math.ceil((state.total || 0) / lim));
        if (state.page < tp) {
          state.page++;
          loadDocuments();
        }
      });
    }
    if (pageSize) {
      pageSize.addEventListener('change', function () {
        var n = parseInt(pageSize.value, 10);
        state.limit = Math.max(1, Math.min(500, Number.isFinite(n) ? n : 30));
        state.page = 1;
        loadDocuments();
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
    var urlP = new URLSearchParams(window.location.search);
    var hl = urlP.get('highlightDoc');
    if (hl) {
      var nid = Number(hl);
      if (Number.isFinite(nid) && nid > 0) {
        state.filters.document_id = String(nid);
        state._highlightRowId = nid;
        state.filters.year = 'all';
        state.filters.category_id = 'all';
        state.filters.quick = '';
        state.filters.file_mode = '';
        state.filters.compliance = '';
        state.filters.template_id = '';
        state.filters.has_template = '';
        urlP.delete('highlightDoc');
        var clean = window.location.pathname + (urlP.toString() ? '?' + urlP.toString() : '');
        window.history.replaceState({}, '', clean);
      }
    }
    wireUi();
    fillYearSelect();
    if (state.filters.document_id) {
      var ysel = el('filter-year');
      if (ysel) ysel.value = 'all';
      state.filters.year = 'all';
      syncFilterSelectsChrome();
    }
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
    syncFilterSelectsChrome();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
