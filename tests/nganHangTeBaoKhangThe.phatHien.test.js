'use strict';

// Mẫu chưa khai báo (nhắc trước, nhận, bỏ sau hạn chờ) và mẫu nghi mất / bị lấy không xin phép
// (báo mất, kiểm kê, tự nhận, xác nhận, chốt thất lạc).

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;
let cellbankBox;
let nhom;

const cho = () => new Promise((r) => setTimeout(r, 40));
const den = (tieuDe) => s.mails.filter((m) => m.subject.includes(tieuDe)).map((m) => m.to).sort();
const them = (user, box, r, c, extra) => s.api(user, 'POST', '/tubes', { box_id: box, row_no: r, col_no: c, name: `M${r}${c}`, ...extra });
const phatHien = (r, c, extra) => s.api('manager', 'POST', '/findings', { box_id: kho.box, row_no: r, col_no: c, mo_ta: 'Ống nắp xanh, chữ «HEK P8»', ...extra });
const lichSuMau = async (id) => (await s.api('manager', 'GET', `/tubes/${id}/history`)).json.history;
const doiLuiNgay = (bang, id, cot, ngay) => s.db.prepare(`UPDATE ${bang} SET ${cot} = datetime('now', '-${ngay} days') WHERE id = ?`).run(id);

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  const cb = await s.api('manager', 'POST', '/containers', { name: 'Bình CB', type_id: kho.type, quan_ly_boi: 'cellbank' });
  cellbankBox = (await s.api('manager', 'POST', '/boxes', { container_id: cb.json.id, template_id: kho.tpl99 })).json.ids[0];
  nhom = (await s.api('manager', 'POST', '/groups', { ten: 'Nhóm Phát Hiện', truong_user_id: 6 })).json.id;
  await s.api('manager', 'PUT', '/profiles/3', { loai: 'nghien_cuu_vien', nhom_id: nhom });
});
test.after(() => s.dong());

// ═══ Mẫu chưa khai báo ═══

test('chỉ quản lý đánh dấu ô; ô phải trong lưới, trống, ở thiết bị công khai, có mô tả', async () => {
  assert.equal((await s.api('alice', 'POST', '/findings', { box_id: kho.box, row_no: 1, col_no: 1, mo_ta: 'x' })).status, 403);
  assert.equal((await s.api(null, 'POST', '/findings', {})).status, 401);
  assert.equal((await phatHien(1, 1, { mo_ta: '' })).status, 400);
  assert.equal((await phatHien(10, 1)).status, 400, 'ngoài lưới');
  assert.equal((await s.api('manager', 'POST', '/findings', { box_id: 99999, row_no: 1, col_no: 1, mo_ta: 'x' })).status, 400);
  assert.equal((await s.api('manager', 'POST', '/findings', { box_id: cellbankBox, row_no: 1, col_no: 1, mo_ta: 'x' })).status, 400, 'Cellbank không dùng');
  assert.equal((await phatHien(1, 1, { nghi_user_id: 99999 })).status, 400);
  assert.equal((await phatHien(1, 1, { nghi_nhom_id: 99999 })).status, 400);
  await them('alice', kho.box, 2, 2, { name: 'Có sổ' });
  assert.equal((await phatHien(2, 2)).status, 409, 'ô đã có mẫu trong sổ');
  const ok = await phatHien(1, 1);
  assert.equal(ok.status, 201);
  assert.equal((await phatHien(1, 1)).status, 409, 'đánh dấu hai lần');
  s.ph = ok.json.id;
});

test('ô đang chờ chủ mẫu bị giữ chỗ: không thêm / di chuyển mẫu khác vào; hộp báo ô đó cho giao diện', async () => {
  const r = await them('bob', kho.box, 1, 1, {});
  assert.equal(r.status, 409);
  assert.match(r.json.message, /chưa khai báo/);
  const m = (await them('bob', kho.box, 3, 3, {})).json.id;
  assert.equal((await s.api('bob', 'POST', `/tubes/${m}/move`, { box_id: kho.box, row_no: 1, col_no: 1 })).status, 409);
  assert.equal((await s.api('bob', 'POST', '/tubes/bulk', { box_id: kho.box, row_no: 1, col_no: 1, count: 2, name: 'x' })).status, 409);
  const hop = (await s.api('alice', 'GET', `/boxes/${kho.box}`)).json;
  assert.deepEqual(hop.phat_hien.map((p) => [p.row_no, p.col_no]), [[1, 1]]);
});

