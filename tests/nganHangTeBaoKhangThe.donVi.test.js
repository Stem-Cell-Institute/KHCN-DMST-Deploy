'use strict';

// Đơn vị quản lý thiết bị: chỉ admin tạo / sửa / xóa; thiết bị gắn đơn vị thì người duyệt của đơn vị quyết định;
// bỏ gắn (Public) thì đường duyệt quay về chủ mẫu / trưởng nhóm; cách gọi cũ quan_ly_boi='cellbank' vẫn là đơn vị Cellbank.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;

const cho = () => new Promise((r) => setTimeout(r, 40));
const den = (tieuDe) => s.mails.filter((m) => m.subject.includes(tieuDe)).map((m) => m.to).sort();
const them = (user, box, r, c, extra) => s.api(user, 'POST', '/tubes', { box_id: box, row_no: r, col_no: c, name: `M${r}${c}`, ...extra });
const xin = (user, tubeId) => s.api(user, 'POST', `/tubes/${tubeId}/requests`, { ly_do: 'Cần cho thí nghiệm' });

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

test('đơn vị Cellbank có sẵn; chỉ quản lý xem danh sách, chỉ admin sửa; không xóa được Cellbank', async () => {
  assert.equal((await s.api('alice', 'GET', '/units')).status, 403);
  const ds = (await s.api('manager', 'GET', '/units')).json.units;
  const cb = ds.find((u) => u.ma === 'cellbank');
  assert.ok(cb && cb.mac_dinh);
  assert.deepEqual(cb.nguoi_theo_vai_tro.map((x) => x.user_id), [7], 'Trưởng CIPP là người duyệt của Cellbank theo vai trò');
  assert.equal((await s.api('manager', 'POST', '/units', { ten: 'X' })).status, 403, 'quản lý module không tạo đơn vị');
  assert.equal((await s.api('manager', 'PATCH', `/units/${cb.id}`, { ten: 'Y' })).status, 403);
  assert.equal((await s.api('admin', 'DELETE', `/units/${cb.id}`)).status, 400);
  assert.ok((await s.api('alice', 'GET', '/meta')).json.donVi.some((d) => d.ten === 'Cellbank'), 'ai cũng thấy tên đơn vị để biết thiết bị do ai quản lý');
});

test('tạo đơn vị: kiểm tra tên, trùng tên, người duyệt hợp lệ', async () => {
  assert.equal((await s.api('admin', 'POST', '/units', { ten: '  ' })).status, 400);
  assert.equal((await s.api('admin', 'POST', '/units', { ten: 'Lab X', nguoi_duyet: [999] })).status, 400, 'người duyệt không tồn tại');
  assert.equal((await s.api('admin', 'POST', '/units', { ten: 'Lab X', nguoi_duyet: [8] })).status, 400, 'sinh viên không làm người duyệt');
  assert.equal((await s.api('admin', 'POST', '/units', { ten: 'Lab X', nguoi_duyet: [9] })).status, 400, 'tài khoản bị khóa');
  const r = await s.api('admin', 'POST', '/units', { ten: 'Lab X', mo_ta: 'Phòng lab X', nguoi_duyet: [6] });
  assert.equal(r.status, 201);
  assert.equal((await s.api('admin', 'POST', '/units', { ten: 'lab x' })).status, 409, 'trùng tên (không phân biệt hoa thường)');
  const u = (await s.api('manager', 'GET', '/units')).json.units.find((x) => x.id === r.json.id);
  assert.deepEqual(u.nguoi_duyet.map((x) => x.user_id), [6]);
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_unit_create'));
});

