/**
 * services/periodReportService.js
 * Nghiệp vụ lọc và tổng hợp số liệu Đề tài KHCN (missions) & Bài báo khoa học (publications)
 * theo giai đoạn chính xác từng tháng (MM/YYYY → MM/YYYY).
 *
 * Thuần nghiệp vụ — không phụ thuộc req/res.
 */

const { LEVEL_ORDER, LEVEL_LABEL, STATUS_LABEL } = require('./missionReportBuilder');

const DONE_STATUSES = new Set(['completed', 'hoan_thanh', 'thanh_ly_hop_dong']);
const RUNNING_STATUSES = new Set(['ongoing', 'dang_thuc_hien', 'xin_dieu_chinh']);

const PUB_TYPE_LABEL = {
  journal: 'Bài báo tạp chí',
  conference: 'Hội nghị / Hội thảo',
  book_chapter: 'Chương sách',
  book: 'Sách chuyên khảo',
  patent: 'Sáng chế / GPHI',
  preprint: 'Preprint',
  other: 'Khác',
};

function maybeAwait(v) {
  return v && typeof v.then === 'function' ? v : Promise.resolve(v);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toMonthKey(year, month) {
  return year * 12 + month;
}

/**
 * Chuẩn hóa đầu vào tháng từ người dùng / query:
 * - '01/2021', '1/2021'
 * - '2021-01', '2021-01-15'
 * - '2021' (nếu boundary === 'end' → 2021-12, ngược lại → 2021-01)
 * @returns {{ ym: string, year: number, month: number, key: number } | null}
 */
function parseMonthInput(raw, boundary = 'start') {
  const s = String(raw || '').trim();
  if (!s) return null;

  // YYYY-MM hoặc YYYY-MM-DD hoặc YYYY/MM
  let m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) {
      return { ym: `${year}-${pad2(month)}`, year, month, key: toMonthKey(year, month) };
    }
    return null;
  }

  // MM/YYYY hoặc MM-YYYY
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    const year = Number(m[2]);
    if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) {
      return { ym: `${year}-${pad2(month)}`, year, month, key: toMonthKey(year, month) };
    }
    return null;
  }

  // Chỉ có năm YYYY
  m = s.match(/^(\d{4})$/);
  if (m) {
    const year = Number(m[1]);
    if (year >= 1900 && year <= 2200) {
      const month = boundary === 'end' ? 12 : 1;
      return { ym: `${year}-${pad2(month)}`, year, month, key: toMonthKey(year, month) };
    }
  }

  return null;
}

/**
 * Tách năm/tháng từ chuỗi ngày lưu trong DB (hỗ trợ nhiều định dạng).
 * @returns {{ year: number, month: number|null, hasMonth: boolean, ym: string|null } | null}
 */
function extractYearMonth(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  // ISO: YYYY-MM-DD hoặc YYYY-MM hoặc YYYY/MM/DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) {
      return { year, month, hasMonth: true, ym: `${year}-${pad2(month)}` };
    }
  }

  // VN: DD/MM/YYYY hoặc DD-MM-YYYY
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) {
      return { year, month, hasMonth: true, ym: `${year}-${pad2(month)}` };
    }
  }

  // MM/YYYY hoặc MM-YYYY
  m = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (m) {
    const month = Number(m[1]);
    const year = Number(m[2]);
    if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) {
      return { year, month, hasMonth: true, ym: `${year}-${pad2(month)}` };
    }
  }

  // Chỉ có năm YYYY
  m = s.match(/^(\d{4})/);
  if (m) {
    const year = Number(m[1]);
    if (year >= 1900 && year <= 2200) {
      return { year, month: null, hasMonth: false, ym: null };
    }
  }

  return null;
}

function formatMonthVi(ymOrObj) {
  if (!ymOrObj) return '';
  if (typeof ymOrObj === 'object' && ymOrObj.year && ymOrObj.month) {
    return `${pad2(ymOrObj.month)}/${ymOrObj.year}`;
  }
  const parsed = parseMonthInput(ymOrObj);
  return parsed ? `${pad2(parsed.month)}/${parsed.year}` : String(ymOrObj);
}