test('ai cũng xem được bảng «mẫu chưa khai báo»; lịch sử của mục có người phát hiện', async () => {
  const ds = (await s.api('bob', 'GET', '/findings')).json.findings;
  assert.equal(ds.length, 1);
  assert.equal(ds[0].nhac_lan, 0);
  assert.equal(ds[0].co_the_bo, false);
  const ct = (await s.api('bob', 'GET', `/findings/${s.ph}`)).json;
  assert.equal(ct.history[0].action, 'phat_hien');
  assert.equal((await s.api('bob', 'GET', '/findings/99999')).status, 404);
});

test('VIỆC ĐẦU TIÊN là nhắc: chưa nhắc thì không bỏ mẫu được (kể cả admin)', async () => {
  const r = await s.api('manager', 'POST', `/findings/${s.ph}/discard`, { ly_do: 'Không ai nhận' });
  assert.equal(r.status, 409);
  assert.match(r.json.message, /nhắc chủ mẫu/);
  assert.equal((await s.api('admin', 'POST', `/findings/${s.ph}/discard`, { ly_do: 'Không ai nhận' })).status, 409);
});

test('nhắc: gửi email người nghi là chủ + trưởng nhóm của họ; ghi lần nhắc đầu để tính hạn chờ', async () => {
  s.mails.length = 0;
  assert.equal((await s.api('alice', 'POST', `/findings/${s.ph}/remind`)).status, 403);
  await s.api('manager', 'PATCH', `/groups/${nhom}`, { truong_xac_nhan: true });
  const f2 = (await phatHien(4, 4, { nghi_user_id: 3 })).json.id; // alice (nhóm có trưởng nhóm user 6)
  const r = await s.api('manager', 'POST', `/findings/${f2}/remind`);
  assert.equal(r.status, 200);
  assert.equal(r.json.nhac_lan, 1);
  assert.equal(r.json.nguoi_nhan, 2);
  assert.ok(r.json.han_bo);
  await cho();
  assert.deepEqual(den('Nhắc khai báo'), ['alice@sci.edu.vn', 'truong@sci.edu.vn']);
  assert.match(s.mails[0].text, /Ống nắp xanh/);
  assert.equal((await s.api('manager', 'POST', `/findings/${f2}/remind`)).json.nhac_lan, 2, 'nhắc lại được');
  assert.equal(s.db.prepare('SELECT nhac_dau_luc FROM nhm_phat_hien WHERE id = ?').get(f2).nhac_dau_luc.length, 19);
  s.f2 = f2;
});

test('nhắc khi chưa biết chủ: không có email, chỉ hiện trên bảng; vẫn tính là đã nhắc', async () => {
  s.mails.length = 0;
  const r = await s.api('manager', 'POST', `/findings/${s.ph}/remind`);
  assert.equal(r.json.nguoi_nhan, 0);
  assert.equal(r.json.nhac_lan, 1);
  await cho();
  assert.equal(s.mails.length, 0);
  const ls = (await s.api('manager', 'GET', `/findings/${s.ph}`)).json.history;
  assert.match(ls[0].note, /bảng «Mẫu chưa khai báo»/);
});

test('nhắc nhóm: trưởng nhóm + mọi thành viên đang hoạt động; không gửi người đã rời đi', async () => {
  await s.api('manager', 'PUT', '/profiles/4', { loai: 'nghien_cuu_vien', nhom_id: nhom });
  await s.api('manager', 'PUT', '/profiles/5', { loai: 'sinh_vien', nhom_id: nhom, trang_thai: 'da_roi_di' });
  const f3 = (await phatHien(5, 5, { nghi_nhom_id: nhom })).json.id;
  s.mails.length = 0;
  await s.api('manager', 'POST', `/findings/${f3}/remind`);
  await cho();
  assert.deepEqual(den('Nhắc khai báo'), ['alice@sci.edu.vn', 'bob@sci.edu.vn', 'truong@sci.edu.vn']);
  await s.api('manager', 'POST', `/findings/${f3}/cancel`, {});
});

