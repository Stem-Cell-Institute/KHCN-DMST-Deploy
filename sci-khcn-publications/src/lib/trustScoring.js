/**
 * Trust score engine for author disambiguation — SCI / HCMUS.
 * Per-researcher profile with institute-wide base config.
 * Pure module: no DB or Express.
 */

'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _profileCache = null;

function getProfiles() {
  if (_profileCache) return _profileCache;
  const configPath = path.join(__dirname, '../../config/researcherProfiles.json');
  try {
    _profileCache = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`[trustScoring] Cannot read researcherProfiles.json: ${e.message}`);
  }
  return _profileCache;
}

function reloadProfiles() {
  _profileCache = null;
  return getProfiles();
}

/** Remove diacritics for matching BibTeX (ASCII) vs display names (Vietnamese). */
function foldAscii(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd');
}

/** Single searchable blob from authors field (array of strings or one comma-separated string). */
function authorsToSearchBlob(item) {
  let parts = [];
  if (Array.isArray(item.authors)) {
    parts = item.authors.map((x) => String(x).trim()).filter(Boolean);
  } else if (item.authors != null && String(item.authors).trim() !== '') {
    parts = [String(item.authors).trim()];
  }
  const raw = parts.join(' ').trim();
  return foldAscii(raw)
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const AUTHOR_NAME_STOPWORDS = new Set(['et', 'al', 'and', 'jr', 'sr', 'dr']);

/**
 * One segment per author. BibTeX / Scholar usually separates with " and "
 * (each segment can still contain a comma: "Pham, Phuc Van").
 */
function authorSegmentsFromBlob(authorsBlob) {
  if (!authorsBlob || !String(authorsBlob).trim()) return [];
  const normalized = String(authorsBlob)
    .replace(/;/g, ' and ')
    .trim();
  return normalized
    .split(/\s+and\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

function looseCoauthorTokensMatch(authorsBlob, coauthorName) {
  const fold = foldAscii(String(coauthorName))
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = fold.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return false;
  return tokens.every((t) => authorsBlob.includes(t));
}

function getResearcherDisplayAndVariants(researcherKey) {
  if (!researcherKey) return [];
  const val = getProfiles().researchers?.[researcherKey];
  if (!val) return [];
  const out = [];
  if (val.display_name) out.push(String(val.display_name));
  for (const v of val.name_variants ?? []) out.push(String(v));
  return out;
}

/**
 * True if the selected NCV appears in the author list.
 * Handles "Phuc Van Pham" order and BibTeX "Pham, Phuc Van" (same token set).
 */
function matchTargetResearcherInAuthors(authorsBlob, researcherKey) {
  if (!researcherKey || !authorsBlob) return false;
  for (const name of getResearcherDisplayAndVariants(researcherKey)) {
    const n = foldAscii(name)
      .toLowerCase()
      .replace(/\./g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (n.length >= 6 && authorsBlob.includes(n)) return true;
  }
  const sigSet = getResearcherTokenSignatures(researcherKey);
  if (!sigSet.size) return false;
  for (const seg of authorSegmentsFromBlob(authorsBlob)) {
    const ss = nameTokenSignature(seg);
    if (ss && sigSet.has(ss)) return true;
  }
  return false;
}

function nameTokenSignature(name) {
  const tokens = foldAscii(String(name))
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\./g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !AUTHOR_NAME_STOPWORDS.has(t));
  if (!tokens.length) return '';
  return [...new Set(tokens)].sort().join('|');
}

function getResearcherTokenSignatures(researcherKey) {
  const set = new Set();
  for (const n of getResearcherDisplayAndVariants(researcherKey)) {
    const sig = nameTokenSignature(n);
    if (sig) set.add(sig);
  }
  return set;
}

/** Skip institute coauthor row if it is the same person as the selected NCV. */
function coauthorIsResearcherSelf(coauthorName, researcherKey) {
  if (!researcherKey) return false;
  const caSig = nameTokenSignature(coauthorName);
  if (!caSig) return false;
  for (const n of getResearcherDisplayAndVariants(researcherKey)) {
    if (nameTokenSignature(n) === caSig) return true;
  }
  return false;
}

/** Normalize ISSN for comparison (digits + trailing X). */
function normalizeIssn(raw) {
  if (raw == null || String(raw).trim() === '') return '';
  return String(raw).replace(/[^0-9xX]/g, '').toLowerCase();
}

function issnListMatches(itemIssn, list) {
  const n = normalizeIssn(itemIssn);
  if (!n || n.length < 7) return null;
  for (const entry of list || []) {
    if (normalizeIssn(entry) === n) return String(entry).trim();
  }
  return null;
}

const TARGET_AUTHOR_BONUS = 62;

/**
 * @param {Object} item
 * @param {string|null|undefined} researcherKey
 * @returns {{ trust_score: number, classification: string, flags: Object }}
 */
function computeTrustScore(item, researcherKey) {
  const profiles = getProfiles();
  const inst = profiles.institute || {};
  const res = profiles.researchers?.[researcherKey] ?? {};

  let score = 0;
  const authorsBlob = authorsToSearchBlob(item);
  const crawlFailed = item.crawl_failed === true;

  const flags = {
    affiliation_confirmed: null,
    affiliation_negative_hit: null,
    keyword_match_count: 0,
    keyword_penalty: false,
    journal_match: null,
    coauthor_match_count: 0,
    coauthor_names_matched: [],
    target_researcher_in_authors: false,
    crawl_failed_no_keyword_penalty: false,
  };

  const affiliationSources = [...(item.affiliations ?? []), item.crawledBodyText ?? '']
    .join(' ')
    .toLowerCase();

  for (const marker of inst.affiliation_positive ?? []) {
    const m = String(marker).toLowerCase();
    if (affiliationSources.includes(m)) {
      score += 80;
      flags.affiliation_confirmed = marker;
      break;
    }
  }

  for (const marker of inst.affiliation_negative ?? []) {
    const m = String(marker).toLowerCase();
    if (affiliationSources.includes(m)) {
      score -= 80;
      flags.affiliation_negative_hit = marker;
      break;
    }
  }

  if (item.issn != null && String(item.issn).trim() !== '') {
    const allISSN = [...(inst.known_journals_issn ?? []), ...(res.frequent_journals_issn ?? [])];
    const hit = issnListMatches(item.issn, allISSN);
    if (hit) {
      score += 30;
      flags.journal_match = hit;
    }
  }

  const titleLower = String(item.title ?? '').toLowerCase();
  const strongKw = [...(inst.base_keywords_strong ?? []), ...(res.keywords_strong_add ?? [])];
  const medKw = [...(inst.base_keywords_medium ?? []), ...(res.keywords_medium_add ?? [])];

  let kwCount = 0;
  for (const kw of strongKw) {
    if (titleLower.includes(String(kw).toLowerCase())) {
      score += 10;
      kwCount++;
    }
  }
  for (const kw of medKw) {
    if (titleLower.includes(String(kw).toLowerCase())) {
      score += 5;
      kwCount++;
    }
  }
  flags.keyword_match_count = kwCount;

  if (researcherKey && matchTargetResearcherInAuthors(authorsBlob, researcherKey)) {
    score += TARGET_AUTHOR_BONUS;
    flags.target_researcher_in_authors = true;
  }

  const shouldApplyKeywordPenalty =
    kwCount === 0 &&
    !flags.affiliation_confirmed &&
    !flags.target_researcher_in_authors &&
    !crawlFailed;

  if (shouldApplyKeywordPenalty) {
    score -= 15;
    flags.keyword_penalty = true;
  } else if (kwCount === 0 && !flags.affiliation_confirmed && crawlFailed) {
    flags.crawl_failed_no_keyword_penalty = true;
  }

  for (const ca of inst.known_coauthors ?? []) {
    if (researcherKey && coauthorIsResearcherSelf(ca, researcherKey)) continue;
    const hit =
      authorsBlob.includes(String(ca).toLowerCase()) || looseCoauthorTokensMatch(authorsBlob, ca);
    if (hit) {
      score += 30;
      flags.coauthor_match_count++;
      flags.coauthor_names_matched.push(ca);
    }
  }

  for (const ca of res.frequent_coauthors ?? []) {
    if (researcherKey && coauthorIsResearcherSelf(ca, researcherKey)) continue;
    const hit =
      authorsBlob.includes(String(ca).toLowerCase()) || looseCoauthorTokensMatch(authorsBlob, ca);
    if (hit) {
      score += 20;
      flags.coauthor_match_count++;
      flags.coauthor_names_matched.push(ca);
    }
  }

  const yr = Number(item.year);
  if (!Number.isNaN(yr) && yr > 1900) {
    if (yr >= 2007) score += 5;
    if (yr < 2005) score -= 20;
  }

  const classification = classifyScore(score);
  return { trust_score: score, classification, flags };
}

function classifyScore(score) {
  if (score > 80) return 'High Confidence - Keep';
  if (score >= 0) return 'Manual Review Needed';
  return 'Exclude';
}

function normalizeResearcherQuery(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Map free-text input (display name, name variant, or config key) to researchers{} key.
 * @param {string|null|undefined} rawInput
 * @returns {string|null}
 */
function resolveResearcherKey(rawInput) {
  if (rawInput == null) return null;
  const trimmed = String(rawInput).trim();
  if (!trimmed) return null;
  const researchers = getProfiles().researchers ?? {};
  if (researchers[trimmed]) return trimmed;
  const q = normalizeResearcherQuery(trimmed);
  for (const [key, val] of Object.entries(researchers)) {
    if (key.toLowerCase() === q) return key;
    if (normalizeResearcherQuery(key.replace(/_/g, ' ')) === q) return key;
    const dn = normalizeResearcherQuery(val.display_name);
    if (dn && dn === q) return key;
    for (const v of val.name_variants ?? []) {
      if (normalizeResearcherQuery(v) === q) return key;
    }
  }
  return null;
}

function listResearchers() {
  const profiles = getProfiles();
  return Object.entries(profiles.researchers ?? {}).map(([key, val]) => ({
    key,
    display_name: val.display_name ?? key,
  }));
}

function getNameVariants(researcherKey) {
  const profiles = getProfiles();
  return profiles.researchers?.[researcherKey]?.name_variants ?? [];
}

function getInstituteCrawlDefaults() {
  try {
    const inst = getProfiles().institute || {};
    const d = Number(inst.crawl_delay_ms);
    const t = Number(inst.crawl_timeout_ms);
    return {
      crawlDelayMs: Number.isFinite(d) && d > 0 ? d : 450,
      timeoutMs: Number.isFinite(t) && t > 0 ? t : 15000,
    };
  } catch {
    return { crawlDelayMs: 450, timeoutMs: 15000 };
  }
}

export {
  computeTrustScore,
  classifyScore,
  resolveResearcherKey,
  listResearchers,
  getNameVariants,
  reloadProfiles,
  getInstituteCrawlDefaults,
};
