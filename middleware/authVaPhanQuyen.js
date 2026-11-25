/**
 * Middleware xác thực JWT/cookie, phân quyền theo vai trò, log hoạt động và kiểm tra khóa tài khoản.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const jwt = require('jsonwebtoken');
const db = require('../lib/db-bridge');

module.exports = function createAuthAndRoleMiddleware({ ADMIN_EMAIL, JWT_SECRET }) {
  function getCookieFromReq(req, name) {
    const raw = req.headers.cookie || '';
    const parts = raw.split(';');
    for (const p of parts) {
      const i = p.indexOf('=');
      if (i === -1) continue;
      const k = p.slice(0, i).trim();
      if (k !== name) continue;
      try {
        return decodeURIComponent(p.slice(i + 1).trim());
      } catch (e) {
        return p.slice(i + 1).trim();
      }
    }
    return '';
  }

  /** JWT từ Authorization: Bearer, cookie HttpOnly, hoặc ?token= (EventSource không gửi header). */
  function getTokenFromReq(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const c = getCookieFromReq(req, 'auth_token');
    if (c) return c;
    const q = req.query && req.query.token;
    if (typeof q === 'string' && q.trim()) return q.trim();
    return null;
  }

  function setAuthCookie(res, token) {
    const maxAge = 7 * 24 * 60 * 60;
    const val = encodeURIComponent(token);
    res.append('Set-Cookie', `auth_token=${val}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax`);
  }

  function clearAuthCookie(res) {
    res.append('Set-Cookie', 'auth_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  }

  function clientIpFromReq(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim().slice(0, 128);
    const addr = req.socket && req.socket.remoteAddress;
    return typeof addr === 'string' ? addr.slice(0, 128) : '';
  }

  /** Ghi nhật ký hoạt động (đăng nhập, truy cập trang, v.v.). Không throw. */
  function insertUserActivityLog(req, row) {
    try {
      const ua = (req && req.headers && req.headers['user-agent']) || '';
      const ip = clientIpFromReq(req);
      db.prepare(
        `INSERT INTO user_activity_log (user_id, email, action, module, path, detail, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.userId != null ? Number(row.userId) : null,
        row.email != null ? String(row.email).slice(0, 320) : null,
        String(row.action).slice(0, 120),
        row.module != null ? String(row.module).slice(0, 120) : null,
        row.path != null ? String(row.path).slice(0, 500) : null,
        row.detail != null ? String(row.detail).slice(0, 2000) : null,
        ip || null,
        ua ? String(ua).slice(0, 500) : null
      );
    } catch (e) {
      console.warn('[user_activity_log]', e.message);
    }
  }

  function userIdIsBanned(userId) {
    if (userId == null) return false;
    try {
      const row = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
      return row && Number(row.is_banned) === 1;
    } catch (e) {
      return false;
    }
  }

  const vaiTroHanChe = require('../services/vaiTroHanChe');

  // Vai trò HĐKHCN (chu_tich/thu_ky/thanh_vien/totruong_tham_dinh_tc/thanh_vien_tham_dinh_tc) và Phòng
  // KHCN (phong_khcn) có thể được cấp THÊM cho một user qua bảng council_role_grants, tách biệt khỏi
  // users.role (vai trò hệ thống, vd vien_truong/admin) — để 1 người vừa giữ vai trò hệ thống khác vừa
  // kiêm nhiệm HĐKHCN/Phòng KHCN mà không bị ghi đè mất vai trò nào. Xem module-hoi-dong-khcn admin panel.
  const COUNCIL_ROLE_TOKENS = ['chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc', 'phong_khcn'];

  // Vai trò Tổ thẩm định tài chính — cùng mức bảo vệ "chỉ Master Admin" như vai trò HĐKHCN
  // (councilRoles) ở các route cấp/sửa/xóa vai trò bên dưới.
  const BUDGET_TEAM_ROLES = ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];

  function getCouncilRoleGrants(userId) {
    if (!userId) return [];
    try {
      return db
        .prepare('SELECT role FROM council_role_grants WHERE user_id = ?')
        .all(userId)
        .map((r) => String((r && r.role) || '').trim().toLowerCase())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  /** Set các role "hiệu lực" của 1 user object {id, role}: role hệ thống + mọi council_role_grants. */
  function userEffectiveRoleSet(user) {
    if (!user) return new Set();
    const base = String(user.role || '').trim().toLowerCase();
    const set = new Set(base ? [base] : []);
    getCouncilRoleGrants(user.id).forEach((r) => set.add(r));
    return set;
  }

  /** Như trên nhưng nhận req (req.user) — cache trên req để khỏi query lại nhiều lần / request. */
  function effectiveRoleSet(req) {
    if (!req || !req.user) return new Set();
    if (req._effectiveRoleSet) return req._effectiveRoleSet;
    const set = userEffectiveRoleSet(req.user);
    req._effectiveRoleSet = set;
    return set;
  }

  function roleIs(req, token) {
    return effectiveRoleSet(req).has(String(token || '').trim().toLowerCase());
  }

  function roleIsAny(req, tokens) {
    const set = effectiveRoleSet(req);
    return (tokens || []).some((t) => set.has(String(t || '').trim().toLowerCase()));
  }

  function userHasAnyRole(user, tokens) {
    const set = userEffectiveRoleSet(user);
    return (tokens || []).some((t) => set.has(String(t || '').trim().toLowerCase()));
  }

  /** email của mọi user có 1 trong các role (role hệ thống HOẶC council_role_grants), không trùng lặp. */
  function emailsWithAnyRole(tokens) {
    const wanted = new Set((tokens || []).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean));
    if (!wanted.size) return [];
    try {
      const placeholders = Array.from(wanted).map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT DISTINCT u.email AS email FROM users u
         LEFT JOIN council_role_grants g ON g.user_id = u.id
         WHERE u.role IN (${placeholders}) OR g.role IN (${placeholders})`
        )
        .all(...Array.from(wanted), ...Array.from(wanted));
      return rows.map((r) => r.email).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  /** id/email/fullname/role của mọi user có 1 trong các role (role hệ thống HOẶC council_role_grants). */
  function usersWithAnyRole(tokens) {
    const wanted = new Set((tokens || []).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean));
    if (!wanted.size) return [];
    try {
      const placeholders = Array.from(wanted).map(() => '?').join(',');
      return db
        .prepare(
          `SELECT DISTINCT u.id, u.email, u.fullname, u.role FROM users u
         LEFT JOIN council_role_grants g ON g.user_id = u.id
         WHERE u.role IN (${placeholders}) OR g.role IN (${placeholders})
         ORDER BY u.role, u.fullname, u.email`
        )
        .all(...Array.from(wanted), ...Array.from(wanted));
    } catch (e) {
      return [];
    }
  }

  function authMiddleware(req, res, next) {
    const token = getTokenFromReq(req);
    if (!token) {
      return res.status(401).json({ message: 'Chưa đăng nhập' });
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (userIdIsBanned(payload.id)) {
        return res.status(403).json({ message: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.' });
      }
      let reqUser = payload;
      try {
        const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(payload.id);
        if (row) {
          reqUser = {
            id: row.id,
            email: row.email,
            fullname: row.fullname,
            role: row.role,
          };
        }
      } catch (_) {
        /* giữ payload JWT nếu DB lỗi */
      }
      req.user = reqUser;
      // vai trò chỉ dùng một số module (crd_user, sinh_vien): xem services/vaiTroHanChe.js; kiểm cả vai trò trong token lẫn trong DB
      const p = (req.originalUrl || req.url || '').split('?')[0];
      const loiVaiTro = vaiTroHanChe.kiemTraApi(payload.role, p) || vaiTroHanChe.kiemTraApi(reqUser.role, p);
      if (loiVaiTro) return res.status(403).json({ message: loiVaiTro });
      next();
    } catch (e) {
      return res.status(401).json({ message: 'Phiên đăng nhập hết hạn' });
    }
  }

  /** JWT tuỳ chọn — không có token thì req.user = null (dùng cho chế độ public / kiểm tra quyền). */
  function optionalAuthMiddleware(req, res, next) {
    const token = getTokenFromReq(req);
    if (!token) {
      req.user = null;
      return next();
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (userIdIsBanned(payload.id)) {
        return res.status(403).json({ message: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.' });
      }
      let reqUser = payload;
      try {
        const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(payload.id);
        if (row) {
          reqUser = {
            id: row.id,
            email: row.email,
            fullname: row.fullname,
            role: row.role,
          };
        }
      } catch (_) {}
      req.user = reqUser;
      next();
    } catch (e) {
      req.user = null;
      next();
    }
  }

  /** GET .../dashboard-perms/:id/check dùng optional auth (public analytics có thể không cần đăng nhập). */
  function authUnlessDashboardPermCheck(req, res, next) {
    if (req.method === 'GET' && /^\/[^/]+\/check\/?$/.test(req.path || '')) {
      return optionalAuthMiddleware(req, res, next);
    }
    return authMiddleware(req, res, next);
  }

  function thuyKyOrAdmin(req, res, next) {
    if (!roleIsAny(req, ['admin', 'thu_ky'])) {
      return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới có quyền này' });
    }
    next();
  }

  function chuTichOrAdmin(req, res, next) {
    if (!roleIsAny(req, ['admin', 'chu_tich'])) {
      return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng KHCN hoặc Admin mới có quyền này' });
    }
    next();
  }

  function adminOnly(req, res, next) {
    if ((req.user.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ message: 'Chỉ Admin mới có quyền này' });
    }
    next();
  }

  function userEmailIsMasterAdmin(email) {
    return (email || '').trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
  }

  /**
   * Master Admin = email trùng ADMIN_EMAIL (hằng số / cấu hình triển khai).
   * Không bắt buộc role === 'admin' trong JWT/DB: tránh mất toàn bộ quyền Master
   * (module Thiết bị, cấp Admin, …) khi tài khoản đổi vai trò hoặc dữ liệu role lệch.
   */
  function reqIsMasterAdmin(req) {
    if (!req || !req.user) return false;
    return userEmailIsMasterAdmin(req.user.email);
  }

  function masterAdminOnly(req, res, next) {
    if (!reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được thực hiện thao tác này.' });
    }
    next();
  }

  /** Admin (role) hoặc Master Admin (email) — dùng cho tìm user, phân quyền dashboard, v.v. */
  function adminOrMasterAdminApi(req, res, next) {
    if ((req.user.role || '').toLowerCase() === 'admin') return next();
    if (reqIsMasterAdmin(req)) return next();
    return res.status(403).json({ ok: false, success: false, error: 'Chỉ Admin hoặc Master Admin mới có quyền này' });
  }

  function adminOrPhongKhcn(req, res, next) {
    if (!roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky'])) {
      return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới có quyền này' });
    }
    next();
  }

  /** Chỉ Admin hoặc Phòng KHCN — dùng cho sửa đề tài trên dashboard (không gồm thư ký). */
  function adminOrPhongKhcnMissionEditor(req, res, next) {
    const role = (req.user.role || '').toLowerCase();
    if (role !== 'admin' && role !== 'phong_khcn') {
      return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được cập nhật đề tài qua giao diện này.' });
    }
    next();
  }

  function userHasLoginPassword(pw) {
    return pw != null && String(pw).trim().length > 0;
  }

  return {
    BUDGET_TEAM_ROLES,
    COUNCIL_ROLE_TOKENS,
    adminOnly,
    adminOrMasterAdminApi,
    adminOrPhongKhcn,
    adminOrPhongKhcnMissionEditor,
    authMiddleware,
    authUnlessDashboardPermCheck,
    chuTichOrAdmin,
    clearAuthCookie,
    emailsWithAnyRole,
    getTokenFromReq,
    insertUserActivityLog,
    masterAdminOnly,
    optionalAuthMiddleware,
    reqIsMasterAdmin,
    roleIs,
    roleIsAny,
    setAuthCookie,
    thuyKyOrAdmin,
    userEmailIsMasterAdmin,
    userHasAnyRole,
    userHasLoginPassword,
    userIdIsBanned,
    usersWithAnyRole,
  };
};
