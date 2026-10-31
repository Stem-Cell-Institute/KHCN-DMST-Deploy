/**
 * tests/baoCaoPhongDuyetTrongGiaoDien.test.js
 * Viện trưởng duyệt TỪNG BÁO CÁO ngay trong giao diện, sau khi người quản lý module "trình" đợt (thay cho việc tải tệp lên rồi gửi).
 *
 * Trọng tâm là những chỗ sai thì hậu quả nặng:
 *   - ai được trình / ai được quyết định (chỉ Viện trưởng quyết định; quản lý và admin không duyệt thay)
 *   - quyết định gán nhầm cho bản báo cáo Viện trưởng chưa đọc (phòng nộp lại trong lúc ông đọc)
 *   - nội dung nháp của phòng chưa nộp bị lộ cho Viện trưởng
 *   - email gửi nhầm phòng, gửi thừa (Duyệt không gửi thư cho phòng), hoặc không gửi khi cần
 *   - trạng thái của Viện trưởng không hiện cho phòng / người quản lý, hoặc không vào lịch sử
 * Chạy trên router thật trong tiến trình (tests/helpers/baoCaoPhongApp.js).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');
const { suyRaQuyetDinh, trangThaiVienTruong, demTienDo } = require('../services/baoCaoPhongVienTruong');

const ADMIN = 1;
const QUAN_LY = 2;
const VIEN_TRUONG = 3;
const TP_A = 4;
const TP_B = 5;
const NGOAI = 6;

let ung;
const ID = {};
const doi = (ms = 120) => new Promise((r) => setTimeout(r, ms));

const DU_LIEU = (ten, them = {}) => ({
  nguoi_phu_trach: ten, ky_tu_ngay: '2026-09-04', ky_den_ngay: '2026-10-04', tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm của ' + ten, muc_do: 100 } }],
  ...them,
});

async function nop(uid, id, ten, them) {
  const a = await ung.json(uid, 'PUT', `/bao-cao/${id}/du-lieu`, { du_lieu: DU_LIEU(ten, them) });
  assert.equal(a.s, 200, JSON.stringify(a.d));
  const b = await ung.json(uid, 'POST', `/bao-cao/${id}/nop`, {});
  assert.equal(b.s, 200, JSON.stringify(b.d));
}

/** Đợt có 3 phòng: A và B đã nộp, C CHƯA nộp. Chưa trình. Trả {id, a, b, c} (id báo cáo). */
async function taoDot(tieuDe, kieu = {}) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', {
    tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau,
    phong_ids: kieu.phong || [ID.phongA, ID.phongB, ID.phongC], cach_nop: kieu.cachNop,
  });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  const bc = Object.fromEntries((await ung.json(QUAN_LY, 'GET', '/dot/' + r.d.id)).d.bao_cao.map((b) => [b.phong_id + ':' + (b.chu_id || 0), b.id]));
  const d = { id: r.d.id, a: bc[ID.phongA + ':0'], b: bc[ID.phongB + ':0'], c: bc[ID.phongC + ':0'], bc };
  if (!kieu.khongNop) {
    if (d.a) await nop(TP_A, d.a, 'A');
    if (d.b) await nop(TP_B, d.b, 'B');
  }
  return d;
}

async function trinh(dotId, loiNhan) {
  const r = await ung.json(QUAN_LY, 'POST', `/dot/${dotId}/trinh-vien-truong`, loiNhan === undefined ? {} : { loi_nhan: loiNhan });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  return r.d;
}

const baoCaoCuaVT = async (dotId, baoCaoId) => (await ung.json(VIEN_TRUONG, 'GET', `/dot/${dotId}/vien-truong`)).d.bao_cao.find((b) => b.id === baoCaoId);
const quyetDinh = (uid, baoCaoId, qd, ghiChu, nopLuc) => ung.json(uid, 'POST', `/bao-cao/${baoCaoId}/quyet-dinh`, { quyet_dinh: qd, ghi_chu: ghiChu, nop_luc: nopLuc });
/** Quyết định đúng bản đang có (lấy nop_luc hiện tại, như giao diện làm). */
async function quyet(uid, dotId, baoCaoId, qd, ghiChu) {
  const bc = await baoCaoCuaVT(dotId, baoCaoId);
  return quyetDinh(uid, baoCaoId, qd, ghiChu, bc.nop_luc);
}
const thuTheo = (re) => ung.thu.filter((t) => re.test(t.subject));

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run().lastInsertRowid);
  ID.phongB = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('b','Phòng B')").run().lastInsertRowid);
  ID.phongC = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('c','Phòng C')").run().lastInsertRowid);
  ID.tpC = ung.dangKy('tpc@thu.local', 'Đỗ Trưởng Phòng C');
  ID.tpA2 = ung.dangKy('tpa2@thu.local', 'Ngô Phó Phòng A');
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'truong_phong')").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'truong_phong')").run(TP_B, ID.phongB);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'truong_phong')").run(ID.tpC, ID.phongC);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

// ══ Logic thuần ═════════════════════════════════════════════════════════════════

