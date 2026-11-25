'use strict';

/**
 * Quản trị cấu hình module trên Trang chủ (3 endpoint).
 *
 *   GET /api/admin/homepage-modules
 *   PUT /api/admin/homepage-modules/reorder
 *   PUT /api/admin/homepage-modules/:code
 *
 * Tách khỏi server.js (Đợt 6.3c của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');

module.exports = function createAdminHomepageModulesRouter({
  db,
  authMiddleware,
  adminOnly,
  HOMEPAGE_MODULES_DEFAULT,
}) {
  const router = express.Router();

  router.get('/admin/homepage-modules', authMiddleware, adminOnly, (req, res) => {
    const existing = db.prepare('SELECT code, label, enabled FROM homepage_modules').all();
    if (!existing || existing.length === 0) {
      const stmt = db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        HOMEPAGE_MODULES_DEFAULT.forEach((m, i) => {
          stmt.run(m.code, m.label, m.enabled ? 1 : 0, i);
        });
      })();
    }
    const rows = db.prepare('SELECT code, label, enabled, sort_order FROM homepage_modules ORDER BY sort_order, code').all();
    return res.json({ modules: rows });
  });

  // Phải khai báo TRƯỚC /:code
  router.put('/admin/homepage-modules/reorder', authMiddleware, adminOnly, (req, res) => {
    const order = req.body && Array.isArray(req.body.order) ? req.body.order.map(c => String(c || '').trim()).filter(Boolean) : [];
    const expected = HOMEPAGE_MODULES_DEFAULT.map(m => m.code);
    if (order.length !== expected.length) {
      return res.status(400).json({ message: 'Danh sách thứ tự phải đủ ' + expected.length + ' module.' });
    }
    const set = new Set(order);
    if (!expected.every(c => set.has(c))) {
      return res.status(400).json({ message: 'Thứ tự module không hợp lệ (thiếu hoặc trùng mã).' });
    }
    const tx = db.transaction(() => {
      order.forEach((code, idx) => {
        const def = HOMEPAGE_MODULES_DEFAULT.find(m => m.code === code);
        const labelDefault = (def || {}).label || code;
        const en = def ? (def.enabled ? 1 : 0) : 1;
        db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)').run(code, labelDefault, en, idx);
        db.prepare('UPDATE homepage_modules SET sort_order = ? WHERE code = ?').run(idx, code);
      });
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_module_order', JSON.stringify(order));
    });
    tx();
    return res.json({ message: 'Đã lưu thứ tự hiển thị module trên Trang chủ.' });
  });

  router.put('/admin/homepage-modules/:code', authMiddleware, adminOnly, (req, res) => {
    const code = (req.params.code || '').trim();
    if (!code) return res.status(400).json({ message: 'Thiếu mã module' });
    if (!HOMEPAGE_MODULES_DEFAULT.some(m => m.code === code)) {
      return res.status(400).json({ message: 'Mã module không hợp lệ.' });
    }
    const enabled = req.body && typeof req.body.enabled !== 'undefined' ? !!req.body.enabled : true;
    const labelDefault = (HOMEPAGE_MODULES_DEFAULT.find(m => m.code === code) || {}).label || code;
    const maxSo = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM homepage_modules').get().m;
    const idxDefault = HOMEPAGE_MODULES_DEFAULT.findIndex(m => m.code === code);
    const sortOrder = idxDefault >= 0 ? idxDefault : maxSo + 1;
    db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)')
      .run(code, labelDefault, enabled ? 1 : 0, sortOrder);
    db.prepare('UPDATE homepage_modules SET enabled = ? WHERE code = ?').run(enabled ? 1 : 0, code);
    const row = db.prepare('SELECT code, label, enabled, sort_order FROM homepage_modules WHERE code = ?').get(code);
    return res.json({ message: 'Đã cập nhật cấu hình module.', module: row });
  });

  return router;
};
