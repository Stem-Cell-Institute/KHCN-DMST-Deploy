'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — hàm thuần dùng chung cho các router trong routes/nganHangTeBaoKhangThe/.
 * Không biết `req`/`res`.
 */

// Vai trò (users.role, viết thường) được quản lý kho: tạo/sửa/xóa vị trí lưu trữ và hộp, sửa mọi mẫu.
const MANAGE_ROLES = new Set(['admin', 'manager', 'phong_khcn']);

// Trạng thái mẫu còn "giữ chỗ" trong hộp (đang lưu hoặc đã lấy ra chờ trả lại).
const HOLDING = "('in_storage','checked_out')";

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function toStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

function isUniqueError(e) {
  return !!(e && /UNIQUE constraint/i.test(String(e.message || '')));
}

module.exports = { MANAGE_ROLES, HOLDING, toInt, toStr, toNum, placeholders, isUniqueError };
