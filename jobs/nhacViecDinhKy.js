/**
 * Các tác vụ định kỳ chạy trong tiến trình web:
 * - nhắc bước xử lý HTQT bị treo (mỗi ngày)
 * - nhắc nộp minh chứng hội nghị (8 giờ sáng)
 * - cảnh báo thỏa thuận hợp tác sắp/đã hết hạn (mỗi ngày)
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function startScheduledJobs({
  PORT,
  STATUS_LABELS_COOP,
  coopBuildEmail,
  coopEmailsPhongKhcnForTopic,
  coopEmailsVienTruongForTopic,
  coopEscHtml,
  coopRunThoaThuanExpiryAlerts,
  coopSendMail,
  transporter,
}) {
  /** Đủ điều kiện nhắc: ≥3 ngày kể từ cập nhật hồ sơ; lần nhắc sau cách lần trước ≥3 ngày (chỉ gửi nội bộ, không hiện cho người nộp đề xuất). */
  function coopReminderRowEligible(row) {
    const ref = row.updated_at || row.created_at;
    if (!ref) return false;
    try {
      const dAct = db.prepare('SELECT julianday(\'now\') - julianday(?) AS d').get(ref);
      if (!dAct || dAct.d < 3) return false;
      if (!row.coop_reminder_last_at) return true;
      const dRem = db.prepare('SELECT julianday(\'now\') - julianday(?) AS d').get(row.coop_reminder_last_at);
      return dRem && dRem.d >= 3;
    } catch (e) { return false; }
  }

  /** Nhắc email theo từng hồ sơ tới Phòng KHCN hoặc Viện trưởng (tùy bước đang treo). */
  function sendCoopStaleStepReminders() {
    if (!transporter) return;
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const moduleUrl = baseUrl + '/module-hoatac-quocte.html';
    const cfg = [
      { table: 'cooperation_doan_ra', topic: 'doan_ra', label: 'Đoàn ra',
        phongStatuses: ['cho_phong_duyet'],
        vtStatuses: ['cho_vt_duyet'] },
      { table: 'cooperation_doan_vao', topic: 'doan_vao', label: 'Đoàn vào',
        phongStatuses: ['cho_phong_duyet', 'cho_tham_dinh', 'dang_tham_dinh'],
        vtStatuses: ['cho_vt_duyet', 'cho_ky_duyet'] },
      { table: 'cooperation_mou_de_xuat', topic: 'mou', label: 'Thỏa thuận/MOU',
        phongStatuses: ['cho_phong_duyet', 'dang_tham_dinh'],
        vtStatuses: ['cho_vt_duyet'] },
      { table: 'htqt_de_xuat', topic: 'ytnn', label: 'Đề tài YTNN',
        phongStatuses: ['cho_phan_loai', 'cho_phong_duyet', 'dang_tham_dinh'],
        vtStatuses: ['cho_vt_phe_duyet', 'cho_vt_duyet'] }
    ];
    for (const T of cfg) {
      const phong = coopEmailsPhongKhcnForTopic(T.topic);
      const vt = coopEmailsVienTruongForTopic(T.topic);
      let rows;
      try {
        rows = db.prepare(`SELECT * FROM ${T.table}`).all();
      } catch (e) { continue; }
      for (const row of rows || []) {
        const st = (row.status || '').toLowerCase().trim();
        if (st === 'ket_thuc_boi_nguoi_nop') continue;
        const waitPhong = T.phongStatuses.indexOf(st) >= 0;
        const waitVt = T.vtStatuses.indexOf(st) >= 0;
        if (!waitPhong && !waitVt) continue;
        if (!coopReminderRowEligible(row)) continue;
        const to = waitPhong ? phong : vt;
        if (!to.length) continue;
        const ma = (row.ma_de_xuat || ('#' + row.id)).toString();
        const stepLabel = waitPhong ? 'chờ Phòng KHCN&QHĐN thẩm định / xử lý' : 'chờ Viện trưởng phê duyệt';
        const subject = `[HTQT — nội bộ] Nhắc xử lý: ${T.label} ${ma} — ${waitPhong ? 'Phòng KHCN' : 'Viện trưởng'}`;
        const intro = `Kính gửi Quý Ông/Bà,<br/><br/>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc xin nhắc (nội bộ): đề xuất <strong>${coopEscHtml(T.label)}</strong>, mã <strong>${coopEscHtml(ma)}</strong>, hiện <strong>${stepLabel}</strong>. Đề nghị xem xét xử lý theo quy định.`;
        const stLabel = STATUS_LABELS_COOP[st] || st;
        const html = coopBuildEmail('Nhắc xử lý đề xuất (nội bộ)', intro, [['Mã', ma], ['Trạng thái', stLabel]], 'Trân trọng,<br/>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc', moduleUrl);
        const text = `Kính gửi,\n\nNhắc nội bộ xử lý: ${T.label} — mã ${ma}.\nTrạng thái: ${stLabel}.\n${moduleUrl}\n`;
        coopSendMail({ to, subject, html, text })
          .then(() => {
            try {
              db.prepare(`UPDATE ${T.table} SET coop_reminder_last_at = datetime('now') WHERE id = ?`).run(row.id);
            } catch (e2) { console.error('[CoopReminder] Lỗi cập nhật:', e2.message); }
          })
          .catch(err => console.error('[CoopReminder] Gửi lỗi:', err.message));
      }
    }
  }

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  setInterval(sendCoopStaleStepReminders, ONE_DAY_MS);
  setTimeout(sendCoopStaleStepReminders, 60 * 60 * 1000);

  /** Nhắc nộp minh chứng HN/HT: sau conf_end_date + 15 ngày, gửi một lần (evidence_reminder_sent_at). Chạy khi giờ máy chủ = 8. */
  let _hnhtReminderDayKey = null;
  function sendConferenceEvidenceReminders() {
    if (!transporter) return;
    try {
      const { createConferenceEmailService } = require('../services/conferenceEmailService');
      const emails = createConferenceEmailService({
        db,
        sendMail: coopSendMail,
        buildEmail: coopBuildEmail,
        baseUrl: process.env.BASE_URL || 'http://localhost:' + PORT,
      });
      const rows = db
        .prepare(
          `SELECT * FROM conference_registrations WHERE status = 'director_approved'
         AND julianday('now') - julianday(conf_end_date) >= 15
         AND (evidence_reminder_sent_at IS NULL OR evidence_reminder_sent_at = '')`
        )
        .all();
      for (const r of rows || []) {
        const submitter = db.prepare('SELECT id, email, fullname FROM users WHERE id = ?').get(r.submitted_by_user_id);
        if (!submitter) continue;
        emails
          .sendEvidenceReminder(r, submitter)
          .then(() => {
            try {
              db.prepare('UPDATE conference_registrations SET evidence_reminder_sent_at = datetime(\'now\') WHERE id = ?').run(r.id);
            } catch (e2) {
              console.error('[HNHT reminder] Lỗi cập nhật:', e2.message);
            }
          })
          .catch((err) => console.error('[HNHT reminder] Gửi lỗi:', err.message));
      }
    } catch (e) {
      console.warn('[HNHT reminder]', e.message);
    }
  }
  setInterval(() => {
    const d = new Date();
    if (d.getHours() !== 8) return;
    const key = d.toISOString().slice(0, 10);
    if (_hnhtReminderDayKey === key) return;
    _hnhtReminderDayKey = key;
    sendConferenceEvidenceReminders();
  }, 60 * 1000);

  function coopRunThoaThuanExpiryAlertsWrapped() {
    coopRunThoaThuanExpiryAlerts()
      .then((r) => {
        if (r && r.sent > 0) console.log('[ThoaThuanExpiry] Hoàn tất: đã gửi', r.sent, 'email.');
      })
      .catch((e) => console.error('[ThoaThuanExpiry]', e.message || e));
  }
  setInterval(coopRunThoaThuanExpiryAlertsWrapped, ONE_DAY_MS);
  setTimeout(coopRunThoaThuanExpiryAlertsWrapped, 2 * 60 * 1000);
};
