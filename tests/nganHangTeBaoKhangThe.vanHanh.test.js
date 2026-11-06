'use strict';

// Vận hành hằng ngày: đợt kiểm kê cả thiết bị, nhắc hạn QC (mycoplasma / STR) và kiểm kê, nhật ký nhiệt độ + cảnh báo, thư nhắc định kỳ.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');
const ND = require('../services/nganHangTeBaoKhangTheNhietDo');
const NV = require('../services/nganHangTeBaoKhangTheNhacViec');

let s;
let kho;
const KT = 'khang_the';
const cho = () => new Promise((r) => setTimeout(r, 60));
const lui = (ngay) => new Date(Date.now() + 7 * 3600000 - ngay * 86400000).toISOString().slice(0, 10);
const them = (user, box, r, c, extra) => s.api(user, 'POST', '/tubes', { box_id: box, row_no: r, col_no: c, name: `M${r}${c}`, chu_loai: 'can_bo', ...extra });
const viec = async (user = 'manager', nh) => (await s.api(user, 'GET', '/reminders', null, nh)).json.viec;
const loai = (ds, l) => ds.filter((v) => v.loai === l);

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

// ═══ Hàm thuần ═══

test('gợi ý khoảng nhiệt độ cho phép theo nhiệt độ chuẩn; số đo và cài đặt được kiểm tra', () => {
  assert.deepEqual(ND.goiYNguong(-86), [-96, -70]);
  assert.deepEqual(ND.goiYNguong(-20), [-25, -15]);
  assert.deepEqual(ND.goiYNguong(4), [2, 8]);
  assert.deepEqual(ND.goiYNguong(37), [35, 39]);
  assert.deepEqual(ND.goiYNguong(-196), [-216, -150]);
  assert.equal(ND.goiYNguong(null), null);
  assert.equal(ND.goiYNguong('abc'), null);
  const ng = ND.nguongHieuLuc({ temperature_c: -86, nguong_duoi: null, nguong_tren: -75 });
  assert.deepEqual([ng.duoi, ng.tren, ng.tu_dat], [-96, -75, true], 'thiếu phía nào lấy gợi ý phía đó');
  assert.equal(ND.ngoaiNguong(-60, { duoi: -96, tren: -70 }), true);
  assert.equal(ND.ngoaiNguong(-80, { duoi: -96, tren: -70 }), false);
  assert.equal(ND.ngoaiNguong(5, { duoi: null, tren: null }), false, 'chưa có khoảng thì không kết luận');
  assert.match(ND.docSoDo({ nhiet_do: 'abc' }, false)[1], /Nhiệt độ/);
  assert.match(ND.docSoDo({}, false)[1], /nhập nhiệt độ/);
  assert.match(ND.docSoDo({ nhiet_do: -500 }, false)[1], /không hợp lệ/);
  assert.equal(ND.docSoDo({ nhiet_do: -80, muc_nito: 50 }, false)[0].muc_nito, null, 'tủ thường bỏ qua mức nitơ');
  assert.equal(ND.docSoDo({ nhiet_do: -190, muc_nito: 120 }, true)[0].muc_nito, 120);
  assert.match(ND.docSoDo({ nhiet_do: -190, muc_nito: 9999 }, true)[1], /Mức nitơ/);
  assert.match(ND.docCaiDat({ theo_doi: true, nguong_duoi: -70, nguong_tren: -90 })[1], /nhỏ hơn/);
});

// ═══ Đợt kiểm kê ═══

