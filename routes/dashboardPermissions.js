/**
 * CRUD quyền xem dashboard — /api/dashboard-perms
 * dashboard_id ví dụ: pub_analytics
 */

const express = require('express');

function adminOnly(req, res, next) {
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ ok: false, success: false, error: 'Chỉ Admin mới có quyền này' });
  }
  next();
}

function resolveGroupUserIds(db, group) {
  const g = String(group || '').toLowerCase().trim();
  if (g === 'ncv' || g === 'researchers') {
    return db
      .prepare(
        `SELECT id FROM users
         WHERE lower(trim(role)) IN ('researcher', 'crd_user')
         ORDER BY id`
      )
      .all()
      .map((r) => r.id);
  }
  if (g === 'leadership' || g === 'lanh_dao') {
    return db
      .prepare(
        `SELECT id FROM users
         WHERE lower(trim(role)) IN (
           'chu_tich','thu_ky','thanh_vien','vien_truong','pho_vien_truong','totruong_tham_dinh_tc'
         )
         ORDER BY id`
      )
      .all()
      .map((r) => r.id);
  }
  if (g === 'accounting' || g === 'ke_toan') {
    return db
      .prepare(`SELECT id FROM users WHERE lower(trim(role)) = 'ke_toan' ORDER BY id`)
      .all()
      .map((r) => r.id);
  }
  return [];
}

module.exports = function createDashboardPermissionsRouter({ db }) {
  const router = express.Router();

  /** Kiểm tra quyền user hiện tại (không cần admin) */
  router.get('/:dashboardId/check', (req, res) => {
    try {
      const dashboardId = String(req.params.dashboardId || '').trim();
      if (!dashboardId) {
        return res.status(400).json({ ok: false, success: false, error: 'Thiếu dashboardId' });
      }
      const user = req.user;
      if (!user || user.id == null) {
        return res.status(401).json({ ok: false, success: false, allowed: false, error: 'Chưa đăng nhập' });
      }
      if ((user.role || '').toLowerCase() === 'admin') {
        return res.json({ ok: true, success: true, allowed: true });
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
      return res.json({ ok: true, success: true, allowed: !!row });
    } catch (e) {
      console.error('[dashboard-perms/check]', e);
      return res.status(500).json({ ok: false, success: false, allowed: false, error: e.message });
    }
  });

  /** Danh sách user được cấp (admin) */
  router.get('/:dashboardId', adminOnly, (req, res) => {
    try {
      const dashboardId = String(req.params.dashboardId || '').trim();
      const rows = db
        .prepare(
          `SELECT
             dp.user_id,
             u.fullname,
             u.email,
             u.role,
             dp.granted_at,
             dp.expires_at,
             dp.granted_by
           FROM dashboard_permissions dp
           JOIN users u ON u.id = dp.user_id
           WHERE dp.dashboard_id = ?
           ORDER BY u.fullname COLLATE NOCASE, u.email`
        )
        .all(dashboardId);
      return res.json({ ok: true, success: true, data: rows });
    } catch (e) {
      console.error('[dashboard-perms GET]', e);
      return res.status(500).json({ ok: false, success: false, error: e.message });
    }
  });

  /**
   * Cấp quyền: body { user_ids: [1,2], expires_at: "2026-12-31" | null }
   * hoặc { group: "ncv"|"leadership"|"accounting", expires_at }
   */
  router.post('/:dashboardId', adminOnly, (req, res) => {
    try {
      const dashboardId = String(req.params.dashboardId || '').trim();
      const grantedBy = req.user.id;
      const expiresAt = req.body && req.body.expires_at != null ? String(req.body.expires_at).trim() : null;
      const expiresSql = expiresAt === '' ? null : expiresAt;

      let ids = [];
      if (req.body && Array.isArray(req.body.user_ids) && req.body.user_ids.length) {
        ids = req.body.user_ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
      } else if (req.body && req.body.group) {
        ids = resolveGroupUserIds(db, req.body.group);
      }

      if (!ids.length) {
        return res.status(400).json({
          ok: false,
          success: false,
          error: 'Cần user_ids hoặc group hợp lệ',
        });
      }

      const upsert = db.prepare(
        `INSERT INTO dashboard_permissions (dashboard_id, user_id, granted_by, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dashboard_id, user_id) DO UPDATE SET
           granted_by = excluded.granted_by,
           granted_at = datetime('now','localtime'),
           expires_at = excluded.expires_at`
      );

      const run = db.transaction((userIds) => {
        let n = 0;
        for (const uid of userIds) {
          upsert.run(dashboardId, uid, grantedBy, expiresSql);
          n += 1;
        }
        return n;
      });

      const count = run(ids);
      return res.json({ ok: true, success: true, granted: count, dashboardId });
    } catch (e) {
      console.error('[dashboard-perms POST]', e);
      return res.status(500).json({ ok: false, success: false, error: e.message });
    }
  });

  router.delete('/:dashboardId/:userId', adminOnly, (req, res) => {
    try {
      const dashboardId = String(req.params.dashboardId || '').trim();
      const userId = Number(req.params.userId);
      if (!Number.isFinite(userId)) {
        return res.status(400).json({ ok: false, success: false, error: 'userId không hợp lệ' });
      }
      const r = db
        .prepare(
          `DELETE FROM dashboard_permissions WHERE dashboard_id = ? AND user_id = ?`
        )
        .run(dashboardId, userId);
      if (!r.changes) {
        return res.status(404).json({ ok: false, success: false, error: 'Không tìm thấy bản ghi' });
      }
      return res.json({ ok: true, success: true });
    } catch (e) {
      console.error('[dashboard-perms DELETE]', e);
      return res.status(500).json({ ok: false, success: false, error: e.message });
    }
  });

  return router;
};
