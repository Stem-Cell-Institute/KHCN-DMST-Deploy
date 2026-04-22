'use strict';

/**
 * Repository cho Admin BC - Audit Log.
 */
class AuditLogRepository {
  constructor(db, documentModel) {
    this.db = db;
    this.model = documentModel;
  }

  append(payload) {
    return this.model.addAuditLog(payload);
  }

  list(filters) {
    return this.model.listAuditLogs(filters || {});
  }
}

module.exports = { AuditLogRepository };
