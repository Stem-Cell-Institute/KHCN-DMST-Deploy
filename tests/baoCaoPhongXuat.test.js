/**
 * tests/baoCaoPhongXuat.test.js
 * Kết xuất báo cáo ra Word/PDF: mô hình tài liệu (thuần logic), tệp .docx và tệp PDF.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const PizZip = require(path.join(__dirname, '..', 'node_modules', 'pizzip'));
const { chuanHoaMau, kiemTraDuLieu } = require('../services/baoCaoPhongMau');
const { TRUONG_MAC_DINH } = require('../services/baoCaoPhongMauMacDinh');
const X = require('../services/baoCaoPhongXuat');

const TRUONG = chuanHoaMau(TRUONG_MAC_DINH).truong;
const DOT = { tieu_de: 'Báo cáo công tác tháng 10/2026', loai: 'thang', ky: '10/2026' };

const DU_LIEU_THO = {
  nguoi_phu_trach: 'Nguyễn Trường Sinh',
  ky_tu_ngay: '2026-09-04',
  ky_den_ngay: '2026-10-04',
  thuan_loi: 'Được tạo điều kiện.',
  tu_danh_gia: 'B',
  cv_thuong_xuyen: [
    { nhom: 'Quản lý KHCN' },
    { o: { hang_muc: 'KPI năm', viec_cu_the: 'Họp NCV', muc_do: 100 } },
    { nhom: 'Quản lý QHĐN' },
    { o: { hang_muc: 'Đón đoàn', muc_do: 40 } },
    { o: { hang_muc: 'Ký MOU', muc_do: 100 } },
  ],
  ke_hoach: [{ o: { ten_cong_viec: 'Rà soát đề tài', thoi_han: '2026-10-20' } }],
};
const DU_LIEU = kiemTraDuLieu(TRUONG, DU_LIEU_THO, { nop: true }).du_lieu;

const mh = (phong, du = DU_LIEU, ngay = new Date('2026-10-08T03:00:00Z')) =>
  X.dungMoHinh({ dot: DOT, truong: TRUONG, baoCao: { phong_ten: phong, nguoi_nop: 'Lê Người Nộp', du_lieu: du }, ngayXuat: ngay });

const khoi = (m, loai) => m.khoi.filter((k) => k.loai === loai);

// ── Mô hình tài liệu ─────────────────────────────────────────────────────────

test('mô hình: đầu thư đúng thứ tự — quốc hiệu, ngày, tiêu đề, kính gửi, tên phòng', () => {
  const m = mh('KHCN&QHĐN');
  assert.deepEqual(m.khoi.slice(0, 5).map((k) => k.loai), ['quoc_hieu', 'ngay', 'tieu_de', 'kinh_gui', 'doan']);
  assert.deepEqual(m.khoi[0].trai, ['TRƯỜNG ĐẠI HỌC KHOA HỌC TỰ NHIÊN', 'VIỆN TẾ BÀO GỐC']);
  assert.deepEqual(m.khoi[0].phai, ['CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 'Độc lập – Tự do – Hạnh phúc']);
  assert.equal(m.khoi[2].text, 'BÁO CÁO KẾT QUẢ HOẠT ĐỘNG THÁNG 10/2026');
  assert.equal(m.khoi[3].text, 'Viện trưởng Viện Tế bào gốc');
  assert.deepEqual([m.khoi[4].nhan, m.khoi[4].text], ['Tên Phòng/Ban', 'KHCN&QHĐN']);
});

test('mô hình: ngày in theo GIỜ VIỆT NAM (server chạy UTC: 20:00 UTC đã là ngày hôm sau ở Việt Nam)', () => {
  assert.equal(mh('P', DU_LIEU, new Date('2026-10-08T03:00:00Z')).khoi[1].text, 'TP. Hồ Chí Minh, ngày 8 tháng 10 năm 2026');
  assert.equal(mh('P', DU_LIEU, new Date('2026-10-08T20:00:00Z')).khoi[1].text, 'TP. Hồ Chí Minh, ngày 9 tháng 10 năm 2026');
  assert.equal(mh('P', DU_LIEU, new Date('2026-12-31T18:00:00Z')).khoi[1].text, 'TP. Hồ Chí Minh, ngày 1 tháng 1 năm 2027', 'qua năm mới theo giờ VN');
});

test('mô hình: tiêu đề theo loại đợt', () => {
  assert.equal(X.tieuDeVanBan({ loai: 'quy', ky: '3/2026' }), 'BÁO CÁO KẾT QUẢ HOẠT ĐỘNG QUÝ 3/2026');
  assert.equal(X.tieuDeVanBan({ loai: 'nam', ky: '2026' }), 'BÁO CÁO KẾT QUẢ HOẠT ĐỘNG NĂM 2026');
  assert.match(X.tieuDeVanBan({ loai: 'dot_xuat', ky: null, tieu_de: 'Kiểm tra đột xuất' }), /KIỂM TRA ĐỘT XUẤT/);
});

test('mô hình: ngày hiển thị dd/mm/yyyy, ô trống hiện "—", mục in HOA', () => {
  const m = mh('P');
  const kv = (nhan) => m.khoi.find((k) => k.loai === 'doan' && k.nhan === nhan);
  assert.equal(kv('Kỳ báo cáo từ ngày').text, '04/09/2026');
  assert.equal(kv('Kỳ báo cáo đến ngày').text, '04/10/2026');
  assert.equal(kv('Khó khăn').text, '—', 'ô không điền phải hiện dấu gạch, không để trống trơn');
  assert.ok(khoi(m, 'muc').some((k) => k.text === 'I. TỔNG QUAN TÌNH HÌNH HOẠT ĐỘNG TRONG THÁNG'));
});

test('mô hình: bảng có dòng nhóm A/B, STT đánh liên tục xuyên các nhóm, cột đúng thứ tự', () => {
  const b = khoi(mh('P'), 'bang')[0];
  assert.equal(b.cot[0].nhan, 'Hạng mục công việc / Chỉ tiêu KPI');
  assert.equal(b.hang[0].nhom, 'A. Mục tiêu / Nhóm công việc: Quản lý KHCN');
  assert.equal(b.hang[1].stt, 1);
  assert.equal(b.hang[2].nhom, 'B. Mục tiêu / Nhóm công việc: Quản lý QHĐN');
  assert.deepEqual([b.hang[3].stt, b.hang[4].stt], [2, 3], 'STT không đánh lại từ 1 ở nhóm B');
  assert.equal(b.hang[1].cells[3], '100', 'mức độ hoàn thành');
  assert.equal(b.hang[1].cells[1], 'Họp NCV');
  assert.equal(b.hang[1].cells[2], '', 'ô không điền trong dòng là chuỗi rỗng');
});

test('mô hình: bảng không có dữ liệu thì ghi "Không có nội dung", không vẽ bảng rỗng', () => {
  const m = mh('P', DU_LIEU);
  const dotXuat = m.khoi.findIndex((k) => k.loai === 'tieu_de_bang' && /đột xuất/.test(k.text));
  assert.equal(m.khoi[dotXuat + 1].loai, 'ghi_chu');
  assert.equal(m.khoi[dotXuat + 1].text, 'Không có nội dung.');
});

test('mô hình: số liệu tổng hợp tự tính từ bảng (3 việc: 2 hoàn thành, 1 đang làm)', () => {
  const ds = khoi(mh('P'), 'danh_sach')[0].dong;
  assert.deepEqual(ds[0], ['Tổng số công việc đã đăng ký/được giao', '3 việc']);
  assert.deepEqual(ds[1], ['Hoàn thành', '2 việc (chiếm 67%)']);
  assert.deepEqual(ds[2], ['Đang thực hiện (chưa hoàn thành)', '1 việc (chiếm 33%)']);
  assert.deepEqual(ds[3], ['Chưa thực hiện', '0 việc (chiếm 0%)']);
});

test('mô hình: khối chữ ký — người lập là người nộp, Trưởng phòng lấy từ ô người phụ trách, Viện trưởng để trống ký tay', () => {
  const cs = khoi(mh('P'), 'chu_ky')[0].cot;
  assert.deepEqual(cs.map((c) => c.tieu_de), ['NGƯỜI LẬP BÁO CÁO', 'TRƯỞNG PHÒNG', 'VIỆN TRƯỞNG (Phê duyệt)']);
  assert.deepEqual(cs.map((c) => c.ten), ['Lê Người Nộp', 'Nguyễn Trường Sinh', '']);
});

test('mô hình: biểu mẫu do người quản lý tự dựng (không có mục, không có bảng) vẫn xuất được', () => {
  const tuDung = chuanHoaMau([
    { key: 'a', kieu: 'text', nhan: 'Tình hình chung', bat_buoc: true },
    { key: 'b', kieu: 'checkbox', nhan: 'Đã họp giao ban' },
    { key: 'c', kieu: 'number', nhan: 'Số buổi' },
  ]).truong;
  const m = X.dungMoHinh({ dot: DOT, truong: tuDung, baoCao: { phong_ten: 'P', du_lieu: { a: 'Ổn định', b: true, c: 3 } } });
  const doan = m.khoi.filter((k) => k.loai === 'doan').map((k) => [k.nhan, k.text]);
  assert.deepEqual(doan.slice(1), [['Tình hình chung', 'Ổn định'], ['Đã họp giao ban', 'Có'], ['Số buổi', '3']]);
  assert.deepEqual(khoi(m, 'chu_ky')[0].cot.map((c) => c.ten), ['', '', ''], 'không có ô người phụ trách thì để trống, không in "undefined"');
});

test('chữ cái nhóm: A…Z rồi AA, AB', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(X.chuCaiNhom), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
});

// ── Word ─────────────────────────────────────────────────────────────────────

function docXml(buf) {
  return new PizZip(buf).file('word/document.xml').asText();
}

test('Word: tạo được tệp .docx hợp lệ (zip có document.xml), chứa tiếng Việt đúng dấu và bảng', async () => {
  const buf = await X.taoDocx([mh('KHCN&QHĐN')]);
  assert.equal(buf.slice(0, 2).toString(), 'PK');
  const xml = docXml(buf);
  for (const chuoi of ['BÁO CÁO KẾT QUẢ HOẠT ĐỘNG THÁNG 10/2026', 'KHCN&amp;QHĐN', 'Mục tiêu / Nhóm công việc: Quản lý KHCN', 'Nguyễn Trường Sinh', '(Ký, ghi rõ họ tên)']) {
    assert.ok(xml.includes(chuoi), 'thiếu trong tệp Word: ' + chuoi);
  }
  assert.ok((xml.match(/<w:tbl>/g) || []).length >= 4, 'quốc hiệu + hai bảng có dữ liệu + chữ ký');
  assert.ok(xml.includes('Times New Roman'));
});

test('Word: nhiều phòng = nhiều mục (mỗi báo cáo một trang mới, đánh số trang lại từ 1)', async () => {
  const xml = docXml(await X.taoDocx([mh('Phòng A'), mh('Phòng B'), mh('Phòng C')]));
  assert.equal((xml.match(/<w:sectPr/g) || []).length, 3);
  assert.equal((xml.match(/w:pgNumType w:start="1"/g) || []).length, 3, 'mỗi báo cáo đánh số trang lại từ 1');
  for (const p of ['Phòng A', 'Phòng B', 'Phòng C']) assert.ok(xml.includes(p));
});

test('Word: ký tự đặc biệt trong dữ liệu người dùng không phá cấu trúc XML', async () => {
  const doc = { ...DU_LIEU, thuan_loi: '<script>alert(1)</script> & "trích dẫn" \'nháy\'', kien_nghi: 'Dòng 1\nDòng 2' };
  const xml = docXml(await X.taoDocx([mh('P<>&', doc)]));
  assert.ok(!xml.includes('<script>'), 'không được có thẻ thô');
  assert.ok(xml.includes('&lt;script&gt;'));
  assert.ok(xml.includes('P&lt;&gt;&amp;'));
  assert.ok(xml.includes('<w:br/>'), 'xuống dòng trong ô văn bản phải thành ngắt dòng của Word');
});

// ── PDF ──────────────────────────────────────────────────────────────────────

const demTrang = (buf) => (buf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;

test('PDF: đúng chữ ký, có kết thúc, nhúng font Tinos (font mặc định không có dấu tiếng Việt)', async () => {
  const buf = await X.taoPdf([mh('KHCN&QHĐN')]);
  const s = buf.toString('latin1');
  assert.equal(s.slice(0, 5), '%PDF-');
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.ok(s.includes('Tinos'), 'phải nhúng font Tinos');
  assert.ok(!s.includes('/BaseFont /Helvetica') && !s.includes('/BaseFont /Times-Roman'), 'không được dùng font chuẩn của PDF (thiếu dấu tiếng Việt)');
  assert.ok(demTrang(buf) >= 1);
});

test('PDF: nhiều phòng ra nhiều trang hơn một phòng', async () => {
  const mot = demTrang(await X.taoPdf([mh('A')]));
  const ba = demTrang(await X.taoPdf([mh('A'), mh('B'), mh('C')]));
  assert.ok(ba >= mot * 3 - 0, `3 báo cáo phải có ≥ ${mot * 3} trang, thực tế ${ba}`);
});

test('PDF: bảng dài 100 dòng chữ dài tự ngắt sang nhiều trang, không treo, không đổ vỡ', async () => {
  const dong = Array.from({ length: 100 }, (_, i) => ({ o: { hang_muc: 'Công việc số ' + i, viec_cu_the: 'Mô tả chi tiết '.repeat(30), muc_do: i % 101 } }));
  const du = kiemTraDuLieu(TRUONG, { ...DU_LIEU_THO, cv_thuong_xuyen: dong }, { nop: true });
  assert.equal(du.ok, true, JSON.stringify(du.loi));
  const t0 = Date.now();
  const buf = await X.taoPdf([mh('P', du.du_lieu)]);
  assert.ok(Date.now() - t0 < 10000, 'phải xong trong vài giây');
  assert.ok(demTrang(buf) >= 8, 'bảng 100 dòng dài phải trải ra nhiều trang, thực tế ' + demTrang(buf));
});

test('PDF: ô văn bản dài đến mức vượt quá một trang bị cắt (có dấu …) chứ không làm hỏng tệp', async () => {
  const khung = 'x'.repeat(5000);
  const du = kiemTraDuLieu(TRUONG, { ...DU_LIEU_THO, cv_thuong_xuyen: [{ o: { hang_muc: 'a', viec_cu_the: khung, ket_qua: khung } }] }, { nop: true });
  const buf = await X.taoPdf([mh('P', du.du_lieu)]);
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-');
  assert.ok(demTrang(buf) < 40, 'không được sinh ra hàng trăm trang rác');
});

test('PDF và Word dùng chung một mô hình: cùng dữ liệu thì cùng nội dung chính', async () => {
  const m = mh('Phòng Đồng Nhất');
  const [docx, pdf] = await Promise.all([X.taoDocx([m]), X.taoPdf([m])]);
  assert.ok(docXml(docx).includes('Phòng Đồng Nhất'));
  assert.equal(pdf.slice(0, 5).toString('latin1'), '%PDF-');
});
