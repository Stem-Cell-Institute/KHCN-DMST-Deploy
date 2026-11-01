'use strict';

// Danh sách sinh viên của Viện (Trung tâm quản lý người học): nhập, tài khoản tạo sẵn chưa kích hoạt, hồ sơ module tự tạo,
// hết hạn chỉ khóa quyền vào module, gia hạn, thu hồi, quét định kỳ, đọc danh sách dán từ Excel.

const test = require('node:test');
const assert = require('node:assert/strict');
const SV = require('../services/nganHangTeBaoKhangTheSinhVien');
const { dungServer } = require('./helpers/nganHangServer');

let s;
let kho;

const TUONG_LAI = '2999-12-31';
const nhap = (user, text, hetHan = TUONG_LAI) => s.api(user, 'POST', '/students/import', { text, het_han: hetHan });
const taiKhoan = (email) => s.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const dong = (email) => s.db.prepare('SELECT * FROM nhm_sinh_vien WHERE email = ?').get(email);
const hoSo = (id) => s.db.prepare('SELECT * FROM nhm_ho_so WHERE user_id = ?').get(id);

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

// ── đọc danh sách ──

test('đọc danh sách dán từ Excel / CSV: tách TAB, dấu phẩy, chấm phẩy; bỏ dòng tiêu đề; chuẩn hóa email và ngày', () => {
  const { rows, loi } = SV.docDanhSach(
    ['Email\tHọ tên\tMã SV\tKhóa\tHạn', 'SV1@Gmail.com\tNguyễn  Văn A\t2201\tK22\t31/12/2999', 'sv2@x.vn;Trần Thị B;;;2999-01-01', '"sv3@x.vn", "Lê C", 2203, K22', '', 'khong-phai-email\tAi đó', 'sv4@x.vn\tX', 'sv5@x.vn\tPhạm Văn E\t\t\t31/02/2030'].join('\r\n'),
    '2999-06-30'
  );
  assert.deepEqual(rows.map((r) => [r.email, r.fullname, r.ma_sv, r.khoa, r.het_han]), [
    ['sv1@gmail.com', 'Nguyễn Văn A', '2201', 'K22', '2999-12-31'],
    ['sv2@x.vn', 'Trần Thị B', null, null, '2999-01-01'],
    ['sv3@x.vn', 'Lê C', '2203', 'K22', '2999-06-30'],
  ]);
  assert.deepEqual(loi.map((l) => l.dong), [6, 7, 8]);
  assert.match(loi[0].message, /Email/);
  assert.match(loi[1].message, /Họ tên/);
  assert.match(loi[2].message, /hạn dùng/i);
  assert.equal(SV.docDanhSach('a@b.vn\tTên', '').rows.length, 0, 'thiếu hạn');
  assert.equal(SV.chuanHoaNgay('31/02/2030'), null);
  assert.equal(SV.chuanHoaNgay('5-3-2030'), '2030-03-05');
  assert.equal(SV.conHieuLuc({ trang_thai: 'cho', het_han: '2000-01-01' }), false);
  assert.equal(SV.conHieuLuc({ trang_thai: 'da_xoa', het_han: TUONG_LAI }), false);
  assert.equal(SV.homNay(Date.UTC(2030, 0, 1, 18, 0, 0)), '2030-01-02', 'tính theo giờ Việt Nam (UTC+7)');
});

// ── API ──

test('chỉ admin và quản lý module dùng được danh sách sinh viên', async () => {
  for (const [m, p, b] of [['GET', '/students'], ['POST', '/students/import', { text: 'a@x.vn\tA B', het_han: TUONG_LAI }], ['PATCH', '/students/1', { khoa: 'x' }], ['DELETE', '/students/1']]) {
    assert.equal((await s.api(null, m, p, b)).status, 401, `${m} ${p}`);
    assert.equal((await s.api('alice', m, p, b)).status, 403, `${m} ${p}`);
    assert.equal((await s.api('svmoi', m, p, b)).status, 403, `${m} ${p}`);
  }
});

