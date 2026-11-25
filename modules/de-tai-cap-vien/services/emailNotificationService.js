/**
 * Trung tâm cấu hình Ma trận Luồng Email Thông báo & gửi SMTP thật qua E-Office.
 * - Chỉ Master Admin được cấu hình ma trận bật/tắt & chọn vai trò nhận cho từng sự kiện.
 * - Tự động tra cứu địa chỉ email thật từ bảng `nckh_user_roles` và bảng `users` của E-Office.
 * - Tự động chuẩn hóa link trong email sang `${baseUrl}/de-tai-cap-vien/...`.
 * - Ghi đầy đủ nhật ký vào `nckh_email_logs` (SENT / FAILED / LOGGED_NO_SMTP).
 */

const db = require('../db/db');
const { ROLES } = require('../config/roles');
const { normalizeVietnameseName } = require('./ownershipService');

const MASTER_ADMIN_EMAIL = 'ntsinh0409@gmail.com';

const EMAIL_EVENT_MATRIX_DEFAULT = [
  {
    event_key: 'CALL_BROADCAST',
    stage_label: 'GĐ 1 • Đợt đăng ký',
    event_name: 'Mở đợt đăng ký đề tài mới',
    desc: 'Phát thông báo khi Phòng KHTH mở đợt tiếp nhận thuyết minh đề tài cấp Viện',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN'],
    enabled: 1
  },
  {
    event_key: 'PROPOSAL_SUBMITTED',
    stage_label: 'GĐ 1 • Đề xuất mới',
    event_name: 'NCV nộp đề xuất & thuyết minh đề tài mới',
    desc: 'Xác nhận đã tiếp nhận hồ sơ cho CNĐT và báo Phòng KHTH sơ duyệt thể thức',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN'],
    enabled: 1
  },
  {
    event_key: 'PROPOSAL_REVISION',
    stage_label: 'GĐ 1 • Sơ duyệt',
    event_name: 'Yêu cầu chỉnh sửa / bổ sung hồ sơ đề xuất',
    desc: 'Thông báo cho Chủ nhiệm khi hồ sơ cần hoàn thiện trước khi đưa ra Hội đồng',
    default_roles: ['CHU_NHIEM'],
    enabled: 1
  },
  {
    event_key: 'COUNCIL_SCHEDULED',
    stage_label: 'GĐ 2 • Hội đồng',
    event_name: 'Lên lịch họp Hội đồng xét duyệt đề cương',
    desc: 'Thông báo ngày giờ, địa điểm họp Hội đồng xét duyệt thuyết minh',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'VIEN_TRUONG'],
    enabled: 1
  },
  {
    event_key: 'PROJECT_APPROVED',
    stage_label: 'GĐ 3 • Giao nhiệm vụ',
    event_name: 'Phê duyệt & Giao nhiệm vụ đề tài mới',
    desc: 'Thông báo Quyết định giao nhiệm vụ, cấp mã đề tài và lập dự toán/hợp đồng',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'VIEN_TRUONG', 'PHONG_TC_CU'],
    enabled: 1
  },
  {
    event_key: 'PERIODIC_REPORT_SUBMITTED',
    stage_label: 'GĐ 5 • Tiến độ',
    event_name: 'Nộp Báo cáo tiến độ định kỳ 6 tháng',
    desc: 'Thông báo khi Chủ nhiệm nộp báo cáo định kỳ 6 tháng/lần để Phòng KHTH thẩm định',
    default_roles: ['PHONG_KHCN', 'CHU_NHIEM'],
    enabled: 1
  },
  {
    event_key: 'BUDGET_ADJ_SUBMITTED',
    stage_label: 'GĐ 4 • Dự toán (B1)',
    event_name: 'Điều chỉnh dự toán: CNĐT lập tờ trình (Bước 1)',
    desc: 'Báo Phòng KHTH kiểm tra và thẩm tra chuyên môn tờ trình điều chỉnh dự toán',
    default_roles: ['PHONG_KHCN'],
    enabled: 1
  },
  {
    event_key: 'BUDGET_ADJ_REVIEWED',
    stage_label: 'GĐ 4 • Dự toán (B2)',
    event_name: 'Điều chỉnh dự toán: Phòng KHTH trình Viện trưởng (Bước 2)',
    desc: 'Trình Viện trưởng xem xét phê duyệt điều chỉnh kinh phí/danh mục hóa chất',
    default_roles: ['VIEN_TRUONG'],
    enabled: 1
  },
  {
    event_key: 'BUDGET_ADJ_APPROVED',
    stage_label: 'GĐ 4 • Dự toán (B3)',
    event_name: 'Điều chỉnh dự toán: Viện trưởng phê duyệt (Bước 3)',
    desc: 'Thông báo Quyết định điều chỉnh dự toán đã duyệt để thực hiện mua sắm/cấp phát',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'PHONG_TC_CU'],
    enabled: 1
  },
  {
    event_key: 'EXTENSION_REQUEST',
    stage_label: 'GĐ 5 • Gia hạn',
    event_name: 'Xin gia hạn đề tài (Lần 1, Lần 2) & Quyết định gia hạn',
    desc: 'Thông báo khi CNĐT nộp đơn xin gia hạn 6 tháng hoặc khi gia hạn được phê duyệt',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'VIEN_TRUONG'],
    enabled: 1
  },
  {
    event_key: 'SUPPLY_REQUEST',
    stage_label: 'GĐ 4 • Vật tư',
    event_name: 'Đề xuất & Cấp phát hóa chất - vật tư tiêu hao',
    desc: 'Thông báo phiếu yêu cầu hóa chất/vật tư tới Thủ kho, Phòng TC-Cung ứng và CNĐT',
    default_roles: ['THU_KHO', 'PHONG_TC_CU', 'CHU_NHIEM'],
    enabled: 1
  },
  {
    event_key: 'ACCEPTANCE_EVENT',
    stage_label: 'GĐ 6-7 • Nghiệm thu',
    event_name: 'Nộp hồ sơ Nghiệm thu & Thanh lý Hợp đồng',
    desc: 'Thông báo nộp báo cáo tổng kết, kết quả nghiệm thu và quyết toán thanh lý',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'VIEN_TRUONG', 'PHONG_TC_CU'],
    enabled: 1
  },
  {
    event_key: 'DEADLINE_ALERT',
    stage_label: 'Tự động • Quét hạn',
    event_name: 'Cảnh báo hạn hợp đồng tự động (30 / 15 / 7 / 0 ngày)',
    desc: 'Nhắc việc sắp hết hạn nộp báo cáo/gia hạn và cảnh báo đỏ khi đề tài quá hạn',
    default_roles: ['CHU_NHIEM', 'PHONG_KHCN', 'VIEN_TRUONG', 'PHONG_TC_CU'],
    enabled: 1
  }
];

