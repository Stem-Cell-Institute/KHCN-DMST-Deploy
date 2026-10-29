/**
 * tests/baoCaoPhongTrinh.test.js
 * Test cho ba phần của module Báo cáo phòng ban được thêm sau bản đầu:
 *   1. Vai trò Viện trưởng + dải "tổng quan"
 *   2. Email báo nộp / báo trình / báo duyệt
 *   3. Hồ sơ trình Viện trưởng (tải tệp, gửi, gửi lại để nhắc, chỉ Viện trưởng duyệt)
 *   4. Kết xuất Word/PDF qua API
 *
 * Chạy trên router thật trong tiến trình (tests/helpers/baoCaoPhongApp.js) nên soi được email đã gửi và
 * vị trí tệp trên đĩa. Trọng tâm là những chỗ sai thì hậu quả nặng: tệp tải lên (đuôi giả, đường dẫn),
 * ai được tải hồ sơ, ai được duyệt, và email gửi nhầm người.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { dungUngDung, PDF_MAU } = require('./helpers/baoCaoPhongApp');

const ADMIN = 1;
const QUAN_LY = 2;
const VIEN_TRUONG = 3;
const TP_A = 4;
const TP_B = 5;
const NGOAI = 6;
const VT_CHUNG = 7; // chỉ có users.role = 'vien_truong', KHÔNG được gán trong module

let ung;
const ID = {};

/** Dữ liệu hợp lệ cho biểu mẫu mặc định (các ô bắt buộc: người phụ trách, kỳ báo cáo, tự đánh giá). */
const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten,
  ky_tu_ngay: '2026-09-04',
  ky_den_ngay: '2026-10-04',
  tu_danh_gia: 'B',
  thuan_loi: 'Thuận lợi.',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm', muc_do: 100 } }, { o: { hang_muc: 'Đoàn vào', muc_do: 50 } }],
});

async function nop(uid, baoCaoId, ten) {
  const r = await ung.json(uid, 'PUT', `/bao-cao/${baoCaoId}/du-lieu`, { du_lieu: DU_LIEU(ten) });
  assert.equal(r.s, 200, 'lưu nháp: ' + JSON.stringify(r.d));
  return ung.json(uid, 'POST', `/bao-cao/${baoCaoId}/nop`, {});
}

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run().lastInsertRowid);
  ID.phongB = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('b','Phòng B')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_B, ID.phongB);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

async function taoDot(tieuDe, phongIds) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: phongIds });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const ct = await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id);
  return { id: r.d.id, bc: Object.fromEntries(ct.d.bao_cao.map((b) => [b.phong_id, b.id])) };
}

// ── 1. Biểu mẫu mặc định ─────────────────────────────────────────────────────

test('biểu mẫu mặc định (mẫu của Viện) được nạp sẵn, có bảng và ô tổng hợp', async () => {
  const r = await ung.json(QUAN_LY, 'GET', '/mau/' + ID.mau);
  assert.equal(r.s, 200);
  assert.match(r.d.ten, /mẫu Viện/);
  const kieu = r.d.truong.map((o) => o.kieu);
  assert.ok(kieu.includes('bang') && kieu.includes('tong_hop') && kieu.includes('section'));
  const bangThuongXuyen = r.d.truong.find((o) => o.key === 'cv_thuong_xuyen');
  assert.equal(bangThuongXuyen.cho_phep_nhom, true, 'bảng công việc thường xuyên cho chia nhóm A/B');
  assert.ok(bangThuongXuyen.cot.some((c) => c.phan_tram));
});

// ── 2. Vai trò ───────────────────────────────────────────────────────────────

test('có users.role = vien_truong nhưng chưa được gán trong module thì KHÔNG có quyền', async () => {
  const me = await ung.json(VT_CHUNG, 'GET', '/me');
  assert.equal(me.d.co_quyen, false);
  assert.equal(me.d.quan_ly, false);
  assert.equal((await ung.json(VT_CHUNG, 'GET', '/dot')).s, 403);
});

