const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { ROLES, PERMISSION_GROUPS, DEMO_PROFILES, getPermissionsByRole } = require('../config/roles');
const { AUDIT_CRITERIA } = require('../services/auditService');
const emailNotificationService = require('../services/emailNotificationService');

// 1. Lấy danh sách 7 vai trò
router.get('/roles', (req, res) => {
  res.json({
    success: true,
    data: Object.values(ROLES)
  });
});

// 2. Lấy toàn bộ Ma trận phân quyền
router.get('/matrix', (req, res) => {
  const rolesList = Object.values(ROLES);

  const matrixData = PERMISSION_GROUPS.map(group => ({
    group_id: group.group_id,
    group_name: group.group_name,
    permissions: group.permissions.map(perm => ({
      key: perm.key,
      name: perm.name,
      desc: perm.desc,
      role_access: rolesList.map(r => ({
        role_key: r.key,
        role_name: r.short_name,
        has_access: r.key === 'SUPER_ADMIN' || perm.roles.includes(r.key)
      }))
    }))
  }));

  res.json({
    success: true,
    data: {
      roles: rolesList,
      groups: matrixData,
      document_criteria: AUDIT_CRITERIA,
      total_permissions: PERMISSION_GROUPS.reduce((acc, g) => acc + g.permissions.length, 0)
    }
  });
});

