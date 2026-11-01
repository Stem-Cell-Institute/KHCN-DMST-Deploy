'use strict';

// Hai ngân hàng (tế bào / kháng thể) trong một module: dùng chung tài khoản, tách thiết bị, mẫu, người quản lý, đơn vị.
// Ngân hàng không chọn bị ẩn hoàn toàn (kể cả với admin); quản lý theo ngân hàng; Ab-bank là đơn vị của ngân hàng kháng thể.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;
let tbKt; // thiết bị ở ngân hàng kháng thể
let hopKt;
let mauKt;

const TB = undefined; // ngân hàng tế bào (mặc định, không gửi header)
const KT = 'khang_the';

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho(); // thiết bị + 2 hộp ở ngân hàng tế bào
});
test.after(() => s.dong());

test('mặc định là ngân hàng tế bào; header sai bị từ chối; /banks cho cả hai ngân hàng', async () => {
  assert.equal((await s.api('alice', 'GET', '/tree', null, 'khong_co')).status, 400);
  const ban = (await s.api('alice', 'GET', '/banks')).json;
  assert.equal(ban.hien_tai, 'te_bao');
  assert.deepEqual(ban.ngan_hang.map((b) => b.ma), ['te_bao', 'khang_the']);
  assert.equal(ban.ngan_hang[0].ten, 'Ngân hàng tế bào');
  assert.equal(ban.ngan_hang[0].thiet_bi, 1);
  assert.equal(ban.ngan_hang[1].thiet_bi, 0);
  assert.equal(ban.ngan_hang[0].la_quan_ly, false);
  assert.equal((await s.api('manager', 'GET', '/banks')).json.ngan_hang.every((b) => b.la_quan_ly), true, 'quản lý cũ (không ghi phạm vi) quản lý cả hai');
});

test('thiết bị tạo ở ngân hàng kháng thể: tế bào không thấy; kháng thể không thấy thiết bị tế bào; admin cũng chỉ thấy ngân hàng đang chọn', async () => {
  const r = await s.api('manager', 'POST', '/containers', { name: 'Tủ kháng thể 1', type_id: kho.type }, KT);
  assert.equal(r.status, 201);
  tbKt = r.json.id;
  const hop = await s.api('manager', 'POST', '/boxes', { container_id: tbKt, template_id: kho.tpl99, name: 'Hộp KT' }, KT);
  assert.equal(hop.status, 201);
  hopKt = hop.json.ids[0];
  const m = await s.api('alice', 'POST', '/tubes', { box_id: hopKt, row_no: 1, col_no: 1, name: 'Kháng thể anti-CD34', chu_loai: 'can_bo' }, KT);
  assert.equal(m.status, 201);
  mauKt = m.json.id;

  const ten = async (u, nh) => (await s.api(u, 'GET', '/tree', null, nh)).json.containers.map((c) => c.name);
  assert.ok((await ten('alice', KT)).includes('Tủ kháng thể 1'));
  assert.ok(!(await ten('alice', KT)).includes('Tủ test'), 'ngân hàng kháng thể không thấy thiết bị tế bào');
  assert.ok(!(await ten('alice', TB)).includes('Tủ kháng thể 1'), 'ngân hàng tế bào không thấy thiết bị kháng thể');
  assert.ok(!(await ten('admin', TB)).includes('Tủ kháng thể 1'), 'admin cũng chỉ thấy ngân hàng đang chọn');
  assert.ok((await ten('admin', KT)).includes('Tủ kháng thể 1'));

  // truy cập chéo ngân hàng theo id: 404 như không tồn tại; tìm kiếm không lẫn
  assert.equal((await s.api('alice', 'GET', `/boxes/${hopKt}`, null, TB)).status, 404);
  assert.equal((await s.api('alice', 'GET', `/boxes/${hopKt}`, null, KT)).status, 200);
  assert.equal((await s.api('alice', 'GET', `/tubes/${mauKt}/history`, null, TB)).status, 404);
  assert.equal((await s.api('alice', 'GET', '/tubes/search?q=CD34&status=all', null, TB)).json.total, 0);
  assert.equal((await s.api('alice', 'GET', '/tubes/search?q=CD34&status=all', null, KT)).json.total, 1);
  // không ghi chéo: thêm mẫu vào hộp của ngân hàng khác, hoặc di chuyển mẫu sang đó
  assert.equal((await s.api('alice', 'POST', '/tubes', { box_id: hopKt, row_no: 2, col_no: 2, name: 'chéo', chu_loai: 'can_bo' }, TB)).status, 404);
  assert.equal((await s.api('alice', 'POST', `/tubes/${mauKt}/move`, { box_id: kho.box, row_no: 3, col_no: 3 }, KT)).status, 404, 'không chuyển mẫu sang hộp của ngân hàng khác');
  const ban = (await s.api('alice', 'GET', '/banks')).json.ngan_hang;
  assert.equal(ban[1].thiet_bi, 1);
  assert.equal(ban[1].mau, 1);
});

