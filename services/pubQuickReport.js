/**
 * Báo cáo nhanh: xuất Excel / HTML in PDF + cập nhật trích dẫn (OpenAlex, tuỳ chọn Scopus).
 * Dùng db-bridge (SQLite / Turso).
 */

const XLSX = require('xlsx');

const OPENALEX_WORKS = 'https://api.openalex.org/works/';
const OPENALEX_UA = 'SCI-KHCN-App/1.0 (mailto:admin@sci.edu.vn)';
const SCOPUS_BASE = 'https://api.elsevier.com/content/abstract/doi';

const EXPORT_ROW_CAP = 20000;

function maybeAwait(v) {
  return v && typeof v.then === 'function' ? v : Promise.resolve(v);
}

async function dbAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const r = stmt.all(...params);
  return maybeAwait(r);
}

async function dbRun(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const r = stmt.run(...params);
  return maybeAwait(r);
}

function parseYearRange(query) {
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
  return { yf, yt, active };
}

function cleanDoi(doi) {
  return String(doi)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .trim();
}

function buildWhere(query) {
  const conditions = ['1=1'];
  const params = [];

  const { yf, yt, active } = parseYearRange(query);
  if (active) {
    conditions.push('pub_year BETWEEN ? AND ?');
    params.push(yf, yt);
  }

  if (query.q) {
    conditions.push('(title LIKE ? OR authors LIKE ? OR doi LIKE ? OR journal_name LIKE ?)');
    const like = `%${String(query.q)}%`;
    params.push(like, like, like, like);
  }
  if (query.year && !active) {
    conditions.push('pub_year = ?');
    params.push(Number(query.year));
  }
  if (query.pub_type) {
    conditions.push('pub_type = ?');
    params.push(String(query.pub_type));
  }
  if (query.quartile) {
    conditions.push('quartile = ?');
    params.push(String(query.quartile));
  }
  if (query.status) {
    conditions.push('status = ?');
    params.push(String(query.status));
  }
  if (query.project) {
    conditions.push('project_code = ?');
    params.push(String(query.project));
  }
  if (query.index_db) {
    conditions.push('index_db LIKE ?');
    params.push(`%${String(query.index_db)}%`);
  }

  return { where: conditions.join(' AND '), params };
}

/**
 * @param {object} db — db-bridge
 * @param {object} query — req.query
 */
async function queryPublicationsExportRows(db, query) {
  const { where, params } = buildWhere(query);
  const rows = await dbAll(
    db,
    `SELECT id, title, authors, journal_name, issn, doi, pub_year, pub_type,
            quartile, index_db, impact_factor, cite_score, sjr, sjr_score,
            citation_count, openalex_cite_count, scopus_eid, wos_id, pmid,
            status, project_code, enrichment_status, source, updated_at
     FROM publications
     WHERE ${where}
     ORDER BY pub_year DESC, id DESC
     LIMIT ?`,
    [...params, EXPORT_ROW_CAP]
  );
  return rows || [];
}

