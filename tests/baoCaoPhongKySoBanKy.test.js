/**
 * tests/baoCaoPhongKySoBanKy.test.js
 * Bản PDF ĐÃ KÝ SỐ của báo cáo: hệ thống kiểm chữ ký thật trong tệp và báo "hợp lệ / không hợp lệ"; đối chiếu SHA-256 trước khi cho tải;
 * chữ ký là CHỨNG NHẬN tài liệu (DocMDP); và với báo cáo đã ký thì PDF xuất ra cho người quản lý chính là bản đã ký thay cho bản dựng lại.
 * Chạy trên router thật với MySign giả lập; không cần khoá bí mật nào.
 *
 * Trọng tâm: tệp bị sửa trên đĩa thì không được tải và bị báo không nguyên vẹn; sửa cả tệp lẫn mã SHA-256 trong CSDL thì chữ ký vẫn bị
 * báo không hợp lệ; chỉ người được xem báo cáo mới kiểm / tải được; bản chưa ký không bị thay bằng gì cả.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');
const { dungMySignGiaLap } = require('./helpers/mysignGiaLap');
const Pades = require('../services/mysign/pades');

const QUAN_LY = 2;
const VIEN_TRUONG = 3;
const TP_A = 4;
const TP_B = 5;

let ung;
let gl;
const ID = {};

const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten, ky_tu_ngay: '2026-09-04', ky_den_ngay: '2026-10-04', tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm của ' + ten, muc_do: 100 } }],
});

/** Đợt có 2 phòng đều đã nộp và đã trình. Trả {dot, a, b}. */
async function taoDot(tieuDe) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA, ID.phongB] });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao.map((b) => [b.phong_id, b.id]));
  for (const [uid, id, ten] of [[TP_A, bc[ID.phongA], 'A'], [TP_B, bc[ID.phongB], 'B']]) {
    assert.equal((await ung.json(uid, 'PUT', `/bao-cao/${id}/du-lieu`, { du_lieu: DU_LIEU(ten) })).s, 200);
    assert.equal((await ung.json(uid, 'POST', `/bao-cao/${id}/nop`, {})).s, 200);
  }
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/trinh-vien-truong`, {})).s, 200);
  return { dot: r.d.id, a: bc[ID.phongA], b: bc[ID.phongB] };
}

/** Viện trưởng ký báo cáo `id`; trả PDF đã ký (tải bằng quyền người phụ trách phòng). */
async function kyBaoCao(d, id) {
  const nopLuc = (await ung.json(VIEN_TRUONG, 'GET', `/dot/${d.dot}/vien-truong`)).d.bao_cao.find((b) => b.id === id).nop_luc;
  gl.cheDo = 'cho';
  const r = await ung.json(VIEN_TRUONG, 'POST', `/dot/${d.dot}/ky-so`, { bao_cao: [{ id, nop_luc: nopLuc }] });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  gl.cheDo = 'dong_y';
  const x = await ung.json(VIEN_TRUONG, 'GET', '/api/mysign/giao-dich/' + r.d.giao_dich.id);
  assert.equal(x.d.trang_thai, 'thanh_cong', JSON.stringify(x.d));
}

const taiBan = async (uid, id) => {
  const res = await ung.goi(uid, 'GET', `/bao-cao/${id}/ban-ky-so`);
  return { s: res.status, buf: Buffer.from(await res.arrayBuffer()), res };
};
const duongDanTep = (id) => path.join(ung.uploadsRoot, 'mysign', ung.kySo.banDaKy('bao_cao_phong', id).tep_da_ky);
const xuatPdf = async (uid, dot, ids) => {
  const res = await ung.goi(uid, 'GET', `/dot/${dot}/xuat?bao_cao=${ids.join(',')}&dinh_dang=pdf`);
  return { s: res.status, buf: Buffer.from(await res.arrayBuffer()), res };
};

test.before(async () => {
  gl = await dungMySignGiaLap();
  ung = await dungUngDung({ mysign: gl.cauHinh });
  const { db } = ung;
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng Hành chính')").run().lastInsertRowid);
  ID.phongB = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('b','Phòng Đào tạo')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'truong_phong')").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'truong_phong')").run(TP_B, ID.phongB);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
  const r = await ung.json(VIEN_TRUONG, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'VT_MYSIGN_001' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
});

test.after(async () => {
  if (ung) await ung.dung();
  if (gl) await gl.dung();
});

test('kiểm chữ ký: bản đã ký báo "hợp lệ" kèm người ký, số chứng thư; người trong phòng và người quản lý kiểm được, phòng khác / chưa đăng nhập thì không', async () => {
  const d = await taoDot('Đợt kiểm chữ ký');
  await kyBaoCao(d, d.a);
  const kt = Pades.kiemTra((await taiBan(TP_A, d.a)).buf);
  assert.equal(kt.hopLe, true);

  for (const uid of [TP_A, QUAN_LY]) {
    const r = await ung.json(uid, 'GET', `/bao-cao/${d.a}/ban-ky-so/kiem-tra`);
    assert.equal(r.s, 200, 'user ' + uid);
    assert.equal(r.d.hop_le, true);
    assert.equal(r.d.toan_ven, true);
    assert.equal(r.d.ly_do, null);
    assert.equal(r.d.nguoi_ky, 'PHAM VIEN TRUONG');
    assert.equal(r.d.to_chuc, 'Vien Te bao goc');
    assert.equal(r.d.so_seri, kt.so_seri, 'số chứng thư đúng số seri trong chữ ký');
    assert.equal(typeof r.d.ky_luc, 'string');
  }
  assert.equal((await ung.json(TP_B, 'GET', `/bao-cao/${d.a}/ban-ky-so/kiem-tra`)).s, 404, 'phòng khác không kiểm được báo cáo này');
  assert.equal((await ung.goi(null, 'GET', `/bao-cao/${d.a}/ban-ky-so/kiem-tra`)).status, 401);
  assert.equal((await ung.json(TP_B, 'GET', `/bao-cao/${d.b}/ban-ky-so/kiem-tra`)).s, 404, 'báo cáo chưa ký: chưa có gì để kiểm');
  assert.equal((await ung.json(QUAN_LY, 'GET', '/bao-cao/999999/ban-ky-so/kiem-tra')).s, 404);
});

test('tệp đã ký bị sửa trên đĩa: không cho tải (409), kiểm chữ ký báo không nguyên vẹn', async () => {
  const d = await taoDot('Đợt tệp bị sửa');
  await kyBaoCao(d, d.a);
  assert.equal((await taiBan(TP_A, d.a)).s, 200, 'trước khi bị sửa tải được');
  const p = duongDanTep(d.a);
  const goc = fs.readFileSync(p);
  const sua = Buffer.from(goc);
  sua[100] = sua[100] ^ 0xff; // đổi một byte trong phần nội dung
  fs.writeFileSync(p, sua);
  const t = await taiBan(TP_A, d.a);
  assert.equal(t.s, 409);
  assert.ok(!t.buf.equals(sua), 'không trả tệp đã bị sửa');
  assert.match(JSON.parse(t.buf.toString()).message, /không còn nguyên vẹn/);
  const kt = await ung.json(TP_A, 'GET', `/bao-cao/${d.a}/ban-ky-so/kiem-tra`);
  assert.equal(kt.s, 200);
  assert.equal(kt.d.hop_le, false);
  assert.equal(kt.d.toan_ven, false);
  fs.writeFileSync(p, goc); // trả lại để các bước sau không ảnh hưởng
  assert.equal((await taiBan(TP_A, d.a)).s, 200);
});

test('sửa cả tệp lẫn mã SHA-256 trong CSDL: vẫn tải được nhưng chữ ký bị báo KHÔNG hợp lệ (lớp kiểm thứ hai)', async () => {
  const d = await taoDot('Đợt sửa cả mã băm');
  await kyBaoCao(d, d.a);
  const p = duongDanTep(d.a);
  const goc = fs.readFileSync(p);
  const sua = Buffer.from(goc);
  const giua = Math.floor(sua.indexOf('/Contents <', 0, 'latin1') / 2); // giữa phần nội dung được ký (trước chuỗi chữ ký)
  sua[giua] = sua[giua] ^ 0xff;
  fs.writeFileSync(p, sua);
  const da = ung.kySo.banDaKy('bao_cao_phong', d.a);
  const shaCu = da.sha256;
  ung.db.prepare('UPDATE mysign_tai_lieu SET sha256 = ? WHERE id = ?').run(Pades.sha256(sua).toString('hex'), da.id);
  assert.equal((await taiBan(TP_A, d.a)).s, 200, 'mã băm khớp nên qua lớp kiểm đầu');
  const kt = await ung.json(TP_A, 'GET', `/bao-cao/${d.a}/ban-ky-so/kiem-tra`);
  assert.equal(kt.d.hop_le, false, JSON.stringify(kt.d));
  assert.equal(kt.d.toan_ven, true);
  assert.match(kt.d.ly_do, /thay đổi sau khi ký|không khớp/);
  fs.writeFileSync(p, goc);
  ung.db.prepare('UPDATE mysign_tai_lieu SET sha256 = ? WHERE id = ?').run(shaCu, da.id);
});

test('mất tệp đã ký trên đĩa: báo 404 rõ ràng, không phải lỗi hệ thống', async () => {
  const d = await taoDot('Đợt mất tệp');
  await kyBaoCao(d, d.a);
  const p = duongDanTep(d.a);
  const goc = fs.readFileSync(p);
  fs.rmSync(p);
  const t = await taiBan(TP_A, d.a);
  assert.equal(t.s, 404);
  assert.match(JSON.parse(t.buf.toString()).message, /Không tìm thấy tệp đã ký/);
  assert.equal((await ung.json(TP_A, 'GET', `/bao-cao/${d.a}/ban-ky-so/kiem-tra`)).s, 404);
  fs.writeFileSync(p, goc);
});

test('chứng nhận tài liệu (DocMDP): PDF đã ký có /Perms + /DocMDP mức 2 và chữ ký vẫn hợp lệ', async () => {
  const d = await taoDot('Đợt chứng nhận');
  await kyBaoCao(d, d.a);
  const pdf = (await taiBan(TP_A, d.a)).buf;
  const s = pdf.toString('latin1');
  assert.match(s, /\/Perms\s*<<\s*\/DocMDP \d+ 0 R\s*>>/, 'Catalog trỏ tới chữ ký chứng nhận');
  assert.match(s, /\/TransformMethod \/DocMDP/);
  assert.match(s, /\/P 2\b/);
  assert.equal((s.match(/\/FT \/Sig/g) || []).length, 1, 'vẫn đúng một ô chữ ký');
  assert.equal(Pades.kiemTra(pdf).hopLe, true);
});

test('PDF xuất ra: báo cáo đã ký thì CHÍNH LÀ bản đã ký số; chưa ký hoặc gộp nhiều báo cáo thì dựng như cũ (không có chữ ký)', async () => {
  const d = await taoDot('Đợt xuất PDF');
  await kyBaoCao(d, d.a);
  const daKy = (await taiBan(TP_A, d.a)).buf;

  const x = await xuatPdf(QUAN_LY, d.dot, [d.a]);
  assert.equal(x.s, 200);
  assert.equal(x.res.headers.get('content-type'), 'application/pdf');
  assert.ok(x.buf.equals(daKy), 'đúng bản đã ký số, từng byte');
  assert.equal(Pades.kiemTra(x.buf).hopLe, true);
  assert.match(decodeURIComponent(x.res.headers.get('content-disposition')), /đã ký số\.pdf/);
  const xem = await ung.goi(QUAN_LY, 'GET', `/dot/${d.dot}/xuat?bao_cao=${d.a}&dinh_dang=pdf&xem=1`);
  assert.match(xem.headers.get('content-disposition'), /^inline/);
  await xem.arrayBuffer();

  const chuaKy = await xuatPdf(QUAN_LY, d.dot, [d.b]);
  assert.equal(chuaKy.s, 200);
  assert.ok(!chuaKy.buf.toString('latin1').includes('/ByteRange'), 'báo cáo chưa ký: bản dựng lại, không có chữ ký');

  const gop = await xuatPdf(QUAN_LY, d.dot, [d.a, d.b]);
  assert.equal(gop.s, 200);
  assert.ok(!gop.buf.toString('latin1').includes('/ByteRange'), 'gộp nhiều báo cáo: dựng như cũ');

  const word = await ung.goi(QUAN_LY, 'GET', `/dot/${d.dot}/xuat?bao_cao=${d.a}&dinh_dang=docx`);
  assert.equal(word.status, 200);
  assert.ok(Buffer.from(await word.arrayBuffer()).subarray(0, 2).toString() === 'PK', 'Word vẫn xuất bình thường');
  assert.equal((await xuatPdf(TP_A, d.dot, [d.a])).s, 403, 'chỉ người quản lý module xuất được');
});

test('PDF xuất ra của báo cáo đã ký mà tệp bị sửa trên đĩa: 409, không trả tệp hỏng', async () => {
  const d = await taoDot('Đợt xuất tệp hỏng');
  await kyBaoCao(d, d.a);
  const p = duongDanTep(d.a);
  const goc = fs.readFileSync(p);
  const sua = Buffer.from(goc);
  sua[100] = sua[100] ^ 0xff;
  fs.writeFileSync(p, sua);
  const x = await xuatPdf(QUAN_LY, d.dot, [d.a]);
  assert.equal(x.s, 409);
  assert.ok(!x.buf.equals(sua));
  fs.writeFileSync(p, goc);
});
