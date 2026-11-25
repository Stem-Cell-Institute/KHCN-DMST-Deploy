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
const { spawnSync } = require('child_process');
const appPaths = require('./lib/appPaths');
const { decodeUploadedFilename, setContentDisposition } = require('./lib/filenames');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const express = require('express');
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib;
const ipKeyGenerator =
  rateLimitLib.ipKeyGenerator ||
  ((ip) => {
    const raw = String(ip || '').trim();
    return raw || 'unknown';
  });
const helmet = require('helmet');
const cors = require('cors');
const multer = require('./lib/upload');
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
const { buildMissionReportBuffer } = require('./services/missionReportBuilder');

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
    return `ip:${ipKeyGenerator(ip)}`;
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
/**
 * Kiểm tra định dạng email an toàn trước khi lưu vào users.email — chặn khoảng trắng/ký tự điều
 * khiển (\r \n \t...) để email không thể dùng làm vector chèn header khi truyền cho nodemailer
 * (CRLF/SMTP header injection), vì email lưu trong DB sẽ được dùng lại ở rất nhiều chỗ gửi mail.
 */
function isSafeEmailFormat(str) {
  const s = String(str || '');
  if (s.length > 190) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
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
 * Hỗ trợ tiền tố uploads/ và uploads-cap-vien/ (cũ: relative từ thư mục code).
 * Lưu ý: bản cũ dùng path.relative(__dirname, file) nên có thể là
 * "data/uploads-cap-vien/..." — phải nhận diện uploads-cap-vien/ ở bất kỳ vị trí nào trong chuỗi.
 * Tương tự với uploads/ (vd. data/uploads/htqt-...) khi APP_DATA_DIR tách khỏi thư mục code.
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
  const capIdx = n.toLowerCase().indexOf(capMarker);
  if (capIdx !== -1) {
    const rest = n.slice(capIdx + capMarker.length);
    return path.normalize(path.resolve(uploadDirCapVien, rest));
  }
  const upMarker = 'uploads/';
  const upIdx = n.toLowerCase().indexOf(upMarker);
  if (upIdx !== -1) {
    const rest = n.slice(upIdx + upMarker.length);
    return path.normalize(path.resolve(uploadDir, rest));
  }
  // Legacy: một số bản ghi sai chỉ còn nhánh public-templates/... (resolve cũ gắn nhầm uploads/)
  if (n.startsWith('public-templates/')) {
    return path.normalize(path.resolve(uploadDirCapVien, n));
  }

  if (n.startsWith('uploads/')) {
    return path.normalize(path.resolve(uploadDir, n.slice('uploads/'.length)));
  }
  return path.normalize(path.resolve(uploadDir, n));
}

