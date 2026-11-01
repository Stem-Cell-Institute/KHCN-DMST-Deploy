'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — bảng phân quyền của TOÀN BỘ route, chạy trên server thật (hộp cát).
 *
 * Giống tests/crd.test.js: bảng ROUTES dưới đây phải khớp đúng danh sách route đã đăng ký (route-inventory),
 * nên thêm / bớt route mà quên cập nhật bảng và quên nghĩ tới quyền là test báo ngay. Sửa bảng CÓ CHỦ ĐÍCH.
 *
 *   auth   — mọi người đã đăng nhập
 *   manage — Admin hoặc quản lý module (requireManage)
 *   admin  — chỉ Admin (cấp / gỡ vai trò module)
 *   owner  — người đăng nhập, nhưng sửa/xóa/di chuyển chỉ chủ sở hữu hoặc quản lý (kiểm trong handler)
 *
 * Cổng riêng TEST_PORT_NGAN_HANG (mặc định 3202). Cần data/sci-ace.db và JWT_SECRET như `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

const ROOT = path.resolve(__dirname, '..');
const P = '/api/ngan-hang-te-bao-khang-the';

const ROUTES = [
  ['GET', '/meta', 'auth'],
  ['GET', '/tree', 'auth'],
  ['POST', '/containers', 'manage'],
  ['PATCH', '/containers/:id', 'manage'],
  ['DELETE', '/containers/:id', 'manage'],
  ['POST', '/boxes', 'manage'],
  ['GET', '/boxes/:id', 'auth'],
  ['PATCH', '/boxes/:id', 'manage'],
  ['DELETE', '/boxes/:id', 'manage'],
  ['POST', '/container-types', 'manage'],
  ['PATCH', '/container-types/:id', 'manage'],
  ['DELETE', '/container-types/:id', 'manage'],
  ['POST', '/box-templates', 'manage'],
  ['PATCH', '/box-templates/:id', 'manage'],
  ['DELETE', '/box-templates/:id', 'manage'],
  ['POST', '/sample-types', 'manage'],
  ['PATCH', '/sample-types/:id', 'manage'],
  ['DELETE', '/sample-types/:id', 'manage'],
  ['GET', '/tubes/search', 'auth'],
  ['GET', '/tubes/export.csv', 'manage'],
  ['POST', '/tubes/bulk', 'auth'],
  ['POST', '/tubes', 'auth'],
  ['PATCH', '/tubes/:id', 'owner'],
  ['POST', '/tubes/:id/move', 'owner'],
  ['DELETE', '/tubes/:id', 'owner'],
  ['POST', '/tubes/:id/checkout', 'owner'],
  ['POST', '/tubes/:id/checkin', 'owner'],
  ['POST', '/tubes/:id/thaw', 'owner'],
  ['POST', '/tubes/:id/discard', 'owner'],
  ['GET', '/users', 'manage'],
  ['POST', '/tubes/:id/transfer', 'manage'],
  ['GET', '/tubes/:id/history', 'auth'],
  ['GET', '/tubes/:id/volume', 'auth'],
  ['POST', '/tubes/:id/volume/initial', 'manage'],
  ['POST', '/tubes/:id/volume/use', 'manage'],
  ['POST', '/tubes/:id/volume/adjust', 'manage'],
  ['POST', '/tubes/:id/volume/finish', 'manage'],
  ['GET', '/volume/low', 'manage'],
  ['GET', '/me', 'auth'],
  ['GET', '/roles', 'manage'],
  ['POST', '/roles', 'admin'],
  ['DELETE', '/roles/:id', 'admin'],
  ['GET', '/requests/:id/print', 'auth'],
  ['GET', '/banks', 'auth'],
  ['GET', '/units', 'manage'],
  ['POST', '/units', 'admin'],
  ['PATCH', '/units/:id', 'admin'],
  ['DELETE', '/units/:id', 'admin'],
  ['GET', '/users/search', 'auth'],
  ['GET', '/groups', 'auth'],
  ['POST', '/groups/propose', 'auth'],
  ['POST', '/groups', 'manage'],
  ['PATCH', '/groups/:id', 'manage'],
  ['POST', '/groups/:id/confirm-leader', 'auth'],
  ['POST', '/groups/:id/decline-leader', 'auth'],
  ['POST', '/groups/:id/merge', 'manage'],
  ['GET', '/profiles', 'manage'],
  ['PUT', '/profiles/:userId', 'manage'],
  ['POST', '/tubes/:id/requests', 'auth'],
  ['GET', '/requests', 'auth'],
  ['POST', '/requests/:id/approve', 'auth'],
  ['POST', '/requests/:id/reject', 'auth'],
  ['POST', '/requests/:id/cancel', 'auth'],
  ['POST', '/requests/:id/deliver', 'manage'],
  ['POST', '/requests/:id/return', 'manage'],
  ['POST', '/findings', 'manage'],
  ['GET', '/findings', 'auth'],
  ['GET', '/findings/:id', 'auth'],
  ['POST', '/findings/:id/remind', 'manage'],
  ['POST', '/findings/:id/claim', 'auth'],
  ['POST', '/findings/:id/discard', 'manage'],
  ['POST', '/findings/:id/cancel', 'manage'],
  ['POST', '/tubes/:id/report-missing', 'auth'],
  ['GET', '/incidents', 'auth'],
  ['POST', '/incidents/:id/taken', 'auth'],
  ['POST', '/incidents/:id/confirm', 'auth'],
  ['POST', '/incidents/:id/reject', 'auth'],
  ['POST', '/incidents/:id/self-taken', 'auth'],
  ['POST', '/incidents/:id/found', 'auth'],
  ['POST', '/incidents/:id/lost', 'manage'],
  ['POST', '/incidents/:id/cancel', 'auth'],
  ['GET', '/violations', 'manage'],
  ['POST', '/boxes/:id/audit', 'manage'],
  ['GET', '/settings', 'auth'],
  ['PUT', '/settings', 'manage'],
  ['GET', '/students', 'manage'],
  ['POST', '/students/import', 'manage'],
  ['POST', '/students/import-file', 'manage'],
  ['GET', '/students/template.xlsx', 'manage'],
  ['POST', '/students/bulk', 'manage'],
  ['PATCH', '/students/:id', 'manage'],
  ['DELETE', '/students/:id', 'manage'],
];
const cuThe = (p) => p.replace(/:[A-Za-z_]+/g, '99999');

let srv;
let admin;
let nguoiThuong;
let khach;
let ids = {};

test.before(async () => {
  srv = await startTestServer({ port: Number(process.env.TEST_PORT_NGAN_HANG || 3202), env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = srv.tokens.admin;
  nguoiThuong = addUser(srv, { fullname: 'Nghiên cứu viên NH', role: 'researcher' });
  khach = addUser(srv, { fullname: 'Khách CRD NH', role: 'crd_user' });
});
test.after(async () => {
  if (srv) await srv.stop();
});

async function api(method, url, token, body) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const r = await call(srv.baseUrl, P + url, { token, method, body: hasBody ? body : undefined });
  let json = null;
  try {
    json = await r.json();
  } catch (_) {}
  return { s: r.status, body: json };
}

test('bảng phân quyền khớp danh sách route thật trong server (không thêm/mất route nào)', () => {
  const inv = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'route-inventory.js')], { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const live = inv
    .split(/\r?\n/)
    .map((l) => l.match(/^\d{4}\s+(\S+)\s+(\S+)/))
    .filter((m) => m && m[2].startsWith(P + '/'))
    .map((m) => `${m[1]} ${m[2].slice(P.length)}`)
    .sort();
  const table = ROUTES.map(([m, p]) => `${m} ${p}`).sort();
  assert.deepEqual(table, live, 'bảng ROUTES phải khớp đúng các route đã đăng ký — sửa bảng này CÓ CHỦ ĐÍCH khi thêm/bớt route');
});

test('chưa đăng nhập: mọi route trả 401', async () => {
  for (const [m, p] of ROUTES) {
    const r = await api(m, cuThe(p), null, {});
    assert.equal(r.s, 401, `${m} ${p}`);
  }
});

test('tài khoản crd_user bị chặn khỏi mọi route của module (403)', async () => {
  for (const [m, p] of ROUTES) {
    const r = await api(m, cuThe(p), khach.token, {});
    assert.equal(r.s, 403, `${m} ${p}`);
  }
});

test('route quản lý: nghiên cứu viên bị 403, kể cả khi mẫu / vị trí không tồn tại (quyền kiểm TRƯỚC)', async () => {
  for (const [m, p, guard] of ROUTES) {
    if (guard !== 'manage') continue;
    const r = await api(m, cuThe(p), nguoiThuong.token, {});
    assert.equal(r.s, 403, `${m} ${p}`);
    assert.match(r.body.message, /Chỉ Admin hoặc Quản lý module/);
  }
});

test('route chỉ admin: nghiên cứu viên 403; Admin qua được', async () => {
  for (const [m, p, guard] of ROUTES) {
    if (guard !== 'admin') continue;
    const r = await api(m, cuThe(p), nguoiThuong.token, {});
    assert.equal(r.s, 403, `${m} ${p}`);
    assert.match(r.body.message, /Chỉ Admin mới có quyền/);
    const a = await api(m, cuThe(p), admin, {});
    assert.ok(a.s !== 401 && a.s !== 403, `${m} ${p} → ${a.s}`);
  }
});

test('route quản lý: Admin qua được cổng phân quyền (không 401 / 403)', async () => {
  for (const [m, p, guard] of ROUTES) {
    if (guard !== 'manage') continue;
    const r = await api(m, cuThe(p), admin, {});
    assert.ok(r.s !== 401 && r.s !== 403, `${m} ${p} → ${r.s}`);
  }
});

test('route chủ sở hữu: người lạ bị 403 trên mẫu của người khác; chủ và Admin thì được', async () => {
  const meta = (await api('GET', '/meta', admin)).body;
  const c = await api('POST', '/containers', admin, { name: 'Tủ phân quyền', type_id: meta.containerTypes[0].id });
  const b = await api('POST', '/boxes', admin, { container_id: c.body.id, template_id: meta.boxTemplates[0].id });
  ids.box = b.body.ids[0];
  const t = await api('POST', '/tubes', nguoiThuong.token, { box_id: ids.box, row_no: 1, col_no: 1, name: 'Mẫu của NCV', chu_loai: 'can_bo' });
  assert.equal(t.s, 201);
  ids.tube = t.body.id;
  const nguoiLa = addUser(srv, { fullname: 'Người lạ NH', role: 'researcher' });
  const thaoTac = [
    ['PATCH', `/tubes/${ids.tube}`, { name: 'x' }],
    ['POST', `/tubes/${ids.tube}/move`, { box_id: ids.box, row_no: 2, col_no: 2 }],
    ['POST', `/tubes/${ids.tube}/checkout`, {}],
    ['POST', `/tubes/${ids.tube}/thaw`, {}],
    ['POST', `/tubes/${ids.tube}/discard`, {}],
    ['DELETE', `/tubes/${ids.tube}`, undefined],
  ];
  for (const [m, p, body] of thaoTac) assert.equal((await api(m, p, nguoiLa.token, body)).s, 403, `${m} ${p}`);
  assert.equal((await api('PATCH', `/tubes/${ids.tube}`, nguoiThuong.token, { name: 'Mẫu của NCV 2' })).s, 200);
  assert.equal((await api('POST', `/tubes/${ids.tube}/checkout`, admin, { note: 'Quản lý thao tác hộ' })).s, 200); // quản lý thao tác hộ
});

test('thẻ trang chủ: /api/homepage-stats có số liệu module; địa chỉ cũ chuyển hướng về trang mới', async () => {
  const r = await call(srv.baseUrl, '/api/homepage-stats', { token: admin });
  const j = await r.json();
  assert.deepEqual(Object.keys(j.sampleStorageMini).sort(), ['boxes', 'containers', 'samples']);
  assert.ok(j.sampleStorageMini.containers >= 1 && j.sampleStorageMini.samples >= 1);
  for (const duong of ['/ngan-hang-te-bao-khang-the', '/ngan-hang-mau', '/kho-mau-sinh-pham.html']) {
    const res = await fetch(srv.baseUrl + duong, { redirect: 'manual' });
    assert.equal(res.status, 302, duong);
    assert.equal(res.headers.get('location'), '/public/ngan-hang-te-bao-khang-the/index.html');
  }
  const trang = await fetch(srv.baseUrl + '/public/ngan-hang-te-bao-khang-the/index.html');
  assert.equal(trang.status, 200);
});
