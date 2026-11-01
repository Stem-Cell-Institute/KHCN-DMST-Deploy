'use strict';

// Yêu cầu lấy mẫu: đường duyệt theo loại thiết bị / loại chủ mẫu, quyền duyệt và xử lý thay, giao / nhận lại,
// chuyển cấp khi quá hạn, định tuyến lại khi người duyệt rời đi, email.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;
let cellbankBox;
let nhom; // nhóm có trưởng nhóm đã xác nhận (trưởng nhóm = user 6)

const cho = () => new Promise((r) => setTimeout(r, 40)); // thư gửi nền
const den = (tieuDe) => s.mails.filter((m) => m.subject.includes(tieuDe)).map((m) => m.to).sort();
const them = (user, box, r, c, extra) => s.api(user, 'POST', '/tubes', { box_id: box, row_no: r, col_no: c, name: `M${r}${c}`, ...extra });
const xin = (user, tubeId, lyDo = 'Cần cho thí nghiệm') => s.api(user, 'POST', `/tubes/${tubeId}/requests`, { ly_do: lyDo });
const hanhDong = async (id) => (await s.api('manager', 'GET', `/tubes/${id}/history`)).json.history.map((h) => h.action);

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  const cb = await s.api('manager', 'POST', '/containers', { name: 'Bình Cellbank', type_id: kho.type, quan_ly_boi: 'cellbank' });
  cellbankBox = (await s.api('manager', 'POST', '/boxes', { container_id: cb.json.id, template_id: kho.tpl99 })).json.ids[0];
  nhom = (await s.api('manager', 'POST', '/groups', { ten: 'Nhóm Yêu Cầu', truong_user_id: 6 })).json.id;
  await s.api('manager', 'PUT', '/profiles/5', { loai: 'sinh_vien', nhom_id: nhom });
});
test.after(() => s.dong());

test('gửi yêu cầu: cần lý do, không xin mẫu của mình, chỉ xin mẫu đang lưu kho, mỗi mẫu một yêu cầu đang xử lý', async () => {
  const m = (await them('alice', kho.box, 1, 1)).json.id;
  assert.equal((await s.api('bob', 'POST', `/tubes/${m}/requests`, {})).status, 400);
  assert.equal((await xin('alice', m)).status, 400, 'mẫu của chính mình');
  assert.equal((await xin('bob', 99999)).status, 404);
  assert.equal((await s.api(null, 'POST', `/tubes/${m}/requests`, { ly_do: 'x' })).status, 401);
  const ok = await xin('bob', m);
  assert.equal(ok.status, 201);
  assert.equal(ok.json.cap, 'chu_mau');
  assert.equal((await xin('sv', m)).status, 409, 'đã có yêu cầu khác chưa xong');
  await s.api('alice', 'POST', `/tubes/${m}/checkout`, { note: 'Ghi thao tác thử' });
  const m2 = (await them('alice', kho.box, 1, 2)).json.id;
  await s.api('alice', 'POST', `/tubes/${m2}/checkout`, { note: 'Ghi thao tác thử' });
  assert.equal((await xin('bob', m2)).status, 409, 'mẫu không còn đang lưu kho');
});

test('mẫu của cán bộ ở thiết bị công khai: CHỦ MẪU duyệt, thư chỉ gửi chủ mẫu', async () => {
  s.mails.length = 0;
  const m = (await them('alice', kho.box, 2, 1)).json.id;
  const r = await xin('bob', m);
  assert.equal(r.json.cap, 'chu_mau');
  await cho();
  assert.deepEqual(den('Yêu cầu lấy mẫu'), ['alice@sci.edu.vn']);
  assert.ok(s.mails[0].html.includes('https://eoffice.test/public/ngan-hang-te-bao-khang-the/index.html?nh=te_bao#cong-viec'));
  assert.deepEqual(await hanhDong(m), ['yc_gui', 'store']);
  s.mauAlice = m;
  s.yc = r.json.id;
});