test('suyRaQuyetDinh: quyết định chỉ áp dụng cho BẢN NỘP hiện tại; nộp lại hoặc bị yêu cầu sửa thì hết hiệu lực', () => {
  const dong = (hd, ghi = null) => ({ hanh_dong: hd, ghi_chu: ghi, nguoi: 'VT', tao_luc: '2026-10-01 08:00:00' });
  assert.equal(suyRaQuyetDinh([]), null);
  assert.equal(suyRaQuyetDinh([dong('nop')]), null, 'mới nộp, chưa ai quyết định');
  assert.equal(suyRaQuyetDinh([dong('nop'), dong('vt_duyet')]).quyet_dinh, 'duyet');
  assert.equal(suyRaQuyetDinh([dong('nop'), dong('vt_duyet'), dong('nop_lai')]), null, 'nộp lại → bản mới chưa ai xem');
  assert.equal(suyRaQuyetDinh([dong('nop'), dong('vt_khong_duyet', 'Thiếu số liệu'), dong('yeu_cau_chinh_sua', 'Sửa')]), null, 'quản lý đưa về sửa → nội dung sắp đổi');
  assert.equal(suyRaQuyetDinh([dong('nop'), dong('vt_duyet'), dong('duyet')]).quyet_dinh, 'duyet', 'quản lý XÁC NHẬN không làm mất quyết định của Viện trưởng');
  assert.equal(suyRaQuyetDinh([dong('nop'), dong('vt_de_nghi_chinh_sua', 'Sửa')]).quyet_dinh, 'de_nghi_chinh_sua', 'đề nghị sửa còn hiệu lực cho tới khi phòng nộp lại');
  assert.equal(suyRaQuyetDinh([dong('nop'), dong('vt_de_nghi_chinh_sua', 'Sửa'), dong('nop_lai')]), null);
  // đổi ý: quyết định sau thay quyết định trước
  const doiY = suyRaQuyetDinh([dong('nop'), dong('vt_duyet'), dong('vt_khong_duyet', 'Xem lại số liệu')]);
  assert.equal(doiY.quyet_dinh, 'khong_duyet');
  assert.equal(doiY.ghi_chu, 'Xem lại số liệu');
  assert.equal(doiY.nguoi, 'VT');
});

test('trangThaiVienTruong: Viện trưởng nhìn mỗi báo cáo ở trạng thái nào', () => {
  const q = (x) => ({ quyet_dinh: x });
  assert.equal(trangThaiVienTruong('chua_nop', null), 'chua_nop');
  assert.equal(trangThaiVienTruong('can_chinh_sua', null), 'dang_sua');
  assert.equal(trangThaiVienTruong('can_chinh_sua', q('de_nghi_chinh_sua')), 'de_nghi_chinh_sua');
  assert.equal(trangThaiVienTruong('da_nop', null), 'cho_quyet_dinh');
  assert.equal(trangThaiVienTruong('da_duyet', null), 'cho_quyet_dinh', 'quản lý đã xác nhận nhưng Viện trưởng chưa quyết định');
  assert.equal(trangThaiVienTruong('da_nop', q('duyet')), 'duyet');
  assert.equal(trangThaiVienTruong('da_duyet', q('khong_duyet')), 'khong_duyet');
  const dem = demTienDo(['chua_nop', 'cho_quyet_dinh', 'duyet', 'duyet', 'khong_duyet', 'de_nghi_chinh_sua', 'dang_sua']);
  assert.equal(dem.tong, 7);
  assert.equal(dem.da_nop, 4, 'đã nộp = đang ở bản nộp (chờ quyết định, duyệt, không duyệt)');
  assert.equal(dem.cho_quyet_dinh, 1);
  assert.equal(dem.duyet, 2);
});

// ══ Trình ═══════════════════════════════════════════════════════════════════════

test('trình: chỉ người quản lý module và admin; Viện trưởng, trưởng phòng, người ngoài, người chưa đăng nhập đều bị chặn', async () => {
  const dot = await taoDot('Đợt phân quyền trình');
  for (const uid of [VIEN_TRUONG, TP_A, TP_B, NGOAI]) {
    assert.equal((await ung.json(uid, 'POST', `/dot/${dot.id}/trinh-vien-truong`, {})).s, 403, 'user ' + uid);
  }
  assert.equal((await ung.json(null, 'POST', `/dot/${dot.id}/trinh-vien-truong`, {})).s, 401);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id)).d.trinh_vt, null, 'chưa ai trình được');
  assert.equal((await ung.json(ADMIN, 'POST', `/dot/${dot.id}/trinh-vien-truong`, {})).s, 200, 'admin trình được');
});

test('trình: đợt Nháp, đợt không tồn tại, id sai bị từ chối; chưa có Viện trưởng thì 409 nói rõ lý do', async () => {
  const nhap = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Nháp', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] });
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${nhap.d.id}/trinh-vien-truong`, {})).s, 409);
  assert.equal((await ung.json(QUAN_LY, 'POST', '/dot/999999/trinh-vien-truong', {})).s, 404);
  assert.equal((await ung.json(QUAN_LY, 'POST', '/dot/abc/trinh-vien-truong', {})).s, 400);

  const dot = await taoDot('Đợt chưa có Viện trưởng');
  ung.db.prepare("DELETE FROM bcp_thanh_vien WHERE vai_tro = 'vien_truong'").run();
  const r = await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/trinh-vien-truong`, {});
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  assert.equal(r.s, 409);
  assert.match(r.d.message, /Chưa chỉ định Viện trưởng/);
  assert.equal(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_trinh_lan WHERE dot_id = ?').get(dot.id).n, 0, 'không ghi gì khi bị từ chối');
});

test('trình khi còn phòng CHƯA NỘP vẫn được; thư chỉ tới Viện trưởng, nêu phòng chưa nộp, không nhắc xác nhận và không có tệp', async () => {
  const dot = await taoDot('Đợt có phòng chưa nộp');
  ID.dotChinh = dot;
  ung.thu.length = 0;
  const r = await trinh(dot.id, 'Kính trình Viện trưởng xem và quyết định.');
  assert.equal(r.lan, 1);
  assert.equal(r.trinh_lai, false);
  assert.equal(r.da_bao, 1);
  assert.equal(r.tien_do.cho_quyet_dinh, 2);
  assert.equal(r.tien_do.chua_nop, 1);
  await ung.doiThu(1);
  await doi();
  assert.deepEqual(ung.thu.map((t) => t.to), ['vientruong@thu.local']);
  const thu = ung.thu[0];
  assert.match(thu.subject, /^\[Cần duyệt\] Báo cáo các phòng — Đợt có phòng chưa nộp$/);
  assert.match(thu.text, /Kính trình Viện trưởng xem và quyết định\./);
  assert.match(thu.text, /Đã nộp: 2\/3 phòng/);
  assert.match(thu.text, /Phòng chưa nộp: Phòng C/);
  assert.match(thu.text, /Không cần tải tệp/);
  assert.ok(thu.text.includes(`https://eoffice.test/bao-cao-phong.html#/duyet/${dot.id}`), 'liên kết dẫn thẳng vào màn hình duyệt của đợt');
  assert.doesNotMatch(thu.text, /xác nhận \d|Duyệt hồ sơ/, 'không nêu số báo cáo đã xác nhận (dễ nhầm với việc Viện trưởng duyệt)');
});

