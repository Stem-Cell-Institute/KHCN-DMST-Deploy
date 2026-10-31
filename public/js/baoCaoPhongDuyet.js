/*
 * Màn hình DUYỆT BÁO CÁO của Viện trưởng (trang bao-cao-phong.html, mục #/duyet).
 * Dùng lại các hàm dựng của public/js/baoCaoPhong.js qua window.BCP và tự đăng ký vào BCP.views.duyet.
 *
 * Thiết kế cho người đọc nhiều báo cáo liên tiếp, ít bước nhất:
 *   - MỘT lần tải cả đợt (GET /dot/:id/vien-truong): chuyển giữa các phòng không chờ mạng.
 *   - Danh sách các phòng bên trái (điện thoại: thu thành một nút "Phòng … 3/12 ▾"), mỗi mục có trạng thái rõ ràng.
 *   - Thanh thao tác DÍNH ở đáy màn hình: Duyệt · Không duyệt · Ý kiến · Đề nghị chỉnh sửa, luôn thấy khi cuộn đọc.
 *   - "Duyệt" là MỘT chạm, không hỏi lại: quyết định đổi ý được (quyết định mới thay quyết định cũ, cả hai nằm trong lịch sử).
 *     Ba việc còn lại mở một ô nhập gọn ngay trên thanh, không bật hộp thoại che nội dung đang đọc.
 *   - Quyết định xong tự nhảy sang báo cáo kế tiếp chưa xử lý.
 *   - Phím tắt: J/K đổi báo cáo · N tới báo cáo chưa xử lý kế tiếp · D duyệt · X không duyệt · Y ý kiến · E đề nghị chỉnh sửa · Esc đóng ô nhập.
 *   - Phòng chưa nộp vẫn có mặt trong danh sách với nhãn "Chưa nộp" (không có nội dung, không bấm quyết định được).
 *
 * Mọi nội dung động dựng bằng DOM + textContent (hàm h), không dùng innerHTML. Nội dung nháp của phòng chưa nộp không bao giờ về tới đây:
 * máy chủ chỉ trả nội dung của báo cáo ĐÃ NỘP.
 */
