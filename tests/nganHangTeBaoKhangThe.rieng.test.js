'use strict';

// Thiết bị RIÊNG của Viện trưởng: chỉ chủ và admin thấy; người khác (kể cả quản lý module) không thấy ở cây, tìm kiếm, xuất,
// yêu cầu, số đếm, và gặp 404 khi truy cập trực tiếp theo id. Chủ toàn quyền và đổi được sang Public / đơn vị (Cellbank).

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;
let thietBi; // id thiết bị riêng
let rack;
let hop;
let mau;

const cay = async (user) => (await s.api(user, 'GET', '/tree')).json;
const thay = async (user, id) => (await cay(user)).containers.some((c) => c.id === id);

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  // 'truong' (id 6) được admin cấp vai trò Viện trưởng
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 6, vai_tro: 'vien_truong' })).status, 201);
});
test.after(() => s.dong());

test('chỉ admin cấp vai trò Viện trưởng; chỉ Viện trưởng tạo được thiết bị riêng', async () => {
  assert.equal((await s.api('manager', 'POST', '/roles', { user_id: 3, vai_tro: 'vien_truong' })).status, 403);
  const rieng = { name: 'Tủ riêng VT', type_id: kho.type, rieng: true };
  assert.equal((await s.api('alice', 'POST', '/containers', rieng)).status, 403, 'người thường');
  assert.equal((await s.api('manager', 'POST', '/containers', rieng)).status, 403, 'quản lý module cũng không tạo thiết bị riêng');
  const r = await s.api('truong', 'POST', '/containers', rieng);
  assert.equal(r.status, 201);
  thietBi = r.json.id;
  // Viện trưởng (không phải quản lý) không tạo được thiết bị công khai thường
  assert.equal((await s.api('truong', 'POST', '/containers', { name: 'Tủ công khai', type_id: kho.type })).status, 403);
});

test('chủ toàn quyền: thêm Rack, hộp, mẫu, sửa, kiểm kê trong thiết bị riêng của mình', async () => {
  const gia = kho.meta.containerTypes.find((t) => /^Rack$/.test(t.name)).id;
  const r1 = await s.api('truong', 'POST', '/containers', { name: 'Rack VT', type_id: gia, parent_id: thietBi });
  assert.equal(r1.status, 201);
  rack = r1.json.id;
  const b = await s.api('truong', 'POST', '/boxes', { container_id: rack, template_id: kho.tpl99, name: 'Hộp VT' });
  assert.equal(b.status, 201);
  hop = b.json.ids[0];
  const t = await s.api('truong', 'POST', '/tubes', { box_id: hop, row_no: 1, col_no: 1, name: 'MẪU-BÍ-MẬT-VT', chu_loai: 'can_bo' });
  assert.equal(t.status, 201);
  mau = t.json.id;
  assert.equal((await s.api('truong', 'PATCH', `/containers/${rack}`, { name: 'Rack VT đổi tên' })).status, 200);
  assert.equal((await s.api('truong', 'PATCH', `/boxes/${hop}`, { name: 'Hộp VT đổi tên' })).status, 200);
  assert.equal((await s.api('truong', 'POST', `/tubes/${mau}/checkout`, { note: 'Viện trưởng lấy dùng' })).status, 200);
  assert.equal((await s.api('truong', 'POST', `/tubes/${mau}/checkin`, { note: 'Trả lại đủ' })).status, 200);
  assert.equal((await s.api('truong', 'POST', `/boxes/${hop}/audit`, { thay: [mau], khong_thay: [] })).status, 200, 'kiểm kê hộp của mình');
  assert.ok(await thay('truong', thietBi));
  const c = (await cay('truong')).containers.find((x) => x.id === thietBi);
  assert.equal(c.rieng, true);
  assert.equal(c.rieng_cua_toi, true);
});

test('người khác (kể cả quản lý module) không thấy: cây, tìm kiếm, xuất, số đếm; admin vẫn thấy', async () => {
  for (const u of ['alice', 'bob', 'manager', 'cellbank']) {
    assert.equal(await thay(u, thietBi), false, `${u} không thấy thiết bị`);
    assert.equal(await thay(u, rack), false);
    const hopThay = (await cay(u)).boxes.some((x) => x.id === hop);
    assert.equal(hopThay, false, `${u} không thấy hộp`);
    const tim = (await s.api(u, 'GET', '/tubes/search?q=BÍ-MẬT&status=all')).json;
    assert.equal(tim.total, 0, `${u} tìm không ra mẫu`);
  }
  const csv = await fetch(`${s.base}/tubes/export.csv?status=all`, { headers: { 'x-test-user': 'manager' } });
  assert.doesNotMatch(await csv.text(), /BÍ-MẬT/, 'xuất CSV của quản lý không có mẫu riêng');
  // admin thấy hết (không có nhãn tiết lộ cho người khác)
  assert.ok(await thay('admin', thietBi));
  assert.equal((await s.api('admin', 'GET', '/tubes/search?q=BÍ-MẬT&status=all')).json.total, 1);
  // chủ thấy mẫu của mình
  assert.equal((await s.api('truong', 'GET', '/tubes/search?q=BÍ-MẬT&status=all')).json.total, 1);
});

