'use strict';

// Ủy quyền duyệt ở ngân hàng kháng thể: Viện trưởng giao quyền duyệt một phần kháng thể cho quản lý; có hạn, thu hồi được, ghi lại ai duyệt theo ủy quyền nào.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

const KT = 'khang_the';
let s;
let kho;
let tb; // thiết bị kháng thể
let hop1;
let hop2;
let cd34;
let cd45;
const cho = () => new Promise((r) => setTimeout(r, 60));
const toi = (email) => s.mails.filter((m) => m.to === email);
const ong = async (hop, row, ten) => (await s.api('manager', 'POST', '/tubes', { box_id: hop, row_no: row, col_no: 1, name: ten, chu_loai: 'can_bo', the_tich_ul: 100 }, KT)).json.id;
const yc = (user, id) => s.api(user, 'POST', `/tubes/${id}/requests`, { ly_do: 'Nhuộm', so_ul: 10 }, KT);
const uq = (user, body) => s.api(user, 'POST', '/delegations', body, KT);
const inbox = async (user) => (await s.api(user, 'GET', '/requests?view=inbox', null, KT)).json.requests;

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  tb = (await s.api('manager', 'POST', '/containers', { name: 'Tủ -20 KT', type_id: kho.type }, KT)).json.id;
  hop1 = (await s.api('manager', 'POST', '/boxes', { container_id: tb, template_id: kho.tpl99, name: 'Hộp 1' }, KT)).json.ids[0];
  hop2 = (await s.api('manager', 'POST', '/boxes', { container_id: tb, template_id: kho.tpl99, name: 'Hộp 2' }, KT)).json.ids[0];
  cd34 = await ong(hop1, 1, 'Anti-CD34');
  cd45 = await ong(hop2, 1, 'Anti-CD45');
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 6, vai_tro: 'vien_truong' })).status, 201); // Viện trưởng = truong
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly', ngan_hang: KT })).status, 201); // quản lý thứ hai = alice
});
test.after(() => s.dong());

test('chỉ Viện trưởng ủy quyền; chỉ cho quản lý ngân hàng kháng thể; phạm vi và hạn được kiểm tra; chỉ dùng ở ngân hàng kháng thể', async () => {
  const hopLe = { nguoi_id: 3, pham_vi: 'ten_mau', ten_mau: 'anti-cd34' };
  assert.equal((await uq('manager', hopLe)).status, 403, 'quản lý không tự ủy quyền');
  assert.equal((await uq('admin', hopLe)).status, 403, 'admin cũng không');
  assert.equal((await uq('bob', hopLe)).status, 403);
  assert.equal((await uq('truong', { ...hopLe, nguoi_id: 4 })).status, 400, 'bob không phải quản lý');
  assert.equal((await uq('truong', { ...hopLe, nguoi_id: 6 })).status, 400, 'không tự ủy quyền cho mình');
  assert.equal((await uq('truong', { ...hopLe, pham_vi: 'xyz' })).status, 400);
  assert.equal((await uq('truong', { nguoi_id: 3, pham_vi: 'ten_mau', ten_mau: '  ' })).status, 400);
  assert.equal((await uq('truong', { nguoi_id: 3, pham_vi: 'hop', hop_id: 99999 })).status, 400);
  assert.equal((await uq('truong', { nguoi_id: 3, pham_vi: 'hop', hop_id: kho.box })).status, 400, 'hộp của ngân hàng tế bào');
  assert.equal((await uq('truong', { nguoi_id: 3, pham_vi: 'vi_tri', vi_tri_id: kho.container || 1 })).status, 400, 'thiết bị của ngân hàng tế bào');
  assert.equal((await uq('truong', { ...hopLe, den_ngay: '2000-01-01' })).status, 400, 'ngày hết hạn đã qua');
  assert.equal((await uq('truong', { ...hopLe, den_ngay: '31/12/2030' })).status, 400, 'sai định dạng ngày');
  assert.equal((await s.api('truong', 'GET', '/delegations', null)).status, 400, 'ngân hàng tế bào không có ủy quyền');
  // xem danh sách: Viện trưởng và quản lý; người thường không
  assert.equal((await s.api('bob', 'GET', '/delegations', null, KT)).status, 403);
  const ds = (await s.api('truong', 'GET', '/delegations', null, KT)).json;
  assert.equal(ds.la_vien_truong, true);
  assert.deepEqual(ds.ung_vien.map((u) => u.id).sort(), [2, 3]);
  assert.deepEqual((await s.api('alice', 'GET', '/delegations', null, KT)).json.ung_vien, [], 'quản lý chỉ xem');
});

