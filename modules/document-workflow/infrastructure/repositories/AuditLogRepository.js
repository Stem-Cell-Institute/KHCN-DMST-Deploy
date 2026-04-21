class AuditLogRepository {
  constructor(deps) {
    this.documentModel = deps.documentModel;
  }

  add(payload) {
    return this.documentModel.addAuditLog(payload);
  }

  list(filters) {
    return this.documentModel.listAuditLogs(filters);
  }
}

module.exports = {
  AuditLogRepository,
};