test('thiết bị gắn đơn vị: người duyệt của đơn vị duyệt; người thường không thêm mẫu; Public thì về đường chủ mẫu', async () => {
  const dv = (await s.api('admin', 'POST', '/units', { ten: 'Phòng Lab Duyệt', nguoi_duyet: [6] })).json.id;
  const tb = await s.api('manager', 'POST', '/containers', { name: 'Tủ đơn vị', type_id: kho.type, don_vi_id: dv });
  assert.equal(tb.status, 201);
  const box = (await s.api('manager', 'POST', '/boxes', { container_id: tb.json.id, template_id: kho.tpl99 })).json.ids[0];
  const tree = (await s.api('alice', 'GET', '/tree')).json.containers.find((c) => c.id === tb.json.id);
  assert.equal(tree.don_vi_ten, 'Phòng Lab Duyệt');
  assert.equal(tree.quan_ly_boi, 'cellbank');

  const chan = await them('alice', box, 1, 1, { chu_loai: 'can_bo' });
  assert.equal(chan.status, 403);
  assert.match(chan.json.message, /Phòng Lab Duyệt/, 'báo lỗi nêu đúng tên đơn vị');

  const m = (await them('manager', box, 1, 1, { chu_loai: 'can_bo' })).json.id;
  await s.api('manager', 'POST', `/tubes/${m}/transfer`, { owner_user_id: 3 });
  s.mails.length = 0;
  const r = await xin('bob', m);
  assert.equal(r.json.cap, 'truong_cellbank');
  assert.equal(r.json.cap_ten, 'Người duyệt của Phòng Lab Duyệt');
  await cho();
  assert.deepEqual(den('Yêu cầu lấy mẫu'), ['truong@sci.edu.vn'], 'chỉ người duyệt của đơn vị nhận thư, không phải chủ mẫu hay Trưởng CIPP');
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/approve`)).status, 403, 'chủ mẫu không duyệt thay đơn vị');
  assert.equal((await s.api('cellbank', 'POST', `/requests/${r.json.id}/approve`)).status, 403, 'Trưởng CIPP không duyệt đơn vị khác');
  assert.equal((await s.api('truong', 'POST', `/requests/${r.json.id}/approve`)).status, 200);

  // bỏ gắn đơn vị → Public: yêu cầu đang chờ chuyển về chủ mẫu
  const m2 = (await them('manager', box, 1, 2, { chu_loai: 'can_bo' })).json.id;
  await s.api('manager', 'POST', `/tubes/${m2}/transfer`, { owner_user_id: 3 });
  const r2 = await xin('bob', m2);
  assert.equal(r2.json.cap, 'truong_cellbank');
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tb.json.id}`, { don_vi_id: null })).status, 200);
  const cho2 = (await s.api('alice', 'GET', '/requests?view=inbox')).json.requests.find((x) => x.id === r2.json.id);
  assert.equal(cho2.cap, 'chu_mau', 'đang chờ ở đơn vị thì chuyển về chủ mẫu khi thiết bị thành Public');
  assert.equal((await them('alice', box, 2, 2, { chu_loai: 'can_bo' })).status, 201, 'Public thì ai cũng thêm mẫu được');
});

test('đơn vị không người duyệt → quản lý module; sửa người duyệt; xóa đơn vị chỉ khi không còn thiết bị', async () => {
  const dv = (await s.api('admin', 'POST', '/units', { ten: 'Đơn vị trống' })).json.id;
  const tb = await s.api('manager', 'POST', '/containers', { name: 'Tủ trống', type_id: kho.type, don_vi_id: dv });
  const box = (await s.api('manager', 'POST', '/boxes', { container_id: tb.json.id, template_id: kho.tpl99 })).json.ids[0];
  const m = (await them('manager', box, 1, 1, { chu_loai: 'can_bo' })).json.id;
  assert.equal((await xin('bob', m)).json.cap, 'quan_ly', 'chưa có người duyệt: chuyển thẳng quản lý module');
  assert.equal((await s.api('admin', 'PATCH', `/units/${dv}`, { nguoi_duyet: [3, 6] })).status, 200);
  const u = (await s.api('manager', 'GET', '/units')).json.units.find((x) => x.id === dv);
  assert.deepEqual(u.nguoi_duyet.map((x) => x.user_id).sort(), [3, 6]);
  assert.equal((await s.api('admin', 'DELETE', `/units/${dv}`)).status, 409, 'còn thiết bị thuộc đơn vị');
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tb.json.id}`, { don_vi_id: 99999 })).status, 400, 'đơn vị không tồn tại');
  await s.api('manager', 'PATCH', `/containers/${tb.json.id}`, { don_vi_id: null });
  assert.equal((await s.api('admin', 'DELETE', `/units/${dv}`)).status, 200);
});

test('cách gọi cũ quan_ly_boi=cellbank vẫn là đơn vị Cellbank; vị trí con không tự chọn đơn vị', async () => {
  const cb = (await s.api('manager', 'GET', '/units')).json.units.find((u) => u.ma === 'cellbank');
  const tb = await s.api('manager', 'POST', '/containers', { name: 'Bình cũ', type_id: kho.type, quan_ly_boi: 'cellbank' });
  const c = (await s.api('alice', 'GET', '/tree')).json.containers.find((x) => x.id === tb.json.id);
  assert.equal(c.don_vi_id, cb.id);
  const con = await s.api('manager', 'POST', '/containers', { name: 'Ngăn con', type_id: kho.type, parent_id: tb.json.id });
  const cc = (await s.api('alice', 'GET', '/tree')).json.containers.find((x) => x.id === con.json.id);
  assert.equal(cc.don_vi_ten, 'Cellbank', 'vị trí con thừa hưởng đơn vị của thiết bị gốc');
  assert.equal((await s.api('manager', 'POST', '/containers', { name: 'Con 2', type_id: kho.type, parent_id: tb.json.id, don_vi_id: cb.id })).status, 400);
});
