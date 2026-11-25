'use strict';

/**
 * Lưới test cho Đợt 6: các route quản trị (/api/admin/* & /api/admin-ui-status).
 *
 * Mục tiêu:
 *   1. Đối chiếu danh sách 105 route /api/admin* THẬT trên server (không thêm/mất/đổi thứ tự).
 *   2. Ghim cổng xác thực: chưa đăng nhập → 401; NCV / P.KHCN → 403 trên adminOnly.
 *   3. Ghim luồng CRUD/quản trị chính: cap-vien options/danh mục/cài đặt, users & phân quyền,
 *      homepage-modules, standard-label, notification-recipients, cooperation settings & admin CRUD.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT_ADMIN || 3234);
const TAG = Date.now().toString(36);

let srv;
let admin;
let researcher;
let phongKhcn;

test.before(async () => {
  srv = await startTestServer({ port: PORT, env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = { token: srv.tokens.admin, id: srv.tokens.users.admin.id };
  const mk = (name, role) => addUser(srv, { fullname: `${name} ${TAG}`, role });
  researcher = mk('NCV AdminTest', 'researcher');
  phongKhcn = mk('PKHCN AdminTest', 'phong_khcn');
});

test.after(async () => {
  if (srv) await srv.stop();
});

async function api(method, url, token, body) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const r = await call(srv.baseUrl, url, { token, method, body: hasBody ? body : undefined });
  let json = null;
  try { json = await r.clone().json(); } catch (_) { /* không phải JSON */ }
  return { s: r.status, body: json, res: r };
}

function expectRes(r, status, label) {
  assert.equal(r.s, status, `${label} → mong ${status}, thật ${r.s}: ${JSON.stringify(r.body)}`);
}

