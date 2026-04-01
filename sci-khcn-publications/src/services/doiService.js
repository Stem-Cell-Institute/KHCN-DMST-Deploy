/**
 * src/services/doiService.js
 * DOI Fetch & Enrich Service
 *
 * Pipeline metadata (theo DOI):
 *   1. Crossref → 2. DataCite → 3. OpenAlex → 4. mEDRA (CSL JSON)
 *   5. Fallback: dữ liệu thô ORCID (`orcid_raw_data`) — không throw, không bỏ sót record
 * Enrich thêm: PubMed (tuỳ loại), Unpaywall (song song), Scopus (nếu có API key)
 *
 * Trường gắn cờ: `import_status` (SUCCESS | DEAD_DOI_ORCID_RAW), `data_source` (Crossref | …)
 */

const CROSSREF_BASE  = 'https://api.crossref.org/works';
const DATACITE_BASE  = 'https://api.datacite.org/dois';
const OPENALEX_BASE  = 'https://api.openalex.org/works';
const MEDRA_BASE     = 'https://data.medra.org';
const PUBMED_BASE    = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const UNPAYWALL_BASE = 'https://api.unpaywall.org/v2';
const SCOPUS_BASE    = 'https://api.elsevier.com/content';

const CSL_JSON_ACCEPT = 'application/vnd.citationstyles.csl+json';

/** Ánh xạ nguồn API → nhãn lưu DB / log */
const DATA_SOURCE_LABEL = {
  crossref: 'Crossref',
  datacite: 'DataCite',
  openalex: 'OpenAlex',
  medra:    'mEDRA',
  orcid_raw: 'ORCID_Raw',
  none:     'none',
};

// Email dùng cho Crossref polite pool — thay bằng email thực của SCI
const POLITE_EMAIL = process.env.CROSSREF_POLITE_EMAIL || 'khcn@sci.edu.vn';

// ── Hàm chính: fetch và enrich 1 DOI ─────────────────────────────────────────
// `options.orcid_raw_data`: object work từ ORCID (title, journalTitle, pubYear, putCode, …)
export async function fetchAndEnrichDOI(rawDoi, options = {}) {
  const orcidRaw = options.orcid_raw_data ?? null;

  const doi = normalizeDOI(rawDoi);
  if (!doi) throw new Error('DOI không hợp lệ');

  console.log(`[DOI] Bắt đầu fetch: ${doi}`);

  const unpaywallPromise = fetchUnpaywall(doi).catch(() => null);

  const { base, import_status, data_source } = await resolveBaseFromProviders(doi, orcidRaw);

  let pubmedData = null;
  if (shouldFetchPubMed(base)) {
    try {
      const pmResult = await fetchPubMedByDOI(doi);
      if (pmResult) pubmedData = parsePubMed(pmResult);
    } catch (_) {
      /* một DOI lỗi mạng không làm sập pipeline */
    }
  }

  let scopusData = null;
  if (process.env.SCOPUS_API_KEY) {
    try {
      scopusData = await fetchScopus(doi);
    } catch (_) {}
  }

  let oaData = null;
  try {
    const uw = await unpaywallPromise;
    oaData = parseUnpaywall(uw);
  } catch (_) {
    oaData = null;
  }

  return mergeEnrichedData({
    doi,
    base,
    pubmedData,
    scopusData,
    oaData,
    import_status,
    data_source,
  });
}

/**
 * Crossref → DataCite → OpenAlex → mEDRA → ORCID raw → tối thiểu (không throw).
 */
