/*
 * Chọn vị trí khung chữ ký số trên PDF: người ký xem trước PDF thật, KÉO khung để dời, KÉO GÓC để co giãn, đổi trang bằng nút.
 * Dùng pdf.js (phục vụ nội bộ ở /public/vendor/pdfjs/, CSP không cho script ngoài). Dùng chung cho mọi nơi ký số trong hệ thống.
 *
 *   KySoViTri.dat({ tieuDe, tai: [{ ten, tai: () => Promise<{pdf:ArrayBuffer, meta}> }, ...] })
 *      → Promise<{viTri:[{trang, x, y, w, h}, ...], khung:{ho_ten, to_chuc, so_seri, thoi_gian, ly_do, noi_ky, hinh}|null} | null>   (null = người dùng hủy)
 *   KySoViTri.taiTuUrl(url) → hàm tải {pdf, meta} từ một đường dẫn trả PDF kèm header X-Ky-So-Meta.
 *
 * meta (do máy chủ trả): {so_trang, kho:[rộng,cao], mac_dinh:{trang,x,y,w,h}|null, gan_nhat:{trang,trang_cuoi,x,y,w,h}|null,
 *   khung:{tuy_chon, co_hinh, thong_tin:{ho_ten,to_chuc,so_seri,ly_do,noi_ky}, truong:[{khoa,nhan}], tieu_de, dong_cuoi}|null}.
 * khung (nếu có): bảng "Nội dung trong khung chữ ký" cho người ký bật/tắt từng dòng và tải hình chữ ký tay; khung trên trang hiện đúng
 * các dòng sẽ in vào PDF (cùng công thức với services/mysign/khungKy.js) và tự cao thêm khi bật thêm dòng.
 * x, y, w, h là TỈ LỆ (0..1) so với khổ trang, gốc ở góc trên-trái; trang tính từ 0 — đúng quy ước của máy chủ.
 * Nhiều tài liệu thì đặt lần lượt từng tài liệu; khung mở sẵn ở vị trí vừa đặt cho tài liệu trước (hoặc lần ký gần nhất).
 *
 * Bàn phím (khung đang được chọn): mũi tên = dời, Shift + mũi tên = co giãn. Cảm ứng và chuột đều dùng được (pointer events).
 * Mọi chữ hiển thị dựng bằng DOM + textContent.
 */
