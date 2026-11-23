const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {
  parseMonthInput,
  inferYearFromMissionCode,
  filterMissionsByPeriod,
  filterPublicationsByPeriod,
  summarizeMissions,
  summarizePublications,
} = require('../services/periodReportService');
const { buildPeriodReportExcelBuffer } = require('../services/periodReportExcelBuilder');

test('parseMonthInput nhận MM/YYYY, YYYY-MM và YYYY', () => {
  assert.deepEqual(parseMonthInput('03/2024'), { ym: '2024-03', year: 2024, month: 3, key: 2024 * 12 + 3 });
  assert.deepEqual(parseMonthInput('2024-09'), { ym: '2024-09', year: 2024, month: 9, key: 2024 * 12 + 9 });
  assert.deepEqual(parseMonthInput('2024', 'start'), { ym: '2024-01', year: 2024, month: 1, key: 2024 * 12 + 1 });
  assert.deepEqual(parseMonthInput('2024', 'end'), { ym: '2024-12', year: 2024, month: 12, key: 2024 * 12 + 12 });
  assert.equal(parseMonthInput('13/2024'), null);
});

test('filterMissionsByPeriod (overlap): lấy đúng đề tài giao thời gian và gắn nhãn vai trò', () => {
  const sample = [
    { id: 1, code: 'DT-OLD', title: 'Cũ xong rồi', level: 'institute', status: 'completed', start_date: '2020-01-01', end_date: '2021-12-31', budget: 100 },
    { id: 2, code: 'DT-CARRY', title: 'Chuyển tiếp xuyên kỳ', level: 'national', status: 'ongoing', start_date: '2022-06-01', end_date: '2025-12-31', budget: 500 },
    { id: 3, code: 'DT-NEW', title: 'Mở mới trong kỳ', level: 'institute', status: 'ongoing', start_date: '2024-03-15', end_date: '2026-03-15', budget: 200 },
    { id: 4, code: 'DT-END', title: 'Kết thúc trong kỳ', level: 'ministry', status: 'completed', start_date: '2022-01-01', end_date: '2024-05-30', budget: 300 },
    { id: 5, code: 'DT-FUTURE', title: 'Tương lai', level: 'university', status: 'planning', start_date: '2024-10-01', end_date: '2026-10-01', budget: 400 },
  ];

  // Giai đoạn 01/2024 → 06/2024
  const res = filterMissionsByPeriod(sample, {
    fromMonth: '01/2024',
    toMonth: '06/2024',
    dateMode: 'overlap',
  });
  const codes = res.rows.map((r) => r.code);
  assert.deepEqual(codes, ['DT-NEW', 'DT-END', 'DT-CARRY']); // sắp xếp từ cấp nhỏ -> lớn: institute, ministry, national

  const byCode = Object.fromEntries(res.rows.map((r) => [r.code, r.period_role]));
  assert.equal(byCode['DT-NEW'], 'Mở mới trong kỳ');
  assert.equal(byCode['DT-END'], 'Chuyển tiếp & kết thúc trong kỳ');
  assert.equal(byCode['DT-CARRY'], 'Chuyển tiếp (đang triển khai)');

  // Lọc riêng cấp Viện
  const instOnly = filterMissionsByPeriod(sample, {
    fromMonth: '01/2024',
    toMonth: '06/2024',
    levels: ['institute'],
  });
  assert.deepEqual(instOnly.rows.map((r) => r.code), ['DT-NEW']);
});

test('inferYearFromMissionCode và đề tài thiếu ngày (NCKH-SCI.11/25)', () => {
  assert.equal(inferYearFromMissionCode('NCKH-SCI.11/25'), 2025);
  assert.equal(inferYearFromMissionCode('NVTC.002/26'), 2026);
  assert.equal(inferYearFromMissionCode('DT-UN-2026-8566'), 2026);
  assert.equal(inferYearFromMissionCode('VAST.ĐLT.11/15-16'), 2015);
  assert.equal(inferYearFromMissionCode('NO-YEAR-CODE'), null);

  const sample = [
    { id: 1, code: 'NCKH-SCI.11/25', title: 'Đề tài cấp Viện 2025 thiếu ngày', level: 'institute', status: 'planning', start_date: '', end_date: '' },
    { id: 2, code: 'NCKH-SCI.01/19', title: 'Đề tài cấp Viện 2019 thiếu ngày', level: 'institute', status: 'completed', start_date: null, end_date: null },
    { id: 3, code: 'DT-NO-DATE', title: 'Không có ngày lẫn năm trong mã', level: 'institute', status: 'planning', start_date: '', end_date: '' },
  ];

  // Lọc 01/2022 – 12/2026, không bật includeMissingDate: vẫn tự nhận NCKH-SCI.11/25 (năm 2025), bỏ 2019 và DT-NO-DATE
  const r1 = filterMissionsByPeriod(sample, { fromMonth: '01/2022', toMonth: '12/2026', includeMissingDate: false });
  assert.deepEqual(r1.rows.map((r) => r.code), ['NCKH-SCI.11/25']);
  assert.equal(r1.inferredFromCodeCount, 1);
  assert.equal(r1.missingDateCount, 1);
  assert.equal(r1.rows[0].period_role, 'Suy luận từ mã (năm 2025)');

  // Bật includeMissingDate: lấy thêm cả DT-NO-DATE
  const r2 = filterMissionsByPeriod(sample, { fromMonth: '01/2022', toMonth: '12/2026', includeMissingDate: true });
  assert.deepEqual(r2.rows.map((r) => r.code), ['DT-NO-DATE', 'NCKH-SCI.11/25']);
  assert.equal(r2.missingDateIncludedCount, 1);
});

