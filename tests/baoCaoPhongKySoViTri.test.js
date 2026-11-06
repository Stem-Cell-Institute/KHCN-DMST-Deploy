/**
 * tests/baoCaoPhongKySoViTri.test.js
 * Viện trưởng tự chọn vị trí khung chữ ký số trên PDF (xem trước → kéo khung → ký): máy chủ dựng bản xem trước, kiểm vị trí do client gửi,
 * vẽ khung và đặt ô chữ ký PDF đúng chỗ đã chọn, và nhớ vị trí lần trước. Chạy trên router thật với MySign giả lập.
 *
 * Trọng tâm: vị trí bậy (NaN, âm, ngoài trang, quá nhỏ, trang không có) không được tạo yêu cầu ký; chữ ký vẫn hợp lệ khi khung bị dời;
 * ô chữ ký trong PDF nằm đúng toạ độ đã chọn; không ai ngoài Viện trưởng xem được bản xem trước.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');
const { dungMySignGiaLap } = require('./helpers/mysignGiaLap');
const Pades = require('../services/mysign/pades');

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
  assert.equal((await ung.json(uid, 'POST', `/bao-cao/${id}/nop`, {})).s, 200);
}

async function taoDot(tieuDe, { trinh = true, nopB = true } = {}) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA, ID.phongB] });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao.map((b) => [b.phong_id, b.id]));
  await nop(TP_A, bc[ID.phongA], 'A');
  if (nopB) await nop(TP_B, bc[ID.phongB], 'B');
  if (trinh) assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/trinh-vien-truong`, {})).s, 200);
  return { id: r.d.id, a: bc[ID.phongA], b: bc[ID.phongB] };
}

const cuaVT = async (dotId, id) => (await ung.json(VIEN_TRUONG, 'GET', `/dot/${dotId}/vien-truong`)).d.bao_cao.find((b) => b.id === id);
const hoi = (uid, gdId) => ung.json(uid, 'GET', '/api/mysign/giao-dich/' + gdId);
const soYeuCau = () => gl.yeuCau.length;

async function guiKy(dotId, muc) {
  const ds = [];
  for (const m of muc) ds.push({ id: m.id, nop_luc: (await cuaVT(dotId, m.id)).nop_luc, vi_tri: m.vi_tri });
  return ung.json(VIEN_TRUONG, 'POST', `/dot/${dotId}/ky-so`, { bao_cao: ds });
}

/** Xem trước: {s, pdf, meta}. */
async function xemTruoc(uid, id) {
  const res = await ung.goi(uid, 'GET', `/bao-cao/${id}/ky-so/xem-truoc`);
  const buf = Buffer.from(await res.arrayBuffer());
  let meta = null;
  const h = res.headers.get('x-ky-so-meta');
  if (h) meta = JSON.parse(h);
  return { s: res.status, pdf: buf, meta, headers: res.headers };
}

