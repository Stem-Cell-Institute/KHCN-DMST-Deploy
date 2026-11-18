'use strict';

// Hồ sơ dòng tế bào, lô (stock), QC (chỉ thêm), tệp đính kèm an toàn và báo cáo GMO / an toàn sinh học (ngân hàng tế bào).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dungServer } = require('./helpers/nganHangServer');
const DT = require('../services/nganHangTeBaoKhangTheDongTeBao');

let s;
let kho;
const KT = 'khang_the';
const hopLe = { ma: 'HEK293', ten: 'HEK293T', loai_sinh_vat: 'Người', mo_nguon_goc: 'Thận phôi', dang_nuoi: 'bam_dinh', moi_truong: 'DMEM', bo_sung: 'FBS 10%', nhiet_do_c: 37, co2_phan_tram: 5 };
const homNay = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
const lui = (ngay) => new Date(Date.now() + 7 * 3600000 - ngay * 86400000).toISOString().slice(0, 10);

/** Gửi tệp multipart bằng FormData chuẩn của Node. */
async function guiTep(user, { noiDung, ten, doiTuong = 'dong', doiTuongId, moTa, nganHang }) {
  const f = new FormData();
  f.append('doi_tuong', doiTuong);
  f.append('doi_tuong_id', String(doiTuongId));
  if (moTa) f.append('mo_ta', moTa);
  f.append('tep', new Blob([noiDung]), ten);
  const res = await fetch(s.base + '/attachments', { method: 'POST', headers: { 'x-test-user': user, ...(nganHang ? { 'x-ngan-hang': nganHang } : {}) }, body: f });
  let json = null;
  try { json = await res.json(); } catch (_) { /* không phải JSON */ }
  return { status: res.status, json };
}
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('nội dung giả lập\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

test.before(async () => {
  s = await dungServer();
  kho = await s.taoKho();
});
test.after(() => s.dong());

test('hàm thuần: nhận dạng tệp theo nội dung, tên tệp sạch, CSV chống công thức', () => {
  assert.equal(DT.nhanDangTep(PDF, 'a.pdf'), 'pdf');
  assert.equal(DT.nhanDangTep(PNG, 'anh.PNG'), 'png');
  assert.equal(DT.nhanDangTep(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'a.jpeg'), 'jpg');
  assert.equal(DT.nhanDangTep(Buffer.from('MZ\x90\x00'), 'a.pdf'), null, 'nội dung không phải PDF');
  assert.equal(DT.nhanDangTep(PDF, 'a.exe'), null);
  assert.equal(DT.nhanDangTep(PDF, 'a.html'), null);
  assert.equal(DT.nhanDangTep(PDF, 'khong-duoi'), null);
  assert.equal(DT.nhanDangTep(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]), 'b.xlsx'), 'xlsx');
  assert.equal(DT.nhanDangTep(Buffer.from('a,b\n1,2\n'), 'b.csv'), 'csv');
  assert.equal(DT.nhanDangTep(Buffer.from([0x61, 0x00, 0x62]), 'b.txt'), null, 'có byte rỗng');
  assert.equal(DT.nhanDangTep(Buffer.alloc(0), 'a.pdf'), null);
  assert.equal(DT.lamSachTen('..\\..\\etc/passwd'), 'passwd');
  assert.equal(DT.lamSachTen('a"b<c>.pdf'), 'a_b_c_.pdf');
  assert.equal(DT.oCsv('=1+1'), "'=1+1");
  assert.equal(DT.oCsv('@x'), "'@x");
  assert.equal(DT.oCsv('a,"b"'), '"a,""b"""');
  assert.ok(DT.taoCsv([{ a: 'Tế bào' }], [['a', 'Tên']]).startsWith('﻿Tên\r\n'));
});

