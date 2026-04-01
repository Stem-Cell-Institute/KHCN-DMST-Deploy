/**
 * Enrichment sau ORCID harvest: ISSN (ORCID / OpenAlex) + lookup SJR (journal_metrics)
 * + cập nhật index_db (Scopus / WoS / PubMed / DOAJ) từ ID bản ghi, OpenAlex indexed_in, và khi khớp SJR.
 */

try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch (_) {}

const path = require('path');

const OPENALEX_WORKS = 'https://api.openalex.org/works/';
const OPENALEX_UA = 'SCI-KHCN-App/1.0 (mailto:admin@sci.edu.vn)';
const BATCH_LIMIT = 50;
const FETCH_TIMEOUT_MS = 8000;
const OPENALEX_MIN_INTERVAL_MS = 300;

/**
 * Bản ghi «vào hàng đợi enrich»: pending, chưa gán, lỗi tạm thời, hoặc not_in_sjr
 * (sau khi Admin import SCImago — cần chạy lại để khớp journal_metrics).
 */
function sqlEligibleForEnrichWhere() {
  return `(
    COALESCE(NULLIF(TRIM(enrichment_status), ''), 'pending') IN ('pending', 'not_in_sjr', 'error')
  )`;
}

let openAlexNextSlot = 0;

function getDb() {
  return require(path.join(__dirname, '..', 'lib', 'db-bridge'));
}

async function dbAll(db, sql, params = []) {
  const out = db.prepare(sql).all(...params);
  return out instanceof Promise ? await out : out;
}

async function dbGet(db, sql, params = []) {
  const out = db.prepare(sql).get(...params);
  return out instanceof Promise ? await out : out;
}

async function dbRun(db, sql, params = []) {
  const out = db.prepare(sql).run(...params);
  return out instanceof Promise ? await out : out;
}

function normalizeIssn(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const compact = String(raw).replace(/[^0-9Xx]/g, '');
  if (compact.length !== 8) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4).toUpperCase()}`;
}

/** ISSN đã chuẩn hóa thỏa format XXXX-XXXX (sau normalize). */
function hasValidIssnFormat(issn) {
  return Boolean(issn && /^\d{4}-[\dX]{4}$/.test(issn));
}

/**
 * Khóa so khớp journal_metrics: 8 ký tự [0-9X], không gạch.
 * CSV SJR có thể lưu «12345678» hoặc «1234-5678» — so sánh theo compact tránh miss.
 */
function issnComparableKey(issnOrRaw) {
  if (issnOrRaw == null || String(issnOrRaw).trim() === '') return null;
  const c = String(issnOrRaw).replace(/[^0-9Xx]/g, '');
  if (c.length !== 8) return null;
  return c.toUpperCase();
}

/**
 * Một ô ISSN có thể chứa nhiều mã (in + điện tử). normalizeIssn(cả chuỗi) sẽ fail nếu > 8 chữ số.
 * @returns {string[]} ISSN chuẩn XXXX-XXXX, không trùng
 */
function collectNormalizedIssnsFromRawField(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  const s = String(raw).trim();
  const parts = s.split(/[,;/|]+/).map((x) => x.trim()).filter(Boolean);
  const chunks = parts.length ? parts : [s];
  const out = [];
  const seen = new Set();
  for (const ch of chunks) {
    const n = normalizeIssn(ch);
    if (n && hasValidIssnFormat(n) && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function cleanDoi(doi) {
  return String(doi)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .trim();
}

async function waitOpenAlexTurn() {
  const now = Date.now();
  const wait = Math.max(0, openAlexNextSlot - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  openAlexNextSlot = Date.now() + OPENALEX_MIN_INTERVAL_MS;
}

function collectIssnsFromOpenAlexSource(src) {
  if (!src || typeof src !== 'object') return [];
  const out = [];
  const push = (raw) => {
    const n = normalizeIssn(raw);
    if (n && !out.includes(n)) out.push(n);
  };
  if (src.issn_l) push(src.issn_l);
  if (Array.isArray(src.issn)) {
    for (const x of src.issn) push(x);
  }
  return out;
}

/**
 * GET https://api.openalex.org/works/https://doi.org/{doi}
 * @returns {Promise<null|{ issn: string|null, cited_by_count: number|null }>}
 *   null nếu 404 (work không tồn tại).
 */
async function fetchIssnFromOpenAlex(doi) {
  const d = cleanDoi(doi);
  if (!d) throw new Error('fetchIssnFromOpenAlex: DOI rỗng');

  await waitOpenAlexTurn();

  const workUrl = `${OPENALEX_WORKS}${encodeURIComponent(`https://doi.org/${d}`)}`;
  const mailto = 'admin@sci.edu.vn';
  const url = `${workUrl}${workUrl.includes('?') ? '&' : '?'}mailto=${encodeURIComponent(mailto)}`;

  const doFetch = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': OPENALEX_UA,
        },
      });
    } finally {
      clearTimeout(t);
    }
  };

  let res;
  try {
    res = await doFetch();
  } catch (e1) {
    try {
      res = await doFetch();
    } catch (e2) {
      const msg = e2.name === 'AbortError' ? 'OpenAlex timeout (8s)' : e2.message;
      throw new Error(`OpenAlex network lỗi sau retry: ${msg}`);
    }
  }

  if (res.status === 404) return null;

  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 500);
    } catch (_) {}
    throw new Error(`OpenAlex HTTP ${res.status}${body ? `: ${body}` : ''}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`OpenAlex: không parse được JSON — ${e.message}`);
  }

  const src = data?.primary_location?.source;
  const issns = collectIssnsFromOpenAlexSource(src);
  const issn = issns[0] || null;

  let cited_by_count = null;
  if (data.cited_by_count != null && data.cited_by_count !== '') {
    const n = Number(data.cited_by_count);
    cited_by_count = Number.isFinite(n) ? n : null;
  }

  const indexed_in = Array.isArray(data.indexed_in)
    ? data.indexed_in.map((x) => String(x).toLowerCase().trim()).filter(Boolean)
    : [];

  return { issn, cited_by_count, indexed_in };
}

