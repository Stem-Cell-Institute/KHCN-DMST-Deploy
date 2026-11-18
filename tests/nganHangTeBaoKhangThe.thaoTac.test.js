'use strict';

// Chủ mẫu tự lấy mẫu của mình: không cần ai duyệt nhưng BẮT BUỘC khai thông tin thao tác; ở thiết bị Cellbank thì chủ mẫu
// cũng phải gửi yêu cầu; chủ mẫu thấy mẫu mất vì chính mình đã lấy thì khai bổ sung, không bị tính là vi phạm.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;
let cellbankBox;

const them = (user, box, r, c, extra) => s.api(user, 'POST', '/tubes', { box_id: box, row_no: r, col_no: c, name: `M${r}${c}`, ...extra });
const lichSu = async (id) => (await s.api('manager', 'GET', `/tubes/${id}/history`)).json.history;
const trangThai = (id) => s.db.prepare('SELECT status FROM nhm_tubes WHERE id = ?').get(id).status;

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
  const cb = await s.api('manager', 'POST', '/containers', { name: 'Bình CB', type_id: kho.type, quan_ly_boi: 'cellbank' });
  cellbankBox = (await s.api('manager', 'POST', '/boxes', { container_id: cb.json.id, template_id: kho.tpl99 })).json.ids[0];
});
test.after(() => s.dong());

test('lấy ra / trả lại / rã đông / hủy: thiếu hoặc quá ngắn thông tin thao tác thì 400 và nói rõ cần ghi gì', async () => {
  const m = (await them('alice', kho.box, 1, 1)).json.id;
  const thieu = async (act, nhan) => {
    for (const body of [undefined, {}, { note: '' }, { note: '  ' }, { note: 'ab' }]) {
      const r = await s.api('alice', 'POST', `/tubes/${m}/${act}`, body);
      assert.equal(r.status, 400, `${act} ${JSON.stringify(body)}`);
      assert.ok(r.json.message.includes(nhan), r.json.message);
    }
  };
  await thieu('checkout', 'mục đích sử dụng');
  assert.equal(trangThai(m), 'in_storage', 'không ghi thì mẫu không đổi trạng thái');
  assert.equal((await s.api('alice', 'POST', `/tubes/${m}/checkout`, { note: 'Chạy Western blot' })).status, 200);
  await thieu('checkin', 'tình trạng khi trả');
  assert.equal((await s.api('alice', 'POST', `/tubes/${m}/checkin`, { note: 'Còn khoảng 0,5 mL, bình thường' })).status, 200);
  await thieu('thaw', 'mục đích rã đông');
  await thieu('discard', 'lý do hủy');
  const h = await lichSu(m);
  assert.deepEqual(h.slice(0, 2).map((x) => [x.action, x.note]), [['checkin', 'Còn khoảng 0,5 mL, bình thường'], ['checkout', 'Chạy Western blot']]);
  assert.equal((await lichSu(m)).length, 3, 'các lần thiếu thông tin không để lại dòng lịch sử nào');
});

test('quyền và trạng thái được kiểm TRƯỚC thông tin thao tác (người lạ vẫn 403, mẫu đã hủy vẫn 409)', async () => {
  const m = (await them('alice', kho.box, 1, 2)).json.id;
  assert.equal((await s.api('bob', 'POST', `/tubes/${m}/checkout`, {})).status, 403);
  assert.equal((await s.api('alice', 'POST', `/tubes/${m}/checkin`, {})).status, 409, 'chưa lấy ra');
  assert.equal((await s.api('alice', 'POST', '/tubes/99999/checkout', {})).status, 404);
});

test('quản lý thao tác hộ cũng phải khai thông tin; nhật ký hoạt động ghi kèm thông tin', async () => {
  const m = (await them('alice', kho.box, 1, 3)).json.id;
  assert.equal((await s.api('manager', 'POST', `/tubes/${m}/discard`, {})).status, 400);
  assert.equal((await s.api('manager', 'POST', `/tubes/${m}/discard`, { note: 'Nhiễm mycoplasma, kiểm tra ngày 12/10' })).status, 200);
  assert.match(s.auditLog.filter((a) => a.action === 'nhm_tube_discard').pop().detail, /Nhiễm mycoplasma/);
});

test('mẫu của mình ở thiết bị Cellbank: không tự lấy được nhưng gửi yêu cầu được (Trưởng CIPP duyệt)', async () => {
  const m = (await them('manager', cellbankBox, 1, 1, { chu_loai: 'can_bo' })).json.id;
  await s.api('manager', 'POST', `/tubes/${m}/transfer`, { owner_user_id: 3 });
  assert.equal((await s.api('alice', 'POST', `/tubes/${m}/checkout`, { note: 'Cần dùng' })).status, 403);
  const r = await s.api('alice', 'POST', `/tubes/${m}/requests`, { ly_do: 'Lấy mẫu của chính tôi để rã đông' });
  assert.equal(r.status, 201);
  assert.equal(r.json.cap, 'truong_cellbank');
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/approve`)).status, 403, 'chủ mẫu không tự duyệt yêu cầu của mình');
  assert.equal((await s.api('cellbank', 'POST', `/requests/${r.json.id}/approve`)).status, 200);
  // mẫu của mình ở thiết bị công khai thì vẫn phải tự «Lấy ra», không gửi yêu cầu
  const cong = (await them('alice', kho.box, 2, 1)).json.id;
  const sai = await s.api('alice', 'POST', `/tubes/${cong}/requests`, { ly_do: 'x' });
  assert.equal(sai.status, 400);
  assert.match(sai.json.message, /Lấy ra/);
});

test('chủ mẫu thấy mẫu mất vì chính mình đã lấy: khai bổ sung (bắt buộc ghi mục đích), mẫu «đã lấy ra», không tính vi phạm', async () => {
  const m = (await them('alice', kho.box, 3, 1)).json.id;
  const vv = (await s.api('alice', 'POST', `/tubes/${m}/report-missing`, { mo_ta: 'Không thấy ống trong ô' })).json.id;
  const ds = (await s.api('alice', 'GET', '/incidents')).json.incidents.find((x) => x.id === vv);
  assert.equal(ds.co_the_tu_lay, true);
  assert.equal((await s.api('bob', 'GET', '/incidents')).json.incidents.find((x) => x.id === vv).co_the_tu_lay, false);
  assert.equal((await s.api('bob', 'POST', `/incidents/${vv}/self-taken`, { note: 'Tôi lấy' })).status, 403, 'chỉ chủ mẫu');
  assert.equal((await s.api('alice', 'POST', `/incidents/${vv}/self-taken`, {})).status, 400);
  assert.equal((await s.api('alice', 'POST', `/incidents/${vv}/self-taken`, { note: 'Lấy hôm thứ 3 để nuôi cấy, quên ghi vào hệ thống' })).status, 200);
  assert.equal(trangThai(m), 'checked_out');
  assert.equal((await s.api('alice', 'POST', `/incidents/${vv}/self-taken`, { note: 'Lần hai' })).status, 409, 'vụ việc đã đóng');
  const h = (await lichSu(m))[0];
  assert.equal(h.action, 'chu_tu_lay');
  assert.match(h.note, /quên ghi vào hệ thống/);
  assert.deepEqual((await s.api('manager', 'GET', '/violations')).json.violations, [], 'tự lấy mẫu của mình không phải vi phạm');
});
