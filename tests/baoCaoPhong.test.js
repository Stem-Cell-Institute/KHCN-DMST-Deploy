/**
 * tests/baoCaoPhong.test.js
 * Test tích hợp cho module Báo cáo phòng ban, chạy trên server thật trong hộp cát.
 *
 * Trọng tâm là RANH GIỚI QUYỀN: trưởng phòng A không được thấy hay ghi báo cáo của phòng B,
 * người quản lý không được nhập hộ, người ngoài không được chạm vào gì. Đây là chỗ sai thì
 * hậu quả là lộ/sửa báo cáo của phòng khác, nên mỗi ranh giới có một test riêng.
 */

// node --test chạy các file song song: dùng cổng riêng để khỏi đụng smoke.test.js (3199).
process.env.TEST_PORT = process.env.TEST_PORT_BCP || '3217';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startTestServer, call } = require('./helpers/testServer');

let srv;
const T = {}; // token theo vai
const ID = {}; // id theo vai/đối tượng

const get = (p, tk) => call(srv.baseUrl, p, { token: tk });
const post = (p, tk, body) => call(srv.baseUrl, p, { token: tk, method: 'POST', body: body === undefined ? {} : body });
const put = (p, tk, body) => call(srv.baseUrl, p, { token: tk, method: 'PUT', body });
const del = (p, tk) => call(srv.baseUrl, p, { token: tk, method: 'DELETE' });
const json = async (res) => res.json();

test.before(async () => {
  srv = await startTestServer();
  const root = path.resolve(__dirname, '..');
  const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
  const jwt = require(path.join(root, 'node_modules', 'jsonwebtoken'));
  const db = new Database(srv.dbPath, { readonly: true });
  const nguoi = db.prepare("SELECT id, email, role FROM users WHERE lower(role) <> 'admin' ORDER BY id LIMIT 4").all();
  db.close();
  assert.ok(nguoi.length >= 4, 'DB test cần ít nhất 4 tài khoản không phải admin');

  const ky = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  T.admin = srv.tokens.admin;
  [ID.truongA, ID.truongB, ID.quanLy, ID.nguoiNgoai] = nguoi.map((u) => u.id);
  [T.truongA, T.truongB, T.quanLy, T.nguoiNgoai] = nguoi.map(ky);
});

test.after(async () => {
  if (srv) await srv.stop();
});

// Một biểu mẫu dùng chung cho cả file.
const TRUONG = [
  { key: 'cong_viec', kieu: 'textarea', nhan: 'Công việc đã thực hiện', bat_buoc: true },
  { key: 'so_cuoc_hop', kieu: 'number', nhan: 'Số cuộc họp', min: 0, max: 1000 },
  { key: 'danh_gia', kieu: 'select', nhan: 'Tự đánh giá', lua_chon: ['Tốt', 'Đạt', 'Chưa đạt'] },
];

// ── 1. Xác thực + người ngoài ───────────────────────────────────────────────

test('không token thì 401 trên mọi đường của module', async () => {
  for (const p of ['/api/bao-cao-phong/me', '/api/bao-cao-phong/dot', '/api/bao-cao-phong/cua-toi']) {
    assert.equal((await call(srv.baseUrl, p)).status, 401, p);
  }
});

test('người chưa được cấp vai trò: không có quyền, và bị chặn khỏi mọi thao tác quản lý', async () => {
  const me = await json(await get('/api/bao-cao-phong/me', T.nguoiNgoai));
  assert.equal(me.co_quyen, false);
  assert.equal(me.quan_ly, false);
  for (const p of ['/dot', '/mau', '/phong', '/thanh-vien', '/nguoi-dung?q=ab']) {
    assert.equal((await get('/api/bao-cao-phong' + p, T.nguoiNgoai)).status, 403, 'GET ' + p);
  }
  assert.equal((await post('/api/bao-cao-phong/dot', T.nguoiNgoai, {})).status, 403);
  assert.deepEqual((await json(await get('/api/bao-cao-phong/cua-toi', T.nguoiNgoai))).bao_cao, []);
});

// ── 2. Dựng phòng, phân quyền ───────────────────────────────────────────────

