'use strict';

// Nhập danh sách sinh viên bằng tệp Excel / CSV: tải mẫu, đọc cột theo tên tiêu đề, xem trước không ghi gì, lỗi tệp, thao tác cả đợt.

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const SV = require('../services/nganHangTeBaoKhangTheSinhVien');
const { dungServer } = require('./helpers/nganHangServer');

let s;

const TUONG_LAI = '2999-12-31';
const dong = (email) => s.db.prepare('SELECT * FROM nhm_sinh_vien WHERE email = ?').get(email);
const taiKhoan = (email) => s.db.prepare('SELECT * FROM users WHERE email = ?').get(email);

async function xlsx(bang, tenTrang = 'Sheet1') {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(tenTrang);
  bang.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Gửi tệp (multipart) tới /students/import-file. */
async function guiTep(user, buf, ten, truong = {}) {
  const fd = new FormData();
  Object.entries(truong).forEach(([k, v]) => fd.append(k, v));
  if (buf) fd.append('tep', new Blob([buf]), ten);
  const res = await fetch(s.base + '/students/import-file', { method: 'POST', headers: user ? { 'x-test-user': user } : {}, body: fd });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  s = await dungServer();
  await s.taoKho();
});
test.after(() => s.dong());

test('tải mẫu .xlsx: chỉ quản lý; đúng tiêu đề; có trang hướng dẫn; điền vào rồi nhập lại được (vòng tròn)', async () => {
  const get = (user) => fetch(s.base + '/students/template.xlsx', { headers: user ? { 'x-test-user': user } : {} });
  assert.equal((await get(null)).status, 401);
  assert.equal((await get('alice')).status, 403);
  const r = await get('manager');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  assert.match(r.headers.get('content-disposition'), /mau-danh-sach-sinh-vien\.xlsx/);
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Danh sách', 'Hướng dẫn']);
  assert.deepEqual(wb.getWorksheet('Danh sách').getRow(1).values.slice(1), ['Email', 'Họ và tên', 'Mã sinh viên', 'Khóa / Đợt', 'Hạn dùng (dd/mm/yyyy)']);
  assert.match(String(wb.getWorksheet('Hướng dẫn').getRow(1).getCell(1).value), /HƯỚNG DẪN/);
  // điền hai sinh viên vào chính tệp mẫu rồi xem trước
  const ws = wb.getWorksheet('Danh sách');
  ws.addRow(['mau1@gmail.com', 'Sinh Viên Mẫu Một', '2501', 'K25', '30/06/2999']);
  ws.addRow(['mau2@gmail.com', 'Sinh Viên Mẫu Hai']);
  const dien = Buffer.from(await wb.xlsx.writeBuffer());
  const xem = await guiTep('manager', dien, 'mau.xlsx', { het_han: TUONG_LAI, xem_truoc: '1' });
  assert.equal(xem.status, 200);
  assert.deepEqual([xem.json.moi, xem.json.cap_nhat, xem.json.xem_truoc, xem.json.co_tieu_de], [2, 0, true, true]);
  assert.equal(xem.json.mau[1].het_han, TUONG_LAI, 'dòng không ghi hạn lấy hạn mặc định');
});

test('XEM TRƯỚC không ghi gì: không dòng danh sách, không tài khoản; nhập thật thì mới ghi', async () => {
  const buf = await xlsx([['Email', 'Họ và tên', 'Hạn dùng'], ['xt1@gmail.com', 'Xem Trước', '31/12/2999']]);
  const xem = await guiTep('manager', buf, 'a.xlsx', { xem_truoc: '1' });
  assert.equal(xem.json.moi, 1);
  assert.equal(dong('xt1@gmail.com'), undefined);
  assert.equal(taiKhoan('xt1@gmail.com'), undefined);
  assert.equal(s.auditLog.filter((a) => a.action === 'nhm_students_import').length, 0, 'xem trước không ghi nhật ký nhập');
  const that = await guiTep('manager', buf, 'a.xlsx', {});
  assert.equal(that.status, 200);
  assert.equal(that.json.xem_truoc, false);
  assert.ok(dong('xt1@gmail.com'));
  assert.equal(taiKhoan('xt1@gmail.com').role, 'sinh_vien');
  assert.match(s.auditLog.filter((a) => a.action === 'nhm_students_import').pop().detail, /^tệp:/);
});

