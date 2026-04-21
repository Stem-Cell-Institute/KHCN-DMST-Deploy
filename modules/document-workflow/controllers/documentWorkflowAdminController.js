const crypto = require('crypto');
const {
  EMAIL_EVENT_CATALOG,
  parseStoredToggles,
} = require('../services/documentWorkflowMailRules');

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

function isSqliteUniqueViolation(err) {
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || '');
  return code.includes('SQLITE_CONSTRAINT') || msg.includes('UNIQUE constraint failed');
}

function createDocumentWorkflowAdminController(deps) {
  const { documentModel, permission, documentRepository, unitRepository, userRepository, settingsRepository, auditLogRepository } = deps;
  const userStore = userRepository || documentModel;
  const unitStore = unitRepository || documentModel;
  const settingStore =
    settingsRepository ||
    {
      getAll: () => documentModel.getModuleSettings(),
      get: (key, fallback) => {
        const all = documentModel.getModuleSettings();
        return all[key] != null ? all[key] : fallback;
      },
      set: (key, value, userId) => documentModel.setModuleSetting(key, value, userId),
      listDocumentTypes: () => documentModel.listDocumentTypes(),
      upsertDocumentType: (payload) => documentModel.upsertDocumentType(payload),
    };
  const auditStore =
    auditLogRepository ||
    {
      add: (payload) => documentModel.addAuditLog(payload),
      list: (filters) => documentModel.listAuditLogs(filters),
    };
  const documentStore =
    documentRepository ||
    {
      getModuleAdminStats: () => documentModel.getModuleAdminStats(),
    };

  function audit(req, payload) {
    try {
      auditStore.add({
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
          stats: documentStore.getModuleAdminStats(),
          recentAudit: auditStore.list({}).slice(0, 20),
        },
      });
    },

    listUsers(req, res) {
      return res.json({ ok: true, data: userStore.listUsers() });
    },

    upsertUser(req, res) {
      const b = req.body || {};
      const routeUserId = req.params && req.params.userId ? Number(req.params.userId) : null;
      const normalizedEmail = String(b.email || '').trim().toLowerCase();
      if (!normalizedEmail) return res.status(400).json({ message: 'Thiếu email.' });
      const existingByEmail = userStore.getUserByEmail(normalizedEmail);
      const payloadId = b.id ? Number(b.id) : routeUserId || (existingByEmail && existingByEmail.id ? Number(existingByEmail.id) : null);
      const oldUser = payloadId ? userStore.getUserById(Number(payloadId)) : null;
      if (payloadId && oldUser && Number(oldUser.id) === Number(req.user.id)) {
        const oldRoles = parseRoleCsv(oldUser.role);
        const newRoles = parseRoleCsv(b.role);
        if (oldRoles.includes('master_admin') && !newRoles.includes('master_admin')) {
          return res.status(400).json({ message: 'Không thể tự gỡ quyền master_admin của chính mình.' });
        }
      }

      const saved = userStore.upsertUser({
        id: payloadId || null,
        email: normalizedEmail,
        // User mới không cần admin đặt mật khẩu trước: để trống để user tự kích hoạt/đặt mật khẩu.
        password: b.password ? String(b.password) : '',
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
      const oldUser = userStore.getUserById(userId);
      if (!oldUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
      if (Number(req.user.id) === Number(userId) && !active) {
        return res.status(400).json({ message: 'Không thể tự khóa tài khoản của chính mình.' });
      }
      const saved = userStore.setUserActive(userId, active);
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
      const oldUser = userStore.getUserById(userId);
      if (!oldUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
      if (Number(req.user.id) === userId) {
        return res.status(400).json({ message: 'Không thể tự xóa tài khoản của chính mình.' });
      }
      if (parseRoleCsv(oldUser.role).includes('master_admin')) {
        return res.status(400).json({ message: 'Không thể xóa tài khoản đang có quyền master_admin.' });
      }
      const out = userStore.deleteUser(userId);
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
      const oldUser = userStore.getUserById(userId);
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
      return res.json({ ok: true, data: userStore.listModuleManagersAndRoles() });
    },

    updateUserRoles(req, res) {
      const userId = Number(req.params.userId);
      const oldUser = userStore.getUserById(userId);
      if (!oldUser) return res.status(404).json({ message: 'Không tìm thấy user.' });
      const nextRoles = buildRoleCsv(parseRoleCsv(req.body && req.body.roles));
      if (Number(req.user.id) === userId && parseRoleCsv(oldUser.role).includes('master_admin') && !parseRoleCsv(nextRoles).includes('master_admin')) {
        return res.status(400).json({ message: 'Không thể tự gỡ quyền master_admin của chính mình.' });
      }
      const saved = userStore.upsertUser({
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
      return res.json({ ok: true, data: unitStore.listAll() });
    },

    createUnit(req, res) {
      const b = req.body || {};
      const nameTrimmed = String(b.name || '').trim();
      if (!nameTrimmed) return res.status(400).json({ message: 'Tên đơn vị là bắt buộc.' });
      try {
        const row = unitStore.create({
          code: b.code ? String(b.code).trim() : null,
          name: nameTrimmed,
        });
        audit(req, { action: 'unit_created', target_type: 'unit', target_id: row.id, new_value: row });
        return res.status(201).json({ ok: true, data: row });
      } catch (e) {
        if (isSqliteUniqueViolation(e)) {
          return res.status(409).json({
            message: 'Mã đơn vị đã tồn tại. Dùng mã khác hoặc để trống ô mã.',
          });
        }
        console.error('[DOCFLOW createUnit]', e);
        return res.status(500).json({ message: 'Không thể tạo đơn vị.' });
      }
    },

    updateUnit(req, res) {
      const unitId = Number(req.params.unitId);
      const oldRow = unitStore.listAll().find((x) => Number(x.id) === unitId);
      if (!oldRow) return res.status(404).json({ message: 'Không tìm thấy đơn vị.' });
      const b = req.body || {};
      try {
        const row = unitStore.update(unitId, {
          code: b.code ? String(b.code).trim() : null,
          name: b.name ? String(b.name).trim() : oldRow.name,
          active: b.active !== undefined ? !!b.active : Number(oldRow.active) === 1,
        });
        audit(req, { action: 'unit_updated', target_type: 'unit', target_id: unitId, old_value: oldRow, new_value: row });
        return res.json({ ok: true, data: row });
      } catch (e) {
        if (isSqliteUniqueViolation(e)) {
          return res.status(409).json({
            message: 'Mã đơn vị đã tồn tại. Dùng mã khác hoặc để trống ô mã.',
          });
        }
        console.error('[DOCFLOW updateUnit]', e);
        return res.status(500).json({ message: 'Không thể cập nhật đơn vị.' });
      }
    },

    deleteUnit(req, res) {
      const unitId = Number(req.params.unitId);
      const oldRow = unitStore.listAll().find((x) => Number(x.id) === unitId);
      const out = unitStore.delete(unitId);
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
          settings: settingStore.getAll(),
          documentTypes: settingStore.listDocumentTypes(),
        },
      });
    },

    updateModuleSettings(req, res) {
      const b = req.body || {};
      const old = settingStore.getAll();
      if (b.default_assignment_days != null) {
        settingStore.set('default_assignment_days', String(Number(b.default_assignment_days) || 14), req.user.id);
      }
      if (b.default_review_remind_days != null) {
        settingStore.set('default_review_remind_days', String(Number(b.default_review_remind_days) || 180), req.user.id);
      }
      if (b.email_enabled != null) {
        settingStore.set('email_enabled', b.email_enabled ? '1' : '0', req.user.id);
      }
      if (b.internal_domain_access_enabled != null) {
        settingStore.set(
          'internal_domain_access_enabled',
          b.internal_domain_access_enabled ? '1' : '0',
          req.user.id
        );
      }
      if (b.internal_domain_email_suffix != null) {
        const suffix = String(b.internal_domain_email_suffix || '').trim() || '@sci.edu.vn';
        settingStore.set('internal_domain_email_suffix', suffix, req.user.id);
      }
      if (b.step5_recipient_mode != null) {
        const modeRaw = String(b.step5_recipient_mode || '').trim().toLowerCase();
        const mode = ['module_manager_assigned', 'broad_roles'].includes(modeRaw)
          ? modeRaw
          : 'module_manager_assigned';
        settingStore.set('step5_recipient_mode', mode, req.user.id);
      }
      if (b.email_templates != null) {
        settingStore.set('email_templates', JSON.stringify(b.email_templates || {}), req.user.id);
      }
      if (b.email_recipients != null) {
        settingStore.set('email_recipients', JSON.stringify(b.email_recipients || {}), req.user.id);
      }
      const now = settingStore.getAll();
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
      const row = settingStore.upsertDocumentType({
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

    getEmailNotificationSettings(req, res) {
      const settings = settingStore.getAll();
      const raw = settings.email_notification_toggles || '{}';
      const toggles = parseStoredToggles(raw);
      return res.json({
        ok: true,
        data: {
          toggles,
          catalog: EMAIL_EVENT_CATALOG,
          email_enabled: String(settings.email_enabled || '1') === '1',
        },
      });
    },

    updateEmailNotificationSettings(req, res) {
      const b = req.body || {};
      const merged = parseStoredToggles(b.toggles != null ? b.toggles : b);
      settingStore.set('email_notification_toggles', JSON.stringify(merged), req.user.id);
      if (b.email_enabled != null) {
        settingStore.set('email_enabled', b.email_enabled ? '1' : '0', req.user.id);
      }
      audit(req, {
        action: 'email_notification_settings_updated',
        target_type: 'setting',
        target_id: null,
        new_value: merged,
      });
      const after = settingStore.getAll();
      return res.json({
        ok: true,
        data: {
          toggles: merged,
          catalog: EMAIL_EVENT_CATALOG,
          email_enabled: String(after.email_enabled || '1') === '1',
        },
      });
    },

    listAuditLogs(req, res) {
      return res.json({
        ok: true,
        data: auditStore.list({
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
