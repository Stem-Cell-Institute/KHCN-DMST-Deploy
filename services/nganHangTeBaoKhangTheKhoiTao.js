'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — khởi tạo lúc server khởi động: tạo bảng nhm_*, chuyển hướng địa chỉ cũ,
 * đồng bộ nhãn thẻ trang chủ, và số liệu thẻ trang chủ.
 *
 * Tách khỏi routes/nganHangTeBaoKhangThe.js để router chỉ lo HTTP. server.js chỉ gọi
 * `require('./routes/nganHangTeBaoKhangThe').mount(app, deps)` (xem index.js của router).
 */

const fs = require('fs');
const path = require('path');
const { HOLDING } = require('./nganHangTeBaoKhangThe');

const MODULE_LABEL = 'Ngân hàng tế bào & Kháng thể';
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'ngan_hang_te_bao_khang_the_schema.sql');
// Địa chỉ rút gọn + các tên cũ (để liên kết đã gửi vẫn dùng được)
const LEGACY_PATHS = [
  '/ngan-hang-te-bao-khang-the',
  '/ngan-hang-te-bao-khang-the.html',
  '/kho-mau-sinh-pham',
  '/kho-mau-sinh-pham.html',
  '/public/kho-mau-sinh-pham/index.html',
  '/ngan-hang-mau',
  '/ngan-hang-mau.html',
  '/nganhangmau.html',
];
const PAGE_URL = '/public/ngan-hang-te-bao-khang-the/index.html';

/** Tạo bảng nhm_* (idempotent). Thiếu file schema là lỗi nặng: ném ra để server.js ghi cảnh báo, không bỏ qua im lặng. */
function ensureSchema(db) {
  if (!fs.existsSync(SCHEMA_PATH)) throw new Error('Thiếu file schema: ' + SCHEMA_PATH);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

/** Số liệu thẻ module trên trang chủ; bảng chưa có thì trả 0. */
function miniStats(db) {
  const count = (sql) => {
    try {
      return Number(db.prepare(sql).get().c) || 0;
    } catch (e) {
      return 0;
    }
  };
  return {
    containers: count('SELECT COUNT(*) AS c FROM nhm_containers WHERE deleted_at IS NULL'),
    boxes: count('SELECT COUNT(*) AS c FROM nhm_boxes WHERE deleted_at IS NULL'),
    samples: count(`SELECT COUNT(*) AS c FROM nhm_tubes WHERE deleted_at IS NULL AND status IN ${HOLDING}`),
  };
}

/** Tạo bảng, đăng ký chuyển hướng địa chỉ cũ, đồng bộ nhãn trang chủ. Không mount API (việc của index.js). */
function khoiTao(app, db) {
  ensureSchema(db);
  app.get(LEGACY_PATHS, (req, res) => res.redirect(302, PAGE_URL));
  // Đồng bộ tên hiển thị cho cơ sở dữ liệu đã có dòng homepage_modules từ tên cũ
  db.prepare("UPDATE homepage_modules SET label = ? WHERE code = 'sample_storage' AND label <> ?").run(MODULE_LABEL, MODULE_LABEL);
}

module.exports = { MODULE_LABEL, SCHEMA_PATH, LEGACY_PATHS, PAGE_URL, ensureSchema, miniStats, khoiTao };
