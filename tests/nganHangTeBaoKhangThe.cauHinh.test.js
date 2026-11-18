'use strict';

// Các hạn chờ chỉnh được: quyền, kiểm tra khoảng, giá trị mặc định, và việc hạn mới thật sự được áp dụng
// (hạn phản hồi của yêu cầu, hạn bỏ mẫu chưa khai báo, hạn chốt thất lạc, nội dung email).

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;

const cho = () => new Promise((r) => setTimeout(r, 40));
const them = (user, r, c, extra) => s.api(user, 'POST', '/tubes', { box_id: kho.box, row_no: r, col_no: c, name: `M${r}${c}`, ...extra });
const ngayLech = (chuoi) => (new Date(chuoi.replace(' ', 'T') + 'Z').getTime() - Date.now()) / 86400000;

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

test('mặc định 3 / 7 / 14 ngày; ai đăng nhập cũng đọc được, kèm khoảng cho phép; /meta có hạn', async () => {
  assert.equal((await s.api(null, 'GET', '/settings')).status, 401);
  const r = (await s.api('alice', 'GET', '/settings')).json;
  assert.deepEqual(r.han, { PHAN_HOI_NGAY: 3, CHO_BO_NGAY: 7, CHO_NHAN_NGAY: 14 });
  assert.deepEqual(r.mac_dinh, r.han);
  assert.deepEqual(r.gioi_han.CHO_BO_NGAY, [1, 90]);
  assert.deepEqual((await s.api('alice', 'GET', '/meta')).json.han, r.han);
});

test('chỉ admin và quản lý module sửa được; kiểm tra khoảng và kiểu số', async () => {
  assert.equal((await s.api('alice', 'PUT', '/settings', { PHAN_HOI_NGAY: 2 })).status, 403);
  assert.equal((await s.api('truong', 'PUT', '/settings', { PHAN_HOI_NGAY: 2 })).status, 403);
  assert.equal((await s.api(null, 'PUT', '/settings', {})).status, 401);
  assert.equal((await s.api('manager', 'PUT', '/settings', {})).status, 400, 'không có hạn nào');
  assert.equal((await s.api('manager', 'PUT', '/settings', { thu_gi_do: 5 })).status, 400);
  for (const bad of [0, -1, 31, 'abc', 1.5, null, '']) {
    const r = await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: bad });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.json.message, /từ 1 đến 30 ngày/);
  }
  assert.equal((await s.api('manager', 'PUT', '/settings', { CHO_BO_NGAY: 91 })).status, 400);
  assert.equal((await s.api('manager', 'PUT', '/settings', { CHO_NHAN_NGAY: 0 })).status, 400);
  // một hạn sai thì không hạn nào được lưu
  assert.equal((await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: 5, CHO_BO_NGAY: 0 })).status, 400);
  assert.equal((await s.api('alice', 'GET', '/settings')).json.han.PHAN_HOI_NGAY, 3);
});

test('lưu hạn: đọc lại đúng, chỉ đổi cái được gửi, ghi nhật ký «cũ → mới»; lưu giá trị cũ thì changed = 0', async () => {
  const r = await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: '5', CHO_BO_NGAY: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, 2);
  assert.deepEqual(r.json.han, { PHAN_HOI_NGAY: 5, CHO_BO_NGAY: 10, CHO_NHAN_NGAY: 14 });
  assert.deepEqual((await s.api('bob', 'GET', '/settings')).json.han, r.json.han);
  const log = s.auditLog.filter((a) => a.action === 'nhm_settings_update').pop();
  assert.match(log.detail, /phản hồi.*: 3 → 5 ngày/);
  assert.match(log.detail, /bỏ mẫu.*: 7 → 10 ngày/);
  assert.equal((await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: 5 })).json.changed, 0);
  assert.equal((await s.api('admin', 'PUT', '/settings', { CHO_NHAN_NGAY: 30 })).json.han.CHO_NHAN_NGAY, 30);
  assert.equal((await s.api('admin', 'PUT', '/settings', { CHO_NHAN_NGAY: 14 })).status, 200);
});

test('giá trị hỏng trong CSDL bị bỏ qua, dùng mặc định', async () => {
  s.db.prepare("INSERT OR REPLACE INTO nhm_cau_hinh (key, value) VALUES ('han_phan_hoi_ngay', 'hỏng'), ('han_cho_nhan_ngay', '9999')").run();
  const han = (await s.api('alice', 'GET', '/settings')).json.han;
  assert.equal(han.PHAN_HOI_NGAY, 3);
  assert.equal(han.CHO_NHAN_NGAY, 14);
  assert.equal(han.CHO_BO_NGAY, 10, 'giá trị hợp lệ vẫn dùng');
  await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: 5, CHO_NHAN_NGAY: 14 });
});

