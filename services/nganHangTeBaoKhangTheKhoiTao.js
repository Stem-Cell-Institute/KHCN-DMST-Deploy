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
const { HOLDING, placeholders } = require('./nganHangTeBaoKhangThe');

const MODULE_LABEL = 'Ngân hàng tế bào & Kháng thể';
// Nhãn thẻ trang chủ từ các tên cũ của module
const OLD_LABELS = ['Ngân hàng mẫu', 'Kho mẫu sinh phẩm'];
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

// Cột thêm sau bản đầu: CREATE TABLE IF NOT EXISTS không thêm cột vào bảng đã có, nên thêm bằng ALTER TABLE
// TRƯỚC khi chạy file schema (file schema có chỉ mục dùng các cột này).
const COT_THEM_SAU = [
  ['nhm_containers', 'quan_ly_boi', "TEXT NOT NULL DEFAULT 'cong_khai' CHECK (quan_ly_boi IN ('cong_khai','cellbank'))"],
  ['nhm_containers', 'don_vi_id', 'INTEGER REFERENCES nhm_don_vi(id)'],
  ['nhm_containers', 'rieng_user_id', 'INTEGER'],
  ['nhm_containers', 'ngan_hang', "TEXT NOT NULL DEFAULT 'te_bao' CHECK (ngan_hang IN ('te_bao','khang_the'))"],
  ['nhm_don_vi', 'ngan_hang', "TEXT NOT NULL DEFAULT 'te_bao' CHECK (ngan_hang IN ('te_bao','khang_the'))"],
  ['nhm_containers', 'vi_tri', 'INTEGER CHECK (vi_tri IS NULL OR vi_tri BETWEEN 1 AND 50)'],
  ['nhm_boxes', 'vi_tri', 'INTEGER CHECK (vi_tri IS NULL OR vi_tri BETWEEN 1 AND 50)'],
  ['nhm_ho_so', 'chuc_danh', 'TEXT'],
  ['nhm_tubes', 'chu_loai', "TEXT CHECK (chu_loai IS NULL OR chu_loai IN ('sinh_vien','nghien_cuu_vien','can_bo'))"],
  ['nhm_tubes', 'nhom_id', 'INTEGER REFERENCES nhm_nhom(id)'],
  ['nhm_movements', 'user_label', 'TEXT'],
  ['nhm_tubes', 'thay_luc', 'TEXT'],
];

function themCotNeuThieu(db) {
  for (const [bang, cot, ddl] of COT_THEM_SAU) {
    const coBang = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(bang);
    if (!coBang) continue; // DB mới: CREATE TABLE trong file schema đã có đủ cột
    const dacCot = db.prepare(`PRAGMA table_info(${bang})`).all().some((c) => c.name === cot);
    if (!dacCot) db.exec(`ALTER TABLE ${bang} ADD COLUMN ${cot} ${ddl}`);
  }
}

/**
 * Bảng vai trò từ các bản trước thiếu cột ngan_hang (phạm vi ngân hàng) và/hoặc giá trị 'vien_truong' trong CHECK, và có UNIQUE (user_id, vai_tro);
 * SQLite không sửa được các ràng buộc này nên dựng lại bảng (sao chép nguyên dữ liệu, giữ id). Chạy một lần, idempotent.
 */
function nangCapVaiTro(db) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nhm_vai_tro'").get();
  if (!r || String(r.sql).includes('ngan_hang')) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE nhm_vai_tro_moi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vai_tro TEXT NOT NULL CHECK (vai_tro IN ('quan_ly','truong_cellbank','vien_truong')),
      ngan_hang TEXT CHECK (ngan_hang IS NULL OR ngan_hang IN ('te_bao','khang_the')),
      granted_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    // vai trò cũ không có phạm vi → NULL = cả hai ngân hàng (người quản lý hiện có giữ nguyên quyền)
    db.exec('INSERT INTO nhm_vai_tro_moi (id, user_id, vai_tro, ngan_hang, granted_by, created_at) SELECT id, user_id, vai_tro, NULL, granted_by, created_at FROM nhm_vai_tro');
    db.exec('DROP TABLE nhm_vai_tro');
    db.exec('ALTER TABLE nhm_vai_tro_moi RENAME TO nhm_vai_tro');
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_nhm_vai_tro ON nhm_vai_tro (user_id, vai_tro, IFNULL(ngan_hang, ''))");
  })();
}

/** Tạo bảng nhm_* (idempotent). Thiếu file schema là lỗi nặng: ném ra để server.js ghi cảnh báo, không bỏ qua im lặng. */
function ensureSchema(db) {
  if (!fs.existsSync(SCHEMA_PATH)) throw new Error('Thiếu file schema: ' + SCHEMA_PATH);
  themCotNeuThieu(db);
  nangCapVaiTro(db);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

/** Số liệu thẻ module trên trang chủ; bảng chưa có thì trả 0. */
// vị trí thuộc một thiết bị RIÊNG (kể cả chính nó và mọi cấp con cháu)
const CTE_RIENG = 'WITH RECURSIVE rieng(id) AS (SELECT id FROM nhm_containers WHERE rieng_user_id IS NOT NULL UNION SELECT c.id FROM nhm_containers c JOIN rieng r ON c.parent_id = r.id)';

function miniStats(db) {
  const count = (sql) => {
    try {
      return Number(db.prepare(sql).get().c) || 0;
    } catch (e) {
      return 0;
    }
  };
  return {
    // thiết bị RIÊNG (rieng_user_id) và mọi thứ bên trong không tính vào số liệu công khai của trang chủ
    containers: count(`${CTE_RIENG} SELECT COUNT(*) AS c FROM nhm_containers WHERE deleted_at IS NULL AND id NOT IN (SELECT id FROM rieng)`),
    boxes: count(`${CTE_RIENG} SELECT COUNT(*) AS c FROM nhm_boxes b WHERE b.deleted_at IS NULL AND b.container_id NOT IN (SELECT id FROM rieng)`),
    samples: count(`${CTE_RIENG} SELECT COUNT(*) AS c FROM nhm_tubes t WHERE t.deleted_at IS NULL AND t.status IN ${HOLDING} AND (t.box_id IS NULL OR t.box_id NOT IN (SELECT b.id FROM nhm_boxes b WHERE b.container_id IN (SELECT id FROM rieng)))`),
  };
}

/** Tạo bảng, đăng ký chuyển hướng địa chỉ cũ, đồng bộ nhãn trang chủ. Không mount API (việc của index.js). */
function khoiTao(app, db) {
  ensureSchema(db);
  app.get(LEGACY_PATHS, (req, res) => res.redirect(302, PAGE_URL));
  // Chỉ đổi nhãn khi dòng homepage_modules còn mang TÊN CŨ; nhãn admin đã tự đặt thì giữ nguyên qua các lần khởi động.
  db.prepare(`UPDATE homepage_modules SET label = ? WHERE code = 'sample_storage' AND label IN (${placeholders(OLD_LABELS.length)})`).run(
    MODULE_LABEL,
    ...OLD_LABELS
  );
}

module.exports = { MODULE_LABEL, SCHEMA_PATH, LEGACY_PATHS, PAGE_URL, ensureSchema, miniStats, khoiTao };