test('admin tạo phòng; trùng tên bị 409; mã sai định dạng bị 400', async () => {
  let r = await post('/api/bao-cao-phong/phong', T.admin, { ten: 'Phòng Test A', ma: 'test-a' });
  assert.equal(r.status, 201);
  ID.phongA = (await json(r)).id;
  r = await post('/api/bao-cao-phong/phong', T.admin, { ten: 'Phòng Test B', ma: 'test-b' });
  ID.phongB = (await json(r)).id;
  assert.equal((await post('/api/bao-cao-phong/phong', T.admin, { ten: 'Phòng Test A' })).status, 409);
  assert.equal((await post('/api/bao-cao-phong/phong', T.admin, { ten: 'X', ma: 'Có Dấu!' })).status, 400);
});

test('chỉ admin cấp được vai trò quản lý; người quản lý thì không tự nhân bản quyền', async () => {
  let r = await post('/api/bao-cao-phong/thanh-vien', T.admin, { user_id: ID.quanLy, vai_tro: 'quan_ly' });
  assert.equal(r.status, 201);
  ID.tvQuanLy = (await json(r)).id;

  // người quản lý (không phải admin) thử cấp quyền quản lý cho người ngoài → 403
  r = await post('/api/bao-cao-phong/thanh-vien', T.quanLy, { user_id: ID.nguoiNgoai, vai_tro: 'quan_ly' });
  assert.equal(r.status, 403);
  // nhưng gán trưởng phòng thì được
  r = await post('/api/bao-cao-phong/thanh-vien', T.quanLy, { user_id: ID.truongA, vai_tro: 'truong_phong', phong_id: ID.phongA });
  assert.equal(r.status, 201);
  r = await post('/api/bao-cao-phong/thanh-vien', T.quanLy, { user_id: ID.truongB, vai_tro: 'truong_phong', phong_id: ID.phongB });
  assert.equal(r.status, 201);
  // gán trùng → 409
  r = await post('/api/bao-cao-phong/thanh-vien', T.quanLy, { user_id: ID.truongA, vai_tro: 'truong_phong', phong_id: ID.phongA });
  assert.equal(r.status, 409);
});

test('trưởng phòng gọi được /me nhưng không vào được phần quản lý', async () => {
  const me = await json(await get('/api/bao-cao-phong/me', T.truongA));
  assert.equal(me.co_quyen, true);
  assert.equal(me.quan_ly, false);
  assert.equal(me.phong.length, 1);
  assert.equal(me.phong[0].id, ID.phongA);
  assert.equal((await get('/api/bao-cao-phong/dot', T.truongA)).status, 403);
  assert.equal((await post('/api/bao-cao-phong/dot', T.truongA, {})).status, 403);
});

// ── 3. Biểu mẫu: phiên bản bất biến ─────────────────────────────────────────

test('tạo biểu mẫu; sửa cấu trúc sinh phiên bản mới, sửa y nguyên thì không', async () => {
  let r = await post('/api/bao-cao-phong/mau', T.quanLy, { ten: 'Báo cáo tháng', truong: TRUONG });
  assert.equal(r.status, 201);
  ID.mau = (await json(r)).id;

  assert.equal((await post('/api/bao-cao-phong/mau', T.quanLy, { ten: 'Hỏng', truong: [] })).status, 400);

  const hienTai = await json(await get('/api/bao-cao-phong/mau/' + ID.mau, T.quanLy));
  assert.equal(hienTai.so_phien_ban, 1);

  // gửi lại đúng cấu trúc cũ → không đẻ phiên bản mới
  r = await json(await put('/api/bao-cao-phong/mau/' + ID.mau, T.quanLy, { ten: 'Báo cáo tháng', truong: hienTai.truong }));
  assert.equal(r.da_doi_cau_truc, false);
  assert.equal(r.so_phien_ban, 1);

  // thêm một ô → phiên bản 2
  const them = [...hienTai.truong, { kieu: 'textarea', nhan: 'Kiến nghị' }];
  r = await json(await put('/api/bao-cao-phong/mau/' + ID.mau, T.quanLy, { ten: 'Báo cáo tháng', truong: them }));
  assert.equal(r.da_doi_cau_truc, true);
  assert.equal(r.so_phien_ban, 2);
});

