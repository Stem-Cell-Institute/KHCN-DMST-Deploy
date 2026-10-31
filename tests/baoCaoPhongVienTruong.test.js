/**
 * tests/baoCaoPhongVienTruong.test.js
 * GET /viec-cua-toi — dữ liệu cho thẻ việc (trang chủ và đầu trang module): báo cáo của phòng mình cần nộp
 * (trưởng phòng) và hồ sơ đang chờ mình duyệt (CHỈ Viện trưởng). Trọng tâm: không lộ hồ sơ trình cho ai
 * ngoài Viện trưởng, đúng trạng thái, và đủ thông tin để Viện trưởng quyết định ngay trên thẻ.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');

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
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_B, ID.phongB);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

async function taoDotMo(tieuDe, han = '2099-12-31') {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: han, mau_id: ID.mau, phong_ids: [ID.phongA, ID.phongB] });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao.map((b) => [b.phong_id, b.id]));
  return { id: r.d.id, bc };
}
async function nop(uid, id, ten) {
  assert.equal((await ung.json(uid, 'PUT', `/bao-cao/${id}/du-lieu`, { du_lieu: DU_LIEU(ten) })).s, 200);
  assert.equal((await ung.json(uid, 'POST', `/bao-cao/${id}/nop`, {})).s, 200);
}
async function trinh(dotId, loiNhan) {
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dotId}/trinh-vien-truong`, { loi_nhan: loiNhan })).s, 200);
}
const viec = (uid) => ung.json(uid, 'GET', '/viec-cua-toi');

test('chưa đăng nhập thì 401; người không có vai trò gì nhận danh sách rỗng (không lỗi, không lộ gì)', async () => {
  assert.equal((await viec(null)).s, 401);
  const r = await viec(NGOAI);
  assert.equal(r.s, 200);
  assert.deepEqual(r.d, { bao_cao: [], dot_duyet: [] });
});

test('Viện trưởng thấy đợt đã trình: tiêu đề, người trình, lời nhắn, số báo cáo chờ; người khác nhận rỗng', async () => {
  ID.dot1 = await taoDotMo('Đợt chưa nộp');
  const dot = await taoDotMo('Báo cáo tháng 9/2026');
  assert.deepEqual((await viec(VIEN_TRUONG)).d.dot_duyet, [], 'chưa trình thì chưa phải việc của Viện trưởng');
  await nop(TP_A, dot.bc[ID.phongA], 'A');
  await trinh(dot.id, 'Kính trình Viện trưởng.');
  const r = await viec(VIEN_TRUONG);
  assert.equal(r.d.dot_duyet.length, 1);
  const x = r.d.dot_duyet[0];
  assert.equal(x.dot_id, dot.id);
  assert.equal(x.tieu_de, 'Báo cáo tháng 9/2026');
  assert.equal(x.nguoi_trinh, 'Nguyễn Quản Lý');
  assert.equal(x.loi_nhan, 'Kính trình Viện trưởng.');
  assert.equal(x.cho_quyet_dinh, 1);
  assert.deepEqual(r.d.bao_cao, [], 'Viện trưởng không có phòng nên không có báo cáo cần nộp');
  for (const uid of [TP_A, TP_B, QUAN_LY, 1]) assert.deepEqual((await viec(uid)).d.dot_duyet, [], 'user ' + uid);
  const tq = await ung.json(VIEN_TRUONG, 'GET', '/tong-quan');
  assert.equal(tq.d.bao_cao_cho_vien_truong, 1);
  assert.equal((await ung.json(TP_A, 'GET', '/tong-quan')).s, 403, 'trưởng phòng vẫn không xem được tổng quan');
});

test('users.role = vien_truong nhưng CHƯA được gán trong module thì không thấy hồ sơ (như mọi quyền khác)', async () => {
  const r = await viec(7);
  assert.equal(r.s, 200);
  assert.deepEqual(r.d, { bao_cao: [], dot_duyet: [] });
});

test('trưởng phòng thấy báo cáo của phòng mình đang cần nộp; đã nộp thì biến mất; cần chỉnh sửa thì hiện lại', async () => {
  const r1 = await viec(TP_A);
  const x = r1.d.bao_cao.find((b) => b.id === ID.dot1.bc[ID.phongA]);
  assert.ok(x, 'phòng A chưa nộp đợt 1');
  assert.equal(x.phong_ten, 'Phòng A');
  assert.equal(x.tieu_de, 'Đợt chưa nộp');
  assert.equal(x.trang_thai, 'chua_nop');
  assert.equal(x.han_nop, '2099-12-31');
  assert.equal(x.tre_han, false);
  assert.ok(!r1.d.bao_cao.some((b) => b.phong_ten === 'Phòng B'), 'không thấy báo cáo phòng khác');

  await nop(TP_A, ID.dot1.bc[ID.phongA], 'A');
  assert.ok(!(await viec(TP_A)).d.bao_cao.some((b) => b.id === ID.dot1.bc[ID.phongA]), 'đã nộp thì hết việc');

  await ung.json(QUAN_LY, 'POST', `/bao-cao/${ID.dot1.bc[ID.phongA]}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung' });
  const r3 = (await viec(TP_A)).d.bao_cao.find((b) => b.id === ID.dot1.bc[ID.phongA]);
  assert.equal(r3.trang_thai, 'can_chinh_sua');
});

test('đợt đã đóng thì không còn là việc của trưởng phòng', async () => {
  const dot = await taoDotMo('Đợt sẽ đóng');
  assert.ok((await viec(TP_B)).d.bao_cao.some((b) => b.id === dot.bc[ID.phongB]));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/dong`, {})).s, 200);
  assert.ok(!(await viec(TP_B)).d.bao_cao.some((b) => b.id === dot.bc[ID.phongB]));
});

