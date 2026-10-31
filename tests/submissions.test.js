'use strict';

/**
 * Lưới test cho miền Nộp & theo dõi hồ sơ SCI-ACE — 21 route: 20 route /api/submissions* và
 * GET /api/users/council (đứng giữa nhóm, dùng cho form phân công phản biện).
 *
 * Hồ sơ đi qua máy trạng thái (khai báo trong server.js, không có bảng trạng thái nào khác):
 *   SUBMITTED ──review:pass──▶ VALIDATED ──assign-reviewers──▶ UNDER_REVIEW ──2 file phản biện──▶ IN_MEETING
 *       │  ▲                                                                           │
 *       │  └─resubmit── NEED_REVISION ◀─review:need_*                  meeting-result: ▼
 *       └──review:reject──▶ REJECTED     APPROVED ◀──────────────┬── approved / conditional / rejected
 *                                         ▲   CONDITIONAL ──conditional-submit + conditional-approve
 *                                         └──issue-decision──▶ IMPLEMENTATION ──report-final──▶ COMPLETED
 * Mỗi test dưới đây tự dựng hồ sơ riêng bằng chính các route (không ghi thẳng DB) rồi đẩy tới trạng thái cần thử.
 *
 * Các test GHIM HÀNH VI HIỆN TẠI, kể cả thứ tự kiểm tra (vai trò → tồn tại → trạng thái → chủ hồ sơ) và câu
 * thông báo lỗi, vì giao diện đang hiển thị nguyên văn. Chúng khẳng định "refactor không đổi hành vi",
 * không khẳng định hành vi hiện tại là đúng.
 *
 * Chạy trên server hộp cát riêng (cổng TEST_PORT_SUBMISSIONS, mặc định 3230): DB là bản sao, uploads nằm
 * trong thư mục tạm, SMTP rỗng nên không gửi email nào.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT_SUBMISSIONS || 3230);
const TAG = Date.now().toString(36);

let srv;
let admin;
let owner;      // nghiên cứu viên nộp hồ sơ
let other;      // nghiên cứu viên khác (không phải chủ hồ sơ)
let chuTich;
let thuKy;
let tv1;        // thành viên Hội đồng, thường làm phản biện 1
let tv2;        // thành viên Hội đồng, thường làm phản biện 2
let vienTruong; // đăng nhập được nhưng không thuộc Hội đồng

test.before(async () => {
  srv = await startTestServer({ port: PORT, env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = { token: srv.tokens.admin, id: srv.tokens.users.admin.id };
  const mk = (name, role) => addUser(srv, { fullname: `${name} ${TAG}`, role });
  owner = mk('NCV chủ hồ sơ', 'researcher');
  other = mk('NCV khác', 'researcher');
  chuTich = mk('Chủ tịch', 'chu_tich');
  thuKy = mk('Thư ký', 'thu_ky');
  tv1 = mk('Thành viên một', 'thanh_vien');
  tv2 = mk('Thành viên hai', 'thanh_vien');
  vienTruong = mk('Viện trưởng', 'vien_truong');
});

test.after(async () => {
  if (srv) await srv.stop();
});

/** JSON API: trả { s, body }. */
async function api(method, url, token, body) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const r = await call(srv.baseUrl, url, { token, method, body: hasBody ? body : undefined });
  let json = null;
  try { json = await r.clone().json(); } catch (_) { /* không phải JSON */ }
  return { s: r.status, body: json, res: r };
}

