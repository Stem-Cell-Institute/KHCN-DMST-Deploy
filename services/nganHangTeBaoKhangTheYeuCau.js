'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — nghiệp vụ yêu cầu lấy mẫu: ai duyệt, khi nào chuyển lên cấp trên, người nhận thông báo.
 * Hàm thuần theo `db`, không biết `req`/`res` (router và bộ quét quá hạn dùng chung).
 *
 * Đường duyệt:
 *   Thiết bị có ĐƠN VỊ QUẢN LÝ (Cellbank hoặc đơn vị khác do admin tạo) → người duyệt của đơn vị;
 *                             không có (hoặc chính người gửi) → quản lý module
 *   Thiết bị Public (không có đơn vị):
 *     mẫu của cán bộ / nghiên cứu viên còn hoạt động → chủ mẫu
 *     mẫu của SINH VIÊN (kể cả đang học) hoặc chủ mẫu đã rời đi → trưởng nhóm đã xác nhận
 *     không có trưởng nhóm, trưởng nhóm chưa xác nhận / đã rời đi, nhóm giải thể → quản lý module
 *   Quá hạn phản hồi (layHan(db).PHAN_HOI_NGAY) mà chưa ai xử lý → chuyển quản lý module.
 * Sinh viên KHÔNG BAO GIỜ là người duyệt: người ra trường không thể duyệt, nên người còn ở lại duyệt thay ngay từ đầu.
 */

// Các hạn (ngày). Giá trị MẶC ĐỊNH; quản lý chỉnh được (bảng nhm_cau_hinh, Quản lý module → Cấu hình hạn). Luôn đọc qua layHan(db).
const HAN_MAC_DINH = {
  PHAN_HOI_NGAY: 3, // người duyệt cấp dưới không phản hồi → chuyển quản lý
  CHO_BO_NGAY: 7, // mẫu chưa khai báo: từ lần nhắc đầu tiên đến khi quản lý được bỏ mẫu
  CHO_NHAN_NGAY: 14, // mẫu nghi mất: không ai nhận → quản lý được chốt thất lạc
};
const GIOI_HAN_HAN = { PHAN_HOI_NGAY: [1, 30], CHO_BO_NGAY: [1, 90], CHO_NHAN_NGAY: [1, 90] };
const KHOA_HAN = { PHAN_HOI_NGAY: 'han_phan_hoi_ngay', CHO_BO_NGAY: 'han_cho_bo_ngay', CHO_NHAN_NGAY: 'han_cho_nhan_ngay' };
const NHAN_HAN = {
  PHAN_HOI_NGAY: 'Hạn người duyệt phản hồi (quá hạn chuyển quản lý module)',
  CHO_BO_NGAY: 'Hạn chờ chủ mẫu khai báo trước khi được bỏ mẫu (tính từ lần nhắc đầu)',
  CHO_NHAN_NGAY: 'Hạn chờ người lấy tự nhận trước khi chốt thất lạc',
};

/** Các hạn đang áp dụng: mặc định, đè bằng giá trị quản lý đã lưu (giá trị hỏng hoặc ngoài khoảng thì bỏ qua). */
function layHan(db) {
  const out = { ...HAN_MAC_DINH };
  let rows = [];
  try {
    rows = db.prepare('SELECT key, value FROM nhm_cau_hinh').all();
  } catch (e) {
    return out; // bảng chưa có (DB chưa chạy schema): dùng mặc định
  }
  for (const k of Object.keys(KHOA_HAN)) {
    const r = rows.find((x) => x.key === KHOA_HAN[k]);
    const n = r ? Number(r.value) : NaN;
    const [min, max] = GIOI_HAN_HAN[k];
    if (Number.isInteger(n) && n >= min && n <= max) out[k] = n;
  }
  return out;
}

/** Lưu các hạn (đã kiểm tra khoảng ở nơi gọi). Chỉ ảnh hưởng yêu cầu / vụ việc TẠO SAU đó, trừ hạn bỏ mẫu (tính lúc đọc). */
function luuHan(db, giaTri, userId) {
  const up = db.prepare(
    "INSERT INTO nhm_cau_hinh (key, value, updated_by, updated_at) VALUES (?, ?, ?, datetime('now')) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at'
  );
  db.transaction(() => {
    for (const k of Object.keys(giaTri)) up.run(KHOA_HAN[k], String(giaTri[k]), userId || null);
  })();
}

const CAP_VN = {
  chu_mau: 'Chủ mẫu',
  truong_nhom: 'Trưởng nhóm',
  truong_cellbank: 'Đơn vị quản lý thiết bị', // tên cũ của cấp này; đơn vị cụ thể xem capTen()
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
  let cur = db.prepare('SELECT id, parent_id, quan_ly_boi, don_vi_id, rieng_user_id, created_by FROM nhm_containers WHERE id = ?').get(box.container_id);
  for (let i = 0; cur && cur.parent_id != null && i < 50; i++) {
    cur = db.prepare('SELECT id, parent_id, quan_ly_boi, don_vi_id, rieng_user_id, created_by FROM nhm_containers WHERE id = ?').get(cur.parent_id);
  }
  return cur || null;
}

