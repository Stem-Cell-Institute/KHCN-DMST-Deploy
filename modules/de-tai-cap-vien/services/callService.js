// Service Quản lý Đợt kêu gọi đề tài, Quy trình cuốn chiếu & Hệ thống Email thông báo theo Ma trận phân quyền
const db = require('../db/db');
const { ROLES, DEMO_PROFILES } = require('../config/roles');

// Danh mục Biểu mẫu chuẩn NCKH Cấp Viện (Tải 1-Click)
const OFFICIAL_FORMS = [
  {
    code: 'MAU-01-TM',
    name: 'Thuyết minh Đề tài KHCN Cấp Cơ sở (Viện Tế bào gốc)',
    file_type: 'docx',
    file_name: 'BM01_Thuyet_minh_de_tai_NCKH_cap_Vien.docx',
    desc: 'Bản đề cương chi tiết theo Nghị định 30/2020/NĐ-CP & Viện TBG.',
    required: true,
    target_field: 'THUYET_MINH'
  },
  {
    code: 'MAU-02-DT',
    name: 'Bảng Dự toán Kinh phí Chi tiết theo Định mức Viện',
    file_type: 'xlsx',
    file_name: 'BM02_Du_toan_kinh_phi_de_tai_cap_Vien.xlsx',
    desc: 'File Excel chuẩn hóa định mức chi tiết hóa chất, vật tư, thuê khoán.',
    required: true,
    target_field: 'DU_TOAN'
  },
  {
    code: 'MAU-03-YCH',
    name: 'Phiếu yêu cầu Cấp phát Hóa chất - Vật tư qua Kho',
    file_type: 'xlsx',
    file_name: 'BM03_Phieu_yeu_cau_hoa_chat_vat_tu.xlsx',
    desc: 'Phiếu đề nghị xuất kho vật tư, hóa chất thí nghiệm theo dự toán.',
    required: false,
    target_field: 'CHUNG_TU_VAT_TU'
  },
  {
    code: 'MAU-04-BC6T',
    name: 'Báo cáo Định kỳ Tiến độ Thực hiện Đề tài (06 tháng/lần)',
    file_type: 'docx',
    file_name: 'BM04_Bao_cao_dinh_ky_tien_do_6_thang.docx',
    desc: 'Mẫu báo cáo tiến độ 6 tháng chuẩn hóa thể thức NĐ 30.',
    required: false,
    target_field: 'BAO_CAO_6_THANG'
  }
];

class CallService {
  // Lấy hoặc khởi tạo đợt kêu gọi đang mở mặc định
  async ensureDefaultCall() {
    let call = await db.get('SELECT * FROM nckh_calls WHERE is_active = 1 ORDER BY id DESC LIMIT 1');
    if (!call) {
      const now = new Date();
      const year = now.getFullYear();
      const openDate = now.toISOString().slice(0, 10);
      const res = await db.run(`
        INSERT INTO nckh_calls (
          call_code, title, year, open_date, deadline_date,
          budget_limit_per_project, guidelines, is_active
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, 1)
      `, [
        `DOT-THUONG-XUYEN-${year}`,
        `Đợt Kêu gọi Đề xuất Đề tài NCKH Cấp Viện Thường xuyên Năm ${year}`,
        year,
        openDate,
        50000000,
        'Tiếp nhận và xử lý hồ sơ đề xuất đề tài NCKH cấp cơ sở theo hình thức thường xuyên: Ngay khi Chủ nhiệm nộp hồ sơ, Phòng KHCN tiến hành thẩm định và thực hiện quy trình thành lập Hội đồng xét duyệt đề cương. Đợt tiếp nhận mở thường xuyên và chỉ tạm dừng khi Viện có thông báo chính thức.'
      ]);
      call = await db.get('SELECT * FROM nckh_calls WHERE id = ?', [res.lastInsertRowid]);
    }
    return call;
  }

