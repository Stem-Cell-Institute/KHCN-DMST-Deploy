/**
 * Viện trưởng duyệt báo cáo TRONG GIAO DIỆN — router con của routes/baoCaoPhong.js (gắn vào cùng router, không có tiền tố riêng).
 *
 *   POST /dot/:id/trinh-vien-truong   người quản lý module TRÌNH (hoặc trình lại) đợt: toàn bộ báo cáo của đợt hiện ra trong giao diện
 *                                      Viện trưởng. Phòng chưa nộp / trễ hạn vẫn trình được; Viện trưởng thấy "Chưa nộp".
 *   GET  /dot/:id/vien-truong         tất cả báo cáo của đợt (nội dung, ý kiến, lịch sử, quyết định) trong MỘT lần tải, để Viện trưởng
 *                                      chuyển qua lại giữa các phòng không phải chờ mạng.
 *   POST /bao-cao/:id/quyet-dinh      Viện trưởng: duyet | khong_duyet | de_nghi_chinh_sua. Chỉ Viện trưởng (người quản lý và admin 403).
 *
 * Ý kiến dùng đường sẵn có POST /bao-cao/:id/y-kien.
 *
 * Quy tắc (mỗi dòng đều có test):
 *   - Quyết định chỉ có sau khi đợt đã được trình, và chỉ với báo cáo ĐÃ NỘP (đang xem được nội dung).
 *   - Client phải gửi `nop_luc` của bản mình đã đọc; lệch (phòng nộp lại trong lúc đó) → 409, không duyệt nhầm bản chưa đọc.
 *   - "Không duyệt" và "Đề nghị chỉnh sửa" bắt buộc có lý do (vì được gửi qua email). "Duyệt" có thể kèm ghi chú.
 *   - "Đề nghị chỉnh sửa" đưa báo cáo về Cần chỉnh sửa; đợt đã đóng thì TỰ MỞ LẠI (ghi vào lịch sử đợt, thư báo quản lý đóng lại khi xong).
 *   - "Duyệt" và "Không duyệt" không khóa gì, không đổi trạng thái xác nhận của người quản lý: hai việc độc lập.
 *   - Viện trưởng đổi ý được: quyết định mới thay quyết định cũ, cả hai nằm trong lịch sử. Bấm lại đúng quyết định đang có thì bỏ qua (không ghi, không gửi thư).
 */

const express = require('express');
const { QUYET_DINH, HANH_DONG_THEO_QUYET_DINH, trangThaiVienTruong } = require('../services/baoCaoPhongVienTruong');

