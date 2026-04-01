/**
 * Tạo templates/equipment_report_template.docx — docxtemplater
 * Biến: report_period, total_equipment, total_hours, avg_utilization,
 *   equipment_table, user_stats_table, maintenance_table (mảng — lặp hàng),
 *   generated_date, generated_by
 *
 * Chạy: node scripts/init-equipment-report-template.js
 */
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const outDir = path.join(__dirname, '..', 'templates');
const outFile = path.join(outDir, 'equipment_report_template.docx');

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const borders =
  '<w:tblBorders>' +
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="666666"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="666666"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="666666"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="666666"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>' +
  '</w:tblBorders>';

function tc(text) {
  return (
    '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">' +
    text +
    '</w:t></w:r></w:p></w:tc>'
  );
}

function tr(cells) {
  return '<w:tr>' + cells.map(tc).join('') + '</w:tr>';
}

function tbl(gridCols, headerRow, loopRow) {
  const grid = gridCols.map((w) => `<w:gridCol w:w="${w}" w:type="dxa"/>`).join('');
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' +
    borders +
    '</w:tblPr><w:tblGrid>' +
    grid +
    '</w:tblGrid>' +
    tr(headerRow) +
    tr(loopRow) +
    '</w:tbl>'
  );
}

const tblEquipment = tbl(
  [2800, 2200, 2200, 1600],
  ['Thiết bị', 'Giờ có sẵn', 'Giờ đặt', 'Tỷ lệ (%)'],
  ['{#equipment_table}{eq_name}', '{eq_avail}', '{eq_booked}', '{eq_util}{/equipment_table}']
);

const tblUsers = tbl(
  [2600, 2200, 1400, 1200, 1600],
  ['Họ tên', 'Nhóm NC', 'Tổng giờ', 'Số lịch', 'Tỷ lệ hủy (%)'],
  [
    '{#user_stats_table}{u_name}',
    '{u_group}',
    '{u_hours}',
    '{u_bookings}',
    '{u_cancel}{/user_stats_table}',
  ]
);

const tblMaint = tbl(
  [2400, 1400, 1400, 2000, 2000],
  ['Thiết bị', 'Giờ tích lũy', 'Ngưỡng (h)', 'Cảnh báo', 'Bảo trì gần nhất'],
  [
    '{#maintenance_table}{m_name}',
    '{m_accumulated}',
    '{m_threshold}',
    '{m_urgency_label}',
    '{m_last_date}{/maintenance_table}',
  ]
);

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>BÁO CÁO SỬ DỤNG THIẾT BỊ</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Viện Tế bào gốc — ĐHQG TP.HCM</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Kỳ báo cáo: {report_period}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>I. TỔNG QUAN</w:t></w:r></w:p>
    <w:p><w:r><w:t>Tổng số thiết bị: {total_equipment}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Tổng giờ sử dụng: {total_hours}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Tỷ lệ sử dụng trung bình: {avg_utilization}%</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>II. CHI TIẾT TỪNG THIẾT BỊ</w:t></w:r></w:p>
    ${tblEquipment}
    <w:p/>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>III. THỐNG KÊ NGƯỜI DÙNG</w:t></w:r></w:p>
    ${tblUsers}
    <w:p/>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>IV. TÌNH TRẠNG BẢO TRÌ</w:t></w:r></w:p>
    ${tblMaint}
    <w:p/>
    <w:p><w:r><w:t>Ngày lập báo cáo: {generated_date}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Người lập: {generated_by}</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`;

const zip = new PizZip();
zip.file('[Content_Types].xml', contentTypes);
zip.folder('_rels').file('.rels', rels);
zip.folder('word').file('document.xml', documentXml);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, zip.generate({ type: 'nodebuffer' }));
console.log('Đã tạo:', outFile);