async function resolveBaseFromProviders(doi, orcidRaw) {
  const chain = [
    {
      dataSource: DATA_SOURCE_LABEL.crossref,
      run: async () => {
        const msg = await fetchCrossref(doi);
        return parseCrossref(msg);
      },
    },
    {
      dataSource: DATA_SOURCE_LABEL.datacite,
      run: async () => {
        const j = await fetchDataCite(doi);
        return j ? parseDataCite(j) : null;
      },
    },
    {
      dataSource: DATA_SOURCE_LABEL.openalex,
      run: async () => {
        const w = await fetchOpenAlexByDoi(doi);
        return w ? parseOpenAlex(w) : null;
      },
    },
    {
      dataSource: DATA_SOURCE_LABEL.medra,
      run: async () => {
        const csl = await fetchMedra(doi);
        return csl ? parseMedraCsl(csl, doi) : null;
      },
    },
  ];

  for (const step of chain) {
    try {
      const base = await step.run();
      if (base) {
        console.log(`[Thành công] ${doi}: Đã lấy từ ${step.dataSource}.`);
        return {
          base,
          import_status: 'SUCCESS',
          data_source: step.dataSource,
        };
      }
    } catch (e) {
      const msg = e?.message || String(e);
      console.warn(`[DOI] ${step.dataSource} thất bại (${doi}): ${msg}`);
    }
  }

  const fromOrcid = buildBaseFromOrcidRaw(doi, orcidRaw);
  if (fromOrcid) {
    console.warn(
      `[CẢNH BÁO] ${doi}: Toàn bộ API thất bại. Đã vớt bằng dữ liệu thô ORCID. Trạng thái: DEAD DOI.`
    );
    return {
      base: fromOrcid,
      import_status: 'DEAD_DOI_ORCID_RAW',
      data_source: DATA_SOURCE_LABEL.orcid_raw,
    };
  }

  console.warn(
    `[CẢNH BÁO] ${doi}: Toàn bộ API thất bại, không có dữ liệu ORCID thô. Trạng thái: DEAD DOI.`
  );
  return {
    base: minimalBaseFromDoi(doi),
    import_status: 'DEAD_DOI_ORCID_RAW',
    data_source: DATA_SOURCE_LABEL.none,
  };
}

// ── 1. CROSSREF ───────────────────────────────────────────────────────────────
async function fetchCrossref(doi) {
  const url = `${CROSSREF_BASE}/${encodeURIComponent(doi)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': `SCI-KHCN/1.0 (${POLITE_EMAIL})`,
      'Accept': 'application/json',
    },
  }, 10000);

  if (!res.ok) {
    if (res.status === 404) throw new Error('DOI không tồn tại trên Crossref');
    throw new Error(`Crossref HTTP ${res.status}`);
  }
  const json = await res.json();
  return json.message;
}

function parseCrossref(msg) {
  // Tác giả
  const authors = (msg.author || []).map(a => {
    const name = [a.given, a.family].filter(Boolean).join(' ');
    return {
      name,
      orcid: a.ORCID ? a.ORCID.replace('http://orcid.org/', '').replace('https://orcid.org/', '') : null,
      affiliation: (a.affiliation || []).map(af => af.name).join('; '),
      isSCI: false, // admin đánh dấu sau
    };
  });
  const authorString = authors.map(a => a.name).join(', ');

  // Ngày xuất bản
  const dateParts = msg['published-print']?.['date-parts']?.[0]
    || msg['published-online']?.['date-parts']?.[0]
    || msg['created']?.['date-parts']?.[0]
    || [];
  const pubYear  = dateParts[0] || null;
  const pubDate  = dateParts.length >= 3
    ? `${dateParts[0]}-${String(dateParts[1]).padStart(2,'0')}-${String(dateParts[2]).padStart(2,'0')}`
    : pubYear ? `${pubYear}` : null;

  // Journal / container
  const journalName = (msg['container-title'] || [])[0] || null;
  const publisher   = msg.publisher || null;
  const issn        = (msg.ISSN || [])[0] || null;
  const volume      = [
    msg.volume && `Vol. ${msg.volume}`,
    msg.issue  && `No. ${msg.issue}`,
  ].filter(Boolean).join(', ');
  const pages = msg.page || null;

  // Loại hình
  const typeMap = {
    'journal-article':         'journal',
    'proceedings-article':     'conference',
    'book-chapter':            'book_chapter',
    'monograph':               'book',
    'posted-content':          'preprint',
    'dataset':                 'dataset',
    'report':                  'report',
  };
  const pubType = typeMap[msg.type] || 'journal';

  // Tên hội nghị (nếu là proceedings)
  const conferenceName = (msg['event']?.name) || null;

  // Abstract (Crossref đôi khi có)
  const abstract = msg.abstract
    ? msg.abstract.replace(/<[^>]+>/g, '').trim()  // strip JATS XML tags
    : null;

  // Subjects/keywords
  const keywords = (msg.subject || []).join('; ');

  return {
    doi: msg.DOI,
    title: (msg.title || [])[0] || '',
    authors,
    authorString,
    journalName,
    publisher,
    issn,
    volume,
    pages,
    pubYear,
    pubDate,
    pubType,
    conferenceName,
    abstract,
    keywords,
    url: msg.URL || `https://doi.org/${msg.DOI}`,
    isOpenAccess: msg['is-referenced-by-count'] !== undefined
      ? (msg.license?.length > 0)
      : null,
    citationCount: msg['is-referenced-by-count'] || 0,
    source: 'crossref',
  };
}

