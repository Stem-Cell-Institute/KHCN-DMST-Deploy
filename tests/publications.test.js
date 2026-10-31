'use strict';

/**
 * Lưới test cho miền Công bố khoa học — 15 route: 14 route /api/publications/* và
 * GET /api/researchers/list-for-disambiguation (đứng liền kề, cùng một nhóm trong Đợt 3).
 *
 * Bốn route (export/excel, export/report, admin/refresh-external-metrics, admin/clear-all) khai báo thẳng
 * trong server.js; 10 route còn lại nằm trong module sci-khcn-publications/src/routes/publications.js
 * (đã là router riêng — Đợt 3 chỉ phải giữ nguyên thứ tự mount quanh nó).
 *
 * Các test GHIM HÀNH VI HIỆN TẠI, kể cả điều chưa lý tưởng (xem các test mang nhãn "hiện trạng"):
 * chúng khẳng định "refactor không đổi hành vi", không khẳng định hành vi hiện tại là đúng.
 *
 * Điều quan trọng nhất file này canh: router sci-khcn-publications KHÔNG tự kiểm đăng nhập cho 6 route CRUD
 * (list, stats, :id, tạo, sửa, xóa). Chúng chỉ không bị lộ vì một router khác (module document-workflow,
 * `router.use(authMiddleware)`) được mount ở `/api` TRƯỚC khi publications được mount. Dời hoặc đổi thứ tự
 * mount mà không để ý sẽ mở toang 6 route này — test "cổng ngầm" bên dưới sẽ đỏ.
 *
 * Chạy trên server hộp cát riêng (cổng TEST_PORT_PUBLICATIONS, mặc định 3231): DB là bản sao, không gửi
 * email, không gọi API ngoài (test tự bỏ qua bước cập nhật Scopus/OpenAlex nếu DB có sẵn công bố).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT_PUBLICATIONS || 3231);
const TAG = Date.now().toString(36);

let srv;
let admin; // token Master Admin (email trùng ADMIN_EMAIL) — chính tài khoản admin có sẵn trong DB
let researcher;
let adminKhacMaster; // vai trò admin nhưng KHÔNG phải Master

test.before(async () => {
  srv = await startTestServer({ port: PORT, env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = srv.tokens.admin;
  researcher = addUser(srv, { fullname: 'NCV công bố ' + TAG, role: 'researcher' }).token;
  adminKhacMaster = addUser(srv, { fullname: 'Admin phụ ' + TAG, role: 'admin' }).token;
});

test.after(async () => {
  if (srv) await srv.stop();
});

/** Gọi API, trả { s: mã trạng thái, body: JSON | null, res }. */
async function api(method, url, token, body) {
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const r = await call(srv.baseUrl, url, { token, method, body: hasBody ? body : undefined });
  let json = null;
  try { json = await r.clone().json(); } catch (_) { /* không phải JSON */ }
  return { s: r.status, body: json, res: r };
}

function expectRes(r, status, label, msgPart) {
  assert.equal(r.s, status, `${label} → mong ${status}, thật ${r.s}: ${JSON.stringify(r.body)}`);
  if (msgPart) {
    const m = String((r.body && (r.body.message || r.body.error)) || '');
    assert.ok(m.includes(msgPart), `${label} → câu thông báo phải chứa "${msgPart}", thật: "${m}"`);
  }
}

const mk = (n) => `[test] ${n} ${TAG}`;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. BẢNG PHÂN QUYỀN — 15 route.   auth = chỉ cần đăng nhập · admin = adminOnly · master = masterAdminOnly
// ───────────────────────────────────────────────────────────────────────────────────────────────
const ROUTES = [
  ['GET', '/api/publications/export/excel', 'auth'],
  ['GET', '/api/publications/export/report', 'auth'],
  ['POST', '/api/publications/admin/refresh-external-metrics', 'admin'],
  ['GET', '/api/researchers/list-for-disambiguation', 'auth'],
  ['DELETE', '/api/publications/admin/clear-all', 'master'],
  ['GET', '/api/publications', 'auth'],
  ['GET', '/api/publications/stats', 'auth'],
  ['POST', '/api/publications/import-bibtex', 'auth'],
  ['POST', '/api/publications/preview-bibtex', 'auth'],
  ['POST', '/api/publications/import-bibtex-selected', 'auth'],
  ['POST', '/api/publications/disambiguate-nv-researcher', 'auth'],
  ['GET', '/api/publications/:id', 'auth'],
  ['POST', '/api/publications', 'auth'],
  ['PUT', '/api/publications/:id', 'auth'],
  ['DELETE', '/api/publications/:id', 'auth'],
];
const concrete = (p) => p.replace(/:[A-Za-z_]+/g, '999999');

