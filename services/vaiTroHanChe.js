'use strict';

/**
 * Các vai trò tài khoản CHỈ được dùng một số module (không vào Nhiệm vụ KHCN, Hội đồng đạo đức...). Một chỗ duy nhất cho
 * authMiddleware (chặn API) và cổng .html (chuyển trang) trong server.js.
 *
 *   crd_user   khách / sinh viên tự đăng ký ở module Đặt lịch thiết bị: chỉ Đặt lịch
 *   sinh_vien  sinh viên của Viện có tên trong danh sách chờ (xác minh hộp thư): Đặt lịch + Ngân hàng tế bào & Kháng thể
 *
 * Giữ NGUYÊN hành vi cũ của crd_user (có test canh trong tests/crd.test.js).
 */

const CRD_HTML = ['crd-booking-v2.html', 'crd-dang-ky.html', 'dang-nhap.html', 'quen-mat-khau.html', 'dat-lai-mat-khau.html'];
const API_CHUNG = ['/api/me', '/api/logout', '/api/activity/track', '/api/health'];

const VAI_TRO = {
  crd_user: {
    apiTien: ['/api/crd/'],
    html: CRD_HTML,
    htmlTrungGian: (p) => p.includes('/public/equipment/public.html'),
    trangMacDinh: '/crd-booking-v2.html',
    thongBao:
      'Tài khoản này chỉ dùng cho module Đặt lịch thiết bị CRD. Để dùng Nhiệm vụ KHCN, Hội đồng đạo đức, v.v., vui lòng đăng ký/đăng nhập bằng email @sci.edu.vn trên trang chính.',
  },
  sinh_vien: {
    apiTien: ['/api/crd/', '/api/ngan-hang-te-bao-khang-the/'],
    html: CRD_HTML,
    htmlTrungGian: (p) => p === '/index.html' || p.includes('/public/equipment/public.html') || p.includes('/public/ngan-hang-te-bao-khang-the/'),
    trangMacDinh: '/public/ngan-hang-te-bao-khang-the/index.html',
    thongBao:
      'Tài khoản sinh viên chỉ dùng cho module Đặt lịch thiết bị CRD và Ngân hàng tế bào & Kháng thể. Các module khác dành cho cán bộ có email @sci.edu.vn.',
  },
};

const chuanHoa = (role) => String(role || '').toLowerCase();

function coHanChe(role) {
  return Object.prototype.hasOwnProperty.call(VAI_TRO, chuanHoa(role));
}

/** API này có bị chặn cho vai trò đó không? Trả câu thông báo 403 hoặc null (được phép / vai trò không bị hạn chế). */
function kiemTraApi(role, urlPath) {
  const v = VAI_TRO[chuanHoa(role)];
  if (!v) return null;
  const p = String(urlPath || '').split('?')[0];
  if (v.apiTien.some((t) => p.startsWith(t))) return null;
  if (API_CHUNG.includes(p)) return null;
  if (p.startsWith('/api/pub-analytics')) return null;
  if (p.startsWith('/api/dashboard-perms/') && p.endsWith('/check')) return null;
  return v.thongBao;
}

/** Trang .html này có mở được cho vai trò đó không? */
function trangHtmlDuocPhep(role, reqPath) {
  const v = VAI_TRO[chuanHoa(role)];
  if (!v) return true;
  const p = String(reqPath || '').replace(/\\/g, '/');
  const base = p.split('/').pop();
  return v.html.includes(base) || v.htmlTrungGian(p);
}

function trangMacDinh(role) {
  const v = VAI_TRO[chuanHoa(role)];
  return v ? v.trangMacDinh : '/';
}

module.exports = { coHanChe, kiemTraApi, trangHtmlDuocPhep, trangMacDinh };
