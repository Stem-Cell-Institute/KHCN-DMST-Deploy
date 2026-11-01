'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — danh sách sinh viên của Viện do Trung tâm quản lý người học cung cấp (bảng nhm_sinh_vien).
 *
 * Mục đích: người ngoài Viện không thể giả làm sinh viên để vào module. Sinh viên không có email @sci.edu.vn nên:
 *   1. Quản lý module nhập danh sách (email, họ tên, hạn dùng) theo từng đợt — dán, hoặc nạp file Excel / CSV.
 *   2. Với mỗi email, hệ thống TẠO SẴN một tài khoản vai trò `sinh_vien` CHƯA kích hoạt (mật khẩu rỗng).
 *   3. Sinh viên vào trang Đăng ký chính, nhập đúng email đó → nhận thư xác minh tới CHÍNH hộp thư → đặt mật khẩu
 *      → kích hoạt tài khoản (luồng sẵn có của services/xacMinhEmail.js). Không có xác minh hộp thư thì không có tài khoản.
 *   4. Đến hạn (`het_han`), quyền vào module này bị khóa (tài khoản vẫn dùng được Đặt lịch thiết bị).
 *
 * Đọc bảng: cột được nhận theo TÊN TIÊU ĐỀ (không phụ thuộc thứ tự cột) nên file của Trung tâm khớp được ngay nếu tiêu đề gần giống;
 * khác nhiều thì chỉ cần thêm một cách gọi vào CAC_COT. Không có dòng tiêu đề thì dùng thứ tự: email, họ tên, mã SV, khóa / đợt, hạn.
 *
 * Danh sách chỉ chứa dữ liệu cần thiết, chỉ Admin / quản lý module xem, và dòng đã hết hạn lâu thì bị xóa (HAN_GIU_NGAY).
 */

const HAN_GIU_NGAY = 365; // dòng hết hạn / đã thu hồi được giữ thêm chừng này ngày rồi xóa
const TOI_DA_DONG = 2000;
const TOI_DA_BYTE = 2 * 1024 * 1024;

/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD): hạn dùng tính hết NGÀY ghi trên danh sách. */
function homNay(ms = Date.now()) {
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function chuanHoaEmail(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

/** Bỏ dấu, viết thường, gộp khoảng trắng và ký tự lạ (dùng so tên cột). */
function khoaCot(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Cách gọi tên mỗi cột (đã bỏ dấu, viết thường). Thêm cách gọi mới ở đây khi mẫu của Trung tâm dùng tên khác.
const CAC_COT = {
  email: ['email', 'e mail', 'mail', 'dia chi email', 'email sinh vien', 'email ca nhan', 'email lien he', 'gmail'],
  hoTen: ['ho ten', 'ho va ten', 'ho ten sinh vien', 'ten sinh vien', 'sinh vien', 'full name', 'fullname', 'name'],
  hoDem: ['ho dem', 'ho va ten dem', 'ho lot', 'ho va ten lot'],
  ten: ['ten'],
  maSv: ['ma sv', 'mssv', 'ma sinh vien', 'ma so sinh vien', 'ma so sv', 'ma hoc vien', 'student id'],
  khoa: ['khoa', 'dot', 'khoa dot', 'khoa hoc', 'nien khoa', 'dot nhan', 'dot tuyen', 'lop'],
  han: ['han dung', 'han', 'het han', 'ngay het han', 'ngay ra truong', 'du kien ra truong', 'ngay du kien ra truong', 'han su dung', 'han den'],
};

/** Ngày hợp lệ từ YYYY-MM-DD hoặc DD/MM/YYYY hoặc DD-MM-YYYY -> YYYY-MM-DD, hoặc null. */
function chuanHoaNgay(s) {
  const t = String(s == null ? '' : s).trim();
  let y;
  let m;
  let d;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t))) [, d, m, y] = r;
  else return null;
  const dt = new Date(Date.UTC(+y, +m - 1, +d));
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Dòng danh sách còn hiệu lực: chưa thu hồi, chưa quá hạn. */
function conHieuLuc(entry, ms = Date.now()) {
  return !!entry && entry.trang_thai !== 'da_xoa' && String(entry.het_han) >= homNay(ms);
}

function timTheoEmail(db, email) {
  return db.prepare('SELECT * FROM nhm_sinh_vien WHERE email = ?').get(chuanHoaEmail(email));
}

/** Email này được phép đăng ký tài khoản sinh viên? (có trong danh sách, còn hạn) */
function emailDuocDangKy(db, email) {
  try {
    return conHieuLuc(timTheoEmail(db, email));
  } catch (e) {
    return false; // bảng chưa có: chưa ai được phép
  }
}

// ── đọc bảng ──

/** Ô của exceljs / SheetJS / CSV → giá trị đơn giản (chuỗi, số, Date). */
function giaTriO(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join('');
    if (v.result !== undefined) return giaTriO(v.result); // công thức
    if (v.text != null) return String(v.text); // liên kết (mailto:)
    if (v.hyperlink) return String(v.hyperlink).replace(/^mailto:/i, '');
    return '';
  }
  return v;
}