test('bảng phân quyền khớp danh sách route công bố THẬT trong server (không thêm/mất route nào)', () => {
  const inv = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'route-inventory.js')], { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const live = inv.split(/\r?\n/)
    .map((l) => l.match(/^\d{4}\s+(\S+)\s+(\S+)/))
    .filter((m) => m && (m[2].startsWith('/api/publications') || m[2] === '/api/researchers/list-for-disambiguation'))
    .map((m) => `${m[1]} ${m[2]}`)
    .sort();
  const table = ROUTES.map(([m, p]) => `${m} ${p}`).sort();
  assert.equal(ROUTES.length, 15);
  assert.deepEqual(table, live, 'bảng ROUTES phải khớp đúng các route công bố đã đăng ký — sửa bảng CÓ CHỦ ĐÍCH khi thêm/bớt route');
});

test('chưa đăng nhập: cả 15 route trả 401', async () => {
  for (const [m, p] of ROUTES) {
    const r = await api(m, concrete(p), null, {});
    expectRes(r, 401, `${m} ${p} không token`);
  }
});

test('cổng ngầm: /api/* chưa đăng nhập luôn 401 kể cả đường dẫn không tồn tại; có token mới thấy 404 (router document-workflow gác /api)', async () => {
  // 6 route CRUD của sci-khcn-publications không có kiểm đăng nhập riêng — chỉ nhờ cổng này mà không bị lộ.
  const anon = await api('GET', '/api/duong-dan-khong-ton-tai-' + TAG, null);
  expectRes(anon, 401, 'đường dẫn lạ, không token');
  const authed = await api('GET', '/api/duong-dan-khong-ton-tai-' + TAG, admin);
  expectRes(authed, 404, 'đường dẫn lạ, có token', 'Không tìm thấy API');
});

test('token rác / hết hạn: 401 trên cả route trong server.js lẫn route trong module', async () => {
  for (const url of ['/api/publications', '/api/publications/export/report', '/api/researchers/list-for-disambiguation']) {
    expectRes(await api('GET', url, 'khong.phai.jwt'), 401, `token rác ${url}`);
  }
});

