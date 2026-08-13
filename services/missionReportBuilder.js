/**
 * services/missionReportBuilder.js
 * Dựng báo cáo thống kê nhiệm vụ KHCN (.xlsx) bằng ExcelJS.
 *
 * Bố cục 4 sheet:
 *   1. Tổng quan          — trang bìa: phạm vi lọc + chỉ số tổng hợp
 *   2. Tổng hợp theo cấp  — bảng chéo cấp × năm (số lượng và kinh phí)
 *   3. Chi tiết nhiệm vụ  — danh sách gom nhóm theo cấp (nhỏ → lớn) rồi theo năm
 *   4. Theo trạng thái    — bảng chéo cấp × trạng thái
 *
 * Thứ tự cấp đi từ NHỎ đến LỚN: Viện → Trường → ĐHQG → Bộ → Nhà nước.
 */

const ExcelJS = require('exceljs');

const ORG_NAME = 'VIỆN TẾ BÀO GỐC';

/** Cấp quản lý, xếp từ nhỏ đến lớn. */
const LEVEL_ORDER = ['institute', 'school', 'university', 'ministry', 'national'];

const LEVEL_LABEL = {
  institute: 'Cấp Viện',
  school: 'Cấp Trường ĐH KHTN',
  university: 'Cấp ĐHQG',
  ministry: 'Cấp Bộ',
  national: 'Cấp Nhà nước',
};

/** Giữ khớp với getStatusText() trong quan-ly-de-tai-co-so.html — sửa thì sửa cả hai. */
const STATUS_LABEL = {
  planning: 'Lập kế hoạch',
  approved: 'Đã phê duyệt',
  ongoing: 'Đang thực hiện',
  review: 'Nghiệm thu',
  completed: 'Hoàn thành',
  overdue: 'Quá hạn',
  cho_phe_duyet_ngoai: 'Chờ phê duyệt ngoài',
  da_phe_duyet: 'Đã phê duyệt',
  dang_thuc_hien: 'Đang thực hiện',
  nghiem_thu_trung_gian: 'Nghiệm thu cơ sở (Viện)',
  nghiem_thu_tong_ket: 'Nghiệm thu cấp Bộ/NN',
  hoan_thanh: 'Hoàn thành',
  khong_duoc_phe_duyet: 'Không được phê duyệt',
  cho_vien_xet_chon: 'Chờ HĐ Viện xét chọn',
  cho_ct_hd_xet_duyet: 'Chờ CT HĐ KHCN xét duyệt',
  buoc4a: 'Bước 4A (Nhánh A)',
  buoc4b: 'Bước 4B (Nhánh B)',
  cho_bo_tham_dinh: 'Chờ Bộ thẩm định',
  cho_ngoai_xet_chon: 'Chờ cơ quan ngoài xét chọn',
  cho_ky_hop_dong: 'Chờ ký hợp đồng',
  dung_khong_dat_dot: 'Dừng — không đạt đợt này',
  xin_dieu_chinh: 'Xin điều chỉnh nội dung',
  cho_nghiem_thu_co_so: 'Chờ nghiệm thu cơ sở',
  cho_nghiem_thu_bo_nn: 'Chờ nghiệm thu cấp Bộ/NN',
  hoan_thien_sau_nghiem_thu: 'Hoàn thiện sau nghiệm thu',
  thanh_ly_hop_dong: 'Thanh lý hợp đồng',
};

/** Trạng thái được coi là đã kết thúc (dùng cho chỉ số hoàn thành). */
const DONE_STATUSES = new Set(['completed', 'hoan_thanh', 'thanh_ly_hop_dong']);
/** Trạng thái đang triển khai. */
const RUNNING_STATUSES = new Set(['ongoing', 'dang_thuc_hien']);

// ── Bảng màu ────────────────────────────────────────────────────────────────
const C = {
  brand: 'FF1F4E79',      // xanh đậm — nền tiêu đề bảng
  brandSoft: 'FFDCE6F1',  // xanh nhạt — dòng nhóm cấp
  groupYear: 'FFF2F2F2',  // xám nhạt — dòng nhóm năm
  zebra: 'FFF9FAFB',      // sọc xen kẽ
  total: 'FFFFF2CC',      // vàng nhạt — dòng tổng
  border: 'FFBFBFBF',
  textMuted: 'FF595959',
};