// ── 4. Đợt: nháp ẩn với trưởng phòng ────────────────────────────────────────

test('tạo đợt cho hai phòng; ở trạng thái Nháp thì trưởng phòng KHÔNG thấy', async () => {
  // Dùng phiên bản 1 trước khi sửa mẫu? Đợt ghim phiên bản MỚI NHẤT lúc tạo (=2). Kiểm ở test sau.
  const r = await post('/api/bao-cao-phong/dot', T.quanLy, {
    tieu_de: 'Báo cáo tháng 10',
    loai: 'thang',
    ky: '10/2026',
    han_nop: '2099-12-31',
    mau_id: ID.mau,
    phong_ids: [ID.phongA, ID.phongB],
  });
  assert.equal(r.status, 201);
  ID.dot = (await json(r)).id;

  const ct = await json(await get('/api/bao-cao-phong/dot/' + ID.dot, T.quanLy));
  assert.equal(ct.dot.trang_thai, 'nhap');
  assert.equal(ct.bao_cao.length, 2);
  ID.bcA = ct.bao_cao.find((b) => b.phong_id === ID.phongA).id;
  ID.bcB = ct.bao_cao.find((b) => b.phong_id === ID.phongB).id;
  assert.equal(ct.dot.so_phien_ban, 2, 'đợt ghim phiên bản mới nhất lúc tạo');

  assert.deepEqual((await json(await get('/api/bao-cao-phong/cua-toi', T.truongA))).bao_cao, []);
  assert.equal((await get('/api/bao-cao-phong/bao-cao/' + ID.bcA, T.truongA)).status, 404, 'báo cáo của đợt Nháp phải ẩn');
});

test('dữ liệu đợt không hợp lệ bị từ chối', async () => {
  const base = { tieu_de: 'X', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA] };
  assert.equal((await post('/api/bao-cao-phong/dot', T.quanLy, { ...base, tieu_de: '' })).status, 400);
  assert.equal((await post('/api/bao-cao-phong/dot', T.quanLy, { ...base, han_nop: '2099-02-30' })).status, 400);
  assert.equal((await post('/api/bao-cao-phong/dot', T.quanLy, { ...base, phong_ids: [] })).status, 400);
  assert.equal((await post('/api/bao-cao-phong/dot', T.quanLy, { ...base, phong_ids: [999999] })).status, 400);
  assert.equal((await post('/api/bao-cao-phong/dot', T.quanLy, { ...base, mau_id: 999999 })).status, 400);
  assert.equal((await post('/api/bao-cao-phong/dot', T.quanLy, { ...base, loai: 'khong-co' })).status, 400);
});

// ── 5. Mở đợt → ranh giới giữa hai phòng ────────────────────────────────────

test('mở đợt; mở lần hai bị 409', async () => {
  assert.equal((await post(`/api/bao-cao-phong/dot/${ID.dot}/mo`, T.quanLy)).status, 200);
  assert.equal((await post(`/api/bao-cao-phong/dot/${ID.dot}/mo`, T.quanLy)).status, 409);
});

test('trưởng phòng A chỉ thấy báo cáo của phòng A', async () => {
  const a = (await json(await get('/api/bao-cao-phong/cua-toi', T.truongA))).bao_cao;
  assert.equal(a.length, 1);
  assert.equal(a[0].id, ID.bcA);
  const b = (await json(await get('/api/bao-cao-phong/cua-toi', T.truongB))).bao_cao;
  assert.equal(b.length, 1);
  assert.equal(b[0].id, ID.bcB);
});

test('trưởng phòng A KHÔNG đọc/ghi/nộp được báo cáo của phòng B (404, không lộ sự tồn tại)', async () => {
  assert.equal((await get('/api/bao-cao-phong/bao-cao/' + ID.bcB, T.truongA)).status, 404);
  assert.equal((await put(`/api/bao-cao-phong/bao-cao/${ID.bcB}/du-lieu`, T.truongA, { du_lieu: { cong_viec: 'phá' } })).status, 404);
  assert.equal((await post(`/api/bao-cao-phong/bao-cao/${ID.bcB}/nop`, T.truongA, { du_lieu: { cong_viec: 'phá' } })).status, 404);
  // 404 cho id không tồn tại cũng giống hệt → không phân biệt được "có" và "không được xem"
  assert.equal((await get('/api/bao-cao-phong/bao-cao/99999999', T.truongA)).status, 404);
  // và dữ liệu phòng B còn nguyên
  const b = await json(await get('/api/bao-cao-phong/bao-cao/' + ID.bcB, T.truongB));
  assert.deepEqual(b.du_lieu, {});
});

