/**
 * tests/baoCaoPhongNhacHan.test.js
 * Email tự nhắc trước hạn nộp (services/baoCaoPhongNhacHan.js).
 * Trọng tâm: nhắc đúng người (chỉ phòng CHƯA nộp), đúng lúc (còn 1–2 ngày và đúng ngày hạn, trong giờ làm việc
 * theo giờ Việt Nam), đúng một lần (kể cả chạy chồng / khởi động lại / dời hạn), và không làm hỏng gì khi SMTP lỗi.
 * Thời gian được điều khiển bằng tham số của chayMotLan(ms), không chờ đồng hồ thật.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');
const { taoThongBao } = require('../services/baoCaoPhongThongBao');
const { taoNhacHan } = require('../services/baoCaoPhongNhacHan');

const QUAN_LY = 2; // cũng là trưởng phòng TCHC
const TP_A = 4;
const TP_B = 5;
const HAN = '2099-12-31';

/** Mốc thời gian theo GIỜ VIỆT NAM (UTC+7): vn('2099-12-29', 9) = 9h sáng ngày đó ở Việt Nam. */
const vn = (ngay, gio, phut = 0) => Date.parse(ngay + 'T00:00:00Z') + (gio * 60 + phut) * 60000 - 7 * 3600000;

let ung;
const ID = {};

const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten, ky_tu_ngay: '2026-09-04', ky_den_ngay: '2026-10-04', tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm', muc_do: 100 } }],
});

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

const doi = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** Đợt mở cho TCHC, A, B; phòng B nộp ngay. Dọn thư mở đợt/nộp trước khi test soi thư nhắc. */
async function taoDotMo(tieuDe = 'Báo cáo tháng 10', han = HAN, phongIds = [ID.tchc, ID.phongA, ID.phongB]) {
  // Chạy nhắc quét MỌI đợt đang mở trong DB: đóng các đợt của test trước để mỗi test chỉ thấy đợt của mình.
  ung.db.prepare("UPDATE bcp_dot SET trang_thai = 'dong' WHERE trang_thai = 'dang_mo'").run();
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: han, mau_id: ID.mau, phong_ids: phongIds });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao.map((b) => [b.phong_id, b.id]));
  if (bc[ID.phongB]) {
    assert.equal((await ung.json(TP_B, 'PUT', `/bao-cao/${bc[ID.phongB]}/du-lieu`, { du_lieu: DU_LIEU('B') })).s, 200);
    assert.equal((await ung.json(TP_B, 'POST', `/bao-cao/${bc[ID.phongB]}/nop`, {})).s, 200);
  }
  await doi();
  ung.thu.length = 0;
  return { id: r.d.id, bc };
}

const thuNhac = () => ung.thu.filter((t) => /^\[(Nhắc nộp báo cáo|Hạn nộp hôm nay)\]/.test(t.subject));
const nhatKy = (dotId) => ung.db.prepare('SELECT n.loai, n.han_nop FROM bcp_nhac_han n JOIN bcp_bao_cao b ON b.id = n.bao_cao_id WHERE b.dot_id = ? ORDER BY n.rowid').all(dotId);

test('còn 2 ngày: nhắc trưởng phòng của các phòng CHƯA nộp, kèm hạn và liên kết vào đúng báo cáo; phòng đã nộp không nhận', async () => {
  const dot = await taoDotMo();
  const kq = await ung.nhacHan.chayMotLan(vn('2099-12-29', 9));
  assert.equal(kq.nhac, 2, 'TCHC và A (B đã nộp)');
  await ung.doiThu(2);
  const thu = thuNhac();
  assert.deepEqual(thu.map((t) => t.to).sort(), ['quanly@thu.local', 'tpa@thu.local'], 'quản lý kiêm trưởng phòng TCHC cũng được nhắc việc của phòng mình');
  const thuA = thu.find((t) => t.to === 'tpa@thu.local');
  assert.match(thuA.subject, /^\[Nhắc nộp báo cáo\] Báo cáo tháng 10 — còn 2 ngày \(hạn 31\/12\/2099\)$/);
  assert.match(thuA.text, /Phòng A chưa nộp báo cáo của đợt «Báo cáo tháng 10»/);
  assert.match(thuA.text, /Hạn nộp: 31\/12\/2099 \(còn 2 ngày\)/);
  assert.ok(thuA.text.includes(`https://eoffice.test/bao-cao-phong.html#/bao-cao/${dot.bc[ID.phongA]}`));
  assert.ok(!ung.thu.some((t) => t.to === 'tpb@thu.local'), 'phòng B đã nộp thì không được nhắc');
  assert.deepEqual(nhatKy(dot.id).map((x) => x.loai), ['truoc_han', 'truoc_han']);
});

