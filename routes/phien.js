/**
 * Khôi phục phiên đăng nhập từ token đang lưu trong trình duyệt (localStorage).
 *
 * Vì sao cần: trang chủ (index.html) là trang công khai và chỉ đọc localStorage để hiện "Xin chào …", còn mọi trang module (.html) do
 * máy chủ kiểm bằng COOKIE auth_token trước khi trả về. Cookie có thể mất (trình duyệt đặt "xóa cookie khi đóng", dọn dẹp, hết 7 ngày)
 * trong khi localStorage vẫn còn: người dùng thấy mình "đã đăng nhập" ở trang chủ nhưng vào module nào cũng bị hỏi lại mật khẩu.
 * Endpoint này cấp lại cookie từ token còn hợp lệ, nên không phải gõ lại mật khẩu.
 *
 * Gia hạn trượt: nếu token còn dưới NGUONG_GIA_HAN_GIAY thì cấp token mới 7 ngày (trả về để trình duyệt cập nhật localStorage).
 * Ai dùng hệ thống ít nhất một lần trong 7 ngày thì không phải đăng nhập lại; bỏ quá 7 ngày thì phải đăng nhập như cũ.
 *
 * An toàn: chỉ nhận token trong header Authorization (JS cùng nguồn mới đặt được; trang ngoài không đặt được nếu không qua CORS),
 * không nhận cookie; token hỏng/hết hạn/tài khoản bị khóa hoặc đã xóa thì từ chối và KHÔNG cấp cookie.
 */

const express = require('express');

const HAN_TOKEN = '7d';
const NGUONG_GIA_HAN_GIAY = 4 * 24 * 3600;

/**
 * @param {{jwt:object, JWT_SECRET:string, db:object, setAuthCookie:(res:object, token:string)=>void,
 *          userIdIsBanned:(id:number)=>boolean, userEmailIsMasterAdmin:(email:string)=>boolean, now?:()=>number}} deps
 */
module.exports = function createPhienRouter({ jwt, JWT_SECRET, db, setAuthCookie, userIdIsBanned, userEmailIsMasterAdmin, now }) {
  const router = express.Router();
  const gio = now || (() => Math.floor(Date.now() / 1000));

  router.post('/khoi-phuc', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return res.status(401).json({ message: 'Chưa đăng nhập.' });
    const token = h.slice(7).trim();
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (_) {
      return res.status(401).json({ message: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
    }
    if (userIdIsBanned(payload.id)) return res.status(403).json({ message: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.' });
    const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(payload.id);
    if (!row) return res.status(401).json({ message: 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.' });

    // Thông tin người dùng lấy từ DB (không tin payload cũ): đổi vai trò/họ tên có hiệu lực ngay khi khôi phục.
    const user = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
    if ((user.role || '').toLowerCase() === 'admin') user.isMasterAdmin = userEmailIsMasterAdmin(user.email);

    let tokenDung = token;
    let giaHan = false;
    if (!(payload.exp - gio() > NGUONG_GIA_HAN_GIAY)) {
      tokenDung = jwt.sign(user, JWT_SECRET, { expiresIn: HAN_TOKEN });
      giaHan = true;
    }
    setAuthCookie(res, tokenDung);
    res.json({ ok: true, token: tokenDung, user, gia_han: giaHan });
  });

  return router;
};

module.exports.NGUONG_GIA_HAN_GIAY = NGUONG_GIA_HAN_GIAY;
