'use strict';

/**
 * Quản trị journal_metrics: cập nhật thủ công JCR IF theo ISSN và năm SJR (1 endpoint).
 *
 *   POST /api/admin/journal-metrics/update-if
 *
 * Tách khỏi server.js (Đợt 6.4 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');

module.exports = function createAdminJournalMetricsRouter({
  db,
  authMiddleware,
  adminOnly,
  normalizeIssnJournalMetricsInput,
}) {
  const router = express.Router();

  router.post('/admin/journal-metrics/update-if', authMiddleware, adminOnly, (req, res) => {
    try {
      const issnNorm = normalizeIssnJournalMetricsInput(req.body?.issn);
      if (!issnNorm || !/^\d{4}-[\dX]{4}$/i.test(issnNorm)) {
        return res.status(400).json({ message: 'ISSN phải đúng định dạng XXXX-XXXX' });
      }
      const year = parseInt(req.body?.year, 10);
      if (!Number.isFinite(year) || year < 1900 || year > 2100) {
        return res.status(400).json({ message: 'Năm không hợp lệ (1900–2100)' });
      }
      const jcrIf = Number(req.body?.jcr_if);
      if (!Number.isFinite(jcrIf) || jcrIf <= 0) {
        return res.status(400).json({ message: 'jcr_if phải là số dương' });
      }
      const r = db
        .prepare(
          `UPDATE journal_metrics SET jcr_if_manual = ?, updated_at = datetime('now')
           WHERE sjr_year = ? AND (issn_print = ? OR issn_electronic = ?)`
        )
        .run(jcrIf, year, issnNorm, issnNorm);
      const changes = Number(r?.changes ?? 0);
      if (!changes) {
        return res.status(404).json({
          message: 'Không tìm thấy bản ghi journal_metrics khớp ISSN và năm SJR',
        });
      }
      return res.json({ ok: true, message: 'Đã cập nhật JCR IF', changes });
    } catch (e) {
      console.error('[journal-metrics/update-if]', e);
      return res.status(500).json({ message: 'Lỗi CSDL' });
    }
  });

  return router;
};
