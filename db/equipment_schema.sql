-- Module Quản trị Thiết bị (STIMS / SCI-ACE)
-- Chạy idempotent qua db.exec trong server (CREATE IF NOT EXISTS + ALTER an toàn).

PRAGMA foreign_keys = ON;

-- Cột phục vụ phân quyền nội bộ (nếu chưa có)
-- SQLite: ALTER ADD COLUMN — bỏ qua lỗi nếu đã tồn tại (xử lý ở tầng ứng dụng nếu cần)

CREATE TABLE IF NOT EXISTS equipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  asset_group TEXT,
  model TEXT,
  serial_number TEXT,
  manufacturer TEXT,
  purchase_year INTEGER,
  purchase_value REAL,
  department_id TEXT,
  manager_id INTEGER REFERENCES users(id),
  location TEXT,
  specs_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','maintenance','broken','retired')),
  profile_visibility TEXT NOT NULL DEFAULT 'institute' CHECK(profile_visibility IN ('public','institute','internal')),
  asset_type_code TEXT,
  year_in_use INTEGER,
  unit_name TEXT,
  quantity_book REAL,
  quantity_actual REAL,
  quantity_diff REAL,
  remaining_value REAL,
  utilization_note TEXT,
  condition_note TEXT,
  disaster_impact_note TEXT,
  construction_asset_note TEXT,
  usage_count_note TEXT,
  land_attached_note TEXT,
  asset_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('sop','technical','safety','warranty','calibration')),
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  version TEXT,
  notes TEXT,
  access_level TEXT NOT NULL DEFAULT 'internal' CHECK(access_level IN ('internal','institute','public')),
  uploaded_by INTEGER REFERENCES users(id),
  is_disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_documents_equipment ON equipment_documents(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_documents_disabled ON equipment_documents(equipment_id, is_disabled);

CREATE TABLE IF NOT EXISTS equipment_videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('youtube','drive','internal')),
  description TEXT,
  access_level TEXT NOT NULL DEFAULT 'internal' CHECK(access_level IN ('internal','institute','public')),
  added_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_videos_equipment ON equipment_videos(equipment_id);

CREATE TABLE IF NOT EXISTS equipment_status_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  note TEXT,
  changed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_status_logs_eq ON equipment_status_logs(equipment_id);

CREATE TABLE IF NOT EXISTS equipment_document_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES equipment_documents(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK(action IN ('add','replace','disable')),
  performed_by INTEGER REFERENCES users(id),
  note TEXT,
  performed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_equipment_document_logs_eq ON equipment_document_logs(equipment_id);