test('đợt kiểm kê: mở cho cả thiết bị, theo dõi tiến độ từng hộp, mẫu không thấy mở vụ việc, hộp được ghi mốc kiểm kê', async () => {
  const tb = (await s.api('manager', 'POST', '/containers', { name: 'Tủ kiểm kê', mau_tb: 'tu-86-dung-2-ngan' })).json.id;
  const ngan = (await s.api('manager', 'GET', '/tree')).json.containers.filter((c) => c.parent_id === tb);
  const hop = async (cha, ten) => (await s.api('manager', 'POST', '/boxes', { container_id: cha, template_id: kho.tpl99, name: ten })).json.ids[0];
  const h1 = await hop(ngan[0].id, 'Hộp KK 1');
  const h2 = await hop(ngan[1].id, 'Hộp KK 2');
  const hTrong = await hop(ngan[1].id, 'Hộp KK rỗng');
  const m1 = (await them('alice', h1, 1, 1)).json.id;
  const m2 = (await them('alice', h1, 1, 2)).json.id;
  const m3 = (await them('alice', h2, 1, 1)).json.id;
  assert.ok(hTrong);

  assert.equal((await s.api('alice', 'POST', '/inventories', { container_id: tb })).status, 403);
  assert.equal((await s.api(null, 'POST', '/inventories', {})).status, 401);
  assert.equal((await s.api('manager', 'POST', '/inventories', { container_id: 99999 })).status, 404);
  const mo = await s.api('manager', 'POST', '/inventories', { container_id: tb });
  assert.equal(mo.status, 201);
  assert.equal(mo.json.so_hop, 2, 'hộp rỗng không đưa vào đợt');
  assert.equal(mo.json.so_mau, 3);
  assert.equal((await s.api('manager', 'POST', '/inventories', { container_id: tb })).status, 409, 'đã có đợt đang làm');
  assert.equal((await s.api('manager', 'POST', '/inventories', { container_id: ngan[0].id })).status, 409, 'ngăn nằm trong thiết bị đang kiểm kê');

  const id = mo.json.id;
  let ct = (await s.api('manager', 'GET', `/inventories/${id}`)).json;
  assert.deepEqual([ct.inventory.tong_hop, ct.inventory.hop_xong, ct.inventory.trang_thai], [2, 0, 'dang_lam']);
  assert.match(ct.inventory.ten, /^Kiểm kê Tủ kiểm kê /);
  assert.equal((await s.api('alice', 'GET', `/inventories/${id}`)).status, 403);

  // kết thúc sớm cần lý do
  const som = await s.api('manager', 'POST', `/inventories/${id}/finish`, {});
  assert.equal(som.status, 409);
  assert.match(som.json.message, /Còn 2 hộp chưa kiểm kê/);

  // hộp 1: thấy m1, không thấy m2
  assert.equal((await s.api('manager', 'POST', `/inventories/${id}/boxes/${h1}`, { thay: [m1], khong_thay: [999] })).status, 400, 'mẫu lạ');
  const k1 = await s.api('manager', 'POST', `/inventories/${id}/boxes/${h1}`, { thay: [m1], khong_thay: [m2] });
  assert.equal(k1.status, 200);
  assert.deepEqual([k1.json.thay, k1.json.khong_thay, k1.json.vu_viec_moi, k1.json.hop_xong, k1.json.tong_hop], [1, 1, 1, 1, 2]);
  assert.equal((await s.api('manager', 'POST', `/inventories/${id}/boxes/${h1}`, { thay: [m1], khong_thay: [] })).status, 409, 'một hộp kiểm một lần trong đợt');
  assert.equal((await s.api('manager', 'POST', `/inventories/${id}/boxes/${hTrong}`, { thay: [], khong_thay: [] })).status, 404, 'hộp ngoài đợt');
  const vv = (await s.api('manager', 'GET', '/incidents')).json.incidents.find((v) => v.tube_id === m2);
  assert.ok(vv, 'vụ việc nghi mất của mẫu không thấy');
  assert.equal(s.db.prepare('SELECT nguon FROM nhm_vu_viec WHERE id = ?').get(vv.id).nguon, 'kiem_ke');
  assert.ok(s.db.prepare('SELECT kiem_ke_luc FROM nhm_boxes WHERE id = ?').get(h1).kiem_ke_luc, 'hộp được ghi mốc kiểm kê');
  assert.equal(s.db.prepare('SELECT kiem_ke_luc FROM nhm_boxes WHERE id = ?').get(h2).kiem_ke_luc, null);

  const xong = await s.api('manager', 'POST', `/inventories/${id}/boxes/${h2}`, { thay: [m3], khong_thay: [] });
  assert.equal(xong.json.hop_xong, 2);
  ct = (await s.api('manager', 'GET', `/inventories/${id}`)).json;
  assert.deepEqual(ct.boxes.map((b) => [b.name, b.trang_thai, b.so_thay, b.so_khong_thay]), [['Hộp KK 1', 'xong', 1, 1], ['Hộp KK 2', 'xong', 1, 0]]);
  assert.deepEqual([ct.inventory.so_thay, ct.inventory.so_khong_thay, ct.inventory.so_vu_viec], [2, 1, 1]);

  const csv = await s.api('manager', 'GET', `/inventories/${id}/export.csv`);
  assert.equal(csv.status, 200);
  assert.ok(csv.text.startsWith('﻿Mã hộp,'));
  assert.match(csv.text, /Hộp KK 1/);

  assert.equal((await s.api('manager', 'POST', `/inventories/${id}/finish`, {})).status, 200);
  assert.equal((await s.api('manager', 'POST', `/inventories/${id}/boxes/${h1}`, { thay: [], khong_thay: [] })).status, 409, 'đợt đã kết thúc');
  assert.equal((await s.api('manager', 'POST', `/inventories/${id}/cancel`, { ly_do: 'Không còn cần' })).status, 409);
  assert.ok((await s.api('manager', 'GET', '/inventories')).json.inventories.some((d) => d.id === id && d.trang_thai === 'hoan_tat'));
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_inventory_finish'));
  // đợt kiểm kê không xóa được
  assert.throws(() => s.db.prepare('DELETE FROM nhm_kiem_ke WHERE id = ?').run(id), /không được xóa/);

  // mở lại được sau khi đợt cũ kết thúc; hủy cần lý do; kết thúc sớm có lý do thì được
  const lai = (await s.api('manager', 'POST', '/inventories', { container_id: ngan[0].id, ten: 'Kiểm lại ngăn trên' })).json.id;
  assert.equal((await s.api('manager', 'POST', `/inventories/${lai}/cancel`, { ly_do: 'ngắn' })).status, 400);
  const sau = await s.api('manager', 'POST', `/inventories/${lai}/finish`, { ly_do: 'Chưa thể mở tủ hôm nay' });
  assert.deepEqual([sau.status, sau.json.hop_chua_kiem], [200, 1]);
  const huy = (await s.api('manager', 'POST', '/inventories', { container_id: ngan[1].id })).json.id;
  assert.equal((await s.api('manager', 'POST', `/inventories/${huy}/cancel`, { ly_do: 'Mở nhầm vị trí' })).status, 200);
});

