'use strict';

/**
 * API Ngân hàng tế bào & Kháng thể — mount tại /api/ngan-hang-te-bao-khang-the
 * Vị trí lưu trữ (tủ/bình → ngăn → giá) → hộp (lưới hàng x cột) → mẫu (ống đông lạnh, kháng thể, sinh phẩm...).
 *
 * Tài liệu: readme/MODULE-NGAN-HANG-TE-BAO-KHANG-THE.md. Test: tests/nganHangTeBaoKhangThe.test.js.
 *
 * Thứ tự đăng ký có ý nghĩa: route tĩnh (vd /tubes/tim-kiem) phải đứng TRƯỚC route `:id` (xem
 * readme/KIEN-TRUC-VA-CAM-BAY.md), nên mỗi router con được nối đúng thứ tự dưới đây.
 */

const express = require('express');
const taoBoiCanh = require('./boiCanh');
const createKhoLuuTruRouter = require('./khoLuuTru');
const createMauRouter = require('./mau');
const createThanhVienRouter = require('./thanhVien');
const createYeuCauRouter = require('./yeuCau');
const createPhatHienRouter = require('./phatHien');
const createSinhVienRouter = require('./sinhVien');
const createTimKiemRouter = require('./timKiem');
const createDanhMucRouter = require('./danhMuc');
const createDonViRouter = require('./donVi');
const khoiTao = require('../../services/nganHangTeBaoKhangTheKhoiTao');

function createNganHangMauRouter(deps) {
  const ctx = taoBoiCanh(deps);
  const router = express.Router();
  router.use(deps.authMiddleware);
  // tài khoản sinh viên: hết hạn / bị thu hồi thì không vào module (Đặt lịch thiết bị vẫn dùng được); còn hạn thì tự có hồ sơ «sinh viên»
  router.use((req, res, next) => ctx.chanSinhVien(req, res, next));
  router.use(createKhoLuuTruRouter(ctx));
  router.use(createSinhVienRouter(ctx));
  router.use(createThanhVienRouter(ctx));
  router.use(createDanhMucRouter(ctx));
  router.use(createDonViRouter(ctx));
  router.use(createTimKiemRouter(ctx));
  router.use(createYeuCauRouter(ctx));
  router.use(createPhatHienRouter(ctx));
  router.use(createMauRouter(ctx));
  // cho test và bộ hẹn giờ gọi trực tiếp
  router.quetQuaHan = ctx.quetQuaHan;
  router.quetSinhVien = ctx.quetSinhVien;
  router.dinhTuyenLai = ctx.dinhTuyenLai;
  // Bộ hẹn giờ trong tiến trình: chuyển yêu cầu quá hạn lên quản lý (đa số máy chỉ chạy MỘT tiến trình; câu lệnh UPDATE
  // có điều kiện nên chạy chồng cũng không chuyển hai lần). Không giữ tiến trình sống (unref).
  if (deps.nhacTuDong) {
    const quet = () => Promise.resolve().then(() => ctx.quetQuaHan()).then(() => ctx.quetSinhVien()).catch((e) => console.warn('[ngan-hang] quét quá hạn lỗi:', e && e.message));
    const dau = setTimeout(quet, 2 * 60 * 1000);
    const lap = setInterval(quet, ctx.CHU_KY_QUET_MS);
    for (const t of [dau, lap]) if (t.unref) t.unref();
  }
  return router;
}

/** Tạo bảng nhm_*, chuyển hướng địa chỉ cũ, đồng bộ nhãn trang chủ và mount API — gọi từ server.js. */
function mount(app, deps) {
  khoiTao.khoiTao(app, deps.db);
  app.use('/api/ngan-hang-te-bao-khang-the', createNganHangMauRouter(deps));
}

module.exports = createNganHangMauRouter;
module.exports.miniStats = khoiTao.miniStats;
module.exports.mount = mount;