test('mẫu của SINH VIÊN: trưởng nhóm duyệt, sinh viên (dù còn học) không bao giờ là người duyệt', async () => {
  s.mails.length = 0;
  const m = (await them('sv', kho.box, 3, 1)).json.id;
  const r = await xin('bob', m);
  assert.equal(r.json.cap, 'truong_nhom');
  await cho();
  assert.deepEqual(den('Yêu cầu lấy mẫu'), ['truong@sci.edu.vn']);
  // sinh viên là chủ mẫu nhưng không duyệt được
  assert.equal((await s.api('sv', 'POST', `/requests/${r.json.id}/approve`)).status, 403);
  assert.equal((await s.api('truong', 'POST', `/requests/${r.json.id}/approve`)).status, 200);
});

test('trưởng nhóm chưa xác nhận, nhóm giải thể, chủ mẫu đã rời đi: chuyển quản lý module', async () => {
  // trưởng nhóm chưa xác nhận
  const g2 = (await s.api('sv', 'POST', '/groups/propose', { ten: 'Nhóm Chưa Xác Nhận', truong_user_id: 6 })).json.id;
  const sv2 = (await them('bob', kho.box, 4, 1, { chu_loai: 'nghien_cuu_vien', nhom_id: g2 })).json.id;
  await s.api('manager', 'PATCH', `/tubes/${sv2}`, { chu_loai: 'sinh_vien' });
  assert.equal((await xin('alice', sv2)).json.cap, 'quan_ly', 'trưởng nhóm chưa tự xác nhận');
  // chủ mẫu (cán bộ) đã rời đi → trưởng nhóm; không có nhóm → quản lý
  const m = (await them('alice', kho.box, 4, 2)).json.id;
  await s.api('manager', 'PUT', '/profiles/3', { trang_thai: 'da_roi_di' });
  assert.equal((await xin('bob', m)).json.cap, 'quan_ly');
  await s.api('manager', 'PUT', '/profiles/3', { trang_thai: 'dang_hoat_dong' });
});

