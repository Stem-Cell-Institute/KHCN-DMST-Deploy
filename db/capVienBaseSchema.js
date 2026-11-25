/**
 * Khởi tạo bảng gốc cap_vien_submissions, files, history và step_deadlines.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const appPaths = require('../lib/appPaths');
const db = require('../lib/db-bridge');

module.exports = function initCapVienBaseSchema() {
  const legacyCapVienDbPath = path.join(appPaths.sqliteDataDir(), 'de-tai-cap-vien.db');
  db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    submittedBy TEXT NOT NULL,
    submittedById INTEGER NOT NULL,
    status TEXT DEFAULT 'SUBMITTED',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cap_vien_submission_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    fieldName TEXT NOT NULL,
    originalName TEXT NOT NULL,
    path TEXT NOT NULL,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_public_template_files (
    task_code TEXT PRIMARY KEY,
    stored_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS cap_vien_code_sequences (
    year INTEGER PRIMARY KEY,
    seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS council_role_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    granted_by_id INTEGER,
    granted_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, role)
  );
`);
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewNote TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN revisionRound INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedByRole TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
  db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_step2_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    actionType TEXT NOT NULL,
    performedAt TEXT NOT NULL,
    performedById INTEGER,
    performedByName TEXT,
    performedByRole TEXT,
    note TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submission_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    stepId TEXT NOT NULL,
    actionType TEXT NOT NULL,
    performedAt TEXT NOT NULL,
    performedById INTEGER,
    performedByName TEXT,
    performedByRole TEXT,
    note TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
  db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_step_deadlines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    stepId TEXT NOT NULL,
    openedAt TEXT NOT NULL,
    dueAt TEXT NOT NULL,
    durationDays INTEGER,
    updatedById INTEGER,
    updatedAt TEXT NOT NULL,
    UNIQUE(submissionId, stepId),
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
  try { db.prepare('ALTER TABLE users ADD COLUMN academicTitle TEXT').run(); } catch (e) { /* đã tồn tại */ }
  try { db.prepare('ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('UPDATE users SET password_support_hint = NULL WHERE password_support_hint IS NOT NULL').run();
  } catch (e) { /* không có cột password_support_hint */ }
  try {
    db.exec('ALTER TABLE users DROP COLUMN password_support_hint');
  } catch (e) { /* SQLite < 3.35 hoặc cột đã xóa / chưa từng có */ }

  return { legacyCapVienDbPath };
};
