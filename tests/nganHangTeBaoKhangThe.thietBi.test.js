'use strict';

// Mẫu thiết bị lưu trữ: chọn mẫu (Panasonic -86°C 2 ngăn, tủ -20°C nằm ngang 2 cánh, tủ lạnh 2 ngăn -20°C / 4°C, bình nitơ lỏng…) thì thiết bị
// được tạo kèm các ngăn; người dùng thêm Rack / giỏ / hộp vào sau.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');
const TB = require('../services/nganHangTeBaoKhangTheThietBi');

let s;
const KT = 'khang_the';
const cay = async (nh) => (await s.api('manager', 'GET', '/tree', null, nh)).json;
const tao = (body, nh, user = 'manager') => s.api(user, 'POST', '/containers', body, nh);
const con = (t, id) => t.containers.filter((c) => c.parent_id === id).sort((a, b) => a.vi_tri - b.vi_tri);

test.before(async () => { s = await dungServer(); });
test.after(() => s.dong());

test('danh mục mẫu: mã duy nhất, kiểu vẽ hợp lệ, mẫu có ngăn đều khai số kệ; /meta trả danh mục', async () => {
  const ma = TB.MAU_THIET_BI.map((m) => m.ma);
  assert.equal(new Set(ma).size, ma.length);
  for (const m of TB.MAU_THIET_BI) {
    assert.ok(['binh_ln', 'tu_dung', 'tu_nam', 'tu_lanh'].includes(m.kieu), m.ma);
    assert.ok(TB.NHOM[m.nhom], m.ma);
    if (m.kieu === 'binh_ln') assert.equal(m.khoang.length, 0);
    else for (const k of m.khoang) assert.ok(k.so_ke >= 1 && k.so_ke <= 12 && k.ten && k.loai_ke, m.ma);
    assert.ok(TB.loaiCanCo(m).length >= 1);
  }
  for (const c of ['binh-ln', 'tu-86-dung-2-ngan', 'tu-20-nam-2-canh', 'tu-lanh-20-4']) assert.ok(ma.includes(c), c);
  const meta = (await s.api('alice', 'GET', '/meta')).json;
  assert.deepEqual(meta.mauThietBi.map((m) => m.ma), ma);
  assert.ok(meta.nhomThietBi.binh);
  assert.equal(TB.layMau('khong-co'), null);
  assert.equal(TB.layMau(undefined), null);
});

test('tủ âm sâu -86°C đứng 2 ngăn: loại thiết bị theo mẫu, nhiệt độ -86, hai ngăn trên / dưới đánh số vị trí', async () => {
  const r = await tao({ name: 'Tủ Panasonic phòng A', mau_tb: 'tu-86-dung-2-ngan' });
  assert.equal(r.status, 201);
  assert.equal(r.json.so_ngan, 2);
  const t = await cay();
  const goc = t.containers.find((c) => c.id === r.json.id);
  assert.equal(goc.type_name, 'Tủ âm sâu -86°C');
  assert.equal(goc.temperature_c, -86);
  assert.equal(goc.mau_tb, 'tu-86-dung-2-ngan');
  const ngan = con(t, goc.id);
  assert.deepEqual(ngan.map((c) => [c.name, c.vi_tri, c.type_name, c.temperature_c, c.mau_tb]), [['Ngăn trên', 1, 'Ngăn', -86, null], ['Ngăn dưới', 2, 'Ngăn', -86, null]]);
  // người dùng thêm Rack vào từng ngăn sau đó (vị trí kệ duy nhất trong ngăn)
  const rack = (cha, viTri, ten) => s.api('manager', 'POST', '/containers', { name: ten, type_id: goc.type_id, parent_id: cha, vi_tri: viTri });
  assert.equal((await rack(ngan[0].id, 1, 'Rack A1')).status, 201);
  assert.equal((await rack(ngan[0].id, 1, 'Rack trùng')).status, 409, 'trùng vị trí kệ trong cùng ngăn');
  assert.equal((await rack(ngan[1].id, 1, 'Rack B1')).status, 201, 'ngăn khác có vị trí 1 riêng');
});

