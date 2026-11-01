'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — danh sách sinh viên của Viện do Trung tâm quản lý người học cung cấp (bảng nhm_sinh_vien).
 *
 * Mục đích: người ngoài Viện không thể giả làm sinh viên để vào module. Sinh viên không có email @sci.edu.vn nên:
 *   1. Quản lý module nhập danh sách (email, họ tên, hạn dùng) theo từng đợt.
 *   2. Với mỗi email, hệ thống TẠO SẴN một tài khoản vai trò `sinh_vien` CHƯA kích hoạt (mật khẩu rỗng).
 *   3. Sinh viên vào trang Đăng ký chính, nhập đúng email đó → nhận thư xác minh tới CHÍNH hộp thư → đặt mật khẩu
 *      → kích hoạt tài khoản (luồng sẵn có của services/xacMinhEmail.js). Không có xác minh hộp thư thì không có tài khoản.
 *   4. Đến hạn (`het_han`), quyền vào module này bị khóa (tài khoản vẫn dùng được Đặt lịch thiết bị).
 *
 * Danh sách chỉ chứa dữ liệu cần thiết, chỉ Admin / quản lý module xem, và dòng đã hết hạn lâu thì bị xóa (HAN_GIU_NGAY).
 */

const HAN_GIU_NGAY = 365; // dòng hết hạn / đã thu hồi được giữ thêm chừng này ngày rồi xóa
const TOI_DA_DONG = 2000;

/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD): hạn dùng tính hết NGÀY ghi trên danh sách. */
function homNay(ms = Date.now()) {
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function chuanHoaEmail(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

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

/**
 * Đọc danh sách dán từ Excel / CSV. Mỗi dòng: email, họ tên, [mã sinh viên], [khóa / đợt], [hạn dùng].
 * Tách bằng TAB, dấu phẩy hoặc chấm phẩy. Dòng tiêu đề (ô đầu không có @) bị bỏ qua.
 * @returns {{rows: object[], loi: {dong:number,message:string}[]}}
 */
function docDanhSach(text, hanMacDinh) {
  const rows = [];
  const loi = [];
  const dong = String(text == null ? '' : text).split(/\r?\n/);
  let stt = 0;
  for (const raw of dong) {
    stt++;
    if (!raw.trim()) continue;
    const o = raw.split(/\t|;|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim().replace(/^"|"$/g, ''));
    if (stt === 1 && !String(o[0]).includes('@')) continue; // tiêu đề
    if (rows.length + loi.length >= TOI_DA_DONG) {
      loi.push({ dong: stt, message: `Danh sách quá dài (tối đa ${TOI_DA_DONG} dòng mỗi lần nhập).` });
      break;
    }
    const email = chuanHoaEmail(o[0]);
    const hoTen = String(o[1] || '').replace(/\s+/g, ' ').trim();
    if (!EMAIL_RE.test(email) || email.length > 190) { loi.push({ dong: stt, message: 'Email không hợp lệ.' }); continue; }
    if (hoTen.length < 2 || hoTen.length > 150) { loi.push({ dong: stt, message: 'Họ tên phải từ 2 đến 150 ký tự.' }); continue; }
    const hetHan = chuanHoaNgay(o[4] || hanMacDinh);
    if (!hetHan) { loi.push({ dong: stt, message: 'Thiếu hoặc sai hạn dùng (định dạng YYYY-MM-DD hoặc DD/MM/YYYY).' }); continue; }
    rows.push({ dong: stt, email, fullname: hoTen, ma_sv: String(o[2] || '').trim().slice(0, 40) || null, khoa: String(o[3] || '').trim().slice(0, 60) || null, het_han: hetHan });
  }
  return { rows, loi };
}

module.exports = { HAN_GIU_NGAY, TOI_DA_DONG, homNay, chuanHoaEmail, chuanHoaNgay, conHieuLuc, timTheoEmail, emailDuocDangKy, docDanhSach, EMAIL_RE };