function buildExcelBuffer(rows) {
  const flat = (rows || []).map((r) => ({
    id: r.id,
    title: r.title,
    authors: r.authors,
    journal: r.journal_name,
    issn: r.issn,
    doi: r.doi,
    year: r.pub_year,
    type: r.pub_type,
    quartile: r.quartile,
    index_db: r.index_db,
    IF: r.impact_factor,
    cite_score: r.cite_score,
    sjr: r.sjr ?? r.sjr_score,
    citations: r.citation_count,
    openalex_cites: r.openalex_cite_count,
    scopus_eid: r.scopus_eid,
    wos_id: r.wos_id,
    pmid: r.pmid,
    status: r.status,
    project: r.project_code,
    enrichment: r.enrichment_status,
    source: r.source,
    updated_at: r.updated_at,
  }));
  const ws = XLSX.utils.json_to_sheet(flat.length ? flat : [{ note: 'Không có bản ghi' }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Cong_bo');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function buildPrintableHtmlReport(rows, query, title) {
  const { yf, yt, active } = parseYearRange(query);
  const rangeLabel = active ? `${yf}–${yt}` : 'Toàn bộ (theo bộ lọc)';
  const generated = new Date().toLocaleString('vi-VN');
  const list = rows || [];
  const head = `
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title || 'Báo cáo công bố')}</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 1.25rem; margin-bottom: 4px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  tr:nth-child(even) { background: #fafafa; }
  .num { text-align: right; }
  @media print {
    body { margin: 12px; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
  <h1>${escHtml(title || 'Báo cáo công bố khoa học')}</h1>
  <div class="meta">Phạm vi năm: ${escHtml(rangeLabel)} · Số bản ghi: ${list.length} (tối đa ${EXPORT_ROW_CAP}) · Tạo lúc: ${escHtml(generated)}</div>
  <p class="meta"><strong>In / Lưu PDF:</strong> dùng <kbd>Ctrl+P</kbd> → «Lưu dưới dạng PDF» trên trình duyệt.</p>
  <table>
    <thead>
      <tr>
        <th>#</th><th>Năm</th><th>Tiêu đề</th><th>Tác giả</th><th>Tạp chí</th><th>ISSN</th><th>DOI</th>
        <th>Q</th><th>Trích dẫn</th><th>Scopus EID</th><th>WoS</th><th>Đề tài</th>
      </tr>
    </thead>
    <tbody>
`;
  const body = list
    .map((r, i) => {
      const doi = r.doi ? `https://doi.org/${escHtml(cleanDoi(r.doi))}` : '';
      return `<tr>
        <td class="num">${i + 1}</td>
        <td class="num">${escHtml(r.pub_year)}</td>
        <td>${escHtml(r.title)}</td>
        <td>${escHtml(r.authors)}</td>
        <td>${escHtml(r.journal_name)}</td>
        <td>${escHtml(r.issn)}</td>
        <td>${doi ? `<a href="${doi}">${escHtml(cleanDoi(r.doi))}</a>` : '—'}</td>
        <td>${escHtml(r.quartile)}</td>
        <td class="num">${escHtml(r.citation_count)}</td>
        <td>${escHtml(r.scopus_eid)}</td>
        <td>${escHtml(r.wos_id)}</td>
        <td>${escHtml(r.project_code)}</td>
      </tr>`;
    })
    .join('');
  const foot = `
    </tbody>
  </table>
</body>
</html>`;
  return head + body + foot;
}

async function fetchOpenAlexCitedBy(doi) {
  const d = cleanDoi(doi);
  if (!d) return null;
  const workUrl = `${OPENALEX_WORKS}${encodeURIComponent(`https://doi.org/${d}`)}`;
  const url = `${workUrl}${workUrl.includes('?') ? '&' : '?'}mailto=${encodeURIComponent('admin@sci.edu.vn')}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': OPENALEX_UA },
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    const n = data.cited_by_count;
    return Number.isFinite(Number(n)) ? Number(n) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchScopusByDoi(doi) {
  const key = process.env.SCOPUS_API_KEY?.trim();
  if (!key) return null;
  const d = cleanDoi(doi);
  if (!d) return null;
  const url = `${SCOPUS_BASE}/${encodeURIComponent(d)}?apiKey=${encodeURIComponent(key)}&httpAccept=application%2Fjson`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const entry = json['abstracts-retrieval-response']?.coredata;
    if (!entry) return null;
    return {
      eid: entry.eid || null,
      citedByCount: parseInt(entry['citedby-count'] || '0', 10) || 0,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cập nhật citation_count / EID từ Scopus (nếu có key) và OpenAlex theo DOI.
 */
async function refreshExternalMetrics(db, { limit = 40 } = {}) {
  const cap = Math.min(120, Math.max(1, Number(limit) || 40));
  const rows = await dbAll(
    db,
    `SELECT id, doi FROM publications
     WHERE doi IS NOT NULL AND TRIM(doi) != ''
     ORDER BY
       CASE WHEN citation_updated_at IS NULL THEN 0 ELSE 1 END,
       datetime(updated_at) ASC
     LIMIT ?`,
    [cap]
  );
  const list = rows || [];
  let updated = 0;
  let openalexOk = 0;
  let scopusOk = 0;
  const errors = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    const id = Number(row.id);
    try {
      let cite = null;
      let eid = null;

      const sc = await fetchScopusByDoi(row.doi);
      if (sc && sc.eid) {
        eid = sc.eid;
        if (Number.isFinite(sc.citedByCount)) cite = sc.citedByCount;
        scopusOk += 1;
      }

      await delay(350);
      const oa = await fetchOpenAlexCitedBy(row.doi);
      if (oa != null) openalexOk += 1;
      if (cite == null && oa != null) cite = oa;

      const parts = ['updated_at = datetime(\'now\')', 'citation_updated_at = datetime(\'now\')'];
      const params = [];
      if (eid) {
        parts.push('scopus_eid = COALESCE(scopus_eid, ?)');
        params.push(eid);
      }
      if (oa != null) {
        parts.push('openalex_cite_count = ?');
        params.push(oa);
      }
      if (cite != null && Number.isFinite(cite)) {
        parts.push('citation_count = ?');
        params.push(cite);
      }

      if (params.length === 0) {
        await delay(200);
        continue;
      }
      params.push(id);
      await dbRun(db, `UPDATE publications SET ${parts.join(', ')} WHERE id = ?`, params);
      updated += 1;
    } catch (e) {
      errors.push(`id ${row.id}: ${e.message || e}`);
    }
    await delay(200);
  }

  const wosNote =
    process.env.WOS_API_KEY?.trim()
      ? 'WoS: key có trong .env nhưng chưa gọi API Clarivate trong luồng này.'
      : 'WoS: chưa cấu hình WOS_API_KEY — chỉ cập nhật Scopus (nếu có key) và OpenAlex.';

  return {
    processed: list.length,
    rowsUpdated: updated,
    openalexHits: openalexOk,
    scopusHits: scopusOk,
    wosNote,
    errors: errors.slice(0, 15),
  };
}

module.exports = {
  queryPublicationsExportRows,
  buildExcelBuffer,
  buildPrintableHtmlReport,
  parseYearRange,
  refreshExternalMetrics,
};
