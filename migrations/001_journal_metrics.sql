-- Journal metrics từ SCImago (SJR) — chạy trên SQLite (sci-ace.db / Turso).
-- Khuyến nghị: bảng cũng được tạo tự động khi khởi động app qua sci-khcn-publications/src/db/index.js

CREATE TABLE IF NOT EXISTS journal_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issn_print TEXT,
  issn_electronic TEXT,
  journal_name TEXT,
  sjr_year INTEGER,
  sjr_quartile TEXT,
  sjr_score REAL,
  h_index INTEGER,
  total_docs INTEGER,
  jcr_if_manual REAL,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(issn_print, sjr_year)
);

CREATE INDEX IF NOT EXISTS idx_jm_issn_print ON journal_metrics(issn_print);
CREATE INDEX IF NOT EXISTS idx_jm_issn_elec ON journal_metrics(issn_electronic);
