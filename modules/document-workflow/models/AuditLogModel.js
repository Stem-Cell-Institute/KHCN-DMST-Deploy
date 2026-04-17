class AuditLogModel {
  constructor(db) {
    this.db = db;
  }

  create(payload) {
    this.db
      .prepare(
        `INSERT INTO audit_logs(user_id, action, target_type, target_id, old_value, new_value, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payload.user_id || null,
        payload.action,
        payload.target_type || null,
        payload.target_id || null,
        payload.old_value || null,
        payload.new_value || null,
        payload.ip_address || null,
        payload.user_agent || null
      );
  }

  list(filters = {}) {
    const where = ['1=1'];
    const params = [];
    if (filters.userId) {
      where.push('a.user_id = ?');
      params.push(Number(filters.userId));
    }
    if (filters.action) {
      where.push('a.action = ?');
      params.push(String(filters.action));
    }
    if (filters.from) {
      where.push('a.created_at >= ?');
      params.push(String(filters.from));
    }
    if (filters.to) {
      where.push('a.created_at <= ?');
      params.push(String(filters.to));
    }
    return this.db
      .prepare(
        `SELECT a.*, u.email AS user_email, u.fullname AS user_fullname
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY a.id DESC
         LIMIT 500`
      )
      .all(...params);
  }
}

module.exports = AuditLogModel;
