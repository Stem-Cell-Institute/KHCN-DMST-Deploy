/**
 * OpenAlex — tra work theo WOS UID hoặc Scopus EID (không qua DOI).
 * Polite pool: bắt buộc tham số mailto — https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication
 *
 * Lưu ý: filter `ids.wos` / `ids.scopus` đã bị OpenAlex gỡ (400 Invalid query).
 * Chỉ dùng GET /works/wos:{id} và /works/scopus:{eid} (hoặc URL OpenAlex đầy đủ đã encode).
 */

const OPENALEX = 'https://api.openalex.org';

/** Đồng bộ với doiService.js (CROSSREF_POLITE_EMAIL + fallback). */
function getOpenAlexMailto() {
  const m = (
    process.env.OPENALEX_MAIL
    || process.env.CROSSREF_POLITE_EMAIL
    || process.env.POLITE_EMAIL
    || 'khcn@sci.edu.vn'
  ).trim();
  return m || 'khcn@sci.edu.vn';
}

function withMailto(url) {
  const mail = getOpenAlexMailto();
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}mailto=${encodeURIComponent(mail)}`;
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `SCI-KHCN/1.0 (mailto:${getOpenAlexMailto()})`,
      },
    });
  } finally {
    clearTimeout(t);
  }
}

function normalizeWosForOpenAlex(wosRaw) {
  if (wosRaw == null || wosRaw === '') return null;
  return String(wosRaw).trim().toUpperCase().replace(/^WOS:/i, '').trim() || null;
}

function openAlexAbstractFromInverted(inv) {
  if (!inv || typeof inv !== 'object') return null;
  let max = 0;
  for (const positions of Object.values(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === 'number' && p > max) max = p;
    }
  }
  if (max <= 0 || max > 100000) return null;
  const words = new Array(max + 1);
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos === 'number' && pos >= 0 && pos <= max) words[pos] = word;
    }
  }
  const s = words.filter(Boolean).join(' ');
  return s.trim() || null;
}

function authorshipsToAuthorString(authorships) {
  if (!Array.isArray(authorships) || !authorships.length) return '';
  return authorships
    .map((a) => a?.author?.display_name || a?.raw_author_name || '')
    .filter(Boolean)
    .join(', ');
}

function doiFromOpenAlex(oa) {
  const d = oa?.doi;
  if (!d) return null;
  const s = String(d).replace(/^https?:\/\/doi\.org\//i, '').trim();
  return /^10\.\d{4,}\//.test(s) ? s : null;
}

function mapOpenAlexWorkToEnriched(oaWork, orcidWork) {
  if (!oaWork || typeof oaWork !== 'object') return null;
  const primary = oaWork.primary_location;
  const src = primary?.source;
  const bib = oaWork.biblio || {};
  const pages = [bib.first_page, bib.last_page].filter(Boolean).join('–') || null;
  const abstract = openAlexAbstractFromInverted(oaWork.abstract_inverted_index);
  const authors = authorshipsToAuthorString(oaWork.authorships);
  const oa = oaWork.open_access || {};

  return {
    doi: doiFromOpenAlex(oaWork) || orcidWork?.doi || null,
    pmid: orcidWork?.pmid || null,
    pmc_id: orcidWork?.pmc_id || null,
    wos_id: orcidWork?.wos_id || null,
    scopus_eid: orcidWork?.scopus_id || null,
    title: (oaWork.title && String(oaWork.title).trim()) || orcidWork?.title || 'Unknown Title',
    abstract,
    journal_name: src?.display_name || primary?.raw_source_name || null,
    issn: src?.issn_l || (Array.isArray(src?.issn) ? src.issn[0] : null) || null,
    volume: bib.volume || null,
    pages,
    pub_year: oaWork.publication_year != null ? Number(oaWork.publication_year) : orcidWork?.pubYear ?? null,
    pub_date: oaWork.publication_date || null,
    pub_type: 'journal',
    authors,
    authors_json: oaWork.authorships ? JSON.stringify(oaWork.authorships) : null,
    url: primary?.landing_page_url || orcidWork?.url || null,
    citation_count: oaWork.cited_by_count != null ? Number(oaWork.cited_by_count) || 0 : 0,
    is_open_access: oa.is_oa ? 1 : 0,
    oa_type: oa.oa_status || null,
    source: 'orcid_harvest',
    orcid_put_code: orcidWork?.putCode || null,
    import_status: 'pending_review',
    enrichmentSource: 'OpenAlex',
    enrichmentGroup: 'OpenAlex',
    openalex_id: oaWork.id || null,
    _needsReview: {
      quartile: null,
      impact_factor: null,
      index_db: 'OpenAlex',
      sci_authors: null,
      project_code: null,
      doi_metadata_resolver: 'openalex_external_id',
    },
  };
}

async function parseWorkResponse(res) {
  if (!res.ok) return { ok: false, status: res.status, work: null };
  const json = await res.json();
  if (json?.id) return { ok: true, status: res.status, work: json };
  return { ok: false, status: res.status, work: null };
}

/**
 * GET /works/wos:{digits} — không dùng filter ids.wos (API trả 400).
 */
export async function fetchOpenAlexWorkByWos(wosRaw) {
  const w = normalizeWosForOpenAlex(wosRaw);
  if (!w) return { ok: false, status: 400, work: null, error: 'WOS rỗng' };

  try {
    const urls = [
      withMailto(`${OPENALEX}/works/wos:${w}`),
      withMailto(`${OPENALEX}/works/${encodeURIComponent(`https://openalex.org/wos:${w}`)}`),
    ];

    for (const url of urls) {
      const res = await fetchWithTimeout(url);
      const parsed = await parseWorkResponse(res);
      if (parsed.ok && parsed.work) {
        return { ok: true, status: 200, work: parsed.work, error: null };
      }
      if (res.status !== 404 && !res.ok) {
        return { ok: false, status: res.status, work: null, error: `HTTP ${res.status}` };
      }
    }
    return { ok: false, status: 404, work: null, error: 'Không tìm thấy' };
  } catch (e) {
    return { ok: false, status: 0, work: null, error: e.message || 'fetch failed' };
  }
}

/**
 * Scopus EID dạng 2-s2.0-...
 */
export async function fetchOpenAlexWorkByScopusId(scopusEidRaw) {
  const eid = scopusEidRaw != null ? String(scopusEidRaw).trim().toLowerCase() : '';
  if (!eid) return { ok: false, status: 400, work: null, error: 'Scopus EID rỗng' };

  try {
    const urls = [
      withMailto(`${OPENALEX}/works/scopus:${eid}`),
      withMailto(`${OPENALEX}/works/${encodeURIComponent(`https://openalex.org/scopus:${eid}`)}`),
    ];

    for (const url of urls) {
      const res = await fetchWithTimeout(url);
      const parsed = await parseWorkResponse(res);
      if (parsed.ok && parsed.work) {
        return { ok: true, status: 200, work: parsed.work, error: null };
      }
      if (res.status !== 404 && !res.ok) {
        return { ok: false, status: res.status, work: null, error: `HTTP ${res.status}` };
      }
    }
    return { ok: false, status: 404, work: null, error: 'Không tìm thấy' };
  } catch (e) {
    return { ok: false, status: 0, work: null, error: e.message || 'fetch failed' };
  }
}

/**
 * Thử WOS trước, sau đó Scopus EID.
 */
export async function enrichWorkFromOpenAlex(orcidWork) {
  const wos = orcidWork?.wos_id;
  const scopus = orcidWork?.scopus_id;

  if (wos) {
    const r = await fetchOpenAlexWorkByWos(wos);
    if (r.ok && r.work) {
      return {
        enriched: mapOpenAlexWorkToEnriched(r.work, orcidWork),
        enrichmentSource: 'OpenAlex',
        enrichmentGroup: 'OpenAlex',
        via: 'wos',
      };
    }
    if (!r.ok && r.status !== 404 && r.error) {
      console.warn('[OpenAlex] WOS lookup lỗi:', wos, r.error);
    }
  }

  if (scopus) {
    const r = await fetchOpenAlexWorkByScopusId(scopus);
    if (r.ok && r.work) {
      return {
        enriched: mapOpenAlexWorkToEnriched(r.work, orcidWork),
        enrichmentSource: 'OpenAlex',
        enrichmentGroup: 'OpenAlex',
        via: 'scopus',
      };
    }
    if (!r.ok && r.status !== 404 && r.error) {
      console.warn('[OpenAlex] Scopus lookup lỗi:', scopus, r.error);
    }
  }

  return { enriched: null, enrichmentSource: null, enrichmentGroup: null, via: null };
}
