'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — hàm thuần dùng chung cho các router trong routes/nganHangTeBaoKhangThe/.
 * Không biết `req`/`res`.
 */

// Vai trò (users.role, viết thường) được quản lý kho: tạo/sửa/xóa vị trí lưu trữ và hộp, sửa mọi mẫu.
const MANAGE_ROLES = new Set(['admin', 'manager', 'phong_khcn']);

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

function isUniqueError(e) {
  return !!(e && /UNIQUE constraint/i.test(String(e.message || '')));
}

module.exports = { MANAGE_ROLES, HOLDING, toInt, toStr, parseSo, parseNgay, placeholders, isUniqueError };
