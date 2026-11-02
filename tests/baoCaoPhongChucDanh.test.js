/**
 * tests/baoCaoPhongChucDanh.test.js
 * Chức danh người phụ trách báo cáo của phòng: Trưởng phòng / Phó trưởng phòng / Quyền trưởng phòng / Kế toán.
 * Về quyền chúng ĐỀU là vai trò truong_phong; chức danh chỉ để ghi rõ người đó là ai và hiện trong thư mời/thư báo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { ensureSchema } = require('../services/baoCaoPhongSchema');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');

const ADMIN = 1;
const QUAN_LY = 2;
const VIEN_TRUONG = 3;
const TP_A = 4;
const TP_B = 5;
const NGOAI = 6;

let ung;
const ID = {};

const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten, ky_tu_ngay: '2026-09-04', ky_den_ngay: '2026-10-04', tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm', muc_do: 100 } }],
});

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run().lastInsertRowid);
  ID.phongB = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('b','Phòng B')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

const tv = async (uid) => (await ung.json(QUAN_LY, 'GET', '/thanh-vien')).d.thanh_vien.find((x) => x.user_id === uid && x.vai_tro === 'truong_phong');

test('gán từng chức danh: lưu đúng, mặc định (không nói chức danh) là Trưởng phòng', async () => {
  let r = await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: TP_A, vai_tro: 'truong_phong', phong_id: ID.phongA });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await tv(TP_A)).chuc_danh, 'truong_phong');

  r = await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: TP_B, vai_tro: 'truong_phong', phong_id: ID.phongA, chuc_danh: 'pho_truong_phong' });
  assert.equal(r.s, 201);
  assert.equal((await tv(TP_B)).chuc_danh, 'pho_truong_phong');

  r = await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: NGOAI, vai_tro: 'truong_phong', phong_id: ID.phongB, chuc_danh: 'ke_toan' });
  assert.equal(r.s, 201);
  assert.equal((await tv(NGOAI)).chuc_danh, 'ke_toan');

  const ql = (await ung.json(QUAN_LY, 'GET', '/thanh-vien')).d.thanh_vien.find((x) => x.vai_tro === 'quan_ly');
  assert.equal(ql.chuc_danh, null, 'vai trò toàn module không có chức danh');
});

test('chức danh lạ bị từ chối (400); không gán trùng người vào cùng phòng dù khác chức danh (409)', async () => {
  assert.equal((await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: TP_B, vai_tro: 'truong_phong', phong_id: ID.phongB, chuc_danh: 'giam_doc' })).s, 400);
  assert.equal((await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: TP_B, vai_tro: 'truong_phong', phong_id: ID.phongA, chuc_danh: 'quyen_truong_phong' })).s, 409);
  assert.equal((await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: TP_B, vai_tro: 'truong_phong', phong_id: ID.phongA, chuc_danh: '<script>' })).s, 400);
});

test('mọi chức danh có CÙNG quyền: thấy phòng mình, nộp được báo cáo của phòng; người của phòng khác thì không', async () => {
  const dot = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt chức danh', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA, ID.phongB] });
  assert.equal(dot.s, 201, JSON.stringify(dot.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + dot.d.id)).d.bao_cao.map((b) => [b.phong_id, b.id]));

  // Phó trưởng phòng của phòng A nộp được báo cáo của phòng A
  assert.equal((await ung.json(TP_B, 'PUT', `/bao-cao/${bc[ID.phongA]}/du-lieu`, { du_lieu: DU_LIEU('Phó') })).s, 200);
  assert.equal((await ung.json(TP_B, 'POST', `/bao-cao/${bc[ID.phongA]}/nop`, {})).s, 200);
  // ...nhưng không đụng được báo cáo của phòng B (Kế toán phòng B mới là người của phòng B)
  assert.equal((await ung.json(TP_B, 'GET', `/bao-cao/${bc[ID.phongB]}`)).s, 404);
  assert.equal((await ung.json(NGOAI, 'PUT', `/bao-cao/${bc[ID.phongB]}/du-lieu`, { du_lieu: DU_LIEU('Kế toán') })).s, 200, 'kế toán của phòng B nhập được báo cáo của phòng B');
  assert.equal((await ung.json(NGOAI, 'GET', `/bao-cao/${bc[ID.phongA]}`)).s, 404);
});

test('mời email chưa có tài khoản kèm chức danh: thư ghi đúng chức danh; nhận lời mời thì tạo thành viên đúng chức danh', async () => {
  ung.thu.length = 0;
  const r = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'ketoan.moi@sci.edu.vn', phong_id: ID.phongB, chuc_danh: 'ke_toan' });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  await ung.doiThu(1);
  assert.match(ung.thu[0].subject, /^\[Báo cáo phòng ban\] Mời Kế toán — Phòng B vào module Báo cáo phòng ban$/);
  assert.match(ung.thu[0].text, /mời Kế toán — Phòng B vào module/);
  const ds = (await ung.json(QUAN_LY, 'GET', '/loi-moi')).d.loi_moi.find((l) => l.email === 'ketoan.moi@sci.edu.vn');
  assert.equal(ds.chuc_danh, 'ke_toan');

  const ma = /[a-f0-9]{32}/.exec(ung.thu[0].text)[0];
  const id = ung.dangKy('ketoan.moi@sci.edu.vn', 'Kế Toán Mới');
  const nhan = await ung.json(id, 'POST', '/loi-moi/nhan', { ma });
  assert.equal(nhan.s, 200, JSON.stringify(nhan.d));
  assert.equal(nhan.d.chuc_danh, 'ke_toan');
  assert.equal((await tv(id)).chuc_danh, 'ke_toan');

  // Gửi lại lời mời vẫn giữ chức danh
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'phophong.moi@sci.edu.vn', phong_id: ID.phongB, chuc_danh: 'quyen_truong_phong' });
  await ung.doiThu(1);
  const lm = (await ung.json(QUAN_LY, 'GET', '/loi-moi')).d.loi_moi.find((l) => l.email === 'phophong.moi@sci.edu.vn');
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', `/loi-moi/${lm.id}/gui-lai`, {});
  await ung.doiThu(1);
  assert.match(ung.thu[0].subject, /Mời Quyền trưởng phòng — Phòng B/);
});

test('mời email ĐÃ có tài khoản kèm chức danh: gán luôn đúng chức danh, thư báo ghi đúng chức danh', async () => {
  const id = ung.dangKy('co.tk@sci.edu.vn', 'Có Tài Khoản');
  ung.thu.length = 0;
  const r = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'co.tk@sci.edu.vn', phong_id: ID.phongA, chuc_danh: 'pho_truong_phong' });
  assert.equal(r.s, 201);
  assert.equal(r.d.ket_qua, 'da_gan');
  assert.equal((await tv(id)).chuc_danh, 'pho_truong_phong');
  await ung.doiThu(1);
  assert.match(ung.thu[0].subject, /Phó trưởng phòng — Phòng A: bạn đã được thêm vào module/);
  assert.match(ung.thu[0].text, /đã thêm Phó trưởng phòng — Phòng A vào module/);
  assert.equal((await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'co.tk@sci.edu.vn', phong_id: ID.phongA, chuc_danh: 'ke_toan' })).s, 409, 'đã được phân công cho phòng này');
  assert.equal((await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'x@sci.edu.vn', phong_id: ID.phongA, chuc_danh: 'giam_doc' })).s, 400);
});

test('chỉ người quản lý module / admin phân chức danh; Viện trưởng và trưởng phòng thì không', async () => {
  for (const uid of [VIEN_TRUONG, TP_A]) {
    assert.equal((await ung.json(uid, 'POST', '/thanh-vien', { user_id: ADMIN, vai_tro: 'truong_phong', phong_id: ID.phongA, chuc_danh: 'ke_toan' })).s, 403, 'user ' + uid);
  }
});

test('nâng cấp DB cũ chưa có cột chuc_danh: thêm cột, dòng cũ thành Trưởng phòng, chạy lại an toàn', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, fullname TEXT, role TEXT)');
  db.prepare("INSERT INTO users VALUES (1,'a@x','A','researcher')").run();
  db.exec('CREATE TABLE bcp_phong (id INTEGER PRIMARY KEY AUTOINCREMENT, ma TEXT UNIQUE, ten TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT)');
  db.exec(`CREATE TABLE bcp_thanh_vien (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    vai_tro TEXT NOT NULL CHECK (vai_tro IN ('quan_ly','vien_truong','truong_phong')), phong_id INTEGER, created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (phong_id) REFERENCES bcp_phong(id),
    CHECK ((vai_tro IN ('quan_ly','vien_truong') AND phong_id IS NULL) OR (vai_tro = 'truong_phong' AND phong_id IS NOT NULL)))`);
  db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run();
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (1, 'truong_phong', 1)").run();
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (1, 'quan_ly')").run();

  ensureSchema(db);
  ensureSchema(db);
  const dong = db.prepare('SELECT vai_tro, chuc_danh FROM bcp_thanh_vien ORDER BY id').all();
  assert.deepEqual(dong, [{ vai_tro: 'truong_phong', chuc_danh: 'truong_phong' }, { vai_tro: 'quan_ly', chuc_danh: null }]);
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'bcp_loi_moi'").get().sql.includes('chuc_danh'));
});
