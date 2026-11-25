/**
 * Khởi tạo bảng, migration và seed danh mục cho module Quản lý văn bản (DMS).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function initDmsTablesAndSeed() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS dms_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES dms_categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS dms_document_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS dms_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#64748b',
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dms_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    ref_number TEXT,
    category_id INTEGER REFERENCES dms_categories(id),
    document_type_id INTEGER REFERENCES dms_document_types(id),
    status TEXT NOT NULL DEFAULT 'draft',
    issue_date TEXT,
    valid_until TEXT,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    mime_type TEXT,
    notes TEXT,
    uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
    uploaded_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS dms_document_tags (
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES dms_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS dms_user_roles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    role TEXT NOT NULL,
    granted_by INTEGER REFERENCES users(id),
    granted_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dms_module_access (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    granted_by INTEGER REFERENCES users(id),
    granted_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN issuing_unit TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN external_scan_link TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN import_sheet TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN external_word_link TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_location TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_copy_type TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_sheet_count INTEGER').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_page_count INTEGER').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN retention_until TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN destruction_eligible_date TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN parent_case_ref TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN template_id INTEGER').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_code TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_at TEXT').run();
  } catch (e) {
    /* đã có */
  }
  try {
    db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_by_id INTEGER REFERENCES users(id)').run();
  } catch (e) {
    /* đã có */
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_dms_documents_digitized_code ON dms_documents(digitized_code) WHERE digitized_code IS NOT NULL`
  );
  db.exec(`
  CREATE TABLE IF NOT EXISTS dms_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1.0',
    status TEXT NOT NULL DEFAULT 'active',
    record_kind TEXT DEFAULT 'record',
    description TEXT,
    retention_policy TEXT,
    medium_notes TEXT,
    owning_unit TEXT,
    effective_from TEXT,
    effective_until TEXT,
    blank_form_url TEXT,
    superseded_by_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_by_id INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT,
    FOREIGN KEY (superseded_by_id) REFERENCES dms_templates(id)
  );
  CREATE INDEX IF NOT EXISTS idx_dms_documents_template ON dms_documents(template_id);
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS dms_document_loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    borrower_name TEXT NOT NULL,
    reason TEXT,
    borrowed_at TEXT DEFAULT (datetime('now','localtime')),
    due_at TEXT,
    returned_at TEXT,
    created_by_id INTEGER REFERENCES users(id),
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS dms_document_handovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    from_party TEXT NOT NULL,
    to_party TEXT NOT NULL,
    handed_at TEXT DEFAULT (datetime('now','localtime')),
    notes TEXT,
    created_by_id INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS dms_inventory_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now','localtime')),
    closed_at TEXT,
    started_by_id INTEGER REFERENCES users(id),
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS dms_inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES dms_inventory_sessions(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    physical_location_found TEXT,
    notes TEXT,
    checked_at TEXT DEFAULT (datetime('now','localtime')),
    checked_by_id INTEGER REFERENCES users(id),
    UNIQUE(session_id, document_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dms_loans_doc ON dms_document_loans(document_id);
  CREATE INDEX IF NOT EXISTS idx_dms_loans_open ON dms_document_loans(document_id) WHERE returned_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_dms_handover_doc ON dms_document_handovers(document_id);
`);
  /** Người đã có vai trò module trước đây → tự thêm vào danh sách mở truy cập (một lần). */
  (function backfillDmsModuleAccessFromRoles() {
    try {
      db.prepare(
        `INSERT OR IGNORE INTO dms_module_access (user_id, granted_by, granted_at)
       SELECT user_id, NULL, datetime('now','localtime') FROM dms_user_roles`
      ).run();
    } catch (e) {
      console.warn('[DB] backfillDmsModuleAccessFromRoles:', e.message || e);
    }
  })();
  /** Người đã mở truy cập module nhưng chưa có dòng dms_user_roles → mặc định viewer (một lần). */
  (function backfillDmsDefaultViewerRole() {
    try {
      db.prepare(
        `INSERT OR IGNORE INTO dms_user_roles (user_id, role, granted_by, granted_at)
       SELECT a.user_id, 'viewer', NULL, datetime('now','localtime')
       FROM dms_module_access a
       LEFT JOIN dms_user_roles r ON r.user_id = a.user_id
       WHERE r.user_id IS NULL`
      ).run();
    } catch (e) {
      console.warn('[DB] backfillDmsDefaultViewerRole:', e.message || e);
    }
  })();
  (function seedDmsCatalogIfEmpty() {
    try {
      const n = db.prepare('SELECT COUNT(*) AS c FROM dms_categories').get().c;
      if (n > 0) return;
      const ins = db.prepare(
        'INSERT INTO dms_categories (parent_id, name, sort_order, is_active) VALUES (?, ?, ?, 1)'
      );
      const r1 = ins.run(null, 'Văn bản pháp lý nội bộ', 1);
      const p1 = r1.lastInsertRowid;
      ins.run(p1, 'Quyết định', 1);
      ins.run(p1, 'Quy chế / Quy định', 2);
      ins.run(null, 'Hợp đồng & Thỏa thuận', 2);
      ins.run(null, 'Hồ sơ đề tài KHCN', 3);
      ins.run(null, 'Biên bản & Tờ trình', 4);
      ins.run(null, 'Kế hoạch & Công văn', 5);
      const tins = db.prepare(
        'INSERT INTO dms_document_types (name, code, sort_order, is_active) VALUES (?, ?, ?, 1)'
      );
      tins.run('Quy chế nội bộ', 'quy_che', 1);
      tins.run('Quyết định', 'quyet_dinh', 2);
      tins.run('Hợp đồng', 'hop_dong', 3);
      tins.run('Biên bản', 'bien_ban', 4);
      tins.run('Công văn', 'cong_van', 5);
      const tagIns = db.prepare('INSERT OR IGNORE INTO dms_tags (name, color, sort_order) VALUES (?, ?, ?)');
      tagIns.run('KHCN', '#2563eb', 1);
      tagIns.run('TSTT / IP', '#7c3aed', 2);
      tagIns.run('Nhân sự', '#0891b2', 3);
      tagIns.run('Tài chính', '#047857', 4);
      tagIns.run('Pháp lý', '#b45309', 5);
    } catch (e) {
      console.warn('[DB] seedDmsCatalogIfEmpty:', e.message || e);
    }
  })();

  /** Gán category_id xuống mục con khi bản ghi đang ở danh mục cấp trên nhưng loại tài liệu trùng tên mục con (VD: nhóm «Văn bản…» + loại «Quyết định» → mục Quyết định). Idempotent mỗi lần khởi động. */
  (function realignDmsCategoryByDocumentType() {
    try {
      const children = db
        .prepare(
          `SELECT c.id AS cid, c.name AS cname, c.parent_id AS pid
         FROM dms_categories c
         WHERE c.parent_id IS NOT NULL AND COALESCE(c.is_active,1) = 1`
        )
        .all();
      const findType = db.prepare(
        `SELECT id FROM dms_document_types WHERE lower(trim(name)) = lower(trim(?)) AND COALESCE(is_active,1) = 1 LIMIT 1`
      );
      const upd = db.prepare(
        `UPDATE dms_documents SET category_id = ? WHERE category_id = ? AND document_type_id = ?`
      );
      for (const ch of children) {
        const dt = findType.get(ch.cname);
        if (!dt) continue;
        upd.run(ch.cid, ch.pid, dt.id);
      }
    } catch (e) {
      console.warn('[DB] realignDmsCategoryByDocumentType:', e.message || e);
    }
  })();
};
