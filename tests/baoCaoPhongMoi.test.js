/**
 * tests/baoCaoPhongMoi.test.js
 * Hai việc: (1) mời trưởng phòng bằng email — kể cả email CHƯA có tài khoản eoffice;
 *           (2) email báo trưởng phòng khi quản lý MỞ đợt báo cáo.
 *
 * Trọng tâm của (1) là kịch bản tấn công. Đăng ký tài khoản của hệ thống KHÔNG xác minh quyền sở hữu
 * email, nên "tự gắn quyền cho ai đăng ký email được mời" sẽ cho kẻ đăng ký trước chiếm quyền trưởng
 * phòng. Thiết kế dùng MÃ gửi tới đúng hộp thư; các test dưới đây chứng minh kẻ đăng ký giả không nhận được.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');

const ADMIN = 1;
const QUAN_LY = 2;
const TP_A = 4;
const TP_B = 5;
const NGOAI = 6;

let ung;
const ID = {};

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run().lastInsertRowid);
  ID.phongB = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('b','Phòng B')").run().lastInsertRowid);
  ID.phongC = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('c','Phòng C')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_B, ID.phongB);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

/** Lấy mã lời mời từ thư đã "gửi" (mã chỉ tồn tại trong thư, không bao giờ trong DB). */
const maTuThu = (thu) => (thu.text.match(/Nhập mã lời mời: ([a-f0-9]{32})/) || [])[1];

// ══ 1. Mời bằng email ═══════════════════════════════════════════════════════

test('mời email ĐÃ có tài khoản: gán luôn làm trưởng phòng và gửi thư báo', async () => {
  ung.thu.length = 0;
  const id = ung.dangKy('co.tai.khoan@sci.edu.vn', 'Có Tài Khoản');
  const r2 = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'Co.Tai.Khoan@SCI.edu.vn', phong_id: ID.phongA });
  assert.equal(r2.s, 201, JSON.stringify(r2.d));
  assert.equal(r2.d.ket_qua, 'da_gan', 'email không phân biệt hoa/thường');
  const me = await ung.json(id, 'GET', '/me');
  assert.equal(me.d.phong[0].id, ID.phongA);
  assert.equal(await ung.doiThu(1), 1);
  assert.equal(ung.thu[0].to, 'co.tai.khoan@sci.edu.vn');
  assert.match(ung.thu[0].subject, /Trưởng phòng — Phòng A: bạn đã được thêm vào module/);
  assert.match(ung.thu[0].text, /đã thêm Trưởng phòng — Phòng A vào module/);
  assert.doesNotMatch(ung.thu[0].text, /giao bạn làm|làm Trưởng phòng/, 'không viết như thể bổ nhiệm bạn làm trưởng phòng');
});

test('mời lại người đã là trưởng phòng của phòng đó thì 409', async () => {
  const r = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'co.tai.khoan@sci.edu.vn', phong_id: ID.phongA });
  assert.equal(r.s, 409);
});

test('mời email CHƯA có tài khoản: tạo lời mời chờ, thư có hướng dẫn đăng ký và mã; mã KHÔNG nằm trong DB', async () => {
  ung.thu.length = 0;
  const r = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'moi.hoan.toan@sci.edu.vn', phong_id: ID.phongB });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal(r.d.ket_qua, 'da_moi');
  await ung.doiThu(1);
  const thu = ung.thu[0];
  assert.equal(thu.to, 'moi.hoan.toan@sci.edu.vn');
  assert.match(thu.subject, /^\[Báo cáo phòng ban\] Mời Trưởng phòng — Phòng B vào module Báo cáo phòng ban$/);
  assert.match(thu.text, /mời Trưởng phòng — Phòng B vào module Báo cáo phòng ban/);
  assert.doesNotMatch(thu.text, /mời bạn làm Trưởng phòng/);
  assert.match(thu.text, /CHƯA có tài khoản eoffice/);
  assert.match(thu.text, /https:\/\/eoffice\.test\/dang-ky\.html/);
  assert.match(thu.text, /bằng CHÍNH địa chỉ email này \(moi\.hoan\.toan@sci\.edu\.vn\)/);
  assert.match(thu.text, /hiệu lực đến/);
  const ma = maTuThu(thu);
  assert.match(ma, /^[a-f0-9]{32}$/);
  ID.maMoi = ma;

  // Chỉ lưu BĂM: lộ DB cũng không lộ mã dùng được.
  const dong = ung.db.prepare('SELECT * FROM bcp_loi_moi WHERE email = ?').get('moi.hoan.toan@sci.edu.vn');
  assert.ok(!JSON.stringify(dong).includes(ma), 'mã gốc không được nằm trong DB');
  assert.match(dong.ma_bam, /^[a-f0-9]{64}$/);
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(email) = ?').get('moi.hoan.toan@sci.edu.vn').n, 0, 'mời không tự tạo tài khoản');
});