test('trình lại (nhắc): thư [Nhắc duyệt], ghi vào lịch sử đợt cả hai lần; đợt đã đóng vẫn trình được', async () => {
  const dot = ID.dotChinh;
  ung.thu.length = 0;
  const r = await trinh(dot.id, 'Nhắc Viện trưởng giúp.');
  assert.equal(r.lan, 2);
  assert.equal(r.trinh_lai, true);
  await ung.doiThu(1);
  assert.match(ung.thu[0].subject, /^\[Nhắc duyệt\]/);
  assert.match(ung.thu[0].text, /được trình lại/);

  const ls = (await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}`)).d.lich_su.map((h) => h.hanh_dong).filter((h) => h.startsWith('trinh'));
  assert.deepEqual(ls, ['trinh', 'trinh_lai']);

  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/dong`, {})).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/trinh-vien-truong`, {})).s, 200, 'đã đóng vẫn trình được');
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/mo-lai`, {})).s, 200);
});

test('kết xuất Word/PDF vẫn là công cụ của người quản lý sau khi trình (Viện trưởng không kết xuất)', async () => {
  const dot = ID.dotChinh;
  const r = await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=tat-ca&dinh_dang=docx`);
  assert.equal(r.status, 200);
  assert.equal((await ung.goi(QUAN_LY, 'GET', `/dot/${dot.id}/xuat?phong=${ID.phongA}&dinh_dang=pdf`)).status, 200);
  assert.equal((await ung.goi(VIEN_TRUONG, 'GET', `/dot/${dot.id}/xuat?phong=tat-ca&dinh_dang=docx`)).status, 403);
});

// ══ Đọc cả đợt ══════════════════════════════════════════════════════════════════

test('đọc cả đợt: CHỈ Viện trưởng dùng được màn duyệt; quản lý, admin, trưởng phòng, người ngoài đều 403, người chưa đăng nhập 401', async () => {
  const dot = ID.dotChinh;
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', `/dot/${dot.id}/vien-truong`)).s, 200);
  for (const uid of [QUAN_LY, ADMIN, TP_A, TP_B, NGOAI]) assert.equal((await ung.json(uid, 'GET', `/dot/${dot.id}/vien-truong`)).s, 403, 'user ' + uid);
  assert.equal((await ung.json(null, 'GET', `/dot/${dot.id}/vien-truong`)).s, 401);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/dot/999999/vien-truong')).s, 404);
  const nhap = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Nháp 2', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] });
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', `/dot/${nhap.d.id}/vien-truong`)).s, 409, 'đợt Nháp chưa có gì cho ông đọc');
});

test('đọc cả đợt: có nội dung các phòng đã nộp, phòng chưa nộp hiện "Chưa nộp" và KHÔNG lộ bản nháp', async () => {
  const dot = ID.dotChinh;
  // Phòng C lưu nháp nhưng chưa nộp: bản nháp chưa phải báo cáo, Viện trưởng không được đọc.
  const nhap = await ung.json(ID.tpC, 'PUT', `/bao-cao/${dot.c}/du-lieu`, { du_lieu: { nguoi_phu_trach: 'NOI-DUNG-NHAP-RIENG' } });
  assert.equal(nhap.s, 200);
  const r = await ung.json(VIEN_TRUONG, 'GET', `/dot/${dot.id}/vien-truong`);
  assert.equal(r.s, 200);
  assert.ok(!JSON.stringify(r.d).includes('NOI-DUNG-NHAP-RIENG'), 'bản nháp của phòng chưa nộp không được xuất hiện trong dữ liệu gửi cho Viện trưởng');
  const [a, b, c] = ['a', 'b', 'c'].map((k) => r.d.bao_cao.find((x) => x.id === dot[k]));
  assert.equal(c.vt_trang_thai, 'chua_nop');
  assert.equal(c.du_lieu, null);
  assert.equal(c.trang_thai, 'chua_nop');
  assert.equal(a.vt_trang_thai, 'cho_quyet_dinh');
  assert.match(a.du_lieu.cv_thuong_xuyen[1].o.hang_muc, /KPI năm của A/, 'có nội dung báo cáo đã nộp để dựng HTML');
  assert.ok(b.nop_luc && a.nguoi_nop === 'Trần Trưởng Phòng A');
  assert.ok(Array.isArray(r.d.truong) && r.d.truong.length > 0, 'biểu mẫu đã ghim đi kèm để dựng báo cáo');
  assert.equal(r.d.trinh.lan, 3, 'đã trình ba lần ở các test trên');
  assert.equal(r.d.tien_do.tong, 3);
  assert.equal(r.d.tien_do.cho_quyet_dinh, 2);
  assert.equal(r.d.co_the.quyet_dinh, true, 'Viện trưởng quyết định được');
});

test('đợt CHƯA TRÌNH: Viện trưởng chưa thấy gì (như không tồn tại); trình xong thì Viện trưởng thấy đủ', async () => {
  const dot = await taoDot('Đợt chưa trình');
  // Viện trưởng: không có trong danh sách, tiến độ, không đọc được đợt hay báo cáo, không góp ý, không quyết định
  assert.ok(!(await ung.json(VIEN_TRUONG, 'GET', '/dot')).d.dot.some((x) => x.id === dot.id), 'không có trong danh sách đợt');
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/dot/' + dot.id)).s, 404);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', `/dot/${dot.id}/vien-truong`)).s, 404);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/bao-cao/' + dot.a)).s, 404, 'không đọc được báo cáo của đợt chưa trình');
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${dot.a}/y-kien`, { noi_dung: 'Góp ý sớm' })).s, 404);
  assert.equal((await quyetDinh(VIEN_TRUONG, dot.a, 'duyet', '', '2026-01-01T00:00:00.000Z')).s, 404);
  const tq = (await ung.json(VIEN_TRUONG, 'GET', '/tong-quan')).d;
  assert.ok(!tq.chi_tiet.some((x) => x.dot_id === dot.id), 'không có trong tiến độ');
  // Người quản lý không có màn "xem như Viện trưởng"; thấy đợt chưa trình ở danh sách đợt của mình
  assert.equal((await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}/vien-truong`)).s, 403);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id)).d.trinh_vt, null);
  // Phòng vẫn đọc báo cáo của mình bình thường
  assert.equal((await ung.json(TP_A, 'GET', '/bao-cao/' + dot.a)).s, 200);
  // Trình xong: Viện trưởng thấy đủ
  await trinh(dot.id);
  assert.ok((await ung.json(VIEN_TRUONG, 'GET', '/dot')).d.dot.some((x) => x.id === dot.id));
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/dot/' + dot.id)).s, 200);
  assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/bao-cao/' + dot.a)).s, 200);
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet')).s, 200);
});

// ══ Quyết định ══════════════════════════════════════════════════════════════════

test('chỉ Viện trưởng quyết định: quản lý, admin, trưởng phòng, người ngoài đều 403 và báo cáo không đổi', async () => {
  const dot = ID.dotChinh;
  const bc = await baoCaoCuaVT(dot.id, dot.a);
  for (const uid of [QUAN_LY, ADMIN, TP_A, TP_B, NGOAI]) {
    for (const qd of ['duyet', 'khong_duyet', 'de_nghi_chinh_sua']) {
      const r = await quyetDinh(uid, dot.a, qd, 'Ghi chú', bc.nop_luc);
      assert.equal(r.s, 403, `user ${uid} ${qd}`);
    }
  }
  assert.equal((await quyetDinh(null, dot.a, 'duyet', '', bc.nop_luc)).s, 401);
  const sau = await baoCaoCuaVT(dot.id, dot.a);
  assert.equal(sau.vt_trang_thai, 'cho_quyet_dinh');
  assert.equal(sau.trang_thai, 'da_nop');
});

test('kiểm dữ liệu: quyết định lạ, thiếu lý do khi không duyệt / đề nghị sửa, ghi chú quá dài, báo cáo chưa nộp, nop_luc sai hoặc thiếu', async () => {
  const dot = ID.dotChinh;
  const bc = await baoCaoCuaVT(dot.id, dot.a);
  assert.equal((await quyetDinh(VIEN_TRUONG, dot.a, 'tu_choi', 'x', bc.nop_luc)).s, 400);
  assert.equal((await quyetDinh(VIEN_TRUONG, dot.a, undefined, 'x', bc.nop_luc)).s, 400);
  const k = await quyetDinh(VIEN_TRUONG, dot.a, 'khong_duyet', '   ', bc.nop_luc);
  assert.equal(k.s, 400);
  assert.match(k.d.message, /lý do/);
  const s = await quyetDinh(VIEN_TRUONG, dot.a, 'de_nghi_chinh_sua', '', bc.nop_luc);
  assert.equal(s.s, 400);
  assert.match(s.d.message, /đề nghị chỉnh sửa/);
  assert.equal((await quyetDinh(VIEN_TRUONG, dot.a, 'duyet', 'x'.repeat(2001), bc.nop_luc)).s, 400);
  assert.equal((await quyetDinh(VIEN_TRUONG, 999999, 'duyet', '', bc.nop_luc)).s, 404);
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', '/bao-cao/abc/quyet-dinh', { quyet_dinh: 'duyet' })).s, 400);

  const chuaNop = await quyetDinh(VIEN_TRUONG, dot.c, 'duyet', '', null);
  assert.equal(chuaNop.s, 409);
  assert.match(chuaNop.d.message, /chưa nộp/);

  assert.equal((await quyetDinh(VIEN_TRUONG, dot.a, 'duyet', '', 'khong-phai-ban-dang-co')).s, 409, 'nop_luc sai');
  assert.equal((await quyetDinh(VIEN_TRUONG, dot.a, 'duyet', '', undefined)).s, 409, 'thiếu nop_luc: không đoán, từ chối');
  assert.equal((await baoCaoCuaVT(dot.id, dot.a)).vt_trang_thai, 'cho_quyet_dinh', 'mọi yêu cầu sai ở trên không làm đổi gì');
});

test('DUYỆT: ghi vào lịch sử, KHÔNG gửi thư cho phòng, báo cáo vẫn "Đã nộp" (độc lập với xác nhận của quản lý)', async () => {
  const dot = ID.dotChinh;
  ung.thu.length = 0;
  const r = await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet', 'Đồng ý.');
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.vt_trang_thai, 'duyet');
  assert.equal(r.d.trang_thai, 'da_nop', 'không đổi trạng thái xác nhận của quản lý');
  assert.equal(r.d.da_bao, 0, 'Duyệt không báo qua email');
  assert.equal(r.d.tien_do.duyet, 1);
  assert.equal(r.d.tien_do.cho_quyet_dinh, 1);
  await doi(250);
  assert.equal(ung.thu.length, 0, 'không có thư nào (phòng thấy trạng thái ngay trong báo cáo)');

  // Hiện cho chủ phòng
  const phong = await ung.json(TP_A, 'GET', '/bao-cao/' + dot.a);
  assert.equal(phong.d.vien_truong.quyet_dinh, 'duyet');
  assert.equal(phong.d.vien_truong.ghi_chu, 'Đồng ý.');
  assert.equal(phong.d.vien_truong.nguoi, 'Phạm Viện Trưởng');
  assert.equal(phong.d.vt_trang_thai, 'duyet');
  // Hiện cho người quản lý (bảng tiến độ của đợt) và trong lịch sử của báo cáo
  const ql = await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id);
  const hang = ql.d.bao_cao.find((b) => b.id === dot.a);
  assert.equal(hang.vien_truong.quyet_dinh, 'duyet');
  assert.equal(hang.vt_trang_thai, 'duyet');
  assert.equal(ql.d.bao_cao.find((b) => b.id === dot.b).vt_trang_thai, 'cho_quyet_dinh');
  assert.equal(ql.d.trinh_vt.lan, 3, 'quản lý thấy đợt đã trình mấy lần');
  assert.equal(ql.d.tien_do_vt.duyet, 1);
  const ls = phong.d.lich_su.filter((h) => h.hanh_dong === 'vt_duyet');
  assert.equal(ls.length, 1);
  assert.equal(ls[0].nguoi, 'Phạm Viện Trưởng');
  assert.equal(ls[0].ghi_chu, 'Đồng ý.');
  // "Báo cáo của tôi" cũng thấy
  const cuaToi = (await ung.json(TP_A, 'GET', '/cua-toi')).d.bao_cao.find((b) => b.id === dot.a);
  assert.equal(cuaToi.vien_truong.quyet_dinh, 'duyet');
});

test('XÁC NHẬN của quản lý và DUYỆT của Viện trưởng là hai việc độc lập: xác nhận sau khi duyệt không làm mất quyết định, và không cần xác nhận trước', async () => {
  const dot = ID.dotChinh;
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.a}/duyet`, {})).s, 200);
  const sau = await baoCaoCuaVT(dot.id, dot.a);
  assert.equal(sau.trang_thai, 'da_duyet', 'đã xác nhận');
  assert.equal(sau.vt_trang_thai, 'duyet', 'quyết định của Viện trưởng vẫn còn');
  // báo cáo B chưa được xác nhận mà Viện trưởng vẫn quyết định được (kiểm ở test sau)
  assert.equal((await baoCaoCuaVT(dot.id, dot.b)).trang_thai, 'da_nop');
});

