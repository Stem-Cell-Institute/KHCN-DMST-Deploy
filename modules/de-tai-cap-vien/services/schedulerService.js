/**
 * Automated Daily Scheduler & Deadline Warning Engine
 * Tự động quét hạn hợp đồng đề tài KHCN cấp cơ sở theo chuẩn thông lệ Việt Nam:
 * - Mốc 30 ngày (Nhắc việc nộp nghiệm thu / xin gia hạn / cảnh báo thanh lý)
 * - Mốc 15 ngày (Khẩn cấp: Sắp hết hạn nộp đơn gia hạn)
 * - Mốc 7 ngày (Tối khẩn: Nguy cơ thanh lý / báo cáo Viện trưởng)
 * - Mốc 0 ngày (Quá hạn: Kích hoạt quy trình thanh lý hợp đồng & thông báo các bên)
 */

const db = require('../db/db');
const config = require('../config/config');
const { parseDate, formatDateVN, evaluateStatus } = require('./projectService');
const { DEMO_PROFILES } = require('../config/roles');
const { logActivity } = require('./activityLogService');

class SchedulerService {
  constructor() {
    this.intervalId = null;
    this.initialTimeoutId = null;
    this.alignTimeoutId = null;
    this.isScanning = false;
    this.lastScanAt = null;
    this.lastScanStats = null;
    this.nextRunAt = null;
    this.scheduleConfig = {
      enabled: config.SCHEDULER_ENABLED,
      intervalHours: config.SCHEDULER_INTERVAL_HOURS,
      runAtHour: config.SCHEDULER_RUN_AT_HOUR,
      initialDelayMs: config.SCHEDULER_INITIAL_DELAY_MS
    };
  }

