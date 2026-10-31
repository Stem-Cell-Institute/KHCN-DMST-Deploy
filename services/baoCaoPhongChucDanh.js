/**
 * Chức danh của người được phân công làm báo cáo cho một phòng.
 *
 * Về quyền, mọi chức danh dưới đây ĐỀU là vai trò `truong_phong` (cùng nộp báo cáo của phòng, cùng nhận thư): chức danh chỉ để
 * ghi rõ người đó là ai trong phòng. Lưu ở cột `chuc_danh` của bcp_thanh_vien / bcp_loi_moi; giao diện có bản sao nhãn trong
 * public/js/baoCaoPhong.js (CHUC_DANH) — đổi ở đây thì đổi ở đó.
 */

const CHUC_DANH = {
  truong_phong: 'Trưởng phòng',
  pho_truong_phong: 'Phó trưởng phòng',
  quyen_truong_phong: 'Quyền trưởng phòng',
  ke_toan: 'Kế toán',
};
const MAC_DINH = 'truong_phong';

const hopLe = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(CHUC_DANH, k);
/** Nhãn hiển thị; giá trị lạ hoặc rỗng (dữ liệu cũ) quy về "Trưởng phòng". */
const nhan = (k) => (hopLe(k) ? CHUC_DANH[k] : CHUC_DANH[MAC_DINH]);

module.exports = { CHUC_DANH, MAC_DINH, hopLe, nhan };
