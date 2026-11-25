'use strict';

/**
 * Lưới test cho Đợt 5: Cooperation (65 route) + HTQT (6 route) + Events (13 route) = 84 route.
 *
 * Mục tiêu:
 *   1. Đối chiếu danh sách 84 route THẬT trên server (không thêm/mất/đổi thứ tự).
 *   2. Ghim cổng xác thực (công khai vs cần đăng nhập vs coopPhongOrAdmin vs adminOnly).
 *   3. Ghim luồng nghiệp vụ chính của Events, HTQT và Cooperation (đề xuất, thẩm định, phê duyệt,
 *      nộp lại, kết thúc, thỏa thuận, sự kiện hợp tác, thống kê & badge).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const { startTestServer, call } = require('./helpers/testServer');
const { addUser } = require('./helpers/users');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT_COOP_HTQT_EVENTS || 3233);
const TAG = Date.now().toString(36);

let srv;
let admin;
let researcher;
let other;
let phongKhcn;

test.before(async () => {
  srv = await startTestServer({ port: PORT, env: { API_RATE_LIMIT_MAX: '1000000' } });
  admin = { token: srv.tokens.admin, id: srv.tokens.users.admin.id };
  const mk = (name, role) => addUser(srv, { fullname: `${name} ${TAG}`, role });
  researcher = mk('NCV HTQT', 'researcher');
  other = mk('NCV khác HTQT', 'researcher');
  phongKhcn = mk('Phòng KHCN HTQT', 'phong_khcn');
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

function expectRes(r, status, label, msgPart) {
  assert.equal(r.s, status, `${label} → mong ${status}, thật ${r.s}: ${JSON.stringify(r.body)}`);
  if (msgPart) {
    const m = String((r.body && r.body.message) || '');
    assert.ok(m.includes(msgPart), `${label} → câu thông báo phải chứa "${msgPart}", thật: "${m}"`);
  }
}

const EXPECTED_ROUTES = [
  'POST /api/cooperation/mou/submit',
  'GET /api/cooperation/de-xuat-chi-tiet/:source/:id',
  'GET /api/cooperation/can-approve',
  'GET /api/cooperation/quan-ly-stats',
  'GET /api/cooperation/de-xuat-cho-phong-khcn',
  'GET /api/cooperation/de-xuat-cho-vien-truong',
  'GET /api/cooperation/de-xuat-cho-duyet',
  'PUT /api/cooperation/doan-vao/:id/tham-dinh',
  'PUT /api/cooperation/doan-vao/:id/duyet',
  'PUT /api/cooperation/mou/:id/tham-dinh',
  'PUT /api/cooperation/mou/:id/duyet',
  'PUT /api/cooperation/doan-ra/:id/duyet',
  'GET /api/htqt/de-xuat/:id',
  'POST /api/htqt/de-xuat/:id/phe-duyet',
  'POST /api/htqt/de-xuat/:id/yeu-cau-bo-sung',
  'POST /api/htqt/de-xuat/:id/khong-phe-duyet',
  'PATCH /api/htqt/de-xuat/:id/admin',
  'POST /api/htqt/de-xuat',
  'GET /api/cooperation/de-xuat-cua-toi',
  'POST /api/cooperation/doan-ra/submit',
  'POST /api/cooperation/doan-vao/submit',
  'GET /api/cooperation/doan-ra',
  'GET /api/cooperation/doan-vao',
  'GET /api/cooperation/mou',
  'GET /api/cooperation/overview',
  'GET /api/cooperation/doi-tac',
  'GET /api/cooperation/thoa-thuan',
  'GET /api/cooperation/thoa-thuan/:id',
  'GET /api/cooperation/thoa-thuan/:id/scan',
  'GET /api/cooperation/thoa-thuan/:id/termination-scan',
  'POST /api/cooperation/thoa-thuan',
  'POST /api/cooperation/thoa-thuan/:id/terminate',
  'POST /api/cooperation/thoa-thuan/:id/agreement-scan',
  'GET /api/cooperation/sidebar-badges',
  'GET /api/cooperation/dashboard-stats',
  'GET /api/cooperation/cho-phong-xu-ly',
  'GET /api/cooperation/cho-vt-duyet',
  'GET /api/cooperation/tat-ca-de-xuat',
  'GET /api/cooperation/chi-tiet/:loai/:id',
  'GET /api/cooperation/doan-ra/:id/van-ban-word',
  'GET /api/cooperation/doan-ra/to-trinh-template/status',
  'GET /api/cooperation/doan-vao/:id/van-ban-word',
  'GET /api/cooperation/doan-vao/to-trinh-template/status',
  'GET /api/cooperation/mou/:id/van-ban-word',
  'GET /api/cooperation/mou/to-trinh-template/status',
  'GET /api/cooperation/ytnn/:id/van-ban-word',
  'GET /api/cooperation/ytnn/to-trinh-template/status',
  'GET /api/cooperation/lich-su/:loai/:id',
  'PUT /api/cooperation/doan-ra/:id/tham-dinh',
  'PUT /api/cooperation/doan-ra/:id/phe-duyet',
  'PUT /api/cooperation/doan-vao/:id/phe-duyet',
  'PUT /api/cooperation/mou/:id/phe-duyet',
  'POST /api/cooperation/ytnn/submit',
  'GET /api/cooperation/ytnn',
  'PUT /api/cooperation/ytnn/:id/tham-dinh',
  'PUT /api/cooperation/ytnn/:id/phe-duyet',
  'PUT /api/cooperation/doan-ra/:id/cap-nhat-boi-nguoi-nop',
  'POST /api/cooperation/doan-ra/:id/nop-lai',
  'POST /api/cooperation/doan-ra/:id/ket-thuc',
  'PUT /api/cooperation/doan-vao/:id/cap-nhat-boi-nguoi-nop',
  'POST /api/cooperation/doan-vao/:id/nop-lai',
  'POST /api/cooperation/doan-vao/:id/ket-thuc',
  'PUT /api/cooperation/mou/:id/cap-nhat-boi-nguoi-nop',
  'POST /api/cooperation/mou/:id/nop-lai',
  'POST /api/cooperation/mou/:id/ket-thuc',
  'PUT /api/cooperation/ytnn/:id/cap-nhat-boi-nguoi-nop',
  'POST /api/cooperation/ytnn/:id/nop-lai',
  'POST /api/cooperation/ytnn/:id/ket-thuc',
  'POST /api/cooperation/su-kien',
  'GET /api/cooperation/su-kien',
  'PUT /api/cooperation/su-kien/:id',
  'GET /api/events',
  'POST /api/events',
  'GET /api/events/:id',
  'PUT /api/events/:id',
  'DELETE /api/events/:id',
  'PATCH /api/events/:id/status',
  'GET /api/events/:id/sessions',
  'PUT /api/events/:id/sessions',
  'POST /api/events/:id/files',
  'GET /api/events/:id/files',
  'DELETE /api/events/:id/files/:fileId',
  'POST /api/events/:id/export/to-trinh',
  'POST /api/events/:id/export/bao-cao',
];

test('bảng route khớp 84 route cooperation + htqt + events THẬT trong server', () => {
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
    .filter((r) => / \/api\/(cooperation|htqt|events)(\/|$)/.test(r));
  assert.deepEqual(actual, EXPECTED_ROUTES);
});

test('cổng xác thực: route công khai trả 200, route bảo vệ trả 401 khi thiếu token, sai vai trò trả 403', async () => {
  for (const pub of [
    '/api/cooperation/overview',
    '/api/cooperation/doi-tac',
    '/api/cooperation/thoa-thuan',
  ]) {
    const r = await api('GET', pub, null);
    expectRes(r, 200, `công khai ${pub}`);
  }

  for (const [m, p] of [
    ['GET', '/api/cooperation/de-xuat-cua-toi'],
    ['GET', '/api/cooperation/sidebar-badges'],
    ['GET', '/api/cooperation/dashboard-stats'],
    ['GET', '/api/cooperation/su-kien'],
    ['GET', '/api/htqt/de-xuat/1'],
    ['POST', '/api/htqt/de-xuat'],
    ['GET', '/api/events'],
    ['POST', '/api/events'],
  ]) {
    const r = await api(m, p, null, {});
    expectRes(r, 401, `chưa đăng nhập ${m} ${p}`);
  }

  expectRes(await api('POST', '/api/events', researcher.token, { tieu_de: 'X', ngay_bat_dau: '2026-12-01' }), 403, 'NCV tạo event');
  expectRes(await api('DELETE', '/api/events/999999', phongKhcn.token), 403, 'P.KHCN xóa event (adminOnly)');
  expectRes(await api('PATCH', '/api/htqt/de-xuat/999999/admin', phongKhcn.token, {}), 403, 'P.KHCN patch htqt admin');
  expectRes(await api('POST', '/api/cooperation/su-kien', researcher.token, {}), 403, 'NCV tạo cooperation su-kien');
});

test('luồng Events: đọc danh sách/chi tiết/phiên/file, kiểm tra lỗi SQLite ở POST (hiện trạng) và xóa (adminOnly)', async () => {
  const list = await api('GET', '/api/events', researcher.token);
  expectRes(list, 200, 'danh sách sự kiện');

  // Ghi nhận hiện trạng: eventGenSoVanBan dùng strftime("%Y", ...) nên POST /api/events trả 500 trên SQLite mới
  const cr = await api('POST', '/api/events', phongKhcn.token, {
    tieu_de: `Hội thảo ${TAG}`,
    loai: 'Hội thảo',
    ngay_bat_dau: '2026-12-10',
  });
  assert.ok([201, 500].includes(cr.s), `POST /api/events → ${cr.s}`);

  expectRes(await api('GET', '/api/events/999999', researcher.token), 404, 'chi tiết sự kiện không tồn tại');
  expectRes(await api('PUT', '/api/events/999999', phongKhcn.token, { dia_diem: 'Hội trường A' }), 404, 'cập nhật sự kiện không tồn tại');
  expectRes(await api('GET', '/api/events/999999/sessions', researcher.token), 200, 'phiên họp sự kiện không tồn tại');
  expectRes(await api('PUT', '/api/events/999999/sessions', phongKhcn.token, { sessions: [] }), 404, 'cập nhật phiên họp 404');
  expectRes(await api('GET', '/api/events/999999/files', researcher.token), 200, 'danh sách file sự kiện');
  expectRes(await api('DELETE', '/api/events/999999/files/1', phongKhcn.token), 404, 'xóa file không tồn tại');
  expectRes(await api('PATCH', '/api/events/999999/status', phongKhcn.token, { to_status: 'cho_xin_phep' }), 404, 'chuyển trạng thái 404');
  expectRes(await api('DELETE', '/api/events/999999', admin.token), 200, 'admin xóa sự kiện');
});

test('luồng HTQT: gửi đề xuất, xem chi tiết, yêu cầu bổ sung, phê duyệt', async () => {
  const cr = await api('POST', '/api/htqt/de-xuat', researcher.token, {
    loai_de_xuat: 'doan_ra',
    tieu_de: `Đoàn ra HTQT ${TAG}`,
    quoc_gia: 'Nhật Bản',
    muc_dich: 'Trao đổi học thuật',
  });
  assert.ok([200, 201].includes(cr.s), `tạo đề xuất HTQT → ${cr.s}: ${JSON.stringify(cr.body)}`);
  const id = cr.body.id || (cr.body.data && cr.body.data.id);
  assert.ok(id > 0, 'phải trả về id đề xuất HTQT');

  expectRes(await api('GET', `/api/htqt/de-xuat/${id}`, researcher.token), 200, 'chủ đề xuất xem chi tiết HTQT');
  expectRes(await api('POST', `/api/htqt/de-xuat/${id}/yeu-cau-bo-sung`, admin.token, {
    noi_dung: 'Bổ sung lịch trình công tác chi tiết theo ngày',
    han_bo_sung: '2026-12-20',
  }), 200, 'yêu cầu bổ sung HTQT');
  expectRes(await api('POST', `/api/htqt/de-xuat/${id}/phe-duyet`, admin.token, { y_kien: 'Đồng ý' }), 400, 'đã yêu cầu bổ sung thì không phê duyệt trực tiếp');

  const cr2 = await api('POST', '/api/htqt/de-xuat', researcher.token, {
    loai_de_xuat: 'doan_ra',
    tieu_de: `Đoàn ra HTQT 2 ${TAG}`,
    quoc_gia: 'Hàn Quốc',
    muc_dich: 'Hợp tác nghiên cứu',
  });
  assert.ok([200, 201].includes(cr2.s));
  const id2 = cr2.body.id || (cr2.body.data && cr2.body.data.id);
  expectRes(await api('POST', `/api/htqt/de-xuat/${id2}/phe-duyet`, admin.token, { y_kien: 'Đồng ý phê duyệt đề xuất' }), 200, 'admin phê duyệt HTQT');
  expectRes(await api('PATCH', `/api/htqt/de-xuat/${id2}/admin`, admin.token, { ghi_chu_noi_bo: 'Trao đổi & ký MOU' }), 200, 'admin sửa HTQT');
});

test('luồng Cooperation: đoàn ra, đoàn vào, MOU, YTNN, thỏa thuận, sự kiện & thống kê', async () => {
  // Đề xuất đoàn ra (kể cả khi chưa có email nhận thông báo vẫn lưu DB hoặc báo lỗi có kiểm soát)
  const dr = await api('POST', '/api/cooperation/doan-ra/submit', researcher.token, {
    muc_dich: `Hội nghị quốc tế ${TAG}`,
    quoc_gia: 'Pháp',
    ngay_di: '2026-12-15',
    ngay_ve: '2026-12-20',
  });
  assert.ok([200, 201, 400].includes(dr.s), `doan-ra/submit → ${dr.s}`);
  if (dr.body && dr.body.id) {
    const drId = dr.body.id;
    expectRes(await api('GET', `/api/cooperation/chi-tiet/doan_ra/${drId}`, researcher.token), 200, 'chi tiết đoàn ra');
    expectRes(await api('GET', `/api/cooperation/lich-su/doan_ra/${drId}`, researcher.token), 200, 'lịch sử đoàn ra');
    expectRes(await api('PUT', `/api/cooperation/doan-ra/${drId}/tham-dinh`, phongKhcn.token, { action: 'yeu_cau_bo_sung', note: 'Bổ sung thư mời' }), 200, 'thẩm định yêu cầu bổ sung');
    expectRes(await api('PUT', `/api/cooperation/doan-ra/${drId}/cap-nhat-boi-nguoi-nop`, researcher.token, { muc_dich: `Hội nghị cập nhật ${TAG}` }), 200, 'người nộp cập nhật');
    expectRes(await api('POST', `/api/cooperation/doan-ra/${drId}/nop-lai`, researcher.token, {}), 200, 'người nộp nộp lại');
    expectRes(await api('PUT', `/api/cooperation/doan-ra/${drId}/tham-dinh`, phongKhcn.token, { action: 'duyet_len_vt', note: 'Đủ hồ sơ' }), 200, 'thẩm định chuyển VT');
    expectRes(await api('PUT', `/api/cooperation/doan-ra/${drId}/phe-duyet`, admin.token, { action: 'da_duyet', note: 'Đồng ý' }), 200, 'phê duyệt đoàn ra');
    expectRes(await api('POST', `/api/cooperation/doan-ra/${drId}/ket-thuc`, researcher.token, { bao_cao: 'Hoàn thành tốt' }), 400, 'kết thúc đoàn ra sau khi đã duyệt trả 400');
  }

  // YTNN
  const yt = await api('POST', '/api/cooperation/ytnn/submit', researcher.token, {
    ten: `Đề xuất YTNN ${TAG}`,
    doi_tac_ten: 'Pasteur Paris',
    doi_tac_quoc_gia: 'Pháp',
  });
  assert.ok([200, 201].includes(yt.s), `ytnn/submit → ${yt.s}: ${JSON.stringify(yt.body)}`);
  const ytId = yt.body.id;
  assert.ok(ytId > 0);
  expectRes(await api('GET', '/api/cooperation/ytnn', researcher.token), 200, 'danh sách YTNN');
  expectRes(await api('GET', `/api/cooperation/chi-tiet/ytnn/${ytId}`, other.token), 403, 'NCV khác không xem YTNN');

  // Thỏa thuận
  const tt = await api('POST', '/api/cooperation/thoa-thuan', phongKhcn.token, {
    ten: `MOU hợp tác ${TAG}`,
    doi_tac: `ĐH Tokyo ${TAG}`,
    loai: 'MOU',
    quoc_gia: 'Nhật Bản',
    ngay_ky: '2026-11-01',
    thoi_han_nam: 3,
  });
  assert.ok([200, 201].includes(tt.s), `tạo thỏa thuận → ${tt.s}: ${JSON.stringify(tt.body)}`);
  const ttId = tt.body.item && tt.body.item.id;
  assert.ok(ttId > 0, 'phải trả về item.id');
  expectRes(await api('GET', `/api/cooperation/thoa-thuan/${ttId}`, researcher.token), 200, 'chi tiết thỏa thuận');
  expectRes(await api('POST', `/api/cooperation/thoa-thuan/${ttId}/terminate`, phongKhcn.token, { terminated_at: '2026-11-25' }), 200, 'chấm dứt thỏa thuận');

  // Sự kiện hợp tác & các endpoint tổng hợp
  const sk = await api('POST', '/api/cooperation/su-kien', phongKhcn.token, {
    tieu_de: `Sự kiện hợp tác ${TAG}`,
    ngay_bat_dau: '2026-12-01',
  });
  assert.ok([200, 201].includes(sk.s), `tạo su-kien → ${sk.s}: ${JSON.stringify(sk.body)}`);
  const skId = sk.body.id;
  expectRes(await api('PUT', `/api/cooperation/su-kien/${skId}`, phongKhcn.token, { dia_diem: 'Phòng họp 1' }), 200, 'sửa su-kien');

  for (const ep of [
    '/api/cooperation/de-xuat-cua-toi',
    '/api/cooperation/can-approve',
    '/api/cooperation/quan-ly-stats',
    '/api/cooperation/sidebar-badges',
    '/api/cooperation/dashboard-stats',
    '/api/cooperation/cho-phong-xu-ly',
    '/api/cooperation/cho-vt-duyet',
    '/api/cooperation/tat-ca-de-xuat',
    '/api/cooperation/doan-ra',
    '/api/cooperation/doan-vao',
    '/api/cooperation/mou',
    '/api/cooperation/doan-ra/to-trinh-template/status',
    '/api/cooperation/doan-vao/to-trinh-template/status',
    '/api/cooperation/mou/to-trinh-template/status',
    '/api/cooperation/ytnn/to-trinh-template/status',
  ]) {
    expectRes(await api('GET', ep, admin.token), 200, `GET ${ep}`);
  }
});