test('hồ sơ dòng tế bào: tạo, kiểm tra dữ liệu, trùng mã, chỉ dùng ở ngân hàng tế bào', async () => {
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ten: 'Thiếu mã' })).status, 400);
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ma: 'X1' })).status, 400, 'thiếu tên');
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ...hopLe, dang_nuoi: 'xyz' })).status, 400);
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ...hopLe, nhiet_do_c: 500 })).status, 400);
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ...hopLe, ma: '<script>' })).status, 400, 'mã có ký tự lạ');
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ...hopLe, bien_doi_gen: true })).status, 400, 'GMO phải mô tả biến đổi');
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ...hopLe, bien_doi_gen: true, gmo_mo_ta: 'Lentivirus GFP' })).status, 400, 'GMO phải có BSL');
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ...hopLe, bien_doi_gen: true, gmo_mo_ta: 'x', bsl: 9 })).status, 400);
  const r = await s.api('alice', 'POST', '/cell-lines', hopLe);
  assert.equal(r.status, 201);
  assert.equal((await s.api('bob', 'POST', '/cell-lines', { ...hopLe, ma: 'hek293' })).status, 409, 'trùng mã không phân biệt hoa thường');
  assert.equal((await s.api('alice', 'POST', '/cell-lines', hopLe, KT)).status, 400, 'ngân hàng kháng thể không có hồ sơ dòng');
  assert.equal((await s.api('alice', 'GET', '/cell-lines', null, KT)).status, 400);
  const d = (await s.api('bob', 'GET', `/cell-lines/${r.json.id}`)).json;
  assert.equal(d.dong.ma, 'HEK293');
  assert.equal(d.dong.quyen_sua, false);
  assert.equal(d.dong.tao_boi_ten, 'alice@sci.edu.vn');
  assert.deepEqual([d.lo, d.qc, d.tep, d.ong], [[], [], [], []]);
  assert.equal(d.mycoplasma.co, false);
  assert.equal((await s.api('bob', 'GET', '/cell-lines/99999')).status, 404);
  // tìm kiếm: bỏ dấu, nhiều từ, lọc GMO
  const g = await s.api('manager', 'POST', '/cell-lines', { ma: 'HELA-GFP', ten: 'HeLa GFP', loai_sinh_vat: 'Người', mo_nguon_goc: 'Cổ tử cung', bien_doi_gen: true, gmo_mo_ta: 'Lentivirus mang GFP', bsl: 2 });
  assert.equal(g.status, 201);
  const tim = async (q) => (await s.api('bob', 'GET', `/cell-lines?q=${encodeURIComponent(q)}`)).json.cell_lines.map((x) => x.ma);
  assert.deepEqual(await tim('co tu cung'), ['HELA-GFP']);
  assert.deepEqual((await tim('hek xyz')).length, 0, 'mỗi từ khóa phải khớp một phần dữ liệu');
  assert.deepEqual(await tim('hek 293'), ['HEK293'], 'nhiều từ khóa khớp ở các phần khác nhau vẫn khớp');
  assert.deepEqual(await tim('hek'), ['HEK293']);
  assert.deepEqual((await s.api('bob', 'GET', '/cell-lines?gmo=1')).json.cell_lines.map((x) => x.ma), ['HELA-GFP']);
});