const EXPECTED_ADMIN_ROUTES = [
  'GET /api/admin/homepage-sidebar-rss/sources',
  'POST /api/admin/homepage-sidebar-rss/sources',
  'DELETE /api/admin/homepage-sidebar-rss/sources/:id',
  'PUT /api/admin/homepage-sidebar-rss/settings',
  'GET /api/admin/cap-vien/submission-options',
  'POST /api/admin/cap-vien/submission-options',
  'PUT /api/admin/cap-vien/submission-options/:id',
  'DELETE /api/admin/cap-vien/submission-options/:id',
  'GET /api/admin/cap-vien/linh_vuc',
  'POST /api/admin/cap-vien/linh_vuc',
  'PUT /api/admin/cap-vien/linh_vuc/:id',
  'DELETE /api/admin/cap-vien/linh_vuc/:id',
  'GET /api/admin/cap-vien/loai_de_tai',
  'POST /api/admin/cap-vien/loai_de_tai',
  'PUT /api/admin/cap-vien/loai_de_tai/:id',
  'DELETE /api/admin/cap-vien/loai_de_tai/:id',
  'GET /api/admin/cap-vien/don_vi',
  'POST /api/admin/cap-vien/don_vi',
  'PUT /api/admin/cap-vien/don_vi/:id',
  'DELETE /api/admin/cap-vien/don_vi/:id',
  'GET /api/admin/cap-vien/khoan_muc_chi',
  'POST /api/admin/cap-vien/khoan_muc_chi',
  'PUT /api/admin/cap-vien/khoan_muc_chi/:id',
  'DELETE /api/admin/cap-vien/khoan_muc_chi/:id',
  'POST /api/admin/missions/sync-from-cap-vien',
  'GET /api/admin/cap-vien/submissions',
  'GET /api/admin/cap-vien/settings/step7-complete-email',
  'PUT /api/admin/cap-vien/settings/step7-complete-email',
  'GET /api/admin/cap-vien/settings/chairman-email-controls',
  'PUT /api/admin/cap-vien/settings/chairman-email-controls',
  'GET /api/admin/cap-vien/settings/council-member-email-controls',
  'PUT /api/admin/cap-vien/settings/council-member-email-controls',
  'PUT /api/admin/cap-vien/submissions/:id/code',
  'GET /api/admin/users',
  'GET /api/admin/activity-log',
  'POST /api/admin/users',
  'POST /api/admin/reset-user-password',
  'POST /api/admin/users/send-role-email',
  'GET /api/admin/notification-recipients',
  'PUT /api/admin/missions/:id',
  'DELETE /api/admin/missions/:id',
  'POST /api/admin/missions-templates',
  'POST /api/admin/ace-templates',
  'DELETE /api/admin/ace-templates/:type',
  'POST /api/admin/missions/import',
  'POST /api/admin/missions/manual',
  'GET /api/admin/homepage-modules',
  'PUT /api/admin/homepage-modules/reorder',
  'PUT /api/admin/homepage-modules/:code',
  'GET /api/admin/settings/standard-label',
  'PUT /api/admin/settings/standard-label',
  'POST /api/admin/notification-recipients',
  'DELETE /api/admin/notification-recipients/:id',
  'GET /api/admin/cooperation/notification-recipients',
  'POST /api/admin/cooperation/notification-recipients',
  'DELETE /api/admin/cooperation/notification-recipients/:id',
  'PATCH /api/admin/cooperation/notification-recipients/:id',
  'GET /api/admin/cooperation/settings/thoa-thuan-expiry',
  'PUT /api/admin/cooperation/settings/thoa-thuan-expiry',
  'POST /api/admin/cooperation/thoa-thuan/run-expiry-check',
  'PUT /api/admin/cooperation/doan-ra/:id/status',
  'DELETE /api/admin/cooperation/thoa-thuan/:id',
  'PUT /api/admin/cooperation/thoa-thuan/:id',
  'PUT /api/admin/users/role',
  'GET /api/admin/council-role-grants',
  'PUT /api/admin/council-role-grants/:userId',
  'GET /api/admin/budget-appraisal-team',
  'PUT /api/admin/budget-appraisal-team',
  'DELETE /api/admin/budget-appraisal-team/:email',
  'PUT /api/admin/users/:email/password',
  'PUT /api/admin/users/:email/banned',
  'DELETE /api/admin/users/:email',
  'DELETE /api/admin/council-members/:email',
  'POST /api/admin/cooperation/doan-ra/:id/van-ban-word',
  'DELETE /api/admin/cooperation/doan-ra/:id/van-ban-word',
  'POST /api/admin/cooperation/doan-ra/to-trinh-template',
  'GET /api/admin/cooperation/doan-ra/to-trinh-template',
  'POST /api/admin/cooperation/doan-ra/:id/sinh-to-trinh-word',
  'POST /api/admin/cooperation/doan-vao/:id/van-ban-word',
  'DELETE /api/admin/cooperation/doan-vao/:id/van-ban-word',
  'POST /api/admin/cooperation/doan-vao/to-trinh-template',
  'GET /api/admin/cooperation/doan-vao/to-trinh-template',
  'POST /api/admin/cooperation/doan-vao/:id/sinh-to-trinh-word',
  'POST /api/admin/cooperation/mou/:id/van-ban-word',
  'DELETE /api/admin/cooperation/mou/:id/van-ban-word',
  'POST /api/admin/cooperation/mou/to-trinh-template',
  'GET /api/admin/cooperation/mou/to-trinh-template',
  'POST /api/admin/cooperation/mou/:id/sinh-to-trinh-word',
  'POST /api/admin/cooperation/ytnn/:id/van-ban-word',
  'DELETE /api/admin/cooperation/ytnn/:id/van-ban-word',
  'POST /api/admin/cooperation/ytnn/to-trinh-template',
  'GET /api/admin/cooperation/ytnn/to-trinh-template',
  'POST /api/admin/cooperation/ytnn/:id/sinh-to-trinh-word',
  'DELETE /api/admin/cooperation/su-kien/:id',
  'PUT /api/admin/cooperation/doan-ra/:id',
  'DELETE /api/admin/cooperation/doan-ra/:id',
  'PUT /api/admin/cooperation/doan-vao/:id',
  'DELETE /api/admin/cooperation/doan-vao/:id',
  'PUT /api/admin/cooperation/mou/:id',
  'DELETE /api/admin/cooperation/mou/:id',
  'PUT /api/admin/cooperation/ytnn/:id',
  'DELETE /api/admin/cooperation/ytnn/:id',
  'GET /api/admin-ui-status',
  'POST /api/admin/sjr-csv-import',
  'POST /api/admin/journal-metrics/update-if',
];

test('bảng route khớp 105 route /api/admin* THẬT trong server', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'route-inventory.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const actual = out
    .split(/\r?\n/)
    .map((l) => l.match(/^\d+\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/))
    .filter(Boolean)
    .map((m) => `${m[1]} ${m[2]}`)
    .filter((r) => / \/api\/admin(-ui-status|\/)/.test(r));
  assert.deepEqual(actual, EXPECTED_ADMIN_ROUTES);
});

test('cổng xác thực: chưa đăng nhập → 401, NCV / P.KHCN → 403 trên adminOnly', async () => {
  for (const [m, p] of [
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/activity-log'],
    ['GET', '/api/admin/cap-vien/submissions'],
    ['GET', '/api/admin/homepage-modules'],
    ['GET', '/api/admin/settings/standard-label'],
    ['GET', '/api/admin/cooperation/notification-recipients'],
    ['GET', '/api/admin/council-role-grants'],
    ['GET', '/api/admin/budget-appraisal-team'],
  ]) {
    expectRes(await api(m, p, null), 401, `ẩn danh ${m} ${p}`);
    expectRes(await api(m, p, researcher.token), 403, `NCV ${m} ${p}`);
    expectRes(await api(m, p, phongKhcn.token), 403, `P.KHCN ${m} ${p}`);
  }
  expectRes(await api('GET', '/api/admin-ui-status', null), 401, 'admin-ui-status thiếu token');
  expectRes(await api('GET', '/api/admin-ui-status', researcher.token), 200, 'admin-ui-status đã đăng nhập');
});

