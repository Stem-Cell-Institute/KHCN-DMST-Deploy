'use strict';

// Đợt 1 phân quyền: vai trò module (chỉ admin cấp), nhóm nghiên cứu (đề xuất / xác nhận trưởng nhóm / gộp),
// hồ sơ thành viên, loại chủ mẫu + nhóm trên mẫu, thiết bị Cellbank / công khai, lịch sử không sửa được.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;
let cellbank; // thiết bị Cellbank + hộp bên trong

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  const c = await s.api('manager', 'POST', '/containers', { name: 'Bình Cellbank', type_id: kho.type, quan_ly_boi: 'cellbank' });
  const ngan = await s.api('manager', 'POST', '/containers', { name: 'Ngăn CB', type_id: kho.type, parent_id: c.json.id });
  const hop = await s.api('manager', 'POST', '/boxes', { container_id: ngan.json.id, template_id: kho.tpl99 });
  cellbank = { container: c.json.id, ngan: ngan.json.id, box: hop.json.ids[0] };
});
test.after(() => s.dong());

const them = (user, box, r, c, extra) => s.api(user, 'POST', '/tubes', { box_id: box, row_no: r, col_no: c, name: `M${r}${c}`, ...extra });

test('users.role = manager KHÔNG còn tự có quyền quản lý; quản lý module và admin thì có', async () => {
  // người có users.role 'manager' nhưng không được gán vai trò: chỉ là người dùng thường
  s.db.prepare("INSERT INTO users (id, fullname, email) VALUES (20, 'QL cũ', 'cu@sci.edu.vn')").run();
  assert.equal((await s.api('manager', 'GET', '/me')).json.canManage, true);
  assert.equal((await s.api('admin', 'GET', '/me')).json.canManage, true);
  assert.equal((await s.api('admin', 'GET', '/me')).json.laAdmin, true);
  assert.equal((await s.api('manager', 'GET', '/me')).json.laAdmin, false);
  assert.equal((await s.api('alice', 'GET', '/me')).json.canManage, false);
  assert.deepEqual((await s.api('cellbank', 'GET', '/me')).json.vaiTro, ['truong_cellbank']);
  assert.equal((await s.api('cellbank', 'POST', '/containers', { name: 'x', type_id: kho.type })).status, 403, 'Trưởng CIPP không phải quản lý module');
});

test('chỉ admin cấp / gỡ vai trò; quản lý module chỉ xem được danh sách', async () => {
  assert.equal((await s.api('manager', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly' })).status, 403);
  assert.equal((await s.api('alice', 'POST', '/roles', { user_id: 3, vai_tro: 'quan_ly' })).status, 403);
  assert.equal((await s.api('alice', 'GET', '/roles')).status, 403);
  assert.equal((await s.api('manager', 'GET', '/roles')).status, 200);
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 3, vai_tro: 'chủ tịch' })).status, 400);
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 99999, vai_tro: 'quan_ly' })).status, 400);
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 9, vai_tro: 'quan_ly' })).status, 400, 'tài khoản bị khóa');
  const r = await s.api('admin', 'POST', '/roles', { user_id: 4, vai_tro: 'quan_ly' });
  assert.equal(r.status, 201);
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 4, vai_tro: 'quan_ly' })).status, 409);
  assert.equal((await s.api('bob', 'POST', '/containers', { name: 'Tủ của bob', type_id: kho.type })).status, 201, 'có vai trò thì quản lý ngay');
  assert.equal((await s.api('manager', 'DELETE', `/roles/${r.json.id}`)).status, 403);
  assert.equal((await s.api('admin', 'DELETE', `/roles/${r.json.id}`)).status, 200);
  assert.equal((await s.api('admin', 'DELETE', `/roles/${r.json.id}`)).status, 404);
  assert.equal((await s.api('bob', 'POST', '/containers', { name: 'Tủ 2 của bob', type_id: kho.type })).status, 403, 'gỡ vai trò thì mất quyền ngay');
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_role_grant') && s.auditLog.some((a) => a.action === 'nhm_role_revoke'));
});

test('tìm người: ít nhất 2 ký tự, không bỏ dấu cũng tìm được, không lộ tài khoản bị khóa', async () => {
  assert.equal((await s.api('sv', 'GET', '/users/search?q=a')).status, 400);
  assert.equal((await s.api(null, 'GET', '/users/search?q=truong')).status, 401);
  const r = await s.api('sv', 'GET', '/users/search?q=TRUONG');
  assert.deepEqual(r.json.users.map((u) => u.id), [6]);
  assert.equal((await s.api('sv', 'GET', '/users/search?q=locked')).json.users.length, 0);
});

