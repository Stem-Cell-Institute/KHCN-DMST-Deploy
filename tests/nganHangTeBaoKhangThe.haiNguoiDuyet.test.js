'use strict';

// Đơn vị Cellbank có hai người duyệt (Viện trưởng + Trưởng CIPP): cả hai cùng nhận thư và thấy yêu cầu;
// ai xử lý trước thì yêu cầu đóng; người còn lại nhận kết quả và thấy trong lịch sử, không phải làm gì.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let hop;

const cho = () => new Promise((r) => setTimeout(r, 40));
const den = (tieuDe) => s.mails.filter((m) => m.subject.includes(tieuDe)).map((m) => m.to).sort();
const mauMoi = async (r, c) => {
  const id = (await s.api('manager', 'POST', '/tubes', { box_id: hop, row_no: r, col_no: c, name: `H${r}${c}`, chu_loai: 'can_bo' })).json.id;
  await s.api('manager', 'POST', `/tubes/${id}/transfer`, { owner_user_id: 3 });
  return id;
};

test.before(async () => {
  s = await dungServer();
  const kho = await s.taoKho();
  const cb = await s.api('manager', 'POST', '/containers', { name: 'Bình Cellbank', type_id: kho.type, quan_ly_boi: 'cellbank' });
  hop = (await s.api('manager', 'POST', '/boxes', { container_id: cb.json.id, template_id: kho.tpl99 })).json.ids[0];
  // Trưởng CIPP (user 7) giữ vai trò Trưởng CIPP; Viện trưởng (user 6) được admin thêm làm người duyệt của Cellbank
  const dv = (await s.api('manager', 'GET', '/units')).json.units.find((u) => u.ma === 'cellbank');
  assert.equal((await s.api('admin', 'PATCH', `/units/${dv.id}`, { nguoi_duyet: [6] })).status, 200);
});
test.after(() => s.dong());

test('cả hai người duyệt cùng nhận thư và thấy yêu cầu; chủ mẫu không phải người duyệt', async () => {
  const m = await mauMoi(1, 1);
  s.mails.length = 0;
  const r = await s.api('bob', 'POST', `/tubes/${m}/requests`, { ly_do: 'Cần cho thí nghiệm' });
  assert.equal(r.json.cap, 'truong_cellbank');
  await cho();
  assert.deepEqual(den('Yêu cầu lấy mẫu'), ['cellbank@sci.edu.vn', 'truong@sci.edu.vn']);
  for (const u of ['cellbank', 'truong']) {
    const ds = (await s.api(u, 'GET', '/requests?view=inbox')).json.requests;
    assert.ok(ds.some((y) => y.id === r.json.id && y.co_the_xu_ly), `${u} thấy và xử lý được`);
  }
  assert.equal((await s.api('alice', 'GET', '/requests?view=inbox')).json.requests.length, 0, 'chủ mẫu không nằm trong luồng duyệt Cellbank');
});

test('Trưởng CIPP duyệt: yêu cầu đóng, Viện trưởng nhận kết quả và thấy trong lịch sử, không còn trong việc cần xử lý', async () => {
  const m = await mauMoi(1, 2);
  const r = await s.api('bob', 'POST', `/tubes/${m}/requests`, { ly_do: 'Dùng cho flow' });
  s.mails.length = 0;
  assert.equal((await s.api('cellbank', 'POST', `/requests/${r.json.id}/approve`)).status, 200);
  await cho();
  assert.deepEqual(den('Đã duyệt yêu cầu'), ['bob@sci.edu.vn', 'manager@sci.edu.vn', 'truong@sci.edu.vn'], 'người xin, quản lý module và Viện trưởng (giám sát); người vừa duyệt không nhận lại');
  const vt = await s.api('truong', 'GET', '/requests?view=inbox');
  assert.ok(!vt.json.requests.some((y) => y.id === r.json.id), 'Viện trưởng không còn việc phải xử lý');
  assert.equal((await s.api('truong', 'POST', `/requests/${r.json.id}/approve`)).status, 409, 'đã có người xử lý');
  const ls = (await s.api('truong', 'GET', '/requests?view=done')).json.requests.find((y) => y.id === r.json.id);
  assert.ok(ls && ls.trang_thai === 'da_duyet' && ls.co_the_in, 'Viện trưởng xem được kết quả trong lịch sử');
  assert.equal((await s.api('alice', 'GET', '/requests?view=done')).json.requests.some((y) => y.id === r.json.id), false, 'người không liên quan không thấy');
});

