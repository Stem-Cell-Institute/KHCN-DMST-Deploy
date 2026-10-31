/**
 * tests/baoCaoPhongCachNop.test.js
 * Cách nộp của đợt khi một phòng có nhiều người phụ trách:
 *   mot_nguoi (mặc định, như cũ): một báo cáo chung của phòng, ai nộp cũng được.
 *   tat_ca: mỗi người phụ trách một báo cáo RIÊNG; phòng hoàn thành khi mọi người đã nộp.
 * Trọng tâm: mỗi người chỉ thấy/nộp báo cáo của mình, người mới/người bị gỡ được đồng bộ đúng, thư gửi đúng người,
 * và việc chuyển bảng cũ (UNIQUE (dot_id, phong_id)) không làm mất dữ liệu.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const { ensureSchema } = require('../services/baoCaoPhongSchema');
const { dungUngDung } = require('./helpers/baoCaoPhongApp');

const ADMIN = 1;
const QUAN_LY = 2;
const VIEN_TRUONG = 3;
const TP_A = 4; // phòng A, Trưởng phòng
const TP_B = 5; // phòng A, Phó trưởng phòng
const KE_TOAN = 6; // phòng B, Kế toán

let ung;
const ID = {};

const DU_LIEU = (ten) => ({
  nguoi_phu_trach: ten, ky_tu_ngay: '2026-09-04', ky_den_ngay: '2026-10-04', tu_danh_gia: 'B',
  cv_thuong_xuyen: [{ nhom: 'Quản lý KHCN' }, { o: { hang_muc: 'KPI năm', muc_do: 100 } }],
});

test.before(async () => {
  ung = await dungUngDung();
  const { db } = ung;
  ID.phongA = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run().lastInsertRowid);
  ID.phongB = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('b','Phòng B')").run().lastInsertRowid);
  ID.phongC = Number(db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('c','Phòng C (chưa có người)')").run().lastInsertRowid);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'quan_ly')").run(QUAN_LY);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro) VALUES (?, 'vien_truong')").run(VIEN_TRUONG);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'truong_phong')").run(TP_A, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'pho_truong_phong')").run(TP_B, ID.phongA);
  db.prepare("INSERT INTO bcp_thanh_vien (user_id, vai_tro, phong_id, chuc_danh) VALUES (?, 'truong_phong', ?, 'ke_toan')").run(KE_TOAN, ID.phongB);
  ID.mau = db.prepare('SELECT id FROM bcp_mau ORDER BY id LIMIT 1').get().id;
});

test.after(async () => {
  if (ung) await ung.dung();
});

const doi = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const hang = (dotId) => ung.db.prepare('SELECT id, phong_id, chu_id, trang_thai FROM bcp_bao_cao WHERE dot_id = ? ORDER BY phong_id, chu_id').all(dotId);

async function taoDot(tieuDe, phongIds, cachNop, mo = true) {
  const r = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: tieuDe, loai: 'thang', ky: '10/2026', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: phongIds, ...(cachNop ? { cach_nop: cachNop } : {}) });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  if (mo) assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${r.d.id}/mo`, {})).s, 200);
  if (mo) ung.daTrinh(r.d.id);
  await doi();
  ung.thu.length = 0;
  return r.d.id;
}
async function nop(uid, id, ten) {
  const a = await ung.json(uid, 'PUT', `/bao-cao/${id}/du-lieu`, { du_lieu: DU_LIEU(ten) });
  assert.equal(a.s, 200, JSON.stringify(a.d));
  return ung.json(uid, 'POST', `/bao-cao/${id}/nop`, {});
}
const cuaToi = async (uid) => (await ung.json(uid, 'GET', '/cua-toi')).d.bao_cao;

// ── Chuyển bảng cũ ───────────────────────────────────────────────────────────

test('nâng cấp bảng báo cáo kiểu cũ (UNIQUE dot+phong): giữ nguyên dữ liệu và bảng con, rồi cho phép nhiều báo cáo một phòng', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, fullname TEXT, role TEXT)');
  db.prepare("INSERT INTO users VALUES (1,'a@x','A','researcher')").run();
  db.exec("CREATE TABLE bcp_phong (id INTEGER PRIMARY KEY AUTOINCREMENT, ma TEXT UNIQUE, ten TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT)");
  db.exec("CREATE TABLE bcp_mau (id INTEGER PRIMARY KEY AUTOINCREMENT, ten TEXT NOT NULL, mo_ta TEXT, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE bcp_mau_phien_ban (id INTEGER PRIMARY KEY AUTOINCREMENT, mau_id INTEGER NOT NULL, so_phien_ban INTEGER NOT NULL, truong_json TEXT NOT NULL, created_by INTEGER, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (mau_id) REFERENCES bcp_mau(id))");
  db.exec(`CREATE TABLE bcp_dot (id INTEGER PRIMARY KEY AUTOINCREMENT, tieu_de TEXT NOT NULL, mo_ta TEXT, loai TEXT NOT NULL DEFAULT 'thang', ky TEXT, han_nop TEXT NOT NULL,
    mau_phien_ban_id INTEGER NOT NULL, trang_thai TEXT NOT NULL DEFAULT 'nhap', created_by INTEGER, created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mau_phien_ban_id) REFERENCES bcp_mau_phien_ban(id))`);
  // Bảng báo cáo đúng như phiên bản đầu (có UNIQUE, chưa có chu_id) + bảng con tham chiếu nó với ON DELETE CASCADE
  db.exec(`CREATE TABLE bcp_bao_cao (
    id INTEGER PRIMARY KEY AUTOINCREMENT, dot_id INTEGER NOT NULL, phong_id INTEGER NOT NULL,
    trang_thai TEXT NOT NULL DEFAULT 'chua_nop' CHECK (trang_thai IN ('chua_nop','da_nop','can_chinh_sua','da_duyet')),
    du_lieu_json TEXT NOT NULL DEFAULT '{}', nguoi_nop_id INTEGER, nop_luc TEXT, nguoi_duyet_id INTEGER, duyet_luc TEXT, nhan_xet TEXT,
    cap_nhat_luc TEXT DEFAULT (datetime('now')), UNIQUE (dot_id, phong_id),
    FOREIGN KEY (dot_id) REFERENCES bcp_dot(id) ON DELETE CASCADE, FOREIGN KEY (phong_id) REFERENCES bcp_phong(id),
    FOREIGN KEY (nguoi_nop_id) REFERENCES users(id) ON DELETE SET NULL, FOREIGN KEY (nguoi_duyet_id) REFERENCES users(id) ON DELETE SET NULL)`);
  db.exec(`CREATE TABLE bcp_lich_su (id INTEGER PRIMARY KEY AUTOINCREMENT, bao_cao_id INTEGER NOT NULL, hanh_dong TEXT NOT NULL, nguoi_id INTEGER, ghi_chu TEXT,
    tao_luc TEXT DEFAULT (datetime('now')), FOREIGN KEY (bao_cao_id) REFERENCES bcp_bao_cao(id) ON DELETE CASCADE)`);
  db.prepare("INSERT INTO bcp_mau (ten) VALUES ('m')").run();
  db.prepare("INSERT INTO bcp_mau_phien_ban (mau_id, so_phien_ban, truong_json) VALUES (1, 1, '[]')").run();
  db.prepare("INSERT INTO bcp_phong (ma, ten) VALUES ('a','Phòng A')").run();
  db.prepare("INSERT INTO bcp_dot (tieu_de, han_nop, mau_phien_ban_id) VALUES ('Đợt cũ','2099-12-31',1)").run();
  db.prepare("INSERT INTO bcp_bao_cao (dot_id, phong_id, trang_thai, du_lieu_json, nguoi_nop_id) VALUES (1,1,'da_nop','{\"x\":1}',1)").run();
  db.prepare("INSERT INTO bcp_lich_su (bao_cao_id, hanh_dong) VALUES (1,'nop')").run();

  ensureSchema(db);
  ensureSchema(db); // chạy lại an toàn

  assert.deepEqual(db.prepare('SELECT id, dot_id, phong_id, chu_id, trang_thai, du_lieu_json, nguoi_nop_id FROM bcp_bao_cao').all(),
    [{ id: 1, dot_id: 1, phong_id: 1, chu_id: null, trang_thai: 'da_nop', du_lieu_json: '{"x":1}', nguoi_nop_id: 1 }], 'báo cáo cũ còn nguyên');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bcp_lich_su').get().n, 1, 'bảng con KHÔNG bị xóa theo (khóa ngoại tắt khi dựng lại)');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'khóa ngoại được bật lại');
  assert.equal(db.prepare('SELECT cach_nop FROM bcp_dot').get().cach_nop, 'mot_nguoi', 'đợt cũ là một người nộp');
  // Giờ cho phép nhiều báo cáo một phòng (khác chu_id) nhưng vẫn cấm trùng
  db.prepare("INSERT INTO users VALUES (2,'b@x','B','researcher')").run();
  db.prepare('INSERT INTO bcp_bao_cao (dot_id, phong_id, chu_id) VALUES (1,1,1)').run();
  db.prepare('INSERT INTO bcp_bao_cao (dot_id, phong_id, chu_id) VALUES (1,1,2)').run();
  assert.throws(() => db.prepare('INSERT INTO bcp_bao_cao (dot_id, phong_id, chu_id) VALUES (1,1,2)').run(), /UNIQUE/);
  assert.throws(() => db.prepare('INSERT INTO bcp_bao_cao (dot_id, phong_id, chu_id) VALUES (1,1,NULL)').run(), /UNIQUE/, 'chỉ một báo cáo chung/chờ giao');
  assert.ok(db.prepare('SELECT 1 AS ok FROM bcp_lich_su WHERE bao_cao_id = 1').get(), 'khóa ngoại của bảng con vẫn trỏ đúng bảng mới');
  db.prepare('DELETE FROM bcp_bao_cao WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bcp_lich_su').get().n, 0, 'xóa báo cáo vẫn kéo theo lịch sử (CASCADE còn hiệu lực)');
});

// ── Tạo đợt ──────────────────────────────────────────────────────────────────

test('mặc định (một người nộp): một báo cáo chung mỗi phòng như cũ; cách nộp lạ bị từ chối', async () => {
  const dot = await taoDot('Đợt mặc định', [ID.phongA, ID.phongB], undefined, false);
  const rows = hang(dot);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.chu_id === null));
  assert.equal((await ung.json(QUAN_LY, 'GET', '/dot/' + dot)).d.dot.cach_nop, 'mot_nguoi');
  const xau = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'x', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA], cach_nop: 'ai_cung_duoc' });
  assert.equal(xau.s, 400);
});

test('mỗi người một báo cáo: phòng 2 người có 2 báo cáo, phòng 1 người có 1, phòng chưa có ai có 1 báo cáo chờ giao', async () => {
  const dot = await taoDot('Đợt từng người', [ID.phongA, ID.phongB, ID.phongC], 'tat_ca', false);
  const rows = hang(dot);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.filter((r) => r.phong_id === ID.phongA).map((r) => r.chu_id).sort(), [TP_A, TP_B]);
  assert.deepEqual(rows.filter((r) => r.phong_id === ID.phongB).map((r) => r.chu_id), [KE_TOAN]);
  assert.deepEqual(rows.filter((r) => r.phong_id === ID.phongC).map((r) => r.chu_id), [null]);
  const ct = (await ung.json(QUAN_LY, 'GET', '/dot/' + dot)).d;
  assert.equal(ct.dot.cach_nop, 'tat_ca');
  const a = ct.bao_cao.filter((b) => b.phong_id === ID.phongA);
  assert.deepEqual(a.map((b) => b.chu_ten).sort(), ['Lê Trưởng Phòng B', 'Trần Trưởng Phòng A']);
  assert.deepEqual(a.map((b) => b.chuc_danh).sort(), ['pho_truong_phong', 'truong_phong']);
  ID.dotBoSung = dot;
});

test('chỉ đổi cách nộp khi đợt còn Nháp (dựng lại báo cáo); đã mở thì 409', async () => {
  const dot = await taoDot('Đợt đổi cách nộp', [ID.phongA], undefined, false);
  assert.equal(hang(dot).length, 1);
  const r = await ung.json(QUAN_LY, 'PUT', '/dot/' + dot, { tieu_de: 'Đợt đổi cách nộp', loai: 'thang', han_nop: '2099-12-31', cach_nop: 'tat_ca' });
  assert.equal(r.s, 200, JSON.stringify(r.d));
  assert.equal(hang(dot).length, 2, 'giờ mỗi người một báo cáo');
  assert.equal((await ung.json(QUAN_LY, 'POST', `/dot/${dot}/mo`, {})).s, 200);
  ung.daTrinh(dot);
  const sau = await ung.json(QUAN_LY, 'PUT', '/dot/' + dot, { tieu_de: 'Đợt đổi cách nộp', loai: 'thang', han_nop: '2099-12-31', cach_nop: 'mot_nguoi' });
  assert.equal(sau.s, 409);
  assert.equal(hang(dot).length, 2);
});

// ── Mỗi người chỉ thấy và nộp báo cáo của mình ───────────────────────────────

test('mỗi người chỉ thấy báo cáo của MÌNH: đồng nghiệp cùng phòng không đọc, không nhập, không nộp được báo cáo của nhau (404)', async () => {
  const dot = await taoDot('Đợt riêng tư', [ID.phongA, ID.phongB], 'tat_ca');
  const rows = hang(dot);
  const cuaA = rows.find((r) => r.chu_id === TP_A).id;
  const cuaB = rows.find((r) => r.chu_id === TP_B).id;
  const cuaKT = rows.find((r) => r.chu_id === KE_TOAN).id;

  assert.deepEqual((await cuaToi(TP_A)).filter((b) => b.dot_id === dot).map((b) => b.id), [cuaA]);
  assert.deepEqual((await cuaToi(TP_B)).filter((b) => b.dot_id === dot).map((b) => b.id), [cuaB]);
  assert.deepEqual((await cuaToi(KE_TOAN)).filter((b) => b.dot_id === dot).map((b) => b.id), [cuaKT]);
  assert.equal((await ung.json(TP_A, 'GET', '/bao-cao/' + cuaB)).s, 404);
  assert.equal((await ung.json(TP_A, 'PUT', `/bao-cao/${cuaB}/du-lieu`, { du_lieu: DU_LIEU('x') })).s, 404);
  assert.equal((await ung.json(TP_A, 'POST', `/bao-cao/${cuaB}/nop`, {})).s, 404);
  assert.equal((await ung.json(KE_TOAN, 'GET', '/bao-cao/' + cuaA)).s, 404);
  // việc của tôi trên trang chủ cũng chỉ có báo cáo của mình
  const viec = (await ung.json(TP_A, 'GET', '/viec-cua-toi')).d.bao_cao.filter((b) => b.id === cuaA || b.id === cuaB);
  assert.deepEqual(viec.map((b) => b.id), [cuaA]);
  // người quản lý và Viện trưởng đọc được tất cả
  for (const id of [cuaA, cuaB, cuaKT]) {
    assert.equal((await ung.json(QUAN_LY, 'GET', '/bao-cao/' + id)).s, 200);
    assert.equal((await ung.json(VIEN_TRUONG, 'GET', '/bao-cao/' + id)).s, 200);
  }
  const ct = (await ung.json(QUAN_LY, 'GET', '/bao-cao/' + cuaA)).d;
  assert.equal(ct.nguoi_phu_trach, 'Trần Trưởng Phòng A');
  assert.equal(ct.cach_nop, 'tat_ca');
  ID.dot = dot;
  ID.cua = { A: cuaA, B: cuaB, KT: cuaKT };
});

test('phòng hoàn thành khi MỌI người đã nộp: tiến độ đếm theo báo cáo; thư [Đã đủ báo cáo] chỉ khi báo cáo cuối cùng được nộp', async () => {
  ung.thu.length = 0;
  assert.equal((await nop(TP_A, ID.cua.A, 'Trưởng')).s, 200);
  await ung.doiThu(1);
  let thu = ung.thu.filter((t) => t.to === 'quanly@thu.local');
  assert.equal(thu.length, 1);
  assert.match(thu[0].subject, /\(1\/3 báo cáo\)$/, 'đợt mỗi người một báo cáo đếm theo báo cáo, không theo phòng');
  assert.doesNotMatch(thu[0].subject, /^\[Đã đủ báo cáo\]/);
  assert.match(thu[0].text, /Báo cáo chưa nộp: .*Phòng A \(Lê Trưởng Phòng B\)/, 'nêu rõ ai chưa nộp');

  assert.equal((await nop(TP_B, ID.cua.B, 'Phó')).s, 200);
  await doi();
  const ct = (await ung.json(QUAN_LY, 'GET', '/dot/' + ID.dot)).d.bao_cao;
  const a = ct.filter((b) => b.phong_id === ID.phongA);
  assert.ok(a.every((b) => b.trang_thai === 'da_nop'), 'phòng A: cả hai đã nộp');
  ung.thu.length = 0;
  assert.equal((await nop(KE_TOAN, ID.cua.KT, 'Kế toán')).s, 200);
  await ung.doiThu(1);
  thu = ung.thu.filter((t) => t.to === 'quanly@thu.local');
  assert.match(thu[0].subject, /^\[Đã đủ báo cáo\]/);
  assert.match(thu[0].subject, /\(3\/3 báo cáo\)$/);
});

test('một người nộp xong thì người kia vẫn phải nộp: nộp lại bị chặn chỉ với chính báo cáo đã nộp', async () => {
  assert.equal((await ung.json(TP_A, 'POST', `/bao-cao/${ID.cua.A}/nop`, {})).s, 409, 'báo cáo của chính mình đã nộp');
});

// ── Đồng bộ khi người phụ trách thay đổi ─────────────────────────────────────

test('người mới được phân công vào phòng của đợt đang mở: có báo cáo riêng, thư báo kèm đúng liên kết của họ; báo cáo người khác không bị đụng', async () => {
  const dot = await taoDot('Đợt có người mới', [ID.phongB], 'tat_ca');
  assert.equal(hang(dot).length, 1);
  const moi = ung.dangKy('pho.b@sci.edu.vn', 'Phó Phòng B');
  const r = await ung.json(QUAN_LY, 'POST', '/loi-moi', { email: 'pho.b@sci.edu.vn', phong_id: ID.phongB, chuc_danh: 'pho_truong_phong' });
  assert.equal(r.s, 201);
  const rows = hang(dot);
  assert.equal(rows.length, 2);
  const cua = rows.find((x) => x.chu_id === moi).id;
  await ung.doiThu(1);
  const thu = ung.thu.find((t) => t.to === 'pho.b@sci.edu.vn');
  assert.ok(thu.text.includes('#/bao-cao/' + cua), 'liên kết vào báo cáo riêng của người mới');
  assert.ok(!thu.text.includes('#/bao-cao/' + rows.find((x) => x.chu_id === KE_TOAN).id), 'không dẫn tới báo cáo của người khác');
  assert.deepEqual((await cuaToi(moi)).filter((b) => b.dot_id === dot).map((b) => b.id), [cua]);
  ID.dotMoi = { dot, moi, cua };
});

test('người bị gỡ: báo cáo chưa nộp bị bỏ, báo cáo đã nộp giữ nguyên làm hồ sơ', async () => {
  const { dot, moi } = ID.dotMoi;
  const kt = hang(dot).find((x) => x.chu_id === KE_TOAN).id;
  assert.equal((await nop(KE_TOAN, kt, 'Kế toán')).s, 200);
  // gỡ người mới (chưa nộp): báo cáo của họ bị bỏ
  const tv = (await ung.json(QUAN_LY, 'GET', '/thanh-vien')).d.thanh_vien.find((x) => x.user_id === moi);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/thanh-vien/' + tv.id)).s, 200);
  assert.deepEqual(hang(dot).map((x) => x.chu_id), [KE_TOAN]);
  // gỡ kế toán (đã nộp): báo cáo vẫn còn
  const tvKT = (await ung.json(QUAN_LY, 'GET', '/thanh-vien')).d.thanh_vien.find((x) => x.user_id === KE_TOAN);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/thanh-vien/' + tvKT.id)).s, 200);
  assert.deepEqual(hang(dot).map((x) => [x.chu_id, x.trang_thai]), [[KE_TOAN, 'da_nop']]);
  // trả lại vai trò để các test sau dùng
  await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: KE_TOAN, vai_tro: 'truong_phong', phong_id: ID.phongB, chuc_danh: 'ke_toan' });
});

test('báo cáo đang cần chỉnh sửa của người bị gỡ chuyển thành báo cáo chờ giao: người còn lại trong phòng nhập được', async () => {
  const dot = await taoDot('Đợt người rời phòng', [ID.phongA], 'tat_ca');
  const cuaB = hang(dot).find((x) => x.chu_id === TP_B).id;
  assert.equal((await nop(TP_B, cuaB, 'Phó')).s, 200);
  assert.equal((await ung.json(QUAN_LY, 'POST', `/bao-cao/${cuaB}/yeu-cau-chinh-sua`, { nhan_xet: 'Bổ sung' })).s, 200);
  const tv = (await ung.json(QUAN_LY, 'GET', '/thanh-vien')).d.thanh_vien.find((x) => x.user_id === TP_B && x.phong_id === ID.phongA);
  assert.equal((await ung.json(QUAN_LY, 'DELETE', '/thanh-vien/' + tv.id)).s, 200);
  const sau = hang(dot).find((x) => x.id === cuaB);
  assert.equal(sau.chu_id, null, 'chuyển thành báo cáo chờ giao');
  assert.equal((await ung.json(TP_A, 'GET', '/bao-cao/' + cuaB)).s, 200, 'Trưởng phòng còn lại xem được');
  assert.equal((await nop(TP_A, cuaB, 'Trưởng thay')).s, 200, 'và nộp thay được');
  await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: TP_B, vai_tro: 'truong_phong', phong_id: ID.phongA, chuc_danh: 'pho_truong_phong' });
});

test('phòng chưa có ai: báo cáo chờ giao; người đầu tiên được phân công nhận luôn báo cáo đó (không tạo thêm)', async () => {
  const dot = await taoDot('Đợt phòng trống', [ID.phongC], 'tat_ca');
  assert.deepEqual(hang(dot).map((x) => x.chu_id), [null]);
  const id = hang(dot)[0].id;
  const nguoi = ung.dangKy('tp.c@sci.edu.vn', 'Trưởng Phòng C');
  assert.equal((await ung.json(QUAN_LY, 'POST', '/thanh-vien', { user_id: nguoi, vai_tro: 'truong_phong', phong_id: ID.phongC })).s, 201);
  assert.deepEqual(hang(dot).map((x) => [x.id, x.chu_id]), [[id, nguoi]]);
  const tv = (await ung.json(QUAN_LY, 'GET', '/thanh-vien')).d.thanh_vien.find((x) => x.user_id === nguoi);
  await ung.json(QUAN_LY, 'DELETE', '/thanh-vien/' + tv.id);
});

// ── Thư và kết xuất ──────────────────────────────────────────────────────────

test('thư mở đợt: mỗi người nhận liên kết vào báo cáo RIÊNG của mình, không có liên kết của đồng nghiệp', async () => {
  const dot = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt thư riêng', loai: 'thang', han_nop: '2099-12-31', mau_id: ID.mau, phong_ids: [ID.phongA], cach_nop: 'tat_ca' });
  ung.thu.length = 0;
  await ung.json(QUAN_LY, 'POST', `/dot/${dot.d.id}/mo`, {});
  ung.daTrinh(dot.d.id);
  await ung.doiThu(2);
  const rows = hang(dot.d.id);
  const idA = rows.find((x) => x.chu_id === TP_A).id;
  const idB = rows.find((x) => x.chu_id === TP_B).id;
  const thuA = ung.thu.find((t) => t.to === 'tpa@thu.local');
  const thuB = ung.thu.find((t) => t.to === 'tpb@thu.local');
  assert.ok(thuA.text.includes('#/bao-cao/' + idA) && !thuA.text.includes('#/bao-cao/' + idB));
  assert.ok(thuB.text.includes('#/bao-cao/' + idB) && !thuB.text.includes('#/bao-cao/' + idA));
  assert.equal(ung.thu.filter((t) => t.to === 'tpa@thu.local').length, 1, 'mỗi người một thư');
});

test('nhắc hạn: mỗi người chưa nộp được nhắc riêng với liên kết của mình; người đã nộp thì không', async () => {
  const dot = await ung.json(QUAN_LY, 'POST', '/dot', { tieu_de: 'Đợt nhắc riêng', loai: 'thang', han_nop: '2090-05-10', mau_id: ID.mau, phong_ids: [ID.phongA], cach_nop: 'tat_ca' });
  await ung.json(QUAN_LY, 'POST', `/dot/${dot.d.id}/mo`, {});
  ung.daTrinh(dot.d.id);
  const rows = hang(dot.d.id);
  const idA = rows.find((x) => x.chu_id === TP_A).id;
  const idB = rows.find((x) => x.chu_id === TP_B).id;
  assert.equal((await nop(TP_A, idA, 'Trưởng')).s, 200);
  await doi();
  // đóng các đợt khác để bộ nhắc chỉ thấy đợt này
  ung.db.prepare("UPDATE bcp_dot SET trang_thai = 'dong' WHERE id <> ? AND trang_thai = 'dang_mo'").run(dot.d.id);
  ung.thu.length = 0;
  const homTruoc = Date.parse('2090-05-09T02:00:00Z'); // 9h sáng giờ Việt Nam ngày 09/05/2090 (còn 1 ngày tới hạn)
  const kq = await ung.nhacHan.chayMotLan(homTruoc);
  assert.equal(kq.nhac, 1, 'chỉ báo cáo của người chưa nộp');
  await ung.doiThu(1);
  await doi();
  const nhac = ung.thu.filter((t) => /^\[Nhắc nộp báo cáo\]/.test(t.subject));
  assert.deepEqual(nhac.map((t) => t.to), ['tpb@thu.local']);
  assert.ok(nhac[0].text.includes('#/bao-cao/' + idB));
});

test('ý kiến của Viện trưởng về báo cáo của MỘT người: chỉ người đó và người quản lý nhận thư, đồng nghiệp cùng phòng thì không', async () => {
  const dot = await taoDot('Đợt ý kiến riêng', [ID.phongA], 'tat_ca');
  const rows = hang(dot);
  const idA = rows.find((x) => x.chu_id === TP_A).id;
  assert.equal((await nop(TP_A, idA, 'Trưởng')).s, 200);
  await doi();
  ung.thu.length = 0;
  const r = await ung.json(VIEN_TRUONG, 'POST', `/bao-cao/${idA}/y-kien`, { noi_dung: 'Đề nghị bổ sung số liệu.' });
  assert.equal(r.s, 201, JSON.stringify(r.d));
  assert.equal(r.d.da_bao, 1);
  await ung.doiThu(2);
  await doi();
  const toi = ung.thu.filter((t) => /^\[Ý kiến của Viện trưởng\]/.test(t.subject)).map((t) => t.to).sort();
  assert.deepEqual(toi, ['quanly@thu.local', 'tpa@thu.local']);
});

test('kết xuất: chọn từng báo cáo (bao_cao=), tên có người phụ trách; báo cáo chưa nộp thì 409; chọn theo phòng lấy mọi báo cáo của phòng', async () => {
  const dot = await taoDot('Đợt kết xuất', [ID.phongA], 'tat_ca');
  const rows = hang(dot);
  const idA = rows.find((x) => x.chu_id === TP_A).id;
  const idB = rows.find((x) => x.chu_id === TP_B).id;
  assert.equal((await nop(TP_A, idA, 'Trưởng')).s, 200);

  let r = await ung.goi(QUAN_LY, 'GET', `/dot/${dot}/xuat?bao_cao=${idA}&dinh_dang=docx`);
  assert.equal(r.status, 200);
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /Phòng A — Trần Trưởng Phòng A\.docx/);
  r = await ung.json(QUAN_LY, 'GET', `/dot/${dot}/xuat?bao_cao=${idA},${idB}&dinh_dang=docx`);
  assert.equal(r.s, 409);
  assert.match(r.d.message, /Phòng A — Lê Trưởng Phòng B/);
  assert.equal((await ung.json(QUAN_LY, 'GET', `/dot/${dot}/xuat?bao_cao=999999`)).s, 404);
  assert.equal((await ung.json(QUAN_LY, 'GET', `/dot/${dot}/xuat?bao_cao=abc`)).s, 400);
  // theo phòng: phòng A còn một báo cáo chưa nộp → 409 nêu rõ ai
  r = await ung.json(QUAN_LY, 'GET', `/dot/${dot}/xuat?phong=${ID.phongA}&dinh_dang=docx`);
  assert.equal(r.s, 409);
  assert.equal((await nop(TP_B, idB, 'Phó')).s, 200);
  r = await ung.goi(QUAN_LY, 'GET', `/dot/${dot}/xuat?phong=${ID.phongA}&dinh_dang=docx`);
  assert.equal(r.status, 200, 'đủ cả hai thì xuất được theo phòng');
  assert.match(decodeURIComponent(r.headers.get('content-disposition')), /2 phòng\.docx|2 báo cáo\.docx|2 phòng/);
});

test('danh sách phòng đếm số ĐỢT (không phải số báo cáo): phòng có hai báo cáo trong một đợt vẫn là một đợt', async () => {
  const ds = (await ung.json(QUAN_LY, 'GET', '/phong')).d.phong;
  const a = ds.find((p) => p.id === ID.phongA);
  const soDot = ung.db.prepare('SELECT COUNT(DISTINCT dot_id) AS n FROM bcp_bao_cao WHERE phong_id = ?').get(ID.phongA).n;
  assert.equal(a.so_dot, soDot);
  assert.ok(ung.db.prepare('SELECT COUNT(*) AS n FROM bcp_bao_cao WHERE phong_id = ?').get(ID.phongA).n > soDot);
});

test('chế độ một người nộp vẫn như cũ: một báo cáo chung, người nào trong phòng cũng nhập và nộp được', async () => {
  const dot = await taoDot('Đợt chung', [ID.phongA]);
  const id = hang(dot)[0].id;
  assert.equal((await ung.json(TP_B, 'PUT', `/bao-cao/${id}/du-lieu`, { du_lieu: DU_LIEU('Phó') })).s, 200);
  assert.equal((await ung.json(TP_A, 'GET', '/bao-cao/' + id)).s, 200, 'đồng nghiệp xem được báo cáo chung');
  assert.equal((await ung.json(TP_B, 'POST', `/bao-cao/${id}/nop`, {})).s, 200);
  assert.equal((await ung.json(TP_A, 'POST', `/bao-cao/${id}/nop`, {})).s, 409, 'đã nộp rồi');
});