function normalizeRange(fromRaw, toRaw) {
  let from = parseMonthInput(fromRaw, 'start');
  let to = parseMonthInput(toRaw, 'end');
  if (from && to && from.key > to.key) {
    const tmp = from;
    from = to;
    to = tmp;
  }
  let label = 'Toàn bộ thời gian';
  if (from && to) {
    label = from.ym === to.ym ? `Tháng ${formatMonthVi(from)}` : `${formatMonthVi(from)} – ${formatMonthVi(to)}`;
  } else if (from) {
    label = `Từ ${formatMonthVi(from)} đến nay`;
  } else if (to) {
    label = `Đến ${formatMonthVi(to)}`;
  }
  return { from, to, label };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function levelRank(v) {
  const i = LEVEL_ORDER.indexOf(v);
  return i === -1 ? LEVEL_ORDER.length : i;
}

function levelLabel(v) {
  return LEVEL_LABEL[v] || v || '(Không rõ)';
}

function statusLabel(v) {
  return STATUS_LABEL[v] || v || '(Không rõ)';
}

function pubTypeLabel(v) {
  const k = String(v || '').trim().toLowerCase();
  return PUB_TYPE_LABEL[k] || (v ? String(v) : 'Khác');
}

/**
 * Suy luận năm từ mã đề tài khi bản ghi thiếu cả start_date lẫn end_date.
 * Ví dụ:
 * - 'NCKH-SCI.11/25' → 2025
 * - 'NVTC.002/26' → 2026
 * - 'DT-UN-2026-8566', 'CB2025-18-26', 'FIRST-SCI/2018/09' → 2026, 2025, 2018
 * - 'VAST.ĐLT.11/15-16' → 2015
 */
function inferYearFromMissionCode(code) {
  const s = String(code || '').trim();
  if (!s) return null;

  // 1. Năm 4 chữ số (1990–2099)
  const m4 = s.match(/(?:^|[^\d])((?:199\d|20\d{2}))(?:[^\d]|$)/);
  if (m4) {
    const y = Number(m4[1]);
    if (y >= 1990 && y <= 2099) return y;
  }

  // 2. Đuôi /YY hoặc /YY-YY (VD: NCKH-SCI.11/25, NVTC.002/26, VAST.ĐLT.11/15-16)
  const m2 = s.match(/\/(\d{2})(?:-\d{2})?$/);
  if (m2) {
    const yy = Number(m2[1]);
    return yy >= 80 ? 1900 + yy : 2000 + yy;
  }

  return null;
}

/**
 * Lọc danh sách nhiệm vụ KHCN theo giai đoạn tháng + cấp + trạng thái.
 * Mặc định dateMode = 'overlap': lấy mọi đề tài có thời gian thực hiện giao với giai đoạn.
 */
function filterMissionsByPeriod(allRows, opts = {}) {
  const { from, to } = normalizeRange(opts.fromMonth, opts.toMonth);
  const dateMode = ['overlap', 'start', 'end'].includes(opts.dateMode) ? opts.dateMode : 'overlap';
  const levels = Array.isArray(opts.levels) ? opts.levels.filter(Boolean) : [];
  const statuses = Array.isArray(opts.statuses) ? opts.statuses.filter(Boolean) : [];
  const includeMissingDate = Boolean(opts.includeMissingDate);
  const levelSet = levels.length ? new Set(levels) : null;
  const statusSet = statuses.length ? new Set(statuses) : null;

  const hasDateFilter = Boolean(from || to);
  const fromKey = from ? from.key : null;
  const toKey = to ? to.key : null;

  const matched = [];
  let missingDateCount = 0;
  let missingDateIncludedCount = 0;
  let inferredFromCodeCount = 0;

  for (const r of allRows || []) {
    if (levelSet && !levelSet.has(r.level)) continue;
    if (statusSet && !statusSet.has(r.status)) continue;

    const s = extractYearMonth(r.start_date);
    const e = extractYearMonth(r.end_date);
    const startKey = s ? toMonthKey(s.year, s.hasMonth ? s.month : 1) : null;
    const endKey = e ? toMonthKey(e.year, e.hasMonth ? e.month : 12) : null;

    let periodRole = 'Toàn giai đoạn';

    if (hasDateFilter) {
      if (startKey == null && endKey == null) {
        const inferredYear = inferYearFromMissionCode(r.code);
        if (inferredYear != null) {
          const effStart = toMonthKey(inferredYear, 1);
          const effEnd = toMonthKey(inferredYear, 12);
          if (toKey != null && effStart > toKey) continue;
          if (fromKey != null && effEnd < fromKey) continue;
          periodRole = `Suy luận từ mã (năm ${inferredYear})`;
          inferredFromCodeCount += 1;
        } else if (includeMissingDate) {
          periodRole = 'Chưa có ngày thực hiện';
          missingDateIncludedCount += 1;
        } else {
          missingDateCount += 1;
          continue;
        }
      } else if (dateMode === 'start') {
        if (startKey == null) {
          if (includeMissingDate) {
            periodRole = 'Chưa có ngày bắt đầu';
            missingDateIncludedCount += 1;
          } else {
            missingDateCount += 1;
            continue;
          }
        } else {
          if (fromKey != null && startKey < fromKey) continue;
          if (toKey != null && startKey > toKey) continue;
        }
      } else if (dateMode === 'end') {
        if (endKey == null) {
          if (includeMissingDate) {
            periodRole = 'Chưa có ngày kết thúc';
            missingDateIncludedCount += 1;
          } else {
            missingDateCount += 1;
            continue;
          }
        } else {
          if (fromKey != null && endKey < fromKey) continue;
          if (toKey != null && endKey > toKey) continue;
        }
      } else {
        // overlap (mặc định): giao với [fromKey, toKey]
        const effStart = startKey != null ? startKey : endKey;
        const effEnd = endKey != null ? endKey : Infinity;
        if (toKey != null && effStart > toKey) continue;
        if (fromKey != null && effEnd < fromKey) continue;
      }

      if (periodRole === 'Toàn giai đoạn') {
        const startedIn =
          startKey != null &&
          (fromKey == null || startKey >= fromKey) &&
          (toKey == null || startKey <= toKey);
        const endedIn =
          endKey != null &&
          (fromKey == null || endKey >= fromKey) &&
          (toKey == null || endKey <= toKey);
        if (startedIn && endedIn) periodRole = 'Mở mới & kết thúc trong kỳ';
        else if (startedIn) periodRole = 'Mở mới trong kỳ';
        else if (endedIn) periodRole = 'Chuyển tiếp & kết thúc trong kỳ';
        else periodRole = 'Chuyển tiếp (đang triển khai)';
      }
    }

    matched.push({
      ...r,
      level_label: levelLabel(r.level),
      status_label: statusLabel(r.status),
      period_role: periodRole,
    });
  }

  matched.sort((a, b) => {
    const lr = levelRank(a.level) - levelRank(b.level);
    if (lr !== 0) return lr;
    const sd = String(a.start_date || '').localeCompare(String(b.start_date || ''));
    if (sd !== 0) return sd;
    return String(a.code || '').localeCompare(String(b.code || ''));
  });

  return { rows: matched, missingDateCount, missingDateIncludedCount, inferredFromCodeCount };
}

/**
 * Lọc bài báo khoa học theo giai đoạn chính xác từng tháng.
 * Xử lý an toàn cả bài có pub_date đầy đủ lẫn bài chỉ có pub_year.
 */
function filterPublicationsByPeriod(allRows, opts = {}) {
  const { from, to } = normalizeRange(opts.fromMonth, opts.toMonth);
  const includeYearOnly = opts.includeYearOnly !== false;
  const pubType = String(opts.pubType || '').trim().toLowerCase();
  const quartile = String(opts.quartile || '').trim().toUpperCase();
  const indexDb = String(opts.indexDb || '').trim().toLowerCase();

  const hasDateFilter = Boolean(from || to);
  const fromKey = from ? from.key : null;
  const toKey = to ? to.key : null;

  const matched = [];
  let yearOnlyIncludedCount = 0;
  let yearOnlyExcludedCount = 0;
  let missingDateCount = 0;

  for (const r of allRows || []) {
    if (pubType && String(r.pub_type || '').trim().toLowerCase() !== pubType) continue;
    if (quartile && String(r.quartile || '').trim().toUpperCase() !== quartile) continue;
    if (indexDb && !String(r.index_db || '').toLowerCase().includes(indexDb)) continue;

    const parsedDate = extractYearMonth(r.pub_date);
    const pubYearNum = r.pub_year != null && String(r.pub_year).trim() !== '' ? Number(r.pub_year) : null;
    const year = parsedDate ? parsedDate.year : (Number.isFinite(pubYearNum) ? pubYearNum : null);
    const month = parsedDate && parsedDate.hasMonth ? parsedDate.month : null;

    let datePrecision = month != null ? 'exact' : (year != null ? 'year_only' : 'missing');
    let dateNote = '';

    if (hasDateFilter) {
      if (year == null) {
        missingDateCount += 1;
        continue;
      }
      if (month != null) {
        const key = toMonthKey(year, month);
        if (fromKey != null && key < fromKey) continue;
        if (toKey != null && key > toKey) continue;
      } else {
        // Chỉ có năm (thiếu tháng)
        const janKey = toMonthKey(year, 1);
        const decKey = toMonthKey(year, 12);
        const overlapsYear = (toKey == null || janKey <= toKey) && (fromKey == null || decKey >= fromKey);
        if (!overlapsYear) continue;

        const fullyCovered = (fromKey == null || fromKey <= janKey) && (toKey == null || toKey >= decKey);
        if (fullyCovered) {
          datePrecision = 'year_covered';
          dateNote = 'Chỉ có năm (trọn năm trong kỳ)';
        } else if (includeYearOnly) {
          datePrecision = 'year_only_partial';
          dateNote = 'Chỉ có năm (chưa rõ tháng)';
          yearOnlyIncludedCount += 1;
        } else {
          yearOnlyExcludedCount += 1;
          continue;
        }
      }
    } else if (month == null && year != null) {
      dateNote = 'Chỉ có năm';
    }

    const displayMonth = month != null ? `${pad2(month)}/${year}` : (year != null ? String(year) : '—');
    matched.push({
      ...r,
      _year: year,
      _month: month,
      display_month: displayMonth,
      date_precision: datePrecision,
      date_note: dateNote,
      pub_type_label: pubTypeLabel(r.pub_type),
    });
  }

  matched.sort((a, b) => {
    const yd = (b._year || 0) - (a._year || 0);
    if (yd !== 0) return yd;
    const md = (b._month || 0) - (a._month || 0);
    if (md !== 0) return md;
    return (b.id || 0) - (a.id || 0);
  });

  return {
    rows: matched,
    yearOnlyIncludedCount,
    yearOnlyExcludedCount,
    missingDateCount,
  };
}

function summarizeMissions(rows) {
  const list = rows || [];
  const totalBudget = list.reduce((s, r) => s + num(r.budget), 0);
  const doneCount = list.filter((r) => DONE_STATUSES.has(r.status)).length;
  const runningCount = list.filter((r) => RUNNING_STATUSES.has(r.status)).length;

  const byLevel = [];
  const presentLevels = [
    ...LEVEL_ORDER.filter((lv) => list.some((r) => r.level === lv)),
    ...[...new Set(list.map((r) => r.level))].filter((lv) => !LEVEL_ORDER.includes(lv)),
  ];
  for (const lv of presentLevels) {
    const sub = list.filter((r) => r.level === lv);
    byLevel.push({
      level: lv,
      label: levelLabel(lv),
      count: sub.length,
      budget: sub.reduce((s, x) => s + num(x.budget), 0),
    });
  }

  const byRoleMap = new Map();
  for (const r of list) {
    const role = r.period_role || 'Toàn giai đoạn';
    byRoleMap.set(role, (byRoleMap.get(role) || 0) + 1);
  }
  const byRole = [...byRoleMap.entries()].map(([role, count]) => ({ role, count }));

  return {
    total: list.length,
    totalBudget,
    runningCount,
    doneCount,
    byLevel,
    byRole,
  };
}

function summarizePublications(rows) {
  const list = rows || [];
  let totalCitations = 0;
  const quartileCounts = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, other: 0 };
  const indexCounts = { scopus: 0, wos: 0, pubmed: 0, other: 0 };
  const byTypeMap = new Map();
  const byYearMap = new Map();

  for (const r of list) {
    totalCitations += num(r.citation_count);
    const q = String(r.quartile || '').trim().toUpperCase();
    if (q === 'Q1' || q === 'Q2' || q === 'Q3' || q === 'Q4') quartileCounts[q] += 1;
    else quartileCounts.other += 1;

    const idx = String(r.index_db || '').toLowerCase();
    let matchedIdx = false;
    if (idx.includes('scopus') || r.scopus_eid) { indexCounts.scopus += 1; matchedIdx = true; }
    if (idx.includes('wos') || idx.includes('web of science') || idx.includes('scie') || idx.includes('ssci') || r.wos_id) {
      indexCounts.wos += 1; matchedIdx = true;
    }
    if (idx.includes('pubmed') || r.pmid) { indexCounts.pubmed += 1; matchedIdx = true; }
    if (!matchedIdx) indexCounts.other += 1;

    const ptLabel = r.pub_type_label || pubTypeLabel(r.pub_type);
    byTypeMap.set(ptLabel, (byTypeMap.get(ptLabel) || 0) + 1);

    const yKey = r._year != null ? String(r._year) : 'Không rõ';
    byYearMap.set(yKey, (byYearMap.get(yKey) || 0) + 1);
  }

  return {
    total: list.length,
    totalCitations,
    quartileCounts,
    indexCounts,
    byType: [...byTypeMap.entries()].map(([label, count]) => ({ label, count })),
    byYear: [...byYearMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([year, count]) => ({ year, count })),
  };
}

