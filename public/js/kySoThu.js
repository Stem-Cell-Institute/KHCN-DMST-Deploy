/*
 * Trang THỬ ký số MySign (ky-so-thu.html, chỉ quản trị viên): liên kết tài khoản MySign của chính mình, đặt khung chữ ký trên một PDF MẪU,
 * ký, rồi tải về và kiểm chữ ký. Không dính dữ liệu nghiệp vụ nên thử được mà không cần vai trò Viện trưởng.
 * API: /api/mysign/* (routes/mysign.js). Mọi chữ hiển thị dựng bằng DOM + textContent.
 */
(function () {
  'use strict';

  var main = document.getElementById('main');
  var banner = document.getElementById('thong-bao');
  var timer = null;

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === false || v === null || v === undefined) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.append(x.nodeType ? x : document.createTextNode(String(x))); });
      else if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function thongBao(msg, loai) {
    banner.textContent = msg;
    banner.dataset.loai = loai || '';
    banner.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(function () { banner.hidden = true; }, loai === 'loi' ? 8000 : 4500);
  }

  function api(duong, opt) {
    opt = opt || {};
    return fetch('/api/mysign' + duong, {
      method: opt.method || 'GET',
      headers: opt.body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(function () {
      throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.');
    }).then(function (res) {
      if (res.status === 401) { location.href = '/dang-nhap.html?returnUrl=' + encodeURIComponent(location.pathname); return new Promise(function () {}); }
      return res.json().catch(function () { return null; }).then(function (d) {
        if (!res.ok) { var e = new Error((d && d.message) || 'Lỗi ' + res.status); e.status = res.status; throw e; }
        return d;
      });
    });
  }

  var tk = null; // {da_cau_hinh, tai_khoan}
  var ketQua = h('div', { class: 'ky-thu-kq', 'aria-live': 'polite' });
  var dungTheoDoi = null;
  var dangKy = false;

  function veTaiKhoan() {
    var t = tk.tai_khoan;
    if (!tk.da_cau_hinh) {
      return h('div', { class: 'luu-y luu-y-do', role: 'status' }, h('p', null, h('strong', { text: 'Hệ thống chưa được cấu hình MySign. ' }), 'Cần đặt MYSIGN_CLIENT_ID, MYSIGN_CLIENT_SECRET, MYSIGN_PROFILE_ID trong cấu hình máy chủ.'));
    }
    if (t) {
      return h('div', { class: 'luu-y' },
        h('p', null, h('strong', { text: 'Đã liên kết: ' }), t.mysign_user_id),
        h('p', { text: 'Chứng thư: ' + (t.chu_the || '—') + (t.het_han ? ' · hết hạn ' + t.het_han : '') }),
        h('p', { class: 'mo', text: 'Số điện thoại: ' + (t.so_dien_thoai || '—') }),
        h('div', { class: 'nhom-nut' }, h('button', { type: 'button', class: 'btn btn-phu btn-nho', onclick: huyLienKet }, 'Đổi / bỏ liên kết')));
    }
    var o = h('input', { type: 'text', id: 'ma-mysign', maxlength: 50, autocomplete: 'off', spellcheck: 'false' });
    var loi = h('p', { class: 'loi-truong', role: 'alert', hidden: true });
    var f = h('form', { novalidate: true },
      h('div', { class: 'truong' }, h('label', { for: 'ma-mysign', text: 'Mã tài khoản MySign của bạn' }), h('p', { class: 'tro-giup', text: 'Mã do Viettel cấp. Không cần mật khẩu: mỗi lần ký bạn xác nhận trên ứng dụng MySign.' }), o, loi),
      h('button', { type: 'submit', class: 'btn' }, 'Liên kết'));
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      loi.hidden = true;
      var ma = o.value.trim();
      if (!ma) { loi.textContent = 'Hãy nhập mã tài khoản MySign.'; loi.hidden = false; return; }
      window.MySign.lienKet(ma).then(function (r) { tk = { da_cau_hinh: true, tai_khoan: r.tai_khoan }; thongBao('Đã liên kết tài khoản MySign.'); ve(); })
        .catch(function (er) { loi.textContent = er.message; loi.hidden = false; });
    });
    return f;
  }

  function huyLienKet() {
    api('/tai-khoan', { method: 'DELETE' }).then(function () { tk.tai_khoan = null; ve(); }).catch(function (e) { thongBao(e.message, 'loi'); });
  }

  function chonVaKy() {
    if (dangKy) return;
    window.KySoViTri.dat({ tieuDe: 'Đặt khung chữ ký số', tai: [{ ten: 'Tài liệu mẫu để thử ký số', tai: window.KySoViTri.taiTuUrl('/api/mysign/thu/xem-truoc') }] })
      .then(function (kq) {
        if (!kq) return null;
        dangKy = true;
        ve();
        return api('/thu/ky', { method: 'POST', body: { vi_tri: kq.viTri[0], khung: kq.khung || undefined } }).then(function (r) { theoDoi(r.giao_dich); });
      })
      .catch(function (e) {
        dangKy = false;
        ve();
        if (e.status === 409 && /liên kết/i.test(e.message)) { tk.tai_khoan = null; ve(); }
        thongBao(e.message, 'loi');
      });
  }

  function theoDoi(g) {
    if (dungTheoDoi) dungTheoDoi();
    ketQua.replaceChildren(h('div', { class: 'luu-y', role: 'status' }, h('p', null, h('strong', { text: 'Mở ứng dụng MySign trên điện thoại để xác nhận ký.' })), h('p', { class: 'mo', text: 'Xác nhận bằng vân tay hoặc khuôn mặt. Trang này tự cập nhật khi có kết quả.' })));
    dungTheoDoi = window.MySign.theoDoi(g.id, null, function (kq) {
      dangKy = false;
      dungTheoDoi = null;
      if (kq.trang_thai === 'thanh_cong') hienKetQuaKy(kq); else {
        ketQua.replaceChildren(h('div', { class: 'luu-y luu-y-do', role: 'status' }, h('p', null, h('strong', { text: 'Chưa ký được. ' }), kq.thong_diep || 'Yêu cầu ký không thành công.')));
      }
      ve();
    });
  }

  function hienKetQuaKy(g) {
    var kiemTra = h('div', { class: 'luu-y', role: 'status' }, h('p', { text: 'Đang kiểm chữ ký…' }));
    ketQua.replaceChildren(
      h('div', { class: 'luu-y', role: 'status' }, h('p', null, h('strong', { text: 'Đã ký xong.' })), h('p', { class: 'mo', text: 'Mở bằng Adobe Reader (hoặc trình đọc PDF có hỗ trợ chữ ký số) để xem bảng chữ ký.' }),
        h('div', { class: 'nhom-nut' },
          h('a', { class: 'btn', href: '/api/mysign/thu/ban-ky/' + g.id + '?xem=1', target: '_blank', rel: 'noopener' }, 'Mở PDF đã ký'),
          h('a', { class: 'btn btn-phu', href: '/api/mysign/thu/ban-ky/' + g.id }, 'Tải về'))),
      kiemTra);
    api('/thu/kiem-tra/' + g.id).then(function (k) {
      kiemTra.className = 'luu-y' + (k.hopLe ? '' : ' luu-y-do');
      kiemTra.replaceChildren(h('p', null, h('strong', { text: k.hopLe ? 'Chữ ký hợp lệ' : 'Chữ ký KHÔNG hợp lệ' }), k.hopLe ? ' — nội dung chưa bị thay đổi sau khi ký.' : ': ' + (k.ly_do || '')),
        k.hopLe ? h('p', { class: 'mo', text: 'Chứng thư: ' + String(k.chu_the || '').replace(/\n/g, ', ') + ' · số seri ' + (k.so_seri || '—') }) : null);
    }).catch(function (e) { kiemTra.replaceChildren(h('p', { text: e.message })); });
  }

  function ve() {
    var nodes = [
      h('h2', { text: 'Thử ký số MySign' }),
      h('p', { class: 'phu', text: 'Dùng tài khoản MySign của chính bạn để ký một PDF mẫu: kéo khung chữ ký tới chỗ bạn muốn, ký, rồi tải về kiểm tra. Không dính dữ liệu báo cáo nào.' }),
      h('h3', { text: '1. Tài khoản MySign' }),
      veTaiKhoan(),
    ];
    if (tk.da_cau_hinh && tk.tai_khoan) {
      nodes.push(h('h3', { text: '2. Chọn vị trí khung và ký' }),
        h('p', { class: 'mo', text: 'Bản xem trước là PDF thật 3 trang. Kéo khung để dời, kéo bốn góc để co giãn, đổi trang bằng nút ‹ ›.' }),
        h('div', { class: 'nhom-nut' }, h('button', { type: 'button', class: 'btn', disabled: dangKy, onclick: chonVaKy }, 'Chọn vị trí khung rồi ký')),
        h('h3', { text: '3. Kết quả' }), ketQua);
    }
    main.replaceChildren.apply(main, nodes);
  }

  function khoiDong() {
    api('/tai-khoan').then(function (r) {
      tk = r;
      // Kiểm quyền sớm: chỉ quản trị viên dùng được các đường /thu/*.
      return fetch('/api/mysign/thu/xem-truoc', { method: 'HEAD', credentials: 'same-origin' }).then(function (res) {
        if (res.status === 403) {
          main.replaceChildren(h('h2', { text: 'Không có quyền' }), h('div', { class: 'luu-y luu-y-do' }, h('p', { text: 'Trang thử ký số chỉ dành cho quản trị viên hệ thống.' })));
          return;
        }
        ve();
      });
    }).catch(function (e) {
      main.replaceChildren(h('h2', { text: 'Không tải được' }), h('div', { class: 'luu-y luu-y-do', role: 'alert' }, h('p', { text: e.message })));
    });
  }

  khoiDong();
})();