test('bỏ mẫu: phải có lý do, phải qua hạn chờ kể từ lần nhắc ĐẦU; admin bỏ sớm được và bị ghi rõ', async () => {
  assert.equal((await s.api('manager', 'POST', `/findings/${s.f2}/discard`, { ly_do: '' })).status, 400);
  const som = await s.api('manager', 'POST', `/findings/${s.f2}/discard`, { ly_do: 'Không ai nhận sau nhắc' });
  assert.equal(som.status, 409, 'chưa hết 7 ngày');
  assert.match(som.json.message, /Chưa hết hạn chờ/);
  assert.equal((await s.api('alice', 'POST', `/findings/${s.f2}/discard`, { ly_do: 'Không ai nhận sau nhắc' })).status, 403);
  // admin bỏ sớm
  const f4 = (await phatHien(6, 6)).json.id;
  await s.api('manager', 'POST', `/findings/${f4}/remind`);
  const a = await s.api('admin', 'POST', `/findings/${f4}/discard`, { ly_do: 'Mẫu hỏng, cần dọn ô gấp' });
  assert.equal(a.json.bo_som, true);
  assert.equal((await s.api('manager', 'GET', `/findings/${f4}`)).json.history[0].action, 'da_bo_som');
  // quá 7 ngày kể từ lần nhắc đầu: quản lý bỏ được
  doiLuiNgay('nhm_phat_hien', s.f2, 'nhac_dau_luc', 8);
  const ok = await s.api('manager', 'POST', `/findings/${s.f2}/discard`, { ly_do: 'Không ai nhận sau 8 ngày' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.bo_som, false);
  assert.equal((await s.api('manager', 'POST', `/findings/${s.f2}/discard`, { ly_do: 'Lần hai thử' })).status, 409);
  assert.equal((await them('bob', kho.box, 4, 4, {})).status, 201, 'ô được nhả sau khi bỏ mẫu');
  assert.equal((await s.api('alice', 'GET', '/findings')).json.findings.some((p) => p.id === s.f2), false);
  assert.equal((await s.api('manager', 'GET', '/findings?status=all')).json.findings.some((p) => p.id === s.f2), true);
});

test('chủ mẫu nhận: tạo mẫu ngay tại ô, người nhận là chủ, lịch sử ghi khai báo bổ sung, báo quản lý', async () => {
  assert.equal((await s.api('alice', 'POST', `/findings/${s.ph}/claim`, {})).status, 400, 'thiếu tên');
  assert.equal((await s.api('alice', 'POST', `/findings/${s.ph}/claim`, { name: 'HEK P8', cell_count: 'abc' })).status, 400);
  assert.equal((await s.api('truong', 'POST', `/findings/${s.ph}/claim`, { name: 'HEK P8' })).status, 400, 'chưa có hồ sơ: phải khai loại chủ');
  s.mails.length = 0;
  const r = await s.api('alice', 'POST', `/findings/${s.ph}/claim`, { name: 'HEK P8', passage: 'P8', project: 'Đề tài X' });
  assert.equal(r.status, 201);
  const t = s.db.prepare('SELECT owner_user_id, box_id, row_no, col_no, nhom_id, chu_loai FROM nhm_tubes WHERE id = ?').get(r.json.tube_id);
  assert.deepEqual(t, { owner_user_id: 3, box_id: kho.box, row_no: 1, col_no: 1, nhom_id: nhom, chu_loai: 'nghien_cuu_vien' });
  const h = await lichSuMau(r.json.tube_id);
  assert.equal(h[0].action, 'khai_bao_bo_sung');
  assert.match(h[0].note, /Ống nắp xanh/);
  assert.equal(h[1].action, 'store');
  const ph = (await s.api('manager', 'GET', `/findings/${s.ph}`)).json;
  assert.equal(ph.finding.trang_thai, 'da_khai_bao');
  assert.equal(ph.finding.tube_id, r.json.tube_id);
  assert.deepEqual(ph.history.map((x) => x.action), ['da_khai_bao', 'nhac', 'phat_hien']);
  await cho();
  assert.deepEqual(den('Đã khai báo mẫu'), ['manager@sci.edu.vn']);
  assert.equal((await s.api('bob', 'POST', `/findings/${s.ph}/claim`, { name: 'x', chu_loai: 'can_bo' })).status, 409, 'đã được nhận');
});

test('lịch sử phát hiện không sửa / xóa được ở mức CSDL, ghi tên người thao tác', async () => {
  assert.throws(() => s.db.prepare("UPDATE nhm_phat_hien_ls SET note = 'sửa'").run(), /chỉ được thêm, không được sửa/);
  assert.throws(() => s.db.prepare('DELETE FROM nhm_phat_hien_ls').run(), /chỉ được thêm, không được xóa/);
  const ls = (await s.api('manager', 'GET', `/findings/${s.ph}`)).json.history;
  assert.equal(ls[ls.length - 1].user_label, 'manager@sci.edu.vn');
});

test('hủy đánh dấu nhầm: quản lý, nhả ô', async () => {
  const f = (await phatHien(7, 7)).json.id;
  assert.equal((await s.api('alice', 'POST', `/findings/${f}/cancel`, {})).status, 403);
  assert.equal((await s.api('manager', 'POST', `/findings/${f}/cancel`, { ly_do: 'Đã tìm ra là mẫu có sổ' })).status, 200);
  assert.equal((await s.api('manager', 'POST', `/findings/${f}/cancel`, {})).status, 409);
  assert.equal((await them('bob', kho.box, 7, 7, {})).status, 201);
});

// ═══ Mẫu nghi mất / bị lấy không xin phép ═══

test('báo mất: chủ mẫu, trưởng nhóm hoặc quản lý; mẫu phải đang lưu kho; thư tới chủ, trưởng nhóm, quản lý', async () => {
  const m = (await them('alice', kho.box, 8, 1, {})).json.id;
  s.mauMat = m;
  assert.equal((await s.api('bob', 'POST', `/tubes/${m}/report-missing`, {})).status, 403);
  assert.equal((await s.api('alice', 'POST', '/tubes/99999/report-missing', {})).status, 404);
  s.mails.length = 0;
  const r = await s.api('alice', 'POST', `/tubes/${m}/report-missing`, { mo_ta: 'Mở hộp không thấy ống' });
  assert.equal(r.status, 201);
  assert.equal((await s.api('alice', 'POST', `/tubes/${m}/report-missing`, {})).status, 409, 'đã có vụ việc mở');
  await cho();
  assert.deepEqual(den('Mẫu nghi mất'), ['manager@sci.edu.vn', 'truong@sci.edu.vn']); // alice là người báo nên không nhận thư
  assert.equal((await lichSuMau(m))[0].action, 'bao_mat');
  assert.equal((await s.api('bob', 'GET', `/boxes/${kho.box}`)).json.tubes.find((t) => t.id === m).nghi_mat, true);
  s.vv = r.json.id;
  const co = (await them('alice', kho.box, 8, 2, {})).json.id;
  await s.api('alice', 'POST', `/tubes/${co}/checkout`);
  assert.equal((await s.api('alice', 'POST', `/tubes/${co}/report-missing`, {})).status, 409, 'mẫu đã lấy ra rồi');
});

test('mẫu đang nghi mất không xin lấy được', async () => {
  const r = await s.api('bob', 'POST', `/tubes/${s.mauMat}/requests`, { ly_do: 'Cần dùng' });
  assert.equal(r.status, 409);
  assert.match(r.json.message, /nghi mất/);
});

test('người đã lấy tự nhận; chủ mẫu từ chối thì vụ việc mở lại; người nhận không tự xác nhận', async () => {
  assert.equal((await s.api('alice', 'POST', `/incidents/${s.vv}/taken`, {})).status, 400, 'chủ mẫu không phải người lấy');
  assert.equal((await s.api('bob', 'POST', `/incidents/${s.vv}/taken`, { ghi_chu: 'Lấy hôm thứ 3, quên báo' })).status, 200);
  assert.equal((await s.api('sv', 'POST', `/incidents/${s.vv}/taken`, {})).status, 409, 'đã có người nhận');
  assert.equal((await s.api('bob', 'POST', `/incidents/${s.vv}/confirm`)).status, 403);
  assert.equal((await s.api('sv', 'POST', `/incidents/${s.vv}/confirm`)).status, 403, 'người lạ');
  assert.equal((await s.api('alice', 'POST', `/incidents/${s.vv}/reject`, { ly_do: 'Không đúng ống' })).status, 200);
  assert.equal(s.db.prepare('SELECT trang_thai, nguoi_nhan_id FROM nhm_vu_viec WHERE id = ?').get(s.vv).trang_thai, 'mo');
  assert.ok((await lichSuMau(s.mauMat)).some((h) => h.action === 'tu_choi_nhan'));
});

test('chủ mẫu xác nhận người lấy: mẫu «đã lấy ra», tính vào số lần vi phạm, quản lý xem được', async () => {
  await s.api('bob', 'POST', `/incidents/${s.vv}/taken`, { ghi_chu: 'Xin lỗi, đúng là tôi lấy' });
  assert.equal((await s.api('alice', 'POST', `/incidents/${s.vv}/confirm`)).status, 200);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(s.mauMat).status, 'checked_out');
  assert.equal((await s.api('alice', 'GET', '/violations')).status, 403);
  const v = (await s.api('manager', 'GET', '/violations')).json.violations;
  assert.deepEqual(v.map((x) => [x.user_id, x.so_lan]), [[4, 1]]);
  assert.equal(v[0].nhom_ten, 'Nhóm Phát Hiện');
  assert.equal((await lichSuMau(s.mauMat))[0].action, 'xac_nhan_lay');
});