const THIN = { style: 'thin', color: { argb: C.border } };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };

const FMT_MONEY = '#,##0';
const FMT_PCT = '0"%"';

// ── Tiện ích ────────────────────────────────────────────────────────────────

function levelLabel(v) {
  return LEVEL_LABEL[v] || v || '(không rõ)';
}

function statusLabel(v) {
  return STATUS_LABEL[v] || v || '(không rõ)';
}

/** Năm của nhiệm vụ = năm bắt đầu; không có thì trả null. */
function missionYear(row) {
  const s = String(row.start_date || '').trim();
  const m = s.match(/^(\d{4})/);
  return m ? Number(m[1]) : null;
}

function levelRank(v) {
  const i = LEVEL_ORDER.indexOf(v);
  return i === -1 ? LEVEL_ORDER.length : i;
}

/** dd/mm/yyyy — giữ nguyên chuỗi gốc nếu không parse được. */
function formatDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function styleHeaderRow(row, height = 30) {
  row.height = height;
  row.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.brand } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
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

/**
 * Khối tiêu đề dùng chung đầu mỗi sheet.
 * @returns {number} số dòng đã chiếm
 */
function addSheetTitle(ws, { title, subtitle, colSpan }) {
  const last = String.fromCharCode(64 + colSpan);

  ws.mergeCells(`A1:${last}1`);
  const c1 = ws.getCell('A1');
  c1.value = ORG_NAME;
  c1.font = { bold: true, size: 11, color: { argb: C.textMuted } };
  c1.alignment = { horizontal: 'center' };

  ws.mergeCells(`A2:${last}2`);
  const c2 = ws.getCell('A2');
  c2.value = title;
  c2.font = { bold: true, size: 16, color: { argb: C.brand } };
  c2.alignment = { horizontal: 'center' };
  ws.getRow(2).height = 24;

  ws.mergeCells(`A3:${last}3`);
  const c3 = ws.getCell('A3');
  c3.value = subtitle;
  c3.font = { italic: true, size: 10, color: { argb: C.textMuted } };
  c3.alignment = { horizontal: 'center' };

  ws.getRow(4).height = 6;
  return 4;
}

// ── Sheet 1: Tổng quan ──────────────────────────────────────────────────────

