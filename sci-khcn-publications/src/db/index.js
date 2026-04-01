/**
 * src/db/index.js
 * Khởi tạo database và schema cho module Công bố Khoa học
 *
 * - Dev:  SQLite via better-sqlite3 (file: ./data/sci_khcn.db)
 * - Prod: Neon PostgreSQL via @neondatabase/serverless
 *
 * Cursor prompt: "Kết nối hàm getDB() vào pool Neon hiện có của project"
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';

let _db = null;

// ── Lấy instance DB (singleton) ───────────────────────────────────────────────
export async function getDB() {
  if (_db) return _db;
  // Ưu tiên dùng DB pool/bridge hiện có của hệ thống chính (không tạo pool mới)
  try {
    const require = createRequire(import.meta.url);
    const sharedDb = require('../../../lib/db-bridge');
    if (sharedDb && typeof sharedDb.prepare === 'function') {
      // Router trong module đang check cờ này để dùng nhánh prepare(...).all/run
      if (typeof sharedDb.__isSQLite === 'undefined') sharedDb.__isSQLite = true;
      _db = sharedDb;
      return _db;
    }
  } catch (_) {
    // Fallback sang mode standalone của module
  }

  if (IS_PROD) {
    // Neon PostgreSQL — dùng pool đã có trong project
    const { neon } = await import('@neondatabase/serverless');
    _db = neon(process.env.DATABASE_URL);
  } else {
    // SQLite local
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const dbPath = path.resolve(__dirname, '../../data/sci_khcn.db');
    _db = new Database(dbPath, { verbose: console.log });
    _db.__isSQLite = true;
  }
  return _db;
}

// ── Khởi tạo schema ───────────────────────────────────────────────────────────
export async function initDB() {
  const db = await getDB();
  const sql = SCHEMA_SQL;

  if (db.__isSQLite) {
    // SQLite: chạy trực tiếp; nếu DB cũ đã có bảng publications schema tối giản
    // thì fallback sang migrate cột thiếu để tương thích module ORCID/DOI.
    try {
      db.exec(sql);
    } catch (_) {
      // continue with compatibility migration below
    }
    ensureSQLiteCompatibility(db);
    console.log('[DB] SQLite schema initialized');
  } else {
    // Neon: chạy qua tagged template
    await db`${sql}`;
    console.log('[DB] Neon PostgreSQL schema initialized');
  }
}

function ensureSQLiteCompatibility(db) {
  const cols = [
    ['doi', 'TEXT'],
    ['pmid', 'TEXT'],
    ['pmc_id', 'TEXT'],
    ['scopus_eid', 'TEXT'],
    ['wos_id', 'TEXT'],
    ['patent_no', 'TEXT'],
    ['title', "TEXT DEFAULT ''"],
    ['title_vi', 'TEXT'],
    ['abstract', 'TEXT'],
    ['keywords', 'TEXT'],
    ['language', "TEXT DEFAULT 'en'"],
    ['authors', "TEXT DEFAULT ''"],
    ['authors_json', 'TEXT'],
    ['corresponding', 'TEXT'],
    ['sci_authors', 'TEXT'],
    ['pub_type', "TEXT DEFAULT 'journal'"],
    ['journal_name', 'TEXT'],
    ['issn', 'TEXT'],
    ['isbn', 'TEXT'],
    ['volume', 'TEXT'],
    ['pages', 'TEXT'],
    ['pub_year', 'INTEGER'],
    ['pub_date', 'TEXT'],
    ['publisher', 'TEXT'],
    ['conference_name', 'TEXT'],
    ['conference_location', 'TEXT'],
    ['index_db', 'TEXT'],
    ['quartile', 'TEXT'],
    ['impact_factor', 'REAL'],
    ['cite_score', 'REAL'],
    ['sjr', 'REAL'],
    ['h5_index', 'INTEGER'],
    ['is_open_access', 'INTEGER DEFAULT 0'],
    ['oa_type', 'TEXT'],
    ['citation_count', 'INTEGER DEFAULT 0'],
    ['citation_updated_at', 'TEXT'],
    ['project_code', 'TEXT'],
    ['funder', 'TEXT'],
    ['grant_no', 'TEXT'],
    ['status', "TEXT DEFAULT 'published'"],
    ['submitted_at', 'TEXT'],
    ['accepted_at', 'TEXT'],
    ['file_url', 'TEXT'],
    ['url', 'TEXT'],
    ['source', "TEXT DEFAULT 'manual'"],
    ['orcid_put_code', 'TEXT'],
    ['created_by', 'INTEGER'],
    ['updated_at', "TEXT DEFAULT (datetime('now'))"],
    // Enrichment / SJR & OpenAlex (migration 002_publications_enrichment)
    ['issn_resolved', 'TEXT'],
    ['issn_source', 'TEXT'],
    ['sjr_score', 'REAL'],
    ['sjr_year_used', 'INTEGER'],
    ['jcr_if', 'REAL'],
    ['openalex_cite_count', 'INTEGER'],
    ['enrichment_status', "TEXT DEFAULT 'pending'"],
    ['enrichment_note', 'TEXT'],
    ['enriched_at', 'TEXT'],
  ];
  cols.forEach(([name, type]) => {
    try { db.prepare(`ALTER TABLE publications ADD COLUMN ${name} ${type}`).run(); } catch (_) {}
  });
  try { db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS ux_publications_doi ON publications(doi)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_year ON publications(pub_year)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_quartile ON publications(quartile)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_status ON publications(status)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_type ON publications(pub_type)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_project ON publications(project_code)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_orcid_put ON publications(orcid_put_code)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_wos ON publications(wos_id)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_scopus_eid ON publications(scopus_eid)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_pmid ON publications(pmid)').run(); } catch (_) {}
  try { db.prepare('CREATE INDEX IF NOT EXISTS idx_pub_pmc ON publications(pmc_id)').run(); } catch (_) {}
}

// ── Schema SQL (tương thích SQLite & PostgreSQL) ───────────────────────────────
const SCHEMA_SQL = `
-- ============================================================
-- BẢNG CHÍNH: Công bố Khoa học
-- Mỗi record = 1 công bố (bài báo, hội nghị, sách, bằng sáng chế…)
-- ============================================================
CREATE TABLE IF NOT EXISTS publications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- PostgreSQL: SERIAL hoặc BIGSERIAL
  
  -- ── Định danh ──────────────────────────────────────────────
  doi             TEXT UNIQUE,          -- 10.xxxx/xxxxx  (NULL nếu chưa có / bằng sáng chế)
  scopus_eid      TEXT,                 -- 2-s2.0-XXXXXXXXX
  wos_id          TEXT,                 -- WOS:000XXXXXXXXX
  pmid            TEXT,                 -- PubMed ID
  pmc_id          TEXT,                 -- PubMed Central (PMCxxxxxxx)
  patent_no       TEXT,                 -- Số bằng sáng chế / GPHI

  -- ── Nội dung cơ bản ────────────────────────────────────────
  title           TEXT NOT NULL,
  title_vi        TEXT,                 -- Tiêu đề tiếng Việt (nếu có)
  abstract        TEXT,
  keywords        TEXT,                 -- "k1; k2; k3"
  language        TEXT DEFAULT 'en',   -- 'en' | 'vi'

  -- ── Tác giả ────────────────────────────────────────────────
  authors         TEXT NOT NULL,        -- "Họ A, Họ B, Họ C" — full list
  authors_json    TEXT,                 -- JSON array: [{name, orcid, affil, isSCI}]
  corresponding   TEXT,                 -- Tên tác giả liên hệ
  sci_authors     TEXT,                 -- Tác giả thuộc SCI (dùng để highlight)

  -- ── Xuất bản ───────────────────────────────────────────────
  pub_type        TEXT NOT NULL DEFAULT 'journal',
                  -- journal | conference | book_chapter | book | patent | preprint | dataset
  journal_name    TEXT,
  issn            TEXT,
  isbn            TEXT,
  volume          TEXT,                 -- "Vol. 45, No. 3"
  pages           TEXT,                 -- "pp. 112–125"
  pub_year        INTEGER,
  pub_date        TEXT,                 -- ISO date "2024-03-15"
  publisher       TEXT,
  conference_name TEXT,
  conference_location TEXT,

  -- ── Chỉ số & Phân hạng ─────────────────────────────────────
  index_db        TEXT,                 -- "Scopus,WoS,PubMed" — comma-separated
  quartile        TEXT,                 -- Q1 | Q2 | Q3 | Q4
  impact_factor   REAL,                 -- IF năm xuất bản
  cite_score      REAL,
  sjr             REAL,
  h5_index        INTEGER,
  is_open_access  INTEGER DEFAULT 0,    -- 0=No, 1=Yes
  oa_type         TEXT,                 -- gold | green | diamond | hybrid

  -- ── Trích dẫn (cập nhật định kỳ) ──────────────────────────
  citation_count  INTEGER DEFAULT 0,
  citation_updated_at TEXT,             -- ISO timestamp lần cập nhật cuối

  -- ── Liên kết đề tài KHCN ───────────────────────────────────
  project_code    TEXT,                 -- Mã đề tài (FK → bảng projects)
  funder          TEXT,                 -- "ĐHQG-HCM, Bộ KH&CN"
  grant_no        TEXT,                 -- Mã tài trợ
  
  -- ── Trạng thái workflow ────────────────────────────────────
  status          TEXT DEFAULT 'published',
                  -- draft | under_review | accepted | published | retracted
  submitted_at    TEXT,
  accepted_at     TEXT,
  
  -- ── File đính kèm ──────────────────────────────────────────
  file_url        TEXT,                 -- R2/S3 URL preprint/manuscript
  url             TEXT,                 -- URL bài báo gốc

  -- ── Nguồn gốc dữ liệu ──────────────────────────────────────
  source          TEXT DEFAULT 'manual',-- manual | orcid_harvest | doi_fetch | import_bulk
  orcid_put_code  TEXT,                 -- put-code trong ORCID record (để dedup)

  -- ── Audit ──────────────────────────────────────────────────
  created_by      INTEGER,              -- FK → users.id
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- BẢNG: ORCID của Nghiên cứu viên SCI
-- Admin quản lý — dùng cho harvest tự động
-- ============================================================
CREATE TABLE IF NOT EXISTS researcher_orcids (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name   TEXT NOT NULL,
  orcid_id    TEXT NOT NULL UNIQUE,     -- 0000-0002-XXXX-XXXX
  department  TEXT,
  position    TEXT,                     -- GS, PGS, TS, ThS, NCS…
  is_active   INTEGER DEFAULT 1,        -- 1=tích cực quét, 0=tạm dừng
  last_harvested_at   TEXT,             -- ISO timestamp lần quét gần nhất
  last_work_count     INTEGER,          -- số works ORCID lần quét trước
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- BẢNG: Log lịch sử harvest ORCID
-- Mỗi lần chạy harvest = 1 session, mỗi NCV = 1 log row
-- ============================================================
CREATE TABLE IF NOT EXISTS orcid_harvest_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,        -- UUID của lần harvest
  researcher_id   INTEGER,              -- FK → researcher_orcids.id
  orcid_id        TEXT NOT NULL,
  works_found     INTEGER DEFAULT 0,
  new_found       INTEGER DEFAULT 0,
  skipped_dup     INTEGER DEFAULT 0,
  error_msg       TEXT,
  harvested_at    TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- BẢNG: Queue công bố mới chờ duyệt (từ ORCID harvest)
-- Chưa được import chính thức → cần admin xem xét
-- ============================================================
CREATE TABLE IF NOT EXISTS publication_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  doi             TEXT,
  raw_data        TEXT,                 -- JSON từ Crossref/ORCID
  enriched_data   TEXT,                 -- JSON sau khi enrich Scopus/WoS
  detected_from   TEXT,                 -- orcid_id nguồn
  researcher_name TEXT,
  harvest_session TEXT,                 -- session_id
  status          TEXT DEFAULT 'pending',-- pending | approved | rejected | duplicate
  reviewed_by     INTEGER,
  reviewed_at     TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- INDEXES để query nhanh
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_pub_doi       ON publications(doi);
CREATE INDEX IF NOT EXISTS idx_pub_year      ON publications(pub_year);
CREATE INDEX IF NOT EXISTS idx_pub_quartile  ON publications(quartile);
CREATE INDEX IF NOT EXISTS idx_pub_status    ON publications(status);
CREATE INDEX IF NOT EXISTS idx_pub_type      ON publications(pub_type);
CREATE INDEX IF NOT EXISTS idx_pub_project   ON publications(project_code);
CREATE INDEX IF NOT EXISTS idx_pub_orcid_put ON publications(orcid_put_code);
CREATE INDEX IF NOT EXISTS idx_pub_wos        ON publications(wos_id);
CREATE INDEX IF NOT EXISTS idx_pub_scopus_eid ON publications(scopus_eid);
CREATE INDEX IF NOT EXISTS idx_pub_pmid       ON publications(pmid);
CREATE INDEX IF NOT EXISTS idx_pub_pmc        ON publications(pmc_id);
CREATE INDEX IF NOT EXISTS idx_queue_status  ON publication_queue(status);
CREATE INDEX IF NOT EXISTS idx_harvest_sess  ON orcid_harvest_logs(session_id);

-- ============================================================
-- BẢNG: SCImago Journal Metrics (SJR) — import từ CSV SCImago
-- ============================================================
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
`;