test('sửa / xóa hồ sơ: người tạo hoặc quản lý; ràng buộc GMO tính trên bản gộp; xóa chỉ khi hết ống', async () => {
  const id = (await s.api('alice', 'POST', '/cell-lines', { ...hopLe, ma: 'CHO-K1', ten: 'CHO-K1' })).json.id;
  assert.equal((await s.api('bob', 'PATCH', `/cell-lines/${id}`, { ghi_chu: 'x' })).status, 403);
  assert.equal((await s.api('bob', 'DELETE', `/cell-lines/${id}`)).status, 403);
  assert.equal((await s.api('alice', 'PATCH', `/cell-lines/${id}`, {})).json.changed, 0);
  assert.equal((await s.api('alice', 'PATCH', `/cell-lines/${id}`, { ghi_chu: 'Nuôi ở phòng 3' })).json.changed, 1);
  assert.equal((await s.api('alice', 'PATCH', `/cell-lines/${id}`, { bien_doi_gen: true })).status, 400, 'bật GMO mà chưa mô tả');
  assert.equal((await s.api('alice', 'PATCH', `/cell-lines/${id}`, { bien_doi_gen: true, gmo_mo_ta: 'CRISPR knock-out gen X', bsl: 2 })).status, 200);
  assert.equal((await s.api('alice', 'PATCH', `/cell-lines/${id}`, { bsl: null })).status, 400, 'đang là GMO thì không bỏ BSL');
  assert.equal((await s.api('manager', 'PATCH', `/cell-lines/${id}`, { ma: 'hek293' })).status, 409, 'đổi sang mã đã có');
  assert.equal((await s.api('manager', 'PATCH', `/cell-lines/${id}`, { ten: 'CHO-K1 (đổi tên)' })).status, 200, 'quản lý sửa được');
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_cell_line_update'));
  // ống đang giữ thì không xóa được
  const lo = (await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'LO-01', passage: 'P5' })).json.id;
  const ong = await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 1, col_no: 1, name: 'CHO ống 1', chu_loai: 'can_bo', lo_id: lo });
  assert.equal(ong.status, 201);
  assert.equal((await s.api('alice', 'DELETE', `/cell-lines/${id}`)).status, 409);
  assert.equal((await s.api('alice', 'DELETE', `/lots/${lo}`)).status, 409);
  assert.equal((await s.api('alice', 'POST', `/tubes/${ong.json.id}/discard`, { note: 'hết hạn' })).status, 200);
  assert.equal((await s.api('alice', 'DELETE', `/lots/${lo}`)).status, 200);
  assert.equal((await s.api('alice', 'DELETE', `/cell-lines/${id}`)).status, 200);
  assert.equal((await s.api('alice', 'GET', `/cell-lines/${id}`)).status, 404);
  assert.equal((await s.api('alice', 'POST', '/cell-lines', { ...hopLe, ma: 'CHO-K1', ten: 'Dùng lại mã sau khi xóa' })).status, 201, 'mã được dùng lại sau khi xóa');
});