function buildOverviewSheet(wb, ctx) {
  const { rows, scopeText, generatedAt, generatedBy, years } = ctx;
  const ws = wb.addWorksheet('Tổng quan', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.getColumn(1).width = 42;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 16;

  addSheetTitle(ws, {
    title: 'BÁO CÁO THỐNG KÊ NHIỆM VỤ KHOA HỌC & CÔNG NGHỆ',
    subtitle: scopeText,
    colSpan: 4,
  });

  const totalBudget = rows.reduce((s, r) => s + num(r.budget), 0);
  const done = rows.filter((r) => DONE_STATUSES.has(r.status)).length;
  const running = rows.filter((r) => RUNNING_STATUSES.has(r.status)).length;
  const avgProgress = rows.length
    ? Math.round(rows.reduce((s, r) => s + num(r.progress), 0) / rows.length)
    : 0;

  ws.addRow([]);
  const hdr = ws.addRow(['CHỈ SỐ TỔNG HỢP', 'GIÁ TRỊ', '', '']);
  ws.mergeCells(`B${hdr.number}:D${hdr.number}`);
  styleHeaderRow(hdr, 26);

  const kpis = [
    ['Tổng số nhiệm vụ', rows.length, null],
    ['Tổng kinh phí (VNĐ)', totalBudget, FMT_MONEY],
    ['Đang thực hiện', running, null],
    ['Đã hoàn thành / thanh lý', done, null],
    ['Tiến độ trung bình', avgProgress, FMT_PCT],
    ['Số cấp quản lý có nhiệm vụ', new Set(rows.map((r) => r.level)).size, null],
    ['Khoảng năm có dữ liệu', years.length ? `${years[0]}–${years[years.length - 1]}` : '—', null],
  ];
  kpis.forEach(([label, value, fmt], i) => {
    const r = ws.addRow([label, value, '', '']);
    ws.mergeCells(`B${r.number}:D${r.number}`);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { horizontal: 'left' };
    if (fmt) r.getCell(2).numFmt = fmt;
    if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
    r.height = 20;
  });

  // Phân bổ theo cấp — nhỏ → lớn
  ws.addRow([]);
  const h2 = ws.addRow(['PHÂN BỔ THEO CẤP QUẢN LÝ', 'SỐ LƯỢNG', 'TỶ LỆ', 'KINH PHÍ (VNĐ)']);
  styleHeaderRow(h2, 26);

  const presentLevels = LEVEL_ORDER.filter((lv) => rows.some((r) => r.level === lv));
  const otherLevels = [...new Set(rows.map((r) => r.level))].filter(
    (lv) => !LEVEL_ORDER.includes(lv)
  );
  [...presentLevels, ...otherLevels].forEach((lv, i) => {
    const sub = rows.filter((r) => r.level === lv);
    const r = ws.addRow([
      levelLabel(lv),
      sub.length,
      rows.length ? sub.length / rows.length : 0,
      sub.reduce((s, x) => s + num(x.budget), 0),
    ]);
    r.getCell(2).alignment = { horizontal: 'center' };
    r.getCell(3).numFmt = '0.0%';
    r.getCell(3).alignment = { horizontal: 'center' };
    r.getCell(4).numFmt = FMT_MONEY;
    if (i % 2 === 1) fillRow(r, C.zebra);
    borderRow(r);
  });

  const tr = ws.addRow(['TỔNG CỘNG', rows.length, 1, totalBudget]);
  tr.font = { bold: true };
  tr.getCell(2).alignment = { horizontal: 'center' };
  tr.getCell(3).numFmt = '0.0%';
  tr.getCell(3).alignment = { horizontal: 'center' };
  tr.getCell(4).numFmt = FMT_MONEY;
  fillRow(tr, C.total);
  borderRow(tr);

  ws.addRow([]);
  const f1 = ws.addRow([`Xuất lúc: ${generatedAt}`]);
  f1.getCell(1).font = { italic: true, size: 9, color: { argb: C.textMuted } };
  if (generatedBy) {
    const f2 = ws.addRow([`Người xuất: ${generatedBy}`]);
    f2.getCell(1).font = { italic: true, size: 9, color: { argb: C.textMuted } };
  }
  return ws;
}

// ── Sheet 2: Tổng hợp theo cấp × năm ────────────────────────────────────────

function buildPivotSheet(wb, ctx) {
  const { rows, scopeText, years } = ctx;
  const ws = wb.addWorksheet('Tổng hợp theo cấp', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const colSpan = years.length + 2; // cấp + các năm + tổng
  ws.getColumn(1).width = 26;
  for (let i = 2; i <= colSpan; i++) ws.getColumn(i).width = 13;

  addSheetTitle(ws, {
    title: 'TỔNG HỢP NHIỆM VỤ THEO CẤP VÀ THEO NĂM',
    subtitle: scopeText,
    colSpan: Math.max(colSpan, 2),
  });

  const levelsPresent = [
    ...LEVEL_ORDER.filter((lv) => rows.some((r) => r.level === lv)),
    ...[...new Set(rows.map((r) => r.level))].filter((lv) => !LEVEL_ORDER.includes(lv)),
  ];

  /** Vẽ một bảng chéo cấp × năm. */
  function addMatrix(caption, valueFn, numFmt) {
    ws.addRow([]);
    const cap = ws.addRow([caption]);
    ws.mergeCells(`A${cap.number}:${ws.getColumn(colSpan).letter}${cap.number}`);
    cap.getCell(1).font = { bold: true, size: 12, color: { argb: C.brand } };

    const head = ws.addRow(['Cấp quản lý', ...years.map(String), 'Tổng']);
    styleHeaderRow(head, 24);

    levelsPresent.forEach((lv, i) => {
      const cells = years.map((y) =>
        valueFn(rows.filter((r) => r.level === lv && missionYear(r) === y))
      );
      const rowTotal = valueFn(rows.filter((r) => r.level === lv));
      const r = ws.addRow([levelLabel(lv), ...cells, rowTotal]);
      r.eachCell((cell, cn) => {
        cell.border = BOX;
        if (cn > 1) {
          cell.alignment = { horizontal: 'center' };
          if (numFmt) cell.numFmt = numFmt;
        }
      });
      r.getCell(1).font = { bold: true };
      r.getCell(colSpan).font = { bold: true };
      if (i % 2 === 1) fillRow(r, C.zebra);
    });

    const totals = years.map((y) => valueFn(rows.filter((r) => missionYear(r) === y)));
    const tr = ws.addRow(['TỔNG CỘNG', ...totals, valueFn(rows)]);
    tr.font = { bold: true };
    tr.eachCell((cell, cn) => {
      cell.border = BOX;
      if (cn > 1) {
        cell.alignment = { horizontal: 'center' };
        if (numFmt) cell.numFmt = numFmt;
      }
    });
    fillRow(tr, C.total);
  }

  addMatrix('A. SỐ LƯỢNG NHIỆM VỤ', (list) => list.length, null);
  addMatrix(
    'B. KINH PHÍ (VNĐ)',
    (list) => list.reduce((s, r) => s + num(r.budget), 0),
    FMT_MONEY
  );

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 6 }];
  return ws;
}

