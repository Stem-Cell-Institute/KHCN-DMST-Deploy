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
            var iconUser = '<span class="icon-wrap" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>';
            var iconSettings = '<span class="icon-wrap" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33A1.65 1.65 0 0 0 14 20.1V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>';
            var adminBtn = isAdmin ? '<a href="quan-tri-cap-vien.html" class="auth-btn-admin">' + iconSettings + ' Quản trị hệ thống</a> ' : '';
            el.innerHTML = '<span class="auth-user-info">' + iconUser + ' ' + (display.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</span> ' +
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
            var iconLogin = '<span class="icon-wrap" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg></span>';
            el.innerHTML = '<a href="dang-nhap.html' + returnUrl + '" class="auth-btn-login">' + iconLogin + ' Đăng kí/Đăng nhập</a>';
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