test('phân quyền theo vai trò: refresh-external-metrics (adminOnly) và clear-all (masterAdminOnly)', async () => {
  expectRes(await api('POST', '/api/publications/admin/refresh-external-metrics', researcher, {}), 403, 'NCV refresh', 'Chỉ Admin');
  expectRes(await api('DELETE', '/api/publications/admin/clear-all', researcher, { confirm: 'XOA-TOAN-BO' }), 403, 'NCV clear-all', 'Chỉ Master Admin');
  // admin thường (không trùng ADMIN_EMAIL) qua adminOnly nhưng KHÔNG qua masterAdminOnly
  expectRes(await api('DELETE', '/api/publications/admin/clear-all', adminKhacMaster, { confirm: 'XOA-TOAN-BO' }), 403, 'admin phụ clear-all', 'Chỉ Master Admin');
  const lt = addUser(srv, { fullname: 'Viện trưởng ' + TAG, role: 'vien_truong' }).token;
  for (const [m, p] of ROUTES.filter((r) => r[2] === 'auth' && r[0] === 'GET' && !r[1].includes(':id'))) {
    expectRes(await api(m, p, lt), 200, `vien_truong ${m} ${p}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. NGHIỆP VỤ
// ───────────────────────────────────────────────────────────────────────────────────────────────
test('refresh-external-metrics (admin): DB trống thì xử lý 0 bản ghi, không gọi mạng', async (t) => {
  const total = (await api('GET', '/api/publications?limit=1', admin)).body.pagination.total;
  if (total > 0) return t.skip('DB sao có sẵn công bố — bỏ qua để khỏi gọi OpenAlex/Scopus thật');
  const r = await api('POST', '/api/publications/admin/refresh-external-metrics', admin, { limit: 5 });
  expectRes(r, 200, 'refresh', 'Đã xử lý 0 bản ghi');
  assert.equal(r.body.processed, 0);
});

test('tạo → xem → sửa → tìm kiếm → xóa một công bố', async () => {
  const title = mk('bài báo vòng đời');
  const c = await api('POST', '/api/publications', researcher, { title, pub_year: 2031, authors: 'A; B', doi: `10.9999/vd.${TAG}`, quartile: 'Q1', journal_name: 'Tạp chí thử', status: 'accepted', is_open_access: true });
  expectRes(c, 201, 'tạo');
  assert.equal(c.body.ok, true);
  const id = c.body.id;
  assert.ok(Number.isInteger(id) && id > 0);

  const g = await api('GET', `/api/publications/${id}`, researcher);
  expectRes(g, 200, 'xem');
  assert.match(g.res.headers.get('cache-control') || '', /no-store/, 'chi tiết công bố không được cache');
  assert.equal(g.body.data.title, title);
  assert.equal(g.body.data.quartile, 'Q1');
  assert.equal(g.body.data.status, 'accepted');
  assert.equal(g.body.data.is_open_access, 1);

  const u = await api('PUT', `/api/publications/${id}`, admin, { title: title + ' (sửa)', pub_year: 2031, quartile: 'Q2' });
  expectRes(u, 200, 'sửa');
  const g2 = (await api('GET', `/api/publications/${id}`, admin)).body.data;
  assert.equal(g2.title, title + ' (sửa)');
  assert.equal(g2.quartile, 'Q2');
  // COALESCE: trường không gửi lên (doi, authors) được GIỮ; trường không COALESCE (journal_name) bị XÓA thành null
  assert.equal(g2.doi, `10.9999/vd.${TAG}`);
  assert.equal(g2.authors, 'A; B');
  assert.equal(g2.journal_name, null, 'hiện trạng: PUT thiếu journal_name thì xóa journal_name');
  assert.equal(g2.status, 'published', 'hiện trạng: PUT thiếu status thì đặt lại về published');
  assert.equal(g2.is_open_access, 0, 'hiện trạng: PUT thiếu is_open_access thì đặt lại về 0');

  const found = await api('GET', `/api/publications?q=${encodeURIComponent(TAG)}&year=2031&quartile=Q2`, researcher);
  expectRes(found, 200, 'tìm');
  assert.ok(found.body.data.some((p) => p.id === id));
  assert.equal(found.body.pagination.page, 1);

  expectRes(await api('DELETE', `/api/publications/${id}`, researcher), 200, 'xóa');
  expectRes(await api('GET', `/api/publications/${id}`, admin), 404, 'xem sau xóa', 'Không tìm thấy');
});

test('tạo công bố: thiếu title 400; trùng DOI 409; trùng tiêu đề+năm 409; trùng tiêu đề khi không có năm 409', async () => {
  expectRes(await api('POST', '/api/publications', admin, { authors: 'x' }), 400, 'thiếu title', 'Cần có trường title');
  expectRes(await api('POST', '/api/publications', admin, { title: '   ' }), 400, 'title toàn khoảng trắng');

  const title = mk('chống trùng');
  const a = await api('POST', '/api/publications', admin, { title, pub_year: 2032, doi: `10.9999/trung.${TAG}` });
  expectRes(a, 201, 'bản đầu');
  const dDoi = await api('POST', '/api/publications', admin, { title: mk('khác tiêu đề'), pub_year: 2032, doi: `10.9999/trung.${TAG}` });
  expectRes(dDoi, 409, 'trùng DOI', 'DOI này đã tồn tại');
  assert.equal(dDoi.body.reason, 'doi');
  assert.equal(dDoi.body.existing_id, a.body.id);
  const dTitle = await api('POST', '/api/publications', admin, { title, pub_year: 2032 });
  expectRes(dTitle, 409, 'trùng tiêu đề+năm', 'Trùng tiêu đề và năm xuất bản');
  const dNoYear = await api('POST', '/api/publications', admin, { title });
  expectRes(dNoYear, 409, 'trùng tiêu đề, không năm', 'không có năm hợp lệ');
  assert.equal(dNoYear.body.reason, 'title_no_year');
  // cùng tiêu đề, KHÁC năm: cho phép
  expectRes(await api('POST', '/api/publications', admin, { title, pub_year: 2033 }), 201, 'cùng tiêu đề khác năm');
});

test('hiện trạng: sửa / xóa công bố KHÔNG tồn tại vẫn trả 200 {ok:true}; NCV thường tạo-sửa-xóa được công bố của người khác', async () => {
  expectRes(await api('PUT', '/api/publications/987654321', admin, { title: 'x' }), 200, 'PUT id lạ');
  expectRes(await api('DELETE', '/api/publications/987654321', admin), 200, 'DELETE id lạ');
  // route CRUD không có kiểm vai trò: NCV xóa được công bố do admin tạo
  const c = await api('POST', '/api/publications', admin, { title: mk('của admin'), pub_year: 2034 });
  expectRes(c, 201, 'admin tạo');
  expectRes(await api('PUT', `/api/publications/${c.body.id}`, researcher, { title: mk('NCV sửa'), pub_year: 2034 }), 200, 'NCV sửa của admin');
  expectRes(await api('DELETE', `/api/publications/${c.body.id}`, researcher), 200, 'NCV xóa của admin');
  expectRes(await api('GET', `/api/publications/${c.body.id}`, admin), 404, 'đã mất');
});

test('danh sách: phân trang có trần 100, sort/order sai thì dùng mặc định, bộ lọc status/pub_type/project', async () => {
  const mkPub = (n, extra) => api('POST', '/api/publications', admin, { title: mk('lọc ' + n), pub_year: 2035, ...extra });
  expectRes(await mkPub('a', { pub_type: 'conference', status: 'accepted', project_code: 'DT-LOC-' + TAG }), 201, 'a');
  expectRes(await mkPub('b', { pub_type: 'journal', project_code: 'DT-LOC-' + TAG }), 201, 'b');
  const big = await api('GET', '/api/publications?limit=5000', admin);
  expectRes(big, 200, 'limit lớn');
  assert.equal(big.body.pagination.limit, 100, 'trần 100');
  const bad = await api('GET', '/api/publications?sort=password&order=sideways&limit=2', admin);
  expectRes(bad, 200, 'sort sai không lỗi');
  const byProj = await api('GET', `/api/publications?project=DT-LOC-${TAG}`, admin);
  assert.equal(byProj.body.pagination.total, 2);
  const byType = await api('GET', `/api/publications?project=DT-LOC-${TAG}&pub_type=conference&status=accepted`, admin);
  assert.equal(byType.body.pagination.total, 1);
  assert.equal(byType.body.data[0].title, mk('lọc a'));
  const paged = await api('GET', `/api/publications?project=DT-LOC-${TAG}&limit=1&page=2&sort=title&order=asc`, admin);
  assert.equal(paged.body.data.length, 1);
  assert.equal(paged.body.pagination.totalPages, 2);
  assert.equal(paged.body.data[0].title, mk('lọc b'));
});

test('thống kê: có meta năm, bộ lọc năm và đếm theo hạng Q', async () => {
  expectRes(await api('POST', '/api/publications', admin, { title: mk('thống kê Q1'), pub_year: 2036, quartile: 'Q1' }), 201, 'tạo Q1');
  expectRes(await api('POST', '/api/publications', admin, { title: mk('thống kê Q3'), pub_year: 2036, quartile: 'Q3' }), 201, 'tạo Q3');
  const all = await api('GET', '/api/publications/stats', researcher);
  expectRes(all, 200, 'stats');
  assert.equal(all.body.ok, true);
  assert.ok(all.body.data.meta.yearMax >= 2036);
  const y = await api('GET', '/api/publications/stats?year=2036', researcher);
  expectRes(y, 200, 'stats năm');
  assert.deepEqual(y.body.data.filter, { yearFrom: 2036, yearTo: 2036 });
  assert.equal(y.body.data.header.q1q2, 1);
  assert.equal(y.body.data.totals.total, 2);
  assert.equal(y.body.data.totals.q1, 1);
  assert.equal(y.body.data.totals.q3, 1);
  // đảo khoảng năm được chuẩn hóa
  const rev = await api('GET', '/api/publications/stats?year_from=2037&year_to=2036', researcher);
  assert.deepEqual(rev.body.data.filter, { yearFrom: 2036, yearTo: 2037 });
});

const BIB = (n, doi) => `@article{k${n}${TAG},\n  title={${mk('bib ' + n)}},\n  author={Nguyen, Van A and Tran, Thi B},\n  journal={Journal of Tests},\n  year={2037},\n  doi={${doi}}\n}\n`;

test('BibTeX: thiếu nội dung → 400; xem trước không ghi DB; nhập 1 lần, nhập lại thì bị bỏ qua vì trùng', async () => {
  for (const u of ['import-bibtex', 'preview-bibtex', 'import-bibtex-selected']) {
    expectRes(await api('POST', `/api/publications/${u}`, researcher, {}), 400, u + ' rỗng', 'Thiếu nội dung BibTeX');
  }
  const bib = BIB(1, `10.9999/bib1.${TAG}`) + BIB(2, `10.9999/bib2.${TAG}`) + BIB(2, `10.9999/bib2.${TAG}`);
  const before = (await api('GET', '/api/publications?limit=1', admin)).body.pagination.total;
  const pv = await api('POST', '/api/publications/preview-bibtex', researcher, { bibtex: bib });
  expectRes(pv, 200, 'preview');
  assert.equal(pv.body.entries.length, 3, 'xem trước liệt kê cả entry trùng trong file');
  assert.equal((await api('GET', '/api/publications?limit=1', admin)).body.pagination.total, before, 'preview không được ghi DB');

  const imp = await api('POST', '/api/publications/import-bibtex', researcher, { bibtex: bib });
  expectRes(imp, 200, 'import');
  assert.equal(imp.body.imported, 2);
  assert.equal(imp.body.skipped, 0, 'entry trùng NGAY TRONG file bị bỏ lặng lẽ, không tính vào skipped');
  assert.equal((await api('GET', '/api/publications?limit=1', admin)).body.pagination.total, before + 2);

  const again = await api('POST', '/api/publications/import-bibtex', researcher, { bibtex: bib });
  assert.equal(again.body.imported, 0);
  assert.equal(again.body.skipped, 2);
  assert.equal(again.body.skippedList.length, 2);
});

test('BibTeX chọn lọc: nhập theo scope "ready" và theo entry_ids; entry đã có trong DB không nhập lại', async () => {
  const bib = BIB(3, `10.9999/bib3.${TAG}`) + BIB(4, `10.9999/bib4.${TAG}`) + BIB(5, `10.9999/bib5.${TAG}`);
  const pv = await api('POST', '/api/publications/preview-bibtex', admin, { bibtex: bib });
  const ids = pv.body.entries.map((e) => e.entryId);
  assert.equal(ids.length, 3);
  const one = await api('POST', '/api/publications/import-bibtex-selected', admin, { bibtex: bib, entry_ids: [ids[0]] });
  expectRes(one, 200, 'chọn 1');
  assert.equal(one.body.imported, 1);
  assert.equal(one.body.attempted, 1);
  // chọn cả entry đã có trong DB (không nhập được) lẫn entry mới: chỉ entry mới được thử
  const mixed = await api('POST', '/api/publications/import-bibtex-selected', admin, { bibtex: bib, entry_ids: [ids[0], ids[1]] });
  assert.equal(mixed.body.attempted, 1, 'entry trùng DB không thuộc nhóm nhập được');
  assert.equal(mixed.body.imported, 1);
  // phần còn lại (scope mặc định ready): entry 3 và 4 đã vào DB nên chỉ còn entry 5
  const rest = await api('POST', '/api/publications/import-bibtex-selected', admin, { bibtex: bib });
  assert.equal(rest.body.imported, 1);
  assert.equal(rest.body.attempted, 1);
  const none = await api('POST', '/api/publications/import-bibtex-selected', admin, { bibtex: bib, scope: 'ready_and_suspicious' });
  assert.equal(none.body.imported, 0);
});

test('lọc định danh NCV: thiếu items → 400; quá 200 bài → 400 (không gọi mạng)', async () => {
  expectRes(await api('POST', '/api/publications/disambiguate-nv-researcher', researcher, {}), 400, 'thiếu items', 'Thiếu mảng items');
  const many = Array.from({ length: 201 }, (_, i) => ({ title: 'x' + i }));
  expectRes(await api('POST', '/api/publications/disambiguate-nv-researcher', researcher, { items: many }), 400, '201 bài', 'Tối đa 200 bài');
});

test('danh sách NCV để lọc định danh trả { success, researchers[] } có key và tên hiển thị', async () => {
  const r = await api('GET', '/api/researchers/list-for-disambiguation', researcher);
  expectRes(r, 200, 'list');
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.researchers) && r.body.researchers.length > 0);
  assert.ok(r.body.researchers[0].key && r.body.researchers[0].display_name);
});

test('xuất Excel và báo cáo in: đúng loại nội dung; bộ lọc năm được áp dụng', async () => {
  const x = await call(srv.baseUrl, '/api/publications/export/excel?year=2036', { token: researcher });
  assert.equal(x.status, 200);
  assert.ok((x.headers.get('content-type') || '').includes('spreadsheetml.sheet'));
  assert.match(x.headers.get('content-disposition') || '', /attachment; filename="cong-bo-khoa-hoc-\d{4}-\d{2}-\d{2}\.xlsx"/);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'xlsx là zip');
  const rp = await call(srv.baseUrl, '/api/publications/export/report?year=2036', { token: researcher });
  assert.equal(rp.status, 200);
  assert.ok((rp.headers.get('content-type') || '').startsWith('text/html'));
  const html = await rp.text();
  assert.ok(html.includes('Báo cáo công bố khoa học'));
  assert.ok(html.includes(mk('thống kê Q1')), 'năm 2036 có bài thống kê Q1');
  assert.ok(!html.includes(mk('lọc a')), 'bài năm 2035 bị lọc ra');
});

test('clear-all (Master Admin): sai/thiếu xác nhận → 400 không xóa gì; đúng xác nhận → xóa sạch công bố và hàng chờ ORCID', async () => {
  expectRes(await api('DELETE', '/api/publications/admin/clear-all', admin, {}), 400, 'thiếu confirm', 'XOA-TOAN-BO');
  expectRes(await api('DELETE', '/api/publications/admin/clear-all', admin, { confirm: 'xoa-toan-bo' }), 400, 'sai hoa/thường');
  const total = (await api('GET', '/api/publications?limit=1', admin)).body.pagination.total;
  assert.ok(total > 0, 'chưa xóa gì');
  const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  const raw = new Database(srv.dbPath, { readonly: true });
  const queueBefore = raw.prepare('SELECT COUNT(*) AS c FROM publication_queue').get().c;
  raw.close();
  const r = await api('DELETE', '/api/publications/admin/clear-all', admin, { confirm: 'XOA-TOAN-BO' });
  expectRes(r, 200, 'clear-all');
  assert.equal(r.body.ok, true);
  assert.equal(r.body.publicationsDeleted, total);
  assert.equal(r.body.queueDeleted, queueBefore, 'làm sạch cả hàng chờ ORCID để quét lại không trùng DOI');
  assert.equal((await api('GET', '/api/publications?limit=1', admin)).body.pagination.total, 0);
  const after = new Database(srv.dbPath, { readonly: true });
  assert.equal(after.prepare('SELECT COUNT(*) AS c FROM publication_queue').get().c, 0);
  after.close();
});
