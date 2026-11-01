/* Module Ngân hàng tế bào & Kháng thể — sơ đồ kho, lưới hộp, mẫu. Mọi dữ liệu người dùng đi qua textContent (không innerHTML). */
(function () {
  'use strict';

  var API = '/api/ngan-hang-te-bao-khang-the';
  var state = { meta: null, tree: null, sel: null, expanded: {}, box: null, search: null };
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
        if (state.search) return runSearch(state.search.p); // đang xem kết quả tìm: làm mới kết quả
        renderDetail();
      })
      .catch(function (e) {
        if (keepBox && e.status === 404) { state.sel = null; return reload(false); }
        say(e.message, 'err');
      });
  }

  function select(type, id) {
    state.search = null;
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
    if (state.search) return renderSearch(box);
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
      ].concat(tube ? [] : [
        // Thêm cùng lô: n ống liên tiếp từ ô này (sang hàng kế khi hết cột), mã vạch = tiền tố + số thứ tự
        { name: 'count', label: 'Số ống cùng lô (1–100, đặt vào các ô liên tiếp từ ô này)', type: 'number', value: 1 },
        { name: 'barcode_prefix', label: 'Tiền tố mã vạch cho cả lô (nếu thêm nhiều ống)', placeholder: 'ví dụ HELA-' },
      ]),
      onSubmit: function (v) {
        var body = { name: v.name, barcode: v.barcode, sample_type_id: v.sample_type_id === '' ? null : Number(v.sample_type_id), passage: v.passage,
          cell_count: v.cell_count, volume_ml: v.volume_ml, freeze_date: v.freeze_date, project: v.project, notes: v.notes };
        var n = tube ? 1 : Number(v.count) || 1;
        var p;
        if (tube) p = api('PATCH', '/tubes/' + tube.id, body);
        else if (n > 1) p = api('POST', '/tubes/bulk', Object.assign({ box_id: box.id, row_no: r, col_no: c, count: n, barcode_prefix: v.barcode_prefix }, body));
        else p = api('POST', '/tubes', Object.assign({ box_id: box.id, row_no: r, col_no: c }, body));
        return p.then(function () { say(tube ? 'Đã cập nhật thông tin mẫu.' : n > 1 ? 'Đã thêm ' + n + ' mẫu.' : 'Đã thêm mẫu.', 'ok'); return reload(true); });
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

  var ACTION_VN = {
    store: 'Nhập kho', move: 'Di chuyển', edit: 'Sửa thông tin', delete: 'Xóa', checkout: 'Lấy ra', checkin: 'Trả lại',
    thaw: 'Rã đông', discard: 'Hủy mẫu', transfer: 'Chuyển chủ sở hữu', box_move: 'Hộp đổi chỗ', box_edit: 'Hộp đổi mã',
  };
  var STATUS_VN = { in_storage: 'Đang lưu kho', checked_out: 'Đã lấy ra', thawed: 'Đã rã đông', discarded: 'Đã hủy' };
  var FIELD_VN = {
    name: 'Tên', barcode: 'Mã vạch', sample_type_id: 'Loại mẫu', passage: 'Passage', cell_count: 'Số tế bào',
    volume_ml: 'Thể tích (mL)', freeze_date: 'Ngày đông lạnh', project: 'Đề tài', notes: 'Ghi chú',
  };

  /** Thời gian lưu trong DB là UTC dạng 'YYYY-MM-DD HH:MM:SS'; hiển thị theo giờ máy người xem. */
  function gioDia(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s || '');
    if (!m) return s || '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    return d.toLocaleString('vi-VN', { hour12: false, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function viTri(boxId, boxCode, r, c) {
    return boxId ? (boxCode || '?') + ' ' + posLabel(r, c) : '';
  }

  /** Cột «Chi tiết» của lịch sử: vị trí đi/đến, hoặc giá trị cũ → mới của lần sửa, hoặc ghi chú. */
  function chiTietLichSu(x) {
    var from = viTri(x.from_box_id, x.from_box_code, x.from_row, x.from_col);
    var to = viTri(x.to_box_id, x.to_box_code, x.to_row, x.to_col);
    if (x.action === 'edit' && x.note) {
      try {
        var d = JSON.parse(x.note);
        return Object.keys(d).map(function (k) {
          var v = function (a) { return a == null ? '(trống)' : String(a); };
          return (FIELD_VN[k] || k) + ': ' + v(d[k][0]) + ' → ' + v(d[k][1]);
        }).join('; ');
      } catch (e) { return 'Đã sửa: ' + x.note; } // bản ghi cũ chỉ lưu tên cột
    }
    var vt = from || to ? from + ' → ' + to : '';
    return [vt, x.note && x.action !== 'edit' ? x.note : ''].filter(Boolean).join(' — ');
  }

  /** Hỏi ghi chú rồi đổi trạng thái mẫu (lấy ra / trả lại / rã đông / hủy). */
  function trangThaiForm(t, act, title, nhanNut, canhBao) {
    openForm({
      title: title + ': ' + t.name,
      fields: [{ name: 'note', label: 'Ghi chú (không bắt buộc)', type: 'textarea' }],
      submitLabel: nhanNut,
      onSubmit: function (v) {
        if (canhBao && !window.confirm(canhBao)) return Promise.reject(new Error('Đã hủy thao tác.'));
        return api('POST', '/tubes/' + t.id + '/' + act, { note: v.note }).then(function () { say(title + ' thành công.', 'ok'); return reload(true); });
      },
    });
  }

  function transferForm(t) {
    api('GET', '/users').then(function (r) {
      var opts = r.users.map(function (u) { return { value: u.id, label: (u.fullname || u.email) + ' — ' + u.email }; });
      openForm({
        title: 'Chuyển chủ sở hữu: ' + t.name,
        fields: [{ name: 'owner_user_id', label: 'Người nhận', type: 'select', options: opts, value: t.owner_user_id, required: true }],
        submitLabel: 'Chuyển',
        onSubmit: function (v) {
          return api('POST', '/tubes/' + t.id + '/transfer', { owner_user_id: Number(v.owner_user_id) })
            .then(function () { say('Đã chuyển chủ sở hữu.', 'ok'); return reload(true); });
        },
      });
    }).catch(function (e) { say(e.message, 'err'); });
  }

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
    var btn = function (label, cls, fn) { return h('button', { type: 'button', class: 'nhm-btn' + (cls ? ' nhm-btn--' + cls : ''), onclick: fn }, label); };
    var buttons = [];
    if (t.can_edit) {
      buttons.push(btn('Chỉnh sửa', '', function () { tubeForm(box, t.row_no, t.col_no, t); }));
      if (t.status === 'in_storage') {
        buttons.push(btn('Di chuyển', '', function () { moveForm(box, t); }));
        buttons.push(btn('Lấy ra', '', function () { trangThaiForm(t, 'checkout', 'Lấy mẫu ra', 'Lấy ra'); }));
      }
      if (t.status === 'checked_out') buttons.push(btn('Trả lại', '', function () { trangThaiForm(t, 'checkin', 'Trả mẫu lại kho', 'Trả lại'); }));
      buttons.push(btn('Rã đông', '', function () { trangThaiForm(t, 'thaw', 'Rã đông mẫu', 'Rã đông', 'Rã đông là không hoàn tác: mẫu sẽ rời khỏi hộp và nhả ô. Tiếp tục?'); }));
      buttons.push(btn('Hủy mẫu', 'danger', function () { trangThaiForm(t, 'discard', 'Hủy mẫu', 'Hủy mẫu', 'Hủy mẫu là không hoàn tác: mẫu sẽ rời khỏi hộp và nhả ô. Tiếp tục?'); }));
      buttons.push(btn('Xóa', 'danger', function () { deleteTube(t); }));
    }
    if (state.meta.canManage) buttons.push(btn('Chuyển chủ', '', function () { transferForm(t); }));
    openInfo(t.name, body, buttons);
    api('GET', '/tubes/' + t.id + '/history').then(function (r) {
      var slot = $('nhm-hist');
      if (!slot) return;
      slot.replaceChildren(h('table', { class: 'nhm-hist' }, [
        h('tr', {}, ['Thời gian', 'Hành động', 'Chi tiết', 'Người thực hiện'].map(function (x) { return h('th', {}, x); })),
      ].concat(r.history.map(function (x) {
        return h('tr', {}, [gioDia(x.at), ACTION_VN[x.action] || x.action, chiTietLichSu(x), x.user_name || '']
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

  // ---------- tìm mẫu xuyên kho ----------
  var TRANG = 25;

  function timKiemQuery(p, kemTrang) {
    var a = [];
    ['q', 'sample_type_id', 'owner', 'status'].forEach(function (k) { if (p[k]) a.push(k + '=' + encodeURIComponent(p[k])); });
    if (kemTrang) { a.push('limit=' + TRANG); a.push('offset=' + (p.offset || 0)); }
    return a.join('&');
  }

  function runSearch(p) {
    state.sel = null;
    state.box = null;
    state.search = { p: p, result: null };
    if (location.hash) location.hash = '';
    renderTree();
    renderDetail();
    api('GET', '/tubes/search?' + timKiemQuery(p, true)).then(function (r) {
      if (!state.search || state.search.p !== p) return; // đã chuyển sang việc khác
      state.search.result = r;
      renderDetail();
    }).catch(function (e) { say(e.message, 'err'); });
  }

  function moMauTuKetQua(it) {
    var t = Object.assign({}, it, { owner_name: it.owner_name });
    if (it.status === 'in_storage' || it.status === 'checked_out') {
      // còn trong hộp: mở hộp rồi mở hộp thoại của mẫu ngay trên lưới
      state.search = null;
      state.sel = { type: 'box', id: it.box_id };
      location.hash = 'box=' + it.box_id;
      var cur = it.container_id;
      while (cur) { state.expanded[cur] = true; var c = state.tree.containers.filter(function (x) { return x.id === cur; })[0]; cur = c && c.parent_id; }
      api('GET', '/boxes/' + it.box_id).then(function (b) {
        state.box = b;
        renderTree();
        renderDetail();
        var tube = b.tubes.filter(function (x) { return x.id === it.id; })[0];
        if (tube) tubeDialog(b.box, tube);
      }).catch(function (e) { say(e.message, 'err'); });
    } else {
      tubeDialog({ id: it.box_id }, t); // đã rã đông / hủy: không còn ô trong hộp
    }
  }

  function renderSearch(root) {
    var s = state.search, p = s.p, r = s.result;
    var typeSel = h('select', { name: 'sample_type_id', 'aria-label': 'Loại mẫu' }, [h('option', { value: '' }, 'Mọi loại mẫu')].concat(
      state.meta.sampleTypes.map(function (x) { return h('option', { value: x.id }, x.name); })));
    typeSel.value = p.sample_type_id || '';
    var qIn = h('input', { name: 'q', type: 'search', placeholder: 'Tên, mã vạch, đề tài, passage, ghi chú…', 'aria-label': 'Từ khóa' });
    qIn.value = p.q || '';
    var mine = h('input', { type: 'checkbox', name: 'owner' }); mine.checked = p.owner === 'me';
    var all = h('input', { type: 'checkbox', name: 'status' }); all.checked = p.status === 'all';
    var form = h('form', { class: 'nhm-searchbar', onsubmit: function (ev) {
      ev.preventDefault();
      runSearch({ q: qIn.value.trim(), sample_type_id: typeSel.value, owner: mine.checked ? 'me' : '', status: all.checked ? 'all' : '', offset: 0 });
    } }, [
      qIn, typeSel,
      h('label', { class: 'nhm-check' }, [mine, 'Chỉ mẫu của tôi']),
      h('label', { class: 'nhm-check' }, [all, 'Gồm mẫu đã rã đông / hủy']),
      h('button', { type: 'submit', class: 'nhm-btn nhm-btn--primary' }, 'Tìm'),
      state.meta.canManage ? h('button', { type: 'button', class: 'nhm-btn', onclick: function () { window.location.href = API + '/tubes/export.csv?' + timKiemQuery(p, false); } }, 'Xuất CSV') : null,
    ]);

    var body;
    if (!r) body = h('div', { class: 'nhm-loading' }, 'Đang tìm…');
    else if (!r.items.length) body = h('p', { class: 'nhm-muted' }, 'Không có mẫu nào khớp.');
    else {
      var rows = r.items.map(function (it) {
        var vt = it.box_id ? it.path.concat([it.box_code]).join(' › ') + (it.row_no ? ' › ' + posLabel(it.row_no, it.col_no) : '') : '—';
        return h('tr', {}, [
          h('td', {}, h('button', { type: 'button', class: 'nhm-link', onclick: function () { moMauTuKetQua(it); } }, it.name)),
          h('td', {}, it.barcode || ''), h('td', {}, it.sample_type_name || ''), h('td', {}, vt),
          h('td', {}, STATUS_VN[it.status] || it.status), h('td', {}, it.owner_name || ''),
        ]);
      });
      var truoc = h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm', disabled: r.offset <= 0, onclick: function () { runSearch(Object.assign({}, p, { offset: Math.max(0, r.offset - TRANG) })); } }, '‹ Trước');
      var sau = h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm', disabled: r.offset + r.items.length >= r.total, onclick: function () { runSearch(Object.assign({}, p, { offset: r.offset + TRANG })); } }, 'Sau ›');
      body = h('div', {}, [
        h('div', { class: 'nhm-gridwrap' }, h('table', { class: 'nhm-hist nhm-results' }, [
          h('tr', {}, ['Tên mẫu', 'Mã vạch', 'Loại mẫu', 'Vị trí', 'Trạng thái', 'Người sở hữu'].map(function (x) { return h('th', {}, x); })),
        ].concat(rows))),
        h('div', { class: 'nhm-pager' }, [truoc, h('span', { class: 'nhm-muted' }, (r.offset + 1) + '–' + (r.offset + r.items.length) + ' / ' + r.total), sau]),
      ]);
    }
    put(root, h('div', { class: 'nhm-title' }, [h('h2', {}, 'Tìm mẫu'), r ? h('span', { class: 'nhm-muted' }, r.total + ' kết quả') : null]), form, body);
  }

  // ---------- quản lý danh mục (chỉ quản lý) ----------
  var DANH_MUC = [
    { path: 'container-types', title: 'Loại vị trí lưu trữ', key: 'containerTypes',
      fields: [{ name: 'name', label: 'Tên', required: true }, { name: 'default_temp_c', label: 'Nhiệt độ mặc định (°C)', type: 'number' }, { name: 'sort_order', label: 'Thứ tự sắp xếp', type: 'number' }],
      show: function (x) { return x.default_temp_c != null ? x.default_temp_c + ' °C' : ''; } },
    { path: 'box-templates', title: 'Mẫu hộp', key: 'boxTemplates',
      fields: [{ name: 'name', label: 'Tên', required: true }, { name: 'rows', label: 'Số hàng (1–26)', type: 'number', required: true }, { name: 'cols', label: 'Số cột (1–30)', type: 'number', required: true }],
      show: function (x) { return x.rows + '×' + x.cols; } },
    { path: 'sample-types', title: 'Loại mẫu', key: 'sampleTypes', fields: [{ name: 'name', label: 'Tên', required: true }], show: function () { return ''; } },
  ];

  function danhMucDialog() {
    api('GET', '/meta').then(function (meta) {
      state.meta = meta;
      var err = h('div', { class: 'nhm-err' });
      var reopen = function () { setTimeout(danhMucDialog, 0); };
      var sections = DANH_MUC.map(function (dm) {
        var rows = meta[dm.key].map(function (x) {
          return h('tr', {}, [
            h('td', {}, x.name), h('td', {}, dm.show(x)),
            h('td', { class: 'nhm-hist-act' }, [
              h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm', onclick: function () { danhMucForm(dm, x, reopen); } }, 'Sửa'),
              h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm nhm-btn--danger', onclick: function () {
                if (!window.confirm('Xóa "' + x.name + '"?')) return;
                api('DELETE', '/' + dm.path + '/' + x.id).then(function () { say('Đã xóa.', 'ok'); return reload(true); }).then(danhMucDialog)
                  .catch(function (e) { err.textContent = e.message; });
              } }, 'Xóa'),
            ]),
          ]);
        });
        return h('section', { class: 'nhm-dm' }, [
          h('div', { class: 'nhm-dm-head' }, [
            h('strong', {}, dm.title),
            h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm', onclick: function () { danhMucForm(dm, null, reopen); } }, '+ Thêm'),
          ]),
          h('table', { class: 'nhm-hist' }, rows),
        ]);
      });
      openInfo('Quản lý danh mục', h('div', {}, sections.concat([err])), []);
    }).catch(function (e) { say(e.message, 'err'); });
  }

  function danhMucForm(dm, x, reopen) {
    openForm({
      title: (x ? 'Sửa: ' : 'Thêm: ') + dm.title.toLowerCase(),
      fields: dm.fields.map(function (f) { return Object.assign({}, f, { value: x ? x[f.name] : undefined }); }),
      onSubmit: function (v) {
        var body = {};
        dm.fields.forEach(function (f) { body[f.name] = v[f.name]; });
        return (x ? api('PATCH', '/' + dm.path + '/' + x.id, body) : api('POST', '/' + dm.path, body))
          .then(function () { say('Đã lưu danh mục.', 'ok'); reopen(); });
      },
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
      $('nhm-search-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        runSearch({ q: $('nhm-search-q').value.trim(), sample_type_id: '', owner: '', status: '', offset: 0 });
      });
      var addRoot = $('nhm-add-root');
      if (meta.canManage) {
        addRoot.classList.remove('nhm-hide');
        addRoot.addEventListener('click', function () { containerForm(null, null); });
        var qlDm = $('nhm-manage-catalog');
        qlDm.classList.remove('nhm-hide');
        qlDm.addEventListener('click', danhMucDialog);
      }
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
