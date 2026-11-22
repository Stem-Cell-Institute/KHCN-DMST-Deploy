/**
 * services/periodReportExcelBuilder.js
 * Dựng báo cáo Excel (.xlsx) theo giai đoạn tháng (MM/YYYY → MM/YYYY)
 * cho Đề tài KHCN, Bài báo khoa học, hoặc gộp cả hai trong 1 file.
 */

const ExcelJS = require('exceljs');
const { LEVEL_ORDER, LEVEL_LABEL, STATUS_LABEL } = require('./missionReportBuilder');

const ORG_NAME = 'VIỆN TẾ BÀO GỐC';

const C = {
  brand: 'FF1F4E79',
  brandSoft: 'FFDCE6F1',
  pubBrand: 'FF1D5B4E',
  pubSoft: 'FFD9EFE9',
  groupYear: 'FFF2F2F2',
  zebra: 'FFF9FAFB',
  total: 'FFFFF2CC',
  border: 'FFBFBFBF',
  textMuted: 'FF595959',
};

const THIN = { style: 'thin', color: { argb: C.border } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const FMT_MONEY = '#,##0';
const FMT_PCT = '0"%"';

const DATE_MODE_LABEL = {
  overlap: 'Giao với giai đoạn (đang triển khai / chuyển tiếp)',
  start: 'Bắt đầu trong giai đoạn',
  end: 'Kết thúc trong giai đoạn',
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function levelLabel(v) {
  return LEVEL_LABEL[v] || v || '(Không rõ)';
}

function statusLabel(v) {
  return STATUS_LABEL[v] || v || '(Không rõ)';
}

function formatDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function missionStartYear(row) {
  const m = String(row.start_date || '').trim().match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function styleHeaderRow(row, height = 28, bg = C.brand) {
  row.height = height;
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10.5 };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = BOX;
  });
}

function fillRow(row, argb) {
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
  });
}

function borderRow(row) {
  row.eachCell((cell) => {
    cell.border = BOX;
  });
}

function addSheetTitle(ws, { title, subtitle, colSpan, accent = C.brand }) {
  const last = colLetter(Math.max(colSpan, 2));
  ws.mergeCells(`A1:${last}1`);
  const c1 = ws.getCell('A1');
  c1.value = ORG_NAME;
  c1.font = { bold: true, size: 11, color: { argb: C.textMuted } };
  c1.alignment = { horizontal: 'center' };

  ws.mergeCells(`A2:${last}2`);
  const c2 = ws.getCell('A2');
  c2.value = title;
  c2.font = { bold: true, size: 15, color: { argb: accent } };
  c2.alignment = { horizontal: 'center' };
  ws.getRow(2).height = 24;

  ws.mergeCells(`A3:${last}3`);
  const c3 = ws.getCell('A3');
  c3.value = subtitle;
  c3.font = { italic: true, size: 10, color: { argb: C.textMuted } };
  c3.alignment = { horizontal: 'center' };

  ws.getRow(4).height = 6;
}

// ── Sheet Tổng hợp chung (khi xuất cả Đề tài & Bài báo) ─────────────────────

