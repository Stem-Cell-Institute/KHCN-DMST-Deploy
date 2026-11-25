/**
 * tests/capVienModule.test.js
 * Kiểm tra tích hợp Sub-App «Quản lý đề tài cấp Viện» (modules/de-tai-cap-vien) vào Eoffice:
 *   - Đăng ký module cap_vien trong /api/homepage-modules và /api/admin/homepage-modules
 *   - Số liệu capVienMini trong /api/homepage-stats khớp dữ liệu nckh_projects hiện có
 *   - Bắt buộc đăng nhập Eoffice (chưa đăng nhập: HTML -> 302, API -> 401)
 *   - Phân quyền thật (Tùy chọn A): Admin được đổi vai trò xem thử; người dùng thường bị khóa 403 & bỏ qua cookie active_role
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const { startTestServer } = require('./helpers/testServer');

const CAP_VIEN_DB = path.resolve(__dirname, '..', 'modules', 'de-tai-cap-vien', 'data', 'de-tai-cap-vien.db');

let srv;

before(async () => {
  srv = await startTestServer({ port: 3277 });
});

after(async () => {
  if (srv) await srv.stop();
});

test('module cap_vien xuất hiện trong /api/homepage-modules và bật mặc định', async () => {
  const res = await fetch(srv.baseUrl + '/api/homepage-modules');
  assert.equal(res.status, 200);
  const data = await res.json();
  const mod = (data.modules || []).find((m) => m.code === 'cap_vien');
  assert.ok(mod, 'Phải có module cap_vien trong /api/homepage-modules');
  assert.equal(Number(mod.enabled), 1);
});

test('admin xem, bật/tắt và sắp xếp lại danh sách module bao gồm cap_vien', async () => {
  const headers = {
    Authorization: 'Bearer ' + srv.tokens.admin,
    'Content-Type': 'application/json',
  };

  const listRes = await fetch(srv.baseUrl + '/api/admin/homepage-modules', { headers });
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  const mod = (listData.modules || []).find((m) => m.code === 'cap_vien');
  assert.ok(mod);
  assert.equal(mod.label, 'Quản lý đề tài cấp Viện');

  const offRes = await fetch(srv.baseUrl + '/api/admin/homepage-modules/cap_vien', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(offRes.status, 200);
  assert.equal(Number((await offRes.json()).module.enabled), 0);

  const onRes = await fetch(srv.baseUrl + '/api/admin/homepage-modules/cap_vien', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(onRes.status, 200);
  assert.equal(Number((await onRes.json()).module.enabled), 1);

  const codes = listData.modules.map((m) => m.code).filter((c) => c !== 'cap_vien');
  codes.unshift('cap_vien');
  const reorderRes = await fetch(srv.baseUrl + '/api/admin/homepage-modules/reorder', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ order: codes }),
  });
  assert.equal(reorderRes.status, 200);
});

test('/api/homepage-stats trả capVienMini khớp dữ liệu nckh_projects hiện có', async () => {
  const db = new Database(CAP_VIEN_DB, { readonly: true });
  const expectedTotal = db.prepare('SELECT COUNT(*) AS c FROM nckh_projects').get().c;
  const expectedInProgress = db.prepare("SELECT COUNT(*) AS c FROM nckh_projects WHERE UPPER(status) = 'IN_PROGRESS'").get().c;
  const expectedCompleted = db.prepare("SELECT COUNT(*) AS c FROM nckh_projects WHERE UPPER(status) = 'COMPLETED'").get().c;
  db.close();

  const res = await fetch(srv.baseUrl + '/api/homepage-stats', {
    headers: { Authorization: 'Bearer ' + srv.tokens.admin },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.capVienMini, {
    total: expectedTotal,
    inProgress: expectedInProgress,
    completed: expectedCompleted,
  });
  assert.ok(expectedTotal >= 30, 'Phải bảo toàn đủ dữ liệu đề tài hiện có');
});

test('chưa đăng nhập Eoffice: /de-tai-cap-vien/ chuyển hướng đăng nhập (302) và API trả 401', async () => {
  const redirSlash = await fetch(srv.baseUrl + '/de-tai-cap-vien', { redirect: 'manual' });
  assert.equal(redirSlash.status, 301);
  assert.equal(redirSlash.headers.get('location'), '/de-tai-cap-vien/');

  const unauthPage = await fetch(srv.baseUrl + '/de-tai-cap-vien/', { redirect: 'manual' });
  assert.equal(unauthPage.status, 302);
  assert.ok((unauthPage.headers.get('location') || '').includes('/dang-nhap.html'));

  const unauthApi = await fetch(srv.baseUrl + '/de-tai-cap-vien/api/projects');
  assert.equal(unauthApi.status, 401);
});

test('đã đăng nhập: phục vụ giao diện, toàn bộ 31 đề tài và khóa đổi vai trò theo Tùy chọn A', async () => {
  const adminHeaders = { Authorization: 'Bearer ' + srv.tokens.admin };

  const page = await fetch(srv.baseUrl + '/de-tai-cap-vien/', { headers: adminHeaders });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('QUẢN LÝ ĐỀ TÀI CẤP VIỆN'));
  assert.ok(html.includes('js/mount-path.js'));

  const projectsRes = await fetch(srv.baseUrl + '/de-tai-cap-vien/api/projects', { headers: adminHeaders });
  assert.equal(projectsRes.status, 200);
  const projectsJson = await projectsRes.json();
  assert.equal(projectsJson.success, true);
  assert.ok(Array.isArray(projectsJson.data) && projectsJson.data.length >= 30);

  // Admin: can_switch_role = true và gọi switch-role được (200)
  const adminMe = await (await fetch(srv.baseUrl + '/de-tai-cap-vien/api/rbac/current-user', { headers: adminHeaders })).json();
  assert.equal(adminMe.data.can_switch_role, true);
  assert.equal(adminMe.data.real_role, 'SUPER_ADMIN');

  const adminSwitch = await fetch(srv.baseUrl + '/de-tai-cap-vien/api/rbac/switch-role', {
    method: 'POST',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'VIEN_TRUONG' }),
  });
  assert.equal(adminSwitch.status, 200);

  // Người dùng thường: can_switch_role = false, bỏ qua x-role/cookie giả mạo, gọi switch-role bị 403
  if (srv.tokens.plain) {
    const plainHeaders = {
      Authorization: 'Bearer ' + srv.tokens.plain,
      'x-role': 'SUPER_ADMIN',
      Cookie: 'active_role=SUPER_ADMIN',
    };
    const plainMe = await (await fetch(srv.baseUrl + '/de-tai-cap-vien/api/rbac/current-user', { headers: plainHeaders })).json();
    assert.equal(plainMe.data.can_switch_role, false);
    assert.notEqual(plainMe.data.role, 'SUPER_ADMIN');

    const plainSwitch = await fetch(srv.baseUrl + '/de-tai-cap-vien/api/rbac/switch-role', {
      method: 'POST',
      headers: { ...plainHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'SUPER_ADMIN' }),
    });
    assert.equal(plainSwitch.status, 403);
  }
});

test('Cách 1: CHU_NHIEM chỉ thấy đúng đề tài của mình (khớp 2 lớp leader_email & tên chuẩn hóa), bị chặn 403 đề tài người khác', async () => {
  const ownership = require('../modules/de-tai-cap-vien/services/ownershipService');

  // Kiểm tra hàm khớp 2 lớp
  assert.equal(
    ownership.isProjectOwnedByUser(
      { leader_name: 'Phạm Thị Thu Thuỷ', leader_email: null },
      { role: 'CHU_NHIEM', fullname: 'TS. Phạm Thị Thu Thủy', email: 'thuy@sci.edu.vn' }
    ),
    true
  );
  assert.equal(
    ownership.isProjectOwnedByUser(
      { leader_name: 'Nguyễn Trường Sinh', leader_email: 'sinhnguyen@sci.edu.vn' },
      { role: 'CHU_NHIEM', fullname: 'Tên Khác', email: 'sinhnguyen@sci.edu.vn' }
    ),
    true
  );
  assert.equal(
    ownership.isProjectOwnedByUser(
      { leader_name: 'Nguyễn Trường Sinh', leader_email: 'sinhnguyen@sci.edu.vn' },
      { role: 'CHU_NHIEM', fullname: 'Nguyễn Trường Sinh', email: 'other@sci.edu.vn' }
    ),
    false
  );

  // Kiểm tra API thật với tài khoản researcher trong DB
  if (srv.tokens.plain && srv.tokens.users.plain) {
    const plainHeaders = { Authorization: 'Bearer ' + srv.tokens.plain };
    const adminHeaders = { Authorization: 'Bearer ' + srv.tokens.admin };

    const allAdmin = (await (await fetch(srv.baseUrl + '/de-tai-cap-vien/api/projects', { headers: adminHeaders })).json()).data;
    const myRes = await fetch(srv.baseUrl + '/de-tai-cap-vien/api/projects?leader=Phạm', { headers: plainHeaders });
    assert.equal(myRes.status, 200);
    const myList = (await myRes.json()).data;
    assert.ok(myList.length < allAdmin.length, 'CHU_NHIEM không được thấy toàn bộ đề tài của Viện');

    const foreignProject = allAdmin.find((p) => !myList.some((m) => m.id === p.id));
    if (foreignProject) {
      const detailRes = await fetch(srv.baseUrl + `/de-tai-cap-vien/api/projects/${foreignProject.id}`, { headers: plainHeaders });
      assert.equal(detailRes.status, 403, 'CHU_NHIEM truy cập đề tài của người khác phải bị 403');
    }
  }
});