test('nhắc đúng MỘT lần: chạy lại cùng ngày, hoặc "khởi động lại" (bộ nhắc mới trên cùng DB), không gửi trùng', async () => {
  const dot = await taoDotMo();
  await ung.nhacHan.chayMotLan(vn('2099-12-29', 9));
  await doi();
  assert.equal(thuNhac().length, 2);
  const lanHai = await ung.nhacHan.chayMotLan(vn('2099-12-29', 14));
  assert.equal(lanHai.nhac, 0);
  const khoiDongLai = taoNhacHan({ db: ung.db, thongBao: taoThongBao({ db: ung.db, mailSend: (o) => ung.thu.push(o), baseUrl: 'https://eoffice.test' }) });
  assert.equal((await khoiDongLai.chayMotLan(vn('2099-12-30', 9))).nhac, 0, 'còn 1 ngày vẫn thuộc mốc "trước hạn" đã nhắc rồi');
  await doi();
  assert.equal(thuNhac().length, 2);
  assert.equal(nhatKy(dot.id).length, 2);
});

test('hai lần chạy CHỒNG nhau chỉ nhắc một lần', async () => {
  await taoDotMo();
  const [a, b] = await Promise.all([ung.nhacHan.chayMotLan(vn('2099-12-29', 9)), ung.nhacHan.chayMotLan(vn('2099-12-29', 9))]);
  assert.equal(a.nhac + b.nhac, 2);
  await doi();
  assert.equal(thuNhac().length, 2);
});

test('đúng ngày hạn: thư [Hạn nộp hôm nay], gửi thêm sau thư "trước hạn" (hai mốc khác nhau)', async () => {
  const dot = await taoDotMo();
  await ung.nhacHan.chayMotLan(vn('2099-12-30', 9)); // còn 1 ngày
  await doi();
  ung.thu.length = 0;
  const kq = await ung.nhacHan.chayMotLan(vn('2099-12-31', 9)); // hết hạn trong hôm nay
  assert.equal(kq.nhac, 2);
  await ung.doiThu(2);
  const thuA = thuNhac().find((t) => t.to === 'tpa@thu.local');
  assert.match(thuA.subject, /^\[Hạn nộp hôm nay\] Báo cáo tháng 10$/);
  assert.match(thuA.text, /hết hạn trong hôm nay/);
  assert.deepEqual(nhatKy(dot.id).map((x) => x.loai), ['truoc_han', 'truoc_han', 'hom_nay', 'hom_nay']);
});

test('không nhắc khi còn 3 ngày trở lên, hoặc khi đã QUÁ hạn', async () => {
  const dot = await taoDotMo();
  assert.equal((await ung.nhacHan.chayMotLan(vn('2099-12-28', 9))).nhac, 0, 'còn 3 ngày');
  assert.equal((await ung.nhacHan.chayMotLan(vn('2100-01-01', 9))).nhac, 0, 'quá hạn 1 ngày');
  assert.equal((await ung.nhacHan.chayMotLan(vn('2100-02-01', 9))).nhac, 0, 'quá hạn lâu');
  await doi();
  assert.equal(thuNhac().length, 0);
  assert.equal(nhatKy(dot.id).length, 0);
});