test('thiết bị riêng của Viện trưởng: đợt kiểm kê ở đó chỉ chủ và admin thấy', async () => {
  s.db.prepare("INSERT INTO nhm_vai_tro (user_id, vai_tro) VALUES (6, 'vien_truong')").run();
  const tb = (await s.api('truong', 'POST', '/containers', { name: 'Tủ riêng VT', type_id: kho.type, rieng: true })).json;
  assert.ok(tb.id, 'Viện trưởng tạo được thiết bị riêng');
  const h = (await s.api('truong', 'POST', '/boxes', { container_id: tb.id, template_id: kho.tpl99 })).json.ids[0];
  await them('truong', h, 1, 1);
  const dot = await s.api('truong', 'POST', '/inventories', { container_id: tb.id });
  assert.equal(dot.status, 201);
  assert.equal((await s.api('manager', 'GET', `/inventories/${dot.json.id}`)).status, 404, 'quản lý khác không thấy');
  assert.ok(!(await s.api('manager', 'GET', '/inventories')).json.inventories.some((d) => d.id === dot.json.id));
  assert.equal((await s.api('manager', 'POST', '/inventories', { container_id: tb.id })).status, 404);
  assert.equal((await s.api('admin', 'GET', `/inventories/${dot.json.id}`)).status, 200, 'admin thấy');
});

// ═══ Việc đến hạn: kiểm kê ═══

test('hộp có mẫu quá chu kỳ kiểm kê thì vào danh sách đến hạn; kiểm kê xong thì hết; chu kỳ chỉnh được', async () => {
  const c = (await s.api('manager', 'POST', '/containers', { name: 'Tủ đến hạn KK', type_id: kho.type })).json.id;
  const h = (await s.api('manager', 'POST', '/boxes', { container_id: c, template_id: kho.tpl99 })).json.ids[0];
  const m = (await them('alice', h, 1, 1)).json.id;
  assert.equal(loai(await viec(), 'kiem_ke').filter((v) => v.container_id === c).length, 0, 'hộp mới tạo chưa đến hạn');
  s.db.prepare("UPDATE nhm_boxes SET created_at = datetime('now', '-200 days') WHERE id = ?").run(h);
  const v = loai(await viec(), 'kiem_ke').find((x) => x.container_id === c);
  assert.ok(v);
  assert.match(v.chi_tiet, /1\/1 hộp quá 180 ngày/);
  assert.equal((await s.api('alice', 'GET', '/reminders')).json.viec.length, 0, 'người thường không thấy việc của quản lý');
  assert.ok((await s.api('manager', 'GET', '/me')).json.denHan >= 1);
  // chu kỳ dài hơn → chưa đến hạn
  assert.equal((await s.api('manager', 'PUT', '/settings', { KIEM_KE_NGAY: 365 })).status, 200);
  assert.ok(!loai(await viec(), 'kiem_ke').some((x) => x.container_id === c));
  await s.api('manager', 'PUT', '/settings', { KIEM_KE_NGAY: 180 });
  // kiểm kê hộp lẻ cũng ghi mốc
  assert.equal((await s.api('manager', 'POST', `/boxes/${h}/audit`, { thay: [m], khong_thay: [] })).status, 200);
  assert.ok(!loai(await viec(), 'kiem_ke').some((x) => x.container_id === c));
});

