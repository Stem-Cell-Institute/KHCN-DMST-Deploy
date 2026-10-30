/**
 * tests/baoCaoPhongTuDuyet.test.js
 * "Tự duyệt": người quản lý module cũng là trưởng phòng của một phòng (vd. trưởng phòng TCHC) nên có thể
 * tự nộp rồi tự duyệt báo cáo phòng mình. Chính sách đã chọn: CHO PHÉP, nhưng phải ghi rõ để người xem biết
 * (lịch sử dùng hành động riêng 'tu_duyet', API trả cờ tu_duyet, danh sách đợt cũng có cờ).
 * Trọng tâm: cờ chỉ bật khi đúng là cùng một người, và không dính lại sau khi chỉnh sửa/nộp lại.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');

const QUAN_LY = 2; // đồng thời là trưởng phòng TCHC
const VIEN_TRUONG = 3;
const TP_A = 4;

let ung;
const ID = {};

const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten,
  ky_tu_ngay: '2026-09-04',
  ky_den_ngay: '2026-10-04',
  tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm', muc_do: 100 } }],
});

async function nop(uid, baoCaoId, ten) {
  const r = await ung.json(uid, 'PUT', `/bao-cao/${baoCaoId}/du-lieu`, { du_lieu: DU_LIEU(ten) });
  assert.equal(r.s, 200, 'lưu nháp: ' + JSON.stringify(r.d));
  const n = await ung.json(uid, 'POST', `/bao-cao/${baoCaoId}/nop`, {});
  assert.equal(n.s, 200, 'nộp: ' + JSON.stringify(n.d));
}

const lichSu = (id) => ung.db.prepare('SELECT hanh_dong FROM bcp_lich_su WHERE bao_cao_id = ? ORDER BY id').all(id).map((r) => r.hanh_dong);

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  ID.tchc = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('tchc','Phòng TCHC')").run().lastInsertRowid);
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(QUAN_LY, ID.tchc);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.phongA);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;

  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Báo cáo tháng 10', loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.tchc, ID.phongA] });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  ID.dot = r.d.id;
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${ID.dot}/mo`, {})).s, 200);
  const ct = await ung.json(QUAN_LY, 'GET', '/dot/' + ID.dot);
  ID.bcTchc = ct.d.bao_cao.find((b) => b.phong_id === ID.tchc).id;
  ID.bcA = ct.d.bao_cao.find((b) => b.phong_id === ID.phongA).id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

test('trưởng phòng TCHC (cũng là quản lý) nộp rồi tự duyệt: được, và được ghi rõ là tự duyệt', async () => {
  await nop(QUAN_LY, ID.bcTchc, 'Quản Lý');
  const r = await ung.json(QUAN_LY, 'POST', `/bao-cao/${ID.bcTchc}/duyet`, { nhan_xet: 'ok' });
  assert.equal(r.s, 200);
  assert.equal(r.d.tu_duyet, true);
  assert.deepEqual(lichSu(ID.bcTchc), ['nop', 'tu_duyet']);

  const ct = await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcTchc);
  assert.equal(ct.d.trang_thai, 'da_duyet');
  assert.equal(ct.d.tu_duyet, true);
  assert.equal(ct.d.nguoi_nop, 'Nguyễn Quản Lý');
  assert.equal(ct.d.nguoi_duyet, 'Nguyễn Quản Lý');
  assert.ok(ct.d.lich_su.some((l) => l.hanh_dong === 'tu_duyet'));

  const dot = await ung.json(QUAN_LY, 'GET', '/dot/' + ID.dot);
  assert.equal(dot.d.bao_cao.find((b) => b.id === ID.bcTchc).tu_duyet, 1);
});

test('duyệt báo cáo của người KHÁC thì KHÔNG phải tự duyệt', async () => {
  await nop(TP_A, ID.bcA, 'Trưởng A');
  const r = await ung.json(QUAN_LY, 'POST', `/bao-cao/${ID.bcA}/duyet`, {});
  assert.equal(r.s, 200);
  assert.equal(r.d.tu_duyet, false);
  assert.deepEqual(lichSu(ID.bcA), ['nop', 'duyet']);

  const ct = await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcA);
  assert.equal(ct.d.tu_duyet, false);
  assert.equal(ct.d.nguoi_duyet, 'Nguyễn Quản Lý');
  const dot = await ung.json(QUAN_LY, 'GET', '/dot/' + ID.dot);
  assert.equal(dot.d.bao_cao.find((b) => b.id === ID.bcA).tu_duyet, 0);
});

test('cờ nop_boi_toi chỉ bật với đúng người nộp (để giao diện đổi nhãn nút)', async () => {
  assert.equal((await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcTchc)).d.nop_boi_toi, true);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/bao-cao/' + ID.bcTchc)).d.nop_boi_toi, false);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcA)).d.nop_boi_toi, false);
});

test('yêu cầu chỉnh sửa rồi nộp lại: cờ tự duyệt không dính lại; người khác duyệt thì không phải tự duyệt', async () => {
  const yc = await ung.json(QUAN_LY, 'POST', `/bao-cao/${ID.bcTchc}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung số liệu' });
  assert.equal(yc.s, 200);
  const giua = await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcTchc);
  assert.equal(giua.d.tu_duyet, false, 'đang cần chỉnh sửa thì không còn là báo cáo tự duyệt');

  await nop(QUAN_LY, ID.bcTchc, 'Quản Lý');
  assert.equal((await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcTchc)).d.tu_duyet, false, 'đã nộp lại, chưa duyệt');

  const r = await ung.json(1, 'POST', `/bao-cao/${ID.bcTchc}/duyet`, {}); // admin: người xác nhận KHÁC (Viện trưởng không xác nhận)
  assert.equal(r.s, 200);
  assert.equal(r.d.tu_duyet, false);
  const ct = await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcTchc);
  assert.equal(ct.d.tu_duyet, false);
  assert.equal(ct.d.nguoi_duyet, 'Quản Trị');
  assert.deepEqual(lichSu(ID.bcTchc), ['nop', 'tu_duyet', 'yeu_cau_chinh_sua', 'nop_lai', 'duyet']);
});

test('người nộp đã bị xóa tài khoản (nguoi_nop_id rỗng): không bị coi là tự duyệt', async () => {
  const { db } = ung;
  await ung.json(QUAN_LY, 'POST', `/bao-cao/${ID.bcTchc}/yeu-cau-chinh-sua`, { nhan_xet: 'Lần nữa' });
  await nop(QUAN_LY, ID.bcTchc, 'Quản Lý');
  db.prepare('UPDATE bcp_bao_cao SET nguoi_nop_id = NULL WHERE id = ?').run(ID.bcTchc);
  const r = await ung.json(QUAN_LY, 'POST', `/bao-cao/${ID.bcTchc}/duyet`, {});
  assert.equal(r.d.tu_duyet, false);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/bao-cao/' + ID.bcTchc)).d.tu_duyet, false);
});

test('trưởng phòng thường (không phải quản lý) vẫn KHÔNG duyệt được dù là người nộp', async () => {
  const dot2 = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt 2', loai: 'thang', ky: '11/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] });
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot2.d.id}/mo`, {})).s, 200);
  const ct = await ung.json(QUAN_LY, 'GET', '/dot/' + dot2.d.id);
  const bc = ct.d.bao_cao[0].id;
  await nop(TP_A, bc, 'Trưởng A');
  assert.equal((await ung.json(TP_A, 'POST', `/bao-cao/${bc}/duyet`, {})).s, 403);
  assert.deepEqual(lichSu(bc), ['nop']);
});
