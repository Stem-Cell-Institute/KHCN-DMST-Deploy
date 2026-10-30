'use strict';

/**
 * Lưới test cho module CRD — đặt lịch thiết bị (/api/crd/*, 36 route).
 *
 * Đây là điều kiện tiên quyết của Đợt 2 trong readme/KE-HOACH-REFACTOR.md: không có lưới thì cắt–dán
 * 36 route ra khỏi server.js là đi không phanh. Các test dưới đây GHIM HÀNH VI HIỆN TẠI (kể cả thứ
 * tự kiểm tra và câu thông báo lỗi, vì giao diện CRD đang hiển thị nguyên văn các câu đó) — chúng
 * khẳng định "refactor không đổi hành vi", không khẳng định hành vi hiện tại là lý tưởng.
 *
 * Gồm 3 lớp:
 *   1. Bảng phân quyền của cả 36 route + đối chiếu với danh sách route THẬT (thêm/mất route là báo ngay)
 *   2. Đăng ký công khai, hồ sơ CRD, chặn/gỡ quyền
 *   3. Nghiệp vụ: đặt lịch (biên giờ, trùng lịch), sửa/hủy, chat + giới hạn tốc độ, khiếu nại, quản trị
 *
 * Chạy trên server hộp cát riêng (cổng TEST_PORT_CRD, mặc định 3200) — xem tests/helpers/testServer.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

const ROOT = path.resolve(__dirname, '..');
const PORT_CRD = Number(process.env.TEST_PORT_CRD || 3200);
const BROADCAST = '__crd_broadcast__';
const TAG = Date.now().toString(36);

let srv;
let admin;

test.before(async () => {
  // Nới giới hạn tốc độ chung của API: bộ test này gửi vài trăm request trong vài giây.
  srv = await startTestServer({ port: PORT_CRD, env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = srv.tokens.admin;
});

test.after(async () => {
  if (srv) await srv.stop();
});

/** Gọi API, trả { s: mã trạng thái, body: JSON | null }. */
async function api(method, url, token, body) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const r = await call(srv.baseUrl, url, { token, method, body: hasBody ? body : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) { /* không phải JSON */ }
  return { s: r.status, body: json };
}

/** Khẳng định mã trạng thái (+ đoạn câu thông báo nếu có). Lỗi in kèm nhãn và thân phản hồi. */
function expectRes(r, status, label, msgPart) {
  assert.equal(r.s, status, `${label} → mong ${status}, thật ${r.s}: ${JSON.stringify(r.body)}`);
  if (msgPart) {
    const m = String((r.body && r.body.message) || '');
    assert.ok(m.includes(msgPart), `${label} → câu thông báo phải chứa "${msgPart}", thật: "${m}"`);
  }
}

const newUser = (name, role = 'researcher') => addUser(srv, { fullname: `${name} ${TAG}`, role });

/** Tạo thiết bị riêng cho từng test (id mới) để các test không giẫm lên lịch của nhau. */
async function newMachine(extra = {}) {
  const r = await api('POST', '/api/crd/admin/machines', admin, {
    name: `[test] máy ${TAG}-${Math.random().toString(36).slice(2, 7)}`,
    availFrom: 8,
    availTo: 20,
    maxHours: 4,
    ...extra,
  });
  expectRes(r, 201, 'tạo thiết bị thử');
  return r.body.machine;
}

const book = (token, machineId, startH, endH, extra = {}) =>
  api('POST', '/api/crd/bookings', token, {
    machineId, date: '2031-05-20', startH, endH, purpose: 'thử nghiệm', researchGroup: 'nhóm thử', ...extra,
  });

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. BẢNG PHÂN QUYỀN — cả 36 route
//    public = không cần đăng nhập · auth = chỉ cần đăng nhập · admin = Admin hệ thống (adminOnly)
// ───────────────────────────────────────────────────────────────────────────────────────────────
const ROUTES = [
  ['POST', '/api/crd/public/register', 'public'],
  ['GET', '/api/crd/state', 'auth'],
  ['POST', '/api/crd/bookings', 'auth'],
  ['DELETE', '/api/crd/bookings/:id', 'auth'],
  ['PUT', '/api/crd/bookings/:id', 'auth'],
  ['POST', '/api/crd/chats', 'auth'],
  ['PUT', '/api/crd/chats/:id/read', 'auth'],
  ['PUT', '/api/crd/chats/mark-thread-read', 'auth'],
  ['PUT', '/api/crd/chats/broadcast-read', 'auth'],
  ['POST', '/api/crd/complaints', 'auth'],
  ['GET', '/api/crd/admin/snapshot', 'admin'],
  ['GET', '/api/crd/admin/lab-announcements', 'admin'],
  ['POST', '/api/crd/admin/lab-announcements', 'admin'],
  ['PUT', '/api/crd/admin/lab-announcements/:id', 'admin'],
  ['DELETE', '/api/crd/admin/lab-announcements/:id', 'admin'],
  ['POST', '/api/crd/admin/machines', 'admin'],
  ['PUT', '/api/crd/admin/machines/reorder', 'admin'],
  ['PUT', '/api/crd/admin/machines/:id', 'admin'],
  ['DELETE', '/api/crd/admin/machines/:id', 'admin'],
  ['POST', '/api/crd/admin/persons', 'admin'],
  ['PUT', '/api/crd/admin/persons/:id', 'admin'],
  ['DELETE', '/api/crd/admin/persons/:id', 'admin'],
  ['GET', '/api/crd/admin/persons/:id/stats', 'admin'],
  ['GET', '/api/crd/admin/users', 'admin'],
  ['PUT', '/api/crd/admin/users/:id/disable', 'admin'],
  ['POST', '/api/crd/admin/users/:id/reset-password', 'admin'],
  ['POST', '/api/crd/admin/role-defs', 'admin'],
  ['PUT', '/api/crd/admin/role-defs/:slug', 'admin'],
  ['DELETE', '/api/crd/admin/role-defs/:slug', 'admin'],
  ['PUT', '/api/crd/admin/bookings/:id', 'admin'],
  ['DELETE', '/api/crd/admin/bookings/:id', 'admin'],
  // Kiểm quyền nằm TRONG handler (Admin hệ thống hoặc vai trò Admin CRD), không qua adminOnly.
  ['DELETE', '/api/crd/admin/chats/:id', 'auth'],
  ['PUT', '/api/crd/email-notif', 'auth'],
  ['GET', '/api/crd/email-notif', 'auth'],
  ['PUT', '/api/crd/admin/complaints/:id', 'admin'],
  ['DELETE', '/api/crd/admin/complaints/:id', 'admin'],
];
const concrete = (p) => p.replace(/:[A-Za-z_]+/g, 'x1');

test('bảng phân quyền khớp danh sách route CRD thật trong server (không thêm/mất route nào)', () => {
  const inv = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'route-inventory.js')], { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const live = inv.split(/\r?\n/)
    .map((l) => l.match(/^\d{4}\s+(\S+)\s+(\S+)/))
    .filter((m) => m && m[2].startsWith('/api/crd/'))
    .map((m) => `${m[1]} ${m[2]}`)
    .sort();
  const table = ROUTES.map(([m, p]) => `${m} ${p}`).sort();
  assert.equal(ROUTES.length, 36, 'kế hoạch ghi 36 route CRD');
  assert.deepEqual(table, live, 'bảng ROUTES phải khớp đúng các route /api/crd/* đã đăng ký — sửa bảng này CÓ CHỦ ĐÍCH khi thêm/bớt route');
});

