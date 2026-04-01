/**
 * Scopus Abstract Retrieval API — tra bản ghi theo EID (2-s2.0-…).
 * https://dev.elsevier.com/documentation/AbstractRetrievalAPI.wadl
 *
 * Cấu hình: SCOPUS_API_KEY trong .env (không commit key).
 * Tuỳ gói institutional có thể cần thêm SCOPUS_INST_TOKEN.
 */

const SCOPUS_BASE = 'https://api.elsevier.com/content';

function firstVal(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const x = v[0];
    if (x == null) return null;
    if (typeof x === 'object' && x.$ != null) return String(x.$).trim() || null;
    return String(x).trim() || null;
  }
  if (typeof v === 'object' && v.$ != null) return String(v.$).trim() || null;
  const s = String(v).trim();
  return s || null;
}

function normalizeEid(raw) {
  if (raw == null || raw === '') return null;
  return String(raw).trim().toLowerCase() || null;
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
  } finally {
    clearTimeout(t);
  }
}

function parseScopusAuthors(ar) {
  const auth = ar?.authors?.author;
  const list = Array.isArray(auth) ? auth : auth ? [auth] : [];
  const names = [];
  for (const a of list) {
    const pref = a?.['preferred-name'] || a;
    const given = firstVal(pref?.['given-name'] ?? pref?.givenname);
    const sur = firstVal(pref?.surname ?? pref?.surname);
    const ce = [given, sur].filter(Boolean).join(' ');
    if (ce) names.push(ce);
  }
  return names.join(', ');
}

function parseSubjectAreas(ar) {
  const areas = ar?.['subject-areas']?.['subject-area'];
  const list = Array.isArray(areas) ? areas : areas ? [areas] : [];
  return list
    .map((s) => (typeof s === 'object' && s.$ != null ? String(s.$) : String(s || '')).trim())
    .filter(Boolean)
    .join('; ') || null;
}

/**
 * Map JSON Abstract Retrieval → shape gần với enriched / publications.
 */
export function mapScopusAbstractToEnriched(json, orcidWork) {
  const ar = json?.['abstracts-retrieval-response'];
  const core = ar?.coredata;
  if (!core || typeof core !== 'object') return null;

  const title = firstVal(core['dc:title']) || orcidWork?.title || 'Unknown Title';
  const abstract = firstVal(core['dc:description']);
  const journal = firstVal(core['prism:publicationName']);
  const doiRaw = firstVal(core['prism:doi']);
  const doi = doiRaw && /^10\.\d{4,}\//i.test(doiRaw) ? doiRaw : orcidWork?.doi || null;
  const volume = firstVal(core['prism:volume']);
  const issue = firstVal(core['prism:issue']);
  const pageRange = firstVal(core['prism:pageRange']);
  const issn = firstVal(core['prism:issn']);
  const eid = firstVal(core.eid) || normalizeEid(orcidWork?.scopus_id);
  const citedBy = parseInt(String(core['citedby-count'] ?? core.citedbycount ?? '0'), 10) || 0;
  const coverDate = firstVal(core['prism:coverDate']);
  let pubYear = orcidWork?.pubYear != null ? Number(orcidWork.pubYear) : null;
  if (coverDate) {
    const y = parseInt(String(coverDate).slice(0, 4), 10);
    if (!Number.isNaN(y)) pubYear = y;
  }

  const authors = parseScopusAuthors(ar);
  const subjectArea = parseSubjectAreas(ar);

  return {
    doi,
    pmid: orcidWork?.pmid || null,
    pmc_id: orcidWork?.pmc_id || null,
    wos_id: orcidWork?.wos_id || null,
    scopus_eid: eid || orcidWork?.scopus_id || null,
    title,
    abstract: abstract || null,
    keywords: subjectArea,
    authors: authors || '',
    language: firstVal(core['dc:language']) || 'en',
    pub_type: 'journal',
    journal_name: journal,
    issn: issn || null,
    volume: volume || null,
    pages: pageRange || (issue ? `(issue ${issue})` : null),
    pub_year: pubYear,
    pub_date: coverDate || null,
    url: doi ? `https://doi.org/${doi}` : orcidWork?.url || null,
    citation_count: citedBy,
    citation_updated_at: new Date().toISOString(),
    source: 'orcid_harvest',
    orcid_put_code: orcidWork?.putCode || null,
    import_status: 'pending_review',
    enrichmentSource: 'Scopus (Elsevier)',
    enrichmentGroup: 'Scopus',
    _needsReview: {
      quartile: null,
      impact_factor: null,
      index_db: 'Scopus',
      sci_authors: null,
      project_code: null,
      doi_metadata_resolver: 'scopus_eid',
    },
  };
}

/**
 * GET /content/abstract/eid/{eid}
 */
export async function fetchScopusAbstractByEid(eidRaw) {
  const apiKey = process.env.SCOPUS_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, status: 0, error: 'Thiếu SCOPUS_API_KEY trong .env', json: null };
  }

  const eid = normalizeEid(eidRaw);
  if (!eid) {
    return { ok: false, status: 400, error: 'EID rỗng', json: null };
  }

  const params = new URLSearchParams({
    apiKey,
    httpAccept: 'application/json',
    view: 'META_ABS',
  });
  const inst = process.env.SCOPUS_INST_TOKEN?.trim();
  if (inst) params.set('insttoken', inst);

  const url = `${SCOPUS_BASE}/abstract/eid/${encodeURIComponent(eid)}?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        json: null,
      };
    }
    const json = await res.json();
    return { ok: true, status: 200, error: null, json };
  } catch (e) {
    return { ok: false, status: 0, error: e.message || 'fetch failed', json: null };
  }
}

/**
 * @returns {Promise<{ enriched: object|null, enrichmentSource: string|null, enrichmentGroup: string|null }>}
 */
export async function enrichWorkFromScopusEid(orcidWork) {
  if (!orcidWork?.scopus_id) {
    return { enriched: null, enrichmentSource: null, enrichmentGroup: null };
  }

  const r = await fetchScopusAbstractByEid(orcidWork.scopus_id);
  if (!r.ok || !r.json) {
    if (r.error && !r.error.includes('Thiếu SCOPUS_API_KEY')) {
      console.warn('[Scopus] EID lookup:', orcidWork.scopus_id, r.error);
    }
    return { enriched: null, enrichmentSource: null, enrichmentGroup: null };
  }

  const enriched = mapScopusAbstractToEnriched(r.json, orcidWork);
  if (!enriched) {
    return { enriched: null, enrichmentSource: null, enrichmentGroup: null };
  }

  return {
    enriched,
    enrichmentSource: 'Scopus (Elsevier)',
    enrichmentGroup: 'Scopus',
  };
}