test('sinh viên chưa có hồ sơ: phải khai loại chủ và nhóm khi thêm mẫu', async () => {
  const thieuLoai = await them('sv', kho.box, 1, 1, {});
  assert.equal(thieuLoai.status, 400);
  assert.match(thieuLoai.json.message, /loại chủ mẫu/);
  const thieuNhom = await them('sv', kho.box, 1, 1, { chu_loai: 'sinh_vien' });
  assert.equal(thieuNhom.status, 400);
  assert.match(thieuNhom.json.message, /nhóm nghiên cứu/);
  assert.equal((await them('sv', kho.box, 1, 1, { chu_loai: 'sinh_vien', nhom_id: 99999 })).status, 400);
  assert.equal((await them('sv', kho.box, 1, 1, { chu_loai: 'chủ tịch' })).status, 400);
});

test('đề xuất nhóm: bắt buộc chọn trưởng nhóm là tài khoản; trùng tên (không dấu, không hoa thường) dùng lại nhóm cũ', async () => {
  assert.equal((await s.api('sv', 'POST', '/groups/propose', { ten: '' })).status, 400);
  assert.equal((await s.api('sv', 'POST', '/groups/propose', { ten: 'Nhóm Nam' })).status, 400); // thiếu trưởng nhóm
  assert.equal((await s.api('sv', 'POST', '/groups/propose', { ten: 'Nhóm Nam', truong_user_id: 99999 })).status, 400);
  assert.equal((await s.api('sv', 'POST', '/groups/propose', { ten: 'Nhóm Nam', truong_user_id: 9 })).status, 400, 'tài khoản bị khóa');
  const g = await s.api('sv', 'POST', '/groups/propose', { ten: 'Nhóm Nam', truong_user_id: 6 });
  assert.equal(g.status, 201);
  s.nhom = g.json.id;
  const lai = await s.api('alice', 'POST', '/groups/propose', { ten: ' nhom   NAM ', truong_user_id: 4 });
  assert.equal(lai.status, 200);
  assert.deepEqual({ id: lai.json.id, daCo: lai.json.daCo }, { id: s.nhom, daCo: true });
  const ds = (await s.api('sv', 'GET', '/groups')).json.groups.filter((x) => x.id === s.nhom)[0];
  assert.equal(ds.trang_thai, 'cho_xac_nhan');
  assert.equal(ds.truong_xac_nhan, 0);
  assert.equal(ds.truong_ten, 'truong@sci.edu.vn');
});

test('trưởng nhóm được ghi nhận phải tự xác nhận hoặc từ chối; người khác không xác nhận hộ được (trừ quản lý)', async () => {
  const me = (await s.api('truong', 'GET', '/me')).json;
  assert.deepEqual(me.nhomChoXacNhan.map((g) => g.id), [s.nhom]);
  assert.equal((await s.api('sv', 'POST', `/groups/${s.nhom}/confirm-leader`)).status, 403, 'sinh viên không tự xác nhận trưởng nhóm của mình');
  assert.equal((await s.api('truong', 'POST', `/groups/${s.nhom}/confirm-leader`)).status, 200);
  assert.equal((await s.api('truong', 'GET', '/me')).json.nhomChoXacNhan.length, 0);
  assert.equal((await s.api('truong', 'POST', `/groups/${s.nhom}/confirm-leader`)).json.changed, 0);
  // từ chối: nhóm trở lại chưa có trưởng nhóm
  const g2 = await s.api('sv', 'POST', '/groups/propose', { ten: 'Nhóm Lan', truong_user_id: 6 });
  assert.equal((await s.api('alice', 'POST', `/groups/${g2.json.id}/decline-leader`)).status, 403);
  assert.equal((await s.api('truong', 'POST', `/groups/${g2.json.id}/decline-leader`)).status, 200);
  assert.equal(s.db.prepare('SELECT truong_user_id FROM nhm_nhom WHERE id = ?').get(g2.json.id).truong_user_id, null);
  assert.equal((await s.api('manager', 'POST', `/groups/${g2.json.id}/confirm-leader`)).status, 409, 'chưa có trưởng nhóm');
  s.nhomLan = g2.json.id;
});

