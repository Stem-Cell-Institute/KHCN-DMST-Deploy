/**
 * Báo cáo Word — thành tích công bố KHCN (thư viện docx).
 * Font Times New Roman 13pt; lề VN: trên/dưới 2cm, trái 3cm, phải 2cm.
 */

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  Header,
  Footer,
  AlignmentType,
  BorderStyle,
  WidthType,
  TableLayoutType,
  ShadingType,
  convertMillimetersToTwip,
  PageNumber,
  VerticalAlignTable,
} = require('docx');

const FONT = 'Times New Roman';
/** docx: kích thước theo half-points — 13pt = 26 */
const SIZE_PT13 = 26;

const CELL_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
  left: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
  right: { style: BorderStyle.SINGLE, size: 1, color: '000000' },
};

function dash(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function tr(text, opts = {}) {
  return new TextRun({
    text: text == null ? '' : String(text),
    font: FONT,
    size: SIZE_PT13,
    bold: opts.bold,
    ...opts,
  });
}

function p(children, paraOpts = {}) {
  const runs = typeof children === 'string' ? [tr(children)] : children;
  return new Paragraph({
    alignment: paraOpts.alignment,
    spacing: paraOpts.spacing,
    children: runs,
  });
}

function headerCell(text) {
  return new TableCell({
    borders: CELL_BORDER,
    shading: { fill: 'D9D9D9', type: ShadingType.CLEAR },
    verticalAlign: VerticalAlignTable.CENTER,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: [p([tr(text, { bold: true })], { spacing: { after: 0, before: 0 } })],
  });
}

function dataCell(text) {
  return new TableCell({
    borders: CELL_BORDER,
    verticalAlign: VerticalAlignTable.TOP,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [p([tr(dash(text))], { spacing: { after: 0, before: 0 } })],
  });
}

function buildTable(headerTexts, rows) {
  const headerRow = new TableRow({
    children: headerTexts.map((h) => headerCell(h)),
  });
  const dataRows = rows.map(
    (cells) =>
      new TableRow({
        children: cells.map((c) => dataCell(c)),
      })
  );
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  });
}

function sectionTitle(text) {
  return p([tr(text, { bold: true })], {
    spacing: { before: 280, after: 160 },
  });
}

function shortIndexDb(s, maxLen = 48) {
  if (!s || !String(s).trim()) return '—';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > maxLen ? `${t.slice(0, maxLen - 1)}…` : t;
}

/**
 * @param {object} opts
 * @param {object} opts.kpi — total_papers, total_citations, avg_if, top_tier_pct, tt26_total_score
 * @param {object[]} opts.quartileRows — view v_quartile_distribution
 * @param {object[]} opts.topCited
 * @param {object[]} opts.fullList
 * @param {number} opts.fromY
 * @param {number} opts.toY
 * @param {string} opts.generatedDate
 * @param {string} opts.generatedByLabel
 * @param {object} [opts.plans] — plan_papers, plan_top_tier, plan_tt26, plan_citations (number | null)
 */