test('kéo Rack trên sơ đồ: chuyển sang ô trống, hoán đổi giữa hai ngăn bằng chuỗi PATCH (tạm bỏ số → đổi chỗ → đặt vào), người thường không kéo được', async () => {
  const r = await tao({ name: 'Tủ kéo thả', mau_tb: 'tu-86-dung-2-ngan' });
  const t0 = await cay();
  const [tren, duoi] = con(t0, r.json.id);
  const loai = t0.containers.find((c) => c.id === r.json.id).type_id;
  const rack = async (cha, viTri, ten) => (await s.api('manager', 'POST', '/containers', { name: ten, type_id: loai, parent_id: cha, vi_tri: viTri })).json.id;
  const a = await rack(tren.id, 1, 'Rack kéo A'), b = await rack(duoi.id, 2, 'Rack kéo B');
  const patch = (id, body, user = 'manager') => s.api(user, 'PATCH', '/containers/' + id, body);
  const vitri = async (id) => { const c = (await cay()).containers.find((x) => x.id === id); return [c.parent_id, c.vi_tri]; };
  // ô trống: chuyển thẳng sang ngăn dưới, ô 5
  assert.equal((await patch(a, { parent_id: duoi.id, vi_tri: 5 })).status, 200);
  assert.deepEqual(await vitri(a), [duoi.id, 5]);
  // ô đã có Rack khác: đặt thẳng bị 409, hoán đổi theo chuỗi thì được
  assert.equal((await patch(a, { parent_id: duoi.id, vi_tri: 2 })).status, 409);
  assert.equal((await patch(a, { vi_tri: null })).status, 200);
  assert.equal((await patch(b, { parent_id: duoi.id, vi_tri: 5 })).status, 200);
  assert.equal((await patch(a, { parent_id: duoi.id, vi_tri: 2 })).status, 200);
  assert.deepEqual([await vitri(a), await vitri(b)], [[duoi.id, 2], [duoi.id, 5]]);
  assert.equal((await patch(a, { vi_tri: 1 }, 'alice')).status, 403, 'người thường không đổi vị trí Rack');
});

test('tủ lạnh 2 ngăn: ngăn trên -20°C, ngăn dưới 4°C, thiết bị không có nhiệt độ chung', async () => {
  const r = await tao({ name: 'Tủ lạnh Panasonic 2 ngăn', mau_tb: 'tu-lanh-20-4' });
  assert.equal(r.status, 201);
  const t = await cay();
  const goc = t.containers.find((c) => c.id === r.json.id);
  assert.equal(goc.type_name, 'Tủ lạnh 2 ngăn (-20°C / 4°C)');
  assert.equal(goc.temperature_c, null);
  assert.deepEqual(con(t, goc.id).map((c) => [c.name, c.temperature_c]), [['Ngăn đá trên (-20°C)', -20], ['Ngăn mát dưới (4°C)', 4]]);
});

test('tủ -20°C nằm ngang 2 cánh: hai cánh trái / phải; loại «Giỏ» có sẵn để thêm vào cánh', async () => {
  const r = await tao({ name: 'Tủ đông 2 cánh', mau_tb: 'tu-20-nam-2-canh' });
  assert.equal(r.status, 201);
  const t = await cay();
  const goc = t.containers.find((c) => c.id === r.json.id);
  assert.deepEqual(con(t, goc.id).map((c) => c.name), ['Cánh trái', 'Cánh phải']);
  assert.ok((await s.api('manager', 'GET', '/meta')).json.containerTypes.some((x) => x.name === 'Giỏ'));
  assert.equal((await s.api('manager', 'GET', '/meta')).json.containerTypes.filter((x) => x.name === 'Ngăn').length, 1, 'không tạo trùng loại «Ngăn»');
});

