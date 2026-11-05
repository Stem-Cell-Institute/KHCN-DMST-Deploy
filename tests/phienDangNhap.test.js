/**
 * tests/phienDangNhap.test.js
 * POST /api/phien/khoi-phuc: cấp lại cookie đăng nhập từ token trong trình duyệt, gia hạn trượt khi token sắp hết hạn.
 * Dùng thư viện jsonwebtoken THẬT với khóa thử; không đụng DB hay khóa của hệ thống.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const jwt = require(path.join(__dirname, '..', 'node_modules', 'jsonwebtoken'));
const express = require(path.join(__dirname, '..', 'node_modules', 'express'));
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
const createPhienRouter = require('../routes/phien');

const KHOA = 'khoa-thu-nghiem-khong-dung-that';
const NGUONG = createPhienRouter.NGUONG_GIA_HAN_GIAY;
let server;
let base;
let db;
const biKhoa = new Set();
const cookieDaCap = [];

test.before(async () => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, fullname TEXT, role TEXT)');
  db.prepare("INSERT INTO users VALUES (1,'vien.truong@thu.local','Viện Trưởng Thử','researcher')").run();
  db.prepare("INSERT INTO users VALUES (2,'admin@thu.local','Quản Trị Thử','admin')").run();
  db.prepare("INSERT INTO users VALUES (3,'bi.khoa@thu.local','Bị Khóa','researcher')").run();
  biKhoa.add(3);
  const app = express();
  app.use(
    '/api/phien',
    createPhienRouter({
      jwt,
      JWT_SECRET: KHOA,
      db,
      setAuthCookie: (res, token) => { cookieDaCap.push(token); res.append('Set-Cookie', 'auth_token=' + encodeURIComponent(token) + '; HttpOnly; Path=/'); },
      userIdIsBanned: (id) => biKhoa.has(id),
      userEmailIsMasterAdmin: (e) => e === 'admin@thu.local',
    })
  );
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
});

const ky = (payload, opts = {}) => jwt.sign(payload, KHOA, opts);
const goi = (headers = {}) => fetch(base + '/api/phien/khoi-phuc', { method: 'POST', headers });

test('token còn hạn dài: cấp lại cookie, KHÔNG đổi token', async () => {
  cookieDaCap.length = 0;
  const token = ky({ id: 1, email: 'vien.truong@thu.local', role: 'researcher' }, { expiresIn: '7d' });
  const r = await goi({ Authorization: 'Bearer ' + token });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.token, token);
  assert.equal(d.gia_han, false);
  assert.equal(d.user.fullname, 'Viện Trưởng Thử');
  assert.match(r.headers.get('set-cookie'), /^auth_token=/);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.deepEqual(cookieDaCap, [token]);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('token sắp hết hạn: cấp token MỚI 7 ngày (gia hạn trượt), cookie mang token mới', async () => {
  cookieDaCap.length = 0;
  const cu = ky({ id: 1, email: 'vien.truong@thu.local', role: 'researcher' }, { expiresIn: NGUONG - 3600 });
  const r = await goi({ Authorization: 'Bearer ' + cu });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.gia_han, true);
  assert.notEqual(d.token, cu);
  const moi = jwt.verify(d.token, KHOA);
  assert.ok(moi.exp - Math.floor(Date.now() / 1000) > 6.9 * 24 * 3600, 'token mới sống khoảng 7 ngày');
  assert.equal(moi.id, 1);
  assert.deepEqual(cookieDaCap, [d.token]);
});

test('thông tin người dùng lấy từ DB, không tin payload cũ: đổi vai trò/họ tên có hiệu lực khi gia hạn', async () => {
  db.prepare("UPDATE users SET fullname = 'Tên Mới', role = 'researcher' WHERE id = 1").run();
  const cu = ky({ id: 1, email: 'vien.truong@thu.local', fullname: 'Tên Cũ', role: 'admin' }, { expiresIn: 60 });
  const d = await (await goi({ Authorization: 'Bearer ' + cu })).json();
  assert.equal(d.user.fullname, 'Tên Mới');
  assert.equal(d.user.role, 'researcher', 'không giữ quyền admin ghi trong token cũ');
  assert.equal(jwt.verify(d.token, KHOA).role, 'researcher');
});

test('admin: có cờ isMasterAdmin như lúc đăng nhập', async () => {
  const cu = ky({ id: 2, email: 'admin@thu.local', role: 'admin' }, { expiresIn: 60 });
  const d = await (await goi({ Authorization: 'Bearer ' + cu })).json();
  assert.equal(d.user.isMasterAdmin, true);
});

test('từ chối và KHÔNG cấp cookie: không có token, token sai khóa, token hết hạn, tài khoản đã xóa', async () => {
  cookieDaCap.length = 0;
  const truong = [
    {},
    { Authorization: 'Bearer ' },
    { Authorization: 'Basic abc' },
    { Authorization: 'Bearer ' + jwt.sign({ id: 1 }, 'khoa-khac', { expiresIn: '7d' }) },
    { Authorization: 'Bearer ' + ky({ id: 1 }, { expiresIn: -10 }) },
    { Authorization: 'Bearer ' + ky({ id: 999 }, { expiresIn: '7d' }) },
  ];
  for (const h of truong) {
    const r = await goi(h);
    assert.equal(r.status, 401, JSON.stringify(h).slice(0, 60));
    assert.equal(r.headers.get('set-cookie'), null, 'không được cấp cookie');
  }
  assert.deepEqual(cookieDaCap, []);
});

test('tài khoản bị khóa: 403, không cấp cookie', async () => {
  const r = await goi({ Authorization: 'Bearer ' + ky({ id: 3, email: 'bi.khoa@thu.local' }, { expiresIn: '7d' }) });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('chỉ nhận token trong header Authorization: cookie hay tham số URL không đủ', async () => {
  const token = ky({ id: 1 }, { expiresIn: '7d' });
  assert.equal((await goi({ Cookie: 'auth_token=' + token })).status, 401);
  const r = await fetch(base + '/api/phien/khoi-phuc?token=' + token, { method: 'POST' });
  assert.equal(r.status, 401);
});

test('chỉ nhận POST (GET không khôi phục được)', async () => {
  const token = ky({ id: 1 }, { expiresIn: '7d' });
  const r = await fetch(base + '/api/phien/khoi-phuc', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(r.status, 404);
});