test('cột nhận theo TÊN tiêu đề, không theo thứ tự: tiêu đề khác, thêm cột lạ, họ đệm + tên tách riêng, ngày Excel (Date và số serial)', async () => {
  const buf = await xlsx([
    ['STT', 'Ghi chú', 'Họ đệm', 'Tên', 'Ngày ra trường', 'Email sinh viên', 'MSSV', 'Đợt'],
    [1, 'x', 'Nguyễn Văn', 'An', new Date(Date.UTC(2999, 5, 30)), 'AN.NGUYEN@Gmail.com', 2201, 'Đợt 1'],
    [2, 'y', 'Lê', 'Bình', 90000, 'binh@gmail.com', '2202', 'Đợt 1'],
    [3, '', '', '', '', '', '', ''],
    [4, 'z', 'Phạm', 'Chi', '31/02/2999', 'chi@gmail.com', '', ''],
  ]);
  const r = await guiTep('manager', buf, 'dot1.xlsx', { het_han: TUONG_LAI, xem_truoc: '1' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.moi, 2);
  assert.deepEqual(r.json.loi.map((l) => l.dong), [5]);
  assert.match(r.json.loi[0].message, /hạn dùng/i);
  assert.deepEqual(r.json.mau.map((m) => [m.email, m.fullname, m.khoa, m.het_han]), [
    ['an.nguyen@gmail.com', 'Nguyễn Văn An', 'Đợt 1', '2999-06-30'],
    ['binh@gmail.com', 'Lê Bình', 'Đợt 1', new Date(Date.UTC(1899, 11, 30) + 90000 * 86400000).toISOString().slice(0, 10)], // số serial ngày của Excel
  ]);
});

test('trang tính đầu có thể không tên «Danh sách»; trang «Hướng dẫn» bị bỏ qua; tiêu đề không ở dòng 1 vẫn nhận', async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Hướng dẫn').addRow(['bỏ qua email: x@y.vn']);
  const ws = wb.addWorksheet('Đợt 12');
  ws.addRow(['TRUNG TÂM QUẢN LÝ NGƯỜI HỌC — DANH SÁCH ĐỢT 12']);
  ws.addRow([]);
  ws.addRow(['Họ và tên', 'Email', 'Hạn']);
  ws.addRow(['Trần Thị Dung', 'dung@gmail.com', '2999-01-01']);
  const r = await guiTep('manager', Buffer.from(await wb.xlsx.writeBuffer()), 'dot12.xlsx', { xem_truoc: '1' });
  assert.equal(r.json.moi, 1);
  assert.equal(r.json.mau[0].email, 'dung@gmail.com');
});