test('quản lý theo ngân hàng: cấp Quản lý kháng thể cho alice thì chỉ quản lý được ngân hàng kháng thể', async () => {
  assert.equal((await s.api('manager', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly', ngan_hang: KT })).status, 403, 'chỉ admin cấp');
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly', ngan_hang: 'xyz' })).status, 400);
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 3, vai_tro: 'truong_cellbank', ngan_hang: KT })).status, 400, 'phạm vi chỉ có ở Quản lý');
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly', ngan_hang: KT })).status, 201);
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly', ngan_hang: KT })).status, 409, 'trùng vai trò cùng ngân hàng');
  assert.equal((await s.api('alice', 'GET', '/meta', null, KT)).json.canManage, true);
  assert.equal((await s.api('alice', 'GET', '/meta', null, TB)).json.canManage, false, 'không quản lý ngân hàng tế bào');
  assert.equal((await s.api('alice', 'POST', '/containers', { name: 'Tủ KT của alice', type_id: kho.type }, KT)).status, 201);
  assert.equal((await s.api('alice', 'POST', '/containers', { name: 'Tủ TB của alice', type_id: kho.type }, TB)).status, 403);
  assert.equal((await s.api('alice', 'GET', '/units', null, KT)).status, 200);
  assert.equal((await s.api('alice', 'GET', '/units', null, TB)).status, 403);
  // cùng vai trò ở ngân hàng còn lại là bản ghi khác
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly', ngan_hang: 'te_bao' })).status, 201);
  assert.equal((await s.api('alice', 'GET', '/meta', null, TB)).json.canManage, true);
});

test('đơn vị theo ngân hàng: Ab-bank của ngân hàng kháng thể, Cellbank của ngân hàng tế bào', async () => {
  const donVi = async (nh) => (await s.api('manager', 'GET', '/units', null, nh)).json.units;
  assert.deepEqual((await donVi(TB)).map((u) => u.ma), ['cellbank']);
  assert.deepEqual((await donVi(KT)).map((u) => u.ma), ['ab-bank']);
  assert.deepEqual((await s.api('bob', 'GET', '/meta', null, KT)).json.donVi.map((d) => d.ten), ['Ab-bank']);
  const ab = (await donVi(KT))[0];
  const cb = (await donVi(TB))[0];
  assert.equal(ab.mac_dinh, true);
  assert.equal((await s.api('admin', 'DELETE', `/units/${ab.id}`, null, KT)).status, 400, 'Ab-bank không xóa được');
  assert.equal((await s.api('admin', 'DELETE', `/units/${ab.id}`, null, TB)).status, 404, 'đơn vị của ngân hàng khác như không có');
  // gắn đơn vị đúng ngân hàng
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tbKt}`, { don_vi_id: cb.id }, KT)).status, 400, 'thiết bị kháng thể không gắn Cellbank');
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tbKt}`, { don_vi_id: ab.id }, KT)).status, 200);
  // đơn vị mới tạo thuộc ngân hàng đang chọn
  const moi = await s.api('admin', 'POST', '/units', { ten: 'Phòng Ab phụ' }, KT);
  assert.equal(moi.status, 201);
  assert.ok((await donVi(KT)).some((u) => u.ten === 'Phòng Ab phụ'));
  assert.ok(!(await donVi(TB)).some((u) => u.ten === 'Phòng Ab phụ'));
});

test('yêu cầu ở ngân hàng kháng thể: người duyệt Ab-bank; chưa có người duyệt thì quản lý đúng ngân hàng; thư ghi tên ngân hàng', async () => {
  const ab = (await s.api('manager', 'GET', '/units', null, KT)).json.units.find((u) => u.ma === 'ab-bank');
  // chưa có người duyệt → quản lý kháng thể (alice được cấp cả hai ngân hàng ở test trên; manager cấp cả hai từ đầu)
  s.mails.length = 0;
  const r1 = await s.api('bob', 'POST', `/tubes/${mauKt}/requests`, { ly_do: 'Cần dùng' }, KT);
  assert.equal(r1.status, 201);
  assert.equal(r1.json.cap, 'quan_ly');
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(s.mails.length >= 1 && s.mails.every((m) => m.subject.startsWith('[Ngân hàng kháng thể]')), 'tiêu đề thư ghi ngân hàng kháng thể');
  assert.equal((await s.api('bob', 'POST', `/requests/${r1.json.id}/cancel`, null, KT)).status, 200);
  // gán người duyệt Ab-bank (user 6)
  assert.equal((await s.api('admin', 'PATCH', `/units/${ab.id}`, { nguoi_duyet: [6] }, KT)).status, 200);
  const r2 = await s.api('bob', 'POST', `/tubes/${mauKt}/requests`, { ly_do: 'Lần hai' }, KT);
  assert.equal(r2.json.cap, 'truong_cellbank');
  assert.equal(r2.json.cap_ten, 'Ab-bank');
  assert.equal((await s.api('truong', 'POST', `/requests/${r2.json.id}/approve`, {}, KT)).status, 200);
  // yêu cầu thuộc ngân hàng kháng thể: không hiện ở ngân hàng tế bào
  assert.equal((await s.api('truong', 'GET', '/requests?view=done', null, TB)).json.requests.some((y) => y.id === r2.json.id), false);
  assert.equal((await s.api('bob', 'GET', `/requests/${r2.json.id}/print`, null, TB)).status, 404);
  const p = await fetch(`${s.base}/requests/${r2.json.id}/print?nh=khang_the`, { headers: { 'x-test-user': 'bob' } });
  assert.equal(p.status, 200);
  assert.match(await p.text(), /Ngân hàng kháng thể/);
});