test('chỉ gửi trong giờ làm việc theo GIỜ VIỆT NAM (8h–17h59), không gửi lúc nửa đêm dù server chạy UTC', async () => {
  const dot = await taoDotMo();
  for (const gio of [0, 3, 7]) assert.equal((await ung.nhacHan.chayMotLan(vn('2099-12-29', gio, 59))).bo_qua, 'ngoai_gio', gio + 'h');
  assert.equal((await ung.nhacHan.chayMotLan(vn('2099-12-29', 18))).bo_qua, 'ngoai_gio', '18h');
  assert.equal((await ung.nhacHan.chayMotLan(vn('2099-12-29', 23, 30))).bo_qua, 'ngoai_gio', '23h30');
  await doi();
  assert.equal(thuNhac().length, 0);
  assert.equal((await ung.nhacHan.chayMotLan(vn('2099-12-29', 8))).nhac, 2, '8h00 là được');
  assert.equal(nhatKy(dot.id).length, 2);
});

test('ngày được tính theo giờ VN: 6h sáng VN (= chiều hôm trước theo UTC) vẫn thuộc ngày VN đó, nên chưa gửi, đến 8h mới gửi', async () => {
  await taoDotMo('Đợt múi giờ');
  // 2099-12-29 06:00 VN = 2099-12-28 23:00 UTC. Nếu code nhầm sang UTC thì ngày sẽ lệch một ngày.
  assert.equal((await ung.nhacHan.chayMotLan(vn('2099-12-29', 6))).bo_qua, 'ngoai_gio');
  const kq = await ung.nhacHan.chayMotLan(vn('2099-12-29', 8));
  assert.equal(kq.nhac, 2);
  await ung.doiThu(2);
  assert.match(thuNhac()[0].text, /còn 2 ngày/, 'tính đúng ngày VN, không lệch một ngày theo UTC');
});

test('đợt NHÁP hoặc ĐÃ ĐÓNG thì không nhắc', async () => {
  const nhap = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Nháp', loai: 'thang', ky: '10/2026', han_nop: HAN, mau_id: ID.mau, phong_ids: [ID.phongA] });
  const dong = await taoDotMo('Sẽ đóng');
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dong.id}/dong`, {})).s, 200);
  // chỉ còn đợt Nháp và đợt đã đóng khi chạy (các đợt mở ở test trước cũng có thể có mặt: lọc theo đợt)
  await ung.nhacHan.chayMotLan(vn('2099-12-29', 9));
  assert.equal(nhatKy(nhap.d.id).length, 0, 'đợt Nháp');
  assert.equal(nhatKy(dong.id).length, 0, 'đợt đã đóng');
});

test('phòng "cần chỉnh sửa" vẫn được nhắc (kèm lưu ý); phòng đã nộp, đã duyệt thì không', async () => {
  const dot = await taoDotMo('Đợt cần sửa', HAN, [ID.phongA, ID.phongB]);
  await ung.json(TP_A, 'PUT', `/bao-cao/${dot.bc[ID.phongA]}/du-lieu`, { du_lieu: DU_LIEU('A') });
  await ung.json(TP_A, 'POST', `/bao-cao/${dot.bc[ID.phongA]}/nop`, {});
  await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.bc[ID.phongA]}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung' });
  await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.bc[ID.phongB]}/duyet`, {}); // B: đã duyệt
  await doi();
  ung.thu.length = 0;
  await ung.nhacHan.chayMotLan(vn('2099-12-29', 9));
  assert.equal(nhatKy(dot.id).length, 1);
  await doi();
  const thu = thuNhac().filter((t) => t.to === 'tpa@thu.local' && /Đợt cần sửa/.test(t.subject));
  assert.equal(thu.length, 1);
  assert.match(thu[0].text, /đang cần chỉnh sửa theo yêu cầu của người quản lý/);
  assert.ok(!thuNhac().some((t) => t.to === 'tpb@thu.local' && /Đợt cần sửa/.test(t.subject)));
});

