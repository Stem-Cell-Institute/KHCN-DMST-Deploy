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
 * POST   /api/publications/bulk-import — Import từ file BibTeX / CSV / Excel (TODO)
 *
 * SSE (đăng ký trên app chính): mountEnrichmentStatsSse → GET /api/enrich/stream
 */

import { Router } from 'express';
import { getDB } from '../db/index.js';

export const publicationsRouter = Router();

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

// ── GET /api/publications/:id ─────────────────────────────────────────────────
publicationsRouter.get('/:id', async (req, res, next) => {
  try {
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

    // Check DOI trùng
    if (data.doi) {
      const [existing] = await queryAll(db,
        `SELECT id FROM publications WHERE doi = ?`, [data.doi]
      );
      if (existing) {
        return res.status(409).json({
          ok: false,
          error: `DOI này đã tồn tại trong hệ thống (id: ${existing.id})`,
          existing_id: existing.id,
        });
      }
    }

    const result = await queryRun(db, `
      INSERT INTO publications (
        doi, pmid, scopus_eid, wos_id, patent_no,
        title, title_vi, abstract, keywords, language,
        authors, authors_json, corresponding, sci_authors,
        pub_type, journal_name, issn, isbn, volume, pages,
        pub_year, pub_date, publisher, conference_name, conference_location,
        index_db, quartile, impact_factor, cite_score, sjr,
        is_open_access, oa_type, citation_count,
        project_code, funder, grant_no,
        status, submitted_at, accepted_at,
        file_url, url, source,
        created_by, created_at, updated_at
      ) VALUES (
        ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,
        ?,?,?,?,?,?, ?,?,?,?,?,
        ?,?,?,?,?, ?,?,?,
        ?,?,?, ?,?,?,
        ?,?, ?,?,datetime('now'),datetime('now')
      )`,
      [
        data.doi,           data.pmid,          data.scopus_eid,
        data.wos_id,        data.patent_no,
        data.title,         data.title_vi,       data.abstract,
        data.keywords,      data.language,
        data.authors,       data.authors_json,   data.corresponding,
        data.sci_authors,
        data.pub_type,      data.journal_name,   data.issn,
        data.isbn,          data.volume,         data.pages,
        data.pub_year,      data.pub_date,       data.publisher,
        data.conference_name, data.conference_location,
        data.index_db,      data.quartile,       data.impact_factor,
        data.cite_score,    data.sjr,
        data.is_open_access, data.oa_type,       data.citation_count,
        data.project_code,  data.funder,         data.grant_no,
        data.status,        data.submitted_at,   data.accepted_at,
        data.file_url,      data.url,            data.source || 'manual',
        req.user?.id || 1,
      ]
    );

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