test('liên kết trong thư mời là liên kết của CHÍNH hệ thống, bấm được; URL người dùng gõ thì KHÔNG bị biến thành liên kết', async () => {
  const thu = ung.thu[0];
  assert.match(thu.html, /<a href="https:\/\/eoffice\.test\/dang-ky\.html"/);
  assert.match(thu.html, /<a href="https:\/\/eoffice\.test\/bao-cao-phong\.html\?moi=[a-f0-9]{32}"/);

  // Tiêu đề đợt do người quản lý gõ: URL lạ không được thành liên kết trong email của hệ thống.
  const dot = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt lừa đảo đăng nhập tại http://trang-gia-mao.example/dang-nhap để nộp', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] });
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', `/dot/${dot.d.id}/mo`, {});
  await ung.doiThu(1);
  assert.ok(!/<a [^>]*trang-gia-mao/.test(ung.thu[0].html), 'URL lạ không được thành liên kết bấm được');
  assert.ok(ung.thu[0].html.includes('trang-gia-mao.example'), 'nhưng nội dung vẫn hiện (dạng văn bản thường)');
});

test('email sai định dạng, sai đuôi, thiếu phòng, phòng không tồn tại/ngừng dùng bị từ chối', async () => {
  const goi = (b) => ung.json(QUAN_LY, 'POST', '/loi-moi', b);
  assert.equal((await goi({ email: 'khong-phai-email', phong_id: ID.phongA })).s, 400);
  assert.equal((await goi({ email: 'nguoi@gmail.com', phong_id: ID.phongA })).s, 400, 'chỉ @sci.edu.vn');
  assert.equal((await goi({ email: 'a@sci.edu.vn' })).s, 400);
  assert.equal((await goi({ email: 'a@sci.edu.vn', phong_id: 99999 })).s, 404);
  ung.db.prepare('UPDATE bcp_phong SET active = 0 WHERE id = ?').run(ID.phongC);
  assert.equal((await goi({ email: 'a@sci.edu.vn', phong_id: ID.phongC })).s, 409);
  ung.db.prepare('UPDATE bcp_phong SET active = 1 WHERE id = ?').run(ID.phongC);
});

test('mời trùng (cùng email, cùng phòng, đang chờ) bị 409; mời cùng email cho phòng KHÁC thì được', async () => {
  assert.equal((await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'moi.hoan.toan@sci.edu.vn', phong_id: ID.phongB })).s, 409);
  assert.equal((await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'moi.hoan.toan@sci.edu.vn', phong_id: ID.phongC })).s, 201);
});

test('chỉ người quản lý được mời/xem/hủy lời mời; danh sách KHÔNG lộ mã', async () => {
  for (const uid of [TP_A, NGOAI, null]) {
    assert.equal((await ung.json(uid, 'POST', '/loi-moi', { email: 'x@sci.edu.vn', phong_id: ID.phongA })).s, uid ? 403 : 401);
    assert.equal((await ung.json(uid, 'GET', '/loi-moi')).s, uid ? 403 : 401);
  }
  const ds = await ung.json(QUAN_LY, 'GET', '/loi-moi');
  assert.equal(ds.s, 200);
  assert.ok(ds.d.loi_moi.length >= 2);
  const tho = JSON.stringify(ds.d);
  assert.ok(!tho.includes(ID.maMoi) && !tho.includes('ma_bam'), 'danh sách không được trả mã hay mã băm');
});

// ══ 2. Nhận lời mời — và các kịch bản tấn công ═══════════════════════════════

