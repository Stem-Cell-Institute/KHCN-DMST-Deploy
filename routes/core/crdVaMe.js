/**
 * Route phục vụ trang đặt lịch CRD (/crd-lab-booking*) và thông tin người dùng hiện tại (/api/me).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const db = require('../../lib/db-bridge');

module.exports = function mountCoreCrdAndMeRoutes({ app, authMiddleware, userEmailIsMasterAdmin, rootDir }) {
  const crdLabBookingPath = path.join(rootDir, 'crd-lab-booking', 'index.html');
  app.get('/crd-lab-booking', (req, res) => res.redirect(302, '/crd-lab-booking/'));
  app.get('/crd-lab-booking/', (req, res) => {
    if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
    res.type('html').send(
      '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>CRD Lab Booking</title></head><body style="font-family:Segoe UI;padding:40px;text-align:center;">' +
      '<h1>🏢 CRD Lab Booking</h1><p>Ứng dụng sẽ hiển thị tại đây khi bạn build dự án React ra thư mục <code>crd-lab-booking/</code>.</p>' +
      '<p><a href="/crd-lab-booking.html">Trang thông tin</a> · <a href="/index.html">Trang chủ</a></p></body></html>'
    );
  });
  app.get('/crd-lab-booking/index.html', (req, res) => {
    if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
    res.redirect(302, '/crd-lab-booking.html');
  });

  // Phục vụ file tĩnh (HTML, CSS, v.v.) — sau tất cả route API
  // Trả 404 JSON cho API không tồn tại (tránh HTML "Cannot POST/GET")

  // ============================================================
  // BỔ SUNG MODULE HỢP TÁC QUỐC TẾ
  // ============================================================
  // ROUTE /api/me — Thông tin user hiện tại (HTML mới cần route này)
  // ============================================================
  app.get('/api/me', authMiddleware, (req, res) => {
    try {
      const user = req.user || {};
      const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(user.id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
      const out = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
      out.isMasterAdmin = userEmailIsMasterAdmin(out.email);
      return res.json(out);
    } catch(e) {
      return res.json(req.user || {});
    }
  });
};