test('trưởng nhóm xác nhận thay chủ mẫu là sinh viên; tìm thấy / báo nhầm đóng vụ việc', async () => {
  const svTube = (await them('truong', kho.box, 9, 1, { chu_loai: 'nghien_cuu_vien', nhom_id: nhom })).json.id;
  await s.api('manager', 'PATCH', `/tubes/${svTube}`, { chu_loai: 'sinh_vien' });
  // trưởng nhóm (user 6) báo mất mẫu của sinh viên trong nhóm — được vì là trưởng nhóm có hiệu lực
  s.db.prepare('UPDATE nhm_tubes SET owner_user_id = 5 WHERE id = ?').run(svTube);
  const r = await s.api('truong', 'POST', `/tubes/${svTube}/report-missing`, {});
  assert.equal(r.status, 201);
  assert.equal((await s.api('bob', 'POST', `/incidents/${r.json.id}/found`)).status, 403);
  assert.equal((await s.api('truong', 'POST', `/incidents/${r.json.id}/found`)).status, 200);
  assert.equal((await s.api('truong', 'POST', `/incidents/${r.json.id}/found`)).status, 409);
  assert.equal((await lichSuMau(svTube))[0].action, 'tim_thay');
  const r2 = await s.api('truong', 'POST', `/tubes/${svTube}/report-missing`, {});
  assert.equal((await s.api('truong', 'POST', `/incidents/${r2.json.id}/cancel`)).status, 200);
});

