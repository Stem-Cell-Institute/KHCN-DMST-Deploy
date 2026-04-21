const ALLOWED_DOC_TYPES = ['quy_che', 'quy_dinh', 'noi_quy', 'huong_dan'];

class Document {
  static normalizeDocType(value) {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  static isAllowedDocType(value) {
    return ALLOWED_DOC_TYPES.includes(Document.normalizeDocType(value));
  }

  static ensureValidCreatePayload(payload) {
    const title = String((payload && payload.title) || '').trim();
    const docType = Document.normalizeDocType(
      payload && (payload.docType || payload.doc_type)
    );
    if (!title) {
      return { ok: false, message: 'Thiếu tiêu đề.' };
    }
    if (!Document.isAllowedDocType(docType)) {
      return { ok: false, message: 'Loại văn bản không hợp lệ.' };
    }
    return { ok: true, value: { title, docType } };
  }
}

module.exports = {
  Document,
  ALLOWED_DOC_TYPES,
};
