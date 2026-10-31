/**
 * Hồ sơ trình Viện trưởng BẰNG TỆP của một đợt báo cáo — cách làm CŨ, nay CHỈ CÒN ĐỌC. Router con của routes/baoCaoPhong.js.
 *
 * Mount: router.use('/dot/:id/trinh', canQuanLy, createTrinhRouter({...}))
 * Nên MỌI đường ở đây đã qua canQuanLy (quản lý module, Viện trưởng, hoặc admin hệ thống).
 * Trưởng phòng không thấy hồ sơ này: đó là bộ báo cáo gộp của nhiều phòng.
 *
 * Vì sao còn: dữ liệu thật có thể đã có hồ sơ tệp (đã gửi / đã duyệt). Không được làm mất, nên giữ đọc và tải về được.
 * Cách làm mới: người quản lý "trình" đợt, Viện trưởng đọc báo cáo và duyệt từng báo cáo ngay trong giao diện
 * (routes/baoCaoPhongVienTruong.js) — không tải tệp lên, không tải về.
 *
 * Còn lại ở đây:
 *   GET  /                 xem hồ sơ cũ (trạng thái, tệp, lịch sử của đợt)
 *   GET  /tep/:tid/tai     tải tệp cũ về (quản lý module, Viện trưởng, admin)
 *   POST /duyet            Viện trưởng duyệt hồ sơ cũ ĐANG CHỜ (da_gui) lúc chuyển đổi, để không kẹt vĩnh viễn
 *   POST /tep, DELETE /tep/:tid, POST /gui   ĐÃ NGỪNG (409): không tạo hồ sơ tệp mới, không xóa tệp cũ (báo cáo là hồ sơ, không được mất)
 *
 * Không còn nhận tệp tải lên nên cũng không còn bề mặt tấn công của việc tải tệp. Phần tải về vẫn giữ các chốt:
 *   - Tên trên đĩa là 32 hex ngẫu nhiên, kiểm lại bằng mẫu trước khi ghép đường dẫn (không path traversal dù DB bị can thiệp).
 *   - Không để tệp trong thư mục phục vụ tĩnh; chỉ tải qua endpoint này, sau canQuanLy, kèm nosniff và no-store.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { contentDisposition } = require('../lib/filenames');

const MIME_TEP = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
};
const TEN_LUU_HOP_LE = /^[a-f0-9]{32}\.(pdf|docx|doc)$/;
const DA_NGUNG = 'Hồ sơ trình bằng tệp đã được thay bằng cách trình ngay trong giao diện: bấm "Trình Viện trưởng" ở trang đợt, Viện trưởng đọc và duyệt từng báo cáo, không cần tải tệp. Hồ sơ tệp cũ chỉ còn để xem và tải về.';

module.exports = function createTrinhRouter({ db, uploadsRoot, thongBao, guiNen, loi, bao, docId }) {
  const router = express.Router({ mergeParams: true });

  const thuMucDot = (dotId) => path.join(uploadsRoot, 'bao-cao-phong', String(dotId));

  function ghiLichSu(dotId, hanhDong, nguoiId, ghiChu) {
    db.prepare('INSERT INTO bcp_dot_lich_su (dot_id, hanh_dong, nguoi_id, ghi_chu) VALUES (?,?,?,?)').run(dotId, hanhDong, nguoiId, ghiChu || null);
  }

  // Nạp đợt; đợt Nháp chưa có báo cáo nào nên không có gì để xem.
  router.use((req, res, next) => {
    const id = docId(req.params.id);
    if (!id) return loi(res, 400, 'ID không hợp lệ.');
    const dot = db.prepare('SELECT id, tieu_de, trang_thai FROM bcp_dot WHERE id = ?').get(id);
    if (!dot) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
    if (dot.trang_thai === 'nhap') return loi(res, 409, 'Đợt còn ở trạng thái Nháp, chưa có báo cáo để trình.');
    req.dotTrinh = dot;
    next();
  });

  const layTrinh = (dotId) => db.prepare('SELECT * FROM bcp_trinh WHERE dot_id = ?').get(dotId);

  // ── Ngừng tạo mới / xóa ────────────────────────────────────────────────────
  const daNgung = (req, res) => loi(res, 409, DA_NGUNG);
  router.post('/tep', daNgung);
  router.delete('/tep/:tid', daNgung);
  router.post('/gui', daNgung);

  // ── Xem ────────────────────────────────────────────────────────────────────
  router.get(
    '/',
    bao((req, res) => {
      const dotId = req.dotTrinh.id;
      const t = layTrinh(dotId) || { trang_thai: 'chua_gui' };
      const tep = db
        .prepare(
          `SELECT f.id, f.ten_goc, f.loai, f.kich_thuoc, f.tai_luc, u.fullname AS nguoi_tai
             FROM bcp_trinh_tep f LEFT JOIN users u ON u.id = f.nguoi_tai_id WHERE f.dot_id = ? ORDER BY f.id`
        )
        .all(dotId);
      const lichSu = db
        .prepare(
          `SELECT h.hanh_dong, h.ghi_chu, h.tao_luc, u.fullname AS nguoi
             FROM bcp_dot_lich_su h LEFT JOIN users u ON u.id = h.nguoi_id WHERE h.dot_id = ? ORDER BY h.id`
        )
        .all(dotId);
      const nguoiGui = t.nguoi_gui_id ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(t.nguoi_gui_id) : null;
      const nguoiDuyet = t.nguoi_duyet_id ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(t.nguoi_duyet_id) : null;
      res.json({
        trinh: {
          trang_thai: t.trang_thai,
          loi_nhan: t.loi_nhan || null,
          gui_luc: t.gui_luc || null,
          nguoi_gui: nguoiGui ? nguoiGui.fullname : null,
          duyet_luc: t.duyet_luc || null,
          nguoi_duyet: nguoiDuyet ? nguoiDuyet.fullname : null,
          nhan_xet: t.nhan_xet || null,
        },
        tep,
        lich_su: lichSu,
        // Có dữ liệu cũ để hiện không (giao diện chỉ dựng mục "Hồ sơ trình bằng tệp (cũ)" khi có).
        co_du_lieu_cu: tep.length > 0 || t.trang_thai !== 'chua_gui',
        la_vien_truong: req.bcp.laVienTruong,
        co_the: { duyet: t.trang_thai === 'da_gui' && req.bcp.laVienTruong },
      });
    })
  );

  // ── Tải tệp cũ về ──────────────────────────────────────────────────────────
  router.get(
    '/tep/:tid/tai',
    bao((req, res) => {
      const tid = docId(req.params.tid);
      if (!tid) return loi(res, 400, 'ID không hợp lệ.');
      const f = db.prepare('SELECT ten_goc, ten_luu, loai FROM bcp_trinh_tep WHERE id = ? AND dot_id = ?').get(tid, req.dotTrinh.id);
      // Phòng thủ chiều sâu: ten_luu do chính server sinh ra, nhưng vẫn không tin dòng DB mù quáng
      // trước khi ghép vào đường dẫn đĩa.
      if (!f || !TEN_LUU_HOP_LE.test(f.ten_luu)) return loi(res, 404, 'Không tìm thấy tệp.');
      const duongDan = path.join(thuMucDot(req.dotTrinh.id), f.ten_luu);
      const luong = fs.createReadStream(duongDan);
      luong.on('error', () => {
        if (!res.headersSent) loi(res, 404, 'Tệp không còn trên máy chủ.');
        else res.destroy();
      });
      luong.on('open', () => {
        res.setHeader('Content-Type', MIME_TEP[f.loai] || 'application/octet-stream');
        res.setHeader('Content-Disposition', contentDisposition(f.ten_goc));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        luong.pipe(res);
      });
    })
  );

  // ── Duyệt hồ sơ cũ đang chờ ────────────────────────────────────────────────
  router.post(
    '/duyet',
    bao((req, res) => {
      const dotId = req.dotTrinh.id;
      // Chỉ Viện trưởng (được gán trong module) duyệt. Quản lý module và admin hệ thống KHÔNG duyệt thay.
      if (!req.bcp.laVienTruong) return loi(res, 403, 'Chỉ Viện trưởng mới duyệt được hồ sơ này.');
      const nhanXet = typeof (req.body && req.body.nhan_xet) === 'string' ? req.body.nhan_xet.trim().slice(0, 2000) : '';
      const r = db
        .prepare(
          `UPDATE bcp_trinh
              SET trang_thai = 'da_duyet', nguoi_duyet_id = ?, duyet_luc = ?, nhan_xet = ?, cap_nhat_luc = datetime('now')
            WHERE dot_id = ? AND trang_thai = 'da_gui'`
        )
        .run(req.user.id, new Date().toISOString(), nhanXet || null, dotId);
      if (r.changes === 0) return loi(res, 409, 'Chỉ duyệt được hồ sơ đang ở trạng thái Đã gửi, chờ duyệt.');
      ghiLichSu(dotId, 'duyet', req.user.id, nhanXet);
      guiNen(thongBao.baoDaDuyetTrinh(dotId, req.user.id));
      res.json({ ok: true, trang_thai: 'da_duyet' });
    })
  );

  return router;
};