test('thiết bị Cellbank: Trưởng CIPP duyệt; chưa có Trưởng CIPP thì quản lý', async () => {
  s.mails.length = 0;
  const m = (await them('manager', cellbankBox, 1, 1, { chu_loai: 'can_bo' })).json.id;
  await s.api('manager', 'POST', `/tubes/${m}/transfer`, { owner_user_id: 3 });
  const r = await xin('bob', m);
  assert.equal(r.json.cap, 'truong_cellbank');
  await cho();
  assert.deepEqual(den('Yêu cầu lấy mẫu'), ['cellbank@sci.edu.vn'], 'chủ mẫu không phải người duyệt ở Cellbank');
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/approve`)).status, 403, 'chủ mẫu không duyệt thay Trưởng CIPP');
  assert.equal((await s.api('cellbank', 'POST', `/requests/${r.json.id}/approve`)).status, 200);
  // bỏ vai trò Trưởng CIPP → yêu cầu mới đi thẳng quản lý
  s.db.prepare("DELETE FROM nhm_vai_tro WHERE vai_tro = 'truong_cellbank'").run();
  const m2 = (await them('manager', cellbankBox, 1, 2, { chu_loai: 'can_bo' })).json.id;
  assert.equal((await xin('bob', m2)).json.cap, 'quan_ly');
  s.db.prepare("INSERT INTO nhm_vai_tro (user_id, vai_tro) VALUES (7, 'truong_cellbank')").run();
});

test('duyệt: đúng người; không tự duyệt; thư tới người yêu cầu và quản lý module (không tới người vừa duyệt)', async () => {
  s.mails.length = 0;
  assert.equal((await s.api('bob', 'POST', `/requests/${s.yc}/approve`)).status, 403, 'người yêu cầu không tự duyệt');
  assert.equal((await s.api('sv', 'POST', `/requests/${s.yc}/approve`)).status, 403, 'người không liên quan');
  assert.equal((await s.api('alice', 'POST', '/requests/99999/approve')).status, 404);
  assert.equal((await s.api('alice', 'POST', `/requests/${s.yc}/approve`)).status, 200);
  assert.equal((await s.api('alice', 'POST', `/requests/${s.yc}/approve`)).status, 409, 'đã xử lý');
  await cho();
  assert.deepEqual(den('Đã duyệt yêu cầu'), ['bob@sci.edu.vn', 'manager@sci.edu.vn'].sort());
  assert.ok((await hanhDong(s.mauAlice)).includes('yc_duyet'));
});

test('từ chối: phải ghi lý do, thư tới người yêu cầu', async () => {
  const m = (await them('alice', kho.box, 5, 1)).json.id;
  const r = await xin('bob', m);
  s.mails.length = 0;
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/reject`, {})).status, 400);
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/reject`, { ly_do: 'Mẫu cuối cùng, chưa dùng được' })).status, 200);
  await cho();
  assert.deepEqual(den('bị từ chối'), ['bob@sci.edu.vn', 'manager@sci.edu.vn'], 'người yêu cầu và quản lý module cùng được báo');
  assert.match(s.mails[0].text, /Mẫu cuối cùng/);
  // từ chối xong thì xin lại được
  assert.equal((await xin('bob', m)).status, 201);
});

test('quản lý «xử lý thay»: bắt buộc lý do, ghi rõ vào lịch sử; admin xử lý được mọi yêu cầu', async () => {
  const m = (await them('alice', kho.box, 5, 2)).json.id;
  const r = await xin('bob', m);
  assert.equal((await s.api('manager', 'POST', `/requests/${r.json.id}/approve`, {})).status, 400);
  assert.equal((await s.api('manager', 'POST', `/requests/${r.json.id}/approve`, { ly_do: 'ngắn' })).status, 400);
  assert.equal((await s.api('manager', 'POST', `/requests/${r.json.id}/approve`, { ly_do: 'Chủ mẫu đi công tác 2 tuần' })).json.xu_ly_thay, true);
  const h = (await s.api('manager', 'GET', `/tubes/${m}/history`)).json.history.find((x) => x.action === 'yc_duyet');
  assert.match(h.note, /xử lý thay Chủ mẫu: Chủ mẫu đi công tác 2 tuần/);
  const yc = (await s.api('manager', 'GET', '/requests?view=all')).json.requests.find((x) => x.id === r.json.id);
  assert.equal(yc.xu_ly_thay, true);
  // admin (quyền cuối cùng) duyệt yêu cầu ở cấp Trưởng CIPP
  const m2 = (await them('manager', cellbankBox, 2, 1, { chu_loai: 'can_bo' })).json.id;
  const r2 = await xin('bob', m2);
  assert.equal((await s.api('admin', 'POST', `/requests/${r2.json.id}/approve`, { ly_do: 'Trưởng CIPP vắng, Viện trưởng ủy quyền' })).status, 200);
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_request_approve' && /xử lý thay/.test(a.detail)));
});

test('quản lý không duyệt được yêu cầu của chính mình', async () => {
  const m = (await them('alice', kho.box, 6, 1)).json.id;
  const r = await xin('manager', m);
  assert.equal((await s.api('manager', 'POST', `/requests/${r.json.id}/approve`, { ly_do: 'Tự duyệt thử' })).status, 403);
  assert.equal((await s.api('admin', 'POST', `/requests/${r.json.id}/approve`, { ly_do: 'Admin duyệt cho quản lý' })).status, 200);
});

test('giao mẫu rồi nhận lại: chỉ quản lý; mẫu chuyển «đã lấy ra», lịch sử ghi giao / trả; thư cho người xin', async () => {
  const m = s.mauAlice; // yêu cầu s.yc đã duyệt ở trên
  assert.equal((await s.api('bob', 'POST', `/requests/${s.yc}/deliver`)).status, 403);
  assert.equal((await s.api('alice', 'POST', `/requests/${s.yc}/deliver`)).status, 403);
  assert.equal((await s.api('manager', 'POST', `/requests/${s.yc}/return`)).status, 409, 'chưa giao');
  s.mails.length = 0;
  assert.equal((await s.api('manager', 'POST', `/requests/${s.yc}/deliver`)).status, 200);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(m).status, 'checked_out');
  await cho();
  assert.deepEqual(den('Đã giao mẫu'), ['bob@sci.edu.vn']);
  assert.equal((await s.api('manager', 'POST', `/requests/${s.yc}/deliver`)).status, 409);
  assert.equal((await s.api('manager', 'POST', `/requests/${s.yc}/return`)).status, 200);
  assert.equal(s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(m).status, 'in_storage');
  const acts = await hanhDong(m);
  assert.deepEqual(acts.slice(0, 2), ['tra', 'giao']);
  assert.equal(s.db.prepare('SELECT trang_thai FROM nhm_yeu_cau WHERE id = ?').get(s.yc).trang_thai, 'da_tra');
});

test('người yêu cầu hủy được khi chưa giao; người khác không hủy hộ', async () => {
  const m = (await them('alice', kho.box, 6, 2)).json.id;
  const r = await xin('bob', m);
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/cancel`)).status, 403);
  assert.equal((await s.api('bob', 'POST', `/requests/${r.json.id}/cancel`)).status, 200);
  assert.equal((await s.api('bob', 'POST', `/requests/${r.json.id}/cancel`)).status, 409);
  assert.ok((await hanhDong(m)).includes('yc_huy'));
  assert.equal((await xin('bob', m)).status, 201, 'hủy xong xin lại được');
});

