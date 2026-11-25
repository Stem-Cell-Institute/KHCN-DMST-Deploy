/**
 * Điểm gắn (mount) Sub-App «Quản lý Đề tài Cấp Viện» vào Eoffice (server.js).
 * - Bắt buộc đăng nhập Eoffice (JWT cookie/Bearer) cho mọi trang & API của module
 * - Ánh xạ đúng tài khoản & vai trò thật từ bảng users của Eoffice
 * - Chỉ Admin Eoffice mới được quyền dùng chế độ "Đổi vai trò (xem thử)"
 * - Bảo toàn 100% dữ liệu hiện có tại modules/de-tai-cap-vien/data/de-tai-cap-vien.db
 */

const fs = require('fs');
const Database = require('better-sqlite3');
const subapp = require('./subapp');
const config = require('./config/config');
const db = require('./db/db');
const schedulerService = require('./services/schedulerService');
const emailNotificationService = require('./services/emailNotificationService');

let initialized = false;

function isStaticPublicAsset(subPath) {
  return subPath.startsWith('/css/') || subPath.startsWith('/js/');
}

function mount(app, ctx = {}) {
  const {
    db: eofficeDb,
    jwt,
    JWT_SECRET,
    getTokenFromReq,
    userIdIsBanned,
    clearAuthCookie,
    userEmailIsMasterAdmin,
    transporter,
    getSmtpFrom,
    baseUrl,
  } = ctx;

  emailNotificationService.configure({
    transporter: transporter || null,
    getSmtpFrom: typeof getSmtpFrom === 'function' ? getSmtpFrom : null,
    eofficeDb: eofficeDb || null,
    baseUrl: baseUrl || process.env.BASE_URL || 'https://eoffice.sci.edu.vn',
  });

  // Đảm bảo /de-tai-cap-vien luôn có dấu "/" cuối và kiểm tra phiên đăng nhập Eoffice
  app.use('/de-tai-cap-vien', (req, res, next) => {
    const orig = req.originalUrl || '';
    if (orig === '/de-tai-cap-vien' || orig.startsWith('/de-tai-cap-vien?')) {
      return res.redirect(301, '/de-tai-cap-vien/' + orig.slice('/de-tai-cap-vien'.length));
    }

    const subPath = req.path || '/';
    if (isStaticPublicAsset(subPath)) {
      return subapp(req, res, next);
    }

    if (eofficeDb && jwt && JWT_SECRET && typeof getTokenFromReq === 'function') {
      const isApi = subPath.startsWith('/api/');
      const token = getTokenFromReq(req);
      const rejectUnauth = (banned) => {
        if (isApi) {
          return res.status(401).json({
            success: false,
            error: banned ? 'Tài khoản đã bị khóa.' : 'Vui lòng đăng nhập E-Office để sử dụng module.',
          });
        }
        if (banned) {
          if (typeof clearAuthCookie === 'function') clearAuthCookie(res);
          return res.redirect(302, '/dang-nhap.html?banned=1');
        }
        return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(orig || '/de-tai-cap-vien/'));
      };

      if (!token) return rejectUnauth(false);
      let payload;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch (_) {
        return rejectUnauth(false);
      }
      if (!payload || payload.id == null) return rejectUnauth(false);
      if (typeof userIdIsBanned === 'function' && userIdIsBanned(payload.id)) {
        return rejectUnauth(true);
      }

      const row = eofficeDb
        .prepare('SELECT id, email, fullname, role FROM users WHERE id = ?')
        .get(payload.id);
      if (!row) return rejectUnauth(false);

      const roleLower = String(row.role || '').trim().toLowerCase();
      const isMasterAdmin =
        typeof userEmailIsMasterAdmin === 'function'
          ? !!userEmailIsMasterAdmin(row.email)
          : String(row.email || '').trim().toLowerCase() === 'ntsinh0409@gmail.com';
      const isAdmin = isMasterAdmin || roleLower === 'admin';

      // Tra cứu vai trò đã được Admin E-Office gán trong bảng nckh_user_roles (ưu tiên cao nhất)
      let assignedRole = null;
      let assignedTitle = null;
      const dbFile = String(config.DB_URL || '').replace(/^file:/, '');
      if (dbFile && fs.existsSync(dbFile)) {
        let cvConn;
        try {
          cvConn = new Database(dbFile, { readonly: true });
          const assigned = cvConn
            .prepare(
              `SELECT role_key, position_title FROM nckh_user_roles
               WHERE eoffice_user_id = ? OR LOWER(TRIM(email)) = LOWER(TRIM(?))
               LIMIT 1`
            )
            .get(row.id, row.email || '');
          if (assigned && assigned.role_key) {
            assignedRole = String(assigned.role_key).trim();
            assignedTitle = assigned.position_title ? String(assigned.position_title).trim() : null;
          }
        } catch (_) {
          /* bảng nckh_user_roles chưa tạo trong lần khởi động đầu — bỏ qua */
        } finally {
          if (cvConn) {
            try { cvConn.close(); } catch (_) {}
          }
        }
      }

      req.eofficeDb = eofficeDb;
      req.eofficeUser = {
        id: row.id,
        email: row.email || '',
        fullname: (row.fullname && String(row.fullname).trim()) || row.email || 'Người dùng',
        role: roleLower,
        isAdmin,
        isMasterAdmin,
        assignedRole,
        assignedTitle,
      };
    }

    return subapp(req, res, next);
  });

  if (!initialized) {
    initialized = true;
    db.initSchema().catch((err) => {
      console.error('[DE-TAI-CAP-VIEN] Lỗi khởi tạo schema:', err && err.message ? err.message : err);
    });
    if (config.SCHEDULER_ENABLED && !process.env.TEST_PORT) {
      try {
        schedulerService.startDailyScheduler();
      } catch (err) {
        console.warn('[DE-TAI-CAP-VIEN] Không khởi động được scheduler:', err && err.message ? err.message : err);
      }
    }
  }
}