const runtimeCtx = {
  transporter: null,
  getSmtpFrom: null,
  eofficeDb: null,
  baseUrl: 'https://eoffice.sci.edu.vn'
};

function configure(ctx = {}) {
  if (ctx.transporter !== undefined) runtimeCtx.transporter = ctx.transporter;
  if (typeof ctx.getSmtpFrom === 'function') runtimeCtx.getSmtpFrom = ctx.getSmtpFrom;
  if (ctx.eofficeDb) runtimeCtx.eofficeDb = ctx.eofficeDb;
  if (ctx.baseUrl) runtimeCtx.baseUrl = String(ctx.baseUrl).replace(/\/+$/, '');
}

function getBaseModuleUrl() {
  const b = (process.env.BASE_URL || runtimeCtx.baseUrl || 'https://eoffice.sci.edu.vn').replace(/\/+$/, '');
  return b + '/de-tai-cap-vien';
}

function normalizeEmailLinks(html) {
  if (!html) return '';
  const modUrl = getBaseModuleUrl();
  return String(html).replace(/http:\/\/localhost:3005/gi, modUrl);
}

function parseRolesJson(raw, fallback) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return Array.isArray(fallback) ? fallback : [];
}

async function getMatrixRules() {
  const rows = await db.all('SELECT * FROM nckh_email_matrix');
  const map = new Map(rows.map((r) => [r.event_key, r]));
  return EMAIL_EVENT_MATRIX_DEFAULT.map((def) => {
    const saved = map.get(def.event_key);
    return {
      event_key: def.event_key,
      stage_label: def.stage_label,
      event_name: def.event_name,
      desc: def.desc,
      enabled: saved ? Number(saved.enabled) === 1 : def.enabled === 1,
      recipient_roles: saved ? parseRolesJson(saved.recipient_roles, def.default_roles) : [...def.default_roles],
      extra_cc: saved && saved.extra_cc ? String(saved.extra_cc).trim() : '',
      updated_by: saved ? saved.updated_by : null,
      updated_at: saved ? saved.updated_at : null
    };
  });
}

