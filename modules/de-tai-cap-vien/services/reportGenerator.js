// Service sinh Báo cáo Kiểm toán Hồ sơ dạng HTML độc lập (Self-contained HTML Report)
// Có thể mở offline, in ấn A4 hoặc gửi email đính kèm cho chuyên viên P. KHCN

function generateAuditHtmlReport(projects, summary) {
  const now = new Date();
  const dateStr = `Ngày ${now.getDate()} tháng ${now.getMonth() + 1} năm ${now.getFullYear()}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const rowsHtml = projects.map((p, idx) => {
    const a = p.audit;

    // Màu tiến độ
    let progColor = '#0284c7';
    if (a.percentage === 100) progColor = '#16a34a';
    else if (a.percentage < 40) progColor = '#dc2626';
    else if (a.percentage < 70) progColor = '#ca8a04';

    // Badge trạng thái
    let statusText = 'Đang thực hiện';
    let statusBg = '#f1f5f9';
    let statusColor = '#475569';

    if (a.is_completed) {
      statusText = 'Đã nghiệm thu';
      statusBg = '#dbeafe';
      statusColor = '#1e40af';
    } else if (a.is_extended) {
      statusText = `Đã gia hạn (Lần ${p.extension_count})`;
      statusBg = '#f3e8ff';
      statusColor = '#7e22ce';
    } else if (p.status_color === 'RED') {
      statusText = 'Báo đỏ quá hạn';
      statusBg = '#fee2e2';
      statusColor = '#b91c1c';
    } else if (p.status_color === 'YELLOW') {
      statusText = 'Sắp hết hạn';
      statusBg = '#fef9c3';
      statusColor = '#854d0e';
    }

    // Danh sách văn bản còn thiếu dạng checklist
    let missingListHtml = '';
    if (a.percentage === 100) {
      missingListHtml = '<span style="color: #16a34a; font-weight: 600;">✓ Đầy đủ 100% hồ sơ kiểm toán</span>';
    } else {
      missingListHtml = `
        <ul style="margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.5; color: #334155;">
          ${a.items.filter(i => i.status === 'MISSING').map(i => {
            let tagColor = '#dc2626';
            let tagBg = '#fef2f2';
            let tagBorder = '#fecaca';

            if (i.key.includes('GIA_HAN_2')) {
              tagColor = '#7e22ce';
              tagBg = '#faf5ff';
              tagBorder = '#e9d5ff';
            } else if (i.needed_for === 'LIQUIDATION') {
              tagColor = '#b45309';
              tagBg = '#fffbeb';
              tagBorder = '#fef3c7';
            }

            return `
              <li style="margin-bottom: 4px;">
                <span style="background: ${tagBg}; color: ${tagColor}; border: 1px solid ${tagBorder}; padding: 1px 6px; border-radius: 4px; font-weight: 700; font-size: 11px;">
                  ${i.short_name || i.name}
                </span>
                <span style="color: #475569; margin-left: 4px;">(${i.notes || i.desc})</span>
              </li>
            `;
          }).join('')}
        </ul>
      `;
    }

    return `
      <tr style="border-bottom: 1px solid #e2e8f0; background: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
        <td style="text-align: center; font-size: 12px; color: #64748b; padding: 10px 6px;">${idx + 1}</td>
        <td style="padding: 10px 8px; font-weight: 700; font-size: 12px; color: #0369a1; white-space: nowrap;">
          ${p.code}
        </td>
        <td style="padding: 10px 8px;">
          <div style="font-weight: 600; font-size: 13px; color: #0f172a; line-height: 1.35;">
            ${p.title}
          </div>
          <div style="font-size: 11px; color: #64748b; margin-top: 3px;">
            Chủ nhiệm: <strong style="color: #1e293b;">${p.leader_name}</strong> • Nhóm: <span style="color: #0284c7;">${p.research_group || 'Chưa phân nhóm'}</span>
          </div>
        </td>
        <td style="padding: 10px 8px; white-space: nowrap;">
          <span style="background: ${statusBg}; color: ${statusColor}; padding: 3px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; display: inline-block;">
            ${statusText}
          </span>
          <div style="font-size: 11px; color: #64748b; margin-top: 4px;">
            Hạn: <strong>${p.current_end_date_vn || '-'}</strong>
            ${p.extension_count > 0 ? `<br><small style="text-decoration: line-through; color: #94a3b8;">Gốc: ${p.base_end_date_vn}</small>` : ''}
          </div>
        </td>
        <td style="padding: 10px 8px; text-align: center; white-space: nowrap;">
          <div style="font-size: 13px; font-weight: 800; color: ${progColor};">${a.percentage}%</div>
          <div style="font-size: 11px; color: #64748b; margin-top: 2px;">${a.completed_count}/${a.total_required} giấy tờ</div>
          <div style="width: 80px; height: 6px; background: #e2e8f0; border-radius: 3px; margin: 4px auto 0; overflow: hidden;">
            <div style="width: ${a.percentage}%; height: 100%; background: ${progColor};"></div>
          </div>
        </td>
        <td style="padding: 10px 8px;">
          ${missingListHtml}
        </td>
        <td style="padding: 10px 8px; font-size: 11px; color: #64748b; line-height: 1.3;">
          ${a.is_completed ? '<span style="color: #b45309; font-weight: 600;">Cần ký Thanh lý HĐ & Quyết toán</span>' : 
            (a.missing_extension_2 ? '<span style="color: #7e22ce; font-weight: 600;">Cần nộp Giấy gia hạn L2 hoặc nộp hồ sơ Nghiệm thu</span>' : 
            'Đôn đốc theo tiến độ')}
        </td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>Báo cáo Rà soát Hồ sơ Pháp lý & Danh mục Thiếu - Viện Tế bào gốc (SCI)</title>
  <style>
    @page { size: A4 landscape; margin: 12mm 10mm; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      margin: 0;
      padding: 24px;
      color: #0f172a;
      background: #ffffff;
      font-size: 13px;
      line-height: 1.4;
    }
    .header-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 20px;
    }
    .header-table td {
      vertical-align: top;
    }
    .title-box {
      text-align: center;
      margin: 20px 0 24px 0;
    }
    .report-title {
      font-size: 18px;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      margin: 0 0 6px 0;
      letter-spacing: -0.01em;
    }
    .report-subtitle {
      font-size: 13px;
      color: #475569;
      margin: 0;
      font-style: italic;
    }
    .kpi-container {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
    }
    .kpi-box {
      flex: 1;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
    }
    .kpi-box h4 {
      margin: 0 0 4px 0;
      font-size: 11px;
      text-transform: uppercase;
      color: #64748b;
    }
    .kpi-box .num {
      font-size: 20px;
      font-weight: 800;
      margin: 0;
    }
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #cbd5e1;
      font-size: 12px;
    }
    table.data-table th {
      background: #0f172a;
      color: #ffffff;
      padding: 10px 8px;
      text-align: left;
      font-weight: 700;
      font-size: 11px;
      text-transform: uppercase;
      border-right: 1px solid #334155;
    }
    table.data-table td {
      border: 1px solid #e2e8f0;
      vertical-align: top;
    }
    .signatures {
      width: 100%;
      margin-top: 35px;
      border-collapse: collapse;
      page-break-inside: avoid;
    }
    .signatures td {
      text-align: center;
      vertical-align: top;
      width: 33.33%;
    }
    .sig-title {
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      margin-bottom: 50px;
    }
    @media print {
      body { padding: 0; }
      .no-print { display: none !important; }
    }
  </style>
