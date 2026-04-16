-- Prompt 2: workflow duyệt, bảo trì, sự cố, thông báo trong app
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS equipment_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

INSERT OR IGNORE INTO equipment_departments (code, name, sort_order) VALUES
  ('SCI', 'Phòng thí nghiệm SCI', 10),
  ('CRD', 'Phòng CRD', 20),
  ('PTN', 'Phòng thí nghiệm chung', 30);

CREATE TABLE IF NOT EXISTS equipment_maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  maintenance_type TEXT NOT NULL CHECK(maintenance_type IN ('periodic','calibration','repair')),
  scheduled_date TEXT,
  completed_date TEXT,
  performed_by INTEGER REFERENCES users(id),
  cost REAL,
  result_note TEXT,
  next_due_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eq_maint_eq ON equipment_maintenance(equipment_id);

CREATE TABLE IF NOT EXISTS equipment_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
  reported_by INTEGER REFERENCES users(id),
  report_date TEXT DEFAULT (datetime('now')),
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
  photo_paths TEXT,
  assigned_to INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'reported' CHECK(status IN ('reported','assigned','in_progress','resolved','closed')),
  resolution_note TEXT,
  resolved_at TEXT,
  cost REAL,
  repair_type TEXT CHECK(repair_type IN ('internal','external') OR repair_type IS NULL),
  created_at TEXT DEFAULT (datetime('now')),
  reporter_display TEXT,
  reporter_email TEXT,
  reporter_phone TEXT,
  reporter_ip TEXT,
  incident_source TEXT DEFAULT 'user',
  vendor_note TEXT,
  invoice_ref TEXT,
  proposal_ref TEXT,
  resolution_attachment_paths TEXT
);

CREATE INDEX IF NOT EXISTS idx_eq_inc_eq ON equipment_incidents(equipment_id);
CREATE INDEX IF NOT EXISTS idx_eq_inc_status ON equipment_incidents(status);

CREATE TABLE IF NOT EXISTS app_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  module TEXT NOT NULL DEFAULT 'equipment',
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_notif_user_unread ON app_notifications(user_id, read_at);