test('lô (stock) và ống: gắn ống vào lô, hiện ở hộp / tìm kiếm / chi tiết dòng, ghi lịch sử; kiểm tra dữ liệu', async () => {
  const id = (await s.api('alice', 'POST', '/cell-lines', { ...hopLe, ma: 'JURKAT', ten: 'Jurkat' })).json.id;
  assert.equal((await s.api('bob', 'POST', `/cell-lines/${id}/lots`, { ma: 'L1' })).status, 403);
  assert.equal((await s.api('alice', 'POST', `/cell-lines/${id}/lots`, {})).status, 400, 'thiếu mã lô');
  assert.equal((await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'L1', ty_le_song_sot: 120 })).status, 400);
  assert.equal((await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'L1', ngay_dong_lanh: '31/02/2026' })).status, 400);
  const l1 = (await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'L1', passage: 'P4', ngay_dong_lanh: '2026-09-01', so_te_bao_moi_ong: 1000000, ty_le_song_sot: 92.5, moi_truong_dong: 'FBS + 10% DMSO' })).json.id;
  assert.equal((await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'l1' })).status, 409, 'trùng mã lô');
  const l2 = (await s.api('manager', 'POST', `/cell-lines/${id}/lots`, { ma: 'L2', passage: 'P6' })).json.id;
  assert.equal((await s.api('alice', 'PATCH', `/lots/${l2}`, { passage: 'P7' })).json.changed, 1);
  assert.equal((await s.api('bob', 'PATCH', `/lots/${l2}`, { passage: 'P9' })).status, 403);
  // gắn ống
  assert.equal((await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 2, col_no: 1, name: 'x', chu_loai: 'can_bo', lo_id: 99999 })).status, 400, 'lô không có');
  const ong = (await s.api('alice', 'POST', '/tubes', { box_id: kho.box, row_no: 2, col_no: 1, name: 'Jurkat P4', chu_loai: 'can_bo', lo_id: l1 })).json.id;
  const lo = await s.api('alice', 'POST', '/tubes/bulk', { box_id: kho.box, row_no: 3, col_no: 1, count: 3, name: 'Jurkat P7', chu_loai: 'can_bo', lo_id: l2 });
  assert.equal(lo.status, 201);
  const tren = (await s.api('bob', 'GET', `/boxes/${kho.box}`)).json.tubes.find((t) => t.id === ong);
  assert.deepEqual([tren.lo_ma, tren.dong_ten, tren.dong_id], ['L1', 'Jurkat', id]);
  const tk = (await s.api('bob', 'GET', '/tubes/search?q=Jurkat&status=all')).json.items.find((t) => t.id === ong);
  assert.deepEqual([tk.lo_ma, tk.dong_ten], ['L1', 'Jurkat']);
  const d = (await s.api('bob', 'GET', `/cell-lines/${id}`)).json;
  assert.equal(d.ong.length, 4);
  assert.deepEqual(d.lo.map((x) => [x.ma, x.so_ong]).sort(), [['L1', 1], ['L2', 3]]);
  assert.ok(d.ong[0].vi_tri.includes('Tủ test'));
  assert.equal((await s.api('bob', 'GET', '/cell-lines')).json.cell_lines.find((x) => x.id === id).so_ong, 4);
  // đổi lô của ống: ghi lịch sử mẫu
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${ong}`, { lo_id: l2 })).status, 200);
  const ls = (await s.api('alice', 'GET', `/tubes/${ong}/history`)).json.history.find((x) => x.action === 'edit' && /lo_id/.test(x.note));
  assert.match(ls.note, /JURKAT \/ L2/);
  assert.equal((await s.api('alice', 'PATCH', `/tubes/${ong}`, { lo_id: null })).status, 200);
  // ống kháng thể không gắn lô
  const tb = (await s.api('manager', 'POST', '/containers', { name: 'Tủ KT', type_id: kho.type }, KT)).json.id;
  const hop = (await s.api('manager', 'POST', '/boxes', { container_id: tb, template_id: kho.tpl99 }, KT)).json.ids[0];
  assert.equal((await s.api('manager', 'POST', '/tubes', { box_id: hop, row_no: 1, col_no: 1, name: 'KT', the_tich_ul: 10, lo_id: l1 }, KT)).status, 400);
});

test('QC: chỉ thêm, kiểm tra dữ liệu, trạng thái mycoplasma và quá hạn thử', async () => {
  const id = (await s.api('alice', 'POST', '/cell-lines', { ...hopLe, ma: 'QC-1', ten: 'Dòng QC' })).json.id;
  const lo = (await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'L1' })).json.id;
  const qc = (body) => s.api('alice', 'POST', `/cell-lines/${id}/qc`, body);
  assert.equal((await qc({ loai: 'xyz', ket_qua: 'dat', ngay: homNay() })).status, 400);
  assert.equal((await qc({ loai: 'str', ket_qua: 'xyz', ngay: homNay() })).status, 400);
  assert.equal((await qc({ loai: 'str', ket_qua: 'dat' })).status, 400, 'thiếu ngày');
  assert.equal((await qc({ loai: 'str', ket_qua: 'dat', ngay: '2999-01-01' })).status, 400, 'ngày tương lai');
  assert.equal((await qc({ loai: 'mycoplasma', ket_qua: 'dat', ngay: homNay() })).status, 400, 'mycoplasma là âm / dương tính');
  assert.equal((await qc({ loai: 'str', ket_qua: 'dat', ngay: homNay(), lo_id: 99999 })).status, 400);
  assert.equal((await s.api('bob', 'POST', `/cell-lines/${id}/qc`, { loai: 'str', ket_qua: 'dat', ngay: homNay() })).status, 403);
  assert.equal((await qc({ loai: 'mycoplasma', ket_qua: 'am_tinh', ngay: lui(200), phuong_phap: 'PCR' })).status, 201);
  let d = (await s.api('bob', 'GET', `/cell-lines/${id}`)).json;
  assert.deepEqual([d.mycoplasma.co, d.mycoplasma.ket_qua, d.mycoplasma.qua_han], [true, 'am_tinh', true], '200 ngày trước: quá hạn thử');
  const moi = await qc({ loai: 'mycoplasma', ket_qua: 'duong_tinh', ngay: lui(2), lo_id: lo, ghi_chu: 'Nhiễm, cách ly' });
  assert.equal(moi.status, 201);
  d = (await s.api('bob', 'GET', `/cell-lines/${id}`)).json;
  assert.deepEqual([d.mycoplasma.ket_qua, d.mycoplasma.qua_han], ['duong_tinh', false], 'lần gần nhất được tính');
  assert.deepEqual(d.qc.map((x) => [x.loai, x.ket_qua, x.lo_ma]), [['mycoplasma', 'duong_tinh', 'L1'], ['mycoplasma', 'am_tinh', null]]);
  assert.equal(d.qc[0].user_label, 'alice@sci.edu.vn');
  assert.throws(() => s.db.prepare('UPDATE nhm_qc SET ket_qua = ? WHERE dong_id = ?').run('dat', id), /chỉ được thêm/);
  assert.throws(() => s.db.prepare('DELETE FROM nhm_qc WHERE dong_id = ?').run(id), /chỉ được thêm/);
});

test('tệp đính kèm: chỉ loại an toàn theo NỘI DUNG, giới hạn kích thước và số lượng, tải về an toàn, xóa mềm, quyền', async () => {
  const id = (await s.api('alice', 'POST', '/cell-lines', { ...hopLe, ma: 'TEP-1', ten: 'Dòng có tệp' })).json.id;
  const lo = (await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'L1' })).json.id;
  const qc = (await s.api('alice', 'POST', `/cell-lines/${id}/qc`, { loai: 'str', ket_qua: 'dat', ngay: homNay() })).json.id;
  assert.equal((await guiTep('alice', { noiDung: PDF, ten: 'a.pdf', doiTuong: 'xyz', doiTuongId: id })).status, 400);
  assert.equal((await guiTep('alice', { noiDung: PDF, ten: 'a.pdf', doiTuongId: 99999 })).status, 404);
  assert.equal((await guiTep('bob', { noiDung: PDF, ten: 'a.pdf', doiTuongId: id })).status, 403, 'người lạ không đính kèm');
  assert.equal((await guiTep('alice', { noiDung: Buffer.from('MZ giả'), ten: 'virus.pdf', doiTuongId: id })).status, 400, 'nội dung không phải PDF');
  assert.equal((await guiTep('alice', { noiDung: PDF, ten: 'chay.exe', doiTuongId: id })).status, 400);
  assert.equal((await guiTep('alice', { noiDung: Buffer.from('<script>alert(1)</script>'), ten: 'x.html', doiTuongId: id })).status, 400);
  assert.equal((await guiTep('alice', { noiDung: PDF, ten: 'a.pdf', doiTuongId: id, nganHang: KT })).status, 400, 'ngân hàng kháng thể không dùng');
  const lon = await guiTep('alice', { noiDung: Buffer.concat([PDF, Buffer.alloc(DT.TOI_DA_TEP)]), ten: 'lon.pdf', doiTuongId: id });
  assert.equal(lon.status, 400);
  assert.match(lon.json.message, /quá lớn/);
  // tải lên: tên tiếng Việt giữ nguyên, tên có đường dẫn bị làm sạch, tệp nằm dưới thư mục tạm với tên ngẫu nhiên
  const a = await guiTep('alice', { noiDung: PDF, ten: 'Phiếu dữ liệu HEK293.pdf', doiTuongId: id, moTa: 'Datasheet ATCC' });
  assert.equal(a.status, 201);
  assert.equal(a.json.ten_goc, 'Phiếu dữ liệu HEK293.pdf');
  const hinh = await guiTep('manager', { noiDung: PNG, ten: '..\\..\\hinh-thai.png', doiTuong: 'lo', doiTuongId: lo });
  assert.equal(hinh.status, 201, 'quản lý đính kèm được');
  assert.equal(hinh.json.ten_goc, 'hinh-thai.png');
  const kq = await guiTep('alice', { noiDung: PDF, ten: 'str.pdf', doiTuong: 'qc', doiTuongId: qc });
  assert.equal(kq.status, 201);
  const hang = db3(s.db, a.json.id);
  assert.match(hang.khoa, /^\d{4}\/[0-9a-f]{32}$/);
  assert.ok(fs.existsSync(path.join(s.thuMucTep, 'ngan-hang', ...hang.khoa.split('/'))));
  assert.equal(hang.mime, 'application/pdf');
  assert.equal(hang.sha256.length, 64);
  // chi tiết dòng liệt kê tệp của dòng, lô, QC
  const d = (await s.api('bob', 'GET', `/cell-lines/${id}`)).json;
  assert.deepEqual(d.tep.map((t) => [t.doi_tuong, t.ten_goc, t.anh]).sort(), [['dong', 'Phiếu dữ liệu HEK293.pdf', false], ['lo', 'hinh-thai.png', true], ['qc', 'str.pdf', false]]);
  // tải về: ai có tài khoản module tải được; PDF ép tải về, ảnh hiện trực tiếp; luôn nosniff + CSP chặn chạy mã
  const tai = await fetch(`${s.base}/attachments/${a.json.id}/download`, { headers: { 'x-test-user': 'bob' } });
  assert.equal(tai.status, 200);
  assert.equal(tai.headers.get('content-type'), 'application/pdf');
  assert.match(tai.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''Phi%E1%BA%BFu/);
  assert.equal(tai.headers.get('x-content-type-options'), 'nosniff');
  assert.match(tai.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await tai.arrayBuffer()), PDF);
  const anh = await fetch(`${s.base}/attachments/${hinh.json.id}/download`, { headers: { 'x-test-user': 'bob' } });
  assert.match(anh.headers.get('content-disposition'), /^inline;/);
  assert.equal((await fetch(`${s.base}/attachments/${a.json.id}/download`)).status, 401);
  assert.equal((await fetch(`${s.base}/attachments/99999/download`, { headers: { 'x-test-user': 'bob' } })).status, 404);
  // khóa hỏng trong CSDL không đi vòng ra ngoài thư mục
  s.db.prepare("UPDATE nhm_tep SET khoa = '../../../etc/passwd' WHERE id = ?").run(kq.json.id);
  assert.equal((await fetch(`${s.base}/attachments/${kq.json.id}/download`, { headers: { 'x-test-user': 'bob' } })).status, 404);
  // xóa: người lạ không xóa được; người tạo dòng xóa thì tệp biến mất khỏi danh sách và không tải được, dòng ghi vẫn còn
  assert.equal((await s.api('bob', 'DELETE', `/attachments/${a.json.id}`)).status, 403);
  assert.equal((await s.api('alice', 'DELETE', `/attachments/${a.json.id}`)).status, 200);
  assert.equal((await fetch(`${s.base}/attachments/${a.json.id}/download`, { headers: { 'x-test-user': 'bob' } })).status, 404);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM nhm_tep WHERE id = ? AND xoa_luc IS NOT NULL').get(a.json.id).c, 1);
  assert.ok((await s.api('bob', 'GET', `/cell-lines/${id}`)).json.tep.every((t) => t.id !== a.json.id));
});

test('tệp đính kèm: tối đa 20 tệp mỗi mục', async () => {
  const id = (await s.api('alice', 'POST', '/cell-lines', { ...hopLe, ma: 'TEP-2', ten: 'Nhiều tệp' })).json.id;
  for (let i = 0; i < DT.TOI_DA_TEP_MOI_DOI_TUONG; i++) assert.equal((await guiTep('alice', { noiDung: PDF, ten: `t${i}.pdf`, doiTuongId: id })).status, 201);
  assert.equal((await guiTep('alice', { noiDung: PDF, ten: 'them.pdf', doiTuongId: id })).status, 409);
});

const db3 = (db, id) => db.prepare('SELECT * FROM nhm_tep WHERE id = ?').get(id);

test('báo cáo GMO / an toàn sinh học: chỉ quản lý và Viện trưởng; số liệu, lọc BSL, CSV chống công thức, bản in thoát mã', async () => {
  // hồ sơ GMO có ống, QC và vị trí
  const id = (await s.api('alice', 'POST', '/cell-lines', { ma: 'RP-1', ten: '=HYPERLINK("http://x")', loai_sinh_vat: 'Chuột', bien_doi_gen: true, gmo_mo_ta: 'Knock-in <script>alert(1)</script>', bsl: 3, nguon_cung_cap: 'Phòng Lab A, "ATCC"', du_an: 'DA-01' })).json.id;
  const lo = (await s.api('alice', 'POST', `/cell-lines/${id}/lots`, { ma: 'L1' })).json.id;
  assert.equal((await s.api('alice', 'POST', '/tubes/bulk', { box_id: kho.box2, row_no: 1, col_no: 1, count: 2, name: 'RP ống', chu_loai: 'can_bo', lo_id: lo })).status, 201);
  assert.equal((await s.api('alice', 'POST', `/cell-lines/${id}/qc`, { loai: 'mycoplasma', ket_qua: 'am_tinh', ngay: lui(10) })).status, 201);
  for (const u of ['alice', 'bob']) {
    assert.equal((await s.api(u, 'GET', '/reports/gmo')).status, 403, `${u} không xem được báo cáo`);
    assert.equal((await s.api(u, 'GET', '/reports/gmo.csv')).status, 403);
    assert.equal((await s.api(u, 'GET', '/reports/gmo/print')).status, 403);
  }
  assert.equal((await s.api('manager', 'GET', '/reports/gmo', null, KT)).status, 400, 'chỉ ngân hàng tế bào');
  const bc = (await s.api('manager', 'GET', '/reports/gmo')).json;
  assert.ok(bc.dong.length >= 2);
  const r = bc.dong.find((x) => x.ma === 'RP-1');
  assert.deepEqual([r.bsl, r.bsl_ten, r.so_lo, r.so_ong, r.nguoi_tao], [3, 'BSL-3', 1, 2, 'alice@sci.edu.vn']);
  assert.match(r.vi_tri, /Tủ test/);
  assert.match(r.mycoplasma, /Âm tính/);
  assert.equal(bc.tong.theo_bsl[3], 1);
  assert.ok(bc.tong.so_ong >= 2);
  assert.ok(bc.dong.every((x) => x.ma !== 'HEK293'), 'dòng không biến đổi gen không có trong báo cáo');
  assert.deepEqual((await s.api('manager', 'GET', '/reports/gmo?bsl=3')).json.dong.map((x) => x.ma), ['RP-1']);
  assert.equal((await s.api('manager', 'GET', '/reports/gmo?bsl=1')).json.dong.length, 0);
  // Viện trưởng xem được
  assert.equal((await s.api('admin', 'POST', '/roles', { user_id: 6, vai_tro: 'vien_truong' })).status, 201);
  assert.equal((await s.api('truong', 'GET', '/reports/gmo')).status, 200);
  // CSV: BOM, tiêu đề, ô bắt đầu bằng = bị thêm dấu nháy, dấu phẩy và nháy kép được bọc
  const csv = await s.api('manager', 'GET', '/reports/gmo.csv?bsl=3');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /bao-cao-gmo-\d{8}\.csv/);
  assert.ok(csv.text.startsWith('﻿Mã dòng,Tên dòng,Loài,An toàn sinh học'));
  assert.ok(csv.text.includes('\'=HYPERLINK(""http://x"")'), 'công thức bị vô hiệu hóa');
  assert.ok(csv.text.includes('"Phòng Lab A, ""ATCC"""'));
  // bản in: escape mọi chữ người dùng gõ
  const html = (await s.api('manager', 'GET', '/reports/gmo/print')).text;
  assert.match(html, /BÁO CÁO DÒNG TẾ BÀO BIẾN ĐỔI GEN/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(s.auditLog.some((a) => a.action === 'nhm_report_gmo_csv'));
});
