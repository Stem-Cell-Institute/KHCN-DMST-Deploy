/* Module Ngân hàng tế bào & Kháng thể — sơ đồ kho, lưới hộp, mẫu. Mọi dữ liệu người dùng đi qua textContent (không innerHTML). */
(function () {
  'use strict';

  var API = '/api/ngan-hang-te-bao-khang-the';
  var state = { meta: null, me: null, groups: [], tree: null, sel: null, expanded: {}, box: null, search: null };
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
      if (f.type === 'custom') { // ô tự dựng (chọn người, khai nhóm...): f.widget = { node, get() }
        inputs[f.name] = { get value() { return f.widget.get(); } };
        form.appendChild(h('div', { class: 'nhm-field' }, [h('span', { class: 'nhm-lbl' }, f.label), f.widget.node]));
        return;
      }
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

  // ---------- ô chọn người (tìm theo tên / email trong tài khoản đã có) ----------
  /** Trả { node, get() → {id,label}|null, set(u) }. Trưởng nhóm, người nhận... đều là TÀI KHOẢN, không gõ tay. */
  function chonNguoi(opts) {
    var chon = opts && opts.value || null;
    var ket = h('div', { class: 'nhm-pick-list' });
    var chip = h('div', { class: 'nhm-chip-slot' });
    var inp = h('input', { type: 'search', placeholder: (opts && opts.placeholder) || 'Gõ tên hoặc email để tìm…', 'aria-label': (opts && opts.label) || 'Tìm người', autocomplete: 'off' });
    var timer = null;
    function veChip() {
      put(chip, chon ? h('span', { class: 'nhm-chip' }, [chon.label, h('button', { type: 'button', 'aria-label': 'Bỏ chọn', onclick: function () { chon = null; veChip(); if (opts && opts.onChange) opts.onChange(null); } }, '×')]) : null);
    }
    function tim() {
      var q = inp.value.trim();
      if (q.length < 2) { put(ket); return; }
      api('GET', '/users/search?q=' + encodeURIComponent(q)).then(function (r) {
        put(ket, r.users.length ? h('ul', {}, r.users.map(function (u) {
          return h('li', {}, h('button', { type: 'button', class: 'nhm-pick', onclick: function () {
            chon = { id: u.id, label: (u.fullname || u.email) + (u.fullname ? ' · ' + u.email : '') };
            inp.value = ''; put(ket); veChip();
            if (opts && opts.onChange) opts.onChange(chon);
          } }, (u.fullname || '—') + ' · ' + u.email));
        })) : h('p', { class: 'nhm-muted nhm-small' }, 'Không tìm thấy tài khoản nào.'));
      }).catch(function (e) { put(ket, h('p', { class: 'nhm-err' }, e.message)); });
    }
    inp.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(tim, 280); });
    veChip();
    return { node: h('div', { class: 'nhm-picker' }, [chip, inp, ket]), get: function () { return chon; }, set: function (u) { chon = u; veChip(); } };
  }

  var LOAI_CHU = [['sinh_vien', 'Sinh viên'], ['nghien_cuu_vien', 'Nghiên cứu viên'], ['can_bo', 'Cán bộ']];
  function loaiChuVN(v) { var x = LOAI_CHU.filter(function (l) { return l[0] === v; })[0]; return x ? x[1] : ''; }

  /**
   * Ô khai loại chủ + nhóm khi thêm mẫu. Người đã có hồ sơ (quản lý gán) thì chỉ hiện thông tin, không cho khai lại.
   * Người chưa có hồ sơ chọn loại, chọn nhóm có sẵn hoặc «nhóm khác» (nhập tên nhóm + chọn trưởng nhóm từ tài khoản;
   * trưởng nhóm sẽ phải xác nhận, nhóm do quản lý kiểm).
   */
  function chuMauWidget(groups) {
    var hs = state.me && state.me.hoSo;
    if (hs) {
      return { node: h('div', { class: 'nhm-fixed' }, [h('b', {}, 'Chủ mẫu: '), loaiChuVN(hs.loai) + (hs.nhom_ten ? ' · nhóm ' + hs.nhom_ten : ''), h('span', { class: 'nhm-muted nhm-small' }, ' (theo hồ sơ do quản lý gán)')]),
        get: function () { return {}; } };
    }
    var loai = h('select', { 'aria-label': 'Loại chủ mẫu' }, [h('option', { value: '' }, '— chọn loại chủ mẫu —')].concat(LOAI_CHU.map(function (l) { return h('option', { value: l[0] }, l[1]); })));
    var nhom = h('select', { 'aria-label': 'Nhóm nghiên cứu' }, [h('option', { value: '' }, '— chọn nhóm nghiên cứu —')]
      .concat(groups.map(function (g) { return h('option', { value: g.id }, g.ten + (g.truong_ten ? ' (trưởng nhóm: ' + g.truong_ten + ')' : ' (chưa có trưởng nhóm)')); }))
      .concat([h('option', { value: 'moi' }, '+ Nhóm khác (nhập nhóm mới)…')]));
    var tenMoi = h('input', { type: 'text', placeholder: 'Tên nhóm nghiên cứu', 'aria-label': 'Tên nhóm mới', maxlength: '120' });
    var truong = chonNguoi({ placeholder: 'Tìm trưởng nhóm của bạn (tên hoặc email)…', label: 'Trưởng nhóm' });
    var moi = h('div', { class: 'nhm-newgroup nhm-hide' }, [
      h('p', { class: 'nhm-muted nhm-small' }, 'Nhóm mới cần quản lý module xác nhận, và người bạn chọn làm trưởng nhóm sẽ nhận thông báo để xác nhận. Trưởng nhóm là người sẽ duyệt khi có ai xin lấy mẫu của bạn.'),
      tenMoi, truong.node,
    ]);
    nhom.addEventListener('change', function () { moi.classList.toggle('nhm-hide', nhom.value !== 'moi'); });
    return {
      node: h('div', {}, [loai, nhom, moi]),
      get: function () { return { chu_loai: loai.value, nhom: nhom.value, tenMoi: tenMoi.value.trim(), truong: truong.get() }; },
    };
  }

  /** Từ giá trị của chuMauWidget → promise trả phần thân gửi kèm khi thêm mẫu ({chu_loai, nhom_id}). Nhóm mới thì đề xuất trước. */
  function chuMauBody(v) {
    if (v.chu_loai === undefined) return Promise.resolve({}); // đã có hồ sơ: máy chủ tự lấy
    if (!v.chu_loai) return Promise.reject(new Error('Chọn loại chủ mẫu.'));
    if (v.chu_loai !== 'can_bo' && !v.nhom) return Promise.reject(new Error('Chọn nhóm nghiên cứu của mẫu.'));
    if (v.nhom !== 'moi') return Promise.resolve({ chu_loai: v.chu_loai, nhom_id: v.nhom ? Number(v.nhom) : null });
    if (!v.tenMoi) return Promise.reject(new Error('Nhập tên nhóm nghiên cứu mới.'));
    if (!v.truong) return Promise.reject(new Error('Chọn trưởng nhóm từ danh sách tài khoản.'));
    return api('POST', '/groups/propose', { ten: v.tenMoi, truong_user_id: v.truong.id }).then(function (r) { return { chu_loai: v.chu_loai, nhom_id: r.id }; });
  }

  // ---------- biểu tượng ----------
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICON_PATH = {
    tu: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M4 12h16M8 6v3M8 15v3"/>',
    ngan: '<path d="M3 7h18M3 12h18M3 17h18"/>',
    hop: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  };
  /** Biểu tượng SVG đơn sắc (đường nét). Dựng bằng DOM từ chuỗi cố định của mã nguồn, không chứa dữ liệu người dùng. */
  function icon(name) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '18'); s.setAttribute('height', '18');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.7');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICON_PATH[name] || ICON_PATH.ngan;
    return s;
  }

  // ---------- cây thư mục ----------
  function renderTree() {
    var t = state.tree;
    var kids = {}, boxesBy = {}, tong = {};
    t.containers.forEach(function (c) { (kids[c.parent_id == null ? 0 : c.parent_id] = kids[c.parent_id == null ? 0 : c.parent_id] || []).push(c); });
    t.boxes.forEach(function (b) { (boxesBy[b.container_id] = boxesBy[b.container_id] || []).push(b); });
    // số mẫu cộng dồn của cả nhánh
    function dem(c) {
      var n = 0;
      (boxesBy[c.id] || []).forEach(function (b) { n += b.tube_count; });
      (kids[c.id] || []).forEach(function (k) { n += dem(k); });
      return (tong[c.id] = n);
    }
    (kids[0] || []).forEach(dem);

    function nodeBtn(cls, on, ic, label, meta, onclick, caret, extra) {
      return h('button', { type: 'button', class: 'nhm-node ' + cls + (on ? ' nhm-node--on' : ''), 'aria-current': on ? 'true' : null, onclick: onclick }, [
        h('span', { class: 'nhm-node__caret', 'aria-hidden': 'true' }, caret || ''),
        h('span', { class: 'nhm-node__icon' }, icon(ic)),
        h('span', { class: 'nhm-node__label' }, label),
        extra || null,
        h('span', { class: 'nhm-node__meta' }, meta),
      ]);
    }

    function build(parentKey, depth) {
      var items = [];
      (kids[parentKey] || []).forEach(function (c) {
        var children = (kids[c.id] || []).length + (boxesBy[c.id] || []).length;
        var open = !!state.expanded[c.id];
        var la = state.sel && state.sel.type === 'container' && state.sel.id === c.id;
        var tag = c.parent_id == null ? h('span', { class: 'nhm-tag' + (c.quan_ly_boi === 'cellbank' ? ' nhm-tag--cb' : '') }, c.quan_ly_boi === 'cellbank' ? 'Cellbank' : 'Công khai') : null;
        var li = h('li', { role: 'treeitem', 'aria-expanded': children ? String(open) : null }, [
          nodeBtn('nhm-node--container', la, c.parent_id == null ? 'tu' : 'ngan', c.name, tong[c.id] + ' mẫu',
            function () { state.expanded[c.id] = la ? !open : true; select('container', c.id); }, children ? (open ? '▾' : '▸') : '', tag),
        ]);
        if (open && children) {
          var ul = h('ul', { role: 'group' }, build(c.id, depth + 1));
          (boxesBy[c.id] || []).forEach(function (b) {
            ul.appendChild(h('li', { role: 'treeitem' }, [nodeBtn('nhm-node--box', state.sel && state.sel.type === 'box' && state.sel.id === b.id, 'hop',
              b.name || b.code, b.tube_count + '/' + b.rows * b.cols, function () { select('box', b.id); })]));
          });
          li.appendChild(ul);
        }
        items.push(li);
      });
      return items;
    }

    var root = build(0, 0);
    var tatCa = h('div', { class: 'nhm-tree-tools' }, [
      h('button', { type: 'button', class: 'nhm-link', onclick: function () { t.containers.forEach(function (c) { state.expanded[c.id] = true; }); renderTree(); } }, 'Mở hết'),
      h('button', { type: 'button', class: 'nhm-link', onclick: function () { state.expanded = {}; renderTree(); } }, 'Thu gọn'),
    ]);
    put($('nhm-tree'), root.length ? tatCa : null, root.length ? h('ul', { role: 'tree', class: 'nhm-treeul' }, root) : h('p', { class: 'nhm-muted' }, 'Chưa có thiết bị lưu trữ nào.'));
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
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { containerForm(null, c.id); } }, '+ Ngăn / giá bên trong'),
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { boxForm(c.id); } }, '+ Hộp'),
      h('button', { class: 'nhm-btn', type: 'button', onclick: function () { containerForm(c); } }, 'Chỉnh sửa'),
      h('button', { class: 'nhm-btn nhm-btn--danger', type: 'button', onclick: function () { deleteContainer(c); } }, 'Xóa'),
    ]) : null;
    var cb = c.quan_ly_boi === 'cellbank';
    put(box,
      h('div', { class: 'nhm-title' }, [h('h2', {}, c.name), h('span', { class: 'nhm-muted' }, c.type_name + ' · ' + c.code)]),
      h('div', { class: 'nhm-facts' }, [
        fact('Quản lý bởi', cb ? 'Cellbank — gửi yêu cầu để lấy mẫu' : 'Công khai — ai cũng thêm mẫu vào ô trống'),
        fact('Nhiệt độ (°C)', c.temperature_c), fact('Vị trí đặt', c.location_note), fact('Ghi chú', c.notes),
      ]),
      actions,
      subs.length ? h('div', { class: 'nhm-inside' }, [h('h3', {}, 'Bên trong'), h('ul', {}, subs.map(function (x) {
        return h('li', {}, h('button', { type: 'button', class: 'nhm-sub', onclick: function () { state.expanded[c.id] = true; state.expanded[x.id] = true; select('container', x.id); } },
          [icon('ngan'), h('span', { class: 'nhm-sub__name' }, x.name), h('span', { class: 'nhm-muted nhm-small' }, x.type_name)]));
      }))]) : null,
      boxes.length ? h('div', { class: 'nhm-boxlist' }, boxes.map(function (b) {
        var total = b.rows * b.cols;
        return h('button', { type: 'button', class: 'nhm-boxcard', onclick: function () { state.expanded[c.id] = true; select('box', b.id); } }, [
          h('strong', {}, b.name || b.code), h('div', { class: 'nhm-muted' }, b.code + ' · ' + b.rows + '×' + b.cols),
          h('div', {}, b.tube_count + ' / ' + total + ' mẫu'),
          h('div', { class: 'nhm-bar' }, [h('i', { style: 'width:' + Math.round((100 * b.tube_count) / total) + '%' })]),
        ]);
      })) : (subs.length ? null : h('p', { class: 'nhm-muted' }, 'Chưa có hộp hay ngăn nào bên trong.'))
    );
  }

  function renderBox(root) {
    var info = state.box;
    if (!info) { put(root, h('div', { class: 'nhm-loading' }, 'Đang tải hộp…')); return; }
    var b = info.box, byPos = {};
    info.tubes.forEach(function (t) { byPos[t.row_no + ',' + t.col_no] = t; });
    var m = state.meta.canManage;
    var grid = h('div', { class: 'nhm-grid', style: 'grid-template-columns: 26px repeat(' + b.cols + ', var(--nhm-o, 64px))' });
    grid.appendChild(h('div', { class: 'nhm-gh' }));
    for (var c = 1; c <= b.cols; c++) grid.appendChild(h('div', { class: 'nhm-gh' }, c));
    for (var r = 1; r <= b.rows; r++) {
      grid.appendChild(h('div', { class: 'nhm-gh' }, rowLabel(r)));
      for (var cc = 1; cc <= b.cols; cc++) grid.appendChild(cell(b, r, cc, byPos[r + ',' + cc]));
    }
    put(root, 
      h('div', { class: 'nhm-title' }, [h('h2', {}, b.name || b.code), h('span', { class: 'nhm-muted' }, (b.name ? b.code + ' · ' : '') + b.rows + '×' + b.cols + ' · ' + info.tubes.length + ' mẫu')]),
      h('div', { class: 'nhm-path' }, info.path.join(' › ')),
      h('div', { class: 'nhm-actions' }, [
        h('button', { class: 'nhm-btn', type: 'button', onclick: function () { window.print(); } }, 'In sơ đồ hộp'),
        m ? h('button', { class: 'nhm-btn', type: 'button', onclick: function () { boxEditForm(b); } }, 'Chỉnh sửa hộp') : null,
        m ? h('button', { class: 'nhm-btn nhm-btn--danger', type: 'button', onclick: function () { deleteBox(b); } }, 'Xóa hộp') : null,
      ]),
      b.notes ? h('p', { class: 'nhm-muted' }, b.notes) : null,
      h('div', { class: 'nhm-gridwrap' }, [grid]),
      h('p', { class: 'nhm-muted' }, 'Bấm vào ô trống để thêm mẫu; bấm vào ô có mẫu để xem chi tiết. Kéo mẫu sang ô trống để di chuyển trong hộp.')
    );
  }

  function cell(box, r, c, t) {
    var cls = 'nhm-cell' + (t ? ' nhm-cell--full' + (t.status === 'checked_out' ? ' nhm-cell--out' : '') : '');
    var nhan = posLabel(r, c) + (t ? ', ' + t.name + ', ' + (STATUS_VN[t.status] || t.status) : ', trống, thêm mẫu');
    var el = h('div', { class: cls, role: 'button', tabindex: '0', title: posLabel(r, c) + (t ? ' — ' + t.name : ' (trống)'), 'aria-label': nhan, 'data-r': r, 'data-c': c }, t ? t.name : '');
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
      ].concat(!parentId && (!c || c.parent_id == null) ? [
        // chỉ thiết bị gốc; ngăn, giá bên trong thừa hưởng
        { name: 'quan_ly_boi', label: 'Ai quản lý thiết bị này', type: 'select', value: c ? c.quan_ly_boi : 'cong_khai',
          options: [{ value: 'cong_khai', label: 'Công khai — ai cũng thêm mẫu vào ô trống' }, { value: 'cellbank', label: 'Cellbank quản lý — người dùng gửi yêu cầu lấy mẫu' }] },
      ] : []),
      onSubmit: function (v) {
        var body = { name: v.name, type_id: Number(v.type_id), code: v.code || undefined, temperature_c: v.temperature_c, location_note: v.location_note, notes: v.notes };
        if (v.quan_ly_boi) body.quan_ly_boi = v.quan_ly_boi;
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
    var quanLy = state.meta.canManage;
    var chu = tube ? null : chuMauWidget(state.groups || []);
    var nhomOpts = [{ value: '', label: '— không —' }].concat((state.groups || []).map(function (g) { return { value: g.id, label: g.ten }; }));
    var fields = [
      { name: 'name', label: 'Tên mẫu', required: true, value: tube && tube.name },
      { name: 'sample_type_id', label: 'Loại mẫu', type: 'select', options: sampleTypeOptions(), value: tube ? (tube.sample_type_id || '') : '' },
      { name: 'passage', label: 'Passage', value: tube && tube.passage },
      { name: 'cell_count', label: 'Số tế bào', type: 'number', value: tube && tube.cell_count },
      { name: 'volume_ml', label: 'Thể tích (mL)', type: 'number', value: tube && tube.volume_ml },
      { name: 'freeze_date', label: 'Ngày đông lạnh', type: 'date', value: tube && tube.freeze_date },
      { name: 'project', label: 'Đề tài / dự án', value: tube && tube.project },
      { name: 'notes', label: 'Ghi chú', type: 'textarea', value: tube && tube.notes },
    ];
    if (tube && quanLy) {
      // loại chủ và nhóm quyết định ai duyệt yêu cầu về mẫu: chỉ quản lý đổi
      fields.push({ name: 'chu_loai', label: 'Loại chủ mẫu (chỉ quản lý đổi)', type: 'select', value: tube.chu_loai || '',
        options: [{ value: '', label: '— chưa xác định —' }].concat(LOAI_CHU.map(function (l) { return { value: l[0], label: l[1] }; })) });
      fields.push({ name: 'nhom_id', label: 'Nhóm nghiên cứu (chỉ quản lý đổi)', type: 'select', options: nhomOpts, value: tube.nhom_id || '' });
    }
    if (!tube) {
      // Thêm cùng lô: n ống liên tiếp từ ô này (sang hàng kế khi hết cột)
      fields.push({ name: 'count', label: 'Số ống cùng lô (1–100, đặt vào các ô liên tiếp từ ô này)', type: 'number', value: 1 });
      fields.push({ name: 'chu', label: 'Chủ mẫu', type: 'custom', widget: chu });
    }
    openForm({
      title: tube ? 'Chỉnh sửa thông tin mẫu' : 'Thêm mẫu tại ' + posLabel(r, c),
      fields: fields,
      onSubmit: function (v) {
        var body = { name: v.name, sample_type_id: v.sample_type_id === '' ? null : Number(v.sample_type_id), passage: v.passage,
          cell_count: v.cell_count, volume_ml: v.volume_ml, freeze_date: v.freeze_date, project: v.project, notes: v.notes };
        if (tube) {
          if (quanLy) { body.chu_loai = v.chu_loai || null; body.nhom_id = v.nhom_id === '' ? null : Number(v.nhom_id); }
          return api('PATCH', '/tubes/' + tube.id, body).then(function () { say('Đã cập nhật thông tin mẫu.', 'ok'); return reload(true); });
        }
        var n = Number(v.count) || 1;
        return chuMauBody(v.chu).then(function (extra) {
          var all = Object.assign({ box_id: box.id, row_no: r, col_no: c }, body, extra);
          return n > 1 ? api('POST', '/tubes/bulk', Object.assign(all, { count: n })) : api('POST', '/tubes', all);
        }).then(function () { say(n > 1 ? 'Đã thêm ' + n + ' mẫu.' : 'Đã thêm mẫu.', 'ok'); return taiNhom().then(function () { return reload(true); }); });
      },
    });
  }

  /** Di chuyển mẫu: chọn hộp đích rồi bấm vào một ô trống trên lưới của hộp đó. */
  function moveForm(box, tube) {
    var boxes = state.tree.boxes.map(function (b) { return h('option', { value: b.id }, (b.name || b.code) + ' [' + b.code + '] ' + b.rows + '×' + b.cols); });
    var sel = h('select', { 'aria-label': 'Hộp đích' }, boxes);
    sel.value = box.id;
    var slot = h('div', { class: 'nhm-gridwrap' });
    var err = h('div', { class: 'nhm-err' });
    var chon = null; // {box, r, c}
    var goBtn = h('button', { type: 'button', class: 'nhm-btn nhm-btn--primary', disabled: true, onclick: function () {
      if (!chon) return;
      goBtn.disabled = true;
      api('POST', '/tubes/' + tube.id + '/move', { box_id: chon.box, row_no: chon.r, col_no: chon.c })
        .then(function () { closeDialog(); say('Đã di chuyển mẫu tới ' + posLabel(chon.r, chon.c) + '.', 'ok'); return reload(true); })
        .catch(function (e) { err.textContent = e.message; goBtn.disabled = false; });
    } }, 'Di chuyển');

    function veLuoi() {
      chon = null; goBtn.disabled = true; goBtn.textContent = 'Di chuyển'; err.textContent = '';
      put(slot, h('div', { class: 'nhm-loading' }, 'Đang tải hộp…'));
      api('GET', '/boxes/' + sel.value).then(function (info) {
        var b = info.box, byPos = {};
        info.tubes.forEach(function (t) { byPos[t.row_no + ',' + t.col_no] = t; });
        var grid = h('div', { class: 'nhm-grid nhm-grid--mini', style: 'grid-template-columns: 22px repeat(' + b.cols + ', var(--nhm-o-nho, 40px))' });
        grid.appendChild(h('div', { class: 'nhm-gh' }));
        for (var c = 1; c <= b.cols; c++) grid.appendChild(h('div', { class: 'nhm-gh' }, c));
        for (var r = 1; r <= b.rows; r++) {
          grid.appendChild(h('div', { class: 'nhm-gh' }, rowLabel(r)));
          for (var cc = 1; cc <= b.cols; cc++) grid.appendChild(oDich(b, r, cc, byPos[r + ',' + cc], grid));
        }
        put(slot, grid);
      }).catch(function (e) { put(slot, h('div', { class: 'nhm-err' }, e.message)); });
    }

    function oDich(b, r, c, t, grid) {
      var la = t && t.id === tube.id;
      var el = h('button', { type: 'button', class: 'nhm-cell' + (t ? ' nhm-cell--full' : '') + (la ? ' nhm-cell--self' : ''), disabled: !!t,
        title: posLabel(r, c) + (t ? ' — ' + t.name : ' (trống)'), 'aria-label': posLabel(r, c) + (la ? ', vị trí hiện tại' : t ? ', đã có mẫu ' + t.name : ', trống') }, t ? '' : posLabel(r, c));
      if (!t) el.addEventListener('click', function () {
        [].forEach.call(grid.querySelectorAll('.nhm-cell--pick'), function (x) { x.classList.remove('nhm-cell--pick'); });
        el.classList.add('nhm-cell--pick');
        chon = { box: b.id, r: r, c: c };
        goBtn.disabled = false;
        goBtn.textContent = 'Di chuyển tới ' + (b.name || b.code) + ' ' + posLabel(r, c);
      });
      return el;
    }

    sel.addEventListener('change', veLuoi);
    openInfo('Di chuyển: ' + tube.name, h('div', {}, [h('label', { class: 'nhm-lbl' }, ['Hộp đích', sel]), slot, err]), [goBtn]);
    veLuoi();
  }

  var ACTION_VN = {
    store: 'Nhập kho', move: 'Di chuyển', edit: 'Sửa thông tin', delete: 'Xóa', checkout: 'Lấy ra', checkin: 'Trả lại',
    thaw: 'Rã đông', discard: 'Hủy mẫu', transfer: 'Chuyển chủ sở hữu', box_move: 'Hộp đổi chỗ', box_edit: 'Hộp đổi mã',
  };
  var STATUS_VN = { in_storage: 'Đang lưu kho', checked_out: 'Đã lấy ra', thawed: 'Đã rã đông', discarded: 'Đã hủy' };
  var FIELD_VN = {
    name: 'Tên', sample_type_id: 'Loại mẫu', passage: 'Passage', cell_count: 'Số tế bào',
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
    // Chỉ có điểm đi (lấy ra, rã đông, hủy, xóa) hoặc chỉ có điểm đến (nhập kho) thì không in mũi tên thừa
    var vt = from && to ? from + ' → ' + to : to ? '→ ' + to : from;
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
        fact('Loại chủ mẫu', loaiChuVN(t.chu_loai)), fact('Nhóm nghiên cứu', t.nhom_ten), fact('Passage', t.passage), fact('Số tế bào', t.cell_count), fact('Thể tích (mL)', t.volume_ml),
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
    ['q', 'sample_type_id', 'owner', 'status', 'chu_loai', 'nhom_id'].forEach(function (k) { if (p[k]) a.push(k + '=' + encodeURIComponent(p[k])); });
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
    var loaiSel = h('select', { name: 'chu_loai', 'aria-label': 'Loại chủ mẫu' }, [h('option', { value: '' }, 'Sinh viên & cán bộ')].concat(LOAI_CHU.map(function (l) { return h('option', { value: l[0] }, l[1]); })));
    loaiSel.value = p.chu_loai || '';
    var nhomSel = h('select', { name: 'nhom_id', 'aria-label': 'Nhóm nghiên cứu' }, [h('option', { value: '' }, 'Mọi nhóm')].concat((state.groups || []).map(function (g) { return h('option', { value: g.id }, g.ten); })));
    nhomSel.value = p.nhom_id || '';
    var qIn = h('input', { name: 'q', type: 'search', placeholder: 'Tìm mọi thông tin: tên, đề tài, người, nhóm, vị trí…', 'aria-label': 'Từ khóa' });
    qIn.value = p.q || '';
    var mine = h('input', { type: 'checkbox', name: 'owner' }); mine.checked = p.owner === 'me';
    var all = h('input', { type: 'checkbox', name: 'status' }); all.checked = p.status === 'all';
    var form = h('form', { class: 'nhm-searchbar', onsubmit: function (ev) {
      ev.preventDefault();
      runSearch({ q: qIn.value.trim(), sample_type_id: typeSel.value, chu_loai: loaiSel.value, nhom_id: nhomSel.value, owner: mine.checked ? 'me' : '', status: all.checked ? 'all' : '', offset: 0 });
    } }, [
      qIn, typeSel, loaiSel, nhomSel,
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
          h('td', {}, it.sample_type_name || ''), h('td', {}, vt),
          h('td', {}, STATUS_VN[it.status] || it.status), h('td', {}, it.owner_name || ''),
        ]);
      });
      var truoc = h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm', disabled: r.offset <= 0, onclick: function () { runSearch(Object.assign({}, p, { offset: Math.max(0, r.offset - TRANG) })); } }, '‹ Trước');
      var sau = h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm', disabled: r.offset + r.items.length >= r.total, onclick: function () { runSearch(Object.assign({}, p, { offset: r.offset + TRANG })); } }, 'Sau ›');
      body = h('div', {}, [
        h('div', { class: 'nhm-gridwrap' }, h('table', { class: 'nhm-hist nhm-results' }, [
          h('tr', {}, ['Tên mẫu', 'Loại mẫu', 'Vị trí', 'Trạng thái', 'Người sở hữu'].map(function (x) { return h('th', {}, x); })),
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

  // ---------- quản trị: danh mục, nhóm, thành viên, vai trò ----------
  var NHOM_TT = { cho_xac_nhan: 'Chờ quản lý xác nhận', da_xac_nhan: 'Đã xác nhận', giai_the: 'Đã giải thể' };
  var VAI_TRO_VN = { quan_ly: 'Quản lý module', truong_cellbank: 'Trưởng CIPP (Cellbank)' };

  function loiTrongSlot(slot) { return function (e) { put(slot, h('p', { class: 'nhm-err' }, e.message)); }; }
  function nutNho(label, cls, fn) { return h('button', { type: 'button', class: 'nhm-btn nhm-btn--sm' + (cls ? ' nhm-btn--' + cls : ''), onclick: fn }, label); }

  function tabDanhMuc(body, reopen) {
    api('GET', '/meta').then(function (meta) {
      state.meta = meta;
      var err = h('div', { class: 'nhm-err' });
      var sections = DANH_MUC.map(function (dm) {
        var rows = meta[dm.key].map(function (x) {
          return h('tr', {}, [
            h('td', {}, x.name), h('td', {}, dm.show(x)),
            h('td', { class: 'nhm-hist-act' }, [
              nutNho('Sửa', '', function () { danhMucForm(dm, x, reopen); }),
              nutNho('Xóa', 'danger', function () {
                if (!window.confirm('Xóa "' + x.name + '"?')) return;
                api('DELETE', '/' + dm.path + '/' + x.id).then(function () { say('Đã xóa.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
              }),
            ]),
          ]);
        });
        return h('section', { class: 'nhm-dm' }, [
          h('div', { class: 'nhm-dm-head' }, [h('strong', {}, dm.title), nutNho('+ Thêm', '', function () { danhMucForm(dm, null, reopen); })]),
          h('table', { class: 'nhm-hist' }, rows),
        ]);
      });
      put(body, h('div', {}, sections.concat([err])));
    }).catch(loiTrongSlot(body));
  }

  function taiNhom() { return api('GET', '/groups').then(function (r) { state.groups = r.groups; return r.groups; }); }

  function nhomForm(g, reopen) {
    var truong = chonNguoi({ value: g && g.truong_user_id ? { id: g.truong_user_id, label: g.truong_ten || ('#' + g.truong_user_id) } : null, label: 'Trưởng nhóm' });
    openForm({
      title: g ? 'Sửa nhóm nghiên cứu' : 'Thêm nhóm nghiên cứu',
      fields: [
        { name: 'ten', label: 'Tên nhóm', required: true, value: g && g.ten },
        { name: 'truong', label: 'Trưởng nhóm (tài khoản)', type: 'custom', widget: truong },
        { name: 'xn', label: 'Trưởng nhóm đã xác nhận?', type: 'select', options: [{ value: '1', label: 'Có (quản lý xác nhận)' }, { value: '0', label: 'Chưa — người được ghi sẽ tự xác nhận' }], value: g && !g.truong_xac_nhan ? '0' : '1' },
        { name: 'trang_thai', label: 'Trạng thái', type: 'select', options: Object.keys(NHOM_TT).map(function (k) { return { value: k, label: NHOM_TT[k] }; }), value: g ? g.trang_thai : 'da_xac_nhan' },
        { name: 'ghi_chu', label: 'Ghi chú', type: 'textarea', value: g && g.ghi_chu },
      ],
      onSubmit: function (v) {
        var t = v.truong;
        var body = { ten: v.ten, truong_user_id: t ? t.id : null, truong_xac_nhan: v.xn === '1', trang_thai: v.trang_thai, ghi_chu: v.ghi_chu };
        return (g ? api('PATCH', '/groups/' + g.id, body) : api('POST', '/groups', body)).then(function () { say('Đã lưu nhóm.', 'ok'); reopen(); });
      },
    });
  }

  function gopNhomForm(g, danhSach, reopen) {
    var opts = danhSach.filter(function (x) { return x.id !== g.id && x.trang_thai !== 'giai_the'; }).map(function (x) { return { value: x.id, label: x.ten }; });
    if (!opts.length) { say('Chưa có nhóm khác để gộp vào.', 'err'); return; }
    openForm({
      title: 'Gộp nhóm «' + g.ten + '» vào…',
      fields: [{ name: 'into_id', label: 'Nhóm đích (mẫu và thành viên của nhóm này sẽ chuyển sang đó, nhóm này giải thể)', type: 'select', options: opts }],
      submitLabel: 'Gộp nhóm',
      onSubmit: function (v) { return api('POST', '/groups/' + g.id + '/merge', { into_id: Number(v.into_id) }).then(function (r) { say('Đã gộp, chuyển ' + r.mau + ' mẫu.', 'ok'); reopen(); }); },
    });
  }

  function tabNhom(body, reopen) {
    api('GET', '/groups?all=1').then(function (r) {
      var err = h('div', { class: 'nhm-err' });
      var cards = r.groups.map(function (g) {
        var tt = [h('span', { class: 'nhm-chip nhm-chip--tt nhm-chip--' + g.trang_thai }, NHOM_TT[g.trang_thai])];
        if (g.truong_user_id && !g.truong_xac_nhan) tt.push(h('span', { class: 'nhm-chip nhm-chip--warn' }, 'Trưởng nhóm chưa xác nhận'));
        if (!g.truong_user_id) tt.push(h('span', { class: 'nhm-chip nhm-chip--warn' }, 'Chưa có trưởng nhóm'));
        var act = [nutNho('Sửa', '', function () { nhomForm(g, reopen); })];
        if (g.trang_thai === 'cho_xac_nhan') act.push(nutNho('Xác nhận nhóm', '', function () { api('PATCH', '/groups/' + g.id, { trang_thai: 'da_xac_nhan' }).then(reopen).catch(function (e) { err.textContent = e.message; }); }));
        if (g.truong_user_id && !g.truong_xac_nhan) act.push(nutNho('Xác nhận thay trưởng nhóm', '', function () { api('POST', '/groups/' + g.id + '/confirm-leader').then(reopen).catch(function (e) { err.textContent = e.message; }); }));
        if (g.trang_thai !== 'giai_the') act.push(nutNho('Gộp…', '', function () { gopNhomForm(g, r.groups, reopen); }));
        return h('div', { class: 'nhm-card' }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, g.ten), h('span', { class: 'nhm-muted nhm-small' }, g.so_thanh_vien + ' thành viên · ' + g.so_mau + ' mẫu')]),
          h('div', { class: 'nhm-small' }, 'Trưởng nhóm: ' + (g.truong_ten || '—') + (g.de_xuat_ten ? ' · đề xuất bởi ' + g.de_xuat_ten : '')),
          h('div', { class: 'nhm-chips' }, tt),
          h('div', { class: 'nhm-card-act' }, act),
        ]);
      });
      put(body, h('div', {}, [h('div', { class: 'nhm-dm-head' }, [h('strong', {}, 'Nhóm nghiên cứu (' + r.groups.length + ')'), nutNho('+ Thêm nhóm', '', function () { nhomForm(null, reopen); })]),
        r.groups.length ? h('div', { class: 'nhm-cards' }, cards) : h('p', { class: 'nhm-muted' }, 'Chưa có nhóm nào. Nhóm mới sẽ xuất hiện khi người dùng đề xuất lúc thêm mẫu.'), err]));
    }).catch(loiTrongSlot(body));
  }

  function hoSoForm(p, danhSachNhom, reopen) {
    var nguoi = chonNguoi({ value: p ? { id: p.user_id, label: (p.fullname || p.email) } : null, label: 'Người dùng' });
    var nhomOpts = [{ value: '', label: '— không thuộc nhóm —' }].concat(danhSachNhom.filter(function (g) { return g.trang_thai !== 'giai_the'; }).map(function (g) { return { value: g.id, label: g.ten }; }));
    openForm({
      title: p ? 'Sửa hồ sơ thành viên' : 'Thêm hồ sơ thành viên',
      fields: [
        { name: 'nguoi', label: 'Người dùng', type: 'custom', widget: p ? { node: h('div', { class: 'nhm-fixed' }, p.fullname || p.email), get: function () { return { id: p.user_id }; } } : nguoi },
        { name: 'loai', label: 'Loại', type: 'select', options: LOAI_CHU.map(function (l) { return { value: l[0], label: l[1] }; }), value: p && p.loai },
        { name: 'nhom_id', label: 'Nhóm nghiên cứu (bắt buộc với sinh viên và nghiên cứu viên)', type: 'select', options: nhomOpts, value: p && p.nhom_id ? p.nhom_id : '' },
        { name: 'trang_thai', label: 'Trạng thái', type: 'select', options: [{ value: 'dang_hoat_dong', label: 'Đang hoạt động' }, { value: 'da_roi_di', label: 'Đã rời đi (ra trường / nghỉ việc)' }], value: p ? p.trang_thai : 'dang_hoat_dong' },
      ],
      onSubmit: function (v) {
        if (!v.nguoi) return Promise.reject(new Error('Chọn người dùng.'));
        return api('PUT', '/profiles/' + v.nguoi.id, { loai: v.loai, nhom_id: v.nhom_id === '' ? null : Number(v.nhom_id), trang_thai: v.trang_thai })
          .then(function () { say('Đã lưu hồ sơ.', 'ok'); reopen(); });
      },
    });
  }

  function tabThanhVien(body, reopen) {
    Promise.all([api('GET', '/profiles'), api('GET', '/groups?all=1')]).then(function (rs) {
      var err = h('div', { class: 'nhm-err' });
      var ds = rs[0].profiles, nhom = rs[1].groups;
      var rows = ds.map(function (p) {
        var roi = p.trang_thai === 'da_roi_di';
        return h('div', { class: 'nhm-card' + (roi ? ' nhm-card--roi' : '') }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, p.fullname || p.email), h('span', { class: 'nhm-chip' }, loaiChuVN(p.loai))]),
          h('div', { class: 'nhm-small nhm-muted' }, p.email + ' · ' + (p.nhom_ten ? 'nhóm ' + p.nhom_ten : 'không thuộc nhóm') + (roi ? ' · ĐÃ RỜI ĐI' : '')),
          h('div', { class: 'nhm-card-act' }, [
            nutNho('Sửa', '', function () { hoSoForm(p, nhom, reopen); }),
            nutNho(roi ? 'Hoạt động trở lại' : 'Đánh dấu đã rời đi', roi ? '' : 'danger', function () {
              if (!roi && !window.confirm('Đánh dấu ' + (p.fullname || p.email) + ' đã rời đi (ra trường / nghỉ việc)? Yêu cầu về mẫu của họ sẽ chuyển cho trưởng nhóm / quản lý.')) return;
              api('PUT', '/profiles/' + p.user_id, { trang_thai: roi ? 'dang_hoat_dong' : 'da_roi_di' }).then(reopen).catch(function (e) { err.textContent = e.message; });
            }),
          ]),
        ]);
      });
      put(body, h('div', {}, [
        h('div', { class: 'nhm-dm-head' }, [h('strong', {}, 'Hồ sơ thành viên (' + ds.length + ')'), nutNho('+ Thêm hồ sơ', '', function () { hoSoForm(null, nhom, reopen); })]),
        h('p', { class: 'nhm-muted nhm-small' }, 'Hồ sơ cho biết một người là sinh viên, nghiên cứu viên hay cán bộ và thuộc nhóm nào. Người chưa có hồ sơ vẫn thêm mẫu được nhưng phải tự khai.'),
        ds.length ? h('div', { class: 'nhm-cards' }, rows) : h('p', { class: 'nhm-muted' }, 'Chưa có hồ sơ nào.'), err]));
    }).catch(loiTrongSlot(body));
  }

  function tabVaiTro(body, reopen) {
    api('GET', '/roles').then(function (r) {
      var err = h('div', { class: 'nhm-err' });
      var nguoi = chonNguoi({ label: 'Người được cấp vai trò' });
      var sel = h('select', { 'aria-label': 'Vai trò' }, Object.keys(VAI_TRO_VN).map(function (k) { return h('option', { value: k }, VAI_TRO_VN[k]); }));
      var rows = r.roles.map(function (x) {
        return h('div', { class: 'nhm-card' }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, x.fullname || x.email || ('#' + x.user_id)), h('span', { class: 'nhm-chip' }, VAI_TRO_VN[x.vai_tro] || x.vai_tro)]),
          h('div', { class: 'nhm-small nhm-muted' }, x.email || ''),
          h('div', { class: 'nhm-card-act' }, [nutNho('Gỡ vai trò', 'danger', function () {
            if (!window.confirm('Gỡ vai trò «' + (VAI_TRO_VN[x.vai_tro] || x.vai_tro) + '» của ' + (x.fullname || x.email) + '?')) return;
            api('DELETE', '/roles/' + x.id).then(reopen).catch(function (e) { err.textContent = e.message; });
          })]),
        ]);
      });
      put(body, h('div', {}, [
        h('strong', {}, 'Vai trò trong module (' + r.roles.length + ')'),
        h('p', { class: 'nhm-muted nhm-small' }, 'Chỉ Admin cấp và gỡ vai trò. Quản lý module (2–3 người) quản lý thiết bị, hộp, danh mục, nhóm và mọi mẫu; Trưởng CIPP duyệt yêu cầu lấy mẫu ở thiết bị Cellbank.'),
        r.roles.length ? h('div', { class: 'nhm-cards' }, rows) : h('p', { class: 'nhm-muted' }, 'Chưa gán vai trò nào.'),
        h('div', { class: 'nhm-addrole' }, [nguoi.node, sel, nutNho('Cấp vai trò', '', function () {
          var u = nguoi.get();
          if (!u) { err.textContent = 'Chọn người dùng.'; return; }
          api('POST', '/roles', { user_id: u.id, vai_tro: sel.value }).then(function () { say('Đã cấp vai trò.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
        })]),
        err]));
    }).catch(loiTrongSlot(body));
  }

  function quanTriDialog(tab) {
    tab = tab || 'danhmuc';
    var tabs = [['danhmuc', 'Danh mục', tabDanhMuc], ['nhom', 'Nhóm nghiên cứu', tabNhom], ['thanhvien', 'Thành viên', tabThanhVien]];
    if (state.me && state.me.laAdmin) tabs.push(['vaitro', 'Vai trò', tabVaiTro]);
    var body = h('div', { class: 'nhm-tabbody' }, h('div', { class: 'nhm-loading' }, 'Đang tải…'));
    var bar = h('div', { class: 'nhm-tabs', role: 'tablist' }, tabs.map(function (t) {
      return h('button', { type: 'button', role: 'tab', class: 'nhm-tab' + (t[0] === tab ? ' nhm-tab--on' : ''), 'aria-selected': String(t[0] === tab), onclick: function () { quanTriDialog(t[0]); } }, t[1]);
    }));
    openInfo('Quản trị module', h('div', {}, [bar, body]), []);
    var reopen = function () { setTimeout(function () { taiNhom().then(function () { quanTriDialog(tab); }); }, 0); };
    tabs.filter(function (t) { return t[0] === tab; })[0][2](body, reopen);
  }

  // ---------- thông báo: bạn được ghi là trưởng nhóm ----------
  function renderBanner() {
    var slot = $('nhm-banner');
    var ds = (state.me && state.me.nhomChoXacNhan) || [];
    put(slot, ds.length ? h('div', { class: 'nhm-notice', role: 'alert' }, ds.map(function (g) {
      var xong = function () { return api('GET', '/me').then(function (m) { state.me = m; return taiNhom(); }).then(renderBanner); };
      return h('div', { class: 'nhm-notice-row' }, [
        h('span', {}, 'Bạn được ghi là trưởng nhóm «' + g.ten + '»' + (g.de_xuat_ten ? ' (do ' + g.de_xuat_ten + ' đề xuất)' : '') + '. Khi có người xin lấy mẫu của nhóm, bạn là người duyệt. Đúng không?'),
        h('span', { class: 'nhm-notice-act' }, [
          nutNho('Đúng, tôi là trưởng nhóm', 'primary', function () { api('POST', '/groups/' + g.id + '/confirm-leader').then(xong).then(function () { say('Đã xác nhận.', 'ok'); }).catch(function (e) { say(e.message, 'err'); }); }),
          nutNho('Không phải', '', function () { api('POST', '/groups/' + g.id + '/decline-leader').then(xong).then(function () { say('Đã ghi nhận. Quản lý sẽ gán người khác.', 'ok'); }).catch(function (e) { say(e.message, 'err'); }); }),
        ]),
      ]);
    })) : null);
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
        qlDm.addEventListener('click', function () { quanTriDialog('danhmuc'); });
      }
      return Promise.all([api('GET', '/tree'), api('GET', '/me'), taiNhom()]).then(function (rs) { state.me = rs[1]; renderBanner(); return rs[0]; });
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
