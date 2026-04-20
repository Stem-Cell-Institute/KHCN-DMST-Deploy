ALTER TABLE documents ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at);
