/**
 * tests/baoCaoPhongXacNhan.test.js
 * Ai làm gì: người quản lý module (và admin) XÁC NHẬN báo cáo từng phòng, yêu cầu chỉnh sửa, tải/gửi hồ sơ trình.
 * Viện trưởng chỉ đọc và DUYỆT hồ sơ — không xác nhận hộ, không tải/gửi hồ sơ. Một người giữ cả hai vai trò thì làm được cả hai.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung, PDF_MAU } = require('./helpers/baoCaoPhongApp');

const ADMIN = 1;
const QUAN_LY = 2;
const VIEN_TRUONG = 3; // chỉ là Viện trưởng
const TP_A = 4;
const TP_B = 5;
const VT_KIEM_QL = 6; // vừa là Viện trưởng vừa là quản lý module

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
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VT_KIEM_QL);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(VT_KIEM_QL);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_B, ID.phongB);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

/** Đợt mới có hai báo cáo đã nộp (A, B) và trả về id báo cáo. */
async function dotDaNop(tieuDe) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA, ID.phongB] });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao.map((b) => [b.phong_id, b.id]));
  for (const [uid, p, ten] of [[TP_A, ID.phongA, 'A'], [TP_B, ID.phongB, 'B']]) {
    assert.equal((await ung.json(uid, 'PUT', `/bao-cao/${bc[p]}/du-lieu`, { du_lieu: DU_LIEU(ten) })).s, 200);
    assert.equal((await ung.json(uid, 'POST', `/bao-cao/${bc[p]}/nop`, {})).s, 200);
  }
  return { id: r.d.id, a: bc[ID.phongA], b: bc[ID.phongB] };
}

test('/me: chỉ admin và người có vai trò quản lý module mới có quan_ly_module; Viện trưởng thì không (dù vẫn vào được phần quản lý chung)', async () => {
  const vt = (await ung.json(VIEN_TRUONG, 'GET', '/me')).d;
  assert.equal(vt.vien_truong, true);
  assert.equal(vt.quan_ly, true, 'vẫn xem và quản lý chung như trước');
  assert.equal(vt.quan_ly_module, false);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/me')).d.quan_ly_module, true);
  assert.equal((await ung.json(ADMIN, 'GET', '/me')).d.quan_ly_module, true);
  assert.equal((await ung.json(VT_KIEM_QL, 'GET', '/me')).d.quan_ly_module, true, 'kiêm cả hai vai trò');
  assert.equal((await ung.json(TP_A, 'GET', '/me')).d.quan_ly_module, false);
});

test('Viện trưởng KHÔNG xác nhận và KHÔNG yêu cầu chỉnh sửa được báo cáo của phòng (403), báo cáo giữ nguyên', async () => {
  const dot = await dotDaNop('Đợt 1');
  let r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${dot.a}/duyet`, { nhan_xet: 'Xác nhận hộ' });
  assert.equal(r.s, 403);
  assert.match(r.d.message, /Chỉ người quản lý module/);
  r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${dot.a}/yeu-cau-chinh-sua`, { nhan_xet: 'Sửa lại' });
  assert.equal(r.s, 403);
  const ct = await ung.json(VIEN_TRUONG, 'GET', '/bao-cao/' + dot.a);
  assert.equal(ct.s, 200, 'vẫn ĐỌC được báo cáo');
  assert.equal(ct.d.trang_thai, 'da_nop', 'không bị đổi trạng thái');
  assert.equal(ct.d.duyet_duoc, false, 'giao diện không có nút Xác nhận');
  assert.equal(ct.d.yeu_cau_sua_duoc, false, 'giao diện không có nút Yêu cầu chỉnh sửa');
  ID.dot1 = dot;
});

test('quản lý module và admin xác nhận / yêu cầu chỉnh sửa được; người quản lý thấy đủ nút', async () => {
  const dot = ID.dot1;
  const ct = await ung.json(QUAN_LY, 'GET', '/bao-cao/' + dot.a);
  assert.equal(ct.d.duyet_duoc, true);
  assert.equal(ct.d.yeu_cau_sua_duoc, true);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.a}/duyet`, {})).s, 200);
  assert.equal((await ung.json(ADMIN, 'POST', `/bao-cao/${dot.b}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung' })).s, 200);
});

test('người kiêm cả Viện trưởng và quản lý module thì xác nhận được', async () => {
  const dot = await dotDaNop('Đợt 2');
  assert.equal((await ung.json(VT_KIEM_QL, 'POST', `/bao-cao/${dot.a}/duyet`, {})).s, 200);
});

test('Viện trưởng KHÔNG tải/xóa tệp hay gửi hồ sơ (403), nhưng đọc (tải về) và duyệt được', async () => {
  const dot = await dotDaNop('Đợt 3');
  const url = `/dot/${dot.id}/trinh`;
  assert.equal((await ung.taiTep(QUAN_LY, url + '/tep', 'bao-cao.pdf', PDF_MAU)).s, 201);
  const ds = await ung.json(VIEN_TRUONG, 'GET', url);
  assert.equal(ds.s, 200, 'Viện trưởng xem được hồ sơ');
  const tepId = ds.d.tep[0].id;

  assert.equal((await ung.taiTep(VIEN_TRUONG, url + '/tep', 'them.pdf', PDF_MAU)).s, 403, 'không tải tệp lên');
  assert.equal((await ung.json(VIEN_TRUONG, 'DELETE', `${url}/tep/${tepId}`)).s, 403, 'không xóa tệp');
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', url + '/gui', {})).s, 403, 'không gửi hồ sơ');

  assert.equal((await ung.json(QUAN_LY, 'POST', url + '/gui', {})).s, 200);
  const taiVe = await ung.goi(VIEN_TRUONG, 'GET', `${url}/tep/${tepId}/tai`);
  assert.equal(taiVe.status, 200, 'Viện trưởng tải tệp về đọc được');
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', url + '/duyet', { nhan_xet: 'Đồng ý.' })).s, 200, 'và duyệt được');
});

test('người kiêm Viện trưởng và quản lý module thì tải/gửi hồ sơ được', async () => {
  const dot = await dotDaNop('Đợt 4');
  const url = `/dot/${dot.id}/trinh`;
  assert.equal((await ung.taiTep(VT_KIEM_QL, url + '/tep', 'bao-cao.pdf', PDF_MAU)).s, 201);
  assert.equal((await ung.json(VT_KIEM_QL, 'POST', url + '/gui', {})).s, 200);
});