test('truy cập trực tiếp theo id: 404 như không tồn tại; không ghi vào thiết bị riêng của người khác', async () => {
  const gia = kho.meta.containerTypes.find((t) => /^Rack$/.test(t.name)).id;
  for (const u of ['alice', 'manager']) {
    assert.equal((await s.api(u, 'GET', `/boxes/${hop}`)).status, 404, `${u} đọc hộp`);
    assert.equal((await s.api(u, 'GET', `/tubes/${mau}/history`)).status, 404, `${u} đọc lịch sử`);
    assert.equal((await s.api(u, 'PATCH', `/containers/${thietBi}`, { name: 'x' })).status, 404, `${u} sửa thiết bị`);
    assert.equal((await s.api(u, 'DELETE', `/boxes/${hop}`)).status, 404, `${u} xóa hộp`);
    assert.equal((await s.api(u, 'POST', `/tubes/${mau}/requests`, { ly_do: 'xin thử' })).status, 404, `${u} xin lấy mẫu`);
    assert.equal((await s.api(u, 'POST', '/tubes', { box_id: hop, row_no: 2, col_no: 2, name: 'chen vào', chu_loai: 'can_bo' })).status, 404, `${u} thêm mẫu vào hộp`);
    assert.equal((await s.api(u, 'POST', '/boxes', { container_id: rack, template_id: kho.tpl99 })).status, 404, `${u} thêm hộp vào Rack`);
    assert.equal((await s.api(u, 'POST', '/containers', { name: 'chen', type_id: gia, parent_id: thietBi })).status, 404, `${u} thêm Rack vào thiết bị`);
  }
  // 404 giống hệt id không tồn tại: không phân biệt được "có nhưng bị ẩn"
  const khongCo = await s.api('alice', 'GET', '/boxes/999999');
  const biAn = await s.api('alice', 'GET', `/boxes/${hop}`);
  assert.equal(khongCo.status, biAn.status);
  // lịch sử mẫu riêng chỉ có thao tác của chủ
  const ls = (await s.api('truong', 'GET', `/tubes/${mau}/history`)).json.history;
  assert.ok(ls.length >= 3 && ls.every((h) => h.user_id == null || h.user_id === 6), 'chỉ có thao tác của Viện trưởng');
});

test('số đếm trang chủ không tính thiết bị riêng', async () => {
  const { miniStats } = require('../services/nganHangTeBaoKhangTheKhoiTao');
  const st = miniStats(s.db);
  // DB có: 1 thiết bị công khai + 1 thiết bị riêng + 1 Rack riêng; 2 hộp công khai + 1 hộp riêng; 1 mẫu (riêng)
  assert.equal(st.containers, 1);
  assert.equal(st.boxes, 2);
  assert.equal(st.samples, 0, 'mẫu duy nhất nằm trong thiết bị riêng nên không tính');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM nhm_tubes WHERE deleted_at IS NULL').get().c, 1);
});

test('chủ đổi chế độ: riêng → Cellbank → riêng → Public; người khác tới lúc nào thấy lúc đó', async () => {
  const cellbank = (await s.api('manager', 'GET', '/units')).json.units.find((u) => u.ma === 'cellbank').id;
  // sang Cellbank (người duyệt Cellbank là Trưởng CIPP, user 7)
  assert.equal((await s.api('truong', 'PATCH', `/containers/${thietBi}`, { rieng: false, don_vi_id: cellbank })).status, 200);
  assert.ok(await thay('alice', thietBi), 'giờ người khác thấy');
  const c = (await cay('alice')).containers.find((x) => x.id === thietBi);
  assert.equal(c.rieng, false);
  assert.equal(c.don_vi_ten, 'Cellbank');
  // về lại riêng (do chính Viện trưởng tạo)
  assert.equal((await s.api('truong', 'PATCH', `/containers/${thietBi}`, { rieng: true })).status, 200);
  assert.equal(await thay('alice', thietBi), false, 'ẩn lại');
  // sang Public
  assert.equal((await s.api('truong', 'PATCH', `/containers/${thietBi}`, { rieng: false })).status, 200);
  const pub = (await cay('alice')).containers.find((x) => x.id === thietBi);
  assert.ok(pub && pub.rieng === false && pub.quan_ly_boi === 'cong_khai' && pub.don_vi_id === null);
  // người khác KHÔNG tự biến thiết bị của Viện trưởng thành riêng / không sửa thiết bị công khai của người khác
  assert.equal((await s.api('alice', 'PATCH', `/containers/${thietBi}`, { rieng: true })).status, 403);
  assert.equal((await s.api('truong', 'PATCH', `/containers/${kho.container}`, { rieng: true })).status, 403, 'Viện trưởng không biến thiết bị do người khác tạo thành riêng');
  assert.equal((await s.api('truong', 'PATCH', `/containers/${kho.container}`, { name: 'đổi tên' })).status, 403, 'và không sửa thiết bị công khai của người khác');
  // lại riêng để các test sau (nếu có) còn dữ liệu
  assert.equal((await s.api('truong', 'PATCH', `/containers/${thietBi}`, { rieng: true })).status, 200);
});
