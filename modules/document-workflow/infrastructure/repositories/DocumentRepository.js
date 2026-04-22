'use strict';

/**
 * Repository cho Workflow Bounded Context.
 * - Lam adapter mong quanh DocumentModel hien tai de controller/use-case khong
 *   phu thuoc truc tiep vao model monolithic.
 * - Khi xoa DocumentModel sau nay, chi can swap implementation o day.
 */
class DocumentRepository {
  constructor(db, documentModel) {
    this.db = db;
    this.model = documentModel;
  }

  create(payload) {
    return this.model.create(payload);
  }

  findById(id) {
    return this.model.findById(id);
  }

  findAll(filters) {
    return this.model.findAll(filters);
  }

  update(id, data) {
    return this.model.update(id, data);
  }

  softDelete(id) {
    return this.model.softDeleteDocument(id);
  }

  getAttachments(documentId) {
    return this.model.getAttachments(documentId);
  }

  addAttachment(documentId, payload) {
    return this.model.addAttachment(documentId, payload);
  }

  getFeedback(documentId) {
    return this.model.getFeedback(documentId);
  }

  addFeedback(documentId, payload) {
    return this.model.addFeedback(documentId, payload);
  }

  getHistory(documentId) {
    return this.model.getHistory(documentId);
  }

  addHistory(documentId, payload) {
    return this.model.addHistory(documentId, payload);
  }

  getDashboardStats() {
    return this.model.getDashboardStats();
  }

  findAttachmentWithContext(attachmentId) {
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

module.exports = { DocumentRepository };
