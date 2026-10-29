/**
 * tests/baoCaoPhongMau.test.js
 * Test cho phần kiểm tra biểu mẫu + dữ liệu nhập của module Báo cáo phòng ban.
 * Logic thuần, không cần server hay DB nên chạy được ở mọi nơi (kể cả CI không có DB).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { chuanHoaMau, kiemTraDuLieu } = require('../services/baoCaoPhongMau');

// ── chuanHoaMau ─────────────────────────────────────────────────────────────

test('biểu mẫu rỗng hoặc không phải mảng bị từ chối', () => {
  assert.equal(chuanHoaMau([]).ok, false);
  assert.equal(chuanHoaMau(null).ok, false);
  assert.equal(chuanHoaMau('abc').ok, false);
});

test('biểu mẫu chỉ có tiêu đề nhóm bị từ chối (không có ô nhập liệu)', () => {
  const kq = chuanHoaMau([{ kieu: 'section', nhan: 'Phần A' }]);
  assert.equal(kq.ok, false);
});

test('loại ô lạ và thiếu nhãn bị từ chối', () => {
  assert.equal(chuanHoaMau([{ kieu: 'script', nhan: 'x' }]).ok, false);
  assert.equal(chuanHoaMau([{ kieu: 'text', nhan: '   ' }]).ok, false);
});

test('ô mới được cấp khóa hợp lệ, ô cũ giữ nguyên khóa', () => {
  const kq = chuanHoaMau([
    { key: 'cong_viec', kieu: 'textarea', nhan: 'Công việc đã làm', bat_buoc: true },
    { kieu: 'number', nhan: 'Số cuộc họp' },
  ]);
  assert.equal(kq.ok, true);
  assert.equal(kq.truong[0].key, 'cong_viec', 'khóa cũ phải được giữ để dữ liệu các đợt trước còn khớp');
  assert.match(kq.truong[1].key, /^[a-z][a-z0-9_]{0,40}$/);
  assert.notEqual(kq.truong[1].key, 'cong_viec');
});

test('khóa trùng nhau bị từ chối', () => {
  const kq = chuanHoaMau([
    { key: 'a', kieu: 'text', nhan: 'A' },
    { key: 'a', kieu: 'text', nhan: 'B' },
  ]);
  assert.equal(kq.ok, false);
});

test('ô chọn cần ít nhất 2 lựa chọn khác nhau (lặp được gộp)', () => {
  assert.equal(chuanHoaMau([{ kieu: 'select', nhan: 'X', lua_chon: ['a'] }]).ok, false);
  assert.equal(chuanHoaMau([{ kieu: 'select', nhan: 'X', lua_chon: ['a', 'a', ' '] }]).ok, false);
  const ok = chuanHoaMau([{ kieu: 'select', nhan: 'X', lua_chon: ['a', 'b', 'a'] }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.truong[0].lua_chon, ['a', 'b']);
});

test('ô số: min lớn hơn max bị từ chối', () => {
  assert.equal(chuanHoaMau([{ kieu: 'number', nhan: 'N', min: 10, max: 5 }]).ok, false);
});

test('vượt 60 ô bị từ chối', () => {
  const nhieu = Array.from({ length: 61 }, (_, i) => ({ kieu: 'text', nhan: 'Ô ' + i }));
  assert.equal(chuanHoaMau(nhieu).ok, false);
});

test('tiêu đề nhóm không mang cờ bắt buộc', () => {
  const kq = chuanHoaMau([
    { kieu: 'section', nhan: 'Phần A', bat_buoc: true },
    { kieu: 'text', nhan: 'T' },
  ]);
  assert.equal(kq.ok, true);
  assert.equal('bat_buoc' in kq.truong[0], false);
});

// ── kiemTraDuLieu ───────────────────────────────────────────────────────────

const MAU = chuanHoaMau([
  { key: 'tt', kieu: 'textarea', nhan: 'Tóm tắt', bat_buoc: true },
  { key: 'so', kieu: 'number', nhan: 'Số', min: 0, max: 100 },
  { key: 'ngay', kieu: 'date', nhan: 'Ngày' },
  { key: 'loai', kieu: 'select', nhan: 'Loại', lua_chon: ['tot', 'kem'] },
  { key: 'cam_ket', kieu: 'checkbox', nhan: 'Cam kết', bat_buoc: true },
]).truong;

test('lưu nháp không đòi ô bắt buộc, nhưng nộp thì đòi', () => {
  assert.equal(kiemTraDuLieu(MAU, {}, { nop: false }).ok, true);
  const nop = kiemTraDuLieu(MAU, {}, { nop: true });
  assert.equal(nop.ok, false);
  assert.ok(nop.loi.tt && nop.loi.cam_ket);
});

test('số 0 là giá trị hợp lệ (không bị coi là trống)', () => {
  const kq = kiemTraDuLieu(MAU, { tt: 'x', cam_ket: true, so: 0 }, { nop: true });
  assert.equal(kq.ok, true);
  assert.equal(kq.du_lieu.so, 0);
});

test('chuỗi số được ép thành số; "abc", NaN, Infinity bị từ chối', () => {
  assert.equal(kiemTraDuLieu(MAU, { so: '42' }).du_lieu.so, 42);
  assert.ok(kiemTraDuLieu(MAU, { so: 'abc' }).loi.so);
  assert.ok(kiemTraDuLieu(MAU, { so: Infinity }).loi.so);
  assert.ok(kiemTraDuLieu(MAU, { so: NaN }).loi.so);
});

test('số ngoài khoảng min/max bị từ chối', () => {
  assert.ok(kiemTraDuLieu(MAU, { so: -1 }).loi.so);
  assert.ok(kiemTraDuLieu(MAU, { so: 101 }).loi.so);
});

test('ngày phải thật (30/02 không tồn tại)', () => {
  assert.equal(kiemTraDuLieu(MAU, { ngay: '2026-02-28' }).ok, true);
  assert.ok(kiemTraDuLieu(MAU, { ngay: '2026-02-30' }).loi.ngay);
  assert.ok(kiemTraDuLieu(MAU, { ngay: '28/02/2026' }).loi.ngay);
});

test('ô chọn chỉ nhận giá trị trong danh sách', () => {
  assert.equal(kiemTraDuLieu(MAU, { loai: 'tot' }).ok, true);
  assert.ok(kiemTraDuLieu(MAU, { loai: 'khac' }).loi.loai);
});

test('khóa lạ bị bỏ, không lọt vào dữ liệu lưu', () => {
  const kq = kiemTraDuLieu(MAU, { tt: 'x', cam_ket: true, __proto__x: 1, admin: true, o_la: 'độc' }, { nop: true });
  assert.equal(kq.ok, true);
  assert.deepEqual(Object.keys(kq.du_lieu).sort(), ['cam_ket', 'tt']);
});

test('dữ liệu không phải object thì coi như trống, không ném lỗi', () => {
  assert.equal(kiemTraDuLieu(MAU, null).ok, true);
  assert.equal(kiemTraDuLieu(MAU, [1, 2]).ok, true);
  assert.equal(kiemTraDuLieu(MAU, 'abc').ok, true);
});

test('văn bản quá dài bị từ chối, khoảng trắng hai đầu được cắt', () => {
  assert.ok(kiemTraDuLieu(MAU, { tt: 'a'.repeat(10001) }).loi.tt);
  assert.equal(kiemTraDuLieu(MAU, { tt: '  xin chào  ' }).du_lieu.tt, 'xin chào');
});

test('kiểu sai (số thay vì chuỗi cho ô văn bản) bị từ chối', () => {
  assert.ok(kiemTraDuLieu(MAU, { tt: 123 }).loi.tt);
  assert.ok(kiemTraDuLieu(MAU, { cam_ket: 'true' }).loi.cam_ket);
});