(function () {
  'use strict';

  var PDFJS = null;
  var RONG_TOI_THIEU = 0.1; // khớp quy tắc của máy chủ (routes/baoCaoPhongKySo.js)
  var CAO_TOI_THIEU = 0.04;
  var BUOC = 0.005;
  var CO_TOI_THIEU_PT = 5; // cỡ chữ tối thiểu khi tính chiều cao khung (máy chủ cho phép tới 4,5 nên luôn còn dư)
  var GIAN_DONG = 1.4;
  var CO_TOI_DA_PT = 8.5;
  var KHO_MAC_DINH = [595.28, 841.89];
  var TOI_DA_HINH = 1024 * 1024;
  var TOI_DA_CHO = 4; // khớp services/mysign/viTri.js
  var GOI_Y = 'Kéo khung để dời; kéo bốn góc để co giãn.';
  var GOI_Y_NHIEU = 'Chỗ 1 mang chữ ký số; các chỗ khác hiện cùng nội dung.';

  function napPdfJs() {
    if (PDFJS) return Promise.resolve(PDFJS);
    return import('/public/vendor/pdfjs/pdf.min.mjs').then(function (m) {
      m.GlobalWorkerOptions.workerSrc = '/public/vendor/pdfjs/pdf.worker.min.mjs';
      PDFJS = m;
      return m;
    });
  }

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
      if (c === null || c === undefined || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function taiTuUrl(url) {
    return function () {
      return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
        .catch(function () { throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'); })
        .then(function (res) {
          if (!res.ok) {
            return res.json().catch(function () { return null; }).then(function (d) { throw new Error((d && d.message) || 'Lỗi ' + res.status); });
          }
          var meta = {};
          try { meta = JSON.parse(res.headers.get('X-Ky-So-Meta') || '{}'); } catch (_) { /* thiếu meta: dùng giá trị mặc định */ }
          return res.arrayBuffer().then(function (pdf) { return { pdf: pdf, meta: meta }; });
        });
    };
  }

  /** Vị trí khung ban đầu cho một tài liệu: lần đặt trước trong phiên → lần ký gần nhất → mặc định của biểu mẫu → góc dưới phải trang cuối. */
  function viTriBanDau(meta, truoc) {
    var n = Math.max(1, meta.so_trang || 1);
    var v = truoc || meta.gan_nhat || meta.mac_dinh || null;
    if (!v) return { trang: n - 1, x: 0.5, y: 0.82, w: 0.42, h: 0.1 };
    var trang = v.trang_cuoi ? n - 1 : Math.min(Math.max(0, v.trang || 0), n - 1);
    return { trang: trang, x: v.x, y: v.y, w: v.w, h: v.h };
  }

  function chuanTrang(v, n) {
    var trang = v.trang_cuoi ? n - 1 : Math.min(Math.max(0, v.trang || 0), n - 1);
    return { trang: trang, x: v.x, y: v.y, w: v.w, h: v.h };
  }

  /** Danh sách chỗ ký ban đầu của một tài liệu: lần đặt trước trong phiên → lần ký gần nhất (kèm các chỗ sau) → mặc định. */
  function choBanDau(meta, truocDs) {
    var n = Math.max(1, meta.so_trang || 1);
    if (truocDs && truocDs.length) return truocDs.map(function (v) { return chuanTrang(v, n); });
    var gn = meta.gan_nhat;
    if (gn) return [gn].concat(Array.isArray(gn.them) ? gn.them : []).slice(0, TOI_DA_CHO).map(function (v) { return chuanTrang(v, n); });
    return [viTriBanDau(meta, null)];
  }

  function dat(opt) {
    var tai = opt.tai;
    return new Promise(function (resolve) {
      var ketQua = [];
      var buoc = 0;
      var tk = null; // trạng thái tài liệu đang đặt: {pdfDoc, meta, so_trang, rect:{trang,x,y,w,h}}
      var veLan = 0;

      var tieuDe = h('h2', { text: opt.tieuDe || 'Đặt khung chữ ký số', id: 'kyso-tieu-de' });
      var phuDe = h('p', { class: 'kyso-phu' });
      var loiEl = h('p', { class: 'loi-truong', role: 'alert', hidden: true });
      var nhanTrang = h('span', { class: 'kyso-nhan-trang', 'aria-live': 'polite' });
      var nutTruoc = h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'aria-label': 'Trang trước' }, '‹');
      var nutSau = h('button', { type: 'button', class: 'btn btn-phu btn-nho', 'aria-label': 'Trang sau' }, '›');
      var nutMacDinh = h('button', { type: 'button', class: 'btn btn-phu btn-nho' }, 'Đặt lại vị trí gợi ý');
      // Nhiều chỗ ký trong một văn bản: chỗ 1 mang chữ ký số thật, các chỗ sau là khung lặp lại cùng nội dung.
      var chuyenCho = h('div', { class: 'kyso-cho', role: 'group', 'aria-label': 'Các chỗ ký trong văn bản' });
      var goiY = h('span', { class: 'kyso-goi-y', text: GOI_Y });
      var canvas = h('canvas', { class: 'kyso-canvas' });
      var xemKhung = h('div', { class: 'kyso-xem', 'aria-hidden': 'true' });
      var khung = h('div', { class: 'kyso-khung', tabindex: '0', role: 'group', 'aria-label': 'Khung chữ ký số. Mũi tên để dời, Shift cùng mũi tên để co giãn.' },
        h('span', { class: 'kyso-khung-chu', 'aria-hidden': 'true', text: 'Chữ ký số' }), xemKhung);

      // Nội dung trong khung: dòng thông tin bật/tắt + hình chữ ký tay. Chỉ hiện khi máy chủ gửi meta.khung.
      var khungMeta = null; // meta.khung của tài liệu đầu tiên
      var tuyChon = null; // {ho_ten, to_chuc, so_seri, thoi_gian, ly_do, noi_ky, hinh}
      var coHinh = false;
      var hinhUrl = null;
      var bangNoiDung = h('details', { class: 'kyso-noidung', hidden: true });
      var luoiTruong = h('div', { class: 'kyso-truong' });
      var oHinh = h('input', { type: 'checkbox', id: 'kyso-hinh-bat' });
      var anhNho = h('img', { class: 'kyso-anh-nho', alt: 'Hình chữ ký đã tải lên', hidden: true });
      var oChonAnh = h('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'sr-only', id: 'kyso-hinh-tep', tabindex: '-1' });
      var nutAnh = h('button', { type: 'button', class: 'btn btn-phu btn-nho' }, 'Tải ảnh chữ ký…');
      var nutXoaAnh = h('button', { type: 'button', class: 'btn btn-phu btn-nho', hidden: true }, 'Xóa ảnh');
      var tomTat = h('span', { class: 'kyso-noidung-tom' });
      ['nw', 'ne', 'sw', 'se'].forEach(function (g) { khung.append(h('span', { class: 'kyso-goc kyso-goc-' + g, 'data-g': g, 'aria-hidden': 'true' })); });
      var trang = h('div', { class: 'kyso-trang' }, canvas, khung);
      var vung = h('div', { class: 'kyso-vung' }, trang);
      var dangTai = h('p', { class: 'kyso-tai', role: 'status', text: 'Đang tải bản xem trước…' });
      var nutHuy = h('button', { type: 'button', class: 'btn btn-phu' }, 'Hủy');
      // Nút × ở góc trên: luôn thấy dù màn hình thấp và thanh nút phía dưới bị đẩy khuất.
      var nutDong = h('button', { type: 'button', class: 'kyso-nut-dong', 'aria-label': 'Đóng, không ký', title: 'Đóng (Esc)' }, '×');
      var nutLui = h('button', { type: 'button', class: 'btn btn-phu' }, '‹ Báo cáo trước');
      var nutTiep = h('button', { type: 'button', class: 'btn' }, 'Tiếp tục');
      var hop = h('dialog', { class: 'kyso-hop', 'aria-labelledby': 'kyso-tieu-de' },
        h('div', { class: 'kyso-dau' }, tieuDe, phuDe, nutDong),
        h('div', { class: 'kyso-thanh' },
          h('div', { class: 'kyso-chuyen' }, nutTruoc, nhanTrang, nutSau), chuyenCho, nutMacDinh, goiY),
        bangNoiDung, dangTai, vung, loiEl,
        h('div', { class: 'kyso-chan' }, nutHuy, nutLui, nutTiep));

      function dong(kq) {
        try { hop.close(); } catch (_) { /* đã đóng */ }
        hop.remove();
        if (hinhUrl) { try { URL.revokeObjectURL(hinhUrl); } catch (_) { /* bỏ qua */ } hinhUrl = null; }
        resolve(kq);
      }
      hop.addEventListener('cancel', function (e) { e.preventDefault(); dong(null); });
      nutHuy.addEventListener('click', function () { dong(null); });
      nutDong.addEventListener('click', function () { dong(null); });

      var chuKhung = khung.querySelector('.kyso-khung-chu');

      function khoTrang() { return (tk && tk.meta && tk.meta.kho) || KHO_MAC_DINH; }

      /**
       * Các dòng chữ sẽ in trong khung — cùng quy tắc với KhungKy.dungDong ở máy chủ. Mục chưa biết giá trị lúc xem trước (số seri,
       * tổ chức, thời gian) vẫn được tính một dòng để chiều cao tối thiểu không bị thiếu.
       */
      function dongKhung() {
        if (!khungMeta || !tuyChon) return null;
        var tt = khungMeta.thong_tin || {};
        var dong = [khungMeta.tieu_de];
        khungMeta.truong.forEach(function (t) {
          if (!tuyChon[t.khoa]) return;
          var v = t.khoa === 'thoi_gian' ? '(ghi lúc ký)' : String(tt[t.khoa] || '').trim() || '(theo chứng thư lúc ký)';
          dong.push(t.nhan + ': ' + v);
        });
        dong.push(khungMeta.dong_cuoi);
        return dong;
      }

      /** Chiều cao tối thiểu (tỉ lệ so với trang) để khung chứa đủ các dòng đã chọn. */
      function caoTT() {
        var d = dongKhung();
        if (!d) return CAO_TOI_THIEU;
        return Math.max(CAO_TOI_THIEU, (8 + d.length * GIAN_DONG * CO_TOI_THIEU_PT) / khoTrang()[1]);
      }

      /** Dựng lại chữ + hình bên trong khung (khi đổi lựa chọn). */
      function veNoiDung() {
        var d = dongKhung();
        chuKhung.hidden = !!d;
        xemKhung.hidden = !d;
        xemKhung.replaceChildren();
        if (!d) return;
        if (tuyChon.hinh && coHinh && hinhUrl) xemKhung.append(h('img', { class: 'kyso-hinh', src: hinhUrl, alt: '' }));
        var chu = h('div', { class: 'kyso-dong' });
        d.forEach(function (s, j) { chu.append(h('div', { class: j === 0 ? 'kyso-dong-dau' : null, text: s })); });
        xemKhung.append(chu);
        canhChuKhung();
      }

      /** Cỡ chữ trong khung theo chiều cao khung và độ phóng của trang (giống máy chủ: vừa chiều cao, tối đa 8,5 pt). */
      function canhChuKhung() {
        var d = dongKhung();
        if (!d || !tk) return;
        var scale = (parseFloat(trang.style.width) || trang.getBoundingClientRect().width || khoTrang()[0]) / khoTrang()[0];
        var hpt = tk.rect.h * khoTrang()[1];
        var co = Math.max(4.5, Math.min(CO_TOI_DA_PT, (hpt - 8) / (d.length * GIAN_DONG)));
        xemKhung.style.fontSize = co * scale + 'px';
      }

      function datKhung() {
        var r = tk.rect;
        khung.style.left = r.x * 100 + '%';
        khung.style.top = r.y * 100 + '%';
        khung.style.width = r.w * 100 + '%';
        khung.style.height = r.h * 100 + '%';
        canhChuKhung();
      }

      // ── Nhiều chỗ ký ───────────────────────────────────────────────────────
      /** Các chỗ ký KHÁC trên trang đang xem: ô mờ, bấm vào để chọn chỗ đó. */
      function veChoKhac() {
        Array.prototype.slice.call(trang.querySelectorAll('.kyso-khung-phu')).forEach(function (e) { e.remove(); });
        if (!tk) return;
        tk.chos.forEach(function (r, i) {
          if (i === tk.chon || r.trang !== tk.rect.trang) return;
          var o = h('button', { type: 'button', class: 'kyso-khung-phu', 'aria-label': 'Chọn chỗ ký ' + (i + 1), text: 'Chỗ ' + (i + 1) });
          o.style.left = r.x * 100 + '%';
          o.style.top = r.y * 100 + '%';
          o.style.width = r.w * 100 + '%';
          o.style.height = r.h * 100 + '%';
          o.addEventListener('click', function () { chonCho(i); });
          trang.insertBefore(o, khung);
        });
      }

      function veThanhCho() {
        chuyenCho.replaceChildren();
        if (!tk) return;
        chuyenCho.append(h('span', { class: 'kyso-cho-nhan', text: 'Chỗ ký' }));
        tk.chos.forEach(function (r, i) {
          var b = h('button', { type: 'button', class: 'btn btn-phu btn-nho kyso-cho-so', 'aria-pressed': i === tk.chon ? 'true' : 'false', 'aria-label': 'Chỗ ký ' + (i + 1) + (i === 0 ? ' (mang chữ ký số)' : ''), text: String(i + 1) });
          b.addEventListener('click', function () { chonCho(i); });
          chuyenCho.append(b);
        });
        if (tk.chos.length < TOI_DA_CHO) {
          var them = h('button', { type: 'button', class: 'btn btn-phu btn-nho', title: 'Thêm một chỗ ký nữa trong văn bản (cùng một chữ ký số)' }, '+ Thêm');
          them.addEventListener('click', themCho);
          chuyenCho.append(them);
        }
        if (tk.chos.length > 1) {
          var xoa = h('button', { type: 'button', class: 'btn btn-phu btn-nho', title: 'Bỏ chỗ ký đang chọn' }, 'Bỏ chỗ này');
          xoa.addEventListener('click', xoaCho);
          chuyenCho.append(xoa);
        }
        goiY.textContent = tk.chos.length > 1 ? GOI_Y_NHIEU : GOI_Y;
      }

      function chonCho(i) {
        if (!tk || i < 0 || i >= tk.chos.length) return;
        tk.chon = i;
        tk.rect = tk.chos[i];
        veThanhCho();
        veTrang().then(function () { khung.focus({ preventScroll: true }); }).catch(baoLoi);
      }

      function themCho() {
        if (!tk || tk.chos.length >= TOI_DA_CHO) return;
        var r = tk.rect;
        // Chỗ mới cùng cỡ, nằm ngay phía trên chỗ đang chọn (hết chỗ thì ngay phía dưới); người ký kéo tới nơi cần.
        var y = r.y - r.h - 0.03;
        if (y < 0) y = Math.min(r.y + r.h + 0.03, 1 - r.h);
        var moi = { trang: r.trang, x: r.x, y: Math.max(0, y), w: r.w, h: r.h };
        tk.chos.push(moi);
        chonCho(tk.chos.length - 1);
      }

      function xoaCho() {
        if (!tk || tk.chos.length <= 1) return;
        tk.chos.splice(tk.chon, 1);
        chonCho(Math.max(0, tk.chon - 1));
      }

      function capNhatNhanTrang() {
        nhanTrang.textContent = 'Trang ' + (tk.rect.trang + 1) + '/' + tk.so_trang;
        nutTruoc.disabled = tk.rect.trang <= 0;
        nutSau.disabled = tk.rect.trang >= tk.so_trang - 1;
      }

      function veTrang() {
        var lan = ++veLan;
        capNhatNhanTrang();
        return tk.pdfDoc.getPage(tk.rect.trang + 1).then(function (p) {
          if (lan !== veLan) return null;
          var goc = p.getViewport({ scale: 1 });
          var rong = Math.min(Math.max(vung.clientWidth - 2, 240), 760);
          var tiLe = rong / goc.width;
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          var vp = p.getViewport({ scale: tiLe * dpr });
          canvas.width = Math.floor(vp.width);
          canvas.height = Math.floor(vp.height);
          trang.style.width = Math.floor(goc.width * tiLe) + 'px';
          trang.style.height = Math.floor(goc.height * tiLe) + 'px';
          return p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () { if (lan === veLan) { datKhung(); veChoKhac(); } });
        });
      }

      function gioiHan(rect) {
        var r = rect || tk.rect;
        r.w = Math.min(Math.max(r.w, RONG_TOI_THIEU), 1);
        r.h = Math.min(Math.max(r.h, caoTT()), 1);
        r.x = Math.min(Math.max(r.x, 0), 1 - r.w);
        r.y = Math.min(Math.max(r.y, 0), 1 - r.h);
      }

      // ── Kéo / co giãn bằng chuột và cảm ứng ────────────────────────────────
      var keo = null;
      khung.addEventListener('pointerdown', function (e) {
        if (!tk) return;
        e.preventDefault();
        khung.focus({ preventScroll: true });
        var g = e.target && e.target.getAttribute && e.target.getAttribute('data-g');
        keo = { g: g || 'move', x0: e.clientX, y0: e.clientY, r0: { x: tk.rect.x, y: tk.rect.y, w: tk.rect.w, h: tk.rect.h }, rect: trang.getBoundingClientRect() };
        try { khung.setPointerCapture(e.pointerId); } catch (_) { /* trình duyệt cũ */ }
      });
      khung.addEventListener('pointermove', function (e) {
        if (!keo) return;
        var dx = (e.clientX - keo.x0) / keo.rect.width;
        var dy = (e.clientY - keo.y0) / keo.rect.height;
        var r0 = keo.r0;
        var r = tk.rect;
        if (keo.g === 'move') { r.x = r0.x + dx; r.y = r0.y + dy; r.w = r0.w; r.h = r0.h; }
        else {
          var x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
          if (keo.g.indexOf('w') >= 0) x1 = Math.min(Math.max(r0.x + dx, 0), x2 - RONG_TOI_THIEU);
          if (keo.g.indexOf('e') >= 0) x2 = Math.max(Math.min(x2 + dx, 1), x1 + RONG_TOI_THIEU);
          if (keo.g.indexOf('n') >= 0) y1 = Math.min(Math.max(r0.y + dy, 0), y2 - caoTT());
          if (keo.g.indexOf('s') >= 0) y2 = Math.max(Math.min(y2 + dy, 1), y1 + caoTT());
          r.x = x1; r.y = y1; r.w = x2 - x1; r.h = y2 - y1;
        }
        gioiHan();
        datKhung();
      });
      function thoiKeo() { keo = null; }
      khung.addEventListener('pointerup', thoiKeo);
      khung.addEventListener('pointercancel', thoiKeo);

      // ── Bàn phím ───────────────────────────────────────────────────────────
      khung.addEventListener('keydown', function (e) {
        if (!tk) return;
        var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (!d) return;
        e.preventDefault();
        var r = tk.rect;
        var b = BUOC * (e.altKey ? 4 : 1);
        if (e.shiftKey) { r.w += d[0] * b; r.h += d[1] * b; } else { r.x += d[0] * b; r.y += d[1] * b; }
        gioiHan();
        datKhung();
      });

      function baoLoi(e) {
        loiEl.textContent = (e && e.message) || 'Không hiển thị được bản xem trước.';
        loiEl.hidden = false;
      }

      nutTruoc.addEventListener('click', function () { if (tk.rect.trang > 0) { tk.rect.trang--; veTrang().catch(baoLoi); } });
      nutSau.addEventListener('click', function () { if (tk.rect.trang < tk.so_trang - 1) { tk.rect.trang++; veTrang().catch(baoLoi); } });
      nutMacDinh.addEventListener('click', function () {
        var m = tk.meta.mac_dinh;
        // Về vị trí gợi ý: một chỗ ký duy nhất ở vị trí mặc định của biểu mẫu.
        tk.chos = [m ? { trang: Math.min(m.trang, tk.so_trang - 1), x: m.x, y: m.y, w: m.w, h: m.h } : viTriBanDau({ so_trang: tk.so_trang }, null)];
        tk.chon = 0;
        tk.rect = tk.chos[0];
        gioiHan();
        veThanhCho();
        veTrang().catch(baoLoi);
      });

      // ── Bảng "Nội dung trong khung chữ ký" ─────────────────────────────────
      function capNhatTom() {
        var d = dongKhung();
        tomTat.textContent = d ? '· ' + d.length + ' dòng' + (tuyChon.hinh && coHinh ? ', có hình chữ ký' : '') : '';
      }

      function capNhatHinh() {
        oHinh.disabled = !coHinh;
        oHinh.checked = !!tuyChon.hinh && coHinh;
        anhNho.hidden = !(coHinh && hinhUrl);
        if (hinhUrl) anhNho.src = hinhUrl;
        nutXoaAnh.hidden = !coHinh;
        nutAnh.textContent = coHinh ? 'Thay ảnh…' : 'Tải ảnh chữ ký…';
        capNhatTom();
      }

      function doiNoiDung() {
        veNoiDung();
        capNhatTom();
        // Bật thêm dòng thì MỌI chỗ ký phải đủ cao cho các dòng đó.
        if (tk) { tk.chos.forEach(function (r) { gioiHan(r); }); datKhung(); veChoKhac(); }
      }

      /** Tải hình chữ ký của chính mình về dạng blob để hiện trong khung (cần đăng nhập nên không dùng thẳng src). */
      function taiAnh() {
        return fetch('/api/mysign/hinh-ky', { credentials: 'same-origin', cache: 'no-store' })
          .then(function (res) { return res.ok ? res.blob() : null; })
          .then(function (b) {
            if (hinhUrl) { URL.revokeObjectURL(hinhUrl); hinhUrl = null; }
            if (b) hinhUrl = URL.createObjectURL(b);
          })
          .catch(function () { /* không tải được hình: vẫn ký được, chỉ không xem trước hình */ });
      }

      function dungBang(km) {
        khungMeta = km;
        tuyChon = Object.assign({ hinh: true }, km.tuy_chon || {});
        coHinh = !!km.co_hinh;
        luoiTruong.replaceChildren();
        km.truong.forEach(function (t) {
          var id = 'kyso-t-' + t.khoa;
          var o = h('input', { type: 'checkbox', id: id });
          o.checked = !!tuyChon[t.khoa];
          o.addEventListener('change', function () { tuyChon[t.khoa] = o.checked; doiNoiDung(); });
          luoiTruong.append(h('label', { class: 'kyso-chon', for: id }, o, ' ' + t.nhan));
        });
        oHinh.addEventListener('change', function () { tuyChon.hinh = oHinh.checked; doiNoiDung(); });
        nutAnh.addEventListener('click', function () { oChonAnh.click(); });
        oChonAnh.addEventListener('change', function () {
          var f = oChonAnh.files && oChonAnh.files[0];
          oChonAnh.value = '';
          if (!f) return;
          if (!/^image\/(png|jpeg)$/.test(f.type)) { baoLoi(new Error('Chỉ nhận ảnh PNG hoặc JPEG.')); return; }
          if (f.size > TOI_DA_HINH) { baoLoi(new Error('Ảnh quá lớn. Tối đa 1 MB.')); return; }
          loiEl.hidden = true;
          nutAnh.disabled = true;
          fetch('/api/mysign/hinh-ky', { method: 'POST', headers: { 'Content-Type': f.type }, body: f, credentials: 'same-origin' })
            .catch(function () { throw new Error('Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.'); })
            .then(function (res) {
              return res.json().catch(function () { return null; }).then(function (d) { if (!res.ok) throw new Error((d && d.message) || 'Lỗi ' + res.status); });
            })
            .then(function () { coHinh = true; tuyChon.hinh = true; return taiAnh(); })
            .then(function () { capNhatHinh(); doiNoiDung(); })
            .catch(baoLoi)
            .then(function () { nutAnh.disabled = false; });
        });
        nutXoaAnh.addEventListener('click', function () {
          nutXoaAnh.disabled = true;
          fetch('/api/mysign/hinh-ky', { method: 'DELETE', credentials: 'same-origin' })
            .then(function (res) { if (!res.ok) throw new Error('Không xóa được ảnh. Vui lòng thử lại.'); })
            .then(function () {
              coHinh = false;
              if (hinhUrl) { URL.revokeObjectURL(hinhUrl); hinhUrl = null; }
              capNhatHinh();
              doiNoiDung();
            })
            .catch(baoLoi)
            .then(function () { nutXoaAnh.disabled = false; });
        });
        nutAnh.title = 'Ảnh PNG nền trong suốt cho đẹp nhất, tối đa 1 MB. Ảnh chỉ của riêng bạn và dùng cho mọi lần ký.';
        bangNoiDung.replaceChildren(
          h('summary', { title: 'Chọn thông tin hiện trong khung chữ ký. Khung tự cao thêm khi bật thêm dòng.' }, 'Nội dung khung chữ ký ', tomTat),
          // Một hàng gọn: các ô chọn + hình chữ ký nằm cùng dòng, tự xuống dòng khi hết chỗ.
          h('div', { class: 'kyso-noidung-than' },
            luoiTruong,
            h('div', { class: 'kyso-hinh-hang' },
              h('label', { class: 'kyso-chon', for: 'kyso-hinh-bat' }, oHinh, ' Hình chữ ký'),
              anhNho, nutAnh, nutXoaAnh, oChonAnh)));
        bangNoiDung.hidden = false;
        capNhatHinh();
      }

      function luuBuoc() {
        if (!tk) return;
        tk.chos.forEach(function (r) { gioiHan(r); });
        ketQua[buoc] = { chos: tk.chos.map(function (r) { return { trang: r.trang, x: r.x, y: r.y, w: r.w, h: r.h }; }), soTrang: tk.so_trang };
      }

      /** Nạp tài liệu thứ i, đặt khung ở vị trí ban đầu rồi vẽ. */
      function nap(i) {
        buoc = i;
        tk = null;
        veThanhCho();
        loiEl.hidden = true;
        dangTai.hidden = false;
        vung.hidden = true;
        [nutTiep, nutTruoc, nutSau, nutMacDinh].forEach(function (b) { b.disabled = true; });
        nutLui.hidden = i === 0;
        var n = tai.length;
        phuDe.textContent = (n > 1 ? 'Báo cáo ' + (i + 1) + '/' + n + ' — ' : '') + (tai[i].ten || '');
        nutTiep.textContent = i < n - 1 ? 'Tiếp tục ›' : n > 1 ? 'Gửi yêu cầu ký (' + n + ' báo cáo)' : 'Gửi yêu cầu ký';
        return Promise.all([napPdfJs(), tai[i].tai()]).then(function (kq) {
          var tl = kq[1];
          return kq[0].getDocument({ data: new Uint8Array(tl.pdf.slice(0)) }).promise.then(function (pdfDoc) {
            var soTrang = pdfDoc.numPages;
            var meta = tl.meta || {};
            meta.so_trang = soTrang;
            // Khởi tạo các chỗ ký: đã đặt rồi (quay lại tài liệu này) → theo tài liệu trước trong phiên → lần ký gần nhất → mặc định.
            var p = i > 0 ? ketQua[i - 1] : null;
            var truocDs = p ? p.chos.map(function (v) { return { trang: v.trang, trang_cuoi: v.trang === p.soTrang - 1, x: v.x, y: v.y, w: v.w, h: v.h }; }) : null;
            var c = ketQua[i];
            var chos = c ? c.chos.map(function (v) { return chuanTrang(v, soTrang); }) : choBanDau(meta, truocDs);
            tk = { pdfDoc: pdfDoc, meta: meta, so_trang: soTrang, chos: chos, chon: 0, rect: chos[0] };
            if (meta.khung && !khungMeta) dungBang(meta.khung);
            var xongAnh = khungMeta && coHinh && !hinhUrl ? taiAnh() : Promise.resolve();
            return xongAnh.then(function () {
              if (khungMeta) { capNhatHinh(); veNoiDung(); }
              tk.chos.forEach(function (r) { gioiHan(r); });
              veThanhCho();
              dangTai.hidden = true;
              vung.hidden = false;
              [nutTiep, nutMacDinh].forEach(function (b) { b.disabled = false; });
              return veTrang().then(function () { khung.focus({ preventScroll: true }); });
            });
          });
        }).catch(function (e) {
          dangTai.hidden = true;
          baoLoi(e);
          nutTiep.disabled = true;
        });
      }

      nutLui.addEventListener('click', function () { luuBuoc(); if (buoc > 0) nap(buoc - 1); });
      nutTiep.addEventListener('click', function () {
        if (!tk) return;
        luuBuoc();
        if (buoc < tai.length - 1) { nap(buoc + 1); return; }
        dong({
          viTri: ketQua.map(function (r) { return r.chos; }), // mỗi tài liệu: mảng 1..4 chỗ ký
          khung: tuyChon ? Object.assign({}, tuyChon) : null,
        });
      });

      // Đổi cỡ cửa sổ (xoay điện thoại, kéo giãn trình duyệt): vẽ lại trang theo bề rộng mới để khung và chữ trong khung khớp bản PDF.
      var heHen = null;
      function khiDoiCo() {
        clearTimeout(heHen);
        heHen = setTimeout(function () { if (tk) veTrang().catch(baoLoi); }, 200);
      }
      window.addEventListener('resize', khiDoiCo);
      hop.addEventListener('close', function () { window.removeEventListener('resize', khiDoiCo); clearTimeout(heHen); });

      document.body.append(hop);
      hop.showModal();
      nap(0);
    });
  }

  window.KySoViTri = { dat: dat, taiTuUrl: taiTuUrl };
})();
