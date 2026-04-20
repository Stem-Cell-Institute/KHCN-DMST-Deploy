CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS module_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_document_types_active ON document_types(is_active);

INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('default_assignment_days', '14');
INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('default_review_remind_days', '180');
INSERT OR IGNORE INTO module_settings(setting_key, setting_value) VALUES ('email_enabled', '1');
INSERT OR IGNORE INTO module_settings(setting_key, setting_value)
VALUES ('email_templates', '{"assign":"Bạn được phân công soạn thảo.","review_reject":"Hồ sơ bị từ chối.","publish":"Văn bản đã ban hành."}');

INSERT OR IGNORE INTO document_types(code, name, is_active, sort_order) VALUES ('quy_che', 'Quy chế', 1, 1);
INSERT OR IGNORE INTO document_types(code, name, is_active, sort_order) VALUES ('quy_dinh', 'Quy định', 1, 2);
INSERT OR IGNORE INTO document_types(code, name, is_active, sort_order) VALUES ('noi_quy', 'Nội quy', 1, 3);
INSERT OR IGNORE INTO document_types(code, name, is_active, sort_order) VALUES ('huong_dan', 'Hướng dẫn', 1, 4);
