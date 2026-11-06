/*
 * Sơ đồ thiết bị lưu trữ xuyên thấu (tủ đứng, tủ nằm ngang, tủ lạnh nhiều ngăn): các ngăn, Rack / giỏ / kệ / ngăn kéo và hộp theo đúng khai báo trong hệ thống,
 * chấm đỏ đánh dấu mục đang chọn (ngăn, Rack, hộp hoặc một ô ống trên lưới hộp). Cùng phong cách với binh-ln.js (bình nitơ lỏng).
 *
 * Ba kiểu vẽ:
 *   tu_dung  tủ đứng: các ngăn xếp từ trên xuống, mỗi ngăn có các kệ / ngăn kéo NẰM NGANG (kệ số 1 ở trên cùng)
 *   tu_lanh  như tu_dung nhưng ngăn đá phía trên thấp hơn ngăn mát phía dưới, tay cầm một bên
 *   tu_nam   tủ nằm ngang nhìn từ TRÊN: các cánh (nắp) xếp cạnh nhau, mỗi cánh có các giỏ ĐỨNG (giỏ số 1 bên trái); kèm hình cắt ngang cánh mở lên
 * Không phụ thuộc thư viện nào; module chính dùng qua window.NhmThietBi.tao(...) và window.NhmThietBi.xemTruoc(mau).
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var TOI_DA_KE = 12;

  function el(tag, attrs, kids) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) n.setAttribute(k, String(attrs[k])); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function chu(x, y, s, cls, anchor) {
    var t = el('text', { x: x, y: y, class: cls, 'text-anchor': anchor || 'middle' });
    t.textContent = s;
    return t;
  }
  function cat(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
  function nhietDoChu(v) { return v == null ? '' : ' · ' + String(v).replace('.', ',') + '°C'; }

  /**
   * du = { kieu, ten, mauTen, khoang: [{ id, ten, nhiet_do, so_ke, loai_ke, ke: [{ id, name, vi_tri, boxes: [{ id, vi_tri, rows, cols, name, code }] }], hop: [box] }] }
   * opts = { chonKhoang(id), chonKe(id), chonHop(id), khiChon(chuỗi) } — đều tùy chọn
   * @returns {{node: HTMLElement, chon: function(sel)}} sel = null | {khoang:id} | {gia:id} | {hop:id} | {hop:id, row, col}
   */
  function tao(du, opts) {
    opts = opts || {};
    var nam = du.kieu === 'tu_nam';
    var khoang = du.khoang && du.khoang.length ? du.khoang : [{ id: null, ten: 'Chưa có ngăn', nhiet_do: null, so_ke: 3, loai_ke: 'Rack', ke: [], hop: [] }];
    var svg = el('svg', { viewBox: '0 0 300 330', class: 'tb-svg', role: 'img', 'aria-label': 'Sơ đồ ' + (du.mauTen || 'thiết bị') + ' ' + (du.ten || '') + ': ' + khoang.length + ' ngăn' });

    // ----- vỏ thiết bị -----
    var BX0 = 40, BX1 = 260, BY0 = 12, BY1 = 308; // vùng thân (tủ đứng / tủ lạnh)
    var vung; // toạ độ từng khoang: {x, y, w, h}
    if (nam) {
      svg.appendChild(el('rect', { x: 12, y: 30, width: 276, height: 198, rx: 12, class: 'tb-vo' }));
      vung = khoang.map(function (k, i) {
        var n = khoang.length, gap = 8, w = (252 - gap * (n - 1)) / n; // phần trong cách vỏ 12px mỗi bên
        return { x: 24 + i * (w + gap), y: 58, w: w, h: 160 };
      });
    } else {
      svg.appendChild(el('rect', { x: BX0, y: BY0, width: BX1 - BX0, height: BY1 - BY0, rx: 9, class: 'tb-vo' }));
      svg.appendChild(el('rect', { x: BX0 + 10, y: BY1, width: 22, height: 8, rx: 2, class: 'tb-chan' }));
      svg.appendChild(el('rect', { x: BX1 - 32, y: BY1, width: 22, height: 8, rx: 2, class: 'tb-chan' }));
      var tong = BY1 - BY0 - 16, gapD = 6, n = khoang.length;
      var tyLe = du.kieu === 'tu_lanh' && n === 2 ? [0.38, 0.62] : khoang.map(function () { return 1 / n; });
      var y = BY0 + 8;
      vung = khoang.map(function (k, i) {
        var h = (tong - gapD * (n - 1)) * tyLe[i];
        var v = { x: BX0 + 8, y: y, w: BX1 - BX0 - 16, h: h };
        y += h + gapD;
        return v;
      });
    }

    var theoKhoang = {}, theoKe = {}, theoHop = {};
    khoang.forEach(function (k, i) {
      var v = vung[i];
      var g = el('g', { class: 'tb-nhom' });
      var khung = el('rect', { x: v.x, y: v.y, width: v.w, height: v.h, rx: 5, class: 'tb-khoang' });
      var tt = el('title', {}); tt.textContent = k.ten + nhietDoChu(k.nhiet_do); khung.appendChild(tt);
      if (k.id != null && opts.chonKhoang) { khung.style.cursor = 'pointer'; khung.addEventListener('click', function () { opts.chonKhoang(k.id); }); }
      g.appendChild(khung);
      var km = { id: k.id, ten: k.ten, x: v.x, y: v.y, w: v.w, h: v.h, el: khung, ke: {} };
      theoKhoang[k.id == null ? 'x' + i : k.id] = km;

      // tay cầm / bản lề
      if (nam) { g.appendChild(el('rect', { x: v.x + v.w / 2 - 14, y: v.y + v.h + 3, width: 28, height: 5, rx: 2.5, class: 'tb-tay' })); g.appendChild(el('rect', { x: v.x + 6, y: 24, width: 12, height: 6, rx: 2, class: 'tb-tay' })); g.appendChild(el('rect', { x: v.x + v.w - 18, y: 24, width: 12, height: 6, rx: 2, class: 'tb-tay' })); }
      else g.appendChild(el('rect', { x: du.kieu === 'tu_lanh' ? v.x + 4 : v.x + v.w - 6, y: v.y + v.h / 2 - 12, width: 3, height: 24, rx: 1.5, class: 'tb-tay' }));

      // nhãn khoang
      var nhan = cat(k.ten, nam ? 14 : 30) + (/°C/.test(k.ten) ? '' : nhietDoChu(k.nhiet_do)); // tên ngăn đã có nhiệt độ («Ngăn đá trên (-20°C)») thì không lặp lại
      g.appendChild(chu(v.x + v.w / 2, nam ? v.y - 5 : v.y + 11, nhan, 'tb-ten'));

      // các kệ / giỏ
      var ke = (k.ke || []).slice();
      var dung = {}; ke.forEach(function (r) { if (r.vi_tri) dung[r.vi_tri] = true; });
      var tiep = 1;
      ke.forEach(function (r) { r._so = r.vi_tri; if (!r._so) { while (dung[tiep]) tiep++; r._so = tiep; dung[tiep] = true; } });
      var soKe = Math.min(TOI_DA_KE, Math.max(k.so_ke || 0, ke.length, ke.reduce(function (m, r) { return Math.max(m, r._so); }, 0), 1));
      var coHopTrucTiep = (k.hop || []).length > 0;
      var vungKe = nam ? { x: v.x + 4, y: v.y + 6, w: v.w - 8, h: v.h - 12 - (coHopTrucTiep ? 18 : 0) } : { x: v.x + 5, y: v.y + 17, w: v.w - 10, h: v.h - 22 - (coHopTrucTiep ? 18 : 0) };
      var gapK = 3;
      var cell = nam ? (vungKe.w - gapK * (soKe - 1)) / soKe : (vungKe.h - gapK * (soKe - 1)) / soKe; // bề dày một kệ / giỏ
      function viTriKe(so) { return nam ? { x: vungKe.x + (so - 1) * (cell + gapK), y: vungKe.y, w: cell, h: vungKe.h } : { x: vungKe.x, y: vungKe.y + (so - 1) * (cell + gapK), w: vungKe.w, h: cell }; }
      for (var s = 1; s <= soKe; s++) {
        var p = viTriKe(s);
        g.appendChild(el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 2.5, class: 'tb-ke tb-ke--trong' }));
      }
      ke.forEach(function (r) {
        var p = viTriKe(Math.min(r._so, soKe));
        var kr = el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 2.5, class: 'tb-ke' });
        var tk = el('title', {}); tk.textContent = (r.name || (k.loai_ke || 'Rack') + ' ' + r._so); kr.appendChild(tk);
        if (opts.chonKe) { kr.style.cursor = 'pointer'; kr.addEventListener('click', function (e) { e.stopPropagation(); opts.chonKe(r.id); }); }
        g.appendChild(kr);
        var rm = { id: r.id, x: p.x, y: p.y, w: p.w, h: p.h, el: kr, ten: r.name || (k.loai_ke || 'Rack') + ' ' + r._so, so: r._so, khoang: km };
        theoKe[r.id] = rm; km.ke[r.id] = rm;
        // số kệ ở đầu kệ
        if ((nam ? p.w : p.h) >= 14) g.appendChild(chu(nam ? p.x + p.w / 2 : p.x + 7, nam ? p.y + 9 : p.y + p.h / 2 + 3, String(r._so), 'tb-so'));
        veHop(g, rm, r.boxes || [], p);
      });
      // hộp đặt thẳng trong khoang (không qua kệ): một dải riêng ở đáy
      if (coHopTrucTiep) {
        var pb = { x: vungKe.x, y: vungKe.y + vungKe.h + 3, w: vungKe.w, h: 15 };
        g.appendChild(el('rect', { x: pb.x, y: pb.y, width: pb.w, height: pb.h, rx: 2.5, class: 'tb-ke tb-ke--san' }));
        var rm2 = { id: null, x: pb.x, y: pb.y, w: pb.w, h: pb.h, el: null, ten: 'hộp đặt thẳng trong ngăn', so: 0, khoang: km };
        veHopNgang(g, rm2, k.hop, pb);
      }
      svg.appendChild(g);
    });

    // hộp trên một kệ: tủ đứng → dãy ô vuông nằm ngang; tủ nằm ngang → dãy ô vuông xếp dọc trong giỏ
    function veHop(g, rm, boxes, p) {
      if (!boxes.length) return;
      var ds = boxes.slice().sort(function (a, b) { return (a.vi_tri || 999) - (b.vi_tri || 999) || a.id - b.id; });
      var canh = nam ? Math.min(p.w - 4, 13) : Math.min(p.h - 4, 13);
      var khoangCach = 2, dau = nam ? p.y + 14 : p.x + 14, sucChua = nam ? p.h - 16 : p.w - 16;
      var soVe = Math.max(1, Math.floor((sucChua + khoangCach) / (canh + khoangCach)));
      ds.slice(0, soVe).forEach(function (b, i) {
        var x = nam ? p.x + (p.w - canh) / 2 : dau + i * (canh + khoangCach);
        var y = nam ? dau + i * (canh + khoangCach) : p.y + (p.h - canh) / 2;
        veMotHop(g, rm, b, x, y, canh);
      });
      if (ds.length > soVe) g.appendChild(chu(nam ? p.x + p.w / 2 : p.x + p.w - 4, nam ? p.y + p.h - 2 : p.y + p.h / 2 + 3, '+' + (ds.length - soVe), 'tb-so', nam ? 'middle' : 'end'));
    }
    function veHopNgang(g, rm, boxes, p) {
      var ds = boxes.slice().sort(function (a, b) { return (a.vi_tri || 999) - (b.vi_tri || 999) || a.id - b.id; });
      var canh = Math.min(p.h - 3, 12), soVe = Math.max(1, Math.floor((p.w - 6) / (canh + 2)));
      ds.slice(0, soVe).forEach(function (b, i) { veMotHop(g, rm, b, p.x + 4 + i * (canh + 2), p.y + (p.h - canh) / 2, canh); });
    }
    function veMotHop(g, rm, b, x, y, canh) {
      var r = el('rect', { x: x, y: y, width: canh, height: canh, rx: 1.4, class: 'tb-hop' });
      var t = el('title', {}); t.textContent = rm.ten + ' · ' + (b.name || b.code); r.appendChild(t);
      if (opts.chonHop) { r.style.cursor = 'pointer'; r.addEventListener('click', function (e) { e.stopPropagation(); opts.chonHop(b.id); }); }
      g.appendChild(r);
      theoHop[b.id] = { x: x, y: y, w: canh, h: canh, b: b, el: r, ke: rm };
    }

    // mặt trước tủ nằm ngang: thân tủ và các nắp (cánh) xếp cạnh nhau, mỗi nắp có tay nắm (trang trí, cho biết đây là tủ nằm ngang)
    if (nam) {
      svg.appendChild(chu(150, 15, 'Nhìn từ trên (các cánh mở lên)', 'tb-nhan'));
      svg.appendChild(el('rect', { x: 52, y: 280, width: 196, height: 28, rx: 4, class: 'tb-vo' }));
      var nNap = khoang.length, wNap = (196 - 4 * (nNap - 1)) / nNap;
      khoang.forEach(function (k, i) {
        var xn = 52 + i * (wNap + 4);
        svg.appendChild(el('rect', { x: xn, y: 266, width: wNap, height: 14, rx: 3, class: 'tb-khoang' }));
        svg.appendChild(el('rect', { x: xn + wNap / 2 - 12, y: 270, width: 24, height: 4, rx: 2, class: 'tb-tay' }));
      });
      svg.appendChild(el('rect', { x: 62, y: 308, width: 22, height: 6, rx: 2, class: 'tb-chan' }));
      svg.appendChild(el('rect', { x: 216, y: 308, width: 22, height: 6, rx: 2, class: 'tb-chan' }));
      svg.appendChild(chu(150, 326, 'Nhìn thẳng (các cánh đóng)', 'tb-nhan'));
    }
    // chấm đỏ + nhãn đang chọn
    var cham = el('g', { class: 'tb-cham', style: 'display:none', 'aria-hidden': 'true' }, [el('circle', { r: 8, class: 'tb-vong' }), el('circle', { r: 3.4, class: 'tb-diem' })]);
    svg.appendChild(cham);

    var chuThich = document.createElement('p');
    chuThich.className = 'ln-chuthich';
    chuThich.setAttribute('aria-live', 'polite');
    var mac = 'Bấm vào ngăn, ' + (nam ? 'giỏ' : 'kệ') + ', hộp hoặc một ô trên lưới hộp để xem vị trí trong thiết bị.';
    chuThich.textContent = mac;

    var truocDo = [];
    function tat() { truocDo.forEach(function (n) { n.classList.remove('tb-on'); }); truocDo = []; cham.style.display = 'none'; }
    function dat(n) { if (n) { n.classList.add('tb-on'); truocDo.push(n); } }
    function baoChon(t) { if (opts.khiChon) opts.khiChon(t); }

    function chon(sel) {
      tat();
      if (!sel) { chuThich.textContent = mac; baoChon(''); return; }
      var v = sel.hop != null ? theoHop[sel.hop] : null;
      var rm = v ? v.ke : sel.gia != null ? theoKe[sel.gia] : null;
      var km = rm ? rm.khoang : sel.khoang != null ? theoKhoang[sel.khoang] : null;
      if (!km) { chuThich.textContent = mac; baoChon(''); return; }
      var mo = km.ten, px, py;
      dat(km.el);
      if (rm) {
        if (rm.el) dat(rm.el);
        mo += ' · ' + rm.ten;
        px = rm.x + rm.w / 2; py = rm.y + rm.h / 2;
      } else { px = km.x + km.w / 2; py = km.y + 22; }
      if (v) {
        dat(v.el);
        px = v.x + v.w / 2; py = v.y + v.h / 2;
        mo += ' · ' + (v.b.name || v.b.code);
        if (sel.row && sel.col && v.b.rows && v.b.cols) {
          px = v.x + (v.w * (sel.col - 0.5)) / v.b.cols; py = v.y + (v.h * (sel.row - 0.5)) / v.b.rows;
          mo += ' · ô ' + String.fromCharCode(64 + sel.row) + sel.col;
        }
      }
      cham.setAttribute('transform', 'translate(' + px.toFixed(1) + ' ' + py.toFixed(1) + ')');
      cham.style.display = '';
      chuThich.textContent = mo + ' — chấm đỏ trên sơ đồ.';
      baoChon(mo);
    }

    var node = document.createElement('div');
    node.className = 'ln-hop-bao tb-bao';
    node.appendChild(svg);
    node.appendChild(chuThich);
    return { node: node, chon: chon };
  }

  /** Dữ liệu vẽ trước cho một MẪU thiết bị (chưa có Rack / hộp): các ngăn theo mẫu với số kệ trống. */
  function duLieuMau(mau) {
    return { kieu: mau.kieu, ten: mau.ten, mauTen: mau.ten, khoang: (mau.khoang || []).map(function (k, i) { return { id: 'm' + i, ten: k.ten, nhiet_do: k.nhiet_do != null ? k.nhiet_do : mau.nhiet_do, so_ke: k.so_ke, loai_ke: k.loai_ke, ke: [], hop: [] }; }) };
  }

  /** Nút xem trước ở form thêm thiết bị: trả node SVG (hoặc null nếu mẫu là bình nitơ lỏng, đã có sơ đồ riêng). */
  function xemTruoc(mau) {
    if (!mau || mau.kieu === 'binh_ln') return null;
    var m = tao(duLieuMau(mau), {});
    return m.node;
  }

  window.NhmThietBi = { tao: tao, xemTruoc: xemTruoc };
})();