test('nhập danh sách: tạo dòng, tạo sẵn tài khoản sinh_vien CHƯA kích hoạt; báo lỗi từng dòng; đếm đúng', async () => {
  const r = await nhap('manager', ['sv1@gmail.com\tNguyễn Văn A\t2201\tK22', 'sv2@student.edu.vn\tTrần Thị B', 'x@sci.edu.vn\tCán bộ', 'sv1@gmail.com\tTrùng', 'hỏng\tAi', 'sv9@x.vn\tQuá hạn\t\t\t2001-01-01'].join('\n'));
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.moi, r.json.cap_nhat, r.json.tao_tai_khoan, r.json.bo_qua], [2, 0, 2, 3]);
  assert.equal(r.json.loi.length, 4);
  const u = taiKhoan('sv1@gmail.com');
  assert.deepEqual([u.role, u.password, u.fullname], ['sinh_vien', '', 'Nguyễn Văn A'], 'chưa kích hoạt: mật khẩu rỗng');
  assert.equal(taiKhoan('x@sci.edu.vn'), undefined, 'email @sci.edu.vn đăng ký bình thường, không tạo sẵn');
  assert.equal(dong('sv1@gmail.com').ma_sv, '2201');
  assert.equal((await nhap('manager', '')).status, 400);
  assert.equal((await s.api('manager', 'POST', '/students/import', { text: 'a@x.vn\tA B', het_han: '31/02/2030' })).status, 400);
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_students_import' && !/gmail/.test(a.detail)), 'nhật ký không ghi email');
});

test('nhập lại: cập nhật và gia hạn, không tạo trùng; tài khoản vai trò khác không bị đụng; tài khoản CRD cũ bị đặt lại', async () => {
  s.db.prepare("INSERT INTO users (id, fullname, email, role, password) VALUES (30, 'Khách CRD', 'chiem@gmail.com', 'crd_user', 'mat-khau-cua-ke-chiem')").run();
  s.db.prepare("INSERT INTO users (id, fullname, email, role, password) VALUES (31, 'Nghiên cứu viên', 'nc@gmail.com', 'researcher', 'mk')").run();
  const r = await nhap('manager', ['sv1@gmail.com\tNguyễn Văn A (sửa)\t2201\tK22\t2998-01-01', 'chiem@gmail.com\tNgười thật', 'nc@gmail.com\tNC'].join('\n'));
  assert.deepEqual([r.json.moi, r.json.cap_nhat, r.json.dat_lai_crd, r.json.tai_khoan_khac], [2, 1, 1, 1]);
  assert.equal(dong('sv1@gmail.com').het_han, '2998-01-01');
  assert.equal(taiKhoan('sv1@gmail.com').password, '');
  const chiem = taiKhoan('chiem@gmail.com');
  assert.deepEqual([chiem.role, chiem.password], ['sinh_vien', ''], 'người chiếm email trước (không xác minh hộp thư) mất quyền');
  assert.deepEqual([taiKhoan('nc@gmail.com').role, taiKhoan('nc@gmail.com').password], ['researcher', 'mk']);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM nhm_sinh_vien WHERE email = ?').get('sv1@gmail.com').c, 1);
});

test('danh sách: tình trạng chờ / đã kích hoạt, tìm bỏ dấu, lọc, không lộ mật khẩu', async () => {
  s.db.prepare("UPDATE users SET password = 'da-dat-mat-khau' WHERE email = 'sv2@student.edu.vn'").run();
  const ds = (await s.api('manager', 'GET', '/students')).json.students;
  assert.equal(ds.find((x) => x.email === 'sv2@student.edu.vn').tinh_trang, 'da_kich_hoat');
  assert.equal(ds.find((x) => x.email === 'sv1@gmail.com').tinh_trang, 'cho_kich_hoat');
  assert.ok(ds.every((x) => !('password' in x) && !('mk' in x)));
  assert.equal((await s.api('manager', 'GET', '/students?q=' + encodeURIComponent('tran thi'))).json.students.length, 1);
  assert.equal((await s.api('manager', 'GET', '/students?tinh_trang=da_kich_hoat')).json.students.length, 2); // sv2 và tài khoản nc@ (đã có sẵn tài khoản đầy đủ)
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_students_view'));
});

