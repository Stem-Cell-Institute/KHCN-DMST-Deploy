/*
 * Mô hình bình nitơ lỏng xuyên thấu: các giá (rack) và hộp theo đúng khai báo trong hệ thống,
 * chấm đỏ đánh dấu mục đang chọn (giá, hộp hoặc một ô ống trên lưới hộp).
 *
 * Gồm hai hình trong một SVG: mặt cắt đứng (giá đứng cạnh nhau, hộp xếp từ trên xuống theo «vị trí số»: số 1 ở trên cùng)
 * và nhìn từ trên xuống (các vị trí giá quanh cổ bình, đánh số như trên bình thật).
 * Không phụ thuộc thư viện nào; module chính dùng qua window.NhmBinhLn.tao(...).
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var BODY_TOP = 100, BODY_BOTTOM = 284; // vùng giá bên trong bình (mặt cắt)
  var RACK_X0 = 34, RACK_X1 = 186;

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

  /**
   * du = { tank: {name}, racks: [{ id, name, vi_tri, boxes: [{ id, vi_tri, rows, cols, name, code }] }] }
   * opts = { chonGia(id), chonHop(id) (bấm vào mô hình để chọn), khiChon(chuỗi mô tả mục đang chọn) } — đều tùy chọn
   * @returns {{node: HTMLElement, chon: function(sel)}} sel = null | {gia:id} | {hop:id} | {hop:id, row, col}
   */
  function tao(du, opts) {
    opts = opts || {};
    // đánh số hiển thị: giá có «vị trí số» giữ nguyên, giá chưa đánh số lấy số trống nhỏ nhất
    var dung = {};
    du.racks.forEach(function (r) { if (r.vi_tri) dung[r.vi_tri] = true; });
    var tiep = 1;
    var racks = du.racks.map(function (r) {
      var so = r.vi_tri;
      if (!so) { while (dung[tiep]) tiep++; so = tiep; dung[so] = true; }
      return { id: r.id, name: r.name, so: so, boxes: r.boxes.slice() };
    }).sort(function (a, b) { return a.so - b.so; });
    var soGia = Math.max(racks.length, racks.reduce(function (m, r) { return Math.max(m, r.so); }, 0), 1);
    soGia = Math.min(soGia, 24);
    var soNgan = 6; // số tầng tối thiểu để hình không quá thưa
    racks.forEach(function (r) { r.boxes.forEach(function (b, i) { if (!b.vi_tri) b._so = i + 1; else b._so = b.vi_tri; soNgan = Math.max(soNgan, b._so); }); });
    soNgan = Math.min(soNgan, 50);
    var hNgan = (BODY_BOTTOM - BODY_TOP) / soNgan;

    // tên hiển thị của Rack: tên đã đặt, chưa đặt thì «Rack N»
    function tenRack(r) { return r.name || 'Rack ' + r.so; }
    function ngan(t) { return t.length > 14 ? t.slice(0, 13) + '…' : t; }
    var RONG_CHU = 5.6; // bề rộng ước lượng một ký tự chữ đậm 9px
    /** Toạ độ giữa của nhãn sao cho cả nhãn nằm trong [tu, den] (chữ dài hơn khoảng đó thì căn giữa khoảng). */
    function kepNhan(giua, chuoi, tu, den) {
      var nua = (chuoi.length * RONG_CHU) / 2;
      if (nua * 2 >= den - tu) return (tu + den) / 2;
      return Math.max(tu + nua, Math.min(den - nua, giua));
    }

    // toạ độ từng giá trong mặt cắt (giá thứ 1..soGia chia đều theo chiều ngang)
    var gap = 4;
    var wGia = Math.min(30, (RACK_X1 - RACK_X0 - gap * (soGia + 1)) / soGia);
    var tongRong = soGia * wGia + (soGia - 1) * gap;
    var x0 = (RACK_X0 + RACK_X1) / 2 - tongRong / 2;
    var xGia = function (so) { return x0 + (so - 1) * (wGia + gap); };

    var svg = el('svg', { viewBox: '0 0 300 330', class: 'ln-svg', role: 'img', 'aria-label': 'Mô hình bình nitơ lỏng ' + (du.tank.name || '') + ': ' + racks.length + ' Rack' });

    // vỏ bình xuyên thấu: nắp, cổ, thân, bình trong
    svg.appendChild(el('rect', { x: 84, y: 6, width: 52, height: 12, rx: 4, class: 'ln-nap' }));
    svg.appendChild(el('rect', { x: 92, y: 18, width: 36, height: 28, class: 'ln-co' }));
    svg.appendChild(el('path', { d: 'M92 46 C32 54 14 82 14 122 L14 290 Q14 308 32 308 L188 308 Q206 308 206 290 L206 122 C206 82 188 54 128 46 Z', class: 'ln-vo' }));
    svg.appendChild(el('rect', { x: 26, y: 92, width: 168, height: 202, rx: 10, class: 'ln-trong' }));
    svg.appendChild(el('line', { x1: 14, y1: 296, x2: 206, y2: 296, class: 'ln-de' }));

    // các giá và hộp
    var theoGia = {}, theoHop = {};
    for (var s = 1; s <= soGia; s++) {
      svg.appendChild(el('rect', { x: xGia(s), y: BODY_TOP, width: wGia, height: BODY_BOTTOM - BODY_TOP, rx: 3, class: 'ln-gia ln-gia--trong' }));
    }
    racks.forEach(function (r) {
      var g = el('g', { class: 'ln-nhom' });
      var khung = el('rect', { x: xGia(r.so), y: BODY_TOP, width: wGia, height: BODY_BOTTOM - BODY_TOP, rx: 3, class: 'ln-gia' });
      var tt = el('title', {});
      tt.textContent = tenRack(r);
      khung.appendChild(tt);
      g.appendChild(khung);
      var gm = { x: xGia(r.so), w: wGia, el: khung, boxes: {} };
      r.boxes.forEach(function (b) {
        var y = BODY_TOP + (b._so - 1) * hNgan; // số 1 ở TRÊN CÙNG, số càng lớn càng sâu
        var hop = el('rect', { x: xGia(r.so) + 1.5, y: y + 0.6, width: wGia - 3, height: Math.max(1.6, hNgan - 1.2), rx: 1.2, class: 'ln-hop' });
        if (opts.chonHop) { hop.style.cursor = 'pointer'; hop.addEventListener('click', function (e) { e.stopPropagation(); opts.chonHop(b.id); }); }
        var tb = el('title', {});
        tb.textContent = tenRack(r) + ' · ' + (b.name || 'Hộp ' + (b.vi_tri ? 'vị trí ' + b.vi_tri : b.code));
        hop.appendChild(tb);
        g.appendChild(hop);
        var v = { x: xGia(r.so) + 1.5, y: y, w: wGia - 3, h: hNgan, b: b, el: hop, gia: gm };
        theoHop[b.id] = v;
        gm.boxes[b.id] = v;
      });
      if (opts.chonGia) { khung.style.cursor = 'pointer'; khung.addEventListener('click', function () { opts.chonGia(r.id); }); }
      svg.appendChild(g);
      theoGia[r.id] = gm;
      // nhãn số giá dưới đáy
      if (wGia >= 11 || r.so % 2 === 1) svg.appendChild(chu(xGia(r.so) + wGia / 2, BODY_BOTTOM + 11, String(r.so), 'ln-so'));
    });

    // nhìn từ trên: các vị trí giá quanh cổ bình
    var CX = 252, CY = 62, R = 34;
    var cach = soGia > 1 ? 2 * R * Math.sin(Math.PI / soGia) : 99; // khoảng cách giữa hai vị trí kề nhau
    var rr = Math.max(2.5, Math.min(9, cach / 2 - 0.9));
    svg.appendChild(el('circle', { cx: CX, cy: CY, r: R + 12, class: 'ln-vo ln-tren' }));
    svg.appendChild(el('circle', { cx: CX, cy: CY, r: R + 3, class: 'ln-trong' }));
    var viTriTren = {};
    for (var k = 1; k <= soGia; k++) {
      var ang = -Math.PI / 2 + ((k - 1) * 2 * Math.PI) / soGia;
      var px = CX + R * Math.cos(ang), py = CY + R * Math.sin(ang);
      viTriTren[k] = { x: px, y: py };
      var co = racks.some(function (r) { return r.so === k; });
      svg.appendChild(el('circle', { cx: px, cy: py, r: rr, class: 'ln-o' + (co ? ' ln-o--co' : '') }));
      if (rr >= 5.5) svg.appendChild(chu(px, py + (rr >= 7 ? 2.6 : 2.2), String(k), 'ln-so ln-so--tren' + (rr < 7 ? ' ln-so--nho' : '')));
    }
    svg.appendChild(chu(CX, CY + R + 28, 'Nhìn từ trên', 'ln-nhan'));
    svg.appendChild(chu(110, 326, 'Mặt cắt đứng', 'ln-nhan'));

    // chấm đỏ
    var cham = el('g', { class: 'ln-cham', style: 'display:none', 'aria-hidden': 'true' }, [
      el('circle', { r: 8, class: 'ln-vong' }),
      el('circle', { r: 3.4, class: 'ln-diem' }),
    ]);
    var chamTren = el('g', { class: 'ln-cham', style: 'display:none', 'aria-hidden': 'true' }, [
      el('circle', { r: rr + 3, class: 'ln-vong' }),
      el('circle', { r: 3, class: 'ln-diem' }),
    ]);
    svg.appendChild(cham);
    svg.appendChild(chamTren);
    // nhãn tên Rack đang chọn: trên đầu mặt cắt và phía trên hình nhìn từ trên
    var tenCat = chu(110, BODY_TOP - 6, '', 'ln-ten');
    var tenTren = chu(CX, 12, '', 'ln-ten');
    tenCat.style.display = 'none';
    tenTren.style.display = 'none';
    svg.appendChild(tenCat);
    svg.appendChild(tenTren);

    var chuThich = document.createElement('p');
    chuThich.className = 'ln-chuthich';
    chuThich.setAttribute('aria-live', 'polite');
    var mac = 'Bấm vào Rack, hộp hoặc một ô trên lưới hộp để xem vị trí trong bình.';
    chuThich.textContent = mac;

    var truocDo = [];
    function tat() {
      truocDo.forEach(function (n) { n.classList.remove('ln-on'); });
      truocDo = [];
      cham.style.display = 'none';
      chamTren.style.display = 'none';
      tenCat.style.display = 'none';
      tenTren.style.display = 'none';
    }
    function dat(n) { n.classList.add('ln-on'); truocDo.push(n); }

    // báo cho nơi dùng biết mục đang chọn (điện thoại: hiện ngay trên thanh gập, khỏi phải mở mô hình)
    function baoChon(t) { if (opts.khiChon) opts.khiChon(t); }

    function chon(sel) {
      tat();
      if (!sel) { chuThich.textContent = mac; baoChon(''); return; }
      var v = sel.hop != null ? theoHop[sel.hop] : null;
      var gm = v ? v.gia : theoGia[sel.gia];
      if (!gm) { chuThich.textContent = mac; baoChon(''); return; }
      var rack = racks.filter(function (r) { return theoGia[r.id] === gm; })[0];
      dat(gm.el);
      var px, py;
      // tên Rack: «Rack N» (kèm tên riêng nếu khác); tên hộp lấy nguyên tên đã đặt, không thêm chữ «hộp» thừa
      var mo = 'Rack ' + rack.so + (rack.name && rack.name.trim().toLowerCase() !== 'rack ' + rack.so ? ' (' + rack.name + ')' : '');
      if (v) {
        dat(v.el);
        px = v.x + v.w / 2;
        py = v.y + v.h / 2;
        mo += ' · ' + (v.b.name ? v.b.name + (v.b.vi_tri ? ' (vị trí ' + v.b.vi_tri + ')' : '') : 'Hộp ' + (v.b.vi_tri ? 'vị trí ' + v.b.vi_tri : v.b.code));
        if (sel.row && sel.col && v.b.rows && v.b.cols) {
          px = v.x + (v.w * (sel.col - 0.5)) / v.b.cols;
          py = v.y + (Math.max(v.h, 2) * (sel.row - 0.5)) / v.b.rows;
          mo += ' · ô ' + String.fromCharCode(64 + sel.row) + sel.col;
        }
      } else {
        px = gm.x + gm.w / 2;
        py = BODY_TOP + 12;
      }
      cham.setAttribute('transform', 'translate(' + px.toFixed(1) + ' ' + py.toFixed(1) + ')');
      cham.style.display = '';
      var nhan = ngan(tenRack(rack));
      tenCat.textContent = nhan;
      tenCat.setAttribute('x', kepNhan(gm.x + gm.w / 2, nhan, 30, 190).toFixed(1));
      tenCat.style.display = '';
      tenTren.textContent = nhan;
      tenTren.setAttribute('x', kepNhan(CX, nhan, 210, 298).toFixed(1));
      tenTren.style.display = '';
      var t = viTriTren[rack.so];
      if (t) { chamTren.setAttribute('transform', 'translate(' + t.x.toFixed(1) + ' ' + t.y.toFixed(1) + ')'); chamTren.style.display = ''; }
      chuThich.textContent = mo + ' — chấm đỏ trên mô hình.';
      baoChon(mo);
    }

    var node = document.createElement('div');
    node.className = 'ln-hop-bao';
    node.appendChild(svg);
    node.appendChild(chuThich);
    return { node: node, chon: chon };
  }

  window.NhmBinhLn = { tao: tao };
})();
