/**
 * Ghi nhận mở trang (page_view) khi body có data-activity-module và user đã đăng nhập.
 * POST /api/activity/track — Bearer từ localStorage (hỗ trợ mở HTML qua file:// trỏ API localhost).
 */
(function () {
  if (typeof window === 'undefined' || !window.localStorage) return;
  var token = localStorage.getItem('token');
  if (!token) return;
  var mod = document.body && document.body.getAttribute('data-activity-module');
  if (!mod || !String(mod).trim()) return;
  var path =
    (window.location.pathname && window.location.pathname.split('/').pop()) ||
    window.location.pathname ||
    '';
  var base =
    window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')
      ? 'http://localhost:3000'
      : '';
  fetch(base + '/api/activity/track', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({
      module: String(mod).trim(),
      path: path,
      action: 'page_view',
    }),
    credentials: 'include',
    keepalive: true,
  }).catch(function () {});
})();