  _clearTimers() {
    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
      this.initialTimeoutId = null;
    }
    if (this.alignTimeoutId) {
      clearTimeout(this.alignTimeoutId);
      this.alignTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  _scheduleRecurring() {
    const intervalMs = Math.max(1, Number(this.scheduleConfig.intervalHours) || 24) * 60 * 60 * 1000;
    const runAtHour = Number(this.scheduleConfig.runAtHour);

    if (!this.scheduleConfig.enabled) {
      this.nextRunAt = null;
      console.log('⏸️ [Scheduler] Tiến trình quét hạn tự động đang tạm tắt.');
      return;
    }

    if (!Number.isNaN(runAtHour) && runAtHour >= 0 && runAtHour <= 23) {
      const now = new Date();
      const nextTarget = new Date(now);
      nextTarget.setHours(runAtHour, 0, 0, 0);
      if (nextTarget.getTime() <= now.getTime()) {
        nextTarget.setDate(nextTarget.getDate() + 1);
      }
      const delayMs = nextTarget.getTime() - now.getTime();
      this.nextRunAt = nextTarget.toISOString();

      console.log(
        `⏰ [Scheduler] Đã lên lịch quét hạn lúc ${String(runAtHour).padStart(2, '0')}:00 (chu kỳ mỗi ${this.scheduleConfig.intervalHours}h). Lần kế tiếp: ${nextTarget.toLocaleString('vi-VN')}`
      );

      this.alignTimeoutId = setTimeout(() => {
        this.scanAndSendDeadlineAlerts('SCHEDULED').catch(err => console.error('Lỗi quét hạn theo lịch:', err));
        this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
        this.intervalId = setInterval(() => {
          this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
          this.scanAndSendDeadlineAlerts('SCHEDULED').catch(err => console.error('Lỗi quét hạn định kỳ:', err));
        }, intervalMs);
      }, delayMs);
    } else {
      this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
      console.log(`⏰ [Scheduler] Đã lên lịch quét hạn theo chu kỳ mỗi ${this.scheduleConfig.intervalHours} giờ.`);
      this.intervalId = setInterval(() => {
        this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
        this.scanAndSendDeadlineAlerts('SCHEDULED').catch(err => console.error('Lỗi quét hạn định kỳ:', err));
      }, intervalMs);
    }
  }

  // Khởi động tiến trình quét tự động theo chu kỳ cấu hình
  startDailyScheduler() {
    this._clearTimers();
    if (!this.scheduleConfig.enabled) {
      console.log('⏸️ [Scheduler] SCHEDULER_ENABLED=false, bỏ qua khởi động tự động.');
      return;
    }

    console.log('⏰ [Scheduler] Khởi động Tiến trình Tự động Quét hạn Đề tài (Mốc 30 - 15 - 7 - 0 ngày)');

    const initialDelay = Math.max(1000, Number(this.scheduleConfig.initialDelayMs) || 15000);
    this.initialTimeoutId = setTimeout(() => {
      this.scanAndSendDeadlineAlerts('STARTUP').catch(err => console.error('Lỗi quét hạn lần đầu:', err));
    }, initialDelay);

    this._scheduleRecurring();
  }

  stopScheduler() {
    this._clearTimers();
    this.nextRunAt = null;
  }

  getStatus() {
    return {
      isScanning: this.isScanning,
      lastScanAt: this.lastScanAt,
      nextRunAt: this.nextRunAt,
      lastScanStats: this.lastScanStats,
      config: { ...this.scheduleConfig }
    };
  }

  updateSchedule({ enabled, intervalHours, runAtHour } = {}) {
    if (enabled !== undefined) {
      this.scheduleConfig.enabled = Boolean(enabled);
    }
    if (intervalHours !== undefined && !Number.isNaN(Number(intervalHours)) && Number(intervalHours) >= 1) {
      this.scheduleConfig.intervalHours = Number(intervalHours);
    }
    if (runAtHour !== undefined && !Number.isNaN(Number(runAtHour))) {
      const h = Number(runAtHour);
      if (h >= -1 && h <= 23) {
        this.scheduleConfig.runAtHour = h;
      }
    }

    this._clearTimers();
    this._scheduleRecurring();
    return this.getStatus();
  }

  // Kiểm tra xem đã gửi email mốc này cho đề tài này trong vòng N ngày qua chưa (Chống spam)
  async hasAlertBeenSentRecently(projectId, eventType, daysWindow = 5) {
    try {
      const row = await db.get(`
        SELECT id, sent_at FROM nckh_email_logs 
        WHERE related_project_id = ? AND event_type = ?
          AND datetime(sent_at) >= datetime('now', '-${daysWindow} days')
        LIMIT 1
      `, [projectId, eventType]);
      return !!row;
    } catch (err) {
      return false;
    }
  }

  // Ghi nhật ký email thông báo
  async logEmail({ eventType, recipientEmail, recipientName, recipientRole, subject, bodyHtml, relatedProjectId }) {
    try {
      await db.run(`
        INSERT INTO nckh_email_logs (
          event_type, recipient_email, recipient_name, recipient_role,
          subject, body_html, related_project_id, action_url, sent_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SENT')
      `, [
        eventType,
        recipientEmail,
        recipientName,
        recipientRole,
        subject,
        bodyHtml,
        relatedProjectId,
        `/chi-tiet.html?id=${relatedProjectId}`
      ]);
      return true;
    } catch (err) {
      console.error('Lỗi ghi nhật ký email nhắc hạn:', err);
      return false;
    }
  }

  // Hàm quét chính: Kiểm tra tất cả đề tài và phát email theo các mốc 30, 15, 7, 0 ngày
  async scanAndSendDeadlineAlerts(triggerSource = 'MANUAL') {
    if (this.isScanning) {
      console.log('⏳ [Scheduler] Tiến trình quét hạn đang chạy, bỏ qua lần gọi trùng.');
      return { skipped: true };
    }

    this.isScanning = true;
    console.log(`🔍 [Scheduler] Bắt đầu quét thời hạn đề tài cấp Viện (Nguồn: ${triggerSource})...`);

    const stats = {
      scanned_count: 0,
      alerts_30d: 0,
      alerts_15d: 0,
      alerts_7d: 0,
      alerts_overdue: 0,
      total_emails_sent: 0,
      timestamp: new Date().toISOString()
    };

    try {
      // 1. Lấy danh sách đề tài đang thực hiện (chưa hoàn thành, chưa hủy)
      const projects = await db.all(`
        SELECT p.*, 
          COALESCE(p.current_end_date, p.base_end_date) as effective_end_date
        FROM nckh_projects p
        WHERE UPPER(COALESCE(p.status, 'IN_PROGRESS')) NOT IN ('COMPLETED', 'CANCELLED')
          AND (p.final_evaluation IS NULL OR p.final_evaluation NOT LIKE '%nghiệm thu%')
      `);

      stats.scanned_count = projects.length;
      const now = new Date();
      const msPerDay = 24 * 60 * 60 * 1000;

      // Danh bạ cố định các phòng ban liên quan
      const directorProfile = DEMO_PROFILES.find(p => p.role === 'VIEN_TRUONG') || { fullname: 'PGS.TS. Phạm Văn Phúc', email: 'director@sci.edu.vn' };
      const khcnProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_KHCN') || { fullname: 'Phòng Khoa học & Công nghệ', email: 'khcn@sci.edu.vn' };
      const financeProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_TC_CU') || { fullname: 'Phòng Tài chính - Cung ứng', email: 'finance@sci.edu.vn' };
      const tchcProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_TCHC') || { fullname: 'Phòng Tổ chức - Hành chính', email: 'tchc@sci.edu.vn' };
      const storageProfile = DEMO_PROFILES.find(p => p.role === 'THU_KHO') || { fullname: 'Thủ kho Vật tư - Hóa chất', email: 'thukho@sci.edu.vn' };

      for (const p of projects) {
        if (!p.effective_end_date) continue;
        const endDate = parseDate(p.effective_end_date);
        if (!endDate) continue;

        const daysRemaining = Math.ceil((endDate.getTime() - now.getTime()) / msPerDay);
        const pCode = p.code;
        const pTitle = p.title;
        const pLeader = p.leader_name || 'Chủ nhiệm đề tài';
        const pGroup = p.research_group || 'SCI';
        const pEndDateVN = formatDateVN(endDate);
        const pBudget = Number(p.budget_total || 0).toLocaleString('vi-VN') + ' đ';
        const leaderEmail = `${pLeader.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]/g, '.')}@sci.edu.vn`;

        // -------------------------------------------------------------
        // MỐC 1: TRƯỚC HẠN 30 NGÀY (26 <= daysRemaining <= 30)
        // -------------------------------------------------------------
        if (daysRemaining >= 26 && daysRemaining <= 30) {
          const alreadySent = await this.hasAlertBeenSentRecently(p.id, 'DEADLINE_ALERT_30D', 10);
          if (!alreadySent) {
            const subject = `[E-Office SCI] [Nhắc việc lần 1] Đề tài ${pCode} còn 30 ngày đến hạn kết thúc hợp đồng (${pEndDateVN})`;
            const bodyHtml = `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155; max-width: 650px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="background: #0284c7; color: white; padding: 18px 20px;">
                  <span style="background: #fef08a; color: #854d0e; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px;">CẢNH BÁO THỜI HẠN: CÒN 30 NGÀY</span>
                  <h3 style="margin: 6px 0 0 0; color: white; font-size: 17px;">Thông báo Thời hạn Hợp đồng & Nhắc việc Nghiệm thu / Gia hạn</h3>
                </div>
                <div style="padding: 20px;">
                  <p>Kính gửi <strong>${pLeader}</strong> (${pGroup}),</p>
                  <p>Hệ thống Quản lý Đề tài Cấp Viện thông báo: Đề tài <strong>${pCode}</strong> do Quý Thầy/Cô làm Chủ nhiệm sẽ kết thúc thời hạn thực hiện theo hợp đồng vào ngày <strong>${pEndDateVN}</strong> (còn <strong>${daysRemaining} ngày</strong>).</p>
                  
                  <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 12px; margin: 15px 0;">
                    <div style="font-weight: 700; color: #0f172a; margin-bottom: 6px;">📋 3 NỘI DUNG NHẮC VIỆC TRỌNG TÂM CẦN THỰC HIỆN:</div>
                    <ol style="margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.7;">
                      <li><strong>Trường hợp 1 (Đã hoàn thành nghiên cứu):</strong> Đề nghị Chủ nhiệm khẩn trương hoàn thiện Báo cáo tổng kết, Báo cáo tóm tắt và minh chứng sản phẩm KHCN để nộp hồ sơ xin nghiệm thu trước ngày hết hạn.</li>
                      <li><strong>Trường hợp 2 (Cần xin gia hạn):</strong> Theo quy chế quản lý KHCN, nếu chưa hoàn thành các nội dung chuyên môn, Chủ nhiệm <strong>phải nộp Đơn xin gia hạn trực tuyến trước ngày thứ 15</strong> (Gia hạn tối đa 6 tháng/lần).</li>
                      <li><strong>Cảnh báo chế tài bắt buộc:</strong> Nếu đến ngày hết hạn mà đề tài không có Quyết định gia hạn và không nộp hồ sơ nghiệm thu, hệ thống sẽ <strong>kích hoạt Quy trình Thanh lý Hợp đồng và Chấm dứt nhiệm vụ</strong> theo quy định tài chính của Viện.</li>
                    </ol>
                  </div>

                  <div style="text-align: center; margin: 20px 0;">
                    <a href="http://localhost:3005/chi-tiet.html?id=${p.id}&action=extension" style="background: #0284c7; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 13px; display: inline-block;">
                      Truy cập Hồ sơ Đề tài để Nộp Nghiệm thu / Xin gia hạn →
                    </a>
                  </div>
                  <div style="font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                    Email gửi tự động đến: Chủ nhiệm đề tài (${leaderEmail}) & Đồng gửi Phòng KHCN (khcn@sci.edu.vn).
                  </div>
                </div>
              </div>
            `;

            // Gửi Chủ nhiệm & Phòng KHCN
            await this.logEmail({ eventType: 'DEADLINE_ALERT_30D', recipientEmail: leaderEmail, recipientName: pLeader, recipientRole: 'CHU_NHIEM', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_ALERT_30D', recipientEmail: khcnProfile.email, recipientName: khcnProfile.fullname, recipientRole: 'PHONG_KHCN', subject, bodyHtml, relatedProjectId: p.id });
            stats.alerts_30d++;
            stats.total_emails_sent += 2;
          }
        }

        // -------------------------------------------------------------
        // MỐC 2: TRƯỚC HẠN 15 NGÀY (12 <= daysRemaining <= 15)
        // -------------------------------------------------------------
        else if (daysRemaining >= 12 && daysRemaining <= 15) {
          const alreadySent = await this.hasAlertBeenSentRecently(p.id, 'DEADLINE_ALERT_15D', 8);
          if (!alreadySent) {
            const subject = `[KHẨN] Đề tài ${pCode} còn 15 ngày hết hạn (${pEndDateVN}) - Hạn chót nộp đơn gia hạn hợp đồng`;
            const bodyHtml = `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155; max-width: 650px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="background: #d97706; color: white; padding: 18px 20px;">
                  <span style="background: #fee2e2; color: #b91c1c; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px;">CẢNH BÁO KHẨN CẤP: CÒN 15 NGÀY</span>
                  <h3 style="margin: 6px 0 0 0; color: white; font-size: 17px;">Thông báo Đóng cổng Xin gia hạn & Yêu cầu Báo cáo Tiến độ</h3>
                </div>
                <div style="padding: 20px;">
                  <p>Kính gửi <strong>${pLeader}</strong> và <strong>Trưởng nhóm nghiên cứu ${pGroup}</strong>,</p>
                  <p>Hệ thống cảnh báo khẩn: Đề tài <strong>${pCode}</strong> chỉ còn <strong>${daysRemaining} ngày</strong> là hết hạn hợp đồng NCKH (${pEndDateVN}).</p>
                  
                  <div style="background: #fffbeb; border-left: 4px solid #d97706; padding: 12px; margin: 15px 0; font-size: 13px;">
                    <strong>LƯU Ý QUAN TRỌNG:</strong> Theo quy định, thủ tục xin gia hạn hợp đồng sẽ <strong>chính thức đóng trước ngày hết hạn 15 ngày</strong> để Phòng KHCN thẩm tra và trình Viện trưởng ký Quyết định. Sau thời hạn này, hệ thống sẽ khóa chức năng xin gia hạn và chuyển sang chuẩn bị nghiệm thu hoặc thanh lý.
                  </div>

                  <p style="font-size: 13px;">Đề nghị Quý Thầy/Cô khẩn trương liên hệ Phòng KHCN hoặc truy cập hệ thống để thực hiện ngay:</p>
                  <div style="text-align: center; margin: 20px 0;">
                    <a href="http://localhost:3005/chi-tiet.html?id=${p.id}" style="background: #d97706; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 13px; display: inline-block;">
                      Vào Hồ sơ Đề tài để Xử lý Khẩn cấp →
                    </a>
                  </div>
                </div>
              </div>
            `;

            // Gửi Chủ nhiệm & Phòng KHCN
            await this.logEmail({ eventType: 'DEADLINE_ALERT_15D', recipientEmail: leaderEmail, recipientName: pLeader, recipientRole: 'CHU_NHIEM', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_ALERT_15D', recipientEmail: khcnProfile.email, recipientName: khcnProfile.fullname, recipientRole: 'PHONG_KHCN', subject, bodyHtml, relatedProjectId: p.id });
            stats.alerts_15d++;
            stats.total_emails_sent += 2;
          }
        }

        // -------------------------------------------------------------
        // MỐC 3: TRƯỚC HẠN 7 NGÀY (5 <= daysRemaining <= 7)
        // -------------------------------------------------------------
        else if (daysRemaining >= 5 && daysRemaining <= 7) {
          const alreadySent = await this.hasAlertBeenSentRecently(p.id, 'DEADLINE_ALERT_7D', 4);
          if (!alreadySent) {
            const subject = `[TỐI KHẨN] Đề tài ${pCode} còn 7 ngày hết hạn (${pEndDateVN}) - Nguy cơ Chấm dứt & Thanh lý`;
            const bodyHtml = `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155; max-width: 650px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="background: #b91c1c; color: white; padding: 18px 20px;">
                  <span style="background: #ffffff; color: #b91c1c; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px;">BÁO ĐỘNG ĐỎ: CÒN 7 NGÀY</span>
                  <h3 style="margin: 6px 0 0 0; color: white; font-size: 17px;">Cảnh báo Chế tài: Chuẩn bị kích hoạt Thanh lý Hợp đồng</h3>
                </div>
                <div style="padding: 20px;">
                  <p>Kính gửi <strong>${pLeader}</strong>,</p>
                  <p>Đồng kính gửi: <strong>Viện trưởng (${directorProfile.fullname})</strong>, <strong>Phòng KHCN</strong> và <strong>Phòng Tài chính - Cung ứng</strong>,</p>
                  
                  <p>Đề tài <strong>${pCode}</strong> (Kinh phí: ${pBudget}) chỉ còn <strong>${daysRemaining} ngày</strong> là chính thức hết hạn (${pEndDateVN}). Hiện tại đề tài vẫn chưa hoàn tất hồ sơ nghiệm thu và chưa có Quyết định gia hạn hợp đồng.</p>

                  <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 12px; margin: 15px 0; font-size: 13px; color: #991b1b;">
                    <strong>THÔNG BÁO CHẾ TÀI:</strong> Vào ngày <strong>${pEndDateVN}</strong>, nếu không có hồ sơ nghiệm thu hợp lệ được nộp, hệ thống sẽ tự động khóa toàn bộ quyền của đề tài và chuyển hồ sơ sang <strong>Hội đồng Thanh lý & Thu hồi kinh phí</strong>.
                  </div>

                  <div style="text-align: center; margin: 20px 0;">
                    <a href="http://localhost:3005/chi-tiet.html?id=${p.id}" style="background: #b91c1c; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 13px; display: inline-block;">
                      Mở Hồ sơ Đề tài để Nộp Khẩn cấp →
                    </a>
                  </div>
                </div>
              </div>
            `;

            // Gửi Chủ nhiệm, Viện trưởng, Phòng KHCN, Phòng TC-CU
            await this.logEmail({ eventType: 'DEADLINE_ALERT_7D', recipientEmail: leaderEmail, recipientName: pLeader, recipientRole: 'CHU_NHIEM', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_ALERT_7D', recipientEmail: directorProfile.email, recipientName: directorProfile.fullname, recipientRole: 'VIEN_TRUONG', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_ALERT_7D', recipientEmail: khcnProfile.email, recipientName: khcnProfile.fullname, recipientRole: 'PHONG_KHCN', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_ALERT_7D', recipientEmail: financeProfile.email, recipientName: financeProfile.fullname, recipientRole: 'PHONG_TC_CU', subject, bodyHtml, relatedProjectId: p.id });
            stats.alerts_7d++;
            stats.total_emails_sent += 4;
          }
        }

        // -------------------------------------------------------------
        // MỐC 4: NGÀY HẾT HẠN / QUÁ HẠN (daysRemaining <= 0) -> THANH LÝ
        // -------------------------------------------------------------
        else if (daysRemaining <= 0) {
          const alreadySent = await this.hasAlertBeenSentRecently(p.id, 'DEADLINE_OVERDUE_LIQUIDATION', 15);
          if (!alreadySent) {
            const overdueDays = Math.abs(daysRemaining);
            const subject = `[CHÍNH THỨC] Đề tài ${pCode} đã HẾT HẠN (${pEndDateVN}) - Kích hoạt Quy trình Thanh lý Nhiệm vụ`;
            const bodyHtml = `
              <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155; max-width: 650px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
                <div style="background: #1e293b; color: white; padding: 18px 20px;">
                  <span style="background: #ef4444; color: white; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px;">ĐÃ HẾT HẠN - KÍCH HOẠT THANH LÝ</span>
                  <h3 style="margin: 6px 0 0 0; color: white; font-size: 17px;">Thông báo Hết hiệu lực Hợp đồng NCKH & Chuyển Quy trình Thanh lý</h3>
                </div>
                <div style="padding: 20px;">
                  <p>Kính gửi <strong>Ban Lãnh đạo Viện</strong>, <strong>Phòng KHCN</strong>, <strong>Phòng Tài chính - Cung ứng</strong> và <strong>Chủ nhiệm đề tài ${pLeader}</strong>,</p>
                  <p>Hệ thống Quản lý Đề tài thông báo: Đề tài <strong>${pCode}</strong> đã chính thức quá hạn hợp đồng ${overdueDays > 0 ? `<strong>${overdueDays} ngày</strong>` : 'hôm nay'} (Ngày hết hạn: ${pEndDateVN}).</p>

                  <div style="background: #f1f5f9; border-left: 4px solid #475569; padding: 12px; margin: 15px 0; font-size: 13px;">
                    <strong>QUY TRÌNH THANH LÝ ĐƯỢC KÍCH HOẠT:</strong>
                    <ul style="margin: 6px 0 0 0; padding-left: 18px; line-height: 1.7;">
                      <li>Khóa các quyền xuất kho hóa chất và tạm ứng kinh phí của đề tài.</li>
                      <li>Phòng TC-Cung ứng tiến hành rà soát quyết toán chứng từ và thu hồi kinh phí chưa chi.</li>
                      <li>Thủ kho kiểm kê và thu hồi vật tư, hóa chất còn tồn tại phòng thí nghiệm.</li>
                      <li>Phòng KHCN tham mưu Hội đồng xử lý chấm dứt hợp đồng trình Viện trưởng ký Quyết định thanh lý.</li>
                    </ul>
                  </div>

                  <div style="text-align: center; margin: 20px 0;">
                    <a href="http://localhost:3005/chi-tiet.html?id=${p.id}&tab=tab-audit" style="background: #1e293b; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: 700; font-size: 13px; display: inline-block;">
                      Truy cập Hồ sơ Thanh tra & Xuất Gói Kiểm toán (Audit Packet) →
                    </a>
                  </div>
                  <div style="font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                    Thông báo chính thức được lưu trữ vĩnh viễn trong Hồ sơ điện tử phục vụ công tác Thanh tra - Kiểm toán Nhà nước.
                  </div>
                </div>
              </div>
            `;

            // Gửi đồng thời cho 6 bên trong ma trận phân quyền
            await this.logEmail({ eventType: 'DEADLINE_OVERDUE_LIQUIDATION', recipientEmail: leaderEmail, recipientName: pLeader, recipientRole: 'CHU_NHIEM', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_OVERDUE_LIQUIDATION', recipientEmail: directorProfile.email, recipientName: directorProfile.fullname, recipientRole: 'VIEN_TRUONG', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_OVERDUE_LIQUIDATION', recipientEmail: khcnProfile.email, recipientName: khcnProfile.fullname, recipientRole: 'PHONG_KHCN', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_OVERDUE_LIQUIDATION', recipientEmail: financeProfile.email, recipientName: financeProfile.fullname, recipientRole: 'PHONG_TC_CU', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_OVERDUE_LIQUIDATION', recipientEmail: tchcProfile.email, recipientName: tchcProfile.fullname, recipientRole: 'PHONG_TCHC', subject, bodyHtml, relatedProjectId: p.id });
            await this.logEmail({ eventType: 'DEADLINE_OVERDUE_LIQUIDATION', recipientEmail: storageProfile.email, recipientName: storageProfile.fullname, recipientRole: 'THU_KHO', subject, bodyHtml, relatedProjectId: p.id });

            stats.alerts_overdue++;
            stats.total_emails_sent += 6;
          }
        }
      }

      console.log(`✅ [Scheduler] Hoàn tất quét hạn: Đã quét ${stats.scanned_count} đề tài | Phát ${stats.total_emails_sent} email cảnh báo (30D: ${stats.alerts_30d}, 15D: ${stats.alerts_15d}, 7D: ${stats.alerts_7d}, Quá hạn: ${stats.alerts_overdue})`);

      this.lastScanAt = stats.timestamp;
      this.lastScanStats = { ...stats, triggerSource };

      if (stats.total_emails_sent > 0 || triggerSource === 'MANUAL') {
        await logActivity({
          actorName: triggerSource === 'MANUAL' ? 'Cán bộ vận hành' : 'Hệ thống Tự động',
          actorRole: 'SYSTEM',
          action: 'DEADLINE_SCAN',
          entityType: 'SYSTEM',
          summary: `Quét hạn đề tài (${triggerSource}): ${stats.scanned_count} đề tài, phát ${stats.total_emails_sent} email cảnh báo (30N:${stats.alerts_30d}, 15N:${stats.alerts_15d}, 7N:${stats.alerts_7d}, Quá hạn:${stats.alerts_overdue}).`,
          details: stats
        });
      }
    } catch (err) {
      console.error('Lỗi trong tiến trình quét hạn:', err);
    } finally {
      this.isScanning = false;
    }

    return stats;
  }
}

module.exports = new SchedulerService();