/** multipart: files = [{ field, name, content }], fields = { k: v }. */
async function send(method, url, token, { fields = {}, files = [] } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  for (const f of files) fd.append(f.field, new Blob([f.content || '%PDF-1.4 thử nghiệm'], { type: 'application/pdf' }), f.name);
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
const three = () => [f('sci_ace_01', 'a1.pdf'), f('sci_ace_02', 'a2.pdf'), f('sci_ace_03', 'a3.docx')];
const one = (name = 'x.pdf', field = 'file') => [f(field, name)];

const create = async (who = owner, title = `[test] hồ sơ ${TAG}`) => {
  const r = await send('POST', '/api/submissions', who.token, { fields: { title }, files: three() });
  expectRes(r, 201, 'tạo hồ sơ');
  return r.body.id;
};
const detail = async (id, token = admin.token) => {
  const r = await api('GET', `/api/submissions/${id}`, token);
  expectRes(r, 200, `chi tiết #${id}`);
  return r.body;
};
const toValidated = async (who = owner) => {
  const id = await create(who);
  expectRes(await api('PUT', `/api/submissions/${id}/review`, thuKy.token, { decision: 'pass' }), 200, 'kiểm tra: pass');
  return id;
};
const toUnderReview = async (reviewers = [tv1, tv2], who = owner) => {
  const id = await toValidated(who);
  expectRes(await api('PUT', `/api/submissions/${id}/assign-reviewers`, chuTich.token, { reviewerIds: reviewers.map((u) => u.id) }), 200, 'phân công');
  return id;
};
const toInMeeting = async () => {
  const id = await toUnderReview();
  expectRes(await send('POST', `/api/submissions/${id}/review-upload`, tv1.token, { files: one('pb1.pdf') }), 200, 'phản biện 1');
  const r = await send('POST', `/api/submissions/${id}/review-upload`, tv2.token, { files: one('pb2.pdf') });
  expectRes(r, 200, 'phản biện 2');
  assert.equal(r.body.status, 'IN_MEETING');
  return id;
};
const meeting = (id, decision, withFile = true) =>
  send('PUT', `/api/submissions/${id}/meeting-result`, thuKy.token, { fields: { decision, note: 'ghi chú họp' }, files: withFile ? one('bien-ban.pdf') : [] });
const toApproved = async () => {
  const id = await toInMeeting();
  expectRes(await meeting(id, 'approved'), 200, 'họp: chấp thuận');
  return id;
};
const toImplementation = async () => {
  const id = await toApproved();
  const r = await send('PUT', `/api/submissions/${id}/issue-decision`, thuKy.token, { files: [f('decision_vn', 'qd-vn.pdf'), f('decision_en', 'qd-en.docx')] });
  expectRes(r, 200, 'cấp quyết định');
  return id;
};

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. BẢNG ROUTE — 21 route
// ───────────────────────────────────────────────────────────────────────────────────────────────
const ROUTES = [
  ['POST', '/api/submissions', 'auth'],
  ['GET', '/api/submissions', 'auth'],
  ['GET', '/api/users/council', 'auth'],
  ['GET', '/api/submissions/:id', 'auth'],
  ['POST', '/api/submissions/:id/conditional-submit', 'auth'],
  ['PUT', '/api/submissions/:id/conditional-approve', 'auth'],
  ['PUT', '/api/submissions/:id/conditional-reject', 'auth'],
  ['PUT', '/api/submissions/:id/meeting-result', 'auth'],
  ['PUT', '/api/submissions/:id/issue-decision', 'auth'],
  ['POST', '/api/submissions/:id/report-periodic', 'auth'],
  ['POST', '/api/submissions/:id/report-final', 'auth'],
  ['GET', '/api/submissions/:id/file/:fieldName', 'auth'],
  ['PUT', '/api/submissions/:id/review', 'auth'],
  ['POST', '/api/submissions/:id/resubmit', 'auth'],
  ['PUT', '/api/submissions/:id/assign-reviewers', 'auth'],
  ['PUT', '/api/submissions/:id/reset-gd4', 'admin'],
  ['GET', '/api/submissions/:id/review-files', 'auth'],
  ['GET', '/api/submissions/:id/review-file/:slot', 'auth'],
  ['POST', '/api/submissions/:id/review-upload', 'auth'],
  ['GET', '/api/submissions/:id/download', 'auth'],
  ['DELETE', '/api/submissions/:id', 'admin'],
];
const concrete = (p) => p.replace(':id', '1').replace(':fieldName', 'sci_ace_01').replace(':slot', '1');

test('bảng route khớp danh sách route hồ sơ THẬT trong server (không thêm/mất route nào)', () => {
  const inv = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'route-inventory.js')], { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const live = inv.split(/\r?\n/)
    .map((l) => l.match(/^\d{4}\s+(\S+)\s+(\S+)/))
    .filter((m) => m && (m[2].startsWith('/api/submissions') || m[2] === '/api/users/council'))
    .map((m) => `${m[1]} ${m[2]}`)
    .sort();
  assert.equal(ROUTES.length, 21);
  assert.deepEqual(ROUTES.map(([m, p]) => `${m} ${p}`).sort(), live, 'sửa bảng ROUTES CÓ CHỦ ĐÍCH khi thêm/bớt route');
});

test('chưa đăng nhập: cả 21 route trả 401', async () => {
  for (const [m, p] of ROUTES) {
    expectRes(await api(m, concrete(p), null, {}), 401, `${m} ${p} không token`);
  }
});

test('adminOnly: reset-gd4 và xóa hồ sơ → 403 với mọi vai trò khác Admin (kể cả Chủ tịch, Thư ký)', async () => {
  for (const who of [owner, chuTich, thuKy, tv1, vienTruong]) {
    for (const [m, p] of ROUTES.filter((r) => r[2] === 'admin')) {
      expectRes(await api(m, concrete(p), who.token, {}), 403, `${m} ${p} ${who.email}`, 'Chỉ Admin');
    }
  }
});

