'use strict';

/**
 * Công bố khoa học — 5 endpoint bổ sung nằm trong server.js (ngoài router chính của
 * sci-khcn-publications): xuất Excel, báo cáo in, cập nhật chỉ số Scopus/OpenAlex,
 * danh sách NCV lọc định danh, và xóa toàn bộ CSDL công bố (Master Admin).
 *
 *   GET    /api/publications/export/excel
 *   GET    /api/publications/export/report
 *   POST   /api/publications/admin/refresh-external-metrics
 *   GET    /api/researchers/list-for-disambiguation
 *   DELETE /api/publications/admin/clear-all
 *
 * Tách khỏi server.js (Đợt 3.4 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành
 * `router.` (mount ở '/api').
 *
 * LƯU Ý THỨ TỰ: PHẢI mount TRƯỚC `app.use('/api/publications', pubMod.publicationsRouter)`
 * để các đường dẫn tĩnh (`/export/*`, `/admin/*`) không bị `:id` trong `publicationsRouter`
 * nuốt mất.
 *
 * Lưới an toàn: tests/publications.test.js (xem readme/REFACTOR-PROGRESS.md).
 */

const express = require('express');
const pubQuickReport = require('../../services/pubQuickReport');

module.exports = function createPublicationsBoSungRouter({
  db,
  authMiddleware,
  adminOnly,
  masterAdminOnly,
  authPubMod,
  trustMod,
  insertUserActivityLog,
}) {
const router = express.Router();

router.get('/publications/export/excel', authMiddleware, async (req, res) => {
  try {
    const rows = await pubQuickReport.queryPublicationsExportRows(db, req.query);
    const buf = pubQuickReport.buildExcelBuffer(rows);
    const fn = 'cong-bo-khoa-hoc-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error('[export/excel]', e);
    if (!res.headersSent) res.status(500).json({ message: 'Lỗi xuất Excel' });
  }
});

router.get('/publications/export/report', authMiddleware, async (req, res) => {
  try {
    const rows = await pubQuickReport.queryPublicationsExportRows(db, req.query);
    const html = pubQuickReport.buildPrintableHtmlReport(rows, req.query, 'Báo cáo công bố khoa học');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('[export/report]', e);
    if (!res.headersSent) {
      res
        .status(500)
        .type('html')
        .send(
          '<!DOCTYPE html><html lang="vi"><meta charset="utf-8"><body><pre>' +
            String(e.message || e).replace(/</g, '&lt;') +
            '</pre></body></html>'
        );
    }
  }
});

router.post('/publications/admin/refresh-external-metrics', authMiddleware, adminOnly, async (req, res) => {
  try {
    const limit = Math.min(120, Math.max(1, parseInt(req.body?.limit, 10) || 45));
    const result = await pubQuickReport.refreshExternalMetrics(db, { limit });
    return res.json({
      message:
        `Đã xử lý ${result.processed} bản ghi, cập nhật ${result.rowsUpdated} dòng. OpenAlex: ${result.openalexHits}, Scopus: ${result.scopusHits}.`,
      ...result,
    });
  } catch (e) {
    console.error('[refresh-external-metrics]', e);
    return res.status(500).json({ message: 'Lỗi cập nhật Scopus/OpenAlex' });
  }
});

// Phải khai báo trước app.use('/api/publications', router) để không bị coi là :id
router.get('/researchers/list-for-disambiguation', authPubMod.publicationsAuthMiddleware, (req, res) => {
  try {
    res.json({ success: true, researchers: trustMod.listResearchers() });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' });
  }
});

router.delete('/publications/admin/clear-all', authMiddleware, masterAdminOnly, (req, res) => {
  try {
    const { confirm } = req.body && typeof req.body === 'object' ? req.body : {};
    if (confirm !== 'XOA-TOAN-BO') {
      return res.status(400).json({ message: 'Cần xác nhận bằng chuỗi "XOA-TOAN-BO" trong body JSON (confirm).' });
    }
    const rPub = db.prepare('DELETE FROM publications').run();
    let queueChanges = 0;
    try {
      const rQ = db.prepare('DELETE FROM publication_queue').run();
      queueChanges = Number(rQ.changes || 0);
    } catch (e) {
      if (!String(e.message || '').includes('no such table')) {
        console.warn('[publications/admin/clear-all] publication_queue:', e.message);
      }
    }
    insertUserActivityLog(req, {
      userId: req.user && req.user.id,
      email: req.user && req.user.email,
      action: 'publications_clear_all',
      module: 'publications',
      path: req.originalUrl || req.path || '/api/publications/admin/clear-all',
      detail: JSON.stringify({
        at: new Date().toISOString(),
        publicationsDeleted: Number(rPub.changes || 0),
        queueDeleted: queueChanges
      })
    });
    return res.json({
      ok: true,
      publicationsDeleted: Number(rPub.changes || 0),
      queueDeleted: queueChanges,
      message:
        'Đã xóa toàn bộ công bố trên CSDL và làm sạch hàng chờ ORCID (để quét lại không bị trùng DOI).',
    });
  } catch (e) {
    insertUserActivityLog(req, {
      userId: req.user && req.user.id,
      email: req.user && req.user.email,
      action: 'publications_clear_all_failed',
      module: 'publications',
      path: req.originalUrl || req.path || '/api/publications/admin/clear-all',
      detail: JSON.stringify({
        at: new Date().toISOString(),
        error: e && e.message ? e.message : String(e)
      })
    });
    console.error('[publications/admin/clear-all]', e);
    return res.status(500).json({ message: 'Không xóa được CSDL' });
  }
});

return router;
};
