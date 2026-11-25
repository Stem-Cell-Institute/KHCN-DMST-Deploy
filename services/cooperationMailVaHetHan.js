/**
 * Helper gửi email, sinh mã đề xuất, lịch sử và cảnh báo thỏa thuận hết hạn HTQT.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function createCooperationMailVaHetHan({ PORT, getSmtpFrom, transporter }) {
  function coopGenMa(loai, id) {
    const year = new Date().getFullYear();
    const prefix = { doan_ra:'DR', doan_vao:'DV', mou:'MU', ytnn:'YT', su_kien:'SK' }[loai] || 'XX';
    return `ĐX-${year}-${prefix}${String(id).padStart(4,'0')}`;
  }

  function coopAddHistory(loai, de_xuat_id, buoc, action, action_label, user, note) {
    try {
      db.prepare(`
      INSERT INTO coop_history (loai, de_xuat_id, buoc, action, action_label, performed_by_id, performed_by_name, performed_by_role, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(loai, de_xuat_id, buoc, action, action_label || action,
        (user && user.id) || null,
        (user && (user.fullname || user.email)) || 'Hệ thống',
        (user && user.role) || null,
        note || null
      );
    } catch(e) { console.error('[History]', e.message); }
  }

  function coopIsVienTruong(email) {
    if (!email) return false;
    try {
      return !!db.prepare("SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email))=? AND lower(trim(role))='vien_truong'").get(email.trim().toLowerCase());
    } catch(e) { return false; }
  }

  /** TO = Viện trưởng (role trong cooperation_notification_recipients), CC = email nhận cùng topic + user role phong_khcn. Không có VT thì lấy người đầu CC làm TO. */
  function coopGetRecipients(topic) {
    try {
      const rows = db.prepare('SELECT email, topics, role FROM cooperation_notification_recipients').all();
      const to = [], cc = [];
      for (const r of rows) {
        const em = (r.email || '').trim().toLowerCase();
        if (!em) continue;
        const t = (r.topics || 'all').toLowerCase();
        if (t !== 'all' && !t.split(',').map(s => s.trim()).includes(topic)) continue;
        if ((r.role || '').toLowerCase() === 'vien_truong') to.push(em);
        else cc.push(em);
      }
      const seen = new Set([...to, ...cc]);
      try {
        const pu = db.prepare("SELECT email FROM users WHERE lower(trim(role)) = 'phong_khcn'").all();
        for (const u of pu || []) {
          const em = (u.email || '').trim().toLowerCase();
          if (em && !seen.has(em)) { cc.push(em); seen.add(em); }
        }
      } catch (e) { /* ignore */ }
      if (to.length === 0 && cc.length > 0) to.push(cc.shift());
      return { to, cc, all: [...to, ...cc] };
    } catch(e) { return { to: [], cc: [], all: [] }; }
  }

  function coopSendMail({ to, cc, subject, html, text: textBody }) {
    if (!transporter) return Promise.resolve();
    if (!to || to.length === 0) return Promise.resolve();
    const opts = {
      from: getSmtpFrom(),
      to: Array.isArray(to) ? to.join(', ') : to,
      subject, text: textBody, html
    };
    if (cc && cc.length > 0) opts.cc = Array.isArray(cc) ? cc.join(', ') : cc;
    return transporter.sendMail(opts)
      .then(() => console.log('[Email HTQT] Đã gửi:', subject))
      .catch(err => {
        console.error('[Email HTQT] Lỗi:', err.message);
        throw err;
      });
  }

  function coopDateAtMidnight(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function coopParseYmdDate(s) {
    if (!s || !String(s).trim()) return null;
    const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return isNaN(d.getTime()) ? null : d;
  }

  function coopAddCalendarMonths(date, deltaMonths) {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + deltaMonths);
    return d;
  }

  function coopGetThoaThuanExpiryMonths() {
    try {
      const row = db.prepare('SELECT value FROM cooperation_settings WHERE key = ?').get('thoa_thuan_expiry_alert_months');
      const n = parseInt(row && row.value, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 36) return n;
    } catch (e) { /* ignore */ }
    return 3;
  }

  function coopGetThoaThuanPostExpiryMaxEmails() {
    try {
      const row = db.prepare('SELECT value FROM cooperation_settings WHERE key = ?').get('thoa_thuan_post_expiry_max_emails');
      const n = parseInt(row && row.value, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
    } catch (e) { /* ignore */ }
    return 3;
  }

  function coopGetThoaThuanPostExpiryMinDays() {
    try {
      const row = db.prepare('SELECT value FROM cooperation_settings WHERE key = ?').get('thoa_thuan_post_expiry_min_days');
      const n = parseInt(row && row.value, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 90) return n;
    } catch (e) { /* ignore */ }
    return 7;
  }

  function coopDaysBetweenMidnight(later, earlier) {
    const a = coopDateAtMidnight(later).getTime();
    const b = coopDateAtMidnight(earlier).getTime();
    return Math.round((a - b) / (86400000));
  }

  /** Trước hạn: một email trong khoảng N tháng cuối. Sau hạn: tối đa M email, cách nhau ít nhất D ngày. */
  async function coopRunThoaThuanExpiryAlerts() {
    if (!transporter) {
      return { sent: 0, skipped: true, reason: 'no_smtp' };
    }
    const months = coopGetThoaThuanExpiryMonths();
    if (months < 1) return { sent: 0, skipped: true, reason: 'invalid_months' };
    const postMax = coopGetThoaThuanPostExpiryMaxEmails();
    const postMinDays = coopGetThoaThuanPostExpiryMinDays();

    const recip = coopGetRecipients('thoa_thuan_het_han');
    const to = recip.to || [];
    const cc = recip.cc || [];
    if (!to.length) {
      console.warn('[ThoaThuanExpiry] Không có người nhận (topic thoa_thuan_het_han hoặc all). Cấu hình tại Quản trị Hợp tác QT.');
      return { sent: 0, checked: 0, reason: 'no_recipients' };
    }

    const today = new Date();
    const t0 = coopDateAtMidnight(today);
    let rows;
    try {
      rows = db.prepare(`
      SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, expiry_alert_sent_at,
             COALESCE(post_expiry_alert_count, 0) AS post_expiry_alert_count, last_post_expiry_alert_at
      FROM cooperation_thoa_thuan
      WHERE het_han IS NOT NULL AND trim(het_han) != ''
      AND lower(trim(trang_thai)) IN ('hieu_luc','sap_het_han')
    `).all();
    } catch (e) {
      return { sent: 0, error: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
    }

    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const link = baseUrl + '/module-hoatac-quocte.html';
    let sentPre = 0;
    let sentPost = 0;

    for (const row of rows || []) {
      const exp = coopParseYmdDate(row.het_han);
      if (!exp) continue;
      const expDay = coopDateAtMidnight(exp);

      // --- Sau ngày hết hạn (đã quá hạn lịch, trạng thái vẫn hiệu lực/sắp hết hạn) ---
      if (postMax > 0 && t0 > expDay) {
        const cnt = parseInt(row.post_expiry_alert_count, 10) || 0;
        if (cnt >= postMax) continue;
        let canSendPost = true;
        if (row.last_post_expiry_alert_at) {
          const last = coopParseYmdDate(String(row.last_post_expiry_alert_at).slice(0, 10));
          if (last && coopDaysBetweenMidnight(t0, last) < postMinDays) canSendPost = false;
        }
        if (!canSendPost) continue;

        const nextNum = cnt + 1;
        const subject = '[Hợp tác QT] Thỏa thuận đã quá hạn hiệu lực — nhắc ' + nextNum + '/' + postMax + ' — ' + String(row.ten || '—').slice(0, 100);
        const html = coopBuildEmail(
          'Thỏa thuận đã quá ngày hết hiệu lực',
          `Ngày hết hiệu lực đã qua; trạng thái trên hệ thống vẫn là <strong>Hiệu lực / Sắp hết hạn</strong>. Đây là email nhắc <strong>sau hết hạn</strong> lần <strong>${nextNum}</strong> trong tối đa <strong>${postMax}</strong> lần (cách nhau ít nhất <strong>${postMinDays}</strong> ngày). Vui lòng gia hạn, ký lại hoặc đổi trạng thái thành <strong>Hết hạn</strong>.`,
          [
            ['Tên thỏa thuận', row.ten],
            ['Đối tác', row.doi_tac],
            ['Loại', row.loai],
            ['Quốc gia', row.quoc_gia || '—'],
            ['Ngày hết hiệu lực (đã qua)', coopFmtDateVN(row.het_han)],
            ['Trạng thái hiện tại', row.trang_thai || '—'],
            ['Lần nhắc sau hết hạn', nextNum + ' / ' + postMax]
          ],
          'Trân trọng,<br/>Hệ thống tự động — Hợp tác Quốc tế',
          link
        );
        const text = `Thỏa thuận đã quá hạn (nhắc ${nextNum}/${postMax})\n${row.ten}\nHết hạn: ${coopFmtDateVN(row.het_han)}\n${link}`;

        try {
          await coopSendMail({ to, cc: cc.length ? cc : undefined, subject, html, text });
          db.prepare(`UPDATE cooperation_thoa_thuan SET post_expiry_alert_count=?, last_post_expiry_alert_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(nextNum, row.id);
          sentPost++;
        } catch (e) {
          console.error('[ThoaThuanExpiry] Gửi sau hạn lỗi id=', row.id, e.message);
        }
        continue;
      }

      // --- Trước / trong khoảng N tháng cuối (chưa quá ngày hết hạn) ---
      if (row.expiry_alert_sent_at) continue;
      const thr = coopAddCalendarMonths(expDay, -months);
      if (t0 < coopDateAtMidnight(thr) || t0 > expDay) continue;

      const subject = '[Hợp tác QT] Cảnh báo: Thỏa thuận sắp đến hạn hiệu lực — ' + String(row.ten || '—').slice(0, 120);
      const html = coopBuildEmail(
        'Thỏa thuận trong khoảng cảnh báo hết hạn',
        `Thỏa thuận sau đây đang trong khoảng <strong>${months} tháng</strong> cuối trước ngày hết hiệu lực (theo cấu hình Quản trị Hợp tác quốc tế). Vui lòng xem xét gia hạn hoặc cập nhật trạng thái trên hệ thống.`,
        [
          ['Tên thỏa thuận', row.ten],
          ['Đối tác', row.doi_tac],
          ['Loại', row.loai],
          ['Quốc gia', row.quoc_gia || '—'],
          ['Ngày hết hiệu lực', coopFmtDateVN(row.het_han)],
          ['Trạng thái', row.trang_thai || '—']
        ],
        'Trân trọng,<br/>Hệ thống tự động — Hợp tác Quốc tế',
        link
      );
      const text = `Cảnh báo thỏa thuận sắp hết hiệu lực\n${row.ten}\nĐối tác: ${row.doi_tac}\nHết hạn: ${coopFmtDateVN(row.het_han)}\n${link}`;

      try {
        await coopSendMail({ to, cc: cc.length ? cc : undefined, subject, html, text });
        db.prepare(`UPDATE cooperation_thoa_thuan SET expiry_alert_sent_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(row.id);
        sentPre++;
      } catch (e) {
        console.error('[ThoaThuanExpiry] Gửi lỗi id=', row.id, e.message);
      }
    }
    const sent = sentPre + sentPost;
    if (sent) console.log('[ThoaThuanExpiry] Đã gửi', sent, 'email (trước hạn:', sentPre, ', sau hạn:', sentPost, ').');
    return { sent, sent_pre: sentPre, sent_post: sentPost, checked: (rows || []).length };
  }

  function coopBuildEmail(title, intro, rows, footer, link) {
    const rowsHtml = rows.map(([k,v]) =>
      `<tr><td style="font-weight:600;width:38%;background:#f8fafc;padding:8px 12px;border:1px solid #e2e8f0">${k}</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${(v||'—').toString().replace(/\n/g,'<br>')}</td></tr>`
    ).join('');
    return `<div style="font-family:Arial,sans-serif;max-width:660px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1e40af,#1a6fb5);padding:20px 28px">
      <div style="color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">Viện Tế bào gốc — SCI</div>
      <h1 style="color:#fff;margin:0;font-size:17px;font-weight:700">${title}</h1>
    </div>
    <div style="padding:20px 28px">
      <p style="color:#374151;margin-bottom:14px">${intro}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${rowsHtml}</table>
      ${link ? `<p><a href="${link}" style="display:inline-block;background:#1e40af;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:600">Xem chi tiết &amp; xử lý →</a></p>` : ''}
      <p style="color:#6b7280;font-size:13px;margin-top:16px;border-top:1px solid #e5e7eb;padding-top:14px">${footer || 'Trân trọng,<br/>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc'}</p>
    </div>
  </div>`;
  }

  function coopFmtDateVN(s) {
    if (!s) return '—';
    const d = String(s).slice(0, 10).split('-');
    return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(s).slice(0, 10);
  }

  return {
    coopAddHistory,
    coopBuildEmail,
    coopFmtDateVN,
    coopGenMa,
    coopGetRecipients,
    coopGetThoaThuanExpiryMonths,
    coopGetThoaThuanPostExpiryMaxEmails,
    coopGetThoaThuanPostExpiryMinDays,
    coopIsVienTruong,
    coopRunThoaThuanExpiryAlerts,
    coopSendMail,
  };
};