test('người quản lý không tự gán được Viện trưởng; chỉ admin mới gán được', async () => {
  let r = await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: VIEN_TRUONG, vai_tro: 'vien_truong' });
  assert.equal(r.s, 403);
  r = await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: VT_CHUNG, vai_tro: 'quan_ly' });
  assert.equal(r.s, 403);
  // Trưởng phòng thì người quản lý gán được (việc hằng ngày)
  r = await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: NGOAI, vai_tro: 'truong_phong', phong_id: ID.phongA });
  assert.equal(r.s, 201);
  await ung.json(ADMIN, 'DELETE', '/thanh-vien/' + r.d.id);
});

// ── 3. Email báo nộp ─────────────────────────────────────────────────────────

test('phòng nộp báo cáo: email chỉ tới NGƯỜI QUẢN LÝ, kèm tiến độ đã nộp/cần nộp và liên kết', async () => {
  const dot = await taoDot('Đợt email 1', [ID.phongA, ID.phongB]);
  ID.dotMail = dot;
  ung.thu.length = 0;

  const r = await nop(TP_A, dot.bc[ID.phongA], 'Trần A');
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(await ung.doiThu(1), 1);
  const thu = ung.thu[0];
  assert.equal(thu.to, 'quanly@thu.local', 'chỉ người quản lý nhận; không phải trưởng phòng hay admin hệ thống');
  assert.match(thu.subject, /Phòng A/);
  assert.match(thu.subject, /1\/2 phòng/, 'tiêu đề có tiến độ để đọc lướt cũng biết');
  assert.match(thu.text, /Phòng chưa nộp: Phòng B/);
  assert.match(thu.text, /Hạn nộp của đợt: 31\/12\/2099/);
  assert.match(thu.text, /https:\/\/eoffice\.test\/bao-cao-phong\.html#\/bao-cao\/\d+/);
});

test('phòng cuối cùng nộp xong thì tiêu đề báo ĐÃ ĐỦ báo cáo', async () => {
  const dot = ID.dotMail;
  ung.thu.length = 0;
  assert.equal((await nop(TP_B, dot.bc[ID.phongB], 'Lê B')).s, 200);
  await ung.doiThu(1);
  assert.match(ung.thu[0].subject, /^\[Đã đủ báo cáo\]/);
  assert.match(ung.thu[0].subject, /2\/2 phòng/);
  assert.match(ung.thu[0].text, /tất cả các phòng đã nộp/);
});

test('nộp lại sau khi bị yêu cầu chỉnh sửa: email ghi rõ là nộp lại', async () => {
  const dot = await taoDot('Đợt nộp lại', [ID.phongA]);
  assert.equal((await nop(TP_A, dot.bc[ID.phongA], 'Trần A')).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.bc[ID.phongA]}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung.' })).s, 200);
  ung.thu.length = 0;
  assert.equal((await ung.json(TP_A, 'POST', `/bao-cao/${dot.bc[ID.phongA]}/nop`, {})).s, 200);
  await ung.doiThu(1);
  assert.match(ung.thu[0].subject, /nộp lại/);
});

test('email KHÔNG BAO GIỜ làm hỏng việc nộp: SMTP lỗi thì báo cáo vẫn nộp thành công', async () => {
  ung.cheDoMail = async () => { throw new Error('SMTP: connection refused'); };
  const dot = await taoDot('Đợt SMTP hỏng', [ID.phongA]);
  const r = await nop(TP_A, dot.bc[ID.phongA], 'Trần A');
  assert.equal(r.s, 200, 'nộp phải thành công dù không gửi được thư');
  const bc = await ung.json(TP_A, 'GET', '/bao-cao/' + dot.bc[ID.phongA]);
  assert.equal(bc.d.trang_thai, 'da_nop');
  ung.cheDoMail = null;
});

test('dữ liệu người dùng gõ được escape trong email (không chèn được HTML)', async () => {
  const dot = await taoDot('<img src=x onerror=alert(1)> Đợt độc', [ID.phongA]);
  ung.thu.length = 0;
  assert.equal((await nop(TP_A, dot.bc[ID.phongA], 'Trần A')).s, 200);
  await ung.doiThu(1);
  assert.ok(!ung.thu[0].html.includes('<img src=x'), 'thẻ HTML thô không được lọt vào thư');
  assert.ok(ung.thu[0].html.includes('&lt;img'), 'phải được escape');
});

// ── 4. Tổng quan ─────────────────────────────────────────────────────────────

test('tổng quan: người quản lý thấy số báo cáo chờ duyệt, phòng chưa nộp theo từng đợt', async () => {
  const dot = await taoDot('Đợt tổng quan', [ID.phongA, ID.phongB]);
  assert.equal((await nop(TP_A, dot.bc[ID.phongA], 'Trần A')).s, 200);
  const r = await ung.json(QUAN_LY, 'GET', '/tong-quan');
  assert.equal(r.s, 200);
  const d = r.d.chi_tiet.find((x) => x.dot_id === dot.id);
  assert.equal(d.tong, 2);
  assert.equal(d.da_nop, 1);
  assert.equal(d.cho_duyet, 1);
  assert.equal(d.chua_nop, 1);
  assert.ok(r.d.cho_duyet >= 1);
  assert.equal(r.d.la_vien_truong, false);
});

test('trưởng phòng và người ngoài không xem được tổng quan', async () => {
  assert.equal((await ung.json(TP_A, 'GET', '/tong-quan')).s, 403);
  assert.equal((await ung.json(NGOAI, 'GET', '/tong-quan')).s, 403);
  assert.equal((await ung.json(null, 'GET', '/tong-quan')).s, 401);
});

// ── 5. Hồ sơ trình Viện trưởng ───────────────────────────────────────────────

test('trình: trưởng phòng và người ngoài không chạm được vào hồ sơ trình', async () => {
  const dot = ID.dotMail;
  for (const uid of [TP_A, TP_B, NGOAI, VT_CHUNG]) {
    assert.equal((await ung.json(uid, 'GET', `/dot/${dot.id}/trinh`)).s, 403, 'user ' + uid);
    assert.equal((await ung.json(uid, 'POST', `/dot/${dot.id}/trinh/gui`, {})).s, 403);
    assert.equal((await ung.json(uid, 'POST', `/dot/${dot.id}/trinh/duyet`, {})).s, 403);
  }
  assert.equal((await ung.json(null, 'GET', `/dot/${dot.id}/trinh`)).s, 401);
});

test('trình: đợt còn Nháp chưa có gì để trình (409)', async () => {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Nháp', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] });
  assert.equal((await ung.json(QUAN_LY, 'GET', `/dot/${r.d.id}/trinh`)).s, 409);
});

test('trình: ban đầu chưa gửi được, nói rõ lý do (chưa có tệp)', async () => {
  const r = await ung.json(QUAN_LY, 'GET', `/dot/${ID.dotMail.id}/trinh`);
  assert.equal(r.s, 200);
  assert.equal(r.d.trinh.trang_thai, 'chua_gui');
  assert.equal(r.d.co_the.gui, false);
  assert.match(r.d.ly_do_khong_gui, /tải lên/);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${ID.dotMail.id}/trinh/gui`, {})).s, 409);
});

test('tải tệp: từ chối đuôi lạ, từ chối đuôi .pdf nhưng ruột là thứ khác, và không để lại tệp rác', async () => {
  const url = `/dot/${ID.dotMail.id}/trinh/tep`;
  let r = await ung.taiTep(QUAN_LY, url, 'virus.exe', Buffer.from('MZ....'));
  assert.equal(r.s, 400);
  assert.match(r.d.message, /PDF hoặc Word/);

  r = await ung.taiTep(QUAN_LY, url, 'gia-mao.pdf', Buffer.from('đây là văn bản chứ không phải PDF'));
  assert.equal(r.s, 400);
  assert.match(r.d.message, /không đúng định dạng/);

  r = await ung.taiTep(QUAN_LY, url, 'gia-mao.docx', PDF_MAU); // ruột là PDF, đuôi docx
  assert.equal(r.s, 400);

  const dir = path.join(ung.uploadsRoot, 'bao-cao-phong', String(ID.dotMail.id));
  const conLai = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  assert.deepEqual(conLai, [], 'tệp bị từ chối phải bị xóa khỏi đĩa');

  r = await ung.taiTep(QUAN_LY, url, 'bao-cao.pdf', PDF_MAU, 'sai_ten_truong');
  assert.equal(r.s, 400, 'sai tên trường multipart');
});

test('tải tệp: tệp quá lớn bị từ chối (413)', async () => {
  const lon = Buffer.concat([PDF_MAU, Buffer.alloc(26 * 1024 * 1024, 1)]);
  const r = await ung.taiTep(QUAN_LY, `/dot/${ID.dotMail.id}/trinh/tep`, 'qua-lon.pdf', lon);
  assert.equal(r.s, 413);
});

test('tải tệp: tên tiếng Việt được giữ nguyên; trên đĩa lưu tên NGẪU NHIÊN, không dùng tên người dùng đặt', async () => {
  const r = await ung.taiTep(QUAN_LY, `/dot/${ID.dotMail.id}/trinh/tep`, 'Báo cáo tháng 10 – đã ký.pdf', PDF_MAU);
  assert.equal(r.s, 201, JSON.stringify(r.d));
  ID.tep1 = r.d.id;

  const ds = await ung.json(QUAN_LY, 'GET', `/dot/${ID.dotMail.id}/trinh`);
  assert.equal(ds.d.tep.length, 1);
  assert.equal(ds.d.tep[0].ten_goc, 'Báo cáo tháng 10 – đã ký.pdf');

  const dir = path.join(ung.uploadsRoot, 'bao-cao-phong', String(ID.dotMail.id));
  const tepTrenDia = fs.readdirSync(dir);
  assert.equal(tepTrenDia.length, 1);
  assert.match(tepTrenDia[0], /^[a-f0-9]{32}\.pdf$/, 'tên trên đĩa phải là 32 ký tự hex ngẫu nhiên');
  assert.ok(!tepTrenDia[0].includes('Báo'), 'tên người dùng không được lọt vào đường dẫn');
});

test('gửi khi CHƯA chỉ định Viện trưởng: bị chặn và nói rõ lý do', async () => {
  const r = await ung.json(QUAN_LY, 'POST', `/dot/${ID.dotMail.id}/trinh/gui`, {});
  assert.equal(r.s, 409);
  assert.match(r.d.message, /Chưa chỉ định Viện trưởng/);
  const st = await ung.json(QUAN_LY, 'GET', `/dot/${ID.dotMail.id}/trinh`);
  assert.match(st.d.ly_do_khong_gui, /Viện trưởng/);
});

test('admin gán Viện trưởng; Viện trưởng có đủ quyền quản lý và thấy mình là Viện trưởng', async () => {
  const r = await ung.json(ADMIN, 'POST', '/thanh-vien', { user_id: VIEN_TRUONG, vai_tro: 'vien_truong' });
  assert.equal(r.s, 201);
  ID.tvVienTruong = r.d.id;
  const me = await ung.json(VIEN_TRUONG, 'GET', '/me');
  assert.equal(me.d.vien_truong, true);
  assert.equal(me.d.quan_ly, true);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/dot')).s, 200);
  // gán trùng bị chặn
  assert.equal((await ung.json(ADMIN, 'POST', '/thanh-vien', { user_id: VIEN_TRUONG, vai_tro: 'vien_truong' })).s, 409);
});

test('gửi hồ sơ: email chỉ tới VIỆN TRƯỞNG, ngắn gọn, KHÔNG nêu tiến độ duyệt các phòng', async () => {
  const dot = ID.dotMail;
  ung.thu.length = 0;
  const r = await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/trinh/gui`, { loi_nhan: 'Kính trình Viện trưởng xem và duyệt.' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.gui_lai, false);
  await ung.doiThu(1);
  assert.equal(ung.thu.length, 1);
  assert.equal(ung.thu[0].to, 'vientruong@thu.local');
  assert.match(ung.thu[0].subject, /^\[Cần duyệt\]/);
  assert.match(ung.thu[0].text, /Kính trình Viện trưởng/);
  assert.match(ung.thu[0].text, /Báo cáo tháng 10 – đã ký\.pdf/);
  assert.match(ung.thu[0].text, /bấm "Duyệt hồ sơ"/);
  assert.doesNotMatch(ung.thu[0].text, /Tiến độ|đã nộp \d+\/\d+|đã duyệt \d/, 'không nhắc tiến độ duyệt các phòng (dễ nhầm với việc Viện trưởng duyệt)');
});

test('chưa duyệt thì KHÔNG khóa: đổi tệp được, rồi GỬI LẠI để nhắc Viện trưởng (thư [Nhắc duyệt])', async () => {
  const dot = ID.dotMail;
  const them = await ung.taiTep(QUAN_LY, `/dot/${dot.id}/trinh/tep`, 'Bo-sung.pdf', PDF_MAU);
  assert.equal(them.s, 201);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', `/dot/${dot.id}/trinh/tep/${them.d.id}`)).s, 200);
  const dir = path.join(ung.uploadsRoot, 'bao-cao-phong', String(dot.id));
  assert.equal(fs.readdirSync(dir).length, 1, 'xóa tệp phải xóa cả trên đĩa');

  ung.thu.length = 0;
  const r = await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/trinh/gui`, { loi_nhan: 'Nhắc Viện trưởng giúp, bản mới đã cập nhật.' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.gui_lai, true);
  await ung.doiThu(1);
  assert.deepEqual(ung.thu.map((t) => t.to), ['vientruong@thu.local']);
  assert.match(ung.thu[0].subject, /^\[Nhắc duyệt\]/);
  assert.match(ung.thu[0].text, /vừa được gửi lại/);

  const st = await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}/trinh`);
  assert.equal(st.d.trinh.trang_thai, 'da_gui', 'vẫn chưa duyệt');
  assert.deepEqual(st.d.lich_su.filter((h) => h.hanh_dong === 'gui' || h.hanh_dong === 'gui_lai').map((h) => h.hanh_dong), ['gui', 'gui_lai']);
});

