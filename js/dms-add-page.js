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

  function syncVnDateHint(inputId, hintId) {
    var inp = el(inputId);
    var h = el(hintId);
    if (!inp || !h) return;
    var v = inp.value;
    if (!v) {
      h.textContent = '';
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      var p = v.split('-');
      h.textContent =
        'Trong danh sách tài liệu hiển thị dạng ngày/tháng/năm: ' + p[2] + '/' + p[1] + '/' + p[0] + '.';
    } else {
      h.textContent = '';
    }
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

  var state = { categories: [], types: [], templates: [], tags: [], editId: null, readOnly: false };

  function ensureMultiFileUi() {
    var baseInput = el('f-file');
    if (!baseInput || !baseInput.parentElement) return;
    var wrap = baseInput.parentElement;
    wrap.classList.add('dms-attach-panel');
    baseInput.classList.add('dms-attach-main-input');

    if (!el('f-extra-files')) {
      var extra = document.createElement('div');
      extra.id = 'f-extra-files';
      extra.className = 'dms-attach-extra-files';
      wrap.insertBefore(extra, el('f-file-help'));
    }
    if (!el('f-add-file')) {
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'dms-btn dms-btn-ghost dms-attach-add-btn';
      addBtn.id = 'f-add-file';
      addBtn.textContent = '+ Thêm file';
      wrap.insertBefore(addBtn, el('f-file-help'));
    }
    if (!el('f-upload-files')) {
      var uploadBtn = document.createElement('button');
      uploadBtn.type = 'button';
      uploadBtn.className = 'dms-btn dms-btn-primary dms-attach-upload-btn';
      uploadBtn.id = 'f-upload-files';
      uploadBtn.textContent = 'Upload file bổ sung';
      wrap.insertBefore(uploadBtn, el('f-file-help'));
    }
    if (!el('f-actions-row')) {
      var actions = document.createElement('div');
      actions.id = 'f-actions-row';
      actions.className = 'dms-attach-actions';
      var addBtnNode = el('f-add-file');
      var uploadBtnNode = el('f-upload-files');
      if (addBtnNode) actions.appendChild(addBtnNode);
      if (uploadBtnNode) actions.appendChild(uploadBtnNode);
      wrap.insertBefore(actions, el('f-extra-files'));
    }
    if (!el('f-existing-files')) {
      var list = document.createElement('div');
      list.id = 'f-existing-files';
      list.className = 'dms-add-note dms-attach-existing';
      wrap.insertBefore(list, el('f-file-help'));
    }

    var addBtnFinal = el('f-add-file');
    if (addBtnFinal) {
      addBtnFinal.classList.add('dms-btn', 'dms-attach-add-btn');
      addBtnFinal.classList.remove('dms-btn-ghost');
      addBtnFinal.textContent = '+ Thêm file';
    }
    var uploadBtnFinal = el('f-upload-files');
    if (uploadBtnFinal) {
      uploadBtnFinal.classList.add('dms-btn', 'dms-btn-primary', 'dms-attach-upload-btn');
    }
  }

  function renderQuickDownloadLinks(doc) {
    var scan = doc && doc.external_scan_link ? String(doc.external_scan_link).trim() : '';
    var word = doc && doc.external_word_link ? String(doc.external_word_link).trim() : '';
    var holder = el('f-download-links');
    if (!holder) {
      var panel = document.querySelector('[data-add-tab="manual"]');
      var form = el('form-manual');
      if (!panel || !form) return;
      holder = document.createElement('div');
      holder.id = 'f-download-links';
      holder.className = 'dms-add-note';
      holder.style.margin = '0 0 14px';
      panel.insertBefore(holder, form);
    }
    if (!scan && !word) {
      holder.innerHTML = '';
      return;
    }
    var links = [];
    if (scan) {
      links.push(
        '<a class="dms-btn dms-btn-ghost" target="_blank" rel="noopener noreferrer" href="' +
          scan.replace(/"/g, '&quot;') +
          '">Tải link PDF</a>'
      );
    }
    if (word) {
      links.push(
        '<a class="dms-btn dms-btn-ghost" target="_blank" rel="noopener noreferrer" href="' +
          word.replace(/"/g, '&quot;') +
          '">Tải link Word</a>'
      );
    }
    holder.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap"><strong style="align-self:center">Tải nhanh:</strong>' + links.join('') + '</div>';
  }

  function setFormReadOnly() {
    var title = el('page-title');
    if (title) title.textContent = 'Xem tài liệu';
    var form = el('form-manual');
    if (!form) return;
    form.querySelectorAll('input, select, textarea, button, a').forEach(function (node) {
      var tag = (node.tagName || '').toUpperCase();
      if (tag === 'A') return;
      var type = (node.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'file' || type === 'checkbox' || type === 'radio') {
        node.disabled = true;
        return;
      }
      node.readOnly = true;
      node.disabled = true;
    });
    var actions = form.querySelector('.dms-add-actions');
    if (actions) actions.style.display = 'none';
    document.querySelectorAll('[data-add-tab-btn="import"]').forEach(function (b) {
      b.style.display = 'none';
    });
    var note = document.createElement('p');
    note.className = 'dms-add-note';
    note.style.margin = '0 0 12px';
    note.textContent = 'Bạn đang ở chế độ chỉ xem, không thể chỉnh sửa thông tin tài liệu.';
    var panel = document.querySelector('[data-add-tab="manual"]');
    if (panel) panel.insertBefore(note, panel.querySelector('h2').nextSibling);
    renderReadonlyLinkActions();
  }

  function renderReadonlyLinkActions() {
    var scanInput = el('f-scan');
    var wordInput = el('f-word');
    if (!scanInput || !wordInput) return;
    var scanUrl = String(scanInput.value || '').trim();
    var wordUrl = String(wordInput.value || '').trim();

    var box = el('f-readonly-downloads');
    if (!box) {
      box = document.createElement('div');
      box.id = 'f-readonly-downloads';
      box.className = 'dms-add-note';
      box.style.marginTop = '10px';
      var host = wordInput.closest('.dms-add-grid') || wordInput.parentElement;
      if (!host || !host.parentElement) return;
      host.parentElement.insertBefore(box, host.nextSibling);
    }

    if (!scanUrl && !wordUrl) {
      box.innerHTML = '';
      return;
    }

    var links = [];
    if (scanUrl) {
      links.push(
        '<a class="dms-btn dms-btn-primary" target="_blank" rel="noopener noreferrer" href="' +
          scanUrl.replace(/"/g, '&quot;') +
          '">Mở link PDF</a>'
      );
    }
    if (wordUrl) {
      links.push(
        '<a class="dms-btn dms-btn-primary" target="_blank" rel="noopener noreferrer" href="' +
          wordUrl.replace(/"/g, '&quot;') +
          '">Mở link Word</a>'
      );
    }
    box.innerHTML =
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
      '<strong>Tải tài liệu:</strong>' +
      links.join('') +
      '</div>';
  }

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

  function fillTemplateSelect(includeIdForEdit) {
    var sel = el('f-template');
    if (!sel) return;
    var cur = sel.value;
    var pid = includeIdForEdit != null ? Number(includeIdForEdit) : NaN;
    var keepInactive = Number.isFinite(pid) && pid > 0;
    sel.innerHTML =
      '<option value="">— Không gắn mẫu —</option>' +
      (state.templates || [])
        .filter(function (t) {
          return t.is_active || (keepInactive && t.id === pid);
        })
        .map(function (t) {
          return (
            '<option value="' +
            t.id +
            '">' +
            escapeHtml(t.code + ' — v' + (t.version || '1.0') + ' — ' + (t.name || '')) +
            '</option>'
          );
        })
        .join('');
    if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
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

  function resetManualFormForNextEntry() {
    el('form-manual').reset();
    if (el('f-extra-files')) el('f-extra-files').innerHTML = '';
    if (el('f-existing-files')) el('f-existing-files').innerHTML = '';
    fillTagChecks();
    fillTemplateSelect();
    syncVnDateHint('f-issue', 'f-issue-hint');
    syncVnDateHint('f-valid', 'f-valid-hint');
  }

  function addExtraFileInput() {
    var box = el('f-extra-files');
    if (!box) return;
    var row = document.createElement('div');
    row.className = 'dms-attach-extra-row';
    row.innerHTML =
      '<input type="file" class="f-extra-file dms-attach-extra-input">' +
      '<button type="button" class="dms-btn dms-btn-ghost f-extra-file-remove">Xóa dòng</button>';
    box.appendChild(row);
    var rm = row.querySelector('.f-extra-file-remove');
    if (rm) {
      rm.addEventListener('click', function () {
        row.remove();
      });
    }
  }

  function collectExtraFiles() {
    var files = [];
    var box = el('f-extra-files');
    if (!box) return files;
    box.querySelectorAll('.f-extra-file').forEach(function (inp) {
      if (inp.files && inp.files[0]) files.push(inp.files[0]);
    });
    return files;
  }

  async function uploadExtraFilesOnly() {
    if (!state.editId) {
      alert('Chỉ upload thêm file khi đang ở chế độ sửa tài liệu.');
      return;
    }
    if (state.readOnly) return;
    var allFiles = [];
    var mainFile = el('f-file').files && el('f-file').files[0] ? el('f-file').files[0] : null;
    if (mainFile) allFiles.push(mainFile);
    allFiles = allFiles.concat(collectExtraFiles());
    if (!allFiles.length) {
      alert('Bạn chưa chọn file để upload.');
      return;
    }
    var btn = el('f-upload-files');
    var oldText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Đang upload...';
    }
    try {
      var fd = new FormData();
      allFiles.forEach(function (f) {
        fd.append('files', f);
      });
      var r = await fetch(apiBase + '/api/dms/documents/' + state.editId + '/attachments', {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + getToken() },
        body: fd,
      });
      var j = await r.json().catch(function () {
        return {};
      });
      if (!r.ok) throw new Error(j.message || 'Không upload được file bổ sung');
      if (el('f-file')) el('f-file').value = '';
      if (el('f-extra-files')) el('f-extra-files').innerHTML = '';
      var refreshed = await api('/documents/' + state.editId);
      renderExistingAttachments((refreshed.document && refreshed.document.attachments) || [], state.editId);
      alert('Đã upload ' + (j.uploaded || allFiles.length) + ' file bổ sung.');
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || 'Upload file bổ sung';
      }
    }
  }

  function renderExistingAttachments(list, docId) {
    var root = el('f-existing-files');
    if (!root) return;
    if (!list || !list.length) {
      root.innerHTML = '<div class="dms-attach-empty">Chưa có file bổ sung.</div>';
      return;
    }
    root.innerHTML =
      '<div class="dms-attach-existing-title">File đã upload</div>' +
      list
        .map(function (a) {
          return (
            '<div class="dms-attach-item">' +
            '<a class="dms-link dms-attach-item-name" target="_blank" rel="noopener" href="' +
            apiBase +
            '/api/dms/documents/' +
            docId +
            '/attachments/' +
            a.id +
            '/file">' +
            escapeHtml(a.original_name || ('file_' + a.id)) +
            '</a>' +
            (state.readOnly
              ? ''
              : '<button type="button" class="dms-btn dms-btn-ghost dms-attach-delete" data-attachment-id="' +
                a.id +
                '">Xóa</button>') +
            '</div>'
          );
        })
        .join('');
    root.querySelectorAll('.dms-attach-delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var attachmentId = Number(btn.getAttribute('data-attachment-id'));
        if (!Number.isFinite(attachmentId) || attachmentId <= 0) return;
        if (!confirm('Xóa file đính kèm này?')) return;
        btn.disabled = true;
        fetch(apiBase + '/api/dms/documents/' + docId + '/attachments/' + attachmentId, {
          method: 'DELETE',
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + getToken() },
        })
          .then(async function (r) {
            var j = await r.json().catch(function () {
              return {};
            });
            if (!r.ok) throw new Error(j.message || 'Không xóa được file');
            return api('/documents/' + docId);
          })
          .then(function (refreshed) {
            renderExistingAttachments((refreshed.document && refreshed.document.attachments) || [], docId);
          })
          .catch(function (e) {
            alert(e.message || String(e));
            btn.disabled = false;
          });
      });
    });
  }

  async function submitManual(ev) {
    if (state.readOnly) return;
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
            template_id: el('f-template').value ? Number(el('f-template').value) : null,
            issuing_unit: el('f-dv').value,
            external_scan_link: el('f-scan').value,
            external_word_link: el('f-word').value,
            physical_location: el('f-phys-loc').value,
            physical_copy_type: el('f-phys-copy').value || null,
            physical_sheet_count: el('f-phys-sheets').value,
            physical_page_count: el('f-phys-pages').value,
            retention_until: el('f-retention').value,
            destruction_eligible_date: el('f-destruction').value,
            parent_case_ref: el('f-parent-case').value,
            tag_ids: JSON.stringify(tagIds),
          }),
        });
        var allFiles = [];
        var mainFile = el('f-file').files && el('f-file').files[0] ? el('f-file').files[0] : null;
        if (mainFile) allFiles.push(mainFile);
        allFiles = allFiles.concat(collectExtraFiles());
        if (allFiles.length) {
          var afd = new FormData();
          allFiles.forEach(function (f) {
            afd.append('files', f);
          });
          await fetch(apiBase + '/api/dms/documents/' + editId + '/attachments', {
            method: 'POST',
            headers: { Accept: 'application/json', Authorization: 'Bearer ' + getToken() },
            body: afd,
          }).then(async function (r) {
            if (!r.ok) {
              var j = await r.json().catch(function () {
                return {};
              });
              throw new Error(j.message || 'Không tải được file đính kèm');
            }
          });
        }
        alert('Đã lưu cập nhật tài liệu. Bạn có thể tiếp tục thao tác ngay tại trang này.');
        if (el('f-file')) el('f-file').value = '';
        if (el('f-extra-files')) el('f-extra-files').innerHTML = '';
        var refreshed = await api('/documents/' + editId);
        renderExistingAttachments((refreshed.document && refreshed.document.attachments) || [], editId);
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
      fd.append('physical_location', el('f-phys-loc').value);
      fd.append('physical_copy_type', el('f-phys-copy').value);
      fd.append('physical_sheet_count', el('f-phys-sheets').value);
      fd.append('physical_page_count', el('f-phys-pages').value);
      fd.append('retention_until', el('f-retention').value);
      fd.append('destruction_eligible_date', el('f-destruction').value);
      fd.append('parent_case_ref', el('f-parent-case').value);
      if (el('f-cat').value) fd.append('category_id', el('f-cat').value);
      if (el('f-type').value) fd.append('document_type_id', el('f-type').value);
      if (el('f-template').value) fd.append('template_id', el('f-template').value);
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
      resetManualFormForNextEntry();
      alert('Đã lưu tài liệu. Biểu mẫu đã được làm mới để bạn tiếp tục nhập.');
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
    var templates = await api('/templates');
    state.templates = templates.templates || [];
    var tags = await api('/tags');
    state.tags = tags.tags || [];

    fillCategorySelect();
    fillTypeSelect();
    fillTemplateSelect();
    fillImportSelects();
    fillTagChecks();
    ensureMultiFileUi();

    var idParam = qs('id');
    var mode = String(qs('mode') || '').toLowerCase();
    state.readOnly = mode === 'view' || mode === 'readonly';
    if (idParam) {
      state.editId = Number(idParam);
      if (Number.isFinite(state.editId)) {
        var doc = await api('/documents/' + state.editId);
        var d = doc.document;
        renderQuickDownloadLinks(d);
        el('page-title').textContent = 'Sửa tài liệu';
        el('f-title').value = d.title || '';
        el('f-ref').value = d.ref_number || '';
        el('f-status').value = d.status || 'draft';
        el('f-issue').value = d.issue_date ? String(d.issue_date).slice(0, 10) : '';
        el('f-valid').value = d.valid_until ? String(d.valid_until).slice(0, 10) : '';
        syncVnDateHint('f-issue', 'f-issue-hint');
        syncVnDateHint('f-valid', 'f-valid-hint');
        el('f-notes').value = d.notes || '';
        el('f-dv').value = d.issuing_unit || '';
        el('f-scan').value = d.external_scan_link || '';
        el('f-word').value = d.external_word_link || '';
        el('f-cat').value = d.category_id || '';
        el('f-type').value = d.document_type_id || '';
        fillTemplateSelect(d.template_id);
        el('f-template').value = d.template_id ? String(d.template_id) : '';
        el('f-phys-loc').value = d.physical_location || '';
        el('f-phys-copy').value = d.physical_copy_type || '';
        el('f-parent-case').value = d.parent_case_ref || '';
        el('f-phys-sheets').value =
          d.physical_sheet_count != null && d.physical_sheet_count !== '' ? String(d.physical_sheet_count) : '';
        el('f-phys-pages').value =
          d.physical_page_count != null && d.physical_page_count !== '' ? String(d.physical_page_count) : '';
        el('f-retention').value = d.retention_until ? String(d.retention_until).slice(0, 10) : '';
        el('f-destruction').value = d.destruction_eligible_date
          ? String(d.destruction_eligible_date).slice(0, 10)
          : '';
        fillTagChecks(d.tags || []);
        renderExistingAttachments(d.attachments || [], state.editId);
        el('f-file').removeAttribute('required');
        el('f-file-help').textContent =
          d.file_path === '__no_file__'
            ? 'Hiện chưa có PDF trên máy chủ — chọn file để đính kèm (cần API bổ sung) hoặc giữ link scan.'
            : 'Để giữ file hiện tại, không chọn file mới.';
        showTab('manual');
        document.querySelectorAll('[data-add-tab-btn="import"]').forEach(function (b) {
          b.style.display = 'none';
        });
        if (state.readOnly) setFormReadOnly();
      }
    }

    el('tab-manual').addEventListener('click', function () {
      showTab('manual');
    });
    el('tab-import').addEventListener('click', function () {
      showTab('import');
    });
    el('form-manual').addEventListener('submit', submitManual);
    var addFileBtn = el('f-add-file');
    if (addFileBtn) {
      addFileBtn.addEventListener('click', function () {
        addExtraFileInput();
      });
    }
    var uploadFilesBtn = el('f-upload-files');
    if (uploadFilesBtn) {
      uploadFilesBtn.addEventListener('click', function () {
        uploadExtraFilesOnly().catch(function (e) {
          alert(e.message || String(e));
        });
      });
    }
    el('f-issue').addEventListener('change', function () {
      syncVnDateHint('f-issue', 'f-issue-hint');
    });
    el('f-issue').addEventListener('input', function () {
      syncVnDateHint('f-issue', 'f-issue-hint');
    });
    el('f-valid').addEventListener('change', function () {
      syncVnDateHint('f-valid', 'f-valid-hint');
    });
    el('f-valid').addEventListener('input', function () {
      syncVnDateHint('f-valid', 'f-valid-hint');
    });
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
