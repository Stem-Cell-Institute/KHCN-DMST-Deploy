/**
 * src/services/orcidService.js
 * ORCID Auto-Harvest Service
 *
 * Pipeline cho mỗi phiên harvest:
 *   1. Lấy danh sách NCV có ORCID từ DB
 *   2. Gọi ORCID Public API v3.0 → lấy danh sách works
 *   3. Lọc works chưa có trong DB / hàng chờ (dedup thác nước: DOI → put-code → WOS/Scopus/PMID/PMC → tiêu đề+năm)
 *   4. Enrich: có DOI → fetchAndEnrichDOI; không DOI → Europe PMC (PMID/PMC) / Scopus API (EID) / OpenAlex / ORCID raw
 *   5. Đưa vào publication_queue chờ admin duyệt
 *   6. Ghi log vào orcid_harvest_logs
 *
 * ORCID Public API: hoàn toàn miễn phí, không cần token
 * Rate limit: 24 req/s — chúng ta dùng 1 req/600ms để an toàn
 */

import { getDB } from '../db/index.js';
import { fetchAndEnrichDOI } from './doiService.js';
import { enrichOrcidWorkWithoutDoi } from './orcidNoDoiEnrichService.js';
import { randomUUID } from 'crypto';

const ORCID_API   = 'https://pub.orcid.org/v3.0';
const RATE_DELAY  = 600; // ms giữa các request (= ~1.6 req/s, an toàn dưới ngưỡng 24/s)

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const e = new Error('Phiên quét đã dừng');
    e.name = 'AbortError';
    throw e;
  }
}

