'use strict';

// Thể tích (µL) của ống kháng thể: ghi ban đầu, dùng, đo lại, sắp hết, giao / nhận lại theo yêu cầu, khi hết thì bỏ ống khỏi kho.
// Quản lý ngân hàng kháng thể ghi; Viện trưởng duyệt; sổ thể tích chỉ thêm, không sửa / xóa.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');
const TT = require('../services/nganHangTeBaoKhangTheTheTich');

const KT = 'khang_the';
let s;
let hop;
let kho;
const cho = () => new Promise((r) => setTimeout(r, 60));

const them = async (row, col, ul, ten = 'Anti-CD34') => {
  const r = await s.api('manager', 'POST', '/tubes', { box_id: hop, row_no: row, col_no: col, name: ten, chu_loai: 'can_bo', ...(ul != null ? { the_tich_ul: ul } : {}) }, KT);
  return r;
};
const volume = async (id) => (await s.api('alice', 'GET', `/tubes/${id}/volume`, null, KT)).json;
const xin = (user, id, ul) => s.api(user, 'POST', `/tubes/${id}/requests`, { ly_do: 'Nhuộm', ...(ul != null ? { so_ul: ul } : {}) }, KT);

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  const tb = await s.api('manager', 'POST', '/containers', { name: 'Tủ -20 KT', type_id: kho.type }, KT);
  hop = (await s.api('manager', 'POST', '/boxes', { container_id: tb.json.id, template_id: kho.tpl99, name: 'Hộp KT' }, KT)).json.ids[0];
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 6, vai_tro: 'vien_truong' })).status, 201);
});
test.after(() => s.dong());

test('hàm thuần: trạng thái theo tỉ lệ còn lại, đọc số µL', () => {
  assert.equal(TT.trangThai(null, null), 'chua_ghi');
  assert.equal(TT.trangThai(200, 200), 'con');
  assert.equal(TT.trangThai(200, 41), 'con');
  assert.equal(TT.trangThai(200, 40), 'sap_het');
  assert.equal(TT.trangThai(200, 0), 'het');
  assert.deepEqual(TT.docUl('12,34', 'x'), [12.3, null]);
  assert.ok(TT.docUl('0', 'x')[1] && TT.docUl('-5', 'x')[1] && TT.docUl('abc', 'x')[1] && TT.docUl('', 'x')[1]);
});

test('ống kháng thể phải ghi thể tích ban đầu khi thêm; ghi vào sổ và lịch sử mẫu; ống cũ ghi bổ sung; ngân hàng tế bào không dùng µL', async () => {
  assert.equal((await them(1, 1, null)).status, 400, 'thiếu thể tích ban đầu');
  assert.equal((await them(1, 1, 0)).status, 400);
  const r = await them(1, 1, 200);
  assert.equal(r.status, 201);
  const v = await volume(r.json.id);
  assert.equal(v.con_lai_ul, 200);
  assert.equal(v.the_tich_ul, 200);
  assert.equal(v.trang_thai, 'con');
  assert.equal(v.so.length, 1);
  assert.equal(v.so[0].hanh_dong, 'ban_dau');
  assert.equal(v.so[0].user_label, 'manager@sci.edu.vn');
  const ls = (await s.api('alice', 'GET', `/tubes/${r.json.id}/history`, null, KT)).json.history.map((x) => x.action);
  assert.ok(ls.includes('kt_ban_dau'));
  // nhiều ống cùng lô: mỗi ống có thể tích
  const lo = await s.api('manager', 'POST', '/tubes/bulk', { box_id: hop, row_no: 2, col_no: 1, count: 3, name: 'Lô', chu_loai: 'can_bo', the_tich_ul: 50 }, KT);
  assert.equal(lo.status, 201);
  for (const id of lo.json.ids) assert.equal((await volume(id)).con_lai_ul, 50);
  // ống cũ chưa ghi: người thường không ghi, quản lý ghi bổ sung một lần
  const cu = s.db.prepare("INSERT INTO nhm_tubes (box_id, row_no, col_no, name, chu_loai, owner_user_id) VALUES (?, 3, 1, 'Ống cũ', 'can_bo', 2)").run(hop).lastInsertRowid;
  assert.equal((await volume(cu)).trang_thai, 'chua_ghi');
  assert.equal((await s.api('alice', 'POST', `/tubes/${cu}/volume/initial`, { the_tich_ul: 100 }, KT)).status, 403);
  assert.equal((await s.api('manager', 'POST', `/tubes/${cu}/volume/use`, { so_ul: 5 }, KT)).status, 409, 'chưa ghi thì chưa dùng');
  assert.equal((await s.api('manager', 'POST', `/tubes/${cu}/volume/initial`, { the_tich_ul: 100 }, KT)).status, 200);
  assert.equal((await s.api('manager', 'POST', `/tubes/${cu}/volume/initial`, { the_tich_ul: 100 }, KT)).status, 409, 'chỉ ghi ban đầu một lần');
  // ngân hàng tế bào không có µL
  assert.equal((await s.api('alice', 'GET', `/tubes/${kho.tube || 99999}/volume`)).status, 404);
});