/**
 * Tra journal_metrics chỉ theo ISSN (compact 8 ký tự, bỏ gạch). Không lọc theo năm xuất bản.
 * Nếu nhiều kỳ SJR: lấy bản ghi có sjr_year mới nhất trong CSDL.
 */
async function lookupSJR(db, issnCanonicalHyphenated) {
  const key = issnComparableKey(issnCanonicalHyphenated);
  if (!key) return null;
  const strip = (col) =>
    `upper(replace(replace(replace(replace(ifnull(${col}, ''), '-', ''), ' ', ''), char(9), ''), '.', ''))`;
  const issnClause = `(${strip('issn_print')} = ? OR ${strip('issn_electronic')} = ?)`;
  return dbGet(
    db,
    `SELECT * FROM journal_metrics
     WHERE ${issnClause}
     ORDER BY sjr_year DESC
     LIMIT 1`,
    [key, key]
  );
}

async function updatePublicationStatus(db, id, status, note) {
  await dbRun(
    db,
    `UPDATE publications SET
       enrichment_status = ?,
       enrichment_note = ?,
       enriched_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    [status, note || null, id]
  );
}

const hasId = (v) => v != null && String(v).trim() !== '';

/**
 * Chuỗi index_db (comma-separated) cho cột «Cơ sở dữ liệu» trên UI.
 * Nguồn: ID đã có trên bản ghi, OpenAlex indexed_in, và (nếu có) khớp SJR → Scopus.
 */
function buildIndexDb(pub, { indexedInOpenAlex = [], matchedSjr = false } = {}) {
  const labels = [];
  const seen = new Set();
  const norm = (s) => String(s).toLowerCase().trim();
  const add = (label) => {
    const t = String(label || '').trim();
    if (!t) return;
    const k = norm(t);
    if (seen.has(k)) return;
    seen.add(k);
    labels.push(t);
  };

  if (pub.index_db) {
    String(pub.index_db)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach(add);
  }

  if (hasId(pub.scopus_eid)) add('Scopus');
  if (hasId(pub.wos_id)) add('Web of Science');
  if (hasId(pub.pmid) || hasId(pub.pmc_id)) add('PubMed/MEDLINE');
  if (matchedSjr) add('Scopus');

  if (Array.isArray(indexedInOpenAlex)) {
    for (const x of indexedInOpenAlex) {
      const s = norm(x);
      if (s === 'pubmed') add('PubMed/MEDLINE');
      else if (s === 'doaj') add('DOAJ');
    }
  }

  return labels.join(', ');
}

/**
 * @returns {Promise<'success'|'failed'|'no_issn'|'not_in_sjr'>}
 */
async function enrichSinglePublication(pub) {
  const db = getDb();
  const id = Number(pub.id);
  if (!Number.isFinite(id)) return 'failed';

  let issnResolved = null;
  let issnSource = null;
  let openalexCite = pub.openalex_cite_count != null ? Number(pub.openalex_cite_count) : null;
  /** Chỉ có khi đã gọi OpenAlex theo DOI */
  let oaIndexedIn = [];

  /** Các ISSN hợp lệ từ cột bài báo (hỗ trợ nhiều mã trong một ô). */
  let issnCandidates = [];

  try {
    const rawIssn = pub.issn != null ? String(pub.issn).trim() : '';
    issnCandidates = collectNormalizedIssnsFromRawField(rawIssn);

    if (issnCandidates.length > 0) {
      issnResolved = issnCandidates[0];
      issnSource = 'orcid';
      const doiForMeta = pub.doi != null ? String(pub.doi).trim() : '';
      if (doiForMeta) {
        const oaMeta = await fetchIssnFromOpenAlex(doiForMeta);
        if (oaMeta) {
          oaIndexedIn = oaMeta.indexed_in || [];
          if (oaMeta.cited_by_count != null) openalexCite = oaMeta.cited_by_count;
        }
      }
    } else {
      const doi = pub.doi != null ? String(pub.doi).trim() : '';
      if (doi) {
        const oa = await fetchIssnFromOpenAlex(doi);
        if (oa === null) {
          const idxOnly = buildIndexDb(pub, { indexedInOpenAlex: [] });
          if (idxOnly) {
            await dbRun(
              db,
              `UPDATE publications SET index_db = ?, updated_at = datetime('now') WHERE id = ?`,
              [idxOnly, id]
            );
          }
          await updatePublicationStatus(
            db,
            id,
            'no_issn',
            'DOI không tìm thấy trên OpenAlex (404).'
          );
          return 'no_issn';
        }
        oaIndexedIn = oa.indexed_in || [];
        if (oa.cited_by_count != null) openalexCite = oa.cited_by_count;
        if (oa.issn && hasValidIssnFormat(oa.issn)) {
          issnResolved = oa.issn;
          issnSource = 'openalex_fallback';
        } else {
          const idxDb = buildIndexDb(pub, { indexedInOpenAlex: oaIndexedIn });
          await dbRun(
            db,
            `UPDATE publications SET
               openalex_cite_count = ?,
               index_db = ?,
               updated_at = datetime('now')
             WHERE id = ?`,
            [openalexCite, idxDb || null, id]
          );
          await updatePublicationStatus(
            db,
            id,
            'no_issn',
            'Không có ISSN hợp lệ từ ORCID và OpenAlex (issn_l / issn).'
          );
          return 'no_issn';
        }
      } else {
        const idxOnly = buildIndexDb(pub, { indexedInOpenAlex: [] });
        if (idxOnly) {
          await dbRun(
            db,
            `UPDATE publications SET index_db = ?, updated_at = datetime('now') WHERE id = ?`,
            [idxOnly, id]
          );
        }
        await updatePublicationStatus(
          db,
          id,
          'no_issn',
          'Thiếu ISSN và không có DOI để tra OpenAlex.'
        );
        return 'no_issn';
      }
    }

    const tryIssns = [];
    for (const c of issnCandidates) {
      if (!tryIssns.includes(c)) tryIssns.push(c);
    }
    if (issnResolved && !tryIssns.includes(issnResolved)) tryIssns.push(issnResolved);

    let jm = null;
    for (const cand of tryIssns) {
      jm = await lookupSJR(db, cand);
      if (jm) {
        issnResolved = cand;
        break;
      }
    }
    if (!jm) {
      const indexDb = buildIndexDb(pub, {
        indexedInOpenAlex: oaIndexedIn,
        matchedSjr: false,
      });
      const note = `Không có bản ghi journal_metrics cho ISSN ${issnResolved}.`;
      await dbRun(
        db,
        `UPDATE publications SET
           issn_resolved = ?,
           issn_source = ?,
           openalex_cite_count = ?,
           index_db = ?,
           enrichment_status = 'not_in_sjr',
           enrichment_note = ?,
           enriched_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?`,
        [issnResolved, issnSource, openalexCite, indexDb || null, note, id]
      );
      return 'not_in_sjr';
    }

    const quartile = jm.sjr_quartile != null ? String(jm.sjr_quartile).trim() : null;
    const sjrScore =
      jm.sjr_score == null || jm.sjr_score === '' ? null : Number(jm.sjr_score);
    const sjrYearUsed =
      jm.sjr_year == null || jm.sjr_year === '' ? null : Number(jm.sjr_year);
    const jcrIf =
      jm.jcr_if_manual == null || jm.jcr_if_manual === ''
        ? null
        : Number(jm.jcr_if_manual);
    const indexDb = buildIndexDb(pub, {
      indexedInOpenAlex: oaIndexedIn,
      matchedSjr: true,
    });

    await dbRun(
      db,
      `UPDATE publications SET
         issn_resolved = ?,
         issn_source = ?,
         quartile = ?,
         sjr_score = ?,
         sjr_year_used = ?,
         jcr_if = ?,
         openalex_cite_count = ?,
         index_db = ?,
         enrichment_status = 'enriched',
         enrichment_note = NULL,
         enriched_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`,
      [
        issnResolved,
        issnSource,
        quartile,
        sjrScore,
        sjrYearUsed,
        jcrIf,
        openalexCite,
        indexDb || null,
        id,
      ]
    );
    return 'success';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await updatePublicationStatus(db, id, 'error', msg.slice(0, 2000));
    } catch (_) {}
    return 'failed';
  }
}

/**
 * @param {number[]} [publicationIds] — rỗng/undefined: lấy hàng đợi enrich (pending / not_in_sjr / error), tối đa 50 bản ghi.
 * @returns {Promise<{ success: number, failed: number, skipped: number, no_issn: number, not_in_sjr: number }>}
 */
async function enrichPublicationBatch(publicationIds) {
  const db = getDb();
  let rows;

  if (publicationIds && publicationIds.length > 0) {
    const ids = publicationIds.slice(0, BATCH_LIMIT).map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (ids.length === 0) {
      return { success: 0, failed: 0, skipped: 0, no_issn: 0, not_in_sjr: 0 };
    }
    const ph = ids.map(() => '?').join(',');
    rows = await dbAll(
      db,
      `SELECT * FROM publications WHERE id IN (${ph})`,
      ids
    );
  } else {
    rows = await dbAll(
      db,
      `SELECT * FROM publications
       WHERE ${sqlEligibleForEnrichWhere()}
       ORDER BY id
       LIMIT ?`,
      [BATCH_LIMIT]
    );
  }

  let success = 0;
  let failed = 0;
  let noIssn = 0;
  let notInSjr = 0;

  for (const pub of rows) {
    const r = await enrichSinglePublication(pub);
    if (r === 'success') success += 1;
    else if (r === 'failed') failed += 1;
    else if (r === 'no_issn') noIssn += 1;
    else if (r === 'not_in_sjr') notInSjr += 1;
  }

  const skipped = noIssn + notInSjr;
  return { success, failed, skipped, no_issn: noIssn, not_in_sjr: notInSjr };
}

/**
 * @returns {Promise<{ total: number, enriched: number, pending: number, no_issn: number, not_in_sjr: number, error: number, enrich_eligible: number }>}
 */
async function getEnrichmentStats() {
  const db = getDb();
  const rows = await dbAll(
    db,
    `SELECT COALESCE(NULLIF(TRIM(enrichment_status), ''), 'pending') AS st, COUNT(*) AS c
     FROM publications
     GROUP BY COALESCE(NULLIF(TRIM(enrichment_status), ''), 'pending')`
  );

  const by = {
    enriched: 0,
    pending: 0,
    no_issn: 0,
    not_in_sjr: 0,
    error: 0,
  };
  let total = 0;
  for (const r of rows) {
    const c = Number(r.c) || 0;
    total += c;
    const st = r.st;
    if (Object.prototype.hasOwnProperty.call(by, st)) by[st] += c;
    else by.pending += c;
  }

  const q = await dbGet(
    db,
    `SELECT COUNT(*) AS c FROM publications WHERE ${sqlEligibleForEnrichWhere()}`
  );
  const enrichEligible = Number(q && q.c) || 0;

  return {
    total,
    enriched: by.enriched,
    pending: by.pending,
    no_issn: by.no_issn,
    not_in_sjr: by.not_in_sjr,
    error: by.error,
    enrich_eligible: enrichEligible,
  };
}

module.exports = {
  enrichPublicationBatch,
  getEnrichmentStats,
  sqlEligibleForEnrichWhere,
};