test('KHÔNG có thu hồi và KHÔNG có duyệt thay: quản lý module và admin đều bị 403 khi duyệt, hồ sơ vẫn chưa duyệt', async () => {
  const dot = ID.dotMail;
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/trinh/thu-hoi`, {})).s, 404, 'đã bỏ thu hồi');
  for (const uid of [QUAN_LY, ADMIN]) {
    const r = await ung.json(uid, 'POST', `/dot/${dot.id}/trinh/duyet`, { nhan_xet: 'Duyệt hộ' });
    assert.equal(r.s, 403, 'user ' + uid);
    assert.match(r.d.message, /Chỉ Viện trưởng/);
  }
  const st = await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}/trinh`);
  assert.equal(st.d.trinh.trang_thai, 'da_gui');
  assert.equal(st.d.co_the.duyet, false, 'giao diện của quản lý không có nút Duyệt');
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', `/dot/${dot.id}/trinh`)).d.co_the.duyet, true, 'Viện trưởng có nút Duyệt');
});

test('Viện trưởng duyệt: người quản lý được báo, Viện trưởng không nhận lại thư; sau đó khóa tệp và không gửi lại được', async () => {
  const dot = ID.dotMail;
  ung.thu.length = 0;
  const r = await ung.json(VIEN_TRUONG, 'POST', `/dot/${dot.id}/trinh/duyet`, { nhan_xet: 'Đã xem, đồng ý.' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  await ung.doiThu(1);
  assert.deepEqual(ung.thu.map((t) => t.to), ['quanly@thu.local']);
  assert.match(ung.thu[0].subject, /^\[Viện trưởng đã duyệt\]/);
  assert.match(ung.thu[0].text, /Đã xem, đồng ý\./);

  const st = await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}/trinh`);
  assert.equal(st.d.trinh.trang_thai, 'da_duyet');
  assert.equal(st.d.trinh.nguoi_duyet, 'Phạm Viện Trưởng');
  assert.equal(st.d.trinh.duyet_thay, undefined, 'không còn khái niệm duyệt thay');
  assert.ok(st.d.lich_su.some((h) => h.hanh_dong === 'duyet'));
  assert.ok(!st.d.lich_su.some((h) => h.hanh_dong === 'duyet_thay'));

  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/dot/${dot.id}/trinh/duyet`, {})).s, 409, 'đã duyệt rồi');
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/trinh/gui`, {})).s, 409, 'đã duyệt thì không gửi lại');
  assert.equal((await ung.taiTep(QUAN_LY, `/dot/${dot.id}/trinh/tep`, 'them.pdf', PDF_MAU)).s, 409);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', `/dot/${dot.id}/trinh/tep/${ID.tep1}`)).s, 409);
});

test('đợt khác: Viện trưởng chưa duyệt thì hồ sơ cứ ở trạng thái chưa duyệt, không có gì khác xảy ra', async () => {
  const dot = await taoDot('Đợt Viện trưởng chưa duyệt', [ID.phongA]);
  assert.equal((await nop(TP_A, dot.bc[ID.phongA], 'Trần A')).s, 200);
  assert.equal((await ung.taiTep(QUAN_LY, `/dot/${dot.id}/trinh/tep`, 'kx.pdf', PDF_MAU)).s, 201);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/trinh/gui`, {})).s, 200);
  const st = await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}/trinh`);
  assert.equal(st.d.trinh.trang_thai, 'da_gui');
  assert.equal(st.d.co_the.gui, true, 'quản lý vẫn gửi lại (nhắc) được bao nhiêu lần cũng được');
  const dot2 = await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id);
  assert.equal(dot2.d.dot.trang_thai, 'dang_mo', 'đợt không bị ảnh hưởng');
});

// ── 6. Tải tệp về ────────────────────────────────────────────────────────────

test('tải tệp hồ sơ: người quản lý và Viện trưởng tải được đúng nội dung, tên tiếng Việt, không lưu đệm', async () => {
  const url = `/dot/${ID.dotMail.id}/trinh/tep/${ID.tep1}/tai`;
  for (const uid of [QUAN_LY, VIEN_TRUONG, ADMIN]) {
    const r = await ung.goi(uid, 'GET', url);
    assert.equal(r.status, 200, 'user ' + uid);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-disposition'), /filename\*=UTF-8''B%C3%A1o/);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), PDF_MAU, 'nội dung tải về phải y nguyên tệp đã tải lên');
  }
});

test('tải tệp hồ sơ: trưởng phòng, người ngoài, người chưa đăng nhập đều bị chặn', async () => {
  const url = `/dot/${ID.dotMail.id}/trinh/tep/${ID.tep1}/tai`;
  assert.equal((await ung.goi(TP_A, 'GET', url)).status, 403);
  assert.equal((await ung.goi(TP_B, 'GET', url)).status, 403);
  assert.equal((await ung.goi(NGOAI, 'GET', url)).status, 403);
  assert.equal((await ung.goi(VT_CHUNG, 'GET', url)).status, 403);
  assert.equal((await ung.goi(null, 'GET', url)).status, 401);
});

test('tải tệp hồ sơ: không tải được tệp của đợt khác bằng cách đổi id đợt', async () => {
  const dotKhac = await taoDot('Đợt khác', [ID.phongA]);
  const r = await ung.goi(QUAN_LY, 'GET', `/dot/${dotKhac.id}/trinh/tep/${ID.tep1}/tai`);
  assert.equal(r.status, 404);
});

test('tải tệp hồ sơ: dòng DB có tên lưu độc hại (../) cũng không đọc được tệp ngoài thư mục', async () => {
  const dot = await taoDot('Đợt traversal', [ID.phongA]);
  // Mô phỏng DB bị can thiệp: tên lưu trỏ ra ngoài thư mục tệp
  ung.db.prepare('INSERT INTO bcp_trinh (dot_id) VALUES (?)').run(dot.id);
  const r = ung.db
    .prepare("INSERT INTO bcp_trinh_tep (dot_id, ten_goc, ten_luu, loai, kich_thuoc) VALUES (?, 'x.pdf', '../../../etc/passwd', 'pdf', 1)")
    .run(dot.id);
  const res = await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/trinh/tep/${Number(r.lastInsertRowid)}/tai`);
  assert.equal(res.status, 404);
});

