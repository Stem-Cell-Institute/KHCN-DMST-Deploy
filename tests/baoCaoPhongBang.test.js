/**
 * tests/baoCaoPhongBang.test.js
 * Bảng nhiều dòng (bang) và ô tổng hợp (tong_hop) của biểu mẫu báo cáo phòng ban.
 * Logic thuần, không cần server hay DB.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { chuanHoaMau, kiemTraDuLieu, tinhTongHop } = require('../services/baoCaoPhongMau');
const { TRUONG_MAC_DINH } = require('../services/baoCaoPhongMauMacDinh');

const COT = [
  { key: 'ten', kieu: 'text', nhan: 'Tên việc' },
  { key: 'pt', kieu: 'number', nhan: 'Mức độ (%)', min: 0, max: 100, phan_tram: true },
  { key: 'ghi', kieu: 'textarea', nhan: 'Ghi chú' },
];
const bangDef = (them = {}) => ({ key: 'b1', kieu: 'bang', nhan: 'Công việc', cot: COT, ...them });
const tongHop = (bang) => ({ key: 't1', kieu: 'tong_hop', nhan: 'Thống kê', bang });

test('mẫu mặc định của Viện hợp lệ và qua chuanHoaMau không mất ô nào', () => {
  const kq = chuanHoaMau(TRUONG_MAC_DINH);
  assert.equal(kq.ok, true, JSON.stringify(kq.loi));
  assert.deepEqual(kq.truong.map((o) => o.key), TRUONG_MAC_DINH.map((o) => o.key), 'khóa ô giữ nguyên');
});

// ── Định nghĩa bảng ──────────────────────────────────────────────────────────

test('bảng: cần ít nhất một cột, tối đa 8 cột, khóa cột không trùng', () => {
  assert.equal(chuanHoaMau([bangDef({ cot: [] })]).ok, false);
  const chin = Array.from({ length: 9 }, (_, i) => ({ kieu: 'text', nhan: 'C' + i }));
  assert.equal(chuanHoaMau([bangDef({ cot: chin })]).ok, false);
  const trung = [{ key: 'a', kieu: 'text', nhan: 'A' }, { key: 'a', kieu: 'text', nhan: 'B' }];
  assert.equal(chuanHoaMau([bangDef({ cot: trung })]).ok, false);
});

test('bảng: loại cột lạ, cột thiếu tiêu đề bị từ chối; cột mới được cấp khóa', () => {
  assert.equal(chuanHoaMau([bangDef({ cot: [{ kieu: 'bang', nhan: 'X' }] })]).ok, false, 'không lồng bảng trong bảng');
  assert.equal(chuanHoaMau([bangDef({ cot: [{ kieu: 'text', nhan: ' ' }] })]).ok, false);
  const kq = chuanHoaMau([bangDef({ cot: [{ kieu: 'text', nhan: 'Mới' }] })]);
  assert.equal(kq.ok, true);
  assert.match(kq.truong[0].cot[0].key, /^c_[a-z0-9]+$/);
});

test('bảng: chỉ MỘT cột được chọn làm mức độ hoàn thành, và phải là cột Số', () => {
  const hai = COT.map((c) => ({ ...c })).concat({ key: 'pt2', kieu: 'number', nhan: 'Khác', phan_tram: true });
  assert.equal(chuanHoaMau([bangDef({ cot: hai })]).ok, false);
  const sai = [{ key: 'x', kieu: 'text', nhan: 'Văn bản', phan_tram: true }];
  assert.equal(chuanHoaMau([bangDef({ cot: sai })]).ok, false);
});

test('ô tổng hợp: phải trỏ tới bảng CÓ THẬT và bảng đó phải có cột mức độ hoàn thành', () => {
  assert.equal(chuanHoaMau([bangDef(), tongHop(['b1'])]).ok, true);
  assert.equal(chuanHoaMau([bangDef(), tongHop([])]).ok, false, 'không chọn bảng nào');
  assert.equal(chuanHoaMau([bangDef(), tongHop(['khong_co'])]).ok, false, 'bảng không tồn tại');
  const khongPt = bangDef({ cot: [{ key: 'a', kieu: 'text', nhan: 'A' }] });
  assert.equal(chuanHoaMau([khongPt, tongHop(['b1'])]).ok, false, 'bảng không có cột %');
  const khongPhaiBang = { key: 'o1', kieu: 'text', nhan: 'Ô thường' };
  assert.equal(chuanHoaMau([khongPhaiBang, tongHop(['o1'])]).ok, false, 'trỏ vào ô không phải bảng');
});

test('chỉ có ô tổng hợp (không có ô nhập liệu nào) thì không hợp lệ', () => {
  assert.equal(chuanHoaMau([tongHop([])]).ok, false);
  assert.equal(chuanHoaMau([bangDef(), tongHop(['b1'])]).ok, true);
});

// ── Dữ liệu bảng ─────────────────────────────────────────────────────────────

const MAU = chuanHoaMau([bangDef({ cho_phep_nhom: true, bat_buoc: true }), tongHop(['b1'])]).truong;

test('dữ liệu bảng: dòng trống và nhóm trống bị bỏ; số được ép; khóa lạ trong dòng bị bỏ', () => {
  const dong = { ten: '  Việc A  ', pt: '75', la: 'độc' };
  Object.defineProperty(dong, '__proto__x', { value: 1, enumerable: true });
  const kq = kiemTraDuLieu(MAU, { b1: [{ nhom: 'Nhóm 1' }, { nhom: '   ' }, { o: {} }, { o: dong }] }, { nop: true });
  assert.equal(kq.ok, true, JSON.stringify(kq.loi));
  assert.deepEqual(kq.du_lieu.b1, [{ nhom: 'Nhóm 1' }, { o: { ten: 'Việc A', pt: 75 } }]);
});

test('dữ liệu bảng: lỗi chỉ rõ DÒNG và CỘT bị sai (đếm theo dòng dữ liệu, không đếm dòng nhóm)', () => {
  const kq = kiemTraDuLieu(MAU, { b1: [{ nhom: 'N' }, { o: { ten: 'A', pt: 50 } }, { o: { ten: 'B', pt: 150 } }] });
  assert.equal(kq.ok, false);
  assert.match(kq.loi.b1, /Dòng 2, cột "Mức độ \(%\)": Không được lớn hơn 100/);
});

test('dữ liệu bảng: bảng bắt buộc thì NỘP phải có ít nhất một dòng dữ liệu (chỉ tên nhóm không đủ); lưu nháp thì không đòi', () => {
  assert.equal(kiemTraDuLieu(MAU, {}, { nop: false }).ok, true);
  assert.equal(kiemTraDuLieu(MAU, {}, { nop: true }).ok, false);
  assert.equal(kiemTraDuLieu(MAU, { b1: [{ nhom: 'Chỉ nhóm' }] }, { nop: true }).ok, false);
  assert.equal(kiemTraDuLieu(MAU, { b1: [{ o: { ten: 'x' } }] }, { nop: true }).ok, true);
});

test('dữ liệu bảng: bảng không cho chia nhóm thì từ chối dòng nhóm; dữ liệu sai kiểu bị từ chối', () => {
  const khongNhom = chuanHoaMau([bangDef({ cho_phep_nhom: false })]).truong;
  assert.equal(kiemTraDuLieu(khongNhom, { b1: [{ nhom: 'N' }] }).ok, false);
  assert.equal(kiemTraDuLieu(MAU, { b1: 'không phải mảng' }).ok, false);
  assert.equal(kiemTraDuLieu(MAU, { b1: [123] }).ok, false);
  assert.equal(kiemTraDuLieu(MAU, { b1: [[1, 2]] }).ok, false);
  assert.equal(kiemTraDuLieu(MAU, { b1: [{ o: 'x' }] }).ok, false);
});

test('dữ liệu bảng: tối đa 100 dòng', () => {
  const nhieu = Array.from({ length: 101 }, (_, i) => ({ o: { ten: 'V' + i } }));
  assert.equal(kiemTraDuLieu(MAU, { b1: nhieu }).ok, false);
  assert.equal(kiemTraDuLieu(MAU, { b1: nhieu.slice(0, 100) }).ok, true);
});

test('ô tổng hợp KHÔNG được lưu: client gửi lên cũng bị bỏ (luôn tính lại từ bảng)', () => {
  const kq = kiemTraDuLieu(MAU, { b1: [{ o: { ten: 'x', pt: 100 } }], t1: { tong: 999 } });
  assert.equal('t1' in kq.du_lieu, false);
});

// ── Số liệu tổng hợp ─────────────────────────────────────────────────────────

test('tinhTongHop: ≥100 là hoàn thành, 1–99 đang thực hiện, 0 hoặc trống là chưa; bỏ qua dòng nhóm', () => {
  const du = { b1: [{ nhom: 'N' }, { o: { ten: 'a', pt: 100 } }, { o: { ten: 'b', pt: 100 } }, { o: { ten: 'c', pt: 60 } }, { o: { ten: 'd', pt: 0 } }, { o: { ten: 'e' } }] };
  const t = tinhTongHop(MAU, du, MAU[1]);
  assert.equal(t.tong, 5, 'dòng nhóm không tính là công việc');
  assert.equal(t.hoan_thanh, 2);
  assert.equal(t.dang_thuc_hien, 1);
  assert.equal(t.chua_thuc_hien, 2, 'dòng 0% và dòng chưa ghi % đều tính là chưa thực hiện');
  assert.deepEqual(t.ty_le, { hoan_thanh: 40, dang_thuc_hien: 20, chua_thuc_hien: 40 });
});

test('tinhTongHop: gộp nhiều bảng; không có dòng nào thì ra 0 chứ không NaN', () => {
  const hai = chuanHoaMau([bangDef({ key: 'b1' }), bangDef({ key: 'b2' }), tongHop(['b1', 'b2'])]).truong;
  const t = tinhTongHop(hai, { b1: [{ o: { ten: 'a', pt: 100 } }], b2: [{ o: { ten: 'b', pt: 10 } }] }, hai[2]);
  assert.equal(t.tong, 2);
  assert.equal(t.hoan_thanh, 1);
  assert.deepEqual(tinhTongHop(hai, {}, hai[2]).ty_le, { hoan_thanh: 0, dang_thuc_hien: 0, chua_thuc_hien: 0 });
});
