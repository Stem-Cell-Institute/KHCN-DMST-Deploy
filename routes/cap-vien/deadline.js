'use strict';

/**
 * Đề tài cấp Viện — đặt/xóa deadline cho từng bước (1 endpoint).
 *
 *   PUT /api/cap-vien/submissions/:id/steps/:step/deadline
 *
 * Tách khỏi server.js (Đợt 4.9 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');

module.exports = function createCapVienDeadlineRouter({ db, authMiddleware }) {
const router = express.Router();

// Admin (dev): đặt/cập nhật deadline cho từng bước
router.put('/cap-vien/submissions/:id/steps/:step/deadline', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepId = String(req.params.step || '').trim();
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  if (!stepId) return res.status(400).json({ message: 'Step không hợp lệ' });
  if ((req.user.role || '').toLowerCase() !== 'admin') return res.status(403).json({ message: 'Chỉ Admin mới được đặt deadline' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });

  const body = req.body || {};
  const clear = !!body.clear;
  if (clear) {
    db.prepare('DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').run(id, stepId);
    return res.json({ message: 'Đã xóa deadline cho bước ' + stepId, stepId, cleared: true });
  }

  const existing = db.prepare('SELECT openedAt FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').get(id, stepId);
  const openedAt = existing && existing.openedAt ? existing.openedAt : new Date().toISOString();
  let durationDays = body.durationDays != null ? parseInt(body.durationDays, 10) : null;
  let dueAt = null;
  if (body.dueAt) {
    const d = new Date(body.dueAt);
    if (isNaN(d.getTime())) return res.status(400).json({ message: 'dueAt không hợp lệ' });
    dueAt = d.toISOString();
  } else {
    if (!Number.isFinite(durationDays) || durationDays <= 0) return res.status(400).json({ message: 'durationDays phải > 0' });
    const ms = new Date(openedAt).getTime() + (durationDays * 24 * 60 * 60 * 1000);
    dueAt = new Date(ms).toISOString();
  }
  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    const diff = new Date(dueAt).getTime() - new Date(openedAt).getTime();
    durationDays = Math.max(1, Math.ceil(diff / (24 * 60 * 60 * 1000)));
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO cap_vien_step_deadlines (submissionId, stepId, openedAt, dueAt, durationDays, updatedById, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submissionId, stepId) DO UPDATE SET
      openedAt = excluded.openedAt,
      dueAt = excluded.dueAt,
      durationDays = excluded.durationDays,
      updatedById = excluded.updatedById,
      updatedAt = excluded.updatedAt
  `).run(id, stepId, openedAt, dueAt, durationDays, req.user.id, updatedAt);
  return res.json({ message: 'Đã cập nhật deadline bước ' + stepId, stepId, openedAt, dueAt, durationDays, updatedAt });
});

return router;
};