// 3. Lấy thông tin người dùng & vai trò hiện tại (đã xác thực qua middleware/auth.js)
router.get('/current-user', async (req, res) => {
  try {
    const u = req.user;
    const canSwitch = !!(u && u.can_switch_role);

    const leaders = canSwitch
      ? await db.all(`
          SELECT leader_name, research_group, COUNT(*) as project_count
          FROM nckh_projects
          WHERE leader_name IS NOT NULL AND leader_name != ''
          GROUP BY leader_name
          ORDER BY project_count DESC, leader_name ASC
        `)
      : [];

    res.json({
      success: true,
      data: {
        id: u.id,
        email: u.email,
        fullname: u.fullname,
        leader_name: u.leader_name,
        unit: u.unit,
        title: u.title,
        role: u.role,
        real_role: u.real_role,
        real_fullname: u.real_fullname,
        is_master_admin: !!u.is_master_admin,
        can_switch_role: canSwitch,
        is_role_preview: !!u.is_role_preview,
        role_info: u.role_info || ROLES[u.role] || ROLES.CHU_NHIEM,
        permissions: u.permissions || getPermissionsByRole(u.role),
        available_leaders: leaders
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Lấy danh sách hồ sơ mẫu demo để switch vai trò (chỉ trả dữ liệu khi được phép đổi vai trò)
router.get('/profiles', async (req, res) => {
  try {
    if (!req.user || !req.user.can_switch_role) {
      return res.json({ success: true, data: [], leaders: [] });
    }
    const leaders = await db.all(`
      SELECT leader_name, research_group, COUNT(*) as project_count
      FROM nckh_projects
      WHERE leader_name IS NOT NULL AND leader_name != ''
      GROUP BY leader_name
      ORDER BY project_count DESC, leader_name ASC
    `);

    const profiles = DEMO_PROFILES.map(p => ({
      ...p,
      role_info: ROLES[p.role]
    }));

    res.json({
      success: true,
      data: profiles,
      leaders
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Chuyển đổi vai trò xem thử — CHỈ DÀNH CHO ADMIN E-OFFICE
router.post('/switch-role', (req, res) => {
  if (!req.user || !req.user.can_switch_role) {
    return res.status(403).json({
      success: false,
      error: 'Chỉ Quản trị viên (Admin E-Office) mới được phép chuyển vai trò xem thử.'
    });
  }

  const { role, leader_name } = req.body || {};
  if (!ROLES[role]) {
    return res.status(400).json({ success: false, error: 'Vai trò không hợp lệ trong hệ thống' });
  }

  res.cookie('active_role', role, {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: false,
    path: '/',
    sameSite: 'lax'
  });

  if (leader_name) {
    res.cookie('active_leader', leader_name, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      path: '/',
      sameSite: 'lax'
    });
  }

  const profile = DEMO_PROFILES.find(p => p.role === role);
  const displayLeader = role === 'CHU_NHIEM' ? (leader_name || req.cookies?.active_leader || 'Nguyễn Trường Sinh') : profile.fullname;

  res.json({
    success: true,
    message: role === 'CHU_NHIEM'
      ? `Đã chuyển sang vai trò xem thử: Chủ nhiệm đề tài (${displayLeader})`
      : `Đã chuyển sang vai trò xem thử: ${ROLES[role].name}`,
    data: {
      role,
      leader_name: role === 'CHU_NHIEM' ? displayLeader : null,
      profile,
      role_info: ROLES[role]
    }
  });
});

// 6. Quản lý gán vai trò thực tế cho tài khoản E-Office — CHỈ DÀNH CHO ADMIN E-OFFICE
router.get('/assignments', async (req, res) => {
  try {
    if (!req.user || !req.user.can_switch_role) {
      return res.status(403).json({
        success: false,
        error: 'Chỉ Admin E-Office mới có quyền quản lý gán vai trò người dùng.'
      });
    }

    let eofficeUsers = [];
    if (req.eofficeDb) {
      try {
        eofficeUsers = req.eofficeDb
          .prepare('SELECT id, email, fullname, role FROM users ORDER BY fullname COLLATE NOCASE, email')
          .all();
      } catch (_) {
        eofficeUsers = [];
      }
    }

    const assignments = await db.all(`
      SELECT id, eoffice_user_id, email, fullname, role_key, position_title, assigned_by, updated_at
      FROM nckh_user_roles
      ORDER BY updated_at DESC, id DESC
    `);

    res.json({
      success: true,
      data: {
        eoffice_users: eofficeUsers,
        assignments: assignments.map((a) => ({
          ...a,
          role_info: ROLES[a.role_key] || ROLES.CHU_NHIEM
        })),
        roles: Object.values(ROLES)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/assignments', async (req, res) => {
  try {
    if (!req.user || !req.user.can_switch_role) {
      return res.status(403).json({
        success: false,
        error: 'Chỉ Admin E-Office mới có quyền gán vai trò người dùng.'
      });
    }

    const { eoffice_user_id, email, fullname, role_key, position_title } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanRole = String(role_key || '').trim().toUpperCase() === 'PHONG_TCHC'
      ? 'PHONG_KHCN'
      : String(role_key || '').trim().toUpperCase();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      return res.status(400).json({ success: false, error: 'Vui lòng chọn tài khoản hoặc nhập email hợp lệ.' });
    }
    if (!ROLES[cleanRole]) {
      return res.status(400).json({ success: false, error: 'Vai trò không hợp lệ.' });
    }

    // Tự động khớp với tài khoản E-Office nếu tồn tại
    let resolvedUserId = eoffice_user_id ? Number(eoffice_user_id) : null;
    let resolvedFullname = String(fullname || '').trim();
    if (req.eofficeDb) {
      try {
        const eoRow = resolvedUserId
          ? req.eofficeDb.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(resolvedUserId)
          : req.eofficeDb.prepare('SELECT id, email, fullname FROM users WHERE LOWER(TRIM(email)) = ?').get(cleanEmail);
        if (eoRow) {
          resolvedUserId = eoRow.id;
          if (!resolvedFullname) resolvedFullname = eoRow.fullname || eoRow.email;
        }
      } catch (_) {}
    }

    const assignedBy = (req.user && (req.user.email || req.user.fullname)) || 'admin';
    const existing = await db.get('SELECT id FROM nckh_user_roles WHERE LOWER(TRIM(email)) = ?', [cleanEmail]);

    if (existing) {
      await db.run(
        `UPDATE nckh_user_roles
         SET eoffice_user_id = COALESCE(?, eoffice_user_id),
             fullname = ?,
             role_key = ?,
             position_title = ?,
             assigned_by = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [resolvedUserId, resolvedFullname || cleanEmail, cleanRole, String(position_title || '').trim() || null, assignedBy, existing.id]
      );
    } else {
      await db.run(
        `INSERT INTO nckh_user_roles (eoffice_user_id, email, fullname, role_key, position_title, assigned_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [resolvedUserId, cleanEmail, resolvedFullname || cleanEmail, cleanRole, String(position_title || '').trim() || null, assignedBy]
      );
    }

    const saved = await db.get('SELECT * FROM nckh_user_roles WHERE LOWER(TRIM(email)) = ?', [cleanEmail]);
    res.json({
      success: true,
      message: `Đã gán vai trò ${ROLES[cleanRole].name} cho ${saved.fullname || saved.email}`,
      data: { ...saved, role_info: ROLES[cleanRole] }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/assignments/:id', async (req, res) => {
  try {
    if (!req.user || !req.user.can_switch_role) {
      return res.status(403).json({
        success: false,
        error: 'Chỉ Admin E-Office mới có quyền gỡ vai trò người dùng.'
      });
    }
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'ID không hợp lệ.' });
    }
    const r = await db.run('DELETE FROM nckh_user_roles WHERE id = ?', [id]);
    if (!r.rowsAffected) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy phân quyền.' });
    }
    res.json({ success: true, message: 'Đã gỡ phân quyền thành công.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Ma trận Luồng Email Thông báo Tự động — CHỈ DÀNH CHO MASTER ADMIN
router.get('/email-matrix', async (req, res) => {
  try {
    if (!req.user || !req.user.is_master_admin) {
      return res.status(403).json({
        success: false,
        error: 'Chỉ Master Admin E-Office mới có quyền xem và cấu hình Ma trận Email thông báo.'
      });
    }
    const [rules, roleDirectory, recentLogs] = await Promise.all([
      emailNotificationService.getMatrixRules(),
      emailNotificationService.getRoleEmailDirectory(),
      db.all(`
        SELECT id, event_type, recipient_email, recipient_name, recipient_role, subject, sent_status AS status, sent_at
        FROM nckh_email_logs
        ORDER BY id DESC
        LIMIT 30
      `)
    ]);
    res.json({
      success: true,
      data: {
        smtp_configured: emailNotificationService.isSmtpConfigured(),
        base_module_url: emailNotificationService.getBaseModuleUrl(),
        roles: Object.values(ROLES),
        role_directory: roleDirectory,
        rules,
        recent_logs: recentLogs
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/email-matrix/:eventKey', async (req, res) => {
  try {
    if (!req.user || !req.user.is_master_admin) {
      return res.status(403).json({
        success: false,
        error: 'Chỉ Master Admin E-Office mới có quyền cấu hình Ma trận Email thông báo.'
      });
    }
    const { eventKey } = req.params;
    const { enabled, recipient_roles, extra_cc } = req.body || {};
    const updated = await emailNotificationService.saveMatrixRule(eventKey, {
      enabled: enabled !== false && enabled !== 0,
      recipient_roles,
      extra_cc,
      updated_by: req.user.email || req.user.fullname || 'master_admin'
    });
    res.json({
      success: true,
      message: `Đã lưu cấu hình email cho sự kiện "${updated.event_name}".`,
      data: updated
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = router;
