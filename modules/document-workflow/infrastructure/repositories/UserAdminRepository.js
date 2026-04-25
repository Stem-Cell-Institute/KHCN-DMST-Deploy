function splitRoleTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[,\s;|]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

class UserAdminRepository {
  constructor(deps) {
    this.db = deps.db;
    this.documentModel = deps.documentModel;
  }

  listAssignableUsers() {
    return this.db
      .prepare(
        `SELECT id, email, fullname, role
         FROM users
         WHERE COALESCE(is_active, CASE WHEN COALESCE(is_banned,0)=1 THEN 0 ELSE 1 END) = 1
         ORDER BY fullname COLLATE NOCASE, email COLLATE NOCASE`
      )
      .all();
  }

  listUsers() {
    return this.documentModel.listUsers();
  }

  getUserById(userId) {
    return this.documentModel.getUserById(userId);
  }

  getUserByEmail(email) {
    return this.documentModel.getUserByEmail(email);
  }

  upsertUser(payload) {
    return this.documentModel.upsertUser(payload);
  }

  setUserActive(userId, active) {
    return this.documentModel.setUserActive(userId, active);
  }

  deleteUser(userId) {
    return this.documentModel.deleteUser(userId);
  }

  listModuleManagersAndRoles() {
    return this.documentModel.listModuleManagersAndRoles();
  }

  getUserEmailById(userId) {
    if (!userId) return null;
    try {
      const row = this.db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId);
      return row && row.email ? String(row.email).trim() : null;
    } catch (_) {
      return null;
    }
  }

  getRoleEmails(role) {
    const target = String(role || '').trim().toLowerCase();
    if (!target) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT u.email, u.role AS base_role, GROUP_CONCAT(ur.role, ',') AS extra_roles
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id
           WHERE trim(COALESCE(u.email,'')) <> ''
           GROUP BY u.id, u.email, u.role`
        )
        .all();
      return Array.from(
        new Set(
          (rows || [])
            .filter((row) => {
              const merged = splitRoleTokens(row.base_role).concat(splitRoleTokens(row.extra_roles));
              return Array.from(new Set(merged)).includes(target);
            })
            .map((row) => String(row.email || '').trim())
            .filter(Boolean)
        )
      );
    } catch (_) {
      return [];
    }
  }

  getModuleManagerEmails() {
    return this.getRoleEmails('module_manager');
  }

  getMasterAdminEmails() {
    const admins = this.getRoleEmails('admin');
    const masters = this.getRoleEmails('master_admin');
    return Array.from(new Set([...admins, ...masters]));
  }

  getAllEmails() {
    try {
      const rows = this.db
        .prepare(`SELECT email FROM users WHERE trim(COALESCE(email,'')) <> ''`)
        .all();
      return Array.from(
        new Set(
          (rows || [])
            .map((row) => String(row.email || '').trim())
            .filter(Boolean)
        )
      );
    } catch (_) {
      return [];
    }
  }

  resolveAssigneeId(input) {
    const assignedToId = Number(input && input.assignedToId);
    if (Number.isFinite(assignedToId) && assignedToId > 0) return assignedToId;
    const raw = String((input && input.assignedToName) || '').trim();
    if (!raw) return null;
    const m = raw.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const email = m ? String(m[1] || '').trim().toLowerCase() : '';
    if (email) {
      const byEmail = this.db
        .prepare(`SELECT id FROM users WHERE lower(trim(email)) = ? ORDER BY id DESC LIMIT 1`)
        .get(email);
      if (byEmail && byEmail.id) return Number(byEmail.id);
    }
    const simpleName = raw.replace(/\([^()]*\)\s*$/, '').trim();
    const byName = this.db
      .prepare(`SELECT id FROM users WHERE trim(fullname) = ? ORDER BY id DESC LIMIT 1`)
      .get(simpleName || raw);
    return byName && byName.id ? Number(byName.id) : null;
  }
}

module.exports = {
  UserAdminRepository,
};