(function () {
  'use strict';

  var B = window.BCP;
  if (!B) return;
  var h = B.h;
  var api = B.api;
  var thongBao = B.thongBao;
  var fmtGio = B.fmtGio;
  var fmtNgay = B.fmtNgay;

  // Nhãn ngắn cho danh sách bên trái (nhãn đầy đủ nằm ở B.TT_VT).
  var NGAN = {
    chua_nop: 'Chưa nộp', dang_sua: 'Đang chỉnh sửa', de_nghi_chinh_sua: 'Đã đề nghị sửa', cho_quyet_dinh: 'Chờ duyệt', duyet: 'Đã duyệt', khong_duyet: 'Không duyệt',
  };
  var DA_XU_LY = { duyet: 1, khong_duyet: 1, de_nghi_chinh_sua: 1 };
  var LOC = [
    ['tat_ca', 'Tất cả'],
    ['cho', 'Chờ duyệt'],
    ['xong', 'Đã xử lý'],
    ['chua', 'Chưa nộp / đang sửa'],
  ];
  var SOAN = {
    khong_duyet: { nhan: 'Lý do không duyệt', gui: 'Gửi, không duyệt', batBuoc: true },
    de_nghi_chinh_sua: { nhan: 'Nội dung đề nghị chỉnh sửa', gui: 'Gửi đề nghị chỉnh sửa', batBuoc: true },
    y_kien: { nhan: 'Ý kiến về báo cáo này', gui: 'Gửi ý kiến', batBuoc: true },
  };

  function chipNgan(ma) {
    var m = B.TT_VT[ma] || ['', ma, ''];
    return h('span', { class: 'nhan ' + m[2] }, h('span', { 'aria-hidden': 'true', text: m[0] }), NGAN[ma] || m[1]);
  }

  /** Thay toàn bộ con của el. replaceChildren không tự bỏ qua null / không tự trải mảng (nó đổi chúng thành chữ), nên làm phẳng ở đây. */
  function ghi(el, ds) {
    var phang = [];
    (function them(x) {
      if (x === null || x === undefined || x === false) return;
      if (Array.isArray(x)) x.forEach(them); else phang.push(x);
    })(ds);
    el.replaceChildren.apply(el, phang);
  }

  function docLive(msg) {
    B.live.textContent = '';
    setTimeout(function () { B.live.textContent = msg; }, 30);
  }

  // ══ Danh sách các đợt đã trình ═════════════════════════════════════════════
  function theDot(x, vienTruong) {
    var cho = x.cho_quyet_dinh > 0;
    return h('section', { class: cho ? 'viec-lon' : 'luu-y duyet-the-xong', 'aria-label': x.tieu_de },
      h('div', { class: 'viec-chu' },
        h('p', { class: 'viec-tieu', text: x.tieu_de }),
        h('p', { class: 'viec-phu', text: (cho ? x.cho_quyet_dinh + ' báo cáo chờ quyết định · ' : 'Đã xử lý xong · ') + 'đã nộp ' + x.da_nop + '/' + x.tong + (x.chua_nop ? ' · chưa nộp ' + x.chua_nop : '') + ' · hạn ' + fmtNgay(x.han_nop) }),
        h('p', { class: 'mo', text: 'Trình' + (x.lan > 1 ? ' (lần ' + x.lan + ')' : '') + ' bởi ' + (x.nguoi_trinh || '—') + ' lúc ' + fmtGio(x.trinh_luc) }),
        x.loi_nhan ? h('p', { class: 'viec-nx' }, h('strong', { text: 'Lời nhắn: ' }), x.loi_nhan) : null),
      h('a', { class: cho ? 'btn btn-lon' : 'btn btn-phu', href: '#/duyet/' + x.dot_id }, cho ? (vienTruong ? 'Đọc và duyệt →' : 'Xem →') : 'Xem lại →'));
  }

  function veDanhSachDot(tq) {
    var vt = !!B.me().vien_truong;
    var cho = tq.dot_cho_vien_truong || [];
    var xong = (tq.dot_da_trinh || []).filter(function (x) { return x.cho_quyet_dinh === 0; });
    var node = [h('div', { class: 'thanh-tieu-de' }, h('div', null,
      h('h2', { text: 'Duyệt báo cáo' }),
      h('p', { class: 'phu', text: vt
        ? 'Các đợt đã được người quản lý module trình. Đọc báo cáo của từng phòng rồi bấm Duyệt, Không duyệt, Ý kiến hoặc Đề nghị chỉnh sửa; không cần tải tệp.'
        : 'Các đợt đã trình Viện trưởng. Bạn xem được như Viện trưởng, nhưng chỉ Viện trưởng đưa ra quyết định.' })))];
    if (!cho.length && !xong.length) {
      node.push(h('div', { class: 'trong', text: 'Chưa có đợt nào được trình. Khi người quản lý module trình một đợt, báo cáo của các phòng sẽ hiện ở đây.' }));
    }
    if (cho.length) node.push(h('h3', { text: 'Chờ quyết định (' + cho.length + ')' }), cho.map(function (x) { return theDot(x, vt); }));
    if (xong.length) node.push(h('h3', { text: 'Đã xử lý xong' }), xong.map(function (x) { return theDot(x, vt); }));
    ghi(B.main, node);
  }

  // ══ Màn hình đọc và duyệt một đợt ═════════════════════════════════════════
  function viewDoc(dotId, chonId) {
    return api('/dot/' + dotId + '/vien-truong').then(function (data) {
      var S = { data: data, idx: 0, loc: 'tat_ca', moDs: false, soan: null, dangGui: false };
      var khung = h('div', { class: 'duyet' });
      var dau = h('div', { class: 'duyet-dau' });
      var ds = h('nav', { class: 'duyet-ds', id: 'duyet-ds', 'aria-label': 'Danh sách báo cáo của các phòng' });
      var bai = h('article', { class: 'duyet-bai', 'aria-labelledby': 'duyet-bai-tieu-de' });
      var thanh = h('div', { class: 'duyet-thao-tac', role: 'region', 'aria-label': 'Thao tác với báo cáo đang đọc' });
      khung.append(dau, h('div', { class: 'duyet-luoi' }, ds, bai), thanh);

      function cur() { return S.data.bao_cao[S.idx]; }
      function quyenQuyetDinh() { return !!S.data.co_the.quyet_dinh; }
      function duocQuyetDinh(b) { return quyenQuyetDinh() && (b.trang_thai === 'da_nop' || b.trang_thai === 'da_duyet'); }
      function duocYKien(b) { return !!S.data.co_the.y_kien && b.trang_thai !== 'chua_nop'; }

      function locOk(b) {
        var q = b.vt_trang_thai;
        if (S.loc === 'cho') return q === 'cho_quyet_dinh';
        if (S.loc === 'xong') return !!DA_XU_LY[q];
        if (S.loc === 'chua') return q === 'chua_nop' || q === 'dang_sua';
        return true;
      }
      function demTheo(q) { return S.data.bao_cao.filter(function (b) { return b.vt_trang_thai === q; }).length; }
      function soTheoLoc(ma) {
        var luu = S.loc; S.loc = ma;
        var n = S.data.bao_cao.filter(locOk).length;
        S.loc = luu;
        return n;
      }
      /** Chỉ số (trong toàn bộ danh sách) của các báo cáo đang hiện theo bộ lọc. */
      function hienThi() {
        var r = [];
        S.data.bao_cao.forEach(function (b, i) { if (locOk(b) || i === S.idx) r.push(i); });
        return r;
      }
      function buoc(huong) {
        var d = hienThi();
        if (d.length < 2) return;
        var vt = d.indexOf(S.idx);
        chon(d[(vt + huong + d.length) % d.length], true);
      }
      function tiepChoXuLy() {
        var n = S.data.bao_cao.length;
        for (var k = 1; k <= n; k++) {
          var i = (S.idx + k) % n;
          if (S.data.bao_cao[i].vt_trang_thai === 'cho_quyet_dinh' && i !== S.idx) return i;
        }
        return -1;
      }

      // ── Đầu trang: tên đợt, tiến độ ─────────────────────────────────────────
      function veDau() {
        var d = S.data.dot;
        var xuLy = S.data.bao_cao.filter(function (b) { return DA_XU_LY[b.vt_trang_thai]; }).length;
        var cho = demTheo('cho_quyet_dinh');
        var chuaNop = demTheo('chua_nop') + demTheo('dang_sua');
        var nodes = [
          h('a', { class: 'btn btn-phu btn-nho', href: '#/duyet/ds' }, '← Các đợt đã trình'),
          h('h2', { text: 'Duyệt báo cáo: ' + d.tieu_de }),
          h('p', { class: 'phu duyet-meta', text: (LOAI_DOT_NHAN[d.loai] || '') + (d.ky ? ' ' + d.ky : '') + ' · hạn nộp ' + fmtNgay(d.han_nop) + (S.data.trinh ? ' · trình lúc ' + fmtGio(S.data.trinh.trinh_luc) + (S.data.trinh.nguoi_trinh ? ' bởi ' + S.data.trinh.nguoi_trinh : '') : '') }),
        ];
        // Lời nhắn: hiện sẵn trên màn hình rộng; trên điện thoại thu lại để báo cáo lên được màn hình đầu.
        if (S.data.trinh && S.data.trinh.loi_nhan) {
          var heP = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
          nodes.push(h('details', { class: 'duyet-nhan', open: !heP }, h('summary', { text: 'Lời nhắn của người quản lý' }), h('p', { text: S.data.trinh.loi_nhan })));
        }
        if (!S.data.trinh) {
          nodes.push(h('div', { class: 'luu-y', role: 'status' }, h('p', { text: 'Đợt này chưa được người quản lý module trình Viện trưởng. Bạn đọc được báo cáo nhưng chưa quyết định được.' })));
        } else if (!S.data.co_the.quyet_dinh) {
          nodes.push(h('div', { class: 'luu-y', role: 'status' }, h('p', { text: 'Bạn đang xem như Viện trưởng (chỉ đọc). Chỉ Viện trưởng đưa ra quyết định.' })));
        }
        var tong = xuLy + cho;
        var nutTiep = h('button', { type: 'button', class: 'btn btn-phu btn-nho', disabled: tiepChoXuLy() < 0, onclick: function () { var i = tiepChoXuLy(); if (i >= 0) chon(i, true); } }, 'Báo cáo chờ duyệt kế tiếp ›');
        nodes.push(h('div', { class: 'duyet-tien-do' },
          h('progress', { max: tong || 1, value: xuLy, 'aria-label': 'Đã xử lý ' + xuLy + ' trên ' + tong + ' báo cáo đã nộp' }),
          h('span', { class: 'con-so', text: 'Đã xử lý ' + xuLy + '/' + tong + ' báo cáo đã nộp' + (chuaNop ? ' · ' + chuaNop + ' chưa nộp hoặc đang sửa' : '') }),
          nutTiep));
        // Điện thoại: danh sách thu lại thành một nút, bấm mới bung ra.
        var b = cur();
        nodes.push(h('button', { type: 'button', class: 'btn btn-phu duyet-chon', 'aria-expanded': S.moDs ? 'true' : 'false', 'aria-controls': 'duyet-ds', onclick: function () {
            S.moDs = !S.moDs;
            ds.classList.toggle('mo', S.moDs);
            veDau();
            // Bung danh sách thì đưa nút lên đầu màn hình để thấy ngay các phòng, không bị thanh dưới che.
            var nut = dau.querySelector('.duyet-chon');
            if (S.moDs && nut && nut.scrollIntoView) nut.scrollIntoView({ block: 'start' });
          } },
          h('span', { text: b.phong_ten + (b.chu_ten ? ' — ' + b.chu_ten : '') + ' · ' + (S.idx + 1) + '/' + S.data.bao_cao.length }), h('span', { 'aria-hidden': 'true', text: S.moDs ? '▴' : '▾' })));
        ghi(dau, nodes);
      }

      // ── Danh sách các phòng ─────────────────────────────────────────────────
      function veDanhSach() {
        var chips = h('div', { class: 'duyet-loc', role: 'group', 'aria-label': 'Lọc danh sách' }, LOC.map(function (l) {
          return h('button', { type: 'button', class: 'duyet-loc-nut', 'aria-pressed': S.loc === l[0] ? 'true' : 'false', onclick: function () { S.loc = l[0]; veDanhSach(); } }, l[1] + ' (' + soTheoLoc(l[0]) + ')');
        }));
        var muc = hienThi();
        var ol = h('ol', null, muc.length ? muc.map(function (i) {
          var b = S.data.bao_cao[i];
          return h('li', null, h('button', {
            type: 'button', class: 'duyet-muc', 'data-i': i, 'aria-current': i === S.idx ? 'true' : null,
            onclick: function () { chon(i, true); },
          },
            h('span', { class: 'duyet-muc-ten', text: b.phong_ten }),
            b.chu_ten ? h('span', { class: 'duyet-muc-phu', text: b.chu_ten }) : null,
            chipNgan(b.vt_trang_thai)));
        }) : h('li', { class: 'duyet-muc-trong', text: 'Không có báo cáo nào trong mục này.' }));
        ghi(ds, [chips, ol]);
        var dang = ds.querySelector('[aria-current="true"]');
        if (dang && dang.scrollIntoView) dang.scrollIntoView({ block: 'nearest' });
      }

      // ── Báo cáo đang đọc ────────────────────────────────────────────────────
      function veYKien(vung, b) {
        if (!b.y_kien.length) { ghi(vung, null); return; }
        ghi(vung, [h('h3', { text: 'Ý kiến đã gửi (' + b.y_kien.length + ')' }), b.y_kien.map(function (k) {
          return h('div', { class: 'y-kien' }, h('p', { class: 'y-kien-nd', text: k.noi_dung }), h('p', { class: 'mo', text: (k.nguoi || 'Viện trưởng') + ' · ' + fmtGio(k.tao_luc) }));
        })]);
      }

      function bangQuyetDinh(b) {
        var q = b.vien_truong;
        if (!q) return null;
        var ten = 'Viện trưởng' + (q.nguoi ? ' ' + q.nguoi : '');
        if (q.quyet_dinh === 'duyet') {
          return h('div', { class: 'luu-y', role: 'status' }, h('p', null, h('strong', { text: ten + ' đã duyệt báo cáo này' }), ' · ' + fmtGio(q.luc)), q.ghi_chu ? h('p', { text: 'Ghi chú: ' + q.ghi_chu }) : null);
        }
        if (q.quyet_dinh === 'khong_duyet') {
          return h('div', { class: 'luu-y luu-y-do', role: 'status' }, h('p', null, h('strong', { text: ten + ' không duyệt báo cáo này' }), ' · ' + fmtGio(q.luc)), h('p', { text: 'Lý do: ' + q.ghi_chu }),
            h('p', { class: 'mo', text: 'Báo cáo vẫn giữ nguyên trạng thái đã nộp. Đã gửi email lý do cho phòng và người quản lý module.' }));
        }
        return h('div', { class: 'luu-y luu-y-do', role: 'status' }, h('p', null, h('strong', { text: ten + ' đã đề nghị phòng chỉnh sửa' }), ' · ' + fmtGio(q.luc)), h('p', { text: q.ghi_chu }),
          h('p', { class: 'mo', text: 'Báo cáo đã trả về phòng. Khi phòng nộp lại, báo cáo hiện lại ở đây để chờ quyết định.' }));
      }

      function veBai() {
        var b = cur();
        var d = S.data.dot;
        var phuTrach = b.chu_ten ? b.chu_ten + (b.chuc_danh && B.CHUC_DANH[b.chuc_danh] ? ' — ' + B.CHUC_DANH[b.chuc_danh] : '') : '';
        var meta = [];
        if (phuTrach) meta.push('Phụ trách: ' + phuTrach);
        else if (b.nguoi_nop) meta.push('Người nộp: ' + b.nguoi_nop);
        if (b.nop_luc) meta.push('Nộp lúc ' + fmtGio(b.nop_luc));
        var nodes = [
          h('p', { class: 'duyet-bai-so', text: 'Báo cáo ' + (S.idx + 1) + '/' + S.data.bao_cao.length }),
          h('h3', { id: 'duyet-bai-tieu-de', class: 'duyet-bai-ten', tabindex: '-1', text: b.phong_ten }),
          meta.length ? h('p', { class: 'mo', text: meta.join(' · ') }) : null,
          h('p', { class: 'duyet-nhan-hang' }, B.nhan(B.TT_VT, b.vt_trang_thai),
            b.trang_thai === 'da_duyet' ? [' ', h('span', { class: 'nhan' }, h('span', { 'aria-hidden': 'true', text: '✓' }), 'Quản lý đã xác nhận')] : null,
            b.tre_han ? [' ', B.nhanTreHan()] : null),
          bangQuyetDinh(b),
        ];
        if (b.trang_thai === 'chua_nop') {
          nodes.push(h('div', { class: 'duyet-trong' }, h('p', { class: 'duyet-trong-chinh', text: 'Chưa nộp' }),
            h('p', { text: b.phong_ten + ' chưa nộp báo cáo. Hạn nộp ' + fmtNgay(d.han_nop) + ' (' + B.conLaiNgay(d.han_nop) + ').' }),
            h('p', { class: 'mo', text: 'Chưa có nội dung để đọc. Khi phòng nộp, báo cáo hiện ở đây; người quản lý module có thể trình lại để nhắc bạn.' })));
        } else if (b.trang_thai === 'can_chinh_sua') {
          nodes.push(h('div', { class: 'duyet-trong' }, h('p', { class: 'duyet-trong-chinh', text: 'Phòng đang chỉnh sửa' }),
            b.nhan_xet ? h('p', { text: (b.nhan_xet_boi === 'vien_truong' ? 'Viện trưởng' : 'Người quản lý') + ' yêu cầu chỉnh sửa: ' + b.nhan_xet }) : null,
            h('p', { class: 'mo', text: 'Báo cáo hiện lại ở đây khi phòng nộp lại.' })));
        } else if (b.du_lieu) {
          nodes.push(B.dungXemLai(S.data.truong, b.du_lieu));
        }
        var yKien = h('section', { class: 'duyet-y-kien', 'aria-label': 'Ý kiến đã gửi' });
        veYKien(yKien, b);
        nodes.push(yKien);
        if (b.lich_su.length) {
          nodes.push(h('details', { class: 'duyet-lich-su' }, h('summary', { text: 'Lịch sử báo cáo (' + b.lich_su.length + ')' }),
            h('ul', { class: 'lich-su' }, b.lich_su.map(function (l) {
              return h('li', null, h('strong', { text: B.HANH_DONG[l.hanh_dong] || l.hanh_dong }), ' — ', l.nguoi || 'Không rõ', ' · ', fmtGio(l.tao_luc), l.ghi_chu ? h('span', { class: 'ghi-chu', text: l.ghi_chu }) : null);
            }))));
        }
        ghi(bai, nodes);
        bai._yKien = yKien;
      }

      // ── Thanh thao tác dính ─────────────────────────────────────────────────
      function nutQD(ma, chu, glyph, phim, lop, bat, daChon, hanhDong) {
        return h('button', {
          type: 'button', class: 'btn duyet-qd ' + lop, disabled: !bat || S.dangGui, 'aria-pressed': daChon ? 'true' : 'false',
          'aria-keyshortcuts': phim.toUpperCase(), title: chu + ' (phím ' + phim.toUpperCase() + ')', 'data-qd': ma, onclick: hanhDong,
        }, h('span', { class: 'duyet-glyph', 'aria-hidden': 'true', text: glyph }), h('span', { class: 'duyet-chu', text: chu }), h('kbd', { class: 'duyet-phim', 'aria-hidden': 'true', text: phim.toUpperCase() }));
      }

      function veSoan(b) {
        var cau = SOAN[S.soan.loai];
        var nd = h('textarea', { id: 'duyet-soan-nd', rows: 3, maxlength: 2000, 'aria-describedby': 'duyet-soan-tro' });
        nd.value = S.soan.nd || '';
        nd.addEventListener('input', function () { S.soan.nd = nd.value; });
        nd.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') { e.preventDefault(); dongSoan(); }
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); guiSoan(); }
        });
        var loi = h('p', { class: 'loi-truong', role: 'alert', hidden: !S.soan.loi }, S.soan.loi || '');
        // Ngắn gọn: người nhận đã rõ từ tên phòng ở tiêu đề báo cáo; số người nhận thật được báo lại sau khi gửi.
        var nguoiNhan = 'email cho người phụ trách' + (b.chu_ten ? ' (' + b.chu_ten + ')' : '') + ' và người quản lý module';
        var ghiChu = 'Gửi ' + nguoiNhan + '.';
        if (S.soan.loai === 'y_kien') ghiChu = 'Lưu trong báo cáo và gửi ' + nguoiNhan + '.';
        if (S.soan.loai === 'khong_duyet') ghiChu += ' Báo cáo giữ nguyên trạng thái đã nộp.';
        if (S.soan.loai === 'de_nghi_chinh_sua') ghiChu += ' Báo cáo trở về "Cần chỉnh sửa".' + (S.data.dot.trang_thai === 'dong' ? ' Đợt đã đóng sẽ tự mở lại.' : '');
        var form = h('form', { class: 'duyet-soan', novalidate: true },
          h('label', { for: 'duyet-soan-nd' }, cau.nhan, cau.batBuoc ? h('span', { class: 'bat-buoc', 'aria-hidden': 'true', text: ' *' }) : null),
          h('p', { class: 'tro-giup', id: 'duyet-soan-tro', text: ghiChu }),
          nd, loi,
          h('div', { class: 'nhom-nut' },
            h('button', { type: 'submit', class: 'btn', disabled: S.dangGui }, cau.gui),
            h('button', { type: 'button', class: 'btn btn-phu', onclick: dongSoan }, 'Hủy'),
            h('span', { class: 'mo duyet-goi-y', text: 'Ctrl+Enter để gửi · Esc để đóng' })));
        form.addEventListener('submit', function (e) { e.preventDefault(); guiSoan(); });
        return form;
      }

      function veThanh() {
        var b = cur();
        var coQuyen = quyenQuyetDinh();
        var qd = b.vien_truong ? b.vien_truong.quyet_dinh : null;
        var n = S.data.bao_cao.length;
        var nodes = [];
        if (S.soan && coQuyen) nodes.push(veSoan(b));
        var dieuHuong = h('div', { class: 'duyet-dh' },
          h('button', { type: 'button', class: 'btn btn-phu duyet-dh-nut', 'aria-label': 'Báo cáo trước (phím K)', title: 'Báo cáo trước (K)', onclick: function () { buoc(-1); } }, '‹'),
          h('span', { class: 'duyet-vi-tri con-so', text: (S.idx + 1) + '/' + n }),
          h('button', { type: 'button', class: 'btn btn-phu duyet-dh-nut', 'aria-label': 'Báo cáo sau (phím J)', title: 'Báo cáo sau (J)', onclick: function () { buoc(1); } }, '›'));
        var hang = [dieuHuong];
        if (coQuyen) {
          var bat = duocQuyetDinh(b);
          hang.push(h('div', { class: 'duyet-nut' },
            nutQD('duyet', 'Duyệt', '✓', 'd', 'duyet-qd-duyet', bat, qd === 'duyet', function () { guiQuyetDinh('duyet', ''); }),
            nutQD('khong_duyet', 'Không duyệt', '✕', 'x', 'duyet-qd-khong', bat, qd === 'khong_duyet' || (S.soan && S.soan.loai === 'khong_duyet'), function () { moSoan('khong_duyet'); }),
            nutQD('y_kien', 'Ý kiến', '✎', 'y', 'duyet-qd-y-kien', duocYKien(b), !!(S.soan && S.soan.loai === 'y_kien'), function () { moSoan('y_kien'); }),
            nutQD('de_nghi_chinh_sua', 'Đề nghị chỉnh sửa', '↺', 'e', 'duyet-qd-sua', bat, qd === 'de_nghi_chinh_sua' || (S.soan && S.soan.loai === 'de_nghi_chinh_sua'), function () { moSoan('de_nghi_chinh_sua'); })));
        }
        nodes.push(h('div', { class: 'duyet-hang' }, hang));
        if (coQuyen) nodes.push(h('p', { class: 'mo duyet-phim-goi-y', text: 'Phím tắt: J sau · K trước · N báo cáo chờ kế tiếp · D duyệt · X không duyệt · Y ý kiến · E đề nghị chỉnh sửa' }));
        ghi(thanh, nodes);
      }

      // ── Hành động ───────────────────────────────────────────────────────────
      function moSoan(loai) {
        var b = cur();
        if (S.dangGui) return;
        if (loai === 'y_kien' ? !duocYKien(b) : !duocQuyetDinh(b)) return;
        if (S.soan && S.soan.loai === loai) { dongSoan(); return; }
        S.soan = { loai: loai, nd: '', loi: '' };
        veThanh();
        var o = document.getElementById('duyet-soan-nd');
        if (o) o.focus();
      }
      function dongSoan() { S.soan = null; veThanh(); }

      function guiSoan() {
        if (!S.soan || S.dangGui) return;
        var loai = S.soan.loai;
        var nd = (S.soan.nd || '').trim();
        if (!nd) {
          S.soan.loi = loai === 'khong_duyet' ? 'Hãy ghi lý do không duyệt.' : loai === 'y_kien' ? 'Hãy nhập nội dung ý kiến.' : 'Hãy ghi rõ nội dung đề nghị chỉnh sửa.';
          veThanh();
          var o = document.getElementById('duyet-soan-nd');
          if (o) o.focus();
          return;
        }
        if (loai === 'y_kien') guiYKien(nd); else guiQuyetDinh(loai, nd);
      }

      function baoLoi(e) {
        if (S.soan) { S.soan.loi = e.message; veThanh(); }
        else thongBao(e.message, 'loi');
      }

      function guiYKien(nd) {
        var b = cur();
        S.dangGui = true;
        veThanh();
        api('/bao-cao/' + b.id + '/y-kien', { method: 'POST', body: { noi_dung: nd } })
          .then(function (r) {
            if (r.y_kien) b.y_kien.push(r.y_kien);
            var nhanThu = [];
            if (r.da_bao) nhanThu.push(r.da_bao + ' người phụ trách');
            if (r.da_bao_quan_ly) nhanThu.push(r.da_bao_quan_ly + ' người quản lý module');
            thongBao(nhanThu.length ? 'Đã gửi ý kiến. Email đã gửi tới ' + nhanThu.join(' và ') + '.' : 'Đã lưu ý kiến. Chưa có ai nhận email vì phòng này chưa có người phụ trách.');
            S.soan = null;
            if (bai._yKien) veYKien(bai._yKien, b);
          })
          .catch(baoLoi)
          .then(function () { S.dangGui = false; veThanh(); });
      }

      function capNhatCucBo(b, qd, r, ghiChu) {
        b.vien_truong = r.vien_truong;
        b.vt_trang_thai = r.vt_trang_thai;
        b.trang_thai = r.trang_thai;
        if (!r.khong_doi && r.vien_truong) b.lich_su.push({ hanh_dong: 'vt_' + qd, nguoi: r.vien_truong.nguoi, ghi_chu: ghiChu || null, tao_luc: r.vien_truong.luc });
        if (qd === 'de_nghi_chinh_sua') { b.nhan_xet = ghiChu; b.nhan_xet_boi = 'vien_truong'; b.du_lieu = null; }
        if (r.dot_mo_lai) S.data.dot.trang_thai = 'dang_mo';
      }

      function guiQuyetDinh(qd, ghiChu) {
        if (S.dangGui) return;
        var b = cur();
        S.dangGui = true;
        veThanh();
        api('/bao-cao/' + b.id + '/quyet-dinh', { method: 'POST', body: { quyet_dinh: qd, ghi_chu: ghiChu, nop_luc: b.nop_luc } })
          .then(function (r) {
            capNhatCucBo(b, qd, r, ghiChu);
            var nhanThu = [];
            if (r.da_bao) nhanThu.push(r.da_bao + ' người phụ trách');
            if (r.da_bao_quan_ly) nhanThu.push(r.da_bao_quan_ly + ' người quản lý module');
            var kq = { duyet: 'Đã duyệt', khong_duyet: 'Đã ghi: không duyệt', de_nghi_chinh_sua: 'Đã đề nghị chỉnh sửa' }[qd] + ' — ' + b.phong_ten + '.';
            if (r.khong_doi) kq = 'Quyết định này đã được ghi trước đó.';
            else if (nhanThu.length) kq += ' Email đã gửi tới ' + nhanThu.join(' và ') + '.';
            if (r.dot_mo_lai) kq += ' Đợt đã được mở lại để phòng chỉnh sửa.';
            thongBao(kq);
            B.lamMoiTongQuan();
            S.soan = null;
            var tiep = r.khong_doi ? -1 : tiepChoXuLy();
            if (tiep >= 0) chon(tiep, true);
            else { veDau(); veDanhSach(); veBai(); if (!r.khong_doi && !demTheo('cho_quyet_dinh')) thongBao(kq + ' Đã xử lý hết các báo cáo đang chờ.'); }
          })
          .catch(function (e) {
            if (e.status === 409) { thongBao(e.message, 'loi'); S.soan = null; return taiLai(b.id); }
            baoLoi(e);
          })
          .then(function () { S.dangGui = false; veThanh(); });
      }

      /** Báo cáo đã đổi phía máy chủ (vd. phòng vừa nộp lại): tải lại cả đợt và giữ nguyên báo cáo đang đọc. */
      function taiLai(giuId) {
        return api('/dot/' + dotId + '/vien-truong').then(function (data) {
          S.data = data;
          var i = 0;
          data.bao_cao.forEach(function (x, k) { if (x.id === giuId) i = k; });
          chon(i, false);
        }).catch(function (e) { thongBao(e.message, 'loi'); });
      }

      function chon(i, cuon) {
        S.idx = i;
        S.soan = null;
        S.moDs = false;
        ds.classList.remove('mo');
        veDau();
        veDanhSach();
        veBai();
        veThanh();
        var b = cur();
        B.datHash('#/duyet/' + dotId + '/' + b.id);
        docLive(b.phong_ten + ', báo cáo ' + (i + 1) + ' trên ' + S.data.bao_cao.length + ', ' + B.TT_VT[b.vt_trang_thai][1]);
        if (cuon) {
          var top = khung.querySelector('.duyet-luoi').getBoundingClientRect().top + window.pageYOffset - 8;
          window.scrollTo(0, Math.max(0, top));
          var tieuDe = document.getElementById('duyet-bai-tieu-de');
          if (tieuDe) tieuDe.focus({ preventScroll: true });
        }
      }

      // ── Phím tắt ────────────────────────────────────────────────────────────
      function phim(e) {
        if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
        var t = e.target;
        var tag = t && t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
        if (document.querySelector('dialog[open]')) return;
        var b = cur();
        if (!b) return;
        switch ((e.key || '').toLowerCase()) {
          case 'j': buoc(1); break;
          case 'k': buoc(-1); break;
          case 'n': { var i = tiepChoXuLy(); if (i >= 0) chon(i, true); break; }
          case 'd': if (quyenQuyetDinh() && duocQuyetDinh(b)) guiQuyetDinh('duyet', ''); else return; break;
          case 'x': if (quyenQuyetDinh()) moSoan('khong_duyet'); else return; break;
          case 'y': if (quyenQuyetDinh()) moSoan('y_kien'); else return; break;
          case 'e': if (quyenQuyetDinh()) moSoan('de_nghi_chinh_sua'); else return; break;
          case 'escape': if (S.soan) dongSoan(); else return; break;
          default: return;
        }
        e.preventDefault();
      }
      document.addEventListener('keydown', phim);
      document.body.classList.add('co-thanh-duyet');
      B.khiRoiTrang(function () {
        document.removeEventListener('keydown', phim);
        document.body.classList.remove('co-thanh-duyet');
      });

      // Báo cáo mở đầu: theo liên kết nếu có, không thì báo cáo đầu tiên đang chờ quyết định, không thì báo cáo đầu tiên.
      var dau0 = -1;
      data.bao_cao.forEach(function (b, i) { if (dau0 < 0 && b.id === chonId) dau0 = i; });
      if (dau0 < 0) data.bao_cao.forEach(function (b, i) { if (dau0 < 0 && b.vt_trang_thai === 'cho_quyet_dinh') dau0 = i; });
      S.idx = Math.max(0, dau0);
      ghi(B.main, khung);
      if (!data.bao_cao.length) {
        ghi(khung, [h('h2', { text: 'Duyệt báo cáo: ' + data.dot.tieu_de }), h('div', { class: 'trong', text: 'Đợt này chưa có báo cáo nào.' })]);
        return;
      }
      veDau();
      veDanhSach();
      veBai();
      veThanh();
      B.datHash('#/duyet/' + dotId + '/' + cur().id);
    });
  }

  var LOAI_DOT_NHAN = B.LOAI_DOT;

  // ══ Định tuyến của mục #/duyet ════════════════════════════════════════════
  B.views.duyet = function (args) {
    var dotId = Number(args[0]);
    if (dotId > 0) return viewDoc(dotId, Number(args[1]) || 0);
    var vienTruong = !!B.me().vien_truong;
    return api('/tong-quan').then(function (tq) {
      // Viện trưởng chỉ có MỘT đợt đang chờ thì vào thẳng đó: bớt một bước.
      // "#/duyet/ds" luôn hiện danh sách (nút "Các đợt đã trình" dẫn tới đây), nên vẫn đi tới được danh sách khi cần.
      var cho = tq.dot_cho_vien_truong || [];
      if (args[0] !== 'ds' && vienTruong && cho.length === 1) return viewDoc(cho[0].dot_id, 0);
      veDanhSachDot(tq);
    });
  };
})();