test('bấm lại đúng quyết định đang có thì bỏ qua (không thêm lịch sử, không gửi thư); đổi ý thì quyết định mới thay cũ, cũ vẫn nằm trong lịch sử', async () => {
  const dot = ID.dotChinh;
  const lai = await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet', 'Đồng ý.');
  assert.equal(lai.s, 200);
  assert.equal(lai.d.khong_doi, true);
  assert.equal(ung.db.prepare("SELECT COUNT(*) AS n FROM bcp_lich_su WHERE bao_cao_id = ? AND hanh_dong = 'vt_duyet'").get(dot.a).n, 1);

  ung.thu.length = 0;
  const doiY = await quyet(VIEN_TRUONG, dot.id, dot.a, 'khong_duyet', 'Xem lại mục KPI.');
  assert.equal(doiY.s, 200);
  assert.equal(doiY.d.vt_trang_thai, 'khong_duyet');
  assert.equal(doiY.d.vien_truong.ghi_chu, 'Xem lại mục KPI.');
  assert.equal(doiY.d.trang_thai, 'da_duyet', 'không duyệt không động tới trạng thái xác nhận (không khóa gì)');
  const ls = (await ung.json(TP_A, 'GET', '/bao-cao/' + dot.a)).d.lich_su.map((h) => h.hanh_dong).filter((h) => h.startsWith('vt_'));
  assert.deepEqual(ls, ['vt_duyet', 'vt_khong_duyet']);
  // trả lại như cũ cho các test sau
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet', 'Đồng ý.')).s, 200);
});

