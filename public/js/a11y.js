/*
 * Sàn tiếp cận BÀN PHÍM dùng chung cho mọi trang .html.
 * Đi kèm public/css/a11y.css (viền focus). File này lo phần hành vi.
 *
 * Vì sao có file này: rà 49 trang thì thấy 100 chỗ dùng <div>/<span> kèm onclick
 * làm nút bấm. Chuột bấm được, bàn phím thì KHÔNG: các thẻ này không nhận focus,
 * không nằm trong thứ tự Tab, và trình đọc màn hình đọc chúng ra như một đoạn văn
 * bản chứ không phải một điều khiển. Người dùng bàn phím không có cách nào kích hoạt.
 *
 * Vì sao KHÔNG đổi 100 chỗ đó thành <button>: phần lớn là mục điều hướng trong
 * sidebar hoặc hàng/ô có bố cục riêng. <button> mang theo style mặc định và mô hình
 * hiển thị khác (display, line-height, white-space, text-align...), nên đổi thẻ sẽ
 * làm vỡ bố cục ở cả 8 trang. Thêm vai trò + tabindex giữ nguyên bố cục mà vẫn đủ
 * ngữ nghĩa cho trình đọc màn hình.
 */
(function () {
  'use strict';

  /* ── 1. Cho bàn phím chạm tới những "nút giả" ───────────────────────────── */

  function laHaTangSuKien(onc) {
    // Handler chỉ chặn sự kiện nổi lên, không phải một lệnh người dùng gọi
    if (/^\s*event\.stopPropagation\(\s*\)\s*;?\s*$/.test(onc)) return true;
    // Lối tắt BẤM RA NGOÀI của chuột để đóng hộp thoại. Bàn phím đã có Escape
    // (phần 2 bên dưới), nên nhét nền mờ vào Tab chỉ tạo một điểm dừng rỗng:
    // Tab tới đó rồi Enter thì KHÔNG mở ra gì cả.
    if (/event\.target\s*===?\s*this/.test(onc)) return true;
    return false;
  }

  function nangCap(el) {
    // Trang đã tự khai thì tôn trọng, không ghi đè
    if (el.hasAttribute('role') || el.hasAttribute('tabindex')) return;
    var onc = el.getAttribute('onclick') || '';
    if (laHaTangSuKien(onc)) return;
    // Tự đánh dấu là lối tắt của chuột: bàn phím đã có đường khác.
    // Ví dụ ô nửa giờ trên lịch đặt thiết bị — bấm vào ô điền sẵn máy + giờ, nhưng
    // nút "+ Đặt lịch mới" mở đúng hộp thoại ấy. Cho cả lưới vào Tab thì một ngày
    // 6 máy × 12 giờ = 144 điểm dừng, lợi bất cập hại.
    if (el.hasAttribute('data-a11y-bo-qua')) return;
    // Bên trong đã có điều khiển thật thì KHÔNG bọc role="button" ra ngoài:
    // nút lồng trong nút là cấu trúc không hợp lệ, trình đọc màn hình sẽ đọc sai.
    // Để nguyên và đếm vào phần còn nợ thay vì tạo lỗi mới.
    if (el.querySelector('button, a[href], input, select, textarea, [role="button"]')) {
      el.setAttribute('data-a11y-long-nhau', '1');
      return;
    }
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
  }

  function quet(goc) {
    var ds = (goc || document).querySelectorAll('div[onclick], span[onclick]');
    for (var i = 0; i < ds.length; i++) nangCap(ds[i]);
  }

  /* Enter và Space kích hoạt, đúng như <button> thật.
   * Bắt trên document nên nội dung do JS sinh ra sau này vẫn chạy, không cần gắn
   * lại từng phần tử.
   *
   * CỐ Ý dùng pha bubble, KHÔNG dùng capture. Vài trang đã tự gắn keydown lên
   * chính phần tử đó (ví dụ cong-bo-khoa-hoc.html gắn cho .sidebar-item). Ở pha
   * capture, handler này chạy TRƯỚC handler của trang nên không thể biết trang đã
   * xử lý rồi -> kích hoạt hai lần, bấm một cái lọc chạy hai lượt. Ở pha bubble,
   * handler của phần tử chạy xong trước, nên hai chốt dưới đây nhìn thấy được. */
  document.addEventListener('click', function (e) {
    // Mốc thời gian để chốt thứ hai bên dưới biết đã có cú bấm vừa xảy ra
    if (e.target) e.target.__a11yBamLuc = (performance.now ? performance.now() : Date.now());
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var el = e.target;
    if (!el || el.getAttribute('role') !== 'button') return;
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return; // trình duyệt tự lo

    // Chốt 1: handler của trang đã chặn mặc định -> trang tự lo, đứng ngoài.
    if (e.defaultPrevented) return;
    // Chốt 2: phòng trường hợp trang gọi .click() mà không chặn mặc định. Cú bấm
    // ấy là đồng bộ, xảy ra xong trước khi tới đây, nên chỉ cần nhìn mốc thời gian.
    var now = (performance.now ? performance.now() : Date.now());
    if (el.__a11yBamLuc && now - el.__a11yBamLuc < 50) return;

    // Space cuộn trang nếu không chặn — <button> thật cũng chặn
    e.preventDefault();
    el.click();
  });

  /* ── 2. Escape đóng hộp thoại ────────────────────────────────────────────
   * Chuột đóng được bằng cách bấm ra ngoài; bàn phím cần Escape. Rà 8 trang có
   * hộp thoại thì chỉ 3 trang tự xử lý Escape.
   *
   * Cẩn thận không đóng hai lần: vài trang ĐÃ có handler Escape riêng, và hàm đóng
   * của họ còn làm thêm việc khác (xoá trắng biểu mẫu). Nên ở đây chờ một nhịp,
   * rồi chỉ ra tay nếu hộp thoại VẪN còn hiện — tức là trang không tự lo.
   *
   * Cách đóng: phát một sự kiện click lên chính nền mờ. Handler sẵn có của trang
   * (`if(event.target===this) dong()`) sẽ chạy với target đúng là nền mờ, làm đúng
   * những gì bấm ra ngoài làm. Mượn lại logic của trang thay vì đoán tên hàm đóng. */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    var hien = [];
    var ds = document.querySelectorAll('.modal-overlay[onclick], .modal-overlay');
    for (var i = 0; i < ds.length; i++) {
      var el = ds[i];
      if (el.offsetParent !== null && getComputedStyle(el).display !== 'none') hien.push(el);
    }
    if (!hien.length) return;
    var tren = hien[hien.length - 1]; // cái sau cùng trong DOM nằm trên cùng
    setTimeout(function () {
      if (tren.offsetParent === null || getComputedStyle(tren).display === 'none') return; // trang đã tự đóng
      tren.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }, 0);
  });

  /* ── 3. Chạy khi DOM sẵn sàng, và theo dõi nội dung sinh sau ─────────────── */
  function khoiDong() {
    quet(document);
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function (dsThayDoi) {
        for (var i = 0; i < dsThayDoi.length; i++) {
          var them = dsThayDoi[i].addedNodes;
          for (var j = 0; j < them.length; j++) {
            if (them[j].nodeType !== 1) continue;
            if (them[j].matches && them[j].matches('div[onclick], span[onclick]')) nangCap(them[j]);
            quet(them[j]);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', khoiDong);
  } else {
    khoiDong();
  }
})();