test('sinh viên không có trong danh sách (hoặc hết hạn) không vào được module; có trong danh sách thì vào được và tự có hồ sơ «sinh viên»', async () => {
  const chan = await s.api('svmoi', 'GET', '/me');
  assert.equal(chan.status, 403);
  assert.equal(chan.json.hetHan, true);
  assert.match(chan.json.message, /Đặt lịch thiết bị vẫn dùng được/);
  assert.equal((await s.api('svmoi', 'GET', '/tree')).status, 403);
  await nhap('manager', 'svmoi@gmail.com\tSinh Viên Mới\t2301\tK23');
  s.db.prepare("UPDATE users SET password = 'x' WHERE id = 8").run();
  const me = await s.api('svmoi', 'GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.hoSo.loai, 'sinh_vien');
  assert.equal(me.json.hoSo.nhom_id, null);
  assert.equal(me.json.sinhVien.het_han, TUONG_LAI);
  assert.equal((await s.api('svmoi', 'GET', '/tree')).status, 200);
  assert.equal((await s.api('alice', 'GET', '/me')).json.sinhVien, null, 'cán bộ không bị ảnh hưởng');
});

test('sinh viên mới chưa có nhóm: chọn nhóm khi thêm mẫu đầu tiên thì nhóm vào hồ sơ; chưa chọn nhóm thì bị từ chối', async () => {
  const nhom = (await s.api('manager', 'POST', '/groups', { ten: 'Nhóm SV Mới', truong_user_id: 6 })).json.id;
  const thieu = await s.api('svmoi', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 1, name: 'Mẫu của SV' });
  assert.equal(thieu.status, 400);
  assert.match(thieu.json.message, /nhóm nghiên cứu/);
  const ok = await s.api('svmoi', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 1, name: 'Mẫu của SV', nhom_id: nhom });
  assert.equal(ok.status, 201);
  assert.equal(hoSo(8).nhom_id, nhom);
  assert.equal(s.db.prepare('SELECT chu_loai FROM nhm_tubes WHERE id = ?').get(ok.json.id).chu_loai, 'sinh_vien');
  s.mauSv = ok.json.id;
  const khac = (await s.api('manager', 'POST', '/groups', { ten: 'Nhóm Khác', truong_user_id: 6 })).json.id;
  const sai = await s.api('svmoi', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 2, name: 'Sai nhóm', nhom_id: khac });
  assert.equal(sai.status, 400, 'đã có nhóm trong hồ sơ: không thêm cho nhóm khác');
});

test('HẾT HẠN: khóa quyền vào module (hồ sơ «đã rời đi», yêu cầu về mẫu chuyển cấp), danh sách ghi «hết hạn»; gia hạn thì mở lại', async () => {
  const yc = await s.api('alice', 'POST', `/tubes/${s.mauSv}/requests`, { ly_do: 'Cần dùng' });
  assert.equal(yc.json.cap, 'truong_nhom');
  s.db.prepare("UPDATE nhm_sinh_vien SET het_han = '2000-01-01' WHERE email = 'svmoi@gmail.com'").run();
  const r = await s.api('svmoi', 'GET', '/me');
  assert.equal(r.status, 403);
  assert.equal(r.json.hetHan, true);
  assert.equal(dong('svmoi@gmail.com').trang_thai, 'het_han');
  assert.equal(hoSo(8).trang_thai, 'da_roi_di');
  const h = (await s.api('manager', 'GET', `/tubes/${s.mauSv}/history`)).json.history.map((x) => x.action);
  assert.ok(h.includes('chu_roi_di'));
  assert.equal((await s.api('manager', 'GET', '/students')).json.students.find((x) => x.email === 'svmoi@gmail.com').tinh_trang, 'het_han');
  assert.equal(taiKhoan('svmoi@gmail.com').role, 'sinh_vien', 'tài khoản không bị khóa: vẫn dùng được Đặt lịch thiết bị');
  // gia hạn
  const id = dong('svmoi@gmail.com').id;
  assert.equal((await s.api('manager', 'PATCH', `/students/${id}`, { het_han: 'không phải ngày' })).status, 400);
  assert.equal((await s.api('manager', 'PATCH', `/students/${id}`, { het_han: '31/12/2999', khoa: 'K23 (gia hạn)' })).status, 200);
  assert.equal((await s.api('svmoi', 'GET', '/me')).status, 200);
  assert.equal(hoSo(8).trang_thai, 'dang_hoat_dong');
  assert.ok((await s.api('manager', 'GET', `/tubes/${s.mauSv}/history`)).json.history.map((x) => x.action).includes('chu_tro_lai'));
});

