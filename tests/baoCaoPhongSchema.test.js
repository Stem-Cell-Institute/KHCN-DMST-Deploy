/**
 * tests/baoCaoPhongSchema.test.js
 * Lược đồ DB của module: chuyển đổi bảng kiểu cũ, nạp mẫu mặc định đúng một lần, chạy lại an toàn.
 * Chạy trên DB :memory:, không cần data/sci-ace.db.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { ensureSchema } = require('../services/baoCaoPhongSchema');

function dbMoi() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, fullname TEXT, role TEXT)');
  for (let i = 1; i <= 3; i++) db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(i, `u${i}@x`, 'U' + i, 'researcher');
  return db;
}

test('lược đồ mới: tạo đủ bảng, nạp biểu mẫu mặc định đúng một lần dù chạy lại nhiều lần', () => {
  const db = dbMoi();
  ensureSchema(db);
  ensureSchema(db);
  ensureSchema(db);
  const bang = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'bcp_%'").all().map((r) => r.name);
  for (const t of ['bcp_phong', 'bcp_thanh_vien', 'bcp_mau', 'bcp_mau_phien_ban', 'bcp_dot', 'bcp_bao_cao', 'bcp_lich_su', 'bcp_trinh', 'bcp_trinh_tep', 'bcp_dot_lich_su']) {
    assert.ok(bang.includes(t), 'thiếu bảng ' + t);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bcp_mau').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bcp_mau_phien_ban').get().n, 1);
});

test('đã có biểu mẫu của người quản lý thì KHÔNG nạp thêm mẫu mặc định', () => {
  const db = dbMoi();
  ensureSchema(db);
  db.prepare('DELETE FROM bcp_mau').run(); // giả lập DB đã có mẫu riêng: dọn mẫu mặc định rồi thêm mẫu của họ
  db.prepare("INSERT INTO bcp_mau (ten) VALUES ('Mẫu riêng')").run();
  ensureSchema(db);
  assert.deepEqual(db.prepare('SELECT ten FROM bcp_mau').all().map((r) => r.ten), ['Mẫu riêng']);
});

test('bảng thành viên kiểu CŨ (chưa có vien_truong) được chuyển đổi, giữ nguyên dữ liệu', () => {
  const db = dbMoi();
  db.exec('CREATE TABLE bcp_phong (id INTEGER PRIMARY KEY AUTOINCREMENT, ma TEXT UNIQUE, ten TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT)');
  db.exec(
    `CREATE TABLE bcp_thanh_vien (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
       vai_tro TEXT NOT NULL CHECK (vai_tro IN ('quan_ly','truong_phong')), phong_id INTEGER, created_by INTEGER,
       created_at TEXT DEFAULT (datetime('now')),
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (phong_id) REFERENCES bcp_phong(id),
       CHECK ((vai_tro = 'quan_ly' AND phong_id IS NULL) OR (vai_tro = 'truong_phong' AND phong_id IS NOT NULL)))`
  );
  db.exec("CREATE UNIQUE INDEX ux_bcp_thanh_vien_quan_ly ON bcp_thanh_vien(user_id) WHERE vai_tro = 'quan_ly'");
  db.exec("CREATE UNIQUE INDEX ux_bcp_thanh_vien_phong ON bcp_thanh_vien(user_id, phong_id) WHERE vai_tro = 'truong_phong'");
  db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('khcn','Phòng KHCN')").run();
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (1, 'quan_ly')").run();
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (2, 'truong_phong', 1)").run();

  ensureSchema(db);

  assert.deepEqual(
    db.prepare('SELECT user_id, vai_tro, phong_id FROM bcp_thanh_vien ORDER BY id').all(),
    [{ user_id: 1, vai_tro: 'quan_ly', phong_id: null }, { user_id: 2, vai_tro: 'truong_phong', phong_id: 1 }]
  );
  assert.equal(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'bcp_thanh_vien_cu'").get(), undefined, 'bảng tạm phải được dọn');
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (3, 'vien_truong')").run(); // giờ mới chèn được
});

test('ràng buộc: Viện trưởng chỉ một lần, không gắn phòng; trưởng phòng bắt buộc có phòng', () => {
  const db = dbMoi();
  ensureSchema(db);
  db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','A')").run();
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (1, 'vien_truong')").run();
  assert.throws(() => db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (1, 'vien_truong')").run(), /UNIQUE/);
  assert.throws(() => db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (2, 'vien_truong', 1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (2, 'truong_phong')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (2, 'vai_tro_la')").run(), /CHECK/);
  // một người vừa là quản lý vừa là Viện trưởng thì được (hai vai trò khác nhau)
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (1, 'quan_ly')").run();
});

test('xóa tài khoản không bị module chặn: dòng thành viên bị xóa theo', () => {
  const db = dbMoi();
  ensureSchema(db);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (3, 'quan_ly')").run();
  db.prepare('DELETE FROM users WHERE id = 3').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bcp_thanh_vien').get().n, 0);
});