test('chưa đăng nhập: mọi route (trừ đăng ký công khai) trả 401', async () => {
  for (const [m, p, guard] of ROUTES) {
    if (guard === 'public') continue;
    const r = await api(m, concrete(p), null, {});
    expectRes(r, 401, `${m} ${p}`, 'Chưa đăng nhập');
  }
});

test('route quản trị: nghiên cứu viên và tài khoản crd_user đều bị 403 (adminOnly)', async () => {
  const researcher = newUser('Nghiên cứu viên');
  const guest = newUser('Khách CRD', 'crd_user');
  for (const [m, p, guard] of ROUTES) {
    if (guard !== 'admin') continue;
    for (const [ten, u] of [['nghiên cứu viên', researcher], ['crd_user', guest]]) {
      const r = await api(m, concrete(p), u.token, {});
      expectRes(r, 403, `${ten} ${m} ${p}`, 'Chỉ Admin mới có quyền này');
    }
  }
});

test('Admin vào được các route quản trị đọc (200)', async () => {
  for (const p of ['/api/crd/admin/snapshot', '/api/crd/admin/lab-announcements', '/api/crd/admin/users']) {
    expectRes(await api('GET', p, admin), 200, `admin GET ${p}`);
  }
});

test('crd_user: dùng được /api/crd/* ở mức người dùng nhưng bị chặn khỏi mọi API ngoài CRD', async () => {
  const guest = newUser('Khách CRD', 'crd_user');
  const st = await api('GET', '/api/crd/state', guest.token);
  expectRes(st, 200, 'crd_user GET state');
  assert.equal(st.body.mePersonId, guest.personId);
  assert.equal(st.body.appRole, 'crd_user');
  const m = await newMachine();
  expectRes(await book(guest.token, m.id, 9, 10), 201, 'crd_user đặt lịch');
  expectRes(await api('GET', '/api/missions', guest.token), 403, 'crd_user ngoài CRD', 'chỉ dùng cho module Đặt lịch thiết bị CRD');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. ĐĂNG KÝ CÔNG KHAI, HỒ SƠ CRD, CHẶN / GỠ QUYỀN
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('đăng ký công khai: kiểm tra đầu vào theo đúng thứ tự', async () => {
  const reg = (b) => api('POST', '/api/crd/public/register', null, b);
  expectRes(await reg({}), 400, 'rỗng', 'Email không hợp lệ');
  expectRes(await reg({ email: 'a@sci.edu.vn', password: 'secret1', fullname: 'Nhân sự Viện' }), 400, 'email @sci.edu.vn', 'dang-ky.html');
  expectRes(await reg({ email: 'khong-phai-email', password: 'secret1', fullname: 'Khách' }), 400, 'email sai dạng', 'Email không hợp lệ');
  expectRes(await reg({ email: `k1-${TAG}@example.org`, password: 'secret1', fullname: 'K' }), 400, 'tên quá ngắn', 'họ và tên');
  expectRes(await reg({ email: `k2-${TAG}@example.org`, password: '12345', fullname: 'Khách Thử' }), 400, 'mật khẩu ngắn', 'ít nhất 6');
  expectRes(await reg({ email: `k3-${TAG}@example.org`, password: 'x'.repeat(129), fullname: 'Khách Thử' }), 400, 'mật khẩu dài', 'quá dài');
});

test('đăng ký công khai: thành công cấp token crd_user, trùng email bị từ chối', async () => {
  const email = `khach-${TAG}@example.org`;
  const ok = await api('POST', '/api/crd/public/register', null, { email: email.toUpperCase(), password: 'secret1', fullname: '  Khách Thử  ' });
  expectRes(ok, 201, 'đăng ký', undefined);
  assert.equal(ok.body.user.role, 'crd_user');
  assert.equal(ok.body.user.email, email, 'email được chuẩn hoá chữ thường');
  assert.equal(ok.body.user.fullname, 'Khách Thử', 'họ tên được cắt khoảng trắng');
  assert.equal(typeof ok.body.token, 'string');
  expectRes(await api('GET', '/api/crd/state', ok.body.token), 200, 'token mới dùng được /state');
  expectRes(await api('POST', '/api/crd/public/register', null, { email, password: 'secret1', fullname: 'Khách Thử' }), 400, 'đăng ký trùng', 'đã được sử dụng');
});

test('state: hồ sơ CRD tự tạo lần đầu, đủ khóa, kênh chung và vai trò mặc định', async () => {
  const u = newUser('Người dùng mới');
  const r = await api('GET', '/api/crd/state', u.token);
  expectRes(r, 200, 'state');
  for (const k of ['machines', 'users', 'bookings', 'chats', 'mePersonId', 'appRole', 'crdRoles', 'broadcastLastRead', 'broadcastChannelId', 'labAnnouncements']) {
    assert.ok(k in r.body, `state thiếu khóa ${k}`);
  }
  assert.equal(r.body.mePersonId, u.personId, 'id hồ sơ = u_app_<id tài khoản>');
  assert.equal(r.body.appRole, 'researcher');
  assert.equal(r.body.broadcastChannelId, BROADCAST);
  const me = r.body.users.find((x) => x.id === u.personId);
  assert.ok(me, 'hồ sơ của chính mình nằm trong danh sách users');
  assert.equal(me.role, 'user');
  assert.equal(me.isBanned, false);
  const slugs = r.body.crdRoles.map((x) => x.slug);
  assert.ok(slugs.includes('user') && slugs.includes('admin'), 'luôn có vai trò user và admin');
  assert.equal(r.body.crdRoles.find((x) => x.slug === 'admin').isAdminSlot, true);
  assert.equal(r.body.crdRoles.find((x) => x.slug === 'user').isAdminSlot, false);
});

test('chặn và gỡ quyền: người bị khóa không đặt lịch được, người bị gỡ không vào được state', async () => {
  const u = newUser('Người bị chặn');
  const m = await newMachine();
  expectRes(await api('GET', '/api/crd/state', u.token), 200, 'khởi tạo hồ sơ');

  // Khóa tạm
  expectRes(await api('PUT', `/api/crd/admin/persons/${u.personId}`, admin, { isBanned: true }), 200, 'khóa');
  expectRes(await book(u.token, m.id, 9, 10), 403, 'đặt lịch khi bị khóa', 'tạm khoá');
  expectRes(await api('GET', '/api/crd/state', u.token), 403, 'state khi bị khóa', 'tạm khoá');
  expectRes(await api('POST', '/api/crd/complaints', u.token, { subject: 'a', body: 'b' }), 403, 'khiếu nại khi bị khóa', 'tạm khoá');
  expectRes(await api('PUT', `/api/crd/admin/persons/${u.personId}`, admin, { isBanned: false }), 200, 'mở khóa');
  expectRes(await book(u.token, m.id, 9, 10), 201, 'đặt lịch sau khi mở khóa');

  // Gỡ quyền: crdEnsurePersonForAppUser trả null nên thông báo khác với khóa tạm
  expectRes(await api('PUT', `/api/crd/admin/persons/${u.personId}`, admin, { crdAccessRevoked: true }), 200, 'gỡ quyền');
  expectRes(await api('GET', '/api/crd/state', u.token), 403, 'state khi bị gỡ', 'chưa có hoặc đã bị gỡ');
  expectRes(await book(u.token, m.id, 11, 12), 403, 'đặt lịch khi bị gỡ', 'quyền đã bị gỡ');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. NGHIỆP VỤ ĐẶT LỊCH
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('đặt lịch: kiểm tra đầu vào theo ĐÚNG THỨ TỰ (câu lỗi giao diện đang hiển thị nguyên văn)', async () => {
  const u = newUser('Người đặt lịch');
  const m = await newMachine(); // mở 8–20h, tối đa 4 giờ/lần
  const base = { machineId: m.id, date: '2031-05-20', startH: 9, endH: 10, purpose: 'p', researchGroup: 'g' };
  const go = (patch) => api('POST', '/api/crd/bookings', u.token, { ...base, ...patch });

  expectRes(await api('POST', '/api/crd/bookings', u.token, {}), 400, 'thiếu hết', 'Thiếu thông tin đặt lịch');
  expectRes(await go({ machineId: '' }), 400, 'thiếu thiết bị', 'Thiếu thông tin đặt lịch');
  expectRes(await go({ date: '' }), 400, 'thiếu ngày', 'Thiếu thông tin đặt lịch');
  expectRes(await go({ startH: 'abc' }), 400, 'giờ không phải số', 'Thiếu thông tin đặt lịch');
  expectRes(await go({ startH: 10, endH: 10 }), 400, 'kết thúc = bắt đầu', 'Giờ kết thúc phải sau giờ bắt đầu');
  expectRes(await go({ startH: 11, endH: 9 }), 400, 'kết thúc trước bắt đầu', 'Giờ kết thúc phải sau giờ bắt đầu');
  expectRes(await go({ startH: 9.25 }), 400, 'lẻ 15 phút', 'bước 30 phút');
  expectRes(await go({ purpose: '   ' }), 400, 'thiếu mục đích', 'mục đích sử dụng');
  expectRes(await go({ researchGroup: '' }), 400, 'thiếu nhóm nghiên cứu', 'nhóm nghiên cứu');
  // Thứ tự: mục đích được kiểm TRƯỚC khi tra thiết bị
  expectRes(await go({ machineId: 'khong-co', purpose: '' }), 400, 'thiết bị lạ + thiếu mục đích', 'mục đích sử dụng');
  expectRes(await go({ machineId: 'khong-co' }), 404, 'thiết bị không tồn tại', 'Không tìm thấy thiết bị');
  expectRes(await go({ startH: 7, endH: 8 }), 400, 'trước giờ mở', 'chỉ mở đặt lịch 8:00–20:00');
  expectRes(await go({ startH: 19, endH: 21 }), 400, 'quá giờ đóng', 'chỉ mở đặt lịch 8:00–20:00');
  expectRes(await go({ startH: 8, endH: 13 }), 400, 'vượt tối đa 4 giờ', 'Tối đa 4 giờ mỗi lần đặt');
});

test('đặt lịch: mốc 30 phút và biên giờ hợp lệ', async () => {
  const u = newUser('Người đặt lịch');
  const m = await newMachine();
  const half = await book(u.token, m.id, 9.5, 10.5);
  expectRes(half, 201, 'đặt 9:30–10:30');
  assert.deepEqual(
    { startH: half.body.booking.startH, endH: half.body.booking.endH, status: half.body.booking.status, userId: half.body.booking.userId, machineId: half.body.booking.machineId },
    { startH: 9.5, endH: 10.5, status: 'confirmed', userId: u.personId, machineId: m.id }
  );
  expectRes(await book(u.token, m.id, 8, 12, { date: '2031-05-21' }), 201, 'đúng 4 giờ là hợp lệ (biên trên)');
  expectRes(await book(u.token, m.id, 16, 20, { date: '2031-05-22' }), 201, 'kết thúc đúng giờ đóng 20:00 là hợp lệ');
  assert.match(half.body.booking.id, /^b_[0-9a-f]{12}$/, 'định dạng id booking');
});

test('đặt lịch: quy tắc trùng lịch (khoảng nửa mở: liền kề thì được)', async () => {
  const a = newUser('Người A');
  const b = newUser('Người B');
  const m = await newMachine();
  expectRes(await book(a.token, m.id, 9, 11), 201, 'A đặt 9–11');
  const clash = 'Khung giờ này đã có người đặt';
  expectRes(await book(b.token, m.id, 9, 11), 409, 'trùng hệt', clash);
  expectRes(await book(b.token, m.id, 10, 12), 409, 'gối đuôi', clash);
  expectRes(await book(b.token, m.id, 8, 10), 409, 'gối đầu', clash);
  expectRes(await book(b.token, m.id, 9.5, 10), 409, 'nằm trong', clash);
  expectRes(await book(b.token, m.id, 8, 12), 409, 'bao trùm', clash);
  expectRes(await book(b.token, m.id, 11, 12), 201, 'liền kề sau (bắt đầu = giờ kết thúc cũ)');
  expectRes(await book(b.token, m.id, 8, 9), 201, 'liền kề trước (kết thúc = giờ bắt đầu cũ)');
  expectRes(await book(b.token, m.id, 9, 11, { date: '2031-05-21' }), 201, 'cùng giờ, KHÁC ngày');
  const other = await newMachine();
  expectRes(await book(b.token, other.id, 9, 11), 201, 'cùng giờ, KHÁC thiết bị');
});

test('sửa lịch: chủ lịch / Admin được, người khác 403; kiểm tra lại trùng giờ và giới hạn máy', async () => {
  const a = newUser('Chủ lịch');
  const b = newUser('Người khác');
  const m = await newMachine();
  const first = (await book(a.token, m.id, 9, 11)).body.booking;
  expectRes(await book(b.token, m.id, 12, 14), 201, 'lịch của B để so trùng');
  const put = (token, id, body) => api('PUT', `/api/crd/bookings/${id}`, token, body);

  const ok = await put(a.token, first.id, { startH: 9, endH: 10.5, purpose: 'đã sửa' });
  expectRes(ok, 200, 'chủ lịch sửa');
  assert.equal(ok.body.booking.endH, 10.5);
  assert.equal(ok.body.booking.purpose, 'đã sửa');
  assert.equal(ok.body.booking.researchGroup, 'nhóm thử', 'trường không gửi thì giữ nguyên');

  expectRes(await put(b.token, first.id, { purpose: 'x' }), 403, 'người khác sửa', 'Chỉ sửa được lịch của chính mình');
  expectRes(await put(a.token, 'b_khong_co', {}), 404, 'lịch không tồn tại', 'Không tìm thấy lịch');
  expectRes(await put(a.token, first.id, { startH: 'abc' }), 400, 'giờ không hợp lệ', 'Giờ không hợp lệ');
  expectRes(await put(a.token, first.id, { startH: 10, endH: 9 }), 400, 'kết thúc trước bắt đầu', 'Giờ kết thúc phải sau giờ bắt đầu');
  expectRes(await put(a.token, first.id, { startH: 9.1 }), 400, 'lẻ', 'bước 30 phút');
  expectRes(await put(a.token, first.id, { researchGroup: '' }), 400, 'bỏ nhóm', 'nhóm nghiên cứu');
  expectRes(await put(a.token, first.id, { purpose: '' }), 400, 'bỏ mục đích', 'mục đích sử dụng');
  expectRes(await put(a.token, first.id, { endH: 14 }), 400, 'vượt 4 giờ (9→14)', 'Tối đa 4 giờ/lần đặt');
  expectRes(await put(a.token, first.id, { startH: 7 }), 400, 'ngoài giờ máy', 'Máy chỉ hoạt động 8:00–20:00');
  expectRes(await put(a.token, first.id, { startH: 11, endH: 13 }), 409, 'đè lịch của B (12–14)', 'Trùng lịch với booking khác');
  expectRes(await put(a.token, first.id, { startH: 9, endH: 12 }), 200, 'dời sát lịch B (kết thúc 12 = bắt đầu 12) vẫn được');
  expectRes(await put(admin, first.id, { purpose: 'Admin sửa hộ' }), 200, 'Admin sửa lịch của người khác');
});

test('hủy lịch: chỉ chủ lịch hoặc Admin; hủy xong thì giải phóng khung giờ', async () => {
  const a = newUser('Chủ lịch');
  const b = newUser('Người khác');
  const m = await newMachine();
  const del = (token, id) => api('DELETE', `/api/crd/bookings/${id}`, token);
  const bk = (await book(a.token, m.id, 9, 11)).body.booking;

  expectRes(await del(b.token, bk.id), 403, 'người khác hủy', 'Chỉ huỷ được lịch của chính mình');
  expectRes(await del(a.token, 'b_khong_co'), 404, 'lịch không tồn tại', 'Không tìm thấy lịch');
  expectRes(await book(b.token, m.id, 9, 11), 409, 'khung giờ đang bị giữ');
  const ok = await del(a.token, bk.id);
  expectRes(ok, 200, 'chủ lịch hủy');
  assert.deepEqual(ok.body, { ok: true });
  expectRes(await del(a.token, bk.id), 404, 'hủy lần hai');
  expectRes(await book(b.token, m.id, 9, 11), 201, 'khung giờ đã được giải phóng');

  const bk2 = (await book(a.token, m.id, 14, 15)).body.booking;
  expectRes(await del(admin, bk2.id), 200, 'Admin hủy lịch của người khác');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. CHAT
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('chat riêng: kiểm tra đầu vào, người nhận, và đính kèm booking', async () => {
  const a = newUser('Người gửi');
  const b = newUser('Người nhận');
  await api('GET', '/api/crd/state', b.token); // tạo hồ sơ CRD cho người nhận
  const send = (body, token = a.token) => api('POST', '/api/crd/chats', token, body);

  const ok = await send({ toId: b.personId, msg: '  xin chào  ' });
  expectRes(ok, 201, 'gửi tin');
  assert.equal(ok.body.chat.msg, 'xin chào', 'nội dung được cắt khoảng trắng');
  assert.equal(ok.body.chat.fromId, a.personId);
  assert.equal(ok.body.chat.toId, b.personId);
  assert.equal(ok.body.chat.read, false);
  assert.equal(ok.body.chat.isDeleted, false);

  expectRes(await send({ toId: b.personId }), 400, 'thiếu nội dung', 'Thiếu nội dung hoặc người nhận');
  expectRes(await send({ msg: 'x' }), 400, 'thiếu người nhận', 'Thiếu nội dung hoặc người nhận');
  expectRes(await send({ toId: a.personId, msg: 'x' }), 400, 'gửi cho chính mình', 'Không thể gửi cho chính mình');
  expectRes(await send({ toId: b.personId, msg: 'x'.repeat(4001) }), 400, 'quá 4000 ký tự', 'quá dài');
  expectRes(await send({ toId: b.personId, msg: 'x'.repeat(4000) }), 201, 'đúng 4000 ký tự là hợp lệ');
  expectRes(await send({ toId: 'u_khong_co', msg: 'x' }), 404, 'người nhận không tồn tại', 'Người nhận không tồn tại');
  expectRes(await send({ toId: b.personId, msg: 'x', bookingId: 'b_khong_co' }), 400, 'booking đính kèm không tồn tại', 'Booking không tồn tại');

  const m = await newMachine();
  const bk = (await book(a.token, m.id, 9, 10)).body.booking;
  const withBk = await send({ toId: b.personId, msg: 'kèm lịch', bookingId: bk.id });
  expectRes(withBk, 201, 'đính kèm booking hợp lệ');
  assert.equal(withBk.body.chat.bookingId, bk.id);

  // Người nhận bị khóa / bị gỡ khỏi module
  expectRes(await api('PUT', `/api/crd/admin/persons/${b.personId}`, admin, { isBanned: true }), 200, 'khóa người nhận');
  expectRes(await send({ toId: b.personId, msg: 'x' }), 400, 'nhắn người bị khóa', 'đang bị khoá');
  expectRes(await api('PUT', `/api/crd/admin/persons/${b.personId}`, admin, { isBanned: false, crdAccessRevoked: true }), 200, 'gỡ người nhận');
  expectRes(await send({ toId: b.personId, msg: 'x' }), 400, 'nhắn người bị gỡ', 'không còn trong module CRD');
});

test('chat: đánh dấu đã đọc — chỉ người NHẬN được đánh dấu', async () => {
  const a = newUser('Người gửi');
  const b = newUser('Người nhận');
  await api('GET', '/api/crd/state', b.token);
  const chat = (await api('POST', '/api/crd/chats', a.token, { toId: b.personId, msg: 'đọc đi' })).body.chat;
  const read = (token, id) => api('PUT', `/api/crd/chats/${id}/read`, token);

  expectRes(await read(a.token, chat.id), 403, 'người gửi tự đánh dấu', 'Không có quyền');
  expectRes(await read(b.token, 'c_khong_co'), 404, 'tin không tồn tại', 'Không tìm thấy');
  expectRes(await read(b.token, chat.id), 200, 'người nhận đánh dấu');
  const st = await api('GET', '/api/crd/state', b.token);
  assert.equal(st.body.chats.find((c) => c.id === chat.id).read, true, 'state phản ánh đã đọc');

  const chat2 = (await api('POST', '/api/crd/chats', a.token, { toId: b.personId, msg: 'tin 2' })).body.chat;
  const thread = (token, body) => api('PUT', '/api/crd/chats/mark-thread-read', token, body);
  expectRes(await thread(b.token, {}), 400, 'thiếu fromId', 'Thiếu fromId');
  expectRes(await thread(b.token, { fromId: a.personId }), 200, 'đánh dấu cả luồng');
  const st2 = await api('GET', '/api/crd/state', b.token);
  assert.equal(st2.body.chats.find((c) => c.id === chat2.id).read, true);
});

test('kênh chung: giới hạn 3 tin liên tiếp rồi 429; đính kèm booking chỉ của chính mình', async () => {
  const eve = newUser('Người nói nhiều');
  const send = (token, body) => api('POST', '/api/crd/chats', token, { toId: BROADCAST, ...body });
  for (let i = 1; i <= 3; i++) expectRes(await send(eve.token, { msg: `thông báo ${i}` }), 201, `tin chung ${i}`);
  const blocked = await send(eve.token, { msg: 'tin thứ tư' });
  expectRes(blocked, 429, 'tin thứ tư', 'Vui lòng chờ');
  assert.equal(typeof blocked.body.retryAfter, 'number');
  assert.ok(blocked.body.retryAfter >= 1 && blocked.body.retryAfter <= 30, `retryAfter nằm trong 1–30s, thật ${blocked.body.retryAfter}`);

  // Dùng người khác để không đụng giới hạn của eve
  const a = newUser('Chủ lịch');
  const b = newUser('Người khác');
  const m = await newMachine();
  const bk = (await book(a.token, m.id, 9, 10)).body.booking;
  expectRes(await send(b.token, { msg: 'mượn lịch', bookingId: bk.id }), 403, 'đính kèm lịch người khác', 'booking của chính mình');
  expectRes(await send(b.token, { msg: 'x', bookingId: 'b_khong_co' }), 400, 'booking không tồn tại', 'Booking không tồn tại');
  const mine = await send(a.token, { msg: 'lịch của tôi', bookingId: bk.id });
  expectRes(mine, 201, 'đính kèm lịch của chính mình');
  assert.equal(mine.body.chat.toId, BROADCAST);
});

test('kênh chung: mốc "đã đọc" theo thời điểm tin mới nhất', async () => {
  const u = newUser('Người đọc');
  const r = await api('PUT', '/api/crd/chats/broadcast-read', u.token);
  expectRes(r, 200, 'broadcast-read');
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.broadcastLastRead, 'number');
  const st = await api('GET', '/api/crd/state', u.token);
  assert.equal(st.body.broadcastLastRead, r.body.broadcastLastRead, 'state trả lại đúng mốc vừa lưu');
});

test('xóa tin: tin riêng chỉ Admin hệ thống; tin kênh chung thêm vai trò Admin CRD', async () => {
  const a = newUser('Người gửi');
  const b = newUser('Người nhận');
  const mod = newUser('Người kiểm duyệt');
  await api('GET', '/api/crd/state', b.token);
  await api('GET', '/api/crd/state', mod.token);
  const del = (token, id) => api('DELETE', `/api/crd/admin/chats/${id}`, token);

  const priv = (await api('POST', '/api/crd/chats', a.token, { toId: b.personId, msg: 'riêng' })).body.chat;
  const pub = (await api('POST', '/api/crd/chats', a.token, { toId: BROADCAST, msg: 'chung' })).body.chat;
  expectRes(await del(a.token, 'c_khong_co'), 404, 'tin không tồn tại', 'Không tìm thấy');
  expectRes(await del(b.token, priv.id), 403, 'người thường xóa tin riêng', 'Chỉ quản trị hệ thống mới xóa được tin nhắn riêng');
  expectRes(await del(b.token, pub.id), 403, 'người thường xóa tin chung', 'vai trò Admin CRD');

  // Gán cờ quản trị CRD cho một vai trò rồi gán cho người kiểm duyệt
  const slug = `kd_${TAG}`.replace(/[^a-z0-9_]/g, '');
  expectRes(await api('POST', '/api/crd/admin/role-defs', admin, { slug, label: 'Kiểm duyệt', isAdminSlot: true }), 201, 'tạo vai trò CRD');
  expectRes(await api('PUT', `/api/crd/admin/persons/${mod.personId}`, admin, { role: slug }), 200, 'gán vai trò');
  expectRes(await del(mod.token, priv.id), 403, 'Admin CRD vẫn không xóa được tin riêng', 'tin nhắn riêng');
  expectRes(await del(mod.token, pub.id), 200, 'Admin CRD xóa tin kênh chung');
  expectRes(await del(admin, priv.id), 200, 'Admin hệ thống xóa tin riêng');

  const st = await api('GET', '/api/crd/state', a.token);
  assert.ok(!st.body.chats.some((c) => c.id === priv.id || c.id === pub.id), 'tin đã xóa biến mất khỏi state');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 5. KHIẾU NẠI
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('khiếu nại: gửi, Admin xem / xử lý / xóa, kiểm tra đầu vào', async () => {
  const u = newUser('Người khiếu nại');
  const other = newUser('Người bị khiếu nại');
  await api('GET', '/api/crd/state', other.token);
  const send = (body) => api('POST', '/api/crd/complaints', u.token, body);

  expectRes(await send({ subject: 'chỉ có tiêu đề' }), 400, 'thiếu nội dung', 'tiêu đề và nội dung');
  expectRes(await send({ body: 'chỉ có nội dung' }), 400, 'thiếu tiêu đề', 'tiêu đề và nội dung');
  const created = await send({ subject: `Khiếu nại ${TAG}`, body: 'máy hỏng', againstId: other.personId });
  expectRes(created, 201, 'gửi khiếu nại');
  const id = created.body.id;
  assert.equal(typeof id, 'number');

  const snap = await api('GET', '/api/crd/admin/snapshot', admin);
  const c = snap.body.complaints.find((x) => x.id === id);
  assert.ok(c, 'snapshot có khiếu nại vừa gửi');
  assert.deepEqual(
    { reporterId: c.reporterId, againstId: c.againstId, bookingId: c.bookingId, subject: c.subject, status: c.status, adminNote: c.adminNote },
    { reporterId: u.personId, againstId: other.personId, bookingId: null, subject: `Khiếu nại ${TAG}`, status: 'open', adminNote: '' }
  );

  const put = (cid, body) => api('PUT', `/api/crd/admin/complaints/${cid}`, admin, body);
  expectRes(await put('abc', {}), 400, 'id không phải số', 'ID không hợp lệ');
  expectRes(await put(99999999, {}), 404, 'id không tồn tại', 'Không tìm thấy');
  expectRes(await put(id, { status: 'dang-xu-ly' }), 400, 'trạng thái lạ', 'Trạng thái không hợp lệ');
  for (const status of ['in_review', 'resolved', 'rejected', 'open']) {
    expectRes(await put(id, { status, adminNote: `ghi chú ${status}` }), 200, `chuyển sang ${status}`);
  }
  const after = (await api('GET', '/api/crd/admin/snapshot', admin)).body.complaints.find((x) => x.id === id);
  assert.equal(after.status, 'open');
  assert.equal(after.adminNote, 'ghi chú open');

  expectRes(await api('DELETE', '/api/crd/admin/complaints/abc', admin), 400, 'xóa id sai dạng', 'ID không hợp lệ');
  expectRes(await api('DELETE', `/api/crd/admin/complaints/${id}`, admin), 200, 'xóa');
  expectRes(await api('DELETE', `/api/crd/admin/complaints/${id}`, admin), 404, 'xóa lần hai');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 6. QUẢN TRỊ — THIẾT BỊ
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('quản trị thiết bị: tạo — mặc định, kẹp giá trị, kiểm tra và trùng id', async () => {
  const create = (b) => api('POST', '/api/crd/admin/machines', admin, b);
  expectRes(await create({}), 400, 'thiếu tên', 'Tên thiết bị bắt buộc');
  expectRes(await create({ name: '  ' }), 400, 'tên toàn khoảng trắng', 'Tên thiết bị bắt buộc');
  expectRes(await create({ name: 'x', availFrom: 12, availTo: 12 }), 400, 'giờ đóng = giờ mở', 'availTo phải lớn hơn availFrom');
  expectRes(await create({ name: 'x', availFrom: 30 }), 400, 'availFrom bị kẹp về 23 nên availTo(20) < availFrom', 'availTo phải lớn hơn availFrom');

  const d = await create({ name: `Mặc định ${TAG}` });
  expectRes(d, 201, 'tạo với giá trị mặc định');
  assert.deepEqual(
    { type: d.body.machine.type, location: d.body.machine.location, color: d.body.machine.color, availFrom: d.body.machine.availFrom, availTo: d.body.machine.availTo, maxHours: d.body.machine.maxHours },
    { type: '', location: '', color: '#667eea', availFrom: 8, availTo: 20, maxHours: 4 }
  );
  assert.match(d.body.machine.id, /^m_[0-9a-f]{10}$/);

  const k = await create({ name: `Kẹp ${TAG}`, availFrom: 0.4, availTo: 99, maxHours: 99 });
  expectRes(k, 201, 'giá trị vượt biên bị kẹp');
  assert.equal(k.body.machine.availTo, 24, 'availTo kẹp về 24');
  assert.equal(k.body.machine.maxHours, 24, 'maxHours kẹp về 24');

  const id = `m_cua_toi_${TAG}`;
  expectRes(await create({ name: 'có id riêng', id }), 201, 'tạo với id chỉ định');
  expectRes(await create({ name: 'trùng id', id }), 409, 'trùng id', 'ID thiết bị đã tồn tại');
});

test('quản trị thiết bị: sửa — giữ trường không gửi, kẹp giá trị, kiểm tra', async () => {
  const m = await newMachine({ type: 'loại cũ' });
  const put = (id, b) => api('PUT', `/api/crd/admin/machines/${id}`, admin, b);
  expectRes(await put('m_khong_co', { name: 'x' }), 404, 'không tồn tại', 'Không tìm thấy');
  expectRes(await put(m.id, { name: '   ' }), 400, 'tên rỗng', 'Tên thiết bị bắt buộc');
  expectRes(await put(m.id, { availFrom: 15, availTo: 10 }), 400, 'đóng trước mở', 'availTo phải lớn hơn availFrom');
  const ok = await put(m.id, { location: 'phòng 101', maxHours: 2 });
  expectRes(ok, 200, 'sửa một phần');
  assert.equal(ok.body.machine.location, 'phòng 101');
  assert.equal(ok.body.machine.maxHours, 2);
  assert.equal(ok.body.machine.type, 'loại cũ', 'trường không gửi giữ nguyên');
  assert.equal(ok.body.machine.name, m.name);
  const clamp = await put(m.id, { maxHours: 500 });
  assert.equal(clamp.body.machine.maxHours, 24, 'maxHours kẹp về 24');
});

test('quản trị thiết bị: sắp xếp lại — kiểm tra danh sách id rồi áp dụng thứ tự', async () => {
  const reorder = (b) => api('PUT', '/api/crd/admin/machines/reorder', admin, b);
  const before = (await api('GET', '/api/crd/state', admin)).body.machines.map((x) => x.id);
  assert.ok(before.length >= 2, 'cần ít nhất 2 thiết bị');
  expectRes(await reorder({}), 400, 'không phải mảng', 'orderedIds phải là mảng');
  expectRes(await reorder({ orderedIds: [] }), 400, 'mảng rỗng', 'orderedIds phải là mảng');
  expectRes(await reorder({ orderedIds: [before[0], before[0]] }), 400, 'trùng id', 'Trùng ID');
  expectRes(await reorder({ orderedIds: before.slice(1) }), 400, 'thiếu một id', 'Số thiết bị không khớp');
  expectRes(await reorder({ orderedIds: [...before.slice(1), 'm_la'] }), 400, 'id lạ', 'không tồn tại trong orderedIds');

  const reversed = [...before].reverse();
  const ok = await reorder({ orderedIds: reversed });
  expectRes(ok, 200, 'đảo thứ tự');
  assert.deepEqual(ok.body.machines.map((x) => x.id), reversed);
  assert.deepEqual((await api('GET', '/api/crd/state', admin)).body.machines.map((x) => x.id), reversed, 'state phản ánh thứ tự mới');
  expectRes(await reorder({ orderedIds: before }), 200, 'khôi phục thứ tự');
});

test('quản trị thiết bị: xóa thiết bị kéo theo xóa mọi lịch của nó', async () => {
  const u = newUser('Người đặt lịch');
  const m = await newMachine();
  const bk = (await book(u.token, m.id, 9, 10)).body.booking;
  expectRes(await api('DELETE', '/api/crd/admin/machines/m_khong_co', admin), 404, 'không tồn tại', 'Không tìm thấy');
  expectRes(await api('DELETE', `/api/crd/admin/machines/${m.id}`, admin), 200, 'xóa thiết bị');
  const st = await api('GET', '/api/crd/state', u.token);
  assert.ok(!st.body.machines.some((x) => x.id === m.id), 'thiết bị đã biến mất');
  assert.ok(!st.body.bookings.some((x) => x.id === bk.id), 'lịch của thiết bị đã bị xóa theo');
  expectRes(await api('DELETE', `/api/crd/admin/machines/${m.id}`, admin), 404, 'xóa lần hai');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 7. QUẢN TRỊ — HỒ SƠ CRD, TÀI KHOẢN, VAI TRÒ, LỊCH
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('quản trị hồ sơ CRD: tạo / sửa / thống kê', async () => {
  const create = (b) => api('POST', '/api/crd/admin/persons', admin, b);
  expectRes(await create({}), 400, 'thiếu tên', 'Tên bắt buộc');
  expectRes(await create({ name: 'A', role: 'vai-tro-la' }), 400, 'vai trò không có trong danh sách', 'Vai trò không hợp lệ');
  const id = `u_khach_${TAG}`;
  const ok = await create({ id, name: 'Khách Mới', email: ' KHACH@Example.ORG ' });
  expectRes(ok, 201, 'tạo hồ sơ');
  assert.deepEqual(
    { id: ok.body.user.id, name: ok.body.user.name, email: ok.body.user.email, role: ok.body.user.role, avatar: ok.body.user.avatar },
    { id, name: 'Khách Mới', email: 'khach@example.org', role: 'user', avatar: 'K' }
  );
  expectRes(await create({ id, name: 'Trùng' }), 409, 'trùng id', 'ID đã tồn tại');

  const put = (pid, b) => api('PUT', `/api/crd/admin/persons/${pid}`, admin, b);
  expectRes(await put('u_khong_co', { name: 'x' }), 404, 'không tồn tại', 'Không tìm thấy');
  expectRes(await put(id, { name: '  ' }), 400, 'tên rỗng', 'Tên không được để trống');
  expectRes(await put(id, { role: 'khong-co' }), 400, 'vai trò lạ', 'Vai trò không hợp lệ');
  const upd = await put(id, { name: 'Tên Mới', role: 'admin', isBanned: true });
  expectRes(upd, 200, 'sửa');
  assert.deepEqual({ name: upd.body.user.name, role: upd.body.user.role, isBanned: upd.body.user.isBanned }, { name: 'Tên Mới', role: 'admin', isBanned: true });
  assert.equal(upd.body.user.email, 'khach@example.org', 'trường không gửi giữ nguyên');

  // Thống kê: chỉ tính lịch chưa hủy, làm tròn giờ
  const u = newUser('Người thống kê');
  const m1 = await newMachine();
  const m2 = await newMachine();
  await book(u.token, m1.id, 9, 11);          // 2h
  await book(u.token, m1.id, 12, 13.5);       // 1,5h
  const onM2 = (await book(u.token, m2.id, 9, 10)).body.booking; // 1h
  const stats = await api('GET', `/api/crd/admin/persons/${u.personId}/stats`, admin);
  expectRes(stats, 200, 'thống kê');
  assert.equal(stats.body.personId, u.personId);
  assert.equal(stats.body.totalBookings, 3);
  assert.equal(stats.body.totalHours, 4.5);
  assert.equal(stats.body.byMachine.length, 2);
  assert.deepEqual(stats.body.byMachine[0], { machineId: m1.id, machineName: m1.name, bookings: 2, hours: 3.5 }, 'sắp theo số giờ giảm dần');

  // Lịch đã hủy (status = cancelled, chỉ Admin đặt được) KHÔNG được tính vào thống kê
  expectRes(await api('PUT', `/api/crd/admin/bookings/${onM2.id}`, admin, { status: 'cancelled' }), 200, 'Admin đánh dấu đã hủy');
  const after = await api('GET', `/api/crd/admin/persons/${u.personId}/stats`, admin);
  assert.equal(after.body.totalBookings, 2, 'lịch đã hủy bị loại khỏi tổng số lịch');
  assert.equal(after.body.totalHours, 3.5, 'lịch đã hủy bị loại khỏi tổng giờ');
  assert.deepEqual(after.body.byMachine.map((x) => x.machineId), [m1.id], 'máy chỉ có lịch đã hủy không còn trong thống kê');
  expectRes(await api('GET', '/api/crd/admin/persons/u_khong_co/stats', admin), 404, 'thống kê người lạ', 'Không tìm thấy người dùng CRD');
});

test('quản trị hồ sơ CRD: xóa — hồ sơ thủ công xóa hẳn, hồ sơ từ tài khoản chỉ bị GỠ quyền', async () => {
  const del = (id) => api('DELETE', `/api/crd/admin/persons/${id}`, admin);
  expectRes(await del('u_khong_co'), 404, 'không tồn tại', 'Không tìm thấy');

  // Hồ sơ tạo tay (không có tiền tố u_app_): xóa hẳn
  const manual = `u_tay_${TAG}`;
  expectRes(await api('POST', '/api/crd/admin/persons', admin, { id: manual, name: 'Hồ sơ tay' }), 201, 'tạo hồ sơ tay');
  const del1 = await del(manual);
  expectRes(del1, 200, 'xóa hồ sơ tay');
  assert.deepEqual(del1.body, { ok: true });
  const st0 = await api('GET', '/api/crd/state', admin);
  assert.ok(!st0.body.users.some((x) => x.id === manual), 'hồ sơ tay đã biến mất');

  // Hồ sơ gắn tài khoản (u_app_…): xóa lịch + chat, nhưng giữ hồ sơ và đánh dấu gỡ quyền
  const a = newUser('Người bị gỡ');
  const b = newUser('Người còn lại');
  await api('GET', '/api/crd/state', b.token);
  const m = await newMachine();
  const bk = (await book(a.token, m.id, 9, 10)).body.booking;
  const chat = (await api('POST', '/api/crd/chats', a.token, { toId: b.personId, msg: 'sẽ mất' })).body.chat;
  const del2 = await del(a.personId);
  expectRes(del2, 200, 'gỡ hồ sơ gắn tài khoản');
  assert.equal(del2.body.revoked, true);
  assert.match(del2.body.message, /Đã gỡ quyền CRD/);
  const st = await api('GET', '/api/crd/admin/snapshot', admin);
  const kept = st.body.users.find((x) => x.id === a.personId);
  assert.ok(kept, 'hồ sơ vẫn còn (Admin thấy cả hồ sơ bị gỡ)');
  assert.equal(kept.crdAccessRevoked, true);
  assert.ok(!st.body.bookings.some((x) => x.id === bk.id), 'lịch của họ đã bị xóa');
  assert.ok(!st.body.chats.some((x) => x.id === chat.id), 'chat của họ đã bị xóa');
  expectRes(await api('GET', '/api/crd/state', a.token), 403, 'họ không vào lại được', 'đã bị gỡ');
  const stB = await api('GET', '/api/crd/state', b.token);
  assert.ok(!stB.body.users.some((x) => x.id === a.personId), 'người thường không còn thấy hồ sơ bị gỡ trong danh sách');
});

test('quản trị tài khoản: danh sách kèm trạng thái CRD, khóa / mở, đặt lại mật khẩu', async () => {
  const withCrd = newUser('Có hồ sơ CRD');
  const noCrd = newUser('Chưa vào CRD');
  await api('GET', '/api/crd/state', withCrd.token);

  const list = await api('GET', '/api/crd/admin/users', admin);
  expectRes(list, 200, 'danh sách');
  assert.ok(Array.isArray(list.body));
  const a = list.body.find((x) => x.id === withCrd.id);
  assert.equal(a.email, withCrd.email);
  assert.equal(a.role, 'researcher');
  assert.equal(a.isDisabled, false);
  assert.equal(a.crd.personId, withCrd.personId);
  assert.equal(a.crd.syncedFromApp, true);
  assert.equal(a.crd.isInVien, true, 'email @sci.edu.vn được tính là trong Viện');
  assert.equal(list.body.find((x) => x.id === noCrd.id).crd, null, 'chưa vào module thì crd = null');

  const dis = (id) => api('PUT', `/api/crd/admin/users/${id}/disable`, admin);
  expectRes(await dis('abc'), 400, 'id sai dạng', 'ID không hợp lệ');
  expectRes(await dis(99999999), 404, 'id lạ', 'Không tìm thấy tài khoản');
  const off = await dis(noCrd.id);
  expectRes(off, 200, 'khóa');
  assert.equal(off.body.isDisabled, true);
  assert.match(off.body.message, /vô hiệu hoá/);
  const on = await dis(noCrd.id);
  assert.equal(on.body.isDisabled, false, 'gọi lần hai là mở lại (đảo trạng thái)');
  assert.match(on.body.message, /kích hoạt lại/);

  const reset = (id, b) => api('POST', `/api/crd/admin/users/${id}/reset-password`, admin, b);
  expectRes(await reset('abc', { password: 'secret1' }), 400, 'id sai dạng', 'ID không hợp lệ');
  expectRes(await reset(99999999, { password: 'secret1' }), 404, 'id lạ', 'Không tìm thấy tài khoản');
  expectRes(await reset(noCrd.id, { password: '12345' }), 400, 'quá ngắn', 'ít nhất 6');
  expectRes(await reset(noCrd.id, { password: 'x'.repeat(129) }), 400, 'quá dài', 'quá dài');
  expectRes(await reset(noCrd.id, { password: '  MatKhau-Moi-1  ' }), 200, 'đặt lại', 'Đã đặt lại mật khẩu thành công');

  // Mật khẩu mới thật sự được băm vào DB (bcrypt) và đã cắt khoảng trắng
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
  const db = new Database(srv.dbPath, { readonly: true });
  const row = db.prepare('SELECT password FROM users WHERE id = ?').get(noCrd.id);
  db.close();
  assert.ok(bcrypt.compareSync('MatKhau-Moi-1', row.password), 'hash khớp mật khẩu đã cắt khoảng trắng');
});

test('quản trị vai trò CRD: tạo / sửa / xóa và các vai trò mặc định được bảo vệ', async () => {
  const create = (b) => api('POST', '/api/crd/admin/role-defs', admin, b);
  expectRes(await create({ slug: 'Sai Ma', label: 'x' }), 400, 'mã sai dạng', 'Mã vai trò');
  expectRes(await create({ slug: '1abc', label: 'x' }), 400, 'mã bắt đầu bằng số', 'Mã vai trò');
  expectRes(await create({ slug: 'okslug', label: '' }), 400, 'thiếu tên hiển thị', 'Nhập tên hiển thị');
  expectRes(await create({ slug: 'user', label: 'x' }), 409, 'trùng vai trò mặc định', 'Mã vai trò đã tồn tại');

  const slug = `vt_${TAG}`.replace(/[^a-z0-9_]/g, '');
  const ok = await create({ slug: slug.toUpperCase(), label: 'Vai trò thử', sortOrder: 7, isAdminSlot: true });
  expectRes(ok, 201, 'tạo');
  const made = ok.body.crdRoles.find((x) => x.slug === slug);
  assert.deepEqual({ label: made.label, sortOrder: made.sortOrder, isAdminSlot: made.isAdminSlot }, { label: 'Vai trò thử', sortOrder: 7, isAdminSlot: true });
  assert.equal(ok.body.crdRoles.find((x) => x.slug === slug.toUpperCase()), undefined, 'mã được chuẩn hoá chữ thường');

  const put = (s, b) => api('PUT', `/api/crd/admin/role-defs/${s}`, admin, b);
  expectRes(await put('khong_co', { label: 'x' }), 404, 'sửa vai trò lạ', 'Không tìm thấy vai trò');
  expectRes(await put(slug, { label: '  ' }), 400, 'tên rỗng', 'không được trống');
  const upd = await put(slug, { label: 'Tên mới', isAdminSlot: false });
  assert.equal(upd.body.crdRoles.find((x) => x.slug === slug).label, 'Tên mới');
  assert.equal(upd.body.crdRoles.find((x) => x.slug === slug).isAdminSlot, false);
  // Vai trò mặc định: cờ quản trị bị ép cố định
  assert.equal((await put('user', { isAdminSlot: true })).body.crdRoles.find((x) => x.slug === 'user').isAdminSlot, false, 'user không bao giờ là slot quản trị');
  assert.equal((await put('admin', { isAdminSlot: false })).body.crdRoles.find((x) => x.slug === 'admin').isAdminSlot, true, 'admin luôn là slot quản trị');

  const del = (s) => api('DELETE', `/api/crd/admin/role-defs/${s}`, admin);
  expectRes(await del('user'), 400, 'xóa user', 'Không xóa được vai trò mặc định');
  expectRes(await del('admin'), 400, 'xóa admin', 'Không xóa được vai trò mặc định');
  expectRes(await del('khong_co'), 404, 'xóa vai trò lạ', 'Không tìm thấy');

  const holder = newUser('Người giữ vai trò');
  await api('GET', '/api/crd/state', holder.token);
  expectRes(await api('PUT', `/api/crd/admin/persons/${holder.personId}`, admin, { role: slug }), 200, 'gán vai trò');
  expectRes(await del(slug), 400, 'xóa khi còn người dùng', 'Còn người dùng đang gán vai trò này');
  expectRes(await api('PUT', `/api/crd/admin/persons/${holder.personId}`, admin, { role: 'user' }), 200, 'trả về user');
  expectRes(await del(slug), 200, 'xóa khi không còn ai giữ');
});

test('quản trị lịch: Admin sửa mọi trường, kiểm tra đủ điều kiện, xóa', async () => {
  const a = newUser('Chủ lịch');
  const b = newUser('Người khác');
  const m = await newMachine();
  const m2 = await newMachine({ availFrom: 10, availTo: 14, maxHours: 2 });
  await api('GET', '/api/crd/state', b.token);
  const bk = (await book(a.token, m.id, 9, 10)).body.booking;
  await book(b.token, m2.id, 11, 12);
  const put = (id, body) => api('PUT', `/api/crd/admin/bookings/${id}`, admin, body);

  expectRes(await put('b_khong_co', {}), 404, 'lịch lạ', 'Không tìm thấy');
  expectRes(await put(bk.id, { machineId: 'm_la' }), 400, 'thiết bị lạ', 'Thiết bị không tồn tại');
  expectRes(await put(bk.id, { userId: 'u_la' }), 400, 'người dùng lạ', 'Người dùng CRD không tồn tại');
  expectRes(await put(bk.id, { startH: 10, endH: 10 }), 400, 'kết thúc = bắt đầu', 'Giờ kết thúc phải sau giờ bắt đầu');
  expectRes(await put(bk.id, { startH: 9.2 }), 400, 'lẻ', 'bước 30 phút');
  expectRes(await put(bk.id, { machineId: m2.id, startH: 9, endH: 10 }), 400, 'ngoài giờ mở của máy mới', 'Ngoài khung giờ mở');
  expectRes(await put(bk.id, { machineId: m2.id, startH: 10, endH: 13 }), 400, 'vượt tối đa của máy mới', 'Vượt tối đa 2 giờ');
  expectRes(await put(bk.id, { machineId: m2.id, startH: 11, endH: 12 }), 409, 'đè lịch của B trên máy mới', 'Trùng lịch với booking khác');

  const ok = await put(bk.id, { machineId: m2.id, userId: b.personId, date: '2031-06-01', startH: 11, endH: 12, status: 'cancelled' });
  expectRes(ok, 200, 'Admin chuyển lịch sang máy/người/ngày khác');
  assert.deepEqual(
    { machineId: ok.body.booking.machineId, userId: ok.body.booking.userId, date: ok.body.booking.date, status: ok.body.booking.status },
    { machineId: m2.id, userId: b.personId, date: '2031-06-01', status: 'cancelled' }
  );

  expectRes(await api('DELETE', '/api/crd/admin/bookings/b_khong_co', admin), 404, 'xóa lịch lạ', 'Không tìm thấy');
  expectRes(await api('DELETE', `/api/crd/admin/bookings/${bk.id}`, admin), 200, 'xóa lịch');
});

test('thông báo của phòng lab: tạo / sửa / bật tắt / xóa, người dùng chỉ thấy thông báo đang bật', async () => {
  const u = newUser('Người đọc');
  const create = (b) => api('POST', '/api/crd/admin/lab-announcements', admin, b);
  expectRes(await create({}), 400, 'rỗng cả hai', 'tiêu đề hoặc nội dung');
  expectRes(await create({ title: '  ', body: '  ' }), 400, 'chỉ khoảng trắng', 'tiêu đề hoặc nội dung');

  const on = await create({ title: `Bật ${TAG}`, body: 'nội dung' });
  expectRes(on, 201, 'tạo thông báo bật');
  assert.match(on.body.announcement.id, /^la_[0-9a-f]{12}$/);
  assert.equal(on.body.announcement.isActive, true);
  const off = await create({ title: `Tắt ${TAG}`, isActive: false });
  expectRes(off, 201, 'tạo thông báo tắt');
  assert.equal(off.body.announcement.isActive, false);

  const seen = (await api('GET', '/api/crd/state', u.token)).body.labAnnouncements.map((x) => x.id);
  assert.ok(seen.includes(on.body.announcement.id), 'thông báo bật hiện ra cho người dùng');
  assert.ok(!seen.includes(off.body.announcement.id), 'thông báo tắt bị ẩn với người dùng');
  const adminList = (await api('GET', '/api/crd/admin/lab-announcements', admin)).body.announcements.map((x) => x.id);
  assert.ok(adminList.includes(off.body.announcement.id), 'Admin vẫn thấy thông báo đã tắt');

  const put = (id, b) => api('PUT', `/api/crd/admin/lab-announcements/${id}`, admin, b);
  expectRes(await put('la_khong_co', { title: 'x' }), 404, 'sửa thông báo lạ', 'Không tìm thấy thông báo');
  expectRes(await put(on.body.announcement.id, { title: '', body: '' }), 400, 'làm rỗng cả hai', 'không được để trống cùng lúc');
  const flipped = await put(off.body.announcement.id, { isActive: true });
  expectRes(flipped, 200, 'bật lại');
  assert.equal(flipped.body.announcement.isActive, true);
  assert.ok(flipped.body.labAnnouncements.some((x) => x.id === off.body.announcement.id), 'danh sách đang bật được trả kèm');

  const del = (id) => api('DELETE', `/api/crd/admin/lab-announcements/${id}`, admin);
  expectRes(await del('la_khong_co'), 404, 'xóa thông báo lạ', 'Không tìm thấy thông báo');
  expectRes(await del(on.body.announcement.id), 200, 'xóa 1');
  expectRes(await del(off.body.announcement.id), 200, 'xóa 2');
});

test('thông báo email của chính mình: bật / tắt và mặc định khi không gửi giá trị', async () => {
  const u = newUser('Người nhận email');
  const get = () => api('GET', '/api/crd/email-notif', u.token);
  const put = (b) => api('PUT', '/api/crd/email-notif', u.token, b);
  expectRes(await get(), 200, 'đọc ban đầu');
  assert.equal(typeof (await get()).body.enabled, 'boolean');
  const off = await put({ enabled: false });
  expectRes(off, 200, 'tắt');
  assert.deepEqual(off.body, { ok: true, enabled: false });
  assert.equal((await get()).body.enabled, false);
  assert.deepEqual((await put({ enabled: true })).body, { ok: true, enabled: true });
  assert.equal((await get()).body.enabled, true);
  await put({ enabled: false });
  assert.deepEqual((await put({})).body, { ok: true, enabled: true }, 'không gửi enabled thì mặc định BẬT');
});