/** Hạn dùng từ ô: ngày Excel (Date / số serial) hoặc chuỗi. */
function ngayTuO(v) {
  const x = giaTriO(v);
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
  if (typeof x === 'number') {
    if (x < 20000 || x > 2958465) return null; // ngoài khoảng số serial ngày của Excel (1954 … 9999)
    return new Date(Date.UTC(1899, 11, 30) + Math.round(x) * 86400000).toISOString().slice(0, 10);
  }
  return chuanHoaNgay(x);
}

const chuoiO = (v) => {
  const x = giaTriO(v);
  return x instanceof Date ? x.toISOString().slice(0, 10) : String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
};

/** Tìm dòng tiêu đề trong 10 dòng đầu và ánh xạ cột. Trả null nếu không thấy cột email. */
function timTieuDe(bang) {
  for (let i = 0; i < Math.min(bang.length, 10); i++) {
    const khoa = (bang[i] || []).map((c) => khoaCot(chuoiO(c)));
    const cot = {};
    for (const [ten, cach] of Object.entries(CAC_COT)) {
      const j = khoa.findIndex((k, idx) => k && cach.includes(k) && !Object.values(cot).includes(idx));
      if (j >= 0) cot[ten] = j;
    }
    if (cot.email == null) continue;
    // «Họ đệm» + «Tên» tách riêng thì ghép lại; không thì cột «họ tên»
    if (cot.hoDem != null && cot.ten != null) delete cot.hoTen;
    else delete cot.ten;
    if (cot.hoTen == null && !(cot.hoDem != null && cot.ten != null)) continue;
    return { dong: i, cot };
  }
  return null;
}

/**
 * Bảng (mảng các dòng, mỗi dòng là mảng ô) → danh sách sinh viên + lỗi từng dòng.
 * @returns {{rows: object[], loi: {dong:number,message:string}[], coTieuDe: boolean}}
 */
function docBang(bang, hanMacDinh) {
  const rows = [];
  const loi = [];
  const th = timTieuDe(bang);
  const batDau = th ? th.dong + 1 : 0;
  const vt = th
    ? th.cot
    : { email: 0, hoTen: 1, maSv: 2, khoa: 3, han: 4 }; // không có tiêu đề: theo thứ tự
  for (let i = batDau; i < bang.length; i++) {
    const o = bang[i] || [];
    if (o.every((c) => chuoiO(c) === '')) continue;
    if (!th && i === 0 && !String(chuoiO(o[0])).includes('@')) continue; // dòng tiêu đề không nhận ra được: bỏ qua
    const dong = i + 1;
    if (rows.length + loi.length >= TOI_DA_DONG) {
      loi.push({ dong, message: `Danh sách quá dài (tối đa ${TOI_DA_DONG} dòng mỗi lần nhập).` });
      break;
    }
    const email = chuanHoaEmail(chuoiO(o[vt.email]));
    const hoTen = (vt.hoDem != null && vt.ten != null ? `${chuoiO(o[vt.hoDem])} ${chuoiO(o[vt.ten])}` : chuoiO(o[vt.hoTen])).replace(/\s+/g, ' ').trim();
    if (!email && !hoTen) continue; // dòng chỉ có số thứ tự / ô thừa: bỏ qua im lặng, không coi là lỗi
    if (!EMAIL_RE.test(email) || email.length > 190) { loi.push({ dong, message: 'Email không hợp lệ.' }); continue; }
    if (hoTen.length < 2 || hoTen.length > 150) { loi.push({ dong, message: 'Họ tên phải từ 2 đến 150 ký tự.' }); continue; }
    const thoHan = vt.han != null ? chuoiO(o[vt.han]) : '';
    const hetHan = thoHan !== '' ? ngayTuO(o[vt.han]) : chuanHoaNgay(hanMacDinh); // ô hạn để trống thì dùng hạn mặc định
    if (!hetHan) { loi.push({ dong, message: 'Thiếu hoặc sai hạn dùng (định dạng YYYY-MM-DD hoặc DD/MM/YYYY).' }); continue; }
    rows.push({
      dong,
      email,
      fullname: hoTen,
      ma_sv: (vt.maSv != null ? chuoiO(o[vt.maSv]).slice(0, 40) : '') || null,
      khoa: (vt.khoa != null ? chuoiO(o[vt.khoa]).slice(0, 60) : '') || null,
      het_han: hetHan,
    });
  }
  return { rows, loi, coTieuDe: !!th };
}

/** Văn bản dán từ Excel / CSV: tách TAB, dấu phẩy (ngoài ngoặc kép) hoặc chấm phẩy. */
function docDanhSach(text, hanMacDinh) {
  const bang = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((raw) => (raw.trim() ? raw.split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim().replace(/^"|"$/g, '')) : []));
  return docBang(bang, hanMacDinh);
}