test('KHÔNG DUYỆT: gửi thư lý do cho người phụ trách ĐÚNG phòng và người quản lý; phòng khác không nhận; báo cáo giữ nguyên trạng thái', async () => {
  const dot = ID.dotChinh;
  ung.thu.length = 0;
  const r = await quyet(VIEN_TRUONG, dot.id, dot.b, 'khong_duyet', 'Số liệu chưa khớp với báo cáo quý.\nĐề nghị giải trình.');
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.trang_thai, 'da_nop', 'không khóa gì, không đổi trạng thái');
  assert.equal(r.d.da_bao, 1);
  assert.equal(r.d.da_bao_quan_ly, 1);
  await ung.doiThu(2);
  await doi();
  const thu = thuTheo(/^\[Viện trưởng không duyệt\]/);
  assert.deepEqual(thu.map((t) => t.to).sort(), ['quanly@thu.local', 'tpb@thu.local'], 'trưởng phòng B và người quản lý, không ai khác');
  const cho = thu.find((t) => t.to === 'tpb@thu.local');
  assert.equal(cho.subject, '[Viện trưởng không duyệt] Phòng B — Đợt có phòng chưa nộp');
  assert.match(cho.text, /Viện trưởng Phạm Viện Trưởng không duyệt báo cáo của Phòng B/);
  assert.match(cho.text, /Lý do: Số liệu chưa khớp với báo cáo quý\./);
  assert.ok(cho.text.includes(`https://eoffice.test/bao-cao-phong.html#/bao-cao/${dot.b}`));
  assert.ok(!ung.thu.some((t) => t.to === 'tpa@thu.local' || t.to === 'vientruong@thu.local'), 'không gửi cho phòng A, không gửi lại cho chính Viện trưởng');

  // Phòng B thấy lý do ngay trong báo cáo; phòng A không đọc được báo cáo của B
  const phong = await ung.json(TP_B, 'GET', '/bao-cao/' + dot.b);
  assert.equal(phong.d.vien_truong.quyet_dinh, 'khong_duyet');
  assert.match(phong.d.vien_truong.ghi_chu, /giải trình/);
  assert.equal(phong.d.sua_duoc, false, 'không duyệt không mở lại việc sửa');
  assert.equal((await ung.json(TP_A, 'GET', '/bao-cao/' + dot.b)).s, 404);
});

