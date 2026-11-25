'use strict';

/**
 * Lưới test cho miền Đề tài cấp Viện (/api/cap-vien/*) — 49 route trong server.js.
 *
 * Mục tiêu:
 *   1. Đối chiếu bảng phân quyền & danh sách route THẬT trên server (không thêm/mất route).
 *   2. Ghim hành vi xác thực (công khai vs cần đăng nhập vs adminOnly).
 *   3. Ghim luồng nghiệp vụ chính: nộp hồ sơ + sinh mã DTSCI, danh sách, chi tiết,
 *      mẫu công khai, Bước 2 (hợp lệ/yêu cầu bổ sung/nộp lại/bổ sung/revert), Bước 3 (phân công),
 *      Bước 4 (phản biện upload/hoàn thành/xóa), Bước 4A (dự toán), tải file & xóa hồ sơ.
 *
 * Chạy trên server hộp cát riêng (cổng TEST_PORT_CAP_VIEN, mặc định 3232): DB là bản sao,
 * uploads nằm trong thư mục tạm, SMTP rỗng nên không gửi email nào.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT_CAP_VIEN || 3232);
const TAG = Date.now().toString(36);

let srv;
let admin;
let owner;
let other;
let chuTich;
let thuKy;
let tv1;
let tv2;
let phongKhcn;

test.before(async () => {
  srv = await startTestServer({ port: PORT, env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = { token: srv.tokens.admin, id: srv.tokens.users.admin.id };
  const mk = (name, role) => addUser(srv, { fullname: `${name} ${TAG}`, role });
  owner = mk('NCV cấp Viện', 'researcher');
  other = mk('NCV khác', 'researcher');
  chuTich = mk('Chủ tịch HĐKHCN', 'chu_tich');
  thuKy = mk('Thư ký HĐKHCN', 'thu_ky');
  tv1 = mk('Thành viên 1', 'thanh_vien');
  tv2 = mk('Thành viên 2', 'thanh_vien');
  phongKhcn = mk('Phòng KHCN', 'phong_khcn');
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

async function send(method, url, token, { fields = {}, files = [] } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const fl of files) fd.append(fl.field, new Blob([fl.content || '%PDF-1.4 thử nghiệm'], { type: 'application/pdf' }), fl.name);
  const r = await fetch(srv.baseUrl + url, {
    method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd, signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try { json = await r.clone().json(); } catch (_) { /* không phải JSON */ }
  return { s: r.status, body: json, res: r };
}

function expectRes(r, status, label, msgPart) {
  assert.equal(r.s, status, `${label} → mong ${status}, thật ${r.s}: ${JSON.stringify(r.body)}`);
  if (msgPart) {
    const m = String((r.body && r.body.message) || '');
    assert.ok(m.includes(msgPart), `${label} → câu thông báo phải chứa "${msgPart}", thật: "${m}"`);
  }
}

const f = (field, name, content) => ({ field, name, content });
const threeFiles = () => [f('sci_ace_01', 'tm.pdf'), f('sci_ace_02', 'kh.pdf'), f('sci_ace_03', 'bs.docx')];

const createSubmission = async (who = owner, title = `[test] đề tài cấp Viện ${TAG}`, extraFields = {}) => {
  const r = await send('POST', '/api/cap-vien/submissions', who.token, {
    fields: { title, ...extraFields },
    files: threeFiles(),
  });
  expectRes(r, 201, 'tạo hồ sơ cấp Viện');
  return r.body.id;
};

