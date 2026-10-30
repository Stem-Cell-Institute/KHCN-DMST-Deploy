/**
 * tests/baoCaoPhongSuaDot.test.js
 * Sửa đợt báo cáo ĐANG MỞ (hạn nộp / tiêu đề / hướng dẫn) thì báo trưởng phòng các phòng CHƯA nộp.
 * Trọng tâm: không gửi nhầm người (phòng đã nộp, người vừa sửa), không gửi khi không có thay đổi thật,
 * người quản lý tắt được, đợt Nháp/đã đóng không gửi, thư lỗi không làm hỏng việc lưu, dữ liệu gõ vào được escape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');

const QUAN_LY = 2; // cũng là trưởng phòng TCHC (phòng chưa nộp) → vẫn KHÔNG nhận thư vì chính mình vừa sửa
const TP_A = 4;
const TP_B = 5;

let ung;
const ID = {};

const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten,
  ky_tu_ngay: '2026-09-04',
  ky_den_ngay: '2026-10-04',
  tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm', muc_do: 100 } }],
});

const lichSuDot = (id) => ung.db.prepare('SELECT hanh_dong, ghi_chu FROM bcp_dot_lich_su WHERE dot_id = ? AND hanh_dong = ? ORDER BY id').all(id, 'sua_dot');
const guiNhanThuSua = () => ung.thu.filter((t) => /^\[(Đổi hạn nộp|Cập nhật đợt báo cáo)\]/.test(t.subject));

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  ID.tchc = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('tchc','Phòng TCHC')").run().lastInsertRowid);
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run().lastInsertRowid);
  ID.phongB = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('b','Phòng B')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(QUAN_LY, ID.tchc);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_B, ID.phongB);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

/** Tạo đợt cho 3 phòng và mở; phòng B nộp ngay → chỉ TCHC và A chưa nộp. Xóa thư mở đợt để test soi sạch. */
async function taoDotMo(tieuDe = 'Báo cáo tháng 10') {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', {
    tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mo_ta: 'Hướng dẫn cũ', mau_id: ID.mau,
    phong_ids: [ID.tchc, ID.phongA, ID.phongB],
  });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const ct = await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id);
  const bcB = ct.d.bao_cao.find((b) => b.phong_id === ID.phongB).id;
  assert.equal((await ung.json(TP_B, 'PUT', `/bao-cao/${bcB}/du-lieu`, { du_lieu: DU_LIEU('B') })).s, 200);
  assert.equal((await ung.json(TP_B, 'POST', `/bao-cao/${bcB}/nop`, {})).s, 200);
  await ung.doiThu(ung.thu.length + 0);
  await new Promise((x) => setTimeout(x, 150)); // chờ hết thư mở đợt/nộp gửi nền
  ung.thu.length = 0;
  return { id: r.d.id, bcA: ct.d.bao_cao.find((b) => b.phong_id === ID.phongA).id, bcB };
}

const suaDot = (id, thayDoi, tuyChon = {}) =>
  ung.json(QUAN_LY, 'PUT', '/dot/' + id, {
    tieu_de: 'Báo cáo tháng 10', loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mo_ta: 'Hướng dẫn cũ', ...thayDoi, ...tuyChon,
  });

test('đổi hạn nộp đợt đang mở: chỉ trưởng phòng CHƯA nộp nhận thư, nêu hạn cũ → mới và liên kết đúng báo cáo', async () => {
  const dot = await taoDotMo();
  const r = await suaDot(dot.id, { han_nop: '2099-12-30' });
  assert.equal(r.s, 200);
  assert.equal(r.d.da_bao, 1, 'chỉ phòng A (TCHC là người vừa sửa, phòng B đã nộp)');
  await ung.doiThu(1);
  const thu = guiNhanThuSua();
  assert.equal(thu.length, 1);
  assert.equal(thu[0].to, 'tpa@thu.local');
  assert.match(thu[0].subject, /^\[Đổi hạn nộp\]/);
  assert.match(thu[0].text, /31\/12\/2099 → 30\/12\/2099/);
  assert.ok(thu[0].text.includes(`https://eoffice.test/bao-cao-phong.html#/bao-cao/${dot.bcA}`), 'liên kết vào đúng báo cáo của phòng A');
  assert.ok(!ung.thu.some((t) => t.to === 'tpb@thu.local'), 'phòng B đã nộp thì không bị làm phiền');
  assert.ok(!ung.thu.some((t) => t.to === 'quanly@thu.local'), 'người vừa sửa không nhận thư của chính mình');
});

