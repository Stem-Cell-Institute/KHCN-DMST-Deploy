/**
 * Parse & import SCImago Journal Rank CSV → bảng journal_metrics.
 * Dùng chung: CLI (scripts/import-sjr-csv.js) và POST /api/admin/sjr-csv-import.
 * DB: db-bridge (SQLite sync, Turso Local sync, Turso Remote async → hàm import là async).
 *
 * CSV: phân tách bằng ; — xuất từ https://www.scimagojr.com/journalrank.php → Export → CSV
 */

const { parse } = require('csv-parse/sync');

function maybeAwait(v) {
  return v && typeof v.then === 'function' ? v : Promise.resolve(v);
}

function normalizeIssn(token) {
  if (token == null) return null;
  const s = String(token).trim();
  if (!s) return null;
  const compact = s.replace(/[^0-9Xx]/g, '');
  if (compact.length !== 8) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4).toUpperCase()}`;
}

function parseIssnField(issnField) {
  if (issnField == null || String(issnField).trim() === '') {
    return { issn_print: null, issn_electronic: null };
  }
  const raw = String(issnField).trim();
  const chunks = raw.split(/[,;]+|\s+/).map((x) => x.trim()).filter(Boolean);
  const normalized = [];
  for (const c of chunks) {
    const n = normalizeIssn(c);
    if (n && !normalized.includes(n)) normalized.push(n);
  }
  return {
    issn_print: normalized[0] || null,
    issn_electronic: normalized[1] || null,
  };
}

function pickRow(row, ...candidates) {
  const keys = Object.keys(row);
  for (const name of candidates) {
    const lower = name.toLowerCase();
    const k = keys.find((key) => key.replace(/^\uFEFF/, '').toLowerCase() === lower);
    if (k !== undefined) return row[k];
  }
  return undefined;
}

function findTotalDocsColumn(row) {
  const keys = Object.keys(row);
  const k = keys.find((key) => /^total docs/i.test(key.replace(/^\uFEFF/, '').trim()));
  return k !== undefined ? row[k] : undefined;
}

function parseNumberEu(val) {
  if (val == null || String(val).trim() === '') return null;
  const s = String(val).trim().replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseIntSafe(val) {
  if (val == null || String(val).trim() === '') return null;
  const s = String(val).replace(/[^\d-]/g, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseIntLoose(val) {
  if (val == null || String(val).trim() === '') return null;
  const digits = String(val).replace(/\D/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function normalizeQuartile(val) {
  if (val == null) return null;
  const s = String(val).trim().toUpperCase();
  if (/^Q[1-4]$/.test(s)) return s;
  return null;
}

const JOURNAL_METRICS_DDL = `
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

async function ensureJournalMetricsTable(db) {
  await maybeAwait(db.exec(JOURNAL_METRICS_DDL));
}

/**
 * SCImago export đôi khi có dấu ngoặc Unicode hoặc ký tự «cứng» sau dấu " đóng trường,
 * khiến csv-parse (rtrim mặc định) báo CSV_NON_TRIMABLE_CHAR_AFTER_CLOSING_QUOTE.
 * Chuẩn hóa nhẹ + tắt rtrim khi parse giúp đọc được gần như toàn bộ file.
 */
function sanitizeScimagoCsvText(csvText) {
  let s = String(csvText || '');
  s = s.replace(/\uFEFF/g, '');
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const smartQuotes = {
    '\u201C': '"',
    '\u201D': '"',
    '\u201E': '"',
    '\u201F': '"',
    '\u2033': '"',
    '\u2018': "'",
    '\u2019': "'",
  };
  s = s.split('').map((ch) => smartQuotes[ch] || ch).join('');
  s = s.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');
  return s;
}

