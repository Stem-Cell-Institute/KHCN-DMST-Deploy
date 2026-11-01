'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — thể tích (µL) của ống kháng thể: ghi thể tích ban đầu, ghi lần dùng, đo lại, đánh dấu hết,
 * danh sách ống sắp hết. 6 endpoint. Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Chỉ QUẢN LÝ ngân hàng kháng thể (và admin) ghi thể tích; ai nhìn thấy mẫu đều xem được số liệu và sổ. Chỉ dùng cho ống ở ngân hàng
 * kháng thể. Giao mẫu / nhận lại theo yêu cầu cũng ghi vào sổ này (xem yeuCau.js). Quy tắc và ý nghĩa các hành động: services/nganHangTeBaoKhangTheTheTich.js.
 *
 * Ống HẾT: ống bị bỏ khỏi kho (trạng thái «đã hủy», nhả ô), sổ ghi dòng 'het' kèm lý do, lịch sử mẫu ghi «Ống hết». Ống và lịch sử vẫn tìm được.
 */

const express = require('express');
const { toInt, toStr } = require('../../services/nganHangTeBaoKhangThe');
const TT = require('../../services/nganHangTeBaoKhangTheTheTich');

module.exports = function createTheTichRouter(ctx) {
  const { db, requireManage, audit, fail, logMove, nhanNguoi, nguoiDung, thongBao, guiNen, moTaViTri, YeuCau } = ctx;
  const router = express.Router();
  const MO = "('cho_duyet','da_duyet','da_giao')"; // yêu cầu đang xử lý

  // ---------- phép tính dùng chung (cả yêu cầu giao / nhận lại gọi); gọi trong transaction của nơi gọi ----------

  const theTich = {
    /** Ghi thể tích ban đầu của ống (còn lại = ban đầu). */
    datBanDau(tubeId, ul, userId) {
      db.prepare("UPDATE nhm_tubes SET the_tich_ul = ?, con_lai_ul = ?, updated_at = datetime('now') WHERE id = ?").run(ul, ul, tubeId);
      TT.ghiSo(db, { tubeId, hanhDong: 'ban_dau', soUl: ul, conLai: ul, nguoiGhi: { id: userId, label: nhanNguoi(userId) } });
      logMove(tubeId, 'kt_ban_dau', null, null, userId, `Ghi thể tích ban đầu ${ul} µL`);
    },

    /** Trừ `ul` µL (đã kiểm tra không vượt số còn lại). Trả số còn lại mới. */
    dung(tube, ul, { nguoiDungId, yeuCauId, ghiChu, userId }) {
      const conLai = TT.lamTron(tube.con_lai_ul - ul);
      const nguoi = nguoiDungId ? { id: nguoiDungId, label: nhanNguoi(nguoiDungId) } : null;
      db.prepare("UPDATE nhm_tubes SET con_lai_ul = ?, updated_at = datetime('now') WHERE id = ?").run(conLai, tube.id);
      TT.ghiSo(db, { tubeId: tube.id, hanhDong: 'dung', soUl: -ul, conLai, nguoiDung: nguoi, yeuCauId, ghiChu, nguoiGhi: { id: userId, label: nhanNguoi(userId) } });
      logMove(tube.id, 'kt_dung', null, null, userId,
        `Dùng ${ul} µL${nguoi ? ' — ' + nguoi.label : ''}${yeuCauId ? ` (yêu cầu #${yeuCauId})` : ''}; còn ${conLai}/${tube.the_tich_ul} µL${ghiChu ? ' — ' + ghiChu : ''}`);
      return conLai;
    },

    /** Đặt lại số còn lại sau khi đo (chênh lệch ghi vào sổ kèm lý do). */
    dieuChinh(tube, conLaiMoi, lyDo, userId) {
      const chenh = TT.lamTron(conLaiMoi - tube.con_lai_ul);
      db.prepare("UPDATE nhm_tubes SET con_lai_ul = ?, updated_at = datetime('now') WHERE id = ?").run(conLaiMoi, tube.id);
      TT.ghiSo(db, { tubeId: tube.id, hanhDong: 'dieu_chinh', soUl: chenh, conLai: conLaiMoi, ghiChu: lyDo, nguoiGhi: { id: userId, label: nhanNguoi(userId) } });
      logMove(tube.id, 'kt_dieu_chinh', null, null, userId, `Đo lại: ${tube.con_lai_ul} → ${conLaiMoi} µL (${chenh > 0 ? '+' : ''}${chenh}) — ${lyDo}`);
    },

    /** Ống hết: còn lại = 0, ống bỏ khỏi kho (đã hủy, nhả ô). Phần còn lại (nếu có) được xóa sổ kèm lý do. */
    danhDauHet(tube, lyDo, userId) {
      const du = TT.lamTron(tube.con_lai_ul || 0);
      db.prepare("UPDATE nhm_tubes SET status = 'discarded', con_lai_ul = 0, updated_at = datetime('now') WHERE id = ?").run(tube.id);
      TT.ghiSo(db, { tubeId: tube.id, hanhDong: 'het', soUl: -du, conLai: 0, ghiChu: lyDo, nguoiGhi: { id: userId, label: nhanNguoi(userId) } });
      logMove(tube.id, 'kt_het', tube.box_id ? tube : null, null, userId, `Ống hết${du > 0 ? ` (xóa sổ ${du} µL còn lại)` : ''}, bỏ khỏi kho — ${lyDo}`);
    },

    /** Báo quản lý khi ống vừa chuyển sang «sắp hết» hoặc «hết» (so sánh trước / sau). Chạy nền. */
    canhBao(tubeId, truoc, sau) {
      const a = TT.trangThai(truoc.the_tich_ul, truoc.con_lai_ul);
      const b = TT.trangThai(sau.the_tich_ul, sau.con_lai_ul);
      if (a === b || (b !== 'sap_het' && b !== 'het')) return;
      const tube = db.prepare('SELECT * FROM nhm_tubes WHERE id = ?').get(tubeId);
      guiNen(thongBao.theTichCanhBao({ tube, conLai: sau.con_lai_ul, theTich: sau.the_tich_ul, trangThai: b, duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no) }));
    },
  };
  ctx.theTich = theTich;

  // ---------- nạp ống ----------

  /** Ống kháng thể còn tồn tại; trả null (đã trả lỗi) nếu không hợp lệ. */
  function layOng(req, res) {
    const id = toInt(req.params.id);
    const tube = id && db.prepare('SELECT * FROM nhm_tubes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!tube) { fail(res, 404, 'Không tìm thấy mẫu.'); return null; }
    if (YeuCau.nganHangCuaHop(db, tube.box_id) !== 'khang_the') { fail(res, 400, 'Thể tích (µL) chỉ dùng cho ống ở ngân hàng kháng thể.'); return null; }
    return tube;
  }

  const dangGiu = (t) => t.status === 'in_storage' || t.status === 'checked_out';

  router.get('/tubes/:id/volume', (req, res) => {
    const tube = layOng(req, res);
    if (!tube) return;
    res.json({ tube_id: tube.id, name: tube.name, ...TT.tomTat(tube), so: TT.laySo(db, tube.id) });
  });

  /** Ghi thể tích ban đầu cho ống chưa ghi (ống cũ). */
  router.post('/tubes/:id/volume/initial', requireManage, (req, res) => {
    const tube = layOng(req, res);
    if (!tube) return;
    if (tube.the_tich_ul != null) return fail(res, 409, 'Ống này đã ghi thể tích ban đầu. Dùng «Đo lại» nếu cần sửa số còn lại.');
    const [ul, loi] = TT.docUl((req.body || {}).the_tich_ul, 'Thể tích ban đầu');
    if (loi) return fail(res, 400, loi);
    db.transaction(() => theTich.datBanDau(tube.id, ul, req.user.id))();
    audit(req, 'volume_initial', `tube=${tube.id} ${ul} µL`);
    res.json({ ok: true, ...TT.tomTat({ ...tube, the_tich_ul: ul, con_lai_ul: ul }) });
  });

  /** Ghi một lần dùng không qua yêu cầu (vd quản lý tự dùng, hoặc người dùng đến lấy trực tiếp). */
  router.post('/tubes/:id/volume/use', requireManage, (req, res) => {
    const tube = layOng(req, res);
    if (!tube) return;
    if (!dangGiu(tube)) return fail(res, 409, 'Ống không còn trong kho (đã hết, rã đông hoặc đã hủy).');
    if (tube.con_lai_ul == null) return fail(res, 409, 'Hãy ghi thể tích ban đầu của ống trước.');
    const b = req.body || {};
    const [ul, loi] = TT.docUl(b.so_ul, 'Số µL đã dùng');
    if (loi) return fail(res, 400, loi);
    if (ul > tube.con_lai_ul) return fail(res, 409, `Ống chỉ còn ${tube.con_lai_ul} µL, không dùng được ${ul} µL.`);
    const nguoiId = b.nguoi_dung_id ? toInt(b.nguoi_dung_id) : null;
    if (b.nguoi_dung_id && !nguoiDung(nguoiId)) return fail(res, 400, 'Người dùng không tồn tại.');
    const ghiChu = toStr(b.ghi_chu, 300);
    let conLai;
    db.transaction(() => {
      conLai = theTich.dung(tube, ul, { nguoiDungId: nguoiId, ghiChu, userId: req.user.id });
      if (conLai <= 0 && tube.status === 'in_storage') theTich.danhDauHet({ ...tube, con_lai_ul: 0 }, 'dùng hết', req.user.id);
    })();
    theTich.canhBao(tube.id, tube, { ...tube, con_lai_ul: conLai });
    audit(req, 'volume_use', `tube=${tube.id} -${ul} µL, còn ${conLai}`);
    res.json({ ok: true, con_lai_ul: conLai, het: conLai <= 0 && tube.status === 'in_storage' });
  });

  /** Đo lại: đặt số còn lại (bắt buộc ghi lý do). Về 0 thì ống hết. */
  router.post('/tubes/:id/volume/adjust', requireManage, (req, res) => {
    const tube = layOng(req, res);
    if (!tube) return;
    if (!dangGiu(tube)) return fail(res, 409, 'Ống không còn trong kho.');
    if (tube.con_lai_ul == null) return fail(res, 409, 'Hãy ghi thể tích ban đầu của ống trước.');
    const b = req.body || {};
    const n = typeof b.con_lai_ul === 'string' ? Number(b.con_lai_ul.trim().replace(',', '.')) : Number(b.con_lai_ul);
    if (b.con_lai_ul == null || b.con_lai_ul === '' || !Number.isFinite(n) || n < 0) return fail(res, 400, 'Số còn lại phải là số không âm (µL).');
    const moi = TT.lamTron(n);
    if (moi > tube.the_tich_ul) return fail(res, 400, `Số còn lại không được lớn hơn thể tích ban đầu (${tube.the_tich_ul} µL).`);
    const lyDo = toStr(b.ly_do, 300);
    if (!lyDo || lyDo.length < 3) return fail(res, 400, 'Hãy ghi lý do đo lại / điều chỉnh.');
    if (moi === tube.con_lai_ul) return fail(res, 400, 'Số còn lại không đổi.');
    db.transaction(() => {
      theTich.dieuChinh(tube, moi, lyDo, req.user.id);
      if (moi <= 0 && tube.status === 'in_storage') theTich.danhDauHet({ ...tube, con_lai_ul: 0 }, lyDo, req.user.id);
    })();
    theTich.canhBao(tube.id, tube, { ...tube, con_lai_ul: moi });
    audit(req, 'volume_adjust', `tube=${tube.id} ${tube.con_lai_ul} → ${moi} µL — ${lyDo}`);
    res.json({ ok: true, con_lai_ul: moi, het: moi <= 0 && tube.status === 'in_storage' });
  });

  /** Đánh dấu hết (hỏng, nhiễm, mất hoạt tính...): xóa sổ phần còn lại, bỏ ống khỏi kho. */
  router.post('/tubes/:id/volume/finish', requireManage, (req, res) => {
    const tube = layOng(req, res);
    if (!tube) return;
    if (!dangGiu(tube)) return fail(res, 409, 'Ống không còn trong kho.');
    const lyDo = toStr((req.body || {}).ly_do, 300);
    if (!lyDo || lyDo.length < 3) return fail(res, 400, 'Hãy ghi lý do (dùng hết, hỏng, nhiễm...).');
    const mo = db.prepare(`SELECT id FROM nhm_yeu_cau WHERE tube_id = ? AND trang_thai IN ${MO}`).get(tube.id);
    if (mo) return fail(res, 409, `Ống đang có yêu cầu #${mo.id} chưa xong. Hãy xử lý yêu cầu (hoặc người xin hủy) trước khi đánh dấu hết.`);
    db.transaction(() => theTich.danhDauHet(tube, lyDo, req.user.id))();
    theTich.canhBao(tube.id, tube, { ...tube, con_lai_ul: 0 });
    audit(req, 'volume_finish', `tube=${tube.id} ${tube.name} — ${lyDo}`);
    res.json({ ok: true });
  });

  /** Ống sắp hết (còn ≤ 20% thể tích ban đầu) và số ống chưa ghi thể tích, để quản lý chuẩn bị mua / pha thêm. */
  router.get('/volume/low', requireManage, (req, res) => {
    if (req.nganHang !== 'khang_the') return fail(res, 400, 'Chỉ dùng ở ngân hàng kháng thể.');
    const rows = db
      .prepare(
        `SELECT t.id, t.name, t.box_id, t.row_no, t.col_no, t.the_tich_ul, t.con_lai_ul, t.status
         FROM nhm_tubes t WHERE t.deleted_at IS NULL AND t.status IN ('in_storage','checked_out') AND t.box_id IS NOT NULL AND ${ctx.dkKhongAn(req, 't.box_id')}
         ORDER BY t.name, t.id`
      )
      .all()
      .filter((t) => YeuCau.nganHangCuaHop(db, t.box_id) === 'khang_the');
    const sap = rows
      .filter((t) => TT.trangThai(t.the_tich_ul, t.con_lai_ul) === 'sap_het')
      .map((t) => ({ ...TT.tomTat(t), id: t.id, name: t.name, status: t.status, vi_tri: moTaViTri(t.box_id, t.row_no, t.col_no) }))
      .sort((a, b) => a.ty_le - b.ty_le);
    res.json({ sap_het: sap, chua_ghi: rows.filter((t) => t.con_lai_ul == null).length });
  });

  return router;
};
