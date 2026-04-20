const crypto = require('crypto');

function parseRoleCsv(value) {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split(/[,\s;|]+/)
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean);
}

function buildRoleCsv(roles) {
  return Array.from(new Set((roles || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))).join(',');
}

function createDocumentWorkflowAdminController(deps) {
  const { documentModel, permission } = deps;

  function audit(req, payload) {
    try {
      documentModel.addAuditLog({
        user_id: req.user && req.user.id,
        action: payload.action,
        target_type: payload.target_type,
        target_id: payload.target_id,
        old_value: payload.old_value ? JSON.stringify(payload.old_value) : null,
        new_value: payload.new_value ? JSON.stringify(payload.new_value) : null,
        ip_address: req.ip || null,
        user_agent: req.headers['user-agent'] || null,
      });
    } catch (_) {}
  }

  return {
    getAdminMe(req, res) {
      const roles = Array.from(permission.getUserRoles(req));
      return res.json({
        ok: true,
        data: {
          user: req.user,
          roles,
          isMasterAdmin: permission.isMasterAdmin(req),
          isModuleManager: permission.isModuleManager(req),
        },
      });
    },

    getDashboard(req, res) {
      return res.json({
        ok: true,
        data: {
          stats: documentModel.getModuleAdminStats(),
          recentAudit: documentModel.listAuditLogs({}).slice(0, 20),
        },
      });
    },

    listUsers(req, res) {
      return res.json({ ok: true, data: documentModel.listUsers() });
    },

    upsertUser(req, res) {
      const b = req.body || {};
      const routeUserId = req.params && req.params.userId ? Number(req.params.userId) : null;
      const normalizedEmail = String(b.email || '').trim().toLowerCase();
      if (!normalizedEmail) return res.status(400).json({ message: 'Thiếu email.' });
      const existingByEmail = documentModel.getUserByEmail(normalizedEmail);
      const payloadId = b.id ? Number(b.id) : routeUserId || (existingByEmail && existingByEmail.id ? Number(existingByEmail.id) : null);
      if (!payloadId && !b.password) return res.status(400).json({ message: 'Email chưa tồn tại. Tạo mới cần mật khẩu.' });

      const oldUser = payloadId ? documentModel.getUserById(Number(payloadId)) : null;
      if (payloadId && oldUser && Number(oldUser.id) === Number(req.user.id)) {
        const oldRoles = parseRoleCsv(oldUser.role);
        const newRoles = parseRoleCsv(b.role);
        if (oldRoles.includes('master_admin') && !newRoles.includes('master_admin')) {
          return res.status(400).json({ message: 'Không thể tự gỡ quyền master_admin của chính mình.' });
        }
      }

      const saved = documentModel.upsertUser({
        id: payloadId || null,
        email: normalizedEmail,
        password: b.password ? String(b.password) : null,
        fullname: b.fullname ? String(b.fullname) : null,
        role: buildRoleCsv(parseRoleCsv(b.role)),
        department_id: b.department_id ? String(b.department_id) : null,
        is_banned: !!b.is_banned,
        is_active: b.is_active !== false,
      });
      audit(req, {
        action: payloadId ? 'user_updated' : 'user_created',
        target_type: 'user',
        target_id: saved && saved.id,
        old_value: oldUser,
        new_value: saved,
      });
      return res.json({ ok: true, data: saved });
    },

    toggleUserActive(req, res) {
      const userId = Number(req.params.userId);
      const active = !!(req.body && req.body.active);
      const oldUser = documentModel.getUserById(userId);
      if (!oldUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
      if (Number(req.user.id) === Number(userId) && !active) {
        return res.status(400).json({ message: 'Không thể tự khóa tài khoản của chính mình.' });
      }
      const saved = documentModel.setUserActive(userId, active);
      audit(req, {
        action: active ? 'user_unlocked' : 'user_locked',
        target_type: 'user',
        target_id: userId,
        old_value: oldUser,
        new_value: saved,
      });
      return res.json({ ok: true, data: saved });
    },

    deleteUser(req, res) {
      const userId = Number(req.params.userId);
      const oldUser = documentModel.getUserById(userId);
      if (!oldUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
      if (Number(req.user.id) === userId) {
        return res.status(400).json({ message: 'Không thể tự xóa tài khoản của chính mình.' });
      }
      if (parseRoleCsv(oldUser.role).includes('master_admin')) {
        return res.status(400).json({ message: 'Không thể xóa tài khoản đang có quyền master_admin.' });
      }
      const out = documentModel.deleteUser(userId);
      if (!out.deleted) {
        return res.status(409).json({ message: 'User đang liên kết hồ sơ, không thể xóa.' });
      }
      audit(req, {
        action: 'user_deleted',
        target_type: 'user',
        target_id: userId,
        old_value: oldUser,
      });
      return res.json({ ok: true });
    },

    resetUserPassword(req, res) {
      const userId = Number(req.params.userId);
      const oldUser = documentModel.getUserById(userId);
      if (!oldUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
      const resetToken = crypto.randomBytes(12).toString('hex');
      audit(req, {
        action: 'user_password_reset_requested',
        target_type: 'user',
        target_id: userId,
        old_value: null,
        new_value: { token: resetToken },
      });
      return res.json({ ok: true, data: { resetToken, email: oldUser.email } });
    },

    listModulePermissions(req, res) {
      return res.json({ ok: true, data: documentModel.listModuleManagersAndRoles() });
    },

    updateUserRoles(req, res) {
      const userId = Number(req.params.userId);
      const oldUser = documentModel.getUserById(userId);
      if (!oldUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
      const nextRoles = buildRoleCsv(parseRoleCsv(req.body && req.body.roles));
      if (Number(req.user.id) === userId && parseRoleCsv(oldUser.role).includes('master_admin') && !parseRoleCsv(nextRoles).includes('master_admin')) {
        return res.status(400).json({ message: 'Không thể tự gỡ quyền master_admin của chính mình.' });
      }
      const saved = documentModel.upsertUser({
        id: userId,
        email: oldUser.email,
        fullname: oldUser.fullname,
        role: nextRoles,
        department_id: oldUser.department_id,
        is_banned: Number(oldUser.is_banned) === 1,
      });
      audit(req, {
        action: 'role_updated',
        target_type: 'user',
        target_id: userId,
        old_value: { role: oldUser.role },
        new_value: { role: saved.role },
      });
      return res.json({ ok: true, data: saved });
    },

    listUnits(req, res) {
      return res.json({ ok: true, data: documentModel.listUnits() });
    },

    createUnit(req, res) {
      const b = req.body || {};
      if (!b.name) return res.status(400).json({ message: 'Tên đơn vị là bắt buộc.' });
      const row = documentModel.createUnit({ code: b.code ? String(b.code).trim() : null, name: String(b.name).trim() });
      audit(req, { action: 'unit_created', target_type: 'unit', target_id: row.id, new_value: row });
      return res.status(201).json({ ok: true, data: row });
    },

    updateUnit(req, res) {
      const unitId = Number(req.params.unitId);
      const oldRow = documentModel.listUnits().find((x) => Number(x.id) === unitId);
      if (!oldRow) return res.status(404).json({ message: 'Không tìm thấy đơn vị.' });
      const b = req.body || {};
      const row = documentModel.updateUnit(unitId, {
        code: b.code ? String(b.code).trim() : null,
        name: b.name ? String(b.name).trim() : oldRow.name,
        active: b.active !== undefined ? !!b.active : Number(oldRow.active) === 1,
      });
      audit(req, { action: 'unit_updated', target_type: 'unit', target_id: unitId, old_value: oldRow, new_value: row });
      return res.json({ ok: true, data: row });
    },

    deleteUnit(req, res) {
      const unitId = Number(req.params.unitId);
      const oldRow = documentModel.listUnits().find((x) => Number(x.id) === unitId);
      const out = documentModel.deleteUnit(unitId);
      if (!out.deleted) {
        return res.status(400).json({ message: 'Đơn vị đang liên kết dữ liệu, không thể xóa.' });
      }
      audit(req, { action: 'unit_deleted', target_type: 'unit', target_id: unitId, old_value: oldRow });
      return res.json({ ok: true });
    },

    getModuleSettings(req, res) {
      return res.json({
        ok: true,
        data: {
          settings: documentModel.getModuleSettings(),
          documentTypes: documentModel.listDocumentTypes(),
        },
      });
    },

    updateModuleSettings(req, res) {
      const b = req.body || {};
      const old = documentModel.getModuleSettings();
      if (b.default_assignment_days != null) {
        documentModel.setModuleSetting('default_assignment_days', String(Number(b.default_assignment_days) || 14), req.user.id);
      }
      if (b.default_review_remind_days != null) {
        documentModel.setModuleSetting('default_review_remind_days', String(Number(b.default_review_remind_days) || 180), req.user.id);
      }
      if (b.email_enabled != null) {
        documentModel.setModuleSetting('email_enabled', b.email_enabled ? '1' : '0', req.user.id);
      }
      if (b.internal_domain_access_enabled != null) {
        documentModel.setModuleSetting(
          'internal_domain_access_enabled',
          b.internal_domain_access_enabled ? '1' : '0',
          req.user.id
        );
      }
      if (b.internal_domain_email_suffix != null) {
        const suffix = String(b.internal_domain_email_suffix || '').trim() || '@sci.edu.vn';
        documentModel.setModuleSetting('internal_domain_email_suffix', suffix, req.user.id);
      }
      if (b.step5_recipient_mode != null) {
        const modeRaw = String(b.step5_recipient_mode || '').trim().toLowerCase();
        const mode = ['module_manager_assigned', 'broad_roles'].includes(modeRaw)
          ? modeRaw
          : 'module_manager_assigned';
        documentModel.setModuleSetting('step5_recipient_mode', mode, req.user.id);
      }
      if (b.email_templates != null) {
        documentModel.setModuleSetting('email_templates', JSON.stringify(b.email_templates || {}), req.user.id);
      }
      if (b.email_recipients != null) {
        documentModel.setModuleSetting('email_recipients', JSON.stringify(b.email_recipients || {}), req.user.id);
      }
      const now = documentModel.getModuleSettings();
      audit(req, {
        action: 'module_setting_changed',
        target_type: 'setting',
        old_value: old,
        new_value: now,
      });
      return res.json({ ok: true, data: now });
    },

    upsertDocumentType(req, res) {
      const b = req.body || {};
      const routeId = req.params && req.params.id ? Number(req.params.id) : null;
      if (!b.code || !b.name) return res.status(400).json({ message: 'code và name là bắt buộc.' });
      const row = documentModel.upsertDocumentType({
        id: b.id ? Number(b.id) : routeId,
        code: String(b.code).trim().toLowerCase(),
        name: String(b.name).trim(),
        is_active: b.is_active !== false,
        sort_order: Number(b.sort_order || 0),
        updated_by: req.user.id,
      });
      audit(req, {
        action: 'document_type_updated',
        target_type: 'document_type',
        target_id: row.id,
        new_value: row,
      });
      return res.json({ ok: true, data: row });
    },

    listAuditLogs(req, res) {
      return res.json({
        ok: true,
        data: documentModel.listAuditLogs({
          userId: req.query.userId,
          action: req.query.action,
          from: req.query.from,
          to: req.query.to,
        }),
      });
    },
  };
}

module.exports = {
  createDocumentWorkflowAdminController,
};