function addCombinedOverviewSheet(wb, ctx) {
  const { data, scopeText, generatedAt, generatedBy } = ctx;
  const ms = data.summary.missions;
  const ps = data.summary.publications;

  const ws = wb.addWorksheet('Tổng hợp chung', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 22;

  addSheetTitle(ws, {
    title: 'BÁO CÁO TỔNG HỢP HOẠT ĐỘNG KHCN (ĐỀ TÀI & BÀI BÁO)',
    subtitle: scopeText,
    colSpan: 4,
  });

  // Khối 1: Đề tài
  ws.addRow([]);
  const h1 = ws.addRow(['I. TỔNG HỢP ĐỀ TÀI / NHIỆM VỤ KHCN', 'SỐ LƯỢNG', 'TỶ LỆ', 'KINH PHÍ (VNĐ)']);
  styleHeaderRow(h1, 26, C.brand);

  ms.byLevel.forEach((lv, i) => {
    const r = ws.addRow([
      lv.label,
      lv.count,
      ms.total ? lv.count / ms.total : 0,
      lv.budget,
    ]);
    r.getCell(2).alignment = { horizontal: 'center' };
    r.getCell(3).numFmt = '0.0%';
    r.getCell(3).alignment = { horizontal: 'center' };
    r.getCell(4).numFmt = FMT_MONEY;
    if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
  });

  const mTot = ws.addRow(['TỔNG CỘNG ĐỀ TÀI', ms.total, ms.total ? 1 : 0, ms.totalBudget]);
  mTot.font = { bold: true };
  mTot.getCell(2).alignment = { horizontal: 'center' };
  mTot.getCell(3).numFmt = '0.0%';
  mTot.getCell(3).alignment = { horizontal: 'center' };
  mTot.getCell(4).numFmt = FMT_MONEY;
  fillRow(mTot, C.total);
  borderRow(mTot);

  // Khối 2: Bài báo
  ws.addRow([]);
  const h2 = ws.addRow(['II. TỔNG HỢP BÀI BÁO / CÔNG BỐ KHOA HỌC', 'SỐ LƯỢNG', 'GHI CHÚ', '']);
  ws.mergeCells(`C${h2.number}:D${h2.number}`);
  styleHeaderRow(h2, 26, C.pubBrand);

  const pubRows = [
    ['Tổng số bài báo / công bố', ps.total, `Tổng lượt trích dẫn: ${ps.totalCitations}`],
    ['Thuộc chỉ mục Scopus', ps.indexCounts.scopus, ''],
    ['Thuộc chỉ mục Web of Science (WoS)', ps.indexCounts.wos, ''],
    ['Thuộc chỉ mục PubMed', ps.indexCounts.pubmed, ''],
    ['Phân hạng Q1', ps.quartileCounts.Q1, ''],
    ['Phân hạng Q2', ps.quartileCounts.Q2, ''],
    ['Phân hạng Q3 / Q4', ps.quartileCounts.Q3 + ps.quartileCounts.Q4, `Q3: ${ps.quartileCounts.Q3} · Q4: ${ps.quartileCounts.Q4}`],
    ['Chưa phân hạng / Khác', ps.quartileCounts.other, ''],
  ];
  pubRows.forEach(([label, val, note], i) => {
    const r = ws.addRow([label, val, note, '']);
    ws.mergeCells(`C${r.number}:D${r.number}`);
    r.getCell(1).font = { bold: i === 0 };
    r.getCell(2).alignment = { horizontal: 'center' };
    if (i === 0) fillRow(r, C.total);
    else if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
  });

  ws.addRow([]);
  const f1 = ws.addRow([`Xuất lúc: ${generatedAt}${generatedBy ? ' · Người xuất: ' + generatedBy : ''}`]);
  f1.getCell(1).font = { italic: true, size: 9, color: { argb: C.textMuted } };
}

// ── Các sheet Đề tài ────────────────────────────────────────────────────────

function addMissionsOverviewSheet(wb, ctx) {
  const { data, scopeText, generatedAt, generatedBy } = ctx;
  const rows = data.missions;
  const ms = data.summary.missions;

  const ws = wb.addWorksheet('Tổng quan đề tài', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 20;

  addSheetTitle(ws, {
    title: 'BÁO CÁO THỐNG KÊ ĐỀ TÀI / NHIỆM VỤ KHCN',
    subtitle: scopeText,
    colSpan: 4,
  });

  ws.addRow([]);
  const h1 = ws.addRow(['CHỈ SỐ TỔNG HỢP', 'GIÁ TRỊ', '', '']);
  ws.mergeCells(`B${h1.number}:D${h1.number}`);
  styleHeaderRow(h1, 26);

  const avgProgress = rows.length
    ? Math.round(rows.reduce((s, r) => s + num(r.progress), 0) / rows.length)
    : 0;

  const kpis = [
    ['Giai đoạn báo cáo', data.range.label, null],
    ['Tiêu chí mốc thời gian', DATE_MODE_LABEL[data.dateMode] || data.dateMode, null],
    ['Tổng số đề tài khớp', ms.total, null],
    ['Tổng kinh phí (VNĐ)', ms.totalBudget, FMT_MONEY],
    ['Đang thực hiện', ms.runningCount, null],
    ['Đã hoàn thành / thanh lý', ms.doneCount, null],
    ['Tiến độ trung bình', avgProgress, FMT_PCT],
  ];
  kpis.forEach(([label, value, fmt], i) => {
    const r = ws.addRow([label, value, '', '']);
    ws.mergeCells(`B${r.number}:D${r.number}`);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { horizontal: 'left' };
    if (fmt) r.getCell(2).numFmt = fmt;
    if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
  });

  ws.addRow([]);
  const h2 = ws.addRow(['PHÂN BỔ THEO CẤP QUẢN LÝ', 'SỐ LƯỢNG', 'TỶ LỆ', 'KINH PHÍ (VNĐ)']);
  styleHeaderRow(h2, 26);

  ms.byLevel.forEach((lv, i) => {
    const r = ws.addRow([lv.label, lv.count, ms.total ? lv.count / ms.total : 0, lv.budget]);
    r.getCell(2).alignment = { horizontal: 'center' };
    r.getCell(3).numFmt = '0.0%';
    r.getCell(3).alignment = { horizontal: 'center' };
    r.getCell(4).numFmt = FMT_MONEY;
    if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
  });

  const tr = ws.addRow(['TỔNG CỘNG', ms.total, ms.total ? 1 : 0, ms.totalBudget]);
  tr.font = { bold: true };
  tr.getCell(2).alignment = { horizontal: 'center' };
  tr.getCell(3).numFmt = '0.0%';
  tr.getCell(3).alignment = { horizontal: 'center' };
  tr.getCell(4).numFmt = FMT_MONEY;
  fillRow(tr, C.total);
  borderRow(tr);

  if (ms.byRole.length) {
    ws.addRow([]);
    const h3 = ws.addRow(['PHÂN BỔ THEO TÌNH TRẠNG TRONG KỲ', 'SỐ LƯỢNG', '', '']);
    ws.mergeCells(`B${h3.number}:D${h3.number}`);
    styleHeaderRow(h3, 24);
    ms.byRole.forEach((item, i) => {
      const r = ws.addRow([item.role, item.count, '', '']);
      ws.mergeCells(`B${r.number}:D${r.number}`);
      r.getCell(2).alignment = { horizontal: 'center' };
      if (i % 2 === 1) fillRow(r, C.zebra);
      borderRow(r);
    });
  }

  ws.addRow([]);
  const f1 = ws.addRow([`Xuất lúc: ${generatedAt}${generatedBy ? ' · Người xuất: ' + generatedBy : ''}`]);
  f1.getCell(1).font = { italic: true, size: 9, color: { argb: C.textMuted } };
}

function addMissionsDetailSheet(wb, ctx) {
  const { data, scopeText } = ctx;
  const rows = data.missions;
  const cols = [
    { header: 'STT', width: 6, align: 'center' },
    { header: 'Mã đề tài', width: 18, align: 'left' },
    { header: 'Tên đề tài / nhiệm vụ', width: 46, align: 'left', wrap: true },
    { header: 'Chủ nhiệm', width: 22, align: 'left' },
    { header: 'Cấp quản lý', width: 20, align: 'left' },
    { header: 'Tình trạng trong kỳ', width: 24, align: 'left' },
    { header: 'Trạng thái hiện tại', width: 22, align: 'left' },
    { header: 'Ngày bắt đầu', width: 14, align: 'center' },
    { header: 'Ngày kết thúc', width: 14, align: 'center' },
    { header: 'Tiến độ', width: 10, align: 'center' },
    { header: 'Kinh phí (VNĐ)', width: 18, align: 'right' },
    { header: 'Cơ quan quản lý', width: 22, align: 'left' },
    { header: 'Số hợp đồng', width: 18, align: 'left' },
  ];

  const ws = wb.addWorksheet('Chi tiết đề tài', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  addSheetTitle(ws, {
    title: 'DANH SÁCH CHI TIẾT ĐỀ TÀI / NHIỆM VỤ KHCN',
    subtitle: scopeText,
    colSpan: cols.length,
  });

  ws.addRow([]);
  const head = ws.addRow(cols.map((c) => c.header));
  styleHeaderRow(head, 30);
  const headRowNum = head.number;

  const presentLevels = [
    ...LEVEL_ORDER.filter((lv) => rows.some((r) => r.level === lv)),
    ...[...new Set(rows.map((r) => r.level))].filter((lv) => !LEVEL_ORDER.includes(lv)),
  ];

  let stt = 0;
  for (const lv of presentLevels) {
    const sub = rows.filter((r) => r.level === lv);
    const subBudget = sub.reduce((s, x) => s + num(x.budget), 0);
    const grp = ws.addRow([
      `${levelLabel(lv).toUpperCase()} (${sub.length} đề tài — Kinh phí: ${subBudget.toLocaleString('vi-VN')} VNĐ)`,
    ]);
    ws.mergeCells(`A${grp.number}:${colLetter(cols.length)}${grp.number}`);
    grp.font = { bold: true, color: { argb: C.brand }, size: 10.5 };
    fillRow(grp, C.brandSoft);
    borderRow(grp);
    grp.height = 22;

    sub.forEach((m, idx) => {
      stt += 1;
      const r = ws.addRow([
        stt,
        m.code || '',
        m.title || '',
        m.principal || '',
        levelLabel(m.level),
        m.period_role || '',
        statusLabel(m.status),
        formatDate(m.start_date),
        formatDate(m.end_date),
        num(m.progress),
        num(m.budget),
        m.managing_agency || '',
        m.contract_number || '',
      ]);
      cols.forEach((c, ci) => {
        const cell = r.getCell(ci + 1);
        cell.alignment = { vertical: 'middle', horizontal: c.align, wrapText: Boolean(c.wrap) };
        cell.border = BOX;
      });
      r.getCell(10).numFmt = FMT_PCT;
      r.getCell(11).numFmt = FMT_MONEY;
      if (idx % 2 === 1) fillRow(r, C.zebra);
    });
  }

  const grand = ws.addRow([
    '',
    'TỔNG CỘNG',
    `${rows.length} đề tài`,
    '', '', '', '', '', '', '',
    rows.reduce((s, x) => s + num(x.budget), 0),
    '', '',
  ]);
  grand.font = { bold: true };
  grand.getCell(11).numFmt = FMT_MONEY;
  fillRow(grand, C.total);
  borderRow(grand);

  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: headRowNum }];
  ws.autoFilter = {
    from: { row: headRowNum, column: 1 },
    to: { row: headRowNum, column: cols.length },
  };
  ws.pageSetup.printTitlesRow = `${headRowNum}:${headRowNum}`;
}

function addMissionsPivotSheet(wb, ctx) {
  const { data, scopeText } = ctx;
  const rows = data.missions;
  const years = [...new Set(rows.map(missionStartYear).filter((y) => y != null))].sort((a, b) => a - b);
  const levelsPresent = [
    ...LEVEL_ORDER.filter((lv) => rows.some((r) => r.level === lv)),
    ...[...new Set(rows.map((r) => r.level))].filter((lv) => !LEVEL_ORDER.includes(lv)),
  ];

  const colSpan = Math.max(years.length + 2, 2);
  const ws = wb.addWorksheet('Đề tài theo cấp × năm', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.getColumn(1).width = 26;
  for (let i = 2; i <= colSpan; i++) ws.getColumn(i).width = 14;

  addSheetTitle(ws, {
    title: 'PHÂN BỔ ĐỀ TÀI THEO CẤP VÀ NĂM BẮT ĐẦU',
    subtitle: scopeText,
    colSpan,
  });

  function addMatrix(caption, valueFn, numFmt) {
    ws.addRow([]);
    const cap = ws.addRow([caption]);
    ws.mergeCells(`A${cap.number}:${colLetter(colSpan)}${cap.number}`);
    cap.getCell(1).font = { bold: true, size: 11.5, color: { argb: C.brand } };

    const head = ws.addRow(['Cấp quản lý', ...years.map(String), 'Tổng']);
    styleHeaderRow(head, 24);

    levelsPresent.forEach((lv, i) => {
      const vals = years.map((y) => valueFn(rows.filter((r) => r.level === lv && missionStartYear(r) === y)));
      const rowTot = valueFn(rows.filter((r) => r.level === lv));
      const r = ws.addRow([levelLabel(lv), ...vals, rowTot]);
      r.eachCell((cell, cn) => {
        cell.border = BOX;
        if (cn > 1) {
          cell.alignment = { horizontal: numFmt ? 'right' : 'center' };
          if (numFmt) cell.numFmt = numFmt;
        }
      });
      r.getCell(1).font = { bold: true };
      r.getCell(colSpan).font = { bold: true };
      if (i % 2 === 1) fillRow(r, C.zebra);
    });

    const tot = ws.addRow([
      'TỔNG CỘNG',
      ...years.map((y) => valueFn(rows.filter((r) => missionStartYear(r) === y))),
      valueFn(rows),
    ]);
    tot.font = { bold: true };
    tot.eachCell((cell, cn) => {
      cell.border = BOX;
      if (cn > 1) {
        cell.alignment = { horizontal: numFmt ? 'right' : 'center' };
        if (numFmt) cell.numFmt = numFmt;
      }
    });
    fillRow(tot, C.total);
  }

  addMatrix('1. Số lượng đề tài', (sub) => sub.length, null);
  addMatrix('2. Tổng kinh phí (VNĐ)', (sub) => sub.reduce((s, x) => s + num(x.budget), 0), FMT_MONEY);
}

// ── Các sheet Bài báo ───────────────────────────────────────────────────────

function addPublicationsOverviewSheet(wb, ctx) {
  const { data, scopeText, generatedAt, generatedBy } = ctx;
  const ps = data.summary.publications;

  const ws = wb.addWorksheet('Tổng quan bài báo', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.getColumn(1).width = 38;
  ws.getColumn(2).width = 18;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 20;

  addSheetTitle(ws, {
    title: 'BÁO CÁO THỐNG KÊ BÀI BÁO / CÔNG BỐ KHOA HỌC',
    subtitle: scopeText,
    colSpan: 4,
    accent: C.pubBrand,
  });

  ws.addRow([]);
  const h1 = ws.addRow(['CHỈ SỐ TỔNG HỢP CÔNG BỐ', 'GIÁ TRỊ', '', '']);
  ws.mergeCells(`B${h1.number}:D${h1.number}`);
  styleHeaderRow(h1, 26, C.pubBrand);

  const kpis = [
    ['Giai đoạn báo cáo', data.range.label],
    ['Tổng số bài báo / công bố', ps.total],
    ['Tổng lượt trích dẫn', ps.totalCitations],
    ['Chỉ mục Scopus', ps.indexCounts.scopus],
    ['Chỉ mục Web of Science (WoS)', ps.indexCounts.wos],
    ['Chỉ mục PubMed', ps.indexCounts.pubmed],
    ['Số bài Q1 / Q2 / Q3 / Q4', `Q1: ${ps.quartileCounts.Q1} · Q2: ${ps.quartileCounts.Q2} · Q3: ${ps.quartileCounts.Q3} · Q4: ${ps.quartileCounts.Q4}`],
  ];
  if (data.meta.publicationsYearOnlyIncluded > 0) {
    kpis.push(['Bài chỉ có năm (chưa rõ tháng) được gộp vào', data.meta.publicationsYearOnlyIncluded]);
  }
  kpis.forEach(([label, value], i) => {
    const r = ws.addRow([label, value, '', '']);
    ws.mergeCells(`B${r.number}:D${r.number}`);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { horizontal: 'left' };
    if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
  });

  // Phân bổ theo năm
  ws.addRow([]);
  const h2 = ws.addRow(['PHÂN BỔ THEO NĂM XUẤT BẢN', 'SỐ BÀI', 'TỶ LỆ', '']);
  ws.mergeCells(`C${h2.number}:D${h2.number}`);
  styleHeaderRow(h2, 24, C.pubBrand);

  ps.byYear.forEach((item, i) => {
    const r = ws.addRow([item.year, item.count, ps.total ? item.count / ps.total : 0, '']);
    ws.mergeCells(`C${r.number}:D${r.number}`);
    r.getCell(2).alignment = { horizontal: 'center' };
    r.getCell(3).numFmt = '0.0%';
    r.getCell(3).alignment = { horizontal: 'center' };
    if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
  });

  const tr = ws.addRow(['TỔNG CỘNG', ps.total, ps.total ? 1 : 0, '']);
  ws.mergeCells(`C${tr.number}:D${tr.number}`);
  tr.font = { bold: true };
  tr.getCell(2).alignment = { horizontal: 'center' };
  tr.getCell(3).numFmt = '0.0%';
  tr.getCell(3).alignment = { horizontal: 'center' };
  fillRow(tr, C.total);
  borderRow(tr);

  // Phân bổ theo loại công bố
  if (ps.byType.length) {
    ws.addRow([]);
    const h3 = ws.addRow(['PHÂN BỔ THEO LOẠI CÔNG BỐ', 'SỐ BÀI', '', '']);
    ws.mergeCells(`B${h3.number}:D${h3.number}`);
    styleHeaderRow(h3, 24, C.pubBrand);
    ps.byType.forEach((item, i) => {
      const r = ws.addRow([item.label, item.count, '', '']);
      ws.mergeCells(`B${r.number}:D${r.number}`);
      r.getCell(2).alignment = { horizontal: 'center' };
      if (i % 2 === 1) fillRow(r, C.zebra);
      borderRow(r);
    });
  }

  ws.addRow([]);
  const f1 = ws.addRow([`Xuất lúc: ${generatedAt}${generatedBy ? ' · Người xuất: ' + generatedBy : ''}`]);
  f1.getCell(1).font = { italic: true, size: 9, color: { argb: C.textMuted } };
}

function addPublicationsDetailSheet(wb, ctx) {
  const { data, scopeText } = ctx;
  const rows = data.publications;
  const cols = [
    { header: 'STT', width: 6, align: 'center' },
    { header: 'Tháng/Năm', width: 13, align: 'center' },
    { header: 'Tiêu đề bài báo / công bố', width: 48, align: 'left', wrap: true },
    { header: 'Tác giả', width: 32, align: 'left', wrap: true },
    { header: 'Tạp chí / Hội nghị', width: 28, align: 'left', wrap: true },
    { header: 'Loại', width: 16, align: 'left' },
    { header: 'Chỉ mục', width: 18, align: 'left' },
    { header: 'Quartile', width: 10, align: 'center' },
    { header: 'IF', width: 9, align: 'right' },
    { header: 'Trích dẫn', width: 11, align: 'center' },
    { header: 'ISSN / ISBN', width: 15, align: 'left' },
    { header: 'DOI', width: 24, align: 'left' },
    { header: 'Mã đề tài', width: 16, align: 'left' },
    { header: 'Ghi chú ngày', width: 22, align: 'left' },
  ];

  const ws = wb.addWorksheet('Chi tiết bài báo', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  addSheetTitle(ws, {
    title: 'DANH SÁCH CHI TIẾT BÀI BÁO / CÔNG BỐ KHOA HỌC',
    subtitle: scopeText,
    colSpan: cols.length,
    accent: C.pubBrand,
  });

  ws.addRow([]);
  const head = ws.addRow(cols.map((c) => c.header));
  styleHeaderRow(head, 30, C.pubBrand);
  const headRowNum = head.number;

  rows.forEach((p, idx) => {
    const r = ws.addRow([
      idx + 1,
      p.display_month || '',
      p.title || '',
      p.authors || '',
      p.journal_name || p.conference_name || '',
      p.pub_type_label || '',
      p.index_db || '',
      p.quartile || '',
      p.impact_factor != null && p.impact_factor !== '' ? Number(p.impact_factor) : '',
      num(p.citation_count),
      p.issn || p.isbn || '',
      p.doi || '',
      p.project_code || '',
      p.date_note || '',
    ]);
    cols.forEach((c, ci) => {
      const cell = r.getCell(ci + 1);
      cell.alignment = { vertical: 'middle', horizontal: c.align, wrapText: Boolean(c.wrap) };
      cell.border = BOX;
    });
    if (idx % 2 === 1) fillRow(r, C.zebra);
  });

  const grand = ws.addRow([
    '',
    'TỔNG CỘNG',
    `${rows.length} bài báo`,
    '', '', '', '', '', '',
    rows.reduce((s, x) => s + num(x.citation_count), 0),
    '', '', '', '',
  ]);
  grand.font = { bold: true };
  grand.getCell(10).alignment = { horizontal: 'center' };
  fillRow(grand, C.total);
  borderRow(grand);

  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: headRowNum }];
  ws.autoFilter = {
    from: { row: headRowNum, column: 1 },
    to: { row: headRowNum, column: cols.length },
  };
  ws.pageSetup.printTitlesRow = `${headRowNum}:${headRowNum}`;
}

/**
 * Dựng buffer file Excel (.xlsx) từ kết quả queryPeriodReportData().
 */
async function buildPeriodReportExcelBuffer({ data, filters = {}, generatedBy = '' }) {
  const parts = [`Giai đoạn: ${data.range.label}`];
  if (data.scope === 'missions' || data.scope === 'both') {
    const lvText =
      Array.isArray(filters.levels) && filters.levels.length
        ? filters.levels.map(levelLabel).join(', ')
        : 'Tất cả các cấp';
    parts.push(`Cấp đề tài: ${lvText}`);
    parts.push(`Đề tài: ${data.missions.length}`);
  }
  if (data.scope === 'publications' || data.scope === 'both') {
    parts.push(`Bài báo: ${data.publications.length}`);
  }

  const generatedAt = new Date().toLocaleString('vi-VN', {
    timeZone: process.env.TZ || 'Asia/Ho_Chi_Minh',
    hour12: false,
  });
  const scopeText = parts.join('  ·  ');

  const wb = new ExcelJS.Workbook();
  wb.creator = ORG_NAME;
  wb.created = new Date();
  wb.title = `Báo cáo KHCN — ${data.range.label}`;

  const ctx = { data, filters, scopeText, generatedAt, generatedBy };

  if (data.scope === 'both') {
    addCombinedOverviewSheet(wb, ctx);
    addMissionsOverviewSheet(wb, ctx);
    addMissionsPivotSheet(wb, ctx);
    addMissionsDetailSheet(wb, ctx);
    addPublicationsOverviewSheet(wb, ctx);
    addPublicationsDetailSheet(wb, ctx);
  } else if (data.scope === 'publications') {
    addPublicationsOverviewSheet(wb, ctx);
    addPublicationsDetailSheet(wb, ctx);
  } else {
    addMissionsOverviewSheet(wb, ctx);
    addMissionsPivotSheet(wb, ctx);
    addMissionsDetailSheet(wb, ctx);
  }

  return wb.xlsx.writeBuffer();
}

module.exports = {
  buildPeriodReportExcelBuffer,
};