test('sinh viên thêm mẫu vào nhóm đã có trưởng nhóm: mẫu ghi loại chủ + nhóm; nhóm không có trưởng nhóm bị chặn', async () => {
  const ok = await them('sv', kho.box, 1, 1, { chu_loai: 'sinh_vien', nhom_id: s.nhom });
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const hop = (await s.api('sv', 'GET', `/boxes/${kho.box}`)).json.tubes.find((t) => t.id === ok.json.id);
  assert.equal(hop.chu_loai, 'sinh_vien');
  assert.equal(hop.nhom_ten, 'Nhóm Nam');
  const khongTruong = await them('sv', kho.box, 1, 2, { chu_loai: 'sinh_vien', nhom_id: s.nhomLan });
  assert.equal(khongTruong.status, 400);
  assert.match(khongTruong.json.message, /chưa có trưởng nhóm/);
  // nghiên cứu viên thì được vào nhóm chưa có trưởng nhóm
  assert.equal((await them('sv', kho.box, 1, 2, { chu_loai: 'nghien_cuu_vien', nhom_id: s.nhomLan })).status, 201);
  s.mauSv = ok.json.id;
});

test('hồ sơ thành viên: chỉ quản lý gán; hồ sơ quyết định loại chủ, sinh viên không thêm mẫu cho nhóm khác', async () => {
  assert.equal((await s.api('alice', 'PUT', '/profiles/5', { loai: 'sinh_vien', nhom_id: s.nhom })).status, 403);
  assert.equal((await s.api('manager', 'PUT', '/profiles/5', { loai: 'sinh_vien' })).status, 400, 'sinh viên phải có nhóm');
  assert.equal((await s.api('manager', 'PUT', '/profiles/5', { loai: 'giáo sư', nhom_id: s.nhom })).status, 400);
  assert.equal((await s.api('manager', 'PUT', '/profiles/99999', { loai: 'can_bo' })).status, 404);
  assert.equal((await s.api('manager', 'PUT', '/profiles/5', { loai: 'sinh_vien', nhom_id: s.nhom })).status, 200);
  assert.equal((await s.api('manager', 'GET', '/profiles')).json.profiles.find((p) => p.user_id === 5).nhom_ten, 'Nhóm Nam');
  assert.equal((await s.api('sv', 'GET', '/me')).json.hoSo.loai, 'sinh_vien');
  // có hồ sơ: không cần khai lại
  assert.equal((await them('sv', kho.box, 2, 1, {})).status, 201);
  // khai gian loại chủ trong body bị bỏ qua, nhóm khác bị chặn
  const gian = await them('sv', kho.box, 2, 2, { chu_loai: 'can_bo', nhom_id: s.nhomLan });
  assert.equal(gian.status, 400);
  assert.match(gian.json.message, /nhóm nghiên cứu của mình/);
  const t = await them('sv', kho.box, 2, 2, { chu_loai: 'can_bo' });
  assert.equal(s.db.prepare('SELECT chu_loai FROM nhm_tubes WHERE id = ?').get(t.json.id).chu_loai, 'sinh_vien');
});

test('sinh viên ra trường: hồ sơ «đã rời đi» chặn thêm mẫu mới và ghi lịch sử vào mọi mẫu của họ', async () => {
  assert.equal((await s.api('manager', 'PUT', '/profiles/5', { trang_thai: 'da_roi_di' })).status, 200);
  assert.equal((await them('sv', kho.box, 3, 1, {})).status, 403);
  const h = (await s.api('manager', 'GET', `/tubes/${s.mauSv}/history`)).json.history;
  assert.equal(h[0].action, 'chu_roi_di');
  assert.match(h[0].note, /đã rời đi/);
  assert.equal((await s.api('manager', 'PUT', '/profiles/5', { trang_thai: 'dang_hoat_dong' })).status, 200);
  assert.equal((await s.api('manager', 'GET', `/tubes/${s.mauSv}/history`)).json.history[0].action, 'chu_tro_lai');
});