/**
 * Truy vấn dữ liệu từ DB (hỗ trợ cả better-sqlite3 sync lẫn libsql/bridge async).
 */
async function queryPeriodReportData(db, opts = {}) {
  const scope = ['missions', 'publications', 'both'].includes(opts.scope) ? opts.scope : 'missions';
  const range = normalizeRange(opts.fromMonth, opts.toMonth);

  let missionsResult = { rows: [], missingDateCount: 0, missingDateIncludedCount: 0, inferredFromCodeCount: 0 };
  let publicationsResult = {
    rows: [],
    yearOnlyIncludedCount: 0,
    yearOnlyExcludedCount: 0,
    missingDateCount: 0,
  };

  if (scope === 'missions' || scope === 'both') {
    const rawMissions = await maybeAwait(
      db.prepare(
        'SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget, ' +
          'managing_agency, contract_number, funding_source, field, mission_type FROM missions'
      ).all()
    );
    missionsResult = filterMissionsByPeriod(rawMissions || [], opts);
  }

  if (scope === 'publications' || scope === 'both') {
    let rawPubs = [];
    try {
      rawPubs = (await maybeAwait(db.prepare('SELECT * FROM publications').all())) || [];
    } catch (_) {
      rawPubs = [];
    }
    publicationsResult = filterPublicationsByPeriod(rawPubs, opts);
  }

  return {
    scope,
    range: {
      fromMonth: range.from ? range.from.ym : null,
      toMonth: range.to ? range.to.ym : null,
      fromLabel: range.from ? formatMonthVi(range.from) : null,
      toLabel: range.to ? formatMonthVi(range.to) : null,
      label: range.label,
    },
    dateMode: ['overlap', 'start', 'end'].includes(opts.dateMode) ? opts.dateMode : 'overlap',
    missions: missionsResult.rows,
    publications: publicationsResult.rows,
    summary: {
      missions: summarizeMissions(missionsResult.rows),
      publications: summarizePublications(publicationsResult.rows),
    },
    meta: {
      missionsMissingDateCount: missionsResult.missingDateCount,
      missionsMissingDateIncluded: missionsResult.missingDateIncludedCount || 0,
      missionsInferredFromCode: missionsResult.inferredFromCodeCount || 0,
      publicationsYearOnlyIncluded: publicationsResult.yearOnlyIncludedCount,
      publicationsYearOnlyExcluded: publicationsResult.yearOnlyExcludedCount,
      publicationsMissingDateCount: publicationsResult.missingDateCount,
    },
  };
}

module.exports = {
  parseMonthInput,
  extractYearMonth,
  inferYearFromMissionCode,
  formatMonthVi,
  normalizeRange,
  filterMissionsByPeriod,
  filterPublicationsByPeriod,
  summarizeMissions,
  summarizePublications,
  queryPeriodReportData,
  pubTypeLabel,
};