test('chốt thất lạc: quản lý, phải có lý do và hết hạn chờ; admin chốt sớm được; mẫu thành «đã hủy», đóng yêu cầu', async () => {
  const m = (await them('bob', kho.box, 9, 2, {})).json.id;
  const r = await s.api('bob', 'POST', `/tubes/${m}/report-missing`, {});
  assert.equal((await s.api('alice', 'POST', `/incidents/${r.json.id}/lost`, { ly_do: 'Không tìm thấy' })).status, 403);
  assert.equal((await s.api('manager', 'POST', `/incidents/${r.json.id}/lost`, {})).status, 400);
  const som = await s.api('manager', 'POST', `/incidents/${r.json.id}/lost`, { ly_do: 'Không ai nhận' });
  assert.equal(som.status, 409);
  assert.match(som.json.message, /Chưa hết hạn chờ/);
  doiLuiNgay('nhm_vu_viec', r.json.id, 'han_nhan', 1);
  s.mails.length = 0;
  assert.equal((await s.api('manager', 'POST', `/incidents/${r.json.id}/lost`, { ly_do: 'Quá 14 ngày không ai nhận' })).status, 200);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(m).status, 'discarded');
  assert.equal((await lichSuMau(m))[0].action, 'that_lac');
  await cho();
  assert.ok(den('Mẫu thất lạc').includes('bob@sci.edu.vn'));
  // admin chốt sớm
  const m2 = (await them('bob', kho.box, 9, 3, {})).json.id;
  const r2 = await s.api('bob', 'POST', `/tubes/${m2}/report-missing`, {});
  assert.equal((await s.api('admin', 'POST', `/incidents/${r2.json.id}/lost`, { ly_do: 'Viện trưởng quyết định chốt' })).status, 200);
  assert.match((await lichSuMau(m2))[0].note, /sớm, admin/);
});

