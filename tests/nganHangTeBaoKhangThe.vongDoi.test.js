'use strict';

// Vòng đời mẫu (lấy ra / trả lại / rã đông / hủy), lịch sử có giá trị cũ → mới, chuyển quyền sở hữu,
// và nhật ký khi hộp đổi chỗ.

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

async function taoMau(user, row, col, extra) {
  const r = await s.api(user, 'POST', '/tubes', { box_id: kho.box, row_no: row, col_no: col, name: `M${row}${col}`, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}
const hanhDong = async (id) => (await s.api('manager', 'GET', `/tubes/${id}/history`)).json.history.map((h) => h.action);
const trangThai = (id) => s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(id).status;

test('lấy ra rồi trả lại: giữ nguyên ô, hiện trạng thái, không cho di chuyển khi đang lấy ra', async () => {
  const id = await taoMau('alice', 1, 1);
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/checkout`, { note: 'chạy thí nghiệm' })).status, 200);
  assert.equal(trangThai(id), 'checked_out');
  // vẫn giữ chỗ: ô (1,1) chưa trống
  assert.equal((await s.api('bob', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 1, name: 'chen' })).status, 409);
  const hop = (await s.api('alice', 'GET', `/boxes/${kho.box}`)).json;
  assert.equal(hop.tubes.find((t) => t.id === id).status, 'checked_out');
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/move`, { box_id: kho.box, row_no: 5, col_no: 5 })).status, 409);
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/checkout`)).status, 409); // đã lấy ra rồi
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/checkin`)).status, 200);
  assert.equal(trangThai(id), 'in_storage');
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/checkin`)).status, 409); // chưa lấy ra
  assert.deepEqual(await hanhDong(id), ['checkin', 'checkout', 'store']);
  const h = (await s.api('alice', 'GET', `/tubes/${id}/history`)).json.history;
  assert.equal(h[1].note, 'chạy thí nghiệm');
});

test('rã đông nhả ô, mẫu biến khỏi lưới nhưng lịch sử còn; không thể di chuyển / rã đông lại', async () => {
  const id = await taoMau('alice', 2, 2);
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/thaw`)).status, 200);
  assert.equal(trangThai(id), 'thawed');
  const hop = (await s.api('alice', 'GET', `/boxes/${kho.box}`)).json;
  assert.ok(!hop.tubes.some((t) => t.id === id));
  // ô đã được nhả: đặt mẫu mới vào được
  assert.equal((await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 2, col_no: 2, name: 'mới' })).status, 201);
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/thaw`)).status, 409);
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/checkout`)).status, 409);
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/move`, { box_id: kho.box, row_no: 9, col_no: 9 })).status, 409);
  assert.deepEqual(await hanhDong(id), ['thaw', 'store']);
});

test('hủy mẫu từ mọi trạng thái còn lại; hủy hai lần bị 409', async () => {
  const a = await taoMau('alice', 3, 1);
  assert.equal((await s.api('alice', 'POST', `/tubes/${a}/discard`, { note: 'nhiễm mycoplasma' })).status, 200);
  assert.equal(trangThai(a), 'discarded');
  assert.equal((await s.api('alice', 'POST', `/tubes/${a}/discard`)).status, 409);
  const b = await taoMau('alice', 3, 2);
  await s.api('alice', 'POST', `/tubes/${b}/thaw`);
  assert.equal((await s.api('alice', 'POST', `/tubes/${b}/discard`)).status, 200);
  const c = await taoMau('alice', 3, 3);
  await s.api('alice', 'POST', `/tubes/${c}/checkout`);
  assert.equal((await s.api('alice', 'POST', `/tubes/${c}/discard`)).status, 200);
});

test('vòng đời: người lạ 403, mẫu không có 404, quản lý được thao tác hộ', async () => {
  const id = await taoMau('alice', 4, 1);
  for (const act of ['checkout', 'checkin', 'thaw', 'discard']) {
    assert.equal((await s.api('bob', 'POST', `/tubes/${id}/${act}`)).status, 403, act);
    assert.equal((await s.api('alice', 'POST', `/tubes/99999/${act}`)).status, 404, act);
    assert.equal((await s.api(null, 'POST', `/tubes/${id}/${act}`)).status, 401, act);
  }
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/checkout`)).status, 200);
  assert.equal(trangThai(id), 'checked_out');
  assert.equal((await s.api('manager', 'GET', `/tubes/${id}/history`)).json.history[0].user_name, 'manager@sci.edu.vn');
});

test('xóa hộp / vật chứa: mẫu đã rã đông hoặc hủy không chặn', async () => {
  const f = await s.api('manager', 'POST', '/containers', { name: 'Tủ tạm', type_id: kho.type });
  const b = await s.api('manager', 'POST', '/boxes', { container_id: f.json.id, template_id: kho.tpl99 });
  const t = await s.api('alice', 'POST', '/tubes', { box_id: b.json.ids[0], row_no: 1, col_no: 1, name: 'x' });
  assert.equal((await s.api('manager', 'DELETE', `/boxes/${b.json.ids[0]}`)).status, 409);
  await s.api('alice', 'POST', `/tubes/${t.json.id}/discard`);
  assert.equal((await s.api('manager', 'DELETE', `/containers/${f.json.id}`)).status, 200);
});

