'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — hàm thuần dùng chung cho các router trong routes/nganHangTeBaoKhangThe/.
 * Không biết `req`/`res`.
 */

// Vai trò TRONG module (bảng nhm_vai_tro) — chỉ admin cấp / gỡ.
const VAI_TRO_MODULE = ['quan_ly', 'truong_cellbank'];
const VAI_TRO_VN = { quan_ly: 'Quản lý module', truong_cellbank: 'Trưởng CIPP (Cellbank)' };

// Loại chủ mẫu, để lọc và để biết ai duyệt yêu cầu khi người gửi mẫu đã ra trường / nghỉ việc.
const LOAI_CHU = ['sinh_vien', 'nghien_cuu_vien', 'can_bo'];
const LOAI_CHU_VN = { sinh_vien: 'Sinh viên', nghien_cuu_vien: 'Nghiên cứu viên', can_bo: 'Cán bộ' };

// Trạng thái mẫu còn "giữ chỗ" trong hộp (đang lưu hoặc đã lấy ra chờ trả lại).
const HOLDING = "('in_storage','checked_out')";

/** Số nguyên từ số hoặc chuỗi số nguyên; mọi thứ khác (null, '', true, mảng, 1.5) trả null. */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v);
  return null;
}

function toStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Đọc trường số tùy chọn: trống => {value: null}; không phải số hữu hạn hoặc ngoài [min, max] => {error}.
 * (Trước đây chuỗi rác bị nuốt thành null mà không báo.)
 */
function parseSo(v, { min = -Infinity, max = Infinity, label }) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return { value: null };
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) return { error: `${label} không hợp lệ.` };
  return { value: n };
}

/** Ngày YYYY-MM-DD có thật trong lịch; trống => {value: null}. */
function parseNgay(v, label) {
  if (v == null || (typeof v === 'string' && v.trim() === '')) return { value: null };
  const s = typeof v === 'string' ? v.trim() : '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    return { error: `${label} không hợp lệ (định dạng YYYY-MM-DD).` };
  }
  return { value: s };
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

/** Tên so khớp: bỏ dấu, viết thường, gộp khoảng trắng — «Nhóm Nam» và «nhom  nam» là một. */
function chuanHoaTen(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isUniqueError(e) {
  return !!(e && /UNIQUE constraint/i.test(String(e.message || '')));
}

const TRANG_THAI_VN = { in_storage: 'Đang lưu kho', checked_out: 'Đã lấy ra', thawed: 'Đã rã đông', discarded: 'Đã hủy' };

// ---------- Truy vết thay đổi ----------

const NHAN_TRUONG = {
  name: 'Tên', sample_type_id: 'Loại mẫu', passage: 'Passage', cell_count: 'Số tế bào',
  volume_ml: 'Thể tích (mL)', freeze_date: 'Ngày đông lạnh', project: 'Đề tài', notes: 'Ghi chú', code: 'Mã',
  container_id: 'Vị trí lưu trữ', rows: 'Số hàng', cols: 'Số cột', type_id: 'Loại', parent_id: 'Thuộc vị trí',
  ten: 'Tên nhóm', truong_user_id: 'Trưởng nhóm', trang_thai: 'Trạng thái', truong_xac_nhan: 'Trưởng nhóm đã xác nhận',
  chu_loai: 'Loại chủ mẫu', nhom_id: 'Nhóm nghiên cứu', ghi_chu: 'Ghi chú', quan_ly_boi: 'Do ai quản lý',
  temperature_c: 'Nhiệt độ (°C)', location_note: 'Vị trí đặt', sort_order: 'Thứ tự', template_id: 'Mẫu hộp',
};

/** Các trường THỰC SỰ đổi giá trị: {trường: [cũ, mới]} (null/undefined coi như nhau). */
function layThayDoi(cur, upd) {
  const out = {};
  for (const k of Object.keys(upd)) {
    const a = cur[k] == null ? null : cur[k];
    const b = upd[k] == null ? null : upd[k];
    if (a !== b) out[k] = [a, b];
  }
  return out;
}

function cat(v) {
  return v == null ? '(trống)' : String(v).slice(0, 100);
}

/** «Passage: P12 → P13; Ghi chú: (trống) → x» — dùng cho nhật ký hoạt động. */
function moTaThayDoi(thayDoi) {
  return Object.keys(thayDoi)
    .map((k) => `${NHAN_TRUONG[k] || k}: ${cat(thayDoi[k][0])} → ${cat(thayDoi[k][1])}`)
    .join('; ');
}

/** Dạng gọn để lưu vào nhm_movements.note (JSON {trường: [cũ, mới]}, chuỗi cắt 100 ký tự). */
function thayDoiJson(thayDoi) {
  const out = {};
  for (const k of Object.keys(thayDoi)) out[k] = thayDoi[k].map((v) => (typeof v === 'string' ? v.slice(0, 100) : v));
  return JSON.stringify(out);
}

module.exports = {
  VAI_TRO_MODULE, VAI_TRO_VN, LOAI_CHU, LOAI_CHU_VN, chuanHoaTen, HOLDING, toInt, toStr, parseSo, parseNgay, placeholders, isUniqueError,
  TRANG_THAI_VN, NHAN_TRUONG, layThayDoi, moTaThayDoi, thayDoiJson,
};