test('người chưa đăng nhập không nhận được lời mời', async () => {
  assert.equal((await ung.json(null, 'POST', '/loi-moi/nhan', { ma: ID.maMoi })).s, 401);
});

test('TẤN CÔNG: kẻ đăng ký trước đúng email được mời nhưng KHÔNG có mã → không nhận được quyền', async () => {
  // Hệ thống không xác minh email khi đăng ký, nên kẻ này đăng ký được và đăng nhập được ngay.
  const ke = ung.dangKy('moi.hoan.toan@sci.edu.vn', 'Kẻ Mạo Danh');
  const me = await ung.json(ke, 'GET', '/me');
  assert.equal(me.d.co_quyen, false, 'đăng ký email được mời KHÔNG tự cấp quyền — đây là lý do phải có mã');
  assert.equal((await ung.json(ke, 'GET', '/cua-toi')).d.bao_cao.length, 0);
  // đoán mã sai
  const sai = await ung.json(ke, 'POST', '/loi-moi/nhan', { ma: 'a'.repeat(32) });
  assert.equal(sai.s, 400);
  assert.match(sai.d.message, /không đúng, đã được dùng hoặc đã hết hạn/);
  assert.equal((await ung.json(ke, 'GET', '/me')).d.co_quyen, false);
  ID.keMaoDanh = ke;
});

test('mã định dạng sai bị từ chối trước khi tra cứu', async () => {
  const ke = ID.keMaoDanh;
  for (const ma of ['', 'abc', 'g'.repeat(32), 'a'.repeat(31), "' OR 1=1 --", 'a'.repeat(200)]) {
    assert.equal((await ung.json(ke, 'POST', '/loi-moi/nhan', { ma })).s, 400, 'mã: ' + ma.slice(0, 20));
  }
  assert.equal((await ung.json(ke, 'POST', '/loi-moi/nhan', {})).s, 400);
});

test('TẤN CÔNG: người KHÁC cầm được mã (bị lộ thư) nhưng đăng nhập bằng email khác → 403, mã vẫn dùng được cho chủ thật', async () => {
  const r = await ung.json(TP_B, 'POST', '/loi-moi/nhan', { ma: ID.maMoi });
  assert.equal(r.s, 403);
  assert.match(r.d.message, /địa chỉ email khác/);
  assert.equal(ung.db.prepare("SELECT trang_thai FROM bcp_loi_moi WHERE email = 'moi.hoan.toan@sci.edu.vn' AND phong_id = ?").get(ID.phongB).trang_thai, 'cho');
});

test('chủ thật: đăng nhập bằng đúng email + nhập mã → trở thành trưởng phòng và thấy báo cáo phòng mình', async () => {
  // Chủ thật dùng tài khoản đã có với đúng email này (ở đây là tài khoản kẻ mạo danh đã đăng ký trước:
  // trong hệ thống thật, ai đăng nhập được bằng email này chính là người giữ mật khẩu của tài khoản đó).
  const dot = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt cho người mới', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongB] });
  await ung.json(QUAN_LY, 'POST', `/dot/${dot.d.id}/mo`, {});
  const r = await ung.json(ID.keMaoDanh, 'POST', '/loi-moi/nhan', { ma: ID.maMoi.toUpperCase() + '  ' });
  assert.equal(r.s, 200, 'mã không phân biệt hoa/thường, bỏ khoảng trắng thừa: ' + JSON.stringify(r.d));
  assert.equal(r.d.phong.ten, 'Phòng B');
  const me = await ung.json(ID.keMaoDanh, 'GET', '/me');
  assert.equal(me.d.co_quyen, true);
  assert.equal(me.d.phong[0].id, ID.phongB);
  const ds = (await ung.json(ID.keMaoDanh, 'GET', '/cua-toi')).d.bao_cao;
  assert.ok(ds.some((b) => b.tieu_de === 'Đợt cho người mới'));
});

