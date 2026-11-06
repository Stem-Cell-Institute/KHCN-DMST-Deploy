/*
 * Chọn vị trí khung chữ ký số trên PDF: người ký xem trước PDF thật, KÉO khung để dời, KÉO GÓC để co giãn, đổi trang bằng nút.
 * Dùng pdf.js (phục vụ nội bộ ở /public/vendor/pdfjs/, CSP không cho script ngoài). Dùng chung cho mọi nơi ký số trong hệ thống.
 *
 *   KySoViTri.dat({ tieuDe, tai: [{ ten, tai: () => Promise<{pdf:ArrayBuffer, meta}> }, ...] })
 *      → Promise<[{trang, x, y, w, h}, ...] | null>   (null = người dùng hủy)
 *   KySoViTri.taiTuUrl(url) → hàm tải {pdf, meta} từ một đường dẫn trả PDF kèm header X-Ky-So-Meta.
 *
 * meta (do máy chủ trả): {so_trang, kho:[rộng,cao], mac_dinh:{trang,x,y,w,h}|null, gan_nhat:{trang,trang_cuoi,x,y,w,h}|null}.
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
      var canvas = h('canvas', { class: 'kyso-canvas' });
      var khung = h('div', { class: 'kyso-khung', tabindex: '0', role: 'group', 'aria-label': 'Khung chữ ký số. Mũi tên để dời, Shift cùng mũi tên để co giãn.' },
        h('span', { class: 'kyso-khung-chu', 'aria-hidden': 'true', text: 'Chữ ký số' }));
      ['nw', 'ne', 'sw', 'se'].forEach(function (g) { khung.append(h('span', { class: 'kyso-goc kyso-goc-' + g, 'data-g': g, 'aria-hidden': 'true' })); });
      var trang = h('div', { class: 'kyso-trang' }, canvas, khung);
      var vung = h('div', { class: 'kyso-vung' }, trang);
      var dangTai = h('p', { class: 'kyso-tai', role: 'status', text: 'Đang tải bản xem trước…' });
      var nutHuy = h('button', { type: 'button', class: 'btn btn-phu' }, 'Hủy');
      var nutLui = h('button', { type: 'button', class: 'btn btn-phu' }, '‹ Báo cáo trước');
      var nutTiep = h('button', { type: 'button', class: 'btn' }, 'Tiếp tục');
      var hop = h('dialog', { class: 'kyso-hop', 'aria-labelledby': 'kyso-tieu-de' },
        h('div', { class: 'kyso-dau' }, tieuDe, phuDe),
        h('div', { class: 'kyso-thanh' },
          h('div', { class: 'kyso-chuyen' }, nutTruoc, nhanTrang, nutSau), nutMacDinh,
          h('span', { class: 'kyso-goi-y', text: 'Kéo khung để dời; kéo bốn góc để co giãn.' })),
        dangTai, vung, loiEl,
        h('div', { class: 'kyso-chan' }, nutHuy, nutLui, nutTiep));

      function dong(kq) {
        try { hop.close(); } catch (_) { /* đã đóng */ }
        hop.remove();
        resolve(kq);
      }
      hop.addEventListener('cancel', function (e) { e.preventDefault(); dong(null); });
      nutHuy.addEventListener('click', function () { dong(null); });

      function datKhung() {
        var r = tk.rect;
        khung.style.left = r.x * 100 + '%';
        khung.style.top = r.y * 100 + '%';
        khung.style.width = r.w * 100 + '%';
        khung.style.height = r.h * 100 + '%';
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
          return p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise.then(function () { if (lan === veLan) datKhung(); });
        });
      }

      function gioiHan() {
        var r = tk.rect;
        r.w = Math.min(Math.max(r.w, RONG_TOI_THIEU), 1);
        r.h = Math.min(Math.max(r.h, CAO_TOI_THIEU), 1);
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
          if (keo.g.indexOf('n') >= 0) y1 = Math.min(Math.max(r0.y + dy, 0), y2 - CAO_TOI_THIEU);
          if (keo.g.indexOf('s') >= 0) y2 = Math.max(Math.min(y2 + dy, 1), y1 + CAO_TOI_THIEU);
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
        tk.rect = m ? { trang: Math.min(m.trang, tk.so_trang - 1), x: m.x, y: m.y, w: m.w, h: m.h } : viTriBanDau({ so_trang: tk.so_trang }, null);
        gioiHan();
        veTrang().catch(baoLoi);
      });

      function luuBuoc() {
        if (!tk) return;
        gioiHan();
        ketQua[buoc] = { trang: tk.rect.trang, x: tk.rect.x, y: tk.rect.y, w: tk.rect.w, h: tk.rect.h, soTrang: tk.so_trang };
      }

      /** Nạp tài liệu thứ i, đặt khung ở vị trí ban đầu rồi vẽ. */
      function nap(i) {
        buoc = i;
        tk = null;
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
            var p = i > 0 ? ketQua[i - 1] : null;
            var truoc = p ? { trang: p.trang, trang_cuoi: p.trang === p.soTrang - 1, x: p.x, y: p.y, w: p.w, h: p.h } : null;
            tk = { pdfDoc: pdfDoc, meta: meta, so_trang: soTrang, rect: viTriBanDau(meta, truoc) };
            var c = ketQua[i];
            if (c) tk.rect = { trang: Math.min(c.trang, soTrang - 1), x: c.x, y: c.y, w: c.w, h: c.h };
            gioiHan();
            dangTai.hidden = true;
            vung.hidden = false;
            [nutTiep, nutMacDinh].forEach(function (b) { b.disabled = false; });
            return veTrang().then(function () { khung.focus({ preventScroll: true }); });
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
        dong(ketQua.map(function (r) { return { trang: r.trang, x: r.x, y: r.y, w: r.w, h: r.h }; }));
      });

      document.body.append(hop);
      hop.showModal();
      nap(0);
    });
  }

  window.KySoViTri = { dat: dat, taiTuUrl: taiTuUrl };
})();
