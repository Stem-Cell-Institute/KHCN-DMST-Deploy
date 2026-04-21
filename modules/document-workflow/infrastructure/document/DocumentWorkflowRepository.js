class DocumentWorkflowRepository {
  constructor(documentModel) {
    this.documentModel = documentModel;
  }

  createDocument(payload) {
    return this.documentModel.create(payload);
  }

  getDocuments(filters) {
    return this.documentModel.findAll(filters);
  }

  getDocumentById(documentId) {
    return this.documentModel.findById(documentId);
  }

  getDocumentAttachments(documentId) {
    return this.documentModel.getAttachments(documentId);
  }

  getDocumentFeedback(documentId) {
    return this.documentModel.getFeedback(documentId);
  }

  getDocumentHistory(documentId) {
    return this.documentModel.getHistory(documentId);
  }

  addDocumentHistory(documentId, payload) {
    return this.documentModel.addHistory(documentId, payload);
  }
}

module.exports = {
  DocumentWorkflowRepository,
};