test('cắt hạn về quá khứ khóa ngay; thu hồi khóa và không gia hạn được nữa (phải nhập lại)', async () => {
  const id = dong('svmoi@gmail.com').id;
  assert.equal((await s.api('manager', 'PATCH', `/students/${id}`, { het_han: '2001-01-01' })).status, 200);
  assert.equal((await s.api('svmoi', 'GET', '/me')).status, 403);
  await s.api('manager', 'PATCH', `/students/${id}`, { het_han: TUONG_LAI });
  assert.equal((await s.api('svmoi', 'GET', '/me')).status, 200);
  assert.equal((await s.api('manager', 'DELETE', `/students/${id}`)).status, 200);
  assert.equal((await s.api('manager', 'DELETE', `/students/${id}`)).status, 409);
  assert.equal((await s.api('svmoi', 'GET', '/me')).status, 403);
  assert.equal(hoSo(8).trang_thai, 'da_roi_di');
  assert.equal((await s.api('manager', 'PATCH', `/students/${id}`, { khoa: 'x' })).status, 409);
  assert.equal((await s.api('manager', 'PATCH', '/students/99999', { khoa: 'x' })).status, 404);
  assert.equal((await s.api('manager', 'DELETE', '/students/99999')).status, 404);
  // nhập lại cấp lại quyền
  await nhap('manager', 'svmoi@gmail.com\tSinh Viên Mới\t2301\tK23');
  assert.equal((await s.api('svmoi', 'GET', '/me')).status, 200);
});

test('quét định kỳ: dòng quá hạn chuyển «hết hạn» và khóa hồ sơ; dòng hết hạn / thu hồi quá lâu bị xóa', async () => {
  await nhap('manager', 'quet1@x.vn\tQuét Một\n' + 'quet2@x.vn\tQuét Hai');
  s.db.prepare("UPDATE users SET password = 'x', role = 'sinh_vien' WHERE email = 'quet1@x.vn'").run();
  const u1 = taiKhoan('quet1@x.vn');
  s.db.prepare("INSERT INTO nhm_ho_so (user_id, loai) VALUES (?, 'sinh_vien')").run(u1.id);
  s.db.prepare("UPDATE nhm_sinh_vien SET het_han = '2000-01-01' WHERE email IN ('quet1@x.vn', 'quet2@x.vn')").run();
  s.db.prepare("INSERT INTO nhm_sinh_vien (email, fullname, het_han, trang_thai, updated_at) VALUES ('cu@x.vn', 'Rất cũ', '2001-01-01', 'het_han', '2001-01-01 00:00:00')").run();
  const kq = s.router.quetSinhVien();
  assert.equal(kq.hetHan, 2);
  assert.ok(kq.daXoa >= 1);
  assert.equal(dong('quet1@x.vn').trang_thai, 'het_han');
  assert.equal(hoSo(u1.id).trang_thai, 'da_roi_di');
  assert.equal(dong('cu@x.vn'), undefined, 'dòng đã hết hạn hơn 365 ngày bị xóa');
  assert.equal(s.router.quetSinhVien().hetHan, 0, 'chạy lại không làm gì thêm');
});

test('email trong danh sách còn hạn được phép đăng ký; hết hạn / thu hồi / ngoài danh sách thì không', () => {
  assert.equal(SV.emailDuocDangKy(s.db, 'SVMOI@gmail.com'), true);
  assert.equal(SV.emailDuocDangKy(s.db, 'quet1@x.vn'), false, 'hết hạn');
  assert.equal(SV.emailDuocDangKy(s.db, 'khong-co@x.vn'), false);
  assert.equal(SV.emailDuocDangKy(new (require('better-sqlite3'))(':memory:'), 'a@x.vn'), false, 'bảng chưa có thì không ai được phép');
});
