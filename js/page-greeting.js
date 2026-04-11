/**
 * Lời chào thống nhất trên đầu trang (kèm auth-status và các header tùy chỉnh).
 * Viện trưởng Phạm Văn Phúc: luôn "Xin chào Viện trưởng !"
 * — theo email phucpham@sci.edu.vn hoặc họ tên khớp (fallback).
 */
(function (global) {
    'use strict';

    var VIEN_TRUONG_EMAIL = 'phucpham@sci.edu.vn';
    var VIEN_TRUONG_FULLNAME_LOWER = 'phạm văn phúc';

    function normName(s) {
        return String(s || '').trim().replace(/\s+/g, ' ');
    }

    function isVienTruongPhucUser(user) {
        if (!user) return false;
        var em = String(user.email || '').trim().toLowerCase();
        if (em === VIEN_TRUONG_EMAIL) return true;
        if (user.fullname && normName(user.fullname).toLowerCase() === VIEN_TRUONG_FULLNAME_LOWER) return true;
        return false;
    }

    /**
     * @param {Object} user — object từ localStorage /api (fullname, email, role)
     * @returns {string} Chuỗi hiển thị (đã gồm "Xin chào…")
     */
    function getLoginGreetingDisplay(user) {
        if (!user) return 'Xin chào';
        if (isVienTruongPhucUser(user)) return 'Xin chào Viện trưởng !';

        var namePart = normName(user.fullname);
        if (!namePart && user.email) {
            var em = normName(user.email);
            namePart = em.indexOf('@') !== -1 ? em.split('@')[0] : em;
        }
        if ((user.email || '').toLowerCase() === 'sinhnguyen@sci.edu.vn' && (!namePart || namePart.toLowerCase() === 'sinh')) {
            namePart = 'Nguyễn Trường Sinh';
        }
        return namePart ? ('Xin chào ' + namePart) : 'Xin chào';
    }

    global.getLoginGreetingDisplay = getLoginGreetingDisplay;
    global.isVienTruongPhucUser = isVienTruongPhucUser;
})(typeof window !== 'undefined' ? window : this);