test('ĐỀ NGHỊ CHỈNH SỬA: báo cáo về "Cần chỉnh sửa" kèm nội dung, thư tới đúng phòng + quản lý; phòng sửa và nộp lại thì Viện trưởng được báo', async () => {
  const dot = ID.dotChinh;
  ung.thu.length = 0;
  const r = await quyet(VIEN_TRUONG, dot.id, dot.b, 'de_nghi_chinh_sua', 'Bổ sung giải trình về chênh lệch số liệu.');
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.trang_thai, 'can_chinh_sua');
  assert.equal(r.d.vt_trang_thai, 'de_nghi_chinh_sua');
  assert.equal(r.d.dot_mo_lai, false, 'đợt đang mở, không cần mở lại');
  await ung.doiThu(2);
  await doi();
  const thu = thuTheo(/^\[Viện trưởng đề nghị chỉnh sửa\]/);
  assert.deepEqual(thu.map((t) => t.to).sort(), ['quanly@thu.local', 'tpb@thu.local']);
  assert.match(thu[0].text, /Nội dung đề nghị chỉnh sửa: Bổ sung giải trình/);
  assert.match(thu[0].text, /trở về trạng thái "Cần chỉnh sửa"/);

  const phong = await ung.json(TP_B, 'GET', '/bao-cao/' + dot.b);
  assert.equal(phong.d.trang_thai, 'can_chinh_sua');
  assert.equal(phong.d.sua_duoc, true, 'phòng sửa được ngay');
  assert.match(phong.d.nhan_xet, /Bổ sung giải trình/);
  assert.equal(phong.d.nhan_xet_boi, 'vien_truong', 'giao diện ghi đúng người nói là Viện trưởng, không phải người quản lý');
  assert.equal((await ung.json(TP_B, 'GET', '/cua-toi')).d.bao_cao.find((b) => b.id === dot.b).nhan_xet_boi, 'vien_truong');
  // Viện trưởng không quyết định được khi báo cáo đang ở phòng
  const cho = await quyetDinh(VIEN_TRUONG, dot.b, 'duyet', '', (await baoCaoCuaVT(dot.id, dot.b)).nop_luc);
  assert.equal(cho.s, 409);
  assert.match(cho.d.message, /đang được phòng chỉnh sửa/);

  // Phòng nộp lại → mail cho Viện trưởng (và mail báo nộp cho quản lý như mọi lần nộp lại)
  ung.thu.length = 0;
  await nop(TP_B, dot.b, 'B', { thuan_loi: 'Đã bổ sung giải trình.' });
  await ung.doiThu(2);
  await doi();
  const baoVt = thuTheo(/^\[Đã chỉnh sửa theo đề nghị\]/);
  assert.deepEqual(baoVt.map((t) => t.to), ['vientruong@thu.local']);
  assert.ok(baoVt[0].text.includes(`#/duyet/${dot.id}/${dot.b}`), 'liên kết dẫn thẳng tới báo cáo đó trong màn hình duyệt');
  assert.ok(ung.thu.some((t) => t.to === 'quanly@thu.local' && /nộp lại/.test(t.subject)), 'người quản lý vẫn nhận thư nộp lại như mọi lần');
  // Quyết định cũ hết hiệu lực: bản mới đang chờ Viện trưởng
  const sau = await baoCaoCuaVT(dot.id, dot.b);
  assert.equal(sau.vt_trang_thai, 'cho_quyet_dinh');
  assert.equal(sau.vien_truong, null);
});

test('nộp lại sau khi chính QUẢN LÝ yêu cầu sửa thì KHÔNG báo Viện trưởng (chỉ báo khi đúng báo cáo ông đã đề nghị sửa)', async () => {
  const dot = await taoDot('Đợt quản lý yêu cầu sửa');
  await trinh(dot.id);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.a}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung.' })).s, 200);
  ung.thu.length = 0;
  await nop(TP_A, dot.a, 'A');
  await doi(250);
  assert.equal(thuTheo(/Đã chỉnh sửa theo đề nghị/).length, 0);
  assert.ok(!ung.thu.some((t) => t.to === 'vientruong@thu.local'), 'Viện trưởng không nhận thư mỗi lần phòng nộp');
});

test('phòng nộp lại trong lúc Viện trưởng đang đọc bản cũ: quyết định theo bản cũ bị từ chối (409), không gán nhầm cho bản mới', async () => {
  const dot = await taoDot('Đợt nộp lại khi đang đọc');
  await trinh(dot.id);
  const banCu = (await baoCaoCuaVT(dot.id, dot.a)).nop_luc;
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${dot.a}/yeu-cau-chinh-sua`, { nhan_xet: 'Sửa.' })).s, 200);
  await doi(15); // để nop_luc (ISO, mili giây) của bản mới chắc chắn khác
  await nop(TP_A, dot.a, 'A', { thuan_loi: 'Bản đã sửa.' });
  const r = await quyetDinh(VIEN_TRUONG, dot.a, 'duyet', '', banCu);
  assert.equal(r.s, 409);
  assert.match(r.d.message, /nộp lại|tải lại/);
  assert.equal((await baoCaoCuaVT(dot.id, dot.a)).vt_trang_thai, 'cho_quyet_dinh', 'chưa có quyết định nào được ghi');
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet')).s, 200, 'đọc bản mới rồi quyết định thì được');
});

test('đề nghị chỉnh sửa khi đợt đã ĐÓNG: đợt tự mở lại, ghi vào lịch sử đợt, thư nói rõ; Duyệt / Không duyệt thì không mở lại đợt', async () => {
  const dot = await taoDot('Đợt đã đóng', { phong: [ID.phongA, ID.phongB] });
  await trinh(dot.id);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot.id}/dong`, {})).s, 200);

  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet')).s, 200, 'đợt đóng vẫn duyệt được');
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.b, 'khong_duyet', 'Thiếu số liệu.')).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id)).d.dot.trang_thai, 'dong', 'duyệt / không duyệt không mở lại đợt');

  ung.thu.length = 0;
  const r = await quyet(VIEN_TRUONG, dot.id, dot.a, 'de_nghi_chinh_sua', 'Sửa mục 2.');
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(r.d.dot_mo_lai, true);
  assert.equal((await ung.json(QUAN_LY, 'GET', '/dot/' + dot.id)).d.dot.trang_thai, 'dang_mo');
  const ls = (await ung.json(QUAN_LY, 'GET', `/dot/${dot.id}`)).d.lich_su.find((h) => h.hanh_dong === 'mo_lai_theo_de_nghi');
  assert.ok(ls, 'ghi vào lịch sử đợt');
  assert.match(ls.ghi_chu, /Phòng A/);
  assert.equal(ls.nguoi, 'Phạm Viện Trưởng');
  await ung.doiThu(2);
  await doi();
  assert.match(thuTheo(/đề nghị chỉnh sửa/)[0].text, /đã được mở lại.*đóng lại/);
  assert.equal((await ung.json(TP_A, 'GET', '/bao-cao/' + dot.a)).d.sua_duoc, true, 'phòng sửa được vì đợt đã mở lại');
});

