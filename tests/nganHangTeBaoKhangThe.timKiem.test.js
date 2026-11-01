'use strict';

// Tìm mẫu xuyên kho, xuất CSV kiểm kê, thêm hàng loạt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  const loai = kho.meta.sampleTypes.find((x) => x.name === 'Kháng thể').id;
  const mau = [
    ['alice', 1, 1, { name: 'HEK293 P12', barcode: 'BC-100', project: 'Đề tài A', sample_type_id: loai }],
    ['alice', 1, 2, { name: 'HEK293 P13', project: 'Đề tài A' }],
    ['bob', 2, 1, { name: 'MSC dây rốn', project: '50% đề tài_B' }],
    ['bob', 2, 2, { name: '=CMD("calc")', notes: 'có "dấu nháy", phẩy' }],
  ];
  for (const [u, r, c, extra] of mau) {
    const x = await s.api(u, 'POST', '/tubes', { box_id: kho.box, row_no: r, col_no: c, ...extra });
    assert.equal(x.status, 201, JSON.stringify(x.json));
  }
});
test.after(() => s.dong());

const tim = (qs, user = 'alice') => s.api(user, 'GET', '/tubes/search' + qs);

test('tìm mẫu: cần đăng nhập; theo tên, mã vạch, đề tài; không phân biệt hoa thường', async () => {
  assert.equal((await tim('', null)).status, 401);
  assert.equal((await tim('?q=hek')).json.total, 2);
  assert.equal((await tim('?q=bc-100')).json.items[0].name, 'HEK293 P12');
  assert.equal((await tim('?q=' + encodeURIComponent('đề tài a'))).json.total, 0); // LIKE của SQLite không bỏ dấu / hoa thường Unicode
  assert.equal((await tim('?q=' + encodeURIComponent('Đề tài A'))).json.total, 2);
});

test('tìm mẫu: ký tự % và _ được coi là chữ thường, không phải ký tự đại diện', async () => {
  assert.equal((await tim('?q=' + encodeURIComponent('%'))).json.total, 1);
  assert.equal((await tim('?q=' + encodeURIComponent('_'))).json.total, 1);
  assert.equal((await tim('?q=' + encodeURIComponent('50% đề tài_B'))).json.total, 1);
});

test('tìm mẫu: kết quả có vị trí đầy đủ (đường dẫn, hộp, ô) và người sở hữu', async () => {
  const r = (await tim('?q=MSC')).json.items[0];
  assert.deepEqual(r.path, ['Tủ test']);
  assert.equal(r.box_code.startsWith('HOP-'), true);
  assert.equal(r.row_no, 2);
  assert.equal(r.owner_name, 'bob@sci.edu.vn');
});

test('tìm mẫu: lọc theo loại mẫu, người sở hữu (me / id), hộp; tham số sai bị 400', async () => {
  const loai = kho.meta.sampleTypes.find((x) => x.name === 'Kháng thể').id;
  assert.equal((await tim(`?sample_type_id=${loai}`)).json.total, 1);
  assert.equal((await tim('?owner=me', 'bob')).json.total, 2);
  assert.equal((await tim('?owner=3')).json.total, 2);
  assert.equal((await tim(`?box_id=${kho.box2}`)).json.total, 0);
  for (const bad of ['?status=bậy', '?sample_type_id=abc', '?owner=ai', '?box_id=x']) assert.equal((await tim(bad)).status, 400, bad);
});

test('tìm mẫu: mặc định chỉ mẫu còn trong kho; status=all thấy cả mẫu đã rã đông / hủy', async () => {
  const id = (await tim('?q=MSC')).json.items[0].id;
  await s.api('bob', 'POST', `/tubes/${id}/thaw`);
  assert.equal((await tim('?q=MSC')).json.total, 0);
  assert.equal((await tim('?q=MSC&status=thawed')).json.total, 1);
  assert.equal((await tim('?q=MSC&status=all')).json.items[0].status, 'thawed');
  assert.equal((await tim('?q=MSC&status=in_storage')).json.total, 0);
});

test('tìm mẫu: phân trang và trần limit', async () => {
  const p1 = (await tim('?limit=2&offset=0')).json;
  const p2 = (await tim('?limit=2&offset=2')).json;
  assert.equal(p1.items.length, 2);
  assert.equal(p1.total, 3);
  assert.equal(p2.items.length, 1);
  assert.notEqual(p1.items[0].id, p2.items[0].id);
  assert.equal((await tim('?limit=99999')).json.limit, 200);
});