test('mã chỉ dùng MỘT lần: dùng lại bị từ chối; lời mời biến khỏi danh sách chờ', async () => {
  assert.equal((await ung.json(ID.keMaoDanh, 'POST', '/loi-moi/nhan', { ma: ID.maMoi })).s, 400);
  assert.equal((await ung.json(TP_A, 'POST', '/loi-moi/nhan', { ma: ID.maMoi })).s, 400, 'kể cả người khác thử lại sau khi đã dùng');
  const ds = (await ung.json(QUAN_LY, 'GET', '/loi-moi')).d.loi_moi;
  assert.ok(!ds.some((l) => l.email === 'moi.hoan.toan@sci.edu.vn' && l.phong_id === ID.phongB));
  // người nhận chỉ có đúng một dòng thành viên
  assert.equal(ung.db.prepare("SELECT COUNT(*) AS n FROM bcp_thanh_vien WHERE user_id = ? AND phong_id = ?").get(ID.keMaoDanh, ID.phongB).n, 1);
});

test('được quyền ĐÚNG phòng được mời: không thấy báo cáo phòng khác', async () => {
  const bcA = ung.db.prepare('SELECT id FROM bcp_bao_cao WHERE phong_id = ? LIMIT 1').get(ID.phongA);
  if (bcA) assert.equal((await ung.json(ID.keMaoDanh, 'GET', '/bao-cao/' + bcA.id)).s, 404);
  assert.equal((await ung.json(ID.keMaoDanh, 'GET', '/dot')).s, 403, 'trưởng phòng không vào được phần quản lý');
});

test('lời mời HẾT HẠN không nhận được; "Gửi lại" cấp mã mới và vô hiệu mã cũ', async () => {
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'het.han@sci.edu.vn', phong_id: ID.phongA });
  await ung.doiThu(1);
  const maCu = maTuThu(ung.thu[0]);
  const id = ung.dangKy('het.han@sci.edu.vn', 'Hết Hạn');
  ung.db.prepare("UPDATE bcp_loi_moi SET het_han = ? WHERE email = 'het.han@sci.edu.vn'").run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await ung.json(id, 'POST', '/loi-moi/nhan', { ma: maCu })).s, 400, 'hết hạn');
  const ds = (await ung.json(QUAN_LY, 'GET', '/loi-moi')).d.loi_moi.find((l) => l.email === 'het.han@sci.edu.vn');
  assert.equal(ds.het_han_roi, true, 'giao diện biết lời mời đã hết hạn');

  ung.thu.length = 0;
  const gl = await ung.json(QUAN_LY, 'POST', `/loi-moi/${ds.id}/gui-lai`, {});
  assert.equal(gl.s, 200);
  await ung.doiThu(1);
  const maMoi = maTuThu(ung.thu[0]);
  assert.notEqual(maMoi, maCu);
  assert.equal((await ung.json(id, 'POST', '/loi-moi/nhan', { ma: maCu })).s, 400, 'mã CŨ mất hiệu lực sau khi gửi lại');
  assert.equal((await ung.json(id, 'POST', '/loi-moi/nhan', { ma: maMoi })).s, 200, 'mã mới dùng được');
});

test('hủy lời mời: mã trong thư không còn dùng được', async () => {
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'se.bi.huy@sci.edu.vn', phong_id: ID.phongA });
  await ung.doiThu(1);
  const ma = maTuThu(ung.thu[0]);
  const id = ung.dangKy('se.bi.huy@sci.edu.vn', 'Sẽ Bị Hủy');
  const l = (await ung.json(QUAN_LY, 'GET', '/loi-moi')).d.loi_moi.find((x) => x.email === 'se.bi.huy@sci.edu.vn');
  assert.equal((await ung.json(TP_A, 'DELETE', '/loi-moi/' + l.id)).s, 403);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/loi-moi/' + l.id)).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/loi-moi/' + l.id)).s, 404, 'hủy lần hai');
  assert.equal((await ung.json(id, 'POST', '/loi-moi/nhan', { ma })).s, 400);
  // hủy rồi thì mời lại được
  assert.equal((await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'se.bi.huy@sci.edu.vn', phong_id: ID.phongA })).s, 201);
});

