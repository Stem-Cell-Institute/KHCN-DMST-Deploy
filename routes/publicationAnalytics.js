/**
 * Thống kê công bố KHCN — API /api/pub-analytics
 * CSDL: publications (+ publication_authors), views trong queries/publication_analytics.sql
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { buildPublicationReportBuffer } = require('../services/wordReportBuilder');
const { logDashboardAccess, clientIp } = require('../middleware/checkDashboardPermission');

const PUB_DASHBOARD_ID = 'pub_analytics';

const QUERIES_FILE = path.join(__dirname, '..', 'queries', 'publication_analytics.sql');

let schemaEnsured = false;

function ensurePublicationAnalyticsSchema(db) {
  if (schemaEnsured) return;
  try {
    if (fs.existsSync(QUERIES_FILE)) {
      db.exec(fs.readFileSync(QUERIES_FILE, 'utf8'));
    }
    schemaEnsured = true;
  } catch (e) {
    console.warn('[pub-analytics] ensure schema:', e.message);
  }
}

function parseYear(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1900 || v > 2100) return null;
  return Math.floor(v);
}

function parseYearRange(query) {
  const fromY = parseYear(query.from);
  const toY = parseYear(query.to);
  if (fromY != null && toY != null && fromY > toY) return { error: 'from phải <= to' };
  return { fromY, toY };
}

function yearFilterSql(fromY, toY) {
  if (fromY == null && toY == null) return { sql: '', params: [] };
  if (fromY != null && toY != null) {
    return { sql: ' AND pub_year >= ? AND pub_year <= ? ', params: [fromY, toY] };
  }
  if (fromY != null) return { sql: ' AND pub_year >= ? ', params: [fromY] };
  return { sql: ' AND pub_year <= ? ', params: [toY] };
}

function parseLimit(raw, def, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

/** Cờ lập chỉ mục — cùng logic gần với GET /api/publications/stats */
function sqlIndexedFlags(alias) {
  const a = alias || 'p';
  return {
    scopus: `(
      COALESCE(${a}.index_db, '') LIKE '%Scopus%'
      OR (${a}.scopus_eid IS NOT NULL AND TRIM(${a}.scopus_eid) != '')
    )`,
    wos: `(
      COALESCE(${a}.index_db, '') LIKE '%WoS%'
      OR COALESCE(${a}.index_db, '') LIKE '%Web of Science%'
      OR (${a}.wos_id IS NOT NULL AND TRIM(${a}.wos_id) != '')
    )`,
    pubmed: `(
      COALESCE(${a}.index_db, '') LIKE '%PubMed%'
      OR (${a}.pmid IS NOT NULL AND TRIM(${a}.pmid) != '')
    )`,
    doaj: `(COALESCE(${a}.index_db, '') LIKE '%DOAJ%')`,
  };
}

function fetchKpiSnapshotRange(db, fromY, toY) {
  const f = sqlIndexedFlags('p');
  return db
    .prepare(
      `SELECT
        COUNT(*) AS total_papers,
        SUM(p.citation_count) AS total_citations,
        ROUND(AVG(p.citation_count), 2) AS avg_citations,
        ROUND(AVG(NULLIF(p.impact_factor, 0)), 3) AS avg_if,
        MAX(p.impact_factor) AS max_if,
        SUM(CASE WHEN p.quartile IN ('Q1', 'Q2') THEN 1 ELSE 0 END) AS top_tier_count,
        ROUND(
          SUM(CASE WHEN p.quartile IN ('Q1', 'Q2') THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0),
          1
        ) AS top_tier_pct,
        SUM(CASE WHEN ${f.scopus} THEN 1 ELSE 0 END) AS scopus_count,
        SUM(CASE WHEN ${f.wos} THEN 1 ELSE 0 END) AS wos_count,
        SUM(CASE WHEN ${f.pubmed} THEN 1 ELSE 0 END) AS pubmed_count,
        SUM(CASE WHEN ${f.doaj} THEN 1 ELSE 0 END) AS doaj_count,
        ROUND(SUM(
          CASE
            WHEN p.quartile = 'Q1' THEN 2.0
            WHEN p.quartile = 'Q2' THEN 1.5
            WHEN p.quartile = 'Q3' THEN 1.0
            WHEN p.quartile = 'Q4' THEN 0.75
            ELSE 0
          END
        ), 2) AS tt26_total_score
      FROM publications p
      WHERE p.status = 'published'
        AND p.pub_year >= ?
        AND p.pub_year <= ?`
    )
    .get(fromY, toY);
}