test('ủy quyền theo tên kháng thể: người được ủy quyền cùng duyệt, người khác chỉ theo dõi; thư và lịch sử ghi ủy quyền', async () => {
  s.mails.length = 0;
  const d = await uq('truong', { nguoi_id: 3, pham_vi: 'ten_mau', ten_mau: 'ANTI-cd34', ghi_chu: 'Tuần này tôi đi công tác' });
  assert.equal(d.status, 201);
  await cho();
  assert.equal(toi('alice@sci.edu.vn').length, 1, 'người được ủy quyền nhận thư');
  assert.match(toi('alice@sci.edu.vn')[0].subject, /Bạn được ủy quyền duyệt/);
  s.mails.length = 0;

  const y = await yc('bob', cd34);
  assert.equal(y.status, 201);
  await cho();
  assert.equal(toi('truong@sci.edu.vn').length, 1);
  assert.equal(toi('alice@sci.edu.vn').length, 1, 'người được ủy quyền được báo như người duyệt');
  assert.match(toi('alice@sci.edu.vn')[0].subject, /Yêu cầu lấy mẫu:/);
  assert.equal(toi('manager@sci.edu.vn').length, 1);
  assert.match(toi('manager@sci.edu.vn')[0].subject, /chờ Viện trưởng duyệt/, 'quản lý không được ủy quyền chỉ theo dõi');
  const mailAlice = toi('alice@sci.edu.vn')[0];
  assert.match(mailAlice.text, /Được Viện trưởng ủy quyền duyệt: alice@sci\.edu\.vn/);

  const cua = (await inbox('alice')).find((x) => x.id === y.json.id);
  assert.equal(cua.co_the_xu_ly, true);
  assert.equal(cua.theo_doi, false);
  assert.deepEqual(cua.nguoi_duoc_uy_quyen, ['alice@sci.edu.vn']);
  assert.equal((await inbox('manager')).find((x) => x.id === y.json.id).co_the_xu_ly, false);
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/approve`, {}, KT)).status, 403);

  // kháng thể khác (không thuộc ủy quyền): alice không duyệt được
  const y45 = await yc('bob', cd45);
  assert.equal((await inbox('alice')).find((x) => x.id === y45.json.id).co_the_xu_ly, false);
  assert.equal((await s.api('alice', 'POST', `/requests/${y45.json.id}/approve`, {}, KT)).status, 403);
  assert.equal((await s.api('bob', 'POST', `/requests/${y45.json.id}/cancel`, null, KT)).status, 200);

  // alice duyệt theo ủy quyền
  s.mails.length = 0;
  assert.equal((await s.api('alice', 'POST', `/requests/${y.json.id}/approve`, {}, KT)).status, 200);
  await cho();
  const mailBob = toi('bob@sci.edu.vn')[0];
  assert.match(mailBob.text, /duyệt theo ủy quyền của Viện trưởng truong@sci\.edu\.vn/);
  assert.equal(toi('truong@sci.edu.vn').length >= 1, true, 'Viện trưởng được báo kết quả');
  const row = s.db.prepare('SELECT uy_quyen_id, xu_ly_boi, xu_ly_thay FROM nhm_yeu_cau WHERE id = ?').get(y.json.id);
  assert.deepEqual([row.uy_quyen_id, row.xu_ly_boi, row.xu_ly_thay], [d.json.id, 3, 0]);
  const ls = (await s.api('bob', 'GET', `/tubes/${cd34}/history`, null, KT)).json.history.find((x) => x.action === 'yc_duyet');
  assert.match(ls.note, /theo ủy quyền của Viện trưởng truong@sci\.edu\.vn \(#\d+\)/);
  assert.equal(ls.user_id, 3);
  const the = (await s.api('manager', 'GET', '/requests?view=all', null, KT)).json.requests.find((x) => x.id === y.json.id);
  assert.equal(the.uy_quyen_ten, 'truong@sci.edu.vn');
  // quản lý giao theo lệnh duyệt như bình thường
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/deliver`, null, KT)).status, 200);
  // phiếu in ghi ủy quyền
  const p = await fetch(`${s.base}/requests/${y.json.id}/print?nh=khang_the`, { headers: { 'x-test-user': 'bob' } });
  assert.match(await p.text(), /theo ủy quyền của Viện trưởng truong@sci\.edu\.vn/);
  // Viện trưởng duyệt trực tiếp thì không ghi ủy quyền
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/return`, null, KT)).status, 200);
  const y2 = await yc('bob', cd34);
  assert.equal((await s.api('truong', 'POST', `/requests/${y2.json.id}/approve`, {}, KT)).status, 200);
  assert.equal(s.db.prepare('SELECT uy_quyen_id FROM nhm_yeu_cau WHERE id = ?').get(y2.json.id).uy_quyen_id, null);
  assert.equal((await s.api('manager', 'POST', `/requests/${y2.json.id}/deliver`, null, KT)).status, 200);
  assert.equal((await s.api('manager', 'POST', `/requests/${y2.json.id}/return`, null, KT)).status, 200);
});

test('không tự duyệt yêu cầu của chính mình; Viện trưởng tự yêu cầu thì người được ủy quyền duyệt', async () => {
  const cua = await yc('alice', cd34);
  assert.equal(cua.status, 201, 'alice yêu cầu: Viện trưởng duyệt');
  assert.equal((await s.api('alice', 'POST', `/requests/${cua.json.id}/approve`, {}, KT)).status, 403, 'không tự duyệt yêu cầu của mình');
  assert.equal((await s.api('truong', 'POST', `/requests/${cua.json.id}/reject`, { ly_do: 'Để sau' }, KT)).status, 200);
  const vt = await yc('truong', cd34);
  assert.equal(vt.status, 201, 'Viện trưởng yêu cầu được vì có người được ủy quyền duyệt');
  assert.equal((await s.api('truong', 'POST', `/requests/${vt.json.id}/approve`, {}, KT)).status, 403, 'không tự duyệt của mình');
  assert.equal((await s.api('alice', 'POST', `/requests/${vt.json.id}/approve`, {}, KT)).status, 200);
  assert.equal((await s.api('manager', 'POST', `/requests/${vt.json.id}/deliver`, null, KT)).status, 200);
  assert.equal((await s.api('manager', 'POST', `/requests/${vt.json.id}/return`, null, KT)).status, 200);
});

test('thu hồi có hiệu lực ngay kể cả với yêu cầu đang chờ; hết hạn tự mất hiệu lực; thu hồi một lần', async () => {
  const hop = await uq('truong', { nguoi_id: 3, pham_vi: 'hop', hop_id: hop2 });
  assert.equal(hop.status, 201);
  const y = await yc('bob', cd45);
  assert.equal((await inbox('alice')).find((x) => x.id === y.json.id).co_the_xu_ly, true, 'hộp 2 thuộc ủy quyền');
  assert.equal((await s.api('manager', 'DELETE', `/delegations/${hop.json.id}`, null, KT)).status, 403, 'quản lý không thu hồi');
  s.mails.length = 0;
  assert.equal((await s.api('truong', 'DELETE', `/delegations/${hop.json.id}`, null, KT)).status, 200);
  await cho();
  assert.match(toi('alice@sci.edu.vn')[0].subject, /Đã thu hồi ủy quyền duyệt/);
  assert.equal((await inbox('alice')).find((x) => x.id === y.json.id).co_the_xu_ly, false, 'mất quyền ngay');
  assert.equal((await s.api('alice', 'POST', `/requests/${y.json.id}/approve`, {}, KT)).status, 403);
  assert.equal((await s.api('truong', 'DELETE', `/delegations/${hop.json.id}`, null, KT)).status, 409, 'đã thu hồi');
  assert.equal((await s.api('truong', 'DELETE', '/delegations/99999', null, KT)).status, 404);
  const trong = (await s.api('alice', 'GET', '/delegations', null, KT)).json.delegations.find((d) => d.id === hop.json.id);
  assert.equal(trong.trang_thai, 'thu_hoi', 'vẫn xem lại được trong lịch sử');
  assert.equal(trong.thu_hoi_boi_ten, 'truong@sci.edu.vn');

  // hết hạn: ủy quyền theo thiết bị có hạn; quá hạn thì không còn hiệu lực
  const dv = await uq('truong', { nguoi_id: 3, pham_vi: 'vi_tri', vi_tri_id: tb, den_ngay: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  assert.equal(dv.status, 201);
  assert.equal((await inbox('alice')).find((x) => x.id === y.json.id).co_the_xu_ly, true, 'cả thiết bị');
  s.db.prepare("UPDATE nhm_uy_quyen_duyet SET den_ngay = '2000-01-01' WHERE id = ?").run(dv.json.id);
  assert.equal((await inbox('alice')).find((x) => x.id === y.json.id).co_the_xu_ly, false, 'quá hạn');
  assert.equal((await s.api('alice', 'GET', '/delegations', null, KT)).json.delegations.find((d) => d.id === dv.json.id).trang_thai, 'het_han');
  // phạm vi cả ngân hàng
  const tat = await uq('truong', { nguoi_id: 2, pham_vi: 'ngan_hang' });
  assert.equal(tat.status, 201);
  assert.equal((await inbox('manager')).find((x) => x.id === y.json.id).co_the_xu_ly, true);
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/reject`, { ly_do: 'Chưa cần' }, KT)).status, 200);
  assert.match(s.db.prepare("SELECT note FROM nhm_movements WHERE tube_id = ? AND action = 'yc_tu_choi' ORDER BY id DESC LIMIT 1").get(cd45).note, /theo ủy quyền/);
});