test('dùng không qua yêu cầu: trừ đúng, không vượt số còn lại, sắp hết báo quản lý, đo lại cần lý do', async () => {
  const id = (await them(4, 1, 200, 'Anti-CD45')).json.id;
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/volume/use`, { so_ul: 10 }, KT)).status, 403, 'người thường không ghi');
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/use`, { so_ul: 100, nguoi_dung_id: 4, ghi_chu: 'FACS' }, KT)).json.con_lai_ul, 100);
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/use`, { so_ul: 120 }, KT)).status, 409, 'vượt số còn lại');
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/use`, { so_ul: 0 }, KT)).status, 400);
  s.mails.length = 0;
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/use`, { so_ul: 70 }, KT)).json.con_lai_ul, 30);
  await cho();
  assert.equal((await volume(id)).trang_thai, 'sap_het');
  assert.ok(s.mails.some((m) => m.to === 'manager@sci.edu.vn' && /Sắp hết: Anti-CD45/.test(m.subject)), 'thư sắp hết cho quản lý');
  const sap = (await s.api('manager', 'GET', '/volume/low', null, KT)).json;
  assert.ok(sap.sap_het.some((t) => t.id === id && t.con_lai_ul === 30));
  assert.ok(sap.chua_ghi >= 0);
  assert.equal((await s.api('alice', 'GET', '/volume/low', null, KT)).status, 403);
  // đo lại
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/adjust`, { con_lai_ul: 25 }, KT)).status, 400, 'thiếu lý do');
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/adjust`, { con_lai_ul: 500, ly_do: 'đo' }, KT)).status, 400, 'không lớn hơn ban đầu');
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/adjust`, { con_lai_ul: 25, ly_do: 'Đo lại bằng pipet' }, KT)).status, 200);
  const v = await volume(id);
  assert.equal(v.con_lai_ul, 25);
  assert.deepEqual(v.so.map((x) => [x.hanh_dong, x.so_ul, x.con_lai_ul]).reverse(), [['ban_dau', 200, 200], ['dung', -100, 100], ['dung', -70, 30], ['dieu_chinh', -5, 25]]);
  // sổ chỉ thêm, không sửa / xóa
  assert.throws(() => s.db.prepare('UPDATE nhm_the_tich SET so_ul = 1 WHERE tube_id = ?').run(id), /chỉ được thêm/);
  assert.throws(() => s.db.prepare('DELETE FROM nhm_the_tich WHERE tube_id = ?').run(id), /chỉ được thêm/);
});