// ── 1b. DATACITE (fallback) ───────────────────────────────────────────────────
async function fetchDataCite(doi) {
  const url = `${DATACITE_BASE}/${encodeURIComponent(doi)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/vnd.api+json',
      'User-Agent': `SCI-KHCN/1.0 (${POLITE_EMAIL})`,
    },
  }, 12000);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

function mapDataCiteResourceType(general, specific) {
  const g = (general || '').toLowerCase();
  const s = (specific || '').toLowerCase();
  if (g === 'journalarticle' || s.includes('journal')) return 'journal';
  if (g === 'proceedingsarticle' || g === 'conferencepaper') return 'conference';
  if (g === 'bookchapter') return 'book_chapter';
  if (g === 'book' || g === 'monograph') return 'book';
  if (g === 'dataset') return 'dataset';
  if (g === 'preprint' || s.includes('preprint')) return 'preprint';
  if (g === 'report') return 'report';
  return 'journal';
}

function parseDataCite(json) {
  const attr = json?.data?.attributes;
  if (!attr) throw new Error('Thiếu attributes');

  const doiVal = attr.doi || json.data.id;
  const titles = attr.titles || [];
  const title = (titles[0] && (titles[0].title || titles[0])) || '';

  const creators = attr.creators || [];
  const authors = creators.map((c) => {
    let name = c.name;
    if (!name && (c.givenName || c.familyName)) {
      name = [c.givenName, c.familyName].filter(Boolean).join(' ');
    }
    const aff = (c.affiliation || [])
      .map((a) => (typeof a === 'string' ? a : a.name))
      .filter(Boolean)
      .join('; ');
    const nid = (c.nameIdentifiers || []).find(
      (x) => (x.nameIdentifierScheme || '').toUpperCase() === 'ORCID'
    );
    const orcidRaw = nid?.nameIdentifier || null;
    const orcid = orcidRaw
      ? String(orcidRaw).replace(/^https?:\/\/orcid\.org\//i, '')
      : null;
    return { name: name || '', orcid, affiliation: aff, isSCI: false };
  });
  const authorString = authors.map((a) => a.name).filter(Boolean).join(', ');

  const pubYear = attr.publicationYear || attr.publicationYearEnd || null;
  const pubDate = pubYear ? String(pubYear) : null;

  const container = attr.container || {};
  const journalName = container.title || null;
  const contIds = Array.isArray(container.identifier) ? container.identifier : [];
  const attrIds = Array.isArray(attr.identifiers) ? attr.identifiers : [];
  const issn = contIds.find((i) => (i.identifierType || '').toUpperCase() === 'ISSN')?.identifier
    || attrIds.find((i) => (i.identifierType || '').toUpperCase() === 'ISSN')?.identifier
    || null;

  const vol = container.volume || attr.volume;
  const issue = container.issue || attr.issue;
  const volume = [vol && `Vol. ${vol}`, issue && `No. ${issue}`].filter(Boolean).join(', ') || null;
  const fp = attr.firstPage || container.firstPage;
  const lp = attr.lastPage || container.lastPage;
  const pages = fp && lp ? `${fp}–${lp}` : fp || lp || null;

  const types = attr.types || {};
  const pubType = mapDataCiteResourceType(types.resourceTypeGeneral, types.resourceType);

  const desc = (attr.descriptions || []).find((d) => (d.descriptionType || '').toLowerCase() === 'abstract')
    || attr.descriptions?.[0];
  const abstract = desc?.description
    ? String(desc.description).replace(/<[^>]+>/g, '').trim()
    : null;

  const keywords = (attr.subjects || [])
    .map((s) => (typeof s === 'string' ? s : s.subject))
    .filter(Boolean)
    .join('; ');

  return {
    doi: doiVal,
    title,
    authors,
    authorString,
    journalName,
    publisher: attr.publisher || null,
    issn,
    volume,
    pages,
    pubYear,
    pubDate,
    pubType,
    conferenceName: null,
    abstract,
    keywords: keywords || null,
    url: attr.url || `https://doi.org/${doiVal}`,
    isOpenAccess: null,
    citationCount: 0,
    source: 'datacite',
  };
}

