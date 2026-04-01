const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType } = require('docx');

function tr(text, opts = {}) {
  return new TextRun({ text: String(text || ''), font: 'Times New Roman', size: 26, bold: !!opts.bold });
}
function p(text, opts = {}) {
  return new Paragraph({ alignment: opts.alignment, spacing: { after: opts.after == null ? 120 : opts.after }, children: [tr(text, opts)] });
}
function vnDateText(iso) {
  const s = String(iso || '').slice(0, 10);
  const a = s.split('-');
  if (a.length !== 3) return '';
  return 'ngày ' + a[2] + ' tháng ' + a[1] + ' năm ' + a[0];
}
function toVietnameseCurrencyWords(n0) {
  const n = Math.max(0, Math.floor(Number(n0) || 0));
  if (n === 0) return 'Không đồng';
  const unit = ['', ' nghìn', ' triệu', ' tỷ', ' nghìn tỷ'];
  const nums = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  function read3(x, full) {
    let s = '';
    const trm = Math.floor(x / 100), ch = Math.floor((x % 100) / 10), dv = x % 10;
    if (full || trm > 0) s += nums[trm] + ' trăm';
    if (ch > 1) {
      s += (s ? ' ' : '') + nums[ch] + ' mươi';
      if (dv === 1) s += ' mốt'; else if (dv === 4) s += ' tư'; else if (dv === 5) s += ' lăm'; else if (dv > 0) s += ' ' + nums[dv];
    } else if (ch === 1) {
      s += (s ? ' ' : '') + 'mười';
      if (dv === 5) s += ' lăm'; else if (dv > 0) s += ' ' + nums[dv];
    } else if (dv > 0) {
      if (s) s += ' lẻ ';
      s += nums[dv];
    }
    return s.trim();
  }
  let x = n, i = 0, out = '', full = false;
  while (x > 0) {
    const b = x % 1000;
    if (b > 0) { out = read3(b, full) + unit[i] + (out ? ' ' + out : ''); full = true; }
    x = Math.floor(x / 1000); i += 1;
  }
  return out.charAt(0).toUpperCase() + out.slice(1) + ' đồng';
}
function scheduleTable(rows) {
  const data = Array.isArray(rows) ? rows : [];
  const head = new TableRow({ children: ['STT', 'Thời gian', 'Ngày', 'Nội dung'].map((h) => new TableCell({ children: [p(h, { bold: true, alignment: AlignmentType.CENTER })] })) });
  const body = (data.length ? data : [{ stt: 1, gio_bat_dau: '', gio_ket_thuc: '', ngay: '', noi_dung: '' }]).map((r, i) =>
    new TableRow({
      children: [
        new TableCell({ children: [p(String(r.stt || i + 1), { alignment: AlignmentType.CENTER })] }),
        new TableCell({ children: [p((r.gio_bat_dau || '') + ' - ' + (r.gio_ket_thuc || ''))] }),
        new TableCell({ children: [p(vnDateText(r.ngay || ''))] }),
        new TableCell({ children: [p(r.noi_dung || '')] }),
      ],
    })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [head, ...body] });
}
function buildByTemplate(templateAbsPath, data) {
  const content = fs.readFileSync(templateAbsPath);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render(data || {});
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
async function buildEventPermissionDocBuffer(data) {
  const templatePath = path.join(__dirname, '..', 'templates', 'events', 'to_trinh_xin_phep.docx');
  if (fs.existsSync(templatePath)) {
    const d = data || {};
    const dt = String(d.ngay_bat_dau || '').slice(0, 10).split('-');
    return buildByTemplate(templatePath, {
      ...d,
      ten_su_kien: d.tieu_de || '',
      loai_su_kien: d.loai || '',
      kinh_phi_bang_chu: d.kinh_phi_bang_chu || toVietnameseCurrencyWords(d.kinh_phi_du_kien || 0),
      ngay: dt[2] || '',
      thang: dt[1] || '',
      nam: dt[0] || '',
      lich_trinh: (d.lich_trinh || []).map((r, i) => ({
        stt: r.stt || i + 1,
        ngay: r.ngay || '',
        gio_bat_dau: r.gio_bat_dau || '',
        gio_ket_thuc: r.gio_ket_thuc || '',
        noi_dung: r.noi_dung || '',
      })),
    });
  }
  const doc = new Document({
    sections: [{
      children: [
        p('TRƯỜNG ĐẠI HỌC KHOA HỌC TỰ NHIÊN', { bold: true }),
        p('VIỆN TẾ BÀO GỐC', { bold: true }),
        p('Số: ' + (data.so_van_ban || '...') + '/SCI-KHCN&QHĐN'),
        p('V/v xin phép tổ chức ' + (data.loai || 'sự kiện')),
        p('Thành phố Hồ Chí Minh, ' + vnDateText(data.ngay_bat_dau), { alignment: AlignmentType.RIGHT }),
        p('Kính gửi: Ban Giám Hiệu Trường Đại học Khoa học tự nhiên; Phòng Khoa học - Công nghệ.'),
        p('I. THÔNG TIN CHUNG', { bold: true }),
        p('Tên sự kiện: ' + (data.tieu_de || '')),
        scheduleTable(data.lich_trinh || []),
        p('Hình thức: ' + (data.hinh_thuc || '')),
        p('Địa điểm/Link: ' + ((data.dia_diem || '') || (data.link_su_kien || ''))),
        p('Quy mô: ' + (data.quy_mo || '') + ' người'),
        p('II. MỤC TIÊU', { bold: true }),
        p(data.muc_tieu || ''),
        p('III. KINH PHÍ DỰ KIẾN', { bold: true }),
        p('Tổng kinh phí: ' + (Number(data.kinh_phi_du_kien || 0)).toLocaleString('vi-VN') + ' đồng'),
        p('(Bằng chữ: ' + (data.kinh_phi_bang_chu || toVietnameseCurrencyWords(data.kinh_phi_du_kien || 0)) + ')'),
        p('Nguồn kinh phí: ' + (data.nguon_kinh_phi || '')),
        p('IV. THÀNH PHẦN THAM DỰ', { bold: true }),
        p(data.thanh_phan_tham_du || ''),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}
async function buildEventReportDocBuffer(data) {
  const templatePath = path.join(__dirname, '..', 'templates', 'events', 'bao_cao_su_kien.docx');
  if (fs.existsSync(templatePath)) {
    return buildByTemplate(templatePath, data || {});
  }
  const doc = new Document({
    sections: [{
      children: [
        p('BÁO CÁO KẾT QUẢ TỔ CHỨC SỰ KIỆN', { bold: true, alignment: AlignmentType.CENTER }),
        p('Tên sự kiện: ' + (data.tieu_de || '')),
        p('Thời gian: ' + vnDateText(data.ngay_bat_dau) + (data.ngay_ket_thuc ? ' đến ' + vnDateText(data.ngay_ket_thuc) : '')),
        p('I. KẾT QUẢ', { bold: true }),
        p('Số người tham dự thực tế: ' + (data.so_nguoi_tham_du_thuc_te || '')),
        p('Tóm tắt kết quả: ' + (data.ket_qua_su_kien || '')),
        p('Ưu điểm: ' + (data.uu_diem || '')),
        p('Hạn chế: ' + (data.han_che || '')),
        p('II. ĐỀ XUẤT, KIẾN NGHỊ', { bold: true }),
        p(data.de_xuat_kien_nghi || ''),
        p('III. BÀI HỌC KINH NGHIỆM', { bold: true }),
        p(data.bai_hoc_kinh_nghiem || ''),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}
module.exports = { buildEventPermissionDocBuffer, buildEventReportDocBuffer, toVietnameseCurrencyWords };

