/**
 * Enrichment cho ORCID work không có DOI (sau dedup).
 * Thứ tự: Europe PMC (PMID/PMCID) → Scopus API theo EID (nếu có key) → OpenAlex (WOS/Scopus fallback) → ORCID raw.
 */

import { enrichWorkFromEuropePmc } from './europePmcService.js';
import { enrichWorkFromScopusEid } from './scopusByEidService.js';
import { enrichWorkFromOpenAlex } from './openAlexExternalService.js';

export function mapOrcidWorkType(workType) {
  const t = String(workType || '').toUpperCase();
  if (t.includes('JOURNAL')) return 'journal';
  if (t.includes('CONFERENCE') || t.includes('PROCEEDINGS')) return 'conference';
  if (t.includes('BOOK')) return 'book';
  if (t.includes('PATENT')) return 'patent';
  if (t.includes('PREPRINT')) return 'preprint';
  return 'journal';
}

export function buildEnrichedFromOrcidWorkOnly(work) {
  const title = work.title && String(work.title).trim()
    ? String(work.title).trim()
    : 'Unknown Title';
  const authors = work.contributorsSummary || '';

  return {
    doi: work.doi || null,
    pmid: work.pmid || null,
    pmc_id: work.pmc_id || null,
    wos_id: work.wos_id || null,
    scopus_eid: work.scopus_id || null,
    title,
    journal_name: work.journalTitle || null,
    pub_year: work.pubYear != null && !Number.isNaN(Number(work.pubYear)) ? Number(work.pubYear) : null,
    pub_type: mapOrcidWorkType(work.workType),
    authors: typeof authors === 'string' ? authors : '',
    url: work.url || null,
    source: 'orcid_harvest',
    orcid_put_code: work.putCode || null,
    import_status: 'pending_review',
    abstract: null,
    keywords: null,
    enrichmentSource: 'ORCID Raw (No API)',
    enrichmentGroup: 'ORCID_Raw',
    _needsReview: {
      quartile: null,
      impact_factor: null,
      index_db: null,
      sci_authors: null,
      project_code: null,
      doi_metadata_resolver: 'orcid_summary_only',
    },
  };
}

function mergeOrcidIdsIntoEnriched(enriched, work) {
  if (!enriched || typeof enriched !== 'object') return enriched;
  return {
    ...enriched,
    wos_id: enriched.wos_id ?? work.wos_id ?? null,
    scopus_eid: enriched.scopus_eid ?? work.scopus_id ?? null,
    pmid: enriched.pmid ?? work.pmid ?? null,
    pmc_id: enriched.pmc_id ?? work.pmc_id ?? null,
    orcid_put_code: enriched.orcid_put_code ?? work.putCode ?? null,
  };
}

/**
 * @param {object} orcidWork — object từ parseOrcidWorks
 * @returns {Promise<{ enriched: object, enrichmentSource: string, enrichmentGroup: string }>}
 */
export async function enrichOrcidWorkWithoutDoi(orcidWork) {
  const hasPmidOrPmc = !!(orcidWork?.pmid || orcidWork?.pmc_id);

  if (hasPmidOrPmc) {
    try {
      const epm = await enrichWorkFromEuropePmc(orcidWork);
      if (epm.enriched) {
        const enriched = mergeOrcidIdsIntoEnriched(epm.enriched, orcidWork);
        return {
          enriched,
          enrichmentSource: epm.enrichmentSource,
          enrichmentGroup: epm.enrichmentGroup,
        };
      }
    } catch (e) {
      console.warn('[ORCID][EuropePMC] enrich lỗi:', e.message);
    }
    // Có PMID/PMC nhưng Europe PMC không trả dữ liệu — không gọi OpenAlex (theo spec: OA chỉ khi không có PMID/PMC)
    const raw = buildEnrichedFromOrcidWorkOnly(orcidWork);
    return {
      enriched: mergeOrcidIdsIntoEnriched(raw, orcidWork),
      enrichmentSource: raw.enrichmentSource,
      enrichmentGroup: raw.enrichmentGroup,
    };
  }

  if (orcidWork?.scopus_id) {
    try {
      const sc = await enrichWorkFromScopusEid(orcidWork);
      if (sc.enriched) {
        const enriched = mergeOrcidIdsIntoEnriched(sc.enriched, orcidWork);
        return {
          enriched,
          enrichmentSource: sc.enrichmentSource,
          enrichmentGroup: sc.enrichmentGroup,
        };
      }
    } catch (e) {
      console.warn('[ORCID][Scopus] enrich lỗi:', e.message);
    }
  }

  if (orcidWork?.wos_id || orcidWork?.scopus_id) {
    try {
      const ox = await enrichWorkFromOpenAlex(orcidWork);
      if (ox.enriched) {
        const enriched = mergeOrcidIdsIntoEnriched(ox.enriched, orcidWork);
        return {
          enriched,
          enrichmentSource: ox.enrichmentSource,
          enrichmentGroup: ox.enrichmentGroup,
        };
      }
    } catch (e) {
      console.warn('[ORCID][OpenAlex] enrich lỗi:', e.message);
    }
  }

  const raw = buildEnrichedFromOrcidWorkOnly(orcidWork);
  return {
    enriched: mergeOrcidIdsIntoEnriched(raw, orcidWork),
    enrichmentSource: raw.enrichmentSource,
    enrichmentGroup: raw.enrichmentGroup,
  };
}
