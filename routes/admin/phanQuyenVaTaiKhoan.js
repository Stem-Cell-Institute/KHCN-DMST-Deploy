'use strict';

/**
 * Quản trị phân quyền, Hội đồng KHCN, Tổ thẩm định TC & mật khẩu/trạng thái tài khoản (10 endpoint).
 *
 *   PUT    /api/admin/users/role
 *   GET    /api/admin/council-role-grants
 *   PUT    /api/admin/council-role-grants/:userId
 *   GET    /api/admin/budget-appraisal-team
 *   PUT    /api/admin/budget-appraisal-team
 *   DELETE /api/admin/budget-appraisal-team/:email
 *   PUT    /api/admin/users/:email/password
 *   PUT    /api/admin/users/:email/banned
 *   DELETE /api/admin/users/:email
 *   DELETE /api/admin/council-members/:email
 *
 * Tách khỏi server.js (Đợt 6.2b của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

module.exports = function createAdminPhanQuyenVaTaiKhoanRouter({
  db,
  authMiddleware,
  adminOnly,
  masterAdminOnly,
  reqIsMasterAdmin,
  userEmailIsMasterAdmin,
  ALLOWED_EMAIL_DOMAIN,
  BUDGET_TEAM_ROLES,
  COUNCIL_ROLE_TOKENS,
}) {
  const router = express.Router();

  // Admin: cập nhật vai trò. Cấp / gỡ vai trò Admin chỉ Master Admin; không gỡ được Master.
  router.put('/admin/users/role', authMiddleware, adminOnly, (req, res) => {
    const { email, role } = req.body || {};
    const em = (email || '').trim().toLowerCase();
    const currentEmail = (req.user.email || '').toLowerCase();
    if (em === currentEmail && role !== 'admin') {
      return res.status(400).json({ message: 'Bạn không thể tự hạ vai trò của chính mình' });
    }
    const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
    if (!allowed.includes(role)) {
      return res.status(400).json({ message: 'Vai trò không hợp lệ' });
    }
    const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
    const targetRow = db.prepare('SELECT role FROM users WHERE email = ?').get(em);
    if (!targetRow) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }
    const prevRole = (targetRow.role || '').toLowerCase();
    const newRole = (role || '').toLowerCase();
    if ((councilRoles.includes(prevRole) || councilRoles.includes(newRole)) && !reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được sửa vai trò thành viên Hội đồng KHCN.' });
    }
    if ((BUDGET_TEAM_ROLES.includes(prevRole) || BUDGET_TEAM_ROLES.includes(newRole)) && !reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được sửa vai trò Tổ thẩm định tài chính.' });
    }
    if (newRole === 'admin' && prevRole !== 'admin' && !reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được cấp vai trò Admin.' });
    }
    if (prevRole === 'admin' && newRole !== 'admin') {
      if (!reqIsMasterAdmin(req)) {
        return res.status(403).json({ message: 'Chỉ Master Admin mới được gỡ quyền Admin.' });
      }
      if (userEmailIsMasterAdmin(em)) {
        return res.status(400).json({ message: 'Không thể gỡ quyền Master Admin hệ thống.' });
      }
    }
    if (councilRoles.includes(role) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
      return res.status(400).json({ message: 'Chỉ tài khoản có đuôi @sci.edu.vn mới được gán vai trò Chủ tịch, Thư ký, Thành viên Hội đồng' });
    }
    const r = db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, em);
    if (r.changes === 0) {
      return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    }
    return res.json({ message: 'Đã cập nhật vai trò' });
  });

  // Admin: xem vai trò HĐKHCN "phụ" (council_role_grants)
  router.get('/admin/council-role-grants', authMiddleware, adminOnly, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT g.id, g.user_id, g.role, g.granted_at, u.email, u.fullname, u.role AS system_role
           FROM council_role_grants g JOIN users u ON u.id = g.user_id
           ORDER BY u.fullname, u.email, g.role`
        )
        .all();
      return res.json({ ok: true, data: rows });
    } catch (e) {
      return res.status(500).json({ message: 'Không tải được danh sách.' });
    }
  });

  // Admin: thay toàn bộ tập vai trò HĐKHCN phụ của 1 user
  router.put('/admin/council-role-grants/:userId', authMiddleware, adminOnly, (req, res) => {
    if (!reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được cấp vai trò Hội đồng KHCN.' });
    }
    const userId = parseInt(req.params.userId, 10);
    if (!userId) return res.status(400).json({ message: 'userId không hợp lệ' });
    const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const em = String(user.email || '').trim().toLowerCase();
    if (!em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
      return res.status(400).json({ message: 'Chỉ tài khoản có đuôi @sci.edu.vn mới được gán vai trò Hội đồng KHCN' });
    }
    const requested = Array.isArray(req.body && req.body.roles) ? req.body.roles : [];
    const roles = Array.from(
      new Set(requested.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean))
    );
    const invalid = roles.filter((r) => !COUNCIL_ROLE_TOKENS.includes(r));
    if (invalid.length) {
      return res.status(400).json({ message: 'Vai trò không hợp lệ: ' + invalid.join(', ') });
    }
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM council_role_grants WHERE user_id = ?').run(userId);
      const ins = db.prepare(
        'INSERT INTO council_role_grants (user_id, role, granted_by_id) VALUES (?, ?, ?)'
      );
      roles.forEach((r) => ins.run(userId, r, req.user.id || null));
    });
    tx();
    return res.json({ ok: true, roles });
  });

  // Admin: danh sách Tổ thẩm định tài chính
  router.get('/admin/budget-appraisal-team', authMiddleware, adminOnly, (req, res) => {
    const rows = db
      .prepare(
        `SELECT DISTINCT u.id, u.email, u.fullname, u.academicTitle, u.role, u.createdAt FROM users u
         LEFT JOIN council_role_grants g ON g.user_id = u.id
         WHERE u.role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc')
            OR g.role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc')
         ORDER BY u.role, u.fullname, u.email`
      )
      .all();
    return res.json({ members: rows });
  });

  // Admin: cập nhật thành viên Tổ thẩm định tài chính — chỉ Master Admin
  router.put('/admin/budget-appraisal-team', authMiddleware, adminOnly, masterAdminOnly, (req, res) => {
    const { email, fullname, academicTitle, role } = req.body || {};
    const em = (email || '').trim().toLowerCase();
    if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
    const allowed = ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
    const r = (role || '').toLowerCase();
    if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trò phải là Tổ trưởng hoặc Thành viên Tổ thẩm định TC' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
    if (!existing) return res.status(404).json({ message: 'Không tìm thấy tài khoản. Thêm qua form bên trên trước.' });
    db.prepare('UPDATE users SET fullname = ?, academicTitle = ?, role = ? WHERE email = ?')
      .run((fullname || '').trim(), (academicTitle || '').trim() || null, r, em);
    return res.json({ message: 'Đã cập nhật thông tin thành viên Tổ thẩm định tài chính.' });
  });

  // Admin: xóa thành viên khỏi Tổ thẩm định tài chính — chỉ Master Admin
  router.delete('/admin/budget-appraisal-team/:email', authMiddleware, adminOnly, masterAdminOnly, (req, res) => {
    const em = decodeURIComponent(req.params.email || '').trim().toLowerCase();
    if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
    const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    if (!['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(row.role)) {
      return res.status(400).json({ message: 'Người này không phải thành viên Tổ thẩm định tài chính' });
    }
    db.prepare('UPDATE users SET role = ?, academicTitle = NULL WHERE email = ?').run('researcher', em);
    return res.json({ message: 'Đã xóa khỏi Tổ thẩm định tài chính. Tài khoản chuyển thành Nghiên cứu viên.' });
  });

  // Admin: đặt mật khẩu mới (≥6 ký tự), hoặc đưa về chưa kích hoạt nếu để trống
  router.put('/admin/users/:email/password', authMiddleware, adminOnly, async (req, res) => {
    const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
    if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
    const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const newPassword = (req.body?.newPassword ?? '').toString().trim();
    const wantRandomTemp = !!(req.body && req.body.generateRandomTemp === true);

    if (!newPassword || newPassword.length < 6) {
      if (wantRandomTemp) {
        const temp = crypto.randomBytes(8).toString('hex');
        const hash = await bcrypt.hash(temp, 10);
        db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
        return res.json({
          message: 'Đã cấp mật khẩu tạm ngẫu nhiên.',
          tempPassword: temp,
        });
      }
      if ((row.role || '').toLowerCase() === 'admin') {
        return res.status(400).json({ message: 'Không thể đưa tài khoản Admin về chưa kích hoạt qua API này.' });
      }
      const selfEm = (req.user.email || '').toLowerCase();
      if (em === selfEm) {
        return res.status(400).json({ message: 'Không thể đưa chính tài khoản đang đăng nhập về chưa kích hoạt.' });
      }
      db.prepare('UPDATE users SET password = ? WHERE email = ?').run('', em);
      return res.json({
        message: 'Đã đưa tài khoản về chưa kích hoạt. User vào trang Đăng ký (@sci.edu.vn) để đặt mật khẩu.',
        activated: false,
      });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
    return res.json({
      message: 'Đã cấp lại mật khẩu. Gửi mật khẩu tạm cho thành viên qua email nếu cần.',
      tempPassword: newPassword,
    });
  });

  // Admin: khóa / mở khóa đăng nhập (ban nick)
  router.put('/admin/users/:email/banned', authMiddleware, adminOnly, (req, res) => {
    const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
    const banned = !!(req.body && req.body.banned);
    if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
    const currentEmail = (req.user.email || '').toLowerCase();
    if (em === currentEmail) {
      return res.status(400).json({ message: 'Không thể khóa hoặc mở khóa tài khoản của chính mình' });
    }
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    db.prepare('UPDATE users SET is_banned = ? WHERE email = ?').run(banned ? 1 : 0, em);
    return res.json({ message: banned ? 'Đã khóa tài khoản (không đăng nhập được).' : 'Đã mở khóa tài khoản.' });
  });

  // Admin: xóa tài khoản thành viên (chỉ khi không có hồ sơ đã nộp)
  router.delete('/admin/users/:email', authMiddleware, adminOnly, async (req, res) => {
    const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
    if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
    const currentEmail = (req.user.email || '').toLowerCase();
    if (em === currentEmail) return res.status(400).json({ message: 'Bạn không thể xóa tài khoản của chính mình' });
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
    const hasCapVien = db.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
    if (hasSubs || hasCapVien) {
      return res.status(400).json({ message: 'Không thể xóa: thành viên này đã có hồ sơ nộp trong hệ thống. Có thể chuyển vai trò về Nghiên cứu viên thay vì xóa.' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    return res.json({ message: 'Đã xóa tài khoản.' });
  });

  // Master Admin: xóa thành viên Hội đồng KHCN (chu_tich/thu_ky/thanh_vien)
  router.delete('/admin/council-members/:email', authMiddleware, adminOnly, (req, res) => {
    if (!reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được xóa thành viên Hội đồng KHCN.' });
    }
    const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
    if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
    const currentEmail = (req.user.email || '').toLowerCase();
    if (em === currentEmail) return res.status(400).json({ message: 'Bạn không thể tự xóa tài khoản của chính mình' });
    const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
    if (!councilRoles.includes((row.role || '').toLowerCase())) {
      return res.status(400).json({ message: 'Tài khoản này không phải thành viên Hội đồng KHCN.' });
    }
    const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
    const hasCapVien = db.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
    if (hasSubs || hasCapVien) {
      return res.status(400).json({ message: 'Không thể xóa: thành viên này đã có hồ sơ nộp trong hệ thống.' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
    return res.json({ message: 'Đã xóa thành viên Hội đồng KHCN.' });
  });

  return router;
};
