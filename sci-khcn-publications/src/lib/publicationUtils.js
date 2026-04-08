/**
 * Tiện ích dùng chung: kiểm tra trùng công bố và insert một bản ghi publications.
 * Dùng cho POST /api/publications và POST /api/publications/import-bibtex.
 */

/** Chuẩn hóa DOI để so khớp (trim + lowercase). */
export function normalizeDoiForDedup(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw).trim().toLowerCase();
}

/**
 * Normalize title for duplicate detection.
 * Apply to both DB titles and BibTeX/ORCID titles before comparison.
 */
export function normalizeTitle(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\\#/g, '#')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, '`')
    .replace(/\{([^{}]*)\}/g, '$1')
    .replace(/\{([^{}]*)\}/g, '$1')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\s*[…]{1,}\s*$/, '')
    .replace(/\s*\.{2,}\s*$/, '')
    .replace(/^id:\s*\d+\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Min length of the shorter title for prefix-based duplicate match (avoid false positives). */
const MIN_TITLE_PREFIX_LEN = 12;

/**
 * Duplicate if normalized titles are equal, or the longer one starts with the shorter + space
 * (e.g. BibTeX "Stem cells … treatment" vs CSDL "Stem cells … treatment preface").
 */
export function normalizedTitlesMatchForDedup(tNorm, rowNorm) {
  if (!tNorm || !rowNorm) return false;
  if (tNorm === rowNorm) return true;
  const shorter = tNorm.length <= rowNorm.length ? tNorm : rowNorm;
  const longer = tNorm.length <= rowNorm.length ? rowNorm : tNorm;
  if (shorter.length < MIN_TITLE_PREFIX_LEN) return false;
  return longer.startsWith(`${shorter} `);
}

/**
 * Truy vấn tương thích SQLite (db.prepare) và Neon (template function).
 */
async function queryAll(db, sql, params = []) {
  if (db.__isSQLite) return db.prepare(sql).all(...params);
  const r = await db(sql, params);
  return r.rows || r;
}

/**
 * Columns bound on INSERT (single source of truth — avoids "N values for M columns").
 * created_at / updated_at use table DEFAULT.
 */
const INSERT_PUBLICATION_COLUMNS = [
  'doi',
  'pmid',
  'scopus_eid',
  'wos_id',
  'patent_no',
  'title',
  'title_vi',
  'abstract',
  'keywords',
  'language',
  'authors',
  'authors_json',
  'corresponding',
  'sci_authors',
  'pub_type',
  'journal_name',
  'issn',
  'isbn',
  'volume',
  'pages',
  'pub_year',
  'pub_date',
  'publisher',
  'conference_name',
  'conference_location',
  'index_db',
  'quartile',
  'impact_factor',
  'cite_score',
  'sjr',
  'is_open_access',
  'oa_type',
  'citation_count',
  'project_code',
  'funder',
  'grant_no',
  'status',
  'submitted_at',
  'accepted_at',
  'file_url',
  'url',
  'source',
  'import_source',
  'created_by',
];

/**
 * Chạy INSERT một dòng publications (cùng cột như route POST hiện tại).
 * @param {object} db — kết quả getDB()
 * @param {object} data — đã qua sanitizePublicationInput (đủ trường giống INSERT cũ)
 * @param {number} createdByUserId — req.user.id hoặc 1
 * @param {string|null} importSource — orcid | google_scholar | bibtex | manual | null
 * @returns {Promise<{ lastInsertRowid: number }>}
 */
export async function insertPublication(db, data, createdByUserId, importSource = null) {
  const placeholders = INSERT_PUBLICATION_COLUMNS.map(() => '?').join(', ');
  const sql = `INSERT INTO publications (${INSERT_PUBLICATION_COLUMNS.join(', ')}) VALUES (${placeholders})`;
  const isoImport =
    importSource != null && String(importSource).trim() !== ''
      ? String(importSource).trim()
      : null;
  const params = INSERT_PUBLICATION_COLUMNS.map((col) => {
    if (col === 'source') return data.source || 'manual';
    if (col === 'import_source') return isoImport;
    if (col === 'created_by') return createdByUserId;
    return data[col];
  });
  if (params.length !== INSERT_PUBLICATION_COLUMNS.length) {
    throw new Error(
      `insertPublication: internal mismatch params=${params.length} cols=${INSERT_PUBLICATION_COLUMNS.length}`
    );
  }
  if (db.__isSQLite) {
    const r = db.prepare(sql).run(...params);
    return { lastInsertRowid: Number(r.lastInsertRowid) };
  }
  const r = await db(sql, params);
  const id = r?.lastInsertRowid ?? r?.rows?.[0]?.id;
  return { lastInsertRowid: Number(id) || 0 };
}

/**
 * Kiểm tra trùng với CSDL publications.
 * - Có DOI: khớp theo DOI đã chuẩn hóa; nếu không khớp vẫn so title+năm (DB có thể chưa có DOI).
 * - Có năm hợp lệ: cùng pub_year và (title normalize trùng hoặc một là tiền tố của kia + space).
 * - Không có năm: so với mọi bản ghi CSDL cùng quy tắc tiêu đề → reason title_no_year.
 * @returns {Promise<{ isDuplicate: boolean, existingId: number|null, reason?: string }>}
 */
export async function checkDuplicatePublication(db, { doi, title, year }) {
  const doiNorm = normalizeDoiForDedup(doi);
  if (doiNorm) {
    const rows = await queryAll(
      db,
      `SELECT id FROM publications WHERE LOWER(TRIM(COALESCE(doi, ''))) = ? LIMIT 1`,
      [doiNorm]
    );
    const row = rows[0];
    if (row && row.id != null) {
      return { isDuplicate: true, existingId: Number(row.id), reason: 'doi' };
    }
  }

  const t = title != null ? String(title).trim() : '';
  if (!t) return { isDuplicate: false, existingId: null };

  const tNorm = normalizeTitle(t);
  if (!tNorm) return { isDuplicate: false, existingId: null };

  const y = year != null && year !== '' ? Number(year) : null;

  if (y != null && !Number.isNaN(y)) {
    const candidates = await queryAll(
      db,
      `SELECT id, title FROM publications WHERE pub_year = ?`,
      [y]
    );
    for (const row of candidates) {
      const rowNorm = normalizeTitle(row.title);
      if (normalizedTitlesMatchForDedup(tNorm, rowNorm)) {
        return { isDuplicate: true, existingId: Number(row.id), reason: 'title_year' };
      }
    }
    return { isDuplicate: false, existingId: null };
  }

  const allRows = await queryAll(
    db,
    `SELECT id, title FROM publications WHERE title IS NOT NULL AND TRIM(title) != ''`
  );
  for (const row of allRows) {
    const rowNorm = normalizeTitle(row.title);
    if (normalizedTitlesMatchForDedup(tNorm, rowNorm)) {
      return { isDuplicate: true, existingId: Number(row.id), reason: 'title_no_year' };
    }
  }

  return { isDuplicate: false, existingId: null };
}