test('Viện trưởng xử lý trước thì Trưởng CIPP cũng nhận kết quả (từ chối)', async () => {
  const m = await mauMoi(1, 3);
  const r = await s.api('bob', 'POST', `/tubes/${m}/requests`, { ly_do: 'Thử' });
  s.mails.length = 0;
  assert.equal((await s.api('truong', 'POST', `/requests/${r.json.id}/reject`, { ly_do: 'Mẫu cần giữ lại' })).status, 200);
  await cho();
  assert.deepEqual(den('bị từ chối'), ['bob@sci.edu.vn', 'cellbank@sci.edu.vn', 'manager@sci.edu.vn']);
  assert.equal((await s.api('cellbank', 'POST', `/requests/${r.json.id}/reject`, { ly_do: 'x' })).status, 409);
  assert.ok((await s.api('cellbank', 'GET', '/requests?view=done')).json.requests.some((y) => y.id === r.json.id));
});

test('người duyệt của đơn vị (Viện trưởng, Trưởng CIPP) không bị chặn thêm / lấy mẫu ở thiết bị Cellbank; người thường vẫn bị chặn', async () => {
  const them = (user, r, c) => s.api(user, 'POST', '/tubes', { box_id: hop, row_no: r, col_no: c, name: `Q${r}${c}`, chu_loai: 'can_bo' });
  assert.equal((await them('bob', 6, 1)).status, 403, 'người thường bị chặn');
  const a = await them('truong', 6, 2); // Viện trưởng (người duyệt được chỉ định)
  assert.equal(a.status, 201, 'Viện trưởng thêm mẫu được');
  const b = await them('cellbank', 6, 3); // Trưởng CIPP (người duyệt theo vai trò)
  assert.equal(b.status, 201, 'Trưởng CIPP thêm mẫu được');
  // thao tác mẫu của người khác ở thiết bị của đơn vị mình: lấy ra, trả lại
  const mauAlice = (await them('manager', 6, 4)).json.id;
  assert.equal((await s.api('bob', 'POST', `/tubes/${mauAlice}/checkout`, { note: 'x' })).status, 403);
  assert.equal((await s.api('truong', 'POST', `/tubes/${mauAlice}/checkout`, { note: 'Viện trưởng lấy kiểm tra' })).status, 200);
  assert.equal((await s.api('truong', 'POST', `/tubes/${mauAlice}/checkin`, { note: 'Trả lại đủ' })).status, 200);
  // cờ cho giao diện
  const hopInfo = (u) => s.api(u, 'GET', `/boxes/${hop}`);
  assert.equal((await hopInfo('truong')).json.duoc_don_vi, true);
  assert.equal((await hopInfo('cellbank')).json.duoc_don_vi, true);
  assert.equal((await hopInfo('bob')).json.duoc_don_vi, false);
  const cay = (await s.api('truong', 'GET', '/tree')).json.containers.find((c) => c.quan_ly_boi === 'cellbank');
  assert.equal(cay.duoc_don_vi, true);
  assert.equal((await s.api('bob', 'GET', '/tree')).json.containers.find((c) => c.quan_ly_boi === 'cellbank').duoc_don_vi, false);
  // người duyệt của đơn vị KHÁC không được miễn ở thiết bị Cellbank
  const dv2 = (await s.api('admin', 'POST', '/units', { ten: 'Đơn vị khác', nguoi_duyet: [3] })).json.id;
  assert.ok(dv2);
  assert.equal((await them('alice', 6, 5)).status, 403, 'alice duyệt cho đơn vị khác, không phải Cellbank');
});