test('sửa mẫu ghi giá trị cũ → mới, bỏ qua trường không đổi, loại mẫu ghi tên', async () => {
  const id = await taoMau('alice', 5, 1, { passage: 'P12' });
  const loai = kho.meta.sampleTypes.find((x) => x.name === 'Kháng thể').id;
  const r = await s.api('alice', 'PATCH', `/tubes/${id}`, { passage: 'P13', name: 'M51', sample_type_id: loai });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, 2); // name không đổi
  const edit = (await s.api('alice', 'GET', `/tubes/${id}/history`)).json.history[0];
  assert.equal(edit.action, 'edit');
  assert.deepEqual(JSON.parse(edit.note), { passage: ['P12', 'P13'], sample_type_id: [null, 'Kháng thể'] });
  // không có gì đổi thì không ghi thêm dòng lịch sử
  const n = (await hanhDong(id)).length;
  const same = await s.api('alice', 'PATCH', `/tubes/${id}`, { passage: 'P13' });
  assert.equal(same.status, 200);
  assert.equal(same.json.changed, 0);
  assert.equal((await hanhDong(id)).length, n);
  const log = s.auditLog.filter((a) => a.action === 'nhm_tube_update').pop();
  assert.match(log.detail, /Passage: P12 → P13/);
});

test('di chuyển về đúng ô hiện tại bị 400 và không ghi lịch sử', async () => {
  const id = await taoMau('alice', 6, 1);
  const n = (await hanhDong(id)).length;
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/move`, { box_id: kho.box, row_no: 6, col_no: 1 })).status, 400);
  assert.equal((await hanhDong(id)).length, n);
});

test('chuyển quyền sở hữu: chỉ quản lý, người nhận phải tồn tại, chủ mới sửa được, chủ cũ mất quyền', async () => {
  const id = await taoMau('alice', 7, 1);
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/transfer`, { owner_user_id: 4 })).status, 403);
  assert.equal((await s.api('alice', 'GET', '/users')).status, 403);
  const ds = (await s.api('manager', 'GET', '/users')).json.users;
  assert.ok(ds.some((u) => u.id === 4));
  assert.ok(!ds.some((u) => u.id === 9), 'tài khoản bị khóa không nằm trong danh sách');
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/transfer`, { owner_user_id: 12345 })).status, 400);
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/transfer`, { owner_user_id: 3 })).status, 400); // đã là chủ
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/transfer`, { owner_user_id: 4 })).status, 200);
  assert.equal((await s.api('bob', 'PATCH', `/tubes/${id}`, { passage: 'P1' })).status, 200);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${id}`, { passage: 'P2' })).status, 403);
  const h = (await s.api('bob', 'GET', `/tubes/${id}/history`)).json.history.find((x) => x.action === 'transfer');
  assert.ok(h);
  assert.match(h.note, /alice@sci\.edu\.vn → bob@sci\.edu\.vn/);
});

test('hộp đổi chỗ / đổi mã được ghi vào lịch sử từng mẫu trong hộp; đổi tên thì không', async () => {
  const f2 = await s.api('manager', 'POST', '/containers', { name: 'Tủ đích', type_id: kho.type });
  const b = await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, name: 'Hộp chuyển', code: 'HOP-CHUYEN' });
  const id = (await s.api('alice', 'POST', '/tubes', { box_id: b.json.ids[0], row_no: 1, col_no: 1, name: 'theo hộp' })).json.id;
  const n0 = (await hanhDong(id)).length;
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${b.json.ids[0]}`, { name: 'Tên khác' })).status, 200);
  assert.equal((await hanhDong(id)).length, n0);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${b.json.ids[0]}`, { container_id: f2.json.id })).status, 200);
  const h1 = (await s.api('alice', 'GET', `/tubes/${id}/history`)).json.history[0];
  assert.equal(h1.action, 'box_move');
  assert.match(h1.note, /HOP-CHUYEN: Tủ test → Tủ đích/);
  assert.equal((await s.api('manager', 'PATCH', `/boxes/${b.json.ids[0]}`, { code: 'HOP-MOI' })).status, 200);
  const h2 = (await s.api('alice', 'GET', `/tubes/${id}/history`)).json.history[0];
  assert.equal(h2.action, 'box_edit');
  assert.match(h2.note, /HOP-CHUYEN → HOP-MOI/);
  const log = s.auditLog.filter((a) => a.action === 'nhm_box_update').pop();
  assert.match(log.detail, /Mã: HOP-CHUYEN → HOP-MOI/);
});

test('sửa vật chứa ghi thay đổi vào nhật ký; không đổi gì thì changed = 0', async () => {
  const r = await s.api('manager', 'PATCH', `/containers/${kho.container}`, { location_note: 'Phòng 203' });
  assert.equal(r.json.changed, 1);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${kho.container}`, { location_note: 'Phòng 203' })).json.changed, 0);
  assert.match(s.auditLog.filter((a) => a.action === 'nhm_container_update').pop().detail, /Vị trí đặt: \(trống\) → Phòng 203/);
});
