'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — ủy quyền duyệt yêu cầu lấy kháng thể. 3 endpoint. Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Viện trưởng không đủ thời gian duyệt hết nên có thể GIAO quyền duyệt một phần kháng thể cho một quản lý ngân hàng kháng thể:
 * toàn ngân hàng, một thiết bị / Rack, một hộp hoặc một loại kháng thể (theo tên), có hạn (tùy chọn) và THU HỒI được bất cứ lúc nào.
 * Chỉ VIỆN TRƯỞNG tạo / thu hồi (admin và quản lý thì không); quản lý chỉ xem. Người được ủy quyền cùng Viện trưởng là người duyệt, tính ngay lúc duyệt
 * (thu hồi hay hết hạn có hiệu lực tức thì, kể cả với yêu cầu đang chờ). Ủy quyền không cho thêm quyền gì khác ngoài duyệt / từ chối yêu cầu
 * thuộc phạm vi; không tự duyệt yêu cầu của chính mình. Lịch sử mẫu và phiếu in ghi «theo ủy quyền của Viện trưởng X». Quy tắc: services/nganHangTeBaoKhangTheYeuCau.js.
 */

const express = require('express');
const { toInt, toStr } = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createUyQuyenRouter(ctx) {
  const { db, canManage, laVienTruong, audit, fail, nhanNguoi, nguoiDung, thongBao, guiNen, YeuCau, duongDan } = ctx;
  const router = express.Router();

  const homNay = () => YeuCau.homNayVn();

  /** Câu mô tả phạm vi ủy quyền để hiện cho người dùng. */
  function tenPhamVi(dq) {
    if (dq.pham_vi === 'ngan_hang') return 'Mọi kháng thể của ngân hàng';
    if (dq.pham_vi === 'ten_mau') return `Kháng thể «${dq.ten_mau}»`;
    if (dq.pham_vi === 'hop') {
      const b = db.prepare('SELECT code, name, container_id FROM nhm_boxes WHERE id = ?').get(dq.hop_id);
      return b ? `Hộp ${b.name || b.code} (${duongDan(b.container_id).join(' › ')})` : 'Hộp đã xóa';
    }
    const c = db.prepare('SELECT id FROM nhm_containers WHERE id = ?').get(dq.vi_tri_id);
    return c ? `Thiết bị / vị trí ${duongDan(c.id).join(' › ')}` : 'Vị trí đã xóa';
  }

  const trangThai = (dq) => (dq.thu_hoi_luc ? 'thu_hoi' : dq.den_ngay && dq.den_ngay < homNay() ? 'het_han' : 'hieu_luc');

  /** Ứng viên nhận ủy quyền: quản lý ngân hàng kháng thể (vai trò không ghi phạm vi = cả hai ngân hàng) còn hoạt động. */
  function ungVien() {
    const ids = db
      .prepare("SELECT DISTINCT user_id FROM nhm_vai_tro WHERE vai_tro = 'quan_ly' AND (ngan_hang IS NULL OR ngan_hang = 'khang_the')")
      .all()
      .map((r) => r.user_id);
    return ids.map((id) => YeuCau.nguoiConHoatDong(db, id)).filter(Boolean).map((u) => ({ id: u.id, ten: u.fullname || u.email, email: u.email }));
  }

  function chiKhangThe(req, res) {
    if (req.nganHang !== 'khang_the') { fail(res, 400, 'Ủy quyền duyệt chỉ dùng ở ngân hàng kháng thể.'); return false; }
    return true;
  }

  router.get('/delegations', (req, res) => {
    if (!chiKhangThe(req, res)) return;
    if (!laVienTruong(req) && !canManage(req)) return fail(res, 403, 'Chỉ Viện trưởng hoặc quản lý ngân hàng kháng thể xem được ủy quyền duyệt.');
    const rows = db.prepare('SELECT * FROM nhm_uy_quyen_duyet ORDER BY id DESC LIMIT 200').all();
    res.json({
      la_vien_truong: laVienTruong(req),
      ung_vien: laVienTruong(req) ? ungVien() : [],
      delegations: rows.map((d) => ({
        id: d.id, nguoi_id: d.nguoi_id, nguoi_ten: nhanNguoi(d.nguoi_id), pham_vi: d.pham_vi, pham_vi_ten: tenPhamVi(d), den_ngay: d.den_ngay, ghi_chu: d.ghi_chu,
        tao_boi_ten: nhanNguoi(d.tao_boi), tao_luc: d.tao_luc, trang_thai: trangThai(d), thu_hoi_luc: d.thu_hoi_luc, thu_hoi_boi_ten: d.thu_hoi_boi ? nhanNguoi(d.thu_hoi_boi) : null,
      })),
    });
  });

  router.post('/delegations', (req, res) => {
    if (!chiKhangThe(req, res)) return;
    if (!laVienTruong(req)) return fail(res, 403, 'Chỉ Viện trưởng mới ủy quyền duyệt.');
    const b = req.body || {};
    const nguoiId = toInt(b.nguoi_id);
    if (!nguoiId || nguoiId === req.user.id) return fail(res, 400, 'Chọn một quản lý ngân hàng kháng thể (không phải chính bạn).');
    if (!ungVien().some((u) => u.id === nguoiId)) return fail(res, 400, 'Chỉ ủy quyền được cho quản lý ngân hàng kháng thể đang hoạt động.');
    const dq = { nguoi_id: nguoiId, pham_vi: b.pham_vi, vi_tri_id: null, hop_id: null, ten_mau: null, den_ngay: null, ghi_chu: toStr(b.ghi_chu, 300) };
    if (dq.pham_vi === 'vi_tri') {
      dq.vi_tri_id = toInt(b.vi_tri_id);
      const g = dq.vi_tri_id && YeuCau.gocCuaViTri(db, dq.vi_tri_id);
      if (!g || g.ngan_hang !== 'khang_the' || !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(dq.vi_tri_id)) return fail(res, 400, 'Thiết bị / vị trí không thuộc ngân hàng kháng thể.');
    } else if (dq.pham_vi === 'hop') {
      dq.hop_id = toInt(b.hop_id);
      if (!dq.hop_id || !db.prepare('SELECT 1 FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(dq.hop_id) || YeuCau.nganHangCuaHop(db, dq.hop_id) !== 'khang_the') return fail(res, 400, 'Hộp không thuộc ngân hàng kháng thể.');
    } else if (dq.pham_vi === 'ten_mau') {
      dq.ten_mau = toStr(b.ten_mau, 100);
      if (!dq.ten_mau) return fail(res, 400, 'Nhập tên kháng thể được ủy quyền.');
    } else if (dq.pham_vi !== 'ngan_hang') {
      return fail(res, 400, 'Phạm vi ủy quyền không hợp lệ.');
    }
    if (b.den_ngay != null && b.den_ngay !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.den_ngay)) || Number.isNaN(Date.parse(b.den_ngay))) return fail(res, 400, 'Ngày hết hạn không hợp lệ (năm-tháng-ngày).');
      if (b.den_ngay < homNay()) return fail(res, 400, 'Ngày hết hạn phải từ hôm nay trở đi.');
      dq.den_ngay = String(b.den_ngay);
    }
    const id = Number(
      db
        .prepare('INSERT INTO nhm_uy_quyen_duyet (nguoi_id, pham_vi, vi_tri_id, hop_id, ten_mau, den_ngay, ghi_chu, tao_boi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(dq.nguoi_id, dq.pham_vi, dq.vi_tri_id, dq.hop_id, dq.ten_mau, dq.den_ngay, dq.ghi_chu, req.user.id).lastInsertRowid
    );
    audit(req, 'delegation_create', `#${id} → ${nhanNguoi(nguoiId)}: ${tenPhamVi(dq)}${dq.den_ngay ? ' đến ' + dq.den_ngay : ''}`);
    guiNen(thongBao.uyQuyen({ hanhDong: 'cap', nguoi: nguoiDung(nguoiId), vienTruong: nguoiDung(req.user.id), phamVi: tenPhamVi(dq), denNgay: dq.den_ngay, ghiChu: dq.ghi_chu }));
    res.status(201).json({ id });
  });

  /** Thu hồi (ghi thu_hoi_luc, không xóa). Viện trưởng nào cũng thu hồi được. */
  router.delete('/delegations/:id', (req, res) => {
    if (!chiKhangThe(req, res)) return;
    if (!laVienTruong(req)) return fail(res, 403, 'Chỉ Viện trưởng mới thu hồi ủy quyền duyệt.');
    const id = toInt(req.params.id);
    const dq = id && db.prepare('SELECT * FROM nhm_uy_quyen_duyet WHERE id = ?').get(id);
    if (!dq) return fail(res, 404, 'Không tìm thấy ủy quyền.');
    if (dq.thu_hoi_luc) return fail(res, 409, 'Ủy quyền này đã được thu hồi.');
    db.prepare("UPDATE nhm_uy_quyen_duyet SET thu_hoi_luc = datetime('now'), thu_hoi_boi = ? WHERE id = ?").run(req.user.id, id);
    audit(req, 'delegation_revoke', `#${id} ${nhanNguoi(dq.nguoi_id)}: ${tenPhamVi(dq)}`);
    guiNen(thongBao.uyQuyen({ hanhDong: 'thu_hoi', nguoi: nguoiDung(dq.nguoi_id), vienTruong: nguoiDung(req.user.id), phamVi: tenPhamVi(dq) }));
    res.json({ ok: true });
  });

  return router;
};
