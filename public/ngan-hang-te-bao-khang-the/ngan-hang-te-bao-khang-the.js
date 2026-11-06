/* Module Ngân hàng Tế bào & Kháng thể — sơ đồ kho, lưới hộp, mẫu. Mọi dữ liệu người dùng đi qua textContent (không innerHTML). */
(function () {
  'use strict';

  var API = '/api/ngan-hang-te-bao-khang-the';
  // Ngân hàng đang dùng: lấy từ ?nh= trên địa chỉ ('te_bao' | 'khang_the'). Không có thì hiện màn hình chọn ngân hàng.
  var NH_VN = { te_bao: 'Ngân hàng tế bào', khang_the: 'Ngân hàng kháng thể' };
  var nganHang = (function () { var v = new URLSearchParams(location.search).get('nh'); return NH_VN[v] ? v : null; })();
  var state = { meta: null, me: null, groups: [], tree: null, sel: null, expanded: {}, box: null, search: null, cv: null, audit: null, dtb: null };
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
      headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, nganHang ? { 'X-Ngan-Hang': nganHang } : {}),
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

  /**
   * Mở hộp thoại. Màn hình rộng và đang xem một thiết bị có sơ đồ (có vùng .nhm-dock dưới sơ đồ): hộp thoại của ống (xem ống, nhập mẫu) hiện NGAY DƯỚI sơ đồ
   * để vẫn thấy lưới hộp và vị trí ống trên sơ đồ khi thao tác; còn lại (điện thoại, hộp thoại quản lý, xác nhận) là popup như cũ.
   * Đang mở rồi thì giữ nguyên chế độ (chỉ thay nội dung), nên từ hộp thoại ống bấm «Chỉnh sửa», «Lấy ra»… vẫn nằm ở dock.
   */
  function hienHopThoai(dockUuTien) {
    var d = $('nhm-dialog');
    if (d.open) return;
    var dock = dockUuTien && !window.matchMedia('(max-width: 900px)').matches ? document.querySelector('.nhm-dock') : null;
    if (dock) {
      dock.appendChild(d);
      d.classList.add('nhm-dialog--dock');
      d.show();
    } else {
      if (d.parentNode !== document.body) document.body.appendChild(d);
      d.classList.remove('nhm-dialog--dock');
      d.showModal();
    }
  }

  /** Sau khi vẽ lại chi tiết: hộp thoại dock đang mở được đưa sang dock mới; không còn dock (đã chuyển sang màn khác) thì đóng. */
  function giuHopThoaiDock() {
    var d = $('nhm-dialog');
    if (!d || !d.classList.contains('nhm-dialog--dock')) return;
    var dock = document.querySelector('.nhm-dock');
    if (!d.open) { d.classList.remove('nhm-dialog--dock'); return; }
    if (dock) { if (d.parentNode !== dock) dock.appendChild(d); }
    else { d.close(); d.classList.remove('nhm-dialog--dock'); if (d.parentNode !== document.body) document.body.appendChild(d); }
  }
  document.addEventListener('keydown', function (e) { var d = $('nhm-dialog'); if (e.key === 'Escape' && d && d.open && d.classList.contains('nhm-dialog--dock')) d.close(); });

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
    hienHopThoai(opts.dock);
    var first = form.querySelector('input,select,textarea');
    if (first) first.focus();
  }

  /**
   * Hộp xác nhận TRONG TRANG (thay window.confirm: trình duyệt nhúng và cài đặt «chặn hộp thoại» trả về «hủy» ngay nên nút không làm gì).
   * khiDongY chạy khi bấm «Đồng ý»; khiHuy (tùy chọn) khi bấm «Hủy», nhấn Esc hoặc bấm ra ngoài.
   */
  function hoi(cauHoi, khiDongY, khiHuy) {
    var d = h('dialog', { class: 'nhm-dialog nhm-dialog--hoi', 'aria-label': 'Xác nhận' });
    var xong = false;
    var dong = function (dongY) {
      if (xong) return;
      xong = true;
      if (d.open) d.close();
      d.remove();
      if (dongY) khiDongY(); else if (khiHuy) khiHuy();
    };
    d.addEventListener('cancel', function (ev) { ev.preventDefault(); dong(false); });
    d.appendChild(h('div', { class: 'nhm-form' }, [
      h('p', { class: 'nhm-hoi', role: 'alert' }, cauHoi),
      h('div', { class: 'nhm-form-actions' }, [
        h('button', { type: 'button', class: 'nhm-btn', onclick: function () { dong(false); } }, 'Hủy'),
        h('button', { type: 'button', class: 'nhm-btn nhm-btn--primary', onclick: function () { dong(true); } }, 'Đồng ý'),
      ]),
    ]));
    document.body.appendChild(d);
    d.showModal();
    var dy = d.querySelector('.nhm-btn--primary');
    if (dy) dy.focus();
  }

  /** Bản Promise của hoi() cho các biểu mẫu: không có câu hỏi thì qua luôn; «Hủy» thì từ chối với «Đã hủy thao tác.». */
  function hoiP(cauHoi) {
    if (!cauHoi) return Promise.resolve();
    return new Promise(function (res, rej) { hoi(cauHoi, res, function () { rej(new Error('Đã hủy thao tác.')); }); });
  }

  /** gon: nhiều nút (hộp thoại ống) thì nút nhỏ, xếp sát nhau từ bên trái thay vì to và dàn sang phải. */
  function openInfo(title, nodes, buttons, dock, gon) {
    var d = $('nhm-dialog');
    d.replaceChildren(h('div', {}, [
      h('h3', {}, title),
      nodes,
      h('div', { class: 'nhm-form-actions' + (gon ? ' nhm-form-actions--gon' : '') }, [].concat(buttons || [], [
        h('button', { type: 'button', class: 'nhm-btn', onclick: closeDialog }, 'Đóng'),
      ])),
    ]));
    hienHopThoai(dock);
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
    state.dtb = null;
    state.cv = null;
    state.audit = null;
    state.sel = { type: type, id: id };
    state.box = null;
    location.hash = type + '=' + id;
    if (type === 'box') cuonToiChiTiet();
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
      h('p', { class: 'nhm-muted nhm-small' }, 'Nhóm mới cần quản lý module xác nhận, và người bạn chọn làm trưởng nhóm sẽ nhận thông báo để xác nhận. Trưởng nhóm là người sẽ duyệt khi có ai yêu cầu lấy mẫu của bạn.'),
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

  /** Ống kháng thể: chủ mẫu mặc định là AntibodyBank; chỉ khi chọn «Cá nhân» (mua bằng kinh phí cá nhân, xung công quỹ) mới khai loại chủ, nhóm và người sở hữu. */
  function chuMauKhangThe() {
    var chon = h('select', { 'aria-label': 'Chủ mẫu' }, [
      h('option', { value: 'don_vi' }, 'AntibodyBank (mặc định)'),
      h('option', { value: 'ca_nhan' }, 'Cá nhân (mua bằng kinh phí cá nhân, xung công quỹ)')]);
    var canhan = chuMauWidget(state.groups || []);
    var nguoi = chonNguoi({ label: 'Người sở hữu (để trống thì là chính bạn)', placeholder: 'Tìm người sở hữu (tên hoặc email)…' });
    var vung = h('div', { class: 'nhm-hide' }, [canhan.node, nguoi.node]);
    chon.addEventListener('change', function () { vung.classList.toggle('nhm-hide', chon.value !== 'ca_nhan'); });
    return { node: h('div', {}, [chon, vung]), get: function () { return { loai: chon.value, ca: canhan.get(), nguoi: nguoi.get() }; } };
  }

  /** Từ giá trị của chuMauKhangThe → phần thân gửi kèm khi thêm ống kháng thể. */
  function chuMauBodyKt(v) {
    if (v.loai !== 'ca_nhan') return Promise.resolve({ chu_don_vi: true });
    return chuMauBody(v.ca).then(function (extra) { return Object.assign({ chu_don_vi: false }, v.nguoi ? { owner_user_id: v.nguoi.id } : {}, extra); });
  }

  // ---------- dòng tế bào: hồ sơ, lô (stock), QC, tệp đính kèm, báo cáo GMO (ngân hàng tế bào) ----------
  var DANG_NUOI_VN = { bam_dinh: 'Bám dính', huyen_phu: 'Huyền phù', khac: 'Khác' };
  var LOAI_DONG_VN = { dong_ban_dau: 'Dòng nguyên phát', dong_vo_han: 'Dòng bất tử hóa', ipsc: 'iPSC', khac: 'Khác' };
  var QC_LOAI_VN = { mycoplasma: 'Mycoplasma', str: 'Xác thực STR', song_sot: 'Tỉ lệ sống sót', vi_khuan_nam: 'Vi khuẩn / nấm', hinh_thai: 'Hình thái', khac: 'Khác' };
  var QC_KET_QUA_VN = { dat: 'Đạt', khong_dat: 'Không đạt', am_tinh: 'Âm tính', duong_tinh: 'Dương tính', khac: 'Khác' };

  function ngayVn(s) { return s ? String(s).split('-').reverse().join('/') : ''; }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function homNayIso() { return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); }
  function loChoOpts(map, trong) { return (trong ? [{ value: '', label: trong }] : []).concat(Object.keys(map).map(function (k) { return { value: k, label: map[k] }; })); }

  /** Chip mycoplasma: âm tính còn hạn (thường), dương tính hoặc chưa thử / quá hạn (cảnh báo). */
  function chipMyco(m) {
    if (!m || !m.co) return h('span', { class: 'nhm-chip nhm-chip--canh' }, 'Chưa thử mycoplasma');
    var ten = 'Mycoplasma ' + (QC_KET_QUA_VN[m.ket_qua] || '').toLowerCase() + ' · ' + ngayVn(m.ngay);
    if (m.ket_qua === 'duong_tinh') return h('span', { class: 'nhm-chip nhm-chip--canh' }, ten);
    return h('span', { class: 'nhm-chip' + (m.qua_han ? ' nhm-chip--canh' : '') }, ten + (m.qua_han ? ' · quá hạn thử' : ''));
  }
  function chipGmo(d) {
    return d.bien_doi_gen ? h('span', { class: 'nhm-chip nhm-chip--gmo' }, 'GMO') : null;
  }
  function chipBsl(bsl) { return bsl ? h('span', { class: 'nhm-chip ' + (bsl >= 3 ? 'nhm-chip--bsl3' : 'nhm-chip--gmo') }, 'BSL-' + bsl) : null; }

  function moDongTeBao(id) {
    state.search = null; state.cv = null; state.sel = null; state.box = null; state.audit = null;
    var cu = state.dtb;
    state.dtb = id ? { view: 'ct', id: id, data: null } : { view: 'ds', q: cu && cu.view === 'ds' ? cu.q : '', gmo: cu && cu.view === 'ds' ? cu.gmo : false, data: null };
    location.hash = id ? 'dong-te-bao=' + id : 'dong-te-bao';
    renderTree();
    renderDetail();
    return taiDtb();
  }

  function taiDtb() {
    var d = state.dtb; if (!d) return Promise.resolve();
    var url = d.view === 'ct' ? '/cell-lines/' + d.id : '/cell-lines?' + (d.q ? 'q=' + encodeURIComponent(d.q) + '&' : '') + (d.gmo ? 'gmo=1' : '');
    return api('GET', url).then(function (r) {
      if (state.dtb !== d) return;
      d.data = r;
      renderDetail();
    }).catch(function (e) {
      if (state.dtb !== d) return;
      if (d.view === 'ct' && e.status === 404) { say('Không còn dòng tế bào này.', 'err'); return moDongTeBao(); }
      d.loi = e.message; renderDetail();
    });
  }

  function renderDongTeBao(root) {
    var d = state.dtb;
    if (d.loi) return put(root, h('p', { class: 'nhm-err' }, d.loi));
    if (!d.data) return put(root, h('div', { class: 'nhm-loading' }, 'Đang tải…'));
    return d.view === 'ct' ? renderHoSoDong(root, d.data) : renderDsDong(root, d);
  }

  function renderDsDong(root, d) {
    var q = h('input', { type: 'search', placeholder: 'Tìm theo mã, tên, loài, mô, nguồn…', 'aria-label': 'Tìm dòng tế bào', value: d.q || '' });
    var gmo = h('input', { type: 'checkbox' }); gmo.checked = !!d.gmo;
    var tim = function () { d.q = q.value.trim(); d.gmo = gmo.checked; d.data = null; renderDetail(); taiDtb(); };
    q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); tim(); } });
    gmo.addEventListener('change', tim);
    var quanTri = state.meta.canManage || state.meta.laVienTruong;
    var ds = d.data.cell_lines;
    put(root,
      h('div', { class: 'nhm-title' }, [h('h2', {}, 'Dòng tế bào'), h('span', { class: 'nhm-muted' }, d.data.tong + ' dòng')]),
      h('div', { class: 'nhm-dtb-bar' }, [q, nutNho('Tìm', 'primary', tim), h('label', {}, [gmo, 'Chỉ dòng biến đổi gen']), nutNho('+ Thêm dòng', 'primary', function () { dongForm(null); })]
        .concat(quanTri ? [nutNho('Báo cáo GMO (in)', '', function () { window.open(API + '/reports/gmo/print?nh=te_bao', '_blank', 'noopener'); }), h('a', { class: 'nhm-btn nhm-btn--sm', href: API + '/reports/gmo.csv?nh=te_bao' }, 'Xuất CSV')] : [])),
      ds.length ? h('div', { class: 'nhm-cards' }, ds.map(function (x) {
        return h('div', { class: 'nhm-card' }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, x.ma + ' · ' + x.ten), h('span', { class: 'nhm-chips' }, [chipGmo(x), chipBsl(x.bsl)])]),
          h('div', { class: 'nhm-small' }, [x.loai_sinh_vat, x.mo_nguon_goc].filter(Boolean).join(' · ') || '—'),
          h('div', { class: 'nhm-small nhm-muted' }, x.so_lo + ' lô · ' + x.so_ong + ' ống đang giữ'),
          h('div', { class: 'nhm-chips' }, chipMyco(x.mycoplasma)),
          h('div', { class: 'nhm-card-act' }, [nutNho('Mở hồ sơ', 'primary', function () { moDongTeBao(x.id); })]),
        ]);
      })) : h('p', { class: 'nhm-muted' }, d.q || d.gmo ? 'Không có dòng tế bào nào khớp.' : 'Chưa có hồ sơ dòng tế bào nào. Bấm «+ Thêm dòng» để tạo; các lô và ống đông lạnh gắn vào dòng.'));
  }

  function sec(tieuDe, noiDung, nut) {
    return h('section', { class: 'nhm-dtb-sec' }, [h('h3', {}, [h('span', {}, tieuDe), nut || null]), noiDung]);
  }

  function renderHoSoDong(root, r) {
    var d = r.dong, lamMoi = function () { return taiDtb(); };
    var sua = d.quyen_sua;
    var thongTin = h('div', { class: 'nhm-facts' }, [
      fact('Loài', d.loai_sinh_vat), fact('Mô nguồn gốc', d.mo_nguon_goc), fact('Bệnh', d.benh), fact('Loại dòng', LOAI_DONG_VN[d.loai_dong]),
      fact('Nguồn cung cấp', d.nguon_cung_cap), fact('Mã nguồn', d.ma_nguon), fact('Dạng nuôi', DANG_NUOI_VN[d.dang_nuoi]), fact('Môi trường', d.moi_truong),
      fact('Bổ sung (serum…)', d.bo_sung), fact('Nhiệt độ nuôi', d.nhiet_do_c != null ? d.nhiet_do_c + ' °C' : null), fact('CO₂', d.co2_phan_tram != null ? d.co2_phan_tram + ' %' : null),
      fact('Thời gian nhân đôi', d.thoi_gian_nhan_doi), fact('Hình thái', d.hinh_thai), fact('Đặc điểm tăng trưởng', d.dac_diem_tang_truong),
      fact('Đề tài / dự án', d.du_an), fact('Nhóm nghiên cứu', d.nhom_ten), fact('Người tạo hồ sơ', d.tao_boi_ten), fact('Ghi chú', d.ghi_chu),
    ]);
    var anToan = d.bien_doi_gen || d.bsl ? h('div', { class: 'nhm-facts' }, [fact('Biến đổi gen', d.bien_doi_gen ? 'Có' : 'Không'), fact('Cấp an toàn sinh học', d.bsl ? 'BSL-' + d.bsl : null), fact('Mô tả biến đổi (vector, gen, phương pháp)', d.gmo_mo_ta)]) : h('p', { class: 'nhm-muted nhm-small' }, 'Không phải dòng biến đổi gen.');

    var bangLo = r.lo.length ? h('div', { class: 'nhm-bang-cuon' }, h('table', { class: 'nhm-bang' }, [
      h('tr', {}, ['Mã lô', 'Passage', 'Ngày đông lạnh', 'Tế bào / ống', 'Sống sót', 'Ống còn', 'Ghi chú', ''].map(function (x) { return h('th', {}, x); })),
    ].concat(r.lo.map(function (l) {
      return h('tr', {}, [
        h('td', {}, h('b', {}, l.ma)), l.passage || '—', ngayVn(l.ngay_dong_lanh) || '—', l.so_te_bao_moi_ong != null ? String(l.so_te_bao_moi_ong) : '—', l.ty_le_song_sot != null ? l.ty_le_song_sot + ' %' : '—', String(l.so_ong),
        [l.moi_truong_dong, l.ghi_chu].filter(Boolean).join(' · ') || '—',
        h('span', { class: 'nhm-card-act' }, [nutNho('Nhập ống', 'primary', function () {
          state.chonSan = { dong_id: d.id, lo_id: l.id };
          say('Mở hộp rồi bấm vào ô trống để nhập ống của lô ' + l.ma + ': dòng, lô, passage và ngày đông lạnh đã được chọn sẵn.', 'ok');
        })].concat(sua ? [nutNho('Sửa', '', function () { loForm(d, l, lamMoi); }), nutNho('Xóa', 'danger', function () {
          hoi('Xóa lô «' + l.ma + '»? (Chỉ xóa được khi không còn ống đang giữ.)', function () { api('DELETE', '/lots/' + l.id).then(function () { say('Đã xóa lô.', 'ok'); lamMoi(); }).catch(function (e) { say(e.message, 'err'); }); });
        })] : [])),
      ].map(function (c) { return c instanceof Node ? (c.tagName === 'TD' ? c : h('td', {}, c)) : h('td', {}, c); }));
    })))) : h('p', { class: 'nhm-muted nhm-small' }, 'Chưa có lô nào. Mỗi lần đông lạnh một mẻ tế bào là một lô; ống đông lạnh gắn vào lô khi thêm mẫu.');

    var bangQc = r.qc.length ? h('div', { class: 'nhm-bang-cuon' }, h('table', { class: 'nhm-bang' }, [
      h('tr', {}, ['Ngày', 'Kiểm tra', 'Kết quả', 'Lô', 'Phương pháp / ghi chú', 'Người ghi'].map(function (x) { return h('th', {}, x); })),
    ].concat(r.qc.map(function (x) {
      return h('tr', {}, [ngayVn(x.ngay), QC_LOAI_VN[x.loai] || x.loai, h('b', { class: (x.ket_qua === 'duong_tinh' || x.ket_qua === 'khong_dat') ? 'nhm-canh' : '' }, QC_KET_QUA_VN[x.ket_qua] || x.ket_qua), x.lo_ma || 'Cả dòng', [x.phuong_phap, x.ghi_chu].filter(Boolean).join(' · ') || '—', x.user_label || '']
        .map(function (c) { return h('td', {}, c); }));
    })))) : h('p', { class: 'nhm-muted nhm-small' }, 'Chưa có kết quả QC nào.');

    var tepNut = sua ? nutNho('+ Tải tệp lên', 'primary', function () { tepForm(d, r, lamMoi); }) : null;
    var dsTep = r.tep.length ? h('div', {}, r.tep.map(function (t) {
      var href = API + '/attachments/' + t.id + '/download?nh=te_bao';
      var gan = t.doi_tuong === 'dong' ? 'Dòng' : t.doi_tuong === 'lo' ? 'Lô ' + ((r.lo.filter(function (l) { return l.id === t.doi_tuong_id; })[0] || {}).ma || '') : 'QC ' + ngayVn((r.qc.filter(function (x) { return x.id === t.doi_tuong_id; })[0] || {}).ngay);
      return h('div', { class: 'nhm-tep' }, [
        t.anh ? h('a', { href: href, target: '_blank', rel: 'noopener' }, h('img', { src: href, alt: t.ten_goc })) : null,
        h('a', { href: href, target: t.anh ? '_blank' : null, rel: 'noopener' }, t.ten_goc),
        h('span', { class: 'nhm-small nhm-muted' }, kb(t.kich_thuoc) + ' · ' + gan + (t.mo_ta ? ' · ' + t.mo_ta : '') + ' · ' + (t.tao_boi_ten || '') + ' · ' + gioDia(t.tao_luc)),
        sua || t.tao_boi_ten ? nutNho('Xóa', 'danger', function () {
          hoi('Xóa tệp «' + t.ten_goc + '»?', function () { api('DELETE', '/attachments/' + t.id).then(function () { say('Đã xóa tệp.', 'ok'); lamMoi(); }).catch(function (e) { say(e.message, 'err'); }); });
        }) : null,
      ]);
    })) : h('p', { class: 'nhm-muted nhm-small' }, 'Chưa có tệp đính kèm (phiếu dữ liệu, kết quả mycoplasma / STR, ảnh hình thái…).');

    var dsOng = r.ong.length ? h('div', { class: 'nhm-bang-cuon' }, h('table', { class: 'nhm-bang' }, [
      h('tr', {}, ['Ống', 'Lô', 'Vị trí', ''].map(function (x) { return h('th', {}, x); })),
    ].concat(r.ong.map(function (o) {
      return h('tr', {}, [o.name + (o.status === 'checked_out' ? ' (đã lấy ra)' : ''), o.lo_ma, o.vi_tri || '—', nutNho('Xem mẫu', '', function () { moMauTheoId(o.id); })].map(function (c) { return c instanceof Node ? h('td', {}, c) : h('td', {}, c); }));
    })))) : h('p', { class: 'nhm-muted nhm-small' }, 'Chưa có ống nào gắn với dòng này. Khi thêm hoặc sửa mẫu, chọn dòng và lô ở ô «Dòng tế bào và lô».');

    put(root,
      h('p', {}, nutNho('← Danh sách dòng tế bào', '', function () { moDongTeBao(); })),
      h('div', { class: 'nhm-title' }, [h('h2', {}, d.ten), h('span', { class: 'nhm-muted' }, d.ma)]),
      h('div', { class: 'nhm-chips' }, [chipGmo(d), chipBsl(d.bsl), chipMyco(r.mycoplasma)]),
      sua ? h('div', { class: 'nhm-actions' }, [nutNho('Chỉnh sửa hồ sơ', 'primary', function () { dongForm(d); }), nutNho('Xóa dòng', 'danger', function () {
        hoi('Xóa dòng «' + d.ten + '» cùng các lô? Chỉ xóa được khi không còn ống đang giữ.', function () { api('DELETE', '/cell-lines/' + d.id).then(function () { say('Đã xóa dòng tế bào.', 'ok'); moDongTeBao(); }).catch(function (e) { say(e.message, 'err'); }); });
      })]) : null,
      sec('Thông tin nguồn gốc và nuôi cấy', thongTin),
      sec('An toàn sinh học', anToan),
      sec('Lô đông lạnh (stock) — ' + r.lo.length, bangLo, sua ? nutNho('+ Thêm lô', 'primary', function () { loForm(d, null, lamMoi); }) : null),
      sec('Kiểm soát chất lượng (QC) — mycoplasma nên thử ít nhất mỗi ' + r.han_myco_ngay + ' ngày', bangQc, sua ? nutNho('+ Ghi kết quả QC', 'primary', function () { qcForm(d, r, lamMoi); }) : null),
      sec('Tệp đính kèm — ' + r.tep.length, dsTep, tepNut),
      sec('Ống đang giữ — ' + r.ong.length, dsOng));
  }

  function dongForm(d) {
    var f = function (name, label, extra) { return Object.assign({ name: name, label: label, value: d && d[name] }, extra || {}); };
    openForm({
      title: d ? 'Chỉnh sửa dòng tế bào ' + d.ma : 'Thêm dòng tế bào',
      fields: [
        f('ma', 'Mã dòng (duy nhất, vd HEK293-01)', { required: true }), f('ten', 'Tên dòng', { required: true }),
        f('loai_sinh_vat', 'Loài (người, chuột…)'), f('mo_nguon_goc', 'Mô / cơ quan nguồn gốc'), f('benh', 'Bệnh liên quan'),
        f('loai_dong', 'Loại dòng', { type: 'select', options: loChoOpts(LOAI_DONG_VN, '— chưa chọn —'), value: d && d.loai_dong || '' }),
        f('nguon_cung_cap', 'Nguồn cung cấp (ATCC, phòng thí nghiệm…)'), f('ma_nguon', 'Mã tại nguồn (catalog)'),
        f('dang_nuoi', 'Dạng nuôi', { type: 'select', options: loChoOpts(DANG_NUOI_VN, '— chưa chọn —'), value: d && d.dang_nuoi || '' }),
        f('moi_truong', 'Môi trường nuôi'), f('bo_sung', 'Bổ sung (serum, kháng sinh…)'),
        f('nhiet_do_c', 'Nhiệt độ nuôi (°C)', { type: 'number' }), f('co2_phan_tram', 'CO₂ (%)', { type: 'number' }),
        f('thoi_gian_nhan_doi', 'Thời gian nhân đôi'), f('hinh_thai', 'Hình thái', { type: 'textarea' }), f('dac_diem_tang_truong', 'Đặc điểm tăng trưởng', { type: 'textarea' }),
        f('du_an', 'Đề tài / dự án'),
        { name: 'bien_doi_gen', label: 'Dòng biến đổi gen (GMO)?', type: 'select', options: [{ value: '0', label: 'Không' }, { value: '1', label: 'Có — phải mô tả và ghi cấp an toàn sinh học' }], value: d && d.bien_doi_gen ? '1' : '0' },
        f('gmo_mo_ta', 'Mô tả biến đổi gen (vector, gen, phương pháp) — bắt buộc nếu là GMO', { type: 'textarea' }),
        { name: 'bsl', label: 'Cấp an toàn sinh học (bắt buộc nếu là GMO)', type: 'select', options: [{ value: '', label: '— chưa ghi —' }, { value: '1', label: 'BSL-1' }, { value: '2', label: 'BSL-2' }, { value: '3', label: 'BSL-3' }, { value: '4', label: 'BSL-4' }], value: d && d.bsl ? String(d.bsl) : '' },
        f('ghi_chu', 'Ghi chú', { type: 'textarea' }),
      ],
      submitLabel: d ? 'Lưu' : 'Tạo hồ sơ',
      onSubmit: function (v) {
        var body = {};
        Object.keys(v).forEach(function (k) { body[k] = v[k]; });
        body.bien_doi_gen = v.bien_doi_gen === '1';
        ['loai_dong', 'dang_nuoi', 'bsl'].forEach(function (k) { if (body[k] === '') body[k] = null; });
        if (body.bsl != null) body.bsl = Number(body.bsl);
        return (d ? api('PATCH', '/cell-lines/' + d.id, body) : api('POST', '/cell-lines', body)).then(function (r) {
          say(d ? 'Đã lưu hồ sơ dòng tế bào.' : 'Đã tạo hồ sơ dòng tế bào.', 'ok');
          return moDongTeBao(d ? d.id : r.id);
        });
      },
    });
  }

  function loForm(d, l, lamMoi) {
    var f = function (name, label, extra) { return Object.assign({ name: name, label: label, value: l && l[name] }, extra || {}); };
    openForm({
      title: (l ? 'Sửa lô ' + l.ma : 'Thêm lô') + ' — ' + d.ten,
      fields: [
        f('ma', 'Mã lô (duy nhất trong dòng, vd L2026-09)', { required: true }), f('passage', 'Passage lúc đông lạnh'),
        f('ngay_dong_lanh', 'Ngày đông lạnh', { type: 'date' }), f('so_te_bao_moi_ong', 'Số tế bào mỗi ống', { type: 'number' }),
        f('ty_le_song_sot', 'Tỉ lệ sống sót sau đông lạnh (%)', { type: 'number' }), f('moi_truong_dong', 'Môi trường đông lạnh (vd FBS + 10% DMSO)'),
        f('ghi_chu', 'Ghi chú', { type: 'textarea' }),
      ],
      submitLabel: l ? 'Lưu' : 'Thêm lô',
      onSubmit: function (v) {
        return (l ? api('PATCH', '/lots/' + l.id, v) : api('POST', '/cell-lines/' + d.id + '/lots', v)).then(function () { say('Đã lưu lô.', 'ok'); return lamMoi(); });
      },
    });
  }

  function qcForm(d, r, lamMoi) {
    var loOpts = [{ value: '', label: 'Cả dòng' }].concat(r.lo.map(function (l) { return { value: String(l.id), label: 'Lô ' + l.ma }; }));
    openForm({
      title: 'Ghi kết quả QC — ' + d.ten,
      fields: [
        { name: 'loai', label: 'Kiểm tra', type: 'select', options: loChoOpts(QC_LOAI_VN), value: 'mycoplasma' },
        { name: 'ket_qua', label: 'Kết quả (mycoplasma: âm tính / dương tính)', type: 'select', options: loChoOpts(QC_KET_QUA_VN), value: 'am_tinh' },
        { name: 'ngay', label: 'Ngày kiểm tra', type: 'date', required: true, value: homNayIso() },
        { name: 'lo_id', label: 'Áp dụng cho', type: 'select', options: loOpts, value: '' },
        { name: 'phuong_phap', label: 'Phương pháp (PCR, DAPI, bộ kit…)' },
        { name: 'ghi_chu', label: 'Ghi chú', type: 'textarea' },
      ],
      submitLabel: 'Ghi kết quả',
      onSubmit: function (v) {
        return api('POST', '/cell-lines/' + d.id + '/qc', v).then(function () {
          say(v.loai === 'mycoplasma' && v.ket_qua === 'duong_tinh' ? 'Đã ghi. Mycoplasma DƯƠNG TÍNH: hãy cách ly và xử lý dòng này.' : 'Đã ghi kết quả QC (không sửa / xóa được).', v.loai === 'mycoplasma' && v.ket_qua === 'duong_tinh' ? 'err' : 'ok');
          return lamMoi();
        });
      },
    });
  }

  /** Tải tệp lên: chọn tệp, gắn vào dòng / một lô / một kết quả QC, mô tả. Gửi multipart (không qua api() JSON). */
  function tepForm(d, r, lamMoi) {
    var file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.docx,.txt,.csv', 'aria-label': 'Tệp đính kèm' });
    var gan = h('select', { 'aria-label': 'Gắn vào' }, [h('option', { value: 'dong:' + d.id }, 'Cả dòng')]
      .concat(r.lo.map(function (l) { return h('option', { value: 'lo:' + l.id }, 'Lô ' + l.ma); }))
      .concat(r.qc.map(function (x) { return h('option', { value: 'qc:' + x.id }, 'QC ' + (QC_LOAI_VN[x.loai] || x.loai) + ' ' + ngayVn(x.ngay)); })));
    openForm({
      title: 'Tải tệp lên — ' + d.ten,
      fields: [
        { name: 'tep', label: 'Tệp (PDF, ảnh PNG / JPG / WEBP, .xlsx, .docx, .txt, .csv; tối đa 10 MB)', type: 'custom', widget: { node: file, get: function () { return file.files[0] || null; } } },
        { name: 'gan', label: 'Gắn vào', type: 'custom', widget: { node: gan, get: function () { return gan.value; } } },
        { name: 'mo_ta', label: 'Mô tả (không bắt buộc)' },
      ],
      submitLabel: 'Tải lên',
      onSubmit: function (v) {
        if (!v.tep) return Promise.reject(new Error('Chưa chọn tệp.'));
        if (v.tep.size > 10 * 1048576) return Promise.reject(new Error('Tệp quá lớn (tối đa 10 MB).'));
        var p = v.gan.split(':'), f = new FormData();
        f.append('doi_tuong', p[0]); f.append('doi_tuong_id', p[1]); if (v.mo_ta) f.append('mo_ta', v.mo_ta); f.append('tep', v.tep, v.tep.name);
        return fetch(API + '/attachments', { method: 'POST', credentials: 'same-origin', headers: { 'X-Ngan-Hang': nganHang }, body: f })
          .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { if (!res.ok) throw new Error(j.message || 'Lỗi ' + res.status); return j; }); })
          .then(function () { say('Đã tải tệp lên.', 'ok'); return lamMoi(); });
      },
    });
  }

  /** Thẻ tóm tắt một dòng tế bào (dùng ở form nhập mẫu và hộp thoại ống): mã · tên, chip GMO / BSL / mycoplasma, nuôi cấy, cảnh báo an toàn. */
  function theDong(r, lo) {
    var d = r.dong;
    var nuoi = [d.loai_sinh_vat, d.mo_nguon_goc, d.moi_truong, d.nhiet_do_c != null ? d.nhiet_do_c + ' °C' : null, d.co2_phan_tram != null ? 'CO₂ ' + d.co2_phan_tram + '%' : null].filter(Boolean).join(' · ');
    var canh = [];
    if (d.bien_doi_gen) canh.push('Dòng biến đổi gen' + (d.bsl ? ' (BSL-' + d.bsl + ')' : '') + ': lưu giữ và thao tác theo quy định an toàn sinh học.' + (d.gmo_mo_ta ? ' ' + d.gmo_mo_ta : ''));
    if (r.mycoplasma && r.mycoplasma.ket_qua === 'duong_tinh') canh.push('Mycoplasma DƯƠNG TÍNH lần thử gần nhất: không nên nhập ống mới vào kho dùng chung.');
    return h('div', { class: 'nhm-dl-tt' }, [
      h('div', { class: 'nhm-card-top' }, [h('strong', {}, d.ma + ' · ' + d.ten), h('span', { class: 'nhm-chips' }, [chipGmo(d), chipBsl(d.bsl), chipMyco(r.mycoplasma)])]),
      nuoi ? h('div', { class: 'nhm-small' }, nuoi) : null,
      lo ? h('div', { class: 'nhm-small' }, ['Lô ', h('b', {}, lo.ma), [lo.passage, lo.ngay_dong_lanh ? 'đông lạnh ' + ngayVn(lo.ngay_dong_lanh) : null, lo.so_te_bao_moi_ong != null ? lo.so_te_bao_moi_ong + ' tế bào/ống' : null, lo.ty_le_song_sot != null ? 'sống sót ' + lo.ty_le_song_sot + '%' : null].filter(Boolean).map(function (x) { return ' · ' + x; }).join('')]) : null,
      canh.length ? h('div', { class: 'nhm-small nhm-canh', role: 'alert' }, canh.join(' ')) : null,
    ]);
  }

  /**
   * Phần «Dòng tế bào → lô» ở ĐẦU form thêm / sửa ống (ngân hàng tế bào): chọn dòng, hiện thẻ tóm tắt dòng, chọn lô; có thể TẠO dòng hoặc lô mới ngay tại chỗ.
   * Chọn dòng / lô thì điền sẵn tên ống, passage, ngày đông lạnh, số tế bào, đề tài (chỉ ghi đè ô còn trống hoặc ô do chính phần này điền lần trước).
   * Ống đã chọn dòng thì phải chọn lô. Nhập từ hồ sơ dòng («Nhập ống» ở một lô) thì dòng và lô được chọn sẵn.
   */
  function chonDongLo(tube) {
    var san = !tube && state.chonSan ? state.chonSan : null;
    state.chonSan = null; // dùng một lần
    var tuDat = {}; // giá trị phần này đã điền, để lần chọn sau ghi đè được mà không đè chữ người dùng gõ
    var dongHienTai = null; // chi tiết GET /cell-lines/:id của dòng đang chọn
    var lots = {};
    var dong = h('select', { 'aria-label': 'Dòng tế bào' }, [h('option', { value: '' }, '— mẫu không thuộc dòng nào —'), h('option', { value: '+' }, '+ Tạo dòng tế bào mới…')]);
    var lo = h('select', { 'aria-label': 'Lô' }, [h('option', { value: '' }, '— chọn dòng trước —')]);
    lo.disabled = true;
    var khungThe = h('div', {});
    var loiMoi = h('div', { class: 'nhm-err', role: 'alert' });

    function oDat(ten, giaTri) {
      var inp = $('nhm-dialog').querySelector('[name="' + ten + '"]');
      if (!inp || giaTri == null || giaTri === '') return;
      if (!inp.value || inp.value === tuDat[ten]) { inp.value = giaTri; tuDat[ten] = String(giaTri); }
    }
    function tenOng(l) { return dongHienTai ? (dongHienTai.dong.ten + (l && l.passage ? ' ' + l.passage : '')).trim() : ''; }

    function veThe() { put(khungThe, dongHienTai ? theDong(dongHienTai, lots[lo.value] || null) : null); }

    function napLo(chon) {
      lots = {};
      dongHienTai.lo.forEach(function (l) { lots[l.id] = l; });
      var opts = [h('option', { value: '' }, dongHienTai.lo.length ? '— chọn lô —' : '— dòng chưa có lô —')]
        .concat(dongHienTai.lo.map(function (l) { return h('option', { value: l.id }, 'Lô ' + l.ma + (l.passage ? ' · ' + l.passage : '') + (l.ngay_dong_lanh ? ' · ' + ngayVn(l.ngay_dong_lanh) : '')); }));
      if (dongHienTai.dong.quyen_sua) opts.push(h('option', { value: '+' }, '+ Tạo lô mới…'));
      put.apply(null, [lo].concat(opts));
      lo.disabled = false;
      if (chon) lo.value = String(chon);
      veThe();
    }

    function napDong(id, chonLo) {
      return api('GET', '/cell-lines/' + id).then(function (r) {
        dongHienTai = r;
        dong.value = String(id);
        if (!tube) { oDat('project', r.dong.du_an); oDat('name', tenOng(null)); }
        napLo(chonLo);
        if (chonLo && lots[chonLo] && !tube) chonLoXong();
      });
    }
    function chonLoXong() {
      var l = lots[lo.value];
      if (!l || tube) return;
      oDat('passage', l.passage); oDat('freeze_date', l.ngay_dong_lanh); oDat('cell_count', l.so_te_bao_moi_ong);
      oDat('name', tenOng(l));
    }

    // ----- tạo dòng / lô mới ngay trong form -----
    function o(tag, ten, nhan, thuoc) { var e = h(tag, Object.assign({ 'aria-label': nhan, placeholder: nhan }, thuoc || {})); e.dataset.k = ten; return e; }
    function phanTaoMoi(tieuDe, cacO, nutTao, khiTao) {
      var vung = h('div', { class: 'nhm-dl-moi nhm-hide' }, [h('strong', {}, tieuDe)].concat(cacO, [loiMoi, h('div', { class: 'nhm-card-act' }, [nutTao, nutNho('Hủy', '', function () { vung.classList.add('nhm-hide'); loiMoi.textContent = ''; khiTao.huy(); })])]));
      cacO.forEach(function (e) { e.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); nutTao.click(); } }); });
      return vung;
    }
    function docO(cacO) { var b = {}; cacO.forEach(function (e) { b[e.dataset.k] = e.value; }); return b; }

    var gmoSel = o('select', 'bien_doi_gen', 'Biến đổi gen?'); [['0', 'Không biến đổi gen'], ['1', 'Dòng biến đổi gen (GMO)']].forEach(function (x) { gmoSel.appendChild(h('option', { value: x[0] }, x[1])); });
    var bslSel = o('select', 'bsl', 'Cấp an toàn sinh học'); [['', '— cấp an toàn sinh học —'], ['1', 'BSL-1'], ['2', 'BSL-2'], ['3', 'BSL-3'], ['4', 'BSL-4']].forEach(function (x) { bslSel.appendChild(h('option', { value: x[0] }, x[1])); });
    var gmoMoTa = o('input', 'gmo_mo_ta', 'Mô tả biến đổi (vector, gen, phương pháp)', { type: 'text' });
    var oDong = [o('input', 'ma', 'Mã dòng (vd HEK293-01) *', { type: 'text' }), o('input', 'ten', 'Tên dòng *', { type: 'text' }), o('input', 'loai_sinh_vat', 'Loài', { type: 'text' }), o('input', 'mo_nguon_goc', 'Mô nguồn gốc', { type: 'text' }), o('input', 'moi_truong', 'Môi trường nuôi', { type: 'text' }), gmoSel, gmoMoTa, bslSel];
    function doiGmo() { gmoMoTa.classList.toggle('nhm-hide', gmoSel.value !== '1'); bslSel.classList.toggle('nhm-hide', gmoSel.value !== '1'); }
    gmoSel.addEventListener('change', doiGmo); doiGmo();
    var nutTaoDong = nutNho('Tạo dòng', 'primary', function () {
      var b = docO(oDong); b.bien_doi_gen = b.bien_doi_gen === '1'; b.bsl = b.bsl ? Number(b.bsl) : null;
      loiMoi.textContent = '';
      api('POST', '/cell-lines', b).then(function (r) {
        dong.appendChild(h('option', { value: r.id }, b.ma + ' · ' + b.ten));
        panelDong.classList.add('nhm-hide');
        say('Đã tạo dòng «' + b.ten + '». Bổ sung nuôi cấy, QC, tệp ở «Dòng tế bào».', 'ok');
        return napDong(r.id, null);
      }).catch(function (e) { loiMoi.textContent = e.message; });
    });
    var panelDong = phanTaoMoi('Dòng tế bào mới', oDong, nutTaoDong, { huy: function () { dong.value = dongHienTai ? String(dongHienTai.dong.id) : ''; } });

    var oLo = [o('input', 'ma', 'Mã lô (vd L2026-09) *', { type: 'text' }), o('input', 'passage', 'Passage lúc đông lạnh', { type: 'text' }), o('input', 'ngay_dong_lanh', 'Ngày đông lạnh', { type: 'date' }), o('input', 'so_te_bao_moi_ong', 'Số tế bào mỗi ống', { type: 'number', step: 'any' }), o('input', 'ty_le_song_sot', 'Tỉ lệ sống sót (%)', { type: 'number', step: 'any' })];
    var nutTaoLo = nutNho('Tạo lô', 'primary', function () {
      loiMoi.textContent = '';
      api('POST', '/cell-lines/' + dongHienTai.dong.id + '/lots', docO(oLo)).then(function (r) {
        panelLo.classList.add('nhm-hide');
        say('Đã tạo lô.', 'ok');
        return napDong(dongHienTai.dong.id, r.id);
      }).catch(function (e) { loiMoi.textContent = e.message; });
    });
    var panelLo = phanTaoMoi('Lô mới của dòng này', oLo, nutTaoLo, { huy: function () { lo.value = ''; veThe(); } });

    dong.addEventListener('change', function () {
      loiMoi.textContent = '';
      panelLo.classList.add('nhm-hide');
      if (dong.value === '+') { panelDong.classList.remove('nhm-hide'); khungThe.replaceChildren(); return; }
      panelDong.classList.add('nhm-hide');
      if (!dong.value) { dongHienTai = null; lots = {}; put(lo, h('option', { value: '' }, '— chọn dòng trước —')); lo.disabled = true; veThe(); return; }
      napDong(Number(dong.value), null).catch(function (e) { say(e.message, 'err'); });
    });
    lo.addEventListener('change', function () {
      loiMoi.textContent = '';
      if (lo.value === '+') { panelLo.classList.remove('nhm-hide'); return; }
      panelLo.classList.add('nhm-hide');
      chonLoXong(); veThe();
    });

    api('GET', '/cell-lines').then(function (r) {
      r.cell_lines.forEach(function (x) { dong.appendChild(h('option', { value: x.id }, x.ma + ' · ' + x.ten + (x.bien_doi_gen ? ' (GMO)' : ''))); });
      var dongId = tube && tube.dong_id ? tube.dong_id : san ? san.dong_id : null;
      if (dongId) return napDong(dongId, tube && tube.lo_id ? tube.lo_id : san ? san.lo_id : null);
    }).catch(function () {});

    return {
      node: h('div', { class: 'nhm-dl' }, [dong, khungThe, panelDong, lo, panelLo]),
      get: function () {
        if (dong.value && dong.value !== '+' && (!lo.value || lo.value === '+')) return { loi: 'Ống thuộc một dòng tế bào phải chọn lô (hoặc tạo lô mới), hoặc bỏ chọn dòng.' };
        if (dong.value === '+') return { loi: 'Bấm «Tạo dòng» để tạo dòng mới, hoặc chọn một dòng có sẵn.' };
        return { lo_id: dong.value ? lo.value : '' };
      },
    };
  }

  /** Thẻ «Dòng tế bào · lô» trong hộp thoại ống: thông tin dòng, lô, chỉ dẫn mở hồ sơ. Tải chi tiết dòng khi mở. */
  function dongLoPanel(t) {
    // không đặt khung trong khung: phần này phẳng, chỉ có nhãn nhỏ, nội dung và một đường kẻ phân cách
    var khung = h('div', { class: 'nhm-dl-phang' }, h('span', { class: 'nhm-muted' }, 'Đang tải dòng tế bào…'));
    api('GET', '/cell-lines/' + t.dong_id).then(function (r) {
      var l = r.lo.filter(function (x) { return x.id === t.lo_id; })[0] || null;
      put(khung, h('strong', {}, 'Dòng tế bào và lô'), theDong(r, l), h('button', { type: 'button', class: 'nhm-link nhm-dl-phang__mo', onclick: function () { closeDialog(); moDongTeBao(t.dong_id); } }, 'Mở hồ sơ dòng ›'));
    }).catch(function () { put(khung, null); });
    return khung;
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
    // sơ đồ kho luôn bung tới mục đang chọn (kể cả mở thẳng bằng địa chỉ / liên kết), để thấy các cấp trên và các hộp bên trong
    // chỉ bung khi mục chọn ĐỔI (để người dùng vẫn gập lại được bằng tay)
    if (state.sel && state.bungChoMuc !== state.sel.type + state.sel.id) {
      state.bungChoMuc = state.sel.type + state.sel.id;
      var viTriChon = state.sel.type === 'box' ? (t.boxes.filter(function (b) { return b.id === state.sel.id; })[0] || {}).container_id : state.sel.id;
      for (var cc = t.containers.filter(function (x) { return x.id === viTriChon; })[0], buoc = 0; cc && buoc < 50; buoc++) {
        state.expanded[cc.id] = true;
        cc = t.containers.filter(function (x) { return x.id === cc.parent_id; })[0];
      }
    }
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

    // Đường đi tới mục đang chọn (các cấp cha) để tô nhạt: nhìn là biết mình đang ở nhánh nào
    var theoId = {};
    t.containers.forEach(function (c) { theoId[c.id] = c; });
    var duongTo = {};
    if (state.sel) {
      var dau = state.sel.type === 'box' ? (t.boxes.filter(function (b) { return b.id === state.sel.id; })[0] || {}).container_id : state.sel.id;
      for (var cap = theoId[dau], n = 0; cap && n < 50; cap = theoId[cap.parent_id], n++) duongTo[cap.id] = true;
    }

    /**
     * Một hàng của cây. o.cap: 'l0' thiết bị (dải tiêu đề hai dòng), 'l1' Rack / ngăn (hàng có đường nối), 'l2' hộp (lá nhẹ, kèm thanh đầy).
     * Ba cấp khác nhau về nền, cỡ chữ và độ đậm để nheo mắt vẫn thấy phân cấp.
     */
    function nutCay(o) {
      var cls = 'nhm-node nhm-node--' + o.cap + (o.on ? ' nhm-node--on' : '') + (o.duong ? ' nhm-node--duong' : '');
      var kids = [h('span', { class: 'nhm-node__caret' + (o.coCon ? (o.mo ? ' nhm-node__caret--mo' : ' nhm-node__caret--dong') : ''), 'aria-hidden': 'true' })];
      if (o.cap === 'l0') {
        kids.push(h('span', { class: 'nhm-node__icon' }, icon(o.icon)));
        // nhãn quản lý nằm ở dòng phụ để tên thiết bị có trọn chiều rộng
        kids.push(h('span', { class: 'nhm-node__stack' }, [h('span', { class: 'nhm-node__ten' }, o.ten), h('span', { class: 'nhm-node__phu' }, [o.tag || null, o.phu])]));
      } else {
        if (o.viTri) kids.push(h('span', { class: 'nhm-node__so', title: 'Vị trí số ' + o.viTri }, String(o.viTri)));
        if (o.cap === 'l2') kids.push(h('span', { class: 'nhm-node__icon' }, icon(o.icon))); // Rack / ngăn nhận ra nhờ ô số và đường nối, khỏi tốn chỗ cho biểu tượng
        kids.push(h('span', { class: 'nhm-node__ten' }, o.ten));
        kids.push(h('span', { class: 'nhm-node__meta', title: o.metaTitle || null }, o.meta));
        if (o.thanh != null) kids.push(h('span', { class: 'nhm-node__bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + o.thanh + '%' })));
      }
      return h('button', { type: 'button', class: cls, 'aria-current': o.on ? 'true' : null, title: o.ten, onclick: o.onclick }, kids);
    }

    function build(parentKey, depth) {
      var items = [];
      (kids[parentKey] || []).forEach(function (c) {
        var children = (kids[c.id] || []).length + (boxesBy[c.id] || []).length;
        var open = !!state.expanded[c.id];
        var la = state.sel && state.sel.type === 'container' && state.sel.id === c.id;
        var laGoc = c.parent_id == null;
        var tag = laGoc ? h('span', { class: 'nhm-tags' }, [
          h('span', { class: 'nhm-tag' + (c.rieng ? ' nhm-tag--rieng' : c.quan_ly_boi === 'cellbank' ? ' nhm-tag--cb' : '') }, c.rieng ? 'Riêng tư' : c.quan_ly_boi === 'cellbank' ? (c.don_vi_ten || 'Đơn vị') : 'Public'),
          c.canh_bao_nhiet ? h('span', { class: 'nhm-tag nhm-tag--canh', title: 'Đang có cảnh báo nhiệt độ' }, 'Cảnh báo') : null,
        ]) : null;
        var li = h('li', { role: 'treeitem', 'aria-expanded': children ? String(open) : null }, [
          nutCay({
            cap: laGoc ? 'l0' : 'l1', on: la, duong: !!duongTo[c.id] && !la, icon: laGoc ? 'tu' : 'ngan', ten: c.name, viTri: c.vi_tri,
            phu: c.type_name + ' · ' + tong[c.id] + ' mẫu', meta: String(tong[c.id]), metaTitle: tong[c.id] + ' mẫu', tag: tag, coCon: !!children, mo: open,
            onclick: function () { state.expanded[c.id] = la ? !open : true; select('container', c.id); },
          }),
        ]);
        if (open && children) {
          var ul = h('ul', { role: 'group' }, build(c.id, depth + 1));
          (boxesBy[c.id] || []).forEach(function (b) {
            var tongO = b.rows * b.cols;
            ul.appendChild(h('li', { role: 'treeitem' }, [nutCay({
              cap: 'l2', on: state.sel && state.sel.type === 'box' && state.sel.id === b.id, icon: 'hop', ten: b.name || b.code, viTri: b.vi_tri,
              meta: b.tube_count + '/' + tongO, metaTitle: b.tube_count + ' mẫu trên ' + tongO + ' ô', thanh: b.tube_count ? Math.max(6, Math.round((100 * b.tube_count) / tongO)) : 0,
              onclick: function () { select('box', b.id); },
            })]));
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
  /** Màn hình hẹp: sơ đồ kho GIỮ NGUYÊN (không tự gập); chọn đến Hộp thì cuộn xuống chi tiết để lưới hộp hiện ngay bên dưới. */
  function cuonToiChiTiet() {
    if (!window.matchMedia || !window.matchMedia('(max-width: 900px)').matches) return;
    setTimeout(function () { var d = $('nhm-detail'); if (d && d.scrollIntoView) d.scrollIntoView({ block: 'start' }); }, 60);
  }

  // ---------- khu vực chi tiết ----------
  /**
   * Giải thích cho người dùng thường ở thiết bị có đơn vị quản lý (Cellbank...): không tự thêm / lấy mẫu mà gửi yêu cầu, ai duyệt.
   * Chỉ hiện trên màn hình rộng (CSS ẩn ở màn hình hẹp để nhường chỗ cho sơ đồ). ten / nguoiDuyet lấy từ máy chủ.
   */
  function loiNhacDonVi(ten, nguoiDuyet) {
    return h('p', { class: 'nhm-hint nhm-hint--rong' }, (ten || 'Đơn vị quản lý') + ' quản lý: không tự thêm / lấy mẫu. Bấm vào mẫu để gửi yêu cầu; ' + (nguoiDuyet || 'người duyệt của đơn vị') + ' duyệt, kết quả báo qua email.');
  }

  function fact(label, value) { return h('div', { class: 'nhm-fact' }, [h('b', {}, label), value == null || value === '' ? '—' : String(value)]); }

  // ---------- bình nitơ lỏng: giá (rack) rồi hộp theo vị trí số, kèm mô hình xuyên thấu ----------
  var containerById = function (id) { return id == null ? null : state.tree.containers.filter(function (x) { return x.id === id; })[0] || null; };
  function gocCua(c) { for (var i = 0; c && c.parent_id != null && i < 50; i++) c = containerById(c.parent_id); return c; }
  var boDau = function (t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase(); };
  /** Vật chứa nằm trong (hoặc là) bình nitơ lỏng? Nhận biết theo tên LOẠI của thiết bị gốc («Bình nitơ lỏng»). */
  function trongBinhNito(c) { var g = gocCua(c); return !!g && boDau(g.type_name).indexOf('nito') >= 0; }
  /** Rack chứa vật chứa c: tổ tiên là con trực tiếp của bình. */
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

  // Kéo rộng / thu hẹp cửa sổ sau khi đã tải trang: sơ đồ bình tự mở khi màn hình rộng, gập khi hẹp (khỏi kẹt ở trạng thái cũ)
  if (window.matchMedia) {
    var mqHep = window.matchMedia('(max-width: 900px)');
    var doiCoMan = function (e) { Array.prototype.forEach.call(document.querySelectorAll('.nhm-ln'), function (d) { d.open = !e.matches; }); };
    if (mqHep.addEventListener) mqHep.addEventListener('change', doiCoMan);
    else if (mqHep.addListener) mqHep.addListener(doiCoMan);
  }

  /** Gắn mô hình bình vào bảng chi tiết nếu mục đang xem nằm trong bình nitơ; sel = {gia}|{hop}|null. */
  // ---------- sơ đồ thiết bị không phải bình nitơ lỏng (thiet-bi.js): tủ đứng, tủ nằm ngang, tủ lạnh nhiều ngăn ----------
  /** Mẫu thiết bị (danh mục trong /meta) của thiết bị gốc g; null nếu thiết bị tự khai. */
  function mauCua(g) { var ma = g && g.mau_tb; return ma ? (state.meta.mauThietBi || []).filter(function (m) { return m.ma === ma; })[0] || null : null; }
  /** Kiểu vẽ: theo mẫu; thiết bị tự khai thì đoán theo tên loại («nằm ngang», «2 ngăn»), còn lại là tủ đứng. */
  function kieuCua(g) {
    var m = mauCua(g);
    if (m) return m.kieu;
    var t = boDau(g.type_name);
    return t.indexOf('nam ngang') >= 0 ? 'tu_nam' : t.indexOf('2 ngan') >= 0 ? 'tu_lanh' : 'tu_dung';
  }
  function theoViTri(a, b) { return (a.vi_tri || 999) - (b.vi_tri || 999) || a.id - b.id; }
  function hopCua(containerId) {
    return state.tree.boxes.filter(function (b) { return b.container_id === containerId; }).sort(theoViTri)
      .map(function (b) { return { id: b.id, vi_tri: b.vi_tri, rows: b.rows, cols: b.cols, name: b.name, code: b.code }; });
  }
  /** Dữ liệu vẽ: ngăn (con của thiết bị) → Rack / giỏ / kệ (con của ngăn) → hộp; hộp đặt thẳng trong ngăn hoặc trong thiết bị vẫn được vẽ. */
  function duLieuThietBi(g) {
    var mau = mauCua(g);
    var ngan = state.tree.containers.filter(function (x) { return x.parent_id === g.id; }).sort(theoViTri);
    var khoang = ngan.map(function (n, i) {
      var km = mau && mau.khoang[(n.vi_tri || i + 1) - 1] || null;
      var ke = state.tree.containers.filter(function (x) { return x.parent_id === n.id; }).sort(theoViTri)
        .map(function (r) { return { id: r.id, name: r.name, vi_tri: r.vi_tri, boxes: hopCua(r.id) }; });
      return { id: n.id, ten: n.name, nhiet_do: n.temperature_c, so_ke: km ? km.so_ke : 0, loai_ke: km ? km.loai_ke : 'Rack', ke: ke, hop: hopCua(n.id) };
    });
    var hopGoc = hopCua(g.id);
    if (hopGoc.length) khoang.push({ id: g.id, ten: 'Trong thiết bị', nhiet_do: null, so_ke: 0, loai_ke: 'Rack', ke: [], hop: hopGoc });
    return { kieu: kieuCua(g), ten: g.name, mauTen: mau ? mau.ten : g.type_name, khoang: khoang };
  }
  /** Mục đang xem của vật chứa c trong thiết bị g: ngăn → {khoang}, Rack / giỏ (con của ngăn, kể cả vật chứa nằm sâu hơn) → {gia}. */
  function chonThietBi(c, g) {
    if (!c || c === g) return null;
    if (c.parent_id === g.id) return { khoang: c.id };
    var r = c;
    for (var i = 0; r && i < 50; i++) { var p = containerById(r.parent_id); if (p && p.parent_id === g.id) return { gia: r.id }; r = p; }
    return null;
  }
  /** Đặt khung sơ đồ (kèm vùng dock) vào cột phải của chi tiết; màn hình hẹp thì sau phần thông tin vị trí, trước lưới hộp. */
  function datCotPhai(root, det) {
    var cot = h('div', { class: 'nhm-cot-phai' }, [det, h('div', { class: 'nhm-dock' })]); // dưới sơ đồ là vùng để hộp thoại ống hiện ra (màn hình rộng)
    root.classList.add('nhm-detail--ln');
    var cuoiThongTin = root.querySelectorAll('.nhm-title, .nhm-hint');
    var moc = cuoiThongTin.length ? cuoiThongTin[cuoiThongTin.length - 1] : null;
    if (moc && moc.parentNode === root) root.insertBefore(cot, moc.nextSibling);
    else root.appendChild(cot);
  }
  /**
   * Kéo Rack trên sơ đồ sang ô (khoangId, so): ô trống thì chuyển sang đó; ô đã có Rack khác thì hoán đổi hai Rack
   * (tạm bỏ số của Rack đang kéo → Rack kia về chỗ cũ → Rack đang kéo vào ô mới), vì máy chủ không cho hai Rack trùng số trong một ngăn.
   */
  function doiViTriKe(keId, khoangId, so) {
    var r = containerById(keId);
    if (!r || (r.parent_id === khoangId && r.vi_tri === so)) return;
    var khac = state.tree.containers.filter(function (x) { return x.parent_id === khoangId && x.vi_tri === so && x.id !== keId; })[0];
    var ngan = containerById(khoangId);
    // hỏi xác nhận trước khi lưu: người có quyền chỉnh sửa rất dễ kéo / thả nhầm, nhất là trên điện thoại
    hoi('Chuyển «' + (r.name || 'Rack') + '» sang ô số ' + so + (ngan ? ' của «' + ngan.name + '»' : '') + (khac ? ', hoán đổi chỗ với «' + (khac.name || 'Rack khác') + '»' : '') + '?', function () { thucHienDoiViTri(r, khac, khoangId, so); });
  }
  function thucHienDoiViTri(r, khac, khoangId, so) {
    var keId = r.id;
    var patch = function (id, body) { return api('PATCH', '/containers/' + id, body); };
    var chuoi;
    if (!khac) chuoi = patch(keId, { parent_id: khoangId, vi_tri: so });
    else {
      var cu = { parent_id: r.parent_id, vi_tri: r.vi_tri || null };
      chuoi = (r.vi_tri ? patch(keId, { vi_tri: null }) : Promise.resolve())
        .then(function () { return patch(khac.id, cu); })
        .then(function () { return patch(keId, { parent_id: khoangId, vi_tri: so }); });
    }
    return chuoi
      .then(function () { say((r.name || 'Rack') + (khac ? ' đã hoán đổi chỗ với ' + (khac.name || 'Rack khác') : ' đã chuyển sang ô số ' + so) + '.'); return reload(true); })
      .catch(function (e) { say(e.message, 'err'); return reload(true); });
  }
  function ganThietBi(root, c, selHop) {
    var g = gocCua(c);
    if (!g || !window.NhmThietBi) return;
    var tom = h('span', { class: 'nhm-ln__tom' });
    var quanLy = !!(state.meta.canManage || g.quan_ly_duoc); // kéo Rack / thêm Rack vào ô trống chỉ cho người quản lý thiết bị
    var m = window.NhmThietBi.tao(duLieuThietBi(g), {
      khiChon: function (t) { tom.textContent = t; },
      chonKhoang: function (id) { state.expanded[g.id] = true; select('container', id); },
      chonKe: function (id) { state.expanded[g.id] = true; select('container', id); },
      chonHop: function (id) { state.expanded[g.id] = true; select('box', id); },
      keoKe: quanLy ? doiViTriKe : null,
      themKe: quanLy ? function (khoangId, so) { containerForm(null, khoangId, so); } : null,
    });
    state.ln = m;
    m.chon(selHop || chonThietBi(c, g));
    var det = h('details', { class: 'nhm-ln' }, [h('summary', {}, [h('span', { class: 'nhm-ln__tit' }, 'Sơ đồ ' + g.name), tom]), m.node]);
    det.open = !window.matchMedia('(max-width: 900px)').matches; // máy tính: mở sẵn; điện thoại: gập lại
    datCotPhai(root, det);
  }

  /**
   * Ô «Mẫu thiết bị» ở đầu form thêm thiết bị gốc: chọn mẫu (bình nitơ lỏng, tủ âm sâu -86°C 2 ngăn, tủ -20°C nằm ngang 2 cánh, tủ lạnh -20°C / 4°C…)
   * thì loại và nhiệt độ theo mẫu, các ngăn được tạo kèm; có xem trước sơ đồ. «Thiết bị khác» thì tự khai loại và nhiệt độ như trước.
   */
  function chonMauThietBi() {
    var ds = state.meta.mauThietBi || [];
    var nhom = state.meta.nhomThietBi || {};
    var sel = h('select', { 'aria-label': 'Mẫu thiết bị' }, [h('option', { value: '' }, 'Thiết bị khác (tự khai loại và nhiệt độ)')].concat(Object.keys(nhom).map(function (k) {
      return h('optgroup', { label: nhom[k] }, ds.filter(function (m) { return m.nhom === k; }).map(function (m) { return h('option', { value: m.ma }, m.ten); }));
    })));
    var xem = h('div', { class: 'nhm-mau-xem' });
    var tuDat = null;
    sel.addEventListener('change', function () {
      var m = ds.filter(function (x) { return x.ma === sel.value; })[0];
      var form = $('nhm-dialog');
      var loai = form.querySelector('[name="type_id"]');
      var nhiet = form.querySelector('[name="temperature_c"]');
      if (loai) loai.disabled = !!m; // loại theo mẫu (máy chủ bỏ qua loại gửi lên khi có mẫu)
      if (!m) { put(xem); if (nhiet && nhiet.value === tuDat) nhiet.value = ''; tuDat = null; return; }
      var t = (state.meta.containerTypes || []).filter(function (x) { return x.name === m.loai_goc; })[0];
      if (loai && t) loai.value = String(t.id);
      if (nhiet && (!nhiet.value || nhiet.value === tuDat)) { nhiet.value = m.nhiet_do != null ? m.nhiet_do : ''; tuDat = nhiet.value; }
      var hinh = m.kieu === 'binh_ln' ? (window.NhmBinhLn ? window.NhmBinhLn.tao({ tank: { name: '' }, racks: [] }, {}).node : null) : window.NhmThietBi ? window.NhmThietBi.xemTruoc(m) : null;
      put(xem,
        hinh,
        h('p', { class: 'nhm-small' }, m.mo_ta),
        m.hang ? h('p', { class: 'nhm-small nhm-muted' }, 'Dòng máy tham khảo: ' + m.hang + '. Số ngăn, số kệ thực tế tùy model: thêm hoặc xóa Rack / giỏ sau khi tạo.') : null,
        m.khoang.length ? h('p', { class: 'nhm-small nhm-muted' }, 'Tạo kèm ' + m.khoang.length + ' ngăn: ' + m.khoang.map(function (k) { return k.ten + (k.nhiet_do != null ? ' (' + k.nhiet_do + '°C)' : ''); }).join(', ') + '. Thêm ' + m.khoang[0].loai_ke + ' rồi hộp vào từng ngăn sau.') : h('p', { class: 'nhm-small nhm-muted' }, 'Thêm Rack rồi thêm hộp vào Rack sau khi tạo.'));
    });
    return { node: h('div', {}, [sel, xem]), get: function () { return sel.value; } };
  }

  function ganBinh(root, containerId, sel) {
    root.classList.remove('nhm-detail--ln');
    state.ln = null;
    var c = containerById(containerId);
    if (c && !trongBinhNito(c)) return ganThietBi(root, c, sel); // tủ đứng, tủ nằm ngang, tủ lạnh nhiều ngăn…
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
    det.open = !window.matchMedia('(max-width: 900px)').matches; // máy tính: mở sẵn; điện thoại: gập lại
    datCotPhai(root, det);
  }

  function renderDetail() {
    var dlg = $('nhm-dialog');
    if (dlg && dlg.classList.contains('nhm-dialog--dock') && dlg.parentNode !== document.body) document.body.appendChild(dlg); // cất tạm để không mất khi vẽ lại cột phải
    veChiTiet();
    giuHopThoaiDock();
  }

  function veChiTiet() {
    var box = $('nhm-detail');
    box.style.removeProperty('--nhm-cols'); // số cột lưới hộp (đặt lại khi xem hộp) để cột trái vừa khít lưới
    var sel = state.sel;
    if (state.search) return renderSearch(box);
    if (state.cv) return renderCongViec(box);
    if (state.dtb) return renderDongTeBao(box);
    if (!sel) { put(box, h('p', { class: 'nhm-muted' }, 'Chọn một thiết bị, vị trí lưu trữ hoặc hộp ở bên trái.')); return; }
    if (sel.type === 'box') { renderBox(box); if (state.box && state.box.box) box.style.setProperty('--nhm-cols', state.box.box.cols); ganBinh(box, state.box && state.box.box ? state.box.box.container_id : null, { hop: sel.id }); return; }
    var c = state.tree.containers.filter(function (x) { return x.id === sel.id; })[0];
    if (!c) { put(box, h('p', { class: 'nhm-muted' }, 'Không còn mục này.')); return; }
    var boxes = state.tree.boxes.filter(function (b) { return b.container_id === c.id; }).sort(function (a, b) { return (a.vi_tri || 999) - (b.vi_tri || 999); });
    var subs = state.tree.containers.filter(function (x) { return x.parent_id === c.id; });
    var m = state.meta.canManage || c.quan_ly_duoc;
    var actions = m ? h('div', { class: 'nhm-actions' }, [
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { containerForm(null, c.id); } }, '+ Ngăn / Rack bên trong'),
      h('button', { class: 'nhm-btn nhm-btn--primary', type: 'button', onclick: function () { boxForm(c.id); } }, '+ Hộp'),
      h('button', { class: 'nhm-btn', type: 'button', onclick: function () { moDotKiemKe(c.id); } }, 'Mở đợt kiểm kê'),
      h('button', { class: 'nhm-btn', type: 'button', onclick: function () { containerForm(c); } }, 'Chỉnh sửa'),
      h('button', { class: 'nhm-btn nhm-btn--danger', type: 'button', onclick: function () { deleteContainer(c); } }, 'Xóa'),
    ]) : null;
    var cb = c.quan_ly_boi === 'cellbank';
    put(box,
      h('div', { class: 'nhm-title' }, [h('h2', {}, c.name), h('span', { class: 'nhm-muted' }, c.type_name + ' · ' + c.code)]),
      cb && !m && !c.duoc_don_vi ? loiNhacDonVi(c.don_vi_ten, c.don_vi_duyet) : null,
      actions,
      subs.length ? h('div', { class: 'nhm-inside' }, [h('h3', {}, 'Bên trong'), h('ul', {}, subs.map(function (x) {
        return h('li', {}, h('button', { type: 'button', class: 'nhm-sub', onclick: function () { state.expanded[c.id] = true; state.expanded[x.id] = true; select('container', x.id); } },
          [icon('ngan'), h('span', { class: 'nhm-sub__name' }, x.name), h('span', { class: 'nhm-muted nhm-small' }, x.type_name)]));
      }))]) : null,
      // hộp nằm trực tiếp trong vị trí này (vd Rack): liệt kê để bấm vào xem lưới hộp, không để khung giữa trống
      boxes.length ? h('div', { class: 'nhm-inside' }, [h('h3', {}, 'Hộp trong ' + c.name + ' (' + boxes.length + ')'), h('ul', {}, boxes.map(function (b) {
        return h('li', {}, h('button', { type: 'button', class: 'nhm-sub', onclick: function () { state.expanded[c.id] = true; select('box', b.id); } },
          [icon('hop'), h('span', { class: 'nhm-sub__name' }, (b.vi_tri ? b.vi_tri + ' · ' : '') + (b.name || b.code)),
            h('span', { class: 'nhm-muted nhm-small' }, b.rows + '×' + b.cols + ' · ' + b.tube_count + '/' + b.rows * b.cols + ' mẫu')]));
      }))]) : null,
      boxes.length || subs.length ? null : h('p', { class: 'nhm-muted' }, 'Chưa có Hộp.' + (m ? ' Bấm «+ Hộp» để thêm.' : ''))
    );
    ganBinh(box, c.id, null);
    if (c.parent_id == null) box.appendChild(nhietDoPanel(c)); // nhiệt độ chỉ ghi cho thiết bị gốc (tủ, bình)
  }

  function renderBox(root) {
    var info = state.box;
    if (!info) { put(root, h('div', { class: 'nhm-loading' }, 'Đang tải hộp…')); return; }
    var b = info.box, byPos = {};
    $('nhm-crumb').textContent = info.path.concat([b.name || b.code]).join(' › ');
    info.tubes.forEach(function (t) { byPos[t.row_no + ',' + t.col_no] = t; });
    (info.phat_hien || []).forEach(function (p) { byPos[p.row_no + ',' + p.col_no] = { phat_hien: p }; });
    var m = state.meta.canManage || info.quan_ly_duoc;
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
        h('span', {}, (state.audit.dot ? 'Đang kiểm kê trong một đợt. ' : 'Đang kiểm kê hộp. ') + 'Kiểm tra thực tế, bấm vào những mẫu KHÔNG thấy (chuyển sang gạch đỏ). Mẫu không bấm là có mặt. Đã đánh dấu không thấy: ' + Object.keys(state.audit.khong).length + ' / ' + dem + ' mẫu.'),
        h('span', { class: 'nhm-notice-act' }, [
          nutNho('Hoàn tất kiểm kê', 'primary', function () { hoanTatKiemKe(info); }),
          nutNho(state.audit.dot ? 'Về đợt kiểm kê' : 'Thoát', '', function () { var dot = state.audit.dot; state.audit = null; if (dot) { moCongViec('kiemke'); state.cv.moDot = dot; } else renderDetail(); }),
        ]),
      ]),
    ]) : null;
    put(root,
      h('div', { class: 'nhm-title' }, [h('h2', {}, b.name || b.code), h('span', { class: 'nhm-muted' }, (b.name ? b.code + ' · ' : '') + b.rows + '×' + b.cols + ' · ' + info.tubes.length + ' mẫu' + (cb ? ' · ' + (info.don_vi_ten || 'Đơn vị quản lý') : ''))]),
      cb && !m && !info.duoc_don_vi ? loiNhacDonVi(info.don_vi_ten, info.don_vi_duyet) : null,
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
    var dot = state.audit.dot;
    var gui = function () {
      // đang kiểm trong một đợt: ghi vào đợt (có tiến độ) rồi quay lại danh sách hộp của đợt; không thì kiểm kê hộp lẻ
      api('POST', dot ? '/inventories/' + dot + '/boxes/' + info.box.id : '/boxes/' + info.box.id + '/audit', { thay: thay, khong_thay: khong })
        .then(function (r) {
          state.audit = null;
          say('Đã kiểm kê: ' + r.thay + ' có mặt, ' + r.khong_thay + ' không thấy (' + r.vu_viec_moi + ' vụ việc mới).', 'ok');
          if (dot) { taiMe(); moCongViec('kiemke'); state.cv.moDot = dot; return; }
          return reload(true).then(taiMe);
        })
        .catch(function (e) { say(e.message, 'err'); });
    };
    if (khong.length) hoi('Có ' + khong.length + ' mẫu không thấy: hệ thống sẽ mở vụ việc nghi mất và gửi thông báo cho chủ mẫu. Tiếp tục?', gui);
    else gui();
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
      if (info && info.quan_ly_boi === 'cellbank' && !state.meta.canManage && !info.duoc_don_vi) { say('Thiết bị này do ' + (info.don_vi_ten || 'đơn vị quản lý') + ' quản lý: chỉ quản lý module mới thêm mẫu. Bạn có thể gửi yêu cầu cho mẫu đã có.', 'err'); return; }
      tubeForm(box, r, c);
    };
    el.addEventListener('click', open);
    var lnChon = function () { if (state.ln) state.ln.chon({ hop: box.id, row: r, col: c }); };
    ['mouseenter', 'focus', 'click'].forEach(function (ev) { el.addEventListener(ev, lnChon); });
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    if (!kk && t && t.can_edit && t.status === 'in_storage' && !(info && info.quan_ly_boi === 'cellbank' && !state.meta.canManage && !info.duoc_don_vi)) {
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
  function containerForm(c, parentId, viTriGoiY) {
    var typeOpts = state.meta.containerTypes.map(function (t) { return { value: t.id, label: t.name }; });
    var chonMau = !c && !parentId ? chonMauThietBi() : null; // thiết bị gốc mới: chọn mẫu (tạo kèm các ngăn, vẽ sơ đồ)
    openForm({
      title: c ? 'Chỉnh sửa vị trí lưu trữ' : parentId ? 'Thêm vị trí lưu trữ con' : 'Thêm thiết bị lưu trữ',
      fields: (chonMau ? [{ name: 'mau', label: 'Mẫu thiết bị', type: 'custom', widget: chonMau }] : []).concat([
        { name: 'name', label: 'Tên', required: true, value: c && c.name },
        { name: 'type_id', label: 'Loại', type: 'select', options: typeOpts, value: c ? c.type_id : typeOpts[0] && typeOpts[0].value },
        { name: 'code', label: 'Mã (để trống để tự sinh)', value: c && c.code },
        { name: 'temperature_c', label: 'Nhiệt độ (°C)', type: 'number', value: c && c.temperature_c },
        { name: 'location_note', label: 'Vị trí đặt (phòng…)', value: c && c.location_note },
        { name: 'notes', label: 'Ghi chú', type: 'textarea', value: c && c.notes },
      ]).concat(viTriGiaField(c, parentId, viTriGoiY)).concat(!parentId && (!c || c.parent_id == null) && !state.meta.khongPublic ? [
        // chỉ thiết bị gốc; ngăn, giá bên trong thừa hưởng
        { name: 'don_vi_id', label: 'Ai quản lý thiết bị này', type: 'select', value: c && c.rieng ? 'rieng' : c && c.don_vi_id ? String(c.don_vi_id) : '',
          options: [{ value: '', label: 'Public — ai cũng thêm mẫu vào ô trống' }].concat(state.meta.laVienTruong ? [{ value: 'rieng', label: 'Riêng tư — không hiện với người khác' }] : []).concat((state.meta.donVi || []).map(function (d) {
            return { value: String(d.id), label: d.ten + ' quản lý — người dùng gửi yêu cầu, người duyệt của đơn vị quyết định' };
          })) },
      ] : []),
      onSubmit: function (v) {
        var body = { name: v.name, type_id: Number(v.type_id), code: v.code || undefined, temperature_c: v.temperature_c, location_note: v.location_note, notes: v.notes };
        if ('vi_tri' in v) body.vi_tri = v.vi_tri === '' || v.vi_tri == null ? null : Number(v.vi_tri);
        if (v.mau) body.mau_tb = v.mau;
        if ('don_vi_id' in v) {
          if (v.don_vi_id === 'rieng') { body.rieng = true; body.don_vi_id = null; }
          else {
            body.don_vi_id = v.don_vi_id === '' ? null : Number(v.don_vi_id);
            if (c && c.rieng) body.rieng = false; // đang riêng tư mà chọn Public / đơn vị: bỏ riêng tư
          }
        }
        if (c) { if (!v.code) delete body.code; return api('PATCH', '/containers/' + c.id, body).then(function () { return reload(true); }); }
        if (parentId) body.parent_id = parentId;
        return api('POST', '/containers', body).then(function (r) { if (parentId) state.expanded[parentId] = true; say('Đã thêm vị trí lưu trữ.', 'ok'); return reload(true).then(function () { select('container', r.id); }); });
      },
    });
  }

  /** Ô «vị trí số» cho giá trong bình nitơ (thêm giá con trực tiếp của bình, hoặc sửa một giá); khác thì không có ô. */
  function viTriGiaField(c, parentId, goiY) {
    var cha = parentId != null ? containerById(parentId) : c ? containerById(c.parent_id) : null;
    // Rack / giỏ / kệ nằm trong NGĂN của tủ (không phải bình nitơ lỏng): vị trí số trong ngăn (không bắt buộc) để vẽ đúng chỗ trên sơ đồ
    if (cha && cha.parent_id != null && containerById(cha.parent_id) && containerById(cha.parent_id).parent_id == null && !trongBinhNito(cha)) {
      var goc = containerById(cha.parent_id), mau = mauCua(goc), km = mau && mau.khoang[(cha.vi_tri || 1) - 1];
      var dung = state.tree.containers.filter(function (x) { return x.parent_id === cha.id && (!c || x.id !== c.id) && x.vi_tri; }).map(function (x) { return x.vi_tri; });
      var ten = km ? km.loai_ke.toLowerCase() : 'Rack';
      return [{ name: 'vi_tri', label: 'Vị trí ' + ten + ' trong ngăn (số 1–' + (km ? Math.max(km.so_ke, 12) : 12) + ', ' + (kieuCua(goc) === 'tu_nam' ? '1 ở bên trái' : '1 ở trên cùng') + '; để trống nếu chưa rõ)', type: 'number', value: c && c.vi_tri ? c.vi_tri : goiY || (dung.length ? Math.max.apply(null, dung) + 1 : 1) }];
    }
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
        { name: 'vi_tri', label: 'Vị trí hộp trong Rack / giỏ (số 1–50, 1 ở trên cùng hoặc bên trái; để trống nếu chưa rõ; chỉ khi thêm một hộp)', type: 'number' },
        { name: 'notes', label: 'Ghi chú', type: 'textarea' },
      ],
      onSubmit: function (v) {
        return api('POST', '/boxes', { container_id: containerId, template_id: Number(v.template_id), name: v.name, count: Number(v.count) || 1, notes: v.notes, vi_tri: v.vi_tri === '' || v.vi_tri == null ? undefined : Number(v.vi_tri) })
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
    var chu = tube ? null : (nganHang === 'khang_the' && !(opts && opts.claimId) ? chuMauKhangThe() : chuMauWidget(state.groups || []));
    var nhomOpts = [{ value: '', label: '— không —' }].concat((state.groups || []).map(function (g) { return { value: g.id, label: g.ten }; }));
    var kt = nganHang === 'khang_the';
    var fields = [
      { name: 'name', label: kt ? 'Tên kháng thể' : 'Tên mẫu', required: true, value: tube && tube.name },
      { name: 'sample_type_id', label: 'Loại mẫu', type: 'select', options: sampleTypeOptions(), value: tube ? (tube.sample_type_id || '') : '' },
    ].concat(kt ? (tube ? [] : [{ name: 'the_tich_ul', label: 'Thể tích ban đầu của ống (µL)', type: 'number', required: true }]) : [
      { name: 'passage', label: 'Passage', value: tube && tube.passage },
      { name: 'cell_count', label: 'Số tế bào', type: 'number', value: tube && tube.cell_count },
      { name: 'volume_ml', label: 'Thể tích (mL)', type: 'number', value: tube && tube.volume_ml },
    ]).concat(kt ? [] : [{ name: 'freeze_date', label: 'Ngày đông lạnh', type: 'date', value: tube && tube.freeze_date }]).concat([
      { name: 'project', label: 'Đề tài / dự án', value: tube && tube.project },
      { name: 'notes', label: 'Ghi chú', type: 'textarea', value: tube && tube.notes },
    ]);
    if (tube && quanLy) {
      if (kt) fields.push({ name: 'chu_mau', label: 'Chủ mẫu (chỉ quản lý đổi)', type: 'select', value: tube.chu_don_vi ? 'don_vi' : 'ca_nhan',
        options: [{ value: 'don_vi', label: 'AntibodyBank (mặc định)' }, { value: 'ca_nhan', label: 'Cá nhân (mua bằng kinh phí cá nhân, xung công quỹ)' }] });
      // loại chủ và nhóm quyết định ai duyệt yêu cầu về mẫu: chỉ quản lý đổi
      fields.push({ name: 'chu_loai', label: kt ? 'Loại chủ mẫu — chỉ khi chủ mẫu là cá nhân' : 'Loại chủ mẫu (chỉ quản lý đổi)', type: 'select', value: tube.chu_loai || '',
        options: [{ value: '', label: '— chưa xác định —' }].concat(LOAI_CHU.map(function (l) { return { value: l[0], label: l[1] }; })) });
      fields.push({ name: 'nhom_id', label: kt ? 'Nhóm nghiên cứu — chỉ khi chủ mẫu là cá nhân' : 'Nhóm nghiên cứu (chỉ quản lý đổi)', type: 'select', options: nhomOpts, value: tube.nhom_id || '' });
    }
    if (!kt && !claim) fields.unshift({ name: 'dongLo', label: 'Dòng tế bào và lô (nếu mẫu thuộc một dòng)', type: 'custom', widget: chonDongLo(tube) });
    if (!tube) {
      // Thêm cùng lô: n ống liên tiếp từ ô này (sang hàng kế khi hết cột)
      if (!claim) fields.push({ name: 'count', label: 'Số ống cùng lô (1–100, đặt vào các ô liên tiếp từ ô này)', type: 'number', value: 1 });
      fields.push({ name: 'chu', label: 'Chủ mẫu', type: 'custom', widget: chu });
    }
    openForm({
      title: tube ? 'Chỉnh sửa thông tin mẫu' : (claim ? 'Nhận và khai báo mẫu tại ' : 'Thêm mẫu tại ') + posLabel(r, c),
      dock: true,
      fields: fields,
      extraButtons: !tube && !claim && quanLy ? [h('button', { type: 'button', class: 'nhm-btn', onclick: function () { phatHienForm(box, r, c); } }, 'Ô này có mẫu nhưng chưa khai báo')] : [],
      onSubmit: function (v) {
        var body = { name: v.name, sample_type_id: v.sample_type_id === '' ? null : Number(v.sample_type_id), passage: v.passage,
          cell_count: v.cell_count, volume_ml: v.volume_ml, freeze_date: v.freeze_date, project: v.project, notes: v.notes };
        if (kt) { delete body.passage; delete body.cell_count; delete body.volume_ml; }
        if (!kt && v.dongLo) { if (v.dongLo.loi) return Promise.reject(new Error(v.dongLo.loi)); body.lo_id = v.dongLo.lo_id ? Number(v.dongLo.lo_id) : null; }
        if (kt && !tube) body.the_tich_ul = v.the_tich_ul;
        if (tube) {
          if (quanLy) { body.chu_loai = v.chu_loai || null; body.nhom_id = v.nhom_id === '' ? null : Number(v.nhom_id); }
          if (kt && quanLy) { body.chu_don_vi = v.chu_mau === 'don_vi'; if (body.chu_don_vi) { delete body.chu_loai; delete body.nhom_id; } }
          return api('PATCH', '/tubes/' + tube.id, body).then(function () { say('Đã cập nhật thông tin mẫu.', 'ok'); return reload(true); });
        }
        var n = claim ? 1 : Number(v.count) || 1;
        return (kt && !claim ? chuMauBodyKt(v.chu) : chuMauBody(v.chu)).then(function (extra) {
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
    kt_ban_dau: 'Ghi thể tích ban đầu', kt_dung: 'Dùng kháng thể', kt_dieu_chinh: 'Đo lại thể tích', kt_het: 'Ống hết',
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
        return hoiP(canhBao).then(function () { return api('POST', '/tubes/' + t.id + '/' + act, { note: v.note }); }).then(function () { say(title + ' thành công.', 'ok'); return reload(true); });
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

  // ---------- thể tích (µL) của ống kháng thể ----------
  function ul(n) { return n == null ? '—' : String(n).replace('.', ',') + ' µL'; }
  var TT_TEN = { chua_ghi: 'Chưa ghi thể tích', con: 'Còn', sap_het: 'Sắp hết', het: 'Hết' };
  var SO_TEN = { ban_dau: 'Thể tích ban đầu', dung: 'Dùng', dieu_chinh: 'Đo lại', het: 'Ống hết' };

  /** Khối «Thể tích» trong hộp thoại mẫu: còn lại / ban đầu, thanh, trạng thái, sổ; quản lý có nút ghi. */
  function theTichPanel(t) {
    var khung = h('div', { class: 'nhm-tt' }, h('span', { class: 'nhm-muted' }, 'Đang tải thể tích…'));
    function veLai() {
      api('GET', '/tubes/' + t.id + '/volume').then(function (v) {
        var quanLy = state.meta.canManage, trongKho = t.status === 'in_storage' || t.status === 'checked_out';
        var nut = [];
        if (quanLy && trongKho) {
          if (v.trang_thai === 'chua_ghi') nut.push(nutNho('Ghi thể tích ban đầu', 'primary', function () { ulForm(t, 'initial', v); }));
          else {
            nut.push(nutNho('Ghi lần dùng', 'primary', function () { ulForm(t, 'use', v); }));
            nut.push(nutNho('Đo lại', '', function () { ulForm(t, 'adjust', v); }));
          }
          nut.push(nutNho('Đánh dấu hết', 'danger', function () { ulForm(t, 'finish', v); }));
        }
        var dong = v.so.map(function (x) {
          return h('tr', {}, [gioDia(x.created_at), SO_TEN[x.hanh_dong] || x.hanh_dong, (x.so_ul > 0 ? '+' : '') + String(x.so_ul).replace('.', ','), ul(x.con_lai_ul),
            [x.nguoi_dung_label ? 'Cho ' + x.nguoi_dung_label : '', x.yeu_cau_id ? 'Yêu cầu #' + x.yeu_cau_id : '', x.ghi_chu || ''].filter(Boolean).join(' · '), x.user_label || '']
            .map(function (c, i) { return h('td', { 'data-l': ['Thời gian', 'Việc', 'Thay đổi (µL)', 'Còn lại', 'Chi tiết', 'Người ghi'][i] }, c); }));
        });
        put(khung,
          h('div', { class: 'nhm-tt-head' }, [
            h('strong', {}, 'Thể tích'),
            h('span', { class: 'nhm-chip nhm-tt-chip nhm-tt-chip--' + v.trang_thai }, TT_TEN[v.trang_thai] || v.trang_thai),
          ]),
          v.the_tich_ul != null ? h('div', { class: 'nhm-tt-so' }, [h('b', {}, ul(v.con_lai_ul)), ' còn lại / ' + ul(v.the_tich_ul) + ' ban đầu']) : h('p', { class: 'nhm-hint' }, 'Chưa ghi thể tích. Quản lý ghi thể tích ban đầu để theo dõi số µL đã dùng và còn lại.'),
          v.the_tich_ul != null ? h('div', { class: 'nhm-tt-bar nhm-tt-bar--' + v.trang_thai, role: 'img', 'aria-label': 'Còn ' + Math.round((v.ty_le || 0) * 100) + '% thể tích' }, h('span', { style: 'width:' + Math.round((v.ty_le || 0) * 100) + '%' })) : null,
          nut.length ? h('div', { class: 'nhm-card-act' }, nut) : null,
          dong.length ? h('details', { class: 'nhm-tt-so-ct' }, [h('summary', {}, 'Sổ thể tích (' + dong.length + ')'),
            h('table', { class: 'nhm-hist' }, [h('tr', {}, ['Thời gian', 'Việc', 'Thay đổi (µL)', 'Còn lại', 'Chi tiết', 'Người ghi'].map(function (x) { return h('th', {}, x); }))].concat(dong))]) : null);
      }).catch(function (e) { put(khung, h('div', { class: 'nhm-err' }, e.message)); });
    }
    veLai();
    return khung;
  }

  /** Form ghi thể tích: initial | use | adjust | finish. */
  function ulForm(t, loai, v) {
    var cau = {
      initial: { tieuDe: 'Ghi thể tích ban đầu', nut: 'Ghi', f: [{ name: 'the_tich_ul', label: 'Thể tích ban đầu của ống (µL)', type: 'number', required: true }] },
      use: { tieuDe: 'Ghi lần dùng', nut: 'Ghi lần dùng', f: [
        { name: 'so_ul', label: 'Số µL đã dùng (còn ' + ul(v.con_lai_ul) + ')', type: 'number', required: true },
        { name: 'ghi_chu', label: 'Dùng cho việc gì / của ai (không bắt buộc)', type: 'textarea' }] },
      adjust: { tieuDe: 'Đo lại thể tích', nut: 'Lưu', f: [
        { name: 'con_lai_ul', label: 'Số µL còn lại sau khi đo (đang ghi ' + ul(v.con_lai_ul) + '; nhập 0 nếu đã cạn)', type: 'number', required: true },
        { name: 'ly_do', label: 'Lý do / cách đo (bắt buộc, ghi vào sổ)', type: 'textarea', required: true }] },
      finish: { tieuDe: 'Đánh dấu ống hết', nut: 'Đánh dấu hết, bỏ ống khỏi kho', f: [
        { name: 'ly_do', label: 'Lý do (dùng hết, hỏng, nhiễm…). Ống rời khỏi hộp, phần còn lại ' + ul(v.con_lai_ul) + ' bị xóa sổ; lịch sử vẫn được giữ.', type: 'textarea', required: true }] },
    }[loai];
    openForm({
      title: cau.tieuDe + ': ' + t.name,
      fields: cau.f,
      submitLabel: cau.nut,
      onSubmit: function (x) {
        return hoiP(loai === 'finish' ? 'Ống «' + t.name + '» sẽ bị bỏ khỏi kho và không hoàn tác được. Tiếp tục?' : null).then(function () { return api('POST', '/tubes/' + t.id + '/volume/' + loai, x); }).then(function (r) {
          say(r && r.het ? 'Đã ghi. Ống hết nên được bỏ khỏi kho.' : 'Đã ghi thể tích.', 'ok');
          return reload(true).then(function () { if (!(r && r.het) && loai !== 'finish') moMauTheoId(t.id); });
        });
      },
    });
  }

  function tubeDialog(box, t) {
    var body = h('div', {}, [
      nganHang !== 'khang_the' && t.dong_id ? dongLoPanel(t) : null,
      h('div', { class: 'nhm-facts' }, [
        fact('Vị trí', posLabel(t.row_no, t.col_no)), fact('Trạng thái', (STATUS_VN[t.status] || t.status) + (t.nghi_mat ? ' — NGHI MẤT' : '')), fact('Loại mẫu', t.sample_type_name),
        fact(nganHang === 'khang_the' ? 'Chủ mẫu' : 'Loại chủ mẫu', t.chu_don_vi ? 'Đơn vị ' + (t.owner_name || 'AntibodyBank') : (nganHang === 'khang_the' ? 'Cá nhân · ' : '') + loaiChuVN(t.chu_loai)),
      ].concat(t.chu_don_vi ? [] : [fact('Nhóm nghiên cứu', t.nhom_ten)])
        .concat(nganHang === 'khang_the' ? [] : [fact('Passage', t.passage), fact('Số tế bào', t.cell_count), fact('Thể tích (mL)', t.volume_ml), fact('Ngày đông lạnh', t.freeze_date)])
        .concat((t.chu_don_vi ? [] : [fact('Người sở hữu', t.owner_name)]).concat([fact('Đề tài', t.project), fact('Ghi chú', t.notes)])
      )),
      nganHang === 'khang_the' ? theTichPanel(t) : null,
      h('strong', {}, 'Lịch sử thao tác'),
      h('div', { id: 'nhm-hist' }, h('span', { class: 'nhm-muted' }, 'Đang tải…')),
    ]);
    var btn = function (label, cls, fn) { return h('button', { type: 'button', class: 'nhm-btn' + (cls ? ' nhm-btn--' + cls : ''), onclick: fn }, label); };
    var buttons = [];
    var cbKhoa = state.box && state.box.quan_ly_boi === 'cellbank' && !state.meta.canManage && !state.box.duoc_don_vi; // mẫu ở thiết bị Cellbank: người dùng thường chỉ sửa mô tả
    var laChu = state.me && t.owner_user_id === state.me.id;
    if (t.can_edit) {
      buttons.push(btn('Chỉnh sửa', '', function () { tubeForm(box, t.row_no, t.col_no, t); }));
      if (t.status === 'in_storage' && !cbKhoa) {
        buttons.push(btn('Di chuyển', '', function () { moveForm(box, t); }));
        buttons.push(btn('Lấy ra', '', function () { trangThaiForm(t, 'checkout', 'Lấy mẫu ra', 'Lấy ra'); }));
      }
      if (t.status === 'checked_out' && !cbKhoa) buttons.push(btn('Trả lại', '', function () { trangThaiForm(t, 'checkin', 'Trả mẫu lại kho', 'Trả lại'); }));
      if (!cbKhoa) {
        if (nganHang !== 'khang_the') buttons.push(btn('Rã đông', '', function () { trangThaiForm(t, 'thaw', 'Rã đông mẫu', 'Rã đông', 'Rã đông là không hoàn tác: mẫu sẽ rời khỏi hộp và nhả ô. Tiếp tục?'); }));
        buttons.push(btn('Hủy mẫu', 'danger', function () { trangThaiForm(t, 'discard', 'Hủy mẫu', 'Hủy mẫu', 'Hủy mẫu là không hoàn tác: mẫu sẽ rời khỏi hộp và nhả ô. Tiếp tục?'); }));
        buttons.push(btn('Xóa', 'danger', function () { deleteTube(t); }));
      }
      if (t.status === 'in_storage' && !t.nghi_mat) buttons.push(btn('Báo không còn ở vị trí', '', function () { baoMatForm(t); }));
    }
    // người khác muốn lấy mẫu: gửi yêu cầu (quản lý tự thao tác được nên không cần)
    // (chủ mẫu có mẫu ở thiết bị Cellbank cũng phải gửi yêu cầu vì không được tự lấy)
    if ((!laChu || cbKhoa) && !state.meta.canManage && !(state.box && state.box.duoc_don_vi) && t.status === 'in_storage' && !t.nghi_mat) buttons.unshift(btn('Yêu cầu lấy mẫu này', 'primary', function () { xinMauForm(t); }));
    if (t.nghi_mat) buttons.unshift(btn('Mẫu nghi mất — xem vụ việc', 'danger', function () { closeDialog(); moCongViec('nghimat'); }));
    if (state.meta.canManage) buttons.push(btn('Chuyển chủ', '', function () { transferForm(t); }));
    openInfo(t.name, body, buttons, true, true);
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
  function confirmThen(msg, fn) { hoi(msg, function () { fn().catch(function (e) { say(e.message, 'err'); }); }); }

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
    state.dtb = null;
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
      state.meta.canManage ? h('button', { type: 'button', class: 'nhm-btn', onclick: function () { window.location.href = API + '/tubes/export.csv?nh=' + nganHang + '&' + timKiemQuery(p, false); } }, 'Xuất CSV') : null,
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
  var VAI_TRO_VN = { quan_ly: 'Quản lý module', truong_cellbank: 'Trưởng CIPP (Cellbank)', vien_truong: 'Viện trưởng (thiết bị riêng)' };

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
                hoi('Xóa "' + x.name + '"?', function () { api('DELETE', '/' + dm.path + '/' + x.id).then(function () { say('Đã xóa.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; }); });
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
        { name: 'chuc_danh', label: 'Lời chào ở đầu trang (để trống = chào bằng tên; vd: Viện trưởng)', value: p && p.chuc_danh ? p.chuc_danh : '' },
        { name: 'trang_thai', label: 'Trạng thái', type: 'select', options: [{ value: 'dang_hoat_dong', label: 'Đang hoạt động' }, { value: 'da_roi_di', label: 'Đã rời đi (ra trường / nghỉ việc)' }], value: p ? p.trang_thai : 'dang_hoat_dong' },
      ],
      onSubmit: function (v) {
        if (!v.nguoi) return Promise.reject(new Error('Chọn người dùng.'));
        return api('PUT', '/profiles/' + v.nguoi.id, { loai: v.loai, nhom_id: v.nhom_id === '' ? null : Number(v.nhom_id), trang_thai: v.trang_thai, chuc_danh: v.chuc_danh })
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
              var doi = function () { api('PUT', '/profiles/' + p.user_id, { trang_thai: roi ? 'dang_hoat_dong' : 'da_roi_di' }).then(reopen).catch(function (e) { err.textContent = e.message; }); };
              if (roi) doi(); else hoi('Đánh dấu ' + (p.fullname || p.email) + ' đã rời đi (ra trường / nghỉ việc)? Yêu cầu về mẫu của họ sẽ chuyển cho trưởng nhóm / quản lý.', doi);
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
      // phạm vi ngân hàng chỉ có ở Quản lý module
      var phamVi = h('select', { 'aria-label': 'Phạm vi ngân hàng' }, [h('option', { value: '' }, 'Cả hai ngân hàng'), h('option', { value: 'te_bao' }, NH_VN.te_bao), h('option', { value: 'khang_the' }, NH_VN.khang_the)]);
      var capNhatPhamVi = function () { phamVi.classList.toggle('nhm-hide', sel.value !== 'quan_ly'); };
      sel.addEventListener('change', capNhatPhamVi);
      capNhatPhamVi();
      var rows = r.roles.map(function (x) {
        return h('div', { class: 'nhm-card' }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, x.fullname || x.email || ('#' + x.user_id)), h('span', { class: 'nhm-chip' }, (VAI_TRO_VN[x.vai_tro] || x.vai_tro) + (x.vai_tro === 'quan_ly' ? ' · ' + (x.ngan_hang ? NH_VN[x.ngan_hang] : 'cả hai ngân hàng') : ''))]),
          h('div', { class: 'nhm-small nhm-muted' }, x.email || ''),
          h('div', { class: 'nhm-card-act' }, [nutNho('Gỡ vai trò', 'danger', function () {
            hoi('Gỡ vai trò «' + (VAI_TRO_VN[x.vai_tro] || x.vai_tro) + '» của ' + (x.fullname || x.email) + '?', function () { api('DELETE', '/roles/' + x.id).then(reopen).catch(function (e) { err.textContent = e.message; }); });
          })]),
        ]);
      });
      put(body, h('div', {}, [
        h('strong', {}, 'Vai trò trong module (' + r.roles.length + ')'),
        h('p', { class: 'nhm-muted nhm-small' }, 'Chỉ Admin cấp và gỡ vai trò. Quản lý module (2–3 người) quản lý thiết bị, hộp, danh mục, nhóm và mọi mẫu; Trưởng CIPP là người duyệt của đơn vị Cellbank (người duyệt của các đơn vị khác gán ở thẻ Đơn vị quản lý).'),
        r.roles.length ? h('div', { class: 'nhm-cards' }, rows) : h('p', { class: 'nhm-muted' }, 'Chưa gán vai trò nào.'),
        h('div', { class: 'nhm-addrole' }, [nguoi.node, sel, phamVi, nutNho('Cấp vai trò', '', function () {
          var u = nguoi.get();
          if (!u) { err.textContent = 'Chọn người dùng.'; return; }
          api('POST', '/roles', { user_id: u.id, vai_tro: sel.value, ngan_hang: sel.value === 'quan_ly' ? phamVi.value : '' }).then(function () { say('Đã cấp vai trò.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
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
      var lam = function () { api('POST', '/students/bulk', Object.assign({ khoa: sel.value, hanh_dong: hanhDong }, extra || {})).then(function (r) { say('Đã xử lý ' + r.so_luong + ' sinh viên.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; }); };
      if (cauHoi) hoi(cauHoi.replace('{dot}', sel.value || '(không ghi đợt)'), lam); else lam();
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
          hoi('Thu hồi quyền của ' + s.fullname + '? Họ không vào được module này nữa (Đặt lịch thiết bị vẫn dùng được).', function () { api('DELETE', '/students/' + s.id).then(reopen).catch(function (e) { err.textContent = e.message; }); });
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
      var dong = function (giaTri, gioiHan, nhan, macDinh) {
        return Object.keys(giaTri).map(function (k) {
          var inp = h('input', { type: 'number', min: String(gioiHan[k][0]), max: String(gioiHan[k][1]), step: '1', 'aria-label': nhan[k] });
          inp.value = giaTri[k];
          o[k] = inp;
          return h('div', { class: 'nhm-field' }, [
            h('span', { class: 'nhm-lbl' }, nhan[k]),
            h('div', { class: 'nhm-han' }, [inp, h('span', {}, 'ngày'), h('span', { class: 'nhm-muted nhm-small' }, 'từ ' + gioiHan[k][0] + ' đến ' + gioiHan[k][1] + ' · mặc định ' + macDinh[k])]),
          ]);
        });
      };
      var hang = dong(r.han, r.gioi_han, r.nhan, r.mac_dinh);
      var hangChuKy = dong(r.chu_ky, r.chu_ky_gioi_han, r.chu_ky_nhan, r.chu_ky_mac_dinh);
      var luu = function (giaTri) {
        api('PUT', '/settings', giaTri).then(function (x) { state.meta.han = x.han; say(x.changed ? 'Đã lưu các hạn.' : 'Không có gì thay đổi.', 'ok'); reopen(); }).catch(function (e) { err.textContent = e.message; });
      };
      put(body, h('div', {}, [
        h('strong', {}, 'Các hạn chờ'),
        h('p', { class: 'nhm-muted nhm-small' }, 'Hạn mới áp dụng cho yêu cầu và vụ việc tạo SAU khi lưu; yêu cầu và vụ việc đang chạy giữ hạn đã ghi. Riêng hạn bỏ mẫu chưa khai báo được tính lúc xem nên đổi là áp dụng ngay cho mọi mục đang chờ.'),
      ].concat(hang, [
        h('strong', { class: 'nhm-cauhinh__nhom' }, 'Chu kỳ nhắc việc định kỳ'),
        h('p', { class: 'nhm-muted nhm-small' }, 'Kiểm kê hộp, thử mycoplasma, xác thực STR, ghi nhiệt độ. Quá chu kỳ thì việc hiện ở «Việc cần xử lý» → «Đến hạn» và hệ thống gửi một thư nhắc gộp cho quản lý (và người tạo dòng / thiết bị). Áp dụng ngay khi lưu.'),
      ], hangChuKy, [
        err,
        h('div', { class: 'nhm-card-act' }, [
          nutNho('Lưu', 'primary', function () { var g = {}; Object.keys(o).forEach(function (k) { g[k] = o[k].value; }); luu(g); }),
          nutNho('Khôi phục mặc định', '', function () { luu(Object.assign({}, r.mac_dinh, r.chu_ky_mac_dinh)); }),
        ]),
      ])));
    }).catch(loiTrongSlot(body));
  }

  // ----- nhập dữ liệu từ tệp xuất Cellseeker (chỉ Admin, ngân hàng tế bào) -----

  /** Chọn tệp .zip → «Kiểm tra» (chưa ghi gì, đúng số liệu như khi ghi) → «Nhập vào hệ thống». Chỉ thêm, không sửa / xóa; nhập lại không bị trùng. */
  function tabNhapDuLieu(body) {
    var tep = h('input', { type: 'file', accept: '.zip,application/zip', 'aria-label': 'Tệp .zip xuất từ Cellseeker' });
    var kieu = h('select', { 'aria-label': 'Cách đếm ô trong hộp' }, [
      h('option', { value: 'hang' }, 'Theo hàng: A1, A2 … A5, rồi B1'),
      h('option', { value: 'cot' }, 'Theo cột: A1, B1 … E1, rồi A2'),
    ]);
    var ketQua = h('div', { class: 'nhm-nhap__kq', 'aria-live': 'polite' });
    var nutKiemTra = h('button', { type: 'button', class: 'nhm-btn nhm-btn--primary' }, 'Kiểm tra');
    var nutGhi = h('button', { type: 'button', class: 'nhm-btn nhm-hide' }, 'Nhập vào hệ thống');
    var dangChay = false;
    var batDau = function (ghi) {
      if (dangChay) return;
      if (!tep.files[0]) { put(ketQua, h('p', { class: 'nhm-err' }, 'Hãy chọn tệp .zip xuất từ Cellseeker.')); return; }
      dangChay = true; nutKiemTra.disabled = true; nutGhi.disabled = true;
      put(ketQua, h('p', { class: 'nhm-loading' }, ghi ? 'Đang nhập, đừng đóng cửa sổ…' : 'Đang kiểm tra…'));
      var fd = new FormData();
      fd.append('tep', tep.files[0]); fd.append('kieu_dem', kieu.value); fd.append('ghi', ghi ? '1' : '0');
      apiTep('/import/cellseeker?nh=te_bao', fd).then(function (r) {
        dangChay = false; nutKiemTra.disabled = false; nutGhi.disabled = false;
        put(ketQua, veKetQuaNhap(r));
        nutGhi.classList.toggle('nhm-hide', r.da_ghi);
        if (r.da_ghi) { say('Đã nhập dữ liệu Cellseeker.', 'ok'); reload(true).then(taiMe); }
      }).catch(function (e) {
        dangChay = false; nutKiemTra.disabled = false; nutGhi.disabled = false;
        put(ketQua, h('p', { class: 'nhm-err' }, e.message));
      });
    };
    tep.addEventListener('change', function () { nutGhi.classList.add('nhm-hide'); put(ketQua); });
    kieu.addEventListener('change', function () { nutGhi.classList.add('nhm-hide'); put(ketQua); });
    nutKiemTra.addEventListener('click', function () { batDau(false); });
    nutGhi.addEventListener('click', function () {
      hoi('Nhập dữ liệu vào hệ thống? Chỉ thêm mới, không sửa hay xóa dữ liệu đang có. Việc này đổi vị trí ống thật nên hãy chắc cách đếm ô đã đúng.', function () { batDau(true); });
    });
    put(body, h('div', { class: 'nhm-nhap' }, [
      h('strong', {}, 'Nhập dữ liệu từ Cellseeker'),
      h('p', { class: 'nhm-muted nhm-small' }, 'Chọn tệp .zip tải về từ Cellseeker (cellseeker-export-….zip). «Kiểm tra» chỉ xem trước, chưa ghi gì. Nhập lại tệp đó lần nữa không bị trùng.'),
      h('div', { class: 'nhm-field' }, [h('span', { class: 'nhm-lbl' }, 'Tệp .zip'), tep]),
      h('div', { class: 'nhm-field' }, [h('span', { class: 'nhm-lbl' }, 'Cách Cellseeker đếm số ô trong hộp'), kieu]),
      h('div', { class: 'nhm-card-act' }, [nutKiemTra, nutGhi]),
      ketQua,
    ]));
  }

  function veKetQuaNhap(r) {
    var k = r.ket_qua;
    var dong = function (ten, x, tong) {
      return h('tr', {}, [h('td', { 'data-l': 'Mục' }, ten), h('td', { 'data-l': 'Trong tệp' }, tong == null ? '' : String(tong)), h('td', { 'data-l': 'Thêm mới' }, String(x.moi)), h('td', { 'data-l': 'Đã có' }, String(x.coSan)), h('td', { 'data-l': 'Bỏ qua' }, x.boQua ? String(x.boQua) : '')]);
    };
    var t = r.trong_tep;
    return h('div', {}, [
      h('p', { class: r.da_ghi ? 'nhm-ok' : 'nhm-hint', role: 'status' }, r.da_ghi
        ? 'Đã ghi xong.' + (r.sao_luu ? ' Sao lưu trước khi nhập: ' + r.sao_luu + '.' : ' Không tạo được bản sao lưu trước khi nhập.')
        : 'Đây là kết quả kiểm tra, chưa có gì được ghi.'),
      h('table', { class: 'nhm-hist' }, [
        h('tr', {}, ['Mục', 'Trong tệp', 'Thêm mới', 'Đã có', 'Bỏ qua'].map(function (x) { return h('th', {}, x); })),
        dong('Thiết bị', k.thietBi, t.thiet_bi), dong('Rack', k.rack, t.rack), dong('Hộp', k.hop, t.hop), dong('Dòng tế bào', k.dong, t.dong), dong('Lô', k.lo, t.lo), dong('Ống', k.ong, t.ong), dong('Tệp của lô', k.tep, t.tep),
      ]),
      r.vi_du && r.vi_du.length ? h('div', { class: 'nhm-nhap__vd' }, [
        h('strong', {}, 'Đối chiếu cách đếm ô'),
        h('p', { class: 'nhm-muted nhm-small' }, 'Mở các ống này trong Cellseeker; nếu ô khác với bảng dưới thì đổi «cách đếm» ở trên rồi kiểm tra lại.'),
        h('ul', {}, r.vi_du.map(function (x) { return h('li', {}, 'Ô số ' + x.vi_tri + ' của hộp ' + x.rows + '×' + x.cols + ' (' + x.tank + ', Rack ' + x.rack + ', hộp ' + x.hop + ') → ô ' + x.o + ' · ' + x.mau); })),
      ]) : null,
      k.canhBao && k.canhBao.length ? h('details', { class: 'nhm-nhap__cb', open: k.canhBao.length <= 6 }, [
        h('summary', {}, 'Lưu ý (' + k.canhBao.length + ')'),
        h('ul', {}, k.canhBao.slice(0, 80).map(function (c) { return h('li', {}, c); })),
      ]) : null,
    ]);
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
        }).concat(u.nguoi_theo_vai_tro.map(function (x) { return h('span', { class: 'nhm-chip nhm-chip--vt' }, x.ten + (u.chi_vien_truong ? ' (Viện trưởng)' : ' (Trưởng CIPP)')); }));
        var them = null;
        if (laAdmin && !u.chi_vien_truong) {
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
          u.mac_dinh || u.chi_vien_truong ? null : nutNho('Xóa', 'danger', function () {
            hoi('Xóa đơn vị «' + u.ten + '»?', function () { api('DELETE', '/units/' + u.id).then(function () { reopen(); }).catch(function (e) { err.textContent = e.message; }); });
          }),
        ]) : null;
        return h('div', { class: 'nhm-card' }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, u.ten), h('span', { class: 'nhm-chip' }, u.so_thiet_bi + ' thiết bị')]),
          u.mo_ta ? h('div', { class: 'nhm-small nhm-muted' }, u.mo_ta) : null,
          h('div', { class: 'nhm-lbl nhm-small' }, u.chi_vien_truong ? 'Người duyệt yêu cầu lấy mẫu (chỉ Viện trưởng)' : 'Người duyệt yêu cầu lấy mẫu'),
          chips.length ? h('div', { class: 'nhm-chips' }, chips) : h('p', { class: 'nhm-hint' }, u.chi_vien_truong ? 'Chưa có ai giữ vai trò Viện trưởng: admin xử lý yêu cầu cho đến khi cấp vai trò (tab Vai trò).' : 'Chưa có người duyệt: yêu cầu sẽ chuyển thẳng cho quản lý module.'),
          u.chi_vien_truong ? h('div', { class: 'nhm-lbl nhm-small' }, 'Quản lý ngân hàng kháng thể (theo dõi, giao và nhận lại mẫu)') : null,
          u.chi_vien_truong ? (u.quan_ly.length ? h('div', { class: 'nhm-chips' }, u.quan_ly.map(function (x) { return h('span', { class: 'nhm-chip' }, x.ten); })) : h('p', { class: 'nhm-hint' }, 'Chưa có quản lý: admin cấp ở tab Vai trò (Quản lý, phạm vi Ngân hàng kháng thể).')) : null,
          them, act,
        ]);
      });
      put(body, h('div', {}, [
        h('div', { class: 'nhm-dm-head' }, [h('strong', {}, 'Đơn vị quản lý thiết bị (' + r.units.length + ')'), laAdmin && nganHang !== 'khang_the' ? nutNho('+ Thêm đơn vị', 'primary', function () { donViForm(null, reopen); }) : null]),
        nganHang === 'khang_the'
          ? h('p', { class: 'nhm-muted nhm-small' }, 'Ngân hàng kháng thể không có Public: mọi thiết bị thuộc AntibodyBank. Người dùng gửi yêu cầu; chỉ Viện trưởng duyệt. Quản lý ngân hàng kháng thể được báo, theo dõi yêu cầu, rồi giao và nhận lại mẫu theo quyết định của Viện trưởng.' + (laAdmin ? '' : ' Chỉ Admin cấp vai trò.'))
          : h('p', { class: 'nhm-muted nhm-small' }, 'Thiết bị gắn với một đơn vị (chọn ở Thêm / Chỉnh sửa thiết bị) thì người dùng không tự thêm hay lấy mẫu mà gửi yêu cầu; người duyệt của đơn vị quyết định. Thiết bị không gắn đơn vị là Public: chủ mẫu, rồi trưởng nhóm, rồi quản lý module duyệt. ' + (laAdmin ? '' : 'Chỉ Admin thêm, sửa đơn vị và gán người duyệt.')),
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
    if (state.me && state.me.laAdmin && nganHang === 'te_bao') tabs.push(['nhapdl', 'Nhập dữ liệu', tabNhapDuLieu]);
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
    var thongBaoHan = sv && conNgay <= 30 ? h('div', { class: 'nhm-hint', role: 'status' }, 'Quyền vào Ngân hàng Tế bào & Kháng thể của tài khoản sinh viên đến hết ngày ' + sv.het_han.split('-').reverse().join('/') + ' (còn ' + Math.max(conNgay, 0) + ' ngày). Cần gia hạn thì liên hệ quản lý module.') : null;
    put(slot, thongBaoHan, ds.length ? h('div', { class: 'nhm-notice', role: 'alert' }, ds.map(function (g) {
      var xong = function () { return api('GET', '/me').then(function (m) { state.me = m; capNhatLoiChao(); return taiNhom(); }).then(renderBanner); };
      return h('div', { class: 'nhm-notice-row' }, [
        h('span', {}, 'Bạn được ghi là trưởng nhóm «' + g.ten + '»' + (g.de_xuat_ten ? ' (do ' + g.de_xuat_ten + ' đề xuất)' : '') + '. Khi có người yêu cầu lấy mẫu của nhóm, bạn là người duyệt. Đúng không?'),
        h('span', { class: 'nhm-notice-act' }, [
          nutNho('Đúng, tôi là trưởng nhóm', 'primary', function () { api('POST', '/groups/' + g.id + '/confirm-leader').then(xong).then(function () { say('Đã xác nhận.', 'ok'); }).catch(function (e) { say(e.message, 'err'); }); }),
          nutNho('Không phải', '', function () { api('POST', '/groups/' + g.id + '/decline-leader').then(xong).then(function () { say('Đã ghi nhận. Quản lý sẽ gán người khác.', 'ok'); }).catch(function (e) { say(e.message, 'err'); }); }),
        ]),
      ]);
    })) : null);
  }

  // ---------- yêu cầu lấy mẫu, mẫu chưa khai báo, mẫu nghi mất ----------
  function taiMe() {
    return api('GET', '/me').then(function (m) { state.me = m; capNhatHuy(); capNhatLoiChao(); return m; });
  }

  /** Số việc chờ trên nút «Việc cần xử lý»: yêu cầu cần tôi xử lý + mẫu chưa khai báo + mẫu nghi mất đang mở. */
  function capNhatHuy() {
    var me = state.me;
    var n = me ? me.yeuCau.inbox + me.phatHienMo + me.vuViecMo + (me.denHan || 0) : 0;
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
      title: 'Yêu cầu lấy mẫu: ' + t.name,
      fields: (nganHang === 'khang_the' ? [{ name: 'so_ul', label: 'Số µL cần dùng' + (t.con_lai_ul != null ? ' (ống còn ' + ul(t.con_lai_ul) + ')' : ''), type: 'number', required: true }] : [])
        .concat([{ name: 'ly_do', label: 'Lý do / mục đích sử dụng', type: 'textarea', required: true }]),
      submitLabel: 'Gửi yêu cầu',
      onSubmit: function (v) {
        return api('POST', '/tubes/' + t.id + '/requests', nganHang === 'khang_the' ? { ly_do: v.ly_do, so_ul: v.so_ul } : { ly_do: v.ly_do }).then(function (r) {
          say(nganHang === 'khang_the'
            ? 'Đã gửi yêu cầu tới Viện trưởng; quản lý ngân hàng kháng thể cũng được báo. Sau khi duyệt, quản lý sẽ giao mẫu cho bạn. Theo dõi ở «Việc cần xử lý».'
            : 'Đã gửi yêu cầu tới ' + r.cap_ten + '. Nếu quá ' + gioDia(r.han_phan_hoi) + ' chưa ai phản hồi, yêu cầu sẽ chuyển cho quản lý module. Theo dõi ở «Việc cần xử lý».', 'ok');
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
        label: tuChoi ? 'Lý do từ chối (người yêu cầu sẽ đọc được)' : y.can_ly_do ? 'Lý do xử lý thay ' + y.cap_ten + ' (bắt buộc, ghi vào lịch sử)' : 'Ghi chú (không bắt buộc)',
      }],
      submitLabel: tuChoi ? 'Từ chối' : 'Duyệt',
      onSubmit: function (v) { return api('POST', '/requests/' + y.id + '/' + ketQua, { ly_do: v.ly_do }).then(function () { say(tuChoi ? 'Đã từ chối.' : (nganHang === 'khang_the' ? 'Đã duyệt. Người yêu cầu và quản lý ngân hàng kháng thể đã được thông báo; quản lý sẽ giao mẫu.' : 'Đã duyệt. Người yêu cầu và quản lý module đã được thông báo.'), 'ok'); return lamMoiCv(); }); },
    });
  }

  /** Ngân hàng kháng thể: giao bao nhiêu µL (mặc định đúng số đã yêu cầu); trừ vào số còn lại của ống. */
  function giaoForm(y) {
    openForm({
      title: 'Giao ' + y.mau_ten + ' cho ' + y.nguoi_gui_ten,
      fields: [{ name: 'so_ul', label: 'Số µL giao (đã yêu cầu ' + ul(y.so_ul_yeu_cau) + '; ống còn ' + ul(y.con_lai_ul) + ')', type: 'number', required: true, value: y.so_ul_yeu_cau }],
      submitLabel: 'Giao mẫu',
      onSubmit: function (v) {
        return api('POST', '/requests/' + y.id + '/deliver', { so_ul: v.so_ul }).then(function (r) { say('Đã giao. Ống còn ' + ul(r.con_lai_ul) + (r.con_lai_ul <= 0 ? ' (hết, sẽ bỏ khỏi kho khi nhận lại)' : '') + '.', 'ok'); return lamMoiCv(); });
      },
    });
  }

  /** Nhận ống về: có thể đo lại số còn lại; còn 0 thì ống hết và bỏ khỏi kho. */
  function nhanLaiForm(y) {
    openForm({
      title: 'Nhận lại ' + y.mau_ten,
      fields: [{ name: 'con_lai_ul', label: 'Số µL còn lại (hệ thống tính ' + ul(y.con_lai_ul) + '; sửa nếu đo lại khác; 0 = ống đã hết, sẽ bỏ khỏi kho)', type: 'number', required: true, value: y.con_lai_ul }],
      submitLabel: 'Nhận lại',
      onSubmit: function (v) {
        return api('POST', '/requests/' + y.id + '/return', { con_lai_ul: v.con_lai_ul }).then(function (r) { say(r.het ? 'Đã nhận lại. Ống hết nên được bỏ khỏi kho.' : 'Đã nhận lại; ống còn ' + ul(r.con_lai_ul) + '.', 'ok'); return lamMoiCv(); });
      },
    });
  }

  function hoiRoiLam(cauHoi, fn) { hoi(cauHoi, function () { fn().then(lamMoiCv).catch(function (e) { say(e.message, 'err'); }); }); }

  // ---------- ủy quyền duyệt (ngân hàng kháng thể) ----------
  var UQ_TT = { hieu_luc: 'Đang hiệu lực', het_han: 'Đã hết hạn', thu_hoi: 'Đã thu hồi' };

  /** Danh sách ủy quyền duyệt. Viện trưởng cấp và thu hồi; quản lý chỉ xem. */
  function uyQuyenDialog() {
    api('GET', '/delegations').then(function (r) {
      var dangDung = r.delegations.filter(function (d) { return d.trang_thai === 'hieu_luc'; });
      var cu = r.delegations.filter(function (d) { return d.trang_thai !== 'hieu_luc'; });
      var the = function (d) {
        return h('div', { class: 'nhm-card' }, [
          h('div', { class: 'nhm-card-top' }, [h('strong', {}, d.nguoi_ten), h('span', { class: 'nhm-chip' + (d.trang_thai === 'hieu_luc' ? ' nhm-chip--ok' : ' nhm-chip--no') }, UQ_TT[d.trang_thai])]),
          h('div', { class: 'nhm-small' }, d.pham_vi_ten),
          h('div', { class: 'nhm-small nhm-muted' }, (d.den_ngay ? 'Đến hết ngày ' + d.den_ngay.split('-').reverse().join('/') : 'Cho tới khi thu hồi') + ' · cấp bởi ' + d.tao_boi_ten + ' lúc ' + gioDia(d.tao_luc)),
          d.ghi_chu ? h('div', { class: 'nhm-small' }, 'Ghi chú: ' + d.ghi_chu) : null,
          d.thu_hoi_luc ? h('div', { class: 'nhm-small nhm-muted' }, 'Thu hồi bởi ' + d.thu_hoi_boi_ten + ' lúc ' + gioDia(d.thu_hoi_luc)) : null,
          r.la_vien_truong && d.trang_thai === 'hieu_luc' ? h('div', { class: 'nhm-card-act' }, [nutNho('Thu hồi', 'danger', function () {
            hoi('Thu hồi ủy quyền của ' + d.nguoi_ten + '? Có hiệu lực ngay, kể cả với yêu cầu đang chờ.', function () { api('DELETE', '/delegations/' + d.id).then(function () { say('Đã thu hồi ủy quyền.', 'ok'); uyQuyenDialog(); }).catch(function (e) { say(e.message, 'err'); }); });
          })]) : null,
        ]);
      };
      var noi = h('div', {}, [
        h('p', { class: 'nhm-muted nhm-small' }, 'Viện trưởng có thể giao quyền DUYỆT một phần kháng thể cho quản lý ngân hàng kháng thể: cả ngân hàng, một thiết bị, một hộp hoặc một loại kháng thể. Người được ủy quyền cùng Viện trưởng duyệt (ai duyệt trước thì yêu cầu đóng); mọi lần duyệt đều ghi «theo ủy quyền của Viện trưởng» vào lịch sử mẫu. Thu hồi có hiệu lực ngay.' + (r.la_vien_truong ? '' : ' Bạn chỉ xem được; chỉ Viện trưởng cấp và thu hồi.')),
        dangDung.length ? h('div', { class: 'nhm-cards' }, dangDung.map(the)) : h('p', { class: 'nhm-muted' }, 'Chưa có ủy quyền nào đang hiệu lực: chỉ Viện trưởng duyệt.'),
        cu.length ? h('details', { class: 'nhm-ls' }, [h('summary', {}, h('span', { class: 'nhm-ls__tit' }, 'Đã thu hồi hoặc hết hạn (' + cu.length + ')')), h('div', { class: 'nhm-cards' }, cu.map(the))]) : null,
      ]);
      openInfo('Ủy quyền duyệt', noi, r.la_vien_truong ? [h('button', { type: 'button', class: 'nhm-btn nhm-btn--primary', onclick: function () { uyQuyenForm(r.ung_vien); } }, '+ Ủy quyền mới')] : []);
    }).catch(function (e) { say(e.message, 'err'); });
  }

  function uyQuyenForm(ungVien) {
    if (!ungVien.length) { say('Chưa có quản lý ngân hàng kháng thể nào để ủy quyền. Admin cấp vai trò Quản lý (phạm vi Ngân hàng kháng thể) trước.', 'err'); return; }
    var phamVi = h('select', { 'aria-label': 'Phạm vi' }, [['ngan_hang', 'Mọi kháng thể của ngân hàng'], ['vi_tri', 'Một thiết bị / Rack'], ['hop', 'Một hộp'], ['ten_mau', 'Một loại kháng thể (theo tên)']].map(function (o) { return h('option', { value: o[0] }, o[1]); }));
    var viTri = h('select', { 'aria-label': 'Thiết bị / Rack' }, state.tree.containers.map(function (c) { return h('option', { value: c.id }, (c.parent_id ? '— ' : '') + c.name + ' (' + c.type_name + ')'); }));
    var hop = h('select', { 'aria-label': 'Hộp' }, state.tree.boxes.map(function (b) { return h('option', { value: b.id }, (b.name || b.code) + ' [' + b.code + ']'); }));
    var ten = h('input', { type: 'text', placeholder: 'Tên kháng thể, vd Anti-CD34 (không phân biệt hoa thường, dấu)', 'aria-label': 'Tên kháng thể', maxlength: '100' });
    var oDoiTuong = { vi_tri: viTri, hop: hop, ten_mau: ten };
    function doiPhamVi() { Object.keys(oDoiTuong).forEach(function (k) { oDoiTuong[k].classList.toggle('nhm-hide', k !== phamVi.value); }); }
    phamVi.addEventListener('change', doiPhamVi);
    doiPhamVi();
    openForm({
      title: 'Ủy quyền duyệt mới',
      fields: [
        { name: 'nguoi_id', label: 'Giao quyền duyệt cho (quản lý ngân hàng kháng thể)', type: 'select', required: true, options: ungVien.map(function (u) { return { value: u.id, label: u.ten + ' — ' + u.email }; }) },
        { name: 'pham', label: 'Phạm vi', type: 'custom', widget: { node: h('div', { class: 'nhm-uq-pham' }, [phamVi, viTri, hop, ten]), get: function () { return { pham_vi: phamVi.value, vi_tri_id: viTri.value, hop_id: hop.value, ten_mau: ten.value }; } } },
        { name: 'den_ngay', label: 'Hết hạn (để trống = tới khi thu hồi)', type: 'date' },
        { name: 'ghi_chu', label: 'Ghi chú (không bắt buộc)', type: 'textarea' },
      ],
      submitLabel: 'Ủy quyền',
      onSubmit: function (v) {
        return api('POST', '/delegations', { nguoi_id: Number(v.nguoi_id), pham_vi: v.pham.pham_vi, vi_tri_id: Number(v.pham.vi_tri_id) || null, hop_id: Number(v.pham.hop_id) || null, ten_mau: v.pham.ten_mau, den_ngay: v.den_ngay || null, ghi_chu: v.ghi_chu })
          .then(function () { say('Đã ủy quyền. Người được ủy quyền nhận thư.', 'ok'); setTimeout(uyQuyenDialog, 0); });
      },
    });
  }

  /** Thẻ một yêu cầu. */
  function theYeuCau(y) {
    var trangThai = { cho_duyet: 'Chờ ' + y.cap_ten + ' duyệt' + (y.theo_doi ? ' · bạn theo dõi' : ''), da_duyet: 'Đã duyệt — chờ quản lý giao mẫu', tu_choi: 'Bị từ chối', da_giao: 'Đã giao cho người yêu cầu', da_tra: 'Đã trả', da_huy: 'Đã hủy' }[y.trang_thai] || y.trang_thai;
    var nut = [];
    if (y.co_the_xu_ly) {
      nut.push(nutNho('Duyệt', 'primary', function () { dongYForm(y, 'approve'); }));
      nut.push(nutNho('Từ chối', '', function () { dongYForm(y, 'reject'); }));
    }
    if (y.co_the_giao) nut.push(nutNho('Giao mẫu', 'primary', function () { if (y.khang_the) giaoForm(y); else hoiRoiLam('Giao mẫu «' + y.mau_ten + '» cho ' + y.nguoi_gui_ten + '? Mẫu chuyển sang «đã lấy ra».', function () { return api('POST', '/requests/' + y.id + '/deliver'); }); }));
    if (y.co_the_nhan_lai) nut.push(nutNho('Nhận lại mẫu', 'primary', function () { if (y.khang_the && y.con_lai_ul != null) nhanLaiForm(y); else hoiRoiLam('Ghi nhận đã nhận lại mẫu «' + y.mau_ten + '» vào kho?', function () { return api('POST', '/requests/' + y.id + '/return'); }); }));
    if (y.co_the_huy) nut.push(nutNho('Hủy yêu cầu', 'danger', function () { hoiRoiLam('Hủy yêu cầu này?', function () { return api('POST', '/requests/' + y.id + '/cancel'); }); }));
    nut.push(nutNho('Xem mẫu', '', function () { moMauTheoId(y.tube_id); }));
    // phiếu in được (kèm kết quả duyệt) cho người gửi, người đã xử lý, người duyệt và quản lý
    if (y.co_the_in) nut.push(nutNho('In phiếu', '', function () { window.open(API + '/requests/' + y.id + '/print?nh=' + nganHang, '_blank', 'noopener'); }));
    return h('div', { class: 'nhm-card' }, [
      h('div', { class: 'nhm-card-top' }, [h('strong', {}, y.mau_ten), h('span', { class: 'nhm-chip' + ({ da_duyet: ' nhm-chip--ok', da_giao: ' nhm-chip--ok', da_tra: ' nhm-chip--ok', tu_choi: ' nhm-chip--no', da_huy: ' nhm-chip--no' }[y.trang_thai] || '') }, trangThai)]),
      h('div', { class: 'nhm-small' }, y.nguoi_gui_ten + ' yêu cầu lấy' + (y.so_ul_yeu_cau != null ? ' ' + ul(y.so_ul_yeu_cau) : '') + (y.so_ul_giao != null ? ' · đã giao ' + ul(y.so_ul_giao) : '') + ' · ' + y.vi_tri),
      y.khang_the && y.con_lai_ul != null && (y.trang_thai === 'cho_duyet' || y.trang_thai === 'da_duyet' || y.trang_thai === 'da_giao') ? h('div', { class: 'nhm-small nhm-muted' }, 'Ống còn ' + ul(y.con_lai_ul) + (y.the_tich_ul != null ? ' / ' + ul(y.the_tich_ul) : '')) : null,
      y.ly_do ? h('div', { class: 'nhm-small' }, 'Lý do: ' + y.ly_do) : null,
      h('div', { class: 'nhm-small nhm-muted' }, 'Chủ mẫu: ' + (y.chu_ten || '—') + (y.nhom_ten ? ' · nhóm ' + y.nhom_ten : '') + (y.trang_thai === 'cho_duyet' ? ' · hạn phản hồi ' + gioDia(y.han_phan_hoi) : '')),
      y.nguoi_duoc_uy_quyen && y.nguoi_duoc_uy_quyen.length ? h('div', { class: 'nhm-small nhm-muted' }, 'Được Viện trưởng ủy quyền duyệt: ' + y.nguoi_duoc_uy_quyen.join(', ')) : null,
      y.leo_thang_luc ? h('div', { class: 'nhm-small nhm-muted' }, 'Đã chuyển quản lý module lúc ' + gioDia(y.leo_thang_luc) + ' (quá hạn phản hồi).') : null,
      y.xu_ly_ten && y.trang_thai !== 'cho_duyet' ? h('div', { class: 'nhm-small nhm-muted' }, 'Xử lý bởi ' + y.xu_ly_ten + ' lúc ' + gioDia(y.xu_ly_luc) + (y.xu_ly_thay ? ' (xử lý thay)' : '') + (y.uy_quyen_ten ? ' (theo ủy quyền của Viện trưởng ' + y.uy_quyen_ten + ')' : '') + (y.ly_do_xu_ly ? ': ' + y.ly_do_xu_ly : '')) : null,
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
        hoi('Hủy đánh dấu ô này (đánh dấu nhầm)?', function () { api('POST', '/findings/' + ph.id + '/cancel', { ly_do: 'Đánh dấu nhầm' }).then(xong).catch(function (e) { say(e.message, 'err'); }); });
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

  // ═══ ĐẾN HẠN · KIỂM KÊ · NHIỆT ĐỘ THIẾT BỊ ═══════════════════════════════════════════════════════════
  // Việc đến hạn (kiểm kê, QC mycoplasma / STR, nhiệt độ) từ GET /reminders; đợt kiểm kê từ /inventories;
  // nhiệt độ từ /containers/:id/temperatures. Cách tính và chu kỳ: services/nganHangTeBaoKhangTheNhacViec.js.

  var DEN_HAN_NHAN = { kiem_ke: 'Kiểm kê', myco: 'Mycoplasma', myco_duong_tinh: 'Mycoplasma dương tính', str: 'STR', nhiet_quen: 'Quên ghi nhiệt độ', nhiet_canh_bao: 'Cảnh báo nhiệt độ' };
  var soVn = function (n) { return n == null ? '—' : String(n).replace('.', ','); };
  var soGui = function (v) { return v == null ? '' : String(v).trim().replace(',', '.'); };

  /** Mở trang chi tiết một thiết bị / vị trí lưu trữ (và bung cây tới đó). */
  function moThietBi(id) {
    var c = containerById(id);
    if (!c) { say('Không còn thiết bị này.', 'err'); return; }
    state.expanded[id] = true;
    select('container', id);
  }

  function theDenHan(v) {
    var l = v.loai, dt = v.doi_tuong, nut = [];
    if (l === 'kiem_ke') nut.push(nutNho('Mở đợt kiểm kê', 'primary', function () { moDotKiemKe(dt.id); }));
    if (l === 'myco' || l === 'str' || l === 'myco_duong_tinh') nut.push(nutNho('Mở hồ sơ dòng', 'primary', function () { moDongTeBao(dt.id); }));
    if (l === 'nhiet_quen') nut.push(nutNho('Ghi số đo', 'primary', function () { soDoForm(dt.id); }));
    if (l === 'nhiet_canh_bao') nut.push(nutNho('Ghi nhận xử lý', 'primary', function () { xuLyCanhBaoForm(v.canh_bao_id); }));
    if (dt.loai === 'container') nut.push(nutNho('Xem thiết bị', '', function () { moThietBi(dt.id); }));
    var khan = v.muc === 'do';
    return h('div', { class: 'nhm-card ' + (khan ? 'nhm-card--do' : 'nhm-card--vang') }, [
      h('div', { class: 'nhm-card-top' }, [h('strong', {}, v.tieu_de), h('span', { class: 'nhm-chip ' + (khan ? 'nhm-chip--no' : 'nhm-chip--warn') }, DEN_HAN_NHAN[l] || l)]),
      h('div', { class: 'nhm-small' }, v.chi_tiet),
      h('div', { class: 'nhm-card-act' }, nut),
    ]);
  }

  // ----- đợt kiểm kê -----

  /** Mở đợt kiểm kê cho cả thiết bị / ngăn / Rack: hệ thống liệt kê mọi hộp đang chứa mẫu để đối chiếu từng hộp. */
  function moDotKiemKe(containerId) {
    var c = containerById(containerId);
    hoi('Mở đợt kiểm kê cho «' + (c ? c.name : 'vị trí này') + '»? Hệ thống liệt kê mọi hộp đang chứa mẫu bên trong để bạn đối chiếu từng hộp với thực tế.', function () {
      api('POST', '/inventories', { container_id: containerId }).then(function (r) {
        say('Đã mở đợt kiểm kê: ' + r.so_hop + ' hộp, ' + r.so_mau + ' mẫu.', 'ok');
        moCongViec('kiemke');
        state.cv.moDot = r.id;
      }).catch(function (e) { say(e.message, 'err'); });
    });
  }

  function taiDotKiemKe(c, id) {
    c.chiTiet = c.chiTiet || {};
    return api('GET', '/inventories/' + id).then(function (r) { c.chiTiet[id] = r; if (state.cv === c) renderDetail(); }).catch(function (e) { say(e.message, 'err'); });
  }

  /** Mở một hộp của đợt ở chế độ kiểm kê: bấm những mẫu KHÔNG thấy rồi «Hoàn tất» (ghi vào đợt thay vì kiểm kê lẻ). */
  function kiemHopTrongDot(d, b) {
    state.cv = null; state.search = null; state.dtb = null;
    state.sel = { type: 'box', id: b.box_id };
    state.box = null;
    state.audit = { boxId: b.box_id, khong: {}, dot: d.id };
    location.hash = 'box=' + b.box_id;
    renderTree(); renderDetail(); cuonToiChiTiet();
    api('GET', '/boxes/' + b.box_id).then(function (bx) { state.box = bx; renderTree(); renderDetail(); }).catch(function (e) { say(e.message, 'err'); });
  }

  function ketThucDot(d) {
    openForm({
      title: 'Kết thúc đợt kiểm kê: ' + d.ten,
      fields: [{ name: 'ly_do', label: d.hop_xong < d.tong_hop ? 'Còn ' + (d.tong_hop - d.hop_xong) + ' hộp chưa kiểm: ghi lý do kết thúc sớm (bắt buộc)' : 'Ghi chú (không bắt buộc)', type: 'textarea', required: d.hop_xong < d.tong_hop }],
      submitLabel: 'Kết thúc đợt',
      onSubmit: function (f) { return api('POST', '/inventories/' + d.id + '/finish', { ly_do: f.ly_do }).then(function () { say('Đã kết thúc đợt kiểm kê.', 'ok'); return lamMoiCv(); }); },
    });
  }

  function huyDot(d) {
    openForm({
      title: 'Hủy đợt kiểm kê: ' + d.ten,
      fields: [{ name: 'ly_do', label: 'Lý do hủy đợt (kết quả các hộp đã kiểm vẫn được giữ)', type: 'textarea', required: true }],
      submitLabel: 'Hủy đợt',
      onSubmit: function (f) { return api('POST', '/inventories/' + d.id + '/cancel', { ly_do: f.ly_do }).then(function () { say('Đã hủy đợt kiểm kê.', 'ok'); return lamMoiCv(); }); },
    });
  }

  function theKiemKe(c, d) {
    var mo = d.trang_thai === 'dang_lam';
    var dangMo = c.moDot === d.id;
    var pt = d.tong_hop ? Math.round((100 * d.hop_xong) / d.tong_hop) : 0;
    var nut = [nutNho(dangMo ? 'Thu gọn' : mo ? 'Mở danh sách hộp' : 'Xem chi tiết', mo && !dangMo ? 'primary' : '', function () {
      c.moDot = dangMo ? null : d.id;
      if (!dangMo) taiDotKiemKe(c, d.id);
      renderDetail();
    })];
    if (mo) { nut.push(nutNho('Kết thúc đợt', '', function () { ketThucDot(d); })); nut.push(nutNho('Hủy đợt', 'danger', function () { huyDot(d); })); }
    nut.push(h('a', { class: 'nhm-btn nhm-btn--sm', href: API + '/inventories/' + d.id + '/export.csv?nh=' + nganHang }, 'Biên bản CSV'));
    var chiTiet = null;
    if (dangMo) {
      var ct = c.chiTiet && c.chiTiet[d.id];
      if (!ct) chiTiet = h('div', { class: 'nhm-loading' }, 'Đang tải danh sách hộp…');
      else chiTiet = h('ul', { class: 'nhm-kk-hop' }, ct.boxes.map(function (b) {
        var xong = b.trang_thai === 'xong';
        return h('li', { class: 'nhm-kk-hop__muc' + (xong ? ' nhm-kk-hop__muc--xong' : '') }, [
          h('span', { class: 'nhm-kk-hop__ten' }, [h('strong', {}, b.name || b.code), h('span', { class: 'nhm-muted nhm-small' }, ' ' + b.duong_dan + ' · ' + b.so_mau + ' mẫu')]),
          xong
            ? h('span', { class: 'nhm-small' }, [b.so_thay + ' có mặt' + (b.so_khong_thay ? ' · ' : ''), b.so_khong_thay ? h('b', { class: 'nhm-kk-hop__thieu' }, b.so_khong_thay + ' không thấy') : null])
            : (mo ? nutNho('Kiểm hộp này', 'primary', function () { kiemHopTrongDot(d, b); }) : h('span', { class: 'nhm-small nhm-muted' }, 'Chưa kiểm')),
        ]);
      }));
    }
    return h('div', { class: 'nhm-card' + (mo ? '' : ' nhm-card--xong') }, [
      h('div', { class: 'nhm-card-top' }, [h('strong', {}, d.ten), h('span', { class: 'nhm-chip ' + (mo ? 'nhm-chip--warn' : d.trang_thai === 'huy' ? '' : 'nhm-chip--ok') }, { dang_lam: 'Đang làm', hoan_tat: 'Hoàn tất', huy: 'Đã hủy' }[d.trang_thai])]),
      h('div', { class: 'nhm-small nhm-muted' }, d.duong_dan + ' · mở bởi ' + d.nguoi_tao_ten + ' lúc ' + gioDia(d.created_at)),
      h('div', { class: 'nhm-tt-bar', role: 'img', 'aria-label': d.hop_xong + ' trên ' + d.tong_hop + ' hộp đã kiểm' }, h('span', { style: 'width:' + pt + '%' })),
      h('div', { class: 'nhm-small' }, [d.hop_xong + '/' + d.tong_hop + ' hộp đã kiểm · ' + d.so_thay + ' mẫu có mặt · ', d.so_khong_thay ? h('b', { class: 'nhm-kk-hop__thieu' }, d.so_khong_thay + ' không thấy (' + d.so_vu_viec + ' vụ việc)') : '0 không thấy']),
      !mo && d.ket_thuc_luc ? h('div', { class: 'nhm-small nhm-muted' }, (d.trang_thai === 'huy' ? 'Hủy' : 'Kết thúc') + ' bởi ' + (d.ket_thuc_ten || '—') + ' lúc ' + gioDia(d.ket_thuc_luc) + (d.ly_do ? ' — ' + d.ly_do : '')) : null,
      chiTiet,
      h('div', { class: 'nhm-card-act' }, nut),
    ]);
  }

  function noiDungKiemKe(c) {
    if (c.moDot && !(c.chiTiet && c.chiTiet[c.moDot]) && !c.dangTaiDot) { c.dangTaiDot = true; taiDotKiemKe(c, c.moDot).then(function () { c.dangTaiDot = false; }); }
    return c.data.length
      ? h('div', { class: 'nhm-cards' }, c.data.map(function (d) { return theKiemKe(c, d); }))
      : h('p', { class: 'nhm-muted' }, 'Chưa có đợt kiểm kê nào. Mở thiết bị, ngăn hoặc Rack cần kiểm kê rồi bấm «Mở đợt kiểm kê»; hoặc bấm vào việc «Đến hạn kiểm kê».');
  }

  // ----- nhiệt độ thiết bị -----

  function soDoForm(containerId, xong) {
    var c = containerById(containerId);
    var nito = !!c && trongBinhNito(c);
    var fields = [{ name: 'nhiet_do', label: 'Nhiệt độ đang hiển thị trên thiết bị (°C)', type: 'text', required: true, placeholder: nito ? 'ví dụ -190' : 'ví dụ -82,5' }];
    if (nito) fields.push({ name: 'muc_nito', label: 'Mức nitơ lỏng (đọc trên thước đo của bình, không bắt buộc)', type: 'text' });
    fields.push({ name: 'ghi_chu', label: 'Ghi chú (không bắt buộc)', type: 'text' });
    openForm({
      title: 'Ghi số đo: ' + (c ? c.name : 'thiết bị'),
      fields: fields,
      submitLabel: 'Ghi số đo',
      onSubmit: function (f) {
        return api('POST', '/containers/' + containerId + '/temperatures', { nhiet_do: soGui(f.nhiet_do), muc_nito: soGui(f.muc_nito), ghi_chu: f.ghi_chu })
          .then(function (r) {
            if (r.ngoai_nguong) say('Số đo NGOÀI khoảng cho phép' + (r.canh_bao_id ? ': đã mở cảnh báo và báo quản lý.' : '.'), 'err');
            else say('Đã ghi số đo.', 'ok');
            return reload(true).then(taiMe).then(function () { if (xong) xong(); });
          });
      },
    });
  }

  function xuLyCanhBaoForm(alarmId) {
    openForm({
      title: 'Ghi nhận đã xử lý cảnh báo nhiệt độ',
      fields: [{ name: 'ly_do', label: 'Nguyên nhân và việc đã làm (có chuyển mẫu sang thiết bị khác không?)', type: 'textarea', required: true }],
      submitLabel: 'Ghi nhận',
      onSubmit: function (f) { return api('POST', '/alarms/' + alarmId + '/resolve', { ly_do: f.ly_do }).then(function () { say('Đã ghi nhận xử lý cảnh báo.', 'ok'); return reload(true).then(taiMe); }); },
    });
  }

  function caiDatNhietForm(c, r) {
    var gy = r.nguong.goi_y;
    openForm({
      title: 'Theo dõi nhiệt độ: ' + c.name,
      fields: [
        { name: 'theo_doi', label: 'Theo dõi nhiệt độ hằng ngày', type: 'select', options: [{ value: '1', label: 'Có — nhắc khi quên ghi, cảnh báo khi ra ngoài khoảng' }, { value: '0', label: 'Không' }], value: r.theo_doi ? '1' : '0' },
        { name: 'nguong_duoi', label: 'Thấp nhất cho phép (°C)' + (gy ? ' — để trống = ' + soVn(gy[0]) : ''), type: 'text', value: r.nguong.tu_dat && r.nguong.duoi != null ? soVn(r.nguong.duoi) : '' },
        { name: 'nguong_tren', label: 'Cao nhất cho phép (°C)' + (gy ? ' — để trống = ' + soVn(gy[1]) : ''), type: 'text', value: r.nguong.tu_dat && r.nguong.tren != null ? soVn(r.nguong.tren) : '' },
      ],
      submitLabel: 'Lưu',
      onSubmit: function (f) {
        return api('PUT', '/containers/' + c.id + '/monitoring', { theo_doi: f.theo_doi === '1', nguong_duoi: soGui(f.nguong_duoi), nguong_tren: soGui(f.nguong_tren) })
          .then(function () { say('Đã lưu cài đặt theo dõi nhiệt độ.', 'ok'); return reload(true); });
      },
    });
  }

  /** Biểu đồ số đo trong cửa sổ ngày: dải khoảng cho phép (xám nhạt), đường mực, chấm đỏ cho số đo ngoài khoảng. null nếu chưa có số đo. */
  function veBieuDoNhiet(r, ngay) {
    var pts = r.so_do;
    if (!pts.length) return null;
    var ns = 'http://www.w3.org/2000/svg';
    var W = 360, H = 150, L = 40, R = 12, T = 12, B = 24;
    var se = function (tag, a) { var e = document.createElementNS(ns, tag); Object.keys(a || {}).forEach(function (k) { e.setAttribute(k, a[k]); }); return e; };
    var ng = r.nguong;
    var ms = function (p) { return Date.parse(String(p.ghi_luc).replace(' ', 'T') + 'Z'); };
    var cuoi = Date.now(), dau = cuoi - ngay * 86400000;
    var vals = pts.map(function (p) { return p.nhiet_do; }).concat([ng.duoi, ng.tren].filter(function (v) { return v != null; }));
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = Math.max(1, (hi - lo) * 0.15); lo -= pad; hi += pad;
    var X = function (t) { return Math.min(W - R, Math.max(L, L + ((t - dau) / (cuoi - dau)) * (W - L - R))); };
    var Y = function (v) { return T + ((hi - v) / (hi - lo)) * (H - T - B); };
    var tomTat = pts.length + ' số đo trong ' + ngay + ' ngày, gần nhất ' + soVn(pts[pts.length - 1].nhiet_do) + '°C' + (pts.some(function (p) { return p.ngoai_nguong; }) ? ', có số đo ngoài khoảng cho phép' : '');
    var svg = se('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'nhm-nhiet__hinh', role: 'img', 'aria-label': tomTat, preserveAspectRatio: 'xMidYMid meet' });
    if (ng.duoi != null && ng.tren != null) svg.appendChild(se('rect', { x: L, y: Y(ng.tren), width: W - L - R, height: Math.max(1, Y(ng.duoi) - Y(ng.tren)), class: 'nhm-nhiet__dai' }));
    [ng.duoi, ng.tren].forEach(function (v) {
      if (v == null) return;
      svg.appendChild(se('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'nhm-nhiet__bien' }));
      var t = se('text', { x: L - 5, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'nhm-nhiet__nhan' }); t.textContent = soVn(v); svg.appendChild(t);
    });
    svg.appendChild(se('polyline', { points: pts.map(function (p) { return X(ms(p)).toFixed(1) + ',' + Y(p.nhiet_do).toFixed(1); }).join(' '), class: 'nhm-nhiet__duong' }));
    pts.forEach(function (p) {
      var c = se('circle', { cx: X(ms(p)).toFixed(1), cy: Y(p.nhiet_do).toFixed(1), r: p.ngoai_nguong ? 4 : 2.6, class: 'nhm-nhiet__cham' + (p.ngoai_nguong ? ' nhm-nhiet__cham--ngoai' : '') });
      var tt = se('title', {}); tt.textContent = soVn(p.nhiet_do) + '°C · ' + gioDia(p.ghi_luc) + (p.user_label ? ' · ' + p.user_label : ''); c.appendChild(tt);
      svg.appendChild(c);
    });
    [[dau, 'start'], [cuoi, 'end']].forEach(function (m) {
      var t = se('text', { x: m[1] === 'start' ? L : W - R, y: H - 7, 'text-anchor': m[1], class: 'nhm-nhiet__nhan' });
      var dd = new Date(m[0]);
      t.textContent = ('0' + dd.getDate()).slice(-2) + '/' + ('0' + (dd.getMonth() + 1)).slice(-2);
      svg.appendChild(t);
    });
    return svg;
  }

  function veNhietDo(c, r, ngay) {
    var nito = r.thiet_bi.la_binh_nito;
    var cb = r.canh_bao;
    var tt = cb ? h('span', { class: 'nhm-chip nhm-chip--no' }, 'Đang cảnh báo')
      : r.theo_doi ? (r.qua_han_ghi ? h('span', { class: 'nhm-chip nhm-chip--warn' }, 'Quá ' + r.chu_ky_ghi_ngay + ' ngày chưa ghi') : h('span', { class: 'nhm-chip nhm-chip--ok' }, 'Đang theo dõi'))
      : h('span', { class: 'nhm-chip' }, 'Chưa theo dõi');
    var ng = r.nguong;
    var khoang = ng.duoi != null || ng.tren != null ? 'Khoảng cho phép ' + soVn(ng.duoi) + ' đến ' + soVn(ng.tren) + '°C' + (ng.tu_dat ? '' : ' (gợi ý theo nhiệt độ chuẩn ' + soVn(r.thiet_bi.temperature_c) + '°C)') : 'Chưa có khoảng nhiệt độ cho phép.';
    var m = r.moi_nhat;
    var nut = [];
    if (r.quyen_ghi) nut.push(nutNho('Ghi số đo', 'primary', function () { soDoForm(c.id); }));
    if (r.quyen_cai_dat) nut.push(nutNho(r.theo_doi ? 'Cài đặt theo dõi' : 'Bật theo dõi nhiệt độ', '', function () { caiDatNhietForm(c, r); }));
    var hinh = veBieuDoNhiet(r, ngay);
    return [
      h('div', { class: 'nhm-nhiet__dau' }, [h('h3', {}, 'Nhiệt độ thiết bị'), tt]),
      cb ? h('div', { class: 'nhm-notice nhm-notice--canh', role: 'alert' }, h('div', { class: 'nhm-notice-row' }, [
        h('span', {}, 'Số đo ' + soVn(cb.nhiet_do) + '°C ngày ' + gioDia(cb.created_at) + ' ra ngoài khoảng cho phép. Kiểm tra thiết bị, chuyển mẫu nếu cần rồi ghi nhận đã xử lý.'),
        r.quyen_cai_dat ? h('span', { class: 'nhm-notice-act' }, nutNho('Ghi nhận xử lý', 'primary', function () { xuLyCanhBaoForm(cb.id); })) : null,
      ])) : null,
      h('p', { class: 'nhm-small' }, m
        ? ['Gần nhất: ', h('b', { class: m.ngoai_nguong ? 'nhm-nhiet__xau' : '' }, soVn(m.nhiet_do) + '°C'), nito && m.muc_nito != null ? ' · nitơ ' + soVn(m.muc_nito) : '', ' · ' + gioDia(m.ghi_luc) + (m.user_label ? ' · ' + m.user_label : '')]
        : 'Chưa có số đo nào.'),
      h('p', { class: 'nhm-small nhm-muted' }, khoang),
      hinh ? h('div', { class: 'nhm-nhiet__khung' }, hinh) : null,
      nut.length ? h('div', { class: 'nhm-actions' }, nut) : null,
      r.so_do.length ? h('details', { class: 'nhm-nhiet__nk' }, [
        h('summary', {}, 'Nhật ký số đo (' + r.so_do.length + ' trong ' + ngay + ' ngày)'),
        h('div', { class: 'nhm-bang-cuon' }, h('table', { class: 'nhm-hist' }, [
          h('thead', {}, h('tr', {}, [h('th', {}, 'Lúc'), h('th', {}, '°C')].concat(nito ? [h('th', {}, 'Nitơ')] : [], [h('th', {}, 'Người ghi'), h('th', {}, 'Ghi chú')]))),
          h('tbody', {}, r.so_do.slice().reverse().slice(0, 100).map(function (p) {
            return h('tr', {}, [h('td', { 'data-l': 'Lúc' }, gioDia(p.ghi_luc)), h('td', { 'data-l': '°C', class: p.ngoai_nguong ? 'nhm-nhiet__xau' : '' }, soVn(p.nhiet_do))]
              .concat(nito ? [h('td', { 'data-l': 'Nitơ' }, soVn(p.muc_nito))] : [], [h('td', { 'data-l': 'Người ghi' }, p.user_label || ''), h('td', { 'data-l': 'Ghi chú' }, p.ghi_chu || '')]));
          })),
        ])),
      ]) : null,
    ];
  }

  /** Khung «Nhiệt độ thiết bị» ở trang chi tiết thiết bị gốc; tải số đo rồi vẽ. */
  function nhietDoPanel(c) {
    var ngay = 30;
    var vung = h('section', { class: 'nhm-nhiet', 'aria-label': 'Nhiệt độ thiết bị' }, h('div', { class: 'nhm-loading' }, 'Đang tải nhiệt độ…'));
    api('GET', '/containers/' + c.id + '/temperatures?days=' + ngay)
      .then(function (r) { put.apply(null, [vung].concat(veNhietDo(c, r, ngay))); })
      .catch(function (e) { put(vung, h('p', { class: 'nhm-err' }, e.message)); });
    return vung;
  }

  // ----- bảng «Việc cần xử lý» -----
  function moCongViec(tab, gapSan) {
    state.search = null; state.sel = null; state.box = null; state.audit = null; state.dtb = null;
    state.cv = { tab: tab || 'inbox', data: null, dsMo: !gapSan };
    if (location.hash !== '#cong-viec') location.hash = 'cong-viec';
    renderTree();
    renderDetail();
    taiCv();
  }

  function taiCv() {
    var c = state.cv; if (!c) return Promise.resolve();
    var url = { inbox: '/requests?view=inbox', mine: '/requests?view=mine', done: '/requests?view=done', all: '/requests?view=all', saphet: '/volume/low', phathien: '/findings', nghimat: '/incidents', vipham: '/violations', denhan: '/reminders', kiemke: '/inventories' }[c.tab];
    // tab «Cần tôi xử lý» kèm lịch sử đã xử lý ở phía dưới (hai lần gọi độc lập; lịch sử lỗi thì chỉ không hiện)
    var ls = c.tab === 'inbox' ? api('GET', '/requests?view=done').then(function (x) { return x.requests || []; }, function () { return []; }) : Promise.resolve(null);
    return Promise.all([api('GET', url), ls]).then(function (kq) {
      var r = kq[0];
      if (state.cv !== c) return;
      c.data = r.requests || r.findings || r.incidents || r.violations || r.sap_het || r.viec || r.inventories || [];
      c.chuaGhi = r.chua_ghi || 0;
      c.lichSu = kq[1];
      renderDetail();
    }).catch(function (e) { say(e.message, 'err'); });
  }

  function renderCongViec(root) {
    var c = state.cv, me = state.me || { yeuCau: { inbox: 0, mine: 0 }, phatHienMo: 0, vuViecMo: 0 };
    var tabs = [['inbox', 'Cần tôi xử lý', me.yeuCau.inbox], ['mine', 'Yêu cầu của tôi', me.yeuCau.mine], ['phathien', 'Mẫu chưa khai báo', me.phatHienMo], ['nghimat', 'Mẫu nghi mất', me.vuViecMo]];
    if (state.meta.canManage || me.denHan) tabs.push(['denhan', 'Đến hạn', me.denHan || 0]);
    if (state.meta.canManage || state.meta.laVienTruong) tabs.push(['kiemke', 'Kiểm kê', 0]);
    if (state.meta.canManage) tabs.push(['all', 'Tất cả yêu cầu', 0], ['vipham', 'Lấy không xin phép', 0]);
    if (state.meta.canManage && nganHang === 'khang_the') tabs.push(['saphet', 'Ống sắp hết', 0]);
    var bar = h('div', { class: 'nhm-tabs', role: 'tablist' }, tabs.map(function (t) {
      return h('button', { type: 'button', role: 'tab', class: 'nhm-tab' + (t[0] === c.tab ? ' nhm-tab--on' : ''), 'aria-selected': String(t[0] === c.tab), onclick: function () { moCongViec(t[0]); } },
        [t[1], t[2] ? h('span', { class: 'nhm-count' }, String(t[2])) : null]);
    }));
    var noiDung;
    // quản lý ngân hàng kháng thể: yêu cầu đang chờ Viện trưởng duyệt chỉ để THEO DÕI, tách khỏi việc của mình
    var theo = c.tab === 'inbox' && c.data ? c.data.filter(function (y) { return y.theo_doi; }) : [];
    var ds = c.tab === 'inbox' && c.data ? c.data.filter(function (y) { return !y.theo_doi; }) : c.data;
    if (!c.data) noiDung = h('div', { class: 'nhm-loading' }, 'Đang tải…');
    else if (c.tab === 'denhan') {
      noiDung = c.data.length ? h('div', { class: 'nhm-cards' }, c.data.map(theDenHan)) : h('p', { class: 'nhm-muted' }, 'Không có việc nào đến hạn: kiểm kê, mycoplasma, STR và nhiệt độ đều đang trong chu kỳ.');
    } else if (c.tab === 'kiemke') noiDung = noiDungKiemKe(c);
    else if (c.tab === 'vipham') {
      noiDung = c.data.length ? h('div', { class: 'nhm-cards' }, c.data.map(function (x) {
        return h('div', { class: 'nhm-card' }, [h('div', { class: 'nhm-card-top' }, [h('strong', {}, x.ten), h('span', { class: 'nhm-chip nhm-chip--warn' }, x.so_lan + ' lần')]),
          h('div', { class: 'nhm-small nhm-muted' }, (x.nhom_ten ? 'Nhóm ' + x.nhom_ten + ' · ' : '') + 'gần nhất ' + gioDia(x.gan_nhat))]);
      })) : h('p', { class: 'nhm-muted' }, 'Chưa có trường hợp lấy mẫu không xin phép nào được chủ mẫu xác nhận.');
    } else if (c.tab === 'saphet') {
      noiDung = h('div', {}, [
        c.chuaGhi ? h('p', { class: 'nhm-hint' }, c.chuaGhi + ' ống chưa ghi thể tích: mở ống và bấm «Ghi thể tích ban đầu».') : null,
        c.data.length ? h('div', { class: 'nhm-cards' }, c.data.map(function (x) {
          return h('div', { class: 'nhm-card' }, [
            h('div', { class: 'nhm-card-top' }, [h('strong', {}, x.name), h('span', { class: 'nhm-chip nhm-tt-chip nhm-tt-chip--sap_het' }, 'Sắp hết')]),
            h('div', { class: 'nhm-small' }, 'Còn ' + ul(x.con_lai_ul) + ' / ' + ul(x.the_tich_ul) + ' · ' + x.vi_tri),
            h('div', { class: 'nhm-tt-bar nhm-tt-bar--sap_het', role: 'img', 'aria-label': 'Còn ' + Math.round(x.ty_le * 100) + '%' }, h('span', { style: 'width:' + Math.round(x.ty_le * 100) + '%' })),
            h('div', { class: 'nhm-card-act' }, [nutNho('Xem ống', '', function () { moMauTheoId(x.id); })]),
          ]);
        })) : h('p', { class: 'nhm-muted' }, 'Không có ống kháng thể nào sắp hết (còn ≤ 20% thể tích ban đầu).'),
      ]);
    } else if (!ds.length) noiDung = h('p', { class: 'nhm-muted' }, { inbox: 'Không có yêu cầu nào đang chờ bạn xử lý.', mine: 'Bạn chưa gửi yêu cầu nào.', done: 'Chưa có yêu cầu nào đã được xử lý. Yêu cầu đã duyệt hoặc từ chối sẽ được lưu ở đây (quản lý module thấy tất cả).', phathien: 'Không có mẫu nào đang chờ chủ mẫu khai báo.', nghimat: 'Không có mẫu nào đang bị báo nghi mất.', all: 'Chưa có yêu cầu nào.' }[c.tab]);
    else noiDung = h('div', { class: 'nhm-cards' }, ds.map(c.tab === 'phathien' ? theMauChuaKhaiBao : c.tab === 'nghimat' ? theNghiMat : theYeuCau));
    if (c.tab === 'inbox' && ds && ds.length) noiDung = gapDanhSach(c, noiDung, ds.length); // danh sách việc: gập sẵn khi mở từ địa chỉ / thư
    put(root, h('div', { class: 'nhm-title' }, [h('h2', {}, 'Việc cần xử lý')]), bar, noiDung, theo.length ? theoDoiViTruong(theo) : null, c.tab === 'inbox' && c.data ? lichSuXuLy(c) : null);
  }

  /** Bọc danh sách «Cần tôi xử lý» trong khung gập (người ít dùng máy chỉ cần thanh đỏ báo việc; bấm «Xem và xử lý» để mở). */
  function gapDanhSach(c, noiDung, n) {
    var det = h('details', { class: 'nhm-ls nhm-ls--viec' }, [
      h('summary', {}, h('span', { class: 'nhm-ls__tit' }, 'Cần tôi xử lý (' + n + ')')),
      noiDung,
    ]);
    det.open = !!c.dsMo;
    det.addEventListener('toggle', function () { c.dsMo = det.open; });
    return det;
  }

  /** Ngân hàng kháng thể: yêu cầu đang chờ Viện trưởng duyệt, quản lý chỉ xem (không có nút duyệt). Gập sẵn. */
  function theoDoiViTruong(ds) {
    return h('details', { class: 'nhm-ls nhm-ls--theo', 'aria-label': 'Đang chờ Viện trưởng duyệt' }, [
      h('summary', {}, h('span', { class: 'nhm-ls__tit' }, 'Đang chờ Viện trưởng duyệt — bạn theo dõi (' + ds.length + ')')),
      h('p', { class: 'nhm-muted nhm-small' }, 'Chỉ Viện trưởng duyệt. Khi yêu cầu được duyệt, nó chuyển lên «Cần tôi xử lý» để bạn giao mẫu.'),
      h('div', { class: 'nhm-cards' }, ds.map(theYeuCau)),
    ]);
  }

  /**
   * Lịch sử yêu cầu đã xử lý, dưới danh sách «Cần tôi xử lý». GẬP SẴN (người ít dùng máy chỉ thấy việc cần làm); bấm «Xem lịch sử» để mở.
   * Mở rồi hiện 10 mục gần nhất, bấm để xem hết. Không có gì thì không hiện.
   */
  function lichSuXuLy(c) {
    var ds = c.lichSu || [];
    if (!ds.length) return null;
    var hetHet = !!c.lichSuHet;
    var det = h('details', { class: 'nhm-ls', 'aria-label': 'Lịch sử xử lý' }, [
      h('summary', {}, h('span', { class: 'nhm-ls__tit' }, 'Lịch sử xử lý (' + ds.length + ')')),
      h('p', { class: 'nhm-muted nhm-small' }, 'Yêu cầu đã duyệt hoặc từ chối được lưu lại ở đây.'),
      h('div', { class: 'nhm-cards' }, (hetHet ? ds : ds.slice(0, 10)).map(theYeuCau)),
      ds.length > 10 ? h('p', {}, nutNho(hetHet ? 'Thu gọn' : 'Xem tất cả ' + ds.length + ' mục', '', function () { c.lichSuHet = !hetHet; renderDetail(); })) : null,
    ]);
    det.open = !!c.lichSuMo; // nhớ trạng thái mở khi bảng được vẽ lại
    det.addEventListener('toggle', function () { c.lichSuMo = det.open; });
    return det;
  }

  // ---------- măng-sét: lời chào, về trang chủ, đăng xuất ----------
  function logout() {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(function () {}).then(function () {
      try { localStorage.removeItem('token'); localStorage.removeItem('user'); } catch (e) {}
      location.href = '/dang-nhap.html';
    });
  }

  /** Lời chào: «Xin chào <lời chào trong hồ sơ>» (vd Viện trưởng); chưa đặt thì chào bằng tên tài khoản. */
  var loiChaoNode = null;
  function capNhatLoiChao() {
    if (!loiChaoNode) return;
    var chao = (state.me && state.me.hoSo && state.me.hoSo.chuc_danh) || state.tenChao;
    loiChaoNode.textContent = chao ? 'Xin chào ' + chao : 'Xin chào';
  }

  function initHeader() {
    var box = $('auth-status');
    if (!box) return;
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (!me) return;
        var u = me.user || me;
        state.tenChao = (u.fullname && String(u.fullname).trim()) || (u.email ? String(u.email).split('@')[0] : '');
        loiChaoNode = h('span', { class: 'auth-user-info' });
        capNhatLoiChao();
        put(box, 
          loiChaoNode,
          h('a', { href: '/index.html', class: 'auth-btn-admin' }, 'Trang chủ'),
          h('button', { type: 'button', class: 'auth-btn-logout', onclick: logout }, 'Đăng xuất')
        );
      })
      .catch(function () {});
  }

  // ---------- khởi động ----------
  /** Màn hình chọn ngân hàng: hai nút lớn, mỗi nút ghi số thiết bị, mẫu và việc cần xử lý của người đang đăng nhập. */
  function moManHinhChon() {
    document.querySelector('.nhm-shell').classList.add('nhm-hide');
    $('nhm-chon-nh').classList.remove('nhm-hide');
    // lời chào theo hồ sơ (vd «Xin chào Viện trưởng») cũng hiện ở màn hình chọn, không chỉ trong ngân hàng
    api('GET', '/me').then(function (m) { state.me = m; capNhatLoiChao(); }).catch(function () {});
    api('GET', '/banks').then(function (r) {
      put.apply(null, [$('nhm-chon-ds')].concat(r.ngan_hang.map(function (b) {
        return h('a', { class: 'nhm-chon-the', href: '?nh=' + b.ma }, [
          h('span', { class: 'nhm-chon-ten' }, b.ten),
          h('span', { class: 'nhm-chon-phu' }, b.thiet_bi + ' thiết bị · ' + b.mau + ' mẫu'),
          h('span', { class: 'nhm-chon-nhan' }, [
            b.viec ? h('span', { class: 'nhm-count nhm-count--canh' }, b.viec + ' việc cần xử lý') : null,
            b.la_quan_ly ? h('span', { class: 'nhm-chip' }, 'Bạn quản lý') : null,
          ]),
        ]);
      })));
    }).catch(function (e) { put($('nhm-chon-ds'), h('p', { class: 'nhm-err' }, e.message)); });
  }

  function init() {
    if (!nganHang) { moManHinhChon(); return; }
    $('nhm-nh-ten').textContent = NH_VN[nganHang];
    $('nhm-nh-doi').href = location.pathname; // về màn hình chọn
    document.title = NH_VN[nganHang] + ' — STIMS';
    api('GET', '/meta').then(function (meta) {
      state.meta = meta;
      $('nhm-search-form').addEventListener('submit', function (ev) {
        ev.preventDefault();
        runSearch({ q: $('nhm-search-q').value.trim(), sample_type_id: '', owner: '', status: '', offset: 0 });
      });
      var addRoot = $('nhm-add-root');
      if (meta.canManage || (meta.laVienTruong && !meta.khongPublic)) { // Viện trưởng chỉ tạo thiết bị riêng, ngân hàng kháng thể không có
        addRoot.classList.remove('nhm-hide');
        addRoot.addEventListener('click', function () { containerForm(null, null); });
      }
      if (nganHang === 'te_bao') {
        var nutDtb = $('nhm-dong-tb');
        nutDtb.classList.remove('nhm-hide');
        nutDtb.addEventListener('click', function () { moDongTeBao(); });
      }
      if (nganHang === 'khang_the' && (meta.laVienTruong || meta.canManage)) { // Viện trưởng cấp / thu hồi, quản lý xem
        var nutUq = $('nhm-uy-quyen');
        nutUq.classList.remove('nhm-hide');
        nutUq.addEventListener('click', function () { uyQuyenDialog(); });
      }
      if (meta.canManage) {
        var qlDm = $('nhm-manage-catalog');
        qlDm.classList.remove('nhm-hide');
        qlDm.addEventListener('click', function () { quanTriDialog('danhmuc'); });
      }
      return Promise.all([api('GET', '/tree'), api('GET', '/me'), taiNhom()]).then(function (rs) { state.me = rs[1]; capNhatLoiChao(); renderBanner(); return rs[0]; });
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
      if (location.hash === '#den-han') moCongViec('denhan');
      else if (location.hash === '#cong-viec') moCongViec('inbox', true);
      else if (state.sel && state.sel.type === 'box') cuonToiChiTiet(); // mở thẳng một hộp: cuộn tới lưới hộp
    }).catch(function (e) {
      $('nhm-tree').textContent = '';
      say(e.message, 'err');
    });
  }

  initHeader();
  init();
})();