test('lịch sử đợt ghi lại việc sửa, kể cả giá trị cũ → mới', async () => {
  const dot = await taoDotMo();
  await suaDot(dot.id, { han_nop: '2099-12-30', tieu_de: 'Báo cáo tháng 10 (điều chỉnh)' });
  const ls = lichSuDot(dot.id);
  assert.equal(ls.length, 1);
  assert.match(ls[0].ghi_chu, /Hạn nộp 31\/12\/2099 → 30\/12\/2099/);
  assert.match(ls[0].ghi_chu, /Tiêu đề «Báo cáo tháng 10» → «Báo cáo tháng 10 \(điều chỉnh\)»/);
});

test('chỉ đổi hướng dẫn: thư "Cập nhật đợt báo cáo" báo có thay đổi, không chép nguyên văn hướng dẫn', async () => {
  const dot = await taoDotMo();
  await suaDot(dot.id, { mo_ta: 'Nộp trước 15h, kèm minh chứng.' });
  await ung.doiThu(1);
  const thu = guiNhanThuSua();
  assert.equal(thu.length, 1);
  assert.match(thu[0].subject, /^\[Cập nhật đợt báo cáo\]/);
  assert.match(thu[0].text, /Hướng dẫn của người quản lý: đã được cập nhật/);
  assert.doesNotMatch(thu[0].text, /Nộp trước 15h/);
  assert.doesNotMatch(thu[0].text, /Hạn nộp:/, 'không đổi hạn thì không nhắc hạn như một thay đổi');
});

test('lưu y nguyên (không đổi hạn/tiêu đề/hướng dẫn) thì KHÔNG gửi thư và KHÔNG ghi lịch sử', async () => {
  const dot = await taoDotMo();
  const r = await suaDot(dot.id, {}, { ky: '10/2026 (sửa kỳ)' }); // đổi kỳ không thuộc nhóm báo
  assert.equal(r.s, 200);
  assert.equal(r.d.da_bao, 0);
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(guiNhanThuSua().length, 0);
  assert.equal(lichSuDot(dot.id).length, 0);
});

test('hướng dẫn null và chuỗi rỗng là như nhau: không tính là thay đổi', async () => {
  const dot = await taoDotMo();
  await suaDot(dot.id, { mo_ta: '' }); // cũ "Hướng dẫn cũ" → rỗng: có đổi
  assert.equal(lichSuDot(dot.id).length, 1);
  ung.thu.length = 0;
  const r = await suaDot(dot.id, { mo_ta: '   ' }); // rỗng → rỗng (chuoi() cắt khoảng trắng): không đổi
  assert.equal(r.d.da_bao, 0);
  assert.equal(lichSuDot(dot.id).length, 1);
});

test('người quản lý tắt thông báo: không gửi thư nhưng vẫn lưu và ghi lịch sử có đánh dấu', async () => {
  const dot = await taoDotMo();
  const r = await suaDot(dot.id, { han_nop: '2099-12-29' }, { khong_thong_bao: true });
  assert.equal(r.s, 200);
  assert.equal(r.d.da_bao, 0);
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(guiNhanThuSua().length, 0);
  const ls = lichSuDot(dot.id);
  assert.equal(ls.length, 1);
  assert.match(ls[0].ghi_chu, /không gửi thông báo/);
  const ct = await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id);
  assert.equal(ct.d.dot.han_nop, '2099-12-29');
});

test('khong_thong_bao chỉ nhận đúng true (chuỗi "true" không tắt được)', async () => {
  const dot = await taoDotMo();
  const r = await suaDot(dot.id, { han_nop: '2099-12-28' }, { khong_thong_bao: 'true' });
  assert.equal(r.d.da_bao, 1);
});

test('đợt NHÁP: sửa không gửi thư, không ghi lịch sử (chưa ai thấy)', async () => {
  await new Promise((x) => setTimeout(x, 150)); // thư nền của test trước có thể còn đang đến
  ung.thu.length = 0;
  const r0 = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Nháp', loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] });
  const r = await ung.json(QUAN_LY, 'PUT', '/dot/' + r0.d.id, { tieu_de: 'Nháp 2', loai: 'thang', ky: '10/2026', han_nop: '2099-12-30', phong_ids: [ID.phongA] });
  assert.equal(r.s, 200);
  assert.equal(r.d.da_bao, 0);
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(guiNhanThuSua().length, 0);
  assert.equal(lichSuDot(r0.d.id).length, 0);
});