// ═══ Việc đến hạn: QC dòng tế bào ═══

test('QC: dòng còn ống mà chưa thử / quá chu kỳ mycoplasma và STR thì nhắc; dương tính là khẩn; dòng hết ống thì không nhắc', async () => {
  const dong = async (ma) => (await s.api('alice', 'POST', '/cell-lines', { ma, ten: 'Dòng ' + ma })).json.id;
  const lo = async (d) => (await s.api('alice', 'POST', `/cell-lines/${d}/lots`, { ma: 'L1' })).json.id;
  const qc = (d, loaiQc, ketQua, ngay) => s.api('alice', 'POST', `/cell-lines/${d}/qc`, { loai: loaiQc, ket_qua: ketQua, ngay });
  const hop = (await s.api('manager', 'POST', '/boxes', { container_id: kho.container, template_id: kho.tpl99, name: 'Hộp QC' })).json.ids[0];

  const moi = await dong('QC-MOI');
  await them('alice', hop, 1, 1, { lo_id: await lo(moi) });
  assert.ok(!(await viec()).some((v) => v.doi_tuong.loai === 'dong' && v.doi_tuong.id === moi), 'dòng vừa tạo được ân hạn');

  const cu = await dong('QC-CU');
  await them('alice', hop, 1, 2, { lo_id: await lo(cu) });
  s.db.prepare("UPDATE nhm_dong_te_bao SET created_at = datetime('now', '-60 days') WHERE id = ?").run(cu);
  let ds = (await viec()).filter((v) => v.doi_tuong.loai === 'dong' && v.doi_tuong.id === cu);
  assert.deepEqual(ds.map((v) => v.loai).sort(), ['myco', 'str'], 'chưa thử mycoplasma và chưa xác thực STR');
  assert.match(ds.find((v) => v.loai === 'myco').tieu_de, /Chưa thử mycoplasma/);

  assert.equal((await qc(cu, 'mycoplasma', 'am_tinh', lui(200))).status, 201);
  assert.equal((await qc(cu, 'str', 'dat', lui(400))).status, 201);
  ds = (await viec()).filter((v) => v.doi_tuong.id === cu && v.doi_tuong.loai === 'dong');
  assert.match(ds.find((v) => v.loai === 'myco').tieu_de, /Quá hạn thử mycoplasma/);
  assert.match(ds.find((v) => v.loai === 'str').tieu_de, /Quá hạn xác thực STR/);
  const hs = (await s.api('alice', 'GET', `/cell-lines/${cu}`)).json;
  assert.equal(hs.han_myco_ngay, 180);
  assert.equal(hs.mycoplasma.qua_han, true);

  // thử mới → hết nhắc mycoplasma; chu kỳ STR dài hơn → hết nhắc STR
  assert.equal((await qc(cu, 'mycoplasma', 'am_tinh', lui(1))).status, 201);
  await s.api('manager', 'PUT', '/settings', { STR_NGAY: 500 });
  assert.ok(!(await viec()).some((v) => v.doi_tuong.id === cu && v.doi_tuong.loai === 'dong'));
  await s.api('manager', 'PUT', '/settings', { STR_NGAY: 365, MYCO_NGAY: 30 });
  assert.equal(hs.mycoplasma.qua_han, true);
  assert.equal((await s.api('alice', 'GET', `/cell-lines/${cu}`)).json.mycoplasma.qua_han, false, 'chu kỳ 30 ngày, thử hôm qua');
  await s.api('manager', 'PUT', '/settings', { MYCO_NGAY: 180 });

  // dương tính: khẩn, email báo ngay
  s.mails.length = 0;
  await qc(cu, 'mycoplasma', 'duong_tinh', lui(0));
  await cho();
  const dt = (await viec()).find((v) => v.loai === 'myco_duong_tinh' && v.doi_tuong.id === cu);
  assert.equal(dt.muc, 'do');
  const thu = s.mails.filter((m) => m.subject.includes('mycoplasma dương tính'));
  assert.deepEqual(thu.map((m) => m.to).sort(), ['manager@sci.edu.vn'], 'quản lý nhận; alice là người ghi nên không nhận lại');
  assert.match(thu[0].text, /DƯƠNG TÍNH/);

  // dòng hết ống đang giữ thì không nhắc nữa
  s.db.prepare("UPDATE nhm_tubes SET status = 'discarded' WHERE lo_id IN (SELECT id FROM nhm_lo WHERE dong_id = ?)").run(cu);
  assert.ok(!(await viec()).some((v) => v.doi_tuong.id === cu && v.doi_tuong.loai === 'dong'));
  // ngân hàng kháng thể không có QC dòng tế bào
  assert.ok(!(await viec('manager', KT)).some((v) => v.doi_tuong.loai === 'dong'));
});