test('đổi nhóm: tên / trưởng nhóm / giải thể ghi vào lịch sử từng mẫu của nhóm; đổi trưởng nhóm phải xác nhận lại', async () => {
  assert.equal((await s.api('alice', 'PATCH', `/groups/${s.nhom}`, { ten: 'x' })).status, 403);
  assert.equal((await s.api('manager', 'PATCH', `/groups/${s.nhom}`, { ten: '' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/groups/${s.nhom}`, { trang_thai: 'xóa' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/groups/${s.nhom}`, { truong_user_id: 99999 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/groups/${s.nhom}`, { ten: 'Nhóm Nam' })).json.changed, 0);
  assert.equal((await s.api('manager', 'PATCH', `/groups/${s.nhom}`, { truong_user_id: 4 })).status, 200);
  const g = s.db.prepare('SELECT truong_user_id, truong_xac_nhan FROM nhm_nhom WHERE id = ?').get(s.nhom);
  assert.deepEqual(g, { truong_user_id: 4, truong_xac_nhan: 0 });
  const h = (await s.api('manager', 'GET', `/tubes/${s.mauSv}/history`)).json.history[0];
  assert.equal(h.action, 'nhom_doi');
  assert.match(h.note, /Trưởng nhóm: truong@sci\.edu\.vn → bob@sci\.edu\.vn/);
  // quản lý xác nhận thay
  assert.equal((await s.api('manager', 'PATCH', `/groups/${s.nhom}`, { truong_user_id: 6, truong_xac_nhan: true })).status, 200);
  assert.equal(s.db.prepare('SELECT truong_xac_nhan FROM nhm_nhom WHERE id = ?').get(s.nhom).truong_xac_nhan, 1);
  assert.equal((await s.api('manager', 'PATCH', `/groups/${s.nhom}`, { trang_thai: 'giai_the' })).status, 200);
  assert.equal((await s.api('manager', 'GET', `/tubes/${s.mauSv}/history`)).json.history[0].action, 'nhom_giai_the');
  assert.equal((await them('truong', kho.box, 4, 1, { chu_loai: 'nghien_cuu_vien', nhom_id: s.nhom })).status, 400, 'nhóm đã giải thể không chọn được');
  assert.ok(!(await s.api('alice', 'GET', '/groups')).json.groups.some((x) => x.id === s.nhom));
  assert.ok((await s.api('manager', 'GET', '/groups?all=1')).json.groups.some((x) => x.id === s.nhom));
  assert.equal((await s.api('alice', 'GET', '/groups?all=1')).json.groups.some((x) => x.id === s.nhom), false, 'người thường không xem được nhóm đã giải thể');
});

test('gộp nhóm trùng: mẫu và hồ sơ chuyển sang nhóm đích, nhóm nguồn giải thể, lịch sử ghi lại', async () => {
  const a = (await s.api('manager', 'POST', '/groups', { ten: 'Nhóm A', truong_user_id: 4 })).json.id;
  const b = (await s.api('manager', 'POST', '/groups', { ten: 'Nhóm A (bản sao)', truong_user_id: 4 })).json.id;
  const t = await them('bob', kho.box, 5, 1, { chu_loai: 'nghien_cuu_vien', nhom_id: b });
  assert.equal((await s.api('alice', 'POST', `/groups/${b}/merge`, { into_id: a })).status, 403);
  assert.equal((await s.api('manager', 'POST', `/groups/${b}/merge`, { into_id: b })).status, 400);
  assert.equal((await s.api('manager', 'POST', `/groups/${b}/merge`, { into_id: 99999 })).status, 400);
  const r = await s.api('manager', 'POST', `/groups/${b}/merge`, { into_id: a });
  assert.equal(r.status, 200);
  assert.equal(r.json.mau, 1);
  assert.equal(s.db.prepare('SELECT nhom_id FROM nhm_tubes WHERE id = ?').get(t.json.id).nhom_id, a);
  assert.equal(s.db.prepare('SELECT trang_thai FROM nhm_nhom WHERE id = ?').get(b).trang_thai, 'giai_the');
  assert.equal((await s.api('manager', 'GET', `/tubes/${t.json.id}/history`)).json.history[0].action, 'nhom_gop');
  assert.equal((await s.api('manager', 'POST', '/groups', { ten: 'nhóm a' })).status, 409, 'tên nhóm đang dùng');
  assert.equal((await s.api('manager', 'POST', '/groups', { ten: 'Nhóm A (bản sao)' })).status, 201, 'nhóm đã giải thể thì tên được dùng lại');
});

test('quản lý đổi loại chủ / nhóm của mẫu; chủ mẫu thường không đổi được', async () => {
  const t = await them('alice', kho.box, 6, 1, {});
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${t.json.id}`, { chu_loai: 'sinh_vien' })).status, 403);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${t.json.id}`, { nhom_id: s.nhomLan })).status, 403);
  assert.equal((await s.api('manager', 'PATCH', `/tubes/${t.json.id}`, { chu_loai: 'bậy' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/tubes/${t.json.id}`, { nhom_id: 99999 })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/tubes/${t.json.id}`, { chu_loai: 'nghien_cuu_vien', nhom_id: s.nhomLan })).status, 200);
  const h = (await s.api('alice', 'GET', `/tubes/${t.json.id}/history`)).json.history[0];
  assert.deepEqual(JSON.parse(h.note), { chu_loai: ['Cán bộ', 'Nghiên cứu viên'], nhom_id: [null, 'Nhóm Lan'] });
});

test('thiết bị Cellbank: người dùng thường không thêm, di chuyển, xóa, lấy ra được; quản lý thì được', async () => {
  const them1 = await them('alice', cellbank.box, 1, 1, {});
  assert.equal(them1.status, 403);
  assert.match(them1.json.message, /Cellbank/);
  assert.equal((await s.api('alice', 'POST', '/tubes/bulk', { box_id: cellbank.box, row_no: 1, col_no: 1, count: 2, name: 'x' })).status, 403);
  const t = await them('manager', cellbank.box, 1, 1, { chu_loai: 'can_bo' });
  assert.equal(t.status, 201);
  // chủ là alice (quản lý thêm hộ rồi chuyển chủ) — vẫn không tự thao tác trên thiết bị Cellbank
  await s.api('manager', 'POST', `/tubes/${t.json.id}/transfer`, { owner_user_id: 3 });
  for (const [m, p, b] of [
    ['POST', `/tubes/${t.json.id}/checkout`, {}],
    ['POST', `/tubes/${t.json.id}/thaw`, {}],
    ['POST', `/tubes/${t.json.id}/discard`, {}],
    ['POST', `/tubes/${t.json.id}/move`, { box_id: cellbank.box, row_no: 2, col_no: 2 }],
    ['DELETE', `/tubes/${t.json.id}`, undefined],
  ]) assert.equal((await s.api('alice', m, p, b)).status, 403, `${m} ${p}`);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${t.json.id}`, { passage: 'P9' })).status, 200, 'chủ mẫu vẫn sửa được thông tin mô tả');
  // mẫu công khai không được chuyển vào thiết bị Cellbank
  const cong = await them('alice', kho.box, 7, 1, {});
  assert.equal((await s.api('alice', 'POST', `/tubes/${cong.json.id}/move`, { box_id: cellbank.box, row_no: 3, col_no: 3 })).status, 403);
  assert.equal((await s.api('manager', 'POST', `/tubes/${t.json.id}/checkout`, { note: 'Ghi thao tác thử' })).status, 200);
});

