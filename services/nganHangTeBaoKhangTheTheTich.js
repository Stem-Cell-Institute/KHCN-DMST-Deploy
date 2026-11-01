'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — thể tích (µL) của ống KHÁNG THỂ: thể tích ban đầu, còn lại, mỗi lần dùng, khi hết.
 * Hàm thuần theo `db` (không biết req/res); router: routes/nganHangTeBaoKhangThe/theTich.js, yêu cầu: yeuCau.js.
 *
 * Quy tắc:
 *   - Mỗi thay đổi ghi MỘT dòng vào sổ nhm_the_tich (chỉ thêm, có trigger chặn sửa / xóa) và MỘT dòng vào lịch sử mẫu (nhm_movements).
 *   - Số còn lại không âm: dùng quá số còn lại bị từ chối (không để số liệu sai).
 *   - Ống HẾT (còn lại = 0): ống được bỏ khỏi kho (trạng thái «đã hủy», nhả ô trong hộp), sổ ghi dòng 'het' kèm lý do;
 *     ống và toàn bộ lịch sử vẫn tìm lại được (lọc «mọi trạng thái»).
 *   - Số µL làm tròn 1 chữ số thập phân.
 */

/** Sắp hết khi còn không quá tỉ lệ này so với thể tích ban đầu. */
const SAP_HET_TY_LE = 0.2;
const TOI_DA_UL = 1e6;

const lamTron = (x) => Math.round(Number(x) * 10) / 10;

/** Số µL hợp lệ (> 0, tối đa TOI_DA_UL) → [giá trị, lỗi]. */
function docUl(v, nhan) {
  const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n <= 0) return [null, `${nhan} phải là số lớn hơn 0 (µL).`];
  if (n > TOI_DA_UL) return [null, `${nhan} quá lớn (tối đa ${TOI_DA_UL} µL).`];
  return [lamTron(n), null];
}

/** 'chua_ghi' | 'con' | 'sap_het' | 'het' theo thể tích ban đầu và còn lại. */
function trangThai(theTich, conLai) {
  if (conLai == null) return 'chua_ghi';
  if (conLai <= 0) return 'het';
  if (theTich != null && theTich > 0 && conLai <= theTich * SAP_HET_TY_LE) return 'sap_het';
  return 'con';
}

const TRANG_THAI_VN = { chua_ghi: 'Chưa ghi thể tích', con: 'Còn', sap_het: 'Sắp hết', het: 'Hết' };

/** Ghi một dòng vào sổ thể tích. `nguoiDung` / `nguoiGhi` = {id, label}. */
function ghiSo(db, { tubeId, hanhDong, soUl, conLai, nguoiDung, yeuCauId, ghiChu, nguoiGhi }) {
  db.prepare(
    `INSERT INTO nhm_the_tich (tube_id, hanh_dong, so_ul, con_lai_ul, nguoi_dung_id, nguoi_dung_label, yeu_cau_id, ghi_chu, user_id, user_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tubeId, hanhDong, lamTron(soUl), lamTron(conLai), nguoiDung ? nguoiDung.id : null, nguoiDung ? nguoiDung.label : null,
    yeuCauId || null, ghiChu || null, nguoiGhi ? nguoiGhi.id : null, nguoiGhi ? nguoiGhi.label : null
  );
}

/** Sổ thể tích của một ống, mới nhất trước. */
function laySo(db, tubeId) {
  return db.prepare('SELECT * FROM nhm_the_tich WHERE tube_id = ? ORDER BY id DESC').all(tubeId);
}

/** Tóm tắt cho giao diện: số liệu + trạng thái + tỉ lệ còn lại (0–1, null nếu chưa ghi). */
function tomTat(tube) {
  const tt = trangThai(tube.the_tich_ul, tube.con_lai_ul);
  return {
    the_tich_ul: tube.the_tich_ul == null ? null : tube.the_tich_ul,
    con_lai_ul: tube.con_lai_ul == null ? null : tube.con_lai_ul,
    trang_thai: tt,
    trang_thai_ten: TRANG_THAI_VN[tt],
    ty_le: tube.the_tich_ul > 0 && tube.con_lai_ul != null ? Math.max(0, Math.min(1, tube.con_lai_ul / tube.the_tich_ul)) : null,
  };
}

module.exports = { SAP_HET_TY_LE, TOI_DA_UL, TRANG_THAI_VN, lamTron, docUl, trangThai, ghiSo, laySo, tomTat };
