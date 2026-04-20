class DocumentTypeModel {
  constructor(db) {
    this.db = db;
  }

  list() {
    return this.db
      .prepare(`SELECT id, code, name, is_active, sort_order FROM document_types ORDER BY sort_order, id`)
      .all();
  }

  upsert(payload) {
    if (payload.id) {
      this.db
        .prepare(
          `UPDATE document_types
           SET code = ?, name = ?, is_active = ?, sort_order = ?, updated_by = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(payload.code, payload.name, payload.is_active ? 1 : 0, payload.sort_order || 0, payload.updated_by || null, payload.id);
      return this.db.prepare(`SELECT * FROM document_types WHERE id = ?`).get(payload.id);
    }
    const ins = this.db
      .prepare(
        `INSERT INTO document_types(code, name, is_active, sort_order, updated_by)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(payload.code, payload.name, payload.is_active ? 1 : 0, payload.sort_order || 0, payload.updated_by || null);
    return this.db.prepare(`SELECT * FROM document_types WHERE id = ?`).get(ins.lastInsertRowid);
  }
}

module.exports = DocumentTypeModel;
