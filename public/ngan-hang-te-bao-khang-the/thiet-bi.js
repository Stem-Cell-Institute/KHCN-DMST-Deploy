/*
 * Sơ đồ thiết bị lưu trữ xuyên thấu (tủ đứng, tủ nằm ngang, tủ lạnh nhiều ngăn): các ngăn, Rack / giỏ / kệ / ngăn kéo và hộp theo đúng khai báo trong hệ thống,
 * chấm đỏ đánh dấu mục đang chọn (ngăn, Rack, hộp hoặc một ô ống trên lưới hộp). Cùng phong cách với binh-ln.js (bình nitơ lỏng).
 *
 * Ba kiểu vẽ:
 *   tu_dung  tủ đứng — nhìn NGHIÊNG 3D từ phía trước-trái-trên: mỗi ngăn là một khoang mở, Rack là tấm dài chạy từ ngoài vào SÂU bên trong
 *            (Rack số 1 ở trên cùng), các hộp xếp nối nhau dọc theo chiều dài Rack nên thấy được vị trí từng hộp
 *   tu_lanh  như tu_dung nhưng ngăn đá phía trên thấp hơn ngăn mát phía dưới
 *   tu_nam   tủ nằm ngang nhìn từ TRÊN: các cánh (nắp) xếp cạnh nhau, mỗi cánh có các giỏ ĐỨNG (giỏ số 1 bên trái); kèm hình cắt ngang cánh mở lên
 *
 * Kéo thả (khi module chính truyền opts.keoKe): giữ chuột / ngón tay trên một Rack rồi kéo sang ô khác trong cùng thiết bị — ô trống thì chuyển Rack sang đó,
 * ô đã có Rack khác thì hoán đổi. Bàn phím: Alt + mũi tên trên một Rack. Bấm vào ô trống (nét đứt) để thêm Rack vào đúng vị trí (opts.themKe).
 * Không phụ thuộc thư viện nào; module chính dùng qua window.NhmThietBi.tao(...) và window.NhmThietBi.xemTruoc(mau).
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var TOI_DA_KE = 12;   // số ô Rack tối đa vẽ trong một ngăn
  var TOI_DA_HOP = 8;   // số ô hộp tối đa vẽ dọc một Rack (còn lại ghi «+n»)
  var NGUONG_KEO = 5;   // pixel di chuyển tối thiểu để coi là kéo (dưới ngưỡng này là bấm)

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
  function da(pts) { return pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
  function hcn(x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
  /** Điểm (x, y) có nằm trong đa giác poly không (tia ngang). */
  function trongDaGiac(x, y, poly) {
    var vao = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) vao = !vao;
    }
    return vao;
  }
  function theoSo(a, b) { return (a.vi_tri || 999) - (b.vi_tri || 999) || a.id - b.id; }

  /**
   * du = { kieu, ten, mauTen, khoang: [{ id, ten, nhiet_do, so_ke, loai_ke, ke: [{ id, name, vi_tri, boxes: [{ id, vi_tri, rows, cols, name, code }] }], hop: [box] }] }
   * opts = { chonKhoang(id), chonKe(id), chonHop(id), khiChon(chuỗi), keoKe(keId, khoangId, soViTri), themKe(khoangId, soViTri) } — đều tùy chọn
   * @returns {{node: HTMLElement, chon: function(sel)}} sel = null | {khoang:id} | {gia:id} | {hop:id} | {hop:id, row, col}
   */
  function tao(du, opts) {
    opts = opts || {};
    var nam = du.kieu === 'tu_nam';
    var khoang = du.khoang && du.khoang.length ? du.khoang : [{ id: null, ten: 'Chưa có ngăn', nhiet_do: null, so_ke: 3, loai_ke: 'Rack', ke: [], hop: [] }];
    var svg = el('svg', { viewBox: '0 0 300 330', class: 'tb-svg', role: 'img', 'aria-label': 'Sơ đồ ' + (du.mauTen || 'thiết bị') + ' ' + (du.ten || '') + ': ' + khoang.length + ' ngăn' });
    var keoDuoc = typeof opts.keoKe === 'function';
    var themDuoc = typeof opts.themKe === 'function';

    var theoKhoang = {}, theoKe = {}, theoHop = {}, oCho = [];

    // ----- số liệu từng ngăn: đánh số Rack chưa có vị trí, số ô Rack -----
    var thongTin = khoang.map(function (k) {
      var ke = (k.ke || []).slice().sort(theoSo);
      var dung = {}; ke.forEach(function (r) { if (r.vi_tri) dung[r.vi_tri] = true; });
      var tiep = 1;
      ke.forEach(function (r) { r._so = r.vi_tri; if (!r._so) { while (dung[tiep]) tiep++; r._so = tiep; dung[tiep] = true; } });
      var soKe = Math.min(TOI_DA_KE, Math.max(k.so_ke || 0, ke.length, ke.reduce(function (m, r) { return Math.max(m, r._so); }, 0), 1));
      return { ke: ke, soKe: soKe, coHopTrucTiep: (k.hop || []).length > 0 };
    });

    // ----- vỏ thiết bị và vùng từng ngăn -----
    var vung; // {x, y, w, h}: khung nhìn vào ngăn (tủ đứng) hoặc cánh (tủ nằm)
    var BX0 = 18, BX1 = 266, BY0 = 22, BY1 = 304; // mặt trước tủ đứng
    var DAY_TREN = 8, DAY_PHAI = 10;                // bề dày vỏ nhìn nghiêng (mặt trên, mặt bên phải)
    var TIEU_DE = 14;                               // dải chữ tên ngăn phía trên khung
    var DAY_KE = 4;                                 // bề dày một Rack nhìn từ phía trước
    var dyS = 0, dxS = 0;                           // vectơ chiều sâu trên màn hình (ra sau = sang phải, lên trên)
    var pitch = [];                                 // khoảng cách các tầng Rack trong từng ngăn
    if (nam) {
      svg.appendChild(el('rect', { x: 12, y: 30, width: 276, height: 198, rx: 12, class: 'tb-vo' }));
      vung = khoang.map(function (k, i) {
        var n = khoang.length, gap = 8, w = (252 - gap * (n - 1)) / n; // phần trong cách vỏ 12px mỗi bên
        return { x: 24 + i * (w + gap), y: 58, w: w, h: 160 };
      });
    } else {
      svg.appendChild(el('polygon', { points: da([[BX0, BY0], [BX0 + DAY_PHAI, BY0 - DAY_TREN], [BX1 + DAY_PHAI, BY0 - DAY_TREN], [BX1, BY0]]), class: 'tb-vo tb-vo--mat' }));
      svg.appendChild(el('polygon', { points: da([[BX1, BY0], [BX1 + DAY_PHAI, BY0 - DAY_TREN], [BX1 + DAY_PHAI, BY1 - DAY_TREN], [BX1, BY1]]), class: 'tb-vo tb-vo--mat' }));
      svg.appendChild(el('rect', { x: BX0, y: BY0, width: BX1 - BX0, height: BY1 - BY0, rx: 6, class: 'tb-vo' }));
      svg.appendChild(el('rect', { x: BX0 + 10, y: BY1, width: 22, height: 8, rx: 2, class: 'tb-chan' }));
      svg.appendChild(el('rect', { x: BX1 - 32, y: BY1, width: 22, height: 8, rx: 2, class: 'tb-chan' }));
      var tong = BY1 - BY0 - 16, gapD = 6, n = khoang.length;
      var tyLe = du.kieu === 'tu_lanh' && n === 2 ? [0.38, 0.62] : khoang.map(function () { return 1 / n; });
      var y = BY0 + 8;
      vung = khoang.map(function (k, i) {
        var khoi = (tong - gapD * (n - 1)) * tyLe[i];
        var v = { x: BX0 + 8, y: y + TIEU_DE, w: BX1 - BX0 - 16, h: khoi - TIEU_DE, dauKhoi: y };
        y += khoi + gapD;
        return v;
      });
      // chiều sâu: đủ thấp để mặt trên của Rack dưới không che Rack ngay phía trên
      var dyToiDa = 18, minPitch = 999;
      khoang.forEach(function (k, i) {
        var v = vung[i], dung = v.h - (thongTin[i].coHopTrucTiep ? 18 : 0);
        minPitch = Math.min(minPitch, (dung - dyToiDa - 12) / thongTin[i].soKe);
      });
      dyS = Math.max(5, Math.min(dyToiDa, minPitch - DAY_KE - 5)); // chừa chỗ cho hộp nhô cao 3px
      dxS = dyS * 2.6;
      khoang.forEach(function (k, i) {
        var v = vung[i], dung = v.h - (thongTin[i].coHopTrucTiep ? 18 : 0);
        pitch[i] = (dung - dyS - 12) / thongTin[i].soKe;
      });
    }

    // ----- vẽ từng ngăn -----
    khoang.forEach(function (k, i) {
      var v = vung[i], tt = thongTin[i];
      var g = el('g', { class: 'tb-nhom' });
      var khung = el('rect', { x: v.x, y: v.y, width: v.w, height: v.h, rx: 5, class: 'tb-khoang' });
      var tit = el('title', {}); tit.textContent = k.ten + nhietDoChu(k.nhiet_do); khung.appendChild(tit);
      if (k.id != null && opts.chonKhoang) { khung.style.cursor = 'pointer'; khung.addEventListener('click', function () { opts.chonKhoang(k.id); }); }
      g.appendChild(khung);
      var km = { id: k.id, ten: k.ten, x: v.x, y: v.y, w: v.w, h: v.h, el: khung, ke: {} };
      theoKhoang[k.id == null ? 'x' + i : k.id] = km;
      var thatSu = typeof k.id === 'number'; // ngăn thật (không phải bản xem trước của mẫu)

      // tay cầm / bản lề
      if (nam) { g.appendChild(el('rect', { x: v.x + v.w / 2 - 14, y: v.y + v.h + 3, width: 28, height: 5, rx: 2.5, class: 'tb-tay' })); g.appendChild(el('rect', { x: v.x + 6, y: 24, width: 12, height: 6, rx: 2, class: 'tb-tay' })); g.appendChild(el('rect', { x: v.x + v.w - 18, y: 24, width: 12, height: 6, rx: 2, class: 'tb-tay' })); }
      else g.appendChild(el('rect', { x: du.kieu === 'tu_lanh' ? BX0 + 2 : BX1 - 5, y: v.y + v.h / 2 - 12, width: 3, height: 24, rx: 1.5, class: 'tb-tay' }));

      // nhãn khoang
      var nhan = cat(k.ten, nam ? 14 : 34) + (/°C/.test(k.ten) ? '' : nhietDoChu(k.nhiet_do)); // tên ngăn đã có nhiệt độ («Ngăn đá trên (-20°C)») thì không lặp lại
      if (nam) g.appendChild(chu(v.x + v.w / 2, v.y - 5, nhan, 'tb-ten'));
      else g.appendChild(chu(v.x + 2, v.dauKhoi + 10, nhan, 'tb-ten', 'start'));

      var coHop = tt.coHopTrucTiep, ke = tt.ke, soKe = tt.soKe;

      // ---- hình học các ô Rack của ngăn ----
      var vungKe = nam ? { x: v.x + 4, y: v.y + 6, w: v.w - 8, h: v.h - 12 - (coHop ? 18 : 0) } : null;
      var gapK = 3;
      var cell = nam ? (vungKe.w - gapK * (soKe - 1)) / soKe : 0;
      var kho3 = nam ? null : { sx: v.x + 14, sw: Math.min(70, v.w - dxS - 56), pt: pitch[i] }; // Rack: lệch trái 14px, rộng tối đa 70px
      function oRack(so) { // đa giác của ô số `so` (dùng làm vùng thả và vùng bấm khi trống)
        if (nam) { var p = { x: vungKe.x + (so - 1) * (cell + gapK), y: vungKe.y, w: cell, h: vungKe.h }; return hcn(p.x, p.y, p.w, p.h); }
        var ly = v.y + dyS + 6 + (so - 1) * kho3.pt, sx = kho3.sx, sw = kho3.sw;
        return [[sx, ly + DAY_KE], [sx + sw, ly + DAY_KE], [sx + sw, ly], [sx + sw + dxS, ly - dyS], [sx + dxS, ly - dyS], [sx, ly]];
      }

      // ô nền: vùng thả khi kéo; ô chưa có Rack hiện nét đứt và bấm để thêm
      var coRack = {}; ke.forEach(function (r) { coRack[Math.min(r._so, soKe)] = r; });
      // khoang 3D: tường trái, tường sau, sàn — tạo cảm giác chiều sâu
      if (!nam) {
        g.appendChild(el('polygon', { points: da([[v.x, v.y], [v.x + dxS, v.y], [v.x + dxS, v.y + v.h - dyS], [v.x, v.y + v.h]]), class: 'tb-tuong tb-tuong--trai' }));
        g.appendChild(el('rect', { x: v.x + dxS, y: v.y, width: v.w - dxS, height: v.h - dyS, class: 'tb-tuong' }));
        g.appendChild(el('polygon', { points: da([[v.x, v.y + v.h], [v.x + dxS, v.y + v.h - dyS], [v.x + v.w, v.y + v.h - dyS], [v.x + v.w, v.y + v.h]]), class: 'tb-san' }));
      }
      for (var s = 1; s <= soKe; s++) {
        var poly = oRack(s);
        var trong = !coRack[s];
        var oc = el('polygon', { points: da(poly), class: 'tb-o' + (trong ? ' tb-ke tb-ke--trong' : '') });
        if (trong && themDuoc && thatSu) {
          oc.classList.add('tb-o--them');
          var tOc = el('title', {}); tOc.textContent = 'Ô trống số ' + s + ' — bấm để thêm ' + (k.loai_ke || 'Rack'); oc.appendChild(tOc);
          oc.addEventListener('click', (function (so) { return function () { opts.themKe(k.id, so); }; })(s));
        }
        g.appendChild(oc);
        oCho.push({ khoang: km, so: s, poly: poly, el: oc, trong: trong, thatSu: thatSu });
      }

      // ---- các Rack / giỏ ----
      ke.forEach(function (r) {
        var so = Math.min(r._so, soKe);
        var poly = oRack(so);
        var ten = r.name || (k.loai_ke || 'Rack') + ' ' + r._so;
        var gk = el('g', { class: 'tb-ke-g' + (keoDuoc && thatSu ? ' tb-ke-g--keo' : '') });
        var els = [];
        var rm = { id: r.id, el: null, els: els, ten: ten, so: r._so, oSo: so, khoang: km, g: gk, poly: poly, cx: 0, cy: 0 };
        var vungHop; // hàm P(u, w) → toạ độ trên mặt Rack: u = 0 (ngoài cùng) … 1 (sâu nhất), w = 0 (trái) … 1 (phải)

        if (nam) {
          var p = { x: poly[0][0], y: poly[0][1], w: poly[1][0] - poly[0][0], h: poly[2][1] - poly[0][1] };
          var kr = el('rect', { x: p.x, y: p.y, width: p.w, height: p.h, rx: 2.5, class: 'tb-ke' });
          els.push(kr); gk.appendChild(kr);
          if (p.w >= 14) gk.appendChild(chu(p.x + p.w / 2, p.y + 9, String(r._so), 'tb-so'));
          rm.cx = p.x + p.w / 2; rm.cy = p.y + p.h / 2;
          vungHop = { cho: function (j, m) { var c = Math.min(p.w - 4, 13), d = p.y + 14, kc = 2; return { poly: hcn(p.x + (p.w - c) / 2, d + (j - 1) * (c + kc), c, c), tam: null, mo: { u0: 0, u1: 0 } }; }, soTo: Math.max(1, Math.floor((p.h - 16 + 2) / (Math.min(p.w - 4, 13) + 2))) };
        } else {
          var ly = v.y + dyS + 6 + (so - 1) * kho3.pt, sx = kho3.sx, sw = kho3.sw;
          var mat = el('polygon', { points: da([[sx, ly], [sx + sw, ly], [sx + sw + dxS, ly - dyS], [sx + dxS, ly - dyS]]), class: 'tb-ke' });
          var dau = el('rect', { x: sx, y: ly, width: sw, height: DAY_KE, class: 'tb-ke tb-ke--dau' });
          els.push(mat, dau); gk.appendChild(mat); gk.appendChild(dau);
          gk.appendChild(chu(v.x + 3, ly + DAY_KE, String(r._so), 'tb-so', 'start'));
          gk.appendChild(chu(sx + sw + dxS + 6, ly - dyS / 2 + 3, cat(ten, 16), 'tb-ten2', 'start'));
          rm.cx = sx + sw / 2 + dxS / 2; rm.cy = ly - dyS / 2;
          // điểm trên mặt Rack: u theo chiều sâu, w ngang
          var P = function (u, w) { return [sx + w * sw + u * dxS, ly - u * dyS]; };
          vungHop = { P: P };
        }

        var tk = el('title', {}); tk.textContent = ten; gk.appendChild(tk);
        if (opts.chonKe) {
          gk.style.cursor = keoDuoc && thatSu ? 'grab' : 'pointer';
          gk.addEventListener('click', function (e) { e.stopPropagation(); opts.chonKe(r.id); });
        }
        if (keoDuoc && thatSu) {
          gk.setAttribute('tabindex', '0'); gk.setAttribute('role', 'button');
          gk.setAttribute('aria-label', ten + ' — Enter để chọn, Alt + mũi tên để đổi vị trí');
          gk.addEventListener('pointerdown', function (e) { batDauKeo(e, rm); });
          gk.addEventListener('keydown', function (e) { phimKe(e, rm, soKe); });
        }
        rm.el = els[0];
        theoKe[r.id] = rm; km.ke[r.id] = rm;

        // hộp trên Rack
        var hop = (r.boxes || []).slice().sort(theoSo);
        var dungH = {}; hop.forEach(function (b) { if (b.vi_tri) dungH[b.vi_tri] = true; });
        var tiepH = 1; hop.forEach(function (b) { b._so = b.vi_tri; if (!b._so) { while (dungH[tiepH]) tiepH++; b._so = tiepH; dungH[tiepH] = true; } });
        var soO = Math.min(TOI_DA_HOP, Math.max(nam ? vungHop.soTo : 4, hop.reduce(function (m, b) { return Math.max(m, b._so); }, 0)));
        if (nam) soO = Math.min(soO, vungHop.soTo);
        var khongVe = 0;
        if (!nam) { // vạch chia các vị trí hộp dọc theo chiều sâu Rack: thấy cả ô chưa có hộp
          for (var j = 1; j < soO; j++) {
            var a0 = vungHop.P(j / soO, 0), a1 = vungHop.P(j / soO, 1);
            gk.appendChild(el('line', { x1: a0[0], y1: a0[1], x2: a1[0], y2: a1[1], class: 'tb-vach' }));
          }
        }
        hop.slice().sort(function (a, b) { return b._so - a._so; }).forEach(function (b) { // vẽ từ sâu ra ngoài: hộp phía trước che mép hộp phía sau
          if (b._so > soO) { khongVe++; return; }
          var hg = el('g', { class: 'tb-hopg' }), tam, diem;
          if (nam) {
            var kq = vungHop.cho(b._so, soO).poly;
            hg.appendChild(el('polygon', { points: da(kq), class: 'tb-hop' }));
            tam = [(kq[0][0] + kq[2][0]) / 2, (kq[0][1] + kq[2][1]) / 2];
            diem = function () { return tam; };
          } else {
            // hộp là khối dày HB: mặt trên nâng lên, thêm mặt trước và mặt bên phải để thấy rõ từng hộp
            var HB = 3, u0 = (b._so - 1) / soO + 0.12 / soO, u1 = b._so / soO - 0.12 / soO, w0 = 0.1, w1 = 0.9, Pn = vungHop.P;
            var nang = function (p) { return [p[0], p[1] - HB]; };
            hg.appendChild(el('polygon', { points: da([Pn(u0, w0), Pn(u0, w1), nang(Pn(u0, w1)), nang(Pn(u0, w0))]), class: 'tb-hop tb-hop--mat' }));
            hg.appendChild(el('polygon', { points: da([Pn(u0, w1), Pn(u1, w1), nang(Pn(u1, w1)), nang(Pn(u0, w1))]), class: 'tb-hop tb-hop--mat' }));
            hg.appendChild(el('polygon', { points: da([nang(Pn(u0, w0)), nang(Pn(u0, w1)), nang(Pn(u1, w1)), nang(Pn(u1, w0))]), class: 'tb-hop' }));
            tam = nang(Pn((u0 + u1) / 2, 0.5));
            diem = function (row, col, rows, cols) { return nang(Pn(u0 + ((u1 - u0) * (row - 0.5)) / rows, w0 + ((w1 - w0) * (col - 0.5)) / cols)); }; // hàng chạy theo chiều sâu, cột theo chiều ngang
          }
          var th = el('title', {}); th.textContent = ten + ' · ' + (b.name || b.code); hg.appendChild(th);
          if (opts.chonHop) { hg.style.cursor = keoDuoc && thatSu ? 'grab' : 'pointer'; hg.addEventListener('click', function (e) { e.stopPropagation(); opts.chonHop(b.id); }); }
          gk.appendChild(hg);
          theoHop[b.id] = { tam: tam, diem: diem, b: b, el: hg, ke: rm };
        });
        if (khongVe > 0) {
          if (nam) gk.appendChild(chu(rm.cx, poly[2][1] - 2, '+' + khongVe, 'tb-so'));
          else gk.appendChild(chu(rm.cx + dxS / 2 + 4, rm.cy + dyS / 2 + 3, '+' + khongVe, 'tb-so', 'start'));
        }
        g.appendChild(gk);
      });

      // hộp đặt thẳng trong khoang (không qua Rack): một dải riêng ở đáy
      if (coHop) {
        var pb = nam ? { x: vungKe.x, y: vungKe.y + vungKe.h + 3, w: vungKe.w, h: 15 } : { x: v.x + 6, y: v.y + v.h - 20, w: v.w - 12, h: 15 };
        g.appendChild(el('rect', { x: pb.x, y: pb.y, width: pb.w, height: pb.h, rx: 2.5, class: 'tb-ke tb-ke--san' }));
        var rm2 = { id: null, el: null, els: [], ten: 'hộp đặt thẳng trong ngăn', so: 0, khoang: km, cx: pb.x + pb.w / 2, cy: pb.y + pb.h / 2 };
        var ds = k.hop.slice().sort(theoSo);
        var canh = Math.min(pb.h - 3, 12), soVe = Math.max(1, Math.floor((pb.w - 6) / (canh + 2)));
        ds.slice(0, soVe).forEach(function (b, j) {
          var x = pb.x + 4 + j * (canh + 2), yy = pb.y + (pb.h - canh) / 2;
          var r2 = el('rect', { x: x, y: yy, width: canh, height: canh, rx: 1.4, class: 'tb-hop' });
          var t2 = el('title', {}); t2.textContent = rm2.ten + ' · ' + (b.name || b.code); r2.appendChild(t2);
          if (opts.chonHop) { r2.style.cursor = 'pointer'; r2.addEventListener('click', function (e) { e.stopPropagation(); opts.chonHop(b.id); }); }
          g.appendChild(r2);
          theoHop[b.id] = { tam: [x + canh / 2, yy + canh / 2], diem: function () { return [x + canh / 2, yy + canh / 2]; }, b: b, el: r2, ke: rm2 };
        });
      }
      svg.appendChild(g);
    });

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

    // ---------- kéo thả Rack sang ô khác ----------
    var vuaKeo = false;
    // bấm ngay sau khi thả chuột không được tính là chọn
    svg.addEventListener('click', function (e) { if (vuaKeo) { e.stopPropagation(); e.preventDefault(); } }, true);

    function sangToaDo(cx, cy) { // toạ độ màn hình → toạ độ viewBox
      var m = svg.getScreenCTM();
      if (!m) return [0, 0];
      var pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy;
      var q = pt.matrixTransform(m.inverse());
      return [q.x, q.y];
    }
    function oDuoi(x, y, loaiTru) { // ô Rack đang nằm dưới điểm (x, y), bỏ qua ô loaiTru
      for (var i = 0; i < oCho.length; i++) if (oCho[i] !== loaiTru && oCho[i].thatSu && trongDaGiac(x, y, oCho[i].poly)) return oCho[i];
      return null;
    }
    function oCuaKe(rm) { for (var i = 0; i < oCho.length; i++) if (oCho[i].khoang === rm.khoang && oCho[i].so === rm.oSo) return oCho[i]; return null; }

    function batDauKeo(e, rm) {
      if (e.button != null && e.button !== 0) return;
      var x0 = e.clientX, y0 = e.clientY, goc = sangToaDo(x0, y0), dangKeo = false, ma = null, dich = null, nguon = oCuaKe(rm);
      function dichuyen(ev) {
        if (!dangKeo) {
          if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < NGUONG_KEO) return;
          dangKeo = true;
          svg.classList.add('tb-keo');
          rm.g.classList.add('tb-dang-keo');
          ma = rm.g.cloneNode(true);
          ma.setAttribute('class', 'tb-ma'); ma.removeAttribute('tabindex'); ma.removeAttribute('role');
          svg.insertBefore(ma, cham);
        }
        ev.preventDefault();
        var p = sangToaDo(ev.clientX, ev.clientY);
        ma.setAttribute('transform', 'translate(' + (p[0] - goc[0]).toFixed(1) + ' ' + (p[1] - goc[1]).toFixed(1) + ')');
        var o = oDuoi(p[0], p[1], nguon);
        if (o !== dich) {
          if (dich) dich.el.classList.remove('tb-o--dich');
          dich = o;
          if (dich) dich.el.classList.add('tb-o--dich');
        }
      }
      function xong(ev) {
        window.removeEventListener('pointermove', dichuyen);
        window.removeEventListener('pointerup', xong);
        window.removeEventListener('pointercancel', xong);
        if (!dangKeo) return; // chỉ là một cú bấm: để sự kiện click chọn Rack
        svg.classList.remove('tb-keo');
        rm.g.classList.remove('tb-dang-keo');
        if (ma && ma.parentNode) ma.parentNode.removeChild(ma);
        if (dich) dich.el.classList.remove('tb-o--dich');
        vuaKeo = true; setTimeout(function () { vuaKeo = false; }, 0);
        if (ev.type === 'pointerup' && dich && dich.khoang.id != null) opts.keoKe(rm.id, dich.khoang.id, dich.so);
      }
      window.addEventListener('pointermove', dichuyen, { passive: false });
      window.addEventListener('pointerup', xong);
      window.addEventListener('pointercancel', xong);
    }
    function phimKe(e, rm, soKe) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (opts.chonKe) opts.chonKe(rm.id); return; }
      if (!e.altKey) return;
      var buoc = nam ? ({ ArrowLeft: -1, ArrowRight: 1 })[e.key] : ({ ArrowUp: -1, ArrowDown: 1 })[e.key];
      if (!buoc) return;
      e.preventDefault();
      var den = rm.so + buoc;
      if (den >= 1 && den <= soKe) opts.keoKe(rm.id, rm.khoang.id, den);
    }

    var truocDo = [];
    function tat() { truocDo.forEach(function (n) { n.classList.remove('tb-on'); }); truocDo = []; cham.style.display = 'none'; }
    function dat(n) { if (Array.isArray(n)) n.forEach(dat); else if (n) { n.classList.add('tb-on'); truocDo.push(n); } }
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
        dat(rm.els);
        mo += ' · ' + rm.ten;
        px = rm.cx; py = rm.cy;
      } else { px = km.x + km.w / 2; py = km.y + 10; }
      if (v) {
        dat(v.el);
        px = v.tam[0]; py = v.tam[1];
        mo += ' · ' + (v.b.name || v.b.code);
        if (sel.row && sel.col && v.b.rows && v.b.cols) {
          var q = v.diem(sel.row, sel.col, v.b.rows, v.b.cols);
          px = q[0]; py = q[1];
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
    if (keoDuoc || themDuoc) {
      var goiY = document.createElement('p');
      goiY.className = 'nhm-small nhm-muted tb-goiy';
      goiY.textContent = (keoDuoc ? 'Kéo ' + (nam ? 'giỏ' : 'Rack') + ' sang ô khác để đổi vị trí (thả lên ' + (nam ? 'giỏ' : 'Rack') + ' khác để hoán đổi). ' : '') + (themDuoc ? 'Bấm ô nét đứt để thêm vào đúng chỗ đó.' : '');
      node.appendChild(goiY);
    }
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
