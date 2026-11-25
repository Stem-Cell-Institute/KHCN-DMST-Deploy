const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { ROLES, PERMISSION_GROUPS, DEMO_PROFILES, getPermissionsByRole } = require('../config/roles');
const { AUDIT_CRITERIA } = require('../services/auditService');

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

module.exports = router;
