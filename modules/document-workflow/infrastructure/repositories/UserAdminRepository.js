'use strict';

/**
 * Repository cho Admin BC - User.
 */
class UserAdminRepository {
  constructor(db, documentModel) {
    this.db = db;
    this.model = documentModel;
  }

  list() {
    return this.model.listUsers();
  }

  getById(userId) {
    return this.model.getUserById(userId);
  }

  getByEmail(email) {
    return this.model.getUserByEmail(email);
  }

  upsert(payload) {
    return this.model.upsertUser(payload);
  }

  setActive(userId, active) {
    return this.model.setUserActive(userId, active);
  }

  delete(userId) {
    return this.model.deleteUser(userId);
  }

  listModulePermissions() {
    return this.model.listModuleManagersAndRoles();
  }

  getAssignableUsers() {
    return this.db
      .prepare(
        `SELECT id, email, fullname, role
         FROM users
         WHERE COALESCE(is_active, CASE WHEN COALESCE(is_banned,0)=1 THEN 0 ELSE 1 END) = 1
         ORDER BY fullname COLLATE NOCASE, email COLLATE NOCASE`
      )
      .all();
  }

  findEmailById(userId) {
    if (!userId) return null;
    try {
      const row = this.db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId);
      return row && row.email ? String(row.email).trim() : null;
    } catch (_) {
      return null;
    }
  }

  findIdByEmailOrName(raw) {
    if (!raw) return null;
    const text = String(raw).trim();
    if (!text) return null;
    const m = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
    const email = m ? String(m[1] || '').trim().toLowerCase() : '';
    if (email) {
      try {
        const row = this.db
          .prepare(`SELECT id FROM users WHERE lower(trim(email)) = ? ORDER BY id DESC LIMIT 1`)
          .get(email);
        if (row && row.id) return Number(row.id);
      } catch (_) {}
    }
    const simpleName = text.replace(/\([^()]*\)\s*$/, '').trim();
    try {
      const row = this.db
        .prepare(`SELECT id FROM users WHERE trim(fullname) = ? ORDER BY id DESC LIMIT 1`)
        .get(simpleName || text);
      if (row && row.id) return Number(row.id);
    } catch (_) {}
    return null;
  }

  getEmailsByRole(role) {
    try {
      const rows = this.db
        .prepare(`SELECT email FROM users WHERE lower(trim(role)) = ? AND trim(COALESCE(email,'')) <> ''`)
        .all(String(role || '').toLowerCase());
      return Array.from(new Set((rows || []).map((r) => String(r.email || '').trim()).filter(Boolean)));
    } catch (_) {
      return [];
    }
  }

  getAllEmails() {
    try {
      const rows = this.db.prepare(`SELECT email FROM users WHERE trim(COALESCE(email,'')) <> ''`).all();
      return Array.from(new Set((rows || []).map((r) => String(r.email || '').trim()).filter(Boolean)));
    } catch (_) {
      return [];
    }
  }

  getModuleManagerEmails() {
    try {
      const rows = this.db
        .prepare(`SELECT email, role FROM users WHERE trim(COALESCE(email,'')) <> ''`)
        .all();
      return Array.from(
        new Set(
          (rows || [])
            .filter((r) =>
              String(r.role || '')
                .toLowerCase()
                .split(/[,\s;|]+/)
                .map((x) => x.trim())
                .filter(Boolean)
                .includes('module_manager')
            )
            .map((r) => String(r.email || '').trim())
            .filter(Boolean)
        )
      );
    } catch (_) {
      return [];
    }
  }
}

module.exports = { UserAdminRepository };