/** Normalize full_name for harvest filter matching (exact match after NFC + trim). */
function normHarvestResearcherName(s) {
  return String(s || '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeOrcidForFilter(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
  return (m ? m[1] : s).toUpperCase();
}

/**
 * Keep researchers that match ANY of the provided researcherIds, orcidIds, or fullNames (OR).
 * If no filter arrays are set, returns the input list unchanged.
 */
function applyHarvestResearcherFilters(researchers, { researcherIds, orcidIds, fullNames } = {}) {
  const idSet =
    researcherIds?.length > 0
      ? new Set(
          researcherIds
            .map((n) => Number(n))
            .filter((n) => Number.isInteger(n) && n > 0)
        )
      : null;
  const orcSet =
    orcidIds?.length > 0 ? new Set(orcidIds.map((o) => normalizeOrcidForFilter(o))) : null;
  const nameSet =
    fullNames?.length > 0 ? new Set(fullNames.map((n) => normHarvestResearcherName(n))) : null;

  if (!idSet && !orcSet && !nameSet) return researchers;

  return researchers.filter((r) => {
    const byId = idSet ? idSet.has(Number(r.id)) : false;
    const byOrc = orcSet ? orcSet.has(normalizeOrcidForFilter(r.orcid_id)) : false;
    const byName = nameSet ? nameSet.has(normHarvestResearcherName(r.full_name)) : false;
    const checks = [];
    if (idSet) checks.push(byId);
    if (orcSet) checks.push(byOrc);
    if (nameSet) checks.push(byName);
    return checks.some(Boolean);
  });
}

/** Nhóm công bố mới theo enrichmentGroup (SSE / POST harvest). */
export function groupNewWorksForResponse(items) {
  const newWorksGrouped = {
    DOI_Crossref: [],
    Europe_PMC: [],
    Scopus: [],
    OpenAlex: [],
    ORCID_Raw: [],
  };
  for (const it of items || []) {
    const k = it.enrichmentGroup && Object.prototype.hasOwnProperty.call(newWorksGrouped, it.enrichmentGroup)
      ? it.enrichmentGroup
      : 'ORCID_Raw';
    newWorksGrouped[k].push(it);
  }
  const stats = {
    total: (items || []).length,
    doi: newWorksGrouped.DOI_Crossref.length,
    europe_pmc: newWorksGrouped.Europe_PMC.length,
    scopus: newWorksGrouped.Scopus.length,
    openalex: newWorksGrouped.OpenAlex.length,
    raw: newWorksGrouped.ORCID_Raw.length,
  };
  return { newWorksGrouped, stats };
}

/** Tiêu đề hiển thị khi ghi nhận bài bị loại */
function orcidWorkDisplayTitle(work) {
  if (work?.title != null && String(work.title).trim()) return String(work.title).trim();
  return 'Unknown Title';
}

/** Chuẩn hóa external-id-type từ ORCID để so khớp */
function normalizeExternalIdType(typeRaw) {
  return String(typeRaw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

export function normalizeWosUid(val) {
  if (val == null || val === '') return null;
  let s = String(val).trim().toUpperCase().replace(/^WOS:/i, '').trim();
  return s || null;
}

export function normalizeScopusEid(val) {
  if (val == null || val === '') return null;
  const s = String(val).trim().toLowerCase();
  return s || null;
}

export function normalizePmid(val) {
  if (val == null || val === '') return null;
  const m = String(val).match(/\d+/);
  return m ? m[0] : null;
}

export function normalizePmcId(val) {
  if (val == null || val === '') return null;
  let s = String(val).trim().toUpperCase().replace(/^PMC/i, '');
  const m = s.match(/\d+/);
  return m ? `PMC${m[0]}` : null;
}

function normalizeTitleForDedup(title) {
  if (title == null || typeof title !== 'string') return '';
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

function workHasAnyExternalId(work) {
  return !!(
    (work.doi && String(work.doi).trim())
    || work.wos_id
    || work.scopus_id
    || work.pmid
    || work.pmc_id
  );
}

/**
 * Quét external-ids trong một work-group ORCID v3.0.
 * Ánh xạ: wosuid → wos_id, eid → scopus_id, pmid, pmc (và biến thể tên type).
 */
export function extractOrcidIdentifiers(workGroup) {
  const out = { doi: null, wos_id: null, scopus_id: null, pmid: null, pmc_id: null };
  const externalIds = workGroup['external-ids']?.['external-id'] || [];
  if (!Array.isArray(externalIds)) return out;

  for (const ext of externalIds) {
    const type = normalizeExternalIdType(ext['external-id-type']);
    const valRaw = ext['external-id-value'];
    if (valRaw == null) continue;
    const val = String(valRaw).trim();
    if (!val) continue;

    if (type === 'doi') {
      const d = normalizeDOI(val);
      if (d) out.doi = d;
    } else if (type === 'wosuid' || type === 'wos') {
      const w = normalizeWosUid(val);
      if (w) out.wos_id = w;
    } else if (type === 'eid' || type === 'scopuseid' || type === 'scopusid') {
      const e = normalizeScopusEid(val);
      if (e) out.scopus_id = e;
    } else if (type === 'pmid' || type === 'pubmed') {
      const p = normalizePmid(val);
      if (p) out.pmid = p;
    } else if (
      type === 'pmc'
      || type === 'pmcid'
      || type === 'pmcidversion'
      || type === 'pubmedcentral'
      || type === 'pubmedcentralid'
    ) {
      const c = normalizePmcId(val);
      if (c) out.pmc_id = c;
    }
  }
  return out;
}

/**
 * Dedup thác nước so với danh sách bản ghi (publications hoặc queue đã chuẩn hóa).
 * Mỗi phần tử existing: { doi, wos_id, scopus_eid, pmid, pmc_id, title, pub_year, orcid_put_code, _source? }
 */
export function checkDuplicatePublication(newWork, existingWorksInDB) {
  const doiNorm = newWork.doi ? String(newWork.doi).trim().toLowerCase() : null;

  if (doiNorm) {
    for (const ex of existingWorksInDB) {
      const ed = ex.doi ? String(ex.doi).trim().toLowerCase() : null;
      if (ed && ed === doiNorm) {
        return {
          isDuplicate: true,
          reason: 'doi',
          detail: newWork.doi,
          source: ex._source || 'publications',
        };
      }
    }
  }

  const pc = newWork.putCode != null && String(newWork.putCode).trim() !== ''
    ? String(newWork.putCode)
    : '';
  if (pc) {
    for (const ex of existingWorksInDB) {
      const ep = ex.orcid_put_code != null ? String(ex.orcid_put_code) : '';
      if (ep && ep === pc) {
        return {
          isDuplicate: true,
          reason: 'orcid_put_code',
          detail: pc,
          source: ex._source || 'publications',
        };
      }
    }
  }

  const wos = newWork.wos_id ? normalizeWosUid(newWork.wos_id) : null;
  const sid = newWork.scopus_id ? normalizeScopusEid(newWork.scopus_id) : null;
  const pmid = newWork.pmid ? normalizePmid(newWork.pmid) : null;
  const pmc = newWork.pmc_id ? normalizePmcId(newWork.pmc_id) : null;

  if (wos || sid || pmid || pmc) {
    for (const ex of existingWorksInDB) {
      if (wos && ex.wos_id) {
        const ew = normalizeWosUid(ex.wos_id);
        if (ew && ew === wos) {
          return { isDuplicate: true, reason: 'wos_id', detail: wos, source: ex._source || 'publications' };
        }
      }
      if (sid && ex.scopus_eid) {
        const es = normalizeScopusEid(ex.scopus_eid);
        if (es && es === sid) {
          return { isDuplicate: true, reason: 'scopus_id', detail: sid, source: ex._source || 'publications' };
        }
      }
      if (pmid && ex.pmid) {
        const ep = normalizePmid(ex.pmid);
        if (ep && ep === pmid) {
          return { isDuplicate: true, reason: 'pmid', detail: pmid, source: ex._source || 'publications' };
        }
      }
      if (pmc && ex.pmc_id) {
        const ec = normalizePmcId(ex.pmc_id);
        if (ec && ec === pmc) {
          return { isDuplicate: true, reason: 'pmc_id', detail: pmc, source: ex._source || 'publications' };
        }
      }
    }
  }

  if (!workHasAnyExternalId(newWork)) {
    const tn = normalizeTitleForDedup(newWork.title);
    const yr = newWork.pubYear != null ? Number(newWork.pubYear) : null;
    if (tn && yr != null && !Number.isNaN(yr)) {
      for (const ex of existingWorksInDB) {
        const exTitle = normalizeTitleForDedup(ex.title);
        const exYr = ex.pub_year != null ? Number(ex.pub_year) : null;
        if (exTitle && exTitle === tn && exYr != null && !Number.isNaN(exYr) && exYr === yr) {
          return {
            isDuplicate: true,
            reason: 'title_year',
            detail: `${yr}`,
            source: ex._source || 'publications',
          };
        }
      }
    }
  }

  return { isDuplicate: false };
}

function duplicateSkipMessage(dup, workTitle) {
  const where = dup.source === 'queue' ? 'hàng chờ (pending)' : 'CSDL publications';
  const labels = {
    doi: 'DOI',
    orcid_put_code: 'put-code ORCID',
    wos_id: 'wos_id',
    scopus_id: 'scopus_id',
    pmid: 'pmid',
    pmc_id: 'pmc_id',
    title_year: 'tiêu đề + năm',
  };
  const lab = labels[dup.reason] || dup.reason;
  const tail = dup.detail ? ` (${dup.detail})` : '';
  return `Bỏ qua "${workTitle}" vì trùng ${lab}${tail} — ${where}`;
}

/** In danh sách bài bị loại ra terminal (server) */
function printSkippedRecordsTable(researcherName, skipped_records) {
  if (!skipped_records || !skipped_records.length) return;
  console.log(`\n--- DANH SÁCH ${skipped_records.length} BÀI BÁO BỊ LOẠI [${researcherName}] ---`);
  skipped_records.forEach((rec, idx) => {
    const raw = (rec.title || 'Unknown Title').replace(/\s+/g, ' ').trim() || 'Unknown Title';
    const short = raw.length > 140 ? `${raw.slice(0, 137)}...` : raw;
    console.log(`${idx + 1}. [${rec.reason}] - ${short}`);
  });
  console.log('------------------------------------\n');
}

// ── Entry point: chạy 1 phiên harvest đầy đủ ─────────────────────────────────
// `signal`: AbortSignal — khi client đóng SSE, server dừng giữa các NCV / giữa các DOI
// Optional: researcherIds, orcidIds, fullNames — chỉ quét NCV khớp một trong các điều kiện (OR).
export async function runHarvestSession({
  onProgress,
  signal,
  researcherIds,
  orcidIds,
  fullNames,
} = {}) {
  const sessionId = randomUUID();
  const db = await getDB();

  const filterRequested =
    (Array.isArray(researcherIds) && researcherIds.length > 0) ||
    (Array.isArray(orcidIds) && orcidIds.length > 0) ||
    (Array.isArray(fullNames) && fullNames.length > 0);

  // Lấy danh sách NCV đang active
  const allActive = await queryAll(db,
    `SELECT * FROM researcher_orcids WHERE is_active = 1 ORDER BY full_name`
  );

  const researchers = applyHarvestResearcherFilters(allActive, {
    researcherIds,
    orcidIds,
    fullNames,
  });

  if (!researchers.length) {
    const message = !allActive.length
      ? 'Không có NCV nào đang active'
      : filterRequested
        ? 'Không có NCV nào khớp bộ lọc (kiểm tra full_name/ORCID/id trong bảng researcher_orcids).'
        : 'Không có NCV nào đang active';
    if (!allActive.length) {
      console.log('[ORCID] Không có NCV nào đang bật quét (is_active=1).');
    } else if (filterRequested) {
      const hint = allActive.map((r) => `${r.full_name} (id=${r.id})`).join('; ');
      console.log(`[ORCID] NCV đang active: ${hint}`);
    }

    const emptyG = groupNewWorksForResponse([]);
    onProgress?.({
      type: 'session_complete',
      sessionId,
      totalNew: 0,
      researchersChecked: 0,
      message,
      newWorksGrouped: emptyG.newWorksGrouped,
      stats: emptyG.stats,
    });
    return {
      sessionId,
      message,
      results: [],
      aborted: false,
      totalNew: 0,
      allNewItems: [],
      data: { newWorksGrouped: emptyG.newWorksGrouped, stats: emptyG.stats },
    };
  }

  const sessionResults = [];
  const sessionNewItems = [];
  let totalNew = 0;

  console.log(
    `\n[ORCID] ══ Bắt đầu phiên harvest (${sessionId}) — ${researchers.length} NCV — mỗi NCV: gọi API ORCID → so khớp CSDL/hàng chờ ══\n`
  );

  try {
    for (let i = 0; i < researchers.length; i++) {
      throwIfAborted(signal);
      const researcher = researchers[i];

      console.log(
        `[ORCID] [${i + 1}/${researchers.length}] ${researcher.full_name} (${researcher.orcid_id}) — đang gọi ORCID Public API…`
      );

      onProgress?.({
        type:       'researcher_start',
        index:      i,
        total:      researchers.length,
        name:       researcher.full_name,
        orcid:      researcher.orcid_id,
      });

      const result = await harvestOneResearcher(db, researcher, sessionId, onProgress, signal);
      sessionResults.push(result);
      totalNew += result.newFound;
      if (result.newItems?.length) sessionNewItems.push(...result.newItems);

      await queryRun(db,
        `UPDATE researcher_orcids 
         SET last_harvested_at = ?, last_work_count = ?, updated_at = ?
         WHERE id = ?`,
        [new Date().toISOString(), result.worksFound, new Date().toISOString(), researcher.id]
      );

      const rg = groupNewWorksForResponse(result.newItems || []);
      onProgress?.({
        type:       'researcher_done',
        index:      i,
        total:      researchers.length,
        name:       researcher.full_name,
        orcid:      researcher.orcid_id,
        worksFound: result.worksFound,
        newFound:   result.newFound,
        skipped:    result.skipped,
        error:      result.error || null,
        newItems:   result.newItems,
        skippedRecords: result.skipped_records || [],
        newWorksGrouped: rg.newWorksGrouped,
        stats: rg.stats,
      });

      if (i < researchers.length - 1) await sleep(RATE_DELAY);
    }

    const sg = groupNewWorksForResponse(sessionNewItems);
    onProgress?.({
      type: 'session_complete',
      sessionId,
      totalNew,
      researchersChecked: researchers.length,
      newWorksGrouped: sg.newWorksGrouped,
      stats: sg.stats,
    });

    console.log(
      `[ORCID] ══ Kết thúc phiên ${sessionId}: ${researchers.length} NCV, ${totalNew} bài mới vào hàng chờ (còn lại là trùng → bỏ qua, không gọi enrich DOI) ═=\n`
    );

    return {
      sessionId,
      researchersChecked: researchers.length,
      totalNew,
      results: sessionResults,
      aborted: false,
      allNewItems: sessionNewItems,
      data: { newWorksGrouped: sg.newWorksGrouped, stats: sg.stats },
    };
  } catch (e) {
    if (e.name === 'AbortError' || signal?.aborted) {
      const ag = groupNewWorksForResponse(sessionNewItems);
      onProgress?.({
        type: 'session_aborted',
        sessionId,
        totalNew,
        researchersChecked: sessionResults.length,
        message: e.message || 'Đã dừng quét',
        newWorksGrouped: ag.newWorksGrouped,
        stats: ag.stats,
      });
      return {
        sessionId,
        researchersChecked: sessionResults.length,
        totalNew,
        results: sessionResults,
        aborted: true,
        allNewItems: sessionNewItems,
        data: { newWorksGrouped: ag.newWorksGrouped, stats: ag.stats },
      };
    }
    throw e;
  }
}

// ── Harvest 1 NCV ─────────────────────────────────────────────────────────────
async function harvestOneResearcher(db, researcher, sessionId, onProgress, signal) {
  const logBase = {
    session_id:    sessionId,
    researcher_id: researcher.id,
    orcid_id:      researcher.orcid_id,
  };

  let worksFound = 0, newFound = 0, skipped = 0;
  let newItems = [];
  let errorMsg = null;
  const skipped_records = [];

  try {
    // 1. Gọi ORCID API lấy danh sách works (+ bài lỗi parse nhóm)
    const { works, parseSkipped } = await fetchOrcidWorks(researcher.orcid_id);
    for (const row of parseSkipped) skipped_records.push(row);

    worksFound = works.length;

    const withDoi = works.filter(w => w.doi).length;
    console.log(
      `[ORCID] [${researcher.full_name}] Đã nhận ${worksFound} work từ ORCID (có DOI: ${withDoi}) — so khớp với publications + hàng chờ pending…`
    );

    onProgress?.({
      type: 'log',
      level: 'info',
      message: `[${researcher.full_name}] ORCID works: ${worksFound}, có DOI: ${withDoi}, có ID khác (WOS/Scopus/PMC/PMID): ${works.filter(w => w.wos_id || w.scopus_id || w.pmc_id || w.pmid).length}`,
      researcher: researcher.full_name,
      orcid: researcher.orcid_id,
    });

    const pubRows = await getPublicationDedupRows(db);
    const queueRows = await getPendingQueueDedupRows(db);
    const existingAll = [
      ...pubRows.map((r) => ({ ...r, _source: 'publications' })),
      ...queueRows.map((r) => ({ ...r, _source: 'queue' })),
    ];

    for (const work of works) {
      throwIfAborted(signal);

      const dup = checkDuplicatePublication(work, existingAll);
      if (dup.isDuplicate) {
        skipped++;
        const titleDisp = orcidWorkDisplayTitle(work);
        const reasonText = duplicateSkipMessage(dup, titleDisp.replace(/"/g, "'"));
        skipped_records.push({ title: titleDisp, reason: reasonText });
        onProgress?.({
          type: 'log',
          level: 'debug',
          message: `[${researcher.full_name}] ${reasonText}`,
          doi: work.doi || null,
        });
        continue;
      }

      let enriched = null;
      let enrichmentSource = '';
      let enrichmentGroup = 'ORCID_Raw';

      if (work.doi) {
        try {
          enriched = await fetchAndEnrichDOI(work.doi, { orcid_raw_data: work });
          await sleep(200);
        } catch (e) {
          console.warn(`[ORCID] Enrich thất bại hoàn toàn (${work.doi}): ${e.message}`);
        }
        enrichmentSource = enriched?.data_source
          ? String(enriched.data_source)
          : 'DOI metadata resolver';
        enrichmentGroup = 'DOI_Crossref';
        if (enriched && typeof enriched === 'object') {
          enriched.enrichmentSource = enrichmentSource;
          enriched.enrichmentGroup = enrichmentGroup;
        }
      } else {
        const noDoi = await enrichOrcidWorkWithoutDoi(work);
        enriched = noDoi.enriched;
        enrichmentSource = noDoi.enrichmentSource || 'ORCID Raw (No API)';
        enrichmentGroup = noDoi.enrichmentGroup || 'ORCID_Raw';
        await sleep(200);
      }

      if (enriched && typeof enriched === 'object') {
        enriched.wos_id = enriched.wos_id ?? work.wos_id ?? null;
        enriched.scopus_eid = enriched.scopus_eid ?? enriched.scopus_id ?? work.scopus_id ?? null;
        enriched.pmc_id = enriched.pmc_id ?? work.pmc_id ?? null;
        enriched.pmid = enriched.pmid ?? work.pmid ?? null;
        if (!enriched.enrichmentSource) enriched.enrichmentSource = enrichmentSource;
        if (!enriched.enrichmentGroup) enriched.enrichmentGroup = enrichmentGroup;
      }

      const queueItemId = await addToQueue(db, {
        doi:             work.doi || null,
        raw_data:        JSON.stringify(work),
        enriched_data:   enriched ? JSON.stringify(enriched) : null,
        detected_from:   researcher.orcid_id,
        researcher_name: researcher.full_name,
        harvest_session: sessionId,
      });

      newFound++;
      const dispTitle = enriched?.title || work.title || work.doi || orcidWorkDisplayTitle(work);
      newItems.push({
        queueId:         queueItemId,
        doi:            work.doi || null,
        title:          dispTitle,
        journal:        enriched?.journal_name || work.journalTitle || null,
        year:           enriched?.pub_year ?? work.pubYear ?? null,
        authors:        enriched?.authors || null,
        quartile:       enriched?._needsReview?.quartile || null,
        impact_factor:  enriched?._needsReview?.impact_factor || null,
        is_open_access: enriched?.is_open_access || 0,
        oa_type:        enriched?.oa_type || null,
        researcher:     researcher.full_name,
        orcid:          researcher.orcid_id,
        enrichmentSource: enrichmentSource || enriched?.enrichmentSource || '',
        enrichmentGroup: enrichmentGroup || enriched?.enrichmentGroup || 'ORCID_Raw',
      });
      onProgress?.({
        type: 'log',
        level: 'info',
        message: work.doi
          ? `[${researcher.full_name}] Bài mới (DOI): ${work.doi}`
          : `[${researcher.full_name}] Bài mới (không DOI): ${dispTitle}`,
        doi: work.doi || null,
        queueId: queueItemId,
      });
    }
  } catch (err) {
    errorMsg = err.message;
    console.error(`[ORCID] Lỗi khi harvest ${researcher.orcid_id}:`, err.message);
  }

  if (!errorMsg) {
    console.log(
      `[ORCID] [${researcher.full_name}] === Hoàn thành. Tổng mới: ${newFound} ` +
      `(works=${worksFound}, trùng CSDL/hàng chờ=${skipped}) ===`
    );
  } else {
    console.log(
      `[ORCID] [${researcher.full_name}] === Kết thúc có lỗi (${errorMsg}). ` +
      `Tổng mới (đến lúc lỗi): ${newFound} ===`
    );
  }
  printSkippedRecordsTable(researcher.full_name, skipped_records);

  // Ghi log
  await queryRun(db,
    `INSERT INTO orcid_harvest_logs 
     (session_id, researcher_id, orcid_id, works_found, new_found, skipped_dup, error_msg)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, researcher.id, researcher.orcid_id, worksFound, newFound, skipped, errorMsg]
  );

  return { worksFound, newFound, skipped, newItems, error: errorMsg, skipped_records };
}

// ── ORCID Public API v3.0 ─────────────────────────────────────────────────────
async function fetchOrcidWorks(orcidId) {
  const url = `${ORCID_API}/${orcidId}/works`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'SCI-KHCN/1.0 (khcn@sci.edu.vn)',
    },
  }, 15000);

  if (res.status === 404) {
    throw new Error(`ORCID ${orcidId} không tồn tại`);
  }
  if (!res.ok) {
    throw new Error(`ORCID API HTTP ${res.status}`);
  }

  const json = await res.json();
  const parseSkipped = [];
  const works = parseOrcidWorks(json, orcidId, parseSkipped);
  return { works, parseSkipped };
}

/** Tên tác giả từ contributor-group (work-summary ORCID), nếu có. */
function extractOrcidContributorSummary(preferred) {
  const groups = preferred['contributor-group'];
  if (!groups) return '';
  const list = Array.isArray(groups) ? groups : [groups];
  const names = [];
  for (const g of list) {
    const contribs = g?.contributor;
    const arr = Array.isArray(contribs) ? contribs : contribs ? [contribs] : [];
    for (const c of arr) {
      const v = c?.['credit-name']?.value;
      if (v && String(v).trim()) names.push(String(v).trim());
    }
  }
  return names.join(', ');
}

function parseOrcidWorks(json, orcidId, skipAccumulator = null) {
  const groups = json.group || [];
  const works = [];

  for (const group of groups) {
    // Mỗi group có thể có nhiều work-summary (versions)
    // Lấy work-summary đầu tiên (preferred source)
    const summaries = group['work-summary'] || [];
    const preferred = summaries.find(s => s.source?.['source-orcid']?.path === orcidId)
      || summaries[0];
    if (!preferred) {
      if (skipAccumulator) {
        skipAccumulator.push({
          title: 'Unknown Title',
          reason: 'Không có work-summary hợp lệ (nhóm ORCID không chọn được bản ghi)',
        });
      }
      continue;
    }

    const ids = extractOrcidIdentifiers(group);

    const title = preferred.title?.title?.value || null;
    const journalTitle = preferred['journal-title']?.value || null;
    const pubYear = preferred['publication-date']?.year?.value
      ? parseInt(preferred['publication-date'].year.value, 10)
      : null;
    const workType = preferred.type || null;
    const putCode = String(preferred['put-code'] || '');
    const doi = ids.doi;
    const url = preferred.url?.value || (doi ? `https://doi.org/${doi}` : null);
    const contributorsSummary = extractOrcidContributorSummary(preferred);

    works.push({
      doi: ids.doi,
      wos_id: ids.wos_id,
      scopus_id: ids.scopus_id,
      pmid: ids.pmid,
      pmc_id: ids.pmc_id,
      title,
      journalTitle,
      pubYear,
      workType,
      putCode,
      url,
      orcidId,
      contributorsSummary,
    });
  }

  return works;
}

// ── Helpers DB (dedup) ───────────────────────────────────────────────────────
async function getPublicationDedupRows(db) {
  return queryAll(db, `
    SELECT doi, wos_id, scopus_eid, pmid, pmc_id, title, pub_year, orcid_put_code
    FROM publications
  `);
}

/** Hàng chờ pending — parse raw_data (JSON work) để lấy ID giống luồng harvest */
async function getPendingQueueDedupRows(db) {
  const rows = await queryAll(db,
    `SELECT id, doi, raw_data FROM publication_queue WHERE status = 'pending'`
  );
  const out = [];
  for (const row of rows) {
    let w = {};
    if (row.raw_data) {
      try { w = JSON.parse(row.raw_data); } catch (_) { w = {}; }
    }
    out.push({
      doi: row.doi || w.doi || null,
      wos_id: w.wos_id || null,
      scopus_eid: w.scopus_id || w.scopus_eid || null,
      pmid: w.pmid || null,
      pmc_id: w.pmc_id || null,
      title: w.title || null,
      pub_year: w.pubYear != null ? Number(w.pubYear) : null,
      orcid_put_code: w.putCode != null ? String(w.putCode) : null,
    });
  }
  return out;
}

async function addToQueue(db, item) {
  const r = await queryRun(db,
    `INSERT INTO publication_queue 
     (doi, raw_data, enriched_data, detected_from, researcher_name, harvest_session)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [item.doi, item.raw_data, item.enriched_data,
     item.detected_from, item.researcher_name, item.harvest_session]
  );
  return Number(r?.lastInsertRowid || r?.lastInsertId || 0);
}

// ── Approve/Reject từ queue ───────────────────────────────────────────────────
export async function approveQueueItem(queueId, adminId, overrides = {}) {
  const db = await getDB();

  // Lấy item từ queue
  const [item] = await queryAll(db,
    `SELECT * FROM publication_queue WHERE id = ? AND status = 'pending'`,
    [queueId]
  );
  if (!item) throw new Error('Item không tìm thấy hoặc đã xử lý');

  let raw = {};
  try {
    raw = item.raw_data ? JSON.parse(item.raw_data) : {};
  } catch (_) {
    raw = {};
  }
  const enriched = item.enriched_data ? JSON.parse(item.enriched_data) : {};
  const merged = {
    ...enriched,
    doi: enriched.doi ?? raw.doi ?? null,
    pmid: enriched.pmid ?? raw.pmid ?? null,
    pmc_id: enriched.pmc_id ?? raw.pmc_id ?? null,
    wos_id: enriched.wos_id ?? raw.wos_id ?? null,
    scopus_eid: enriched.scopus_eid ?? enriched.scopus_id ?? raw.scopus_id ?? raw.scopus_eid ?? null,
    orcid_put_code: enriched.orcid_put_code ?? raw.putCode ?? null,
    ...overrides,
  };
  if (merged.title == null || String(merged.title).trim() === '') {
    merged.title = merged.doi || 'Unknown Title';
  }

  await queryRun(db, `
    INSERT INTO publications (
      doi, pmid, pmc_id, wos_id, scopus_eid, title, abstract, keywords,
      authors, authors_json, sci_authors,
      pub_type, journal_name, issn, volume, pages, pub_year, pub_date,
      index_db, quartile, impact_factor, cite_score, sjr,
      is_open_access, oa_type,
      citation_count, citation_updated_at,
      project_code, funder, grant_no,
      status, source, import_source, orcid_put_code, url,
      created_by, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?, ?,
      'published', ?, ?, ?, ?,
      ?, datetime('now'), datetime('now')
    )`,
    [
      merged.doi, merged.pmid, merged.pmc_id, merged.wos_id, merged.scopus_eid,
      merged.title, merged.abstract, merged.keywords,
      merged.authors, merged.authors_json, merged.sci_authors,
      merged.pub_type, merged.journal_name, merged.issn, merged.volume,
      merged.pages, merged.pub_year, merged.pub_date,
      merged.index_db, merged.quartile, merged.impact_factor,
      merged.cite_score, merged.sjr,
      merged.is_open_access, merged.oa_type,
      merged.citation_count, new Date().toISOString(),
      merged.project_code, merged.funder, merged.grant_no,
      merged.source || 'orcid_harvest',
      'orcid',
      merged.orcid_put_code, merged.url,
      adminId,
    ]
  );

  // Cập nhật status queue
  await queryRun(db,
    `UPDATE publication_queue SET status='approved', reviewed_by=?, reviewed_at=? WHERE id=?`,
    [adminId, new Date().toISOString(), queueId]
  );

  return { success: true, message: `Đã import công bố: ${merged.title}` };
}

export async function rejectQueueItem(queueId, adminId) {
  const db = await getDB();
  await queryRun(db,
    `UPDATE publication_queue SET status='rejected', reviewed_by=?, reviewed_at=? WHERE id=?`,
    [adminId, new Date().toISOString(), queueId]
  );
  return { success: true };
}

// ── CRUD researcher_orcids ────────────────────────────────────────────────────
export async function getResearchers() {
  const db = await getDB();
  return queryAll(db, `SELECT * FROM researcher_orcids ORDER BY full_name`);
}

export async function upsertResearcher(data) {
  const db = await getDB();
  await queryRun(db, `
    INSERT INTO researcher_orcids (full_name, orcid_id, department, position, is_active)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(orcid_id) DO UPDATE SET
      full_name   = excluded.full_name,
      department  = excluded.department,
      position    = excluded.position,
      is_active   = excluded.is_active,
      updated_at  = datetime('now')`,
    [data.full_name, data.orcid_id, data.department || null,
     data.position || null, data.is_active ?? 1]
  );
}

export async function deleteResearcher(id) {
  const db = await getDB();
  await queryRun(db, `DELETE FROM researcher_orcids WHERE id = ?`, [id]);
}

// ── DB query helpers (SQLite sync / Neon async) ───────────────────────────────
async function queryAll(db, sql, params = []) {
  if (db.__isSQLite) {
    return db.prepare(sql).all(...params);
  }
  // Neon: không dùng tagged template với params động → dùng sql() helper
  const result = await db(sql, params);
  return result.rows || result;
}

async function queryRun(db, sql, params = []) {
  if (db.__isSQLite) {
    return db.prepare(sql).run(...params);
  }
  return db(sql, params);
}

// ── Utility ───────────────────────────────────────────────────────────────────
function normalizeDOI(input) {
  if (!input) return null;
  let doi = input.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return /^10\.\d{4,}\//.test(doi) ? doi : null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