test('phòng bị ngừng dùng sau khi mời: nhận mã bị từ chối rõ ràng', async () => {
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'phong.dong@sci.edu.vn', phong_id: ID.phongC });
  await ung.doiThu(1);
  const ma = maTuThu(ung.thu[0]);
  const id = ung.dangKy('phong.dong@sci.edu.vn', 'Phòng Đóng');
  ung.db.prepare('UPDATE bcp_phong SET active = 0 WHERE id = ?').run(ID.phongC);
  const r = await ung.json(id, 'POST', '/loi-moi/nhan', { ma });
  assert.equal(r.s, 409);
  ung.db.prepare('UPDATE bcp_phong SET active = 1 WHERE id = ?').run(ID.phongC);
});

test('người quản lý (không phải admin) mời được trưởng phòng; quản lý/Viện trưởng thì vẫn CHỈ admin gán, và chỉ cho người đã có tài khoản', async () => {
  assert.equal((await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'qly.moi@sci.edu.vn', phong_id: ID.phongA })).s, 201);
  // endpoint mời không nhận tham số vai trò: không có cách nào mời một email chưa xác minh làm quản lý
  const r = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'cao.quyen@sci.edu.vn', phong_id: ID.phongA, vai_tro: 'quan_ly' });
  assert.equal(r.s, 201);
  const dong = ung.db.prepare("SELECT * FROM bcp_loi_moi WHERE email = 'cao.quyen@sci.edu.vn'").get();
  const id = ung.dangKy('cao.quyen@sci.edu.vn', 'Cao Quyền');
  const ma = (() => { ung.thu.length = 0; return null; })();
  assert.ok(dong);
  // Dù gửi kèm vai_tro quan_ly, sau khi nhận chỉ là trưởng phòng
  const gl = await ung.json(QUAN_LY, 'POST', `/loi-moi/${dong.id}/gui-lai`, {});
  assert.equal(gl.s, 200);
  await ung.doiThu(1);
  const maThat = maTuThu(ung.thu[0]);
  assert.equal(ma, null);
  assert.equal((await ung.json(id, 'POST', '/loi-moi/nhan', { ma: maThat })).s, 200);
  const me = await ung.json(id, 'GET', '/me');
  assert.equal(me.d.quan_ly, false, 'không thể leo thang quyền qua lời mời');
  assert.equal(me.d.phong.length, 1);
});

// ══ 3. Email khi MỞ đợt ═════════════════════════════════════════════════════

async function dotMoi(tieuDe, phongIds, thamSo = {}) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: phongIds, ...thamSo });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  return r.d.id;
}

test('mở đợt: email tới trưởng phòng CÁC PHÒNG ĐƯỢC GIAO, kèm hạn nộp và liên kết vào đúng báo cáo của họ (không chép hướng dẫn)', async () => {
  const dot = await dotMoi('Báo cáo tháng 10/2026', [ID.phongA], { mo_mo_ta: 'x', mo_ta: 'Nộp trước ngày 5, dùng mẫu mới.' });
  const bcA = (await ung.json(QUAN_LY, 'GET', '/dot/' + dot)).d.bao_cao[0].id;
  ung.thu.length = 0;
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo`, {})).s, 200);
  await ung.doiThu(1);
  await new Promise((r) => setTimeout(r, 150)); // chờ xem có thư nào gửi nhầm thêm không
  const toi = ung.thu.map((t) => t.to).sort();
  assert.ok(toi.includes('tpa@thu.local'), 'trưởng phòng A (được giao) phải nhận thư');
  assert.ok(!toi.includes('tpb@thu.local'), 'trưởng phòng B (KHÔNG được giao đợt này) không được nhận');
  assert.ok(!toi.includes('quanly@thu.local'), 'người quản lý không phải trưởng phòng nên không nhận');
  const thu = ung.thu.find((t) => t.to === 'tpa@thu.local');
  assert.match(thu.subject, /^\[Cần nộp báo cáo\] Báo cáo tháng 10\/2026 — hạn 31\/12\/2099/);
  assert.match(thu.text, /Phòng A cần nộp báo cáo/);
  assert.match(thu.text, /Hạn nộp: 31\/12\/2099 \(còn \d+ ngày\)/);
  assert.doesNotMatch(thu.text, /Hướng dẫn của người quản lý|Nộp trước ngày 5/, 'hướng dẫn xem trong báo cáo, không chép vào email');
  assert.match(thu.text, new RegExp(`https://eoffice\\.test/bao-cao-phong\\.html#/bao-cao/${bcA}\\b`), 'liên kết đi thẳng tới báo cáo của phòng họ');
  assert.match(thu.html, new RegExp(`<a href="https://eoffice\\.test/bao-cao-phong\\.html#/bao-cao/${bcA}"`));
});

