const fs = require('fs');
const path = require('path');
const db = require('../db/db');
const config = require('../config/config');

// Helper to generate a minimal valid single-page PDF with text
function createSimplePDF(title, content) {
  const stream = `BT /F1 16 Tf 50 720 Td (${title}) Tj /F1 11 Tf 0 -30 Td (${content}) Tj ET`;
  const streamLen = stream.length;
  
  return `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamLen} >>
stream
${stream}
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000340 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
417
%%EOF`;
}

async function seedSampleDocs() {
  await db.initSchema();
  const projects = await db.all('SELECT id, code, title, leader_name FROM nckh_projects LIMIT 5');

  for (const p of projects) {
    const projectFolder = p.code.replace(/[\/\\:]/g, '_');
    const targetDir = path.join(config.UPLOAD_DIR, projectFolder);
    fs.mkdirSync(targetDir, { recursive: true });

    const sampleDocs = [
      {
        stage: 1,
        doc_type: 'THUYET_MINH',
        title: `Thuyết minh đề tài - ${p.code}`,
        fileName: `Thuyet_minh_${projectFolder}.pdf`,
        content: `De tai: ${p.title} | Chu nhiem: ${p.leader_name}`
      },
      {
        stage: 3,
        doc_type: 'QD_GIAO_NHIEM_VU',
        title: `Quyết định giao nhiệm vụ KHCN số QĐ-${p.code}`,
        fileName: `Quyet_dinh_giao_viec_${projectFolder}.pdf`,
        content: `Quyet dinh giao nhiem vu KHCN cap Vien: ${p.code}`
      },
      {
        stage: 3,
        doc_type: 'DU_TOAN_DA_DUYET',
        title: `Bảng dự toán kinh phí đã phê duyệt - ${p.code}`,
        fileName: `Du_toan_phe_duyet_${projectFolder}.pdf`,
        content: `Du toan kinh phi phe duyet: 50.000.000 VND`
      },
      {
        stage: 5,
        doc_type: 'BAO_CAO_6_THANG',
        title: `Báo cáo tiến độ định kỳ 6 tháng đợt 1 - ${p.code}`,
        fileName: `Bao_cao_dinh_ky_6T_${projectFolder}.pdf`,
        content: `Bao cao tien do dinh ky 6 thang. Tien do: 65%`
      }
    ];

    for (const d of sampleDocs) {
      const filePath = path.join(targetDir, d.fileName);
      fs.writeFileSync(filePath, createSimplePDF(d.title, d.content));
      const relativePath = path.relative(config.UPLOAD_DIR, filePath).replace(/\\/g, '/');

      await db.run(`
        INSERT INTO nckh_documents (
          project_id, stage, doc_type, title, file_name, stored_path,
          file_size, mime_type, uploaded_by, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'application/pdf', 'P. KHCN', 'Tài liệu mẫu lưu trữ')
      `, [
        p.id,
        d.stage,
        d.doc_type,
        d.title,
        d.fileName,
        relativePath,
        fs.statSync(filePath).size
      ]);
    }
  }

  console.log('✅ Đã tạo các tài liệu mẫu PDF để test chức năng Xem trước (Preview)!');
}

seedSampleDocs().catch(console.error);