test('quá hạn phản hồi: tự chuyển quản lý một lần, thư cho quản lý, lịch sử ghi (không có người thao tác)', async () => {
  const m = (await them('alice', kho.box, 6, 3)).json.id;
  const r = await xin('bob', m);
  assert.equal((await s.router.quetQuaHan()).leoThang, 0, 'chưa tới hạn');
  s.db.prepare("UPDATE nhm_yeu_cau SET han_phan_hoi = datetime('now', '-1 hour') WHERE id = ?").run(r.json.id);
  s.mails.length = 0;
  assert.equal((await s.router.quetQuaHan()).leoThang, 1);
  assert.equal((await s.router.quetQuaHan()).leoThang, 0, 'không chuyển hai lần');
  await cho();
  assert.deepEqual(den('quá hạn'), ['manager@sci.edu.vn']);
  const y = s.db.prepare('SELECT cap, leo_thang_luc FROM nhm_yeu_cau WHERE id = ?').get(r.json.id);
  assert.equal(y.cap, 'quan_ly');
  assert.ok(y.leo_thang_luc);
  const h = (await s.api('manager', 'GET', `/tubes/${m}/history`)).json.history.find((x) => x.action === 'yc_leo_thang');
  assert.equal(h.user_id, null);
  // giờ quản lý duyệt là duyệt đúng cấp (không phải xử lý thay → không cần lý do)
  assert.equal((await s.api('manager', 'POST', `/requests/${r.json.id}/approve`, {})).json.xu_ly_thay, false);
});

test('chủ mẫu rời đi khi yêu cầu đang chờ: định tuyến lại ngay sang cấp còn người', async () => {
  const m = (await them('alice', kho.box, 7, 1)).json.id;
  const r = await xin('bob', m);
  assert.equal(r.json.cap, 'chu_mau');
  s.mails.length = 0;
  await s.api('manager', 'PUT', '/profiles/3', { trang_thai: 'da_roi_di' });
  assert.equal(s.db.prepare('SELECT cap FROM nhm_yeu_cau WHERE id = ?').get(r.json.id).cap, 'quan_ly');
  assert.ok((await hanhDong(m)).includes('yc_dinh_tuyen_lai'));
  await cho();
  assert.ok(den('Yêu cầu lấy mẫu').includes('manager@sci.edu.vn'));
  await s.api('manager', 'PUT', '/profiles/3', { trang_thai: 'dang_hoat_dong' });
});

