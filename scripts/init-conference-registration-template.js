/**
 * Tạo templates/conference_registration_approval.docx — docxtemplater
 * Chạy: node scripts/init-conference-registration-template.js
 */
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const outDir = path.join(__dirname, '..', 'templates');
const outFile = path.join(outDir, 'conference_registration_approval.docx');

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

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>VIỆN TẾ BÀO GỐC / {unit}</w:t></w:r></w:p><w:p><w:r><w:t>Số: {submission_code}</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Độc lập - Tự do - Hạnh phúc</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Thành phố Hồ Chí Minh, ngày {approved_day} tháng {approved_month} năm {approved_year}</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>ĐƠN ĐĂNG KÝ THAM DỰ HỘI NGHỊ/HỘI THẢO</w:t></w:r></w:p>
    <w:p><w:r><w:t>Kính gửi: Ban Giám đốc Viện Tế bào gốc</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>I. THÔNG TIN NGƯỜI ĐĂNG KÝ</w:t></w:r></w:p>
    <w:p><w:r><w:t>Họ tên: {submitter_name}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Đơn vị: {unit}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Nhóm nghiên cứu: {research_group}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Chức danh/Học vị: {job_title}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>II. THÔNG TIN HỘI NGHỊ/HỘI THẢO</w:t></w:r></w:p>
    <w:p><w:r><w:t>Tên: {conf_name}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Loại: {conf_type}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Đơn vị tổ chức: {conf_organizer}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Thời gian: {conf_start_date} — {conf_end_date}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Địa điểm: {conf_location}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Quốc gia: {conf_country}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Website: {conf_website}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>III. BÀI BÁO/BÁO CÁO THAM DỰ</w:t></w:r></w:p>
    <w:p><w:r><w:t>Có bài: {has_paper}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Tiêu đề: {paper_title}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Tác giả: {paper_authors}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Hình thức: {paper_type}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>IV. MỤC ĐÍCH THAM DỰ</w:t></w:r></w:p>
    <w:p><w:r><w:t>{purpose}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>V. DỰ KIẾN KINH PHÍ</w:t></w:r></w:p>
    <w:p><w:r><w:t>Loại kinh phí: {funding_type}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Tổng đề nghị (VNĐ): {funding_total_vnd}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Chi tiết:</w:t></w:r></w:p>
    <w:p><w:r><w:t>{funding_items_table}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>VI. Ý KIẾN PHÒNG KHCN</w:t></w:r></w:p>
    <w:p><w:r><w:t>{khcn_comment}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Người xét duyệt: {khcn_reviewer_name}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Ngày: {khcn_reviewed_date}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>VII. PHÊ DUYỆT CỦA VIỆN TRƯỞNG</w:t></w:r></w:p>
    <w:p><w:r><w:t>{director_comment}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Người phê duyệt: {director_reviewer_name}</w:t></w:r></w:p>
    <w:p><w:r><w:t>Ngày: {director_reviewed_date}</w:t></w:r></w:p>
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
