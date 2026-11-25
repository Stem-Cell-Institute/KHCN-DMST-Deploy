const fs = require('fs');
const path = require('path');
const db = require('../db/db');
const projectService = require('../services/projectService');

// Simple CSV parser that handles quotes and newlines
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      row.push(cell.trim());
      if (row.some(c => c.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some(c => c.length > 0)) {
      rows.push(row);
    }
  }
  return rows;
}

async function seed() {
  console.log('🌱 Bắt đầu nạp dữ liệu từ Google Sheets...');
  await db.initSchema();

  // Xóa sạch dữ liệu cũ để nạp lại chuẩn xác
  await db.run('DELETE FROM nckh_audit_checklist');
  await db.run('DELETE FROM nckh_supplies');
  await db.run('DELETE FROM nckh_budget_items');
  await db.run('DELETE FROM nckh_periodic_reports');
  await db.run('DELETE FROM nckh_extensions');
  await db.run('DELETE FROM nckh_documents');
  await db.run('DELETE FROM nckh_projects');

  const csvDir = path.resolve('C:\\Users\\Admin\\.gemini\\antigravity\\brain\\87da25bb-09cf-4580-b227-5237d69af413\\scratch\\csvs');
  const fileToChuc = path.join(csvDir, 'To_chuc_xet_duyet_de_tai_0.csv');
  const fileTrienKhai = path.join(csvDir, 'Trien_khai_de_tai_1443717525.csv');
  const fileDuToan = path.join(csvDir, 'Du_toan_1481710557.csv');

  if (!fs.existsSync(fileToChuc)) {
    console.error('Không tìm thấy file To_chuc_xet_duyet_de_tai_0.csv tại:', fileToChuc);
    return;
  }

  // 1. Nạp danh sách đề tài cấp Viện
  const rawTextToChuc = fs.readFileSync(fileToChuc, 'utf-8');
  const rows = parseCSV(rawTextToChuc);
  console.log(`Đọc được ${rows.length} dòng từ To_chuc_xet_duyet_de_tai_0.csv`);

  const codeToIdMap = new Map();
  const leaderToIdMap = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title = row[0] || '';
    const code = row[1] || '';
    const leader = row[2] || '';
    const missingDocs = row[3] || '';
    const members = row[4] || '';
    const category = row[5] || 'Cơ bản';
    const group = row[6] || '';
    const rawBudget = (row[7] || '0').replace(/[^0-9]/g, '');
    const budget = Number(rawBudget) || 50000000;
    const submissionDate = row[8] || '';
    const dossierStatus = row[10] || '';
    const councilResult = (row[19] || '').trim();
    const councilDate = row[20] || '';
    const rawEndDate = row[23] || '';
    const giaHan1 = row[24] || '';
    const giaHan2 = row[25] || '';
    const finalEvaluation = row[26] || '';

    if (!title) continue;

    // Chuẩn hóa mã đề tài
    let cleanCode = code.trim();
    if (!cleanCode || cleanCode === 'Không được duyệt' || cleanCode === 'Xin bỏ') {
      cleanCode = `NCKH-SCI.TRIAL-${i}`;
    }

    // Thời gian thực hiện và ngày bắt đầu
    let decisionDate = councilDate || '10/10/2024';
    let durationMonths = 12;

    // Đếm số lần gia hạn từ sheet
    let extCount = 0;
    if (giaHan2 && giaHan2.trim()) extCount = 2;
    else if (giaHan1 && giaHan1.trim()) extCount = 1;

    // 1. Ngày hết hạn gốc (trước khi gia hạn)
    let baseEndDate = null;
    if (rawEndDate && rawEndDate.includes('/')) {
      const parsedEnd = projectService.parseDate(rawEndDate);
      if (parsedEnd) {
        baseEndDate = projectService.formatDateISO(parsedEnd);
      }
    }
    if (!baseEndDate) {
      baseEndDate = projectService.calculateEndDates(decisionDate, durationMonths, 0).base_end_date;
    }

    // 2. Ngày hết hạn hiện tại (sau khi gia hạn lần 1 hoặc lần 2)
    let currentEndDate = baseEndDate;
    let extDateStr = '';
    if (extCount === 2 && giaHan2) {
      const p2 = projectService.parseDate(giaHan2);
      if (p2) currentEndDate = projectService.formatDateISO(p2);
      extDateStr = giaHan2;
    } else if (extCount === 1 && giaHan1) {
      const p1 = projectService.parseDate(giaHan1);
      if (p1) currentEndDate = projectService.formatDateISO(p1);
      extDateStr = giaHan1;
    }

    // Trạng thái tổng quát
    let status = 'IN_PROGRESS';
    if (finalEvaluation.includes('Nghiệm thu')) status = 'COMPLETED';
    else if (finalEvaluation.includes('Hủy') || finalEvaluation.includes('Không được duyệt') || finalEvaluation.includes('Xin bỏ')) status = 'CANCELLED';

    // Insert vào database
    const rs = await db.run(`
      INSERT INTO nckh_projects (
        code, title, leader_name, members, category, research_group,
        budget_total, submission_date, council_date, council_result,
        decision_number, decision_date, duration_months,
        base_end_date, current_end_date, extension_count,
        status, final_evaluation, missing_docs, dossier_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      cleanCode,
      title,
      leader,
      members,
      category,
      group,
      budget,
      submissionDate,
      councilDate,
      councilResult || 'Đạt',
      `QĐ-SCI-${cleanCode}`,
      projectService.formatDateISO(projectService.parseDate(decisionDate)),
      durationMonths,
      baseEndDate,
      currentEndDate,
      extCount,
      status,
      finalEvaluation,
      missingDocs,
      dossierStatus,
      `Gia hạn 1: ${giaHan1 || 'Không'} | Gia hạn 2: ${giaHan2 || 'Không'}`
    ]);

    const pId = rs.lastInsertRowid;
    codeToIdMap.set(cleanCode, pId);
    if (leader) leaderToIdMap.set(leader.toLowerCase().trim(), pId);

    // Thêm thông tin lịch sử gia hạn nếu có
    if (extCount >= 1) {
      const decGHDate = projectService.formatDateISO(new Date(2025, 9, 20)); // Ngày 20/10/2025
      const reqGHDate = projectService.formatDateISO(new Date(2025, 9, 5));  // Ngày 05/10/2025
      await db.run(`
        INSERT INTO nckh_extensions (
          project_id, extension_num, months_added, previous_end_date, new_end_date,
          request_date, reason, decision_number, decision_date, status
        ) VALUES (?, 1, 6, ?, ?, ?, 'Gia hạn bổ sung thời gian thử nghiệm theo Quyết định của Viện', ?, ?, 'APPROVED')
      `, [
        pId,
        baseEndDate,
        currentEndDate,
        reqGHDate,
        `QĐ-GH-01/SCI-${cleanCode}`,
        decGHDate
      ]);
    }

    // Khởi tạo các mốc Báo cáo định kỳ 6 tháng
    const milestones = projectService.generateReportMilestones(decisionDate, durationMonths + (extCount * 6));
    for (const m of milestones) {
      await db.run(`
        INSERT INTO nckh_periodic_reports (project_id, period_num, due_date, status)
        VALUES (?, ?, ?, 'PENDING')
      `, [pId, m.period_num, m.due_date]);
    }
  }

  console.log(`✅ Đã nạp xong ${codeToIdMap.size} đề tài cấp Viện.`);

  // 2. Nạp Dự toán chi tiết từ Du_toan_1481710557.csv
  if (fs.existsSync(fileDuToan)) {
    const rawTextDuToan = fs.readFileSync(fileDuToan, 'utf-8');
    const dtRows = parseCSV(rawTextDuToan);
    console.log(`Đọc được ${dtRows.length} dòng từ Du_toan_1481710557.csv`);

    const pNhat = leaderToIdMap.get('trương châu nhật');
    const pKhan = leaderToIdMap.get('bùi đình khan');
    const pNghia = leaderToIdMap.get('đỗ minh nghĩa');
    const pNhi = leaderToIdMap.get('huỳnh thảo nhi');

    const projectColMap = [
      { col: 2, pid: pNhat },
      { col: 3, pid: pKhan },
      { col: 4, pid: pNghia },
      { col: 5, pid: pNhi }
    ];

    for (let r = 4; r < dtRows.length; r++) {
      const row = dtRows[r];
      const itemName = row[0] || '';
      const spec = row[1] || '';
      if (!itemName) continue;

      for (const p of projectColMap) {
        if (!p.pid) continue;
        const qty = Number(row[p.col]);
        if (qty > 0) {
          await db.run(`
            INSERT INTO nckh_budget_items (project_id, item_name, specification, unit, approved_quantity, unit_price, total_price)
            VALUES (?, ?, ?, ?, ?, 0, 0)
          `, [p.pid, itemName, spec, spec.split('/')[0] || 'Cái', qty]);
        }
      }
    }
    console.log('✅ Đã nạp danh mục Dự toán được duyệt cho các đề tài.');
  }

  // 3. Nạp Cấp phát hóa chất từ Trien_khai_de_tai_1443717525.csv
  if (fs.existsSync(fileTrienKhai)) {
    const rawTextTK = fs.readFileSync(fileTrienKhai, 'utf-8');
    const tkRows = parseCSV(rawTextTK);
    console.log(`Đọc được ${tkRows.length} dòng từ Trien_khai_de_tai_1443717525.csv`);

    let supplyCount = 0;
    for (let r = 1; r < Math.min(tkRows.length, 500); r++) {
      const row = tkRows[r];
      const leader = (row[0] || '').trim().toLowerCase();
      const code = (row[2] || '').trim();
      const itemName = row[3] || '';
      const spec = row[4] || '';
      const reqQty = Number(row[5]) || 1;
      const unit = row[6] || '';
      const reqDate = row[7] || '';
      const stockStatus = row[9] || 'Trong kho';
      const recQty = Number(row[10]) || 0;
      const remQty = Number(row[11]) || Math.max(0, reqQty - recQty);
      const fulfillment = row[12] || 'Chưa nhận đủ';
      const receiver = row[17] || '';
      const receivedDate = row[18] || '';
      const misaId = row[20] || '';
      const misaLink = row[21] || '';
      const notes = row[23] || '';

      if (!itemName) continue;

      let pid = codeToIdMap.get(code);
      if (!pid && leader) {
        pid = leaderToIdMap.get(leader);
      }
      if (!pid) {
        pid = Array.from(codeToIdMap.values())[0];
      }

      await db.run(`
        INSERT INTO nckh_supplies (
          project_id, item_name, specification, unit, requested_quantity,
          request_date, stock_status, received_quantity, remaining_quantity,
          fulfillment_status, receiver_name, received_date,
          misa_order_id, misa_link, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        pid,
        itemName,
        spec,
        unit,
        reqQty,
        reqDate,
        stockStatus,
        recQty,
        remQty,
        fulfillment,
        receiver,
        receivedDate,
        misaId,
        misaLink,
        notes
      ]);
      supplyCount++;
    }
    console.log(`✅ Đã nạp ${supplyCount} dòng cấp phát hóa chất/vật tư thực tế.`);
  }

  // 4. Tạo các tài liệu mẫu chuẩn hóa cho tất cả các đề tài theo hiện trạng thực tế
  const allProjects = await db.all('SELECT id, code, title, leader_name, status, extension_count, missing_docs, final_evaluation FROM nckh_projects');
  const config = require('../config/config');

  function createSimplePDF(title, content) {
    const stream = `BT /F1 16 Tf 50 720 Td (${title}) Tj /F1 11 Tf 0 -30 Td (${content}) Tj ET`;
    const streamLen = stream.length;
    return `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n4 0 obj << /Length ${streamLen} >>\nstream\n${stream}\nendstream\nendobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000244 00000 n \n0000000340 00000 n \ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n417\n%%EOF`;
  }

  let totalDocsCreated = 0;

  for (const p of allProjects) {
    // Bỏ qua đề tài Hủy / Không được duyệt
    if (p.status === 'CANCELLED') continue;

    const projectFolder = p.code.replace(/[\/\\:]/g, '_');
    const targetDir = path.join(config.UPLOAD_DIR, projectFolder);
    fs.mkdirSync(targetDir, { recursive: true });

    const isMissingAll = (p.missing_docs || '').toLowerCase().includes('thiếu tất cả');
    const isMissingThuyetMinh = (p.missing_docs || '').toLowerCase().includes('thuyết minh');
    const isCompleted = p.status === 'COMPLETED' || (p.final_evaluation || '').includes('Nghiệm thu');
    const isExtended = (p.extension_count || 0) > 0;

    // Nếu đề tài bị đánh dấu "Thiếu tất cả" trong Google Sheet -> Không có văn bản nào
    if (isMissingAll) continue;

    const docsToCreate = [];

    // GĐ 1: Thuyết minh đề tài
    if (!isMissingThuyetMinh) {
      docsToCreate.push({
        stage: 1,
        doc_type: 'THUYET_MINH',
        title: `Thuyết minh đề tài - ${p.code}`,
        fileName: `Thuyet_minh_${projectFolder}.pdf`,
        content: `Thuyet minh de tai NCKH cap Vien: ${p.title} - Chu nhiem: ${p.leader_name}`
      });
    }

    // GĐ 2: Biên bản họp Hội đồng xét duyệt đề cương
    docsToCreate.push({
      stage: 2,
      doc_type: 'BB_XET_DUYET',
      title: `Biên bản Hội đồng xét duyệt đề cương - ${p.code}`,
      fileName: `Bien_ban_xet_duyet_${projectFolder}.pdf`,
      content: `Bien ban hop Hoi dong xet duyet de cuong de tai: ${p.code}. Ket qua: Dat`
    });

    // GĐ 3: Quyết định giao nhiệm vụ KHCN, Hợp đồng NCKH, Dự toán đã duyệt
    docsToCreate.push(
      {
        stage: 3,
        doc_type: 'QD_GIAO_NHIEM_VU',
        title: `Quyết định giao nhiệm vụ KHCN số QĐ-${p.code}`,
        fileName: `Quyet_dinh_giao_viec_${projectFolder}.pdf`,
        content: `Quyet dinh giao nhiem vu KHCN cap Co so: ${p.code}`
      },
      {
        stage: 3,
        doc_type: 'HOP_DONG',
        title: `Hợp đồng NCKH số HĐ-NCKH-${p.code}`,
        fileName: `Hop_dong_NCKH_${projectFolder}.pdf`,
        content: `Hop dong nghien cuu khoa hoc giua Vien Te bao goc va ${p.leader_name}`
      },
      {
        stage: 3,
        doc_type: 'DU_TOAN_DA_DUYET',
        title: `Bảng dự toán kinh phí đã phê duyệt - ${p.code}`,
        fileName: `Du_toan_phe_duyet_${projectFolder}.pdf`,
        content: `Du toan kinh phi phe duyet de tai: ${p.code}`
      }
    );

    // GĐ 5: Báo cáo định kỳ 6 tháng
    docsToCreate.push({
      stage: 5,
      doc_type: 'BAO_CAO_6_THANG',
      title: `Báo cáo tiến độ định kỳ 6 tháng đợt 1 - ${p.code}`,
      fileName: `Bao_cao_dinh_ky_6T_${projectFolder}.pdf`,
      content: `Bao cao tien do dinh ky 6 thang. Tien do khao sat thuc nghiem dat 65%`
    });

    // GĐ 6: Quyết định gia hạn nếu có
    if (isExtended) {
      docsToCreate.push({
        stage: 6,
        doc_type: 'QD_GIA_HAN',
        title: `Quyết định cho phép gia hạn đề tài số QĐ-GH-01/SCI-${p.code}`,
        fileName: `QD_Gia_han_01_${projectFolder}.pdf`,
        content: `Quyet dinh cho phep gia han de tai ${p.code} them 6 thang den ngay 31/05/2026`
      });
    }

    // GĐ 7: Hồ sơ Nghiệm thu nếu đề tài ĐÃ NGHIỆM THU (COMPLETED)
    if (isCompleted) {
      docsToCreate.push(
        {
          stage: 7,
          doc_type: 'BAO_CAO_TONG_KET',
          title: `Báo cáo tổng kết đề tài & Tóm tắt - ${p.code}`,
          fileName: `Bao_cao_tong_ket_${projectFolder}.pdf`,
          content: `Bao cao tong ket toan bo ket qua nghien cuu de tai ${p.code}`
        },
        {
          stage: 7,
          doc_type: 'SAN_PHAM',
          title: `Minh chứng bài báo khoa học đã đăng - ${p.code}`,
          fileName: `Bai_bao_khoa_hoc_${projectFolder}.pdf`,
          content: `Bai bao khoa hoc cong bo tren Tap chi Chuyen nganh - Minh chung san pham`
        },
        {
          stage: 7,
          doc_type: 'BB_NGHIEM_THU',
          title: `Biên bản Hội đồng đánh giá nghiệm thu cấp cơ sở - ${p.code}`,
          fileName: `Bien_ban_nghiem_thu_${projectFolder}.pdf`,
          content: `Bien ban danh gia nghiem thu Hoi dong cap Co so: Ket qua Dat`
        },
        {
          stage: 7,
          doc_type: 'QD_CONG_NHAN',
          title: `Quyết định công nhận kết quả nghiệm thu - ${p.code}`,
          fileName: `QD_Cong_nhan_ket_qua_${projectFolder}.pdf`,
          content: `Quyet dinh cong nhan ket qua nghiem thu de tai khoa hoc cap Vien: ${p.code}`
        }
        // LƯU Ý: Cố ý CHƯA CÓ BB_THANH_LY (Biên bản thanh lý hợp đồng & Báo cáo quyết toán tài chính)
        // để hệ thống hiển thị chính xác cảnh báo: "Đã nghiệm thu nhưng thiếu Biên bản thanh lý"
      );
    }

    for (const d of docsToCreate) {
      const filePath = path.join(targetDir, d.fileName);
      fs.writeFileSync(filePath, createSimplePDF(d.title, d.content));
      const relativePath = path.relative(config.UPLOAD_DIR, filePath).replace(/\\/g, '/');

      await db.run(`
        INSERT INTO nckh_documents (
          project_id, stage, doc_type, title, file_name, stored_path,
          file_size, mime_type, uploaded_by, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'application/pdf', 'P. KHCN', 'Tài liệu số hóa lưu trữ')
      `, [p.id, d.stage, d.doc_type, d.title, d.fileName, relativePath, fs.statSync(filePath).size]);
      totalDocsCreated++;
    }
  }

  console.log(`✅ Đã nạp thành công ${totalDocsCreated} văn bản tài liệu pháp lý cho các đề tài.`);
  console.log('🎉 Hoàn tất nạp toàn bộ dữ liệu mẫu!');
}

seed().catch(console.error);
