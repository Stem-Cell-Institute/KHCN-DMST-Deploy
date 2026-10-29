/**
 * tests/baoCaoPhongYKien.test.js
 * Ý kiến của Viện trưởng về báo cáo của từng phòng: chỉ Viện trưởng gửi được; lưu trong báo cáo; gửi email cho trưởng phòng
 * của ĐÚNG phòng đó. Trọng tâm: không gửi nhầm phòng, không ai khác gửi được, không lộ ý kiến cho phòng khác.
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
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Báo cáo tháng 9/2026', loai: 'thang', ky: '9/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA, ID.phongB] });
  ID.dot = r.d.id;
  await ung.json(QUAN_LY, 'POST', `/dot/${ID.dot}/mo`, {});
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + ID.dot)).d.bao_cao.map((b) => [b.phong_id, b.id]));
  ID.bcA = bc[ID.phongA];
  ID.bcB = bc[ID.phongB];
  await ung.json(TP_A, 'PUT', `/bao-cao/${ID.bcA}/du-lieu`, { du_lieu: DU_LIEU('A') });
  await ung.json(TP_A, 'POST', `/bao-cao/${ID.bcA}/nop`, {});
  await new Promise((x) => setTimeout(x, 150));
  ung.thu.length = 0;
});

test.after(async () => {
  if (ung) await ung.dung();
});

const doi = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const thuYKien = () => ung.thu.filter((t) => /^\[Ý kiến của Viện trưởng\]/.test(t.subject));

test('Viện trưởng gửi ý kiến: lưu trong báo cáo, email nguyên văn tới trưởng phòng ĐÚNG phòng và người quản lý module, kèm liên kết', async () => {
  const r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'Đề nghị bổ sung số liệu KPI quý 3.\nGửi lại trước thứ Sáu.' });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal(r.d.da_bao, 1);
  assert.equal(r.d.da_bao_quan_ly, 1);
  await ung.doiThu(2);
  await doi();
  const thu = thuYKien().filter((x) => x.to === 'tpa@thu.local');
  assert.deepEqual(thuYKien().map((x) => x.to).sort(), ['quanly@thu.local', 'tpa@thu.local'], 'trưởng phòng A và người quản lý module, không ai khác');
  assert.match(thu[0].subject, /^\[Ý kiến của Viện trưởng\] Phòng A — Báo cáo tháng 9\/2026$/);
  assert.match(thu[0].text, /Viện trưởng Phạm Viện Trưởng có ý kiến về báo cáo của Phòng A/);
  assert.match(thu[0].text, /Đề nghị bổ sung số liệu KPI quý 3\./);
  assert.ok(thu[0].text.includes(`https://eoffice.test/bao-cao-phong.html#/bao-cao/${ID.bcA}`));
  assert.ok(!ung.thu.some((x) => x.to === 'tpb@thu.local'), 'không gửi cho trưởng phòng của phòng khác');
  assert.ok(!ung.thu.some((x) => x.to === 'vientruong@thu.local'), 'không gửi lại cho chính Viện trưởng');
  assert.match(thuYKien().find((x) => x.to === 'quanly@thu.local').text, /Đề nghị bổ sung số liệu KPI quý 3\./, 'người quản lý nhận cùng nội dung');
});

test('ý kiến hiện trong báo cáo cho chủ phòng, quản lý, Viện trưởng; phòng khác không đọc được báo cáo nên không thấy', async () => {
  for (const uid of [TP_A, QUAN_LY, VIEN_TRUONG, ADMIN]) {
    const ct = await ung.json(uid, 'GET', '/bao-cao/' + ID.bcA);
    assert.equal(ct.s, 200, 'user ' + uid);
    assert.equal(ct.d.y_kien.length, 1);
    assert.equal(ct.d.y_kien[0].nguoi, 'Phạm Viện Trưởng');
    assert.match(ct.d.y_kien[0].noi_dung, /bổ sung số liệu KPI/);
    assert.ok(ct.d.y_kien[0].tao_luc);
  }
  assert.equal((await ung.json(TP_B, 'GET', '/bao-cao/' + ID.bcA)).s, 404, 'phòng B không xem được báo cáo phòng A');
  assert.equal((await ung.json(NGOAI, 'GET', '/bao-cao/' + ID.bcA)).s, 404);
});

test('chỉ Viện trưởng mới có nút và quyền gửi ý kiến; trưởng phòng, quản lý, admin, người ngoài đều 403', async () => {
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/bao-cao/' + ID.bcA)).d.y_kien_duoc, true);
  for (const uid of [TP_A, QUAN_LY, ADMIN, NGOAI]) {
    const ct = await ung.json(uid, 'GET', '/bao-cao/' + ID.bcA);
    if (ct.s === 200) assert.equal(ct.d.y_kien_duoc, false, 'user ' + uid + ' không có ô gửi ý kiến');
    const r = await ung.json(uid, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'Tôi cũng góp ý' });
    assert.equal(r.s, 403, 'user ' + uid);
  }
  assert.equal((await ung.json(null, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'x' })).s, 401);
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_y_kien WHERE bao_cao_id = ?').get(ID.bcA).n, 1, 'không có ý kiến lạ lọt vào');
});

test('kiểm dữ liệu: rỗng 400, quá 2000 ký tự 400; phòng chưa nộp 409; báo cáo không có 404', async () => {
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: '   ' })).s, 400);
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, {})).s, 400);
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'a'.repeat(2001) })).s, 400);
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'a'.repeat(2000) })).s, 201, '2000 ký tự là vừa đủ');
  const chuaNop = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcB}/y-kien`, { noi_dung: 'Góp ý' });
  assert.equal(chuaNop.s, 409);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/bao-cao/' + ID.bcB)).d.y_kien_duoc, false, 'chưa nộp thì không có ô góp ý');
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', '/bao-cao/99999/y-kien', { noi_dung: 'x' })).s, 404);
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', '/bao-cao/abc/y-kien', { noi_dung: 'x' })).s, 400);
});

test('nhiều ý kiến: giữ đủ theo thứ tự; phòng có HAI trưởng phòng thì cả hai nhận thư', async () => {
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(NGOAI, ID.phongA);
  try {
    await doi();
    ung.thu.length = 0;
    const r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'Ý kiến thứ ba.' });
    assert.equal(r.d.da_bao, 2);
    assert.equal(r.d.da_bao_quan_ly, 1);
    await ung.doiThu(3);
    assert.deepEqual(thuYKien().map((t) => t.to).sort(), ['ngoai@thu.local', 'quanly@thu.local', 'tpa@thu.local']);
    const ds = (await ung.json(TP_A, 'GET', '/bao-cao/' + ID.bcA)).d.y_kien;
    assert.equal(ds[ds.length - 1].noi_dung, 'Ý kiến thứ ba.');
  } finally {
    ung.db.prepare('DELETE FROM bcp_thanh_vien WHERE user_id = ? AND phong_id = ?').run(NGOAI, ID.phongA);
  }
});

test('nội dung do người gõ được escape trong thư; URL lạ không thành liên kết; SMTP hỏng không làm mất ý kiến', async () => {
  await doi();
  ung.thu.length = 0;
  await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: '<script>alert(1)</script> xem http://doc-hai.example/x' });
  await ung.doiThu(1);
  const html = thuYKien()[0].html;
  assert.ok(!html.includes('<script>') && html.includes('&lt;script&gt;'));
  assert.ok(!/<a [^>]*doc-hai/.test(html), 'URL ngoài hệ thống không thành liên kết');

  ung.cheDoMail = async () => { throw new Error('smtp_down'); };
  try {
    const r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'Ý kiến khi SMTP hỏng' });
    assert.equal(r.s, 201);
    await doi();
  } finally {
    ung.cheDoMail = null;
  }
  const ds = (await ung.json(TP_A, 'GET', '/bao-cao/' + ID.bcA)).d.y_kien;
  assert.equal(ds[ds.length - 1].noi_dung, 'Ý kiến khi SMTP hỏng', 'ý kiến vẫn được lưu dù thư không đi');
});

test('người quản lý module kiêm trưởng phòng của phòng đó chỉ nhận MỘT thư; người kiêm Viện trưởng và quản lý không nhận thư của chính mình', async () => {
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(QUAN_LY, ID.phongA);
  try {
    await doi();
    ung.thu.length = 0;
    const r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'Ý kiến cho phòng có quản lý kiêm trưởng phòng.' });
    assert.equal(r.d.da_bao, 2, 'tpa và quản lý (với tư cách trưởng phòng)');
    assert.equal(r.d.da_bao_quan_ly, 0, 'quản lý đã nhận rồi nên không đếm lần hai');
    await ung.doiThu(2);
    await doi();
    assert.deepEqual(thuYKien().map((t) => t.to).sort(), ['quanly@thu.local', 'tpa@thu.local'], 'mỗi người đúng một thư');
  } finally {
    ung.db.prepare('DELETE FROM bcp_thanh_vien WHERE user_id = ? AND phong_id = ?').run(QUAN_LY, ID.phongA);
  }

  // Người vừa là Viện trưởng vừa là quản lý module (user NGOAI): tự góp ý thì không nhận thư của chính mình.
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(NGOAI);
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(NGOAI);
  try {
    await doi();
    ung.thu.length = 0;
    const r = await ung.json(NGOAI, 'POST', `/bao-cao/${ID.bcA}/y-kien`, { noi_dung: 'Ý kiến của người kiêm hai vai trò.' });
    assert.equal(r.s, 201);
    await ung.doiThu(2);
    await doi();
    assert.ok(!ung.thu.some((t) => t.to === 'ngoai@thu.local'), 'không gửi cho chính người viết');
    assert.deepEqual(thuYKien().map((t) => t.to).sort(), ['quanly@thu.local', 'tpa@thu.local']);
  } finally {
    ung.db.prepare('DELETE FROM bcp_thanh_vien WHERE user_id = ?').run(NGOAI);
  }
});

test('không có sửa/xóa ý kiến qua API (chỉ thêm)', async () => {
  for (const [m, d] of [['PUT', `/bao-cao/${ID.bcA}/y-kien/1`], ['DELETE', `/bao-cao/${ID.bcA}/y-kien/1`]]) {
    assert.ok([404, 405].includes((await ung.json(VIEN_TRUONG, m, d, {})).s), m);
  }
});
