/**
 * tests/baoCaoPhongKySoKhung.test.js
 * Nội dung NHÌN THẤY của khung chữ ký số: người ký bật/tắt từng dòng (họ tên, tổ chức, số chứng thư, thời gian, lý do, nơi ký),
 * tải hình chữ ký tay; khung lấy tên / tổ chức / số seri từ CHỨNG THƯ, nhớ lựa chọn lần trước.
 * Chạy trên router thật với MySign giả lập; không cần khoá bí mật nào.
 *
 * Trọng tâm: lựa chọn bậy bị từ chối trước khi gửi MySign; ảnh giả mạo (không phải PNG/JPEG, quá lớn, xen kẽ) không được lưu;
 * ảnh chỉ của chính chủ; khung thấp quá không chứa nổi các dòng đã chọn thì báo lỗi rõ chứ không vẽ tràn; chữ ký vẫn hợp lệ.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');
const { dungMySignGiaLap } = require('./helpers/mysignGiaLap');
const Pades = require('../services/mysign/pades');
const KhungKy = require('../services/mysign/khungKy');

const ADMIN = 1;
const QUAN_LY = 2;
const VIEN_TRUONG = 3;
const TP_A = 4;

// ── PNG tối thiểu tự dựng (không cần thư viện ảnh) ───────────────────────────
const BANG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = BANG_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function khoiPng(loai, data) {
  const dai = Buffer.alloc(4);
  dai.writeUInt32BE(data.length);
  const phan = Buffer.concat([Buffer.from(loai, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(phan));
  return Buffer.concat([dai, phan, crc]);
}
/** PNG RGBA w×h, nét ngang xanh trên nền trong suốt. interlace=1 chỉ đổi cờ trong IHDR (để thử bị từ chối). */
function taoPng(w, h, { xenKe = 0 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8 bit
  ihdr[9] = 6; // RGBA
  ihdr[12] = xenKe;
  const dong = Buffer.alloc(1 + w * 4);
  const anh = [];
  for (let y = 0; y < h; y++) {
    const d = Buffer.from(dong);
    if (y % 5 === 0) for (let x = 0; x < w; x++) { d[1 + x * 4] = 20; d[2 + x * 4] = 60; d[3 + x * 4] = 160; d[4 + x * 4] = 255; }
    anh.push(d);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    khoiPng('IHDR', ihdr), khoiPng('IDAT', zlib.deflateSync(Buffer.concat(anh))), khoiPng('IEND', Buffer.alloc(0)),
  ]);
}

let ung;
let gl;
const ID = {};

const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten, ky_tu_ngay: '2026-09-04', ky_den_ngay: '2026-10-04', tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm của ' + ten, muc_do: 100 } }],
});

