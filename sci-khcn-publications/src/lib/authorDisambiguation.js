/**
 * Academic Author Disambiguation — scoring for NCV profile (server-side).
 * Crawl + cheerio unchanged; trust score via config-driven trustScoring.js.
 */

import { computeTrustScore, getInstituteCrawlDefaults } from './trustScoring.js';

const KW_STRONG = [
  'stem cell',
  'mesenchymal',
  'exosome',
  'regenerative',
  'cancer stem cell',
  'ipsc',
  'prp',
];
const KW_MEDIUM = ['nanoparticle', 'curcumin', 'extract', 'apoptosis'];

const POSITIVE_AFFILIATION_MARKERS = [
  'university of science',
  'vnu-hcm',
  'vnu hcm',
  'stem cell institute',
  'laboratory of stem cell research and application',
];

const NEGATIVE_AFFILIATION_MARKERS = [
  'vietnam academy of science and technology',
  'vast',
  // "hanoi" per spec — may false-positive; keep as weak signal in crawl text only
  'hanoi',
];

const KNOWN_COAUTHORS = [
  'phan kim ngoc',
  'truong dinh kiet',
  'le van dong',
  'vu bich ngoc',
];

const SCORE_HIGH_MIN = 80;
const SCORE_MANUAL_MAX = 80;
const SCORE_MANUAL_MIN = 0;

/**
 * Bước 1–2: keyword + temporal (không cần URL).
 */
export function scoreKeywordsAndYear(title, year) {
  let score = 0;
  const t = title != null ? String(title).toLowerCase() : '';
  for (const kw of KW_STRONG) {
    if (t.includes(kw)) score += 10;
  }
  for (const kw of KW_MEDIUM) {
    if (t.includes(kw)) score += 5;
  }
  const y = year != null && year !== '' ? Number(year) : null;
  if (y != null && !Number.isNaN(y)) {
    if (y >= 2007) score += 5;
    if (y < 2005) score -= 20;
  }
  return score;
}

/**
 * Bước 3: phân tích HTML đã tải (lowercase body text).
 */
export function scoreAffiliationFromText(pageTextLower) {
  let delta = 0;
  const matched = { positive: [], negative: [], coauthors: [] };
  if (!pageTextLower || typeof pageTextLower !== 'string') {
    return { delta, matched };
  }
  for (const m of POSITIVE_AFFILIATION_MARKERS) {
    if (pageTextLower.includes(m)) {
      delta += 100;
      matched.positive.push(m);
      break;
    }
  }
  for (const m of NEGATIVE_AFFILIATION_MARKERS) {
    if (pageTextLower.includes(m)) {
      delta -= 100;
      matched.negative.push(m);
      break;
    }
  }
  for (const name of KNOWN_COAUTHORS) {
    if (pageTextLower.includes(name)) {
      delta += 50;
      matched.coauthors.push(name);
    }
  }
  return { delta, matched };
}

function isAllowedDetailUrl(url) {
  if (url == null || String(url).trim() === '') return false;
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Tải URL và trả toàn bộ chữ thường (cheerio).
 */
export async function fetchPageTextLower(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!isAllowedDetailUrl(url)) {
    return { ok: false, text: '', error: 'invalid_or_missing_url' };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(String(url).trim(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SCI-KHCN-disambiguation/1.0; +https://sci.edu.vn)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      return { ok: false, text: '', error: `http_${res.status}` };
    }
    const html = await res.text();
    const { load } = await import('cheerio');
    const $ = load(html);
    $('script, style, noscript').remove();
    const text = $('body').text() || '';
    return { ok: true, text: text.toLowerCase().replace(/\s+/g, ' '), error: null };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : String(e.message || e);
    return { ok: false, text: '', error: msg };
  } finally {
    clearTimeout(t);
  }
}

export function classifyTrustScore(score) {
  if (score > SCORE_HIGH_MIN) return 'High Confidence - Keep';
  if (score >= SCORE_MANUAL_MIN && score <= SCORE_MANUAL_MAX) return 'Manual Review Needed';
  return 'Exclude';
}

/**
 * @param {Array<object>} items — id, title, year, detail_url|detailUrl; optional authors[], affiliations[], issn
 * @param {object} [options]
 * @param {string|null} [options.researcherKey] — key trong researcherProfiles.json (vd: pham_van_phuc)
 */
export async function disambiguateItems(items, options = {}) {
  const crawlDefaults = getInstituteCrawlDefaults();
  const delayMs =
    options.crawlDelayMs != null ? options.crawlDelayMs : crawlDefaults.crawlDelayMs;
  const fetchOpts = {
    ...options,
    timeoutMs: options.timeoutMs != null ? options.timeoutMs : crawlDefaults.timeoutMs,
  };
  const researcherKey = options.researcherKey ?? null;

  const out = [];
  for (const row of items) {
    const detailUrl = row.detail_url != null ? row.detail_url : row.detailUrl;

    let crawledText = null;
    const crawlMeta = { attempted: false, error: null, matched: null };

    if (isAllowedDetailUrl(detailUrl)) {
      crawlMeta.attempted = true;
      const fetched = await fetchPageTextLower(detailUrl, fetchOpts);
      if (fetched.ok) {
        crawledText = fetched.text;
      } else {
        crawlMeta.error = fetched.error;
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }

    const authors = row.authors;
    const affiliations = Array.isArray(row.affiliations) ? row.affiliations : [];
    const crawlFailed = Boolean(crawlMeta.attempted && crawlMeta.error);

    const scoreResult = computeTrustScore(
      {
        title: row.title,
        year: row.year,
        authors,
        affiliations,
        issn: row.issn,
        crawledBodyText: crawledText,
        crawl_failed: crawlFailed,
      },
      researcherKey
    );

    const f = scoreResult.flags;
    let crawl_note;
    if (!crawlMeta.attempted) {
      crawl_note = 'no_detail_url';
    } else if (crawlMeta.error) {
      crawl_note = `crawl: ${crawlMeta.error}`;
    } else {
      crawl_note = JSON.stringify({
        positive: f.affiliation_confirmed ? [f.affiliation_confirmed] : [],
        negative: f.affiliation_negative_hit ? [f.affiliation_negative_hit] : [],
        coauthors: f.coauthor_names_matched || [],
        journal: f.journal_match || null,
      });
    }

    out.push({
      ...row,
      detail_url: detailUrl || null,
      trust_score: scoreResult.trust_score,
      classification: scoreResult.classification,
      crawl_note,
      score_flags: scoreResult.flags,
    });
  }
  return out;
}