test('người phụ trách NHIỀU phòng nhận MỘT thư liệt kê các báo cáo', async () => {
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id) VALUES (?, 'truong_phong', ?)").run(TP_A, ID.tchc);
  try {
    const dot = await taoDotMo('Đợt hai phòng', '2098-06-15', [ID.tchc, ID.phongA]);
    await ung.nhacHan.chayMotLan(vn('2098-06-14', 9));
    await doi();
    const choA = thuNhac().filter((t) => t.to === 'tpa@thu.local');
    assert.equal(choA.length, 1, 'một thư, không phải mỗi phòng một thư');
    assert.match(choA[0].subject, /^\[Nhắc nộp báo cáo\] 2 báo cáo sắp đến hạn$/);
    for (const id of Object.values(dot.bc)) assert.ok(choA[0].text.includes(`#/bao-cao/${id}`));
  } finally {
    ung.db.prepare('DELETE FROM bcp_thanh_vien WHERE user_id = ? AND phong_id = ?').run(TP_A, ID.tchc);
  }
});

test('dời hạn nộp thì hạn MỚI được nhắc lại; hạn cũ đã nhắc không bị nhắc lại', async () => {
  const dot = await taoDotMo('Đợt dời hạn', '2097-03-10', [ID.phongA]);
  await ung.nhacHan.chayMotLan(vn('2097-03-09', 9));
  await doi();
  assert.equal(thuNhac().length, 1);
  // quản lý dời hạn thêm 10 ngày
  const ct = (await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id)).d;
  await ung.json(QUAN_LY, 'PUT', '/dot/' + dot.id, { tieu_de: ct.dot.tieu_de, loai: 'thang', ky: '10/2026', han_nop: '2097-03-20', khong_thong_bao: true });
  ung.thu.length = 0;
  assert.equal((await ung.nhacHan.chayMotLan(vn('2097-03-10', 9))).nhac, 0, 'ngày hạn cũ: đã dời rồi nên không nhắc');
  assert.equal((await ung.nhacHan.chayMotLan(vn('2097-03-19', 9))).nhac, 1, 'còn 1 ngày tới hạn MỚI: nhắc');
  await ung.doiThu(1);
  assert.match(thuNhac()[0].text, /20\/03\/2097/);
  assert.deepEqual(nhatKy(dot.id).map((x) => x.han_nop), ['2097-03-10', '2097-03-20']);
});

test('SMTP hỏng: không ném lỗi, nhả nhật ký để lần sau thử lại; sau khi hết hỏng thì nhắc được', async () => {
  const dot = await taoDotMo('Đợt SMTP hỏng', '2096-05-10', [ID.phongA]);
  ung.cheDoMail = async () => { throw new Error('smtp_down'); };
  let kq;
  try {
    kq = await ung.nhacHan.chayMotLan(vn('2096-05-09', 9));
  } finally {
    ung.cheDoMail = null;
  }
  assert.equal(kq.gui, 0);
  assert.equal(nhatKy(dot.id).length, 0, 'mọi thư đều hỏng thì không đánh dấu là đã nhắc');
  ung.thu.length = 0;
  assert.equal((await ung.nhacHan.chayMotLan(vn('2096-05-09', 10))).nhac, 1);
  await ung.doiThu(1);
  assert.equal(thuNhac().length, 1);
});

test('tiêu đề đợt do người gõ được escape trong thư nhắc', async () => {
  await taoDotMo('<img src=x onerror=alert(1)> Đợt', '2095-01-10', [ID.phongA]);
  await ung.nhacHan.chayMotLan(vn('2095-01-09', 9));
  await ung.doiThu(1);
  const html = thuNhac()[0].html;
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

test('hẹn giờ: batDau() tạo timer không giữ tiến trình sống và dừng lại được', async () => {
  const dung = ung.nhacHan.batDau();
  assert.equal(typeof dung, 'function');
  dung();
});
