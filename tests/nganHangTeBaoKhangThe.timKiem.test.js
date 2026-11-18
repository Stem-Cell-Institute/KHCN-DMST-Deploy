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
    ['alice', 1, 1, { name: 'HEK293 P12', project: 'Đề tài A', sample_type_id: loai }],
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

test('tìm mẫu: cần đăng nhập; theo tên, đề tài; không phân biệt hoa thường', async () => {
  assert.equal((await tim('', null)).status, 401);
  assert.equal((await tim('?q=hek')).json.total, 2);
  // bỏ dấu, không phân biệt hoa thường: ba cách gõ cho cùng một kết quả (mỗi từ khớp ở một trường bất kỳ nên từ «a» khớp rộng)
  const ba = [];
  for (const q of ['đề tài a', 'DE TAI A', 'Đề tài A']) ba.push((await tim('?q=' + encodeURIComponent(q))).json.total);
  assert.equal(new Set(ba).size, 1);
  assert.ok(ba[0] >= 2);
  assert.equal((await tim('?q=' + encodeURIComponent('hek de tai a'))).json.total, 2);
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
  await s.api('bob', 'POST', `/tubes/${id}/thaw`, { note: 'Ghi thao tác thử' });
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

test('thêm hàng loạt: đặt vào các ô liên tiếp, sang hàng kế khi hết cột', async () => {
  const r = await s.api('alice', 'POST', '/tubes/bulk', {
    box_id: kho.box2, row_no: 1, col_no: 8, count: 4, name: 'Lô HeLa', passage: 'P3',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.ids.length, 4);
  const hop = (await s.api('alice', 'GET', `/boxes/${kho.box2}`)).json.tubes;
  const vt = hop.map((t) => `${t.row_no},${t.col_no}`).sort();
  assert.deepEqual(vt, ['1,8', '1,9', '2,1', '2,2']);
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
  assert.equal(dem(), n0, 'không có lỗi nào để lại mẫu dở dang');
});

test('tìm mẫu theo MỌI trường: loại mẫu, người sở hữu, đường dẫn, hộp, ô, trạng thái, loại chủ, ngày, passage, ghi chú', async () => {
  const dem = async (q) => (await tim('?q=' + encodeURIComponent(q))).json.total;
  assert.equal(await dem('khang the'), 1); // loại mẫu «Kháng thể»
  assert.equal(await dem('bob@sci'), 1); // người sở hữu (email); mẫu MSC của bob đã rã đông nên không tính
  const tong = (await tim('')).json.total;
  assert.equal(await dem('tu test'), tong); // đường dẫn tủ
  assert.equal(await dem('hop test'), tong); // tên hộp
  assert.equal(await dem('a9'), 1); // ô A9 (mẫu thêm hàng loạt)
  assert.equal(await dem('can bo'), tong); // loại chủ «Cán bộ» (hồ sơ alice, bob)
  assert.equal(await dem('dang luu kho'), tong); // trạng thái
  assert.equal(await dem('dau nhay'), 1); // ghi chú
  assert.equal(await dem('khong co gi nhu the'), 0);
});

test('tìm nhiều từ: mẫu phải khớp TẤT CẢ các từ, mỗi từ ở một trường bất kỳ', async () => {
  const dem = async (q) => (await tim('?q=' + encodeURIComponent(q))).json.total;
  assert.equal(await dem('hek alice'), 2); // tên + người sở hữu
  assert.equal(await dem('hek bob'), 0);
  assert.equal(await dem('hek p13 de tai a'), 1);
  assert.equal(await dem('   hek    '), 2, 'khoảng trắng thừa không ảnh hưởng');
});

test('lọc theo loại chủ mẫu và nhóm; kết quả có nhóm, trưởng nhóm, loại chủ', async () => {
  const nhom = (await s.api('manager', 'POST', '/groups', { ten: 'Nhóm Tìm Kiếm', truong_user_id: 6 })).json.id;
  const id = (await tim('?q=P13')).json.items[0].id;
  assert.equal((await s.api('manager', 'PATCH', `/tubes/${id}`, { chu_loai: 'sinh_vien', nhom_id: nhom })).status, 200);
  assert.equal((await tim('?chu_loai=sinh_vien')).json.total, 1);
  assert.equal((await tim(`?nhom_id=${nhom}`)).json.items[0].nhom_ten, 'Nhóm Tìm Kiếm');
  assert.equal((await tim('?chu_loai=bậy')).status, 400);
  assert.equal((await tim('?nhom_id=abc')).status, 400);
  const r = (await tim('?q=' + encodeURIComponent('nhom tim kiem sinh vien'))).json;
  assert.equal(r.total, 1);
  assert.equal(r.items[0].truong_ten, 'truong@sci.edu.vn');
  assert.equal((await tim('?q=truong')).json.total, 1, 'tìm theo tên trưởng nhóm');
  const csv = (await s.api('manager', 'GET', '/tubes/export.csv?chu_loai=sinh_vien')).text;
  assert.ok(csv.includes('Sinh viên') && csv.includes('Nhóm Tìm Kiếm') && csv.includes('truong@sci.edu.vn'));
});
