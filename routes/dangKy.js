/**
 * Đăng ký tài khoản có xác minh email — xem services/xacMinhEmail.js.
 *
 * Gắn tại /api/register (đúng vị trí handler cũ trong server.js):
 *   POST /api/register            gửi thư xác minh (KHÔNG tạo tài khoản, KHÔNG đăng nhập)
 *   POST /api/register/kiem-tra   liên kết còn dùng được không
 *   POST /api/register/hoan-tat   đặt mật khẩu → tạo / kích hoạt tài khoản → đăng nhập
 */
const express = require('express');
const rateLimitLib = require('express-rate-limit');
const { taoBang, taoXacMinhEmail } = require('../services/xacMinhEmail');

const rateLimit = rateLimitLib.rateLimit || rateLimitLib;

const THONG_BAO_DA_GUI =
  'Nếu email hợp lệ, hệ thống đã gửi thư xác minh tới hộp thư đó (hiệu lực 2 giờ). Hãy mở thư và nhấn vào liên kết để đặt mật khẩu. ' +
  'Nếu bạn đã có tài khoản, hãy đăng nhập hoặc dùng "Quên mật khẩu".';

/**
 * @param {{db:object, mailSend:null|Function, baseUrl:string, bcrypt:object, jwt:object, JWT_SECRET:string,
 *   setAuthCookie:Function, userEmailIsMasterAdmin:Function, isSafeEmailFormat:Function, allowedDomain:string,
 *   gioiHanGuiThu?:{windowMs:number,max:number}}} deps
 */
function createDangKyRouter(deps) {
  const { db, jwt, JWT_SECRET, setAuthCookie, userEmailIsMasterAdmin, isSafeEmailFormat, allowedDomain } = deps;
  taoBang(db);
  const xm = taoXacMinhEmail({ db, mailSend: deps.mailSend, baseUrl: deps.baseUrl, bcrypt: deps.bcrypt });
  const router = express.Router();

  const gh = deps.gioiHanGuiThu || { windowMs: 3600 * 1000, max: 20 };
  const gioiHanIp = rateLimit({
    windowMs: gh.windowMs,
    max: gh.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Quá nhiều yêu cầu đăng ký từ địa chỉ này, vui lòng thử lại sau.' },
  });

  const baoLoi = (res, e) => {
    if (e && e.status) return res.status(e.status).json({ message: e.message });
    console.error('[dang-ky]', e);
    return res.status(500).json({ message: 'Có lỗi xảy ra. Vui lòng thử lại.' });
  };

  router.post('/', gioiHanIp, async (req, res) => {
    const { email, fullname } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    const fn = String(fullname || '').trim();
    // Cố ý bỏ qua `password` nếu trình duyệt cũ còn gửi: mật khẩu chỉ được đặt SAU khi xác minh.
    if (!em || !fn) return res.status(400).json({ message: 'Vui lòng điền đầy đủ thông tin' });
    if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email không hợp lệ.' });
    if (!em.endsWith(allowedDomain)) return res.status(400).json({ message: 'Chỉ chấp nhận email có đuôi ' + allowedDomain });
    if (fn.length < 2) return res.status(400).json({ message: 'Vui lòng nhập họ và tên (ít nhất 2 ký tự).' });
    if (fn.length > 150) return res.status(400).json({ message: 'Họ và tên quá dài (tối đa 150 ký tự).' });
    try {
      await xm.yeuCau(em, fn);
      // Cùng một thông báo dù có gửi thư hay không: không cho dò xem email nào đã có tài khoản.
      return res.status(202).json({ message: THONG_BAO_DA_GUI, daGuiThu: true });
    } catch (e) {
      return baoLoi(res, e);
    }
  });

  router.post('/kiem-tra', (req, res) => {
    const r = xm.kiemTra(req.body && req.body.token);
    if (!r) return res.status(400).json({ message: 'Liên kết xác minh không đúng, đã được dùng hoặc đã hết hạn. Vui lòng đăng ký lại để nhận thư mới.' });
    return res.json(r);
  });

  router.post('/hoan-tat', async (req, res) => {
    const { token, password } = req.body || {};
    try {
      const { user, kichHoat } = await xm.hoanTat(token, password);
      if ((user.role || '').toLowerCase() === 'admin') user.isMasterAdmin = userEmailIsMasterAdmin(user.email);
      const jwtToken = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
      setAuthCookie(res, jwtToken);
      return res.status(kichHoat ? 200 : 201).json(
        kichHoat
          ? { message: 'Kích hoạt tài khoản thành công! Chào mừng bạn.', token: jwtToken, user, activated: true }
          : { message: 'Đăng ký thành công', token: jwtToken, user }
      );
    } catch (e) {
      return baoLoi(res, e);
    }
  });

  return router;
}

module.exports = createDangKyRouter;
