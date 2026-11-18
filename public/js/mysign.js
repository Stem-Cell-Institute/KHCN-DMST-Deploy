/*
 * Ký số MySign phía trình duyệt — dùng chung cho mọi trang có ký số (API ở routes/mysign.js).
 * Chỉ gồm việc gọi API và theo dõi một yêu cầu ký; giao diện do từng trang tự dựng.
 *
 *   MySign.taiKhoan()            → {da_cau_hinh, tai_khoan|null}
 *   MySign.lienKet(maTaiKhoan)   → {tai_khoan}   (lỗi: Error có .message đọc được)
 *   MySign.theoDoi(id, moiLan, xong) → hỏi trạng thái vài giây một lần cho tới khi xong; trả hàm dừng.
 */
(function () {
  'use strict';

  var CHU_KY_HOI_MS = 3000;

  function goi(duong, opt) {
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
      return res.json().catch(function () { return null; }).then(function (d) {
        if (!res.ok) {
          var e = new Error((d && d.message) || 'Lỗi ' + res.status);
          e.status = res.status;
          throw e;
        }
        return d;
      });
    });
  }

  function theoDoi(id, moiLan, xong) {
    var dung = false;
    var hen = null;
    function hoi() {
      if (dung) return;
      goi('/giao-dich/' + id).then(function (g) {
        if (dung) return;
        if (g.trang_thai !== 'cho_xac_nhan') { dung = true; xong(g); return; }
        if (moiLan) moiLan(g);
        hen = setTimeout(hoi, CHU_KY_HOI_MS);
      }).catch(function (e) {
        if (dung) return;
        // Yêu cầu không còn / không phải của mình: dừng. Lỗi mạng thoáng qua: hỏi lại.
        if (e.status === 404 || e.status === 403) { dung = true; xong({ id: id, trang_thai: 'loi', thong_diep: e.message, tai_lieu: [] }); return; }
        hen = setTimeout(hoi, CHU_KY_HOI_MS * 2);
      });
    }
    hen = setTimeout(hoi, 1500);
    return function () { dung = true; clearTimeout(hen); };
  }

  window.MySign = {
    taiKhoan: function () { return goi('/tai-khoan'); },
    lienKet: function (ma) { return goi('/tai-khoan', { method: 'PUT', body: { mysign_user_id: ma } }); },
    theoDoi: theoDoi,
  };
})();
