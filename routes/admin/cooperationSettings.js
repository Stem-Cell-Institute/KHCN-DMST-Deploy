'use strict';

/**
 * Quản trị HTQT: danh sách người nhận email thông báo & cấu hình cảnh báo thỏa thuận hết hạn (7 endpoint).
 *
 *   GET    /api/admin/cooperation/notification-recipients
 *   POST   /api/admin/cooperation/notification-recipients
 *   DELETE /api/admin/cooperation/notification-recipients/:id
 *   PATCH  /api/admin/cooperation/notification-recipients/:id
 *   GET    /api/admin/cooperation/settings/thoa-thuan-expiry
 *   PUT    /api/admin/cooperation/settings/thoa-thuan-expiry
 *   POST   /api/admin/cooperation/thoa-thuan/run-expiry-check
 *
 * Tách khỏi server.js (Đợt 6.4 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');

module.exports = function createAdminCooperationSettingsRouter({
  db,
  authMiddleware,
  adminOnly,
  isSafeEmailFormat,
  coopGetThoaThuanExpiryMonths,
  coopGetThoaThuanPostExpiryMaxEmails,
  coopGetThoaThuanPostExpiryMinDays,
  coopRunThoaThuanExpiryAlerts,
}) {
  const router = express.Router();

  router.get('/admin/cooperation/notification-recipients', authMiddleware, adminOnly, (req, res) => {
    try {
      const rows = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients ORDER BY id').all();
      return res.json({ recipients: rows || [] });
    } catch (e) {
      return res.json({ recipients: [] });
    }
  });

  router.post('/admin/cooperation/notification-recipients', authMiddleware, adminOnly, (req, res) => {
    const { email, fullname, topics, role } = req.body || {};
    const em = (email || '').trim().toLowerCase();
    if (!em) return res.status(400).json({ message: 'Vui lòng nhập email.' });
    if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email không hợp lệ.' });
    const topicsVal = (topics === 'all' || (typeof topics === 'string' && topics.trim() === 'all')) ? 'all' : (Array.isArray(topics) ? topics.filter(Boolean).join(',') : (typeof topics === 'string' ? topics.trim() : 'all'));
    const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
    try {
      db.prepare('INSERT INTO cooperation_notification_recipients (email, fullname, topics, role) VALUES (?, ?, ?, ?)').run(em, (fullname || '').trim() || null, topicsVal || 'all', roleVal);
      const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE email = ?').get(em);
      return res.status(201).json({ message: 'Đã thêm người nhận thông báo.', recipient: row });
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email này đã có trong danh sách.' });
      return res.status(500).json({ message: 'Lỗi thêm: ' + (e.message || '') });
    }
  });

  router.delete('/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    try {
      const r = db.prepare('DELETE FROM cooperation_notification_recipients WHERE id = ?').run(id);
      if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
      return res.json({ message: 'Đã xóa khỏi danh sách nhận thông báo.' });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi xóa: ' + (e.message || '') });
    }
  });

  router.patch('/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { role, fullname, topics } = req.body || {};
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    const row0 = db.prepare('SELECT id FROM cooperation_notification_recipients WHERE id = ?').get(id);
    if (!row0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
    const sets = [];
    const vals = [];
    if (role !== undefined) {
      const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
      sets.push('role = ?');
      vals.push(roleVal);
    }
    if (fullname !== undefined) {
      sets.push('fullname = ?');
      vals.push((fullname && String(fullname).trim()) || null);
    }
    if (topics !== undefined) {
      let topicsVal = 'all';
      if (topics === 'all' || (typeof topics === 'string' && topics.trim().toLowerCase() === 'all')) topicsVal = 'all';
      else if (Array.isArray(topics)) topicsVal = topics.map((t) => String(t).trim().toLowerCase()).filter(Boolean).join(',') || 'all';
      else if (typeof topics === 'string') topicsVal = topics.trim() || 'all';
      sets.push('topics = ?');
      vals.push(topicsVal);
    }
    if (!sets.length) return res.status(400).json({ message: 'Không có trường nào để cập nhật (role, fullname, topics).' });
    vals.push(id);
    try {
      db.prepare(`UPDATE cooperation_notification_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE id = ?').get(id);
      return res.json({ ok: true, message: 'Đã cập nhật.', recipient: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });

  // Cảnh báo thỏa thuận đã ký — trước/sau hết hạn (topic thoa_thuan_het_han)
  router.get('/admin/cooperation/settings/thoa-thuan-expiry', authMiddleware, adminOnly, (req, res) => {
    return res.json({
      months: coopGetThoaThuanExpiryMonths(),
      post_expiry_max_emails: coopGetThoaThuanPostExpiryMaxEmails(),
      post_expiry_min_days: coopGetThoaThuanPostExpiryMinDays(),
    });
  });

  router.put('/admin/cooperation/settings/thoa-thuan-expiry', authMiddleware, adminOnly, (req, res) => {
    const body = req.body || {};
    const updates = [];
    if (body.months != null) {
      const m = parseInt(body.months, 10);
      if (!Number.isFinite(m) || m < 1 || m > 36) {
        return res.status(400).json({ message: 'months phải là số từ 1 đến 36.' });
      }
      db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_expiry_alert_months', String(m));
      updates.push('months');
    }
    if (body.post_expiry_max_emails != null) {
      const n = parseInt(body.post_expiry_max_emails, 10);
      if (!Number.isFinite(n) || n < 0 || n > 20) {
        return res.status(400).json({ message: 'post_expiry_max_emails phải từ 0 (không gửi) đến 20.' });
      }
      db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_max_emails', String(n));
      updates.push('post_expiry_max_emails');
    }
    if (body.post_expiry_min_days != null) {
      const d = parseInt(body.post_expiry_min_days, 10);
      if (!Number.isFinite(d) || d < 1 || d > 90) {
        return res.status(400).json({ message: 'post_expiry_min_days phải từ 1 đến 90.' });
      }
      db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_min_days', String(d));
      updates.push('post_expiry_min_days');
    }
    if (!updates.length) {
      return res.status(400).json({ message: 'Gửi ít nhất một trường: months, post_expiry_max_emails, post_expiry_min_days.' });
    }
    try {
      return res.json({
        ok: true,
        message: 'Đã lưu cấu hình cảnh báo thỏa thuận.',
        months: coopGetThoaThuanExpiryMonths(),
        post_expiry_max_emails: coopGetThoaThuanPostExpiryMaxEmails(),
        post_expiry_min_days: coopGetThoaThuanPostExpiryMinDays(),
      });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi lưu cấu hình.' });
    }
  });

  router.post('/admin/cooperation/thoa-thuan/run-expiry-check', authMiddleware, adminOnly, (req, res) => {
    coopRunThoaThuanExpiryAlerts()
      .then((r) => res.json({ ok: true, ...r }))
      .catch(() => res.status(500).json({ message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' }));
  });

  return router;
};