/**
 * Thống kê tóm tắt đồng bộ cho thẻ module trên trang chủ Eoffice.
 * Đọc readonly từ de-tai-cap-vien.db hiện có (không ghi đè, không ảnh hưởng dữ liệu).
 */
function miniStats() {
  const stats = { total: 0, inProgress: 0, completed: 0 };
  const dbFile = String(config.DB_URL || '').replace(/^file:/, '');
  if (!dbFile || !fs.existsSync(dbFile)) return stats;
  let conn;
  try {
    conn = new Database(dbFile, { readonly: true });
    const count = (sql) => {
      const row = conn.prepare(sql).get();
      return row && row.c != null ? Number(row.c) : 0;
    };
    stats.total = count('SELECT COUNT(*) AS c FROM nckh_projects');
    stats.inProgress = count("SELECT COUNT(*) AS c FROM nckh_projects WHERE UPPER(COALESCE(status, '')) = 'IN_PROGRESS'");
    stats.completed = count("SELECT COUNT(*) AS c FROM nckh_projects WHERE UPPER(COALESCE(status, '')) = 'COMPLETED'");
  } catch (e) {
    /* bảng chưa khởi tạo hoặc lỗi đọc — giữ 0 */
  } finally {
    if (conn) {
      try { conn.close(); } catch (_) {}
    }
  }
  return stats;
}

const CAP_VIEN_ACTIVE_ACCEPTANCE_STAGES = new Set([
  'REQUESTED',
  'KHCN_CHECKED',
  'COUNCIL_SCHEDULED',
  'COUNCIL_PASSED',
  'REVISION_REQUIRED',
  'REVISION_SUBMITTED',
]);

/**
 * Đọc danh sách đề tài từ Module «Quản lý đề tài cấp Viện» (de-tai-cap-vien.db)
 * ở chế độ readonly và ánh xạ sang cấu trúc bản ghi nhiệm vụ KHCN phục vụ thống kê & báo cáo.
 */
