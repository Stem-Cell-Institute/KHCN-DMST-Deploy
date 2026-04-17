CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  reason TEXT,
  proposal_summary TEXT,
  proposer_id INTEGER REFERENCES users(id),
  proposer_unit TEXT,
  current_step INTEGER NOT NULL DEFAULT 1 CHECK(current_step BETWEEN 1 AND 9),
  status TEXT NOT NULL DEFAULT 'in_progress',
  assigned_unit_id INTEGER REFERENCES units(id),
  assigned_to_id INTEGER REFERENCES users(id),
  assignment_deadline TEXT,
  legal_basis TEXT,
  scope TEXT,
  applicable_subjects TEXT,
  main_content TEXT,
  execution_clause TEXT,
  review_comment TEXT,
  review_result TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  review_at TEXT,
  feedback_summary TEXT,
  meeting_held INTEGER NOT NULL DEFAULT 0,
  meeting_minutes_note TEXT,
  explain_receive TEXT,
  submit_note TEXT,
  signed_confirmed INTEGER NOT NULL DEFAULT 0,
  publish_date TEXT,
  document_number TEXT,
  archived_at TEXT,
  expire_date TEXT,
  remind_after_days INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  category TEXT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT,
  file_size INTEGER,
  file_path TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_step ON documents(current_step);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
CREATE INDEX IF NOT EXISTS idx_documents_assigned_unit ON documents(assigned_unit_id);
CREATE INDEX IF NOT EXISTS idx_documents_assigned_to ON documents(assigned_to_id);
CREATE INDEX IF NOT EXISTS idx_document_attachments_document ON document_attachments(document_id);
CREATE INDEX IF NOT EXISTS idx_document_feedback_document ON document_feedback(document_id);
CREATE INDEX IF NOT EXISTS idx_document_history_document ON document_history(document_id);
