/**
 * Quyền xem dashboard theo dashboard_permissions (+ admin luôn được).
 * Dùng sau authMiddleware; req.user phải có id, role.
 */

function clientIp(req) {
  const xf = req.headers && req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim();
  }
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return '';
}

function logAccessAttempt(db, { userId, dashboardId, action, ip }) {
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO dashboard_access_log (user_id, dashboard_id, action, ip_address)
       VALUES (?, ?, ?, ?)`
    ).run(userId ?? null, dashboardId, action, ip || null);
  } catch (_) {
    /* bảng có thể chưa có — bỏ qua */
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ dashboardId: string }} opts
 */
function createCheckDashboardPermission(db, opts) {
  const dashboardId = opts.dashboardId;
  if (!dashboardId) {
    throw new Error('checkDashboardPermission: cần dashboardId');
  }

  return function checkDashboardPermission(req, res, next) {
    try {
      const user = req.user;
      if (!user || user.id == null) {
        return res.status(401).json({
          ok: false,
          success: false,
          error: 'Chưa đăng nhập',
        });
      }
      const role = String(user.role || '').toLowerCase();
      if (role === 'admin') {
        return next();
      }

      const row = db
        .prepare(
          `SELECT id FROM dashboard_permissions
           WHERE dashboard_id = ?
             AND user_id = ?
             AND (expires_at IS NULL OR TRIM(expires_at) = ''
               OR date(expires_at) >= date('now','localtime'))`
        )
        .get(dashboardId, user.id);

      if (!row) {
        logAccessAttempt(db, {
          userId: user.id,
          dashboardId,
          action: 'denied',
          ip: clientIp(req),
        });
        return res.status(403).json({
          ok: false,
          success: false,
          error:
            'Bạn không có quyền xem dashboard này. Liên hệ admin để được cấp quyền.',
        });
      }
      next();
    } catch (e) {
      console.error('[checkDashboardPermission]', e);
      return res.status(500).json({ ok: false, success: false, error: e.message || 'Lỗi' });
    }
  };
}

module.exports = {
  createCheckDashboardPermission,
  /** Ghi nhật ký export / từ chối (bảng dashboard_access_log) */
  logDashboardAccess: logAccessAttempt,
  clientIp,
};