// ── 1c. OPENALEX (fallback) ───────────────────────────────────────────────────
async function fetchOpenAlexByDoi(doi) {
  const doiUrl = `https://doi.org/${doi}`;
  const url = `${OPENALEX_BASE}/${encodeURIComponent(doiUrl)}?mailto=${encodeURIComponent(POLITE_EMAIL)}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': `SCI-KHCN/1.0 (mailto:${POLITE_EMAIL})` },
  }, 12000);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.error) return null;
  return json;
}

function openAlexAbstractFromInverted(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const tuples = [];
  for (const [word, positions] of Object.entries(inv)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) tuples.push([pos, word]);
  }
  tuples.sort((a, b) => a[0] - b[0]);
  const text = tuples.map((t) => t[1]).join(' ');
  return text.trim() || null;
}

function mapOpenAlexType(type) {
  const t = (type || '').toLowerCase().replace(/-/g, '');
  if (t === 'article') return 'journal';
  if (t === 'book') return 'book';
  if (t === 'bookchapter') return 'book_chapter';
  if (t === 'dataset') return 'dataset';
  if (t === 'preprint' || t === 'postedcontent') return 'preprint';
  if (t === 'proceedingsarticle' || t === 'conference') return 'conference';
  if (t === 'report') return 'report';
  if (t === 'peerreview') return 'journal';
  return 'journal';
}

function parseOpenAlex(work) {
  if (!work || !work.id) throw new Error('Work không hợp lệ');

  const title = work.display_name || work.title || '';
  const doiRaw = work.doi || work.ids?.doi || '';
  const doiNorm = String(doiRaw).replace(/^https?:\/\/doi\.org\//i, '').trim();

  const authorships = work.authorships || [];
  const authors = authorships.map((as) => {
    const a = as.author || {};
    const name = a.display_name || '';
    const orcid = (a.orcid || '').replace(/^https?:\/\/orcid\.org\//i, '') || null;
    const aff = (as.institutions || []).map((i) => i.display_name).filter(Boolean).join('; ');
    return { name, orcid, affiliation: aff, isSCI: false };
  });
  const authorString = authors.map((a) => a.name).filter(Boolean).join(', ');

  const src = work.primary_location?.source || work.host_venue || {};
  const journalName = src.display_name || null;
  const issn = src.issn_l || (src.issn && src.issn[0]) || null;

  const bib = work.biblio || {};
  const volume = [bib.volume && `Vol. ${bib.volume}`, bib.issue && `No. ${bib.issue}`]
    .filter(Boolean)
    .join(', ') || null;
  const pages = [bib.first_page, bib.last_page].filter(Boolean).join('–') || null;

  const pubYear = work.publication_year || null;
  const pubDate = pubYear ? String(pubYear) : null;

  const abstract = openAlexAbstractFromInverted(work.abstract_inverted_index);

  const pubType = mapOpenAlexType(work.type);

  return {
    doi: doiNorm,
    title,
    authors,
    authorString,
    journalName,
    publisher: null,
    issn,
    volume,
    pages,
    pubYear,
    pubDate,
    pubType,
    conferenceName: null,
    abstract,
    keywords: null,
    url: (doiNorm ? `https://doi.org/${doiNorm}` : null) || String(doiRaw || work.id || ''),
    isOpenAccess: null,
    citationCount: work.cited_by_count || 0,
    source: 'openalex',
  };
}

