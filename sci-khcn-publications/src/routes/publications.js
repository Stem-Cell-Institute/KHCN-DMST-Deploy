/**
 * src/routes/publications.js
 * CRUD đầy đủ cho bảng publications
 *
 * GET    /api/publications             — Danh sách (filter, search, pagination)
 * GET    /api/publications/stats       — Thống kê (query: year_from, year_to, year)
 * GET    /api/publications/:id         — Chi tiết 1 công bố
 * POST   /api/publications             — Tạo mới (thủ công)
 * PUT    /api/publications/:id         — Cập nhật
 * DELETE /api/publications/:id         — Xóa
 * POST   /api/publications/import-bibtex — Import file .bib hoặc chuỗi BibTeX (multipart / JSON)
 * POST   /api/publications/preview-bibtex — So sánh BibTeX với CSDL (phân nhóm, không insert)
 * POST   /api/publications/import-bibtex-selected — Nhập có chọn entry_ids hoặc scope ready / ready_and_suspicious
 * POST   /api/publications/disambiguate-nv-researcher — Trust_Score (config NCV) + crawl URL (cheerio)
 *
 * SSE (đăng ký trên app chính): mountEnrichmentStatsSse → GET /api/enrich/stream
 */

import { Router } from 'express';
import multer from 'multer';
import { getDB } from '../db/index.js';
import {
  checkDuplicatePublication,
  insertPublication,
  normalizeTitle,
} from '../lib/publicationUtils.js';
import { parseBibTeX, pubTypeLabelToSlug } from '../lib/bibTexParser.js';
import { disambiguateItems } from '../lib/authorDisambiguation.js';
import { resolveResearcherKey } from '../lib/trustScoring.js';
import { publicationsAuthMiddleware } from '../middleware/publicationsAuthMiddleware.js';

export const publicationsRouter = Router();

/** Multer bộ nhớ tạm — chỉ dùng cho import BibTeX (tối đa 2MB). */
const bibtexUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

/** Chỉ chạy multer khi client gửi multipart/form-data. */
function importBibtexMultipartMaybe(req, res, next) {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('multipart/form-data')) {
    return bibtexUpload.single('bibfile')(req, res, next);
  }
  next();
}

/** import_source cho BibTeX: mặc định google_scholar; cho phép bibtex nếu client gửi rõ. */
function resolveBibtexImportSource(body) {
  const s = body?.import_source != null ? String(body.import_source).trim() : '';
  if (s === 'bibtex' || s === 'google_scholar') return s;
  return 'google_scholar';
}

/**
 * GET /api/enrich/stream — Server-Sent Events, push getEnrichmentStats() mỗi 4s.
 * Gắn lên `app` (không dùng publicationsRouter) để path đúng /api/enrich/stream.
 */