/** Thiết bị gốc của một vị trí lưu trữ (đi ngược parent_id); null nếu không có. */
function gocCuaViTri(db, containerId) {
  let cur = containerId && db.prepare('SELECT id, parent_id, quan_ly_boi, don_vi_id, rieng_user_id, created_by FROM nhm_containers WHERE id = ?').get(containerId);
  for (let i = 0; cur && cur.parent_id != null && i < 50; i++) {
    cur = db.prepare('SELECT id, parent_id, quan_ly_boi, don_vi_id, rieng_user_id, created_by FROM nhm_containers WHERE id = ?').get(cur.parent_id);
  }
  return cur || null;
}

/** Hộp nằm trong thiết bị CÓ ĐƠN VỊ QUẢN LÝ (không còn là Public)? Tên hàm giữ từ bản chỉ có Cellbank. */
function hopTrongCellbank(db, boxId) {
  const goc = thietBiGocCuaHop(db, boxId);
  return !!goc && goc.quan_ly_boi === 'cellbank';
}

/** Đơn vị quản lý của thiết bị chứa hộp; null nếu Public (hoặc dữ liệu cũ chưa gắn đơn vị). */
function donViCuaHop(db, boxId) {
  const goc = thietBiGocCuaHop(db, boxId);
  if (!goc || !goc.don_vi_id) return null;
  return db.prepare('SELECT * FROM nhm_don_vi WHERE id = ?').get(goc.don_vi_id) || null;
}

/** Tên cấp duyệt để hiện cho người dùng: cấp «đơn vị» thì nêu tên đơn vị của thiết bị. */
function capTen(db, cap, boxId) {
  if (cap !== 'truong_cellbank') return CAP_VN[cap];
  const dv = donViCuaHop(db, boxId);
  return dv ? dv.ten : CAP_VN.truong_cellbank;
}

// Cách gọi người duyệt hiện cho người dùng: «Quản lý <đơn vị>» (đơn vị Cellbank: người duyệt là Trưởng CIPP, cũng là người quản lý Cellbank)
const NHAN_VAI_TRO_DUYET = { truong_cellbank: 'Quản lý Cellbank' };

/** Câu chỉ người duyệt để hiện cho người dùng: «Quản lý Cellbank», «Quản lý <đơn vị>». */
function nhanNguoiDuyet(donVi) {
  if (!donVi) return null;
  return (donVi.vai_tro_duyet && NHAN_VAI_TRO_DUYET[donVi.vai_tro_duyet]) || 'Quản lý ' + donVi.ten;
}

/** Người duyệt của một đơn vị còn hoạt động: tài khoản được chỉ định + người giữ vai trò gắn với đơn vị (Cellbank: Trưởng CIPP). */
function nguoiDuyetDonVi(db, donVi) {
  if (!donVi) return [];
  const ids = new Set(db.prepare('SELECT user_id FROM nhm_don_vi_duyet WHERE don_vi_id = ?').all(donVi.id).map((r) => r.user_id));
  if (donVi.vai_tro_duyet) for (const r of db.prepare('SELECT user_id FROM nhm_vai_tro WHERE vai_tro = ?').all(donVi.vai_tro_duyet)) ids.add(r.user_id);
  return [...ids].map((id) => nguoiConHoatDong(db, id)).filter(Boolean);
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
    const donVi = donViCuaHop(db, tube.box_id);
    // dữ liệu cũ (kiểu Cellbank nhưng chưa gắn đơn vị) vẫn đi qua Trưởng CIPP
    const ds = khacNguoiGui(donVi ? nguoiDuyetDonVi(db, donVi) : nguoiCoVaiTro(db, 'truong_cellbank'));
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
  if (yc.cap === 'truong_cellbank') {
    const donVi = tube.box_id ? donViCuaHop(db, tube.box_id) : null;
    return donVi ? nguoiDuyetDonVi(db, donVi) : nguoiCoVaiTro(db, 'truong_cellbank');
  }
  return quanLyModule(db);
}

module.exports = {
  HAN_MAC_DINH, GIOI_HAN_HAN, KHOA_HAN, NHAN_HAN, layHan, luuHan, CAP_VN, sauNgay, bayGio, nguoiConHoatDong, thietBiGocCuaHop, gocCuaViTri, hopTrongCellbank, donViCuaHop, capTen, nhanNguoiDuyet, nguoiDuyetDonVi, nguoiCoVaiTro, quanLyModule,
  truongNhomHieuLuc, xacDinhCap, nguoiDuyetHienTai,
};