/** Các ô chữ ký (/FT /Sig) của PDF: [{rect:[x1,y1,x2,y2]}]. */
function oChuKy(pdf) {
  const s = pdf.toString('latin1');
  const kq = [];
  for (const m of s.matchAll(/<<[^<>]*?\/FT \/Sig[^<>]*?>>/g)) {
    const r = /\/Rect \[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(m[0]);
    if (r) kq.push({ rect: r.slice(1).map(Number) });
  }
  return kq;
}

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

test('xem trước: chỉ Viện trưởng; đợt chưa trình / báo cáo chưa nộp thì 409; trả PDF thật kèm thông tin trang, chưa có chữ ký', async () => {
  const d = await taoDot('Đợt xem trước', { nopB: false });
  for (const uid of [ADMIN, QUAN_LY, TP_A, TP_B]) assert.equal((await xemTruoc(uid, d.a)).s, 403, 'user ' + uid);
  assert.equal((await ung.goi(null, 'GET', `/bao-cao/${d.a}/ky-so/xem-truoc`)).status, 401);
  assert.equal((await xemTruoc(VIEN_TRUONG, d.b)).s, 409, 'phòng B chưa nộp');
  assert.equal((await xemTruoc(VIEN_TRUONG, 999999)).s, 404);
  const chuaTrinh = await taoDot('Đợt chưa trình', { trinh: false });
  assert.equal((await xemTruoc(VIEN_TRUONG, chuaTrinh.a)).s, 404, 'đợt chưa trình: Viện trưởng chưa thấy báo cáo');

  const x = await xemTruoc(VIEN_TRUONG, d.a);
  assert.equal(x.s, 200);
  assert.equal(x.headers.get('content-type'), 'application/pdf');
  assert.equal(x.headers.get('cache-control'), 'no-store');
  assert.equal(x.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(!x.pdf.toString('latin1').includes('/ByteRange'), 'bản xem trước chưa chừa chữ ký');
  assert.ok(x.meta.so_trang >= 1);
  assert.ok(Math.abs(x.meta.kho[0] - 595.28) < 1 && Math.abs(x.meta.kho[1] - 841.89) < 1, 'khổ A4');
  assert.ok(x.meta.mac_dinh && x.meta.mac_dinh.trang === x.meta.so_trang - 1, 'vị trí mặc định ở trang cuối');
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(x.meta.mac_dinh[k] > 0 && x.meta.mac_dinh[k] < 1);
  assert.equal(x.meta.gan_nhat, null, 'chưa ký lần nào');
  assert.equal(typeof x.meta.nop_luc, 'string');
  assert.ok(/^[\x20-\x7e]*$/.test(x.headers.get('x-ky-so-meta')), 'header chỉ gồm ASCII (dấu tiếng Việt được escape)');
});

test('ký với khung do Viện trưởng đặt: ô chữ ký PDF nằm đúng toạ độ đã chọn, chữ ký vẫn hợp lệ', async () => {
  const d = await taoDot('Đợt đặt khung');
  const x = await xemTruoc(VIEN_TRUONG, d.a);
  const vt = { trang: 0, x: 0.1, y: 0.05, w: 0.5, h: 0.12 }; // góc trên-trái trang đầu: chỗ khác hẳn mặc định
  const r = await guiKy(d.id, [{ id: d.a, vi_tri: vt }]);
  assert.equal(r.s, 200, JSON.stringify(r.d));
  gl.cheDo = 'dong_y';
  const xong = await hoi(VIEN_TRUONG, r.d.giao_dich.id);
  assert.equal(xong.d.trang_thai, 'thanh_cong', JSON.stringify(xong.d));

  const res = await ung.goi(TP_A, 'GET', `/bao-cao/${d.a}/ban-ky-so`);
  const pdf = Buffer.from(await res.arrayBuffer());
  const kt = Pades.kiemTra(pdf);
  assert.equal(kt.hopLe, true, JSON.stringify(kt));
  const o = oChuKy(pdf);
  assert.equal(o.length, 1);
  const [W, H] = x.meta.kho;
  const mong = [vt.x * W, H - (vt.y + vt.h) * H, (vt.x + vt.w) * W, H - vt.y * H]; // toạ độ PDF: gốc dưới-trái
  o[0].rect.forEach((v, i) => assert.ok(Math.abs(v - mong[i]) < 0.6, `Rect[${i}] = ${v}, mong ${mong[i]}`));
  // Vị trí mặc định cũ (cuối trang) không còn là chỗ của ô chữ ký.
  assert.ok(Math.abs(o[0].rect[1] - (H - (x.meta.mac_dinh.y + x.meta.mac_dinh.h) * H)) > 20);
  // Số trang của báo cáo đã ký bằng số trang xem trước (bố cục không đổi giữa xem trước và bản ký).
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length, x.meta.so_trang);
});

test('vị trí bậy bị từ chối (400) và KHÔNG tạo yêu cầu ký nào gửi sang MySign', async () => {
  const d = await taoDot('Đợt vị trí bậy');
  const truoc = soYeuCau();
  const ok = { trang: 0, x: 0.1, y: 0.1, w: 0.4, h: 0.1 };
  const bay = [
    { ...ok, x: 'abc' }, { ...ok, w: null }, { ...ok, x: Number.NaN }, { ...ok, trang: 1.5 }, { ...ok, trang: -1 }, { ...ok, trang: '0' },
    { ...ok, x: -0.1 }, { ...ok, y: -0.01 }, { ...ok, x: 0.8 }, { ...ok, y: 0.95 }, // tràn ra ngoài trang
    { ...ok, w: 0.05 }, { ...ok, h: 0.01 }, // quá nhỏ để đọc
    { ...ok, w: 2 }, 'khung', 5,
  ];
  for (const v of bay) {
    const r = await guiKy(d.id, [{ id: d.a, vi_tri: v }]);
    assert.equal(r.s, 400, JSON.stringify(v) + ' → ' + JSON.stringify(r.d));
  }
  // Trang không có trong báo cáo: dựng PDF mới biết số trang nên báo lỗi 400 chứ không phải 500.
  const r = await guiKy(d.id, [{ id: d.a, vi_tri: { ...ok, trang: 40 } }]);
  assert.equal(r.s, 400, JSON.stringify(r.d));
  assert.match(r.d.message, /không có trong báo cáo/);
  assert.equal(soYeuCau(), truoc, 'không yêu cầu ký nào tới MySign');
  const bc = await cuaVT(d.id, d.a);
  assert.equal(bc.vt_trang_thai, 'cho_quyet_dinh');
  assert.ok(!bc.ky_so, 'không để lại yêu cầu ký đang chờ');
});

test('nhớ vị trí lần trước: lần sau khung mở sẵn ở đó; đặt ở trang cuối thì ghi nhớ là "trang cuối"', async () => {
  const d = await taoDot('Đợt nhớ vị trí');
  const x0 = await xemTruoc(VIEN_TRUONG, d.a);
  const cuoi = x0.meta.so_trang - 1;
  const vt = { trang: cuoi, x: 0.55, y: 0.7, w: 0.3, h: 0.08 };
  const r = await guiKy(d.id, [{ id: d.a, vi_tri: vt }]);
  assert.equal(r.s, 200, JSON.stringify(r.d));
  gl.cheDo = 'tu_choi'; // dù bị từ chối trên điện thoại, vị trí người ký đã chọn vẫn được nhớ cho lần thử lại
  await hoi(VIEN_TRUONG, r.d.giao_dich.id);
  const x1 = await xemTruoc(VIEN_TRUONG, d.a);
  assert.deepEqual({ ...x1.meta.gan_nhat }, { trang: cuoi, trang_cuoi: true, x: 0.55, y: 0.7, w: 0.3, h: 0.08 });
  // Người khác (admin cũng không xem trước được) không thấy vị trí này: vị trí lưu theo từng người ký.
  assert.equal(ung.kySo.viTriGanNhat(ADMIN, 'bao_cao_phong'), null);
  assert.deepEqual(ung.kySo.viTriGanNhat(VIEN_TRUONG, 'bao_cao_phong'), { trang: cuoi, trang_cuoi: true, x: 0.55, y: 0.7, w: 0.3, h: 0.08 });
});

test('không gửi vi_tri thì khung ở vị trí mặc định của biểu mẫu như trước, và không đổi vị trí đã nhớ', async () => {
  const d = await taoDot('Đợt mặc định');
  const truoc = ung.kySo.viTriGanNhat(VIEN_TRUONG, 'bao_cao_phong');
  const x = await xemTruoc(VIEN_TRUONG, d.a);
  const r = await guiKy(d.id, [{ id: d.a }]);
  assert.equal(r.s, 200, JSON.stringify(r.d));
  gl.cheDo = 'dong_y';
  assert.equal((await hoi(VIEN_TRUONG, r.d.giao_dich.id)).d.trang_thai, 'thanh_cong');
  const pdf = Buffer.from(await (await ung.goi(TP_A, 'GET', `/bao-cao/${d.a}/ban-ky-so`)).arrayBuffer());
  assert.equal(Pades.kiemTra(pdf).hopLe, true);
  const [W, H] = x.meta.kho;
  const md = x.meta.mac_dinh;
  const o = oChuKy(pdf)[0].rect;
  assert.ok(Math.abs(o[0] - md.x * W) < 0.6 && Math.abs(o[3] - (H - md.y * H)) < 0.6, 'khung ở vị trí mặc định');
  assert.deepEqual(ung.kySo.viTriGanNhat(VIEN_TRUONG, 'bao_cao_phong'), truoc);
});

test('ký nhiều báo cáo, mỗi báo cáo một vị trí riêng: PDF nào ô chữ ký ở chỗ của PDF đó', async () => {
  const d = await taoDot('Đợt nhiều vị trí');
  const va = { trang: 0, x: 0.05, y: 0.05, w: 0.3, h: 0.07 };
  const vb = { trang: 0, x: 0.6, y: 0.4, w: 0.35, h: 0.09 };
  const r = await guiKy(d.id, [{ id: d.a, vi_tri: va }, { id: d.b, vi_tri: vb }]);
  assert.equal(r.s, 200, JSON.stringify(r.d));
  gl.cheDo = 'dong_y';
  assert.equal((await hoi(VIEN_TRUONG, r.d.giao_dich.id)).d.trang_thai, 'thanh_cong');
  for (const [id, v, uid] of [[d.a, va, TP_A], [d.b, vb, TP_B]]) {
    const pdf = Buffer.from(await (await ung.goi(uid, 'GET', `/bao-cao/${id}/ban-ky-so`)).arrayBuffer());
    assert.equal(Pades.kiemTra(pdf).hopLe, true);
    const o = oChuKy(pdf)[0].rect;
    assert.ok(Math.abs(o[0] - v.x * 595.28) < 0.7, `x của báo cáo ${id}`);
    assert.ok(Math.abs(o[2] - (v.x + v.w) * 595.28) < 0.7, `rộng của báo cáo ${id}`);
  }
});

// ══ Trang thử ký số (PDF mẫu, chỉ quản trị viên) ═══════════════════════════════

test('trang thử: chỉ quản trị viên; Viện trưởng, quản lý, trưởng phòng đều 403, chưa đăng nhập 401', async () => {
  for (const uid of [VIEN_TRUONG, QUAN_LY, TP_A]) {
    assert.equal((await ung.goi(uid, 'GET', '/api/mysign/thu/xem-truoc')).status, 403, 'user ' + uid);
    assert.equal((await ung.json(uid, 'POST', '/api/mysign/thu/ky', {})).s, 403);
    assert.equal((await ung.goi(uid, 'GET', '/api/mysign/thu/ban-ky/1')).status, 403);
    assert.equal((await ung.goi(uid, 'GET', '/api/mysign/thu/kiem-tra/1')).status, 403);
  }
  assert.equal((await ung.goi(null, 'GET', '/api/mysign/thu/xem-truoc')).status, 401);
});

test('trang thử: quản trị viên ký PDF mẫu bằng tài khoản MySign của mình, khung đúng chỗ đã chọn, kiểm chữ ký hợp lệ, tải về được', async () => {
  gl.nguoiDung.add('ADMIN_MYSIGN');
  assert.equal((await ung.json(ADMIN, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'ADMIN_MYSIGN' })).s, 200);

  const res = await ung.goi(ADMIN, 'GET', '/api/mysign/thu/xem-truoc');
  assert.equal(res.status, 200);
  const meta = JSON.parse(res.headers.get('x-ky-so-meta'));
  const xt = Buffer.from(await res.arrayBuffer());
  assert.equal(meta.so_trang, 3);
  assert.equal(meta.gan_nhat, null);
  assert.ok(!xt.toString('latin1').includes('/ByteRange'), 'bản xem trước chưa có chữ ký');

  // vị trí bậy → 400, không gửi MySign
  const truoc = soYeuCau();
  for (const v of [{ trang: 0, x: 0.9, y: 0.1, w: 0.3, h: 0.1 }, { trang: 3, x: 0.1, y: 0.1, w: 0.3, h: 0.1 }, { trang: 0, x: 0.1, y: 0.1, w: 0.01, h: 0.1 }, 'x']) {
    assert.equal((await ung.json(ADMIN, 'POST', '/api/mysign/thu/ky', { vi_tri: v })).s, 400, JSON.stringify(v));
  }
  assert.equal(soYeuCau(), truoc);

  const vt = { trang: 1, x: 0.2, y: 0.3, w: 0.4, h: 0.1 };
  const r = await ung.json(ADMIN, 'POST', '/api/mysign/thu/ky', { vi_tri: vt });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  const gd = r.d.giao_dich.id;
  assert.equal((await ung.goi(ADMIN, 'GET', `/api/mysign/thu/ban-ky/${gd}`)).status, 404, 'chưa ký xong thì chưa có bản đã ký');
  gl.cheDo = 'dong_y';
  assert.equal((await hoi(ADMIN, gd)).d.trang_thai, 'thanh_cong');

  const tai = await ung.goi(ADMIN, 'GET', `/api/mysign/thu/ban-ky/${gd}`);
  assert.equal(tai.status, 200);
  assert.match(tai.headers.get('content-disposition'), /^attachment/);
  const pdf = Buffer.from(await tai.arrayBuffer());
  assert.equal(Pades.kiemTra(pdf).hopLe, true);
  const o = oChuKy(pdf)[0].rect;
  const [W, H] = meta.kho;
  assert.ok(Math.abs(o[0] - vt.x * W) < 0.7 && Math.abs(o[3] - (H - vt.y * H)) < 0.7, 'ô chữ ký đúng chỗ đã chọn');
  assert.equal((await ung.goi(ADMIN, 'GET', `/api/mysign/thu/ban-ky/${gd}?xem=1`)).headers.get('content-disposition').slice(0, 6), 'inline');

  const kt = await ung.json(ADMIN, 'GET', `/api/mysign/thu/kiem-tra/${gd}`);
  assert.equal(kt.s, 200);
  assert.equal(kt.d.hopLe, true);
  assert.match(kt.d.chu_the, /PHAM VIEN TRUONG/);
  // lần sau khung mở sẵn ở vị trí này
  const x2 = JSON.parse((await ung.goi(ADMIN, 'GET', '/api/mysign/thu/xem-truoc')).headers.get('x-ky-so-meta'));
  assert.deepEqual({ ...x2.gan_nhat }, { trang: 1, trang_cuoi: false, x: 0.2, y: 0.3, w: 0.4, h: 0.1 });
  // giao dịch không tồn tại / id sai
  assert.equal((await ung.goi(ADMIN, 'GET', '/api/mysign/thu/ban-ky/999999')).status, 404);
  assert.equal((await ung.goi(ADMIN, 'GET', '/api/mysign/thu/kiem-tra/abc')).status, 404);
});