async function saveMatrixRule(eventKey, { enabled, recipient_roles, extra_cc, updated_by }) {
  const def = EMAIL_EVENT_MATRIX_DEFAULT.find((d) => d.event_key === eventKey);
  if (!def) throw new Error('Mã sự kiện email không hợp lệ: ' + eventKey);

  const cleanRoles = Array.isArray(recipient_roles)
    ? [...new Set(recipient_roles.map((r) => String(r).trim().toUpperCase()).filter((r) => ROLES[r]))]
    : def.default_roles;
  const cleanCc = String(extra_cc || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s.includes('@'))
    .join(', ');

  const exists = await db.get('SELECT event_key FROM nckh_email_matrix WHERE event_key = ?', [eventKey]);
  if (exists) {
    await db.run(
      `UPDATE nckh_email_matrix
       SET enabled = ?, recipient_roles = ?, extra_cc = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE event_key = ?`,
      [enabled ? 1 : 0, JSON.stringify(cleanRoles), cleanCc, updated_by || 'admin', eventKey]
    );
  } else {
    await db.run(
      `INSERT INTO nckh_email_matrix (event_key, enabled, recipient_roles, extra_cc, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [eventKey, enabled ? 1 : 0, JSON.stringify(cleanRoles), cleanCc, updated_by || 'admin']
    );
  }
  const all = await getMatrixRules();
  return all.find((x) => x.event_key === eventKey);
}

/** Trả về danh sách email thực tế ứng với từng vai trò từ bảng nckh_user_roles */
async function getRoleEmailDirectory() {
  const dir = {
    VIEN_TRUONG: [],
    SUPER_ADMIN: [{ email: MASTER_ADMIN_EMAIL, fullname: 'Master Admin E-Office' }],
    PHONG_KHCN: [],
    PHONG_TC_CU: [],
    THU_KHO: [],
    CHU_NHIEM: []
  };

  try {
    const assigned = await db.all('SELECT email, fullname, role_key, position_title FROM nckh_user_roles');
    for (const a of assigned) {
      const rk = a.role_key === 'PHONG_TCHC' ? 'PHONG_KHCN' : a.role_key;
      const em = String(a.email || '').trim().toLowerCase();
      if (!em || !dir[rk]) continue;
      if (!dir[rk].some((x) => x.email === em)) {
        dir[rk].push({ email: em, fullname: a.fullname || em, title: a.position_title || '' });
      }
    }
  } catch (_) {}

  return dir;
}

/** Tìm email thật của Chủ nhiệm đề tài: ưu tiên leader_email -> tra bảng users của E-Office theo tên chuẩn hóa */
function resolveLeaderEmail({ leaderEmail, leaderName, project }) {
  const explicit = String(leaderEmail || (project && project.leader_email) || '').trim().toLowerCase();
  if (explicit && explicit.includes('@')) return explicit;

  const targetName = normalizeVietnameseName(leaderName || (project && project.leader_name));
  if (targetName && runtimeCtx.eofficeDb) {
    try {
      const users = runtimeCtx.eofficeDb.prepare('SELECT email, fullname FROM users').all();
      const hit = users.find((u) => normalizeVietnameseName(u.fullname) === targetName);
      if (hit && hit.email) return String(hit.email).trim().toLowerCase();
    } catch (_) {}
  }
  return null;
}

/** Gửi một email qua SMTP thật của E-Office (nếu đã cấu hình) và ghi log vào nckh_email_logs */
async function sendAndLogSingleEmail({
  eventType,
  recipientEmail,
  recipientName,
  recipientRole,
  subject,
  bodyHtml,
  actionUrl = null,
  relatedProposalId = null,
  relatedProjectId = null
}) {
  // Nếu recipientRole là 1 vai trò có người thật trong nckh_user_roles và email truyền vào là email mẫu cũ, ưu tiên email thật
  let cleanEmail = String(recipientEmail || '').trim().toLowerCase();
  if (recipientRole && recipientRole !== 'CHU_NHIEM' && recipientRole !== 'CC' && recipientRole !== 'SYSTEM') {
    const dir = await getRoleEmailDirectory();
    const rk = recipientRole === 'PHONG_TCHC' ? 'PHONG_KHCN' : recipientRole;
    if (dir[rk] && dir[rk].length > 0 && (!cleanEmail || /^(p\.|director@|khcn@|finance@|tchc@|thukho@)/.test(cleanEmail))) {
      cleanEmail = dir[rk][0].email;
      recipientName = dir[rk][0].fullname || recipientName;
    }
  }
  if (!cleanEmail || !cleanEmail.includes('@')) return { status: 'SKIPPED_INVALID_EMAIL' };

  const fixedHtml = normalizeEmailLinks(bodyHtml);
  let sentStatus = 'LOGGED_NO_SMTP';

  if (runtimeCtx.transporter && typeof runtimeCtx.transporter.sendMail === 'function') {
    try {
      const from = typeof runtimeCtx.getSmtpFrom === 'function'
        ? runtimeCtx.getSmtpFrom()
        : (process.env.SMTP_FROM || process.env.SMTP_USER || 'eoffice@sci.edu.vn');
      await runtimeCtx.transporter.sendMail({
        from,
        to: cleanEmail,
        subject,
        html: fixedHtml
      });
      sentStatus = 'SENT';
    } catch (err) {
      console.error(`[DE-TAI-CAP-VIEN][SMTP] Lỗi gửi tới ${cleanEmail}:`, err && err.message ? err.message : err);
      sentStatus = 'FAILED';
    }
  }

  try {
    const res = await db.run(
      `INSERT INTO nckh_email_logs (
        event_type, recipient_email, recipient_name, recipient_role,
        subject, body_html, related_proposal_id, related_project_id,
        action_url, sent_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventType,
        cleanEmail,
        recipientName || cleanEmail,
        recipientRole || 'SYSTEM',
        subject,
        fixedHtml,
        relatedProposalId,
        relatedProjectId,
        actionUrl || (relatedProjectId ? `/de-tai-cap-vien/chi-tiet.html?id=${relatedProjectId}` : '/de-tai-cap-vien/'),
        sentStatus
      ]
    );
    return { status: sentStatus, email: cleanEmail, id: res.lastInsertRowid };
  } catch (logErr) {
    console.error('[DE-TAI-CAP-VIEN][EMAIL-LOG]', logErr && logErr.message ? logErr.message : logErr);
    return { status: sentStatus, email: cleanEmail };
  }
}