test('xử lý xong báo cáo cuối cùng đang chờ → MỘT thư tổng kết cho người quản lý; đổi ý sau đó không gửi lại thư tổng kết', async () => {
  const dot = await taoDot('Đợt xử lý xong', { phong: [ID.phongA, ID.phongB] });
  await trinh(dot.id);
  ung.thu.length = 0;
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet')).s, 200);
  await doi(200);
  assert.equal(thuTheo(/Viện trưởng đã xử lý/).length, 0, 'còn một báo cáo đang chờ nên chưa tổng kết');

  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.b, 'duyet')).s, 200);
  await ung.doiThu(1);
  await doi();
  const tk = thuTheo(/^\[Viện trưởng đã xử lý\]/);
  assert.equal(tk.length, 1);
  assert.equal(tk[0].to, 'quanly@thu.local');
  assert.match(tk[0].text, /duyệt 2 · không duyệt 0 · đề nghị chỉnh sửa 0/);
  assert.equal(ung.thu.length, 1, 'hai lần Duyệt chỉ sinh đúng một thư (tổng kết), không gửi cho phòng');

  ung.thu.length = 0;
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'khong_duyet', 'Đổi ý.')).s, 200);
  await doi(250);
  assert.equal(thuTheo(/Viện trưởng đã xử lý/).length, 0, 'đổi ý khi không còn gì chờ thì không tổng kết lại');
});

test('email KHÔNG BAO GIỜ làm hỏng quyết định: SMTP lỗi thì quyết định vẫn được ghi; lý do được escape trong thư HTML', async () => {
  const dot = await taoDot('Đợt SMTP', { phong: [ID.phongA] });
  await trinh(dot.id);
  ung.cheDoMail = async () => { throw new Error('SMTP: connection refused'); };
  const r = await quyet(VIEN_TRUONG, dot.id, dot.a, 'khong_duyet', 'Lý do');
  ung.cheDoMail = null;
  assert.equal(r.s, 200, 'không duyệt phải thành công dù không gửi được thư');
  assert.equal((await baoCaoCuaVT(dot.id, dot.a)).vt_trang_thai, 'khong_duyet');

  ung.thu.length = 0;
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'khong_duyet', '<img src=x onerror=alert(1)> độc')).s, 200);
  await ung.doiThu(2);
  await doi();
  const thu = thuTheo(/không duyệt/)[0];
  assert.ok(!thu.html.includes('<img src=x'), 'thẻ HTML thô không được lọt vào thư');
  assert.ok(thu.html.includes('&lt;img'));
});

test('đợt cách nộp "mỗi người một báo cáo": thư chỉ tới ĐÚNG người phụ trách báo cáo đó, đồng nghiệp cùng phòng không nhận', async () => {
  ung.db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'pho_truong_phong')").run(ID.tpA2, ID.phongA);
  const dot = await taoDot('Đợt mỗi người một báo cáo', { phong: [ID.phongA], cachNop: 'tat_ca', khongNop: true });
  const bcA = dot.bc[ID.phongA + ':' + TP_A];
  const bcA2 = dot.bc[ID.phongA + ':' + ID.tpA2];
  assert.ok(bcA && bcA2 && bcA !== bcA2, 'mỗi người một báo cáo riêng');
  await nop(TP_A, bcA, 'Trưởng phòng A');
  await nop(ID.tpA2, bcA2, 'Phó phòng A');
  await trinh(dot.id);
  const bundle = (await ung.json(VIEN_TRUONG, 'GET', `/dot/${dot.id}/vien-truong`)).d;
  assert.equal(bundle.bao_cao.length, 2);
  assert.deepEqual(bundle.bao_cao.map((b) => b.chu_ten).sort(), ['Ngô Phó Phòng A', 'Trần Trưởng Phòng A']);
  assert.ok(bundle.bao_cao.every((b) => b.chuc_danh), 'có chức danh để Viện trưởng biết ai là ai');

  ung.thu.length = 0;
  const r = await quyet(VIEN_TRUONG, dot.id, bcA2, 'khong_duyet', 'Báo cáo của phó phòng thiếu mục kế hoạch.');
  assert.equal(r.s, 200);
  assert.equal(r.d.da_bao, 1);
  await ung.doiThu(2);
  await doi();
  assert.deepEqual(thuTheo(/không duyệt/).map((t) => t.to).sort(), ['quanly@thu.local', 'tpa2@thu.local'], 'chỉ người sở hữu báo cáo, không phải cả phòng');
  assert.equal((await ung.json(TP_A, 'GET', '/bao-cao/' + bcA)).d.vien_truong, null, 'báo cáo của trưởng phòng không bị ảnh hưởng');
  assert.equal((await ung.json(ID.tpA2, 'GET', '/bao-cao/' + bcA2)).d.vien_truong.quyet_dinh, 'khong_duyet');
});

// ══ Việc của Viện trưởng ════════════════════════════════════════════════════════

