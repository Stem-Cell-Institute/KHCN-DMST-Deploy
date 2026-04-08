/**
 * Migration: Đăng ký tham dự Hội nghị/Hội thảo — bảng mới only.
 * @param {import('better-sqlite3').Database} db
 */
function runConferenceRegistrationsMigration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conference_registrations (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_code       TEXT UNIQUE,
      submitted_by_user_id  INTEGER NOT NULL,
      unit                  TEXT NOT NULL DEFAULT '',
      research_group        TEXT,
      job_title             TEXT,

      conf_name             TEXT NOT NULL DEFAULT '',
      conf_type             TEXT NOT NULL DEFAULT 'Trong nước' CHECK(conf_type IN ('Quốc tế','Trong nước')),
      conf_organizer        TEXT NOT NULL DEFAULT '',
      conf_start_date       TEXT NOT NULL DEFAULT '',
      conf_end_date         TEXT NOT NULL DEFAULT '',
      conf_location         TEXT NOT NULL DEFAULT '',
      conf_country          TEXT,
      conf_website          TEXT,

      invitation_status     TEXT NOT NULL DEFAULT 'Chưa có thư mời' CHECK(invitation_status IN (
                              'Đã có thư mời',
                              'Chưa có thư mời',
                              'Đang mở nộp bài'
                            )),
      invitation_file_path  TEXT,

      has_paper             INTEGER NOT NULL DEFAULT 0,
      paper_title           TEXT,
      paper_authors         TEXT,
      paper_type            TEXT CHECK(paper_type IN (
                              'Báo cáo toàn văn','Báo cáo tóm tắt',
                              'Poster','Không có bài'
                            )),
      paper_abstract        TEXT,
      paper_file_path       TEXT,

      funding_type          TEXT NOT NULL DEFAULT 'Tự túc hoàn toàn' CHECK(funding_type IN (
                              'Tự túc hoàn toàn',
                              'Đề nghị Viện hỗ trợ một phần',
                              'Đề nghị Viện hỗ trợ toàn bộ'
                            )),
      funding_requested_vnd INTEGER DEFAULT 0,
      funding_items         TEXT,
      funding_note          TEXT,

      purpose               TEXT NOT NULL DEFAULT '',

      status                TEXT NOT NULL DEFAULT 'draft' CHECK(status IN (
                              'draft',
                              'submitted',
                              'khcn_reviewing',
                              'khcn_approved',
                              'khcn_rejected',
                              'director_reviewing',
                              'director_approved',
                              'director_rejected',
                              'completed',
                              'cancelled'
                            )),

      khcn_reviewer_id      INTEGER,
      khcn_reviewed_at      TEXT,
      khcn_comment          TEXT,

      director_reviewer_id  INTEGER,
      director_reviewed_at  TEXT,
      director_comment      TEXT,

      evidence_uploaded_at  TEXT,
      evidence_note         TEXT,
      evidence_reminder_sent_at TEXT,

      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (submitted_by_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conference_attachments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL REFERENCES conference_registrations(id),
      file_type       TEXT NOT NULL CHECK(file_type IN (
                        'invitation',
                        'paper',
                        'evidence',
                        'other'
                      )),
      original_name   TEXT NOT NULL,
      stored_path     TEXT NOT NULL,
      file_size_bytes INTEGER,
      uploaded_by     INTEGER NOT NULL,
      uploaded_at     TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conference_audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL REFERENCES conference_registrations(id),
      actor_user_id   INTEGER NOT NULL,
      action          TEXT NOT NULL,
      old_status      TEXT,
      new_status      TEXT,
      comment         TEXT,
      ip_address      TEXT,
      user_agent      TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (actor_user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_conf_reg_user    ON conference_registrations(submitted_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_conf_reg_status  ON conference_registrations(status);
    CREATE INDEX IF NOT EXISTS idx_conf_reg_code    ON conference_registrations(submission_code);
    CREATE INDEX IF NOT EXISTS idx_conf_audit_reg   ON conference_audit_log(registration_id);
  `);
}

module.exports = runConferenceRegistrationsMigration;
