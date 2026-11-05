/**
 * Khôi phục phiên đăng nhập từ token trong localStorage (xem routes/phien.js để biết vì sao).
 *
 *   <script src="/public/js/khoi-phuc-phien.js" data-tu-dong="trang-chu"></script>   — trang chủ
 *   <script src="/public/js/khoi-phuc-phien.js" data-tu-dong="dang-nhap"></script>   — trang đăng nhập
 *
 * trang-chu : mỗi lần mở trình duyệt (một lượt sessionStorage) tự cấp lại cookie / gia hạn token, để bấm vào module không bị hỏi lại.
 *             Token đã hỏng/hết hạn thì xóa khỏi localStorage và nạp lại trang để trang chủ hiện đúng trạng thái "chưa đăng nhập".
 * dang-nhap : chỉ khi trang được mở do bị chuyển từ một trang cần đăng nhập (có returnUrl): thử khôi phục rồi quay lại trang đó,
 *             người dùng không phải gõ lại mật khẩu. Không khôi phục được thì hiện biểu mẫu đăng nhập kèm lời nhắn.
 *             Có chốt chặn vòng lặp (15 giây) phòng trường hợp trình duyệt chặn cookie.
 */
(function () {
  'use strict';

  var KHOA_THU_LAI = 'khoiPhucPhienLuc';
  var KHOA_TRANG_CHU = 'khoiPhucPhienTrangChu';
  var CHO_THU_LAI_MS = 15000;

  function luu(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function xoaPhien() { try { window.localStorage.removeItem('token'); window.localStorage.removeItem('user'); } catch (e) { /* bỏ qua */ } }
  function ss(k, v) {
    try {
      if (v === undefined) return window.sessionStorage.getItem(k);
      window.sessionStorage.setItem(k, v);
    } catch (e) { /* bỏ qua */ }
    return null;
  }

  /** @returns {Promise<'ok'|'het_han'|'loi'|'khong_co'>} */
  function khoiPhuc() {
    var token = luu('token');
    if (!token) return Promise.resolve('khong_co');
    return fetch('/api/phien/khoi-phuc', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (r.ok && d && d.token) {
            try {
              window.localStorage.setItem('token', d.token);
              if (d.user) window.localStorage.setItem('user', JSON.stringify(d.user));
            } catch (e) { /* bỏ qua */ }
            return 'ok';
          }
          if (r.status === 401 || r.status === 403) { xoaPhien(); return 'het_han'; }
          return 'loi';
        });
      })
      .catch(function () { return 'loi'; });
  }
  window.khoiPhucPhien = khoiPhuc;

  /** Chỉ nhận đường dẫn trong chính hệ thống (chống chuyển hướng ra ngoài). */
  function returnUrlHopLe(u) {
    if (!u || u.indexOf('..') !== -1 || u.indexOf('//') !== -1 || u.indexOf('\\') !== -1) return false;
    return /^\/?[a-zA-Z0-9_\-./]+\.html(?:[?#][^\s]*)?$/.test(u);
  }
  function returnUrlTuTrang() {
    var m = /[?&]returnUrl=([^&]+)/.exec(window.location.search);
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
  }

  var che = document.currentScript && document.currentScript.getAttribute('data-tu-dong');

  if (che === 'trang-chu') {
    if (luu('token') && !ss(KHOA_TRANG_CHU)) {
      ss(KHOA_TRANG_CHU, '1');
      khoiPhuc().then(function (kq) { if (kq === 'het_han') window.location.reload(); });
    }
  }

  if (che === 'dang-nhap') {
    var dich = returnUrlTuTrang();
    var lanTruoc = Number(ss(KHOA_THU_LAI)) || 0;
    var chuaThuGanDay = Date.now() - lanTruoc > CHO_THU_LAI_MS;
    if (dich && returnUrlHopLe(dich) && luu('token') && !chuaThuGanDay) {
      // Vừa khôi phục xong mà vẫn bị chuyển về đây: nhiều khả năng trình duyệt chặn cookie. Không thử lại, nhờ người dùng đăng nhập.
      var canh = document.getElementById('msg');
      if (canh) {
        canh.textContent = 'Chưa khôi phục được phiên đăng nhập tự động. Vui lòng đăng nhập lại.';
        canh.className = 'msg error';
      }
    } else if (dich && returnUrlHopLe(dich) && luu('token') && chuaThuGanDay) {
      ss(KHOA_THU_LAI, String(Date.now()));
      khoiPhuc().then(function (kq) {
        if (kq === 'ok') { window.location.replace(dich); return; }
        var el = document.getElementById('msg');
        if (el && kq === 'het_han') {
          el.textContent = 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
          el.className = 'msg error';
        }
      });
    }
  }
})();
