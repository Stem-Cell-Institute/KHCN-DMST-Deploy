/**
 * tests/baoCaoPhongXoaPhong.test.js
 * Xóa phòng: chỉ khi phòng CHƯA TỪNG được giao đợt nào (kể cả đợt Nháp); xóa kèm gỡ trưởng phòng và hủy lời mời đang chờ,
 * không đụng tới tài khoản; phòng đã dùng thì phải "Ngừng dùng" để không mất báo cáo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');

const ADMIN = 1;
const QUAN_LY = 2;
const VIEN_TRUONG = 3;
const TP_A = 4;
const TP_B = 5;
const NGOAI = 6;

let ung;
const ID = {};

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  const phong = (ma, ten) => Number(db.prepare('INSERT INTO bcp_phong (ma, ten) VALUES (?,?)').run(ma, ten).lastInsertRowid);
  ID.dung = phong('dung', 'Phòng đã dùng');
  ID.trong = phong('trong', 'Phòng chưa giao đợt');
  ID.khac = phong('khac', 'Phòng khác');
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.dung);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.trong);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_B, ID.khac);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

const phongCon = (id) => ung.db.prepare('SELECT 1 AS ok FROM bcp_phong WHERE id = ?').get(id);

test('danh sách phòng có số đợt đã giao (để giao diện biết phòng nào xóa được)', async () => {
  const dot = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt 1', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.dung] });
  assert.equal(dot.s, 201, JSON.stringify(dot.d));
  ID.dot = dot.d.id;
  const ds = (await ung.json(QUAN_LY, 'GET', '/phong')).d.phong;
  assert.equal(ds.find((p) => p.id === ID.dung).so_dot, 1);
  assert.equal(ds.find((p) => p.id === ID.trong).so_dot, 0);
});

test('phòng đã được giao đợt (kể cả đợt Nháp): 409, nêu lý do và hướng "Ngừng dùng", phòng và trưởng phòng giữ nguyên', async () => {
  const r = await ung.json(QUAN_LY, 'DELETE', '/phong/' + ID.dung);
  assert.equal(r.s, 409);
  assert.match(r.d.message, /đã được giao trong 1 đợt/);
  assert.match(r.d.message, /Ngừng dùng/);
  assert.ok(phongCon(ID.dung));
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_thanh_vien WHERE phong_id = ?').get(ID.dung).n, 1);
});

test('phòng chưa từng giao đợt: xóa được, kèm gỡ trưởng phòng và hủy lời mời; tài khoản và phòng khác không bị đụng', async () => {
  const moi = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'moi@sci.edu.vn', phong_id: ID.trong });
  assert.equal(moi.s, 201, JSON.stringify(moi.d));
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_loi_moi WHERE phong_id = ?').get(ID.trong).n, 1);

  const r = await ung.json(QUAN_LY, 'DELETE', '/phong/' + ID.trong);
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.go_truong_phong, 1);
  assert.ok(!phongCon(ID.trong), 'phòng đã bị xóa');
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_thanh_vien WHERE phong_id = ?').get(ID.trong).n, 0, 'trưởng phòng đã được gỡ');
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_loi_moi WHERE phong_id = ?').get(ID.trong).n, 0, 'lời mời đã hủy');
  assert.ok(ung.db.prepare('SELECT 1 AS ok FROM users WHERE id = ?').get(TP_A), 'tài khoản trưởng phòng vẫn còn');

  const me = (await ung.json(TP_A, 'GET', '/me')).d;
  assert.deepEqual(me.phong.map((p) => p.id), [ID.dung], 'chỉ còn phòng kia');
  assert.ok(phongCon(ID.khac), 'phòng khác không bị ảnh hưởng');
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_thanh_vien WHERE phong_id = ?').get(ID.khac).n, 1);
});

test('xóa đợt Nháp xong thì phòng đó hết "đã dùng" và xóa được', async () => {
  const nhap = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt nháp tạm', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.khac] });
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/phong/' + ID.khac)).s, 409);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/dot/' + nhap.d.id)).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/phong/' + ID.khac)).s, 200);
  assert.ok(!phongCon(ID.khac));
});

test('phòng đã đóng đợt vẫn không xóa được (báo cáo vẫn là hồ sơ của phòng)', async () => {
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${ID.dot}/mo`, {})).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${ID.dot}/dong`, {})).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/phong/' + ID.dung)).s, 409);
});

test('quyền: chỉ quản lý module và admin; Viện trưởng, trưởng phòng, người ngoài 403; chưa đăng nhập 401', async () => {
  const phong = Number(ung.db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('tam','Phòng tạm')").run().lastInsertRowid);
  for (const uid of [VIEN_TRUONG, TP_A, NGOAI]) {
    assert.equal((await ung.json(uid, 'DELETE', '/phong/' + phong)).s, 403, 'user ' + uid);
  }
  assert.equal((await ung.json(null, 'DELETE', '/phong/' + phong)).s, 401);
  assert.ok(phongCon(phong), 'không ai trái quyền xóa được');
  assert.equal((await ung.json(ADMIN, 'DELETE', '/phong/' + phong)).s, 200, 'admin xóa được');
});

test('ID sai: 400; phòng không có: 404', async () => {
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/phong/abc')).s, 400);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/phong/999999')).s, 404);
});