module.exports = function createVienTruongRouter({ db, vt, thongBao, guiNen, loi, bao, docId, chuoi, parseJson, nap, ghiLichSu, ngayVN, treHan, dongBoBaoCaoDot, canQuanLy, canQuanLyModule }) {
  const router = express.Router();

  const dotDaTrinh = (dotId) => !!db.prepare('SELECT 1 AS ok FROM bcp_trinh_lan WHERE dot_id = ?').get(dotId);

  // ── Trình ──────────────────────────────────────────────────────────────────
  router.post(
    '/dot/:id/trinh-vien-truong',
    canQuanLyModule,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const dot = db.prepare('SELECT id, trang_thai FROM bcp_dot WHERE id = ?').get(id);
      if (!dot) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
      if (dot.trang_thai === 'nhap') return loi(res, 409, 'Đợt còn ở trạng thái Nháp, chưa có báo cáo để trình.');
      const dsVienTruong = thongBao.nguoiNhanVienTruong(null);
      const coVienTruong = db.prepare("SELECT 1 AS ok FROM bcp_thanh_vien WHERE vai_tro = 'vien_truong'").get();
      if (!coVienTruong) return loi(res, 409, 'Chưa chỉ định Viện trưởng. Quản trị viên cần gán vai trò Viện trưởng trong mục Phòng & phân quyền.');
      const loiNhan = typeof (req.body && req.body.loi_nhan) === 'string' ? req.body.loi_nhan.trim().slice(0, 1000) : '';
      const trinhLai = dotDaTrinh(id);
      let lan = 0;
      db.transaction(() => {
        db.prepare('INSERT INTO bcp_trinh_lan (dot_id, nguoi_trinh_id, trinh_luc, loi_nhan) VALUES (?,?,?,?)').run(id, req.user.id, new Date().toISOString(), loiNhan || null);
        lan = db.prepare('SELECT COUNT(*) AS n FROM bcp_trinh_lan WHERE dot_id = ?').get(id).n;
        db.prepare('INSERT INTO bcp_dot_lich_su (dot_id, hanh_dong, nguoi_id, ghi_chu) VALUES (?,?,?,?)').run(id, trinhLai ? 'trinh_lai' : 'trinh', req.user.id, loiNhan || null);
      })();
      guiNen(thongBao.baoTrinhVienTruong(id, req.user.id, trinhLai));
      res.json({ ok: true, lan, trinh_lai: trinhLai, da_bao: dsVienTruong.length, tien_do: vt.tienDoDot(id) });
    })
  );

  // ── Tải cả đợt cho màn hình duyệt ──────────────────────────────────────────
  router.get(
    '/dot/:id/vien-truong',
    canQuanLy,
    bao((req, res) => {
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const d = db
        .prepare(
          `SELECT d.id, d.tieu_de, d.mo_ta, d.loai, d.ky, d.han_nop, d.trang_thai, d.cach_nop, v.truong_json
             FROM bcp_dot d JOIN bcp_mau_phien_ban v ON v.id = d.mau_phien_ban_id WHERE d.id = ?`
        )
        .get(id);
      if (!d) return loi(res, 404, 'Không tìm thấy đợt báo cáo.');
      if (d.trang_thai === 'nhap') return loi(res, 409, 'Đợt còn ở trạng thái Nháp, chưa có báo cáo.');
      const homNay = ngayVN(new Date());
      const rows = db
        .prepare(
          `SELECT b.id, b.phong_id, p.ten AS phong_ten, b.chu_id, uc.fullname AS chu_ten,
                  (SELECT t.chuc_danh FROM bcp_thanh_vien t WHERE t.user_id = b.chu_id AND t.phong_id = b.phong_id AND t.vai_tro = 'truong_phong') AS chuc_danh,
                  b.trang_thai, b.du_lieu_json, b.nop_luc, b.nhan_xet, un.fullname AS nguoi_nop
             FROM bcp_bao_cao b
             JOIN bcp_phong p ON p.id = b.phong_id
             LEFT JOIN users uc ON uc.id = b.chu_id
             LEFT JOIN users un ON un.id = b.nguoi_nop_id
            WHERE b.dot_id = ? ORDER BY p.ten, uc.fullname, b.id`
        )
        .all(id);
      const nhom = (sql) => {
        const m = new Map();
        for (const r of db.prepare(sql).all(id)) {
          if (!m.has(r.bao_cao_id)) m.set(r.bao_cao_id, []);
          m.get(r.bao_cao_id).push(r);
        }
        return m;
      };
      const lichSu = nhom(
        `SELECT h.bao_cao_id, h.hanh_dong, h.ghi_chu, h.tao_luc, u.fullname AS nguoi
           FROM bcp_lich_su h JOIN bcp_bao_cao b ON b.id = h.bao_cao_id LEFT JOIN users u ON u.id = h.nguoi_id
          WHERE b.dot_id = ? ORDER BY h.id`
      );
      const yKien = nhom(
        `SELECT k.bao_cao_id, k.id, k.noi_dung, k.tao_luc, u.fullname AS nguoi
           FROM bcp_y_kien k JOIN bcp_bao_cao b ON b.id = k.bao_cao_id LEFT JOIN users u ON u.id = k.nguoi_id
          WHERE b.dot_id = ? ORDER BY k.id`
      );
      const qd = vt.quyetDinhTheoDot(id);
      const nguoiSua = vt.nguoiYeuCauSua(rows.map((r) => r.id));
      const baoCao = rows.map((r) => {
        const q = qd.get(r.id) || null;
        const daNop = r.trang_thai === 'da_nop' || r.trang_thai === 'da_duyet';
        return {
          id: r.id,
          phong_id: r.phong_id,
          phong_ten: r.phong_ten,
          chu_ten: r.chu_ten,
          chuc_danh: r.chu_ten ? r.chuc_danh : null,
          trang_thai: r.trang_thai,
          nop_luc: r.nop_luc,
          nguoi_nop: r.nguoi_nop,
          tre_han: treHan(r, d, homNay),
          nhan_xet: r.nhan_xet,
          nhan_xet_boi: r.trang_thai === 'can_chinh_sua' ? nguoiSua.get(r.id) || 'quan_ly' : null,
          // Bản nháp chưa phải báo cáo: chỉ báo cáo ĐÃ NỘP (đã khóa) mới có nội dung cho Viện trưởng đọc.
          du_lieu: daNop ? parseJson(r.du_lieu_json, {}) : null,
          y_kien: yKien.get(r.id) || [],
          lich_su: (lichSu.get(r.id) || []).map(({ bao_cao_id, ...x }) => x),
          vien_truong: q,
          vt_trang_thai: trangThaiVienTruong(r.trang_thai, q),
        };
      });
      const trinh = vt.trinhCuaDot(id);
      const { truong_json, ...dot } = d;
      res.json({
        dot,
        truong: parseJson(truong_json, []),
        trinh: trinh ? { lan: trinh.lan, trinh_luc: trinh.trinh_luc, nguoi_trinh: trinh.nguoi_trinh, loi_nhan: trinh.loi_nhan } : null,
        tien_do: vt.tienDoDot(id),
        bao_cao: baoCao,
        co_the: { quyet_dinh: req.bcp.laVienTruong && !!trinh, y_kien: req.bcp.laVienTruong },
      });
    })
  );

  // ── Quyết định của Viện trưởng ─────────────────────────────────────────────
  router.post(
    '/bao-cao/:id/quyet-dinh',
    bao((req, res) => {
      if (!req.bcp.laVienTruong) return loi(res, 403, 'Chỉ Viện trưởng mới duyệt, không duyệt hoặc đề nghị chỉnh sửa báo cáo của phòng.');
      const id = docId(req.params.id);
      if (!id) return loi(res, 400, 'ID không hợp lệ.');
      const n = nap(req, id);
      if (!n) return loi(res, 404, 'Không tìm thấy báo cáo.');
      const b = n.b;
      const body = req.body || {};
      if (!QUYET_DINH.includes(body.quyet_dinh)) return loi(res, 400, 'Quyết định không hợp lệ.');
      const quyetDinh = body.quyet_dinh;
      const ghiChu = typeof body.ghi_chu === 'string' ? body.ghi_chu.trim() : '';
      if (ghiChu.length > 2000) return loi(res, 400, 'Nội dung tối đa 2000 ký tự.');
      if (quyetDinh !== 'duyet' && !ghiChu) {
        return loi(res, 400, quyetDinh === 'khong_duyet' ? 'Cần ghi lý do không duyệt (lý do được gửi qua email cho phòng).' : 'Cần ghi rõ nội dung đề nghị chỉnh sửa (được gửi qua email cho phòng).');
      }
      if (b.dot_trang_thai === 'nhap') return loi(res, 409, 'Đợt báo cáo chưa mở.');
      if (!dotDaTrinh(b.dot_id)) return loi(res, 409, 'Đợt này chưa được người quản lý module trình Viện trưởng.');
      if (b.trang_thai !== 'da_nop' && b.trang_thai !== 'da_duyet') {
        return loi(res, 409, b.trang_thai === 'chua_nop' ? 'Phòng chưa nộp báo cáo nên chưa có gì để quyết định.' : 'Báo cáo đang được phòng chỉnh sửa; chờ phòng nộp lại.');
      }
      // Bản Viện trưởng đã đọc phải là bản đang có: phòng nộp lại trong lúc ông đọc thì quyết định không được gán nhầm cho bản mới.
      if (typeof body.nop_luc !== 'string' || body.nop_luc !== b.nop_luc) {
        return loi(res, 409, 'Báo cáo vừa được phòng nộp lại hoặc thay đổi. Hãy tải lại trang để đọc bản mới trước khi quyết định.');
      }

      const hienTai = vt.quyetDinhMotBaoCao(id);
      if (hienTai && hienTai.quyet_dinh === quyetDinh && (hienTai.ghi_chu || '') === ghiChu) {
        return res.json({ ok: true, khong_doi: true, quyet_dinh: quyetDinh, vien_truong: hienTai, vt_trang_thai: trangThaiVienTruong(b.trang_thai, hienTai), trang_thai: b.trang_thai, tien_do: vt.tienDoDot(b.dot_id) });
      }

      const truoc = vt.tienDoDot(b.dot_id);
      let moLaiDot = false;
      // Mọi điều kiện đã kiểm ở trên và tới đây là đồng bộ (không có await) nên không ai chen vào được; điều kiện trạng thái vẫn nằm trong
      // câu UPDATE để chắc chắn, và nếu có lệch thì giao dịch hủy toàn bộ.
      const doi = db.transaction(() => {
        if (quyetDinh === 'de_nghi_chinh_sua') {
          const r = db
            .prepare(
              `UPDATE bcp_bao_cao SET trang_thai = 'can_chinh_sua', nhan_xet = ?, duyet_luc = NULL, cap_nhat_luc = datetime('now')
                WHERE id = ? AND nop_luc = ? AND trang_thai IN ('da_nop','da_duyet')`
            )
            .run(ghiChu, id, b.nop_luc);
          if (r.changes === 0) return false;
          if (b.dot_trang_thai === 'dong') {
            moLaiDot = db.prepare("UPDATE bcp_dot SET trang_thai = 'dang_mo' WHERE id = ? AND trang_thai = 'dong'").run(b.dot_id).changes > 0;
            if (moLaiDot) {
              db.prepare('INSERT INTO bcp_dot_lich_su (dot_id, hanh_dong, nguoi_id, ghi_chu) VALUES (?,?,?,?)').run(
                b.dot_id, 'mo_lai_theo_de_nghi', req.user.id, 'Viện trưởng đề nghị chỉnh sửa báo cáo của ' + b.phong_ten + '; đợt tự mở lại để phòng sửa được.'
              );
              dongBoBaoCaoDot(b.dot_id);
            }
          }
        }
        ghiLichSu(id, HANH_DONG_THEO_QUYET_DINH[quyetDinh], req.user.id, ghiChu);
        return true;
      })();
      if (!doi) return loi(res, 409, 'Báo cáo vừa thay đổi. Hãy tải lại trang rồi quyết định lại.');

      const sau = vt.tienDoDot(b.dot_id);
      // Thư (chạy nền): "Duyệt" không gửi thư cho phòng. Không duyệt / đề nghị chỉnh sửa → người phụ trách báo cáo đó + người quản lý.
      let daBao = 0;
      let daBaoQuanLy = 0;
      if (quyetDinh !== 'duyet') {
        const tp = thongBao.nguoiNhanYKien(id);
        daBao = tp.length;
        daBaoQuanLy = thongBao.nguoiNhanQuanLyYKien(req.user.id, tp).length;
        guiNen(thongBao.baoQuyetDinh(id, req.user.id, quyetDinh, ghiChu, moLaiDot));
      }
      // Xử lý xong báo cáo cuối cùng đang chờ → MỘT thư tổng kết cho người quản lý.
      if (truoc.cho_quyet_dinh > 0 && sau.cho_quyet_dinh === 0) guiNen(thongBao.baoDaXuLyXong(b.dot_id, req.user.id, sau));

      const moi = vt.quyetDinhMotBaoCao(id);
      const trangThaiMoi = db.prepare('SELECT trang_thai FROM bcp_bao_cao WHERE id = ?').get(id).trang_thai;
      res.json({
        ok: true,
        quyet_dinh: quyetDinh,
        trang_thai: trangThaiMoi,
        vien_truong: moi,
        vt_trang_thai: trangThaiVienTruong(trangThaiMoi, moi),
        tien_do: sau,
        da_bao: daBao,
        da_bao_quan_ly: daBaoQuanLy,
        dot_mo_lai: moLaiDot,
      });
    })
  );

  return router;
};
