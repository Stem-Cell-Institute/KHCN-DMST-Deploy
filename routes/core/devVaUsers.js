/**
 * Route cấu hình quyền pub-analytics (/api/dev/pub-analytics-access) và tìm kiếm người dùng (/api/users/search).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../../lib/db-bridge');

module.exports = function mountCoreDevAndUsersRoutes({ adminOrMasterAdminApi, app, authMiddleware }) {
  app.get('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
    try {
      const { getPubAnalyticsSettings } = require('../../middleware/pubAnalyticsAccess');
      const s = getPubAnalyticsSettings(db);
      return res.json({ ok: true, mode: s.mode, email_suffix: s.emailSuffix });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Lỗi' });
    }
  });

  app.put('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
    try {
      const allowed = ['whitelist', 'internal_domain', 'stims_all', 'public'];
      const raw = req.body && req.body.mode != null ? String(req.body.mode).trim().toLowerCase() : '';
      if (!allowed.includes(raw)) {
        return res.status(400).json({ ok: false, error: 'mode không hợp lệ' });
      }
      let suffix = req.body && req.body.email_suffix != null ? String(req.body.email_suffix).trim().toLowerCase() : '@sci.edu.vn';
      if (suffix && !suffix.startsWith('@')) suffix = '@' + suffix;
      if (suffix.length < 2 || suffix.length > 80) {
        return res.status(400).json({ ok: false, error: 'email_suffix không hợp lệ' });
      }
      db.prepare(
        `INSERT INTO system_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run('pub_analytics_access_mode', raw);
      db.prepare(
        `INSERT INTO system_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run('pub_analytics_email_suffix', suffix);
      return res.json({ ok: true, mode: raw, email_suffix: suffix });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Lỗi' });
    }
  });

  /** Tìm user (autocomplete phân quyền dashboard) — chỉ Admin */
  app.get('/api/users/search', authMiddleware, adminOrMasterAdminApi, (req, res) => {
    try {
      const raw = String(req.query.q || '').trim();
      if (raw.length < 1) {
        return res.json({ ok: true, success: true, data: [] });
      }
      const safe = raw.replace(/[%_]/g, '').slice(0, 80);
      if (!safe) {
        return res.json({ ok: true, success: true, data: [] });
      }
      const like = `%${safe.toLowerCase()}%`;
      const rows = db
        .prepare(
          `SELECT id, email, fullname, role FROM users
         WHERE lower(COALESCE(fullname,'')) LIKE ?
            OR lower(COALESCE(email,'')) LIKE ?
         ORDER BY fullname COLLATE NOCASE
         LIMIT 30`
        )
        .all(like, like);
      return res.json({ ok: true, success: true, data: rows });
    } catch (e) {
      console.error('[GET /api/users/search]', e);
      return res.status(500).json({ ok: false, success: false, error: 'Lỗi' });
    }
  });
};
