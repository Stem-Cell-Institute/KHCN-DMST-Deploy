'use strict';

// Quản lý danh mục (loại vị trí lưu trữ, mẫu hộp, loại mẫu): quyền, kiểm tra đầu vào, ràng buộc khi xóa / sửa.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

const DUONG_DAN = ['container-types', 'box-templates', 'sample-types'];

test('danh mục: chưa đăng nhập 401, nghiên cứu viên 403 ở mọi thao tác ghi', async () => {
  for (const p of DUONG_DAN) {
    assert.equal((await s.api(null, 'POST', `/${p}`, { name: 'x' })).status, 401, p);
    assert.equal((await s.api('alice', 'POST', `/${p}`, { name: 'x' })).status, 403, p);
    assert.equal((await s.api('alice', 'PATCH', `/${p}/1`, { name: 'x' })).status, 403, p);
    assert.equal((await s.api('alice', 'DELETE', `/${p}/1`)).status, 403, p);
  }
  // đọc danh mục thì ai cũng được (qua /meta)
  assert.equal((await s.api('alice', 'GET', '/meta')).status, 200);
});

test('loại vị trí lưu trữ: thêm, sửa, trùng tên 409, nhiệt độ sai 400, thiếu tên 400', async () => {
  const ok = await s.api('manager', 'POST', '/container-types', { name: 'Tủ -150°C', default_temp_c: -150, sort_order: 9 });
  assert.equal(ok.status, 201);
  const id = ok.json.id;
  assert.equal((await s.api('manager', 'POST', '/container-types', { name: 'Tủ -150°C' })).status, 409);
  assert.equal((await s.api('manager', 'POST', '/container-types', { default_temp_c: -1 })).status, 400);
  assert.equal((await s.api('manager', 'POST', '/container-types', { name: 'Nóng', default_temp_c: 900 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/container-types/${id}`, { name: '' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/container-types/${id}`, { name: 'Tủ -150' })).status, 200);
  assert.equal((await s.api('manager', 'PATCH', `/container-types/${id}`, { name: 'Tủ -80°C' })).status, 409); // trùng mặc định
  assert.equal((await s.api('manager', 'PATCH', '/container-types/99999', { name: 'a' })).status, 404);
  assert.equal((await s.api('manager', 'PATCH', `/container-types/${id}`, {})).status, 400);
  const meta = (await s.api('alice', 'GET', '/meta')).json;
  assert.ok(meta.containerTypes.some((t) => t.name === 'Tủ -150'));
});

test('loại vị trí lưu trữ đang được dùng thì không xóa được', async () => {
  const dung = await s.api('manager', 'DELETE', `/container-types/${kho.type}`);
  assert.equal(dung.status, 409);
  assert.match(dung.json.message, /vị trí lưu trữ đang dùng/);
  const moi = await s.api('manager', 'POST', '/container-types', { name: 'Loại tạm' });
  assert.equal((await s.api('manager', 'DELETE', `/container-types/${moi.json.id}`)).status, 200);
  assert.equal((await s.api('manager', 'DELETE', `/container-types/${moi.json.id}`)).status, 404);
});

test('mẫu hộp: kích thước hợp lệ 1–26 × 1–30; đổi kích thước bị khóa khi đã có hộp dùng; xóa thì gỡ liên kết', async () => {
  assert.equal((await s.api('manager', 'POST', '/box-templates', { name: 'to', rows: 27, cols: 5 })).status, 400);
  assert.equal((await s.api('manager', 'POST', '/box-templates', { name: 'to', rows: 5, cols: 31 })).status, 400);
  assert.equal((await s.api('manager', 'POST', '/box-templates', { name: 'to', rows: 'a', cols: 5 })).status, 400);
  assert.equal((await s.api('manager', 'POST', '/box-templates', { rows: 5, cols: 5 })).status, 400);
  const t = await s.api('manager', 'POST', '/box-templates', { name: 'Hộp 8x12', rows: 8, cols: 12 });
  assert.equal(t.status, 201);
  assert.equal((await s.api('manager', 'POST', '/box-templates', { name: 'Hộp 8x12', rows: 8, cols: 12 })).status, 409);
  // chưa có hộp dùng: đổi kích thước được
  assert.equal((await s.api('manager', 'PATCH', `/box-templates/${t.json.id}`, { rows: 8, cols: 10 })).status, 200);
  const hop = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: t.json.id });
  assert.equal((await s.api('manager', 'PATCH', `/box-templates/${t.json.id}`, { cols: 12 })).status, 409);
  assert.equal((await s.api('manager', 'PATCH', `/box-templates/${t.json.id}`, { name: 'Hộp 8x10' })).status, 200); // đổi tên thì được
  assert.equal((await s.api('manager', 'DELETE', `/box-templates/${t.json.id}`)).status, 200);
  const row = s.db.prepare('SELECT template_id, rows, cols FROM nhm_boxes WHERE id = ?').get(hop.json.ids[0]);
  assert.deepEqual(row, { template_id: null, rows: 8, cols: 10 }); // hộp giữ nguyên kích thước
});

test('loại mẫu: thêm, sửa tên, không xóa khi còn mẫu (kể cả mẫu đã hủy), xóa được khi không ai dùng', async () => {
  const loai = await s.api('manager', 'POST', '/sample-types', { name: 'Plasmid' });
  assert.equal(loai.status, 201);
  const m = await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 1, name: 'pUC19', sample_type_id: loai.json.id });
  assert.equal(m.status, 201);
  assert.equal((await s.api('manager', 'DELETE', `/sample-types/${loai.json.id}`)).status, 409);
  await s.api('alice', 'POST', `/tubes/${m.json.id}/discard`);
  assert.equal((await s.api('manager', 'DELETE', `/sample-types/${loai.json.id}`)).status, 409); // mẫu đã hủy vẫn tham chiếu
  assert.equal((await s.api('manager', 'PATCH', `/sample-types/${loai.json.id}`, { name: 'Plasmid DNA' })).status, 200);
  const rong = await s.api('manager', 'POST', '/sample-types', { name: 'Không ai dùng' });
  assert.equal((await s.api('manager', 'DELETE', `/sample-types/${rong.json.id}`)).status, 200);
});

test('danh mục ghi nhật ký hoạt động', async () => {
  const acts = new Set(s.auditLog.map((a) => a.action));
  for (const a of ['nhm_container_types_create', 'nhm_box_templates_update', 'nhm_sample_types_delete']) assert.ok(acts.has(a), a);
});

test('dữ liệu mặc định chỉ nạp một lần: mục đã xóa không quay lại khi chạy lại schema', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'ngan_hang_te_bao_khang_the_schema.sql'), 'utf8');
  const db = new Database(':memory:');
  db.exec(schema);
  const n0 = db.prepare('SELECT COUNT(*) AS c FROM nhm_sample_types').get().c;
  assert.equal(n0, 7);
  db.prepare("DELETE FROM nhm_sample_types WHERE name = 'Khác'").run();
  db.exec(schema);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM nhm_sample_types').get().c, 6);
  db.close();
});
