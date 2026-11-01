'use strict';

// Hai ngân hàng (tế bào / kháng thể) trong một module: dùng chung tài khoản, tách thiết bị, mẫu, người quản lý, đơn vị.
// Ngân hàng không chọn bị ẩn hoàn toàn (kể cả với admin); quản lý theo ngân hàng; AntibodyBank là đơn vị duy nhất của ngân hàng kháng thể (không có Public), chỉ Viện trưởng duyệt, quản lý theo dõi và giao mẫu.

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
  // thiết bị kháng thể thuộc AntibodyBank (không có Public): người thường không tự thêm mẫu, quản lý thêm
  assert.equal((await s.api('alice', 'POST', '/tubes', { box_id: hopKt, row_no: 1, col_no: 1, name: 'Kháng thể anti-CD34', chu_loai: 'can_bo', the_tich_ul: 200 }, KT)).status, 403);
  const m = await s.api('manager', 'POST', '/tubes', { box_id: hopKt, row_no: 1, col_no: 1, name: 'Kháng thể anti-CD34', chu_loai: 'can_bo', the_tich_ul: 200 }, KT);
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

test('đơn vị theo ngân hàng: AntibodyBank của ngân hàng kháng thể, Cellbank của ngân hàng tế bào; kháng thể không có Public', async () => {
  const donVi = async (nh) => (await s.api('manager', 'GET', '/units', null, nh)).json.units;
  assert.deepEqual((await donVi(TB)).map((u) => u.ma), ['cellbank']);
  assert.deepEqual((await donVi(KT)).map((u) => u.ma), ['antibodybank']);
  assert.deepEqual((await s.api('bob', 'GET', '/meta', null, KT)).json.donVi.map((d) => d.ten), ['AntibodyBank']);
  assert.equal((await s.api('bob', 'GET', '/meta', null, KT)).json.khongPublic, true);
  assert.equal((await s.api('bob', 'GET', '/meta', null, TB)).json.khongPublic, false);
  const ab = (await donVi(KT))[0];
  const cb = (await donVi(TB))[0];
  assert.equal(ab.mac_dinh, true);
  assert.equal(ab.chi_vien_truong, true);
  assert.deepEqual(ab.nguoi_duyet, [], 'không gán tay người duyệt');
  assert.ok(ab.quan_ly.some((u) => u.user_id === 2), 'liệt kê quản lý ngân hàng kháng thể');
  assert.equal((await s.api('admin', 'DELETE', `/units/${ab.id}`, null, KT)).status, 400, 'AntibodyBank không xóa được');
  assert.equal((await s.api('admin', 'DELETE', `/units/${ab.id}`, null, TB)).status, 404, 'đơn vị của ngân hàng khác như không có');
  assert.equal((await s.api('admin', 'POST', '/units', { ten: 'Phòng Ab phụ' }, KT)).status, 400, 'ngân hàng kháng thể chỉ có một đơn vị');
  assert.equal((await s.api('admin', 'PATCH', `/units/${ab.id}`, { nguoi_duyet: [6] }, KT)).status, 400, 'người duyệt luôn là Viện trưởng');
  // thiết bị: gắn đúng ngân hàng; kháng thể luôn thuộc AntibodyBank
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tbKt}`, { don_vi_id: cb.id }, KT)).status, 400, 'thiết bị kháng thể không gắn Cellbank');
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tbKt}`, { don_vi_id: null }, KT)).status, 400, 'không có Public');
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tbKt}`, { rieng: true }, KT)).status, 400, 'không có thiết bị riêng');
  assert.equal((await s.api('manager', 'PATCH', `/containers/${tbKt}`, { don_vi_id: ab.id }, KT)).status, 200);
  const cay = (await s.api('manager', 'GET', '/tree', null, KT)).json.containers;
  assert.ok(cay.filter((c) => c.parent_id == null).every((c) => c.don_vi_id === ab.id && c.don_vi_ten === 'AntibodyBank'), 'mọi thiết bị gốc thuộc AntibodyBank');
  assert.equal(cay.find((c) => c.id === tbKt).don_vi_duyet, 'Viện trưởng');
  // thiết bị tạo không nói đơn vị vẫn thuộc AntibodyBank (không thành Public)
  const moi = await s.api('manager', 'POST', '/containers', { name: 'Tủ KT chưa chọn đơn vị', type_id: kho.type }, KT);
  assert.equal(moi.status, 201);
  assert.equal((await s.api('manager', 'GET', '/tree', null, KT)).json.containers.find((c) => c.id === moi.json.id).don_vi_id, ab.id);
});

test('yêu cầu ở ngân hàng kháng thể: chỉ Viện trưởng duyệt, quản lý theo dõi và giao mẫu, thư gửi đúng người', async () => {
  const doi = () => new Promise((r) => setTimeout(r, 60));
  const toi = (email) => s.mails.filter((m) => m.to === email);
  // chưa có Viện trưởng: không gửi được yêu cầu (không chuyển cho quản lý hay admin)
  const r0 = await s.api('bob', 'POST', `/tubes/${mauKt}/requests`, { ly_do: 'Chưa có Viện trưởng', so_ul: 20 }, KT);
  assert.equal(r0.status, 409);
  assert.match(r0.json.message, /Chưa có Viện trưởng/);

  // cấp vai trò Viện trưởng (user 6)
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 6, vai_tro: 'vien_truong' })).status, 201);
  assert.equal((await s.api('truong', 'POST', '/containers', { name: 'Tủ riêng KT', type_id: kho.type, rieng: true }, KT)).status, 400, 'Viện trưởng cũng không tạo thiết bị riêng ở ngân hàng kháng thể');
  s.mails.length = 0;
  const r1 = await s.api('bob', 'POST', `/tubes/${mauKt}/requests`, { ly_do: 'Cần dùng', so_ul: 20 }, KT);
  assert.equal(r1.status, 201);
  assert.equal(r1.json.cap, 'truong_cellbank');
  assert.equal(r1.json.cap_ten, 'Viện trưởng');
  await doi();
  assert.ok(s.mails.every((m) => m.subject.startsWith('[Ngân hàng kháng thể]')), 'tiêu đề thư ghi ngân hàng kháng thể');
  assert.equal(toi('truong@sci.edu.vn').length, 1, 'Viện trưởng được báo để duyệt');
  assert.match(toi('truong@sci.edu.vn')[0].subject, /Yêu cầu lấy mẫu:/);
  assert.equal(toi('manager@sci.edu.vn').length, 1, 'quản lý được báo để theo dõi');
  assert.match(toi('manager@sci.edu.vn')[0].subject, /chờ Viện trưởng duyệt/);
  assert.equal(toi('bob@sci.edu.vn').length, 0, 'người gửi không nhận thư về yêu cầu của mình');

  // quản lý theo dõi (có trong «Cần tôi xử lý» nhưng đánh dấu theo_doi, không có quyền duyệt)
  const hop = (await s.api('manager', 'GET', '/requests?view=inbox', null, KT)).json.requests.find((y) => y.id === r1.json.id);
  assert.equal(hop.theo_doi, true);
  assert.equal(hop.co_the_xu_ly, false);
  assert.equal(hop.co_the_giao, false);
  assert.equal((await s.api('manager', 'POST', `/requests/${r1.json.id}/approve`, {}, KT)).status, 403);
  assert.equal((await s.api('manager', 'POST', `/requests/${r1.json.id}/reject`, { ly_do: 'không', so_ul: 20 }, KT)).status, 403);
  assert.equal((await s.api('manager', 'POST', `/requests/${r1.json.id}/deliver`, null, KT)).status, 409, 'chưa duyệt thì chưa giao');
  const choTruong = (await s.api('truong', 'GET', '/requests?view=inbox', null, KT)).json.requests.find((y) => y.id === r1.json.id);
  assert.equal(choTruong.co_the_xu_ly, true);
  assert.equal(choTruong.theo_doi, false);

  // quá hạn không chuyển cho quản lý
  assert.deepEqual(await s.router.quetQuaHan(Date.now() + 10 * 86400000), { leoThang: 0 });
  assert.equal((await s.api('truong', 'GET', '/requests?view=inbox', null, KT)).json.requests.find((y) => y.id === r1.json.id).cap, 'truong_cellbank');

  // Viện trưởng duyệt → thư cho người yêu cầu và quản lý (quản lý nhận thư riêng «cần giao mẫu»)
  s.mails.length = 0;
  assert.equal((await s.api('truong', 'POST', `/requests/${r1.json.id}/approve`, {}, KT)).status, 200);
  await doi();
  assert.equal(toi('bob@sci.edu.vn').length, 1);
  assert.match(toi('bob@sci.edu.vn')[0].subject, /Đã duyệt yêu cầu lấy mẫu/);
  assert.equal(toi('manager@sci.edu.vn').length, 1);
  assert.match(toi('manager@sci.edu.vn')[0].subject, /cần giao mẫu/);
  assert.equal(toi('truong@sci.edu.vn').length, 0, 'người vừa duyệt không nhận lại');

  // quản lý thực thi: giao rồi nhận lại; người thường và Viện trưởng không giao
  assert.equal((await s.api('bob', 'POST', `/requests/${r1.json.id}/deliver`, null, KT)).status, 403);
  assert.equal((await s.api('truong', 'POST', `/requests/${r1.json.id}/deliver`, null, KT)).status, 403, 'Viện trưởng duyệt, không giao');
  const daDuyet = (await s.api('manager', 'GET', '/requests?view=inbox', null, KT)).json.requests.find((y) => y.id === r1.json.id);
  assert.equal(daDuyet.co_the_giao, true);
  assert.equal(daDuyet.theo_doi, false);
  assert.equal((await s.api('manager', 'POST', `/requests/${r1.json.id}/deliver`, null, KT)).status, 200);
  assert.equal((await s.api('manager', 'POST', `/requests/${r1.json.id}/return`, null, KT)).status, 200);

  // Viện trưởng từ chối: người yêu cầu và quản lý được báo
  const r2 = await s.api('bob', 'POST', `/tubes/${mauKt}/requests`, { ly_do: 'Lần hai', so_ul: 20 }, KT);
  await doi();
  s.mails.length = 0;
  assert.equal((await s.api('truong', 'POST', `/requests/${r2.json.id}/reject`, { ly_do: 'Chưa cần', so_ul: 20 }, KT)).status, 200);
  await doi();
  assert.equal(toi('bob@sci.edu.vn').length, 1);
  assert.equal(toi('manager@sci.edu.vn').length, 1);

  // admin cũng không duyệt thay Viện trưởng
  const r4 = await s.api('bob', 'POST', `/tubes/${mauKt}/requests`, { ly_do: 'Admin thử duyệt', so_ul: 20 }, KT);
  assert.equal((await s.api('admin', 'POST', `/requests/${r4.json.id}/approve`, {}, KT)).status, 403);
  assert.equal((await s.api('bob', 'POST', `/requests/${r4.json.id}/cancel`, null, KT)).status, 200);

  // Viện trưởng không có Viện trưởng nào khác duyệt thì không gửi yêu cầu cho chính mình (lấy mẫu trực tiếp)
  const r3 = await s.api('truong', 'POST', `/tubes/${mauKt}/requests`, { ly_do: 'Viện trưởng tự xin', so_ul: 20 }, KT);
  assert.equal(r3.status, 409);
  assert.match(r3.json.message, /lấy mẫu trực tiếp/);

  // lịch sử của mẫu ghi đủ quá trình: gửi (người duyệt + quản lý theo dõi), duyệt (người duyệt, người được báo), giao, nhận lại, từ chối, hủy
  const ls = (await s.api('bob', 'GET', `/tubes/${mauKt}/history`, null, KT)).json.history.slice().reverse();
  const hanhDong = ls.map((x) => x.action);
  assert.deepEqual(hanhDong.filter((a) => a.startsWith('yc_') || a === 'giao' || a === 'tra'), ['yc_gui', 'yc_duyet', 'giao', 'tra', 'yc_gui', 'yc_tu_choi', 'yc_gui', 'yc_huy']);
  const gui = ls.find((x) => x.action === 'yc_gui');
  assert.match(gui.note, /Viện trưởng duyệt \(truong@sci\.edu\.vn\)/);
  assert.match(gui.note, /quản lý theo dõi: .*manager@sci\.edu\.vn/);
  assert.match(gui.note, /Lý do: Cần dùng/);
  const duyet = ls.find((x) => x.action === 'yc_duyet');
  assert.equal(duyet.user_id, 6);
  assert.match(duyet.note, /Duyệt yêu cầu #\d+ của bob@sci\.edu\.vn.*báo người yêu cầu và quản lý: .*manager@sci\.edu\.vn/);
  assert.match(ls.find((x) => x.action === 'giao').note, /Giao cho bob@sci\.edu\.vn \(yêu cầu #\d+, truong@sci\.edu\.vn đã duyệt\)/);
  assert.equal(ls.find((x) => x.action === 'giao').user_id, 2, 'quản lý thực thi');
  assert.match(ls.find((x) => x.action === 'yc_tu_choi').note, /Từ chối yêu cầu .*Chưa cần/);
  assert.equal((await s.api('truong', 'GET', '/requests?view=done', null, TB)).json.requests.some((y) => y.id === r1.json.id), false);
  assert.equal((await s.api('bob', 'GET', `/requests/${r1.json.id}/print`, null, TB)).status, 404);
  const p = await fetch(`${s.base}/requests/${r1.json.id}/print?nh=khang_the`, { headers: { 'x-test-user': 'bob' } });
  assert.equal(p.status, 200);
  const html = await p.text();
  assert.match(html, /Ngân hàng kháng thể/);
  assert.match(html, /AntibodyBank/);
});