export function mountEnrichmentStatsSse(app, authMiddleware, getEnrichmentStats) {
  app.get('/api/enrich/stream', authMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const writeStats = async () => {
      try {
        const stats = await getEnrichmentStats();
        res.write(`data: ${JSON.stringify(stats)}\n\n`);
      } catch (e) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: e.message || String(e) })}\n\n`);
      }
    };

    writeStats();
    const tick = setInterval(writeStats, 4000);

    req.on('close', () => {
      clearInterval(tick);
    });
  });
}

function parseStatsYearFilter(query) {
  let yf =
    query.year_from != null && String(query.year_from).trim() !== ''
      ? parseInt(String(query.year_from), 10)
      : null;
  let yt =
    query.year_to != null && String(query.year_to).trim() !== ''
      ? parseInt(String(query.year_to), 10)
      : null;
  if (query.year != null && String(query.year).trim() !== '') {
    const y = parseInt(String(query.year), 10);
    if (!Number.isNaN(y)) {
      yf = y;
      yt = y;
    }
  }
  if (yf != null && Number.isNaN(yf)) yf = null;
  if (yt != null && Number.isNaN(yt)) yt = null;
  if (yf != null && yt == null) yt = yf;
  if (yt != null && yf == null) yf = yt;
  if (yf != null && yt != null && yf > yt) {
    const t = yf;
    yf = yt;
    yt = t;
  }
  const active = yf != null && yt != null && !Number.isNaN(yf) && !Number.isNaN(yt);
  return { active, yf, yt };
}

function emptyIndexExclusive() {
  return { scopus: 0, wos: 0, pubmed: 0, doaj: 0, conference: 0, other: 0 };
}

function rowsToExclusiveMap(rows) {
  const m = emptyIndexExclusive();
  for (const r of rows) {
    const k = r.idx_bucket || r.IDX_BUCKET;
    if (k && Object.prototype.hasOwnProperty.call(m, k)) m[k] = Number(r.cnt ?? r.CNT) || 0;
  }
  return m;
}

// ── GET /api/publications ─────────────────────────────────────────────────────
// Query params:
//   q         — tìm kiếm tự do (title, authors, doi, journal)
//   year      — năm xuất bản
//   pub_type  — journal | conference | book_chapter | patent | preprint
//   quartile  — Q1 | Q2 | Q3 | Q4
//   status    — published | accepted | under_review
//   index_db  — scopus | wos | pubmed (contains search)
//   project   — mã đề tài
//   page      — trang (default 1)
//   limit     — số kết quả (default 20, max 100)
//   sort      — pub_year | citation_count | impact_factor | created_at
//   order     — asc | desc (default desc)
publicationsRouter.get('/', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const {
      q, year, pub_type, quartile, status, index_db, project,
      page = 1, limit = 20, sort = 'pub_year', order = 'desc',
    } = req.query;

    const safeSorts  = ['pub_year', 'citation_count', 'impact_factor', 'created_at', 'title'];
    const safeOrders = ['asc', 'desc'];
    const sortCol    = safeSorts.includes(sort)   ? sort  : 'pub_year';
    const sortOrder  = safeOrders.includes(order) ? order : 'desc';
    const offset     = (Math.max(1, Number(page)) - 1) * Math.min(100, Number(limit));
    const take       = Math.min(100, Number(limit));

    // Build WHERE động
    const conditions = ['1=1'];
    const params = [];

    if (q) {
      conditions.push(`(title LIKE ? OR authors LIKE ? OR doi LIKE ? OR journal_name LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (year)      { conditions.push(`pub_year = ?`);            params.push(Number(year)); }
    if (pub_type)  { conditions.push(`pub_type = ?`);            params.push(pub_type); }
    if (quartile)  { conditions.push(`quartile = ?`);            params.push(quartile); }
    if (status)    { conditions.push(`status = ?`);              params.push(status); }
    if (project)   { conditions.push(`project_code = ?`);        params.push(project); }
    if (index_db)  { conditions.push(`index_db LIKE ?`);         params.push(`%${index_db}%`); }

    const where = conditions.join(' AND ');

    // Count total
    const [countRow] = await queryAll(db,
      `SELECT COUNT(*) as total FROM publications WHERE ${where}`,
      params
    );
    const total = countRow?.total || 0;

    // Fetch page
    const rows = await queryAll(db,
      `SELECT * FROM publications
       WHERE ${where}
       ORDER BY ${sortCol} ${sortOrder}
       LIMIT ? OFFSET ?`,
      [...params, take, offset]
    );

    res.json({
      ok: true,
      data: rows,
      pagination: {
        total,
        page:       Number(page),
        limit:      take,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/publications/stats ───────────────────────────────────────────────
publicationsRouter.get('/stats', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const { active: yearFilterActive, yf, yt } = parseStatsYearFilter(req.query);
    const yClause = yearFilterActive
      ? ' AND pub_year IS NOT NULL AND pub_year >= ? AND pub_year <= ? '
      : '';
    const yParams = yearFilterActive ? [yf, yt] : [];

    const [metaRow] = await queryAll(db, `
      SELECT
        MIN(pub_year) AS year_min,
        MAX(pub_year) AS year_max
      FROM publications
      WHERE status != 'retracted' AND pub_year IS NOT NULL
    `);

    const meta = {
      yearMin: metaRow?.year_min != null ? Number(metaRow.year_min) : null,
      yearMax: metaRow?.year_max != null ? Number(metaRow.year_max) : null,
    };

    const [totals] = await queryAll(
      db,
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN quartile='Q1' THEN 1 ELSE 0 END) as q1,
        SUM(CASE WHEN quartile='Q2' THEN 1 ELSE 0 END) as q2,
        SUM(CASE WHEN quartile='Q3' THEN 1 ELSE 0 END) as q3,
        SUM(CASE WHEN quartile='Q4' THEN 1 ELSE 0 END) as q4,
        SUM(CASE WHEN pub_type='journal' THEN 1 ELSE 0 END) as journals,
        SUM(CASE WHEN pub_type='conference' THEN 1 ELSE 0 END) as conferences,
        SUM(CASE WHEN pub_type='book_chapter' THEN 1 ELSE 0 END) as book_chapters,
        SUM(CASE WHEN pub_type='preprint' THEN 1 ELSE 0 END) as preprints,
        SUM(CASE WHEN pub_type='patent' THEN 1 ELSE 0 END) as patents,
        SUM(CASE WHEN pub_type='patent' AND status='under_review' THEN 1 ELSE 0 END) as patents_pending,
        SUM(CASE WHEN is_open_access=1 THEN 1 ELSE 0 END) as open_access,
        SUM(citation_count) as total_citations,
        AVG(CASE WHEN impact_factor IS NOT NULL THEN impact_factor END) as avg_if,
        MAX(impact_factor) as max_if,
        AVG(CASE WHEN quartile='Q1' AND impact_factor IS NOT NULL THEN impact_factor END) as avg_if_q1,
        AVG(CASE WHEN quartile='Q2' AND impact_factor IS NOT NULL THEN impact_factor END) as avg_if_q2
      FROM publications
      WHERE status != 'retracted' ${yClause}
    `,
      yParams
    );

    const byYear = await queryAll(
      db,
      `
      SELECT pub_year, COUNT(*) as count,
             SUM(citation_count) as citations
      FROM publications
      WHERE pub_year IS NOT NULL AND status != 'retracted' ${yClause}
      GROUP BY pub_year
      ORDER BY pub_year ASC
    `,
      yParams
    );

    const indexStatsRows = await queryAll(
      db,
      `
      SELECT
        SUM(CASE WHEN index_db LIKE '%Scopus%' THEN 1 ELSE 0 END) as scopus,
        SUM(CASE WHEN index_db LIKE '%WoS%' OR index_db LIKE '%Web of Science%' THEN 1 ELSE 0 END) as wos,
        SUM(CASE WHEN index_db LIKE '%PubMed%' THEN 1 ELSE 0 END) as pubmed,
        SUM(CASE WHEN index_db LIKE '%DOAJ%' THEN 1 ELSE 0 END) as doaj,
        SUM(CASE WHEN index_db LIKE '%Scopus%' OR index_db LIKE '%WoS%' OR index_db LIKE '%Web of Science%' THEN 1 ELSE 0 END) as scopus_or_wos
      FROM publications WHERE status != 'retracted' ${yClause}
    `,
      yParams
    );

    const exRows = await queryAll(
      db,
      `
      SELECT idx_bucket, COUNT(*) AS cnt FROM (
        SELECT
          CASE
            WHEN LOWER(COALESCE(index_db,'')) LIKE '%scopus%' THEN 'scopus'
            WHEN LOWER(COALESCE(index_db,'')) LIKE '%web of science%'
              OR LOWER(COALESCE(index_db,'')) LIKE '%wos%' THEN 'wos'
            WHEN LOWER(COALESCE(index_db,'')) LIKE '%pubmed%' THEN 'pubmed'
            WHEN LOWER(COALESCE(index_db,'')) LIKE '%doaj%' THEN 'doaj'
            WHEN pub_type = 'conference' THEN 'conference'
            ELSE 'other'
          END AS idx_bucket
        FROM publications
        WHERE status != 'retracted' ${yClause}
      ) t
      GROUP BY idx_bucket
    `,
      yParams
    );
    const indexExclusive = rowsToExclusiveMap(exRows);

    const [sidebarTypes] = await queryAll(db, `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN pub_type='journal' THEN 1 ELSE 0 END) AS journals,
        SUM(CASE WHEN pub_type='conference' THEN 1 ELSE 0 END) AS conferences,
        SUM(CASE WHEN pub_type='book_chapter' THEN 1 ELSE 0 END) AS book_chapters,
        SUM(CASE WHEN pub_type='preprint' THEN 1 ELSE 0 END) AS preprints,
        SUM(CASE WHEN pub_type='patent' THEN 1 ELSE 0 END) AS patents
      FROM publications WHERE status != 'retracted'
    `);

    const [sidebarQ] = await queryAll(db, `
      SELECT
        SUM(CASE WHEN quartile='Q1' THEN 1 ELSE 0 END) AS q1,
        SUM(CASE WHEN quartile='Q2' THEN 1 ELSE 0 END) AS q2,
        SUM(CASE WHEN quartile='Q3' THEN 1 ELSE 0 END) AS q3,
        SUM(CASE WHEN quartile='Q4' THEN 1 ELSE 0 END) AS q4
      FROM publications WHERE status != 'retracted'
    `);

    const sidebarIdx = await queryAll(db, `
      SELECT
        SUM(CASE WHEN index_db LIKE '%Scopus%' THEN 1 ELSE 0 END) AS scopus,
        SUM(CASE WHEN index_db LIKE '%WoS%' OR index_db LIKE '%Web of Science%' THEN 1 ELSE 0 END) AS wos,
        SUM(CASE WHEN index_db LIKE '%PubMed%' THEN 1 ELSE 0 END) AS pubmed,
        SUM(CASE WHEN index_db LIKE '%DOAJ%' THEN 1 ELSE 0 END) AS doaj
      FROM publications WHERE status != 'retracted'
    `);

    const [sidebarStatus] = await queryAll(db, `
      SELECT
        SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,
        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status='under_review' THEN 1 ELSE 0 END) AS under_review
      FROM publications WHERE status != 'retracted'
    `);

    const [globalHead] = await queryAll(db, `
      SELECT
        SUM(citation_count) AS total_citations,
        SUM(CASE WHEN quartile='Q1' OR quartile='Q2' THEN 1 ELSE 0 END) AS q1_q2,
        SUM(CASE WHEN index_db LIKE '%Scopus%' OR index_db LIKE '%WoS%' OR index_db LIKE '%Web of Science%' THEN 1 ELSE 0 END) AS scopus_or_wos
      FROM publications WHERE status != 'retracted'
    `);

    res.json({
      ok: true,
      data: {
        meta,
        filter: yearFilterActive ? { yearFrom: yf, yearTo: yt } : null,
        totals,
        byYear,
        indexStats: indexStatsRows[0] || {},
        indexExclusive,
        sidebar: {
          types: sidebarTypes || {},
          quartiles: sidebarQ || {},
          index: sidebarIdx[0] || {},
          status: sidebarStatus || {},
        },
        header: {
          total: Number(sidebarTypes?.total) || 0,
          scopusOrWos: Number(globalHead?.scopus_or_wos) || 0,
          q1q2: Number(globalHead?.q1_q2) || 0,
          totalCitations: Number(globalHead?.total_citations) || 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/publications/import-bibtex ──────────────────────────────────────
// multipart: field bibfile | JSON: { "bibtex": "..." } — cần đăng nhập JWT.
publicationsRouter.post(
  '/import-bibtex',
  publicationsAuthMiddleware,
  importBibtexMultipartMaybe,
  async (req, res, next) => {
    try {
      let raw = '';
      if (req.file && req.file.buffer) {
        raw = req.file.buffer.toString('utf8');
      } else if (req.body && typeof req.body.bibtex === 'string') {
        raw = req.body.bibtex;
      }
      if (!String(raw).trim()) {
        return res.status(400).json({
          ok: false,
          message: 'Thiếu nội dung BibTeX (gửi file field bibfile hoặc JSON bibtex).',
        });
      }

      let items = [];
      try {
        items = parseBibTeX(raw);
      } catch (e) {
        return res.status(400).json({
          ok: false,
          message: 'Không parse được BibTeX: ' + (e.message || String(e)),
        });
      }

      const seenInFile = new Set();
      const dedupedItems = [];
      for (const item of items) {
        if (!item.title) {
          dedupedItems.push(item);
          continue;
        }
        const key = normalizeTitle(item.title) + '||' + (item.year ?? '');
        if (!seenInFile.has(key)) {
          seenInFile.add(key);
          dedupedItems.push(item);
        }
      }

      const db = await getDB();
      const uid = req.user?.id != null ? Number(req.user.id) : 1;
      const bibImportSource = resolveBibtexImportSource(req.body);
      let imported = 0;
      const skippedList = [];
      const errorList = [];

      for (const item of dedupedItems) {
        const r = await tryInsertParsedBibItem(db, item, uid, bibImportSource);
        if (r.outcome === 'imported') imported += 1;
        else if (r.outcome === 'skipped') {
          skippedList.push({ title: r.titleLine, reason: r.reason });
        } else {
          errorList.push({ title: r.titleLine, reason: r.reason });
        }
      }

      res.json({
        ok: true,
        imported,
        skipped: skippedList.length,
        skippedList,
        errors: errorList.length ? errorList : undefined,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/publications/preview-bibtex ─────────────────────────────────────
// So sánh BibTeX với CSDL (không insert). Trả về phân nhóm: trùng file, trùng DB, sẵn sàng, nghi ngờ, lỗi.
publicationsRouter.post(
  '/preview-bibtex',
  publicationsAuthMiddleware,
  importBibtexMultipartMaybe,
  async (req, res, next) => {
    try {
      let raw = '';
      if (req.file && req.file.buffer) {
        raw = req.file.buffer.toString('utf8');
      } else if (req.body && typeof req.body.bibtex === 'string') {
        raw = req.body.bibtex;
      }
      if (!String(raw).trim()) {
        return res.status(400).json({
          ok: false,
          message: 'Thiếu nội dung BibTeX (field bibfile hoặc JSON bibtex).',
        });
      }

      const db = await getDB();
      let result;
      try {
        result = await analyzeBibtexAgainstDb(db, raw);
      } catch (e) {
        if (e && e.code === 'BIB_PARSE') {
          return res.status(400).json({
            ok: false,
            message: 'Không parse được BibTeX: ' + (e.message || String(e)),
          });
        }
        throw e;
      }

      res.json({
        ok: true,
        stats: result.stats,
        entries: result.entries,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/publications/import-bibtex-selected ─────────────────────────────
// Nhập có chọn lọc: entry_ids (từ preview) hoặc scope ready | ready_and_suspicious.
publicationsRouter.post(
  '/import-bibtex-selected',
  publicationsAuthMiddleware,
  importBibtexMultipartMaybe,
  async (req, res, next) => {
    try {
      let raw = '';
      if (req.file && req.file.buffer) {
        raw = req.file.buffer.toString('utf8');
      } else if (req.body && typeof req.body.bibtex === 'string') {
        raw = req.body.bibtex;
      }
      if (!String(raw).trim()) {
        return res.status(400).json({
          ok: false,
          message: 'Thiếu nội dung BibTeX.',
        });
      }

      let items = [];
      try {
        items = parseBibTeX(raw);
      } catch (e) {
        return res.status(400).json({
          ok: false,
          message: 'Không parse được BibTeX: ' + (e.message || String(e)),
        });
      }

      const db = await getDB();
      const uid = req.user?.id != null ? Number(req.user.id) : 1;
      const bibImportSource = resolveBibtexImportSource(req.body);

      const analysis = await analyzeBibtexAgainstDb(db, raw);
      const { entries } = analysis;

      const bodyEntryIds = req.body.entry_ids ?? req.body.entryIds;
      const entryIds = Array.isArray(bodyEntryIds)
        ? bodyEntryIds.map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : [];

      const scopeRaw = String(req.body.scope || '').toLowerCase().replace(/-/g, '_');
      const scope =
        scopeRaw === 'ready_and_suspicious' || scopeRaw === 'all_importable'
          ? 'ready_and_suspicious'
          : 'ready';

      const importable = new Set(['ready', 'suspicious']);
      const pickItems = [];

      if (entryIds.length > 0) {
        const byId = new Map(entries.map((e) => [e.entryId, e]));
        const seenRaw = new Set();
        for (const id of entryIds) {
          const e = byId.get(id);
          if (!e) continue;
          if (!importable.has(e.category)) continue;
          if (seenRaw.has(e.rawIndex)) continue;
          seenRaw.add(e.rawIndex);
          pickItems.push(items[e.rawIndex]);
        }
      } else {
        for (const e of entries) {
          if (e.category === 'ready') {
            pickItems.push(items[e.rawIndex]);
            continue;
          }
          if (scope === 'ready_and_suspicious' && e.category === 'suspicious') {
            pickItems.push(items[e.rawIndex]);
          }
        }
      }

      let imported = 0;
      const skippedList = [];
      const errorList = [];

      for (const item of pickItems) {
        const r = await tryInsertParsedBibItem(db, item, uid, bibImportSource);
        if (r.outcome === 'imported') imported += 1;
        else if (r.outcome === 'skipped') {
          skippedList.push({ title: r.titleLine, reason: r.reason });
        } else {
          errorList.push({ title: r.titleLine, reason: r.reason });
        }
      }

      res.json({
        ok: true,
        imported,
        skipped: skippedList.length,
        skippedList,
        errors: errorList.length ? errorList : undefined,
        attempted: pickItems.length,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/publications/disambiguate-nv-researcher ─────────────────────────
// Lọc định danh NCV: keyword + năm + crawl detail_url (BeautifulSoup/cheerio trên server).
publicationsRouter.post(
  '/disambiguate-nv-researcher',
  publicationsAuthMiddleware,
  async (req, res, next) => {
    try {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      if (!items.length) {
        return res.status(400).json({ ok: false, message: 'Thiếu mảng items.' });
      }
      if (items.length > 200) {
        return res.status(400).json({
          ok: false,
          message: 'Tối đa 200 bài mỗi lần.',
        });
      }
      const rawResearcher =
        req.body.researcherKey != null && String(req.body.researcherKey).trim() !== ''
          ? String(req.body.researcherKey).trim()
          : req.query.researcherKey != null && String(req.query.researcherKey).trim() !== ''
            ? String(req.query.researcherKey).trim()
            : '';
      const researcherKey = resolveResearcherKey(rawResearcher);
      const results = await disambiguateItems(items, {
        timeoutMs: 15000,
        crawlDelayMs: 450,
        researcherKey,
      });
      res.json({
        ok: true,
        results,
        researcher_query: rawResearcher || null,
        researcher_resolved_key: researcherKey,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/publications/:id ─────────────────────────────────────────────────
publicationsRouter.get('/:id', async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const db = await getDB();
    const [row] = await queryAll(db,
      `SELECT * FROM publications WHERE id = ?`,
      [Number(req.params.id)]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Không tìm thấy' });
    res.json({ ok: true, data: row });
  } catch (err) { next(err); }
});

// ── POST /api/publications ────────────────────────────────────────────────────
publicationsRouter.post('/', async (req, res, next) => {
  try {
    const db = await getDB();
    const data = sanitizePublicationInput(req.body);

    if (!data.title) {
      return res.status(400).json({ ok: false, error: 'Cần có trường title' });
    }

    const dup = await checkDuplicatePublication(db, {
      doi: data.doi,
      title: data.title,
      year: data.pub_year,
    });
    if (dup.isDuplicate) {
      let errMsg;
      if (dup.reason === 'doi') {
        errMsg = `DOI này đã tồn tại trong hệ thống (id: ${dup.existingId})`;
      } else if (dup.reason === 'title_no_year') {
        errMsg = `Trùng tiêu đề với CSDL (id: ${dup.existingId}) — không có năm hợp lệ để so khớp theo cặp tiêu đề+năm.`;
      } else {
        errMsg = `Trùng tiêu đề và năm xuất bản (id: ${dup.existingId})`;
      }
      return res.status(409).json({
        ok: false,
        error: errMsg,
        existing_id: dup.existingId,
        reason: dup.reason,
      });
    }

    const uid = req.user?.id != null ? Number(req.user.id) : 1;
    const result = await insertPublication(db, data, uid, 'manual');

    res.status(201).json({ ok: true, id: result.lastInsertRowid || result });
  } catch (err) { next(err); }
});

// ── PUT /api/publications/:id ─────────────────────────────────────────────────
publicationsRouter.put('/:id', async (req, res, next) => {
  try {
    const db = await getDB();
    const id = Number(req.params.id);
    const data = sanitizePublicationInput(req.body);

    await queryRun(db, `
      UPDATE publications SET
        doi=COALESCE(?,doi), title=COALESCE(?,title),
        abstract=?, keywords=?, authors=COALESCE(?,authors),
        sci_authors=?, journal_name=?, issn=?,
        volume=?, pages=?, pub_year=?, pub_date=?,
        index_db=?, quartile=?, impact_factor=?,
        cite_score=?, sjr=?,
        is_open_access=COALESCE(?,is_open_access),
        status=COALESCE(?,status),
        project_code=?, funder=?, grant_no=?,
        updated_at=datetime('now')
      WHERE id=?`,
      [
        data.doi, data.title,
        data.abstract, data.keywords, data.authors,
        data.sci_authors, data.journal_name, data.issn,
        data.volume, data.pages, data.pub_year, data.pub_date,
        data.index_db, data.quartile, data.impact_factor,
        data.cite_score, data.sjr,
        data.is_open_access,
        data.status,
        data.project_code, data.funder, data.grant_no,
        id,
      ]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/publications/:id ──────────────────────────────────────────────
publicationsRouter.delete('/:id', async (req, res, next) => {
  try {
    const db = await getDB();
    await queryRun(db, `DELETE FROM publications WHERE id = ?`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitizePublicationInput(body) {
  return {
    doi:                body.doi?.trim() || null,
    pmid:               body.pmid || null,
    scopus_eid:         body.scopus_eid || null,
    wos_id:             body.wos_id || null,
    patent_no:          body.patent_no || null,
    title:              body.title?.trim() || null,
    title_vi:           body.title_vi || null,
    abstract:           body.abstract || null,
    keywords:           body.keywords || null,
    language:           body.language || 'en',
    authors:            body.authors || null,
    authors_json:       typeof body.authors_json === 'object'
                          ? JSON.stringify(body.authors_json)
                          : body.authors_json || null,
    corresponding:      body.corresponding || null,
    sci_authors:        body.sci_authors || null,
    pub_type:           body.pub_type || 'journal',
    journal_name:       body.journal_name || null,
    issn:               body.issn || null,
    isbn:               body.isbn || null,
    volume:             body.volume || null,
    pages:              body.pages || null,
    pub_year:           body.pub_year ? Number(body.pub_year) : null,
    pub_date:           body.pub_date || null,
    publisher:          body.publisher || null,
    conference_name:    body.conference_name || null,
    conference_location: body.conference_location || null,
    index_db:           body.index_db || null,
    quartile:           ['Q1','Q2','Q3','Q4'].includes(body.quartile) ? body.quartile : null,
    impact_factor:      body.impact_factor ? Number(body.impact_factor) : null,
    cite_score:         body.cite_score ? Number(body.cite_score) : null,
    sjr:                body.sjr ? Number(body.sjr) : null,
    is_open_access:     body.is_open_access ? 1 : 0,
    oa_type:            body.oa_type || null,
    citation_count:     body.citation_count ? Number(body.citation_count) : 0,
    project_code:       body.project_code || null,
    funder:             body.funder || null,
    grant_no:           body.grant_no || null,
    status:             body.status || 'published',
    submitted_at:       body.submitted_at || null,
    accepted_at:        body.accepted_at || null,
    file_url:           body.file_url || null,
    url:                body.url || null,
    source:             body.source || 'manual',
  };
}

async function queryAll(db, sql, params = []) {
  if (db.__isSQLite) return db.prepare(sql).all(...params);
  const r = await db(sql, params); return r.rows || r;
}
async function queryRun(db, sql, params = []) {
  if (db.__isSQLite) return db.prepare(sql).run(...params);
  return db(sql, params);
}

function bibParsedItemToBodyLike(item) {
  const volStr =
    item.volume && item.number
      ? `${item.volume}(${item.number})`
      : item.volume || item.number || null;
  const authorsStr =
    item.authors != null && String(item.authors).trim() !== ''
      ? String(item.authors).trim()
      : '(Author not listed in BibTeX)';
  return {
    title: item.title,
    authors: authorsStr,
    pub_year: item.year,
    journal_name: item.journal,
    volume: volStr,
    pages: item.pages,
    doi: item.doi,
    abstract: item.abstract,
    url: item.url,
    keywords: item.keywords,
    pub_type: pubTypeLabelToSlug(item.pub_type),
    source: 'bibtex_import',
  };
}

/**
 * Insert one parsed BibTeX row using the same rules as bulk import-bibtex.
 * @returns {{ outcome: 'imported'|'skipped'|'error', titleLine: string, reason?: string }}
 */
async function tryInsertParsedBibItem(db, item, uid, bibImportSource) {
  const titleOne = item.title ? String(item.title).trim() : '';
  if (!titleOne) {
    return { outcome: 'error', titleLine: '(Không có tiêu đề)', reason: 'Thiếu tiêu đề' };
  }

  const dup = await checkDuplicatePublication(db, {
    doi: item.doi,
    title: item.title,
    year: item.year,
  });
  if (dup.isDuplicate) {
    let reason = 'Trùng tiêu đề và năm';
    if (dup.reason === 'doi') reason = 'Trùng DOI';
    else if (dup.reason === 'title_no_year') {
      reason = 'Không có năm · trùng tiêu đề (CSDL)';
    }
    return {
      outcome: 'skipped',
      titleLine: titleOne,
      reason,
    };
  }

  try {
    const data = sanitizePublicationInput(bibParsedItemToBodyLike(item));
    await insertPublication(db, data, uid, bibImportSource);
    return { outcome: 'imported', titleLine: titleOne };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err);
    const isUniqueViolation =
      msg.includes('UNIQUE constraint failed') ||
      msg.includes('SQLITE_CONSTRAINT_UNIQUE') ||
      /unique constraint/i.test(msg) ||
      msg.includes('duplicate key') ||
      err.code === '23505';

    if (isUniqueViolation) {
      return {
        outcome: 'skipped',
        titleLine: titleOne,
        reason: 'Trùng (phát hiện qua DB constraint)',
      };
    }
    return { outcome: 'error', titleLine: titleOne, reason: msg };
  }
}

async function buildDbTitleNormIndex(db) {
  const rows = await queryAll(db, `SELECT id, title, pub_year FROM publications`);
  const byNorm = new Map();
  for (const row of rows) {
    const n = normalizeTitle(row.title);
    if (!n) continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push({ id: row.id, year: row.pub_year });
  }
  return byNorm;
}

/**
 * Classify every parsed BibTeX row (full file order, including duplicates inside file).
 */
async function analyzeBibtexAgainstDb(db, rawText) {
  let items;
  try {
    items = parseBibTeX(rawText);
  } catch (e) {
    const er = new Error(e.message || String(e));
    er.code = 'BIB_PARSE';
    throw er;
  }

  const byNorm = await buildDbTitleNormIndex(db);
  const entries = [];
  const stats = {
    total_raw: 0,
    duplicate_file: 0,
    duplicate_db: 0,
    duplicate_db_no_year: 0,
    ready: 0,
    suspicious: 0,
    error: 0,
  };

  const firstKeyToEntryId = new Map();

  for (let rawIndex = 0; rawIndex < items.length; rawIndex++) {
    const item = items[rawIndex];
    stats.total_raw += 1;
    const entryId = entries.length;

    const snapshot = {
      title: item.title,
      year: item.year,
      doi: item.doi,
      authors: item.authors || null,
      journal: item.journal || null,
      pub_type_label: item.pub_type || null,
      url: item.url || null,
    };

    if (!item.title || !String(item.title).trim()) {
      entries.push({
        entryId,
        rawIndex,
        category: 'error',
        message: 'Thiếu tiêu đề',
        item: snapshot,
      });
      stats.error += 1;
      continue;
    }

    const key = normalizeTitle(item.title) + '||' + (item.year ?? '');
    if (firstKeyToEntryId.has(key)) {
      entries.push({
        entryId,
        rawIndex,
        category: 'duplicate_file',
        duplicateOfEntryId: firstKeyToEntryId.get(key),
        item: snapshot,
      });
      stats.duplicate_file += 1;
      continue;
    }
    firstKeyToEntryId.set(key, entryId);

    const dup = await checkDuplicatePublication(db, {
      doi: item.doi,
      title: item.title,
      year: item.year,
    });
    if (dup.isDuplicate) {
      const noYearDup = dup.reason === 'title_no_year';
      entries.push({
        entryId,
        rawIndex,
        category: noYearDup ? 'duplicate_db_no_year' : 'duplicate_db',
        duplicateReason: dup.reason,
        existingId: dup.existingId,
        item: snapshot,
      });
      if (noYearDup) stats.duplicate_db_no_year += 1;
      else stats.duplicate_db += 1;
      continue;
    }

    const tNorm = normalizeTitle(item.title);
    const yNum =
      item.year != null && item.year !== '' ? Number(item.year) : null;

    let suspicious = null;
    if (yNum == null || Number.isNaN(yNum)) {
      suspicious = {
        kind: 'missing_year',
        detail:
          'Không có năm trong BibTeX — hệ thống không thể khớp trùng theo tiêu đề+năm; nên kiểm tra trước khi nhập.',
      };
    } else {
      const matches = byNorm.get(tNorm) || [];
      const otherYears = matches.filter(
        (m) => m.year != null && Number(m.year) !== yNum
      );
      if (otherYears.length) {
        suspicious = {
          kind: 'title_other_year',
          detail:
            'Cùng tiêu đề (đã chuẩn hóa) đã có trong CSDL nhưng khác năm xuất bản.',
          matches: otherYears.slice(0, 8).map((m) => ({
            id: m.id,
            pub_year: m.year,
          })),
        };
      }
    }

    if (suspicious) {
      entries.push({
        entryId,
        rawIndex,
        category: 'suspicious',
        suspicious,
        item: snapshot,
      });
      stats.suspicious += 1;
    } else {
      entries.push({
        entryId,
        rawIndex,
        category: 'ready',
        item: snapshot,
      });
      stats.ready += 1;
    }
  }

  return { entries, stats };
}
