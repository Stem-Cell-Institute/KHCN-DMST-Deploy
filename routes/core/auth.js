/**
 * Route đăng nhập, đăng xuất và ghi nhận hoạt động (/api/login, /api/logout, /api/activity/track).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../lib/db-bridge');

module.exports = function mountCoreAuthRoutes({
  JWT_SECRET,
  app,
  authMiddleware,
  clearAuthCookie,
  getTokenFromReq,
  insertUserActivityLog,
  setAuthCookie,
  userEmailIsMasterAdmin,
  userHasLoginPassword,
}) {
  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof password !== 'string' || !password || password.length > 128) {
      return res.status(400).json({ message: 'Mật khẩu không hợp lệ' });
    }
    const em = (email || '').trim().toLowerCase();
    const row = db.prepare('SELECT id, email, password, fullname, role, COALESCE(is_banned, 0) AS is_banned FROM users WHERE email = ?').get(em);
    if (!row) {
      insertUserActivityLog(req, {
        userId: null,
        email: em || null,
        action: 'login_failed',
        module: 'auth',
        path: '/api/login',
        detail: 'unknown_email',
      });
      return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
    }
    if (Number(row.is_banned) === 1) {
      insertUserActivityLog(req, {
        userId: row.id,
        email: row.email,
        action: 'login_failed',
        module: 'auth',
        path: '/api/login',
        detail: 'account_banned',
      });
      return res.status(403).json({ message: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.' });
    }
    if (!userHasLoginPassword(row.password)) {
      insertUserActivityLog(req, {
        userId: row.id,
        email: row.email,
        action: 'login_failed',
        module: 'auth',
        path: '/api/login',
        detail: 'not_activated',
      });
      return res.status(401).json({
        message:
          'Tài khoản chưa kích hoạt. Vui lòng mở trang Đăng ký, nhập cùng email @sci.edu.vn và đặt mật khẩu lần đầu.',
      });
    }
    const ok = await bcrypt.compare(password, row.password);
    if (!ok) {
      insertUserActivityLog(req, {
        userId: row.id,
        email: row.email,
        action: 'login_failed',
        module: 'auth',
        path: '/api/login',
        detail: 'wrong_password',
      });
      return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
    }
    const user = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
    if ((user.role || '').toLowerCase() === 'admin') {
      user.isMasterAdmin = userEmailIsMasterAdmin(user.email);
    }
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    insertUserActivityLog(req, {
      userId: row.id,
      email: row.email,
      action: 'login',
      module: 'auth',
      path: '/api/login',
    });
    return res.json({ token, user });
  });

  app.post('/api/logout', (req, res) => {
    try {
      const token = getTokenFromReq(req);
      if (token) {
        try {
          const p = jwt.verify(token, JWT_SECRET);
          insertUserActivityLog(req, {
            userId: p.id,
            email: p.email,
            action: 'logout',
            module: 'auth',
            path: '/api/logout',
          });
        } catch (_) {
          /* token hết hạn — không ghi logout */
        }
      }
    } catch (_) {}
    clearAuthCookie(res);
    return res.json({ ok: true });
  });

  // Client ghi nhận mở trang / hành động (đã đăng nhập). Module CRD-only cũng được phép (whitelist API).
  app.post('/api/activity/track', authMiddleware, (req, res) => {
    const b = req.body || {};
    const action = String(b.action || 'page_view').slice(0, 120);
    const moduleName = b.module != null ? String(b.module).slice(0, 120) : '';
    const pathStr = b.path != null ? String(b.path).slice(0, 500) : '';
    const detail = b.detail != null ? String(b.detail).slice(0, 2000) : null;
    if (!moduleName.trim() && !pathStr.trim()) {
      return res.status(400).json({ message: 'Cần ít nhất module hoặc path' });
    }
    insertUserActivityLog(req, {
      userId: req.user.id,
      email: req.user.email,
      action,
      module: moduleName.trim() || null,
      path: pathStr.trim() || null,
      detail,
    });
    return res.json({ ok: true });
  });
};