test('tệp CSV: dấu chấm phẩy hoặc phẩy, có BOM, tiêu đề tiếng Việt', async () => {
  const csv = '\uFEFFEmail;Họ và tên;Mã SV;Khóa;Hạn dùng\r\ncsv1@gmail.com;Võ Văn E;2301;K23;15/08/2999\r\ncsv2@gmail.com;"Đặng, Thị F";2302;K23;\r\n';
  const r = await guiTep('manager', Buffer.from(csv), 'ds.csv', { het_han: TUONG_LAI, xem_truoc: '1' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.moi, 2);
  assert.deepEqual(r.json.mau.map((m) => [m.fullname, m.het_han]), [['Võ Văn E', '2999-08-15'], ['Đặng, Thị F', TUONG_LAI]]);
});

test('tệp sai: thiếu tệp, đuôi lạ, hỏng, quá lớn, không có cột email, rỗng, người không có quyền', async () => {
  const ok = await xlsx([['Email', 'Họ tên'], ['a@gmail.com', 'A B']]);
  assert.equal((await guiTep(null, ok, 'a.xlsx')).status, 401);
  assert.equal((await guiTep('alice', ok, 'a.xlsx')).status, 403);
  assert.equal((await guiTep('manager', null, '', { het_han: TUONG_LAI })).status, 400);
  const xls = await guiTep('manager', ok, 'cu.xls', { het_han: TUONG_LAI });
  assert.equal(xls.status, 400);
  assert.match(xls.json.message, /\.xlsx hoặc \.csv/);
  const hong = await guiTep('manager', Buffer.from('không phải zip'), 'hong.xlsx', { het_han: TUONG_LAI });
  assert.equal(hong.status, 400);
  assert.match(hong.json.message, /Không đọc được/);
  const lon = await guiTep('manager', Buffer.alloc(2 * 1024 * 1024 + 10, 1), 'lon.xlsx', { het_han: TUONG_LAI });
  assert.equal(lon.status, 400);
  assert.match(lon.json.message, /quá lớn/);
  const khongEmail = await guiTep('manager', await xlsx([['Tên', 'Lớp'], ['A B', 'x']]), 'k.xlsx', { het_han: TUONG_LAI });
  assert.equal(khongEmail.status, 400, 'không nhận ra cột email thì không nhập gì');
  assert.equal((await guiTep('manager', ok, 'a.xlsx', { het_han: 'không phải ngày' })).status, 400);
  assert.equal(dong('a@gmail.com'), undefined, 'mọi trường hợp lỗi đều không ghi gì');
});

test('xem trước báo đúng tài khoản CRD cũ sẽ bị đặt lại và tài khoản vai trò khác bị bỏ qua, nhưng không đụng tới chúng', async () => {
  s.db.prepare("INSERT INTO users (id, fullname, email, role, password) VALUES (40, 'Khách', 'crdcu@gmail.com', 'crd_user', 'mk-cu')").run();
  s.db.prepare("INSERT INTO users (id, fullname, email, role, password) VALUES (41, 'NCV', 'ncv@gmail.com', 'researcher', 'mk')").run();
  const buf = await xlsx([['Email', 'Họ tên'], ['crdcu@gmail.com', 'Người Thật'], ['ncv@gmail.com', 'NCV']]);
  const xem = await guiTep('manager', buf, 'b.xlsx', { het_han: TUONG_LAI, xem_truoc: '1' });
  assert.deepEqual([xem.json.dat_lai_crd, xem.json.tai_khoan_khac], [1, 1]);
  assert.deepEqual([taiKhoan('crdcu@gmail.com').role, taiKhoan('crdcu@gmail.com').password], ['crd_user', 'mk-cu'], 'xem trước không đặt lại');
});

test('thao tác CẢ ĐỢT: gia hạn, đánh dấu ra trường (khóa ngay), thu hồi; chỉ quản lý; kiểm tra tham số', async () => {
  const buf = await xlsx([['Email', 'Họ tên', 'Khóa', 'Hạn'], ['d1@gmail.com', 'Đợt Một A', 'K20', '01/01/2999'], ['d2@gmail.com', 'Đợt Một B', 'K20', '01/01/2999'], ['d3@gmail.com', 'Đợt Hai', 'K21', '01/01/2999']]);
  await guiTep('manager', buf, 'dot.xlsx', {});
  // d1 đã kích hoạt, có hồ sơ module
  s.db.prepare("UPDATE users SET password = 'x' WHERE email = 'd1@gmail.com'").run();
  const d1 = taiKhoan('d1@gmail.com');
  s.db.prepare("INSERT INTO nhm_ho_so (user_id, loai) VALUES (?, 'sinh_vien')").run(d1.id);
  const bulk = (user, body) => s.api(user, 'POST', '/students/bulk', body);
  assert.equal((await bulk('alice', { khoa: 'K20', hanh_dong: 'thu_hoi' })).status, 403);
  assert.equal((await bulk('manager', { khoa: 'K20', hanh_dong: 'xoa_het' })).status, 400);
  assert.equal((await bulk('manager', { khoa: 'K20', hanh_dong: 'gia_han' })).status, 400, 'gia hạn cần hạn mới');
  assert.equal((await bulk('manager', { khoa: 'K20', hanh_dong: 'gia_han', het_han: '2000-01-01' })).status, 400, 'hạn mới phải từ hôm nay');
  assert.equal((await bulk('manager', { khoa: 'K99', hanh_dong: 'thu_hoi' })).status, 404);
  const gh = await bulk('manager', { khoa: 'K20', hanh_dong: 'gia_han', het_han: '2998-12-31' });
  assert.equal(gh.json.so_luong, 2);
  assert.equal(dong('d1@gmail.com').het_han, '2998-12-31');
  assert.equal(dong('d3@gmail.com').het_han, '2999-01-01', 'đợt khác không bị đụng');
  // đợt K20 ra trường: khóa ngay
  const rt = await bulk('manager', { khoa: 'K20', hanh_dong: 'ra_truong' });
  assert.equal(rt.json.so_luong, 2);
  assert.equal(dong('d1@gmail.com').trang_thai, 'het_han');
  assert.equal(SV.conHieuLuc(dong('d1@gmail.com')), false);
  assert.equal(s.db.prepare('SELECT trang_thai FROM nhm_ho_so WHERE user_id = ?').get(d1.id).trang_thai, 'da_roi_di');
  assert.equal(taiKhoan('d1@gmail.com').role, 'sinh_vien', 'tài khoản không bị khóa');
  // gia hạn cả đợt đã hết hạn thì mở lại
  await bulk('manager', { khoa: 'K20', hanh_dong: 'gia_han', het_han: '2999-06-30' });
  assert.equal(SV.conHieuLuc(dong('d1@gmail.com')), true);
  assert.equal(s.db.prepare('SELECT trang_thai FROM nhm_ho_so WHERE user_id = ?').get(d1.id).trang_thai, 'dang_hoat_dong');
  const th = await bulk('manager', { khoa: 'K21', hanh_dong: 'thu_hoi' });
  assert.equal(th.json.so_luong, 1);
  assert.equal(dong('d3@gmail.com').trang_thai, 'da_xoa');
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_students_bulk' && /ra_truong đợt «K20»: 2 sinh viên/.test(a.detail)));
});