test('kiểm kê hộp: chỉ quản lý; kiểm tra danh sách; «thấy» ghi mốc, «không thấy» mở vụ việc kèm lần cuối thấy', async () => {
  const hop = kho.box2;
  const a = (await them('alice', hop, 1, 1, {})).json.id;
  const b = (await them('alice', hop, 1, 2, {})).json.id;
  const c = (await them('alice', hop, 1, 3, {})).json.id;
  const ngoai = (await them('alice', kho.box, 3, 5, {})).json.id;
  assert.equal((await s.api('alice', 'POST', `/boxes/${hop}/audit`, { thay: [a], khong_thay: [] })).status, 403);
  assert.equal((await s.api('manager', 'POST', '/boxes/99999/audit', { thay: [], khong_thay: [] })).status, 404);
  assert.equal((await s.api('manager', 'POST', `/boxes/${hop}/audit`, { thay: 'a', khong_thay: [] })).status, 400);
  assert.equal((await s.api('manager', 'POST', `/boxes/${hop}/audit`, { thay: [a], khong_thay: [a] })).status, 400);
  assert.equal((await s.api('manager', 'POST', `/boxes/${hop}/audit`, { thay: [ngoai], khong_thay: [] })).status, 400, 'mẫu của hộp khác');
  assert.equal((await s.api('manager', 'POST', `/boxes/${hop}/audit`, { thay: [], khong_thay: [99999] })).status, 400);
  await s.api('manager', 'POST', `/boxes/${hop}/audit`, { thay: [a, b, c], khong_thay: [] });
  assert.ok(s.db.prepare('SELECT thay_luc FROM nhm_tubes WHERE id = ?').get(b).thay_luc);
  s.mails.length = 0;
  const r = await s.api('manager', 'POST', `/boxes/${hop}/audit`, { thay: [a], khong_thay: [b] });
  assert.deepEqual([r.json.thay, r.json.khong_thay, r.json.vu_viec_moi], [1, 1, 1]);
  const vv = s.db.prepare("SELECT * FROM nhm_vu_viec WHERE tube_id = ? AND trang_thai = 'mo'").get(b);
  assert.equal(vv.nguon, 'kiem_ke');
  assert.match(vv.mo_ta, /lần cuối thấy/);
  assert.equal((await lichSuMau(b))[0].action, 'kiem_ke_khong_thay');
  await cho();
  assert.ok(den('Mẫu nghi mất').includes('alice@sci.edu.vn'), 'chủ mẫu nhận thư');
  // kiểm kê lại mẫu đã có vụ việc mở: không mở thêm
  assert.equal((await s.api('manager', 'POST', `/boxes/${hop}/audit`, { thay: [], khong_thay: [b] })).json.vu_viec_moi, 0);
  // mọi người thấy vụ việc để tự nhận
  const ds = (await s.api('sv', 'GET', '/incidents')).json.incidents;
  assert.ok(ds.some((x) => x.tube_id === b && x.co_the_nhan_lay));
  assert.ok((await s.api('sv', 'GET', '/me')).json.vuViecMo >= 1);
});
