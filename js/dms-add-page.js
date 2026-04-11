/**
 * Trang thêm / sửa tài liệu + import Excel mẫu Quyết định
 */
(function () {
  var apiBase =
    window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')
      ? 'http://localhost:3000'
      : '';

  function getToken() {
    return localStorage.getItem('token') || '';
  }

  function authHeaders(isJson) {
    var h = { Accept: 'application/json', Authorization: 'Bearer ' + getToken() };
    if (isJson) h['Content-Type'] = 'application/json';
    return h;
  }

  async function api(path, opts) {
    opts = opts || {};
    var r = await fetch(apiBase + '/api/dms' + path, Object.assign({ headers: authHeaders(!!opts.body && typeof opts.body === 'string') }, opts));
    var j = {};
    try {
      j = await r.json();
    } catch (e) {}
    if (!r.ok) throw new Error(j.message || 'Lỗi ' + r.status);
    return j;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  var state = { categories: [], types: [], tags: [], editId: null };

  function showTab(name) {
    document.querySelectorAll('[data-add-tab]').forEach(function (p) {
      p.style.display = p.getAttribute('data-add-tab') === name ? 'block' : 'none';
    });
    document.querySelectorAll('[data-add-tab-btn]').forEach(function (b) {
      b.classList.toggle('dms-add-tab--on', b.getAttribute('data-add-tab-btn') === name);
    });
  }

  function fillCategorySelect() {
    var sel = el('f-cat');
    sel.innerHTML =
      '<option value="">— Chọn danh mục —</option>' +
      state.categories
        .filter(function (c) {
          return c.is_active;
        })
        .map(function (c) {
          var pad = c.parent_id ? '　' : '';
          return '<option value="' + c.id + '">' + pad + escapeHtml(c.name) + '</option>';
        })
        .join('');
  }

  function fillTypeSelect() {
    var sel = el('f-type');
    sel.innerHTML =
      '<option value="">— Chọn loại —</option>' +
      state.types
        .filter(function (t) {
          return t.is_active;
        })
        .map(function (t) {
          return '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>';
        })
        .join('');
  }

  function fillImportSelects() {
    el('imp-cat').innerHTML = el('f-cat').innerHTML;
    el('imp-type').innerHTML = el('f-type').innerHTML;
  }

  function fillTagChecks(selected) {
    var box = el('f-tags');
    var selIds = {};
    (selected || []).forEach(function (t) {
      selIds[t.id] = true;
    });
    box.innerHTML = state.tags
      .map(function (t) {
        var c = selIds[t.id] ? ' checked' : '';
        return (
          '<label class="dms-add-tag"><input type="checkbox" name="tag" value="' +
          t.id +
          '"' +
          c +
          '> ' +
          escapeHtml(t.name) +
          '</label>'
        );
      })
      .join('');
  }

  async function submitManual(ev) {
    ev.preventDefault();
    var editId = state.editId;
    var tagEls = el('f-tags').querySelectorAll('input[name="tag"]:checked');
    var tagIds = Array.prototype.map.call(tagEls, function (x) {
      return Number(x.value);
    });

    try {
      if (editId) {
        await api('/documents/' + editId, {
          method: 'PATCH',
          headers: authHeaders(true),
          body: JSON.stringify({
            title: el('f-title').value,
            ref_number: el('f-ref').value,
            status: el('f-status').value,
            issue_date: el('f-issue').value,
            valid_until: el('f-valid').value,
            notes: el('f-notes').value,
            category_id: el('f-cat').value ? Number(el('f-cat').value) : null,
            document_type_id: el('f-type').value ? Number(el('f-type').value) : null,
            issuing_unit: el('f-dv').value,
            external_scan_link: el('f-scan').value,
            external_word_link: el('f-word').value,
            tag_ids: JSON.stringify(tagIds),
          }),
        });
        window.location.href = 'tai-lieu-hanh-chinh.html';
        return;
      }

      var fd = new FormData();
      fd.append('title', el('f-title').value);
      fd.append('ref_number', el('f-ref').value);
      fd.append('status', el('f-status').value);
      fd.append('issue_date', el('f-issue').value);
      fd.append('valid_until', el('f-valid').value);
      fd.append('notes', el('f-notes').value);
      fd.append('issuing_unit', el('f-dv').value);
      fd.append('external_scan_link', el('f-scan').value);
      fd.append('external_word_link', el('f-word').value);
      if (el('f-cat').value) fd.append('category_id', el('f-cat').value);
      if (el('f-type').value) fd.append('document_type_id', el('f-type').value);
      fd.append('tag_ids', JSON.stringify(tagIds));
      var f = el('f-file').files[0];
      if (f) fd.append('file', f);
      else {
        if (!el('f-title').value.trim()) {
          alert('Nhập tiêu đề hoặc chọn file đính kèm.');
          return;
        }
      }
      var r = await fetch(apiBase + '/api/dms/documents', { method: 'POST', headers: authHeaders(), body: fd });
      var j = await r.json();
      if (!r.ok) throw new Error(j.message || 'Lỗi');
      window.location.href = 'tai-lieu-hanh-chinh.html';
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  function renderPreview(data) {
    var box = el('imp-report');
    var html = '';
    if (data.parseErrors && data.parseErrors.length) {
      html += '<p class="dms-add-warn"><strong>Sheet không đọc được tiêu đề:</strong></p><ul>';
      data.parseErrors.forEach(function (e) {
        html += '<li>' + escapeHtml(e.sheet) + ': ' + escapeHtml(e.message) + '</li>';
      });
      html += '</ul>';
    }
    html +=
      '<p><strong>Tóm tắt (xem trước):</strong> sẽ nhập <strong>' +
      (data.wouldImport || 0) +
      '</strong> dòng; bỏ qua <strong>' +
      (data.wouldSkipDb || 0) +
      '</strong> trùng đã có trong hệ thống; <strong>' +
      (data.wouldSkipBatch || 0) +
      '</strong> trùng trong file.</p>';

    if (data.details && data.details.skippedDb && data.details.skippedDb.length) {
      html += '<h4 class="dms-add-h4">Trùng với CSDL (sẽ không nhập lại)</h4><div class="dms-add-table-wrap"><table class="dms-add-table"><thead><tr><th>Sheet</th><th>Dòng</th><th>Số QĐ</th><th>Ngày BH</th><th>ID hiện có</th></tr></thead><tbody>';
      data.details.skippedDb.slice(0, 80).forEach(function (r) {
        html +=
          '<tr><td>' +
          escapeHtml(r.sheet) +
          '</td><td>' +
          r.excelRow +
          '</td><td>' +
          escapeHtml(r.ref_number) +
          '</td><td>' +
          escapeHtml(r.issue_date) +
          '</td><td>#' +
          r.existingId +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
      if (data.details.skippedDb.length > 80) html += '<p>… và ' + (data.details.skippedDb.length - 80) + ' dòng khác.</p>';
    }

    if (data.details && data.details.skippedBatch && data.details.skippedBatch.length) {
      html += '<h4 class="dms-add-h4">Trùng trong cùng file Excel</h4><div class="dms-add-table-wrap"><table class="dms-add-table"><thead><tr><th>Sheet</th><th>Dòng</th><th>Số QĐ</th><th>Ngày BH</th></tr></thead><tbody>';
      data.details.skippedBatch.slice(0, 50).forEach(function (r) {
        html +=
          '<tr><td>' +
          escapeHtml(r.sheet) +
          '</td><td>' +
          r.excelRow +
          '</td><td>' +
          escapeHtml(r.ref_number) +
          '</td><td>' +
          escapeHtml(r.issue_date) +
          '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    if (data.parseRowErrors && data.parseRowErrors.length) {
      html += '<h4 class="dms-add-h4">Dòng lỗi (thiếu Số QĐ / ngày)</h4><ul>';
      data.parseRowErrors.forEach(function (e) {
        html += '<li>' + escapeHtml(e.sheet) + ' dòng ' + e.excelRow + ': ' + escapeHtml(e.message) + '</li>';
      });
      html += '</ul>';
    }

    box.innerHTML = html || '<p>Không có dữ liệu xem trước.</p>';
    el('imp-btn-run').disabled = (data.wouldImport || 0) <= 0;
  }

  async function runPreview() {
    var file = el('imp-file').files[0];
    if (!file) {
      alert('Chọn file Excel (.xlsx).');
      return;
    }
    var fd = new FormData();
    fd.append('file', file);
    if (el('imp-cat').value) fd.append('category_id', el('imp-cat').value);
    if (el('imp-type').value) fd.append('document_type_id', el('imp-type').value);
    fd.append('default_status', el('imp-status').value);
    var r = await fetch(apiBase + '/api/dms/import/excel-preview', {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + getToken() },
      body: fd,
    });
    var j = await r.json();
    if (!r.ok) throw new Error(j.message || 'Lỗi xem trước');
    renderPreview(j);
    window._dmsLastImportPreview = j;
  }

  async function runImport() {
    if (!window._dmsLastImportPreview) {
      alert('Bấm «Xem trước & kiểm tra trùng» trước.');
      return;
    }
    if (!confirm('Xác nhận nhập dữ liệu vào hệ thống?')) return;
    var file = el('imp-file').files[0];
    if (!file) {
      alert('Chọn lại file Excel.');
      return;
    }
    var fd = new FormData();
    fd.append('file', file);
    if (el('imp-cat').value) fd.append('category_id', el('imp-cat').value);
    if (el('imp-type').value) fd.append('document_type_id', el('imp-type').value);
    fd.append('default_status', el('imp-status').value);
    var r = await fetch(apiBase + '/api/dms/import/excel', {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + getToken() },
      body: fd,
    });
    var j = await r.json();
    if (!r.ok) throw new Error(j.message || 'Lỗi import');
    el('imp-report').innerHTML =
      '<p class="dms-add-ok"><strong>Hoàn tất.</strong> ' +
      escapeHtml(j.message || '') +
      '</p><p><a class="dms-link" href="tai-lieu-hanh-chinh.html">→ Về trang Quản lý tài liệu</a></p>';
    window._dmsLastImportPreview = null;
  }

  async function init() {
    if (!getToken()) {
      window.location.href = 'dang-nhap.html?returnUrl=' + encodeURIComponent('dms-them-tai-lieu.html');
      return;
    }

    var me = await api('/me');
    if (!me.canUpload) {
      el('dms-add-main').innerHTML =
        '<div class="dms-nope"><h2>Không có quyền</h2><p>Chỉ tài khoản được cấp quyền tải lên / quản lý mới thêm hoặc import tài liệu.</p></div>';
      return;
    }

    var cats = await api('/categories');
    state.categories = cats.categories || [];
    var types = await api('/document-types');
    state.types = types.types || [];
    var tags = await api('/tags');
    state.tags = tags.tags || [];

    fillCategorySelect();
    fillTypeSelect();
    fillImportSelects();
    fillTagChecks();

    var idParam = qs('id');
    if (idParam) {
      state.editId = Number(idParam);
      if (Number.isFinite(state.editId)) {
        var doc = await api('/documents/' + state.editId);
        var d = doc.document;
        el('page-title').textContent = 'Sửa tài liệu';
        el('f-title').value = d.title || '';
        el('f-ref').value = d.ref_number || '';
        el('f-status').value = d.status || 'draft';
        el('f-issue').value = d.issue_date ? String(d.issue_date).slice(0, 10) : '';
        el('f-valid').value = d.valid_until ? String(d.valid_until).slice(0, 10) : '';
        el('f-notes').value = d.notes || '';
        el('f-dv').value = d.issuing_unit || '';
        el('f-scan').value = d.external_scan_link || '';
        el('f-word').value = d.external_word_link || '';
        el('f-cat').value = d.category_id || '';
        el('f-type').value = d.document_type_id || '';
        fillTagChecks(d.tags || []);
        el('f-file').removeAttribute('required');
        el('f-file-help').textContent =
          d.file_path === '__no_file__'
            ? 'Hiện chưa có PDF trên máy chủ — chọn file để đính kèm (cần API bổ sung) hoặc giữ link scan.'
            : 'Để giữ file hiện tại, không chọn file mới.';
        showTab('manual');
        document.querySelectorAll('[data-add-tab-btn="import"]').forEach(function (b) {
          b.style.display = 'none';
        });
      }
    }

    el('tab-manual').addEventListener('click', function () {
      showTab('manual');
    });
    el('tab-import').addEventListener('click', function () {
      showTab('import');
    });
    el('form-manual').addEventListener('submit', submitManual);
    el('imp-preview').addEventListener('click', function () {
      runPreview().catch(function (e) {
        alert(e.message);
      });
    });
    el('imp-btn-run').addEventListener('click', function () {
      runImport().catch(function (e) {
        alert(e.message);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
