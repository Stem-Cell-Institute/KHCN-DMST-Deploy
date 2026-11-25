/**
 * Khởi tạo SMTP transporter và toàn bộ helper gửi email thông báo (Hội đồng, CRD, Cấp Viện, Hồ sơ, Đặt lại mật khẩu, Phân quyền).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const nodemailer = require('nodemailer');
const db = require('../lib/db-bridge');

module.exports = function createEmailServices({ PORT, emailsWithAnyRole }) {
  let transporter = null;
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }

  /** From gửi SMTP: có tên hiển thị (tránh Gmail hiện chỉ local-part như ntsinh0409). SMTP_FROM có thể: địa chỉ email; "Tên" <email>; hoặc chỉ tên (không có @) → dùng cùng SMTP_USER làm địa chỉ. SMTP_FROM_NAME: tên mặc định khi SMTP_FROM là email thuần. */
  function getSmtpFrom() {
    const raw = (process.env.SMTP_FROM || '').trim();
    const user = (process.env.SMTP_USER || '').trim();
    if (raw.includes('<') && raw.includes('>')) {
      return raw;
    }
    // Chỉ tên hiển thị, ví dụ STIMS SCI — gửi từ địa chỉ SMTP_USER
    if (raw && !raw.includes('@')) {
      if (!user) return undefined;
      return { name: raw, address: user };
    }
    const address = (raw.includes('@') ? raw : user) || '';
    if (!address) return undefined;
    const name = (process.env.SMTP_FROM_NAME || 'Hệ thống quản lí KHCN&ĐMST SCI').trim();
    if (!name) return address;
    return { name, address };
  }

  function getCouncilEmails() {
    return emailsWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']);
  }

  /** Email của mọi user có role Phòng KHCN — dùng làm người nhận (TO) khi nộp hồ sơ mới, và CC khi thông báo kết quả duyệt (Đề tài cấp Viện). */
  function getPhongKhcnEmails() {
    return emailsWithAnyRole(['phong_khcn']);
  }

  function getBudgetTeamEmails() {
    return emailsWithAnyRole(['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  }

  function getChairmanEmail() {
    const emails = emailsWithAnyRole(['chu_tich']);
    return emails.length ? emails[0] : null;
  }

  const CHAIRMAN_EMAIL_CONTROL_KEY = 'chairman_email_controls';
  const CHAIRMAN_EMAIL_CONTROL_DEFAULTS = {
    ngoai_vien_step2_to_chairman: true,
    cap_vien_new_submission: true,
    cap_vien_step2_revision_notice: true,
    cap_vien_step2_validated_notice: true,
    cap_vien_supplement_submitted_notice: true,
    cap_vien_step3_assign_notice: true,
    cap_vien_step4a_budget_cc_notice: true,
    cap_vien_step5_ready_notice: true,
    cap_vien_step5_secretary_revision_notice: true,
    cap_vien_step5_revision_uploaded_notice: true,
    cap_vien_step5_chair_request_more_notice: true,
    cap_vien_step5_chair_approved_notice: true,
    cap_vien_step5_council_passed_notice: true,
    cap_vien_step6_completed_notice: true,
    cap_vien_step7_completed_notice: true
  };

  const COUNCIL_MEMBER_EMAIL_CONTROL_KEY = 'council_member_email_controls';
  const COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS = {
    generic_council_notice: true,
    cap_vien_new_submission: true,
    cap_vien_step2_revision_notice: true,
    cap_vien_step2_validated_notice: true,
    cap_vien_supplement_submitted_notice: true,
    cap_vien_step3_assign_notice: true,
    cap_vien_step4a_budget_cc_notice: true,
    cap_vien_step5_ready_notice: true,
    cap_vien_step5_secretary_revision_notice: true,
    cap_vien_step5_revision_uploaded_notice: true,
    cap_vien_step5_chair_request_more_notice: true,
    cap_vien_step5_chair_approved_notice: true,
    cap_vien_step5_council_passed_notice: true,
    cap_vien_step6_completed_notice: true,
    cap_vien_step7_completed_notice: true
  };

  function getChairmanEmailControls() {
    let parsed = {};
    try {
      const row = db.prepare('SELECT value FROM cooperation_settings WHERE key = ?').get(CHAIRMAN_EMAIL_CONTROL_KEY);
      if (row && row.value) {
        const j = JSON.parse(String(row.value || '{}'));
        if (j && typeof j === 'object') parsed = j;
      }
    } catch (e) { /* ignore parse / table errors */ }
    return Object.assign({}, CHAIRMAN_EMAIL_CONTROL_DEFAULTS, parsed);
  }

  function isChairmanEmailEnabled(notificationKey) {
    if (!notificationKey) return true;
    const controls = getChairmanEmailControls();
    const v = controls[notificationKey];
    if (v === undefined) return true;
    return !!v;
  }

  function getCouncilMemberEmailControls() {
    let parsed = {};
    try {
      const row = db.prepare('SELECT value FROM cooperation_settings WHERE key = ?').get(COUNCIL_MEMBER_EMAIL_CONTROL_KEY);
      if (row && row.value) {
        const j = JSON.parse(String(row.value || '{}'));
        if (j && typeof j === 'object') parsed = j;
      }
    } catch (e) { /* ignore parse / table errors */ }
    return Object.assign({}, COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS, parsed);
  }

  function isCouncilMemberEmailEnabled(notificationKey) {
    const key = notificationKey || 'generic_council_notice';
    const controls = getCouncilMemberEmailControls();
    const v = controls[key];
    if (v === undefined) return true;
    return !!v;
  }

  function getCouncilMemberEmailsExcludeChair() {
    try {
      return emailsWithAnyRole(['thu_ky', 'thanh_vien'])
        .map((e) => String(e || '').trim().toLowerCase())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function applyCouncilMemberControlToRecipients(emails, notificationKey) {
    const normalized = (emails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return [];
    if (isCouncilMemberEmailEnabled(notificationKey)) return Array.from(new Set(normalized));
    const memberEmails = new Set(getCouncilMemberEmailsExcludeChair());
    if (memberEmails.size === 0) return Array.from(new Set(normalized));
    return Array.from(new Set(normalized.filter(e => !memberEmails.has(e))));
  }

  function applyChairmanControlToRecipients(emails, notificationKey) {
    const normalized = (emails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return [];
    if (isChairmanEmailEnabled(notificationKey)) return Array.from(new Set(normalized));
    const chairmanEmail = (getChairmanEmail() || '').trim().toLowerCase();
    if (!chairmanEmail) return Array.from(new Set(normalized));
    return Array.from(new Set(normalized.filter(e => e !== chairmanEmail)));
  }

  function computeNhanhFromLevel(level) {
    const lev = (level || '').toLowerCase();
    if (['ministry', 'university', 'school'].includes(lev)) return 'A';
    if (['national'].includes(lev)) return 'B';
    return 'B';
  }

  // Danh sách email nhận thông báo: ưu tiên bảng notification_recipients (Admin quản lý), không có thì NOTIFICATION_EMAILS, rồi Hội đồng trong DB
  function getNotificationEmails(notificationKey) {
    const resolvedKey = notificationKey || 'generic_council_notice';
    let baseList = [];
    try {
      const rows = db.prepare('SELECT email FROM notification_recipients ORDER BY id').all();
      if (rows && rows.length > 0) {
        baseList = rows.map(r => (r.email || '').trim().toLowerCase()).filter(Boolean);
        return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
      }
    } catch (e) { /* bảng chưa có */ }
    const envList = (process.env.NOTIFICATION_EMAILS || '').trim();
    if (envList) {
      baseList = envList.split(/[,;]/).map(e => e.trim().toLowerCase()).filter(Boolean);
      return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
    }
    baseList = getCouncilEmails();
    return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
  }

  function sendNotificationToCouncil(submissionTitle, submittedByEmail) {
    const toList = getNotificationEmails();
    if (!transporter || toList.length === 0) {
      if (!transporter) console.log('[Email] Bỏ qua: chưa cấu hình SMTP (kiểm tra file .env có SMTP_HOST, SMTP_USER)');
      else console.log('[Email] Bỏ qua: chưa có người nhận (thêm trong Quản trị → Danh sách người nhận email)');
      return Promise.resolve();
    }
    console.log('[Email] Gửi thông báo hồ sơ mới tới: ' + toList.join(', '));
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject: '[SCI-ACE] Hồ sơ mới được nộp: ' + submissionTitle,
      text: 'Nghiên cứu viên ' + submittedByEmail + ' vừa nộp hồ sơ: ' + submissionTitle + '. Vui lòng đăng nhập vào khu vực Hội đồng để xem và tải hồ sơ.',
      html: '<p>Nghiên cứu viên <strong>' + submittedByEmail + '</strong> vừa nộp hồ sơ: <strong>' + submissionTitle + '</strong>.</p><p>Vui lòng đăng nhập vào <a href="' + (process.env.BASE_URL || 'http://localhost:' + PORT) + '/hoi-dong.html">khu vực Hội đồng</a> để xem và tải hồ sơ.</p>'
    }).catch(err => console.error('[Email] Lỗi gửi:', err.message));
  }

  /** Thông báo tới Hội đồng khi NCV nộp lại hồ sơ sau khi Thư ký yêu cầu bổ sung (GĐ3). */
  function sendResubmitEmail(submissionTitle, submittedByEmail) {
    const toList = getNotificationEmails();
    if (!transporter || toList.length === 0) return Promise.resolve();
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject: '[SCI-ACE] Hồ sơ đã nộp lại sau bổ sung: ' + submissionTitle,
      text: 'Nghiên cứu viên ' + submittedByEmail + ' đã nộp lại hồ sơ (sau khi được yêu cầu bổ sung): ' + submissionTitle + '. Vui lòng đăng nhập vào khu vực Hội đồng để kiểm tra lại.',
      html: '<p>Nghiên cứu viên <strong>' + submittedByEmail + '</strong> đã <strong>nộp lại</strong> hồ sơ (sau khi được yêu cầu bổ sung): <strong>' + submissionTitle + '</strong>.</p><p>Vui lòng đăng nhập vào <a href="' + (process.env.BASE_URL || 'http://localhost:' + PORT) + '/hoi-dong.html">khu vực Hội đồng</a> để kiểm tra lại.</p>'
    }).catch(err => console.error('[Email] Lỗi gửi:', err.message));
  }

  /** Gửi email thông báo tin nhắn mới trên kênh chung CRD cho người đã bật thông báo */
  function crdSendBroadcastEmailNotification(senderPersonId, message, ts) {
    if (!transporter) {
      console.log('[CRD broadcast] Bỏ qua email: chưa cấu hình SMTP');
      return Promise.resolve();
    }
    const sender = db.prepare('SELECT name, email FROM crd_persons WHERE id = ?').get(senderPersonId);
    if (!sender) return Promise.resolve();
    const senderName = sender.name || sender.email || 'Người dùng CRD';
    const senderEmail = sender.email || '';

    // Lấy user_id của người gửi để tránh notify chính mình
    const senderRow = db.prepare('SELECT user_id FROM crd_persons WHERE id = ?').get(senderPersonId);
    const senderUserId = senderRow && senderRow.user_id != null ? Number(senderRow.user_id) : null;

    // Lấy danh sách user có crd_email_notif = 1 và không phải chính mình
    let query;
    let params;
    if (senderUserId) {
      query = 'SELECT u.email, u.fullname, p.id AS person_id FROM users u JOIN crd_persons p ON p.user_id = u.id WHERE u.crd_email_notif = 1 AND u.is_disabled = 0 AND u.id != ?';
      params = [senderUserId];
    } else {
      query = 'SELECT u.email, u.fullname, p.id AS person_id FROM users u JOIN crd_persons p ON p.user_id = u.id WHERE u.crd_email_notif = 1 AND u.is_disabled = 0';
      params = [];
    }
    const recipients = db.prepare(query).all(...params);
    if (!recipients.length) {
      console.log('[CRD broadcast] Không có người nhận email thông báo');
      return Promise.resolve();
    }

    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const chatUrl = baseUrl + '/crd-booking-v2.html';
    const preview = message.length > 120 ? message.substring(0, 120) + '…' : message;
    const dateStr = new Date(ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    const subject = '[SCI-ACE CRD] Tin nhắn mới trên Kênh chung — ' + (new Date(ts)).toLocaleDateString('vi-VN');

    const htmlParts = recipients.map(r => {
      const name = r.fullname || r.email || 'bạn';
      return '<li style="margin-bottom:4px;"><a href="mailto:' + r.email + '">' + name + '</a> &lt;' + r.email + '&gt;</li>';
    }).join('');

    const html = `
<p>Xin chào,</p>
<p><strong>${senderName}</strong> vừa gửi một tin nhắn mới trên <strong>Kênh chung CRD</strong>:</p>
<blockquote style="border-left:4px solid #667eea;margin:12px 0;padding:8px 16px;background:#f8f9ff;color:#333;">
  <em>${preview.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</em>
</blockquote>
<p><strong>Người gửi:</strong> ${senderName}${senderEmail ? ' (' + senderEmail + ')' : ''}<br>
<strong>Thời gian:</strong> ${dateStr}</p>
<p>Vui lòng đăng nhập vào <a href="${chatUrl}">Khu vực CRD</a> để xem toàn bộ tin nhắn và phản hồi.</p>
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">
<p style="font-size:12px;color:#888;">
  Bạn nhận được email này vì đã bật thông báo CRD trong cài đặt tài khoản.<br>
  Để tắt thông báo, vui lòng liên hệ quản trị hoặc cập nhật trong <strong>Quản trị → Người dùng → Tài khoản Hệ thống</strong>.
</p>`;

    return transporter.sendMail({
      from: getSmtpFrom(),
      to: recipients.map(r => r.email).join(', '),
      subject,
      html
    }).then(() => {
      console.log('[CRD broadcast] Đã gửi email thông báo tới ' + recipients.length + ' người');
    }).catch(err => {
      console.error('[CRD broadcast email] Lỗi:', err.message);
    });
  }

  // Helper: thông tin bước hiện tại / sắp tới / người duyệt theo status (Đề tài cấp Viện)
  function getCapVienStepInfo(status) {
    const s = (status || 'SUBMITTED').toUpperCase();
    const map = {
      SUBMITTED: { current: 'Bước 1: Nộp hồ sơ đề xuất (đã hoàn thành)', next: 'Bước 2: Kiểm tra hồ sơ hành chính', who: 'Thư ký HĐKHCN' },
      NEED_REVISION: { current: 'Bước 2: Kiểm tra hồ sơ hành chính (đang chờ hồ sơ bổ sung)', next: 'Bước 2: Kiểm tra hồ sơ hành chính', who: 'Thư ký HĐKHCN' },
      VALIDATED: { current: 'Bước 2: Kiểm tra hồ sơ hành chính (đã hoàn thành)', next: 'Bước 3: Phân công phản biện', who: 'Chủ tịch HĐKHCN' },
      ASSIGNED: { current: 'Bước 3: Phân công phản biện (đã hoàn thành)', next: 'Bước 4: Đánh giá phản biện', who: '2 Phản biện' },
      UNDER_REVIEW: { current: 'Bước 4: Đánh giá phản biện (đang thực hiện)', next: 'Bước 4: Đánh giá phản biện', who: '2 Phản biện' },
      REVIEWED: { current: 'Bước 4: Đánh giá phản biện (đã hoàn thành)', next: 'Bước 5: Họp Hội đồng Khoa học Viện', who: 'HĐKHCN' },
      IN_MEETING: { current: 'Bước 5: Họp Hội đồng (đang thực hiện)', next: 'Bước 5: Họp Hội đồng', who: 'HĐKHCN' },
      CONDITIONAL: { current: 'Bước 5: Họp Hội đồng (đã họp)', next: 'Bước 6: Cấp Quyết định phê duyệt', who: 'Viện trưởng' },
      APPROVED: { current: 'Bước 6: Cấp Quyết định phê duyệt (đã hoàn thành)', next: 'Bước 7: Ký hợp đồng thực hiện', who: 'Viện trưởng & Chủ nhiệm' },
      CONTRACTED: { current: 'Bước 7: Ký hợp đồng (đã hoàn thành)', next: 'Bước tiếp theo theo quy định', who: '—' },
      IMPLEMENTATION: { current: 'Đang thực hiện đề tài', next: 'Báo cáo tiến độ / Nghiệm thu', who: '—' },
      COMPLETED: { current: 'Đã hoàn thành', next: '—', who: '—' },
      REJECTED: { current: 'Đã dừng/từ chối', next: '—', who: '—' }
    };
    return map[s] || map.SUBMITTED;
  }

  // Đề tài cấp Viện: gửi thông báo khi có hồ sơ mới nộp
  function sendCapVienNewSubmissionEmail(opts) {
    const { submissionId, submissionTitle, submittedByEmail, submittedByName, createdAt, status } = opts;
    // Ưu tiên gửi thẳng tới Phòng KHCN (người xử lý Bước 2); nếu chưa cấu hình role phong_khcn thì fallback về danh sách thông báo cũ.
    let toList = getPhongKhcnEmails();
    if (!toList.length) toList = getNotificationEmails('cap_vien_new_submission');
    if (!transporter || toList.length === 0) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
    const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'Nghiên cứu viên');
    const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
    const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : '—';

    const subject = '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ mới được nộp: ' + (submissionTitle || '');
    const text =
      'Kính gửi Phòng Khoa học và Công nghệ,\n\n' +
      'Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc có ghi nhận hồ sơ mới đăng kí đề tài cấp Viện TBG do ' + submitterLabel + ' nộp.\n\n' +
      'Thông tin đề tài:\n- Tên đề tài: ' + (submissionTitle || '') + '\n- Người nộp: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- Ngày nộp: ' + dateStr + '\n\n' +
      'Khu vực Hội đồng (theo dõi và tải hồ sơ): ' + councilUrl + '\n\n' +
      'Hiện tại: ' + stepInfo.current + '\n' +
      'Sắp tới: ' + stepInfo.next + '\n' +
      'Chờ duyệt bởi: ' + stepInfo.who + '\n\n' +
      'Trân trọng.';

    const html =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Phòng Khoa học và Công nghệ,</p>' +
      '<p>Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc có ghi nhận hồ sơ mới đăng kí đề tài cấp Viện TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> nộp.</p>' +
      '<p><strong>Thông tin đề tài:</strong></p>' +
      '<ul style="margin:0.5em 0">' +
      '<li>Tên đề tài: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
      '<li>Người nộp: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
      '<li>Ngày nộp: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
      '</ul>' +
      '<p>Khu vực Hội đồng để theo dõi và tải hồ sơ:</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
      '<p><strong>Hiện tại:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Sắp tới:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Chờ duyệt bởi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
      '<p>Trân trọng.</p>' +
      '</div>';

    console.log('[Email] Gửi thông báo Đề tài cấp Viện (hồ sơ mới) tới: ' + toList.join(', '));
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject,
      text,
      html
    }).catch(err => console.error('[Email] Lỗi gửi (Đề tài cấp Viện):', err.message));
  }

  // Đề tài cấp Viện — Bước 2: Yêu cầu bổ sung — gửi nghiên cứu viên (chính) + thông báo Hội đồng (phụ)
  function sendCapVienStep2RevisionEmail(submissionTitle, researcherEmail, note, secretaryName, submissionId, researcherName) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const resubmitUrl = baseUrl + '/nop-de-tai-cap-vien.html?resubmit=' + (submissionId || '');
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
    const researcherLabel = (researcherName && researcherName.trim()) ? researcherName.trim() : (researcherEmail || 'Nghiên cứu viên');
    const secLabel = (secretaryName && secretaryName.trim()) ? secretaryName.trim() : 'Thư ký HĐKHCN';
    const noteEsc = String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const noteBlock = note ? '<p><strong>Nội dung yêu cầu bổ sung:</strong></p><p style="white-space:pre-wrap;background:#fff8e1;padding:12px;border-radius:8px">' + noteEsc + '</p>' : '';

    const promises = [];
    if (!transporter) return Promise.all(promises);

    // Email chính: nghiên cứu viên — yêu cầu bổ sung hồ sơ
    if (researcherEmail) {
      const subjectRes = '[Đề tài cấp Viện Tế bào gốc]: Yêu cầu bổ sung hồ sơ (Bước 2): ' + (submissionTitle || '');
      const textRes =
        'Kính gửi ' + researcherLabel + ',\n\n' +
        'Thư ký HĐKHCN đã kiểm tra hồ sơ đề tài cấp Viện của bạn và yêu cầu bổ sung.\n\n' +
        'Nội dung yêu cầu bổ sung:\n' + (note || '') + '\n\n' +
        'Thông tin đề tài: ' + (submissionTitle || '') + '\n\n' +
        'Bạn cần chỉnh sửa và bổ sung hồ sơ theo nội dung trên, sau đó nộp lại hồ sơ qua hệ thống.\n\n' +
        'Nộp lại hồ sơ: ' + resubmitUrl + '\nTheo dõi đề tài: ' + timelineUrl + '\n\n' +
        'Trân trọng,\nHệ thống Quản lý Đề tài cấp Viện';
      const htmlRes =
        '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
        '<p>Kính gửi <strong>' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
        '<p>Thư ký HĐKHCN đã kiểm tra hồ sơ đề tài cấp Viện của bạn và yêu cầu bổ sung.</p>' +
        noteBlock +
        '<p><strong>Thông tin đề tài:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
        '<p>Bạn cần chỉnh sửa và bổ sung hồ sơ theo nội dung trên, sau đó <strong>nộp lại hồ sơ</strong> qua hệ thống.</p>' +
        '<p><a href="' + resubmitUrl + '" style="color:#1565c0">Nộp lại hồ sơ</a> &nbsp;|&nbsp; <a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi đề tài</a></p>' +
        '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: researcherEmail,
        subject: subjectRes,
        text: textRes,
        html: htmlRes
      }).catch(err => console.error('[Email] Lỗi gửi (Yêu cầu bổ sung → NCV):', err.message)));
    }

    // Email phụ: thành viên Hội đồng — thông báo để nắm thông tin
    const councilList = getNotificationEmails('cap_vien_step2_revision_notice');
    if (councilList.length > 0) {
      const subjectCouncil = '[Đề tài cấp Viện Tế bào gốc] (Thông báo) Thư ký đã yêu cầu bổ sung hồ sơ: ' + (submissionTitle || '');
      const textCouncil =
        'Thông báo để các thành viên Hội đồng nắm thông tin:\n\n' +
        'Thư ký ' + secLabel + ' đã yêu cầu bổ sung hồ sơ cho đề tài «' + (submissionTitle || '') + '», do nghiên cứu viên ' + (researcherLabel + ' (' + (researcherEmail || '') + ')') + ' nộp.\n\n' +
        'Nội dung yêu cầu bổ sung:\n' + (note || '') + '\n\n' +
        'Theo dõi đề tài: ' + timelineUrl;
      const htmlCouncil =
        '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
        '<p><strong>Thông báo để các thành viên Hội đồng nắm thông tin</strong></p>' +
        '<p>Thư ký <strong>' + (secLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã yêu cầu bổ sung hồ sơ cho đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>, do nghiên cứu viên ' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(researcherEmail || '').replace(/</g, '&lt;')) + ') nộp.</p>' +
        noteBlock +
        '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi đề tài cấp Viện</a></p></div>';
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: subjectCouncil,
        text: textCouncil,
        html: htmlCouncil
      }).catch(err => console.error('[Email] Lỗi gửi (Yêu cầu bổ sung → HĐ):', err.message)));
    }
    return Promise.all(promises);
  }

  // Đề tài cấp Viện — Bước 2 đã Hợp lệ: gửi thông báo (1) nghiên cứu viên, (2) thành viên Hội đồng
  function sendCapVienStep2ValidatedEmail(opts) {
    const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, reviewedByName, hasSupplement } = opts;
    if (!transporter) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
    const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'Nghiên cứu viên');
    const stepInfo = getCapVienStepInfo(status || 'VALIDATED');
    const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : '—';
    const reviewedLabel = (reviewedByName && reviewedByName.trim()) ? reviewedByName.trim() : 'Thư ký HĐKHCN';
    const supplementPhrase = hasSupplement ? ' sau khi nghiên cứu viên bổ sung hồ sơ' : '';

    const promises = [];

    // (1) Email chính: Nghiên cứu viên — thông báo hồ sơ đã hợp lệ, chuyển Bước 3
    if (submittedByEmail) {
      const subjectRes = hasSupplement
        ? '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ bổ sung của bạn đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '')
        : '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ của bạn đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '');
      const textRes =
        'Kính gửi ' + submitterLabel + ',\n\n' +
        'Thư ký HĐKHCN đã kiểm tra hồ sơ đề tài cấp Viện của bạn' + (hasSupplement ? ' (bao gồm hồ sơ bổ sung)' : '') + ' và đánh dấu Hợp lệ' + supplementPhrase + ' (Bước 2 – Kiểm tra hồ sơ hành chính).\n\n' +
        'Hồ sơ chuyển sang Bước 3 (Phân công phản biện).\n\n' +
        'Thông tin đề tài: ' + (submissionTitle || '') + '\nNgày nộp: ' + dateStr + '\n\n' +
        'Theo dõi đề tài: ' + timelineUrl + '\n\n' +
        'Trân trọng,\nHệ thống Quản lý Đề tài cấp Viện';
      const htmlRes =
        '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
        '<p>Kính gửi <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
        '<p>Thư ký HĐKHCN (' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ') đã kiểm tra hồ sơ đề tài cấp Viện của bạn' + (hasSupplement ? ' (bao gồm hồ sơ bổ sung)' : '') + ' và đánh dấu <strong>Hợp lệ' + (supplementPhrase.replace(/</g, '&lt;')) + '</strong> (Bước 2 – Kiểm tra hồ sơ hành chính).</p>' +
        '<p>Hồ sơ chuyển sang <strong>Bước 3: Phân công phản biện</strong>.</p>' +
        '<p><strong>Thông tin đề tài:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '<br>Ngày nộp: ' + (String(dateStr).replace(/</g, '&lt;')) + '</p>' +
        '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi đề tài cấp Viện</a></p>' +
        '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: submittedByEmail,
        subject: subjectRes,
        text: textRes,
        html: htmlRes
      }).catch(err => console.error('[Email] Lỗi gửi (Bước 2 Hợp lệ → NCV):', err.message)));
    }

    // (2) Email phụ: Thành viên Hội đồng — thông báo để nắm thông tin
    const toList = getNotificationEmails('cap_vien_step2_validated_notice');
    if (toList.length > 0) {
      const subjectCouncil = hasSupplement
        ? '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ bổ sung đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '')
        : '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ đã được kiểm tra hợp lệ (Bước 2): ' + (submissionTitle || '');
      const textCouncil =
        'Kính gửi Quý thành viên Hội đồng,\n\n' +
        'Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: hồ sơ đề tài cấp Viện TBG do ' + submitterLabel + ' nộp đã được ' + reviewedLabel + ' kiểm tra và đánh dấu Hợp lệ' + supplementPhrase + ' (Bước 2 – Kiểm tra hồ sơ hành chính).\n\n' +
        'Thông tin đề tài:\n- Tên đề tài: ' + (submissionTitle || '') + '\n- Người nộp: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- Ngày nộp: ' + dateStr + '\n\n' +
        'Khu vực Hội đồng (theo dõi và tải hồ sơ): ' + councilUrl + '\n\n' +
        'Hiện tại: ' + stepInfo.current + '\n' +
        'Sắp tới: ' + stepInfo.next + '\n' +
        'Chờ duyệt bởi: ' + stepInfo.who + '\n\n' +
        'Trân trọng.';
      const htmlCouncil =
        '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
        '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
        '<p>Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: hồ sơ đề tài cấp Viện TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> nộp đã được <strong>' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> kiểm tra và đánh dấu <strong>Hợp lệ' + (supplementPhrase.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> (Bước 2 – Kiểm tra hồ sơ hành chính).</p>' +
        '<p><strong>Thông tin đề tài:</strong></p>' +
        '<ul style="margin:0.5em 0">' +
        '<li>Tên đề tài: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
        '<li>Người nộp: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
        '<li>Ngày nộp: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
        '</ul>' +
        '<p>Khu vực Hội đồng để theo dõi và tải hồ sơ:</p>' +
        '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
        '<p><strong>Hiện tại:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
        '<strong>Sắp tới:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
        '<strong>Chờ duyệt bởi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
        '<p>Trân trọng.</p>' +
        '</div>';
      console.log('[Email] Gửi thông báo Đề tài cấp Viện (Bước 2 Hợp lệ) → NCV + HĐ: ' + (submittedByEmail || '') + ', ' + toList.join(', '));
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: toList.join(', '),
        subject: subjectCouncil,
        text: textCouncil,
        html: htmlCouncil
      }).catch(err => console.error('[Email] Lỗi gửi (Bước 2 Hợp lệ → HĐ):', err.message)));
    }
    return Promise.all(promises);
  }

  // Đề tài cấp Viện — Nghiên cứu viên đã nộp hồ sơ bổ sung: gửi thông báo đến các thành viên Hội đồng
  function sendCapVienSupplementSubmittedEmail(opts) {
    const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, supplementRound } = opts;
    const toList = getNotificationEmails('cap_vien_supplement_submitted_notice');
    if (!transporter || toList.length === 0) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
    const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'Nghiên cứu viên');
    const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
    const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : '—';
    const roundText = (supplementRound != null && supplementRound >= 1) ? ' (lần bổ sung thứ ' + supplementRound + ')' : '';

    const subject = '[Đề tài cấp Viện Tế bào gốc]: Nghiên cứu viên đã nộp hồ sơ bổ sung' + roundText + ': ' + (submissionTitle || '');
    const text =
      'Kính gửi Quý thành viên Hội đồng,\n\n' +
      'Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: nghiên cứu viên ' + submitterLabel + ' đã nộp hồ sơ bổ sung cho đề tài cấp Viện TBG' + roundText + '.\n\n' +
      'Thông tin đề tài:\n- Tên đề tài: ' + (submissionTitle || '') + '\n- Người nộp: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- Ngày nộp hồ sơ gốc: ' + dateStr + '\n\n' +
      'Khu vực Hội đồng (theo dõi và tải hồ sơ): ' + councilUrl + '\n\n' +
      'Hiện tại: ' + stepInfo.current + '\n' +
      'Sắp tới: ' + stepInfo.next + '\n' +
      'Chờ duyệt bởi: ' + stepInfo.who + '\n\n' +
      'Trân trọng.';

    const html =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
      '<p>Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc thông báo: nghiên cứu viên <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã nộp hồ sơ bổ sung cho đề tài cấp Viện TBG' + (roundText.replace(/</g, '&lt;')) + '.</p>' +
      '<p><strong>Thông tin đề tài:</strong></p>' +
      '<ul style="margin:0.5em 0">' +
      '<li>Tên đề tài: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
      '<li>Người nộp: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
      '<li>Ngày nộp hồ sơ gốc: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
      '</ul>' +
      '<p>Khu vực Hội đồng để theo dõi và tải hồ sơ:</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
      '<p><strong>Hiện tại:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Sắp tới:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Chờ duyệt bởi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
      '<p>Trân trọng.</p>' +
      '</div>';

    console.log('[Email] Gửi thông báo Đề tài cấp Viện (NCV đã nộp hồ sơ bổ sung) tới: ' + toList.join(', '));
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject,
      text,
      html
    }).catch(err => console.error('[Email] Lỗi gửi (NCV nộp bổ sung):', err.message));
  }

  // Đề tài cấp Viện — Bước 3: Chủ tịch phân công phản biện — gửi đến từng phản biện + toàn Hội đồng
  function sendCapVienStep3AssignEmail(submissionTitle, chairmanName, reviewerEmails, reviewerNames, submissionId) {
    if (!transporter) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
    const reviewersList = reviewerNames && reviewerNames.length ? reviewerNames.join(', ') : (reviewerEmails && reviewerEmails.length ? reviewerEmails.join(', ') : '');
    const htmlAll = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
      '<p>Chủ tịch HĐKHCN <strong>' + (chairmanName || 'Chủ tịch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> đã phân công phản biện cho hồ sơ: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
      '<p><strong>Phản biện được phân công:</strong> ' + (String(reviewersList).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
      '<p>Giai đoạn đã chuyển sang <strong>Bước 4 – Đánh giá phản biện</strong>. Các thành viên được phân công cần hoàn thành phiếu đánh giá (SCI-TASK-06).</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vực Hội đồng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const textAll = 'Chủ tịch đã phân công phản biện cho hồ sơ: ' + submissionTitle + '. Phản biện: ' + reviewersList + '. Giai đoạn chuyển sang Bước 4. ' + baseUrl;
    const promises = [];
    reviewerEmails.forEach((email, i) => {
      const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
      const htmlYou = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
        '<p>Kính gửi ' + (String(name || email).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ',</p>' +
        '<p>Chủ tịch HĐKHCN <strong>' + (chairmanName || 'Chủ tịch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> đã phân công <strong>bạn</strong> làm phản biện cho hồ sơ: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
        '<p>Bạn vui lòng đăng nhập và hoàn thành phiếu đánh giá (SCI-TASK-06) theo quy định.</p>' +
        '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vực Hội đồng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
        '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: email,
        subject: '[Đề tài cấp Viện Tế bào gốc]: Bạn được phân công phản biện: ' + submissionTitle,
        text: 'Bạn được phân công phản biện hồ sơ: ' + submissionTitle + '. ' + baseUrl,
        html: htmlYou
      }).catch(err => console.error('[Email] Lỗi gửi (phân công phản biện → PB):', err.message)));
    });
    const toList = getNotificationEmails('cap_vien_step3_assign_notice');
    if (toList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: toList.join(', '),
        subject: '[Đề tài cấp Viện Tế bào gốc]: Chủ tịch đã phân công phản biện (Bước 3): ' + submissionTitle,
        text: textAll,
        html: htmlAll
      }).catch(err => console.error('[Email] Lỗi gửi (phân công phản biện → HĐ):', err.message)));
    }
    return Promise.all(promises);
  }

  // Bước 3→4: Ngay sau khi Chủ tịch phân công phản biện — gửi Tổ thẩm định tài chính (to), CC Hội đồng khoa học
  function sendCapVienStep4aNotifyBudgetTeamEmail(opts) {
    const { submissionTitle, submissionId } = opts;
    if (!transporter) return Promise.resolve();
    const budgetTeamEmails = getBudgetTeamEmails();
    const councilList = getNotificationEmails('cap_vien_step4a_budget_cc_notice');
    if (!budgetTeamEmails || budgetTeamEmails.length === 0) {
      console.log('[Email] Bỏ qua gửi Tổ thẩm định: chưa có thành viên Tổ thẩm định tài chính trong hệ thống.');
      return Promise.resolve();
    }
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Thông báo thẩm định dự toán (Bước 4A) — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Tổ thẩm định tài chính,</p>' +
      '<p>Hệ thống Quản lý KHCN&ĐMST Viện Tế bào gốc trân trọng thông báo: Đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã hoàn thành Bước 3 (Phân công phản biện) và chuyển sang Bước 4.</p>' +
      '<p>Đề nghị Tổ thẩm định tài chính thực hiện thẩm định dự toán theo quy định và nộp phiếu thẩm định (SCI-BUDGET-01, SCI-BUDGET-02) đúng hạn.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình đề tài</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Thông báo thẩm định dự toán: ' + submissionTitle + '. Đề nghị Tổ thẩm định thực hiện thẩm định theo quy định và nộp đúng hạn. ' + timelineUrl;
    const promises = [];
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: budgetTeamEmails.join(', '),
      cc: councilList && councilList.length > 0 ? councilList.join(', ') : undefined,
      subject,
      text,
      html
    }).catch(err => console.error('[Email] Lỗi gửi (thông báo Tổ thẩm định 4A):', err.message)));
    return Promise.all(promises);
  }

  // Bước 4A: Tổ thẩm định yêu cầu bổ sung — gửi Chủ nhiệm (to), CC Hội đồng
  function sendCapVienBudgetRevisionRequestEmail(opts) {
    const { submissionTitle, researcherEmail, researcherName, note, requestedByName, submissionId, councilList } = opts;
    if (!transporter) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Tổ thẩm định yêu cầu bổ sung/chỉnh sửa dự toán — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Chủ nhiệm đề tài,</p>' +
      '<p>Tổ thẩm định tài chính đã xem xét dự toán của đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> và yêu cầu bổ sung/chỉnh sửa như sau:</p>' +
      '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + (String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
      '<p><strong>Người yêu cầu:</strong> ' + (String(requestedByName || '').replace(/</g, '&lt;')) + '</p>' +
      '<p>Quý Chủ nhiệm vui lòng đăng nhập hệ thống, truy cập trang theo dõi tiến trình và nộp lại tài liệu tài chính đã chỉnh sửa (Phiếu thẩm định SCI-BUDGET-01 và Tờ trình SCI-BUDGET-02).</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình đề tài</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Tổ thẩm định yêu cầu bổ sung dự toán: ' + submissionTitle + '\n\nNội dung: ' + (note || '') + '\n\n' + timelineUrl;
    const promises = [];
    if (researcherEmail) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
        .catch(err => console.error('[Email] Lỗi gửi (yêu cầu bổ sung dự toán → NCV):', err.message)));
    }
    if (councilList && councilList.length > 0) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC] ' + subject, text, html })
        .catch(err => console.error('[Email] Lỗi gửi (yêu cầu bổ sung dự toán → HĐ):', err.message)));
    }
    return Promise.all(promises);
  }

  // Bước 4A: NCV nộp tài liệu chỉnh sửa — thông báo Hội đồng
  function sendCapVienBudgetRevisedSubmittedEmail(opts) {
    const { submissionTitle, researcherName, submissionId, councilList } = opts;
    if (!transporter || !councilList || councilList.length === 0) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Chủ nhiệm đã nộp tài liệu tài chính chỉnh sửa — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
      '<p>Chủ nhiệm đề tài <strong>' + (String(researcherName || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã nộp tài liệu tài chính đã chỉnh sửa cho đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
      '<p>Tổ thẩm định tài chính sẽ kiểm tra và phê duyệt hoặc yêu cầu bổ sung tiếp.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Chủ nhiệm đã nộp tài liệu tài chính chỉnh sửa: ' + submissionTitle + '. ' + timelineUrl;
    return transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] Lỗi gửi (NCV nộp chỉnh sửa dự toán):', err.message));
  }

  // Bước 4A: Tổ thẩm định phê duyệt — gửi Chủ nhiệm + Hội đồng
  function sendCapVienBudgetApprovedEmail(opts) {
    const { submissionTitle, researcherEmail, researcherName, approvedByName, submissionId, councilList } = opts;
    if (!transporter) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Dự toán đã được thẩm định xong — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
      '<p>Tổ thẩm định tài chính đã phê duyệt dự toán cho đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
      '<p><strong>Người phê duyệt:</strong> ' + (String(approvedByName || '').replace(/</g, '&lt;')) + '</p>' +
      '<p>Lưu ý: Bước 4 (Đánh giá phản biện) và Bước 4A (Thẩm định dự toán) thực hiện song song. Đề tài sẽ chuyển sang Bước 5 (Họp Hội đồng) khi cả hai bước đều hoàn thành.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Dự toán đã được thẩm định xong: ' + submissionTitle + '. ' + timelineUrl;
    const promises = [];
    if (researcherEmail) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
        .catch(err => console.error('[Email] Lỗi gửi (phê duyệt dự toán → NCV):', err.message)));
    }
    if (councilList && councilList.length > 0) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
        .catch(err => console.error('[Email] Lỗi gửi (phê duyệt dự toán → HĐ):', err.message)));
    }
    return Promise.all(promises);
  }

  // Bước 4 & 4A đều hoàn thành → chuyển Bước 5 — thông báo Hội đồng (văn phong trang trọng)
  function sendCapVienStep5ReadyEmail(opts) {
    const { submissionTitle, submissionId } = opts;
    if (!transporter) return Promise.resolve();
    const councilList = getNotificationEmails('cap_vien_step5_ready_notice');
    if (!councilList || councilList.length === 0) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Đề tài đã sẵn sàng Họp Hội đồng (Bước 5) — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý thành viên Hội đồng Khoa học và Công nghệ Viện Tế bào gốc,</p>' +
      '<p>Hệ thống Quản lý KHCN&ĐMST trân trọng thông báo: Đề tài <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> đã hoàn thành Bước 4 (Đánh giá phản biện) và Bước 4A (Thẩm định dự toán).</p>' +
      '<p>Đề tài hiện đã sẵn sàng chuyển sang <strong>Bước 5 – Họp Hội đồng Khoa học Viện</strong> để xem xét và biểu quyết.</p>' +
      '<p>Kính mong Quý Hội đồng sắp xếp thời gian và tham dự phiên họp theo quy định.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình đề tài</a></p>' +
      '<p>Trân trọng kính chào,<br>Hệ thống Quản lý Đề tài cấp Viện – Viện Tế bào gốc</p></div>';
    const text = 'Đề tài đã sẵn sàng Họp Hội đồng (Bước 5): ' + submissionTitle + '. ' + timelineUrl;
    return transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] Lỗi gửi (chuyển Bước 5):', err.message));
  }

  /** Link chi tiết tiến trình đề tài cấp Viện — Bước 5 */
  function capVienStep5DetailUrl(submissionId) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    return baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  }
  function capVienEmailEsc(s) {
    return String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Thư ký HĐ: yêu cầu Chủ nhiệm chỉnh sửa theo góp ý (Bước 5)
  function sendCapVienStep5SecretaryRevisionRequestEmail(opts) {
    const { submissionTitle, submissionId, round, note, requestedByName, researcherEmail, councilList } = opts;
    if (!transporter) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const t = capVienEmailEsc(submissionTitle);
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Yêu cầu chỉnh sửa hồ sơ (vòng ' + round + ') — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý Chủ nhiệm / Quý Hội đồng,</p>' +
      '<p><strong>Bước 5 — Họp Hội đồng KHCN:</strong> Đề tài <strong>' + t + '</strong> — Thư ký Hội đồng đã gửi <strong>yêu cầu chỉnh sửa</strong> theo góp ý Hội đồng <strong>(vòng ' + round + ')</strong>.</p>' +
      '<p><strong>Nội dung yêu cầu:</strong></p>' +
      '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + capVienEmailEsc(note) + '</p>' +
      '<p><strong>Người gửi yêu cầu:</strong> ' + capVienEmailEsc(requestedByName) + '</p>' +
      '<p><strong>Việc tiếp theo:</strong> <strong>Chủ nhiệm đề tài</strong> đăng nhập hệ thống, mở tiến trình và <strong>nộp hồ sơ chỉnh sửa</strong>. <strong>Chủ tịch HĐKHCN</strong> cùng các thành viên liên quan theo dõi cập nhật trên hệ thống.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình (Bước 5)</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Bước 5 — Yêu cầu chỉnh sửa (vòng ' + round + '): ' + submissionTitle + '\n\n' + (note || '') + '\n\n' + timelineUrl;
    const promises = [];
    if (researcherEmail) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
        .catch(err => console.error('[Email] Bước 5 yêu cầu chỉnh sửa → CN:', err.message)));
    }
    if (councilList && councilList.length > 0) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC Hội đồng] ' + subject, text, html })
        .catch(err => console.error('[Email] Bước 5 yêu cầu chỉnh sửa → HĐ:', err.message)));
    }
    return Promise.all(promises);
  }

  // Chủ nhiệm đã nộp hồ sơ chỉnh sửa — chờ Chủ tịch xem xét
  function sendCapVienStep5RevisionUploadedEmail(opts) {
    const { submissionTitle, submissionId, round, fileCount, uploaderName, councilList, researcherEmail } = opts;
    if (!transporter || !councilList || councilList.length === 0) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const t = capVienEmailEsc(submissionTitle);
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Chủ nhiệm đã nộp hồ sơ chỉnh sửa (vòng ' + round + ') — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý Chủ tịch / Thư ký / Thành viên Hội đồng,</p>' +
      '<p><strong>' + capVienEmailEsc(uploaderName) + '</strong> đã nộp <strong>' + fileCount + '</strong> tệp hồ sơ chỉnh sửa cho đề tài <strong>' + t + '</strong> <strong>(vòng ' + round + ')</strong>.</p>' +
      '<p><strong>Việc tiếp theo:</strong> <strong>Chủ tịch HĐKHCN</strong> xem xét trên hệ thống: <strong>thông qua bản chỉnh sửa</strong> hoặc <strong>yêu cầu chỉnh sửa tiếp</strong>.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Mở tiến trình Bước 5</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Bước 5 — Đã nộp hồ sơ chỉnh sửa (vòng ' + round + '): ' + submissionTitle + '. ' + timelineUrl;
    const re = (researcherEmail || '').trim().toLowerCase();
    const researcherInCouncil = re && councilList.some(e => (e || '').trim().toLowerCase() === re);
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: councilList.join(', '),
      cc: (researcherEmail && !researcherInCouncil) ? researcherEmail : undefined,
      subject,
      text,
      html
    }).catch(err => console.error('[Email] Bước 5 nộp chỉnh sửa → HĐ:', err.message));
  }

  // Chủ tịch HĐ: yêu cầu chỉnh sửa tiếp
  function sendCapVienStep5ChairRequestMoreEmail(opts) {
    const { submissionTitle, submissionId, round, note, chairName, researcherEmail, councilList } = opts;
    if (!transporter) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const t = capVienEmailEsc(submissionTitle);
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Yêu cầu chỉnh sửa tiếp (vòng ' + round + ') — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>Kính gửi Quý Chủ nhiệm / Quý Hội đồng,</p>' +
      '<p><strong>Chủ tịch HĐKHCN</strong> (' + capVienEmailEsc(chairName) + ') đã <strong>yêu cầu chỉnh sửa tiếp</strong> đối với đề tài <strong>' + t + '</strong> <strong>(vòng ' + round + ')</strong>.</p>' +
      '<p><strong>Nội dung góp ý:</strong></p>' +
      '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + capVienEmailEsc(note) + '</p>' +
      '<p><strong>Việc tiếp theo:</strong> <strong>Chủ nhiệm đề tài</strong> cập nhật hồ sơ theo góp ý và <strong>nộp lại</strong> trên hệ thống.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình Bước 5</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Bước 5 — Yêu cầu chỉnh sửa tiếp (vòng ' + round + '): ' + submissionTitle + '\n\n' + (note || '') + '\n\n' + timelineUrl;
    const promises = [];
    if (researcherEmail) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
        .catch(err => console.error('[Email] Bước 5 chỉnh sửa tiếp → CN:', err.message)));
    }
    if (councilList && councilList.length > 0) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC Hội đồng] ' + subject, text, html })
        .catch(err => console.error('[Email] Bước 5 chỉnh sửa tiếp → HĐ:', err.message)));
    }
    return Promise.all(promises);
  }

  // Chủ tịch HĐ: thông qua bản chỉnh sửa (kết thúc vòng)
  function sendCapVienStep5ChairApprovedRevisionEmail(opts) {
    const { submissionTitle, submissionId, round, chairName, researcherEmail, researcherName, councilList } = opts;
    if (!transporter) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const t = capVienEmailEsc(submissionTitle);
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Đã thông qua bản chỉnh sửa (vòng ' + round + ') — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p><strong>Bước 5 — Họp Hội đồng KHCN:</strong> Đề tài <strong>' + t + '</strong> — <strong>Chủ tịch HĐKHCN</strong> (' + capVienEmailEsc(chairName) + ') đã <strong>thông qua bản chỉnh sửa</strong> <strong>(vòng ' + round + ')</strong>.</p>' +
      '<p><strong>Việc tiếp theo:</strong> Thư ký Hội đồng có thể tiếp tục các thao tác Bước 5 trên hệ thống (cập nhật thông tin họp, biên bản, ghi nhận <strong>Hội đồng KHCN thông qua</strong> chuyển Bước 6 khi đủ điều kiện).</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Bước 5 — Thông qua bản chỉnh sửa (vòng ' + round + '): ' + submissionTitle + '. ' + timelineUrl;
    const promises = [];
    if (researcherEmail) {
      const htmlCn = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
        '<p>Kính gửi ' + capVienEmailEsc(researcherName || 'Quý Chủ nhiệm') + ',</p>' +
        '<p>Bản chỉnh sửa hồ sơ đề tài <strong>' + t + '</strong> <strong>(vòng ' + round + ')</strong> đã được <strong>Chủ tịch HĐKHCN</strong> thông qua.</p>' +
        '<p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>' +
        '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text: text + '\n(Thông báo tới Chủ nhiệm)', html: htmlCn })
        .catch(err => console.error('[Email] Bước 5 thông qua chỉnh sửa → CN:', err.message)));
    }
    if (councilList && councilList.length > 0) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
        .catch(err => console.error('[Email] Bước 5 thông qua chỉnh sửa → HĐ:', err.message)));
    }
    return Promise.all(promises);
  }

  // Ghi nhận Hội đồng KHCN thông qua → chuyển Bước 6
  function sendCapVienStep5CouncilPassedEmail(opts) {
    const { submissionTitle, submissionId, researcherEmail, researcherName, councilList, recordedByName } = opts;
    if (!transporter) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const t = capVienEmailEsc(submissionTitle);
    const subject = '[Đề tài cấp Viện Tế bào gốc]: Bước 5 hoàn tất — Chuyển Bước 6 (Cấp Quyết định) — ' + (submissionTitle || '');
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p><strong>Hội đồng KHCN thông qua</strong> đối với đề tài <strong>' + t + '</strong> đã được ghi nhận trên hệ thống' + (recordedByName ? ' (bởi ' + capVienEmailEsc(recordedByName) + ')' : '') + '.</p>' +
      '<p>Hồ sơ chuyển sang <strong>Bước 6 — Cấp Quyết định phê duyệt</strong>. Kính mời các đồng chí có trách nhiệm theo dõi và thực hiện bước tiếp theo.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình đề tài</a></p>' +
      '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const text = 'Bước 5 hoàn tất — chuyển Bước 6: ' + submissionTitle + '. ' + timelineUrl;
    const promises = [];
    if (researcherEmail) {
      const htmlCn = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
        '<p>Kính gửi ' + capVienEmailEsc(researcherName || 'Quý Chủ nhiệm') + ',</p>' +
        '<p>Đề tài <strong>' + t + '</strong> đã được <strong>ghi nhận Hội đồng KHCN thông qua</strong> và chuyển sang <strong>Bước 6</strong>.</p>' +
        '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình</a></p>' +
        '<p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html: htmlCn })
        .catch(err => console.error('[Email] Bước 5 thông qua HĐ → CN:', err.message)));
    }
    if (councilList && councilList.length > 0) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
        .catch(err => console.error('[Email] Bước 5 thông qua HĐ → HĐ:', err.message)));
    }
    return Promise.all(promises);
  }

  /** Bước 6 hoàn thành — email trịnh trọng: TO Chủ nhiệm, CC thành viên nhận thông báo HĐ (notification_recipients / HĐ trong DB) */
  function sendCapVienStep6CompletedEmail(opts) {
    const { submissionTitle, submissionId, researcherEmail, researcherName, soQd, councilList } = opts;
    if (!transporter) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const t = capVienEmailEsc(submissionTitle);
    const sq = capVienEmailEsc(soQd || '—');
    const subject = 'THÔNG BÁO HÀNH CHÍNH — Đề tài cấp Viện Tế bào gốc: Hoàn thành Bước 6 (Cấp Quyết định phê duyệt) — ' + (submissionTitle || '');
    const wrapOpen = '<div style="font-family:\'Times New Roman\',Times,Georgia,serif;font-size:15px;max-width:680px;line-height:1.6;color:#1a1a1a">';
    const wrapClose = '</div>';
    const htmlBody =
      '<p style="margin:0 0 14px 0;text-align:justify">Căn cứ quy trình quản lý nhiệm vụ khoa học và công nghệ cấp Viện; Hệ thống quản lý đề tài xin <strong>trân trọng thông báo</strong> để Quý đồng chí biết, chủ động triển khai các việc tiếp theo theo thẩm quyền:</p>' +
      '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top;width:36%"><strong>Nội dung thông báo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top">' +
      'Đã <strong>hoàn thành Bước 6 — Cấp Quyết định phê duyệt đề tài</strong> trên hệ thống điện tử.' +
      '</td></tr><tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Tên đề tài</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">' + t + '</td></tr>' +
      '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Số / ký hiệu Quyết định</strong><br><span style="font-size:12px;color:#546e7a">(đã ghi nhận)</span></td><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>' + sq + '</strong></td></tr>' +
      '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Hồ sơ đính kèm</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">Bản Quyết định <strong>tiếng Việt</strong> và <strong>tiếng Anh</strong> (bản scan) đã được lưu trong hồ sơ điện tử; Quý đồng chí đăng nhập hệ thống để tra cứu, tải về khi cần.</td></tr>' +
      '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Việc tiếp theo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">Chuyển sang <strong>Bước 7 — Ký hợp đồng thực hiện</strong>. Đề nghị <strong>Chủ nhiệm</strong> phối hợp chặt chẽ với <strong>Phòng Khoa học và Công nghệ</strong> và các bộ phận liên quan để chuẩn bị, rà soát và tiến hành ký kết hợp đồng đúng tiến độ; <strong>Hội đồng KHCN Viện</strong> tiếp tục theo dõi, phối hợp khi cần thiết.</td></tr></table>' +
      '<p style="margin:14px 0 8px 0"><strong>Đường link theo dõi tiến trình:</strong> <a href="' + timelineUrl + '" style="color:#0d47a1">' + timelineUrl + '</a></p>' +
      '<p style="margin:16px 0 0 0;text-align:justify;font-size:13px;color:#455a64"><em>Văn bản được gửi tự động từ Hệ thống Quản lý Đề tài cấp Viện nhằm phục vụ công tác hành chính và lưu vết trao đổi.</em></p>' +
      '<p style="margin:20px 0 0 0"><strong>Trân trọng thông báo.</strong></p>';
    const salutationCn = '<p style="margin:0 0 6px 0"><strong>Kính gửi Quý Chủ nhiệm' + (researcherName ? ' ' + capVienEmailEsc(researcherName) : '') + ',</strong></p>' +
      '<p style="margin:0 0 12px 0">cc Quý thầy cô thành viên Hội đồng Khoa học Viện.</p>';
    const salutationHdOnly = '<p style="margin:0 0 12px 0"><strong>Kính gửi Quý thầy cô thành viên Hội đồng Khoa học Viện,</strong></p>';
    const htmlForChuNhiem = wrapOpen + salutationCn + htmlBody + wrapClose;
    const htmlForHdOnly = wrapOpen + salutationHdOnly + htmlBody + wrapClose;
    const text =
      'THÔNG BÁO HÀNH CHÍNH — Hoàn thành Bước 6 (Cấp Quyết định phê duyệt).\n' +
      'Kính gửi Quý Chủ nhiệm' + (researcherName ? ' ' + String(researcherName).trim() : '') + ',\n' +
      'cc Quý thầy cô thành viên Hội đồng Khoa học Viện.\n\n' +
      'Đề tài: ' + (submissionTitle || '') + '\n' +
      'Số QĐ ghi nhận: ' + (soQd || '—') + '\n' +
      'Việc tiếp theo: Bước 7 — Ký hợp đồng thực hiện.\n' +
      'Xem tiến trình: ' + timelineUrl;

    const rEmail = String(researcherEmail || '').trim().toLowerCase();
    if (!rEmail) {
      console.warn('[Email] Bước 6 hoàn thành: không có email Chủ nhiệm, chỉ gửi Hội đồng nếu có.');
    }
    const ccRaw = (councilList || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    const ccList = [...new Set(ccRaw)].filter(e => e !== rEmail);
    const promises = [];
    if (rEmail) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: rEmail,
        cc: ccList.length ? ccList.join(', ') : undefined,
        subject,
        text,
        html: htmlForChuNhiem
      }).catch(err => console.error('[Email] Bước 6 hoàn thành → CN+CC:', err.message)));
    } else if (ccList.length > 0) {
      const textHd =
        'THÔNG BÁO HÀNH CHÍNH — Hoàn thành Bước 6 (Cấp Quyết định phê duyệt).\n' +
        'Kính gửi Quý thầy cô thành viên Hội đồng Khoa học Viện.\n\n' +
        'Đề tài: ' + (submissionTitle || '') + '\n' +
        'Số QĐ ghi nhận: ' + (soQd || '—') + '\n' +
        'Việc tiếp theo: Bước 7 — Ký hợp đồng thực hiện.\n' +
        'Xem tiến trình: ' + timelineUrl;
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: ccList.join(', '),
        subject,
        text: textHd + '\n\n(Không xác định được email Chủ nhiệm — chỉ gửi Hội đồng.)',
        html: '<p><em>(Không xác định được email Chủ nhiệm — gửi danh sách Hội đồng nhận TO.)</em></p>' + htmlForHdOnly
      }).catch(err => console.error('[Email] Bước 6 hoàn thành → HĐ only:', err.message)));
    }
    return Promise.all(promises);
  }

  function getCapVienStep7EmailOnComplete() {
    try {
      const row = db.prepare('SELECT value FROM cooperation_settings WHERE key = ?').get('cap_vien_step7_complete_send_email');
      if (!row || row.value == null || row.value === '') return true;
      const v = String(row.value).trim().toLowerCase();
      return v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
    } catch (e) {
      return true;
    }
  }

  /** Bước 7 hoàn thành — email hành chính (TO Chủ nhiệm, CC như Bước 6); có thể tắt trong Quản trị */
  function sendCapVienStep7CompletedEmail(opts) {
    const { submissionTitle, submissionId, researcherEmail, researcherName, councilList } = opts;
    if (!transporter) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const t = capVienEmailEsc(submissionTitle);
    const subject = 'THÔNG BÁO HÀNH CHÍNH — Đề tài cấp Viện Tế bào gốc: Hoàn thành Bước 7 (Ký hợp đồng KHCN) — ' + (submissionTitle || '');
    const wrapOpen = '<div style="font-family:\'Times New Roman\',Times,Georgia,serif;font-size:15px;max-width:680px;line-height:1.6;color:#1a1a1a">';
    const wrapClose = '</div>';
    const htmlBody =
      '<p style="margin:0 0 14px 0;text-align:justify">Căn cứ quy trình quản lý nhiệm vụ khoa học và công nghệ cấp Viện; Hệ thống quản lý đề tài xin <strong>trân trọng thông báo</strong> để Quý đồng chí biết, chủ động triển khai các việc tiếp theo theo thẩm quyền:</p>' +
      '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top;width:36%"><strong>Nội dung thông báo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top">' +
      'Đã <strong>hoàn thành Bước 7 — Ký hợp đồng thực hiện</strong> (ghi nhận trên hệ thống điện tử). <strong>Phòng Khoa học và Công nghệ</strong> đã lưu <strong>Hợp đồng KHCN</strong> (bản điện tử) vào hồ sơ.' +
      '</td></tr><tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Tên đề tài</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">' + t + '</td></tr>' +
      '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Hồ sơ đính kèm</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">Bản <strong>Hợp đồng KHCN</strong> đã được lưu trong hồ sơ điện tử; Quý đồng chí đăng nhập hệ thống để tra cứu, tải về khi cần.</td></tr>' +
      '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Việc tiếp theo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">Các bước tiếp theo theo quy trình (ví dụ <strong>Bước 8 — Đăng ký đạo đức</strong> và triển khai thực hiện). Đề nghị <strong>Chủ nhiệm</strong> và các đơn vị liên quan tiếp tục phối hợp với <strong>Phòng KHCN</strong>; <strong>Hội đồng KHCN Viện</strong> tiếp tục theo dõi khi cần.</td></tr></table>' +
      '<p style="margin:14px 0 8px 0"><strong>Đường link theo dõi tiến trình:</strong> <a href="' + timelineUrl + '" style="color:#0d47a1">' + timelineUrl + '</a></p>' +
      '<p style="margin:16px 0 0 0;text-align:justify;font-size:13px;color:#455a64"><em>Văn bản được gửi tự động từ Hệ thống Quản lý Đề tài cấp Viện nhằm phục vụ công tác hành chính và lưu vết trao đổi.</em></p>' +
      '<p style="margin:20px 0 0 0"><strong>Trân trọng thông báo.</strong></p>';
    const salutationCn = '<p style="margin:0 0 6px 0"><strong>Kính gửi Quý Chủ nhiệm' + (researcherName ? ' ' + capVienEmailEsc(researcherName) : '') + ',</strong></p>' +
      '<p style="margin:0 0 12px 0">cc Quý thầy cô thành viên Hội đồng Khoa học Viện.</p>';
    const salutationHdOnly = '<p style="margin:0 0 12px 0"><strong>Kính gửi Quý thầy cô thành viên Hội đồng Khoa học Viện,</strong></p>';
    const htmlForChuNhiem = wrapOpen + salutationCn + htmlBody + wrapClose;
    const htmlForHdOnly = wrapOpen + salutationHdOnly + htmlBody + wrapClose;
    const text =
      'THÔNG BÁO HÀNH CHÍNH — Hoàn thành Bước 7 (Ký hợp đồng KHCN).\n' +
      'Kính gửi Quý Chủ nhiệm' + (researcherName ? ' ' + String(researcherName).trim() : '') + ',\n' +
      'cc Quý thầy cô thành viên Hội đồng Khoa học Viện.\n\n' +
      'Đề tài: ' + (submissionTitle || '') + '\n' +
      'Nội dung: Đã hoàn thành Bước 7; Hợp đồng KHCN đã lưu trong hồ sơ điện tử.\n' +
      'Xem tiến trình: ' + timelineUrl;

    const rEmail = String(researcherEmail || '').trim().toLowerCase();
    if (!rEmail) {
      console.warn('[Email] Bước 7 hoàn thành: không có email Chủ nhiệm, chỉ gửi Hội đồng nếu có.');
    }
    const ccRaw = (councilList || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    const ccList = [...new Set(ccRaw)].filter(e => e !== rEmail);
    const promises = [];
    if (rEmail) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: rEmail,
        cc: ccList.length ? ccList.join(', ') : undefined,
        subject,
        text,
        html: htmlForChuNhiem
      }).catch(err => console.error('[Email] Bước 7 hoàn thành → CN+CC:', err.message)));
    } else if (ccList.length > 0) {
      const textHd =
        'THÔNG BÁO HÀNH CHÍNH — Hoàn thành Bước 7 (Ký hợp đồng KHCN).\n' +
        'Kính gửi Quý thầy cô thành viên Hội đồng Khoa học Viện.\n\n' +
        'Đề tài: ' + (submissionTitle || '') + '\n' +
        'Xem tiến trình: ' + timelineUrl;
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: ccList.join(', '),
        subject,
        text: textHd + '\n\n(Không xác định được email Chủ nhiệm — chỉ gửi Hội đồng.)',
        html: '<p><em>(Không xác định được email Chủ nhiệm — gửi danh sách Hội đồng nhận TO.)</em></p>' + htmlForHdOnly
      }).catch(err => console.error('[Email] Bước 7 hoàn thành → HĐ only:', err.message)));
    }
    return Promise.all(promises);
  }

  // Cập nhật thông tin họp / biên bản / tài liệu kèm (thông báo chung)
  function sendCapVienStep5SecretaryActivityEmail(opts) {
    const { submissionTitle, submissionId, subjectLine, bodyHtml, bodyText, councilList, researcherEmail } = opts;
    if (!transporter) return Promise.resolve();
    const timelineUrl = capVienStep5DetailUrl(submissionId);
    const suffix = '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dõi tiến trình Bước 5</a></p><p>Trân trọng,<br>Hệ thống Quản lý Đề tài cấp Viện</p></div>';
    const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' + bodyHtml + suffix;
    const text = (bodyText || '') + '\n\n' + timelineUrl;
    const promises = [];
    if (councilList && councilList.length > 0) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: subjectLine, text, html })
        .catch(err => console.error('[Email] Bước 5 hoạt động Thư ký → HĐ:', err.message)));
    }
    if (researcherEmail) {
      promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject: '[Chủ nhiệm] ' + subjectLine, text, html })
        .catch(err => console.error('[Email] Bước 5 hoạt động → CN:', err.message)));
    }
    return Promise.all(promises);
  }

  function sendStage3ResultEmail(submissionTitle, submittedByEmail, decision, comment, reviewerName) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const decisionLabels = { pass: 'Hợp lệ (chuyển GĐ4)', reject: 'Không chấp thuận', need_supplement: 'Yêu cầu bổ sung hồ sơ', need_revision: 'Yêu cầu sửa hồ sơ' };
    const label = decisionLabels[decision] || decision;
    const commentBlock = comment ? '<p><strong>Nhận xét / Yêu cầu:</strong></p><p>' + String(comment).replace(/\n/g, '<br>') + '</p>' : '';
    const needRevisionNote = (decision === 'need_supplement' || decision === 'need_revision')
      ? '<p><strong>Bạn cần chỉnh sửa và bổ sung hồ sơ theo nhận xét trên, sau đó nộp lại tại mục <a href="' + baseUrl + '/ho-so-cua-toi.html">Hồ sơ của tôi</a>.</strong></p>'
      : '';
    const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<p>Kết quả kiểm tra hồ sơ (GĐ3) tại Hệ thống SCI-ACE.</p>' +
      '<p><strong>Hồ sơ:</strong> ' + submissionTitle + '</p>' +
      '<p><strong>Người nộp:</strong> ' + submittedByEmail + '</p>' +
      '<p><strong>Kết quả:</strong> ' + label + '</p>' +
      (reviewerName ? '<p><strong>Người kiểm tra:</strong> ' + reviewerName + '</p>' : '') +
      commentBlock +
      needRevisionNote +
      '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> hoặc <a href="' + baseUrl + '/ho-so-cua-toi.html">Hồ sơ của tôi</a> để xem chi tiết.</p>' +
      '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
    const needRevisionText = (decision === 'need_supplement' || decision === 'need_revision')
      ? '\n\nBạn cần chỉnh sửa và bổ sung hồ sơ theo nhận xét trên, sau đó nộp lại tại Hồ sơ của tôi.'
      : '';
    const text = 'Kết quả kiểm tra hồ sơ (GĐ3): ' + submissionTitle + '\nKết quả: ' + label + (comment ? '\nNhận xét: ' + comment : '') + needRevisionText + '\n\n' + baseUrl;
    const promises = [];
    if (transporter) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: submittedByEmail,
        subject: '[SCI-ACE] Kết quả kiểm tra hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email to researcher:', err.message)));
      const councilList = getNotificationEmails();
      if (councilList.length > 0) {
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: councilList.join(', '),
          subject: '[SCI-ACE] Thư ký đã xử lý GĐ3 – Hồ sơ: ' + submissionTitle,
          text,
          html
        }).catch(err => console.error('Email to council:', err.message)));
      }
    }
    return Promise.all(promises);
  }

  function sendStage4AssignmentEmail(submissionTitle, chairmanName, reviewerEmails, reviewerNames, note) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const reviewersList = reviewerNames && reviewerNames.length ? reviewerNames.join(', ') : (reviewerEmails && reviewerEmails.length ? reviewerEmails.join(', ') : '');
    const noteBlock = note ? '<p><strong>Ghi chú:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
    const htmlAll = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<p>Chủ tịch Hội đồng <strong>' + (chairmanName || 'Chủ tịch') + '</strong> đã phân công phản biện cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
      '<p><strong>Phản biện được phân công:</strong> ' + reviewersList + '</p>' +
      noteBlock +
      '<p>Giai đoạn đã chuyển sang <strong>GĐ5 – Đánh giá phản biện</strong>. Các thành viên được phân công cần upload phiếu đánh giá (SCI-ACE-PĐG).</p>' +
      '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> hoặc <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dõi tiến trình</a> để xem chi tiết.</p>' +
      '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
    const textAll = 'Chủ tịch đã phân công phản biện cho hồ sơ: ' + submissionTitle + '. Phản biện: ' + reviewersList + '. Giai đoạn chuyển sang GĐ5. ' + baseUrl;
    const promises = [];
    if (transporter) {
      reviewerEmails.forEach((email, i) => {
        const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
        const htmlYou = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
          '<p>Kính gửi ' + (name || email) + ',</p>' +
          '<p>Chủ tịch Hội đồng <strong>' + (chairmanName || 'Chủ tịch') + '</strong> đã phân công <strong>bạn</strong> làm phản biện cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
          noteBlock +
          '<p>Bạn vui lòng đăng nhập và thực hiện đánh giá (GĐ5), upload phiếu đánh giá SCI-ACE-PĐG theo quy định.</p>' +
          '<p><a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> | <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dõi tiến trình</a></p>' +
          '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: email,
          subject: '[SCI-ACE] Bạn được phân công phản biện: ' + submissionTitle,
          text: 'Bạn được phân công phản biện hồ sơ: ' + submissionTitle + '. ' + baseUrl,
          html: htmlYou
        }).catch(err => console.error('Email to reviewer:', err.message)));
      });
      const councilList = getNotificationEmails();
      if (councilList.length > 0) {
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: councilList.join(', '),
          subject: '[SCI-ACE] Chủ tịch đã phân công phản biện (GĐ4) – Hồ sơ: ' + submissionTitle,
          text: textAll,
          html: htmlAll
        }).catch(err => console.error('Email to council GĐ4:', err.message)));
      }
    }
    return Promise.all(promises);
  }

  function sendDecisionIssuedEmail(submissionTitle, submittedByEmail, trackUrl) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const url = trackUrl || baseUrl + '/theo-doi-ho-so.html';
    const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<p>Thư ký Hội đồng đã cấp Quyết định (SCI-ACE-QĐ) cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
      '<p>Quyết định có bản tiếng Việt và tiếng Anh. Vui lòng đăng nhập để tải về.</p>' +
      '<p><a href="' + url + '">Xem chi tiết và tải Quyết định</a></p>' +
      '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
    const text = 'Đã cấp Quyết định cho hồ sơ: ' + submissionTitle + '. Vui lòng đăng nhập để tải: ' + url;
    const promises = [];
    if (transporter) {
      if (submittedByEmail) {
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: submittedByEmail,
          subject: '[SCI-ACE] Đã cấp Quyết định – Hồ sơ: ' + submissionTitle,
          text,
          html
        }).catch(err => console.error('Email decision to NCV:', err.message)));
      }
      const councilList = getNotificationEmails();
      if (councilList.length > 0) {
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: councilList.join(', '),
          subject: '[SCI-ACE] Đã cấp Quyết định – Hồ sơ: ' + submissionTitle,
          text,
          html
        }).catch(err => console.error('Email decision to council:', err.message)));
      }
    }
    return Promise.all(promises);
  }

  // GĐ5 (Họp Hội đồng): Thông báo kết quả họp cho nghiên cứu viên và toàn thể Hội đồng
  function sendMeetingResultEmail(submissionTitle, submittedByEmail, decision, note, secretaryName) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const decisionLabels = { approved: 'Chấp thuận', conditional: 'Chấp thuận có điều kiện', rejected: 'Không chấp thuận' };
    const label = decisionLabels[decision] || decision;
    const noteBlock = note ? '<p><strong>Ghi chú:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
    const nextStep = decision === 'rejected'
      ? 'Quy trình xét duyệt kết thúc tại đây.'
      : (decision === 'approved' ? 'Hồ sơ chuyển sang giai đoạn Cấp Quyết định (SCI-ACE-QĐ).' : 'Nghiên cứu viên cần nộp bản giải trình SCI-ACE-04, sau đó Chủ tịch Hội đồng xem xét thông qua.');
    const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<p>Kết quả họp Hội đồng (GĐ5) tại Hệ thống SCI-ACE.</p>' +
      '<p><strong>Hồ sơ:</strong> ' + submissionTitle + '</p>' +
      '<p><strong>Kết luận Hội đồng:</strong> ' + label + '</p>' +
      (secretaryName ? '<p><strong>Người ghi nhận:</strong> ' + secretaryName + '</p>' : '') +
      noteBlock +
      '<p><strong>Bước tiếp theo:</strong> ' + nextStep + '</p>' +
      '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dõi tiến trình</a> hoặc <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> để xem chi tiết.</p>' +
      '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
    const text = 'Kết quả họp Hội đồng (GĐ5): ' + submissionTitle + '\nKết luận: ' + label + '\n' + nextStep + (note ? '\nGhi chú: ' + note : '') + '\n\n' + baseUrl;
    const promises = [];
    if (transporter) {
      if (submittedByEmail) {
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: submittedByEmail,
          subject: '[SCI-ACE] Kết quả họp Hội đồng – Hồ sơ: ' + submissionTitle,
          text,
          html
        }).catch(err => console.error('Email meeting result to researcher:', err.message)));
      }
      const councilList = getNotificationEmails();
      if (councilList.length > 0) {
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: councilList.join(', '),
          subject: '[SCI-ACE] Thư ký đã ghi nhận kết quả họp (GĐ5) – Hồ sơ: ' + submissionTitle,
          text,
          html
        }).catch(err => console.error('Email meeting result to council:', err.message)));
      }
    }
    return Promise.all(promises);
  }

  function sendConditionalSubmitEmail(submissionTitle, submittedByName, submissionId) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const trackUrl = baseUrl + '/theo-doi-ho-so.html?id=' + submissionId;
    const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<p>Nghiên cứu viên <strong>' + (submittedByName || 'NCV') + '</strong> đã nộp bản giải trình SCI-ACE-04 cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
      '<p>Chủ tịch Hội đồng và các thành viên vui lòng đăng nhập để tải file và xem xét. Sau đó Chủ tịch sẽ quyết định Thông qua hoặc Không thông qua.</p>' +
      '<p><a href="' + trackUrl + '">Xem chi tiết và tải file giải trình</a></p>' +
      '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
    const text = 'NCV đã nộp SCI-ACE-04 cho hồ sơ: ' + submissionTitle + '. Vui lòng đăng nhập để xem xét: ' + trackUrl;
    const councilList = getNotificationEmails();
    if (!transporter || councilList.length === 0) return Promise.resolve();
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: councilList.join(', '),
      subject: '[SCI-ACE] NCV đã nộp bản giải trình SCI-ACE-04 – Hồ sơ: ' + submissionTitle,
      text,
      html
    }).catch(err => console.error('Email conditional submit to council:', err.message));
  }

  function sendConditionalRejectEmail(submissionTitle, submittedByEmail, chairmanName) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<p>Chủ tịch Hội đồng <strong>' + (chairmanName || 'Chủ tịch') + '</strong> chưa thông qua bản giải trình SCI-ACE-04 cho hồ sơ: <strong>' + submissionTitle + '</strong>.</p>' +
      '<p>Nghiên cứu viên vui lòng nộp lại tài liệu giải trình (SCI-ACE-04) theo yêu cầu. Sau khi nộp, Chủ tịch Hội đồng sẽ xem xét lại.</p>' +
      '<p>Vui lòng đăng nhập <a href="' + baseUrl + '/hoi-dong.html">Khu vực Hội đồng</a> hoặc <a href="' + baseUrl + '/ho-so-cua-toi.html">Hồ sơ của tôi</a> để xem chi tiết.</p>' +
      '<p>Trân trọng,<br>Hệ thống SCI-ACE</p></div>';
    const text = 'Chủ tịch chưa thông qua bản giải trình SCI-ACE-04. NCV cần nộp lại. Hồ sơ: ' + submissionTitle + '. ' + baseUrl;
    const promises = [];
    if (transporter) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: submittedByEmail,
        subject: '[SCI-ACE] Chưa thông qua bản giải trình – Hồ sơ: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email to NCV conditional reject:', err.message)));
      const councilList = getNotificationEmails();
      if (councilList.length > 0) {
        promises.push(transporter.sendMail({
          from: getSmtpFrom(),
          to: councilList.join(', '),
          subject: '[SCI-ACE] Chủ tịch chưa thông qua bản giải trình – Hồ sơ: ' + submissionTitle,
          text,
          html
        }).catch(err => console.error('Email to council conditional reject:', err.message)));
      }
    }
    return Promise.all(promises);
  }

  function sendPasswordResetEmail(toEmail, resetToken) {
    if (!transporter) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const resetUrl = baseUrl + '/dat-lai-mat-khau.html?token=' + encodeURIComponent(resetToken);
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: toEmail,
      subject: '[SCI-ACE] Đặt lại mật khẩu',
      text: 'Bạn đã yêu cầu đặt lại mật khẩu. Mở link sau trong 1 giờ để đặt mật khẩu mới: ' + resetUrl,
      html: '<p>Bạn đã yêu cầu đặt lại mật khẩu.</p><p>Nhấn vào link sau để đặt mật khẩu mới (link có hiệu lực trong <strong>1 giờ</strong>):</p><p><a href="' + resetUrl + '">' + resetUrl + '</a></p><p>Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>'
    }).catch(err => console.error('Email reset error:', err.message));
  }

  const ROLE_LABELS = { chu_tich: 'Chủ tịch', thu_ky: 'Thư ký', thanh_vien: 'Thành viên Hội đồng', researcher: 'Nghiên cứu viên', admin: 'Admin', phong_khcn: 'Phòng KHCN&QHĐN', vien_truong: 'Viện trưởng', totruong_tham_dinh_tc: 'Tổ trưởng Tổ thẩm định TC', thanh_vien_tham_dinh_tc: 'Thành viên Tổ thẩm định TC' };

  function sendRoleAssignmentEmail(toEmail, fullname, role, tempPassword) {
    if (!transporter) return Promise.resolve();
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const loginUrl = baseUrl + '/dang-nhap.html';
    const roleLabel = ROLE_LABELS[role] || role;
    const greeting = fullname ? 'Kính gửi ' + fullname + ',' : 'Kính gửi,';
    let passwordBlock = '';
    if (tempPassword) {
      passwordBlock = '<p><strong>Mật khẩu tạm để đăng nhập lần đầu:</strong> <code style="background:#f0f0f0;padding:4px 8px;">' + tempPassword + '</code></p><p>Bạn nên đổi mật khẩu sau khi đăng nhập (dùng chức năng <strong>Quên mật khẩu</strong> trên trang đăng nhập nếu cần đặt lại).</p>';
    } else {
      passwordBlock = '<p>Nếu bạn chưa có mật khẩu hoặc quên mật khẩu, vui lòng dùng chức năng <strong>Quên mật khẩu</strong> trên trang đăng nhập.</p>';
    }
    const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
      '<p>' + greeting + '</p>' +
      '<p>Bạn đã được cấp vai trò <strong>' + roleLabel + '</strong> trong Hệ thống Hồ sơ Đạo đức Nghiên cứu Động vật (SCI-ACE), Viện Tế bào gốc, Trường Đại học Khoa học Tự nhiên, ĐHQG-HCM.</p>' +
      '<p><strong>Thông tin đăng nhập:</strong></p>' +
      '<p>• Email: ' + toEmail + '</p>' +
      passwordBlock +
      '<p><strong>Link đăng nhập:</strong> <a href="' + loginUrl + '">' + loginUrl + '</a></p>' +
      '<p>Sau khi đăng nhập, thành viên Hội đồng có thể vào <strong>Khu vực Hội đồng</strong> để xem và tải hồ sơ nghiên cứu viên đã nộp.</p>' +
      '<p>Trân trọng,<br>Hệ thống SCI-ACE</p>' +
      '</div>';
    const text = greeting + '\n\nBạn đã được cấp vai trò ' + roleLabel + ' trong Hệ thống SCI-ACE.\n\nThông tin đăng nhập:\n• Email: ' + toEmail + '\n' + (tempPassword ? '• Mật khẩu tạm: ' + tempPassword + '\n' : '') + '\nLink đăng nhập: ' + loginUrl + '\n\nTrân trọng,\nHệ thống SCI-ACE';
    return transporter.sendMail({
      from: getSmtpFrom(),
      to: toEmail,
      subject: '[SCI-ACE] Bạn đã được cấp vai trò trong Hội đồng Đạo đức',
      text,
      html
    }).catch(err => console.error('Email role assignment error:', err.message));
  }

  return {
    CHAIRMAN_EMAIL_CONTROL_DEFAULTS,
    CHAIRMAN_EMAIL_CONTROL_KEY,
    COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS,
    COUNCIL_MEMBER_EMAIL_CONTROL_KEY,
    ROLE_LABELS,
    capVienEmailEsc,
    computeNhanhFromLevel,
    crdSendBroadcastEmailNotification,
    getCapVienStep7EmailOnComplete,
    getChairmanEmail,
    getChairmanEmailControls,
    getCouncilMemberEmailControls,
    getNotificationEmails,
    getPhongKhcnEmails,
    getSmtpFrom,
    isChairmanEmailEnabled,
    sendCapVienBudgetApprovedEmail,
    sendCapVienBudgetRevisedSubmittedEmail,
    sendCapVienBudgetRevisionRequestEmail,
    sendCapVienNewSubmissionEmail,
    sendCapVienStep2RevisionEmail,
    sendCapVienStep2ValidatedEmail,
    sendCapVienStep3AssignEmail,
    sendCapVienStep4aNotifyBudgetTeamEmail,
    sendCapVienStep5ChairApprovedRevisionEmail,
    sendCapVienStep5ChairRequestMoreEmail,
    sendCapVienStep5CouncilPassedEmail,
    sendCapVienStep5ReadyEmail,
    sendCapVienStep5RevisionUploadedEmail,
    sendCapVienStep5SecretaryActivityEmail,
    sendCapVienStep5SecretaryRevisionRequestEmail,
    sendCapVienStep6CompletedEmail,
    sendCapVienStep7CompletedEmail,
    sendCapVienSupplementSubmittedEmail,
    sendConditionalRejectEmail,
    sendConditionalSubmitEmail,
    sendDecisionIssuedEmail,
    sendMeetingResultEmail,
    sendNotificationToCouncil,
    sendPasswordResetEmail,
    sendResubmitEmail,
    sendRoleAssignmentEmail,
    sendStage3ResultEmail,
    sendStage4AssignmentEmail,
    transporter,
  };
};
