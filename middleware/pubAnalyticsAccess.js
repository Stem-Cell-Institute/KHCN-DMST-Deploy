/**
 * Chính sách truy cập dashboard phân tích công bố (pub_analytics).
 * Modes: whitelist | internal_domain | stims_all | public
 */

const { logDashboardAccess, clientIp } = require('./checkDashboardPermission');

const PUB_DASHBOARD_ID = 'pub_analytics';

function getPubAnalyticsSettings(db) {
  let mode = 'whitelist';
  let emailSuffix = '@sci.edu.vn';
  try {
    const r1 = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('pub_analytics_access_mode');
    if (r1 && r1.value) mode = String(r1.value).trim().toLowerCase();
    const r2 = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('pub_analytics_email_suffix');
    if (r2 && r2.value) emailSuffix = String(r2.value).trim().toLowerCase();
  } catch (_) {
    /* ignore */
  }
  const allowedModes = ['whitelist', 'internal_domain', 'stims_all', 'public'];
  if (!allowedModes.includes(mode)) mode = 'whitelist';
  if (!emailSuffix.startsWith('@')) emailSuffix = '@' + emailSuffix.replace(/^@+/, '');
  return { mode, emailSuffix };
}

function hasWhitelistAccess(db, userId) {
  const row = db
    .prepare(
      `SELECT id FROM dashboard_permissions
       WHERE dashboard_id = ?
         AND user_id = ?
         AND (expires_at IS NULL OR TRIM(expires_at) = ''
           OR date(expires_at) >= date('now','localtime'))`
    )
    .get(PUB_DASHBOARD_ID, userId);
  return !!row;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object|null} user - req.user hoặc null (chưa đăng nhập)
 * @param {{ isUserMasterAdmin?: (u: object) => boolean }} opts
 */
function evaluatePubAnalyticsAccess(db, user, opts = {}) {
  const { mode, emailSuffix } = getPubAnalyticsSettings(db);
  const isUserMasterAdmin = opts.isUserMasterAdmin;
  const role = user && String(user.role || '').toLowerCase();

  if (isUserMasterAdmin && user && isUserMasterAdmin(user)) {
    return { allowed: true, mode, reason: 'master_admin' };
  }
  if (role === 'admin') {
    return { allowed: true, mode, reason: 'admin' };
  }

  if (mode === 'public') {
    return { allowed: true, mode, reason: 'public' };
  }

  if (!user || user.id == null) {
    return { allowed: false, mode, reason: 'need_login' };
  }

  if (mode === 'stims_all') {
    return { allowed: true, mode, reason: 'stims_all' };
  }

  const email = String(user.email || '').trim().toLowerCase();
  if (mode === 'internal_domain') {
    const ok = email.endsWith(emailSuffix);
    return { allowed: ok, mode, reason: ok ? 'internal' : 'domain_mismatch' };
  }

  if (mode === 'whitelist') {
    const ok = hasWhitelistAccess(db, user.id);
    return { allowed: ok, mode, reason: ok ? 'whitelist' : 'not_listed' };
  }

  return { allowed: false, mode, reason: 'unknown' };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ isUserMasterAdmin?: (u: object) => boolean }} opts
 */
function createCheckPubAnalyticsAccess(db, opts = {}) {
  const isUserMasterAdmin = opts.isUserMasterAdmin;

  return function checkPubAnalyticsAccess(req, res, next) {
    try {
      const result = evaluatePubAnalyticsAccess(db, req.user || null, { isUserMasterAdmin });
      if (!result.allowed) {
        logDashboardAccess(db, {
          userId: req.user && req.user.id,
          dashboardId: PUB_DASHBOARD_ID,
          action: 'denied',
          ip: clientIp(req),
        });
        if (!req.user || result.reason === 'need_login') {
          return res.status(401).json({
            ok: false,
            success: false,
            error: 'Chưa đăng nhập',
          });
        }
        let msg = 'Bạn không có quyền xem dashboard này. Liên hệ quản trị để được cấp quyền.';
        if (result.reason === 'domain_mismatch') {
          msg = 'Chỉ tài khoản email nội bộ (theo cấu hình) mới được truy cập dashboard này.';
        }
        return res.status(403).json({
          ok: false,
          success: false,
          error: msg,
        });
      }
      next();
    } catch (e) {
      console.error('[checkPubAnalyticsAccess]', e);
      return res.status(500).json({ ok: false, success: false, error: e.message || 'Lỗi' });
    }
  };
}

module.exports = {
  PUB_DASHBOARD_ID,
  getPubAnalyticsSettings,
  evaluatePubAnalyticsAccess,
  createCheckPubAnalyticsAccess,
  hasWhitelistAccess,
};