// ── Sheet 3: Chi tiết nhiệm vụ ──────────────────────────────────────────────

const DETAIL_COLUMNS = [
  { header: 'STT', width: 6, align: 'center' },
  { header: 'Mã nhiệm vụ', width: 18 },
  { header: 'Tên nhiệm vụ', width: 52, wrap: true },
  { header: 'Chủ nhiệm', width: 24 },
  { header: 'Cấp quản lý', width: 20 },
  { header: 'Trạng thái', width: 22 },
  { header: 'Ngày bắt đầu', width: 13, align: 'center' },
  { header: 'Ngày kết thúc', width: 13, align: 'center' },
  { header: 'Tiến độ', width: 9, align: 'center', numFmt: FMT_PCT },
  { header: 'Kinh phí (VNĐ)', width: 16, numFmt: FMT_MONEY },
  { header: 'Cơ quan chủ quản', width: 24 },
  { header: 'Số hợp đồng', width: 16 },
  { header: 'Nguồn kinh phí', width: 18 },
  { header: 'Lĩnh vực', width: 18 },
  { header: 'Loại hình', width: 16 },
];

function buildDetailSheet(wb, ctx) {
  const { rows, scopeText } = ctx;
  const ws = wb.addWorksheet('Chi tiết nhiệm vụ', {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });

  const nCols = DETAIL_COLUMNS.length;
  DETAIL_COLUMNS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
  });

  addSheetTitle(ws, {
    title: 'DANH SÁCH CHI TIẾT NHIỆM VỤ KHOA HỌC & CÔNG NGHỆ',
    subtitle: `${scopeText} · Sắp xếp từ cấp nhỏ đến cấp lớn, trong mỗi cấp theo năm tăng dần`,
    colSpan: nCols,
  });

  const headRow = ws.addRow(DETAIL_COLUMNS.map((c) => c.header));
  styleHeaderRow(headRow, 32);
  const headRowNumber = headRow.number;

  // Gom nhóm: cấp (nhỏ → lớn) → năm (tăng dần)
  const sorted = [...rows].sort((a, b) => {
    const lr = levelRank(a.level) - levelRank(b.level);
    if (lr !== 0) return lr;
    const ya = missionYear(a);
    const yb = missionYear(b);
    if (ya !== yb) return (ya == null ? Infinity : ya) - (yb == null ? Infinity : yb);
    return String(a.code || '').localeCompare(String(b.code || ''), 'vi');
  });

  let stt = 0;
  let currentLevel = Symbol('none');
  let currentYear = Symbol('none');
  let levelBucket = [];

  /** Dòng tổng cho một cấp vừa kết thúc. */
  function flushLevelSubtotal() {
    if (!levelBucket.length) return;
    const r = ws.addRow([
      '',
      `Tổng ${levelLabel(currentLevel)}`,
      `${levelBucket.length} nhiệm vụ`,
      '',
      '',
      '',
      '',
      '',
      '',
      levelBucket.reduce((s, x) => s + num(x.budget), 0),
    ]);
    r.font = { bold: true };
    r.getCell(10).numFmt = FMT_MONEY;
    for (let i = 1; i <= nCols; i++) {
      const cell = r.getCell(i);
      cell.border = BOX;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.total } };
    }
    levelBucket = [];
  }

  for (const m of sorted) {
    const lv = m.level;
    const yr = missionYear(m);

    if (lv !== currentLevel) {
      flushLevelSubtotal();
      currentLevel = lv;
      currentYear = Symbol('none');
      const gr = ws.addRow([levelLabel(lv)]);
      ws.mergeCells(`A${gr.number}:${ws.getColumn(nCols).letter}${gr.number}`);
      const cell = gr.getCell(1);
      cell.font = { bold: true, size: 12, color: { argb: C.brand } };
      cell.alignment = { vertical: 'middle', indent: 1 };
      gr.height = 24;
      for (let i = 1; i <= nCols; i++) {
        gr.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.brandSoft } };
        gr.getCell(i).border = BOX;
      }
    }

    if (yr !== currentYear) {
      currentYear = yr;
      const yrLabel = yr == null ? 'Chưa có ngày bắt đầu' : `Năm ${yr}`;
      const gy = ws.addRow([yrLabel]);
      ws.mergeCells(`A${gy.number}:${ws.getColumn(nCols).letter}${gy.number}`);
      const cell = gy.getCell(1);
      cell.font = { bold: true, italic: true, size: 10.5 };
      cell.alignment = { vertical: 'middle', indent: 2 };
      for (let i = 1; i <= nCols; i++) {
        gy.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.groupYear } };
        gy.getCell(i).border = BOX;
      }
    }

    stt += 1;
    levelBucket.push(m);
    const r = ws.addRow([
      stt,
      m.code || '',
      m.title || '',
      m.principal || '',
      levelLabel(m.level),
      statusLabel(m.status),
      formatDate(m.start_date),
      formatDate(m.end_date),
      m.progress != null ? num(m.progress) : '',
      m.budget != null ? num(m.budget) : '',
      m.managing_agency || '',
      m.contract_number || '',
      m.funding_source || '',
      m.field || '',
      m.mission_type || '',
    ]);
    r.alignment = { vertical: 'top' };
    DETAIL_COLUMNS.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      cell.border = BOX;
      if (c.numFmt) cell.numFmt = c.numFmt;
      cell.alignment = {
        vertical: 'top',
        horizontal: c.align || 'left',
        wrapText: !!c.wrap,
      };
    });
    if (stt % 2 === 0) fillRow(r, C.zebra);
  }
  flushLevelSubtotal();

  // Tổng toàn báo cáo
  const grand = ws.addRow([
    '',
    'TỔNG TOÀN BÁO CÁO',
    `${rows.length} nhiệm vụ`,
    '',
    '',
    '',
    '',
    '',
    '',
    rows.reduce((s, x) => s + num(x.budget), 0),
  ]);
  grand.font = { bold: true, size: 11.5 };
  grand.getCell(10).numFmt = FMT_MONEY;
  for (let i = 1; i <= nCols; i++) {
    const cell = grand.getCell(i);
    cell.border = { ...BOX, top: { style: 'double', color: { argb: C.brand } } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.brandSoft } };
  }

  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: headRowNumber }];
  ws.autoFilter = {
    from: { row: headRowNumber, column: 1 },
    to: { row: headRowNumber, column: nCols },
  };
  // Lặp lại dòng tiêu đề khi in nhiều trang
  ws.pageSetup.printTitlesRow = `${headRowNumber}:${headRowNumber}`;
  return ws;
}

