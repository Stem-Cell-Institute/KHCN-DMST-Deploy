/**
 * Trang chủ: thẻ "Báo cáo phòng ban" nêu THẲNG việc cần làm cho người phải nộp báo cáo.
 *
 * Người nộp báo cáo thường không quen công nghệ: thẻ mặc định chỉ có chữ "Truy cập →" như mọi module khác nên
 * họ không biết mình đang có việc. Nếu phòng của họ có báo cáo cần nộp / cần chỉnh sửa thì thẻ hiện khung đỏ
 * "Có 1 báo cáo cần nộp", hạn nộp, và nút "Làm báo cáo ngay →" dẫn thẳng vào đúng báo cáo.
 *
 * Chỉ dùng GET /api/bao-cao-phong/viec-cua-toi: báo cáo phòng mình cần nộp (trưởng phòng) và hồ sơ chờ mình duyệt
 * (chỉ Viện trưởng). Người không thuộc module nhận danh sách rỗng, thẻ giữ nguyên.
 * Lỗi mạng hay chưa đăng nhập thì im lặng: thẻ vẫn như cũ, không làm hỏng trang chủ.
 */
(function () {
  'use strict';

  function conLai(han, homNayMs) {
    var homNay = new Date((homNayMs == null ? Date.now() : homNayMs) + 7 * 3600 * 1000).toISOString().slice(0, 10);
    var n = Math.round((Date.parse(han + 'T00:00:00Z') - Date.parse(homNay + 'T00:00:00Z')) / 86400000);
    if (isNaN(n)) return '';
    return n > 0 ? 'còn ' + n + ' ngày' : n === 0 ? 'hết hạn trong hôm nay' : 'đã quá hạn ' + (-n) + ' ngày';
  }

  function ngay(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s.split('-').reverse().join('/') : s || '';
  }

  /**
   * viec: báo cáo cần nộp/chỉnh sửa của phòng mình; hoSo: hồ sơ chờ Viện trưởng duyệt (rỗng nếu không phải Viện trưởng).
   * Dữ liệu chỉ vào DOM qua textContent.
   */
  function ap(card, viec, hoSo) {
    var cu = card.querySelector('.viec-the');
    if (cu) cu.remove();
    viec = viec || [];
    hoSo = hoSo || [];
    if ((!viec.length && !hoSo.length) || card.classList.contains('module-card--disabled')) return;
    var ds = viec.slice().sort(function (a, b) { return a.han_nop < b.han_nop ? -1 : a.han_nop > b.han_nop ? 1 : 0; });
    var b = ds[0];
    var nhieu = ds.length > 1;
    var canSua = !!b && b.trang_thai === 'can_chinh_sua';

    var khung = document.createElement('div');
    khung.className = 'viec-the';
    khung.setAttribute('role', 'status');
    function them(dam, chiTiet) {
      var d = document.createElement('strong');
      d.textContent = dam;
      khung.appendChild(d);
      if (chiTiet) {
        var s = document.createElement('span');
        s.textContent = chiTiet;
        khung.appendChild(s);
      }
    }
    if (hoSo.length) them(hoSo.length > 1 ? 'Có ' + hoSo.length + ' hồ sơ chờ bạn duyệt' : 'Có 1 hồ sơ chờ bạn duyệt', hoSo[0].tieu_de);
    if (ds.length) {
      them(nhieu ? 'Có ' + ds.length + ' báo cáo cần nộp' : canSua ? 'Có 1 báo cáo cần chỉnh sửa' : 'Có 1 báo cáo cần nộp',
        b.tieu_de + ' — hạn ' + ngay(b.han_nop) + ' (' + conLai(b.han_nop) + ')');
    }

    var nut = card.querySelector('.btn-access');
    if (nut) card.insertBefore(khung, nut);
    else card.appendChild(khung);
    card.classList.add('module-card--viec');
    if (nut) {
      var dich;
      if (hoSo.length && ds.length) { nut.textContent = 'Xem việc của bạn →'; dich = 'bao-cao-phong.html'; }
      else if (hoSo.length) { nut.textContent = 'Đọc và duyệt hồ sơ →'; dich = 'bao-cao-phong.html#/dot'; }
      else {
        nut.textContent = nhieu ? 'Xem các báo cáo cần nộp →' : canSua ? 'Chỉnh sửa báo cáo →' : 'Làm báo cáo ngay →';
        dich = 'bao-cao-phong.html' + (nhieu ? '#/cua-toi' : '#/bao-cao/' + b.id);
      }
      nut.classList.add('btn-access--viec');
      nut.onclick = function () { window.location.href = dich; };
    }
  }

  function chay() {
    var card = document.querySelector('.module-card[data-module="department_reports"]');
    var token = null;
    try { token = window.localStorage.getItem('token'); } catch (e) { /* chặn lưu trữ: bỏ qua */ }
    if (!card || !token) return;
    fetch('/api/bao-cao-phong/viec-cua-toi', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && Array.isArray(d.bao_cao)) ap(card, d.bao_cao, Array.isArray(d.ho_so_duyet) ? d.ho_so_duyet : []);
      })
      .catch(function () { /* thẻ giữ nguyên */ });
  }

  window.theBaoCaoPhong = { ap: ap, conLai: conLai };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', chay);
  else chay();
})();