async function taoBaoCao(tieuDe) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const id = (await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao[0].id;
  assert.equal((await ung.json(TP_A, 'PUT', `/bao-cao/${id}/du-lieu`, { du_lieu: DU_LIEU('A') })).s, 200);
  assert.equal((await ung.json(TP_A, 'POST', `/bao-cao/${id}/nop`, {})).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/trinh-vien-truong`, {})).s, 200);
  return { dot: r.d.id, id };
}

const nopLuc = async (dot, id) => (await ung.json(VIEN_TRUONG, 'GET', `/dot/${dot}/vien-truong`)).d.bao_cao.find((b) => b.id === id).nop_luc;

async function ky(bc, thanPhu = {}) {
  return ung.json(VIEN_TRUONG, 'POST', `/dot/${bc.dot}/ky-so`, { bao_cao: [{ id: bc.id, nop_luc: await nopLuc(bc.dot, bc.id), ...(thanPhu.vi_tri ? { vi_tri: thanPhu.vi_tri } : {}) }], ...(thanPhu.khung !== undefined ? { khung: thanPhu.khung } : {}) });
}

async function kyXong(bc, thanPhu) {
  gl.cheDo = 'cho';
  const r = await ky(bc, thanPhu);
  assert.equal(r.s, 200, JSON.stringify(r.d));
  gl.cheDo = 'dong_y';
  const x = await ung.json(VIEN_TRUONG, 'GET', '/api/mysign/giao-dich/' + r.d.giao_dich.id);
  assert.equal(x.d.trang_thai, 'thanh_cong', JSON.stringify(x.d));
  const res = await ung.goi(TP_A, 'GET', `/bao-cao/${bc.id}/ban-ky-so`);
  return Buffer.from(await res.arrayBuffer());
}

/** Bắt các lần dựng dòng chữ khung (kèm kết quả) trong lúc chạy fn. */
async function batDong(fn) {
  const goc = KhungKy.dungDong;
  const lan = [];
  KhungKy.dungDong = (p) => {
    const kq = goc(p);
    lan.push({ p, dong: kq });
    return kq;
  };
  try {
    await fn();
  } finally {
    KhungKy.dungDong = goc;
  }
  return lan;
}

async function xemTruoc(bc) {
  const res = await ung.goi(VIEN_TRUONG, 'GET', `/bao-cao/${bc.id}/ky-so/xem-truoc`);
  await res.arrayBuffer();
  return JSON.parse(res.headers.get('x-ky-so-meta'));
}

const guiAnh = (uid, buf, kieu = 'image/png') =>
  fetch(ung.base + '/api/mysign/hinh-ky', { method: 'POST', headers: { 'x-nguoi-dung': String(uid), 'Content-Type': kieu }, body: buf }).then(async (r) => ({ s: r.status, d: await r.json().catch(() => null) }));

test.before(async () => {
  gl = await dungMySignGiaLap();
  ung = await dungUngDung({ mysign: gl.cauHinh });
  const { db } = ung;
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng Hành chính')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'truong_phong')").run(TP_A, ID.phongA);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
  const r = await ung.json(VIEN_TRUONG, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'VT_MYSIGN_001' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
});

test.after(async () => {
  if (ung) await ung.dung();
  if (gl) await gl.dung();
});

// ── Hàm thuần ────────────────────────────────────────────────────────────────

test('kiemTuyChon: thiếu thì dùng mặc định; ghi đè từng mục; giá trị không phải true/false bị từ chối', () => {
  assert.deepEqual(KhungKy.kiemTuyChon(undefined).tuy_chon, KhungKy.MAC_DINH);
  const kq = KhungKy.kiemTuyChon({ to_chuc: true, thoi_gian: false });
  assert.equal(kq.tuy_chon.to_chuc, true);
  assert.equal(kq.tuy_chon.thoi_gian, false);
  assert.equal(kq.tuy_chon.ho_ten, true, 'mục không gửi giữ mặc định');
  assert.equal(KhungKy.kiemTuyChon({ ly_do: true }, { ly_do: false, noi_ky: true }).tuy_chon.noi_ky, true, 'nền = lựa chọn đã lưu');
  for (const xau of ['x', 1, [], { ho_ten: 'có' }, { so_seri: 1 }, { hinh: null }]) assert.ok(KhungKy.kiemTuyChon(xau).loi, JSON.stringify(xau));
  assert.ok(!('chen_vao' in KhungKy.kiemTuyChon({ chen_vao: true }).tuy_chon), 'khoá lạ bị bỏ qua');
});

test('dungDong: tiêu đề + các mục được bật và có giá trị + dòng dịch vụ; mục trống không in dòng rỗng', () => {
  const thongTin = { ho_ten: 'Nguyễn Văn A', to_chuc: 'Viện Tế bào gốc', so_seri: 'AB12', ly_do: 'Phê duyệt báo cáo', noi_ky: 'TP. Hồ Chí Minh' };
  assert.deepEqual(KhungKy.dungDong({ tuyChon: KhungKy.MAC_DINH, thongTin, thoiGian: '02/11/2026 09:05' }), [
    'ĐÃ KÝ SỐ', 'Người ký: Nguyễn Văn A', 'Số chứng thư: AB12', 'Thời gian: 02/11/2026 09:05', 'Qua MySign — Viettel-CA',
  ]);
  const du = KhungKy.dungDong({ tuyChon: { ...KhungKy.MAC_DINH, to_chuc: true, ly_do: true, noi_ky: true }, thongTin, thoiGian: 'X', tieuDe: 'ĐÃ KÝ SỐ (THỬ)' });
  assert.equal(du.length, 8);
  assert.equal(du[0], 'ĐÃ KÝ SỐ (THỬ)');
  assert.ok(du.includes('Tổ chức: Viện Tế bào gốc') && du.includes('Lý do: Phê duyệt báo cáo') && du.includes('Nơi ký: TP. Hồ Chí Minh'));
  const tat = KhungKy.dungDong({ tuyChon: { ...KhungKy.MAC_DINH, ho_ten: false, so_seri: false, thoi_gian: false }, thongTin, thoiGian: 'X' });
  assert.deepEqual(tat, ['ĐÃ KÝ SỐ', 'Qua MySign — Viettel-CA']);
  const trong = KhungKy.dungDong({ tuyChon: { ...KhungKy.MAC_DINH, to_chuc: true }, thongTin: { ho_ten: 'A', to_chuc: '  ', so_seri: '' }, thoiGian: 'X' });
  assert.ok(!trong.some((d) => /Tổ chức|Số chứng thư/.test(d)), 'giá trị trống thì bỏ dòng');
});

test('thongTinTuDn: lấy CN, O, số seri; dấu phẩy được escape trong tên không làm cụt', () => {
  assert.deepEqual(KhungKy.thongTinTuDn('CN=PHAM VAN A, O=Vien Te bao goc, C=VN', 'ab12cd'), { cn: 'PHAM VAN A', to_chuc: 'Vien Te bao goc', so_seri: 'AB12CD' });
  assert.equal(KhungKy.thongTinTuDn('CN=Nguyen\\, Van A, O=Cong ty X').cn, 'Nguyen, Van A');
  assert.equal(KhungKy.thongTinTuDn('CN=A\nO=B\nC=VN').to_chuc, 'B', 'dạng nhiều dòng của Node');
  assert.deepEqual(KhungKy.thongTinTuDn('', null), { cn: '', to_chuc: '', so_seri: '' });
});

test('kiemHinh: nhận PNG/JPEG hợp lệ; từ chối tệp khác, PNG xen kẽ, quá lớn, quá nhỏ, ảnh hỏng', () => {
  const ok = KhungKy.kiemHinh(taoPng(120, 60));
  assert.equal(ok.mime, 'image/png');
  assert.equal(ok.rong, 120);
  assert.equal(ok.cao, 60);
  assert.ok(KhungKy.kiemHinh(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')).loi, 'SVG/chữ không phải ảnh');
  assert.ok(KhungKy.kiemHinh(Buffer.from('%PDF-1.4 giả làm ảnh')).loi);
  assert.ok(/xen kẽ/.test(KhungKy.kiemHinh(taoPng(120, 60, { xenKe: 1 })).loi));
  assert.ok(/quá nhỏ/.test(KhungKy.kiemHinh(taoPng(10, 10)).loi));
  assert.ok(/Tối đa 1 MB/.test(KhungKy.kiemHinh(Buffer.concat([taoPng(120, 60), Buffer.alloc(1024 * 1024)])).loi));
  assert.ok(KhungKy.kiemHinh(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('không phải jpeg thật')])).loi, 'JPEG hỏng');
  assert.ok(KhungKy.kiemHinh(Buffer.alloc(0)).loi);
  assert.ok(KhungKy.kiemHinh(null).loi);
});

test('veKhung: khung thấp quá để chứa các dòng thì báo lỗi vi_tri (không vẽ tràn); đủ cao thì vẽ đủ các dòng', () => {
  const goi = [];
  const doc = {
    save() { return this; }, restore() { return this; }, lineWidth() { return this; }, rect() { return this; }, stroke() { return this; },
    fillColor() { return this; }, font() { return this; }, fontSize() { return this; }, widthOfString: () => 50,
    switchToPage() {}, image(...a) { goi.push(['anh', a.length]); },
    text(d, x, y) { goi.push(['chu', d, y]); return this; },
  };
  const dong = ['ĐÃ KÝ SỐ', 'Người ký: A', 'Số chứng thư: 1', 'Thời gian: 2', 'Lý do: 3', 'Nơi ký: 4', 'Tổ chức: 5', 'Qua MySign — Viettel-CA'];
  assert.throws(() => KhungKy.veKhung(doc, [10, 10, 300, 30], { dong }), (e) => e.maLoi === 'vi_tri' && /quá thấp/.test(e.message));
  assert.equal(goi.length, 0, 'không vẽ gì khi báo lỗi');
  KhungKy.veKhung(doc, [10, 10, 300, KhungKy.caoToiThieu(dong.length) + 1], { dong });
  assert.equal(goi.filter((g) => g[0] === 'chu').length, dong.length);
  const ys = goi.filter((g) => g[0] === 'chu').map((g) => g[2]);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys, 'các dòng xếp từ trên xuống');
  goi.length = 0;
  KhungKy.veKhung(doc, [10, 10, 300, 80], { dong: dong.slice(0, 3), hinh: Buffer.from('x') });
  assert.equal(goi.filter((g) => g[0] === 'anh').length, 1, 'có hình thì chèn hình');
});

// ── API hình chữ ký ───────────────────────────────────────────────────────────

test('hình chữ ký: chưa đăng nhập 401; tải lên PNG hợp lệ; xem lại đúng tệp; chỉ của chính mình; xóa được', async () => {
  const png = taoPng(200, 80);
  assert.equal((await fetch(ung.base + '/api/mysign/hinh-ky')).status, 401);
  assert.equal((await ung.goi(VIEN_TRUONG, 'GET', '/api/mysign/hinh-ky')).status, 404, 'chưa có hình');
  const r = await guiAnh(VIEN_TRUONG, png);
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.rong, r.d.cao], [200, 80]);
  const xem = await ung.goi(VIEN_TRUONG, 'GET', '/api/mysign/hinh-ky');
  assert.equal(xem.status, 200);
  assert.equal(xem.headers.get('content-type'), 'image/png');
  assert.equal(xem.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(xem.headers.get('cache-control'), 'no-store');
  assert.ok(Buffer.from(await xem.arrayBuffer()).equals(png));
  assert.equal((await ung.goi(QUAN_LY, 'GET', '/api/mysign/hinh-ky')).status, 404, 'người khác không thấy hình của Viện trưởng');
  assert.equal((await ung.goi(VIEN_TRUONG, 'DELETE', '/api/mysign/hinh-ky')).status, 200);
  assert.equal((await ung.goi(VIEN_TRUONG, 'GET', '/api/mysign/hinh-ky')).status, 404);
});

test('hình chữ ký: tệp giả mạo / quá lớn / sai loại bị từ chối và không được lưu', async () => {
  assert.equal((await guiAnh(VIEN_TRUONG, Buffer.from('<script>alert(1)</script>'))).s, 400, 'nội dung không phải ảnh dù khai image/png');
  assert.equal((await guiAnh(VIEN_TRUONG, taoPng(120, 60, { xenKe: 1 }))).s, 400);
  assert.equal((await guiAnh(VIEN_TRUONG, Buffer.concat([taoPng(120, 60), Buffer.alloc(1024 * 1024 + 10)]))).s, 413);
  assert.equal((await guiAnh(VIEN_TRUONG, Buffer.from('chữ thường'), 'text/plain')).s, 400, 'Content-Type khác PNG/JPEG');
  assert.equal((await guiAnh(VIEN_TRUONG, Buffer.alloc(0))).s, 400);
  assert.equal((await ung.goi(VIEN_TRUONG, 'GET', '/api/mysign/hinh-ky')).status, 404, 'không có gì được lưu');
});

// ── Xem trước + ký ────────────────────────────────────────────────────────────

test('xem trước: meta.khung gồm lựa chọn mặc định, tên / tổ chức / số seri theo CHỨNG THƯ, và co_hinh theo việc đã tải ảnh', async () => {
  const bc = await taoBaoCao('Đợt xem trước khung');
  const m = await xemTruoc(bc);
  assert.deepEqual(m.khung.tuy_chon, KhungKy.MAC_DINH);
  assert.equal(m.khung.co_hinh, false);
  assert.equal(m.khung.thong_tin.ho_ten, 'PHAM VIEN TRUONG', 'tên theo chứng thư, không phải tên trong hệ thống');
  assert.equal(m.khung.thong_tin.to_chuc, 'Vien Te bao goc');
  assert.match(m.khung.thong_tin.so_seri, /^[0-9A-F]{8,}$/);
  assert.equal(m.khung.thong_tin.ly_do, 'Phê duyệt báo cáo');
  assert.ok(m.khung.thong_tin.noi_ky);
  assert.deepEqual(m.khung.truong.map((t) => t.khoa), ['ho_ten', 'to_chuc', 'so_seri', 'thoi_gian', 'ly_do', 'noi_ky']);
  assert.equal(m.khung.tieu_de, 'ĐÃ KÝ SỐ');
  assert.equal((await guiAnh(VIEN_TRUONG, taoPng(200, 80))).s, 200);
  assert.equal((await xemTruoc(bc)).khung.co_hinh, true);
  await ung.goi(VIEN_TRUONG, 'DELETE', '/api/mysign/hinh-ky');
});

test('ký với lựa chọn mặc định: khung có họ tên theo chứng thư, số chứng thư đúng số seri trong chữ ký, thời gian; không có tổ chức / lý do', async () => {
  const bc = await taoBaoCao('Đợt khung mặc định');
  let pdf;
  const lan = await batDong(async () => { pdf = await kyXong(bc, {}); });
  assert.equal(lan.length, 1);
  const kt = Pades.kiemTra(pdf);
  assert.equal(kt.hopLe, true, JSON.stringify(kt));
  const d = lan[0].dong;
  assert.equal(d[0], 'ĐÃ KÝ SỐ');
  assert.ok(d.includes('Người ký: PHAM VIEN TRUONG'), JSON.stringify(d));
  assert.ok(d.includes('Số chứng thư: ' + kt.so_seri), 'số hiện trên trang đúng số seri của chứng thư đã ký: ' + JSON.stringify(d));
  assert.ok(d.some((x) => /^Thời gian: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(x)));
  assert.ok(!d.some((x) => /^(Tổ chức|Lý do|Nơi ký)/.test(x)));
  assert.equal(d[d.length - 1], 'Qua MySign — Viettel-CA');
  assert.ok(!pdf.toString('latin1').includes('/Subtype /Image'), 'chưa tải ảnh thì PDF không có ảnh');
});

test('ký với lựa chọn riêng: đúng các dòng đã bật, được NHỚ cho lần sau; gửi lựa chọn bậy thì 400 và không gửi MySign', async () => {
  const bc1 = await taoBaoCao('Đợt chọn dòng 1');
  const lan1 = await batDong(async () => { await kyXong(bc1, { khung: { ho_ten: true, to_chuc: true, so_seri: false, thoi_gian: false, ly_do: true, noi_ky: true, hinh: false } }); });
  assert.deepEqual(lan1[0].dong.slice(1, -1), ['Người ký: PHAM VIEN TRUONG', 'Tổ chức: Vien Te bao goc', 'Lý do: Phê duyệt báo cáo', lan1[0].dong[4]]);
  assert.match(lan1[0].dong[4], /^Nơi ký: /);

  const bc2 = await taoBaoCao('Đợt chọn dòng 2');
  const lan2 = await batDong(async () => { await kyXong(bc2, {}); }); // không gửi khung: dùng lựa chọn đã lưu
  assert.deepEqual(lan2[0].dong, lan1[0].dong, 'nhớ lựa chọn lần trước');

  const bc3 = await taoBaoCao('Đợt chọn bậy');
  gl.cheDo = 'cho';
  const truoc = gl.yeuCau.length;
  for (const khung of ['bật hết', { ho_ten: 'true' }, { so_seri: 1 }, [true]]) {
    const r = await ky(bc3, { khung });
    assert.equal(r.s, 400, JSON.stringify(khung));
  }
  assert.equal(gl.yeuCau.length, truoc, 'không có yêu cầu nào tới MySign');
});

test('ký với hình chữ ký: bật thì PDF có ảnh, tắt thì không; ảnh đã xóa thì ký bình thường không lỗi; chữ ký vẫn hợp lệ', async () => {
  assert.equal((await guiAnh(VIEN_TRUONG, taoPng(200, 80))).s, 200);
  const bcA = await taoBaoCao('Đợt có hình');
  const pdfA = await kyXong(bcA, { khung: { ...KhungKy.MAC_DINH, hinh: true } });
  assert.equal(Pades.kiemTra(pdfA).hopLe, true);
  assert.ok(pdfA.toString('latin1').includes('/Subtype /Image'), 'có ảnh chữ ký trong PDF');

  const bcB = await taoBaoCao('Đợt tắt hình');
  const pdfB = await kyXong(bcB, { khung: { ...KhungKy.MAC_DINH, hinh: false } });
  assert.equal(Pades.kiemTra(pdfB).hopLe, true);
  assert.ok(!pdfB.toString('latin1').includes('/Subtype /Image'), 'tắt hình thì không chèn');

  await ung.goi(VIEN_TRUONG, 'DELETE', '/api/mysign/hinh-ky');
  const bcC = await taoBaoCao('Đợt đã xóa hình');
  const pdfC = await kyXong(bcC, { khung: { ...KhungKy.MAC_DINH, hinh: true } });
  assert.equal(Pades.kiemTra(pdfC).hopLe, true);
  assert.ok(!pdfC.toString('latin1').includes('/Subtype /Image'), 'bật hình nhưng không còn ảnh thì bỏ qua');
});

test('khung quá thấp để chứa các dòng đã chọn: 400 rõ ràng, không tạo yêu cầu ký nào', async () => {
  const bc = await taoBaoCao('Đợt khung thấp');
  const x = await xemTruoc(bc);
  const batHet = { ho_ten: true, to_chuc: true, so_seri: true, thoi_gian: true, ly_do: true, noi_ky: true, hinh: false };
  gl.cheDo = 'cho';
  const truoc = gl.yeuCau.length;
  const r = await ky(bc, { khung: batHet, vi_tri: { trang: x.so_trang - 1, x: 0.1, y: 0.5, w: 0.5, h: 0.04 } });
  assert.equal(r.s, 400, JSON.stringify(r.d));
  assert.match(r.d.message, /quá thấp/);
  assert.equal(gl.yeuCau.length, truoc);
  // Cao đúng mức tối thiểu mà giao diện tính thì ký được.
  const dongToiDa = 2 + 6;
  const cao = Math.ceil((KhungKy.caoToiThieu(dongToiDa) / x.kho[1]) * 1000) / 1000 + 0.002;
  const ok = await ky(bc, { khung: batHet, vi_tri: { trang: x.so_trang - 1, x: 0.1, y: 0.5, w: 0.8, h: cao } });
  assert.equal(ok.s, 200, JSON.stringify(ok.d));
  gl.cheDo = 'dong_y';
  const xong = await ung.json(VIEN_TRUONG, 'GET', '/api/mysign/giao-dich/' + ok.d.giao_dich.id);
  assert.equal(xong.d.trang_thai, 'thanh_cong', JSON.stringify(xong.d));
});

test('trang thử: khung theo chứng thư cùng quy tắc; tiêu đề (THỬ); lựa chọn bậy 400', async () => {
  gl.nguoiDung.add('ADMIN_MYSIGN_KHUNG');
  assert.equal((await ung.json(ADMIN, 'PUT', '/api/mysign/tai-khoan', { mysign_user_id: 'ADMIN_MYSIGN_KHUNG' })).s, 200);
  gl.cheDo = 'cho';
  const truoc = gl.yeuCau.length;
  assert.equal((await ung.json(ADMIN, 'POST', '/api/mysign/thu/ky', { khung: { ho_ten: 'x' } })).s, 400);
  assert.equal(gl.yeuCau.length, truoc);

  const xt = await ung.goi(ADMIN, 'GET', '/api/mysign/thu/xem-truoc');
  await xt.arrayBuffer();
  const meta = JSON.parse(xt.headers.get('x-ky-so-meta'));
  assert.equal(meta.khung.tieu_de, 'ĐÃ KÝ SỐ (THỬ)');
  assert.ok(meta.khung.thong_tin.so_seri);

  let g;
  const lan = await batDong(async () => {
    const r = await ung.json(ADMIN, 'POST', '/api/mysign/thu/ky', { khung: { ...KhungKy.MAC_DINH, to_chuc: true, hinh: false } });
    assert.equal(r.s, 200, JSON.stringify(r.d));
    g = r.d.giao_dich;
  });
  assert.equal(lan[0].dong[0], 'ĐÃ KÝ SỐ (THỬ)');
  assert.ok(lan[0].dong.some((d) => /^Tổ chức: /.test(d)));
  assert.ok(lan[0].dong.some((d) => /^Số chứng thư: /.test(d)));
  gl.cheDo = 'dong_y';
  const xong = await ung.json(ADMIN, 'GET', '/api/mysign/giao-dich/' + g.id);
  assert.equal(xong.d.trang_thai, 'thanh_cong', JSON.stringify(xong.d));
  const kt = await ung.json(ADMIN, 'GET', '/api/mysign/thu/kiem-tra/' + g.id);
  assert.equal(kt.d.hopLe, true, JSON.stringify(kt.d));
});
