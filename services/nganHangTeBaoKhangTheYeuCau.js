'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — nghiệp vụ yêu cầu lấy mẫu: ai duyệt, khi nào chuyển lên cấp trên, người nhận thông báo.
 * Hàm thuần theo `db`, không biết `req`/`res` (router và bộ quét quá hạn dùng chung).
 *
 * Đường duyệt:
 *   Thiết bị Cellbank        → Trưởng CIPP;            không có (hoặc chính người gửi) → quản lý module
 *   Thiết bị công khai:
 *     mẫu của cán bộ / nghiên cứu viên còn hoạt động → chủ mẫu
 *     mẫu của SINH VIÊN (kể cả đang học) hoặc chủ mẫu đã rời đi → trưởng nhóm đã xác nhận
 *     không có trưởng nhóm, trưởng nhóm chưa xác nhận / đã rời đi, nhóm giải thể → quản lý module
 *   Quá hạn phản hồi (HAN.PHAN_HOI_NGAY) mà chưa ai xử lý → chuyển quản lý module.
 * Sinh viên KHÔNG BAO GIỜ là người duyệt: người ra trường không thể duyệt, nên người còn ở lại duyệt thay ngay từ đầu.
 */

// Các hạn (ngày). Một chỗ duy nhất để chỉnh.
const HAN = {
  PHAN_HOI_NGAY: 3, // người duyệt cấp dưới không phản hồi → chuyển quản lý
  CHO_BO_NGAY: 7, // mẫu chưa khai báo: từ lần nhắc đầu tiên đến khi quản lý được bỏ mẫu
  CHO_NHAN_NGAY: 14, // mẫu nghi mất: không ai nhận → quản lý được chốt thất lạc
};

const CAP_VN = {
  chu_mau: 'Chủ mẫu',
  truong_nhom: 'Trưởng nhóm',
  truong_cellbank: 'Trưởng CIPP (Cellbank)',
  quan_ly: 'Quản lý module',
};

/** 'YYYY-MM-DD HH:MM:SS' (UTC) sau `ngay` ngày kể từ `ms`. */
function sauNgay(ngay, ms = Date.now()) {
  return new Date(ms + ngay * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

function bayGio(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** Tài khoản còn dùng được: tồn tại, không bị khóa, không phải crd_user, và hồ sơ không ghi «đã rời đi». */
function nguoiConHoatDong(db, userId) {
  if (!userId) return null;
  const u = db.prepare('SELECT id, fullname, email, role, is_banned FROM users WHERE id = ?').get(userId);
  if (!u || Number(u.is_banned) === 1 || String(u.role || '').toLowerCase() === 'crd_user') return null;
  const hs = db.prepare('SELECT trang_thai FROM nhm_ho_so WHERE user_id = ?').get(userId);
  if (hs && hs.trang_thai === 'da_roi_di') return null;
  return u;
}

/** Thiết bị gốc chứa hộp (đi ngược parent_id). */
function thietBiGocCuaHop(db, boxId) {
  const box = boxId && db.prepare('SELECT container_id FROM nhm_boxes WHERE id = ?').get(boxId);
  if (!box) return null;
  let cur = db.prepare('SELECT id, parent_id, quan_ly_boi FROM nhm_containers WHERE id = ?').get(box.container_id);
  for (let i = 0; cur && cur.parent_id != null && i < 50; i++) {
    cur = db.prepare('SELECT id, parent_id, quan_ly_boi FROM nhm_containers WHERE id = ?').get(cur.parent_id);
  }
  return cur || null;
}

function hopTrongCellbank(db, boxId) {
  const goc = thietBiGocCuaHop(db, boxId);
  return !!goc && goc.quan_ly_boi === 'cellbank';
}

/** Người giữ một vai trò module và còn hoạt động. */
function nguoiCoVaiTro(db, vaiTro) {
  return db
    .prepare('SELECT DISTINCT user_id FROM nhm_vai_tro WHERE vai_tro = ?')
    .all(vaiTro)
    .map((r) => nguoiConHoatDong(db, r.user_id))
    .filter(Boolean);
}

/** Quản lý module nhận thông báo; chưa gán ai thì rơi về các admin để thông báo không biến mất. */
function quanLyModule(db) {
  const ds = nguoiCoVaiTro(db, 'quan_ly');
  if (ds.length) return ds;
  return db
    .prepare("SELECT id FROM users WHERE LOWER(COALESCE(role, '')) = 'admin'")
    .all()
    .map((r) => nguoiConHoatDong(db, r.id))
    .filter(Boolean);
}

/** Trưởng nhóm CÓ HIỆU LỰC của nhóm: tài khoản còn hoạt động, đã tự xác nhận, nhóm chưa giải thể. */
function truongNhomHieuLuc(db, nhomId) {
  const g = nhomId && db.prepare("SELECT truong_user_id, truong_xac_nhan FROM nhm_nhom WHERE id = ? AND trang_thai <> 'giai_the'").get(nhomId);
  if (!g || !g.truong_user_id || !g.truong_xac_nhan) return null;
  return nguoiConHoatDong(db, g.truong_user_id);
}

/**
 * Cấp duyệt và người duyệt cho yêu cầu của `nguoiGuiId` về `tube`.
 * @returns {{cap: string, nguoiDuyet: object[]}}
 */
function xacDinhCap(db, tube, nguoiGuiId) {
  const khacNguoiGui = (ds) => ds.filter((u) => u.id !== nguoiGuiId);
  if (tube.box_id && hopTrongCellbank(db, tube.box_id)) {
    const ds = khacNguoiGui(nguoiCoVaiTro(db, 'truong_cellbank'));
    if (ds.length) return { cap: 'truong_cellbank', nguoiDuyet: ds };
    return { cap: 'quan_ly', nguoiDuyet: khacNguoiGui(quanLyModule(db)) };
  }
  const chu = nguoiConHoatDong(db, tube.owner_user_id);
  if (tube.chu_loai !== 'sinh_vien' && chu && chu.id !== nguoiGuiId) return { cap: 'chu_mau', nguoiDuyet: [chu] };
  const truong = truongNhomHieuLuc(db, tube.nhom_id);
  if (truong && truong.id !== nguoiGuiId) return { cap: 'truong_nhom', nguoiDuyet: [truong] };
  return { cap: 'quan_ly', nguoiDuyet: khacNguoiGui(quanLyModule(db)) };
}

/** Những người ĐƯỢC CHỈ ĐỊNH duyệt ở cấp hiện tại của một yêu cầu (không tính quản lý / admin xử lý thay). */
function nguoiDuyetHienTai(db, yc, tube) {
  if (yc.cap === 'chu_mau') return [nguoiConHoatDong(db, tube.owner_user_id)].filter(Boolean);
  if (yc.cap === 'truong_nhom') return [truongNhomHieuLuc(db, tube.nhom_id)].filter(Boolean);
  if (yc.cap === 'truong_cellbank') return nguoiCoVaiTro(db, 'truong_cellbank');
  return quanLyModule(db);
}

module.exports = {
  HAN, CAP_VN, sauNgay, bayGio, nguoiConHoatDong, thietBiGocCuaHop, hopTrongCellbank, nguoiCoVaiTro, quanLyModule,
  truongNhomHieuLuc, xacDinhCap, nguoiDuyetHienTai,
};
