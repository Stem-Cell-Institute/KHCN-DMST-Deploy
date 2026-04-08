/**
 * Email thông báo module Đăng ký HN/HT — dùng sendMail giống coopSendMail.
 */

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function collectKhcnEmails(db) {
  const set = new Set();
  try {
    const pu = db.prepare("SELECT email FROM users WHERE lower(trim(role)) = 'phong_khcn'").all();
    for (const u of pu || []) {
      const em = (u.email || '').trim().toLowerCase();
      if (em) set.add(em);
    }
  } catch (_) {}
  try {
    const rows = db.prepare('SELECT email, topics, role FROM cooperation_notification_recipients').all();
    for (const r of rows || []) {
      const em = (r.email || '').trim().toLowerCase();
      if (!em || String(r.role || '').toLowerCase() === 'vien_truong') continue;
      const t = (r.topics || 'all').trim().toLowerCase();
      if (t === 'all' || t.split(',').map((x) => x.trim()).includes('hnht')) set.add(em);
    }
  } catch (_) {}
  return [...set];
}

function collectDirectorEmails(db) {
  const set = new Set();
  try {
    const rows = db
      .prepare("SELECT email, topics FROM cooperation_notification_recipients WHERE lower(trim(role)) = 'vien_truong'")
      .all();
    for (const r of rows || []) {
      const em = (r.email || '').trim().toLowerCase();
      if (!em) continue;
      const t = (r.topics || 'all').trim().toLowerCase();
      if (t === 'all' || t.split(',').map((x) => x.trim()).includes('hnht')) set.add(em);
    }
  } catch (_) {}
  try {
    const pu = db.prepare("SELECT email FROM users WHERE lower(trim(role)) = 'vien_truong'").all();
    for (const u of pu || []) {
      const em = (u.email || '').trim().toLowerCase();
      if (em) set.add(em);
    }
  } catch (_) {}
  return [...set];
}