function listProjectsForMissionStats() {
  const dbFile = String(config.DB_URL || '').replace(/^file:/, '');
  if (!dbFile || !fs.existsSync(dbFile)) return [];
  let conn;
  try {
    conn = new Database(dbFile, { readonly: true });
    const projects = conn
      .prepare(
        `SELECT id, code, title, leader_name, category, research_group,
                budget_total, budget_revised, submission_date, decision_date,
                base_end_date, current_end_date, status, contract_number, created_at
         FROM nckh_projects`
      )
      .all();

    const acceptanceStageByProject = new Map();
    try {
      const accRows = conn
        .prepare('SELECT project_id, stage_status FROM nckh_acceptances')
        .all();
      for (const a of accRows) {
        if (a && a.project_id != null) {
          acceptanceStageByProject.set(Number(a.project_id), String(a.stage_status || '').toUpperCase());
        }
      }
    } catch (_) {
      /* bảng nckh_acceptances có thể chưa khởi tạo */
    }

    return (projects || []).map((p) => {
      const rawStatus = String(p.status || 'IN_PROGRESS').trim().toUpperCase();
      const accStage = acceptanceStageByProject.get(Number(p.id)) || '';
      let status = 'dang_thuc_hien';
      let progress = 50;
      if (rawStatus === 'COMPLETED') {
        status = 'hoan_thanh';
        progress = 100;
      } else if (rawStatus === 'CANCELLED') {
        status = 'khong_duoc_phe_duyet';
        progress = 0;
      } else if (rawStatus === 'DRAFT') {
        status = 'planning';
        progress = 10;
      } else if (CAP_VIEN_ACTIVE_ACCEPTANCE_STAGES.has(accStage)) {
        status = 'cho_nghiem_thu_co_so';
        progress = 90;
      }

      const startDate =
        (p.decision_date && String(p.decision_date).trim()) ||
        (p.submission_date && String(p.submission_date).trim()) ||
        (p.created_at ? String(p.created_at).slice(0, 10) : null);
      const endDate =
        (p.current_end_date && String(p.current_end_date).trim()) ||
        (p.base_end_date && String(p.base_end_date).trim()) ||
        null;
      const revised = p.budget_revised != null && Number(p.budget_revised) > 0 ? Number(p.budget_revised) : null;
      const total = p.budget_total != null && Number.isFinite(Number(p.budget_total)) ? Number(p.budget_total) : 0;
      const budget = revised != null ? revised : total;

      return {
        id: null,
        code: String(p.code || '').trim(),
        title: p.title || '',
        principal: p.leader_name || '',
        level: 'institute',
        status,
        start_date: startDate,
        end_date: endDate,
        progress,
        budget,
        managing_agency: 'Viện Tế bào gốc',
        contract_number: p.contract_number || null,
        funding_source: 'Viện Tế bào gốc',
        field: p.research_group || null,
        mission_type: p.category || null,
        source_type: 'cap_vien_module',
        source_id: p.id,
      };
    });
  } catch (e) {
    return [];
  } finally {
    if (conn) {
      try { conn.close(); } catch (_) {}
    }
  }
}

/**
 * Gộp danh sách nhiệm vụ từ bảng `missions` với đề tài cấp Viện từ Module «Quản lý đề tài cấp Viện»,
 * chống trùng theo mã đề tài (code, không phân biệt hoa/thường).
 */
function mergeCapVienModuleMissions(missionRows) {
  const base = Array.isArray(missionRows) ? missionRows : [];
  const capVienRows = listProjectsForMissionStats();
  if (!capVienRows.length) return base;

  const existingCodes = new Set();
  for (const m of base) {
    const c = String((m && m.code) || '').trim().toUpperCase();
    if (c) existingCodes.add(c);
  }

  const merged = base.slice();
  for (const p of capVienRows) {
    const c = String((p && p.code) || '').trim().toUpperCase();
    if (c && existingCodes.has(c)) continue;
    if (c) existingCodes.add(c);
    merged.push(p);
  }
  return merged;
}

module.exports = {
  mount,
  miniStats,
  listProjectsForMissionStats,
  mergeCapVienModuleMissions,
};