/** File vừa ghi dưới uploadDir → chuỗi lưu CSDL dạng uploads/... (không phụ thuộc __dirname / APP_DATA_DIR). */
function storedUploadsPathForDatabase(absoluteFilePath) {
  const abs = path.resolve(absoluteFilePath);
  const rel = path.relative(uploadDir, abs);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return 'uploads/' + rel.split(path.sep).join('/');
  }
  return path.relative(__dirname, abs).split(path.sep).join('/');
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
  const norm = resolveStoredFileFromDb(raw);
  if (!norm) return { err: 404 };
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
  CREATE TABLE IF NOT EXISTS cap_vien_code_sequences (
    year INTEGER PRIMARY KEY,
    seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS council_role_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    granted_by_id INTEGER,
    granted_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, role)
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
// Bước 9: danh mục hoá chất/vật tư đã "khoá" (số liệu chính thức để đối sánh dự toán, xem cap_vien_step9_supply_item).
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_at TEXT').run(); } catch (e) { /* đã tồn tại */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_by INTEGER').run(); } catch (e) { /* đã tồn tại */ }

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
  -- Bước 9 (Thực hiện đề tài): mốc hoạt động do Chủ nhiệm/Admin tự khai báo (thay vì 3 mốc cố định trước đây).
  CREATE TABLE IF NOT EXISTS cap_vien_step9_milestone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned', -- planned | in_progress | done
    eventDate TEXT,
    note TEXT,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    createdById INTEGER,
    updatedAt TEXT,
    updatedById INTEGER,
    deletedAt TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  -- Danh mục hoá chất/vật tư dự toán (Bước 9). Trước khi cap_vien_submissions.step9_supply_locked_at
  -- được set, Chủ nhiệm/Admin còn sửa/xóa tự do; sau khi khoá, approvedQty là số liệu chính thức để
  -- đối sánh với các đợt cấp phát (cap_vien_step9_supply_issuance).
  CREATE TABLE IF NOT EXISTS cap_vien_step9_supply_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    name TEXT NOT NULL,
    unit TEXT,
    approvedQty REAL NOT NULL DEFAULT 0,
    approvedAmount REAL,
    note TEXT,
    createdAt TEXT NOT NULL,
    createdById INTEGER,
    updatedAt TEXT,
    updatedById INTEGER,
    deletedAt TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  -- Đợt cấp phát cho từng item — 'requested' do Chủ nhiệm/Admin đề nghị, chỉ Admin/Phòng KHCN/Thư ký
  -- mới chuyển sang 'confirmed' (trừ vào approvedQty) hoặc 'rejected'.
  CREATE TABLE IF NOT EXISTS cap_vien_step9_supply_issuance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    itemId INTEGER NOT NULL,
    submissionId INTEGER NOT NULL,
    qty REAL NOT NULL,
    issuedDate TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'requested', -- requested | confirmed | rejected
    requestedById INTEGER,
    requestedAt TEXT NOT NULL,
    decidedById INTEGER,
    decidedAt TEXT,
    decisionNote TEXT,
    FOREIGN KEY (itemId) REFERENCES cap_vien_step9_supply_item(id),
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
  -- Bước 11: đề xuất điều chỉnh (nhân sự/kế hoạch/dự toán/gia hạn) — quy trình 2 cấp:
  -- Chủ nhiệm nộp -> Phòng KHCN xem xét (yêu cầu bổ sung/trình lên/từ chối thẳng) -> Viện trưởng duyệt/không duyệt.
  CREATE TABLE IF NOT EXISTS cap_vien_step11_adjustment_request (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submissionId INTEGER NOT NULL,
    type TEXT NOT NULL, -- nhan_su | ke_hoach | du_toan | gia_han | khac
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', -- submitted | khcn_need_revision | khcn_forwarded | approved | rejected
    requestedById INTEGER,
    requestedAt TEXT NOT NULL,
    khcnNote TEXT,
    khcnDecidedById INTEGER,
    khcnDecidedAt TEXT,
    directorNote TEXT,
    directorDecidedById INTEGER,
    directorDecidedAt TEXT,
    FOREIGN KEY (submissionId) REFERENCES cap_vien_submissions(id)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_cv_prp_sub ON cap_vien_periodic_report_period(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_prp_due ON cap_vien_periodic_report_period(submissionId, dueAt);
  CREATE INDEX IF NOT EXISTS idx_cv_prpal_sub ON cap_vien_periodic_report_admin_log(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9m_sub ON cap_vien_step9_milestone(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9si_sub ON cap_vien_step9_supply_item(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9su_item ON cap_vien_step9_supply_issuance(itemId);
  CREATE INDEX IF NOT EXISTS idx_cv_s9su_sub ON cap_vien_step9_supply_issuance(submissionId);
  CREATE INDEX IF NOT EXISTS idx_cv_s11ar_sub ON cap_vien_step11_adjustment_request(submissionId);
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

db.exec(`
  CREATE TABLE IF NOT EXISTS ace_templates (
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
try {
  db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('chairman_email_controls', '{}');
} catch (e) { /* ignore */ }
try {
  db.prepare('INSERT OR IGNORE INTO cooperation_settings (key, value) VALUES (?, ?)').run('council_member_email_controls', '{}');
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
  // Ánh xạ đầy đủ 10 trạng thái thật của cap_vien_submissions (9-step) sang mã trạng thái nhiệm vụ
  // KHCN đã có sẵn nhãn tiếng Việt (MISSION_STATUS_SEARCH_LABELS / getStatusText trong quan-ly-de-tai-co-so.html).
  // Trước đây ASSIGNED và CONTRACTED bị thiếu trong map → rơi về default 'planning' («Lập kế hoạch»),
  // khiến hồ sơ đã ký hợp đồng (gần cuối quy trình) hiển thị như vừa mới nộp; REJECTED cũng bị gộp
  // nhầm vào 'planning' thay vì trạng thái từ chối riêng.
  const statusMap = {
    SUBMITTED: 'planning',              // Mới nộp hồ sơ
    NEED_REVISION: 'planning',          // Thư ký yêu cầu bổ sung hồ sơ
    VALIDATED: 'planning',              // Hồ sơ hợp lệ, chờ phân công phản biện
    // Dùng 'cho_vien_xet_chon' (không phải 'review') vì sidebar quan-ly-de-tai-co-so.html gộp
    // 'review' vào nhóm "Nghiệm thu" (nghiệm thu cuối) — trong khi 3 trạng thái này thực chất là
    // "đang chờ Hội đồng Viện xét/họp", đúng nghĩa nhóm "Chờ xét duyệt".
    ASSIGNED: 'cho_vien_xet_chon',      // Đã phân công phản biện — đang thẩm định
    REVIEWED: 'cho_vien_xet_chon',      // Phản biện xong, chờ họp Hội đồng KHCN
    IN_MEETING: 'cho_vien_xet_chon',    // Đang họp Hội đồng KHCN
    CONDITIONAL: 'da_phe_duyet',        // Hội đồng thông qua (có điều kiện), chờ cấp QĐ chính thức
    APPROVED: 'cho_ky_hop_dong',        // Đã có Quyết định phê duyệt, chờ ký hợp đồng
    CONTRACTED: 'dang_thuc_hien',       // Đã ký hợp đồng — đang triển khai thực hiện
    REJECTED: 'khong_duoc_phe_duyet',   // Bị từ chối / dừng quy trình
  };
  const progressMap = {
    planning: 10,
    cho_vien_xet_chon: 40,
    da_phe_duyet: 55,
    cho_ky_hop_dong: 70,
    dang_thuc_hien: 85,
    khong_duoc_phe_duyet: 0,
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
    const progress = progressMap[status] != null ? progressMap[status] : 10;
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
  { code: 'cap_vien', label: 'Quản lý đề tài cấp Viện', enabled: 1 },
  { code: 'ethics_ace', label: 'Hội đồng đạo đức trên động vật (SCI-ACE)', enabled: 1 },
  { code: 'personnel', label: 'Quản lý Nhân lực KHCN', enabled: 0 },
  { code: 'ip', label: 'Quản lý Tài sản Trí tuệ', enabled: 0 },
  { code: 'finance', label: 'Quản lý Tài chính KHCN', enabled: 0 },
  { code: 'publications', label: 'Quản lý Công bố Khoa học', enabled: 0 },
  { code: 'cooperation', label: 'Quản lý Hợp tác', enabled: 1 },
  { code: 'equipment_stims', label: 'Quản trị thiết bị', enabled: 1 },
  { code: 'sample_storage', label: 'Ngân hàng Tế bào & Kháng thể', enabled: 1 },
  { code: 'tech_transfer', label: 'Quản lý Chuyển giao Công nghệ', enabled: 0 },
  { code: 'facilities', label: 'CRD Lab Booking', enabled: 1 },
  { code: 'ethics_integrity', label: 'Đạo đức và Liêm chính khoa học', enabled: 0 },
  { code: 'reward', label: 'Quản lý Khen thưởng & Đánh giá', enabled: 0 },
  { code: 'dms', label: 'Quản lý tài liệu & hồ sơ (Hành chính)', enabled: 1 },
  { code: 'document_workflow', label: 'Quy trình văn bản nội bộ', enabled: 1 },
  { code: 'department_reports', label: 'Báo cáo phòng ban', enabled: 1 },
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

/** Nối mã document_workflow vào JSON thứ tự cũ (13 mã) để kéo thả admin không lỗi */
(function migrateHomepageModuleOrderAddDocumentWorkflow() {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
    if (!row || row.value == null || String(row.value).trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch (e) {
      return;
    }
    if (!Array.isArray(parsed) || parsed.includes('document_workflow')) return;
    if (parsed.length !== HOMEPAGE_MODULES_DEFAULT.length - 1) return;
    const idx = parsed.indexOf('dms');
    if (idx >= 0) parsed.splice(idx + 1, 0, 'document_workflow');
    else parsed.push('document_workflow');
    if (parsed.length === HOMEPAGE_MODULES_DEFAULT.length) {
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run(
        'homepage_module_order',
        JSON.stringify(parsed)
      );
    }
  } catch (e) {
    console.warn('[DB] migrateHomepageModuleOrderAddDocumentWorkflow:', e.message || e);
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
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_code TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_at TEXT').run();
} catch (e) {
  /* đã có */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_by_id INTEGER REFERENCES users(id)').run();
} catch (e) {
  /* đã có */
}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_dms_documents_digitized_code ON dms_documents(digitized_code) WHERE digitized_code IS NOT NULL`
);
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

const vaiTroHanChe = require('./services/vaiTroHanChe');

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
  if (roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky', 'chu_tich', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'])) {
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

// Đăng ký (chỉ @sci.edu.vn) có XÁC MINH email: gửi liên kết dùng một lần, mật khẩu đặt SAU khi xác minh. Xem routes/dangKy.js
app.use(
  '/api/register',
  require('./routes/dangKy')({
    db,
    mailSend: transporter ? (o) => transporter.sendMail({ from: getSmtpFrom(), ...o }) : null,
    baseUrl: process.env.BASE_URL || 'http://localhost:' + PORT,
    bcrypt,
    jwt,
    JWT_SECRET,
    setAuthCookie,
    userEmailIsMasterAdmin,
    isSafeEmailFormat,
    allowedDomain: ALLOWED_EMAIL_DOMAIN, emailDuocPhep: (em) => require('./services/nganHangTeBaoKhangTheSinhVien').emailDuocDangKy(db, em),
  })
);

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

// Đăng ký công khai cho module CRD (1 endpoint) đã tách sang routes/crd/dangKyCongKhai.js.
// Mount ĐÚNG TẠI VỊ TRÍ CŨ.
app.use('/api', require('./routes/crd/dangKyCongKhai')({
  ALLOWED_EMAIL_DOMAIN,
  CRD_ONLY_USER_ROLE,
  bcrypt,
  db,
  jwt,
  JWT_SECRET,
  setAuthCookie, emailSinhVienDangCho: (em) => require('./services/nganHangTeBaoKhangTheSinhVien').emailDuocDangKy(db, em),
}));

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

// Hồ sơ SCI-ACE — nhóm cơ bản (4 endpoint: nộp, danh sách, danh sách Hội đồng, chi tiết) đã tách sang routes/submissions/hoSoCoBan.js.
app.use('/api', require('./routes/submissions/hoSoCoBan')({
  db,
  authMiddleware,
  upload,
  uploadDir,
  sanitizeFolderName,
  fixFilenameEncoding,
  sendNotificationToCouncil,
  roleIsAny,
  usersWithAnyRole,
  ROLE_LABELS,
}));

// Hồ sơ SCI-ACE — GĐ6 & GĐ7 (7 endpoint: có điều kiện, họp, cấp QĐ, báo cáo) đã tách sang routes/submissions/nghiemThuVaQuyetDinh.js.
app.use('/api', require('./routes/submissions/nghiemThuVaQuyetDinh')({
  db,
  authMiddleware,
  upload,
  uploadDir,
  fixFilenameEncoding,
  insertGd5History,
  sendConditionalSubmitEmail,
  roleIsAny,
  sendConditionalRejectEmail,
  sendMeetingResultEmail,
  PORT,
  sendDecisionIssuedEmail,
}));

// Hồ sơ SCI-ACE — tải file, GĐ3/GĐ4/GĐ5, download & xóa (10 endpoint) đã tách sang routes/submissions/kiemTraPhanBien.js.
app.use('/api', require('./routes/submissions/kiemTraPhanBien')({
  db,
  authMiddleware,
  adminOnly,
  upload,
  uploadDir,
  roleIsAny,
  usersWithAnyRole,
  safeDownload,
  prepareDownloadFileList,
  resolveGdSubmissionDirForRmSync,
  fixFilenameEncoding,
  insertGd5History,
  sendStage3ResultEmail,
  sendResubmitEmail,
  sendStage4AssignmentEmail,
}));

// ========== API Đề tài cấp Viện (Nhiệm vụ KHCN cấp cơ sở) — DB và upload riêng ==========
// Nhóm nộp hồ sơ mới, danh mục công khai & mẫu hồ sơ công khai (10 endpoint) đã tách sang routes/cap-vien/nopHoSoVaDanhMuc.js.
app.use('/api', require('./routes/cap-vien/nopHoSoVaDanhMuc')({
  db,
  authMiddleware,
  adminOnly,
  uploadCapVien,
  uploadCapVienPublicTemplate,
  uploadDirCapVien,
  sanitizeFolderName,
  fixFilenameEncoding,
  insertCapVienHistory,
  sendCapVienNewSubmissionEmail,
  CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
  isAllowedTaskCode,
  resolveStoredFileFromDb,
  capVienPublicTemplatesFsDir,
  pathIsStrictlyInsideResolvedRoot,
  resolveCapVienPublicTemplateStoredFileForUnlink,
  appRootDir: __dirname,
}));

// Đợt 6.1: quản trị Đề tài cấp Viện & đồng bộ nhiệm vụ KHCN
app.use('/api', require('./routes/admin/capVien')({
  db,
  authMiddleware,
  adminOnly,
  syncMissionsFromCapVien,
  getCapVienStep7EmailOnComplete,
  getChairmanEmailControls,
  CHAIRMAN_EMAIL_CONTROL_KEY,
  CHAIRMAN_EMAIL_CONTROL_DEFAULTS,
  getCouncilMemberEmailControls,
  COUNCIL_MEMBER_EMAIL_CONTROL_KEY,
  COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS,
}));

/** Xem mọi hồ sơ cấp Viện (danh sách + chi tiết + tải): Admin, Viện trưởng, P.KHCN, Hội đồng (kể cả
 * role được cấp qua council_role_grants). Chủ nhiệm chỉ hồ sơ của mình. */
function capVienRoleSeesAllSubmissions(req) {
  return roleIsAny(req, ['admin', 'vien_truong', 'phong_khcn', 'chu_tich', 'thu_ky', 'thanh_vien']);
}

// Đề tài cấp Viện — danh sách & chi tiết hồ sơ (2 endpoint) đã tách sang routes/cap-vien/danhSachVaChiTiet.js.
app.use('/api', require('./routes/cap-vien/danhSachVaChiTiet')({
  db,
  authMiddleware,
  capVienRoleSeesAllSubmissions,
  computeCapVienStepActualStats,
  getCapVienPeriodicReportBundle,
}));

function capVienStep6CanEdit(req) {
  return roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky']);
}

function capVienStep6HistoryRoleDb(roleRaw) {
  const r = (roleRaw || '').toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'thu_ky') return 'thu_ky';
  return 'phong_khcn';
}

// Đề tài cấp Viện — Bước 6, 7, 8 (6 endpoint: quyết định, hợp đồng, đạo đức) đã tách sang routes/cap-vien/quyetDinhHopDongDaoDuc.js.
app.use('/api', require('./routes/cap-vien/quyetDinhHopDongDaoDuc')({
  db,
  authMiddleware,
  uploadCapVien,
  uploadDirCapVien,
  capVienStep6CanEdit,
  capVienStep6HistoryRoleDb,
  insertCapVienHistory,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
}));

// Đề tài cấp Viện — báo cáo định kỳ (2 endpoint: upload theo kỳ, công cụ admin) đã tách sang routes/cap-vien/baoCaoDinhKy.js.
app.use('/api', require('./routes/cap-vien/baoCaoDinhKy')({
  db,
  authMiddleware,
  uploadCapVien,
  uploadDirCapVien,
  userHasAnyRole,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
  insertCapVienHistory,
  capVienPeriodicFlatFromStepHistory,
  insertCapVienPeriodicAdminLog,
  capVienResolvePeriodicAnchor,
  capVienBuildPeriodicSchedule,
}));

// Đề tài cấp Viện — đặt/xóa deadline theo bước (1 endpoint) đã tách sang routes/cap-vien/deadline.js.
app.use('/api', require('./routes/cap-vien/deadline')({ db, authMiddleware }));

// Đề tài cấp Viện — Bước 5 (họp HĐ, biên bản, chỉnh sửa, thông qua) & danh sách Hội đồng (8 endpoint) đã tách sang routes/cap-vien/hoiDongBuoc5.js.
app.use('/api', require('./routes/cap-vien/hoiDongBuoc5')({
  db,
  authMiddleware,
  roleIsAny,
  roleIs,
  uploadCapVien,
  uploadDirCapVien,
  insertCapVienHistory,
  sendCapVienStep5SecretaryActivityEmail,
  sendCapVienStep5SecretaryRevisionRequestEmail,
  sendCapVienStep5RevisionUploadedEmail,
  sendCapVienStep5ChairApprovedRevisionEmail,
  sendCapVienStep5ChairRequestMoreEmail,
  sendCapVienStep5CouncilPassedEmail,
  capVienEmailEsc,
  getNotificationEmails,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
  usersWithAnyRole,
}));



// Đề tài cấp Viện — bộ điều phối các bước quy trình (Bước 2, 3, 6, 7, 8, 8a, 9) đã tách sang routes/cap-vien/cacBuocQuyTrinh.js.
app.use('/api', require('./routes/cap-vien/cacBuocQuyTrinh')({
  db,
  authMiddleware,
  roleIsAny,
  insertCapVienStep2History,
  sendCapVienStep2ValidatedEmail,
  sendCapVienStep2RevisionEmail,
  usersWithAnyRole,
  insertCapVienHistory,
  sendCapVienStep3AssignEmail,
  sendCapVienStep4aNotifyBudgetTeamEmail,
  capVienStep6CanEdit,
  capVienStep6HistoryRoleDb,
  sendCapVienStep6CompletedEmail,
  getNotificationEmails,
  getPhongKhcnEmails,
  getCapVienStep7EmailOnComplete,
  sendCapVienStep7CompletedEmail,
}));

// Đề tài cấp Viện — Bước 9 (vật tư/hoá chất) & Bước 11 (đề xuất điều chỉnh) đã tách sang routes/cap-vien/vatTuVaDieuChinh.js.
app.use('/api', require('./routes/cap-vien/vatTuVaDieuChinh')({
  db,
  authMiddleware,
  roleIsAny,
  capVienStep6HistoryRoleDb,
  insertCapVienHistory,
}));

// Bước 4: Phản biện upload phiếu đánh giá (slot 1 hoặc 2) - upload KHONG tu dong "hoan thanh"
app.use('/api', require('./routes/cap-vien/phanBienVaDuToan')({
  db,
  authMiddleware,
  adminOnly,
  uploadCapVien,
  uploadDirCapVien,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
  insertCapVienHistory,
  sendCapVienStep5ReadyEmail,
  roleIsAny,
  getNotificationEmails,
  sendCapVienBudgetRevisionRequestEmail,
  sendCapVienBudgetRevisedSubmittedEmail,
  sendCapVienBudgetApprovedEmail,
  sendCapVienStep3AssignEmail,
  sendCapVienStep4aNotifyBudgetTeamEmail,
}));



// Đề tài cấp Viện — revert, dev-reset, nộp lại/bổ sung, tải file & xóa (8 endpoint) đã tách sang routes/cap-vien/boSungTaiVaXoa.js.
app.use('/api', require('./routes/cap-vien/boSungTaiVaXoa')({
  db,
  authMiddleware,
  adminOnly,
  uploadCapVien,
  uploadDirCapVien,
  insertCapVienStep2History,
  safeUnlinkCapVienStoredFile,
  sanitizeFolderName,
  fixFilenameEncoding,
  sendCapVienSupplementSubmittedEmail,
  capVienRoleSeesAllSubmissions,
  prepareDownloadFileList,
  safeDownload,
  deleteCapVienSubmissionCascade,
}));

// Đợt 6.2a: quản trị tài khoản & nhật ký hoạt động
app.use('/api', require('./routes/admin/usersVaNhatKy')({
  db,
  authMiddleware,
  adminOnly,
  userHasLoginPassword,
  userEmailIsMasterAdmin,
  reqIsMasterAdmin,
  isSafeEmailFormat,
  ALLOWED_EMAIL_DOMAIN,
  BUDGET_TEAM_ROLES,
  ROLE_LABELS,
  sendRoleAssignmentEmail,
  transporter,
}));

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
  const capVienMod = require('./modules/de-tai-cap-vien/eofficeMount');
  /** Thẻ module «Nhiệm vụ KHCN» — cùng quy tắc với /api/missions/stats (bao gồm đề tài cấp Viện từ module riêng) */
  let missions = 0;
  const missionMini = { inProgress: 0, completed: 0, overdue: 0 };
  try {
    const mRows = capVienMod.mergeCapVienModuleMissions(db.prepare('SELECT code, status, end_date FROM missions').all());
    missions = mRows.length;
    const now = new Date().toISOString().slice(0, 10);
    for (const m of mRows || []) {
      const st = (m.status || 'planning').toLowerCase();
      const isCompleted = st === 'completed' || st === 'hoan_thanh' || st === 'thanh_ly_hop_dong';
      const isCancelled = st === 'khong_duoc_phe_duyet' || st === 'dung_khong_dat_dot';
      const ed = m.end_date ? String(m.end_date).slice(0, 10) : '';
      const isPastEnd = ed && ed < now;
      if (isCompleted) missionMini.completed += 1;
      else if (isCancelled) { /* không tính quá hạn / đang thực hiện */ }
      else if (isPastEnd) missionMini.overdue += 1;
      else missionMini.inProgress += 1;
    }
  } catch (e) {
    missions = dbCount('SELECT COUNT(*) as c FROM missions');
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
   * Tài sản trí tuệ: số thực từ công bố loại "Bằng sáng chế / GPHI" (publications.pub_type = 'patent'),
   * cùng nguồn dữ liệu với module Công bố khoa học — chỉ khi module «ip» được bật; tắt → null (không hiển thị 0).
   */
  let ip = null;
  try {
    const hmIp = db
      .prepare('SELECT COALESCE(enabled, 0) AS en FROM homepage_modules WHERE code = ?')
      .get('ip');
    if (hmIp && Number(hmIp.en) === 1) {
      ip = dbCount(
        "SELECT COUNT(*) as c FROM publications WHERE COALESCE(status, '') != 'retracted' AND pub_type = 'patent'"
      );
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
  let documentWorkflowMini = { inProgress: 0, completed: 0, overdue: 0 };
  try {
    documentWorkflowMini.inProgress = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM documents
         WHERE deleted_at IS NULL
           AND status IN ('pending','in_progress')
           AND current_step BETWEEN 1 AND 8`
      )
      .get().c;
    documentWorkflowMini.completed = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM documents
         WHERE deleted_at IS NULL
           AND (status = 'archived' OR current_step >= 9)`
      )
      .get().c;
    documentWorkflowMini.overdue = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM documents
         WHERE deleted_at IS NULL
           AND assignment_deadline IS NOT NULL
           AND assignment_deadline < date('now')
           AND current_step BETWEEN 2 AND 7
           AND status IN ('pending', 'in_progress')`
      )
      .get().c;
  } catch (e) {
    /* bảng document workflow chưa có */
  }
  /** Thẻ module «Hội đồng đạo đức trên động vật» — đồng bộ trạng thái với /api/submissions (SCI-ACE) */
  let aceMini = { total: 0, inReview: 0, approved: 0 };
  try {
    aceMini.total = dbCount('SELECT COUNT(*) as c FROM submissions');
    aceMini.inReview = dbCount(
      "SELECT COUNT(*) as c FROM submissions WHERE COALESCE(status, 'SUBMITTED') IN ('SUBMITTED','VALIDATED','NEED_REVISION','UNDER_REVIEW','IN_MEETING','CONDITIONAL')"
    );
    aceMini.approved = dbCount(
      "SELECT COUNT(*) as c FROM submissions WHERE status IN ('APPROVED','IMPLEMENTATION','COMPLETED')"
    );
  } catch (e) {
    /* bảng submissions (SCI-ACE) chưa có */
  }
  const sampleStorageMini = require('./routes/nganHangTeBaoKhangThe').miniStats(db);
  const capVienMini = require('./modules/de-tai-cap-vien/eofficeMount').miniStats();
  return res.json({
    missions, missionMini, capVienMini, personnel, ip,
    publications, publicationMini, cooperation, cooperationMini,
    facilities, dmsMini, equipmentMini, sampleStorageMini, documentWorkflowMini, aceMini,
  });
});

// ========== Nhiệm vụ KHCN (Dashboard): trích xuất thống kê + danh sách tìm kiếm ==========
syncMissionsFromCapVien();

// Nhóm lõi (thống kê, danh sách, đăng ký mới) đã tách sang routes/missions/core.js.
// Mount ĐÚNG TẠI VỊ TRÍ CŨ: phải trước '/api/missions/:id' bên dưới, vì handler đó
// trả 400 «ID không hợp lệ» và không gọi next() — '/missions/stats' đăng ký sau nó
// sẽ chết im lặng.
app.use('/api', require('./routes/missions/core')({
  db,
  authMiddleware,
  transporter,
  PORT,
  syncMissionsFromCapVien,
  getSmtpFrom,
  getNotificationEmails,
}));

// Hồ sơ đăng ký + duyệt Bước 2–3 đã tách sang routes/missions/hoSo.js.
// Mount ĐÚNG TẠI VỊ TRÍ CŨ: vẫn phải trước '/api/missions/:id' bên dưới.
app.use('/api', require('./routes/missions/hoSo')({
  db,
  authMiddleware,
  thuyKyOrAdmin,
  chuTichOrAdmin,
  adminOrPhongKhcn,
  transporter,
  PORT,
  canUserAccessMissionHoSoNgoai,
  computeNhanhFromLevel,
  getChairmanEmail,
  getNotificationEmails,
  getSmtpFrom,
  isChairmanEmailEnabled,
  normalizeAndCheckDownloadPath,
}));

// Duyệt Bước 4a/4b/5/6 đã tách sang routes/missions/pheDuyet.js.
// Mount ĐÚNG TẠI VỊ TRÍ CŨ: vẫn phải trước '/api/missions/:id' bên dưới.
app.use('/api', require('./routes/missions/pheDuyet')({
  db,
  authMiddleware,
  thuyKyOrAdmin,
  transporter,
  upload,
  PORT,
  roleIsAny,
  getNotificationEmails,
  getSmtpFrom,
}));

// Danh sách chờ CT HĐ xét duyệt đã tách sang routes/missions/choXetDuyet.js.
// Mount ĐÚNG TẠI VỊ TRÍ CŨ — phải trước missionsExport và missionsChiTiet bên dưới.
app.use('/api', require('./routes/missions/choXetDuyet')({
  db,
  authMiddleware,
  roleIsAny,
}));

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
  if (level != null && ['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'].includes(level)) { updates.push('level = ?'); params.push(level); }
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

// Xuất dữ liệu nhiệm vụ (CSV / Excel / báo cáo thống kê) — xem routes/missions/export.js.
// Phải mount TRƯỚC handler '/api/missions/:id' bên dưới, nếu không 'export',
// 'export-excel', 'report-excel'… sẽ bị bắt nhầm thành :id.
app.use('/api', require('./routes/missions/export')({
  db,
  authMiddleware,
  adminOnly,
  csvEscape,
  syncMissionsFromCapVien,
  insertUserActivityLog,
}));

// Chi tiết đề tài + hồ sơ ngoài Viện + file sản phẩm đã tách sang
// routes/missions/chiTiet.js. Router này chứa '/missions/:id' nên BẮT BUỘC mount
// SAU missionsCore, missionsChoXetDuyet và missionsExport ở trên — nếu không,
// '/api/missions/export', '/stats', '/cho-ct-hd-*' sẽ bị :id nuốt thành 400.
app.use('/api', require('./routes/missions/chiTiet')({
  db,
  authMiddleware,
  upload,
  uploadDir,
  syncMissionsFromCapVien,
  canUserAccessMissionDetail,
  canUserAccessMissionHoSoNgoai,
  normalizeAndCheckDownloadPath,
}));

// Mẫu hồ sơ đăng ký đề tài ngoài Viện — Admin upload, User download
const TEMPLATE_TYPES = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong'];
const TEMPLATE_LABELS = { thuyet_minh_chi_tiet: 'Mẫu Thuyết minh chi tiết', van_ban_xin_phep_vien_truong: 'Mẫu Văn bản xin phép Viện trưởng' };

// Mẫu hồ sơ đăng ký đề tài ngoài Viện — xem routes/missions/templates.js.
app.use('/api', require('./routes/missions/templates')({
  db,
  authMiddleware,
  adminOnly,
  upload,
  uploadDir,
  templateTypes: TEMPLATE_TYPES,
  templateLabels: TEMPLATE_LABELS,
  pathIsStrictlyInsideResolvedRoot,
}));

// Mẫu hồ sơ SCI-ACE (Hội đồng đạo đức trên động vật) — Admin/Thư ký Hội đồng upload, mọi người đăng nhập được download
const ACE_TEMPLATE_DEFS = [
  { type: 'nhom1_muc_luc', group: 1, label: 'Mục lục Hệ thống' },
  { type: 'nhom1_huong_dan_tong_hop', group: 1, label: 'Hướng dẫn Tổng hợp' },
  { type: 'nhom1_huong_dan_thao_tac', group: 1, label: 'Hướng dẫn Thao tác Động vật' },
  { type: 'nhom1_quy_che', group: 1, label: 'Quy chế Hội đồng' },
  { type: 'sci_ace_01', group: 2, label: 'SCI-ACE-01: Đơn đề nghị xét duyệt' },
  { type: 'sci_ace_02', group: 2, label: 'SCI-ACE-02: Phiếu thuyết minh đề tài' },
  { type: 'sci_ace_03', group: 2, label: 'SCI-ACE-03: Báo cáo tuân thủ nguyên tắc 3R' },
  { type: 'sci_ace_04', group: 2, label: 'SCI-ACE-04: Báo cáo giải trình tiếp thu' },
  { type: 'sci_ace_06', group: 2, label: 'SCI-ACE-06: Báo cáo thay đổi kế hoạch' },
  { type: 'sci_ace_07', group: 2, label: 'SCI-ACE-07: Báo cáo kết quả tuân thủ' },
  { type: 'sci_ace_pdg', group: 3, label: 'SCI-ACE-PĐG: Phiếu nhận xét thành viên Hội đồng' },
  { type: 'sci_ace_05', group: 3, label: 'SCI-ACE-05: Biên bản họp Hội đồng' },
  { type: 'sci_ace_qd_vn', group: 3, label: 'Quyết định phê duyệt (Tiếng Việt)' },
  { type: 'sci_ace_qd_en', group: 3, label: 'Decision (English)' },
];
const ACE_TEMPLATE_TYPES = ACE_TEMPLATE_DEFS.map((d) => d.type);
const ACE_TEMPLATE_BY_TYPE = {};
ACE_TEMPLATE_DEFS.forEach((d) => { ACE_TEMPLATE_BY_TYPE[d.type] = d; });

/** Admin hoặc Thư ký Hội đồng (KHCN/SCI-ACE dùng chung role) mới được cập nhật mẫu hồ sơ SCI-ACE. */
function aceCanManageTemplates(req) {
  return roleIsAny(req, ['admin', 'thu_ky']);
}

app.get('/api/ace-templates', (req, res) => {
  const rows = db.prepare('SELECT template_type, original_name, updated_at FROM ace_templates').all();
  const byType = {};
  rows.forEach((r) => { byType[r.template_type] = r; });
  const templates = ACE_TEMPLATE_DEFS.map((d) => ({
    type: d.type,
    group: d.group,
    label: d.label,
    original_name: byType[d.type] ? byType[d.type].original_name : null,
    updated_at: byType[d.type] ? byType[d.type].updated_at : null,
    has_file: !!byType[d.type],
  }));
  return res.json({ templates });
});

app.get('/api/ace-templates/can-manage', authMiddleware, (req, res) => {
  return res.json({ canManage: aceCanManageTemplates(req) });
});

app.get('/api/ace-templates/:type/download', authMiddleware, (req, res) => {
  const type = (req.params.type || '').trim();
  if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loại mẫu không hợp lệ' });
  const row = db.prepare('SELECT template_type, original_name, path FROM ace_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'Chưa có mẫu này' });
  const templatesRoot = path.resolve(uploadDir, 'ace-templates');
  const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
  if (!pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath)) {
    return res.status(403).json({ message: 'Đường dẫn file mẫu không hợp lệ' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
  setContentDisposition(res, row.original_name || 'download');
  return res.sendFile(fullPath);
});

app.post(
  '/api/admin/ace-templates',
  authMiddleware,
  (req, res, next) => {
    if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'Chỉ Admin hoặc Thư ký Hội đồng mới được cập nhật mẫu.' });
    next();
  },
  upload.single('file'),
  (req, res) => {
    const type = (req.body.template_type || '').trim();
    if (!ACE_TEMPLATE_TYPES.includes(type)) {
      try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'template_type không hợp lệ' });
    }
    if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!['pdf', 'doc', 'docx'].includes(ext)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'Chỉ chấp nhận PDF, Word (.doc, .docx)' });
    }
    const destDir = path.join(uploadDir, 'ace-templates');
    fs.mkdirSync(destDir, { recursive: true });
    const finalName = type + '_' + Date.now() + '.' + ext;
    const destPath = path.join(destDir, finalName);
    fs.copyFileSync(req.file.path, destPath);
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    db.prepare("INSERT OR REPLACE INTO ace_templates (template_type, original_name, path, updated_at) VALUES (?, ?, ?, datetime('now'))").run(type, req.file.originalname || finalName, finalName);
    const row = db.prepare('SELECT template_type, original_name, updated_at FROM ace_templates WHERE template_type = ?').get(type);
    return res.status(201).json({ message: 'Đã cập nhật mẫu ' + (ACE_TEMPLATE_BY_TYPE[type] ? ACE_TEMPLATE_BY_TYPE[type].label : type), template: row });
  }
);

app.delete('/api/admin/ace-templates/:type', authMiddleware, (req, res) => {
  if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'Chỉ Admin hoặc Thư ký Hội đồng mới được xóa mẫu.' });
  const type = (req.params.type || '').trim();
  if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loại mẫu không hợp lệ' });
  const row = db.prepare('SELECT path FROM ace_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'Không có file để xóa' });
  try {
    const templatesRoot = path.resolve(uploadDir, 'ace-templates');
    const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
    if (pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath) && fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
    db.prepare('DELETE FROM ace_templates WHERE template_type = ?').run(type);
    return res.json({ ok: true, message: 'Đã xóa mẫu' });
  } catch (e) {
    console.error('[ace-templates delete]', e);
    return res.status(500).json({ message: 'Lỗi xóa' });
  }
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
  const levels = ['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'];
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
  if (!['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'].includes(level)) {
    return res.status(400).json({ message: 'Cấp đề tài không hợp lệ. Hãy chọn: national | ministry | university | school | coe | first | institute.' });
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
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email không hợp lệ.' });
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
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email không hợp lệ.' });
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
    return res.status(500).json({ message: 'Lỗi lưu cấu hình.' });
  }
});

app.post('/api/admin/cooperation/thoa-thuan/run-expiry-check', authMiddleware, adminOnly, (req, res) => {
  coopRunThoaThuanExpiryAlerts()
    .then((r) => res.json({ ok: true, ...r }))
    .catch((e) => res.status(500).json({ message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' }));
});

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
  if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'Chỉ Admin, Phòng KHCN hoặc Viện trưởng mới có quyền này' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'Chỉ Admin, Phòng KHCN hoặc Viện trưởng mới có quyền này' });
}

// Đợt 5.3–5.4: nộp MOU, quản lý đề xuất & thẩm định/duyệt legacy
app.use('/api', require('./routes/cooperation/quanLyDeXuat')({
  db,
  authMiddleware,
  roleIsAny,
  vienTruongOrAdmin,
  canSeeQuanLySection,
  getCooperationRecipientsSplit,
  coopAddHistory,
  coopGenMa,
  transporter,
  getSmtpFrom,
}));

app.use('/api', require('./routes/cooperation/thamDinhVaDuyetCu')({
  db,
  PORT,
  authMiddleware,
  coopPhongOrAdmin,
  vienTruongOrAdmin,
  coopAddHistory,
  coopGenMa,
  coopSendMail,
  coopSendMailTuChoi,
  coopBuildEmail,
  coopGetRecipients,
  STATUS_LABELS_COOP,
  coopTryAutoGenerateDoanVaoVanBan,
  coopTryAutoGenerateMouVanBan,
  coopTryAutoGenerateDoanRaVanBan,
}));

// ========== HTQT ĐỀ XUẤT YTNN (Chương VII Quy chế KHCN-ĐMST SCI 2026) — đã tách sang routes/htqt.js (Đợt 5.2) ==========
app.use('/api', require('./routes/htqt')({
  db,
  authMiddleware,
  adminOnly,
  roleIsAny,
  vienTruongOrAdmin,
  coopTryAutoGenerateYtnnVanBan,
}));

// Đợt 5.5: đề xuất của tôi, nộp & danh sách Đoàn ra / Đoàn vào / MOU
app.use('/api', require('./routes/cooperation/nopVaDanhSach')({
  db,
  PORT,
  authMiddleware,
  getCooperationRecipients,
  coopAddHistory,
  coopGenMa,
  coopGetRecipients,
  coopEscHtml,
  coopBuildEmail,
  coopSendMail,
  transporter,
}));

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

// Đợt 5.6: tổng quan, đối tác & đọc/tải scan thỏa thuận
app.use('/api', require('./routes/cooperation/tongQuanVaThoaThuan')({
  db,
  authMiddleware,
  cooperationComputePartnerStats,
  normalizeAndCheckDownloadPath,
}));

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

// Đợt 5.7: thêm, chấm dứt & cập nhật scan thỏa thuận
app.use('/api', require('./routes/cooperation/thoaThuanCapNhat')({
  db,
  authMiddleware,
  coopPhongOrAdmin,
  uploadHtqtThoaThuanScan,
  uploadHtqtThoaThuanTermination,
  thoaThuanParseOpenEndedFlag,
  thoaThuanAutoStatusByExpiry,
  thoaThuanHetHanFromSigningYears,
}));

// Đợt 6.2b: quản trị phân quyền, Hội đồng KHCN, Tổ thẩm định TC & mật khẩu/trạng thái tài khoản
app.use('/api', require('./routes/admin/phanQuyenVaTaiKhoan')({
  db,
  authMiddleware,
  adminOnly,
  masterAdminOnly,
  reqIsMasterAdmin,
  userEmailIsMasterAdmin,
  ALLOWED_EMAIL_DOMAIN,
  BUDGET_TEAM_ROLES,
  COUNCIL_ROLE_TOKENS,
}));

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

// Đặt lịch CRD — phần người dùng thường (9 endpoint) đã tách sang routes/crd/nguoiDung.js.
// Mount ĐÚNG TẠI VỊ TRÍ CŨ.
app.use('/api', require('./routes/crd/nguoiDung')({
  authMiddleware,
  crdEnsurePersonForAppUser,
  crdPersonBlockedForUse,
  crdGetStateForUser,
  crdIsHalfHourMark,
  db,
  crdBookingOverlaps,
  crypto,
  crdBookingToClient,
  CRD_BROADCAST_TO_ID,
  crdBroadcastRateMap,
  CRD_BROADCAST_RATE_MS,
  CRD_BROADCAST_RATE_BURST,
  crdSendBroadcastEmailNotification,
  crdChatToClient,
}));

// Đặt lịch CRD — quản trị snapshot, thông báo phòng lab, thiết bị (9 endpoint) đã tách sang
// routes/crd/quanTriThietBi.js. Mount ĐÚNG TẠI VỊ TRÍ CŨ: vẫn trước nhóm quản trị hồ sơ CRD bên dưới.
app.use('/api', require('./routes/crd/quanTriThietBi')({
  authMiddleware,
  adminOnly,
  crdGetStateForUser,
  db,
  crdLabAnnouncementsAll,
  crypto,
  crdAnnouncementToClient,
  crdLabAnnouncementsActive,
  crdMachineToClient,
}));

// Đặt lịch CRD — quản trị hồ sơ CRD, tài khoản, vai trò, lịch (12 endpoint) đã tách sang
// routes/crd/quanTriNguoiDung.js. Mount ĐÚNG TẠI VỊ TRÍ CŨ.
app.use('/api', require('./routes/crd/quanTriNguoiDung')({
  authMiddleware,
  adminOnly,
  crypto,
  crdRoleSlugValid,
  db,
  crdPersonToUser,
  bcrypt,
  crdRoleDefsToClient,
  crdIsHalfHourMark,
  crdBookingOverlaps,
  crdBookingToClient,
}));

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
    'ALTER TABLE equipments ADD COLUMN asset_group TEXT',
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
    'ALTER TABLE equipments ADD COLUMN deleted_at TEXT',
    'ALTER TABLE equipments ADD COLUMN deleted_by INTEGER REFERENCES users(id)',
  ];
  for (const sql of alters) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      /* đã có cột */
    }
  }
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS equipment_code_sequences (
        dept_code TEXT NOT NULL,
        year INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (dept_code, year)
      );
      CREATE TABLE IF NOT EXISTS equipment_loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
        borrower_id INTEGER REFERENCES users(id),
        borrower_name TEXT,
        purpose TEXT,
        borrowed_at TEXT DEFAULT (datetime('now')),
        expected_return_at TEXT,
        returned_at TEXT,
        return_note TEXT,
        created_by INTEGER REFERENCES users(id),
        returned_by INTEGER REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_equipment_loans_equipment ON equipment_loans(equipment_id);
      CREATE INDEX IF NOT EXISTS idx_equipment_loans_open ON equipment_loans(equipment_id, returned_at);
    `);
  } catch (e) {
    console.warn('[equipment extra tables]', e.message);
  }
})();

(function dropLegacyEquipmentReviewColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info(equipments)`).all();
    if (!cols || !cols.length) return;
    const names = new Set(cols.map((c) => String(c.name || '')));
    const legacyCols = ['review_status', 'published_at', 'review_rejection_note'];
    const hasLegacy = legacyCols.some((c) => names.has(c));
    if (!hasLegacy) return;

    const keepCols = [
      'id',
      'equipment_code',
      'name',
      'asset_group',
      'model',
      'serial_number',
      'manufacturer',
      'purchase_year',
      'purchase_value',
      'department_id',
      'manager_id',
      'location',
      'specs_json',
      'status',
      'profile_visibility',
      'created_by',
      'last_maintenance_date',
      'next_maintenance_date',
      'calibration_due_date',
      'asset_type_code',
      'year_in_use',
      'unit_name',
      'quantity_book',
      'quantity_actual',
      'quantity_diff',
      'remaining_value',
      'utilization_note',
      'condition_note',
      'disaster_impact_note',
      'construction_asset_note',
      'usage_count_note',
      'land_attached_note',
      'asset_note',
      'created_at',
      'updated_at',
    ].filter((c) => names.has(c));
    if (!keepCols.length) return;
    const keepSql = keepCols.join(', ');

    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE __equipments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        asset_group TEXT,
        model TEXT,
        serial_number TEXT,
        manufacturer TEXT,
        purchase_year INTEGER,
        purchase_value REAL,
        department_id TEXT,
        manager_id INTEGER REFERENCES users(id),
        location TEXT,
        specs_json TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','maintenance','broken','retired')),
        profile_visibility TEXT NOT NULL DEFAULT 'institute' CHECK(profile_visibility IN ('public','institute','internal')),
        created_by INTEGER REFERENCES users(id),
        last_maintenance_date TEXT,
        next_maintenance_date TEXT,
        calibration_due_date TEXT,
        asset_type_code TEXT,
        year_in_use INTEGER,
        unit_name TEXT,
        quantity_book REAL,
        quantity_actual REAL,
        quantity_diff REAL,
        remaining_value REAL,
        utilization_note TEXT,
        condition_note TEXT,
        disaster_impact_note TEXT,
        construction_asset_note TEXT,
        usage_count_note TEXT,
        land_attached_note TEXT,
        asset_note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`INSERT INTO __equipments_new (${keepSql}) SELECT ${keepSql} FROM equipments`);
    db.exec(`DROP TABLE equipments`);
    db.exec(`ALTER TABLE __equipments_new RENAME TO equipments`);
    db.exec('COMMIT');
    console.log('[EQUIP] dropped legacy review columns from equipments');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    console.warn('[EQUIP] drop legacy review columns:', e.message);
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
        return { ok: false, reason: 'smtp_error', error: 'smtp_error' };
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

/** Ngân hàng Tế bào & Kháng thể — routes/nganHangTeBaoKhangThe.js (bảng nhm_*, chuyển hướng địa chỉ cũ, API) */
try {
  require('./routes/nganHangTeBaoKhangThe').mount(app, { db, authMiddleware, insertUserActivityLog, baseUrl: process.env.BASE_URL || '', nhacTuDong: true, mailSend: (o) => (transporter ? transporter.sendMail({ from: getSmtpFrom(), ...o }) : Promise.reject(new Error('mail_not_configured'))) });
  console.log('[NGAN-HANG] Đã mount /api/ngan-hang-te-bao-khang-the');
} catch (e) {
  console.warn('[NGAN-HANG] Không mount ngan-hang-te-bao-khang-the:', e.message);
}

/** Quy trình ban hành văn bản hành chính nội bộ (9 bước) */
try {
  const createInternalDocumentsWorkflowRouter = require('./routes/internalDocumentsWorkflow');
  function documentWorkflowMailSend(opts) {
    if (!transporter || !opts) return Promise.resolve({ ok: false, reason: 'mail_not_configured' });
    const toList = Array.isArray(opts.to) ? opts.to.filter(Boolean) : opts.to ? [opts.to] : [];
    if (!toList.length) return Promise.resolve({ ok: false, reason: 'no_recipients' });
    return transporter
      .sendMail({
        from: getSmtpFrom(),
        to: toList.join(', '),
        subject: opts.subject || 'Thông báo quy trình văn bản',
        text: opts.text || '',
        html: opts.html || opts.text || '',
      })
      .then(() => ({ ok: true }))
      .catch((e) => {
        console.warn('[DOCFLOW mail]', e.message);
        return { ok: false, reason: 'smtp_error', error: 'smtp_error' };
      });
  }
  const internalWorkflowRouter = createInternalDocumentsWorkflowRouter({
    db,
    authMiddleware,
    uploadsRoot: appPaths.uploadsRoot(),
    mailSend: documentWorkflowMailSend,
    baseUrl: process.env.BASE_URL || '',
  });
  // Alias tương thích ngược cho bundle React cũ (trước khi đổi prefix /api/admin -> /api/docflow-admin).
  // Chỉ bắc cầu những path KHÔNG đụng với các handler /api/admin/* có sẵn của server.js (đặc biệt
  // KHÔNG đụng /api/admin/users — handler cũ trả schema khác, sẽ bị phá nếu alias).
  //
  // Middleware này rewrite req.url trước khi chạm internalWorkflowRouter, nên phải đứng TRƯỚC
  // `app.use('/api', internalWorkflowRouter)` bên dưới.
  const DOCFLOW_ADMIN_LEGACY_PREFIXES = [
    '/api/admin/module/',
    '/api/admin/module-permissions',
    '/api/admin/module-settings',
    '/api/admin/audit-logs',
    '/api/admin/dashboard',
    '/api/admin/units',
    '/api/admin/units/',
    '/api/admin/email-notifications',
    '/api/admin/document-types',
    '/api/admin/document-types/',
  ];
  let warnedDocflowStaleBundle = false;
  app.use((req, _res, next) => {
    try {
      const p = req.path || '';
      if (!DOCFLOW_ADMIN_LEGACY_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix))) {
        return next();
      }
      if (!warnedDocflowStaleBundle) {
        warnedDocflowStaleBundle = true;
        console.warn(
          '[DOCFLOW] Client gọi /api/admin/* (bundle React cũ) — đã alias sang /api/docflow-admin/*.\n' +
            '          Triển khai bundle mới: git pull + restart Node (server sẽ auto rebuild dist).'
        );
      }
      // /api/admin/<rest> -> /api/docflow-admin/<rest>
      req.url = req.url.replace(/^\/api\/admin(\/|$)/, '/api/docflow-admin$1');
    } catch (_) {
      /* noop */
    }
    return next();
  });

  app.use('/api', internalWorkflowRouter);
  console.log('[DOCFLOW] Đã mount /api/documents, /api/attachments, /api/units, /api/dashboard/stats, /api/docflow-admin/*');
  console.log('[DOCFLOW] Alias sẵn sàng cho bundle cũ: /api/admin/{module|module-*|dashboard|units|audit-logs|email-notifications|document-types} -> /api/docflow-admin/*');
} catch (e) {
  console.warn('[DOCFLOW] Không mount internal documents workflow:', e.message);
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
    return res.status(500).json({ ok: false, error: 'Lỗi' });
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
    return res.status(500).json({ ok: false, error: 'Lỗi' });
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
    return res.status(500).json({ ok: false, success: false, error: 'Lỗi' });
  }
});

// Đặt lịch CRD — kiểm duyệt tin, email-notif, khiếu nại admin (5 endpoint) đã tách sang
// routes/crd/kiemDuyetThongBao.js. Mount ĐÚNG TẠI VỊ TRÍ CŨ.
app.use('/api', require('./routes/crd/kiemDuyetThongBao')({
  authMiddleware,
  db,
  crdEnsurePersonForAppUser,
  CRD_BROADCAST_TO_ID,
  crdPersonHasModeratorSlot,
  adminOnly,
}));

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

function coopIsManager(req) {
  const role = (req.user && req.user.role || '').toLowerCase();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  return role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email);
}

function coopCanDownloadDoanRaVanBan(req, row) {
  if (!row || !row.van_ban_word_path) return false;
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin') return true;
  if (roleIsAny(req, ['phong_khcn'])) return true;
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
    const abs = resolveStoredFileFromDb(outRel);
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[doan_ra] auto Word:', e);
    return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
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
    const abs = resolveStoredFileFromDb(outRel);
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[doan_vao] auto Word:', e);
    return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
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
    const abs = resolveStoredFileFromDb(row.van_ban_word_path);
    if (!abs || !fs.existsSync(abs)) {
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
    const abs = resolveStoredFileFromDb(row.van_ban_word_path);
    if (!abs || !fs.existsSync(abs)) {
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
    const abs = resolveStoredFileFromDb(outRel);
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[mou] auto Word:', e);
    return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
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
    const abs = resolveStoredFileFromDb(row.van_ban_word_path);
    if (!abs || !fs.existsSync(abs)) {
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
    const abs = resolveStoredFileFromDb(outRel);
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
    fs.writeFileSync(abs, buf);
    db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(outRel, outName, nid);
    return { ok: true, outName };
  } catch (e) {
    console.error('[ytnn] auto Word:', e);
    return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
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
    const abs = resolveStoredFileFromDb(row.van_ban_word_path);
    if (!abs || !fs.existsSync(abs)) {
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
  if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) return next();
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
  if (role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email)) return next();
  return res.status(403).json({ message: 'Chỉ Quản trị viện, Phòng KHCN hoặc Viện trưởng mới xem được Dashboard.' });
}

// Đợt 5.8a: badge sidebar & thống kê dashboard
app.use('/api', require('./routes/cooperation/thongKeDashboard')({
  db,
  authMiddleware,
  roleIsAny,
  coopIsVienTruong,
  coopDashboardViewer,
  cooperationComputePartnerStats,
  coopDashMergeStatusBuckets,
  coopDashSeries12m,
}));

// HTQT dashboard (EJS) — /ytnn/dashboard, /ytnn/api/dashboard/*
try {
  const createYtnnRouter = require('./routes/ytnn');
  app.use('/ytnn', authMiddleware, createYtnnRouter({ db, coopDashboardViewer }));
} catch (e) {
  console.warn('[ytnn] Không mount router /ytnn:', e.message);
}
app.use('/api/bao-cao-phong', authMiddleware, require('./routes/baoCaoPhong')({ db, uploadsRoot: appPaths.uploadsRoot(), baseUrl: process.env.BASE_URL || '', nhacTuDong: true, mailSend: (o) => (transporter ? transporter.sendMail({ from: getSmtpFrom(), ...o }) : Promise.reject(new Error('mail_not_configured'))) })); // Báo cáo phòng ban: xem routes/baoCaoPhong.js
app.use('/api/mysign', authMiddleware, require('./routes/mysign')({ db, uploadsRoot: appPaths.uploadsRoot() })); // Ký số MySign dùng chung: xem services/mysign/

// Đợt 5.8b: danh sách chờ xử lý & chi tiết đề xuất
app.use('/api', require('./routes/cooperation/danhSachVaChiTiet')({
  db,
  authMiddleware,
  coopPhongOrAdmin,
  coopVTOrAdmin,
  coopIsManager,
  coopGenMa,
  coopBuildTitle,
  STATUS_LABELS_COOP,
  coopEnsureFreshDoanRaVanBan,
  coopEnsureFreshDoanVaoVanBan,
  coopEnsureFreshMouVanBan,
  coopEnsureFreshYtnnVanBan,
  DOAN_RA_TO_TRINH_TEMPLATE_PATH,
  DOAN_VAO_TO_TRINH_TEMPLATE_PATH,
  MOU_TO_TRINH_TEMPLATE_PATH,
  YTNN_TO_TRINH_TEMPLATE_PATH,
}));

// Đợt 5.9: văn bản Word & mẫu Tờ trình (Đoàn ra, Đoàn vào, MOU, YTNN)
app.use('/api', require('./routes/cooperation/vanBanWord')({
  db,
  uploadDir,
  authMiddleware,
  adminOnly,
  storedUploadsPathForDatabase,
  resolveStoredFileFromDb,
  pathIsStrictlyInsideResolvedRoot,
  uploadHtqtDoanRa,
  uploadToTrinhTemplate,
  DOAN_RA_TO_TRINH_TEMPLATE_PATH,
  coopUnlinkDoanRaVanBanFile,
  coopCanDownloadDoanRaVanBan,
  coopEnsureFreshDoanRaVanBan,
  coopTryAutoGenerateDoanRaVanBan,
  uploadHtqtDoanVao,
  uploadToTrinhTemplateDoanVao,
  DOAN_VAO_TO_TRINH_TEMPLATE_PATH,
  coopUnlinkDoanVaoVanBanFile,
  coopCanDownloadDoanVaoVanBan,
  coopEnsureFreshDoanVaoVanBan,
  coopTryAutoGenerateDoanVaoVanBan,
  uploadHtqtMou,
  uploadToTrinhTemplateMou,
  MOU_TO_TRINH_TEMPLATE_PATH,
  coopUnlinkMouVanBanFile,
  coopCanDownloadMouVanBan,
  coopEnsureFreshMouVanBan,
  coopTryAutoGenerateMouVanBan,
  uploadHtqtYtnn,
  uploadToTrinhTemplateYtnn,
  YTNN_TO_TRINH_TEMPLATE_PATH,
  coopUnlinkYtnnVanBanFile,
  coopCanDownloadYtnnVanBan,
  coopEnsureFreshYtnnVanBan,
  coopTryAutoGenerateYtnnVanBan,
}));

// Đợt 5.10: lịch sử, thẩm định & phê duyệt mới
app.use('/api', require('./routes/cooperation/pheDuyetMoi')({
  db,
  PORT,
  authMiddleware,
  coopPhongOrAdmin,
  coopVTOrAdmin,
  coopIsManager,
  coopAddHistory,
  coopGenMa,
  coopFmtDate,
  coopGetRecipients,
  coopEmailsPhongKhcnForTopic,
  coopEmailListMinus,
  coopBuildEmail,
  coopSendMail,
  coopSendMailTuChoi,
  STATUS_LABELS_COOP,
  coopTryAutoGenerateDoanRaVanBan,
  coopTryAutoGenerateDoanVaoVanBan,
  coopTryAutoGenerateMouVanBan,
  coopTryAutoGenerateYtnnVanBan,
}));

// Đợt 5.11: người nộp cập nhật / nộp lại / kết thúc & sự kiện hợp tác
app.use('/api', require('./routes/cooperation/nopLaiVaSuKien')({
  db,
  PORT,
  authMiddleware,
  coopPhongOrAdmin,
  coopAssertSubmitter,
  coopAddHistory,
  coopGenMa,
  coopEscHtml,
  coopBuildEmail,
  coopNotifyPhongToCcVt,
}));

app.delete('/api/admin/cooperation/su-kien/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM cooperation_su_kien WHERE id=?').run(parseInt(req.params.id,10));
    return res.json({ ok:true, message:'Đã xóa sự kiện.' });
  } catch(e) { return res.status(500).json({ message:'Lỗi: '+e.message }); }
});

// ============================================================
// ROUTE MỚI — EVENTS WORKFLOW (đã tách sang routes/events.js, Đợt 5.1)
// ============================================================
app.use('/api', require('./routes/events')({
  db,
  rootDir: __dirname,
  uploadDir,
  UPLOAD_FILE_BYTES_SUBMISSION,
  MULTIPART_MAX_FIELD_BYTES,
  authMiddleware,
  coopPhongOrAdmin,
  adminOnly,
  fixFilenameEncoding,
  resolveEventUploadFileForUnlink,
  toVietnameseCurrencyWords,
  buildEventPermissionDocBuffer,
  buildEventReportDocBuffer,
  setContentDisposition,
}));

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
// Tích hợp Sub-App Quản lý Đề tài Cấp Viện chuyên biệt tại /de-tai-cap-vien/
require('./modules/de-tai-cap-vien/eofficeMount').mount(app, { db, jwt, JWT_SECRET, getTokenFromReq, userIdIsBanned, clearAuthCookie, userEmailIsMasterAdmin });
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
  'xac-minh-email.html',
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
      // vai trò chỉ dùng một số module (crd_user, sinh_vien): chỉ mở các trang của module đó (services/vaiTroHanChe.js)
      if (!userIdIsBanned(payload0.id) && !vaiTroHanChe.trangHtmlDuocPhep(payload0.role, reqPath)) {
        return res.redirect(302, vaiTroHanChe.trangMacDinh(payload0.role));
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

/** Chart.js phục vụ nội bộ: CSP chỉ cho script-src 'self', nạp từ CDN sẽ bị chặn.
 *  Gói npm chỉ có dist/chart.umd.js (đã minify) — không có chart.umd.min.js như URL
 *  jsDelivr dùng trước đây (jsDelivr tự minify khi file .min.js không tồn tại). */
app.get('/public/vendor/chart.umd.js', (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  } catch (e) {
    return res.status(404).send('chart.js bundle not found');
  }
});

/** pdf.js phục vụ nội bộ (CSP chỉ cho script-src 'self'): chỉ hai tệp dùng để xem trước PDF khi đặt khung chữ ký số (public/js/kysoViTri.js). */
app.get('/public/vendor/pdfjs/:tep', (req, res) => (['pdf.min.mjs', 'pdf.worker.min.mjs'].includes(req.params.tep) ? res.type('application/javascript').sendFile(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build', req.params.tep)) : res.status(404).end()));

// Admin UI bridge:
// - If built bundle exists, serve React app at /admin
// - Otherwise fallback to legacy HTML workflow page from backend
const adminUiDistCandidates = [
  process.env.ADMIN_UI_DIST || '',
  path.join(__dirname, 'frontend', 'document-workflow-ui', 'dist'),
  path.join(__dirname, 'document-workflow-ui', 'dist'),
  path.join(__dirname, 'dist', 'document-workflow-ui'),
].filter(Boolean);
const adminUiAutoBuildDisabled =
  String(process.env.ADMIN_UI_AUTO_BUILD || '').toLowerCase() === '0' ||
  String(process.env.ADMIN_UI_AUTO_BUILD || '').toLowerCase() === 'false';
function tryAutoBuildAdminUi(triggerReason) {
  const frontendDir = path.join(__dirname, 'frontend', 'document-workflow-ui');
  const frontendPkg = path.join(frontendDir, 'package.json');
  if (adminUiAutoBuildDisabled) return { attempted: false, ok: false, reason: 'disabled-by-env' };
  if (!fs.existsSync(frontendPkg)) return { attempted: false, ok: false, reason: 'missing-frontend-package' };

  // Giới hạn tổng thời gian spawnSync để không chặn app.listen vô hạn nếu npm treo
  // (mạng chậm, lockfile hỏng, postinstall hook stuck). Quá giờ -> SIGTERM child, server
  // vẫn khởi động được với bundle cũ (nếu có) thay vì zombie không listen.
  const DEFAULT_AUTO_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
  const parsedTimeout = Number.parseInt(String(process.env.ADMIN_UI_AUTO_BUILD_TIMEOUT_MS || ''), 10);
  const perStepTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_AUTO_BUILD_TIMEOUT_MS;
  const fmtTimeout = `${Math.round(perStepTimeoutMs / 1000)}s`;

  console.log(
    `[ADMIN UI] ${triggerReason || 'dist missing'} -> attempting auto build (npm install + npm run build; timeout=${fmtTimeout}/step)`
  );

  function describeSpawnFailure(label, result) {
    if (result && result.signal) return `${label}: process bị kill bởi ${result.signal} (có thể do timeout=${fmtTimeout})`;
    if (result && result.error) return `${label}: ${result.error.code || ''} ${result.error.message || result.error}`.trim();
    return `${label}: exit code = ${result ? result.status : 'unknown'}`;
  }

  const installResult = spawnSync('npm', ['install'], {
    cwd: frontendDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: perStepTimeoutMs,
    killSignal: 'SIGTERM',
  });
  if (installResult.status !== 0) {
    console.error('[ADMIN UI] Auto-build failed at npm install -', describeSpawnFailure('npm install', installResult));
    return { attempted: true, ok: false, reason: installResult.signal ? 'install-timeout' : 'install-failed' };
  }
  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: frontendDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    timeout: perStepTimeoutMs,
    killSignal: 'SIGTERM',
  });
  if (buildResult.status !== 0) {
    console.error('[ADMIN UI] Auto-build failed at npm run build -', describeSpawnFailure('npm run build', buildResult));
    return { attempted: true, ok: false, reason: buildResult.signal ? 'build-timeout' : 'build-failed' };
  }
  console.log('[ADMIN UI] Auto-build succeeded');
  return { attempted: true, ok: true, reason: 'build-succeeded' };
}

/**
 * So sánh mtime của thư mục source React với dist/index.html để nhận biết khi
 * người vận hành đã `git pull` code mới nhưng chưa rebuild bundle. Nếu phát hiện
 * source mới hơn dist thì tự động rebuild khi khởi động (trừ khi tắt bằng env).
 */
function adminUiSourceNewerThanDist() {
  try {
    const srcDir = path.join(__dirname, 'frontend', 'document-workflow-ui', 'src');
    const indexHtmlInRepo = path.join(__dirname, 'frontend', 'document-workflow-ui', 'index.html');
    const packageJson = path.join(__dirname, 'frontend', 'document-workflow-ui', 'package.json');
    const existingDist = adminUiDistCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));
    if (!existingDist) return { newer: true, reason: 'dist-missing' };
    if (!fs.existsSync(srcDir)) return { newer: false, reason: 'src-missing' };
    const distMtime = fs.statSync(path.join(existingDist, 'index.html')).mtimeMs;
    let latestSourceMtime = 0;
    let latestSourceFile = '';
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else {
          const m = fs.statSync(full).mtimeMs;
          if (m > latestSourceMtime) {
            latestSourceMtime = m;
            latestSourceFile = full;
          }
        }
      }
    };
    walk(srcDir);
    for (const aux of [indexHtmlInRepo, packageJson]) {
      if (fs.existsSync(aux)) {
        const m = fs.statSync(aux).mtimeMs;
        if (m > latestSourceMtime) {
          latestSourceMtime = m;
          latestSourceFile = aux;
        }
      }
    }
    if (latestSourceMtime > distMtime + 1000) {
      return {
        newer: true,
        reason: `source newer than dist (source=${latestSourceFile} mtime=${new Date(latestSourceMtime).toISOString()}, dist=${new Date(distMtime).toISOString()})`,
      };
    }
    return { newer: false, reason: 'dist up-to-date' };
  } catch (e) {
    return { newer: false, reason: 'stat-failed: ' + (e && e.message) };
  }
}

let adminUiAutoBuildState = { attempted: false, ok: false, reason: 'not-needed' };
const adminUiDistPresent = adminUiDistCandidates.some((dir) => fs.existsSync(path.join(dir, 'index.html')));
if (!adminUiDistPresent) {
  adminUiAutoBuildState = tryAutoBuildAdminUi('dist missing');
} else {
  const staleCheck = adminUiSourceNewerThanDist();
  if (staleCheck.newer) {
    console.log('[ADMIN UI] Stale build detected: ' + staleCheck.reason);
    adminUiAutoBuildState = tryAutoBuildAdminUi('stale dist: ' + staleCheck.reason);
  }
}
const adminUiDistDir = adminUiDistCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || null;
const adminUiIndexFile = adminUiDistDir ? path.join(adminUiDistDir, 'index.html') : '';
const legacyWorkflowHtml = path.join(__dirname, 'quy-trinh-van-ban-noi-bo.html');
let adminUiServeMode = 'uninitialized';
let adminUiModeReason = '';

if (adminUiDistDir && fs.existsSync(adminUiIndexFile)) {
  adminUiServeMode = 'react-build';
  adminUiModeReason = `Found build file: ${adminUiIndexFile}`;
  // Vite build currently emits absolute /assets/* URLs by default.
  // Serve both /assets and /admin/assets to avoid 404 in admin SPA.
  app.use(
    '/assets',
    express.static(path.join(adminUiDistDir, 'assets'), {
      etag: false,
      lastModified: false,
      maxAge: 0,
    })
  );
  app.use(
    '/admin/assets',
    express.static(path.join(adminUiDistDir, 'assets'), {
      etag: false,
      lastModified: false,
      maxAge: 0,
    })
  );
  app.get(['/admin', '/admin/*'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.sendFile(adminUiIndexFile);
  });
} else {
  adminUiServeMode = fs.existsSync(legacyWorkflowHtml) ? 'legacy-fallback' : 'unavailable';
  const checkedDistPaths = adminUiDistCandidates.length
    ? adminUiDistCandidates.join(', ')
    : '(none)';
  adminUiModeReason = fs.existsSync(legacyWorkflowHtml)
    ? `Missing React build (checked: ${checkedDistPaths}); using legacy page (${legacyWorkflowHtml})`
    : `Missing React build (checked: ${checkedDistPaths}) and legacy page (${legacyWorkflowHtml})`;
  app.get(['/admin', '/admin/*'], (req, res) => {
    if (fs.existsSync(legacyWorkflowHtml)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      return res.sendFile(legacyWorkflowHtml);
    }
    return res.status(503).send('Admin UI is not available. Missing frontend build and legacy fallback page.');
  });
}
console.log(`[ADMIN UI] Mode=${adminUiServeMode}. ${adminUiModeReason}`);
function sendAdminUiStatus(res) {
  res.set('Cache-Control', 'no-store');
  return res.json({
    ok: adminUiServeMode !== 'unavailable',
    mode: adminUiServeMode,
    reason: adminUiModeReason,
    reactBuildIndexExists: !!(adminUiDistDir && fs.existsSync(adminUiIndexFile)),
    autoBuild: adminUiAutoBuildState,
    legacyFallbackExists: fs.existsSync(legacyWorkflowHtml),
    adminPath: '/admin',
  });
}
// Public status endpoint (không đi qua namespace /api để tránh bị auth middleware chặn).
app.get('/admin-ui-status', (req, res) => {
  return sendAdminUiStatus(res);
});
// Giữ endpoint cũ để tương thích nếu môi trường không chặn /api.
app.get('/api/admin-ui-status', (req, res) => {
  return sendAdminUiStatus(res);
});

app.use(
  express.static(__dirname, {
    /** Tắt ETag/Last-Modified — nếu không, trình duyệt vẫn nhận 304 dù có Cache-Control (file HTML cũ). */
    etag: false,
    lastModified: false,
    /** Tránh cache HTML; các file khác vẫn tải lại đầy đủ khi không còn 304. */
    setHeaders(res, filePath) {
      const lower = String(filePath || '').toLowerCase().replace(/\\/g, '/');
      // Các file JS của module DMS đang sửa đổi thường xuyên — nếu cache như file tĩnh thông
      // thường, trình duyệt có thể chạy bản cũ dù HTML đã tải bản mới (tab/nút mới hiện ra
      // nhưng bấm không phản ứng vì JS xử lý vẫn là bản trước đó).
      const isNoCacheJs = /\/js\/dms-(records-app|admin-page)\.js$/.test(lower);
      if (lower.endsWith('.html') || isNoCacheJs) {
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
      return res.status(500).json({ message: 'Lỗi enrichment' });
    }
  });

  app.get('/api/enrich/stats', authMiddleware, async (req, res) => {
    try {
      const stats = await enrichService.getEnrichmentStats();
      return res.json(stats);
    } catch (e) {
      console.error('[enrich/stats]', e);
      return res.status(500).json({ message: 'Lỗi thống kê enrichment' });
    }
  });

  if (typeof pubMod.mountEnrichmentStatsSse === 'function') {
    pubMod.mountEnrichmentStatsSse(app, authMiddleware, () => enrichService.getEnrichmentStats());
  }

  const { importScimagoCsvToJournalMetrics } = require(path.join(__dirname, 'lib', 'sjr-csv-import'));
  app.post(
    '/api/admin/sjr-csv-import',
    authMiddleware,
    masterAdminOnly,
    (req, res, next) => {
      uploadSjrCsv.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ message: 'Upload thất bại' });
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
        return res.status(500).json({ message: 'Lỗi import SJR' });
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
      return res.status(500).json({ message: 'Lỗi CSDL' });
    }
  });

  // Công bố khoa học — 5 endpoint bổ sung đã tách sang routes/publications/boSung.js.
  // PHẢI mount trước app.use('/api/publications', pubMod.publicationsRouter) để không bị :id nuốt.
  app.use('/api', require('./routes/publications/boSung')({
    db,
    authMiddleware,
    adminOnly,
    masterAdminOnly,
    authPubMod,
    trustMod,
    insertUserActivityLog,
  }));

  app.use('/api/publications', pubMod.publicationsRouter);

  // ── Công tắc Harvest (bật/tắt từ giao diện) ─────────────────────────────────
  // Nguồn sự thật đặt tại đây (sci-ace.db) chứ không ở module con: module con
  // dùng DB riêng (sci_khcn.db), trong khi công tắc phải chặn được cả hai lối
  // vào — POST /api/orcid/harvest và GET /api/orcid/harvest/stream (SSE).
  // Mặc định TẮT: sau khi deploy hoặc khởi động lại, harvest không tự chạy.
  const ORCID_HARVEST_KEY = 'orcid_harvest_enabled';

  function isOrcidHarvestEnabled() {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(ORCID_HARVEST_KEY);
      return !!row && String(row.value) === '1';
    } catch (e) {
      // Không đọc được trạng thái → coi như tắt; an toàn hơn là để chạy ngoài kiểm soát.
      console.error('[orcid-harvest] Không đọc được công tắc:', e && e.message ? e.message : e);
      return false;
    }
  }

  app.get('/api/orcid/harvest/enabled', authMiddleware, (req, res) => {
    res.json({ ok: true, enabled: isOrcidHarvestEnabled() });
  });

  app.post('/api/orcid/harvest/enabled', authMiddleware, adminOnly, (req, res) => {
    const raw = req.body && typeof req.body === 'object' ? req.body.enabled : undefined;
    const enabled = raw === true || raw === 1 || String(raw) === 'true' || String(raw) === '1';
    try {
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)')
        .run(ORCID_HARVEST_KEY, enabled ? '1' : '0');
    } catch (e) {
      console.error('[orcid-harvest] Không lưu được công tắc:', e && e.message ? e.message : e);
      return res.status(500).json({ ok: false, message: 'Không lưu được trạng thái Harvest.' });
    }
    insertUserActivityLog(req, {
      userId: req.user && req.user.id,
      email: req.user && req.user.email,
      action: enabled ? 'orcid_harvest_enabled' : 'orcid_harvest_disabled',
      module: 'publications',
      path: req.originalUrl || '/api/orcid/harvest/enabled',
      detail: JSON.stringify({ at: new Date().toISOString(), enabled })
    });
    console.log(
      `[orcid-harvest] ${enabled ? 'BẬT' : 'TẮT'} bởi ${(req.user && req.user.email) || 'không rõ'}`
    );
    return res.json({ ok: true, enabled });
  });

  // Chặn khi công tắc tắt. Đăng ký theo đúng từng route (không dùng tiền tố
  // '/api/orcid/harvest') để không vô tình chặn luôn hai route /enabled ở trên.
  function requireHarvestEnabled(req, res, next) {
    if (isOrcidHarvestEnabled()) return next();
    const message = 'Chức năng Harvest đang TẮT. Bật công tắc ở trang ORCID Auto-Harvest trước khi quét.';
    // SSE: client là EventSource, chỉ hiểu được thông báo qua chính luồng sự kiện.
    if (String(req.headers.accept || '').includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ ok: false })}\n\n`);
      return res.end();
    }
    return res.status(423).json({ ok: false, success: false, message });
  }
  app.get('/api/orcid/harvest/stream', requireHarvestEnabled);
  app.post('/api/orcid/harvest', requireHarvestEnabled);

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

  // Khối "Quản lý nghiên cứu viên (ORCID)" và "Duyệt import" trên trang Quản lý
  // công bố là thao tác của riêng Admin. Router con (module sci-khcn-publications)
  // không có lớp phân quyền nào, nên chặn tại đây TRƯỚC khi mount — giao diện đã
  // ẩn bằng .pub-admin-only, nhưng lớp ẩn đó dựa trên localStorage nên không đủ.
  // Chỉ khoá thao tác GHI; GET danh sách vẫn để nguyên cho trang Auto-Harvest.
  app.post('/api/orcid/researchers', authMiddleware, masterAdminOnly);
  app.delete('/api/orcid/researchers/:id', authMiddleware, masterAdminOnly);
  app.post('/api/orcid/queue/:id/approve', authMiddleware, adminOnly);
  app.post('/api/orcid/queue/:id/reject', authMiddleware, adminOnly);
  app.post('/api/orcid/queue/approve-all', authMiddleware, adminOnly);

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
  const httpServer = bindHost ? app.listen(PORT, bindHost, onListen) : app.listen(PORT, onListen);
  // Xử lý tường minh lỗi bind (EADDRINUSE, EACCES...): log + exit(1) để PM2/systemd
  // restart sạch, tránh trạng thái zombie "process còn sống nhưng không listen"
  // do uncaughtException handler mặc định chỉ log.
  httpServer.on('error', (err) => {
    const code = err && err.code ? err.code : '(unknown-code)';
    if (code === 'EADDRINUSE') {
      console.error(
        `[FATAL] Không bind được PORT=${PORT} (EADDRINUSE): một tiến trình khác đã chiếm port.\n` +
          `        Kill tiến trình cũ rồi thử lại. Trên Windows: netstat -ano | findstr :${PORT}\n` +
          `        Trên Linux: lsof -i :${PORT}`
      );
    } else if (code === 'EACCES') {
      console.error(
        `[FATAL] Không có quyền bind PORT=${PORT} (EACCES). Dùng port >1024 hoặc chạy với quyền phù hợp.`
      );
    } else {
      console.error('[FATAL] app.listen error:', code, err && err.stack ? err.stack : err);
    }
    process.exit(1);
  });
})();
