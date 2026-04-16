/**
 * Thanh chào / đăng nhập cho module Thiết bị (header #eq-auth-bar).
 * Dùng localStorage token + user; lời chào thống nhất qua /js/page-greeting.js nếu có.
 */
(function () {
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function returnUrlQuery() {
    var path = window.location.pathname || '';
    var q = window.location.search || '';
    var rel = path.replace(/^\/+/, '') + q;
    if (!rel) return '';
    return '?returnUrl=' + encodeURIComponent(rel);
  }

  function apiBase() {
    if (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000')) {
      return 'http://localhost:3000';
    }
    return '';
  }

  function render() {
    var el = document.getElementById('eq-auth-bar');
    if (!el) return;

    var token = '';
    try {
      token = localStorage.getItem('token') || '';
    } catch (e) {}

    var user = {};
    try {
      user = JSON.parse(localStorage.getItem('user') || '{}');
    } catch (e2) {}

    var greeting =
      typeof window.getLoginGreetingDisplay === 'function'
        ? window.getLoginGreetingDisplay(user)
        : (function () {
            var n = (user.fullname && String(user.fullname).trim()) || '';
            if (!n && user.email) {
              var em = String(user.email || '').trim();
              n = em.indexOf('@') !== -1 ? em.split('@')[0] : em;
            }
            return n ? 'Xin chào ' + n : 'Xin chào';
          })();

    if (token) {
      el.innerHTML =
        '<span class="eq-auth-greet">' +
        esc(greeting) +
        '</span>' +
        '<button type="button" class="eq-auth-link eq-auth-link--btn" id="eq-auth-logout">Đăng xuất</button>';
      var lo = document.getElementById('eq-auth-logout');
      if (lo) {
        lo.addEventListener('click', function () {
          fetch(apiBase() + '/api/logout', { method: 'POST', credentials: 'same-origin' })
            .catch(function () {})
            .finally(function () {
              try {
                localStorage.removeItem('token');
                localStorage.removeItem('user');
              } catch (e3) {}
              window.location.href = '/index.html';
            });
        });
      }
    } else {
      var ru = returnUrlQuery();
      el.innerHTML =
        '<a class="eq-auth-link" href="/dang-nhap.html' +
        ru +
        '">Đăng nhập</a>' +
        '<span class="eq-auth-sep" aria-hidden="true">/</span>' +
        '<a class="eq-auth-link" href="/dang-ky.html' +
        ru +
        '">Đăng ký</a>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