test('filterPublicationsByPeriod: lọc chính xác từng tháng và xử lý bài thiếu tháng', () => {
  const pubs = [
    { id: 1, title: 'Bài tháng 2/2024', pub_year: 2024, pub_date: '2024-02-15', quartile: 'Q1', index_db: 'Scopus', citation_count: 10 },
    { id: 2, title: 'Bài tháng 4/2024', pub_year: 2024, pub_date: '2024-04-20', quartile: 'Q2', index_db: 'WoS', citation_count: 5 },
    { id: 3, title: 'Bài chỉ có năm 2024', pub_year: 2024, pub_date: '', quartile: 'Q1', index_db: 'Scopus', citation_count: 2 },
    { id: 4, title: 'Bài tháng 11/2024', pub_year: 2024, pub_date: '2024-11-01', quartile: 'Q3', index_db: 'PubMed', citation_count: 1 },
  ];

  // Lọc 03/2024 → 06/2024, includeYearOnly = true
  const inc = filterPublicationsByPeriod(pubs, {
    fromMonth: '03/2024',
    toMonth: '06/2024',
    includeYearOnly: true,
  });
  assert.deepEqual(inc.rows.map((r) => r.id), [2, 3]);
  assert.equal(inc.yearOnlyIncludedCount, 1);

  // Lọc 03/2024 → 06/2024, includeYearOnly = false
  const exc = filterPublicationsByPeriod(pubs, {
    fromMonth: '03/2024',
    toMonth: '06/2024',
    includeYearOnly: false,
  });
  assert.deepEqual(exc.rows.map((r) => r.id), [2]);
  assert.equal(exc.yearOnlyExcludedCount, 1);
});

test('buildPeriodReportExcelBuffer tạo đủ sheet hợp lệ cho scope both', async () => {
  const missions = [
    { id: 1, code: 'DT-01', title: 'Đề tài A', principal: 'TS. A', level: 'institute', level_label: 'Cấp Viện', status: 'ongoing', status_label: 'Đang thực hiện', period_role: 'Mở mới trong kỳ', start_date: '2024-02-01', end_date: '2025-12-31', progress: 50, budget: 300000000 },
  ];
  const publications = [
    { id: 1, title: 'Paper A', authors: 'Nguyen A', journal_name: 'Stem Cell', pub_type: 'journal', pub_type_label: 'Bài báo tạp chí', index_db: 'Scopus, WoS', quartile: 'Q1', impact_factor: 6.5, citation_count: 12, _year: 2024, _month: 5, display_month: '05/2024', date_note: '' },
  ];
  const data = {
    scope: 'both',
    range: { fromMonth: '2024-01', toMonth: '2024-12', fromLabel: '01/2024', toLabel: '12/2024', label: '01/2024 – 12/2024' },
    dateMode: 'overlap',
    missions,
    publications,
    summary: {
      missions: summarizeMissions(missions),
      publications: summarizePublications(publications),
    },
    meta: { publicationsYearOnlyIncluded: 0, publicationsYearOnlyExcluded: 0 },
  };

  const buf = await buildPeriodReportExcelBuffer({ data, filters: {}, generatedBy: 'admin@sci.edu.vn' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheetNames = wb.worksheets.map((ws) => ws.name);
  assert.deepEqual(sheetNames, [
    'Tổng hợp chung',
    'Tổng quan đề tài',
    'Đề tài theo cấp × năm',
    'Chi tiết đề tài',
    'Tổng quan bài báo',
    'Chi tiết bài báo',
  ]);
});
