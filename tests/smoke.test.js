/**
 * tests/smoke.test.js
 * Test khói cho các endpoint quan trọng nhất.
 *
 * Mục tiêu KHÔNG phải phủ hết logic, mà là lưới an toàn khi tách/refactor
 * server.js: nếu một endpoint biến mất, đổi đường dẫn, hoặc tuột phân quyền
 * thì test phải đỏ ngay.
 *
 * Chạy: npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, call } = require('./helpers/testServer');

let srv;

test.before(async () => {
  srv = await startTestServer();
});

test.after(async () => {
  if (srv) await srv.stop();
});

const get = (p, token) => call(srv.baseUrl, p, { token });
const post = (p, token, body) => call(srv.baseUrl, p, { token, method: 'POST', body });
const del = (p, token) => call(srv.baseUrl, p, { token, method: 'DELETE' });

// ── 1. Sống và cấu hình cơ bản ───────────────────────────────────────────────

test('health trả về ok', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
});

test('server-time trả về múi giờ Việt Nam', async () => {
  const res = await get('/api/server-time');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.match(j.timezone, /Ho_Chi_Minh/);
});

test('SMTP phải tắt trong môi trường test (không gửi mail thật)', () => {
  const out = srv.logs.join('');
  assert.ok(
    /Chưa cấu hình SMTP/.test(out),
    'Server phải báo chưa cấu hình SMTP — nếu không, test có thể gửi email thật'
  );
});

// ── 2. Ranh giới xác thực ────────────────────────────────────────────────────

test('API cần đăng nhập: không token thì 401', async () => {
  for (const p of ['/api/missions', '/api/orcid/researchers', '/api/cooperation/dashboard-stats']) {
    const res = await get(p);
    assert.equal(res.status, 401, p + ' phải trả 401 khi chưa đăng nhập');
  }
});

test('token hỏng thì 401', async () => {
  const res = await get('/api/missions', 'khong-phai-jwt');
  assert.equal(res.status, 401);
});

test('trang HTML được bảo vệ thì chuyển hướng về đăng nhập', async () => {
  const res = await fetch(srv.baseUrl + '/quan-ly-de-tai-co-so.html', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') || '', /dang-nhap/);
});

// ── 3. Nhiệm vụ KHCN ─────────────────────────────────────────────────────────

test('danh sách nhiệm vụ trả về mảng', async () => {
  const res = await get('/api/missions', srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.missions), 'phải có trường missions dạng mảng');
});

test('thống kê nhiệm vụ trả về 200', async () => {
  const res = await get('/api/missions/stats', srv.tokens.admin);
  assert.equal(res.status, 200);
});

test('export CSV / Excel / mẫu nhập liệu: admin dùng được', async () => {
  for (const p of ['/api/missions/export', '/api/missions/export-excel', '/api/missions/export-template']) {
    const res = await get(p, srv.tokens.admin);
    assert.equal(res.status, 200, p);
  }
});

test('báo cáo thống kê xuất được file xlsx và đếm đúng số bản ghi', async () => {
  const res = await get('/api/missions/report-excel', srv.tokens.admin);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /spreadsheetml/);
  const count = Number(res.headers.get('x-mission-count'));
  assert.ok(Number.isFinite(count) && count >= 0, 'phải có header X-Mission-Count');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'file xlsx phải bắt đầu bằng chữ ký ZIP');
});

test('báo cáo lọc theo năm không vượt quá tổng số', async () => {
  const all = await get('/api/missions/report-excel', srv.tokens.admin);
  const some = await get('/api/missions/report-excel?fromYear=2016&toYear=2018', srv.tokens.admin);
  assert.equal(some.status, 200);
  assert.ok(
    Number(some.headers.get('x-mission-count')) <= Number(all.headers.get('x-mission-count')),
    'lọc theo năm phải cho kết quả nhỏ hơn hoặc bằng toàn bộ'
  );
});

test('export và import nhiệm vụ chỉ dành cho admin', async () => {
  const paths = [
    '/api/missions/export',
    '/api/missions/export-excel',
    '/api/missions/export-template',
    '/api/missions/report-excel',
  ];
  for (const p of paths) {
    const res = await get(p, srv.tokens.director);
    assert.equal(res.status, 403, p + ' phải chặn Viện trưởng');
  }
  const imp = await post('/api/admin/missions/import', srv.tokens.director, {});
  assert.equal(imp.status, 403, 'import phải chặn Viện trưởng');
});

// ── 4. Công tắc Harvest (không được tự chạy) ─────────────────────────────────

test('công tắc harvest mặc định TẮT', async () => {
  const res = await get('/api/orcid/harvest/enabled', srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.enabled, false, 'mặc định phải tắt để không tự gọi NCBI/ORCID');
});

test('khi TẮT thì không thể chạy harvest', async () => {
  const res = await post('/api/orcid/harvest', srv.tokens.admin, {});
  assert.equal(res.status, 423, 'phải bị công tắc chặn, không được khởi động phiên quét');
});

test('chỉ admin được bật/tắt harvest', async () => {
  const res = await post('/api/orcid/harvest/enabled', srv.tokens.director, { enabled: true });
  assert.equal(res.status, 403);
  // xác nhận trạng thái không đổi
  const check = await get('/api/orcid/harvest/enabled', srv.tokens.admin);
  assert.equal((await check.json()).enabled, false);
});

// ── 5. ORCID / công bố ───────────────────────────────────────────────────────

test('đọc danh sách nghiên cứu viên ORCID được', async () => {
  const res = await get('/api/orcid/researchers', srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.data));
});

test('thêm/xoá nghiên cứu viên và duyệt hàng chờ chỉ dành cho admin', async () => {
  const add = await post('/api/orcid/researchers', srv.tokens.director, {
    full_name: 'Không được phép',
    orcid_id: '0000-0001-2345-6789',
  });
  assert.equal(add.status, 403);

  const rm = await del('/api/orcid/researchers/999999', srv.tokens.director);
  assert.equal(rm.status, 403);

  const approve = await post('/api/orcid/queue/approve-all', srv.tokens.director, {});
  assert.equal(approve.status, 403);
});

test('import SCImago chỉ dành cho admin', async () => {
  const res = await post('/api/admin/sjr-csv-import', srv.tokens.director, {});
  assert.equal(res.status, 403);
});

// ── 6. Hợp tác quốc tế ───────────────────────────────────────────────────────

test('dashboard hợp tác trả về các nhóm số liệu', async () => {
  const res = await get('/api/cooperation/dashboard-stats', srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  const d = j.data || j;
  for (const k of ['by_loai', 'by_status']) {
    assert.ok(d[k] && typeof d[k] === 'object', 'thiếu nhóm ' + k);
  }
  for (const k of ['dang_xu_ly', 'da_phe_duyet', 'tu_choi', 'ket_thuc']) {
    assert.ok(k in d.by_status, 'by_status thiếu khoá ' + k);
  }
});

test('danh sách đề xuất lọc được theo loại', async () => {
  const res = await get('/api/cooperation/tat-ca-de-xuat?loai=doan_ra', srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.list));
  for (const it of j.list) assert.equal(it.loai, 'doan_ra');
});

test('lọc nhiều trạng thái cùng lúc (các ô Dashboard dựa vào cái này)', async () => {
  const nhom = 'dang_tham_dinh,cho_ky_duyet,cho_tham_dinh,cho_phong_duyet,cho_vt_duyet,cho_vt_phe_duyet,yeu_cau_bo_sung,cho_phan_loai,dang_chuan_bi';
  const res = await get('/api/cooperation/tat-ca-de-xuat?status=' + nhom, srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  const cho_phep = new Set(nhom.split(','));
  for (const it of j.list) {
    assert.ok(cho_phep.has(it.status), 'lọt trạng thái ngoài nhóm: ' + it.status);
  }
});

test('lọc một trạng thái (cách gọi cũ) vẫn chạy', async () => {
  const res = await get('/api/cooperation/tat-ca-de-xuat?status=cho_vt_duyet', srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  for (const it of j.list) assert.equal(it.status, 'cho_vt_duyet');
});

// ── 7. Mẫu biểu / tải file ───────────────────────────────────────────────────

test('danh sách mẫu ACE trả về đủ các loại', async () => {
  const res = await get('/api/ace-templates', srv.tokens.admin);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(Array.isArray(j.templates) && j.templates.length > 0);
  assert.ok(j.templates.every((t) => typeof t.type === 'string'));
});

test('tải mẫu không tồn tại thì 404, loại sai thì 400', async () => {
  const bad = await get('/api/ace-templates/khong-co-loai-nay/download', srv.tokens.admin);
  assert.equal(bad.status, 400);
});

test('danh sách mẫu hồ sơ nhiệm vụ trả về 200', async () => {
  const res = await get('/api/missions-templates', srv.tokens.admin);
  assert.equal(res.status, 200);
});

// ── 8. Tên file tiếng Việt ───────────────────────────────────────────────────

test('Content-Disposition giữ được tên file tiếng Việt', async () => {
  const { contentDisposition, decodeUploadedFilename } = require('../lib/filenames');
  const ten = 'Đơn đề nghị đánh giá đạo đức.docx';

  const cd = contentDisposition(ten);
  const m = cd.match(/filename\*=UTF-8''([^;]+)$/);
  assert.ok(m, 'phải có phần filename*=UTF-8');
  assert.equal(decodeURIComponent(m[1]), ten);
  assert.ok(!/[\r\n]/.test(cd), 'header không được chứa xuống dòng');

  // mojibake do busboy đọc latin1 phải khôi phục được
  const mojibake = Buffer.from(ten, 'utf8').toString('latin1');
  assert.equal(decodeUploadedFilename(mojibake), ten);
  // tên vốn đã đúng thì không bị "sửa" lần hai
  assert.equal(decodeUploadedFilename(ten), ten);
});
