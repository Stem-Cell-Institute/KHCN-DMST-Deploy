/**
 * tests/baoCaoPhongKySo.test.js
 * Viện trưởng DUYỆT VÀ KÝ SỐ báo cáo qua MySign (routes/baoCaoPhongKySo.js + hạ tầng services/mysign/).
 * Chạy trên router thật với một MySign GIẢ (tests/helpers/mysignGiaLap.js): khóa RSA + chứng thư tự cấp, ký đúng như
 * dịch vụ thật (RSA PKCS#1 v1.5 trên mã băm SHA-256).
 *
 * Trọng tâm là những chỗ sai thì hậu quả nặng:
 *   - "Đã duyệt" bị ghi khi Viện trưởng CHƯA xác nhận ký (từ chối / hết hạn / còn chờ)
 *   - chữ ký gán cho bản báo cáo Viện trưởng chưa đọc (phòng nộp lại trong lúc chờ ký)
 *   - PDF đã ký không hợp lệ (mã băm sai, chữ ký không khớp chứng thư), hoặc sửa tệp mà vẫn báo hợp lệ
 *   - đổi được quyết định trên bản đã ký số; gửi trùng yêu cầu ký
 *   - người khác Viện trưởng ký được, hoặc xem được yêu cầu ký của người khác
 *   - tên tài liệu gửi MySign có dấu / quá dài (MySign từ chối)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');
const { dungMySignGiaLap } = require('./helpers/mysignGiaLap');
const Pades = require('../services/mysign/pades');
const { chuoiHienThi, taoMySign } = require('../services/mysign/client');

const ADMIN = 1;
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

async function nop(uid, id, ten) {
  assert.equal((await ung.json(uid, 'PUT', `/bao-cao/${id}/du-lieu`, { du_lieu: DU_LIEU(ten) })).s, 200);
  const r = await ung.json(uid, 'POST', `/bao-cao/${id}/nop`, {});
  assert.equal(r.s, 200, JSON.stringify(r.d));
}

/** Đợt hai phòng A, B đã nộp và đã trình Viện trưởng. */
async function taoDot(tieuDe) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA, ID.phongB] });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao.map((b) => [b.phong_id, b.id]));
  await nop(TP_A, bc[ID.phongA], 'A');
  await nop(TP_B, bc[ID.phongB], 'B');
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/trinh-vien-truong`, {})).s, 200);
  return { id: r.d.id, a: bc[ID.phongA], b: bc[ID.phongB] };
}

const cuaVT = async (dotId, id) => (await ung.json(VIEN_TRUONG, 'GET', `/dot/${dotId}/vien-truong`)).d.bao_cao.find((b) => b.id === id);
async function guiKy(dotId, ids, them = {}) {
  const ds = [];
  for (const id of ids) ds.push({ id, nop_luc: (await cuaVT(dotId, id)).nop_luc });
  return ung.json(VIEN_TRUONG, 'POST', `/dot/${dotId}/ky-so`, { bao_cao: ds, ...them });
}
const hoi = (uid, gdId) => ung.json(uid, 'GET', '/api/mysign/giao-dich/' + gdId);
const lichSu = (id) => ung.db.prepare('SELECT hanh_dong, ghi_chu FROM bcp_lich_su WHERE bao_cao_id = ? ORDER BY id').all(id).map((r) => r.hanh_dong);

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
});

test.after(async () => {
  if (ung) await ung.dung();
  if (gl) await gl.dung();
});

// ══ Logic thuần ═════════════════════════════════════════════════════════════════

test('chuoiHienThi: tên gửi MySign không dấu, chỉ ký tự cho phép, base64 dưới 100 ký tự', () => {
  const t = Buffer.from(chuoiHienThi('Báo cáo Phòng Đào tạo — Quý 3/2026 (bản #2)'), 'base64').toString('utf8');
  assert.equal(t, 'Bao cao Phong Dao tao - Quy 3 2026 ban 2');
  const dai = chuoiHienThi('Đ'.repeat(500));
  assert.ok(dai.length < 100);
  assert.match(Buffer.from(dai, 'base64').toString(), /^[A-Za-z0-9 _-]+$/);
});

test('MySign chưa cấu hình (thiếu client_id/secret/profile): coi như tắt, không gọi mạng', async () => {
  const ms = taoMySign({ cauHinh: { baseUrl: gl.base, clientId: '', clientSecret: '', profileId: '' } });
  assert.equal(ms.daCauHinh(), false);
  await assert.rejects(() => ms.chungThu('VT_MYSIGN_001'), /chưa được cấu hình/);
});

// ══ Liên kết tài khoản ══════════════════════════════════════════════════════════

test('liên kết tài khoản: mã sai / không tồn tại bị từ chối, mã đúng lưu kèm chứng thư; số điện thoại bị che', async () => {
  let r = await ung.json(VIEN_TRUONG, 'GET', '/api/mysign/tai-khoan');
  assert.equal(r.s, 200);
  assert.equal(r.d.da_cau_hinh, true);
  assert.equal(r.d.tai_khoan, null);
  assert.equal((await ung.json(VIEN_TRUONG, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'có dấu cách' })).s, 400);
  r = await ung.json(VIEN_TRUONG, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'KHONG_TON_TAI' });
  assert.equal(r.s, 400);
  assert.match(r.d.message, /Không tìm thấy tài khoản MySign/);
  assert.equal(ung.kySo.taiKhoan(VIEN_TRUONG), null, 'không lưu khi MySign không xác nhận');
  // Chưa liên kết mà bấm ký → 409 kèm mã để giao diện mở hộp liên kết.
  const d = await taoDot('Đợt chưa liên kết');
  r = await guiKy(d.id, [d.a]);
  assert.equal(r.s, 409);
  assert.equal(r.d.ma, 'chua_lien_ket');

  r = await ung.json(VIEN_TRUONG, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'VT_MYSIGN_001' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.tai_khoan.mysign_user_id, 'VT_MYSIGN_001');
  assert.match(r.d.tai_khoan.chu_the, /PHAM VIEN TRUONG/);
  assert.equal(r.d.tai_khoan.so_dien_thoai, '*******678');
  assert.ok(!JSON.stringify(r.d).includes('bi-mat-test'), 'không lộ client_secret');
});

// ══ Ký số ═══════════════════════════════════════════════════════════════════════

test('chỉ Viện trưởng ký được; báo cáo phải thuộc đợt, đúng bản đang có', async () => {
  const d = await taoDot('Đợt quyền ký');
  for (const uid of [ADMIN, QUAN_LY, TP_A]) {
    const r = await ung.json(uid, 'POST', `/dot/${d.id}/ky-so`, { bao_cao: [{ id: d.a, nop_luc: 'x' }] });
    assert.equal(r.s, 403, 'user ' + uid);
  }
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/dot/${d.id}/ky-so`, { bao_cao: [] })).s, 400);
  const r = await ung.json(VIEN_TRUONG, 'POST', `/dot/${d.id}/ky-so`, { bao_cao: [{ id: d.a, nop_luc: '2000-01-01T00:00:00.000Z' }] });
  assert.equal(r.s, 409, 'nop_luc lệch → không ký bản chưa đọc');
  const khac = await taoDot('Đợt khác');
  const nopKhac = (await cuaVT(khac.id, khac.a)).nop_luc;
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/dot/${d.id}/ky-so`, { bao_cao: [{ id: khac.a, nop_luc: nopKhac }] })).s, 404);
  assert.equal(gl.yeuCau.length, 0, 'chưa có yêu cầu nào tới MySign');
});

test('ký 2 báo cáo một lần: chờ → chưa ghi duyệt; đồng ý → ghi duyệt + ký số, PDF hợp lệ, tải được', async () => {
  const d = await taoDot('Đợt ký hai báo cáo');
  gl.cheDo = 'cho';
  const r = await guiKy(d.id, [d.a, d.b], { ghi_chu: 'Đồng ý.' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  const g = r.d.giao_dich;
  assert.equal(g.trang_thai, 'cho_xac_nhan');
  assert.equal(g.tai_lieu.length, 2);

  // MySign nhận MỘT yêu cầu, 2 mã băm, tên tài liệu không dấu.
  const yc = gl.yeuCau[gl.yeuCau.length - 1];
  assert.equal(yc.numSignatures, 2);
  assert.equal(yc.async, 2);
  assert.equal(yc.hashAlgo, '2.16.840.1.101.3.4.2.1');
  for (const doc of yc.documents) assert.match(Buffer.from(doc.document_name, 'base64').toString(), /^[A-Za-z0-9 _-]+$/);
  assert.match(Buffer.from(yc.documents[0].document_name, 'base64').toString(), /Phong Hanh chinh/);

  // Đang chờ: chưa có "duyệt", không quyết định kiểu thường được, không gửi trùng.
  let bc = await cuaVT(d.id, d.a);
  assert.equal(bc.ky_so.trang_thai, 'dang_cho');
  assert.equal(bc.vt_trang_thai, 'cho_quyet_dinh');
  assert.equal((await hoi(VIEN_TRUONG, g.id)).d.trang_thai, 'cho_xac_nhan');
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${d.a}/quyet-dinh`, { quyet_dinh: 'duyet', nop_luc: bc.nop_luc })).s, 409);
  assert.equal((await guiKy(d.id, [d.a])).s, 409);
  assert.ok(!lichSu(d.a).includes('vt_duyet'));
  // Người khác không xem được yêu cầu ký của Viện trưởng.
  assert.equal((await hoi(QUAN_LY, g.id)).s, 404);

  gl.cheDo = 'dong_y';
  const xong = await hoi(VIEN_TRUONG, g.id);
  assert.equal(xong.d.trang_thai, 'thanh_cong', JSON.stringify(xong.d));
  assert.deepEqual(xong.d.tai_lieu.map((t) => t.trang_thai), ['da_ky', 'da_ky']);
  // Hỏi lại lần nữa không ghi trùng lịch sử.
  await hoi(VIEN_TRUONG, g.id);

  for (const id of [d.a, d.b]) {
    assert.deepEqual(lichSu(id).filter((x) => x.startsWith('vt_')), ['vt_duyet', 'vt_ky_so']);
    bc = await cuaVT(d.id, id);
    assert.equal(bc.vt_trang_thai, 'duyet');
    assert.equal(bc.vien_truong.ghi_chu, 'Đồng ý.');
    assert.equal(bc.ky_so.trang_thai, 'da_ky');
  }

  // Phòng tải được PDF đã ký của báo cáo mình; PDF hợp lệ và đúng chứng thư.
  const res = await ung.goi(TP_A, 'GET', `/bao-cao/${d.a}/ban-ky-so`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const kt = Pades.kiemTra(pdf);
  assert.equal(kt.hopLe, true, JSON.stringify(kt));
  assert.match(kt.chu_the, /PHAM VIEN TRUONG/);
  assert.match(pdf.toString('latin1'), /\/SubFilter \/ETSI\.CAdES\.detached/);
  // Sửa một byte nội dung → không còn hợp lệ.
  const hong = Buffer.from(pdf);
  hong[pdf.length - 300] ^= 0x01;
  assert.equal(Pades.kiemTra(hong).hopLe, false);
  // Phòng B không tải được báo cáo của phòng A.
  assert.equal((await ung.goi(TP_B, 'GET', `/bao-cao/${d.a}/ban-ky-so`)).status, 404);
  // Trang báo cáo của phòng thấy trạng thái đã ký.
  assert.equal((await ung.json(TP_A, 'GET', `/bao-cao/${d.a}`)).d.ky_so.trang_thai, 'da_ky');

  // Đã ký số: không đổi quyết định được nữa, không ký lại.
  const nopA = (await cuaVT(d.id, d.a)).nop_luc;
  const qd = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${d.a}/quyet-dinh`, { quyet_dinh: 'khong_duyet', ghi_chu: 'Đổi ý', nop_luc: nopA });
  assert.equal(qd.s, 409);
  assert.match(qd.d.message, /đã được ký số/);
  assert.equal((await guiKy(d.id, [d.a])).s, 409);
  // Ký xong hai báo cáo đang chờ cuối cùng của đợt → MỘT thư tổng kết cho người quản lý.
  for (let i = 0; i < 50 && !ung.thu.some((t) => t.subject === '[Viện trưởng đã xử lý] Đợt ký hai báo cáo'); i++) await new Promise((x) => setTimeout(x, 20));
  const tongKet = ung.thu.filter((t) => t.subject === '[Viện trưởng đã xử lý] Đợt ký hai báo cáo');
  assert.equal(tongKet.length, 1);
  assert.match(tongKet[0].html || tongKet[0].text || '', /duyệt 2/);
});

test('từ chối / hết hạn trên MySign: báo cáo giữ nguyên, ký lại được', async () => {
  const d = await taoDot('Đợt từ chối');
  for (const cheDo of ['tu_choi', 'het_han']) {
    gl.cheDo = 'cho';
    const r = await guiKy(d.id, [d.a]);
    assert.equal(r.s, 200, JSON.stringify(r.d));
    gl.cheDo = cheDo;
    const g = (await hoi(VIEN_TRUONG, r.d.giao_dich.id)).d;
    assert.equal(g.trang_thai, cheDo);
    assert.ok(g.thong_diep);
    const bc = await cuaVT(d.id, d.a);
    assert.equal(bc.ky_so, null);
    assert.equal(bc.vt_trang_thai, 'cho_quyet_dinh');
    assert.ok(!lichSu(d.a).includes('vt_duyet'));
    assert.equal((await ung.goi(TP_A, 'GET', `/bao-cao/${d.a}/ban-ky-so`)).status, 404);
  }
  // Sau khi từ chối, quyết định kiểu thường vẫn dùng được.
  const bc = await cuaVT(d.id, d.a);
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${d.a}/quyet-dinh`, { quyet_dinh: 'khong_duyet', ghi_chu: 'Thiếu số liệu', nop_luc: bc.nop_luc })).s, 200);
});