// ── Sheet 4: Theo trạng thái ────────────────────────────────────────────────

function buildStatusSheet(wb, ctx) {
  const { rows, scopeText } = ctx;
  const ws = wb.addWorksheet('Theo trạng thái', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const levelsPresent = [
    ...LEVEL_ORDER.filter((lv) => rows.some((r) => r.level === lv)),
    ...[...new Set(rows.map((r) => r.level))].filter((lv) => !LEVEL_ORDER.includes(lv)),
  ];
  const statusesPresent = [...new Set(rows.map((r) => r.status))].sort((a, b) =>
    statusLabel(a).localeCompare(statusLabel(b), 'vi')
  );

  const colSpan = levelsPresent.length + 2;
  ws.getColumn(1).width = 30;
  for (let i = 2; i <= colSpan; i++) ws.getColumn(i).width = 20;

  addSheetTitle(ws, {
    title: 'THỐNG KÊ NHIỆM VỤ THEO TRẠNG THÁI',
    subtitle: scopeText,
    colSpan: Math.max(colSpan, 2),
  });

  ws.addRow([]);
  const head = ws.addRow(['Trạng thái', ...levelsPresent.map(levelLabel), 'Tổng']);
  styleHeaderRow(head, 30);

  statusesPresent.forEach((st, i) => {
    const cells = levelsPresent.map(
      (lv) => rows.filter((r) => r.status === st && r.level === lv).length
    );
    const r = ws.addRow([
      statusLabel(st),
      ...cells,
      rows.filter((r2) => r2.status === st).length,
    ]);
    r.eachCell((cell, cn) => {
      cell.border = BOX;
      if (cn > 1) cell.alignment = { horizontal: 'center' };
    });
    r.getCell(1).font = { bold: true };
    r.getCell(colSpan).font = { bold: true };
    if (i % 2 === 1) fillRow(r, C.zebra);
  });

  const tr = ws.addRow([
    'TỔNG CỘNG',
    ...levelsPresent.map((lv) => rows.filter((r) => r.level === lv).length),
    rows.length,
  ]);
  tr.font = { bold: true };
  tr.eachCell((cell, cn) => {
    cell.border = BOX;
    if (cn > 1) cell.alignment = { horizontal: 'center' };
  });
  fillRow(tr, C.total);

  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 6 }];
  return ws;
}