test('thẻ việc: /tong-quan và /viec-cua-toi cho Viện trưởng biết đợt nào còn bao nhiêu báo cáo chờ; người khác không thấy (hoặc nhận rỗng)', async () => {
  const dot = await taoDot('Đợt cho thẻ việc', { phong: [ID.phongA, ID.phongB] });
  const truoc = (await ung.json(VIEN_TRUONG, 'GET', '/viec-cua-toi')).d;
  assert.ok(!truoc.dot_duyet.some((x) => x.dot_id === dot.id), 'chưa trình thì chưa phải việc của Viện trưởng');
  await trinh(dot.id, 'Mời Viện trưởng xem.');
  const vc = (await ung.json(VIEN_TRUONG, 'GET', '/viec-cua-toi')).d;
  const x = vc.dot_duyet.find((y) => y.dot_id === dot.id);
  assert.ok(x);
  assert.equal(x.tieu_de, 'Đợt cho thẻ việc');
  assert.equal(x.cho_quyet_dinh, 2);
  assert.equal(x.tong, 2);
  assert.equal(x.nguoi_trinh, 'Nguyễn Quản Lý');
  assert.equal(x.loi_nhan, 'Mời Viện trưởng xem.');
  for (const uid of [QUAN_LY, ADMIN, TP_A, NGOAI]) {
    assert.deepEqual((await ung.json(uid, 'GET', '/viec-cua-toi')).d.dot_duyet, [], 'user ' + uid + ' không có việc duyệt');
  }
  const tq = (await ung.json(VIEN_TRUONG, 'GET', '/tong-quan')).d;
  assert.ok(tq.bao_cao_cho_vien_truong >= 2);
  assert.equal(tq.dot_cho_vien_truong.find((y) => y.dot_id === dot.id).cho_quyet_dinh, 2);
  const chiTiet = tq.chi_tiet.find((y) => y.dot_id === dot.id);
  assert.equal(chiTiet.da_trinh, true);
  assert.equal(chiTiet.vt.cho_quyet_dinh, 2);

  // Quyết định hết thì đợt rời khỏi danh sách chờ
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet')).s, 200);
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.b, 'duyet')).s, 200);
  assert.ok(!(await ung.json(VIEN_TRUONG, 'GET', '/viec-cua-toi')).d.dot_duyet.some((y) => y.dot_id === dot.id));
  assert.equal((await ung.json(TP_A, 'GET', '/tong-quan')).s, 403, 'trưởng phòng vẫn không xem được tổng quan');
});

test('ý kiến vẫn dùng đường sẵn có và trả về nội dung vừa tạo để màn hình duyệt thêm vào ngay', async () => {
  const dot = ID.dotChinh;
  const r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${dot.a}/y-kien`, { noi_dung: 'Đề nghị làm rõ chỉ tiêu quý 4.' });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal(r.d.y_kien.noi_dung, 'Đề nghị làm rõ chỉ tiêu quý 4.');
  assert.equal(r.d.y_kien.nguoi, 'Phạm Viện Trưởng');
  assert.ok(r.d.y_kien.tao_luc);
  const bc = await baoCaoCuaVT(dot.id, dot.a);
  assert.equal(bc.y_kien.length, 1);
  assert.equal(bc.vt_trang_thai, 'duyet', 'ý kiến không đổi quyết định');
  assert.equal((await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${dot.c}/y-kien`, { noi_dung: 'x' })).s, 409, 'phòng chưa nộp thì chưa góp ý được');
});

test('danh sách đợt cho người quản lý phân biệt đợt ĐÃ TRÌNH và CHƯA TRÌNH (kèm lần trình và tiến độ của Viện trưởng)', async () => {
  const dot = await taoDot('Đợt để phân biệt trình', { phong: [ID.phongA, ID.phongB] });
  const dong = async () => (await ung.json(QUAN_LY, 'GET', '/dot')).d.dot.find((x) => x.id === dot.id);
  let x = await dong();
  assert.equal(x.da_trinh, false);
  assert.equal(x.trinh_lan, 0);
  assert.equal(x.vt, null);
  await trinh(dot.id);
  x = await dong();
  assert.equal(x.da_trinh, true);
  assert.equal(x.trinh_lan, 1);
  assert.ok(x.trinh_luc);
  assert.equal(x.vt.cho_quyet_dinh, 2);
  assert.equal((await quyet(VIEN_TRUONG, dot.id, dot.a, 'duyet')).s, 200);
  assert.equal((await dong()).vt.duyet, 1);
  await trinh(dot.id);
  assert.equal((await dong()).trinh_lan, 2);
  const tq = (await ung.json(QUAN_LY, 'GET', '/tong-quan')).d.chi_tiet.find((y) => y.dot_id === dot.id);
  assert.equal(tq.da_trinh, true);
});

test('nhiều biểu mẫu: nhân bản tạo biểu mẫu mới từ cấu trúc của mẫu gốc; xóa chỉ khi chưa đợt nào dùng; chỉ người quản lý module', async () => {
  for (const uid of [VIEN_TRUONG, TP_A, NGOAI]) {
    assert.equal((await ung.json(uid, 'POST', `/mau/${ID.mau}/nhan-ban`, {})).s, 403, 'user ' + uid);
    assert.equal((await ung.json(uid, 'DELETE', `/mau/${ID.mau}`)).s, 403);
  }
  const goc = (await ung.json(QUAN_LY, 'GET', '/mau/' + ID.mau)).d;
  const r = await ung.json(QUAN_LY, 'POST', `/mau/${ID.mau}/nhan-ban`, {});
  assert.equal(r.s, 201, JSON.stringify(r.d));
  const ban = (await ung.json(QUAN_LY, 'GET', '/mau/' + r.d.id)).d;
  assert.equal(ban.ten, goc.ten + ' (bản sao)');
  assert.deepEqual(ban.truong, goc.truong, 'cùng cấu trúc ô');
  assert.equal(ban.so_phien_ban, 1);
  const ds = (await ung.json(QUAN_LY, 'GET', '/mau')).d.mau;
  assert.ok(ds.length >= 2, 'lưu được nhiều biểu mẫu');
  // dùng mẫu mới cho một đợt khác
  const dot = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt dùng mẫu khác', han_nop: '2099-12-31', mau_id: r.d.id, phong_ids: [ID.phongA] });
  assert.equal(dot.s, 201);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/mau/' + r.d.id)).s, 409, 'đã có đợt dùng thì không xóa');
  const r2 = await ung.json(QUAN_LY, 'POST', `/mau/${ID.mau}/nhan-ban`, {});
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/mau/' + r2.d.id)).s, 200, 'mẫu chưa dùng thì xóa được');
  assert.equal((await ung.json(QUAN_LY, 'GET', '/mau/' + r2.d.id)).s, 404);
  assert.equal((await ung.json(QUAN_LY, 'POST', '/mau/999999/nhan-ban', {})).s, 404);
});
