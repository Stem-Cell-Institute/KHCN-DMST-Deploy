'use strict';

/**
 * Đặt lịch thiết bị CRD — đăng ký tài khoản công khai cho sinh viên và khách ngoài Viện (email KHÔNG
 * phải @sci.edu.vn). 1 endpoint, KHÔNG qua authMiddleware: cấp token và cookie đăng nhập với vai trò
 * crd_user ngay sau khi đăng ký.
 *
 * Tách khỏi server.js (Đợt 2.1 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi. Không sửa một
 * dòng logic nào — chỉ đổi `app.` thành `router.` và bỏ tiền tố `/api` ở dòng khai báo (router được
 * mount ở '/api').
 *
 * Tách riêng thành một router (không gộp vào nguoiDung.js) vì nó nằm ở một chỗ KHÁC trong server.js,
 * gần nhóm đăng ký/đăng nhập chính, và giữ nguyên vị trí mount là quy tắc của kế hoạch.
 *
 * Lưới an toàn: tests/crd.test.js (các test "đăng ký công khai").
 */

const express = require('express');

module.exports = function createCrdDangKyCongKhaiRouter({
  ALLOWED_EMAIL_DOMAIN,
  CRD_ONLY_USER_ROLE,
  bcrypt,
  db,
  jwt,
  JWT_SECRET,
  setAuthCookie,
}) {
const router = express.Router();
// Đăng ký chỉ phục vụ module Đặt lịch CRD — chấp nhận mọi email NGOẠI TRỪ @sci.edu.vn (nhân sự Viện dùng /api/register + dang-ky.html)
router.post('/crd/public/register', async (req, res) => {
  const { email, password, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const fn = (fullname || '').trim();
  if (em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({
      message:
        'Email @sci.edu.vn đăng ký tài khoản đầy đủ tại trang Đăng ký chính (dang-ky.html). Trang đăng ký CRD dành cho sinh viên và khách ngoài Viện đặt lịch thiết bị.',
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em) || em.length > 190) {
    return res.status(400).json({ message: 'Email không hợp lệ.' });
  }
  if (!fn || fn.length < 2) {
    return res.status(400).json({ message: 'Vui lòng nhập họ và tên (ít nhất 2 ký tự).' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu ít nhất 6 ký tự' });
  }
  if (password.length > 128) {
    return res.status(400).json({ message: 'Mật khẩu quá dài (tối đa 128 ký tự).' });
  }
  const role = CRD_ONLY_USER_ROLE;
  let hash;
  try {
    hash = await bcrypt.hash(password, 10);
  } catch (e) {
    return res.status(500).json({ message: 'Không thể tạo tài khoản. Vui lòng thử lại.' });
  }
  try {
    const ins = db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(em, hash, fn, role);
    const user = { id: Number(ins.lastInsertRowid), email: em, fullname: fn, role };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    return res.status(201).json({ message: 'Đăng ký thành công', token, user });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ message: 'Email này đã được sử dụng. Hãy đăng nhập hoặc dùng email khác.' });
    }
    throw e;
  }
});

return router;
};