function parseScimagoCsvRecords(csvText) {
  const raw = sanitizeScimagoCsvText(csvText);
  if (!raw.trim()) {
    throw new Error('File CSV rỗng');
  }
  let records;
  try {
    records = parse(raw, {
      columns: true,
      delimiter: ';',
      relax_quotes: true,
      relax_column_count: true,
      rtrim: false,
      ltrim: false,
      skip_empty_lines: true,
      bom: true,
      trim: false,
    });
  } catch (e) {
    throw new Error(`Không đọc được CSV (cần file SCImago Export CSV, phân tách bằng ;): ${e.message}`);
  }
  if (!records.length) {
    throw new Error('CSV không có dòng dữ liệu (chỉ có header?)');
  }
  const headerKeys = Object.keys(records[0] || {});
  const joined = headerKeys.join(';').toLowerCase();
  if (!joined.includes('issn') && !/\btitle\b/i.test(joined)) {
    throw new Error(
      'Header CSV không giống SCImago (thiếu Issn/Title). Hãy tải đúng «Export → CSV» từ scimagojr.com, không dùng Excel .xlsx trực tiếp.'
    );
  }
  return records;
}

const UPSERT_SQL = `
INSERT INTO journal_metrics (
  issn_print, issn_electronic, journal_name, sjr_year,
  sjr_quartile, sjr_score, h_index, total_docs, updated_at
) VALUES (
  ?, ?, ?, ?,
  ?, ?, ?, ?, datetime('now')
)
ON CONFLICT(issn_print, sjr_year) DO UPDATE SET
  issn_electronic = excluded.issn_electronic,
  journal_name = excluded.journal_name,
  sjr_quartile = excluded.sjr_quartile,
  sjr_score = excluded.sjr_score,
  h_index = excluded.h_index,
  total_docs = excluded.total_docs,
  updated_at = datetime('now')
`;

async function runStmt(stmt, params) {
  const out = stmt.run(...params);
  return maybeAwait(out);
}

/**
 * @param {object} db — db-bridge (better-sqlite3–compatible API)
 * @param {string} csvText — nội dung UTF-8
 * @param {number} yearArg — năm kỳ SJR (vd. 2024)
 * @returns {Promise<{ ok: number, fail: number, total: number, errors: string[] }>}
 */
async function importScimagoCsvToJournalMetrics(db, csvText, yearArg) {
  const y = Number(yearArg);
  if (!Number.isFinite(y) || y < 1900 || y > 2100) {
    throw new Error('Năm SJR không hợp lệ (1900–2100)');
  }

  await ensureJournalMetricsTable(db);
  const stmt = db.prepare(UPSERT_SQL);
  const records = parseScimagoCsvRecords(csvText);

  let ok = 0;
  let fail = 0;
  const errors = [];
  const maxErr = 80;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const lineNo = i + 2;

    const issnRaw = pickRow(row, 'Issn', 'ISSN');
    const { issn_print, issn_electronic } = parseIssnField(issnRaw);

    if (!issn_print) {
      fail += 1;
      if (errors.length < maxErr) {
        const title = pickRow(row, 'Title', 'title') || '';
        errors.push(`Dòng ${lineNo}: bỏ qua (không ISSN) — ${String(title).slice(0, 80)}`);
      }
      continue;
    }

    const journal_name = pickRow(row, 'Title', 'title') || '';
    const sjr_quartile = normalizeQuartile(pickRow(row, 'SJR Best Quartile', 'SJR best quartile'));
    const sjr_score = parseNumberEu(pickRow(row, 'SJR', 'sjr'));
    const h_index = parseIntSafe(pickRow(row, 'H index', 'H Index'));
    const totalDocsVal = findTotalDocsColumn(row);
    const total_docs = parseIntLoose(totalDocsVal);

    try {
      await runStmt(stmt, [
        issn_print,
        issn_electronic,
        String(journal_name).trim() || null,
        y,
        sjr_quartile,
        sjr_score,
        h_index,
        total_docs,
      ]);
      ok += 1;
    } catch (e) {
      fail += 1;
      if (errors.length < maxErr) {
        errors.push(`Dòng ${lineNo} ISSN ${issn_print}: ${e.message || String(e)}`);
      }
    }
  }

  return { ok, fail, total: records.length, errors };
}

module.exports = {
  importScimagoCsvToJournalMetrics,
  parseScimagoCsvRecords,
  ensureJournalMetricsTable,
  normalizeIssn,
};
