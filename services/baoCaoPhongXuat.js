/**
 * Kết xuất báo cáo phòng ban ra Word (.docx) và PDF.
 *
 * Thiết kế hai tầng để Word và PDF luôn cho NỘI DUNG giống hệt nhau:
 *   1. dungMoHinh()  — thuần logic: biến (đợt + biểu mẫu + dữ liệu một phòng) thành danh sách
 *      "khối" (quốc hiệu, tiêu đề, đoạn, bảng, chữ ký…). Không biết gì về Word hay PDF, nên test
 *      được trực tiếp trên dữ liệu mà không cần mở file.
 *   2. taoDocx() / taoPdf() — chỉ việc VẼ các khối đó.
 *
 * Bố cục theo mẫu "Báo cáo kết quả hoạt động tháng" của Viện: quốc hiệu, ngày, tiêu đề, kính
 * gửi, các mục I–V, khối chữ ký. Biểu mẫu do người quản lý chỉnh được nên phần thân KHÔNG cứng:
 * duyệt theo thứ tự ô, mỗi ô sinh ra khối tương ứng (tiêu đề nhóm → mục; bảng → bảng; ô thường →
 * "Nhãn: giá trị"; ô tổng hợp → các dòng thống kê). Chỉ phần đầu thư và chữ ký là cố định.
 *
 * Nhiều phòng trong một file: mỗi báo cáo là một văn bản đầy đủ, bắt đầu ở trang mới.
 *
 * PDF cần font NHÚNG vì font mặc định của PDF không có dấu tiếng Việt — xem services/fonts/README.md.
 */

const fs = require('fs');
const path = require('path');
const { tinhTongHop } = require('./baoCaoPhongMau');

// ── Thông tin cơ quan: hằng số của Viện, in ở đầu mọi văn bản ───────────────
const CO_QUAN = {
  truong: 'TRƯỜNG ĐẠI HỌC KHOA HỌC TỰ NHIÊN',
  don_vi: 'VIỆN TẾ BÀO GỐC',
  quoc_hieu: 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM',
  tieu_ngu: 'Độc lập – Tự do – Hạnh phúc',
  noi_viet: 'TP. Hồ Chí Minh',
  kinh_gui: 'Viện trưởng Viện Tế bào gốc',
};

const LOAI_HOA = { tuan: 'TUẦN', thang: 'THÁNG', quy: 'QUÝ', nam: 'NĂM' };

/** Khóa ô dùng để in tên dưới chữ ký Trưởng phòng (xem services/baoCaoPhongMauMacDinh.js). */
const KHOA_NGUOI_PHU_TRACH = 'nguoi_phu_trach';

// ── Định dạng giá trị ──────────────────────────────────────────────────────
function fmtNgay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : s == null ? '' : String(s);
}

function fmtGiaTri(def, v) {
  if (v === undefined || v === null || v === '') return '';
  if (def.kieu === 'date') return fmtNgay(v);
  if (def.kieu === 'checkbox') return v === true ? 'Có' : 'Không';
  return String(v);
}