// ── 1d. mEDRA (CSL JSON) — fallback ───────────────────────────────────────────
async function fetchMedra(doi) {
  const url = `${MEDRA_BASE}/${encodeURIComponent(doi)}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: CSL_JSON_ACCEPT,
        'User-Agent': `SCI-KHCN/1.0 (${POLITE_EMAIL})`,
      },
    },
    12000
  );
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`mEDRA HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`mEDRA không parse được JSON (${e.message || e})`);
  }
}

function pickCslString(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) {
    const first = val[0];
    if (typeof first === 'string') return first.trim();
    if (first && typeof first === 'object' && first.value) return String(first.value).trim();
  }
  return String(val).trim();
}

function cslDatePartsToYearDate(issued) {
  if (!issued) return { pubYear: null, pubDate: null };
  const parts = issued['date-parts']?.[0];
  if (!parts || !parts.length) return { pubYear: null, pubDate: null };
  const y = parts[0] || null;
  const m = parts[1];
  const d = parts[2];
  const pubYear = y != null ? Number(y) : null;
  let pubDate = y != null ? String(y) : null;
  if (y != null && m != null && d != null) {
    pubDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return { pubYear: Number.isFinite(pubYear) ? pubYear : null, pubDate };
}

function mapCslTypeToPubType(cslType) {
  const t = (cslType || '').toLowerCase().replace(/-/g, '');
  if (t === 'article' || t === 'articlejournal' || t === 'article-journal') return 'journal';
  if (t === 'paperconference' || t === 'paper-conference') return 'conference';
  if (t === 'chapter') return 'book_chapter';
  if (t === 'book' || t === 'monograph') return 'book';
  if (t === 'dataset') return 'dataset';
  if (t === 'report') return 'report';
  if (t === 'manuscript' || t === 'preprint') return 'preprint';
  return 'journal';
}

function parseMedraCsl(csl, doiFallback) {
  if (!csl || typeof csl !== 'object') throw new Error('mEDRA CSL rỗng');

  const doiVal = pickCslString(csl.DOI || csl.doi) || doiFallback;
  const title = pickCslString(csl.title) || doiVal;
  const journalName = pickCslString(csl['container-title']) || null;

  const authorArr = Array.isArray(csl.author) ? csl.author : [];
  const authors = authorArr.map((a) => {
    let name = '';
    if (a.literal) name = String(a.literal).trim();
    else name = [a.given, a.family].filter(Boolean).join(' ').trim();
    return { name, orcid: null, affiliation: '', isSCI: false };
  });
  const authorString = authors.map((a) => a.name).filter(Boolean).join(', ');

  const { pubYear, pubDate } = cslDatePartsToYearDate(csl.issued);
  const volume = [csl.volume && `Vol. ${csl.volume}`, csl.issue && `No. ${csl.issue}`]
    .filter(Boolean)
    .join(', ') || null;
  const pages = pickCslString(csl.page) || null;
  const pubType = mapCslTypeToPubType(csl.type);
  const url = pickCslString(csl.URL) || (doiVal ? `https://doi.org/${doiVal}` : '');

  return {
    doi: doiVal,
    title,
    authors,
    authorString,
    journalName,
    publisher: pickCslString(csl.publisher) || null,
    issn: null,
    volume,
    pages,
    pubYear,
    pubDate,
    pubType,
    conferenceName: null,
    abstract: null,
    keywords: null,
    url: url || null,
    isOpenAccess: null,
    citationCount: 0,
    source: 'medra',
  };
}

// ── Fallback ORCID (work summary từ harvest) ─────────────────────────────────
function buildBaseFromOrcidRaw(doi, orcidRaw) {
  if (orcidRaw == null || typeof orcidRaw !== 'object') return null;

  const rawDoi = orcidRaw.doi != null ? normalizeDOI(String(orcidRaw.doi)) : null;
  const titleRaw = typeof orcidRaw.title === 'string' ? orcidRaw.title.trim() : '';
  const journalName = orcidRaw.journalTitle || orcidRaw['journal-title'] || null;
  let pubYear = null;
  if (orcidRaw.pubYear != null && orcidRaw.pubYear !== '') {
    const n = parseInt(String(orcidRaw.pubYear), 10);
    if (Number.isFinite(n)) pubYear = n;
  }
  const url = orcidRaw.url || `https://doi.org/${doi}`;
  const putCode = orcidRaw.putCode != null && orcidRaw.putCode !== ''
    ? String(orcidRaw.putCode)
    : null;

  const title = titleRaw || doi;

  return {
    doi: rawDoi || doi,
    title,
    authors: [],
    authorString: '',
    journalName,
    publisher: null,
    issn: null,
    volume: null,
    pages: null,
    pubYear,
    pubDate: pubYear != null ? String(pubYear) : null,
    pubType: 'journal',
    conferenceName: null,
    abstract: null,
    keywords: null,
    url,
    isOpenAccess: null,
    citationCount: 0,
    source: 'orcid_raw',
    orcid_put_code: putCode,
  };
}

function minimalBaseFromDoi(doi) {
  return {
    doi,
    title: doi,
    authors: [],
    authorString: '',
    journalName: null,
    publisher: null,
    issn: null,
    volume: null,
    pages: null,
    pubYear: null,
    pubDate: null,
    pubType: 'journal',
    conferenceName: null,
    abstract: null,
    keywords: null,
    url: `https://doi.org/${doi}`,
    isOpenAccess: null,
    citationCount: 0,
    source: 'none',
    orcid_put_code: null,
  };
}

function dataSourceToResolverKey(dataSource) {
  const inv = Object.fromEntries(
    Object.entries(DATA_SOURCE_LABEL).map(([k, v]) => [v, k])
  );
  return inv[dataSource] || String(dataSource || 'none').toLowerCase();
}

// ── 2. PUBMED ─────────────────────────────────────────────────────────────────
async function fetchPubMedByDOI(doi) {
  // Bước 1: esearch — tìm PMID từ DOI
  const searchUrl = `${PUBMED_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(doi)}[doi]&retmode=json`;
  const searchRes = await fetchWithTimeout(searchUrl, {}, 8000);
  if (!searchRes.ok) throw new Error('PubMed esearch failed');
  const searchJson = await searchRes.json();
  const pmids = searchJson.esearchresult?.idlist || [];
  if (!pmids.length) return null;

  const pmid = pmids[0];

  // Bước 2: efetch — lấy metadata đầy đủ
  const fetchUrl = `${PUBMED_BASE}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=json&rettype=abstract`;
  const fetchRes = await fetchWithTimeout(fetchUrl, {}, 8000);
  if (!fetchRes.ok) throw new Error('PubMed efetch failed');
  const fetchJson = await fetchRes.json();

  return { pmid, data: fetchJson.PubmedArticleSet?.PubmedArticle?.[0] };
}

function parsePubMed(result) {
  if (!result?.data) return null;
  const article = result.data.MedlineCitation?.Article;
  const abstract = article?.Abstract?.AbstractText;
  return {
    pmid: result.pmid,
    abstractText: Array.isArray(abstract)
      ? abstract.map(t => typeof t === 'string' ? t : t?._ || '').join(' ')
      : (typeof abstract === 'string' ? abstract : null),
    meshTerms: (result.data.MedlineCitation?.MeshHeadingList?.MeshHeading || [])
      .map(m => m.DescriptorName?._ || m.DescriptorName || '')
      .filter(Boolean)
      .join('; '),
  };
}

function shouldFetchPubMed(base) {
  const bioKeywords = ['stem cell', 'therapy', 'clinical', 'cancer', 'gene', 'biology',
                       'medicine', 'immuno', 'protein', 'cell', 'nk', 'msc'];
  const titleLower = (base.title || '').toLowerCase();
  return bioKeywords.some(k => titleLower.includes(k));
}

// ── 3. UNPAYWALL ─────────────────────────────────────────────────────────────
async function fetchUnpaywall(doi) {
  const url = `${UNPAYWALL_BASE}/${encodeURIComponent(doi)}?email=${POLITE_EMAIL}`;
  const res = await fetchWithTimeout(url, {}, 8000);
  if (!res.ok) return null;
  return res.json();
}

function parseUnpaywall(data) {
  if (!data) return null;
  return {
    isOpenAccess: data.is_oa || false,
    oaStatus:     data.oa_status || null, // gold | green | diamond | hybrid | closed
    oaUrl:        data.best_oa_location?.url || null,
    license:      data.best_oa_location?.license || null,
  };
}

// ── 4. SCOPUS (tuỳ chọn — cần Institutional API Key) ─────────────────────────
// Liên hệ Elsevier: https://dev.elsevier.com để xin API key cho trường
async function fetchScopus(doi) {
  if (!process.env.SCOPUS_API_KEY) return null;
  const url = `${SCOPUS_BASE}/abstract/doi/${encodeURIComponent(doi)}?apiKey=${process.env.SCOPUS_API_KEY}&httpAccept=application%2Fjson`;
  const res = await fetchWithTimeout(url, {}, 10000);
  if (!res.ok) return null;
  const json = await res.json();
  const entry = json['abstracts-retrieval-response']?.coredata;
  if (!entry) return null;
  return {
    scopusEid:  entry['eid'] || null,
    citedByCount: parseInt(entry['citedby-count'] || '0'),
    subjectArea: (json['abstracts-retrieval-response']?.['subject-areas']?.['subject-area'] || [])
      .map(s => s['$']).join('; '),
  };
}

// ── Merge tất cả nguồn ────────────────────────────────────────────────────────
function mergeEnrichedData({
  doi,
  base,
  pubmedData,
  scopusData,
  oaData,
  import_status,
  data_source,
}) {
  const ds = data_source || DATA_SOURCE_LABEL.crossref;
  const istatus = import_status || 'SUCCESS';

  return {
    // Định danh
    doi:            base.doi || doi,
    pmid:           pubmedData?.pmid || null,
    scopus_eid:     scopusData?.scopusEid || null,
    orcid_put_code: base.orcid_put_code != null ? base.orcid_put_code : null,

    // Nội dung
    title:          base.title,
    abstract:       pubmedData?.abstractText || base.abstract || null,
    keywords:       [base.keywords, pubmedData?.meshTerms].filter(Boolean).join('; ') || null,
    authors:        base.authorString,
    authors_json:   JSON.stringify(base.authors),
    language:       'en',

    // Xuất bản
    pub_type:       base.pubType,
    journal_name:   base.journalName,
    issn:           base.issn,
    volume:         base.volume,
    pages:          base.pages,
    pub_year:       base.pubYear,
    pub_date:       base.pubDate,
    publisher:      base.publisher,
    conference_name: base.conferenceName,
    url:            base.url,

    // Chỉ số (điền thêm thủ công hoặc từ Scopus API)
    citation_count:  scopusData?.citedByCount || base.citationCount || 0,
    citation_updated_at: new Date().toISOString(),

    // Open Access
    is_open_access: oaData?.isOpenAccess ? 1 : 0,
    oa_type:        oaData?.oaStatus || null,

    // Nguồn & cờ admin (RIMS)
    source:         'doi_fetch',
    import_status:  istatus,
    data_source:    ds,

    // Metadata cần admin điền thêm
    _needsReview: {
      quartile:       null,
      impact_factor:  null,
      index_db:       null,
      sci_authors:    null,
      project_code:   null,
      doi_metadata_resolver: dataSourceToResolverKey(ds),
    },
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────
function normalizeDOI(input) {
  if (!input) return null;
  let doi = input.trim();
  // Bỏ prefix https://doi.org/ hoặc http://dx.doi.org/
  doi = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  // Validate: phải bắt đầu bằng 10.
  if (!/^10\.\d{4,}\//.test(doi)) return null;
  return doi;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}
