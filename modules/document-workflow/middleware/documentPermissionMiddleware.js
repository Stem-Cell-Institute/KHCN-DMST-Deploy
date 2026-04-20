function normalizeRole(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function parseRoles(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(normalizeRole).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (Array.isArray(arr)) return arr.map(normalizeRole).filter(Boolean);
  } catch (_) {}
  return text
    .split(/[,\s;|]+/)
    .map(normalizeRole)
    .filter(Boolean);
}

const DEV_MASTER_ADMIN_EMAIL = 'ntsinh0409@gmail.com';

function createDocumentPermissionMiddleware(db) {
  const knownTables = new Map();

  function tableExists(name) {
    if (knownTables.has(name)) return knownTables.get(name);
    let exists = false;
    try {
      const row = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`)
        .get(name);
      exists = !!(row && row.ok);
    } catch (_) {
      exists = false;
    }
    knownTables.set(name, exists);
    return exists;
  }

  function getUserRoles(req) {
    const out = new Set(parseRoles(req.user && req.user.role));
    const email = String((req.user && req.user.email) || '')
      .trim()
      .toLowerCase();
    if (email && email === DEV_MASTER_ADMIN_EMAIL) {
      out.add('master_admin');
      out.add('admin');
    }
    if (tableExists('user_roles')) {
      try {
        const rows = db.prepare(`SELECT role FROM user_roles WHERE user_id = ?`).all(req.user.id);
        rows.forEach((r) => parseRoles(r.role).forEach((x) => out.add(x)));
      } catch (_) {}
    }
    if (tableExists('dms_user_roles')) {
      try {
        const rows = db.prepare(`SELECT role FROM dms_user_roles WHERE user_id = ?`).all(req.user.id);
        rows.forEach((r) => parseRoles(r.role).forEach((x) => out.add(x)));
      } catch (_) {}
    }
    return out;
  }

  function getUserUnitTokens(req) {
    const tokens = new Set();
    const raw = [req.user && req.user.unit, req.user && req.user.department_id, req.user && req.user.departmentId];
    raw
      .filter((x) => x != null && String(x).trim() !== '')
      .forEach((x) => {
        tokens.add(String(x).trim().toLowerCase());
      });
    if (req.user && req.user.id) {
      try {
        const row = db.prepare(`SELECT department_id FROM users WHERE id = ?`).get(req.user.id);
        if (row && row.department_id != null && String(row.department_id).trim() !== '') {
          tokens.add(String(row.department_id).trim().toLowerCase());
        }
      } catch (_) {}
    }
    return tokens;
  }

  function userBelongsToAssignedUnit(req, document) {
    if (!document || document.assigned_unit_id == null) return false;
    const assigned = db
      .prepare(`SELECT id, code, name FROM units WHERE id = ?`)
      .get(document.assigned_unit_id);
    if (!assigned) return false;
    const userUnitTokens = getUserUnitTokens(req);
    if (!userUnitTokens.size) return false;
    const assignedTokens = new Set(
      [assigned.id, assigned.code, assigned.name]
        .filter((x) => x != null && String(x).trim() !== '')
        .map((x) => String(x).trim().toLowerCase())
    );
    for (const t of userUnitTokens) {
      if (assignedTokens.has(t)) return true;
    }
    return false;
  }

  function isAdmin(req) {
    const roles = getUserRoles(req);
    return roles.has('admin') || roles.has('master_admin');
  }

  function isMasterAdmin(req) {
    const roles = getUserRoles(req);
    return roles.has('master_admin') || roles.has('admin');
  }

  function isModuleManager(req) {
    const roles = getUserRoles(req);
    return roles.has('module_manager') || isMasterAdmin(req);
  }

  function getModuleSetting(key, fallback) {
    try {
      if (!tableExists('module_settings')) return fallback;
      const row = db.prepare(`SELECT setting_value FROM module_settings WHERE setting_key = ?`).get(key);
      return row && row.setting_value != null ? row.setting_value : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function isInternalDomainViewer(req) {
    const enabled = String(getModuleSetting('internal_domain_access_enabled', '0')) === '1';
    if (!enabled) return false;
    const email = String((req.user && req.user.email) || '')
      .trim()
      .toLowerCase();
    if (!email) return false;
    const suffix = String(getModuleSetting('internal_domain_email_suffix', '@sci.edu.vn') || '@sci.edu.vn')
      .trim()
      .toLowerCase();
    if (!suffix) return false;
    return email.endsWith(suffix.startsWith('@') ? suffix : `@${suffix}`);
  }

  function hasAnyRole(req, requiredRoles) {
    if (isAdmin(req)) return true;
    const roles = getUserRoles(req);
    return requiredRoles.some((r) => roles.has(normalizeRole(r)));
  }

  function canAccessDocument(req, document, options = {}) {
    if (!document || !req || !req.user) return false;
    if (isAdmin(req) || isModuleManager(req)) return true;
    if (isInternalDomainViewer(req)) return true;
    const roles = getUserRoles(req);
    const requireReviewerForStep4 = options.requireReviewerForStep4 === true;
    if (requireReviewerForStep4 && Number(document.current_step) === 4) {
      return roles.has('reviewer');
    }
    if (Number(document.proposer_id) === Number(req.user.id)) return true;
    if (Number(document.assigned_to_id) === Number(req.user.id)) return true;
    if ((roles.has('drafter') || roles.has('leader')) && userBelongsToAssignedUnit(req, document)) return true;
    if (roles.has('reviewer') && Number(document.current_step) === 4) return true;
    return false;
  }

  function requireRoles(requiredRoles) {
    return function roleGuard(req, res, next) {
      if (isModuleManager(req)) return next();
      if (!hasAnyRole(req, requiredRoles)) {
        return res.status(403).json({ message: 'Bạn không có quyền thao tác chức năng này.' });
      }
      next();
    };
  }

  function requireMasterAdmin(req, res, next) {
    if (!isMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới có quyền truy cập.' });
    }
    return next();
  }

  function requireModuleAdmin(req, res, next) {
    if (!(isMasterAdmin(req) || isModuleManager(req))) {
      return res.status(403).json({ message: 'Chỉ Master Admin hoặc Module Manager mới có quyền truy cập.' });
    }
    return next();
  }

  function requireDocumentAccess(loadDocument, options = {}) {
    return function documentAccessGuard(req, res, next) {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
      }
      const document = loadDocument(id);
      if (!document) return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
      if (!canAccessDocument(req, document, options)) {
        return res.status(403).json({ message: 'Bạn không có quyền truy cập hồ sơ này.' });
      }
      req.documentRecord = document;
      next();
    };
  }

  return {
    getUserRoles,
    hasAnyRole,
    isAdmin,
    isMasterAdmin,
    isModuleManager,
    canAccessDocument,
    requireRoles,
    requireMasterAdmin,
    requireModuleAdmin,
    requireDocumentAccess,
    userBelongsToAssignedUnit,
  };
}

module.exports = {
  createDocumentPermissionMiddleware,
};