function createConferenceEmailService({ db, sendMail, buildEmail, baseUrl }) {
  const reviewLink = `${baseUrl.replace(/\/$/, '')}/quan-ly/hoi-nghi-hoi-thao.html`;
  const myLink = `${baseUrl.replace(/\/$/, '')}/hop-tac/hoi-nghi-hoi-thao/cua-toi.html`;

  async function sendSubmissionNotification(registration, submitter) {
    const to = collectKhcnEmails(db);
    if (!to.length) {
      console.warn('[HNHT email] Không có email P.KHCN cho topic hnht');
      return;
    }
    const code = registration.submission_code || '';
    const rows = [
      ['Người nộp', esc(submitter.fullname || submitter.email)],
      ['Đơn vị', esc(registration.unit)],
      ['Hội nghị/Hội thảo', esc(registration.conf_name)],
      ['Thời gian', `${esc(registration.conf_start_date)} — ${esc(registration.conf_end_date)}`],
    ];
    const html = buildEmail(
      `[HNHT] Đăng ký tham dự HN/HT mới — ${code}`,
      'Có đăng ký mới cần Phòng KHCN xem xét.',
      rows,
      'Trân trọng.',
      reviewLink
    );
    await sendMail({
      to,
      subject: `[HNHT] Đăng ký tham dự HN/HT mới — ${code}`,
      html,
      text: `Đăng ký mới ${code}. ${submitter.fullname || submitter.email} — ${registration.conf_name}. ${reviewLink}`,
    });
  }

  async function sendKhcnRejectedNotification(registration, submitter, _reviewer, comment) {
    const u = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(registration.submitted_by_user_id);
    const to = (u && u.email) || submitter.email;
    if (!to) return;
    const code = registration.submission_code || '';
    const html = buildEmail(
      `[HNHT] Đăng ký ${code} — P.KHCN không phê duyệt`,
      'Phòng KHCN đã từ chối đăng ký. Vui lòng chỉnh sửa theo góp ý và nộp lại trên hệ thống.',
      [
        ['Hội nghị/Hội thảo', esc(registration.conf_name)],
        ['Lý do', esc(comment || '—')],
      ],
      'Trân trọng.',
      myLink
    );
    await sendMail({
      to: [to.trim().toLowerCase()],
      subject: `[HNHT] Đăng ký ${code} — P.KHCN không phê duyệt`,
      html,
      text: `Từ chối ${code}. ${comment || ''} ${myLink}`,
    });
  }

  async function sendDirectorReviewRequest(registration, submitter) {
    const to = collectDirectorEmails(db);
    if (!to.length) {
      console.warn('[HNHT email] Không có email Viện trưởng (hnht)');
      return;
    }
    const code = registration.submission_code || '';
    const fund =
      registration.funding_type === 'Tự túc hoàn toàn'
        ? 'Tự túc'
        : `Đề nghị hỗ trợ: ${Number(registration.funding_requested_vnd || 0).toLocaleString('vi-VN')} VNĐ`;
    const html = buildEmail(
      `[HNHT] Đề nghị phê duyệt — ${code}`,
      'Kính gửi Viện trưởng xem xét phê duyệt đăng ký tham dự HN/HT.',
      [
        ['Người đăng ký', esc(submitter.fullname || submitter.email)],
        ['Đơn vị', esc(registration.unit)],
        ['Hội nghị/Hội thảo', esc(registration.conf_name)],
        ['Kinh phí', esc(fund)],
      ],
      'Trân trọng.',
      reviewLink
    );
    await sendMail({
      to,
      subject: `[HNHT] Đề nghị phê duyệt — ${code}`,
      html,
      text: `Phê duyệt ${code}. ${registration.conf_name}. ${reviewLink}`,
    });
  }

  async function sendDirectorApprovedNotification(registration, submitter) {
    const u = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(registration.submitted_by_user_id);
    const to = (u && u.email) || submitter.email;
    if (!to) return;
    const cc = collectKhcnEmails(db).filter((e) => e !== (to || '').trim().toLowerCase());
    const code = registration.submission_code || '';
    const exportUrl = `${baseUrl.replace(/\/$/, '')}/api/conference-registrations/${registration.id}/export-word`;
    const evidenceUrl = `${baseUrl.replace(/\/$/, '')}/hop-tac/hoi-nghi-hoi-thao/cua-toi.html`;
    const html = buildEmail(
      `[HNHT] Đăng ký ${code} đã được phê duyệt`,
      'Viện trưởng đã phê duyệt đăng ký của bạn. Sau khi tham dự, vui lòng nộp minh chứng trong vòng 15 ngày kể từ ngày kết thúc hội nghị.',
      [
        ['Hội nghị/Hội thảo', esc(registration.conf_name)],
        ['Ghi chú Viện trưởng', esc(registration.director_comment || '—')],
        ['Xuất Word', `<a href="${esc(exportUrl)}">Tải file Word</a> (đã đăng nhập)`],
        ['Nộp minh chứng', esc(evidenceUrl)],
      ],
      'Trân trọng.',
      myLink
    );
    await sendMail({
      to: [to.trim().toLowerCase()],
      cc: cc.length ? cc : undefined,
      subject: `[HNHT] Đăng ký ${code} đã được phê duyệt`,
      html,
      text: `Đã phê duyệt ${code}. Nộp minh chứng trong 15 ngày. ${myLink}`,
    });
  }

  async function sendDirectorRejectedNotification(registration, submitter, comment) {
    const u = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(registration.submitted_by_user_id);
    const to = (u && u.email) || submitter.email;
    if (!to) return;
    const cc = collectKhcnEmails(db);
    const code = registration.submission_code || '';
    const html = buildEmail(
      `[HNHT] Đăng ký ${code} — Viện trưởng không phê duyệt`,
      'Viện trưởng đã từ chối. Phòng KHCN được CC. Người nộp có thể chỉnh sửa và nộp lại.',
      [
        ['Hội nghị/Hội thảo', esc(registration.conf_name)],
        ['Lý do', esc(comment || '—')],
      ],
      'Trân trọng.',
      myLink
    );
    await sendMail({
      to: [to.trim().toLowerCase()],
      cc: cc.length ? cc : undefined,
      subject: `[HNHT] Đăng ký ${code} — Viện trưởng không phê duyệt`,
      html,
      text: `VT từ chối ${code}. ${comment || ''} ${myLink}`,
    });
  }

  async function sendEvidenceUploadedNotification(registration, submitter, fileCount) {
    const to = collectKhcnEmails(db);
    if (!to.length) return;
    const code = registration.submission_code || '';
    const html = buildEmail(
      `[HNHT] Minh chứng tham dự đã nộp — ${code}`,
      'Người đăng ký đã nộp minh chứng sau sự kiện.',
      [
        ['Người nộp', esc(submitter.fullname || submitter.email)],
        ['Hội nghị/Hội thảo', esc(registration.conf_name)],
        ['Số file', String(fileCount || 0)],
      ],
      'Trân trọng.',
      reviewLink
    );
    await sendMail({
      to,
      subject: `[HNHT] Minh chứng tham dự đã nộp — ${code}`,
      html,
      text: `Minh chứng ${code}. ${fileCount} file. ${reviewLink}`,
    });
  }

  async function sendEvidenceReminder(registration, submitter) {
    const u = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(registration.submitted_by_user_id);
    const to = (u && u.email) || submitter.email;
    if (!to) return;
    const code = registration.submission_code || '';
    const html = buildEmail(
      `[HNHT] Nhắc nộp minh chứng — ${code}`,
      'Đã quá 15 ngày kể từ ngày kết thúc hội nghị mà hệ thống chưa nhận minh chứng. Vui lòng đăng nhập và nộp file minh chứng.',
      [['Hội nghị/Hội thảo', esc(registration.conf_name)]],
      'Trân trọng.',
      myLink
    );
    await sendMail({
      to: [to.trim().toLowerCase()],
      subject: `[HNHT] Nhắc nộp minh chứng — ${code}`,
      html,
      text: `Nhắc minh chứng ${code}. ${myLink}`,
    });
  }

  return {
    sendSubmissionNotification,
    sendKhcnRejectedNotification,
    sendDirectorReviewRequest,
    sendDirectorApprovedNotification,
    sendDirectorRejectedNotification,
    sendEvidenceUploadedNotification,
    sendEvidenceReminder,
    collectKhcnEmails,
    collectDirectorEmails,
  };
}

module.exports = { createConferenceEmailService };
