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
    isUserMasterAdmin,
  } = ctx;

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
      const isAdmin =
        roleLower === 'admin' ||
        (typeof isUserMasterAdmin === 'function' && !!isUserMasterAdmin(row));

      req.eofficeUser = {
        id: row.id,
        email: row.email || '',
        fullname: (row.fullname && String(row.fullname).trim()) || row.email || 'Người dùng',
        role: roleLower,
        isAdmin,
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

module.exports = { mount, miniStats };
