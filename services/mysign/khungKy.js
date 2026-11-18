/**
 * Nội dung NHÌN THẤY của khung chữ ký số trên trang PDF: các dòng thông tin người ký chọn bật/tắt, hình chữ ký tay (tùy chọn).
 * Chữ ký số thật (mật mã) nằm trong tệp, độc lập với khung này; khung chỉ để người đọc thấy ngay ai ký, lúc nào, bằng chứng thư nào.
 *
 *   TRUONG                       các dòng chọn được, theo thứ tự hiển thị: {khoa, nhan}
 *   kiemTuyChon(x)               kiểm dữ liệu người dùng gửi lên → {tuy_chon} | {loi}
 *   thongTinChungThu(der)        tên (CN), tổ chức (O), số seri của chứng thư → {cn, to_chuc, so_seri}
 *   thongTinTuDn(dn, soSeri)     như trên nhưng từ chuỗi DN đã lưu (không cần chứng thư gốc)
 *   dungDong({...})              các dòng chữ trong khung
 *   kiemHinh(buf)                kiểm ảnh chữ ký tải lên → {mime, rong, cao} | {loi}
 *   veKhung(doc, rect, {dong, hinh, trang})   vẽ khung (viền, hình bên trái, chữ bên phải) lên trang pdfkit
 *   gioVietNam(date)             02/11/2026 09:05
 *
 * Quy ước cỡ chữ: thu theo chiều cao khung để đủ mọi dòng; thấp hơn CO_TOI_THIEU thì báo lỗi 'vi_tri' (khung quá thấp).
 * Giao diện (public/js/kysoViTri.js) dùng cùng công thức để tự nâng chiều cao tối thiểu của khung khi người ký bật thêm dòng.
 */

const crypto = require('crypto');

const TIEU_DE = 'ĐÃ KÝ SỐ';
const DONG_CUOI = 'Qua MySign — Viettel-CA';
const TRUONG = [
  { khoa: 'ho_ten', nhan: 'Người ký' },
  { khoa: 'to_chuc', nhan: 'Tổ chức' },
  { khoa: 'so_seri', nhan: 'Số chứng thư' },
  { khoa: 'thoi_gian', nhan: 'Thời gian' },
  { khoa: 'ly_do', nhan: 'Lý do' },
  { khoa: 'noi_ky', nhan: 'Nơi ký' },
];
const MAC_DINH = { ho_ten: true, to_chuc: false, so_seri: true, thoi_gian: true, ly_do: false, noi_ky: false, hinh: true };

const CO_TOI_DA = 8.5;
const CO_TOI_THIEU = 4.5;
const GIAN_DONG = 1.4;
const TOI_DA_HINH_BYTE = 1024 * 1024;
const TOI_DA_HINH_PX = 4000;
const TOI_THIEU_HINH_PX = 20;

