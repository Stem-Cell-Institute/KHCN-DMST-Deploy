/**
 * Europe PMC REST API — metadata theo PMID hoặc PMCID (JSON).
 * https://www.ebi.ac.uk/europepmc/webservices/rest/
 */

const EUROPE_PMC_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

function digitsOnly(s) {
  if (s == null || s === '') return null;
  const m = String(s).match(/\d+/);
  return m ? m[0] : null;
}

function toPmcParam(pmcRaw) {
  if (pmcRaw == null || pmcRaw === '') return null;
  let s = String(pmcRaw).trim().toUpperCase();
  s = s.replace(/^PMC/i, '');
  const d = digitsOnly(s);
  return d ? `PMC${d}` : null;
}

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SCI-KHCN/1.0 (orcid-harvest)',
      },
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {object} article - trường `result` từ JSON Europe PMC (MED/PMC)
 */
function mapEuropePmcArticleToEnriched(article, orcidWork) {
  if (!article || typeof article !== 'object') return null;
  const pubYear = article.pubYear != null ? parseInt(String(article.pubYear), 10) : null;
  const pmid = article.pmid ? digitsOnly(article.pmid) : null;
  const pmcid = article.pmcid ? toPmcParam(article.pmcid) : null;
  const doiRaw = article.doi ? String(article.doi).trim() : null;

  return {
    doi: doiRaw && /^10\.\d{4,}\//.test(doiRaw) ? doiRaw : orcidWork?.doi || null,
    pmid: pmid || orcidWork?.pmid || null,
    pmc_id: pmcid || orcidWork?.pmc_id || null,
    wos_id: orcidWork?.wos_id || null,
    scopus_eid: orcidWork?.scopus_id || null,
    title: (article.title && String(article.title).trim()) || orcidWork?.title || 'Unknown Title',
    abstract: article.abstractText ? String(article.abstractText).trim() : null,
    journal_name: (article.journalTitle && String(article.journalTitle).trim())
      || (article.journalInfo?.journal?.title && String(article.journalInfo.journal.title).trim())
      || null,
    issn: article.journalIssn ? String(article.journalIssn).split(';')[0].trim() : null,
    volume: article.journalVolume || null,
    pages: article.pageInfo || null,
    pub_year: Number.isFinite(pubYear) ? pubYear : orcidWork?.pubYear ?? null,
    pub_type: 'journal',
    authors: article.authorString ? String(article.authorString).trim() : '',
    url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : orcidWork?.url || null,
    citation_count: article.citedByCount != null ? parseInt(String(article.citedByCount), 10) || 0 : 0,
    source: 'orcid_harvest',
    orcid_put_code: orcidWork?.putCode || null,
    import_status: 'pending_review',
    enrichmentSource: 'Europe PMC',
    enrichmentGroup: 'Europe_PMC',
    _needsReview: {
      quartile: null,
      impact_factor: null,
      index_db: 'PubMed/Europe PMC',
      sci_authors: null,
      project_code: null,
      doi_metadata_resolver: 'europe_pmc',
    },
  };
}

function parseArticleResponse(json) {
  const hit = Number(json?.hitCount ?? 0);
  const r = json?.result;
  if (!hit || !r) return null;
  return Array.isArray(r) ? r[0] : r;
}

/**
 * GET /article/MED/{pmid}?format=json&resultType=core
 */
export async function fetchEuropePmcByPmid(pmid) {
  const id = digitsOnly(pmid);
  if (!id) return { ok: false, status: 400, article: null, error: 'PMID không hợp lệ' };
  const url = `${EUROPE_PMC_BASE}/article/MED/${encodeURIComponent(id)}?format=json&resultType=core`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return { ok: false, status: res.status, article: null, error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const article = parseArticleResponse(json);
    return { ok: !!article, status: res.status, article, error: article ? null : 'Không có bản ghi' };
  } catch (e) {
    return { ok: false, status: 0, article: null, error: e.message || 'fetch failed' };
  }
}

/**
 * GET /article/PMC/{PMCxxxx}?format=json&resultType=core
 */
export async function fetchEuropePmcByPmcId(pmcId) {
  const pmc = toPmcParam(pmcId);
  if (!pmc) return { ok: false, status: 400, article: null, error: 'PMCID không hợp lệ' };
  const url = `${EUROPE_PMC_BASE}/article/PMC/${encodeURIComponent(pmc)}?format=json&resultType=core`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      return { ok: false, status: res.status, article: null, error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    const article = parseArticleResponse(json);
    return { ok: !!article, status: res.status, article, error: article ? null : 'Không có bản ghi' };
  } catch (e) {
    return { ok: false, status: 0, article: null, error: e.message || 'fetch failed' };
  }
}

/**
 * Ưu tiên PMID, sau đó PMCID.
 * @returns {Promise<{ enriched: object|null, enrichmentSource: string, enrichmentGroup: string, via: string }>}
 */
export async function enrichWorkFromEuropePmc(orcidWork) {
  const pmid = orcidWork?.pmid ? digitsOnly(orcidWork.pmid) : null;
  const pmc = orcidWork?.pmc_id ? toPmcParam(orcidWork.pmc_id) : null;

  if (pmid) {
    const r = await fetchEuropePmcByPmid(pmid);
    if (r.ok && r.article) {
      return {
        enriched: mapEuropePmcArticleToEnriched(r.article, orcidWork),
        enrichmentSource: 'Europe PMC',
        enrichmentGroup: 'Europe_PMC',
        via: 'pmid',
      };
    }
  }
  if (pmc) {
    const r = await fetchEuropePmcByPmcId(pmc);
    if (r.ok && r.article) {
      return {
        enriched: mapEuropePmcArticleToEnriched(r.article, orcidWork),
        enrichmentSource: 'Europe PMC',
        enrichmentGroup: 'Europe_PMC',
        via: 'pmc',
      };
    }
  }
  return { enriched: null, enrichmentSource: null, enrichmentGroup: null, via: null };
}
