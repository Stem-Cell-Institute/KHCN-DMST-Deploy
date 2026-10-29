/* Module Ngân hàng tế bào & Kháng thể — sơ đồ kho, lưới hộp, mẫu. Mọi dữ liệu người dùng đi qua textContent (không innerHTML). */
(function () {
  'use strict';

  var API = '/api/ngan-hang-te-bao-khang-the';
  var state = { meta: null, tree: null, sel: null, expanded: {}, box: null };
  var $ = function (id) { return document.getElementById(id); };

  // ---------- tiện ích ----------
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    [].concat(children == null ? [] : children).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }

  /** Thay nội dung phần tử; bỏ qua null/false (replaceChildren(null) sẽ chèn chữ "null"). */
  function put(el) {
    el.replaceChildren.apply(el, [].slice.call(arguments, 1).filter(function (n) { return n != null && n !== false; }));
  }

  function say(text, kind) {
    var m = $('nhm-msg');
    m.textContent = text || '';
    m.className = 'nhm-msg' + (kind ? ' nhm-msg--' + kind : '');
    if (text && kind === 'ok') setTimeout(function () { if (m.textContent === text) m.textContent = ''; }, 3500);
  }

  function api(method, url, body) {
    return fetch(API + url, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      if (res.status === 401) {
        location.href = '/dang-nhap.html?returnUrl=' + encodeURIComponent(location.pathname);
        return new Promise(function () {});
      }
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) { var e = new Error(json.message || 'Lỗi ' + res.status); e.status = res.status; throw e; }
        return json;
      });
    });
  }

  function rowLabel(r) { return String.fromCharCode(64 + r); }
  function posLabel(r, c) { return rowLabel(r) + c; }
  function parsePos(text, box) {
    var m = /^\s*([A-Za-z])\s*(\d{1,2})\s*$/.exec(text || '');
    if (!m) return null;
    var r = m[1].toUpperCase().charCodeAt(0) - 64, c = parseInt(m[2], 10);
    return r >= 1 && r <= box.rows && c >= 1 && c <= box.cols ? { r: r, c: c } : null;
  }

  // ---------- hộp thoại biểu mẫu ----------
  function closeDialog() { var d = $('nhm-dialog'); if (d.open) d.close(); }

  /** fields: {name,label,type,options:[{value,label}],value,required,placeholder}; onSubmit(values) trả Promise. */
  function openForm(opts) {
    var d = $('nhm-dialog');
    var err = h('div', { class: 'nhm-err' });
    var inputs = {};
    var form = h('form', { class: 'nhm-form', method: 'dialog' });
    form.appendChild(h('h3', {}, opts.title));
    opts.fields.forEach(function (f) {
      var inp;
      if (f.type === 'select') {
        inp = h('select', { name: f.name }, (f.options || []).map(function (o) {
          return h('option', { value: o.value }, o.label);
        }));
      } else if (f.type === 'textarea') {
        inp = h('textarea', { name: f.name });
      } else {
        inp = h('input', { name: f.name, type: f.type || 'text', placeholder: f.placeholder, step: f.type === 'number' ? 'any' : null });
      }
      if (f.value != null) inp.value = f.value;
      if (f.required) inp.required = true;
      inputs[f.name] = inp;
      form.appendChild(h('label', {}, [f.label + (f.required ? ' *' : ''), inp]));
    });
    form.appendChild(err);
    var actions = h('div', { class: 'nhm-form-actions' }, [].concat(opts.extraButtons || [], [
      h('button', { type: 'button', class: 'nhm-btn', onclick: closeDialog }, 'Hủy'),
      h('button', { type: 'submit', class: 'nhm-btn nhm-btn--primary' }, opts.submitLabel || 'Lưu'),
    ]));
    form.appendChild(actions);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var values = {};
      Object.keys(inputs).forEach(function (k) { values[k] = inputs[k].value; });
      err.textContent = '';
      opts.onSubmit(values).then(closeDialog).catch(function (e) { err.textContent = e.message; });
    });
    d.replaceChildren(form);
    if (!d.open) d.showModal();
    var first = form.querySelector('input,select,textarea');
    if (first) first.focus();
  }

  function openInfo(title, nodes, buttons) {
    var d = $('nhm-dialog');
    d.replaceChildren(h('div', {}, [
      h('h3', {}, title),
      nodes,
      h('div', { class: 'nhm-form-actions' }, [].concat(buttons || [], [
        h('button', { type: 'button', class: 'nhm-btn', onclick: closeDialog }, 'Đóng'),
      ])),
    ]));
    if (!d.open) d.showModal();
  }

  // ---------- tải dữ liệu ----------
  function reload(keepBox) {
    return Promise.all([api('GET', '/tree'), keepBox && state.sel && state.sel.type === 'box' ? api('GET', '/boxes/' + state.sel.id) : null])
      .then(function (r) {
        state.tree = r[0];
        state.box = r[1];
        renderTree();
        renderDetail();
      })
      .catch(function (e) {
        if (keepBox && e.status === 404) { state.sel = null; return reload(false); }
        say(e.message, 'err');
      });
  }

  function select(type, id) {
    state.sel = { type: type, id: id };
    state.box = null;
    location.hash = type + '=' + id;
    if (type === 'box') {
      api('GET', '/boxes/' + id).then(function (b) { state.box = b; renderTree(); renderDetail(); }).catch(function (e) { say(e.message, 'err'); });
    } else {
      renderTree();
      renderDetail();
    }
  }

  // ---------- cây ----------
  function renderTree() {
    var t = state.tree;
    var kids = {}, boxesBy = {};
    t.containers.forEach(function (c) { (kids[c.parent_id == null ? 0 : c.parent_id] = kids[c.parent_id == null ? 0 : c.parent_id] || []).push(c); });
    t.boxes.forEach(function (b) { (boxesBy[b.container_id] = boxesBy[b.container_id] || []).push(b); });

    function nodeBtn(cls, on, label, meta, onclick, caret) {
      return h('button', { type: 'button', class: 'nhm-node ' + cls + (on ? ' nhm-node--on' : ''), onclick: onclick }, [
        h('span', { class: 'nhm-node__caret' }, caret || ''),
        h('span', { class: 'nhm-node__label' }, label),
        h('span', { class: 'nhm-node__meta' }, meta),
      ]);
    }

    function build(parentKey) {
      var items = [];
      (kids[parentKey] || []).forEach(function (c) {
        var children = (kids[c.id] || []).length + (boxesBy[c.id] || []).length;
        var open = !!state.expanded[c.id];
        var li = h('li', {}, [
          nodeBtn('nhm-node--container', state.sel && state.sel.type === 'container' && state.sel.id === c.id, c.name, c.type_name,
            function () {
              var already = state.sel && state.sel.type === 'container' && state.sel.id === c.id;
              state.expanded[c.id] = already ? !open : true; // bấm lần đầu: chọn và mở; bấm lại: đóng/mở
              select('container', c.id);
            },
            children ? (open ? '▾' : '▸') : ''),
        ]);
        if (open && children) {
          var ul = h('ul', {}, build(c.id));
          (boxesBy[c.id] || []).forEach(function (b) {
            ul.appendChild(h('li', {}, [nodeBtn('nhm-node--box', state.sel && state.sel.type === 'box' && state.sel.id === b.id,
              b.name || b.code, b.tube_count + '/' + b.rows * b.cols, function () { select('box', b.id); })]));
          });
          li.appendChild(ul);
        }
        items.push(li);
      });
      return items;
    }

    var root = build(0);
    $('nhm-tree').replaceChildren(root.length ? h('ul', {}, root) : h('p', { class: 'nhm-muted' }, 'Chưa có thiết bị lưu trữ nào.'));
  }

  // ---------- khu vực chi tiết ----------
  function fact(label, value) { return h('div', { class: 'nhm-fact' }, [h('b', {}, label), value == null || value === '' ? '—' : String(value)]); }

  function renderDetail() {
    var box = $('nhm-detail');
    var sel = state.sel;
    if (!sel) { put(box, h('p', { class: 'nhm-muted' }, 'Chọn một thiết bị, vị trí lưu trữ hoặc hộp ở bên trái.')); return; }
    if (sel.type === 'box') return renderBox(box);
    var c = state.tree.containers.filter(function (x) { return x.id === sel.id; })[0];
    if (!c) { put(box, h('p', { class: 'nhm-muted' }, 'Không còn mục này.')); return; }
    var boxes = state.tree.boxes.filter(function (b) { return b.container_id === c.id; });
    var subs = state.tree.containers.filter(function (x) { return x.parent_id === c.id; });
    var m = state.meta.canManage;
    var actions = m ? h('div', { class: 'nhm-actions' }, [
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { containerForm(null, c.id); } }, '+ Vị trí lưu trữ con'),
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { boxForm(c.id); } }, '+ Hộp'),
      h('button', { class: 'nhm-btn', type: 'button', onclick: function () { containerForm(c); } }, 'Chỉnh sửa'),
      h('button', { class: 'nhm-btn nhm-btn--danger', type: 'button', onclick: function () { deleteContainer(c); } }, 'Xóa'),
    ]) : null;
    put(box, 
      h('div', { class: 'nhm-title' }, [h('h2', {}, c.name), h('span', { class: 'nhm-muted' }, c.type_name + ' · ' + c.code)]),
      h('div', { class: 'nhm-facts' }, [
        fact('Nhiệt độ (°C)', c.temperature_c), fact('Vị trí đặt', c.location_note),
        fact('Vị trí lưu trữ con', subs.length), fact('Hộp', boxes.length), fact('Ghi chú', c.notes),
      ]),
      actions,
      boxes.length ? h('div', { class: 'nhm-boxlist' }, boxes.map(function (b) {
        var total = b.rows * b.cols;
        return h('button', { type: 'button', class: 'nhm-boxcard', onclick: function () { state.expanded[c.id] = true; select('box', b.id); } }, [
          h('strong', {}, b.name || b.code), h('div', { class: 'nhm-muted' }, b.code + ' · ' + b.rows + '×' + b.cols),
          h('div', {}, b.tube_count + ' / ' + total + ' mẫu'),
          h('div', { class: 'nhm-bar' }, [h('i', { style: 'width:' + Math.round((100 * b.tube_count) / total) + '%' })]),
        ]);
      })) : h('p', { class: 'nhm-muted' }, 'Chưa có hộp nào trong vị trí lưu trữ này.')
    );
  }

  function renderBox(root) {
    var info = state.box;
    if (!info) { put(root, h('div', { class: 'nhm-loading' }, 'Đang tải hộp…')); return; }
    var b = info.box, byPos = {};
    info.tubes.forEach(function (t) { byPos[t.row_no + ',' + t.col_no] = t; });
    var m = state.meta.canManage;
    var grid = h('div', { class: 'nhm-grid', style: 'grid-template-columns: 26px repeat(' + b.cols + ', 62px)' });
    grid.appendChild(h('div', { class: 'nhm-gh' }));
    for (var c = 1; c <= b.cols; c++) grid.appendChild(h('div', { class: 'nhm-gh' }, c));
    for (var r = 1; r <= b.rows; r++) {
      grid.appendChild(h('div', { class: 'nhm-gh' }, rowLabel(r)));
      for (var cc = 1; cc <= b.cols; cc++) grid.appendChild(cell(b, r, cc, byPos[r + ',' + cc]));
    }
    put(root, 
      h('div', { class: 'nhm-title' }, [h('h2', {}, b.name || b.code), h('span', { class: 'nhm-muted' }, (b.name ? b.code + ' · ' : '') + b.rows + '×' + b.cols + ' · ' + info.tubes.length + ' mẫu')]),
      h('div', { class: 'nhm-path' }, info.path.join(' › ')),
      m ? h('div', { class: 'nhm-actions' }, [
        h('button', { class: 'nhm-btn', type: 'button', onclick: function () { boxEditForm(b); } }, 'Chỉnh sửa hộp'),
        h('button', { class: 'nhm-btn nhm-btn--danger', type: 'button', onclick: function () { deleteBox(b); } }, 'Xóa hộp'),
      ]) : null,
      b.notes ? h('p', { class: 'nhm-muted' }, b.notes) : null,
      h('div', { class: 'nhm-gridwrap' }, [grid]),
      h('p', { class: 'nhm-muted' }, 'Bấm vào ô trống để thêm mẫu; bấm vào ô có mẫu để xem chi tiết. Kéo mẫu sang ô trống để di chuyển trong hộp.')
    );
  }

  function cell(box, r, c, t) {
    var cls = 'nhm-cell' + (t ? ' nhm-cell--full' + (t.status === 'checked_out' ? ' nhm-cell--out' : '') : '');
    var el = h('div', { class: cls, role: 'button', tabindex: '0', title: posLabel(r, c) + (t ? ' — ' + t.name : ' (trống)'), 'data-r': r, 'data-c': c }, t ? t.name : '');
    var open = function () { t ? tubeDialog(box, t) : tubeForm(box, r, c); };
    el.addEventListener('click', open);
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    if (t && t.can_edit && t.status === 'in_storage') {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; });
    }
    if (!t) {
      el.addEventListener('dragover', function (e) { e.preventDefault(); el.classList.add('nhm-cell--over'); });
      el.addEventListener('dragleave', function () { el.classList.remove('nhm-cell--over'); });
      el.addEventListener('drop', function (e) {
        e.preventDefault();
        el.classList.remove('nhm-cell--over');
        var id = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!id) return;
        api('POST', '/tubes/' + id + '/move', { box_id: box.id, row_no: r, col_no: c })
          .then(function () { say('Đã di chuyển mẫu tới ' + posLabel(r, c) + '.', 'ok'); return reload(true); })
          .catch(function (er) { say(er.message, 'err'); });
      });
    }
    return el;
  }

  // ---------- biểu mẫu nghiệp vụ ----------
  function containerForm(c, parentId) {
    var typeOpts = state.meta.containerTypes.map(function (t) { return { value: t.id, label: t.name }; });
    openForm({
      title: c ? 'Chỉnh sửa vị trí lưu trữ' : parentId ? 'Thêm vị trí lưu trữ con' : 'Thêm thiết bị lưu trữ',
      fields: [
        { name: 'name', label: 'Tên', required: true, value: c && c.name },
        { name: 'type_id', label: 'Loại', type: 'select', options: typeOpts, value: c ? c.type_id : typeOpts[0] && typeOpts[0].value },
        { name: 'code', label: 'Mã (để trống để tự sinh)', value: c && c.code },
        { name: 'temperature_c', label: 'Nhiệt độ (°C)', type: 'number', value: c && c.temperature_c },
        { name: 'location_note', label: 'Vị trí đặt (phòng…)', value: c && c.location_note },
        { name: 'notes', label: 'Ghi chú', type: 'textarea', value: c && c.notes },
      ],
      onSubmit: function (v) {
        var body = { name: v.name, type_id: Number(v.type_id), code: v.code || undefined, temperature_c: v.temperature_c, location_note: v.location_note, notes: v.notes };
        if (c) { if (!v.code) delete body.code; return api('PATCH', '/containers/' + c.id, body).then(function () { return reload(true); }); }
        if (parentId) body.parent_id = parentId;
        return api('POST', '/containers', body).then(function (r) { if (parentId) state.expanded[parentId] = true; say('Đã thêm vị trí lưu trữ.', 'ok'); return reload(true).then(function () { select('container', r.id); }); });
      },
    });
  }

  function boxForm(containerId) {
    var tpl = state.meta.boxTemplates.map(function (t) { return { value: t.id, label: t.name + ' (' + t.rows + '×' + t.cols + ')' }; });
    openForm({
      title: 'Thêm hộp',
      fields: [
        { name: 'template_id', label: 'Mẫu hộp', type: 'select', options: tpl },
        { name: 'name', label: 'Tên hộp (hoặc tên gốc nếu tạo nhiều)' },
        { name: 'count', label: 'Số lượng hộp (1–50)', type: 'number', value: 1 },
        { name: 'notes', label: 'Ghi chú', type: 'textarea' },
      ],
      onSubmit: function (v) {
        return api('POST', '/boxes', { container_id: containerId, template_id: Number(v.template_id), name: v.name, count: Number(v.count) || 1, notes: v.notes })
          .then(function (r) { state.expanded[containerId] = true; say('Đã tạo ' + r.ids.length + ' hộp.', 'ok'); return reload(true); });
      },
    });
  }

  function boxEditForm(b) {
    var cont = state.tree.containers.map(function (c) { return { value: c.id, label: c.name + ' (' + c.type_name + ')' }; });
    openForm({
      title: 'Chỉnh sửa hộp ' + b.code,
      fields: [
        { name: 'name', label: 'Tên hộp', value: b.name },
        { name: 'code', label: 'Mã hộp', value: b.code, required: true },
        { name: 'container_id', label: 'Đặt trong vị trí lưu trữ', type: 'select', options: cont, value: b.container_id },
        { name: 'rows', label: 'Số hàng (1–26)', type: 'number', value: b.rows },
        { name: 'cols', label: 'Số cột (1–30)', type: 'number', value: b.cols },
        { name: 'notes', label: 'Ghi chú', type: 'textarea', value: b.notes },
      ],
      onSubmit: function (v) {
        return api('PATCH', '/boxes/' + b.id, { name: v.name, code: v.code, container_id: Number(v.container_id), rows: Number(v.rows), cols: Number(v.cols), notes: v.notes })
          .then(function () { return reload(true); });
      },
    });
  }

  function sampleTypeOptions() {
    return [{ value: '', label: '— không chọn —' }].concat(state.meta.sampleTypes.map(function (s) { return { value: s.id, label: s.name }; }));
  }

  function tubeForm(box, r, c, tube) {
    openForm({
      title: tube ? 'Chỉnh sửa thông tin mẫu' : 'Thêm mẫu tại ' + posLabel(r, c),
      fields: [
        { name: 'name', label: 'Tên mẫu', required: true, value: tube && tube.name },
        { name: 'barcode', label: 'Mã vạch', value: tube && tube.barcode },
        { name: 'sample_type_id', label: 'Loại mẫu', type: 'select', options: sampleTypeOptions(), value: tube ? (tube.sample_type_id || '') : '' },
        { name: 'passage', label: 'Passage', value: tube && tube.passage },
        { name: 'cell_count', label: 'Số tế bào', type: 'number', value: tube && tube.cell_count },
        { name: 'volume_ml', label: 'Thể tích (mL)', type: 'number', value: tube && tube.volume_ml },
        { name: 'freeze_date', label: 'Ngày đông lạnh', type: 'date', value: tube && tube.freeze_date },
        { name: 'project', label: 'Đề tài / dự án', value: tube && tube.project },
        { name: 'notes', label: 'Ghi chú', type: 'textarea', value: tube && tube.notes },
      ],
      onSubmit: function (v) {
        var body = { name: v.name, barcode: v.barcode, sample_type_id: v.sample_type_id === '' ? null : Number(v.sample_type_id), passage: v.passage,
          cell_count: v.cell_count, volume_ml: v.volume_ml, freeze_date: v.freeze_date, project: v.project, notes: v.notes };
        var p = tube ? api('PATCH', '/tubes/' + tube.id, body) : api('POST', '/tubes', Object.assign({ box_id: box.id, row_no: r, col_no: c }, body));
        return p.then(function () { say(tube ? 'Đã cập nhật thông tin mẫu.' : 'Đã thêm mẫu.', 'ok'); return reload(true); });
      },
    });
  }

  function moveForm(box, tube) {
    var boxes = state.tree.boxes.map(function (b) { return { value: b.id, label: (b.name || b.code) + ' [' + b.code + '] ' + b.rows + '×' + b.cols }; });
    openForm({
      title: 'Di chuyển: ' + tube.name,
      fields: [
        { name: 'box_id', label: 'Hộp đích', type: 'select', options: boxes, value: box.id },
        { name: 'pos', label: 'Vị trí đích (ví dụ B4)', required: true, placeholder: 'A1' },
      ],
      onSubmit: function (v) {
        var target = state.tree.boxes.filter(function (b) { return b.id === Number(v.box_id); })[0];
        var p = target && parsePos(v.pos, target);
        if (!p) return Promise.reject(new Error('Vị trí không hợp lệ cho hộp đã chọn.'));
        return api('POST', '/tubes/' + tube.id + '/move', { box_id: target.id, row_no: p.r, col_no: p.c })
          .then(function () { say('Đã di chuyển mẫu tới ' + posLabel(p.r, p.c) + '.', 'ok'); return reload(true); });
      },
    });
  }

  var ACTION_VN = { store: 'Nhập kho', move: 'Di chuyển', edit: 'Sửa thông tin', delete: 'Xóa', checkout: 'Lấy ra', checkin: 'Trả lại', thaw: 'Rã đông', discard: 'Hủy mẫu' };
  var STATUS_VN = { in_storage: 'Đang lưu kho', checked_out: 'Đã lấy ra', thawed: 'Đã rã đông', discarded: 'Đã hủy' };

  function tubeDialog(box, t) {
    var body = h('div', {}, [
      h('div', { class: 'nhm-facts' }, [
        fact('Vị trí', posLabel(t.row_no, t.col_no)), fact('Trạng thái', STATUS_VN[t.status] || t.status), fact('Loại mẫu', t.sample_type_name),
        fact('Mã vạch', t.barcode), fact('Passage', t.passage), fact('Số tế bào', t.cell_count), fact('Thể tích (mL)', t.volume_ml),
        fact('Ngày đông lạnh', t.freeze_date), fact('Người sở hữu', t.owner_name), fact('Đề tài', t.project), fact('Ghi chú', t.notes),
      ]),
      h('strong', {}, 'Lịch sử thao tác'),
      h('div', { id: 'nhm-hist' }, h('span', { class: 'nhm-muted' }, 'Đang tải…')),
    ]);
    var buttons = t.can_edit ? [
      h('button', { type: 'button', class: 'nhm-btn', onclick: function () { tubeForm(box, t.row_no, t.col_no, t); } }, 'Chỉnh sửa'),
      h('button', { type: 'button', class: 'nhm-btn', onclick: function () { moveForm(box, t); } }, 'Di chuyển'),
      h('button', { type: 'button', class: 'nhm-btn nhm-btn--danger', onclick: function () { deleteTube(t); } }, 'Xóa'),
    ] : [];
    openInfo(t.name, body, buttons);
    api('GET', '/tubes/' + t.id + '/history').then(function (r) {
      var slot = $('nhm-hist');
      if (!slot) return;
      slot.replaceChildren(h('table', { class: 'nhm-hist' }, [
        h('tr', {}, ['Thời gian', 'Hành động', 'Từ → Đến', 'Người thực hiện'].map(function (x) { return h('th', {}, x); })),
      ].concat(r.history.map(function (x) {
        var from = x.from_box_id ? (x.from_box_code || '?') + ' ' + posLabel(x.from_row, x.from_col) : '';
        var to = x.to_box_id ? (x.to_box_code || '?') + ' ' + posLabel(x.to_row, x.to_col) : '';
        return h('tr', {}, [x.at, ACTION_VN[x.action] || x.action, from || to ? from + ' → ' + to : (x.note || ''), x.user_name || '']
          .map(function (v) { return h('td', {}, v); }));
      }))));
    }).catch(function () { var s = $('nhm-hist'); if (s) s.textContent = 'Không tải được lịch sử.'; });
  }

  // ---------- xóa ----------
  function confirmThen(msg, fn) { if (window.confirm(msg)) fn().catch(function (e) { say(e.message, 'err'); }); }

  function deleteContainer(c) {
    confirmThen('Xóa "' + c.name + '" cùng toàn bộ vị trí lưu trữ con và hộp bên trong? Chỉ xóa được khi không còn mẫu.', function () {
      return api('DELETE', '/containers/' + c.id).then(function (r) { state.sel = null; location.hash = ''; say('Đã xóa ' + r.containers + ' vị trí lưu trữ, ' + r.boxes + ' hộp.', 'ok'); return reload(false); });
    });
  }
  function deleteBox(b) {
    confirmThen('Xóa hộp "' + (b.name || b.code) + '"? Chỉ xóa được khi hộp trống.', function () {
      return api('DELETE', '/boxes/' + b.id).then(function () { state.sel = { type: 'container', id: b.container_id }; say('Đã xóa hộp.', 'ok'); return reload(false); });
    });
  }
  function deleteTube(t) {
    confirmThen('Xóa mẫu "' + t.name + '"? Lịch sử vẫn được lưu.', function () {
      return api('DELETE', '/tubes/' + t.id).then(function () { closeDialog(); say('Đã xóa mẫu.', 'ok'); return reload(true); });
    });
  }

  // ---------- măng-sét: lời chào, về trang chủ, đăng xuất ----------
  function logout() {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () {}).then(function () {
      try { localStorage.removeItem('token'); localStorage.removeItem('user'); } catch (e) {}
      location.href = '/dang-nhap.html';
    });
  }

  function initHeader() {
    var box = $('auth-status');
    if (!box) return;
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (!me) return;
        var u = me.user || me;
        var name = (u.fullname && String(u.fullname).trim()) || (u.email ? String(u.email).split('@')[0] : '');
        put(box, 
          h('span', { class: 'auth-user-info' }, name ? 'Xin chào ' + name : 'Xin chào'),
          h('a', { href: '/index.html', class: 'auth-btn-admin' }, 'Trang chủ'),
          h('button', { type: 'button', class: 'auth-btn-logout', onclick: logout }, 'Đăng xuất')
        );
      })
      .catch(function () {});
  }

  // ---------- khởi động ----------
  function init() {
    api('GET', '/meta').then(function (meta) {
      state.meta = meta;
      var addRoot = $('nhm-add-root');
      if (meta.canManage) { addRoot.classList.remove('nhm-hide'); addRoot.addEventListener('click', function () { containerForm(null, null); }); }
      return api('GET', '/tree');
    }).then(function (tree) {
      state.tree = tree;
      var m = /^#(container|box)=(\d+)$/.exec(location.hash);
      if (m) {
        var id = parseInt(m[2], 10);
        if (m[1] === 'box') {
          var b = tree.boxes.filter(function (x) { return x.id === id; })[0];
          if (b) { var cur = b.container_id, byId = {}; tree.containers.forEach(function (c) { byId[c.id] = c; }); while (cur && byId[cur]) { state.expanded[cur] = true; cur = byId[cur].parent_id; } }
        }
        state.sel = { type: m[1], id: id };
        if (m[1] === 'box') return api('GET', '/boxes/' + id).then(function (bx) { state.box = bx; }).catch(function () { state.sel = null; });
      }
    }).then(function () { renderTree(); renderDetail(); }).catch(function (e) {
      $('nhm-tree').textContent = '';
      say(e.message, 'err');
    });
  }

  initHeader();
  init();
})();