test('danh sách: mine, inbox (đúng người duyệt), all chỉ quản lý; số việc trong /me', async () => {
  const m = (await them('alice', kho.box, 7, 2)).json.id;
  const r = await xin('bob', m);
  const mine = (await s.api('bob', 'GET', '/requests?view=mine')).json.requests;
  assert.ok(mine.some((x) => x.id === r.json.id && x.co_the_huy));
  const inbox = (await s.api('alice', 'GET', '/requests?view=inbox')).json.requests;
  assert.ok(inbox.some((x) => x.id === r.json.id && x.co_the_xu_ly && !x.can_ly_do));
  assert.ok(!(await s.api('sv', 'GET', '/requests?view=inbox')).json.requests.some((x) => x.id === r.json.id));
  const quanLy = (await s.api('manager', 'GET', '/requests?view=inbox')).json.requests.find((x) => x.id === r.json.id);
  assert.ok(quanLy.co_the_xu_ly && quanLy.can_ly_do, 'quản lý xử lý thay cần lý do');
  assert.equal((await s.api('alice', 'GET', '/requests?view=all')).status, 403);
  assert.equal((await s.api('manager', 'GET', '/requests?view=all')).status, 200);
  const me = (await s.api('alice', 'GET', '/me')).json;
  assert.ok(me.yeuCau.inbox >= 1);
  assert.ok((await s.api('bob', 'GET', '/me')).json.yeuCau.mine >= 1);
});

test('xóa / rã đông / hủy mẫu thì đóng yêu cầu đang chờ; trả mẫu đang giao thì kết thúc yêu cầu', async () => {
  const m = (await them('alice', kho.box, 8, 1)).json.id;
  const r = await xin('bob', m);
  await s.api('alice', 'POST', `/tubes/${m}/discard`, { note: 'Ghi thao tác thử' });
  assert.equal(s.db.prepare('SELECT trang_thai FROM nhm_yeu_cau WHERE id = ?').get(r.json.id).trang_thai, 'da_huy');
  const m2 = (await them('alice', kho.box, 8, 2)).json.id;
  const r2 = await xin('bob', m2);
  await s.api('alice', 'POST', `/requests/${r2.json.id}/approve`);
  await s.api('manager', 'POST', `/requests/${r2.json.id}/deliver`);
  assert.equal((await s.api('alice', 'POST', `/tubes/${m2}/checkin`, { note: 'Ghi thao tác thử' })).status, 200);
  assert.equal(s.db.prepare('SELECT trang_thai FROM nhm_yeu_cau WHERE id = ?').get(r2.json.id).trang_thai, 'da_tra');
  const m3 = (await them('alice', kho.box, 8, 3)).json.id;
  const r3 = await xin('bob', m3);
  await s.api('alice', 'DELETE', `/tubes/${m3}`);
  assert.equal(s.db.prepare('SELECT trang_thai FROM nhm_yeu_cau WHERE id = ?').get(r3.json.id).trang_thai, 'da_huy');
});

test('email không bao giờ làm hỏng thao tác chính: SMTP hỏng vẫn gửi và duyệt yêu cầu thành công', async () => {
  const m = (await them('alice', kho.box, 9, 1)).json.id;
  const goc = console.warn;
  console.warn = () => {};
  s.mailLoi = true;
  try {
    s.mails.length = 0;
    const r = await xin('bob', m);
    assert.equal(r.status, 201);
    assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/approve`)).status, 200);
    await cho();
    assert.equal(s.mails.length, 0, 'không thư nào đi được, nhưng thao tác chính đã xong');
  } finally {
    s.mailLoi = false;
    console.warn = goc;
  }
});
