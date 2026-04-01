-- Quyền xem dashboard (admin gán) — Phần C / tích hợp sau
-- Bảng users phải tồn tại (CSDL chính KHCN&ĐMST).

CREATE TABLE IF NOT EXISTS dashboard_permissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  dashboard_id TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  granted_by   INTEGER NOT NULL,
  granted_at   TEXT DEFAULT (datetime('now', 'localtime')),
  expires_at   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (granted_by) REFERENCES users(id),
  UNIQUE (dashboard_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dash_perm_user ON dashboard_permissions(user_id, dashboard_id);
CREATE INDEX IF NOT EXISTS idx_dash_perm_dashboard ON dashboard_permissions(dashboard_id);
