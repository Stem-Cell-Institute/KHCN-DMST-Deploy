'use strict';

// Phiếu yêu cầu lấy mẫu in được (kèm kết quả duyệt), lịch sử xử lý, email tới người yêu cầu và quản lý module.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;

const cho = () => new Promise((r) => setTimeout(r, 40));
const den = (tieuDe) => s.mails.filter((m) => m.subject.includes(tieuDe)).map((m) => m.to).sort();
const them = (user, r, c) => s.api(user, 'POST', '/tubes', { box_id: kho.box, row_no: r, col_no: c, name: `P${r}${c}`, chu_loai: 'can_bo' });
const xin = (user, id, lyDo = 'Cần cho thí nghiệm') => s.api(user, 'POST', `/tubes/${id}/requests`, { ly_do: lyDo });
const phieu = async (user, id) => {
  const res = await fetch(`${s.base}/requests/${id}/print`, { headers: user ? { 'x-test-user': user } : {} });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
};

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

test('phiếu: chỉ người liên quan xem được; yêu cầu đang chờ ghi rõ chưa có giá trị', async () => {
  const m = (await them('alice', 1, 1)).json.id;
  const r = await xin('bob', m);
  const p = await phieu('bob', r.json.id);
  assert.equal(p.status, 200);
  assert.match(p.type, /text\/html/);
  assert.match(p.text, /PHIẾU YÊU CẦU LẤY MẪU/);
  assert.match(p.text, new RegExp('YC-' + String(r.json.id).padStart(6, '0')));
  assert.match(p.text, /ĐANG CHỜ DUYỆT/);
  assert.match(p.text, /CHƯA có giá trị nhận mẫu/);
  assert.equal((await phieu('alice', r.json.id)).status, 200, 'người duyệt xem được');
  assert.equal((await phieu('manager', r.json.id)).status, 200, 'quản lý xem được');
  assert.equal((await phieu('admin', r.json.id)).status, 200, 'admin xem được');
  assert.equal((await phieu('sv', r.json.id)).status, 403, 'người không liên quan');
  assert.equal((await phieu(null, r.json.id)).status, 401);
  assert.equal((await phieu('bob', 99999)).status, 404);
});

test('duyệt: phiếu có xác nhận đã duyệt, tên người duyệt; dữ liệu nhập được escape; email gửi người yêu cầu và quản lý module', async () => {
  const m = (await them('alice', 1, 2)).json.id;
  const r = await xin('bob', m, 'Làm thí nghiệm <script>alert(1)</script> & thử');
  s.mails.length = 0;
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/approve`, { ly_do: 'Đồng ý, nhớ trả trong tuần' })).status, 200);
  await cho();
  assert.deepEqual(den('Đã duyệt yêu cầu'), ['bob@sci.edu.vn', 'manager@sci.edu.vn']);
  assert.match(s.mails.find((x) => x.to === 'bob@sci.edu.vn').text, /requests\/\d+\/print/, 'thư có liên kết tới phiếu');
  const p = await phieu('bob', r.json.id);
  assert.match(p.text, /ĐÃ ĐƯỢC DUYỆT/);
  assert.match(p.text, /alice@sci\.edu\.vn/);
  assert.match(p.text, /Đồng ý, nhớ trả trong tuần/);
  assert.doesNotMatch(p.text, /<script>alert/, 'không để lọt thẻ script');
  assert.match(p.text, /&lt;script&gt;/);
  assert.match(p.text, /Người nhận mẫu xuất trình phiếu/);
});

test('từ chối: phiếu ghi đã từ chối + lý do; email gửi người yêu cầu và quản lý module', async () => {
  const m = (await them('alice', 1, 3)).json.id;
  const r = await xin('bob', m);
  s.mails.length = 0;
  assert.equal((await s.api('alice', 'POST', `/requests/${r.json.id}/reject`, { ly_do: 'Mẫu cuối, chưa dùng được' })).status, 200);
  await cho();
  assert.deepEqual(den('bị từ chối'), ['bob@sci.edu.vn', 'manager@sci.edu.vn']);
  const p = await phieu('bob', r.json.id);
  assert.match(p.text, /ĐÃ BỊ TỪ CHỐI/);
  assert.match(p.text, /Mẫu cuối, chưa dùng được/);
  assert.doesNotMatch(p.text, /Người nhận mẫu xuất trình phiếu/, 'không có xác nhận nhận mẫu khi bị từ chối');
});

test('lịch sử xử lý: người duyệt thấy những gì mình đã xử lý, quản lý thấy tất cả, người xin chỉ thấy trong «của tôi»', async () => {
  const lichSu = async (user) => (await s.api(user, 'GET', '/requests?view=done')).json.requests;
  const cuaAlice = await lichSu('alice');
  assert.ok(cuaAlice.length >= 2, 'alice đã duyệt một và từ chối một');
  assert.ok(cuaAlice.every((y) => y.trang_thai !== 'cho_duyet' && y.xu_ly_ten));
  assert.ok(cuaAlice.some((y) => y.trang_thai === 'da_duyet') && cuaAlice.some((y) => y.trang_thai === 'tu_choi'));
  assert.ok(cuaAlice.every((y) => y.co_the_in === true));
  assert.equal((await lichSu('bob')).length, 0, 'bob chỉ gửi yêu cầu, chưa xử lý yêu cầu nào');
  const mine = (await s.api('bob', 'GET', '/requests?view=mine')).json.requests;
  assert.ok(mine.length >= 3 && mine.every((y) => y.co_the_in === true), 'người xin in được phiếu của mình');
  const tatCa = await lichSu('manager');
  assert.ok(tatCa.length >= cuaAlice.length);
  assert.equal((await s.api(null, 'GET', '/requests?view=done')).status, 401);
});