// ═══ Nhật ký nhiệt độ ═══

test('theo dõi nhiệt độ: cài đặt, ghi số đo, cảnh báo ra ngoài khoảng (một cảnh báo mở), thư báo, ghi nhận xử lý', async () => {
  const tb = (await s.api('manager', 'POST', '/containers', { name: 'Tủ -86 nhiệt', mau_tb: 'tu-86-dung-2-ngan' })).json.id;
  const ngan = (await s.api('manager', 'GET', '/tree')).json.containers.find((c) => c.parent_id === tb).id;
  const url = `/containers/${tb}/temperatures`;
  let t = (await s.api('alice', 'GET', url)).json;
  assert.deepEqual([t.theo_doi, t.nguong.duoi, t.nguong.tren, t.nguong.tu_dat, t.quyen_ghi, t.quyen_cai_dat], [false, -96, -70, false, true, false]);
  assert.equal((await s.api('alice', 'GET', `/containers/${ngan}/temperatures`)).status, 400, 'chỉ thiết bị gốc');
  assert.equal((await s.api('alice', 'PUT', `/containers/${tb}/monitoring`, { theo_doi: true })).status, 403);
  assert.equal((await s.api('manager', 'PUT', `/containers/${tb}/monitoring`, { theo_doi: true, nguong_duoi: -70, nguong_tren: -90 })).status, 400);
  assert.equal((await s.api('manager', 'PUT', `/containers/${tb}/monitoring`, { theo_doi: true })).status, 200, 'dùng gợi ý theo -86°C');

  // ghi số đo: tủ Public thì ai cũng ghi được
  assert.equal((await s.api('alice', 'POST', url, { nhiet_do: 'abc' })).status, 400);
  assert.equal((await s.api('alice', 'POST', url, {})).status, 400);
  const tot = await s.api('alice', 'POST', url, { nhiet_do: -82.5, ghi_chu: 'Sáng 7h' });
  assert.deepEqual([tot.status, tot.json.ngoai_nguong, tot.json.canh_bao_id], [201, false, null]);
  assert.equal((await s.api('manager', 'GET', '/alarms')).json.alarms.length, 0);

  s.mails.length = 0;
  const xau = await s.api('alice', 'POST', url, { nhiet_do: -55 });
  assert.deepEqual([xau.status, xau.json.ngoai_nguong], [201, true]);
  assert.ok(xau.json.canh_bao_id);
  await cho();
  const thu = s.mails.filter((m) => m.subject.includes('CẢNH BÁO nhiệt độ'));
  assert.deepEqual(thu.map((m) => m.to), ["manager@sci.edu.vn"]);
  assert.match(thu[0].text, /-55/);
  assert.match(thu[0].text, /-96 đến -70/);
  // số đo xấu tiếp theo trong lúc đang mở: chỉ vào nhật ký, không thêm cảnh báo, không gửi thêm thư
  s.mails.length = 0;
  const tiep = await s.api('alice', 'POST', url, { nhiet_do: -50 });
  assert.deepEqual([tiep.json.ngoai_nguong, tiep.json.canh_bao_id], [true, null]);
  await cho();
  assert.equal(s.mails.length, 0);
  assert.equal((await s.api('manager', 'GET', '/alarms')).json.alarms.length, 1);
  t = (await s.api('alice', 'GET', url)).json;
  assert.equal(t.canh_bao.nhiet_do, -55);
  assert.equal(t.so_do.length, 3);
  assert.deepEqual(t.so_do.map((x) => [x.nhiet_do, x.ngoai_nguong, x.user_label]), [[-82.5, 0, 'alice@sci.edu.vn'], [-55, 1, 'alice@sci.edu.vn'], [-50, 1, 'alice@sci.edu.vn']]);
  const cay = (await s.api('manager', 'GET', '/tree')).json.containers.find((c) => c.id === tb);
  assert.deepEqual([cay.theo_doi_nhiet, cay.canh_bao_nhiet], [1, 1]);
  assert.ok((await viec()).some((v) => v.loai === 'nhiet_canh_bao' && v.container_id === tb && v.muc === 'do'));

  // nhật ký không sửa / xóa được
  assert.throws(() => s.db.prepare('UPDATE nhm_nhiet_do SET nhiet_do = 0').run(), /chỉ được thêm/);
  assert.throws(() => s.db.prepare('DELETE FROM nhm_nhiet_do').run(), /chỉ được thêm/);

  // ghi nhận xử lý: người thường không; cần mô tả; cảnh báo đóng thì số đo xấu kế tiếp mở cảnh báo mới
  const wid = t.canh_bao.id;
  assert.equal((await s.api('alice', 'POST', `/alarms/${wid}/resolve`, { ly_do: 'Đã xử lý xong rồi' })).status, 403);
  assert.equal((await s.api('manager', 'POST', `/alarms/${wid}/resolve`, { ly_do: 'ok' })).status, 400);
  assert.equal((await s.api('manager', 'POST', `/alarms/${wid}/resolve`, { ly_do: 'Cửa tủ hở, đóng lại; mẫu không phải chuyển' })).status, 200);
  assert.equal((await s.api('manager', 'POST', `/alarms/${wid}/resolve`, { ly_do: 'Cửa tủ hở, đóng lại' })).status, 409);
  assert.equal((await s.api('manager', 'GET', '/alarms')).json.alarms.length, 0);
  assert.equal((await s.api('manager', 'GET', '/alarms?status=all')).json.alarms[0].trang_thai, 'da_xu_ly');
  assert.ok((await s.api('alice', 'POST', url, { nhiet_do: -40 })).json.canh_bao_id, 'cảnh báo mới sau khi đã xử lý cái cũ');

  // tắt theo dõi: vẫn ghi được số đo, nhưng không mở cảnh báo mới
  await s.api('manager', 'POST', `/alarms/${(await s.api('manager', 'GET', '/alarms')).json.alarms[0].id}/resolve`, { ly_do: 'Đã kiểm tra, chuyển mẫu sang tủ khác' });
  await s.api('manager', 'PUT', `/containers/${tb}/monitoring`, { theo_doi: false });
  assert.equal((await s.api('alice', 'POST', url, { nhiet_do: -30 })).json.canh_bao_id, null);
});