/** Phát email theo đúng Ma trận sự kiện (tự lọc vai trò bật, tra email thật, gửi SMTP & ghi log) */
async function dispatchEventEmail({
  eventKey,
  subject,
  bodyHtml,
  project = null,
  leaderEmail = null,
  leaderName = null,
  relatedProposalId = null,
  relatedProjectId = null
}) {
  const rules = await getMatrixRules();
  const rule = rules.find((r) => r.event_key === eventKey);
  if (!rule || !rule.enabled) {
    return { sent: 0, skipped: true, reason: 'disabled_in_matrix' };
  }

  const dir = await getRoleEmailDirectory();
  const recipients = new Map(); // email -> { email, name, role }

  for (const roleKey of rule.recipient_roles) {
    if (roleKey === 'CHU_NHIEM') {
      const resolved = resolveLeaderEmail({ leaderEmail, leaderName, project });
      if (resolved) {
        recipients.set(resolved, {
          email: resolved,
          name: leaderName || (project && project.leader_name) || 'Chủ nhiệm đề tài',
          role: 'CHU_NHIEM'
        });
      }
    } else if (dir[roleKey] && dir[roleKey].length > 0) {
      for (const u of dir[roleKey]) {
        if (!recipients.has(u.email)) {
          recipients.set(u.email, { email: u.email, name: u.fullname, role: roleKey });
        }
      }
    }
  }

  if (rule.extra_cc) {
    const extras = rule.extra_cc.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
    for (const em of extras) {
      if (!recipients.has(em)) {
        recipients.set(em, { email: em, name: em, role: 'CC' });
      }
    }
  }

  let sentCount = 0;
  const results = [];
  for (const rec of recipients.values()) {
    const r = await sendAndLogSingleEmail({
      eventType: eventKey,
      recipientEmail: rec.email,
      recipientName: rec.name,
      recipientRole: rec.role,
      subject,
      bodyHtml,
      relatedProposalId,
      relatedProjectId: relatedProjectId || (project ? project.id : null)
    });
    results.push(r);
    sentCount++;
  }

  return { sent: sentCount, results };
}

function isSmtpConfigured() {
  return !!(runtimeCtx.transporter && typeof runtimeCtx.transporter.sendMail === 'function');
}

module.exports = {
  EMAIL_EVENT_MATRIX_DEFAULT,
  configure,
  getMatrixRules,
  saveMatrixRule,
  getRoleEmailDirectory,
  resolveLeaderEmail,
  sendAndLogSingleEmail,
  dispatchEventEmail,
  isSmtpConfigured,
  getBaseModuleUrl
};