// ── 7. Kết xuất qua API ─────────────────────────────────────────────────────

test('kết xuất: trưởng phòng và người ngoài không xuất được', async () => {
  const dot = ID.dotMail;
  for (const uid of [TP_A, NGOAI, VT_CHUNG, VIEN_TRUONG]) { // Viện trưởng đọc báo cáo, không kết xuất (việc của quản lý module)
    assert.equal((await ung.goi(uid, 'GET', `/dot/${dot.id}/xuat?phong=${ID.phongA}&dinh_dang=docx`)).status, 403);
  }
  assert.equal((await ung.goi(null, 'GET', `/dot/${dot.id}/xuat`)).status, 401);
});

test('kết xuất Word: một phòng, nhiều phòng, tất cả; có tên tệp tiếng Việt và không lưu đệm', async () => {
  const dot = ID.dotMail;
  let r = await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=${ID.phongA}&dinh_dang=docx`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /wordprocessingml/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /Phòng A\.docx/);
  const mot = Buffer.from(await r.arrayBuffer());
  assert.equal(mot.slice(0, 2).toString(), 'PK', 'docx là tệp zip');

  r = await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=${ID.phongA},${ID.phongB}&dinh_dang=docx`);
  assert.equal(r.status, 200);
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /2 phòng\.docx/);

  r = await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=tat-ca&dinh_dang=docx`);
  assert.equal(r.status, 200);
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /2 phòng\.docx/);

  // mặc định (không nói định dạng) là Word
  r = await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=${ID.phongA}`);
  assert.match(r.headers.get('content-type'), /wordprocessingml/);
});