test('phòng nộp lại trong lúc chờ ký: chữ ký KHÔNG gán cho bản mới', async () => {
  const d = await taoDot('Đợt nộp lại khi chờ ký');
  gl.cheDo = 'cho';
  const r = await guiKy(d.id, [d.a]);
  assert.equal(r.s, 200);
  // Người quản lý yêu cầu sửa, phòng sửa và nộp lại trong lúc Viện trưởng chưa xác nhận.
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${d.a}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung' })).s, 200);
  await nop(TP_A, d.a, 'A sửa');
  gl.cheDo = 'dong_y';
  const g = (await hoi(VIEN_TRUONG, r.d.giao_dich.id)).d;
  assert.equal(g.trang_thai, 'thanh_cong');
  assert.equal(g.tai_lieu[0].trang_thai, 'huy', 'tài liệu đã ký nhưng không còn hiệu lực nghiệp vụ');
  const bc = await cuaVT(d.id, d.a);
  assert.equal(bc.vt_trang_thai, 'cho_quyet_dinh', 'bản mới chưa được duyệt');
  assert.equal(bc.ky_so, null);
  assert.ok(!lichSu(d.a).includes('vt_ky_so'));
});

test('bỏ liên kết: không được khi đang chờ ký; được khi không còn yêu cầu chờ', async () => {
  const d = await taoDot('Đợt bỏ liên kết');
  gl.cheDo = 'cho';
  const r = await guiKy(d.id, [d.a]);
  assert.equal((await ung.json(VIEN_TRUONG, 'DELETE', '/api/mysign/tai-khoan')).s, 400);
  gl.cheDo = 'tu_choi';
  await hoi(VIEN_TRUONG, r.d.giao_dich.id);
  assert.equal((await ung.json(VIEN_TRUONG, 'DELETE', '/api/mysign/tai-khoan')).s, 200);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/api/mysign/tai-khoan')).d.tai_khoan, null);
  assert.equal((await ung.json(VIEN_TRUONG, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'VT_MYSIGN_001' })).s, 200);
});

test('chữ ký MySign trả về sai (không khớp chứng thư): không tạo PDF, không ghi duyệt', async () => {
  const d = await taoDot('Đợt chữ ký sai');
  gl.cheDo = 'cho';
  const r = await guiKy(d.id, [d.b]);
  assert.equal(r.s, 200);
  // Đổi khóa ký của MySign giả: chữ ký trả về không khớp chứng thư đã nhúng.
  const cu = gl.khoa;
  gl.khoa = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
  gl.cheDo = 'dong_y';
  const g = (await hoi(VIEN_TRUONG, r.d.giao_dich.id)).d;
  gl.khoa = cu;
  assert.equal(g.trang_thai, 'loi');
  assert.match(g.thong_diep, /không khớp/);
  assert.ok(!lichSu(d.b).includes('vt_duyet'));
});