test('admin cap-vien: CRUD submission-options, danh mục & cài đặt email', async () => {
  const opt = await api('POST', '/api/admin/cap-vien/submission-options', admin.token, {
    code: `OPT_${TAG}`,
    label: `Nhãn ${TAG}`,
    affects_code: true,
  });
  expectRes(opt, 201, 'tạo submission-option');
  const optId = opt.body.option.id;
  expectRes(await api('GET', '/api/admin/cap-vien/submission-options', admin.token), 200, 'ds submission-options');
  expectRes(await api('PUT', `/api/admin/cap-vien/submission-options/${optId}`, admin.token, { label: `Sửa ${TAG}` }), 200, 'sửa submission-option');
  expectRes(await api('DELETE', `/api/admin/cap-vien/submission-options/${optId}`, admin.token), 200, 'xóa submission-option');

  const lv = await api('POST', '/api/admin/cap-vien/linh_vuc', admin.token, { code: `LV_${TAG}`, label: `Lĩnh vực ${TAG}` });
  expectRes(lv, 200, 'tạo linh_vuc');
  const lvId = lv.body.item.id;
  expectRes(await api('GET', '/api/admin/cap-vien/linh_vuc', admin.token), 200, 'ds linh_vuc');
  expectRes(await api('PUT', `/api/admin/cap-vien/linh_vuc/${lvId}`, admin.token, { label: `LV Sửa ${TAG}` }), 200, 'sửa linh_vuc');
  expectRes(await api('DELETE', `/api/admin/cap-vien/linh_vuc/${lvId}`, admin.token), 200, 'xóa linh_vuc');

  expectRes(await api('GET', '/api/admin/cap-vien/submissions', admin.token), 200, 'admin ds cap-vien');
  expectRes(await api('GET', '/api/admin/cap-vien/settings/step7-complete-email', admin.token), 200, 'get step7 email');
  expectRes(await api('GET', '/api/admin/cap-vien/settings/chairman-email-controls', admin.token), 200, 'get chairman controls');
  expectRes(await api('GET', '/api/admin/cap-vien/settings/council-member-email-controls', admin.token), 200, 'get council controls');
});

test('admin users, council-role-grants, budget-appraisal-team & activity-log', async () => {
  expectRes(await api('GET', '/api/admin/users', admin.token), 200, 'ds users');
  expectRes(await api('GET', '/api/admin/activity-log', admin.token), 200, 'activity-log');
  expectRes(await api('GET', '/api/admin/council-role-grants', admin.token), 200, 'council-role-grants');
  expectRes(await api('GET', '/api/admin/budget-appraisal-team', admin.token), 200, 'budget-appraisal-team');

  const email = `admintest_${TAG}@sci.edu.vn`;
  const cr = await api('POST', '/api/admin/users', admin.token, {
    email,
    fullname: `User ${TAG}`,
    role: 'researcher',
  });
  assert.ok([200, 201].includes(cr.s), `tạo user → ${cr.s}: ${JSON.stringify(cr.body)}`);
  expectRes(await api('PUT', '/api/admin/users/role', admin.token, { email, role: 'thanh_vien' }), 200, 'đổi role user');
  expectRes(await api('PUT', `/api/admin/users/${encodeURIComponent(email)}/banned`, admin.token, { banned: true }), 200, 'khóa user');
  expectRes(await api('DELETE', `/api/admin/users/${encodeURIComponent(email)}`, admin.token), 200, 'xóa user');
});

test('admin homepage-modules, standard-label, notification-recipients & cooperation settings', async () => {
  expectRes(await api('GET', '/api/admin/homepage-modules', admin.token), 200, 'homepage-modules');
  expectRes(await api('GET', '/api/admin/settings/standard-label', admin.token), 200, 'standard-label');
  expectRes(await api('GET', '/api/admin/notification-recipients', admin.token), 200, 'notification-recipients');

  const nr = await api('POST', '/api/admin/cooperation/notification-recipients', admin.token, {
    email: `coop_${TAG}@sci.edu.vn`,
    role: 'phong_khcn',
    topic: 'doan_ra',
  });
  assert.ok([200, 201].includes(nr.s), `tạo coop recipient → ${nr.s}: ${JSON.stringify(nr.body)}`);
  const nrList = await api('GET', '/api/admin/cooperation/notification-recipients', admin.token);
  expectRes(nrList, 200, 'ds coop recipients');
  const created = (nrList.body.recipients || []).find((x) => x.email === `coop_${TAG}@sci.edu.vn`);
  assert.ok(created && created.id);
  expectRes(await api('PATCH', `/api/admin/cooperation/notification-recipients/${created.id}`, admin.token, { topics: 'all' }), 200, 'sửa coop recipient');
  expectRes(await api('DELETE', `/api/admin/cooperation/notification-recipients/${created.id}`, admin.token), 200, 'xóa coop recipient');

  expectRes(await api('GET', '/api/admin/cooperation/settings/thoa-thuan-expiry', admin.token), 200, 'get thoa-thuan-expiry');
  expectRes(await api('DELETE', '/api/admin/cooperation/su-kien/999999', admin.token), 200, 'xóa su-kien không tồn tại');
});
