'use strict';

/**
 * Quản trị tài khoản & Nhật ký hoạt động (5 endpoint).
 *
 *   GET  /api/admin/users
 *   GET  /api/admin/activity-log
 *   POST /api/admin/users
 *   POST /api/admin/reset-user-password
 *   POST /api/admin/users/send-role-email
 *
 * Tách khỏi server.js (Đợt 6.2a của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = function createAdminUsersVaNhatKyRouter({
  db,
  authMiddleware,
  adminOnly,
  userHasLoginPassword,
  userEmailIsMasterAdmin,
  reqIsMasterAdmin,
  isSafeEmailFormat,
  ALLOWED_EMAIL_DOMAIN,
  BUDGET_TEAM_ROLES,
  ROLE_LABELS,
  sendRoleAssignmentEmail,
  transporter,
}) {
  const router = express.Router();

  // Admin: danh sách user (không trả hash password; có cờ activated)
  router.get('/admin/users', authMiddleware, adminOnly, (req, res) => {
    const rows = db.prepare(
      'SELECT id, email, fullname, role, academicTitle, createdAt, COALESCE(is_banned, 0) AS is_banned, password FROM users ORDER BY createdAt DESC'
    ).all();
    const users = rows.map((r) => {
      const activated = userHasLoginPassword(r.password);
      const roleLower = (r.role || '').toLowerCase();
      return {
        id: r.id,
        email: r.email,
        fullname: r.fullname,
        role: r.role,
        academicTitle: r.academicTitle,
        createdAt: r.createdAt,
        is_banned: r.is_banned,
        activated,
        isMasterAdminAccount: roleLower === 'admin' && userEmailIsMasterAdmin(r.email),
      };
    });
    return res.json({ users });
  });

  // Admin: nhật ký đăng nhập / truy cập / hành động (bảng user_activity_log)
  router.get('/admin/activity-log', authMiddleware, adminOnly, (req, res) => {
    const q = req.query || {};
    const limit = Math.min(Math.max(parseInt(String(q.limit || '100'), 10) || 100, 1), 500);
    const offset = Math.max(parseInt(String(q.offset || '0'), 10) || 0, 0);
    const from = q.from ? String(q.from).trim() : '';
    const to = q.to ? String(q.to).trim() : '';
    const emailFilter = q.email ? String(q.email).trim().toLowerCase() : '';
    const actionFilter = q.action ? String(q.action).trim() : '';
    const moduleFilter = q.module ? String(q.module).trim() : '';

    const conds = [];
    const params = [];
    if (from) {
      conds.push('l.created_at >= ?');
      params.push(/^\d{4}-\d{2}-\d{2}$/.test(from) ? from + ' 00:00:00' : from);
    }
    if (to) {
      const toVal = /^\d{4}-\d{2}-\d{2}$/.test(to) ? to + ' 23:59:59' : to;
      conds.push('l.created_at <= ?');
      params.push(toVal);
    }
    if (emailFilter) {
      const safe = emailFilter.replace(/%/g, '').replace(/_/g, '');
      conds.push('LOWER(TRIM(COALESCE(l.email, ""))) LIKE ?');
      params.push('%' + safe + '%');
    }
    if (actionFilter) {
      conds.push('l.action = ?');
      params.push(actionFilter);
    }
    if (moduleFilter) {
      conds.push('l.module = ?');
      params.push(moduleFilter);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const rows = db
      .prepare(
        `SELECT l.id, l.user_id, l.email, l.action, l.module, l.path, l.detail, l.ip_address, l.user_agent, l.created_at,
                u.fullname AS fullname
         FROM user_activity_log l
         LEFT JOIN users u ON u.id = l.user_id
         ${where}
         ORDER BY l.id DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    const countRow = db.prepare(`SELECT COUNT(1) AS c FROM user_activity_log l ${where}`).get(...params);
    const total = countRow && typeof countRow.c === 'number' ? countRow.c : 0;

    return res.json({ rows, total, limit, offset });
  });

  // Admin: thêm tài khoản mới hoặc cập nhật họ tên + vai trò
  router.post('/admin/users', authMiddleware, adminOnly, async (req, res) => {
    const { email, fullname, role, password, academicTitle } = req.body || {};
    const em = (email || '').trim().toLowerCase();
    if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
    if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email không hợp lệ.' });
    const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
    const r = (role || 'researcher').toLowerCase().trim();
    const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
    if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trò không hợp lệ. Vui lòng khởi động lại server (node server.js) và thử lại.' });
    if (councilRoles.includes(r) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
      return res.status(400).json({ message: 'Chỉ email @sci.edu.vn mới được gán vai trò Chủ tịch, Thư ký, Thành viên Hội đồng' });
    }
    if (councilRoles.includes(r) && !reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được cấp vai trò thành viên Hội đồng KHCN.' });
    }
    if (BUDGET_TEAM_ROLES.includes(r) && !reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được cấp vai trò Tổ thẩm định tài chính.' });
    }
    const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
    const acadTitle = (academicTitle || '').trim() || null;
    const oldRole = existing ? (existing.role || '').toLowerCase() : '';
    const promotingToAdmin = r === 'admin' && oldRole !== 'admin';
    const demotingFromAdmin = oldRole === 'admin' && r !== 'admin';
    if (promotingToAdmin && !reqIsMasterAdmin(req)) {
      return res.status(403).json({
        message: 'Chỉ Master Admin mới được thêm tài khoản mới với vai trò Admin hoặc nâng user lên Admin.',
      });
    }
    if (demotingFromAdmin && !reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được gỡ quyền Admin khỏi tài khoản.' });
    }
    if (demotingFromAdmin && userEmailIsMasterAdmin(em)) {
      return res.status(400).json({ message: 'Không thể gỡ quyền Master Admin hệ thống.' });
    }
    if (existing) {
      db.prepare('UPDATE users SET fullname = ?, role = ?, academicTitle = ? WHERE email = ?').run((fullname || '').trim(), r, acadTitle, em);
      return res.json({ message: 'Đã cập nhật họ tên và vai trò cho ' + em });
    }
    const plainPassword = (password || '').trim();
    if (plainPassword.length > 0 && plainPassword.length < 6) {
      return res.status(400).json({
        message:
          'Mật khẩu tối thiểu 6 ký tự, hoặc để trống để tạo tài khoản chưa kích hoạt (user tự đặt mật khẩu qua trang Đăng ký @sci.edu.vn).',
      });
    }
    if (plainPassword.length >= 6) {
      const hash = await bcrypt.hash(plainPassword, 10);
      db.prepare('INSERT INTO users (email, password, fullname, role, academicTitle) VALUES (?, ?, ?, ?, ?)').run(
        em,
        hash,
        (fullname || '').trim(),
        r,
        acadTitle
      );
      return res.status(201).json({ message: 'Đã thêm tài khoản với mật khẩu do bạn đặt.', activated: true });
    }
    db.prepare('INSERT INTO users (email, password, fullname, role, academicTitle) VALUES (?, ?, ?, ?, ?)').run(
      em,
      '',
      (fullname || '').trim(),
      r,
      acadTitle
    );
    return res.status(201).json({
      message:
        'Đã thêm tài khoản. Người dùng cần vào trang Đăng ký (@sci.edu.vn) để đặt mật khẩu và kích hoạt.',
      activated: false,
    });
  });

  // Admin: đưa tài khoản về chưa kích hoạt (xóa mật khẩu đăng nhập; không áp dụng Admin)
  router.post('/admin/reset-user-password', authMiddleware, adminOnly, (req, res) => {
    const userId = parseInt(req.body && req.body.userId, 10);
    if (!userId || Number.isNaN(userId)) {
      return res.status(400).json({ message: 'userId không hợp lệ' });
    }
    const row = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
    if (!row) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }
    if ((row.role || '').toLowerCase() === 'admin') {
      return res.status(400).json({ message: 'Không thể reset mật khẩu tài khoản Admin' });
    }
    if (Number(row.id) === Number(req.user.id)) {
      return res.status(400).json({ message: 'Không thể reset chính tài khoản đang đăng nhập' });
    }
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run('', userId);
    return res.json({
      message: 'Đã reset. User cần đăng ký lại (trang Đăng ký @sci.edu.vn) để đặt mật khẩu mới.',
    });
  });

  // Admin: gửi email thông báo cấp vai trò tới địa chỉ email
  router.post('/admin/users/send-role-email', authMiddleware, adminOnly, async (req, res) => {
    const { email, fullname, role, tempPassword } = req.body || {};
    const em = (email || '').trim().toLowerCase();
    if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
    const roleLabel = ROLE_LABELS[role] || role;
    let fullnameToUse = (fullname || '').trim();
    if (!fullnameToUse) {
      const row = db.prepare('SELECT fullname FROM users WHERE email = ?').get(em);
      if (row && row.fullname) fullnameToUse = row.fullname;
    }
    await sendRoleAssignmentEmail(em, fullnameToUse, role || 'researcher', tempPassword || null);
    if (!transporter) {
      return res.status(503).json({ message: 'Chưa cấu hình SMTP. Không thể gửi email. Xem README_BACKEND.md.' });
    }
    return res.json({ message: 'Đã gửi email thông báo đến ' + em });
  });

  // Admin: danh sách người nhận email thông báo
  router.get('/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
    try {
      const rows = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients ORDER BY id').all();
      return res.json({ recipients: rows || [] });
    } catch (e) {
      return res.json({ recipients: [] });
    }
  });

  return router;
};
