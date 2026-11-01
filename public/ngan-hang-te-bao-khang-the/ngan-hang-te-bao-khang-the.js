/* Module Ngân hàng tế bào & Kháng thể — sơ đồ kho, lưới hộp, mẫu. Mọi dữ liệu người dùng đi qua textContent (không innerHTML). */
(function () {
  'use strict';

  var API = '/api/ngan-hang-te-bao-khang-the';
  var state = { meta: null, me: null, groups: [], tree: null, sel: null, expanded: {}, box: null, search: null, cv: null, audit: null };
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
        if (state.cv) return taiCv();
        renderDetail();
      })
      .catch(function (e) {
        if (keepBox && e.status === 404) { state.sel = null; return reload(false); }
        say(e.message, 'err');
      });
  }

  function select(type, id) {
    state.search = null;
    state.cv = null;
    state.audit = null;
    state.sel = { type: type, id: id };
    state.box = null;
    location.hash = type + '=' + id;
    manHinhHep(true);
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
    if (hs && hs.nhom_id) {
      return { node: h('div', { class: 'nhm-fixed' }, [h('b', {}, 'Chủ mẫu: '), loaiChuVN(hs.loai) + (hs.nhom_ten ? ' · nhóm ' + hs.nhom_ten : ''), h('span', { class: 'nhm-muted nhm-small' }, ' (theo hồ sơ do quản lý gán)')]),
        get: function () { return {}; } };
    }
    var loai = h('select', { 'aria-label': 'Loại chủ mẫu' }, [h('option', { value: '' }, '— chọn loại chủ mẫu —')].concat(LOAI_CHU.map(function (l) { return h('option', { value: l[0] }, l[1]); })));
    if (hs) loai.classList.add('nhm-hide'); // đã có hồ sơ (vd sinh viên mới kích hoạt): loại chủ lấy từ hồ sơ, chỉ chọn nhóm
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
      node: h('div', {}, [hs ? h('p', { class: 'nhm-hint' }, 'Bạn là ' + loaiChuVN(hs.loai).toLowerCase() + ' của Viện: hãy chọn nhóm nghiên cứu của bạn (nhóm sẽ được ghi vào hồ sơ).') : null, loai, nhom, moi]),
      get: function () { return { hoSo: !!hs, chu_loai: loai.value, nhom: nhom.value, tenMoi: tenMoi.value.trim(), truong: truong.get() }; },
    };
  }

  /** Từ giá trị của chuMauWidget → promise trả phần thân gửi kèm khi thêm mẫu ({chu_loai, nhom_id}). Nhóm mới thì đề xuất trước. */
  function chuMauBody(v) {
    if (v.chu_loai === undefined) return Promise.resolve({}); // đã có hồ sơ và nhóm: máy chủ tự lấy
    if (!v.hoSo && !v.chu_loai) return Promise.reject(new Error('Chọn loại chủ mẫu.'));
    if ((v.hoSo || v.chu_loai !== 'can_bo') && !v.nhom) return Promise.reject(new Error('Chọn nhóm nghiên cứu của mẫu.'));
    var loaiGui = v.hoSo ? {} : { chu_loai: v.chu_loai };
    if (v.nhom !== 'moi') return Promise.resolve(Object.assign(loaiGui, { nhom_id: v.nhom ? Number(v.nhom) : null }));
    if (!v.tenMoi) return Promise.reject(new Error('Nhập tên nhóm nghiên cứu mới.'));
    if (!v.truong) return Promise.reject(new Error('Chọn trưởng nhóm từ danh sách tài khoản.'));
    return api('POST', '/groups/propose', { ten: v.tenMoi, truong_user_id: v.truong.id }).then(function (r) { return Object.assign(loaiGui, { nhom_id: r.id }); });
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
    // giá / hộp có «vị trí số» (bình nitơ) xếp theo số, chưa đánh số thì giữ thứ tự cũ ở cuối
    var theoViTri = function (a, b) { return (a.vi_tri || 999) - (b.vi_tri || 999); };
    Object.keys(kids).forEach(function (k) { kids[k].sort(theoViTri); });
    Object.keys(boxesBy).forEach(function (k) { boxesBy[k].sort(theoViTri); });
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
        var tag = c.parent_id == null ? h('span', { class: 'nhm-tag' + (c.quan_ly_boi === 'cellbank' ? ' nhm-tag--cb' : '') }, c.quan_ly_boi === 'cellbank' ? (c.don_vi_ten || 'Đơn vị') : 'Public') : null;
        var li = h('li', { role: 'treeitem', 'aria-expanded': children ? String(open) : null }, [
          nodeBtn('nhm-node--container', la, c.parent_id == null ? 'tu' : 'ngan', (c.vi_tri ? c.vi_tri + '. ' : '') + c.name, tong[c.id] + ' mẫu',
            function () { state.expanded[c.id] = la ? !open : true; select('container', c.id); }, children ? (open ? '▾' : '▸') : '', tag),
        ]);
        if (open && children) {
          var ul = h('ul', { role: 'group' }, build(c.id, depth + 1));
          (boxesBy[c.id] || []).forEach(function (b) {
            ul.appendChild(h('li', { role: 'treeitem' }, [nodeBtn('nhm-node--box', state.sel && state.sel.type === 'box' && state.sel.id === b.id, 'hop',
              (b.vi_tri ? b.vi_tri + '. ' : '') + (b.name || b.code), b.tube_count + '/' + b.rows * b.cols, function () { select('box', b.id); })]));
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

  /** Màn hình điện thoại / máy tính bảng dọc: sơ đồ kho nằm trên đầu, nên chọn xong thì gập lại và cuộn tới nội dung. */
  function manHinhHep(cuon) {
    if (!window.matchMedia || !window.matchMedia('(max-width: 900px)').matches) return;
    var r = $('nhm-rail');
    if (r) r.open = false;
    if (cuon) setTimeout(function () { var d = $('nhm-detail'); if (d && d.scrollIntoView) d.scrollIntoView({ block: 'start' }); }, 60);
  }

  // ---------- khu vực chi tiết ----------
  function fact(label, value) { return h('div', { class: 'nhm-fact' }, [h('b', {}, label), value == null || value === '' ? '—' : String(value)]); }

  // ---------- bình nitơ lỏng: giá (rack) rồi hộp theo vị trí số, kèm mô hình xuyên thấu ----------
  var containerById = function (id) { return id == null ? null : state.tree.containers.filter(function (x) { return x.id === id; })[0] || null; };
  function gocCua(c) { for (var i = 0; c && c.parent_id != null && i < 50; i++) c = containerById(c.parent_id); return c; }
  var boDau = function (t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase(); };
  /** Vật chứa nằm trong (hoặc là) bình nitơ lỏng? Nhận biết theo tên LOẠI của thiết bị gốc («Bình nitơ lỏng»). */
  function trongBinhNito(c) { var g = gocCua(c); return !!g && boDau(g.type_name).indexOf('nito') >= 0; }
  /** Giá (rack) chứa vật chứa c: tổ tiên là con trực tiếp của bình. */
  function giaCua(c) {
    var g = gocCua(c);
    if (!c || !g || c === g) return null;
    for (var i = 0; c && c.parent_id !== g.id && i < 50; i++) c = containerById(c.parent_id);
    return c || null;
  }

  function duLieuBinh(tank) {
    var racks = {};
    state.tree.containers.forEach(function (x) { if (x.parent_id === tank.id) racks[x.id] = { id: x.id, name: x.name, vi_tri: x.vi_tri, boxes: [] }; });
    state.tree.boxes.forEach(function (b) {
      var r = giaCua(containerById(b.container_id));
      if (r && racks[r.id]) racks[r.id].boxes.push({ id: b.id, vi_tri: b.vi_tri, rows: b.rows, cols: b.cols, name: b.name, code: b.code });
    });
    return { tank: tank, racks: Object.keys(racks).map(function (k) { return racks[k]; }) };
  }

  /** Gắn mô hình bình vào bảng chi tiết nếu mục đang xem nằm trong bình nitơ; sel = {gia}|{hop}|null. */
  function ganBinh(root, containerId, sel) {
    root.classList.remove('nhm-detail--ln');
    state.ln = null;
    var c = containerById(containerId);
    if (!c || !trongBinhNito(c) || !window.NhmBinhLn) return;
    var tank = gocCua(c);
    var tom = h('span', { class: 'nhm-ln__tom' });
    var m = window.NhmBinhLn.tao(duLieuBinh(tank), {
      khiChon: function (t) { tom.textContent = t; },
      chonGia: function (id) { state.expanded[tank.id] = true; select('container', id); },
      chonHop: function (id) { state.expanded[tank.id] = true; select('box', id); },
    });
    state.ln = m;
    var r = giaCua(c);
    m.chon(sel || (r && r.id === c.id ? { gia: r.id } : null));
    var det = h('details', { class: 'nhm-ln' }, [h('summary', {}, [h('span', { class: 'nhm-ln__tit' }, 'Sơ đồ bình ' + tank.name), tom]), m.node]);
    if (window.innerWidth > 900) det.open = true;
    root.classList.add('nhm-detail--ln');
    root.appendChild(det);
  }

  function renderDetail() {
    var box = $('nhm-detail');
    var sel = state.sel;
    if (state.search) return renderSearch(box);
    if (state.cv) return renderCongViec(box);
    if (!sel) { put(box, h('p', { class: 'nhm-muted' }, 'Chọn một thiết bị, vị trí lưu trữ hoặc hộp ở bên trái.')); return; }
    if (sel.type === 'box') { renderBox(box); ganBinh(box, state.box && state.box.box ? state.box.box.container_id : null, { hop: sel.id }); return; }
    var c = state.tree.containers.filter(function (x) { return x.id === sel.id; })[0];
    if (!c) { put(box, h('p', { class: 'nhm-muted' }, 'Không còn mục này.')); return; }
    var boxes = state.tree.boxes.filter(function (b) { return b.container_id === c.id; }).sort(function (a, b) { return (a.vi_tri || 999) - (b.vi_tri || 999); });
    var subs = state.tree.containers.filter(function (x) { return x.parent_id === c.id; });
    var m = state.meta.canManage;
    var actions = m ? h('div', { class: 'nhm-actions' }, [
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { containerForm(null, c.id); } }, '+ Ngăn / Rack bên trong'),
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { boxForm(c.id); } }, '+ Hộp'),
      h('button', { class: 'nhm-btn', type: 'button', onclick: function () { containerForm(c); } }, 'Chỉnh sửa'),
      h('button', { class: 'nhm-btn nhm-btn--danger', type: 'button', onclick: function () { deleteContainer(c); } }, 'Xóa'),
    ]) : null;
    var cb = c.quan_ly_boi === 'cellbank';
    put(box,
      h('div', { class: 'nhm-title' }, [h('h2', {}, c.name), h('span', { class: 'nhm-muted' }, c.type_name + ' · ' + c.code)]),
      h('div', { class: 'nhm-facts' }, [
        fact('Quản lý bởi', cb ? (c.don_vi_ten || 'Đơn vị quản lý') + ' — người dùng gửi yêu cầu để lấy mẫu; ' + (c.don_vi_duyet || 'người duyệt của đơn vị') + ' duyệt' : 'Public — ai cũng thêm mẫu vào ô trống'),
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
          h('strong', {}, (b.vi_tri ? 'Vị trí ' + b.vi_tri + ' · ' : '') + (b.name || b.code)), h('div', { class: 'nhm-muted' }, b.code + ' · ' + b.rows + '×' + b.cols),
          h('div', {}, b.tube_count + ' / ' + total + ' mẫu'),
          h('div', { class: 'nhm-bar' }, [h('i', { style: 'width:' + Math.round((100 * b.tube_count) / total) + '%' })]),
        ]);
      })) : (subs.length ? null : h('p', { class: 'nhm-muted' }, 'Chưa có hộp hay ngăn nào bên trong.'))
    );
    ganBinh(box, c.id, null);
  }

  function renderBox(root) {
    var info = state.box;
    if (!info) { put(root, h('div', { class: 'nhm-loading' }, 'Đang tải hộp…')); return; }
    var b = info.box, byPos = {};
    $('nhm-crumb').textContent = info.path.concat([b.name || b.code]).join(' › ');
    info.tubes.forEach(function (t) { byPos[t.row_no + ',' + t.col_no] = t; });
    (info.phat_hien || []).forEach(function (p) { byPos[p.row_no + ',' + p.col_no] = { phat_hien: p }; });
    var m = state.meta.canManage;
    var cb = info.quan_ly_boi === 'cellbank';
    var kk = state.audit && state.audit.boxId === b.id;
    var grid = h('div', { class: 'nhm-grid' + (kk ? ' nhm-grid--kk' : ''), style: 'grid-template-columns: 26px repeat(' + b.cols + ', var(--nhm-o, 64px))' });
    grid.appendChild(h('div', { class: 'nhm-gh' }));
    for (var c = 1; c <= b.cols; c++) grid.appendChild(h('div', { class: 'nhm-gh' }, c));
    for (var r = 1; r <= b.rows; r++) {
      grid.appendChild(h('div', { class: 'nhm-gh' }, rowLabel(r)));
      for (var cc = 1; cc <= b.cols; cc++) grid.appendChild(cell(b, r, cc, byPos[r + ',' + cc], info));
    }
    var dem = info.tubes.filter(function (t) { return t.status === 'in_storage'; }).length;
    var kkBar = kk ? h('div', { class: 'nhm-notice nhm-notice--kk', role: 'status' }, [
      h('div', { class: 'nhm-notice-row' }, [
        h('span', {}, 'Đang kiểm kê hộp. Mở hộp ngoài đời, bấm vào những mẫu KHÔNG thấy (chuyển sang gạch đỏ). Mẫu không bấm là có mặt. Đã đánh dấu không thấy: ' + Object.keys(state.audit.khong).length + ' / ' + dem + ' mẫu.'),
        h('span', { class: 'nhm-notice-act' }, [
          nutNho('Hoàn tất kiểm kê', 'primary', function () { hoanTatKiemKe(info); }),
          nutNho('Thoát', '', function () { state.audit = null; renderDetail(); }),
        ]),
      ]),
    ]) : null;
    put(root,
      h('div', { class: 'nhm-title' }, [h('h2', {}, b.name || b.code), h('span', { class: 'nhm-muted' }, (b.name ? b.code + ' · ' : '') + b.rows + '×' + b.cols + ' · ' + info.tubes.length + ' mẫu' + (cb ? ' · ' + (info.don_vi_ten || 'Đơn vị quản lý') : ''))]),
      h('div', { class: 'nhm-path' }, info.path.join(' › ')),
      cb && !m ? h('p', { class: 'nhm-hint' }, 'Thiết bị do ' + (info.don_vi_ten || 'đơn vị quản lý') + ' quản lý: bạn không tự thêm hay lấy mẫu ở đây. Muốn lấy mẫu, bấm vào mẫu rồi gửi yêu cầu; ' + (info.don_vi_duyet || 'người duyệt của đơn vị') + ' sẽ duyệt và hệ thống gửi email báo kết quả cho bạn.') : null,
      kkBar,
      h('div', { class: 'nhm-actions' }, [
        h('button', { class: 'nhm-btn', type: 'button', onclick: function () { window.print(); } }, 'In sơ đồ hộp'),
        m && !kk ? h('button', { class: 'nhm-btn', type: 'button', onclick: function () { state.audit = { boxId: b.id, khong: {} }; renderDetail(); } }, 'Kiểm kê hộp') : null,
        m ? h('button', { class: 'nhm-btn', type: 'button', onclick: function () { boxEditForm(b); } }, 'Chỉnh sửa hộp') : null,
        m ? h('button', { class: 'nhm-btn nhm-btn--danger', type: 'button', onclick: function () { deleteBox(b); } }, 'Xóa hộp') : null,
      ]),
      b.notes ? h('p', { class: 'nhm-muted' }, b.notes) : null,
      h('div', { class: 'nhm-gridwrap' }, [grid]),
      h('p', { class: 'nhm-muted nhm-small' }, 'Bấm vào ô trống để thêm mẫu; bấm vào ô có mẫu để xem chi tiết. Màu đỏ: mẫu đang được lấy ra. Gạch vàng: mẫu nghi mất. Ô vàng «?»: có mẫu nhưng chưa khai báo.')
    );
  }

  function hoanTatKiemKe(info) {
    var khong = Object.keys(state.audit.khong).map(Number);
    var thay = info.tubes.filter(function (t) { return t.status === 'in_storage' && !state.audit.khong[t.id]; }).map(function (t) { return t.id; });
    if (khong.length && !window.confirm('Có ' + khong.length + ' mẫu không thấy: hệ thống sẽ mở vụ việc nghi mất và gửi thông báo cho chủ mẫu. Tiếp tục?')) return;
    api('POST', '/boxes/' + info.box.id + '/audit', { thay: thay, khong_thay: khong })
      .then(function (r) { state.audit = null; say('Đã kiểm kê: ' + r.thay + ' có mặt, ' + r.khong_thay + ' không thấy (' + r.vu_viec_moi + ' vụ việc mới).', 'ok'); return reload(true); })
      .then(taiMe)
      .catch(function (e) { say(e.message, 'err'); });
  }

  function cell(box, r, c, t, info) {
    var ph = t && t.phat_hien;
    if (ph) t = null;
    var kk = state.audit && state.audit.boxId === box.id;
    var cls = 'nhm-cell' + (t ? ' nhm-cell--full' + (t.status === 'checked_out' ? ' nhm-cell--out' : '') + (t.nghi_mat ? ' nhm-cell--mat' : '') : '') + (ph ? ' nhm-cell--ph' : '');
    var nhan = posLabel(r, c) + (ph ? ', mẫu chưa khai báo: ' + ph.mo_ta : t ? ', ' + t.name + ', ' + (STATUS_VN[t.status] || t.status) + (t.nghi_mat ? ', nghi mất' : '') : ', trống, thêm mẫu');
    var el = h('div', { class: cls, role: 'button', tabindex: '0', title: nhan, 'aria-label': nhan, 'data-r': r, 'data-c': c }, ph ? '?' : t ? t.name : '');
    var open;
    if (kk) {
      // chế độ kiểm kê: chỉ mẫu đang lưu kho bấm được; bấm = «không thấy»
      if (t && t.status === 'in_storage') {
        if (state.audit.khong[t.id]) el.classList.add('nhm-cell--kk-khong');
        open = function () { if (state.audit.khong[t.id]) delete state.audit.khong[t.id]; else state.audit.khong[t.id] = true; renderDetail(); };
      } else open = function () {};
    } else if (ph) open = function () { phatHienDialog(box, ph.id); };
    else if (t) open = function () { tubeDialog(box, t); };
    else open = function () {
      if (info && info.quan_ly_boi === 'cellbank' && !state.meta.canManage) { say('Thiết bị này do ' + (info.don_vi_ten || 'đơn vị quản lý') + ' quản lý: chỉ quản lý module mới thêm mẫu. Bạn có thể gửi yêu cầu cho mẫu đã có.', 'err'); return; }
      tubeForm(box, r, c);
    };
    el.addEventListener('click', open);
    var lnChon = function () { if (state.ln) state.ln.chon({ hop: box.id, row: r, col: c }); };
    ['mouseenter', 'focus', 'click'].forEach(function (ev) { el.addEventListener(ev, lnChon); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    if (!kk && t && t.can_edit && t.status === 'in_storage' && !(info && info.quan_ly_boi === 'cellbank' && !state.meta.canManage)) {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; });
    }
    if (!kk && !t && !ph) {
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
      ].concat(viTriGiaField(c, parentId)).concat(!parentId && (!c || c.parent_id == null) ? [
        // chỉ thiết bị gốc; ngăn, giá bên trong thừa hưởng
        { name: 'don_vi_id', label: 'Ai quản lý thiết bị này', type: 'select', value: c && c.don_vi_id ? String(c.don_vi_id) : '',
          options: [{ value: '', label: 'Public — ai cũng thêm mẫu vào ô trống' }].concat((state.meta.donVi || []).map(function (d) {
            return { value: String(d.id), label: d.ten + ' quản lý — người dùng gửi yêu cầu, người duyệt của đơn vị quyết định' };
          })) },
      ] : []),
      onSubmit: function (v) {
        var body = { name: v.name, type_id: Number(v.type_id), code: v.code || undefined, temperature_c: v.temperature_c, location_note: v.location_note, notes: v.notes };
        if ('vi_tri' in v) body.vi_tri = v.vi_tri === '' || v.vi_tri == null ? null : Number(v.vi_tri);
        if ('don_vi_id' in v) body.don_vi_id = v.don_vi_id === '' ? null : Number(v.don_vi_id);
        if (c) { if (!v.code) delete body.code; return api('PATCH', '/containers/' + c.id, body).then(function () { return reload(true); }); }
        if (parentId) body.parent_id = parentId;
        return api('POST', '/containers', body).then(function (r) { if (parentId) state.expanded[parentId] = true; say('Đã thêm vị trí lưu trữ.', 'ok'); return reload(true).then(function () { select('container', r.id); }); });
      },
    });
  }

  /** Ô «vị trí số» cho giá trong bình nitơ (thêm giá con trực tiếp của bình, hoặc sửa một giá); khác thì không có ô. */
  function viTriGiaField(c, parentId) {
    var cha = parentId != null ? containerById(parentId) : c ? containerById(c.parent_id) : null;
    if (!cha || cha.parent_id != null || !trongBinhNito(cha)) return [];
    var da = state.tree.containers.filter(function (x) { return x.parent_id === cha.id && (!c || x.id !== c.id) && x.vi_tri; }).map(function (x) { return x.vi_tri; });
    return [{ name: 'vi_tri', label: 'Vị trí Rack trong bình (số 1–50)', type: 'number', required: true, value: c && c.vi_tri ? c.vi_tri : (da.length ? Math.max.apply(null, da) + 1 : 1) }];
  }

  function boxForm(containerId) {
    var cont = containerById(containerId);
    if (cont && trongBinhNito(cont)) return boxTrongGiaForm(containerId);
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

  /** Hộp trong giá của bình nitơ: khai VỊ TRÍ SỐ của hộp trong giá (1–50, số 1 ở trên cùng), mỗi lần một hộp. */
  function boxTrongGiaForm(containerId) {
    var tpl = state.meta.boxTemplates.map(function (t) { return { value: t.id, label: t.name + ' (' + t.rows + '×' + t.cols + ')' }; });
    var da = state.tree.boxes.filter(function (x) { return x.container_id === containerId && x.vi_tri; }).map(function (x) { return x.vi_tri; });
    openForm({
      title: 'Thêm hộp vào Rack',
      fields: [
        { name: 'vi_tri', label: 'Vị trí hộp trong Rack (số 1–50, số 1 ở trên cùng, càng lớn càng sâu)', type: 'number', required: true, value: da.length ? Math.min(50, Math.max.apply(null, da) + 1) : 1 },
        { name: 'template_id', label: 'Mẫu hộp', type: 'select', options: tpl },
        { name: 'name', label: 'Tên hộp' },
        { name: 'notes', label: 'Ghi chú', type: 'textarea' },
      ],
      onSubmit: function (v) {
        return api('POST', '/boxes', { container_id: containerId, template_id: Number(v.template_id), name: v.name, vi_tri: Number(v.vi_tri), notes: v.notes })
          .then(function () { state.expanded[containerId] = true; say('Đã thêm hộp vào vị trí ' + v.vi_tri + '.', 'ok'); return reload(true); });
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
      ].concat(trongBinhNito(containerById(b.container_id)) ? [{ name: 'vi_tri', label: 'Vị trí hộp trong Rack (số 1–50, số 1 ở trên cùng, càng lớn càng sâu)', type: 'number', value: b.vi_tri }] : []),
      onSubmit: function (v) {
        var body = { name: v.name, code: v.code, container_id: Number(v.container_id), rows: Number(v.rows), cols: Number(v.cols), notes: v.notes };
        if ('vi_tri' in v) body.vi_tri = v.vi_tri === '' || v.vi_tri == null ? null : Number(v.vi_tri);
        return api('PATCH', '/boxes/' + b.id, body)
          .then(function () { return reload(true); });
      },
    });
  }

  function sampleTypeOptions() {
    return [{ value: '', label: '— không chọn —' }].concat(state.meta.sampleTypes.map(function (s) { return { value: s.id, label: s.name }; }));
  }

  function tubeForm(box, r, c, tube, opts) {
    var claim = opts && opts.claimId;
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
      if (!claim) fields.push({ name: 'count', label: 'Số ống cùng lô (1–100, đặt vào các ô liên tiếp từ ô này)', type: 'number', value: 1 });
      fields.push({ name: 'chu', label: 'Chủ mẫu', type: 'custom', widget: chu });
    }
    openForm({
      title: tube ? 'Chỉnh sửa thông tin mẫu' : (claim ? 'Nhận và khai báo mẫu tại ' : 'Thêm mẫu tại ') + posLabel(r, c),
      fields: fields,
      extraButtons: !tube && !claim && quanLy ? [h('button', { type: 'button', class: 'nhm-btn', onclick: function () { phatHienForm(box, r, c); } }, 'Ô này có mẫu nhưng chưa khai báo')] : [],
      onSubmit: function (v) {
        var body = { name: v.name, sample_type_id: v.sample_type_id === '' ? null : Number(v.sample_type_id), passage: v.passage,
          cell_count: v.cell_count, volume_ml: v.volume_ml, freeze_date: v.freeze_date, project: v.project, notes: v.notes };
        if (tube) {
          if (quanLy) { body.chu_loai = v.chu_loai || null; body.nhom_id = v.nhom_id === '' ? null : Number(v.nhom_id); }
          return api('PATCH', '/tubes/' + tube.id, body).then(function () { say('Đã cập nhật thông tin mẫu.', 'ok'); return reload(true); });
        }
        var n = claim ? 1 : Number(v.count) || 1;
        return chuMauBody(v.chu).then(function (extra) {
          if (claim) return api('POST', '/findings/' + claim + '/claim', Object.assign({}, body, extra));
          var all = Object.assign({ box_id: box.id, row_no: r, col_no: c }, body, extra);
          return n > 1 ? api('POST', '/tubes/bulk', Object.assign(all, { count: n })) : api('POST', '/tubes', all);
        }).then(function () { say(claim ? 'Đã nhận và khai báo mẫu. Cảm ơn bạn.' : n > 1 ? 'Đã thêm ' + n + ' mẫu.' : 'Đã thêm mẫu.', 'ok'); return taiNhom().then(function () { return claim ? (state.cv ? lamMoiCv() : reload(true).then(taiMe)) : reload(true); }); });
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
    chu_tu_lay: 'Chủ mẫu tự lấy', yc_gui: 'Gửi yêu cầu lấy mẫu', yc_duyet: 'Duyệt yêu cầu', yc_tu_choi: 'Từ chối yêu cầu', yc_huy: 'Hủy yêu cầu', yc_leo_thang: 'Yêu cầu chuyển quản lý',
    yc_dinh_tuyen_lai: 'Đổi người duyệt', giao: 'Giao mẫu', tra: 'Nhận lại mẫu', khai_bao_bo_sung: 'Khai báo bổ sung', bao_mat: 'Báo mất',
    nguoi_nhan_lay: 'Có người nhận đã lấy', xac_nhan_lay: 'Xác nhận người lấy', tu_choi_nhan: 'Từ chối lời nhận', tim_thay: 'Tìm thấy', huy_bao_mat: 'Hủy báo mất',
    that_lac: 'Thất lạc', kiem_ke_thay: 'Kiểm kê: có mặt', kiem_ke_khong_thay: 'Kiểm kê: không thấy', nhom_doi: 'Nhóm đổi', nhom_giai_the: 'Nhóm giải thể',
    nhom_gop: 'Nhóm gộp', nhom_truong_xac_nhan: 'Trưởng nhóm xác nhận', nhom_truong_tu_choi: 'Trưởng nhóm từ chối', chu_roi_di: 'Chủ mẫu rời đi', chu_tro_lai: 'Chủ mẫu quay lại',
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
  var NHAN_GHI_CHU = {
    checkout: 'Mục đích sử dụng (bắt buộc)',
    checkin: 'Tình trạng khi trả: còn lại bao nhiêu, có vấn đề gì không (bắt buộc)',
    thaw: 'Mục đích rã đông (bắt buộc)',
    discard: 'Lý do hủy mẫu (bắt buộc)',
  };

  function trangThaiForm(t, act, title, nhanNut, canhBao) {
    openForm({
      title: title + ': ' + t.name,
      // thông tin thao tác là BẮT BUỘC: lịch sử mẫu phải cho biết vì sao mẫu rời kho, ai làm, tình trạng khi trả
      fields: [{ name: 'note', label: NHAN_GHI_CHU[act], type: 'textarea', required: true }],
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
        fact('Vị trí', posLabel(t.row_no, t.col_no)), fact('Trạng thái', (STATUS_VN[t.status] || t.status) + (t.nghi_mat ? ' — NGHI MẤT' : '')), fact('Loại mẫu', t.sample_type_name),
        fact('Loại chủ mẫu', loaiChuVN(t.chu_loai)), fact('Nhóm nghiên cứu', t.nhom_ten), fact('Passage', t.passage), fact('Số tế bào', t.cell_count), fact('Thể tích (mL)', t.volume_ml),
        fact('Ngày đông lạnh', t.freeze_date), fact('Người sở hữu', t.owner_name), fact('Đề tài', t.project), fact('Ghi chú', t.notes),
      ]),
      h('strong', {}, 'Lịch sử thao tác'),
      h('div', { id: 'nhm-hist' }, h('span', { class: 'nhm-muted' }, 'Đang tải…')),
    ]);
    var btn = function (label, cls, fn) { return h('button', { type: 'button', class: 'nhm-btn' + (cls ? ' nhm-btn--' + cls : ''), onclick: fn }, label); };
    var buttons = [];
    var cbKhoa = state.box && state.box.quan_ly_boi === 'cellbank' && !state.meta.canManage; // mẫu ở thiết bị Cellbank: người dùng thường chỉ sửa mô tả
    var laChu = state.me && t.owner_user_id === state.me.id;
    if (t.can_edit) {
      buttons.push(btn('Chỉnh sửa', '', function () { tubeForm(box, t.row_no, t.col_no, t); }));
      if (t.status === 'in_storage' && !cbKhoa) {
        buttons.push(btn('Di chuyển', '', function () { moveForm(box, t); }));
        buttons.push(btn('Lấy ra', '', function () { trangThaiForm(t, 'checkout', 'Lấy mẫu ra', 'Lấy ra'); }));
      }
      if (t.status === 'checked_out' && !cbKhoa) buttons.push(btn('Trả lại', '', function () { trangThaiForm(t, 'checkin', 'Trả mẫu lại kho', 'Trả lại'); }));
      if (!cbKhoa) {
        buttons.push(btn('Rã đông', '', function () { trangThaiForm(t, 'thaw', 'Rã đông mẫu', 'Rã đông', 'Rã đông là không hoàn tác: mẫu sẽ rời khỏi hộp và nhả ô. Tiếp tục?'); }));
        buttons.push(btn('Hủy mẫu', 'danger', function () { trangThaiForm(t, 'discard', 'Hủy mẫu', 'Hủy mẫu', 'Hủy mẫu là không hoàn tác: mẫu sẽ rời khỏi hộp và nhả ô. Tiếp tục?'); }));
        buttons.push(btn('Xóa', 'danger', function () { deleteTube(t); }));
      }
      if (t.status === 'in_storage' && !t.nghi_mat) buttons.push(btn('Báo không còn ở vị trí', '', function () { baoMatForm(t); }));
    }
    // người khác muốn lấy mẫu: gửi yêu cầu (quản lý tự thao tác được nên không cần)
    // (chủ mẫu có mẫu ở thiết bị Cellbank cũng phải gửi yêu cầu vì không được tự lấy)
    if ((!laChu || cbKhoa) && !state.meta.canManage && t.status === 'in_storage' && !t.nghi_mat) buttons.unshift(btn('Xin lấy mẫu này', 'primary', function () { xinMauForm(t); }));
    if (t.nghi_mat) buttons.unshift(btn('Mẫu nghi mất — xem vụ việc', 'danger', function () { closeDialog(); moCongViec('nghimat'); }));
    if (state.meta.canManage) buttons.push(btn('Chuyển chủ', '', function () { transferForm(t); }));
    openInfo(t.name, body, buttons);
    api('GET', '/tubes/' + t.id + '/history').then(function (r) {
      var slot = $('nhm-hist');
      if (!slot) return;
      slot.replaceChildren(h('table', { class: 'nhm-hist' }, [
        h('tr', {}, ['Thời gian', 'Hành động', 'Chi tiết', 'Người thực hiện'].map(function (x) { return h('th', {}, x); })),
      ].concat(r.history.map(function (x) {
        return h('tr', {}, [gioDia(x.at), ACTION_VN[x.action] || x.action, chiTietLichSu(x), x.user_label || x.user_name || '']
          .map(function (v, i) { return h('td', { 'data-l': ['Thời gian', 'Hành động', 'Chi tiết', 'Người'][i] }, v); }));
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
    state.cv = null;
    state.audit = null;
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
          h('td', { 'data-l': 'Tên mẫu' }, h('button', { type: 'button', class: 'nhm-link', onclick: function () { moMauTuKetQua(it); } }, it.name)),
          h('td', { 'data-l': 'Loại mẫu' }, it.sample_type_name || ''), h('td', { 'data-l': 'Vị trí' }, vt),
          h('td', { 'data-l': 'Trạng thái' }, STATUS_VN[it.status] || it.status), h('td', { 'data-l': 'Người sở hữu' }, it.owner_name || ''),
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
        h('p', { class: 'nhm-muted nhm-small' }, 'Chỉ Admin cấp và gỡ vai trò. Quản lý module (2–3 người) quản lý thiết bị, hộp, danh mục, nhóm và mọi mẫu; Trưởng CIPP là người duyệt của đơn vị Cellbank (người duyệt của các đơn vị khác gán ở thẻ Đơn vị quản lý).'),
        r.roles.length ? h('div', { class: 'nhm-cards' }, rows) : h('p', { class: 'nhm-muted' }, 'Chưa gán vai trò nào.'),
        h('div', { class: 'nhm-addrole' }, [nguoi.node, sel, nutNho('Cấp vai trò', '', function () {
          var u = nguoi.get();
          if (!u) { err.textContent = 'Chọn người dùng.'; return; }
          api('POST', '/roles', { user_id: u.id, vai_tro: sel.value }).then(function () { say('Đã cấp vai trò.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
        })]),
        err]));
    }).catch(loiTrongSlot(body));
  }

  // ----- danh sách sinh viên của Viện (Trung tâm quản lý người học) -----
  var TINH_TRANG_SV = { cho_kich_hoat: 'Chờ kích hoạt', da_kich_hoat: 'Đã kích hoạt', het_han: 'Hết hạn', da_xoa: 'Đã thu hồi' };
  var luocSv = { q: '', tt: '' };

  /** Gửi tệp (multipart) — api() chỉ gửi JSON. Cùng cách xử lý đăng nhập hết hạn và lỗi. */
  function apiTep(url, fd) {
    return fetch(API + url, { method: 'POST', credentials: 'same-origin', body: fd }).then(function (res) {
      if (res.status === 401) { location.href = '/dang-nhap.html?returnUrl=' + encodeURIComponent(location.pathname); return new Promise(function () {}); }
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) { var e = new Error(json.message || 'Lỗi ' + res.status); e.status = res.status; throw e; }
        return json;
      });
    });
  }

  /** Gọi nhập (hoặc xem trước) cho tệp đã chọn hoặc văn bản đã dán. */
  function goiNhapSv(v, xemTruoc) {
    if (v.tep) {
      var fd = new FormData();
      fd.append('tep', v.tep);
      fd.append('het_han', v.het_han);
      if (xemTruoc) fd.append('xem_truoc', '1');
      return apiTep('/students/import-file', fd);
    }
    return api('POST', '/students/import', { text: v.text, het_han: v.het_han, xem_truoc: !!xemTruoc });
  }

  function tomTatNhap(r) {
    var dong = [h('p', {}, (r.xem_truoc ? 'Nếu nhập: ' : 'Đã nhập: ') + r.moi + ' sinh viên mới, ' + r.cap_nhat + ' cập nhật, ' + r.bo_qua + ' bỏ qua. ' + (r.xem_truoc ? 'Sẽ tạo sẵn ' : 'Đã tạo sẵn ') + r.tao_tai_khoan + ' tài khoản chờ kích hoạt.')];
    if (r.co_tieu_de === false) dong.push(h('p', { class: 'nhm-hint' }, 'Không nhận ra dòng tiêu đề: đọc theo thứ tự cột email, họ tên, mã sinh viên, khóa / đợt, hạn dùng.'));
    if (r.dat_lai_crd) dong.push(h('p', { class: 'nhm-hint' }, r.dat_lai_crd + ' tài khoản Đặt lịch cũ trùng email phải kích hoạt lại bằng Đăng ký chính (vì trước đó chưa xác minh hộp thư).'));
    if (r.tai_khoan_khac) dong.push(h('p', { class: 'nhm-muted nhm-small' }, r.tai_khoan_khac + ' email đã có tài khoản vai trò khác: không đổi.'));
    return dong;
  }

  function nhapDanhSachForm(reopen) {
    var tep = h('input', { type: 'file', accept: '.xlsx,.csv', 'aria-label': 'Tệp Excel hoặc CSV' });
    var widget = {
      node: h('div', {}, [
        h('a', { class: 'nhm-link', href: API + '/students/template.xlsx', download: 'mau-danh-sach-sinh-vien.xlsx' }, 'Tải mẫu Excel (.xlsx)'),
        h('p', { class: 'nhm-muted nhm-small' }, 'Điền theo mẫu rồi chọn tệp. Cột được nhận theo TÊN tiêu đề nên không cần đúng thứ tự; tệp của Trung tâm có tiêu đề gần giống (Email, Họ và tên, MSSV, Đợt, Hạn…) thường nhập được luôn.'),
        tep,
      ]),
      get: function () { return tep.files && tep.files[0] ? tep.files[0] : null; },
    };
    openForm({
      title: 'Nhập danh sách sinh viên',
      fields: [
        { name: 'tep', label: 'Tệp Excel (.xlsx) hoặc CSV', type: 'custom', widget: widget },
        { name: 'text', label: '…hoặc dán danh sách (mỗi dòng: email, họ tên, mã sinh viên, khóa / đợt, hạn dùng; dán thẳng từ Excel được)', type: 'textarea' },
        { name: 'het_han', label: 'Hạn dùng mặc định cho dòng không ghi hạn (hết ngày này thì khóa quyền vào module)', type: 'date', required: true },
      ],
      submitLabel: 'Xem trước',
      onSubmit: function (v) {
        if (!v.tep && !String(v.text || '').trim()) return Promise.reject(new Error('Hãy chọn tệp hoặc dán danh sách.'));
        return goiNhapSv(v, true).then(function (r) { setTimeout(function () { xemTruocNhap(v, r, reopen); }, 0); });
      },
    });
  }

  /** Bước xem trước: chưa ghi gì; bấm «Nhập» mới ghi. */
  function xemTruocNhap(v, r, reopen) {
    var mau = r.mau && r.mau.length ? h('table', { class: 'nhm-hist' }, [h('tr', {}, ['Dòng', 'Email', 'Họ tên', 'Đợt', 'Hạn', ''].map(function (x) { return h('th', {}, x); }))].concat(
      r.mau.map(function (m) { return h('tr', {}, [m.dong, m.email, m.fullname, m.khoa || '', m.het_han, m.cap_nhat ? 'cập nhật' : 'mới'].map(function (x, i) { return h('td', { 'data-l': ['Dòng', 'Email', 'Họ tên', 'Đợt', 'Hạn', 'Loại'][i] }, x); })); }))) : null;
    var loi = r.loi && r.loi.length ? h('div', {}, [h('strong', {}, 'Dòng có lỗi (không được nhập): ' + r.loi.length), h('ul', { class: 'nhm-small' }, r.loi.map(function (e) { return h('li', {}, 'Dòng ' + e.dong + ': ' + e.message); }))]) : null;
    var nhap = nutNho('Nhập ' + (r.moi + r.cap_nhat) + ' sinh viên', 'primary', function () {
      nhap.disabled = true;
      goiNhapSv(v, false).then(function (kq) {
        say('Đã nhập danh sách.', 'ok');
        openInfo('Kết quả nhập danh sách', h('div', {}, tomTatNhap(kq)), []);
        var dongNut = document.querySelector('#nhm-dialog .nhm-form-actions .nhm-btn');
        if (dongNut) dongNut.addEventListener('click', reopen);
      }).catch(function (e) { nhap.disabled = false; say(e.message, 'err'); });
    });
    nhap.disabled = !(r.moi + r.cap_nhat);
    openInfo('Xem trước danh sách (chưa ghi gì)', h('div', {}, tomTatNhap(r).concat([mau, loi])), [nhap]);
    var dongNut2 = document.querySelector('#nhm-dialog .nhm-form-actions .nhm-btn:last-child');
    if (dongNut2) dongNut2.addEventListener('click', reopen);
  }

  /** Thao tác cả đợt: gia hạn, đánh dấu ra trường (khóa ngay), thu hồi. */
  function theoDot(body, ds, reopen, err) {
    var dem = {};
    ds.forEach(function (s) { if (s.tinh_trang === 'cho_kich_hoat' || s.tinh_trang === 'da_kich_hoat' || s.tinh_trang === 'het_han') dem[s.khoa || ''] = (dem[s.khoa || ''] || 0) + 1; });
    var dots = Object.keys(dem);
    if (!dots.length) return null;
    var sel = h('select', { 'aria-label': 'Chọn đợt' }, dots.map(function (k) { return h('option', { value: k }, (k || '(không ghi đợt)') + ' — ' + dem[k] + ' sinh viên'); }));
    var chay = function (hanhDong, cauHoi, extra) {
      if (cauHoi && !window.confirm(cauHoi.replace('{dot}', sel.value || '(không ghi đợt)'))) return;
      api('POST', '/students/bulk', Object.assign({ khoa: sel.value, hanh_dong: hanhDong }, extra || {})).then(function (r) { say('Đã xử lý ' + r.so_luong + ' sinh viên.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
    };
    return h('div', { class: 'nhm-card' }, [
      h('strong', {}, 'Thao tác cả đợt'),
      h('p', { class: 'nhm-muted nhm-small' }, 'Dùng khi một đợt sinh viên ra trường hoặc được gia hạn. «Đợt» là cột Khóa / Đợt trong danh sách.'),
      sel,
      h('div', { class: 'nhm-card-act' }, [
        nutNho('Gia hạn cả đợt…', '', function () {
          openForm({
            title: 'Gia hạn cả đợt «' + (sel.value || '(không ghi đợt)') + '»',
            fields: [{ name: 'het_han', label: 'Hạn dùng mới (hết ngày này thì khóa quyền vào module)', type: 'date', required: true }],
            submitLabel: 'Gia hạn',
            onSubmit: function (v) { return api('POST', '/students/bulk', { khoa: sel.value, hanh_dong: 'gia_han', het_han: v.het_han }).then(function (r) { say('Đã gia hạn ' + r.so_luong + ' sinh viên.', 'ok'); reopen(); }); },
          });
        }),
        nutNho('Đợt đã ra trường', 'danger', function () { chay('ra_truong', 'Đánh dấu đợt «{dot}» đã ra trường? Họ mất quyền vào Ngân hàng tế bào ngay (Đặt lịch thiết bị vẫn dùng được); yêu cầu về mẫu của họ chuyển cho trưởng nhóm / quản lý.'); }),
        nutNho('Thu hồi cả đợt', 'danger', function () { chay('thu_hoi', 'Thu hồi quyền của cả đợt «{dot}»? Muốn cấp lại phải nhập lại danh sách.'); }),
      ]),
    ]);
  }

  function suaSinhVienForm(s, reopen) {
    openForm({
      title: 'Sửa / gia hạn: ' + s.fullname,
      fields: [
        { name: 'fullname', label: 'Họ tên', required: true, value: s.fullname },
        { name: 'het_han', label: 'Hạn dùng (hết ngày này thì khóa quyền vào module)', type: 'date', required: true, value: s.het_han },
        { name: 'ma_sv', label: 'Mã sinh viên', value: s.ma_sv },
        { name: 'khoa', label: 'Khóa / đợt', value: s.khoa },
        { name: 'ghi_chu', label: 'Ghi chú', type: 'textarea', value: s.ghi_chu },
      ],
      onSubmit: function (v) { return api('PATCH', '/students/' + s.id, v).then(function () { say('Đã lưu.', 'ok'); reopen(); }); },
    });
  }

  function tabSinhVien(body, reopen) {
    var qs = [];
    if (luocSv.q) qs.push('q=' + encodeURIComponent(luocSv.q));
    if (luocSv.tt) qs.push('tinh_trang=' + luocSv.tt);
    api('GET', '/students' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
      var err = h('div', { class: 'nhm-err' });
      var dem = {};
      r.students.forEach(function (s) { dem[s.tinh_trang] = (dem[s.tinh_trang] || 0) + 1; });
      var tim = h('input', { type: 'search', placeholder: 'Tìm theo email, tên, mã sinh viên, khóa…', 'aria-label': 'Tìm sinh viên' }); tim.value = luocSv.q;
      var loc = h('select', { 'aria-label': 'Lọc tình trạng' }, [h('option', { value: '' }, 'Mọi tình trạng')].concat(Object.keys(TINH_TRANG_SV).map(function (k) { return h('option', { value: k }, TINH_TRANG_SV[k]); }))); loc.value = luocSv.tt;
      var ap = function () { luocSv.q = tim.value.trim(); luocSv.tt = loc.value; reopen(); };
      tim.addEventListener('keydown', function (e) { if (e.key === 'Enter') ap(); });
      loc.addEventListener('change', ap);
      var cards = r.students.map(function (s) {
        var chipCls = 'nhm-chip' + (s.tinh_trang === 'het_han' || s.tinh_trang === 'da_xoa' ? ' nhm-chip--warn' : '');
        var nut = [nutNho('Gia hạn / sửa', '', function () { suaSinhVienForm(s, reopen); })];
        if (s.tinh_trang !== 'da_xoa') nut.push(nutNho('Thu hồi', 'danger', function () {
          if (window.confirm('Thu hồi quyền của ' + s.fullname + '? Họ không vào được module này nữa (Đặt lịch thiết bị vẫn dùng được).')) api('DELETE', '/students/' + s.id).then(reopen).catch(function (e) { err.textContent = e.message; });
        }));
        return h('div', { class: 'nhm-card' + (s.tinh_trang === 'het_han' || s.tinh_trang === 'da_xoa' ? ' nhm-card--roi' : '') }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, s.fullname), h('span', { class: chipCls }, TINH_TRANG_SV[s.tinh_trang])]),
          h('div', { class: 'nhm-small nhm-muted' }, s.email + (s.ma_sv ? ' · ' + s.ma_sv : '') + (s.khoa ? ' · ' + s.khoa : '') + (s.nhom_ten ? ' · nhóm ' + s.nhom_ten : '')),
          h('div', { class: 'nhm-small' }, 'Hạn dùng: hết ngày ' + s.het_han.split('-').reverse().join('/')),
          h('div', { class: 'nhm-card-act' }, nut),
        ]);
      });
      put(body, h('div', {}, [
        h('div', { class: 'nhm-dm-head' }, [h('strong', {}, 'Sinh viên của Viện (' + r.students.length + ')'), nutNho('+ Nhập danh sách', 'primary', function () { nhapDanhSachForm(reopen); })]),
        h('p', { class: 'nhm-muted nhm-small' }, 'Danh sách do Trung tâm quản lý người học cung cấp. Chỉ email trong danh sách mới đăng ký được tài khoản sinh viên (sau khi xác minh hộp thư). Đã kích hoạt: ' + (dem.da_kich_hoat || 0) + ' · chờ: ' + (dem.cho_kich_hoat || 0) + ' · hết hạn: ' + (dem.het_han || 0) + '. Danh sách là dữ liệu cá nhân: chỉ Admin và quản lý module xem.'),
        theoDot(body, r.students, reopen, err),
        h('div', { class: 'nhm-searchbar' }, [tim, loc, nutNho('Lọc', '', ap)]),
        r.students.length ? h('div', { class: 'nhm-cards' }, cards) : h('p', { class: 'nhm-muted' }, 'Chưa có sinh viên nào khớp.'),
        err]));
    }).catch(loiTrongSlot(body));
  }

  /** Các hạn chờ: người duyệt phản hồi, bỏ mẫu chưa khai báo, chốt thất lạc. */
  function tabCauHinh(body, reopen) {
    api('GET', '/settings').then(function (r) {
      var err = h('div', { class: 'nhm-err' });
      var o = {};
      var hang = Object.keys(r.han).map(function (k) {
        var inp = h('input', { type: 'number', min: String(r.gioi_han[k][0]), max: String(r.gioi_han[k][1]), step: '1', 'aria-label': r.nhan[k] });
        inp.value = r.han[k];
        o[k] = inp;
        return h('div', { class: 'nhm-field' }, [
          h('span', { class: 'nhm-lbl' }, r.nhan[k]),
          h('div', { class: 'nhm-han' }, [inp, h('span', {}, 'ngày'), h('span', { class: 'nhm-muted nhm-small' }, 'từ ' + r.gioi_han[k][0] + ' đến ' + r.gioi_han[k][1] + ' · mặc định ' + r.mac_dinh[k])]),
        ]);
      });
      var luu = function (giaTri) {
        api('PUT', '/settings', giaTri).then(function (x) { state.meta.han = x.han; say(x.changed ? 'Đã lưu các hạn.' : 'Không có gì thay đổi.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
      };
      put(body, h('div', {}, [
        h('strong', {}, 'Các hạn chờ'),
        h('p', { class: 'nhm-muted nhm-small' }, 'Hạn mới áp dụng cho yêu cầu và vụ việc tạo SAU khi lưu; yêu cầu và vụ việc đang chạy giữ hạn đã ghi. Riêng hạn bỏ mẫu chưa khai báo được tính lúc xem nên đổi là áp dụng ngay cho mọi mục đang chờ.'),
      ].concat(hang, [
        err,
        h('div', { class: 'nhm-card-act' }, [
          nutNho('Lưu', 'primary', function () { var g = {}; Object.keys(o).forEach(function (k) { g[k] = o[k].value; }); luu(g); }),
          nutNho('Khôi phục mặc định', '', function () { luu(r.mac_dinh); }),
        ]),
      ])));
    }).catch(loiTrongSlot(body));
  }

  // ----- đơn vị quản lý thiết bị: thiết bị gắn đơn vị thì yêu cầu lấy mẫu do người duyệt của đơn vị quyết định -----
  function tabDonVi(body, reopen) {
    var laAdmin = !!(state.me && state.me.laAdmin);
    api('GET', '/units').then(function (r) {
      state.meta.donVi = r.units.map(function (u) { return { id: u.id, ten: u.ten }; });
      var err = h('div', { class: 'nhm-err' });
      var luu = function (u, ds) {
        return api('PATCH', '/units/' + u.id, { nguoi_duyet: ds.map(function (x) { return x.user_id; }) }).then(function () { say('Đã lưu người duyệt.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
      };
      var cards = r.units.map(function (u) {
        var chips = u.nguoi_duyet.map(function (x) {
          return h('span', { class: 'nhm-chip' }, [x.ten, laAdmin ? h('button', { type: 'button', 'aria-label': 'Bỏ ' + x.ten, onclick: function () { luu(u, u.nguoi_duyet.filter(function (y) { return y.user_id !== x.user_id; })); } }, '×') : null]);
        }).concat(u.nguoi_theo_vai_tro.map(function (x) { return h('span', { class: 'nhm-chip nhm-chip--vt' }, x.ten + ' (Trưởng CIPP)'); }));
        var them = null;
        if (laAdmin) {
          var nguoi = chonNguoi({ label: 'Thêm người duyệt cho ' + u.ten, placeholder: 'Gõ tên hoặc email người duyệt…' });
          them = h('div', { class: 'nhm-addrole' }, [nguoi.node, nutNho('Thêm người duyệt', '', function () {
            var x = nguoi.get();
            if (!x) { err.textContent = 'Chọn người dùng.'; return; }
            if (u.nguoi_duyet.some(function (y) { return y.user_id === x.id; })) { err.textContent = 'Người này đã là người duyệt.'; return; }
            luu(u, u.nguoi_duyet.concat([{ user_id: x.id }]));
          })]);
        }
        var act = laAdmin ? h('div', { class: 'nhm-card-act' }, [
          nutNho('Sửa tên / mô tả', '', function () { donViForm(u, reopen); }),
          u.mac_dinh ? null : nutNho('Xóa', 'danger', function () {
            if (!window.confirm('Xóa đơn vị «' + u.ten + '»?')) return;
            api('DELETE', '/units/' + u.id).then(function () { reopen(); }).catch(function (e) { err.textContent = e.message; });
          }),
        ]) : null;
        return h('div', { class: 'nhm-card' }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, u.ten), h('span', { class: 'nhm-chip' }, u.so_thiet_bi + ' thiết bị')]),
          u.mo_ta ? h('div', { class: 'nhm-small nhm-muted' }, u.mo_ta) : null,
          h('div', { class: 'nhm-lbl nhm-small' }, 'Người duyệt yêu cầu lấy mẫu'),
          chips.length ? h('div', { class: 'nhm-chips' }, chips) : h('p', { class: 'nhm-hint' }, 'Chưa có người duyệt: yêu cầu sẽ chuyển thẳng cho quản lý module.'),
          them, act,
        ]);
      });
      put(body, h('div', {}, [
        h('div', { class: 'nhm-dm-head' }, [h('strong', {}, 'Đơn vị quản lý thiết bị (' + r.units.length + ')'), laAdmin ? nutNho('+ Thêm đơn vị', 'primary', function () { donViForm(null, reopen); }) : null]),
        h('p', { class: 'nhm-muted nhm-small' }, 'Thiết bị gắn với một đơn vị (chọn ở Thêm / Chỉnh sửa thiết bị) thì người dùng không tự thêm hay lấy mẫu mà gửi yêu cầu; người duyệt của đơn vị quyết định. Thiết bị không gắn đơn vị là Public: chủ mẫu, rồi trưởng nhóm, rồi quản lý module duyệt. ' + (laAdmin ? '' : 'Chỉ Admin thêm, sửa đơn vị và gán người duyệt.')),
        h('div', { class: 'nhm-cards' }, cards), err]));
    }).catch(loiTrongSlot(body));
  }

  function donViForm(u, reopen) {
    openForm({
      title: u ? 'Sửa đơn vị «' + u.ten + '»' : 'Thêm đơn vị quản lý',
      fields: [
        { name: 'ten', label: 'Tên đơn vị', required: true, value: u && u.ten },
        { name: 'mo_ta', label: 'Mô tả (đơn vị quản lý những thiết bị nào…)', type: 'textarea', value: u && u.mo_ta },
      ],
      onSubmit: function (v) {
        var p = u ? api('PATCH', '/units/' + u.id, { ten: v.ten, mo_ta: v.mo_ta }) : api('POST', '/units', { ten: v.ten, mo_ta: v.mo_ta });
        return p.then(function () { say(u ? 'Đã lưu đơn vị.' : 'Đã thêm đơn vị. Hãy thêm người duyệt.', 'ok'); reopen(); });
      },
    });
  }

  function quanTriDialog(tab) {
    tab = tab || 'danhmuc';
    var tabs = [['danhmuc', 'Danh mục', tabDanhMuc], ['nhom', 'Nhóm nghiên cứu', tabNhom], ['thanhvien', 'Thành viên', tabThanhVien], ['sinhvien', 'Sinh viên', tabSinhVien], ['donvi', 'Đơn vị quản lý', tabDonVi], ['cauhinh', 'Cấu hình hạn', tabCauHinh]];
    if (state.me && state.me.laAdmin) tabs.push(['vaitro', 'Vai trò', tabVaiTro]);
    var body = h('div', { class: 'nhm-tabbody' }, h('div', { class: 'nhm-loading' }, 'Đang tải…'));
    var bar = h('div', { class: 'nhm-tabs', role: 'tablist' }, tabs.map(function (t) {
      return h('button', { type: 'button', role: 'tab', class: 'nhm-tab' + (t[0] === tab ? ' nhm-tab--on' : ''), 'aria-selected': String(t[0] === tab), onclick: function () { quanTriDialog(t[0]); } }, t[1]);
    }));
    openInfo('Quản lý module', h('div', {}, [bar, body]), []);
    var reopen = function () { setTimeout(function () { taiNhom().then(function () { quanTriDialog(tab); }); }, 0); };
    tabs.filter(function (t) { return t[0] === tab; })[0][2](body, reopen);
  }

  // ---------- thông báo: bạn được ghi là trưởng nhóm ----------
  function renderBanner() {
    var slot = $('nhm-banner');
    var ds = (state.me && state.me.nhomChoXacNhan) || [];
    var sv = state.me && state.me.sinhVien;
    var conNgay = sv ? Math.ceil((new Date(sv.het_han + 'T23:59:59+07:00').getTime() - Date.now()) / 86400000) : null;
    var thongBaoHan = sv && conNgay <= 30 ? h('div', { class: 'nhm-hint', role: 'status' }, 'Quyền vào Ngân hàng tế bào & Kháng thể của tài khoản sinh viên đến hết ngày ' + sv.het_han.split('-').reverse().join('/') + ' (còn ' + Math.max(conNgay, 0) + ' ngày). Cần gia hạn thì liên hệ quản lý module.') : null;
    put(slot, thongBaoHan, ds.length ? h('div', { class: 'nhm-notice', role: 'alert' }, ds.map(function (g) {
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

  // ---------- yêu cầu lấy mẫu, mẫu chưa khai báo, mẫu nghi mất ----------
  function taiMe() {
    return api('GET', '/me').then(function (m) { state.me = m; capNhatHuy(); return m; });
  }

  /** Số việc chờ trên nút «Việc cần xử lý»: yêu cầu cần tôi xử lý + mẫu chưa khai báo + mẫu nghi mất đang mở. */
  function capNhatHuy() {
    var me = state.me;
    var n = me ? me.yeuCau.inbox + me.phatHienMo + me.vuViecMo : 0;
    var b = $('nhm-work-badge');
    if (b) {
      b.textContent = n ? String(n) : '';
      b.classList.toggle('nhm-hide', !n);
      b.setAttribute('aria-label', n ? n + ' việc cần xử lý' : '');
    }
    var nut = $('nhm-work');
    if (nut) nut.classList.toggle('nhm-viec--canh', n > 0); // có việc thì cả nút đổi sang màu cảnh báo
    renderBanner();
  }

  /** Sau một thao tác ở bảng công việc: nạp lại số đếm và danh sách (và hộp đang mở nếu có). */
  function lamMoiCv() {
    return taiMe().then(function () { return state.cv ? taiCv() : reload(true); });
  }

  function xinMauForm(t) {
    openForm({
      title: 'Xin lấy mẫu: ' + t.name,
      fields: [{ name: 'ly_do', label: 'Lý do / mục đích sử dụng', type: 'textarea', required: true }],
      submitLabel: 'Gửi yêu cầu',
      onSubmit: function (v) {
        return api('POST', '/tubes/' + t.id + '/requests', { ly_do: v.ly_do }).then(function (r) {
          say('Đã gửi yêu cầu tới ' + r.cap_ten + '. Nếu quá ' + gioDia(r.han_phan_hoi) + ' chưa ai phản hồi, yêu cầu sẽ chuyển cho quản lý module. Theo dõi ở «Việc cần xử lý».', 'ok');
          return taiMe();
        });
      },
    });
  }

  function baoMatForm(t) {
    openForm({
      title: 'Báo mẫu không còn ở vị trí: ' + t.name,
      fields: [{ name: 'mo_ta', label: 'Ghi chú (đã tìm ở đâu, lần cuối thấy khi nào…)', type: 'textarea' }],
      submitLabel: 'Báo mất',
      onSubmit: function (v) {
        return api('POST', '/tubes/' + t.id + '/report-missing', { mo_ta: v.mo_ta }).then(function () {
          say('Đã báo. Chủ mẫu, trưởng nhóm và quản lý đã được thông báo; ai đã lấy mẫu có thể tự nhận.', 'ok');
          return reload(true).then(taiMe);
        });
      },
    });
  }

  function dongYForm(y, ketQua) {
    var tuChoi = ketQua === 'reject';
    openForm({
      title: (tuChoi ? 'Từ chối' : 'Duyệt') + ' yêu cầu: ' + y.mau_ten,
      fields: [{
        name: 'ly_do', type: 'textarea', required: tuChoi || y.can_ly_do,
        label: tuChoi ? 'Lý do từ chối (người xin sẽ đọc được)' : y.can_ly_do ? 'Lý do xử lý thay ' + y.cap_ten + ' (bắt buộc, ghi vào lịch sử)' : 'Ghi chú (không bắt buộc)',
      }],
      submitLabel: tuChoi ? 'Từ chối' : 'Duyệt',
      onSubmit: function (v) { return api('POST', '/requests/' + y.id + '/' + ketQua, { ly_do: v.ly_do }).then(function () { say(tuChoi ? 'Đã từ chối.' : 'Đã duyệt. Người xin và quản lý module đã được thông báo.', 'ok'); return lamMoiCv(); }); },
    });
  }

  function hoiRoiLam(cauHoi, fn) { if (window.confirm(cauHoi)) fn().then(lamMoiCv).catch(function (e) { say(e.message, 'err'); }); }

  /** Thẻ một yêu cầu. */
  function theYeuCau(y) {
    var trangThai = { cho_duyet: 'Chờ ' + y.cap_ten + ' duyệt', da_duyet: 'Đã duyệt — chờ quản lý giao mẫu', tu_choi: 'Bị từ chối', da_giao: 'Đã giao cho người xin', da_tra: 'Đã trả', da_huy: 'Đã hủy' }[y.trang_thai] || y.trang_thai;
    var nut = [];
    if (y.co_the_xu_ly) {
      nut.push(nutNho('Duyệt', 'primary', function () { dongYForm(y, 'approve'); }));
      nut.push(nutNho('Từ chối', '', function () { dongYForm(y, 'reject'); }));
    }
    if (y.co_the_giao) nut.push(nutNho('Giao mẫu', 'primary', function () { hoiRoiLam('Giao mẫu «' + y.mau_ten + '» cho ' + y.nguoi_gui_ten + '? Mẫu chuyển sang «đã lấy ra».', function () { return api('POST', '/requests/' + y.id + '/deliver'); }); }));
    if (y.co_the_nhan_lai) nut.push(nutNho('Nhận lại mẫu', 'primary', function () { hoiRoiLam('Ghi nhận đã nhận lại mẫu «' + y.mau_ten + '» vào kho?', function () { return api('POST', '/requests/' + y.id + '/return'); }); }));
    if (y.co_the_huy) nut.push(nutNho('Hủy yêu cầu', 'danger', function () { hoiRoiLam('Hủy yêu cầu này?', function () { return api('POST', '/requests/' + y.id + '/cancel'); }); }));
    nut.push(nutNho('Xem mẫu', '', function () { moMauTheoId(y.tube_id); }));
    // phiếu in được (kèm kết quả duyệt) cho người gửi, người đã xử lý, người duyệt và quản lý
    if (y.co_the_in) nut.push(nutNho('In phiếu', '', function () { window.open(API + '/requests/' + y.id + '/print', '_blank', 'noopener'); }));
    return h('div', { class: 'nhm-card' }, [
      h('div', { class: 'nhm-card-top' }, [h('strong', {}, y.mau_ten), h('span', { class: 'nhm-chip' }, trangThai)]),
      h('div', { class: 'nhm-small' }, y.nguoi_gui_ten + ' xin lấy · ' + y.vi_tri),
      y.ly_do ? h('div', { class: 'nhm-small' }, 'Lý do: ' + y.ly_do) : null,
      h('div', { class: 'nhm-small nhm-muted' }, 'Chủ mẫu: ' + (y.chu_ten || '—') + (y.nhom_ten ? ' · nhóm ' + y.nhom_ten : '') + (y.trang_thai === 'cho_duyet' ? ' · hạn phản hồi ' + gioDia(y.han_phan_hoi) : '')),
      y.leo_thang_luc ? h('div', { class: 'nhm-small nhm-muted' }, 'Đã chuyển quản lý module lúc ' + gioDia(y.leo_thang_luc) + ' (quá hạn phản hồi).') : null,
      y.xu_ly_ten && y.trang_thai !== 'cho_duyet' ? h('div', { class: 'nhm-small nhm-muted' }, 'Xử lý bởi ' + y.xu_ly_ten + ' lúc ' + gioDia(y.xu_ly_luc) + (y.xu_ly_thay ? ' (xử lý thay)' : '') + (y.ly_do_xu_ly ? ': ' + y.ly_do_xu_ly : '')) : null,
      h('div', { class: 'nhm-card-act' }, nut),
    ]);
  }

  /** Mở mẫu theo id (từ bảng công việc): tìm vị trí rồi mở hộp + hộp thoại. */
  function moMauTheoId(id) {
    api('GET', '/tubes/search?status=all&id=' + id).then(function (r) {
      var it = r.items.filter(function (x) { return x.id === id; })[0];
      if (it) { state.cv = null; moMauTuKetQua(it); } else say('Không tìm thấy mẫu.', 'err');
    }).catch(function (e) { say(e.message, 'err'); });
  }

  // ----- mẫu chưa khai báo -----
  function phatHienForm(box, r, c) {
    var nguoi = chonNguoi({ label: 'Người có thể là chủ mẫu' });
    var nhomOpts = [{ value: '', label: '— chưa biết —' }].concat((state.groups || []).map(function (g) { return { value: g.id, label: g.ten }; }));
    openForm({
      title: 'Ô ' + posLabel(r, c) + ' có mẫu chưa khai báo',
      fields: [
        { name: 'mo_ta', label: 'Mô tả mẫu (chữ viết trên ống, màu nắp, kiểu hộp con…)', type: 'textarea', required: true },
        { name: 'nguoi', label: 'Người có thể là chủ mẫu (nếu đoán được)', type: 'custom', widget: nguoi },
        { name: 'nhom_id', label: 'Hoặc nhóm có thể là chủ mẫu', type: 'select', options: nhomOpts },
      ],
      submitLabel: 'Đánh dấu ô',
      onSubmit: function (v) {
        return api('POST', '/findings', { box_id: box.id, row_no: r, col_no: c, mo_ta: v.mo_ta, nghi_user_id: v.nguoi ? v.nguoi.id : null, nghi_nhom_id: v.nhom_id === '' ? null : Number(v.nhom_id) })
          .then(function () { say('Đã đánh dấu. Việc tiếp theo: bấm vào ô và «Nhắc chủ mẫu».', 'ok'); return reload(true).then(taiMe); });
      },
    });
  }

  /** Các nút xử lý một mục «mẫu chưa khai báo» (dùng ở thẻ và ở hộp thoại). `xong` chạy sau khi thao tác thành công. */
  function nutPhatHien(ph, box, xong) {
    var nut = [nutNho('Đây là mẫu của tôi', 'primary', function () {
      var b = box || { id: ph.box_id };
      tubeForm(b, ph.row_no, ph.col_no, null, { claimId: ph.id });
    })];
    if (state.meta.canManage) {
      nut.push(nutNho('Nhắc chủ mẫu', '', function () {
        api('POST', '/findings/' + ph.id + '/remind').then(function (r) {
          say('Đã nhắc lần ' + r.nhac_lan + (r.nguoi_nhan ? ' (email tới ' + r.nguoi_nhan + ' người)' : ' (chưa biết chủ mẫu: nhắc trên bảng chung)') + '. Được bỏ mẫu từ ' + gioDia(r.han_bo) + '.', 'ok');
          return xong();
        }).catch(function (e) { say(e.message, 'err'); });
      }));
      nut.push(nutNho('Bỏ mẫu', 'danger', function () {
        if (!ph.nhac_lan) { say('Việc đầu tiên là nhắc chủ mẫu cập nhật thông tin: bấm «Nhắc chủ mẫu» trước.', 'err'); return; }
        openForm({
          title: 'Bỏ mẫu chưa khai báo tại ' + ph.vi_tri,
          fields: [{ name: 'ly_do', label: 'Lý do bỏ mẫu' + (ph.co_the_bo ? '' : ' (chưa hết hạn chờ — chỉ admin bỏ sớm được)'), type: 'textarea', required: true }],
          submitLabel: 'Bỏ mẫu',
          onSubmit: function (v) { return api('POST', '/findings/' + ph.id + '/discard', { ly_do: v.ly_do }).then(function () { say('Đã ghi nhận bỏ mẫu.', 'ok'); return xong(); }); },
        });
      }));
      nut.push(nutNho('Đánh dấu nhầm', '', function () {
        if (window.confirm('Hủy đánh dấu ô này (đánh dấu nhầm)?')) api('POST', '/findings/' + ph.id + '/cancel', { ly_do: 'Đánh dấu nhầm' }).then(xong).catch(function (e) { say(e.message, 'err'); });
      }));
    }
    return nut;
  }

  function phatHienDialog(box, id) {
    api('GET', '/findings/' + id).then(function (r) {
      var ph = r.finding;
      var xong = function () { closeDialog(); return reload(true).then(taiMe); };
      var body = h('div', {}, [
        h('div', { class: 'nhm-facts' }, [
          fact('Vị trí', ph.vi_tri), fact('Mô tả mẫu', ph.mo_ta), fact('Có thể là của', ph.nghi_ten || ph.nghi_nhom_ten || 'chưa biết'),
          fact('Đã nhắc', ph.nhac_lan ? ph.nhac_lan + ' lần (đầu tiên ' + gioDia(ph.nhac_dau_luc) + ')' : 'chưa nhắc'),
          fact('Được bỏ mẫu từ', ph.han_bo ? gioDia(ph.han_bo) : 'sau khi đã nhắc + ' + (state.meta.han ? state.meta.han.CHO_BO_NGAY : 7) + ' ngày'), fact('Phát hiện bởi', ph.phat_hien_ten),
        ]),
        h('p', { class: 'nhm-hint' }, 'Mẫu này đang nằm trong ô nhưng chưa có thông tin trong hệ thống. Nếu là mẫu của bạn hoặc của nhóm bạn, hãy bấm «Đây là mẫu của tôi» và điền thông tin.'),
        h('strong', {}, 'Lịch sử'),
        h('table', { class: 'nhm-hist' }, [h('tr', {}, ['Thời gian', 'Hành động', 'Ghi chú', 'Người thực hiện'].map(function (x) { return h('th', {}, x); }))]
          .concat(r.history.map(function (x) {
            return h('tr', {}, [gioDia(x.at), PH_ACTION_VN[x.action] || x.action, x.note || '', x.user_label || ''].map(function (v, i) { return h('td', { 'data-l': ['Thời gian', 'Hành động', 'Ghi chú', 'Người'][i] }, v); }));
          }))),
      ]);
      openInfo('Mẫu chưa khai báo', body, nutPhatHien(ph, box, xong));
    }).catch(function (e) { say(e.message, 'err'); });
  }
  var PH_ACTION_VN = { phat_hien: 'Phát hiện', nhac: 'Nhắc chủ mẫu', da_khai_bao: 'Chủ mẫu đã khai báo', da_bo: 'Bỏ mẫu', da_bo_som: 'Bỏ mẫu sớm (admin)', da_huy: 'Hủy đánh dấu' };

  function theMauChuaKhaiBao(ph) {
    return h('div', { class: 'nhm-card nhm-card--vang' }, [
      h('div', { class: 'nhm-card-top' }, [h('strong', {}, ph.vi_tri), h('span', { class: 'nhm-chip nhm-chip--warn' }, ph.nhac_lan ? 'Đã nhắc ' + ph.nhac_lan + ' lần' : 'Chưa nhắc')]),
      h('div', { class: 'nhm-small' }, 'Mô tả: ' + ph.mo_ta),
      h('div', { class: 'nhm-small nhm-muted' }, 'Có thể là của: ' + (ph.nghi_ten || ph.nghi_nhom_ten || 'chưa biết') + (ph.han_bo ? ' · quản lý được bỏ mẫu từ ' + gioDia(ph.han_bo) : '')),
      h('div', { class: 'nhm-card-act' }, [nutNho('Xem ô', '', function () { state.cv = null; select('box', ph.box_id); })].concat(nutPhatHien(ph, null, lamMoiCv))),
    ]);
  }

  // ----- mẫu nghi mất -----
  var VV_TT = { mo: 'Đang tìm', cho_chu_xac_nhan: 'Có người nhận đã lấy — chờ chủ mẫu xác nhận', da_xac_nhan_lay: 'Đã xác nhận người lấy', da_tim_thay: 'Đã tìm thấy', that_lac: 'Thất lạc', da_huy: 'Báo nhầm' };
  function theNghiMat(v) {
    var nut = [];
    if (v.co_the_nhan_lay) nut.push(nutNho('Tôi đã lấy mẫu này', 'primary', function () {
      openForm({
        title: 'Tôi đã lấy mẫu: ' + v.mau_ten,
        fields: [{ name: 'ghi_chu', label: 'Ghi chú (lấy khi nào, để làm gì…)', type: 'textarea' }],
        submitLabel: 'Xác nhận tôi đã lấy',
        onSubmit: function (f) { return api('POST', '/incidents/' + v.id + '/taken', { ghi_chu: f.ghi_chu }).then(function () { say('Đã ghi nhận. Chủ mẫu sẽ xác nhận.', 'ok'); return lamMoiCv(); }); },
      });
    }));
    if (v.co_the_xac_nhan) {
      nut.push(nutNho('Đúng, người này đã lấy', 'primary', function () { hoiRoiLam('Xác nhận ' + v.nguoi_nhan_ten + ' đã lấy mẫu không qua yêu cầu? Mẫu chuyển sang «đã lấy ra» và tính một lần lấy không xin phép.', function () { return api('POST', '/incidents/' + v.id + '/confirm'); }); }));
      nut.push(nutNho('Không đúng', '', function () { hoiRoiLam('Không đồng ý lời nhận này? Vụ việc mở lại.', function () { return api('POST', '/incidents/' + v.id + '/reject', {}); }); }));
    }
    if (v.co_the_tu_lay) nut.push(nutNho('Chính tôi đã lấy mẫu này', 'primary', function () {
      openForm({
        title: 'Tôi đã tự lấy mẫu: ' + v.mau_ten,
        fields: [{ name: 'note', label: 'Mục đích bạn đã lấy mẫu (bắt buộc — sẽ ghi vào lịch sử mẫu)', type: 'textarea', required: true }],
        submitLabel: 'Ghi nhận',
        onSubmit: function (f) { return api('POST', '/incidents/' + v.id + '/self-taken', { note: f.note }).then(function () { say('Đã ghi nhận bạn tự lấy mẫu. Mẫu chuyển sang «đã lấy ra».', 'ok'); return lamMoiCv(); }); },
      });
    }));
    if (v.co_the_tim_thay) nut.push(nutNho('Đã tìm thấy mẫu', '', function () { hoiRoiLam('Đóng vụ việc vì đã tìm thấy mẫu?', function () { return api('POST', '/incidents/' + v.id + '/found'); }); }));
    if (v.co_the_chot_that_lac) nut.push(nutNho('Chốt thất lạc', 'danger', function () {
      openForm({
        title: 'Chốt thất lạc: ' + v.mau_ten,
        fields: [{ name: 'ly_do', label: 'Lý do chốt thất lạc', type: 'textarea', required: true }],
        submitLabel: 'Chốt thất lạc',
        onSubmit: function (f) { return api('POST', '/incidents/' + v.id + '/lost', { ly_do: f.ly_do }).then(function () { say('Đã chốt thất lạc.', 'ok'); return lamMoiCv(); }); },
      });
    }));
    nut.push(nutNho('Xem mẫu', '', function () { moMauTheoId(v.tube_id); }));
    return h('div', { class: 'nhm-card nhm-card--vang' }, [
      h('div', { class: 'nhm-card-top' }, [h('strong', {}, v.mau_ten), h('span', { class: 'nhm-chip nhm-chip--warn' }, VV_TT[v.trang_thai] || v.trang_thai)]),
      h('div', { class: 'nhm-small' }, v.vi_tri + ' · chủ mẫu ' + (v.chu_ten || '—')),
      v.mo_ta ? h('div', { class: 'nhm-small' }, v.mo_ta) : null,
      v.nguoi_nhan_ten ? h('div', { class: 'nhm-small' }, v.nguoi_nhan_ten + ' cho biết đã lấy' + (v.nhan_ghi_chu ? ': ' + v.nhan_ghi_chu : '')) : null,
      h('div', { class: 'nhm-small nhm-muted' }, 'Báo bởi ' + v.nguoi_bao_ten + ' lúc ' + gioDia(v.created_at) + ' · chốt thất lạc được từ ' + gioDia(v.han_nhan)),
      h('div', { class: 'nhm-card-act' }, nut),
    ]);
  }

  // ----- bảng «Việc cần xử lý» -----
  function moCongViec(tab) {
    state.search = null; state.sel = null; state.box = null; state.audit = null;
    state.cv = { tab: tab || 'inbox', data: null };
    if (location.hash !== '#cong-viec') location.hash = 'cong-viec';
    renderTree();
    renderDetail();
    taiCv();
    var rail = $('nhm-rail'); if (rail && window.matchMedia('(max-width: 900px)').matches) rail.open = false;
  }

  function taiCv() {
    var c = state.cv; if (!c) return Promise.resolve();
    var url = { inbox: '/requests?view=inbox', mine: '/requests?view=mine', done: '/requests?view=done', all: '/requests?view=all', phathien: '/findings', nghimat: '/incidents', vipham: '/violations' }[c.tab];
    return api('GET', url).then(function (r) {
      if (state.cv !== c) return;
      c.data = r.requests || r.findings || r.incidents || r.violations || [];
      renderDetail();
    }).catch(function (e) { say(e.message, 'err'); });
  }

  function renderCongViec(root) {
    var c = state.cv, me = state.me || { yeuCau: { inbox: 0, mine: 0 }, phatHienMo: 0, vuViecMo: 0 };
    var tabs = [['inbox', 'Cần tôi xử lý', me.yeuCau.inbox], ['mine', 'Yêu cầu của tôi', me.yeuCau.mine], ['done', 'Lịch sử xử lý', 0], ['phathien', 'Mẫu chưa khai báo', me.phatHienMo], ['nghimat', 'Mẫu nghi mất', me.vuViecMo]];
    if (state.meta.canManage) tabs.push(['all', 'Tất cả yêu cầu', 0], ['vipham', 'Lấy không xin phép', 0]);
    var bar = h('div', { class: 'nhm-tabs', role: 'tablist' }, tabs.map(function (t) {
      return h('button', { type: 'button', role: 'tab', class: 'nhm-tab' + (t[0] === c.tab ? ' nhm-tab--on' : ''), 'aria-selected': String(t[0] === c.tab), onclick: function () { moCongViec(t[0]); } },
        [t[1], t[2] ? h('span', { class: 'nhm-count' }, String(t[2])) : null]);
    }));
    var noiDung;
    if (!c.data) noiDung = h('div', { class: 'nhm-loading' }, 'Đang tải…');
    else if (c.tab === 'vipham') {
      noiDung = c.data.length ? h('div', { class: 'nhm-cards' }, c.data.map(function (x) {
        return h('div', { class: 'nhm-card' }, [h('div', { class: 'nhm-card-top' }, [h('strong', {}, x.ten), h('span', { class: 'nhm-chip nhm-chip--warn' }, x.so_lan + ' lần')]),
          h('div', { class: 'nhm-small nhm-muted' }, (x.nhom_ten ? 'Nhóm ' + x.nhom_ten + ' · ' : '') + 'gần nhất ' + gioDia(x.gan_nhat))]);
      })) : h('p', { class: 'nhm-muted' }, 'Chưa có trường hợp lấy mẫu không xin phép nào được chủ mẫu xác nhận.');
    } else if (!c.data.length) noiDung = h('p', { class: 'nhm-muted' }, { inbox: 'Không có yêu cầu nào đang chờ bạn xử lý.', mine: 'Bạn chưa gửi yêu cầu nào.', done: 'Chưa có yêu cầu nào đã được xử lý. Yêu cầu đã duyệt hoặc từ chối sẽ được lưu ở đây (quản lý module thấy tất cả).', phathien: 'Không có mẫu nào đang chờ chủ mẫu khai báo.', nghimat: 'Không có mẫu nào đang bị báo nghi mất.', all: 'Chưa có yêu cầu nào.' }[c.tab]);
    else noiDung = h('div', { class: 'nhm-cards' }, c.data.map(c.tab === 'phathien' ? theMauChuaKhaiBao : c.tab === 'nghimat' ? theNghiMat : theYeuCau));
    put(root, h('div', { class: 'nhm-title' }, [h('h2', {}, 'Việc cần xử lý')]), bar, noiDung);
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
    }).then(function () {
      $('nhm-work').addEventListener('click', function () { moCongViec('inbox'); });
      renderTree(); renderDetail(); capNhatHuy();
      if (location.hash === '#cong-viec') moCongViec('inbox');
      else if (state.sel) manHinhHep(false); // mở thẳng một hộp / vị trí: điện thoại gập sơ đồ lại để thấy nội dung
    }).catch(function (e) {
      $('nhm-tree').textContent = '';
      say(e.message, 'err');
    });
  }

  initHeader();
  init();
})();