// Toàn bộ 49 route /api/cap-vien/* đăng ký trên server: [method, path, access ('public'|'auth'|'admin')]
const ROUTE_TABLE = [
  ['POST',   '/api/cap-vien/submissions', 'auth'],
  ['GET',    '/api/cap-vien/submission-options', 'public'],
  ['GET',    '/api/cap-vien/linh-vuc', 'public'],
  ['GET',    '/api/cap-vien/loai-de-tai', 'public'],
  ['GET',    '/api/cap-vien/don-vi', 'public'],
  ['GET',    '/api/cap-vien/khoan-muc-chi', 'public'],
  ['GET',    '/api/cap-vien/public-templates', 'public'],
  ['GET',    '/api/cap-vien/public-templates/:taskCode/file', 'public'],
  ['POST',   '/api/cap-vien/public-templates/:taskCode', 'admin'],
  ['DELETE', '/api/cap-vien/public-templates/:taskCode', 'admin'],
  ['GET',    '/api/cap-vien/submissions', 'auth'],
  ['GET',    '/api/cap-vien/submissions/:id', 'auth'],
  ['PUT',    '/api/cap-vien/submissions/:id/steps/6/decision-meta', 'auth'],
  ['PUT',    '/api/cap-vien/submissions/:id/steps/7/contract-meta', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/6/upload-decision', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/7/upload-contract', 'auth'],
  ['PUT',    '/api/cap-vien/submissions/:id/steps/8/ethics-meta', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/8/upload-ethics-decision', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/periodic-report/period/:periodId/upload', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/periodic-report/admin', 'auth'],
  ['PUT',    '/api/cap-vien/submissions/:id/steps/:step/deadline', 'auth'],
  ['PUT',    '/api/cap-vien/submissions/:id/steps/5/hd-meeting', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/5/upload-minutes', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/5/upload-step5-extras', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/5/council-request-revision', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/5/council-revision-upload', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/5/council-revision-chair', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/5/council-pass', 'auth'],
  ['GET',    '/api/cap-vien/council', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/:step', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/step9-supply/action', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/step11-adjustment/action', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/4/reviewer-upload', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/4/reviewer-complete', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/4/reviewer-delete', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/4a/upload', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/4a/request-revision', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/4a/upload-revised', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/steps/4a/approve', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/send-step4-email', 'admin'],
  ['POST',   '/api/cap-vien/submissions/:id/send-step4a-email', 'admin'],
  ['POST',   '/api/cap-vien/submissions/:id/revert-to-step-2', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/revert-to-step/:step', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/dev-reset-step/:step', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/resubmit', 'auth'],
  ['POST',   '/api/cap-vien/submissions/:id/supplement', 'auth'],
  ['GET',    '/api/cap-vien/submissions/:id/download', 'auth'],
  ['GET',    '/api/cap-vien/submissions/:id/files/:fileId/download', 'auth'],
  ['DELETE', '/api/cap-vien/submissions/:id', 'admin'],
];

test('bảng route khớp danh sách route /api/cap-vien THẬT trong server (không thêm/mất route nào)', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'route-inventory.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  const real = out
    .split(/\r?\n/)
    .map((l) => l.match(/^\d+\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/))
    .filter(Boolean)
    .map((m) => `${m[1]} ${m[2]}`)
    .filter((r) => r.includes(' /api/cap-vien'));
  const expected = ROUTE_TABLE.map(([m, p]) => `${m} ${p}`);
  assert.deepEqual(real, expected);
});

test('xác thực: route công khai mở, route bảo vệ trả 401 khi thiếu token', async () => {
  for (const [method, p, access] of ROUTE_TABLE) {
    const concrete = p
      .replace(':id', '999999')
      .replace(':step', '2')
      .replace(':periodId', '1')
      .replace(':fileId', '1')
      .replace(':taskCode', 'khong-hop-le');
    const r = await api(method, concrete, null, {});
    if (access === 'public') {
      assert.notEqual(r.s, 401, `${method} ${p} là công khai nhưng lại trả 401`);
    } else {
      assert.equal(r.s, 401, `${method} ${p} thiếu token phải trả 401, thật: ${r.s}`);
    }
  }
});

test('adminOnly: các route chỉ Admin trả 403 với nghiên cứu viên, Thư ký, Chủ tịch', async () => {
  const adminRoutes = ROUTE_TABLE.filter(([, , a]) => a === 'admin');
  for (const [method, p] of adminRoutes) {
    const concrete = p.replace(':id', '999999').replace(':taskCode', 'khong-hop-le');
    for (const u of [owner, thuKy, chuTich]) {
      const r = await api(method, concrete, u.token, {});
      assert.equal(r.s, 403, `${method} ${p} phải trả 403 cho role ${u.role}, thật: ${r.s}`);
    }
  }
});

test('danh mục công khai: submission-options, linh-vuc, loai-de-tai, don-vi, khoan-muc-chi trả 200', async () => {
  const opt = await api('GET', '/api/cap-vien/submission-options', null);
  expectRes(opt, 200, 'submission-options');
  assert.ok(Array.isArray(opt.body.options));
  for (const ep of ['/api/cap-vien/linh-vuc', '/api/cap-vien/loai-de-tai', '/api/cap-vien/don-vi', '/api/cap-vien/khoan-muc-chi']) {
    const r = await api('GET', ep, null);
    expectRes(r, 200, ep);
    assert.ok(Array.isArray(r.body.items));
  }
});

test('mẫu hồ sơ công khai: danh sách, upload (Admin), tải file, xóa (Admin)', async () => {
  const list = await api('GET', '/api/cap-vien/public-templates', null);
  expectRes(list, 200, 'public-templates list');
  assert.ok(Array.isArray(list.body.tasks) && list.body.tasks.length > 0);
  const taskCode = list.body.tasks[0].taskCode;

  // Mã mẫu sai → 400/404
  expectRes(await api('GET', '/api/cap-vien/public-templates/MA_SAI/file', null), 404, 'mẫu sai mã');
  expectRes(await send('POST', '/api/cap-vien/public-templates/MA_SAI', admin.token, { files: [f('file', 'a.pdf')] }), 400, 'upload sai mã');

  // Upload bởi Admin → tải về được → xóa bởi Admin
  const up = await send('POST', `/api/cap-vien/public-templates/${taskCode}`, admin.token, {
    files: [f('file', 'mau-thu.pdf', '%PDF-1.4 noi dung mau')],
  });
  expectRes(up, 200, 'upload mẫu công khai');
  assert.equal(up.body.ok, true);

  const dl = await api('GET', `/api/cap-vien/public-templates/${taskCode}/file`, null);
  assert.equal(dl.s, 200, 'tải mẫu công khai phải 200');

  const del = await api('DELETE', `/api/cap-vien/public-templates/${taskCode}`, admin.token);
  expectRes(del, 200, 'xóa mẫu công khai');
  assert.equal(del.body.ok, true);
});

test('nộp hồ sơ: thiếu tên 400; thiếu 3 file 400; đủ 3 file → 201 + sinh mã DTSCI', async () => {
  expectRes(await send('POST', '/api/cap-vien/submissions', owner.token, { fields: { title: '' }, files: threeFiles() }), 400, 'thiếu tên');
  expectRes(await send('POST', '/api/cap-vien/submissions', owner.token, { fields: { title: 'Test' }, files: [f('sci_ace_01', 'a.pdf')] }), 400, 'thiếu file');

  const id = await createSubmission(owner, `[test] Đề tài ${TAG}`);
  const d = await api('GET', `/api/cap-vien/submissions/${id}`, owner.token);
  expectRes(d, 200, 'chi tiết sau nộp');
  assert.equal(d.body.status, 'SUBMITTED');
  assert.match(d.body.code, /^DTSCI-/);
  assert.equal(d.body.files.length, 3);
});

test('danh sách & chi tiết: NCV chỉ thấy của mình; Hội đồng/Admin/Phòng KHCN thấy tất cả; người ngoài 403', async () => {
  const id = await createSubmission(owner, `[test] Quyền xem ${TAG}`);
  const listOwner = await api('GET', '/api/cap-vien/submissions', owner.token);
  const listOther = await api('GET', '/api/cap-vien/submissions', other.token);
  const listKhcn = await api('GET', '/api/cap-vien/submissions', phongKhcn.token);
  expectRes(listOwner, 200, 'list owner');
  expectRes(listOther, 200, 'list other');
  expectRes(listKhcn, 200, 'list phongKhcn');
  assert.ok(listOwner.body.some((x) => x.id === id));
  assert.ok(!listOther.body.some((x) => x.id === id));
  assert.ok(listKhcn.body.some((x) => x.id === id));

  expectRes(await api('GET', `/api/cap-vien/submissions/${id}`, other.token), 403, 'NCV khác xem chi tiết');
  expectRes(await api('GET', `/api/cap-vien/submissions/${id}`, phongKhcn.token), 200, 'Phòng KHCN xem chi tiết');
  expectRes(await api('GET', '/api/cap-vien/submissions/abc', admin.token), 400, 'id không hợp lệ');
  expectRes(await api('GET', '/api/cap-vien/submissions/999999', admin.token), 404, 'id không tồn tại');

  // Danh sách Hội đồng KHCN
  expectRes(await api('GET', '/api/cap-vien/council', owner.token), 403, 'NCV xem council');
  const cRes = await api('GET', '/api/cap-vien/council', chuTich.token);
  expectRes(cRes, 200, 'Chủ tịch xem council');
  assert.ok(Array.isArray(cRes.body.council) && cRes.body.council.length > 0);
});

test('luồng Bước 2 → Bước 3 → Bước 4 & 4A → tải file → xóa hồ sơ', async () => {
  const id = await createSubmission(owner, `[test] Luồng đầy đủ ${TAG}`);

  // Bước 2: NCV không được duyệt; Thư ký yêu cầu bổ sung (thiếu note 400, có note 200)
  expectRes(await api('POST', `/api/cap-vien/submissions/${id}/steps/2`, owner.token, { action: 'approve' }), 403, 'NCV duyệt B2');
  expectRes(await api('POST', `/api/cap-vien/submissions/${id}/steps/2`, thuKy.token, { action: 'request_revision', payload: { note: '' } }), 400, 'thiếu note');
  const rev = await api('POST', `/api/cap-vien/submissions/${id}/steps/2`, thuKy.token, { action: 'request_revision', payload: { note: 'Cần bổ sung phụ lục' } });
  expectRes(rev, 200, 'Thư ký yêu cầu bổ sung');
  assert.equal(rev.body.status, 'NEED_REVISION');

  // NCV nộp bổ sung (supplement) → quay lại SUBMITTED
  const sup = await send('POST', `/api/cap-vien/submissions/${id}/supplement`, owner.token, {
    files: [f('supplement', 'bo-sung.pdf')],
  });
  expectRes(sup, 200, 'NCV nộp bổ sung');
  assert.equal(sup.body.status, 'SUBMITTED');

  // Thư ký duyệt Hợp lệ → VALIDATED
  const val = await api('POST', `/api/cap-vien/submissions/${id}/steps/2`, thuKy.token, { action: 'approve', payload: { note: 'Đủ hồ sơ' } });
  expectRes(val, 200, 'Thư ký duyệt B2');
  assert.equal(val.body.status, 'VALIDATED');

  // Bước 3: Chủ tịch phân công 2 phản biện → ASSIGNED
  const assign = await api('POST', `/api/cap-vien/submissions/${id}/steps/3`, chuTich.token, {
    action: 'assign',
    payload: { reviewerIds: [tv1.id, tv2.id] },
  });
  expectRes(assign, 200, 'Chủ tịch phân công B3');
  assert.equal(assign.body.status, 'ASSIGNED');

  // Bước 4: Phản biện 1 & 2 upload + hoàn thành
  expectRes(await send('POST', `/api/cap-vien/submissions/${id}/steps/4/reviewer-upload`, tv1.token, { fields: { slot: 1 }, files: [f('phieu_danh_gia', 'pb1.pdf')] }), 200, 'PB1 upload');
  expectRes(await api('POST', `/api/cap-vien/submissions/${id}/steps/4/reviewer-complete`, tv1.token, { slot: 1 }), 200, 'PB1 complete');
  expectRes(await send('POST', `/api/cap-vien/submissions/${id}/steps/4/reviewer-upload`, tv2.token, { fields: { slot: 2 }, files: [f('phieu_danh_gia', 'pb2.pdf')] }), 200, 'PB2 upload');
  expectRes(await api('POST', `/api/cap-vien/submissions/${id}/steps/4/reviewer-complete`, tv2.token, { slot: 2 }), 200, 'PB2 complete');

  // Tải file & tải zip hồ sơ
  const dlAll = await api('GET', `/api/cap-vien/submissions/${id}/download`, owner.token);
  assert.equal(dlAll.s, 200, 'tải toàn bộ hồ sơ phải 200');
  expectRes(await api('GET', `/api/cap-vien/submissions/${id}/download`, other.token), 403, 'người khác tải hồ sơ');

  // Xóa hồ sơ (Admin) → sau đó chi tiết trả 404
  expectRes(await api('DELETE', `/api/cap-vien/submissions/${id}`, admin.token), 200, 'Admin xóa hồ sơ');
  expectRes(await api('GET', `/api/cap-vien/submissions/${id}`, admin.token), 404, 'chi tiết sau xóa');
});