test('quên ghi nhiệt độ quá chu kỳ thì nhắc; chu kỳ chỉnh được', async () => {
  const tb = (await s.api('manager', 'POST', '/containers', { name: 'Tủ quên ghi', mau_tb: 'tu-lanh-4-dung' })).json.id;
  await s.api('manager', 'PUT', `/containers/${tb}/monitoring`, { theo_doi: true });
  const quen = async () => (await viec()).find((x) => x.loai === 'nhiet_quen' && x.container_id === tb);
  assert.ok(!(await quen()), 'vừa bật theo dõi');
  s.db.prepare("UPDATE nhm_containers SET updated_at = datetime('now', '-5 days') WHERE id = ?").run(tb);
  assert.match((await quen()).chi_tiet, /Chưa có số đo nào/);
  await s.api('alice', 'POST', `/containers/${tb}/temperatures`, { nhiet_do: 4.5 });
  assert.ok(!(await quen()), 'vừa ghi xong');
  // số đo cuối cách đây 4 ngày: nhật ký không sửa được nên dựng lại bảng bằng cách tạm gỡ trigger xóa
  s.db.exec('DROP TRIGGER trg_nhm_nhiet_do_khong_xoa');
  s.db.prepare('DELETE FROM nhm_nhiet_do WHERE container_id = ?').run(tb);
  s.db.exec("CREATE TRIGGER trg_nhm_nhiet_do_khong_xoa BEFORE DELETE ON nhm_nhiet_do BEGIN SELECT RAISE(ABORT, 'Số đo nhiệt độ chỉ được thêm, không được xóa'); END");
  s.db.prepare("INSERT INTO nhm_nhiet_do (container_id, nhiet_do, user_label, ghi_luc) VALUES (?, 4, 'cũ', datetime('now', '-4 days'))").run(tb);
  assert.match((await quen()).chi_tiet, /đã quá 3 ngày/);
  await s.api('manager', 'PUT', '/settings', { NHIET_GHI_NGAY: 7 });
  assert.ok(!(await quen()));
  await s.api('manager', 'PUT', '/settings', { NHIET_GHI_NGAY: 3 });
  assert.equal((await s.api('alice', 'GET', `/containers/${tb}/temperatures`)).json.qua_han_ghi, true);
});

