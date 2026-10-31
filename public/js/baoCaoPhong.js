/*
 * Giao diện module Báo cáo phòng ban (trang bao-cao-phong.html).
 * API: /api/bao-cao-phong/* — xem routes/baoCaoPhong.js.
 *
 * Mọi nội dung động đều dựng bằng DOM + textContent (hàm h), KHÔNG dùng innerHTML với dữ
 * liệu người dùng: tên phòng, nhãn ô, nội dung báo cáo… đều do người dùng gõ, nên đưa thẳng
 * vào HTML là mở cửa cho XSS.
 *
 * Định tuyến theo hash (#/dot, #/dot/12, #/bao-cao/5, #/mau, #/mau/3, #/phong, #/cua-toi).
 * Đổi mục thì chuyển focus về tiêu đề mới để người dùng bàn phím/đọc màn hình biết đã sang trang.
 */
(function () {
  'use strict';

  var API = '/api/bao-cao-phong';
  var main = document.getElementById('main');
  var nav = document.getElementById('dieu-huong');
  var live = document.getElementById('live');
  var banner = document.getElementById('thong-bao');
  var hop = document.getElementById('hop-thoai');

  var me = null;
  var BCP = null; // = window.BCP, gán ở cuối tệp
  var donDep = []; // việc dọn dẹp của màn hình hiện tại (xem BCP.khiRoiTrang)
  // Báo cáo của phòng MÌNH đang cần nộp / chỉnh sửa (mọi vai trò có phòng, kể cả quản lý kiêm trưởng phòng).
  // Dải "việc của bạn" dựa vào đây để người không quen công nghệ thấy ngay việc phải làm, không phải đi tìm.
  var viec = [];
  var hienDai = false;
  var daiViec = document.createElement('div');
  daiViec.id = 'viec-cua-toi';
  daiViec.className = 'dai-viec';
  main.parentNode.insertBefore(daiViec, main);
  var dirty = false; // có thay đổi chưa lưu
  var hashHienTai = '';
  var khoiPhucHash = false;

  // ── Nhãn hiển thị ─────────────────────────────────────────────────────────
  var TT_BAO_CAO = {
    chua_nop: ['○', 'Chưa nộp', ''],
    da_nop: ['●', 'Đã nộp, chờ xác nhận', 'nhan-nop'],
    can_chinh_sua: ['!', 'Cần chỉnh sửa', 'nhan-chu-y'],
    da_duyet: ['✓', 'Đã xác nhận', 'nhan-duyet'],
  };
  var TT_DOT = {
    nhap: ['', 'Nháp', ''],
    dang_mo: ['●', 'Đang mở', 'nhan-mo'],
    dong: ['', 'Đã đóng', ''],
  };
  // Chức danh người phụ trách báo cáo của phòng (khớp services/baoCaoPhongChucDanh.js). Đều là vai trò truong_phong về quyền.
  var CHUC_DANH = { truong_phong: 'Trưởng phòng', pho_truong_phong: 'Phó trưởng phòng', quyen_truong_phong: 'Quyền trưởng phòng', ke_toan: 'Kế toán' };
  var LOAI_DOT = { tuan: 'Tuần', thang: 'Tháng', quy: 'Quý', nam: 'Năm', dot_xuat: 'Đột xuất' };
  var KIEU_O = {
    text: 'Văn bản ngắn',
    textarea: 'Văn bản dài',
    number: 'Số',
    date: 'Ngày',
    select: 'Chọn một trong danh sách',
    checkbox: 'Ô đánh dấu (có/không)',
    section: 'Tiêu đề nhóm',
    bang: 'Bảng nhiều dòng',
    tong_hop: 'Số liệu tổng hợp tự động',
  };
  var HANH_DONG = {
    nop: 'Nộp báo cáo',
    nop_lai: 'Nộp lại sau chỉnh sửa',
    duyet: 'Xác nhận',
    tu_duyet: 'Tự xác nhận (người nộp cũng là người xác nhận)',
    yeu_cau_chinh_sua: 'Yêu cầu chỉnh sửa',
    vt_duyet: 'Viện trưởng duyệt',
    vt_khong_duyet: 'Viện trưởng không duyệt',
    vt_de_nghi_chinh_sua: 'Viện trưởng đề nghị chỉnh sửa',
  };
  // Trạng thái của báo cáo trong con mắt của Viện trưởng (khớp trangThaiVienTruong() ở services/baoCaoPhongVienTruong.js).
  // Khác TT_BAO_CAO: đó là XÁC NHẬN của người quản lý module; đây là QUYẾT ĐỊNH của Viện trưởng. Hai việc độc lập nhau.
  var TT_VT = {
    chua_nop: ['○', 'Chưa nộp', ''],
    dang_sua: ['↺', 'Phòng đang chỉnh sửa', 'nhan-chu-y'],
    de_nghi_chinh_sua: ['↺', 'Đã đề nghị chỉnh sửa', 'nhan-chu-y'],
    cho_quyet_dinh: ['●', 'Chờ duyệt', 'nhan-nop'],
    duyet: ['✓', 'Viện trưởng đã duyệt', 'nhan-duyet'],
    khong_duyet: ['✕', 'Viện trưởng không duyệt', 'nhan-chu-y'],
  };

  // ── Tiện ích ──────────────────────────────────────────────────────────────

  /** Dựng phần tử DOM. Dữ liệu luôn đi qua textContent / createTextNode. */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === false || v === null || v === undefined) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'value') return; // đặt sau khi có con (select cần option trước)
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    if (a.value !== undefined && a.value !== null) el.value = a.value;
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }

  function fmtNgay(s) {
    return s ? String(s).split('-').reverse().join('/') : '';
  }
  /** "còn N ngày" / "hết hạn trong hôm nay" / "đã quá hạn N ngày", theo ngày Việt Nam. */
  function conLaiNgay(han) {
    var homNay = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    var n = Math.round((Date.parse(han + 'T00:00:00Z') - Date.parse(homNay + 'T00:00:00Z')) / 86400000);
    if (isNaN(n)) return '';
    return n > 0 ? 'còn ' + n + ' ngày' : n === 0 ? 'hết hạn trong hôm nay' : 'đã quá hạn ' + (-n) + ' ngày';
  }
  /** Đơn vị đếm tiến độ: đợt "mỗi người một báo cáo" đếm theo báo cáo (một phòng có thể có nhiều báo cáo), đợt thường đếm theo phòng. */
  function donVi(cachNop) { return cachNop === 'tat_ca' ? 'báo cáo' : 'phòng'; }
  /** "Họ tên — Chức danh" của người phụ trách một báo cáo riêng (rỗng nếu là báo cáo chung của phòng). */
  function nguoiPhuTrachNhan(b) {
    return b.chu_ten ? b.chu_ten + (b.chuc_danh && CHUC_DANH[b.chuc_danh] ? ' — ' + CHUC_DANH[b.chuc_danh] : '') : '';
  }
  function fmtGio(s) {
    if (!s) return '';
    var t = /^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(' ', 'T') + 'Z' : s; // SQLite datetime('now') là UTC, không có 'Z'
    var d = new Date(t);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function nhan(map, key, them) {
    var m = map[key] || ['', key, ''];
    return h('span', { class: 'nhan ' + m[2] + (them ? ' ' + them : '') }, m[0] ? h('span', { 'aria-hidden': 'true', text: m[0] }) : null, m[1]);
  }
  /** Nhãn quyết định của Viện trưởng, CHỈ khi ông đã quyết định (duyệt / không duyệt / đề nghị sửa); không có thì null. Dùng cho phòng và quản lý. */
  function nhanQuyetDinh(b) {
    var q = b && b.vt_trang_thai;
    return q === 'duyet' || q === 'khong_duyet' || q === 'de_nghi_chinh_sua' ? nhan(TT_VT, q) : null;
  }
  /** Nhãn "Đã trình" / "Chưa trình" Viện trưởng của một đợt (người quản lý cần phân biệt đợt nào đã trình, đợt nào chưa). */
  function nhanTrinh(daTrinh, lan) {
    return daTrinh
      ? h('span', { class: 'nhan nhan-duyet' }, h('span', { 'aria-hidden': 'true', text: '✓' }), 'Đã trình' + (lan > 1 ? ' (lần ' + lan + ')' : ''))
      : h('span', { class: 'nhan nhan-chu-y' }, h('span', { 'aria-hidden': 'true', text: '!' }), 'Chưa trình');
  }
  function nhanTuDuyet() {
    return h('span', { class: 'nhan nhan-chu-y' }, h('span', { 'aria-hidden': 'true', text: '↺' }), 'Tự xác nhận');
  }
  function nhanTreHan() {
    return h('span', { class: 'nhan nhan-chu-y' }, h('span', { 'aria-hidden': 'true', text: '!' }), 'Trễ hạn');
  }

  var timerBao = null;
  function thongBao(msg, loai) {
    live.textContent = '';
    // đặt lại trong nhịp sau để trình đọc màn hình đọc cả khi nội dung trùng lần trước
    setTimeout(function () { live.textContent = msg; }, 30);
    banner.textContent = msg;
    banner.dataset.loai = loai || '';
    banner.hidden = false;
    clearTimeout(timerBao);
    timerBao = setTimeout(function () { banner.hidden = true; }, loai === 'loi' ? 8000 : 4500);
  }

  function api(path, opt) {
    opt = opt || {};
    var headers = {};
    if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: opt.method || 'GET',
      headers: headers,
      body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
      credentials: 'same-origin',
      cache: 'no-store',
    }).catch(function () {
      // fetch chỉ từ chối khi KHÔNG tới được máy chủ (mất mạng, server tắt) — trình duyệt khi đó chỉ nói
      // "Failed to fetch", người dùng không hiểu. Phân biệt với lỗi HTTP (có phản hồi) xử lý bên dưới.
      throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi bấm Thử lại.');
    }).then(function (res) {
      if (res.status === 401) {
        location.href = '/dang-nhap.html?returnUrl=' + encodeURIComponent(location.pathname + location.hash);
        return new Promise(function () {}); // đang chuyển trang
      }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var e = new Error((data && data.message) || 'Lỗi ' + res.status);
          e.status = res.status;
          e.data = data;
          throw e;
        }
        return data;
      });
    });
  }

  // ── Hộp thoại (dùng <dialog> gốc: có sẵn bẫy focus + phím Esc) ─────────────
  /**
   * @param {{tieuDe:string, than:Node, nutChinh?:string, nutPhu?:string, nguy?:boolean,
   *          khiGui?:(form:HTMLFormElement)=>Promise<boolean|void>}} o
   *   khiGui trả false = giữ hộp thoại mở (vd. còn lỗi nhập); ném lỗi = hiện lỗi trong hộp.
   * @returns {Promise<boolean>} true nếu người dùng đồng ý và khiGui thành công
   */
  function moHop(o) {
    return new Promise(function (resolve) {
      hop.replaceChildren();
      var loiEl = h('p', { class: 'loi-truong', role: 'alert', hidden: true });
      var nutChinh = h('button', { type: 'submit', class: 'btn' + (o.nguy ? ' btn-nguy' : '') }, o.nutChinh || 'Đồng ý');
      var form = h('form', { novalidate: true },
        h('div', { class: 'hop-dau' }, h('h2', { id: 'hop-thoai-tieu-de', text: o.tieuDe })),
        h('div', { class: 'hop-than' }, o.than, loiEl),
        h('div', { class: 'hop-chan' },
          h('button', { type: 'button', class: 'btn btn-phu', onclick: function () { hop.close(); } }, o.nutPhu || 'Hủy'),
          nutChinh));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        nutChinh.disabled = true;
        loiEl.hidden = true;
        // new Promise bắt cả lỗi ném ĐỒNG BỘ trong khiGui; nếu không, nút chính kẹt ở trạng thái vô hiệu.
        new Promise(function (xong) { xong(o.khiGui ? o.khiGui(form) : true); })
          .then(function (kq) { if (kq !== false) hop.close('ok'); })
          .catch(function (err) { loiEl.textContent = err.message; loiEl.hidden = false; })
          .then(function () { nutChinh.disabled = false; });
      });
      function dong() {
        hop.removeEventListener('close', dong);
        resolve(hop.returnValue === 'ok');
      }
      hop.addEventListener('close', dong);
      hop.returnValue = '';
      hop.append(form);
      hop.showModal();
      var dau = form.querySelector('input:not([type=checkbox]), select, textarea');
      if (dau) dau.focus();
    });
  }

  function xacNhan(tieuDe, noiDung, nutChinh, nguy) {
    return moHop({ tieuDe: tieuDe, than: h('p', { text: noiDung }), nutChinh: nutChinh, nguy: !!nguy });
  }

  // ── Biểu mẫu nhập: dựng ô theo định nghĩa do người quản lý cấu hình ─────────

  function chuCaiNhom(i) {
    var n = i;
    var s = '';
    do {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
  }

  function laSoHuuHan(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * Số liệu cho ô tổng hợp. BẢN SAO của tinhTongHop() trong services/baoCaoPhongMau.js, để hiện số
   * liệu NGAY khi đang gõ mà không phải hỏi server. Hai nơi PHẢI khớp nhau — sửa một thì sửa cả hai.
   *   hoàn thành ≥100 · đang thực hiện >0 và <100 · chưa thực hiện = 0 hoặc để trống.
   * `du[khoaBang]` là mảng dòng; giá trị ô có thể là chuỗi (đang gõ) hoặc số (đã lưu) nên ép về số.
   */
  function tinhTongHopClient(truong, du, def) {
    var tong = 0;
    var xong = 0;
    var dang = 0;
    var chua = 0;
    (def.bang || []).forEach(function (bk) {
      var b = truong.filter(function (o) { return o.key === bk && o.kieu === 'bang'; })[0];
      if (!b) return;
      var cot = b.cot.filter(function (c) { return c.phan_tram; })[0];
      (Array.isArray(du[bk]) ? du[bk] : []).forEach(function (r) {
        if (!r || !r.o) return;
        // Dòng toàn ô trống (người dùng vừa bấm "Thêm dòng") chưa phải một công việc.
        var coGiaTri = Object.keys(r.o).some(function (k) { return String(r.o[k] == null ? '' : r.o[k]).trim() !== ''; });
        if (!coGiaTri) return;
        tong++;
        var raw = cot ? r.o[cot.key] : undefined;
        var p = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (laSoHuuHan(p) && p >= 100) xong++;
        else if (laSoHuuHan(p) && p > 0) dang++;
        else chua++;
      });
    });
    function ty(x) { return tong ? Math.round((x * 100) / tong) : 0; }
    return { tong: tong, hoan_thanh: xong, dang_thuc_hien: dang, chua_thuc_hien: chua, ty_le: { hoan_thanh: ty(xong), dang_thuc_hien: ty(dang), chua_thuc_hien: ty(chua) } };
  }

  function dongTongHop(t) {
    return [
      ['Tổng số công việc đã đăng ký/được giao', t.tong + ' việc'],
      ['Hoàn thành', t.hoan_thanh + ' việc (chiếm ' + t.ty_le.hoan_thanh + '%)'],
      ['Đang thực hiện (chưa hoàn thành)', t.dang_thuc_hien + ' việc (chiếm ' + t.ty_le.dang_thuc_hien + '%)'],
      ['Chưa thực hiện', t.chua_thuc_hien + ' việc (chiếm ' + t.ty_le.chua_thuc_hien + '%)'],
    ];
  }

  function dungHopTongHop(o, tinh) {
    var ul = h('ul', { class: 'tong-hop-ds' });
    var idNhan = 'o-' + o.key + '-nhan';
    var el = h('div', { class: 'tong-hop', role: 'group', 'aria-labelledby': idNhan },
      h('p', { class: 'tong-hop-nhan', id: idNhan, text: o.nhan }),
      o.tro_giup ? h('p', { class: 'tro-giup', text: o.tro_giup }) : null,
      ul);
    return {
      el: el,
      capNhat: function () {
        ul.replaceChildren.apply(ul, dongTongHop(tinh()).map(function (d) {
          return h('li', null, h('strong', { text: d[0] + ': ' }), d[1]);
        }));
      },
    };
  }

  /** Một ô nhập đơn (dùng cho ô thường và cho từng ô trong dòng của bảng). */
  function dungOnhap(def, id, giaTri, mota, batBuoc) {
    var chung = { id: id, 'aria-describedby': mota || null, 'aria-required': batBuoc ? 'true' : null };
    var input;
    if (def.kieu === 'textarea') input = h('textarea', Object.assign({ rows: 3 }, chung));
    else if (def.kieu === 'number') input = h('input', Object.assign({ type: 'number', step: 'any', inputmode: 'decimal', min: def.min, max: def.max }, chung));
    else if (def.kieu === 'date') input = h('input', Object.assign({ type: 'date' }, chung));
    else if (def.kieu === 'select') {
      input = h('select', chung, h('option', { value: '', text: '— Chọn —' }),
        (def.lua_chon || []).map(function (x) { return h('option', { value: x, text: x }); }));
    } else input = h('input', Object.assign({ type: 'text', maxlength: 500, autocomplete: 'off' }, chung));
    input.value = giaTri === undefined || giaTri === null ? '' : String(giaTri);
    return input;
  }

  /** Bảng nhiều dòng để NHẬP. Mỗi dòng là một "thẻ" có nhãn riêng cho từng ô: đọc được trên điện thoại, và trình đọc màn hình nghe được tên cột cho từng ô. */
  function dungBangNhap(o, duLieuBan, canTheoDoi) {
    var id = 'o-' + o.key;
    var gyId = id + '-gy';
    var loiId = id + '-loi';
    var rows = (Array.isArray(duLieuBan) ? duLieuBan : []).map(function (r) {
      return r && r.nhom !== undefined ? { nhom: String(r.nhom) } : { o: Object.assign({}, (r && r.o) || {}) };
    });
    var ds = h('div', { class: 'bang-ds' });
    var tenNhom = o.nhan_nhom || 'Nhóm';
    var nutThem = h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'aria-describedby': loiId }, '+ Thêm dòng');
    var nutThemNhom = o.cho_phep_nhom ? h('button', { type: 'button', class: 'btn btn-phu btn-nho' }, '+ Thêm ' + tenNhom.toLowerCase()) : null;

    function doi(i, huong) {
      var j = i + huong;
      var t = rows[i]; rows[i] = rows[j]; rows[j] = t;
      canTheoDoi();
      veLai('[data-b="' + id + '"][data-ro="' + j + '"][data-ract="' + (huong < 0 ? 'len' : 'xuong') + '"], [data-b="' + id + '"][data-ro="' + j + '"][data-ract="' + (huong < 0 ? 'xuong' : 'len') + '"]');
    }

    function dungDong(r, i) {
      var pref = id + '-r' + i;
      var stt = 0;
      var nhom = -1;
      for (var j = 0; j <= i; j++) { if (rows[j].nhom !== undefined) nhom++; else stt++; }
      var laNhom = r.nhom !== undefined;
      var ten = laNhom ? tenNhom.toLowerCase() + ' ' + chuCaiNhom(nhom) : 'dòng ' + stt;
      var than;
      if (laNhom) {
        var inN = h('input', { type: 'text', id: pref + '-nhom', maxlength: 200, value: r.nhom, autocomplete: 'off' });
        inN.addEventListener('input', function () { r.nhom = inN.value; });
        than = h('div', { class: 'truong' }, h('label', { for: pref + '-nhom', text: 'Tên ' + tenNhom.toLowerCase() }), inN);
      } else {
        than = h('div', { class: 'luoi-2' }, o.cot.map(function (c) {
          var cid = pref + '-' + c.key;
          var inp = dungOnhap(c, cid, r.o[c.key], null, false);
          inp.addEventListener('input', function () { if (inp.value === '') delete r.o[c.key]; else r.o[c.key] = inp.value; });
          inp.addEventListener('change', function () { if (inp.value === '') delete r.o[c.key]; else r.o[c.key] = inp.value; });
          var rong = c.kieu === 'textarea' ? 'rong' : '';
          return h('div', { class: rong }, h('label', { for: cid, text: c.nhan }), inp);
        }));
      }
      return h('fieldset', { class: 'dong-bang' + (laNhom ? ' dong-nhom' : '') },
        h('legend', { text: laNhom ? chuCaiNhom(nhom) + '. ' + tenNhom : 'Dòng ' + stt }),
        than,
        h('div', { class: 'nhom-nut' },
          h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'data-b': id, 'data-ro': i, 'data-ract': 'len', disabled: i === 0, 'aria-label': 'Chuyển ' + ten + ' lên', onclick: function () { doi(i, -1); } }, '↑ Lên'),
          h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'data-b': id, 'data-ro': i, 'data-ract': 'xuong', disabled: i === rows.length - 1, 'aria-label': 'Chuyển ' + ten + ' xuống', onclick: function () { doi(i, 1); } }, '↓ Xuống'),
          h('button', {
            type: 'button', class: 'btn btn-nguy btn-nho', 'aria-label': 'Xóa ' + ten,
            onclick: function () {
              rows.splice(i, 1);
              canTheoDoi();
              var k = Math.min(i, rows.length - 1);
              veLai(rows.length ? '[data-b="' + id + '"][data-ro="' + k + '"][data-ract="len"], [data-b="' + id + '"][data-ro="' + k + '"][data-ract="xuong"]' : '#' + nutThem.id);
            },
          }, 'Xóa')));
    }

    function veLai(chonFocus) {
      ds.replaceChildren.apply(ds, rows.map(dungDong));
      ds.dispatchEvent(new Event('bang-doi', { bubbles: true })); // ô tổng hợp tính lại
      if (!chonFocus) return;
      var ds2 = chonFocus.split(', ');
      for (var k = 0; k < ds2.length; k++) {
        var f = document.querySelector(ds2[k]);
        if (f && !f.disabled) { f.focus(); return; }
      }
    }

    nutThem.id = id + '-them';
    nutThem.addEventListener('click', function () {
      rows.push({ o: {} });
      canTheoDoi();
      veLai(null);
      var f = ds.querySelector('.dong-bang:last-child input, .dong-bang:last-child textarea, .dong-bang:last-child select');
      if (f) f.focus();
    });
    if (nutThemNhom) {
      nutThemNhom.addEventListener('click', function () {
        rows.push({ nhom: '' });
        canTheoDoi();
        veLai(null);
        var f = ds.querySelector('.dong-bang:last-child input');
        if (f) f.focus();
      });
    }
    veLai(null);

    return {
      el: h('div', { class: 'truong truong-bang' },
        h('p', { class: 'nhan-truong', id: id + '-nhan' }, o.nhan,
          o.bat_buoc ? h('span', { class: 'bat-buoc', 'aria-hidden': 'true', text: ' *' }) : null,
          o.bat_buoc ? h('span', { class: 'sr-only', text: ' (bắt buộc)' }) : null),
        o.tro_giup ? h('p', { class: 'tro-giup', id: gyId, text: o.tro_giup }) : null,
        ds,
        h('div', { class: 'nhom-nut' }, nutThem, nutThemNhom),
        h('p', { class: 'loi-truong', id: loiId, role: 'alert', hidden: true })),
      rows: rows,
      nutThem: nutThem,
    };
  }

  function dungForm(truong, duLieu) {
    var wrap = h('div');
    var ctl = {};
    var bangMap = {};
    var tongHops = [];
    duLieu = duLieu || {};
    var daTheoDoi = false;
    function canTheoDoi() { if (daTheoDoi) dirty = true; }

    function duLieuBang() {
      var out = {};
      Object.keys(bangMap).forEach(function (k) { out[k] = bangMap[k].rows; });
      return out;
    }
    function capNhatTongHop() { tongHops.forEach(function (t) { t.capNhat(); }); }

    truong.forEach(function (o) {
      if (o.kieu === 'section') {
        wrap.append(h('h3', { class: 'phan-nhom', text: o.nhan }));
        if (o.tro_giup) wrap.append(h('p', { class: 'tro-giup', text: o.tro_giup }));
        return;
      }
      if (o.kieu === 'tong_hop') {
        var th = dungHopTongHop(o, function () { return tinhTongHopClient(truong, duLieuBang(), o); });
        tongHops.push(th);
        wrap.append(th.el);
        return;
      }
      if (o.kieu === 'bang') {
        var b = dungBangNhap(o, duLieu[o.key], canTheoDoi);
        bangMap[o.key] = b;
        wrap.append(b.el);
        return;
      }
      var id = 'o-' + o.key;
      var gyId = id + '-gy';
      var loiId = id + '-loi';
      var v = duLieu[o.key];
      var mota = (o.tro_giup ? gyId + ' ' : '') + loiId;
      var input;
      if (o.kieu === 'checkbox') {
        input = h('input', { type: 'checkbox', id: id, 'aria-describedby': mota, 'aria-required': o.bat_buoc ? 'true' : null });
        input.checked = v === true;
        ctl[o.key] = input;
        wrap.append(h('div', { class: 'truong' },
          h('label', { class: 'dong-tick', for: id }, input,
            h('span', null, o.nhan, o.bat_buoc ? h('span', { class: 'bat-buoc', 'aria-hidden': 'true', text: ' *' }) : null,
              o.bat_buoc ? h('span', { class: 'sr-only', text: ' (bắt buộc)' }) : null)),
          o.tro_giup ? h('p', { class: 'tro-giup', id: gyId, text: o.tro_giup }) : null,
          h('p', { class: 'loi-truong', id: loiId, role: 'alert', hidden: true })));
        return;
      }
      input = dungOnhap(o, id, v, mota, o.bat_buoc);
      if (o.kieu === 'textarea') input.rows = 5;
      ctl[o.key] = input;
      wrap.append(h('div', { class: 'truong' },
        h('label', { for: id }, o.nhan, o.bat_buoc ? h('span', { class: 'bat-buoc', 'aria-hidden': 'true', text: ' *' }) : null,
          o.bat_buoc ? h('span', { class: 'sr-only', text: ' (bắt buộc)' }) : null),
        o.tro_giup ? h('p', { class: 'tro-giup', id: gyId, text: o.tro_giup }) : null,
        input,
        h('p', { class: 'loi-truong', id: loiId, role: 'alert', hidden: true })));
    });

    // Gõ vào bất kỳ ô nào (kể cả trong bảng) hoặc thêm/xóa/đổi chỗ dòng → số liệu tổng hợp tính lại ngay.
    wrap.addEventListener('input', capNhatTongHop);
    wrap.addEventListener('change', capNhatTongHop);
    wrap.addEventListener('bang-doi', capNhatTongHop);
    capNhatTongHop();

    function coDuLieuDong(r) {
      return !!r.o && Object.keys(r.o).some(function (k) { return String(r.o[k]).trim() !== ''; });
    }

    return {
      el: wrap,
      thu: function () {
        var out = {};
        truong.forEach(function (o) {
          if (o.kieu === 'section' || o.kieu === 'tong_hop') return;
          if (o.kieu === 'bang') {
            // Sao chép sâu để người gọi không giữ tham chiếu vào trạng thái đang sửa.
            out[o.key] = JSON.parse(JSON.stringify(bangMap[o.key].rows));
            return;
          }
          var el = ctl[o.key];
          out[o.key] = o.kieu === 'checkbox' ? el.checked : el.value;
        });
        return out;
      },
      /** Soi trước các ô bắt buộc còn trống để báo lỗi NGAY, khỏi hỏi xác nhận rồi mới bị từ chối.
       *  Chỉ là tiện lợi: server mới là nơi quyết định, vẫn kiểm lại khi nhận. */
      kiemTraThieu: function () {
        var loi = {};
        truong.forEach(function (o) {
          if (o.kieu === 'section' || o.kieu === 'tong_hop' || !o.bat_buoc) return;
          if (o.kieu === 'bang') {
            if (!bangMap[o.key].rows.some(coDuLieuDong)) loi[o.key] = 'Cần nhập ít nhất một dòng.';
            return;
          }
          var el = ctl[o.key];
          if (o.kieu === 'checkbox' ? !el.checked : !el.value.trim()) loi[o.key] = o.kieu === 'checkbox' ? 'Cần đánh dấu ô này.' : 'Ô này là bắt buộc.';
        });
        return loi;
      },
      hienLoi: function (loi) {
        var dau = null;
        truong.forEach(function (o) {
          if (o.kieu === 'section' || o.kieu === 'tong_hop') return;
          var el = o.kieu === 'bang' ? bangMap[o.key].nutThem : ctl[o.key];
          var p = document.getElementById('o-' + o.key + '-loi');
          var co = loi && loi[o.key];
          if (!p) return;
          p.textContent = co || '';
          p.hidden = !co;
          if (co) {
            if (o.kieu !== 'bang') el.setAttribute('aria-invalid', 'true');
            if (!dau) dau = el;
          } else if (o.kieu !== 'bang') el.removeAttribute('aria-invalid');
        });
        if (dau) dau.focus();
        return !!dau;
      },
      theoDoiThayDoi: function () {
        daTheoDoi = true;
        wrap.addEventListener('input', function () { dirty = true; });
        wrap.addEventListener('change', function () { dirty = true; });
      },
    };
  }

  /** Bảng chỉ ĐỌC (xem báo cáo đã nộp / đang chờ duyệt). */
  function dungBangXem(o, hangDL) {
    var tenNhom = o.nhan_nhom || 'Nhóm';
    var stt = 0;
    var nhom = -1;
    var thead = h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'STT' }), o.cot.map(function (c) { return h('th', { scope: 'col', text: c.nhan }); })));
    var tbody = h('tbody', null, hangDL.map(function (r) {
      if (r.nhom !== undefined) {
        nhom++;
        return h('tr', { class: 'dong-nhom-xem' }, h('th', { scope: 'rowgroup', colspan: o.cot.length + 1, text: chuCaiNhom(nhom) + '. ' + tenNhom + ': ' + r.nhom }));
      }
      stt++;
      return h('tr', null, h('td', { class: 'con-so', 'data-nhan': 'STT', text: String(stt) }), o.cot.map(function (c) {
        var v = r.o[c.key];
        // data-nhan: tên cột, để màn hình hẹp (điện thoại) xếp mỗi dòng thành một thẻ "tên cột: giá trị" thay vì bắt cuộn ngang.
        return h('td', { class: c.kieu === 'number' || c.kieu === 'date' ? 'con-so' : '', 'data-nhan': c.nhan, text: v === undefined ? '' : c.kieu === 'date' ? fmtNgay(v) : String(v) });
      }));
    }));
    return h('div', { class: 'cuon-ngang' }, h('table', { class: 'bang-xem' }, h('caption', { class: 'sr-only', text: o.nhan }), thead, tbody));
  }

  function dungXemLai(truong, duLieu) {
    var dl = h('dl', { class: 'xem-lai' });
    truong.forEach(function (o) {
      if (o.kieu === 'section') {
        dl.append(h('h3', { class: 'phan-nhom', text: o.nhan }));
        return;
      }
      if (o.kieu === 'tong_hop') {
        dl.append(h('dt', { text: o.nhan }), h('dd', { class: 'dd-bang' },
          h('ul', { class: 'tong-hop-ds' }, dongTongHop(tinhTongHopClient(truong, duLieu, o)).map(function (d) {
            return h('li', null, h('strong', { text: d[0] + ': ' }), d[1]);
          }))));
        return;
      }
      if (o.kieu === 'bang') {
        var hang = Array.isArray(duLieu[o.key]) ? duLieu[o.key] : [];
        dl.append(h('dt', { text: o.nhan }), hang.length
          ? h('dd', { class: 'dd-bang' }, dungBangXem(o, hang))
          : h('dd', { class: 'chua-dien', text: 'Không có nội dung' }));
        return;
      }
      var v = duLieu[o.key];
      var chua = v === undefined || v === null || v === '';
      var text;
      if (o.kieu === 'checkbox') { chua = false; text = v === true ? 'Có' : 'Không'; }
      else if (o.kieu === 'date') text = fmtNgay(v);
      else text = chua ? 'Chưa điền' : String(v);
      dl.append(h('dt', { text: o.nhan }), h('dd', { class: chua ? 'chua-dien' : '', text: text }));
    });
    return dl;
  }

  // ── Khung chung ───────────────────────────────────────────────────────────
  var tq = null; // tổng quan "cần xử lý" (chỉ người quản lý / Viện trưởng)
  var mucNav = '';

  /** Số việc của người quản lý module: báo cáo đã nộp đang chờ XÁC NHẬN. */
  function soViecCanLam() {
    if (!tq) return 0;
    return me.quan_ly_module ? tq.cho_duyet : 0;
  }
  /** Số việc của Viện trưởng: báo cáo chờ ông quyết định (trong các đợt đã trình). */
  function soViecVienTruong() {
    if (!tq || !me.vien_truong) return 0;
    return tq.bao_cao_cho_vien_truong || 0;
  }

  /** Tên mục danh sách đợt: người quản lý dùng nó để giao và theo dõi đợt; Viện trưởng dùng nó để xem lại (lưu trữ) các đợt đã trình và báo cáo từng phòng. */
  function tenMucDot() { return me.quan_ly_module ? 'Các đợt báo cáo' : 'Lịch sử các đợt báo cáo'; }

  function dungNav(muc) {
    mucNav = muc;
    var ds = [];
    if (me.vien_truong) ds.push(['duyet', 'Duyệt báo cáo']);
    if (me.quan_ly) ds.push(['dot', tenMucDot()]);
    // Biểu mẫu và Phòng & phân quyền: chỉ người quản lý module (Viện trưởng không quản lý, chỉ xem tiến độ và duyệt hồ sơ).
    if (me.quan_ly_module) ds.push(['mau', 'Biểu mẫu'], ['phong', 'Phòng & phân quyền']);
    if (me.phong.length) ds[viec.length ? 'unshift' : 'push'](['cua-toi', 'Báo cáo của tôi']);
    nav.replaceChildren.apply(nav, ds.map(function (m) {
      var n = m[0] === 'dot' ? soViecCanLam() : m[0] === 'duyet' ? soViecVienTruong() : m[0] === 'cua-toi' ? viec.length : 0;
      return h('a', { href: '#/' + m[0], 'aria-current': m[0] === muc ? 'page' : null },
        m[1],
        n > 0 ? [h('span', { class: 'nav-so', 'aria-hidden': 'true', text: String(n) }), h('span', { class: 'sr-only', text: ', ' + n + ' việc cần xử lý' })] : null);
    }));
  }

  /** Nạp lại tổng quan (số việc) rồi vẽ lại các thẻ việc. */
  function lamMoiTongQuan() {
    if (!me || !me.quan_ly) return Promise.resolve();
    return api('/tong-quan').then(function (r) { tq = r; dungNav(mucNav); veDaiViec(); }).catch(function () { /* giữ số liệu cũ */ });
  }

  /** Dải nổi bật trên các màn quản lý: "Phòng bạn cần nộp báo cáo" + nút to. (Việc duyệt của Viện trưởng nằm ở mục "Duyệt báo cáo", không lặp lại ở đây.) */
  function veDaiViec() {
    var cacThe = [];
    if (!hienDai || !viec.length) { daiViec.replaceChildren.apply(daiViec, cacThe); return; }
    var b = viec[0];
    var nhieu = viec.length > 1;
    var canSua = b.trang_thai === 'can_chinh_sua';
    var tieu = nhieu ? 'Bạn có ' + viec.length + ' báo cáo cần nộp' : (canSua ? 'Báo cáo của ' + b.phong_ten + ' cần chỉnh sửa' : b.phong_ten + ' cần nộp báo cáo');
    var phu = b.tieu_de + ' · hạn ' + fmtNgay(b.han_nop) + ' (' + conLaiNgay(b.han_nop) + ')';
    cacThe.push(h('section', { class: 'viec-lon' + (b.tre_han ? ' tre' : ''), 'aria-label': 'Việc của bạn' },
      h('div', { class: 'viec-chu' }, h('p', { class: 'viec-tieu', text: tieu }), h('p', { class: 'viec-phu', text: phu })),
      h('a', { class: 'btn btn-lon', href: nhieu ? '#/cua-toi' : '#/bao-cao/' + b.id }, nhieu ? 'Xem các báo cáo cần nộp →' : (canSua ? 'Chỉnh sửa báo cáo →' : 'Làm báo cáo ngay →'))));
    daiViec.replaceChildren.apply(daiViec, cacThe);
  }

  /** Nạp báo cáo của phòng mình đang cần làm (chạy nền: lỗi ở đây không được làm hỏng trang). */
  function capNhatViec() {
    if (!me || !me.phong.length) { viec = []; veDaiViec(); return Promise.resolve(); }
    return api('/cua-toi').then(function (r) {
      viec = r.bao_cao.filter(function (x) { return x.sua_duoc; }).sort(function (a, c) { return a.han_nop < c.han_nop ? -1 : a.han_nop > c.han_nop ? 1 : 0; });
      dungNav(mucNav);
      veDaiViec();
    }).catch(function () { /* không có dải việc thì vẫn dùng được module */ });
  }

  /** Nạp lại số liệu tổng quan rồi vẽ lại thanh điều hướng. Chạy nền: lỗi ở đây không được làm hỏng trang. */
  function capNhatTongQuan() {
    if (!me || !me.quan_ly) return Promise.resolve();
    return api('/tong-quan').then(function (r) { tq = r; dungNav(mucNav); veDaiViec(); }).catch(function () { /* thanh điều hướng vẫn dùng được không cần số đếm */ });
  }

  function hienLoiTrang(err) {
    main.replaceChildren(
      h('h2', { text: 'Không tải được' }),
      h('div', { class: 'luu-y luu-y-do', role: 'alert' }, h('p', { text: err.message || 'Có lỗi xảy ra.' })),
      h('button', { type: 'button', class: 'btn btn-phu', onclick: route }, 'Thử lại'));
  }

  function tieuDe(ten, mota, nut) {
    return h('div', { class: 'thanh-tieu-de' },
      h('div', null, h('h2', { text: ten }), mota ? h('p', { class: 'phu', text: mota }) : null),
      nut || null);
  }

  function bangTrong(msg) {
    return h('div', { class: 'trong' }, msg);
  }

  // ══ TRƯỞNG PHÒNG: danh sách báo cáo của tôi ═══════════════════════════════
  function viewCuaToi() {
    return api('/cua-toi').then(function (kq) {
      var ds = kq.bao_cao;
      var canLam = ds.filter(function (b) { return b.sua_duoc; });
      var con = ds.filter(function (b) { return !b.sua_duoc; });
      function bang(rows) {
        return h('div', { class: 'cuon-ngang' }, h('table', null,
          h('thead', null, h('tr', null, ['Đợt báo cáo', 'Phòng', 'Hạn nộp', 'Trạng thái', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, rows.map(function (b) {
            return h('tr', { class: b.tre_han && b.sua_duoc ? 'dong-chu-y' : '' },
              h('td', null, h('a', { href: '#/bao-cao/' + b.id, text: b.tieu_de }), b.ky ? h('div', { class: 'mo', text: LOAI_DOT[b.loai] + ' · ' + b.ky }) : null),
              h('td', { text: b.phong_ten }),
              h('td', { class: 'con-so' }, fmtNgay(b.han_nop), b.tre_han ? [' ', nhanTreHan()] : null),
              h('td', null, nhan(TT_BAO_CAO, b.trang_thai), b.dot_trang_thai === 'dong' ? [' ', nhan(TT_DOT, 'dong')] : null, nhanQuyetDinh(b) ? [' ', nhanQuyetDinh(b)] : null),
              h('td', null, h('a', { class: 'btn btn-nho ' + (b.sua_duoc ? '' : 'btn-phu'), href: '#/bao-cao/' + b.id },
                b.sua_duoc ? (b.trang_thai === 'can_chinh_sua' ? 'Chỉnh sửa' : 'Nhập báo cáo') : 'Xem')));
          }))));
      }
      // Việc phải làm hiện thành THẺ LỚN với một nút duy nhất ("Làm báo cáo ngay"): người nộp không cần hiểu bảng hay tìm nút.
      function theViec(b) {
        var canSua = b.trang_thai === 'can_chinh_sua';
        return h('section', { class: 'viec-lon' + (b.tre_han ? ' tre' : ''), 'aria-label': b.tieu_de },
          h('div', { class: 'viec-chu' },
            h('p', { class: 'viec-tieu', text: (canSua ? 'Cần chỉnh sửa: ' : 'Cần nộp: ') + b.tieu_de }),
            h('p', { class: 'viec-phu', text: b.phong_ten + ' · hạn ' + fmtNgay(b.han_nop) + ' (' + conLaiNgay(b.han_nop) + ')' }),
            canSua && b.nhan_xet ? h('p', { class: 'viec-nx' }, h('strong', { text: (b.nhan_xet_boi === 'vien_truong' ? 'Viện trưởng nhắn: ' : 'Người quản lý nhắn: ') }), b.nhan_xet) : null),
          h('a', { class: 'btn btn-lon', href: '#/bao-cao/' + b.id }, canSua ? 'Chỉnh sửa báo cáo →' : 'Làm báo cáo ngay →'));
      }
      var node = [tieuDe('Báo cáo của tôi', 'Các đợt báo cáo được giao cho phòng của bạn.')];
      if (!ds.length) node.push(bangTrong('Chưa có đợt báo cáo nào được giao cho phòng của bạn.'));
      if (canLam.length) { node.push(h('h3', { text: 'Việc của bạn (' + canLam.length + ')' })); canLam.forEach(function (b) { node.push(theViec(b)); }); }
      else if (ds.length) node.push(h('div', { class: 'luu-y', role: 'status' }, h('p', null, h('strong', { text: '✓ Phòng bạn đã nộp xong. ' }), 'Hiện không có báo cáo nào cần bạn làm.')));
      if (con.length) node.push(h('h3', { text: 'Đã nộp và các đợt khác' }), bang(con));
      main.replaceChildren.apply(main, node);
    });
  }

  // ══ BÁO CÁO: nhập (trưởng phòng) / xem + duyệt (quản lý) ═══════════════════
  function viewBaoCao(id) {
    return api('/bao-cao/' + id).then(function (d) {
      var laChuPhong = me.phong.some(function (p) { return p.id === d.phong_id; });
      dungNav(laChuPhong && !me.quan_ly ? 'cua-toi' : me.quan_ly && !d.sua_duoc ? 'dot' : 'cua-toi');

      var quayLai = h('a', { class: 'btn btn-phu btn-nho', href: laChuPhong && !me.quan_ly ? '#/cua-toi' : '#/dot/' + d.dot.id }, '← Quay lại');
      var form = dungForm(d.truong, d.du_lieu);
      var node = [
        h('div', { class: 'nhom-nut' }, quayLai),
        tieuDe(d.dot.tieu_de, d.phong_ten + (d.nguoi_phu_trach ? ' · ' + d.nguoi_phu_trach + (d.chuc_danh && CHUC_DANH[d.chuc_danh] ? ' (' + CHUC_DANH[d.chuc_danh] + ')' : '') : '') + (d.dot.ky ? ' · ' + LOAI_DOT[d.dot.loai] + ' ' + d.dot.ky : '') + ' · Hạn nộp ' + fmtNgay(d.dot.han_nop)),
        h('p', null, nhan(TT_BAO_CAO, d.trang_thai), ' ', d.tre_han ? nhanTreHan() : null, ' ', d.dot.trang_thai === 'dong' ? nhan(TT_DOT, 'dong') : null, nhanQuyetDinh(d) ? [' ', nhanQuyetDinh(d)] : null),
      ];
      // Viện trưởng đọc báo cáo này trong màn hình duyệt (đã trình): một lối đi thẳng tới đó thay vì tự tìm.
      if (me.vien_truong && d.da_trinh) node.push(h('div', { class: 'nhom-nut' }, h('a', { class: 'btn btn-nho', href: '#/duyet/' + d.dot.id + '/' + d.id }, 'Mở trong màn hình duyệt →')));
      if (d.dot.mo_ta) node.push(h('p', { class: 'phu', text: d.dot.mo_ta }));
      if (d.nhan_xet && d.trang_thai === 'can_chinh_sua') {
        node.push(h('div', { class: 'luu-y luu-y-do', role: 'status' },
          h('p', null, h('strong', { text: d.nhan_xet_boi === 'vien_truong' ? 'Viện trưởng đề nghị chỉnh sửa:' : 'Người quản lý yêu cầu chỉnh sửa:' })), h('p', { text: d.nhan_xet })));
      } else if (d.nhan_xet && d.trang_thai === 'da_duyet') {
        node.push(h('div', { class: 'luu-y' }, h('p', null, h('strong', { text: 'Nhận xét khi xác nhận:' })), h('p', { text: d.nhan_xet })));
      }
      // Quyết định của Viện trưởng về báo cáo này (phòng, người quản lý và Viện trưởng đều thấy). "Đề nghị chỉnh sửa" đã hiện ở khung trên.
      if (d.vien_truong && d.vien_truong.quyet_dinh !== 'de_nghi_chinh_sua') {
        var vt = d.vien_truong;
        var duyetRoi = vt.quyet_dinh === 'duyet';
        node.push(h('div', { class: 'luu-y' + (duyetRoi ? '' : ' luu-y-do'), role: 'status' },
          h('p', null, h('strong', { text: duyetRoi ? 'Viện trưởng đã duyệt báo cáo này' : 'Viện trưởng không duyệt báo cáo này' }), ' — ' + (vt.nguoi || 'Viện trưởng') + ' · ' + fmtGio(vt.luc)),
          vt.ghi_chu ? h('p', { text: (duyetRoi ? 'Ghi chú: ' : 'Lý do: ') + vt.ghi_chu }) : null,
          duyetRoi ? null : h('p', { class: 'mo', text: 'Báo cáo vẫn giữ nguyên trạng thái đã nộp. Trao đổi với người quản lý module nếu cần giải trình.' })));
      }
      if (d.tu_duyet) {
        node.push(h('div', { class: 'luu-y luu-y-do', role: 'status' },
          h('p', null, h('strong', { text: 'Tự xác nhận: ' }), 'báo cáo do ' + (d.nguoi_nop || 'người nộp') + ' nộp và cũng do chính người này xác nhận' + (d.duyet_luc ? ' lúc ' + fmtGio(d.duyet_luc) : '') + '.')));
      }

      // Ý kiến của Viện trưởng: hiện ngay đầu báo cáo để trưởng phòng đọc trước khi chỉnh sửa.
      if (d.y_kien.length) {
        node.push(h('section', { class: 'luu-y', 'aria-label': 'Ý kiến của Viện trưởng' },
          h('p', null, h('strong', { text: 'Ý kiến của Viện trưởng' })),
          d.y_kien.map(function (k) {
            return h('div', { class: 'y-kien' }, h('p', { class: 'y-kien-nd', text: k.noi_dung }), h('p', { class: 'mo', text: (k.nguoi || 'Viện trưởng') + ' · ' + fmtGio(k.tao_luc) }));
          })));
      }

      if (d.sua_duoc) {
        form.theoDoiThayDoi();
        var luu = h('button', { type: 'button', class: 'btn btn-phu' }, 'Lưu nháp');
        var nop = h('button', { type: 'button', class: 'btn' }, 'Nộp báo cáo');
        luu.addEventListener('click', function () {
          luu.disabled = true;
          api('/bao-cao/' + id + '/du-lieu', { method: 'PUT', body: { du_lieu: form.thu() } })
            .then(function () {
              form.hienLoi({});
              dirty = false;
              thongBao('Đã lưu nháp lúc ' + new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) + '.');
            })
            .catch(function (e) { baoLoiForm(e, form, 'Chưa lưu được.'); })
            .then(function () { luu.disabled = false; });
        });
        nop.addEventListener('click', function () {
          // Còn thiếu ô bắt buộc thì báo ngay trên form, KHÔNG hỏi xác nhận (xác nhận chỉ có nghĩa khi đã đủ).
          var thieu = form.kiemTraThieu();
          if (Object.keys(thieu).length) {
            form.hienLoi(thieu);
            thongBao('Chưa điền đủ ' + Object.keys(thieu).length + ' ô bắt buộc.', 'loi');
            return;
          }
          xacNhan('Nộp báo cáo?', 'Sau khi nộp, bạn không sửa được cho tới khi người quản lý yêu cầu chỉnh sửa.', 'Nộp báo cáo').then(function (dongY) {
            if (!dongY) return;
            nop.disabled = true;
            api('/bao-cao/' + id + '/nop', { method: 'POST', body: { du_lieu: form.thu() } })
              .then(function () { dirty = false; thongBao('Đã nộp báo cáo.'); return route(); })
              .catch(function (e) { baoLoiForm(e, form, 'Chưa nộp được.'); nop.disabled = false; });
          });
        });
        node.push(h('p', { class: 'mo', text: 'Ô có dấu * là bắt buộc khi nộp. Bạn có thể lưu nháp và quay lại sau.' }), form.el, h('div', { class: 'nhom-nut' }, luu, nop));
      } else {
        node.push(dungXemLai(d.truong, d.du_lieu));
        if (d.nop_luc) node.push(h('p', { class: 'mo', text: 'Nộp lúc ' + fmtGio(d.nop_luc) }));
      }

      if (d.duyet_duoc || d.yeu_cau_sua_duoc) node.push(khoiXuLy(id, d));

      if (d.lich_su.length) {
        node.push(h('h3', { text: 'Lịch sử' }), h('ul', { class: 'lich-su' }, d.lich_su.map(function (l) {
          return h('li', null, h('strong', { text: HANH_DONG[l.hanh_dong] || l.hanh_dong }), ' — ', l.nguoi || 'Không rõ', ' · ', fmtGio(l.tao_luc),
            l.ghi_chu ? h('span', { class: 'ghi-chu', text: l.ghi_chu }) : null);
        })));
      }
      main.replaceChildren.apply(main, node);
    });
  }

  function baoLoiForm(e, form, tienTo) {
    if (e.status === 422 && e.data && e.data.loi) {
      form.hienLoi(e.data.loi);
      thongBao(tienTo + ' ' + (e.data.message || 'Có ô chưa hợp lệ.'), 'loi');
    } else thongBao(e.message, 'loi');
  }

  function khoiXuLy(id, d) {
    var nx = h('textarea', { id: 'nhan-xet', rows: 3, maxlength: 2000 });
    var loi = h('p', { class: 'loi-truong', role: 'alert', hidden: true });
    function gui(duongDan, body, thanhCong) {
      loi.hidden = true;
      api('/bao-cao/' + id + duongDan, { method: 'POST', body: body })
        .then(function () { thongBao(thanhCong); return route(); })
        .catch(function (e) { loi.textContent = e.message; loi.hidden = false; });
    }
    var nut = [];
    if (d.duyet_duoc) {
      nut.push(h('button', { type: 'button', class: 'btn', onclick: function () { gui('/duyet', { nhan_xet: nx.value }, d.nop_boi_toi ? 'Đã tự xác nhận báo cáo.' : 'Đã xác nhận báo cáo.'); } }, d.nop_boi_toi ? 'Tự xác nhận báo cáo' : 'Xác nhận báo cáo'));
    }
    if (d.yeu_cau_sua_duoc) {
      nut.push(h('button', {
        type: 'button', class: 'btn btn-nguy',
        onclick: function () {
          if (!nx.value.trim()) { loi.textContent = 'Hãy ghi rõ nội dung cần chỉnh sửa vào ô Nhận xét.'; loi.hidden = false; nx.focus(); return; }
          gui('/yeu-cau-chinh-sua', { nhan_xet: nx.value }, 'Đã gửi yêu cầu chỉnh sửa.');
        },
      }, 'Yêu cầu chỉnh sửa'));
    }
    return h('section', { 'aria-labelledby': 'xu-ly-tieu-de' },
      h('h3', { id: 'xu-ly-tieu-de', text: 'Xử lý báo cáo' }),
      h('div', { class: 'truong' },
        h('label', { for: 'nhan-xet', text: 'Nhận xét' }),
        h('p', { class: 'tro-giup', text: 'Bắt buộc khi yêu cầu chỉnh sửa; tùy chọn khi xác nhận.' }),
        nx, loi),
      h('div', { class: 'nhom-nut' }, nut));
  }

  // ══ QUẢN LÝ: đợt báo cáo ═══════════════════════════════════════════════════

  /**
   * Dải "Cần xử lý" ở đầu danh sách đợt. Đây là chỗ trả lời ngay khi mở module: bao nhiêu phòng đã nộp /
   * cần nộp, ở đợt nào, bao nhiêu báo cáo đang chờ duyệt, hồ sơ nào đang chờ Viện trưởng. Email báo nộp
   * (services/baoCaoPhongThongBao.js) dùng cùng cách tính tiến độ.
   */
  function dungDaiCanXuLy(t) {
    // Viện trưởng (không kiêm quản lý module): việc của ông đã có thẻ "Đợt chờ bạn duyệt" và tiến độ đã nằm ngay trong bảng đợt bên dưới,
    // nên không dựng thêm dải này (sẽ chỉ lặp lại đúng thông tin của bảng).
    if (me.vien_truong && !me.quan_ly_module) return null;
    if (!t.dot_dang_mo && !t.bao_cao_cho_vien_truong) return null;
    var khan = t.tre_han > 0 || (t.la_vien_truong && t.bao_cao_cho_vien_truong > 0);
    var tom = [];
    // Có đợt "mỗi người một báo cáo" thì số liệu tổng hợp đếm theo báo cáo, không theo phòng.
    var dv = t.chi_tiet.some(function (x) { return x.cach_nop === 'tat_ca'; }) ? 'báo cáo' : 'phòng';
    if (t.cho_duyet) tom.push(t.cho_duyet + ' báo cáo chờ xác nhận');
    if (t.chua_nop) tom.push(t.chua_nop + ' ' + dv + ' chưa nộp');
    // Trễ hạn gồm cả phòng ĐÃ nộp nhưng nộp muộn, nên có thể lớn hơn số phòng chưa nộp: tách riêng cho khỏi tưởng sai.
    if (t.tre_han) tom.push(t.tre_han + ' ' + dv + ' trễ hạn (kể cả nộp muộn)');
    if (t.bao_cao_cho_vien_truong) tom.push(t.bao_cao_cho_vien_truong + ' báo cáo chờ Viện trưởng duyệt');
    var node = [h('p', null, h('strong', { text: 'Cần xử lý: ' }), tom.length ? tom.join(' · ') : 'không có việc nào đang chờ.')];
    if (t.chi_tiet.length) {
      node.push(h('ul', { class: 'dai-dot' }, t.chi_tiet.map(function (d) {
        return h('li', null, h('a', { href: '#/dot/' + d.dot_id, text: d.tieu_de }),
          ' — đã nộp ' + d.da_nop + '/' + d.tong + ' ' + donVi(d.cach_nop) + (d.cho_duyet ? ', chờ xác nhận ' + d.cho_duyet : '') + (d.chua_nop ? ', chưa nộp ' + d.chua_nop : '') + (d.tre_han ? ', trễ hạn ' + d.tre_han : '') + ' · hạn ' + fmtNgay(d.han_nop) +
          (d.da_trinh ? ' · đã trình, Viện trưởng còn ' + d.vt.cho_quyet_dinh + ' báo cáo chờ duyệt' : ' · chưa trình Viện trưởng'));
      })));
    }
    return h('section', { class: 'luu-y dai-xu-ly' + (khan ? ' luu-y-do' : ''), 'aria-label': 'Việc cần xử lý' }, node);
  }

  function viewDotList() {
    return Promise.all([api('/dot'), api('/tong-quan')]).then(function (r) {
      var kq = r[0];
      tq = r[1];
      dungNav(mucNav);
      veDaiViec();
      // Viện trưởng chỉ xem tiến độ: không có nút tạo đợt, và không cần thấy đợt còn Nháp (chưa giao cho ai).
      var cacDot = me.quan_ly_module ? kq.dot : kq.dot.filter(function (d) { return d.trang_thai !== 'nhap'; });
      var node = [tieuDe(tenMucDot(), me.quan_ly_module ? 'Mỗi đợt giao một biểu mẫu cho các phòng, kèm hạn nộp.' : 'Lưu trữ các đợt báo cáo đã trình: xem lại báo cáo và tiến độ của từng phòng theo từng đợt.',
        me.quan_ly_module ? h('button', { type: 'button', class: 'btn', onclick: function () { moFormDot(null); } }, '+ Tạo đợt báo cáo') : null)];
      var dai = dungDaiCanXuLy(tq);
      if (dai) node.push(dai);
      if (!cacDot.length) {
        node.push(bangTrong(me.quan_ly_module ? 'Chưa có đợt báo cáo nào. Bấm "Tạo đợt báo cáo" để bắt đầu.' : 'Chưa có đợt báo cáo nào đang mở.'));
      } else {
        node.push(h('div', { class: 'cuon-ngang' }, h('table', null,
          h('thead', null, h('tr', null, ['Đợt báo cáo', 'Hạn nộp', 'Trạng thái', me.quan_ly_module ? 'Trình Viện trưởng' : null, 'Tiến độ'].filter(Boolean).map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, cacDot.map(function (d) {
            var daNop = d.da_nop + d.da_duyet;
            return h('tr', { class: d.tre_han && d.trang_thai === 'dang_mo' ? 'dong-chu-y' : '' },
              h('td', null, h('a', { href: '#/dot/' + d.id, text: d.tieu_de }), h('div', { class: 'mo', text: LOAI_DOT[d.loai] + (d.ky ? ' · ' + d.ky : '') + ' · ' + d.mau_ten })),
              h('td', { class: 'con-so', text: fmtNgay(d.han_nop) }),
              h('td', null, nhan(TT_DOT, d.trang_thai)),
              // Chỉ người quản lý module: đợt nào đã trình, đợt nào chưa (đợt Nháp chưa mở nên chưa có gì để trình).
              me.quan_ly_module ? h('td', null,
                d.trang_thai === 'nhap' ? h('span', { class: 'mo', text: '—' }) : nhanTrinh(d.da_trinh, d.trinh_lan),
                d.da_trinh ? h('div', { class: 'mo con-so', text: fmtGio(d.trinh_luc) }) : null,
                d.da_trinh ? h('div', { class: 'mo', text: d.vt.cho_quyet_dinh ? 'Viện trưởng còn ' + d.vt.cho_quyet_dinh + ' báo cáo chờ duyệt' : 'Viện trưởng đã duyệt xong' }) : null) : null,
              h('td', null,
                h('span', { class: 'con-so', text: 'Đã nộp ' + daNop + '/' + d.tong }),
                h('div', { class: 'mo con-so', text: 'chờ xác nhận ' + d.da_nop + ' · cần sửa ' + d.can_chinh_sua + ' · đã xác nhận ' + d.da_duyet }),
                d.tre_han ? nhanTreHan() : null, d.tre_han ? ' ' + d.tre_han + ' phòng' : null));
          })))));
      }
      main.replaceChildren.apply(main, node);
    });
  }

  function moFormDot(dotId) {
    var canTai = [api('/mau'), api('/phong')];
    if (dotId) canTai.push(api('/dot/' + dotId));
    return Promise.all(canTai).then(function (r) {
      var maus = r[0].mau;
      var phongs = r[1].phong.filter(function (p) { return p.active; });
      var cu = dotId ? r[2] : null;
      if (!maus.length) { thongBao('Hãy tạo ít nhất một biểu mẫu trước (mục Biểu mẫu).', 'loi'); return null; }
      if (!phongs.length) { thongBao('Hãy thêm phòng trước (mục Phòng & phân quyền).', 'loi'); return null; }

      var dot = cu ? cu.dot : {};
      var daGiao = cu ? cu.bao_cao.map(function (b) { return b.phong_id; }) : [];
      var khoa = cu && dot.trang_thai !== 'nhap';

      var fTieuDe = h('input', { type: 'text', id: 'd-tieu-de', maxlength: 200, value: dot.tieu_de || '' });
      var fLoai = h('select', { id: 'd-loai', value: dot.loai || 'thang' }, Object.keys(LOAI_DOT).map(function (k) { return h('option', { value: k, text: LOAI_DOT[k] }); }));
      var fKy = h('input', { type: 'text', id: 'd-ky', maxlength: 50, placeholder: 'VD: 10/2026 hoặc Quý 3/2026', value: dot.ky || '' });
      var fHan = h('input', { type: 'date', id: 'd-han', value: dot.han_nop || '' });
      var fMoTa = h('textarea', { id: 'd-mo-ta', rows: 3, maxlength: 2000, value: dot.mo_ta || '' });
      // Chỉ hiện khi sửa đợt ĐANG MỞ: đổi hạn nộp / tiêu đề / hướng dẫn sẽ báo trưởng phòng các phòng chưa nộp.
      var cbBao = h('input', { type: 'checkbox', id: 'd-bao', checked: true });
      cbBao.checked = true;
      var hopBao = cu && dot.trang_thai === 'dang_mo'
        ? h('div', { class: 'truong' }, h('label', { class: 'dong-tick', for: 'd-bao' }, cbBao, 'Gửi email báo trưởng phòng các phòng chưa nộp nếu đổi hạn nộp, tiêu đề hoặc hướng dẫn'),
            h('p', { class: 'tro-giup', text: 'Phòng đã nộp không nhận thư. Bỏ chọn nếu chỉ sửa lỗi chính tả.' }))
        : null;
      // Cách nộp của phòng có từ hai người phụ trách trở lên. Chỉ đổi được khi đợt còn Nháp (đã mở thì báo cáo đã được tạo theo cách nộp này).
      var fCach = h('select', { id: 'd-cach-nop', disabled: khoa, value: dot.cach_nop || 'mot_nguoi' },
        h('option', { value: 'mot_nguoi', text: 'Một báo cáo chung của phòng (một người phụ trách nộp là đủ)' }),
        h('option', { value: 'tat_ca', text: 'Mỗi người phụ trách nộp một báo cáo riêng (phòng hoàn thành khi tất cả đã nộp)' }));
      var fMau = h('select', { id: 'd-mau', disabled: khoa, value: String(dot.mau_id || maus[0].id) },
        maus.map(function (m) { return h('option', { value: String(m.id), text: m.ten + ' (phiên bản ' + m.so_phien_ban + ')' }); }));
      var hop_phong = phongs.map(function (p) {
        var da = daGiao.indexOf(p.id) !== -1;
        var cb = h('input', { type: 'checkbox', id: 'd-p-' + p.id, value: String(p.id), checked: da, disabled: !!(khoa && da) });
        cb.checked = da;
        return h('label', { class: 'dong-tick', for: 'd-p-' + p.id }, cb, p.ten);
      });
      var chonHet = h('button', { type: 'button', class: 'btn btn-phu btn-nho', onclick: function () {
        hop_phong.forEach(function (l) { l.querySelector('input').checked = true; });
      } }, 'Chọn tất cả');

      var than = h('div', null,
        h('div', { class: 'truong' }, h('label', { for: 'd-tieu-de' }, 'Tiêu đề ', h('span', { class: 'bat-buoc', 'aria-hidden': 'true', text: '*' })), fTieuDe),
        h('div', { class: 'luoi-2' },
          h('div', { class: 'truong' }, h('label', { for: 'd-loai', text: 'Loại đợt' }), fLoai),
          h('div', { class: 'truong' }, h('label', { for: 'd-ky', text: 'Kỳ báo cáo' }), fKy)),
        h('div', { class: 'truong' }, h('label', { for: 'd-han' }, 'Hạn nộp ', h('span', { class: 'bat-buoc', 'aria-hidden': 'true', text: '*' })), fHan),
        h('div', { class: 'truong' }, h('label', { for: 'd-mo-ta', text: 'Hướng dẫn / ghi chú cho các phòng' }), fMoTa),
        hopBao,
        h('div', { class: 'truong' }, h('label', { for: 'd-mau', text: 'Biểu mẫu' }),
          khoa ? h('p', { class: 'tro-giup', text: 'Đợt đã mở nên không đổi được biểu mẫu.' }) : h('p', { class: 'tro-giup', text: 'Đợt dùng phiên bản mới nhất của biểu mẫu tại thời điểm tạo.' }), fMau),
        h('div', { class: 'truong' }, h('label', { for: 'd-cach-nop', text: 'Cách nộp báo cáo của phòng' }),
          h('p', { class: 'tro-giup', text: khoa ? 'Đợt đã mở nên không thể thay đổi cách nộp.' : 'Áp dụng khi một phòng có từ hai người phụ trách trở lên. Chỉ lựa chọn được khi đợt còn ở trạng thái Nháp.' }), fCach),
        h('fieldset', { class: 'nhom' }, h('legend', { text: 'Giao cho các phòng *' }),
          khoa ? h('p', { class: 'tro-giup', text: 'Đợt đã mở: chỉ thêm được phòng, không gỡ phòng.' }) : null,
          h('div', { class: 'lua-phong' }, hop_phong), chonHet));

      return moHop({
        tieuDe: cu ? 'Sửa đợt báo cáo' : 'Tạo đợt báo cáo',
        than: than,
        nutChinh: cu ? 'Lưu thay đổi' : 'Tạo đợt',
        khiGui: function () {
          var phong_ids = hop_phong.map(function (l) { return l.querySelector('input'); }).filter(function (c) { return c.checked; }).map(function (c) { return Number(c.value); });
          if (!fTieuDe.value.trim()) { fTieuDe.focus(); throw new Error('Cần nhập tiêu đề.'); }
          if (!fHan.value) { fHan.focus(); throw new Error('Cần chọn hạn nộp.'); }
          if (!phong_ids.length) throw new Error('Cần chọn ít nhất một phòng.');
          var body = { tieu_de: fTieuDe.value, loai: fLoai.value, ky: fKy.value, han_nop: fHan.value, mo_ta: fMoTa.value, phong_ids: phong_ids };
          if (!khoa) { body.mau_id = Number(fMau.value); body.cach_nop = fCach.value; }
          if (hopBao && !cbBao.checked) body.khong_thong_bao = true;
          return api(cu ? '/dot/' + dotId : '/dot', { method: cu ? 'PUT' : 'POST', body: body }).then(function (kq) {
            thongBao(cu ? 'Đã lưu đợt báo cáo.' + (kq.da_bao ? ' Đã gửi email báo ' + kq.da_bao + ' trưởng phòng chưa nộp.' : '') : 'Đã tạo đợt báo cáo ở trạng thái Nháp.');
            location.hash = '#/dot/' + (cu ? dotId : kq.id);
            if (cu) return route();
          });
        },
      });
    }).catch(function (e) { thongBao(e.message, 'loi'); });
  }

  var HANH_DONG_DOT = {
    trinh: 'Trình Viện trưởng', trinh_lai: 'Trình lại Viện trưởng (nhắc)', mo_lai_theo_de_nghi: 'Đợt tự mở lại theo đề nghị chỉnh sửa của Viện trưởng',
    xuat: 'Kết xuất báo cáo', sua_dot: 'Sửa đợt báo cáo',
  };
  /** Lịch sử của đợt (trình, kết xuất, sửa đợt, mở lại…). */
  function khoiLichSuDot(lichSu) {
    if (!lichSu || !lichSu.length) return null;
    return [h('h3', { text: 'Lịch sử của đợt' }), h('ul', { class: 'lich-su' }, lichSu.map(function (l) {
      return h('li', null, h('strong', { text: HANH_DONG_DOT[l.hanh_dong] || l.hanh_dong }), ' — ', l.nguoi || 'Không rõ', ' · ', fmtGio(l.tao_luc),
        l.ghi_chu ? h('span', { class: 'ghi-chu', text: l.ghi_chu }) : null);
    }))];
  }

  /** Câu mô tả tiến độ xử lý của Viện trưởng: "Đã xử lý 5/8 · duyệt 3 · không duyệt 1 · đề nghị chỉnh sửa 1 · còn chờ 3 · chưa nộp 0". */
  function tomTatTienDoVT(td) {
    var daXuLy = td.duyet + td.khong_duyet + td.de_nghi_chinh_sua;
    return 'Viện trưởng đã xử lý ' + daXuLy + '/' + (daXuLy + td.cho_quyet_dinh) + ' báo cáo đã nộp (duyệt ' + td.duyet + ' · không duyệt ' + td.khong_duyet +
      ' · đề nghị chỉnh sửa ' + td.de_nghi_chinh_sua + ') · còn chờ duyệt ' + td.cho_quyet_dinh + ' · chưa nộp ' + td.chua_nop + (td.dang_sua ? ' · đang chỉnh sửa ' + td.dang_sua : '');
  }

  /**
   * Mục "Trình Viện trưởng" của một đợt. Người quản lý module bấm trình: toàn bộ báo cáo của đợt hiện ra trong màn hình duyệt của Viện trưởng
   * (đọc ngay trên màn hình, bấm Duyệt / Không duyệt / Ý kiến / Đề nghị chỉnh sửa), không xuất và không tải tệp. Phòng chưa nộp vẫn trình được.
   * Viện trưởng (không kiêm quản lý module) chỉ thấy tiến độ và lối vào màn hình duyệt. Có thể trình lại bao nhiêu lần cũng được, để nhắc.
   */
  function khoiTrinhMoi(dotId, d, kq) {
    var t = kq.trinh_vt;
    var td = kq.tien_do_vt;
    var node = [h('h3', { id: 'trinh-tieu-de', text: 'Trình Viện trưởng' })];
    if (t) {
      node.push(h('p', null, h('span', { class: 'nhan nhan-nop' }, h('span', { 'aria-hidden': 'true', text: '●' }), 'Đã trình' + (t.lan > 1 ? ' (lần ' + t.lan + ')' : ''))));
      node.push(h('p', { class: 'mo', text: 'Trình bởi ' + (t.nguoi_trinh || '—') + ' lúc ' + fmtGio(t.trinh_luc) + (t.loi_nhan ? ' · Lời nhắn: ' + t.loi_nhan : '') }));
      node.push(h('p', { text: tomTatTienDoVT(td) }));
    } else if (me.quan_ly_module) {
      node.push(h('p', { class: 'mo', text: 'Chưa trình.' }));
    } else {
      node.push(h('p', { class: 'mo', text: 'Đợt này chưa được người quản lý module trình Viện trưởng.' }));
    }
    var nut = [];
    if (t && me.vien_truong) nut.push(h('a', { class: 'btn' + (me.quan_ly_module ? ' btn-phu' : ''), href: '#/duyet/' + dotId }, 'Đọc và duyệt →'));
    if (me.quan_ly_module && d.trang_thai !== 'nhap') {
      var chuaNop = kq.bao_cao.filter(function (b) { return b.trang_thai === 'chua_nop'; });
      var trinhLai = !!t;
      node.push(h('p', { class: 'mo', text: 'Trình để Viện trưởng đọc báo cáo của từng phòng ngay trong hệ thống và duyệt, không duyệt, góp ý hoặc đề nghị chỉnh sửa; Viện trưởng nhận email kèm liên kết. Không cần xuất hay tải tệp. Phòng chưa nộp hoặc trễ hạn vẫn trình được, Viện trưởng sẽ thấy "Chưa nộp". Có thể trình lại để nhắc. Kết xuất Word/PDF (ở trên) vẫn dùng được khi cần nộp hồ sơ cho nơi khác.' }));
      var loiNhan = h('textarea', { id: 'trinh-loi-nhan', rows: 2, maxlength: 1000 });
      var loiEl = h('p', { class: 'loi-truong', role: 'alert', hidden: true });
      var nutTrinh = h('button', { type: 'button', class: trinhLai ? 'btn btn-phu' : 'btn' }, trinhLai ? 'Trình lại để nhắc Viện trưởng' : 'Trình Viện trưởng');
      nutTrinh.addEventListener('click', function () {
        loiEl.hidden = true;
        var daNop = kq.bao_cao.length - chuaNop.length;
        xacNhan(trinhLai ? 'Trình lại cho Viện trưởng?' : 'Trình đợt này cho Viện trưởng?',
          'Viện trưởng sẽ thấy ' + daNop + '/' + kq.bao_cao.length + ' báo cáo đã nộp để đọc và duyệt, kèm email thông báo.' +
          (chuaNop.length ? ' Còn ' + chuaNop.length + ' báo cáo chưa nộp (' + chuaNop.slice(0, 4).map(function (b) { return b.phong_ten; }).join('; ') + (chuaNop.length > 4 ? '…' : '') + '): Viện trưởng sẽ thấy "Chưa nộp" ở các phòng đó, và vẫn có thể trình lại khi phòng nộp xong.' : ''),
          trinhLai ? 'Trình lại' : 'Trình').then(function (ok) {
          if (!ok) return;
          nutTrinh.disabled = true;
          api('/dot/' + dotId + '/trinh-vien-truong', { method: 'POST', body: { loi_nhan: loiNhan.value } })
            .then(function (r) {
              thongBao((r.trinh_lai ? 'Đã trình lại' : 'Đã trình') + ' cho Viện trưởng' + (r.da_bao ? '; email đã gửi tới ' + r.da_bao + ' người.' : '. Chưa có ai nhận email (Viện trưởng chưa có địa chỉ email hợp lệ).'));
              return route();
            })
            .catch(function (e) { loiEl.textContent = e.message; loiEl.hidden = false; nutTrinh.disabled = false; });
        });
      });
      node.push(h('div', { class: 'truong' }, h('label', { for: 'trinh-loi-nhan', text: 'Lời nhắn gửi Viện trưởng (tùy chọn)' }), loiNhan, loiEl));
      nut.push(nutTrinh);
    }
    if (nut.length) node.push(h('div', { class: 'nhom-nut' }, nut));
    return h('section', { 'aria-labelledby': 'trinh-tieu-de', class: 'khoi-trinh' }, node);
  }

  /** Thanh chọn phòng + nút kết xuất Word/PDF. Chỉ phòng ĐÃ NỘP / ĐÃ DUYỆT mới chọn được. */
  function dungBangTienDo(dotId, d, baoCao, daTrinh) {
    var daNop = function (b) { return b.trang_thai === 'da_nop' || b.trang_thai === 'da_duyet'; };
    var chon = {};
    var coXuat = d.trang_thai !== 'nhap' && me.quan_ly_module; // Viện trưởng đọc, không kết xuất
    var dem = h('span', { class: 'mo', 'aria-live': 'polite' });
    var aWord = h('a', { class: 'btn btn-phu btn-nho', 'aria-disabled': 'true' }, 'Tải Word (.docx)');
    var aPdf = h('a', { class: 'btn btn-phu btn-nho', 'aria-disabled': 'true' }, 'Tải PDF');
    var aXem = h('a', { class: 'btn btn-phu btn-nho', 'aria-disabled': 'true', target: '_blank', rel: 'noopener' }, 'Xem trước PDF');
    var cbTatCa = h('input', { type: 'checkbox', id: 'xuat-tat-ca', 'aria-label': 'Chọn tất cả các báo cáo đã nộp' });
    var cbs = [];

    function capNhat() {
      var ids = Object.keys(chon).filter(function (k) { return chon[k]; });
      dem.textContent = ids.length ? 'Đã chọn ' + ids.length + ' báo cáo' : 'Chưa chọn báo cáo nào';
      [[aWord, 'docx', ''], [aPdf, 'pdf', ''], [aXem, 'pdf', '&xem=1']].forEach(function (p) {
        if (ids.length) { p[0].setAttribute('href', API + '/dot/' + dotId + '/xuat?bao_cao=' + ids.join(',') + '&dinh_dang=' + p[1] + p[2]); p[0].removeAttribute('aria-disabled'); }
        else { p[0].removeAttribute('href'); p[0].setAttribute('aria-disabled', 'true'); }
      });
      var duocChon = baoCao.filter(daNop);
      cbTatCa.checked = duocChon.length > 0 && ids.length === duocChon.length;
    }
    [aWord, aPdf, aXem].forEach(function (a) { a.addEventListener('click', function (e) { if (a.getAttribute('aria-disabled') === 'true') e.preventDefault(); }); });
    cbTatCa.disabled = !baoCao.some(daNop);
    cbTatCa.addEventListener('change', function () {
      baoCao.forEach(function (b, i) { if (daNop(b)) { chon[b.id] = cbTatCa.checked; cbs[i].checked = cbTatCa.checked; } });
      capNhat();
    });

    var cotDau = coXuat ? [h('th', { scope: 'col', class: 'cot-chon' }, cbTatCa)] : [];
    var bang = h('div', { class: 'cuon-ngang' }, h('table', null,
      h('thead', null, h('tr', null, cotDau, ['Phòng', 'Trạng thái', daTrinh ? 'Viện trưởng' : null, 'Người nộp', 'Nộp lúc', ''].filter(Boolean).map(function (t) { return h('th', { scope: 'col', text: t }); }))),
      h('tbody', null, baoCao.map(function (b, i) {
        var cb = null;
        if (coXuat) {
          cb = h('input', { type: 'checkbox', id: 'xuat-' + b.id, disabled: !daNop(b), 'aria-label': 'Chọn báo cáo của ' + b.phong_ten + (b.chu_ten ? ' (' + b.chu_ten + ')' : '') + ' để kết xuất' });
          if (!daNop(b)) cb.title = 'Chưa nộp, chưa kết xuất được';
          cb.addEventListener('change', function () { chon[b.id] = cb.checked; capNhat(); });
          cbs[i] = cb;
        }
        return h('tr', { class: b.tre_han && (b.trang_thai === 'chua_nop' || b.trang_thai === 'can_chinh_sua') ? 'dong-chu-y' : '' },
          coXuat ? h('td', { class: 'cot-chon' }, cb) : null,
          h('td', { class: 'ten-phong' }, b.phong_ten, b.chu_ten ? h('div', { class: 'mo', text: nguoiPhuTrachNhan(b) }) : null),
          h('td', null, nhan(TT_BAO_CAO, b.trang_thai), b.tre_han ? [' ', nhanTreHan()] : null, b.tu_duyet ? [' ', nhanTuDuyet()] : null),
          daTrinh ? h('td', null, nhan(TT_VT, b.vt_trang_thai),
            b.vien_truong && b.vien_truong.ghi_chu && b.vt_trang_thai !== 'duyet' ? h('div', { class: 'mo vt-ghi-chu', text: b.vien_truong.ghi_chu }) : null) : null,
          h('td', { text: b.nguoi_nop || '—' }),
          h('td', { class: 'con-so', text: b.nop_luc ? fmtGio(b.nop_luc) : '—' }),
          h('td', null, d.trang_thai === 'nhap' ? null : h('a', { class: 'btn btn-nho btn-phu', href: '#/bao-cao/' + b.id }, b.trang_thai === 'da_nop' && me.quan_ly_module ? 'Xem và xác nhận' : 'Xem')));
      }))));
    capNhat();
    if (!coXuat) return [bang];
    return [bang, h('div', { class: 'xuat-bar' },
      h('span', { class: 'xuat-nhan', text: 'Kết xuất các báo cáo đã chọn:' }), aWord, aPdf, aXem, dem,
      h('p', { class: 'mo' }, 'Chọn một hoặc nhiều báo cáo. Nhiều báo cáo được gộp vào một tệp, mỗi báo cáo là một văn bản riêng bắt đầu ở trang mới. Chỉ báo cáo đã nộp hoặc đã xác nhận mới kết xuất được.'))];
  }

  function viewDot(id) {
    return api('/dot/' + id).then(function (kq) {
      return kq;
    }).then(function (kq) {
      var d = kq.dot;
      function doiTT(duongDan, thanhCong) {
        return api('/dot/' + id + duongDan, { method: 'POST' }).then(function () { thongBao(thanhCong); return route(); }).catch(function (e) { thongBao(e.message, 'loi'); });
      }
      var nut = [];
      if (d.trang_thai === 'nhap') {
        nut.push(h('button', { type: 'button', class: 'btn', onclick: function () {
          // Phòng CHƯA có trưởng phòng thì không ai nhận email báo: nói rõ ngay lúc mở để người quản lý kịp gán.
          api('/phong').then(function (p) {
            var thieu = kq.bao_cao.filter(function (b) {
              var ph = p.phong.filter(function (x) { return x.id === b.phong_id; })[0];
              return ph && ph.so_truong_phong === 0;
            }).map(function (b) { return b.phong_ten; });
            return xacNhan('Mở đợt báo cáo?',
              'Những người phụ trách của các phòng sẽ nhìn thấy đợt này và nhận email thông báo kèm liên kết để nộp báo cáo.' + (d.cach_nop === 'tat_ca' ? ' Đợt này yêu cầu mỗi người phụ trách nộp một báo cáo riêng.' : '') +
              (thieu.length ? ' LƯU Ý: ' + thieu.join('; ') + ' chưa có người phụ trách nên sẽ không nhận được email. Có thể mở đợt rồi phân công người phụ trách sau (người được phân công sẽ nhận thư thông báo các đợt đang mở), hoặc phân công trước tại mục Phòng & phân quyền.' : ''),
              'Mở đợt');
          }).then(function (ok) { if (ok) doiTT('/mo', 'Đã mở đợt báo cáo.'); }).catch(function (e) { thongBao(e.message, 'loi'); });
        } }, 'Mở đợt cho các phòng'));
      }
      if (d.trang_thai === 'dang_mo') {
        nut.push(h('button', { type: 'button', class: 'btn btn-phu', onclick: function () {
          xacNhan('Đóng đợt báo cáo?', 'Các phòng sẽ không nhập hoặc nộp được nữa. Bạn có thể mở lại sau.', 'Đóng đợt').then(function (ok) { if (ok) doiTT('/dong', 'Đã đóng đợt.'); });
        } }, 'Đóng đợt'));
      }
      if (d.trang_thai === 'dong') nut.push(h('button', { type: 'button', class: 'btn btn-phu', onclick: function () { doiTT('/mo-lai', 'Đã mở lại đợt.'); } }, 'Mở lại đợt'));
      nut.push(h('button', { type: 'button', class: 'btn btn-phu', onclick: function () { moFormDot(id); } }, 'Sửa đợt'));
      if (d.trang_thai === 'nhap') {
        nut.push(h('button', { type: 'button', class: 'btn btn-nguy', onclick: function () {
          xacNhan('Xóa đợt Nháp?', 'Đợt "' + d.tieu_de + '" sẽ bị xóa vĩnh viễn. Không hoàn tác được.', 'Xóa đợt', true).then(function (ok) {
            if (!ok) return;
            api('/dot/' + id, { method: 'DELETE' }).then(function () { thongBao('Đã xóa đợt.'); location.hash = '#/dot'; }).catch(function (e) { thongBao(e.message, 'loi'); });
          });
        } }, 'Xóa đợt'));
      }

      var daNop = kq.bao_cao.filter(function (b) { return b.trang_thai === 'da_nop' || b.trang_thai === 'da_duyet'; }).length;
      var node = [
        h('div', { class: 'nhom-nut' }, h('a', { class: 'btn btn-phu btn-nho', href: '#/dot' }, '← ' + tenMucDot())),
        tieuDe(d.tieu_de, LOAI_DOT[d.loai] + (d.ky ? ' · ' + d.ky : '') + ' · Hạn nộp ' + fmtNgay(d.han_nop) + ' · Biểu mẫu "' + d.mau_ten + '" phiên bản ' + d.so_phien_ban),
        h('p', null, nhan(TT_DOT, d.trang_thai), ' ', d.trang_thai !== 'nhap' ? [nhanTrinh(!!kq.trinh_vt, kq.trinh_vt ? kq.trinh_vt.lan : 0), ' '] : null, h('span', { class: 'con-so', text: 'Đã nộp ' + daNop + '/' + kq.bao_cao.length })),
      ];
      if (d.mo_ta) node.push(h('p', { class: 'phu', text: d.mo_ta }));
      node.push(h('p', { class: 'mo', text: 'Cách nộp: ' + (d.cach_nop === 'tat_ca' ? 'mỗi người phụ trách nộp một báo cáo riêng; phòng chỉ hoàn thành khi tất cả những người được phân công đã nộp.' : 'một báo cáo chung của phòng; một người phụ trách nộp là đủ.') }));
      if (d.cach_nop === 'tat_ca') {
        var nhomPhong = {};
        kq.bao_cao.forEach(function (b) { (nhomPhong[b.phong_id] = nhomPhong[b.phong_id] || []).push(b); });
        var soPhong = Object.keys(nhomPhong);
        var soXong = soPhong.filter(function (k) { return nhomPhong[k].every(function (b) { return b.trang_thai === 'da_nop' || b.trang_thai === 'da_duyet'; }); }).length;
        node.push(h('p', null, h('strong', { text: 'Phòng đã hoàn thành báo cáo: ' + soXong + '/' + soPhong.length })));
      }
      if (d.trang_thai === 'nhap' && me.quan_ly_module) node.push(h('div', { class: 'luu-y' }, h('p', { text: 'Đợt đang ở trạng thái Nháp: các trưởng phòng chưa nhìn thấy. Kiểm tra lại rồi bấm "Mở đợt cho các phòng".' })));
      // Mở/đóng/sửa/xóa đợt: chỉ người quản lý module. Viện trưởng chỉ xem.
      if (me.quan_ly_module) node.push(h('div', { class: 'nhom-nut' }, nut));
      node.push(h('h3', { text: 'Tiến độ theo phòng' }));
      node.push.apply(node, dungBangTienDo(id, d, kq.bao_cao, !!kq.trinh_vt));
      if (d.trang_thai !== 'nhap') node.push(khoiTrinhMoi(id, d, kq));
      var ls = khoiLichSuDot(kq.lich_su);
      if (ls) node.push.apply(node, ls);
      main.replaceChildren.apply(main, node);
    });
  }

  // ══ QUẢN LÝ: biểu mẫu ═════════════════════════════════════════════════════
  function viewMauList() {
    return api('/mau').then(function (kq) {
      var node = [tieuDe('Biểu mẫu báo cáo', 'Cấu hình các ô mà trưởng phòng phải điền. Sửa biểu mẫu không làm đổi các đợt đã giao.',
        h('a', { class: 'btn', href: '#/mau/moi' }, '+ Tạo biểu mẫu'))];
      if (!kq.mau.length) node.push(bangTrong('Chưa có biểu mẫu nào.'));
      else {
        node.push(h('div', { class: 'cuon-ngang' }, h('table', null,
          h('thead', null, h('tr', null, ['Tên biểu mẫu', 'Phiên bản', 'Số đợt đã dùng', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, kq.mau.map(function (m) {
            return h('tr', null,
              h('td', null, h('a', { href: '#/mau/' + m.id, text: m.ten }), m.mo_ta ? h('div', { class: 'mo', text: m.mo_ta }) : null),
              h('td', { class: 'con-so', text: String(m.so_phien_ban) }),
              h('td', { class: 'con-so', text: String(m.so_dot) }),
              h('td', null, h('a', { class: 'btn btn-nho btn-phu', href: '#/mau/' + m.id }, 'Sửa')));
          })))));
      }
      main.replaceChildren.apply(main, node);
    });
  }

  /** Khóa ngẫu nhiên không trùng trong tập `dung`. Ô và cột mới được cấp khóa NGAY Ở MÁY (không chờ server)
   *  để ô tổng hợp trỏ được vào một bảng vừa thêm trước khi lưu. Server vẫn kiểm lại tính hợp lệ/duy nhất. */
  function khoaMoi(dung, tienTo) {
    var k;
    do { k = tienTo + Math.random().toString(36).slice(2, 8); } while (dung[k]);
    dung[k] = 1;
    return k;
  }

  var KIEU_COT = { text: 'Văn bản ngắn', textarea: 'Văn bản dài', number: 'Số', date: 'Ngày', select: 'Chọn một trong danh sách' };

  var MAU_KHOI_DAU = [
    { kieu: 'textarea', nhan: 'Công việc đã thực hiện trong kỳ', bat_buoc: true },
    { kieu: 'textarea', nhan: 'Khó khăn, vướng mắc', bat_buoc: false },
    { kieu: 'textarea', nhan: 'Kiến nghị, đề xuất', bat_buoc: false },
  ];

  function viewMau(id) {
    var moi = id === 'moi';
    var tai = moi ? Promise.resolve({ ten: '', mo_ta: '', so_phien_ban: 0, truong: MAU_KHOI_DAU.map(function (o) { return Object.assign({}, o); }) }) : api('/mau/' + id);
    return tai.then(function (m) {
      var model = { ten: m.ten, mo_ta: m.mo_ta || '', truong: JSON.parse(JSON.stringify(m.truong)) };
      var khoaO = {};
      model.truong.forEach(function (o) { if (o.key) khoaO[o.key] = 1; else o.key = khoaMoi(khoaO, 'o_'); });
      var ds = h('div');
      var loiEl = h('div', { class: 'luu-y luu-y-do', role: 'alert', hidden: true });
      var xemTruoc = h('div', { class: 'noi-dung' });

      function danDirty() { dirty = true; }

      /** Tên ô để đọc cho trình đọc màn hình: nhãn hiện tại, hoặc "ô N" nếu chưa đặt. */
      function tenO(o, i) { return o.nhan && o.nhan.trim() ? '"' + o.nhan.trim() + '"' : 'ô ' + (i + 1); }

      // ── Cấu hình bảng: danh sách cột ─────────────────────────────────────────
      function cauHinhBang(o, p, i) {
        var khoaCot = {};
        o.cot.forEach(function (c) { if (c.key) khoaCot[c.key] = 1; else c.key = khoaMoi(khoaCot, 'c_'); });
        var cpn = h('input', { type: 'checkbox', id: p + 'cpn' });
        cpn.checked = !!o.cho_phep_nhom;
        var nn = h('input', { type: 'text', id: p + 'nn', maxlength: 60, placeholder: 'VD: Mục tiêu / Nhóm công việc', value: o.nhan_nhom || '' });
        var hangNn = h('div', { class: 'truong' }, h('label', { for: p + 'nn', text: 'Tên gọi một nhóm (hiện ở nút "Thêm …" và trên dòng nhóm)' }), nn);
        hangNn.hidden = !o.cho_phep_nhom;
        cpn.addEventListener('change', function () { o.cho_phep_nhom = cpn.checked; hangNn.hidden = !cpn.checked; danDirty(); });
        nn.addEventListener('input', function () { o.nhan_nhom = nn.value; danDirty(); });

        function dungCot(c, j) {
          var q = p + 'c' + j + '-';
          var nhanC = h('input', { type: 'text', id: q + 'nhan', maxlength: 150, value: c.nhan || '' });
          var kieuC = h('select', { id: q + 'kieu', value: c.kieu }, Object.keys(KIEU_COT).map(function (k) { return h('option', { value: k, text: KIEU_COT[k] }); }));
          var phan = [
            h('div', null, h('label', { for: q + 'nhan', text: 'Tiêu đề cột' }), nhanC),
            h('div', null, h('label', { for: q + 'kieu', text: 'Loại dữ liệu' }), kieuC),
          ];
          kieuC.addEventListener('change', function () {
            c.kieu = kieuC.value;
            if (c.kieu === 'select' && !(c.lua_chon && c.lua_chon.length)) c.lua_chon = ['Lựa chọn 1', 'Lựa chọn 2'];
            if (c.kieu !== 'number') delete c.phan_tram;
            danDirty();
            veLai('#' + q + 'kieu');
          });
          if (c.kieu === 'select') {
            var lc = h('textarea', { id: q + 'lc', rows: 3, value: (c.lua_chon || []).join('\n') });
            lc.addEventListener('input', function () { c.lua_chon = lc.value.split('\n'); danDirty(); });
            phan.push(h('div', { class: 'rong' }, h('label', { for: q + 'lc', text: 'Các lựa chọn (mỗi dòng một lựa chọn, tối thiểu 2)' }), lc));
          }
          if (c.kieu === 'number') {
            var mn = h('input', { type: 'number', step: 'any', id: q + 'min', value: c.min === undefined ? '' : String(c.min) });
            var mx = h('input', { type: 'number', step: 'any', id: q + 'max', value: c.max === undefined ? '' : String(c.max) });
            mn.addEventListener('input', function () { c.min = mn.value === '' ? undefined : Number(mn.value); danDirty(); });
            mx.addEventListener('input', function () { c.max = mx.value === '' ? undefined : Number(mx.value); danDirty(); });
            var pt = h('input', { type: 'checkbox', id: q + 'pt', 'data-pt': '1' });
            pt.checked = !!c.phan_tram;
            pt.addEventListener('change', function () {
              // Mỗi bảng chỉ có MỘT cột làm mức độ hoàn thành: chọn cột này thì bỏ chọn các cột khác.
              o.cot.forEach(function (x) { delete x.phan_tram; });
              if (pt.checked) c.phan_tram = true;
              var khung = pt.closest('.cau-hinh-bang');
              khung.querySelectorAll('input[data-pt]').forEach(function (cb) { cb.checked = cb === pt && pt.checked; });
              danDirty();
            });
            phan.push(h('div', null, h('label', { for: q + 'min', text: 'Giá trị nhỏ nhất (tùy chọn)' }), mn),
              h('div', null, h('label', { for: q + 'max', text: 'Giá trị lớn nhất (tùy chọn)' }), mx),
              h('div', { class: 'rong' }, h('label', { class: 'dong-tick', for: q + 'pt' }, pt, 'Cột này là "Mức độ hoàn thành (%)" — dùng để tự tính số liệu tổng hợp')));
          }
          var nutL = h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'data-oc': q, 'data-act': 'len', disabled: j === 0, onclick: function () { doiCot(j, -1); } }, '↑ Lên');
          var nutX = h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'data-oc': q, 'data-act': 'xuong', disabled: j === o.cot.length - 1, onclick: function () { doiCot(j, 1); } }, '↓ Xuống');
          var nutXoa = h('button', {
            type: 'button', class: 'btn btn-nguy btn-nho', disabled: o.cot.length <= 1,
            onclick: function () {
              o.cot.splice(j, 1);
              danDirty();
              var k = Math.min(j, o.cot.length - 1);
              veLai('[data-oc="' + p + 'c' + k + '-"][data-act="len"], [data-oc="' + p + 'c' + k + '-"][data-act="xuong"]');
            },
          }, 'Xóa cột');
          function datNhan() {
            var t = c.nhan && c.nhan.trim() ? '"' + c.nhan.trim() + '"' : 'cột ' + (j + 1);
            nutL.setAttribute('aria-label', 'Chuyển cột ' + t + ' sang trước');
            nutX.setAttribute('aria-label', 'Chuyển cột ' + t + ' ra sau');
            nutXoa.setAttribute('aria-label', 'Xóa cột ' + t);
          }
          nhanC.addEventListener('input', function () { c.nhan = nhanC.value; danDirty(); datNhan(); });
          datNhan();
          return h('fieldset', { class: 'cot-mau' }, h('legend', { text: 'Cột ' + (j + 1) }), h('div', { class: 'luoi-2' }, phan), h('div', { class: 'nhom-nut' }, nutL, nutX, nutXoa));
        }

        function doiCot(j, huong) {
          var k = j + huong;
          var t = o.cot[j]; o.cot[j] = o.cot[k]; o.cot[k] = t;
          danDirty();
          veLai('[data-oc="' + p + 'c' + k + '-"][data-act="' + (huong < 0 ? 'len' : 'xuong') + '"], [data-oc="' + p + 'c' + k + '-"][data-act="' + (huong < 0 ? 'xuong' : 'len') + '"]');
        }

        var nutThemCot = h('button', {
          type: 'button', class: 'btn btn-phu btn-nho', disabled: o.cot.length >= 8,
          onclick: function () {
            o.cot.push({ key: khoaMoi(khoaCot, 'c_'), kieu: 'text', nhan: 'Cột mới' });
            danDirty();
            veLai('#' + p + 'c' + (o.cot.length - 1) + '-nhan');
          },
        }, '+ Thêm cột');

        return h('div', { class: 'rong cau-hinh-bang' },
          h('div', { class: 'truong' }, h('label', { class: 'dong-tick', for: p + 'cpn' }, cpn, 'Cho phép chia nhóm (dòng tiêu đề A, B, C… để gom các dòng công việc)')),
          hangNn,
          h('p', { class: 'nhan-truong', text: 'Các cột của bảng (tối đa 8)' }),
          o.cot.map(dungCot),
          h('div', { class: 'nhom-nut' }, nutThemCot));
      }

      // ── Cấu hình ô tổng hợp: chọn các bảng cần thống kê ──────────────────────
      function cauHinhTongHop(o, p) {
        var cacBang = model.truong.filter(function (x) { return x.kieu === 'bang'; });
        if (!cacBang.length) {
          return h('p', { class: 'rong mo', text: 'Biểu mẫu chưa có bảng nào. Hãy thêm một ô "Bảng nhiều dòng" (có cột "Mức độ hoàn thành (%)") để thống kê.' });
        }
        o.bang = (o.bang || []).filter(function (k) { return cacBang.some(function (b) { return b.key === k; }); });
        return h('fieldset', { class: 'rong nhom' }, h('legend', { text: 'Thống kê từ các bảng' }),
          h('p', { class: 'tro-giup', text: 'Đếm số dòng công việc ở các bảng được chọn: hoàn thành (100%), đang thực hiện (1–99%), chưa thực hiện (0% hoặc để trống). Mỗi bảng cần có một cột được đánh dấu "Mức độ hoàn thành (%)".' }),
          cacBang.map(function (b, j) {
            var cid = p + 'tb' + j;
            var cb = h('input', { type: 'checkbox', id: cid });
            cb.checked = o.bang.indexOf(b.key) !== -1;
            cb.addEventListener('change', function () {
              o.bang = (o.bang || []).filter(function (k) { return k !== b.key; });
              if (cb.checked) o.bang.push(b.key);
              danDirty();
            });
            var thieuCot = !b.cot.some(function (c) { return c.phan_tram; });
            return h('div', null, h('label', { class: 'dong-tick', for: cid }, cb, (b.nhan || '(bảng chưa đặt tên)') + (thieuCot ? ' — chưa có cột "Mức độ hoàn thành (%)"' : '')));
          }));
      }

      function dungO(o, i) {
        var p = 'm' + i + '-';
        var laSection = o.kieu === 'section';
        var laTongHop = o.kieu === 'tong_hop';
        var laBang = o.kieu === 'bang';
        var kieu = h('select', { id: p + 'kieu', value: o.kieu }, Object.keys(KIEU_O).map(function (k) { return h('option', { value: k, text: KIEU_O[k] }); }));
        kieu.addEventListener('change', function () {
          o.kieu = kieu.value;
          if (o.kieu === 'select' && !(o.lua_chon && o.lua_chon.length)) o.lua_chon = ['Lựa chọn 1', 'Lựa chọn 2'];
          if (o.kieu === 'bang' && !(o.cot && o.cot.length)) {
            o.cot = [{ key: khoaMoi({}, 'c_'), kieu: 'text', nhan: 'Nội dung' }, { key: khoaMoi({}, 'c_'), kieu: 'number', nhan: 'Mức độ hoàn thành (%)', min: 0, max: 100, phan_tram: true }];
          }
          if (o.kieu === 'tong_hop' && !o.bang) o.bang = [];
          danDirty();
          veLai('#' + p + 'kieu');
        });
        var nhanIn = h('input', { type: 'text', id: p + 'nhan', maxlength: 200, value: o.nhan || '' });
        nhanIn.addEventListener('input', function () { o.nhan = nhanIn.value; danDirty(); datNhanNut(); });
        var gy = h('input', { type: 'text', id: p + 'gy', maxlength: 300, value: o.tro_giup || '' });
        gy.addEventListener('input', function () { o.tro_giup = gy.value; danDirty(); });

        var nhanNhan = laSection ? 'Tiêu đề nhóm' : laBang ? 'Tiêu đề bảng' : laTongHop ? 'Tiêu đề khối thống kê' : 'Nhãn (câu hỏi)';
        var cot = [
          h('div', null, h('label', { for: p + 'kieu', text: 'Loại ô' }), kieu),
          h('div', null, h('label', { for: p + 'nhan', text: nhanNhan }), nhanIn),
          h('div', { class: 'rong' }, h('label', { for: p + 'gy', text: 'Gợi ý (hiện dưới nhãn, tùy chọn)' }), gy),
        ];
        if (!laSection && !laTongHop) {
          var bb = h('input', { type: 'checkbox', id: p + 'bb' });
          bb.checked = !!o.bat_buoc;
          bb.addEventListener('change', function () { o.bat_buoc = bb.checked; danDirty(); });
          cot.push(h('div', { class: 'rong' }, h('label', { class: 'dong-tick', for: p + 'bb' }, bb, laBang ? 'Bắt buộc có ít nhất một dòng khi nộp' : 'Bắt buộc phải điền khi nộp')));
        }
        if (o.kieu === 'select') {
          var lc = h('textarea', { id: p + 'lc', rows: 4, value: (o.lua_chon || []).join('\n') });
          lc.addEventListener('input', function () { o.lua_chon = lc.value.split('\n'); danDirty(); });
          cot.push(h('div', { class: 'rong' }, h('label', { for: p + 'lc', text: 'Các lựa chọn (mỗi dòng một lựa chọn, tối thiểu 2)' }), lc));
        }
        if (o.kieu === 'number') {
          var mn = h('input', { type: 'number', step: 'any', id: p + 'min', value: o.min === undefined ? '' : String(o.min) });
          var mx = h('input', { type: 'number', step: 'any', id: p + 'max', value: o.max === undefined ? '' : String(o.max) });
          mn.addEventListener('input', function () { o.min = mn.value === '' ? undefined : Number(mn.value); danDirty(); });
          mx.addEventListener('input', function () { o.max = mx.value === '' ? undefined : Number(mx.value); danDirty(); });
          cot.push(h('div', null, h('label', { for: p + 'min', text: 'Giá trị nhỏ nhất (tùy chọn)' }), mn),
            h('div', null, h('label', { for: p + 'max', text: 'Giá trị lớn nhất (tùy chọn)' }), mx));
        }
        if (laBang) cot.push(cauHinhBang(o, p, i));
        if (laTongHop) cot.push(cauHinhTongHop(o, p));

        var nutLen = h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'data-o': i, 'data-act': 'len', disabled: i === 0, onclick: function () { doi(i, -1, 'len'); } }, '↑ Lên');
        var nutXuong = h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'data-o': i, 'data-act': 'xuong', disabled: i === model.truong.length - 1, onclick: function () { doi(i, 1, 'xuong'); } }, '↓ Xuống');
        // aria-label phải theo kịp nhãn đang gõ: nếu tính một lần lúc dựng, nút Xóa sẽ đọc tên CŨ
        // của ô ("Xóa 'Câu hỏi mới'") trong khi ô đã mang nhãn khác — dễ khiến người ta xóa nhầm.
        function datNhanNut() {
          var ten = tenO(o, i);
          nutLen.setAttribute('aria-label', 'Chuyển ' + ten + ' lên');
          nutXuong.setAttribute('aria-label', 'Chuyển ' + ten + ' xuống');
          nutXoa.setAttribute('aria-label', 'Xóa ' + ten);
        }
        var nutXoa = h('button', {
          type: 'button', class: 'btn btn-nguy btn-nho',
          onclick: function () {
            model.truong.splice(i, 1);
            // Ô tổng hợp không được trỏ vào một bảng đã bị xóa.
            if (o.kieu === 'bang') model.truong.forEach(function (x) { if (x.kieu === 'tong_hop') x.bang = (x.bang || []).filter(function (k) { return k !== o.key; }); });
            danDirty();
            var k = Math.min(i, model.truong.length - 1);
            veLai(model.truong.length ? '[data-o="' + k + '"][data-act="len"], [data-o="' + k + '"][data-act="xuong"]' : '#them-kieu');
          },
        }, 'Xóa ô');
        datNhanNut();
        return h('fieldset', { class: 'o-mau' + (laSection ? ' o-mau-tieu-de' : '') + (laBang || laTongHop ? ' o-mau-bang' : '') },
          h('legend', { text: 'Ô ' + (i + 1) }),
          h('div', { class: 'luoi-2' }, cot),
          h('div', { class: 'nhom-nut' }, nutLen, nutXuong, nutXoa));
      }

      function doi(i, huong, act) {
        var j = i + huong;
        var t = model.truong;
        var tam = t[i]; t[i] = t[j]; t[j] = tam;
        danDirty();
        // Ô vừa chuyển có thể nằm sát đầu/cuối nên nút vừa bấm bị vô hiệu: dự phòng bằng nút còn lại.
        var kia = act === 'len' ? 'xuong' : 'len';
        veLai('[data-o="' + j + '"][data-act="' + act + '"], [data-o="' + j + '"][data-act="' + kia + '"]');
      }

      function veLai(chonFocus) {
        ds.replaceChildren.apply(ds, model.truong.map(dungO));
        if (!chonFocus) return;
        var all = chonFocus.split(', ');
        for (var k = 0; k < all.length; k++) {
          var f = document.querySelector(all[k]);
          if (f && !f.disabled) { f.focus(); return; }
        }
      }

      var tenIn = h('input', { type: 'text', id: 'mau-ten', maxlength: 150, value: model.ten });
      tenIn.addEventListener('input', function () { model.ten = tenIn.value; danDirty(); });
      var moTaIn = h('textarea', { id: 'mau-mo-ta', rows: 2, maxlength: 1000, value: model.mo_ta });
      moTaIn.addEventListener('input', function () { model.mo_ta = moTaIn.value; danDirty(); });
      var themKieu = h('select', { id: 'them-kieu' }, Object.keys(KIEU_O).map(function (k) { return h('option', { value: k, text: KIEU_O[k] }); }));
      var themNut = h('button', { type: 'button', class: 'btn btn-phu', onclick: function () {
        var k = themKieu.value;
        var o = { key: khoaMoi(khoaO, 'o_'), kieu: k, nhan: k === 'section' ? 'Nhóm mới' : k === 'bang' ? 'Bảng mới' : k === 'tong_hop' ? 'Thống kê tự động' : 'Câu hỏi mới', bat_buoc: false };
        if (k === 'select') o.lua_chon = ['Lựa chọn 1', 'Lựa chọn 2'];
        if (k === 'bang') o.cot = [{ key: khoaMoi({}, 'c_'), kieu: 'text', nhan: 'Nội dung' }, { key: khoaMoi({}, 'c_'), kieu: 'number', nhan: 'Mức độ hoàn thành (%)', min: 0, max: 100, phan_tram: true }];
        if (k === 'tong_hop') { o.bang = []; delete o.bat_buoc; }
        model.truong.push(o);
        danDirty();
        veLai(null);
        var cuoi = ds.querySelectorAll('fieldset.o-mau');
        var in1 = cuoi[cuoi.length - 1].querySelector('input[type=text]');
        if (in1) { in1.focus(); in1.select(); }
      } }, '+ Thêm ô');

      var luu = h('button', { type: 'button', class: 'btn' }, moi ? 'Tạo biểu mẫu' : 'Lưu biểu mẫu');
      luu.addEventListener('click', function () {
        loiEl.hidden = true;
        luu.disabled = true;
        var body = { ten: model.ten, mo_ta: model.mo_ta, truong: model.truong };
        api(moi ? '/mau' : '/mau/' + id, { method: moi ? 'POST' : 'PUT', body: body })
          .then(function (kq) {
            dirty = false;
            if (moi) { thongBao('Đã tạo biểu mẫu.'); location.hash = '#/mau/' + kq.id; return; }
            thongBao(kq.da_doi_cau_truc ? 'Đã lưu — tạo phiên bản ' + kq.so_phien_ban + '. Các đợt đã giao giữ phiên bản cũ.' : 'Đã lưu (cấu trúc không đổi nên không tạo phiên bản mới).');
            return route();
          })
          .catch(function (e) {
            var dsLoi = (e.data && e.data.loi) || [e.message];
            loiEl.replaceChildren.apply(loiEl, [h('p', null, h('strong', { text: 'Chưa lưu được:' }))].concat(dsLoi.map(function (x) { return h('p', { text: '• ' + x }); })));
            loiEl.hidden = false;
            loiEl.scrollIntoView({ block: 'nearest' });
          })
          .then(function () { luu.disabled = false; });
      });

      var details = h('details', { class: 'xem-truoc' }, h('summary', { text: 'Xem trước biểu mẫu' }), xemTruoc);
      details.addEventListener('toggle', function () {
        if (!details.open) return;
        // Bản xem trước chỉ dựng từ các ô đã đặt nhãn, để ô đang soạn dở không làm vỡ hình.
        var sach = JSON.parse(JSON.stringify(model.truong)).filter(function (o) { return o.nhan && o.nhan.trim(); }).map(function (o) {
          if (o.lua_chon) o.lua_chon = o.lua_chon.filter(function (x) { return x.trim(); });
          if (o.cot) o.cot = o.cot.filter(function (c) { return c.nhan && c.nhan.trim(); }).map(function (c) { if (c.lua_chon) c.lua_chon = c.lua_chon.filter(function (x) { return x.trim(); }); return c; });
          return o;
        }).filter(function (o) { return o.kieu !== 'bang' || o.cot.length; });
        xemTruoc.replaceChildren(dungForm(sach, {}).el);
      });

      veLai(null);
      main.replaceChildren(
        h('div', { class: 'nhom-nut' }, h('a', { class: 'btn btn-phu btn-nho', href: '#/mau' }, '← Tất cả biểu mẫu')),
        tieuDe(moi ? 'Tạo biểu mẫu' : 'Sửa biểu mẫu', moi ? null : 'Phiên bản hiện tại: ' + m.so_phien_ban),
        h('div', { class: 'luu-y' }, h('p', null, h('strong', { text: 'Sửa biểu mẫu chỉ áp dụng cho đợt tạo SAU. ' }), 'Các đợt đã giao giữ nguyên phiên bản cũ nên báo cáo đã nộp luôn hiển thị đúng như lúc nộp.')),
        h('div', { class: 'truong' }, h('label', { for: 'mau-ten' }, 'Tên biểu mẫu ', h('span', { class: 'bat-buoc', 'aria-hidden': 'true', text: '*' })), tenIn),
        h('div', { class: 'truong' }, h('label', { for: 'mau-mo-ta', text: 'Mô tả (tùy chọn)' }), moTaIn),
        h('h3', { text: 'Các ô của biểu mẫu' }),
        ds,
        h('div', { class: 'them-o' }, h('label', { for: 'them-kieu', text: 'Thêm ô loại:' }), themKieu, themNut),
        details,
        loiEl,
        h('div', { class: 'nhom-nut' }, luu));
    });
  }

  // ══ QUẢN LÝ: phòng & phân quyền ═══════════════════════════════════════════
  function xoaPhong(p) {
    var gan = p.so_truong_phong ? ' ' + p.so_truong_phong + ' trưởng phòng đang gắn với phòng này sẽ không còn là trưởng phòng của phòng (tài khoản của họ không bị xóa).' : '';
    xacNhan('Xóa phòng?', 'Phòng "' + p.ten + '" sẽ bị xóa vĩnh viễn.' + gan + ' Không hoàn tác được.', 'Xóa phòng', true).then(function (ok) {
      if (!ok) return;
      api('/phong/' + p.id, { method: 'DELETE' }).then(function () { thongBao('Đã xóa phòng.'); return route(); }).catch(function (e) { thongBao(e.message, 'loi'); });
    });
  }

  function viewPhong() {
    return Promise.all([api('/phong'), api('/thanh-vien'), api('/loi-moi')]).then(function (r) {
      var phongs = r[0].phong;
      var tvs = r[1].thanh_vien;
      var loiMoi = r[2].loi_moi;
      var node = [tieuDe('Phòng & phân quyền', 'Danh mục các phòng nộp báo cáo, và ai là trưởng phòng, người quản lý module hoặc Viện trưởng.')];

      // — Phòng
      var ten = h('input', { type: 'text', id: 'p-ten', maxlength: 150 });
      var formThem = h('form', { novalidate: true },
        h('div', { class: 'truong' }, h('label', { for: 'p-ten', text: 'Tên phòng' }), ten),
        h('div', { class: 'nhom-nut' },
          h('button', { type: 'submit', class: 'btn' }, 'Thêm phòng'),
          h('button', { type: 'button', class: 'btn btn-phu', onclick: function () {
            api('/phong/nhap-tu-don-vi', { method: 'POST' }).then(function (k) {
              thongBao(k.them ? 'Đã nhập ' + k.them + ' phòng từ danh mục đơn vị (bỏ qua ' + k.bo_qua + ' phòng đã có).' : (k.ghi_chu || 'Không có phòng mới để nhập.'));
              return route();
            }).catch(function (e) { thongBao(e.message, 'loi'); });
          } }, 'Nhập từ danh mục đơn vị')));
      formThem.addEventListener('submit', function (e) {
        e.preventDefault();
        api('/phong', { method: 'POST', body: { ten: ten.value } })
          .then(function () { thongBao('Đã thêm phòng.'); return route(); })
          .catch(function (er) { thongBao(er.message, 'loi'); });
      });
      node.push(h('h3', { text: 'Các phòng' }),
        phongs.length ? h('div', { class: 'cuon-ngang' }, h('table', null,
          h('thead', null, h('tr', null, ['Phòng', 'Người phụ trách', 'Số đợt đã giao', 'Trạng thái', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
          h('tbody', null, phongs.map(function (p) {
            return h('tr', null,
              h('td', { text: p.ten }), h('td', { class: 'con-so', text: String(p.so_truong_phong) }), h('td', { class: 'con-so', text: String(p.so_dot) }),
              h('td', null, p.active ? h('span', { class: 'nhan nhan-mo', text: 'Đang dùng' }) : h('span', { class: 'nhan', text: 'Ngừng dùng' })),
              h('td', null, h('div', { class: 'nhom-nut' },
                h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'aria-label': 'Đổi tên ' + p.ten, onclick: function () { suaPhong(p); } }, 'Đổi tên'),
                h('button', { type: 'button', class: 'btn btn-phu btn-nho', onclick: function () {
                  api('/phong/' + p.id, { method: 'PUT', body: { active: !p.active } }).then(function () { return route(); }).catch(function (e) { thongBao(e.message, 'loi'); });
                } }, p.active ? 'Ngừng dùng' : 'Dùng lại'),
                // Chỉ phòng chưa từng được giao đợt nào mới xóa được (cột "Số đợt đã giao" = 0); phòng đã dùng thì Ngừng dùng.
                p.so_dot === 0 ? h('button', { type: 'button', class: 'btn btn-nguy btn-nho', 'aria-label': 'Xóa ' + p.ten, onclick: function () { xoaPhong(p); } }, 'Xóa') : null)));
          })))) : bangTrong('Chưa có phòng nào.'),
        h('h3', { text: 'Thêm phòng' }), formThem);

      // — Mời trưởng phòng bằng email
      var cdMoi = h('select', { id: 'moi-chuc-danh' }, Object.keys(CHUC_DANH).map(function (k) { return h('option', { value: k, text: CHUC_DANH[k] }); }));
      var emailMoi = h('input', { type: 'email', id: 'moi-email', placeholder: 'vd: nguyenvan@sci.edu.vn', autocomplete: 'off', spellcheck: 'false' });
      var phMoi = h('select', { id: 'moi-phong' }, phongs.filter(function (p) { return p.active; }).map(function (p) { return h('option', { value: String(p.id), text: p.ten }); }));
      var loiMoiEl = h('p', { class: 'loi-truong', role: 'alert', hidden: true });
      var formMoi = h('form', { novalidate: true },
        h('p', { class: 'tro-giup' }, 'Nhập email @sci.edu.vn của người được giao nộp báo cáo cho phòng (trưởng phòng, phó trưởng phòng, quyền trưởng phòng hoặc kế toán). Đã có tài khoản eoffice thì được gán ngay và nhận thư báo. Chưa có thì hệ thống gửi thư mời kèm hướng dẫn đăng ký và một mã nhận lời mời (hiệu lực 14 ngày): quyền chỉ được cấp khi họ đăng nhập bằng đúng email đó và nhập mã.'),
        h('div', { class: 'luoi-2' },
          h('div', { class: 'truong' }, h('label', { for: 'moi-email', text: 'Email người được mời' }), emailMoi),
          h('div', { class: 'truong' }, h('label', { for: 'moi-chuc-danh', text: 'Chức danh' }), cdMoi),
          h('div', { class: 'truong' }, h('label', { for: 'moi-phong', text: 'Thuộc phòng' }), phMoi)),
        loiMoiEl,
        h('div', { class: 'nhom-nut' }, h('button', { type: 'submit', class: 'btn' }, 'Gán hoặc gửi lời mời')));
      formMoi.addEventListener('submit', function (e) {
        e.preventDefault();
        loiMoiEl.hidden = true;
        if (!emailMoi.value.trim()) { loiMoiEl.textContent = 'Hãy nhập email.'; loiMoiEl.hidden = false; emailMoi.focus(); return; }
        api('/loi-moi', { method: 'POST', body: { email: emailMoi.value, phong_id: Number(phMoi.value), chuc_danh: cdMoi.value } }).then(function (k) {
          thongBao(k.ket_qua === 'da_gan'
            ? 'Đã gán ' + (k.fullname || 'người này') + ' làm ' + CHUC_DANH[cdMoi.value].toLowerCase() + ' (đã có tài khoản eoffice) và gửi thư báo.'
            : 'Email này chưa có tài khoản eoffice. Đã gửi thư mời kèm hướng dẫn đăng ký và mã nhận lời mời.');
          return route();
        }).catch(function (er) { loiMoiEl.textContent = er.message; loiMoiEl.hidden = false; emailMoi.focus(); });
      });
      node.push(h('h3', { text: 'Mời người phụ trách phòng bằng email' }), formMoi);

      if (loiMoi.length) {
        node.push(h('h3', { text: 'Lời mời đang chờ (' + loiMoi.length + ')' }),
          h('p', { class: 'mo', text: 'Các email này chưa có tài khoản eoffice, hoặc đã nhận thư nhưng chưa nhập mã.' }),
          h('div', { class: 'cuon-ngang' }, h('table', null,
            h('thead', null, h('tr', null, ['Email', 'Chức danh', 'Phòng', 'Mời bởi', 'Hết hạn', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
            h('tbody', null, loiMoi.map(function (l) {
              return h('tr', null,
                h('td', { text: l.email }), h('td', { text: CHUC_DANH[l.chuc_danh] || CHUC_DANH.truong_phong }), h('td', { class: 'ten-phong', text: l.phong_ten }), h('td', { text: l.nguoi_moi || '—' }),
                h('td', { class: 'con-so' }, fmtNgay(String(l.het_han).slice(0, 10)), l.het_han_roi ? [' ', h('span', { class: 'nhan nhan-chu-y', text: 'Đã hết hạn' })] : null),
                h('td', null, h('div', { class: 'nhom-nut' },
                  h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'aria-label': 'Gửi lại lời mời cho ' + l.email, onclick: function () {
                    api('/loi-moi/' + l.id + '/gui-lai', { method: 'POST', body: {} }).then(function () { thongBao('Đã gửi lại thư mời (mã cũ không còn dùng được).'); return route(); }).catch(function (e) { thongBao(e.message, 'loi'); });
                  } }, 'Gửi lại'),
                  h('button', { type: 'button', class: 'btn btn-nguy btn-nho', 'aria-label': 'Hủy lời mời cho ' + l.email, onclick: function () {
                    xacNhan('Hủy lời mời?', 'Mã trong thư đã gửi cho ' + l.email + ' sẽ không còn dùng được.', 'Hủy lời mời', true).then(function (ok) {
                      if (ok) api('/loi-moi/' + l.id, { method: 'DELETE' }).then(function () { thongBao('Đã hủy lời mời.'); return route(); }).catch(function (e) { thongBao(e.message, 'loi'); });
                    });
                  } }, 'Hủy'))));
            })))));
      }

      // — Thành viên
      node.push(h('h3', { text: 'Người được phân quyền' }));
      var vaiTroTen = { quan_ly: 'Người quản lý module', vien_truong: 'Viện trưởng', truong_phong: 'Trưởng phòng' };
      node.push(tvs.length ? h('div', { class: 'cuon-ngang' }, h('table', null,
        h('thead', null, h('tr', null, ['Người dùng', 'Vai trò', 'Phòng', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, tvs.map(function (t) {
          var khongGo = t.vai_tro !== 'truong_phong' && !me.la_admin;
          return h('tr', null,
            h('td', null, t.fullname || '(chưa có tên)', h('div', { class: 'mo', text: t.email })),
            h('td', { text: t.vai_tro === 'truong_phong' ? (CHUC_DANH[t.chuc_danh] || CHUC_DANH.truong_phong) : vaiTroTen[t.vai_tro] }), h('td', { text: t.phong_ten || '—' }),
            h('td', null, khongGo ? h('span', { class: 'mo', text: 'Chỉ quản trị viên gỡ được' }) : h('button', {
              type: 'button', class: 'btn btn-nguy btn-nho', 'aria-label': 'Gỡ vai trò của ' + (t.fullname || t.email),
              onclick: function () {
                xacNhan('Gỡ vai trò?', (t.fullname || t.email) + ' sẽ không còn quyền ' + (t.vai_tro === 'truong_phong' ? (CHUC_DANH[t.chuc_danh] || CHUC_DANH.truong_phong) : vaiTroTen[t.vai_tro]).toLowerCase() + (t.phong_ten ? ' của ' + t.phong_ten : '') + '.', 'Gỡ vai trò', true).then(function (ok) {
                  if (ok) api('/thanh-vien/' + t.id, { method: 'DELETE' }).then(function () { thongBao('Đã gỡ vai trò.'); return route(); }).catch(function (e) { thongBao(e.message, 'loi'); });
                });
              },
            }, 'Gỡ')));
        })))) : bangTrong('Chưa phân quyền cho ai.'));

      var q = h('input', { type: 'search', id: 'nd-q', placeholder: 'Gõ ít nhất 2 ký tự của tên hoặc email' });
      var chon = h('select', { id: 'nd-chon', disabled: true }, h('option', { value: '', text: '— Chưa tìm —' }));
      // Chức danh trong phòng (đều là vai trò truong_phong) rồi tới vai trò toàn module (chỉ admin cấp).
      var vt = h('select', { id: 'nd-vai-tro' }, Object.keys(CHUC_DANH).map(function (k) { return h('option', { value: k, text: CHUC_DANH[k] }); }), me.la_admin ? h('option', { value: 'quan_ly', text: 'Người quản lý module' }) : null, me.la_admin ? h('option', { value: 'vien_truong', text: 'Viện trưởng' }) : null);
      var ph = h('select', { id: 'nd-phong' }, phongs.filter(function (p) { return p.active; }).map(function (p) { return h('option', { value: String(p.id), text: p.ten }); }));
      var hangPhong = h('div', { class: 'truong' }, h('label', { for: 'nd-phong', text: 'Phòng' }), ph);
      vt.addEventListener('change', function () { hangPhong.hidden = !CHUC_DANH[vt.value]; });
      var tim = h('form', { class: 'truong', novalidate: true }, h('label', { for: 'nd-q', text: 'Tìm người dùng' }),
        h('p', { class: 'tro-giup', text: 'Dùng để gán vai trò Người quản lý / Viện trưởng (chỉ quản trị viên) hoặc chức danh trong phòng cho người ĐÃ CÓ tài khoản eoffice. Muốn mời người chưa có tài khoản, dùng mục "Mời người phụ trách phòng bằng email" ở trên.' }), q,
        h('div', { class: 'nhom-nut' }, h('button', { type: 'submit', class: 'btn btn-phu' }, 'Tìm')));
      tim.addEventListener('submit', function (e) {
        e.preventDefault();
        api('/nguoi-dung?q=' + encodeURIComponent(q.value)).then(function (k) {
          chon.replaceChildren.apply(chon, k.nguoi_dung.length
            ? k.nguoi_dung.map(function (u) { return h('option', { value: String(u.id), text: (u.fullname || '(chưa có tên)') + ' — ' + u.email }); })
            : [h('option', { value: '', text: 'Không tìm thấy' })]);
          chon.disabled = !k.nguoi_dung.length;
          thongBao(k.nguoi_dung.length ? 'Tìm thấy ' + k.nguoi_dung.length + ' người. Chọn một người trong ô bên dưới.' : 'Không tìm thấy người dùng nào.');
          if (k.nguoi_dung.length) chon.focus();
        }).catch(function (er) { thongBao(er.message, 'loi'); });
      });
      var them = h('form', { novalidate: true }, h('div', { class: 'truong' }, h('label', { for: 'nd-chon', text: 'Người được chọn' }), chon),
        h('div', { class: 'truong' }, h('label', { for: 'nd-vai-tro', text: 'Vai trò' }), vt), hangPhong,
        h('button', { type: 'submit', class: 'btn' }, 'Thêm phân quyền'));
      them.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!chon.value) { thongBao('Hãy tìm và chọn một người dùng trước.', 'loi'); q.focus(); return; }
        var laChucDanh = !!CHUC_DANH[vt.value];
        var body = { user_id: Number(chon.value), vai_tro: laChucDanh ? 'truong_phong' : vt.value };
        if (laChucDanh) { body.chuc_danh = vt.value; body.phong_id = Number(ph.value); }
        api('/thanh-vien', { method: 'POST', body: body }).then(function () { thongBao('Đã phân quyền.'); return route(); }).catch(function (er) { thongBao(er.message, 'loi'); });
      });
      node.push(h('h3', { text: 'Thêm phân quyền' }), tim, them);
      main.replaceChildren.apply(main, node);
    });
  }

  function suaPhong(p) {
    var ten = h('input', { type: 'text', id: 'sp-ten', maxlength: 150, value: p.ten });
    return moHop({
      tieuDe: 'Đổi tên phòng',
      than: h('div', { class: 'truong' }, h('label', { for: 'sp-ten', text: 'Tên phòng' }), ten),
      nutChinh: 'Lưu',
      khiGui: function () {
        return api('/phong/' + p.id, { method: 'PUT', body: { ten: ten.value } }).then(function () { thongBao('Đã đổi tên phòng.'); return route(); });
      },
    });
  }

  // ══ Định tuyến ═════════════════════════════════════════════════════════════
  function route() {
    if (!me) return Promise.resolve();
    var p = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    var ten = p[0] || (me.quan_ly ? (me.vien_truong && !me.quan_ly_module ? 'duyet' : 'dot') : 'cua-toi');
    var tham = p[1];
    var QUAN_LY = { dot: 1, mau: 1, phong: 1 };
    // Việc dọn dẹp của màn hình trước (gỡ phím tắt, bỏ lớp CSS riêng…) chạy mỗi khi đổi mục.
    donDep.splice(0).forEach(function (f) { try { f(); } catch (_) { /* dọn không được làm hỏng việc chuyển trang */ } });

    hashHienTai = location.hash;
    dirty = false;
    hienDai = ten === 'dot' || ten === 'mau' || ten === 'phong';
    veDaiViec();
    dungNav(ten === 'bao-cao' ? 'dot' : ten);
    main.replaceChildren(h('p', { class: 'tai', text: 'Đang tải…' }));

    var xong;
    if ((ten === 'duyet' && !me.vien_truong) || (QUAN_LY[ten] && !me.quan_ly) || ((ten === 'mau' || ten === 'phong') && !me.quan_ly_module)) {
      xong = Promise.resolve(main.replaceChildren(h('h2', { text: 'Không có quyền' }), h('div', { class: 'luu-y luu-y-do' }, h('p', { text: 'Mục này chỉ dành cho người quản lý module.' }))));
    } else if (ten === 'duyet') {
      xong = BCP.views.duyet ? BCP.views.duyet(p.slice(1)) : Promise.reject(new Error('Chưa tải được màn hình duyệt báo cáo. Hãy tải lại trang.'));
    } else if (ten === 'cua-toi') xong = viewCuaToi();
    else if (ten === 'bao-cao' && Number(tham) > 0) xong = viewBaoCao(Number(tham));
    else if (ten === 'dot') xong = tham && Number(tham) > 0 ? viewDot(Number(tham)) : viewDotList();
    else if (ten === 'mau') xong = tham ? viewMau(tham === 'moi' ? 'moi' : Number(tham)) : viewMauList();
    else if (ten === 'phong') xong = viewPhong();
    else { location.hash = me.quan_ly ? (me.vien_truong && !me.quan_ly_module ? '#/duyet' : '#/dot') : '#/cua-toi'; return Promise.resolve(); }

    // Danh sách đợt tự nạp tổng quan; các màn khác nạp nền để số đếm trên thanh điều hướng luôn mới.
    if (!(ten === 'dot' && !tham)) capNhatTongQuan();
    capNhatViec();
    return xong.catch(hienLoiTrang).then(function () {
      var h2 = main.querySelector('h2');
      document.title = (h2 ? h2.textContent + ' — ' : '') + 'Báo cáo phòng ban - STIMS';
      if (h2) { h2.tabIndex = -1; h2.focus({ preventScroll: true }); window.scrollTo(0, 0); }
    });
  }

  window.addEventListener('hashchange', function () {
    if (khoiPhucHash) { khoiPhucHash = false; return; }
    if (dirty && !window.confirm('Bạn có thay đổi chưa lưu. Rời trang này?')) {
      khoiPhucHash = true;
      location.hash = hashHienTai;
      return;
    }
    route();
  });
  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ── Giao diện dùng chung cho tệp baoCaoPhongDuyet.js (màn hình duyệt của Viện trưởng) ─────────────────────
  // Màn hình duyệt nằm ở tệp riêng để tệp này không phình thêm; nó dùng lại các hàm dựng ở đây qua window.BCP và tự đăng ký vào BCP.views.
  BCP = window.BCP = {
    h: h, api: api, thongBao: thongBao, fmtNgay: fmtNgay, fmtGio: fmtGio, conLaiNgay: conLaiNgay, nhan: nhan, nhanTreHan: nhanTreHan,
    TT_BAO_CAO: TT_BAO_CAO, TT_VT: TT_VT, TT_DOT: TT_DOT, CHUC_DANH: CHUC_DANH, LOAI_DOT: LOAI_DOT, HANH_DONG: HANH_DONG, donVi: donVi,
    dungXemLai: dungXemLai, xacNhan: xacNhan, main: main, live: live,
    me: function () { return me; },
    route: function () { return route(); },
    lamMoiTongQuan: function () { return lamMoiTongQuan(); },
    /** Đặt hash mà KHÔNG chạy lại route (chuyển giữa các báo cáo trong màn hình duyệt không cần tải lại gì). */
    datHash: function (hash) { try { history.replaceState(null, '', hash); hashHienTai = hash; } catch (_) { /* trình duyệt cũ: bỏ qua, URL không đổi */ } },
    /** Đăng ký việc dọn dẹp, chạy một lần khi người dùng rời màn hình hiện tại. */
    khiRoiTrang: function (f) { donDep.push(f); },
    views: {},
  };

  // ── Khởi động ─────────────────────────────────────────────────────────────
  api('/me').then(function (r) {
    me = r;
    if (!me.co_quyen) {
      nav.replaceChildren();
      var maSan = '';
      try { maSan = new URLSearchParams(location.search).get('moi') || ''; } catch (_) { /* trình duyệt cũ: bỏ qua */ }
      var inpMa = h('input', { type: 'text', id: 'ma-loi-moi', maxlength: 64, autocomplete: 'off', spellcheck: 'false', value: maSan });
      var loiMa = h('p', { class: 'loi-truong', role: 'alert', hidden: true });
      var formMa = h('form', { novalidate: true },
        h('div', { class: 'truong' },
          h('label', { for: 'ma-loi-moi', text: 'Mã lời mời (32 ký tự trong email mời)' }),
          h('p', { class: 'tro-giup', text: 'Chỉ dùng được khi bạn đăng nhập bằng ĐÚNG địa chỉ email đã nhận thư mời.' }), inpMa, loiMa),
        h('button', { type: 'submit', class: 'btn' }, 'Nhận lời mời'));
      function nhanMa() {
        loiMa.hidden = true;
        return api('/loi-moi/nhan', { method: 'POST', body: { ma: inpMa.value } }).then(function (k) {
          thongBao('Đã nhận lời mời: bạn là ' + (CHUC_DANH[k.chuc_danh] || CHUC_DANH.truong_phong).toLowerCase() + ' — ' + k.phong.ten + '.');
          try { history.replaceState(null, '', location.pathname + '#/cua-toi'); } catch (_) { location.hash = '#/cua-toi'; }
          return api('/me').then(function (m) { me = m; return route(); });
        }).catch(function (er) { loiMa.textContent = er.message; loiMa.hidden = false; inpMa.focus(); });
      }
      formMa.addEventListener('submit', function (e) { e.preventDefault(); nhanMa(); });
      main.replaceChildren(
        h('h2', { text: 'Bạn chưa được cấp quyền' }),
        h('div', { class: 'luu-y' }, h('p', { text: 'Tài khoản của bạn chưa được phân quyền sử dụng module Báo cáo phòng ban. Vui lòng liên hệ Trưởng phòng Tổ chức Hành chính hoặc quản trị viên hệ thống để được cấp quyền.' })),
        h('h3', { text: 'Có thư mời?' }),
        h('p', { class: 'phu', text: 'Nếu bạn nhận được email mời vào module, nhập mã trong thư vào đây.' }),
        formMa);
      if (maSan) nhanMa(); // mở bằng liên kết trong thư: thử nhận luôn, khỏi bắt gõ lại
      return;
    }
    return route();
  }).catch(hienLoiTrang);
})();
