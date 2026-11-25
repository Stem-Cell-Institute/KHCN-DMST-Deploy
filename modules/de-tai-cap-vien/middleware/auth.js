/**
 * Auth & RBAC Middleware cho Sub-app Quản lý Đề tài Cấp Viện
 * - Khi gắn vào E-Office mẹ (req.eofficeUser có sẵn):
 *   + Ánh xạ tự động tài khoản & vai trò thật từ E-Office sang 7 vai trò của module.
 *   + Chỉ Admin E-Office (can_switch_role = true) mới được phép chuyển vai trò xem thử.
 *   + Người dùng thường bị khóa hoàn toàn cookie/header/query đổi vai trò.
 */

const { ROLES, DEMO_PROFILES, hasPermission, getPermissionsByRole } = require('../config/roles');

function mapEofficeRoleToCapVien(eofficeUser) {
  if (!eofficeUser) return 'PHONG_KHCN';
  if (eofficeUser.isAdmin) return 'SUPER_ADMIN';
  const r = String(eofficeUser.role || '').trim().toLowerCase();
  if (r === 'vien_truong' || r === 'pho_vien_truong') return 'VIEN_TRUONG';
  if (r === 'phong_khcn' || r === 'thu_ky' || r === 'chu_tich') return 'PHONG_KHCN';
  if (r === 'ke_toan' || r === 'totruong_tham_dinh_tc' || r === 'phong_tc_cu') return 'PHONG_TC_CU';
  if (r === 'phong_tchc') return 'PHONG_TCHC';
  if (r === 'thu_kho') return 'THU_KHO';
  return 'CHU_NHIEM';
}

module.exports = function authMiddleware(req, res, next) {
  const eo = req.eofficeUser || null;
  const realRoleKey = eo ? mapEofficeRoleToCapVien(eo) : 'PHONG_KHCN';
  const canSwitchRole = eo ? !!eo.isAdmin : true;

  let roleKey = realRoleKey;
  if (canSwitchRole) {
    if (req.cookies && req.cookies.active_role && ROLES[req.cookies.active_role]) {
      roleKey = req.cookies.active_role;
    } else if (req.headers['x-role'] && ROLES[req.headers['x-role']]) {
      roleKey = req.headers['x-role'];
    } else if (req.query && req.query.role && ROLES[req.query.role]) {
      roleKey = req.query.role;
    }
  }

  const baseProfile = DEMO_PROFILES.find(p => p.role === roleKey) || DEMO_PROFILES[2];
  const roleInfo = ROLES[roleKey] || ROLES.CHU_NHIEM;
  const isRolePreview = !!(eo && roleKey !== realRoleKey);

  let fullname = eo ? eo.fullname : baseProfile.fullname;
  let leaderName = null;
  if (roleKey === 'CHU_NHIEM') {
    if (canSwitchRole) {
      leaderName = (req.cookies && req.cookies.active_leader) || req.headers['x-leader'] || (eo ? eo.fullname : 'Nguyễn Trường Sinh');
    } else {
      leaderName = eo ? eo.fullname : baseProfile.fullname;
    }
    fullname = leaderName;
  } else if (isRolePreview) {
    fullname = baseProfile.fullname;
  }

  req.user = {
    id: eo ? eo.id : (roleKey === 'SUPER_ADMIN' ? 1 : 2),
    email: eo ? eo.email : baseProfile.email,
    fullname,
    leader_name: leaderName,
    unit: baseProfile.unit,
    title: baseProfile.title,
    role: roleKey,
    real_role: realRoleKey,
    real_fullname: eo ? eo.fullname : baseProfile.fullname,
    eoffice_role: eo ? eo.role : null,
    can_switch_role: canSwitchRole,
    is_role_preview: isRolePreview,
    role_info: roleInfo,
    permissions: getPermissionsByRole(roleKey),
    hasPermission: (permKey) => hasPermission(roleKey, permKey),
    isMasterAdmin: roleKey === 'SUPER_ADMIN',
    isDirector: roleKey === 'VIEN_TRUONG',
    isScienceDept: roleKey === 'PHONG_KHCN',
    isPrincipalInvestigator: roleKey === 'CHU_NHIEM'
  };

  next();
};
