'use strict';

/**
 * Quản trị nhãn tiêu chuẩn hệ thống & danh sách người nhận email thông báo chung (4 endpoint).
 *
 *   GET    /api/admin/settings/standard-label
 *   PUT    /api/admin/settings/standard-label
 *   POST   /api/admin/notification-recipients
 *   DELETE /api/admin/notification-recipients/:id
 *
 * Tách khỏi server.js (Đợt 6.3d của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');

module.exports = function createAdminCaiDatVaThongBaoRouter({
  db,
  authMiddleware,
  adminOnly,
  isSafeEmailFormat,
}) {
  const router = express.Router();

  router.get('/admin/settings/standard-label', authMiddleware, adminOnly, (req, res) => {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('standard_label');
    return res.json({ label: (row && row.value != null) ? String(row.value).trim() : 'ISO9001' });
  });

  router.put('/admin/settings/standard-label', authMiddleware, adminOnly, (req, res) => {
    const label = req.body && req.body.label != null ? String(req.body.label).trim() : '';
    db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('standard_label', label);
    return res.json({ message: label ? 'Đã lưu tiêu chuẩn hiển thị.' : 'Đã xóa dòng tiêu chuẩn (sẽ không hiển thị trên Trang chủ).', label });
  });

  router.post('/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
    const { email, fullname } = req.body || {};
    const em = (email || '').trim().toLowerCase();
    if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
    if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email không hợp lệ.' });
    try {
      db.prepare('INSERT INTO notification_recipients (email, fullname) VALUES (?, ?)').run(em, (fullname || '').trim() || null);
      const row = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients WHERE email = ?').get(em);
      return res.status(201).json({ message: 'Đã thêm người nhận thông báo.', recipient: row });
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email này đã có trong danh sách.' });
      return res.status(500).json({ message: 'Lỗi thêm: ' + (e.message || '') });
    }
  });

  router.delete('/admin/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
    try {
      const r = db.prepare('DELETE FROM notification_recipients WHERE id = ?').run(id);
      if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
      return res.json({ message: 'Đã xóa khỏi danh sách nhận thông báo.' });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi xóa: ' + (e.message || '') });
    }
  });

  return router;
};