test('kết xuất PDF: đúng chữ ký %PDF, nhúng font Tinos (để có dấu tiếng Việt)', async () => {
  const r = await ung.goi(QUAN_LY, 'GET', `/dot/${ID.dotMail.id}/xuat?phong=${ID.phongA}&dinh_dang=pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  assert.ok(buf.includes('Tinos'), 'PDF phải nhúng font Tinos; font mặc định không có dấu tiếng Việt');
});

test('kết xuất: chọn đích danh phòng CHƯA NỘP thì báo lỗi nêu tên phòng, không lặng lẽ bỏ qua', async () => {
  const dot = await taoDot('Đợt xuất lỗi', [ID.phongA, ID.phongB]);
  assert.equal((await nop(TP_A, dot.bc[ID.phongA], 'Trần A')).s, 200);
  const r = await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=${ID.phongA},${ID.phongB}&dinh_dang=docx`);
  assert.equal(r.s, 409);
  assert.match(r.d.message, /Phòng B/);
  // "tất cả" thì chỉ lấy phòng đã nộp
  const tat = await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=tat-ca&dinh_dang=docx`);
  assert.equal(tat.status, 200);
  assert.match(decodeURIComponent(tat.headers.get('content-disposition')), /Phòng A\.docx/);
});

test('kết xuất: tham số sai bị từ chối đúng mã', async () => {
  const dot = ID.dotMail;
  assert.equal((await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?dinh_dang=exe`)).status, 400);
  assert.equal((await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=abc`)).status, 400);
  assert.equal((await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=`)).status, 400);
  assert.equal((await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=99999`)).status, 404, 'phòng không thuộc đợt');
  assert.equal((await ung.goi(QUAN_LY, 'GET', `/dot/99999/xuat`)).status, 404);
});

test('kết xuất: không xuất được khi đợt chưa có báo cáo nào được nộp', async () => {
  const dot = await taoDot('Đợt trống', [ID.phongA]);
  const r = await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=tat-ca`);
  assert.equal(r.s, 409);
  assert.match(r.d.message, /chưa có báo cáo nào đã nộp/);
});

test('kết xuất được ghi vào lịch sử đợt (ai xuất, định dạng, phòng nào)', async () => {
  const st = await ung.json(QUAN_LY, 'GET', `/dot/${ID.dotMail.id}/trinh`);
  const xuat = st.d.lich_su.filter((h) => h.hanh_dong === 'xuat');
  assert.ok(xuat.length >= 3);
  assert.ok(xuat.some((h) => /^PDF:/.test(h.ghi_chu) && h.nguoi === 'Nguyễn Quản Lý'));
});