  // Khởi tạo một email thông báo và lưu vào nhật ký nckh_email_logs
  async sendNotification({
    eventType,
    recipientRole,
    recipientEmail,
    recipientName,
    subject,
    bodyHtml,
    actionUrl,
    relatedProposalId = null,
    relatedProjectId = null
  }) {
    try {
      const res = await db.run(`
        INSERT INTO nckh_email_logs (
          event_type, recipient_email, recipient_name, recipient_role,
          subject, body_html, related_proposal_id, related_project_id,
          action_url, sent_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENT')
      `, [
        eventType,
        recipientEmail,
        recipientName,
        recipientRole,
        subject,
        bodyHtml,
        relatedProposalId,
        relatedProjectId,
        actionUrl
      ]);
      return res.lastInsertRowid;
    } catch (err) {
      console.error('Lỗi lưu nhật ký email:', err);
      return null;
    }
  }

  // Phát email thông báo tự động toàn Viện khi Mở đợt đăng ký đề tài
  async broadcastCallOpenNotification(call) {
    try {
      const leaders = await db.all(`
        SELECT DISTINCT leader_name, research_group 
        FROM nckh_projects 
        WHERE leader_name IS NOT NULL AND leader_name != ''
      `);

      const recipients = [];
      const seen = new Set();

      (leaders || []).forEach(l => {
        const cleanName = (l.leader_name || '').trim();
        if (!cleanName || seen.has(cleanName)) return;
        seen.add(cleanName);
        const emailSlug = cleanName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '.');
        recipients.push({
          name: cleanName,
          role: 'CHU_NHIEM',
          email: `${emailSlug}@sci.edu.vn`,
          group: l.research_group || 'Nhóm NCKH'
        });
      });

      // Thêm Ban Lãnh đạo Viện & Phòng ban thường trực
      recipients.push({ name: 'PGS.TS. Phạm Văn Phúc', role: 'VIEN_TRUONG', email: 'director@sci.edu.vn', group: 'Ban Lãnh đạo Viện' });
      recipients.push({ name: 'Phòng KHCN & ĐN', role: 'PHONG_KHCN', email: 'khcn@sci.edu.vn', group: 'Đơn vị Quản lý KHCN' });
      recipients.push({ name: 'Phòng Tài chính - Cung ứng', role: 'PHONG_TC_CU', email: 'finance@sci.edu.vn', group: 'Bộ phận Thẩm định Dự toán' });

      let sentCount = 0;
      for (const r of recipients) {
        const emailHtml = `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155; max-width: 650px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div style="background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: white; padding: 20px;">
              <span style="background: #22c55e; color: white; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px;">ĐANG MỞ TIẾP NHẬN THƯỜNG XUYÊN</span>
              <h2 style="margin: 8px 0 4px 0; font-size: 18px; color: white;">Thông báo Tiếp nhận Hồ sơ Đề tài NCKH Cấp Viện Năm ${call.year || 2026}</h2>
              <div style="font-size: 12px; opacity: 0.9;">Viện Tế bào gốc - ĐHQG TP.HCM | Cổng Quản lý Đề tài E-Office SCI</div>
            </div>
            <div style="padding: 20px;">
              <p>Kính gửi <strong>${r.name}</strong> (${r.group}),</p>
              <p>Phòng Khoa học & Công nghệ trân trọng thông báo đến Quý Thầy/Cô, Nhà khoa học và các Nhóm nghiên cứu:</p>
              <div style="background: #f8fafc; border-left: 4px solid #0284c7; padding: 12px 15px; margin: 15px 0;">
                <div style="font-weight: 700; color: #0f172a; margin-bottom: 4px;">Thông tin đợt tiếp nhận:</div>
                <ul style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6;">
                  <li><strong>Tên đợt:</strong> ${call.title}</li>
                  <li><strong>Định mức kinh phí:</strong> Tối đa <strong>50.000.000 VNĐ</strong> / đề tài cấp cơ sở.</li>
                  <li><strong>Hình thức nộp:</strong> Trực tuyến qua Cổng Quản lý Đề tài E-Office SCI.</li>
                  <li><strong>Cơ chế tiếp nhận:</strong> Thường xuyên theo nhu cầu, hồ sơ nộp sẽ được kích hoạt Hội đồng thẩm định đề cương theo quy trình.</li>
                </ul>
              </div>
              <p style="font-size: 13px;">Hệ thống đã chuẩn hóa sẵn <strong>4 biểu mẫu chính thức</strong> (Thuyết minh, Dự toán chi tiết theo định mức, LLKH, Giấy cam kết phối hợp). Quý Thầy/Cô có thể tải biểu mẫu và nộp hồ sơ trực tiếp tại đường dẫn bên dưới:</p>
              <div style="text-align: center; margin: 25px 0;">
                <a href="http://localhost:3005/quan-ly-dot.html" style="background: #0284c7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 14px; display: inline-block;">
                  Truy cập Cổng Đăng ký & Tải Biểu mẫu →
                </a>
              </div>
              <div style="border-top: 1px solid #e2e8f0; padding-top: 12px; font-size: 11px; color: #64748b;">
                Email được gửi tự động từ Hệ thống Quản lý Đề tài Cấp Viện - Viện Tế bào gốc (eoffice.sci.edu.vn).
              </div>
            </div>
          </div>
        `;

        await this.sendNotification({
          eventType: 'CALL_BROADCAST_ANNOUNCEMENT',
          recipientRole: r.role,
          recipientEmail: r.email,
          recipientName: r.name,
          subject: `[E-Office SCI] Thông báo Mở Tiếp nhận Hồ sơ Đề tài NCKH Cấp Viện Năm ${call.year || 2026}`,
          bodyHtml: emailHtml,
          actionUrl: '/quan-ly-dot.html'
        });
        sentCount++;
      }

      return sentCount;
    } catch (err) {
      console.error('Lỗi phát broadcast email thông báo đợt:', err);
      return 0;
    }
  }

  // Kích hoạt chuỗi Email thông báo tự động theo từng bước quy trình nộp hồ sơ đề xuất
  async triggerProposalWorkflowEmails(proposal, stepName, extraData = {}) {
    const pId = proposal.id;
    const pCode = proposal.proposal_code;
    const pTitle = proposal.title;
    const pLeader = proposal.leader_name;
    const pGroup = proposal.research_group || 'Chưa phân nhóm';
    const pBudget = Number(proposal.budget_proposed || 0).toLocaleString('vi-VN') + ' đ';

    const khcnProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_KHCN') || { fullname: 'Phòng KHCN & ĐN', email: 'khcn@sci.edu.vn' };
    const directorProfile = DEMO_PROFILES.find(p => p.role === 'VIEN_TRUONG') || { fullname: 'PGS.TS. Phạm Văn Phúc', email: 'director@sci.edu.vn' };
    const financeProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_TC_CU') || { fullname: 'Phòng Tài chính - Cung ứng', email: 'finance@sci.edu.vn' };
    const leaderEmail = proposal.leader_email || `${pLeader.toLowerCase().replace(/\s+/g, '.')}@sci.edu.vn`;

    // BƯỚC 1: CHỦ NHIỆM VỪA NỘP HỒ SƠ (SUBMITTED) -> Xử lý cuốn chiếu ngay lập tức
    if (stepName === 'SUBMITTED') {
      // 1. Email xác nhận biên nhận nộp cho Chủ nhiệm đề tài
      await this.sendNotification({
        eventType: 'PROPOSAL_SUBMITTED',
        recipientRole: 'CHU_NHIEM',
        recipientEmail: leaderEmail,
        recipientName: pLeader,
        subject: `[E-Office SCI] Đã tiếp nhận Hồ sơ Đề tài KHCN: ${pCode} - ${pLeader}`,
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
            <h3 style="color: #0284c7;">Xác nhận Tiếp nhận Hồ sơ Đề xuất Đề tài Cấp Viện</h3>
            <p>Kính gửi <strong>${pLeader}</strong>,</p>
            <p>Hệ thống Quản lý Đề tài Cấp Viện (SCI) xác nhận đã tiếp nhận thành công hồ sơ đề xuất nghiên cứu của Quý Thầy/Cô:</p>
            <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
              <tr><td style="padding: 6px; border: 1px solid #e2e8f0; font-weight: bold; width: 180px;">Mã tiếp nhận:</td><td style="padding: 6px; border: 1px solid #e2e8f0; color: #0284c7; font-weight: bold;">${pCode}</td></tr>
              <tr><td style="padding: 6px; border: 1px solid #e2e8f0; font-weight: bold;">Tên đề tài:</td><td style="padding: 6px; border: 1px solid #e2e8f0;">${pTitle}</td></tr>
              <tr><td style="padding: 6px; border: 1px solid #e2e8f0; font-weight: bold;">Nhóm nghiên cứu:</td><td style="padding: 6px; border: 1px solid #e2e8f0;">${pGroup}</td></tr>
              <tr><td style="padding: 6px; border: 1px solid #e2e8f0; font-weight: bold;">Dự toán đề xuất:</td><td style="padding: 6px; border: 1px solid #e2e8f0; color: #b45309; font-weight: bold;">${pBudget}</td></tr>
              <tr><td style="padding: 6px; border: 1px solid #e2e8f0; font-weight: bold;">Thời điểm nộp:</td><td style="padding: 6px; border: 1px solid #e2e8f0;">${new Date().toLocaleString('vi-VN')}</td></tr>
            </table>
            <p><em>Tiến độ xử lý hồ sơ:</em> Phòng KHCN đang tiến hành thẩm tra tính hợp lệ của Thuyết minh & Bảng dự toán, và sẽ trình Hội đồng xét duyệt đề cương trong thời gian sớm nhất.</p>
            <p><a href="http://localhost:3005/quan-ly-dot.html?proposal_id=${pId}" style="display: inline-block; background: #0284c7; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Theo dõi Tiến độ Hồ sơ tại E-Office &rarr;</a></p>
          </div>
        `,
        actionUrl: `/quan-ly-dot.html?proposal_id=${pId}`,
        relatedProposalId: pId
      });

      // 2. Email thông báo ngay cho Phòng KHCN để thẩm tra hồ sơ cuốn chiếu
      await this.sendNotification({
        eventType: 'NEW_PROPOSAL_ALERT',
        recipientRole: 'PHONG_KHCN',
        recipientEmail: khcnProfile.email,
        recipientName: khcnProfile.fullname,
        subject: `[Tiếp nhận mới] Hồ sơ đề xuất đề tài: ${pCode} - CNĐT: ${pLeader}`,
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
            <h3 style="color: #b45309;">Thông báo Tiếp nhận Hồ sơ Đề xuất Đề tài</h3>
            <p>Kính gửi <strong>Chuyên viên Phòng KHCN & ĐN</strong>,</p>
            <p>Chủ nhiệm đề tài <strong>${pLeader}</strong> vừa nộp hồ sơ đề xuất đề tài cấp Viện. Đề nghị Phòng KHCN mở kiểm tra tính hợp lệ của hồ sơ (Thuyết minh, Dự toán, phân nhóm NC):</p>
            <ul style="line-height: 1.8;">
              <li><strong>Mã hồ sơ:</strong> ${pCode}</li>
              <li><strong>Tên đề tài:</strong> ${pTitle}</li>
              <li><strong>Kinh phí đề xuất:</strong> ${pBudget}</li>
            </ul>
            <p><a href="http://localhost:3005/quan-ly-dot.html?proposal_id=${pId}&action=verify" style="display: inline-block; background: #0284c7; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Thẩm định Hồ sơ Đề xuất &rarr;</a></p>
          </div>
        `,
        actionUrl: `/quan-ly-dot.html?proposal_id=${pId}&action=verify`,
        relatedProposalId: pId
      });
    }

    // BƯỚC 2: PHÒNG KHCN SƠ DUYỆT ĐẠT & LÊN LỊCH HỘI ĐỒNG XÉT DUYỆT (COUNCIL_SCHEDULED)
    else if (stepName === 'COUNCIL_SCHEDULED') {
      const councilDateVN = extraData.council_date || 'Dự kiến trong 5 ngày tới';
      // Gửi cho Chủ nhiệm để chuẩn bị báo cáo trước Hội đồng
      await this.sendNotification({
        eventType: 'COUNCIL_SCHEDULED',
        recipientRole: 'CHU_NHIEM',
        recipientEmail: leaderEmail,
        recipientName: pLeader,
        subject: `[Hội đồng Tuyển chọn] Lịch bảo vệ Đề cương Đề tài: ${pCode} - ${councilDateVN}`,
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
            <h3 style="color: #7e22ce;">Thư mời Báo cáo trước Hội đồng Tuyển chọn Đề cương</h3>
            <p>Kính gửi <strong>${pLeader}</strong>,</p>
            <p>Hồ sơ đề tài <strong>"${pTitle}"</strong> (${pCode}) đã được Phòng KHCN thẩm tra sơ bộ hợp lệ.</p>
            <p>Kính mời Thầy/Cô chuẩn bị slide báo cáo trước Hội đồng tuyển chọn theo kế hoạch:</p>
            <div style="background: #faf5ff; border: 1px solid #d8b4fe; padding: 12px; border-radius: 6px; margin: 10px 0;">
              <div><strong>Thời gian họp:</strong> ${councilDateVN}</div>
              <div><strong>Địa điểm:</strong> Phòng họp Viện Tế bào gốc (SCI)</div>
              <div><strong>Thời lượng báo cáo:</strong> 15 phút trình bày + 15 phút trả lời phản biện của Hội đồng.</div>
            </div>
            <p><a href="http://localhost:3005/quan-ly-dot.html?proposal_id=${pId}" style="display: inline-block; background: #7e22ce; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Xem Chi tiết Lịch họp tại E-Office &rarr;</a></p>
          </div>
        `,
        actionUrl: `/quan-ly-dot.html?proposal_id=${pId}`,
        relatedProposalId: pId
      });

      // Báo cáo gửi Viện trưởng (Chủ tịch Hội đồng / Lãnh đạo Viện)
      await this.sendNotification({
        eventType: 'COUNCIL_SCHEDULED',
        recipientRole: 'VIEN_TRUONG',
        recipientEmail: directorProfile.email,
        recipientName: directorProfile.fullname,
        subject: `[Trình Viện trưởng] Lịch họp Hội đồng xét duyệt đề cương: ${pCode} - ${pLeader}`,
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
            <p>Kính gửi <strong>Viện trưởng</strong>,</p>
            <p>Phòng KHCN đã rà soát hồ sơ đề xuất của CNĐT <strong>${pLeader}</strong> và kính trình Viện trưởng xem trước Thuyết minh/Dự toán trước khi diễn ra phiên họp Hội đồng vào ngày <strong>${councilDateVN}</strong>.</p>
            <p><a href="http://localhost:3005/quan-ly-dot.html?proposal_id=${pId}" style="display: inline-block; background: #0284c7; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Đọc trước Thuyết minh & Dự toán &rarr;</a></p>
          </div>
        `,
        actionUrl: `/quan-ly-dot.html?proposal_id=${pId}`,
        relatedProposalId: pId
      });
    }

    // BƯỚC 3: HỘI ĐỒNG THÔNG QUA & VIỆN TRƯỞNG DUYỆT TRÚNG TUYỂN -> SINH RA ĐỀ TÀI CHÍNH THỨC
    else if (stepName === 'APPROVED') {
      const decNum = extraData.decision_number || 'Đang ban hành';
      const approvedBudget = Number(extraData.budget || proposal.budget_proposed).toLocaleString('vi-VN') + ' đ';

      // 1. Email chúc mừng Chủ nhiệm đề tài
      await this.sendNotification({
        eventType: 'DIRECTOR_APPROVED',
        recipientRole: 'CHU_NHIEM',
        recipientEmail: leaderEmail,
        recipientName: pLeader,
        subject: `[Chúc mừng] Đề tài ${pCode} đã được Viện trưởng Phê duyệt Trúng tuyển!`,
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
            <h3 style="color: #15803d;">Chúc mừng Đề tài Cấp Viện đã được Phê duyệt</h3>
            <p>Kính gửi <strong>${pLeader}</strong>,</p>
            <p>Viện trưởng Viện Tế bào gốc đã ký Quyết định phê duyệt giao nhiệm vụ KHCN cấp cơ sở cho đề tài:</p>
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 12px; border-radius: 6px; margin: 12px 0;">
              <div><strong>Tên đề tài:</strong> ${pTitle}</div>
              <div><strong>Số Quyết định:</strong> ${decNum}</div>
              <div><strong>Kinh phí phê duyệt:</strong> <span style="color: #15803d; font-weight: bold;">${approvedBudget}</span></div>
              <div><strong>Chủ nhiệm:</strong> ${pLeader}</div>
            </div>
            <p>Hồ sơ đã được tự động chuyển thành **Đề tài chính thức** trên hệ thống quản lý. Kính mời Thầy/Cô liên hệ Phòng KHCN và Phòng Tài chính - Cung ứng để ký Hợp đồng NCKH và triển khai tạm ứng vật tư/hóa chất.</p>
            <p><a href="http://localhost:3005/chi-tiet.html?id=${extraData.projectId || ''}" style="display: inline-block; background: #15803d; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Mở Trang Quản trị 360 độ Đề tài &rarr;</a></p>
          </div>
        `,
        actionUrl: `/chi-tiet.html?id=${extraData.projectId || ''}`,
        relatedProposalId: pId,
        relatedProjectId: extraData.projectId || null
      });

      // 2. Email thông báo Phòng TC-Cung ứng chuẩn bị Hợp đồng & Tạm ứng kinh phí
      await this.sendNotification({
        eventType: 'FINANCE_PREPARE_CONTRACT',
        recipientRole: 'PHONG_TC_CU',
        recipientEmail: financeProfile.email,
        recipientName: financeProfile.fullname,
        subject: `[Phối hợp NCKH] Đề tài ${pCode} đã duyệt QĐ - Chuẩn bị Hợp đồng & Tạm ứng`,
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
            <p>Kính gửi <strong>Phòng Tài chính - Cung ứng</strong>,</p>
            <p>Viện trưởng vừa phê duyệt đề tài <strong>"${pTitle}"</strong> của CNĐT <strong>${pLeader}</strong> với tổng kinh phí: <strong>${approvedBudget}</strong> (QĐ số ${decNum}).</p>
            <p>Đề nghị Phòng TC-CU phối hợp cùng Phòng KHCN và CNĐT hoàn tất Hợp đồng NCKH và lập thủ tục cấp phát theo danh mục dự toán.</p>
            <p><a href="http://localhost:3005/chi-tiet.html?id=${extraData.projectId || ''}&tab=tab-supplies" style="display: inline-block; background: #4338ca; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Xem Danh mục Dự toán đã duyệt &rarr;</a></p>
          </div>
        `,
        actionUrl: `/chi-tiet.html?id=${extraData.projectId || ''}&tab=tab-supplies`,
        relatedProposalId: pId,
        relatedProjectId: extraData.projectId || null
      });
    }

    // BƯỚC 4: HỘI ĐỒNG YÊU CẦU CHỈNH SỬA / BỔ SUNG (REVISION_NEEDED)
    else if (stepName === 'REVISION_NEEDED') {
      const feedback = extraData.feedback || 'Vui lòng cập nhật lại dự toán kinh phí hoặc làm rõ phương pháp nghiên cứu theo nhận xét của Hội đồng.';
      await this.sendNotification({
        eventType: 'REVISION_REQUESTED',
        recipientRole: 'CHU_NHIEM',
        recipientEmail: leaderEmail,
        recipientName: pLeader,
        subject: `[Yêu cầu chỉnh sửa đề cương] Hồ sơ đề tài ${pCode} - ${pLeader}`,
        bodyHtml: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
            <h3 style="color: #b91c1c;">Ý kiến Nhận xét của Hội đồng Tuyển chọn</h3>
            <p>Kính gửi <strong>${pLeader}</strong>,</p>
            <p>Hội đồng tuyển chọn đã họp xem xét hồ sơ đề xuất <strong>"${pTitle}"</strong> (${pCode}). Hội đồng kết luận đề tài **Đạt có chỉnh sửa** với các nội dung cần bổ sung sau:</p>
            <div style="background: #fff1f2; border: 1px solid #fecdd3; padding: 12px; border-radius: 6px; margin: 12px 0; color: #9f1239;">
              ${feedback}
            </div>
            <p>Kính mời Thầy/Cô cập nhật lại file Thuyết minh/Dự toán và nộp bổ sung trực tuyến trên hệ thống.</p>
            <p><a href="http://localhost:3005/quan-ly-dot.html?proposal_id=${pId}&action=reupload" style="display: inline-block; background: #e11d48; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Nộp Hồ sơ Chỉnh sửa tại E-Office &rarr;</a></p>
          </div>
        `,
        actionUrl: `/quan-ly-dot.html?proposal_id=${pId}&action=reupload`,
        relatedProposalId: pId
      });
    }
  }
}

module.exports = {
  callService: new CallService(),
  OFFICIAL_FORMS
};
