'use strict';

/**
 * Sinh viên của Viện từ danh sách chờ đến tài khoản dùng được — chạy trên server thật (hộp cát), vì phần quan trọng nằm ở
 * xác thực: cổng đăng ký chính, chặn chiếm email qua đăng ký CRD (không xác minh hộp thư), giới hạn vai trò sinh_vien ở
 * authMiddleware và cổng .html, và hết hạn chỉ khóa module này.
 *
 * Cổng TEST_PORT_SINH_VIEN (mặc định 3204). SMTP trong hộp cát để rỗng: đăng ký của email ĐƯỢC PHÉP trả 503 («chưa cấu hình
 * gửi email») còn email KHÔNG được phép trả 202 như thường — hai mã khác nhau cho thấy email đã qua cổng hay chưa.
 * Bước đặt mật khẩu được mô phỏng bằng cách ghi mã xác minh trực tiếp vào bảng (đúng cơ chế băm của dịch vụ).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');
const { bamMa } = require('../services/xacMinhEmail');

const ROOT = path.resolve(__dirname, '..');
const NH = '/api/ngan-hang-te-bao-khang-the';
const EM1 = 'sv-dau-cuoi-1@gmail.test';
const EM2 = 'sv-dau-cuoi-2@gmail.test';
const NGOAI = 'nguoi-ngoai@gmail.test';
const MK = 'mat-khau-sinh-vien-1';

let srv;
let admin;
let tokenSv;

const mo = () => {
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  return new Database(srv.dbPath);
};
const sql = (fn) => {
  const db = mo();
  try {
    return fn(db);
  } finally {
    db.close();
  }
};
async function api(method, url, token, body) {
  const r = await call(srv.baseUrl, url, { token, method, body: method === 'GET' ? undefined : body });
  let json = null;
  try {
    json = await r.json();
  } catch (_) {}
  return { s: r.status, body: json };
}
const dangKy = (email) => api('POST', '/api/register', null, { email, fullname: 'Sinh Viên Thử' });

test.before(async () => {
  srv = await startTestServer({ port: Number(process.env.TEST_PORT_SINH_VIEN || 3204), env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = srv.tokens.admin;
});
test.after(async () => {
  if (srv) await srv.stop();
});

test('nhập danh sách bằng admin: tạo sẵn tài khoản sinh_vien chưa kích hoạt', async () => {
  const r = await api('POST', NH + '/students/import', admin, { text: `${EM1}\tSinh Viên Một\t2401\tK24\n${EM2}\tSinh Viên Hai`, het_han: '2999-12-31' });
  assert.equal(r.s, 200, JSON.stringify(r.body));
  assert.equal(r.body.moi, 2);
  const u = sql((db) => db.prepare('SELECT role, password FROM users WHERE email = ?').get(EM1));
  assert.deepEqual(u, { role: 'sinh_vien', password: '' });
});

test('cổng đăng ký chính: email trong danh sách qua được cổng; email ngoài danh sách nhận cùng thông báo nhưng KHÔNG có thư', async () => {
  const trong = await dangKy(EM1);
  assert.equal(trong.s, 503, 'qua cổng rồi mới dừng vì hộp cát không có SMTP');
  const ngoai = await dangKy(NGOAI);
  assert.equal(ngoai.s, 202);
  assert.equal(ngoai.body.daGuiThu, true);
  assert.equal(sql((db) => db.prepare('SELECT COUNT(*) AS c FROM email_verifications WHERE email = ?').get(NGOAI).c), 0);
  assert.equal(sql((db) => db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get(NGOAI).c), 0);
  assert.equal((await dangKy('khong-hop-le')).s, 400);
});

test('chống chiếm email: đăng ký CRD (không xác minh hộp thư) bằng email trong danh sách bị từ chối, không tạo tài khoản', async () => {
  sql((db) => db.prepare('DELETE FROM users WHERE email = ?').run(EM2)); // giả lập chưa có hàng nào giữ chỗ email
  const r = await api('POST', '/api/crd/public/register', null, { email: EM2, password: 'ke-chiem-1', fullname: 'Kẻ Chiếm' });
  assert.equal(r.s, 400);
  assert.match(r.body.message, /đã được sử dụng/);
  assert.equal(sql((db) => db.prepare('SELECT COUNT(*) AS c FROM users WHERE email = ?').get(EM2).c), 0);
  // email ngoài danh sách thì đăng ký CRD vẫn như cũ
  const binhThuong = await api('POST', '/api/crd/public/register', null, { email: NGOAI, password: 'khach-1', fullname: 'Khách' });
  assert.equal(binhThuong.s, 201);
  assert.equal(binhThuong.body.user.role, 'crd_user');
  // người đã chiếm trước khi có danh sách bị đặt lại khi nhập
  const t = await api('POST', NH + '/students/import', admin, { text: `${NGOAI}\tNgười Thật`, het_han: '2999-12-31' });
  assert.equal(t.body.dat_lai_crd, 1);
  assert.deepEqual(sql((db) => db.prepare('SELECT role, password FROM users WHERE email = ?').get(NGOAI)), { role: 'sinh_vien', password: '' });
  assert.equal((await dangKy(NGOAI)).s, 503, 'giờ chính chủ đăng ký được (sau khi xác minh hộp thư)');
});

test('kích hoạt qua liên kết xác minh: tài khoản vẫn là sinh_vien (không thành researcher), mật khẩu đặt được', async () => {
  const ma = 'a'.repeat(64);
  sql((db) =>
    db
      .prepare('INSERT INTO email_verifications (email, token_hash, fullname, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(EM1, bamMa(ma), 'Sinh Viên Một', new Date().toISOString(), new Date(Date.now() + 3600 * 1000).toISOString())
  );
  const r = await api('POST', '/api/register/hoan-tat', null, { token: ma, password: MK });
  assert.equal(r.s, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'sinh_vien');
  tokenSv = r.body.token;
  assert.ok(tokenSv);
  assert.deepEqual(sql((db) => db.prepare('SELECT role FROM users WHERE email = ?').get(EM1)), { role: 'sinh_vien' });
});

test('sinh viên đã kích hoạt: vào được Ngân hàng tế bào và Đặt lịch thiết bị; KHÔNG vào được module khác (API và trang .html)', async () => {
  const me = await api('GET', NH + '/me', tokenSv);
  assert.equal(me.s, 200);
  assert.equal(me.body.hoSo.loai, 'sinh_vien');
  assert.equal((await api('GET', NH + '/tree', tokenSv)).s, 200);
  assert.equal((await api('GET', '/api/crd/state', tokenSv)).s, 200);
  const khac = await api('GET', '/api/missions', tokenSv);
  assert.equal(khac.s, 403);
  assert.match(khac.body.message, /Tài khoản sinh viên chỉ dùng cho/);
  const hoiDong = await api('GET', '/api/submissions', tokenSv);
  assert.equal(hoiDong.s, 403);
  // trang .html
  const get = (p) => fetch(srv.baseUrl + p, { redirect: 'manual', headers: { Authorization: 'Bearer ' + tokenSv } });
  assert.equal((await get('/public/ngan-hang-te-bao-khang-the/index.html')).status, 200);
  assert.equal((await get('/crd-booking-v2.html')).status, 200);
  const chuyen = await get('/cong-bo-khoa-hoc.html');
  assert.equal(chuyen.status, 302);
  assert.equal(chuyen.headers.get('location'), '/public/ngan-hang-te-bao-khang-the/index.html');
});

test('crd_user (khách ngoài) vẫn bị chặn khỏi Ngân hàng tế bào và mọi module ngoài Đặt lịch như trước', async () => {
  const khach = addUser(srv, { fullname: 'Khách CRD', role: 'crd_user' });
  assert.equal((await api('GET', NH + '/me', khach.token)).s, 403);
  const r = await api('GET', '/api/missions', khach.token);
  assert.equal(r.s, 403);
  assert.match(r.body.message, /chỉ dùng cho module Đặt lịch thiết bị CRD/);
});

test('HẾT HẠN: chỉ khóa module Ngân hàng; Đặt lịch thiết bị vẫn dùng được; gia hạn thì vào lại', async () => {
  sql((db) => db.prepare("UPDATE nhm_sinh_vien SET het_han = '2000-01-01' WHERE email = ?").run(EM1));
  const khoa = await api('GET', NH + '/me', tokenSv);
  assert.equal(khoa.s, 403);
  assert.equal(khoa.body.hetHan, true);
  assert.equal((await api('GET', NH + '/tree', tokenSv)).s, 403);
  assert.equal((await api('GET', '/api/crd/state', tokenSv)).s, 200, 'tài khoản không bị khóa: vẫn đặt lịch thiết bị');
  const ds = (await api('GET', NH + '/students', admin)).body.students.find((x) => x.email === EM1);
  assert.equal(ds.tinh_trang, 'het_han');
  assert.equal((await api('PATCH', NH + `/students/${ds.id}`, admin, { het_han: '2999-12-31' })).s, 200);
  assert.equal((await api('GET', NH + '/me', tokenSv)).s, 200);
});

test('người thường (researcher) không bị ảnh hưởng: vẫn vào được Ngân hàng tế bào và module khác', async () => {
  const ncv = addUser(srv, { fullname: 'Nghiên cứu viên', role: 'researcher' });
  assert.equal((await api('GET', NH + '/me', ncv.token)).s, 200);
  assert.notEqual((await api('GET', '/api/missions', ncv.token)).s, 403);
});