function chuCaiNhom(i) {
  // 0→A, 1→B … 25→Z, 26→AA
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Ngày hiện tại theo giờ Việt Nam: server có thể chạy UTC nên không dùng getDate() trực tiếp. */
function ngayVietNam(d) {
  const t = new Date((d || new Date()).getTime() + 7 * 3600 * 1000);
  return { ngay: t.getUTCDate(), thang: t.getUTCMonth() + 1, nam: t.getUTCFullYear() };
}

function tieuDeVanBan(dot) {
  const goc = 'BÁO CÁO KẾT QUẢ HOẠT ĐỘNG';
  const loai = LOAI_HOA[dot.loai];
  if (loai && dot.ky) return `${goc} ${loai} ${dot.ky}`;
  if (dot.ky) return `${goc} ${String(dot.ky).toLocaleUpperCase('vi')}`;
  return `${goc} — ${String(dot.tieu_de || '').toLocaleUpperCase('vi')}`.trim();
}

/**
 * Dựng mô hình tài liệu cho MỘT báo cáo.
 * @param {{dot:object, truong:object[], baoCao:{phong_ten:string, nguoi_nop?:string, du_lieu:object}, ngayXuat?:Date}} p
 * @returns {{tieu_de_tep:string, khoi:object[]}}
 */
function dungMoHinh({ dot, truong, baoCao, ngayXuat }) {
  const du = baoCao.du_lieu || {};
  const { ngay, thang, nam } = ngayVietNam(ngayXuat);
  const khoi = [];

  khoi.push({
    loai: 'quoc_hieu',
    trai: [CO_QUAN.truong, CO_QUAN.don_vi],
    phai: [CO_QUAN.quoc_hieu, CO_QUAN.tieu_ngu],
  });
  khoi.push({ loai: 'ngay', text: `${CO_QUAN.noi_viet}, ngày ${ngay} tháng ${thang} năm ${nam}` });
  khoi.push({ loai: 'tieu_de', text: tieuDeVanBan(dot) });
  khoi.push({ loai: 'kinh_gui', nhan: 'Kính gửi:', text: CO_QUAN.kinh_gui });
  khoi.push({ loai: 'doan', nhan: 'Tên Phòng/Ban', text: baoCao.phong_ten || '' });

  for (const o of truong) {
    switch (o.kieu) {
      case 'section':
        khoi.push({ loai: 'muc', text: String(o.nhan).toLocaleUpperCase('vi') });
        if (o.tro_giup) khoi.push({ loai: 'ghi_chu', text: o.tro_giup });
        break;

      case 'bang': {
        khoi.push({ loai: 'tieu_de_bang', text: o.nhan });
        const hang = Array.isArray(du[o.key]) ? du[o.key] : [];
        const hangOut = [];
        let stt = 0;
        let nhom = -1;
        for (const r of hang) {
          if (r && typeof r.nhom === 'string') {
            nhom++;
            hangOut.push({ nhom: `${chuCaiNhom(nhom)}. ${o.nhan_nhom ? o.nhan_nhom + ': ' : ''}${r.nhom}` });
          } else if (r && r.o) {
            stt++;
            hangOut.push({ stt, cells: o.cot.map((c) => fmtGiaTri(c, r.o[c.key])) });
          }
        }
        if (stt === 0 && !hangOut.length) khoi.push({ loai: 'ghi_chu', text: 'Không có nội dung.' });
        else {
          khoi.push({
            loai: 'bang',
            cot: o.cot.map((c) => ({ nhan: c.nhan, kieu: c.kieu })),
            hang: hangOut,
          });
        }
        break;
      }

      case 'tong_hop': {
        const t = tinhTongHop(truong, du, o);
        khoi.push({
          loai: 'danh_sach',
          dong: [
            ['Tổng số công việc đã đăng ký/được giao', `${t.tong} việc`],
            ['Hoàn thành', `${t.hoan_thanh} việc (chiếm ${t.ty_le.hoan_thanh}%)`],
            ['Đang thực hiện (chưa hoàn thành)', `${t.dang_thuc_hien} việc (chiếm ${t.ty_le.dang_thuc_hien}%)`],
            ['Chưa thực hiện', `${t.chua_thuc_hien} việc (chiếm ${t.ty_le.chua_thuc_hien}%)`],
          ],
        });
        break;
      }

      default: {
        const text = fmtGiaTri(o, du[o.key]);
        khoi.push({ loai: 'doan', nhan: o.nhan, text: text || '—' });
      }
    }
  }

  const phuTrach = truong.some((o) => o.key === KHOA_NGUOI_PHU_TRACH) ? fmtGiaTri({ kieu: 'text' }, du[KHOA_NGUOI_PHU_TRACH]) : '';
  khoi.push({
    loai: 'chu_ky',
    cot: [
      { tieu_de: 'NGƯỜI LẬP BÁO CÁO', ten: baoCao.nguoi_nop || '' },
      { tieu_de: 'TRƯỞNG PHÒNG', ten: phuTrach },
      { tieu_de: 'VIỆN TRƯỞNG (Phê duyệt)', ten: '' },
    ],
  });

  return { tieu_de_tep: baoCao.phong_ten || 'bao-cao', khoi };
}

/** Trọng số độ rộng cột: cột số/ngày hẹp, văn bản dài rộng. */
function trongSoCot(c) {
  if (c.kieu === 'number') return 0.7;
  if (c.kieu === 'date') return 0.8;
  if (c.kieu === 'select') return 0.8;
  if (c.kieu === 'textarea') return 1.6;
  return 1;
}

function chiaDoRong(cot, tong, rongStt) {
  const con = tong - rongStt;
  const w = cot.map(trongSoCot);
  const s = w.reduce((a, b) => a + b, 0);
  return [rongStt, ...w.map((x) => (con * x) / s)];
}

// ══ WORD ═══════════════════════════════════════════════════════════════════
async function taoDocx(moHinhs) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, AlignmentType, BorderStyle,
    WidthType, ShadingType, Footer, PageNumber, VerticalAlign, convertMillimetersToTwip,
  } = require('docx');

  const FONT = 'Times New Roman';
  const CO = 26; // 13pt, tính theo half-point
  const CO_BANG = 22; // 11pt
  const RONG_TRANG = 9071; // twip: A4 (21cm) trừ lề trái 3cm + phải 2cm = 16cm
  const KHONG_VIEN = {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };
  const VIEN = {
    top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  };

  const run = (text, o = {}) => new TextRun({ text: text == null ? '' : String(text), font: FONT, size: o.size || CO, bold: o.bold, italics: o.italics });

  /** Chuỗi nhiều dòng → các TextRun có xuống dòng (docx không tự hiểu \n trong text). */
  function runsNhieuDong(text, o = {}) {
    const dong = String(text == null ? '' : text).split(/\r?\n/);
    return dong.map((d, i) => new TextRun({ text: d, font: FONT, size: o.size || CO, bold: o.bold, italics: o.italics, break: i > 0 ? 1 : 0 }));
  }

  const para = (children, o = {}) =>
    new Paragraph({ alignment: o.canh, spacing: { before: o.truoc || 0, after: o.sau === undefined ? 80 : o.sau }, keepNext: o.giuCungTiep, children });

  function oBang(children, rong, o = {}) {
    return new TableCell({
      width: { size: Math.round(rong), type: WidthType.DXA },
      borders: o.khongVien ? KHONG_VIEN : VIEN,
      shading: o.nen ? { fill: o.nen, type: ShadingType.CLEAR, color: 'auto' } : undefined,
      verticalAlign: o.giua ? VerticalAlign.CENTER : VerticalAlign.TOP,
      columnSpan: o.gop,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children,
    });
  }

  function veKhoi(k) {
    switch (k.loai) {
      case 'quoc_hieu': {
        // Cùng tỷ lệ 47/53 và cỡ 10,5pt như bản PDF (đã đo theo độ rộng chữ thật) để mỗi dòng vừa một hàng.
        const rongTrai = Math.round(RONG_TRANG * 0.47);
        const rongPhai = RONG_TRANG - rongTrai;
        const cot = (dong, dam) =>
          dong.map((d, i) => para([run(d, { size: 21, bold: dam[i] })], { canh: AlignmentType.CENTER, sau: 0 }));
        return [
          new Table({
            width: { size: RONG_TRANG, type: WidthType.DXA },
            columnWidths: [rongTrai, rongPhai],
            borders: { ...KHONG_VIEN, insideHorizontal: KHONG_VIEN.top, insideVertical: KHONG_VIEN.top },
            rows: [new TableRow({ children: [oBang(cot(k.trai, [false, true]), rongTrai, { khongVien: true }), oBang(cot(k.phai, [true, true]), rongPhai, { khongVien: true })] })],
          }),
          para([run('')], { sau: 120 }),
        ];
      }
      case 'ngay':
        return [para([run(k.text, { italics: true })], { canh: AlignmentType.RIGHT, sau: 160 })];
      case 'tieu_de':
        return [para([run(k.text, { bold: true, size: 28 })], { canh: AlignmentType.CENTER, truoc: 120, sau: 160 })];
      case 'kinh_gui':
        // Căn TRÁI, chỉ "Kính gửi:" in đậm — đúng như file Word gốc của Viện (đã kiểm trong XML).
        return [para([run(k.nhan + ' ', { bold: true }), run(k.text)], { sau: 200 })];
      case 'doan':
        return [para([run(k.nhan + ': ', { bold: true }), ...runsNhieuDong(k.text)])];
      case 'muc':
        return [para([run(k.text, { bold: true })], { truoc: 200, sau: 80, giuCungTiep: true })];
      case 'ghi_chu':
        return [para(runsNhieuDong(k.text, { italics: true, size: 24 }))];
      case 'tieu_de_bang':
        return [para([run(k.text, { bold: true })], { truoc: 100, sau: 60, giuCungTiep: true })];
      case 'danh_sach':
        return k.dong.map(([nhan, giaTri]) => para([run('•  ' + nhan + ': ', { bold: true }), run(giaTri)], { sau: 40 }));
      case 'bang': {
        const w = chiaDoRong(k.cot, RONG_TRANG, 560);
        const dauBang = new TableRow({
          tableHeader: true,
          cantSplit: true,
          children: [
            oBang([para([run('STT', { bold: true, size: CO_BANG })], { canh: AlignmentType.CENTER, sau: 0 })], w[0], { nen: 'D9D9D9', giua: true }),
            ...k.cot.map((c, i) => oBang([para([run(c.nhan, { bold: true, size: CO_BANG })], { canh: AlignmentType.CENTER, sau: 0 })], w[i + 1], { nen: 'D9D9D9', giua: true })),
          ],
        });
        const thanBang = k.hang.map((r) => {
          if (r.nhom !== undefined) {
            return new TableRow({
              cantSplit: true,
              children: [oBang([para([run(r.nhom, { bold: true, size: CO_BANG })], { sau: 0 })], RONG_TRANG, { gop: k.cot.length + 1, nen: 'F2F2F2' })],
            });
          }
          return new TableRow({
            cantSplit: true,
            children: [
              oBang([para([run(r.stt, { size: CO_BANG })], { canh: AlignmentType.CENTER, sau: 0 })], w[0]),
              ...r.cells.map((t, i) => oBang([para(runsNhieuDong(t, { size: CO_BANG }), { sau: 0, canh: k.cot[i].kieu === 'number' || k.cot[i].kieu === 'date' ? AlignmentType.CENTER : undefined })], w[i + 1])),
            ],
          });
        });
        return [
          new Table({ width: { size: RONG_TRANG, type: WidthType.DXA }, columnWidths: w.map(Math.round), rows: [dauBang, ...thanBang] }),
          para([run('')], { sau: 60 }),
        ];
      }
      case 'chu_ky': {
        const w = RONG_TRANG / k.cot.length;
        return [
          para([run('')], { sau: 200 }),
          new Table({
            width: { size: RONG_TRANG, type: WidthType.DXA },
            columnWidths: k.cot.map(() => Math.round(w)),
            borders: { ...KHONG_VIEN, insideHorizontal: KHONG_VIEN.top, insideVertical: KHONG_VIEN.top },
            rows: [
              new TableRow({
                cantSplit: true,
                children: k.cot.map((c) =>
                  oBang(
                    [
                      para([run(c.tieu_de, { bold: true })], { canh: AlignmentType.CENTER, sau: 0 }),
                      para([run('(Ký, ghi rõ họ tên)', { italics: true, size: 22 })], { canh: AlignmentType.CENTER, sau: 900 }),
                      para([run(c.ten, { bold: true })], { canh: AlignmentType.CENTER, sau: 0 }),
                    ],
                    w,
                    { khongVien: true }
                  )
                ),
              }),
            ],
          }),
        ];
      }
      default:
        return [];
    }
  }

  const sections = moHinhs.map((mh) => ({
    properties: {
      page: {
        size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
        margin: { top: convertMillimetersToTwip(20), bottom: convertMillimetersToTwip(20), left: convertMillimetersToTwip(30), right: convertMillimetersToTwip(20) },
        pageNumbers: { start: 1 }, // mỗi báo cáo đánh số trang lại từ 1
      },
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Trang ', PageNumber.CURRENT], font: FONT, size: 20 })] })],
      }),
    },
    children: mh.khoi.flatMap(veKhoi),
  }));

  const doc = new Document({
    creator: 'STIMS — Viện Tế bào gốc',
    title: 'Báo cáo kết quả hoạt động',
    styles: { default: { document: { run: { font: FONT, size: CO } } } },
    sections,
  });
  return Packer.toBuffer(doc);
}

