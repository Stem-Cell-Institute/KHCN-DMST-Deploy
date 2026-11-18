'use strict';

// Kiểm tra đầu vào của module Ngân hàng Tế bào & Kháng thể: số, ngày, nhiệt độ, mã tự sinh, mẫu hộp.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

const mau = (extra) => ({ box_id: kho.box, row_no: 1, col_no: 1, name: 'M', ...extra });

test('mẫu: số tế bào / thể tích sai hoặc âm bị 400, không nuốt im lặng', async () => {
  for (const bad of [{ cell_count: 'abc' }, { cell_count: -1 }, { volume_ml: 'x1' }, { volume_ml: -0.5 }, { cell_count: true }, { volume_ml: [] }]) {
    const r = await s.api('alice', 'POST', '/tubes', mau(bad));
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.json.message, /không hợp lệ/);
  }
  const ok = await s.api('alice', 'POST', '/tubes', mau({ cell_count: '1000000', volume_ml: 1.5 }));
  assert.equal(ok.status, 201);
  s.tubeId = ok.json.id;
  // trống => null, không phải lỗi
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${s.tubeId}`, { cell_count: '', volume_ml: null })).status, 200);
});

test('mẫu: ngày đông lạnh phải đúng YYYY-MM-DD và có thật', async () => {
  for (const bad of ['2026-13-01', '2026-02-30', '20/10/2026', 'hôm qua', '2026-1-5']) {
    const r = await s.api('alice', 'PATCH', `/tubes/${s.tubeId}`, { freeze_date: bad });
    assert.equal(r.status, 400, bad);
    assert.match(r.json.message, /Ngày đông lạnh/);
  }
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${s.tubeId}`, { freeze_date: '2026-02-28' })).status, 200);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${s.tubeId}`, { freeze_date: '' })).status, 200);
});

test('vị trí: null / chuỗi rỗng / true không bị coi là số 0 hay 1', async () => {
  for (const bad of [{ row_no: null }, { row_no: '' }, { col_no: true }, { row_no: 1.5 }, { box_id: '' }]) {
    const r = await s.api('alice', 'POST', '/tubes', mau({ col_no: 2, ...bad }));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  // số nguyên dạng chuỗi vẫn được (giao diện gửi chuỗi)
  assert.equal((await s.api('alice', 'POST', '/tubes', mau({ row_no: '2', col_no: '2' }))).status, 201);
});

test('vật chứa: nhiệt độ ngoài khoảng vật lý hoặc không phải số bị 400', async () => {
  for (const bad of ['lạnh', -300, 500]) {
    const r = await s.api('manager', 'POST', '/containers', { name: 'T', type_id: kho.type, temperature_c: bad });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.json.message, /Nhiệt độ/);
  }
  const ok = await s.api('manager', 'POST', '/containers', { name: 'T', type_id: kho.type, temperature_c: -196 });
  assert.equal(ok.status, 201);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${ok.json.id}`, { temperature_c: 'abc' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${ok.json.id}`, { sort_order: 'x' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${ok.json.id}`, { sort_order: '3' })).status, 200);
});

test('mã tự sinh bỏ qua mã đã được đặt tay; tạo hàng loạt không bị rollback', async () => {
  const next = s.db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM nhm_boxes').get().n;
  const taken = 'HOP-' + String(next).padStart(4, '0');
  const t = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, code: taken });
  assert.equal(t.status, 201);
  const bulk = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, count: 3 });
  assert.equal(bulk.status, 201);
  assert.equal(bulk.json.ids.length, 3);
  const codes = s.db.prepare(`SELECT code FROM nhm_boxes WHERE id IN (${bulk.json.ids.join(',')})`).all().map((r) => r.code);
  assert.ok(!codes.includes(taken));
  assert.equal(new Set(codes).size, 3);
});

test('đổi kích thước hộp thì bỏ liên kết mẫu hộp; đổi tên thì giữ', async () => {
  const before = s.db.prepare('SELECT template_id FROM nhm_boxes WHERE id = ?').get(kho.box2);
  assert.equal(before.template_id, kho.tpl99);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${kho.box2}`, { name: 'Đổi tên' })).status, 200);
  assert.equal(s.db.prepare('SELECT template_id FROM nhm_boxes WHERE id = ?').get(kho.box2).template_id, kho.tpl99);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${kho.box2}`, { rows: 9, cols: 9 })).status, 200);
  assert.equal(s.db.prepare('SELECT template_id FROM nhm_boxes WHERE id = ?').get(kho.box2).template_id, kho.tpl99);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${kho.box2}`, { rows: 8, cols: 12 })).status, 200);
  assert.equal(s.db.prepare('SELECT template_id FROM nhm_boxes WHERE id = ?').get(kho.box2).template_id, null);
});
