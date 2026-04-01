-- Nhật ký truy cập / từ chối dashboard (Phần C)

CREATE TABLE IF NOT EXISTS dashboard_access_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  dashboard_id TEXT,
  action       TEXT CHECK(action IN ('view', 'denied', 'export')) DEFAULT 'denied',
  ip_address   TEXT,
  accessed_at  TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_dash_access_user ON dashboard_access_log(user_id, accessed_at);
CREATE INDEX IF NOT EXISTS idx_dash_access_dash ON dashboard_access_log(dashboard_id, accessed_at);