test('Cellbank / công khai chỉ đặt ở thiết bị gốc, vị trí con thừa hưởng; cây trả quan_ly_boi hiệu lực', async () => {
  assert.equal((await s.api('manager', 'POST', '/containers', { name: 'Ngăn lạ', type_id: kho.type, parent_id: kho.container, quan_ly_boi: 'cellbank' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${cellbank.ngan}`, { quan_ly_boi: 'cong_khai' })).status, 400);
  assert.equal((await s.api('manager', 'POST', '/containers', { name: 'Tủ', type_id: kho.type, quan_ly_boi: 'lạ' })).status, 400);
  const cay = (await s.api('alice', 'GET', '/tree')).json.containers;
  assert.equal(cay.find((c) => c.id === cellbank.ngan).quan_ly_boi, 'cellbank');
  assert.equal(cay.find((c) => c.id === kho.container).quan_ly_boi, 'cong_khai');
  // đổi thiết bị gốc sang công khai thì người dùng thêm mẫu vào được
  assert.equal((await s.api('manager', 'PATCH', `/containers/${cellbank.container}`, { quan_ly_boi: 'cong_khai' })).status, 200);
  assert.equal((await them('alice', cellbank.box, 4, 4, {})).status, 201);
  assert.equal((await s.api('manager', 'PATCH', `/containers/${cellbank.container}`, { quan_ly_boi: 'cellbank' })).status, 200);
  assert.equal((await them('alice', cellbank.box, 5, 5, {})).status, 403);
});

test('lịch sử mẫu không sửa / xóa được ở mức CSDL, và lưu tên người thao tác tại thời điểm đó', async () => {
  const t = await them('alice', kho.box, 8, 1, {});
  assert.throws(() => s.db.prepare('UPDATE nhm_movements SET note = ? WHERE tube_id = ?').run('sửa lén', t.json.id), /chỉ được thêm, không được sửa/);
  assert.throws(() => s.db.prepare('DELETE FROM nhm_movements WHERE tube_id = ?').run(t.json.id), /chỉ được thêm, không được xóa/);
  s.db.prepare("UPDATE users SET fullname = 'Tên mới của Alice' WHERE id = 3").run();
  assert.equal(s.db.prepare('SELECT user_label FROM nhm_movements WHERE tube_id = ?').get(t.json.id).user_label, 'alice@sci.edu.vn');
  s.db.prepare("DELETE FROM users WHERE id = 20").run();
  assert.equal((await s.api('alice', 'GET', `/tubes/${t.json.id}/history`)).json.history[0].user_label, 'alice@sci.edu.vn');
});