// ── Điểm vào ────────────────────────────────────────────────────────────────

/**
 * @param {object[]} rows      Bản ghi từ bảng missions (đã lọc sẵn).
 * @param {object}   filters   { fromYear, toYear, levels[], statuses[] } — chỉ dùng để mô tả phạm vi.
 * @param {string}   generatedBy Email/tên người xuất (tuỳ chọn).
 * @returns {Promise<Buffer>}
 */
async function buildMissionReportBuffer({ rows, filters = {}, generatedBy = '' }) {
  const list = Array.isArray(rows) ? rows : [];

  const yearSet = new Set();
  for (const r of list) {
    const y = missionYear(r);
    if (y != null) yearSet.add(y);
  }
  const years = [...yearSet].sort((a, b) => a - b);

  const parts = [];
  if (filters.fromYear || filters.toYear) {
    parts.push(`Giai đoạn: ${filters.fromYear || '…'} – ${filters.toYear || '…'}`);
  } else {
    parts.push('Giai đoạn: toàn bộ');
  }
  if (Array.isArray(filters.levels) && filters.levels.length) {
    parts.push(`Cấp: ${filters.levels.map(levelLabel).join(', ')}`);
  } else {
    parts.push('Cấp: tất cả');
  }
  if (Array.isArray(filters.statuses) && filters.statuses.length) {
    parts.push(`Trạng thái: ${filters.statuses.map(statusLabel).join(', ')}`);
  }
  const generatedAt = new Date().toLocaleString('vi-VN', {
    timeZone: process.env.TZ || 'Asia/Ho_Chi_Minh',
    hour12: false,
  });
  const scopeText = `${parts.join('  ·  ')}  ·  Tổng: ${list.length} nhiệm vụ`;

  const wb = new ExcelJS.Workbook();
  wb.creator = ORG_NAME;
  wb.created = new Date();
  wb.title = 'Báo cáo thống kê nhiệm vụ KHCN';

  const ctx = { rows: list, years, scopeText, generatedAt, generatedBy };
  buildOverviewSheet(wb, ctx);
  buildPivotSheet(wb, ctx);
  buildDetailSheet(wb, ctx);
  buildStatusSheet(wb, ctx);

  return wb.xlsx.writeBuffer();
}

module.exports = {
  buildMissionReportBuffer,
  LEVEL_ORDER,
  LEVEL_LABEL,
  STATUS_LABEL,
};