/** Ngày giờ theo giờ Việt Nam, dạng 02/11/2026 09:05. */
function gioVietNam(d) {
  const t = new Date(d.getTime() + 7 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())}/${p(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

/** @returns {{tuy_chon:object}|{loi:string}} giá trị thiếu lấy từ nen (mặc định nếu không có) */
function kiemTuyChon(x, nen) {
  const goc = { ...MAC_DINH, ...(nen || {}) };
  if (x === undefined || x === null) return { tuy_chon: goc };
  if (typeof x !== 'object' || Array.isArray(x)) return { loi: 'Lựa chọn nội dung khung chữ ký không hợp lệ.' };
  for (const k of Object.keys(MAC_DINH)) {
    if (x[k] === undefined) continue;
    if (typeof x[k] !== 'boolean') return { loi: 'Lựa chọn nội dung khung chữ ký không hợp lệ.' };
    goc[k] = x[k];
  }
  return { tuy_chon: goc };
}

const bo = (s) => String(s || '').replace(/\\,/g, ',').trim();

/** Lấy giá trị một thuộc tính (CN, O…) trong chuỗi DN dạng "CN=A, O=B" hoặc nhiều dòng "CN=A\nO=B". */
function layThuocTinh(dn, ten) {
  const m = String(dn || '').match(new RegExp('(?:^|,\\s*|\\n)' + ten + '=((?:\\\\,|[^,\\n])+)'));
  return m ? bo(m[1]) : '';
}

function thongTinTuDn(dn, soSeri) {
  return { cn: layThuocTinh(dn, 'CN'), to_chuc: layThuocTinh(dn, 'O'), so_seri: soSeri ? String(soSeri).toUpperCase() : '' };
}

function thongTinChungThu(der) {
  const c = new crypto.X509Certificate(der);
  return thongTinTuDn(c.subject, c.serialNumber);
}

/**
 * @param {{tuyChon:object, thongTin:{ho_ten?:string,to_chuc?:string,so_seri?:string,ly_do?:string,noi_ky?:string}, thoiGian?:string, tieuDe?:string}} p
 * @returns {string[]} dòng đầu là tiêu đề, dòng cuối là dịch vụ; ở giữa là các mục được bật và có giá trị
 */
function dungDong({ tuyChon, thongTin, thoiGian, tieuDe }) {
  const tc = { ...MAC_DINH, ...(tuyChon || {}) };
  const giaTri = { ...(thongTin || {}), thoi_gian: thoiGian };
  const dong = [tieuDe || TIEU_DE];
  for (const t of TRUONG) {
    const v = String(giaTri[t.khoa] || '').trim();
    if (tc[t.khoa] && v) dong.push(t.nhan + ': ' + v);
  }
  dong.push(DONG_CUOI);
  return dong;
}

/** Chiều cao tối thiểu (pt) của khung chứa đủ n dòng ở cỡ chữ tối thiểu. */
const caoToiThieu = (n) => 8 + n * GIAN_DONG * CO_TOI_THIEU;

/**
 * Kiểm ảnh chữ ký: PNG (không xen kẽ) hoặc JPEG, ≤ 1 MB, cạnh 20–4000 px, và pdfkit đọc được.
 * @returns {{mime:string, rong:number, cao:number}|{loi:string}}
 */
function kiemHinh(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { loi: 'Chưa có dữ liệu ảnh.' };
  if (buf.length > TOI_DA_HINH_BYTE) return { loi: 'Ảnh quá lớn. Tối đa 1 MB.' };
  let mime = null;
  if (buf.length > 33 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mime = 'image/png';
    if (buf[28] === 1) return { loi: 'Ảnh PNG dạng xen kẽ (interlaced) chưa dùng được. Hãy lưu lại thành PNG thường.' };
  } else if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    mime = 'image/jpeg';
  } else {
    return { loi: 'Chỉ nhận ảnh PNG hoặc JPEG.' };
  }
  let img;
  try {
    const PDFDocument = require('pdfkit');
    img = new PDFDocument().openImage(buf);
  } catch (_) {
    return { loi: 'Không đọc được ảnh này. Hãy dùng ảnh PNG (nền trong suốt) hoặc JPEG khác.' };
  }
  const rong = Number(img.width);
  const cao = Number(img.height);
  if (!(rong >= TOI_THIEU_HINH_PX && cao >= TOI_THIEU_HINH_PX)) return { loi: 'Ảnh quá nhỏ. Mỗi cạnh tối thiểu ' + TOI_THIEU_HINH_PX + ' điểm ảnh.' };
  if (rong > TOI_DA_HINH_PX || cao > TOI_DA_HINH_PX) return { loi: 'Ảnh quá lớn. Mỗi cạnh tối đa ' + TOI_DA_HINH_PX + ' điểm ảnh.' };
  return { mime, rong, cao };
}

/**
 * Vẽ khung chữ ký lên trang pdfkit (đã có font 'R' và 'B' đăng ký sẵn).
 * @param {object} doc pdfkit
 * @param {number[]} rect [x, y, rộng, cao], gốc trên-trái
 * @param {{dong:string[], hinh?:Buffer|null, trang?:number}} p
 */
function veKhung(doc, rect, { dong, hinh, trang }) {
  const [x, y, w, h] = rect;
  const n = Math.max(1, dong.length);
  const coCao = (h - 8) / (n * GIAN_DONG);
  if (coCao < CO_TOI_THIEU) {
    throw Object.assign(new Error('Khung chữ ký quá thấp để chứa các thông tin đã chọn. Hãy kéo cao khung hoặc bớt dòng thông tin.'), { maLoi: 'vi_tri' });
  }
  if (trang !== undefined) doc.switchToPage(trang);
  doc.save().lineWidth(0.8).rect(x, y, w, h).stroke('#1f4e79').restore();

  let xChu = x + 4;
  let rongChu = w - 8;
  if (hinh) {
    const rongAnh = w * 0.34;
    try {
      doc.image(hinh, x + 4, y + 4, { fit: [rongAnh, h - 8], align: 'center', valign: 'center' });
      xChu = x + 4 + rongAnh + 4;
      rongChu = w - 8 - rongAnh - 4;
    } catch (_) {
      /* ảnh hỏng: bỏ hình, vẫn ký bình thường */
    }
  }
  // Cỡ chữ: vừa chiều cao khung, và thu nhỏ thêm nếu dòng dài nhất vượt bề rộng (không nhỏ hơn mức tối thiểu).
  let dai = 0;
  dong.forEach((d, j) => { dai = Math.max(dai, doc.font(j === 0 ? 'B' : 'R').fontSize(10).widthOfString(d)); });
  const coRong = dai > 0 ? (10 * rongChu) / dai : CO_TOI_DA;
  const co = Math.max(CO_TOI_THIEU, Math.min(CO_TOI_DA, coCao, coRong));
  const dan = co * GIAN_DONG;
  doc.fillColor('#1f4e79');
  dong.forEach((d, j) => {
    doc.font(j === 0 ? 'B' : 'R').fontSize(co).text(d, xChu, y + 4 + j * dan, { width: rongChu, align: 'left', lineBreak: false, ellipsis: true });
  });
  doc.fillColor('#000000');
}

module.exports = {
  TIEU_DE, DONG_CUOI, TRUONG, MAC_DINH, CO_TOI_THIEU, GIAN_DONG,
  kiemTuyChon, thongTinChungThu, thongTinTuDn, dungDong, caoToiThieu, kiemHinh, veKhung, gioVietNam,
};
