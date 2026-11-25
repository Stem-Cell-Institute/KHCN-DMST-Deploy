/**
 * tests/core.test.js
 * Lưới an toàn cho các route lõi (Đợt 7): auth, homepage, templates, dev/users, admin-ui-status.
 * Chạy trên server.js gốc trước khi tách sang routes/core/*.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

let srv;
let researcher;

test.before(async () => {
  srv = await startTestServer();
  researcher = addUser(srv, { fullname: 'NCV CoreTest', role: 'researcher' });
});

test.after(async () => {
  if (srv) await srv.stop();
});

const get = (p, token) => call(srv.baseUrl, p, { token });
const post = (p, token, body) => call(srv.baseUrl, p, { token, method: 'POST', body });

test('core public: health, server-time, homepage-stats, homepage-modules, standard-label, ace-templates', async () => {
  for (const [path, check] of [
    ['/api/health', (j) => j.ok === true],
    ['/api/server-time', (j) => /Ho_Chi_Minh/.test(j.timezone || '')],
    ['/api/homepage-stats', (j) => typeof j === 'object' && j !== null],
    ['/api/homepage-modules', (j) => Array.isArray(j.modules)],
    ['/api/settings/standard-label', (j) => typeof j.label === 'string'],
    ['/api/ace-templates', (j) => Array.isArray(j.templates)],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, `${path} phải trả 200`);
    const j = await res.json();
    assert.ok(check(j), `${path} trả schema hợp lệ`);
  }
});

test('core auth gate: /api/me, /api/activity/track, /api/ace-templates/can-manage, /api/users/search, /api/dev/pub-analytics-access, /api/admin-ui-status', async () => {
  for (const [method, path, body] of [
    ['GET', '/api/me'],
    ['POST', '/api/activity/track', { action: 'ping' }],
    ['GET', '/api/ace-templates/can-manage'],
    ['GET', '/api/users/search?q=test'],
    ['GET', '/api/dev/pub-analytics-access'],
    ['PUT', '/api/dev/pub-analytics-access', { mode: 'public' }],
  ]) {
    const res = await call(srv.baseUrl, path, { method, body });
    assert.equal(res.status, 401, `${method} ${path} chưa đăng nhập phải trả 401`);
  }

  // NCV không được vào route admin/master-admin
  for (const path of ['/api/users/search?q=a', '/api/dev/pub-analytics-access']) {
    const res = await get(path, researcher.token);
    assert.equal(res.status, 403, `${path} với NCV phải trả 403`);
  }

  // Admin gọi được /api/me, /api/activity/track, /api/users/search, /api/dev/pub-analytics-access, /api/admin-ui-status
  const meRes = await get('/api/me', srv.tokens.admin);
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.ok(me.email);

  const trackRes = await post('/api/activity/track', srv.tokens.admin, { action: 'page_view', path: '/' });
  assert.equal(trackRes.status, 200);

  const searchRes = await get('/api/users/search?q=a', srv.tokens.admin);
  assert.equal(searchRes.status, 200);

  const pubAccessRes = await get('/api/dev/pub-analytics-access', srv.tokens.admin);
  assert.equal(pubAccessRes.status, 200);

  const uiStatusRes = await get('/api/admin-ui-status', srv.tokens.admin);
  assert.equal(uiStatusRes.status, 200);
});

test('core auth flow: login sai mật khẩu → 401, forgot-password thiếu email → 400, logout → 200', async () => {
  const badLogin = await post('/api/login', null, { email: 'khongtontai@sci.edu.vn', password: '123' });
  assert.equal(badLogin.status, 401);

  const badForgot = await post('/api/forgot-password', null, {});
  assert.equal(badForgot.status, 400);

  const badReset = await post('/api/reset-password', null, {});
  assert.equal(badReset.status, 400);

  const logoutRes = await post('/api/logout', null, {});
  assert.equal(logoutRes.status, 200);
});
