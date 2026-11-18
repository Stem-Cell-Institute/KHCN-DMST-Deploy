'use strict';

// Bình nitơ lỏng: giá (rack) đánh số vị trí trong bình, hộp đánh số vị trí trong giá (1–50), không trùng số,
// cây kho trả vị trí số để giao diện vẽ mô hình bình.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;
let binh;
let giaType;

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  giaType = kho.meta.containerTypes.find((t) => /^Rack$/.test(t.name)).id;
  const nito = kho.meta.containerTypes.find((t) => /nitơ/i.test(t.name)).id;
  binh = (await s.api('manager', 'POST', '/containers', { name: 'Bình LN test', type_id: nito })).json.id;
});
test.after(() => s.dong());

const taoGia = (viTri, extra) => s.api('manager', 'POST', '/containers', { name: `Giá ${viTri}`, type_id: giaType, parent_id: binh, vi_tri: viTri, ...extra });
const taoHop = (giaId, viTri, extra) => s.api('manager', 'POST', '/boxes', { container_id: giaId, template_id: kho.tpl99, vi_tri: viTri, ...extra });

test('giá trong bình có vị trí số 1–50, không trùng số trong cùng bình', async () => {
  assert.equal((await taoGia(0)).status, 400);
  assert.equal((await taoGia(51)).status, 400);
  const g1 = await taoGia(1);
  assert.equal(g1.status, 201);
  assert.equal((await taoGia(1)).status, 409, 'trùng số giá');
  const g2 = await taoGia(2);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${g2.json.id}`, { vi_tri: 1 })).status, 409, 'đổi sang số đã có');
  assert.equal((await s.api('manager', 'PATCH', `/containers/${g2.json.id}`, { vi_tri: 3 })).status, 200);
  assert.equal((await s.api('alice', 'POST', '/containers', { name: 'x', type_id: giaType, parent_id: binh, vi_tri: 4 })).status, 403, 'chỉ quản lý module');
});

test('hộp trong giá: khai vị trí số thay cho số lượng; không trùng; sửa được; tối đa 50', async () => {
  const g = (await taoGia(10)).json.id;
  assert.equal((await taoHop(g, 1)).status, 201);
  assert.equal((await taoHop(g, 1)).status, 409, 'trùng vị trí hộp');
  assert.equal((await taoHop(g, 51)).status, 400);
  assert.equal((await taoHop(g, 0)).status, 400);
  assert.equal((await taoHop(g, 2, { count: 3 })).status, 400, 'khai vị trí số thì thêm từng hộp một');
  const h50 = await taoHop(g, 50);
  assert.equal(h50.status, 201);
  const b = (await s.api('manager', 'GET', '/tree')).json.boxes.filter((x) => x.container_id === g);
  assert.deepEqual(b.map((x) => x.vi_tri).sort((a, c) => a - c), [1, 50]);
  const id50 = h50.json.ids[0];
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${id50}`, { vi_tri: 1 })).status, 409);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${id50}`, { vi_tri: 7 })).status, 200);
  // cùng số ở giá khác thì được
  const g2 = (await taoGia(11)).json.id;
  assert.equal((await taoHop(g2, 7)).status, 201);
});

test('không khai vị trí số thì vẫn thêm nhiều hộp như cũ; cây kho trả vi_tri của giá và hộp', async () => {
  const r = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, count: 3 });
  assert.equal(r.status, 201);
  assert.equal(r.json.ids.length, 3);
  const t = (await s.api('alice', 'GET', '/tree')).json;
  assert.ok(t.containers.some((c) => c.id === binh && c.vi_tri === null));
  assert.ok(t.containers.some((c) => c.parent_id === binh && c.vi_tri === 1));
  assert.ok(t.boxes.every((x) => 'vi_tri' in x));
});