test('yêu cầu theo µL: bắt buộc ghi số µL, không xin quá số còn lại; giao trừ µL; nhận lại có thể đo lại', async () => {
  const id = (await them(5, 1, 100, 'Anti-CD90')).json.id;
  assert.equal((await xin('bob', id, null)).status, 400, 'thiếu số µL');
  assert.equal((await xin('bob', id, 150)).status, 409, 'xin quá số còn lại');
  const y = await xin('bob', id, 60);
  assert.equal(y.status, 201);
  assert.equal((await s.api('manager', 'GET', '/requests?view=inbox', null, KT)).json.requests.find((x) => x.id === y.json.id).so_ul_yeu_cau, 60);
  assert.equal((await s.api('truong', 'POST', `/requests/${y.json.id}/approve`, {}, KT)).status, 200);
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/deliver`, { so_ul: 200 }, KT)).status, 409, 'giao quá số còn lại');
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/deliver`, { so_ul: 'abc' }, KT)).status, 400);
  s.mails.length = 0;
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/deliver`, { so_ul: 55 }, KT)).json.con_lai_ul, 45);
  await cho();
  assert.ok(s.mails.some((m) => m.to === 'bob@sci.edu.vn' && /Đã giao/.test(m.subject)));
  let v = await volume(id);
  assert.equal(v.con_lai_ul, 45);
  const dung = v.so.find((x) => x.hanh_dong === 'dung');
  assert.equal(dung.so_ul, -55);
  assert.equal(dung.yeu_cau_id, y.json.id);
  assert.equal(dung.nguoi_dung_id, 4, 'ghi người dùng kháng thể');
  const yc = (await s.api('manager', 'GET', '/requests?view=all', null, KT)).json.requests.find((x) => x.id === y.json.id);
  assert.equal(yc.so_ul_giao, 55);
  // nhận lại: đo lại còn 40 → chênh lệch ghi sổ, ống về kho
  const tra = await s.api('manager', 'POST', `/requests/${y.json.id}/return`, { con_lai_ul: 40 }, KT);
  assert.equal(tra.status, 200);
  assert.equal(tra.json.het, false);
  v = await volume(id);
  assert.equal(v.con_lai_ul, 40);
  assert.equal(v.so[0].hanh_dong, 'dieu_chinh');
  assert.match(v.so[0].ghi_chu, /Đo lại khi nhận lại/);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(id).status, 'in_storage');
  const ghi = (await s.api('alice', 'GET', `/tubes/${id}/history`, null, KT)).json.history.map((x) => x.action).reverse();
  assert.deepEqual(ghi.filter((a) => /^kt_|giao|tra|yc_/.test(a)), ['kt_ban_dau', 'yc_gui', 'yc_duyet', 'kt_dung', 'giao', 'kt_dieu_chinh', 'tra']);
});

test('ống hết khi giao hết µL: nhận lại thì bỏ khỏi kho (đã hủy, nhả ô), ghi sổ và lịch sử, tìm lại được', async () => {
  const id = (await them(6, 1, 30, 'Anti-CD3')).json.id;
  const y = await xin('bob', id, 30);
  await s.api('truong', 'POST', `/requests/${y.json.id}/approve`, {}, KT);
  s.mails.length = 0;
  assert.equal((await s.api('manager', 'POST', `/requests/${y.json.id}/deliver`, null, KT)).json.con_lai_ul, 0, 'mặc định giao đúng số đã xin');
  await cho();
  assert.ok(s.mails.some((m) => m.to === 'manager@sci.edu.vn' && /Đã hết: Anti-CD3/.test(m.subject)), 'thư báo hết cho quản lý');
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(id).status, 'checked_out', 'còn ở ngoài cho tới khi nhận lại');
  const tra = await s.api('manager', 'POST', `/requests/${y.json.id}/return`, null, KT);
  assert.equal(tra.json.het, true);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(id).status, 'discarded');
  const v = await volume(id);
  assert.equal(v.trang_thai, 'het');
  assert.equal(v.so[0].hanh_dong, 'het');
  assert.equal(v.so[0].con_lai_ul, 0);
  assert.match(v.so[0].ghi_chu, /dùng hết/);
  const ls = (await s.api('alice', 'GET', `/tubes/${id}/history`, null, KT)).json.history;
  assert.ok(ls.some((x) => x.action === 'kt_het' && /Ống hết/.test(x.note)));
  assert.equal(s.db.prepare("SELECT trang_thai FROM nhm_yeu_cau WHERE id = ?").get(y.json.id).trang_thai, 'da_tra');
  // ô được nhả: thêm ống mới vào đúng ô; ống hết vẫn tìm được với trạng thái «mọi trạng thái»
  assert.equal((await them(6, 1, 100, 'Ống mới')).status, 201);
  const tim = (await s.api('alice', 'GET', '/tubes/search?q=CD3&status=all', null, KT)).json;
  assert.ok(tim.items.some((x) => x.id === id && x.status === 'discarded' && x.con_lai_ul === 0));
  assert.equal((await xin('bob', id, 5)).status, 409, 'ống hết không xin được nữa');
});

test('đánh dấu hết thủ công (hỏng, nhiễm): cần lý do, không khi đang có yêu cầu, xóa sổ phần còn lại', async () => {
  const id = (await them(7, 1, 50, 'Anti-CD19')).json.id;
  assert.equal((await s.api('alice', 'POST', `/tubes/${id}/volume/finish`, { ly_do: 'hỏng' }, KT)).status, 403);
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/finish`, {}, KT)).status, 400, 'thiếu lý do');
  const y = await xin('bob', id, 10);
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/finish`, { ly_do: 'nhiễm' }, KT)).status, 409, 'đang có yêu cầu');
  await s.api('bob', 'POST', `/requests/${y.json.id}/cancel`, null, KT);
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/finish`, { ly_do: 'Nhiễm khuẩn' }, KT)).status, 200);
  const v = await volume(id);
  assert.equal(v.trang_thai, 'het');
  assert.equal(v.so[0].so_ul, -50);
  assert.equal(v.so[0].ghi_chu, 'Nhiễm khuẩn');
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(id).status, 'discarded');
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/volume/finish`, { ly_do: 'lại' }, KT)).status, 409, 'đã ra khỏi kho');
});

test('dùng hết bằng «dùng» / «đo lại về 0» khi ống còn trong kho thì ống bỏ khỏi kho ngay', async () => {
  const a = (await them(8, 1, 20, 'Anti-CD8')).json.id;
  assert.equal((await s.api('manager', 'POST', `/tubes/${a}/volume/use`, { so_ul: 20 }, KT)).json.het, true);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(a).status, 'discarded');
  const b = (await them(8, 2, 20, 'Anti-CD4')).json.id;
  assert.equal((await s.api('manager', 'POST', `/tubes/${b}/volume/adjust`, { con_lai_ul: 0, ly_do: 'Đo lại: cạn' }, KT)).json.het, true);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(b).status, 'discarded');
});

test('chủ mẫu ống kháng thể: mặc định là AntibodyBank (không loại chủ / nhóm / người sở hữu); tùy chọn cá nhân; quản lý đổi qua lại', async () => {
  const id = (await them(9, 1, 100, 'Anti-IgG')).json.id;
  const lay = async () => (await s.api('manager', 'GET', `/boxes/${hop}`, null, KT)).json.tubes.find((t) => t.id === id);
  let t = await lay();
  assert.equal(t.chu_don_vi, 1);
  assert.equal(t.owner_user_id, null);
  assert.equal(t.chu_loai, null);
  assert.equal(t.nhom_id, null);
  assert.equal(t.owner_name, 'AntibodyBank');
  // chủ là đơn vị: người dùng thường chỉ yêu cầu; không ai là «chủ mẫu» để tự lấy
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${id}`, { notes: 'x' }, KT)).status, 403);
  // ống cá nhân (mua bằng kinh phí cá nhân): quản lý ghi người sở hữu
  const cn = await s.api('manager', 'POST', '/tubes', { box_id: hop, row_no: 9, col_no: 2, name: 'Anti-IgM cá nhân', chu_loai: 'can_bo', the_tich_ul: 50, chu_don_vi: false, owner_user_id: 3 }, KT);
  assert.equal(cn.status, 201);
  const t2 = (await s.api('manager', 'GET', `/boxes/${hop}`, null, KT)).json.tubes.find((x) => x.id === cn.json.id);
  assert.equal(t2.chu_don_vi, 0);
  assert.equal(t2.owner_user_id, 3);
  assert.equal(t2.chu_loai, 'can_bo');
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${cn.json.id}`, { notes: 'của tôi' }, KT)).status, 200, 'chủ cá nhân sửa được');
  assert.equal((await s.api('manager', 'POST', '/tubes', { box_id: hop, row_no: 9, col_no: 3, name: 'x', chu_loai: 'can_bo', the_tich_ul: 5, chu_don_vi: false, owner_user_id: 99999 }, KT)).status, 400, 'người sở hữu không tồn tại');
  // quản lý đổi: cá nhân → AntibodyBank (xóa chủ cá nhân, ghi lịch sử), rồi ngược lại
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${cn.json.id}`, { chu_don_vi: true }, KT)).status, 403, 'chủ cá nhân không tự chuyển cho đơn vị');
  assert.equal((await s.api('manager', 'PATCH', `/tubes/${cn.json.id}`, { chu_don_vi: true }, KT)).status, 200);
  const t3 = (await s.api('manager', 'GET', `/boxes/${hop}`, null, KT)).json.tubes.find((x) => x.id === cn.json.id);
  assert.deepEqual([t3.chu_don_vi, t3.owner_user_id, t3.chu_loai], [1, null, null]);
  const ls = (await s.api('manager', 'GET', `/tubes/${cn.json.id}/history`, null, KT)).json.history.find((x) => x.action === 'edit' && /AntibodyBank/.test(x.note || ''));
  assert.ok(ls, 'lịch sử ghi việc đổi chủ mẫu');
  assert.equal((await s.api('manager', 'PATCH', `/tubes/${cn.json.id}`, { chu_don_vi: false }, KT)).status, 200);
  assert.equal((await s.api('manager', 'POST', `/tubes/${cn.json.id}/transfer`, { owner_user_id: 4 }, KT)).status, 200);
  // «chuyển chủ» sang một người thì chủ mẫu là cá nhân đó
  assert.equal((await s.api('manager', 'PATCH', `/tubes/${id}`, { chu_don_vi: 'sai' }, KT)).status, 400);
  assert.equal((await s.api('manager', 'POST', `/tubes/${id}/transfer`, { owner_user_id: 4 }, KT)).status, 200);
  t = (await s.api('manager', 'GET', `/boxes/${hop}`, null, KT)).json.tubes.find((x) => x.id === id);
  assert.deepEqual([t.chu_don_vi, t.owner_user_id], [0, 4]);
  // yêu cầu về ống của đơn vị: người yêu cầu thấy «chủ mẫu: AntibodyBank»
  const don = (await them(9, 4, 100, 'Anti-IgA')).json.id;
  const y = await xin('bob', don, 10);
  assert.equal((await s.api('manager', 'GET', '/requests?view=all', null, KT)).json.requests.find((x) => x.id === y.json.id).chu_ten, 'AntibodyBank');
});
