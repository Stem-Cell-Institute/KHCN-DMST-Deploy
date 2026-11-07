/**
 * PDF MẪU để THỬ ký số MySign bằng tài khoản của chính người thử (trang ky-so-thu.html, chỉ quản trị viên).
 * Không dính dữ liệu nghiệp vụ nào: nội dung cố định vài trang, để xem khung chữ ký đặt/kéo ở đâu cũng được.
 *
 *   taoPdfThu({ ten, viTri, xemTruoc, luc, dongKhung, hinh }) → Promise<{pdf:Buffer, meta}>
 *     viTri    — {trang, x, y, w, h} tỉ lệ 0..1 (gốc trên-trái, trang từ 0); không có thì góc dưới-phải trang cuối.
 *     dongKhung — các dòng chữ trong khung (KhungKy.dungDong); hinh — Buffer ảnh chữ ký tay (tùy chọn).
 *     xemTruoc — true: bản xem trước, không vẽ khung và không chừa chữ ký (số trang, bố cục y hệt bản ký).
 */

const path = require('path');
const { datChoKy } = require('./pades');
const { veKhung } = require('./khungKy');

const DIR_FONT = path.join(__dirname, '..', 'fonts');
const SO_TRANG = 3;
const MAC_DINH = { x: 0.5, y: 0.82, w: 0.42, h: 0.1 };
const LY_DO_THU = 'Thử ký số';
const NOI_KY_THU = 'STIMS';

function taoPdfThu({ ten, viTri, xemTruoc, luc, dongKhung, hinh } = {}) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 57, bottom: 57, left: 70, right: 57 }, bufferPages: true, info: { Title: 'Tài liệu thử ký số MySign', Author: 'STIMS — Viện Tế bào gốc' } });
    const chunks = [];
    let meta = null;
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ pdf: Buffer.concat(chunks), meta }));
    doc.on('error', reject);
    try {
      doc.registerFont('R', path.join(DIR_FONT, 'Tinos-Regular.ttf'));
      doc.registerFont('B', path.join(DIR_FONT, 'Tinos-Bold.ttf'));
    } catch (e) {
      reject(e);
      return;
    }

    for (let p = 0; p < SO_TRANG; p++) {
      if (p > 0) doc.addPage();
      doc.font('B').fontSize(16).text('TÀI LIỆU THỬ KÝ SỐ', { align: 'center' });
      doc.moveDown(0.3).font('R').fontSize(11).text('Trang ' + (p + 1) + '/' + SO_TRANG + ' — chỉ để kiểm tra chữ ký số MySign, không có giá trị nghiệp vụ.', { align: 'center' });
      doc.moveDown(1.2);
      for (let i = 1; i <= 14; i++) {
        doc.font('R').fontSize(12).text(`Đoạn ${i} của trang ${p + 1}. Nội dung mẫu để thấy khung chữ ký nằm đè lên hay nằm cạnh chữ khi kéo thả: văn bản này kéo dài nhiều dòng để lấp đầy trang một cách tự nhiên.`, { align: 'justify' });
        doc.moveDown(0.5);
      }
    }

    const W = doc.page.width;
    const H = doc.page.height;
    meta = { so_trang: SO_TRANG, kho: [W, H], mac_dinh: { trang: SO_TRANG - 1, ...MAC_DINH } };
    if (xemTruoc) {
      doc.end();
      return;
    }

    // Một hoặc nhiều chỗ ký: mọi chỗ đều vẽ khung nhìn thấy; ô chữ ký số thật (widget) ở chỗ đầu tiên.
    const ds = viTri ? [].concat(viTri) : [{ trang: SO_TRANG - 1, ...MAC_DINH }];
    for (const v of ds) {
      if (!Number.isInteger(v.trang) || v.trang < 0 || v.trang >= SO_TRANG) {
        reject(Object.assign(new Error('Trang đặt khung chữ ký không có trong tài liệu (tài liệu có ' + SO_TRANG + ' trang).'), { maLoi: 'vi_tri' }));
        return;
      }
    }
    const dong = dongKhung || ['ĐÃ KÝ SỐ (THỬ)', 'Người ký: ' + (ten || ''), 'Qua MySign — Viettel-CA'];
    try {
      for (const v of ds) veKhung(doc, [v.x * W, v.y * H, v.w * W, v.h * H], { dong, hinh, trang: v.trang });
    } catch (e) {
      reject(e);
      return;
    }
    const v0 = ds[0];
    doc.switchToPage(v0.trang);
    datChoKy(doc, { rect: [v0.x * W, v0.y * H, v0.w * W, v0.h * H], ten: ten || '', lyDo: LY_DO_THU, noiKy: NOI_KY_THU, luc: luc || new Date() });
    doc.end();
  });
}

module.exports = { taoPdfThu, SO_TRANG };