function parseOptionalPlanParam(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

module.exports = function createPublicationAnalyticsRouter({ db }) {
  ensurePublicationAnalyticsSchema(db);
  const router = express.Router();

  router.get('/yearly-output', (req, res) => {
    try {
      const { fromY, toY, error } = parseYearRange(req.query);
      if (error) return res.status(400).json({ ok: false, error });

      let sql = 'SELECT * FROM v_yearly_output WHERE 1=1';
      const params = [];
      if (fromY != null) {
        sql += ' AND year >= ?';
        params.push(fromY);
      }
      if (toY != null) {
        sql += ' AND year <= ?';
        params.push(toY);
      }
      sql += ' ORDER BY year ASC';
      const rows = db.prepare(sql).all(...params);
      return res.json({ ok: true, data: rows });
    } catch (e) {
      console.error('[pub-analytics/yearly-output]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  router.get('/quartile-distribution', (req, res) => {
    try {
      const { fromY, toY, error } = parseYearRange(req.query);
      if (error) return res.status(400).json({ ok: false, error });

      let sql = 'SELECT * FROM v_quartile_distribution WHERE 1=1';
      const params = [];
      if (fromY != null) {
        sql += ' AND year >= ?';
        params.push(fromY);
      }
      if (toY != null) {
        sql += ' AND year <= ?';
        params.push(toY);
      }
      sql += ' ORDER BY year ASC';
      const rows = db.prepare(sql).all(...params);
      return res.json({ ok: true, data: rows });
    } catch (e) {
      console.error('[pub-analytics/quartile-distribution]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  router.get('/top-authors', (req, res) => {
    try {
      const { fromY, toY, error } = parseYearRange(req.query);
      if (error) return res.status(400).json({ ok: false, error });
      const limit = parseLimit(req.query.limit, 15, 100);
      const yf = yearFilterSql(fromY, toY);

      const sql = `
        SELECT
          author_name,
          COUNT(*) AS paper_count,
          SUM(pub_citations) AS total_citations,
          ROUND(AVG(impact_factor), 2) AS avg_if
        FROM (
          SELECT
            pa.author_name,
            pa.publication_id,
            MAX(COALESCE(p.citation_count, 0)) AS pub_citations,
            MAX(p.impact_factor) AS impact_factor
          FROM publication_authors pa
          INNER JOIN publications p ON pa.publication_id = p.id
          WHERE p.status = 'published'
            ${yf.sql.replace(/pub_year/g, 'p.pub_year')}
          GROUP BY pa.author_name, pa.publication_id
        ) t
        GROUP BY author_name
        ORDER BY paper_count DESC, total_citations DESC
        LIMIT ?
      `;
      const params = [...yf.params, limit];
      const rows = db.prepare(sql).all(...params);
      return res.json({ ok: true, data: rows, meta: { limit, from: fromY, to: toY } });
    } catch (e) {
      console.error('[pub-analytics/top-authors]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  router.get('/kpi-snapshot', (req, res) => {
    try {
      const year = parseYear(req.query.year);
      if (year == null) {
        return res.status(400).json({ ok: false, error: 'Thiếu hoặc sai year (YYYY)' });
      }
      const f = sqlIndexedFlags('p');
      const row = db
        .prepare(
          `SELECT
            COUNT(*) AS total_papers,
            SUM(p.citation_count) AS total_citations,
            ROUND(AVG(p.citation_count), 2) AS avg_citations,
            ROUND(AVG(NULLIF(p.impact_factor, 0)), 3) AS avg_if,
            MAX(p.impact_factor) AS max_if,
            SUM(CASE WHEN p.quartile IN ('Q1', 'Q2') THEN 1 ELSE 0 END) AS top_tier_count,
            ROUND(
              SUM(CASE WHEN p.quartile IN ('Q1', 'Q2') THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0),
              1
            ) AS top_tier_pct,
            SUM(CASE WHEN ${f.scopus} THEN 1 ELSE 0 END) AS scopus_count,
            SUM(CASE WHEN ${f.wos} THEN 1 ELSE 0 END) AS wos_count,
            SUM(CASE WHEN ${f.pubmed} THEN 1 ELSE 0 END) AS pubmed_count,
            SUM(CASE WHEN ${f.doaj} THEN 1 ELSE 0 END) AS doaj_count,
            ROUND(SUM(
              CASE
                WHEN p.quartile = 'Q1' THEN 2.0
                WHEN p.quartile = 'Q2' THEN 1.5
                WHEN p.quartile = 'Q3' THEN 1.0
                WHEN p.quartile = 'Q4' THEN 0.75
                ELSE 0
              END
            ), 2) AS tt26_total_score
          FROM publications p
          WHERE p.status = 'published'
            AND p.pub_year = ?`
        )
        .get(year);
      return res.json({ ok: true, data: row || {}, meta: { year } });
    } catch (e) {
      console.error('[pub-analytics/kpi-snapshot]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  router.get('/top-journals', (req, res) => {
    try {
      const { fromY, toY, error } = parseYearRange(req.query);
      if (error) return res.status(400).json({ ok: false, error });
      const limit = parseLimit(req.query.limit, 10, 100);
      const yf = yearFilterSql(fromY, toY);

      const sql = `
        SELECT
          journal_name,
          COUNT(*) AS paper_count,
          SUM(citation_count) AS total_citations,
          ROUND(AVG(NULLIF(impact_factor, 0)), 3) AS avg_if
        FROM publications
        WHERE status = 'published'
          AND journal_name IS NOT NULL
          AND TRIM(journal_name) != ''
          ${yf.sql}
        GROUP BY journal_name
        ORDER BY paper_count DESC, total_citations DESC
        LIMIT ?
      `;
      const rows = db.prepare(sql).all(...yf.params, limit);
      return res.json({ ok: true, data: rows, meta: { limit, from: fromY, to: toY } });
    } catch (e) {
      console.error('[pub-analytics/top-journals]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  router.get('/citations-ranking', (req, res) => {
    try {
      const { fromY, toY, error } = parseYearRange(req.query);
      if (error) return res.status(400).json({ ok: false, error });
      const limit = parseLimit(req.query.limit, 20, 200);
      const yf = yearFilterSql(fromY, toY);

      const sql = `
        SELECT
          id,
          title,
          authors,
          journal_name,
          pub_year,
          quartile,
          impact_factor,
          citation_count,
          doi
        FROM publications
        WHERE status = 'published'
          ${yf.sql}
        ORDER BY (citation_count IS NULL) ASC, citation_count DESC, id DESC
        LIMIT ?
      `;
      const rows = db.prepare(sql).all(...yf.params, limit);
      return res.json({ ok: true, data: rows, meta: { limit, from: fromY, to: toY } });
    } catch (e) {
      console.error('[pub-analytics/citations-ranking]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  /** KPI tổng hợp theo khoảng năm (dashboard) */
  router.get('/kpi-range', (req, res) => {
    try {
      const fromY = parseYear(req.query.from);
      const toY = parseYear(req.query.to);
      if (fromY == null || toY == null) {
        return res.status(400).json({ ok: false, error: 'Bắt buộc from và to (YYYY)' });
      }
      if (fromY > toY) {
        return res.status(400).json({ ok: false, error: 'from phải <= to' });
      }
      const kpi = fetchKpiSnapshotRange(db, fromY, toY) || {};
      return res.json({ ok: true, data: kpi, meta: { from: fromY, to: toY } });
    } catch (e) {
      console.error('[pub-analytics/kpi-range]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  /** IF trung bình theo năm (biểu đồ đường) */
  router.get('/yearly-if', (req, res) => {
    try {
      const { fromY, toY, error } = parseYearRange(req.query);
      if (error) return res.status(400).json({ ok: false, error });
      const yf = yearFilterSql(fromY, toY);
      const rows = db
        .prepare(
          `SELECT
            pub_year AS year,
            ROUND(AVG(NULLIF(impact_factor, 0)), 4) AS avg_if
          FROM publications
          WHERE status = 'published'
            AND pub_year IS NOT NULL
            ${yf.sql}
          GROUP BY pub_year
          ORDER BY pub_year ASC`
        )
        .all(...yf.params);
      return res.json({ ok: true, data: rows, meta: { from: fromY, to: toY } });
    } catch (e) {
      console.error('[pub-analytics/yearly-if]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  router.get('/database-coverage', (req, res) => {
    try {
      const { fromY, toY, error } = parseYearRange(req.query);
      if (error) return res.status(400).json({ ok: false, error });
      const yf = yearFilterSql(fromY, toY);
      const f = sqlIndexedFlags('t');

      const sql = `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN ${f.scopus} THEN 1 ELSE 0 END) AS in_scopus,
          SUM(CASE WHEN ${f.wos} THEN 1 ELSE 0 END) AS in_wos,
          SUM(CASE WHEN ${f.pubmed} THEN 1 ELSE 0 END) AS in_pubmed,
          SUM(CASE WHEN ${f.doaj} THEN 1 ELSE 0 END) AS in_doaj,
          SUM(CASE WHEN ${f.scopus} AND ${f.wos} THEN 1 ELSE 0 END) AS scopus_and_wos,
          SUM(CASE WHEN ${f.scopus} AND ${f.pubmed} AND NOT ${f.wos} THEN 1 ELSE 0 END) AS scopus_pubmed_not_wos,
          SUM(CASE WHEN ${f.wos} AND ${f.pubmed} AND NOT ${f.scopus} THEN 1 ELSE 0 END) AS wos_pubmed_not_scopus,
          SUM(CASE WHEN ${f.scopus} AND ${f.wos} AND ${f.pubmed} THEN 1 ELSE 0 END) AS all_three,
          SUM(CASE WHEN ${f.scopus} AND NOT ${f.wos} AND NOT ${f.pubmed} THEN 1 ELSE 0 END) AS scopus_only,
          SUM(CASE WHEN ${f.wos} AND NOT ${f.scopus} AND NOT ${f.pubmed} THEN 1 ELSE 0 END) AS wos_only,
          SUM(CASE WHEN ${f.pubmed} AND NOT ${f.scopus} AND NOT ${f.wos} THEN 1 ELSE 0 END) AS pubmed_only,
          SUM(CASE WHEN NOT ${f.scopus} AND NOT ${f.wos} AND NOT ${f.pubmed} AND NOT ${f.doaj} THEN 1 ELSE 0 END) AS no_major_index
        FROM (
          SELECT
            index_db,
            scopus_eid,
            wos_id,
            pmid
          FROM publications
          WHERE status = 'published'
            ${yf.sql}
        ) t
      `;
      const row = db.prepare(sql).get(...yf.params);
      return res.json({ ok: true, data: row || {}, meta: { from: fromY, to: toY } });
    } catch (e) {
      console.error('[pub-analytics/database-coverage]', e);
      return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
    }
  });

  /**
   * Xuất báo cáo Word (thư viện docx — services/wordReportBuilder.js).
   * GET /api/pub-analytics/report/export-word?from=YYYY&to=YYYY&generated_by=userId
   * Tuỳ chọn kế hoạch mục V: plan_papers, plan_top_tier, plan_tt26, plan_citations
   * Quyền: admin (mount server.js). Sau này có thể thêm checkDashboardPermission('pub_analytics').
   */
  router.get('/report/export-word', async (req, res) => {
    try {
      const fromY = parseYear(req.query.from);
      const toY = parseYear(req.query.to);
      if (fromY == null || toY == null) {
        return res.status(400).json({ ok: false, error: 'Bắt buộc from và to (YYYY)' });
      }
      if (fromY > toY) {
        return res.status(400).json({ ok: false, error: 'from phải <= to' });
      }

      logDashboardAccess(db, {
        userId: req.user && req.user.id,
        dashboardId: PUB_DASHBOARD_ID,
        action: 'export',
        ip: clientIp(req),
      });

      const kpi = fetchKpiSnapshotRange(db, fromY, toY) || {};
      const quartileRows = db
        .prepare(
          `SELECT * FROM v_quartile_distribution
           WHERE year >= ? AND year <= ?
           ORDER BY year ASC`
        )
        .all(fromY, toY);

      const topCited = db
        .prepare(
          `SELECT
            id, title, authors, journal_name, pub_year, quartile, impact_factor, citation_count, doi
          FROM publications
          WHERE status = 'published'
            AND pub_year >= ? AND pub_year <= ?
          ORDER BY (citation_count IS NULL) ASC, citation_count DESC, id DESC
          LIMIT 10`
        )
        .all(fromY, toY);

      const fullList = db
        .prepare(
          `SELECT
            id, title, authors, journal_name, issn, pub_year, quartile, impact_factor,
            index_db, citation_count, doi
          FROM publications
          WHERE status = 'published'
            AND pub_year >= ? AND pub_year <= ?
          ORDER BY pub_year DESC, id DESC`
        )
        .all(fromY, toY);

      let generatedByLabel = '';
      const genId = Number.parseInt(String(req.query.generated_by || '').trim(), 10);
      if (Number.isFinite(genId)) {
        const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(genId);
        generatedByLabel = u ? (u.fullname || u.email || `User #${genId}`) : `User #${genId}`;
      } else if (req.user) {
        generatedByLabel = (req.user.fullname || req.user.email || '').trim();
      }

      const now = new Date();
      const generatedDate = now.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

      const plans = {
        plan_papers: parseOptionalPlanParam(req.query.plan_papers),
        plan_top_tier: parseOptionalPlanParam(req.query.plan_top_tier),
        plan_tt26: parseOptionalPlanParam(req.query.plan_tt26),
        plan_citations: parseOptionalPlanParam(req.query.plan_citations),
      };

      const buf = await buildPublicationReportBuffer({
        kpi,
        quartileRows,
        topCited,
        fullList,
        fromY,
        toY,
        generatedDate,
        generatedByLabel,
        plans,
      });

      const filenameAscii = `BaoCao_CongBo_SCI_${fromY}_${toY}.docx`;
      const filenameUtf8 = `BaoCao_CongBo_SCI_${fromY}_${toY}.docx`;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filenameAscii}"; filename*=UTF-8''${encodeURIComponent(filenameUtf8)}`
      );
      return res.send(Buffer.from(buf));
    } catch (e) {
      console.error('[pub-analytics/report/export-word]', e);
      if (!res.headersSent) {
        return res.status(500).json({ ok: false, error: e.message || 'Lỗi xuất Word' });
      }
    }
  });

  /**
   * Xuất Excel — 4 sheet: KPI, Sản lượng/năm, Danh sách đầy đủ, Top tác giả
   * GET /api/pub-analytics/report/export-excel?from=YYYY&to=YYYY
   */
  router.get('/report/export-excel', async (req, res) => {
    try {
      const fromY = parseYear(req.query.from);
      const toY = parseYear(req.query.to);
      if (fromY == null || toY == null) {
        return res.status(400).json({ ok: false, error: 'Bắt buộc from và to (YYYY)' });
      }
      if (fromY > toY) {
        return res.status(400).json({ ok: false, error: 'from phải <= to' });
      }

      logDashboardAccess(db, {
        userId: req.user && req.user.id,
        dashboardId: PUB_DASHBOARD_ID,
        action: 'export',
        ip: clientIp(req),
      });

      const kpi = fetchKpiSnapshotRange(db, fromY, toY) || {};
      const yearly = db
        .prepare(
          `SELECT * FROM v_yearly_output WHERE year >= ? AND year <= ? ORDER BY year ASC`
        )
        .all(fromY, toY);
      const fullList = db
        .prepare(
          `SELECT id, title, authors, journal_name, issn, pub_year, quartile, impact_factor,
                  index_db, citation_count, doi
           FROM publications
           WHERE status = 'published'
             AND pub_year >= ? AND pub_year <= ?
           ORDER BY pub_year DESC, id DESC`
        )
        .all(fromY, toY);

      const yf = yearFilterSql(fromY, toY);
      const topAuthorsSql = `
        SELECT
          author_name,
          COUNT(*) AS paper_count,
          SUM(pub_citations) AS total_citations,
          ROUND(AVG(impact_factor), 2) AS avg_if
        FROM (
          SELECT
            pa.author_name,
            pa.publication_id,
            MAX(COALESCE(p.citation_count, 0)) AS pub_citations,
            MAX(p.impact_factor) AS impact_factor
          FROM publication_authors pa
          INNER JOIN publications p ON pa.publication_id = p.id
          WHERE p.status = 'published'
            ${yf.sql.replace(/pub_year/g, 'p.pub_year')}
          GROUP BY pa.author_name, pa.publication_id
        ) t
        GROUP BY author_name
        ORDER BY paper_count DESC, total_citations DESC
        LIMIT 50`;
      const topAuthors = db.prepare(topAuthorsSql).all(...yf.params);

      const wb = new ExcelJS.Workbook();
      wb.creator = 'SCI-KHCN';
      wb.created = new Date();

      const s1 = wb.addWorksheet('KPI tổng hợp', { views: [{ state: 'frozen', ySplit: 1 }] });
      s1.addRow(['Chỉ số', 'Giá trị']);
      [
        ['Tổng bài', kpi.total_papers],
        ['Tổng trích dẫn', kpi.total_citations],
        ['IF trung bình (toàn kỳ)', kpi.avg_if],
        ['Số bài Q1+Q2', kpi.top_tier_count],
        ['Tỷ lệ Q1+Q2 (%)', kpi.top_tier_pct],
        ['Điểm TT 26/2022', kpi.tt26_total_score],
        ['Kỳ (năm)', `${fromY}–${toY}`],
      ].forEach((r) => s1.addRow(r));
      s1.getRow(1).font = { bold: true };

      const s2 = wb.addWorksheet('Sản lượng theo năm', { views: [{ state: 'frozen', ySplit: 1 }] });
      s2.addRow(['Năm', 'Số bài', 'YoY (bài)', 'YoY %', 'Tổng trích dẫn', 'TB trích dẫn/bài']);
      for (const r of yearly) {
        s2.addRow([
          r.year,
          r.total_papers,
          r.yoy_change,
          r.yoy_pct,
          r.total_citations,
          r.avg_citations_per_paper,
        ]);
      }
      s2.getRow(1).font = { bold: true };

      const s3 = wb.addWorksheet('Danh sách công bố', { views: [{ state: 'frozen', ySplit: 1 }] });
      s3.addRow([
        'ID',
        'Tiêu đề',
        'Tác giả',
        'Tạp chí',
        'ISSN',
        'Năm',
        'Q',
        'IF',
        'CSDL',
        'Trích dẫn',
        'DOI',
      ]);
      for (const r of fullList) {
        s3.addRow([
          r.id,
          r.title,
          r.authors,
          r.journal_name,
          r.issn,
          r.pub_year,
          r.quartile,
          r.impact_factor,
          r.index_db,
          r.citation_count,
          r.doi,
        ]);
      }
      s3.getRow(1).font = { bold: true };

      const s4 = wb.addWorksheet('Top tác giả', { views: [{ state: 'frozen', ySplit: 1 }] });
      s4.addRow(['Tác giả', 'Số bài', 'Tổng trích dẫn', 'IF TB']);
      for (const r of topAuthors) {
        s4.addRow([r.author_name, r.paper_count, r.total_citations, r.avg_if]);
      }
      s4.getRow(1).font = { bold: true };

      const buf = await wb.xlsx.writeBuffer();
      const fn = `BaoCao_CongBo_SCI_${fromY}_${toY}.xlsx`;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${fn}"; filename*=UTF-8''${encodeURIComponent(fn)}`
      );
      return res.send(Buffer.from(buf));
    } catch (e) {
      console.error('[pub-analytics/report/export-excel]', e);
      if (!res.headersSent) {
        return res.status(500).json({ ok: false, error: e.message || 'Lỗi xuất Excel' });
      }
    }
  });

  return router;
};
