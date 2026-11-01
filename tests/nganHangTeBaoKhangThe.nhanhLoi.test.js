'use strict';

// Các nhánh lỗi / biên còn thiếu của module: 404, trùng mã khi sửa, hộp đã xóa, xóa hai lần, đầu vào không phải JSON object.

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

test('vật chứa: sửa thành công (tên, đổi cha hợp lệ), trùng mã 409, mã / tên trống 400, không tồn tại 404', async () => {
  const a = await s.api('manager', 'POST', '/containers', { name: 'Tủ A', type_id: kho.type, code: 'MA-A' });
  const b = await s.api('manager', 'POST', '/containers', { name: 'Tủ B', type_id: kho.type, code: 'MA-B' });
  assert.equal((await s.api('manager', 'PATCH', `/containers/${a.json.id}`, { name: 'Tủ A mới', parent_id: b.json.id })).status, 200);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${a.json.id}`, { parent_id: null })).status, 200); // đưa về gốc
  assert.equal((await s.api('manager', 'PATCH', `/containers/${a.json.id}`, { code: 'MA-B' })).status, 409);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${a.json.id}`, { code: '' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${a.json.id}`, { name: '  ' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${a.json.id}`, { type_id: 99999 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${a.json.id}`, { parent_id: 99999 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', '/containers/99999', { name: 'x' })).status, 404);
  assert.equal((await s.api('manager', 'DELETE', '/containers/99999')).status, 404);
  assert.equal((await s.api('manager', 'PATCH', '/containers/abc', { name: 'x' })).status, 404);
});

test('hộp: sửa mã trùng 409, đổi sang vật chứa không tồn tại 400, kích thước sai 400, 404', async () => {
  const x = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, code: 'BOX-X' });
  const y = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, code: 'BOX-Y' });
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${x.json.ids[0]}`, { code: 'BOX-Y' })).status, 409);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${x.json.ids[0]}`, { code: '' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${x.json.ids[0]}`, { container_id: 99999 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${x.json.ids[0]}`, { rows: 0 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${x.json.ids[0]}`, { cols: 31 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${x.json.ids[0]}`, {})).status, 400);
  assert.equal((await s.api('manager', 'PATCH', '/boxes/99999', { name: 'x' })).status, 404);
  assert.equal((await s.api('alice', 'GET', '/boxes/99999')).status, 404);
  assert.equal((await s.api('manager', 'DELETE', `/boxes/${y.json.ids[0]}`)).status, 200);
  assert.equal((await s.api('manager', 'DELETE', `/boxes/${y.json.ids[0]}`)).status, 404); // đã xóa
  assert.equal((await s.api('alice', 'GET', `/boxes/${y.json.ids[0]}`)).status, 404);
  assert.equal((await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: 99999 })).status, 400);
  assert.equal((await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, code: 'C', count: 2 })).status, 400);
});

test('mẫu: loại mẫu sai khi sửa 400, mã vạch trùng khi sửa 409, mã vạch rỗng thì xóa mã', async () => {
  const a = await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 1, name: 'A', barcode: 'MV-1' });
  const b = await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 2, name: 'B' });
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${b.json.id}`, { sample_type_id: 99999 })).status, 400);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${b.json.id}`, { barcode: 'MV-1' })).status, 409);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${a.json.id}`, { barcode: '' })).status, 200);
  assert.equal(s.db.prepare('SELECT barcode FROM nhm_tubes WHERE id = ?').get(a.json.id).barcode, null);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${b.json.id}`, {})).status, 400);
  assert.equal((await s.api('alice', 'PATCH', '/tubes/99999', { name: 'x' })).status, 404);
  assert.equal((await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 3, col_no: 3, name: 'L', sample_type_id: 99999 })).status, 400);
});

test('di chuyển: hộp đích đã xóa hoặc không tồn tại bị 400; mẫu không tồn tại 404', async () => {
  const t = await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 4, col_no: 1, name: 'Đi' });
  const hop = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99 });
  await s.api('manager', 'DELETE', `/boxes/${hop.json.ids[0]}`);
  assert.equal((await s.api('alice', 'POST', `/tubes/${t.json.id}/move`, { box_id: hop.json.ids[0], row_no: 1, col_no: 1 })).status, 400);
  assert.equal((await s.api('alice', 'POST', `/tubes/${t.json.id}/move`, { box_id: 99999, row_no: 1, col_no: 1 })).status, 400);
  assert.equal((await s.api('alice', 'POST', `/tubes/${t.json.id}/move`, {})).status, 400);
  assert.equal((await s.api('alice', 'POST', '/tubes/99999/move', { box_id: kho.box, row_no: 1, col_no: 1 })).status, 404);
});

test('xóa mẫu hai lần: lần hai 404; lịch sử mẫu đã xóa vẫn đọc được; mẫu không tồn tại 404', async () => {
  const t = await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 5, col_no: 1, name: 'Xóa' });
  assert.equal((await s.api('alice', 'DELETE', `/tubes/${t.json.id}`)).status, 200);
  assert.equal((await s.api('alice', 'DELETE', `/tubes/${t.json.id}`)).status, 404);
  assert.equal((await s.api('alice', 'GET', `/tubes/${t.json.id}/history`)).status, 200);
  assert.equal((await s.api('alice', 'GET', '/tubes/99999/history')).status, 404);
  assert.equal((await s.api('alice', 'POST', `/tubes/${t.json.id}/checkout`)).status, 404); // mẫu đã xóa không còn thao tác được
});

test('thân yêu cầu không phải đối tượng JSON (mảng, chuỗi) không làm sập — trả 400, không 500', async () => {
  for (const body of [[], 'abc', 123]) {
    const res = await fetch(`${s.base}/containers`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'manager' }, body: JSON.stringify(body) });
    assert.ok(res.status === 400, `body ${JSON.stringify(body)} → ${res.status}`);
  }
});