</head>
<body>

  <!-- Nút tiện ích in ấn / lưu file -->
  <div class="no-print" style="margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; background: #eff6ff; padding: 10px 16px; border-radius: 8px; border: 1px solid #bfdbfe;">
    <div style="color: #1e40af; font-weight: 600; font-size: 13px;">
      📄 File Báo cáo Kiểm toán Hồ sơ Đề tài Cấp Viện (Định dạng HTML độc lập, có thể lưu trữ hoặc gửi email trực tiếp cho Chuyên viên P. KHCN)
    </div>
    <div style="display: flex; gap: 8px;">
      <button onclick="window.print()" style="background: #0284c7; color: #fff; border: none; padding: 7px 16px; border-radius: 6px; font-weight: 600; cursor: pointer;">
        🖨️ In Báo Cáo / Lưu PDF
      </button>
    </div>
  </div>

  <!-- Tiêu ngữ & Đơn vị -->
  <table class="header-table">
    <tr>
      <td style="width: 50%;">
        <div style="font-weight: 700; font-size: 13px; text-transform: uppercase; color: #1e293b;">VIỆN TẾ BÀO GỐC (SCI)</div>
        <div style="font-weight: 700; font-size: 13px; text-transform: uppercase; color: #0284c7; margin-top: 2px;">PHÒNG KHOA HỌC CÔNG NGHỆ & ĐÀO TẠO</div>
        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Mã tài liệu: SCI-NCKH-AUDIT-2026</div>
      </td>
      <td style="width: 50%; text-align: right;">
        <div style="font-weight: 700; font-size: 13px; text-transform: uppercase;">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
        <div style="font-weight: 600; font-size: 12px; margin-top: 2px;">Độc lập - Tự do - Hạnh phúc</div>
        <div style="font-size: 11px; color: #64748b; margin-top: 4px; font-style: italic;">TP. Hồ Chí Minh, ${dateStr} (${timeStr})</div>
      </td>
    </tr>
  </table>

  <!-- Tiêu đề Báo cáo -->
  <div class="title-box">
    <h1 class="report-title">BẢNG RÀ SOÁT HỒ SƠ PHÁP LÝ & DANH MỤC VĂN BẢN CÒN THIẾU</h1>
    <h2 style="font-size: 14px; font-weight: 700; color: #0284c7; margin: 4px 0;">CÁC ĐỀ TÀI KHOA HỌC CÔNG NGHỆ CẤP CƠ SỞ (CẤP VIỆN)</h2>
    <p class="report-subtitle">Phục vụ công tác Nghiệm thu, Thanh lý Hợp đồng và Chuẩn bị Hồ sơ cho Đoàn Thanh tra - Kiểm toán Nhà nước</p>
  </div>

  <!-- Thống kê KPI tóm tắt -->
  <div class="kpi-container">
    <div class="kpi-box">
      <h4>Tổng số đề tài rà soát</h4>
      <div class="num" style="color: #0f172a;">${summary.total_projects} đề tài</div>
    </div>
    <div class="kpi-box" style="border-left: 4px solid #b45309; background: #fefce8;">
      <h4 style="color: #b45309;">Đã nghiệm thu - Thiếu Thanh lý/Quyết toán</h4>
      <div class="num" style="color: #b45309;">${summary.missing_liquidation} đề tài</div>
    </div>
    <div class="kpi-box" style="border-left: 4px solid #7e22ce; background: #faf5ff;">
      <h4 style="color: #7e22ce;">Đã gia hạn L1 - Thiếu Giấy/QĐ gia hạn L2</h4>
      <div class="num" style="color: #7e22ce;">${summary.extended_needs_docs} đề tài</div>
    </div>
    <div class="kpi-box" style="border-left: 4px solid #16a34a; background: #f0fdf4;">
      <h4 style="color: #16a34a;">Đầy đủ 100% hồ sơ kiểm toán</h4>
      <div class="num" style="color: #16a34a;">${summary.full_audit_ready} đề tài</div>
    </div>
  </div>

  <!-- Bảng Ma trận Kiểm tra Chi tiết -->
  <table class="data-table">
    <thead>
      <tr>
        <th style="width: 32px; text-align: center;">STT</th>
        <th style="width: 110px;">MÃ ĐỀ TÀI</th>
        <th style="width: 25%;">TÊN ĐỀ TÀI & CHỦ NHIỆM</th>
        <th style="width: 120px;">TÌNH TRẠNG & HẠN</th>
        <th style="width: 100px; text-align: center;">TIẾN ĐỘ HỒ SƠ</th>
        <th style="width: 38%;">DANH MỤC VĂN BẢN CÒN THIẾU CẦN CHỦ NHIỆM NỘP BỔ SUNG</th>
        <th style="width: 130px;">HƯỚNG XỬ LÝ P. KHCN</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <!-- Chữ ký xác nhận phục vụ kiểm toán -->
  <table class="signatures">
    <tr>
      <td>
        <div class="sig-title">NGƯỜI LẬP BẢNG RÀ SOÁT</div>
        <div style="color: #64748b; font-size: 11px; margin-bottom: 50px;">(Ký và ghi rõ họ tên)</div>
        <div style="font-weight: 700;">Chuyên viên P. KHCN & ĐN</div>
      </td>
      <td>
        <div class="sig-title">TRƯỞNG PHÒNG KẾ HOẠCH TỔNG HỢP & ĐN</div>
        <div style="color: #64748b; font-size: 11px; margin-bottom: 50px;">(Ký và ghi rõ họ tên)</div>
        <div style="font-weight: 700;">Phòng KHCN & Đào tạo</div>
      </td>
      <td>
        <div class="sig-title">BAN GIÁM ĐỐC VIỆN TẾ BÀO GỐC</div>
        <div style="color: #64748b; font-size: 11px; margin-bottom: 50px;">(Phê duyệt)</div>
        <div style="font-weight: 700;">Lãnh đạo Viện</div>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

module.exports = {
  generateAuditHtmlReport
};
