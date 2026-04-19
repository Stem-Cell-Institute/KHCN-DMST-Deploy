/**
 * Backend SCI-ACE
 * - Đăng ký (@sci.edu.vn) + đăng ký chỉ module CRD (mọi email khác, role crd_user)
 * - Nộp hồ sơ (upload), gửi email thông báo Hội đồng
 * - Hội đồng xem/tải hồ sơ
 * - Master Admin = tài khoản đăng nhập có email trùng ADMIN_EMAIL (hằng số trong file). Cấp/gỡ vai trò Admin; Admin phụ: quyền admin API nhưng không cấp/gỡ Admin.
 * 
 * Database: Hỗ trợ SQLite (local) và Turso (Cloudflare)
 * - Local: Sử dụng better-sqlite3
 * - Cloudflare: Sử dụng @libsql/client qua ./lib/db-bridge.js
 */
try { require('dotenv').config({ path: '.env' }); } catch (_) {}
/**
 * Civil time for Vietnam (ICT, UTC+7, no DST). Matches how Google services show "local time" for VN.
 * Set TZ in .env to override. Does not replace OS NTP — sync the host clock if drift is large.
 */
if (!process.env.TZ) {
  process.env.TZ = 'Asia/Ho_Chi_Minh';
}

const path = require('path');
const { startWorker } = require(path.join(__dirname, 'services', 'enrichmentWorker.js'));
const fs = require('fs');
const appPaths = require('./lib/appPaths');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const {
  buildEventPermissionDocBuffer,
  buildEventReportDocBuffer,
  toVietnameseCurrencyWords,
} = require('./services/eventWordBuilder');

// Database - tự động chọn SQLite hoặc Turso dựa trên .env
// Sử dụng ./lib/db-bridge.js thay vì better-sqlite3 trực tiếp
const db = require('./lib/db-bridge');
const {
  CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
  isAllowedTaskCode,
} = require('./lib/capVienPublicTemplatesCatalog');

const app = express();
const PORT = process.env.PORT || 3000;

const BYTES_PER_MB = 1024 * 1024;
/** application/json — không áp dụng multipart/form-data (multer tự đọc stream, không qua express.json). */
const BODY_JSON_LIMIT_STR =
  process.env.BODY_JSON_LIMIT != null && String(process.env.BODY_JSON_LIMIT).trim() !== ''
    ? String(process.env.BODY_JSON_LIMIT).trim()
    : '12mb';
/** Kích thước từng file upload (multipart). Độc lập với BODY_JSON_LIMIT_STR. */
const UPLOAD_FILE_BYTES_SUBMISSION = 20 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_SJR_CSV = 60 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_CAP_PUBLIC_TEMPLATE = 80 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_CAP_VIEN = 200 * BYTES_PER_MB;
/** Trường text không phải file trong multipart (mặc định multer 1MB). Đồng bộ mức với body JSON mặc định. */
const MULTIPART_MAX_FIELD_BYTES = 12 * BYTES_PER_MB;

// Sau reverse proxy (Nginx/Traefik) trên Ubuntu/container: TRUST_PROXY=1 để req.ip / req.secure đúng
(function applyTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw == null || String(raw).trim() === '' || raw === '0' || String(raw).toLowerCase() === 'false') {
    return;
  }
  const n = parseInt(raw, 10);
  app.set('trust proxy', Number.isFinite(n) && n > 0 ? n : 1);
})();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// Lỗi không bắt được trong async / callback — log để vận hành (PM2/Docker) còn dấu vết.
// uncaughtException: trạng thái process không an toàn; nhiều nơi gọi process.exit(1) sau log để tiến trình giám sát tự restart.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.stack || reason : reason);
});

// Giới hạn tốc độ toàn bộ /api/* trước express.json — giảm nguy cơ flood body JSON (RAM/CPU).
(function mountApiRateLimitEarly() {
  const windowMs = Math.max(1000, parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '900000', 10) || 900000);
  const max = Math.max(1, parseInt(process.env.API_RATE_LIMIT_MAX || '400', 10) || 400);
  function getRateLimitKey(req) {
    // Ưu tiên tách theo user đăng nhập để tránh dồn toàn bộ request theo 1 IP/proxy.
    const auth = String(req.headers.authorization || '').trim();
    if (auth.toLowerCase().startsWith('bearer ')) {
      const token = auth.slice(7).trim();
      if (token) {
        try {
          const payload = jwt.decode(token) || {};
          const userKey = payload.uid || payload.userId || payload.id || payload.email || payload.sub;
          if (userKey != null && String(userKey).trim() !== '') {
            return `user:${String(userKey).trim().toLowerCase()}`;
          }
        } catch (_) {}
      }
    }

    // Fallback cho khách chưa đăng nhập: dùng IP (ưu tiên IP client từ proxy nếu có).
    const xff = String(req.headers['x-forwarded-for'] || '').trim();
    const firstForwardedIp = xff ? xff.split(',')[0].trim() : '';
    const ip = firstForwardedIp || req.ip || req.socket?.remoteAddress || 'unknown';
    return `ip:${String(ip).trim().toLowerCase()}`;
  }
  const apiRateLimiter = rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getRateLimitKey,
    message: { message: 'Quá nhiều yêu cầu tới API, vui lòng thử lại sau.' },
  });
  app.use('/api', apiRateLimiter);
})();

// Route kiểm tra sớm nhất (trước middleware)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend đang chạy' });
});

/** Compare OS clock to Google edge HTTP Date (UTC reference). Does not change system time. */
function logServerTimeDriftVsGoogle() {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  fetch('https://www.google.com', { method: 'HEAD', signal: c.signal })
    .then((r) => {
      clearTimeout(t);
      const dh = r.headers.get('date');
      if (!dh) return;
      const skewSec = Math.round((new Date(dh).getTime() - Date.now()) / 1000);
      if (Math.abs(skewSec) > 120) {
        console.warn(
          `[clock] OS clock differs from Google HTTP Date by ~${skewSec}s. Sync system time (Windows: Settings → Time & language) or NTP. Application TZ=${process.env.TZ}`
        );
      }
    })
    .catch(() => {
      clearTimeout(t);
    });
}

// Public: server wall clock vs Google HTTP Date (for diagnostics; ICT via TZ)
app.get('/api/server-time', async (req, res) => {
  const tz = process.env.TZ || 'Asia/Ho_Chi_Minh';
  const payload = {
    timezone: tz,
    serverUtcIso: new Date().toISOString(),
    vietnamWallClock: new Date().toLocaleString('vi-VN', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  };
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch('https://www.google.com', { method: 'HEAD', signal: c.signal });
    clearTimeout(t);
    const dh = r.headers.get('date');
    if (dh) {
      const g = new Date(dh);
      payload.googleHttpDateHeader = dh;
      payload.googleUtcIso = g.toISOString();
      payload.skewSecondsVsGoogle = Math.round((g.getTime() - Date.now()) / 1000);
    }
  } catch (e) {
    payload.googleReferenceError = String(e.message || 'unavailable');
  }
  res.set('Cache-Control', 'no-store');
  res.json(payload);
});

// Favicon: trả 204 để tránh 404 trong Console khi trình duyệt tự gọi /favicon.ico
app.get('/favicon.ico', (req, res) => {
  const favPath = path.join(__dirname, 'favicon.ico');
  if (fs.existsSync(favPath)) return res.sendFile(favPath);
  res.status(204).end();
});

// Route phục vụ logo (đường dẫn tuyệt đối, tránh lỗi khi mở qua server)
const logoPath = path.join(__dirname, 'images', 'logo-vien-te-bao-goc.png');
app.get('/images/logo-vien-te-bao-goc.png', (req, res) => {
  if (fs.existsSync(logoPath)) {
    res.sendFile(logoPath);
  } else {
    res.status(404).send('Logo not found');
  }
});

const JWT_SECRET = String(process.env.JWT_SECRET || '').trim();
if (!JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET chưa được cấu hình trong môi trường (.env hoặc biến hệ thống). Dừng ứng dụng.');
  process.exit(1);
}
const ALLOWED_EMAIL_DOMAIN = '@sci.edu.vn';
/** Chỉ dùng đặt lịch thiết bị CRD — JWT có role này chỉ được gọi /api/crd/* (+ me, logout, health). */
const CRD_ONLY_USER_ROLE = 'crd_user';
/** Giá trị đặc biệt: tin nhắn gửi tới mọi người trong module CRD (kênh chung). */
const CRD_BROADCAST_TO_ID = '__crd_broadcast__';
/** Email Master Admin (nhà phát triển): toàn quyền cấp / gỡ vai trò Admin. Admin khác chỉ là Admin thường. */
const ADMIN_EMAIL = 'ntsinh0409@gmail.com';

// Database đã được khởi tạo từ ./lib/db-bridge.js (dòng trên)
// db-bridge tự động chọn SQLite (local) hoặc Turso (Cloudflare) dựa trên DATABASE_URL trong .env

// Thư mục dữ liệu (DB + upload): mặc định cạnh code; production đặt APP_DATA_DIR để tách khỏi mã nguồn
fs.mkdirSync(appPaths.sqliteDataDir(), { recursive: true });
const uploadDir = appPaths.uploadsRoot();
const uploadDirCapVien = appPaths.uploadsCapVienRoot();
const capVienPublicTemplatesFsDir = appPaths.capVienPublicTemplatesDir();
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(uploadDirCapVien, { recursive: true });
fs.mkdirSync(capVienPublicTemplatesFsDir, { recursive: true });
for (const sub of ['htqt-doan-ra', 'htqt-doan-vao', 'htqt-mou', 'htqt-ytnn', 'events', 'htqt-thoa-thuan', 'dms', 'conference']) {
  fs.mkdirSync(path.join(uploadDir, sub), { recursive: true });
}
fs.mkdirSync(path.join(__dirname, 'templates', 'events'), { recursive: true });
if (appPaths.appDataDir) {
  console.log('[paths] APP_DATA_DIR=' + appPaths.appDataDir + ' | DB dir=' + appPaths.sqliteDataDir() + ' | uploads=' + uploadDir);
}

// --- Giới hạn đường dẫn khi xóa file/thư mục (chống path traversal / xóa nhầm mã nguồn) ---
const RESOLVED_UPLOADS_ROOT = path.resolve(uploadDir);
const RESOLVED_CAP_VIEN_UPLOADS_ROOT = path.resolve(uploadDirCapVien);

/**
 * Chuỗi đường dẫn lưu trong CSDL → file thật trên đĩa.
 * - uploads-cap-vien: có thể xuất hiện ở đầu chuỗi hoặc sau ../ (code /opt/app, file ở APP_DATA_DIR).
 * - public-templates/...: lưu mới (relative tới uploads-cap-vien).
 * - uploads/: thư mục upload chung (missions, htqt, …).
 */
function resolveStoredFileFromDb(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (path.isAbsolute(s)) return path.normalize(path.resolve(s));
  let n = s.replace(/\\/g, '/');
  if (n.startsWith('./')) n = n.slice(2);

  const capMarker = 'uploads-cap-vien/';
  const capIdx = n.indexOf(capMarker);
  if (capIdx !== -1) {
    const rest = n.slice(capIdx + capMarker.length);
    return path.normalize(path.resolve(uploadDirCapVien, rest));
  }

  if (n.startsWith('public-templates/')) {
    return path.normalize(path.resolve(uploadDirCapVien, n));
  }

  if (n.startsWith('uploads/')) {
    return path.normalize(path.resolve(uploadDir, n.slice('uploads/'.length)));
  }
  return path.normalize(path.resolve(uploadDir, n));
}

function pathIsStrictlyInsideResolvedRoot(resolvedRootAbs, candidateAbs) {
  const root = path.resolve(resolvedRootAbs);
  const cand = path.resolve(candidateAbs);
  if (cand === root) return false;
  const rel = path.relative(root, cand);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function downloadPathIsAllowed(normAbs) {
  const norm = path.resolve(normAbs);
  return (
    pathIsStrictlyInsideResolvedRoot(RESOLVED_UPLOADS_ROOT, norm) ||
    pathIsStrictlyInsideResolvedRoot(RESOLVED_CAP_VIEN_UPLOADS_ROOT, norm)
  );
}

/** Kiểm tra path từ DB trước khi res.download (defense-in-depth). Trả { norm } hoặc { err: 403|404 }. */
function normalizeAndCheckDownloadPath(storedPath) {
  const raw = storedPath == null ? '' : String(storedPath).trim();
  if (!raw) return { err: 404 };
  const norm = path.resolve(raw);
  if (!downloadPathIsAllowed(norm)) return { err: 403 };
  try {
    if (!fs.existsSync(norm) || !fs.statSync(norm).isFile()) return { err: 404 };
  } catch (_) {
    return { err: 404 };
  }
  return { norm };
}

function safeDownload(res, storedPath, downloadName) {
  const r = normalizeAndCheckDownloadPath(storedPath);
  if (r.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (r.err) return res.status(404).json({ message: 'File không tồn tại' });
  return res.download(r.norm, downloadName);
}

/** Chuẩn bị danh sách file cho ZIP; đã gửi lỗi thì trả null. */
function prepareDownloadFileList(res, files) {
  const out = [];
  for (let i = 0; i < (files || []).length; i++) {
    const f = files[i];
    const r = normalizeAndCheckDownloadPath(f && f.path);
    if (r.err === 403) {
      res.status(403).json({ message: 'Truy cập bị từ chối' });
      return null;
    }
    if (r.err) {
      res.status(404).json({ message: 'File không tồn tại' });
      return null;
    }
    out.push({ norm: r.norm, originalName: f.originalName });
  }
  return out;
}

/** Chỉ file trong uploads/missions/<missionId>/ (đúng cách lưu khi upload). */
function resolveMissionUploadFileForUnlink(storedPath, missionId) {
  const mid = parseInt(missionId, 10);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const missionRoot = path.resolve(uploadDir, 'missions', String(mid));
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(uploadDir, raw);
  const norm = path.normalize(full);
  if (!pathIsStrictlyInsideResolvedRoot(missionRoot, norm)) return null;
  try {
    if (!fs.existsSync(norm) || !fs.statSync(norm).isFile()) return null;
  } catch (_) {
    return null;
  }
  return norm;
}

/** Chỉ thư mục .../submission_<id>/ nằm trong uploads/ — tránh rmSync nhầm project root. */
function resolveGdSubmissionDirForRmSync(submissionId, sampleFilePathFromDb) {
  const sid = parseInt(submissionId, 10);
  if (!Number.isFinite(sid) || sid <= 0) return null;
  const raw = String(sampleFilePathFromDb || '').trim();
  if (!raw) return null;
  const fileAbs = path.isAbsolute(raw) ? path.resolve(raw) : resolveStoredFileFromDb(raw);
  if (!fileAbs || !pathIsStrictlyInsideResolvedRoot(RESOLVED_UPLOADS_ROOT, fileAbs)) return null;
  const dir = path.dirname(fileAbs);
  if (path.basename(dir) !== 'submission_' + sid) return null;
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return dir;
}

function resolveEventUploadFileForUnlink(storedPath, eventId) {
  const eid = parseInt(eventId, 10);
  if (!Number.isFinite(eid) || eid <= 0) return null;
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const eventRoot = path.resolve(uploadDir, 'events', String(eid));
  const full = resolveStoredFileFromDb(raw);
  if (!full) return null;
  const norm = full;
  if (!pathIsStrictlyInsideResolvedRoot(eventRoot, norm)) return null;
  try {
    if (!fs.existsSync(norm) || !fs.statSync(norm).isFile()) return null;
  } catch (_) {
    return null;
  }
  return norm;
}

function coopHtqtVanBanUnlinkRoots() {
  return [
    path.resolve(uploadDir, 'htqt-doan-ra'),
    path.resolve(uploadDir, 'htqt-doan-vao'),
    path.resolve(uploadDir, 'htqt-mou'),
    path.resolve(uploadDir, 'htqt-ytnn'),
    path.resolve(uploadDir, 'htqt-thoa-thuan'),
  ];
}

function resolveCoopVanBanWordFileForUnlink(storedPath) {
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const full = resolveStoredFileFromDb(raw);
  if (!full) return null;
  const norm = full;
  for (const root of coopHtqtVanBanUnlinkRoots()) {
    if (pathIsStrictlyInsideResolvedRoot(root, norm)) {
      try {
        if (fs.existsSync(norm) && fs.statSync(norm).isFile()) return norm;
      } catch (_) {
        return null;
      }
      return null;
    }
  }
  return null;
}

function resolveCapVienPublicTemplateStoredFileForUnlink(storedPath) {
  const root = path.resolve(capVienPublicTemplatesFsDir);
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const full = resolveStoredFileFromDb(raw);
  if (!full) return null;
  const norm = full;
  if (!pathIsStrictlyInsideResolvedRoot(root, norm)) return null;
  try {
    if (fs.existsSync(norm) && fs.statSync(norm).isFile()) return norm;
  } catch (_) {
    return null;
  }
  return null;
}

// Đề tài cấp Viện: cùng file sci-ace.db (gom DB). File de-tai-cap-vien.db cũ được migrate một lần khi khởi động.
const legacyCapVienDbPath = path.join(appPaths.sqliteDataDir(), 'de-tai-cap-vien.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    submittedBy TEXT NOT NULL,
    submittedById INTEGER NOT NULL,
    status TEXT DEFAULT 'SUBMITTED',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cap_vien_submission_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    fieldName TEXT NOT NULL,
    originalName TEXT NOT NULL,
    path TEXT NOT NULL,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_public_template_files (
    task_code TEXT PRIMARY KEY,
    stored_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by_id INTEGER
  );
`);
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewNote TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN revisionRound INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedByRole TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_step2_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    actionType TEXT NOT NULL,
    performedAt TEXT NOT NULL,
    performedById INTEGER,
    performedByName TEXT,
    performedByRole TEXT,
    note TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submission_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    stepId TEXT NOT NULL,
    actionType TEXT NOT NULL,
    performedAt TEXT NOT NULL,
    performedById INTEGER,
    performedByName TEXT,
    performedByRole TEXT,
    note TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_step_deadlines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    stepId TEXT NOT NULL,
    openedAt TEXT NOT NULL,
    dueAt TEXT NOT NULL,
    durationDays INTEGER,
    updatedById INTEGER,
    updatedAt TEXT NOT NULL,
    UNIQUE(submissionId, stepId),
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  )
`);
try { db.prepare('ALTER TABLE users ADD COLUMN academicTitle TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try {
  db.prepare('UPDATE users SET password_support_hint = NULL WHERE password_support_hint IS NOT NULL').run();
} catch (e) { /* không có cột password_support_hint */ }
try {
  db.exec('ALTER TABLE users DROP COLUMN password_support_hint');
} catch (e) { /* SQLite < 3.35 hoặc cột đã xóa / chưa từng có */ }

// ─── CRD Lab Booking (đặt lịch thiết bị) ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS crd_machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT,
    location TEXT,
    color TEXT DEFAULT '#667eea',
    avail_from INTEGER DEFAULT 8,
    avail_to INTEGER DEFAULT 20,
    max_hours INTEGER DEFAULT 4,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS crd_persons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT DEFAULT 'user',
    avatar TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS crd_bookings (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    date TEXT NOT NULL,
    start_h REAL NOT NULL,
    end_h REAL NOT NULL,
    purpose TEXT,
    status TEXT DEFAULT 'confirmed',
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS crd_chats (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    booking_id TEXT,
    msg TEXT NOT NULL,
    ts INTEGER NOT NULL,
    read_flag INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS crd_complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id TEXT NOT NULL,
    against_id TEXT,
    booking_id TEXT,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    admin_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS crd_role_defs (
    slug TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_admin_slot INTEGER DEFAULT 0
  );
`);
try {
  const insRd = db.prepare(
    'INSERT OR IGNORE INTO crd_role_defs (slug, label, sort_order, is_admin_slot) VALUES (?,?,?,?)'
  );
  insRd.run('user', 'Researcher', 0, 0);
  insRd.run('admin', 'Admin CRD', 1, 1);
} catch (e) {
  /* ignore */
}

function crdMachineToClient(r) {
  if (!r) return null;
  const af = r.avail_from != null ? Number(r.avail_from) : null;
  const at = r.avail_to != null ? Number(r.avail_to) : null;
  return {
    id: r.id,
    name: r.name,
    type: r.type || '',
    location: r.location || '',
    color: r.color || '#667eea',
    availFrom: Number.isFinite(af) ? af : null,
    availTo: Number.isFinite(at) ? at : null,
    maxHours: r.max_hours != null ? Number(r.max_hours) : null,
    desc: r.description || '',
    sort_order: r.sort_order != null ? r.sort_order : 0
  };
}
function crdPersonToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    email: r.email || '',
    role: r.role || 'user',
    avatar: r.avatar || '?',
    isBanned: Number(r.is_banned) === 1,
    crdAccessRevoked: Number(r.crd_access_revoked) === 1
  };
}

/** null nếu được phép dùng CRD; chuỗi lý do nếu bị chặn */
function crdPersonBlockedForUse(personId) {
  if (!personId) return 'Không xác định người dùng CRD';
  const row = db.prepare('SELECT is_banned, crd_access_revoked FROM crd_persons WHERE id = ?').get(personId);
  if (!row) return 'Không tìm thấy hồ sơ CRD';
  if (Number(row.crd_access_revoked) === 1) return 'Hồ sơ CRD đã bị gỡ. Liên hệ quản trị để kích hoạt lại.';
  if (Number(row.is_banned) === 1) return 'Tài khoản CRD đang bị tạm khoá.';
  return null;
}

/** Người có vai trò CRD gắn cờ Quản trị (vd Admin CRD) — dùng kiểm duyệt kênh chung */
function crdPersonHasModeratorSlot(personId) {
  if (!personId) return false;
  const p = db.prepare('SELECT role FROM crd_persons WHERE id = ?').get(personId);
  if (!p) return false;
  const slug = String(p.role || '')
    .trim()
    .toLowerCase();
  const rd = db.prepare('SELECT is_admin_slot FROM crd_role_defs WHERE slug = ?').get(slug);
  return rd && Number(rd.is_admin_slot) === 1;
}
function crdBookingToClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    machineId: r.machine_id,
    userId: r.person_id,
    date: r.date,
    startH: r.start_h,
    endH: r.end_h,
    purpose: r.purpose || '',
    researchGroup: r.research_group != null ? String(r.research_group) : '',
    status: r.status || 'confirmed'
  };
}
function crdChatToClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    fromId: r.from_id,
    toId: r.to_id,
    bookingId: r.booking_id || null,
    msg: r.msg,
    ts: r.ts,
    read: !!r.read_flag,
    isDeleted: !!r.is_deleted
  };
}

function crdRoleDefsToClient() {
  return db
    .prepare('SELECT slug, label, sort_order AS sortOrder, is_admin_slot AS isAdminSlot FROM crd_role_defs ORDER BY sort_order ASC, slug ASC')
    .all()
    .map((r) => ({
      slug: r.slug,
      label: r.label,
      sortOrder: r.sortOrder != null ? Number(r.sortOrder) : 0,
      isAdminSlot: !!r.isAdminSlot
    }));
}

function crdRoleSlugValid(slug) {
  if (!slug) return false;
  return !!db.prepare('SELECT 1 FROM crd_role_defs WHERE slug = ?').get(slug);
}

function crdSeedIfEmpty() {
  const n = db.prepare('SELECT COUNT(*) AS c FROM crd_machines').get();
  if (n && n.c > 0) return;
  const todayStr = new Date().toISOString().split('T')[0];
  const insM = db.prepare(
    'INSERT INTO crd_machines (id,name,type,location,color,avail_from,avail_to,max_hours,description,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  [
    ['m1', 'SEM-7000', 'Kính hiển vi điện tử quét', 'Lab A-01', '#667eea', 8, 20, 4, 'Scanning Electron Microscope', 1],
    ['m2', 'XRD-Pro', 'Máy nhiễu xạ tia X', 'Lab A-02', '#764ba2', 7, 22, 6, 'X-Ray Diffractometer', 2],
    ['m3', 'FTIR-4000', 'Máy quang phổ hồng ngoại', 'Lab B-01', '#4caf88', 8, 18, 3, 'FTIR', 3],
    ['m4', 'TEM-HiRes', 'Kính hiển vi điện tử truyền qua', 'Lab B-02', '#f5a623', 9, 17, 2, 'TEM', 4],
    ['m5', 'Rheometer-AR', 'Máy đo lưu biến', 'Lab C-01', '#e05c6a', 8, 20, 5, 'Rheometer', 5]
  ].forEach(row => insM.run(...row));
  const insP = db.prepare('INSERT INTO crd_persons (id,name,email,role,avatar) VALUES (?,?,?,?,?)');
  [
    ['u_admin', 'Admin CRD', 'admin@crd.edu.vn', 'admin', 'A'],
    ['u1', 'Nguyễn Minh Khoa', 'khoa@crd.edu.vn', 'user', 'K'],
    ['u2', 'Trần Thị Lan', 'lan@crd.edu.vn', 'user', 'L'],
    ['u3', 'Lê Văn Hùng', 'hung@crd.edu.vn', 'user', 'H']
  ].forEach(row => insP.run(...row));
  const insB = db.prepare(
    'INSERT INTO crd_bookings (id,machine_id,person_id,date,start_h,end_h,purpose,status) VALUES (?,?,?,?,?,?,?,?)'
  );
  insB.run('b1', 'm1', 'u1', todayStr, 9, 11, 'Phân tích vật liệu nano', 'confirmed');
  insB.run('b2', 'm2', 'u2', todayStr, 13, 16, 'Phân tích cấu trúc tinh thể', 'confirmed');
  insB.run('b3', 'm3', 'u3', todayStr, 10, 12, 'Nghiên cứu polymer', 'confirmed');
  const ts = Date.now();
  db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
    'c1', 'u1', 'u2', 'b2', 'Chào bạn, mình cần dùng XRD lúc 14h–15h, bạn có thể dời sang 15h không?', ts - 3600000, 0
  );
  db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
    'c2', 'u2', 'u1', 'b2', 'Mình xem lại lịch nhé.', ts - 1800000, 1
  );
  console.log('[CRD] Đã seed dữ liệu mặc định đặt lịch thiết bị.');
}
try {
  crdSeedIfEmpty();
} catch (e) {
  console.warn('[CRD] Seed:', e.message);
}

/** Đặt lịch theo bước 30 phút — migrate bảng cũ INTEGER → REAL */
function crdEnsureBookingHalfHourColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(crd_bookings)').all();
    const startCol = cols.find((c) => c.name === 'start_h');
    if (!startCol) return;
    const typ = String(startCol.type || '').toUpperCase();
    if (typ.includes('REAL')) return;

    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE crd_bookings_new (
          id TEXT PRIMARY KEY,
          machine_id TEXT NOT NULL,
          person_id TEXT NOT NULL,
          date TEXT NOT NULL,
          start_h REAL NOT NULL,
          end_h REAL NOT NULL,
          purpose TEXT,
          status TEXT DEFAULT 'confirmed',
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);
      const rows = db.prepare('SELECT * FROM crd_bookings').all();
      const ins = db.prepare(
        'INSERT INTO crd_bookings_new (id,machine_id,person_id,date,start_h,end_h,purpose,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
      );
      for (const r of rows) {
        ins.run(
          r.id,
          r.machine_id,
          r.person_id,
          r.date,
          Number(r.start_h),
          Number(r.end_h),
          r.purpose,
          r.status,
          r.updated_at
        );
      }
      db.exec('DROP TABLE crd_bookings');
      db.exec('ALTER TABLE crd_bookings_new RENAME TO crd_bookings');
    });
    migrate();
    console.log('[CRD] Đã migrate crd_bookings.start_h/end_h → REAL (hỗ trợ 30 phút)');
  } catch (e) {
    console.warn('[CRD] Migrate booking columns:', e.message);
  }
}
try {
  crdEnsureBookingHalfHourColumns();
} catch (e) {
  console.warn('[CRD] crdEnsureBookingHalfHourColumns:', e.message);
}

try {
  db.prepare('ALTER TABLE crd_bookings ADD COLUMN research_group TEXT').run();
} catch (e) {
  /* cột đã tồn tại */
}

/**
 * Cho phép ALTER ... ADD COLUMN chỉ với (bảng, cột, định nghĩa kiểu) đã khai báo — tránh SQL injection nếu sau này gọi từ input.
 * Khi thêm migration cột mới: bổ sung Map tương ứng bên dưới.
 */
const CRD_ENSURE_COLUMN_ALLOWED = new Map([
  [
    'crd_bookings',
    new Map([
      ['created_at', new Set(['TEXT'])],
      ['research_group', new Set(['TEXT'])],
    ]),
  ],
]);

function crdEnsureColumnIsWhitelisted(tableName, columnName, columnDefSql) {
  const table = String(tableName || '').trim().toLowerCase();
  const col = String(columnName || '').trim().toLowerCase();
  const def = String(columnDefSql || '').trim().replace(/\s+/g, ' ');
  const byTable = CRD_ENSURE_COLUMN_ALLOWED.get(table);
  if (!byTable) {
    console.warn(`[CRD] Ensure column: bảng không nằm trong whitelist: ${tableName}`);
    return false;
  }
  const allowedDefs = byTable.get(col);
  if (!allowedDefs || !allowedDefs.has(def)) {
    console.warn(
      `[CRD] Ensure column: cột hoặc kiểu SQL không được phép: ${table}.${col} — "${def}"`
    );
    return false;
  }
  return true;
}

function crdQuoteSqlIdent(name) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return null;
  return '"' + s.replace(/"/g, '""') + '"';
}

function crdEnsureColumn(tableName, columnName, columnDefSql) {
  if (!crdEnsureColumnIsWhitelisted(tableName, columnName, columnDefSql)) return false;
  const tableCanon = String(tableName || '').trim().toLowerCase();
  const colCanon = String(columnName || '').trim().toLowerCase();
  const qTable = crdQuoteSqlIdent(tableCanon);
  const qCol = crdQuoteSqlIdent(colCanon);
  if (!qTable || !qCol) {
    console.warn('[CRD] Ensure column: tên bảng/cột không hợp lệ (chỉ chữ, số, gạch dưới).');
    return false;
  }
  const def = String(columnDefSql || '').trim().replace(/\s+/g, ' ');
  try {
    const cols = db.prepare(`PRAGMA table_info(${qTable})`).all();
    const exists = (cols || []).some((c) => String(c.name).toLowerCase() === colCanon);
    if (exists) return true;
    db.prepare(`ALTER TABLE ${qTable} ADD COLUMN ${qCol} ${def}`).run();
    return true;
  } catch (e) {
    console.warn(`[CRD] Ensure column failed: ${tableCanon}.${colCanon}:`, e && e.message ? e.message : String(e));
    return false;
  }
}

crdEnsureColumn(
  'crd_bookings',
  'created_at',
  // SQLite chỉ cho phép default kiểu hằng số khi dùng ALTER TABLE ADD COLUMN.
  // Với datetime('now',...) sẽ fail => thêm cột TEXT trống rồi update sau.
  'TEXT'
);

crdEnsureColumn(
  'crd_bookings',
  'research_group',
  'TEXT'
);

// Nếu bảng đã có created_at (dạng TEXT) nhưng dữ liệu cũ chưa được set, ta điền giá trị hiện tại.
try {
  db.prepare(
    "UPDATE crd_bookings SET created_at = datetime('now','localtime') WHERE created_at IS NULL OR trim(created_at) = ''"
  ).run();
} catch (e) {
  /* ignore */
}
try {
  db.prepare('ALTER TABLE crd_persons ADD COLUMN is_banned INTEGER DEFAULT 0').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.prepare('ALTER TABLE crd_persons ADD COLUMN crd_access_revoked INTEGER DEFAULT 0').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.prepare('ALTER TABLE crd_persons ADD COLUMN user_id INTEGER').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.prepare('ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crd_broadcast_read (
      person_id TEXT PRIMARY KEY,
      last_read_ts INTEGER NOT NULL DEFAULT 0
    );
  `);
} catch (e) {
  console.warn('[CRD] crd_broadcast_read:', e.message);
}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crd_lab_announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
} catch (e) {
  console.warn('[CRD] crd_lab_announcements:', e.message);
}
try {
  db.prepare('ALTER TABLE crd_chats ADD COLUMN is_deleted INTEGER DEFAULT 0').run();
} catch (e) {
  /* cột đã tồn tại */
}
/** CRD — giờ tích lũy & nhật ký bảo trì (migrations/003_crd_maintenance_and_utilization.sql) */
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN accumulated_hours REAL DEFAULT 0').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_threshold_hours REAL DEFAULT 500').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN last_maintenance_date TEXT').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_notes TEXT').run();
} catch (e) {
  /* cột đã tồn tại */
}
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crd_maintenance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT NOT NULL,
      maintenance_date TEXT NOT NULL,
      hours_at_maintenance REAL,
      type TEXT CHECK(type IS NULL OR type IN ('preventive','corrective','calibration')),
      performed_by TEXT,
      cost REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (machine_id) REFERENCES crd_machines(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_crd_maint_log_machine ON crd_maintenance_log(machine_id);
    CREATE INDEX IF NOT EXISTS idx_crd_maint_log_date ON crd_maintenance_log(maintenance_date);
  `);
} catch (e) {
  console.warn('[CRD] crd_maintenance_log:', e.message);
}
try {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS crd_trg_booking_accum_after_update
    AFTER UPDATE OF status ON crd_bookings
    FOR EACH ROW
    WHEN NEW.status = 'completed'
      AND IFNULL(OLD.status, '') != 'completed'
      AND NEW.end_h > NEW.start_h
    BEGIN
      UPDATE crd_machines
      SET accumulated_hours = COALESCE(accumulated_hours, 0) + (NEW.end_h - NEW.start_h)
      WHERE id = NEW.machine_id;
    END;
    CREATE TRIGGER IF NOT EXISTS crd_trg_booking_accum_after_insert
    AFTER INSERT ON crd_bookings
    FOR EACH ROW
    WHEN NEW.status = 'completed' AND NEW.end_h > NEW.start_h
    BEGIN
      UPDATE crd_machines
      SET accumulated_hours = COALESCE(accumulated_hours, 0) + (NEW.end_h - NEW.start_h)
      WHERE id = NEW.machine_id;
    END;
  `);
} catch (e) {
  console.warn('[CRD] triggers accumulated_hours:', e.message);
}
try {
  db.prepare('ALTER TABLE users ADD COLUMN crd_email_notif INTEGER DEFAULT 1').run();
} catch (e) {
  /* cột đã tồn tại */
}
/** Map: personId → [timestamp] cho rate-limiting gửi tin kênh chung */
const crdBroadcastRateMap = new Map(); // cleared when server restarts (in-memory)
const CRD_BROADCAST_RATE_MS = 30_000;  // tối thiểu 30 giây giữa 2 lần gửi
const CRD_BROADCAST_RATE_BURST = 3;     // cho phép burst 3 tin trước khi áp rate

function crdIsHalfHourMark(t) {
  if (!Number.isFinite(t)) return false;
  return Math.abs(Math.round(t * 2) - t * 2) < 1e-5;
}

function insertCapVienStep2History(submissionId, actionType, performedById, performedByRole, note) {
  const performedAt = new Date().toISOString();
  const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
  const performedByName = u ? (u.fullname || u.email || '') : '';
  db.prepare(
    'INSERT INTO cap_vien_step2_history (submissionId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(submissionId, actionType, performedAt, performedById || null, performedByName, performedByRole || null, note || null);
  insertCapVienHistory(submissionId, '2', actionType, performedById, performedByRole, note);
}

function insertCapVienHistory(submissionId, stepId, actionType, performedById, performedByRole, note, performedAtOverride) {
  const performedAt = performedAtOverride || new Date().toISOString();
  const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
  const performedByName = u ? (u.fullname || u.email || '') : '';
  db.prepare(
    'INSERT INTO cap_vien_submission_history (submissionId, stepId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(submissionId, stepId, actionType, performedAt, performedById || null, performedByName, performedByRole || null, note || null);
}

function capVienPeriodicPeriodIsTerminal(status) {
  const s = String(status || '').toLowerCase();
  return s === 'submitted' || s === 'waived' || s === 'bypassed';
}

function insertCapVienPeriodicAdminLog(submissionId, periodId, actionType, reqUser, payloadObj, note) {
  const performedAt = new Date().toISOString();
  const payloadJson = payloadObj != null ? JSON.stringify(payloadObj) : null;
  const role = reqUser && reqUser.role ? String(reqUser.role) : null;
  db.prepare(
    `INSERT INTO cap_vien_periodic_report_admin_log (submissionId, periodId, actionType, payloadJson, note, performedAt, performedById, performedByRole)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(submissionId, periodId || null, actionType, payloadJson, note || null, performedAt, reqUser.id, role);
}

function capVienPeriodicFlatFromStepHistory(stepHistory) {
  const flat = [];
  for (const sid of Object.keys(stepHistory || {})) {
    for (const h of stepHistory[sid] || []) {
      if (!h || !h.performedAt) continue;
      flat.push({ stepId: sid, actionType: h.actionType, performedAt: h.performedAt });
    }
  }
  flat.sort((a, b) => String(a.performedAt).localeCompare(String(b.performedAt)));
  return flat;
}

function capVienResolvePeriodicAnchor(submissionId, row, anchorType, anchorAtCustom, flat) {
  const pickLast = (stepId, actions) => {
    let last = null;
    for (const h of flat) {
      if (h.stepId !== stepId) continue;
      if (actions && !actions.includes(h.actionType)) continue;
      last = h.performedAt;
    }
    return last;
  };
  const t = String(anchorType || '').toLowerCase().trim();
  if (t === 'custom_date' && anchorAtCustom) return anchorAtCustom;
  if (t === 'contract_start') return row.createdAt || null;
  const t7 = pickLast('7', ['step7_complete']);
  if (t7) return t7;
  return row.createdAt || new Date().toISOString();
}

function capVienBuildPeriodicSchedule(anchorIso, cycleMonths, periodCount) {
  const anc = new Date(anchorIso);
  if (Number.isNaN(anc.getTime())) return [];
  const c = Math.max(1, Math.min(24, parseInt(cycleMonths, 10) || 6));
  const n = Math.max(1, Math.min(48, parseInt(periodCount, 10) || Math.min(12, Math.ceil(36 / c))));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const start = new Date(anc.getTime());
    start.setUTCMonth(start.getUTCMonth() + i * c);
    const endExclusive = new Date(anc.getTime());
    endExclusive.setUTCMonth(endExclusive.getUTCMonth() + (i + 1) * c);
    const end = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000);
    const due = end.toISOString();
    rows.push({
      seq: i + 1,
      label: `Kỳ ${i + 1} (${c} tháng)`,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      dueAt: due
    });
  }
  return rows;
}

function getCapVienPeriodicReportBundle(submissionId, includeAdminLog, role) {
  const config = db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(submissionId);
  const periods = db.prepare(
    `SELECT * FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL ORDER BY seq ASC`
  ).all(submissionId);
  const primaryFiles = {};
  for (const p of periods) {
    if (p.primaryFileId) {
      const f = db.prepare(
        'SELECT id, fieldName, originalName, uploadedAt, uploadedById, uploadedByRole FROM cap_vien_submission_files WHERE id = ?'
      ).get(p.primaryFileId);
      if (f) primaryFiles[p.id] = f;
    }
  }
  let adminLog = [];
  if (includeAdminLog && String(role || '').toLowerCase() === 'admin') {
    adminLog = db.prepare(
      `SELECT id, periodId, actionType, payloadJson, note, performedAt, performedById, performedByRole FROM cap_vien_periodic_report_admin_log WHERE submissionId = ? ORDER BY id DESC LIMIT 200`
    ).all(submissionId);
  }
  return { config: config || null, periods, primaryFiles, adminLog };
}

/** Số ngày thực tế (mở bước → hoàn thành / đến hiện tại) — từ lịch sử + deadline + trạng thái */
function computeCapVienStepActualStats(row, stepHistory, stepDeadlines) {
  const flat = [];
  for (const sid of Object.keys(stepHistory || {})) {
    for (const h of stepHistory[sid] || []) {
      if (!h || !h.performedAt) continue;
      flat.push({ stepId: sid, actionType: h.actionType, performedAt: h.performedAt });
    }
  }
  flat.sort((a, b) => String(a.performedAt).localeCompare(String(b.performedAt)));

  const dlOpened = (s) => (stepDeadlines[s] && stepDeadlines[s].openedAt) ? stepDeadlines[s].openedAt : null;
  const st = (row.status || '').toUpperCase();
  const nowIso = new Date().toISOString();

  const pickFirst = (stepId, actions) => {
    for (const h of flat) {
      if (h.stepId !== stepId) continue;
      if (actions && !actions.includes(h.actionType)) continue;
      return h.performedAt;
    }
    return null;
  };
  const pickLast = (stepId, actions) => {
    let last = null;
    for (const h of flat) {
      if (h.stepId !== stepId) continue;
      if (actions && !actions.includes(h.actionType)) continue;
      last = h.performedAt;
    }
    return last;
  };
  const pickAll = (stepId, action) => flat.filter(h => h.stepId === stepId && h.actionType === action).map(h => h.performedAt);

  const daySpan = (fromIso, toIso) => {
    if (!fromIso || !toIso) return null;
    const a = new Date(fromIso).getTime();
    const b = new Date(toIso).getTime();
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    return Math.max(1, Math.ceil((b - a) / (24 * 60 * 60 * 1000)));
  };

  const pack = (openedAt, completedAt, completed) => {
    const end = completed && completedAt ? completedAt : (!completed && openedAt ? nowIso : null);
    const days = openedAt && end ? daySpan(openedAt, end) : null;
    return {
      days,
      completed: !!completed,
      openedAt: openedAt || null,
      completedAt: completed && completedAt ? completedAt : null
    };
  };

  const out = {};

  // Bước 1 — mở: tạo hồ sơ; đóng: nộp hồ sơ
  const s1o = dlOpened('1') || row.createdAt;
  let s1c = pickFirst('1', ['researcher_submit']);
  if (!s1c && st !== 'SUBMITTED' && st !== 'NEED_REVISION') {
    s1c = pickFirst('2', null) || row.createdAt;
  }
  const step1Done = !!s1c || (st !== 'SUBMITTED' && st !== 'NEED_REVISION');
  out['1'] = pack(s1o, s1c, step1Done);

  // Bước 2
  const s2o = dlOpened('2') || s1c || row.createdAt;
  const step2Done = ['VALIDATED', 'ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
  let s2c = pickLast('2', ['secretary_approve']);
  if (!s2c && step2Done && row.reviewedAt && st !== 'NEED_REVISION') s2c = row.reviewedAt;
  if (st === 'NEED_REVISION' || st === 'SUBMITTED') {
    out['2'] = pack(s2o, null, false);
  } else {
    out['2'] = pack(s2o, s2c, step2Done);
  }

  // Bước 3
  const s3o = dlOpened('3') || s2c || s2o;
  let s3c = pickLast('3', ['chairman_assign']);
  if (!s3c && row.assignedAt) s3c = row.assignedAt;
  const step3Done = ['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
  out['3'] = pack(s3o, s3c, step3Done);

  // Bước 4 — đóng: lần PB2 hoàn thành (reviewer_complete thứ 2 theo thời gian)
  const s4o = dlOpened('4') || s3c || s3o;
  const rcTimes = pickAll('4', 'reviewer_complete').sort();
  let s4c = rcTimes.length >= 2 ? rcTimes[1] : null;
  const bothPb = !!(row.step_4_reviewer1_done && row.step_4_reviewer2_done);
  if (!s4c && bothPb && rcTimes.length === 1) s4c = rcTimes[0];
  out['4'] = pack(s4o, s4c, bothPb);

  // Bước 4A
  const s4aO = dlOpened('4a') || pickFirst('4a', ['budget_upload']) || s3c || s3o;
  let s4aC = pickLast('4a', ['budget_approve']);
  const step4aDone = String(row.budget_4a_status || '').toLowerCase() === 'approved';
  if (!s4aC && step4aDone && row.budget_4a_approved_at) s4aC = row.budget_4a_approved_at;
  out['4a'] = pack(s4aO, s4aC, step4aDone);

  // Bước 5 — mở: sau khi đủ điều kiện (max PB2 xong & phê duyệt 4A) hoặc deadline / sự kiện đầu bước 5
  const secondRc = rcTimes.length >= 2 ? rcTimes[1] : null;
  const baTime = pickLast('4a', ['budget_approve']) || (step4aDone && row.budget_4a_approved_at ? row.budget_4a_approved_at : null);
  let s5o = dlOpened('5') || pickFirst('5', null);
  if (!s5o && secondRc && baTime) {
    s5o = new Date(Math.max(new Date(secondRc).getTime(), new Date(baTime).getTime())).toISOString();
  }
  if (!s5o && ['REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st)) {
    s5o = baTime || secondRc || s4aC || s4c || s3c;
  }
  const s5councilPass = pickLast('5', ['step5_council_pass_hd']);
  const step5WorkflowPast = ['CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
  if (s5councilPass) {
    out['5'] = pack(s5o, s5councilPass, true);
  } else if (step5WorkflowPast) {
    out['5'] = { days: null, completed: true, openedAt: s5o || null, completedAt: null };
  } else if (['REVIEWED', 'IN_MEETING'].includes(st)) {
    out['5'] = s5o ? pack(s5o, null, false) : { days: null, completed: false, openedAt: null, completedAt: null };
  } else {
    out['5'] = { days: null, completed: false, openedAt: null, completedAt: null };
  }

  const s7cEthics = pickLast('7', ['step7_complete']);
  const s8o = dlOpened('8') || s7cEthics || null;
  const s8c = pickLast('8', ['step8_complete', 'step8_admin_bypass', 'step8_admin_waive']);
  const step8Done = !!(row.step8_completed === 1 || row.step8_completed === true);
  const step8Waived = !!(row.step8_waived === 1 || row.step8_waived === true);
  out['8'] = pack(s8o, s8c, step8Done || step8Waived);

  try {
    const periods = db.prepare(
      `SELECT seq, status, submittedAt, waivedAt, bypassedAt, periodStart, dueAt FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL ORDER BY seq ASC`
    ).all(row.id);
    if (periods.length > 0) {
      const s10o = dlOpened('10') || periods[0].periodStart || periods[0].dueAt || null;
      const allDone = periods.every((p) => capVienPeriodicPeriodIsTerminal(p.status));
      let s10c = null;
      if (allDone) {
        for (const p of periods) {
          const t =
            String(p.status).toLowerCase() === 'submitted'
              ? p.submittedAt
              : String(p.status).toLowerCase() === 'waived'
                ? p.waivedAt
                : String(p.status).toLowerCase() === 'bypassed'
                  ? p.bypassedAt
                  : null;
          if (t && (!s10c || String(t).localeCompare(String(s10c)) > 0)) s10c = t;
        }
      }
      out['10'] = pack(s10o, s10c, allDone);
    } else if (['IMPLEMENTATION', 'COMPLETED'].includes(st)) {
      out['10'] = pack(dlOpened('10'), null, false);
    }
  } catch (e) {
    /* bảng có thể chưa tạo trên DB cực cũ */
  }

  return out;
}

try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedReviewerIds TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedAt TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedById INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_status TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_round INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('UPDATE cap_vien_submissions SET budget_4a_round = 1 WHERE COALESCE(budget_4a_round, 0) < 1').run(); } catch (e) { /* bỏ qua */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_note TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer1_done INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer2_done INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN code TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN options_checked TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_location TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_attendance TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_documents TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_vote_result TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_decision TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_event_time TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_status TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_round INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('UPDATE cap_vien_submissions SET step5_council_revision_round = 0 WHERE step5_council_revision_round IS NULL').run(); } catch (e) { /* bỏ qua */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_note TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_so_qd TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_kinh_phi TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_thoi_gian TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_phi_quan_ly TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_so_hd TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_hieu_luc TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_ma_dao_duc TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_hieu_luc TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_so_quyet_dinh TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_completed INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_waived INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_completed INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_waived INTEGER DEFAULT 0').run(); } catch (e) { /* đã tồn tại */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_config (
    submissionId INTEGER PRIMARY KEY,
    cycleMonths INTEGER NOT NULL DEFAULT 6,
    anchorType TEXT NOT NULL DEFAULT 'post_step7',
    anchorAt TEXT,
    dueRule TEXT DEFAULT 'end_of_period',
    dueOffsetDays INTEGER DEFAULT 0,
    timezone TEXT DEFAULT 'Asia/Ho_Chi_Minh',
    pauseReportClock INTEGER NOT NULL DEFAULT 0,
    pausedUntil TEXT,
    pauseReason TEXT,
    updatedAt TEXT NOT NULL,
    updatedById INTEGER,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_period (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    label TEXT,
    periodStart TEXT,
    periodEnd TEXT,
    dueAt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    waivedAt TEXT,
    waivedById INTEGER,
    waiveNote TEXT,
    bypassedAt TEXT,
    bypassedById INTEGER,
    bypassNote TEXT,
    submittedAt TEXT,
    primaryFileId INTEGER,
    extraMeta TEXT,
    deletedAt TEXT,
    createdAt TEXT NOT NULL,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id),
    UNIQUE(submissionId, seq)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_period_file (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodId INTEGER NOT NULL,
    fileId INTEGER NOT NULL,
    role TEXT DEFAULT 'main',
    attachedAt TEXT NOT NULL,
    attachedById INTEGER,
    detachedAt TEXT,
    FOREIGN KEY (periodId) REFERENCES cap_vien_periodic_report_period(id),
    FOREIGN KEY (fileId) REFERENCES cap_vien_submission_files(id)
  );
  CREATE TABLE IF NOT EXISTS cap_vien_periodic_report_admin_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    periodId INTEGER,
    actionType TEXT NOT NULL,
    payloadJson TEXT,
    note TEXT,
    performedAt TEXT NOT NULL,
    performedById INTEGER NOT NULL,
    performedByRole TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_cv_prp_sub ON cap_vien_periodic_report_period(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_prp_due ON cap_vien_periodic_report_period(submissionId, dueAt);
  CREATE INDEX IF NOT EXISTS idx_cv_prpal_sub ON cap_vien_periodic_report_admin_log(submissionId);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_submission_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    affects_code INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0
  )
`);
(function seedCapVienOptions() {
  const opts = db.prepare('SELECT id FROM cap_vien_submission_options LIMIT 1').get();
  if (opts) return;
  db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('coe', 'CoE', 1, 1);
  db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('kinh_phi_vien', 'Kinh phí từ Viện Tế bào gốc', 0, 2);
})();

// Bảng danh mục hạng mục đề tài cấp Viện (admin quản trị)
db.exec(`
  CREATE TABLE IF NOT EXISTS cap_vien_linh_vuc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_loai_de_tai (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_don_vi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS cap_vien_khoan_muc_chi (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    parent_code TEXT,
    sort_order INTEGER DEFAULT 0
  )
`);
(function seedCapVienCategories() {
  const hasLv = db.prepare('SELECT id FROM cap_vien_linh_vuc LIMIT 1').get();
  if (!hasLv) {
    const lv = [['stem-cell', 'Tế bào gốc', 1], ['biotechnology', 'Công nghệ sinh học', 2], ['medicine', 'Y sinh học', 3], ['other', 'Khác', 4]];
    lv.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_linh_vuc (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasLdt = db.prepare('SELECT id FROM cap_vien_loai_de_tai LIMIT 1').get();
  if (!hasLdt) {
    const ldt = [['research', 'Đề tài nghiên cứu', 1], ['project', 'Dự án', 2], ['program', 'Chương trình', 3]];
    ldt.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_loai_de_tai (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasKm = db.prepare('SELECT id FROM cap_vien_khoan_muc_chi LIMIT 1').get();
  if (!hasKm) {
    const km = [
      ['1', 'Chi thù lao cho cán bộ khoa học', null, 1],
      ['1.1', 'Chủ nhiệm đề tài', '1', 2],
      ['1.2', 'Thành viên chính', '1', 3],
      ['1.3', 'Kỹ thuật viên/Trợ lý', '1', 4],
      ['2', 'Chi mua vật tư, nguyên liệu', null, 5],
      ['2.1', 'Hóa chất', '2', 6],
      ['2.2', 'Sinh phẩm', '2', 7],
      ['2.3', 'Dụng cụ thí nghiệm tiêu hao', '2', 8],
      ['3', 'Chi mua sắm, sửa chữa tài sản cố định', null, 9],
      ['3.1', 'Thiết bị', '3', 10],
      ['3.2', 'Phần mềm', '3', 11],
      ['4', 'Chi hội nghị, hội thảo, công tác phí', null, 12],
      ['4.1', 'Hội nghị, hội thảo khoa học', '4', 13],
      ['4.2', 'Công tác phí trong nước', '4', 14],
      ['4.3', 'Công tác phí nước ngoài', '4', 15],
      ['5', 'Chi thuê ngoài', null, 16],
      ['5.1', 'Thuê chuyên gia', '5', 17],
      ['5.2', 'Thuê dịch vụ phân tích', '5', 18],
      ['6', 'Chi khác', null, 19],
      ['6.1', 'Chi phí quản lý chung (tối đa 5%)', '6', 20],
      ['6.2', 'Chi phí in ấn, văn phòng phẩm', '6', 21]
    ];
    km.forEach(([c, l, p, o]) => db.prepare('INSERT INTO cap_vien_khoan_muc_chi (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(c, l, p, o));
  }
})();

(function migrateLegacyCapVienIntoMainDb() {
  if (!fs.existsSync(legacyCapVienDbPath)) return;
  const mainSubCount = db.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions').get().n;
  if (mainSubCount > 0) return;
  
  // Legacy database chỉ đọc từ file local, luôn dùng better-sqlite3
  let legacyDb;
  try {
    const LegacyDatabase = require('better-sqlite3');
    legacyDb = new LegacyDatabase(legacyCapVienDbPath, { readonly: true });
  } catch (e) {
    console.warn('[DB] Không mở được de-tai-cap-vien.db để gom vào sci-ace.db:', e.message);
    return;
  }
  let legacySubCount = 0;
  try {
    legacySubCount = legacyDb.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions').get().n;
  } catch (e) {
    legacyDb.close();
    return;
  }
  legacyDb.close();
  if (!legacySubCount) return;
  const capVienTables = [
    'cap_vien_submission_options',
    'cap_vien_linh_vuc',
    'cap_vien_loai_de_tai',
    'cap_vien_don_vi',
    'cap_vien_khoan_muc_chi',
    'cap_vien_submissions',
    'cap_vien_submission_files',
    'cap_vien_step2_history',
    'cap_vien_submission_history'
  ];
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare('ATTACH DATABASE ? AS capvien_legacy').run(legacyCapVienDbPath);
    db.transaction(() => {
      db.exec(`
        DELETE FROM cap_vien_submission_files;
        DELETE FROM cap_vien_step2_history;
        DELETE FROM cap_vien_submission_history;
        DELETE FROM cap_vien_submissions;
        DELETE FROM cap_vien_submission_options;
        DELETE FROM cap_vien_linh_vuc;
        DELETE FROM cap_vien_loai_de_tai;
        DELETE FROM cap_vien_don_vi;
        DELETE FROM cap_vien_khoan_muc_chi;
      `);
      for (const t of capVienTables) {
        const exists = db.prepare("SELECT 1 FROM capvien_legacy.sqlite_master WHERE type = 'table' AND name = ?").get(t);
        if (!exists) continue;
        db.exec('INSERT INTO main.' + t + ' SELECT * FROM capvien_legacy.' + t);
      }
    })();
    db.prepare('DETACH DATABASE capvien_legacy').run();
    const bakPath = legacyCapVienDbPath + '.migrated.' + Date.now() + '.bak';
    fs.renameSync(legacyCapVienDbPath, bakPath);
    console.log('[DB] Đã gom dữ liệu Đề tài cấp Viện từ de-tai-cap-vien.db vào sci-ace.db. File cũ đổi tên:', path.basename(bakPath));
  } catch (e) {
    try { db.prepare('DETACH DATABASE capvien_legacy').run(); } catch (_) {}
    console.error('[DB] Gom de-tai-cap-vien.db thất bại:', e.message || e);
  }
  db.pragma('foreign_keys = ON');
})();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    fullname TEXT,
    role TEXT DEFAULT 'researcher',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    submittedBy TEXT NOT NULL,
    submittedById INTEGER,
    status TEXT DEFAULT 'SUBMITTED',
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (submittedById) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS submission_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    fieldName TEXT NOT NULL,
    originalName TEXT NOT NULL,
    path TEXT NOT NULL,
    FOREIGN KEY (submissionId) REFERENCES submissions(id)
  );
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS notification_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    fullname TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS homepage_modules (
    code TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS user_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    email TEXT,
    action TEXT NOT NULL,
    module TEXT,
    path TEXT,
    detail TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);
try {
  db.prepare('CREATE INDEX IF NOT EXISTS idx_user_activity_log_created ON user_activity_log(created_at DESC)').run();
} catch (e) {}
try {
  db.prepare('CREATE INDEX IF NOT EXISTS idx_user_activity_log_user ON user_activity_log(user_id)').run();
} catch (e) {}
try {
  db.prepare('CREATE INDEX IF NOT EXISTS idx_user_activity_log_action ON user_activity_log(action)').run();
} catch (e) {}

try {
  require('./database/migrations/add_ticker')(db);
} catch (e) {
  console.error('[Ticker migration]', e.message || e);
}
try {
  require('./database/migrations/add_conference_registrations')(db);
} catch (e) {
  console.error('[Conference registrations migration]', e.message || e);
}
try {
  require('./database/migrations/add_homepage_sidebar_rss')(db);
} catch (e) {
  console.error('[Homepage sidebar RSS migration]', e.message || e);
}
try {
  require('./database/migrations/add_homepage_sidebar_rss_html_scrape')(db);
  require('./database/migrations/add_homepage_news_strip_display')(db);
} catch (e) {
  console.error('[Homepage sidebar RSS HTML scrape migration]', e.message || e);
}
try {
  require('./database/migrations/add_cooperation_thoa_thuan_open_term')(db);
} catch (e) {
  console.error('[Cooperation thoa thuan open-term migration]', e.message || e);
}

(function backfillCapVienHistory() {
  const allSubs = db.prepare('SELECT id, status, createdAt, submittedById, reviewedAt, reviewedById, reviewNote, assignedAt, assignedById, assignedReviewerIds FROM cap_vien_submissions').all();
  for (const sub of allSubs) {
    const hasStep1 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '1');
    if (!hasStep1 && sub.createdAt && sub.submittedById) {
      insertCapVienHistory(sub.id, '1', 'researcher_submit', sub.submittedById, 'researcher', 'Nghiên cứu viên nộp hồ sơ đề xuất', sub.createdAt);
    }
    const hasStep2 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '2');
    if (!hasStep2 && sub.reviewedAt && sub.reviewedById) {
      const u = db.prepare('SELECT fullname, role FROM users WHERE id = ?').get(sub.reviewedById);
      const performedByName = u ? (u.fullname || '') : '';
      const role = (u && u.role === 'admin') ? 'admin' : 'secretary';
      const actionType = (sub.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
      const note = sub.reviewNote || (actionType === 'secretary_approve' ? 'Hợp lệ' : null);
      insertCapVienHistory(sub.id, '2', actionType, sub.reviewedById, role, note, sub.reviewedAt);
      const existingStep2 = db.prepare('SELECT 1 FROM cap_vien_step2_history WHERE submissionId = ? LIMIT 1').get(sub.id);
      if (!existingStep2) {
        db.prepare(
          'INSERT INTO cap_vien_step2_history (submissionId, actionType, performedAt, performedById, performedByName, performedByRole, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(sub.id, actionType, sub.reviewedAt, sub.reviewedById, performedByName, role, note);
      }
    }
    const hasStep3 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '3');
    if (!hasStep3 && sub.assignedAt && sub.assignedById) {
      const reviewerIds = (() => { try { return JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) { return []; } })();
      const names = reviewerIds.length ? db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '') : [];
      insertCapVienHistory(sub.id, '3', 'chairman_assign', sub.assignedById, 'chairman', 'Phân công 2 phản biện: ' + names.join(', '), sub.assignedAt);
    }
  }
})();

  try {
    db.prepare("ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'SUBMITTED'").run();
  } catch (e) { /* column đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewNote TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewedAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewedById INTEGER').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedReviewerIds TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedById INTEGER').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignNote TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submission_files ADD COLUMN uploadedAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingNote TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionById INTEGER').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedById INTEGER').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedById INTEGER').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedById INTEGER').run();
  } catch (e) { /* đã tồn tại */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN completedAt TEXT').run();
  } catch (e) { /* đã tồn tại */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS submission_gd5_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submissionId INTEGER NOT NULL,
      actionType TEXT NOT NULL,
      performedAt TEXT NOT NULL,
      performedById INTEGER,
      performedByName TEXT,
      fileFieldName TEXT,
      originalFileName TEXT,
      label TEXT,
      FOREIGN KEY (submissionId) REFERENCES submissions(id)
    )
  `);

// Bảng nhiệm vụ KHCN (dashboard): trích xuất từ đề tài các cấp, đồng bộ từ cap_vien
db.exec(`
  CREATE TABLE IF NOT EXISTS missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    title TEXT NOT NULL,
    principal TEXT,
    level TEXT NOT NULL,
    status TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    progress INTEGER DEFAULT 0,
    budget REAL,
    source_id INTEGER,
    source_type TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_level ON missions(level)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status)').run(); } catch (e) {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_dates ON missions(start_date, end_date)').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN managing_agency TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN contract_number TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN funding_source TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN approved_budget REAL').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN disbursed_budget REAL').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN disbursement_year TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN cooperating_units TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN mission_type TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN field TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN objectives TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_trang_thai TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nguoi_xet_duyet_id INTEGER').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ngay_gui TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ngay_phan_hoi TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ket_qua TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_dieu_kien TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_khoa_hoc TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_kha_thi TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_dinh_huong TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_nhan_xet_nang_luc TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_ly_do_tu_choi TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_lan_xet_thu INTEGER DEFAULT 1').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN buoc3_file_phieu_nhan_xet TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN nhanh TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN principal_hoc_vi TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN principal_don_vi TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN principal_orcid TEXT').run(); } catch (e) {}
try { db.prepare('ALTER TABLE missions ADD COLUMN lan_phan_nhanh INTEGER DEFAULT 1').run(); } catch (e) {}
db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_buoc3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    lan_xet INTEGER NOT NULL DEFAULT 1,
    nguoi_xet_id INTEGER,
    ngay_xet TEXT,
    ket_qua TEXT,
    nhan_xet_json TEXT,
    dieu_kien TEXT,
    ly_do_tu_choi TEXT,
    file_phieu_pdf TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_buoc3_mission ON lich_su_buoc3(mission_id)').run(); } catch (e) {}
db.exec(`
  CREATE TABLE IF NOT EXISTS missions_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    field_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS missions_hidden (
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    PRIMARY KEY (source_type, source_id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS missions_ho_so_ngoai (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    submission_date TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_missions_ho_so_ngoai_mission ON missions_ho_so_ngoai(mission_id)').run(); } catch (e) {}

// Bước 4 Nhánh A — Xét chọn tại Viện & gửi Bộ
db.exec(`
  CREATE TABLE IF NOT EXISTS buoc4a (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    hop_trang_thai TEXT DEFAULT 'chua_len_lich',
    hop_ngay TEXT,
    hop_hinh_thuc TEXT,
    hop_dia_diem TEXT,
    hop_link TEXT,
    thanh_phan_ids TEXT,
    ghi_chu TEXT,
    ngay_hop_thuc_te TEXT,
    hd_ket_luan TEXT,
    noi_dung_chinh_sua TEXT,
    han_chinh_sua TEXT,
    ly_do TEXT,
    nhan_xet TEXT,
    bien_ban_file_id INTEGER,
    thuyet_minh_chinh_sua_ok INTEGER DEFAULT 0,
    trang_thai TEXT DEFAULT 'chua_hop',
    lan_xet_thu INTEGER DEFAULT 1,
    co_quan_nhan TEXT,
    danh_muc_file_id INTEGER,
    ngay_gui TEXT,
    hinh_thuc_gui TEXT,
    nguoi_nhan TEXT,
    gui_ghi_chu TEXT,
    ngay_nhan_ket_qua TEXT,
    ket_qua_bo TEXT,
    bo_noi_dung_yc TEXT,
    bo_han_yc TEXT,
    bo_ly_do TEXT,
    van_ban_bo_file_id INTEGER,
    ket_qua_ghi_chu TEXT,
    lan_gui_thu INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc4a_mission ON buoc4a(mission_id)').run(); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_buoc4a (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    buoc_so INTEGER DEFAULT 4,
    sub_buoc TEXT,
    action TEXT NOT NULL,
    user_id INTEGER,
    timestamp TEXT DEFAULT (datetime('now')),
    data_snapshot TEXT,
    ip_address TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_buoc4a_mission ON lich_su_buoc4a(mission_id)').run(); } catch (e) {}

// Bước 4 Nhánh B — Nộp cơ quan ngoài
db.exec(`
  CREATE TABLE IF NOT EXISTS buoc4b (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    co_quan_nhan TEXT,
    han_nop TEXT,
    ngay_nop_thuc_te TEXT,
    hinh_thuc_nop TEXT,
    ma_ho_so TEXT,
    ghi_chu TEXT,
    trang_thai TEXT DEFAULT 'chua_nop',
    ngay_du_kien_ket_qua TEXT,
    ket_qua TEXT,
    noi_dung_yc TEXT,
    han_yc TEXT,
    ly_do TEXT,
    van_ban_file_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc4b_mission ON buoc4b(mission_id)').run(); } catch (e) {}

// Lịch sử đổi nhánh (reset về Bước 3)
db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_doi_nhanh (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    nhanh_cu TEXT NOT NULL,
    nhanh_moi TEXT NOT NULL,
    cap_cu TEXT,
    cap_moi TEXT,
    ly_do TEXT NOT NULL,
    reset_boi INTEGER,
    reset_luc TEXT DEFAULT (datetime('now')),
    buoc4_snapshot TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id),
    FOREIGN KEY (reset_boi) REFERENCES users(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_doi_nhanh_mission ON lich_su_doi_nhanh(mission_id)').run(); } catch (e) {}

// Lịch sử hành động các bước (generic)
db.exec(`
  CREATE TABLE IF NOT EXISTS lich_su_buoc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    user_id INTEGER,
    timestamp TEXT DEFAULT (datetime('now')),
    note TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_lich_su_buoc_mission ON lich_su_buoc(mission_id)').run(); } catch (e) {}

// Bước 5 — Chờ phê duyệt chính thức & hoàn chỉnh thuyết minh
db.exec(`
  CREATE TABLE IF NOT EXISTS buoc5 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    trang_thai TEXT DEFAULT 'cho_hoan_chinh',
    bo_yeu_cau_chinh_sua TEXT,
    so_qd TEXT,
    ngay_ky_qd TEXT,
    co_quan_ky TEXT,
    qd_file_id INTEGER,
    ma_de_tai_chinh_thuc TEXT,
    kinh_phi REAL,
    thoi_gian_bd TEXT,
    thoi_gian_kt TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc5_mission ON buoc5(mission_id)').run(); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS buoc5_thuyet_minh_ls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    phien_ban TEXT,
    ghi_chu TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    user_id INTEGER,
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc5_tm_mission ON buoc5_thuyet_minh_ls(mission_id)').run(); } catch (e) {}

// Bước 6 — Ký hợp đồng
db.exec(`
  CREATE TABLE IF NOT EXISTS buoc6 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id INTEGER NOT NULL UNIQUE,
    so_hd_ngoai TEXT,
    ngay_ky_ngoai TEXT,
    gia_tri_hd REAL,
    file_hd_ngoai_id INTEGER,
    so_hd_noi_bo TEXT,
    ngay_ky_noi_bo TEXT,
    file_hd_noi_bo_id INTEGER,
    phi_quan_ly REAL,
    phi_override INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (mission_id) REFERENCES missions(id)
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_buoc6_mission ON buoc6(mission_id)').run(); } catch (e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS missions_templates (
    template_type TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Bảng placeholder cho thống kê trang chủ (khi có module tương ứng sẽ thêm cột và dữ liệu)
db.exec(`CREATE TABLE IF NOT EXISTS personnel (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS ip_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
try {
  db.prepare('ALTER TABLE publications ADD COLUMN import_source TEXT DEFAULT NULL').run();
} catch (e) {
  /* cột đã tồn tại */
}
db.exec(`CREATE TABLE IF NOT EXISTS cooperation (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_notification_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    fullname TEXT,
    topics TEXT DEFAULT 'all',
    createdAt TEXT DEFAULT (datetime('now'))
  )
`);
  try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN topics TEXT DEFAULT \'all\'').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN role TEXT').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN quoc_gia TEXT').run(); } catch (e) { /* đã có cột */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN loai_doi_tac TEXT').run(); } catch (e) { /* đã có cột */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_doan_ra (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT,
    muc_dich TEXT,
    quoc_gia TEXT NOT NULL,
    ngay_di TEXT NOT NULL,
    ngay_ve TEXT NOT NULL,
    thanh_vien TEXT,
    nguon_kinh_phi TEXT,
    du_toan TEXT,
    status TEXT NOT NULL DEFAULT 'cho_phong_duyet',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_doan_vao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT,
    muc_dich TEXT,
    don_vi_de_xuat TEXT,
    ngay_den TEXT NOT NULL,
    ngay_roi_di TEXT,
    thanh_phan_doan TEXT,
    noi_dung_lam_viec TEXT,
    kinh_phi_nguon TEXT,
    ho_tro_visa TEXT,
    status TEXT NOT NULL DEFAULT 'cho_tham_dinh',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_thoa_thuan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ten TEXT NOT NULL,
    doi_tac TEXT NOT NULL,
    loai TEXT NOT NULL,
    het_han TEXT,
    trang_thai TEXT NOT NULL DEFAULT 'hieu_luc',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
try {
  db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_expiry_alert_months', '3');
} catch (e) { /* ignore */ }
try {
  db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_max_emails', '3');
} catch (e) { /* ignore */ }
try {
  db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_min_days', '7');
} catch (e) { /* ignore */ }
try {
  db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('cap_vien_step7_complete_send_email', '1');
} catch (e) { /* ignore */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN expiry_alert_sent_at TEXT').run(); } catch (e) { /* đã có cột */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN post_expiry_alert_count INTEGER DEFAULT 0').run(); } catch (e) { /* đã có cột */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN last_post_expiry_alert_at TEXT').run(); } catch (e) { /* đã có cột */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_path TEXT').run(); } catch (e) { /* đã có cột */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_name TEXT').run(); } catch (e) { /* đã có cột */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_uploaded_at TEXT').run(); } catch (e) { /* đã có cột */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    so_van_ban TEXT,
    tieu_de TEXT NOT NULL,
    loai TEXT,
    don_vi_to_chuc TEXT,
    hinh_thuc TEXT,
    link_su_kien TEXT,
    dia_diem TEXT,
    quy_mo INTEGER,
    lich_trinh TEXT,
    muc_tieu TEXT,
    thanh_phan_tham_du TEXT,
    kinh_phi_du_kien REAL,
    nguon_kinh_phi TEXT,
    ngay_bat_dau TEXT,
    ngay_ket_thuc TEXT,
    han_dang_ky TEXT,
    ngay_tao TEXT DEFAULT (datetime('now','localtime')),
    nguoi_tao TEXT,
    trang_thai TEXT DEFAULT 'draft',
    so_nguoi_tham_du_thuc_te INTEGER,
    ket_qua_su_kien TEXT,
    de_xuat_kien_nghi TEXT,
    bai_hoc_kinh_nghiem TEXT,
    uu_diem TEXT,
    han_che TEXT,
    nguoi_phu_trach TEXT,
    phu_trach_lien_he TEXT,
    ghi_chu TEXT,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS event_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    loai_file TEXT NOT NULL,
    ten_file TEXT NOT NULL,
    duong_dan TEXT NOT NULL,
    mo_ta TEXT,
    nguoi_upload TEXT,
    ngay_upload TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (event_id) REFERENCES events(id)
  );
  CREATE TABLE IF NOT EXISTS event_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    ngay TEXT,
    gio_bat_dau TEXT,
    gio_ket_thuc TEXT,
    noi_dung TEXT,
    thu_tu INTEGER,
    FOREIGN KEY (event_id) REFERENCES events(id)
  );
  CREATE TABLE IF NOT EXISTS event_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    note TEXT,
    changed_by_id INTEGER,
    changed_by_name TEXT,
    changed_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (event_id) REFERENCES events(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_mou_de_xuat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submitted_by_email TEXT NOT NULL,
    submitted_by_name TEXT,
    loai_thoa_thuan TEXT,
    ten_doi_tac TEXT,
    quoc_gia TEXT,
    thoi_han_nam TEXT,
    gia_tri_tai_chinh TEXT,
    don_vi_de_xuat TEXT,
    noi_dung_hop_tac TEXT,
    status TEXT NOT NULL DEFAULT 'dang_tham_dinh',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// Đề xuất tiếp nhận tài chính YTNN (Chương VII Quy chế KHCN-ĐMST SCI 2026)
db.exec(`
  CREATE TABLE IF NOT EXISTS htqt_de_xuat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ma_de_xuat TEXT,
    ten TEXT NOT NULL,
    mo_ta TEXT,
    doi_tac_ten TEXT,
    doi_tac_quoc_gia TEXT,
    doi_tac_nguoi_dai_dien TEXT,
    doi_tac_website TEXT,
    hinh_thuc_hop_tac TEXT,
    chu_nhiem_ten TEXT,
    chu_nhiem_hoc_vi TEXT,
    chu_nhiem_don_vi TEXT,
    thanh_vien_json TEXT,
    ngay_bat_dau TEXT,
    ngay_ket_thuc TEXT,
    thoi_gian_thang INTEGER,
    kinh_phi REAL,
    don_vi_tien_te TEXT DEFAULT 'VNĐ',
    kinh_phi_vnd REAL,
    loai_hinh TEXT,
    to_phan_loai_json TEXT,
    to_trinh_phong_khcn TEXT,
    de_nghi_vt TEXT,
    vt_y_kien TEXT,
    vt_ngay_ky TEXT,
    vt_so_van_ban TEXT,
    vt_nguoi_ky_id INTEGER,
    ly_do_khong_duyet TEXT,
    han_xu_ly_vt TEXT,
    muc_do_uu_tien TEXT DEFAULT 'binh_thuong',
    ghi_chu_noi_bo TEXT,
    nguoi_phu_trach_id INTEGER,
    phi_quan_ly_pct REAL,
    phi_quan_ly_vnd REAL,
    submitted_by_email TEXT,
    submitted_by_name TEXT,
    submitted_by_id INTEGER,
    status TEXT NOT NULL DEFAULT 'cho_phan_loai',
    ngay_tiep_nhan TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS htqt_de_xuat_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    de_xuat_id INTEGER NOT NULL,
    loai_file TEXT,
    ten_file TEXT,
    duong_dan TEXT,
    uploaded_by_id INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (de_xuat_id) REFERENCES htqt_de_xuat(id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS htqt_de_xuat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    de_xuat_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    performed_by_id INTEGER,
    performed_by_name TEXT,
    performed_at TEXT DEFAULT (datetime('now')),
    note TEXT,
    metadata TEXT,
    FOREIGN KEY (de_xuat_id) REFERENCES htqt_de_xuat(id)
  )
`);

function syncMissionsFromCapVien() {
  // Chỉ dọn missions_hidden «mồ côi» (hồ sơ đã không còn trong cap_vien_submissions).
  // KHÔNG xóa ẩn cho hồ sơ vẫn tồn tại — nếu không, sau khi Admin xóa nhiệm vụ khỏi dashboard
  // (ghi missions_hidden), mỗi lần GET /api/missions sẽ gỡ ẩn và INSERT lại missions từ cap_vien (lỗi «đã xóa mà vẫn hiện»).
  // Khôi phục đầy đủ từ nguồn: POST /api/admin/missions/sync-from-cap-vien (xóa toàn bộ missions_hidden cap_vien).
  try {
    db.prepare(
      `DELETE FROM missions_hidden WHERE source_type = 'cap_vien' AND source_id NOT IN (SELECT id FROM cap_vien_submissions)`
    ).run();
  } catch (e) {
    /* bảng có thể chưa có */
  }
  const rows = db.prepare('SELECT id, title, submittedById, status, createdAt, code FROM cap_vien_submissions').all();
  const hidden = new Set(
    db.prepare("SELECT source_type || ':' || source_id AS k FROM missions_hidden").all().map(r => r.k)
  );
  const statusMap = {
    SUBMITTED: 'planning',
    NEED_REVISION: 'planning',
    CONDITIONAL: 'approved',
    VALIDATED: 'approved',
    REVIEWED: 'ongoing',
    IN_MEETING: 'ongoing',
    APPROVED: 'ongoing',
    IMPLEMENTATION: 'ongoing',
    COMPLETED: 'completed',
    REJECTED: 'planning'
  };
  const now = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    if (hidden.has('cap_vien:' + r.id)) continue;
    const code = r.code || ('DTSCI-' + (r.createdAt || '').slice(0, 4) + '-' + String(r.id).padStart(3, '0'));
    const principal = (r.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById) : null);
    const principalName = principal ? (principal.fullname || '') : '';
    const status = statusMap[(r.status || '').toUpperCase()] || 'planning';
    let startDate = (r.createdAt || '').toString().slice(0, 10);
    if (!startDate) startDate = now;
    const end = new Date(startDate);
    end.setFullYear(end.getFullYear() + 2);
    const endDate = end.toISOString().slice(0, 10);
    const progress = status === 'completed' ? 100 : (status === 'planning' ? 5 : 35);
    const existing = db.prepare('SELECT id FROM missions WHERE source_type = ? AND source_id = ?').get('cap_vien', r.id);
    if (existing) {
      db.prepare(
        `UPDATE missions SET code=?, title=?, principal=?, status=?, start_date=?, end_date=?, progress=? WHERE source_type='cap_vien' AND source_id=?`
      ).run(code, r.title || '', principalName, status, startDate, endDate, progress, r.id);
    } else {
      db.prepare(
        `INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type) VALUES (?, ?, ?, 'institute', ?, ?, ?, ?, NULL, ?, 'cap_vien')`
      ).run(code, r.title || '', principalName, status, startDate, endDate, progress, r.id);
    }
  }
}

/**
 * Xóa đề tài khỏi dashboard và mọi bản ghi phụ thuộc (SQLite foreign_keys = ON).
 * Thứ tự: bảng tham chiếu missions(id) trước, cuối cùng missions.
 */
function deleteMissionCascade(missionId) {
  const mid = parseInt(missionId, 10);
  if (!mid || isNaN(mid)) throw new Error('INVALID_MISSION_ID');
  const pathsToRemove = [];
  try {
    const mf = db.prepare('SELECT path FROM missions_files WHERE mission_id = ?').all(mid);
    for (const r of mf) {
      if (r && r.path) pathsToRemove.push(String(r.path));
    }
  } catch (e) {
    /* bảng có thể chưa tồn tại trên DB cũ */
  }
  try {
    const hs = db.prepare('SELECT path FROM missions_ho_so_ngoai WHERE mission_id = ?').all(mid);
    for (const r of hs) {
      if (r && r.path) pathsToRemove.push(String(r.path));
    }
  } catch (e) {}
  const stmts = [
    'DELETE FROM lich_su_buoc4a WHERE mission_id = ?',
    'DELETE FROM buoc4a WHERE mission_id = ?',
    'DELETE FROM lich_su_buoc3 WHERE mission_id = ?',
    'DELETE FROM buoc4b WHERE mission_id = ?',
    'DELETE FROM lich_su_doi_nhanh WHERE mission_id = ?',
    'DELETE FROM lich_su_buoc WHERE mission_id = ?',
    'DELETE FROM buoc5_thuyet_minh_ls WHERE mission_id = ?',
    'DELETE FROM buoc5 WHERE mission_id = ?',
    'DELETE FROM buoc6 WHERE mission_id = ?',
    'DELETE FROM missions_files WHERE mission_id = ?',
    'DELETE FROM missions_ho_so_ngoai WHERE mission_id = ?',
    'DELETE FROM missions WHERE id = ?',
  ];
  db.transaction(() => {
    for (const sql of stmts) {
      try {
        db.prepare(sql).run(mid);
      } catch (e) {
        const msg = e && e.message ? String(e.message) : '';
        if (msg.includes('no such table')) continue;
        throw e;
      }
    }
  })();
  for (const rel of pathsToRemove) {
    try {
      const abs = resolveMissionUploadFileForUnlink(rel, mid);
      if (abs) fs.unlinkSync(abs);
    } catch (eUn) {
      /* bỏ qua file không xóa được */
    }
  }
}

function resolveCapVienUploadRoot() {
  return path.resolve(uploadDirCapVien);
}

/** Chỉ chấp nhận đường dẫn nằm trong uploads-cap-vien — tránh xóa nhầm mã nguồn (server.js, …). */
function normalizePathUnderCapVienUploads(relOrAbs) {
  const root = resolveCapVienUploadRoot();
  let full = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : resolveStoredFileFromDb(relOrAbs);
  if (!full && relOrAbs != null && String(relOrAbs).trim()) {
    full = path.resolve(uploadDirCapVien, String(relOrAbs).trim());
  }
  if (!full) return null;
  const norm = path.normalize(full);
  if (norm !== root && !norm.startsWith(root + path.sep)) return null;
  return norm;
}

function safeUnlinkCapVienStoredFile(storedPath) {
  try {
    const norm = normalizePathUnderCapVienUploads(storedPath);
    if (!norm || !fs.existsSync(norm)) return;
    const st = fs.statSync(norm);
    if (!st.isFile()) return;
    fs.unlinkSync(norm);
  } catch (_) {}
}

/**
 * Xóa hoàn toàn một hồ sơ đề tài cấp Viện khỏi toàn hệ thống:
 * — mọi missions (dashboard) trỏ tới cap_vien + source_id (cascade buoc*, missions_files…)
 * — missions_hidden, bảng cap_vien (file, lịch sử, deadline, submission)
 * — thư mục upload trên đĩa (nếu có)
 * Dùng cho Admin: nút Xóa ở Quản lý nhiệm vụ và DELETE /api/cap-vien/submissions/:id
 */
function deleteCapVienSubmissionCascade(submissionId) {
  const sid = parseInt(submissionId, 10);
  if (!sid || isNaN(sid)) throw new Error('INVALID_CAP_VIEN_SUBMISSION_ID');
  const subRow = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(sid);
  let missionRows = [];
  try {
    missionRows = db.prepare('SELECT id FROM missions WHERE source_type = ? AND source_id = ?').all('cap_vien', sid);
  } catch (e) {
    missionRows = [];
  }
  if (!subRow && (!missionRows || missionRows.length === 0)) {
    try {
      db.prepare('DELETE FROM missions_hidden WHERE source_type = ? AND source_id = ?').run('cap_vien', sid);
    } catch (eH) {}
    throw new Error('CAP_VIEN_SUBMISSION_NOT_FOUND');
  }
  for (const r of missionRows) {
    if (r && r.id) deleteMissionCascade(r.id);
  }
  try {
    db.prepare('DELETE FROM missions_hidden WHERE source_type = ? AND source_id = ?').run('cap_vien', sid);
  } catch (eH) {}
  if (!subRow) {
    return;
  }
  const pathsToRemove = [];
  try {
    const files = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ?').all(sid);
    for (const f of files) {
      if (f && f.path) pathsToRemove.push(String(f.path));
    }
  } catch (e) {}
  const capStmts = [
    'DELETE FROM cap_vien_submission_files WHERE submissionId = ?',
    'DELETE FROM cap_vien_step2_history WHERE submissionId = ?',
    'DELETE FROM cap_vien_submission_history WHERE submissionId = ?',
    'DELETE FROM cap_vien_step_deadlines WHERE submissionId = ?',
    'DELETE FROM cap_vien_submissions WHERE id = ?',
  ];
  db.transaction(() => {
    for (const sql of capStmts) {
      try {
        db.prepare(sql).run(sid);
      } catch (e) {
        const msg = e && e.message ? String(e.message) : '';
        if (msg.includes('no such table')) continue;
        throw e;
      }
    }
  })();
  for (const rel of pathsToRemove) {
    try {
      const norm = normalizePathUnderCapVienUploads(rel);
      if (!norm || !fs.existsSync(norm)) continue;
      const st = fs.statSync(norm);
      if (st.isFile()) fs.unlinkSync(norm);
    } catch (eUn) {}
  }
  let submissionDirSafe = null;
  const capRoot = resolveCapVienUploadRoot();
  const expectedBase = 'submission_' + String(sid);
  for (const rel of pathsToRemove) {
    const fileNorm = normalizePathUnderCapVienUploads(rel);
    if (!fileNorm) continue;
    let dir = path.dirname(fileNorm);
    while (dir && dir.length >= capRoot.length) {
      if (!dir.startsWith(capRoot + path.sep) && dir !== capRoot) break;
      if (path.basename(dir) === expectedBase) {
        submissionDirSafe = normalizePathUnderCapVienUploads(dir);
        break;
      }
      if (dir === capRoot) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (submissionDirSafe) break;
  }
  if (submissionDirSafe && fs.existsSync(submissionDirSafe)) {
    try {
      fs.rmSync(submissionDirSafe, { recursive: true });
    } catch (eRm) {}
  }
}

function insertGd5History(submissionId, actionType, performedById, fileFieldName, originalFileName, label) {
  const performedAt = new Date().toISOString();
  const u = performedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(performedById) : null;
  const performedByName = u ? (u.fullname || u.email || '') : '';
  db.prepare(
    'INSERT INTO submission_gd5_history (submissionId, actionType, performedAt, performedById, performedByName, fileFieldName, originalFileName, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(submissionId, actionType, performedAt, performedById || null, performedByName, fileFieldName || null, originalFileName || null, label || null);
}

// Sửa tên file bị bể dấu: trình duyệt gửi UTF-8 nhưng Node đọc header theo Latin-1 → chuyển lại UTF-8
function fixFilenameEncoding(name) {
  if (!name || typeof name !== 'string') return name || '';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

// Tên thư mục an toàn từ họ tên (loại bỏ ký tự đặc biệt, khoảng trắng → gạch dưới)
function sanitizeFolderName(name) {
  if (!name || typeof name !== 'string') return 'Nghien_cuu_vien';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'Nghien_cuu_vien';
}

// Multer: lưu file tạm, sau khi tạo submission sẽ chuyển vào uploads/<Họ tên NCV>/submission_<id>/
const tempUploadDir = path.join(uploadDir, 'temp');
fs.mkdirSync(tempUploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!req._uploadDir) {
      req._uploadDir = path.join(tempUploadDir, 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      fs.mkdirSync(req._uploadDir, { recursive: true });
    }
    cb(null, req._uploadDir);
  },
  filename: function (req, file, cb) {
    const safe = (file.originalname || file.fieldname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
});

/** Upload CSV SCImago (memory) — POST /api/admin/sjr-csv-import */
const uploadSjrCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_FILE_BYTES_SJR_CSV, fieldSize: MULTIPART_MAX_FIELD_BYTES },
});

// Multer cho Đề tài cấp Viện (thư mục riêng)
const tempUploadDirCapVien = path.join(uploadDirCapVien, 'temp');
fs.mkdirSync(tempUploadDirCapVien, { recursive: true });
const storageCapVien = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!req._uploadDirCapVien) {
      req._uploadDirCapVien = path.join(tempUploadDirCapVien, 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2));
      fs.mkdirSync(req._uploadDirCapVien, { recursive: true });
    }
    cb(null, req._uploadDirCapVien);
  },
  filename: function (req, file, cb) {
    const safe = (file.originalname || file.fieldname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const uploadCapVien = multer({
  storage: storageCapVien,
  limits: { fileSize: UPLOAD_FILE_BYTES_CAP_VIEN, fieldSize: MULTIPART_MAX_FIELD_BYTES },
});

/** Mẫu hồ sơ công khai (trang tải mẫu đề tài cấp Viện) — mọi định dạng, tối đa 80MB */
const storageCapVienPublicTemplate = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, capVienPublicTemplatesFsDir);
  },
  filename: function (req, file, cb) {
    const tc = ((req.params && req.params.taskCode) || '').trim();
    const ext = path.extname(file.originalname || '') || '';
    const safe = tc.replace(/[^A-Za-z0-9\-_]/g, '_') || 'task';
    cb(null, safe + '_' + Date.now() + ext);
  },
});
const uploadCapVienPublicTemplate = multer({
  storage: storageCapVienPublicTemplate,
  limits: { fileSize: UPLOAD_FILE_BYTES_CAP_PUBLIC_TEMPLATE, fieldSize: MULTIPART_MAX_FIELD_BYTES },
});

const htqtDoanRaDir = path.join(uploadDir, 'htqt-doan-ra');
const DOAN_RA_TO_TRINH_TEMPLATE_PATH = path.join(htqtDoanRaDir, 'to-trinh-template.docx');
const storageHtqtDoanRa = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtDoanRaDir);
  },
  filename: function (req, file, cb) {
    const id = parseInt(req.params.id, 10) || 0;
    const ext = path.extname(file.originalname || '') || '.docx';
    cb(null, 'doan_ra_' + id + '_' + Date.now() + ext);
  }
});
const uploadHtqtDoanRa = multer({
  storage: storageHtqtDoanRa,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(doc|docx)$/.test(n)) {
      return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
    }
    cb(null, true);
  }
});

const storageToTrinhTemplate = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtDoanRaDir);
  },
  filename: function (req, file, cb) {
    cb(null, 'to-trinh-template.docx');
  }
});
const uploadToTrinhTemplate = multer({
  storage: storageToTrinhTemplate,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.docx$/i.test(n)) {
      return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
    }
    cb(null, true);
  }
});

const htqtDoanVaoDir = path.join(uploadDir, 'htqt-doan-vao');
const DOAN_VAO_TO_TRINH_TEMPLATE_PATH = path.join(htqtDoanVaoDir, 'to-trinh-template.docx');
const storageHtqtDoanVao = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtDoanVaoDir);
  },
  filename: function (req, file, cb) {
    const id = parseInt(req.params.id, 10) || 0;
    const ext = path.extname(file.originalname || '') || '.docx';
    cb(null, 'doan_vao_' + id + '_' + Date.now() + ext);
  }
});
const uploadHtqtDoanVao = multer({
  storage: storageHtqtDoanVao,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(doc|docx)$/.test(n)) {
      return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
    }
    cb(null, true);
  }
});
const storageToTrinhTemplateDoanVao = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtDoanVaoDir);
  },
  filename: function (req, file, cb) {
    cb(null, 'to-trinh-template.docx');
  }
});
const uploadToTrinhTemplateDoanVao = multer({
  storage: storageToTrinhTemplateDoanVao,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.docx$/i.test(n)) {
      return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
    }
    cb(null, true);
  }
});

const htqtMouDir = path.join(uploadDir, 'htqt-mou');
const MOU_TO_TRINH_TEMPLATE_PATH = path.join(htqtMouDir, 'to-trinh-template.docx');
const storageHtqtMou = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtMouDir);
  },
  filename: function (req, file, cb) {
    const id = parseInt(req.params.id, 10) || 0;
    const ext = path.extname(file.originalname || '') || '.docx';
    cb(null, 'mou_' + id + '_' + Date.now() + ext);
  }
});
const uploadHtqtMou = multer({
  storage: storageHtqtMou,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(doc|docx)$/.test(n)) {
      return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
    }
    cb(null, true);
  }
});
const storageToTrinhTemplateMou = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtMouDir);
  },
  filename: function (req, file, cb) {
    cb(null, 'to-trinh-template.docx');
  }
});
const uploadToTrinhTemplateMou = multer({
  storage: storageToTrinhTemplateMou,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.docx$/i.test(n)) {
      return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
    }
    cb(null, true);
  }
});

const htqtYtnnDir = path.join(uploadDir, 'htqt-ytnn');
const YTNN_TO_TRINH_TEMPLATE_PATH = path.join(htqtYtnnDir, 'to-trinh-template.docx');
const storageHtqtYtnn = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtYtnnDir);
  },
  filename: function (req, file, cb) {
    const id = parseInt(req.params.id, 10) || 0;
    const ext = path.extname(file.originalname || '') || '.docx';
    cb(null, 'ytnn_' + id + '_' + Date.now() + ext);
  }
});
const uploadHtqtYtnn = multer({
  storage: storageHtqtYtnn,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(doc|docx)$/.test(n)) {
      return cb(new Error('Chỉ chấp nhận file .doc hoặc .docx'));
    }
    cb(null, true);
  }
});
const htqtThoaThuanDir = path.join(uploadDir, 'htqt-thoa-thuan');
const uploadHtqtThoaThuanScan = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) { cb(null, htqtThoaThuanDir); },
    filename: function (_req, file, cb) {
      const ext = path.extname(file.originalname || '') || '.pdf';
      const safe = path.basename(file.originalname || 'scan', ext).replace(/[^\w\-]+/g, '_').slice(0, 80);
      cb(null, 'thoa_thuan_' + Date.now() + '_' + safe + ext.toLowerCase());
    },
  }),
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (_req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Scan chỉ nhận PDF, DOC, DOCX, JPG, PNG'));
    cb(null, true);
  },
});
const uploadHtqtThoaThuanTermination = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) { cb(null, htqtThoaThuanDir); },
    filename: function (_req, file, cb) {
      const ext = path.extname(file.originalname || '') || '.pdf';
      const safe = path.basename(file.originalname || 'termination', ext).replace(/[^\w\-]+/g, '_').slice(0, 80);
      cb(null, 'thoa_thuan_termination_' + Date.now() + '_' + safe + ext.toLowerCase());
    },
  }),
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (_req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Termination file: PDF, DOC, DOCX, JPG, PNG only'));
    cb(null, true);
  },
});
const storageToTrinhTemplateYtnn = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, htqtYtnnDir);
  },
  filename: function (req, file, cb) {
    cb(null, 'to-trinh-template.docx');
  }
});
const uploadToTrinhTemplateYtnn = multer({
  storage: storageToTrinhTemplateYtnn,
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES },
  fileFilter: function (req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.docx$/i.test(n)) {
      return cb(new Error('Mẫu Tờ trình merge chỉ hỗ trợ định dạng .docx'));
    }
    cb(null, true);
  }
});

// Cấu hình mặc định cho các module trên trang chủ
const HOMEPAGE_MODULES_DEFAULT = [
  { code: 'missions', label: 'Quản lý nhiệm vụ KHCN', enabled: 1 },
  { code: 'ethics_ace', label: 'Hội đồng đạo đức trên động vật (SCI-ACE)', enabled: 1 },
  { code: 'personnel', label: 'Quản lý Nhân lực KHCN', enabled: 0 },
  { code: 'ip', label: 'Quản lý Tài sản Trí tuệ', enabled: 0 },
  { code: 'finance', label: 'Quản lý Tài chính KHCN', enabled: 0 },
  { code: 'publications', label: 'Quản lý Công bố Khoa học', enabled: 0 },
  { code: 'cooperation', label: 'Quản lý Hợp tác', enabled: 1 },
  { code: 'equipment_stims', label: 'Quản trị thiết bị', enabled: 1 },
  { code: 'tech_transfer', label: 'Quản lý Chuyển giao Công nghệ', enabled: 0 },
  { code: 'facilities', label: 'CRD Lab Booking', enabled: 1 },
  { code: 'ethics_integrity', label: 'Đạo đức và Liêm chính khoa học', enabled: 0 },
  { code: 'reward', label: 'Quản lý Khen thưởng & Đánh giá', enabled: 0 },
  { code: 'dms', label: 'Quản lý tài liệu & hồ sơ (Hành chính)', enabled: 1 }
];

(function migrateHomepageModuleSortOrder() {
  try {
    db.prepare('ALTER TABLE homepage_modules ADD COLUMN sort_order INTEGER DEFAULT 0').run();
  } catch (e) { /* cột đã tồn tại */ }
  const flag = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_modules_sort_migrated');
  if (flag && flag.value === '1') return;
  try {
    HOMEPAGE_MODULES_DEFAULT.forEach((m, i) => {
      db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)').run(m.code, m.label, m.enabled ? 1 : 0, i);
      db.prepare('UPDATE homepage_modules SET sort_order = ? WHERE code = ?').run(i, m.code);
    });
    db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_modules_sort_migrated', '1');
  } catch (e) {
    console.warn('[DB] migrateHomepageModuleSortOrder:', e.message || e);
  }
})();

(function migrateHomepageModuleOrderJson() {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
    if (row && row.value && String(row.value).trim()) return;
    const rowsFull = db.prepare('SELECT code, sort_order FROM homepage_modules ORDER BY sort_order, code').all();
    if (!rowsFull || rowsFull.length < HOMEPAGE_MODULES_DEFAULT.length) return;
    const distinct = new Set(rowsFull.map(r => r.sort_order ?? 0)).size;
    const codes =
      distinct <= 1
        ? HOMEPAGE_MODULES_DEFAULT.map(m => m.code)
        : rowsFull.map(r => r.code);
    db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_module_order', JSON.stringify(codes));
  } catch (e) {
    console.warn('[DB] migrateHomepageModuleOrderJson:', e.message || e);
  }
})();

/** Xóa dòng homepage_modules sai (vd. code=reorder do route /:code nuốt path /reorder) và sửa JSON homepage_module_order */
(function repairHomepageModulesCorruption() {
  try {
    const expectedList = HOMEPAGE_MODULES_DEFAULT.map(m => m.code);
    const expectedCodes = new Set(expectedList);
    const allCodes = db.prepare('SELECT code FROM homepage_modules').all();
    allCodes.forEach(r => {
      if (!expectedCodes.has(r.code)) {
        db.prepare('DELETE FROM homepage_modules WHERE code = ?').run(r.code);
      }
    });
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
    if (!row || row.value == null || String(row.value).trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch (e) {
      db.prepare('DELETE FROM system_settings WHERE key = ?').run('homepage_module_order');
      return;
    }
    if (!Array.isArray(parsed)) {
      db.prepare('DELETE FROM system_settings WHERE key = ?').run('homepage_module_order');
      return;
    }
    const filtered = [];
    const seen = new Set();
    parsed.forEach(c => {
      const code = String(c || '').trim();
      if (expectedCodes.has(code) && !seen.has(code)) {
        seen.add(code);
        filtered.push(code);
      }
    });
    expectedList.forEach(code => {
      if (!seen.has(code)) filtered.push(code);
    });
    if (JSON.stringify(parsed) !== JSON.stringify(filtered)) {
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_module_order', JSON.stringify(filtered));
    }
  } catch (e) {
    console.warn('[DB] repairHomepageModulesCorruption:', e.message || e);
  }
})();

/** Bổ sung dòng homepage_modules mới (sau khi mở rộng HOMEPAGE_MODULES_DEFAULT) */
(function ensureAllHomepageModulesExist() {
  try {
    let next =
      (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM homepage_modules').get() || {}).m;
    next = Number(next);
    if (!Number.isFinite(next)) next = -1;
    next += 1;
    HOMEPAGE_MODULES_DEFAULT.forEach((m) => {
      const ex = db.prepare('SELECT code FROM homepage_modules WHERE code = ?').get(m.code);
      if (!ex) {
        db.prepare(
          'INSERT INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)'
        ).run(m.code, m.label, m.enabled ? 1 : 0, next);
        next += 1;
      }
    });
  } catch (e) {
    console.warn('[DB] ensureAllHomepageModulesExist:', e.message || e);
  }
})();

/** Module Quản lý tài liệu & hồ sơ (DMS / hành chính) */
db.exec(`
  CREATE TABLE IF NOT EXISTS dms_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES dms_categories(id),
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS dms_document_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    code TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS dms_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#64748b',
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS dms_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    ref_number TEXT,
    category_id INTEGER REFERENCES dms_categories(id),
    document_type_id INTEGER REFERENCES dms_document_types(id),
    status TEXT NOT NULL DEFAULT 'draft',
    issue_date TEXT,
    valid_until TEXT,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    mime_type TEXT,
    notes TEXT,
    uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
    uploaded_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS dms_document_tags (
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES dms_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
  );
  CREATE TABLE IF NOT EXISTS dms_user_roles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    role TEXT NOT NULL,
    granted_by INTEGER REFERENCES users(id),
    granted_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS dms_module_access (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    granted_by INTEGER REFERENCES users(id),
    granted_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN issuing_unit TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN external_scan_link TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN import_sheet TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN external_word_link TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_location TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_copy_type TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_sheet_count INTEGER').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_page_count INTEGER').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN retention_until TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN destruction_eligible_date TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN parent_case_ref TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN template_id INTEGER').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0').run();
} catch (e) {
  /* đã có */
}
db.exec(`
  CREATE TABLE IF NOT EXISTS dms_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1.0',
    status TEXT NOT NULL DEFAULT 'active',
    record_kind TEXT DEFAULT 'record',
    description TEXT,
    retention_policy TEXT,
    medium_notes TEXT,
    owning_unit TEXT,
    effective_from TEXT,
    effective_until TEXT,
    blank_form_url TEXT,
    superseded_by_id INTEGER,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_by_id INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT,
    FOREIGN KEY (superseded_by_id) REFERENCES dms_templates(id)
  );
  CREATE INDEX IF NOT EXISTS idx_dms_documents_template ON dms_documents(template_id);
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS dms_document_loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    borrower_name TEXT NOT NULL,
    reason TEXT,
    borrowed_at TEXT DEFAULT (datetime('now','localtime')),
    due_at TEXT,
    returned_at TEXT,
    created_by_id INTEGER REFERENCES users(id),
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS dms_document_handovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    from_party TEXT NOT NULL,
    to_party TEXT NOT NULL,
    handed_at TEXT DEFAULT (datetime('now','localtime')),
    notes TEXT,
    created_by_id INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS dms_inventory_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    started_at TEXT DEFAULT (datetime('now','localtime')),
    closed_at TEXT,
    started_by_id INTEGER REFERENCES users(id),
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS dms_inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES dms_inventory_sessions(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    physical_location_found TEXT,
    notes TEXT,
    checked_at TEXT DEFAULT (datetime('now','localtime')),
    checked_by_id INTEGER REFERENCES users(id),
    UNIQUE(session_id, document_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dms_loans_doc ON dms_document_loans(document_id);
  CREATE INDEX IF NOT EXISTS idx_dms_loans_open ON dms_document_loans(document_id) WHERE returned_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_dms_handover_doc ON dms_document_handovers(document_id);
`);
/** Người đã có vai trò module trước đây → tự thêm vào danh sách mở truy cập (một lần). */
(function backfillDmsModuleAccessFromRoles() {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO dms_module_access (user_id, granted_by, granted_at)
       SELECT user_id, NULL, datetime('now','localtime') FROM dms_user_roles`
    ).run();
  } catch (e) {
    console.warn('[DB] backfillDmsModuleAccessFromRoles:', e.message || e);
  }
})();
/** Người đã mở truy cập module nhưng chưa có dòng dms_user_roles → mặc định viewer (một lần). */
(function backfillDmsDefaultViewerRole() {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO dms_user_roles (user_id, role, granted_by, granted_at)
       SELECT a.user_id, 'viewer', NULL, datetime('now','localtime')
       FROM dms_module_access a
       LEFT JOIN dms_user_roles r ON r.user_id = a.user_id
       WHERE r.user_id IS NULL`
    ).run();
  } catch (e) {
    console.warn('[DB] backfillDmsDefaultViewerRole:', e.message || e);
  }
})();
(function seedDmsCatalogIfEmpty() {
  try {
    const n = db.prepare('SELECT COUNT(*) AS c FROM dms_categories').get().c;
    if (n > 0) return;
    const ins = db.prepare(
      'INSERT INTO dms_categories (parent_id, name, sort_order, is_active) VALUES (?, ?, ?, 1)'
    );
    const r1 = ins.run(null, 'Văn bản pháp lý nội bộ', 1);
    const p1 = r1.lastInsertRowid;
    ins.run(p1, 'Quyết định', 1);
    ins.run(p1, 'Quy chế / Quy định', 2);
    ins.run(null, 'Hợp đồng & Thỏa thuận', 2);
    ins.run(null, 'Hồ sơ đề tài KHCN', 3);
    ins.run(null, 'Biên bản & Tờ trình', 4);
    ins.run(null, 'Kế hoạch & Công văn', 5);
    const tins = db.prepare(
      'INSERT INTO dms_document_types (name, code, sort_order, is_active) VALUES (?, ?, ?, 1)'
    );
    tins.run('Quy chế nội bộ', 'quy_che', 1);
    tins.run('Quyết định', 'quyet_dinh', 2);
    tins.run('Hợp đồng', 'hop_dong', 3);
    tins.run('Biên bản', 'bien_ban', 4);
    tins.run('Công văn', 'cong_van', 5);
    const tagIns = db.prepare('INSERT OR IGNORE INTO dms_tags (name, color, sort_order) VALUES (?, ?, ?)');
    tagIns.run('KHCN', '#2563eb', 1);
    tagIns.run('TSTT / IP', '#7c3aed', 2);
    tagIns.run('Nhân sự', '#0891b2', 3);
    tagIns.run('Tài chính', '#047857', 4);
    tagIns.run('Pháp lý', '#b45309', 5);
  } catch (e) {
    console.warn('[DB] seedDmsCatalogIfEmpty:', e.message || e);
  }
})();

/** Gán category_id xuống mục con khi bản ghi đang ở danh mục cấp trên nhưng loại tài liệu trùng tên mục con (VD: nhóm «Văn bản…» + loại «Quyết định» → mục Quyết định). Idempotent mỗi lần khởi động. */
(function realignDmsCategoryByDocumentType() {
  try {
    const children = db
      .prepare(
        `SELECT c.id AS cid, c.name AS cname, c.parent_id AS pid
         FROM dms_categories c
         WHERE c.parent_id IS NOT NULL AND COALESCE(c.is_active,1) = 1`
      )
      .all();
    const findType = db.prepare(
      `SELECT id FROM dms_document_types WHERE lower(trim(name)) = lower(trim(?)) AND COALESCE(is_active,1) = 1 LIMIT 1`
    );
    const upd = db.prepare(
      `UPDATE dms_documents SET category_id = ? WHERE category_id = ? AND document_type_id = ?`
    );
    for (const ch of children) {
      const dt = findType.get(ch.cname);
      if (!dt) continue;
      upd.run(ch.cid, ch.pid, dt.id);
    }
  } catch (e) {
    console.warn('[DB] realignDmsCategoryByDocumentType:', e.message || e);
  }
})();

// Email (cấu hình qua biến môi trường)
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
  const stmt = db.prepare("SELECT email FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin')");
  return stmt.all().map(r => r.email);
}

function getBudgetTeamEmails() {
  const stmt = db.prepare("SELECT email FROM users WHERE role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc')");
  return stmt.all().map(r => r.email).filter(Boolean);
}

function getChairmanEmail() {
  const row = db.prepare("SELECT email FROM users WHERE role = 'chu_tich' LIMIT 1").get();
  return row ? row.email : null;
}

function computeNhanhFromLevel(level) {
  const lev = (level || '').toLowerCase();
  if (['ministry', 'university'].includes(lev)) return 'A';
  if (['national'].includes(lev)) return 'B';
  return 'B';
}

// Danh sách email nhận thông báo: ưu tiên bảng notification_recipients (Admin quản lý), không có thì NOTIFICATION_EMAILS, rồi Hội đồng trong DB
function getNotificationEmails() {
  try {
    const rows = db.prepare('SELECT email FROM notification_recipients ORDER BY id').all();
    if (rows && rows.length > 0) {
      return rows.map(r => (r.email || '').trim().toLowerCase()).filter(Boolean);
    }
  } catch (e) { /* bảng chưa có */ }
  const envList = (process.env.NOTIFICATION_EMAILS || '').trim();
  if (envList) {
    return envList.split(/[,;]/).map(e => e.trim().toLowerCase()).filter(Boolean);
  }
  return getCouncilEmails();
}

// Module Hợp tác quốc tế: lấy email nhận thông báo theo topic (doan_ra, mou, ...) hoặc 'all'
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
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'Nghiên cứu viên');
  const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : '—';

  const subject = '[Đề tài cấp Viện Tế bào gốc]: Hồ sơ mới được nộp: ' + (submissionTitle || '');
  const text =
    'Kính gửi Quý thành viên Hội đồng,\n\n' +
    'Hệ thống quản lý KHCN&ĐMST Viện Tế bào gốc có ghi nhận hồ sơ mới đăng kí đề tài cấp Viện TBG do ' + submitterLabel + ' nộp.\n\n' +
    'Thông tin đề tài:\n- Tên đề tài: ' + (submissionTitle || '') + '\n- Người nộp: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- Ngày nộp: ' + dateStr + '\n\n' +
    'Khu vực Hội đồng (theo dõi và tải hồ sơ): ' + councilUrl + '\n\n' +
    'Hiện tại: ' + stepInfo.current + '\n' +
    'Sắp tới: ' + stepInfo.next + '\n' +
    'Chờ duyệt bởi: ' + stepInfo.who + '\n\n' +
    'Trân trọng.';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi Quý thành viên Hội đồng,</p>' +
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
  const councilList = getNotificationEmails();
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
  const toList = getNotificationEmails();
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
  const toList = getNotificationEmails();
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
  const toList = getNotificationEmails();
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
  const councilList = getNotificationEmails();
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
  const councilList = getNotificationEmails();
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

/** Chuẩn hoá origin cho so khớp (scheme + host + port, không path). */
function normalizeCorsOriginValue(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function buildCorsOriginAllowlist() {
  const allow = new Set();
  const add = (raw) => {
    const n = normalizeCorsOriginValue(raw);
    if (n) allow.add(n);
  };
  const corsOriginsEnv = process.env.CORS_ORIGINS;
  if (corsOriginsEnv != null && String(corsOriginsEnv).trim()) {
    String(corsOriginsEnv)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .forEach(add);
  }
  if (process.env.BASE_URL != null && String(process.env.BASE_URL).trim()) {
    add(process.env.BASE_URL);
  }
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd) {
    const p = String(PORT);
    add(`http://localhost:${p}`);
    add(`http://127.0.0.1:${p}`);
    add('http://localhost:3000');
    add('http://127.0.0.1:3000');
  }
  return allow;
}

const CORS_ORIGIN_ALLOWLIST = buildCorsOriginAllowlist();
(function assertCorsConfiguredInProduction() {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd || CORS_ORIGIN_ALLOWLIST.size > 0) return;
  console.error(
    '[FATAL] Production: danh sách CORS rỗng. Đặt BASE_URL và/hoặc CORS_ORIGINS (các origin cách nhau bằng dấu phẩy, ví dụ https://app.example.com,https://admin.example.com).'
  );
  process.exit(1);
})();

function corsOriginCallback(origin, callback) {
  if (!origin) return callback(null, true);
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd && origin === 'null') return callback(null, true);
  const n = normalizeCorsOriginValue(origin);
  if (n && CORS_ORIGIN_ALLOWLIST.has(n)) return callback(null, origin);
  return callback(null, false);
}

// Middleware (static đặt sau API để /api/* luôn do API xử lý)
(function mountSecurityHeaders() {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: isProd ? undefined : false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https:', 'http:'],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
          fontSrc: ["'self'", 'https:', 'data:'],
          connectSrc: ["'self'", 'https:', 'wss:', 'http:', 'ws:'],
          frameSrc: ["'self'", 'https:', 'http:'],
          upgradeInsecureRequests: isProd ? [] : null,
        },
      },
    })
  );
})();
app.use(cors({ origin: corsOriginCallback }));
// BibTeX lớn (JSON) cần > 100kb mặc định của Express — không liên quan giới hạn file của multer (multipart).
app.use(express.json({ limit: BODY_JSON_LIMIT_STR }));

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

function isCrdOnlyUserRole(role) {
  return String(role || '').toLowerCase() === CRD_ONLY_USER_ROLE;
}

/** Pathname không gồm query (vd /api/crd/state). */
function isApiPathAllowedForCrdOnlyUser(urlPath) {
  const p = (urlPath || '').split('?')[0];
  if (p.startsWith('/api/crd/')) return true;
  if (p === '/api/me' || p === '/api/logout') return true;
  if (p === '/api/activity/track') return true;
  if (p === '/api/health') return true;
  if (p.startsWith('/api/pub-analytics')) return true;
  if (p.startsWith('/api/dashboard-perms/') && p.endsWith('/check')) return true;
  return false;
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
    if (isCrdOnlyUserRole(payload.role)) {
      const p = (req.originalUrl || req.url || '').split('?')[0];
      if (!isApiPathAllowedForCrdOnlyUser(p)) {
        return res.status(403).json({
          message:
            'Tài khoản này chỉ dùng cho module Đặt lịch thiết bị CRD. Để dùng Nhiệm vụ KHCN, Hội đồng đạo đức, v.v., vui lòng đăng ký/đăng nhập bằng email @sci.edu.vn trên trang chính.',
        });
      }
    }
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
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới có quyền này' });
  }
  next();
}

function chuTichOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'chu_tich') {
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
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'phong_khcn' && role !== 'thu_ky') {
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

/** Chuỗi trạng thái tự do (không thuộc mã enum): bỏ ký tự điều khiển / <>. */
function sanitizeMissionStatusFreeText(s) {
  const t = String(s || '')
    .trim()
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f<>]/g, '')
    .slice(0, 200);
  return t || null;
}

/** Mã trạng thái chuẩn (dropdown). Giá trị khác có thể lưu nếu là văn bản tự do (sau khi sanitize). */
const MISSION_STATUS_ENUM = [
  'planning',
  'approved',
  'ongoing',
  'review',
  'completed',
  'overdue',
  'cho_phe_duyet_ngoai',
  'da_phe_duyet',
  'dang_thuc_hien',
  'nghiem_thu_trung_gian',
  'nghiem_thu_tong_ket',
  'hoan_thanh',
  'khong_duoc_phe_duyet',
  'cho_vien_xet_chon',
  'cho_ct_hd_xet_duyet',
  'buoc4a',
  'buoc4b',
  'cho_bo_tham_dinh',
  'cho_ngoai_xet_chon',
  'cho_phe_duyet_chinh_thuc',
  'cho_ky_hop_dong',
  'xin_dieu_chinh',
  'cho_nghiem_thu_co_so',
  'cho_nghiem_thu_bo_nn',
  'hoan_thien_sau_nghiem_thu',
  'thanh_ly_hop_dong',
  'dung_khong_dat_dot',
];

function resolveMissionStatusInput(raw) {
  const stRaw = String(raw != null ? raw : '').trim();
  if (!stRaw) return null;
  if (MISSION_STATUS_ENUM.includes(stRaw)) return stRaw;
  const stLow = stRaw.toLowerCase();
  if (MISSION_STATUS_ENUM.includes(stLow)) return stLow;
  return sanitizeMissionStatusFreeText(stRaw);
}

/** Chuẩn hóa tên để so khớp chủ nhiệm (bỏ học hàm viết tắt thường gặp ở đầu chuỗi). */
function normMissionPrincipalName(s) {
  let t = String(s || '').trim();
  let prev;
  do {
    prev = t;
    t = t
      .replace(/^(PGS\.\s*TS\.|PGS\.\s*TS|PGS\s+TS\.|PGS\s+TS|GS\.\s*TS\.|GS\.\s*TS|GS\s+TS\.|GS\s+TS|TSCKH\.|TS\.|TS\s|ThS\.|ThS\s|BSCKII\.|BSCKI\.|BS\.|CN\.|DR\.|Dr\.)\s+/i, '')
      .trim();
  } while (t !== prev);
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** So khớp trường principal của missions với user đăng nhập (fullname / email). */
function missionPrincipalMatchesUser(principalText, user) {
  if (!user) return false;
  const pRaw = (principalText || '').trim();
  if (!pRaw) return false;
  const email = (user.email || '').trim().toLowerCase();
  if (email && pRaw.toLowerCase() === email) return true;
  const fullname = (user.fullname || '').trim();
  const pn = normMissionPrincipalName(pRaw);
  const fn = normMissionPrincipalName(fullname);
  if (fn.length >= 2 && pn === fn) return true;
  if (fn.length >= 3 && pn.length >= 3 && (pn.includes(fn) || fn.includes(pn))) return true;
  return false;
}

/** Admin xem được mọi đề tài; user thường chỉ đề tài mình là chủ nhiệm (theo trường principal). */
function canUserAccessMissionHoSoNgoai(req, missionRow) {
  if (!missionRow) return false;
  if (!req.user) return false;
  if ((req.user.role || '').toLowerCase() === 'admin') return true;
  return missionPrincipalMatchesUser(missionRow.principal, req.user);
}

/** Quyền xem chi tiết đề tài: nhóm xử lý nghiệp vụ + admin; user thường chỉ xem đề tài mình phụ trách. */
function canUserAccessMissionDetail(req, missionRow) {
  if (!missionRow || !req || !req.user) return false;
  const role = (req.user.role || '').toLowerCase();
  if (
    role === 'admin' ||
    role === 'phong_khcn' ||
    role === 'thu_ky' ||
    role === 'chu_tich' ||
    role === 'thanh_vien' ||
    role === 'totruong_tham_dinh_tc' ||
    role === 'thanh_vien_tham_dinh_tc'
  ) {
    return true;
  }
  return missionPrincipalMatchesUser(missionRow.principal, req.user);
}

const createTickerRouter = require('./routes/ticker');
app.use(
  '/',
  createTickerRouter({
    db,
    authMiddleware,
    jwt,
    JWT_SECRET,
    getTokenFromReq,
    userIdIsBanned,
    clearAuthCookie,
  })
);

const registerHomepageSidebarRss = require('./routes/homepageSidebarRss');
registerHomepageSidebarRss(app, { db, authMiddleware, adminOnly });

// --- API ---

/** Đã có mật khẩu đăng nhập (đã kích hoạt). Cột password có thể NOT NULL nên dùng '' làm sentinel “chưa kích hoạt”. */
function userHasLoginPassword(pw) {
  return pw != null && String(pw).trim().length > 0;
}

// Đăng ký / kích hoạt (chỉ @sci.edu.vn) — tài khoản pre-created (password rỗng/NULL) được kích hoạt tại đây
app.post('/api/register', async (req, res) => {
  const { email, password, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const fn = (fullname || '').trim();
  const pw = password;

  if (!em || !fn || !pw) {
    return res.status(400).json({ message: 'Vui lòng điền đầy đủ thông tin' });
  }
  if (!em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chỉ chấp nhận email có đuôi ' + ALLOWED_EMAIL_DOMAIN });
  }
  if (fn.length < 2) {
    return res.status(400).json({ message: 'Vui lòng nhập họ và tên (ít nhất 2 ký tự).' });
  }
  if (pw.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu ít nhất 6 ký tự' });
  }
  if (pw.length > 128) {
    return res.status(400).json({ message: 'Mật khẩu quá dài (tối đa 128 ký tự).' });
  }

  const existing = db.prepare('SELECT id, role, password, fullname FROM users WHERE email = ?').get(em);

  if (existing) {
    if (userHasLoginPassword(existing.password)) {
      return res.status(400).json({
        message: 'Email này đã có tài khoản. Vui lòng đăng nhập hoặc dùng "Quên mật khẩu".',
      });
    }
    let hash;
    try {
      hash = await bcrypt.hash(pw, 10);
    } catch (e) {
      return res.status(500).json({ message: 'Không thể kích hoạt tài khoản. Vui lòng thử lại.' });
    }
    db.prepare('UPDATE users SET password = ?, fullname = ? WHERE id = ?').run(hash, fn, existing.id);
    const user = { id: existing.id, email: em, fullname: fn, role: existing.role };
    if ((user.role || '').toLowerCase() === 'admin') {
      user.isMasterAdmin = userEmailIsMasterAdmin(user.email);
    }
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    return res.status(200).json({
      message: 'Kích hoạt tài khoản thành công! Chào mừng bạn.',
      token,
      user,
      activated: true,
    });
  }

  const role = 'researcher';
  let hash;
  try {
    hash = await bcrypt.hash(pw, 10);
  } catch (e) {
    return res.status(500).json({ message: 'Không thể tạo tài khoản. Vui lòng thử lại.' });
  }
  try {
    const ins = db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(em, hash, fn, role);
    const user = { id: Number(ins.lastInsertRowid), email: em, fullname: fn, role };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    return res.status(201).json({ message: 'Đăng ký thành công', token, user });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ message: 'Email này đã được sử dụng' });
    }
    throw e;
  }
});

// Đăng nhập
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof password !== 'string' || !password || password.length > 128) {
    return res.status(400).json({ message: 'Mật khẩu không hợp lệ' });
  }
  const em = (email || '').trim().toLowerCase();
  const row = db.prepare('SELECT id, email, password, fullname, role, COALESCE(is_banned, 0) AS is_banned FROM users WHERE email = ?').get(em);
  if (!row) {
    insertUserActivityLog(req, {
      userId: null,
      email: em || null,
      action: 'login_failed',
      module: 'auth',
      path: '/api/login',
      detail: 'unknown_email',
    });
    return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
  }
  if (Number(row.is_banned) === 1) {
    insertUserActivityLog(req, {
      userId: row.id,
      email: row.email,
      action: 'login_failed',
      module: 'auth',
      path: '/api/login',
      detail: 'account_banned',
    });
    return res.status(403).json({ message: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.' });
  }
  if (!userHasLoginPassword(row.password)) {
    insertUserActivityLog(req, {
      userId: row.id,
      email: row.email,
      action: 'login_failed',
      module: 'auth',
      path: '/api/login',
      detail: 'not_activated',
    });
    return res.status(401).json({
      message:
        'Tài khoản chưa kích hoạt. Vui lòng mở trang Đăng ký, nhập cùng email @sci.edu.vn và đặt mật khẩu lần đầu.',
    });
  }
  const ok = await bcrypt.compare(password, row.password);
  if (!ok) {
    insertUserActivityLog(req, {
      userId: row.id,
      email: row.email,
      action: 'login_failed',
      module: 'auth',
      path: '/api/login',
      detail: 'wrong_password',
    });
    return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
  }
  const user = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
  if ((user.role || '').toLowerCase() === 'admin') {
    user.isMasterAdmin = userEmailIsMasterAdmin(user.email);
  }
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
  setAuthCookie(res, token);
  insertUserActivityLog(req, {
    userId: row.id,
    email: row.email,
    action: 'login',
    module: 'auth',
    path: '/api/login',
  });
  return res.json({ token, user });
});

app.post('/api/logout', (req, res) => {
  try {
    const token = getTokenFromReq(req);
    if (token) {
      try {
        const p = jwt.verify(token, JWT_SECRET);
        insertUserActivityLog(req, {
          userId: p.id,
          email: p.email,
          action: 'logout',
          module: 'auth',
          path: '/api/logout',
        });
      } catch (_) {
        /* token hết hạn — không ghi logout */
      }
    }
  } catch (_) {}
  clearAuthCookie(res);
  return res.json({ ok: true });
});

// Client ghi nhận mở trang / hành động (đã đăng nhập). Module CRD-only cũng được phép (whitelist API).
app.post('/api/activity/track', authMiddleware, (req, res) => {
  const b = req.body || {};
  const action = String(b.action || 'page_view').slice(0, 120);
  const moduleName = b.module != null ? String(b.module).slice(0, 120) : '';
  const pathStr = b.path != null ? String(b.path).slice(0, 500) : '';
  const detail = b.detail != null ? String(b.detail).slice(0, 2000) : null;
  if (!moduleName.trim() && !pathStr.trim()) {
    return res.status(400).json({ message: 'Cần ít nhất module hoặc path' });
  }
  insertUserActivityLog(req, {
    userId: req.user.id,
    email: req.user.email,
    action,
    module: moduleName.trim() || null,
    path: pathStr.trim() || null,
    detail,
  });
  return res.json({ ok: true });
});

// Đăng ký chỉ phục vụ module Đặt lịch CRD — chấp nhận mọi email NGOẠI TRỪ @sci.edu.vn (nhân sự Viện dùng /api/register + dang-ky.html)
app.post('/api/crd/public/register', async (req, res) => {
  const { email, password, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const fn = (fullname || '').trim();
  if (em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({
      message:
        'Email @sci.edu.vn đăng ký tài khoản đầy đủ tại trang Đăng ký chính (dang-ky.html). Trang đăng ký CRD dành cho sinh viên và khách ngoài Viện đặt lịch thiết bị.',
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em) || em.length > 190) {
    return res.status(400).json({ message: 'Email không hợp lệ.' });
  }
  if (!fn || fn.length < 2) {
    return res.status(400).json({ message: 'Vui lòng nhập họ và tên (ít nhất 2 ký tự).' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ message: 'Mật khẩu ít nhất 6 ký tự' });
  }
  if (password.length > 128) {
    return res.status(400).json({ message: 'Mật khẩu quá dài (tối đa 128 ký tự).' });
  }
  const role = CRD_ONLY_USER_ROLE;
  let hash;
  try {
    hash = await bcrypt.hash(password, 10);
  } catch (e) {
    return res.status(500).json({ message: 'Không thể tạo tài khoản. Vui lòng thử lại.' });
  }
  try {
    const ins = db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(em, hash, fn, role);
    const user = { id: Number(ins.lastInsertRowid), email: em, fullname: fn, role };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookie(res, token);
    return res.status(201).json({ message: 'Đăng ký thành công', token, user });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ message: 'Email này đã được sử dụng. Hãy đăng nhập hoặc dùng email khác.' });
    }
    throw e;
  }
});

/** email (chuẩn hoá) → thời điểm gửi mail quên mật khẩu gần nhất — chống email bomb SMTP */
const forgotPasswordLastSentByEmail = new Map();
const FORGOT_PASSWORD_COOLDOWN_MS = 60_000;

// Quên mật khẩu: gửi email chứa link đặt lại (chỉ tài khoản tồn tại, không tiết lộ)
app.post('/api/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Vui lòng nhập email' });
  }
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!row) {
    return res.json({ message: 'Nếu email tồn tại trong hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu qua email.' });
  }
  const now = Date.now();
  const last = forgotPasswordLastSentByEmail.get(email) || 0;
  if (now - last < FORGOT_PASSWORD_COOLDOWN_MS) {
    return res.status(429).json({ message: 'Vui lòng đợi 1 phút trước khi gửi lại.' });
  }
  forgotPasswordLastSentByEmail.set(email, now);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM password_reset_tokens WHERE email = ?').run(email);
  db.prepare('INSERT INTO password_reset_tokens (token, email, expiresAt) VALUES (?, ?, ?)').run(token, email, expiresAt);
  try {
    await sendPasswordResetEmail(email, token);
  } catch (err) {
    forgotPasswordLastSentByEmail.delete(email);
    console.error('[forgot-password] SMTP:', err && err.message ? err.message : err);
    return res.status(503).json({ message: 'Không gửi được email lúc này. Vui lòng thử lại sau.' });
  }
  return res.json({ message: 'Nếu email tồn tại trong hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu qua email.' });
});

// Đặt lại mật khẩu (sau khi nhấn link trong email)
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ message: 'Link không hợp lệ hoặc mật khẩu mới ít nhất 6 ký tự' });
  }
  const row = db.prepare("SELECT email FROM password_reset_tokens WHERE token = ? AND datetime(expiresAt) > datetime('now')").get(token);
  if (!row) {
    return res.status(400).json({ message: 'Link đã hết hạn hoặc không hợp lệ. Vui lòng yêu cầu quên mật khẩu lại.' });
  }
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, row.email);
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
  return res.json({ message: 'Đã đặt lại mật khẩu thành công. Bạn có thể đăng nhập bằng mật khẩu mới.' });
});

// Nộp hồ sơ (upload)
app.post('/api/submissions', authMiddleware, upload.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đề tài / mã hồ sơ' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'Lần đầu nộp cần đủ 3 file: SCI-ACE-01, SCI-ACE-02, SCI-ACE-03' });
  }
  const run = db.transaction(() => {
    const sub = db.prepare('INSERT INTO submissions (title, submittedBy, submittedById) VALUES (?, ?, ?)').run(title, req.user.email, req.user.id);
    const subId = sub.lastInsertRowid;
    const researcherName = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]);
    const researcherFolder = researcherName + '_' + req.user.id;
    const finalDir = path.join(uploadDir, researcherFolder, 'submission_' + subId);
    fs.mkdirSync(finalDir, { recursive: true });
    const move = (f, fieldName) => {
      if (!f || !f.path) return;
      const newPath = path.join(finalDir, path.basename(f.path));
      try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
      const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
      db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path) VALUES (?, ?, ?, ?)').run(subId, fieldName, storedName, newPath);
    };
    move(f01, 'sci_ace_01');
    move(f02, 'sci_ace_02');
    move(f03, 'sci_ace_03');
    (files.attachments || []).forEach((f, i) => move(f, 'attachment_' + i));
    const tempDir = req._uploadDir;
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
    }
    sendNotificationToCouncil(title, req.user.email);
    return subId;
  })();
  const id = Number(run);
  return res.status(201).json({ id, message: 'Đã gửi hồ sơ thành công' });
});

// Danh sách hồ sơ: Nghiên cứu viên chỉ thấy hồ sơ của mình; Hội đồng/Admin thấy tất cả (kèm họ tên NCV)
app.get('/api/submissions', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache');
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  if (isCouncilOrAdmin) {
    const rows = db.prepare(`
      SELECT s.id, s.title, s.submittedBy, s.submittedById, s.createdAt, u.fullname AS submittedByName
      FROM submissions s
      LEFT JOIN users u ON s.submittedById = u.id
      ORDER BY s.createdAt DESC
    `).all();
    console.log('[API] GET /api/submissions (list) → ' + rows.length + ' hồ sơ, ids: ' + rows.map(r => r.id).join(', '));
    return res.json(rows);
  }
  if (role === 'researcher') {
    const rows = db.prepare('SELECT id, title, submittedBy, status, createdAt FROM submissions WHERE submittedById = ? ORDER BY createdAt DESC').all(req.user.id);
    return res.json(rows);
  }
  return res.status(403).json({ message: 'Bạn không có quyền xem danh sách hồ sơ' });
});

// Danh sách thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên, Admin) — dùng cho form phân công GĐ4. Admin hiển thị vai trò "Ủy viên Hội đồng".
app.get('/api/users/council', authMiddleware, (req, res) => {
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc Admin mới xem được danh sách này' });
  const rows = db.prepare(
    "SELECT id, email, fullname, role FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin') ORDER BY role, fullname, email"
  ).all();
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname,
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Ủy viên Hội đồng' : (ROLE_LABELS[r.role] || r.role)
  }));
  return res.json({ council });
});

// Chi tiết một hồ sơ (để trang theo dõi tiến trình): cùng quyền xem như danh sách
app.get('/api/submissions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  console.log('[API] GET /api/submissions/' + id + ' — request received');
  try {
  res.set('Cache-Control', 'no-store, no-cache');
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const row = db.prepare(`
    SELECT s.id, s.title, s.submittedBy, s.submittedById, s.status, s.createdAt, s.reviewNote, s.reviewedAt, s.reviewedById,
      s.assignedReviewerIds, s.assignedAt, s.assignedById, s.assignNote,
      s.meetingNote, s.meetingDecisionAt, s.meetingDecisionById,
      s.conditionalSubmittedAt, s.conditionalSubmittedById, s.conditionalApprovedAt, s.conditionalApprovedById,
      u.fullname AS submittedByName, reviewer.fullname AS reviewedByName, chairman.fullname AS assignedByName,
      meetingUser.fullname AS meetingDecisionByName,
      condSubUser.fullname AS conditionalSubmittedByName,
      condApproveUser.fullname AS conditionalApprovedByName
    FROM submissions s
    LEFT JOIN users u ON s.submittedById = u.id
    LEFT JOIN users reviewer ON s.reviewedById = reviewer.id
    LEFT JOIN users chairman ON s.assignedById = chairman.id
    LEFT JOIN users meetingUser ON s.meetingDecisionById = meetingUser.id
    LEFT JOIN users condSubUser ON s.conditionalSubmittedById = condSubUser.id
    LEFT JOIN users condApproveUser ON s.conditionalApprovedById = condApproveUser.id
    WHERE s.id = ?
  `).get(id);
  if (!row) {
    console.log('[API] GET /api/submissions/' + id + ' → 404 (không có trong DB)');
    return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  }
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này' });
  }
  let assignedReviewerNames = [];
  try {
    const ids = row.assignedReviewerIds ? JSON.parse(row.assignedReviewerIds) : [];
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const users = db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + placeholders + ')').all(...ids);
      assignedReviewerNames = ids.map(uid => {
        const u = users.find(r => r.id === uid);
        return u ? (u.fullname || u.email || '') : '';
      });
    }
  } catch (e) { /* ignore */ }
  let gd5ReviewHistory = [];
  try {
    const ids = row.assignedReviewerIds ? JSON.parse(row.assignedReviewerIds) : [];
    const gd5Files = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
    ).all(id);
    const bySlot = {};
    gd5Files.forEach(f => { bySlot[f.fieldName] = f; });
    gd5ReviewHistory = [1, 2].map(slot => {
      const f = bySlot['gd5_review_' + slot];
      const reviewerName = assignedReviewerNames && assignedReviewerNames[slot - 1] ? assignedReviewerNames[slot - 1] : 'Phản biện ' + slot;
      return {
        slot,
        reviewerName,
        originalName: f ? f.originalName : null,
        uploadedAt: f ? f.uploadedAt : null
      };
    });
  } catch (e) { /* ignore */ }
  const submissionFiles = db.prepare(
    `SELECT fieldName, originalName FROM submission_files WHERE submissionId = ? 
     AND fieldName NOT IN ('gd5_review_1','gd5_review_2','meeting_minutes','conditional_sci_ace_04','decision_vn','decision_en') 
     AND fieldName NOT LIKE 'report_periodic_%' AND fieldName <> 'report_final' 
     ORDER BY fieldName`
  ).all(id);
  const meetingMinutesFile = db.prepare(
    "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'"
  ).get(id);
  const conditionalFile = db.prepare(
    "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'"
  ).get(id);
  let decisionIssuedAt = null;
  let decisionVnFile = null;
  let decisionEnFile = null;
  try {
    const decRow = db.prepare('SELECT decisionIssuedAt FROM submissions WHERE id = ?').get(id);
    if (decRow) decisionIssuedAt = decRow.decisionIssuedAt;
    decisionVnFile = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'decision_vn'"
    ).get(id);
    decisionEnFile = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'decision_en'"
    ).get(id);
  } catch (e) { /* decision columns/files might not exist yet */ }
  let gd5History = [];
  try {
    gd5History = db.prepare(
      'SELECT id, actionType, performedAt, performedByName, fileFieldName, originalFileName, label FROM submission_gd5_history WHERE submissionId = ? ORDER BY performedAt ASC'
    ).all(id);
  } catch (e) { /* table might not exist yet */ }
  const status = row.status || 'SUBMITTED';
  return res.json({
    id: row.id,
    title: row.title,
    submittedBy: row.submittedBy,
    submittedByName: row.submittedByName || null,
    status,
    createdAt: row.createdAt,
    reviewNote: row.reviewNote || null,
    reviewedAt: row.reviewedAt || null,
    reviewedByName: row.reviewedByName || null,
    assignedReviewerIds: row.assignedReviewerIds || null,
    assignedAt: row.assignedAt || null,
    assignedById: row.assignedById || null,
    assignedByName: row.assignedByName || null,
    assignNote: row.assignNote || null,
    assignedReviewerNames: assignedReviewerNames.length ? assignedReviewerNames : null,
    gd5ReviewHistory,
    submissionFiles,
    meetingNote: row.meetingNote || null,
    meetingDecisionAt: row.meetingDecisionAt || null,
    meetingDecisionByName: row.meetingDecisionByName || null,
    meetingMinutes: meetingMinutesFile ? { originalName: meetingMinutesFile.originalName, uploadedAt: meetingMinutesFile.uploadedAt } : null,
    conditionalSubmittedAt: row.conditionalSubmittedAt || null,
    conditionalSubmittedByName: row.conditionalSubmittedByName || null,
    conditionalApprovedAt: row.conditionalApprovedAt || null,
    conditionalApprovedByName: row.conditionalApprovedByName || null,
    conditionalFile: conditionalFile ? { originalName: conditionalFile.originalName, uploadedAt: conditionalFile.uploadedAt } : null,
    decisionVn: decisionVnFile ? { originalName: decisionVnFile.originalName, uploadedAt: decisionVnFile.uploadedAt } : null,
    decisionEn: decisionEnFile ? { originalName: decisionEnFile.originalName, uploadedAt: decisionEnFile.uploadedAt } : null,
    decisionIssuedAt: decisionIssuedAt || null,
    gd5History: gd5History || [],
    reportPeriodicFiles: (() => { try { return db.prepare("SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'report_periodic_%' ORDER BY fieldName").all(id); } catch (e) { return []; } })(),
    reportFinalFile: (() => { try { return db.prepare("SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").get(id) || null; } catch (e) { return null; } })(),
    completedAt: (() => { try { const r = db.prepare('SELECT completedAt FROM submissions WHERE id = ?').get(id); return r ? r.completedAt : null; } catch (e) { return null; } })()
  });
  } catch (err) {
    console.error('[API] GET /api/submissions/' + (req.params.id) + ' error:', err);
    return res.status(500).json({ message: 'Lỗi máy chủ: ' + (err.message || 'Không xác định') });
  }
});

// Chấp thuận có điều kiện: NCV nộp SCI-ACE-04
app.post('/api/submissions/:id/conditional-submit', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể nộp SCI-ACE-04 khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp SCI-ACE-04' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file SCI-ACE-04 (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const rawName = file.originalname || '';
  const originalName = fixFilenameEncoding(rawName) || 'sci-ace-04-' + id + ext;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const finalPath = path.join(finalDir, 'conditional_sci_ace_04' + ext);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").get(id);
  if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  const uploadedAt = new Date().toISOString();
  db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(id);
  db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'conditional_sci_ace_04', ?, ?, ?)")
    .run(id, originalName, finalPath, uploadedAt);
  db.prepare('UPDATE submissions SET conditionalSubmittedAt = ?, conditionalSubmittedById = ? WHERE id = ?')
    .run(uploadedAt, req.user.id, id);
  insertGd5History(id, 'conditional_upload', req.user.id, 'conditional_sci_ace_04', originalName, 'NCV nộp SCI-ACE-04');
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  const subForEmail = db.prepare('SELECT title FROM submissions WHERE id = ?').get(id);
  const performerName = (req.user.fullname || req.user.email || 'Nghiên cứu viên').toString();
  sendConditionalSubmitEmail(subForEmail ? subForEmail.title : 'Hồ sơ #' + id, performerName, id);
  console.log('[API] POST /api/submissions/' + id + '/conditional-submit — NCV đã nộp SCI-ACE-04');
  return res.json({ message: 'Đã nộp SCI-ACE-04. Chủ tịch Hội đồng sẽ xem xét và thông qua.' });
});

// Chấp thuận có điều kiện: Chủ tịch thông qua sau khi NCV đã nộp SCI-ACE-04
app.put('/api/submissions/:id/conditional-approve', authMiddleware, (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được thông qua' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, conditionalSubmittedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể thông qua khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  if (!sub.conditionalSubmittedAt) {
    return res.status(400).json({ message: 'Nghiên cứu viên chưa nộp SCI-ACE-04. Vui lòng chờ NCV nộp trước khi thông qua.' });
  }
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, conditionalApprovedAt = ?, conditionalApprovedById = ? WHERE id = ?')
    .run('APPROVED', approvedAt, req.user.id, id);
  insertGd5History(id, 'conditional_approve', req.user.id, null, null, 'Chủ tịch thông qua');
  console.log('[API] PUT /api/submissions/' + id + '/conditional-approve — Chủ tịch đã thông qua');
  return res.json({ message: 'Đã thông qua. Hồ sơ chuyển sang giai đoạn Cấp Quyết định.' });
});

// Chấp thuận có điều kiện: Chủ tịch không thông qua → gửi email NCV + Hội đồng, xóa bản nộp để NCV nộp lại
app.put('/api/submissions/:id/conditional-reject', authMiddleware, (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy, conditionalSubmittedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể không thông qua khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  if (!sub.conditionalSubmittedAt) {
    return res.status(400).json({ message: 'Chưa có bản giải trình nào để xem xét.' });
  }
  const fileRow = db.prepare("SELECT id, path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").get(id);
  if (fileRow && fileRow.path && fs.existsSync(fileRow.path)) {
    const versionCount = db.prepare("SELECT COUNT(*) as c FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'conditional_sci_ace_04_v%'").get(id);
    const nextVer = (versionCount.c || 0) + 1;
    const newFieldName = 'conditional_sci_ace_04_v' + nextVer;
    const ext = path.extname(fileRow.path) || '.pdf';
    const newPath = path.join(path.dirname(fileRow.path), newFieldName + ext);
    try { fs.renameSync(fileRow.path, newPath); } catch (_) {
      try { fs.copyFileSync(fileRow.path, newPath); fs.unlinkSync(fileRow.path); } catch (__) {}
    }
    db.prepare("UPDATE submission_files SET fieldName = ?, path = ? WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(newFieldName, newPath, id);
    insertGd5History(id, 'conditional_reject', req.user.id, newFieldName, fileRow.originalName, 'Chủ tịch không thông qua (lần ' + nextVer + ')');
  } else {
    db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(id);
    insertGd5History(id, 'conditional_reject', req.user.id, null, null, 'Chủ tịch không thông qua');
  }
  db.prepare('UPDATE submissions SET conditionalSubmittedAt = NULL, conditionalSubmittedById = NULL WHERE id = ?').run(id);
  const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
  sendConditionalRejectEmail(sub.title, sub.submittedBy, chairmanName);
  console.log('[API] PUT /api/submissions/' + id + '/conditional-reject — Chủ tịch chưa thông qua');
  return res.json({ message: 'Đã gửi thông báo đến NCV và Hội đồng. NCV cần nộp lại SCI-ACE-04.' });
});

// GĐ5 (Họp Hội đồng): Thư ký upload biên bản + chọn kết luận (Chấp thuận / Có điều kiện / Không chấp thuận)
app.put('/api/submissions/:id/meeting-result', authMiddleware, upload.single('file'), (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IN_MEETING') {
    return res.status(400).json({ message: 'Chỉ có thể ghi nhận kết quả họp khi hồ sơ đang ở giai đoạn Họp Hội đồng' });
  }
  const decision = (req.body.decision || '').toLowerCase();
  if (!['approved', 'conditional', 'rejected'].includes(decision)) {
    return res.status(400).json({ message: 'Vui lòng chọn: Chấp thuận, Có điều kiện, hoặc Không chấp thuận' });
  }
  const note = (req.body.note || '').trim();
  const statusMap = { approved: 'APPROVED', conditional: 'CONDITIONAL', rejected: 'REJECTED' };
  const newStatus = statusMap[decision];
  const file = req.file;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  if (file && file.path) {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase() || '.pdf';
    const rawName = file.originalname || '';
    const originalName = fixFilenameEncoding(rawName) || 'bien-ban-hop-' + id + ext;
    const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
    const finalPath = path.join(finalDir, 'meeting_minutes' + safeExt);
    try {
      fs.renameSync(file.path, finalPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(id);
    if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
      try { fs.unlinkSync(existing.path); } catch (_) {}
    }
    const uploadedAt = new Date().toISOString();
    db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").run(id);
    db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'meeting_minutes', ?, ?, ?)")
      .run(id, originalName, finalPath, uploadedAt);
  }
  const meetingDecisionAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, meetingNote = ?, meetingDecisionAt = ?, meetingDecisionById = ? WHERE id = ?')
    .run(newStatus, note, meetingDecisionAt, req.user.id, id);
  const meetingFile = db.prepare("SELECT fieldName, originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(id);
  insertGd5History(id, 'meeting_result', req.user.id, meetingFile ? 'meeting_minutes' : null, meetingFile ? meetingFile.originalName : null, newStatus === 'CONDITIONAL' ? 'Chấp thuận có điều kiện' : (newStatus === 'APPROVED' ? 'Chấp thuận' : 'Không chấp thuận'));
  const secretaryName = (req.user.fullname || req.user.email || 'Thư ký').toString();
  sendMeetingResultEmail(sub.title, sub.submittedBy || null, decision, note, secretaryName);
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
  }
  const msg = decision === 'rejected'
    ? 'Đã ghi nhận: Không chấp thuận. Email đã gửi đến nghiên cứu viên và Hội đồng.'
    : (decision === 'approved' ? 'Đã ghi nhận: Chấp thuận. Email đã gửi đến nghiên cứu viên và Hội đồng. Chuyển sang giai đoạn Cấp Quyết định.' : 'Đã ghi nhận: Chấp thuận có điều kiện. Email đã gửi đến nghiên cứu viên và Hội đồng.');
  console.log('[API] PUT /api/submissions/' + id + '/meeting-result — ' + newStatus);
  return res.json({ message: msg, status: newStatus });
});

// GĐ6 (Cấp Quyết định): Thư ký upload Quyết định VN + EN, chuyển sang IMPLEMENTATION
app.put('/api/submissions/:id/issue-decision', authMiddleware, upload.fields([
  { name: 'decision_vn', maxCount: 1 },
  { name: 'decision_en', maxCount: 1 }
]), (req, res) => {
  const role = req.user.role;
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được cấp Quyết định' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'APPROVED') {
    return res.status(400).json({ message: 'Chỉ có thể cấp Quyết định khi hồ sơ đã được Hội đồng chấp thuận (trạng thái Đã phê duyệt)' });
  }
  const files = req.files || {};
  const fileVn = (files.decision_vn && files.decision_vn[0]) ? files.decision_vn[0] : null;
  const fileEn = (files.decision_en && files.decision_en[0]) ? files.decision_en[0] : null;
  if (!fileVn || !fileVn.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định tiếng Việt' });
  if (!fileEn || !fileEn.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định tiếng Anh' });
  const allowedExt = ['.pdf', '.docx', '.doc'];
  const extVn = (path.extname(fileVn.originalname || '') || '').toLowerCase();
  const extEn = (path.extname(fileEn.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(extVn)) { try { fs.unlinkSync(fileVn.path); } catch (_) {}; return res.status(400).json({ message: 'File Quyết định tiếng Việt: chỉ chấp nhận PDF hoặc Word' }); }
  if (!allowedExt.includes(extEn)) { try { fs.unlinkSync(fileEn.path); } catch (_) {}; return res.status(400).json({ message: 'File Quyết định tiếng Anh: chỉ chấp nhận PDF hoặc Word' }); }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const saveFile = (file, fieldName, defaultName) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase() || '.pdf';
    const originalName = fixFilenameEncoding(file.originalname || '') || defaultName + ext;
    const safeExt = allowedExt.includes(ext) ? ext : '.pdf';
    const finalPath = path.join(finalDir, fieldName + safeExt);
    try { fs.renameSync(file.path, finalPath); } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    const existing = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = ?').get(id, fieldName);
    if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) { try { fs.unlinkSync(existing.path); } catch (_) {} }
    db.prepare('DELETE FROM submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
    db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)')
      .run(id, fieldName, originalName, finalPath, new Date().toISOString());
  };
  saveFile(fileVn, 'decision_vn', 'quyet-dinh-vn');
  saveFile(fileEn, 'decision_en', 'quyet-dinh-en');
  const issuedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, decisionIssuedAt = ?, decisionIssuedById = ? WHERE id = ?')
    .run('IMPLEMENTATION', issuedAt, req.user.id, id);
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const trackUrl = baseUrl + '/theo-doi-ho-so.html?id=' + id;
  sendDecisionIssuedEmail(sub.title, sub.submittedBy, trackUrl);
  console.log('[API] PUT /api/submissions/' + id + '/issue-decision — Đã cấp Quyết định');
  return res.json({ message: 'Đã cấp Quyết định. Email đã gửi đến NCV và Hội đồng.', status: 'IMPLEMENTATION' });
});

// GĐ7: NCV upload báo cáo định kỳ (SCI-ACE-07 định kỳ)
app.post('/api/submissions/:id/report-periodic', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IMPLEMENTATION') {
    return res.status(400).json({ message: 'Chỉ có thể nộp báo cáo định kỳ khi hồ sơ đang ở giai đoạn Thực hiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp báo cáo định kỳ' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file báo cáo định kỳ (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const count = db.prepare("SELECT COUNT(*) as c FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'report_periodic_%'").get(id);
  const slot = (count.c || 0) + 1;
  const fieldName = 'report_periodic_' + slot;
  const originalName = fixFilenameEncoding(file.originalname || '') || 'bao-cao-dinh-ky-' + slot + ext;
  const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
  const finalPath = path.join(finalDir, fieldName + safeExt);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, fieldName, originalName, finalPath, new Date().toISOString());
  console.log('[API] POST /api/submissions/' + id + '/report-periodic — Đã nộp báo cáo định kỳ #' + slot);
  return res.json({ message: 'Đã nộp báo cáo định kỳ.', fieldName, slot });
});

// GĐ7: NCV upload báo cáo kết thúc (SCI-ACE-07 kết thúc) → chuyển sang COMPLETED
app.post('/api/submissions/:id/report-final', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IMPLEMENTATION') {
    return res.status(400).json({ message: 'Chỉ có thể nộp báo cáo kết thúc khi hồ sơ đang ở giai đoạn Thực hiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp báo cáo kết thúc' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file báo cáo kết thúc (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").get(id);
  if (existing && existing.path && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").run(id);
  const originalName = fixFilenameEncoding(file.originalname || '') || 'bao-cao-ket-thuc.pdf';
  const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
  const finalPath = path.join(finalDir, 'report_final' + safeExt);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'report_final', ?, ?, ?)")
    .run(id, originalName, finalPath, new Date().toISOString());
  const completedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, completedAt = ? WHERE id = ?').run('COMPLETED', completedAt, id);
  console.log('[API] POST /api/submissions/' + id + '/report-final — Đã nộp báo cáo kết thúc, hồ sơ hoàn thành');
  return res.json({ message: 'Đã nộp báo cáo kết thúc. Hồ sơ đã hoàn thành.', status: 'COMPLETED' });
});

// Tải một file trong hồ sơ (theo fieldName): Hội đồng/Admin hoặc chủ hồ sơ
app.get('/api/submissions/:id/file/:fieldName', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fieldName = (req.params.fieldName || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !fieldName) return res.status(400).json({ message: 'Tham số không hợp lệ' });
  const sub = db.prepare('SELECT id, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file này' });
  }
  const row = db.prepare('SELECT path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = ?').get(id, fieldName);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  return safeDownload(res, row.path, row.originalName || fieldName);
});

// Thư ký Hội đồng xử lý GĐ3 (kiểm tra hồ sơ): pass / reject / need_supplement / need_revision
app.put('/api/submissions/:id/review', authMiddleware, (req, res) => {
  console.log('[API] PUT /api/submissions/' + req.params.id + '/review');
  const role = req.user.role;
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedBy, status FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || 'SUBMITTED') !== 'SUBMITTED') {
    return res.status(400).json({ message: 'Hồ sơ này đã được xử lý tại GĐ3 trước đó' });
  }
  const { decision, comment } = req.body || {};
  const valid = ['pass', 'reject', 'need_supplement', 'need_revision'];
  if (!decision || !valid.includes(decision)) {
    return res.status(400).json({ message: 'Vui lòng chọn: pass, reject, need_supplement hoặc need_revision' });
  }
  const statusMap = { pass: 'VALIDATED', reject: 'REJECTED', need_supplement: 'NEED_REVISION', need_revision: 'NEED_REVISION' };
  const newStatus = statusMap[decision];
  const reviewedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
    .run(newStatus, (comment || '').trim(), reviewedAt, req.user.id, id);
  const reviewerName = (req.user.fullname || req.user.email || 'Thư ký').toString();
  sendStage3ResultEmail(sub.title, sub.submittedBy, decision, (comment || '').trim(), reviewerName);
  return res.json({ message: 'Đã cập nhật kết quả kiểm tra. Email đã gửi đến nghiên cứu viên và Hội đồng.', status: newStatus });
});

// Chủ tịch Hội đồng phân công phản biện (GĐ4): ≥2 thành viên, lưu lịch sử, gửi email cho phản biện và toàn Hội đồng
app.put('/api/submissions/:id/assign-reviewers', authMiddleware, (req, res) => {
  console.log('[API] PUT /api/submissions/' + req.params.id + '/assign-reviewers');
  const role = req.user.role;
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được phân công phản biện' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedBy, status FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'VALIDATED') {
    return res.status(400).json({ message: 'Chỉ có thể phân công phản biện khi hồ sơ ở trạng thái Đã kiểm tra (chờ phân công)' });
  }
  let reviewerIds = req.body && req.body.reviewerIds;
  if (!Array.isArray(reviewerIds)) reviewerIds = [];
  reviewerIds = reviewerIds.map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
  const uniqueIds = [...new Set(reviewerIds)];
  if (uniqueIds.length < 2) {
    return res.status(400).json({ message: 'Vui lòng chọn ít nhất 2 phản biện (thành viên Hội đồng)' });
  }
  const councilIds = db.prepare("SELECT id FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin')").all().map(r => r.id);
  const invalid = uniqueIds.filter(uid => !councilIds.includes(uid));
  if (invalid.length > 0) {
    return res.status(400).json({ message: 'Tất cả phản biện phải là thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên) hoặc Admin' });
  }
  const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
  const assignedAt = new Date().toISOString();
  db.prepare(
    'UPDATE submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ?, assignNote = ? WHERE id = ?'
  ).run('UNDER_REVIEW', JSON.stringify(uniqueIds), assignedAt, req.user.id, note, id);
  const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + uniqueIds.map(() => '?').join(',') + ')').all(...uniqueIds);
  const reviewerEmails = reviewers.map(r => r.email);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendStage4AssignmentEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, note);
  return res.json({
    message: 'Đã phân công phản biện. Email đã gửi đến các phản biện và toàn thể Hội đồng. Giai đoạn chuyển sang GĐ5.',
    status: 'UNDER_REVIEW'
  });
});

// Admin: đưa hồ sơ về GĐ4 để Chủ tịch phân công lại phản biện (khi Chủ tịch yêu cầu điều chỉnh)
app.put('/api/submissions/:id/reset-gd4', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, assignedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const status = sub.status || '';
  if (status !== 'UNDER_REVIEW') {
    return res.status(400).json({ message: 'Chỉ có thể đưa về GĐ4 khi hồ sơ đang ở giai đoạn Đang đánh giá (GĐ5). Trạng thái hiện tại: ' + status });
  }
  db.prepare(
    'UPDATE submissions SET status = ?, assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, assignNote = NULL WHERE id = ?'
  ).run('VALIDATED', id);
  console.log('[API] PUT /api/submissions/' + id + '/reset-gd4 — đã đưa về GĐ4');
  return res.json({
    message: 'Đã đưa hồ sơ về GĐ4. Chủ tịch Hội đồng có thể vào trang theo dõi và thực hiện lại phân công phản biện.',
    status: 'VALIDATED'
  });
});

// GĐ5: Danh sách file phản biện (2 slot) — để hiển thị / tải
app.get('/api/submissions/:id/review-files', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  let reviewerIdsCheck = [];
  try { reviewerIdsCheck = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const isAssignedReviewer = reviewerIdsCheck.includes(req.user.id);
  if (!isCouncilOrAdmin && !isAssignedReviewer) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc phản biện được phân công mới xem được' });
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const reviewers = reviewerIds.length
    ? db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds)
    : [];
  const files = db.prepare(
    "SELECT fieldName, originalName, path FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
  ).all(id);
  const fileBySlot = {};
  files.forEach(f => { fileBySlot[f.fieldName] = f; });
  const result = [1, 2].map(slot => {
    const reviewerId = reviewerIds[slot - 1];
    const u = reviewers.find(r => r.id === reviewerId);
    const f = fileBySlot['gd5_review_' + slot];
    return {
      slot,
      reviewerId: reviewerId || null,
      reviewerName: u ? (u.fullname || u.email || '') : '—',
      originalName: f ? f.originalName : null,
      hasFile: !!f
    };
  });
  return res.json({ reviewFiles: result });
});

// GĐ5: Tải file phản biện (slot 1 hoặc 2)
app.get('/api/submissions/:id/review-file/:slot', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.params.slot, 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'Tham số không hợp lệ' });
  const sub = db.prepare('SELECT id, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isReviewerForSlot = reviewerIds[slot - 1] === req.user.id;
  if (!isCouncilOrAdmin && !isReviewerForSlot) return res.status(403).json({ message: 'Không có quyền tải file này' });
  const row = db.prepare(
    'SELECT path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = ?'
  ).get(id, 'gd5_review_' + slot);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file phản biện' });
  return safeDownload(res, row.path, row.originalName || 'phản biện ' + slot + '.pdf');
});

// GĐ5: Phản biện upload file đánh giá (PDF/docx có chữ ký hoặc bản scan)
app.post('/api/submissions/:id/review-upload', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'UNDER_REVIEW') {
    return res.status(400).json({ message: 'Chỉ có thể nộp file phản biện khi hồ sơ đang ở GĐ5 (Đang đánh giá)' });
  }
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  const bodySlot = req.body.slot != null ? parseInt(req.body.slot, 10) : NaN;
  const slotIndex = reviewerIds.indexOf(req.user.id);
  let slot;
  if (isAdmin && (bodySlot === 1 || bodySlot === 2)) {
    slot = bodySlot;
  } else if (slotIndex !== -1) {
    slot = slotIndex + 1;
  } else {
    return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được nộp file đánh giá. Admin cần chọn đúng ô slot 1 hoặc 2.' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file (PDF hoặc docx)' });
  const rawName = file.originalname || '';
  const originalName = fixFilenameEncoding(rawName) || path.basename(file.path);
  const ext = (path.extname(originalName) || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word (docx/doc)' });
  }
  const existing = db.prepare(
    'SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = ?'
  ).get(id, 'gd5_review_' + slot);
  let finalPath = file.path;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  if (firstFile && firstFile.path) {
    const finalDir = path.dirname(firstFile.path);
    const safeName = 'gd5_review_' + slot + ext;
    finalPath = path.join(finalDir, safeName);
    fs.mkdirSync(finalDir, { recursive: true });
    try {
      fs.renameSync(file.path, finalPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
  }
  if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  const uploadedAt = new Date().toISOString();
  db.prepare('DELETE FROM submission_files WHERE submissionId = ? AND fieldName = ?').run(id, 'gd5_review_' + slot);
  db.prepare(
    'INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)'
  ).run(id, 'gd5_review_' + slot, originalName, finalPath, uploadedAt);
  const bothDone = db.prepare(
    "SELECT 1 FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
  ).all(id);
  if (bothDone.length >= 2) {
    db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run('IN_MEETING', id);
    console.log('[API] Cả 2 phản biện đã nộp — chuyển hồ sơ ' + id + ' sang GĐ6 (IN_MEETING)');
  }
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
  }
  console.log('[API] POST /api/submissions/' + id + '/review-upload — slot ' + slot);
  return res.json({
    message: bothDone.length >= 2
      ? 'Đã nộp file đánh giá. Cả 2 phản biện đã nộp xong — hồ sơ chuyển sang GĐ6 (Họp Hội đồng).'
      : 'Đã nộp file đánh giá phản biện. Các thành viên Hội đồng có thể xem và tải file.',
    slot,
    originalName,
    status: bothDone.length >= 2 ? 'IN_MEETING' : undefined
  });
});

// Tải hồ sơ: Nghiên cứu viên chỉ tải được hồ sơ của mình; Hội đồng/Admin tải được mọi hồ sơ (không cho sửa)
app.get('/api/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db.prepare('SELECT id, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ này' });
  }
  const files = db.prepare('SELECT path, originalName FROM submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'Không tìm thấy file hồ sơ' });
  const prepared = prepareDownloadFileList(res, files);
  if (!prepared) return;
  if (prepared.length === 1) return res.download(prepared[0].norm, prepared[0].originalName);
  try {
    const archiver = require('archiver');
    res.attachment('ho-so-' + id + '.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    prepared.forEach((p) => archive.file(p.norm, { name: p.originalName }));
    archive.finalize();
  } catch (e) {
    return res.download(prepared[0].norm, prepared[0].originalName);
  }
});

// Xóa hồ sơ: chỉ Admin
app.delete('/api/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const files = db.prepare('SELECT path FROM submission_files WHERE submissionId = ?').all(id);
  const submissionDir = files.length > 0 ? resolveGdSubmissionDirForRmSync(id, files[0].path) : null;
  db.transaction(() => {
    db.prepare('DELETE FROM submission_files WHERE submissionId = ?').run(id);
    db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  })();
  if (submissionDir && fs.existsSync(submissionDir)) {
    try { fs.rmSync(submissionDir, { recursive: true }); } catch (e) { /* ignore */ }
  }
  return res.json({ message: 'Đã xóa hồ sơ' });
});

// ========== API Đề tài cấp Viện (Nhiệm vụ KHCN cấp cơ sở) — DB và upload riêng ==========
app.post('/api/cap-vien/submissions', authMiddleware, uploadCapVien.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đề tài / mã hồ sơ' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'Cần đủ 3 file: Thuyết minh, Kế hoạch, Tài liệu bổ sung' });
  }
  let optionsChecked = [];
  try {
    const raw = req.body.options_checked;
    if (raw) optionsChecked = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
  } catch (e) { optionsChecked = []; }
  if (!Array.isArray(optionsChecked)) optionsChecked = [];

  const run = db.transaction(() => {
    const year = new Date().getFullYear();
    const countRow = db.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions WHERE createdAt >= ? AND createdAt < ?').get(year + '-01-01', (year + 1) + '-01-01');
    const seq = (countRow && countRow.n != null ? countRow.n : 0) + 1;
    const baseCode = 'DTSCI-' + year + '-' + String(seq).padStart(3, '0');
    const optsWithAffect = db.prepare('SELECT code FROM cap_vien_submission_options WHERE affects_code = 1').all();
    const affectCodes = optsWithAffect.map(r => (r.code || '').toUpperCase()).filter(Boolean);
    const checkedAffect = optionsChecked.filter(c => affectCodes.includes((c || '').toUpperCase()));
    let code = baseCode;
    if (checkedAffect.length > 0) {
      const suffix = (checkedAffect[0] || '').toUpperCase();
      code = 'DTSCI-' + suffix + '-' + year + '-' + String(seq).padStart(3, '0');
    }
    const optionsCheckedJson = JSON.stringify(optionsChecked);
    const sub = db.prepare('INSERT INTO cap_vien_submissions (title, submittedBy, submittedById, code, options_checked) VALUES (?, ?, ?, ?, ?)').run(title, req.user.email, req.user.id, code, optionsCheckedJson);
    const subId = sub.lastInsertRowid;
    const researcherName = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]);
    const researcherFolder = researcherName + '_' + req.user.id;
    const finalDir = path.join(uploadDirCapVien, researcherFolder, 'submission_' + subId);
    fs.mkdirSync(finalDir, { recursive: true });
    const move = (f, fieldName) => {
      if (!f || !f.path) return;
      const newPath = path.join(finalDir, path.basename(f.path));
      try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
      const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)').run(subId, fieldName, storedName, newPath);
    };
    move(f01, 'thuyet_minh');
    move(f02, 'ke_hoach');
    move(f03, 'tai_lieu_bo_sung');
    (files.attachments || []).forEach((f, i) => move(f, 'attachment_' + i));
    const tempDir = req._uploadDirCapVien;
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
    }
    return subId;
  })();
  const id = Number(run);
  const row = db.prepare('SELECT createdAt, status FROM cap_vien_submissions WHERE id = ?').get(id);
  insertCapVienHistory(id, '1', 'researcher_submit', req.user.id, 'researcher', 'Nghiên cứu viên nộp hồ sơ đề xuất', row ? row.createdAt : null);
  sendCapVienNewSubmissionEmail({
    submissionId: id,
    submissionTitle: title,
    submittedByEmail: req.user.email,
    submittedByName: req.user.fullname,
    createdAt: row ? row.createdAt : null,
    status: row ? row.status : 'SUBMITTED'
  });
  return res.status(201).json({ id, message: 'Đã gửi hồ sơ đề tài cấp Viện thành công' });
});

// Ô đánh dấu khi nộp đề tài cấp Viện (CoE, Kinh phí Viện...) — public để form hiển thị
app.get('/api/cap-vien/submission-options', (req, res) => {
  const rows = db.prepare('SELECT id, code, label, affects_code FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});

// Danh mục hạng mục (public, dùng trong form nộp hồ sơ)
app.get('/api/cap-vien/linh-vuc', (req, res) => {
  const rows = db.prepare('SELECT id, code, label FROM cap_vien_linh_vuc ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
app.get('/api/cap-vien/loai-de-tai', (req, res) => {
  const rows = db.prepare('SELECT id, code, label FROM cap_vien_loai_de_tai ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
app.get('/api/cap-vien/don-vi', (req, res) => {
  const rows = db.prepare('SELECT id, code, label FROM cap_vien_don_vi ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
app.get('/api/cap-vien/khoan-muc-chi', (req, res) => {
  const rows = db.prepare('SELECT id, code, label, parent_code FROM cap_vien_khoan_muc_chi ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});

// ── Mẫu hồ sơ công khai (trang tai-mau-ho-so-de-tai-cap-vien) — Admin upload; mọi người tải khi đã có file ──
app.get('/api/cap-vien/public-templates', (req, res) => {
  try {
    const rows = db.prepare('SELECT task_code, original_name, uploaded_at FROM cap_vien_public_template_files').all();
    const byCode = new Map((rows || []).map((r) => [r.task_code, r]));
    const tasks = CAP_VIEN_PUBLIC_TEMPLATE_CATALOG.map((item) => {
      const row = byCode.get(item.code);
      return {
        taskCode: item.code,
        label: item.label,
        hasFile: !!row,
        originalName: row ? row.original_name : null,
        uploadedAt: row ? row.uploaded_at : null,
      };
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ tasks });
  } catch (e) {
    console.error('[public-templates list]', e);
    return res.status(500).json({ message: e.message || 'Lỗi CSDL' });
  }
});

app.get('/api/cap-vien/public-templates/:taskCode/file', (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(404).json({ message: 'Mã mẫu không hợp lệ' });
  }
  const row = db.prepare('SELECT stored_path, original_name FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'Chưa có file mẫu cho mã này. Vui lòng liên hệ quản trị hoặc thử lại sau.' });
  }
  const abs = resolveStoredFileFromDb(row.stored_path);
  const baseDir = path.resolve(capVienPublicTemplatesFsDir);
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs) || !fs.existsSync(abs)) {
    return res.status(404).json({ message: 'File không còn trên máy chủ' });
  }
  res.set('Cache-Control', 'no-store');
  return res.download(abs, row.original_name || path.basename(abs));
});

app.post(
  '/api/cap-vien/public-templates/:taskCode',
  authMiddleware,
  adminOnly,
  uploadCapVienPublicTemplate.single('file'),
  (req, res) => {
    const taskCode = (req.params.taskCode || '').trim();
    if (!isAllowedTaskCode(taskCode)) {
      return res.status(400).json({ message: 'Mã mẫu không hợp lệ' });
    }
    const f = req.file;
    if (!f) {
      return res.status(400).json({ message: 'Thiếu file (form field: file)' });
    }
    const relStored = path
      .relative(uploadDirCapVien, path.normalize(f.path))
      .replace(/\\/g, '/');
    const orig = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    try {
      const prev = db.prepare('SELECT stored_path FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
      if (prev && prev.stored_path) {
        const oldAbs = resolveCapVienPublicTemplateStoredFileForUnlink(prev.stored_path);
        if (oldAbs) {
          try {
            fs.unlinkSync(oldAbs);
          } catch (_) {}
        }
      }
      db.prepare(
        `INSERT INTO cap_vien_public_template_files (task_code, stored_path, original_name, uploaded_at, uploaded_by_id)
         VALUES (?, ?, ?, datetime('now'), ?)
         ON CONFLICT(task_code) DO UPDATE SET
           stored_path = excluded.stored_path,
           original_name = excluded.original_name,
           uploaded_at = excluded.uploaded_at,
           uploaded_by_id = excluded.uploaded_by_id`
      ).run(taskCode, relStored, orig, req.user.id);
      return res.json({ ok: true, message: 'Đã cập nhật mẫu', taskCode, originalName: orig });
    } catch (e) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch (_) {}
      console.error('[public-templates upload]', e);
      return res.status(500).json({ message: e.message || 'Lỗi lưu' });
    }
  }
);

app.delete('/api/cap-vien/public-templates/:taskCode', authMiddleware, adminOnly, (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(400).json({ message: 'Mã mẫu không hợp lệ' });
  }
  const row = db.prepare('SELECT stored_path FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'Không có file để xóa' });
  }
  try {
    const p = resolveCapVienPublicTemplateStoredFileForUnlink(row.stored_path);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
    db.prepare('DELETE FROM cap_vien_public_template_files WHERE task_code = ?').run(taskCode);
    return res.json({ ok: true, message: 'Đã xóa mẫu' });
  } catch (e) {
    console.error('[public-templates delete]', e);
    return res.status(500).json({ message: e.message || 'Lỗi xóa' });
  }
});

// Admin: CRUD ô đánh dấu
app.get('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});
app.post('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const { code, label, affects_code } = req.body || {};
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '') || codeStr;
  if (!codeStr) return res.status(400).json({ message: 'Mã option không được để trống' });
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cap_vien_submission_options').get();
    const nextOrder = (maxOrder && maxOrder.m != null ? maxOrder.m : 0) + 1;
    db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, affects_code ? 1 : 0, nextOrder);
    const row = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE code = ?').get(codeStr);
    return res.status(201).json({ message: 'Đã thêm ô đánh dấu', option: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Mã option đã tồn tại' });
    throw e;
  }
});
app.put('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, label, affects_code, sort_order } = req.body || {};
  const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy option' });
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '');
  const updates = [];
  const params = [];
  if (codeStr !== '') { updates.push('code = ?'); params.push(codeStr); }
  if (labelStr !== '') { updates.push('label = ?'); params.push(labelStr); }
  if (affects_code !== undefined) { updates.push('affects_code = ?'); params.push(affects_code ? 1 : 0); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10) || 0); }
  if (updates.length === 0) return res.json({ message: 'Không có thay đổi' });
  params.push(id);
  db.prepare('UPDATE cap_vien_submission_options SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE id = ?').get(id);
  return res.json({ message: 'Đã cập nhật', option: updated });
});
app.delete('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy option' });
  db.prepare('DELETE FROM cap_vien_submission_options WHERE id = ?').run(id);
  return res.json({ message: 'Đã xóa ô đánh dấu' });
});

// Admin: CRUD Lĩnh vực KHCN
function crudCapVienTable(tableName, singularLabel) {
  const table = 'cap_vien_' + tableName;
  app.get('/api/admin/cap-vien/' + tableName, authMiddleware, adminOnly, (req, res) => {
    const rows = db.prepare('SELECT id, code, label, sort_order' + (tableName === 'khoan_muc_chi' ? ', parent_code' : '') + ' FROM ' + table + ' ORDER BY sort_order ASC, id ASC').all();
    return res.json({ items: rows });
  });
  app.post('/api/admin/cap-vien/' + tableName, authMiddleware, adminOnly, (req, res) => {
    const { code, label, parent_code } = req.body || {};
    const codeStr = (code || '').toString().trim().replace(/\s+/g, '_');
    const labelStr = (label || codeStr || '').toString().trim();
    if (!codeStr) return res.status(400).json({ message: 'Mã không được để trống' });
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ' + table).get();
    try {
      if (tableName === 'khoan_muc_chi') {
        db.prepare('INSERT INTO ' + table + ' (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, (parent_code || '').trim() || null, (maxOrder.m || 0) + 1);
      } else {
        db.prepare('INSERT INTO ' + table + ' (code, label, sort_order) VALUES (?, ?, ?)').run(codeStr, labelStr, (maxOrder.m || 0) + 1);
      }
      const row = db.prepare('SELECT * FROM ' + table + ' WHERE code = ?').get(codeStr);
      return res.json({ message: 'Đã thêm ' + singularLabel, item: row });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'Mã đã tồn tại' });
      throw e;
    }
  });
  app.put('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { code, label, parent_code, sort_order } = req.body || {};
    const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const updates = [];
    const params = [];
    if (code != null) { updates.push('code = ?'); params.push(String(code).trim().replace(/\s+/g, '_')); }
    if (label != null) { updates.push('label = ?'); params.push(String(label).trim()); }
    if (parent_code !== undefined && tableName === 'khoan_muc_chi') { updates.push('parent_code = ?'); params.push((parent_code || '').trim() || null); }
    if (sort_order != null) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10)); }
    if (updates.length) {
      params.push(id);
      db.prepare('UPDATE ' + table + ' SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    }
    const updated = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id);
    return res.json({ message: 'Đã cập nhật', item: updated });
  });
  app.delete('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id);
    return res.json({ message: 'Đã xóa ' + singularLabel });
  });
}
crudCapVienTable('linh_vuc', 'lĩnh vực');
crudCapVienTable('loai_de_tai', 'loại đề tài');
crudCapVienTable('don_vi', 'đơn vị');
crudCapVienTable('khoan_muc_chi', 'khoản mục chi');

// Admin: đồng bộ nhiệm vụ KHCN từ đề tài cấp Viện
app.post('/api/admin/missions/sync-from-cap-vien', authMiddleware, adminOnly, (req, res) => {
  // Gỡ trạng thái «ẩn khỏi dashboard» (missions_hidden) để các hồ sơ cấp Viện còn tồn tại được đồng bộ lại.
  // Ẩn chỉ được ghi khi Admin xóa đề tài đồng bộ từ cấp Viện khỏi bảng — nút Đồng bộ = khôi phục theo nguồn.
  try {
    db.prepare("DELETE FROM missions_hidden WHERE source_type = 'cap_vien'").run();
  } catch (e) {
    /* bảng có thể chưa tồn tại trên DB rất cũ */
  }
  syncMissionsFromCapVien();
  const count = db.prepare('SELECT COUNT(*) AS n FROM missions WHERE source_type = ?').get('cap_vien');
  return res.json({ message: 'Đã đồng bộ nhiệm vụ KHCN từ đề tài cấp Viện.', count: count.n });
});

// Admin: danh sách đề tài cấp Viện (đầy đủ, cho quản trị)
app.get('/api/admin/cap-vien/submissions', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
  rows.forEach(r => {
    const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
    r.submittedByName = u ? u.fullname : null;
  });
  return res.json({ submissions: rows });
});

// Admin: sửa mã đề tài (trường hợp cần thiết)
app.get('/api/admin/cap-vien/settings/step7-complete-email', authMiddleware, adminOnly, (req, res) => {
  return res.json({ enabled: getCapVienStep7EmailOnComplete() });
});

app.put('/api/admin/cap-vien/settings/step7-complete-email', authMiddleware, adminOnly, (req, res) => {
  const body = req.body || {};
  const raw = body.enabled !== undefined ? body.enabled : body.sendEmail;
  const on = raw === true || raw === 1 || String(raw).toLowerCase() === 'true' || String(raw) === '1';
  const val = on ? '1' : '0';
  db.prepare('INSERT INTO cooperation_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('cap_vien_step7_complete_send_email', val);
  return res.json({ message: on ? 'Đã bật gửi email khi hoàn thành Bước 7.' : 'Đã tắt gửi email khi hoàn thành Bước 7.', enabled: on });
});

app.put('/api/admin/cap-vien/submissions/:id/code', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const newCode = (req.body && req.body.code != null) ? String(req.body.code).trim() : '';
  const row = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!newCode) return res.status(400).json({ message: 'Mã đề tài không được để trống' });
  db.prepare('UPDATE cap_vien_submissions SET code = ? WHERE id = ?').run(newCode, id);
  return res.json({ message: 'Đã cập nhật mã đề tài', code: newCode });
});

/** Xem mọi hồ sơ cấp Viện (danh sách + chi tiết + tải): Admin, Viện trưởng, P.KHCN, Hội đồng. Chủ nhiệm chỉ hồ sơ của mình. */
function capVienRoleSeesAllSubmissions(roleRaw) {
  const r = String(roleRaw || '').toLowerCase();
  return (
    r === 'admin' ||
    r === 'vien_truong' ||
    r === 'phong_khcn' ||
    r === 'chu_tich' ||
    r === 'thu_ky' ||
    r === 'thanh_vien'
  );
}

app.get('/api/cap-vien/submissions', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache');
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(role);
  if (isCouncilOrAdmin) {
    const rows = db.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
    rows.forEach(r => {
      const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
      r.submittedByName = u ? u.fullname : null;
    });
    return res.json(rows);
  }
  const rows = db.prepare('SELECT id, title, submittedBy, status, createdAt, code FROM cap_vien_submissions WHERE submittedById = ? ORDER BY createdAt DESC').all(req.user.id);
  return res.json(rows);
});

app.get('/api/cap-vien/submissions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const row = db.prepare(`SELECT id, title, submittedBy, submittedById, status, createdAt, code, options_checked, reviewNote, reviewedAt, reviewedById, assignedReviewerIds, assignedAt, assignedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round, budget_4a_revision_note, budget_4a_revision_requested_at, budget_4a_revision_requested_by, budget_4a_approved_at, budget_4a_approved_by, step_4_reviewer1_done, step_4_reviewer2_done, step5_hd_meeting_location, step5_hd_meeting_attendance, step5_hd_meeting_documents, step5_hd_meeting_vote_result, step5_hd_meeting_decision, step5_hd_meeting_event_time, step5_hd_meeting_updated_at, step5_hd_meeting_updated_by, step5_council_revision_status, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_note, step5_council_revision_requested_at, step5_council_revision_requested_by, step6_so_qd, step6_kinh_phi, step6_thoi_gian, step6_phi_quan_ly, step6_meta_updated_at, step6_meta_updated_by, step7_so_hd, step7_hieu_luc, step7_meta_updated_at, step7_meta_updated_by, step8_ma_dao_duc, step8_hieu_luc, step8_so_quyet_dinh, step8_meta_updated_at, step8_meta_updated_by, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived, COALESCE(step8a_completed, 0) AS step8a_completed, COALESCE(step8a_waived, 0) AS step8a_waived FROM cap_vien_submissions WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(role);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này' });
  }
  const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById);
  const files = db.prepare('SELECT id, fieldName, originalName, path, COALESCE(revisionRound, 0) AS revisionRound, uploadedById, uploadedByRole, uploadedAt FROM cap_vien_submission_files WHERE submissionId = ? ORDER BY revisionRound ASC, id ASC').all(id);
  const stepDeadlinesRows = db.prepare('SELECT stepId, openedAt, dueAt, durationDays, updatedById, updatedAt FROM cap_vien_step_deadlines WHERE submissionId = ?').all(id);
  const stepDeadlines = {};
  stepDeadlinesRows.forEach(r => { stepDeadlines[r.stepId] = r; });
  const reviewedBy = (row.reviewedById != null) ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.reviewedById) : null;
  const allHistory = db.prepare('SELECT stepId, actionType, performedAt, performedById, performedByName, performedByRole, note FROM cap_vien_submission_history WHERE submissionId = ? ORDER BY performedAt ASC').all(id);
  const stepHistory = {};
  allHistory.forEach(h => {
    if (!stepHistory[h.stepId]) stepHistory[h.stepId] = [];
    stepHistory[h.stepId].push({ actionType: h.actionType, performedAt: h.performedAt, performedById: h.performedById, performedByName: h.performedByName, performedByRole: h.performedByRole, note: h.note });
  });
  let step2History = (stepHistory['2'] || []);
  if (step2History.length === 0) {
    const legacy = db.prepare('SELECT actionType, performedAt, performedById, performedByName, performedByRole, note FROM cap_vien_step2_history WHERE submissionId = ? ORDER BY performedAt ASC').all(id);
    if (legacy.length) step2History = legacy;
    else if (row.reviewedAt && row.reviewedById) {
      const actionType = (row.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
      const note = row.reviewNote || (actionType === 'secretary_approve' ? 'Hợp lệ' : null);
      const revUser = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.reviewedById);
      step2History = [{ actionType, performedAt: row.reviewedAt, performedById: row.reviewedById, performedByName: revUser ? revUser.fullname : '', performedByRole: 'secretary', note }];
    }
  }
  stepHistory['2'] = step2History;
  let assignedBy = null;
  let reviewerNames = [];
  if (row.assignedById) assignedBy = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.assignedById);
  if (row.assignedReviewerIds) {
    try {
      const ids = JSON.parse(row.assignedReviewerIds);
      const reviewers = db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids);
      reviewerNames = ids.map(rid => { const r = reviewers.find(x => x.id === rid); return r ? (r.fullname || r.email || '') : '—'; });
    } catch (e) {}
  }
  let displayCode = row.code;
  if (!displayCode && row.id) {
    const y = (row.createdAt || '').toString().slice(0, 4) || new Date().getFullYear();
    displayCode = 'DTSCI-' + y + '-' + String(row.id).padStart(3, '0');
  }
  let step5HdMeetingUpdatedByName = null;
  if (row.step5_hd_meeting_updated_by != null) {
    const u5 = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step5_hd_meeting_updated_by);
    if (u5) step5HdMeetingUpdatedByName = u5.fullname || u5.email || null;
  }
  let step5CouncilRevisionRequestedByName = null;
  if (row.step5_council_revision_requested_by != null) {
    const uRev = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step5_council_revision_requested_by);
    if (uRev) step5CouncilRevisionRequestedByName = uRev.fullname || uRev.email || null;
  }
  let step6MetaUpdatedByName = null;
  if (row.step6_meta_updated_by != null) {
    const u6m = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step6_meta_updated_by);
    if (u6m) step6MetaUpdatedByName = u6m.fullname || u6m.email || null;
  }
  let step7MetaUpdatedByName = null;
  if (row.step7_meta_updated_by != null) {
    const u7m = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step7_meta_updated_by);
    if (u7m) step7MetaUpdatedByName = u7m.fullname || u7m.email || null;
  }
  let step8MetaUpdatedByName = null;
  if (row.step8_meta_updated_by != null) {
    const u8m = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step8_meta_updated_by);
    if (u8m) step8MetaUpdatedByName = u8m.fullname || u8m.email || null;
  }
  const stepActualStats = computeCapVienStepActualStats(row, stepHistory, stepDeadlines);
  let periodicReport = null;
  try {
    periodicReport = getCapVienPeriodicReportBundle(id, true, role);
  } catch (e) {
    periodicReport = { config: null, periods: [], primaryFiles: {}, adminLog: [] };
  }
  return res.json({
    ...row,
    code: displayCode,
    step5HdMeetingUpdatedByName,
    step5CouncilRevisionRequestedByName,
    step6MetaUpdatedByName,
    step7MetaUpdatedByName,
    step8MetaUpdatedByName,
    submittedByName: u ? u.fullname : null,
    reviewedByName: reviewedBy ? reviewedBy.fullname : null,
    assignedByName: assignedBy ? assignedBy.fullname : null,
    reviewerNames,
    files,
    stepDeadlines,
    step2History,
    stepHistory,
    stepActualStats,
    periodicReport
  });
});

function capVienStep6DecisionAllowedStatus(st) {
  const s = String(st || '').toUpperCase();
  return ['CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(s);
}

function capVienStep6CanEdit(roleRaw) {
  const r = (roleRaw || '').toLowerCase();
  return r === 'admin' || r === 'phong_khcn' || r === 'thu_ky';
}

function capVienStep6HistoryRoleDb(roleRaw) {
  const r = (roleRaw || '').toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'thu_ky') return 'thu_ky';
  return 'phong_khcn';
}

/** Bước 6 — Phòng KHCN / Thư ký HĐKHCN / Admin: lưu Số QĐ, kinh phí, thời gian, phí QL (chỉnh sửa được nhiều lần) */
app.put('/api/cap-vien/submissions/:id/steps/6/decision-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(role)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin Quyết định.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Hồ sơ chưa đến bước Cấp Quyết định (Bước 6).' });
  }
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const soQd = norm(b.soQd !== undefined ? b.soQd : b.step6_so_qd);
  const kinhPhi = norm(b.kinhPhi !== undefined ? b.kinhPhi : b.step6_kinh_phi);
  const thoiGian = norm(b.thoiGian !== undefined ? b.thoiGian : b.step6_thoi_gian);
  const phiQuanLy = norm(b.phiQuanLy !== undefined ? b.phiQuanLy : b.step6_phi_quan_ly);
  const updatedAt = new Date().toISOString();
  const roleDb = capVienStep6HistoryRoleDb(role);
  db.prepare(`UPDATE cap_vien_submissions SET
    step6_so_qd = ?, step6_kinh_phi = ?, step6_thoi_gian = ?, step6_phi_quan_ly = ?,
    step6_meta_updated_at = ?, step6_meta_updated_by = ?
    WHERE id = ?`).run(soQd, kinhPhi, thoiGian, phiQuanLy, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '6', 'step6_meta_update', req.user.id, roleDb, 'Cập nhật thông tin Quyết định (Số QĐ, kinh phí, thời gian, phí QL)');
  return res.json({ message: 'Đã lưu thông tin Quyết định.', updatedAt });
});

function capVienStep7ContractMetaAllowedStatus(statusRaw) {
  const s = (statusRaw || '').toUpperCase();
  return s === 'APPROVED' || s === 'CONTRACTED';
}

/** Bước 7 — Phòng KHCN / Thư ký HĐKHCN / Admin: lưu Số HĐ, Hiệu lực hợp đồng */
app.put('/api/cap-vien/submissions/:id/steps/7/contract-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(role)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin Hợp đồng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep7ContractMetaAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Chỉ cập nhật được khi hồ sơ đang ở Bước 7 (APPROVED) hoặc vừa hoàn thành Bước 7 (CONTRACTED).' });
  }
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const soHd = norm(b.soHd !== undefined ? b.soHd : b.step7_so_hd);
  const hieuLuc = norm(b.hieuLuc !== undefined ? b.hieuLuc : b.step7_hieu_luc);
  const updatedAt = new Date().toISOString();
  const roleDb = capVienStep6HistoryRoleDb(role);
  db.prepare(`UPDATE cap_vien_submissions SET
    step7_so_hd = ?, step7_hieu_luc = ?,
    step7_meta_updated_at = ?, step7_meta_updated_by = ?
    WHERE id = ?`).run(soHd, hieuLuc, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '7', 'step7_contract_meta_update', req.user.id, roleDb, 'Cập nhật thông tin Hợp đồng (Số HĐ, Hiệu lực)');
  return res.json({ message: 'Đã lưu thông tin Hợp đồng.', updatedAt });
});

/** Bước 6 — upload / thay thế file Quyết định VN & EN (có thể chỉ gửi một phía) */
app.post('/api/cap-vien/submissions/:id/steps/6/upload-decision', authMiddleware, (req, res, next) => {
  uploadCapVien.fields([
    { name: 'decision_vn', maxCount: 1 },
    { name: 'decision_en', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(role)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được upload Quyết định.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Hồ sơ chưa đến bước Cấp Quyết định (Bước 6).' });
  }
  const files = req.files || {};
  const fileVn = files.decision_vn && files.decision_vn[0] ? files.decision_vn[0] : null;
  const fileEn = files.decision_en && files.decision_en[0] ? files.decision_en[0] : null;
  if (!fileVn && !fileEn) return res.status(400).json({ message: 'Vui lòng chọn ít nhất một file (Quyết định VN hoặc EN).' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const roleDb = capVienStep6HistoryRoleDb(role);
  const uploadedAt = new Date().toISOString();
  const saved = [];
  function saveSlot(file, fieldName, tag) {
    if (!file || !file.path) return;
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (!allowedExt.includes(ext)) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      throw new Error('File ' + tag + ': chỉ chấp nhận PDF hoặc Word.');
    }
    const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
    db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
    if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);
    const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
    const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
    try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
    saved.push(storedName);
  }
  try {
    saveSlot(fileVn, 'step6_decision_vn', 'VN');
    saveSlot(fileEn, 'step6_decision_en', 'EN');
  } catch (e) {
    return res.status(400).json({ message: e.message || 'Lỗi lưu file' });
  }
  insertCapVienHistory(id, '6', 'step6_decision_upload', req.user.id, roleDb, 'Upload Quyết định: ' + saved.join(', '));
  console.log('[API] cap-vien step 6 upload-decision — submission ' + id);
  return res.json({ message: 'Đã lưu file Quyết định vào hồ sơ.', files: saved });
});

/** Bước 7 — Phòng KHCN / Thư ký HĐKHCN / Admin: upload / thay thế Hợp đồng KHCN */
app.post('/api/cap-vien/submissions/:id/steps/7/upload-contract', authMiddleware, uploadCapVien.single('step7_hop_dong_khcn'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(role)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được upload Hợp đồng KHCN.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '').toUpperCase() !== 'APPROVED') {
    return res.status(400).json({ message: 'Chỉ upload Hợp đồng KHCN khi hồ sơ đang ở Bước 7 (trạng thái APPROVED).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file Hợp đồng KHCN (PDF hoặc Word).' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word.' });
  }
  const fieldName = 'step7_hop_dong_khcn';
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const roleDb = capVienStep6HistoryRoleDb(role);
  const uploadedAt = new Date().toISOString();
  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);
  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
  try {
    fs.renameSync(file.path, newPath);
  } catch (e) {
    try { fs.copyFileSync(file.path, newPath); } catch (_) {}
  }
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
  insertCapVienHistory(id, '7', 'step7_contract_upload', req.user.id, roleDb, 'Upload Hợp đồng KHCN: ' + storedName);
  console.log('[API] cap-vien step 7 upload-contract — submission ' + id);
  return res.json({ message: 'Đã lưu Hợp đồng KHCN vào hồ sơ.', fileName: storedName });
});

function capVienStep8EthicsAllowedRow(sub) {
  if (!sub) return false;
  if ((sub.status || '').toUpperCase() !== 'CONTRACTED') return false;
  if (sub.step8_waived === 1 || sub.step8_waived === true) return false;
  return !(sub.step8_completed === 1 || sub.step8_completed === true);
}

/** Bước 8 — Phòng KHCN / Thư ký / Admin: lưu Mã đạo đức, Hiệu lực, Số/ký hiệu Quyết định */
app.put('/api/cap-vien/submissions/:id/steps/8/ethics-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(role)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin đạo đức.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'Chỉ cập nhật được khi hồ sơ đã ký hợp đồng (CONTRACTED), Bước 8 chưa hoàn thành và chưa bị bất hoạt.' });
  }
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const ma = norm(b.maDaoDuc !== undefined ? b.maDaoDuc : b.step8_ma_dao_duc);
  const hieuLuc = norm(b.hieuLuc !== undefined ? b.hieuLuc : b.step8_hieu_luc);
  const soQd = norm(b.soQuyetDinh !== undefined ? b.soQuyetDinh : b.step8_so_quyet_dinh);
  const updatedAt = new Date().toISOString();
  const roleDb = capVienStep6HistoryRoleDb(role);
  db.prepare(`UPDATE cap_vien_submissions SET
    step8_ma_dao_duc = ?, step8_hieu_luc = ?, step8_so_quyet_dinh = ?,
    step8_meta_updated_at = ?, step8_meta_updated_by = ?
    WHERE id = ?`).run(ma, hieuLuc, soQd, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '8', 'step8_ethics_meta_update', req.user.id, roleDb, 'Cập nhật thông tin đăng ký đạo đức (mã, hiệu lực, QĐ)');
  return res.json({ message: 'Đã lưu thông tin đạo đức.', updatedAt });
});

/** Bước 8 — upload Quyết định đạo đức (1 file) */
app.post('/api/cap-vien/submissions/:id/steps/8/upload-ethics-decision', authMiddleware, uploadCapVien.single('step8_ethics_quyet_dinh'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(role)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được upload Quyết định đạo đức.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'Chỉ upload khi hồ sơ ở CONTRACTED, Bước 8 chưa hoàn thành và chưa bị bất hoạt.' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định đạo đức.' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận PDF hoặc Word.' });
  }
  const fieldName = 'step8_ethics_quyet_dinh';
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const roleDb = capVienStep6HistoryRoleDb(role);
  const uploadedAt = new Date().toISOString();
  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);
  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
  try {
    fs.renameSync(file.path, newPath);
  } catch (e) {
    try { fs.copyFileSync(file.path, newPath); } catch (_) {}
  }
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
  insertCapVienHistory(id, '8', 'step8_ethics_upload', req.user.id, roleDb, 'Upload Quyết định đạo đức: ' + storedName);
  console.log('[API] cap-vien step 8 upload-ethics — submission ' + id);
  return res.json({ message: 'Đã lưu Quyết định đạo đức vào hồ sơ.', fileName: storedName });
});

function capVienPeriodicReportUploadAllowed(sub, user) {
  const st = (sub.status || '').toUpperCase();
  if (!['IMPLEMENTATION', 'COMPLETED'].includes(st)) return false;
  const r = String(user.role || '').toLowerCase();
  if (r === 'admin' || r === 'phong_khcn' || r === 'thu_ky') return true;
  return sub.submittedById === user.id;
}

/** NCV / P.KHCN / Thư ký / Admin: upload báo cáo gắn một kỳ */
app.post(
  '/api/cap-vien/submissions/:id/periodic-report/period/:periodId/upload',
  authMiddleware,
  uploadCapVien.single('periodic_report_file'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const periodId = parseInt(req.params.periodId, 10);
    if (!id || !periodId) return res.status(400).json({ message: 'ID không hợp lệ' });
    const sub = db.prepare('SELECT id, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if (!capVienPeriodicReportUploadAllowed(sub, req.user)) {
      return res.status(403).json({ message: 'Không có quyền upload báo cáo định kỳ cho hồ sơ này.' });
    }
    const per = db.prepare(
      `SELECT id, submissionId, status, primaryFileId FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`
    ).get(periodId, id);
    if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ báo cáo' });
    const stLow = String(per.status || '').toLowerCase();
    if (stLow === 'waived' || stLow === 'bypassed') {
      return res.status(400).json({ message: 'Kỳ này đã bất hoạt / bypass — không upload.' });
    }
    const file = req.file;
    if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file (PDF/Word).' });
    const allowedExt = ['.pdf', '.doc', '.docx'];
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (!allowedExt.includes(ext)) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      return res.status(400).json({ message: 'Chỉ chấp nhận PDF hoặc Word.' });
    }
    const fieldName = 'periodic_report_p' + periodId;
    const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
    const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const roleDb = (req.user.role || '').toLowerCase() === 'admin' ? 'admin' : (req.user.role || '');
    const uploadedAt = new Date().toISOString();
    const oldF = db.prepare('SELECT id, path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
    if (oldF) {
      db.prepare('DELETE FROM cap_vien_submission_files WHERE id = ?').run(oldF.id);
      if (oldF.path) safeUnlinkCapVienStoredFile(oldF.path);
    }
    const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
    const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
    try {
      fs.renameSync(file.path, newPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, newPath); } catch (_) {}
    }
    const insFile = db.prepare(
      'INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    );
    const info = insFile.run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
    const newId = info.lastInsertRowid;
    db.prepare(
      `UPDATE cap_vien_periodic_report_period SET status = 'submitted', submittedAt = ?, primaryFileId = ?, waivedAt = NULL, waivedById = NULL, waiveNote = NULL, bypassedAt = NULL, bypassedById = NULL, bypassNote = NULL WHERE id = ?`
    ).run(uploadedAt, newId, periodId);
    insertCapVienHistory(id, '10', 'periodic_report_upload', req.user.id, roleDb, 'Nộp báo cáo định kỳ: ' + storedName + ' (kỳ #' + periodId + ')');
    return res.json({ message: 'Đã lưu báo cáo cho kỳ được chọn.', fileId: newId, periodId });
  }
);

/** Admin: công cụ báo cáo định kỳ — body { action, payload } */
app.post('/api/cap-vien/submissions/:id/periodic-report/admin', authMiddleware, (req, res) => {
  if (String(req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được dùng công cụ này.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT * FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const body = req.body || {};
  const payload = body.payload || {};
  const action = String(body.action || payload.action || '').toLowerCase().trim();
  const now = new Date().toISOString();

  const histRows = db.prepare(
    `SELECT stepId, actionType, performedAt FROM cap_vien_submission_history WHERE submissionId = ? ORDER BY performedAt ASC`
  ).all(id);
  const stepHistory = {};
  for (const h of histRows) {
    if (!stepHistory[h.stepId]) stepHistory[h.stepId] = [];
    stepHistory[h.stepId].push({ actionType: h.actionType, performedAt: h.performedAt });
  }
  const flat = capVienPeriodicFlatFromStepHistory(stepHistory);

  const log = (type, periodId, pobj, note) => {
    insertCapVienPeriodicAdminLog(id, periodId, type, req.user, pobj, note);
  };

  try {
    if (action === 'set_cycle') {
      const cycleMonths = Math.max(1, Math.min(24, parseInt(payload.cycleMonths, 10) || 6));
      const anchorType = String(payload.anchorType || 'post_step7').trim() || 'post_step7';
      const anchorAt = payload.anchorAt ? String(payload.anchorAt).trim() : null;
      const dueOffsetDays = Math.max(-60, Math.min(120, parseInt(payload.dueOffsetDays, 10) || 0));
      const ex = db.prepare('SELECT submissionId FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (ex) {
        db.prepare(
          `UPDATE cap_vien_periodic_report_config SET cycleMonths = ?, anchorType = ?, anchorAt = ?, dueOffsetDays = ?, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
        ).run(cycleMonths, anchorType, anchorAt || null, dueOffsetDays, now, req.user.id, id);
      } else {
        db.prepare(
          `INSERT INTO cap_vien_periodic_report_config (submissionId, cycleMonths, anchorType, anchorAt, dueRule, dueOffsetDays, timezone, pauseReportClock, updatedAt, updatedById)
           VALUES (?,?,?,?, 'end_of_period', ?, 'Asia/Ho_Chi_Minh', 0, ?, ?)`
        ).run(id, cycleMonths, anchorType, anchorAt || null, dueOffsetDays, now, req.user.id);
      }
      log('set_cycle', null, { cycleMonths, anchorType, anchorAt, dueOffsetDays }, null);
      insertCapVienHistory(id, '10', 'periodic_report_config', req.user.id, 'admin', `Cấu hình BC định kỳ: ${cycleMonths} tháng, neo ${anchorType}`);
      return res.json({ message: 'Đã lưu cấu hình chu kỳ báo cáo.', action: 'set_cycle' });
    }

    if (action === 'preview_schedule') {
      const cfg =
        db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id) || {
          cycleMonths: parseInt(payload.cycleMonths, 10) || 6,
          anchorType: String(payload.anchorType || 'post_step7'),
          anchorAt: payload.anchorAt || null
        };
      const cycleMonths = Math.max(1, Math.min(24, parseInt(payload.cycleMonths || cfg.cycleMonths, 10) || 6));
      const anchorType = String(payload.anchorType || cfg.anchorType || 'post_step7');
      const anchorIso = capVienResolvePeriodicAnchor(id, sub, anchorType, payload.anchorAt || cfg.anchorAt, flat);
      if (!anchorIso) return res.status(400).json({ message: 'Không xác định được mốc neo (thiếu ngày / lịch sử Bước 7).' });
      const periodCount = Math.max(1, Math.min(48, parseInt(payload.periodCount, 10) || Math.min(12, Math.ceil(36 / cycleMonths))));
      const preview = capVienBuildPeriodicSchedule(anchorIso, cycleMonths, periodCount);
      return res.json({ message: 'Preview lịch kỳ (chưa lưu).', preview, anchorIso, action: 'preview_schedule' });
    }

    if (action === 'apply_recalc') {
      const forceWipe = !!payload.forceWipe;
      const cfg = db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (!cfg) return res.status(400).json({ message: 'Chưa có cấu hình. Dùng set_cycle trước.' });
      const locked = db.prepare(
        `SELECT COUNT(1) AS n FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL AND primaryFileId IS NOT NULL`
      ).get(id);
      if ((locked.n || 0) > 0 && !forceWipe) {
        return res.status(400).json({
          message: 'Đã có kỳ đã nộp file. Truyền payload.forceWipe = true để xóa toàn bộ kỳ và tạo lại (nguy hiểm).'
        });
      }
      db.transaction(() => {
        const ids = db.prepare(`SELECT id FROM cap_vien_periodic_report_period WHERE submissionId = ?`).all(id).map((r) => r.id);
        for (const pid of ids) {
          db.prepare('DELETE FROM cap_vien_periodic_report_period_file WHERE periodId = ?').run(pid);
        }
        db.prepare('DELETE FROM cap_vien_periodic_report_period WHERE submissionId = ?').run(id);
        const anchorIso = capVienResolvePeriodicAnchor(id, sub, cfg.anchorType, cfg.anchorAt, flat);
        if (!anchorIso) throw new Error('NO_ANCHOR');
        const periodCount = Math.max(1, Math.min(48, parseInt(payload.periodCount, 10) || Math.min(12, Math.ceil(36 / cfg.cycleMonths))));
        const rows = capVienBuildPeriodicSchedule(anchorIso, cfg.cycleMonths, periodCount);
        const ins = db.prepare(
          `INSERT INTO cap_vien_periodic_report_period (submissionId, seq, label, periodStart, periodEnd, dueAt, status, createdAt) VALUES (?,?,?,?,?,?, 'pending', ?)`
        );
        for (const r of rows) {
          ins.run(id, r.seq, r.label, r.periodStart, r.periodEnd, r.dueAt, now);
        }
      })();
      log('apply_recalc', null, { forceWipe, periodCount: payload.periodCount }, null);
      insertCapVienHistory(id, '10', 'periodic_report_recalc', req.user.id, 'admin', 'Tính lại lịch các kỳ báo cáo định kỳ');
      return res.json({ message: 'Đã tạo lại danh sách kỳ báo cáo.', action: 'apply_recalc' });
    }

    if (action === 'insert_period') {
      const dueAt = String(payload.dueAt || '').trim();
      if (!dueAt) return res.status(400).json({ message: 'Thiếu dueAt (ISO).' });
      const label = String(payload.label || '').trim() || null;
      const maxS = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL`).get(id);
      const seq = (maxS.m || 0) + 1;
      const periodStart = String(payload.periodStart || dueAt).trim();
      db.prepare(
        `INSERT INTO cap_vien_periodic_report_period (submissionId, seq, label, periodStart, periodEnd, dueAt, status, createdAt) VALUES (?,?,?,?, NULL, ?, 'pending', ?)`
      ).run(id, seq, label, periodStart, dueAt, now);
      const row = db.prepare(`SELECT id FROM cap_vien_periodic_report_period WHERE submissionId = ? AND seq = ? AND deletedAt IS NULL`).get(id, seq);
      log('insert_period', row.id, { seq, dueAt, label }, null);
      return res.json({ message: 'Đã chèn kỳ mới.', periodId: row.id, action: 'insert_period' });
    }

    if (action === 'delete_period') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'Thiếu periodId' });
      const per = db
        .prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`)
        .get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      if (per.primaryFileId) return res.status(400).json({ message: 'Kỳ đã có file — không xóa.' });
      const stLow = String(per.status || '').toLowerCase();
      if (stLow === 'submitted') return res.status(400).json({ message: 'Kỳ đã submitted — không xóa.' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET deletedAt = ? WHERE id = ?`).run(now, periodId);
      log('delete_period', periodId, { seq: per.seq }, null);
      return res.json({ message: 'Đã xóa kỳ (soft).', action: 'delete_period' });
    }

    if (action === 'waive_period') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'Cần periodId và note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'waived', waivedAt = ?, waivedById = ?, waiveNote = ?, primaryFileId = NULL, submittedAt = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('waive_period', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_waive', req.user.id, 'admin', 'Bất hoạt kỳ BC: ' + note);
      return res.json({ message: 'Đã bất hoạt kỳ.', action: 'waive_period' });
    }

    if (action === 'bypass_submit') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'Cần periodId và note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'bypassed', bypassedAt = ?, bypassedById = ?, bypassNote = ?, submittedAt = NULL, primaryFileId = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('bypass_submit', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_bypass', req.user.id, 'admin', 'Bypass nộp kỳ BC: ' + note);
      return res.json({ message: 'Đã bypass kỳ (đánh dấu hoàn thành không file).', action: 'bypass_submit' });
    }

    if (action === 'detach_file') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'Thiếu periodId' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(periodId);
      db.prepare(`UPDATE cap_vien_periodic_report_period_file SET detachedAt = ? WHERE periodId = ? AND detachedAt IS NULL`).run(now, periodId);
      log('detach_file', periodId, {}, null);
      return res.json({ message: 'Đã gỡ file khỏi kỳ (kỳ về pending).', action: 'detach_file' });
    }

    if (action === 'move_file') {
      const fromPeriodId = parseInt(payload.fromPeriodId, 10);
      const toPeriodId = parseInt(payload.toPeriodId, 10);
      if (!fromPeriodId || !toPeriodId) return res.status(400).json({ message: 'Cần fromPeriodId và toPeriodId' });
      const fromP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(fromPeriodId, id);
      const toP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(toPeriodId, id);
      if (!fromP || !toP) return res.status(404).json({ message: 'Kỳ không hợp lệ' });
      const fid = fromP.primaryFileId;
      if (!fid) return res.status(400).json({ message: 'Kỳ nguồn không có file' });
      if (toP.primaryFileId) return res.status(400).json({ message: 'Kỳ đích đã có file' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(fromPeriodId);
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET primaryFileId = ?, status = 'submitted', submittedAt = ? WHERE id = ?`
      ).run(fid, now, toPeriodId);
      log('move_file', toPeriodId, { fromPeriodId, toPeriodId, fileId: fid }, null);
      return res.json({ message: 'Đã chuyển file sang kỳ đích.', action: 'move_file' });
    }

    if (action === 'freeze_deadlines') {
      const until = String(payload.pausedUntil || '').trim() || null;
      const reason = String(payload.pauseReason || '').trim() || 'freeze';
      const exF = db.prepare('SELECT submissionId FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (exF) {
        db.prepare(
          `UPDATE cap_vien_periodic_report_config SET pauseReportClock = 1, pausedUntil = ?, pauseReason = ?, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
        ).run(until, reason, now, req.user.id, id);
      } else {
        db.prepare(
          `INSERT INTO cap_vien_periodic_report_config (submissionId, cycleMonths, anchorType, dueRule, dueOffsetDays, timezone, pauseReportClock, pausedUntil, pauseReason, updatedAt, updatedById)
           VALUES (?, 6, 'post_step7', 'end_of_period', 0, 'Asia/Ho_Chi_Minh', 1, ?, ?, ?, ?)`
        ).run(id, until, reason, now, req.user.id);
      }
      log('freeze_deadlines', null, { until, reason }, null);
      return res.json({ message: 'Đã bật đóng băng hạn (cờ hệ thống).', action: 'freeze_deadlines' });
    }

    if (action === 'unfreeze_deadlines') {
      db.prepare(
        `UPDATE cap_vien_periodic_report_config SET pauseReportClock = 0, pausedUntil = NULL, pauseReason = NULL, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
      ).run(now, req.user.id, id);
      log('unfreeze_deadlines', null, {}, null);
      return res.json({ message: 'Đã tắt đóng băng.', action: 'unfreeze_deadlines' });
    }

    if (action === 'resend_reminder') {
      const periodId = payload.periodId ? parseInt(payload.periodId, 10) : null;
      log('resend_reminder', periodId || null, {}, payload.note || null);
      return res.json({ message: 'Đã ghi nhận yêu cầu nhắc (tích hợp email có thể bổ sung sau).', action: 'resend_reminder' });
    }

    return res.status(400).json({ message: 'action không hợp lệ: ' + action });
  } catch (err) {
    if (err && err.message === 'NO_ANCHOR') {
      return res.status(400).json({ message: 'Không xác định được mốc neo lịch.' });
    }
    console.error('[periodic-report admin]', err);
    return res.status(500).json({ message: err.message || 'Lỗi server' });
  }
});

// Admin (dev): đặt/cập nhật deadline cho từng bước
app.put('/api/cap-vien/submissions/:id/steps/:step/deadline', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepId = String(req.params.step || '').trim();
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  if (!stepId) return res.status(400).json({ message: 'Step không hợp lệ' });
  if ((req.user.role || '').toLowerCase() !== 'admin') return res.status(403).json({ message: 'Chỉ Admin mới được đặt deadline' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });

  const body = req.body || {};
  const clear = !!body.clear;
  if (clear) {
    db.prepare('DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').run(id, stepId);
    return res.json({ message: 'Đã xóa deadline cho bước ' + stepId, stepId, cleared: true });
  }

  const existing = db.prepare('SELECT openedAt FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').get(id, stepId);
  const openedAt = existing && existing.openedAt ? existing.openedAt : new Date().toISOString();
  let durationDays = body.durationDays != null ? parseInt(body.durationDays, 10) : null;
  let dueAt = null;
  if (body.dueAt) {
    const d = new Date(body.dueAt);
    if (isNaN(d.getTime())) return res.status(400).json({ message: 'dueAt không hợp lệ' });
    dueAt = d.toISOString();
  } else {
    if (!Number.isFinite(durationDays) || durationDays <= 0) return res.status(400).json({ message: 'durationDays phải > 0' });
    const ms = new Date(openedAt).getTime() + (durationDays * 24 * 60 * 60 * 1000);
    dueAt = new Date(ms).toISOString();
  }
  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    const diff = new Date(dueAt).getTime() - new Date(openedAt).getTime();
    durationDays = Math.max(1, Math.ceil(diff / (24 * 60 * 60 * 1000)));
  }
  const updatedAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO cap_vien_step_deadlines (submissionId, stepId, openedAt, dueAt, durationDays, updatedById, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(submissionId, stepId) DO UPDATE SET
      openedAt = excluded.openedAt,
      dueAt = excluded.dueAt,
      durationDays = excluded.durationDays,
      updatedById = excluded.updatedById,
      updatedAt = excluded.updatedAt
  `).run(id, stepId, openedAt, dueAt, durationDays, req.user.id, updatedAt);
  return res.json({ message: 'Đã cập nhật deadline bước ' + stepId, stepId, openedAt, dueAt, durationDays, updatedAt });
});

// Bước 5 — Thư ký HĐKHCN / Admin: cập nhật thông tin họp Hội đồng KHCN (hiển thị trên timeline)
app.put('/api/cap-vien/submissions/:id/steps/5/hd-meeting', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin họp.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const location = norm(b.location);
  const attendance = norm(b.attendance);
  const documents = norm(b.documents);
  const voteResult = norm(b.voteResult);
  const decision = norm(b.decision);
  const eventTime = norm(b.eventTime);
  const updatedAt = new Date().toISOString();
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_hd_meeting_location = ?,
    step5_hd_meeting_attendance = ?,
    step5_hd_meeting_documents = ?,
    step5_hd_meeting_vote_result = ?,
    step5_hd_meeting_decision = ?,
    step5_hd_meeting_event_time = ?,
    step5_hd_meeting_updated_at = ?,
    step5_hd_meeting_updated_by = ?
    WHERE id = ?`).run(location, attendance, documents, voteResult, decision, eventTime, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'hd_meeting_info_update', req.user.id, role === 'admin' ? 'admin' : 'secretary', 'Cập nhật thông tin họp HĐ KHCN', updatedAt);
  const subMeta = db.prepare('SELECT title, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  const researcherH = subMeta && subMeta.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(subMeta.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: subMeta ? subMeta.title : '',
    submissionId: id,
    subjectLine: '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Cập nhật thông tin họp HĐ KHCN — ' + (subMeta ? subMeta.title : ''),
    bodyHtml: '<p><strong>Thông tin họp Hội đồng KHCN</strong> của đề tài <strong>' + capVienEmailEsc(subMeta ? subMeta.title : '') + '</strong> đã được cập nhật trên hệ thống.</p><p>Kính mời Chủ nhiệm và các thành viên liên quan xem chi tiết tại Bước 5.</p>',
    bodyText: 'Đã cập nhật thông tin họp HĐ KHCN — ' + (subMeta ? subMeta.title : ''),
    councilList: getNotificationEmails(),
    researcherEmail: researcherH ? researcherH.email : null
  });
  return res.json({ message: 'Đã lưu thông tin họp HĐ KHCN.', updatedAt });
});

// Bước 5 — Thư ký HĐKHCN / Admin: upload biên bản họp HĐ KHCN (lưu file + lịch sử)
app.post('/api/cap-vien/submissions/:id/steps/5/upload-minutes', authMiddleware, (req, res, next) => {
  uploadCapVien.single('bien_ban_hop')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được nộp biên bản họp.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'Chỉ nộp biên bản khi hồ sơ đã đến Bước 5 (sau Bước 4 & 4A), hoặc đang ở trạng thái sau họp (CONDITIONAL).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file biên bản họp (PDF, Word).' });

  const step5MinutesField = 'step5_bien_ban_hop_hd';
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, step5MinutesField);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, step5MinutesField);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);

  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, 'step5_bien_ban_' + Date.now() + path.extname(storedName || '.pdf'));
  try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }

  const uploadedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'thu_ky';
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, step5MinutesField, storedName, newPath, req.user.id, roleDb, uploadedAt);

  const note = 'Upload biên bản họp HĐ KHCN: ' + storedName;
  insertCapVienHistory(id, '5', 'step5_bien_ban_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-minutes — submission ' + id);
  const researcherBb = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Đã upload biên bản họp HĐ — ' + sub.title,
    bodyHtml: '<p><strong>Biên bản họp Hội đồng KHCN</strong> (file: ' + capVienEmailEsc(storedName) + ') cho đề tài <strong>' + capVienEmailEsc(sub.title) + '</strong> đã được lưu trên hệ thống.</p>',
    bodyText: 'Đã upload biên bản họp HĐ — ' + sub.title + ' — ' + storedName,
    councilList: getNotificationEmails(),
    researcherEmail: researcherBb ? researcherBb.email : null
  });
  return res.json({ message: 'Đã lưu biên bản họp vào hồ sơ.', fileName: storedName });
});

// Bước 5 — Thư ký / Admin: upload thêm tài liệu kèm (nhận xét UV HĐ, v.v.) — không thay thế biên bản chính
app.post('/api/cap-vien/submissions/:id/steps/5/upload-step5-extras', authMiddleware, (req, res, next) => {
  uploadCapVien.array('step5_extra_files', 30)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được nộp tài liệu kèm.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'Chỉ nộp tài liệu khi hồ sơ đang ở Bước 5 (REVIEWED / IN_MEETING / CONDITIONAL).' });
  }
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ message: 'Vui lòng chọn ít nhất một file.' });

  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const roleDb = role === 'admin' ? 'admin' : 'thu_ky';
  const uploadedAt = new Date().toISOString();
  const ts = Date.now();
  const savedNames = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file || !file.path) continue;
    const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
    const fieldName = 'step5_hd_extra_' + ts + '_' + i;
    const newPath = path.join(baseDir, fieldName + path.extname(storedName || '.pdf'));
    try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
    savedNames.push(storedName);
  }

  if (!savedNames.length) {
    return res.status(400).json({ message: 'Không lưu được file nào.' });
  }
  const note = 'Tài liệu kèm Bước 5: ' + savedNames.join(', ');
  insertCapVienHistory(id, '5', 'step5_extra_file_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-step5-extras — submission ' + id + ', count ' + savedNames.length);
  const researcherEx = sub.submittedById ? db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Tài liệu kèm mới (' + savedNames.length + ') — ' + sub.title,
    bodyHtml: '<p>Đã bổ sung <strong>' + savedNames.length + '</strong> tài liệu kèm tại Bước 5 cho đề tài <strong>' + capVienEmailEsc(sub.title) + '</strong>: ' + capVienEmailEsc(savedNames.join(', ')) + '.</p>',
    bodyText: 'Tài liệu kèm Bước 5 — ' + sub.title + ': ' + savedNames.join(', '),
    councilList: getNotificationEmails(),
    researcherEmail: researcherEx ? researcherEx.email : null
  });
  return res.json({ message: 'Đã lưu ' + savedNames.length + ' tài liệu kèm.', fileNames: savedNames });
});

// Bước 5 — Thư ký / Admin: yêu cầu Chủ nhiệm chỉnh sửa theo góp ý Hội đồng (mở vòng lặp)
app.post('/api/cap-vien/submissions/:id/steps/5/council-request-revision', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới gửi yêu cầu chỉnh sửa này.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ áp dụng khi hồ sơ đang ở Bước 5 (trạng thái REVIEWED hoặc IN_MEETING).' });
  }
  const revSt = (sub.step5_council_revision_status || '').trim();
  if (revSt === 'waiting_researcher') {
    return res.status(400).json({ message: 'Đang chờ Chủ nhiệm nộp hồ sơ chỉnh sửa. Hoàn tất vòng này trước khi gửi yêu cầu mới.' });
  }
  if (revSt === 'waiting_chair') {
    return res.status(400).json({ message: 'Đang chờ Chủ tịch HĐKHCN xem xét bản chỉnh sửa.' });
  }
  const body = req.body || {};
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung góp ý / yêu cầu chỉnh sửa.' });
  const nextRound = (sub.step5_council_revision_round || 0) + 1;
  const requestedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'secretary';
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_council_revision_round = ?,
    step5_council_revision_status = 'waiting_researcher',
    step5_council_revision_note = ?,
    step5_council_revision_requested_at = ?,
    step5_council_revision_requested_by = ?
    WHERE id = ?`).run(nextRound, note, requestedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'step5_council_request_revision', req.user.id, roleDb, '[Vòng ' + nextRound + '] ' + note, requestedAt);
  console.log('[API] cap-vien step 5 council-request-revision — submission ' + id + ', round ' + nextRound);
  const researcherR = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryRevisionRequestEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round: nextRound,
    note,
    requestedByName: req.user.fullname || req.user.email,
    researcherEmail: researcherR ? researcherR.email : null,
    councilList: getNotificationEmails()
  });
  return res.json({ message: 'Đã gửi yêu cầu chỉnh sửa tới Chủ nhiệm (vòng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// Bước 5 — Chủ nhiệm / Admin: nộp hồ sơ chỉnh sửa theo góp ý Hội đồng
app.post('/api/cap-vien/submissions/:id/steps/5/council-revision-upload', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_researcher') {
    return res.status(400).json({ message: 'Chỉ được nộp khi Hội đồng đã gửi yêu cầu chỉnh sửa (đang chờ Chủ nhiệm).' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được nộp hồ sơ chỉnh sửa.' });
  }
  const fList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!fList.length) {
    return res.status(400).json({ message: 'Vui lòng chọn ít nhất một file.' });
  }
  const round = sub.step5_council_revision_round || 1;
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const ts = Date.now();
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'Chủ nhiệm đề tài' : 'Admin';
  const uploadedAt = new Date().toISOString();
  const prevRows = db.prepare("SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound = ? AND fieldName LIKE 'step5_council_revision_f_%'").all(id, round);
  db.transaction(() => {
    prevRows.forEach((r) => {
      if (r.path) safeUnlinkCapVienStoredFile(r.path);
    });
    db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound = ? AND fieldName LIKE 'step5_council_revision_f_%'").run(id, round);
    let idx = 0;
    for (const file of fList) {
      const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
      const safeBase = (storedName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newPath = path.join(baseDir, 'step5_council_rev_' + round + '_' + ts + '_' + idx + '_' + safeBase);
      try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
      const fieldName = 'step5_council_revision_f_' + round + '_' + ts + '_' + idx;
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, fieldName, storedName, newPath, round, req.user.id, uploaderRole, uploadedAt);
      idx++;
    }
    db.prepare("UPDATE cap_vien_submissions SET step5_council_revision_status = 'waiting_chair' WHERE id = ?").run(id);
  })();
  insertCapVienHistory(id, '5', 'step5_council_revision_upload', req.user.id, uploaderRole, uploaderRoleLabel + ' nộp ' + fList.length + ' file (vòng ' + round + ')', uploadedAt);
  console.log('[API] cap-vien step 5 council-revision-upload — submission ' + id + ', round ' + round);
  const researcherUp = sub.submittedById ? db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5RevisionUploadedEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round,
    fileCount: fList.length,
    uploaderName: req.user.fullname || req.user.email || uploaderRoleLabel,
    councilList: getNotificationEmails(),
    researcherEmail: researcherUp ? researcherUp.email : null
  });
  return res.json({ message: 'Đã lưu hồ sơ chỉnh sửa. Chủ tịch HĐKHCN sẽ thông qua hoặc yêu cầu chỉnh sửa tiếp.', status: 'waiting_chair', round });
});

// Bước 5 — Chủ tịch HĐKHCN / Thư ký / Admin: thông qua bản chỉnh sửa hoặc yêu cầu chỉnh sửa tiếp
app.post('/api/cap-vien/submissions/:id/steps/5/council-revision-chair', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!['admin', 'chu_tich', 'thu_ky'].includes(role)) {
    return res.status(403).json({ message: 'Chỉ Chủ tịch HĐKHCN, Thư ký hoặc Admin mới thực hiện bước này.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_chair') {
    return res.status(400).json({ message: 'Không có bản chỉnh sửa đang chờ Chủ tịch xem xét.' });
  }
  const body = req.body || {};
  const action = String(body.action || '').toLowerCase().trim();
  if (!['approve', 'request_more'].includes(action)) {
    return res.status(400).json({ message: 'action phải là approve hoặc request_more' });
  }
  const performedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : (role === 'thu_ky' ? 'secretary' : 'chu_tich');
  const chairOrActorName = req.user.fullname || req.user.email;
  const researcherCh = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  const councilListCh = getNotificationEmails();
  if (action === 'approve') {
    const roundAp = sub.step5_council_revision_round || 1;
    db.prepare(`UPDATE cap_vien_submissions SET
      step5_council_revision_status = NULL,
      step5_council_revision_note = NULL,
      step5_council_revision_requested_at = NULL,
      step5_council_revision_requested_by = NULL
      WHERE id = ?`).run(id);
    insertCapVienHistory(id, '5', 'step5_chair_approve_revision', req.user.id, roleDb, 'Chấp nhận hồ sơ chỉnh sửa (vòng ' + roundAp + ')', performedAt);
    console.log('[API] cap-vien step 5 council-revision-chair approve — submission ' + id);
    sendCapVienStep5ChairApprovedRevisionEmail({
      submissionTitle: sub.title,
      submissionId: id,
      round: roundAp,
      chairName: chairOrActorName,
      researcherEmail: researcherCh ? researcherCh.email : null,
      researcherName: researcherCh ? researcherCh.fullname : null,
      councilList: councilListCh
    });
    return res.json({ message: 'Đã thông qua bản chỉnh sửa. Có thể tiếp tục quy trình Bước 5 (ghi nhận thông qua Hội đồng hoặc yêu cầu vòng mới).', status: null });
  }
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lòng nhập góp ý khi yêu cầu chỉnh sửa tiếp.' });
  const nextRound = (sub.step5_council_revision_round || 1) + 1;
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_council_revision_round = ?,
    step5_council_revision_status = 'waiting_researcher',
    step5_council_revision_note = ?,
    step5_council_revision_requested_at = ?,
    step5_council_revision_requested_by = ?
    WHERE id = ?`).run(nextRound, note, performedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'step5_chair_request_more_revision', req.user.id, roleDb, '[Vòng ' + nextRound + '] ' + note, performedAt);
  console.log('[API] cap-vien step 5 council-revision-chair request_more — submission ' + id + ', round ' + nextRound);
  sendCapVienStep5ChairRequestMoreEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round: nextRound,
    note,
    chairName: chairOrActorName,
    researcherEmail: researcherCh ? researcherCh.email : null,
    councilList: councilListCh
  });
  return res.json({ message: 'Đã yêu cầu Chủ nhiệm chỉnh sửa tiếp (vòng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// Bước 5 — Thư ký / Admin: ghi nhận Hội đồng KHCN thông qua → chuyển trạng thái sang Bước 6 (CONDITIONAL)
app.post('/api/cap-vien/submissions/:id/steps/5/council-pass', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'thu_ky') {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới ghi nhận thông qua Hội đồng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, step5_council_revision_status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ ghi nhận thông qua khi hồ sơ đang ở Bước 5 (REVIEWED / IN_MEETING).' });
  }
  if (sub.step5_council_revision_status) {
    return res.status(400).json({ message: 'Đang có vòng chỉnh sửa theo góp ý Hội đồng chưa đóng. Chờ Chủ tịch thông qua bản chỉnh sửa hoặc hoàn tất vòng này.' });
  }
  const performedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'secretary';
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
  insertCapVienHistory(id, '5', 'step5_council_pass_hd', req.user.id, roleDb, 'Ghi nhận Hội đồng KHCN thông qua — chuyển sang Bước 6', performedAt);
  console.log('[API] cap-vien step 5 council-pass — submission ' + id);
  const researcherPass = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5CouncilPassedEmail({
    submissionTitle: sub.title,
    submissionId: id,
    researcherEmail: researcherPass ? researcherPass.email : null,
    researcherName: researcherPass ? researcherPass.fullname : null,
    councilList: getNotificationEmails(),
    recordedByName: req.user.fullname || req.user.email
  });
  return res.json({ message: 'Đã ghi nhận Hội đồng KHCN thông qua. Hồ sơ chuyển sang Bước 6 (Cấp Quyết định phê duyệt).', status: 'CONDITIONAL' });
});

// Danh sách thành viên Hội đồng KHCN (Chủ tịch, Thư ký, Thành viên) — để Chủ tịch phân công phản biện
app.get('/api/cap-vien/council', authMiddleware, (req, res) => {
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien'].includes(role);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc Admin mới xem được danh sách' });
  const rows = db.prepare(
    "SELECT id, email, fullname, role FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin') ORDER BY role, fullname, email"
  ).all();
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname || r.email || '',
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Admin' : (r.role === 'chu_tich' ? 'Chủ tịch HĐKHCN' : r.role === 'thu_ky' ? 'Thư ký HĐKHCN' : 'Thành viên HĐKHCN')
  }));
  return res.json({ council });
});

// Bước quy trình Đề tài cấp Viện: Thư ký HĐKHCN — Bước 2 (Kiểm tra hồ sơ): Đánh dấu Hợp lệ / Yêu cầu bổ sung
app.post('/api/cap-vien/submissions/:id/steps/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = req.params.step;
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isSecretaryOrAdmin = role === 'admin' || role === 'thu_ky';
  if (step === '2') {
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const currentStatus = sub.status || 'SUBMITTED';
    const roleLower = (role || '').toLowerCase();

    // Chỉ Admin mới được đưa hồ sơ về Bước 2 để kiểm tra lại
    if (action === 'revert') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về Bước 2 (kiểm tra lại)' });
      }
      if (currentStatus === 'SUBMITTED') {
        return res.status(400).json({ message: 'Hồ sơ đang ở Bước 2, không cần đưa về' });
      }
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
        .run('SUBMITTED', id);
      insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2 để kiểm tra lại');
      console.log('[API] cap-vien step 2 revert — submission ' + id);
      return res.json({ message: 'Đã đưa hồ sơ về Bước 2. Thư ký có thể nhấn Hợp lệ hoặc Yêu cầu bổ sung lại.', status: 'SUBMITTED' });
    }

    if (!isSecretaryOrAdmin) {
      return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được thực hiện Bước 2 (Kiểm tra hồ sơ)' });
    }
    if (currentStatus !== 'SUBMITTED') {
      return res.status(400).json({ message: 'Hồ sơ này đã được xử lý tại Bước 2. Chỉ Admin mới có thể đưa về để kiểm tra lại.' });
    }
    if (action === 'approve') {
      const reviewedAt = new Date().toISOString();
      const note = (payload.note || '').trim();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('VALIDATED', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_approve', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note || 'Hợp lệ');
      const row = db.prepare('SELECT submittedBy, submittedById, createdAt FROM cap_vien_submissions WHERE id = ?').get(id);
      const u = row && row.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById) : null;
      const hasSupplement = (db.prepare('SELECT 1 FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound > 0 LIMIT 1').get(id) || null) != null;
      sendCapVienStep2ValidatedEmail({
        submissionTitle: sub.title,
        submittedByEmail: (row && row.submittedBy) || sub.submittedBy,
        submittedByName: u ? u.fullname : null,
        createdAt: row ? row.createdAt : null,
        status: 'VALIDATED',
        reviewedByName: req.user.fullname || req.user.email,
        hasSupplement
      });
      console.log('[API] cap-vien step 2 approve — submission ' + id);
      return res.json({ message: 'Đã Hợp lệ. Hồ sơ chuyển sang Bước 3.', status: 'VALIDATED' });
    }
    if (action === 'request_revision') {
      const note = (payload.note || '').trim();
      if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung yêu cầu bổ sung' });
      const reviewedAt = new Date().toISOString();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('NEED_REVISION', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_request_revision', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note);
      const secretaryName = (req.user.fullname || req.user.email || 'Thư ký').toString();
      const rowSub = db.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
      const researcherName = rowSub && rowSub.submittedById ? (db.prepare('SELECT fullname FROM users WHERE id = ?').get(rowSub.submittedById) || {}).fullname : null;
      sendCapVienStep2RevisionEmail(sub.title, sub.submittedBy || null, note, secretaryName, id, researcherName);
      console.log('[API] cap-vien step 2 request_revision — submission ' + id);
      return res.json({ message: 'Đã ghi nhận yêu cầu bổ sung. Nội dung đã gửi nghiên cứu viên và thông báo cho Hội đồng.', status: 'NEED_REVISION' });
    }
    return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: approve, request_revision hoặc revert (chỉ Admin)' });
  }
  if (step === '3') {
    const isChairmanOrAdmin = role === 'admin' || role === 'chu_tich';
    if (!isChairmanOrAdmin) {
      return res.status(403).json({ message: 'Chỉ Chủ tịch HĐKHCN hoặc Admin mới được phân công phản biện' });
    }
    if ((sub.status || '') !== 'VALIDATED') {
      return res.status(400).json({ message: 'Chỉ có thể phân công phản biện khi hồ sơ đã Hợp lệ (Bước 2 xong)' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'assign') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: assign' });
    }
    let reviewerIds = (payload.reviewerIds || body.reviewerIds || []).map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
    if (payload.reviewer1 && payload.reviewer2) {
      reviewerIds = [parseInt(payload.reviewer1, 10), parseInt(payload.reviewer2, 10)].filter(rid => rid > 0);
    }
    reviewerIds = [...new Set(reviewerIds)];
    if (reviewerIds.length < 2) {
      return res.status(400).json({ message: 'Vui lòng chọn đủ 2 phản biện từ danh sách thành viên Hội đồng' });
    }
    const councilIds = db.prepare("SELECT id FROM users WHERE role IN ('chu_tich','thu_ky','thanh_vien','admin')").all().map(r => r.id);
    const invalid = reviewerIds.filter(rid => !councilIds.includes(rid));
    if (invalid.length > 0) {
      return res.status(400).json({ message: 'Tất cả phản biện phải là thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên HĐKHCN)' });
    }
    const assignedAt = new Date().toISOString();
    db.prepare('UPDATE cap_vien_submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ? WHERE id = ?')
      .run('ASSIGNED', JSON.stringify(reviewerIds), assignedAt, req.user.id, id);
    const reviewerNamesArr = db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '');
    insertCapVienHistory(id, '3', 'chairman_assign', req.user.id, role === 'admin' ? 'admin' : 'chairman', 'Phân công 2 phản biện: ' + reviewerNamesArr.join(', '));
    const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
    const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
    const reviewerEmails = reviewers.map(r => r.email);
    const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
    sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
    sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
    console.log('[API] cap-vien step 3 assign — submission ' + id + ', reviewers: ' + reviewerIds.join(','));
    return res.json({ message: 'Đã phân công phản biện. Email đã gửi đến các phản biện, Hội đồng và Tổ thẩm định tài chính.', status: 'ASSIGNED' });
  }
  if (step === '6') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(roleLower)) {
      return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới ghi nhận hoàn thành Bước 6 (Quyết định).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const sub6 = db.prepare('SELECT id, status, step6_so_qd FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub6) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if (action !== 'approve') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: approve' });
    }
    if ((sub6.status || '').toUpperCase() !== 'CONDITIONAL') {
      return res.status(400).json({ message: 'Chỉ chuyển Bước 7 khi hồ sơ đang ở Bước 6 (trạng thái sau Bước 5 — CONDITIONAL).' });
    }
    if (!String(sub6.step6_so_qd || '').trim()) {
      return res.status(400).json({ message: 'Vui lòng nhập và lưu Số Quyết định (mục Bước 6) trước khi hoàn tất.' });
    }
    const hasVn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_vn' LIMIT 1").get(id);
    const hasEn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_en' LIMIT 1").get(id);
    if (!hasVn || !hasEn) {
      return res.status(400).json({ message: 'Cần upload đủ file Quyết định tiếng Việt và tiếng Anh trước khi hoàn tất Bước 6.' });
    }
    const rowMail = db.prepare(`SELECT s.title, s.submittedBy, s.submittedById, s.step6_so_qd,
      u.email AS ownerEmail, u.fullname AS ownerName
      FROM cap_vien_submissions s
      LEFT JOIN users u ON u.id = s.submittedById
      WHERE s.id = ?`).get(id);
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('APPROVED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '6', 'step6_complete', req.user.id, roleDb, 'Ghi nhận hoàn thành Cấp Quyết định — chuyển Bước 7');
    console.log('[API] cap-vien step 6 approve — submission ' + id);
    const researcherEmail = ((rowMail && rowMail.ownerEmail) || (rowMail && rowMail.submittedBy) || '').trim();
    sendCapVienStep6CompletedEmail({
      submissionTitle: rowMail ? rowMail.title : '',
      submissionId: id,
      researcherEmail,
      researcherName: rowMail ? rowMail.ownerName : null,
      soQd: rowMail ? rowMail.step6_so_qd : sub6.step6_so_qd,
      councilList: getNotificationEmails()
    }).catch((err) => console.error('[Email] Bước 6 hoàn thành:', err && err.message));
    return res.json({ message: 'Đã ghi nhận hoàn thành Bước 6. Hồ sơ chuyển sang Bước 7 (Ký hợp đồng). Đã gửi thông báo hành chính tới Chủ nhiệm (CC Hội đồng KHCN).', status: 'APPROVED' });
  }
  if (step === '7') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(roleLower)) {
      return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới ghi nhận hoàn thành Bước 7 (Hợp đồng KHCN).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'complete' && action !== 'confirm_signed') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: complete' });
    }
    const sub7 = db.prepare('SELECT id, status, title, submittedBy, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub7) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if ((sub7.status || '').toUpperCase() !== 'APPROVED') {
      return res.status(400).json({ message: 'Chỉ hoàn thành Bước 7 khi hồ sơ đang ở trạng thái APPROVED (sau Bước 6).' });
    }
    const hasContract = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step7_hop_dong_khcn' LIMIT 1").get(id);
    if (!hasContract) {
      return res.status(400).json({ message: 'Cần upload Hợp đồng KHCN vào hồ sơ trước khi nhấn Hoàn thành.' });
    }
    const sendMail = getCapVienStep7EmailOnComplete();
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONTRACTED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '7', 'step7_complete', req.user.id, roleDb, 'Ghi nhận hoàn thành Bước 7 — Hợp đồng KHCN; chuyển bước tiếp theo');
    console.log('[API] cap-vien step 7 complete — submission ' + id + ', email=' + sendMail);
    const rowMail = db.prepare(`SELECT s.title, s.submittedBy, s.submittedById, u.email AS ownerEmail, u.fullname AS ownerName
      FROM cap_vien_submissions s
      LEFT JOIN users u ON u.id = s.submittedById
      WHERE s.id = ?`).get(id);
    const researcherEmail = ((rowMail && rowMail.ownerEmail) || (rowMail && rowMail.submittedBy) || '').trim();
    if (sendMail) {
      sendCapVienStep7CompletedEmail({
        submissionTitle: rowMail ? rowMail.title : '',
        submissionId: id,
        researcherEmail,
        researcherName: rowMail ? rowMail.ownerName : null,
        councilList: getNotificationEmails()
      }).catch((err) => console.error('[Email] Bước 7 hoàn thành:', err && err.message));
    }
    const msg = sendMail
      ? 'Đã ghi nhận hoàn thành Bước 7. Hồ sơ chuyển sang bước tiếp theo (đăng ký đạo đức / tạm ứng…). Đã gửi email thông báo hành chính tới Chủ nhiệm (CC Hội đồng KHCN nhận thông báo).'
      : 'Đã ghi nhận hoàn thành Bước 7. Hồ sơ chuyển sang bước tiếp theo. (Admin đã tắt gửi email tự động.)';
    return res.json({ message: msg, status: 'CONTRACTED', emailSent: !!sendMail });
  }
  if (step === '8') {
    const roleLower = (role || '').toLowerCase();
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const sub8 = db.prepare(`SELECT id, status, step8_ma_dao_duc,
      COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived
      FROM cap_vien_submissions WHERE id = ?`).get(id);
    if (!sub8) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if ((sub8.status || '').toUpperCase() !== 'CONTRACTED') {
      return res.status(400).json({ message: 'Chỉ thao tác Bước 8 khi hồ sơ đã ký hợp đồng (CONTRACTED).' });
    }
    if (action === 'admin_bypass') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin mới được bypass Bước 8 (đánh dấu hoàn thành thủ công).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'Bước 8 đã hoàn thành.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1, step8_waived = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_bypass', req.user.id, 'admin', 'Admin bypass Bước 8 — hoàn thành không qua đủ điều kiện thông thường');
      console.log('[API] cap-vien step 8 admin_bypass — submission ' + id);
      return res.json({ message: 'Đã bypass Bước 8 (đánh dấu hoàn thành).', status: 'CONTRACTED' });
    }
    if (action === 'admin_waive') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin mới được bất hoạt Bước 8 (không áp dụng cho đề tài này).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'Đã hoàn thành Bước 8; không thể bất hoạt. Có thể đưa hồ sơ về Bước 7 (Admin) nếu cần làm lại.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_waived = 1, step8_completed = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_waive', req.user.id, 'admin', 'Admin bất hoạt Bước 8 — đăng ký đạo đức không áp dụng cho đề tài này');
      console.log('[API] cap-vien step 8 admin_waive — submission ' + id);
      return res.json({ message: 'Đã đánh dấu Bước 8 không áp dụng cho đề tài này.', status: 'CONTRACTED' });
    }
    if (action !== 'complete') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng: complete, admin_bypass, admin_waive (Admin).' });
    }
    if (!capVienStep6CanEdit(roleLower)) {
      return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới ghi nhận hoàn thành Bước 8 (Đạo đức).' });
    }
    if (sub8.step8_waived === 1 || sub8.step8_waived === true) {
      return res.status(400).json({ message: 'Bước 8 đã được đánh dấu không áp dụng (bất hoạt).' });
    }
    if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
      return res.status(400).json({ message: 'Bước 8 đã được đánh dấu hoàn thành trước đó.' });
    }
    if (!String(sub8.step8_ma_dao_duc || '').trim()) {
      return res.status(400).json({ message: 'Vui lòng nhập và lưu Mã đạo đức trước khi hoàn tất Bước 8.' });
    }
    const hasEthicsFile = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step8_ethics_quyet_dinh' LIMIT 1").get(id);
    if (!hasEthicsFile) {
      return res.status(400).json({ message: 'Cần upload Quyết định đạo đức trước khi hoàn tất Bước 8.' });
    }
    db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1 WHERE id = ?').run(id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '8', 'step8_complete', req.user.id, roleDb, 'Hoàn thành Bước 8 — Đăng ký/Cấp mã đạo đức');
    console.log('[API] cap-vien step 8 complete — submission ' + id);
    return res.json({
      message: 'Đã ghi nhận hoàn thành Bước 8. Có thể tiếp tục các bước tiếp theo theo quy trình (Bước 9 trở đi).',
      status: 'CONTRACTED'
    });
  }
  if (step === '8a') {
    return res.status(410).json({ message: 'Bước 8A đã được gỡ khỏi quy trình; không còn thao tác tại endpoint này.' });
  }
  return res.status(404).json({ message: 'Bước ' + step + ' chưa được triển khai tại backend' });
});

// Bước 4: Phản biện upload phiếu đánh giá (slot 1 hoặc 2) - upload KHONG tu dong "hoan thanh"
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-upload', authMiddleware, uploadCapVien.single('phieu_danh_gia'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.body.slot || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được upload phiếu đánh giá' });
  const file = req.file || req.files?.phieu_danh_gia?.[0];
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file phiếu đánh giá (PDF hoặc Word)' });

  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, 'reviewer_phieu_' + slot);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);

  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, 'reviewer_' + slot + '_' + Date.now() + path.extname(storedName || '.pdf'));
  try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)')
    .run(id, 'reviewer_phieu_' + slot, storedName, newPath);

  // Upload moi/ghi de thi phai nhan "Hoan thanh" lai
  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('ASSIGNED', 'UNDER_REVIEW', id);

  insertCapVienHistory(id, '4', 'reviewer_upload', req.user.id, 'reviewer', 'Phản biện ' + slot + ' upload phiếu đánh giá');
  console.log('[API] cap-vien step 4 reviewer-upload slot ' + slot + ' — submission ' + id);
  return res.json({ message: 'Đã upload phiếu đánh giá. Vui lòng nhấn "Hoàn thành phản biện ' + slot + '" sau khi kiểm tra.', slot });
});

// Bước 4: Phản biện xác nhận hoàn thành slot
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-complete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được xác nhận hoàn thành' });

  const hasFile = db.prepare('SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!hasFile) return res.status(400).json({ message: 'Phản biện ' + slot + ' chưa upload file. Vui lòng upload trước khi nhấn hoàn thành.' });

  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 1 WHERE id = ?').run(id);
  insertCapVienHistory(id, '4', 'reviewer_complete', req.user.id, 'reviewer', 'Phản biện ' + slot + ' xác nhận hoàn thành');

  const doneRow = db.prepare('SELECT step_4_reviewer1_done, step_4_reviewer2_done, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  const bothDone = !!(doneRow && doneRow.step_4_reviewer1_done && doneRow.step_4_reviewer2_done);
  const budgetApproved = !!(doneRow && doneRow.budget_4a_status === 'approved');
  if (bothDone && budgetApproved) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    sendCapVienStep5ReadyEmail({ submissionTitle: sub.title, submissionId: id });
  } else {
    db.prepare('UPDATE cap_vien_submissions SET status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
      .run('ASSIGNED', 'UNDER_REVIEW', id);
  }

  return res.json({
    message: bothDone ? 'Đã ghi nhận: cả 2 phản biện đã hoàn thành.' : ('Đã ghi nhận: phản biện ' + slot + ' hoàn thành.'),
    slot,
    bothDone,
    step5Ready: bothDone && budgetApproved
  });
});

// Bước 4: Xóa file phản biện để upload lại
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-delete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được xóa file phản biện' });

  const row = db.prepare('SELECT id, path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!row) return res.status(400).json({ message: 'Chưa có file phản biện ' + slot + ' để xóa' });
  db.prepare('DELETE FROM cap_vien_submission_files WHERE id = ?').run(row.id);
  if (row.path) safeUnlinkCapVienStoredFile(row.path);
  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('REVIEWED', 'UNDER_REVIEW', id);
  insertCapVienHistory(id, '4', 'reviewer_delete', req.user.id, 'reviewer', 'Xóa file phản biện ' + slot + ' để upload lại');
  return res.json({ message: 'Đã xóa file phản biện ' + slot + '. Bạn có thể upload lại và nhấn hoàn thành.', slot });
});

// Bước 4A: Nộp phiếu thẩm định dự toán — upload 2 file (budget_phieu_tham_dinh, budget_to_trinh)
app.post('/api/cap-vien/submissions/:id/steps/4a/upload', authMiddleware, uploadCapVien.fields([
  { name: 'budget_phieu_tham_dinh', maxCount: 1 },
  { name: 'budget_to_trinh', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = role === 'admin' || ['chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(role);
  if (!isCouncilOrAdmin) {
    return res.status(403).json({ message: 'Chỉ thành viên Hội đồng, Tổ thẩm định tài chính hoặc Admin mới được nộp phiếu thẩm định dự toán' });
  }
  const files = req.files || {};
  const f1 = files.budget_phieu_tham_dinh && files.budget_phieu_tham_dinh[0];
  const f2 = files.budget_to_trinh && files.budget_to_trinh[0];
  if (!f1 || !f2) {
    return res.status(400).json({ message: 'Vui lòng tải lên đủ 2 file: Phiếu thẩm định (SCI-BUDGET-01) và Tờ trình (SCI-BUDGET-02)' });
  }
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const BUDGET_FIELDS = [
    { field: 'budget_phieu_tham_dinh', file: f1 },
    { field: 'budget_to_trinh', file: f2 }
  ];
  db.transaction(() => {
    for (const { field, file } of BUDGET_FIELDS) {
      const ext = path.extname(file.originalname) || '.pdf';
      const storedName = 'budget_' + field + '_' + Date.now() + ext;
      const newPath = path.join(baseDir, storedName);
      fs.renameSync(file.path, newPath);
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, field, file.originalname, newPath, sub.budget_4a_round || 1, req.user.id, role, new Date().toISOString());
    }
  })();
  const roleLabel = role === 'totruong_tham_dinh_tc' ? 'totruong_tham_dinh' : (role === 'thanh_vien_tham_dinh_tc' ? 'thanh_vien_tham_dinh' : role);
  insertCapVienHistory(id, '4a', 'budget_upload', req.user.id, roleLabel, 'Nộp phiếu thẩm định dự toán (vòng ' + (sub.budget_4a_round || 1) + '): SCI-BUDGET-01, SCI-BUDGET-02');
  console.log('[API] cap-vien step 4a upload — submission ' + id);
  return res.json({ message: 'Đã nộp phiếu thẩm định dự toán. Thành viên Hội đồng có thể tải file ngay.', files: ['budget_phieu_tham_dinh', 'budget_to_trinh'] });
});

// Bước 4A: Tổ thẩm định yêu cầu bổ sung/chỉnh sửa dự toán — comment + file upload
app.post('/api/cap-vien/submissions/:id/steps/4a/request-revision', authMiddleware, uploadCapVien.fields([
  { name: 'revision_files', maxCount: 10 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isBudgetTeam = role === 'admin' || ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(role);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chỉ Tổ thẩm định tài chính hoặc Admin mới được yêu cầu bổ sung dự toán' });
  const note = (req.body.note || req.body.comment || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung yêu cầu bổ sung/chỉnh sửa' });
  const files = req.files || {};
  const fList = files.revision_files || [];
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const ts = Date.now();
  const currentRound = sub.budget_4a_round || 1;
  let targetRound = currentRound;
  if ((sub.budget_4a_status || '') !== 'need_revision') {
    const hasRequestInCurrentRound = !!db.prepare("SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4a' AND actionType = 'budget_request_revision' AND note LIKE ? LIMIT 1")
      .get(id, '[Vòng ' + currentRound + ']%');
    if (hasRequestInCurrentRound) targetRound = currentRound + 1;
  }
  let idx = 0;
  for (const f of fList) {
    if (!f || !f.path) continue;
    const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    const newPath = path.join(baseDir, 'budget_revision_req_' + ts + '_' + idx + '_' + (storedName || '').replace(/[^a-zA-Z0-9._-]/g, '_'));
    try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'budget_revision_request_' + ts + '_' + idx, storedName, newPath, targetRound, req.user.id, role, new Date().toISOString());
    idx++;
  }
  const requestedAt = new Date().toISOString();
  const nextRound = targetRound;
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_round = ?, budget_4a_revision_note = ?, budget_4a_revision_requested_at = ?, budget_4a_revision_requested_by = ? WHERE id = ?')
    .run('need_revision', nextRound, note, requestedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_request_revision', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', '[Vòng ' + nextRound + '] ' + note);
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisionRequestEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, note, requestedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a request-revision — submission ' + id);
  return res.json({ message: 'Đã gửi yêu cầu bổ sung. Email đã gửi đến Chủ nhiệm và CC Hội đồng.', status: 'need_revision' });
});

// Bước 4A: Nghiên cứu viên (Chủ nhiệm) nộp lại tài liệu bổ sung/chỉnh sửa theo yêu cầu
app.post('/api/cap-vien/submissions/:id/steps/4a/upload-revised', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.budget_4a_status || '') !== 'need_revision') {
    return res.status(400).json({ message: 'Chỉ được nộp tài liệu chỉnh sửa khi Tổ thẩm định đã yêu cầu bổ sung (Bước 4A)' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được nộp tài liệu chỉnh sửa' });
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'Chủ nhiệm đề tài' : 'Admin';
  const revisedList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!revisedList.length) {
    return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 file tài liệu bổ sung/chỉnh sửa.' });
  }
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const round = sub.budget_4a_round || 1;
  const ts = Date.now();
  db.transaction(() => {
    let idx = 0;
    for (const file of revisedList) {
      const ext = path.extname(file.originalname) || '.pdf';
      const field = 'budget_revised_attachment_' + round + '_' + ts + '_' + idx;
      const storedName = 'budget_revised_attachment_' + round + '_' + ts + '_' + idx + ext;
      const newPath = path.join(baseDir, storedName);
      fs.renameSync(file.path, newPath);
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, field, file.originalname, newPath, round, req.user.id, uploaderRole, new Date().toISOString());
      idx++;
    }
  })();
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL WHERE id = ?')
    .run(null, id);
  insertCapVienHistory(id, '4a', 'researcher_upload_revised', req.user.id, uploaderRole, uploaderRoleLabel + ' nộp ' + revisedList.length + ' file tài liệu bổ sung/chỉnh sửa (vòng ' + round + ')');
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisedSubmittedEmail({ submissionTitle: sub.title, researcherName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a upload-revised — submission ' + id);
  return res.json({ message: 'Đã nộp tài liệu bổ sung/chỉnh sửa. Tổ thẩm định sẽ kiểm tra và phê duyệt hoặc yêu cầu bổ sung tiếp.' });
});

// Bước 4A: Tổ thẩm định phê duyệt dự toán
app.post('/api/cap-vien/submissions/:id/steps/4a/approve', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isBudgetTeam = role === 'admin' || ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(role);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chỉ Tổ thẩm định tài chính hoặc Admin mới được phê duyệt dự toán' });
  const roundNow = sub.budget_4a_round || 1;
  const cntBudget = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh')").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const cntRevised = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName LIKE 'budget_revised_attachment_%'").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const hasBudgetPair = !!cntBudget && Number(cntBudget.c || 0) >= 2;
  const hasRevisedAttachments = !!cntRevised && Number(cntRevised.c || 0) > 0;
  if (!hasBudgetPair && !hasRevisedAttachments) {
    return res.status(400).json({ message: 'Chưa có tài liệu để phê duyệt ở vòng hiện tại. Vui lòng nộp hồ sơ thẩm định hoặc chờ Chủ nhiệm nộp tài liệu bổ sung.' });
  }
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_approved_at = ?, budget_4a_approved_by = ? WHERE id = ?')
    .run('approved', approvedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_approve', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', 'Tổ thẩm định phê duyệt dự toán');
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetApprovedEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, approvedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  const step4Done = (() => {
    const r = db.prepare('SELECT step_4_reviewer1_done, step_4_reviewer2_done FROM cap_vien_submissions WHERE id = ?').get(id);
    return r && r.step_4_reviewer1_done && r.step_4_reviewer2_done;
  })();
  if (step4Done) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    sendCapVienStep5ReadyEmail({ submissionTitle: sub.title, submissionId: id });
  }
  console.log('[API] cap-vien step 4a approve — submission ' + id);
  return res.json({ message: 'Đã phê duyệt dự toán. Email đã gửi đến Chủ nhiệm và Hội đồng.' + (step4Done ? ' Bước 4 và 4A đều hoàn thành, đã chuyển sang Bước 5.' : ' Đang chờ Bước 4 (Phản biện) hoàn thành.'), status: 'approved', step5Ready: step4Done });
});

// Admin: Gửi lại email Bước 4 (phân công phản biện → phản biện + Hội đồng) — dùng khi đã qua bước 3→4 nhưng email chưa gửi
app.post('/api/cap-vien/submissions/:id/send-step4-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, assignedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ gửi được email Bước 4 khi hồ sơ đã qua Bước 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  if (reviewerIds.length < 2) return res.status(400).json({ message: 'Hồ sơ chưa có đủ 2 phản biện được phân công' });
  const chairmanRow = sub.assignedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(sub.assignedById) : null;
  const chairmanName = (chairmanRow && (chairmanRow.fullname || chairmanRow.email)) || 'Chủ tịch';
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
  const reviewerEmails = reviewers.map(r => r.email).filter(Boolean);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
  console.log('[API] cap-vien admin send-step4-email — submission ' + id);
  return res.json({ message: 'Đã gửi email Bước 4 đến các phản biện và Hội đồng.' });
});

// Admin: Gửi lại email Bước 4A (thông báo Tổ thẩm định tài chính, CC Hội đồng) — dùng khi đã qua bước 3→4 nhưng email chưa gửi
app.post('/api/cap-vien/submissions/:id/send-step4a-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ gửi được email Bước 4A khi hồ sơ đã qua Bước 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
  console.log('[API] cap-vien admin send-step4a-email — submission ' + id);
  return res.json({ message: 'Đã gửi email Bước 4A đến Tổ thẩm định tài chính (CC Hội đồng).' });
});

// Admin đưa hồ sơ về Bước 2 (route riêng để đảm bảo revert luôn hoạt động)
app.post('/api/cap-vien/submissions/:id/revert-to-step-2', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về Bước 2 (kiểm tra lại)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const currentStatus = sub.status || 'SUBMITTED';
  if (currentStatus === 'SUBMITTED') {
    return res.status(400).json({ message: 'Hồ sơ đang ở Bước 2, không cần đưa về' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
    .run('SUBMITTED', id);
  insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2 để kiểm tra lại');
  console.log('[API] cap-vien revert-to-step-2 — submission ' + id);
  return res.json({ message: 'Đã đưa hồ sơ về Bước 2. Thư ký có thể nhấn Hợp lệ hoặc Yêu cầu bổ sung lại.', status: 'SUBMITTED' });
});

// Admin đưa hồ sơ về bước trước (3, 4, 5, 6, 7) — nút "Đưa về Bước N (Admin)"
app.post('/api/cap-vien/submissions/:id/revert-to-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = parseInt(req.params.step, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  if (isNaN(step) || step < 2 || step > 7) return res.status(400).json({ message: 'Bước phải từ 2 đến 7' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về bước trước đó' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });

  if (step === 2) {
    db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?').run('SUBMITTED', id);
    insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2');
    return res.json({ message: 'Đã đưa hồ sơ về Bước 2.', status: 'SUBMITTED' });
  }

  const clearStep4And4a = () => {
    db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL WHERE id = ?').run(id);
  };

  if (step === 3) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('VALIDATED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 3 — submission ' + id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 3 (Phân công phản biện).', status: 'VALIDATED' });
  }

  if (step === 4) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('ASSIGNED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 4 — submission ' + id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 4 & 4A.', status: 'ASSIGNED' });
  }

  if (step === 5) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 5 (Họp Hội đồng).', status: 'REVIEWED' });
  }

  if (step === 6) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 6 (Cấp Quyết định).', status: 'CONDITIONAL' });
  }

  if (step === 7) {
    db.prepare(`UPDATE cap_vien_submissions SET status = ?, step8_completed = 0, step8_waived = 0,
      step8a_completed = 0, step8a_waived = 0 WHERE id = ?`).run('APPROVED', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 7 (Ký hợp đồng).', status: 'APPROVED' });
  }

  return res.status(400).json({ message: 'Bước không hợp lệ' });
});

// Dev-only tiện ích: reset Bước 2 / 3 / 4 / 4A / 5 về trạng thái ban đầu
app.post('/api/cap-vien/submissions/:id/dev-reset-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepKey = String(req.params.step || '').toLowerCase();
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  if (!['2', '3', '4', '4a', '5'].includes(stepKey)) return res.status(400).json({ message: 'Chỉ hỗ trợ reset bước 2, 3, 4, 4A hoặc 5' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được reset bước (dev)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });

  if (stepKey === '2') {
    db.transaction(() => {
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL, assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL WHERE id = ?')
        .run('SUBMITTED', id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId IN ('2','3','4','4a')").run(id);
      db.prepare('DELETE FROM cap_vien_step2_history WHERE submissionId = ?').run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND COALESCE(revisionRound, 0) > 0").run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName IN ('reviewer_phieu_1','reviewer_phieu_2')").run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND (fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh') OR fieldName LIKE 'budget_revision_request_%')").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId IN ('2','3','4','4a')").run(id);
    })();
    return res.json({ message: 'Đã reset Bước 2 (và dọn dữ liệu thử Bước 3–4–4A). Hồ sơ về SUBMITTED, chờ Thư ký kiểm tra lại.', status: 'SUBMITTED' });
  }

  if (stepKey === '3') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'Đã reset Bước 3 về trạng thái ban đầu (chờ phân công phản biện).', status: 'VALIDATED' });
  }

  if (stepKey === '4') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName IN ('reviewer_phieu_1','reviewer_phieu_2')").run(id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'Đã reset Bước 4 về trạng thái ban đầu (chờ phân công phản biện).', status: 'VALIDATED' });
  }

  if (stepKey === '5') {
    const step5MinutesField = 'step5_bien_ban_hop_hd';
    const rows = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').all(id, step5MinutesField);
    const extraRows = db.prepare("SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_hd_extra_%'").all(id);
    const revRows = db.prepare("SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_council_revision_f_%'").all(id);
    const st = String(sub.status || '').toUpperCase();
    const newStatus = (st === 'IN_MEETING' || st === 'CONDITIONAL') ? 'REVIEWED' : (sub.status || 'SUBMITTED');
    db.transaction(() => {
      rows.forEach((r) => {
        if (r.path) safeUnlinkCapVienStoredFile(r.path);
      });
      extraRows.forEach((r) => {
        if (r.path) safeUnlinkCapVienStoredFile(r.path);
      });
      revRows.forEach((r) => {
        if (r.path) safeUnlinkCapVienStoredFile(r.path);
      });
      db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, step5MinutesField);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_hd_extra_%'").run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_council_revision_f_%'").run(id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '5'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '5'").run(id);
      db.prepare(`UPDATE cap_vien_submissions SET
        step5_hd_meeting_location = NULL,
        step5_hd_meeting_attendance = NULL,
        step5_hd_meeting_documents = NULL,
        step5_hd_meeting_vote_result = NULL,
        step5_hd_meeting_decision = NULL,
        step5_hd_meeting_event_time = NULL,
        step5_hd_meeting_updated_at = NULL,
        step5_hd_meeting_updated_by = NULL,
        step5_council_revision_status = NULL,
        step5_council_revision_round = 0,
        step5_council_revision_note = NULL,
        step5_council_revision_requested_at = NULL,
        step5_council_revision_requested_by = NULL,
        status = ?
      WHERE id = ?`).run(newStatus, id);
    })();
    return res.json({
      message: 'Đã reset Bước 5: xóa thông tin họp, biên bản, lịch sử & deadline bước 5.',
      status: newStatus
    });
  }

  db.transaction(() => {
    db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND (fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh') OR fieldName LIKE 'budget_revision_request_%')").run(id);
    db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4a'").run(id);
    db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '4a'").run(id);
    db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL, status = ? WHERE id = ?')
      .run('ASSIGNED', id);
  })();
  return res.json({ message: 'Đã reset Bước 4A về trạng thái ban đầu (thẩm định lại từ đầu).', status: 'ASSIGNED' });
});

// Nghiên cứu viên nộp lại hồ sơ sau khi Thư ký yêu cầu bổ sung (Bước 2) — chỉ cập nhật trạng thái (không file). Nếu có file bổ sung thì dùng POST /supplement.
app.post('/api/cap-vien/submissions/:id/resubmit', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chỉ được nộp lại khi Thư ký đã yêu cầu bổ sung (trạng thái Cần bổ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ chủ nhiệm đề tài hoặc Admin mới được nộp lại hồ sơ' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_resubmit', req.user.id, 'researcher', 'Nghiên cứu viên nộp lại hồ sơ (không file bổ sung)');
  console.log('[API] cap-vien resubmit — submission ' + id);
  return res.json({ message: 'Đã ghi nhận nộp lại hồ sơ. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.', status: 'SUBMITTED' });
});

// Nộp hồ sơ bổ sung (Bước 2 — vẫn trong quy trình Bước 2): upload file(s), lưu bên dưới hồ sơ gốc (revisionRound tăng), chuyển status về SUBMITTED
app.post('/api/cap-vien/submissions/:id/supplement', authMiddleware, (req, res, next) => {
  uploadCapVien.array('supplement', 20)(req, res, (err) => {
    if (err) {
      req.files = [];
      req._uploadDirCapVien = null;
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chỉ được nộp hồ sơ bổ sung khi Thư ký đã yêu cầu bổ sung (trạng thái Cần bổ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ chủ nhiệm đề tài hoặc Admin mới được nộp hồ sơ bổ sung' });
  }
  const uploadedFiles = req.files && Array.isArray(req.files) ? req.files : [];
  const nextRound = (db.prepare('SELECT COALESCE(MAX(revisionRound), 0) + 1 AS r FROM cap_vien_submission_files WHERE submissionId = ?').get(id) || {}).r || 1;
  let submissionDir = null;
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  if (firstExisting && firstExisting.path) submissionDir = path.dirname(firstExisting.path);
  if (!submissionDir && uploadedFiles.length > 0) {
    const researcherFolder = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]) + '_' + req.user.id;
    submissionDir = path.join(uploadDirCapVien, researcherFolder, 'submission_' + id);
    fs.mkdirSync(submissionDir, { recursive: true });
  }
  const move = (f, index) => {
    if (!f || !f.path) return;
    const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    const newPath = path.join(submissionDir, 'supplement_' + nextRound + '_' + index + '_' + (storedName || '').replace(/[^a-zA-Z0-9._-]/g, '_'));
    try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'supplement_' + index, storedName, newPath, nextRound);
  };
  uploadedFiles.forEach((f, i) => move(f, i));
  const tempDir = req._uploadDirCapVien;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_supplement', req.user.id, 'researcher', uploadedFiles.length > 0 ? `Nộp hồ sơ bổ sung lần ${nextRound} (${uploadedFiles.length} file)` : 'Nộp hồ sơ bổ sung');
  const row = db.prepare('SELECT submittedBy, submittedById, createdAt FROM cap_vien_submissions WHERE id = ?').get(id);
  const u = row && row.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById) : null;
  sendCapVienSupplementSubmittedEmail({
    submissionTitle: sub.title,
    submittedByEmail: (row && row.submittedBy) || null,
    submittedByName: u ? u.fullname : null,
    createdAt: row ? row.createdAt : null,
    status: 'SUBMITTED',
    supplementRound: nextRound
  });
  console.log('[API] cap-vien supplement — submission ' + id + ', round ' + nextRound + ', files: ' + uploadedFiles.length);
  return res.json({
    message: uploadedFiles.length > 0
      ? 'Đã ghi nhận hồ sơ bổ sung (lần ' + nextRound + '). Quá trình vẫn ở Bước 2. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.'
      : 'Đã ghi nhận. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.',
    status: 'SUBMITTED',
    supplementRound: nextRound,
    filesCount: uploadedFiles.length
  });
});

app.get('/api/cap-vien/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ này' });
  }
  const files = db.prepare('SELECT path, originalName FROM cap_vien_submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'Không tìm thấy file hồ sơ' });
  const preparedCv = prepareDownloadFileList(res, files);
  if (!preparedCv) return;
  if (preparedCv.length === 1) return res.download(preparedCv[0].norm, preparedCv[0].originalName);
  try {
    const archiver = require('archiver');
    res.attachment('ho-so-cap-vien-' + id + '.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    preparedCv.forEach((p) => archive.file(p.norm, { name: p.originalName }));
    archive.finalize();
  } catch (e) {
    return res.download(preparedCv[0].norm, preparedCv[0].originalName);
  }
});

app.get('/api/cap-vien/submissions/:id/files/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(role);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) return res.status(403).json({ message: 'Bạn không có quyền tải file này' });
  const file = db.prepare('SELECT id, path, originalName FROM cap_vien_submission_files WHERE id = ? AND submissionId = ?').get(fileId, id);
  if (!file || !file.path) return res.status(404).json({ message: 'Không tìm thấy file' });
  return safeDownload(res, file.path, file.originalName);
});

app.delete('/api/cap-vien/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  try {
    deleteCapVienSubmissionCascade(id);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'INVALID_CAP_VIEN_SUBMISSION_ID') return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
    if (msg === 'CAP_VIEN_SUBMISSION_NOT_FOUND') return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
    console.error('[cap-vien/submissions DELETE]', msg || e);
    return res.status(500).json({ message: 'Không thể xóa hồ sơ. ' + msg });
  }
  return res.json({ message: 'Đã xóa hồ sơ đề tài cấp Viện và dữ liệu liên quan (dashboard, tiến trình, file).' });
});

// Admin: danh sách user (không trả hash password; có cờ activated)
app.get('/api/admin/users', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare(
    'SELECT id, email, fullname, role, academicTitle, createdAt, COALESCE(is_banned, 0) AS is_banned, password FROM users ORDER BY createdAt DESC'
  ).all();
  const users = rows.map((r) => {
    const activated = userHasLoginPassword(r.password);
    const roleLower = (r.role || '').toLowerCase();
    return {
      id: r.id,
      email: r.email,
      fullname: r.fullname,
      role: r.role,
      academicTitle: r.academicTitle,
      createdAt: r.createdAt,
      is_banned: r.is_banned,
      activated,
      isMasterAdminAccount: roleLower === 'admin' && userEmailIsMasterAdmin(r.email),
    };
  });
  return res.json({ users });
});

// Admin: nhật ký đăng nhập / truy cập / hành động (bảng user_activity_log)
app.get('/api/admin/activity-log', authMiddleware, adminOnly, (req, res) => {
  const q = req.query || {};
  const limit = Math.min(Math.max(parseInt(String(q.limit || '100'), 10) || 100, 1), 500);
  const offset = Math.max(parseInt(String(q.offset || '0'), 10) || 0, 0);
  const from = q.from ? String(q.from).trim() : '';
  const to = q.to ? String(q.to).trim() : '';
  const emailFilter = q.email ? String(q.email).trim().toLowerCase() : '';
  const actionFilter = q.action ? String(q.action).trim() : '';
  const moduleFilter = q.module ? String(q.module).trim() : '';

  const conds = [];
  const params = [];
  if (from) {
    conds.push('l.created_at >= ?');
    params.push(/^\d{4}-\d{2}-\d{2}$/.test(from) ? from + ' 00:00:00' : from);
  }
  if (to) {
    const toVal = /^\d{4}-\d{2}-\d{2}$/.test(to) ? to + ' 23:59:59' : to;
    conds.push('l.created_at <= ?');
    params.push(toVal);
  }
  if (emailFilter) {
    const safe = emailFilter.replace(/%/g, '').replace(/_/g, '');
    conds.push('LOWER(TRIM(COALESCE(l.email, ""))) LIKE ?');
    params.push('%' + safe + '%');
  }
  if (actionFilter) {
    conds.push('l.action = ?');
    params.push(actionFilter);
  }
  if (moduleFilter) {
    conds.push('l.module = ?');
    params.push(moduleFilter);
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const rows = db
    .prepare(
      `SELECT l.id, l.user_id, l.email, l.action, l.module, l.path, l.detail, l.ip_address, l.user_agent, l.created_at,
              u.fullname AS fullname
       FROM user_activity_log l
       LEFT JOIN users u ON u.id = l.user_id
       ${where}
       ORDER BY l.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const countRow = db.prepare(`SELECT COUNT(1) AS c FROM user_activity_log l ${where}`).get(...params);
  const total = countRow && typeof countRow.c === 'number' ? countRow.c : 0;

  return res.json({ rows, total, limit, offset });
});

// Admin: thêm tài khoản mới hoặc cập nhật họ tên + vai trò (gõ họ tên, email, chọn vai trò)
app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, password, academicTitle } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || 'researcher').toLowerCase().trim();
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trò không hợp lệ. Vui lòng khởi động lại server (node server.js) và thử lại.' });
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (councilRoles.includes(r) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chỉ email @sci.edu.vn mới được gán vai trò Chủ tịch, Thư ký, Thành viên Hội đồng' });
  }
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  const acadTitle = (academicTitle || '').trim() || null;
  const oldRole = existing ? (existing.role || '').toLowerCase() : '';
  const promotingToAdmin = r === 'admin' && oldRole !== 'admin';
  const demotingFromAdmin = oldRole === 'admin' && r !== 'admin';
  if (promotingToAdmin && !reqIsMasterAdmin(req)) {
    return res.status(403).json({
      message: 'Chỉ Master Admin mới được thêm tài khoản mới với vai trò Admin hoặc nâng user lên Admin.',
    });
  }
  if (demotingFromAdmin && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chỉ Master Admin mới được gỡ quyền Admin khỏi tài khoản.' });
  }
  if (demotingFromAdmin && userEmailIsMasterAdmin(em)) {
    return res.status(400).json({ message: 'Không thể gỡ quyền Master Admin hệ thống.' });
  }
  if (existing) {
    db.prepare('UPDATE users SET fullname = ?, role = ?, academicTitle = ? WHERE email = ?').run((fullname || '').trim(), r, acadTitle, em);
    return res.json({ message: 'Đã cập nhật họ tên và vai trò cho ' + em });
  }
  const plainPassword = (password || '').trim();
  if (plainPassword.length > 0 && plainPassword.length < 6) {
    return res.status(400).json({
      message:
        'Mật khẩu tối thiểu 6 ký tự, hoặc để trống để tạo tài khoản chưa kích hoạt (user tự đặt mật khẩu qua trang Đăng ký @sci.edu.vn).',
    });
  }
  if (plainPassword.length >= 6) {
    const hash = await bcrypt.hash(plainPassword, 10);
    db.prepare('INSERT INTO users (email, password, fullname, role, academicTitle) VALUES (?, ?, ?, ?, ?)').run(
      em,
      hash,
      (fullname || '').trim(),
      r,
      acadTitle
    );
    return res.status(201).json({ message: 'Đã thêm tài khoản với mật khẩu do bạn đặt.', activated: true });
  }
  // Để trống mật khẩu: tài khoản chưa kích hoạt (sentinel '' do cột password thường NOT NULL)
  db.prepare('INSERT INTO users (email, password, fullname, role, academicTitle) VALUES (?, ?, ?, ?, ?)').run(
    em,
    '',
    (fullname || '').trim(),
    r,
    acadTitle
  );
  return res.status(201).json({
    message:
      'Đã thêm tài khoản. Người dùng cần vào trang Đăng ký (@sci.edu.vn) để đặt mật khẩu và kích hoạt.',
    activated: false,
  });
});

// Admin: đưa tài khoản về chưa kích hoạt (xóa mật khẩu đăng nhập; không áp dụng Admin)
app.post('/api/admin/reset-user-password', authMiddleware, adminOnly, (req, res) => {
  const userId = parseInt(req.body && req.body.userId, 10);
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ message: 'userId không hợp lệ' });
  }
  const row = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
  if (!row) {
    return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  }
  if ((row.role || '').toLowerCase() === 'admin') {
    return res.status(400).json({ message: 'Không thể reset mật khẩu tài khoản Admin' });
  }
  if (Number(row.id) === Number(req.user.id)) {
    return res.status(400).json({ message: 'Không thể reset chính tài khoản đang đăng nhập' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run('', userId);
  return res.json({
    message: 'Đã reset. User cần đăng ký lại (trang Đăng ký @sci.edu.vn) để đặt mật khẩu mới.',
  });
});

// Admin: gửi email thông báo cấp vai trò tới địa chỉ email
app.post('/api/admin/users/send-role-email', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, tempPassword } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  const roleLabel = ROLE_LABELS[role] || role;
  let fullnameToUse = (fullname || '').trim();
  if (!fullnameToUse) {
    const row = db.prepare('SELECT fullname FROM users WHERE email = ?').get(em);
    if (row && row.fullname) fullnameToUse = row.fullname;
  }
  await sendRoleAssignmentEmail(em, fullnameToUse, role || 'researcher', tempPassword || null);
  if (!transporter) {
    return res.status(503).json({ message: 'Chưa cấu hình SMTP. Không thể gửi email. Xem README_BACKEND.md.' });
  }
  return res.json({ message: 'Đã gửi email thông báo đến ' + em });
});

// Admin: danh sách người nhận email thông báo (Admin thêm/xóa; khi có danh sách này thì mọi thông báo gửi tới đây)
app.get('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients ORDER BY id').all();
    return res.json({ recipients: rows || [] });
  } catch (e) {
    return res.json({ recipients: [] });
  }
});

// ========== Thống kê trang chủ (số liệu thật từ các module) ==========
function dbCount(sql) {
  try {
    const row = db.prepare(sql).get();
    if (!row || row.c == null) return 0;
    const n = Number(row.c);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  } catch (e) {
    return 0;
  }
}

app.get('/api/homepage-stats', (req, res) => {
  syncMissionsFromCapVien();
  const missions = dbCount('SELECT COUNT(*) as c FROM missions');
  /** Thẻ module «Nhiệm vụ KHCN» — cùng quy tắc với /api/missions/stats (hoàn thành / quá hạn / đang thực hiện) */
  const missionMini = { inProgress: 0, completed: 0, overdue: 0 };
  try {
    const mRows = db.prepare('SELECT status, end_date FROM missions').all();
    const now = new Date().toISOString().slice(0, 10);
    for (const m of mRows || []) {
      const st = (m.status || 'planning').toLowerCase();
      const isCompleted = st === 'completed' || st === 'hoan_thanh';
      const ed = m.end_date ? String(m.end_date).slice(0, 10) : '';
      const isPastEnd = ed && ed < now;
      if (isCompleted) missionMini.completed += 1;
      else if (isPastEnd) missionMini.overdue += 1;
      else missionMini.inProgress += 1;
    }
  } catch (e) {
    /* bảng missions thiếu cột hoặc lỗi DB — giữ 0 */
  }
  /**
   * Nhân lực KHCN: đếm bảng `personnel` chỉ khi module được bật trên trang chủ.
   * Module chưa triển khai (enabled = 0) → null để tránh hiển thị 0 gây hiểu nhầm.
   */
  let personnel = null;
  try {
    const hm = db
      .prepare('SELECT COALESCE(enabled, 0) AS en FROM homepage_modules WHERE code = ?')
      .get('personnel');
    if (hm && Number(hm.en) === 1) {
      personnel = dbCount('SELECT COUNT(*) as c FROM personnel');
    }
  } catch (e) {
    personnel = null;
  }
  /**
   * Tài sản trí tuệ: đếm `ip_assets` chỉ khi module được bật; tắt → null (không hiển thị 0).
   */
  let ip = null;
  try {
    const hmIp = db
      .prepare('SELECT COALESCE(enabled, 0) AS en FROM homepage_modules WHERE code = ?')
      .get('ip');
    if (hmIp && Number(hmIp.en) === 1) {
      ip = dbCount('SELECT COUNT(*) as c FROM ip_assets');
    }
  } catch (e) {
    ip = null;
  }
  const publications = dbCount(
    "SELECT COUNT(*) as c FROM publications WHERE COALESCE(status, '') != 'retracted'"
  );
  /** Thẻ module «Công bố KHCN» — đồng bộ logic lọc với module (không tính retracted) */
  const publicationMini = {
    indexedScopusWos: dbCount(
      `SELECT COUNT(*) as c FROM publications
       WHERE COALESCE(status, '') != 'retracted'
       AND (
         LOWER(COALESCE(index_db, '')) LIKE '%scopus%'
         OR LOWER(COALESCE(index_db, '')) LIKE '%web of science%'
         OR LOWER(COALESCE(index_db, '')) LIKE '%wos%'
       )`
    ),
    conferences: dbCount(
      `SELECT COUNT(*) as c FROM publications
       WHERE COALESCE(status, '') != 'retracted' AND pub_type = 'conference'`
    ),
    books: dbCount(
      `SELECT COUNT(*) as c FROM publications
       WHERE COALESCE(status, '') != 'retracted' AND pub_type IN ('book_chapter', 'book')`
    ),
  };
  const cooperation =
    dbCount('SELECT COUNT(*) as c FROM cooperation_doan_ra') +
    dbCount('SELECT COUNT(*) as c FROM cooperation_doan_vao') +
    dbCount('SELECT COUNT(*) as c FROM cooperation_mou_de_xuat') +
    dbCount('SELECT COUNT(*) as c FROM htqt_de_xuat') +
    dbCount('SELECT COUNT(*) as c FROM cooperation_thoa_thuan') +
    dbCount('SELECT COUNT(*) as c FROM cooperation_su_kien');
  // CRD Lab Booking — truy vấn trực tiếp từ bảng CRD (đồng bộ với thẻ module trên trang chủ)
  const crdMachines = dbCount('SELECT COUNT(*) as c FROM crd_machines');
  /** Lịch còn hiệu lực: từ ngày hôm nay trở đi, không tính đã hủy */
  const crdActiveBookings = dbCount(
    `SELECT COUNT(*) as c FROM crd_bookings
     WHERE COALESCE(NULLIF(TRIM(status), ''), 'confirmed') != 'cancelled'
     AND date >= date('now')`
  );
  /** Người có hồ sơ CRD còn được đặt lịch (chưa gỡ quyền, chưa bị khoá) */
  const crdActivePersons = dbCount(
    `SELECT COUNT(*) as c FROM crd_persons
     WHERE COALESCE(crd_access_revoked, 0) = 0 AND COALESCE(is_banned, 0) = 0`
  );
  const facilities = {
    activeBookings: crdActiveBookings,
    machines: crdMachines,
    activeUsers: crdActivePersons,
  };
  /** Thẻ module «Hợp tác» — lấy số liệu trực tiếp từ dữ liệu module đối tác */
  let cooperationMini = { doi_tac: 0, trong_nuoc: 0, quoc_te: 0 };
  try {
    const { stats, total } = cooperationComputePartnerStats();
    cooperationMini = {
      doi_tac: total || 0,
      trong_nuoc: stats.trong_nuoc || 0,
      quoc_te: stats.quoc_te || 0,
    };
  } catch (e) {
    /* bảng hợp tác chưa có hoặc lỗi */
  }
  let dmsMini = { total: 0, active: 0, expiringSoon: 0, expired: 0 };
  try {
    const now = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    dmsMini.total = db.prepare('SELECT COUNT(*) AS c FROM dms_documents').get().c;
    dmsMini.active = db
      .prepare(`SELECT COUNT(*) AS c FROM dms_documents WHERE lower(status) = 'active'`)
      .get().c;
    dmsMini.expired = db
      .prepare(
        `SELECT COUNT(*) AS c FROM dms_documents WHERE lower(status) IN ('expired','revoked')`
      )
      .get().c;
    dmsMini.expiringSoon = db
      .prepare(
        `SELECT COUNT(*) AS c FROM dms_documents
         WHERE lower(status) = 'active' AND valid_until IS NOT NULL AND TRIM(valid_until) != ''
           AND date(valid_until) >= date(?) AND date(valid_until) <= date(?)`
      )
      .get(now, soon).c;
  } catch (e) {
    /* bảng DMS chưa có */
  }
  let equipmentMini = { profiles: 0, documents: 0, notifications: 0 };
  try {
    equipmentMini.profiles = db.prepare(`SELECT COUNT(*) AS c FROM equipments`).get().c;
    equipmentMini.documents = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM equipment_documents
         WHERE COALESCE(is_disabled, 0) = 0
           AND (is_current IS NULL OR is_current = 1)`
      )
      .get().c;
    let notifUserId = null;
    try {
      const tok = getTokenFromReq(req);
      if (tok) {
        const p = jwt.verify(tok, JWT_SECRET);
        if (p && p.id != null && !userIdIsBanned(p.id)) notifUserId = Number(p.id);
      }
    } catch (_) {
      notifUserId = null;
    }
    if (notifUserId != null) {
      equipmentMini.notifications = db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM app_notifications
           WHERE user_id = ?
             AND module = 'equipment'
             AND event_type = 'equip_incident'
             AND read_at IS NULL`
        )
        .get(notifUserId).c;
    } else {
      equipmentMini.notifications = 0;
    }
  } catch (e) {
    /* bảng Equipment chưa có */
  }
  return res.json({
    missions,
    missionMini,
    personnel,
    ip,
    publications,
    publicationMini,
    cooperation,
    cooperationMini,
    facilities,
    dmsMini,
    equipmentMini,
  });
});

// ========== Nhiệm vụ KHCN (Dashboard): trích xuất thống kê + danh sách tìm kiếm ==========
syncMissionsFromCapVien();

app.get('/api/missions/stats', authMiddleware, (req, res) => {
  syncMissionsFromCapVien();
  const all = db.prepare('SELECT id, level, status, end_date, budget, start_date FROM missions').all();
  const now = new Date().toISOString().slice(0, 10);
  const thisMonthStart = now.slice(0, 7) + '-01';
  const byLevel = { national: 0, ministry: 0, university: 0, institute: 0 };
  const byStatus = { planning: 0, approved: 0, ongoing: 0, review: 0, completed: 0, overdue: 0, cho_phe_duyet_ngoai: 0, da_phe_duyet: 0, dang_thuc_hien: 0, nghiem_thu_trung_gian: 0, nghiem_thu_tong_ket: 0, hoan_thanh: 0, khong_duoc_phe_duyet: 0, cho_vien_xet_chon: 0, cho_bo_tham_dinh: 0, cho_ngoai_xet_chon: 0, cho_ky_hop_dong: 0, xin_dieu_chinh: 0, cho_nghiem_thu_co_so: 0, cho_nghiem_thu_bo_nn: 0, hoan_thien_sau_nghiem_thu: 0, thanh_ly_hop_dong: 0 };
  let totalBudget = 0;
  let overdue = 0;
  let completed = 0;
  let totalEnded = 0;
  let acceptanceThisMonth = 0;
  for (const m of all) {
    const lev = (m.level || 'institute').toLowerCase();
    if (byLevel[lev] !== undefined) byLevel[lev]++;
    const st = (m.status || 'planning').toLowerCase();
    if (byStatus[st] !== undefined) byStatus[st]++;
    if (m.budget != null) totalBudget += Number(m.budget);
    const isCompleted = ['completed', 'hoan_thanh'].includes(st);
    if (m.end_date && m.end_date < now && !isCompleted) overdue++;
    if (isCompleted) { completed++; totalEnded++; }
    else if (m.end_date) totalEnded++;
    if (['review', 'nghiem_thu_trung_gian', 'nghiem_thu_tong_ket', 'cho_nghiem_thu_co_so', 'cho_nghiem_thu_bo_nn', 'hoan_thien_sau_nghiem_thu'].includes(st)) acceptanceThisMonth++;
  }
  const completionRate = totalEnded > 0 ? Math.round((completed / totalEnded) * 100) : 0;
  return res.json({
    total: all.length,
    byLevel,
    byStatus,
    totalBudget: Math.round(totalBudget),
    overdue,
    completionRate,
    acceptanceThisMonth,
    totalOngoing: (byStatus.ongoing || 0) + (byStatus.dang_thuc_hien || 0)
  });
});

/** Tìm kiếm nhiệm vụ: gộp dấu + nhiều từ (AND), giống tinh thần module Quản lý công bố */
function missionSearchFold(s) {
  try {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  } catch (e) {
    return String(s == null ? '' : s).toLowerCase();
  }
}

const MISSION_LEVEL_SEARCH_LABELS = {
  national: 'Cấp Nhà nước cap quoc gia',
  ministry: 'Cấp Bộ bo',
  university: 'Cấp ĐHQG dai hoc quoc gia',
  institute: 'Cấp Viện vien co so',
};

const MISSION_STATUS_SEARCH_LABELS = {
  planning: 'Lập kế hoạch lap ke hoach',
  approved: 'Đã phê duyệt da phe duyet',
  ongoing: 'Đang thực hiện dang thuc hien',
  review: 'Nghiệm thu nghiem thu',
  completed: 'Hoàn thành hoan thanh',
  overdue: 'Quá hạn qua han',
  cho_phe_duyet_ngoai: 'Chờ phê duyệt ngoài cho phe duyet ngoai',
  da_phe_duyet: 'Đã phê duyệt da phe duyet',
  dang_thuc_hien: 'Đang thực hiện dang thuc hien',
  nghiem_thu_trung_gian: 'Nghiệm thu cơ sở Viện nghiem thu co so',
  nghiem_thu_tong_ket: 'Nghiệm thu cấp Bộ NN nghiem thu bo',
  hoan_thanh: 'Hoàn thành hoan thanh',
  khong_duoc_phe_duyet: 'Không được phê duyệt khong duoc phe duyet',
  cho_vien_xet_chon: 'Chờ HĐ Viện xét chọn cho hoi dong vien',
  cho_ct_hd_xet_duyet: 'Chờ CT HĐ KHCN xét duyệt chu tich hoi dong',
  buoc4a: 'Bước 4A Nhánh A buoc 4a',
  buoc4b: 'Bước 4B Nhánh B buoc 4b',
  cho_bo_tham_dinh: 'Chờ Bộ thẩm định cho bo tham dinh',
  cho_ngoai_xet_chon: 'Chờ cơ quan ngoài xét chọn cho ngoai',
  cho_phe_duyet_chinh_thuc: 'Chờ phê duyệt chính thức cho phe duyet chinh thuc',
  cho_ky_hop_dong: 'Chờ ký hợp đồng cho ky hop dong',
  dung_khong_dat_dot: 'Dừng không đạt đợt dung khong dat dot',
  xin_dieu_chinh: 'Xin điều chỉnh nội dung xin dieu chinh',
  cho_nghiem_thu_co_so: 'Chờ nghiệm thu cơ sở cho nghiem thu co so',
  cho_nghiem_thu_bo_nn: 'Chờ nghiệm thu cấp Bộ NN cho nghiem thu bo',
  hoan_thien_sau_nghiem_thu: 'Hoàn thiện sau nghiệm thu hoan thien sau nghiem thu',
  thanh_ly_hop_dong: 'Thanh lý hợp đồng thanh ly hop dong',
};

function missionFormatDateVn(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return String(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function missionHaystackNumberVi(n) {
  if (n == null || n === '') return '';
  try {
    return new Intl.NumberFormat('vi-VN').format(Number(n));
  } catch (e) {
    return String(n);
  }
}

function buildMissionSearchHaystack(r) {
  const chunks = [];
  const push = (v) => {
    if (v == null || v === '') return;
    chunks.push(String(v));
  };
  push(r.id);
  push(r.code);
  push(r.title);
  push(r.principal);
  push(r.principal_hoc_vi);
  push(r.principal_don_vi);
  push(r.principal_orcid);
  push(r.level);
  push(r.status);
  push(r.start_date);
  push(r.end_date);
  push(missionFormatDateVn(r.start_date));
  push(missionFormatDateVn(r.end_date));
  if (r.progress != null && r.progress !== '') {
    push(String(r.progress));
    push(`${r.progress}%`);
  }
  push(r.budget);
  push(missionHaystackNumberVi(r.budget));
  push(r.managing_agency);
  push(r.contract_number);
  push(r.funding_source);
  push(r.cooperating_units);
  push(r.mission_type);
  push(r.field);
  push(r.objectives);
  push(r.disbursement_year);
  push(r.approved_budget);
  push(missionHaystackNumberVi(r.approved_budget));
  push(r.disbursed_budget);
  push(missionHaystackNumberVi(r.disbursed_budget));
  push(r.source_type);
  push(r.source_id);
  const lv = MISSION_LEVEL_SEARCH_LABELS[r.level];
  if (lv) push(lv);
  const st = MISSION_STATUS_SEARCH_LABELS[r.status];
  if (st) push(st);
  if (r.source_type === 'cap_vien') {
    push('de tai cap vien dong bo cap vien hồ sơ cấp viện');
  }
  try {
    push(JSON.stringify(r));
  } catch (e) {}
  return missionSearchFold(chunks.join(' '));
}

function missionSearchQueryMatchesRow(r, queryRaw) {
  const qFold = missionSearchFold(queryRaw).trim();
  if (!qFold) return true;
  const tokens = qFold.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = buildMissionSearchHaystack(r);
  return tokens.every((t) => hay.includes(t));
}

app.get('/api/missions', authMiddleware, (req, res) => {
  syncMissionsFromCapVien();
  const qRaw = (req.query.q || req.query.search || '').trim();
  const level = (req.query.level || '').trim().toLowerCase();
  const status = (req.query.status || '').trim().toLowerCase();
  const year = (req.query.year || '').trim();
  const whereParts = [];
  const params = [];
  if (level) {
    whereParts.push('level = ?');
    params.push(level);
  }
  if (status) {
    const statusList = status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statusList.length === 1) {
      whereParts.push('status = ?');
      params.push(statusList[0]);
    } else if (statusList.length > 1) {
      whereParts.push('status IN (' + statusList.map(() => '?').join(',') + ')');
      params.push(...statusList);
    }
  }
  if (year) {
    whereParts.push('(start_date LIKE ? OR end_date LIKE ?)');
    params.push(year + '%', year + '%');
  }
  const whereSql = whereParts.length ? ' AND ' + whereParts.join(' AND ') : '';
  const orderSql = ' ORDER BY start_date DESC, id DESC';
  const selectBases = [
    'SELECT id, code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, managing_agency, contract_number, funding_source, cooperating_units, mission_type, field, objectives, disbursement_year, approved_budget, disbursed_budget, source_id, source_type FROM missions WHERE 1=1',
    'SELECT id, code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, source_id, source_type FROM missions WHERE 1=1',
    'SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type FROM missions WHERE 1=1',
  ];
  let rows;
  let lastErr;
  for (let i = 0; i < selectBases.length; i++) {
    const sql = selectBases[i] + whereSql + orderSql;
    try {
      rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
      if (i === selectBases.length - 1) {
        rows.forEach((r) => {
          r.principal_hoc_vi = r.principal_don_vi = r.principal_orcid = null;
        });
      }
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!rows) {
    console.error('[GET /api/missions]', lastErr && lastErr.message ? lastErr.message : lastErr);
    return res.status(500).json({ missions: [], message: 'Không đọc được danh sách nhiệm vụ.' });
  }
  if (qRaw) {
    rows = rows.filter((r) => missionSearchQueryMatchesRow(r, qRaw));
  }
  return res.json({ missions: rows });
});

// Tạo nhiệm vụ mới (Luồng B - Cấp Bộ/ĐHQG/Nhà nước). Cấp Viện dùng nop-de-tai-cap-vien.html
app.post('/api/missions', authMiddleware, (req, res) => {
  const user = req.user;
  const body = req.body || {};
  const level = (body.level || '').trim().toLowerCase();
  if (!['national', 'ministry', 'university'].includes(level)) {
    return res.status(400).json({ message: 'API này chỉ dùng cho Cấp Bộ, Cấp ĐHQG, Cấp Nhà nước. Cấp Viện vui lòng nộp tại trang Đề tài cấp Viện.' });
  }
  const title = (body.title || '').trim();
  if (!title) return res.status(400).json({ message: 'Tên đề tài không được để trống.' });
  const code = (body.code || '').trim() || ('DT-' + level.toUpperCase().slice(0, 2) + '-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-4));
  const principal = (user.fullname || user.email || '').trim() || null;
  const status = (body.status || 'cho_phe_duyet_ngoai').trim();
  const validStatus = ['cho_phe_duyet_ngoai', 'da_phe_duyet', 'dang_thuc_hien', 'nghiem_thu_trung_gian', 'nghiem_thu_tong_ket', 'hoan_thanh', 'khong_duoc_phe_duyet', 'planning', 'approved', 'ongoing', 'review', 'completed', 'overdue', 'cho_vien_xet_chon', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_ky_hop_dong', 'xin_dieu_chinh', 'cho_nghiem_thu_co_so', 'cho_nghiem_thu_bo_nn', 'hoan_thien_sau_nghiem_thu', 'thanh_ly_hop_dong'];
  const finalStatus = validStatus.includes(status) ? status : 'cho_vien_xet_chon';
  const startDate = (body.start_date || '').trim() || null;
  const endDate = (body.end_date || '').trim() || null;
  const progress = body.progress != null && !isNaN(parseInt(body.progress, 10)) ? Math.min(100, Math.max(0, parseInt(body.progress, 10))) : 0;
  const budget = body.budget != null && !isNaN(parseFloat(body.budget)) ? parseFloat(body.budget) : null;
  const managingAgency = (body.managing_agency || '').trim() || null;
  const contractNumber = (body.contract_number || '').trim() || null;
  const fundingSource = (body.funding_source || '').trim() || null;
  const approvedBudget = body.approved_budget != null && !isNaN(parseFloat(body.approved_budget)) ? parseFloat(body.approved_budget) : null;
  const disbursedBudget = body.disbursed_budget != null && !isNaN(parseFloat(body.disbursed_budget)) ? parseFloat(body.disbursed_budget) : null;
  const disbursementYear = (body.disbursement_year || '').trim() || null;
  const cooperatingUnits = (body.cooperating_units || '').trim() || null;
  const missionType = (body.mission_type || '').trim() || null;
  const field = (body.field || '').trim() || null;
  const objectives = (body.objectives || '').trim() || null;
  try {
    db.prepare(`
      INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_type,
        managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year,
        cooperating_units, mission_type, field, objectives)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, title, principal, level, finalStatus, startDate, endDate, progress, budget,
      managingAgency, contractNumber, fundingSource, approvedBudget, disbursedBudget, disbursementYear,
      cooperatingUnits, missionType, field, objectives);
    const row = db.prepare('SELECT id, code, title, principal, level, status, managing_agency, objectives, start_date, end_date, budget, created_at FROM missions WHERE code = ? ORDER BY id DESC LIMIT 1').get(code);
    sendMissionProposalToCouncil(row, user.email || '');
    return res.status(201).json({ message: 'Đã đăng ký đề tài.', mission: row });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'Mã đề tài đã tồn tại.' });
    throw e;
  }
});

const LEVEL_LABELS_EMAIL = { national: 'Cấp Nhà nước', ministry: 'Cấp Bộ', university: 'Cấp ĐHQG', institute: 'Cấp Viện' };

function sendMissionProposalToCouncil(mission, submitterEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) {
    if (!transporter) console.log('[Email] Bỏ qua: chưa cấu hình SMTP');
    else console.log('[Email] Bỏ qua: chưa có người nhận (Quản trị → Danh sách người nhận email)');
    return Promise.resolve();
  }
  const missionId = mission.id;
  const title = mission.title || '';
  const principal = mission.principal || submitterEmail;
  const levelLabel = LEVEL_LABELS_EMAIL[mission.level] || mission.level || '';
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + missionId;
  const subject = '[Đề tài ngoài Viện] Đề xuất mới: ' + title;

  const detailLines = [];
  detailLines.push('- Chủ nhiệm: ' + principal);
  detailLines.push('- Cấp đề tài: ' + levelLabel);
  detailLines.push('- Tên đề tài: ' + title);
  if (mission.managing_agency) detailLines.push('- Cơ quan quản lý: ' + mission.managing_agency);
  if (mission.start_date || mission.end_date) detailLines.push('- Thời gian: ' + (mission.start_date || '—') + ' đến ' + (mission.end_date || '—'));
  if (mission.budget != null) detailLines.push('- Kinh phí dự kiến: ' + new Intl.NumberFormat('vi-VN').format(mission.budget) + ' VNĐ');
  if (mission.objectives) detailLines.push('- Mục tiêu nghiên cứu: ' + (mission.objectives.length > 200 ? mission.objectives.slice(0, 200) + '...' : mission.objectives));
  const detailBlock = detailLines.join('\n');

  const text =
    'Kính gửi các thầy cô thành viên Hội đồng KHCN Viện Tế bào gốc,\n\n' +
    'Chủ nhiệm ' + principal + ' vừa gửi đề xuất đề tài ' + levelLabel + ': ' + title + '.\n\n' +
    'Chi tiết đề tài:\n' + detailBlock + '\n\n' +
    'Vui lòng đăng nhập hệ thống để xem chi tiết và hồ sơ đính kèm, đồng thời thực hiện bước tiếp theo (xét chọn/phê duyệt đề xuất).\n\n' +
    'Xem tiến trình đề tài: ' + timelineUrl;

  const detailHtml = '<ul style="margin:10px 0;padding-left:20px;line-height:1.6">' +
    '<li><strong>Chủ nhiệm:</strong> ' + (principal || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' +
    '<li><strong>Cấp đề tài:</strong> ' + (levelLabel || '').replace(/</g, '&lt;') + '</li>' +
    '<li><strong>Tên đề tài:</strong> ' + (title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' +
    (mission.managing_agency ? '<li><strong>Cơ quan quản lý:</strong> ' + String(mission.managing_agency).replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</li>' : '') +
    ((mission.start_date || mission.end_date) ? '<li><strong>Thời gian:</strong> ' + (mission.start_date || '—') + ' đến ' + (mission.end_date || '—') + '</li>' : '') +
    (mission.budget != null ? '<li><strong>Kinh phí dự kiến:</strong> ' + new Intl.NumberFormat('vi-VN').format(mission.budget) + ' VNĐ</li>' : '') +
    (mission.objectives ? '<li><strong>Mục tiêu nghiên cứu:</strong> ' + String(mission.objectives).slice(0, 300).replace(/</g, '&lt;').replace(/>/g, '&gt;') + (mission.objectives.length > 300 ? '...' : '') + '</li>' : '') +
    '</ul>';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>Kính gửi các thầy cô thành viên Hội đồng KHCN Viện Tế bào gốc,</p>' +
    '<p>Chủ nhiệm <strong>' + (principal || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> vừa gửi đề xuất đề tài <strong>' + (levelLabel || '').replace(/</g, '&lt;') + '</strong>: <strong>' + (title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p>' +
    '<p>Chi tiết đề tài:</p>' + detailHtml +
    '<p>Vui lòng đăng nhập hệ thống để xem chi tiết và hồ sơ đính kèm, đồng thời thực hiện bước tiếp theo (xét chọn/phê duyệt đề xuất).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0;font-weight:600">Xem tiến trình đề tài</a></p>' +
    '</div>';

  console.log('[Email] Gửi thông báo đề xuất đề tài tới: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lỗi gửi:', err.message));
}

// Danh sách file đăng ký (Thuyết minh, Văn bản xin phép)
app.get('/api/missions/:id/files', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const rows = db.prepare('SELECT id, field_name, original_name, path, created_at FROM missions_files WHERE mission_id = ? ORDER BY created_at ASC').all(id);
  return res.json({ files: rows });
});

// Thông tin CN + nhiệm vụ đang thực hiện + cảnh báo Điều 10 (cho trang CT HĐ xét duyệt)
app.get('/api/missions/:id/cn-info', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  let mission = db.prepare('SELECT id, principal, level FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  try {
    const ext = db.prepare('SELECT principal_hoc_vi, principal_don_vi, principal_orcid FROM missions WHERE id = ?').get(id);
    if (ext) {
      mission.principal_hoc_vi = ext.principal_hoc_vi || '';
      mission.principal_don_vi = ext.principal_don_vi || '';
      mission.principal_orcid = ext.principal_orcid || '';
    }
  } catch (e) {
    mission.principal_hoc_vi = mission.principal_don_vi = mission.principal_orcid = '';
  }
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const principal = (mission.principal || '').trim();
  const ongoingStatuses = ['cho_vien_xet_chon', 'cho_ct_hd_xet_duyet', 'buoc4a', 'buoc4b', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_phe_duyet_ngoai', 'da_phe_duyet', 'approved', 'cho_ky_hop_dong', 'dang_thuc_hien', 'ongoing', 'xin_dieu_chinh', 'cho_nghiem_thu_co_so', 'nghiem_thu_trung_gian', 'review', 'cho_nghiem_thu_bo_nn', 'nghiem_thu_tong_ket', 'hoan_thien_sau_nghiem_thu', 'thanh_ly_hop_dong'];
  const ongoing = principal ? db.prepare(
    'SELECT id, code, title, level, status FROM missions WHERE id != ? AND LOWER(TRIM(principal)) = LOWER(?) AND status IN (' + ongoingStatuses.map(() => '?').join(',') + ') ORDER BY start_date DESC'
  ).all(id, principal, ...ongoingStatuses) : [];
  const nationalCount = ongoing.filter(m => (m.level || '').toLowerCase() === 'national').length;
  const totalCount = ongoing.length;
  const warningNational = nationalCount >= 1;
  const warningMaxCount = totalCount >= 3;
  return res.json({
    principal: mission.principal || '',
    principal_hoc_vi: mission.principal_hoc_vi || '',
    principal_don_vi: mission.principal_don_vi || '',
    principal_orcid: mission.principal_orcid || '',
    level: mission.level || '',
    ongoing,
    warning_dieu10_national: warningNational,
    warning_dieu10_max: warningMaxCount
  });
});

app.get('/api/missions/:id/files/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ đề tài này.' });
  }
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_files WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const checked = normalizeAndCheckDownloadPath(row.path);
  if (checked.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (checked.err) return res.status(404).json({ message: 'File không tồn tại' });
  const safeName = (row.original_name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
  return res.sendFile(checked.norm);
});

// Xem file inline (PDF viewer) — cần token trong URL hoặc cookie
app.get('/api/missions/:id/files/:fileId/view', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ đề tài này.' });
  }
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_files WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const checked = normalizeAndCheckDownloadPath(row.path);
  if (checked.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (checked.err) return res.status(404).json({ message: 'File không tồn tại' });
  const ext = (row.original_name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + (row.original_name || 'view.pdf').replace(/[^a-zA-Z0-9._-]/g, '_') + '"');
  }
  return res.sendFile(checked.norm);
});

// Bước 2 — Thư ký/Admin: Hồ sơ hợp lệ → chuyển sang Bước 3 (Chờ CT HĐ KHCN xét duyệt)
app.post('/api/missions/:id/step2-approve', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, level, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2 (Phòng KHCN kiểm tra)' });
  }
  const now = new Date().toISOString();
  const nhanh = computeNhanhFromLevel(mission.level);
  db.prepare(`UPDATE missions SET status = ?, buoc3_trang_thai = ?, buoc3_ngay_gui = ?, nhanh = ? WHERE id = ?`).run('cho_ct_hd_xet_duyet', 'cho_xet_duyet', now, nhanh, id);
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chairmanEmail = getChairmanEmail();
  const reviewUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/ct-hd-xet-duyet-de-tai.html?id=' + id;
  if (transporter && chairmanEmail) {
    const subject = '[Đề tài ngoài Viện] Có 1 đề tài chờ anh/chị xét duyệt: ' + (mission.title || '');
    const text = 'Phòng KHCN&QHĐN đã xác nhận hồ sơ hợp lệ. Có 1 đề tài chờ anh/chị xét duyệt: "' + (mission.title || '') + '" (Chủ nhiệm: ' + (mission.principal || '') + '). Vào xem và điền phiếu nhận xét: ' + reviewUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã xác nhận hồ sơ hợp lệ.</p><p><strong>Có 1 đề tài chờ anh/chị xét duyệt:</strong> ' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + ' (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p><p>Vui lòng vào xem thuyết minh và điền phiếu nhận xét.</p><p><a href="' + reviewUrl + '" style="color:#1565c0;font-weight:600">Vào trang xét duyệt</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: chairmanEmail, subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Phòng KHCN đã chuyển lên Bước 3: ' + (mission.title || '');
    const html = '<p>Phòng KHCN&QHĐN đã xác nhận hồ sơ hợp lệ. Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> đã chuyển sang <strong>Bước 3 — Chờ CT HĐ KHCN xét duyệt</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 3 (Chờ CT HĐ xét duyệt). Email đã gửi đến Chủ tịch Hội đồng.', status: 'cho_ct_hd_xet_duyet' });
});

// Bước 2 — Thư ký/Admin: Yêu cầu bổ sung (hồ sơ vẫn ở bước 2)
app.post('/api/missions/:id/step2-request-supplement', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2' });
  }
  const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Yêu cầu bổ sung hồ sơ: ' + (mission.title || '');
    const noteBlock = note ? '<p><strong>Nội dung yêu cầu bổ sung:</strong></p><p>' + note.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' : '';
    const text = 'Phòng KHCN&QHĐN đã yêu cầu bổ sung hồ sơ cho đề tài "' + (mission.title || '') + '". ' + (note ? 'Nội dung: ' + note : '') + ' Xem: ' + timelineUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã yêu cầu bổ sung hồ sơ cho đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p>' + noteBlock + '<p>Hồ sơ vẫn ở bước 2. Chủ nhiệm cần bổ sung theo yêu cầu.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình đề tài</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã gửi yêu cầu bổ sung. Email đã gửi đến Chủ nhiệm và Hội đồng.' });
});

// Bước 2 — Thư ký/Admin: Từ chối
app.post('/api/missions/:id/step2-reject', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2' });
  }
  const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : '';
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('khong_duoc_phe_duyet', id);
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề xuất không được chấp thuận: ' + (mission.title || '');
    const reasonBlock = reason ? '<p><strong>Lý do:</strong></p><p>' + reason.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' : '';
    const text = 'Phòng KHCN&QHĐN đã từ chối đề xuất "' + (mission.title || '') + '". ' + (reason ? 'Lý do: ' + reason : '') + ' Xem: ' + timelineUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã từ chối đề xuất đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p>' + reasonBlock + '<p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình đề tài</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã từ chối đề xuất. Email đã gửi đến Hội đồng.', status: 'khong_duoc_phe_duyet' });
});

// Bước 3 — CT HĐ KHCN: Submit phiếu nhận xét
app.post('/api/missions/:id/step3-submit', authMiddleware, chuTichOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, level, status, buoc3_trang_thai, buoc3_lan_xet_thu FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'cho_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài không ở trạng thái chờ xét duyệt' });
  }
  const body = req.body || {};
  const ketQua = (body.ket_qua || '').trim();
  const validKetQua = ['dong_y', 'dong_y_co_dieu_kien', 'khong_dong_y'];
  if (!validKetQua.includes(ketQua)) return res.status(400).json({ message: 'Kết luận phải là: dong_y, dong_y_co_dieu_kien, hoặc khong_dong_y' });
  const nhanXetKhoaHoc = (body.nhan_xet_khoa_hoc || '').trim();
  const nhanXetKhaThi = (body.nhan_xet_kha_thi || '').trim();
  const nhanXetDinhHuong = (body.nhan_xet_dinh_huong || '').trim();
  const nhanXetNangLuc = (body.nhan_xet_nang_luc || '').trim();
  if (!nhanXetKhoaHoc || !nhanXetKhaThi || !nhanXetDinhHuong || !nhanXetNangLuc) {
    return res.status(400).json({ message: 'Vui lòng điền đủ 4 mục nhận xét' });
  }
  if (ketQua === 'dong_y_co_dieu_kien') {
    const dieuKien = (body.dieu_kien || '').trim();
    if (!dieuKien) return res.status(400).json({ message: 'Đồng ý có điều kiện cần ghi rõ điều kiện' });
  }
  if (ketQua === 'khong_dong_y') {
    const lyDo = (body.ly_do_tu_choi || '').trim();
    if (!lyDo) return res.status(400).json({ message: 'Không đồng ý cần ghi rõ lý do' });
  }
  const now = new Date().toISOString();
  const lanXet = (mission.buoc3_lan_xet_thu || 1);
  const dieuKien = (body.dieu_kien || '').trim() || null;
  const lyDoTuChoi = (body.ly_do_tu_choi || '').trim() || null;
  const nhanXetJson = JSON.stringify({ nhan_xet_khoa_hoc: nhanXetKhoaHoc, nhan_xet_kha_thi: nhanXetKhaThi, nhan_xet_dinh_huong: nhanXetDinhHuong, nhan_xet_nang_luc: nhanXetNangLuc });
  db.prepare(`UPDATE missions SET buoc3_trang_thai = ?, buoc3_ngay_phan_hoi = ?, buoc3_nguoi_xet_duyet_id = ?, buoc3_ket_qua = ?, buoc3_dieu_kien = ?, buoc3_ly_do_tu_choi = ?, buoc3_nhan_xet_khoa_hoc = ?, buoc3_nhan_xet_kha_thi = ?, buoc3_nhan_xet_dinh_huong = ?, buoc3_nhan_xet_nang_luc = ? WHERE id = ?`).run('da_xet_duyet', now, req.user.id, ketQua, dieuKien, lyDoTuChoi, nhanXetKhoaHoc, nhanXetKhaThi, nhanXetDinhHuong, nhanXetNangLuc, id);
  db.prepare('INSERT INTO lich_su_buoc3 (mission_id, lan_xet, nguoi_xet_id, ngay_xet, ket_qua, nhan_xet_json, dieu_kien, ly_do_tu_choi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, lanXet, req.user.id, now, ketQua, nhanXetJson, dieuKien, lyDoTuChoi);
  const actor = (req.user.fullname || req.user.email || 'CT HĐ').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const ketQuaLabels = { dong_y: 'Đồng ý', dong_y_co_dieu_kien: 'Đồng ý có điều kiện', khong_dong_y: 'Không đồng ý' };
    const subject = ketQua === 'khong_dong_y' ? '[Đề tài ngoài Viện] CT HĐ yêu cầu chỉnh sửa / từ chối: ' + (mission.title || '') : '[Đề tài ngoài Viện] CT HĐ đã đồng ý — chờ xác nhận chuyển bước 4: ' + (mission.title || '');
    const html = ketQua === 'khong_dong_y'
      ? '<p>CT HĐ KHCN (' + actor + ') đã ' + (ketQuaLabels[ketQua] || ketQua) + ' đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p><p>Vui lòng xử lý.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>'
      : '<p>CT HĐ KHCN (' + actor + ') đã ' + (ketQuaLabels[ketQua] || ketQua) + ' đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p><p>Vui lòng xác nhận chuyển bước 4.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã gửi phiếu nhận xét. Email đã gửi đến Phòng KHCN.', buoc3_ket_qua: ketQua });
});

// Bước 3 — Phòng KHCN: Xác nhận chuyển bước 4A (Nhánh A)
app.post('/api/missions/:id/step3-confirm-4a', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, buoc3_trang_thai, buoc3_ket_qua, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua === 'khong_dong_y') {
    return res.status(400).json({ message: 'CT HĐ không đồng ý — không thể chuyển bước 4' });
  }
  if ((mission.nhanh || '') !== 'A') {
    return res.status(400).json({ message: 'Đề tài thuộc Nhánh B — dùng nút chuyển bước 4B' });
  }
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('buoc4a', 'hoan_thanh', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài đã được duyệt nội bộ — chuyển Bước 4A: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được duyệt nội bộ, chuyển sang <strong>Bước 4A</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 4A. Email đã gửi đến Chủ nhiệm và Hội đồng.', status: 'buoc4a' });
});

// Bước 3 — Phòng KHCN: Xác nhận chuyển bước 4B (Nhánh B)
app.post('/api/missions/:id/step3-confirm-4b', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, buoc3_trang_thai, buoc3_ket_qua, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua === 'khong_dong_y') {
    return res.status(400).json({ message: 'CT HĐ không đồng ý — không thể chuyển bước 4' });
  }
  if ((mission.nhanh || '') !== 'B') {
    return res.status(400).json({ message: 'Đề tài thuộc Nhánh A — dùng nút chuyển bước 4A' });
  }
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('buoc4b', 'hoan_thanh', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài đã được duyệt nội bộ — chuyển Bước 4B: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được duyệt nội bộ, chuyển sang <strong>Bước 4B</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 4B. Email đã gửi đến Chủ nhiệm và Hội đồng.', status: 'buoc4b' });
});

// Bước 3 — Phòng KHCN: Yêu cầu CN chỉnh sửa và nộp lại (chỉ khi lần 1)
app.post('/api/missions/:id/step3-request-revision', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, buoc3_trang_thai, buoc3_ket_qua, buoc3_lan_xet_thu FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua !== 'khong_dong_y') {
    return res.status(400).json({ message: 'Chỉ áp dụng khi CT HĐ không đồng ý' });
  }
  const lanXet = mission.buoc3_lan_xet_thu || 1;
  if (lanXet >= 2) {
    return res.status(400).json({ message: 'Đã xét lần 2 — không thể yêu cầu chỉnh sửa thêm. Dùng "Dừng hồ sơ đợt này".' });
  }
  db.prepare('UPDATE missions SET buoc3_trang_thai = ?, buoc3_lan_xet_thu = ?, buoc3_nguoi_xet_duyet_id = NULL, buoc3_ngay_phan_hoi = NULL, buoc3_ket_qua = NULL, buoc3_dieu_kien = NULL, buoc3_ly_do_tu_choi = NULL, buoc3_nhan_xet_khoa_hoc = NULL, buoc3_nhan_xet_kha_thi = NULL, buoc3_nhan_xet_dinh_huong = NULL, buoc3_nhan_xet_nang_luc = NULL WHERE id = ?').run('cho_xet_duyet', 2, id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Yêu cầu chỉnh sửa thuyết minh: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') — CT HĐ yêu cầu chỉnh sửa. Vui lòng cập nhật thuyết minh và nộp lại.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã yêu cầu CN chỉnh sửa và nộp lại. Email đã gửi.', buoc3_trang_thai: 'cho_xet_duyet' });
});

// Bước 3 — Phòng KHCN: Dừng hồ sơ đợt này
app.post('/api/missions/:id/step3-stop', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('dung_khong_dat_dot', 'tu_choi', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài dừng xét duyệt đợt này: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã dừng xét duyệt đợt này.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã dừng hồ sơ đợt này.', status: 'dung_khong_dat_dot' });
});

// Reset về Bước 3 & đổi nhánh (chỉ admin, phong_khcn)
const BUOC4_STATUSES = ['buoc4a', 'buoc4b', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_phe_duyet_ngoai'];
app.post('/api/missions/:id/reset-ve-buoc3', authMiddleware, adminOrPhongKhcn, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, nhanh, level, lan_phan_nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const { ly_do, nhanh_moi, cap_moi } = req.body || {};
  const lyDoTrim = (ly_do || '').trim();
  if (lyDoTrim.length < 20) return res.status(400).json({ message: 'Lý do thay đổi phải có ít nhất 20 ký tự' });
  if (!nhanh_moi || !['A', 'B'].includes(nhanh_moi)) return res.status(400).json({ message: 'Nhánh mới không hợp lệ' });
  if (!cap_moi || typeof cap_moi !== 'string') return res.status(400).json({ message: 'Cấp đề tài mới không hợp lệ' });
  if (BUOC4_STATUSES.indexOf(mission.status || '') < 0) {
    return res.status(403).json({ message: 'Chỉ được reset khi đề tài đang ở Bước 4. Đã có QĐ phê duyệt thì không cho reset.' });
  }
  const b5 = db.prepare('SELECT id, trang_thai FROM buoc5 WHERE mission_id = ?').get(id);
  if (b5 && (b5.trang_thai || '') === 'hoan_thanh') {
    return res.status(403).json({ message: 'Đề tài đã có QĐ phê duyệt — không cho reset.' });
  }
  const nhanhCu = mission.nhanh || 'A';
  const capCu = mission.level || '';
  const now = new Date().toISOString();
  const lanPhanNhanh = (mission.lan_phan_nhanh || 1) + 1;
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
  const buoc4Snapshot = JSON.stringify({ buoc4a: b4a || null, buoc4b: b4b || null });
  db.prepare('INSERT INTO lich_su_doi_nhanh (mission_id, nhanh_cu, nhanh_moi, cap_cu, cap_moi, ly_do, reset_boi, reset_luc, buoc4_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, nhanhCu, nhanh_moi, capCu, cap_moi, lyDoTrim, req.user.id, now, buoc4Snapshot);
  db.prepare('UPDATE missions SET nhanh = ?, level = ?, status = ?, buoc3_trang_thai = ?, buoc3_nguoi_xet_duyet_id = NULL, buoc3_ngay_phan_hoi = NULL, buoc3_ket_qua = NULL, buoc3_dieu_kien = NULL, buoc3_ly_do_tu_choi = NULL, buoc3_nhan_xet_khoa_hoc = NULL, buoc3_nhan_xet_kha_thi = NULL, buoc3_nhan_xet_dinh_huong = NULL, buoc3_nhan_xet_nang_luc = NULL, lan_phan_nhanh = ? WHERE id = ?').run(nhanh_moi, cap_moi, 'cho_ct_hd_xet_duyet', 'cho_xet_duyet', lanPhanNhanh, id);
  if (b4a) db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('da_reset', id);
  if (b4b) db.prepare('UPDATE buoc4b SET trang_thai = ? WHERE mission_id = ?').run('da_reset', id);
  db.prepare('INSERT INTO lich_su_buoc (mission_id, action, user_id, timestamp, note) VALUES (?, ?, ?, ?, ?)').run(id, 'reset_ve_buoc3', req.user.id, now, lyDoTrim);
  const nhanhLabel = nhanh_moi === 'A' ? 'Nhánh A — Bộ GD/ĐHQG/Trường' : 'Nhánh B — Nhà nước/NAFOSTED';
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const resetByName = (req.user.fullname || req.user.email || 'Admin').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const subject = '[Đề tài ngoài Viện] Đề tài được chuyển lại Bước 3 để phân nhánh lại: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> được chuyển lại Bước 3 để phân nhánh lại.</p><p><strong>Lý do:</strong> ' + lyDoTrim.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p><p><strong>Nhánh mới:</strong> ' + nhanhLabel + '</p><p>Reset bởi: ' + resetByName + '</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển lại Bước 3 và đổi nhánh.', status: 'cho_ct_hd_xet_duyet', nhanh: nhanh_moi, level: cap_moi, lan_phan_nhanh: lanPhanNhanh });
});

// ========== BƯỚC 4 NHÁNH A — Xét chọn tại Viện & gửi Bộ ==========

// Sub-bước ① — Lên lịch họp HĐ
app.post('/api/missions/:id/buoc4a/len-lich', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const { hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu } = req.body || {};
  if (!hop_ngay || !hop_hinh_thuc) return res.status(400).json({ message: 'Thiếu ngày giờ họp hoặc hình thức họp' });
  const ids = Array.isArray(thanh_phan_ids) ? thanh_phan_ids : (typeof thanh_phan_ids === 'string' ? JSON.parse(thanh_phan_ids || '[]') : []);
  if (ids.length < 2) return res.status(400).json({ message: 'Cần ít nhất 2 thành viên Hội đồng' });
  const hopDate = new Date(hop_ngay);
  const now = new Date();
  if (hopDate.getTime() - now.getTime() < 2 * 60 * 60 * 1000) return res.status(400).json({ message: 'Ngày giờ họp phải sau ít nhất 2 giờ' });
  const thanhPhanJson = JSON.stringify(ids);
  let row;
  try {
    row = db.prepare('SELECT id FROM buoc4a WHERE mission_id = ?').get(id);
  } catch (e) {
    row = null;
  }
  const nowStr = new Date().toISOString();
  if (row) {
    db.prepare('UPDATE buoc4a SET hop_trang_thai = ?, hop_ngay = ?, hop_hinh_thuc = ?, hop_dia_diem = ?, hop_link = ?, thanh_phan_ids = ?, ghi_chu = ?, updated_at = ? WHERE mission_id = ?')
      .run('da_len_lich', hop_ngay, hop_hinh_thuc || null, hop_dia_diem || null, hop_link || null, thanhPhanJson, ghi_chu || null, nowStr, id);
  } else {
    db.prepare('INSERT INTO buoc4a (mission_id, hop_trang_thai, hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'da_len_lich', hop_ngay, hop_hinh_thuc, hop_dia_diem || null, hop_link || null, thanhPhanJson, ghi_chu || null);
  }
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)')
    .run(id, '1', 'len_lich', userId, JSON.stringify({ hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Lịch họp HĐ chuyên ngành: ' + (mission.title || '');
    const hinhThuc = hop_hinh_thuc === 'offline' ? 'Offline' : hop_hinh_thuc === 'online' ? 'Online' : 'Hybrid';
    const diaDiem = hop_hinh_thuc === 'offline' ? (hop_dia_diem || '—') : (hop_link || '—');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Lịch họp HĐ chuyên ngành đã được lên.</p><p><strong>Ngày giờ:</strong> ' + hop_ngay + '</p><p><strong>Hình thức:</strong> ' + hinhThuc + '</p><p><strong>Địa điểm/Link:</strong> ' + (diaDiem || '').replace(/</g, '&lt;') + '</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lên lịch họp và gửi thông báo.', hop_trang_thai: 'da_len_lich' });
});

// Sub-bước ① — Chỉnh lịch (chỉ khi hop_ngay > now + 1 giờ)
app.patch('/api/missions/:id/buoc4a/chinh-lich', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT hop_ngay, hop_trang_thai FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hop_trang_thai || '') !== 'da_len_lich') return res.status(400).json({ message: 'Chưa lên lịch hoặc không thể chỉnh' });
  const hopDate = new Date(b4a.hop_ngay);
  if (hopDate.getTime() - Date.now() < 60 * 60 * 1000) return res.status(400).json({ message: 'Không thể chỉnh lịch khi còn dưới 1 giờ' });
  const { hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu } = req.body || {};
  const updates = []; const params = [];
  if (hop_ngay) { updates.push('hop_ngay = ?'); params.push(hop_ngay); }
  if (hop_hinh_thuc) { updates.push('hop_hinh_thuc = ?'); params.push(hop_hinh_thuc); }
  if (hop_dia_diem !== undefined) { updates.push('hop_dia_diem = ?'); params.push(hop_dia_diem || null); }
  if (hop_link !== undefined) { updates.push('hop_link = ?'); params.push(hop_link || null); }
  if (thanh_phan_ids) { const ids = Array.isArray(thanh_phan_ids) ? thanh_phan_ids : JSON.parse(thanh_phan_ids || '[]'); if (ids.length >= 2) { updates.push('thanh_phan_ids = ?'); params.push(JSON.stringify(ids)); } }
  if (ghi_chu !== undefined) { updates.push('ghi_chu = ?'); params.push(ghi_chu || null); }
  if (updates.length === 0) return res.status(400).json({ message: 'Không có thay đổi' });
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE buoc4a SET ' + updates.join(', ') + ', updated_at = ? WHERE mission_id = ?').run(...params);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '1', 'chinh_lich', userId, JSON.stringify(req.body));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Lịch họp đã thay đổi: ' + (mission.title || '');
    const html = '<p>Lịch họp HĐ chuyên ngành cho đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã được cập nhật.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã cập nhật lịch họp.' });
});

// Sub-bước ② — Kết quả họp HĐ (CT HĐ hoặc Phòng KHCN)
function chuTichOrThuyKyOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (!['admin', 'chu_tich', 'thu_ky'].includes(role)) return res.status(403).json({ message: 'Chỉ CT HĐ KHCN hoặc Phòng KHCN mới có quyền này' });
  next();
}
app.post('/api/missions/:id/buoc4a/ket-qua-hop', authMiddleware, chuTichOrThuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hop_trang_thai || '') !== 'da_len_lich') return res.status(400).json({ message: 'Chưa lên lịch họp' });
  if (b4a.hd_ket_luan) return res.status(400).json({ message: 'Đã lưu kết quả họp, không thể sửa' });
  const { ngay_hop_thuc_te, ket_luan, noi_dung_chinh_sua, han_chinh_sua, ly_do, nhan_xet, bien_ban_file_id } = req.body || {};
  if (!ket_luan || !bien_ban_file_id) return res.status(400).json({ message: 'Thiếu kết luận hoặc biên bản họp' });
  const validKetLuan = ['thong_qua', 'thong_qua_co_chinh_sua', 'khong_thong_qua'];
  if (!validKetLuan.includes(ket_luan)) return res.status(400).json({ message: 'Kết luận không hợp lệ' });
  if (ket_luan === 'thong_qua_co_chinh_sua' && (!noi_dung_chinh_sua || !han_chinh_sua)) return res.status(400).json({ message: 'Thông qua có chỉnh sửa cần nội dung và hạn' });
  if (ket_luan === 'khong_thong_qua' && !ly_do) return res.status(400).json({ message: 'Không thông qua cần lý do' });
  const ngayHop = ngay_hop_thuc_te || b4a.hop_ngay;
  db.prepare('UPDATE buoc4a SET ngay_hop_thuc_te = ?, hd_ket_luan = ?, noi_dung_chinh_sua = ?, han_chinh_sua = ?, ly_do = ?, nhan_xet = ?, bien_ban_file_id = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
    .run(ngayHop, ket_luan, noi_dung_chinh_sua || null, han_chinh_sua || null, ly_do || null, nhan_xet || null, bien_ban_file_id, 'da_hop', new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '2', 'ket_qua_hop', userId, JSON.stringify({ ket_luan }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Kết quả họp HĐ: ' + (mission.title || '');
    const kqLabel = ket_luan === 'thong_qua' ? 'Thông qua' : ket_luan === 'thong_qua_co_chinh_sua' ? 'Thông qua — yêu cầu chỉnh sửa' : 'Không thông qua';
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Kết quả họp HĐ: <strong>' + kqLabel + '</strong></p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lưu kết quả họp.', hd_ket_luan: ket_luan });
});

// Sub-bước ③ — Gửi Bộ
app.post('/api/missions/:id/buoc4a/gui-bo', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh, level FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a) return res.status(400).json({ message: 'Chưa có dữ liệu bước 4A' });
  const kl = b4a.hd_ket_luan || '';
  if (kl === 'khong_thong_qua') return res.status(400).json({ message: 'HĐ không thông qua — không thể gửi Bộ' });
  if (kl === 'thong_qua_co_chinh_sua' && !b4a.thuyet_minh_chinh_sua_ok) return res.status(400).json({ message: 'Chờ CN upload thuyết minh chỉnh sửa và Phòng KHCN xác nhận' });
  const { co_quan_nhan, danh_muc_file_id, ngay_gui, hinh_thuc_gui, nguoi_nhan, ghi_chu } = req.body || {};
  if (!co_quan_nhan || !danh_muc_file_id || !ngay_gui) return res.status(400).json({ message: 'Thiếu cơ quan nhận, file danh mục hoặc ngày gửi' });
  db.prepare('UPDATE buoc4a SET co_quan_nhan = ?, danh_muc_file_id = ?, ngay_gui = ?, hinh_thuc_gui = ?, nguoi_nhan = ?, gui_ghi_chu = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
    .run(co_quan_nhan, danh_muc_file_id, ngay_gui, hinh_thuc_gui || null, nguoi_nhan || null, ghi_chu || null, 'da_gui_bo', new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '3', 'gui_bo', userId, JSON.stringify({ co_quan_nhan, ngay_gui }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã gửi danh mục lên Bộ: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Danh mục đã gửi ' + (co_quan_nhan || '').replace(/</g, '&lt;') + ' ngày ' + ngay_gui + '.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận gửi lên Bộ.', trang_thai: 'da_gui_bo' });
});

// Sub-bước ④ — Kết quả thẩm định từ Bộ
app.post('/api/missions/:id/buoc4a/ket-qua-bo', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.trang_thai || '') !== 'da_gui_bo') return res.status(400).json({ message: 'Chưa gửi Bộ' });
  const { ngay_nhan, ket_qua, noi_dung_yc, han_yc, ly_do, van_ban_file_id, ghi_chu } = req.body || {};
  if (!ngay_nhan || !ket_qua) return res.status(400).json({ message: 'Thiếu ngày nhận hoặc kết quả' });
  const validKq = ['lot', 'yeu_cau_chinh_sua', 'khong_lot'];
  if (!validKq.includes(ket_qua)) return res.status(400).json({ message: 'Kết quả không hợp lệ' });
  if (ket_qua === 'yeu_cau_chinh_sua' && (!noi_dung_yc || !han_yc)) return res.status(400).json({ message: 'Yêu cầu chỉnh sửa cần nội dung và hạn' });
  db.prepare('UPDATE buoc4a SET ngay_nhan_ket_qua = ?, ket_qua_bo = ?, bo_noi_dung_yc = ?, bo_han_yc = ?, bo_ly_do = ?, van_ban_bo_file_id = ?, ket_qua_ghi_chu = ?, updated_at = ? WHERE mission_id = ?')
    .run(ngay_nhan, ket_qua, noi_dung_yc || null, han_yc || null, ly_do || null, van_ban_file_id || null, ghi_chu || null, new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '4', 'ket_qua_bo', userId, JSON.stringify({ ket_qua }));
  if (ket_qua === 'lot') {
    db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('lot_danh_muc', id);
  } else if (ket_qua === 'khong_lot') {
    db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('khong_lot', id);
  }
  return res.json({ success: true, message: 'Đã lưu kết quả thẩm định.', ket_qua_bo: ket_qua });
});

// Chuyển sang Bước 5 (khi lọt danh mục)
app.post('/api/missions/:id/buoc4a/chuyen-buoc5', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.ket_qua_bo || '') !== 'lot') return res.status(400).json({ message: 'Chưa lọt danh mục' });
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_phe_duyet_chinh_thuc', id);
  db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('hoan_thanh', id);
  try { db.prepare('INSERT INTO buoc5 (mission_id) VALUES (?)').run(id); } catch (e) {}
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Chuyển Bước 5: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã lọt danh mục — chuyển sang Bước 5 (Chờ phê duyệt chính thức).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã chuyển sang Bước 5.', status: 'cho_phe_duyet_chinh_thuc' });
});

// CN upload thuyết minh chỉnh sửa (khi HĐ yêu cầu)
app.post('/api/missions/:id/buoc4a/cn-upload-thuyet-minh-chinh-sua', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hd_ket_luan || '') !== 'thong_qua_co_chinh_sua') return res.status(400).json({ message: 'Không trong trạng thái yêu cầu chỉnh sửa' });
  const han = b4a.han_chinh_sua ? new Date(b4a.han_chinh_sua) : null;
  if (han && Date.now() > han.getTime()) return res.status(400).json({ message: 'Đã quá hạn nộp' });
  const { file_id } = req.body || {};
  if (!file_id) return res.status(400).json({ message: 'Thiếu file_id' });
  db.prepare('UPDATE buoc4a SET thuyet_minh_chinh_sua_ok = 1, updated_at = ? WHERE mission_id = ?').run(new Date().toISOString(), id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const mission = db.prepare('SELECT title FROM missions WHERE id = ?').get(id);
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] CN đã nộp thuyết minh chỉnh sửa: ' + (mission ? mission.title : '');
    const html = '<p>Chủ nhiệm đã upload thuyết minh chỉnh sửa. Vui lòng xác nhận để mở khóa gửi Bộ.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lưu thuyết minh chỉnh sửa.' });
});

// Phòng KHCN xác nhận thuyết minh chỉnh sửa
app.post('/api/missions/:id/buoc4a/xac-nhan-thuyet-minh-chinh-sua', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hd_ket_luan || '') !== 'thong_qua_co_chinh_sua') return res.status(400).json({ message: 'Không trong trạng thái yêu cầu chỉnh sửa' });
  db.prepare('UPDATE buoc4a SET thuyet_minh_chinh_sua_ok = 1, updated_at = ? WHERE mission_id = ?').run(new Date().toISOString(), id);
  return res.json({ success: true, message: 'Đã xác nhận. Sub-bước 3 mở khóa.' });
});

// ========== BƯỚC 4 NHÁNH B ==========
app.post('/api/missions/:id/buoc4b/nop-ho-so', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.nhanh || '') !== 'B') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh B' });
  const { co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop, ma_ho_so, ghi_chu } = req.body || {};
  if (!co_quan_nhan || !han_nop || !ngay_nop_thuc_te) return res.status(400).json({ message: 'Thiếu cơ quan nhận, hạn nộp hoặc ngày nộp thực tế' });
  let row = db.prepare('SELECT id FROM buoc4b WHERE mission_id = ?').get(id);
  const nowStr = new Date().toISOString();
  if (row) {
    db.prepare('UPDATE buoc4b SET co_quan_nhan = ?, han_nop = ?, ngay_nop_thuc_te = ?, hinh_thuc_nop = ?, ma_ho_so = ?, ghi_chu = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
      .run(co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop || null, ma_ho_so || null, ghi_chu || null, 'da_nop', nowStr, id);
  } else {
    db.prepare('INSERT INTO buoc4b (mission_id, co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop, ma_ho_so, ghi_chu, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop || null, ma_ho_so || null, ghi_chu || null, 'da_nop');
  }
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_ngoai_xet_chon', id);
  return res.json({ success: true, message: 'Đã xác nhận nộp hồ sơ.', trang_thai: 'da_nop' });
});

app.post('/api/missions/:id/buoc4b/ket-qua', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.nhanh || '') !== 'B') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh B' });
  const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
  if (!b4b || (b4b.trang_thai || '') !== 'da_nop') return res.status(400).json({ message: 'Chưa nộp hồ sơ' });
  const { ket_qua, noi_dung_yc, han_yc, ly_do, van_ban_file_id } = req.body || {};
  if (!ket_qua) return res.status(400).json({ message: 'Thiếu kết quả' });
  const validKq = ['duoc_tuyen_chon', 'yeu_cau_chinh_sua', 'khong_duoc'];
  if (!validKq.includes(ket_qua)) return res.status(400).json({ message: 'Kết quả không hợp lệ' });
  if (ket_qua === 'yeu_cau_chinh_sua' && (!noi_dung_yc || !han_yc)) return res.status(400).json({ message: 'Yêu cầu chỉnh sửa cần nội dung và hạn' });
  db.prepare('UPDATE buoc4b SET ket_qua = ?, noi_dung_yc = ?, han_yc = ?, ly_do = ?, van_ban_file_id = ?, updated_at = ? WHERE mission_id = ?')
    .run(ket_qua, noi_dung_yc || null, han_yc || null, ly_do || null, van_ban_file_id || null, new Date().toISOString(), id);
  if (ket_qua === 'duoc_tuyen_chon') {
    db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_phe_duyet_chinh_thuc', id);
    const existing = db.prepare('SELECT id FROM buoc5 WHERE mission_id = ?').get(id);
    if (!existing) db.prepare('INSERT INTO buoc5 (mission_id) VALUES (?)').run(id);
    const toList = getNotificationEmails();
    let principalEmail = null;
    const m = db.prepare('SELECT source_type, source_id FROM missions WHERE id = ?').get(id);
    if (m && m.source_type === 'cap_vien' && m.source_id) {
      const sub = db.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(m.source_id);
      if (sub && sub.submittedById) {
        const u = db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById);
        if (u && u.email) principalEmail = u.email.trim().toLowerCase();
      }
    }
    const recipients = new Set(toList.map(e => e.trim().toLowerCase()));
    if (principalEmail) recipients.add(principalEmail);
    if (transporter && recipients.size > 0) {
      const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
      const subject = '[Đề tài ngoài Viện] Đề tài được tuyển chọn — chuyển Bước 5: ' + (mission.title || '');
      const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được cơ quan ngoài tuyển chọn — chuyển sang Bước 5 (Chờ phê duyệt chính thức & hoàn chỉnh thuyết minh).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
      transporter.sendMail({ from: getSmtpFrom(), to: Array.from(recipients).join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
    }
  }
  return res.json({ success: true, message: 'Đã lưu kết quả.', ket_qua });
});

// ========== BƯỚC 5 ==========
app.post('/api/missions/:id/buoc5/upload-thuyet-minh', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, status FROM missions WHERE id = ?').get(id);
  if (!mission || !['cho_phe_duyet_chinh_thuc', 'da_phe_duyet'].includes(mission.status)) return res.status(400).json({ message: 'Đề tài không ở Bước 5' });
  const { file_id, phien_ban, ghi_chu_thay_doi } = req.body || {};
  if (!file_id) return res.status(400).json({ message: 'Thiếu file_id' });
  db.prepare('INSERT INTO buoc5_thuyet_minh_ls (mission_id, file_id, phien_ban, ghi_chu, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, file_id, phien_ban || null, ghi_chu_thay_doi || null, req.user && req.user.id);
  return res.json({ success: true, message: 'Đã lưu thuyết minh hoàn chỉnh.' });
});

app.post('/api/missions/:id/buoc5/nhan-quyet-dinh', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const { so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc, kinh_phi, thoi_gian_bd, thoi_gian_kt } = req.body || {};
  if (!so_qd || !ngay_ky || !co_quan_ky || !file_id || kinh_phi == null || !thoi_gian_bd || !thoi_gian_kt) return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  const existing = db.prepare('SELECT id FROM buoc5 WHERE mission_id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE buoc5 SET so_qd = ?, ngay_ky_qd = ?, co_quan_ky = ?, qd_file_id = ?, ma_de_tai_chinh_thuc = ?, kinh_phi = ?, thoi_gian_bd = ?, thoi_gian_kt = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
      .run(so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc || null, parseFloat(kinh_phi), thoi_gian_bd, thoi_gian_kt, 'hoan_thanh', new Date().toISOString(), id);
  } else {
    db.prepare('INSERT INTO buoc5 (mission_id, so_qd, ngay_ky_qd, co_quan_ky, qd_file_id, ma_de_tai_chinh_thuc, kinh_phi, thoi_gian_bd, thoi_gian_kt, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc || null, parseFloat(kinh_phi), thoi_gian_bd, thoi_gian_kt, 'hoan_thanh');
  }
  db.prepare('UPDATE missions SET status = ?, approved_budget = ? WHERE id = ?').run('cho_ky_hop_dong', parseFloat(kinh_phi), id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã có QĐ phê duyệt: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã được phê duyệt chính thức. Chuyển sang Bước 6 (Ký hợp đồng).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận QĐ phê duyệt. Chuyển Bước 6.', status: 'cho_ky_hop_dong' });
});

// ========== BƯỚC 6 ==========
app.post('/api/missions/:id/buoc6/ky-hop-dong', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.status || '') !== 'cho_ky_hop_dong') return res.status(400).json({ message: 'Đề tài chưa ở Bước 6' });
  const { so_hd_ngoai, ngay_ky_ngoai, gia_tri_hd, file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi_quan_ly } = req.body || {};
  if (!so_hd_ngoai || !ngay_ky_ngoai || gia_tri_hd == null || !file_hd_ngoai_id || !so_hd_noi_bo || !ngay_ky_noi_bo || !file_hd_noi_bo_id) return res.status(400).json({ message: 'Thiếu thông tin hợp đồng' });
  const phi = phi_quan_ly != null ? parseFloat(phi_quan_ly) : (parseFloat(gia_tri_hd) || 0) * 0.03;
  try {
    db.prepare('INSERT INTO buoc6 (mission_id, so_hd_ngoai, ngay_ky_ngoai, gia_tri_hd, file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi_quan_ly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, so_hd_ngoai, ngay_ky_ngoai, parseFloat(gia_tri_hd), file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi);
  } catch (e) {
    db.prepare('UPDATE buoc6 SET so_hd_ngoai = ?, ngay_ky_ngoai = ?, gia_tri_hd = ?, file_hd_ngoai_id = ?, so_hd_noi_bo = ?, ngay_ky_noi_bo = ?, file_hd_noi_bo_id = ?, phi_quan_ly = ?, updated_at = ? WHERE mission_id = ?')
      .run(so_hd_ngoai, ngay_ky_ngoai, parseFloat(gia_tri_hd), file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi, new Date().toISOString(), id);
  }
  db.prepare('UPDATE missions SET status = ?, start_date = ? WHERE id = ?').run('dang_thuc_hien', ngay_ky_ngoai, id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã ký hợp đồng — bắt đầu thực hiện: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã ký hợp đồng — bắt đầu thực hiện.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận ký hợp đồng. Đề tài bắt đầu thực hiện.', status: 'dang_thuc_hien' });
});

// Danh sách đề tài chờ CT HĐ xét duyệt (Bước 3)
app.get('/api/missions/cho-ct-hd-xet-duyet', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'chu_tich') {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng KHCN hoặc Admin mới xem được' });
  }
  const rows = db.prepare('SELECT id, code, title, principal, level, buoc3_ngay_gui, buoc3_trang_thai FROM missions WHERE status = ? AND (buoc3_trang_thai = ? OR buoc3_trang_thai IS NULL) ORDER BY buoc3_ngay_gui DESC').all('cho_ct_hd_xet_duyet', 'cho_xet_duyet');
  return res.json({ missions: rows });
});

/** Số đề tài ngoài Viện (không phải đồng bộ từ đề tài cấp Viện) đang chờ CT HĐ xét duyệt — badge sidebar Quản lý nhiệm vụ */
app.get('/api/missions/count-cho-ct-hd-ngoai-vien', authMiddleware, (req, res) => {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM missions
         WHERE status = 'cho_ct_hd_xet_duyet'
         AND (buoc3_trang_thai = 'cho_xet_duyet' OR buoc3_trang_thai IS NULL)
         AND COALESCE(TRIM(source_type), '') != 'cap_vien'`
      )
      .get();
    const n = row && row.c != null ? Number(row.c) : 0;
    return res.json({ count: Number.isFinite(n) ? n : 0 });
  } catch (e) {
    return res.json({ count: 0 });
  }
});

// Admin / Phòng KHCN: cập nhật nhiệm vụ (đề tài) — trạng thái có thể là mã chuẩn hoặc chuỗi tự do
app.put('/api/admin/missions/:id', authMiddleware, adminOrPhongKhcnMissionEditor, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài.' });
  const { code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units } = req.body || {};
  const updates = [];
  const params = [];
  if (code != null && String(code).trim()) { updates.push('code = ?'); params.push(String(code).trim()); }
  if (title != null) { updates.push('title = ?'); params.push(String(title).trim()); }
  if (principal !== undefined) { updates.push('principal = ?'); params.push(principal != null ? String(principal).trim() : null); }
  if (principal_hoc_vi !== undefined) { try { updates.push('principal_hoc_vi = ?'); params.push(principal_hoc_vi != null ? String(principal_hoc_vi).trim() : null); } catch (e) {} }
  if (principal_don_vi !== undefined) { try { updates.push('principal_don_vi = ?'); params.push(principal_don_vi != null ? String(principal_don_vi).trim() : null); } catch (e) {} }
  if (principal_orcid !== undefined) { try { updates.push('principal_orcid = ?'); params.push(principal_orcid != null ? String(principal_orcid).trim() : null); } catch (e) {} }
  if (level != null && ['national', 'ministry', 'university', 'institute'].includes(level)) { updates.push('level = ?'); params.push(level); }
  if (status != null) {
    const resolved = resolveMissionStatusInput(status);
    if (resolved) {
      updates.push('status = ?');
      params.push(resolved);
    }
  }
  if (start_date != null) { updates.push('start_date = ?'); params.push(String(start_date).trim() || null); }
  if (end_date != null) { updates.push('end_date = ?'); params.push(String(end_date).trim() || null); }
  if (progress != null && !isNaN(parseInt(progress, 10))) { updates.push('progress = ?'); params.push(Math.min(100, Math.max(0, parseInt(progress, 10)))); }
  if (budget !== undefined) { updates.push('budget = ?'); params.push(budget != null && !isNaN(parseFloat(budget)) ? parseFloat(budget) : null); }
  if (managing_agency !== undefined) { updates.push('managing_agency = ?'); params.push((managing_agency || '').trim() || null); }
  if (contract_number !== undefined) { updates.push('contract_number = ?'); params.push((contract_number || '').trim() || null); }
  if (funding_source !== undefined) { updates.push('funding_source = ?'); params.push((funding_source || '').trim() || null); }
  if (approved_budget !== undefined) { updates.push('approved_budget = ?'); params.push(approved_budget != null && !isNaN(parseFloat(approved_budget)) ? parseFloat(approved_budget) : null); }
  if (disbursed_budget !== undefined) { updates.push('disbursed_budget = ?'); params.push(disbursed_budget != null && !isNaN(parseFloat(disbursed_budget)) ? parseFloat(disbursed_budget) : null); }
  if (disbursement_year !== undefined) { updates.push('disbursement_year = ?'); params.push((disbursement_year || '').trim() || null); }
  if (cooperating_units !== undefined) { updates.push('cooperating_units = ?'); params.push((cooperating_units || '').trim() || null); }
  if (updates.length === 0) return res.status(400).json({ message: 'Không có trường nào để cập nhật.' });
  params.push(id);
  db.prepare('UPDATE missions SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget FROM missions WHERE id = ?').get(id);
  return res.json({ message: 'Đã cập nhật đề tài.', mission: updated });
});

// Master Admin: xóa nhiệm vụ — nếu đồng bộ từ cấp Viện thì xóa luôn hồ sơ + tiến trình + file trên toàn hệ thống
app.delete('/api/admin/missions/:id', authMiddleware, masterAdminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT id, code, title, source_type, source_id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài.' });
  const isCapVien = String(row.source_type || '').toLowerCase() === 'cap_vien' && row.source_id != null;
  try {
    if (isCapVien) {
      deleteCapVienSubmissionCascade(row.source_id);
    } else {
      deleteMissionCascade(id);
    }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    console.error('[admin/missions DELETE]', msg || e);
    return res.status(500).json({ message: 'Không thể xóa đề tài (lỗi cơ sở dữ liệu). ' + msg });
  }
  try {
    insertUserActivityLog(req, {
      userId: req.user.id,
      email: req.user.email,
      action: isCapVien ? 'admin_delete_cap_vien_submission_and_missions' : 'admin_delete_mission',
      module: 'missions_dashboard',
      path: '/api/admin/missions/' + id,
      detail: JSON.stringify({
        code: row.code || '',
        title: (row.title || '').slice(0, 500),
        source_type: row.source_type || null,
        source_id: row.source_id != null ? row.source_id : null,
        cascade_cap_vien: !!isCapVien,
      }),
    });
  } catch (eLog) {
    /* không chặn phản hồi */
  }
  const tail = isCapVien ? ' (đã gỡ khỏi dashboard, theo dõi tiến trình và hồ sơ cấp Viện)' : '';
  return res.json({ message: 'Đã xóa đề tài "' + (row.code || '') + '" khỏi hệ thống.' + tail, deletedId: id });
});

// CSV helper: escape field for CSV (quote if contains comma, newline or quote)
function csvEscape(s) {
  if (s == null) return '';
  const str = String(s).trim();
  if (/[,"\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// Export template CSV: dùng sep=, để Excel mở ra mỗi cột 1 ô (không dồn vào 1 ô)
app.get('/api/missions/export-template', (req, res) => {
  const header = 'code,title,principal,level,status,start_date,end_date,progress,budget';
  const note = 'GHI CHÚ (dòng này bỏ qua khi import): Mỗi dòng = 1 nhiệm vụ. Cấp: national|ministry|university|institute. Trạng thái: planning|cho_vien_xet_chon|cho_bo_tham_dinh|cho_ngoai_xet_chon|cho_phe_duyet_ngoai|da_phe_duyet|cho_ky_hop_dong|dang_thuc_hien|xin_dieu_chinh|cho_nghiem_thu_co_so|nghiem_thu_trung_gian|cho_nghiem_thu_bo_nn|nghiem_thu_tong_ket|hoan_thien_sau_nghiem_thu|thanh_ly_hop_dong|hoan_thanh|khong_duoc_phe_duyet. Ngày: YYYY-MM-DD';
  const sample1 = 'DT-2025-001,Nghiên cứu ứng dụng tế bào gốc trong điều trị,TS. Nguyễn Văn A,institute,ongoing,2025-01-15,2027-12-31,35,500000000';
  const sample2 = 'DT-2025-002,Phát triển công nghệ nuôi cấy tế bào gốc,PGS.TS. Trần Thị B,ministry,approved,2025-03-01,2026-12-31,0,2500000000';
  const sample3 = 'DT-2024-010,Xây dựng ngân hàng tế bào gốc tiêu chuẩn GMP,TS. Lê Văn C,institute,review,2024-06-01,2025-05-31,90,1500000000';
  const csv = '\uFEFFsep=,\n' + header + '\n' + csvEscape(note) + ',,,,,,,\n' + sample1 + '\n' + sample2 + '\n' + sample3 + '\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="mau_nhap_lieu_nhiem_vu_khcn.csv"');
  return res.send(csv);
});

// Export số liệu từ dashboard (Admin)
app.get('/api/missions/export', authMiddleware, adminOnly, (req, res) => {
  syncMissionsFromCapVien();
  const rows = db.prepare('SELECT code, title, principal, level, status, start_date, end_date, progress, budget FROM missions ORDER BY start_date DESC, id DESC').all();
  const header = 'code,title,principal,level,status,start_date,end_date,progress,budget';
  const lines = [header].concat(rows.map(r => [
    csvEscape(r.code),
    csvEscape(r.title),
    csvEscape(r.principal),
    csvEscape(r.level),
    csvEscape(r.status),
    csvEscape(r.start_date),
    csvEscape(r.end_date),
    r.progress != null ? r.progress : '',
    r.budget != null ? r.budget : ''
  ].join(',')));
  const csv = '\uFEFFsep=,\n' + lines.join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="so_lieu_nhiem_vu_khcn_' + new Date().toISOString().slice(0, 10) + '.csv"');
  return res.send(csv);
});

// Export Excel (.xlsx) — hỗ trợ tiếng Việt đầy đủ (không bị vỡ font)
app.get('/api/missions/export-excel', authMiddleware, adminOnly, (req, res) => {
  try {
    syncMissionsFromCapVien();
    const rows = db.prepare('SELECT code, title, principal, level, status, start_date, end_date, progress, budget FROM missions ORDER BY start_date DESC, id DESC').all();
    const data = rows.map(r => ({
      code: r.code || '',
      title: r.title || '',
      principal: r.principal || '',
      level: r.level || '',
      status: r.status || '',
      start_date: r.start_date || '',
      end_date: r.end_date || '',
      progress: r.progress != null ? r.progress : '',
      budget: r.budget != null ? r.budget : ''
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Nhiệm vụ KHCN');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = 'so_lieu_nhiem_vu_khcn_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    return res.send(buf);
  } catch (err) {
    console.error('[Export Excel]', err);
    return res.status(500).json({ message: 'Lỗi xuất Excel: ' + (err.message || 'Không xác định') });
  }
});

app.get('/api/missions/by-code/:code', (req, res) => {
  const code = (req.params.code || '').trim();
  if (!code) return res.status(400).json({ message: 'Mã đề tài không hợp lệ' });
  syncMissionsFromCapVien();
  const row = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units, mission_type, field, objectives FROM missions WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  return res.json(row);
});

app.get('/api/missions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  syncMissionsFromCapVien();
  const colsBase = 'id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units, mission_type, field, objectives, created_at, buoc3_trang_thai, buoc3_nguoi_xet_duyet_id, buoc3_ngay_gui, buoc3_ngay_phan_hoi, buoc3_ket_qua, buoc3_dieu_kien, buoc3_nhan_xet_khoa_hoc, buoc3_nhan_xet_kha_thi, buoc3_nhan_xet_dinh_huong, buoc3_nhan_xet_nang_luc, buoc3_ly_do_tu_choi, buoc3_lan_xet_thu, nhanh, lan_phan_nhanh';
  const cols = colsBase + ', principal_hoc_vi, principal_don_vi, principal_orcid';
  let row;
  try {
    row = db.prepare('SELECT ' + cols + ' FROM missions WHERE id = ?').get(id);
    if (!row && (req.query.code || '').trim()) row = db.prepare('SELECT ' + cols + ' FROM missions WHERE code = ?').get((req.query.code || '').trim());
  } catch (e) {
    row = db.prepare('SELECT ' + colsBase + ' FROM missions WHERE id = ?').get(id);
    if (!row && (req.query.code || '').trim()) row = db.prepare('SELECT ' + colsBase + ' FROM missions WHERE code = ?').get((req.query.code || '').trim());
    if (row) row.principal_hoc_vi = row.principal_don_vi = row.principal_orcid = null;
  }
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionDetail(req, row)) {
    return res.status(403).json({ message: 'Bạn không có quyền xem chi tiết đề tài này.' });
  }
  try {
    const lichSu = db.prepare('SELECT id, lan_xet, nguoi_xet_id, ngay_xet, ket_qua, nhan_xet_json, dieu_kien, ly_do_tu_choi FROM lich_su_buoc3 WHERE mission_id = ? ORDER BY lan_xet ASC').all(id);
    row.lich_su_buoc3 = lichSu.map(ls => {
      const reviewer = ls.nguoi_xet_id ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(ls.nguoi_xet_id) : null;
      return {
        lan_xet: ls.lan_xet,
        ngay_xet: ls.ngay_xet,
        nguoi_xet: reviewer ? (reviewer.fullname || reviewer.email || '') : '—',
        ket_qua: ls.ket_qua,
        nhan_xet_json: ls.nhan_xet_json,
        dieu_kien: ls.dieu_kien,
        ly_do_tu_choi: ls.ly_do_tu_choi
      };
    });
  } catch (e) {
    row.lich_su_buoc3 = [];
  }
  try {
    const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
    if (b4a) row.buoc4a = b4a;
  } catch (e) {
    row.buoc4a = null;
  }
  try {
    const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
    if (b4b) row.buoc4b = b4b;
  } catch (e) {
    row.buoc4b = null;
  }
  try {
    const b5 = db.prepare('SELECT * FROM buoc5 WHERE mission_id = ?').get(id);
    if (b5) row.buoc5 = b5;
  } catch (e) {
    row.buoc5 = null;
  }
  try {
    const tmLs = db.prepare('SELECT id, file_id, phien_ban, ghi_chu, created_at FROM buoc5_thuyet_minh_ls WHERE mission_id = ? ORDER BY created_at DESC').all(id);
    if (tmLs && tmLs.length > 0) row.buoc5_thuyet_minh_ls = tmLs;
  } catch (e) {
    row.buoc5_thuyet_minh_ls = [];
  }
  try {
    const b6 = db.prepare('SELECT * FROM buoc6 WHERE mission_id = ?').get(id);
    if (b6) row.buoc6 = b6;
  } catch (e) {
    row.buoc6 = null;
  }
  try {
    const doiNhanh = db.prepare('SELECT id, nhanh_cu, nhanh_moi, cap_cu, cap_moi, ly_do, reset_boi, reset_luc, buoc4_snapshot FROM lich_su_doi_nhanh WHERE mission_id = ? ORDER BY reset_luc DESC').all(id);
    row.lich_su_doi_nhanh = doiNhanh.map(d => {
      const u = d.reset_boi ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(d.reset_boi) : null;
      return {
        id: d.id,
        nhanh_cu: d.nhanh_cu,
        nhanh_moi: d.nhanh_moi,
        cap_cu: d.cap_cu,
        cap_moi: d.cap_moi,
        ly_do: d.ly_do,
        reset_boi: u ? (u.fullname || u.email || '') : '—',
        reset_luc: d.reset_luc,
        buoc4_snapshot: d.buoc4_snapshot
      };
    });
  } catch (e) {
    row.lich_su_doi_nhanh = [];
  }
  return res.json(row);
});

// Upload file đăng ký (Thuyết minh chi tiết, Văn bản xin phép Viện trưởng) — missions_files
app.post('/api/missions/:id/files', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
  const fieldName = (req.body.field_name || '').trim();
  const allowedFields = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong', 'buoc4a_bien_ban', 'buoc4a_danh_muc', 'buoc4a_van_ban_bo', 'buoc4a_thuyet_minh_chinh_sua', 'buoc4b_tai_lieu', 'buoc5_thuyet_minh', 'buoc5_qd_phe_duyet', 'buoc6_hd_ngoai', 'buoc6_hd_noi_bo'];
  if (!allowedFields.includes(fieldName)) return res.status(400).json({ message: 'field_name không hợp lệ' });
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  const allowedExt = ['pdf', 'doc', 'docx'];
  if (!allowedExt.includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận file PDF, Word (.doc, .docx)' });
  const destDir = path.join(uploadDir, 'missions', String(id));
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = Date.now() + '_' + (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(destDir, finalName);
  fs.copyFileSync(req.file.path, destPath);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  const relPath = path.join('missions', String(id), finalName);
  db.prepare('INSERT INTO missions_files (mission_id, field_name, original_name, path) VALUES (?, ?, ?, ?)').run(id, fieldName, req.file.originalname || finalName, relPath);
  const row = db.prepare('SELECT id, field_name, original_name, path, created_at FROM missions_files WHERE id = last_insert_rowid()').get();
  return res.status(201).json({ message: 'Đã lưu file.', file: row });
});

app.get('/api/missions/:id/ho-so-ngoai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ đề tài này.' });
  }
  const rows = db.prepare('SELECT id, original_name, path, submission_date, note, created_at FROM missions_ho_so_ngoai WHERE mission_id = ? ORDER BY submission_date DESC, created_at DESC').all(id);
  return res.json({ files: rows });
});

app.post('/api/missions/:id/ho-so-ngoai', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Chỉ Admin hoặc Chủ nhiệm đề tài mới được nộp hồ sơ.' });
  }
  if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  const allowed = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];
  if (!allowed.includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận file PDF, Word, Excel' });
  const destDir = path.join(uploadDir, 'missions', String(id));
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = Date.now() + '_' + (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(destDir, finalName);
  fs.copyFileSync(req.file.path, destPath);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  const submissionDate = (req.body.submission_date || '').trim() || null;
  const note = (req.body.note || '').trim() || null;
  const relPath = path.join('missions', String(id), finalName);
  db.prepare('INSERT INTO missions_ho_so_ngoai (mission_id, original_name, path, submission_date, note) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.file.originalname || finalName, relPath, submissionDate, note);
  const row = db.prepare('SELECT id, original_name, path, submission_date, note, created_at FROM missions_ho_so_ngoai WHERE id = last_insert_rowid()').get();
  return res.status(201).json({ message: 'Đã lưu hồ sơ nộp cơ quan ngoài', file: row });
});

app.get('/api/missions/:id/ho-so-ngoai/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ đề tài này.' });
  }
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_ho_so_ngoai WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const checked = normalizeAndCheckDownloadPath(row.path);
  if (checked.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (checked.err) return res.status(404).json({ message: 'File không tồn tại' });
  const safeName = (row.original_name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
  return res.sendFile(checked.norm);
});

// Mẫu hồ sơ đăng ký đề tài ngoài Viện — Admin upload, User download
const TEMPLATE_TYPES = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong'];
const TEMPLATE_LABELS = { thuyet_minh_chi_tiet: 'Mẫu Thuyết minh chi tiết', van_ban_xin_phep_vien_truong: 'Mẫu Văn bản xin phép Viện trưởng' };

app.get('/api/missions-templates', (req, res) => {
  const rows = db.prepare('SELECT template_type, original_name, updated_at FROM missions_templates').all();
  return res.json({ templates: rows });
});

app.get('/api/missions-templates/:type/download', authMiddleware, (req, res) => {
  const type = (req.params.type || '').trim();
  if (!TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loại mẫu không hợp lệ' });
  const row = db.prepare('SELECT template_type, original_name, path FROM missions_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'Chưa có mẫu này' });
  const templatesRoot = path.resolve(uploadDir, 'templates');
  const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
  if (!pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath)) {
    return res.status(403).json({ message: 'Đường dẫn file mẫu không hợp lệ' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
  const safeName = (row.original_name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
  return res.sendFile(fullPath);
});

app.post('/api/admin/missions-templates', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  const type = (req.body.template_type || '').trim();
  if (!TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'template_type phải là: thuyet_minh_chi_tiet hoặc van_ban_xin_phep_vien_truong' });
  if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  if (!['pdf', 'doc', 'docx'].includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận PDF, Word (.doc, .docx)' });
  const destDir = path.join(uploadDir, 'templates');
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = type + '_' + Date.now() + '.' + ext;
  const destPath = path.join(destDir, finalName);
  fs.copyFileSync(req.file.path, destPath);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  const relPath = finalName;
  db.prepare('INSERT OR REPLACE INTO missions_templates (template_type, original_name, path, updated_at) VALUES (?, ?, ?, datetime(\'now\'))').run(type, req.file.originalname || finalName, relPath);
  const row = db.prepare('SELECT template_type, original_name, updated_at FROM missions_templates WHERE template_type = ?').get(type);
  return res.status(201).json({ message: 'Đã cập nhật mẫu ' + (TEMPLATE_LABELS[type] || type), template: row });
});

// Import CSV hoặc Excel (.xlsx): cập nhật/thêm đề tài vào missions (Admin)
app.post('/api/admin/missions/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file || !req.file.path) {
    return res.status(400).json({ message: 'Vui lòng chọn file CSV hoặc Excel (.xlsx) để import.' });
  }
  const isExcel = (req.file.originalname || '').toLowerCase().endsWith('.xlsx');
  let headerCells = [];
  let dataRows = [];

  if (isExcel) {
    try {
      const buf = fs.readFileSync(req.file.path);
      const workbook = XLSX.read(buf, { type: 'buffer', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(400).json({ message: 'File Excel không có sheet nào.' });
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      if (!rawRows.length) return res.status(400).json({ message: 'File Excel trống.' });
      headerCells = (rawRows[0] || []).map(c => String(c == null ? '' : c).trim().toLowerCase());
      const startDateCol = headerCells.indexOf('start_date') >= 0 ? headerCells.indexOf('start_date') : -1;
      const endDateCol = headerCells.indexOf('end_date') >= 0 ? headerCells.indexOf('end_date') : -1;
      for (let r = 1; r < rawRows.length; r++) {
        const row = rawRows[r] || [];
        const cells = [];
        for (let c = 0; c < headerCells.length; c++) {
          const val = row[c];
          if (c === startDateCol || c === endDateCol) {
            if (typeof val === 'number' && val >= 1) {
              const d = XLSX.SSF.parse_date_code(val);
              if (d && d.y) cells.push(d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0'));
              else cells.push(String(val == null ? '' : val));
            } else cells.push(String(val == null ? '' : val));
          } else cells.push(String(val == null ? '' : val));
        }
        dataRows.push(cells);
      }
    } catch (e) {
      if (req.file.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'Không đọc được file Excel. Bạn có thể lưu lại dưới dạng CSV (UTF-8) và thử import CSV.' });
    }
  } else {
    let raw = '';
    if (fs.existsSync(req.file.path)) {
      raw = (fs.readFileSync(req.file.path, 'utf8') || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    if (!raw || raw.trim().length === 0) {
      return res.status(400).json({ message: 'File trống hoặc không đọc được.' });
    }
    let lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines[0] && lines[0].toLowerCase() === 'sep=,') lines = lines.slice(1);
    let delim = ',';
    if (lines[0] && /^sep=;/i.test(lines[0])) { lines = lines.slice(1); delim = ';'; }
    if (lines.length < 2) {
      return res.status(400).json({ message: 'File CSV cần có ít nhất dòng tiêu đề và một dòng dữ liệu.' });
    }
    const parseRow = (line) => {
      const out = [];
      let inQuoted = false, cur = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (inQuoted && line[i + 1] === '"') { cur += '"'; i++; }
          else inQuoted = !inQuoted;
        } else if (c === delim && !inQuoted) { out.push(cur.trim()); cur = ''; }
        else cur += c;
      }
      out.push(cur.trim());
      return out;
    };
    headerCells = parseRow(lines[0]).map(h => h.trim().toLowerCase());
    for (let i = 1; i < lines.length; i++) dataRows.push(parseRow(lines[i]));
  }

  const codeIdx = headerCells.indexOf('code') >= 0 ? headerCells.indexOf('code') : 0;
  const titleIdx = headerCells.indexOf('title') >= 0 ? headerCells.indexOf('title') : 1;
  const principalIdx = headerCells.indexOf('principal') >= 0 ? headerCells.indexOf('principal') : 2;
  const levelIdx = headerCells.indexOf('level') >= 0 ? headerCells.indexOf('level') : 3;
  const statusIdx = headerCells.indexOf('status') >= 0 ? headerCells.indexOf('status') : 4;
  const startIdx = headerCells.indexOf('start_date') >= 0 ? headerCells.indexOf('start_date') : 5;
  const endIdx = headerCells.indexOf('end_date') >= 0 ? headerCells.indexOf('end_date') : 6;
  const progressIdx = headerCells.indexOf('progress') >= 0 ? headerCells.indexOf('progress') : 7;
  const budgetIdx = headerCells.indexOf('budget') >= 0 ? headerCells.indexOf('budget') : 8;

  const normalizeDate = (s) => {
    if (!s || typeof s !== 'string') return null;
    const v = s.trim();
    if (!v) return null;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) return v.slice(0, 10);
    const parts = v.split(/[/\-.]/).map(p => p.trim());
    if (parts.length >= 3) {
      const a = parseInt(parts[0], 10);
      const b = parseInt(parts[1], 10);
      const c = parseInt(parts[2], 10);
      if (!isNaN(a) && !isNaN(b) && !isNaN(c) && parts[2].length >= 4) {
        let year = c;
        let month = a;
        let day = b;
        if (year < 100) year = 2000 + year;
        if (a > 12 && b <= 12) { month = b; day = a; }
        else if (b > 12 && a <= 12) { month = a; day = b; }
        month = Math.max(1, Math.min(12, month));
        day = Math.max(1, Math.min(31, day));
        return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      }
    }
    return null;
  };

  let inserted = 0;
  let updated = 0;
  const levels = ['national', 'ministry', 'university', 'institute'];
  const statuses = ['planning', 'approved', 'ongoing', 'review', 'completed', 'overdue'];
  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i];
    if (cells.length < 2) continue;
    const code = (cells[codeIdx] != null ? cells[codeIdx] : cells[0] || '').trim();
    if (!code) continue;
    if (code.length > 80 || code.indexOf('Cấp') >= 0 || code.indexOf('Trạng thái') >= 0 || code.indexOf('GHI CHÚ') >= 0) continue;
    const title = (cells[titleIdx] != null ? cells[titleIdx] : cells[1] || '').trim() || code;
    const principal = (cells[principalIdx] != null ? cells[principalIdx] : '').trim();
    let level = (cells[levelIdx] != null ? cells[levelIdx] : 'institute').trim().toLowerCase();
    if (!levels.includes(level)) level = 'institute';
    let status = (cells[statusIdx] != null ? cells[statusIdx] : 'planning').trim().toLowerCase();
    if (!statuses.includes(status)) status = 'planning';
    const start_date = normalizeDate((cells[startIdx] != null ? cells[startIdx] : '').trim());
    const end_date = normalizeDate((cells[endIdx] != null ? cells[endIdx] : '').trim());
    let progress = parseInt(cells[progressIdx], 10);
    if (isNaN(progress)) progress = 0;
    progress = Math.max(0, Math.min(100, progress));
    let budget = null;
    const b = cells[budgetIdx];
    if (b != null && b.trim() !== '') { const n = parseFloat(String(b).replace(/,/g, '.')); if (!isNaN(n)) budget = n; }
    const existing = db.prepare('SELECT id, source_type FROM missions WHERE code = ?').get(code);
    if (existing) {
      db.prepare(
        'UPDATE missions SET title=?, principal=?, level=?, status=?, start_date=?, end_date=?, progress=?, budget=? WHERE code=?'
      ).run(title, principal, level, status, start_date, end_date, progress, budget, code);
      updated++;
    } else {
      db.prepare(
        'INSERT INTO missions (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)'
      ).run(code, title, principal, level, status, start_date, end_date, progress, budget);
      inserted++;
    }
  }
  if (req.file.path && fs.existsSync(req.file.path)) try { fs.unlinkSync(req.file.path); } catch (e) {}
  return res.json({
    message: 'Import xong. Đã thêm ' + inserted + ' đề tài, cập nhật ' + updated + ' đề tài. Dashboard sẽ hiển thị số liệu mới.',
    inserted,
    updated
  });
});

// Admin: Thêm thủ công 1 đề tài vào bảng missions (upsert theo code)
app.post('/api/admin/missions/manual', authMiddleware, adminOnly, (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '').trim();
  const title = String(body.title || '').trim();
  const principal = String(body.principal || '').trim() || null;
  const level = String(body.level || '').trim().toLowerCase();
  const statusResolved = resolveMissionStatusInput(body.status != null && body.status !== '' ? body.status : 'planning');

  if (!code) return res.status(400).json({ message: 'Thiếu mã đề tài (code).' });
  if (!title) return res.status(400).json({ message: 'Thiếu tên đề tài (title).' });
  if (!['national', 'ministry', 'university', 'institute'].includes(level)) {
    return res.status(400).json({ message: 'Cấp đề tài không hợp lệ. Hãy chọn: national | ministry | university | institute.' });
  }
  if (!statusResolved) {
    return res.status(400).json({ message: 'Trạng thái không hợp lệ (quá dài hoặc ký tự không được phép).' });
  }

  const normalizeDate = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return s.slice(0, 10);
    // chấp nhận DD/MM/YYYY hoặc MM/DD/YYYY để đỡ sai khi admin nhập tay
    const parts = s.split(/[/\-.]/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) return null;
    const a = parseInt(parts[0], 10);
    const b = parseInt(parts[1], 10);
    const c = parseInt(parts[2], 10);
    if (!isNaN(a) && !isNaN(b) && !isNaN(c)) {
      const year = c;
      const month = Math.max(1, Math.min(12, a));
      const day = Math.max(1, Math.min(31, b));
      return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
    return null;
  };

  const start_date = normalizeDate(body.start_date || body.startDate || null);
  const end_date = normalizeDate(body.end_date || body.endDate || null);

  let progress = 0;
  if (body.progress != null && body.progress !== '') {
    progress = parseInt(body.progress, 10);
    if (!isNaN(progress)) progress = Math.max(0, Math.min(100, progress));
    else progress = 0;
  }

  let budget = null;
  if (body.budget != null && String(body.budget).trim() !== '') {
    const n = parseFloat(String(body.budget).replace(/,/g, '.'));
    if (!isNaN(n)) budget = n;
  }

  const existing = db.prepare('SELECT id FROM missions WHERE code = ?').get(code);
  try {
    if (existing) {
      db.prepare(
        'UPDATE missions SET title=?, principal=?, level=?, status=?, start_date=?, end_date=?, progress=?, budget=? WHERE code=?'
      ).run(title, principal, level, statusResolved, start_date, end_date, progress, budget, code);
      return res.json({ ok: true, message: 'Đã cập nhật đề tài.', id: existing.id, updated: true });
    }

    db.prepare(
      `INSERT INTO missions
        (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'manual')`
    ).run(code, title, principal, level, statusResolved, start_date, end_date, progress, budget);
    const id = db.prepare('SELECT id FROM missions WHERE code=? ORDER BY id DESC LIMIT 1').get(code).id;
    return res.status(201).json({ ok: true, message: 'Đã thêm đề tài thủ công.', id, updated: false });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi thêm thủ công: ' + (e.message || String(e)) });
  }
});

// Admin: cấu hình bật/tắt module trên trang chủ
app.get('/api/admin/homepage-modules', authMiddleware, adminOnly, (req, res) => {
  // Nếu bảng trống thì seed mặc định
  const existing = db.prepare('SELECT code, label, enabled FROM homepage_modules').all();
  if (!existing || existing.length === 0) {
    const stmt = db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)');
    db.transaction(() => {
      HOMEPAGE_MODULES_DEFAULT.forEach((m, i) => {
        stmt.run(m.code, m.label, m.enabled ? 1 : 0, i);
      });
    })();
  }
  const rows = db.prepare('SELECT code, label, enabled, sort_order FROM homepage_modules ORDER BY sort_order, code').all();
  return res.json({ modules: rows });
});

// Phải khai báo TRƯỚC /:code — nếu không PUT .../reorder bị khớp :code=reorder và chèn dòng sai vào DB
app.put('/api/admin/homepage-modules/reorder', authMiddleware, adminOnly, (req, res) => {
  const order = req.body && Array.isArray(req.body.order) ? req.body.order.map(c => String(c || '').trim()).filter(Boolean) : [];
  const expected = HOMEPAGE_MODULES_DEFAULT.map(m => m.code);
  if (order.length !== expected.length) {
    return res.status(400).json({ message: 'Danh sách thứ tự phải đủ ' + expected.length + ' module.' });
  }
  const set = new Set(order);
  if (!expected.every(c => set.has(c))) {
    return res.status(400).json({ message: 'Thứ tự module không hợp lệ (thiếu hoặc trùng mã).' });
  }
  const tx = db.transaction(() => {
    order.forEach((code, idx) => {
      const def = HOMEPAGE_MODULES_DEFAULT.find(m => m.code === code);
      const labelDefault = (def || {}).label || code;
      const en = def ? (def.enabled ? 1 : 0) : 1;
      db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)').run(code, labelDefault, en, idx);
      db.prepare('UPDATE homepage_modules SET sort_order = ? WHERE code = ?').run(idx, code);
    });
    db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_module_order', JSON.stringify(order));
  });
  tx();
  return res.json({ message: 'Đã lưu thứ tự hiển thị module trên Trang chủ.' });
});

app.put('/api/admin/homepage-modules/:code', authMiddleware, adminOnly, (req, res) => {
  const code = (req.params.code || '').trim();
  if (!code) return res.status(400).json({ message: 'Thiếu mã module' });
  if (!HOMEPAGE_MODULES_DEFAULT.some(m => m.code === code)) {
    return res.status(400).json({ message: 'Mã module không hợp lệ.' });
  }
  const enabled = req.body && typeof req.body.enabled !== 'undefined' ? !!req.body.enabled : true;
  const labelDefault = (HOMEPAGE_MODULES_DEFAULT.find(m => m.code === code) || {}).label || code;
  const maxSo = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM homepage_modules').get().m;
  const idxDefault = HOMEPAGE_MODULES_DEFAULT.findIndex(m => m.code === code);
  const sortOrder = idxDefault >= 0 ? idxDefault : maxSo + 1;
  db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)')
    .run(code, labelDefault, enabled ? 1 : 0, sortOrder);
  db.prepare('UPDATE homepage_modules SET enabled = ? WHERE code = ?').run(enabled ? 1 : 0, code);
  const row = db.prepare('SELECT code, label, enabled, sort_order FROM homepage_modules WHERE code = ?').get(code);
  return res.json({ message: 'Đã cập nhật cấu hình module.', module: row });
});

// Public: cấu hình module cho trang chủ (không cần đăng nhập)
app.get('/api/homepage-modules', (req, res) => {
  let rows = db.prepare('SELECT code, enabled, sort_order FROM homepage_modules ORDER BY sort_order, code').all();
  if (!rows || rows.length === 0) {
    rows = HOMEPAGE_MODULES_DEFAULT.map((m, i) => ({ code: m.code, enabled: m.enabled ? 1 : 0, sort_order: i }));
    return res.json({ modules: rows });
  }
  const expectedCodes = new Set(HOMEPAGE_MODULES_DEFAULT.map(m => m.code));
  const orderRow = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
  if (orderRow && orderRow.value) {
    try {
      const parsed = JSON.parse(orderRow.value);
      if (Array.isArray(parsed) && parsed.length === HOMEPAGE_MODULES_DEFAULT.length && parsed.every(c => expectedCodes.has(c))) {
        const byCode = {};
        rows.forEach(r => { byCode[r.code] = r; });
        rows = parsed.map((code, i) => {
          const r = byCode[code];
          return { code, enabled: r ? r.enabled : 1, sort_order: i };
        });
      }
    } catch (e) { /* giữ rows từ DB */ }
  }
  return res.json({ modules: rows });
});

// Tiêu chuẩn hệ thống (ISO9001...) — hiển thị trên header trang chủ; Admin có thể sửa/xóa
app.get('/api/settings/standard-label', (req, res) => {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('standard_label');
  const value = (row && row.value != null) ? String(row.value).trim() : null;
  return res.json({ label: value === '' ? '' : (value || 'ISO9001') });
});

app.get('/api/admin/settings/standard-label', authMiddleware, adminOnly, (req, res) => {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('standard_label');
  return res.json({ label: (row && row.value != null) ? String(row.value).trim() : 'ISO9001' });
});

app.put('/api/admin/settings/standard-label', authMiddleware, adminOnly, (req, res) => {
  const label = req.body && req.body.label != null ? String(req.body.label).trim() : '';
  db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('standard_label', label);
  return res.json({ message: label ? 'Đã lưu tiêu chuẩn hiển thị.' : 'Đã xóa dòng tiêu chuẩn (sẽ không hiển thị trên Trang chủ).', label: label });
});

app.post('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  try {
    db.prepare('INSERT INTO notification_recipients (email, fullname) VALUES (?, ?)').run(em, (fullname || '').trim() || null);
    const row = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'Đã thêm người nhận thông báo.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email này đã có trong danh sách.' });
    return res.status(500).json({ message: 'Lỗi thêm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  try {
    const r = db.prepare('DELETE FROM notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
    return res.json({ message: 'Đã xóa khỏi danh sách nhận thông báo.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi xóa: ' + (e.message || '') });
  }
});

// ========== Module Hợp tác quốc tế: danh sách email nhận thông báo (đề xuất đoàn ra, đoàn vào, ...) — chỉ Admin ==========
app.get('/api/admin/cooperation/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients ORDER BY id').all();
    return res.json({ recipients: rows || [] });
  } catch (e) {
    return res.json({ recipients: [] });
  }
});

app.post('/api/admin/cooperation/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname, topics, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email.' });
  const topicsVal = (topics === 'all' || (typeof topics === 'string' && topics.trim() === 'all')) ? 'all' : (Array.isArray(topics) ? topics.filter(Boolean).join(',') : (typeof topics === 'string' ? topics.trim() : 'all'));
  const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
  try {
    db.prepare('INSERT INTO cooperation_notification_recipients (email, fullname, topics, role) VALUES (?, ?, ?, ?)').run(em, (fullname || '').trim() || null, topicsVal || 'all', roleVal);
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'Đã thêm người nhận thông báo.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email này đã có trong danh sách.' });
    return res.status(500).json({ message: 'Lỗi thêm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  try {
    const r = db.prepare('DELETE FROM cooperation_notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
    return res.json({ message: 'Đã xóa khỏi danh sách nhận thông báo.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi xóa: ' + (e.message || '') });
  }
});

app.patch('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role, fullname, topics } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row0 = db.prepare('SELECT id FROM cooperation_notification_recipients WHERE id = ?').get(id);
  if (!row0) return res.status(404).json({ message: 'Không tìm thấy bản ghi.' });
  const sets = [];
  const vals = [];
  if (role !== undefined) {
  const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
    sets.push('role = ?');
    vals.push(roleVal);
  }
  if (fullname !== undefined) {
    sets.push('fullname = ?');
    vals.push((fullname && String(fullname).trim()) || null);
  }
  if (topics !== undefined) {
    let topicsVal = 'all';
    if (topics === 'all' || (typeof topics === 'string' && topics.trim().toLowerCase() === 'all')) topicsVal = 'all';
    else if (Array.isArray(topics)) topicsVal = topics.map((t) => String(t).trim().toLowerCase()).filter(Boolean).join(',') || 'all';
    else if (typeof topics === 'string') topicsVal = topics.trim() || 'all';
    sets.push('topics = ?');
    vals.push(topicsVal);
  }
  if (!sets.length) return res.status(400).json({ message: 'Không có trường nào để cập nhật (role, fullname, topics).' });
  vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_notification_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE id = ?').get(id);
    return res.json({ ok: true, message: 'Đã cập nhật.', recipient: row });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Cảnh báo thỏa thuận đã ký — trước/sau hết hạn (topic thoa_thuan_het_han)
app.get('/api/admin/cooperation/settings/thoa-thuan-expiry', authMiddleware, adminOnly, (req, res) => {
  return res.json({
    months: coopGetThoaThuanExpiryMonths(),
    post_expiry_max_emails: coopGetThoaThuanPostExpiryMaxEmails(),
    post_expiry_min_days: coopGetThoaThuanPostExpiryMinDays()
  });
});

app.put('/api/admin/cooperation/settings/thoa-thuan-expiry', authMiddleware, adminOnly, (req, res) => {
  const body = req.body || {};
  const updates = [];
  if (body.months != null) {
    const m = parseInt(body.months, 10);
    if (!Number.isFinite(m) || m < 1 || m > 36) {
      return res.status(400).json({ message: 'months phải là số từ 1 đến 36.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_expiry_alert_months', String(m));
    updates.push('months');
  }
  if (body.post_expiry_max_emails != null) {
    const n = parseInt(body.post_expiry_max_emails, 10);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      return res.status(400).json({ message: 'post_expiry_max_emails phải từ 0 (không gửi) đến 20.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_max_emails', String(n));
    updates.push('post_expiry_max_emails');
  }
  if (body.post_expiry_min_days != null) {
    const d = parseInt(body.post_expiry_min_days, 10);
    if (!Number.isFinite(d) || d < 1 || d > 90) {
      return res.status(400).json({ message: 'post_expiry_min_days phải từ 1 đến 90.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_min_days', String(d));
    updates.push('post_expiry_min_days');
  }
  if (!updates.length) {
    return res.status(400).json({ message: 'Gửi ít nhất một trường: months, post_expiry_max_emails, post_expiry_min_days.' });
  }
  try {
    return res.json({
      ok: true,
      message: 'Đã lưu cấu hình cảnh báo thỏa thuận.',
      months: coopGetThoaThuanExpiryMonths(),
      post_expiry_max_emails: coopGetThoaThuanPostExpiryMaxEmails(),
      post_expiry_min_days: coopGetThoaThuanPostExpiryMinDays()
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi lưu cấu hình.' });
  }
});

app.post('/api/admin/cooperation/thoa-thuan/run-expiry-check', authMiddleware, adminOnly, (req, res) => {
  coopRunThoaThuanExpiryAlerts()
    .then((r) => res.json({ ok: true, ...r }))
    .catch((e) => res.status(500).json({ message: e.message || String(e) }));
});

// Gửi đề xuất Thỏa thuận (MOU): lưu vào DB + gửi email tới danh sách nhận thông báo (topic mou hoặc all)
app.post('/api/cooperation/mou/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const loaiThoaThuan = (body.loai_thoa_thuan || body.loaiThoaThuan || '').trim() || '—';
  const tenDoiTac = (body.ten_doi_tac || body.tenDoiTac || '').trim() || '—';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || '—';
  const thoiHanNam = (body.thoi_han_nam != null && body.thoi_han_nam !== '') ? String(body.thoi_han_nam) : '—';
  const giaTriTaiChinh = (body.gia_tri_tai_chinh || body.giaTriTaiChinh || '').trim() || '—';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || '—';
  const noiDungHopTac = (body.noi_dung_hop_tac || body.noiDungHopTac || '').trim() || '—';
  const { to: toList, cc: ccList } = getCooperationRecipientsSplit('mou');
  const allRecipients = [...toList, ...ccList];
  if (allRecipients.length === 0) {
    return res.status(400).json({
      message: 'Chưa có email nhận thông báo đề xuất Thỏa thuận. Admin vui lòng thêm trong Quản trị Hợp tác Quốc tế → Danh sách email (chọn topic MOU).',
      sent: 0
    });
  }
  let newRowId;
  try {
    const ins = db.prepare(
      `INSERT INTO cooperation_mou_de_xuat (submitted_by_email, submitted_by_name, loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, noi_dung_hop_tac, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dang_tham_dinh')`
    ).run(submittedByEmail, submittedBy, loaiThoaThuan, tenDoiTac, quocGia, thoiHanNam, giaTriTaiChinh, donViDeXuat, noiDungHopTac);
    newRowId = ins.lastInsertRowid;
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
  }
  try {
    if (newRowId) coopAddHistory('mou', newRowId, 1, 'gui', 'Nộp đề xuất Thỏa thuận', user, null);
  } catch (e) {}
  const maDeXuatMou = newRowId ? coopGenMa('mou', newRowId) : '';
  try {
    if (newRowId && maDeXuatMou) db.prepare('UPDATE cooperation_mou_de_xuat SET ma_de_xuat=? WHERE id=?').run(maDeXuatMou, newRowId);
  } catch (e) {}
  const subject = '[Hợp tác QT] Đề xuất Thỏa thuận mới: ' + tenDoiTac + ' — ' + submittedBy;
  const textBody = 'Kính gửi Viện trưởng,\n\nPhòng KHCN&QHĐN trân trọng báo cáo: ' + submittedBy + ' (' + submittedByEmail + ') đã gửi đề xuất Thỏa thuận hợp tác quốc tế mới lên Phòng để thẩm định và trình Viện trưởng.\n\nThông tin đề xuất:\n- Mã: ' + maDeXuatMou + '\n- Loại thỏa thuận: ' + loaiThoaThuan + '\n- Đối tác: ' + tenDoiTac + '\n- Quốc gia: ' + quocGia + '\n- Thời hạn (năm): ' + thoiHanNam + '\n- Giá trị tài chính: ' + giaTriTaiChinh + '\n- Đơn vị đề xuất: ' + donViDeXuat + '\n- Nội dung hợp tác: ' + noiDungHopTac + '\n\nKính mong Viện trưởng xem xét và chỉ đạo. Phòng KHCN&QHĐN sẽ thẩm định và báo cáo chi tiết khi có kết quả.\n\nTrân trọng.';
  const htmlBody = '<p style="margin-bottom:16px;"><strong>Kính gửi Viện trưởng,</strong></p><p>Phòng KHCN&amp;QHĐN trân trọng báo cáo: <strong>' + submittedBy + '</strong> (' + submittedByEmail + ') đã gửi đề xuất Thỏa thuận hợp tác quốc tế mới lên Phòng để thẩm định và trình Viện trưởng.</p><p><strong>Thông tin đề xuất:</strong></p><table border="1" cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;"><tr style="background:#f8fafc;"><td style="font-weight:600;width:40%;">Mã đề xuất</td><td>' + maDeXuatMou + '</td></tr><tr><td style="font-weight:600;">Loại thỏa thuận</td><td>' + loaiThoaThuan + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Đối tác</td><td>' + tenDoiTac + '</td></tr><tr><td style="font-weight:600;">Quốc gia</td><td>' + quocGia + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Thời hạn (năm)</td><td>' + thoiHanNam + '</td></tr><tr><td style="font-weight:600;">Giá trị tài chính</td><td>' + giaTriTaiChinh + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Đơn vị đề xuất</td><td>' + donViDeXuat + '</td></tr><tr><td style="font-weight:600;">Nội dung hợp tác</td><td>' + noiDungHopTac.replace(/\n/g, '<br>') + '</td></tr></table><p style="margin-top:16px;">Kính mong Viện trưởng xem xét và chỉ đạo. Phòng KHCN&amp;QHĐN sẽ thẩm định và báo cáo chi tiết khi có kết quả.</p><p>Trân trọng.</p>';
  if (!transporter) {
    return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuatMou, id: newRowId || null });
  }
  const mailOpts = {
    from: getSmtpFrom(),
    to: toList.length > 0 ? toList.join(', ') : ccList[0],
    subject,
    text: textBody,
    html: htmlBody
  };
  if (ccList.length > 0 && toList.length > 0) mailOpts.cc = ccList.join(', ');
  else if (toList.length === 0 && ccList.length > 1) mailOpts.cc = ccList.slice(1).join(', ');
  transporter.sendMail(mailOpts).then(() => {
    res.json({ message: 'Đã gửi đề xuất Thỏa thuận tới Phòng KHCN&QHĐN. Email đã gửi tới Viện trưởng (Kính gửi) và CC ' + allRecipients.length + ' địa chỉ.', sent: allRecipients.length, ma_de_xuat: maDeXuatMou, id: newRowId || null });
  }).catch(err => {
    console.error('[Email] Gửi thông báo đề xuất MOU lỗi:', err.message);
    res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
  });
});

// Helper: Admin hoặc Viện trưởng (email trong cooperation_notification_recipients với role=vien_truong)
function vienTruongOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới có quyền này' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới có quyền này' });
}

// Helper: Admin, P.KHCN (users.role) hoặc Viện trưởng — dùng cho mục QUẢN LÝ
function canSeeQuanLySection(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin' || role === 'phong_khcn') return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'Chỉ Admin, Phòng KHCN hoặc Viện trưởng mới có quyền này' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'Chỉ Admin, Phòng KHCN hoặc Viện trưởng mới có quyền này' });
}

// Chi tiết đề xuất (MOU hoặc Đoàn ra) — user phải là người gửi hoặc admin/vien_truong
app.get('/api/cooperation/de-xuat-chi-tiet/:source/:id', authMiddleware, (req, res) => {
  const source = (req.params.source || '').toLowerCase();
  const id = parseInt(req.params.id, 10);
  if (!id || !['mou', 'doan_ra', 'doan_vao'].includes(source)) {
    return res.status(400).json({ message: 'Nguồn hoặc ID không hợp lệ' });
  }
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const year = new Date().getFullYear();
  try {
    if (source === 'mou') {
      const r = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'yeu_cau_bo_sung' ? 2 : 1);
      return res.json({
        source: 'mou',
        id: r.id,
        ma_de_xuat: r.ma_de_xuat || coopGenMa('mou', r.id),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        loai_thoa_thuan: r.loai_thoa_thuan,
        ten_doi_tac: r.ten_doi_tac,
        quoc_gia: r.quoc_gia,
        thoi_han_nam: r.thoi_han_nam,
        gia_tri_tai_chinh: r.gia_tri_tai_chinh,
        don_vi_de_xuat: r.don_vi_de_xuat,
        noi_dung_hop_tac: r.noi_dung_hop_tac,
        submitted_by_email: r.submitted_by_email,
        submitted_by_name: r.submitted_by_name,
        status: r.status || 'dang_tham_dinh',
        step,
        ngay_gui: (r.created_at || '').slice(0, 10),
        ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    if (source === 'doan_ra') {
      const r = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'dang_chuan_bi' ? 2 : 1);
      return res.json({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
        muc_dich: r.muc_dich,
        quoc_gia: r.quoc_gia,
        ngay_di: r.ngay_di,
        ngay_ve: r.ngay_ve,
        thanh_vien: r.thanh_vien,
        nguon_kinh_phi: r.nguon_kinh_phi,
        du_toan: r.du_toan,
        submitted_by_email: r.submitted_by_email,
        submitted_by_name: r.submitted_by_name,
        status: r.status || 'cho_phong_duyet',
        step,
        ngay_gui: (r.created_at || '').slice(0, 10),
        ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    if (source === 'doan_vao') {
      const r = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        const pk = (req.user.role || '').toLowerCase() === 'phong_khcn';
        if (!vt && !pk) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : 1);
      return res.json({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
        muc_dich: r.muc_dich,
        don_vi_de_xuat: r.don_vi_de_xuat,
        ngay_den: r.ngay_den,
        ngay_roi_di: r.ngay_roi_di,
        thanh_phan_doan: r.thanh_phan_doan,
        noi_dung_lam_viec: r.noi_dung_lam_viec,
        kinh_phi_nguon: r.kinh_phi_nguon,
        ho_tro_visa: r.ho_tro_visa,
        submitted_by_email: r.submitted_by_email,
        submitted_by_name: r.submitted_by_name,
        status: r.status || 'cho_tham_dinh',
        step,
        ngay_gui: (r.created_at || '').slice(0, 10),
        ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
  } catch (e) {
    console.error('[API] de-xuat-chi-tiet error:', e.message);
    return res.status(500).json({ message: 'Lỗi hệ thống' });
  }
  return res.status(400).json({ message: 'Nguồn không hợp lệ' });
});

// Kiểm tra user có quyền phê duyệt đề xuất (Admin hoặc Viện trưởng)
app.get('/api/cooperation/can-approve', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin') return res.json({ canApprove: true });
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.json({ canApprove: false });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    return res.json({ canApprove: !!r });
  } catch (e) {
    return res.json({ canApprove: false });
  }
});

// Số lượng đề xuất chờ P.KHCN vs Viện trưởng + quyền xem mục QUẢN LÝ (Admin, P.KHCN, Viện trưởng)
app.get('/api/cooperation/quan-ly-stats', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  const email = (req.user.email || '').trim().toLowerCase();
  let canSeeQuanLy = role === 'admin' || role === 'phong_khcn';
  if (!canSeeQuanLy && email) {
    try {
      const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
      canSeeQuanLy = !!r;
    } catch (e) {}
  }
  let choPhongKhcn = 0, choVienTruong = 0;
  if (canSeeQuanLy) {
    try {
      const m = db.prepare('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\'').get();
      let mouCount = (m && m.c) || 0;
      let doanVaoCount = 0;
      try {
        const dv = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_tham_dinh\'').get();
        doanVaoCount = (dv && dv.c) || 0;
      } catch (e) {}
      choPhongKhcn = mouCount + doanVaoCount;
      const d = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\'').get();
      const dCount = (d && d.c) || 0;
      let doanVaoVtCount = 0;
      try {
        const dv = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_ky_duyet\'').get();
        doanVaoVtCount = (dv && dv.c) || 0;
      } catch (e) {}
      let htqtCount = 0;
      try {
        const h = db.prepare('SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\')').get();
        htqtCount = (h && h.c) || 0;
      } catch (e) {}
      choVienTruong = dCount + doanVaoVtCount + htqtCount;
    } catch (e) {}
  }
  return res.json({ canSeeQuanLy, choPhongKhcn, choVienTruong });
});

// Các đề xuất chờ P.KHCN thẩm định (MOU dang_tham_dinh + Đoàn vào cho_tham_dinh) — Admin, P.KHCN, Viện trưởng
app.get('/api/cooperation/de-xuat-cho-phong-khcn', authMiddleware, canSeeQuanLySection, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    const doanVao = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of doanVao || []) {
      list.push({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
  } catch (e) {
    console.error('[API] de-xuat-cho-phong-khcn error:', e.message);
  }
  list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
  return res.json({ list });
});

// Các đề xuất chờ Viện trưởng phê duyệt (Đoàn ra cho_vt_duyet + HTQT cho_vt_phe_duyet) — Admin, Viện trưởng
app.get('/api/cooperation/de-xuat-cho-vien-truong', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\' ORDER BY created_at ASC').all();
    for (const r of doans || []) {
      list.push({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    const doanVao = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_ky_duyet\' ORDER BY created_at ASC').all();
    for (const r of doanVao || []) {
      list.push({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    addHtqtToChoDuyetList(list, year);
  } catch (e) {
    console.error('[API] de-xuat-cho-vien-truong error:', e.message);
  }
  list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
  return res.json({ list });
});

// Các đề xuất chờ duyệt — chỉ Admin và Viện trưởng (tổng hợp, giữ tương thích)
app.get('/api/cooperation/de-xuat-cho-duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\' ORDER BY created_at ASC').all();
    for (const r of doans || []) {
      list.push({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
        submitted_by: r.submitted_by_name || r.submitted_by_email,
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status
      });
    }
    addHtqtToChoDuyetList(list, year);
  } catch (e) {
    console.error('[API] de-xuat-cho-duyet error:', e.message);
  }
  list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
  return res.json({ list });
});

// Thẩm định Đoàn vào — P.KHCN / Admin (action đồng bộ với module-hoatac-quocte: duyet_len_vt | yeu_cau_bo_sung | tu_choi)
app.put('/api/cooperation/doan-vao/:id/tham-dinh', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const raw = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const action = raw === 'duyet' ? 'duyet_len_vt' : raw;
  const { note } = req.body || {};
  if (!id || !['duyet_len_vt', 'yeu_cau_bo_sung', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'Action: duyet_len_vt | yeu_cau_bo_sung | tu_choi' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet', 'cho_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chỉ xử lý được đề xuất đang chờ Phòng KHCN. Nếu đang yêu cầu bổ sung, người gửi cần nộp lại hồ sơ trước.' });
    }
    const newStatus = action === 'duyet_len_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'duyet_len_vt' ? 'Phòng KHCN thẩm định — Trình Viện trưởng' : action === 'tu_choi' ? 'Phòng KHCN từ chối' : 'Phòng KHCN yêu cầu bổ sung';
    db.prepare("UPDATE cooperation_doan_vao SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, req.user.id || null, id);
    coopAddHistory('doan_vao', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_vao', row, id, 'phong', note).catch(err => console.error('[Email tu_choi doan_vao]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${row.ma_de_xuat || coopGenMa('doan_vao', id)}] Cập nhật Đoàn vào — ${label}`,
          html: coopBuildEmail('Cập nhật Đề xuất Đoàn vào', 'Đề xuất Đoàn vào của bạn đã được Phòng KHCN&amp;QHĐN xử lý.',
            [['Mã', row.ma_de_xuat || coopGenMa('doan_vao', id)], ['Trạng thái mới', STATUS_LABELS_COOP[newStatus] || newStatus], ['Ý kiến Phòng KHCN', note || '—']], 'Trân trọng.'),
          text: `${row.ma_de_xuat} — ${label}. Ý kiến: ${note || '—'}` });
      }
    }
    if (action === 'duyet_len_vt') {
      const recip = coopGetRecipients('doan_vao');
      coopSendMail({ to: recip.to, cc: recip.cc,
        subject: `[Hợp tác QT] Trình duyệt Đoàn vào — ${row.ma_de_xuat || coopGenMa('doan_vao', id)}`,
        html: coopBuildEmail('Đề xuất Đoàn vào cần Viện trưởng phê duyệt', 'Phòng KHCN&amp;QHĐN đã thẩm định và trình Viện trưởng:',
          [['Mã', row.ma_de_xuat || coopGenMa('doan_vao', id)], ['Người gửi', row.submitted_by_name || row.submitted_by_email], ['Mục đích', row.muc_dich || '—'], ['Đơn vị', row.don_vi_de_xuat || '—'], ['Ý kiến Phòng', note || '—']],
          'Trân trọng,<br/>Phòng KHCN&QHĐN', (process.env.BASE_URL || 'http://localhost:' + PORT) + '/module-hoatac-quocte.html'),
        text: `Trình duyệt Đoàn vào ${row.ma_de_xuat}.` });
    }
    return res.json({ ok: true, message: label, status: newStatus });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Phê duyệt/Từ chối Đoàn vào — Viện trưởng hoặc Admin — cho Đoàn vào cho_ky_duyet
app.put('/api/cooperation/doan-vao/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if ((row.status || '').toLowerCase() !== 'cho_ky_duyet') {
      return res.status(400).json({ message: 'Chỉ phê duyệt được đề xuất đang chờ Viện trưởng.' });
    }
    const r = db.prepare('UPDATE cooperation_doan_vao SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateDoanVaoVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_vao] Đã phê duyệt (legacy) nhưng chưa có mẫu Word trên hệ thống — Admin cần tải mẫu Tờ trình (.docx) một lần.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_vao] Auto Word sau duyet legacy:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('doan_vao', id, 3, 'tu_choi', 'Viện trưởng không phê duyệt', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('doan_vao', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi doan_vao]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất Đoàn vào.' : 'Đã từ chối đề xuất Đoàn vào.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Thẩm định MOU — P.KHCN / Admin (đồng bộ với giao diện: duyet_len_vt → chờ Viện trưởng, không phải da_duyet)
app.put('/api/cooperation/mou/:id/tham-dinh', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const raw = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const action = raw === 'duyet' ? 'duyet_len_vt' : raw;
  const { note } = req.body || {};
  if (!id || !['duyet_len_vt', 'yeu_cau_bo_sung', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'Action: duyet_len_vt | yeu_cau_bo_sung | tu_choi' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet', 'dang_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chỉ xử lý được đề xuất đang chờ Phòng KHCN. Nếu đang yêu cầu bổ sung, người gửi cần nộp lại hồ sơ trước.' });
    }
    const newStatus = action === 'duyet_len_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'duyet_len_vt' ? 'Phòng KHCN thẩm định — Trình Viện trưởng' : action === 'tu_choi' ? 'Phòng KHCN từ chối' : 'Phòng KHCN yêu cầu bổ sung';
    db.prepare("UPDATE cooperation_mou_de_xuat SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, req.user.id || null, id);
    coopAddHistory('mou', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('mou', row, id, 'phong', note).catch(err => console.error('[Email tu_choi mou]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${row.ma_de_xuat || coopGenMa('mou', id)}] Cập nhật MOU — ${label}`,
          html: coopBuildEmail('Cập nhật Đề xuất MOU', 'Đề xuất của bạn đã được Phòng KHCN&amp;QHĐN xử lý.',
            [['Mã', row.ma_de_xuat || coopGenMa('mou', id)], ['Trạng thái mới', STATUS_LABELS_COOP[newStatus] || newStatus], ['Ý kiến Phòng KHCN', note || '—']], 'Trân trọng.'),
          text: `${row.ma_de_xuat} — ${label}. Ý kiến: ${note || '—'}` });
      }
    }
    if (action === 'duyet_len_vt') {
      const recip = coopGetRecipients('mou');
      coopSendMail({ to: recip.to, cc: recip.cc,
        subject: `[Hợp tác QT] Trình duyệt MOU — ${row.ma_de_xuat || coopGenMa('mou', id)}`,
        html: coopBuildEmail('Đề xuất MOU cần Viện trưởng phê duyệt', 'Phòng KHCN&amp;QHĐN đã thẩm định và trình Viện trưởng:',
          [['Mã', row.ma_de_xuat || coopGenMa('mou', id)], ['Người gửi', row.submitted_by_name || row.submitted_by_email], ['Đối tác', row.ten_doi_tac || '—'], ['Ý kiến Phòng', note || '—']],
          'Trân trọng,<br/>Phòng KHCN&QHĐN', (process.env.BASE_URL || 'http://localhost:' + PORT) + '/module-hoatac-quocte.html'),
        text: `Trình duyệt MOU ${row.ma_de_xuat}.` });
    }
    return res.json({ ok: true, message: label, status: newStatus });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Phê duyệt/Từ chối MOU — Admin hoặc Viện trưởng
app.put('/api/cooperation/mou/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    const r = db.prepare('UPDATE cooperation_mou_de_xuat SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateMouVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[mou] legacy duyet: chưa có mẫu Word — Admin cần tải mẫu Tờ trình (.docx) một lần.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[mou] Auto Word legacy duyet:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('mou', id, 3, 'tu_choi', 'Viện trưởng không phê duyệt', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('mou', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi mou]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất MOU.' : 'Đã từ chối đề xuất MOU.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Phê duyệt/Từ chối Đoàn ra — Admin hoặc Viện trưởng
app.put('/api/cooperation/doan-ra/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoặc action không hợp lệ. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\'), coop_reminder_last_at = NULL WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateDoanRaVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_ra] Đã phê duyệt (legacy) nhưng chưa có mẫu Word trên hệ thống — Admin cần tải mẫu Tờ trình (.docx) một lần.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_ra] Auto Word sau duyet legacy:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('doan_ra', id, 3, 'tu_choi', 'Viện trưởng không phê duyệt', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('doan_ra', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi doan_ra]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'Đã phê duyệt đề xuất Đoàn ra.' : 'Đã từ chối đề xuất Đoàn ra.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// ========== HTQT ĐỀ XUẤT YTNN (Chương VII Quy chế KHCN-ĐMST SCI 2026) ==========
function canAccessHtqtDeXuat(req, row) {
  const role = (req.user.role || '').toLowerCase();
  const email = (req.user.email || '').trim().toLowerCase();
  if (role === 'admin') return true;
  if (role === 'phong_khcn') return true;
  try {
    const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (vt) return true;
  } catch (e) {}
  if (row && row.submitted_by_email && (row.submitted_by_email || '').trim().toLowerCase() === email) return true;
  if (row && row.submitted_by_id === req.user.id) return true;
  return false;
}

function phiQuanLyTheoLoaiHinh(loaiHinh, kinhPhiVnd) {
  const k = (kinhPhiVnd || 0);
  if ((loaiHinh || '').toLowerCase() === 'hoat_dong_khcn') return { pct: 8, vnd: k * 0.08 };
  if ((loaiHinh || '').toLowerCase() === 'dich_vu_khcn') return { pct: 13, vnd: k * 0.13 };
  if ((loaiHinh || '').toLowerCase() === 'tai_tro_vien_tro') return { pct: 3, vnd: k * 0.03 };
  return { pct: 0, vnd: 0 };
}

function deNghiVtTheoLoaiHinh(loaiHinh) {
  const l = (loaiHinh || '').toLowerCase();
  if (l === 'hoat_dong_khcn') return 'Phê duyệt tiếp nhận và giao Phòng KHCN cấp mã dự án (Điều 62, 64)';
  if (l === 'tai_tro_vien_tro') return 'Xác nhận để trình Trường ĐHKHTN phê duyệt (Điều 64)';
  if (l === 'dich_vu_khcn') return 'Phê duyệt triển khai theo quy trình dịch vụ (Điều 64)';
  return 'Phê duyệt theo quy định';
}

// GET Đề xuất YTNN chi tiết — vien_truong, admin, phong_khcn, chu_nhiem
app.get('/api/htqt/de-xuat/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (!canAccessHtqtDeXuat(req, row)) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
    const files = db.prepare('SELECT id, loai_file, ten_file, duong_dan, uploaded_by_id, uploaded_at FROM htqt_de_xuat_files WHERE de_xuat_id = ? ORDER BY id').all(id);
    const history = db.prepare('SELECT id, action, performed_by_name, performed_at, note FROM htqt_de_xuat_history WHERE de_xuat_id = ? ORDER BY performed_at DESC').all(id);
    const phi = phiQuanLyTheoLoaiHinh(row.loai_hinh, row.kinh_phi_vnd);
    const coNgưỡngKinhPhi = (row.kinh_phi_vnd || 0) > 500000000;
    const coNgưỡngThoiGian = (row.thoi_gian_thang || 0) > 60;
    const filesBatBuoc = ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'];
    const filesCo = (files || []).map(f => (f.loai_file || '').toLowerCase());
    const thieuFile = filesBatBuoc.filter(loai => !filesCo.includes(loai));
    const coThieuHoSo = thieuFile.length > 0;
    const chuaPhanLoai = !row.loai_hinh || !row.loai_hinh.trim();
    const co = { NGƯỠNG_KINH_PHI: coNgưỡngKinhPhi, NGƯỠNG_THOI_GIAN: coNgưỡngThoiGian, CHUA_PHAN_LOAI: chuaPhanLoai, THIEU_HO_SO: coThieuHoSo };
    const canPheDuyet = (row.status === 'cho_vt_phe_duyet' || row.status === 'cho_vt_duyet') && !chuaPhanLoai && !coThieuHoSo;
    const deNghiVt = row.de_nghi_vt || deNghiVtTheoLoaiHinh(row.loai_hinh);
    return res.json({
      ...row,
      files: files || [],
      history: history || [],
      phi_quan_ly: phi,
      co_canh_bao: co,
      can_phe_duyet: canPheDuyet,
      de_nghi_vt: deNghiVt,
      thieu_file: thieuFile
    });
  } catch (e) {
    console.error('[API] htqt/de-xuat error:', e.message);
    return res.status(500).json({ message: 'Lỗi hệ thống' });
  }
});

// POST Phê duyệt — vien_truong hoặc admin
app.post('/api/htqt/de-xuat/:id/phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { y_kien, ngay_ky, so_van_ban } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isAdmin) {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được phê duyệt' });
    } catch (e) {
      return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được phê duyệt' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    const stl = (row.status || '').toLowerCase();
    if (stl !== 'cho_vt_phe_duyet' && stl !== 'cho_vt_duyet') return res.status(400).json({ message: 'Trạng thái không cho phép phê duyệt' });
    if (!row.loai_hinh) return res.status(400).json({ message: 'Chưa phân loại loại hình' });
    const ngayKy = (ngay_ky || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    db.prepare('UPDATE htqt_de_xuat SET status = \'da_duyet\', vt_y_kien = ?, vt_ngay_ky = ?, vt_so_van_ban = ?, vt_nguoi_ky_id = ?, vt_xu_ly_id = ?, vt_xu_ly_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .run(y_kien || null, ngayKy, so_van_ban || null, req.user.id, req.user.id, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'phe_duyet', req.user.id, req.user.fullname || req.user.email, y_kien || '');
    try {
      const gen = coopTryAutoGenerateYtnnVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[htqt legacy] Đã phê duyệt YTNN nhưng chưa có mẫu Word — Admin cần tải mẫu Tờ trình (.docx).');
      }
    } catch (e) {}
    return res.json({ message: 'Đã phê duyệt đề xuất.', status: 'da_duyet' });
  } catch (e) {
    console.error('[API] phe-duyet error:', e.message);
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// POST Yêu cầu bổ sung — vien_truong, admin
app.post('/api/htqt/de-xuat/:id/yeu-cau-bo-sung', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { noi_dung, han_bo_sung, gui_den } = req.body || {};
  if (!noi_dung || (noi_dung || '').trim().length < 20) return res.status(400).json({ message: 'Nội dung yêu cầu tối thiểu 20 ký tự' });
  if (!han_bo_sung) return res.status(400).json({ message: 'Hạn bổ sung bắt buộc' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'yeu_cau_bo_sung\', updated_at = datetime(\'now\') WHERE id = ?').run(id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'yeu_cau_bo_sung', req.user.id, req.user.fullname || req.user.email, noi_dung.trim(), JSON.stringify({ han_bo_sung, gui_den: gui_den || [] }));
    return res.json({ message: 'Đã gửi yêu cầu bổ sung.', status: 'yeu_cau_bo_sung' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// POST Không phê duyệt — vien_truong hoặc admin
app.post('/api/htqt/de-xuat/:id/khong-phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ly_do } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  if (!ly_do || (ly_do || '').trim().length < 30) return res.status(400).json({ message: 'Lý do tối thiểu 30 ký tự' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được thực hiện' });
    } catch (e) {
      return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được thực hiện' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'tu_choi\', ly_do_khong_duyet = ?, updated_at = datetime(\'now\') WHERE id = ?').run(ly_do.trim(), id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'khong_phe_duyet', req.user.id, req.user.fullname || req.user.email, ly_do.trim());
    return res.json({ message: 'Đã ghi nhận không phê duyệt.', status: 'tu_choi' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// PATCH Admin cập nhật — admin only
app.patch('/api/htqt/de-xuat/:id/admin', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ma_de_xuat, nguoi_phu_trach_id, muc_do_uu_tien, ghi_chu_noi_bo, trang_thai, loai_hinh } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  try {
    const updates = [];
    const params = [];
    if (ma_de_xuat != null) { updates.push('ma_de_xuat = ?'); params.push(ma_de_xuat); }
    if (nguoi_phu_trach_id != null) { updates.push('nguoi_phu_trach_id = ?'); params.push(nguoi_phu_trach_id); }
    if (muc_do_uu_tien != null) { updates.push('muc_do_uu_tien = ?'); params.push(muc_do_uu_tien); }
    if (ghi_chu_noi_bo != null) { updates.push('ghi_chu_noi_bo = ?'); params.push(ghi_chu_noi_bo); }
    if (trang_thai != null) { updates.push('status = ?'); params.push(trang_thai); }
    if (loai_hinh != null) { updates.push('loai_hinh = ?'); params.push(loai_hinh); }
    if (updates.length === 0) return res.status(400).json({ message: 'Không có trường nào cập nhật' });
    params.push(id);
    db.prepare('UPDATE htqt_de_xuat SET ' + updates.join(', ') + ', updated_at = datetime(\'now\') WHERE id = ?').run(...params);
    return res.json({ message: 'Đã cập nhật.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// POST Tạo đề xuất YTNN (demo / Phòng KHCN) — để có dữ liệu test
app.post('/api/htqt/de-xuat', authMiddleware, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  const year = new Date().getFullYear();
  try {
    db.prepare(`
      INSERT INTO htqt_de_xuat (ten, mo_ta, doi_tac_ten, doi_tac_quoc_gia, chu_nhiem_ten, chu_nhiem_hoc_vi, chu_nhiem_don_vi,
        ngay_bat_dau, ngay_ket_thuc, thoi_gian_thang, kinh_phi_vnd, loai_hinh, to_trinh_phong_khcn, status, ngay_tiep_nhan, han_xu_ly_vt,
        submitted_by_email, submitted_by_name, submitted_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.ten || 'Đề xuất tiếp nhận tài chính YTNN mẫu',
      body.mo_ta || 'Mô tả tóm tắt đề xuất hợp tác quốc tế.',
      body.doi_tac_ten || 'Đại học Kyoto',
      body.doi_tac_quoc_gia || 'Nhật Bản',
      body.chu_nhiem_ten || user.fullname || 'Chủ nhiệm',
      body.chu_nhiem_hoc_vi || 'TS.',
      body.chu_nhiem_don_vi || 'Phòng Lab',
      body.ngay_bat_dau || (year + '-04-01'),
      body.ngay_ket_thuc || (year + '-12-31'),
      body.thoi_gian_thang || 9,
      body.kinh_phi_vnd || 300000000,
      body.loai_hinh || 'hoat_dong_khcn',
      body.to_trinh_phong_khcn || 'Phòng KHCN&QHĐN đề nghị Viện trưởng xem xét phê duyệt đề xuất tiếp nhận tài chính YTNN theo Điều 62, 63, 64 Quy chế KHCN-ĐMST SCI 2026.',
      body.status || 'cho_vt_duyet',
      body.ngay_tiep_nhan || new Date().toISOString().slice(0, 10),
      body.han_xu_ly_vt || (() => { const d = new Date(); d.setDate(d.getDate() + 5); return d.toISOString().slice(0, 10); })(),
      user.email || '',
      user.fullname || '',
      user.id || null
    );
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    const ma = body.ma_de_xuat || ('ĐX-' + year + '-' + String(id).padStart(4, '0'));
    db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat = ? WHERE id = ?').run(ma, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'tao_moi', user.id, user.fullname || user.email, 'Tạo đề xuất');
    ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'].forEach(function(loai) {
      try {
        db.prepare('INSERT INTO htqt_de_xuat_files (de_xuat_id, loai_file, ten_file, uploaded_by_id) VALUES (?, ?, ?, ?)')
          .run(id, loai, loai.replace(/_/g, ' ') + '.pdf', user.id);
      } catch (e) {}
    });
    return res.json({ message: 'Đã tạo đề xuất.', id, ma_de_xuat: ma });
  } catch (e) {
    console.error('[API] htqt/de-xuat create error:', e.message);
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Thêm htqt_de_xuat vào danh sách chờ duyệt
function addHtqtToChoDuyetList(list, year) {
  try {
    const rows = db.prepare('SELECT id, ten, chu_nhiem_ten, loai_hinh, status, created_at, ngay_tiep_nhan FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\') ORDER BY created_at ASC').all();
    for (const r of rows || []) {
      list.push({
        source: 'htqt',
        id: r.id,
        ma_de_xuat: r.ma_de_xuat || ('ĐX-' + year + '-' + String(r.id).padStart(4, '0')),
        title: (r.ten || '—') + (r.chu_nhiem_ten ? ' — ' + r.chu_nhiem_ten : ''),
        submitted_by: r.chu_nhiem_ten || '—',
        ngay_gui: (r.ngay_tiep_nhan || r.created_at || '').slice(0, 10),
        status: r.status,
        loai_hinh: r.loai_hinh
      });
    }
  } catch (e) {}
}

// Đề xuất của tôi — danh sách đề xuất user đã gửi (MOU, Đoàn ra)
app.get('/api/cooperation/de-xuat-cua-toi', authMiddleware, (req, res) => {
  const user = req.user || {};
  const email = (user.email || '').trim().toLowerCase();
  if (!email) return res.json({ list: [], cho_duyet: 0 });
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        loai: 'mou',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'dang_tham_dinh',
        step: r.status === 'dang_tham_dinh' ? 1 : (r.status === 'da_duyet' ? 4 : 2),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    const doans = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, status, created_at FROM cooperation_doan_ra WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
    for (const r of doans || []) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      list.push({
        source: 'doan_ra',
        loai: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : '') + ' — ' + soTV + ' thành viên',
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'cho_phong_duyet',
        step: r.status === 'da_duyet' ? 4 : (r.status === 'tu_choi' ? 4 : r.status === 'dang_chuan_bi' ? 2 : 1),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'Phòng KHCN&QHĐN'
      });
    }
    try {
      const doanVao = db.prepare('SELECT id, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
      for (const r of doanVao || []) {
        const st = (r.status || 'cho_tham_dinh').toLowerCase();
        const step = st === 'da_duyet' || st === 'tu_choi' ? 4 : (st === 'cho_ky_duyet' ? 3 : 2);
        list.push({
          source: 'doan_vao',
          loai: 'doan_vao',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_tham_dinh',
          step,
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
    } catch (ev) {}
    try {
      const ytnns = db.prepare('SELECT id, ten, status, created_at, ma_de_xuat FROM htqt_de_xuat WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
      for (const r of ytnns || []) {
        list.push({
          source: 'ytnn',
          loai: 'ytnn',
          id: r.id,
          ma_de_xuat: r.ma_de_xuat || coopGenMa('ytnn', r.id),
          ten: r.ten,
          title: 'Đề tài có yếu tố nước ngoài — ' + (r.ten || '—'),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_phong_duyet',
          step: 1,
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
    } catch (ey) {}
    try {
      const uidRow = db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email);
      if (uidRow && uidRow.id != null) {
        const hn = db
          .prepare(
            `SELECT id, submission_code, conf_name, status, created_at FROM conference_registrations
             WHERE submitted_by_user_id = ? AND status != 'cancelled' ORDER BY created_at DESC`
          )
          .all(uidRow.id);
        const HN_ST = {
          draft: 'Nháp',
          submitted: 'Chờ Phòng KHCN',
          khcn_reviewing: 'Phòng đang xem xét',
          khcn_approved: 'Chờ Viện trưởng',
          director_reviewing: 'Viện trưởng đang xem xét',
          director_approved: 'Đã phê duyệt',
          director_rejected: 'Viện trưởng từ chối',
          khcn_rejected: 'Phòng KHCN từ chối',
          completed: 'Đã nộp minh chứng',
        };
        for (const r of hn || []) {
          list.push({
            source: 'hnht',
            loai: 'hnht',
            id: r.id,
            ma_de_xuat: r.submission_code || '',
            title: 'HN/HT — ' + (r.conf_name || '—'),
            ngay_gui: (r.created_at || '').slice(0, 10),
            status: r.status || 'draft',
            status_label: HN_ST[r.status] || r.status,
            step: 1,
            yeu_cau_bo_sung: null,
            han_phan_hoi: null,
            nguoi_xu_ly: 'Phòng KHCN&QHĐN',
          });
        }
      }
    } catch (eh) {}
  } catch (e) {
    console.error('[API] de-xuat-cua-toi error:', e.message);
  }
  list.sort((a, b) => (b.ngay_gui || '').localeCompare(a.ngay_gui || ''));
  const choDuyet = list.filter(function(x) {
    var s = (x.status || '').toLowerCase();
    if (x.loai === 'hnht') {
      return (
        ['submitted', 'khcn_reviewing', 'khcn_approved', 'director_reviewing', 'khcn_rejected', 'director_rejected'].indexOf(s) >= 0
      );
    }
    return ['dang_tham_dinh', 'cho_ky_duyet', 'cho_tham_dinh', 'cho_phong_duyet', 'cho_vt_duyet', 'cho_vt_phe_duyet', 'yeu_cau_bo_sung', 'cho_phan_loai'].indexOf(s) >= 0;
  }).length;
  return res.json({ list, cho_duyet: choDuyet });
});

// Gửi đề xuất Đoàn ra: lưu vào DB + gửi email tới danh sách nhận thông báo (topic doan_ra hoặc all)
app.post('/api/cooperation/doan-ra/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || '—';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || '—';
  const ngayDi = (body.ngay_di || body.ngayDi || '').trim() || '—';
  const ngayVe = (body.ngay_ve || body.ngayVe || '').trim() || '—';
  const thanhVien = (body.thanh_vien || body.thanhVien || '').trim() || '—';
  const nguonKinhPhi = (body.nguon_kinh_phi || body.nguonKinhPhi || '').trim() || '—';
  const duToan = (body.du_toan != null && body.du_toan !== '') ? String(body.du_toan) : '—';
  const toList = getCooperationRecipients('doan_ra');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'Chưa có email nhận thông báo Đoàn ra. Admin vui lòng thêm trong Quản trị module Hợp tác Quốc tế.',
      sent: 0
    });
  }
  try {
    db.prepare(
      `INSERT INTO cooperation_doan_ra (submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_phong_duyet')`
    ).run(submittedByEmail, submittedBy, mucDich, quocGia, ngayDi, ngayVe, thanhVien, nguonKinhPhi, duToan);
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
  }
  const newRowId = (db.prepare('SELECT last_insert_rowid() as id').get() || {}).id;
  try {
    if (newRowId) coopAddHistory('doan_ra', newRowId, 1, 'gui', 'Nộp đề xuất Đoàn ra', user, null);
  } catch (e) {}
  /* Phải dùng newRowId: sau coopAddHistory, last_insert_rowid() là id bảng coop_history, không phải cooperation_doan_ra → UPDATE ma sai, mã không lưu */
  const maDeXuat = newRowId ? coopGenMa('doan_ra', newRowId) : '';
  try {
    if (newRowId && maDeXuat) db.prepare('UPDATE cooperation_doan_ra SET ma_de_xuat=? WHERE id=?').run(maDeXuat, newRowId);
  } catch (e) {}
  const submittedId = newRowId || null;
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const moduleLink = baseUrl + '/module-hoatac-quocte.html';
  const recip = coopGetRecipients('doan_ra');
  let toMail = (recip.to || []).slice();
  let ccMail = (recip.cc || []).slice();
  if (toMail.length === 0 && (recip.all || []).length) {
    toMail = [recip.all[0]];
    ccMail = recip.all.slice(1);
  }
  if (toMail.length === 0 && toList.length) {
    toMail = toList.slice();
  }
  const subjectFormal = '[Hợp tác QT] Kính gửi Viện trưởng: Đề xuất đăng ký Đoàn ra công tác nước ngoài — ' + maDeXuat;
  const introFormal = 'Kính gửi <strong>Viện trưởng</strong> xem xét chỉ đạo; <strong>Phòng KHCN&amp;QHĐN</strong> và các đơn vị liên quan được CC để phối hợp thẩm định theo quy định. Đề xuất do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gửi trên Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc.';
  const htmlFormal = coopBuildEmail(
    'Thông báo đề xuất Đoàn ra công tác nước ngoài',
    introFormal,
    [['Mã đề xuất', maDeXuat], ['Mục đích', mucDich], ['Quốc gia / Địa điểm', quocGia], ['Ngày đi', ngayDi], ['Ngày về', ngayVe], ['Thành viên đoàn', thanhVien.replace(/\n/g, '<br>')], ['Nguồn kinh phí', nguonKinhPhi], ['Dự toán (VND)', duToan]],
    'Trân trọng kính gửi,<br/>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc<br/><span style="font-size:12px;color:#64748b">(Thông báo tự động từ hệ thống)</span>',
    moduleLink
  );
  const textFormal = 'Kính gửi Viện trưởng (CC Phòng KHCN&QHĐN và các địa chỉ nhận thông báo theo cấu hình),\n\n' +
    'Đề xuất đăng ký Đoàn ra công tác nước ngoài.\nMã: ' + maDeXuat + '\nNgười gửi: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
    'Mục đích: ' + mucDich + '\nQuốc gia/Địa điểm: ' + quocGia + '\nNgày đi: ' + ngayDi + '\nNgày về: ' + ngayVe + '\n' +
    'Dự toán (VND): ' + duToan + '\n\nXem chi tiết: ' + moduleLink + '\n\nTrân trọng kính gửi,\nHệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc';
  if (!transporter) {
    return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
  }
  coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
    .then(() => {
      const n = toMail.length + ccMail.length;
      res.json({ message: 'Đã gửi đề xuất Đoàn ra. Email kính gửi Viện trưởng (CC Phòng KHCN và các địa chỉ nhận thông báo theo cấu hình).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
    })
    .catch(err => {
    console.error('[Email] Gửi thông báo Đoàn ra lỗi:', err.message);
    res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
  });
});

// Gửi đề xuất Đoàn vào — đồng bộ quy trình & mã với Đoàn ra (cho_phong_duyet → thẩm định → VT)
app.post('/api/cooperation/doan-vao/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || '—';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || '—';
  const ngayDen = (body.ngay_den || body.ngayDen || '').trim() || '—';
  const ngayRoiDi = (body.ngay_roi_di || body.ngayRoiDi || '').trim() || '—';
  const thanhPhanDoan = (body.thanh_phan_doan || body.thanhPhanDoan || '').trim() || '—';
  const noiDungLamViec = (body.noi_dung_lam_viec || body.noiDungLamViec || '').trim() || '—';
  const kinhPhiNguon = (body.kinh_phi_nguon || body.kinhPhiNguon || '').trim() || '—';
  const hoTroVisa = (body.ho_tro_visa || body.hoTroVisa || '').trim() || '—';
  const toList = getCooperationRecipients('doan_vao');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'Chưa có email nhận thông báo Đoàn vào. Admin vui lòng thêm trong Quản trị Hợp tác Quốc tế → Danh sách email (chọn topic Đoàn vào).',
      sent: 0
    });
  }
  let newRowId;
  try {
    db.prepare(
      `INSERT INTO cooperation_doan_vao (submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, noi_dung_lam_viec, kinh_phi_nguon, ho_tro_visa, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_phong_duyet')`
    ).run(submittedByEmail, submittedBy, mucDich, donViDeXuat, ngayDen, ngayRoiDi, thanhPhanDoan, noiDungLamViec, kinhPhiNguon, hoTroVisa);
    newRowId = (db.prepare('SELECT last_insert_rowid() as id').get() || {}).id;
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
  }
  try {
    if (newRowId) coopAddHistory('doan_vao', newRowId, 1, 'gui', 'Nộp đề xuất Đoàn vào', user, null);
  } catch (e) {}
  const maDeXuat = newRowId ? coopGenMa('doan_vao', newRowId) : '';
  try {
    if (newRowId && maDeXuat) db.prepare('UPDATE cooperation_doan_vao SET ma_de_xuat=? WHERE id=?').run(maDeXuat, newRowId);
  } catch (e) {}
  const submittedId = newRowId || null;
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const moduleLink = baseUrl + '/module-hoatac-quocte.html';
  const recip = coopGetRecipients('doan_vao');
  let toMail = (recip.to || []).slice();
  let ccMail = (recip.cc || []).slice();
  if (toMail.length === 0 && (recip.all || []).length) {
    toMail = [recip.all[0]];
    ccMail = recip.all.slice(1);
  }
  if (toMail.length === 0 && toList.length) {
    toMail = toList.slice();
  }
  const subjectFormal = '[Hợp tác QT] Kính gửi Viện trưởng: Đề xuất tiếp nhận Đoàn vào — ' + maDeXuat;
  const introFormal = 'Kính gửi <strong>Viện trưởng</strong> xem xét chỉ đạo; <strong>Phòng KHCN&amp;QHĐN</strong> và các đơn vị liên quan được CC để phối hợp thẩm định theo quy định. Đề xuất do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gửi trên Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc.';
  const htmlFormal = coopBuildEmail(
    'Thông báo đề xuất tiếp nhận Đoàn vào (đoàn khách quốc tế)',
    introFormal,
    [['Mã đề xuất', maDeXuat], ['Mục đích', mucDich], ['Đơn vị đề xuất tiếp nhận', donViDeXuat], ['Ngày đến', ngayDen], ['Ngày rời đi', ngayRoiDi], ['Thành phần đoàn khách', thanhPhanDoan.replace(/\n/g, '<br>')], ['Nội dung làm việc', noiDungLamViec.replace(/\n/g, '<br>')], ['Kinh phí đón tiếp', kinhPhiNguon], ['Hỗ trợ visa / nhập cảnh', hoTroVisa]],
    'Trân trọng kính gửi,<br/>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc<br/><span style="font-size:12px;color:#64748b">(Thông báo tự động từ hệ thống)</span>',
    moduleLink
  );
  const textFormal = 'Kính gửi Viện trưởng (CC Phòng KHCN&QHĐN và các địa chỉ nhận thông báo theo cấu hình),\n\n' +
    'Đề xuất tiếp nhận Đoàn vào.\nMã: ' + maDeXuat + '\nNgười gửi: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
    'Mục đích: ' + mucDich + '\nĐơn vị: ' + donViDeXuat + '\nNgày đến: ' + ngayDen + '\nNgày rời: ' + ngayRoiDi + '\n' +
    'Thành phần: ' + thanhPhanDoan + '\n\nXem chi tiết: ' + moduleLink + '\n\nTrân trọng kính gửi,\nHệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc';
  if (!transporter) {
    return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
  }
  coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
    .then(() => {
      const n = toMail.length + ccMail.length;
      res.json({ message: 'Đã gửi đề xuất Đoàn vào. Email kính gửi Viện trưởng (CC Phòng KHCN và các địa chỉ nhận thông báo theo cấu hình).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
    })
    .catch(err => {
    console.error('[Email] Gửi thông báo Đoàn vào lỗi:', err.message);
    res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
  });
});

// Danh sách đề xuất Đoàn ra (dữ liệu thật, quá trình xử lý)
app.get('/api/cooperation/doan-ra', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, ma_de_xuat, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status, created_at FROM cooperation_doan_ra ORDER BY created_at DESC`
    ).all();
    return res.json({ list: rows || [] });
  } catch (e) {
    return res.json({ list: [] });
  }
});

// Danh sách đề xuất Đoàn vào (đồng bộ với bảng "đã gửi" trên giao diện — giống Đoàn ra)
app.get('/api/cooperation/doan-vao', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, ma_de_xuat, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, status, created_at FROM cooperation_doan_vao ORDER BY created_at DESC`
    ).all();
    return res.json({ list: rows || [] });
  } catch (e) {
    return res.json({ list: [] });
  }
});

// Danh sách đề xuất Thỏa thuận / MOU (giống Đoàn ra — bảng «đã gửi» trên module)
app.get('/api/cooperation/mou', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, ma_de_xuat, submitted_by_email, submitted_by_name, loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, status, created_at FROM cooperation_mou_de_xuat ORDER BY created_at DESC`
    ).all();
    return res.json({ list: rows || [] });
  } catch (e) {
    return res.json({ list: [] });
  }
});

// Admin: cập nhật trạng thái đề xuất Đoàn ra (quá trình xử lý)
app.put('/api/admin/cooperation/doan-ra/:id/status', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = (req.body && req.body.status) ? String(req.body.status).trim() : '';
  const allowed = ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung', 'cho_ky_duyet', 'dang_chuan_bi', 'da_duyet', 'tu_choi', 'ket_thuc_boi_nguoi_nop'];
  if (!id || !allowed.includes(status)) {
    return res.status(400).json({ message: 'ID hoặc trạng thái không hợp lệ. Trạng thái: cho_phong_duyet | cho_vt_duyet | yeu_cau_bo_sung | da_duyet | tu_choi | ket_thuc_boi_nguoi_nop | …' });
  }
  try {
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\'), coop_reminder_last_at = NULL WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
    if (status === 'da_duyet') {
      coopTryAutoGenerateDoanRaVanBan(id);
    }
    return res.json({ message: 'Đã cập nhật trạng thái.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
});

// Tổng quan Hợp tác Quốc tế — số liệu thật cho dashboard
app.get('/api/cooperation/overview', (req, res) => {
  try {
    const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia FROM cooperation_thoa_thuan').all();
    const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, created_at FROM cooperation_mou_de_xuat').all();
    const doanRa = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, ngay_di, ngay_ve, status, created_at FROM cooperation_doan_ra').all();
    let missions = [];
    try {
      missions = db.prepare('SELECT id, code, title, status, end_date, approved_budget, cooperating_units FROM missions').all();
    } catch (e) {}
    const mouHieuLuc = (thoaThuans || []).filter(r => (r.trang_thai || '').toLowerCase() === 'hieu_luc').length;
    const mouSapHetHan = (thoaThuans || []).filter(r => (r.trang_thai || '').toLowerCase() === 'sap_het_han').length;
    const deXuatChoDuyet = (mouDeXuats || []).length + (doanRa || []).filter(r => ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung'].includes((r.status || '').toLowerCase())).length;
    const deTaiDangChay = (missions || []).filter(m => ['ongoing', 'approved', 'implementation'].includes((m.status || '').toLowerCase())).length;
    const deTaiChoDuyet = (missions || []).filter(m => ['planning', 'submitted'].includes((m.status || '').toLowerCase())).length;
    let tongKinhPhi = 0;
    try {
      const r = db.prepare('SELECT COALESCE(SUM(approved_budget), 0) AS s FROM missions WHERE approved_budget IS NOT NULL AND approved_budget > 0').get();
      tongKinhPhi = (r && r.s) ? r.s : 0;
    } catch (e) {}
    const partnerMap = new Map();
    for (const r of thoaThuans || []) {
      const k = (r.doi_tac || '').trim().toLowerCase();
      if (k) partnerMap.set(k, true);
    }
    for (const r of mouDeXuats || []) {
      const k = (r.ten_doi_tac || '').trim().toLowerCase();
      if (k) partnerMap.set(k, true);
    }
    const countries = new Set();
    for (const r of thoaThuans || []) { if (r.quoc_gia) countries.add((r.quoc_gia || '').trim()); }
    for (const r of mouDeXuats || []) { if (r.quoc_gia) countries.add((r.quoc_gia || '').trim()); }
    const pendingItems = [];
    for (const r of (thoaThuans || []).filter(x => (x.trang_thai || '').toLowerCase() === 'sap_het_han')) {
      pendingItems.push({
        type: 'mou',
        typeLabel: 'MOU',
        title: r.ten || (r.doi_tac + ' sắp hết hạn'),
        deadline: r.het_han || '—',
        status: 'sap_het_han',
        statusLabel: 'Sắp hết hạn',
        action: 'thoathuan'
      });
    }
    for (const r of (doanRa || []).filter(x => ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung'].includes((x.status || '').toLowerCase()))) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      const st = (r.status || '').toLowerCase();
      const stLabel = st === 'cho_vt_duyet' ? 'Chờ Viện trưởng' : st === 'cho_phong_duyet' ? 'Chờ Phòng KHCN' : 'Yêu cầu bổ sung';
      pendingItems.push({
        type: 'doan_ra',
        typeLabel: 'Đoàn ra',
        title: (r.muc_dich || r.quoc_gia || 'Đoàn ra') + ' — ' + soTV + ' thành viên',
        deadline: r.ngay_di || '—',
        status: st || 'cho_phong_duyet',
        statusLabel: stLabel,
        action: 'doan-ra',
        source: 'doan_ra',
        id: r.id
      });
    }
    for (const r of mouDeXuats || []) {
      pendingItems.push({
        type: 'mou_de_xuat',
        typeLabel: 'Đề xuất MOU',
        title: 'MOU với ' + (r.ten_doi_tac || '—'),
        deadline: '—',
        status: 'dang_tham_dinh',
        statusLabel: 'Đang thẩm định',
        action: 'thoathuan',
        source: 'mou',
        id: r.id
      });
    }
    try {
      const htqtRows = db.prepare('SELECT id, ten, chu_nhiem_ten, status, han_xu_ly_vt FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\')').all();
      for (const r of htqtRows || []) {
        pendingItems.push({
          type: 'de_tai_yttn',
          typeLabel: 'Đề xuất YTNN',
          title: (r.ten || '—') + (r.chu_nhiem_ten ? ' — ' + r.chu_nhiem_ten : ''),
          deadline: r.han_xu_ly_vt || '—',
          status: r.status || 'cho_vt_duyet',
          statusLabel: 'Chờ phê duyệt',
          action: 'de-xuat-cho-duyet',
          source: 'htqt',
          id: r.id
        });
      }
    } catch (e) {}
    pendingItems.sort((a, b) => {
      if (a.deadline === '—' && b.deadline === '—') return 0;
      if (a.deadline === '—') return 1;
      if (b.deadline === '—') return -1;
      return String(a.deadline).localeCompare(String(b.deadline));
    });
    const formatTongKinhPhi = (v) => {
      if (v >= 1e9) return (v / 1e9).toFixed(1) + ' tỷ';
      if (v >= 1e6) return (v / 1e6).toFixed(0) + ' triệu';
      return v ? String(Math.round(v)) : '—';
    };
    return res.json({
      stats: {
        total_doi_tac: partnerMap.size,
        mou_hieu_luc: mouHieuLuc,
        mou_sap_het_han: mouSapHetHan,
        de_tai_dang_chay: deTaiDangChay,
        de_tai_cho_duyet: deTaiChoDuyet,
        de_xuat_cho_duyet: deXuatChoDuyet,
        tong_kinh_phi: tongKinhPhi,
        tong_kinh_phi_formatted: formatTongKinhPhi(tongKinhPhi),
        so_quoc_gia: countries.size
      },
      pending_items: pendingItems.slice(0, 10)
    });
  } catch (e) {
    console.error('[API] cooperation/overview error:', e.message);
    return res.json({
      stats: { total_doi_tac: 0, mou_hieu_luc: 0, mou_sap_het_han: 0, de_tai_dang_chay: 0, de_tai_cho_duyet: 0, de_xuat_cho_duyet: 0, tong_kinh_phi: 0, tong_kinh_phi_formatted: '—', so_quoc_gia: 0 },
      pending_items: []
    });
  }
});

/** Đối tác hợp tác — cùng logic với GET /api/cooperation/doi-tac (dùng cho trang chủ + module) */
function cooperationComputePartnerStats() {
  const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac FROM cooperation_thoa_thuan').all();
  const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status FROM cooperation_mou_de_xuat').all();
  let missions = [];
  try {
    missions = db.prepare('SELECT id, cooperating_units, status FROM missions WHERE cooperating_units IS NOT NULL AND cooperating_units != \'\'').all();
  } catch (e) { /* bảng missions có thể chưa có cột */ }
  const partnerMap = new Map();
  const normalize = (s) => (s || '').trim().toLowerCase();
  const addPartner = (name, source, extra) => {
    const key = normalize(name);
    if (!key) return;
    if (!partnerMap.has(key)) {
      partnerMap.set(key, { name: (name || '').trim(), country: '', loai_doi_tac: null, agreements: [], proposals: [], projectCount: 0 });
    }
    const p = partnerMap.get(key);
    if (source === 'thoa_thuan' && extra) {
      p.agreements.push(extra);
      if (extra.quoc_gia) p.country = extra.quoc_gia;
      if (extra.loai_doi_tac) p.loai_doi_tac = extra.loai_doi_tac;
    }
    if (source === 'mou' && extra) {
      p.proposals.push(extra);
      if (extra.quoc_gia) p.country = extra.quoc_gia;
    }
  };
  for (const r of thoaThuans || []) {
    addPartner(r.doi_tac, 'thoa_thuan', { loai: r.loai, trang_thai: r.trang_thai, het_han: r.het_han, ten: r.ten, quoc_gia: r.quoc_gia, loai_doi_tac: r.loai_doi_tac });
  }
  for (const r of mouDeXuats || []) {
    addPartner(r.ten_doi_tac, 'mou', { quoc_gia: r.quoc_gia, loai: r.loai_thoa_thuan, status: r.status });
  }
  for (const p of partnerMap.values()) {
    const name = (p.name || '').toLowerCase();
    for (const m of missions) {
      const cu = (m.cooperating_units || '').toLowerCase();
      if (cu && name && (cu.includes(name) || name.split(/\s+/).some(w => w.length > 3 && cu.includes(w)))) {
        p.projectCount++;
      }
    }
  }
  const partners = Array.from(partnerMap.values()).map(p => ({
    name: p.name,
    country: p.country,
    loai_doi_tac: p.loai_doi_tac,
    agreements: p.agreements,
    proposals: p.proposals,
    projectCount: p.projectCount,
    bestAgreementStatus: p.agreements.length ? (p.agreements.find(a => a.trang_thai === 'hieu_luc') ? 'hieu_luc' : p.agreements.find(a => a.trang_thai === 'sap_het_han') ? 'sap_het_han' : p.agreements[0].trang_thai) : null,
    bestAgreementLoai: p.agreements.length ? p.agreements[0].loai : null,
    hasProposal: p.proposals.length > 0
  })).sort((a, b) => (b.agreements.length + b.proposals.length + b.projectCount) - (a.agreements.length + a.proposals.length + a.projectCount));
  const inferLoai = (p) => {
    if (p.loai_doi_tac) return p.loai_doi_tac;
    const q = (p.country || '').toLowerCase();
    if (q.includes('việt nam') || q.includes('viet nam') || q.includes('vn')) return 'trong_nuoc';
    return 'quoc_te';
  };
  const stats = {
    quoc_te: partners.filter(p => inferLoai(p) === 'quoc_te').length,
    trong_nuoc: partners.filter(p => inferLoai(p) === 'trong_nuoc').length,
    doanh_nghiep: partners.filter(p => inferLoai(p) === 'doanh_nghiep').length,
    dia_phuong: partners.filter(p => inferLoai(p) === 'dia_phuong').length
  };
  const countries = new Set(partners.map(p => (p.country || '').trim()).filter(Boolean));
  return { partners, stats: { ...stats, so_quoc_gia: countries.size }, total: partners.length };
}

// Danh sách Đối tác Quốc tế — tổng hợp từ thỏa thuận, đề xuất MOU, dự án (missions)
app.get('/api/cooperation/doi-tac', (req, res) => {
  try {
    const { partners, stats, total } = cooperationComputePartnerStats();
    return res.json({ partners, stats, total });
  } catch (e) {
    console.error('[API] cooperation/doi-tac error:', e.message);
    return res.json({ partners: [], stats: { quoc_te: 0, trong_nuoc: 0, doanh_nghiep: 0, dia_phuong: 0, so_quoc_gia: 0 }, total: 0 });
  }
});

/** Form field / JSON: treat common truthy strings as true (multipart sends strings). */
function thoaThuanParseOpenEndedFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on' || s === 'yes';
}

function thoaThuanAutoStatusByExpiry(hetHanText) {
  const s = String(hetHanText || '').trim();
  if (!s) return 'hieu_luc';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return 'hieu_luc';
  const exp = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(exp.getTime())) return 'hieu_luc';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const plus3 = new Date(today.getTime()); plus3.setMonth(plus3.getMonth() + 3);
  if (exp < today) return 'het_han';
  if (exp <= plus3) return 'sap_het_han';
  return 'hieu_luc';
}

/** Expiry = signing date + N calendar years (same month/day; JS normalizes leap years). Returns YYYY-MM-DD or null. */
function thoaThuanHetHanFromSigningYears(ngayKyText, yearsNum) {
  const s = String(ngayKyText || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const years = parseInt(String(yearsNum).trim(), 10);
  if (!Number.isFinite(years) || years < 1 || years > 99) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  dt.setFullYear(dt.getFullYear() + years);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Danh sách Thỏa thuận (MOU, MOA, HĐ KH&CN, LOI)
app.get('/api/cooperation/thoa-thuan', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at,
              no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
       FROM cooperation_thoa_thuan ORDER BY trang_thai ASC, het_han ASC, id DESC`
    ).all();
    return res.json({ list: rows || [] });
  } catch (e) {
    return res.json({ list: [] });
  }
});

app.get('/api/cooperation/thoa-thuan/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  try {
    const row = db.prepare(
      `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
              no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
       FROM cooperation_thoa_thuan WHERE id = ?`
    ).get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
    return res.json({ ok: true, item: row });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + e.message });
  }
});


// Admin / P.KHCN: xóa thỏa thuận
app.delete('/api/admin/cooperation/thoa-thuan/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  try {
    const r = db.prepare('DELETE FROM cooperation_thoa_thuan WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy.' });
    return res.json({ ok: true, message: 'Đã xóa thỏa thuận.' });
  } catch(e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

// P.KHCN / Admin: sửa thỏa thuận (staff notes, open-ended flag, core fields)
app.put('/api/admin/cooperation/thoa-thuan/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  let prev;
  try {
    prev = db.prepare('SELECT * FROM cooperation_thoa_thuan WHERE id=?').get(id);
  } catch (e) {}
  if (!prev) return res.status(404).json({ message: 'Không tìm thấy.' });
  const sets = [];
  const vals = [];
  const allowed = ['ten', 'doi_tac', 'loai', 'trang_thai', 'quoc_gia', 'loai_doi_tac', 'staff_notes'];
  for (const k of allowed) {
    if (body[k] !== undefined) {
      sets.push(`${k}=?`);
      vals.push(body[k]);
    }
  }
  if (body.no_fixed_term !== undefined) {
    const wantOpen = thoaThuanParseOpenEndedFlag(body.no_fixed_term);
    if (wantOpen) {
      if (String(prev.terminated_at || '').trim()) {
        return res.status(400).json({ message: 'Đã ghi nhận kết thúc; không thể chuyển lại sang không thời hạn cố định qua form này.' });
      }
      sets.push('no_fixed_term=1');
      sets.push('het_han=NULL');
      sets.push('trang_thai=?');
      vals.push('hieu_luc');
      sets.push('expiry_alert_sent_at=NULL');
      sets.push('post_expiry_alert_count=0');
      sets.push('last_post_expiry_alert_at=NULL');
    } else {
      sets.push('no_fixed_term=0');
      const newH = body.het_han !== undefined ? String(body.het_han || '').trim() : String(prev.het_han || '').trim();
      if (!newH) {
        return res.status(400).json({ message: 'Thời hạn cố định cần có ngày hết hiệu lực (het_han, YYYY-MM-DD).' });
      }
      sets.push('het_han=?');
      vals.push(newH);
      const oldH = String(prev.het_han || '').trim();
      if (newH !== oldH) {
        sets.push('trang_thai=?');
        vals.push(thoaThuanAutoStatusByExpiry(newH));
        sets.push('expiry_alert_sent_at=NULL');
        sets.push('post_expiry_alert_count=0');
        sets.push('last_post_expiry_alert_at=NULL');
      }
    }
  } else if (body.het_han !== undefined) {
    const newH = String(body.het_han || '').trim() || null;
    const oldH = String(prev.het_han || '').trim() || '';
    const newS = newH || '';
    if (newS !== oldH) {
      sets.push('het_han=?');
      vals.push(newH);
      sets.push('trang_thai=?');
      vals.push(thoaThuanAutoStatusByExpiry(newH));
      sets.push('expiry_alert_sent_at=NULL');
      sets.push('post_expiry_alert_count=0');
      sets.push('last_post_expiry_alert_at=NULL');
      if (newH) sets.push('no_fixed_term=0');
    }
  }
  if (!sets.length) return res.status(400).json({ message: 'Không có gì cập nhật.' });
  sets.push("updated_at=datetime('now','localtime')");
  vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_thoa_thuan SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    return res.json({ ok: true, message: 'Đã cập nhật.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + e.message });
  }
});

// P.KHCN/Admin: thêm thỏa thuận + upload scan
app.post('/api/cooperation/thoa-thuan', authMiddleware, coopPhongOrAdmin, (req, res) => {
  uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload file thất bại' });
    const { ten, doi_tac, loai, het_han, ngay_ky, thoi_han_nam, quoc_gia, loai_doi_tac, staff_notes } = req.body || {};
    const tenTrim = (ten || '').trim();
    const doiTacTrim = (doi_tac || '').trim();
    const loaiTrim = (loai || '').trim();
    if (!tenTrim || !doiTacTrim || !loaiTrim) {
      return res.status(400).json({ message: 'Thiếu Tên thỏa thuận, Đối tác hoặc Loại' });
    }
    const noFixedTerm = thoaThuanParseOpenEndedFlag(req.body && req.body.no_fixed_term);
    const staffNotesVal = String(staff_notes || '').trim() || null;
    const nk = String(ngay_ky || '').trim();
    const thnRaw = String(thoi_han_nam != null ? thoi_han_nam : '').trim();
    const thn = parseInt(thnRaw, 10);
    let hetHanVal = null;
    let noFixedTermInt = 0;
    if (noFixedTerm) {
      if (!nk) {
        return res.status(400).json({ message: 'Vui lòng nhập Ngày ký (thời hạn không cố định vẫn cần ngày ký để hồ sơ).' });
      }
      hetHanVal = null;
      noFixedTermInt = 1;
    } else {
      if (nk && thnRaw !== '' && Number.isFinite(thn)) {
        const computed = thoaThuanHetHanFromSigningYears(nk, thn);
        if (!computed) {
          return res.status(400).json({ message: 'Ngày ký hoặc thời hạn hiệu lực (năm) không hợp lệ.' });
        }
        hetHanVal = computed;
      } else {
        hetHanVal = (het_han || '').trim() || null;
      }
      if (!hetHanVal) {
        return res.status(400).json({ message: 'Vui lòng nhập Ngày ký và Thời hạn hiệu lực (năm), hoặc chọn Không có thời hạn cố định.' });
      }
    }
    const trangThai = noFixedTerm ? 'hieu_luc' : thoaThuanAutoStatusByExpiry(hetHanVal);
    const quocGiaVal = (quoc_gia || '').trim() || null;
    const loaiValDt = ['quoc_te', 'trong_nuoc', 'doanh_nghiep', 'dia_phuong'].includes((loai_doi_tac || '').trim()) ? loai_doi_tac.trim() : null;
    const scanPath = req.file ? path.join('uploads', 'htqt-thoa-thuan', req.file.filename).replace(/\\/g, '/') : null;
    const scanName = req.file ? (req.file.originalname || req.file.filename) : null;
    try {
      db.prepare(
        `INSERT INTO cooperation_thoa_thuan (ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, no_fixed_term, staff_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        tenTrim, doiTacTrim, loaiTrim, hetHanVal, trangThai, quocGiaVal, loaiValDt, scanPath, scanName,
        scanPath ? new Date().toISOString() : null, noFixedTermInt, staffNotesVal
      );
      const row = db.prepare(
        `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at,
                no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
         FROM cooperation_thoa_thuan WHERE id = last_insert_rowid()`
      ).get();
      return res.status(201).json({ message: 'Đã thêm thỏa thuận.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });
});

// P.KHCN / Admin: record agreement termination date + optional termination document
app.post('/api/cooperation/thoa-thuan/:id/terminate', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  uploadHtqtThoaThuanTermination.single('termination_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload termination file failed' });
    const termRaw = String((req.body && req.body.terminated_at) || '').trim();
    if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(termRaw)) {
      return res.status(400).json({ message: 'Vui lòng nhập ngày kết thúc (YYYY-MM-DD).' });
    }
    let prev;
    try {
      prev = db.prepare(
        'SELECT id, termination_scan_path, termination_scan_name, termination_uploaded_at FROM cooperation_thoa_thuan WHERE id = ?'
      ).get(id);
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
    if (!prev) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
    const termPath = req.file ? path.join('uploads', 'htqt-thoa-thuan', req.file.filename).replace(/\\/g, '/') : null;
    const termName = req.file ? (req.file.originalname || req.file.filename) : null;
    const termUploaded = req.file ? new Date().toISOString() : null;
    const finalPath = termPath || prev.termination_scan_path || null;
    const finalName = termName || prev.termination_scan_name || null;
    const finalUploaded = termUploaded || (finalPath && prev.termination_uploaded_at) || (finalPath ? new Date().toISOString() : null);
    try {
      db.prepare(
        `UPDATE cooperation_thoa_thuan SET
          terminated_at = ?, het_han = ?, trang_thai = 'het_han',
          termination_scan_path = ?, termination_scan_name = ?, termination_uploaded_at = ?,
          expiry_alert_sent_at = NULL, post_expiry_alert_count = 0, last_post_expiry_alert_at = NULL,
          updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(termRaw, termRaw, finalPath, finalName, finalUploaded, id);
      const row = db.prepare(
        `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
                no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
         FROM cooperation_thoa_thuan WHERE id = ?`
      ).get(id);
      return res.json({ ok: true, message: 'Đã ghi nhận kết thúc thỏa thuận.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });
});

// P.KHCN / Admin: replace main agreement scan (PDF/DOCX/image)
app.post('/api/cooperation/thoa-thuan/:id/agreement-scan', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  let exists;
  try {
    exists = db.prepare('SELECT id FROM cooperation_thoa_thuan WHERE id = ?').get(id);
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
  }
  if (!exists) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
  uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file bản scan.' });
    const scanPath = path.join('uploads', 'htqt-thoa-thuan', req.file.filename).replace(/\\/g, '/');
    const scanName = req.file.originalname || req.file.filename;
    try {
      db.prepare(
        `UPDATE cooperation_thoa_thuan SET scan_file_path = ?, scan_file_name = ?, scan_uploaded_at = ?, updated_at = datetime('now','localtime') WHERE id = ?`
      ).run(scanPath, scanName, new Date().toISOString(), id);
      const row = db.prepare(
        `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
                no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
         FROM cooperation_thoa_thuan WHERE id = ?`
      ).get(id);
      return res.json({ ok: true, message: 'Đã cập nhật bản scan.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });
});

// Admin: cập nhật vai trò. Cấp / gỡ vai trò Admin chỉ Master Admin; không gỡ được Master.
app.put('/api/admin/users/role', authMiddleware, adminOnly, (req, res) => {
  const { email, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail && role !== 'admin') {
    return res.status(400).json({ message: 'Bạn không thể tự hạ vai trò của chính mình' });
  }
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  if (!allowed.includes(role)) {
    return res.status(400).json({ message: 'Vai trò không hợp lệ' });
  }
  const targetRow = db.prepare('SELECT role FROM users WHERE email = ?').get(em);
  if (!targetRow) {
    return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  }
  const prevRole = (targetRow.role || '').toLowerCase();
  const newRole = (role || '').toLowerCase();
  if (newRole === 'admin' && prevRole !== 'admin' && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chỉ Master Admin mới được cấp vai trò Admin.' });
  }
  if (prevRole === 'admin' && newRole !== 'admin') {
    if (!reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới được gỡ quyền Admin.' });
    }
    if (userEmailIsMasterAdmin(em)) {
      return res.status(400).json({ message: 'Không thể gỡ quyền Master Admin hệ thống.' });
    }
  }
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (councilRoles.includes(role) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chỉ tài khoản có đuôi @sci.edu.vn mới được gán vai trò Chủ tịch, Thư ký, Thành viên Hội đồng' });
  }
  const r = db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, em);
  if (r.changes === 0) {
    return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  }
  return res.json({ message: 'Đã cập nhật vai trò' });
});

// Admin: danh sách Tổ thẩm định tài chính (Tổ trưởng, Thành viên)
app.get('/api/admin/budget-appraisal-team', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare(
    "SELECT id, email, fullname, academicTitle, role, createdAt FROM users WHERE role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc') ORDER BY role, fullname, email"
  ).all();
  return res.json({ members: rows });
});

// Admin: cập nhật thành viên Tổ thẩm định tài chính (họ tên, học hàm học vị, vai trò)
app.put('/api/admin/budget-appraisal-team', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname, academicTitle, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lòng nhập email' });
  const allowed = ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || '').toLowerCase();
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trò phải là Tổ trưởng hoặc Thành viên Tổ thẩm định TC' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!existing) return res.status(404).json({ message: 'Không tìm thấy tài khoản. Thêm qua form bên trên trước.' });
  db.prepare('UPDATE users SET fullname = ?, academicTitle = ?, role = ? WHERE email = ?')
    .run((fullname || '').trim(), (academicTitle || '').trim() || null, r, em);
  return res.json({ message: 'Đã cập nhật thông tin thành viên Tổ thẩm định tài chính.' });
});

// Admin: xóa thành viên khỏi Tổ thẩm định tài chính (chuyển vai trò về Nghiên cứu viên)
app.delete('/api/admin/budget-appraisal-team/:email', authMiddleware, adminOnly, (req, res) => {
  const em = decodeURIComponent(req.params.email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  if (!['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(row.role)) {
    return res.status(400).json({ message: 'Người này không phải thành viên Tổ thẩm định tài chính' });
  }
  db.prepare('UPDATE users SET role = ?, academicTitle = NULL WHERE email = ?').run('researcher', em);
  return res.json({ message: 'Đã xóa khỏi Tổ thẩm định tài chính. Tài khoản chuyển thành Nghiên cứu viên.' });
});

// Admin: đặt mật khẩu mới (≥6 ký tự), hoặc đưa về chưa kích hoạt nếu để trống (không còn sinh random mặc định — tránh nhầm với “chưa kích hoạt”)
app.put('/api/admin/users/:email/password', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  const newPassword = (req.body?.newPassword ?? '').toString().trim();
  const wantRandomTemp = !!(req.body && req.body.generateRandomTemp === true);

  if (!newPassword || newPassword.length < 6) {
    if (wantRandomTemp) {
      const temp = crypto.randomBytes(8).toString('hex');
      const hash = await bcrypt.hash(temp, 10);
      db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
      return res.json({
        message: 'Đã cấp mật khẩu tạm ngẫu nhiên.',
        tempPassword: temp,
      });
    }
    if ((row.role || '').toLowerCase() === 'admin') {
      return res.status(400).json({ message: 'Không thể đưa tài khoản Admin về chưa kích hoạt qua API này.' });
    }
    const selfEm = (req.user.email || '').toLowerCase();
    if (em === selfEm) {
      return res.status(400).json({ message: 'Không thể đưa chính tài khoản đang đăng nhập về chưa kích hoạt.' });
    }
    db.prepare('UPDATE users SET password = ? WHERE email = ?').run('', em);
    return res.json({
      message: 'Đã đưa tài khoản về chưa kích hoạt. User vào trang Đăng ký (@sci.edu.vn) để đặt mật khẩu.',
      activated: false,
    });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
  return res.json({
    message: 'Đã cấp lại mật khẩu. Gửi mật khẩu tạm cho thành viên qua email nếu cần.',
    tempPassword: newPassword,
  });
});

// Admin: khóa / mở khóa đăng nhập (ban nick)
app.put('/api/admin/users/:email/banned', authMiddleware, adminOnly, (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  const banned = !!(req.body && req.body.banned);
  if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) {
    return res.status(400).json({ message: 'Không thể khóa hoặc mở khóa tài khoản của chính mình' });
  }
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  db.prepare('UPDATE users SET is_banned = ? WHERE email = ?').run(banned ? 1 : 0, em);
  return res.json({ message: banned ? 'Đã khóa tài khoản (không đăng nhập được).' : 'Đã mở khóa tài khoản.' });
});

// Admin: xóa tài khoản thành viên (chỉ khi không có hồ sơ đã nộp)
app.delete('/api/admin/users/:email', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email không hợp lệ' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) return res.status(400).json({ message: 'Bạn không thể xóa tài khoản của chính mình' });
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
  const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  const hasCapVien = db.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  if (hasSubs || hasCapVien) {
    return res.status(400).json({ message: 'Không thể xóa: thành viên này đã có hồ sơ nộp trong hệ thống. Có thể chuyển vai trò về Nghiên cứu viên thay vì xóa.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  return res.json({ message: 'Đã xóa tài khoản.' });
});

// Khởi tạo Admin mặc định (ADMIN_EMAIL) nếu chưa có — đồng bộ để tránh race khi đăng nhập ngay sau khởi động
const adminExists = db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(ADMIN_EMAIL.toLowerCase());
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(
    ADMIN_EMAIL.toLowerCase(),
    hash,
    'Admin',
    'admin'
  );
  console.log('Đã tạo tài khoản Admin mặc định: ' + ADMIN_EMAIL + ' / mật khẩu: admin123 (vui lòng đổi sau)');
}
// Luôn đảm bảo super-admin có role admin (phòng trường hợp bị đổi role trong DB)
try {
  const r = db
    .prepare("UPDATE users SET role = 'admin' WHERE lower(trim(email)) = ? AND lower(trim(role)) != 'admin'")
    .run(ADMIN_EMAIL.toLowerCase());
  if (r.changes > 0) console.log('[Admin] Đã khôi phục vai trò admin cho ' + ADMIN_EMAIL);
} catch (e) { /* ignore */ }
// Đồng bộ: sinhnguyen@sci.edu.vn = NCV (researcher), không admin; tên hiển thị đầy đủ «Nguyễn Trường Sinh»
try {
  const r = db
    .prepare(
      `UPDATE users SET
         role = 'researcher',
         fullname = CASE
           WHEN lower(trim(coalesce(fullname, ''))) IN ('admin', 'administrator', 'quản trị', 'quan tri', 'sinh') THEN 'Nguyễn Trường Sinh'
           WHEN trim(coalesce(fullname, '')) = '' THEN 'Nguyễn Trường Sinh'
           ELSE fullname
         END
       WHERE lower(trim(email)) = ?`
    )
    .run('sinhnguyen@sci.edu.vn');
  if (r.changes > 0) {
    console.log('[Users] Đã đồng bộ sinhnguyen@sci.edu.vn → researcher (tên: Nguyễn Trường Sinh).');
  }
} catch (e) {
  /* ignore */
}

// Backfill gd5 history cho hồ sơ cũ đã có meeting result
try {
  const subsWithMeeting = db.prepare('SELECT id, meetingDecisionAt, meetingDecisionById, status FROM submissions WHERE meetingDecisionAt IS NOT NULL').all();
  subsWithMeeting.forEach(s => {
    const hasHistory = db.prepare('SELECT 1 FROM submission_gd5_history WHERE submissionId = ?').get(s.id);
    if (!hasHistory) {
      const label = s.status === 'CONDITIONAL' ? 'Chấp thuận có điều kiện' : (s.status === 'APPROVED' ? 'Chấp thuận' : 'Không chấp thuận');
      const mf = db.prepare("SELECT originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(s.id);
      insertGd5History(s.id, 'meeting_result', s.meetingDecisionById, 'meeting_minutes', mf ? mf.originalName : null, label);
    }
  });
} catch (e) { /* ignore */ }

// CRD Lab Booking: nếu chưa có thư mục crd-lab-booking với index.html thì trả trang placeholder (tránh "Cannot GET")
const crdLabBookingPath = path.join(__dirname, 'crd-lab-booking', 'index.html');
app.get('/crd-lab-booking', (req, res) => res.redirect(302, '/crd-lab-booking/'));
app.get('/crd-lab-booking/', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.type('html').send(
    '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>CRD Lab Booking</title></head><body style="font-family:Segoe UI;padding:40px;text-align:center;">' +
    '<h1>🏢 CRD Lab Booking</h1><p>Ứng dụng sẽ hiển thị tại đây khi bạn build dự án React ra thư mục <code>crd-lab-booking/</code>.</p>' +
    '<p><a href="/crd-lab-booking.html">Trang thông tin</a> · <a href="/index.html">Trang chủ</a></p></body></html>'
  );
});
app.get('/crd-lab-booking/index.html', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.redirect(302, '/crd-lab-booking.html');
});

// Phục vụ file tĩnh (HTML, CSS, v.v.) — sau tất cả route API
// Trả 404 JSON cho API không tồn tại (tránh HTML "Cannot POST/GET")

// ============================================================
// BỔ SUNG MODULE HỢP TÁC QUỐC TẾ
// ============================================================
// ROUTE /api/me — Thông tin user hiện tại (HTML mới cần route này)
// ============================================================
app.get('/api/me', authMiddleware, (req, res) => {
  try {
    const user = req.user || {};
    const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(user.id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const out = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
    out.isMasterAdmin = userEmailIsMasterAdmin(out.email);
    return res.json(out);
  } catch(e) {
    return res.json(req.user || {});
  }
});

// ─── API đặt lịch thiết bị CRD (SQLite: crd_*) ─────────────────────────────
function crdEnsurePersonForAppUser(reqUser) {
  const pid = 'u_app_' + reqUser.id;
  const existing = db.prepare('SELECT id, crd_access_revoked FROM crd_persons WHERE id = ?').get(pid);
  if (existing) {
    if (Number(existing.crd_access_revoked) === 1) return null;
    /* Hồ sơ cũ có thể thiếu user_id — đồng bộ để API (email thông báo, v.v.) hoạt động */
    const uidRow = db.prepare('SELECT user_id FROM crd_persons WHERE id = ?').get(pid);
    if (uidRow && uidRow.user_id == null) {
      try {
        db.prepare('UPDATE crd_persons SET user_id = ? WHERE id = ?').run(reqUser.id, pid);
      } catch (_) { /* ignore nếu DB cũ không có cột */ }
    }
    return pid;
  }
  const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(reqUser.id);
  if (!u) return null;
  const name = (u.fullname || u.email || 'User').trim();
  const av = (name[0] || '?').toUpperCase();
  db.prepare('INSERT INTO crd_persons (id, name, email, role, avatar, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(
    pid,
    name,
    (u.email || '').toLowerCase(),
    'user',
    av,
    reqUser.id
  );
  return pid;
}

function crdBookingOverlaps(machineId, date, startH, endH, excludeId) {
  const ex = excludeId || '';
  const row = db
    .prepare(
      `SELECT id FROM crd_bookings WHERE machine_id = ? AND date = ? AND id != ?
       AND NOT (end_h <= ? OR start_h >= ?) LIMIT 1`
    )
    .get(machineId, date, ex, startH, endH);
  return !!row;
}

function crdAnnouncementToClient(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: (r.title || '').trim(),
    body: r.body || '',
    sortOrder: r.sort_order != null ? Number(r.sort_order) : 0,
    isActive: Number(r.is_active) !== 0,
    createdAt: r.created_at || '',
    updatedAt: r.updated_at || ''
  };
}

function crdLabAnnouncementsActive() {
  try {
    return db
      .prepare(
        `SELECT * FROM crd_lab_announcements WHERE is_active = 1
         ORDER BY sort_order ASC, datetime(COALESCE(updated_at, created_at)) DESC, id ASC`
      )
      .all()
      .map(crdAnnouncementToClient);
  } catch (e) {
    return [];
  }
}

function crdLabAnnouncementsAll() {
  try {
    return db
      .prepare(
        `SELECT * FROM crd_lab_announcements
         ORDER BY sort_order ASC, datetime(COALESCE(updated_at, created_at)) DESC, id ASC`
      )
      .all()
      .map(crdAnnouncementToClient);
  } catch (e) {
    return [];
  }
}

function crdGetStateForUser(reqUser, precomputedMePersonId) {
  const mePersonId =
    precomputedMePersonId !== undefined ? precomputedMePersonId : crdEnsurePersonForAppUser(reqUser);
  const machines = db
    .prepare('SELECT * FROM crd_machines ORDER BY sort_order ASC, name ASC')
    .all()
    .map(crdMachineToClient);
  let users = db.prepare('SELECT * FROM crd_persons ORDER BY name ASC').all().map(crdPersonToUser);
  const isSysAdmin = (reqUser.role || '').toLowerCase() === 'admin';
  if (!isSysAdmin) {
    users = users.filter((u) => !u.crdAccessRevoked);
  }
  const bookings = db.prepare('SELECT * FROM crd_bookings ORDER BY date DESC, start_h ASC').all().map(crdBookingToClient);
  const chats = db.prepare('SELECT * FROM crd_chats WHERE is_deleted = 0 ORDER BY ts ASC').all().map(crdChatToClient);
  const crdRoles = crdRoleDefsToClient();
  const appRole = (reqUser.role || '').toLowerCase();
  let broadcastLastRead = 0;
  if (mePersonId) {
    const br = db.prepare('SELECT last_read_ts FROM crd_broadcast_read WHERE person_id = ?').get(mePersonId);
    broadcastLastRead = br && br.last_read_ts != null ? Number(br.last_read_ts) : 0;
  }
  return {
    machines,
    users,
    bookings,
    chats,
    mePersonId,
    appRole,
    crdRoles,
    broadcastLastRead,
    broadcastChannelId: CRD_BROADCAST_TO_ID,
    labAnnouncements: crdLabAnnouncementsActive()
  };
}

app.get('/api/crd/state', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) {
      return res.status(403).json({
        message: 'Hồ sơ CRD chưa có hoặc đã bị gỡ khỏi module. Liên hệ quản trị để được cấp lại quyền.'
      });
    }
    const block = crdPersonBlockedForUse(mePersonId);
    if (block) return res.status(403).json({ message: block });
    return res.json(crdGetStateForUser(req.user, mePersonId));
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi CRD' });
  }
});

app.post('/api/crd/bookings', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không tạo được hồ sơ người dùng CRD hoặc quyền đã bị gỡ' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const { machineId, date, startH, endH, purpose, researchGroup } = req.body || {};
    const mid = (machineId || '').trim();
    const d = (date || '').trim();
    const sh = Number(startH);
    const eh = Number(endH);
    const pur = (purpose || '').trim();
    const rg = (researchGroup != null ? String(researchGroup) : '').trim();
    if (!mid || !d || !Number.isFinite(sh) || !Number.isFinite(eh)) {
      return res.status(400).json({ message: 'Thiếu thông tin đặt lịch' });
    }
    if (eh <= sh) return res.status(400).json({ message: 'Giờ kết thúc phải sau giờ bắt đầu' });
    if (!crdIsHalfHourMark(sh) || !crdIsHalfHourMark(eh)) {
      return res.status(400).json({ message: 'Giờ đặt phải theo bước 30 phút (VD: 8:00, 8:30)' });
    }
    if (!pur) return res.status(400).json({ message: 'Vui lòng nhập mục đích sử dụng' });
    if (!rg) return res.status(400).json({ message: 'Vui lòng nhập tên nhóm nghiên cứu' });
    const m = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(mid);
    if (!m) return res.status(404).json({ message: 'Không tìm thấy thiết bị' });
    if (sh < m.avail_from || eh > m.avail_to) {
      return res.status(400).json({ message: `Thiết bị chỉ mở đặt lịch ${m.avail_from}:00–${m.avail_to}:00` });
    }
    if (eh - sh > m.max_hours) {
      return res.status(400).json({ message: `Tối đa ${m.max_hours} giờ mỗi lần đặt` });
    }
    if (crdBookingOverlaps(mid, d, sh, eh, null)) {
      return res.status(409).json({ message: 'Khung giờ này đã có người đặt' });
    }
    const id = 'b_' + crypto.randomBytes(6).toString('hex');
    // created_at: không phụ thuộc vào cột này để tránh lỗi migration schema
    // (vẫn có thể hiển thị/track theo created_at nếu cột tồn tại ở DB).
    db.prepare(
      'INSERT INTO crd_bookings (id,machine_id,person_id,date,start_h,end_h,purpose,status,research_group) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, mid, mePersonId, d, sh, eh, pur, 'confirmed', rg);
    return res.status(201).json({ booking: crdBookingToClient(db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/bookings/:id', authMiddleware, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy lịch' });
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!isAdmin) {
      if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người dùng CRD' });
      const blk = crdPersonBlockedForUse(mePersonId);
      if (blk) return res.status(403).json({ message: blk });
    }
    if (!isAdmin && row.person_id !== mePersonId) {
      return res.status(403).json({ message: 'Chỉ huỷ được lịch của chính mình' });
    }
    db.prepare('DELETE FROM crd_bookings WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/bookings/:id', authMiddleware, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy lịch' });
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!isAdmin) {
      if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người dùng CRD' });
      const blk = crdPersonBlockedForUse(mePersonId);
      if (blk) return res.status(403).json({ message: blk });
    }
    if (!isAdmin && row.person_id !== mePersonId) {
      return res.status(403).json({ message: 'Chỉ sửa được lịch của chính mình' });
    }
    const b = req.body || {};
    const startH = b.startH !== undefined ? Number(b.startH) : row.start_h;
    const endH   = b.endH   !== undefined ? Number(b.endH)   : row.end_h;
    const purpose     = b.purpose     !== undefined ? String(b.purpose || '').trim()     : row.purpose || '';
    const researchGroup = b.researchGroup !== undefined ? String(b.researchGroup || '').trim() : (row.research_group != null ? String(row.research_group) : '');
    if (!Number.isFinite(startH) || !Number.isFinite(endH)) {
      return res.status(400).json({ message: 'Giờ không hợp lệ' });
    }
    if (endH <= startH) return res.status(400).json({ message: 'Giờ kết thúc phải sau giờ bắt đầu' });
    if (!crdIsHalfHourMark(startH) || !crdIsHalfHourMark(endH)) {
      return res.status(400).json({ message: 'Giờ phải theo bước 30 phút' });
    }
    if (!researchGroup) return res.status(400).json({ message: 'Vui lòng nhập tên nhóm nghiên cứu' });
    if (!purpose) return res.status(400).json({ message: 'Vui lòng nhập mục đích sử dụng' });
    const m = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(row.machine_id);
    if (!m) return res.status(400).json({ message: 'Thiết bị không tồn tại' });
    if (endH - startH > m.max_hours) return res.status(400).json({ message: `Tối đa ${m.max_hours} giờ/lần đặt` });
    if (startH < m.avail_from || endH > m.avail_to) {
      return res.status(400).json({ message: `Máy chỉ hoạt động ${m.avail_from}:00–${m.avail_to}:00` });
    }
    if (crdBookingOverlaps(row.machine_id, row.date, startH, endH, id)) {
      return res.status(409).json({ message: 'Trùng lịch với booking khác' });
    }
    db.prepare(
      `UPDATE crd_bookings SET start_h=?, end_h=?, purpose=?, research_group=?, updated_at=datetime('now') WHERE id=?`
    ).run(startH, endH, purpose, researchGroup, id);
    return res.json({ booking: crdBookingToClient(db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.post('/api/crd/chats', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người gửi hoặc quyền CRD đã bị gỡ' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const { toId, bookingId, msg } = req.body || {};
    const to = (toId || '').trim();
    const message = (msg || '').trim();
    if (!to || !message) return res.status(400).json({ message: 'Thiếu nội dung hoặc người nhận' });
    if (message.length > 4000) return res.status(400).json({ message: 'Tin nhắn quá dài (tối đa 4000 ký tự)' });
    if (to === mePersonId) return res.status(400).json({ message: 'Không thể gửi cho chính mình' });
    /* ── Kênh chung: mọi người trong CRD đều đọc được ── */
    if (to === CRD_BROADCAST_TO_ID) {
      /* ── Rate limiting ── */
      const now = Date.now();
      if (!crdBroadcastRateMap.has(mePersonId)) crdBroadcastRateMap.set(mePersonId, []);
      const times = crdBroadcastRateMap.get(mePersonId).filter(t => now - t < CRD_BROADCAST_RATE_MS);
      crdBroadcastRateMap.set(mePersonId, times);
      if (times.length >= CRD_BROADCAST_RATE_BURST) {
        const waitSec = Math.ceil((CRD_BROADCAST_RATE_MS - (now - times[0])) / 1000);
        return res.status(429).json({
          message: `Vui lòng chờ ${waitSec}s trước khi gửi tin tiếp theo trên kênh chung.`,
          retryAfter: waitSec
        });
      }
      crdBroadcastRateMap.get(mePersonId).push(now);

      const bk = bookingId ? (bookingId || '').trim() : null;
      if (bk) {
        const b = db.prepare('SELECT id, person_id FROM crd_bookings WHERE id = ?').get(bk);
        if (!b) return res.status(400).json({ message: 'Booking không tồn tại' });
        if (String(b.person_id) !== String(mePersonId)) {
          return res.status(403).json({ message: 'Chỉ được đính kèm booking của chính mình trên kênh chung' });
        }
      }
      const id = 'c_' + crypto.randomBytes(6).toString('hex');
      const ts = Date.now();
      db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,0)').run(
        id,
        mePersonId,
        CRD_BROADCAST_TO_ID,
        bk,
        message,
        ts
      );
      /* ── Gửi email notification cho người đã bật thông báo (không chờ) ── */
      crdSendBroadcastEmailNotification(mePersonId, message, ts).catch(e =>
        console.error('[CRD broadcast email]:', e.message)
      );
      return res.status(201).json({ chat: crdChatToClient(db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id)) });
    }
    const peer = db.prepare('SELECT id, is_banned, crd_access_revoked FROM crd_persons WHERE id = ?').get(to);
    if (!peer) return res.status(404).json({ message: 'Người nhận không tồn tại' });
    if (Number(peer.crd_access_revoked) === 1) return res.status(400).json({ message: 'Người nhận không còn trong module CRD' });
    if (Number(peer.is_banned) === 1) return res.status(400).json({ message: 'Không thể nhắn tới tài khoản đang bị khoá' });
    const bk = bookingId ? (bookingId || '').trim() : null;
    if (bk) {
      const b = db.prepare('SELECT id FROM crd_bookings WHERE id = ?').get(bk);
      if (!b) return res.status(400).json({ message: 'Booking không tồn tại' });
    }
    const id = 'c_' + crypto.randomBytes(6).toString('hex');
    const ts = Date.now();
    db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,0)').run(
      id,
      mePersonId,
      to,
      bk,
      message,
      ts
    );
    return res.status(201).json({ chat: crdChatToClient(db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/chats/:id/read', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định người dùng CRD' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    if (row.to_id !== mePersonId) return res.status(403).json({ message: 'Không có quyền' });
    db.prepare('UPDATE crd_chats SET read_flag = 1 WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/chats/mark-thread-read', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định người dùng CRD' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const fromId = ((req.body || {}).fromId || '').trim();
    if (!fromId) return res.status(400).json({ message: 'Thiếu fromId' });
    db.prepare(
      'UPDATE crd_chats SET read_flag = 1 WHERE from_id = ? AND to_id = ? AND read_flag = 0'
    ).run(fromId, mePersonId);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

/** Đánh dấu đã đọc kênh chung (theo mốc thời gian tin mới nhất lúc mở kênh). */
app.put('/api/crd/chats/broadcast-read', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định người dùng CRD' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const row = db
      .prepare('SELECT MAX(ts) AS m FROM crd_chats WHERE to_id = ?')
      .get(CRD_BROADCAST_TO_ID);
    const ts = row && row.m != null ? Number(row.m) : Date.now();
    db.prepare(
      'INSERT INTO crd_broadcast_read (person_id, last_read_ts) VALUES (?, ?) ON CONFLICT(person_id) DO UPDATE SET last_read_ts = excluded.last_read_ts'
    ).run(mePersonId, ts);
    return res.json({ ok: true, broadcastLastRead: ts });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.post('/api/crd/complaints', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người gửi hoặc quyền CRD đã bị gỡ' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const { subject, body, againstId, bookingId } = req.body || {};
    const sub = (subject || '').trim();
    const bod = (body || '').trim();
    if (!sub || !bod) return res.status(400).json({ message: 'Vui lòng nhập tiêu đề và nội dung' });
    const ag = (againstId || '').trim() || null;
    const bk = (bookingId || '').trim() || null;
    const r = db
      .prepare(
        'INSERT INTO crd_complaints (reporter_id, against_id, booking_id, subject, body, status) VALUES (?,?,?,?,?,?)'
      )
      .run(mePersonId, ag, bk, sub, bod, 'open');
    return res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.get('/api/crd/admin/snapshot', authMiddleware, adminOnly, (req, res) => {
  try {
    const base = crdGetStateForUser(req.user);
    const complaints = db
      .prepare('SELECT * FROM crd_complaints ORDER BY id DESC')
      .all()
      .map(c => ({
        id: c.id,
        reporterId: c.reporter_id,
        againstId: c.against_id || null,
        bookingId: c.booking_id || null,
        subject: c.subject,
        body: c.body,
        status: c.status,
        adminNote: c.admin_note || '',
        createdAt: c.created_at
      }));
    return res.json({ ...base, complaints });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.get('/api/crd/admin/lab-announcements', authMiddleware, adminOnly, (req, res) => {
  try {
    return res.json({ announcements: crdLabAnnouncementsAll() });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.post('/api/crd/admin/lab-announcements', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const title = (b.title != null ? String(b.title) : '').trim();
    const bodyText = (b.body != null ? String(b.body) : '').trim();
    if (!title && !bodyText) {
      return res.status(400).json({ message: 'Vui lòng nhập tiêu đề hoặc nội dung thông báo' });
    }
    let sortOrder = b.sortOrder !== undefined ? Number(b.sortOrder) : 0;
    if (!Number.isFinite(sortOrder)) sortOrder = 0;
    const isActive = b.isActive === false || b.isActive === 0 ? 0 : 1;
    const id = 'la_' + crypto.randomBytes(6).toString('hex');
    db.prepare(
      `INSERT INTO crd_lab_announcements (id, title, body, sort_order, is_active, updated_at)
       VALUES (?,?,?,?,?, datetime('now','localtime'))`
    ).run(id, title, bodyText, sortOrder, isActive);
    const row = db.prepare('SELECT * FROM crd_lab_announcements WHERE id = ?').get(id);
    return res.status(201).json({
      announcement: crdAnnouncementToClient(row),
      labAnnouncements: crdLabAnnouncementsActive()
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/admin/lab-announcements/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_lab_announcements WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy thông báo' });
    const b = req.body || {};
    const title = b.title !== undefined ? String(b.title).trim() : row.title || '';
    const bodyText = b.body !== undefined ? String(b.body) : row.body || '';
    let sortOrder = b.sortOrder !== undefined ? Number(b.sortOrder) : row.sort_order;
    let isActive =
      b.isActive !== undefined ? (b.isActive === false || b.isActive === 0 ? 0 : 1) : row.is_active;
    if (!Number.isFinite(sortOrder)) sortOrder = 0;
    if (!title.trim() && !String(bodyText || '').trim()) {
      return res.status(400).json({ message: 'Tiêu đề và nội dung không được để trống cùng lúc' });
    }
    db.prepare(
      `UPDATE crd_lab_announcements SET title=?, body=?, sort_order=?, is_active=?,
       updated_at=datetime('now','localtime') WHERE id=?`
    ).run(title, bodyText, sortOrder, isActive, id);
    return res.json({
      announcement: crdAnnouncementToClient(db.prepare('SELECT * FROM crd_lab_announcements WHERE id = ?').get(id)),
      labAnnouncements: crdLabAnnouncementsActive()
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/admin/lab-announcements/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const r = db.prepare('DELETE FROM crd_lab_announcements WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy thông báo' });
    return res.json({ ok: true, labAnnouncements: crdLabAnnouncementsActive() });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.post('/api/crd/admin/machines', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Tên thiết bị bắt buộc' });
    const id = (b.id && String(b.id).trim()) || 'm_' + crypto.randomBytes(5).toString('hex');
    const type = (b.type || '').trim() || '';
    const location = (b.location || '').trim() || '';
    const color = (b.color || '#667eea').trim();
    const availFrom = Math.max(0, Math.min(23, Number(b.availFrom) || 8));
    const availTo = Math.max(1, Math.min(24, Number(b.availTo) || 20));
    const maxHours = Math.max(1, Math.min(24, Number(b.maxHours) || 4));
    const description = (b.desc || b.description || '').trim();
    const sort_order = Number(b.sort_order) || 0;
    if (availTo <= availFrom) return res.status(400).json({ message: 'availTo phải lớn hơn availFrom' });
    db.prepare(
      `INSERT INTO crd_machines (id,name,type,location,color,avail_from,avail_to,max_hours,description,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(id, name, type, location, color, availFrom, availTo, maxHours, description, sort_order);
    return res.status(201).json({ machine: crdMachineToClient(db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(id)) });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ message: 'ID thiết bị đã tồn tại' });
    }
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

/** Body: { orderedIds: string[] } — đủ mọi id thiết bị, đúng thứ tự hiển thị */
app.put('/api/crd/admin/machines/reorder', authMiddleware, adminOnly, (req, res) => {
  try {
    const raw = req.body && req.body.orderedIds;
    if (!Array.isArray(raw) || !raw.length) {
      return res.status(400).json({ message: 'orderedIds phải là mảng id thiết bị' });
    }
    const orderedIds = raw.map((x) => String(x || '').trim()).filter(Boolean);
    const uniq = new Set(orderedIds);
    if (uniq.size !== orderedIds.length) {
      return res.status(400).json({ message: 'Trùng ID trong orderedIds' });
    }
    const existing = db.prepare('SELECT id FROM crd_machines').all().map((r) => r.id);
    if (orderedIds.length !== existing.length) {
      return res.status(400).json({ message: 'Số thiết bị không khớp với máy chủ' });
    }
    const es = new Set(existing);
    for (const id of orderedIds) {
      if (!es.has(id)) return res.status(400).json({ message: 'Có ID không tồn tại trong orderedIds' });
    }

    const upd = db.prepare(
      "UPDATE crd_machines SET sort_order = ?, updated_at = datetime('now') WHERE id = ?"
    );
    const tx = db.transaction(() => {
      orderedIds.forEach((id, i) => upd.run(i, id));
    });
    tx();
    const machines = db
      .prepare('SELECT * FROM crd_machines ORDER BY sort_order ASC, name ASC')
      .all()
      .map(crdMachineToClient);
    return res.json({ machines });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/admin/machines/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const name = (b.name !== undefined ? String(b.name) : row.name).trim();
    if (!name) return res.status(400).json({ message: 'Tên thiết bị bắt buộc' });
    const type = b.type !== undefined ? String(b.type) : row.type;
    const location = b.location !== undefined ? String(b.location) : row.location;
    const color = b.color !== undefined ? String(b.color) : row.color;
    let availFrom = b.availFrom !== undefined ? Number(b.availFrom) : row.avail_from;
    let availTo = b.availTo !== undefined ? Number(b.availTo) : row.avail_to;
    let maxHours = b.maxHours !== undefined ? Number(b.maxHours) : row.max_hours;
    const description = b.desc !== undefined ? String(b.desc) : b.description !== undefined ? String(b.description) : row.description;
    let sortOrder = b.sort_order !== undefined ? Number(b.sort_order) : row.sort_order;
    if (!Number.isFinite(sortOrder)) sortOrder = 0;
    availFrom = Math.max(0, Math.min(23, availFrom));
    availTo = Math.max(1, Math.min(24, availTo));
    maxHours = Math.max(1, Math.min(24, maxHours));
    if (availTo <= availFrom) return res.status(400).json({ message: 'availTo phải lớn hơn availFrom' });
    db.prepare(
      `UPDATE crd_machines SET name=?, type=?, location=?, color=?, avail_from=?, avail_to=?, max_hours=?, description=?, sort_order=?, updated_at=datetime('now') WHERE id=?`
    ).run(name, type, location, color, availFrom, availTo, maxHours, description || '', sortOrder, id);
    return res.json({ machine: crdMachineToClient(db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/admin/machines/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT id FROM crd_machines WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    db.prepare('DELETE FROM crd_bookings WHERE machine_id = ?').run(id);
    db.prepare('DELETE FROM crd_machines WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.post('/api/crd/admin/persons', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Tên bắt buộc' });
    const id = (b.id && String(b.id).trim()) || 'u_' + crypto.randomBytes(5).toString('hex');
    const email = (b.email || '').trim().toLowerCase() || null;
    const roleRaw = String(b.role || 'user')
      .trim()
      .toLowerCase();
    if (!crdRoleSlugValid(roleRaw)) return res.status(400).json({ message: 'Vai trò không hợp lệ (chưa có trong danh sách vai trò CRD)' });
    const role = roleRaw;
    const avatar = (b.avatar || name[0] || '?').toString().slice(0, 2).toUpperCase();
    db.prepare('INSERT INTO crd_persons (id,name,email,role,avatar) VALUES (?,?,?,?,?)').run(id, name, email, role, avatar);
    return res.status(201).json({ user: crdPersonToUser(db.prepare('SELECT * FROM crd_persons WHERE id = ?').get(id)) });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ message: 'ID đã tồn tại' });
    }
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/admin/persons/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_persons WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : row.name;
    const email = b.email !== undefined ? String(b.email).trim().toLowerCase() : row.email;
    let role = row.role;
    if (b.role !== undefined) {
      const roleRaw = String(b.role).trim().toLowerCase();
      if (!crdRoleSlugValid(roleRaw)) return res.status(400).json({ message: 'Vai trò không hợp lệ' });
      role = roleRaw;
    }
    const avatar = b.avatar !== undefined ? String(b.avatar).trim().slice(0, 2) : row.avatar;
    let isBanned = Number(row.is_banned) === 1 ? 1 : 0;
    if (b.isBanned !== undefined) isBanned = b.isBanned ? 1 : 0;
    let crdAccessRevoked = Number(row.crd_access_revoked) === 1 ? 1 : 0;
    if (b.crdAccessRevoked !== undefined) crdAccessRevoked = b.crdAccessRevoked ? 1 : 0;
    if (!name) return res.status(400).json({ message: 'Tên không được để trống' });
    db.prepare(
      `UPDATE crd_persons SET name=?, email=?, role=?, avatar=?, is_banned=?, crd_access_revoked=?, updated_at=datetime('now') WHERE id=?`
    ).run(name, email || null, role, avatar || '?', isBanned, crdAccessRevoked, id);
    return res.json({ user: crdPersonToUser(db.prepare('SELECT * FROM crd_persons WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/admin/persons/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT id FROM crd_persons WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    db.prepare('DELETE FROM crd_bookings WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM crd_chats WHERE from_id = ? OR to_id = ?').run(id, id);
    if (String(id).startsWith('u_app_')) {
      db.prepare('UPDATE crd_persons SET crd_access_revoked=1, is_banned=0, updated_at=datetime(\'now\') WHERE id=?').run(id);
      return res.json({ ok: true, revoked: true, message: 'Đã gỡ quyền CRD (hồ sơ giữ lại để không tự tạo lại khi đăng nhập)' });
    }
    db.prepare('DELETE FROM crd_persons WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.get('/api/crd/admin/persons/:id/stats', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT id FROM crd_persons WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy người dùng CRD' });
    const statusCond = `COALESCE(NULLIF(TRIM(status), ''), 'confirmed') != 'cancelled'`;
    const total = db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(end_h - start_h), 0) AS h FROM crd_bookings WHERE person_id = ? AND ${statusCond}`
      )
      .get(id);
    const byM = db
      .prepare(
        `SELECT machine_id, COUNT(*) AS c, COALESCE(SUM(end_h - start_h), 0) AS h
         FROM crd_bookings WHERE person_id = ? AND ${statusCond} GROUP BY machine_id ORDER BY h DESC`
      )
      .all(id);
    const machines = db.prepare('SELECT id, name FROM crd_machines').all();
    const nameById = {};
    for (const m of machines) nameById[m.id] = m.name || m.id;
    const byMachine = (byM || []).map((r) => ({
      machineId: r.machine_id,
      machineName: nameById[r.machine_id] || r.machine_id,
      bookings: r.c,
      hours: Math.round(Number(r.h) * 100) / 100
    }));
    const totalHours = Math.round(Number(total.h) * 100) / 100;
    return res.json({
      personId: id,
      totalBookings: total.c,
      totalHours,
      byMachine
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

/* ── Toàn bộ tài khoản users kèm trạng thái CRD ─────────────────────────── */
app.get('/api/crd/admin/users', authMiddleware, adminOnly, (req, res) => {
  try {
    const sysUsers = db.prepare('SELECT * FROM users ORDER BY createdAt DESC').all();
    // Map userId → crd_persons
    const crdByUserId = {};
    db.prepare('SELECT * FROM crd_persons').all().forEach(p => {
      if (p.user_id) crdByUserId[p.user_id] = p;
    });
    const result = sysUsers.map(u => {
      const crd = crdByUserId[u.id] || null;
      return {
        // Thông tin hệ thống
        id: u.id,
        email: u.email,
        fullname: u.fullname || '',
        role: u.role || 'researcher',
        createdAt: u.created_at,
        isDisabled: Number(u.is_disabled || 0) === 1,
        // Thông tin CRD (null = chưa vào module)
        crd: crd ? {
          personId: crd.id,
          personName: crd.name,
          personRole: crd.role || 'user',
          personAvatar: crd.avatar || '?',
          isBanned: Number(crd.is_banned) === 1,
          crdAccessRevoked: Number(crd.crd_access_revoked) === 1,
          syncedFromApp: String(crd.id).startsWith('u_app_'),
          isInVien: !!(u.email || '').toLowerCase().endsWith('@sci.edu.vn'),
        } : null,
      };
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/admin/users/:id/disable', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || !Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const newVal = Number(row.is_disabled || 0) === 1 ? 0 : 1;
    db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(newVal, id);
    return res.json({ ok: true, isDisabled: newVal === 1, message: newVal ? 'Đã vô hiệu hoá tài khoản' : 'Đã kích hoạt lại tài khoản' });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.post('/api/crd/admin/users/:id/reset-password', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || !Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const newPass = String(req.body.password || '').trim();
    if (!newPass || newPass.length < 6) return res.status(400).json({ message: 'Mật khẩu mới ít nhất 6 ký tự' });
    if (newPass.length > 128) return res.status(400).json({ message: 'Mật khẩu quá dài (tối đa 128 ký tự)' });
    const hash = bcrypt.hashSync(newPass, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
    return res.json({ ok: true, message: 'Đã đặt lại mật khẩu thành công' });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.post('/api/crd/admin/role-defs', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const slug = String(b.slug || '')
      .trim()
      .toLowerCase();
    const label = String(b.label || '').trim();
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(slug)) {
      return res.status(400).json({ message: 'Mã vai trò: chữ thường, số, gạch dưới; bắt đầu bằng chữ cái' });
    }
    if (!label) return res.status(400).json({ message: 'Nhập tên hiển thị' });
    const exists = db.prepare('SELECT 1 FROM crd_role_defs WHERE slug = ?').get(slug);
    if (exists) return res.status(409).json({ message: 'Mã vai trò đã tồn tại' });
    const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 999;
    const isAdm = b.isAdminSlot ? 1 : 0;
    if (slug === 'user' && isAdm) return res.status(400).json({ message: 'Vai trò user không thể đánh dấu quản trị' });
    db.prepare('INSERT INTO crd_role_defs (slug, label, sort_order, is_admin_slot) VALUES (?,?,?,?)').run(
      slug,
      label,
      sortOrder,
      isAdm
    );
    return res.status(201).json({ crdRoles: crdRoleDefsToClient() });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/admin/role-defs/:slug', authMiddleware, adminOnly, (req, res) => {
  try {
    const slug = String(req.params.slug || '')
      .trim()
      .toLowerCase();
    const row = db.prepare('SELECT * FROM crd_role_defs WHERE slug = ?').get(slug);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy vai trò' });
    const b = req.body || {};
    const label = b.label !== undefined ? String(b.label).trim() : row.label;
    let sortOrder = b.sortOrder !== undefined ? Number(b.sortOrder) : row.sort_order;
    if (!Number.isFinite(sortOrder)) sortOrder = row.sort_order;
    let isAdm = b.isAdminSlot !== undefined ? (b.isAdminSlot ? 1 : 0) : row.is_admin_slot;
    if (slug === 'user') isAdm = 0;
    if (slug === 'admin') isAdm = 1;
    if (!label) return res.status(400).json({ message: 'Tên hiển thị không được trống' });
    db.prepare('UPDATE crd_role_defs SET label=?, sort_order=?, is_admin_slot=? WHERE slug=?').run(label, sortOrder, isAdm, slug);
    return res.json({ crdRoles: crdRoleDefsToClient() });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/admin/role-defs/:slug', authMiddleware, adminOnly, (req, res) => {
  try {
    const slug = String(req.params.slug || '')
      .trim()
      .toLowerCase();
    if (slug === 'user' || slug === 'admin') {
      return res.status(400).json({ message: 'Không xóa được vai trò mặc định user / admin' });
    }
    const row = db.prepare('SELECT 1 FROM crd_role_defs WHERE slug = ?').get(slug);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const n = db.prepare('SELECT COUNT(*) AS c FROM crd_persons WHERE role = ?').get(slug);
    if (n && n.c > 0) return res.status(400).json({ message: 'Còn người dùng đang gán vai trò này — đổi vai trò họ trước khi xóa' });
    db.prepare('DELETE FROM crd_role_defs WHERE slug = ?').run(slug);
    return res.json({ crdRoles: crdRoleDefsToClient() });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/admin/bookings/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const machineId = b.machineId !== undefined ? String(b.machineId).trim() : row.machine_id;
    const personId = b.userId !== undefined ? String(b.userId).trim() : row.person_id;
    const date = b.date !== undefined ? String(b.date).trim() : row.date;
    const startH = b.startH !== undefined ? Number(b.startH) : row.start_h;
    const endH = b.endH !== undefined ? Number(b.endH) : row.end_h;
    const purpose = b.purpose !== undefined ? String(b.purpose) : row.purpose;
    const researchGroup =
      b.researchGroup !== undefined ? String(b.researchGroup || '').trim() : row.research_group != null ? String(row.research_group) : '';
    const status = b.status !== undefined ? String(b.status) : row.status;
    const m = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(machineId);
    if (!m) return res.status(400).json({ message: 'Thiết bị không tồn tại' });
    const p = db.prepare('SELECT id FROM crd_persons WHERE id = ?').get(personId);
    if (!p) return res.status(400).json({ message: 'Người dùng CRD không tồn tại' });
    if (endH <= startH) return res.status(400).json({ message: 'Giờ kết thúc phải sau giờ bắt đầu' });
    if (!crdIsHalfHourMark(startH) || !crdIsHalfHourMark(endH)) {
      return res.status(400).json({ message: 'Giờ đặt phải theo bước 30 phút (VD: 8:00, 8:30)' });
    }
    if (startH < m.avail_from || endH > m.avail_to) {
      return res.status(400).json({ message: 'Ngoài khung giờ mở của thiết bị' });
    }
    if (endH - startH > m.max_hours) {
      return res.status(400).json({ message: `Vượt tối đa ${m.max_hours} giờ` });
    }
    if (crdBookingOverlaps(machineId, date, startH, endH, id)) {
      return res.status(409).json({ message: 'Trùng lịch với booking khác' });
    }
    db.prepare(
      `UPDATE crd_bookings SET machine_id=?, person_id=?, date=?, start_h=?, end_h=?, purpose=?, research_group=?, status=?, updated_at=datetime('now') WHERE id=?`
    ).run(machineId, personId, date, startH, endH, purpose || '', researchGroup || '', status || 'confirmed', id);
    return res.json({ booking: crdBookingToClient(db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/admin/bookings/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const r = db.prepare('DELETE FROM crd_bookings WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

/** Phân tích sử dụng thiết bị CRD — routes/equipmentAnalytics.js (entry: server.js, không dùng app.js) */
try {
  const createEquipmentAnalyticsRouter = require('./routes/equipmentAnalytics');
  app.use('/api/equipment-analytics', authMiddleware, adminOnly, createEquipmentAnalyticsRouter({ db }));
  console.log('[CRD] Đã mount /api/equipment-analytics (admin)');
} catch (e) {
  console.warn('[CRD] Không mount equipment-analytics:', e.message);
}

/** Quản trị thiết bị (hồ sơ, PDF, video, QR) — db/equipment_schema.sql */
try {
  const equipmentSchemaPath = path.join(__dirname, 'db', 'equipment_schema.sql');
  if (fs.existsSync(equipmentSchemaPath)) {
    db.exec(fs.readFileSync(equipmentSchemaPath, 'utf8'));
  }
} catch (e) {
  console.warn('[db/equipment_schema]', e.message);
}
try {
  db.prepare('ALTER TABLE users ADD COLUMN department_id TEXT').run();
} catch (e) {
  /* đã có cột */
}

try {
  const equipmentP2 = path.join(__dirname, 'db', 'equipment_prompt2.sql');
  if (fs.existsSync(equipmentP2)) {
    db.exec(fs.readFileSync(equipmentP2, 'utf8'));
  }
} catch (e) {
  console.warn('[db/equipment_prompt2]', e.message);
}
(function equipmentPrompt2Alters() {
  const alters = [
    'ALTER TABLE equipments ADD COLUMN review_status TEXT',
    'ALTER TABLE equipments ADD COLUMN asset_group TEXT',
    'ALTER TABLE equipments ADD COLUMN published_at TEXT',
    'ALTER TABLE equipments ADD COLUMN review_rejection_note TEXT',
    'ALTER TABLE equipments ADD COLUMN created_by INTEGER REFERENCES users(id)',
    'ALTER TABLE equipments ADD COLUMN last_maintenance_date TEXT',
    'ALTER TABLE equipments ADD COLUMN next_maintenance_date TEXT',
    'ALTER TABLE equipments ADD COLUMN calibration_due_date TEXT',
    'ALTER TABLE equipments ADD COLUMN asset_type_code TEXT',
    'ALTER TABLE equipments ADD COLUMN year_in_use INTEGER',
    'ALTER TABLE equipments ADD COLUMN unit_name TEXT',
    'ALTER TABLE equipments ADD COLUMN quantity_book REAL',
    'ALTER TABLE equipments ADD COLUMN quantity_actual REAL',
    'ALTER TABLE equipments ADD COLUMN quantity_diff REAL',
    'ALTER TABLE equipments ADD COLUMN remaining_value REAL',
    'ALTER TABLE equipments ADD COLUMN utilization_note TEXT',
    'ALTER TABLE equipments ADD COLUMN condition_note TEXT',
    'ALTER TABLE equipments ADD COLUMN disaster_impact_note TEXT',
    'ALTER TABLE equipments ADD COLUMN construction_asset_note TEXT',
    'ALTER TABLE equipments ADD COLUMN usage_count_note TEXT',
    'ALTER TABLE equipments ADD COLUMN land_attached_note TEXT',
    'ALTER TABLE equipments ADD COLUMN asset_note TEXT',
    'ALTER TABLE equipment_documents ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE equipment_documents ADD COLUMN supersedes_id INTEGER REFERENCES equipment_documents(id)',
    "ALTER TABLE equipment_videos ADD COLUMN thumbnail_url TEXT",
  ];
  for (const sql of alters) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      /* đã có cột */
    }
  }
})();

(function migrateEquipmentUsageAndConditionCodes() {
  function stripVietnamese(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }
  function normalizeCode(v) {
    if (v == null) return null;
    const raw = String(v).trim();
    if (!raw) return null;
    const m = raw.match(/^([0-3])(?:\s*[:\-].*)?$/);
    if (m) return m[1];
    const key = stripVietnamese(raw).replace(/[^a-z0-9]+/g, ' ').trim();
    const map = {
      'chua ghi so ke toan': '0',
      'da ghi so ke toan': '1',
      'khong phai ghi so ke toan': '2',
      'khong co nhu cau su dung': '3',
      'con su dung duoc dang su dung dung muc dich': '0',
      'con su dung duoc dang su dung khong dung muc dich': '1',
      'con su dung duoc khong co nhu cau su dung': '2',
      'hong khong su dung duoc': '3',
    };
    if (map[key] != null) return map[key];
    if (key.includes('chua ghi so ke toan')) return '0';
    if (key.includes('da ghi so ke toan')) return '1';
    if (key.includes('khong phai ghi so ke toan')) return '2';
    if (key.includes('khong co nhu cau su dung')) return '3';
    if (key.includes('hong') && key.includes('khong su dung duoc')) return '3';
    if (key.includes('khong dung muc dich')) return '1';
    if (key.includes('dung muc dich')) return '0';
    return null;
  }
  try {
    const rows = db
      .prepare(
        `SELECT id, utilization_note, condition_note
         FROM equipments
         WHERE utilization_note IS NOT NULL OR condition_note IS NOT NULL`
      )
      .all();
    if (!rows || !rows.length) return;
    const upd = db.prepare(
      `UPDATE equipments
       SET utilization_note = ?, condition_note = ?, updated_at = datetime('now')
       WHERE id = ?`
    );
    let changed = 0;
    db.exec('BEGIN IMMEDIATE');
    for (const r of rows) {
      const u0 = r.utilization_note == null ? null : String(r.utilization_note);
      const c0 = r.condition_note == null ? null : String(r.condition_note);
      const u1 = normalizeCode(u0);
      const c1 = normalizeCode(c0);
      if (u1 !== u0 || c1 !== c0) {
        upd.run(u1, c1, r.id);
        changed += 1;
      }
    }
    db.exec('COMMIT');
    if (changed > 0) console.log('[EQUIP] normalized utilization/condition codes:', changed);
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    console.warn('[EQUIP] migrate codes:', e.message);
  }
})();

try {
  const createEquipmentRouter = require('./routes/equipment');
  const equipmentUploadsDir = appPaths.equipmentUploadsDir();
  fs.mkdirSync(equipmentUploadsDir, { recursive: true });
  function equipmentMailSend(opts) {
    if (!transporter || !opts) return Promise.resolve({ ok: false, reason: 'mail_not_configured' });
    const toList = Array.isArray(opts.to) ? opts.to.filter(Boolean) : opts.to ? [opts.to] : [];
    if (!toList.length) return Promise.resolve({ ok: false, reason: 'no_recipients' });
    const to = toList.join(', ');
    return transporter
      .sendMail({
        from: getSmtpFrom(),
        to,
        subject: opts.subject || 'Thông báo thiết bị',
        text: opts.text || '',
        html: opts.html || opts.text || '',
      })
      .then(() => ({ ok: true }))
      .catch((e) => {
        console.warn('[EQUIP mail]', e.message);
        return { ok: false, reason: 'smtp_error', error: e.message || 'smtp_error' };
      });
  }

  app.use(
    '/api/equipment',
    createEquipmentRouter({
      db,
      authMiddleware,
      adminOnly,
      getTokenFromReq,
      jwt,
      JWT_SECRET,
      userIdIsBanned,
      isMasterAdmin: reqIsMasterAdmin,
      uploadsEquipmentRoot: equipmentUploadsDir,
      uploadsRoot: appPaths.uploadsRoot(),
      equipmentMailSend,
    })
  );
  console.log('[EQUIP] Đã mount /api/equipment');
} catch (e) {
  console.warn('[EQUIP] Không mount equipment:', e.message);
}

/** Bảng dashboard_permissions (migrations/004_dashboard_permissions.sql) */
try {
  const dashPermSql = path.join(__dirname, 'migrations', '004_dashboard_permissions.sql');
  if (fs.existsSync(dashPermSql)) {
    db.exec(fs.readFileSync(dashPermSql, 'utf8'));
  }
} catch (e) {
  console.warn('[migrations/004_dashboard_permissions]', e.message);
}

/** Nhật ký truy cập dashboard (migrations/005_dashboard_access_log.sql) */
try {
  const dashLogSql = path.join(__dirname, 'migrations', '005_dashboard_access_log.sql');
  if (fs.existsSync(dashLogSql)) {
    db.exec(fs.readFileSync(dashLogSql, 'utf8'));
  }
} catch (e) {
  console.warn('[migrations/005_dashboard_access_log]', e.message);
}

try {
  const rowMode = db.prepare('SELECT 1 FROM system_settings WHERE key = ?').get('pub_analytics_access_mode');
  if (!rowMode) {
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run(
      'pub_analytics_access_mode',
      'whitelist'
    );
  }
  const rowSuf = db.prepare('SELECT 1 FROM system_settings WHERE key = ?').get('pub_analytics_email_suffix');
  if (!rowSuf) {
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run('pub_analytics_email_suffix', '@sci.edu.vn');
  }
  const rowSufVal = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('pub_analytics_email_suffix');
  if (rowSufVal && String(rowSufVal.value || '').toLowerCase() === '@sci.edu') {
    db.prepare('UPDATE system_settings SET value = ? WHERE key = ?').run('@sci.edu.vn', 'pub_analytics_email_suffix');
  }
} catch (e) {
  console.warn('[system_settings pub_analytics]', e.message);
}

/** CRUD quyền xem dashboard — routes/dashboardPermissions.js */
try {
  const createDashboardPermissionsRouter = require('./routes/dashboardPermissions');
  app.use(
    '/api/dashboard-perms',
    authUnlessDashboardPermCheck,
    createDashboardPermissionsRouter({
      db,
      isMasterAdmin: reqIsMasterAdmin,
      isUserMasterAdmin: (u) => userEmailIsMasterAdmin(u && u.email),
    })
  );
  console.log('[DASH] Đã mount /api/dashboard-perms');
} catch (e) {
  console.warn('[DASH] Không mount dashboard-perms:', e.message);
}

/** Quản lý tài liệu & hồ sơ (hành chính) — /api/dms */
try {
  const createDmsRecordsRouter = require('./routes/dmsRecords');
  const dmsUploadsRoot = appPaths.dmsUploadsDir();
  app.use(
    '/api/dms',
    authMiddleware,
    createDmsRecordsRouter({
      db,
      adminOnly,
      masterAdminOnly,
      isMasterAdmin: reqIsMasterAdmin,
      uploadsDir: dmsUploadsRoot,
    })
  );
  console.log('[DMS] Đã mount /api/dms');
} catch (e) {
  console.warn('[DMS] Không mount /api/dms:', e.message);
}

/** Thống kê công bố — theo chính sách pub_analytics (whitelist / nội bộ / STIMS / public) */
try {
  const createPublicationAnalyticsRouter = require('./routes/publicationAnalytics');
  const { createCheckPubAnalyticsAccess } = require('./middleware/pubAnalyticsAccess');
  const checkPubAnalytics = createCheckPubAnalyticsAccess(db, {
    isUserMasterAdmin: (u) => userEmailIsMasterAdmin(u && u.email),
  });
  app.use('/api/pub-analytics', optionalAuthMiddleware, checkPubAnalytics, createPublicationAnalyticsRouter({ db }));
  console.log('[PUB] Đã mount /api/pub-analytics (chính sách truy cập dashboard)');
} catch (e) {
  console.warn('[PUB] Không mount pub-analytics:', e.message);
}

/** Dev (Master Admin): cấu hình chính sách truy cập dashboard phân tích công bố */
app.get('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
  try {
    const { getPubAnalyticsSettings } = require('./middleware/pubAnalyticsAccess');
    const s = getPubAnalyticsSettings(db);
    return res.json({ ok: true, mode: s.mode, email_suffix: s.emailSuffix });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
  }
});

app.put('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
  try {
    const allowed = ['whitelist', 'internal_domain', 'stims_all', 'public'];
    const raw = req.body && req.body.mode != null ? String(req.body.mode).trim().toLowerCase() : '';
    if (!allowed.includes(raw)) {
      return res.status(400).json({ ok: false, error: 'mode không hợp lệ' });
    }
    let suffix = req.body && req.body.email_suffix != null ? String(req.body.email_suffix).trim().toLowerCase() : '@sci.edu.vn';
    if (suffix && !suffix.startsWith('@')) suffix = '@' + suffix;
    if (suffix.length < 2 || suffix.length > 80) {
      return res.status(400).json({ ok: false, error: 'email_suffix không hợp lệ' });
    }
    db.prepare(
      `INSERT INTO system_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('pub_analytics_access_mode', raw);
    db.prepare(
      `INSERT INTO system_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('pub_analytics_email_suffix', suffix);
    return res.json({ ok: true, mode: raw, email_suffix: suffix });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Lỗi' });
  }
});

/** Tìm user (autocomplete phân quyền dashboard) — chỉ Admin */
app.get('/api/users/search', authMiddleware, adminOrMasterAdminApi, (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 1) {
      return res.json({ ok: true, success: true, data: [] });
    }
    const safe = raw.replace(/[%_]/g, '').slice(0, 80);
    if (!safe) {
      return res.json({ ok: true, success: true, data: [] });
    }
    const like = `%${safe.toLowerCase()}%`;
    const rows = db
      .prepare(
        `SELECT id, email, fullname, role FROM users
         WHERE lower(COALESCE(fullname,'')) LIKE ?
            OR lower(COALESCE(email,'')) LIKE ?
         ORDER BY fullname COLLATE NOCASE
         LIMIT 30`
      )
      .all(like, like);
    return res.json({ ok: true, success: true, data: rows });
  } catch (e) {
    console.error('[GET /api/users/search]', e);
    return res.status(500).json({ ok: false, success: false, error: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/admin/chats/:id', authMiddleware, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const isSysAdmin = (req.user.role || '').toLowerCase() === 'admin';
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    const isBroadcast = row.to_id === CRD_BROADCAST_TO_ID;
    if (isBroadcast) {
      if (!isSysAdmin && !crdPersonHasModeratorSlot(mePersonId)) {
        return res.status(403).json({
          message: 'Chỉ quản trị hệ thống hoặc tài khoản có vai trò Admin CRD mới xóa được tin kênh chung.'
        });
      }
    } else if (!isSysAdmin) {
      return res.status(403).json({ message: 'Chỉ quản trị hệ thống mới xóa được tin nhắn riêng.' });
    }
    db.prepare('UPDATE crd_chats SET is_deleted = 1 WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

/**
 * Cài đặt email CRD (bảng users) gắn với tài khoản đăng nhập JWT — không phụ thuộc cột crd_persons.user_id.
 * (Cột user_id trên hồ sơ CRD chỉ là bản sao; trước đây thiếu cột dễ gây hiểu nhầm "Không liên kết tài khoản"
 * dù đã đăng nhập.)
 */
function crdEmailNotifUserId(req) {
  const mePersonId = crdEnsurePersonForAppUser(req.user);
  if (!mePersonId) return { error: 'Không xác định người dùng CRD' };
  const uid = Number(req.user && req.user.id);
  if (!Number.isFinite(uid)) return { error: 'Không xác định tài khoản đăng nhập' };
  try {
    db.prepare('UPDATE crd_persons SET user_id = ? WHERE id = ? AND (user_id IS NULL OR user_id = ?)').run(
      uid,
      mePersonId,
      uid
    );
  } catch (_) {
    /* ignore nếu DB cũ */
  }
  return { uid };
}

/** Toggle thông báo email CRD cho chính mình */
app.put('/api/crd/email-notif', authMiddleware, (req, res) => {
  try {
    const r = crdEmailNotifUserId(req);
    if (r.error) return res.status(403).json({ message: r.error });
    const val = req.body && req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : 1;
    db.prepare('UPDATE users SET crd_email_notif = ? WHERE id = ?').run(val, r.uid);
    return res.json({ ok: true, enabled: val === 1 });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

/** Lấy trạng thái thông báo email CRD của chính mình */
app.get('/api/crd/email-notif', authMiddleware, (req, res) => {
  try {
    const r = crdEmailNotifUserId(req);
    if (r.error) return res.status(403).json({ message: r.error });
    const row = db.prepare('SELECT crd_email_notif FROM users WHERE id = ?').get(r.uid);
    return res.json({ enabled: row && Number(row.crd_email_notif) === 1 });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.put('/api/crd/admin/complaints/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const row = db.prepare('SELECT * FROM crd_complaints WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const status = (b.status || row.status || 'open').trim();
    const adminNote = b.adminNote !== undefined ? String(b.adminNote) : row.admin_note;
    const allowed = ['open', 'in_review', 'resolved', 'rejected'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
    db.prepare('UPDATE crd_complaints SET status=?, admin_note=? WHERE id=?').run(status, adminNote || '', id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

app.delete('/api/crd/admin/complaints/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const r = db.prepare('DELETE FROM crd_complaints WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Lỗi' });
  }
});

// BỔ SUNG MODULE HỢP TÁC QUỐC TẾ — CÁC ROUTE & TÍNH NĂNG MỚI
// Các route CŨ giữ nguyên phía trên — file này CHỈ THÊM route mới
// ============================================================

// --- Tạo bảng lịch sử thao tác (nếu chưa có) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS coop_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loai TEXT NOT NULL,
    de_xuat_id INTEGER NOT NULL,
    buoc INTEGER NOT NULL DEFAULT 1,
    action TEXT NOT NULL,
    action_label TEXT,
    performed_by_id INTEGER,
    performed_by_name TEXT,
    performed_by_role TEXT,
    note TEXT,
    performed_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_coop_history ON coop_history(loai, de_xuat_id)').run(); } catch(e) {}

// --- Thêm cột mới vào các bảng hiện có (migration an toàn) ---
['cooperation_doan_ra','cooperation_doan_vao','cooperation_mou_de_xuat'].forEach(tbl => {
  [
    ['ma_de_xuat','TEXT'], ['submitted_by_id','INTEGER'],
    ['ghi_chu','TEXT'],    ['note_phong','TEXT'],
    ['note_vt','TEXT'],    ['phong_xu_ly_id','INTEGER'],
    ['phong_xu_ly_at','TEXT'], ['vt_xu_ly_id','INTEGER'],
    ['vt_xu_ly_at','TEXT'],
    ['van_ban_word_path','TEXT'],
    ['van_ban_word_original_name','TEXT'],
    ['van_ban_word_uploaded_at','TEXT'],
  ].forEach(([col, type]) => {
    try { db.prepare(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${type}`).run(); } catch(e) {}
  });
});
// Thêm cột cho htqt_de_xuat (đồng bộ quy trình với Đoàn ra / MOU: ghi chú, phê duyệt, Word)
[['note_phong','TEXT'],['note_vt','TEXT'],['phong_xu_ly_id','INTEGER'],['phong_xu_ly_at','TEXT'],
 ['vt_xu_ly_id','INTEGER'],['vt_xu_ly_at','TEXT'],
 ['van_ban_word_path','TEXT'],['van_ban_word_original_name','TEXT'],['van_ban_word_uploaded_at','TEXT']].forEach(([col,type]) => {
  try { db.prepare(`ALTER TABLE htqt_de_xuat ADD COLUMN ${col} ${type}`).run(); } catch(e) {}
});

// --- Bảng Sự kiện Quốc tế (mới) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS cooperation_su_kien (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tieu_de TEXT NOT NULL,
    mo_ta TEXT,
    loai_su_kien TEXT DEFAULT 'hoi_thao',
    quoc_gia TEXT,
    dia_diem TEXT,
    ngay_bat_dau TEXT NOT NULL,
    ngay_ket_thuc TEXT,
    don_vi_to_chuc TEXT,
    link_su_kien TEXT,
    han_dang_ky TEXT,
    kinh_phi_tham_du TEXT,
    ghi_chu TEXT,
    tags TEXT,
    status TEXT DEFAULT 'sap_dien_ra',
    created_by_id INTEGER,
    created_by_name TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

// --- Migrate status cũ sang mới (an toàn, không phá dữ liệu) ---
try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_phong_duyet' WHERE status='cho_tham_dinh'").run(); } catch(e) {}
try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_vt_duyet' WHERE status='cho_ky_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE cooperation_mou_de_xuat SET status='cho_phong_duyet' WHERE status='dang_tham_dinh'").run(); } catch(e) {}
// Đoàn ra: trạng thái cũ cho_ky_duyet (nhầm với VT) → chờ Phòng KHCN thẩm định trước
try { db.prepare("UPDATE cooperation_doan_ra SET status='cho_phong_duyet' WHERE lower(trim(status))='cho_ky_duyet'").run(); } catch(e) {}
// YTNN: đồng bộ tên trạng thái với Đoàn ra / MOU (cho_phong_duyet → cho_vt_duyet → da_duyet / tu_choi)
try { db.prepare("UPDATE htqt_de_xuat SET status='cho_phong_duyet' WHERE status='cho_phan_loai'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='cho_vt_duyet' WHERE status='cho_vt_phe_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='da_duyet' WHERE status='da_phe_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='tu_choi' WHERE status='khong_phe_duyet'").run(); } catch(e) {}

// --- Tạo mã định danh cho đề xuất chưa có mã ---
(function backfillMaDexuat() {
  const year = new Date().getFullYear();
  [
    { table: 'cooperation_doan_ra',    prefix: 'DR' },
    { table: 'cooperation_doan_vao',   prefix: 'DV' },
    { table: 'cooperation_mou_de_xuat',prefix: 'MU' },
    { table: 'htqt_de_xuat',           prefix: 'YT' },
  ].forEach(({ table, prefix }) => {
    try {
      const rows = db.prepare(`SELECT id FROM ${table} WHERE ma_de_xuat IS NULL OR ma_de_xuat = ''`).all();
      rows.forEach(r => {
        const ma = `ĐX-${year}-${prefix}${String(r.id).padStart(4,'0')}`;
        db.prepare(`UPDATE ${table} SET ma_de_xuat=? WHERE id=?`).run(ma, r.id);
      });
    } catch(e) {}
  });
})();

// Cột nhắc nội bộ (không hiển thị trên giao diện người nộp đề xuất)
['cooperation_doan_ra', 'cooperation_doan_vao', 'cooperation_mou_de_xuat', 'htqt_de_xuat'].forEach(tbl => {
  try { db.prepare(`ALTER TABLE ${tbl} ADD COLUMN coop_reminder_last_at TEXT`).run(); } catch (e) { /* đã có */ }
});

// ============================================================
// HELPER FUNCTIONS MỚI
// ============================================================

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
    return { sent: 0, error: e.message };
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

try {
  const createConferenceRegistrationRouter = require('./routes/conferenceRegistration');
  const confUploadDir = path.join(uploadDir, 'conference');
  fs.mkdirSync(confUploadDir, { recursive: true });
  app.use(
    '/api/conference-registrations',
    authMiddleware,
    createConferenceRegistrationRouter({
      db,
      coopSendMail,
      coopBuildEmail,
      baseUrl: process.env.BASE_URL || 'http://localhost:' + PORT,
      coopIsVienTruong,
    })
  );
  console.log('[HNHT] Đã mount /api/conference-registrations');
} catch (e) {
  console.warn('[HNHT] Không mount conference-registrations:', e.message);
}

function coopFmtDate(s) {
  if (!s) return '—';
  const d = String(s).slice(0,10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
}

const STATUS_LABELS_COOP = {
  cho_phong_duyet:  'Chờ Phòng KHCN thẩm định',
  cho_phan_loai:    'Chờ Phòng KHCN phân loại',
  yeu_cau_bo_sung:  'Yêu cầu bổ sung hồ sơ',
  cho_vt_duyet:     'Chờ Viện trưởng phê duyệt',
  cho_vt_phe_duyet: 'Chờ Viện trưởng phê duyệt',
  da_duyet:         'Đã phê duyệt',
  da_phe_duyet:     'Đã phê duyệt',
  tu_choi:          'Không phê duyệt',
  khong_phe_duyet:  'Không phê duyệt',
  hoan_thanh:       'Hoàn thành',
  ket_thuc_boi_nguoi_nop: 'Đã kết thúc (người gửi không nộp lại)',
  // legacy
  dang_tham_dinh:   'Chờ Phòng KHCN thẩm định',
  cho_ky_duyet:     'Chờ Viện trưởng phê duyệt',
  cho_tham_dinh:    'Chờ Phòng KHCN thẩm định',
};

function coopIsManager(req) {
  const role = (req.user && req.user.role || '').toLowerCase();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  return role === 'admin' || role === 'phong_khcn' || coopIsVienTruong(email);
}

function coopCanDownloadDoanRaVanBan(req, row) {
  if (!row || !row.van_ban_word_path) return false;
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin') return true;
  if (role === 'phong_khcn') return true;
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  if (email && (row.submitted_by_email || '').trim().toLowerCase() === email) return true;
  if (coopIsVienTruong(email)) return true;
  return false;
}

function coopUnlinkDoanRaVanBanFile(row) {
  if (!row || !row.van_ban_word_path) return;
  try {
    const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
    if (abs) fs.unlinkSync(abs);
  } catch (e) {}
}

function coopCanDownloadDoanVaoVanBan(req, row) {
  return coopCanDownloadDoanRaVanBan(req, row);
}

function coopUnlinkDoanVaoVanBanFile(row) {
  if (!row || !row.van_ban_word_path) return;
  try {
    const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
    if (abs) fs.unlinkSync(abs);
  } catch (e) {}
}

function coopCanDownloadMouVanBan(req, row) {
  return coopCanDownloadDoanRaVanBan(req, row);
}

function coopUnlinkMouVanBanFile(row) {
  if (!row || !row.van_ban_word_path) return;
  try {
    const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
    if (abs) fs.unlinkSync(abs);
  } catch (e) {}
}

function coopCanDownloadYtnnVanBan(req, row) {
  return coopCanDownloadDoanRaVanBan(req, row);
}

function coopUnlinkYtnnVanBanFile(row) {
  if (!row || !row.van_ban_word_path) return;
  try {
    const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
    if (abs) fs.unlinkSync(abs);
  } catch (e) {}
}

function coopFmtDateVN(s) {
  if (!s) return '—';
  const d = String(s).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(s).slice(0, 10);
}

function coopDaysLabelDoanRa(ngayDi, ngayVe) {
  try {
    const a = new Date(String(ngayDi).slice(0, 10));
    const b = new Date(String(ngayVe).slice(0, 10));
    const n = Math.round((b - a) / 86400000) + 1;
    if (isNaN(n) || n < 1) return '—';
    return `${n} ngày`;
  } catch (e) {
    return '—';
  }
}

function coopParseThanhVienDoanRa(text) {
  const raw = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    let stt = String(i + 1);
    let ho_ten = line;
    let chuc_vu = '';
    const num = line.match(/^(\d+)[\.\)]\s*(.+)$/);
    if (num) {
      stt = num[1];
      line = num[2].trim();
    }
    const parts = line.split('|').map(s => s.trim());
    if (parts.length >= 2) {
      ho_ten = parts[0];
      chuc_vu = parts.slice(1).join(' | ');
    } else {
      const dash = line.match(/^(.+?)\s*[–—-]\s*(.+)$/);
      if (dash) {
        ho_ten = dash[1].trim();
        chuc_vu = dash[2].trim();
      }
    }
    const ho = ho_ten || line;
    const cv = chuc_vu || 'Thành viên';
    out.push({
      stt,
      ho_ten: ho,
      chuc_vu: cv,
      hoTen: ho,
      chucVu: cv,
      ho_ten_chuc_vu: cv ? `${ho} — ${cv}` : ho
    });
  }
  if (!out.length) out.push({ stt: '1', ho_ten: '—', chuc_vu: '—', hoTen: '—', chucVu: '—', ho_ten_chuc_vu: '—' });
  return out;
}

/** Không điền chữ ký khi tên chỉ là tài khoản test (tránh “Admin” in trên mẫu). */
function coopMergePersonLine(name, email) {
  const raw = ((name || '').trim() || (email || '').trim());
  if (!raw) return '';
  if (/^admin$/i.test(raw)) return '';
  if (/^admin@/i.test(raw)) return '';
  return raw;
}

function coopBuildDoanRaMergeData(row) {
  let nguoiPheDuyetKy = '';
  try {
    if (row.vt_xu_ly_id) {
      const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.vt_xu_ly_id);
      if (u) nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
    }
  } catch (e) {}
  const nguoiPheDuyetBang = nguoiPheDuyetKy || '—';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  let duToanStr = '—';
  if (row.du_toan != null && String(row.du_toan).trim() !== '') {
    const s = String(row.du_toan).trim();
    duToanStr = /(usd|vnd|vnđ|đồng|\bđ\b)/i.test(s) ? s : `${s} VND`;
  }
  const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : '—';
  const ma = row.ma_de_xuat || coopGenMa('doan_ra', row.id);
  const tieuDeToTrinh = (row.muc_dich || '').trim() || 'Tờ trình v/v đoàn công tác nước ngoài';
  const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
  const thanhVienList = coopParseThanhVienDoanRa(row.thanh_vien);
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    quoc_gia: row.quoc_gia || '—',
    muc_dich: row.muc_dich || '—',
    ngay_di: coopFmtDateVN(row.ngay_di),
    ngay_ve: coopFmtDateVN(row.ngay_ve),
    tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_di, row.ngay_ve),
    nguon_kinh_phi: row.nguon_kinh_phi || '—',
    du_toan: duToanStr,
    du_toan_vnd: duToanStr,
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay,
    thanh_vien: thanhVienList,
    thanh_phan: thanhVienList,
    thanhPhan: thanhVienList
  };
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
    can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất như sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    so_ngay: core.tong_thoi_gian,
    du_toan_usd: duToanStr,
    danh_sach_thanh_vien: (row.thanh_vien || '').trim() ? String(row.thanh_vien).trim() : '—',
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: '—'
  });
}

const CAN_CU_DOAN_RA_DAY_DU = 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất như sau:';

/**
 * Một số mẫu .docx vẫn gõ sẵn chữ (không chỉ placeholder) — docxtemplater không ghi đè.
 * Hậu xử lý XML trong file đã merge để đồng bộ lời kính gửi, căn cứ, và bỏ chữ ký "Admin" test.
 */
function coopPostProcessDoanRaDocxBuffer(buf) {
  try {
    const zip = new PizZip(buf);
    const rePath = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;
    for (const p of Object.keys(zip.files)) {
      if (!rePath.test(p) || zip.files[p].dir) continue;
      let xml = zip.file(p).asText();
      if (!xml) continue;
      xml = xml.replace(/Ban Giám hiệu\s*\/\s*/g, '');
      xml = xml.replace(
        /<w:t([^>]*)>(Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST\.)<\/w:t>/g,
        (m, attrs) => {
          if (m.includes('tôi đề nghị')) return m;
          return `<w:t${attrs}>${CAN_CU_DOAN_RA_DAY_DU}</w:t>`;
        }
      );
      xml = xml.replace(/<w:t([^>]*)>Admin<\/w:t>/g, '<w:t$1></w:t>');
      zip.file(p, xml);
    }
    return zip.generate({ type: 'nodebuffer' });
  } catch (e) {
    console.warn('[doan_ra] post-process docx:', e.message);
    return buf;
  }
}

function coopMergeDoanRaDocx(row) {
  if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình (menu trong chi tiết Đoàn ra).');
  }
  const content = fs.readFileSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: function () { return ''; }
  });
  doc.render(coopBuildDoanRaMergeData(row));
  let out = doc.getZip().generate({ type: 'nodebuffer' });
  out = coopPostProcessDoanRaDocxBuffer(out);
  return out;
}

/**
 * Sinh file Word từ mẫu Tờ trình Đoàn ra (một file .docx chung cho loại đề xuất này) và ghi vào van_ban_word_*.
 * Dùng sau khi phê duyệt để người gửi không phải chờ Admin.
 */
function coopTryAutoGenerateDoanRaVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return { ok: false, skipped: 'bad_id' };
  if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) {
    return { ok: false, skipped: 'no_template' };
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
      return { ok: false, skipped: 'not_approved' };
    }
    const buf = coopMergeDoanRaDocx(row);
    coopUnlinkDoanRaVanBanFile(row);
    const safeMa = (row.ma_de_xuat || 'doan-ra-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
    const outName = `To-trinh-${safeMa}.docx`;
    const outRel = path.join('uploads', 'htqt-doan-ra', 'doan_ra_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
    const abs = path.join(__dirname, outRel);
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[doan_ra] auto Word:', e);
    return { ok: false, skipped: 'error', message: e.message || String(e) };
  }
}

function coopBuildDoanVaoMergeData(row) {
  let nguoiPheDuyetKy = '';
  try {
    if (row.vt_xu_ly_id) {
      const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.vt_xu_ly_id);
      if (u) nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
    }
  } catch (e) {}
  const nguoiPheDuyetBang = nguoiPheDuyetKy || '—';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const kinhPhiStr = (row.kinh_phi_nguon != null && String(row.kinh_phi_nguon).trim()) ? String(row.kinh_phi_nguon).trim() : '—';
  const ma = row.ma_de_xuat || coopGenMa('doan_vao', row.id);
  const tieuDeToTrinh = (row.muc_dich || '').trim() || 'Tờ trình v/v tiếp nhận đoàn khách quốc tế';
  const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
  const noiParts = [row.noi_dung_lam_viec, row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : '—';
  const thanhVienParsed = coopParseThanhVienDoanRa(row.thanh_phan_doan);
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    quoc_gia: row.don_vi_de_xuat || '—',
    don_vi_de_xuat: row.don_vi_de_xuat || '—',
    muc_dich: row.muc_dich || '—',
    ngay_den: coopFmtDateVN(row.ngay_den),
    ngay_roi_di: coopFmtDateVN(row.ngay_roi_di),
    ngay_di: coopFmtDateVN(row.ngay_den),
    ngay_ve: coopFmtDateVN(row.ngay_roi_di),
    tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_den, row.ngay_roi_di),
    nguon_kinh_phi: kinhPhiStr,
    du_toan: kinhPhiStr,
    du_toan_vnd: kinhPhiStr,
    ho_tro_visa: row.ho_tro_visa || '—',
    noi_dung_lam_viec: row.noi_dung_lam_viec || '—',
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay,
    thanh_vien: thanhVienParsed,
    thanh_phan: thanhVienParsed,
    thanhPhan: thanhVienParsed
  };
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
    can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất tiếp nhận đoàn khách/quốc tế như sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    so_ngay: core.tong_thoi_gian,
    du_toan_usd: kinhPhiStr,
    danh_sach_thanh_vien: (row.thanh_phan_doan || '').trim() ? String(row.thanh_phan_doan).trim() : '—',
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: '—'
  });
}

function coopMergeDoanVaoDocx(row) {
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình Đoàn vào (menu trong chi tiết đề xuất).');
  }
  const content = fs.readFileSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: function () { return ''; }
  });
  doc.render(coopBuildDoanVaoMergeData(row));
  let out = doc.getZip().generate({ type: 'nodebuffer' });
  out = coopPostProcessDoanRaDocxBuffer(out);
  return out;
}

function coopTryAutoGenerateDoanVaoVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return { ok: false, skipped: 'bad_id' };
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) {
    return { ok: false, skipped: 'no_template' };
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
      return { ok: false, skipped: 'not_approved' };
    }
    const buf = coopMergeDoanVaoDocx(row);
    coopUnlinkDoanVaoVanBanFile(row);
    const safeMa = (row.ma_de_xuat || 'doan-vao-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
    const outName = `To-trinh-${safeMa}.docx`;
    const outRel = path.join('uploads', 'htqt-doan-vao', 'doan_vao_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
    const abs = path.join(__dirname, outRel);
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[doan_vao] auto Word:', e);
    return { ok: false, skipped: 'error', message: e.message || String(e) };
  }
}

/** Bản merge tự sinh có đường dẫn chứa `_to_trinh_`. File admin tải tay thay thế không có — không tự ghép đè. */
function coopVanBanIsAutoMergedOutput(relPath) {
  return !!(relPath && String(relPath).includes('_to_trinh_'));
}

/**
 * Đề xuất đã phê duyệt: sinh lần đầu nếu chưa có file.
 * Nếu đã có bản tự sinh và mẫu `to-trinh-template.docx` mới hơn file merge → ghép lại (đổi mẫu [1] không cần bấm Sinh lại thủ công).
 */
function coopEnsureFreshDoanRaVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return null;
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(nid);
  if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
  if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) return row;
  let tplMs = 0;
  try { tplMs = fs.statSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
  let shouldRegen = false;
  if (!row.van_ban_word_path) {
    shouldRegen = true;
  } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
    const abs = path.join(__dirname, row.van_ban_word_path);
    if (!fs.existsSync(abs)) {
      shouldRegen = true;
    } else {
      try {
        if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
      } catch (e) {}
    }
  }
  if (!shouldRegen) return row;
  try {
    const gen = coopTryAutoGenerateDoanRaVanBan(nid);
    if (gen && gen.ok) return db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(nid);
  } catch (e) {}
  return row;
}

function coopEnsureFreshDoanVaoVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return null;
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(nid);
  if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) return row;
  let tplMs = 0;
  try { tplMs = fs.statSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
  let shouldRegen = false;
  if (!row.van_ban_word_path) {
    shouldRegen = true;
  } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
    const abs = path.join(__dirname, row.van_ban_word_path);
    if (!fs.existsSync(abs)) {
      shouldRegen = true;
    } else {
      try {
        if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
      } catch (e) {}
    }
  }
  if (!shouldRegen) return row;
  try {
    const gen = coopTryAutoGenerateDoanVaoVanBan(nid);
    if (gen && gen.ok) return db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(nid);
  } catch (e) {}
  return row;
}

function coopBuildMouMergeData(row) {
  let nguoiPheDuyetKy = '';
  try {
    if (row.vt_xu_ly_id) {
      const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.vt_xu_ly_id);
      if (u) nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
    }
  } catch (e) {}
  const nguoiPheDuyetBang = nguoiPheDuyetKy || '—';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const ma = row.ma_de_xuat || coopGenMa('mou', row.id);
  const loaiTT = (row.loai_thoa_thuan || '').trim();
  const tenDt = (row.ten_doi_tac || '').trim();
  const tieuDeToTrinh = [loaiTT, tenDt].filter(Boolean).join(' — ') || 'Tờ trình v/v đề xuất Thỏa thuận hợp tác';
  const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
  const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : '—';
  const thoiHanStr = (row.thoi_han_nam != null && String(row.thoi_han_nam).trim() !== '') ? String(row.thoi_han_nam).trim() : '—';
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    loai_thoa_thuan: row.loai_thoa_thuan || '—',
    ten_doi_tac: row.ten_doi_tac || '—',
    quoc_gia: row.quoc_gia || '—',
    thoi_han_nam: thoiHanStr,
    gia_tri_tai_chinh: row.gia_tri_tai_chinh || '—',
    don_vi_de_xuat: row.don_vi_de_xuat || '—',
    noi_dung_hop_tac: row.noi_dung_hop_tac || '—',
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay
  };
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
    can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất ký kết thỏa thuận hợp tác như sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: '—'
  });
}

function coopMergeMouDocx(row) {
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình Thỏa thuận/MOU (menu trong chi tiết đề xuất).');
  }
  const content = fs.readFileSync(MOU_TO_TRINH_TEMPLATE_PATH);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: function () { return ''; }
  });
  doc.render(coopBuildMouMergeData(row));
  let out = doc.getZip().generate({ type: 'nodebuffer' });
  out = coopPostProcessDoanRaDocxBuffer(out);
  return out;
}

function coopTryAutoGenerateMouVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return { ok: false, skipped: 'bad_id' };
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) {
    return { ok: false, skipped: 'no_template' };
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
      return { ok: false, skipped: 'not_approved' };
    }
    const buf = coopMergeMouDocx(row);
    coopUnlinkMouVanBanFile(row);
    const safeMa = (row.ma_de_xuat || 'mou-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
    const outName = `To-trinh-${safeMa}.docx`;
    const outRel = path.join('uploads', 'htqt-mou', 'mou_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
    const abs = path.join(__dirname, outRel);
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[mou] auto Word:', e);
    return { ok: false, skipped: 'error', message: e.message || String(e) };
  }
}

function coopEnsureFreshMouVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return null;
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(nid);
  if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) return row;
  let tplMs = 0;
  try { tplMs = fs.statSync(MOU_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
  let shouldRegen = false;
  if (!row.van_ban_word_path) {
    shouldRegen = true;
  } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
    const abs = path.join(__dirname, row.van_ban_word_path);
    if (!fs.existsSync(abs)) {
      shouldRegen = true;
    } else {
      try {
        if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
      } catch (e) {}
    }
  }
  if (!shouldRegen) return row;
  try {
    const gen = coopTryAutoGenerateMouVanBan(nid);
    if (gen && gen.ok) return db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(nid);
  } catch (e) {}
  return row;
}

function coopBuildYtnnMergeData(row) {
  let nguoiPheDuyetKy = '';
  let nguoiPheDuyetRaw = '';
  try {
    const uid = row.vt_xu_ly_id || row.vt_nguoi_ky_id;
    if (uid) {
      const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(uid);
      if (u) {
        nguoiPheDuyetRaw = (u.fullname || u.email || '').trim();
        nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
      }
    }
  } catch (e) {}
  const nguoiPheDuyetBang = nguoiPheDuyetKy || nguoiPheDuyetRaw || '—';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const ma = row.ma_de_xuat || coopGenMa('ytnn', row.id);
  const tenDeTai = (row.ten || '').trim();
  const tenDt = (row.doi_tac_ten || '').trim();
  // Mẫu thường gõ "V/v {tieu_de_to_trinh}" — không lặp chữ "Tờ trình v/v" trong giá trị
  const tieuDeToTrinh = tenDeTai
    ? ('đề xuất đề tài YTNN — ' + tenDeTai)
    : 'đề xuất đề tài có yếu tố nước ngoài';
  const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
  const noiParts = [row.mo_ta, row.ghi_chu_noi_bo, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : '—';
  const moTaGoc = (row.mo_ta && String(row.mo_ta).trim()) ? String(row.mo_ta).trim() : '';
  const moTaMotDong = moTaGoc ? moTaGoc.replace(/\s+/g, ' ') : '—';
  const donViTien = ((row.don_vi_tien_te != null && String(row.don_vi_tien_te).trim()) ? String(row.don_vi_tien_te).trim() : 'VNĐ');
  let kinhPhiSo = '—';
  if (row.kinh_phi != null && String(row.kinh_phi).trim() !== '') {
    const n = Number(row.kinh_phi);
    kinhPhiSo = Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : String(row.kinh_phi).trim();
  }
  let kinhPhiStr = '—';
  if (kinhPhiSo !== '—') kinhPhiStr = `${kinhPhiSo} ${donViTien}`;
  const qgDt = row.doi_tac_quoc_gia || '—';
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    ten_de_tai: tenDeTai || '—',
    ten_doi_tac: tenDt || '—',
    ten_to_chuc_doi_tac: tenDt || '—',
    quoc_gia: qgDt,
    quoc_gia_doi_tac: qgDt,
    nguoi_dai_dien_doi_tac: (row.doi_tac_nguoi_dai_dien && String(row.doi_tac_nguoi_dai_dien).trim()) ? String(row.doi_tac_nguoi_dai_dien).trim() : '—',
    website_doi_tac: (row.doi_tac_website && String(row.doi_tac_website).trim()) ? String(row.doi_tac_website).trim() : '—',
    loai_hinh: row.loai_hinh || '—',
    hinh_thuc_hop_tac: row.hinh_thuc_hop_tac || '—',
    chu_nhiem: row.chu_nhiem_ten || '—',
    chu_nhiem_de_tai: row.chu_nhiem_ten || '—',
    chu_nhiem_hoc_vi: row.chu_nhiem_hoc_vi || '—',
    hoc_ham_hoc_vi: row.chu_nhiem_hoc_vi || '—',
    chu_nhiem_don_vi: row.chu_nhiem_don_vi || '—',
    don_vi_chu_nhiem: row.chu_nhiem_don_vi || '—',
    kinh_phi: kinhPhiSo,
    don_vi_tien_te: donViTien,
    ngay_bat_dau: coopFmtDateVN(row.ngay_bat_dau),
    ngay_ket_thuc: coopFmtDateVN(row.ngay_ket_thuc),
    thoi_gian_thang: row.thoi_gian_thang != null && String(row.thoi_gian_thang).trim() !== '' ? String(row.thoi_gian_thang).trim() : '—',
    mo_ta: moTaMotDong,
    mo_ta_de_tai: moTaGoc || '—',
    noi_dung_hop_tac: moTaGoc || '—',
    gia_tri_tai_chinh: kinhPhiStr,
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay
  };
  const tenVtHienThi = nguoiPheDuyetKy || nguoiPheDuyetRaw || '—';
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    loai_thoa_thuan: core.loai_hinh,
    thoi_han_nam: core.thoi_gian_thang,
    don_vi_de_xuat: core.chu_nhiem_don_vi,
    nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
    can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất tiếp nhận đề tài có yếu tố nước ngoài như sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: tenVtHienThi,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: '—'
  });
}

function coopMergeYtnnDocx(row) {
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình Đề tài YTNN (menu trong chi tiết đề xuất).');
  }
  const content = fs.readFileSync(YTNN_TO_TRINH_TEMPLATE_PATH);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: function () { return ''; }
  });
  doc.render(coopBuildYtnnMergeData(row));
  let out = doc.getZip().generate({ type: 'nodebuffer' });
  out = coopPostProcessDoanRaDocxBuffer(out);
  return out;
}

function coopTryAutoGenerateYtnnVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return { ok: false, skipped: 'bad_id' };
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) {
    return { ok: false, skipped: 'no_template' };
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
      return { ok: false, skipped: 'not_approved' };
    }
    const buf = coopMergeYtnnDocx(row);
    coopUnlinkYtnnVanBanFile(row);
    const safeMa = (row.ma_de_xuat || 'ytnn-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
    const outName = `To-trinh-${safeMa}.docx`;
    const outRel = path.join('uploads', 'htqt-ytnn', 'ytnn_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
    const abs = path.join(__dirname, outRel);
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[ytnn] auto Word:', e);
    return { ok: false, skipped: 'error', message: e.message || String(e) };
  }
}

function coopEnsureFreshYtnnVanBan(id) {
  const nid = parseInt(id, 10);
  if (!nid) return null;
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(nid);
  if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) return row;
  let tplMs = 0;
  try { tplMs = fs.statSync(YTNN_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
  let shouldRegen = false;
  if (!row.van_ban_word_path) {
    shouldRegen = true;
  } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
    const abs = path.join(__dirname, row.van_ban_word_path);
    if (!fs.existsSync(abs)) {
      shouldRegen = true;
    } else {
      try {
        if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
      } catch (e) {}
    }
  }
  if (!shouldRegen) return row;
  try {
    const gen = coopTryAutoGenerateYtnnVanBan(nid);
    if (gen && gen.ok) return db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(nid);
  } catch (e) {}
  return row;
}

// Middleware phân quyền mới
function coopPhongOrAdmin(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin' || role === 'phong_khcn') return next();
  return res.status(403).json({ message: 'Chỉ Phòng KHCN hoặc Admin mới có quyền này.' });
}
function coopVTOrAdmin(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  if (coopIsVienTruong(email)) return next();
  return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới có quyền này.' });
}

const COOP_DASH_TABLES = ['cooperation_doan_ra', 'cooperation_doan_vao', 'cooperation_mou_de_xuat', 'htqt_de_xuat'];
const COOP_PENDING_STATUSES = new Set([
  'dang_tham_dinh', 'cho_ky_duyet', 'cho_tham_dinh', 'cho_phong_duyet', 'cho_vt_duyet', 'cho_vt_phe_duyet',
  'yeu_cau_bo_sung', 'cho_phan_loai', 'dang_chuan_bi'
]);

function coopDashGroupByStatus(table, emailLower) {
  try {
    const sql = emailLower
      ? `SELECT lower(trim(COALESCE(status,''))) AS st, COUNT(*) AS c FROM ${table} WHERE lower(trim(submitted_by_email)) = ? GROUP BY lower(trim(COALESCE(status,'')))`
      : `SELECT lower(trim(COALESCE(status,''))) AS st, COUNT(*) AS c FROM ${table} GROUP BY lower(trim(COALESCE(status,'')))`;
    return emailLower ? db.prepare(sql).all(emailLower) : db.prepare(sql).all();
  } catch (e) {
    return [];
  }
}

function coopDashGroupByMonth(table, emailLower) {
  try {
    const sql = emailLower
      ? `SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS c FROM ${table} WHERE created_at IS NOT NULL AND trim(CAST(created_at AS TEXT)) != '' AND lower(trim(submitted_by_email)) = ? GROUP BY ym HAVING ym IS NOT NULL AND length(ym) >= 7`
      : `SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS c FROM ${table} WHERE created_at IS NOT NULL AND trim(CAST(created_at AS TEXT)) != '' GROUP BY ym HAVING ym IS NOT NULL AND length(ym) >= 7`;
    return emailLower ? db.prepare(sql).all(emailLower) : db.prepare(sql).all();
  } catch (e) {
    return [];
  }
}

function coopDashMergeStatusBuckets(emailLower) {
  const merged = {};
  for (const t of COOP_DASH_TABLES) {
    for (const r of coopDashGroupByStatus(t, emailLower)) {
      const st = (r.st || '').toLowerCase();
      merged[st] = (merged[st] || 0) + (r.c || 0);
    }
  }
  const by = { dang_xu_ly: 0, da_phe_duyet: 0, tu_choi: 0, ket_thuc: 0, khac: 0 };
  for (const st of Object.keys(merged)) {
    const n = merged[st] || 0;
    if (!st) {
      by.khac += n;
      continue;
    }
    if (st === 'da_duyet' || st === 'da_phe_duyet' || st === 'hoan_thanh') by.da_phe_duyet += n;
    else if (st === 'tu_choi' || st === 'khong_phe_duyet') by.tu_choi += n;
    else if (st.indexOf('ket_thuc') >= 0) by.ket_thuc += n;
    else if (COOP_PENDING_STATUSES.has(st)) by.dang_xu_ly += n;
    else by.khac += n;
  }
  return by;
}

function coopDashLast12MonthsKeys() {
  const keys = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

function coopDashSeries12m(emailLower) {
  const acc = {};
  for (const t of COOP_DASH_TABLES) {
    for (const r of coopDashGroupByMonth(t, emailLower)) {
      const ym = r.ym;
      if (!ym || String(ym).length < 7) continue;
      acc[ym] = (acc[ym] || 0) + (r.c || 0);
    }
  }
  return coopDashLast12MonthsKeys().map(month => ({ month, total: acc[month] || 0 }));
}

/** Chỉ Quản trị viện, Phòng KHCN, Viện trưởng — Dashboard tổng thể không dành cho user thường */
function coopDashboardViewer(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  if (role === 'admin' || role === 'phong_khcn' || coopIsVienTruong(email)) return next();
  return res.status(403).json({ message: 'Chỉ Quản trị viện, Phòng KHCN hoặc Viện trưởng mới xem được Dashboard.' });
}

// Badge sidebar — mọi user đăng nhập (không lộ thống kê hệ thống)
app.get('/api/cooperation/sidebar-badges', authMiddleware, (req, res) => {
  try {
    const role = (req.user.role || '').toLowerCase();
    const email = (req.user.email || '').trim().toLowerCase();
    const isManager = role === 'admin' || role === 'phong_khcn' || coopIsVienTruong(email);

    const safeCount = (sql, ...params) => {
      try { return (db.prepare(sql).get(...params) || {}).c || 0; } catch (e) { return 0; }
    };

    let my_doan_ra = 0;
    let my_doan_vao = 0;
    let my_mou = 0;
    let my_ytnn = 0;
    let my_hnht = 0;
    if (email) {
      my_doan_ra = safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE lower(trim(submitted_by_email))=?", email);
      my_doan_vao = safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(submitted_by_email))=?", email);
      my_mou = safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE lower(trim(submitted_by_email))=?", email);
      my_ytnn = safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE lower(trim(submitted_by_email))=?", email);
    }
    try {
      const uid = email ? db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email) : null;
      if (uid && uid.id != null) {
        my_hnht = safeCount(
          "SELECT COUNT(*) AS c FROM conference_registrations WHERE submitted_by_user_id = ? AND status != 'cancelled'",
          uid.id
        );
      }
    } catch (_) {}
    const de_xuat_cua_toi = my_doan_ra + my_doan_vao + my_mou + my_ytnn + my_hnht;

    let cho_phong = 0;
    let cho_vt = 0;
    let tat_ca_tong = 0;
    if (isManager) {
      cho_phong =
        safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status IN ('cho_phong_duyet')")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status IN ('cho_phong_duyet','cho_tham_dinh')")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status IN ('cho_phong_duyet','dang_tham_dinh')")
        + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_phong_duyet','cho_phan_loai','dang_tham_dinh')")
        + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')");
      cho_vt =
        safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status='cho_vt_duyet'")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status='cho_vt_duyet'")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status='cho_vt_duyet'")
        + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_vt_duyet','cho_vt_phe_duyet')")
        + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('khcn_approved','director_reviewing')");
      tat_ca_tong =
        safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat")
        + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat")
        + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status != 'cancelled'");
    }

    let hnht_cho_phong = 0;
    let hnht_sap_dien_ra = 0;
    let hnht_minh_chung_qua_han = 0;
    if (role === 'admin' || role === 'phong_khcn') {
      hnht_cho_phong = safeCount(
        "SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')"
      );
      hnht_sap_dien_ra = safeCount(
        `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
         AND julianday(conf_start_date) >= julianday('now')
         AND julianday(conf_start_date) <= julianday('now','+30 days')`
      );
      hnht_minh_chung_qua_han = safeCount(
        `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
         AND julianday('now') - julianday(conf_end_date) > 15`
      );
    }

    let doi_tac_tong = 0;
    let thoa_thuan_tong = 0;
    if (role === 'admin' || role === 'phong_khcn') {
      thoa_thuan_tong = safeCount('SELECT COUNT(*) AS c FROM cooperation_thoa_thuan');
      try {
        doi_tac_tong = cooperationComputePartnerStats().total || 0;
      } catch (_) {
        doi_tac_tong = 0;
      }
    }

    return res.json({
      de_xuat_cua_toi,
      my_doan_ra,
      my_doan_vao,
      my_mou,
      my_ytnn,
      my_hnht,
      cho_phong_duyet: cho_phong,
      cho_vt_duyet: cho_vt,
      tat_ca_tong,
      su_kien_sap_dien_ra: safeCount("SELECT COUNT(*) AS c FROM cooperation_su_kien WHERE status='sap_dien_ra'"),
      hnht_cho_phong,
      hnht_sap_dien_ra,
      hnht_minh_chung_qua_han,
      doi_tac_tong,
      thoa_thuan_tong,
    });
  } catch (e) {
    return res.json({
      de_xuat_cua_toi: 0,
      my_doan_ra: 0,
      my_doan_vao: 0,
      my_mou: 0,
      my_ytnn: 0,
      my_hnht: 0,
      cho_phong_duyet: 0,
      cho_vt_duyet: 0,
      tat_ca_tong: 0,
      su_kien_sap_dien_ra: 0,
      hnht_cho_phong: 0,
      hnht_sap_dien_ra: 0,
      hnht_minh_chung_qua_han: 0,
      doi_tac_tong: 0,
      thoa_thuan_tong: 0,
    });
  }
});

// ============================================================
// ROUTE MỚI — DASHBOARD STATS (giám sát toàn hệ thống — chỉ lãnh đạo / P.KHCN)
// ============================================================
app.get('/api/cooperation/dashboard-stats', authMiddleware, coopDashboardViewer, (req, res) => {
  try {
    const role = (req.user.role || '').toLowerCase();
    const email = (req.user.email || '').trim().toLowerCase();

    const safeCount = (sql, ...params) => {
      try { return (db.prepare(sql).get(...params) || {}).c || 0; } catch (e) { return 0; }
    };

    const cho_phong =
      safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status IN ('cho_phong_duyet')")
      + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status IN ('cho_phong_duyet','cho_tham_dinh')")
      + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status IN ('cho_phong_duyet','dang_tham_dinh')")
      + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_phong_duyet','cho_phan_loai','dang_tham_dinh')")
      + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')");

    const cho_vt =
      safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status='cho_vt_duyet'")
      + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status='cho_vt_duyet'")
      + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status='cho_vt_duyet'")
      + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_vt_duyet','cho_vt_phe_duyet')")
      + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('khcn_approved','director_reviewing')");

    const tat_ca_tong =
      safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra")
      + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao")
      + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat")
      + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat")
      + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status != 'cancelled'");

    const by_loai = {
      doan_ra: safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_ra'),
      doan_vao: safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_vao'),
      mou: safeCount('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat'),
      ytnn: safeCount('SELECT COUNT(*) AS c FROM htqt_de_xuat'),
      hnht: safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status != 'cancelled'"),
    };

    const hnht_cho_phong = safeCount(
      "SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')"
    );
    const hnht_sap_dien_ra = safeCount(
      `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
       AND julianday(conf_start_date) >= julianday('now')
       AND julianday(conf_start_date) <= julianday('now', '+30 days')`
    );
    const hnht_minh_chung_qua_han = safeCount(
      `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
       AND julianday('now') - julianday(conf_end_date) > 15`
    );
    const by_status = coopDashMergeStatusBuckets(null);
    const series_12m = coopDashSeries12m(null);

    return res.json({
      cho_phong_duyet: cho_phong,
      cho_vt_duyet: cho_vt,
      tat_ca_tong,
      su_kien_sap_dien_ra: safeCount("SELECT COUNT(*) AS c FROM cooperation_su_kien WHERE status='sap_dien_ra'"),
      mou_hieu_luc: safeCount("SELECT COUNT(*) AS c FROM cooperation_thoa_thuan WHERE trang_thai='hieu_luc'"),
      by_loai,
      by_status,
      series_12m,
      hnht_cho_phong,
      hnht_sap_dien_ra,
      hnht_minh_chung_qua_han,
      generated_at: new Date().toISOString(),
      is_phong_khcn: role === 'admin' || role === 'phong_khcn',
      is_vien_truong: role === 'admin' || coopIsVienTruong(email),
      is_admin: role === 'admin',
    });
  } catch (e) {
    return res.status(500).json({ message: 'Không tải được Dashboard.' });
  }
});

// HTQT dashboard (EJS) — /ytnn/dashboard, /ytnn/api/dashboard/*
try {
  const createYtnnRouter = require('./routes/ytnn');
  app.use('/ytnn', authMiddleware, createYtnnRouter({ db, coopDashboardViewer }));
} catch (e) {
  console.warn('[ytnn] Không mount router /ytnn:', e.message);
}

// ============================================================
// ROUTE MỚI — CHỜ PHÒNG KHCN XỬ LÝ
// ============================================================
app.get('/api/cooperation/cho-phong-xu-ly', authMiddleware, coopPhongOrAdmin, (req, res) => {
  try {
    const list = [];
    const year = new Date().getFullYear();
    const tables = [
      { table:'cooperation_doan_ra',    loai:'doan_ra',  statuses:['cho_phong_duyet'] },
      { table:'cooperation_doan_vao',   loai:'doan_vao', statuses:['cho_phong_duyet','cho_tham_dinh'] },
      { table:'cooperation_mou_de_xuat',loai:'mou',      statuses:['cho_phong_duyet','dang_tham_dinh'] },
      { table:'htqt_de_xuat',           loai:'ytnn',     statuses:['cho_phan_loai','cho_phong_duyet','dang_tham_dinh'] },
    ];
    for (const { table, loai, statuses } of tables) {
      try {
        const ph = statuses.map(() => '?').join(',');
        const rows = db.prepare(`SELECT * FROM ${table} WHERE status IN (${ph}) ORDER BY created_at ASC`).all(...statuses);
        rows.forEach(r => {
          const ma = r.ma_de_xuat || coopGenMa(loai, r.id);
          const st = r.status || '';
          list.push({
            loai, id: r.id, ma_de_xuat: ma,
            title: coopBuildTitle(loai, r),
            status: st, status_label: STATUS_LABELS_COOP[st] || st,
            submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
            submitted_by_email: r.submitted_by_email,
            created_at: (r.created_at || '').slice(0,10),
            note_phong: r.note_phong || null,
          });
        });
      } catch(e) {}
    }
    try {
      const hnRows = db
        .prepare(
          `SELECT r.*, u.fullname AS uname, u.email AS uemail FROM conference_registrations r
           JOIN users u ON u.id = r.submitted_by_user_id
           WHERE r.status IN ('submitted','khcn_reviewing') ORDER BY r.created_at ASC`
        )
        .all();
      for (const r of hnRows || []) {
        list.push({
          loai: 'hnht',
          id: r.id,
          ma_de_xuat: r.submission_code || '',
          title: 'Đăng ký HN/HT — ' + (r.conf_name || '—'),
          status: r.status,
          status_label:
            r.status === 'khcn_reviewing' ? 'Phòng đang xem xét' : 'Chờ Phòng KHCN',
          submitted_by_name: r.uname || r.uemail || '—',
          submitted_by_email: r.uemail,
          created_at: (r.created_at || '').slice(0, 10),
          note_phong: r.khcn_comment || null,
        });
      }
    } catch (eh) {}
    list.sort((a,b) => (a.created_at||'').localeCompare(b.created_at||''));
    return res.json({ list, tong: list.length });
  } catch(e) { return res.json({ list:[], tong:0 }); }
});

// ============================================================
// ROUTE MỚI — CHỜ VIỆN TRƯỞNG DUYỆT
// ============================================================
app.get('/api/cooperation/cho-vt-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  try {
    const list = [];
    const tables = [
      { table:'cooperation_doan_ra',    loai:'doan_ra',  status:'cho_vt_duyet' },
      { table:'cooperation_doan_vao',   loai:'doan_vao', status:'cho_vt_duyet' },
      { table:'cooperation_mou_de_xuat',loai:'mou',      status:'cho_vt_duyet' },
      { table:'htqt_de_xuat',           loai:'ytnn',     status:'cho_vt_duyet' },
    ];
    for (const { table, loai, status } of tables) {
      try {
        const rows = table === 'htqt_de_xuat'
          ? db.prepare(`SELECT * FROM htqt_de_xuat WHERE status IN ('cho_vt_duyet','cho_vt_phe_duyet') ORDER BY created_at ASC`).all()
          : db.prepare(`SELECT * FROM ${table} WHERE status=? ORDER BY created_at ASC`).all(status);
        rows
          .forEach(r => list.push({
            loai, id: r.id, ma_de_xuat: r.ma_de_xuat || coopGenMa(loai, r.id),
            title: coopBuildTitle(loai, r), status: r.status,
            status_label: STATUS_LABELS_COOP[r.status] || r.status,
            submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
            submitted_by_email: r.submitted_by_email,
            created_at: (r.created_at||'').slice(0,10),
            note_phong: r.note_phong || null,
          }));
      } catch(e) {}
    }
    try {
      const hnRows = db
        .prepare(
          `SELECT r.*, u.fullname AS uname, u.email AS uemail FROM conference_registrations r
           JOIN users u ON u.id = r.submitted_by_user_id
           WHERE r.status IN ('khcn_approved','director_reviewing') ORDER BY r.created_at ASC`
        )
        .all();
      for (const r of hnRows || []) {
        list.push({
          loai: 'hnht',
          id: r.id,
          ma_de_xuat: r.submission_code || '',
          title: 'Đăng ký HN/HT — ' + (r.conf_name || '—'),
          status: r.status,
          status_label: r.status === 'director_reviewing' ? 'Viện trưởng đang xem xét' : 'Chờ Viện trưởng',
          submitted_by_name: r.uname || r.uemail || '—',
          submitted_by_email: r.uemail,
          created_at: (r.created_at || '').slice(0, 10),
          note_phong: r.khcn_comment || null,
        });
      }
    } catch (eh) {}
    list.sort((a,b) => (a.created_at||'').localeCompare(b.created_at||''));
    return res.json({ list, tong: list.length });
  } catch(e) { return res.json({ list:[], tong:0 }); }
});

// ============================================================
// ROUTE MỚI — TẤT CẢ ĐỀ XUẤT (manager)
// ============================================================
app.get('/api/cooperation/tat-ca-de-xuat', authMiddleware, (req, res) => {
  if (!coopIsManager(req)) return res.status(403).json({ message: 'Không có quyền.' });
  const { loai, status } = req.query;
  const list = [];
  const tables = [
    { table:'cooperation_doan_ra',    loai_key:'doan_ra'  },
    { table:'cooperation_doan_vao',   loai_key:'doan_vao' },
    { table:'cooperation_mou_de_xuat',loai_key:'mou'      },
    { table:'htqt_de_xuat',           loai_key:'ytnn'     },
  ].filter(t => !loai || t.loai_key === loai);
  for (const { table, loai_key } of tables) {
    try {
      let sql = `SELECT * FROM ${table}`;
      const params = [];
      if (status) { sql += ' WHERE status=?'; params.push(status); }
      sql += ' ORDER BY created_at DESC';
      db.prepare(sql).all(...params).forEach(r => list.push({
        loai: loai_key, id: r.id, ma_de_xuat: r.ma_de_xuat || coopGenMa(loai_key, r.id),
        title: coopBuildTitle(loai_key, r), status: r.status,
        status_label: STATUS_LABELS_COOP[r.status] || r.status,
        submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
        submitted_by_email: r.submitted_by_email,
        created_at: (r.created_at||'').slice(0,10),
      }));
    } catch(e) {}
  }
  if (!loai || loai === 'hnht') {
    try {
      let sql = `SELECT r.*, u.fullname AS submitted_by_name, u.email AS submitted_by_email
        FROM conference_registrations r JOIN users u ON u.id = r.submitted_by_user_id WHERE r.status != 'cancelled'`;
      const params = [];
      if (status) {
        sql += ' AND r.status = ?';
        params.push(status);
      }
      sql += ' ORDER BY r.created_at DESC';
      db.prepare(sql).all(...params).forEach((r) =>
        list.push({
          loai: 'hnht',
          id: r.id,
          ma_de_xuat: r.submission_code || '',
          title: 'Đăng ký HN/HT — ' + (r.conf_name || '—'),
          status: r.status,
          status_label: r.status,
          submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
          submitted_by_email: r.submitted_by_email,
          created_at: (r.created_at || '').slice(0, 10),
        })
      );
    } catch (eh) {}
  }
  list.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const page = parseInt(req.query.page)||1;
  const limit = parseInt(req.query.limit)||50;
  const offset = (page-1)*limit;
  return res.json({ list: list.slice(offset, offset+limit), tong: list.length, page });
});

// ============================================================
// ROUTE MỚI — CHI TIẾT + LỊCH SỬ
// ============================================================
app.get('/api/cooperation/chi-tiet/:loai/:id', authMiddleware, (req, res) => {
  const loai = req.params.loai;
  const id = parseInt(req.params.id, 10);
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const isManager = coopIsManager(req);
  const tableMap = { doan_ra:'cooperation_doan_ra', doan_vao:'cooperation_doan_vao', mou:'cooperation_mou_de_xuat', ytnn:'htqt_de_xuat' };
  const table = tableMap[loai];
  if (!table || !id) return res.status(400).json({ message: 'Loại hoặc ID không hợp lệ.' });
  try {
    let r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
    if (!isManager && (r.submitted_by_email||'').trim().toLowerCase() !== userEmail) {
      return res.status(403).json({ message: 'Bạn không có quyền xem đề xuất này.' });
    }
    if (loai === 'doan_ra' && r && (r.status || '').toLowerCase() === 'da_duyet') {
      try {
        const nr = coopEnsureFreshDoanRaVanBan(id);
        if (nr) r = nr;
      } catch (e) {}
    }
    if (loai === 'doan_vao' && r && (r.status || '').toLowerCase() === 'da_duyet') {
      try {
        const nr = coopEnsureFreshDoanVaoVanBan(id);
        if (nr) r = nr;
      } catch (e) {}
    }
    if (loai === 'mou' && r && (r.status || '').toLowerCase() === 'da_duyet') {
      try {
        const nr = coopEnsureFreshMouVanBan(id);
        if (nr) r = nr;
      } catch (e) {}
    }
    if (loai === 'ytnn' && r && (r.status || '').toLowerCase() === 'da_duyet') {
      try {
        const nr = coopEnsureFreshYtnnVanBan(id);
        if (nr) r = nr;
      } catch (e) {}
    }
    const history = (() => { try { return db.prepare("SELECT * FROM coop_history WHERE loai=? AND de_xuat_id=? ORDER BY performed_at ASC").all(loai, id); } catch(e) { return []; } })();
    let dataOut = r;
    if (loai === 'doan_ra' && r) {
      dataOut = Object.assign({}, r);
      delete dataOut.van_ban_word_path;
      dataOut.has_van_ban_word = !!(r.van_ban_word_path);
      dataOut.van_ban_word_original_name = r.van_ban_word_original_name || null;
      dataOut.van_ban_word_uploaded_at = r.van_ban_word_uploaded_at || null;
      try {
        dataOut.has_to_trinh_template = fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH);
      } catch (e) {
        dataOut.has_to_trinh_template = false;
      }
    }
    if (loai === 'doan_vao' && r) {
      dataOut = Object.assign({}, r);
      delete dataOut.van_ban_word_path;
      dataOut.has_van_ban_word = !!(r.van_ban_word_path);
      dataOut.van_ban_word_original_name = r.van_ban_word_original_name || null;
      dataOut.van_ban_word_uploaded_at = r.van_ban_word_uploaded_at || null;
      try {
        dataOut.has_to_trinh_template = fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH);
      } catch (e) {
        dataOut.has_to_trinh_template = false;
      }
    }
    if (loai === 'mou' && r) {
      dataOut = Object.assign({}, r);
      delete dataOut.van_ban_word_path;
      dataOut.has_van_ban_word = !!(r.van_ban_word_path);
      dataOut.van_ban_word_original_name = r.van_ban_word_original_name || null;
      dataOut.van_ban_word_uploaded_at = r.van_ban_word_uploaded_at || null;
      try {
        dataOut.has_to_trinh_template = fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH);
      } catch (e) {
        dataOut.has_to_trinh_template = false;
      }
    }
    if (loai === 'ytnn' && r) {
      dataOut = Object.assign({}, r);
      delete dataOut.van_ban_word_path;
      dataOut.has_van_ban_word = !!(r.van_ban_word_path);
      dataOut.van_ban_word_original_name = r.van_ban_word_original_name || null;
      dataOut.van_ban_word_uploaded_at = r.van_ban_word_uploaded_at || null;
      try {
        dataOut.has_to_trinh_template = fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH);
      } catch (e) {
        dataOut.has_to_trinh_template = false;
      }
    }
    return res.json({ data: dataOut, loai, status_label: STATUS_LABELS_COOP[r.status]||r.status, history, is_manager: isManager });
  } catch(e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

// ============================================================
// ĐOÀN RA — Văn bản Word ký bản cứng (Admin upload; NCV / Phòng / VT tải)
// ============================================================
app.post('/api/admin/cooperation/doan-ra/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ upload văn bản Word sau khi đề xuất đã được phê duyệt.' });
  }
  uploadHtqtDoanRa.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .doc hoặc .docx.' });
    const rel = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
    coopUnlinkDoanRaVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Đã lưu văn bản Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/doan-ra/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
  coopUnlinkDoanRaVanBanFile(row);
  db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Đã xóa file văn bản.' });
});

app.get('/api/cooperation/doan-ra/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  let row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ tải được khi đề xuất đã được phê duyệt.' });
  }
  if (!coopCanDownloadDoanRaVanBan(req, row)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file này.' });
  }
  row = coopEnsureFreshDoanRaVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'Chưa có văn bản Word.' });
  const abs = path.join(__dirname, row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-doan-ra'));
  if (!abs.startsWith(baseDir) || abs.includes('..')) {
    return res.status(400).json({ message: 'Đường dẫn file không hợp lệ.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File không còn trên máy chủ.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-doan-ra.docx');
});

app.post('/api/admin/cooperation/doan-ra/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplate.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .docx (mẫu Tờ trình Đoàn ra, có placeholder {ma_so}, {quoc_gia}, …).' });
    return res.json({ ok: true, message: 'Đã lưu mẫu Tờ trình Đoàn ra (.docx).' });
  });
});

app.get('/api/admin/cooperation/doan-ra/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'Chưa có file mẫu.' });
  res.download(DOAN_RA_TO_TRINH_TEMPLATE_PATH, 'mau-to-trinh-doan-ra.docx');
});

app.get('/api/cooperation/doan-ra/to-trinh-template/status', authMiddleware, (req, res) => {
  const exists = fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH);
  let updatedAt = null;
  if (exists) {
    try { updatedAt = fs.statSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH).mtime.toISOString(); } catch (e) {}
  }
  return res.json({ hasTemplate: exists, updatedAt });
});

app.post('/api/admin/cooperation/doan-ra/:id/sinh-to-trinh-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  const gen = coopTryAutoGenerateDoanRaVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình (menu trong chi tiết Đoàn ra).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  if (!gen.ok) {
    console.error('[merge] doan_ra', gen.message);
    return res.status(400).json({ message: gen.message || 'Lỗi khi ghép Word.' });
  }
  return res.json({ ok: true, message: 'Đã sinh file Word từ mẫu và dữ liệu đề xuất.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// ĐOÀN VÀO — Văn bản Word / mẫu Tờ trình (mirror Đoàn ra)
// ============================================================
app.post('/api/admin/cooperation/doan-vao/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ upload văn bản Word sau khi đề xuất đã được phê duyệt.' });
  }
  uploadHtqtDoanVao.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .doc hoặc .docx.' });
    const rel = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
    coopUnlinkDoanVaoVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Đã lưu văn bản Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/doan-vao/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
  coopUnlinkDoanVaoVanBanFile(row);
  db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Đã xóa file văn bản.' });
});

app.get('/api/cooperation/doan-vao/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  let row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ tải được khi đề xuất đã được phê duyệt.' });
  }
  if (!coopCanDownloadDoanVaoVanBan(req, row)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file này.' });
  }
  row = coopEnsureFreshDoanVaoVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'Chưa có văn bản Word.' });
  const abs = path.join(__dirname, row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-doan-vao'));
  if (!abs.startsWith(baseDir) || abs.includes('..')) {
    return res.status(400).json({ message: 'Đường dẫn file không hợp lệ.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File không còn trên máy chủ.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-doan-vao.docx');
});

app.post('/api/admin/cooperation/doan-vao/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateDoanVao.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .docx (mẫu Tờ trình Đoàn vào, có placeholder {ma_so}, {don_vi_de_xuat}, …).' });
    return res.json({ ok: true, message: 'Đã lưu mẫu Tờ trình Đoàn vào (.docx).' });
  });
});

app.get('/api/admin/cooperation/doan-vao/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'Chưa có file mẫu.' });
  res.download(DOAN_VAO_TO_TRINH_TEMPLATE_PATH, 'mau-to-trinh-doan-vao.docx');
});

app.get('/api/cooperation/doan-vao/to-trinh-template/status', authMiddleware, (req, res) => {
  const exists = fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH);
  let updatedAt = null;
  if (exists) {
    try { updatedAt = fs.statSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH).mtime.toISOString(); } catch (e) {}
  }
  return res.json({ hasTemplate: exists, updatedAt });
});

app.post('/api/admin/cooperation/doan-vao/:id/sinh-to-trinh-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  const gen = coopTryAutoGenerateDoanVaoVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình (menu trong chi tiết Đoàn vào).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  if (!gen.ok) {
    console.error('[merge] doan_vao', gen.message);
    return res.status(400).json({ message: gen.message || 'Lỗi khi ghép Word.' });
  }
  return res.json({ ok: true, message: 'Đã sinh file Word từ mẫu và dữ liệu đề xuất.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// THỎA THUẬN / MOU — Văn bản Word / mẫu Tờ trình (mirror Đoàn ra & Đoàn vào)
// ============================================================
app.post('/api/admin/cooperation/mou/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ upload văn bản Word sau khi đề xuất đã được phê duyệt.' });
  }
  uploadHtqtMou.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .doc hoặc .docx.' });
    const rel = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
    coopUnlinkMouVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Đã lưu văn bản Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/mou/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
  coopUnlinkMouVanBanFile(row);
  db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Đã xóa file văn bản.' });
});

app.get('/api/cooperation/mou/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  let row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ tải được khi đề xuất đã được phê duyệt.' });
  }
  if (!coopCanDownloadMouVanBan(req, row)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file này.' });
  }
  row = coopEnsureFreshMouVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'Chưa có văn bản Word.' });
  const abs = path.join(__dirname, row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-mou'));
  if (!abs.startsWith(baseDir) || abs.includes('..')) {
    return res.status(400).json({ message: 'Đường dẫn file không hợp lệ.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File không còn trên máy chủ.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-mou.docx');
});

app.post('/api/admin/cooperation/mou/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateMou.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .docx (mẫu Tờ trình Thỏa thuận/MOU, có placeholder {ma_so}, {ten_doi_tac}, …).' });
    return res.json({ ok: true, message: 'Đã lưu mẫu Tờ trình Đề xuất Thỏa thuận (.docx).' });
  });
});

app.get('/api/admin/cooperation/mou/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'Chưa có file mẫu.' });
  res.download(MOU_TO_TRINH_TEMPLATE_PATH, 'mau-to-trinh-mou.docx');
});

app.get('/api/cooperation/mou/to-trinh-template/status', authMiddleware, (req, res) => {
  const exists = fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH);
  let updatedAt = null;
  if (exists) {
    try { updatedAt = fs.statSync(MOU_TO_TRINH_TEMPLATE_PATH).mtime.toISOString(); } catch (e) {}
  }
  return res.json({ hasTemplate: exists, updatedAt });
});

app.post('/api/admin/cooperation/mou/:id/sinh-to-trinh-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  const gen = coopTryAutoGenerateMouVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình (menu trong chi tiết Đề xuất Thỏa thuận).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  if (!gen.ok) {
    console.error('[merge] mou', gen.message);
    return res.status(400).json({ message: gen.message || 'Lỗi khi ghép Word.' });
  }
  return res.json({ ok: true, message: 'Đã sinh file Word từ mẫu và dữ liệu đề xuất.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// ĐỀ TÀI YTNN — Văn bản Word / mẫu Tờ trình (mirror MOU)
// ============================================================
app.post('/api/admin/cooperation/ytnn/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ upload văn bản Word sau khi đề xuất đã được phê duyệt.' });
  }
  uploadHtqtYtnn.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .doc hoặc .docx.' });
    const rel = path.relative(__dirname, req.file.path).replace(/\\/g, '/');
    coopUnlinkYtnnVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Đã lưu văn bản Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/ytnn/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
  coopUnlinkYtnnVanBanFile(row);
  db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Đã xóa file văn bản.' });
});

app.get('/api/cooperation/ytnn/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  let row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ tải được khi đề xuất đã được phê duyệt.' });
  }
  if (!coopCanDownloadYtnnVanBan(req, row)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file này.' });
  }
  row = coopEnsureFreshYtnnVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'Chưa có văn bản Word.' });
  const abs = path.join(__dirname, row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-ytnn'));
  if (!abs.startsWith(baseDir) || abs.includes('..')) {
    return res.status(400).json({ message: 'Đường dẫn file không hợp lệ.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File không còn trên máy chủ.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-ytnn.docx');
});

app.post('/api/admin/cooperation/ytnn/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateYtnn.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
    if (!req.file) return res.status(400).json({ message: 'Chọn file .docx (mẫu Tờ trình YTNN: {ma_so}, {ten_de_tai}, {mo_ta_de_tai}, {ten_to_chuc_doi_tac}, {quoc_gia_doi_tac}, {chu_nhiem_de_tai}, {hoc_ham_hoc_vi}, {don_vi_chu_nhiem}, {kinh_phi}, {don_vi_tien_te}, {tieu_de_to_trinh}, {nguoi_phe_duyet}, …).' });
    return res.json({ ok: true, message: 'Đã lưu mẫu Tờ trình Đề tài YTNN (.docx).' });
  });
});

app.get('/api/admin/cooperation/ytnn/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'Chưa có file mẫu.' });
  res.download(YTNN_TO_TRINH_TEMPLATE_PATH, 'mau-to-trinh-ytnn.docx');
});

app.get('/api/cooperation/ytnn/to-trinh-template/status', authMiddleware, (req, res) => {
  const exists = fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH);
  let updatedAt = null;
  if (exists) {
    try { updatedAt = fs.statSync(YTNN_TO_TRINH_TEMPLATE_PATH).mtime.toISOString(); } catch (e) {}
  }
  return res.json({ hasTemplate: exists, updatedAt });
});

app.post('/api/admin/cooperation/ytnn/:id/sinh-to-trinh-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  const gen = coopTryAutoGenerateYtnnVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình (menu trong chi tiết Đề tài YTNN).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chỉ sinh tờ trình khi đề xuất đã được phê duyệt.' });
  }
  if (!gen.ok) {
    console.error('[merge] ytnn', gen.message);
    return res.status(400).json({ message: gen.message || 'Lỗi khi ghép Word.' });
  }
  return res.json({ ok: true, message: 'Đã sinh file Word từ mẫu và dữ liệu đề xuất.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// ROUTE MỚI — LỊCH SỬ THAO TÁC
// ============================================================
app.get('/api/cooperation/lich-su/:loai/:id', authMiddleware, (req, res) => {
  const loai = req.params.loai;
  const id = parseInt(req.params.id, 10);
  try {
    const history = db.prepare("SELECT * FROM coop_history WHERE loai=? AND de_xuat_id=? ORDER BY performed_at ASC").all(loai, id);
    return res.json({ history });
  } catch(e) { return res.json({ history:[] }); }
});

// ============================================================
// ROUTE MỚI — ĐOÀN RA: THẨM ĐỊNH (Phòng KHCN → bước 2)
// ============================================================
app.put('/api/cooperation/doan-ra/:id/tham-dinh', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body || {};
  // action: duyet_len_vt | yeu_cau_bo_sung | tu_choi
  if (!id || !['duyet_len_vt','yeu_cau_bo_sung','tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'Action: duyet_len_vt | yeu_cau_bo_sung | tu_choi' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chỉ thẩm định khi đề xuất đang chờ Phòng KHCN. Nếu đang yêu cầu bổ sung, người gửi cần nộp lại hồ sơ trước.' });
    }
    const newStatus = action==='duyet_len_vt' ? 'cho_vt_duyet' : action==='tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action==='duyet_len_vt' ? 'Phòng KHCN thẩm định — Trình Viện trưởng' : action==='tu_choi' ? 'Phòng KHCN từ chối' : 'Phòng KHCN yêu cầu bổ sung';
    db.prepare("UPDATE cooperation_doan_ra SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_ra', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_ra', row, id, 'phong', note).catch(err => console.error('[Email tu_choi doan_ra]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
        subject:`[${row.ma_de_xuat||coopGenMa('doan_ra',id)}] Cập nhật Đoàn ra — ${label}`,
        html: coopBuildEmail('Cập nhật Đề xuất Đoàn ra', `Đề xuất Đoàn ra của bạn đã được Phòng KHCN&amp;QHĐN xử lý.`,
          [['Mã',row.ma_de_xuat||coopGenMa('doan_ra',id)],['Trạng thái mới',STATUS_LABELS_COOP[newStatus]||newStatus],['Ý kiến Phòng KHCN',note||'—']], 'Trân trọng.'),
        text:`${row.ma_de_xuat} — ${label}. Ý kiến: ${note||'—'}` });
      }
    }
    if (action==='duyet_len_vt') {
      const recip = coopGetRecipients('doan_ra');
      coopSendMail({ to:recip.to, cc:recip.cc,
        subject:`[Hợp tác QT] Trình duyệt Đoàn ra — ${row.ma_de_xuat||coopGenMa('doan_ra',id)}`,
        html: coopBuildEmail('Đề xuất Đoàn ra cần Viện trưởng phê duyệt','Phòng KHCN&amp;QHĐN đã thẩm định và trình Viện trưởng:',
          [['Mã',row.ma_de_xuat||coopGenMa('doan_ra',id)],['Người gửi',row.submitted_by_name||row.submitted_by_email],['Quốc gia',row.quoc_gia],['Ngày đi',coopFmtDate(row.ngay_di)],['Ý kiến Phòng',note||'—']],
          'Trân trọng,<br/>Phòng KHCN&QHĐN', (process.env.BASE_URL||'http://localhost:'+PORT)+'/module-hoatac-quocte.html'),
        text:`Trình duyệt Đoàn ra ${row.ma_de_xuat}.` });
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// ============================================================
// ROUTE MỚI — ĐOÀN RA: PHÊ DUYỆT (Viện trưởng → bước 3)
// ============================================================
app.put('/api/cooperation/doan-ra/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet') {
      return res.status(400).json({ message: 'Chỉ phê duyệt được khi đề xuất đang ở bước chờ Viện trưởng (đã qua Phòng KHCN).' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'Viện trưởng đã phê duyệt' : action==='tu_choi' ? 'Viện trưởng không phê duyệt' : 'Viện trưởng yêu cầu bổ sung';
    db.prepare("UPDATE cooperation_doan_ra SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_ra', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateDoanRaVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_ra] Đã phê duyệt nhưng chưa có mẫu Word trên hệ thống — Admin cần tải mẫu Tờ trình (.docx) một lần.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_ra] Auto Word sau phê duyệt:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('doan_ra'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viện trưởng yêu cầu bổ sung — Đoàn ra`,
          html: coopBuildEmail('Viện trưởng yêu cầu bổ sung hồ sơ (Đoàn ra)',
            'Viện trưởng đã có ý kiến yêu cầu bổ sung. <strong>Phòng KHCN&amp;QHĐN</strong> được CC để phối hợp theo dõi.',
            [['Mã', ma], ['Nội dung ý kiến', note || '—']], 'Trân trọng.'),
          text: `${ma} — Viện trưởng yêu cầu bổ sung. Ý kiến: ${note || '—'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_ra', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi doan_ra]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${ma}] Kết quả phê duyệt Đoàn ra`,
          html: coopBuildEmail('Kết quả phê duyệt Đoàn ra', 'Đề xuất của bạn đã được Viện trưởng xem xét.',
            [['Mã', ma], ['Kết quả', label], ['Ý kiến', note || '—']], 'Trân trọng.'),
          text: `${row.ma_de_xuat} — ${label}. Ý kiến: ${note || '—'}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// ============================================================
// ROUTE MỚI — ĐOÀN VÀO: PHÊ DUYỆT (Viện trưởng)
// ============================================================
app.put('/api/cooperation/doan-vao/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet' && st !== 'cho_ky_duyet') {
      return res.status(400).json({ message: 'Chỉ phê duyệt được khi đề xuất đang chờ Viện trưởng.' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'Viện trưởng đã phê duyệt' : action==='tu_choi' ? 'Viện trưởng không phê duyệt' : 'Viện trưởng yêu cầu bổ sung';
    db.prepare("UPDATE cooperation_doan_vao SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_vao', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateDoanVaoVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_vao] Đã phê duyệt nhưng chưa có mẫu Word trên hệ thống — Admin cần tải mẫu Tờ trình (.docx) một lần.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_vao] Auto Word sau phê duyệt:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('doan_vao'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viện trưởng yêu cầu bổ sung — Đoàn vào`,
          html: coopBuildEmail('Viện trưởng yêu cầu bổ sung hồ sơ (Đoàn vào)',
            'Viện trưởng đã có ý kiến yêu cầu bổ sung. <strong>Phòng KHCN&amp;QHĐN</strong> được CC để phối hợp theo dõi.',
            [['Mã', ma], ['Nội dung ý kiến', note || '—']], 'Trân trọng.'),
          text: `${ma} — YCBS Viện trưởng. Ý kiến: ${note || '—'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_vao', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi doan_vao]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] Kết quả phê duyệt Đoàn vào`,
        html: coopBuildEmail('Kết quả phê duyệt Đoàn vào','Đề xuất của bạn đã được Viện trưởng xem xét.',
            [['Mã',ma],['Kết quả',label],['Ý kiến',note||'—']],'Trân trọng.'),
        text:`${row.ma_de_xuat} — ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// ============================================================
// ROUTE MỚI — MOU: PHÊ DUYỆT (Viện trưởng)
// ============================================================
app.put('/api/cooperation/mou/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note, so_van_ban, ngay_ky } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet') {
      return res.status(400).json({ message: 'Chỉ phê duyệt được khi đề xuất đang chờ Viện trưởng.' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'Viện trưởng đã phê duyệt' : action==='tu_choi' ? 'Viện trưởng không phê duyệt' : 'Viện trưởng yêu cầu bổ sung';
    db.prepare("UPDATE cooperation_mou_de_xuat SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('mou', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateMouVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[mou] Đã phê duyệt nhưng chưa có mẫu Word trên hệ thống — Admin cần tải mẫu Tờ trình (.docx) một lần.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[mou] Auto Word sau phê duyệt:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('mou', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('mou'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viện trưởng yêu cầu bổ sung — MOU`,
          html: coopBuildEmail('Viện trưởng yêu cầu bổ sung hồ sơ (MOU/Thỏa thuận)',
            'Viện trưởng đã có ý kiến yêu cầu bổ sung. <strong>Phòng KHCN&amp;QHĐN</strong> được CC để phối hợp theo dõi.',
            [['Mã', ma], ['Đối tác', row.ten_doi_tac || '—'], ['Nội dung ý kiến', note || '—']], 'Trân trọng.'),
          text: `${ma} — YCBS Viện trưởng. Ý kiến: ${note || '—'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('mou', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi mou]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] Kết quả phê duyệt MOU`,
        html: coopBuildEmail('Kết quả phê duyệt Thỏa thuận MOU','Đề xuất của bạn đã được Viện trưởng xem xét.',
            [['Mã',ma],['Đối tác',row.ten_doi_tac||'—'],['Kết quả',label],['Số văn bản',so_van_ban||'—'],['Ý kiến',note||'—']],'Trân trọng.'),
        text:`${row.ma_de_xuat} — ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// ============================================================
// ROUTE MỚI — YTNN: SUBMIT, LIST, THẨM ĐỊNH, PHÊ DUYỆT
// ============================================================
app.post('/api/cooperation/ytnn/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  const ten = (body.ten || '').trim();
  if (!ten) return res.status(400).json({ message: 'Thiếu: Tên đề tài.' });
  try {
    const result = db.prepare(`
      INSERT INTO htqt_de_xuat (submitted_by_id, submitted_by_email, submitted_by_name, ten, mo_ta, doi_tac_ten, doi_tac_quoc_gia, doi_tac_nguoi_dai_dien, doi_tac_website, hinh_thuc_hop_tac, chu_nhiem_ten, chu_nhiem_hoc_vi, chu_nhiem_don_vi, ngay_bat_dau, ngay_ket_thuc, kinh_phi, don_vi_tien_te, loai_hinh, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_phong_duyet')
    `).run(user.id||null, user.email||'', user.fullname||user.email||'', ten,
      body.mo_ta||'', body.doi_tac_ten||'', body.doi_tac_quoc_gia||'',
      body.doi_tac_nguoi_dai_dien||'', body.doi_tac_website||'',
      body.hinh_thuc_hop_tac||'', body.chu_nhiem_ten||user.fullname||'',
      body.chu_nhiem_hoc_vi||'', body.chu_nhiem_don_vi||'',
      body.ngay_bat_dau||'', body.ngay_ket_thuc||'',
      body.kinh_phi||null, body.don_vi_tien_te||'VNĐ', body.loai_hinh||'');
    const newId = result.lastInsertRowid;
    const ma = coopGenMa('ytnn', newId);
    db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat=? WHERE id=?').run(ma, newId);
    coopAddHistory('ytnn', newId, 1, 'submitted', 'Gửi đề xuất Đề tài YTNN', user, 'Đề xuất tiếp nhận đề tài có yếu tố nước ngoài');
    const recip = coopGetRecipients('ytnn');
    coopSendMail({ to:recip.to, cc:recip.cc,
      subject:`[Hợp tác QT] Đề xuất YTNN mới — ${ma} — ${ten}`,
      html: coopBuildEmail('Đề tài YTNN mới cần phân loại & thẩm định', `<strong>${user.fullname||user.email}</strong> gửi đề xuất đề tài YTNN.`,
        [['Mã',ma],['Tên',ten],['Đối tác',body.doi_tac_ten||'—'],['Quốc gia',body.doi_tac_quoc_gia||'—'],['Chủ nhiệm',body.chu_nhiem_ten||user.fullname||'—']],
        'Trân trọng.', (process.env.BASE_URL||'http://localhost:'+PORT)+'/module-hoatac-quocte.html'),
      text:`[${ma}] Đề xuất YTNN "${ten}" từ ${user.email}.` });
    return res.json({ ok:true, message:`Đã gửi! Mã: ${ma}`, ma_de_xuat:ma, id:newId });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

app.get('/api/cooperation/ytnn', authMiddleware, (req, res) => {
  const userEmail = (req.user.email||'').trim().toLowerCase();
  const isManager = coopIsManager(req);
  try {
    const rows = isManager
      ? db.prepare("SELECT * FROM htqt_de_xuat ORDER BY created_at DESC").all()
      : db.prepare("SELECT * FROM htqt_de_xuat WHERE lower(trim(coalesce(submitted_by_email,'')))=? ORDER BY created_at DESC").all(userEmail);
    return res.json({ list: rows.map(r => ({ ...r, status_label: STATUS_LABELS_COOP[r.status]||r.status })) });
  } catch(e) { return res.json({ list:[] }); }
});

app.put('/api/cooperation/ytnn/:id/tham-dinh', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  let { action, note, to_phan_loai_json, han_xu_ly_vt } = req.body || {};
  if (action === 'duyet_len_vt') action = 'chuyen_vt';
  if (!id || !['chuyen_vt', 'yeu_cau_bo_sung', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'Action: duyet_len_vt | chuyen_vt | yeu_cau_bo_sung | tu_choi' });
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phan_loai', 'cho_phong_duyet', 'dang_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chỉ thẩm định khi đề xuất đang chờ Phòng KHCN. Nếu đang yêu cầu bổ sung, người gửi cần nộp lại hồ sơ trước.' });
    }
    const newStatus = action === 'chuyen_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'chuyen_vt' ? 'Phòng KHCN thẩm định — Trình Viện trưởng' : action === 'tu_choi' ? 'Phòng KHCN từ chối' : 'Phòng KHCN yêu cầu bổ sung';
    const sets = ["status=?","note_phong=?","phong_xu_ly_id=?","phong_xu_ly_at=datetime('now','localtime')","updated_at=datetime('now','localtime')","coop_reminder_last_at=NULL"];
    const vals = [newStatus, note||null, req.user.id||null];
    if (to_phan_loai_json) { sets.push('to_phan_loai_json=?'); vals.push(to_phan_loai_json); }
    if (han_xu_ly_vt) { sets.push('han_xu_ly_vt=?'); vals.push(han_xu_ly_vt); }
    vals.push(id);
    db.prepare(`UPDATE htqt_de_xuat SET ${sets.join(',')} WHERE id=?`).run(...vals);
    coopAddHistory('ytnn', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('ytnn', row, id, 'phong', note).catch(err => console.error('[Email tu_choi ytnn]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
        subject:`[${row.ma_de_xuat||coopGenMa('ytnn',id)}] YTNN — ${label}`,
        html: coopBuildEmail('Cập nhật Đề tài YTNN','Đề xuất của bạn đã được Phòng KHCN xử lý.',
          [['Mã',row.ma_de_xuat||coopGenMa('ytnn',id)],['Trạng thái',STATUS_LABELS_COOP[newStatus]||newStatus],['Ý kiến',note||'—']],'Trân trọng.'),
        text:`${row.ma_de_xuat} — ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

app.put('/api/cooperation/ytnn/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note, vt_so_van_ban, vt_ngay_ky } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung','da_phe_duyet','khong_phe_duyet'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet' && st !== 'cho_vt_phe_duyet') {
      return res.status(400).json({ message: 'Chỉ phê duyệt được khi đề xuất đang chờ Viện trưởng.' });
    }
    const act = (action === 'da_phe_duyet') ? 'da_duyet' : (action === 'khong_phe_duyet') ? 'tu_choi' : action;
    const newStatus = act === 'yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : act;
    const label = act === 'da_duyet' ? 'Viện trưởng đã phê duyệt' : act === 'tu_choi' ? 'Viện trưởng không phê duyệt' : 'Viện trưởng yêu cầu bổ sung';
    db.prepare("UPDATE htqt_de_xuat SET status=?, note_vt=?, vt_y_kien=?, vt_so_van_ban=?, vt_ngay_ky=?, vt_nguoi_ky_id=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, note || null, vt_so_van_ban || null, vt_ngay_ky || null, req.user.id || null, req.user.id || null, id);
    coopAddHistory('ytnn', id, 3, act, label, req.user, note);
    if (act === 'da_duyet') {
      const gen = coopTryAutoGenerateYtnnVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[ytnn] Đã phê duyệt nhưng chưa có mẫu Word trên hệ thống — Admin cần tải mẫu Tờ trình (.docx) một lần.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[ytnn] Auto Word sau phê duyệt:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('ytnn'), row.submitted_by_email);
      if (act === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viện trưởng yêu cầu bổ sung — YTNN`,
          html: coopBuildEmail('Viện trưởng yêu cầu bổ sung hồ sơ (Đề tài YTNN)',
            'Viện trưởng đã có ý kiến yêu cầu bổ sung. <strong>Phòng KHCN&amp;QHĐN</strong> được CC để phối hợp theo dõi.',
            [['Mã', ma], ['Tên đề tài', row.ten || '—'], ['Nội dung ý kiến', note || '—']], 'Trân trọng.'),
          text: `${ma} — YCBS Viện trưởng. Ý kiến: ${note || '—'}` });
      } else if (act === 'tu_choi') {
        coopSendMailTuChoi('ytnn', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi ytnn]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] Kết quả phê duyệt YTNN`,
        html: coopBuildEmail('Kết quả phê duyệt Đề tài YTNN','Đề xuất của bạn đã được Viện trưởng xem xét.',
            [['Mã',ma],['Tên',row.ten],['Kết quả',label],['Số VB',vt_so_van_ban||'—'],['Ý kiến',note||'—']],'Trân trọng.'),
        text:`${row.ma_de_xuat} — ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// Người gửi: chỉnh sửa / nộp lại / kết thúc (giữ mã & lịch sử; chỉ admin xóa bản ghi)
function coopNopLaiStatusForLoai(loai) {
  return 'cho_phong_duyet';
}

app.put('/api/cooperation/doan-ra/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
    }
    const muc_dich = b.muc_dich != null ? String(b.muc_dich) : row.muc_dich;
    const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia || '').trim() : row.quoc_gia;
    const ngay_di = b.ngay_di != null ? String(b.ngay_di || '').trim() : row.ngay_di;
    const ngay_ve = b.ngay_ve != null ? String(b.ngay_ve || '').trim() : row.ngay_ve;
    const thanh_vien = b.thanh_vien != null ? String(b.thanh_vien) : row.thanh_vien;
    const nguon_kinh_phi = b.nguon_kinh_phi != null ? String(b.nguon_kinh_phi) : row.nguon_kinh_phi;
    const du_toan = b.du_toan != null && b.du_toan !== '' ? String(b.du_toan) : row.du_toan;
    if (!quoc_gia || !ngay_di || !ngay_ve || !thanh_vien) {
      return res.status(400).json({ message: 'Vui lòng điền đủ: Quốc gia, Ngày đi, Ngày về, Thành viên đoàn.' });
    }
    db.prepare(`UPDATE cooperation_doan_ra SET muc_dich=?, quoc_gia=?, ngay_di=?, ngay_ve=?, thanh_vien=?, nguon_kinh_phi=?, du_toan=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, id);
    coopAddHistory('doan_ra', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
    return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/doan-ra/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ nộp lại khi đề xuất đang yêu cầu bổ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('doan_ra');
    db.prepare(`UPDATE cooperation_doan_ra SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('doan_ra', id, 2, 'nop_lai', 'Nộp lại hồ sơ — chờ Phòng KHCN thẩm định', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_ra', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã nộp lại hồ sơ — Đoàn ra — ${ma}`,
      html: coopBuildEmail('Nộp lại hồ sơ (Đoàn ra)', `Người gửi <strong>${coopEscHtml(row.submitted_by_name || row.submitted_by_email)}</strong> đã nộp lại hồ sơ theo yêu cầu bổ sung. Đề xuất quay lại bước <strong>Phòng KHCN thẩm định</strong>, sau đó trình Viện trưởng.`,
        [['Mã', ma], ['Người gửi', row.submitted_by_name || row.submitted_by_email]], 'Trân trọng.', modUrl),
      text: `Nộp lại Đoàn ra ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai doan_ra]', err.message));
    return res.json({ ok: true, message: 'Đã nộp lại. Phòng KHCN sẽ thẩm định lại.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/doan-ra/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ kết thúc khi đề xuất đang yêu cầu bổ sung.' });
    }
    db.prepare(`UPDATE cooperation_doan_ra SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('doan_ra', id, 3, 'ket_thuc_boi_nguoi_nop', 'Người gửi kết thúc đề xuất (không nộp lại)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_ra', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã kết thúc đề xuất — Đoàn ra — ${ma}`,
      html: coopBuildEmail('Kết thúc đề xuất (thông báo)', `Người gửi đã <strong>chủ động kết thúc</strong> đề xuất, không tiếp tục nộp lại hồ sơ. Hồ sơ được lưu trong hệ thống.`,
        [['Mã', ma], ['Người gửi', row.submitted_by_name || row.submitted_by_email]], 'Trân trọng.', modUrl),
      text: `Kết thúc đề xuất Đoàn ra ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc doan_ra]', err.message));
    return res.json({ ok: true, message: 'Đã ghi nhận kết thúc đề xuất.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.put('/api/cooperation/doan-vao/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
    }
    const muc_dich = b.muc_dich != null ? String(b.muc_dich) : row.muc_dich;
    const don_vi_de_xuat = b.don_vi_de_xuat != null ? String(b.don_vi_de_xuat || '').trim() : row.don_vi_de_xuat;
    const ngay_den = b.ngay_den != null ? String(b.ngay_den || '').trim() : row.ngay_den;
    const ngay_roi_di = b.ngay_roi_di != null ? String(b.ngay_roi_di || '').trim() : row.ngay_roi_di;
    const thanh_phan_doan = b.thanh_phan_doan != null ? String(b.thanh_phan_doan) : row.thanh_phan_doan;
    const noi_dung_lam_viec = b.noi_dung_lam_viec != null ? String(b.noi_dung_lam_viec) : row.noi_dung_lam_viec;
    const kinh_phi_nguon = b.kinh_phi_nguon != null ? String(b.kinh_phi_nguon) : row.kinh_phi_nguon;
    const ho_tro_visa = b.ho_tro_visa != null ? String(b.ho_tro_visa) : row.ho_tro_visa;
    if (!don_vi_de_xuat || !ngay_den || !thanh_phan_doan) {
      return res.status(400).json({ message: 'Vui lòng điền đủ: Đơn vị đề xuất, Ngày đến, Thành phần đoàn.' });
    }
    db.prepare(`UPDATE cooperation_doan_vao SET muc_dich=?, don_vi_de_xuat=?, ngay_den=?, ngay_roi_di=?, thanh_phan_doan=?, noi_dung_lam_viec=?, kinh_phi_nguon=?, ho_tro_visa=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, noi_dung_lam_viec, kinh_phi_nguon, ho_tro_visa, id);
    coopAddHistory('doan_vao', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
    return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/doan-vao/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ nộp lại khi đề xuất đang yêu cầu bổ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('doan_vao');
    db.prepare(`UPDATE cooperation_doan_vao SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('doan_vao', id, 2, 'nop_lai', 'Nộp lại hồ sơ — chờ Phòng KHCN thẩm định', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_vao', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã nộp lại hồ sơ — Đoàn vào — ${ma}`,
      html: coopBuildEmail('Nộp lại hồ sơ (Đoàn vào)', `Người gửi đã nộp lại hồ sơ. Đề xuất quay lại bước <strong>Phòng KHCN thẩm định</strong>, sau đó trình Viện trưởng.`,
        [['Mã', ma]], 'Trân trọng.', modUrl),
      text: `Nộp lại Đoàn vào ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai doan_vao]', err.message));
    return res.json({ ok: true, message: 'Đã nộp lại.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/doan-vao/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ kết thúc khi đề xuất đang yêu cầu bổ sung.' });
    }
    db.prepare(`UPDATE cooperation_doan_vao SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('doan_vao', id, 3, 'ket_thuc_boi_nguoi_nop', 'Người gửi kết thúc đề xuất (không nộp lại)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_vao', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã kết thúc đề xuất — Đoàn vào — ${ma}`,
      html: coopBuildEmail('Kết thúc đề xuất (thông báo)', `Người gửi đã chủ động kết thúc đề xuất, không tiếp tục nộp lại.`,
        [['Mã', ma]], 'Trân trọng.', modUrl),
      text: `Kết thúc Đoàn vào ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc doan_vao]', err.message));
    return res.json({ ok: true, message: 'Đã ghi nhận kết thúc đề xuất.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.put('/api/cooperation/mou/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
    }
    const loai_thoa_thuan = b.loai_thoa_thuan != null ? String(b.loai_thoa_thuan) : row.loai_thoa_thuan;
    const ten_doi_tac = b.ten_doi_tac != null ? String(b.ten_doi_tac || '').trim() : row.ten_doi_tac;
    const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia) : row.quoc_gia;
    const thoi_han_nam = b.thoi_han_nam != null && b.thoi_han_nam !== '' ? String(b.thoi_han_nam) : row.thoi_han_nam;
    const gia_tri_tai_chinh = b.gia_tri_tai_chinh != null ? String(b.gia_tri_tai_chinh) : row.gia_tri_tai_chinh;
    const don_vi_de_xuat = b.don_vi_de_xuat != null ? String(b.don_vi_de_xuat) : row.don_vi_de_xuat;
    const noi_dung_hop_tac = b.noi_dung_hop_tac != null ? String(b.noi_dung_hop_tac) : row.noi_dung_hop_tac;
    if (!ten_doi_tac || !noi_dung_hop_tac) {
      return res.status(400).json({ message: 'Vui lòng điền đối tác và nội dung hợp tác.' });
    }
    db.prepare(`UPDATE cooperation_mou_de_xuat SET loai_thoa_thuan=?, ten_doi_tac=?, quoc_gia=?, thoi_han_nam=?, gia_tri_tai_chinh=?, don_vi_de_xuat=?, noi_dung_hop_tac=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, noi_dung_hop_tac, id);
    coopAddHistory('mou', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
    return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/mou/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ nộp lại khi đề xuất đang yêu cầu bổ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('mou');
    db.prepare(`UPDATE cooperation_mou_de_xuat SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('mou', id, 2, 'nop_lai', 'Nộp lại hồ sơ — chờ Phòng KHCN thẩm định', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('mou', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('mou', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã nộp lại hồ sơ — MOU — ${ma}`,
      html: coopBuildEmail('Nộp lại hồ sơ (MOU)', `Người gửi đã nộp lại hồ sơ. Đề xuất quay lại bước <strong>Phòng KHCN thẩm định</strong>, sau đó trình Viện trưởng.`,
        [['Mã', ma]], 'Trân trọng.', modUrl),
      text: `Nộp lại MOU ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai mou]', err.message));
    return res.json({ ok: true, message: 'Đã nộp lại.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/mou/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ kết thúc khi đề xuất đang yêu cầu bổ sung.' });
    }
    db.prepare(`UPDATE cooperation_mou_de_xuat SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('mou', id, 3, 'ket_thuc_boi_nguoi_nop', 'Người gửi kết thúc đề xuất (không nộp lại)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('mou', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('mou', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã kết thúc đề xuất — MOU — ${ma}`,
      html: coopBuildEmail('Kết thúc đề xuất (thông báo)', `Người gửi đã chủ động kết thúc đề xuất.`,
        [['Mã', ma]], 'Trân trọng.', modUrl),
      text: `Kết thúc MOU ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc mou]', err.message));
    return res.json({ ok: true, message: 'Đã ghi nhận kết thúc đề xuất.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.put('/api/cooperation/ytnn/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
    }
    const ten = b.ten != null ? String(b.ten || '').trim() : row.ten;
    if (!ten) return res.status(400).json({ message: 'Thiếu tên đề tài.' });
    const mo_ta = b.mo_ta != null ? String(b.mo_ta) : row.mo_ta;
    const doi_tac_ten = b.doi_tac_ten != null ? String(b.doi_tac_ten) : row.doi_tac_ten;
    const doi_tac_quoc_gia = b.doi_tac_quoc_gia != null ? String(b.doi_tac_quoc_gia) : row.doi_tac_quoc_gia;
    const doi_tac_nguoi_dai_dien = b.doi_tac_nguoi_dai_dien != null ? String(b.doi_tac_nguoi_dai_dien) : row.doi_tac_nguoi_dai_dien;
    const doi_tac_website = b.doi_tac_website != null ? String(b.doi_tac_website) : row.doi_tac_website;
    const hinh_thuc_hop_tac = b.hinh_thuc_hop_tac != null ? String(b.hinh_thuc_hop_tac) : row.hinh_thuc_hop_tac;
    const chu_nhiem_ten = b.chu_nhiem_ten != null ? String(b.chu_nhiem_ten) : row.chu_nhiem_ten;
    const chu_nhiem_hoc_vi = b.chu_nhiem_hoc_vi != null ? String(b.chu_nhiem_hoc_vi) : row.chu_nhiem_hoc_vi;
    const chu_nhiem_don_vi = b.chu_nhiem_don_vi != null ? String(b.chu_nhiem_don_vi) : row.chu_nhiem_don_vi;
    const ngay_bat_dau = b.ngay_bat_dau != null ? String(b.ngay_bat_dau) : row.ngay_bat_dau;
    const ngay_ket_thuc = b.ngay_ket_thuc != null ? String(b.ngay_ket_thuc) : row.ngay_ket_thuc;
    let kinh_phi = row.kinh_phi;
    if (b.kinh_phi != null && b.kinh_phi !== '') {
      const n = parseFloat(b.kinh_phi);
      kinh_phi = Number.isFinite(n) ? n : row.kinh_phi;
    }
    const don_vi_tien_te = b.don_vi_tien_te != null ? String(b.don_vi_tien_te) : row.don_vi_tien_te;
    const loai_hinh = b.loai_hinh != null ? String(b.loai_hinh) : row.loai_hinh;
    db.prepare(`UPDATE htqt_de_xuat SET ten=?, mo_ta=?, doi_tac_ten=?, doi_tac_quoc_gia=?, doi_tac_nguoi_dai_dien=?, doi_tac_website=?, hinh_thuc_hop_tac=?, chu_nhiem_ten=?, chu_nhiem_hoc_vi=?, chu_nhiem_don_vi=?, ngay_bat_dau=?, ngay_ket_thuc=?, kinh_phi=?, don_vi_tien_te=?, loai_hinh=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(ten, mo_ta, doi_tac_ten, doi_tac_quoc_gia, doi_tac_nguoi_dai_dien, doi_tac_website, hinh_thuc_hop_tac, chu_nhiem_ten, chu_nhiem_hoc_vi, chu_nhiem_don_vi, ngay_bat_dau, ngay_ket_thuc, kinh_phi, don_vi_tien_te, loai_hinh, id);
    coopAddHistory('ytnn', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
    return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/ytnn/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ nộp lại khi đề xuất đang yêu cầu bổ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('ytnn');
    db.prepare(`UPDATE htqt_de_xuat SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('ytnn', id, 2, 'nop_lai', 'Nộp lại hồ sơ — chờ Phòng KHCN phân loại & thẩm định', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('ytnn', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã nộp lại hồ sơ — YTNN — ${ma}`,
      html: coopBuildEmail('Nộp lại hồ sơ (YTNN)', `Người gửi đã nộp lại hồ sơ. Đề xuất quay lại bước <strong>Phòng KHCN</strong>, sau đó trình Viện trưởng.`,
        [['Mã', ma], ['Tên', row.ten || '—']], 'Trân trọng.', modUrl),
      text: `Nộp lại YTNN ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai ytnn]', err.message));
    return res.json({ ok: true, message: 'Đã nộp lại.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

app.post('/api/cooperation/ytnn/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chỉ kết thúc khi đề xuất đang yêu cầu bổ sung.' });
    }
    db.prepare(`UPDATE htqt_de_xuat SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('ytnn', id, 3, 'ket_thuc_boi_nguoi_nop', 'Người gửi kết thúc đề xuất (không nộp lại)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('ytnn', {
      submitterEmail: row.submitted_by_email,
      subject: `[Hợp tác QT] Người gửi đã kết thúc đề xuất — YTNN — ${ma}`,
      html: coopBuildEmail('Kết thúc đề xuất (thông báo)', `Người gửi đã chủ động kết thúc đề xuất.`,
        [['Mã', ma]], 'Trân trọng.', modUrl),
      text: `Kết thúc YTNN ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc ytnn]', err.message));
    return res.json({ ok: true, message: 'Đã ghi nhận kết thúc đề xuất.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
});

// ============================================================
// ROUTE MỚI — SỰ KIỆN QUỐC TẾ
// ============================================================
app.post('/api/cooperation/su-kien', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  if (!body.tieu_de || !body.ngay_bat_dau) return res.status(400).json({ message: 'Thiếu Tiêu đề và Ngày bắt đầu.' });
  try {
    const result = db.prepare(`
      INSERT INTO cooperation_su_kien (tieu_de, mo_ta, loai_su_kien, quoc_gia, dia_diem, ngay_bat_dau, ngay_ket_thuc, don_vi_to_chuc, link_su_kien, han_dang_ky, kinh_phi_tham_du, ghi_chu, tags, status, created_by_id, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(body.tieu_de, body.mo_ta||'', body.loai_su_kien||'hoi_thao', body.quoc_gia||'', body.dia_diem||'',
      body.ngay_bat_dau, body.ngay_ket_thuc||'', body.don_vi_to_chuc||'',
      body.link_su_kien||'', body.han_dang_ky||'', body.kinh_phi_tham_du||'',
      body.ghi_chu||'', body.tags||'', body.status||'sap_dien_ra',
      user.id||null, user.fullname||user.email||'');
    return res.json({ ok:true, message:'Đã tạo sự kiện!', id: result.lastInsertRowid });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

app.get('/api/cooperation/su-kien', (req, res) => {
  try {
    const { status } = req.query;
    const rows = status
      ? db.prepare("SELECT * FROM cooperation_su_kien WHERE status=? ORDER BY ngay_bat_dau ASC").all(status)
      : db.prepare("SELECT * FROM cooperation_su_kien ORDER BY ngay_bat_dau DESC").all();
    return res.json({ list: rows });
  } catch(e) { return res.json({ list:[] }); }
});

app.put('/api/cooperation/su-kien/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const allowed = ['tieu_de','mo_ta','loai_su_kien','quoc_gia','dia_diem','ngay_bat_dau','ngay_ket_thuc','don_vi_to_chuc','link_su_kien','han_dang_ky','kinh_phi_tham_du','ghi_chu','tags','status'];
  const sets = [], vals = [];
  for (const k of allowed) { if (body[k] !== undefined) { sets.push(`${k}=?`); vals.push(body[k]); } }
  if (!sets.length) return res.status(400).json({ message: 'Không có gì cập nhật.' });
  sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_su_kien SET ${sets.join(',')} WHERE id=?`).run(...vals);
    return res.json({ ok:true, message:'Đã cập nhật.' });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

app.delete('/api/admin/cooperation/su-kien/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM cooperation_su_kien WHERE id=?').run(parseInt(req.params.id,10));
    return res.json({ ok:true, message:'Đã xóa sự kiện.' });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// ============================================================
// ROUTE MỚI — EVENTS WORKFLOW
// ============================================================
const EVENT_STATUS_ORDER = ['draft','cho_xin_phep','da_nop_xin_phep','da_duoc_phep','dang_to_chuc','cho_bao_cao','da_bao_cao','hoan_thanh'];
const EVENT_TRANSITIONS = {
  draft: ['cho_xin_phep'],
  cho_xin_phep: ['da_nop_xin_phep'],
  da_nop_xin_phep: ['da_duoc_phep'],
  da_duoc_phep: ['dang_to_chuc'],
  dang_to_chuc: ['cho_bao_cao'],
  cho_bao_cao: ['da_bao_cao'],
  da_bao_cao: ['hoan_thanh'],
};
function eventNormStatus(s) { const v = String(s || '').trim().toLowerCase(); return EVENT_STATUS_ORDER.includes(v) ? v : 'draft'; }
function eventGetById(id) { return db.prepare('SELECT * FROM events WHERE id = ? AND deleted_at IS NULL').get(id); }
function eventGetSessions(id) { return db.prepare('SELECT id, event_id, ngay, gio_bat_dau, gio_ket_thuc, noi_dung, thu_tu FROM event_sessions WHERE event_id = ? ORDER BY COALESCE(thu_tu, 999), id').all(id); }
function eventGetFiles(id) { return db.prepare('SELECT id, event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload, ngay_upload FROM event_files WHERE event_id = ? ORDER BY ngay_upload DESC, id DESC').all(id); }
function eventGenSoVanBan() {
  const y = String(new Date().getFullYear());
  const row = db.prepare('SELECT COUNT(*) AS c FROM events WHERE strftime("%Y", COALESCE(ngay_tao, datetime("now"))) = ?').get(y);
  return String(((row && row.c) || 0) + 1) + '/SCI-KHCN&QHĐN';
}
function eventStatusTransitionError(ev, toStatus) {
  const from = eventNormStatus(ev.trang_thai);
  const to = eventNormStatus(toStatus);
  if (!(EVENT_TRANSITIONS[from] || []).includes(to)) return 'Không đúng thứ tự chuyển trạng thái.';
  if (to === 'da_duoc_phep') {
    const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file = 'quyet_dinh_cho_phep' LIMIT 1").get(ev.id);
    if (!has) return 'Cần upload Quyết định cho phép trước khi chuyển trạng thái này.';
  }
  if (to === 'da_bao_cao') {
    const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file IN ('bao_cao_su_kien','quyet_dinh_bao_cao') LIMIT 1").get(ev.id);
    if (!has) return 'Cần upload Báo cáo có dấu đỏ trước khi chuyển trạng thái này.';
  }
  return '';
}
const uploadEventFiles = multer({
  storage: multer.diskStorage({
    destination: function (req, _file, cb) {
      const id = parseInt(req.params.id, 10);
      const dir = path.join(uploadDir, 'events', String(id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: function (_req, file, cb) {
      const ext = path.extname(file.originalname || '') || '.bin';
      const safe = path.basename(file.originalname || 'file', ext).replace(/[^\w\-]+/g, '_').slice(0, 80);
      cb(null, Date.now() + '_' + safe + ext.toLowerCase());
    },
  }),
  limits: { fileSize: UPLOAD_FILE_BYTES_SUBMISSION, fieldSize: MULTIPART_MAX_FIELD_BYTES, files: 10 },
  fileFilter: function (_req, file, cb) {
    const n = (file.originalname || '').toLowerCase();
    if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Chỉ nhận PDF, DOC, DOCX, JPG, PNG'));
    cb(null, true);
  },
});

app.get('/api/events', authMiddleware, (req, res) => {
  try {
    const q = req.query || {};
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (q.loai) { conds.push('loai = ?'); params.push(String(q.loai)); }
    if (q.trang_thai) { conds.push('trang_thai = ?'); params.push(eventNormStatus(q.trang_thai)); }
    if (q.nam) { conds.push('strftime("%Y", COALESCE(ngay_bat_dau, ngay_tao)) = ?'); params.push(String(q.nam)); }
    const list = db.prepare(`SELECT id, so_van_ban, tieu_de, loai, ngay_bat_dau, ngay_ket_thuc, trang_thai, ngay_tao FROM events WHERE ${conds.join(' AND ')} ORDER BY COALESCE(ngay_bat_dau, ngay_tao) DESC, id DESC`).all(...params);
    return res.json({ ok: true, list });
  } catch (e) { return res.status(500).json({ message: 'Lỗi tải danh sách sự kiện: ' + e.message }); }
});
app.post('/api/events', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const b = req.body || {};
  if (!String(b.tieu_de || '').trim() || !String(b.ngay_bat_dau || '').trim()) return res.status(400).json({ message: 'Thiếu Tên sự kiện hoặc Ngày bắt đầu.' });
  try {
    const so = String(b.so_van_ban || '').trim() || eventGenSoVanBan();
    const ins = db.prepare(`INSERT INTO events (so_van_ban,tieu_de,loai,don_vi_to_chuc,hinh_thuc,link_su_kien,dia_diem,quy_mo,lich_trinh,muc_tieu,thanh_phan_tham_du,kinh_phi_du_kien,nguon_kinh_phi,ngay_bat_dau,ngay_ket_thuc,han_dang_ky,nguoi_tao,trang_thai,nguoi_phu_trach,phu_trach_lien_he,ghi_chu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(so, b.tieu_de || '', b.loai || 'Hội thảo', b.don_vi_to_chuc || '', b.hinh_thuc || '', b.link_su_kien || '', b.dia_diem || '', b.quy_mo ? Number(b.quy_mo) : null, JSON.stringify(b.lich_trinh || []), b.muc_tieu || '', b.thanh_phan_tham_du || '', b.kinh_phi_du_kien ? Number(b.kinh_phi_du_kien) : 0, b.nguon_kinh_phi || '', b.ngay_bat_dau || '', b.ngay_ket_thuc || '', b.han_dang_ky || '', req.user.fullname || req.user.email || '', eventNormStatus(b.trang_thai || 'draft'), b.nguoi_phu_trach || '', b.phu_trach_lien_he || '', b.ghi_chu || '');
    const id = Number(ins.lastInsertRowid);
    db.prepare('INSERT INTO event_status_history (event_id, from_status, to_status, note, changed_by_id, changed_by_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, null, eventNormStatus(b.trang_thai || 'draft'), 'Tạo sự kiện', req.user.id || null, req.user.fullname || req.user.email || '');
    return res.status(201).json({ ok: true, id, so_van_ban: so });
  } catch (e) { return res.status(500).json({ message: 'Lỗi tạo sự kiện: ' + e.message }); }
});
app.get('/api/events/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  const event = eventGetById(id);
  if (!event) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
  const sessions = eventGetSessions(id);
  const files = eventGetFiles(id);
  const history = db.prepare('SELECT * FROM event_status_history WHERE event_id = ? ORDER BY id DESC').all(id);
  return res.json({ ok: true, event, sessions, files, history });
});
app.put('/api/events/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const sets = [], vals = [];
  ['so_van_ban','tieu_de','loai','don_vi_to_chuc','hinh_thuc','link_su_kien','dia_diem','quy_mo','lich_trinh','muc_tieu','thanh_phan_tham_du','kinh_phi_du_kien','nguon_kinh_phi','ngay_bat_dau','ngay_ket_thuc','han_dang_ky','so_nguoi_tham_du_thuc_te','ket_qua_su_kien','de_xuat_kien_nghi','bai_hoc_kinh_nghiem','uu_diem','han_che','nguoi_phu_trach','phu_trach_lien_he','ghi_chu'].forEach((k) => {
    if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(k === 'lich_trinh' ? JSON.stringify(b[k] || []) : b[k]); }
  });
  if (!sets.length) return res.status(400).json({ message: 'Không có gì cập nhật.' });
  vals.push(id);
  const r = db.prepare(`UPDATE events SET ${sets.join(',')} WHERE id = ? AND deleted_at IS NULL`).run(...vals);
  if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
  return res.json({ ok: true, message: 'Đã cập nhật.' });
});
app.delete('/api/events/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
  db.prepare("UPDATE events SET deleted_at = datetime('now','localtime') WHERE id = ?").run(id);
  return res.json({ ok: true, message: 'Đã xóa sự kiện.' });
});
app.patch('/api/events/:id/status', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const to = eventNormStatus((req.body || {}).to_status);
  const note = String((req.body || {}).note || '').slice(0, 2000);
  const ev = eventGetById(id);
  if (!ev) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
  const err = eventStatusTransitionError(ev, to);
  if (err) return res.status(400).json({ message: err });
  const from = eventNormStatus(ev.trang_thai);
  db.prepare('UPDATE events SET trang_thai = ? WHERE id = ?').run(to, id);
  db.prepare('INSERT INTO event_status_history (event_id, from_status, to_status, note, changed_by_id, changed_by_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, from, to, note || null, req.user.id || null, req.user.fullname || req.user.email || '');
  return res.json({ ok: true, from_status: from, to_status: to });
});
app.get('/api/events/:id/sessions', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  return res.json({ ok: true, list: eventGetSessions(id) });
});
app.put('/api/events/:id/sessions', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const list = Array.isArray((req.body || {}).sessions) ? req.body.sessions : [];
  if (!eventGetById(id)) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
  db.transaction(() => {
    db.prepare('DELETE FROM event_sessions WHERE event_id = ?').run(id);
    const ins = db.prepare('INSERT INTO event_sessions (event_id, ngay, gio_bat_dau, gio_ket_thuc, noi_dung, thu_tu) VALUES (?, ?, ?, ?, ?, ?)');
    list.forEach((s, i) => ins.run(id, s.ngay || '', s.gio_bat_dau || '', s.gio_ket_thuc || '', s.noi_dung || '', i + 1));
    db.prepare('UPDATE events SET lich_trinh = ? WHERE id = ?').run(JSON.stringify(list), id);
  })();
  return res.json({ ok: true, count: list.length });
});
app.post('/api/events/:id/files', authMiddleware, coopPhongOrAdmin, (req, res) => {
  uploadEventFiles.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload thất bại' });
    const id = parseInt(req.params.id, 10);
    if (!eventGetById(id)) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
    const loai = String((req.body || {}).loai_file || 'khac');
    const moTa = (req.body || {}).mo_ta ? String(req.body.mo_ta).slice(0, 2000) : null;
    const out = [];
    for (const f of req.files || []) {
      const rel = path.join('uploads', 'events', String(id), f.filename).replace(/\\/g, '/');
      const ins = db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, loai, f.originalname || f.filename, rel, moTa, req.user.fullname || req.user.email || '');
      out.push({ id: Number(ins.lastInsertRowid), ten_file: f.originalname || f.filename, duong_dan: rel, loai_file: loai });
    }
    return res.json({ ok: true, files: out });
  });
});
app.get('/api/events/:id/files', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  return res.json({ ok: true, list: eventGetFiles(id) });
});
app.delete('/api/events/:id/files/:fileId', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fid = parseInt(req.params.fileId, 10);
  const row = db.prepare('SELECT * FROM event_files WHERE id = ? AND event_id = ?').get(fid, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  try {
    const abs = resolveEventUploadFileForUnlink(row.duong_dan, id);
    if (abs) fs.unlinkSync(abs);
  } catch (_) {}
  db.prepare('DELETE FROM event_files WHERE id = ?').run(fid);
  return res.json({ ok: true });
});
app.post('/api/events/:id/export/to-trinh', authMiddleware, coopPhongOrAdmin, async (req, res) => {
  try {
    const tpl = path.join(__dirname, 'templates', 'events', 'to_trinh_xin_phep.docx');
    if (!fs.existsSync(tpl)) {
      return res.status(400).json({ message: 'Thiếu template Word: templates/events/to_trinh_xin_phep.docx. Vui lòng đặt đúng file mẫu để xuất đúng định dạng.' });
    }
    const id = parseInt(req.params.id, 10);
    const ev = eventGetById(id);
    if (!ev) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
    const sessions = eventGetSessions(id);
    const data = {
      so_van_ban: ev.so_van_ban || '',
      tieu_de: ev.tieu_de || '',
      loai: ev.loai || '',
      hinh_thuc: ev.hinh_thuc || '',
      dia_diem: ev.dia_diem || '',
      link_su_kien: ev.link_su_kien || '',
      quy_mo: ev.quy_mo || '',
      muc_tieu: ev.muc_tieu || '',
      thanh_phan_tham_du: ev.thanh_phan_tham_du || '',
      kinh_phi_du_kien: ev.kinh_phi_du_kien || 0,
      kinh_phi_bang_chu: toVietnameseCurrencyWords(ev.kinh_phi_du_kien || 0),
      nguon_kinh_phi: ev.nguon_kinh_phi || '',
      ngay_bat_dau: ev.ngay_bat_dau || '',
      ngay_ket_thuc: ev.ngay_ket_thuc || '',
      lich_trinh: sessions.map((s, i) => ({ stt: i + 1, ngay: s.ngay || '', gio_bat_dau: s.gio_bat_dau || '', gio_ket_thuc: s.gio_ket_thuc || '', noi_dung: s.noi_dung || '' })),
    };
    const buf = await buildEventPermissionDocBuffer(data);
    const fn = 'to_trinh_xin_phep_' + id + '_' + Date.now() + '.docx';
    const dir = path.join(uploadDir, 'events', String(id)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fn), buf);
    const rel = path.join('uploads', 'events', String(id), fn).replace(/\\/g, '/');
    db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'to_trinh_xin_phep', fn, rel, 'Word tờ trình sinh tự động', req.user.fullname || req.user.email || '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"; filename*=UTF-8''${encodeURIComponent(fn)}`);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ message: 'Lỗi xuất Word: ' + e.message }); }
});
app.post('/api/events/:id/export/bao-cao', authMiddleware, coopPhongOrAdmin, async (req, res) => {
  try {
    const tpl = path.join(__dirname, 'templates', 'events', 'bao_cao_su_kien.docx');
    if (!fs.existsSync(tpl)) {
      return res.status(400).json({ message: 'Thiếu template Word: templates/events/bao_cao_su_kien.docx. Vui lòng đặt đúng file mẫu để xuất đúng định dạng.' });
    }
    const id = parseInt(req.params.id, 10);
    const ev = eventGetById(id);
    if (!ev) return res.status(404).json({ message: 'Không tìm thấy sự kiện' });
    const sessions = eventGetSessions(id);
    const data = { tieu_de: ev.tieu_de || '', ngay_bat_dau: ev.ngay_bat_dau || '', ngay_ket_thuc: ev.ngay_ket_thuc || '', so_nguoi_tham_du_thuc_te: ev.so_nguoi_tham_du_thuc_te || '', ket_qua_su_kien: ev.ket_qua_su_kien || '', de_xuat_kien_nghi: ev.de_xuat_kien_nghi || '', bai_hoc_kinh_nghiem: ev.bai_hoc_kinh_nghiem || '', uu_diem: ev.uu_diem || '', han_che: ev.han_che || '', lich_trinh: sessions };
    const buf = await buildEventReportDocBuffer(data);
    const fn = 'bao_cao_su_kien_' + id + '_' + Date.now() + '.docx';
    const dir = path.join(uploadDir, 'events', String(id)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fn), buf);
    const rel = path.join('uploads', 'events', String(id), fn).replace(/\\/g, '/');
    db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'bao_cao_su_kien', fn, rel, 'Word báo cáo sinh tự động', req.user.fullname || req.user.email || '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"; filename*=UTF-8''${encodeURIComponent(fn)}`);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ message: 'Lỗi xuất Word: ' + e.message }); }
});

// ============================================================
// ROUTE MỚI — ADMIN: SỬA/XÓA ĐỀ XUẤT
// ============================================================
const COOP_ADMIN_DENY_COLS = new Set(['id', 'created_at', 'updated_at']);

function coopAdminUpdateSetsFromBody(body, allowedColSet) {
  const sets = [];
  const vals = [];
  const b = body && typeof body === 'object' ? body : {};
  for (const k of Object.keys(b)) {
    if (COOP_ADMIN_DENY_COLS.has(k)) continue;
    if (!allowedColSet.has(k)) continue;
    sets.push(`${k}=?`);
    vals.push(b[k]);
  }
  return { sets, vals };
}

const COOP_ADMIN_COLS_DOAN_RA = new Set([
  'submitted_by_email', 'submitted_by_name', 'muc_dich', 'quoc_gia', 'ngay_di', 'ngay_ve', 'thanh_vien', 'nguon_kinh_phi', 'du_toan', 'status',
  'ma_de_xuat', 'submitted_by_id', 'ghi_chu', 'note_phong', 'note_vt', 'phong_xu_ly_id', 'phong_xu_ly_at', 'vt_xu_ly_id', 'vt_xu_ly_at',
  'van_ban_word_path', 'van_ban_word_original_name', 'van_ban_word_uploaded_at', 'coop_reminder_last_at',
]);
const COOP_ADMIN_COLS_DOAN_VAO = new Set([
  'submitted_by_email', 'submitted_by_name', 'muc_dich', 'don_vi_de_xuat', 'ngay_den', 'ngay_roi_di', 'thanh_phan_doan', 'noi_dung_lam_viec',
  'kinh_phi_nguon', 'ho_tro_visa', 'status',
  'ma_de_xuat', 'submitted_by_id', 'ghi_chu', 'note_phong', 'note_vt', 'phong_xu_ly_id', 'phong_xu_ly_at', 'vt_xu_ly_id', 'vt_xu_ly_at',
  'van_ban_word_path', 'van_ban_word_original_name', 'van_ban_word_uploaded_at', 'coop_reminder_last_at',
]);
const COOP_ADMIN_COLS_MOU = new Set([
  'submitted_by_email', 'submitted_by_name', 'loai_thoa_thuan', 'ten_doi_tac', 'quoc_gia', 'thoi_han_nam', 'gia_tri_tai_chinh', 'don_vi_de_xuat',
  'noi_dung_hop_tac', 'status',
  'ma_de_xuat', 'submitted_by_id', 'ghi_chu', 'note_phong', 'note_vt', 'phong_xu_ly_id', 'phong_xu_ly_at', 'vt_xu_ly_id', 'vt_xu_ly_at',
  'van_ban_word_path', 'van_ban_word_original_name', 'van_ban_word_uploaded_at', 'coop_reminder_last_at',
]);
const COOP_ADMIN_COLS_YTNN = new Set([
  'ma_de_xuat', 'ten', 'mo_ta', 'doi_tac_ten', 'doi_tac_quoc_gia', 'doi_tac_nguoi_dai_dien', 'doi_tac_website', 'hinh_thuc_hop_tac',
  'chu_nhiem_ten', 'chu_nhiem_hoc_vi', 'chu_nhiem_don_vi', 'thanh_vien_json', 'ngay_bat_dau', 'ngay_ket_thuc', 'thoi_gian_thang',
  'kinh_phi', 'don_vi_tien_te', 'kinh_phi_vnd', 'loai_hinh', 'to_phan_loai_json', 'to_trinh_phong_khcn', 'de_nghi_vt', 'vt_y_kien',
  'vt_ngay_ky', 'vt_so_van_ban', 'vt_nguoi_ky_id', 'ly_do_khong_duyet', 'han_xu_ly_vt', 'muc_do_uu_tien', 'ghi_chu_noi_bo', 'nguoi_phu_trach_id',
  'phi_quan_ly_pct', 'phi_quan_ly_vnd', 'submitted_by_email', 'submitted_by_name', 'submitted_by_id', 'status', 'ngay_tiep_nhan',
  'note_phong', 'note_vt', 'phong_xu_ly_id', 'phong_xu_ly_at', 'vt_xu_ly_id', 'vt_xu_ly_at',
  'van_ban_word_path', 'van_ban_word_original_name', 'van_ban_word_uploaded_at', 'coop_reminder_last_at',
]);

const COOP_ADMIN_COLS_BY_EP = {
  'doan-ra': COOP_ADMIN_COLS_DOAN_RA,
  'doan-vao': COOP_ADMIN_COLS_DOAN_VAO,
  mou: COOP_ADMIN_COLS_MOU,
};

['doan-ra','doan-vao','mou'].forEach(ep => {
  const tableMap = { 'doan-ra':'cooperation_doan_ra', 'doan-vao':'cooperation_doan_vao', 'mou':'cooperation_mou_de_xuat' };
  const loaiMap = { 'doan-ra':'doan_ra', 'doan-vao':'doan_vao', 'mou':'mou' };
  const tbl = tableMap[ep];
  const loai = loaiMap[ep];
  const colWhitelist = COOP_ADMIN_COLS_BY_EP[ep];
  app.put(`/api/admin/cooperation/${ep}/:id`, authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    const { sets, vals } = coopAdminUpdateSetsFromBody(body, colWhitelist);
    if (!sets.length) return res.status(400).json({ message:'Không có gì cập nhật.' });
    sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
    try {
      const r = db.prepare(`UPDATE ${tbl} SET ${sets.join(',')} WHERE id=?`).run(...vals);
      if (r.changes===0) return res.status(404).json({ message:'Không tìm thấy.' });
      coopAddHistory(loai, id, 0, 'admin_edit', 'Admin chỉnh sửa', req.user, JSON.stringify(body));
      if (ep === 'mou' && String(body.status || '').toLowerCase() === 'da_duyet') {
        try {
          const gen = coopTryAutoGenerateMouVanBan(id);
          if (!gen.ok && gen.skipped === 'no_template') {
            console.warn('[mou] Admin đặt trạng thái Đã phê duyệt nhưng chưa có mẫu Word trên hệ thống.');
          } else if (!gen.ok && gen.skipped === 'error') {
            console.error('[mou] Auto Word sau admin cập nhật:', gen.message);
          }
        } catch (e) {}
      }
      return res.json({ ok:true, message:'Đã cập nhật.' });
    } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
  });
  app.delete(`/api/admin/cooperation/${ep}/:id`, authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    try {
      if (ep === 'doan-ra') {
        const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
        coopUnlinkDoanRaVanBanFile(row);
      }
      if (ep === 'doan-vao') {
        const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
        coopUnlinkDoanVaoVanBanFile(row);
      }
      if (ep === 'mou') {
        const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
        coopUnlinkMouVanBanFile(row);
      }
      db.prepare(`DELETE FROM ${tbl} WHERE id=?`).run(id);
      try { db.prepare('DELETE FROM coop_history WHERE loai=? AND de_xuat_id=?').run(loai, id); } catch(e) {}
      return res.json({ ok:true, message:'Đã xóa.' });
    } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
  });
});

// admin ytnn
app.put('/api/admin/cooperation/ytnn/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const { sets, vals } = coopAdminUpdateSetsFromBody(body, COOP_ADMIN_COLS_YTNN);
  if (!sets.length) return res.status(400).json({ message:'Không có gì cập nhật.' });
  sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
  try {
    const r = db.prepare(`UPDATE htqt_de_xuat SET ${sets.join(',')} WHERE id=?`).run(...vals);
    if (r.changes === 0) return res.status(404).json({ message: 'Không tìm thấy.' });
    coopAddHistory('ytnn', id, 0, 'admin_edit', 'Admin chỉnh sửa', req.user, JSON.stringify(body));
    if (String(body.status || '').toLowerCase() === 'da_duyet') {
      try {
        const gen = coopTryAutoGenerateYtnnVanBan(id);
        if (!gen.ok && gen.skipped === 'no_template') {
          console.warn('[ytnn] Admin đặt trạng thái Đã phê duyệt nhưng chưa có mẫu Word trên hệ thống.');
        } else if (!gen.ok && gen.skipped === 'error') {
          console.error('[ytnn] Auto Word sau admin cập nhật:', gen.message);
        }
      } catch (e) {}
    }
    return res.json({ ok:true, message:'Đã cập nhật.' });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});
app.delete('/api/admin/cooperation/ytnn/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (row) coopUnlinkYtnnVanBanFile(row);
    db.prepare('DELETE FROM htqt_de_xuat WHERE id=?').run(id);
    try { db.prepare('DELETE FROM coop_history WHERE loai=? AND de_xuat_id=?').run('ytnn', id); } catch(e) {}
    return res.json({ ok:true, message:'Đã xóa.' });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// ============================================================
// HELPER: build title cho list view
// ============================================================
function coopBuildTitle(loai, r) {
  if (loai==='doan_ra') return `Đoàn ra — ${r.quoc_gia||'—'}${r.muc_dich?' ('+r.muc_dich+')':''}`;
  if (loai==='doan_vao') return `Đoàn vào — ${r.muc_dich||r.don_vi_de_xuat||'—'}`;
  if (loai==='mou') return `MOU — ${r.ten_doi_tac||'—'}${r.quoc_gia?', '+r.quoc_gia:''}`;
  if (loai==='ytnn') return `Đề tài có yếu tố nước ngoài — ${r.ten||'—'}`;
  return '—';
}

console.log('[Cooperation] ✅ Các route Hợp tác Quốc tế mới đã được đăng ký.');
// Lưu ý: middleware 404 cho /api phải đăng ký SAU mountSciKhcnPublicationsRouters()
// (enrich, journal-metrics, …). Nếu đặt trước, mọi /api/enrich/* sẽ 404.

// Serve dang-nhap.html với script inject: sau login redirect về trang pending
app.get('/dang-nhap.html', (req, res) => {
  const filePath = path.join(__dirname, 'dang-nhap.html');
  if (!fs.existsSync(filePath)) return res.status(404).send('Không tìm thấy trang đăng nhập');
  let html = fs.readFileSync(filePath, 'utf8');
  const injectScript = `
<script>
// HTQT Login Hook: sau khi đăng nhập thành công, redirect về trang pending
(function() {
  var _fetch = window.fetch;
  window.fetch = function(url, opts) {
    return _fetch.apply(this, arguments).then(function(response) {
      if (typeof url === 'string' && url.indexOf('/api/login') !== -1 && response.ok) {
        response.clone().json().then(function(data) {
          if (data && data.token) {
            var pending = sessionStorage.getItem('htqt_redirect_after_login');
            if (pending) {
              sessionStorage.removeItem('htqt_redirect_after_login');
              setTimeout(function() { window.location.href = pending; }, 200);
            }
          }
        }).catch(function() {});
      }
      return response;
    });
  };
})();
</script>`;
  // Inject trước </body>
  if (html.includes('</body>')) {
    html = html.replace('</body>', injectScript + '\n</body>');
  } else {
    html = html + injectScript;
  }
  res.type('html').send(html);
});

// Chỉ cho phép khách (chưa đăng nhập) xem trang chủ và các trang đăng nhập/đăng ký/quên mật khẩu; các trang .html khác cần cookie JWT hợp lệ.
const PUBLIC_HTML_AUTH = new Set([
  'dang-nhap.html',
  'dang-ky.html',
  'crd-dang-ky.html',
  'quen-mat-khau.html',
  'dat-lai-mat-khau.html',
]);
function isPublicHtmlPath(reqPath) {
  const p = (reqPath || '').replace(/\\/g, '/');
  if (p === '/' || p === '' || p === '/index.html') return true;
  if (/\/public\/equipment\/public\.html$/i.test(p)) return true;
  const base = path.basename(p);
  return PUBLIC_HTML_AUTH.has(base);
}

/** Đường dẫn không đuôi .html — Đăng ký HN/HT */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = (req.path || '').replace(/\\/g, '/');
  const hnhtMap = {
    '/hop-tac/hoi-nghi-hoi-thao/dang-ky': 'hop-tac/hoi-nghi-hoi-thao/dang-ky.html',
    '/hop-tac/hoi-nghi-hoi-thao/cua-toi': 'hop-tac/hoi-nghi-hoi-thao/cua-toi.html',
    '/hop-tac/hoi-nghi-hoi-thao/chi-tiet': 'hop-tac/hoi-nghi-hoi-thao/chi-tiet.html',
    '/quan-ly/hoi-nghi-hoi-thao': 'quan-ly/hoi-nghi-hoi-thao.html',
  };
  const rel = hnhtMap[p];
  if (!rel) return next();
  const token = getTokenFromReq(req);
  if (!token) {
    return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(p));
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (userIdIsBanned(payload.id)) {
      clearAuthCookie(res);
      return res.redirect(302, '/dang-nhap.html?banned=1');
    }
  } catch (e) {
    return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(p));
  }
  const abs = path.join(__dirname, rel);
  if (!fs.existsSync(abs)) return next();
  return res.sendFile(abs);
});

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const reqPath = req.path || '';
  if (!reqPath.endsWith('.html')) return next();

  const token0 = getTokenFromReq(req);
  if (token0) {
    try {
      const payload0 = jwt.verify(token0, JWT_SECRET);
      if (!userIdIsBanned(payload0.id) && isCrdOnlyUserRole(payload0.role)) {
        const base0 = path.basename(reqPath);
        const htmlOkForCrd = new Set([
          'crd-booking-v2.html',
          'crd-dang-ky.html',
          'dang-nhap.html',
          'quen-mat-khau.html',
          'dat-lai-mat-khau.html',
        ]);
        const pathNormCrd = (reqPath || '').replace(/\\/g, '/');
        const crdPublicEquipment = pathNormCrd.includes('/public/equipment/public.html');
        if (!htmlOkForCrd.has(base0) && !crdPublicEquipment) {
          return res.redirect(302, '/crd-booking-v2.html');
        }
      }
    } catch (e) {
      /* token lỗi — xử lý bước dưới */
    }
  }

  if (isPublicHtmlPath(reqPath)) return next();
  const token = getTokenFromReq(req);
  if (!token) {
    const base = path.basename(reqPath);
    return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(base));
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (userIdIsBanned(payload.id)) {
      clearAuthCookie(res);
      return res.redirect(302, '/dang-nhap.html?banned=1');
    }
    return next();
  } catch (e) {
    const base = path.basename(reqPath);
    return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent(base));
  }
});

/** Không cho tải source / cấu hình qua static (trước đây chỉ .html có auth). */
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let p = (req.path || '').replace(/\\/g, '/');
  try {
    p = decodeURIComponent(p);
  } catch (_) {
    return res.status(400).end();
  }
  if (p.includes('..')) return res.status(403).end();
  p = p.split('?')[0].toLowerCase();
  const blocked = [
    /^\/server\.js$/,
    /^\/server-backup.*\.js$/,
    /^\/package(-lock)?\.json$/,
    /^\/\.env/,
    /^\/lib\//,
    /^\/routes\//,
    /^\/services\//,
    /^\/views\//,
    /^\/templates\//,
    /^\/node_modules\//,
    /^\/middleware\//,
    /^\/migrations\//,
    /^\/scripts\//,
    /^\/database\//,
    /^\/db\//,
    /^\/sci-khcn-publications\//,
    /^\/data\//,
    /^\/uploads\//,
    /^\/uploads\/equipment\//,
    /^\/\.git/,
    /^\/crd-lab-booking\/main\.jsx$/,
    /^\/(fix-crd-created-at|test-insert-created-at)\.js$/,
  ];
  if (blocked.some((r) => r.test(p))) return res.status(403).end();
  return next();
});

// Local fallback for equipment Excel importer when CDN is blocked.
app.get('/public/vendor/xlsx.full.min.js', (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
  } catch (e) {
    return res.status(404).send('xlsx bundle not found');
  }
});

// Local fallback for SortableJS used by homepage drag-and-drop.
app.get('/public/vendor/Sortable.min.js', (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'node_modules', 'sortablejs', 'Sortable.min.js'));
  } catch (e) {
    return res.status(404).send('sortable bundle not found');
  }
});

app.use(
  express.static(__dirname, {
    /** Tắt ETag/Last-Modified — nếu không, trình duyệt vẫn nhận 304 dù có Cache-Control (file HTML cũ). */
    etag: false,
    lastModified: false,
    /** Tránh cache HTML; các file khác vẫn tải lại đầy đủ khi không còn 304. */
    setHeaders(res, filePath) {
      const lower = String(filePath || '').toLowerCase();
      if (lower.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  })
);

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
    const { createConferenceEmailService } = require('./services/conferenceEmailService');
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

async function mountSciKhcnPublicationsRouters() {
  const moduleBase = path.join(__dirname, 'sci-khcn-publications', 'src');
  const toUrl = (p) => pathToFileURL(p).href;
  const [pubMod, orcidMod, doiMod, dbMod, authPubMod, trustMod] = await Promise.all([
    import(toUrl(path.join(moduleBase, 'routes', 'publications.js'))),
    import(toUrl(path.join(moduleBase, 'routes', 'orcid.js'))),
    import(toUrl(path.join(moduleBase, 'routes', 'doi.js'))),
    import(toUrl(path.join(moduleBase, 'db', 'index.js'))),
    import(toUrl(path.join(moduleBase, 'middleware', 'publicationsAuthMiddleware.js'))),
    import(toUrl(path.join(moduleBase, 'lib', 'trustScoring.js'))),
  ]);

  if (dbMod && typeof dbMod.initDB === 'function') {
    await dbMod.initDB();
  }

  const enrichService = require(path.join(__dirname, 'services', 'enrichmentService.js'));

  function normalizeIssnJournalMetricsInput(raw) {
    if (raw == null || String(raw).trim() === '') return null;
    const compact = String(raw).replace(/[^0-9Xx]/g, '');
    if (compact.length !== 8) return null;
    return `${compact.slice(0, 4)}-${compact.slice(4).toUpperCase()}`;
  }

  app.post('/api/enrich/trigger', authMiddleware, adminOnly, async (req, res) => {
    try {
      const publicationIds = Array.isArray(req.body?.publicationIds) ? req.body.publicationIds : [];
      const stats = await enrichService.enrichPublicationBatch(publicationIds);
      return res.json({
        message: 'Enrichment hoàn tất',
        stats,
      });
    } catch (e) {
      console.error('[enrich/trigger]', e);
      return res.status(500).json({ message: e.message || 'Lỗi enrichment' });
    }
  });

  app.get('/api/enrich/stats', authMiddleware, async (req, res) => {
    try {
      const stats = await enrichService.getEnrichmentStats();
      return res.json(stats);
    } catch (e) {
      console.error('[enrich/stats]', e);
      return res.status(500).json({ message: e.message || 'Lỗi thống kê enrichment' });
    }
  });

  if (typeof pubMod.mountEnrichmentStatsSse === 'function') {
    pubMod.mountEnrichmentStatsSse(app, authMiddleware, () => enrichService.getEnrichmentStats());
  }

  const { importScimagoCsvToJournalMetrics } = require(path.join(__dirname, 'lib', 'sjr-csv-import'));
  app.post(
    '/api/admin/sjr-csv-import',
    authMiddleware,
    adminOnly,
    (req, res, next) => {
      uploadSjrCsv.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ message: err.message || 'Upload thất bại' });
        next();
      });
    },
    async (req, res) => {
      try {
        const year = parseInt(req.body?.year, 10);
        if (!Number.isFinite(year) || year < 1900 || year > 2100) {
          return res.status(400).json({ message: 'Năm SJR không hợp lệ (1900–2100)' });
        }
        const buf = req.file?.buffer;
        if (!buf || !buf.length) {
          return res.status(400).json({ message: 'Vui lòng chọn file CSV (tên field: file)' });
        }
        const csvText = buf.toString('utf8');
        const result = await importScimagoCsvToJournalMetrics(db, csvText, year);
        return res.json({
          message: `Import SJR ${year}: ${result.ok} dòng OK, ${result.fail} lỗi/bỏ qua (tổng ${result.total} dòng CSV)`,
          ...result,
        });
      } catch (e) {
        console.error('[sjr-csv-import]', e);
        return res.status(500).json({ message: e.message || 'Lỗi import SJR' });
      }
    }
  );

  app.post('/api/admin/journal-metrics/update-if', authMiddleware, adminOnly, (req, res) => {
    try {
      const issnNorm = normalizeIssnJournalMetricsInput(req.body?.issn);
      if (!issnNorm || !/^\d{4}-[\dX]{4}$/i.test(issnNorm)) {
        return res.status(400).json({ message: 'ISSN phải đúng định dạng XXXX-XXXX' });
      }
      const year = parseInt(req.body?.year, 10);
      if (!Number.isFinite(year) || year < 1900 || year > 2100) {
        return res.status(400).json({ message: 'Năm không hợp lệ (1900–2100)' });
      }
      const jcrIf = Number(req.body?.jcr_if);
      if (!Number.isFinite(jcrIf) || jcrIf <= 0) {
        return res.status(400).json({ message: 'jcr_if phải là số dương' });
      }
      const r = db
        .prepare(
          `UPDATE journal_metrics SET jcr_if_manual = ?, updated_at = datetime('now')
           WHERE sjr_year = ? AND (issn_print = ? OR issn_electronic = ?)`
        )
        .run(jcrIf, year, issnNorm, issnNorm);
      const changes = Number(r?.changes ?? 0);
      if (!changes) {
        return res.status(404).json({
          message: 'Không tìm thấy bản ghi journal_metrics khớp ISSN và năm SJR',
        });
      }
      return res.json({ ok: true, message: 'Đã cập nhật JCR IF', changes });
    } catch (e) {
      console.error('[journal-metrics/update-if]', e);
      return res.status(500).json({ message: e.message || 'Lỗi CSDL' });
    }
  });

  const pubQuickReport = require(path.join(__dirname, 'services', 'pubQuickReport.js'));

  app.get('/api/publications/export/excel', authMiddleware, async (req, res) => {
    try {
      const rows = await pubQuickReport.queryPublicationsExportRows(db, req.query);
      const buf = pubQuickReport.buildExcelBuffer(rows);
      const fn = 'cong-bo-khoa-hoc-' + new Date().toISOString().slice(0, 10) + '.xlsx';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="' + fn + '"');
      res.send(Buffer.from(buf));
    } catch (e) {
      console.error('[export/excel]', e);
      if (!res.headersSent) res.status(500).json({ message: e.message || 'Lỗi xuất Excel' });
    }
  });

  app.get('/api/publications/export/report', authMiddleware, async (req, res) => {
    try {
      const rows = await pubQuickReport.queryPublicationsExportRows(db, req.query);
      const html = pubQuickReport.buildPrintableHtmlReport(rows, req.query, 'Báo cáo công bố khoa học');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      console.error('[export/report]', e);
      if (!res.headersSent) {
        res
          .status(500)
          .type('html')
          .send(
            '<!DOCTYPE html><html lang="vi"><meta charset="utf-8"><body><pre>' +
              String(e.message || e).replace(/</g, '&lt;') +
              '</pre></body></html>'
          );
      }
    }
  });

  app.post('/api/publications/admin/refresh-external-metrics', authMiddleware, adminOnly, async (req, res) => {
    try {
      const limit = Math.min(120, Math.max(1, parseInt(req.body?.limit, 10) || 45));
      const result = await pubQuickReport.refreshExternalMetrics(db, { limit });
      return res.json({
        message:
          `Đã xử lý ${result.processed} bản ghi, cập nhật ${result.rowsUpdated} dòng. OpenAlex: ${result.openalexHits}, Scopus: ${result.scopusHits}.`,
        ...result,
      });
    } catch (e) {
      console.error('[refresh-external-metrics]', e);
      return res.status(500).json({ message: e.message || 'Lỗi cập nhật Scopus/OpenAlex' });
    }
  });

  // Phải khai báo trước app.use('/api/publications', router) để không bị coi là :id
  app.get('/api/researchers/list-for-disambiguation', authPubMod.publicationsAuthMiddleware, (req, res) => {
    try {
      res.json({ success: true, researchers: trustMod.listResearchers() });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message || String(e) });
    }
  });

  app.delete('/api/publications/admin/clear-all', authMiddleware, masterAdminOnly, (req, res) => {
    try {
      const { confirm } = req.body && typeof req.body === 'object' ? req.body : {};
      if (confirm !== 'XOA-TOAN-BO') {
        return res.status(400).json({ message: 'Cần xác nhận bằng chuỗi "XOA-TOAN-BO" trong body JSON (confirm).' });
      }
      const rPub = db.prepare('DELETE FROM publications').run();
      let queueChanges = 0;
      try {
        const rQ = db.prepare('DELETE FROM publication_queue').run();
        queueChanges = Number(rQ.changes || 0);
      } catch (e) {
        if (!String(e.message || '').includes('no such table')) {
          console.warn('[publications/admin/clear-all] publication_queue:', e.message);
        }
      }
      insertUserActivityLog(req, {
        userId: req.user && req.user.id,
        email: req.user && req.user.email,
        action: 'publications_clear_all',
        module: 'publications',
        path: req.originalUrl || req.path || '/api/publications/admin/clear-all',
        detail: JSON.stringify({
          at: new Date().toISOString(),
          publicationsDeleted: Number(rPub.changes || 0),
          queueDeleted: queueChanges
        })
      });
      return res.json({
        ok: true,
        publicationsDeleted: Number(rPub.changes || 0),
        queueDeleted: queueChanges,
        message:
          'Đã xóa toàn bộ công bố trên CSDL và làm sạch hàng chờ ORCID (để quét lại không bị trùng DOI).',
      });
    } catch (e) {
      insertUserActivityLog(req, {
        userId: req.user && req.user.id,
        email: req.user && req.user.email,
        action: 'publications_clear_all_failed',
        module: 'publications',
        path: req.originalUrl || req.path || '/api/publications/admin/clear-all',
        detail: JSON.stringify({
          at: new Date().toISOString(),
          error: e && e.message ? e.message : String(e)
        })
      });
      console.error('[publications/admin/clear-all]', e);
      return res.status(500).json({ message: e.message || 'Không xóa được CSDL' });
    }
  });

  app.use('/api/publications', pubMod.publicationsRouter);

  const orcidServiceUrl = toUrl(path.join(moduleBase, 'services', 'orcidService.js'));
  app.post('/api/orcid/harvest', authMiddleware, adminOnly, async (req, res, next) => {
    try {
      const { runHarvestSession } = await import(orcidServiceUrl);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const opts = {};
      if (Array.isArray(body.researcherIds) && body.researcherIds.length) {
        opts.researcherIds = body.researcherIds;
      }
      if (Array.isArray(body.orcidIds) && body.orcidIds.length) {
        opts.orcidIds = body.orcidIds.map((s) => String(s).trim()).filter(Boolean);
      }
      if (Array.isArray(body.fullNames) && body.fullNames.length) {
        opts.fullNames = body.fullNames.map((s) => String(s).trim()).filter(Boolean);
      }
      const result = await runHarvestSession(opts);
      return res.json({ ok: true, success: true, data: result?.data || {}, ...result });
    } catch (e) {
      return next(e);
    }
  });

  app.use('/api/orcid', orcidMod.orcidRouter);
  app.use('/api/doi', doiMod.doiRouter);
  console.log('[SCI-KHCN] Đã mount /api/publications, /api/orcid, /api/doi');
}

(async () => {
  try {
    await mountSciKhcnPublicationsRouters();
  } catch (e) {
    console.error('[SCI-KHCN] Không mount được publications module:', e.message);
  }

  app.use('/api', (req, res, next) => {
    if (
      req.path.startsWith('/publications') ||
      req.path.startsWith('/orcid') ||
      req.path.startsWith('/doi')
    ) {
      return next();
    }
    const p = req.originalUrl || req.url || req.path;
    res.status(404).json({
      message:
        'Không tìm thấy API: ' +
        req.method +
        ' ' +
        p +
        '. Nếu vừa cập nhật code, hãy khởi động lại server (Ctrl+C rồi node server.js).',
    });
  });

  const bindHost =
    process.env.BIND_HOST != null && String(process.env.BIND_HOST).trim() !== ''
      ? String(process.env.BIND_HOST).trim()
      : undefined;
  function onListen() {
    const hostLabel = bindHost || '(mặc định Node)';
    console.log('SCI-ACE server lắng nghe PORT=' + PORT + ' host=' + hostLabel);
    console.log('Kiểm tra kết nối: http://127.0.0.1:' + PORT + '/api/health');
    console.log(`[clock] TZ=${process.env.TZ} (Vietnam civil time / ICT; override with TZ in .env)`);
    logServerTimeDriftVsGoogle();
    if (transporter) console.log('SMTP đã cấu hình — email thông báo sẽ gửi khi có sự kiện (nộp hồ sơ, yêu cầu bổ sung, kết quả họp...)');
    else console.log('Chưa cấu hình SMTP — kiểm tra file .env (SMTP_HOST, SMTP_USER, SMTP_PASS). Email thông báo sẽ không gửi.');
    console.log('Email nhắc nhở duyệt đề xuất: mỗi 3 ngày (phong cách hành chính nhà nước)');
    try {
      startWorker();
    } catch (e) {
      console.error('[EnrichWorker] Không khởi động được:', e.message || e);
    }
  }
  if (bindHost) {
    app.listen(PORT, bindHost, onListen);
  } else {
    app.listen(PORT, onListen);
  }
})();