test('đợt ĐÃ ĐÓNG: ghi lịch sử nhưng không gửi thư', async () => {
  const dot = await taoDotMo();
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/dong`, {})).s, 200);
  const r = await suaDot(dot.id, { han_nop: '2099-12-27' });
  assert.equal(r.s, 200);
  assert.equal(r.d.da_bao, 0);
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(guiNhanThuSua().length, 0);
  assert.equal(lichSuDot(dot.id).length, 1);
});

test('phòng đang "cần chỉnh sửa" vẫn là phòng chưa nộp xong nên được báo; phòng đã duyệt thì không', async () => {
  const dot = await taoDotMo();
  // A nộp rồi bị yêu cầu chỉnh sửa → quay về trạng thái cần sửa
  assert.equal((await ung.json(TP_A, 'PUT', `/bao-cao/${dot.bcA}/du-lieu`, { du_lieu: DU_LIEU('A') })).s, 200);
  assert.equal((await ung.json(TP_A, 'POST', `/bao-cao/${dot.bcA}/nop`, {})).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.bcA}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung' })).s, 200);
  // B được duyệt
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.bcB}/duyet`, {})).s, 200);
  await new Promise((x) => setTimeout(x, 150));
  ung.thu.length = 0;
  const r = await suaDot(dot.id, { han_nop: '2099-12-26' });
  assert.equal(r.d.da_bao, 1);
  await ung.doiThu(1);
  assert.deepEqual(guiNhanThuSua().map((t) => t.to), ['tpa@thu.local']);
});

test('trưởng phòng phụ trách nhiều phòng chưa nộp nhận MỘT thư liệt kê các báo cáo', async () => {
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.tchc);
  const dot = await taoDotMo();
  await suaDot(dot.id, { han_nop: '2099-12-25' });
  await ung.doiThu(1);
  await new Promise((x) => setTimeout(x, 150));
  const thuA = guiNhanThuSua().filter((t) => t.to === 'tpa@thu.local');
  assert.equal(thuA.length, 1, 'một thư, không phải mỗi phòng một thư');
  assert.match(thuA[0].text, /Phòng A/);
  assert.match(thuA[0].text, /Phòng TCHC/);
  ung.db.prepare("DELETE FROM bcp_thanh_vien WHERE user_id = ? AND phong_id = ?").run(TP_A, ID.tchc);
});

test('dữ liệu người gõ được escape trong thư, và URL lạ trong tiêu đề không thành liên kết', async () => {
  const dot = await taoDotMo();
  await suaDot(dot.id, { tieu_de: 'Báo cáo <script>alert(1)</script> xem http://doc-hai.example/x và https://eoffice.test/bao-cao-phong.html#/cua-toi nhé' });
  await ung.doiThu(1);
  const thu = guiNhanThuSua()[0];
  assert.ok(!thu.html.includes('<script>'), 'tiêu đề phải bị escape');
  assert.ok(thu.html.includes('&lt;script&gt;'));
  assert.ok(!thu.html.includes('href="http://doc-hai.example'), 'URL ngoài hệ thống không được thành liên kết');
  assert.ok(thu.html.includes('href="https://eoffice.test/bao-cao-phong.html#/cua-toi"'), 'URL của chính hệ thống thì được');
});

test('gửi thư lỗi (SMTP hỏng) không làm hỏng việc lưu đợt', async () => {
  const dot = await taoDotMo();
  ung.cheDoMail = async () => { throw new Error('smtp_down'); };
  try {
    const r = await suaDot(dot.id, { han_nop: '2099-12-24' });
    assert.equal(r.s, 200);
    await new Promise((x) => setTimeout(x, 150));
    const ct = await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id);
    assert.equal(ct.d.dot.han_nop, '2099-12-24');
  } finally {
    ung.cheDoMail = null;
  }
});

test('chỉ người quản lý sửa được đợt (trưởng phòng bị 403 và không có thư nào đi)', async () => {
  const dot = await taoDotMo();
  const r = await ung.json(TP_A, 'PUT', '/dot/' + dot.id, { tieu_de: 'x', loai: 'thang', ky: '', han_nop: '2099-01-01' });
  assert.equal(r.s, 403);
  await new Promise((x) => setTimeout(x, 150));
  assert.equal(ung.thu.length, 0);
});
