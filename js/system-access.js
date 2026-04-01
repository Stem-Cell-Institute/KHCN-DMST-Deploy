/**
 * Super admin & quyền vào module nội bộ viện (trang HTML).
 * Khớp với ADMIN_EMAIL trong server.js — sửa cả hai nếu đổi email quản trị.
 */
(function (global) {
  var SYSTEM_SUPER_ADMIN_EMAILS = ['ntsinh0409@gmail.com'];

  function normEmail(e) {
    return String(e || '').trim().toLowerCase();
  }

  function isSystemSuperAdminEmail(email) {
    var em = normEmail(email);
    for (var i = 0; i < SYSTEM_SUPER_ADMIN_EMAILS.length; i++) {
      if (SYSTEM_SUPER_ADMIN_EMAILS[i] === em) return true;
    }
    return false;
  }

  /**
   * @param {string|{email?:string}} emailOrUser — chuỗi email hoặc object user (localStorage /api/me)
   */
  function hasInstituteModuleAccess(emailOrUser) {
    var em = normEmail(
      typeof emailOrUser === 'object' && emailOrUser != null ? emailOrUser.email : emailOrUser
    );
    if (!em) return false;
    if (isSystemSuperAdminEmail(em)) return true;
    return em.endsWith('@sci.edu.vn');
  }

  global.SYSTEM_SUPER_ADMIN_EMAILS = SYSTEM_SUPER_ADMIN_EMAILS;
  global.isSystemSuperAdminEmail = isSystemSuperAdminEmail;
  global.hasInstituteModuleAccess = hasInstituteModuleAccess;
})(typeof window !== 'undefined' ? window : this);