// ══ PDF ════════════════════════════════════════════════════════════════════
const DIR_FONT = path.join(__dirname, 'fonts');

function taoPdf(moHinhs) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const LE = { t: 57, b: 57, l: 85, r: 57 }; // pt: 2cm, 2cm, 3cm, 2cm
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: LE.t, bottom: LE.b, left: LE.l, right: LE.r },
      bufferPages: true,
      info: { Title: 'Báo cáo kết quả hoạt động', Author: 'STIMS — Viện Tế bào gốc' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      doc.registerFont('R', path.join(DIR_FONT, 'Tinos-Regular.ttf'));
      doc.registerFont('B', path.join(DIR_FONT, 'Tinos-Bold.ttf'));
      doc.registerFont('I', path.join(DIR_FONT, 'Tinos-Italic.ttf'));
      doc.registerFont('BI', path.join(DIR_FONT, 'Tinos-BoldItalic.ttf'));
    } catch (e) {
      reject(e);
      return;
    }

    const rongNoiDung = () => doc.page.width - LE.l - LE.r;
    const duoiTrang = () => doc.page.height - LE.b;
    const CO = 12;
    const CO_BANG = 10;
    const DEM = 4;
    const trangBatDau = [];

    function canGiuaDong(dong, font, co) {
      doc.font(font).fontSize(co).text(dong, LE.l, doc.y, { width: rongNoiDung(), align: 'center' });
    }

    function veKhoi(k) {
      doc.x = LE.l;
      switch (k.loai) {
        case 'quoc_hieu': {
          // Tỷ lệ 47/53 và cỡ 10,5pt đo theo độ rộng chữ THẬT của font Tinos: dòng dài nhất của mỗi bên
          // ("TRƯỜNG ĐẠI HỌC KHOA HỌC TỰ NHIÊN" 7,05 cm; "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM" 7,67 cm)
          // đều vừa một dòng. Chia 50/50 thì bên phải bị ngắt dòng.
          const rongTrai = rongNoiDung() * 0.47;
          const rongPhai = rongNoiDung() - rongTrai;
          const y0 = doc.y;
          let yMax = y0;
          const cot = (dong, dam, x, rong) => {
            doc.y = y0;
            dong.forEach((d, i) => {
              doc.font(dam[i] ? 'B' : 'R').fontSize(10.5).text(d, x, doc.y, { width: rong, align: 'center' });
            });
            yMax = Math.max(yMax, doc.y);
          };
          cot(k.trai, [false, true], LE.l, rongTrai);
          cot(k.phai, [true, true], LE.l + rongTrai, rongPhai);
          doc.y = yMax + 10;
          break;
        }
        case 'ngay':
          doc.font('I').fontSize(CO).text(k.text, LE.l, doc.y, { width: rongNoiDung(), align: 'right' });
          doc.moveDown(0.8);
          break;
        case 'tieu_de':
          doc.moveDown(0.4);
          canGiuaDong(k.text, 'B', 14);
          doc.moveDown(0.8);
          break;
        case 'kinh_gui': {
          // Căn TRÁI như file Word gốc, hai đoạn khác kiểu chữ (đậm + thường) trên một dòng. Tự đo độ rộng đoạn
          // đầu rồi đặt đoạn sau ngay cạnh: dùng `continued` kèm `align` của pdfkit sẽ định vị sai và chữ đè lên nhau.
          doc.font('B').fontSize(CO);
          const w1 = doc.widthOfString(k.nhan + ' ');
          const x0 = LE.l;
          const y = doc.y;
          doc.font('B').text(k.nhan + ' ', x0, y, { lineBreak: false });
          doc.font('R').text(k.text, x0 + w1, y, { lineBreak: false });
          doc.x = LE.l;
          doc.y = y + doc.currentLineHeight(true);
          doc.moveDown(0.9);
          break;
        }
        case 'doan':
          doc.font('B').fontSize(CO).text(k.nhan + ': ', LE.l, doc.y, { width: rongNoiDung(), continued: true });
          doc.font('R').text(k.text);
          doc.moveDown(0.35);
          break;
        case 'muc':
          if (doc.y + 50 > duoiTrang()) doc.addPage(); // không để tiêu đề mục mồ côi ở cuối trang
          doc.moveDown(0.6);
          doc.font('B').fontSize(CO).text(k.text, LE.l, doc.y, { width: rongNoiDung() });
          doc.moveDown(0.3);
          break;
        case 'ghi_chu':
          doc.font('I').fontSize(CO_BANG + 1).text(k.text, LE.l, doc.y, { width: rongNoiDung() });
          doc.moveDown(0.4);
          break;
        case 'tieu_de_bang':
          if (doc.y + 60 > duoiTrang()) doc.addPage();
          doc.moveDown(0.3);
          doc.font('B').fontSize(CO).text(k.text, LE.l, doc.y, { width: rongNoiDung() });
          doc.moveDown(0.3);
          break;
        case 'danh_sach':
          for (const [nhan, giaTri] of k.dong) {
            doc.font('B').fontSize(CO).text('•  ' + nhan + ': ', LE.l, doc.y, { width: rongNoiDung(), continued: true });
            doc.font('R').text(giaTri);
          }
          doc.moveDown(0.4);
          break;
        case 'bang':
          veBang(k);
          break;
        case 'chu_ky':
          veChuKy(k);
          break;
        default:
          break;
      }
    }

    function veBang(k) {
      const w = chiaDoRong(k.cot, rongNoiDung(), 28);
      const tong = rongNoiDung();

      /** Chiều cao dòng = ô cao nhất. Ô dài bất thường bị cắt để không vượt quá một trang. */
      function chieuCao(cells, font) {
        doc.font(font).fontSize(CO_BANG);
        let h = 0;
        cells.forEach((t, i) => { h = Math.max(h, doc.heightOfString(String(t), { width: w[i] - 2 * DEM })); });
        return Math.min(h + 2 * DEM, duoiTrang() - LE.t - 20);
      }

      function veDong(cells, font, nen, canGiua) {
        const h = chieuCao(cells, font);
        if (doc.y + h > duoiTrang()) {
          doc.addPage();
          veDauBang();
        }
        const y = doc.y;
        let x = LE.l;
        cells.forEach((t, i) => {
          if (nen) doc.rect(x, y, w[i], h).fillAndStroke(nen, '#000000');
          else doc.rect(x, y, w[i], h).stroke('#000000');
          doc.fillColor('#000000').font(font).fontSize(CO_BANG).text(String(t), x + DEM, y + DEM, {
            width: w[i] - 2 * DEM,
            height: h - 2 * DEM,
            ellipsis: true,
            align: canGiua[i] ? 'center' : 'left',
          });
          x += w[i];
        });
        doc.x = LE.l;
        doc.y = y + h;
      }

      function veDauBang() {
        veDong(['STT', ...k.cot.map((c) => c.nhan)], 'B', '#D9D9D9', [true, ...k.cot.map(() => true)]);
      }

      // Dòng đầu (tiêu đề) phải đi kèm ít nhất một dòng dữ liệu, không để tiêu đề trơ trọi cuối trang.
      if (doc.y + 70 > duoiTrang()) doc.addPage();
      veDauBang();
      for (const r of k.hang) {
        if (r.nhom !== undefined) {
          const h = Math.min(doc.heightOfString(r.nhom, { width: tong - 2 * DEM }) + 2 * DEM, duoiTrang() - LE.t - 20);
          if (doc.y + h > duoiTrang()) { doc.addPage(); veDauBang(); }
          const y = doc.y;
          doc.rect(LE.l, y, tong, h).fillAndStroke('#F2F2F2', '#000000');
          doc.fillColor('#000000').font('B').fontSize(CO_BANG).text(r.nhom, LE.l + DEM, y + DEM, { width: tong - 2 * DEM });
          doc.x = LE.l;
          doc.y = y + h;
        } else {
          veDong([r.stt, ...r.cells], 'R', null, [true, ...k.cot.map((c) => c.kieu === 'number' || c.kieu === 'date')]);
        }
      }
      doc.moveDown(0.8);
    }

    function veChuKy(k) {
      const n = k.cot.length;
      const w = rongNoiDung() / n;
      if (doc.y + 120 > duoiTrang()) doc.addPage();
      doc.moveDown(1.2);
      const y0 = doc.y;
      k.cot.forEach((c, i) => {
        const x = LE.l + i * w;
        doc.font('B').fontSize(CO - 1).text(c.tieu_de, x, y0, { width: w, align: 'center' });
        doc.font('I').fontSize(CO - 2).text('(Ký, ghi rõ họ tên)', x, doc.y, { width: w, align: 'center' });
        if (c.ten) doc.font('B').fontSize(CO).text(c.ten, x, y0 + 80, { width: w, align: 'center' });
      });
      doc.x = LE.l;
      doc.y = y0 + 100;
    }

    moHinhs.forEach((mh, idx) => {
      if (idx > 0) doc.addPage();
      trangBatDau.push(doc.bufferedPageRange().count - 1);
      for (const k of mh.khoi) veKhoi(k);
    });

    // Đánh số trang "Trang i/n" cho TỪNG báo cáo (mỗi báo cáo đánh lại từ 1).
    const tongTrang = doc.bufferedPageRange().count;
    trangBatDau.forEach((bd, idx) => {
      const kt = idx + 1 < trangBatDau.length ? trangBatDau[idx + 1] : tongTrang;
      for (let p = bd; p < kt; p++) {
        doc.switchToPage(p);
        // Ghi vào vùng lề dưới sẽ làm pdfkit tự thêm trang mới nếu không gỡ lề tạm thời.
        const leDuoi = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('R').fontSize(10).fillColor('#000000').text(`Trang ${p - bd + 1}/${kt - bd}`, 0, doc.page.height - 36, { width: doc.page.width, align: 'center' });
        doc.page.margins.bottom = leDuoi;
      }
    });

    doc.end();
  });
}

module.exports = { CO_QUAN, dungMoHinh, taoDocx, taoPdf, tieuDeVanBan, chuCaiNhom, fmtNgay };