test('bình nitơ lỏng theo mẫu: không có ngăn (Rack gắn thẳng vào bình), dùng lại loại có sẵn', async () => {
  const truoc = (await s.api('manager', 'GET', '/meta')).json.containerTypes.filter((x) => x.name === 'Bình nitơ lỏng').length;
  const r = await tao({ name: 'Bình LN mới', mau_tb: 'binh-ln' });
  assert.equal(r.status, 201);
  assert.equal(r.json.so_ngan, 0);
  const t = await cay();
  const goc = t.containers.find((c) => c.id === r.json.id);
  assert.deepEqual([goc.type_name, goc.temperature_c, con(t, goc.id).length], ['Bình nitơ lỏng', -196, 0]);
  assert.equal((await s.api('manager', 'GET', '/meta')).json.containerTypes.filter((x) => x.name === 'Bình nitơ lỏng').length, truoc);
});

test('kiểm tra: mẫu lạ, mẫu cho vị trí con, loại do người dùng gửi bị bỏ qua, quyền, nhiệt độ người dùng nhập được ưu tiên, lỗi không để lại loại rác', async () => {
  assert.equal((await tao({ name: 'x', mau_tb: 'khong-co' })).status, 400);
  const cha = (await tao({ name: 'Cha', mau_tb: 'tu-am-co2' })).json;
  const goc = (await cay()).containers.find((c) => c.id === cha.id);
  assert.equal(goc.type_name, 'Tủ ấm CO₂');
  assert.equal(goc.temperature_c, 37);
  assert.equal((await tao({ name: 'Con', mau_tb: 'tu-am-co2', parent_id: cha.id })).status, 400, 'chỉ thiết bị gốc');
  assert.equal((await tao({ name: 'Thường', mau_tb: 'tu-am-co2' }, undefined, 'alice')).status, 403, 'người thường không thêm thiết bị');
  const typeLa = (await s.api('manager', 'GET', '/meta')).json.containerTypes.find((x) => x.name === 'Bình nitơ lỏng').id;
  const ghiDe = await tao({ name: 'Tủ -150', mau_tb: 'tu-150-dung', type_id: typeLa, temperature_c: -140 });
  assert.equal(ghiDe.status, 201);
  const g2 = (await cay()).containers.find((c) => c.id === ghiDe.json.id);
  assert.deepEqual([g2.type_name, g2.temperature_c], ['Tủ -150°C', -140], 'loại theo mẫu, nhiệt độ người dùng nhập được giữ');
  // mã trùng → 409 và không tạo loại «Tủ -20°C nằm ngang» của mẫu
  const dau = await tao({ name: 'Tủ mã trùng', mau_tb: 'tu-86-nam', code: 'VC-TRUNG' });
  assert.equal(dau.status, 201);
  const soLoai = (await s.api('manager', 'GET', '/meta')).json.containerTypes.length;
  assert.equal((await tao({ name: 'Trùng mã', mau_tb: 'tu-lanh-4-dung', code: 'VC-TRUNG' })).status, 409);
  const sau = (await s.api('manager', 'GET', '/meta')).json.containerTypes;
  assert.equal(sau.length, soLoai, 'yêu cầu bị từ chối không để lại loại thiết bị');
  assert.ok(!(await cay()).containers.some((c) => c.name === 'Trùng mã'));
});

test('ngân hàng kháng thể: thiết bị theo mẫu vẫn thuộc AntibodyBank, các ngăn nằm trong ngân hàng kháng thể', async () => {
  const r = await tao({ name: 'Tủ -86 kháng thể', mau_tb: 'tu-86-dung-2-ngan' }, KT);
  assert.equal(r.status, 201);
  const t = await cay(KT);
  const goc = t.containers.find((c) => c.id === r.json.id);
  assert.equal(goc.don_vi_ten, 'AntibodyBank');
  assert.deepEqual(con(t, goc.id).map((c) => c.name), ['Ngăn trên', 'Ngăn dưới']);
  assert.ok(!(await cay()).containers.some((c) => c.id === r.json.id), 'ngân hàng tế bào không thấy');
  assert.equal(s.db.prepare("SELECT COUNT(*) AS c FROM nhm_containers WHERE parent_id = ? AND ngan_hang = 'khang_the'").get(r.json.id).c, 2);
});
