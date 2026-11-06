'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — việc ĐẾN HẠN (kiểm kê, QC mycoplasma / STR, nhiệt độ). 1 endpoint + bộ quét gửi thư nhắc.
 * Cách tính: services/nganHangTeBaoKhangTheNhacViec.js. Chu kỳ chỉnh ở Quản lý module → Cấu hình hạn (danhMuc.js).
 *
 * Người xem: quản lý module (mọi việc của ngân hàng) và chủ thiết bị riêng (chỉ việc của thiết bị đó; admin thấy tất cả).
 * Bộ quét (ctx.quetNhacViec) chạy cùng bộ hẹn giờ quá hạn của index.js: gộp thư theo người, mỗi việc nhắc lại sau NHAC_LAI_NGAY ngày.
 */

const express = require('express');
const NhacViec = require('../../services/nganHangTeBaoKhangTheNhacViec');

module.exports = function createNhacViecRouter(ctx) {
  const { db, canManage, laAdmin, thongBao } = ctx;
  const router = express.Router();

  /** Việc đến hạn mà người đang gọi được thấy (đã bỏ trường nội bộ). */
  function viecCuaToi(req) {
    // /me gọi mỗi lần mở trang: người thường (không phải quản lý / Viện trưởng) không có việc nào nên khỏi tính
    if (!canManage(req) && !ctx.laVienTruong(req)) return [];
    return NhacViec.tinhViecDenHan(db, req.nganHang)
      .filter((v) => (v.rieng_user_id == null ? canManage(req) : v.rieng_user_id === req.user.id || laAdmin(req)))
      .map(({ rieng_user_id, nguoi_tao_id, ...v }) => v);
  }

  router.get('/reminders', (req, res) => {
    res.json({ viec: viecCuaToi(req), chu_ky: NhacViec.layChuKy(db) });
  });

  ctx.demDenHan = (req) => viecCuaToi(req).length;
  ctx.quetNhacViec = (ms = Date.now()) => NhacViec.quetNhacViec(db, thongBao, ms);

  return router;
};