test('bình nitơ ghi thêm mức nitơ; thiết bị có đơn vị quản lý chỉ quản lý ghi; thiết bị riêng người khác không thấy; chưa có nhiệt độ chuẩn thì phải tự đặt khoảng', async () => {
  const binh = (await s.api('manager', 'POST', '/containers', { name: 'Bình LN theo dõi', mau_tb: 'binh-ln' })).json.id;
  assert.equal((await s.api('alice', 'POST', `/containers/${binh}/temperatures`, { nhiet_do: -190, muc_nito: 85 })).status, 201);
  const t = (await s.api('alice', 'GET', `/containers/${binh}/temperatures`)).json;
  assert.deepEqual([t.thiet_bi.la_binh_nito, t.so_do[0].muc_nito, t.nguong.tren], [true, 85, -150]);
  assert.equal((await s.api('alice', 'POST', `/containers/${binh}/temperatures`, { nhiet_do: -190, muc_nito: 9999 })).status, 400);

  const dv = (await s.api('admin', 'POST', '/units', { ten: 'Phòng theo dõi nhiệt', nguoi_duyet: [6] })).json.id;
  const cb = (await s.api('manager', 'POST', '/containers', { name: 'Tủ đơn vị nhiệt', mau_tb: 'tu-86-dung-2-ngan', don_vi_id: dv })).json.id;
  assert.equal((await s.api('alice', 'POST', `/containers/${cb}/temperatures`, { nhiet_do: -80 })).status, 403, 'người thường không ghi vào thiết bị đơn vị');
  assert.equal((await s.api('truong', 'POST', `/containers/${cb}/temperatures`, { nhiet_do: -80 })).status, 201, 'người duyệt của đơn vị ghi được');
  assert.equal((await s.api('manager', 'POST', `/containers/${cb}/temperatures`, { nhiet_do: -81 })).status, 201);
  assert.equal((await s.api('alice', 'GET', `/containers/${cb}/temperatures`)).json.quyen_ghi, false);

  const rieng = (await s.api('truong', 'POST', '/containers', { name: 'Tủ riêng nhiệt', type_id: kho.type, rieng: true, temperature_c: -80 })).json.id;
  assert.equal((await s.api('manager', 'GET', `/containers/${rieng}/temperatures`)).status, 404, 'quản lý module không thấy thiết bị riêng');
  assert.equal((await s.api('manager', 'POST', `/containers/${rieng}/temperatures`, { nhiet_do: -80 })).status, 404);
  assert.equal((await s.api('truong', 'POST', `/containers/${rieng}/temperatures`, { nhiet_do: -80 })).status, 201, 'chủ ghi được');

  const khong = (await s.api('manager', 'POST', '/containers', { name: 'Tủ tự khai', type_id: kho.type })).json.id;
  assert.equal((await s.api('manager', 'PUT', `/containers/${khong}/monitoring`, { theo_doi: true })).status, 400, 'chưa có nhiệt độ chuẩn');
  assert.equal((await s.api('manager', 'PUT', `/containers/${khong}/monitoring`, { theo_doi: true, nguong_duoi: 15, nguong_tren: 30 })).status, 200);
});

// ═══ Thư nhắc định kỳ ═══