function buildPublicationReportDoc(opts) {
  const {
    kpi,
    quartileRows,
    topCited,
    fullList,
    fromY,
    toY,
    generatedDate,
    generatedByLabel,
    plans = {},
  } = opts;

  const reportPeriod = `${fromY} — ${toY}`;
  const totalPapers = kpi?.total_papers ?? 0;
  const totalCitations = kpi?.total_citations ?? 0;
  const avgIf = kpi?.avg_if;
  const topTierPct = kpi?.top_tier_pct;
  const tt26 = kpi?.tt26_total_score;

  const planPapers = plans.plan_papers;
  const planTopTier = plans.plan_top_tier;
  const planTt26 = plans.plan_tt26;
  const planCitations = plans.plan_citations;

  function pctDone(actual, plan) {
    if (plan == null || plan === '' || Number(plan) <= 0) return '—';
    const a = Number(actual) || 0;
    const p = Number(plan);
    return `${Math.round((a / p) * 1000) / 10}%`;
  }

  const kpiCompareHeaders = ['Chỉ tiêu', 'Kế hoạch', 'Thực hiện', 'Tỷ lệ hoàn thành'];
  const kpiCompareRows = [
    [
      'Số bài công bố',
      dash(planPapers),
      totalPapers,
      pctDone(totalPapers, planPapers),
    ],
    [
      'Số bài Q1 + Q2',
      dash(planTopTier),
      kpi?.top_tier_count ?? 0,
      pctDone(kpi?.top_tier_count ?? 0, planTopTier),
    ],
    [
      'Tổng điểm TT 26/2022',
      dash(planTt26),
      dash(tt26),
      pctDone(tt26, planTt26),
    ],
    [
      'Tổng số trích dẫn',
      dash(planCitations),
      totalCitations,
      pctDone(totalCitations, planCitations),
    ],
  ];

  const quartileHeaders = [
    'Năm',
    'Q1',
    'Q2',
    'Q3',
    'Q4',
    'Tổng',
    '% Top-tier',
    'Điểm TT26',
  ];
  const quartileData = (quartileRows || []).map((r) => [
    r.year,
    r.q1 ?? 0,
    r.q2 ?? 0,
    r.q3 ?? 0,
    r.q4 ?? 0,
    r.total ?? 0,
    r.top_tier_pct != null ? `${r.top_tier_pct}%` : '—',
    dash(r.tt26_score),
  ]);

  const topCitedHeaders = ['STT', 'Tiêu đề', 'Tạp chí', 'Năm', 'Q', 'IF', 'Citations'];
  const topCitedData = (topCited || []).map((r, i) => [
    i + 1,
    r.title,
    r.journal_name,
    r.pub_year,
    dash(r.quartile),
    r.impact_factor != null ? r.impact_factor : '—',
    r.citation_count != null ? r.citation_count : 0,
  ]);

  const fullHeaders = [
    'STT',
    'Tiêu đề',
    'Tác giả',
    'Tạp chí',
    'ISSN',
    'Năm',
    'Q',
    'IF',
    'CSDL',
    'Trích dẫn',
  ];
  const fullData = (fullList || []).map((r, i) => [
    i + 1,
    r.title,
    r.authors,
    r.journal_name,
    dash(r.issn),
    r.pub_year,
    dash(r.quartile),
    r.impact_factor != null ? r.impact_factor : '—',
    shortIndexDb(r.index_db),
    r.citation_count != null ? r.citation_count : 0,
  ]);

  const margin = {
    top: convertMillimetersToTwip(20),
    bottom: convertMillimetersToTwip(20),
    left: convertMillimetersToTwip(30),
    right: convertMillimetersToTwip(20),
  };

  const headerBlock = new Header({
    children: [
      p([tr('VIỆN TẾ BÀO GỐC (SCI)', { bold: true })], { alignment: AlignmentType.CENTER }),
      p([tr('Trường ĐHKH Tự nhiên, ĐHQG TP.HCM')], { alignment: AlignmentType.CENTER }),
      p([tr('─────────────────────────────────────')], { alignment: AlignmentType.CENTER, spacing: { after: 120 } }),
    ],
  });

  const footerBlock = new Footer({
    children: [
      p(
        [
          new TextRun({
            children: ['Trang ', PageNumber.CURRENT],
            font: FONT,
            size: SIZE_PT13,
          }),
        ],
        { alignment: AlignmentType.CENTER }
      ),
    ],
  });

  const bodyChildren = [
    p([tr('BÁO CÁO THÀNH TÍCH CÔNG BỐ KHOA HỌC', { bold: true })], {
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }),
    p(`Kỳ báo cáo: ${reportPeriod}`, { spacing: { after: 60 } }),
    p(`Ngày lập: ${generatedDate}`, { spacing: { after: 60 } }),
    p(`Người lập: ${dash(generatedByLabel)}`, { spacing: { after: 200 } }),

    sectionTitle('━━━ I. TỔNG QUAN ━━━'),
    p(`Tổng số công bố: ${totalPapers} bài`, { spacing: { after: 80 } }),
    p(`Tổng trích dẫn: ${totalCitations} lượt`, { spacing: { after: 80 } }),
    p(`IF trung bình: ${avgIf != null ? avgIf : '—'}`, { spacing: { after: 80 } }),
    p(`Tỷ lệ Q1+Q2: ${topTierPct != null ? `${topTierPct}%` : '—'}`, { spacing: { after: 80 } }),
    p(`Tổng điểm TT 26/2022: ${tt26 != null ? tt26 : '—'} điểm`, { spacing: { after: 120 } }),

    sectionTitle('━━━ II. PHÂN BỐ PHÂN HẠNG ━━━'),
    quartileData.length
      ? buildTable(quartileHeaders, quartileData)
      : p('(Không có dữ liệu trong kỳ.)', { spacing: { after: 120 } }),

    sectionTitle('━━━ III. TOP CÔNG TRÌNH ĐƯỢC TRÍCH DẪN NHIỀU NHẤT ━━━'),
    topCitedData.length
      ? buildTable(topCitedHeaders, topCitedData)
      : p('(Không có dữ liệu.)', { spacing: { after: 120 } }),

    sectionTitle('━━━ IV. DANH MỤC CÔNG BỐ ĐẦY ĐỦ ━━━'),
    fullData.length
      ? buildTable(fullHeaders, fullData)
      : p('(Không có dữ liệu.)', { spacing: { after: 120 } }),

    sectionTitle('━━━ V. CHỈ SỐ CỬA SỞ BAN NGÀNH ━━━'),
    p(
      'Theo yêu cầu biểu mẫu ĐHQG-HCM / Bộ KH&CN (điền kế hoạch qua tham số API nếu cần):',
      { spacing: { after: 120 } }
    ),
    buildTable(kpiCompareHeaders, kpiCompareRows),
  ];

  return new Document({
    creator: 'KHCN-DMST SCI-ACE',
    title: `Báo cáo công bố ${reportPeriod}`,
    styles: {
      default: {
        document: {
          run: {
            font: FONT,
            size: SIZE_PT13,
          },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { margin },
        },
        headers: { default: headerBlock },
        footers: { default: footerBlock },
        children: bodyChildren,
      },
    ],
  });
}

async function buildPublicationReportBuffer(opts) {
  const doc = buildPublicationReportDoc(opts);
  return Packer.toBuffer(doc);
}

module.exports = {
  buildPublicationReportDoc,
  buildPublicationReportBuffer,
};
