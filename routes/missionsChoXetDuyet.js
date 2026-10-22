'use strict';

/**
 * Nhiệm vụ KHCN — danh sách chờ Chủ tịch Hội đồng xét duyệt (Bước 3).
 *
 *   GET /api/missions/cho-ct-hd-xet-duyet
 *   GET /api/missions/count-cho-ct-hd-ngoai-vien
 *
 * Tách khỏi server.js (Đợt 1.4). Không sửa logic — chỉ đổi `app.` thành `router.`.
 *
 * VÌ SAO TÁCH RIÊNG, KHÔNG GỘP VỚI routes/missionsChiTiet.js: hai router này nằm ở hai
 * vị trí mount KHÁC NHAU trong server.js, và giữa chúng là router missionsExport. Cả hai
 * route ở đây có segment chữ sau /api/missions/ nên phải đăng ký TRƯỚC
 * '/api/missions/:id' (nằm trong missionsChiTiet.js). Gộp hai file rồi mount một lần sẽ
 * đẩy ':id' lên trước missionsExport và làm '/api/missions/export' bị nuốt thành
 * ':id = "export"' → trả 400 «ID không hợp lệ». Test «thứ tự đăng ký» trong
 * tests/smoke.test.js canh đúng chế độ hỏng này.
 */

const express = require('express');

module.exports = function createMissionsChoXetDuyetRouter({ db, authMiddleware, roleIsAny }) {
const router = express.Router();

// Danh sách đề tài chờ CT HĐ xét duyệt (Bước 3)
router.get('/missions/cho-ct-hd-xet-duyet', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'chu_tich'])) {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng KHCN hoặc Admin mới xem được' });
  }
  const rows = db.prepare('SELECT id, code, title, principal, level, buoc3_ngay_gui, buoc3_trang_thai FROM missions WHERE status = ? AND (buoc3_trang_thai = ? OR buoc3_trang_thai IS NULL) ORDER BY buoc3_ngay_gui DESC').all('cho_ct_hd_xet_duyet', 'cho_xet_duyet');
  return res.json({ missions: rows });
});

/** Số đề tài ngoài Viện (không phải đồng bộ từ đề tài cấp Viện) đang chờ CT HĐ xét duyệt — badge sidebar Quản lý nhiệm vụ */
router.get('/missions/count-cho-ct-hd-ngoai-vien', authMiddleware, (req, res) => {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM missions
         WHERE status = 'cho_ct_hd_xet_duyet'
         AND (buoc3_trang_thai = 'cho_xet_duyet' OR buoc3_trang_thai IS NULL)
         AND COALESCE(TRIM(source_type), '') != 'cap_vien'`
      )
      .get();
    const n = row && row.c != null ? Number(row.c) : 0;
    return res.json({ count: Number.isFinite(n) ? n : 0 });
  } catch (e) {
    return res.json({ count: 0 });
  }
});

return router;
};