test('bộ quét gửi thư nhắc gộp theo người, không gửi lại trong chu kỳ nhắc, nhắc lại khi đủ ngày; việc xong thì được quên; thiết bị riêng chỉ nhắc chủ', async () => {
  s.db.prepare('DELETE FROM nhm_nhac_viec').run();
  const tb = (await s.api('manager', 'POST', '/containers', { name: 'Tủ nhắc việc', type_id: kho.type })).json.id;
  const h = (await s.api('manager', 'POST', '/boxes', { container_id: tb, template_id: kho.tpl99, name: 'Hộp nhắc' })).json.ids[0];
  await them('alice', h, 1, 1);
  s.db.prepare("UPDATE nhm_boxes SET created_at = datetime('now', '-300 days') WHERE id = ?").run(h);

  s.mails.length = 0;
  const kq = await s.router.quetNhacViec();
  assert.ok(kq.viec >= 1 && kq.nguoi >= 1);
  const thuQl = s.mails.filter((m) => m.to === 'manager@sci.edu.vn' && /việc đến hạn/.test(m.subject));
  assert.equal(thuQl.length, 1, 'một thư gộp cho mỗi người dù có nhiều việc');
  assert.match(thuQl[0].text, /Đến hạn kiểm kê: Tủ nhắc việc/);
  assert.match(thuQl[0].text, /#den-han/);
  assert.ok(!s.mails.some((m) => m.to === 'alice@sci.edu.vn'), 'người thường không nhận thư nhắc của quản lý');

  s.mails.length = 0;
  assert.deepEqual(await s.router.quetNhacViec(), { viec: 0, nguoi: 0 }, 'chưa đủ chu kỳ nhắc lại');
  assert.equal(s.mails.length, 0);
  const sau = await s.router.quetNhacViec(Date.now() + 8 * 86400000); // chu kỳ nhắc lại 7 ngày
  assert.ok(sau.viec >= 1);
  const mauId = s.db.prepare('SELECT id FROM nhm_tubes WHERE box_id = ?').get(h).id;
  await s.api('manager', 'POST', `/boxes/${h}/audit`, { thay: [mauId], khong_thay: [] });
  await s.router.quetNhacViec();
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM nhm_nhac_viec WHERE khoa = ?').get('te_bao:kiem_ke:' + tb).c, 0, 'việc xong thì quên');

  // thiết bị riêng: chỉ chủ nhận thư, quản lý module không
  s.mails.length = 0;
  const rieng = (await s.api('truong', 'POST', '/containers', { name: 'Tủ riêng nhắc', type_id: kho.type, rieng: true })).json.id;
  const hr = (await s.api('truong', 'POST', '/boxes', { container_id: rieng, template_id: kho.tpl99 })).json.ids[0];
  await them('truong', hr, 1, 1);
  s.db.prepare("UPDATE nhm_boxes SET created_at = datetime('now', '-300 days') WHERE id = ?").run(hr);
  await s.router.quetNhacViec();
  assert.ok(s.mails.some((m) => m.to === 'truong@sci.edu.vn' && /Tủ riêng nhắc/.test(m.text)), 'chủ nhận');
  assert.ok(!s.mails.some((m) => m.to === 'manager@sci.edu.vn' && /Tủ riêng nhắc/.test(m.text)), 'quản lý module không biết thiết bị riêng');
  assert.ok(!(await viec('manager')).some((v) => v.container_id === rieng));
  assert.ok((await viec('truong')).some((v) => v.container_id === rieng));
  assert.ok((await viec('admin')).some((v) => v.container_id === rieng));
});

test('SMTP hỏng không làm quét lỗi; chu kỳ: kiểm tra khoảng, quyền, khôi phục mặc định, ghi nhật ký', async () => {
  s.mailLoi = true;
  await assert.doesNotReject(s.router.quetNhacViec(Date.now() + 30 * 86400000));
  s.mailLoi = false;

  const r = (await s.api('alice', 'GET', '/settings')).json;
  assert.deepEqual(r.chu_ky, { KIEM_KE_NGAY: 180, MYCO_NGAY: 180, STR_NGAY: 365, NHIET_GHI_NGAY: 3, NHAC_LAI_NGAY: 7 });
  assert.deepEqual(r.han, { PHAN_HOI_NGAY: 3, CHO_BO_NGAY: 7, CHO_NHAN_NGAY: 14 }, 'ba hạn chờ cũ giữ nguyên');
  assert.equal((await s.api('alice', 'PUT', '/settings', { STR_NGAY: 200 })).status, 403);
  for (const [k, bad] of [['KIEM_KE_NGAY', 29], ['MYCO_NGAY', 731], ['STR_NGAY', 89], ['NHIET_GHI_NGAY', 0], ['NHAC_LAI_NGAY', 31], ['NHAC_LAI_NGAY', 'abc']]) {
    assert.equal((await s.api('manager', 'PUT', '/settings', { [k]: bad })).status, 400, `${k}=${bad}`);
  }
  const luu = await s.api('manager', 'PUT', '/settings', { STR_NGAY: 200, PHAN_HOI_NGAY: 4 });
  assert.equal(luu.json.changed, 2);
  assert.equal(luu.json.chu_ky.STR_NGAY, 200);
  assert.match(s.auditLog.filter((a) => a.action === 'nhm_settings_update').pop().detail, /xác thực STR.*: 365 → 200 ngày/);
  assert.equal((await s.api('manager', 'PUT', '/settings', { STR_NGAY: 200 })).json.changed, 0);
  s.db.prepare("INSERT OR REPLACE INTO nhm_cau_hinh (key, value) VALUES ('chu_ky_myco_ngay', 'hỏng')").run();
  assert.equal(NV.layChuKy(s.db).MYCO_NGAY, 180, 'giá trị hỏng bị bỏ qua');
  await s.api('manager', 'PUT', '/settings', { ...r.chu_ky_mac_dinh, ...r.mac_dinh });
  assert.deepEqual((await s.api('alice', 'GET', '/settings')).json.chu_ky, r.chu_ky_mac_dinh);
});