test('người ngoài không đọc được báo cáo nào', async () => {
  assert.equal((await get('/api/bao-cao-phong/bao-cao/' + ID.bcA, T.nguoiNgoai)).status, 404);
});

// ── 6. Nhập, nộp ────────────────────────────────────────────────────────────

test('lưu nháp: số sai bị 422; hợp lệ thì lưu; khóa lạ bị bỏ', async () => {
  const url = `/api/bao-cao-phong/bao-cao/${ID.bcA}/du-lieu`;
  let r = await put(url, T.truongA, { du_lieu: { so_cuoc_hop: 'nhiều' } });
  assert.equal(r.status, 422);
  assert.ok((await json(r)).loi.so_cuoc_hop);

  r = await put(url, T.truongA, { du_lieu: { cong_viec: 'Đã làm A', so_cuoc_hop: 3, quyen_admin: true } });
  assert.equal(r.status, 200);
  const doc = await json(await get('/api/bao-cao-phong/bao-cao/' + ID.bcA, T.truongA));
  assert.equal(doc.du_lieu.cong_viec, 'Đã làm A');
  assert.equal(doc.du_lieu.so_cuoc_hop, 3);
  assert.equal('quyen_admin' in doc.du_lieu, false, 'khóa lạ không được lưu');
  assert.equal(doc.trang_thai, 'chua_nop', 'lưu nháp chưa làm báo cáo thành Đã nộp');
});

test('người quản lý KHÔNG nhập hộ được (chỉ chủ phòng mới nhập)', async () => {
  const r = await put(`/api/bao-cao-phong/bao-cao/${ID.bcA}/du-lieu`, T.quanLy, { du_lieu: { cong_viec: 'nhập hộ' } });
  assert.equal(r.status, 404);
  assert.equal((await put(`/api/bao-cao-phong/bao-cao/${ID.bcA}/du-lieu`, T.admin, { du_lieu: { cong_viec: 'nhập hộ' } })).status, 404);
});

test('nộp thiếu ô bắt buộc bị 422 kèm danh sách lỗi; báo cáo vẫn chưa nộp', async () => {
  const r = await post(`/api/bao-cao-phong/bao-cao/${ID.bcB}/nop`, T.truongB, { du_lieu: { so_cuoc_hop: 1 } });
  assert.equal(r.status, 422);
  assert.ok((await json(r)).loi.cong_viec);
  const doc = await json(await get('/api/bao-cao-phong/bao-cao/' + ID.bcB, T.truongB));
  assert.equal(doc.trang_thai, 'chua_nop');
});

test('nộp đủ thì thành Đã nộp; sau đó không sửa/nộp lại được (409)', async () => {
  let r = await post(`/api/bao-cao-phong/bao-cao/${ID.bcA}/nop`, T.truongA);
  assert.equal(r.status, 200, 'nộp bản đã lưu nháp (client không gửi kèm dữ liệu)');
  const doc = await json(await get('/api/bao-cao-phong/bao-cao/' + ID.bcA, T.truongA));
  assert.equal(doc.trang_thai, 'da_nop');
  assert.equal(doc.sua_duoc, false);
  assert.equal(doc.lich_su.length, 1);

  r = await put(`/api/bao-cao-phong/bao-cao/${ID.bcA}/du-lieu`, T.truongA, { du_lieu: { cong_viec: 'sửa sau khi nộp' } });
  assert.equal(r.status, 409);
  r = await post(`/api/bao-cao-phong/bao-cao/${ID.bcA}/nop`, T.truongA);
  assert.equal(r.status, 409);
});

// ── 7. Duyệt / yêu cầu chỉnh sửa ────────────────────────────────────────────

