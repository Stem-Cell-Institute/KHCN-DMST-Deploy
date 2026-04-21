class DocumentRepository {
  constructor(deps) {
    this.db = deps.db;
    this.documentModel = deps.documentModel;
  }

  create(payload) {
    return this.documentModel.create(payload);
  }

  findAll(filters) {
    return this.documentModel.findAll(filters);
  }

  findById(documentId) {
    return this.documentModel.findById(documentId);
  }

  update(documentId, payload) {
    return this.documentModel.update(documentId, payload);
  }

  softDelete(documentId) {
    return this.documentModel.softDeleteDocument(documentId);
  }

  addHistory(documentId, payload) {
    return this.documentModel.addHistory(documentId, payload);
  }

  addAttachment(documentId, payload) {
    return this.documentModel.addAttachment(documentId, payload);
  }

  addFeedback(documentId, payload) {
    return this.documentModel.addFeedback(documentId, payload);
  }

  getAttachments(documentId) {
    return this.documentModel.getAttachments(documentId);
  }

  getFeedback(documentId) {
    return this.documentModel.getFeedback(documentId);
  }

  getHistory(documentId) {
    return this.documentModel.getHistory(documentId);
  }

  getDashboardStats() {
    return this.documentModel.getDashboardStats();
  }

  getModuleAdminStats() {
    return this.documentModel.getModuleAdminStats();
  }

  findAttachmentWithDocument(attachmentId) {
    return this.db
      .prepare(
        `SELECT a.*, d.proposer_id, d.assigned_to_id, d.assigned_unit_id, d.current_step
         FROM document_attachments a
         JOIN documents d ON d.id = a.document_id
         WHERE a.id = ?`
      )
      .get(attachmentId);
  }
}

module.exports = {
  DocumentRepository,
};
