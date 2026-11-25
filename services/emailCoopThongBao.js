/**
 * Helper lấy danh sách người nhận và gửi email thông báo cho module Hợp tác Quốc tế.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function createCoopEmailHelpers({
  PORT,
  coopBuildEmail,
  coopGenMa,
  coopGetRecipients,
  coopSendMail,
}) {
  function getCooperationRecipients(topic) {
    try {
      const rows = db.prepare('SELECT email, topics FROM cooperation_notification_recipients').all();
      const list = [];
      for (const r of rows || []) {
        const em = (r.email || '').trim().toLowerCase();
        if (!em) continue;
        const t = (r.topics || 'all').trim().toLowerCase();
        if (t === 'all' || t.split(',').map(s => s.trim()).includes(topic)) list.push(em);
      }
      return list;
    } catch (e) { return []; }
  }

  // Trả về { to: [email Viện trưởng], cc: [các email khác] } — dùng cho email MOU (Kính gửi Viện trưởng, CC những người còn lại)
  function getCooperationRecipientsSplit(topic) {
    try {
      const rows = db.prepare('SELECT email, topics, role FROM cooperation_notification_recipients').all();
      const toList = [];
      const ccList = [];
      for (const r of rows || []) {
        const em = (r.email || '').trim().toLowerCase();
        if (!em) continue;
        const t = (r.topics || 'all').trim().toLowerCase();
        if (t !== 'all' && !t.split(',').map(s => s.trim()).includes(topic)) continue;
        if ((r.role || '').toString().toLowerCase() === 'vien_truong') toList.push(em);
        else ccList.push(em);
      }
      if (toList.length === 0 && ccList.length > 0) {
        toList.push(ccList.shift());
      }
      return { to: toList, cc: ccList };
    } catch (e) { return { to: [], cc: [] }; }
  }

  function coopEscHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function coopEmailsPhongKhcnReminder() {
    const set = new Set();
    try {
      const rows = db.prepare('SELECT email, topics, role FROM cooperation_notification_recipients').all();
      for (const r of rows || []) {
        const em = (r.email || '').trim().toLowerCase();
        if (!em || (r.role || '').toString().toLowerCase() === 'vien_truong') continue;
        set.add(em);
      }
      const pu = db.prepare("SELECT email FROM users WHERE lower(trim(role)) = 'phong_khcn'").all();
      for (const u of pu || []) {
        const em = (u.email || '').trim().toLowerCase();
        if (em) set.add(em);
      }
    } catch (e) { /* ignore */ }
    return [...set];
  }

  function coopEmailsVienTruongReminder() {
    const list = [];
    try {
      const rows = db.prepare("SELECT email FROM cooperation_notification_recipients WHERE lower(trim(role)) = 'vien_truong'").all();
      for (const r of rows || []) {
        const em = (r.email || '').trim().toLowerCase();
        if (em) list.push(em);
      }
    } catch (e) { /* ignore */ }
    return [...new Set(list)];
  }

  /** Email Phòng KHCN + người nhận theo topic (không gồm Viện trưởng) — dùng cho nhắc việc theo từng loại đề xuất */
  function coopEmailsPhongKhcnForTopic(topic) {
    const set = new Set();
    try {
      const rows = db.prepare('SELECT email, topics, role FROM cooperation_notification_recipients').all();
      for (const r of rows || []) {
        const em = (r.email || '').trim().toLowerCase();
        if (!em || (r.role || '').toString().toLowerCase() === 'vien_truong') continue;
        const t = (r.topics || 'all').trim().toLowerCase();
        if (t !== 'all' && !t.split(',').map(s => s.trim()).includes(topic)) continue;
        set.add(em);
      }
      const pu = db.prepare("SELECT email FROM users WHERE lower(trim(role)) = 'phong_khcn'").all();
      for (const u of pu || []) {
        const em = (u.email || '').trim().toLowerCase();
        if (em) set.add(em);
      }
    } catch (e) { /* ignore */ }
    return [...set];
  }

  function coopEmailsVienTruongForTopic(topic) {
    const list = [];
    try {
      const rows = db.prepare("SELECT email, topics FROM cooperation_notification_recipients WHERE lower(trim(role)) = 'vien_truong'").all();
      for (const r of rows || []) {
        const em = (r.email || '').trim().toLowerCase();
        if (!em) continue;
        const t = (r.topics || 'all').trim().toLowerCase();
        if (t !== 'all' && !t.split(',').map(s => s.trim()).includes(topic)) continue;
        list.push(em);
      }
    } catch (e) { /* ignore */ }
    return [...new Set(list)];
  }

  function coopEmailListMinus(list, skipEmail) {
    const sk = (skipEmail || '').trim().toLowerCase();
    if (!sk) return list || [];
    return (list || []).filter(e => (e || '').trim().toLowerCase() !== sk);
  }

  /** Thông báo tới Phòng KHCN (TO), CC Viện trưởng — khi người gửi nộp lại / kết thúc đề xuất */
  function coopNotifyPhongToCcVt(topic, opts) {
    const sub = (opts.submitterEmail || '').trim().toLowerCase();
    let to = coopEmailListMinus(coopEmailsPhongKhcnForTopic(topic), sub);
    let cc = coopEmailListMinus(coopEmailsVienTruongForTopic(topic), sub);
    if (!to.length) {
      const r = coopGetRecipients(topic);
      const pool = [...(r.to || []), ...(r.cc || [])].filter(Boolean);
      const uniq = [];
      const seen = new Set();
      for (const x of pool) {
        const em = (x || '').trim().toLowerCase();
        if (em && !seen.has(em)) { seen.add(em); uniq.push(em); }
      }
      const fb = coopEmailListMinus(uniq, sub);
      if (fb.length) to = [fb[0]];
    }
    if (!to.length) {
      console.warn('[coopNotifyPhongToCcVt] Không có người nhận TO:', topic);
      return Promise.resolve();
    }
    cc = [...new Set(cc)].filter(e => to.indexOf(e) < 0);
    return coopSendMail({ to, cc: cc.length ? cc : undefined, subject: opts.subject, html: opts.html, text: opts.text });
  }

  function coopAssertSubmitter(req, row) {
    const e = (req.user && req.user.email || '').trim().toLowerCase();
    const se = (row.submitted_by_email || '').trim().toLowerCase();
    if (!se || e !== se) return { ok: false, message: 'Chỉ người gửi đề xuất mới thực hiện được thao tác này.' };
    return { ok: true };
  }

  /** Từ chối (Phòng hoặc Viện trưởng): email người nộp — quy trình kết thúc; hồ sơ & coop_history giữ nguyên; chỉ admin xóa. */
  function coopSendMailTuChoi(loaiKey, row, id, who, note) {
    if (!row || !row.submitted_by_email) return Promise.resolve();
    const ma = row.ma_de_xuat || coopGenMa(loaiKey, id);
    const whoLabel = who === 'phong' ? 'Phòng KHCN&QHĐN' : 'Viện trưởng';
    const titleByLoai = { doan_ra: 'Đoàn ra', doan_vao: 'Đoàn vào', mou: 'MOU / Thỏa thuận', ytnn: 'Đề tài có yếu tố nước ngoài' };
    const t = titleByLoai[loaiKey] || 'Đề xuất';
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    const subj = `[Hợp tác QT] Từ chối đề xuất — ${t} — ${ma}`;
    const intro = `<strong>${whoLabel}</strong> đã <strong>từ chối</strong> đề xuất. <strong>Quy trình xử lý đề xuất này đã kết thúc.</strong> Dữ liệu và lịch sử thao tác vẫn được lưu trên hệ thống; chỉ Quản trị viên có thể xóa bản ghi nếu cần.`;
    return coopSendMail({
      to: [row.submitted_by_email],
      subject: subj,
      html: coopBuildEmail(`Thông báo từ chối đề xuất (${t})`, intro,
        [['Mã', ma], ['Ý kiến / lý do', note || '—']], 'Trân trọng.', modUrl),
      text: `${whoLabel} đã từ chối đề xuất ${ma}. Quy trình kết thúc. Ý kiến: ${note || '—'}\n${modUrl}`
    });
  }

  return {
    coopAssertSubmitter,
    coopEmailListMinus,
    coopEmailsPhongKhcnForTopic,
    coopEmailsVienTruongForTopic,
    coopEscHtml,
    coopNotifyPhongToCcVt,
    coopSendMailTuChoi,
    getCooperationRecipients,
    getCooperationRecipientsSplit,
  };
};