test('trưởng phòng không tự duyệt được báo cáo của mình', async () => {
  assert.equal((await post(`/api/bao-cao-phong/bao-cao/${ID.bcA}/duyet`, T.truongA)).status, 403);
  assert.equal((await post(`/api/bao-cao-phong/bao-cao/${ID.bcA}/yeu-cau-chinh-sua`, T.truongA, { nhan_xet: 'x' })).status, 403);
});

test('không duyệt được báo cáo chưa nộp (409)', async () => {
  assert.equal((await post(`/api/bao-cao-phong/bao-cao/${ID.bcB}/duyet`, T.quanLy)).status, 409);
});

test('yêu cầu chỉnh sửa phải kèm nhận xét; sau đó trưởng phòng sửa được và nộp lại', async () => {
  const url = `/api/bao-cao-phong/bao-cao/${ID.bcA}/yeu-cau-chinh-sua`;
  assert.equal((await post(url, T.quanLy, {})).status, 400);
  assert.equal((await post(url, T.quanLy, { nhan_xet: '   ' })).status, 400);

  let r = await post(url, T.quanLy, { nhan_xet: 'Bổ sung số liệu tháng trước' });
  assert.equal(r.status, 200);

  let doc = await json(await get('/api/bao-cao-phong/bao-cao/' + ID.bcA, T.truongA));
  assert.equal(doc.trang_thai, 'can_chinh_sua');
  assert.equal(doc.nhan_xet, 'Bổ sung số liệu tháng trước');
  assert.equal(doc.sua_duoc, true);

  r = await put(`/api/bao-cao-phong/bao-cao/${ID.bcA}/du-lieu`, T.truongA, { du_lieu: { cong_viec: 'Đã bổ sung', so_cuoc_hop: 4 } });
  assert.equal(r.status, 200);
  r = await post(`/api/bao-cao-phong/bao-cao/${ID.bcA}/nop`, T.truongA);
  assert.equal(r.status, 200);

  doc = await json(await get('/api/bao-cao-phong/bao-cao/' + ID.bcA, T.truongA));
  assert.equal(doc.trang_thai, 'da_nop');
  assert.equal(doc.du_lieu.cong_viec, 'Đã bổ sung');
  assert.deepEqual(doc.lich_su.map((h) => h.hanh_dong), ['nop', 'yeu_cau_chinh_sua', 'nop_lai']);
});

test('duyệt: chỉ một lần thắng, lần hai bị 409', async () => {
  const url = `/api/bao-cao-phong/bao-cao/${ID.bcA}/duyet`;
  assert.equal((await post(url, T.quanLy, { nhan_xet: 'Đạt' })).status, 200);
  assert.equal((await post(url, T.admin)).status, 409, 'báo cáo đã duyệt rồi');
  const doc = await json(await get('/api/bao-cao-phong/bao-cao/' + ID.bcA, T.truongA));
  assert.equal(doc.trang_thai, 'da_duyet');
  assert.equal(doc.sua_duoc, false);
  // trưởng phòng không sửa được báo cáo đã duyệt
  assert.equal((await put(`/api/bao-cao-phong/bao-cao/${ID.bcA}/du-lieu`, T.truongA, { du_lieu: { cong_viec: 'lén sửa' } })).status, 409);
});

// ── 8. Đóng đợt, hạn nộp ────────────────────────────────────────────────────

test('đóng đợt: trưởng phòng không nhập/nộp được nữa; mở lại thì được', async () => {
  assert.equal((await post(`/api/bao-cao-phong/dot/${ID.dot}/dong`, T.quanLy)).status, 200);
  assert.equal((await put(`/api/bao-cao-phong/bao-cao/${ID.bcB}/du-lieu`, T.truongB, { du_lieu: { cong_viec: 'trễ' } })).status, 409);
  assert.equal((await post(`/api/bao-cao-phong/bao-cao/${ID.bcB}/nop`, T.truongB, { du_lieu: { cong_viec: 'trễ' } })).status, 409);
  // yêu cầu chỉnh sửa trên đợt đã đóng cũng bị chặn (vô nghĩa vì người ta không sửa được)
  assert.equal((await post(`/api/bao-cao-phong/bao-cao/${ID.bcA}/yeu-cau-chinh-sua`, T.quanLy, { nhan_xet: 'x' })).status, 409);
  // trưởng phòng vẫn đọc được báo cáo của đợt đã đóng
  assert.equal((await get('/api/bao-cao-phong/bao-cao/' + ID.bcB, T.truongB)).status, 200);

  assert.equal((await post(`/api/bao-cao-phong/dot/${ID.dot}/mo-lai`, T.quanLy)).status, 200);
  assert.equal((await put(`/api/bao-cao-phong/bao-cao/${ID.bcB}/du-lieu`, T.truongB, { du_lieu: { cong_viec: 'ok' } })).status, 200);
});