test('xuất CSV: chỉ quản lý; có BOM, tiêu đề, thoát dấu nháy / phẩy và chặn chèn công thức', async () => {
  assert.equal((await s.api(null, 'GET', '/tubes/export.csv')).status, 401);
  assert.equal((await s.api('alice', 'GET', '/tubes/export.csv')).status, 403);
  const r = await s.api('manager', 'GET', '/tubes/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.ok(r.text.startsWith('﻿Mã nội bộ,Tên mẫu'));
  assert.ok(r.text.includes(`"'=CMD(""calc"")"`), 'công thức bị vô hiệu bằng dấu nháy đơn');
  assert.ok(r.text.includes('"có ""dấu nháy"", phẩy"'));
  assert.ok(r.text.includes('Tủ test'));
  assert.ok(r.text.includes('A1')); // nhãn ô
  assert.equal(r.text.trim().split('\r\n').length, 4); // tiêu đề + 3 mẫu còn trong kho
  assert.equal((await s.api('manager', 'GET', '/tubes/export.csv?status=bậy')).status, 400);
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_tube_export'));
});

test('thêm hàng loạt: đặt vào các ô liên tiếp, sang hàng kế khi hết cột, sinh mã vạch', async () => {
  const r = await s.api('alice', 'POST', '/tubes/bulk', {
    box_id: kho.box2, row_no: 1, col_no: 8, count: 4, name: 'Lô HeLa', barcode_prefix: 'HELA-', barcode_start: 5, passage: 'P3',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.ids.length, 4);
  const hop = (await s.api('alice', 'GET', `/boxes/${kho.box2}`)).json.tubes;
  const vt = hop.map((t) => `${t.row_no},${t.col_no}`).sort();
  assert.deepEqual(vt, ['1,8', '1,9', '2,1', '2,2']);
  assert.deepEqual(hop.map((t) => t.barcode).sort(), ['HELA-005', 'HELA-006', 'HELA-007', 'HELA-008']);
  assert.ok(hop.every((t) => t.owner_user_id === 3 && t.passage === 'P3'));
  const h = (await s.api('alice', 'GET', `/tubes/${r.json.ids[0]}/history`)).json.history;
  assert.equal(h[0].action, 'store');
});

test('thêm hàng loạt: tất cả hoặc không — ô bị chiếm, vượt lưới, đầu vào sai đều không thêm mẫu nào', async () => {
  const dem = () => s.db.prepare('SELECT COUNT(*) AS c FROM nhm_tubes').get().c;
  const n0 = dem();
  const goc = { box_id: kho.box, row_no: 1, col_no: 1, name: 'x' };
  const chiem = await s.api('alice', 'POST', '/tubes/bulk', { ...goc, row_no: 1, col_no: 8, count: 5 }); // đi qua ô 2,2 đã có mẫu
  assert.equal(chiem.status, 409);
  assert.match(chiem.json.message, /ô /);
  assert.equal((await s.api('alice', 'POST', '/tubes/bulk', { ...goc, row_no: 9, col_no: 8, count: 5 })).status, 400); // hết lưới
  assert.equal((await s.api('alice', 'POST', '/tubes/bulk', { ...goc, count: 0 })).status, 400);
  assert.equal((await s.api('alice', 'POST', '/tubes/bulk', { ...goc, count: 101 })).status, 400);
  assert.equal((await s.api('alice', 'POST', '/tubes/bulk', { ...goc, row_no: 4, col_no: 1, count: 2, name: '' })).status, 400);
  assert.equal((await s.api('alice', 'POST', '/tubes/bulk', { ...goc, row_no: 4, col_no: 1, count: 2, cell_count: 'abc' })).status, 400);
  assert.equal((await s.api(null, 'POST', '/tubes/bulk', { ...goc, count: 2 })).status, 401);
  // mã vạch sinh ra trùng mã đã có => 409 và rollback toàn bộ
  const trung = await s.api('alice', 'POST', '/tubes/bulk', { ...goc, row_no: 5, col_no: 1, count: 3, barcode_prefix: 'BC-', barcode_start: 100 });
  assert.equal(trung.status, 409);
  assert.equal(dem(), n0);
});