test('người phụ trách NHIỀU phòng nhận MỘT thư liệt kê liên kết từng phòng', async () => {
  const dot = await dotMoi('Đợt hai phòng', [ID.phongA, ID.phongB]);
  const dc = (await ung.json(QUAN_LY, 'GET', '/dot/' + dot)).d.bao_cao;
  // Cho trưởng phòng A phụ trách thêm phòng B
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.phongB);
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo`, {});
  await ung.doiThu(2);
  await new Promise((r) => setTimeout(r, 100));
  const choA = ung.thu.filter((t) => t.to === 'tpa@thu.local');
  assert.equal(choA.length, 1, 'đúng một thư cho người phụ trách hai phòng');
  assert.match(choA[0].text, /Các phòng bạn phụ trách/);
  for (const b of dc) assert.ok(choA[0].text.includes(`#/bao-cao/${b.id}`), 'thiếu liên kết báo cáo ' + b.phong_ten);
  ung.db.prepare("DELETE FROM bcp_thanh_vien WHERE user_id = ? AND phong_id = ?").run(TP_A, ID.phongB);
});

test('đợt còn NHÁP thì không có thư; MỞ LẠI đợt đã đóng không gửi lại thư', async () => {
  ung.thu.length = 0;
  const dot = await dotMoi('Đợt nháp', [ID.phongA]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(ung.thu.length, 0, 'tạo đợt Nháp không được gửi thư');
  await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo`, {});
  await ung.doiThu(1);
  await ung.json(QUAN_LY, 'POST', `/dot/${dot}/dong`, {});
  ung.thu.length = 0;
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo-lai`, {})).s, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(ung.thu.length, 0, 'mở lại không gửi thư mới');
});

test('thêm phòng vào đợt ĐÃ mở: chỉ trưởng phòng của phòng MỚI THÊM nhận thư', async () => {
  const dot = await dotMoi('Đợt thêm phòng', [ID.phongA]);
  await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo`, {});
  await ung.doiThu(1);
  ung.thu.length = 0;
  const r = await ung.json(QUAN_LY, 'PUT', '/dot/' + dot, { tieu_de: 'Đợt thêm phòng', han_nop: '2099-12-31', loai: 'thang', phong_ids: [ID.phongA, ID.phongB] });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  await ung.doiThu(2);
  await new Promise((r2) => setTimeout(r2, 150));
  // Phòng B có HAI trưởng phòng (tpb và người vừa nhận lời mời ở trên): cả hai cùng nhận. Phòng A đã biết rồi nên không.
  assert.deepEqual(ung.thu.map((t) => t.to).sort(), ['moi.hoan.toan@sci.edu.vn', 'tpb@thu.local'], 'chỉ các trưởng phòng của phòng B (mới thêm)');
});

test('email KHÔNG làm hỏng việc mở đợt: SMTP lỗi thì đợt vẫn mở', async () => {
  ung.cheDoMail = async () => { throw new Error('SMTP: connection refused'); };
  const dot = await dotMoi('Đợt SMTP hỏng', [ID.phongA]);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo`, {})).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/dot/' + dot)).d.dot.trang_thai, 'dang_mo');
  // và mời bằng email cũng vẫn tạo được lời mời dù thư không đi
  assert.equal((await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'smtp.hong@sci.edu.vn', phong_id: ID.phongA })).s, 201);
  ung.cheDoMail = null;
});

test('dữ liệu người dùng gõ (tiêu đề) được escape trong thư mở đợt; hướng dẫn không có trong thư', async () => {
  const dot = await dotMoi('<img src=x onerror=alert(1)> Đợt', [ID.phongA], { mo_ta: '<script>alert(2)</script>' });
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo`, {});
  await ung.doiThu(1);
  const html = ung.thu[0].html;
  assert.ok(!html.includes('<img src=x') && !html.includes('<script>'), 'không được lọt thẻ HTML thô');
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('alert(2)'), 'hướng dẫn không được đưa vào email');
});