test('quá hạn mà chưa nộp thì tính là trễ hạn (theo ngày giờ Việt Nam)', async () => {
  const r = await post('/api/bao-cao-phong/dot', T.quanLy, {
    tieu_de: 'Đợt đã quá hạn',
    han_nop: '2020-01-01',
    mau_id: ID.mau,
    phong_ids: [ID.phongA],
  });
  const dotId = (await json(r)).id;
  await post(`/api/bao-cao-phong/dot/${dotId}/mo`, T.quanLy);
  const ds = (await json(await get('/api/bao-cao-phong/cua-toi', T.truongA))).bao_cao;
  const bc = ds.find((x) => x.dot_id === dotId);
  assert.equal(bc.tre_han, true);
  const list = (await json(await get('/api/bao-cao-phong/dot', T.quanLy))).dot.find((d) => d.id === dotId);
  assert.equal(list.tre_han, 1);
  assert.equal(list.chua_nop, 1);
});

// ── 9. Xóa, gỡ quyền ────────────────────────────────────────────────────────

test('chỉ xóa được đợt Nháp', async () => {
  assert.equal((await del('/api/bao-cao-phong/dot/' + ID.dot, T.quanLy)).status, 409, 'đợt đang mở không được xóa');
  const r = await post('/api/bao-cao-phong/dot', T.quanLy, { tieu_de: 'Nháp', han_nop: '2099-01-01', mau_id: ID.mau, phong_ids: [ID.phongB] });
  const nhap = (await json(r)).id;
  assert.equal((await del('/api/bao-cao-phong/dot/' + nhap, T.quanLy)).status, 200);
  assert.equal((await del('/api/bao-cao-phong/dot/' + nhap, T.quanLy)).status, 404);
});

test('gỡ vai trò trưởng phòng thì mất quyền ngay; người quản lý không gỡ được vai trò quản lý', async () => {
  const tv = (await json(await get('/api/bao-cao-phong/thanh-vien', T.quanLy))).thanh_vien;
  const cuaB = tv.find((x) => x.user_id === ID.truongB && x.vai_tro === 'truong_phong');
  assert.equal((await del('/api/bao-cao-phong/thanh-vien/' + cuaB.id, T.quanLy)).status, 200);
  assert.equal((await get('/api/bao-cao-phong/bao-cao/' + ID.bcB, T.truongB)).status, 404, 'mất quyền thì hết thấy');
  assert.deepEqual((await json(await get('/api/bao-cao-phong/cua-toi', T.truongB))).bao_cao, []);

  assert.equal((await del('/api/bao-cao-phong/thanh-vien/' + ID.tvQuanLy, T.quanLy)).status, 403);
  assert.equal((await del('/api/bao-cao-phong/thanh-vien/' + ID.tvQuanLy, T.admin)).status, 200);
  assert.equal((await get('/api/bao-cao-phong/dot', T.quanLy)).status, 403, 'hết là quản lý thì hết vào được phần quản lý');
});

test('tìm người dùng: ký tự đại diện LIKE không khớp tất cả', async () => {
  const r = await json(await get('/api/bao-cao-phong/nguoi-dung?q=%25%25', T.admin));
  assert.deepEqual(r.nguoi_dung, [], '"%%" phải được coi là văn bản thường, không phải wildcard');
  assert.deepEqual((await json(await get('/api/bao-cao-phong/nguoi-dung?q=a', T.admin))).nguoi_dung, [], 'dưới 2 ký tự thì không tìm');
});