/** Nội dung tệp tải lên (.xlsx hoặc .csv) → bảng. Ném lỗi có `status` 400 khi tệp không đọc được. */
async function docTep(buffer, tenTep, hanMacDinh) {
  const ten = String(tenTep || '').toLowerCase();
  const baoLoi = (m) => Object.assign(new Error(m), { status: 400 });
  if (!buffer || !buffer.length) throw baoLoi('Tệp trống.');
  if (buffer.length > TOI_DA_BYTE) throw baoLoi('Tệp quá lớn (tối đa 2 MB).');
  if (ten.endsWith('.csv')) {
    const { parse } = require('csv-parse/sync');
    try {
      const bang = parse(buffer.toString('utf8'), { bom: true, relax_column_count: true, skip_empty_lines: true, delimiter: [',', ';', '\t'] });
      return docBang(bang, hanMacDinh);
    } catch (e) {
      throw baoLoi('Không đọc được tệp CSV: ' + e.message);
    }
  }
  if (!ten.endsWith('.xlsx')) throw baoLoi('Chỉ nhận tệp Excel .xlsx hoặc .csv (Excel cũ .xls: hãy «Lưu thành» .xlsx).');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    throw baoLoi('Không đọc được tệp Excel: tệp hỏng hoặc không phải .xlsx.');
  }
  const ws = wb.worksheets.find((s) => s.name !== 'Hướng dẫn') || wb.worksheets[0];
  if (!ws) throw baoLoi('Tệp Excel không có trang tính nào.');
  const bang = [];
  const toiDa = Math.min(ws.rowCount, TOI_DA_DONG + 20);
  for (let r = 1; r <= toiDa; r++) {
    const dong = ws.getRow(r);
    const o = [];
    for (let c = 1; c <= Math.min(Math.max(ws.columnCount, 1), 30); c++) o.push(giaTriO(dong.getCell(c).value));
    bang.push(o);
  }
  return docBang(bang, hanMacDinh);
}

/** Tệp mẫu .xlsx: trang «Danh sách» (tiêu đề + ô nhập), trang «Hướng dẫn». Trả Buffer. */
async function taoMauXlsx() {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'STIMS — Viện Tế bào gốc';
  const ws = wb.addWorksheet('Danh sách', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Họ và tên', key: 'ten', width: 28 },
    { header: 'Mã sinh viên', key: 'ma', width: 16 },
    { header: 'Khóa / Đợt', key: 'khoa', width: 16 },
    { header: 'Hạn dùng (dd/mm/yyyy)', key: 'han', width: 24 },
  ];
  const tieuDe = ws.getRow(1);
  tieuDe.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  tieuDe.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16233D' } };
  tieuDe.alignment = { vertical: 'middle' };
  tieuDe.height = 24;
  // cột hạn là TEXT để Excel không tự đổi định dạng ngày; trình đọc nhận cả chuỗi lẫn ngày Excel
  ws.getColumn('han').numFmt = '@';
  const hd = wb.addWorksheet('Hướng dẫn');
  hd.columns = [{ width: 110 }];
  [
    'HƯỚNG DẪN NHẬP DANH SÁCH SINH VIÊN',
    '',
    '1. Nhập mỗi sinh viên một dòng ở trang «Danh sách». Bắt buộc: Email và Họ và tên. Các cột còn lại có thể để trống.',
    '2. Email phải là email Trung tâm quản lý người học đã đăng ký cho sinh viên: sinh viên sẽ đăng ký tài khoản bằng ĐÚNG email này.',
    '3. Hạn dùng: hết ngày này thì sinh viên không còn vào được Ngân hàng tế bào (Đặt lịch thiết bị vẫn dùng). Ghi dd/mm/yyyy, ví dụ 30/06/2027.',
    '   Để trống cột hạn thì dùng «Hạn dùng mặc định» chọn ở màn hình nhập.',
    '4. Không đổi tên các cột ở dòng đầu. Cột có thể sắp xếp khác thứ tự; hệ thống nhận cột theo tên.',
    '5. Chọn «Xem trước» ở màn hình nhập để kiểm tra lỗi từng dòng trước khi nhập thật. Nhập lại nhiều lần không bị trùng (cập nhật và gia hạn).',
    '6. Email @sci.edu.vn không cần nằm trong danh sách (đăng ký tài khoản bình thường).',
    '',
    'Danh sách là dữ liệu cá nhân: chỉ gửi cho quản lý module, không chia sẻ rộng.',
  ].forEach((t, i) => {
    hd.getRow(i + 1).getCell(1).value = t;
    if (i === 0) hd.getRow(1).font = { bold: true, size: 13 };
    hd.getRow(i + 1).getCell(1).alignment = { wrapText: true, vertical: 'top' };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = {
  HAN_GIU_NGAY, TOI_DA_DONG, TOI_DA_BYTE, CAC_COT, homNay, chuanHoaEmail, chuanHoaNgay, conHieuLuc, timTheoEmail, emailDuocDangKy,
  docDanhSach, docBang, docTep, taoMauXlsx, ngayTuO, EMAIL_RE,
};