test('route kiểm vai trò TRƯỚC khi tra hồ sơ: sai vai trò vẫn 403 dù id không tồn tại; đúng vai trò thì 404', async () => {
  const cases = [
    ['PUT', 'review', [thuKy], [owner, chuTich, tv1, vienTruong], 'Thư ký'],
    ['PUT', 'assign-reviewers', [chuTich], [owner, thuKy, tv1, vienTruong], 'Chủ tịch'],
    ['PUT', 'conditional-approve', [chuTich], [owner, thuKy, tv1], 'Chủ tịch'],
    ['PUT', 'conditional-reject', [chuTich], [owner, thuKy, tv1], 'Chủ tịch'],
    ['PUT', 'meeting-result', [thuKy], [owner, chuTich, tv1], 'Thư ký'],
    ['PUT', 'issue-decision', [thuKy], [owner, chuTich, tv1], 'Thư ký'],
  ];
  for (const [m, seg, ok, bad, who] of cases) {
    const url = `/api/submissions/987654/${seg}`;
    for (const u of bad) expectRes(await api(m, url, u.token, {}), 403, `${seg} ${u.email}`, who);
    for (const u of [...ok, admin]) expectRes(await api(m, url, u.token, {}), 404, `${seg} ${u.email || 'admin'} id lạ`, 'Không tìm thấy hồ sơ');
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. NỘP, DANH SÁCH, CHI TIẾT, TẢI FILE
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('nộp hồ sơ: thiếu tên 400; thiếu file 400; đủ 3 file (+ phụ lục) → 201, trạng thái SUBMITTED', async () => {
  expectRes(await send('POST', '/api/submissions', owner.token, { files: three() }), 400, 'thiếu tên', 'Vui lòng nhập tên đề tài');
  expectRes(await send('POST', '/api/submissions', owner.token, { fields: { title: 'x' }, files: three().slice(0, 2) }), 400, 'thiếu file 3', 'đủ 3 file');
  expectRes(await send('POST', '/api/submissions', owner.token, { fields: { title: '   ', titleDisplay: '' }, files: three() }), 400, 'tên toàn khoảng trắng');

  expectRes(await send('POST', '/api/submissions', vienTruong.token, { fields: { title: 'viện trưởng nộp ' + TAG }, files: three() }), 201, 'hiện trạng: tài khoản không thuộc Hội đồng cũng nộp được');

  const files = [f('sci_ace_01', 'thuyet-minh.pdf'), f('sci_ace_02', 'b.pdf'), f('sci_ace_03', 'c.pdf'), f('attachments', 'phu-luc-1.pdf'), f('attachments', 'phu-luc-2.pdf')];
  const r = await send('POST', '/api/submissions', owner.token, { fields: { titleDisplay: `  [test] qua titleDisplay ${TAG} ` }, files });
  expectRes(r, 201, 'tạo', 'Đã gửi hồ sơ thành công');
  const d = await detail(r.body.id, owner.token);
  assert.equal(d.status, 'SUBMITTED');
  assert.equal(d.title, `[test] qua titleDisplay ${TAG}`, 'tên được cắt khoảng trắng; titleDisplay dùng khi thiếu title');
  assert.equal(d.submittedBy, owner.email);
  assert.deepEqual(d.submissionFiles.map((x) => x.fieldName), ['attachment_0', 'attachment_1', 'sci_ace_01', 'sci_ace_02', 'sci_ace_03']);
  assert.equal(d.submissionFiles.find((x) => x.fieldName === 'sci_ace_01').originalName, 'thuyet-minh.pdf');
});

test('danh sách: NCV chỉ thấy hồ sơ của mình; Hội đồng/Admin thấy tất cả kèm họ tên; vai trò khác 403', async () => {
  const mineId = await create(owner, `[test] của owner ${TAG}`);
  const theirsId = await create(other, `[test] của other ${TAG}`);
  const own = await api('GET', '/api/submissions', owner.token);
  expectRes(own, 200, 'NCV');
  assert.ok(own.body.some((x) => x.id === mineId));
  assert.ok(!own.body.some((x) => x.id === theirsId), 'NCV không thấy hồ sơ người khác');
  assert.ok(own.body.every((x) => x.submittedBy === owner.email));
  assert.ok('status' in own.body[0] && !('submittedByName' in own.body[0]), 'dạng danh sách NCV: có status, không có submittedByName');
  assert.match(own.res.headers.get('cache-control') || '', /no-store/);

  for (const who of [admin, chuTich, thuKy, tv1]) {
    const all = await api('GET', '/api/submissions', who.token);
    expectRes(all, 200, 'Hội đồng/Admin');
    assert.ok(all.body.some((x) => x.id === mineId) && all.body.some((x) => x.id === theirsId));
    const row = all.body.find((x) => x.id === theirsId);
    assert.equal(row.submittedByName, `NCV khác ${TAG}`);
    assert.ok(!('status' in row), 'hiện trạng: dạng danh sách Hội đồng/Admin KHÔNG có status');
  }
  expectRes(await api('GET', '/api/submissions', vienTruong.token), 403, 'Viện trưởng', 'không có quyền xem danh sách');
});

test('danh sách Hội đồng: GET /api/users/council chỉ cho Hội đồng/Admin; Admin hiện là "Ủy viên Hội đồng"', async () => {
  for (const who of [owner, other, vienTruong]) expectRes(await api('GET', '/api/users/council', who.token), 403, who.email, 'Chỉ thành viên Hội đồng');
  for (const who of [admin, chuTich, thuKy, tv1]) {
    const r = await api('GET', '/api/users/council', who.token);
    expectRes(r, 200, 'council');
    const byId = new Map(r.body.council.map((u) => [u.id, u]));
    assert.equal(byId.get(chuTich.id).roleDisplay, 'Chủ tịch');
    assert.equal(byId.get(admin.id).roleDisplay, 'Ủy viên Hội đồng');
    assert.ok(byId.has(thuKy.id) && byId.has(tv1.id));
    assert.ok(!byId.has(owner.id) && !byId.has(vienTruong.id), 'NCV và Viện trưởng không nằm trong danh sách');
  }
});

test('chi tiết: chủ hồ sơ và Hội đồng/Admin xem được, NCV khác và Viện trưởng 403; id sai 400; id lạ 404', async () => {
  const id = await create();
  for (const who of [owner, admin, chuTich, thuKy, tv1]) expectRes(await api('GET', `/api/submissions/${id}`, who.token), 200, who.email);
  for (const who of [other, vienTruong]) expectRes(await api('GET', `/api/submissions/${id}`, who.token), 403, who.email, 'không có quyền xem hồ sơ này');
  expectRes(await api('GET', '/api/submissions/abc', admin.token), 400, 'id chữ', 'ID hồ sơ không hợp lệ');
  expectRes(await api('GET', '/api/submissions/0', admin.token), 400, 'id 0', 'ID hồ sơ không hợp lệ');
  expectRes(await api('GET', '/api/submissions/987654', admin.token), 404, 'id lạ', 'Không tìm thấy hồ sơ');
  const d = await detail(id);
  for (const k of ['reviewNote', 'assignedReviewerIds', 'meetingMinutes', 'conditionalFile', 'decisionVn', 'decisionEn', 'completedAt']) assert.equal(d[k], null, k + ' chưa có');
  assert.deepEqual(d.gd5History, []);
  assert.deepEqual(d.reportPeriodicFiles, []);
  assert.equal(d.reportFinalFile, null);
});

test('tải file theo tên trường và tải cả hồ sơ: chủ hồ sơ/Hội đồng được, người khác 403; một file → file, nhiều file → zip', async () => {
  const id = await create();
  const one1 = await call(srv.baseUrl, `/api/submissions/${id}/file/sci_ace_02`, { token: owner.token });
  assert.equal(one1.status, 200);
  assert.equal(await one1.text(), '%PDF-1.4 thử nghiệm');
  assert.match(one1.headers.get('content-disposition') || '', /a2\.pdf/);
  expectRes(await api('GET', `/api/submissions/${id}/file/sci_ace_02`, chuTich.token), 200, 'Hội đồng tải file');
  expectRes(await api('GET', `/api/submissions/${id}/file/sci_ace_02`, other.token), 403, 'NCV khác', 'không có quyền tải file');
  expectRes(await api('GET', `/api/submissions/${id}/file/khong_co`, owner.token), 404, 'không có trường', 'Không tìm thấy file');
  expectRes(await api('GET', `/api/submissions/${id}/file/..%2F..`, owner.token), 400, 'tên trường chỉ gồm ký tự bị lọc → rỗng', 'Tham số không hợp lệ');

  const zip = await call(srv.baseUrl, `/api/submissions/${id}/download`, { token: owner.token });
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-disposition') || '', new RegExp(`ho-so-${id}\\.zip`));
  assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  expectRes(await api('GET', `/api/submissions/${id}/download`, other.token), 403, 'NCV khác tải cả hồ sơ', 'không có quyền tải hồ sơ');
  expectRes(await api('GET', '/api/submissions/987654/download', admin.token), 404, 'id lạ');
});

test('HIỆN TRẠNG (lỗi): tên file có dấu tiếng Việt bị hỏng khi lưu — fixFilenameEncoding giải mã latin1→utf8 lần hai trên tên mà lib/upload đã sửa', async () => {
  // server.js dùng multer bọc bởi lib/upload (đã trả tên UTF-8 đúng) rồi lại gọi fixFilenameEncoding — hàm này
  // KHÔNG idempotent nên biến "Thuyết minh.pdf" thành chuỗi chứa U+FFFD. Ghim lại để refactor cắt–dán không
  // vô tình đổi hành vi; khi sửa lỗi (PR riêng, xem Nợ kỹ thuật) thì đổi test này thành mong đợi tên đúng.
  const r = await send('POST', '/api/submissions', owner.token, { fields: { title: 'x ' + TAG }, files: [f('sci_ace_01', 'Thuyết minh.pdf'), f('sci_ace_02', 'b.pdf'), f('sci_ace_03', 'c.pdf')] });
  expectRes(r, 201, 'tạo');
  const name = (await detail(r.body.id)).submissionFiles.find((x) => x.fieldName === 'sci_ace_01').originalName;
  assert.ok(name.includes('�'), 'hiện trạng: tên bị hỏng, thật: ' + JSON.stringify(name));
  assert.ok(name.endsWith('.pdf'));
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. GĐ3 — KIỂM TRA HỒ SƠ (review) và NỘP LẠI (resubmit)
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('review (Thư ký/Admin): quyết định hợp lệ → trạng thái mới; xử lý lại → 400; quyết định lạ → 400', async () => {
  const id = await create();
  expectRes(await api('PUT', `/api/submissions/${id}/review`, thuKy.token, {}), 400, 'thiếu decision', 'pass, reject');
  expectRes(await api('PUT', `/api/submissions/${id}/review`, thuKy.token, { decision: 'maybe' }), 400, 'decision lạ');
  const r = await api('PUT', `/api/submissions/${id}/review`, thuKy.token, { decision: 'need_supplement', comment: '  thiếu phụ lục  ' });
  expectRes(r, 200, 'cần bổ sung');
  assert.equal(r.body.status, 'NEED_REVISION');
  const d = await detail(id);
  assert.equal(d.status, 'NEED_REVISION');
  assert.equal(d.reviewNote, 'thiếu phụ lục');
  assert.equal(d.reviewedByName, `Thư ký ${TAG}`);
  expectRes(await api('PUT', `/api/submissions/${id}/review`, thuKy.token, { decision: 'pass' }), 400, 'xử lý lần 2', 'đã được xử lý tại GĐ3');
  // need_revision và reject cho ra trạng thái khác nhau
  const rej = await create();
  assert.equal((await api('PUT', `/api/submissions/${rej}/review`, admin.token, { decision: 'reject' })).body.status, 'REJECTED');
  const rev = await create();
  assert.equal((await api('PUT', `/api/submissions/${rev}/review`, admin.token, { decision: 'need_revision' })).body.status, 'NEED_REVISION');
});

test('resubmit: chỉ khi NEED_REVISION; chủ hồ sơ hoặc Admin; đuôi file sai 400; thành công → SUBMITTED, xóa ghi chú duyệt, thay file', async () => {
  const id = await create();
  expectRes(await send('POST', `/api/submissions/${id}/resubmit`, owner.token, {}), 400, 'đang SUBMITTED', 'Chỉ có thể nộp lại');
  expectRes(await api('PUT', `/api/submissions/${id}/review`, thuKy.token, { decision: 'need_revision', comment: 'sửa đi' }), 200, 'yêu cầu bổ sung');
  expectRes(await send('POST', `/api/submissions/${id}/resubmit`, other.token, {}), 403, 'NCV khác', 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin');
  expectRes(await send('POST', `/api/submissions/${id}/resubmit`, thuKy.token, {}), 403, 'Thư ký không được nộp lại hộ');
  expectRes(await send('POST', `/api/submissions/${id}/resubmit`, owner.token, { files: [f('sci_ace_01', 'virus.exe')] }), 400, 'đuôi .exe', 'PDF hoặc Word');
  assert.equal((await detail(id)).status, 'NEED_REVISION', 'nộp lỗi thì trạng thái giữ nguyên');
  const ok = await send('POST', `/api/submissions/${id}/resubmit`, owner.token, { fields: { note: 'đã bổ sung' }, files: [f('sci_ace_01', 'ban-moi.docx')] });
  expectRes(ok, 200, 'nộp lại');
  assert.equal(ok.body.status, 'SUBMITTED');
  const d = await detail(id);
  assert.equal(d.status, 'SUBMITTED');
  assert.equal(d.reviewNote, null);
  assert.equal(d.reviewedByName, null);
  assert.equal(d.submissionFiles.find((x) => x.fieldName === 'sci_ace_01').originalName, 'ban-moi.docx');
  assert.equal(d.gd5History.at(-1).actionType, 'resubmit');
  assert.equal(d.gd5History.at(-1).label, 'đã bổ sung');
  // Admin nộp lại hộ được; không cần gửi file nào
  await api('PUT', `/api/submissions/${id}/review`, thuKy.token, { decision: 'need_revision' });
  const byAdmin = await send('POST', `/api/submissions/${id}/resubmit`, admin.token, {});
  expectRes(byAdmin, 200, 'admin nộp lại hộ');
  assert.match((await detail(id)).gd5History.at(-1).label, /Nghiên cứu viên nộp lại hồ sơ sau khi bổ sung/);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. GĐ4 — PHÂN CÔNG PHẢN BIỆN; reset-gd4
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('assign-reviewers: sai trạng thái 400; <2 phản biện 400; ngoài Hội đồng 400; chủ hồ sơ làm phản biện 400; hợp lệ → UNDER_REVIEW', async () => {
  const sub = await create();
  const url = `/api/submissions/${sub}/assign-reviewers`;
  expectRes(await api('PUT', url, chuTich.token, { reviewerIds: [tv1.id, tv2.id] }), 400, 'chưa VALIDATED', 'Đã kiểm tra');
  await api('PUT', `/api/submissions/${sub}/review`, thuKy.token, { decision: 'pass' });
  expectRes(await api('PUT', url, chuTich.token, {}), 400, 'thiếu danh sách', 'ít nhất 2 phản biện');
  expectRes(await api('PUT', url, chuTich.token, { reviewerIds: [tv1.id] }), 400, 'chỉ 1', 'ít nhất 2 phản biện');
  expectRes(await api('PUT', url, chuTich.token, { reviewerIds: [tv1.id, tv1.id, String(tv1.id)] }), 400, 'trùng id chỉ tính một', 'ít nhất 2 phản biện');
  expectRes(await api('PUT', url, chuTich.token, { reviewerIds: [tv1.id, owner.id] }), 400, 'NCV làm phản biện', 'thành viên Hội đồng');
  expectRes(await api('PUT', url, chuTich.token, { reviewerIds: [tv1.id, vienTruong.id] }), 400, 'Viện trưởng làm phản biện');

  // xung đột lợi ích: thành viên Hội đồng nộp hồ sơ thì không được chấm hồ sơ của chính mình
  const own = await toValidated(tv1);
  expectRes(await api('PUT', `/api/submissions/${own}/assign-reviewers`, chuTich.token, { reviewerIds: [tv1.id, tv2.id] }), 400, 'xung đột lợi ích', 'xung đột lợi ích');

  const ok = await api('PUT', url, chuTich.token, { reviewerIds: [tv1.id, String(tv2.id)], note: ' xin xem kỹ ' });
  expectRes(ok, 200, 'phân công');
  assert.equal(ok.body.status, 'UNDER_REVIEW');
  const d = await detail(sub);
  assert.deepEqual(JSON.parse(d.assignedReviewerIds), [tv1.id, tv2.id]);
  assert.deepEqual(d.assignedReviewerNames, [`Thành viên một ${TAG}`, `Thành viên hai ${TAG}`]);
  assert.equal(d.assignNote, 'xin xem kỹ');
  assert.equal(d.assignedByName, `Chủ tịch ${TAG}`);
  expectRes(await api('PUT', url, chuTich.token, { reviewerIds: [tv1.id, tv2.id] }), 400, 'phân công lần 2', 'Đã kiểm tra');
  // Admin cũng thuộc Hội đồng nên được chọn làm phản biện
  const withAdmin = await toValidated();
  expectRes(await api('PUT', `/api/submissions/${withAdmin}/assign-reviewers`, admin.token, { reviewerIds: [admin.id, tv2.id] }), 200, 'admin là phản biện');
});

test('reset-gd4 (Admin): chỉ khi UNDER_REVIEW; đưa về VALIDATED, xóa phân công và file phản biện cũ', async () => {
  const early = await toValidated();
  expectRes(await api('PUT', `/api/submissions/${early}/reset-gd4`, admin.token), 400, 'chưa UNDER_REVIEW', 'Trạng thái hiện tại: VALIDATED');
  expectRes(await api('PUT', '/api/submissions/987654/reset-gd4', admin.token), 404, 'id lạ');
  const id = await toUnderReview();
  expectRes(await send('POST', `/api/submissions/${id}/review-upload`, tv1.token, { files: one('pb-cu.pdf') }), 200, 'phản biện 1 nộp');
  const r = await api('PUT', `/api/submissions/${id}/reset-gd4`, admin.token);
  expectRes(r, 200, 'reset');
  assert.equal(r.body.status, 'VALIDATED');
  const d = await detail(id);
  assert.equal(d.status, 'VALIDATED');
  assert.equal(d.assignedReviewerIds, null);
  assert.equal(d.assignedAt, null);
  assert.equal(d.gd5History.at(-1).actionType, 'reset_gd4');
  assert.match(d.gd5History.at(-1).label, /đã xóa 1 file phản biện cũ/);
  expectRes(await api('GET', `/api/submissions/${id}/review-file/1`, admin.token), 404, 'file cũ đã xóa', 'Không tìm thấy file phản biện');
  // phân công lại được, và phản biện cũ nộp file không còn tính
  expectRes(await api('PUT', `/api/submissions/${id}/assign-reviewers`, chuTich.token, { reviewerIds: [tv2.id, tv1.id] }), 200, 'phân công lại');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 5. GĐ5 — PHẢN BIỆN NỘP FILE
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('review-files / review-file: Hội đồng/Admin xem được; NCV và Viện trưởng 403; slot ngoài 1–2 → 400; chưa có file → 404', async () => {
  const id = await toUnderReview();
  for (const who of [admin, chuTich, thuKy, tv1, tv2]) expectRes(await api('GET', `/api/submissions/${id}/review-files`, who.token), 200, who.email);
  for (const who of [owner, other, vienTruong]) expectRes(await api('GET', `/api/submissions/${id}/review-files`, who.token), 403, who.email, 'phản biện được phân công');
  expectRes(await api('GET', '/api/submissions/987654/review-files', admin.token), 404);
  const files = (await api('GET', `/api/submissions/${id}/review-files`, chuTich.token)).body.reviewFiles;
  assert.deepEqual(files.map((x) => [x.slot, x.reviewerId, x.hasFile]), [[1, tv1.id, false], [2, tv2.id, false]]);
  assert.equal(files[0].reviewerName, `Thành viên một ${TAG}`);

  expectRes(await api('GET', `/api/submissions/${id}/review-file/0`, admin.token), 400, 'slot 0', 'Tham số không hợp lệ');
  expectRes(await api('GET', `/api/submissions/${id}/review-file/3`, admin.token), 400, 'slot 3');
  expectRes(await api('GET', `/api/submissions/${id}/review-file/1`, owner.token), 403, 'NCV', 'Không có quyền tải file này');
  expectRes(await api('GET', `/api/submissions/${id}/review-file/1`, admin.token), 404, 'chưa có file', 'Không tìm thấy file phản biện');
  expectRes(await send('POST', `/api/submissions/${id}/review-upload`, tv2.token, { files: one('pb2.pdf') }), 200, 'phản biện 2 nộp');
  const got = await call(srv.baseUrl, `/api/submissions/${id}/review-file/2`, { token: tv1.token });
  assert.equal(got.status, 200);
  assert.match(got.headers.get('content-disposition') || '', /pb2\.pdf/);
  const after = (await api('GET', `/api/submissions/${id}/review-files`, chuTich.token)).body.reviewFiles;
  assert.deepEqual(after.map((x) => x.hasFile), [false, true]);
});

test('review-upload: chỉ phản biện được phân công hoặc Admin (kèm slot); đủ 2 file thì tự chuyển IN_MEETING', async () => {
  const early = await toValidated();
  expectRes(await send('POST', `/api/submissions/${early}/review-upload`, tv1.token, { files: one() }), 400, 'chưa UNDER_REVIEW', 'GĐ5');
  expectRes(await send('POST', '/api/submissions/987654/review-upload', tv1.token, { files: one() }), 404);

  const id = await toUnderReview();
  const url = `/api/submissions/${id}/review-upload`;
  expectRes(await send('POST', url, owner.token, { files: one() }), 403, 'NCV', 'Chỉ phản biện được phân công');
  expectRes(await send('POST', url, chuTich.token, { files: one() }), 403, 'Chủ tịch không phải phản biện', 'Chỉ phản biện được phân công');
  expectRes(await send('POST', url, admin.token, { files: one() }), 403, 'Admin thiếu slot');
  expectRes(await send('POST', url, admin.token, { fields: { slot: 3 }, files: one() }), 403, 'Admin slot 3');
  expectRes(await send('POST', url, tv1.token, {}), 400, 'thiếu file', 'Vui lòng chọn file');
  expectRes(await send('POST', url, tv1.token, { files: one('pb.txt') }), 400, 'đuôi .txt', 'PDF hoặc Word');
  const first = await send('POST', url, tv2.token, { files: one('cua-tv2.pdf') });
  expectRes(first, 200, 'tv2 nộp');
  assert.equal(first.body.slot, 2, 'slot theo thứ tự trong danh sách phân công');
  assert.equal(first.body.status, undefined);
  assert.equal(first.body.originalName, 'cua-tv2.pdf');
  assert.equal((await detail(id)).status, 'UNDER_REVIEW');
  // nộp lại cùng slot thì thay file, không đếm thành hai
  expectRes(await send('POST', url, tv2.token, { files: one('cua-tv2-ban-2.pdf') }), 200, 'tv2 nộp lại');
  assert.equal((await detail(id)).status, 'UNDER_REVIEW');
  // Admin nộp hộ slot 1 → đủ 2 → IN_MEETING
  const last = await send('POST', url, admin.token, { fields: { slot: 1 }, files: one('admin-ho.pdf') });
  expectRes(last, 200, 'admin nộp hộ');
  assert.equal(last.body.status, 'IN_MEETING');
  assert.match(last.body.message, /Cả 2 phản biện đã nộp xong/);
  const d = await detail(id);
  assert.equal(d.status, 'IN_MEETING');
  assert.deepEqual(d.gd5ReviewHistory.map((x) => x.originalName), ['admin-ho.pdf', 'cua-tv2-ban-2.pdf']);
  expectRes(await send('POST', url, tv1.token, { files: one() }), 400, 'đã sang IN_MEETING', 'GĐ5');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 6. GĐ6 — HỌP HỘI ĐỒNG; chấp thuận có điều kiện; cấp quyết định
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('meeting-result: chỉ khi IN_MEETING; quyết định hợp lệ; ba kết quả ra ba trạng thái; biên bản lưu kèm', async () => {
  const early = await toUnderReview();
  expectRes(await meeting(early, 'approved'), 400, 'chưa họp', 'giai đoạn Họp Hội đồng');
  const id = await toInMeeting();
  expectRes(await meeting(id, 'maybe'), 400, 'quyết định lạ', 'Chấp thuận, Có điều kiện');
  expectRes(await send('PUT', `/api/submissions/${id}/meeting-result`, thuKy.token, {}), 400, 'thiếu decision');
  const r = await meeting(id, 'CONDITIONAL');
  expectRes(r, 200, 'có điều kiện (không phân biệt hoa thường)');
  assert.equal(r.body.status, 'CONDITIONAL');
  const d = await detail(id);
  assert.equal(d.meetingNote, 'ghi chú họp');
  assert.equal(d.meetingMinutes.originalName, 'bien-ban.pdf');
  assert.equal(d.meetingDecisionByName, `Thư ký ${TAG}`);
  expectRes(await meeting(id, 'approved'), 400, 'đã ghi nhận kết quả', 'giai đoạn Họp Hội đồng');

  const ap = await toInMeeting();
  assert.equal((await meeting(ap, 'approved', false)).body.status, 'APPROVED');
  assert.equal((await detail(ap)).meetingMinutes, null, 'không gửi biên bản vẫn ghi nhận được');
  const rj = await toInMeeting();
  assert.equal((await meeting(rj, 'rejected')).body.status, 'REJECTED');
});

test('chấp thuận có điều kiện: NCV nộp SCI-ACE-04 → Chủ tịch không thông qua (xoay vòng) → nộp lại → thông qua → APPROVED', async () => {
  const id = await toInMeeting();
  const sub04 = (who, name = 'sci-ace-04.pdf') => send('POST', `/api/submissions/${id}/conditional-submit`, who.token, { files: one(name) });
  expectRes(await sub04(owner), 400, 'chưa CONDITIONAL', 'Chấp thuận có điều kiện');
  expectRes(await meeting(id, 'conditional'), 200, 'họp: có điều kiện');

  expectRes(await api('PUT', `/api/submissions/${id}/conditional-approve`, chuTich.token), 400, 'NCV chưa nộp', 'chưa nộp SCI-ACE-04');
  expectRes(await api('PUT', `/api/submissions/${id}/conditional-reject`, chuTich.token), 400, 'chưa có bản giải trình', 'Chưa có bản giải trình');
  expectRes(await sub04(other), 403, 'NCV khác', 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin');
  expectRes(await sub04(chuTich), 403, 'Chủ tịch không nộp hộ');
  expectRes(await send('POST', `/api/submissions/${id}/conditional-submit`, owner.token, {}), 400, 'thiếu file', 'chọn file SCI-ACE-04');
  expectRes(await sub04(owner, 'sci-ace-04.png'), 400, 'đuôi .png', 'PDF hoặc Word');

  expectRes(await sub04(owner), 200, 'nộp SCI-ACE-04');
  const d1 = await detail(id);
  assert.ok(d1.conditionalSubmittedAt);
  assert.equal(d1.conditionalFile.originalName, 'sci-ace-04.pdf');
  assert.equal(d1.status, 'CONDITIONAL');

  expectRes(await api('PUT', `/api/submissions/${id}/conditional-reject`, thuKy.token), 403, 'Thư ký không thông qua/bác', 'Chủ tịch Hội đồng hoặc Admin');
  expectRes(await api('PUT', `/api/submissions/${id}/conditional-approve`, owner.token), 403, 'NCV không tự thông qua');
  expectRes(await api('PUT', `/api/submissions/${id}/conditional-reject`, chuTich.token), 200, 'không thông qua');
  const d2 = await detail(id);
  assert.equal(d2.conditionalSubmittedAt, null, 'bị bác thì NCV phải nộp lại');
  assert.equal(d2.conditionalFile, null);
  assert.equal(d2.status, 'CONDITIONAL');
  assert.match(d2.gd5History.at(-1).label, /lần 1/);
  expectRes(await api('PUT', `/api/submissions/${id}/conditional-approve`, chuTich.token), 400, 'sau khi bị bác', 'chưa nộp SCI-ACE-04');

  expectRes(await sub04(admin, 'ban-2.docx'), 200, 'Admin nộp hộ lần 2');
  const ok = await api('PUT', `/api/submissions/${id}/conditional-approve`, chuTich.token);
  expectRes(ok, 200, 'thông qua', 'Cấp Quyết định');
  const d3 = await detail(id);
  assert.equal(d3.status, 'APPROVED');
  assert.equal(d3.conditionalApprovedByName, `Chủ tịch ${TAG}`);
  assert.equal(d3.conditionalFile.originalName, 'ban-2.docx');
  expectRes(await api('PUT', `/api/submissions/${id}/conditional-approve`, chuTich.token), 400, 'đã APPROVED', 'trạng thái Chấp thuận có điều kiện');
});

test('issue-decision: chỉ khi APPROVED; cần đủ QĐ tiếng Việt và tiếng Anh, PDF/Word; thành công → IMPLEMENTATION', async () => {
  const early = await toInMeeting();
  const put = (id, files, who = thuKy) => send('PUT', `/api/submissions/${id}/issue-decision`, who.token, { files });
  expectRes(await put(early, [f('decision_vn', 'a.pdf'), f('decision_en', 'b.pdf')]), 400, 'chưa APPROVED', 'đã được Hội đồng chấp thuận');
  const id = await toApproved();
  expectRes(await put(id, []), 400, 'thiếu cả hai', 'tiếng Việt');
  expectRes(await put(id, [f('decision_vn', 'a.pdf')]), 400, 'thiếu EN', 'tiếng Anh');
  expectRes(await put(id, [f('decision_vn', 'a.pdf'), f('decision_en', 'b.zip')]), 400, 'EN sai đuôi', 'tiếng Anh: chỉ chấp nhận PDF hoặc Word');
  expectRes(await put(id, [f('decision_vn', 'a.exe'), f('decision_en', 'b.pdf')]), 400, 'VN sai đuôi', 'tiếng Việt: chỉ chấp nhận');
  assert.equal((await detail(id)).status, 'APPROVED');
  const ok = await put(id, [f('decision_vn', 'quyet-dinh.pdf'), f('decision_en', 'decision.docx')], admin);
  expectRes(ok, 200, 'cấp quyết định (Admin)');
  assert.equal(ok.body.status, 'IMPLEMENTATION');
  const d = await detail(id);
  assert.equal(d.status, 'IMPLEMENTATION');
  assert.equal(d.decisionVn.originalName, 'quyet-dinh.pdf');
  assert.equal(d.decisionEn.originalName, 'decision.docx');
  assert.ok(d.decisionIssuedAt);
  expectRes(await put(id, [f('decision_vn', 'a.pdf'), f('decision_en', 'b.pdf')]), 400, 'cấp lần 2', 'đã được Hội đồng chấp thuận');
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 7. GĐ7 — BÁO CÁO; xóa hồ sơ
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('báo cáo định kỳ và kết thúc: chỉ khi IMPLEMENTATION; chủ hồ sơ/Admin; định kỳ đánh số 1,2,…; kết thúc → COMPLETED', async () => {
  const early = await toApproved();
  expectRes(await send('POST', `/api/submissions/${early}/report-periodic`, owner.token, { files: one() }), 400, 'chưa thực hiện', 'giai đoạn Thực hiện');
  expectRes(await send('POST', `/api/submissions/${early}/report-final`, owner.token, { files: one() }), 400, 'chưa thực hiện', 'giai đoạn Thực hiện');

  const id = await toImplementation();
  const per = (who, files = one('dinh-ky.pdf')) => send('POST', `/api/submissions/${id}/report-periodic`, who.token, { files });
  const fin = (who, files = one('ket-thuc.pdf')) => send('POST', `/api/submissions/${id}/report-final`, who.token, { files });
  expectRes(await per(other), 403, 'NCV khác', 'báo cáo định kỳ');
  expectRes(await fin(chuTich), 403, 'Chủ tịch', 'báo cáo kết thúc');
  expectRes(await per(owner, []), 400, 'thiếu file', 'báo cáo định kỳ');
  expectRes(await per(owner, one('bc.xlsx')), 400, 'sai đuôi', 'PDF hoặc Word');
  const p1 = await per(owner);
  expectRes(p1, 200, 'định kỳ 1');
  assert.deepEqual([p1.body.slot, p1.body.fieldName], [1, 'report_periodic_1']);
  const p2 = await per(admin, one('dinh-ky-2.docx'));
  assert.deepEqual([p2.body.slot, p2.body.fieldName], [2, 'report_periodic_2']);
  let d = await detail(id);
  assert.deepEqual(d.reportPeriodicFiles.map((x) => x.fieldName), ['report_periodic_1', 'report_periodic_2']);
  assert.equal(d.status, 'IMPLEMENTATION', 'báo cáo định kỳ không đổi trạng thái');
  assert.ok(!d.submissionFiles.some((x) => x.fieldName.startsWith('report_')), 'file báo cáo không lẫn vào danh sách file hồ sơ');

  expectRes(await fin(other), 403, 'NCV khác nộp kết thúc');
  expectRes(await fin(owner, []), 400, 'thiếu file', 'báo cáo kết thúc');
  const done = await fin(owner);
  expectRes(done, 200, 'kết thúc', 'Hồ sơ đã hoàn thành');
  assert.equal(done.body.status, 'COMPLETED');
  d = await detail(id);
  assert.equal(d.status, 'COMPLETED');
  assert.equal(d.reportFinalFile.originalName, 'ket-thuc.pdf');
  assert.ok(d.completedAt);
  expectRes(await per(owner), 400, 'sau khi COMPLETED', 'giai đoạn Thực hiện');
  expectRes(await fin(owner), 400, 'nộp kết thúc lần 2', 'giai đoạn Thực hiện');
});

test('xóa hồ sơ (Admin): xóa cả file và lịch sử; id lạ 404; id sai 400; sau xóa mọi thao tác trả 404', async () => {
  const id = await toApproved();
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const raw = new Database(srv.dbPath, { readonly: true });
  const stored = raw.prepare('SELECT path FROM submission_files WHERE submissionId = ?').all(id).map((r) => r.path);
  raw.close();
  assert.ok(stored.length >= 5, 'hồ sơ có file: 3 hồ sơ + 2 phản biện + biên bản');
  assert.ok(stored.every((p) => fs.existsSync(p)), 'trước khi xóa, mọi file có trên đĩa');
  expectRes(await api('DELETE', '/api/submissions/abc', admin.token), 400, 'id chữ', 'ID hồ sơ không hợp lệ');
  expectRes(await api('DELETE', '/api/submissions/987654', admin.token), 404, 'id lạ', 'Không tìm thấy hồ sơ');
  expectRes(await api('DELETE', `/api/submissions/${id}`, admin.token), 200, 'xóa', 'Đã xóa hồ sơ');
  assert.ok(stored.every((p) => !fs.existsSync(p)), 'xóa hồ sơ thì xóa luôn thư mục file trên đĩa');
  const raw2 = new Database(srv.dbPath, { readonly: true });
  assert.equal(raw2.prepare('SELECT COUNT(*) AS c FROM submission_files WHERE submissionId = ?').get(id).c, 0, 'bảng file sạch');
  assert.equal(raw2.prepare('SELECT COUNT(*) AS c FROM submission_gd5_history WHERE submissionId = ?').get(id).c, 0, 'lịch sử sạch');
  raw2.close();
  expectRes(await api('GET', `/api/submissions/${id}`, admin.token), 404, 'chi tiết sau xóa');
  expectRes(await api('GET', `/api/submissions/${id}/file/sci_ace_01`, admin.token), 404, 'file sau xóa');
  expectRes(await api('GET', `/api/submissions/${id}/download`, admin.token), 404, 'tải sau xóa');
  const list = await api('GET', '/api/submissions', admin.token);
  assert.ok(!list.body.some((x) => x.id === id));
  expectRes(await api('DELETE', `/api/submissions/${id}`, admin.token), 404, 'xóa lần 2');
});
