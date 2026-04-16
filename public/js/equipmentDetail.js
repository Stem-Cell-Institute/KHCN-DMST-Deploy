(function () {
  var params = new URLSearchParams(location.search);
  var id = params.get('id');
  var canManage = false;
  var canUpload = false;
  var canSeeAdvancedTabs = false;
  var meId = null;
  var eqRow = null;
  var incidentListCache = [];

  var DOC_LABEL = {
    sop: 'SOP',
    technical: 'Kỹ thuật',
    safety: 'An toàn',
    warranty: 'Bảo hành',
    calibration: 'Kiểm định',
  };

  function show(t, err) {
    var el = document.getElementById('msg');
    el.innerHTML = t ? '<div class="eq-msg ' + (err ? 'eq-msg--err' : 'eq-msg--ok') + '">' + t + '</div>' : '';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function fmtMoney(v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    if (!Number.isFinite(n)) return esc(v);
    return n.toLocaleString('vi-VN') + ' VNĐ';
  }

  function statusLabel(st) {
    var m = {
      active: 'Hoạt động',
      maintenance: 'Bảo trì',
      broken: 'Hỏng',
      retired: 'Thanh lý',
    };
    return m[st] || st || '—';
  }

  function utilizationLabel(v) {
    var map = {
      '0': '0 - Chưa ghi sổ kế toán',
      '1': '1 - Đã ghi sổ kế toán',
      '2': '2 - Không phải ghi sổ kế toán',
      '3': '3 - Không có nhu cầu sử dụng',
    };
    var s = v == null ? '' : String(v).trim();
    var m = s.match(/^([0-3])(?:\s*[:\-].*)?$/);
    var k = m ? m[1] : s;
    return map[k] || (s || '—');
  }

  function conditionLabel(v) {
    var map = {
      '0': '0 - Còn sử dụng được, đang sử dụng đúng mục đích',
      '1': '1 - Còn sử dụng được, đang sử dụng không đúng mục đích',
      '2': '2 - Còn sử dụng được, không có nhu cầu sử dụng',
      '3': '3 - Hỏng, không sử dụng được',
    };
    var s = v == null ? '' : String(v).trim();
    var m = s.match(/^([0-3])(?:\s*[:\-].*)?$/);
    var k = m ? m[1] : s;
    return map[k] || (s || '—');
  }

  /** Bỏ qua metadata luồng duyệt hồ sơ cũ nếu còn sót trong specs_json. */
  function isLegacyApprovalSpecKey(k) {
    if (k == null || typeof k !== 'string') return false;
    var n = k.trim().toLowerCase();
    return n === 'trạng thái duyệt' || n === 'lý do trả về';
  }

  function renderInfo(eq) {
    var host = document.getElementById('info-pre');
    if (!host || !eq) return;
    var rows = [
      ['Mã thiết bị', eq.equipment_code],
      ['Tên thiết bị', eq.name],
      ['Model', eq.model],
      ['Serial', eq.serial_number],
      ['Nhà sản xuất', eq.manufacturer],
      ['Năm mua', eq.purchase_year],
      ['Giá trị mua', fmtMoney(eq.purchase_value)],
      ['Loại tài sản', eq.asset_group || '—'],
      ['Mã loại tài sản', eq.asset_type_code || '—'],
      ['Năm đưa vào sử dụng', eq.year_in_use || '—'],
      ['Đơn vị tính', eq.unit_name || '—'],
      ['Theo sổ kế toán', eq.quantity_book != null ? eq.quantity_book : '—'],
      ['Theo thực tế kiểm kê', eq.quantity_actual != null ? eq.quantity_actual : '—'],
      ['Chênh lệch', eq.quantity_diff != null ? eq.quantity_diff : '—'],
      ['GTCL', eq.remaining_value != null ? fmtMoney(eq.remaining_value) : '—'],
      ['Tình hình khai thác sử dụng', utilizationLabel(eq.utilization_note)],
      ['Tình trạng của tài sản', conditionLabel(eq.condition_note)],
      ['Ảnh hưởng bởi thiên tai 2023-2025', eq.disaster_impact_note || '—'],
      ['Tài sản công trình xây dựng', eq.construction_asset_note || '—'],
      ['Số lần (nếu có)', eq.usage_count_note || '—'],
      ['Tài sản gắn liền với đất', eq.land_attached_note || '—'],
      ['Ghi chú tài sản', eq.asset_note || '—'],
      ['Phòng/Lab', eq.department_id],
      ['Cán bộ phụ trách', eq.manager_id],
      ['Vị trí', eq.location],
      ['Trạng thái', statusLabel(eq.status)],
      ['Hiển thị hồ sơ', eq.profile_visibility],
      ['Ngày tạo', eq.created_at],
      ['Ngày cập nhật', eq.updated_at],
      ['Ngày xuất bản', eq.published_at || '—'],
      ['Lần bảo trì gần nhất', eq.last_maintenance_date || '—'],
      ['Hạn bảo trì tiếp theo', eq.next_maintenance_date || '—'],
      ['Hạn kiểm định', eq.calibration_due_date || '—'],
    ];
    var specs = '—';
    try {
      var s = eq.specs_json ? JSON.parse(eq.specs_json) : null;
      if (s && typeof s === 'object' && !Array.isArray(s)) {
        var parts = [];
        Object.keys(s).forEach(function (k) {
          if (isLegacyApprovalSpecKey(k)) return;
          parts.push(esc(k) + ': ' + esc(s[k]));
        });
        if (parts.length) specs = parts.join('<br/>');
      }
    } catch (e) {}
    rows.push(['Thông số kỹ thuật', specs]);

    var html =
      '<table class="eq-table"><tbody>' +
      rows
        .map(function (r) {
          return '<tr><th style="width:230px;">' + esc(r[0]) + '</th><td>' + (r[1] == null || r[1] === '' ? '—' : r[1]) + '</td></tr>';
        })
        .join('') +
      '</tbody></table>';
    host.innerHTML = html;
  }

  function renderInfoMediaSummary(payload) {
    var panel = document.getElementById('panel-info');
    if (!panel) return;
    var box = document.getElementById('info-media-summary');
    if (!box) {
      box = document.createElement('div');
      box.id = 'info-media-summary';
      box.style.marginTop = '16px';
      panel.appendChild(box);
    }
    var docs = (payload && payload.documents) || [];
    var videos = (payload && payload.videos) || [];

    function buildDocLines() {
      if (!docs.length) return '<p style="margin:0;color:var(--eq-muted);">Chưa có tài liệu PDF công khai.</p>';
      var lines = docs.slice(0, 5).map(function (d) {
        var href = '/api/equipment/' + id + '/documents/' + d.id + '/download' + window.equipmentApi.qsToken();
        return (
          '<li style="margin:4px 0;">' +
          '<a class="eq-link" target="_blank" href="' +
          esc(href) +
          '">' +
          esc(d.title || ('Tài liệu #' + d.id)) +
          '</a>' +
          '</li>'
        );
      });
      var more = docs.length > 5 ? '<li style="margin:4px 0;color:var(--eq-muted);">… và ' + (docs.length - 5) + ' tài liệu khác</li>' : '';
      return '<ul style="margin:8px 0 0 18px;padding:0;">' + lines.join('') + more + '</ul>';
    }

    function buildVideoLines() {
      if (!videos.length) return '<p style="margin:0;color:var(--eq-muted);">Chưa có video công khai.</p>';
      var lines = videos.slice(0, 5).map(function (v) {
        return (
          '<li style="margin:4px 0;">' +
          '<a class="eq-link" target="_blank" rel="noopener" href="' +
          esc(v.video_url || '#') +
          '">' +
          esc(v.title || ('Video #' + v.id)) +
          '</a>' +
          '</li>'
        );
      });
      var more = videos.length > 5 ? '<li style="margin:4px 0;color:var(--eq-muted);">… và ' + (videos.length - 5) + ' video khác</li>' : '';
      return '<ul style="margin:8px 0 0 18px;padding:0;">' + lines.join('') + more + '</ul>';
    }

    box.innerHTML =
      '<div class="eq-form" style="max-width:none;margin-bottom:12px;">' +
      '<h3 style="margin:0 0 10px;font-size:1.05rem;color:#2f3fb0;">Tài liệu PDF</h3>' +
      buildDocLines() +
      '</div>' +
      '<div class="eq-form" style="max-width:none;">' +
      '<h3 style="margin:0 0 10px;font-size:1.05rem;color:#2f3fb0;">Video</h3>' +
      buildVideoLines() +
      '</div>';
  }

  if (!id) {
    if (document.getElementById('msg')) show('Thiếu tham số id', true);
    return;
  }

  try {
    var u = JSON.parse(localStorage.getItem('user') || '{}');
    meId = u.id;
    var role = (u.role || '').toLowerCase();
    canManage = role === 'admin' || role === 'manager' || role === 'phong_khcn';
  } catch (e) {}

  var navEdit = document.getElementById('nav-edit');
  var navDash = document.getElementById('nav-dash');

  document.getElementById('link-public').href = '/public/equipment/public.html?id=' + id;
  document.getElementById('qr-thumb').src = '/api/equipment/' + id + '/qr';
  document.getElementById('qr-thumb').style.display = 'inline-block';

  var panels = ['info', 'docs', 'videos', 'logs', 'maint', 'incident'];
  var restrictedViewerTabs = ['docs', 'videos', 'maint', 'incident', 'logs'];

  function activateTab(tabName) {
    if (!tabName) return;
    var btn = document.querySelector('.eq-tab[data-tab="' + tabName + '"]');
    if (btn) btn.click();
  }

  function applyModuleTabVisibility() {
    restrictedViewerTabs.forEach(function (tabName) {
      var btn = document.querySelector('.eq-tab[data-tab="' + tabName + '"]');
      var panel = document.getElementById('panel-' + tabName);
      if (!btn) return;
      var hide = !canSeeAdvancedTabs;
      btn.style.display = hide ? 'none' : '';
      if (panel && hide) panel.hidden = true;
    });
    if (!canSeeAdvancedTabs) {
      activateTab('info');
    }
  }

  function syncModuleRole() {
    if (!window.equipmentApi || !window.equipmentApi.getJson) return Promise.resolve();
    return window.equipmentApi
      .getJson('/module/me')
      .then(function (r) {
        if (!r.ok || !r.data || !r.data.data) {
          canSeeAdvancedTabs = false;
          return;
        }
        var data = r.data.data || {};
        var role = String((data.assignment && data.assignment.module_role) || 'viewer').toLowerCase();
        canSeeAdvancedTabs = !!data.isMasterAdmin || role === 'manager' || role === 'editor' || role === 'admin';
      })
      .catch(function () {
        canSeeAdvancedTabs = false;
      })
      .finally(function () {
        applyModuleTabVisibility();
      });
  }

  document.querySelectorAll('.eq-tab').forEach(function (btn) {
    btn.onclick = function () {
      document.querySelectorAll('.eq-tab').forEach(function (b) {
        b.classList.remove('eq-tab--on');
      });
      btn.classList.add('eq-tab--on');
      panels.forEach(function (p) {
        var el = document.getElementById('panel-' + p);
        if (el) el.hidden = btn.dataset.tab !== p;
      });
    };
  });
  var tabQ = params.get('tab');
  if (tabQ) {
    var openTab = document.querySelector('.eq-tab[data-tab="' + tabQ + '"]');
    if (openTab) openTab.click();
  }

  function renderDocsGrouped(r) {
    var host = document.getElementById('docs-groups');
    if (!host) return;
    host.innerHTML = '';
    var docsAll = r.documentsAll || r.documents || [];
    var types = ['sop', 'technical', 'safety', 'warranty', 'calibration'];
    types.forEach(function (dt) {
      var subset = docsAll.filter(function (d) {
        return d.doc_type === dt;
      });
      if (!subset.length) return;
      var cur = subset.filter(function (d) {
        return d.is_current == null || Number(d.is_current) === 1;
      });
      var hist = subset.filter(function (d) {
        return Number(d.is_current) === 0;
      });
      var wrap = document.createElement('div');
      wrap.className = 'eq-doc-group';
      wrap.innerHTML =
        '<div class="eq-doc-group__head">' +
        esc(DOC_LABEL[dt] || dt) +
        ' <span class="eq-count-badge">' +
        subset.length +
        '</span></div>';
      var inner = document.createElement('div');
      inner.className = 'eq-table-wrap';
      var tb = document.createElement('table');
      tb.className = 'eq-table';
      tb.innerHTML =
        '<thead><tr><th>Tiêu đề</th><th>Phiên bản</th><th>Quyền</th><th>Ngày</th><th>Người tải</th><th>Xem/Tải</th><th class="th-doc-manage">Thao tác</th></tr></thead><tbody></tbody>';
      var tbody = tb.querySelector('tbody');
      cur.concat(hist).forEach(function (d) {
        var tr = document.createElement('tr');
        var dis = d.is_disabled ? ' <span class="eq-badge eq-badge--retired">Đã vô hiệu</span>' : '';
        var curB =
          d.is_current == null || Number(d.is_current) === 1
            ? ''
            : ' <span class="eq-badge eq-badge--maintenance">Phiên bản cũ</span>';
        var href =
          '/api/equipment/' +
          id +
          '/documents/' +
          d.id +
          '/download' +
          window.equipmentApi.qsToken();
        var actions = '';
        if (canManage) {
          actions +=
            '<button type="button" class="eq-btn eq-btn--ghost eq-btn-sm" data-disable-doc="' +
            d.id +
            '">Vô hiệu</button> ';
          if (!d.is_disabled && (d.is_current == null || Number(d.is_current) === 1)) {
            actions +=
              '<button type="button" class="eq-btn eq-btn--ghost eq-btn-sm" data-replace-doc="' +
              d.id +
              '">Thay thế</button>';
          }
        }
        tr.innerHTML =
          '<td>' +
          esc(d.title) +
          dis +
          curB +
          '</td><td>' +
          esc(d.version || '—') +
          '</td><td>' +
          esc(d.access_level) +
          '</td><td>' +
          esc(d.created_at || '') +
          '</td><td>' +
          esc(d.uploaded_by_name || '') +
          '</td><td><a class="eq-link" target="_blank" href="' +
          esc(href) +
          '">Xem PDF</a></td><td class="td-doc-manage">' +
          actions +
          '</td>';
        tbody.appendChild(tr);
      });
      inner.appendChild(tb);
      wrap.appendChild(inner);
      host.appendChild(wrap);
    });

    if (!canManage) {
      host.querySelectorAll('.th-doc-manage, .td-doc-manage').forEach(function (el) {
        el.style.display = 'none';
      });
    }

    host.querySelectorAll('[data-disable-doc]').forEach(function (b) {
      b.onclick = function () {
        var reason = window.prompt('Xác nhận vô hiệu hóa. Nhập lý do (tuỳ chọn):');
        if (reason === null) return;
        window.equipmentApi
          .sendJson('PATCH', '/' + id + '/documents/' + b.getAttribute('data-disable-doc') + '/disable', {
            note: reason || null,
          })
          .then(function (x) {
            if (!x.ok) {
              if (window.stimsToast) window.stimsToast(x.data && x.data.message ? x.data.message : 'Lỗi', false);
              else show((x.data && x.data.message) || 'Lỗi', true);
            } else {
              if (window.stimsToast) window.stimsToast('Đã vô hiệu hóa tài liệu', true);
              load();
            }
          });
      };
    });

    host.querySelectorAll('[data-replace-doc]').forEach(function (b) {
      b.onclick = function () {
        var docId = b.getAttribute('data-replace-doc');
        var inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'application/pdf';
        inp.onchange = function () {
          var f = inp.files[0];
          if (!f) return;
          if (f.size > 20 * 1024 * 1024) {
            if (window.stimsToast) window.stimsToast('File vượt quá 20MB', false);
            return;
          }
          var fd = new FormData();
          fd.append('file', f);
          fd.append('title', f.name.replace(/\.pdf$/i, ''));
          var t = localStorage.getItem('token');
          fetch('/api/equipment/' + id + '/documents/' + docId + '/replace', {
            method: 'POST',
            headers: t ? { Authorization: 'Bearer ' + t } : {},
            body: fd,
            credentials: 'same-origin',
          })
            .then(function (x) {
              return x.json().then(function (j) {
                return { ok: x.ok, data: j };
              });
            })
            .then(function (r) {
              if (!r.ok) {
                if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi thay thế', false);
              } else {
                if (window.stimsToast) window.stimsToast('Đã thay thế phiên bản PDF', true);
                load();
              }
            });
        };
        inp.click();
      };
    });
  }

  function renderVideos(r) {
    var tv = document.getElementById('tbody-videos');
    if (!tv) return;
    tv.innerHTML = '';
    (r.videos || []).forEach(function (v) {
      var tr = document.createElement('tr');
      var thumb = v.thumbnail_url
        ? '<img src="' + esc(v.thumbnail_url) + '" alt="" style="width:96px;height:54px;object-fit:cover;border-radius:8px;vertical-align:middle;margin-right:8px;" />'
        : v.platform === 'drive'
          ? '<span style="font-size:1.6rem">📁</span> '
          : '';
      tr.innerHTML =
        '<td>' +
        thumb +
        esc(v.title) +
        '</td><td><span class="eq-badge eq-badge--active">' +
        esc(v.platform) +
        '</span></td><td><a class="eq-link" target="_blank" rel="noopener" href="' +
        esc(v.video_url) +
        '">Mở</a></td><td class="td-vid-del">' +
        (canManage
          ? '<button type="button" class="eq-btn eq-btn--danger" data-del-vid="' +
            v.id +
            '">Xóa</button>'
          : '') +
        '</td>';
      tv.appendChild(tr);
    });
    if (!canManage) {
      tv.querySelectorAll('.td-vid-del').forEach(function (el) {
        el.style.display = 'none';
      });
    }
    tv.querySelectorAll('[data-del-vid]').forEach(function (b) {
      b.onclick = function () {
        if (!confirm('Xóa video này?')) return;
        fetch('/api/equipment/' + id + '/videos/' + b.getAttribute('data-del-vid'), {
          method: 'DELETE',
          headers: window.equipmentApi.authHeaders(false),
          credentials: 'same-origin',
        })
          .then(function (x) {
            return x.json().then(function (j) {
              return { ok: x.ok, data: j };
            });
          })
          .then(function (x) {
            if (!x.ok) {
              if (window.stimsToast) window.stimsToast((x.data && x.data.message) || 'Lỗi', false);
            } else {
              if (window.stimsToast) window.stimsToast('Đã xóa video', true);
              load();
            }
          });
      };
    });
  }

  function renderMaint(list) {
    var tb = document.getElementById('tbody-maint');
    if (!tb) return;
    tb.innerHTML = '';
    (list || []).forEach(function (m) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td><strong>' +
        esc(m.id) +
        '</strong></td><td>' +
        esc(m.completed_date || m.scheduled_date || '') +
        '</td><td>' +
        esc(m.maintenance_type) +
        '</td><td>' +
        esc(m.performed_by_name || '') +
        '</td><td>' +
        esc(m.cost != null ? m.cost : '') +
        '</td><td>' +
        esc(m.result_note || '') +
        '</td><td>' +
        esc(m.next_due_date || '') +
        '</td>';
      tb.appendChild(tr);
    });
  }

  function renderIncidents(list) {
    var host = document.getElementById('incident-timeline');
    if (!host) return;
    incidentListCache = Array.isArray(list) ? list.slice() : [];
    host.innerHTML = '';
    function toTs(v) {
      var t = Date.parse(String(v || '').replace(' ', 'T'));
      return Number.isFinite(t) ? t : 0;
    }
    function fileKindFromPath(p) {
      var b = String(p || '')
        .split('/')
        .pop()
        .toUpperCase();
      if (b.indexOf('__INV__') >= 0) return 'invoice';
      if (b.indexOf('__PROP__') >= 0) return 'proposal';
      return 'resolution';
    }
    function stripKindPrefix(name) {
      return String(name || '')
        .replace(/^INV__+/i, '')
        .replace(/^PROP__+/i, '')
        .replace(/^RES__+/i, '');
    }
    function buildResolveFilesHtml(i, resolveFiles) {
      if (!resolveFiles.length) return '';
      var groups = { invoice: [], proposal: [], resolution: [] };
      resolveFiles.forEach(function (p, idx) {
        groups[fileKindFromPath(p)].push({ idx: idx, path: p });
      });
      function buildGroup(label, arr) {
        if (!arr || !arr.length) return '';
        var h =
          '<div style="margin-top:6px;">' +
          '<strong>' +
          label +
          ':</strong>' +
          '<ul style="margin:6px 0 0 18px;padding:0;line-height:1.5;">';
        arr.forEach(function (x) {
          var u2 = '/api/equipment/' + id + '/incidents/' + i.id + '/attachment/resolve/' + x.idx;
          var fileName = stripKindPrefix(String(x.path || '').split('/').pop() || ('#' + (x.idx + 1)));
          h +=
            '<li style="margin:2px 0;word-break:break-all;">' +
            '<a class="eq-link" target="_blank" href="' +
            esc(u2) +
            '">' +
            esc(fileName) +
            '</a>' +
            '</li>';
        });
        h += '</ul></div>';
        return h;
      }
      var html = '<div style="margin-top:6px;"><strong>Hồ sơ xử lý đính kèm:</strong></div>';
      html += buildGroup('Hóa đơn / chứng từ', groups.invoice);
      html += buildGroup('Tờ trình / đề xuất', groups.proposal);
      html += buildGroup('Tài liệu xử lý khác', groups.resolution);
      return html;
    }

    var events = [];
    (list || []).forEach(function (i) {
      var reportPhotos = [];
      try {
        reportPhotos = i.photo_paths ? JSON.parse(i.photo_paths) : [];
      } catch (e1) {
        reportPhotos = [];
      }
      if (!Array.isArray(reportPhotos)) reportPhotos = [];

      var resolveFiles = [];
      try {
        resolveFiles = i.resolution_attachment_paths ? JSON.parse(i.resolution_attachment_paths) : [];
      } catch (e2) {
        resolveFiles = [];
      }
      if (!Array.isArray(resolveFiles)) resolveFiles = [];

      var reportedHtml = '';
      if (reportPhotos.length) {
        reportedHtml = '<div style="margin-top:8px;font-size:0.85rem;"><strong>Ảnh báo cáo:</strong> ';
        reportPhotos.forEach(function (_, idx) {
          var u = '/api/equipment/' + id + '/incidents/' + i.id + '/attachment/report/' + idx;
          reportedHtml += '<a class="eq-link" target="_blank" href="' + esc(u) + '">#' + (idx + 1) + '</a> ';
        });
        reportedHtml += '</div>';
      }

      events.push({
        incidentId: i.id,
        kind: 'reported',
        ts: toTs(i.report_date),
        timeText: i.report_date || '',
        actor: i.reported_by_name || '',
        severity: i.severity || '',
        description: i.description || '',
        extraHtml: reportedHtml,
      });

      var st = String(i.status || '')
        .trim()
        .toLowerCase();
      var hasResolvedEvent = st === 'resolved' || st === 'closed' || !!i.resolution_note || !!i.resolved_at;
      if (hasResolvedEvent) {
        var resolvedMeta =
          '<div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--eq-border);font-size:0.88rem;">' +
          '<strong>Kết quả xử lý</strong><div style="margin-top:4px;">' +
          esc(i.resolution_note || '') +
          '</div>';
        if (i.cost != null && i.cost !== '') resolvedMeta += '<div>Chi phí: ' + esc(String(i.cost)) + '</div>';
        if (i.repair_type) resolvedMeta += '<div>Loại sửa: ' + esc(i.repair_type) + '</div>';
        if (i.vendor_note) resolvedMeta += '<div>Nhà thầu / công ty: ' + esc(i.vendor_note) + '</div>';
        if (i.invoice_ref) resolvedMeta += '<div>Hóa đơn / chứng từ: ' + esc(i.invoice_ref) + '</div>';
        if (i.proposal_ref) resolvedMeta += '<div>Tờ trình: ' + esc(i.proposal_ref) + '</div>';
        resolvedMeta += buildResolveFilesHtml(i, resolveFiles);
        if (i.resolved_at) resolvedMeta += '<div style="color:var(--eq-muted);margin-top:4px;">Đóng: ' + esc(i.resolved_at) + '</div>';
        resolvedMeta += '</div>';

        events.push({
          incidentId: i.id,
          kind: 'resolved',
          ts: toTs(i.resolved_at || i.report_date),
          timeText: i.resolved_at || i.report_date || '',
          actor: i.assigned_to_name || i.reported_by_name || '',
          severity: i.severity || '',
          description: '',
          extraHtml: resolvedMeta,
        });
      }
    });

    events.sort(function (a, b) {
      if (a.ts !== b.ts) return a.ts - b.ts;
      if (a.incidentId !== b.incidentId) return Number(a.incidentId || 0) - Number(b.incidentId || 0);
      if (a.kind === b.kind) return 0;
      return a.kind === 'reported' ? -1 : 1;
    });

    events.forEach(function (ev) {
      var div = document.createElement('div');
      div.className = 'eq-timeline__item' + (ev.kind === 'resolved' ? ' eq-timeline__item--resolved' : '');
      div.setAttribute('data-incident-id', String(ev.incidentId || ''));
      div.innerHTML =
        '<strong>' +
        esc(ev.kind) +
        '</strong> #' +
        esc(ev.incidentId) +
        ' · ' +
        esc(ev.severity) +
        '<div style="font-size:0.85rem;color:var(--eq-muted);margin-top:4px;">' +
        esc(ev.timeText || '') +
        ' — ' +
        esc(ev.actor || '') +
        '</div>' +
        (ev.description ? '<div style="margin-top:6px;">' + esc(ev.description) + '</div>' : '') +
        (ev.extraHtml || '');
      div.onclick = function () {
        var inp = document.getElementById('inc-resolve-id');
        if (inp && ev.incidentId != null) inp.value = String(ev.incidentId);
      };
      host.appendChild(div);
    });

    var inpId = document.getElementById('inc-resolve-id');
    if (inpId && !String(inpId.value || '').trim()) {
      var firstOpen = (list || []).find(function (x) {
        var stx = String((x && x.status) || '')
          .trim()
          .toLowerCase();
        return stx !== 'resolved' && stx !== 'closed';
      });
      if (firstOpen && firstOpen.id != null) inpId.value = String(firstOpen.id);
    }
  }

  function updateIncidentTabAlert(list) {
    var tab = document.querySelector('.eq-tab[data-tab="incident"]');
    if (!tab) return;
    var arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      tab.classList.remove('eq-tab--incident-alert');
      tab.removeAttribute('title');
      return;
    }
    var latest = arr[0];
    for (var i = 1; i < arr.length; i++) {
      var a = Number(arr[i] && arr[i].id);
      var b = Number(latest && latest.id);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        if (a > b) latest = arr[i];
      }
    }
    var st = String((latest && latest.status) || '')
      .trim()
      .toLowerCase();
    var hasOpen = st !== 'resolved' && st !== 'closed';
    tab.classList.toggle('eq-tab--incident-alert', hasOpen);
    if (hasOpen) {
      tab.setAttribute('title', 'Sự cố mới nhất #' + String((latest && latest.id) || '') + ' chưa xử lý');
    } else {
      tab.removeAttribute('title');
    }
  }

  function load() {
    window.equipmentApi.getJson('/' + id).then(function (r) {
      if (r.status === 401) {
        window.location.href = '/dang-nhap.html?returnUrl=' + encodeURIComponent(location.pathname + location.search);
        return;
      }
      if (!r.ok) {
        show((r.data && r.data.message) || 'Không tải được', true);
        return;
      }
      eqRow = r.data.equipment;
      canManage = !!r.data.canManage;
      canUpload = !!r.data.canUploadDocuments;
      if (navDash) navDash.style.display = canManage ? 'flex' : 'none';

      document.getElementById('h-name').textContent = eqRow.name + ' (' + eqRow.equipment_code + ')';
      renderInfo(eqRow);
      renderInfoMediaSummary(r.data);
      document.getElementById('st-new').value = eqRow.status || 'active';

      if (navEdit) {
        var canEditProfile = canManage || (meId != null && Number(eqRow.created_by) === Number(meId));
        navEdit.style.display = canEditProfile ? 'flex' : 'none';
        if (canEditProfile) navEdit.href = '/public/equipment/form.html?id=' + id;
      }

      var upPdf = document.getElementById('up-pdf');
      var fv = document.getElementById('form-vid');
      if (upPdf) upPdf.style.display = canUpload ? 'block' : 'none';
      if (fv) fv.style.display = canUpload ? 'block' : 'none';
      document.getElementById('manage-bar').style.display = canManage && canSeeAdvancedTabs ? 'flex' : 'none';

      renderDocsGrouped(r.data);
      renderVideos(r.data);

      var ts = document.getElementById('tbody-slog');
      ts.innerHTML = '';
      (r.data.statusLogs || []).forEach(function (l) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' +
          esc(l.changed_at) +
          '</td><td>' +
          esc(l.old_status) +
          ' → ' +
          esc(l.new_status) +
          '</td><td>' +
          esc(l.changed_by_name) +
          '</td><td>' +
          esc(l.note) +
          '</td>';
        ts.appendChild(tr);
      });

      var td = document.getElementById('tbody-dlog');
      td.innerHTML = '';
      (r.data.documentLogs || []).forEach(function (l) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' +
          esc(l.performed_at) +
          '</td><td>' +
          esc(l.action) +
          ' #' +
          esc(l.document_id) +
          '</td><td>' +
          esc(l.performed_by_name) +
          '</td><td>' +
          esc(l.note) +
          '</td>';
        td.appendChild(tr);
      });

      renderMaint(r.data.maintenance);
      renderIncidents(r.data.incidents);
      updateIncidentTabAlert(r.data.incidents);

      var mm = document.getElementById('maint-manage');
      if (mm) mm.style.display = canManage && canSeeAdvancedTabs ? 'block' : 'none';
      var ia = document.getElementById('incident-admin');
      if (ia) ia.style.display = canManage && canSeeAdvancedTabs ? 'block' : 'none';

    });
  }

  var bs = document.getElementById('btn-status');
  if (bs) bs.onclick = function () {
    var st = document.getElementById('st-new').value;
    var note = document.getElementById('st-note').value;
    window.equipmentApi.sendJson('PATCH', '/' + id + '/status', { status: st, note: note }).then(function (r) {
      if (!r.ok) {
        if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi', false);
      } else {
        if (window.stimsToast) window.stimsToast('Đã cập nhật trạng thái', true);
        load();
      }
    });
  };

  var bsd = document.getElementById('btn-softdel');
  if (bsd) bsd.onclick = function () {
    if (!confirm('Đánh dấu thanh lý (retired)?')) return;
    fetch('/api/equipment/' + id, {
      method: 'DELETE',
      headers: window.equipmentApi.authHeaders(true),
      credentials: 'same-origin',
    })
      .then(function (x) {
        return x.json().then(function (j) {
          return { ok: x.ok, data: j };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi', false);
        } else window.location.href = '/public/equipment/index.html';
      });
  };

  var pdfInp = document.querySelector('#up-pdf input[name="file"]');
  if (pdfInp) {
    pdfInp.onchange = function () {
      var f = pdfInp.files[0];
      if (!f) return;
      if (f.type !== 'application/pdf') {
        if (window.stimsToast) window.stimsToast('Chỉ chấp nhận file PDF', false);
        pdfInp.value = '';
        return;
      }
      if (f.size > 20 * 1024 * 1024) {
        if (window.stimsToast) window.stimsToast('PDF tối đa 20MB', false);
        pdfInp.value = '';
      }
    };
  }

  var upEl = document.getElementById('up-pdf');
  if (upEl) upEl.onsubmit = function (ev) {
    ev.preventDefault();
    if (!canUpload) return;
    var f = ev.target;
    var fd = new FormData();
    fd.append('file', f.file.files[0]);
    fd.append('doc_type', f.doc_type.value);
    fd.append('title', f.title.value);
    fd.append('version', f.version.value);
    fd.append('access_level', f.access_level.value);
    fd.append('notes', f.notes.value);
    var t = localStorage.getItem('token');
    fetch('/api/equipment/' + id + '/documents', {
      method: 'POST',
      headers: t ? { Authorization: 'Bearer ' + t } : {},
      body: fd,
      credentials: 'same-origin',
    })
      .then(function (x) {
        return x.json().then(function (j) {
          return { ok: x.ok, data: j };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Upload lỗi', false);
        } else {
          if (window.stimsToast) window.stimsToast('Đã tải lên PDF', true);
          f.reset();
          load();
        }
      });
  };

  var vidUrl = document.querySelector('#form-vid input[name="video_url"]');
  var vidPrev = document.getElementById('vid-thumb-preview');
  if (vidUrl && vidPrev) {
    vidUrl.onblur = function () {
      var u = vidUrl.value.trim();
      vidPrev.innerHTML = '';
      if (/youtu\.be|youtube\.com/i.test(u)) {
        var m = u.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{6,})/);
        if (m) {
          var img = document.createElement('img');
          img.src = 'https://img.youtube.com/vi/' + m[1] + '/mqdefault.jpg';
          img.style.cssText = 'max-width:200px;border-radius:10px;margin-top:8px;';
          vidPrev.appendChild(img);
        }
      }
    };
  }

  var fv = document.getElementById('form-vid');
  if (fv) fv.onsubmit = function (ev) {
    ev.preventDefault();
    if (!canUpload) return;
    var f = ev.target;
    window.equipmentApi
      .sendJson('POST', '/' + id + '/videos', {
        title: f.title.value.trim(),
        video_url: f.video_url.value.trim(),
        platform: f.platform.value || '',
        description: f.description.value.trim() || null,
        access_level: f.access_level.value,
      })
      .then(function (r) {
        if (!r.ok) {
          if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi', false);
        } else {
          if (window.stimsToast) window.stimsToast('Đã thêm video', true);
          f.reset();
          if (vidPrev) vidPrev.innerHTML = '';
          load();
        }
      });
  };

  var fms = document.getElementById('form-maint-sched');
  if (fms) fms.onsubmit = function (ev) {
    ev.preventDefault();
    if (!canManage) return;
    var f = ev.target;
    window.equipmentApi
      .sendJson('POST', '/' + id + '/maintenance', {
        maintenance_type: f.maintenance_type.value,
        scheduled_date: f.scheduled_date.value || null,
        result_note: f.maint_note.value || null,
      })
      .then(function (r) {
        if (!r.ok) {
          if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi', false);
        } else {
          if (window.stimsToast) window.stimsToast('Đã lên lịch bảo trì', true);
          f.reset();
          load();
        }
      });
  };

  var fmd = document.getElementById('form-maint-done');
  if (fmd) fmd.onsubmit = function (ev) {
    ev.preventDefault();
    if (!canManage) return;
    var f = ev.target;
    var mid = f.maint_id.value.trim();
    if (!mid) {
      if (window.stimsToast) window.stimsToast('Nhập ID bản ghi bảo trì', false);
      return;
    }
    window.equipmentApi
      .sendJson('PUT', '/' + id + '/maintenance/' + mid, {
        completed_date: f.completed_date.value || null,
        result_note: f.result_note.value || null,
        cost: f.cost.value ? Number(f.cost.value) : null,
        next_due_date: f.next_due_date.value || null,
      })
      .then(function (r) {
        if (!r.ok) {
          if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi', false);
        } else {
          if (window.stimsToast) window.stimsToast('Đã ghi nhận hoàn thành', true);
          f.reset();
          load();
        }
      });
  };

  var boi = document.getElementById('btn-open-incident');
  if (boi) boi.onclick = function () {
    document.getElementById('modal-incident').hidden = false;
  };
  var bci = document.getElementById('btn-close-incident');
  if (bci) bci.onclick = function () {
    document.getElementById('modal-incident').hidden = true;
  };

  var incPhotos = document.getElementById('inc-photos');
  var incPrev = document.getElementById('inc-photo-preview');
  if (incPhotos && incPrev) {
    incPhotos.onchange = function () {
      incPrev.innerHTML = '';
      var files = [].slice.call(incPhotos.files || [], 0, 5);
      files.forEach(function (file) {
        if (!file.type.match(/^image\//)) return;
        var r = new FileReader();
        r.onload = function () {
          var img = document.createElement('img');
          img.src = r.result;
          img.style.cssText = 'height:64px;border-radius:8px;margin:4px;object-fit:cover;';
          incPrev.appendChild(img);
        };
        r.readAsDataURL(file);
      });
    };
  }

  var fi = document.getElementById('form-incident');
  if (fi) fi.onsubmit = function (ev) {
    ev.preventDefault();
    var f = ev.target;
    var fd = new FormData();
    fd.append('description', f.description.value.trim());
    fd.append('severity', f.severity.value);
    fd.append('extra_note', f.extra_note.value.trim());
    var files = incPhotos && incPhotos.files ? incPhotos.files : [];
    for (var i = 0; i < Math.min(5, files.length); i++) {
      fd.append('photos', files[i]);
    }
    var t = localStorage.getItem('token');
    fetch('/api/equipment/' + id + '/incidents', {
      method: 'POST',
      headers: t ? { Authorization: 'Bearer ' + t } : {},
      body: fd,
      credentials: 'same-origin',
    })
      .then(function (x) {
        return x.json().then(function (j) {
          return { ok: x.ok, data: j };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi gửi sự cố', false);
        } else {
          if (window.stimsToast) window.stimsToast('Đã gửi báo cáo sự cố', true);
          document.getElementById('modal-incident').hidden = true;
          f.reset();
          if (incPrev) incPrev.innerHTML = '';
          load();
        }
      });
  };

  var bir = document.getElementById('btn-inc-resolve');
  if (bir) bir.onclick = function () {
    var incId = document.getElementById('inc-resolve-id').value.trim();
    var note = document.getElementById('inc-resolution').value.trim();
    var cost = document.getElementById('inc-cost').value;
    var rt = document.getElementById('inc-repair-type').value;
    var vendor = document.getElementById('inc-vendor-note');
    var inv = document.getElementById('inc-invoice-ref');
    var invFiles = document.getElementById('inc-invoice-files');
    var prop = document.getElementById('inc-proposal-ref');
    var propFiles = document.getElementById('inc-proposal-files');
    var rfiles = document.getElementById('inc-resolution-files');
    if (!incId) {
      var firstOpen = incidentListCache.find(function (x) {
        var stx = String((x && x.status) || '')
          .trim()
          .toLowerCase();
        return stx !== 'resolved' && stx !== 'closed';
      });
      if (firstOpen && firstOpen.id != null) {
        incId = String(firstOpen.id);
        document.getElementById('inc-resolve-id').value = incId;
      }
    }
    if (!incId || !note) {
      if (window.stimsToast) window.stimsToast('Nhập ID sự cố và kết quả xử lý', false);
      return;
    }
    var fd = new FormData();
    fd.append('resolution_note', note);
    fd.append('cost', cost || '');
    fd.append('repair_type', rt || '');
    if (vendor) fd.append('vendor_note', vendor.value || '');
    if (inv) fd.append('invoice_ref', inv.value || '');
    if (prop) fd.append('proposal_ref', prop.value || '');
    var attachedCount = 0;
    if (invFiles && invFiles.files) {
      for (var fi0 = 0; fi0 < Math.min(5, invFiles.files.length); fi0++) {
        if (attachedCount >= 10) break;
        fd.append('resolution_files', invFiles.files[fi0], 'INV__' + invFiles.files[fi0].name);
        attachedCount++;
      }
    }
    if (propFiles && propFiles.files) {
      for (var fi1 = 0; fi1 < Math.min(5, propFiles.files.length); fi1++) {
        if (attachedCount >= 10) break;
        fd.append('resolution_files', propFiles.files[fi1], 'PROP__' + propFiles.files[fi1].name);
        attachedCount++;
      }
    }
    if (rfiles && rfiles.files) {
      for (var fi = 0; fi < Math.min(10, rfiles.files.length); fi++) {
        if (attachedCount >= 10) break;
        fd.append('resolution_files', rfiles.files[fi], 'RES__' + rfiles.files[fi].name);
        attachedCount++;
      }
    }
    var hdr = window.equipmentApi.authHeaders(false);
    delete hdr['Content-Type'];
    fetch('/api/equipment/' + id + '/incidents/' + incId + '/resolve', {
      method: 'PATCH',
      headers: hdr,
      credentials: 'same-origin',
      body: fd,
    })
      .then(function (x) {
        return x.json().then(function (j) {
          return { ok: x.ok, data: j };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          if (window.stimsToast) window.stimsToast((r.data && r.data.message) || 'Lỗi', false);
        } else {
          var emailSent = r.data && r.data.emailSent === true;
          var msg = 'Đã xử lý sự cố; gửi email: ' + (emailSent ? 'thành công' : 'thất bại');
          if (window.stimsToast) window.stimsToast(msg, emailSent);
          if (rfiles) rfiles.value = '';
          if (invFiles) invFiles.value = '';
          if (propFiles) propFiles.value = '';
          load();
          if (window.equipmentNotifications && typeof window.equipmentNotifications.refresh === 'function') {
            window.equipmentNotifications.refresh();
          }
        }
      });
  };

  syncModuleRole().finally(function () {
    load();
  });
})();