test('hạn phản hồi mới áp dụng cho yêu cầu tạo sau; yêu cầu cũ giữ hạn đã ghi; email nói đúng số ngày', async () => {
  await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: 1 });
  const m = (await them('alice', 1, 1)).json.id;
  s.mails.length = 0;
  const r = await s.api('bob', 'POST', `/tubes/${m}/requests`, { ly_do: 'Thử hạn 1 ngày' });
  const ngay = ngayLech(r.json.han_phan_hoi);
  assert.ok(ngay > 0.9 && ngay < 1.1, `hạn ~1 ngày, thật ${ngay}`);
  await cho();
  assert.match(s.mails[0].text, /trong vòng 1 ngày/);
  await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: 10 });
  assert.equal(s.db.prepare('SELECT han_phan_hoi FROM nhm_yeu_cau WHERE id = ?').get(r.json.id).han_phan_hoi, r.json.han_phan_hoi, 'yêu cầu cũ giữ hạn');
  const m2 = (await them('alice', 1, 2)).json.id;
  const r2 = await s.api('bob', 'POST', `/tubes/${m2}/requests`, { ly_do: 'Thử hạn 10 ngày' });
  assert.ok(ngayLech(r2.json.han_phan_hoi) > 9.9);
  await s.api('manager', 'PUT', '/settings', { PHAN_HOI_NGAY: 3 });
});

test('hạn bỏ mẫu chưa khai báo đổi là áp dụng ngay cho mục đang chờ; thông báo lỗi nói đúng số ngày', async () => {
  await s.api('manager', 'PUT', '/settings', { CHO_BO_NGAY: 7 });
  const ph = (await s.api('manager', 'POST', '/findings', { box_id: kho.box, row_no: 5, col_no: 5, mo_ta: 'Ống nắp xanh' })).json.id;
  await s.api('manager', 'POST', `/findings/${ph}/remind`);
  s.db.prepare("UPDATE nhm_phat_hien SET nhac_dau_luc = datetime('now', '-3 days') WHERE id = ?").run(ph);
  const truoc = await s.api('manager', 'POST', `/findings/${ph}/discard`, { ly_do: 'Không ai nhận sau 3 ngày' });
  assert.equal(truoc.status, 409);
  assert.match(truoc.json.message, /7 ngày sau lần nhắc đầu tiên/);
  await s.api('manager', 'PUT', '/settings', { CHO_BO_NGAY: 2 }); // rút hạn: mục đã nhắc 3 ngày trước giờ bỏ được
  assert.equal((await s.api('manager', 'POST', `/findings/${ph}/discard`, { ly_do: 'Không ai nhận sau 3 ngày' })).status, 200);
  await s.api('manager', 'PUT', '/settings', { CHO_BO_NGAY: 7 });
});

test('hạn chốt thất lạc mới áp dụng cho vụ việc tạo sau', async () => {
  await s.api('manager', 'PUT', '/settings', { CHO_NHAN_NGAY: 2 });
  const m = (await them('alice', 2, 1)).json.id;
  const vv = await s.api('alice', 'POST', `/tubes/${m}/report-missing`, {});
  const han = s.db.prepare('SELECT han_nhan FROM nhm_vu_viec WHERE id = ?').get(vv.json.id).han_nhan;
  const ngay = ngayLech(han);
  assert.ok(ngay > 1.9 && ngay < 2.1, `hạn ~2 ngày, thật ${ngay}`);
  const som = await s.api('manager', 'POST', `/incidents/${vv.json.id}/lost`, { ly_do: 'Thử chốt sớm' });
  assert.equal(som.status, 409);
  assert.match(som.json.message, /2 ngày sau khi báo/);
  await s.api('manager', 'PUT', '/settings', { CHO_NHAN_NGAY: 14 });
});

test('khôi phục mặc định bằng cách lưu lại các giá trị mặc định', async () => {
  const r = await s.api('manager', 'PUT', '/settings', (await s.api('alice', 'GET', '/settings')).json.mac_dinh);
  assert.deepEqual(r.json.han, { PHAN_HOI_NGAY: 3, CHO_BO_NGAY: 7, CHO_NHAN_NGAY: 14 });
});
