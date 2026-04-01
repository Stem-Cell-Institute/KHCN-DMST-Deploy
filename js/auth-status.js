/**
 * Hiển thị thông tin người đăng nhập ở góc trên bên phải (góc phải của nav/header)
 * Chưa đăng nhập: hiện nút "Đăng kí/Đăng nhập"
 * Đã đăng nhập: hiện "Xin chào [họ tên]" + nút "Đăng xuất"
 */
(function() {
    /** Khớp SYSTEM_SUPER_ADMIN_EMAILS trong js/system-access.js và ADMIN_EMAIL trong server.js */
    var SUPER_ADMIN_EMAILS = ['ntsinh0409@gmail.com'];
    function isSuperAdminEmail(email) {
        var em = String(email || '').trim().toLowerCase();
        return SUPER_ADMIN_EMAILS.indexOf(em) !== -1;
    }

    function renderAuthStatus(el) {
        if (!el) return;
        var token = localStorage.getItem('token');
        var user = {};
        try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch (e) {}
        var namePart = (user.fullname && user.fullname.trim()) ? user.fullname.trim() : '';
        if (!namePart && user.email) {
            var em = (user.email || '').trim();
            namePart = em.indexOf('@') !== -1 ? em.split('@')[0] : em;
        }
        if ((user.email || '').toLowerCase() === 'sinhnguyen@sci.edu.vn') namePart = 'Sinh';
        var display = namePart ? ('Xin chào ' + namePart) : 'Xin chào';
        var currentPage = window.location.pathname.replace(/^.*\//, '') || window.location.href.split('/').pop().split('?')[0];

        if (token && display) {
            var isAdmin = (user.role || '').toLowerCase() === 'admin' || isSuperAdminEmail(user.email);
            var adminBtn = isAdmin ? '<a href="quan-tri-cap-vien.html" class="auth-btn-admin">⚙️ Quản trị hệ thống</a> ' : '';
            el.innerHTML = '<span class="auth-user-info">👤 ' + (display.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</span> ' +
                adminBtn +
                '<a href="dang-nhap.html" class="auth-btn-logout">Đăng xuất</a>';
            var lo = el.querySelector('.auth-btn-logout');
            if (lo) {
                lo.addEventListener('click', function(ev) {
                    ev.preventDefault();
                    var apiBase = (window.location.protocol === 'file:' || (window.location.port && window.location.port !== '3000'))
                        ? 'http://localhost:3000' : '';
                    fetch(apiBase + '/api/logout', {
                        method: 'POST',
                        credentials: 'same-origin'
                    }).catch(function() {}).finally(function() {
                        try { localStorage.removeItem('token'); localStorage.removeItem('user'); } catch (e) {}
                        window.location.href = 'index.html';
                    });
                });
            }
        } else {
            var returnUrl = currentPage && currentPage !== 'dang-nhap.html' ? '?returnUrl=' + encodeURIComponent(currentPage) : '';
            el.innerHTML = '<a href="dang-nhap.html' + returnUrl + '" class="auth-btn-login">🔐 Đăng kí/Đăng nhập</a>';
        }
    }

    function init() {
        var el = document.getElementById('auth-status');
        if (el) renderAuthStatus(el);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
