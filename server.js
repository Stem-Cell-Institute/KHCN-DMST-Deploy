/**
 * Backend SCI-ACE
 * - ÄÄƒng kÃ½ (@sci.edu.vn) + Ä‘Äƒng kÃ½ chá»‰ module CRD (má»i email khÃ¡c, role crd_user)
 * - Ná»™p há»“ sÆ¡ (upload), gá»­i email thÃ´ng bÃ¡o Há»™i Ä‘á»“ng
 * - Há»™i Ä‘á»“ng xem/táº£i há»“ sÆ¡
 * - Master Admin = tÃ i khoáº£n Ä‘Äƒng nháº­p cÃ³ email trÃ¹ng ADMIN_EMAIL (háº±ng sá»‘ trong file). Cáº¥p/gá»¡ vai trÃ² Admin; Admin phá»¥: quyá»n admin API nhÆ°ng khÃ´ng cáº¥p/gá»¡ Admin.
 * 
 * Database: Há»— trá»£ SQLite (local) vÃ  Turso (Cloudflare)
 * - Local: Sá»­ dá»¥ng better-sqlite3
 * - Cloudflare: Sá»­ dá»¥ng @libsql/client qua ./lib/db-bridge.js
 */
try { require('dotenv').config({ path: '.env' }); } catch (_) {}
/**
 * Civil time for Vietnam (ICT, UTC+7, no DST). Matches how Google services show "local time" for VN.
 * Set TZ in .env to override. Does not replace OS NTP â€” sync the host clock if drift is large.
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

// Database - tá»± Ä‘á»™ng chá»n SQLite hoáº·c Turso dá»±a trÃªn .env
// Sá»­ dá»¥ng ./lib/db-bridge.js thay vÃ¬ better-sqlite3 trá»±c tiáº¿p
const db = require('./lib/db-bridge');
const {
  CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
  isAllowedTaskCode,
} = require('./lib/capVienPublicTemplatesCatalog');

const app = express();
const PORT = process.env.PORT || 3000;

const BYTES_PER_MB = 1024 * 1024;
/** application/json â€” khÃ´ng Ã¡p dá»¥ng multipart/form-data (multer tá»± Ä‘á»c stream, khÃ´ng qua express.json). */
const BODY_JSON_LIMIT_STR =
  process.env.BODY_JSON_LIMIT != null && String(process.env.BODY_JSON_LIMIT).trim() !== ''
    ? String(process.env.BODY_JSON_LIMIT).trim()
    : '12mb';
/** KÃ­ch thÆ°á»›c tá»«ng file upload (multipart). Äá»™c láº­p vá»›i BODY_JSON_LIMIT_STR. */
const UPLOAD_FILE_BYTES_SUBMISSION = 20 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_SJR_CSV = 60 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_CAP_PUBLIC_TEMPLATE = 80 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_CAP_VIEN = 200 * BYTES_PER_MB;
/** TrÆ°á»ng text khÃ´ng pháº£i file trong multipart (máº·c Ä‘á»‹nh multer 1MB). Äá»“ng bá»™ má»©c vá»›i body JSON máº·c Ä‘á»‹nh. */
const MULTIPART_MAX_FIELD_BYTES = 12 * BYTES_PER_MB;

// Sau reverse proxy (Nginx/Traefik) trÃªn Ubuntu/container: TRUST_PROXY=1 Ä‘á»ƒ req.ip / req.secure Ä‘Ãºng
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

// Lá»—i khÃ´ng báº¯t Ä‘Æ°á»£c trong async / callback â€” log Ä‘á»ƒ váº­n hÃ nh (PM2/Docker) cÃ²n dáº¥u váº¿t.
// uncaughtException: tráº¡ng thÃ¡i process khÃ´ng an toÃ n; nhiá»u nÆ¡i gá»i process.exit(1) sau log Ä‘á»ƒ tiáº¿n trÃ¬nh giÃ¡m sÃ¡t tá»± restart.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.stack || reason : reason);
});

// Giá»›i háº¡n tá»‘c Ä‘á»™ toÃ n bá»™ /api/* trÆ°á»›c express.json â€” giáº£m nguy cÆ¡ flood body JSON (RAM/CPU).
(function mountApiRateLimitEarly() {
  const windowMs = Math.max(1000, parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '900000', 10) || 900000);
  const max = Math.max(1, parseInt(process.env.API_RATE_LIMIT_MAX || '400', 10) || 400);
  function getRateLimitKey(req) {
    // Æ¯u tiÃªn tÃ¡ch theo user Ä‘Äƒng nháº­p Ä‘á»ƒ trÃ¡nh dá»“n toÃ n bá»™ request theo 1 IP/proxy.
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

    // Fallback cho khÃ¡ch chÆ°a Ä‘Äƒng nháº­p: dÃ¹ng IP (Æ°u tiÃªn IP client tá»« proxy náº¿u cÃ³).
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
    message: { message: 'QuÃ¡ nhiá»u yÃªu cáº§u tá»›i API, vui lÃ²ng thá»­ láº¡i sau.' },
  });
  app.use('/api', apiRateLimiter);
})();

// Route kiá»ƒm tra sá»›m nháº¥t (trÆ°á»›c middleware)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend Ä‘ang cháº¡y' });
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
          `[clock] OS clock differs from Google HTTP Date by ~${skewSec}s. Sync system time (Windows: Settings â†’ Time & language) or NTP. Application TZ=${process.env.TZ}`
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

// Favicon: tráº£ 204 Ä‘á»ƒ trÃ¡nh 404 trong Console khi trÃ¬nh duyá»‡t tá»± gá»i /favicon.ico
app.get('/favicon.ico', (req, res) => {
  const favPath = path.join(__dirname, 'favicon.ico');
  if (fs.existsSync(favPath)) return res.sendFile(favPath);
  res.status(204).end();
});

// Route phá»¥c vá»¥ logo (Ä‘Æ°á»ng dáº«n tuyá»‡t Ä‘á»‘i, trÃ¡nh lá»—i khi má»Ÿ qua server)
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
  console.error('[FATAL] JWT_SECRET chÆ°a Ä‘Æ°á»£c cáº¥u hÃ¬nh trong mÃ´i trÆ°á»ng (.env hoáº·c biáº¿n há»‡ thá»‘ng). Dá»«ng á»©ng dá»¥ng.');
  process.exit(1);
}
const ALLOWED_EMAIL_DOMAIN = '@sci.edu.vn';
/**
 * Kiá»ƒm tra Ä‘á»‹nh dáº¡ng email an toÃ n trÆ°á»›c khi lÆ°u vÃ o users.email â€” cháº·n khoáº£ng tráº¯ng/kÃ½ tá»± Ä‘iá»u
 * khiá»ƒn (\r \n \t...) Ä‘á»ƒ email khÃ´ng thá»ƒ dÃ¹ng lÃ m vector chÃ¨n header khi truyá»n cho nodemailer
 * (CRLF/SMTP header injection), vÃ¬ email lÆ°u trong DB sáº½ Ä‘Æ°á»£c dÃ¹ng láº¡i á»Ÿ ráº¥t nhiá»u chá»— gá»­i mail.
 */
function isSafeEmailFormat(str) {
  const s = String(str || '');
  if (s.length > 190) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
/** Chá»‰ dÃ¹ng Ä‘áº·t lá»‹ch thiáº¿t bá»‹ CRD â€” JWT cÃ³ role nÃ y chá»‰ Ä‘Æ°á»£c gá»i /api/crd/* (+ me, logout, health). */
const CRD_ONLY_USER_ROLE = 'crd_user';
/** GiÃ¡ trá»‹ Ä‘áº·c biá»‡t: tin nháº¯n gá»­i tá»›i má»i ngÆ°á»i trong module CRD (kÃªnh chung). */
const CRD_BROADCAST_TO_ID = '__crd_broadcast__';
/** Email Master Admin (nhÃ  phÃ¡t triá»ƒn): toÃ n quyá»n cáº¥p / gá»¡ vai trÃ² Admin. Admin khÃ¡c chá»‰ lÃ  Admin thÆ°á»ng. */
const ADMIN_EMAIL = 'ntsinh0409@gmail.com';

// Database Ä‘Ã£ Ä‘Æ°á»£c khá»Ÿi táº¡o tá»« ./lib/db-bridge.js (dÃ²ng trÃªn)
// db-bridge tá»± Ä‘á»™ng chá»n SQLite (local) hoáº·c Turso (Cloudflare) dá»±a trÃªn DATABASE_URL trong .env

// ThÆ° má»¥c dá»¯ liá»‡u (DB + upload): máº·c Ä‘á»‹nh cáº¡nh code; production Ä‘áº·t APP_DATA_DIR Ä‘á»ƒ tÃ¡ch khá»i mÃ£ nguá»“n
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

// --- Giá»›i háº¡n Ä‘Æ°á»ng dáº«n khi xÃ³a file/thÆ° má»¥c (chá»‘ng path traversal / xÃ³a nháº§m mÃ£ nguá»“n) ---
const RESOLVED_UPLOADS_ROOT = path.resolve(uploadDir);
const RESOLVED_CAP_VIEN_UPLOADS_ROOT = path.resolve(uploadDirCapVien);

/**
 * Chuá»—i Ä‘Æ°á»ng dáº«n lÆ°u trong CSDL â†’ file tháº­t trÃªn Ä‘Ä©a.
 * Há»— trá»£ tiá»n tá»‘ uploads/ vÃ  uploads-cap-vien/ (cÅ©: relative tá»« thÆ° má»¥c code).
 * LÆ°u Ã½: báº£n cÅ© dÃ¹ng path.relative(__dirname, file) nÃªn cÃ³ thá»ƒ lÃ 
 * "data/uploads-cap-vien/..." â€” pháº£i nháº­n diá»‡n uploads-cap-vien/ á»Ÿ báº¥t ká»³ vá»‹ trÃ­ nÃ o trong chuá»—i.
 * TÆ°Æ¡ng tá»± vá»›i uploads/ (vd. data/uploads/htqt-...) khi APP_DATA_DIR tÃ¡ch khá»i thÆ° má»¥c code.
 * - uploads-cap-vien: cÃ³ thá»ƒ xuáº¥t hiá»‡n á»Ÿ Ä‘áº§u chuá»—i hoáº·c sau ../ (code /opt/app, file á»Ÿ APP_DATA_DIR).
 * - public-templates/...: lÆ°u má»›i (relative tá»›i uploads-cap-vien).
 * - uploads/: thÆ° má»¥c upload chung (missions, htqt, â€¦).
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
  // Legacy: má»™t sá»‘ báº£n ghi sai chá»‰ cÃ²n nhÃ¡nh public-templates/... (resolve cÅ© gáº¯n nháº§m uploads/)
  if (n.startsWith('public-templates/')) {
    return path.normalize(path.resolve(uploadDirCapVien, n));
  }

  if (n.startsWith('uploads/')) {
    return path.normalize(path.resolve(uploadDir, n.slice('uploads/'.length)));
  }
  return path.normalize(path.resolve(uploadDir, n));
}

/** File vá»«a ghi dÆ°á»›i uploadDir â†’ chuá»—i lÆ°u CSDL dáº¡ng uploads/... (khÃ´ng phá»¥ thuá»™c __dirname / APP_DATA_DIR). */
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

/** Kiá»ƒm tra path tá»« DB trÆ°á»›c khi res.download (defense-in-depth). Tráº£ { norm } hoáº·c { err: 403|404 }. */
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
  if (r.err === 403) return res.status(403).json({ message: 'Truy cáº­p bá»‹ tá»« chá»‘i' });
  if (r.err) return res.status(404).json({ message: 'File khÃ´ng tá»“n táº¡i' });
  return res.download(r.norm, downloadName);
}

/** Chuáº©n bá»‹ danh sÃ¡ch file cho ZIP; Ä‘Ã£ gá»­i lá»—i thÃ¬ tráº£ null. */
function prepareDownloadFileList(res, files) {
  const out = [];
  for (let i = 0; i < (files || []).length; i++) {
    const f = files[i];
    const r = normalizeAndCheckDownloadPath(f && f.path);
    if (r.err === 403) {
      res.status(403).json({ message: 'Truy cáº­p bá»‹ tá»« chá»‘i' });
      return null;
    }
    if (r.err) {
      res.status(404).json({ message: 'File khÃ´ng tá»“n táº¡i' });
      return null;
    }
    out.push({ norm: r.norm, originalName: f.originalName });
  }
  return out;
}

/** Chá»‰ file trong uploads/missions/<missionId>/ (Ä‘Ãºng cÃ¡ch lÆ°u khi upload). */
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

/** Chá»‰ thÆ° má»¥c .../submission_<id>/ náº±m trong uploads/ â€” trÃ¡nh rmSync nháº§m project root. */
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

// Äá» tÃ i cáº¥p Viá»‡n: cÃ¹ng file sci-ace.db (gom DB). File de-tai-cap-vien.db cÅ© Ä‘Æ°á»£c migrate má»™t láº§n khi khá»Ÿi Ä‘á»™ng.
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
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewNote TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedAt TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedById INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN revisionRound INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedById INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedByRole TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedAt TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
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
try { db.prepare('ALTER TABLE users ADD COLUMN academicTitle TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try {
  db.prepare('UPDATE users SET password_support_hint = NULL WHERE password_support_hint IS NOT NULL').run();
} catch (e) { /* khÃ´ng cÃ³ cá»™t password_support_hint */ }
try {
  db.exec('ALTER TABLE users DROP COLUMN password_support_hint');
} catch (e) { /* SQLite < 3.35 hoáº·c cá»™t Ä‘Ã£ xÃ³a / chÆ°a tá»«ng cÃ³ */ }

// â”€â”€â”€ CRD Lab Booking (Ä‘áº·t lá»‹ch thiáº¿t bá»‹) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

/** null náº¿u Ä‘Æ°á»£c phÃ©p dÃ¹ng CRD; chuá»—i lÃ½ do náº¿u bá»‹ cháº·n */
function crdPersonBlockedForUse(personId) {
  if (!personId) return 'KhÃ´ng xÃ¡c Ä‘á»‹nh ngÆ°á»i dÃ¹ng CRD';
  const row = db.prepare('SELECT is_banned, crd_access_revoked FROM crd_persons WHERE id = ?').get(personId);
  if (!row) return 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡ CRD';
  if (Number(row.crd_access_revoked) === 1) return 'Há»“ sÆ¡ CRD Ä‘Ã£ bá»‹ gá»¡. LiÃªn há»‡ quáº£n trá»‹ Ä‘á»ƒ kÃ­ch hoáº¡t láº¡i.';
  if (Number(row.is_banned) === 1) return 'TÃ i khoáº£n CRD Ä‘ang bá»‹ táº¡m khoÃ¡.';
  return null;
}

/** NgÆ°á»i cÃ³ vai trÃ² CRD gáº¯n cá» Quáº£n trá»‹ (vd Admin CRD) â€” dÃ¹ng kiá»ƒm duyá»‡t kÃªnh chung */
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
    ['m1', 'SEM-7000', 'KÃ­nh hiá»ƒn vi Ä‘iá»‡n tá»­ quÃ©t', 'Lab A-01', '#667eea', 8, 20, 4, 'Scanning Electron Microscope', 1],
    ['m2', 'XRD-Pro', 'MÃ¡y nhiá»…u xáº¡ tia X', 'Lab A-02', '#764ba2', 7, 22, 6, 'X-Ray Diffractometer', 2],
    ['m3', 'FTIR-4000', 'MÃ¡y quang phá»• há»“ng ngoáº¡i', 'Lab B-01', '#4caf88', 8, 18, 3, 'FTIR', 3],
    ['m4', 'TEM-HiRes', 'KÃ­nh hiá»ƒn vi Ä‘iá»‡n tá»­ truyá»n qua', 'Lab B-02', '#f5a623', 9, 17, 2, 'TEM', 4],
    ['m5', 'Rheometer-AR', 'MÃ¡y Ä‘o lÆ°u biáº¿n', 'Lab C-01', '#e05c6a', 8, 20, 5, 'Rheometer', 5]
  ].forEach(row => insM.run(...row));
  const insP = db.prepare('INSERT INTO crd_persons (id,name,email,role,avatar) VALUES (?,?,?,?,?)');
  [
    ['u_admin', 'Admin CRD', 'admin@crd.edu.vn', 'admin', 'A'],
    ['u1', 'Nguyá»…n Minh Khoa', 'khoa@crd.edu.vn', 'user', 'K'],
    ['u2', 'Tráº§n Thá»‹ Lan', 'lan@crd.edu.vn', 'user', 'L'],
    ['u3', 'LÃª VÄƒn HÃ¹ng', 'hung@crd.edu.vn', 'user', 'H']
  ].forEach(row => insP.run(...row));
  const insB = db.prepare(
    'INSERT INTO crd_bookings (id,machine_id,person_id,date,start_h,end_h,purpose,status) VALUES (?,?,?,?,?,?,?,?)'
  );
  insB.run('b1', 'm1', 'u1', todayStr, 9, 11, 'PhÃ¢n tÃ­ch váº­t liá»‡u nano', 'confirmed');
  insB.run('b2', 'm2', 'u2', todayStr, 13, 16, 'PhÃ¢n tÃ­ch cáº¥u trÃºc tinh thá»ƒ', 'confirmed');
  insB.run('b3', 'm3', 'u3', todayStr, 10, 12, 'NghiÃªn cá»©u polymer', 'confirmed');
  const ts = Date.now();
  db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
    'c1', 'u1', 'u2', 'b2', 'ChÃ o báº¡n, mÃ¬nh cáº§n dÃ¹ng XRD lÃºc 14hâ€“15h, báº¡n cÃ³ thá»ƒ dá»i sang 15h khÃ´ng?', ts - 3600000, 0
  );
  db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
    'c2', 'u2', 'u1', 'b2', 'MÃ¬nh xem láº¡i lá»‹ch nhÃ©.', ts - 1800000, 1
  );
  console.log('[CRD] ÄÃ£ seed dá»¯ liá»‡u máº·c Ä‘á»‹nh Ä‘áº·t lá»‹ch thiáº¿t bá»‹.');
}
try {
  crdSeedIfEmpty();
} catch (e) {
  console.warn('[CRD] Seed:', e.message);
}

/** Äáº·t lá»‹ch theo bÆ°á»›c 30 phÃºt â€” migrate báº£ng cÅ© INTEGER â†’ REAL */
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
    console.log('[CRD] ÄÃ£ migrate crd_bookings.start_h/end_h â†’ REAL (há»— trá»£ 30 phÃºt)');
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
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}

/**
 * Cho phÃ©p ALTER ... ADD COLUMN chá»‰ vá»›i (báº£ng, cá»™t, Ä‘á»‹nh nghÄ©a kiá»ƒu) Ä‘Ã£ khai bÃ¡o â€” trÃ¡nh SQL injection náº¿u sau nÃ y gá»i tá»« input.
 * Khi thÃªm migration cá»™t má»›i: bá»• sung Map tÆ°Æ¡ng á»©ng bÃªn dÆ°á»›i.
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
    console.warn(`[CRD] Ensure column: báº£ng khÃ´ng náº±m trong whitelist: ${tableName}`);
    return false;
  }
  const allowedDefs = byTable.get(col);
  if (!allowedDefs || !allowedDefs.has(def)) {
    console.warn(
      `[CRD] Ensure column: cá»™t hoáº·c kiá»ƒu SQL khÃ´ng Ä‘Æ°á»£c phÃ©p: ${table}.${col} â€” "${def}"`
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
    console.warn('[CRD] Ensure column: tÃªn báº£ng/cá»™t khÃ´ng há»£p lá»‡ (chá»‰ chá»¯, sá»‘, gáº¡ch dÆ°á»›i).');
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
  // SQLite chá»‰ cho phÃ©p default kiá»ƒu háº±ng sá»‘ khi dÃ¹ng ALTER TABLE ADD COLUMN.
  // Vá»›i datetime('now',...) sáº½ fail => thÃªm cá»™t TEXT trá»‘ng rá»“i update sau.
  'TEXT'
);

crdEnsureColumn(
  'crd_bookings',
  'research_group',
  'TEXT'
);

// Náº¿u báº£ng Ä‘Ã£ cÃ³ created_at (dáº¡ng TEXT) nhÆ°ng dá»¯ liá»‡u cÅ© chÆ°a Ä‘Æ°á»£c set, ta Ä‘iá»n giÃ¡ trá»‹ hiá»‡n táº¡i.
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
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
try {
  db.prepare('ALTER TABLE crd_persons ADD COLUMN crd_access_revoked INTEGER DEFAULT 0').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
try {
  db.prepare('ALTER TABLE crd_persons ADD COLUMN user_id INTEGER').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
try {
  db.prepare('ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
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
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
/** CRD â€” giá» tÃ­ch lÅ©y & nháº­t kÃ½ báº£o trÃ¬ (migrations/003_crd_maintenance_and_utilization.sql) */
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN accumulated_hours REAL DEFAULT 0').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_threshold_hours REAL DEFAULT 500').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN last_maintenance_date TEXT').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_notes TEXT').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
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
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
}
/** Map: personId â†’ [timestamp] cho rate-limiting gá»­i tin kÃªnh chung */
const crdBroadcastRateMap = new Map(); // cleared when server restarts (in-memory)
const CRD_BROADCAST_RATE_MS = 30_000;  // tá»‘i thiá»ƒu 30 giÃ¢y giá»¯a 2 láº§n gá»­i
const CRD_BROADCAST_RATE_BURST = 3;     // cho phÃ©p burst 3 tin trÆ°á»›c khi Ã¡p rate

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
      label: `Ká»³ ${i + 1} (${c} thÃ¡ng)`,
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

/** Sá»‘ ngÃ y thá»±c táº¿ (má»Ÿ bÆ°á»›c â†’ hoÃ n thÃ nh / Ä‘áº¿n hiá»‡n táº¡i) â€” tá»« lá»‹ch sá»­ + deadline + tráº¡ng thÃ¡i */
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

  // BÆ°á»›c 1 â€” má»Ÿ: táº¡o há»“ sÆ¡; Ä‘Ã³ng: ná»™p há»“ sÆ¡
  const s1o = dlOpened('1') || row.createdAt;
  let s1c = pickFirst('1', ['researcher_submit']);
  if (!s1c && st !== 'SUBMITTED' && st !== 'NEED_REVISION') {
    s1c = pickFirst('2', null) || row.createdAt;
  }
  const step1Done = !!s1c || (st !== 'SUBMITTED' && st !== 'NEED_REVISION');
  out['1'] = pack(s1o, s1c, step1Done);

  // BÆ°á»›c 2
  const s2o = dlOpened('2') || s1c || row.createdAt;
  const step2Done = ['VALIDATED', 'ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
  let s2c = pickLast('2', ['secretary_approve']);
  if (!s2c && step2Done && row.reviewedAt && st !== 'NEED_REVISION') s2c = row.reviewedAt;
  if (st === 'NEED_REVISION' || st === 'SUBMITTED') {
    out['2'] = pack(s2o, null, false);
  } else {
    out['2'] = pack(s2o, s2c, step2Done);
  }

  // BÆ°á»›c 3
  const s3o = dlOpened('3') || s2c || s2o;
  let s3c = pickLast('3', ['chairman_assign']);
  if (!s3c && row.assignedAt) s3c = row.assignedAt;
  const step3Done = ['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
  out['3'] = pack(s3o, s3c, step3Done);

  // BÆ°á»›c 4 â€” Ä‘Ã³ng: láº§n PB2 hoÃ n thÃ nh (reviewer_complete thá»© 2 theo thá»i gian)
  const s4o = dlOpened('4') || s3c || s3o;
  const rcTimes = pickAll('4', 'reviewer_complete').sort();
  let s4c = rcTimes.length >= 2 ? rcTimes[1] : null;
  const bothPb = !!(row.step_4_reviewer1_done && row.step_4_reviewer2_done);
  if (!s4c && bothPb && rcTimes.length === 1) s4c = rcTimes[0];
  out['4'] = pack(s4o, s4c, bothPb);

  // BÆ°á»›c 4A
  const s4aO = dlOpened('4a') || pickFirst('4a', ['budget_upload']) || s3c || s3o;
  let s4aC = pickLast('4a', ['budget_approve']);
  const step4aDone = String(row.budget_4a_status || '').toLowerCase() === 'approved';
  if (!s4aC && step4aDone && row.budget_4a_approved_at) s4aC = row.budget_4a_approved_at;
  out['4a'] = pack(s4aO, s4aC, step4aDone);

  // BÆ°á»›c 5 â€” má»Ÿ: sau khi Ä‘á»§ Ä‘iá»u kiá»‡n (max PB2 xong & phÃª duyá»‡t 4A) hoáº·c deadline / sá»± kiá»‡n Ä‘áº§u bÆ°á»›c 5
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
    /* báº£ng cÃ³ thá»ƒ chÆ°a táº¡o trÃªn DB cá»±c cÅ© */
  }

  return out;
}

try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedReviewerIds TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedAt TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedById INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_status TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_round INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('UPDATE cap_vien_submissions SET budget_4a_round = 1 WHERE COALESCE(budget_4a_round, 0) < 1').run(); } catch (e) { /* bá» qua */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_note TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer1_done INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer2_done INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN code TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN options_checked TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_location TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_attendance TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_documents TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_vote_result TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_decision TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_event_time TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_status TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_round INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('UPDATE cap_vien_submissions SET step5_council_revision_round = 0 WHERE step5_council_revision_round IS NULL').run(); } catch (e) { /* bá» qua */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_note TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_so_qd TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_kinh_phi TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_thoi_gian TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_phi_quan_ly TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_so_hd TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_hieu_luc TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_ma_dao_duc TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_hieu_luc TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_so_quyet_dinh TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_completed INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_waived INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_completed INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_waived INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
// BÆ°á»›c 9: danh má»¥c hoÃ¡ cháº¥t/váº­t tÆ° Ä‘Ã£ "khoÃ¡" (sá»‘ liá»‡u chÃ­nh thá»©c Ä‘á»ƒ Ä‘á»‘i sÃ¡nh dá»± toÃ¡n, xem cap_vien_step9_supply_item).
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_at TEXT').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_by INTEGER').run(); } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }

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
  -- BÆ°á»›c 9 (Thá»±c hiá»‡n Ä‘á» tÃ i): má»‘c hoáº¡t Ä‘á»™ng do Chá»§ nhiá»‡m/Admin tá»± khai bÃ¡o (thay vÃ¬ 3 má»‘c cá»‘ Ä‘á»‹nh trÆ°á»›c Ä‘Ã¢y).
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
  -- Danh má»¥c hoÃ¡ cháº¥t/váº­t tÆ° dá»± toÃ¡n (BÆ°á»›c 9). TrÆ°á»›c khi cap_vien_submissions.step9_supply_locked_at
  -- Ä‘Æ°á»£c set, Chá»§ nhiá»‡m/Admin cÃ²n sá»­a/xÃ³a tá»± do; sau khi khoÃ¡, approvedQty lÃ  sá»‘ liá»‡u chÃ­nh thá»©c Ä‘á»ƒ
  -- Ä‘á»‘i sÃ¡nh vá»›i cÃ¡c Ä‘á»£t cáº¥p phÃ¡t (cap_vien_step9_supply_issuance).
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
  -- Äá»£t cáº¥p phÃ¡t cho tá»«ng item â€” 'requested' do Chá»§ nhiá»‡m/Admin Ä‘á» nghá»‹, chá»‰ Admin/PhÃ²ng KHCN/ThÆ° kÃ½
  -- má»›i chuyá»ƒn sang 'confirmed' (trá»« vÃ o approvedQty) hoáº·c 'rejected'.
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
  -- BÆ°á»›c 11: Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh (nhÃ¢n sá»±/káº¿ hoáº¡ch/dá»± toÃ¡n/gia háº¡n) â€” quy trÃ¬nh 2 cáº¥p:
  -- Chá»§ nhiá»‡m ná»™p -> PhÃ²ng KHCN xem xÃ©t (yÃªu cáº§u bá»• sung/trÃ¬nh lÃªn/tá»« chá»‘i tháº³ng) -> Viá»‡n trÆ°á»Ÿng duyá»‡t/khÃ´ng duyá»‡t.
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
  db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('kinh_phi_vien', 'Kinh phÃ­ tá»« Viá»‡n Táº¿ bÃ o gá»‘c', 0, 2);
})();

// Báº£ng danh má»¥c háº¡ng má»¥c Ä‘á» tÃ i cáº¥p Viá»‡n (admin quáº£n trá»‹)
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
    const lv = [['stem-cell', 'Táº¿ bÃ o gá»‘c', 1], ['biotechnology', 'CÃ´ng nghá»‡ sinh há»c', 2], ['medicine', 'Y sinh há»c', 3], ['other', 'KhÃ¡c', 4]];
    lv.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_linh_vuc (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasLdt = db.prepare('SELECT id FROM cap_vien_loai_de_tai LIMIT 1').get();
  if (!hasLdt) {
    const ldt = [['research', 'Äá» tÃ i nghiÃªn cá»©u', 1], ['project', 'Dá»± Ã¡n', 2], ['program', 'ChÆ°Æ¡ng trÃ¬nh', 3]];
    ldt.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_loai_de_tai (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasKm = db.prepare('SELECT id FROM cap_vien_khoan_muc_chi LIMIT 1').get();
  if (!hasKm) {
    const km = [
      ['1', 'Chi thÃ¹ lao cho cÃ¡n bá»™ khoa há»c', null, 1],
      ['1.1', 'Chá»§ nhiá»‡m Ä‘á» tÃ i', '1', 2],
      ['1.2', 'ThÃ nh viÃªn chÃ­nh', '1', 3],
      ['1.3', 'Ká»¹ thuáº­t viÃªn/Trá»£ lÃ½', '1', 4],
      ['2', 'Chi mua váº­t tÆ°, nguyÃªn liá»‡u', null, 5],
      ['2.1', 'HÃ³a cháº¥t', '2', 6],
      ['2.2', 'Sinh pháº©m', '2', 7],
      ['2.3', 'Dá»¥ng cá»¥ thÃ­ nghiá»‡m tiÃªu hao', '2', 8],
      ['3', 'Chi mua sáº¯m, sá»­a chá»¯a tÃ i sáº£n cá»‘ Ä‘á»‹nh', null, 9],
      ['3.1', 'Thiáº¿t bá»‹', '3', 10],
      ['3.2', 'Pháº§n má»m', '3', 11],
      ['4', 'Chi há»™i nghá»‹, há»™i tháº£o, cÃ´ng tÃ¡c phÃ­', null, 12],
      ['4.1', 'Há»™i nghá»‹, há»™i tháº£o khoa há»c', '4', 13],
      ['4.2', 'CÃ´ng tÃ¡c phÃ­ trong nÆ°á»›c', '4', 14],
      ['4.3', 'CÃ´ng tÃ¡c phÃ­ nÆ°á»›c ngoÃ i', '4', 15],
      ['5', 'Chi thuÃª ngoÃ i', null, 16],
      ['5.1', 'ThuÃª chuyÃªn gia', '5', 17],
      ['5.2', 'ThuÃª dá»‹ch vá»¥ phÃ¢n tÃ­ch', '5', 18],
      ['6', 'Chi khÃ¡c', null, 19],
      ['6.1', 'Chi phÃ­ quáº£n lÃ½ chung (tá»‘i Ä‘a 5%)', '6', 20],
      ['6.2', 'Chi phÃ­ in áº¥n, vÄƒn phÃ²ng pháº©m', '6', 21]
    ];
    km.forEach(([c, l, p, o]) => db.prepare('INSERT INTO cap_vien_khoan_muc_chi (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(c, l, p, o));
  }
})();

(function migrateLegacyCapVienIntoMainDb() {
  if (!fs.existsSync(legacyCapVienDbPath)) return;
  const mainSubCount = db.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions').get().n;
  if (mainSubCount > 0) return;
  
  // Legacy database chá»‰ Ä‘á»c tá»« file local, luÃ´n dÃ¹ng better-sqlite3
  let legacyDb;
  try {
    const LegacyDatabase = require('better-sqlite3');
    legacyDb = new LegacyDatabase(legacyCapVienDbPath, { readonly: true });
  } catch (e) {
    console.warn('[DB] KhÃ´ng má»Ÿ Ä‘Æ°á»£c de-tai-cap-vien.db Ä‘á»ƒ gom vÃ o sci-ace.db:', e.message);
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
    console.log('[DB] ÄÃ£ gom dá»¯ liá»‡u Äá» tÃ i cáº¥p Viá»‡n tá»« de-tai-cap-vien.db vÃ o sci-ace.db. File cÅ© Ä‘á»•i tÃªn:', path.basename(bakPath));
  } catch (e) {
    try { db.prepare('DETACH DATABASE capvien_legacy').run(); } catch (_) {}
    console.error('[DB] Gom de-tai-cap-vien.db tháº¥t báº¡i:', e.message || e);
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
      insertCapVienHistory(sub.id, '1', 'researcher_submit', sub.submittedById, 'researcher', 'NghiÃªn cá»©u viÃªn ná»™p há»“ sÆ¡ Ä‘á» xuáº¥t', sub.createdAt);
    }
    const hasStep2 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '2');
    if (!hasStep2 && sub.reviewedAt && sub.reviewedById) {
      const u = db.prepare('SELECT fullname, role FROM users WHERE id = ?').get(sub.reviewedById);
      const performedByName = u ? (u.fullname || '') : '';
      const role = (u && u.role === 'admin') ? 'admin' : 'secretary';
      const actionType = (sub.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
      const note = sub.reviewNote || (actionType === 'secretary_approve' ? 'Há»£p lá»‡' : null);
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
      insertCapVienHistory(sub.id, '3', 'chairman_assign', sub.assignedById, 'chairman', 'PhÃ¢n cÃ´ng 2 pháº£n biá»‡n: ' + names.join(', '), sub.assignedAt);
    }
  }
})();

  try {
    db.prepare("ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'SUBMITTED'").run();
  } catch (e) { /* column Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewNote TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewedAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewedById INTEGER').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedReviewerIds TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedById INTEGER').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignNote TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submission_files ADD COLUMN uploadedAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingNote TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionById INTEGER').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedById INTEGER').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedById INTEGER').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedById INTEGER').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN completedAt TEXT').run();
  } catch (e) { /* Ä‘Ã£ tá»“n táº¡i */ }
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

// Báº£ng nhiá»‡m vá»¥ KHCN (dashboard): trÃ­ch xuáº¥t tá»« Ä‘á» tÃ i cÃ¡c cáº¥p, Ä‘á»“ng bá»™ tá»« cap_vien
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

// BÆ°á»›c 4 NhÃ¡nh A â€” XÃ©t chá»n táº¡i Viá»‡n & gá»­i Bá»™
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

// BÆ°á»›c 4 NhÃ¡nh B â€” Ná»™p cÆ¡ quan ngoÃ i
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

// Lá»‹ch sá»­ Ä‘á»•i nhÃ¡nh (reset vá» BÆ°á»›c 3)
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

// Lá»‹ch sá»­ hÃ nh Ä‘á»™ng cÃ¡c bÆ°á»›c (generic)
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

// BÆ°á»›c 5 â€” Chá» phÃª duyá»‡t chÃ­nh thá»©c & hoÃ n chá»‰nh thuyáº¿t minh
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

// BÆ°á»›c 6 â€” KÃ½ há»£p Ä‘á»“ng
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

// Báº£ng placeholder cho thá»‘ng kÃª trang chá»§ (khi cÃ³ module tÆ°Æ¡ng á»©ng sáº½ thÃªm cá»™t vÃ  dá»¯ liá»‡u)
db.exec(`CREATE TABLE IF NOT EXISTS personnel (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS ip_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
try {
  db.prepare('ALTER TABLE publications ADD COLUMN import_source TEXT DEFAULT NULL').run();
} catch (e) {
  /* cá»™t Ä‘Ã£ tá»“n táº¡i */
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
  try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN topics TEXT DEFAULT \'all\'').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
  try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN role TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN quoc_gia TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN loai_doi_tac TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }

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
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN expiry_alert_sent_at TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN post_expiry_alert_count INTEGER DEFAULT 0').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN last_post_expiry_alert_at TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_path TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_name TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_uploaded_at TEXT').run(); } catch (e) { /* Ä‘Ã£ cÃ³ cá»™t */ }

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

// Äá» xuáº¥t tiáº¿p nháº­n tÃ i chÃ­nh YTNN (ChÆ°Æ¡ng VII Quy cháº¿ KHCN-ÄMST SCI 2026)
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
    don_vi_tien_te TEXT DEFAULT 'VNÄ',
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
  // Chá»‰ dá»n missions_hidden Â«má»“ cÃ´iÂ» (há»“ sÆ¡ Ä‘Ã£ khÃ´ng cÃ²n trong cap_vien_submissions).
  // KHÃ”NG xÃ³a áº©n cho há»“ sÆ¡ váº«n tá»“n táº¡i â€” náº¿u khÃ´ng, sau khi Admin xÃ³a nhiá»‡m vá»¥ khá»i dashboard
  // (ghi missions_hidden), má»—i láº§n GET /api/missions sáº½ gá»¡ áº©n vÃ  INSERT láº¡i missions tá»« cap_vien (lá»—i Â«Ä‘Ã£ xÃ³a mÃ  váº«n hiá»‡nÂ»).
  // KhÃ´i phá»¥c Ä‘áº§y Ä‘á»§ tá»« nguá»“n: POST /api/admin/missions/sync-from-cap-vien (xÃ³a toÃ n bá»™ missions_hidden cap_vien).
  try {
    db.prepare(
      `DELETE FROM missions_hidden WHERE source_type = 'cap_vien' AND source_id NOT IN (SELECT id FROM cap_vien_submissions)`
    ).run();
  } catch (e) {
    /* báº£ng cÃ³ thá»ƒ chÆ°a cÃ³ */
  }
  const rows = db.prepare('SELECT id, title, submittedById, status, createdAt, code FROM cap_vien_submissions').all();
  const hidden = new Set(
    db.prepare("SELECT source_type || ':' || source_id AS k FROM missions_hidden").all().map(r => r.k)
  );
  // Ãnh xáº¡ Ä‘áº§y Ä‘á»§ 10 tráº¡ng thÃ¡i tháº­t cá»§a cap_vien_submissions (9-step) sang mÃ£ tráº¡ng thÃ¡i nhiá»‡m vá»¥
  // KHCN Ä‘Ã£ cÃ³ sáºµn nhÃ£n tiáº¿ng Viá»‡t (MISSION_STATUS_SEARCH_LABELS / getStatusText trong quan-ly-de-tai-co-so.html).
  // TrÆ°á»›c Ä‘Ã¢y ASSIGNED vÃ  CONTRACTED bá»‹ thiáº¿u trong map â†’ rÆ¡i vá» default 'planning' (Â«Láº­p káº¿ hoáº¡chÂ»),
  // khiáº¿n há»“ sÆ¡ Ä‘Ã£ kÃ½ há»£p Ä‘á»“ng (gáº§n cuá»‘i quy trÃ¬nh) hiá»ƒn thá»‹ nhÆ° vá»«a má»›i ná»™p; REJECTED cÅ©ng bá»‹ gá»™p
  // nháº§m vÃ o 'planning' thay vÃ¬ tráº¡ng thÃ¡i tá»« chá»‘i riÃªng.
  const statusMap = {
    SUBMITTED: 'planning',              // Má»›i ná»™p há»“ sÆ¡
    NEED_REVISION: 'planning',          // ThÆ° kÃ½ yÃªu cáº§u bá»• sung há»“ sÆ¡
    VALIDATED: 'planning',              // Há»“ sÆ¡ há»£p lá»‡, chá» phÃ¢n cÃ´ng pháº£n biá»‡n
    // DÃ¹ng 'cho_vien_xet_chon' (khÃ´ng pháº£i 'review') vÃ¬ sidebar quan-ly-de-tai-co-so.html gá»™p
    // 'review' vÃ o nhÃ³m "Nghiá»‡m thu" (nghiá»‡m thu cuá»‘i) â€” trong khi 3 tráº¡ng thÃ¡i nÃ y thá»±c cháº¥t lÃ 
    // "Ä‘ang chá» Há»™i Ä‘á»“ng Viá»‡n xÃ©t/há»p", Ä‘Ãºng nghÄ©a nhÃ³m "Chá» xÃ©t duyá»‡t".
    ASSIGNED: 'cho_vien_xet_chon',      // ÄÃ£ phÃ¢n cÃ´ng pháº£n biá»‡n â€” Ä‘ang tháº©m Ä‘á»‹nh
    REVIEWED: 'cho_vien_xet_chon',      // Pháº£n biá»‡n xong, chá» há»p Há»™i Ä‘á»“ng KHCN
    IN_MEETING: 'cho_vien_xet_chon',    // Äang há»p Há»™i Ä‘á»“ng KHCN
    CONDITIONAL: 'da_phe_duyet',        // Há»™i Ä‘á»“ng thÃ´ng qua (cÃ³ Ä‘iá»u kiá»‡n), chá» cáº¥p QÄ chÃ­nh thá»©c
    APPROVED: 'cho_ky_hop_dong',        // ÄÃ£ cÃ³ Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t, chá» kÃ½ há»£p Ä‘á»“ng
    CONTRACTED: 'dang_thuc_hien',       // ÄÃ£ kÃ½ há»£p Ä‘á»“ng â€” Ä‘ang triá»ƒn khai thá»±c hiá»‡n
    REJECTED: 'khong_duoc_phe_duyet',   // Bá»‹ tá»« chá»‘i / dá»«ng quy trÃ¬nh
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
 * XÃ³a Ä‘á» tÃ i khá»i dashboard vÃ  má»i báº£n ghi phá»¥ thuá»™c (SQLite foreign_keys = ON).
 * Thá»© tá»±: báº£ng tham chiáº¿u missions(id) trÆ°á»›c, cuá»‘i cÃ¹ng missions.
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
    /* báº£ng cÃ³ thá»ƒ chÆ°a tá»“n táº¡i trÃªn DB cÅ© */
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
      /* bá» qua file khÃ´ng xÃ³a Ä‘Æ°á»£c */
    }
  }
}

function resolveCapVienUploadRoot() {
  return path.resolve(uploadDirCapVien);
}

/** Chá»‰ cháº¥p nháº­n Ä‘Æ°á»ng dáº«n náº±m trong uploads-cap-vien â€” trÃ¡nh xÃ³a nháº§m mÃ£ nguá»“n (server.js, â€¦). */
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
 * XÃ³a hoÃ n toÃ n má»™t há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n khá»i toÃ n há»‡ thá»‘ng:
 * â€” má»i missions (dashboard) trá» tá»›i cap_vien + source_id (cascade buoc*, missions_filesâ€¦)
 * â€” missions_hidden, báº£ng cap_vien (file, lá»‹ch sá»­, deadline, submission)
 * â€” thÆ° má»¥c upload trÃªn Ä‘Ä©a (náº¿u cÃ³)
 * DÃ¹ng cho Admin: nÃºt XÃ³a á»Ÿ Quáº£n lÃ½ nhiá»‡m vá»¥ vÃ  DELETE /api/cap-vien/submissions/:id
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

// Sá»­a tÃªn file bá»‹ bá»ƒ dáº¥u: trÃ¬nh duyá»‡t gá»­i UTF-8 nhÆ°ng Node Ä‘á»c header theo Latin-1 â†’ chuyá»ƒn láº¡i UTF-8
function fixFilenameEncoding(name) {
  if (!name || typeof name !== 'string') return name || '';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

// TÃªn thÆ° má»¥c an toÃ n tá»« há» tÃªn (loáº¡i bá» kÃ½ tá»± Ä‘áº·c biá»‡t, khoáº£ng tráº¯ng â†’ gáº¡ch dÆ°á»›i)
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

// Multer: lÆ°u file táº¡m, sau khi táº¡o submission sáº½ chuyá»ƒn vÃ o uploads/<Há» tÃªn NCV>/submission_<id>/
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

/** Upload CSV SCImago (memory) â€” POST /api/admin/sjr-csv-import */
const uploadSjrCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_FILE_BYTES_SJR_CSV, fieldSize: MULTIPART_MAX_FIELD_BYTES },
});

// Multer cho Äá» tÃ i cáº¥p Viá»‡n (thÆ° má»¥c riÃªng)
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

/** Máº«u há»“ sÆ¡ cÃ´ng khai (trang táº£i máº«u Ä‘á» tÃ i cáº¥p Viá»‡n) â€” má»i Ä‘á»‹nh dáº¡ng, tá»‘i Ä‘a 80MB */
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
      return cb(new Error('Chá»‰ cháº¥p nháº­n file .doc hoáº·c .docx'));
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
      return cb(new Error('Máº«u Tá» trÃ¬nh merge chá»‰ há»— trá»£ Ä‘á»‹nh dáº¡ng .docx'));
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
      return cb(new Error('Chá»‰ cháº¥p nháº­n file .doc hoáº·c .docx'));
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
      return cb(new Error('Máº«u Tá» trÃ¬nh merge chá»‰ há»— trá»£ Ä‘á»‹nh dáº¡ng .docx'));
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
      return cb(new Error('Chá»‰ cháº¥p nháº­n file .doc hoáº·c .docx'));
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
      return cb(new Error('Máº«u Tá» trÃ¬nh merge chá»‰ há»— trá»£ Ä‘á»‹nh dáº¡ng .docx'));
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
      return cb(new Error('Chá»‰ cháº¥p nháº­n file .doc hoáº·c .docx'));
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
    if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Scan chá»‰ nháº­n PDF, DOC, DOCX, JPG, PNG'));
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
      return cb(new Error('Máº«u Tá» trÃ¬nh merge chá»‰ há»— trá»£ Ä‘á»‹nh dáº¡ng .docx'));
    }
    cb(null, true);
  }
});

// Cáº¥u hÃ¬nh máº·c Ä‘á»‹nh cho cÃ¡c module trÃªn trang chá»§
const HOMEPAGE_MODULES_DEFAULT = [
  { code: 'missions', label: 'Quáº£n lÃ½ nhiá»‡m vá»¥ KHCN', enabled: 1 },
  { code: 'cap_vien', label: 'Quáº£n lÃ½ Ä‘á» tÃ i cáº¥p Viá»‡n', enabled: 1 },
  { code: 'ethics_ace', label: 'Há»™i Ä‘á»“ng Ä‘áº¡o Ä‘á»©c trÃªn Ä‘á»™ng váº­t (SCI-ACE)', enabled: 1 },
  { code: 'personnel', label: 'Quáº£n lÃ½ NhÃ¢n lá»±c KHCN', enabled: 0 },
  { code: 'ip', label: 'Quáº£n lÃ½ TÃ i sáº£n TrÃ­ tuá»‡', enabled: 0 },
  { code: 'finance', label: 'Quáº£n lÃ½ TÃ i chÃ­nh KHCN', enabled: 0 },
  { code: 'publications', label: 'Quáº£n lÃ½ CÃ´ng bá»‘ Khoa há»c', enabled: 0 },
  { code: 'cooperation', label: 'Quáº£n lÃ½ Há»£p tÃ¡c', enabled: 1 },
  { code: 'equipment_stims', label: 'Quáº£n trá»‹ thiáº¿t bá»‹', enabled: 1 },
  { code: 'sample_storage', label: 'NgÃ¢n hÃ ng Táº¿ bÃ o & KhÃ¡ng thá»ƒ', enabled: 1 },
  { code: 'tech_transfer', label: 'Quáº£n lÃ½ Chuyá»ƒn giao CÃ´ng nghá»‡', enabled: 0 },
  { code: 'facilities', label: 'CRD Lab Booking', enabled: 1 },
  { code: 'ethics_integrity', label: 'Äáº¡o Ä‘á»©c vÃ  LiÃªm chÃ­nh khoa há»c', enabled: 0 },
  { code: 'reward', label: 'Quáº£n lÃ½ Khen thÆ°á»Ÿng & ÄÃ¡nh giÃ¡', enabled: 0 },
  { code: 'dms', label: 'Quáº£n lÃ½ tÃ i liá»‡u & há»“ sÆ¡ (HÃ nh chÃ­nh)', enabled: 1 },
  { code: 'document_workflow', label: 'Quy trÃ¬nh vÄƒn báº£n ná»™i bá»™', enabled: 1 },
  { code: 'department_reports', label: 'BÃ¡o cÃ¡o phÃ²ng ban', enabled: 1 },
];

(function migrateHomepageModuleSortOrder() {
  try {
    db.prepare('ALTER TABLE homepage_modules ADD COLUMN sort_order INTEGER DEFAULT 0').run();
  } catch (e) { /* cá»™t Ä‘Ã£ tá»“n táº¡i */ }
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

/** XÃ³a dÃ²ng homepage_modules sai (vd. code=reorder do route /:code nuá»‘t path /reorder) vÃ  sá»­a JSON homepage_module_order */
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

/** Ná»‘i mÃ£ document_workflow vÃ o JSON thá»© tá»± cÅ© (13 mÃ£) Ä‘á»ƒ kÃ©o tháº£ admin khÃ´ng lá»—i */
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

/** Bá»• sung dÃ²ng homepage_modules má»›i (sau khi má»Ÿ rá»™ng HOMEPAGE_MODULES_DEFAULT) */
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

/** Module Quáº£n lÃ½ tÃ i liá»‡u & há»“ sÆ¡ (DMS / hÃ nh chÃ­nh) */
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
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN external_scan_link TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN import_sheet TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN external_word_link TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_location TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_copy_type TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_sheet_count INTEGER').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_page_count INTEGER').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN retention_until TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN destruction_eligible_date TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN parent_case_ref TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN template_id INTEGER').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_code TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_at TEXT').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_by_id INTEGER REFERENCES users(id)').run();
} catch (e) {
  /* Ä‘Ã£ cÃ³ */
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
/** NgÆ°á»i Ä‘Ã£ cÃ³ vai trÃ² module trÆ°á»›c Ä‘Ã¢y â†’ tá»± thÃªm vÃ o danh sÃ¡ch má»Ÿ truy cáº­p (má»™t láº§n). */
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
/** NgÆ°á»i Ä‘Ã£ má»Ÿ truy cáº­p module nhÆ°ng chÆ°a cÃ³ dÃ²ng dms_user_roles â†’ máº·c Ä‘á»‹nh viewer (má»™t láº§n). */
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
    const r1 = ins.run(null, 'VÄƒn báº£n phÃ¡p lÃ½ ná»™i bá»™', 1);
    const p1 = r1.lastInsertRowid;
    ins.run(p1, 'Quyáº¿t Ä‘á»‹nh', 1);
    ins.run(p1, 'Quy cháº¿ / Quy Ä‘á»‹nh', 2);
    ins.run(null, 'Há»£p Ä‘á»“ng & Thá»a thuáº­n', 2);
    ins.run(null, 'Há»“ sÆ¡ Ä‘á» tÃ i KHCN', 3);
    ins.run(null, 'BiÃªn báº£n & Tá» trÃ¬nh', 4);
    ins.run(null, 'Káº¿ hoáº¡ch & CÃ´ng vÄƒn', 5);
    const tins = db.prepare(
      'INSERT INTO dms_document_types (name, code, sort_order, is_active) VALUES (?, ?, ?, 1)'
    );
    tins.run('Quy cháº¿ ná»™i bá»™', 'quy_che', 1);
    tins.run('Quyáº¿t Ä‘á»‹nh', 'quyet_dinh', 2);
    tins.run('Há»£p Ä‘á»“ng', 'hop_dong', 3);
    tins.run('BiÃªn báº£n', 'bien_ban', 4);
    tins.run('CÃ´ng vÄƒn', 'cong_van', 5);
    const tagIns = db.prepare('INSERT OR IGNORE INTO dms_tags (name, color, sort_order) VALUES (?, ?, ?)');
    tagIns.run('KHCN', '#2563eb', 1);
    tagIns.run('TSTT / IP', '#7c3aed', 2);
    tagIns.run('NhÃ¢n sá»±', '#0891b2', 3);
    tagIns.run('TÃ i chÃ­nh', '#047857', 4);
    tagIns.run('PhÃ¡p lÃ½', '#b45309', 5);
  } catch (e) {
    console.warn('[DB] seedDmsCatalogIfEmpty:', e.message || e);
  }
})();

/** GÃ¡n category_id xuá»‘ng má»¥c con khi báº£n ghi Ä‘ang á»Ÿ danh má»¥c cáº¥p trÃªn nhÆ°ng loáº¡i tÃ i liá»‡u trÃ¹ng tÃªn má»¥c con (VD: nhÃ³m Â«VÄƒn báº£nâ€¦Â» + loáº¡i Â«Quyáº¿t Ä‘á»‹nhÂ» â†’ má»¥c Quyáº¿t Ä‘á»‹nh). Idempotent má»—i láº§n khá»Ÿi Ä‘á»™ng. */
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

// Email (cáº¥u hÃ¬nh qua biáº¿n mÃ´i trÆ°á»ng)
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

/** From gá»­i SMTP: cÃ³ tÃªn hiá»ƒn thá»‹ (trÃ¡nh Gmail hiá»‡n chá»‰ local-part nhÆ° ntsinh0409). SMTP_FROM cÃ³ thá»ƒ: Ä‘á»‹a chá»‰ email; "TÃªn" <email>; hoáº·c chá»‰ tÃªn (khÃ´ng cÃ³ @) â†’ dÃ¹ng cÃ¹ng SMTP_USER lÃ m Ä‘á»‹a chá»‰. SMTP_FROM_NAME: tÃªn máº·c Ä‘á»‹nh khi SMTP_FROM lÃ  email thuáº§n. */
function getSmtpFrom() {
  const raw = (process.env.SMTP_FROM || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  if (raw.includes('<') && raw.includes('>')) {
    return raw;
  }
  // Chá»‰ tÃªn hiá»ƒn thá»‹, vÃ­ dá»¥ STIMS SCI â€” gá»­i tá»« Ä‘á»‹a chá»‰ SMTP_USER
  if (raw && !raw.includes('@')) {
    if (!user) return undefined;
    return { name: raw, address: user };
  }
  const address = (raw.includes('@') ? raw : user) || '';
  if (!address) return undefined;
  const name = (process.env.SMTP_FROM_NAME || 'Há»‡ thá»‘ng quáº£n lÃ­ KHCN&ÄMST SCI').trim();
  if (!name) return address;
  return { name, address };
}

function getCouncilEmails() {
  return emailsWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']);
}

/** Email cá»§a má»i user cÃ³ role PhÃ²ng KHCN â€” dÃ¹ng lÃ m ngÆ°á»i nháº­n (TO) khi ná»™p há»“ sÆ¡ má»›i, vÃ  CC khi thÃ´ng bÃ¡o káº¿t quáº£ duyá»‡t (Äá» tÃ i cáº¥p Viá»‡n). */
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

// Danh sÃ¡ch email nháº­n thÃ´ng bÃ¡o: Æ°u tiÃªn báº£ng notification_recipients (Admin quáº£n lÃ½), khÃ´ng cÃ³ thÃ¬ NOTIFICATION_EMAILS, rá»“i Há»™i Ä‘á»“ng trong DB
function getNotificationEmails(notificationKey) {
  const resolvedKey = notificationKey || 'generic_council_notice';
  let baseList = [];
  try {
    const rows = db.prepare('SELECT email FROM notification_recipients ORDER BY id').all();
    if (rows && rows.length > 0) {
      baseList = rows.map(r => (r.email || '').trim().toLowerCase()).filter(Boolean);
      return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
    }
  } catch (e) { /* báº£ng chÆ°a cÃ³ */ }
  const envList = (process.env.NOTIFICATION_EMAILS || '').trim();
  if (envList) {
    baseList = envList.split(/[,;]/).map(e => e.trim().toLowerCase()).filter(Boolean);
    return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
  }
  baseList = getCouncilEmails();
  return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
}

// Module Há»£p tÃ¡c quá»‘c táº¿: láº¥y email nháº­n thÃ´ng bÃ¡o theo topic (doan_ra, mou, ...) hoáº·c 'all'
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

// Tráº£ vá» { to: [email Viá»‡n trÆ°á»Ÿng], cc: [cÃ¡c email khÃ¡c] } â€” dÃ¹ng cho email MOU (KÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng, CC nhá»¯ng ngÆ°á»i cÃ²n láº¡i)
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

/** Email PhÃ²ng KHCN + ngÆ°á»i nháº­n theo topic (khÃ´ng gá»“m Viá»‡n trÆ°á»Ÿng) â€” dÃ¹ng cho nháº¯c viá»‡c theo tá»«ng loáº¡i Ä‘á» xuáº¥t */
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

/** ThÃ´ng bÃ¡o tá»›i PhÃ²ng KHCN (TO), CC Viá»‡n trÆ°á»Ÿng â€” khi ngÆ°á»i gá»­i ná»™p láº¡i / káº¿t thÃºc Ä‘á» xuáº¥t */
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
    console.warn('[coopNotifyPhongToCcVt] KhÃ´ng cÃ³ ngÆ°á»i nháº­n TO:', topic);
    return Promise.resolve();
  }
  cc = [...new Set(cc)].filter(e => to.indexOf(e) < 0);
  return coopSendMail({ to, cc: cc.length ? cc : undefined, subject: opts.subject, html: opts.html, text: opts.text });
}

function coopAssertSubmitter(req, row) {
  const e = (req.user && req.user.email || '').trim().toLowerCase();
  const se = (row.submitted_by_email || '').trim().toLowerCase();
  if (!se || e !== se) return { ok: false, message: 'Chá»‰ ngÆ°á»i gá»­i Ä‘á» xuáº¥t má»›i thá»±c hiá»‡n Ä‘Æ°á»£c thao tÃ¡c nÃ y.' };
  return { ok: true };
}

/** Tá»« chá»‘i (PhÃ²ng hoáº·c Viá»‡n trÆ°á»Ÿng): email ngÆ°á»i ná»™p â€” quy trÃ¬nh káº¿t thÃºc; há»“ sÆ¡ & coop_history giá»¯ nguyÃªn; chá»‰ admin xÃ³a. */
function coopSendMailTuChoi(loaiKey, row, id, who, note) {
  if (!row || !row.submitted_by_email) return Promise.resolve();
  const ma = row.ma_de_xuat || coopGenMa(loaiKey, id);
  const whoLabel = who === 'phong' ? 'PhÃ²ng KHCN&QHÄN' : 'Viá»‡n trÆ°á»Ÿng';
  const titleByLoai = { doan_ra: 'ÄoÃ n ra', doan_vao: 'ÄoÃ n vÃ o', mou: 'MOU / Thá»a thuáº­n', ytnn: 'Äá» tÃ i cÃ³ yáº¿u tá»‘ nÆ°á»›c ngoÃ i' };
  const t = titleByLoai[loaiKey] || 'Äá» xuáº¥t';
  const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
  const subj = `[Há»£p tÃ¡c QT] Tá»« chá»‘i Ä‘á» xuáº¥t â€” ${t} â€” ${ma}`;
  const intro = `<strong>${whoLabel}</strong> Ä‘Ã£ <strong>tá»« chá»‘i</strong> Ä‘á» xuáº¥t. <strong>Quy trÃ¬nh xá»­ lÃ½ Ä‘á» xuáº¥t nÃ y Ä‘Ã£ káº¿t thÃºc.</strong> Dá»¯ liá»‡u vÃ  lá»‹ch sá»­ thao tÃ¡c váº«n Ä‘Æ°á»£c lÆ°u trÃªn há»‡ thá»‘ng; chá»‰ Quáº£n trá»‹ viÃªn cÃ³ thá»ƒ xÃ³a báº£n ghi náº¿u cáº§n.`;
  return coopSendMail({
    to: [row.submitted_by_email],
    subject: subj,
    html: coopBuildEmail(`ThÃ´ng bÃ¡o tá»« chá»‘i Ä‘á» xuáº¥t (${t})`, intro,
      [['MÃ£', ma], ['Ã kiáº¿n / lÃ½ do', note || 'â€”']], 'TrÃ¢n trá»ng.', modUrl),
    text: `${whoLabel} Ä‘Ã£ tá»« chá»‘i Ä‘á» xuáº¥t ${ma}. Quy trÃ¬nh káº¿t thÃºc. Ã kiáº¿n: ${note || 'â€”'}\n${modUrl}`
  });
}

function sendNotificationToCouncil(submissionTitle, submittedByEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) {
    if (!transporter) console.log('[Email] Bá» qua: chÆ°a cáº¥u hÃ¬nh SMTP (kiá»ƒm tra file .env cÃ³ SMTP_HOST, SMTP_USER)');
    else console.log('[Email] Bá» qua: chÆ°a cÃ³ ngÆ°á»i nháº­n (thÃªm trong Quáº£n trá»‹ â†’ Danh sÃ¡ch ngÆ°á»i nháº­n email)');
    return Promise.resolve();
  }
  console.log('[Email] Gá»­i thÃ´ng bÃ¡o há»“ sÆ¡ má»›i tá»›i: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject: '[SCI-ACE] Há»“ sÆ¡ má»›i Ä‘Æ°á»£c ná»™p: ' + submissionTitle,
    text: 'NghiÃªn cá»©u viÃªn ' + submittedByEmail + ' vá»«a ná»™p há»“ sÆ¡: ' + submissionTitle + '. Vui lÃ²ng Ä‘Äƒng nháº­p vÃ o khu vá»±c Há»™i Ä‘á»“ng Ä‘á»ƒ xem vÃ  táº£i há»“ sÆ¡.',
    html: '<p>NghiÃªn cá»©u viÃªn <strong>' + submittedByEmail + '</strong> vá»«a ná»™p há»“ sÆ¡: <strong>' + submissionTitle + '</strong>.</p><p>Vui lÃ²ng Ä‘Äƒng nháº­p vÃ o <a href="' + (process.env.BASE_URL || 'http://localhost:' + PORT) + '/hoi-dong.html">khu vá»±c Há»™i Ä‘á»“ng</a> Ä‘á»ƒ xem vÃ  táº£i há»“ sÆ¡.</p>'
  }).catch(err => console.error('[Email] Lá»—i gá»­i:', err.message));
}

/** ThÃ´ng bÃ¡o tá»›i Há»™i Ä‘á»“ng khi NCV ná»™p láº¡i há»“ sÆ¡ sau khi ThÆ° kÃ½ yÃªu cáº§u bá»• sung (GÄ3). */
function sendResubmitEmail(submissionTitle, submittedByEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) return Promise.resolve();
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject: '[SCI-ACE] Há»“ sÆ¡ Ä‘Ã£ ná»™p láº¡i sau bá»• sung: ' + submissionTitle,
    text: 'NghiÃªn cá»©u viÃªn ' + submittedByEmail + ' Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡ (sau khi Ä‘Æ°á»£c yÃªu cáº§u bá»• sung): ' + submissionTitle + '. Vui lÃ²ng Ä‘Äƒng nháº­p vÃ o khu vá»±c Há»™i Ä‘á»“ng Ä‘á»ƒ kiá»ƒm tra láº¡i.',
    html: '<p>NghiÃªn cá»©u viÃªn <strong>' + submittedByEmail + '</strong> Ä‘Ã£ <strong>ná»™p láº¡i</strong> há»“ sÆ¡ (sau khi Ä‘Æ°á»£c yÃªu cáº§u bá»• sung): <strong>' + submissionTitle + '</strong>.</p><p>Vui lÃ²ng Ä‘Äƒng nháº­p vÃ o <a href="' + (process.env.BASE_URL || 'http://localhost:' + PORT) + '/hoi-dong.html">khu vá»±c Há»™i Ä‘á»“ng</a> Ä‘á»ƒ kiá»ƒm tra láº¡i.</p>'
  }).catch(err => console.error('[Email] Lá»—i gá»­i:', err.message));
}

/** Gá»­i email thÃ´ng bÃ¡o tin nháº¯n má»›i trÃªn kÃªnh chung CRD cho ngÆ°á»i Ä‘Ã£ báº­t thÃ´ng bÃ¡o */
function crdSendBroadcastEmailNotification(senderPersonId, message, ts) {
  if (!transporter) {
    console.log('[CRD broadcast] Bá» qua email: chÆ°a cáº¥u hÃ¬nh SMTP');
    return Promise.resolve();
  }
  const sender = db.prepare('SELECT name, email FROM crd_persons WHERE id = ?').get(senderPersonId);
  if (!sender) return Promise.resolve();
  const senderName = sender.name || sender.email || 'NgÆ°á»i dÃ¹ng CRD';
  const senderEmail = sender.email || '';

  // Láº¥y user_id cá»§a ngÆ°á»i gá»­i Ä‘á»ƒ trÃ¡nh notify chÃ­nh mÃ¬nh
  const senderRow = db.prepare('SELECT user_id FROM crd_persons WHERE id = ?').get(senderPersonId);
  const senderUserId = senderRow && senderRow.user_id != null ? Number(senderRow.user_id) : null;

  // Láº¥y danh sÃ¡ch user cÃ³ crd_email_notif = 1 vÃ  khÃ´ng pháº£i chÃ­nh mÃ¬nh
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
    console.log('[CRD broadcast] KhÃ´ng cÃ³ ngÆ°á»i nháº­n email thÃ´ng bÃ¡o');
    return Promise.resolve();
  }

  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const chatUrl = baseUrl + '/crd-booking-v2.html';
  const preview = message.length > 120 ? message.substring(0, 120) + 'â€¦' : message;
  const dateStr = new Date(ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const subject = '[SCI-ACE CRD] Tin nháº¯n má»›i trÃªn KÃªnh chung â€” ' + (new Date(ts)).toLocaleDateString('vi-VN');

  const htmlParts = recipients.map(r => {
    const name = r.fullname || r.email || 'báº¡n';
    return '<li style="margin-bottom:4px;"><a href="mailto:' + r.email + '">' + name + '</a> &lt;' + r.email + '&gt;</li>';
  }).join('');

  const html = `
<p>Xin chÃ o,</p>
<p><strong>${senderName}</strong> vá»«a gá»­i má»™t tin nháº¯n má»›i trÃªn <strong>KÃªnh chung CRD</strong>:</p>
<blockquote style="border-left:4px solid #667eea;margin:12px 0;padding:8px 16px;background:#f8f9ff;color:#333;">
  <em>${preview.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</em>
</blockquote>
<p><strong>NgÆ°á»i gá»­i:</strong> ${senderName}${senderEmail ? ' (' + senderEmail + ')' : ''}<br>
<strong>Thá»i gian:</strong> ${dateStr}</p>
<p>Vui lÃ²ng Ä‘Äƒng nháº­p vÃ o <a href="${chatUrl}">Khu vá»±c CRD</a> Ä‘á»ƒ xem toÃ n bá»™ tin nháº¯n vÃ  pháº£n há»“i.</p>
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">
<p style="font-size:12px;color:#888;">
  Báº¡n nháº­n Ä‘Æ°á»£c email nÃ y vÃ¬ Ä‘Ã£ báº­t thÃ´ng bÃ¡o CRD trong cÃ i Ä‘áº·t tÃ i khoáº£n.<br>
  Äá»ƒ táº¯t thÃ´ng bÃ¡o, vui lÃ²ng liÃªn há»‡ quáº£n trá»‹ hoáº·c cáº­p nháº­t trong <strong>Quáº£n trá»‹ â†’ NgÆ°á»i dÃ¹ng â†’ TÃ i khoáº£n Há»‡ thá»‘ng</strong>.
</p>`;

  return transporter.sendMail({
    from: getSmtpFrom(),
    to: recipients.map(r => r.email).join(', '),
    subject,
    html
  }).then(() => {
    console.log('[CRD broadcast] ÄÃ£ gá»­i email thÃ´ng bÃ¡o tá»›i ' + recipients.length + ' ngÆ°á»i');
  }).catch(err => {
    console.error('[CRD broadcast email] Lá»—i:', err.message);
  });
}

// Helper: thÃ´ng tin bÆ°á»›c hiá»‡n táº¡i / sáº¯p tá»›i / ngÆ°á»i duyá»‡t theo status (Äá» tÃ i cáº¥p Viá»‡n)
function getCapVienStepInfo(status) {
  const s = (status || 'SUBMITTED').toUpperCase();
  const map = {
    SUBMITTED: { current: 'BÆ°á»›c 1: Ná»™p há»“ sÆ¡ Ä‘á» xuáº¥t (Ä‘Ã£ hoÃ n thÃ nh)', next: 'BÆ°á»›c 2: Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh', who: 'ThÆ° kÃ½ HÄKHCN' },
    NEED_REVISION: { current: 'BÆ°á»›c 2: Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh (Ä‘ang chá» há»“ sÆ¡ bá»• sung)', next: 'BÆ°á»›c 2: Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh', who: 'ThÆ° kÃ½ HÄKHCN' },
    VALIDATED: { current: 'BÆ°á»›c 2: Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh (Ä‘Ã£ hoÃ n thÃ nh)', next: 'BÆ°á»›c 3: PhÃ¢n cÃ´ng pháº£n biá»‡n', who: 'Chá»§ tá»‹ch HÄKHCN' },
    ASSIGNED: { current: 'BÆ°á»›c 3: PhÃ¢n cÃ´ng pháº£n biá»‡n (Ä‘Ã£ hoÃ n thÃ nh)', next: 'BÆ°á»›c 4: ÄÃ¡nh giÃ¡ pháº£n biá»‡n', who: '2 Pháº£n biá»‡n' },
    UNDER_REVIEW: { current: 'BÆ°á»›c 4: ÄÃ¡nh giÃ¡ pháº£n biá»‡n (Ä‘ang thá»±c hiá»‡n)', next: 'BÆ°á»›c 4: ÄÃ¡nh giÃ¡ pháº£n biá»‡n', who: '2 Pháº£n biá»‡n' },
    REVIEWED: { current: 'BÆ°á»›c 4: ÄÃ¡nh giÃ¡ pháº£n biá»‡n (Ä‘Ã£ hoÃ n thÃ nh)', next: 'BÆ°á»›c 5: Há»p Há»™i Ä‘á»“ng Khoa há»c Viá»‡n', who: 'HÄKHCN' },
    IN_MEETING: { current: 'BÆ°á»›c 5: Há»p Há»™i Ä‘á»“ng (Ä‘ang thá»±c hiá»‡n)', next: 'BÆ°á»›c 5: Há»p Há»™i Ä‘á»“ng', who: 'HÄKHCN' },
    CONDITIONAL: { current: 'BÆ°á»›c 5: Há»p Há»™i Ä‘á»“ng (Ä‘Ã£ há»p)', next: 'BÆ°á»›c 6: Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t', who: 'Viá»‡n trÆ°á»Ÿng' },
    APPROVED: { current: 'BÆ°á»›c 6: Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t (Ä‘Ã£ hoÃ n thÃ nh)', next: 'BÆ°á»›c 7: KÃ½ há»£p Ä‘á»“ng thá»±c hiá»‡n', who: 'Viá»‡n trÆ°á»Ÿng & Chá»§ nhiá»‡m' },
    CONTRACTED: { current: 'BÆ°á»›c 7: KÃ½ há»£p Ä‘á»“ng (Ä‘Ã£ hoÃ n thÃ nh)', next: 'BÆ°á»›c tiáº¿p theo theo quy Ä‘á»‹nh', who: 'â€”' },
    IMPLEMENTATION: { current: 'Äang thá»±c hiá»‡n Ä‘á» tÃ i', next: 'BÃ¡o cÃ¡o tiáº¿n Ä‘á»™ / Nghiá»‡m thu', who: 'â€”' },
    COMPLETED: { current: 'ÄÃ£ hoÃ n thÃ nh', next: 'â€”', who: 'â€”' },
    REJECTED: { current: 'ÄÃ£ dá»«ng/tá»« chá»‘i', next: 'â€”', who: 'â€”' }
  };
  return map[s] || map.SUBMITTED;
}

// Äá» tÃ i cáº¥p Viá»‡n: gá»­i thÃ´ng bÃ¡o khi cÃ³ há»“ sÆ¡ má»›i ná»™p
function sendCapVienNewSubmissionEmail(opts) {
  const { submissionId, submissionTitle, submittedByEmail, submittedByName, createdAt, status } = opts;
  // Æ¯u tiÃªn gá»­i tháº³ng tá»›i PhÃ²ng KHCN (ngÆ°á»i xá»­ lÃ½ BÆ°á»›c 2); náº¿u chÆ°a cáº¥u hÃ¬nh role phong_khcn thÃ¬ fallback vá» danh sÃ¡ch thÃ´ng bÃ¡o cÅ©.
  let toList = getPhongKhcnEmails();
  if (!toList.length) toList = getNotificationEmails('cap_vien_new_submission');
  if (!transporter || toList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'NghiÃªn cá»©u viÃªn');
  const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : 'â€”';

  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Há»“ sÆ¡ má»›i Ä‘Æ°á»£c ná»™p: ' + (submissionTitle || '');
  const text =
    'KÃ­nh gá»­i PhÃ²ng Khoa há»c vÃ  CÃ´ng nghá»‡,\n\n' +
    'Há»‡ thá»‘ng quáº£n lÃ½ KHCN&ÄMST Viá»‡n Táº¿ bÃ o gá»‘c cÃ³ ghi nháº­n há»“ sÆ¡ má»›i Ä‘Äƒng kÃ­ Ä‘á» tÃ i cáº¥p Viá»‡n TBG do ' + submitterLabel + ' ná»™p.\n\n' +
    'ThÃ´ng tin Ä‘á» tÃ i:\n- TÃªn Ä‘á» tÃ i: ' + (submissionTitle || '') + '\n- NgÆ°á»i ná»™p: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- NgÃ y ná»™p: ' + dateStr + '\n\n' +
    'Khu vá»±c Há»™i Ä‘á»“ng (theo dÃµi vÃ  táº£i há»“ sÆ¡): ' + councilUrl + '\n\n' +
    'Hiá»‡n táº¡i: ' + stepInfo.current + '\n' +
    'Sáº¯p tá»›i: ' + stepInfo.next + '\n' +
    'Chá» duyá»‡t bá»Ÿi: ' + stepInfo.who + '\n\n' +
    'TrÃ¢n trá»ng.';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i PhÃ²ng Khoa há»c vÃ  CÃ´ng nghá»‡,</p>' +
    '<p>Há»‡ thá»‘ng quáº£n lÃ½ KHCN&ÄMST Viá»‡n Táº¿ bÃ o gá»‘c cÃ³ ghi nháº­n há»“ sÆ¡ má»›i Ä‘Äƒng kÃ­ Ä‘á» tÃ i cáº¥p Viá»‡n TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> ná»™p.</p>' +
    '<p><strong>ThÃ´ng tin Ä‘á» tÃ i:</strong></p>' +
    '<ul style="margin:0.5em 0">' +
    '<li>TÃªn Ä‘á» tÃ i: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
    '<li>NgÆ°á»i ná»™p: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
    '<li>NgÃ y ná»™p: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
    '</ul>' +
    '<p>Khu vá»±c Há»™i Ä‘á»“ng Ä‘á»ƒ theo dÃµi vÃ  táº£i há»“ sÆ¡:</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
    '<p><strong>Hiá»‡n táº¡i:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Sáº¯p tá»›i:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Chá» duyá»‡t bá»Ÿi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
    '<p>TrÃ¢n trá»ng.</p>' +
    '</div>';

  console.log('[Email] Gá»­i thÃ´ng bÃ¡o Äá» tÃ i cáº¥p Viá»‡n (há»“ sÆ¡ má»›i) tá»›i: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lá»—i gá»­i (Äá» tÃ i cáº¥p Viá»‡n):', err.message));
}

// Äá» tÃ i cáº¥p Viá»‡n â€” BÆ°á»›c 2: YÃªu cáº§u bá»• sung â€” gá»­i nghiÃªn cá»©u viÃªn (chÃ­nh) + thÃ´ng bÃ¡o Há»™i Ä‘á»“ng (phá»¥)
function sendCapVienStep2RevisionEmail(submissionTitle, researcherEmail, note, secretaryName, submissionId, researcherName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const resubmitUrl = baseUrl + '/nop-de-tai-cap-vien.html?resubmit=' + (submissionId || '');
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const researcherLabel = (researcherName && researcherName.trim()) ? researcherName.trim() : (researcherEmail || 'NghiÃªn cá»©u viÃªn');
  const secLabel = (secretaryName && secretaryName.trim()) ? secretaryName.trim() : 'ThÆ° kÃ½ HÄKHCN';
  const noteEsc = String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noteBlock = note ? '<p><strong>Ná»™i dung yÃªu cáº§u bá»• sung:</strong></p><p style="white-space:pre-wrap;background:#fff8e1;padding:12px;border-radius:8px">' + noteEsc + '</p>' : '';

  const promises = [];
  if (!transporter) return Promise.all(promises);

  // Email chÃ­nh: nghiÃªn cá»©u viÃªn â€” yÃªu cáº§u bá»• sung há»“ sÆ¡
  if (researcherEmail) {
    const subjectRes = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: YÃªu cáº§u bá»• sung há»“ sÆ¡ (BÆ°á»›c 2): ' + (submissionTitle || '');
    const textRes =
      'KÃ­nh gá»­i ' + researcherLabel + ',\n\n' +
      'ThÆ° kÃ½ HÄKHCN Ä‘Ã£ kiá»ƒm tra há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n cá»§a báº¡n vÃ  yÃªu cáº§u bá»• sung.\n\n' +
      'Ná»™i dung yÃªu cáº§u bá»• sung:\n' + (note || '') + '\n\n' +
      'ThÃ´ng tin Ä‘á» tÃ i: ' + (submissionTitle || '') + '\n\n' +
      'Báº¡n cáº§n chá»‰nh sá»­a vÃ  bá»• sung há»“ sÆ¡ theo ná»™i dung trÃªn, sau Ä‘Ã³ ná»™p láº¡i há»“ sÆ¡ qua há»‡ thá»‘ng.\n\n' +
      'Ná»™p láº¡i há»“ sÆ¡: ' + resubmitUrl + '\nTheo dÃµi Ä‘á» tÃ i: ' + timelineUrl + '\n\n' +
      'TrÃ¢n trá»ng,\nHá»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n';
    const htmlRes =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃ­nh gá»­i <strong>' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
      '<p>ThÆ° kÃ½ HÄKHCN Ä‘Ã£ kiá»ƒm tra há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n cá»§a báº¡n vÃ  yÃªu cáº§u bá»• sung.</p>' +
      noteBlock +
      '<p><strong>ThÃ´ng tin Ä‘á» tÃ i:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
      '<p>Báº¡n cáº§n chá»‰nh sá»­a vÃ  bá»• sung há»“ sÆ¡ theo ná»™i dung trÃªn, sau Ä‘Ã³ <strong>ná»™p láº¡i há»“ sÆ¡</strong> qua há»‡ thá»‘ng.</p>' +
      '<p><a href="' + resubmitUrl + '" style="color:#1565c0">Ná»™p láº¡i há»“ sÆ¡</a> &nbsp;|&nbsp; <a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi Ä‘á» tÃ i</a></p>' +
      '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: researcherEmail,
      subject: subjectRes,
      text: textRes,
      html: htmlRes
    }).catch(err => console.error('[Email] Lá»—i gá»­i (YÃªu cáº§u bá»• sung â†’ NCV):', err.message)));
  }

  // Email phá»¥: thÃ nh viÃªn Há»™i Ä‘á»“ng â€” thÃ´ng bÃ¡o Ä‘á»ƒ náº¯m thÃ´ng tin
  const councilList = getNotificationEmails('cap_vien_step2_revision_notice');
  if (councilList.length > 0) {
    const subjectCouncil = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c] (ThÃ´ng bÃ¡o) ThÆ° kÃ½ Ä‘Ã£ yÃªu cáº§u bá»• sung há»“ sÆ¡: ' + (submissionTitle || '');
    const textCouncil =
      'ThÃ´ng bÃ¡o Ä‘á»ƒ cÃ¡c thÃ nh viÃªn Há»™i Ä‘á»“ng náº¯m thÃ´ng tin:\n\n' +
      'ThÆ° kÃ½ ' + secLabel + ' Ä‘Ã£ yÃªu cáº§u bá»• sung há»“ sÆ¡ cho Ä‘á» tÃ i Â«' + (submissionTitle || '') + 'Â», do nghiÃªn cá»©u viÃªn ' + (researcherLabel + ' (' + (researcherEmail || '') + ')') + ' ná»™p.\n\n' +
      'Ná»™i dung yÃªu cáº§u bá»• sung:\n' + (note || '') + '\n\n' +
      'Theo dÃµi Ä‘á» tÃ i: ' + timelineUrl;
    const htmlCouncil =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p><strong>ThÃ´ng bÃ¡o Ä‘á»ƒ cÃ¡c thÃ nh viÃªn Há»™i Ä‘á»“ng náº¯m thÃ´ng tin</strong></p>' +
      '<p>ThÆ° kÃ½ <strong>' + (secLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ä‘Ã£ yÃªu cáº§u bá»• sung há»“ sÆ¡ cho Ä‘á» tÃ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>, do nghiÃªn cá»©u viÃªn ' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(researcherEmail || '').replace(/</g, '&lt;')) + ') ná»™p.</p>' +
      noteBlock +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi Ä‘á» tÃ i cáº¥p Viá»‡n</a></p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: councilList.join(', '),
      subject: subjectCouncil,
      text: textCouncil,
      html: htmlCouncil
    }).catch(err => console.error('[Email] Lá»—i gá»­i (YÃªu cáº§u bá»• sung â†’ HÄ):', err.message)));
  }
  return Promise.all(promises);
}

// Äá» tÃ i cáº¥p Viá»‡n â€” BÆ°á»›c 2 Ä‘Ã£ Há»£p lá»‡: gá»­i thÃ´ng bÃ¡o (1) nghiÃªn cá»©u viÃªn, (2) thÃ nh viÃªn Há»™i Ä‘á»“ng
function sendCapVienStep2ValidatedEmail(opts) {
  const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, reviewedByName, hasSupplement } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'NghiÃªn cá»©u viÃªn');
  const stepInfo = getCapVienStepInfo(status || 'VALIDATED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : 'â€”';
  const reviewedLabel = (reviewedByName && reviewedByName.trim()) ? reviewedByName.trim() : 'ThÆ° kÃ½ HÄKHCN';
  const supplementPhrase = hasSupplement ? ' sau khi nghiÃªn cá»©u viÃªn bá»• sung há»“ sÆ¡' : '';

  const promises = [];

  // (1) Email chÃ­nh: NghiÃªn cá»©u viÃªn â€” thÃ´ng bÃ¡o há»“ sÆ¡ Ä‘Ã£ há»£p lá»‡, chuyá»ƒn BÆ°á»›c 3
  if (submittedByEmail) {
    const subjectRes = hasSupplement
      ? '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Há»“ sÆ¡ bá»• sung cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c kiá»ƒm tra há»£p lá»‡ (BÆ°á»›c 2): ' + (submissionTitle || '')
      : '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Há»“ sÆ¡ cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c kiá»ƒm tra há»£p lá»‡ (BÆ°á»›c 2): ' + (submissionTitle || '');
    const textRes =
      'KÃ­nh gá»­i ' + submitterLabel + ',\n\n' +
      'ThÆ° kÃ½ HÄKHCN Ä‘Ã£ kiá»ƒm tra há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n cá»§a báº¡n' + (hasSupplement ? ' (bao gá»“m há»“ sÆ¡ bá»• sung)' : '') + ' vÃ  Ä‘Ã¡nh dáº¥u Há»£p lá»‡' + supplementPhrase + ' (BÆ°á»›c 2 â€“ Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh).\n\n' +
      'Há»“ sÆ¡ chuyá»ƒn sang BÆ°á»›c 3 (PhÃ¢n cÃ´ng pháº£n biá»‡n).\n\n' +
      'ThÃ´ng tin Ä‘á» tÃ i: ' + (submissionTitle || '') + '\nNgÃ y ná»™p: ' + dateStr + '\n\n' +
      'Theo dÃµi Ä‘á» tÃ i: ' + timelineUrl + '\n\n' +
      'TrÃ¢n trá»ng,\nHá»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n';
    const htmlRes =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃ­nh gá»­i <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
      '<p>ThÆ° kÃ½ HÄKHCN (' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ') Ä‘Ã£ kiá»ƒm tra há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n cá»§a báº¡n' + (hasSupplement ? ' (bao gá»“m há»“ sÆ¡ bá»• sung)' : '') + ' vÃ  Ä‘Ã¡nh dáº¥u <strong>Há»£p lá»‡' + (supplementPhrase.replace(/</g, '&lt;')) + '</strong> (BÆ°á»›c 2 â€“ Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh).</p>' +
      '<p>Há»“ sÆ¡ chuyá»ƒn sang <strong>BÆ°á»›c 3: PhÃ¢n cÃ´ng pháº£n biá»‡n</strong>.</p>' +
      '<p><strong>ThÃ´ng tin Ä‘á» tÃ i:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '<br>NgÃ y ná»™p: ' + (String(dateStr).replace(/</g, '&lt;')) + '</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi Ä‘á» tÃ i cáº¥p Viá»‡n</a></p>' +
      '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: submittedByEmail,
      subject: subjectRes,
      text: textRes,
      html: htmlRes
    }).catch(err => console.error('[Email] Lá»—i gá»­i (BÆ°á»›c 2 Há»£p lá»‡ â†’ NCV):', err.message)));
  }

  // (2) Email phá»¥: ThÃ nh viÃªn Há»™i Ä‘á»“ng â€” thÃ´ng bÃ¡o Ä‘á»ƒ náº¯m thÃ´ng tin
  const toList = getNotificationEmails('cap_vien_step2_validated_notice');
  if (toList.length > 0) {
    const subjectCouncil = hasSupplement
      ? '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Há»“ sÆ¡ bá»• sung Ä‘Ã£ Ä‘Æ°á»£c kiá»ƒm tra há»£p lá»‡ (BÆ°á»›c 2): ' + (submissionTitle || '')
      : '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Há»“ sÆ¡ Ä‘Ã£ Ä‘Æ°á»£c kiá»ƒm tra há»£p lá»‡ (BÆ°á»›c 2): ' + (submissionTitle || '');
    const textCouncil =
      'KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng,\n\n' +
      'Há»‡ thá»‘ng quáº£n lÃ½ KHCN&ÄMST Viá»‡n Táº¿ bÃ o gá»‘c thÃ´ng bÃ¡o: há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n TBG do ' + submitterLabel + ' ná»™p Ä‘Ã£ Ä‘Æ°á»£c ' + reviewedLabel + ' kiá»ƒm tra vÃ  Ä‘Ã¡nh dáº¥u Há»£p lá»‡' + supplementPhrase + ' (BÆ°á»›c 2 â€“ Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh).\n\n' +
      'ThÃ´ng tin Ä‘á» tÃ i:\n- TÃªn Ä‘á» tÃ i: ' + (submissionTitle || '') + '\n- NgÆ°á»i ná»™p: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- NgÃ y ná»™p: ' + dateStr + '\n\n' +
      'Khu vá»±c Há»™i Ä‘á»“ng (theo dÃµi vÃ  táº£i há»“ sÆ¡): ' + councilUrl + '\n\n' +
      'Hiá»‡n táº¡i: ' + stepInfo.current + '\n' +
      'Sáº¯p tá»›i: ' + stepInfo.next + '\n' +
      'Chá» duyá»‡t bá»Ÿi: ' + stepInfo.who + '\n\n' +
      'TrÃ¢n trá»ng.';
    const htmlCouncil =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng,</p>' +
      '<p>Há»‡ thá»‘ng quáº£n lÃ½ KHCN&ÄMST Viá»‡n Táº¿ bÃ o gá»‘c thÃ´ng bÃ¡o: há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> ná»™p Ä‘Ã£ Ä‘Æ°á»£c <strong>' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> kiá»ƒm tra vÃ  Ä‘Ã¡nh dáº¥u <strong>Há»£p lá»‡' + (supplementPhrase.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> (BÆ°á»›c 2 â€“ Kiá»ƒm tra há»“ sÆ¡ hÃ nh chÃ­nh).</p>' +
      '<p><strong>ThÃ´ng tin Ä‘á» tÃ i:</strong></p>' +
      '<ul style="margin:0.5em 0">' +
      '<li>TÃªn Ä‘á» tÃ i: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
      '<li>NgÆ°á»i ná»™p: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
      '<li>NgÃ y ná»™p: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
      '</ul>' +
      '<p>Khu vá»±c Há»™i Ä‘á»“ng Ä‘á»ƒ theo dÃµi vÃ  táº£i há»“ sÆ¡:</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
      '<p><strong>Hiá»‡n táº¡i:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Sáº¯p tá»›i:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
      '<strong>Chá» duyá»‡t bá»Ÿi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
      '<p>TrÃ¢n trá»ng.</p>' +
      '</div>';
    console.log('[Email] Gá»­i thÃ´ng bÃ¡o Äá» tÃ i cáº¥p Viá»‡n (BÆ°á»›c 2 Há»£p lá»‡) â†’ NCV + HÄ: ' + (submittedByEmail || '') + ', ' + toList.join(', '));
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject: subjectCouncil,
      text: textCouncil,
      html: htmlCouncil
    }).catch(err => console.error('[Email] Lá»—i gá»­i (BÆ°á»›c 2 Há»£p lá»‡ â†’ HÄ):', err.message)));
  }
  return Promise.all(promises);
}

// Äá» tÃ i cáº¥p Viá»‡n â€” NghiÃªn cá»©u viÃªn Ä‘Ã£ ná»™p há»“ sÆ¡ bá»• sung: gá»­i thÃ´ng bÃ¡o Ä‘áº¿n cÃ¡c thÃ nh viÃªn Há»™i Ä‘á»“ng
function sendCapVienSupplementSubmittedEmail(opts) {
  const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, supplementRound } = opts;
  const toList = getNotificationEmails('cap_vien_supplement_submitted_notice');
  if (!transporter || toList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'NghiÃªn cá»©u viÃªn');
  const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : 'â€”';
  const roundText = (supplementRound != null && supplementRound >= 1) ? ' (láº§n bá»• sung thá»© ' + supplementRound + ')' : '';

  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: NghiÃªn cá»©u viÃªn Ä‘Ã£ ná»™p há»“ sÆ¡ bá»• sung' + roundText + ': ' + (submissionTitle || '');
  const text =
    'KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng,\n\n' +
    'Há»‡ thá»‘ng quáº£n lÃ½ KHCN&ÄMST Viá»‡n Táº¿ bÃ o gá»‘c thÃ´ng bÃ¡o: nghiÃªn cá»©u viÃªn ' + submitterLabel + ' Ä‘Ã£ ná»™p há»“ sÆ¡ bá»• sung cho Ä‘á» tÃ i cáº¥p Viá»‡n TBG' + roundText + '.\n\n' +
    'ThÃ´ng tin Ä‘á» tÃ i:\n- TÃªn Ä‘á» tÃ i: ' + (submissionTitle || '') + '\n- NgÆ°á»i ná»™p: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- NgÃ y ná»™p há»“ sÆ¡ gá»‘c: ' + dateStr + '\n\n' +
    'Khu vá»±c Há»™i Ä‘á»“ng (theo dÃµi vÃ  táº£i há»“ sÆ¡): ' + councilUrl + '\n\n' +
    'Hiá»‡n táº¡i: ' + stepInfo.current + '\n' +
    'Sáº¯p tá»›i: ' + stepInfo.next + '\n' +
    'Chá» duyá»‡t bá»Ÿi: ' + stepInfo.who + '\n\n' +
    'TrÃ¢n trá»ng.';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng,</p>' +
    '<p>Há»‡ thá»‘ng quáº£n lÃ½ KHCN&ÄMST Viá»‡n Táº¿ bÃ o gá»‘c thÃ´ng bÃ¡o: nghiÃªn cá»©u viÃªn <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ä‘Ã£ ná»™p há»“ sÆ¡ bá»• sung cho Ä‘á» tÃ i cáº¥p Viá»‡n TBG' + (roundText.replace(/</g, '&lt;')) + '.</p>' +
    '<p><strong>ThÃ´ng tin Ä‘á» tÃ i:</strong></p>' +
    '<ul style="margin:0.5em 0">' +
    '<li>TÃªn Ä‘á» tÃ i: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
    '<li>NgÆ°á»i ná»™p: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
    '<li>NgÃ y ná»™p há»“ sÆ¡ gá»‘c: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
    '</ul>' +
    '<p>Khu vá»±c Há»™i Ä‘á»“ng Ä‘á»ƒ theo dÃµi vÃ  táº£i há»“ sÆ¡:</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
    '<p><strong>Hiá»‡n táº¡i:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Sáº¯p tá»›i:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
    '<strong>Chá» duyá»‡t bá»Ÿi:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
    '<p>TrÃ¢n trá»ng.</p>' +
    '</div>';

  console.log('[Email] Gá»­i thÃ´ng bÃ¡o Äá» tÃ i cáº¥p Viá»‡n (NCV Ä‘Ã£ ná»™p há»“ sÆ¡ bá»• sung) tá»›i: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lá»—i gá»­i (NCV ná»™p bá»• sung):', err.message));
}

// Äá» tÃ i cáº¥p Viá»‡n â€” BÆ°á»›c 3: Chá»§ tá»‹ch phÃ¢n cÃ´ng pháº£n biá»‡n â€” gá»­i Ä‘áº¿n tá»«ng pháº£n biá»‡n + toÃ n Há»™i Ä‘á»“ng
function sendCapVienStep3AssignEmail(submissionTitle, chairmanName, reviewerEmails, reviewerNames, submissionId) {
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const reviewersList = reviewerNames && reviewerNames.length ? reviewerNames.join(', ') : (reviewerEmails && reviewerEmails.length ? reviewerEmails.join(', ') : '');
  const htmlAll = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng,</p>' +
    '<p>Chá»§ tá»‹ch HÄKHCN <strong>' + (chairmanName || 'Chá»§ tá»‹ch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> Ä‘Ã£ phÃ¢n cÃ´ng pháº£n biá»‡n cho há»“ sÆ¡: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p><strong>Pháº£n biá»‡n Ä‘Æ°á»£c phÃ¢n cÃ´ng:</strong> ' + (String(reviewersList).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
    '<p>Giai Ä‘oáº¡n Ä‘Ã£ chuyá»ƒn sang <strong>BÆ°á»›c 4 â€“ ÄÃ¡nh giÃ¡ pháº£n biá»‡n</strong>. CÃ¡c thÃ nh viÃªn Ä‘Æ°á»£c phÃ¢n cÃ´ng cáº§n hoÃ n thÃ nh phiáº¿u Ä‘Ã¡nh giÃ¡ (SCI-TASK-06).</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vá»±c Há»™i Ä‘á»“ng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const textAll = 'Chá»§ tá»‹ch Ä‘Ã£ phÃ¢n cÃ´ng pháº£n biá»‡n cho há»“ sÆ¡: ' + submissionTitle + '. Pháº£n biá»‡n: ' + reviewersList + '. Giai Ä‘oáº¡n chuyá»ƒn sang BÆ°á»›c 4. ' + baseUrl;
  const promises = [];
  reviewerEmails.forEach((email, i) => {
    const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
    const htmlYou = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃ­nh gá»­i ' + (String(name || email).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ',</p>' +
      '<p>Chá»§ tá»‹ch HÄKHCN <strong>' + (chairmanName || 'Chá»§ tá»‹ch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> Ä‘Ã£ phÃ¢n cÃ´ng <strong>báº¡n</strong> lÃ m pháº£n biá»‡n cho há»“ sÆ¡: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
      '<p>Báº¡n vui lÃ²ng Ä‘Äƒng nháº­p vÃ  hoÃ n thÃ nh phiáº¿u Ä‘Ã¡nh giÃ¡ (SCI-TASK-06) theo quy Ä‘á»‹nh.</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vá»±c Há»™i Ä‘á»“ng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh</a></p>' +
      '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: email,
      subject: '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Báº¡n Ä‘Æ°á»£c phÃ¢n cÃ´ng pháº£n biá»‡n: ' + submissionTitle,
      text: 'Báº¡n Ä‘Æ°á»£c phÃ¢n cÃ´ng pháº£n biá»‡n há»“ sÆ¡: ' + submissionTitle + '. ' + baseUrl,
      html: htmlYou
    }).catch(err => console.error('[Email] Lá»—i gá»­i (phÃ¢n cÃ´ng pháº£n biá»‡n â†’ PB):', err.message)));
  });
  const toList = getNotificationEmails('cap_vien_step3_assign_notice');
  if (toList.length > 0) {
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject: '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Chá»§ tá»‹ch Ä‘Ã£ phÃ¢n cÃ´ng pháº£n biá»‡n (BÆ°á»›c 3): ' + submissionTitle,
      text: textAll,
      html: htmlAll
    }).catch(err => console.error('[Email] Lá»—i gá»­i (phÃ¢n cÃ´ng pháº£n biá»‡n â†’ HÄ):', err.message)));
  }
  return Promise.all(promises);
}

// BÆ°á»›c 3â†’4: Ngay sau khi Chá»§ tá»‹ch phÃ¢n cÃ´ng pháº£n biá»‡n â€” gá»­i Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh (to), CC Há»™i Ä‘á»“ng khoa há»c
function sendCapVienStep4aNotifyBudgetTeamEmail(opts) {
  const { submissionTitle, submissionId } = opts;
  if (!transporter) return Promise.resolve();
  const budgetTeamEmails = getBudgetTeamEmails();
  const councilList = getNotificationEmails('cap_vien_step4a_budget_cc_notice');
  if (!budgetTeamEmails || budgetTeamEmails.length === 0) {
    console.log('[Email] Bá» qua gá»­i Tá»• tháº©m Ä‘á»‹nh: chÆ°a cÃ³ thÃ nh viÃªn Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh trong há»‡ thá»‘ng.');
    return Promise.resolve();
  }
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: ThÃ´ng bÃ¡o tháº©m Ä‘á»‹nh dá»± toÃ¡n (BÆ°á»›c 4A) â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh,</p>' +
    '<p>Há»‡ thá»‘ng Quáº£n lÃ½ KHCN&ÄMST Viá»‡n Táº¿ bÃ o gá»‘c trÃ¢n trá»ng thÃ´ng bÃ¡o: Äá» tÃ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ä‘Ã£ hoÃ n thÃ nh BÆ°á»›c 3 (PhÃ¢n cÃ´ng pháº£n biá»‡n) vÃ  chuyá»ƒn sang BÆ°á»›c 4.</p>' +
    '<p>Äá» nghá»‹ Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh thá»±c hiá»‡n tháº©m Ä‘á»‹nh dá»± toÃ¡n theo quy Ä‘á»‹nh vÃ  ná»™p phiáº¿u tháº©m Ä‘á»‹nh (SCI-BUDGET-01, SCI-BUDGET-02) Ä‘Ãºng háº¡n.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh Ä‘á» tÃ i</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'ThÃ´ng bÃ¡o tháº©m Ä‘á»‹nh dá»± toÃ¡n: ' + submissionTitle + '. Äá» nghá»‹ Tá»• tháº©m Ä‘á»‹nh thá»±c hiá»‡n tháº©m Ä‘á»‹nh theo quy Ä‘á»‹nh vÃ  ná»™p Ä‘Ãºng háº¡n. ' + timelineUrl;
  const promises = [];
  promises.push(transporter.sendMail({
    from: getSmtpFrom(),
    to: budgetTeamEmails.join(', '),
    cc: councilList && councilList.length > 0 ? councilList.join(', ') : undefined,
    subject,
    text,
    html
  }).catch(err => console.error('[Email] Lá»—i gá»­i (thÃ´ng bÃ¡o Tá»• tháº©m Ä‘á»‹nh 4A):', err.message)));
  return Promise.all(promises);
}

// BÆ°á»›c 4A: Tá»• tháº©m Ä‘á»‹nh yÃªu cáº§u bá»• sung â€” gá»­i Chá»§ nhiá»‡m (to), CC Há»™i Ä‘á»“ng
function sendCapVienBudgetRevisionRequestEmail(opts) {
  const { submissionTitle, researcherEmail, researcherName, note, requestedByName, submissionId, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Tá»• tháº©m Ä‘á»‹nh yÃªu cáº§u bá»• sung/chá»‰nh sá»­a dá»± toÃ¡n â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i Chá»§ nhiá»‡m Ä‘á» tÃ i,</p>' +
    '<p>Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh Ä‘Ã£ xem xÃ©t dá»± toÃ¡n cá»§a Ä‘á» tÃ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> vÃ  yÃªu cáº§u bá»• sung/chá»‰nh sá»­a nhÆ° sau:</p>' +
    '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + (String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
    '<p><strong>NgÆ°á»i yÃªu cáº§u:</strong> ' + (String(requestedByName || '').replace(/</g, '&lt;')) + '</p>' +
    '<p>QuÃ½ Chá»§ nhiá»‡m vui lÃ²ng Ä‘Äƒng nháº­p há»‡ thá»‘ng, truy cáº­p trang theo dÃµi tiáº¿n trÃ¬nh vÃ  ná»™p láº¡i tÃ i liá»‡u tÃ i chÃ­nh Ä‘Ã£ chá»‰nh sá»­a (Phiáº¿u tháº©m Ä‘á»‹nh SCI-BUDGET-01 vÃ  Tá» trÃ¬nh SCI-BUDGET-02).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh Ä‘á» tÃ i</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'Tá»• tháº©m Ä‘á»‹nh yÃªu cáº§u bá»• sung dá»± toÃ¡n: ' + submissionTitle + '\n\nNá»™i dung: ' + (note || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] Lá»—i gá»­i (yÃªu cáº§u bá»• sung dá»± toÃ¡n â†’ NCV):', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC] ' + subject, text, html })
      .catch(err => console.error('[Email] Lá»—i gá»­i (yÃªu cáº§u bá»• sung dá»± toÃ¡n â†’ HÄ):', err.message)));
  }
  return Promise.all(promises);
}

// BÆ°á»›c 4A: NCV ná»™p tÃ i liá»‡u chá»‰nh sá»­a â€” thÃ´ng bÃ¡o Há»™i Ä‘á»“ng
function sendCapVienBudgetRevisedSubmittedEmail(opts) {
  const { submissionTitle, researcherName, submissionId, councilList } = opts;
  if (!transporter || !councilList || councilList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Chá»§ nhiá»‡m Ä‘Ã£ ná»™p tÃ i liá»‡u tÃ i chÃ­nh chá»‰nh sá»­a â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng,</p>' +
    '<p>Chá»§ nhiá»‡m Ä‘á» tÃ i <strong>' + (String(researcherName || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ä‘Ã£ ná»™p tÃ i liá»‡u tÃ i chÃ­nh Ä‘Ã£ chá»‰nh sá»­a cho Ä‘á» tÃ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p>Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh sáº½ kiá»ƒm tra vÃ  phÃª duyá»‡t hoáº·c yÃªu cáº§u bá»• sung tiáº¿p.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'Chá»§ nhiá»‡m Ä‘Ã£ ná»™p tÃ i liá»‡u tÃ i chÃ­nh chá»‰nh sá»­a: ' + submissionTitle + '. ' + timelineUrl;
  return transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
    .catch(err => console.error('[Email] Lá»—i gá»­i (NCV ná»™p chá»‰nh sá»­a dá»± toÃ¡n):', err.message));
}

// BÆ°á»›c 4A: Tá»• tháº©m Ä‘á»‹nh phÃª duyá»‡t â€” gá»­i Chá»§ nhiá»‡m + Há»™i Ä‘á»“ng
function sendCapVienBudgetApprovedEmail(opts) {
  const { submissionTitle, researcherEmail, researcherName, approvedByName, submissionId, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Dá»± toÃ¡n Ä‘Ã£ Ä‘Æ°á»£c tháº©m Ä‘á»‹nh xong â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng,</p>' +
    '<p>Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh Ä‘Ã£ phÃª duyá»‡t dá»± toÃ¡n cho Ä‘á» tÃ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p><strong>NgÆ°á»i phÃª duyá»‡t:</strong> ' + (String(approvedByName || '').replace(/</g, '&lt;')) + '</p>' +
    '<p>LÆ°u Ã½: BÆ°á»›c 4 (ÄÃ¡nh giÃ¡ pháº£n biá»‡n) vÃ  BÆ°á»›c 4A (Tháº©m Ä‘á»‹nh dá»± toÃ¡n) thá»±c hiá»‡n song song. Äá» tÃ i sáº½ chuyá»ƒn sang BÆ°á»›c 5 (Há»p Há»™i Ä‘á»“ng) khi cáº£ hai bÆ°á»›c Ä‘á»u hoÃ n thÃ nh.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'Dá»± toÃ¡n Ä‘Ã£ Ä‘Æ°á»£c tháº©m Ä‘á»‹nh xong: ' + submissionTitle + '. ' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] Lá»—i gá»­i (phÃª duyá»‡t dá»± toÃ¡n â†’ NCV):', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] Lá»—i gá»­i (phÃª duyá»‡t dá»± toÃ¡n â†’ HÄ):', err.message)));
  }
  return Promise.all(promises);
}

// BÆ°á»›c 4 & 4A Ä‘á»u hoÃ n thÃ nh â†’ chuyá»ƒn BÆ°á»›c 5 â€” thÃ´ng bÃ¡o Há»™i Ä‘á»“ng (vÄƒn phong trang trá»ng)
function sendCapVienStep5ReadyEmail(opts) {
  const { submissionTitle, submissionId } = opts;
  if (!transporter) return Promise.resolve();
  const councilList = getNotificationEmails('cap_vien_step5_ready_notice');
  if (!councilList || councilList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: Äá» tÃ i Ä‘Ã£ sáºµn sÃ ng Há»p Há»™i Ä‘á»“ng (BÆ°á»›c 5) â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c vÃ  CÃ´ng nghá»‡ Viá»‡n Táº¿ bÃ o gá»‘c,</p>' +
    '<p>Há»‡ thá»‘ng Quáº£n lÃ½ KHCN&ÄMST trÃ¢n trá»ng thÃ´ng bÃ¡o: Äá» tÃ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ä‘Ã£ hoÃ n thÃ nh BÆ°á»›c 4 (ÄÃ¡nh giÃ¡ pháº£n biá»‡n) vÃ  BÆ°á»›c 4A (Tháº©m Ä‘á»‹nh dá»± toÃ¡n).</p>' +
    '<p>Äá» tÃ i hiá»‡n Ä‘Ã£ sáºµn sÃ ng chuyá»ƒn sang <strong>BÆ°á»›c 5 â€“ Há»p Há»™i Ä‘á»“ng Khoa há»c Viá»‡n</strong> Ä‘á»ƒ xem xÃ©t vÃ  biá»ƒu quyáº¿t.</p>' +
    '<p>KÃ­nh mong QuÃ½ Há»™i Ä‘á»“ng sáº¯p xáº¿p thá»i gian vÃ  tham dá»± phiÃªn há»p theo quy Ä‘á»‹nh.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh Ä‘á» tÃ i</a></p>' +
    '<p>TrÃ¢n trá»ng kÃ­nh chÃ o,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n â€“ Viá»‡n Táº¿ bÃ o gá»‘c</p></div>';
  const text = 'Äá» tÃ i Ä‘Ã£ sáºµn sÃ ng Há»p Há»™i Ä‘á»“ng (BÆ°á»›c 5): ' + submissionTitle + '. ' + timelineUrl;
  return transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
    .catch(err => console.error('[Email] Lá»—i gá»­i (chuyá»ƒn BÆ°á»›c 5):', err.message));
}

/** Link chi tiáº¿t tiáº¿n trÃ¬nh Ä‘á» tÃ i cáº¥p Viá»‡n â€” BÆ°á»›c 5 */
function capVienStep5DetailUrl(submissionId) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  return baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
}
function capVienEmailEsc(s) {
  return String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ThÆ° kÃ½ HÄ: yÃªu cáº§u Chá»§ nhiá»‡m chá»‰nh sá»­a theo gÃ³p Ã½ (BÆ°á»›c 5)
function sendCapVienStep5SecretaryRevisionRequestEmail(opts) {
  const { submissionTitle, submissionId, round, note, requestedByName, researcherEmail, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 â€” YÃªu cáº§u chá»‰nh sá»­a há»“ sÆ¡ (vÃ²ng ' + round + ') â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ Chá»§ nhiá»‡m / QuÃ½ Há»™i Ä‘á»“ng,</p>' +
    '<p><strong>BÆ°á»›c 5 â€” Há»p Há»™i Ä‘á»“ng KHCN:</strong> Äá» tÃ i <strong>' + t + '</strong> â€” ThÆ° kÃ½ Há»™i Ä‘á»“ng Ä‘Ã£ gá»­i <strong>yÃªu cáº§u chá»‰nh sá»­a</strong> theo gÃ³p Ã½ Há»™i Ä‘á»“ng <strong>(vÃ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>Ná»™i dung yÃªu cáº§u:</strong></p>' +
    '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + capVienEmailEsc(note) + '</p>' +
    '<p><strong>NgÆ°á»i gá»­i yÃªu cáº§u:</strong> ' + capVienEmailEsc(requestedByName) + '</p>' +
    '<p><strong>Viá»‡c tiáº¿p theo:</strong> <strong>Chá»§ nhiá»‡m Ä‘á» tÃ i</strong> Ä‘Äƒng nháº­p há»‡ thá»‘ng, má»Ÿ tiáº¿n trÃ¬nh vÃ  <strong>ná»™p há»“ sÆ¡ chá»‰nh sá»­a</strong>. <strong>Chá»§ tá»‹ch HÄKHCN</strong> cÃ¹ng cÃ¡c thÃ nh viÃªn liÃªn quan theo dÃµi cáº­p nháº­t trÃªn há»‡ thá»‘ng.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh (BÆ°á»›c 5)</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'BÆ°á»›c 5 â€” YÃªu cáº§u chá»‰nh sá»­a (vÃ²ng ' + round + '): ' + submissionTitle + '\n\n' + (note || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 yÃªu cáº§u chá»‰nh sá»­a â†’ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC Há»™i Ä‘á»“ng] ' + subject, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 yÃªu cáº§u chá»‰nh sá»­a â†’ HÄ:', err.message)));
  }
  return Promise.all(promises);
}

// Chá»§ nhiá»‡m Ä‘Ã£ ná»™p há»“ sÆ¡ chá»‰nh sá»­a â€” chá» Chá»§ tá»‹ch xem xÃ©t
function sendCapVienStep5RevisionUploadedEmail(opts) {
  const { submissionTitle, submissionId, round, fileCount, uploaderName, councilList, researcherEmail } = opts;
  if (!transporter || !councilList || councilList.length === 0) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 â€” Chá»§ nhiá»‡m Ä‘Ã£ ná»™p há»“ sÆ¡ chá»‰nh sá»­a (vÃ²ng ' + round + ') â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ Chá»§ tá»‹ch / ThÆ° kÃ½ / ThÃ nh viÃªn Há»™i Ä‘á»“ng,</p>' +
    '<p><strong>' + capVienEmailEsc(uploaderName) + '</strong> Ä‘Ã£ ná»™p <strong>' + fileCount + '</strong> tá»‡p há»“ sÆ¡ chá»‰nh sá»­a cho Ä‘á» tÃ i <strong>' + t + '</strong> <strong>(vÃ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>Viá»‡c tiáº¿p theo:</strong> <strong>Chá»§ tá»‹ch HÄKHCN</strong> xem xÃ©t trÃªn há»‡ thá»‘ng: <strong>thÃ´ng qua báº£n chá»‰nh sá»­a</strong> hoáº·c <strong>yÃªu cáº§u chá»‰nh sá»­a tiáº¿p</strong>.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Má»Ÿ tiáº¿n trÃ¬nh BÆ°á»›c 5</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'BÆ°á»›c 5 â€” ÄÃ£ ná»™p há»“ sÆ¡ chá»‰nh sá»­a (vÃ²ng ' + round + '): ' + submissionTitle + '. ' + timelineUrl;
  const re = (researcherEmail || '').trim().toLowerCase();
  const researcherInCouncil = re && councilList.some(e => (e || '').trim().toLowerCase() === re);
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: councilList.join(', '),
    cc: (researcherEmail && !researcherInCouncil) ? researcherEmail : undefined,
    subject,
    text,
    html
  }).catch(err => console.error('[Email] BÆ°á»›c 5 ná»™p chá»‰nh sá»­a â†’ HÄ:', err.message));
}

// Chá»§ tá»‹ch HÄ: yÃªu cáº§u chá»‰nh sá»­a tiáº¿p
function sendCapVienStep5ChairRequestMoreEmail(opts) {
  const { submissionTitle, submissionId, round, note, chairName, researcherEmail, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 â€” YÃªu cáº§u chá»‰nh sá»­a tiáº¿p (vÃ²ng ' + round + ') â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃ­nh gá»­i QuÃ½ Chá»§ nhiá»‡m / QuÃ½ Há»™i Ä‘á»“ng,</p>' +
    '<p><strong>Chá»§ tá»‹ch HÄKHCN</strong> (' + capVienEmailEsc(chairName) + ') Ä‘Ã£ <strong>yÃªu cáº§u chá»‰nh sá»­a tiáº¿p</strong> Ä‘á»‘i vá»›i Ä‘á» tÃ i <strong>' + t + '</strong> <strong>(vÃ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>Ná»™i dung gÃ³p Ã½:</strong></p>' +
    '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + capVienEmailEsc(note) + '</p>' +
    '<p><strong>Viá»‡c tiáº¿p theo:</strong> <strong>Chá»§ nhiá»‡m Ä‘á» tÃ i</strong> cáº­p nháº­t há»“ sÆ¡ theo gÃ³p Ã½ vÃ  <strong>ná»™p láº¡i</strong> trÃªn há»‡ thá»‘ng.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh BÆ°á»›c 5</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'BÆ°á»›c 5 â€” YÃªu cáº§u chá»‰nh sá»­a tiáº¿p (vÃ²ng ' + round + '): ' + submissionTitle + '\n\n' + (note || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 chá»‰nh sá»­a tiáº¿p â†’ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC Há»™i Ä‘á»“ng] ' + subject, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 chá»‰nh sá»­a tiáº¿p â†’ HÄ:', err.message)));
  }
  return Promise.all(promises);
}

// Chá»§ tá»‹ch HÄ: thÃ´ng qua báº£n chá»‰nh sá»­a (káº¿t thÃºc vÃ²ng)
function sendCapVienStep5ChairApprovedRevisionEmail(opts) {
  const { submissionTitle, submissionId, round, chairName, researcherEmail, researcherName, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 â€” ÄÃ£ thÃ´ng qua báº£n chá»‰nh sá»­a (vÃ²ng ' + round + ') â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p><strong>BÆ°á»›c 5 â€” Há»p Há»™i Ä‘á»“ng KHCN:</strong> Äá» tÃ i <strong>' + t + '</strong> â€” <strong>Chá»§ tá»‹ch HÄKHCN</strong> (' + capVienEmailEsc(chairName) + ') Ä‘Ã£ <strong>thÃ´ng qua báº£n chá»‰nh sá»­a</strong> <strong>(vÃ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>Viá»‡c tiáº¿p theo:</strong> ThÆ° kÃ½ Há»™i Ä‘á»“ng cÃ³ thá»ƒ tiáº¿p tá»¥c cÃ¡c thao tÃ¡c BÆ°á»›c 5 trÃªn há»‡ thá»‘ng (cáº­p nháº­t thÃ´ng tin há»p, biÃªn báº£n, ghi nháº­n <strong>Há»™i Ä‘á»“ng KHCN thÃ´ng qua</strong> chuyá»ƒn BÆ°á»›c 6 khi Ä‘á»§ Ä‘iá»u kiá»‡n).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'BÆ°á»›c 5 â€” ThÃ´ng qua báº£n chá»‰nh sá»­a (vÃ²ng ' + round + '): ' + submissionTitle + '. ' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    const htmlCn = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃ­nh gá»­i ' + capVienEmailEsc(researcherName || 'QuÃ½ Chá»§ nhiá»‡m') + ',</p>' +
      '<p>Báº£n chá»‰nh sá»­a há»“ sÆ¡ Ä‘á» tÃ i <strong>' + t + '</strong> <strong>(vÃ²ng ' + round + ')</strong> Ä‘Ã£ Ä‘Æ°á»£c <strong>Chá»§ tá»‹ch HÄKHCN</strong> thÃ´ng qua.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiáº¿n trÃ¬nh</a></p>' +
      '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text: text + '\n(ThÃ´ng bÃ¡o tá»›i Chá»§ nhiá»‡m)', html: htmlCn })
      .catch(err => console.error('[Email] BÆ°á»›c 5 thÃ´ng qua chá»‰nh sá»­a â†’ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 thÃ´ng qua chá»‰nh sá»­a â†’ HÄ:', err.message)));
  }
  return Promise.all(promises);
}

// Ghi nháº­n Há»™i Ä‘á»“ng KHCN thÃ´ng qua â†’ chuyá»ƒn BÆ°á»›c 6
function sendCapVienStep5CouncilPassedEmail(opts) {
  const { submissionTitle, submissionId, researcherEmail, researcherName, councilList, recordedByName } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 hoÃ n táº¥t â€” Chuyá»ƒn BÆ°á»›c 6 (Cáº¥p Quyáº¿t Ä‘á»‹nh) â€” ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p><strong>Há»™i Ä‘á»“ng KHCN thÃ´ng qua</strong> Ä‘á»‘i vá»›i Ä‘á» tÃ i <strong>' + t + '</strong> Ä‘Ã£ Ä‘Æ°á»£c ghi nháº­n trÃªn há»‡ thá»‘ng' + (recordedByName ? ' (bá»Ÿi ' + capVienEmailEsc(recordedByName) + ')' : '') + '.</p>' +
    '<p>Há»“ sÆ¡ chuyá»ƒn sang <strong>BÆ°á»›c 6 â€” Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t</strong>. KÃ­nh má»i cÃ¡c Ä‘á»“ng chÃ­ cÃ³ trÃ¡ch nhiá»‡m theo dÃµi vÃ  thá»±c hiá»‡n bÆ°á»›c tiáº¿p theo.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh Ä‘á» tÃ i</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const text = 'BÆ°á»›c 5 hoÃ n táº¥t â€” chuyá»ƒn BÆ°á»›c 6: ' + submissionTitle + '. ' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    const htmlCn = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃ­nh gá»­i ' + capVienEmailEsc(researcherName || 'QuÃ½ Chá»§ nhiá»‡m') + ',</p>' +
      '<p>Äá» tÃ i <strong>' + t + '</strong> Ä‘Ã£ Ä‘Æ°á»£c <strong>ghi nháº­n Há»™i Ä‘á»“ng KHCN thÃ´ng qua</strong> vÃ  chuyá»ƒn sang <strong>BÆ°á»›c 6</strong>.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh</a></p>' +
      '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html: htmlCn })
      .catch(err => console.error('[Email] BÆ°á»›c 5 thÃ´ng qua HÄ â†’ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 thÃ´ng qua HÄ â†’ HÄ:', err.message)));
  }
  return Promise.all(promises);
}

/** BÆ°á»›c 6 hoÃ n thÃ nh â€” email trá»‹nh trá»ng: TO Chá»§ nhiá»‡m, CC thÃ nh viÃªn nháº­n thÃ´ng bÃ¡o HÄ (notification_recipients / HÄ trong DB) */
function sendCapVienStep6CompletedEmail(opts) {
  const { submissionTitle, submissionId, researcherEmail, researcherName, soQd, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const sq = capVienEmailEsc(soQd || 'â€”');
  const subject = 'THÃ”NG BÃO HÃ€NH CHÃNH â€” Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c: HoÃ n thÃ nh BÆ°á»›c 6 (Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t) â€” ' + (submissionTitle || '');
  const wrapOpen = '<div style="font-family:\'Times New Roman\',Times,Georgia,serif;font-size:15px;max-width:680px;line-height:1.6;color:#1a1a1a">';
  const wrapClose = '</div>';
  const htmlBody =
    '<p style="margin:0 0 14px 0;text-align:justify">CÄƒn cá»© quy trÃ¬nh quáº£n lÃ½ nhiá»‡m vá»¥ khoa há»c vÃ  cÃ´ng nghá»‡ cáº¥p Viá»‡n; Há»‡ thá»‘ng quáº£n lÃ½ Ä‘á» tÃ i xin <strong>trÃ¢n trá»ng thÃ´ng bÃ¡o</strong> Ä‘á»ƒ QuÃ½ Ä‘á»“ng chÃ­ biáº¿t, chá»§ Ä‘á»™ng triá»ƒn khai cÃ¡c viá»‡c tiáº¿p theo theo tháº©m quyá»n:</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top;width:36%"><strong>Ná»™i dung thÃ´ng bÃ¡o</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top">' +
    'ÄÃ£ <strong>hoÃ n thÃ nh BÆ°á»›c 6 â€” Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t Ä‘á» tÃ i</strong> trÃªn há»‡ thá»‘ng Ä‘iá»‡n tá»­.' +
    '</td></tr><tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>TÃªn Ä‘á» tÃ i</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">' + t + '</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Sá»‘ / kÃ½ hiá»‡u Quyáº¿t Ä‘á»‹nh</strong><br><span style="font-size:12px;color:#546e7a">(Ä‘Ã£ ghi nháº­n)</span></td><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>' + sq + '</strong></td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Há»“ sÆ¡ Ä‘Ã­nh kÃ¨m</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">Báº£n Quyáº¿t Ä‘á»‹nh <strong>tiáº¿ng Viá»‡t</strong> vÃ  <strong>tiáº¿ng Anh</strong> (báº£n scan) Ä‘Ã£ Ä‘Æ°á»£c lÆ°u trong há»“ sÆ¡ Ä‘iá»‡n tá»­; QuÃ½ Ä‘á»“ng chÃ­ Ä‘Äƒng nháº­p há»‡ thá»‘ng Ä‘á»ƒ tra cá»©u, táº£i vá» khi cáº§n.</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Viá»‡c tiáº¿p theo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">Chuyá»ƒn sang <strong>BÆ°á»›c 7 â€” KÃ½ há»£p Ä‘á»“ng thá»±c hiá»‡n</strong>. Äá» nghá»‹ <strong>Chá»§ nhiá»‡m</strong> phá»‘i há»£p cháº·t cháº½ vá»›i <strong>PhÃ²ng Khoa há»c vÃ  CÃ´ng nghá»‡</strong> vÃ  cÃ¡c bá»™ pháº­n liÃªn quan Ä‘á»ƒ chuáº©n bá»‹, rÃ  soÃ¡t vÃ  tiáº¿n hÃ nh kÃ½ káº¿t há»£p Ä‘á»“ng Ä‘Ãºng tiáº¿n Ä‘á»™; <strong>Há»™i Ä‘á»“ng KHCN Viá»‡n</strong> tiáº¿p tá»¥c theo dÃµi, phá»‘i há»£p khi cáº§n thiáº¿t.</td></tr></table>' +
    '<p style="margin:14px 0 8px 0"><strong>ÄÆ°á»ng link theo dÃµi tiáº¿n trÃ¬nh:</strong> <a href="' + timelineUrl + '" style="color:#0d47a1">' + timelineUrl + '</a></p>' +
    '<p style="margin:16px 0 0 0;text-align:justify;font-size:13px;color:#455a64"><em>VÄƒn báº£n Ä‘Æ°á»£c gá»­i tá»± Ä‘á»™ng tá»« Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n nháº±m phá»¥c vá»¥ cÃ´ng tÃ¡c hÃ nh chÃ­nh vÃ  lÆ°u váº¿t trao Ä‘á»•i.</em></p>' +
    '<p style="margin:20px 0 0 0"><strong>TrÃ¢n trá»ng thÃ´ng bÃ¡o.</strong></p>';
  const salutationCn = '<p style="margin:0 0 6px 0"><strong>KÃ­nh gá»­i QuÃ½ Chá»§ nhiá»‡m' + (researcherName ? ' ' + capVienEmailEsc(researcherName) : '') + ',</strong></p>' +
    '<p style="margin:0 0 12px 0">cc QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n.</p>';
  const salutationHdOnly = '<p style="margin:0 0 12px 0"><strong>KÃ­nh gá»­i QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n,</strong></p>';
  const htmlForChuNhiem = wrapOpen + salutationCn + htmlBody + wrapClose;
  const htmlForHdOnly = wrapOpen + salutationHdOnly + htmlBody + wrapClose;
  const text =
    'THÃ”NG BÃO HÃ€NH CHÃNH â€” HoÃ n thÃ nh BÆ°á»›c 6 (Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t).\n' +
    'KÃ­nh gá»­i QuÃ½ Chá»§ nhiá»‡m' + (researcherName ? ' ' + String(researcherName).trim() : '') + ',\n' +
    'cc QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n.\n\n' +
    'Äá» tÃ i: ' + (submissionTitle || '') + '\n' +
    'Sá»‘ QÄ ghi nháº­n: ' + (soQd || 'â€”') + '\n' +
    'Viá»‡c tiáº¿p theo: BÆ°á»›c 7 â€” KÃ½ há»£p Ä‘á»“ng thá»±c hiá»‡n.\n' +
    'Xem tiáº¿n trÃ¬nh: ' + timelineUrl;

  const rEmail = String(researcherEmail || '').trim().toLowerCase();
  if (!rEmail) {
    console.warn('[Email] BÆ°á»›c 6 hoÃ n thÃ nh: khÃ´ng cÃ³ email Chá»§ nhiá»‡m, chá»‰ gá»­i Há»™i Ä‘á»“ng náº¿u cÃ³.');
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
    }).catch(err => console.error('[Email] BÆ°á»›c 6 hoÃ n thÃ nh â†’ CN+CC:', err.message)));
  } else if (ccList.length > 0) {
    const textHd =
      'THÃ”NG BÃO HÃ€NH CHÃNH â€” HoÃ n thÃ nh BÆ°á»›c 6 (Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t).\n' +
      'KÃ­nh gá»­i QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n.\n\n' +
      'Äá» tÃ i: ' + (submissionTitle || '') + '\n' +
      'Sá»‘ QÄ ghi nháº­n: ' + (soQd || 'â€”') + '\n' +
      'Viá»‡c tiáº¿p theo: BÆ°á»›c 7 â€” KÃ½ há»£p Ä‘á»“ng thá»±c hiá»‡n.\n' +
      'Xem tiáº¿n trÃ¬nh: ' + timelineUrl;
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: ccList.join(', '),
      subject,
      text: textHd + '\n\n(KhÃ´ng xÃ¡c Ä‘á»‹nh Ä‘Æ°á»£c email Chá»§ nhiá»‡m â€” chá»‰ gá»­i Há»™i Ä‘á»“ng.)',
      html: '<p><em>(KhÃ´ng xÃ¡c Ä‘á»‹nh Ä‘Æ°á»£c email Chá»§ nhiá»‡m â€” gá»­i danh sÃ¡ch Há»™i Ä‘á»“ng nháº­n TO.)</em></p>' + htmlForHdOnly
    }).catch(err => console.error('[Email] BÆ°á»›c 6 hoÃ n thÃ nh â†’ HÄ only:', err.message)));
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

/** BÆ°á»›c 7 hoÃ n thÃ nh â€” email hÃ nh chÃ­nh (TO Chá»§ nhiá»‡m, CC nhÆ° BÆ°á»›c 6); cÃ³ thá»ƒ táº¯t trong Quáº£n trá»‹ */
function sendCapVienStep7CompletedEmail(opts) {
  const { submissionTitle, submissionId, researcherEmail, researcherName, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = 'THÃ”NG BÃO HÃ€NH CHÃNH â€” Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c: HoÃ n thÃ nh BÆ°á»›c 7 (KÃ½ há»£p Ä‘á»“ng KHCN) â€” ' + (submissionTitle || '');
  const wrapOpen = '<div style="font-family:\'Times New Roman\',Times,Georgia,serif;font-size:15px;max-width:680px;line-height:1.6;color:#1a1a1a">';
  const wrapClose = '</div>';
  const htmlBody =
    '<p style="margin:0 0 14px 0;text-align:justify">CÄƒn cá»© quy trÃ¬nh quáº£n lÃ½ nhiá»‡m vá»¥ khoa há»c vÃ  cÃ´ng nghá»‡ cáº¥p Viá»‡n; Há»‡ thá»‘ng quáº£n lÃ½ Ä‘á» tÃ i xin <strong>trÃ¢n trá»ng thÃ´ng bÃ¡o</strong> Ä‘á»ƒ QuÃ½ Ä‘á»“ng chÃ­ biáº¿t, chá»§ Ä‘á»™ng triá»ƒn khai cÃ¡c viá»‡c tiáº¿p theo theo tháº©m quyá»n:</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top;width:36%"><strong>Ná»™i dung thÃ´ng bÃ¡o</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top">' +
    'ÄÃ£ <strong>hoÃ n thÃ nh BÆ°á»›c 7 â€” KÃ½ há»£p Ä‘á»“ng thá»±c hiá»‡n</strong> (ghi nháº­n trÃªn há»‡ thá»‘ng Ä‘iá»‡n tá»­). <strong>PhÃ²ng Khoa há»c vÃ  CÃ´ng nghá»‡</strong> Ä‘Ã£ lÆ°u <strong>Há»£p Ä‘á»“ng KHCN</strong> (báº£n Ä‘iá»‡n tá»­) vÃ o há»“ sÆ¡.' +
    '</td></tr><tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>TÃªn Ä‘á» tÃ i</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">' + t + '</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Há»“ sÆ¡ Ä‘Ã­nh kÃ¨m</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">Báº£n <strong>Há»£p Ä‘á»“ng KHCN</strong> Ä‘Ã£ Ä‘Æ°á»£c lÆ°u trong há»“ sÆ¡ Ä‘iá»‡n tá»­; QuÃ½ Ä‘á»“ng chÃ­ Ä‘Äƒng nháº­p há»‡ thá»‘ng Ä‘á»ƒ tra cá»©u, táº£i vá» khi cáº§n.</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>Viá»‡c tiáº¿p theo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">CÃ¡c bÆ°á»›c tiáº¿p theo theo quy trÃ¬nh (vÃ­ dá»¥ <strong>BÆ°á»›c 8 â€” ÄÄƒng kÃ½ Ä‘áº¡o Ä‘á»©c</strong> vÃ  triá»ƒn khai thá»±c hiá»‡n). Äá» nghá»‹ <strong>Chá»§ nhiá»‡m</strong> vÃ  cÃ¡c Ä‘Æ¡n vá»‹ liÃªn quan tiáº¿p tá»¥c phá»‘i há»£p vá»›i <strong>PhÃ²ng KHCN</strong>; <strong>Há»™i Ä‘á»“ng KHCN Viá»‡n</strong> tiáº¿p tá»¥c theo dÃµi khi cáº§n.</td></tr></table>' +
    '<p style="margin:14px 0 8px 0"><strong>ÄÆ°á»ng link theo dÃµi tiáº¿n trÃ¬nh:</strong> <a href="' + timelineUrl + '" style="color:#0d47a1">' + timelineUrl + '</a></p>' +
    '<p style="margin:16px 0 0 0;text-align:justify;font-size:13px;color:#455a64"><em>VÄƒn báº£n Ä‘Æ°á»£c gá»­i tá»± Ä‘á»™ng tá»« Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n nháº±m phá»¥c vá»¥ cÃ´ng tÃ¡c hÃ nh chÃ­nh vÃ  lÆ°u váº¿t trao Ä‘á»•i.</em></p>' +
    '<p style="margin:20px 0 0 0"><strong>TrÃ¢n trá»ng thÃ´ng bÃ¡o.</strong></p>';
  const salutationCn = '<p style="margin:0 0 6px 0"><strong>KÃ­nh gá»­i QuÃ½ Chá»§ nhiá»‡m' + (researcherName ? ' ' + capVienEmailEsc(researcherName) : '') + ',</strong></p>' +
    '<p style="margin:0 0 12px 0">cc QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n.</p>';
  const salutationHdOnly = '<p style="margin:0 0 12px 0"><strong>KÃ­nh gá»­i QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n,</strong></p>';
  const htmlForChuNhiem = wrapOpen + salutationCn + htmlBody + wrapClose;
  const htmlForHdOnly = wrapOpen + salutationHdOnly + htmlBody + wrapClose;
  const text =
    'THÃ”NG BÃO HÃ€NH CHÃNH â€” HoÃ n thÃ nh BÆ°á»›c 7 (KÃ½ há»£p Ä‘á»“ng KHCN).\n' +
    'KÃ­nh gá»­i QuÃ½ Chá»§ nhiá»‡m' + (researcherName ? ' ' + String(researcherName).trim() : '') + ',\n' +
    'cc QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n.\n\n' +
    'Äá» tÃ i: ' + (submissionTitle || '') + '\n' +
    'Ná»™i dung: ÄÃ£ hoÃ n thÃ nh BÆ°á»›c 7; Há»£p Ä‘á»“ng KHCN Ä‘Ã£ lÆ°u trong há»“ sÆ¡ Ä‘iá»‡n tá»­.\n' +
    'Xem tiáº¿n trÃ¬nh: ' + timelineUrl;

  const rEmail = String(researcherEmail || '').trim().toLowerCase();
  if (!rEmail) {
    console.warn('[Email] BÆ°á»›c 7 hoÃ n thÃ nh: khÃ´ng cÃ³ email Chá»§ nhiá»‡m, chá»‰ gá»­i Há»™i Ä‘á»“ng náº¿u cÃ³.');
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
    }).catch(err => console.error('[Email] BÆ°á»›c 7 hoÃ n thÃ nh â†’ CN+CC:', err.message)));
  } else if (ccList.length > 0) {
    const textHd =
      'THÃ”NG BÃO HÃ€NH CHÃNH â€” HoÃ n thÃ nh BÆ°á»›c 7 (KÃ½ há»£p Ä‘á»“ng KHCN).\n' +
      'KÃ­nh gá»­i QuÃ½ tháº§y cÃ´ thÃ nh viÃªn Há»™i Ä‘á»“ng Khoa há»c Viá»‡n.\n\n' +
      'Äá» tÃ i: ' + (submissionTitle || '') + '\n' +
      'Xem tiáº¿n trÃ¬nh: ' + timelineUrl;
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: ccList.join(', '),
      subject,
      text: textHd + '\n\n(KhÃ´ng xÃ¡c Ä‘á»‹nh Ä‘Æ°á»£c email Chá»§ nhiá»‡m â€” chá»‰ gá»­i Há»™i Ä‘á»“ng.)',
      html: '<p><em>(KhÃ´ng xÃ¡c Ä‘á»‹nh Ä‘Æ°á»£c email Chá»§ nhiá»‡m â€” gá»­i danh sÃ¡ch Há»™i Ä‘á»“ng nháº­n TO.)</em></p>' + htmlForHdOnly
    }).catch(err => console.error('[Email] BÆ°á»›c 7 hoÃ n thÃ nh â†’ HÄ only:', err.message)));
  }
  return Promise.all(promises);
}

// Cáº­p nháº­t thÃ´ng tin há»p / biÃªn báº£n / tÃ i liá»‡u kÃ¨m (thÃ´ng bÃ¡o chung)
function sendCapVienStep5SecretaryActivityEmail(opts) {
  const { submissionTitle, submissionId, subjectLine, bodyHtml, bodyText, councilList, researcherEmail } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const suffix = '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃµi tiáº¿n trÃ¬nh BÆ°á»›c 5</a></p><p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng Quáº£n lÃ½ Äá» tÃ i cáº¥p Viá»‡n</p></div>';
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' + bodyHtml + suffix;
  const text = (bodyText || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: subjectLine, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 hoáº¡t Ä‘á»™ng ThÆ° kÃ½ â†’ HÄ:', err.message)));
  }
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject: '[Chá»§ nhiá»‡m] ' + subjectLine, text, html })
      .catch(err => console.error('[Email] BÆ°á»›c 5 hoáº¡t Ä‘á»™ng â†’ CN:', err.message)));
  }
  return Promise.all(promises);
}

function sendStage3ResultEmail(submissionTitle, submittedByEmail, decision, comment, reviewerName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const decisionLabels = { pass: 'Há»£p lá»‡ (chuyá»ƒn GÄ4)', reject: 'KhÃ´ng cháº¥p thuáº­n', need_supplement: 'YÃªu cáº§u bá»• sung há»“ sÆ¡', need_revision: 'YÃªu cáº§u sá»­a há»“ sÆ¡' };
  const label = decisionLabels[decision] || decision;
  const commentBlock = comment ? '<p><strong>Nháº­n xÃ©t / YÃªu cáº§u:</strong></p><p>' + String(comment).replace(/\n/g, '<br>') + '</p>' : '';
  const needRevisionNote = (decision === 'need_supplement' || decision === 'need_revision')
    ? '<p><strong>Báº¡n cáº§n chá»‰nh sá»­a vÃ  bá»• sung há»“ sÆ¡ theo nháº­n xÃ©t trÃªn, sau Ä‘Ã³ ná»™p láº¡i táº¡i má»¥c <a href="' + baseUrl + '/ho-so-cua-toi.html">Há»“ sÆ¡ cá»§a tÃ´i</a>.</strong></p>'
    : '';
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Káº¿t quáº£ kiá»ƒm tra há»“ sÆ¡ (GÄ3) táº¡i Há»‡ thá»‘ng SCI-ACE.</p>' +
    '<p><strong>Há»“ sÆ¡:</strong> ' + submissionTitle + '</p>' +
    '<p><strong>NgÆ°á»i ná»™p:</strong> ' + submittedByEmail + '</p>' +
    '<p><strong>Káº¿t quáº£:</strong> ' + label + '</p>' +
    (reviewerName ? '<p><strong>NgÆ°á»i kiá»ƒm tra:</strong> ' + reviewerName + '</p>' : '') +
    commentBlock +
    needRevisionNote +
    '<p>Vui lÃ²ng Ä‘Äƒng nháº­p <a href="' + baseUrl + '/hoi-dong.html">Khu vá»±c Há»™i Ä‘á»“ng</a> hoáº·c <a href="' + baseUrl + '/ho-so-cua-toi.html">Há»“ sÆ¡ cá»§a tÃ´i</a> Ä‘á»ƒ xem chi tiáº¿t.</p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p></div>';
  const needRevisionText = (decision === 'need_supplement' || decision === 'need_revision')
    ? '\n\nBáº¡n cáº§n chá»‰nh sá»­a vÃ  bá»• sung há»“ sÆ¡ theo nháº­n xÃ©t trÃªn, sau Ä‘Ã³ ná»™p láº¡i táº¡i Há»“ sÆ¡ cá»§a tÃ´i.'
    : '';
  const text = 'Káº¿t quáº£ kiá»ƒm tra há»“ sÆ¡ (GÄ3): ' + submissionTitle + '\nKáº¿t quáº£: ' + label + (comment ? '\nNháº­n xÃ©t: ' + comment : '') + needRevisionText + '\n\n' + baseUrl;
  const promises = [];
  if (transporter) {
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: submittedByEmail,
      subject: '[SCI-ACE] Káº¿t quáº£ kiá»ƒm tra há»“ sÆ¡: ' + submissionTitle,
      text,
      html
    }).catch(err => console.error('Email to researcher:', err.message)));
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] ThÆ° kÃ½ Ä‘Ã£ xá»­ lÃ½ GÄ3 â€“ Há»“ sÆ¡: ' + submissionTitle,
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
  const noteBlock = note ? '<p><strong>Ghi chÃº:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
  const htmlAll = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Chá»§ tá»‹ch Há»™i Ä‘á»“ng <strong>' + (chairmanName || 'Chá»§ tá»‹ch') + '</strong> Ä‘Ã£ phÃ¢n cÃ´ng pháº£n biá»‡n cho há»“ sÆ¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p><strong>Pháº£n biá»‡n Ä‘Æ°á»£c phÃ¢n cÃ´ng:</strong> ' + reviewersList + '</p>' +
    noteBlock +
    '<p>Giai Ä‘oáº¡n Ä‘Ã£ chuyá»ƒn sang <strong>GÄ5 â€“ ÄÃ¡nh giÃ¡ pháº£n biá»‡n</strong>. CÃ¡c thÃ nh viÃªn Ä‘Æ°á»£c phÃ¢n cÃ´ng cáº§n upload phiáº¿u Ä‘Ã¡nh giÃ¡ (SCI-ACE-PÄG).</p>' +
    '<p>Vui lÃ²ng Ä‘Äƒng nháº­p <a href="' + baseUrl + '/hoi-dong.html">Khu vá»±c Há»™i Ä‘á»“ng</a> hoáº·c <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dÃµi tiáº¿n trÃ¬nh</a> Ä‘á»ƒ xem chi tiáº¿t.</p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p></div>';
  const textAll = 'Chá»§ tá»‹ch Ä‘Ã£ phÃ¢n cÃ´ng pháº£n biá»‡n cho há»“ sÆ¡: ' + submissionTitle + '. Pháº£n biá»‡n: ' + reviewersList + '. Giai Ä‘oáº¡n chuyá»ƒn sang GÄ5. ' + baseUrl;
  const promises = [];
  if (transporter) {
    reviewerEmails.forEach((email, i) => {
      const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
      const htmlYou = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
        '<p>KÃ­nh gá»­i ' + (name || email) + ',</p>' +
        '<p>Chá»§ tá»‹ch Há»™i Ä‘á»“ng <strong>' + (chairmanName || 'Chá»§ tá»‹ch') + '</strong> Ä‘Ã£ phÃ¢n cÃ´ng <strong>báº¡n</strong> lÃ m pháº£n biá»‡n cho há»“ sÆ¡: <strong>' + submissionTitle + '</strong>.</p>' +
        noteBlock +
        '<p>Báº¡n vui lÃ²ng Ä‘Äƒng nháº­p vÃ  thá»±c hiá»‡n Ä‘Ã¡nh giÃ¡ (GÄ5), upload phiáº¿u Ä‘Ã¡nh giÃ¡ SCI-ACE-PÄG theo quy Ä‘á»‹nh.</p>' +
        '<p><a href="' + baseUrl + '/hoi-dong.html">Khu vá»±c Há»™i Ä‘á»“ng</a> | <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dÃµi tiáº¿n trÃ¬nh</a></p>' +
        '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p></div>';
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: email,
        subject: '[SCI-ACE] Báº¡n Ä‘Æ°á»£c phÃ¢n cÃ´ng pháº£n biá»‡n: ' + submissionTitle,
        text: 'Báº¡n Ä‘Æ°á»£c phÃ¢n cÃ´ng pháº£n biá»‡n há»“ sÆ¡: ' + submissionTitle + '. ' + baseUrl,
        html: htmlYou
      }).catch(err => console.error('Email to reviewer:', err.message)));
    });
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] Chá»§ tá»‹ch Ä‘Ã£ phÃ¢n cÃ´ng pháº£n biá»‡n (GÄ4) â€“ Há»“ sÆ¡: ' + submissionTitle,
        text: textAll,
        html: htmlAll
      }).catch(err => console.error('Email to council GÄ4:', err.message)));
    }
  }
  return Promise.all(promises);
}

function sendDecisionIssuedEmail(submissionTitle, submittedByEmail, trackUrl) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const url = trackUrl || baseUrl + '/theo-doi-ho-so.html';
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>ThÆ° kÃ½ Há»™i Ä‘á»“ng Ä‘Ã£ cáº¥p Quyáº¿t Ä‘á»‹nh (SCI-ACE-QÄ) cho há»“ sÆ¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>Quyáº¿t Ä‘á»‹nh cÃ³ báº£n tiáº¿ng Viá»‡t vÃ  tiáº¿ng Anh. Vui lÃ²ng Ä‘Äƒng nháº­p Ä‘á»ƒ táº£i vá».</p>' +
    '<p><a href="' + url + '">Xem chi tiáº¿t vÃ  táº£i Quyáº¿t Ä‘á»‹nh</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p></div>';
  const text = 'ÄÃ£ cáº¥p Quyáº¿t Ä‘á»‹nh cho há»“ sÆ¡: ' + submissionTitle + '. Vui lÃ²ng Ä‘Äƒng nháº­p Ä‘á»ƒ táº£i: ' + url;
  const promises = [];
  if (transporter) {
    if (submittedByEmail) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: submittedByEmail,
        subject: '[SCI-ACE] ÄÃ£ cáº¥p Quyáº¿t Ä‘á»‹nh â€“ Há»“ sÆ¡: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email decision to NCV:', err.message)));
    }
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] ÄÃ£ cáº¥p Quyáº¿t Ä‘á»‹nh â€“ Há»“ sÆ¡: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email decision to council:', err.message)));
    }
  }
  return Promise.all(promises);
}

// GÄ5 (Há»p Há»™i Ä‘á»“ng): ThÃ´ng bÃ¡o káº¿t quáº£ há»p cho nghiÃªn cá»©u viÃªn vÃ  toÃ n thá»ƒ Há»™i Ä‘á»“ng
function sendMeetingResultEmail(submissionTitle, submittedByEmail, decision, note, secretaryName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const decisionLabels = { approved: 'Cháº¥p thuáº­n', conditional: 'Cháº¥p thuáº­n cÃ³ Ä‘iá»u kiá»‡n', rejected: 'KhÃ´ng cháº¥p thuáº­n' };
  const label = decisionLabels[decision] || decision;
  const noteBlock = note ? '<p><strong>Ghi chÃº:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
  const nextStep = decision === 'rejected'
    ? 'Quy trÃ¬nh xÃ©t duyá»‡t káº¿t thÃºc táº¡i Ä‘Ã¢y.'
    : (decision === 'approved' ? 'Há»“ sÆ¡ chuyá»ƒn sang giai Ä‘oáº¡n Cáº¥p Quyáº¿t Ä‘á»‹nh (SCI-ACE-QÄ).' : 'NghiÃªn cá»©u viÃªn cáº§n ná»™p báº£n giáº£i trÃ¬nh SCI-ACE-04, sau Ä‘Ã³ Chá»§ tá»‹ch Há»™i Ä‘á»“ng xem xÃ©t thÃ´ng qua.');
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Káº¿t quáº£ há»p Há»™i Ä‘á»“ng (GÄ5) táº¡i Há»‡ thá»‘ng SCI-ACE.</p>' +
    '<p><strong>Há»“ sÆ¡:</strong> ' + submissionTitle + '</p>' +
    '<p><strong>Káº¿t luáº­n Há»™i Ä‘á»“ng:</strong> ' + label + '</p>' +
    (secretaryName ? '<p><strong>NgÆ°á»i ghi nháº­n:</strong> ' + secretaryName + '</p>' : '') +
    noteBlock +
    '<p><strong>BÆ°á»›c tiáº¿p theo:</strong> ' + nextStep + '</p>' +
    '<p>Vui lÃ²ng Ä‘Äƒng nháº­p <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dÃµi tiáº¿n trÃ¬nh</a> hoáº·c <a href="' + baseUrl + '/hoi-dong.html">Khu vá»±c Há»™i Ä‘á»“ng</a> Ä‘á»ƒ xem chi tiáº¿t.</p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p></div>';
  const text = 'Káº¿t quáº£ há»p Há»™i Ä‘á»“ng (GÄ5): ' + submissionTitle + '\nKáº¿t luáº­n: ' + label + '\n' + nextStep + (note ? '\nGhi chÃº: ' + note : '') + '\n\n' + baseUrl;
  const promises = [];
  if (transporter) {
    if (submittedByEmail) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: submittedByEmail,
        subject: '[SCI-ACE] Káº¿t quáº£ há»p Há»™i Ä‘á»“ng â€“ Há»“ sÆ¡: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email meeting result to researcher:', err.message)));
    }
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] ThÆ° kÃ½ Ä‘Ã£ ghi nháº­n káº¿t quáº£ há»p (GÄ5) â€“ Há»“ sÆ¡: ' + submissionTitle,
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
    '<p>NghiÃªn cá»©u viÃªn <strong>' + (submittedByName || 'NCV') + '</strong> Ä‘Ã£ ná»™p báº£n giáº£i trÃ¬nh SCI-ACE-04 cho há»“ sÆ¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>Chá»§ tá»‹ch Há»™i Ä‘á»“ng vÃ  cÃ¡c thÃ nh viÃªn vui lÃ²ng Ä‘Äƒng nháº­p Ä‘á»ƒ táº£i file vÃ  xem xÃ©t. Sau Ä‘Ã³ Chá»§ tá»‹ch sáº½ quyáº¿t Ä‘á»‹nh ThÃ´ng qua hoáº·c KhÃ´ng thÃ´ng qua.</p>' +
    '<p><a href="' + trackUrl + '">Xem chi tiáº¿t vÃ  táº£i file giáº£i trÃ¬nh</a></p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p></div>';
  const text = 'NCV Ä‘Ã£ ná»™p SCI-ACE-04 cho há»“ sÆ¡: ' + submissionTitle + '. Vui lÃ²ng Ä‘Äƒng nháº­p Ä‘á»ƒ xem xÃ©t: ' + trackUrl;
  const councilList = getNotificationEmails();
  if (!transporter || councilList.length === 0) return Promise.resolve();
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: councilList.join(', '),
    subject: '[SCI-ACE] NCV Ä‘Ã£ ná»™p báº£n giáº£i trÃ¬nh SCI-ACE-04 â€“ Há»“ sÆ¡: ' + submissionTitle,
    text,
    html
  }).catch(err => console.error('Email conditional submit to council:', err.message));
}

function sendConditionalRejectEmail(submissionTitle, submittedByEmail, chairmanName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>Chá»§ tá»‹ch Há»™i Ä‘á»“ng <strong>' + (chairmanName || 'Chá»§ tá»‹ch') + '</strong> chÆ°a thÃ´ng qua báº£n giáº£i trÃ¬nh SCI-ACE-04 cho há»“ sÆ¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>NghiÃªn cá»©u viÃªn vui lÃ²ng ná»™p láº¡i tÃ i liá»‡u giáº£i trÃ¬nh (SCI-ACE-04) theo yÃªu cáº§u. Sau khi ná»™p, Chá»§ tá»‹ch Há»™i Ä‘á»“ng sáº½ xem xÃ©t láº¡i.</p>' +
    '<p>Vui lÃ²ng Ä‘Äƒng nháº­p <a href="' + baseUrl + '/hoi-dong.html">Khu vá»±c Há»™i Ä‘á»“ng</a> hoáº·c <a href="' + baseUrl + '/ho-so-cua-toi.html">Há»“ sÆ¡ cá»§a tÃ´i</a> Ä‘á»ƒ xem chi tiáº¿t.</p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p></div>';
  const text = 'Chá»§ tá»‹ch chÆ°a thÃ´ng qua báº£n giáº£i trÃ¬nh SCI-ACE-04. NCV cáº§n ná»™p láº¡i. Há»“ sÆ¡: ' + submissionTitle + '. ' + baseUrl;
  const promises = [];
  if (transporter) {
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: submittedByEmail,
      subject: '[SCI-ACE] ChÆ°a thÃ´ng qua báº£n giáº£i trÃ¬nh â€“ Há»“ sÆ¡: ' + submissionTitle,
      text,
      html
    }).catch(err => console.error('Email to NCV conditional reject:', err.message)));
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] Chá»§ tá»‹ch chÆ°a thÃ´ng qua báº£n giáº£i trÃ¬nh â€“ Há»“ sÆ¡: ' + submissionTitle,
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
    subject: '[SCI-ACE] Äáº·t láº¡i máº­t kháº©u',
    text: 'Báº¡n Ä‘Ã£ yÃªu cáº§u Ä‘áº·t láº¡i máº­t kháº©u. Má»Ÿ link sau trong 1 giá» Ä‘á»ƒ Ä‘áº·t máº­t kháº©u má»›i: ' + resetUrl,
    html: '<p>Báº¡n Ä‘Ã£ yÃªu cáº§u Ä‘áº·t láº¡i máº­t kháº©u.</p><p>Nháº¥n vÃ o link sau Ä‘á»ƒ Ä‘áº·t máº­t kháº©u má»›i (link cÃ³ hiá»‡u lá»±c trong <strong>1 giá»</strong>):</p><p><a href="' + resetUrl + '">' + resetUrl + '</a></p><p>Náº¿u báº¡n khÃ´ng yÃªu cáº§u, hÃ£y bá» qua email nÃ y.</p>'
  }).catch(err => console.error('Email reset error:', err.message));
}

const ROLE_LABELS = { chu_tich: 'Chá»§ tá»‹ch', thu_ky: 'ThÆ° kÃ½', thanh_vien: 'ThÃ nh viÃªn Há»™i Ä‘á»“ng', researcher: 'NghiÃªn cá»©u viÃªn', admin: 'Admin', phong_khcn: 'PhÃ²ng KHCN&QHÄN', vien_truong: 'Viá»‡n trÆ°á»Ÿng', totruong_tham_dinh_tc: 'Tá»• trÆ°á»Ÿng Tá»• tháº©m Ä‘á»‹nh TC', thanh_vien_tham_dinh_tc: 'ThÃ nh viÃªn Tá»• tháº©m Ä‘á»‹nh TC' };

function sendRoleAssignmentEmail(toEmail, fullname, role, tempPassword) {
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const loginUrl = baseUrl + '/dang-nhap.html';
  const roleLabel = ROLE_LABELS[role] || role;
  const greeting = fullname ? 'KÃ­nh gá»­i ' + fullname + ',' : 'KÃ­nh gá»­i,';
  let passwordBlock = '';
  if (tempPassword) {
    passwordBlock = '<p><strong>Máº­t kháº©u táº¡m Ä‘á»ƒ Ä‘Äƒng nháº­p láº§n Ä‘áº§u:</strong> <code style="background:#f0f0f0;padding:4px 8px;">' + tempPassword + '</code></p><p>Báº¡n nÃªn Ä‘á»•i máº­t kháº©u sau khi Ä‘Äƒng nháº­p (dÃ¹ng chá»©c nÄƒng <strong>QuÃªn máº­t kháº©u</strong> trÃªn trang Ä‘Äƒng nháº­p náº¿u cáº§n Ä‘áº·t láº¡i).</p>';
  } else {
    passwordBlock = '<p>Náº¿u báº¡n chÆ°a cÃ³ máº­t kháº©u hoáº·c quÃªn máº­t kháº©u, vui lÃ²ng dÃ¹ng chá»©c nÄƒng <strong>QuÃªn máº­t kháº©u</strong> trÃªn trang Ä‘Äƒng nháº­p.</p>';
  }
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>' + greeting + '</p>' +
    '<p>Báº¡n Ä‘Ã£ Ä‘Æ°á»£c cáº¥p vai trÃ² <strong>' + roleLabel + '</strong> trong Há»‡ thá»‘ng Há»“ sÆ¡ Äáº¡o Ä‘á»©c NghiÃªn cá»©u Äá»™ng váº­t (SCI-ACE), Viá»‡n Táº¿ bÃ o gá»‘c, TrÆ°á»ng Äáº¡i há»c Khoa há»c Tá»± nhiÃªn, ÄHQG-HCM.</p>' +
    '<p><strong>ThÃ´ng tin Ä‘Äƒng nháº­p:</strong></p>' +
    '<p>â€¢ Email: ' + toEmail + '</p>' +
    passwordBlock +
    '<p><strong>Link Ä‘Äƒng nháº­p:</strong> <a href="' + loginUrl + '">' + loginUrl + '</a></p>' +
    '<p>Sau khi Ä‘Äƒng nháº­p, thÃ nh viÃªn Há»™i Ä‘á»“ng cÃ³ thá»ƒ vÃ o <strong>Khu vá»±c Há»™i Ä‘á»“ng</strong> Ä‘á»ƒ xem vÃ  táº£i há»“ sÆ¡ nghiÃªn cá»©u viÃªn Ä‘Ã£ ná»™p.</p>' +
    '<p>TrÃ¢n trá»ng,<br>Há»‡ thá»‘ng SCI-ACE</p>' +
    '</div>';
  const text = greeting + '\n\nBáº¡n Ä‘Ã£ Ä‘Æ°á»£c cáº¥p vai trÃ² ' + roleLabel + ' trong Há»‡ thá»‘ng SCI-ACE.\n\nThÃ´ng tin Ä‘Äƒng nháº­p:\nâ€¢ Email: ' + toEmail + '\n' + (tempPassword ? 'â€¢ Máº­t kháº©u táº¡m: ' + tempPassword + '\n' : '') + '\nLink Ä‘Äƒng nháº­p: ' + loginUrl + '\n\nTrÃ¢n trá»ng,\nHá»‡ thá»‘ng SCI-ACE';
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toEmail,
    subject: '[SCI-ACE] Báº¡n Ä‘Ã£ Ä‘Æ°á»£c cáº¥p vai trÃ² trong Há»™i Ä‘á»“ng Äáº¡o Ä‘á»©c',
    text,
    html
  }).catch(err => console.error('Email role assignment error:', err.message));
}

/** Chuáº©n hoÃ¡ origin cho so khá»›p (scheme + host + port, khÃ´ng path). */
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
    '[FATAL] Production: danh sÃ¡ch CORS rá»—ng. Äáº·t BASE_URL vÃ /hoáº·c CORS_ORIGINS (cÃ¡c origin cÃ¡ch nhau báº±ng dáº¥u pháº©y, vÃ­ dá»¥ https://app.example.com,https://admin.example.com).'
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

// Middleware (static Ä‘áº·t sau API Ä‘á»ƒ /api/* luÃ´n do API xá»­ lÃ½)
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
// BibTeX lá»›n (JSON) cáº§n > 100kb máº·c Ä‘á»‹nh cá»§a Express â€” khÃ´ng liÃªn quan giá»›i háº¡n file cá»§a multer (multipart).
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

/** JWT tá»« Authorization: Bearer, cookie HttpOnly, hoáº·c ?token= (EventSource khÃ´ng gá»­i header). */
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

/** Ghi nháº­t kÃ½ hoáº¡t Ä‘á»™ng (Ä‘Äƒng nháº­p, truy cáº­p trang, v.v.). KhÃ´ng throw. */
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

// Vai trÃ² HÄKHCN (chu_tich/thu_ky/thanh_vien/totruong_tham_dinh_tc/thanh_vien_tham_dinh_tc) vÃ  PhÃ²ng
// KHCN (phong_khcn) cÃ³ thá»ƒ Ä‘Æ°á»£c cáº¥p THÃŠM cho má»™t user qua báº£ng council_role_grants, tÃ¡ch biá»‡t khá»i
// users.role (vai trÃ² há»‡ thá»‘ng, vd vien_truong/admin) â€” Ä‘á»ƒ 1 ngÆ°á»i vá»«a giá»¯ vai trÃ² há»‡ thá»‘ng khÃ¡c vá»«a
// kiÃªm nhiá»‡m HÄKHCN/PhÃ²ng KHCN mÃ  khÃ´ng bá»‹ ghi Ä‘Ã¨ máº¥t vai trÃ² nÃ o. Xem module-hoi-dong-khcn admin panel.
const COUNCIL_ROLE_TOKENS = ['chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc', 'phong_khcn'];

// Vai trÃ² Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh â€” cÃ¹ng má»©c báº£o vá»‡ "chá»‰ Master Admin" nhÆ° vai trÃ² HÄKHCN
// (councilRoles) á»Ÿ cÃ¡c route cáº¥p/sá»­a/xÃ³a vai trÃ² bÃªn dÆ°á»›i.
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

/** Set cÃ¡c role "hiá»‡u lá»±c" cá»§a 1 user object {id, role}: role há»‡ thá»‘ng + má»i council_role_grants. */
function userEffectiveRoleSet(user) {
  if (!user) return new Set();
  const base = String(user.role || '').trim().toLowerCase();
  const set = new Set(base ? [base] : []);
  getCouncilRoleGrants(user.id).forEach((r) => set.add(r));
  return set;
}

/** NhÆ° trÃªn nhÆ°ng nháº­n req (req.user) â€” cache trÃªn req Ä‘á»ƒ khá»i query láº¡i nhiá»u láº§n / request. */
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

/** email cá»§a má»i user cÃ³ 1 trong cÃ¡c role (role há»‡ thá»‘ng HOáº¶C council_role_grants), khÃ´ng trÃ¹ng láº·p. */
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

/** id/email/fullname/role cá»§a má»i user cÃ³ 1 trong cÃ¡c role (role há»‡ thá»‘ng HOáº¶C council_role_grants). */
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
    return res.status(401).json({ message: 'ChÆ°a Ä‘Äƒng nháº­p' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (userIdIsBanned(payload.id)) {
      return res.status(403).json({ message: 'TÃ i khoáº£n Ä‘Ã£ bá»‹ khÃ³a. Vui lÃ²ng liÃªn há»‡ quáº£n trá»‹ viÃªn.' });
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
      /* giá»¯ payload JWT náº¿u DB lá»—i */
    }
    req.user = reqUser;
    // vai trÃ² chá»‰ dÃ¹ng má»™t sá»‘ module (crd_user, sinh_vien): xem services/vaiTroHanChe.js; kiá»ƒm cáº£ vai trÃ² trong token láº«n trong DB
    const p = (req.originalUrl || req.url || '').split('?')[0];
    const loiVaiTro = vaiTroHanChe.kiemTraApi(payload.role, p) || vaiTroHanChe.kiemTraApi(reqUser.role, p);
    if (loiVaiTro) return res.status(403).json({ message: loiVaiTro });
    next();
  } catch (e) {
    return res.status(401).json({ message: 'PhiÃªn Ä‘Äƒng nháº­p háº¿t háº¡n' });
  }
}

/** JWT tuá»³ chá»n â€” khÃ´ng cÃ³ token thÃ¬ req.user = null (dÃ¹ng cho cháº¿ Ä‘á»™ public / kiá»ƒm tra quyá»n). */
function optionalAuthMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (userIdIsBanned(payload.id)) {
      return res.status(403).json({ message: 'TÃ i khoáº£n Ä‘Ã£ bá»‹ khÃ³a. Vui lÃ²ng liÃªn há»‡ quáº£n trá»‹ viÃªn.' });
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

/** GET .../dashboard-perms/:id/check dÃ¹ng optional auth (public analytics cÃ³ thá»ƒ khÃ´ng cáº§n Ä‘Äƒng nháº­p). */
function authUnlessDashboardPermCheck(req, res, next) {
  if (req.method === 'GET' && /^\/[^/]+\/check\/?$/.test(req.path || '')) {
    return optionalAuthMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}

function thuyKyOrAdmin(req, res, next) {
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ ThÆ° kÃ½ Há»™i Ä‘á»“ng hoáº·c Admin má»›i cÃ³ quyá»n nÃ y' });
  }
  next();
}

function chuTichOrAdmin(req, res, next) {
  if (!roleIsAny(req, ['admin', 'chu_tich'])) {
    return res.status(403).json({ message: 'Chá»‰ Chá»§ tá»‹ch Há»™i Ä‘á»“ng KHCN hoáº·c Admin má»›i cÃ³ quyá»n nÃ y' });
  }
  next();
}

function adminOnly(req, res, next) {
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chá»‰ Admin má»›i cÃ³ quyá»n nÃ y' });
  }
  next();
}

function userEmailIsMasterAdmin(email) {
  return (email || '').trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

/**
 * Master Admin = email trÃ¹ng ADMIN_EMAIL (háº±ng sá»‘ / cáº¥u hÃ¬nh triá»ƒn khai).
 * KhÃ´ng báº¯t buá»™c role === 'admin' trong JWT/DB: trÃ¡nh máº¥t toÃ n bá»™ quyá»n Master
 * (module Thiáº¿t bá»‹, cáº¥p Admin, â€¦) khi tÃ i khoáº£n Ä‘á»•i vai trÃ² hoáº·c dá»¯ liá»‡u role lá»‡ch.
 */
function reqIsMasterAdmin(req) {
  if (!req || !req.user) return false;
  return userEmailIsMasterAdmin(req.user.email);
}

function masterAdminOnly(req, res, next) {
  if (!reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c thá»±c hiá»‡n thao tÃ¡c nÃ y.' });
  }
  next();
}

/** Admin (role) hoáº·c Master Admin (email) â€” dÃ¹ng cho tÃ¬m user, phÃ¢n quyá»n dashboard, v.v. */
function adminOrMasterAdminApi(req, res, next) {
  if ((req.user.role || '').toLowerCase() === 'admin') return next();
  if (reqIsMasterAdmin(req)) return next();
  return res.status(403).json({ ok: false, success: false, error: 'Chá»‰ Admin hoáº·c Master Admin má»›i cÃ³ quyá»n nÃ y' });
}

function adminOrPhongKhcn(req, res, next) {
  if (!roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i cÃ³ quyá»n nÃ y' });
  }
  next();
}

/** Chá»‰ Admin hoáº·c PhÃ²ng KHCN â€” dÃ¹ng cho sá»­a Ä‘á» tÃ i trÃªn dashboard (khÃ´ng gá»“m thÆ° kÃ½). */
function adminOrPhongKhcnMissionEditor(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'phong_khcn') {
    return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c cáº­p nháº­t Ä‘á» tÃ i qua giao diá»‡n nÃ y.' });
  }
  next();
}

/** Chuá»—i tráº¡ng thÃ¡i tá»± do (khÃ´ng thuá»™c mÃ£ enum): bá» kÃ½ tá»± Ä‘iá»u khiá»ƒn / <>. */
function sanitizeMissionStatusFreeText(s) {
  const t = String(s || '')
    .trim()
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f<>]/g, '')
    .slice(0, 200);
  return t || null;
}

/** MÃ£ tráº¡ng thÃ¡i chuáº©n (dropdown). GiÃ¡ trá»‹ khÃ¡c cÃ³ thá»ƒ lÆ°u náº¿u lÃ  vÄƒn báº£n tá»± do (sau khi sanitize). */
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

/** Chuáº©n hÃ³a tÃªn Ä‘á»ƒ so khá»›p chá»§ nhiá»‡m (bá» há»c hÃ m viáº¿t táº¯t thÆ°á»ng gáº·p á»Ÿ Ä‘áº§u chuá»—i). */
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

/** So khá»›p trÆ°á»ng principal cá»§a missions vá»›i user Ä‘Äƒng nháº­p (fullname / email). */
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

/** Admin xem Ä‘Æ°á»£c má»i Ä‘á» tÃ i; user thÆ°á»ng chá»‰ Ä‘á» tÃ i mÃ¬nh lÃ  chá»§ nhiá»‡m (theo trÆ°á»ng principal). */
function canUserAccessMissionHoSoNgoai(req, missionRow) {
  if (!missionRow) return false;
  if (!req.user) return false;
  if ((req.user.role || '').toLowerCase() === 'admin') return true;
  return missionPrincipalMatchesUser(missionRow.principal, req.user);
}

/** Quyá»n xem chi tiáº¿t Ä‘á» tÃ i: nhÃ³m xá»­ lÃ½ nghiá»‡p vá»¥ + admin; user thÆ°á»ng chá»‰ xem Ä‘á» tÃ i mÃ¬nh phá»¥ trÃ¡ch. */
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

/** ÄÃ£ cÃ³ máº­t kháº©u Ä‘Äƒng nháº­p (Ä‘Ã£ kÃ­ch hoáº¡t). Cá»™t password cÃ³ thá»ƒ NOT NULL nÃªn dÃ¹ng '' lÃ m sentinel â€œchÆ°a kÃ­ch hoáº¡tâ€. */
function userHasLoginPassword(pw) {
  return pw != null && String(pw).trim().length > 0;
}

// ÄÄƒng kÃ½ (chá»‰ @sci.edu.vn) cÃ³ XÃC MINH email: gá»­i liÃªn káº¿t dÃ¹ng má»™t láº§n, máº­t kháº©u Ä‘áº·t SAU khi xÃ¡c minh. Xem routes/dangKy.js
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

// ÄÄƒng nháº­p
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof password !== 'string' || !password || password.length > 128) {
    return res.status(400).json({ message: 'Máº­t kháº©u khÃ´ng há»£p lá»‡' });
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
    return res.status(401).json({ message: 'Email hoáº·c máº­t kháº©u khÃ´ng Ä‘Ãºng' });
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
    return res.status(403).json({ message: 'TÃ i khoáº£n Ä‘Ã£ bá»‹ khÃ³a. Vui lÃ²ng liÃªn há»‡ quáº£n trá»‹ viÃªn.' });
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
        'TÃ i khoáº£n chÆ°a kÃ­ch hoáº¡t. Vui lÃ²ng má»Ÿ trang ÄÄƒng kÃ½, nháº­p cÃ¹ng email @sci.edu.vn vÃ  Ä‘áº·t máº­t kháº©u láº§n Ä‘áº§u.',
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
    return res.status(401).json({ message: 'Email hoáº·c máº­t kháº©u khÃ´ng Ä‘Ãºng' });
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
        /* token háº¿t háº¡n â€” khÃ´ng ghi logout */
      }
    }
  } catch (_) {}
  clearAuthCookie(res);
  return res.json({ ok: true });
});

// Client ghi nháº­n má»Ÿ trang / hÃ nh Ä‘á»™ng (Ä‘Ã£ Ä‘Äƒng nháº­p). Module CRD-only cÅ©ng Ä‘Æ°á»£c phÃ©p (whitelist API).
app.post('/api/activity/track', authMiddleware, (req, res) => {
  const b = req.body || {};
  const action = String(b.action || 'page_view').slice(0, 120);
  const moduleName = b.module != null ? String(b.module).slice(0, 120) : '';
  const pathStr = b.path != null ? String(b.path).slice(0, 500) : '';
  const detail = b.detail != null ? String(b.detail).slice(0, 2000) : null;
  if (!moduleName.trim() && !pathStr.trim()) {
    return res.status(400).json({ message: 'Cáº§n Ã­t nháº¥t module hoáº·c path' });
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

// ÄÄƒng kÃ½ cÃ´ng khai cho module CRD (1 endpoint) Ä‘Ã£ tÃ¡ch sang routes/crd/dangKyCongKhai.js.
// Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨.
app.use('/api', require('./routes/crd/dangKyCongKhai')({
  ALLOWED_EMAIL_DOMAIN,
  CRD_ONLY_USER_ROLE,
  bcrypt,
  db,
  jwt,
  JWT_SECRET,
  setAuthCookie, emailSinhVienDangCho: (em) => require('./services/nganHangTeBaoKhangTheSinhVien').emailDuocDangKy(db, em),
}));

/** email (chuáº©n hoÃ¡) â†’ thá»i Ä‘iá»ƒm gá»­i mail quÃªn máº­t kháº©u gáº§n nháº¥t â€” chá»‘ng email bomb SMTP */
const forgotPasswordLastSentByEmail = new Map();
const FORGOT_PASSWORD_COOLDOWN_MS = 60_000;

// QuÃªn máº­t kháº©u: gá»­i email chá»©a link Ä‘áº·t láº¡i (chá»‰ tÃ i khoáº£n tá»“n táº¡i, khÃ´ng tiáº¿t lá»™)
app.post('/api/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Vui lÃ²ng nháº­p email' });
  }
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!row) {
    return res.json({ message: 'Náº¿u email tá»“n táº¡i trong há»‡ thá»‘ng, báº¡n sáº½ nháº­n Ä‘Æ°á»£c hÆ°á»›ng dáº«n Ä‘áº·t láº¡i máº­t kháº©u qua email.' });
  }
  const now = Date.now();
  const last = forgotPasswordLastSentByEmail.get(email) || 0;
  if (now - last < FORGOT_PASSWORD_COOLDOWN_MS) {
    return res.status(429).json({ message: 'Vui lÃ²ng Ä‘á»£i 1 phÃºt trÆ°á»›c khi gá»­i láº¡i.' });
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
    return res.status(503).json({ message: 'KhÃ´ng gá»­i Ä‘Æ°á»£c email lÃºc nÃ y. Vui lÃ²ng thá»­ láº¡i sau.' });
  }
  return res.json({ message: 'Náº¿u email tá»“n táº¡i trong há»‡ thá»‘ng, báº¡n sáº½ nháº­n Ä‘Æ°á»£c hÆ°á»›ng dáº«n Ä‘áº·t láº¡i máº­t kháº©u qua email.' });
});

// Äáº·t láº¡i máº­t kháº©u (sau khi nháº¥n link trong email)
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ message: 'Link khÃ´ng há»£p lá»‡ hoáº·c máº­t kháº©u má»›i Ã­t nháº¥t 6 kÃ½ tá»±' });
  }
  const row = db.prepare("SELECT email FROM password_reset_tokens WHERE token = ? AND datetime(expiresAt) > datetime('now')").get(token);
  if (!row) {
    return res.status(400).json({ message: 'Link Ä‘Ã£ háº¿t háº¡n hoáº·c khÃ´ng há»£p lá»‡. Vui lÃ²ng yÃªu cáº§u quÃªn máº­t kháº©u láº¡i.' });
  }
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, row.email);
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
  return res.json({ message: 'ÄÃ£ Ä‘áº·t láº¡i máº­t kháº©u thÃ nh cÃ´ng. Báº¡n cÃ³ thá»ƒ Ä‘Äƒng nháº­p báº±ng máº­t kháº©u má»›i.' });
});

// Há»“ sÆ¡ SCI-ACE â€” nhÃ³m cÆ¡ báº£n (4 endpoint: ná»™p, danh sÃ¡ch, danh sÃ¡ch Há»™i Ä‘á»“ng, chi tiáº¿t) Ä‘Ã£ tÃ¡ch sang routes/submissions/hoSoCoBan.js.
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

// Há»“ sÆ¡ SCI-ACE â€” GÄ6 & GÄ7 (7 endpoint: cÃ³ Ä‘iá»u kiá»‡n, há»p, cáº¥p QÄ, bÃ¡o cÃ¡o) Ä‘Ã£ tÃ¡ch sang routes/submissions/nghiemThuVaQuyetDinh.js.
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

// Há»“ sÆ¡ SCI-ACE â€” táº£i file, GÄ3/GÄ4/GÄ5, download & xÃ³a (10 endpoint) Ä‘Ã£ tÃ¡ch sang routes/submissions/kiemTraPhanBien.js.
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

// ========== API Äá» tÃ i cáº¥p Viá»‡n (Nhiá»‡m vá»¥ KHCN cáº¥p cÆ¡ sá»Ÿ) â€” DB vÃ  upload riÃªng ==========
app.post('/api/cap-vien/submissions', authMiddleware, uploadCapVien.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lÃ²ng nháº­p tÃªn Ä‘á» tÃ i / mÃ£ há»“ sÆ¡' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'Cáº§n Ä‘á»§ 3 file: Thuyáº¿t minh, Káº¿ hoáº¡ch, TÃ i liá»‡u bá»• sung' });
  }
  let optionsChecked = [];
  try {
    const raw = req.body.options_checked;
    if (raw) optionsChecked = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
  } catch (e) { optionsChecked = []; }
  if (!Array.isArray(optionsChecked)) optionsChecked = [];

  const run = db.transaction(() => {
    const year = new Date().getFullYear();
    let seqRow = db.prepare('SELECT seq FROM cap_vien_code_sequences WHERE year = ?').get(year);
    if (!seqRow) {
      // Khá»Ÿi táº¡o bá»™ Ä‘áº¿m tá»« mÃ£ lá»›n nháº¥t Ä‘ang cÃ³ trong nÄƒm, trÃ¡nh cáº¥p láº¡i sá»‘ cÅ© sau khi há»“ sÆ¡ bá»‹ xÃ³a.
      const maxRow = db.prepare(
        "SELECT MAX(CAST(SUBSTR(code, -3) AS INTEGER)) AS maxSeq FROM cap_vien_submissions WHERE code LIKE '%-' || ? || '-%'"
      ).get(String(year));
      db.prepare('INSERT INTO cap_vien_code_sequences (year, seq) VALUES (?, ?)').run(year, (maxRow && maxRow.maxSeq) || 0);
    }
    // Bá»™ Ä‘áº¿m chá»‰ tÄƒng, khÃ´ng bao giá» giáº£m theo COUNT(*) â€” nhá» Ä‘Ã³ mÃ£ khÃ´ng bá»‹ trÃ¹ng khi cÃ³ há»“ sÆ¡ bá»‹ xÃ³a á»Ÿ giá»¯a.
    db.prepare('UPDATE cap_vien_code_sequences SET seq = seq + 1 WHERE year = ?').run(year);
    const seq = db.prepare('SELECT seq FROM cap_vien_code_sequences WHERE year = ?').get(year).seq;
    const baseCode = 'DTSCI-' + year + '-' + String(seq).padStart(3, '0');
    // Sáº¯p theo sort_order Ä‘á»ƒ thá»© tá»± nhÃ£n trong mÃ£ luÃ´n nháº¥t quÃ¡n (khÃ´ng phá»¥ thuá»™c thá»© tá»± client gá»­i lÃªn).
    const optsWithAffect = db.prepare('SELECT code FROM cap_vien_submission_options WHERE affects_code = 1 ORDER BY sort_order ASC, id ASC').all();
    const affectCodes = optsWithAffect.map(r => (r.code || '').toUpperCase()).filter(Boolean);
    const checkedAffectSet = new Set(optionsChecked.map(c => (c || '').toUpperCase()));
    // Gá»™p Táº¤T Cáº¢ cÃ¡c Ã´ "áº¢nh hÆ°á»Ÿng mÃ£ sá»‘" Ä‘Ã£ tick vÃ o mÃ£ â€” trÆ°á»›c Ä‘Ã¢y chá»‰ láº¥y Ã´ Ä‘áº§u tiÃªn, cÃ¡c Ã´ cÃ²n láº¡i bá»‹ bá» sÃ³t.
    const checkedAffect = affectCodes.filter(c => checkedAffectSet.has(c));
    let code = baseCode;
    if (checkedAffect.length > 0) {
      const suffix = checkedAffect.join('-');
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
  insertCapVienHistory(id, '1', 'researcher_submit', req.user.id, 'researcher', 'NghiÃªn cá»©u viÃªn ná»™p há»“ sÆ¡ Ä‘á» xuáº¥t', row ? row.createdAt : null);
  sendCapVienNewSubmissionEmail({
    submissionId: id,
    submissionTitle: title,
    submittedByEmail: req.user.email,
    submittedByName: req.user.fullname,
    createdAt: row ? row.createdAt : null,
    status: row ? row.status : 'SUBMITTED'
  });
  return res.status(201).json({ id, message: 'ÄÃ£ gá»­i há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n thÃ nh cÃ´ng' });
});

// Ã” Ä‘Ã¡nh dáº¥u khi ná»™p Ä‘á» tÃ i cáº¥p Viá»‡n (CoE, Kinh phÃ­ Viá»‡n...) â€” public Ä‘á»ƒ form hiá»ƒn thá»‹
app.get('/api/cap-vien/submission-options', (req, res) => {
  const rows = db.prepare('SELECT id, code, label, affects_code FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});

// Danh má»¥c háº¡ng má»¥c (public, dÃ¹ng trong form ná»™p há»“ sÆ¡)
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

// â”€â”€ Máº«u há»“ sÆ¡ cÃ´ng khai (trang tai-mau-ho-so-de-tai-cap-vien) â€” Admin upload; má»i ngÆ°á»i táº£i khi Ä‘Ã£ cÃ³ file â”€â”€
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
    return res.status(500).json({ message: 'Lá»—i CSDL' });
  }
});

app.get('/api/cap-vien/public-templates/:taskCode/file', (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(404).json({ message: 'MÃ£ máº«u khÃ´ng há»£p lá»‡' });
  }
  const row = db.prepare('SELECT stored_path, original_name FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'ChÆ°a cÃ³ file máº«u cho mÃ£ nÃ y. Vui lÃ²ng liÃªn há»‡ quáº£n trá»‹ hoáº·c thá»­ láº¡i sau.' });
  }
  const abs = resolveStoredFileFromDb(row.stored_path);
  const baseDir = path.resolve(capVienPublicTemplatesFsDir);
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs) || !fs.existsSync(abs)) {
    return res.status(404).json({ message: 'File khÃ´ng cÃ²n trÃªn mÃ¡y chá»§' });
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
      return res.status(400).json({ message: 'MÃ£ máº«u khÃ´ng há»£p lá»‡' });
    }
    const f = req.file;
    if (!f) {
      return res.status(400).json({ message: 'Thiáº¿u file (form field: file)' });
    }
    const relWithinCapVien = path.relative(uploadDirCapVien, f.path);
    const relStored =
      !relWithinCapVien.startsWith('..') && !path.isAbsolute(relWithinCapVien)
        ? 'uploads-cap-vien/' + relWithinCapVien.split(path.sep).join('/')
        : path.relative(__dirname, f.path).split(path.sep).join('/');
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
      return res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t máº«u', taskCode, originalName: orig });
    } catch (e) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch (_) {}
      console.error('[public-templates upload]', e);
      return res.status(500).json({ message: 'Lá»—i lÆ°u' });
    }
  }
);

app.delete('/api/cap-vien/public-templates/:taskCode', authMiddleware, adminOnly, (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(400).json({ message: 'MÃ£ máº«u khÃ´ng há»£p lá»‡' });
  }
  const row = db.prepare('SELECT stored_path FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'KhÃ´ng cÃ³ file Ä‘á»ƒ xÃ³a' });
  }
  try {
    const p = resolveCapVienPublicTemplateStoredFileForUnlink(row.stored_path);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
    db.prepare('DELETE FROM cap_vien_public_template_files WHERE task_code = ?').run(taskCode);
    return res.json({ ok: true, message: 'ÄÃ£ xÃ³a máº«u' });
  } catch (e) {
    console.error('[public-templates delete]', e);
    return res.status(500).json({ message: 'Lá»—i xÃ³a' });
  }
});

// Admin: CRUD Ã´ Ä‘Ã¡nh dáº¥u
app.get('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});
app.post('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const { code, label, affects_code } = req.body || {};
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '') || codeStr;
  if (!codeStr) return res.status(400).json({ message: 'MÃ£ option khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cap_vien_submission_options').get();
    const nextOrder = (maxOrder && maxOrder.m != null ? maxOrder.m : 0) + 1;
    db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, affects_code ? 1 : 0, nextOrder);
    const row = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE code = ?').get(codeStr);
    return res.status(201).json({ message: 'ÄÃ£ thÃªm Ã´ Ä‘Ã¡nh dáº¥u', option: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'MÃ£ option Ä‘Ã£ tá»“n táº¡i' });
    throw e;
  }
});
app.put('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, label, affects_code, sort_order } = req.body || {};
  const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y option' });
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '');
  const updates = [];
  const params = [];
  if (codeStr !== '') { updates.push('code = ?'); params.push(codeStr); }
  if (labelStr !== '') { updates.push('label = ?'); params.push(labelStr); }
  if (affects_code !== undefined) { updates.push('affects_code = ?'); params.push(affects_code ? 1 : 0); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10) || 0); }
  if (updates.length === 0) return res.json({ message: 'KhÃ´ng cÃ³ thay Ä‘á»•i' });
  params.push(id);
  db.prepare('UPDATE cap_vien_submission_options SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE id = ?').get(id);
  return res.json({ message: 'ÄÃ£ cáº­p nháº­t', option: updated });
});
app.delete('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y option' });
  db.prepare('DELETE FROM cap_vien_submission_options WHERE id = ?').run(id);
  return res.json({ message: 'ÄÃ£ xÃ³a Ã´ Ä‘Ã¡nh dáº¥u' });
});

// Admin: CRUD LÄ©nh vá»±c KHCN
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
    if (!codeStr) return res.status(400).json({ message: 'MÃ£ khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ' + table).get();
    try {
      if (tableName === 'khoan_muc_chi') {
        db.prepare('INSERT INTO ' + table + ' (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, (parent_code || '').trim() || null, (maxOrder.m || 0) + 1);
      } else {
        db.prepare('INSERT INTO ' + table + ' (code, label, sort_order) VALUES (?, ?, ?)').run(codeStr, labelStr, (maxOrder.m || 0) + 1);
      }
      const row = db.prepare('SELECT * FROM ' + table + ' WHERE code = ?').get(codeStr);
      return res.json({ message: 'ÄÃ£ thÃªm ' + singularLabel, item: row });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'MÃ£ Ä‘Ã£ tá»“n táº¡i' });
      throw e;
    }
  });
  app.put('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { code, label, parent_code, sort_order } = req.body || {};
    const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y' });
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
    return res.json({ message: 'ÄÃ£ cáº­p nháº­t', item: updated });
  });
  app.delete('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y' });
    db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id);
    return res.json({ message: 'ÄÃ£ xÃ³a ' + singularLabel });
  });
}
crudCapVienTable('linh_vuc', 'lÄ©nh vá»±c');
crudCapVienTable('loai_de_tai', 'loáº¡i Ä‘á» tÃ i');
crudCapVienTable('don_vi', 'Ä‘Æ¡n vá»‹');
crudCapVienTable('khoan_muc_chi', 'khoáº£n má»¥c chi');

// Admin: Ä‘á»“ng bá»™ nhiá»‡m vá»¥ KHCN tá»« Ä‘á» tÃ i cáº¥p Viá»‡n
app.post('/api/admin/missions/sync-from-cap-vien', authMiddleware, adminOnly, (req, res) => {
  // Gá»¡ tráº¡ng thÃ¡i Â«áº©n khá»i dashboardÂ» (missions_hidden) Ä‘á»ƒ cÃ¡c há»“ sÆ¡ cáº¥p Viá»‡n cÃ²n tá»“n táº¡i Ä‘Æ°á»£c Ä‘á»“ng bá»™ láº¡i.
  // áº¨n chá»‰ Ä‘Æ°á»£c ghi khi Admin xÃ³a Ä‘á» tÃ i Ä‘á»“ng bá»™ tá»« cáº¥p Viá»‡n khá»i báº£ng â€” nÃºt Äá»“ng bá»™ = khÃ´i phá»¥c theo nguá»“n.
  try {
    db.prepare("DELETE FROM missions_hidden WHERE source_type = 'cap_vien'").run();
  } catch (e) {
    /* báº£ng cÃ³ thá»ƒ chÆ°a tá»“n táº¡i trÃªn DB ráº¥t cÅ© */
  }
  syncMissionsFromCapVien();
  const count = db.prepare('SELECT COUNT(*) AS n FROM missions WHERE source_type = ?').get('cap_vien');
  return res.json({ message: 'ÄÃ£ Ä‘á»“ng bá»™ nhiá»‡m vá»¥ KHCN tá»« Ä‘á» tÃ i cáº¥p Viá»‡n.', count: count.n });
});

// Admin: danh sÃ¡ch Ä‘á» tÃ i cáº¥p Viá»‡n (Ä‘áº§y Ä‘á»§, cho quáº£n trá»‹)
app.get('/api/admin/cap-vien/submissions', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
  rows.forEach(r => {
    const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
    r.submittedByName = u ? u.fullname : null;
  });
  return res.json({ submissions: rows });
});

// Admin: sá»­a mÃ£ Ä‘á» tÃ i (trÆ°á»ng há»£p cáº§n thiáº¿t)
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
  return res.json({ message: on ? 'ÄÃ£ báº­t gá»­i email khi hoÃ n thÃ nh BÆ°á»›c 7.' : 'ÄÃ£ táº¯t gá»­i email khi hoÃ n thÃ nh BÆ°á»›c 7.', enabled: on });
});

app.get('/api/admin/cap-vien/settings/chairman-email-controls', authMiddleware, adminOnly, (req, res) => {
  return res.json({ controls: getChairmanEmailControls(), defaults: CHAIRMAN_EMAIL_CONTROL_DEFAULTS });
});

app.put('/api/admin/cap-vien/settings/chairman-email-controls', authMiddleware, adminOnly, (req, res) => {
  const incoming = (req.body && req.body.controls && typeof req.body.controls === 'object') ? req.body.controls : {};
  const merged = Object.assign({}, CHAIRMAN_EMAIL_CONTROL_DEFAULTS);
  Object.keys(merged).forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(incoming, k)) merged[k] = !!incoming[k];
  });
  db.prepare('INSERT INTO cooperation_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CHAIRMAN_EMAIL_CONTROL_KEY, JSON.stringify(merged));
  return res.json({ message: 'ÄÃ£ lÆ°u cáº¥u hÃ¬nh email cho Chá»§ tá»‹ch HÄKHCN.', controls: merged });
});

app.get('/api/admin/cap-vien/settings/council-member-email-controls', authMiddleware, adminOnly, (req, res) => {
  return res.json({ controls: getCouncilMemberEmailControls(), defaults: COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS });
});

app.put('/api/admin/cap-vien/settings/council-member-email-controls', authMiddleware, adminOnly, (req, res) => {
  const incoming = (req.body && req.body.controls && typeof req.body.controls === 'object') ? req.body.controls : {};
  const merged = Object.assign({}, COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS);
  Object.keys(merged).forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(incoming, k)) merged[k] = !!incoming[k];
  });
  db.prepare('INSERT INTO cooperation_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(COUNCIL_MEMBER_EMAIL_CONTROL_KEY, JSON.stringify(merged));
  return res.json({ message: 'ÄÃ£ lÆ°u cáº¥u hÃ¬nh email cho thÃ nh viÃªn HÄKHCN (ngoÃ i Chá»§ tá»‹ch).', controls: merged });
});

app.put('/api/admin/cap-vien/submissions/:id/code', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const newCode = (req.body && req.body.code != null) ? String(req.body.code).trim() : '';
  const row = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if (!newCode) return res.status(400).json({ message: 'MÃ£ Ä‘á» tÃ i khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
  db.prepare('UPDATE cap_vien_submissions SET code = ? WHERE id = ?').run(newCode, id);
  return res.json({ message: 'ÄÃ£ cáº­p nháº­t mÃ£ Ä‘á» tÃ i', code: newCode });
});

/** Xem má»i há»“ sÆ¡ cáº¥p Viá»‡n (danh sÃ¡ch + chi tiáº¿t + táº£i): Admin, Viá»‡n trÆ°á»Ÿng, P.KHCN, Há»™i Ä‘á»“ng (ká»ƒ cáº£
 * role Ä‘Æ°á»£c cáº¥p qua council_role_grants). Chá»§ nhiá»‡m chá»‰ há»“ sÆ¡ cá»§a mÃ¬nh. */
function capVienRoleSeesAllSubmissions(req) {
  return roleIsAny(req, ['admin', 'vien_truong', 'phong_khcn', 'chu_tich', 'thu_ky', 'thanh_vien']);
}

app.get('/api/cap-vien/submissions', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache');
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
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
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const row = db.prepare(`SELECT id, title, submittedBy, submittedById, status, createdAt, code, options_checked, reviewNote, reviewedAt, reviewedById, assignedReviewerIds, assignedAt, assignedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round, budget_4a_revision_note, budget_4a_revision_requested_at, budget_4a_revision_requested_by, budget_4a_approved_at, budget_4a_approved_by, step_4_reviewer1_done, step_4_reviewer2_done, step5_hd_meeting_location, step5_hd_meeting_attendance, step5_hd_meeting_documents, step5_hd_meeting_vote_result, step5_hd_meeting_decision, step5_hd_meeting_event_time, step5_hd_meeting_updated_at, step5_hd_meeting_updated_by, step5_council_revision_status, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_note, step5_council_revision_requested_at, step5_council_revision_requested_by, step6_so_qd, step6_kinh_phi, step6_thoi_gian, step6_phi_quan_ly, step6_meta_updated_at, step6_meta_updated_by, step7_so_hd, step7_hieu_luc, step7_meta_updated_at, step7_meta_updated_by, step8_ma_dao_duc, step8_hieu_luc, step8_so_quyet_dinh, step8_meta_updated_at, step8_meta_updated_by, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived, COALESCE(step8a_completed, 0) AS step8a_completed, COALESCE(step8a_waived, 0) AS step8a_waived, step9_supply_locked_at, step9_supply_locked_by FROM cap_vien_submissions WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n xem há»“ sÆ¡ nÃ y' });
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
      const note = row.reviewNote || (actionType === 'secretary_approve' ? 'Há»£p lá»‡' : null);
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
      reviewerNames = ids.map(rid => { const r = reviewers.find(x => x.id === rid); return r ? (r.fullname || r.email || '') : 'â€”'; });
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
  const step9Milestones = db.prepare(
    'SELECT id, title, status, eventDate, note, sortOrder, createdAt, createdById, updatedAt FROM cap_vien_step9_milestone WHERE submissionId = ? AND deletedAt IS NULL ORDER BY sortOrder ASC, id ASC'
  ).all(id);
  const step9SupplyItemsRaw = db.prepare(
    'SELECT id, name, unit, approvedQty, approvedAmount, note, createdAt FROM cap_vien_step9_supply_item WHERE submissionId = ? AND deletedAt IS NULL ORDER BY id ASC'
  ).all(id);
  const step9SupplyIssuancesRaw = db.prepare(
    `SELECT si.id, si.itemId, si.qty, si.issuedDate, si.note, si.status, si.requestedAt, si.decidedAt, si.decisionNote,
            ru.fullname AS requestedByName, du.fullname AS decidedByName
     FROM cap_vien_step9_supply_issuance si
     LEFT JOIN users ru ON ru.id = si.requestedById
     LEFT JOIN users du ON du.id = si.decidedById
     WHERE si.submissionId = ? ORDER BY si.id ASC`
  ).all(id);
  const step9SupplyItems = step9SupplyItemsRaw.map((it) => {
    const issuances = step9SupplyIssuancesRaw.filter((s) => s.itemId === it.id);
    const issuedQty = issuances.filter((s) => s.status === 'confirmed').reduce((sum, s) => sum + (s.qty || 0), 0);
    return { ...it, issuances, issuedQty, remainingQty: it.approvedQty - issuedQty };
  });
  let step9SupplyLockedByName = null;
  if (row.step9_supply_locked_by != null) {
    const u9 = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step9_supply_locked_by);
    if (u9) step9SupplyLockedByName = u9.fullname || u9.email || null;
  }
  const step11AdjustmentRequests = db.prepare(
    `SELECT ar.id, ar.type, ar.content, ar.status, ar.requestedAt, ar.khcnNote, ar.khcnDecidedAt, ar.directorNote, ar.directorDecidedAt,
            reqU.fullname AS requestedByName, khcnU.fullname AS khcnDecidedByName, dirU.fullname AS directorDecidedByName
     FROM cap_vien_step11_adjustment_request ar
     LEFT JOIN users reqU ON reqU.id = ar.requestedById
     LEFT JOIN users khcnU ON khcnU.id = ar.khcnDecidedById
     LEFT JOIN users dirU ON dirU.id = ar.directorDecidedById
     WHERE ar.submissionId = ? ORDER BY ar.id DESC`
  ).all(id);
  return res.json({
    ...row,
    code: displayCode,
    step5HdMeetingUpdatedByName,
    step5CouncilRevisionRequestedByName,
    step6MetaUpdatedByName,
    step7MetaUpdatedByName,
    step8MetaUpdatedByName,
    step9SupplyLockedByName,
    submittedByName: u ? u.fullname : null,
    reviewedByName: reviewedBy ? reviewedBy.fullname : null,
    assignedByName: assignedBy ? assignedBy.fullname : null,
    reviewerNames,
    files,
    stepDeadlines,
    step2History,
    stepHistory,
    stepActualStats,
    periodicReport,
    step9Milestones,
    step9SupplyItems,
    step11AdjustmentRequests
  });
});

function capVienStep6DecisionAllowedStatus(st) {
  const s = String(st || '').toUpperCase();
  return ['CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(s);
}

function capVienStep6CanEdit(req) {
  return roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky']);
}

function capVienStep6HistoryRoleDb(roleRaw) {
  const r = (roleRaw || '').toLowerCase();
  if (r === 'admin') return 'admin';
  if (r === 'thu_ky') return 'thu_ky';
  return 'phong_khcn';
}

/** BÆ°á»›c 6 â€” PhÃ²ng KHCN / ThÆ° kÃ½ HÄKHCN / Admin: lÆ°u Sá»‘ QÄ, kinh phÃ­, thá»i gian, phÃ­ QL (chá»‰nh sá»­a Ä‘Æ°á»£c nhiá»u láº§n) */
app.put('/api/cap-vien/submissions/:id/steps/6/decision-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c cáº­p nháº­t thÃ´ng tin Quyáº¿t Ä‘á»‹nh.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Há»“ sÆ¡ chÆ°a Ä‘áº¿n bÆ°á»›c Cáº¥p Quyáº¿t Ä‘á»‹nh (BÆ°á»›c 6).' });
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
  insertCapVienHistory(id, '6', 'step6_meta_update', req.user.id, roleDb, 'Cáº­p nháº­t thÃ´ng tin Quyáº¿t Ä‘á»‹nh (Sá»‘ QÄ, kinh phÃ­, thá»i gian, phÃ­ QL)');
  return res.json({ message: 'ÄÃ£ lÆ°u thÃ´ng tin Quyáº¿t Ä‘á»‹nh.', updatedAt });
});

function capVienStep7ContractMetaAllowedStatus(statusRaw) {
  const s = (statusRaw || '').toUpperCase();
  return s === 'APPROVED' || s === 'CONTRACTED';
}

/** BÆ°á»›c 7 â€” PhÃ²ng KHCN / ThÆ° kÃ½ HÄKHCN / Admin: lÆ°u Sá»‘ HÄ, Hiá»‡u lá»±c há»£p Ä‘á»“ng */
app.put('/api/cap-vien/submissions/:id/steps/7/contract-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c cáº­p nháº­t thÃ´ng tin Há»£p Ä‘á»“ng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if (!capVienStep7ContractMetaAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Chá»‰ cáº­p nháº­t Ä‘Æ°á»£c khi há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 7 (APPROVED) hoáº·c vá»«a hoÃ n thÃ nh BÆ°á»›c 7 (CONTRACTED).' });
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
  insertCapVienHistory(id, '7', 'step7_contract_meta_update', req.user.id, roleDb, 'Cáº­p nháº­t thÃ´ng tin Há»£p Ä‘á»“ng (Sá»‘ HÄ, Hiá»‡u lá»±c)');
  return res.json({ message: 'ÄÃ£ lÆ°u thÃ´ng tin Há»£p Ä‘á»“ng.', updatedAt });
});

/** BÆ°á»›c 6 â€” upload / thay tháº¿ file Quyáº¿t Ä‘á»‹nh VN & EN (cÃ³ thá»ƒ chá»‰ gá»­i má»™t phÃ­a) */
app.post('/api/cap-vien/submissions/:id/steps/6/upload-decision', authMiddleware, (req, res, next) => {
  uploadCapVien.fields([
    { name: 'decision_vn', maxCount: 1 },
    { name: 'decision_en', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload tháº¥t báº¡i: ' + (err.message || 'Dá»¯ liá»‡u file khÃ´ng há»£p lá»‡') });
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c upload Quyáº¿t Ä‘á»‹nh.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Há»“ sÆ¡ chÆ°a Ä‘áº¿n bÆ°á»›c Cáº¥p Quyáº¿t Ä‘á»‹nh (BÆ°á»›c 6).' });
  }
  const files = req.files || {};
  const fileVn = files.decision_vn && files.decision_vn[0] ? files.decision_vn[0] : null;
  const fileEn = files.decision_en && files.decision_en[0] ? files.decision_en[0] : null;
  if (!fileVn && !fileEn) return res.status(400).json({ message: 'Vui lÃ²ng chá»n Ã­t nháº¥t má»™t file (Quyáº¿t Ä‘á»‹nh VN hoáº·c EN).' });
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
      throw new Error('File ' + tag + ': chá»‰ cháº¥p nháº­n PDF hoáº·c Word.');
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
    return res.status(400).json({ message: 'Lá»—i lÆ°u file' });
  }
  insertCapVienHistory(id, '6', 'step6_decision_upload', req.user.id, roleDb, 'Upload Quyáº¿t Ä‘á»‹nh: ' + saved.join(', '));
  console.log('[API] cap-vien step 6 upload-decision â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ lÆ°u file Quyáº¿t Ä‘á»‹nh vÃ o há»“ sÆ¡.', files: saved });
});

/** BÆ°á»›c 7 â€” PhÃ²ng KHCN / ThÆ° kÃ½ HÄKHCN / Admin: upload / thay tháº¿ Há»£p Ä‘á»“ng KHCN */
app.post('/api/cap-vien/submissions/:id/steps/7/upload-contract', authMiddleware, uploadCapVien.single('step7_hop_dong_khcn'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c upload Há»£p Ä‘á»“ng KHCN.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if ((sub.status || '').toUpperCase() !== 'APPROVED') {
    return res.status(400).json({ message: 'Chá»‰ upload Há»£p Ä‘á»“ng KHCN khi há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 7 (tráº¡ng thÃ¡i APPROVED).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃ²ng chá»n file Há»£p Ä‘á»“ng KHCN (PDF hoáº·c Word).' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chá»‰ cháº¥p nháº­n file PDF hoáº·c Word.' });
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
  insertCapVienHistory(id, '7', 'step7_contract_upload', req.user.id, roleDb, 'Upload Há»£p Ä‘á»“ng KHCN: ' + storedName);
  console.log('[API] cap-vien step 7 upload-contract â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ lÆ°u Há»£p Ä‘á»“ng KHCN vÃ o há»“ sÆ¡.', fileName: storedName });
});

function capVienStep8EthicsAllowedRow(sub) {
  if (!sub) return false;
  if ((sub.status || '').toUpperCase() !== 'CONTRACTED') return false;
  if (sub.step8_waived === 1 || sub.step8_waived === true) return false;
  return !(sub.step8_completed === 1 || sub.step8_completed === true);
}

/** BÆ°á»›c 8 â€” PhÃ²ng KHCN / ThÆ° kÃ½ / Admin: lÆ°u MÃ£ Ä‘áº¡o Ä‘á»©c, Hiá»‡u lá»±c, Sá»‘/kÃ½ hiá»‡u Quyáº¿t Ä‘á»‹nh */
app.put('/api/cap-vien/submissions/:id/steps/8/ethics-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c cáº­p nháº­t thÃ´ng tin Ä‘áº¡o Ä‘á»©c.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, status, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'Chá»‰ cáº­p nháº­t Ä‘Æ°á»£c khi há»“ sÆ¡ Ä‘Ã£ kÃ½ há»£p Ä‘á»“ng (CONTRACTED), BÆ°á»›c 8 chÆ°a hoÃ n thÃ nh vÃ  chÆ°a bá»‹ báº¥t hoáº¡t.' });
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
  insertCapVienHistory(id, '8', 'step8_ethics_meta_update', req.user.id, roleDb, 'Cáº­p nháº­t thÃ´ng tin Ä‘Äƒng kÃ½ Ä‘áº¡o Ä‘á»©c (mÃ£, hiá»‡u lá»±c, QÄ)');
  return res.json({ message: 'ÄÃ£ lÆ°u thÃ´ng tin Ä‘áº¡o Ä‘á»©c.', updatedAt });
});

/** BÆ°á»›c 8 â€” upload Quyáº¿t Ä‘á»‹nh Ä‘áº¡o Ä‘á»©c (1 file) */
app.post('/api/cap-vien/submissions/:id/steps/8/upload-ethics-decision', authMiddleware, uploadCapVien.single('step8_ethics_quyet_dinh'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c upload Quyáº¿t Ä‘á»‹nh Ä‘áº¡o Ä‘á»©c.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'Chá»‰ upload khi há»“ sÆ¡ á»Ÿ CONTRACTED, BÆ°á»›c 8 chÆ°a hoÃ n thÃ nh vÃ  chÆ°a bá»‹ báº¥t hoáº¡t.' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃ²ng chá»n file Quyáº¿t Ä‘á»‹nh Ä‘áº¡o Ä‘á»©c.' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chá»‰ cháº¥p nháº­n PDF hoáº·c Word.' });
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
  insertCapVienHistory(id, '8', 'step8_ethics_upload', req.user.id, roleDb, 'Upload Quyáº¿t Ä‘á»‹nh Ä‘áº¡o Ä‘á»©c: ' + storedName);
  console.log('[API] cap-vien step 8 upload-ethics â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ lÆ°u Quyáº¿t Ä‘á»‹nh Ä‘áº¡o Ä‘á»©c vÃ o há»“ sÆ¡.', fileName: storedName });
});

function capVienPeriodicReportUploadAllowed(sub, user) {
  const st = (sub.status || '').toUpperCase();
  if (!['IMPLEMENTATION', 'COMPLETED'].includes(st)) return false;
  if (userHasAnyRole(user, ['admin', 'phong_khcn', 'thu_ky'])) return true;
  return sub.submittedById === user.id;
}

/** NCV / P.KHCN / ThÆ° kÃ½ / Admin: upload bÃ¡o cÃ¡o gáº¯n má»™t ká»³ */
app.post(
  '/api/cap-vien/submissions/:id/periodic-report/period/:periodId/upload',
  authMiddleware,
  uploadCapVien.single('periodic_report_file'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const periodId = parseInt(req.params.periodId, 10);
    if (!id || !periodId) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡' });
    const sub = db.prepare('SELECT id, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
    if (!capVienPeriodicReportUploadAllowed(sub, req.user)) {
      return res.status(403).json({ message: 'KhÃ´ng cÃ³ quyá»n upload bÃ¡o cÃ¡o Ä‘á»‹nh ká»³ cho há»“ sÆ¡ nÃ y.' });
    }
    const per = db.prepare(
      `SELECT id, submissionId, status, primaryFileId FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`
    ).get(periodId, id);
    if (!per) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y ká»³ bÃ¡o cÃ¡o' });
    const stLow = String(per.status || '').toLowerCase();
    if (stLow === 'waived' || stLow === 'bypassed') {
      return res.status(400).json({ message: 'Ká»³ nÃ y Ä‘Ã£ báº¥t hoáº¡t / bypass â€” khÃ´ng upload.' });
    }
    const file = req.file;
    if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃ²ng chá»n file (PDF/Word).' });
    const allowedExt = ['.pdf', '.doc', '.docx'];
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (!allowedExt.includes(ext)) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      return res.status(400).json({ message: 'Chá»‰ cháº¥p nháº­n PDF hoáº·c Word.' });
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
    insertCapVienHistory(id, '10', 'periodic_report_upload', req.user.id, roleDb, 'Ná»™p bÃ¡o cÃ¡o Ä‘á»‹nh ká»³: ' + storedName + ' (ká»³ #' + periodId + ')');
    return res.json({ message: 'ÄÃ£ lÆ°u bÃ¡o cÃ¡o cho ká»³ Ä‘Æ°á»£c chá»n.', fileId: newId, periodId });
  }
);

/** Admin: cÃ´ng cá»¥ bÃ¡o cÃ¡o Ä‘á»‹nh ká»³ â€” body { action, payload } */
app.post('/api/cap-vien/submissions/:id/periodic-report/admin', authMiddleware, (req, res) => {
  if (String(req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c dÃ¹ng cÃ´ng cá»¥ nÃ y.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT * FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
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
      insertCapVienHistory(id, '10', 'periodic_report_config', req.user.id, 'admin', `Cáº¥u hÃ¬nh BC Ä‘á»‹nh ká»³: ${cycleMonths} thÃ¡ng, neo ${anchorType}`);
      return res.json({ message: 'ÄÃ£ lÆ°u cáº¥u hÃ¬nh chu ká»³ bÃ¡o cÃ¡o.', action: 'set_cycle' });
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
      if (!anchorIso) return res.status(400).json({ message: 'KhÃ´ng xÃ¡c Ä‘á»‹nh Ä‘Æ°á»£c má»‘c neo (thiáº¿u ngÃ y / lá»‹ch sá»­ BÆ°á»›c 7).' });
      const periodCount = Math.max(1, Math.min(48, parseInt(payload.periodCount, 10) || Math.min(12, Math.ceil(36 / cycleMonths))));
      const preview = capVienBuildPeriodicSchedule(anchorIso, cycleMonths, periodCount);
      return res.json({ message: 'Preview lá»‹ch ká»³ (chÆ°a lÆ°u).', preview, anchorIso, action: 'preview_schedule' });
    }

    if (action === 'apply_recalc') {
      const forceWipe = !!payload.forceWipe;
      const cfg = db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (!cfg) return res.status(400).json({ message: 'ChÆ°a cÃ³ cáº¥u hÃ¬nh. DÃ¹ng set_cycle trÆ°á»›c.' });
      const locked = db.prepare(
        `SELECT COUNT(1) AS n FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL AND primaryFileId IS NOT NULL`
      ).get(id);
      if ((locked.n || 0) > 0 && !forceWipe) {
        return res.status(400).json({
          message: 'ÄÃ£ cÃ³ ká»³ Ä‘Ã£ ná»™p file. Truyá»n payload.forceWipe = true Ä‘á»ƒ xÃ³a toÃ n bá»™ ká»³ vÃ  táº¡o láº¡i (nguy hiá»ƒm).'
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
      insertCapVienHistory(id, '10', 'periodic_report_recalc', req.user.id, 'admin', 'TÃ­nh láº¡i lá»‹ch cÃ¡c ká»³ bÃ¡o cÃ¡o Ä‘á»‹nh ká»³');
      return res.json({ message: 'ÄÃ£ táº¡o láº¡i danh sÃ¡ch ká»³ bÃ¡o cÃ¡o.', action: 'apply_recalc' });
    }

    if (action === 'insert_period') {
      const dueAt = String(payload.dueAt || '').trim();
      if (!dueAt) return res.status(400).json({ message: 'Thiáº¿u dueAt (ISO).' });
      const label = String(payload.label || '').trim() || null;
      const maxS = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL`).get(id);
      const seq = (maxS.m || 0) + 1;
      const periodStart = String(payload.periodStart || dueAt).trim();
      db.prepare(
        `INSERT INTO cap_vien_periodic_report_period (submissionId, seq, label, periodStart, periodEnd, dueAt, status, createdAt) VALUES (?,?,?,?, NULL, ?, 'pending', ?)`
      ).run(id, seq, label, periodStart, dueAt, now);
      const row = db.prepare(`SELECT id FROM cap_vien_periodic_report_period WHERE submissionId = ? AND seq = ? AND deletedAt IS NULL`).get(id, seq);
      log('insert_period', row.id, { seq, dueAt, label }, null);
      return res.json({ message: 'ÄÃ£ chÃ¨n ká»³ má»›i.', periodId: row.id, action: 'insert_period' });
    }

    if (action === 'delete_period') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'Thiáº¿u periodId' });
      const per = db
        .prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`)
        .get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y ká»³' });
      if (per.primaryFileId) return res.status(400).json({ message: 'Ká»³ Ä‘Ã£ cÃ³ file â€” khÃ´ng xÃ³a.' });
      const stLow = String(per.status || '').toLowerCase();
      if (stLow === 'submitted') return res.status(400).json({ message: 'Ká»³ Ä‘Ã£ submitted â€” khÃ´ng xÃ³a.' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET deletedAt = ? WHERE id = ?`).run(now, periodId);
      log('delete_period', periodId, { seq: per.seq }, null);
      return res.json({ message: 'ÄÃ£ xÃ³a ká»³ (soft).', action: 'delete_period' });
    }

    if (action === 'waive_period') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'Cáº§n periodId vÃ  note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y ká»³' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'waived', waivedAt = ?, waivedById = ?, waiveNote = ?, primaryFileId = NULL, submittedAt = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('waive_period', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_waive', req.user.id, 'admin', 'Báº¥t hoáº¡t ká»³ BC: ' + note);
      return res.json({ message: 'ÄÃ£ báº¥t hoáº¡t ká»³.', action: 'waive_period' });
    }

    if (action === 'bypass_submit') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'Cáº§n periodId vÃ  note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y ká»³' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'bypassed', bypassedAt = ?, bypassedById = ?, bypassNote = ?, submittedAt = NULL, primaryFileId = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('bypass_submit', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_bypass', req.user.id, 'admin', 'Bypass ná»™p ká»³ BC: ' + note);
      return res.json({ message: 'ÄÃ£ bypass ká»³ (Ä‘Ã¡nh dáº¥u hoÃ n thÃ nh khÃ´ng file).', action: 'bypass_submit' });
    }

    if (action === 'detach_file') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'Thiáº¿u periodId' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y ká»³' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(periodId);
      db.prepare(`UPDATE cap_vien_periodic_report_period_file SET detachedAt = ? WHERE periodId = ? AND detachedAt IS NULL`).run(now, periodId);
      log('detach_file', periodId, {}, null);
      return res.json({ message: 'ÄÃ£ gá»¡ file khá»i ká»³ (ká»³ vá» pending).', action: 'detach_file' });
    }

    if (action === 'move_file') {
      const fromPeriodId = parseInt(payload.fromPeriodId, 10);
      const toPeriodId = parseInt(payload.toPeriodId, 10);
      if (!fromPeriodId || !toPeriodId) return res.status(400).json({ message: 'Cáº§n fromPeriodId vÃ  toPeriodId' });
      const fromP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(fromPeriodId, id);
      const toP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(toPeriodId, id);
      if (!fromP || !toP) return res.status(404).json({ message: 'Ká»³ khÃ´ng há»£p lá»‡' });
      const fid = fromP.primaryFileId;
      if (!fid) return res.status(400).json({ message: 'Ká»³ nguá»“n khÃ´ng cÃ³ file' });
      if (toP.primaryFileId) return res.status(400).json({ message: 'Ká»³ Ä‘Ã­ch Ä‘Ã£ cÃ³ file' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(fromPeriodId);
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET primaryFileId = ?, status = 'submitted', submittedAt = ? WHERE id = ?`
      ).run(fid, now, toPeriodId);
      log('move_file', toPeriodId, { fromPeriodId, toPeriodId, fileId: fid }, null);
      return res.json({ message: 'ÄÃ£ chuyá»ƒn file sang ká»³ Ä‘Ã­ch.', action: 'move_file' });
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
      return res.json({ message: 'ÄÃ£ báº­t Ä‘Ã³ng bÄƒng háº¡n (cá» há»‡ thá»‘ng).', action: 'freeze_deadlines' });
    }

    if (action === 'unfreeze_deadlines') {
      db.prepare(
        `UPDATE cap_vien_periodic_report_config SET pauseReportClock = 0, pausedUntil = NULL, pauseReason = NULL, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
      ).run(now, req.user.id, id);
      log('unfreeze_deadlines', null, {}, null);
      return res.json({ message: 'ÄÃ£ táº¯t Ä‘Ã³ng bÄƒng.', action: 'unfreeze_deadlines' });
    }

    if (action === 'resend_reminder') {
      const periodId = payload.periodId ? parseInt(payload.periodId, 10) : null;
      log('resend_reminder', periodId || null, {}, payload.note || null);
      return res.json({ message: 'ÄÃ£ ghi nháº­n yÃªu cáº§u nháº¯c (tÃ­ch há»£p email cÃ³ thá»ƒ bá»• sung sau).', action: 'resend_reminder' });
    }

    return res.status(400).json({ message: 'action khÃ´ng há»£p lá»‡: ' + action });
  } catch (err) {
    if (err && err.message === 'NO_ANCHOR') {
      return res.status(400).json({ message: 'KhÃ´ng xÃ¡c Ä‘á»‹nh Ä‘Æ°á»£c má»‘c neo lá»‹ch.' });
    }
    console.error('[periodic-report admin]', err);
    return res.status(500).json({ message: 'Lá»—i server' });
  }
});

// Admin (dev): Ä‘áº·t/cáº­p nháº­t deadline cho tá»«ng bÆ°á»›c
app.put('/api/cap-vien/submissions/:id/steps/:step/deadline', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepId = String(req.params.step || '').trim();
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  if (!stepId) return res.status(400).json({ message: 'Step khÃ´ng há»£p lá»‡' });
  if ((req.user.role || '').toLowerCase() !== 'admin') return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c Ä‘áº·t deadline' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });

  const body = req.body || {};
  const clear = !!body.clear;
  if (clear) {
    db.prepare('DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').run(id, stepId);
    return res.json({ message: 'ÄÃ£ xÃ³a deadline cho bÆ°á»›c ' + stepId, stepId, cleared: true });
  }

  const existing = db.prepare('SELECT openedAt FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').get(id, stepId);
  const openedAt = existing && existing.openedAt ? existing.openedAt : new Date().toISOString();
  let durationDays = body.durationDays != null ? parseInt(body.durationDays, 10) : null;
  let dueAt = null;
  if (body.dueAt) {
    const d = new Date(body.dueAt);
    if (isNaN(d.getTime())) return res.status(400).json({ message: 'dueAt khÃ´ng há»£p lá»‡' });
    dueAt = d.toISOString();
  } else {
    if (!Number.isFinite(durationDays) || durationDays <= 0) return res.status(400).json({ message: 'durationDays pháº£i > 0' });
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
  return res.json({ message: 'ÄÃ£ cáº­p nháº­t deadline bÆ°á»›c ' + stepId, stepId, openedAt, dueAt, durationDays, updatedAt });
});

// BÆ°á»›c 5 â€” ThÆ° kÃ½ HÄKHCN / Admin: cáº­p nháº­t thÃ´ng tin há»p Há»™i Ä‘á»“ng KHCN (hiá»ƒn thá»‹ trÃªn timeline)
app.put('/api/cap-vien/submissions/:id/steps/5/hd-meeting', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c cáº­p nháº­t thÃ´ng tin há»p.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
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
  insertCapVienHistory(id, '5', 'hd_meeting_info_update', req.user.id, role === 'admin' ? 'admin' : 'secretary', 'Cáº­p nháº­t thÃ´ng tin há»p HÄ KHCN', updatedAt);
  const subMeta = db.prepare('SELECT title, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  const researcherH = subMeta && subMeta.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(subMeta.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: subMeta ? subMeta.title : '',
    submissionId: id,
    subjectLine: '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 â€” Cáº­p nháº­t thÃ´ng tin há»p HÄ KHCN â€” ' + (subMeta ? subMeta.title : ''),
    bodyHtml: '<p><strong>ThÃ´ng tin há»p Há»™i Ä‘á»“ng KHCN</strong> cá»§a Ä‘á» tÃ i <strong>' + capVienEmailEsc(subMeta ? subMeta.title : '') + '</strong> Ä‘Ã£ Ä‘Æ°á»£c cáº­p nháº­t trÃªn há»‡ thá»‘ng.</p><p>KÃ­nh má»i Chá»§ nhiá»‡m vÃ  cÃ¡c thÃ nh viÃªn liÃªn quan xem chi tiáº¿t táº¡i BÆ°á»›c 5.</p>',
    bodyText: 'ÄÃ£ cáº­p nháº­t thÃ´ng tin há»p HÄ KHCN â€” ' + (subMeta ? subMeta.title : ''),
    councilList: getNotificationEmails(),
    researcherEmail: researcherH ? researcherH.email : null
  });
  return res.json({ message: 'ÄÃ£ lÆ°u thÃ´ng tin há»p HÄ KHCN.', updatedAt });
});

// BÆ°á»›c 5 â€” ThÆ° kÃ½ HÄKHCN / Admin: upload biÃªn báº£n há»p HÄ KHCN (lÆ°u file + lá»‹ch sá»­)
app.post('/api/cap-vien/submissions/:id/steps/5/upload-minutes', authMiddleware, (req, res, next) => {
  uploadCapVien.single('bien_ban_hop')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload tháº¥t báº¡i: ' + (err.message || 'Dá»¯ liá»‡u file khÃ´ng há»£p lá»‡') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p biÃªn báº£n há»p.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ ná»™p biÃªn báº£n khi há»“ sÆ¡ Ä‘Ã£ Ä‘áº¿n BÆ°á»›c 5 (sau BÆ°á»›c 4 & 4A), hoáº·c Ä‘ang á»Ÿ tráº¡ng thÃ¡i sau há»p (CONDITIONAL).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃ²ng chá»n file biÃªn báº£n há»p (PDF, Word).' });

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

  const note = 'Upload biÃªn báº£n há»p HÄ KHCN: ' + storedName;
  insertCapVienHistory(id, '5', 'step5_bien_ban_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-minutes â€” submission ' + id);
  const researcherBb = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 â€” ÄÃ£ upload biÃªn báº£n há»p HÄ â€” ' + sub.title,
    bodyHtml: '<p><strong>BiÃªn báº£n há»p Há»™i Ä‘á»“ng KHCN</strong> (file: ' + capVienEmailEsc(storedName) + ') cho Ä‘á» tÃ i <strong>' + capVienEmailEsc(sub.title) + '</strong> Ä‘Ã£ Ä‘Æ°á»£c lÆ°u trÃªn há»‡ thá»‘ng.</p>',
    bodyText: 'ÄÃ£ upload biÃªn báº£n há»p HÄ â€” ' + sub.title + ' â€” ' + storedName,
    councilList: getNotificationEmails(),
    researcherEmail: researcherBb ? researcherBb.email : null
  });
  return res.json({ message: 'ÄÃ£ lÆ°u biÃªn báº£n há»p vÃ o há»“ sÆ¡.', fileName: storedName });
});

// BÆ°á»›c 5 â€” ThÆ° kÃ½ / Admin: upload thÃªm tÃ i liá»‡u kÃ¨m (nháº­n xÃ©t UV HÄ, v.v.) â€” khÃ´ng thay tháº¿ biÃªn báº£n chÃ­nh
app.post('/api/cap-vien/submissions/:id/steps/5/upload-step5-extras', authMiddleware, (req, res, next) => {
  uploadCapVien.array('step5_extra_files', 30)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload tháº¥t báº¡i: ' + (err.message || 'Dá»¯ liá»‡u file khÃ´ng há»£p lá»‡') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p tÃ i liá»‡u kÃ¨m.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ ná»™p tÃ i liá»‡u khi há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 5 (REVIEWED / IN_MEETING / CONDITIONAL).' });
  }
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ message: 'Vui lÃ²ng chá»n Ã­t nháº¥t má»™t file.' });

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
    return res.status(400).json({ message: 'KhÃ´ng lÆ°u Ä‘Æ°á»£c file nÃ o.' });
  }
  const note = 'TÃ i liá»‡u kÃ¨m BÆ°á»›c 5: ' + savedNames.join(', ');
  insertCapVienHistory(id, '5', 'step5_extra_file_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-step5-extras â€” submission ' + id + ', count ' + savedNames.length);
  const researcherEx = sub.submittedById ? db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Äá» tÃ i cáº¥p Viá»‡n Táº¿ bÃ o gá»‘c]: BÆ°á»›c 5 â€” TÃ i liá»‡u kÃ¨m má»›i (' + savedNames.length + ') â€” ' + sub.title,
    bodyHtml: '<p>ÄÃ£ bá»• sung <strong>' + savedNames.length + '</strong> tÃ i liá»‡u kÃ¨m táº¡i BÆ°á»›c 5 cho Ä‘á» tÃ i <strong>' + capVienEmailEsc(sub.title) + '</strong>: ' + capVienEmailEsc(savedNames.join(', ')) + '.</p>',
    bodyText: 'TÃ i liá»‡u kÃ¨m BÆ°á»›c 5 â€” ' + sub.title + ': ' + savedNames.join(', '),
    councilList: getNotificationEmails(),
    researcherEmail: researcherEx ? researcherEx.email : null
  });
  return res.json({ message: 'ÄÃ£ lÆ°u ' + savedNames.length + ' tÃ i liá»‡u kÃ¨m.', fileNames: savedNames });
});

// BÆ°á»›c 5 â€” ThÆ° kÃ½ / Admin: yÃªu cáº§u Chá»§ nhiá»‡m chá»‰nh sá»­a theo gÃ³p Ã½ Há»™i Ä‘á»“ng (má»Ÿ vÃ²ng láº·p)
app.post('/api/cap-vien/submissions/:id/steps/5/council-request-revision', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i gá»­i yÃªu cáº§u chá»‰nh sá»­a nÃ y.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ Ã¡p dá»¥ng khi há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 5 (tráº¡ng thÃ¡i REVIEWED hoáº·c IN_MEETING).' });
  }
  const revSt = (sub.step5_council_revision_status || '').trim();
  if (revSt === 'waiting_researcher') {
    return res.status(400).json({ message: 'Äang chá» Chá»§ nhiá»‡m ná»™p há»“ sÆ¡ chá»‰nh sá»­a. HoÃ n táº¥t vÃ²ng nÃ y trÆ°á»›c khi gá»­i yÃªu cáº§u má»›i.' });
  }
  if (revSt === 'waiting_chair') {
    return res.status(400).json({ message: 'Äang chá» Chá»§ tá»‹ch HÄKHCN xem xÃ©t báº£n chá»‰nh sá»­a.' });
  }
  const body = req.body || {};
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p ná»™i dung gÃ³p Ã½ / yÃªu cáº§u chá»‰nh sá»­a.' });
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
  insertCapVienHistory(id, '5', 'step5_council_request_revision', req.user.id, roleDb, '[VÃ²ng ' + nextRound + '] ' + note, requestedAt);
  console.log('[API] cap-vien step 5 council-request-revision â€” submission ' + id + ', round ' + nextRound);
  const researcherR = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryRevisionRequestEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round: nextRound,
    note,
    requestedByName: req.user.fullname || req.user.email,
    researcherEmail: researcherR ? researcherR.email : null,
    councilList: getNotificationEmails('cap_vien_step5_secretary_revision_notice')
  });
  return res.json({ message: 'ÄÃ£ gá»­i yÃªu cáº§u chá»‰nh sá»­a tá»›i Chá»§ nhiá»‡m (vÃ²ng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// BÆ°á»›c 5 â€” Chá»§ nhiá»‡m / Admin: ná»™p há»“ sÆ¡ chá»‰nh sá»­a theo gÃ³p Ã½ Há»™i Ä‘á»“ng
app.post('/api/cap-vien/submissions/:id/steps/5/council-revision-upload', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload tháº¥t báº¡i: ' + (err.message || 'Dá»¯ liá»‡u file khÃ´ng há»£p lá»‡') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_researcher') {
    return res.status(400).json({ message: 'Chá»‰ Ä‘Æ°á»£c ná»™p khi Há»™i Ä‘á»“ng Ä‘Ã£ gá»­i yÃªu cáº§u chá»‰nh sá»­a (Ä‘ang chá» Chá»§ nhiá»‡m).' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p há»“ sÆ¡ chá»‰nh sá»­a.' });
  }
  const fList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!fList.length) {
    return res.status(400).json({ message: 'Vui lÃ²ng chá»n Ã­t nháº¥t má»™t file.' });
  }
  const round = sub.step5_council_revision_round || 1;
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const ts = Date.now();
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'Chá»§ nhiá»‡m Ä‘á» tÃ i' : 'Admin';
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
  insertCapVienHistory(id, '5', 'step5_council_revision_upload', req.user.id, uploaderRole, uploaderRoleLabel + ' ná»™p ' + fList.length + ' file (vÃ²ng ' + round + ')', uploadedAt);
  console.log('[API] cap-vien step 5 council-revision-upload â€” submission ' + id + ', round ' + round);
  const researcherUp = sub.submittedById ? db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5RevisionUploadedEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round,
    fileCount: fList.length,
    uploaderName: req.user.fullname || req.user.email || uploaderRoleLabel,
    councilList: getNotificationEmails('cap_vien_step5_revision_uploaded_notice'),
    researcherEmail: researcherUp ? researcherUp.email : null
  });
  return res.json({ message: 'ÄÃ£ lÆ°u há»“ sÆ¡ chá»‰nh sá»­a. Chá»§ tá»‹ch HÄKHCN sáº½ thÃ´ng qua hoáº·c yÃªu cáº§u chá»‰nh sá»­a tiáº¿p.', status: 'waiting_chair', round });
});

// BÆ°á»›c 5 â€” Chá»§ tá»‹ch HÄKHCN / ThÆ° kÃ½ / Admin: thÃ´ng qua báº£n chá»‰nh sá»­a hoáº·c yÃªu cáº§u chá»‰nh sá»­a tiáº¿p
app.post('/api/cap-vien/submissions/:id/steps/5/council-revision-chair', authMiddleware, (req, res) => {
  if (!roleIsAny(req, ['admin', 'chu_tich', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ Chá»§ tá»‹ch HÄKHCN, ThÆ° kÃ½ hoáº·c Admin má»›i thá»±c hiá»‡n bÆ°á»›c nÃ y.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_chair') {
    return res.status(400).json({ message: 'KhÃ´ng cÃ³ báº£n chá»‰nh sá»­a Ä‘ang chá» Chá»§ tá»‹ch xem xÃ©t.' });
  }
  const body = req.body || {};
  const action = String(body.action || '').toLowerCase().trim();
  if (!['approve', 'request_more'].includes(action)) {
    return res.status(400).json({ message: 'action pháº£i lÃ  approve hoáº·c request_more' });
  }
  const performedAt = new Date().toISOString();
  const roleDb = roleIs(req, 'admin') ? 'admin' : (roleIs(req, 'thu_ky') ? 'secretary' : 'chu_tich');
  const chairOrActorName = req.user.fullname || req.user.email;
  const researcherCh = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  if (action === 'approve') {
    const roundAp = sub.step5_council_revision_round || 1;
    db.prepare(`UPDATE cap_vien_submissions SET
      step5_council_revision_status = NULL,
      step5_council_revision_note = NULL,
      step5_council_revision_requested_at = NULL,
      step5_council_revision_requested_by = NULL
      WHERE id = ?`).run(id);
    insertCapVienHistory(id, '5', 'step5_chair_approve_revision', req.user.id, roleDb, 'Cháº¥p nháº­n há»“ sÆ¡ chá»‰nh sá»­a (vÃ²ng ' + roundAp + ')', performedAt);
    console.log('[API] cap-vien step 5 council-revision-chair approve â€” submission ' + id);
    sendCapVienStep5ChairApprovedRevisionEmail({
      submissionTitle: sub.title,
      submissionId: id,
      round: roundAp,
      chairName: chairOrActorName,
      researcherEmail: researcherCh ? researcherCh.email : null,
      researcherName: researcherCh ? researcherCh.fullname : null,
      councilList: getNotificationEmails('cap_vien_step5_chair_approved_notice')
    });
    return res.json({ message: 'ÄÃ£ thÃ´ng qua báº£n chá»‰nh sá»­a. CÃ³ thá»ƒ tiáº¿p tá»¥c quy trÃ¬nh BÆ°á»›c 5 (ghi nháº­n thÃ´ng qua Há»™i Ä‘á»“ng hoáº·c yÃªu cáº§u vÃ²ng má»›i).', status: null });
  }
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p gÃ³p Ã½ khi yÃªu cáº§u chá»‰nh sá»­a tiáº¿p.' });
  const nextRound = (sub.step5_council_revision_round || 1) + 1;
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_council_revision_round = ?,
    step5_council_revision_status = 'waiting_researcher',
    step5_council_revision_note = ?,
    step5_council_revision_requested_at = ?,
    step5_council_revision_requested_by = ?
    WHERE id = ?`).run(nextRound, note, performedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'step5_chair_request_more_revision', req.user.id, roleDb, '[VÃ²ng ' + nextRound + '] ' + note, performedAt);
  console.log('[API] cap-vien step 5 council-revision-chair request_more â€” submission ' + id + ', round ' + nextRound);
  sendCapVienStep5ChairRequestMoreEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round: nextRound,
    note,
    chairName: chairOrActorName,
    researcherEmail: researcherCh ? researcherCh.email : null,
    councilList: getNotificationEmails('cap_vien_step5_chair_request_more_notice')
  });
  return res.json({ message: 'ÄÃ£ yÃªu cáº§u Chá»§ nhiá»‡m chá»‰nh sá»­a tiáº¿p (vÃ²ng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// BÆ°á»›c 5 â€” ThÆ° kÃ½ / Admin: ghi nháº­n Há»™i Ä‘á»“ng KHCN thÃ´ng qua â†’ chuyá»ƒn tráº¡ng thÃ¡i sang BÆ°á»›c 6 (CONDITIONAL)
app.post('/api/cap-vien/submissions/:id/steps/5/council-pass', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chá»‰ ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i ghi nháº­n thÃ´ng qua Há»™i Ä‘á»“ng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, step5_council_revision_status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ ghi nháº­n thÃ´ng qua khi há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 5 (REVIEWED / IN_MEETING).' });
  }
  if (sub.step5_council_revision_status) {
    return res.status(400).json({ message: 'Äang cÃ³ vÃ²ng chá»‰nh sá»­a theo gÃ³p Ã½ Há»™i Ä‘á»“ng chÆ°a Ä‘Ã³ng. Chá» Chá»§ tá»‹ch thÃ´ng qua báº£n chá»‰nh sá»­a hoáº·c hoÃ n táº¥t vÃ²ng nÃ y.' });
  }
  const performedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'secretary';
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
  insertCapVienHistory(id, '5', 'step5_council_pass_hd', req.user.id, roleDb, 'Ghi nháº­n Há»™i Ä‘á»“ng KHCN thÃ´ng qua â€” chuyá»ƒn sang BÆ°á»›c 6', performedAt);
  console.log('[API] cap-vien step 5 council-pass â€” submission ' + id);
  const researcherPass = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5CouncilPassedEmail({
    submissionTitle: sub.title,
    submissionId: id,
    researcherEmail: researcherPass ? researcherPass.email : null,
    researcherName: researcherPass ? researcherPass.fullname : null,
    councilList: getNotificationEmails('cap_vien_step5_council_passed_notice'),
    recordedByName: req.user.fullname || req.user.email
  });
  return res.json({ message: 'ÄÃ£ ghi nháº­n Há»™i Ä‘á»“ng KHCN thÃ´ng qua. Há»“ sÆ¡ chuyá»ƒn sang BÆ°á»›c 6 (Cáº¥p Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t).', status: 'CONDITIONAL' });
});

// Danh sÃ¡ch thÃ nh viÃªn Há»™i Ä‘á»“ng KHCN (Chá»§ tá»‹ch, ThÆ° kÃ½, ThÃ nh viÃªn) â€” Ä‘á»ƒ Chá»§ tá»‹ch phÃ¢n cÃ´ng pháº£n biá»‡n
app.get('/api/cap-vien/council', authMiddleware, (req, res) => {
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'Chá»‰ thÃ nh viÃªn Há»™i Ä‘á»“ng hoáº·c Admin má»›i xem Ä‘Æ°á»£c danh sÃ¡ch' });
  const rows = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']);
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname || r.email || '',
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Admin' : (r.role === 'chu_tich' ? 'Chá»§ tá»‹ch HÄKHCN' : r.role === 'thu_ky' ? 'ThÆ° kÃ½ HÄKHCN' : 'ThÃ nh viÃªn HÄKHCN')
  }));
  return res.json({ council });
});

// BÆ°á»›c quy trÃ¬nh Äá» tÃ i cáº¥p Viá»‡n: ThÆ° kÃ½ HÄKHCN â€” BÆ°á»›c 2 (Kiá»ƒm tra há»“ sÆ¡): ÄÃ¡nh dáº¥u Há»£p lá»‡ / YÃªu cáº§u bá»• sung
app.post('/api/cap-vien/submissions/:id/steps/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = req.params.step;
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedBy, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const role = req.user.role;
  const isSecretaryOrAdmin = roleIsAny(req, ['admin', 'thu_ky']);
  if (step === '2') {
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const currentStatus = sub.status || 'SUBMITTED';
    const roleLower = (role || '').toLowerCase();

    // Chá»‰ Admin má»›i Ä‘Æ°á»£c Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2 Ä‘á»ƒ kiá»ƒm tra láº¡i
    if (action === 'revert') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2 (kiá»ƒm tra láº¡i)' });
      }
      if (currentStatus === 'SUBMITTED') {
        return res.status(400).json({ message: 'Há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 2, khÃ´ng cáº§n Ä‘Æ°a vá»' });
      }
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
        .run('SUBMITTED', id);
      insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2 Ä‘á»ƒ kiá»ƒm tra láº¡i');
      console.log('[API] cap-vien step 2 revert â€” submission ' + id);
      return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2. ThÆ° kÃ½ cÃ³ thá»ƒ nháº¥n Há»£p lá»‡ hoáº·c YÃªu cáº§u bá»• sung láº¡i.', status: 'SUBMITTED' });
    }

    if (!isSecretaryOrAdmin) {
      return res.status(403).json({ message: 'Chá»‰ ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c thá»±c hiá»‡n BÆ°á»›c 2 (Kiá»ƒm tra há»“ sÆ¡)' });
    }
    if (currentStatus !== 'SUBMITTED') {
      return res.status(400).json({ message: 'Há»“ sÆ¡ nÃ y Ä‘Ã£ Ä‘Æ°á»£c xá»­ lÃ½ táº¡i BÆ°á»›c 2. Chá»‰ Admin má»›i cÃ³ thá»ƒ Ä‘Æ°a vá» Ä‘á»ƒ kiá»ƒm tra láº¡i.' });
    }
    if (action === 'approve') {
      const reviewedAt = new Date().toISOString();
      const note = (payload.note || '').trim();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('VALIDATED', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_approve', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note || 'Há»£p lá»‡');
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
      console.log('[API] cap-vien step 2 approve â€” submission ' + id);
      return res.json({ message: 'ÄÃ£ Há»£p lá»‡. Há»“ sÆ¡ chuyá»ƒn sang BÆ°á»›c 3.', status: 'VALIDATED' });
    }
    if (action === 'request_revision') {
      const note = (payload.note || '').trim();
      if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p ná»™i dung yÃªu cáº§u bá»• sung' });
      const reviewedAt = new Date().toISOString();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('NEED_REVISION', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_request_revision', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note);
      const secretaryName = (req.user.fullname || req.user.email || 'ThÆ° kÃ½').toString();
      const rowSub = db.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
      const researcherName = rowSub && rowSub.submittedById ? (db.prepare('SELECT fullname FROM users WHERE id = ?').get(rowSub.submittedById) || {}).fullname : null;
      sendCapVienStep2RevisionEmail(sub.title, sub.submittedBy || null, note, secretaryName, id, researcherName);
      console.log('[API] cap-vien step 2 request_revision â€” submission ' + id);
      return res.json({ message: 'ÄÃ£ ghi nháº­n yÃªu cáº§u bá»• sung. Ná»™i dung Ä‘Ã£ gá»­i nghiÃªn cá»©u viÃªn vÃ  thÃ´ng bÃ¡o cho Há»™i Ä‘á»“ng.', status: 'NEED_REVISION' });
    }
    return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡. DÃ¹ng action: approve, request_revision hoáº·c revert (chá»‰ Admin)' });
  }
  if (step === '3') {
    const isChairmanOrAdmin = roleIsAny(req, ['admin', 'chu_tich']);
    if (!isChairmanOrAdmin) {
      return res.status(403).json({ message: 'Chá»‰ Chá»§ tá»‹ch HÄKHCN hoáº·c Admin má»›i Ä‘Æ°á»£c phÃ¢n cÃ´ng pháº£n biá»‡n' });
    }
    if ((sub.status || '') !== 'VALIDATED') {
      return res.status(400).json({ message: 'Chá»‰ cÃ³ thá»ƒ phÃ¢n cÃ´ng pháº£n biá»‡n khi há»“ sÆ¡ Ä‘Ã£ Há»£p lá»‡ (BÆ°á»›c 2 xong)' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'assign') {
      return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡. DÃ¹ng action: assign' });
    }
    let reviewerIds = (payload.reviewerIds || body.reviewerIds || []).map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
    if (payload.reviewer1 && payload.reviewer2) {
      reviewerIds = [parseInt(payload.reviewer1, 10), parseInt(payload.reviewer2, 10)].filter(rid => rid > 0);
    }
    reviewerIds = [...new Set(reviewerIds)];
    if (reviewerIds.length < 2) {
      return res.status(400).json({ message: 'Vui lÃ²ng chá»n Ä‘á»§ 2 pháº£n biá»‡n tá»« danh sÃ¡ch thÃ nh viÃªn Há»™i Ä‘á»“ng' });
    }
    const councilIds = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']).map((r) => r.id);
    const invalid = reviewerIds.filter(rid => !councilIds.includes(rid));
    if (invalid.length > 0) {
      return res.status(400).json({ message: 'Táº¥t cáº£ pháº£n biá»‡n pháº£i lÃ  thÃ nh viÃªn Há»™i Ä‘á»“ng (Chá»§ tá»‹ch, ThÆ° kÃ½, ThÃ nh viÃªn HÄKHCN)' });
    }
    const assignedAt = new Date().toISOString();
    db.prepare('UPDATE cap_vien_submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ? WHERE id = ?')
      .run('ASSIGNED', JSON.stringify(reviewerIds), assignedAt, req.user.id, id);
    const reviewerNamesArr = db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '');
    insertCapVienHistory(id, '3', 'chairman_assign', req.user.id, role === 'admin' ? 'admin' : 'chairman', 'PhÃ¢n cÃ´ng 2 pháº£n biá»‡n: ' + reviewerNamesArr.join(', '));
    const chairmanName = (req.user.fullname || req.user.email || 'Chá»§ tá»‹ch').toString();
    const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
    const reviewerEmails = reviewers.map(r => r.email);
    const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
    sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
    sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
    console.log('[API] cap-vien step 3 assign â€” submission ' + id + ', reviewers: ' + reviewerIds.join(','));
    return res.json({ message: 'ÄÃ£ phÃ¢n cÃ´ng pháº£n biá»‡n. Email Ä‘Ã£ gá»­i Ä‘áº¿n cÃ¡c pháº£n biá»‡n, Há»™i Ä‘á»“ng vÃ  Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh.', status: 'ASSIGNED' });
  }
  if (step === '6') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 6 (Quyáº¿t Ä‘á»‹nh).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const sub6 = db.prepare('SELECT id, status, step6_so_qd FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub6) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
    if (action !== 'approve') {
      return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡. DÃ¹ng action: approve' });
    }
    if ((sub6.status || '').toUpperCase() !== 'CONDITIONAL') {
      return res.status(400).json({ message: 'Chá»‰ chuyá»ƒn BÆ°á»›c 7 khi há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 6 (tráº¡ng thÃ¡i sau BÆ°á»›c 5 â€” CONDITIONAL).' });
    }
    if (!String(sub6.step6_so_qd || '').trim()) {
      return res.status(400).json({ message: 'Vui lÃ²ng nháº­p vÃ  lÆ°u Sá»‘ Quyáº¿t Ä‘á»‹nh (má»¥c BÆ°á»›c 6) trÆ°á»›c khi hoÃ n táº¥t.' });
    }
    const hasVn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_vn' LIMIT 1").get(id);
    const hasEn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_en' LIMIT 1").get(id);
    if (!hasVn || !hasEn) {
      return res.status(400).json({ message: 'Cáº§n upload Ä‘á»§ file Quyáº¿t Ä‘á»‹nh tiáº¿ng Viá»‡t vÃ  tiáº¿ng Anh trÆ°á»›c khi hoÃ n táº¥t BÆ°á»›c 6.' });
    }
    const rowMail = db.prepare(`SELECT s.title, s.submittedBy, s.submittedById, s.step6_so_qd,
      u.email AS ownerEmail, u.fullname AS ownerName
      FROM cap_vien_submissions s
      LEFT JOIN users u ON u.id = s.submittedById
      WHERE s.id = ?`).get(id);
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('APPROVED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '6', 'step6_complete', req.user.id, roleDb, 'Ghi nháº­n hoÃ n thÃ nh Cáº¥p Quyáº¿t Ä‘á»‹nh â€” chuyá»ƒn BÆ°á»›c 7');
    console.log('[API] cap-vien step 6 approve â€” submission ' + id);
    const researcherEmail = ((rowMail && rowMail.ownerEmail) || (rowMail && rowMail.submittedBy) || '').trim();
    sendCapVienStep6CompletedEmail({
      submissionTitle: rowMail ? rowMail.title : '',
      submissionId: id,
      researcherEmail,
      researcherName: rowMail ? rowMail.ownerName : null,
      soQd: rowMail ? rowMail.step6_so_qd : sub6.step6_so_qd,
      // CC cáº£ Há»™i Ä‘á»“ng KHCN láº«n PhÃ²ng KHCN (PhÃ²ng KHCN lÃ  nÆ¡i Ä‘Ã£ nháº­n há»“ sÆ¡ ná»™p má»›i, cáº§n biáº¿t káº¿t quáº£ duyá»‡t cuá»‘i cÃ¹ng)
      councilList: Array.from(new Set([
        ...getNotificationEmails('cap_vien_step6_completed_notice'),
        ...getPhongKhcnEmails()
      ]))
    }).catch((err) => console.error('[Email] BÆ°á»›c 6 hoÃ n thÃ nh:', err && err.message));
    return res.json({ message: 'ÄÃ£ ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 6. Há»“ sÆ¡ chuyá»ƒn sang BÆ°á»›c 7 (KÃ½ há»£p Ä‘á»“ng). ÄÃ£ gá»­i thÃ´ng bÃ¡o hÃ nh chÃ­nh tá»›i Chá»§ nhiá»‡m (CC Há»™i Ä‘á»“ng KHCN & PhÃ²ng KHCN).', status: 'APPROVED' });
  }
  if (step === '7') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 7 (Há»£p Ä‘á»“ng KHCN).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'complete' && action !== 'confirm_signed') {
      return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡. DÃ¹ng action: complete' });
    }
    const sub7 = db.prepare('SELECT id, status, title, submittedBy, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub7) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
    if ((sub7.status || '').toUpperCase() !== 'APPROVED') {
      return res.status(400).json({ message: 'Chá»‰ hoÃ n thÃ nh BÆ°á»›c 7 khi há»“ sÆ¡ Ä‘ang á»Ÿ tráº¡ng thÃ¡i APPROVED (sau BÆ°á»›c 6).' });
    }
    const hasContract = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step7_hop_dong_khcn' LIMIT 1").get(id);
    if (!hasContract) {
      return res.status(400).json({ message: 'Cáº§n upload Há»£p Ä‘á»“ng KHCN vÃ o há»“ sÆ¡ trÆ°á»›c khi nháº¥n HoÃ n thÃ nh.' });
    }
    const sendMail = getCapVienStep7EmailOnComplete();
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONTRACTED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '7', 'step7_complete', req.user.id, roleDb, 'Ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 7 â€” Há»£p Ä‘á»“ng KHCN; chuyá»ƒn bÆ°á»›c tiáº¿p theo');
    console.log('[API] cap-vien step 7 complete â€” submission ' + id + ', email=' + sendMail);
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
        councilList: getNotificationEmails('cap_vien_step7_completed_notice')
      }).catch((err) => console.error('[Email] BÆ°á»›c 7 hoÃ n thÃ nh:', err && err.message));
    }
    const msg = sendMail
      ? 'ÄÃ£ ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 7. Há»“ sÆ¡ chuyá»ƒn sang bÆ°á»›c tiáº¿p theo (Ä‘Äƒng kÃ½ Ä‘áº¡o Ä‘á»©c / táº¡m á»©ngâ€¦). ÄÃ£ gá»­i email thÃ´ng bÃ¡o hÃ nh chÃ­nh tá»›i Chá»§ nhiá»‡m (CC Há»™i Ä‘á»“ng KHCN nháº­n thÃ´ng bÃ¡o).'
      : 'ÄÃ£ ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 7. Há»“ sÆ¡ chuyá»ƒn sang bÆ°á»›c tiáº¿p theo. (Admin Ä‘Ã£ táº¯t gá»­i email tá»± Ä‘á»™ng.)';
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
    if (!sub8) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
    if ((sub8.status || '').toUpperCase() !== 'CONTRACTED') {
      return res.status(400).json({ message: 'Chá»‰ thao tÃ¡c BÆ°á»›c 8 khi há»“ sÆ¡ Ä‘Ã£ kÃ½ há»£p Ä‘á»“ng (CONTRACTED).' });
    }
    if (action === 'admin_bypass') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c bypass BÆ°á»›c 8 (Ä‘Ã¡nh dáº¥u hoÃ n thÃ nh thá»§ cÃ´ng).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'BÆ°á»›c 8 Ä‘Ã£ hoÃ n thÃ nh.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1, step8_waived = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_bypass', req.user.id, 'admin', 'Admin bypass BÆ°á»›c 8 â€” hoÃ n thÃ nh khÃ´ng qua Ä‘á»§ Ä‘iá»u kiá»‡n thÃ´ng thÆ°á»ng');
      console.log('[API] cap-vien step 8 admin_bypass â€” submission ' + id);
      return res.json({ message: 'ÄÃ£ bypass BÆ°á»›c 8 (Ä‘Ã¡nh dáº¥u hoÃ n thÃ nh).', status: 'CONTRACTED' });
    }
    if (action === 'admin_waive') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c báº¥t hoáº¡t BÆ°á»›c 8 (khÃ´ng Ã¡p dá»¥ng cho Ä‘á» tÃ i nÃ y).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'ÄÃ£ hoÃ n thÃ nh BÆ°á»›c 8; khÃ´ng thá»ƒ báº¥t hoáº¡t. CÃ³ thá»ƒ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 7 (Admin) náº¿u cáº§n lÃ m láº¡i.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_waived = 1, step8_completed = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_waive', req.user.id, 'admin', 'Admin báº¥t hoáº¡t BÆ°á»›c 8 â€” Ä‘Äƒng kÃ½ Ä‘áº¡o Ä‘á»©c khÃ´ng Ã¡p dá»¥ng cho Ä‘á» tÃ i nÃ y');
      console.log('[API] cap-vien step 8 admin_waive â€” submission ' + id);
      return res.json({ message: 'ÄÃ£ Ä‘Ã¡nh dáº¥u BÆ°á»›c 8 khÃ´ng Ã¡p dá»¥ng cho Ä‘á» tÃ i nÃ y.', status: 'CONTRACTED' });
    }
    if (action !== 'complete') {
      return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡. DÃ¹ng: complete, admin_bypass, admin_waive (Admin).' });
    }
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN, ThÆ° kÃ½ HÄKHCN hoáº·c Admin má»›i ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 8 (Äáº¡o Ä‘á»©c).' });
    }
    if (sub8.step8_waived === 1 || sub8.step8_waived === true) {
      return res.status(400).json({ message: 'BÆ°á»›c 8 Ä‘Ã£ Ä‘Æ°á»£c Ä‘Ã¡nh dáº¥u khÃ´ng Ã¡p dá»¥ng (báº¥t hoáº¡t).' });
    }
    if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
      return res.status(400).json({ message: 'BÆ°á»›c 8 Ä‘Ã£ Ä‘Æ°á»£c Ä‘Ã¡nh dáº¥u hoÃ n thÃ nh trÆ°á»›c Ä‘Ã³.' });
    }
    if (!String(sub8.step8_ma_dao_duc || '').trim()) {
      return res.status(400).json({ message: 'Vui lÃ²ng nháº­p vÃ  lÆ°u MÃ£ Ä‘áº¡o Ä‘á»©c trÆ°á»›c khi hoÃ n táº¥t BÆ°á»›c 8.' });
    }
    const hasEthicsFile = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step8_ethics_quyet_dinh' LIMIT 1").get(id);
    if (!hasEthicsFile) {
      return res.status(400).json({ message: 'Cáº§n upload Quyáº¿t Ä‘á»‹nh Ä‘áº¡o Ä‘á»©c trÆ°á»›c khi hoÃ n táº¥t BÆ°á»›c 8.' });
    }
    db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1 WHERE id = ?').run(id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '8', 'step8_complete', req.user.id, roleDb, 'HoÃ n thÃ nh BÆ°á»›c 8 â€” ÄÄƒng kÃ½/Cáº¥p mÃ£ Ä‘áº¡o Ä‘á»©c');
    console.log('[API] cap-vien step 8 complete â€” submission ' + id);
    return res.json({
      message: 'ÄÃ£ ghi nháº­n hoÃ n thÃ nh BÆ°á»›c 8. CÃ³ thá»ƒ tiáº¿p tá»¥c cÃ¡c bÆ°á»›c tiáº¿p theo theo quy trÃ¬nh (BÆ°á»›c 9 trá»Ÿ Ä‘i).',
      status: 'CONTRACTED'
    });
  }
  if (step === '8a') {
    return res.status(410).json({ message: 'BÆ°á»›c 8A Ä‘Ã£ Ä‘Æ°á»£c gá»¡ khá»i quy trÃ¬nh; khÃ´ng cÃ²n thao tÃ¡c táº¡i endpoint nÃ y.' });
  }
  if (step === '9') {
    const isOwner = sub.submittedById === req.user.id;
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c khai bÃ¡o má»‘c hoáº¡t Ä‘á»™ng BÆ°á»›c 9.' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const nowIso = new Date().toISOString();
    const historyRole = isOwner ? 'researcher' : 'admin';

    if (action === 'add_milestone') {
      const title = String(payload.title || '').trim();
      if (!title) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p tÃªn má»‘c hoáº¡t Ä‘á»™ng' });
      const eventDate = payload.eventDate ? String(payload.eventDate).trim() : null;
      const note = payload.note ? String(payload.note).trim() : null;
      const maxRow = db.prepare('SELECT COALESCE(MAX(sortOrder), 0) AS m FROM cap_vien_step9_milestone WHERE submissionId = ? AND deletedAt IS NULL').get(id);
      const sortOrder = (maxRow.m || 0) + 1;
      const ins = db.prepare(
        'INSERT INTO cap_vien_step9_milestone (submissionId, title, status, eventDate, note, sortOrder, createdAt, createdById) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, title, 'planned', eventDate, note, sortOrder, nowIso, req.user.id);
      insertCapVienHistory(id, '9', 'milestone_add', req.user.id, historyRole, 'ThÃªm má»‘c hoáº¡t Ä‘á»™ng: ' + title);
      return res.json({ message: 'ÄÃ£ thÃªm má»‘c hoáº¡t Ä‘á»™ng.', milestoneId: ins.lastInsertRowid });
    }

    if (action === 'update_milestone') {
      const milestoneId = parseInt(payload.milestoneId, 10);
      if (!milestoneId) return res.status(400).json({ message: 'Thiáº¿u milestoneId' });
      const m = db.prepare('SELECT id, title FROM cap_vien_step9_milestone WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(milestoneId, id);
      if (!m) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y má»‘c hoáº¡t Ä‘á»™ng' });
      const allowedStatus = ['planned', 'in_progress', 'done'];
      const updates = [];
      const params = [];
      if (payload.title !== undefined) {
        const t = String(payload.title || '').trim();
        if (!t) return res.status(400).json({ message: 'TÃªn má»‘c hoáº¡t Ä‘á»™ng khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
        updates.push('title = ?'); params.push(t);
      }
      if (payload.eventDate !== undefined) { updates.push('eventDate = ?'); params.push(payload.eventDate ? String(payload.eventDate).trim() : null); }
      if (payload.note !== undefined) { updates.push('note = ?'); params.push(payload.note ? String(payload.note).trim() : null); }
      if (payload.status !== undefined) {
        const st = String(payload.status || '').toLowerCase().trim();
        if (!allowedStatus.includes(st)) return res.status(400).json({ message: 'Tráº¡ng thÃ¡i khÃ´ng há»£p lá»‡ (planned/in_progress/done)' });
        updates.push('status = ?'); params.push(st);
      }
      if (!updates.length) return res.status(400).json({ message: 'KhÃ´ng cÃ³ trÆ°á»ng nÃ o Ä‘á»ƒ cáº­p nháº­t' });
      updates.push('updatedAt = ?', 'updatedById = ?');
      params.push(nowIso, req.user.id, milestoneId);
      db.prepare('UPDATE cap_vien_step9_milestone SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
      insertCapVienHistory(id, '9', 'milestone_update', req.user.id, historyRole, 'Cáº­p nháº­t má»‘c hoáº¡t Ä‘á»™ng: ' + m.title);
      return res.json({ message: 'ÄÃ£ cáº­p nháº­t má»‘c hoáº¡t Ä‘á»™ng.' });
    }

    if (action === 'delete_milestone') {
      const milestoneId = parseInt(payload.milestoneId, 10);
      if (!milestoneId) return res.status(400).json({ message: 'Thiáº¿u milestoneId' });
      const m = db.prepare('SELECT id, title FROM cap_vien_step9_milestone WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(milestoneId, id);
      if (!m) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y má»‘c hoáº¡t Ä‘á»™ng' });
      db.prepare('UPDATE cap_vien_step9_milestone SET deletedAt = ? WHERE id = ?').run(nowIso, milestoneId);
      insertCapVienHistory(id, '9', 'milestone_delete', req.user.id, historyRole, 'XÃ³a má»‘c hoáº¡t Ä‘á»™ng: ' + m.title);
      return res.json({ message: 'ÄÃ£ xÃ³a má»‘c hoáº¡t Ä‘á»™ng.' });
    }

    return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡. DÃ¹ng action: add_milestone, update_milestone hoáº·c delete_milestone' });
  }
  return res.status(404).json({ message: 'BÆ°á»›c ' + step + ' chÆ°a Ä‘Æ°á»£c triá»ƒn khai táº¡i backend' });
});

// BÆ°á»›c 9 â€” HoÃ¡ cháº¥t, váº­t tÆ°: danh má»¥c dá»± toÃ¡n (Chá»§ nhiá»‡m/Admin khai bÃ¡o, Admin/PhÃ²ng KHCN khoÃ¡ láº¡i lÃ m
// sá»‘ liá»‡u chÃ­nh thá»©c) + cáº¥p phÃ¡t theo Ä‘á»£t (Chá»§ nhiá»‡m/Admin Ä‘á» nghá»‹, Admin/PhÃ²ng KHCN xÃ¡c nháº­n/tá»« chá»‘i,
// khÃ´ng cho vÆ°á»£t approvedQty). Route riÃªng (khÃ´ng dÃ¹ng chung dispatcher steps/:step á»Ÿ trÃªn) vÃ¬ action
// lock_catalog/confirm_issuance/reject_issuance cáº§n thÃªm vai trÃ² PhÃ²ng KHCN, khÃ¡c gate owner||admin cá»§a
// milestone.
app.post('/api/cap-vien/submissions/:id/step9-supply/action', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, submittedById, budget_4a_status, step9_supply_locked_at FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  const isPhongKhcnOrAdmin = roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky']);
  const ownerHistoryRole = isOwner ? 'researcher' : 'admin';
  const staffHistoryRole = capVienStep6HistoryRoleDb(req.user.role);
  const body = req.body || {};
  const payload = body.payload || {};
  const actionRaw = body.action || payload.action || '';
  const action = String(actionRaw).toLowerCase().trim();
  const nowIso = new Date().toISOString();
  const locked = !!sub.step9_supply_locked_at;

  function getItem(itemId) {
    return db.prepare('SELECT * FROM cap_vien_step9_supply_item WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(itemId, id);
  }
  function confirmedQtyForItem(itemId) {
    const r = db.prepare("SELECT COALESCE(SUM(qty), 0) AS s FROM cap_vien_step9_supply_issuance WHERE itemId = ? AND status = 'confirmed'").get(itemId);
    return r.s || 0;
  }

  if (action === 'add_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c khai bÃ¡o hoÃ¡ cháº¥t/váº­t tÆ°.' });
    if (locked) return res.status(400).json({ message: 'Danh má»¥c Ä‘Ã£ khoÃ¡, khÃ´ng thá»ƒ thÃªm má»¥c má»›i.' });
    const name = String(payload.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p tÃªn hoÃ¡ cháº¥t/váº­t tÆ°' });
    const unit = payload.unit ? String(payload.unit).trim() : null;
    const approvedQty = Number(payload.approvedQty);
    if (!isFinite(approvedQty) || approvedQty < 0) return res.status(400).json({ message: 'Sá»‘ lÆ°á»£ng duyá»‡t khÃ´ng há»£p lá»‡' });
    const approvedAmount = (payload.approvedAmount !== undefined && payload.approvedAmount !== null && payload.approvedAmount !== '') ? Number(payload.approvedAmount) : null;
    const note = payload.note ? String(payload.note).trim() : null;
    const ins = db.prepare(
      'INSERT INTO cap_vien_step9_supply_item (submissionId, name, unit, approvedQty, approvedAmount, note, createdAt, createdById) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, unit, approvedQty, approvedAmount, note, nowIso, req.user.id);
    insertCapVienHistory(id, '9', 'supply_add_item', req.user.id, ownerHistoryRole, 'ThÃªm hoÃ¡ cháº¥t/váº­t tÆ°: ' + name);
    return res.json({ message: 'ÄÃ£ thÃªm hoÃ¡ cháº¥t/váº­t tÆ°.', itemId: ins.lastInsertRowid });
  }

  if (action === 'update_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c sá»­a hoÃ¡ cháº¥t/váº­t tÆ°.' });
    if (locked) return res.status(400).json({ message: 'Danh má»¥c Ä‘Ã£ khoÃ¡, khÃ´ng thá»ƒ sá»­a.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'Thiáº¿u itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y má»¥c' });
    const updates = [];
    const params = [];
    if (payload.name !== undefined) {
      const n = String(payload.name || '').trim();
      if (!n) return res.status(400).json({ message: 'TÃªn khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
      updates.push('name = ?'); params.push(n);
    }
    if (payload.unit !== undefined) { updates.push('unit = ?'); params.push(payload.unit ? String(payload.unit).trim() : null); }
    if (payload.approvedQty !== undefined) {
      const q = Number(payload.approvedQty);
      if (!isFinite(q) || q < 0) return res.status(400).json({ message: 'Sá»‘ lÆ°á»£ng duyá»‡t khÃ´ng há»£p lá»‡' });
      updates.push('approvedQty = ?'); params.push(q);
    }
    if (payload.approvedAmount !== undefined) {
      const a = (payload.approvedAmount !== null && payload.approvedAmount !== '') ? Number(payload.approvedAmount) : null;
      updates.push('approvedAmount = ?'); params.push(a);
    }
    if (payload.note !== undefined) { updates.push('note = ?'); params.push(payload.note ? String(payload.note).trim() : null); }
    if (!updates.length) return res.status(400).json({ message: 'KhÃ´ng cÃ³ trÆ°á»ng nÃ o Ä‘á»ƒ cáº­p nháº­t' });
    updates.push('updatedAt = ?', 'updatedById = ?');
    params.push(nowIso, req.user.id, itemId);
    db.prepare('UPDATE cap_vien_step9_supply_item SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    return res.json({ message: 'ÄÃ£ cáº­p nháº­t.' });
  }

  if (action === 'delete_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c xÃ³a hoÃ¡ cháº¥t/váº­t tÆ°.' });
    if (locked) return res.status(400).json({ message: 'Danh má»¥c Ä‘Ã£ khoÃ¡, khÃ´ng thá»ƒ xÃ³a.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'Thiáº¿u itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y má»¥c' });
    db.prepare('UPDATE cap_vien_step9_supply_item SET deletedAt = ? WHERE id = ?').run(nowIso, itemId);
    return res.json({ message: 'ÄÃ£ xÃ³a.' });
  }

  if (action === 'lock_catalog') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c khoÃ¡ danh má»¥c.' });
    if (locked) return res.status(400).json({ message: 'Danh má»¥c Ä‘Ã£ Ä‘Æ°á»£c khoÃ¡ trÆ°á»›c Ä‘Ã³.' });
    if (String(sub.budget_4a_status || '').toLowerCase() !== 'approved') {
      return res.status(400).json({ message: 'Chá»‰ khoÃ¡ Ä‘Æ°á»£c khi BÆ°á»›c 4A (Tháº©m Ä‘á»‹nh dá»± toÃ¡n) Ä‘Ã£ Ä‘Æ°á»£c duyá»‡t.' });
    }
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM cap_vien_step9_supply_item WHERE submissionId = ? AND deletedAt IS NULL').get(id);
    if (!cnt.c) return res.status(400).json({ message: 'Danh má»¥c Ä‘ang trá»‘ng, chÆ°a cÃ³ má»¥c nÃ o Ä‘á»ƒ khoÃ¡.' });
    db.prepare('UPDATE cap_vien_submissions SET step9_supply_locked_at = ?, step9_supply_locked_by = ? WHERE id = ?').run(nowIso, req.user.id, id);
    insertCapVienHistory(id, '9', 'supply_lock_catalog', req.user.id, staffHistoryRole, 'KhoÃ¡ danh má»¥c hoÃ¡ cháº¥t/váº­t tÆ° (' + cnt.c + ' má»¥c)');
    return res.json({ message: 'ÄÃ£ khoÃ¡ danh má»¥c hoÃ¡ cháº¥t/váº­t tÆ°.' });
  }

  if (action === 'unlock_catalog') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c má»Ÿ khoÃ¡ danh má»¥c.' });
    if (!locked) return res.status(400).json({ message: 'Danh má»¥c chÆ°a khoÃ¡.' });
    db.prepare('UPDATE cap_vien_submissions SET step9_supply_locked_at = NULL, step9_supply_locked_by = NULL WHERE id = ?').run(id);
    insertCapVienHistory(id, '9', 'supply_unlock_catalog', req.user.id, staffHistoryRole, 'Má»Ÿ khoÃ¡ danh má»¥c hoÃ¡ cháº¥t/váº­t tÆ° Ä‘á»ƒ Chá»§ nhiá»‡m cáº­p nháº­t láº¡i');
    return res.json({ message: 'ÄÃ£ má»Ÿ khoÃ¡ danh má»¥c hoÃ¡ cháº¥t/váº­t tÆ°.' });
  }

  if (action === 'request_issuance') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c Ä‘á» nghá»‹ cáº¥p phÃ¡t.' });
    if (!locked) return res.status(400).json({ message: 'Danh má»¥c chÆ°a khoÃ¡, chÆ°a thá»ƒ Ä‘á» nghá»‹ cáº¥p phÃ¡t.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'Thiáº¿u itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y má»¥c' });
    const qty = Number(payload.qty);
    if (!isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'Sá»‘ lÆ°á»£ng Ä‘á» nghá»‹ khÃ´ng há»£p lá»‡' });
    const already = confirmedQtyForItem(itemId);
    if (already + qty > item.approvedQty + 1e-9) {
      return res.status(400).json({ message: 'VÆ°á»£t quÃ¡ sá»‘ lÆ°á»£ng Ä‘Ã£ duyá»‡t (cÃ²n láº¡i ' + (item.approvedQty - already) + ' ' + (item.unit || '') + ').' });
    }
    const issuedDate = payload.issuedDate ? String(payload.issuedDate).trim() : null;
    const note = payload.note ? String(payload.note).trim() : null;
    const ins = db.prepare(
      'INSERT INTO cap_vien_step9_supply_issuance (itemId, submissionId, qty, issuedDate, note, status, requestedById, requestedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(itemId, id, qty, issuedDate, note, 'requested', req.user.id, nowIso);
    insertCapVienHistory(id, '9', 'supply_request_issuance', req.user.id, ownerHistoryRole, 'Äá» nghá»‹ cáº¥p ' + qty + ' ' + (item.unit || '') + ' ' + item.name);
    return res.json({ message: 'ÄÃ£ gá»­i Ä‘á» nghá»‹ cáº¥p phÃ¡t, chá» PhÃ²ng KHCN xÃ¡c nháº­n.', issuanceId: ins.lastInsertRowid });
  }

  if (action === 'delete_issuance') {
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'Thiáº¿u issuanceId' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á»£t cáº¥p' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Chá»‰ xÃ³a Ä‘Æ°á»£c Ä‘á» nghá»‹ Ä‘ang chá» xÃ¡c nháº­n.' });
    if (!isAdmin && iss.requestedById !== req.user.id) return res.status(403).json({ message: 'Chá»‰ ngÆ°á»i Ä‘á» nghá»‹ hoáº·c Admin má»›i Ä‘Æ°á»£c xÃ³a Ä‘á» nghá»‹ nÃ y.' });
    db.prepare('DELETE FROM cap_vien_step9_supply_issuance WHERE id = ?').run(issuanceId);
    return res.json({ message: 'ÄÃ£ xÃ³a Ä‘á» nghá»‹ cáº¥p phÃ¡t.' });
  }

  if (action === 'confirm_issuance') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c xÃ¡c nháº­n cáº¥p phÃ¡t.' });
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'Thiáº¿u issuanceId' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á»£t cáº¥p' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Äá»£t cáº¥p nÃ y Ä‘Ã£ Ä‘Æ°á»£c xá»­ lÃ½.' });
    const item = getItem(iss.itemId);
    if (!item) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y má»¥c hoÃ¡ cháº¥t/váº­t tÆ° liÃªn quan' });
    const already = confirmedQtyForItem(iss.itemId);
    if (already + iss.qty > item.approvedQty + 1e-9) {
      return res.status(400).json({ message: 'KhÃ´ng thá»ƒ xÃ¡c nháº­n â€” tá»•ng Ä‘Ã£ cáº¥p sáº½ vÆ°á»£t sá»‘ lÆ°á»£ng Ä‘Ã£ duyá»‡t (cÃ²n láº¡i ' + (item.approvedQty - already) + ' ' + (item.unit || '') + ').' });
    }
    db.prepare('UPDATE cap_vien_step9_supply_issuance SET status = ?, decidedById = ?, decidedAt = ? WHERE id = ?').run('confirmed', req.user.id, nowIso, issuanceId);
    insertCapVienHistory(id, '9', 'supply_confirm_issuance', req.user.id, staffHistoryRole, 'XÃ¡c nháº­n cáº¥p ' + iss.qty + ' ' + (item.unit || '') + ' ' + item.name);
    return res.json({ message: 'ÄÃ£ xÃ¡c nháº­n cáº¥p phÃ¡t.' });
  }

  if (action === 'reject_issuance') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c tá»« chá»‘i cáº¥p phÃ¡t.' });
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'Thiáº¿u issuanceId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p lÃ½ do tá»« chá»‘i' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á»£t cáº¥p' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Äá»£t cáº¥p nÃ y Ä‘Ã£ Ä‘Æ°á»£c xá»­ lÃ½.' });
    db.prepare('UPDATE cap_vien_step9_supply_issuance SET status = ?, decidedById = ?, decidedAt = ?, decisionNote = ? WHERE id = ?').run('rejected', req.user.id, nowIso, note, issuanceId);
    insertCapVienHistory(id, '9', 'supply_reject_issuance', req.user.id, staffHistoryRole, 'Tá»« chá»‘i cáº¥p phÃ¡t: ' + note);
    return res.json({ message: 'ÄÃ£ tá»« chá»‘i Ä‘á» nghá»‹ cáº¥p phÃ¡t.' });
  }

  return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡.' });
});

// BÆ°á»›c 11: Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh (nhÃ¢n sá»±/káº¿ hoáº¡ch/dá»± toÃ¡n/gia háº¡n) â€” 2 cáº¥p PhÃ²ng KHCN -> Viá»‡n trÆ°á»Ÿng.
app.post('/api/cap-vien/submissions/:id/step11-adjustment/action', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  const isPhongKhcnOrAdmin = roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky']);
  const isDirectorOrAdmin = roleIsAny(req, ['admin', 'vien_truong']);
  const actorRole = (req.user.role || '').toLowerCase() || 'admin';
  const ownerHistoryRole = isOwner ? 'researcher' : 'admin';
  const body = req.body || {};
  const payload = body.payload || {};
  const actionRaw = body.action || payload.action || '';
  const action = String(actionRaw).toLowerCase().trim();
  const nowIso = new Date().toISOString();
  const ALLOWED_ADJUSTMENT_TYPES = ['nhan_su', 'ke_hoach', 'du_toan', 'gia_han', 'khac'];

  function getOpenAdjustmentRequest() {
    return db.prepare("SELECT id FROM cap_vien_step11_adjustment_request WHERE submissionId = ? AND status NOT IN ('approved','rejected') ORDER BY id DESC LIMIT 1").get(id);
  }
  function getAdjustmentRequest(requestId) {
    return db.prepare('SELECT * FROM cap_vien_step11_adjustment_request WHERE id = ? AND submissionId = ?').get(requestId, id);
  }

  if (action === 'submit_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh.' });
    if (getOpenAdjustmentRequest()) return res.status(400).json({ message: 'ÄÃ£ cÃ³ Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh Ä‘ang xá»­ lÃ½, vui lÃ²ng chá» hoÃ n táº¥t trÆ°á»›c khi ná»™p Ä‘á» xuáº¥t má»›i.' });
    const type = String(payload.type || '').toLowerCase().trim();
    if (!ALLOWED_ADJUSTMENT_TYPES.includes(type)) return res.status(400).json({ message: 'Loáº¡i Ä‘iá»u chá»‰nh khÃ´ng há»£p lá»‡' });
    const content = String(payload.content || '').trim();
    if (!content) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p ná»™i dung Ä‘á» xuáº¥t' });
    const ins = db.prepare(
      'INSERT INTO cap_vien_step11_adjustment_request (submissionId, type, content, status, requestedById, requestedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, type, content, 'submitted', req.user.id, nowIso);
    insertCapVienHistory(id, '11', 'adjustment_submit_request', req.user.id, ownerHistoryRole, 'Ná»™p Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh (' + type + ')');
    return res.json({ message: 'ÄÃ£ ná»™p Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh, chá» PhÃ²ng KHCN xem xÃ©t.', requestId: ins.lastInsertRowid });
  }

  if (action === 'update_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c sá»­a Ä‘á» xuáº¥t.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiáº¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (r.status !== 'khcn_need_revision') return res.status(400).json({ message: 'Chá»‰ sá»­a Ä‘Æ°á»£c khi PhÃ²ng KHCN yÃªu cáº§u bá»• sung.' });
    const updates = [];
    const params = [];
    if (payload.type !== undefined) {
      const t = String(payload.type || '').toLowerCase().trim();
      if (!ALLOWED_ADJUSTMENT_TYPES.includes(t)) return res.status(400).json({ message: 'Loáº¡i Ä‘iá»u chá»‰nh khÃ´ng há»£p lá»‡' });
      updates.push('type = ?'); params.push(t);
    }
    if (payload.content !== undefined) {
      const c = String(payload.content || '').trim();
      if (!c) return res.status(400).json({ message: 'Ná»™i dung khÃ´ng Ä‘Æ°á»£c Ä‘á»ƒ trá»‘ng' });
      updates.push('content = ?'); params.push(c);
    }
    updates.push('status = ?'); params.push('submitted');
    params.push(requestId);
    db.prepare('UPDATE cap_vien_step11_adjustment_request SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    insertCapVienHistory(id, '11', 'adjustment_update_request', req.user.id, ownerHistoryRole, 'Ná»™p láº¡i Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh sau khi bá»• sung');
    return res.json({ message: 'ÄÃ£ ná»™p láº¡i Ä‘á» xuáº¥t, chá» PhÃ²ng KHCN xem xÃ©t.' });
  }

  if (action === 'withdraw_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c rÃºt Ä‘á» xuáº¥t.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiáº¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chá»‰ rÃºt Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN xem xÃ©t láº§n Ä‘áº§u.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected' WHERE id = ?").run(requestId);
    insertCapVienHistory(id, '11', 'adjustment_withdraw_request', req.user.id, ownerHistoryRole, 'RÃºt Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh');
    return res.json({ message: 'ÄÃ£ rÃºt Ä‘á» xuáº¥t.' });
  }

  if (action === 'khcn_request_revision') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c yÃªu cáº§u bá»• sung.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiáº¿u requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p ná»™i dung yÃªu cáº§u bá»• sung' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chá»‰ xá»­ lÃ½ Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN xem xÃ©t.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'khcn_need_revision', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_request_revision', req.user.id, actorRole, 'YÃªu cáº§u bá»• sung Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh: ' + note);
    return res.json({ message: 'ÄÃ£ yÃªu cáº§u Chá»§ nhiá»‡m bá»• sung Ä‘á» xuáº¥t.' });
  }

  if (action === 'khcn_forward') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c trÃ¬nh Viá»‡n trÆ°á»Ÿng.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiáº¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chá»‰ trÃ¬nh Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN xem xÃ©t.' });
    const note = payload.note ? String(payload.note).trim() : null;
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'khcn_forwarded', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_forward', req.user.id, actorRole, 'TrÃ¬nh Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh');
    return res.json({ message: 'ÄÃ£ trÃ¬nh Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t.' });
  }

  if (action === 'khcn_reject') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c PhÃ²ng KHCN má»›i Ä‘Æ°á»£c tá»« chá»‘i.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiáº¿u requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p lÃ½ do tá»« chá»‘i' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chá»‰ tá»« chá»‘i Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN xem xÃ©t.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_reject', req.user.id, actorRole, 'PhÃ²ng KHCN tá»« chá»‘i Ä‘á» xuáº¥t: ' + note);
    return res.json({ message: 'ÄÃ£ tá»« chá»‘i Ä‘á» xuáº¥t.' });
  }

  if (action === 'director_approve') {
    if (!isDirectorOrAdmin) return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i Ä‘Æ°á»£c phÃª duyá»‡t.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiáº¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (r.status !== 'khcn_forwarded') return res.status(400).json({ message: 'Chá»‰ phÃª duyá»‡t Ä‘Æ°á»£c khi PhÃ²ng KHCN Ä‘Ã£ trÃ¬nh.' });
    const note = payload.note ? String(payload.note).trim() : null;
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'approved', directorNote = ?, directorDecidedById = ?, directorDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_director_approve', req.user.id, actorRole, 'Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh');
    return res.json({ message: 'ÄÃ£ phÃª duyá»‡t Ä‘á» xuáº¥t Ä‘iá»u chá»‰nh.' });
  }

  if (action === 'director_reject') {
    if (!isDirectorOrAdmin) return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i Ä‘Æ°á»£c tá»« chá»‘i.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiáº¿u requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p lÃ½ do khÃ´ng phÃª duyá»‡t' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (r.status !== 'khcn_forwarded') return res.status(400).json({ message: 'Chá»‰ xá»­ lÃ½ Ä‘Æ°á»£c khi PhÃ²ng KHCN Ä‘Ã£ trÃ¬nh.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected', directorNote = ?, directorDecidedById = ?, directorDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_director_reject', req.user.id, actorRole, 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t: ' + note);
    return res.json({ message: 'ÄÃ£ ghi nháº­n Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t.' });
  }

  return res.status(400).json({ message: 'HÃ nh Ä‘á»™ng khÃ´ng há»£p lá»‡.' });
});

// BÆ°á»›c 4: Pháº£n biá»‡n upload phiáº¿u Ä‘Ã¡nh giÃ¡ (slot 1 hoáº·c 2) - upload KHONG tu dong "hoan thanh"
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-upload', authMiddleware, uploadCapVien.single('phieu_danh_gia'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.body.slot || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoáº·c slot khÃ´ng há»£p lá»‡ (slot: 1 hoáº·c 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ thao tÃ¡c Ä‘Æ°á»£c á»Ÿ BÆ°á»›c 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chá»‰ pháº£n biá»‡n Ä‘Æ°á»£c phÃ¢n cÃ´ng hoáº·c Admin má»›i Ä‘Æ°á»£c upload phiáº¿u Ä‘Ã¡nh giÃ¡' });
  const file = req.file || req.files?.phieu_danh_gia?.[0];
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃ²ng chá»n file phiáº¿u Ä‘Ã¡nh giÃ¡ (PDF hoáº·c Word)' });

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

  insertCapVienHistory(id, '4', 'reviewer_upload', req.user.id, 'reviewer', 'Pháº£n biá»‡n ' + slot + ' upload phiáº¿u Ä‘Ã¡nh giÃ¡');
  console.log('[API] cap-vien step 4 reviewer-upload slot ' + slot + ' â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ upload phiáº¿u Ä‘Ã¡nh giÃ¡. Vui lÃ²ng nháº¥n "HoÃ n thÃ nh pháº£n biá»‡n ' + slot + '" sau khi kiá»ƒm tra.', slot });
});

// BÆ°á»›c 4: Pháº£n biá»‡n xÃ¡c nháº­n hoÃ n thÃ nh slot
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-complete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoáº·c slot khÃ´ng há»£p lá»‡ (slot: 1 hoáº·c 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ thao tÃ¡c Ä‘Æ°á»£c á»Ÿ BÆ°á»›c 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chá»‰ pháº£n biá»‡n Ä‘Æ°á»£c phÃ¢n cÃ´ng hoáº·c Admin má»›i Ä‘Æ°á»£c xÃ¡c nháº­n hoÃ n thÃ nh' });

  const hasFile = db.prepare('SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!hasFile) return res.status(400).json({ message: 'Pháº£n biá»‡n ' + slot + ' chÆ°a upload file. Vui lÃ²ng upload trÆ°á»›c khi nháº¥n hoÃ n thÃ nh.' });

  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 1 WHERE id = ?').run(id);
  insertCapVienHistory(id, '4', 'reviewer_complete', req.user.id, 'reviewer', 'Pháº£n biá»‡n ' + slot + ' xÃ¡c nháº­n hoÃ n thÃ nh');

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
    message: bothDone ? 'ÄÃ£ ghi nháº­n: cáº£ 2 pháº£n biá»‡n Ä‘Ã£ hoÃ n thÃ nh.' : ('ÄÃ£ ghi nháº­n: pháº£n biá»‡n ' + slot + ' hoÃ n thÃ nh.'),
    slot,
    bothDone,
    step5Ready: bothDone && budgetApproved
  });
});

// BÆ°á»›c 4: XÃ³a file pháº£n biá»‡n Ä‘á»ƒ upload láº¡i
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-delete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoáº·c slot khÃ´ng há»£p lá»‡ (slot: 1 hoáº·c 2)' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ thao tÃ¡c Ä‘Æ°á»£c á»Ÿ BÆ°á»›c 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chá»‰ pháº£n biá»‡n Ä‘Æ°á»£c phÃ¢n cÃ´ng hoáº·c Admin má»›i Ä‘Æ°á»£c xÃ³a file pháº£n biá»‡n' });

  const row = db.prepare('SELECT id, path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!row) return res.status(400).json({ message: 'ChÆ°a cÃ³ file pháº£n biá»‡n ' + slot + ' Ä‘á»ƒ xÃ³a' });
  db.prepare('DELETE FROM cap_vien_submission_files WHERE id = ?').run(row.id);
  if (row.path) safeUnlinkCapVienStoredFile(row.path);
  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('REVIEWED', 'UNDER_REVIEW', id);
  insertCapVienHistory(id, '4', 'reviewer_delete', req.user.id, 'reviewer', 'XÃ³a file pháº£n biá»‡n ' + slot + ' Ä‘á»ƒ upload láº¡i');
  return res.json({ message: 'ÄÃ£ xÃ³a file pháº£n biá»‡n ' + slot + '. Báº¡n cÃ³ thá»ƒ upload láº¡i vÃ  nháº¥n hoÃ n thÃ nh.', slot });
});

// BÆ°á»›c 4A: Ná»™p phiáº¿u tháº©m Ä‘á»‹nh dá»± toÃ¡n â€” upload 2 file (budget_phieu_tham_dinh, budget_to_trinh)
app.post('/api/cap-vien/submissions/:id/steps/4a/upload', authMiddleware, uploadCapVien.fields([
  { name: 'budget_phieu_tham_dinh', maxCount: 1 },
  { name: 'budget_to_trinh', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isCouncilOrAdmin) {
    return res.status(403).json({ message: 'Chá»‰ thÃ nh viÃªn Há»™i Ä‘á»“ng, Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p phiáº¿u tháº©m Ä‘á»‹nh dá»± toÃ¡n' });
  }
  const files = req.files || {};
  const f1 = files.budget_phieu_tham_dinh && files.budget_phieu_tham_dinh[0];
  const f2 = files.budget_to_trinh && files.budget_to_trinh[0];
  if (!f1 || !f2) {
    return res.status(400).json({ message: 'Vui lÃ²ng táº£i lÃªn Ä‘á»§ 2 file: Phiáº¿u tháº©m Ä‘á»‹nh (SCI-BUDGET-01) vÃ  Tá» trÃ¬nh (SCI-BUDGET-02)' });
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
  insertCapVienHistory(id, '4a', 'budget_upload', req.user.id, roleLabel, 'Ná»™p phiáº¿u tháº©m Ä‘á»‹nh dá»± toÃ¡n (vÃ²ng ' + (sub.budget_4a_round || 1) + '): SCI-BUDGET-01, SCI-BUDGET-02');
  console.log('[API] cap-vien step 4a upload â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ ná»™p phiáº¿u tháº©m Ä‘á»‹nh dá»± toÃ¡n. ThÃ nh viÃªn Há»™i Ä‘á»“ng cÃ³ thá»ƒ táº£i file ngay.', files: ['budget_phieu_tham_dinh', 'budget_to_trinh'] });
});

// BÆ°á»›c 4A: Tá»• tháº©m Ä‘á»‹nh yÃªu cáº§u bá»• sung/chá»‰nh sá»­a dá»± toÃ¡n â€” comment + file upload
app.post('/api/cap-vien/submissions/:id/steps/4a/request-revision', authMiddleware, uploadCapVien.fields([
  { name: 'revision_files', maxCount: 10 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const role = req.user.role;
  const isBudgetTeam = roleIsAny(req, ['admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chá»‰ Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh hoáº·c Admin má»›i Ä‘Æ°á»£c yÃªu cáº§u bá»• sung dá»± toÃ¡n' });
  const note = (req.body.note || req.body.comment || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p ná»™i dung yÃªu cáº§u bá»• sung/chá»‰nh sá»­a' });
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
      .get(id, '[VÃ²ng ' + currentRound + ']%');
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
  insertCapVienHistory(id, '4a', 'budget_request_revision', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', '[VÃ²ng ' + nextRound + '] ' + note);
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisionRequestEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, note, requestedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a request-revision â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ gá»­i yÃªu cáº§u bá»• sung. Email Ä‘Ã£ gá»­i Ä‘áº¿n Chá»§ nhiá»‡m vÃ  CC Há»™i Ä‘á»“ng.', status: 'need_revision' });
});

// BÆ°á»›c 4A: NghiÃªn cá»©u viÃªn (Chá»§ nhiá»‡m) ná»™p láº¡i tÃ i liá»‡u bá»• sung/chá»‰nh sá»­a theo yÃªu cáº§u
app.post('/api/cap-vien/submissions/:id/steps/4a/upload-revised', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload tháº¥t báº¡i: ' + (err.message || 'Dá»¯ liá»‡u file khÃ´ng há»£p lá»‡') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if ((sub.budget_4a_status || '') !== 'need_revision') {
    return res.status(400).json({ message: 'Chá»‰ Ä‘Æ°á»£c ná»™p tÃ i liá»‡u chá»‰nh sá»­a khi Tá»• tháº©m Ä‘á»‹nh Ä‘Ã£ yÃªu cáº§u bá»• sung (BÆ°á»›c 4A)' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chá»‰ Chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p tÃ i liá»‡u chá»‰nh sá»­a' });
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'Chá»§ nhiá»‡m Ä‘á» tÃ i' : 'Admin';
  const revisedList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!revisedList.length) {
    return res.status(400).json({ message: 'Vui lÃ²ng chá»n Ã­t nháº¥t 1 file tÃ i liá»‡u bá»• sung/chá»‰nh sá»­a.' });
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
  insertCapVienHistory(id, '4a', 'researcher_upload_revised', req.user.id, uploaderRole, uploaderRoleLabel + ' ná»™p ' + revisedList.length + ' file tÃ i liá»‡u bá»• sung/chá»‰nh sá»­a (vÃ²ng ' + round + ')');
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisedSubmittedEmail({ submissionTitle: sub.title, researcherName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a upload-revised â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ ná»™p tÃ i liá»‡u bá»• sung/chá»‰nh sá»­a. Tá»• tháº©m Ä‘á»‹nh sáº½ kiá»ƒm tra vÃ  phÃª duyá»‡t hoáº·c yÃªu cáº§u bá»• sung tiáº¿p.' });
});

// BÆ°á»›c 4A: Tá»• tháº©m Ä‘á»‹nh phÃª duyá»‡t dá»± toÃ¡n
app.post('/api/cap-vien/submissions/:id/steps/4a/approve', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const role = req.user.role;
  const isBudgetTeam = roleIsAny(req, ['admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chá»‰ Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh hoáº·c Admin má»›i Ä‘Æ°á»£c phÃª duyá»‡t dá»± toÃ¡n' });
  const roundNow = sub.budget_4a_round || 1;
  const cntBudget = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh')").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const cntRevised = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName LIKE 'budget_revised_attachment_%'").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const hasBudgetPair = !!cntBudget && Number(cntBudget.c || 0) >= 2;
  const hasRevisedAttachments = !!cntRevised && Number(cntRevised.c || 0) > 0;
  if (!hasBudgetPair && !hasRevisedAttachments) {
    return res.status(400).json({ message: 'ChÆ°a cÃ³ tÃ i liá»‡u Ä‘á»ƒ phÃª duyá»‡t á»Ÿ vÃ²ng hiá»‡n táº¡i. Vui lÃ²ng ná»™p há»“ sÆ¡ tháº©m Ä‘á»‹nh hoáº·c chá» Chá»§ nhiá»‡m ná»™p tÃ i liá»‡u bá»• sung.' });
  }
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_approved_at = ?, budget_4a_approved_by = ? WHERE id = ?')
    .run('approved', approvedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_approve', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', 'Tá»• tháº©m Ä‘á»‹nh phÃª duyá»‡t dá»± toÃ¡n');
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
  console.log('[API] cap-vien step 4a approve â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ phÃª duyá»‡t dá»± toÃ¡n. Email Ä‘Ã£ gá»­i Ä‘áº¿n Chá»§ nhiá»‡m vÃ  Há»™i Ä‘á»“ng.' + (step4Done ? ' BÆ°á»›c 4 vÃ  4A Ä‘á»u hoÃ n thÃ nh, Ä‘Ã£ chuyá»ƒn sang BÆ°á»›c 5.' : ' Äang chá» BÆ°á»›c 4 (Pháº£n biá»‡n) hoÃ n thÃ nh.'), status: 'approved', step5Ready: step4Done });
});

// Admin: Gá»­i láº¡i email BÆ°á»›c 4 (phÃ¢n cÃ´ng pháº£n biá»‡n â†’ pháº£n biá»‡n + Há»™i Ä‘á»“ng) â€” dÃ¹ng khi Ä‘Ã£ qua bÆ°á»›c 3â†’4 nhÆ°ng email chÆ°a gá»­i
app.post('/api/cap-vien/submissions/:id/send-step4-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, assignedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ gá»­i Ä‘Æ°á»£c email BÆ°á»›c 4 khi há»“ sÆ¡ Ä‘Ã£ qua BÆ°á»›c 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  if (reviewerIds.length < 2) return res.status(400).json({ message: 'Há»“ sÆ¡ chÆ°a cÃ³ Ä‘á»§ 2 pháº£n biá»‡n Ä‘Æ°á»£c phÃ¢n cÃ´ng' });
  const chairmanRow = sub.assignedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(sub.assignedById) : null;
  const chairmanName = (chairmanRow && (chairmanRow.fullname || chairmanRow.email)) || 'Chá»§ tá»‹ch';
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
  const reviewerEmails = reviewers.map(r => r.email).filter(Boolean);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
  console.log('[API] cap-vien admin send-step4-email â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ gá»­i email BÆ°á»›c 4 Ä‘áº¿n cÃ¡c pháº£n biá»‡n vÃ  Há»™i Ä‘á»“ng.' });
});

// Admin: Gá»­i láº¡i email BÆ°á»›c 4A (thÃ´ng bÃ¡o Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh, CC Há»™i Ä‘á»“ng) â€” dÃ¹ng khi Ä‘Ã£ qua bÆ°á»›c 3â†’4 nhÆ°ng email chÆ°a gá»­i
app.post('/api/cap-vien/submissions/:id/send-step4a-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chá»‰ gá»­i Ä‘Æ°á»£c email BÆ°á»›c 4A khi há»“ sÆ¡ Ä‘Ã£ qua BÆ°á»›c 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
  console.log('[API] cap-vien admin send-step4a-email â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ gá»­i email BÆ°á»›c 4A Ä‘áº¿n Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh (CC Há»™i Ä‘á»“ng).' });
});

// Admin Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2 (route riÃªng Ä‘á»ƒ Ä‘áº£m báº£o revert luÃ´n hoáº¡t Ä‘á»™ng)
app.post('/api/cap-vien/submissions/:id/revert-to-step-2', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2 (kiá»ƒm tra láº¡i)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const currentStatus = sub.status || 'SUBMITTED';
  if (currentStatus === 'SUBMITTED') {
    return res.status(400).json({ message: 'Há»“ sÆ¡ Ä‘ang á»Ÿ BÆ°á»›c 2, khÃ´ng cáº§n Ä‘Æ°a vá»' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
    .run('SUBMITTED', id);
  insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2 Ä‘á»ƒ kiá»ƒm tra láº¡i');
  console.log('[API] cap-vien revert-to-step-2 â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2. ThÆ° kÃ½ cÃ³ thá»ƒ nháº¥n Há»£p lá»‡ hoáº·c YÃªu cáº§u bá»• sung láº¡i.', status: 'SUBMITTED' });
});

// Admin Ä‘Æ°a há»“ sÆ¡ vá» bÆ°á»›c trÆ°á»›c (3, 4, 5, 6, 7) â€” nÃºt "ÄÆ°a vá» BÆ°á»›c N (Admin)"
app.post('/api/cap-vien/submissions/:id/revert-to-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = parseInt(req.params.step, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  if (isNaN(step) || step < 2 || step > 7) return res.status(400).json({ message: 'BÆ°á»›c pháº£i tá»« 2 Ä‘áº¿n 7' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c Ä‘Æ°a há»“ sÆ¡ vá» bÆ°á»›c trÆ°á»›c Ä‘Ã³' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });

  if (step === 2) {
    db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?').run('SUBMITTED', id);
    insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2');
    return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 2.', status: 'SUBMITTED' });
  }

  const clearStep4And4a = () => {
    db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL WHERE id = ?').run(id);
  };

  if (step === 3) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('VALIDATED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 3 â€” submission ' + id);
    return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 3 (PhÃ¢n cÃ´ng pháº£n biá»‡n).', status: 'VALIDATED' });
  }

  if (step === 4) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('ASSIGNED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 4 â€” submission ' + id);
    return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 4 & 4A.', status: 'ASSIGNED' });
  }

  if (step === 5) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 5 (Há»p Há»™i Ä‘á»“ng).', status: 'REVIEWED' });
  }

  if (step === 6) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
    return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 6 (Cáº¥p Quyáº¿t Ä‘á»‹nh).', status: 'CONDITIONAL' });
  }

  if (step === 7) {
    db.prepare(`UPDATE cap_vien_submissions SET status = ?, step8_completed = 0, step8_waived = 0,
      step8a_completed = 0, step8a_waived = 0 WHERE id = ?`).run('APPROVED', id);
    return res.json({ message: 'ÄÃ£ Ä‘Æ°a há»“ sÆ¡ vá» BÆ°á»›c 7 (KÃ½ há»£p Ä‘á»“ng).', status: 'APPROVED' });
  }

  return res.status(400).json({ message: 'BÆ°á»›c khÃ´ng há»£p lá»‡' });
});

// Dev-only tiá»‡n Ã­ch: reset BÆ°á»›c 2 / 3 / 4 / 4A / 5 vá» tráº¡ng thÃ¡i ban Ä‘áº§u
app.post('/api/cap-vien/submissions/:id/dev-reset-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepKey = String(req.params.step || '').toLowerCase();
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  if (!['2', '3', '4', '4a', '5'].includes(stepKey)) return res.status(400).json({ message: 'Chá»‰ há»— trá»£ reset bÆ°á»›c 2, 3, 4, 4A hoáº·c 5' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chá»‰ Admin má»›i Ä‘Æ°á»£c reset bÆ°á»›c (dev)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });

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
    return res.json({ message: 'ÄÃ£ reset BÆ°á»›c 2 (vÃ  dá»n dá»¯ liá»‡u thá»­ BÆ°á»›c 3â€“4â€“4A). Há»“ sÆ¡ vá» SUBMITTED, chá» ThÆ° kÃ½ kiá»ƒm tra láº¡i.', status: 'SUBMITTED' });
  }

  if (stepKey === '3') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'ÄÃ£ reset BÆ°á»›c 3 vá» tráº¡ng thÃ¡i ban Ä‘áº§u (chá» phÃ¢n cÃ´ng pháº£n biá»‡n).', status: 'VALIDATED' });
  }

  if (stepKey === '4') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName IN ('reviewer_phieu_1','reviewer_phieu_2')").run(id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'ÄÃ£ reset BÆ°á»›c 4 vá» tráº¡ng thÃ¡i ban Ä‘áº§u (chá» phÃ¢n cÃ´ng pháº£n biá»‡n).', status: 'VALIDATED' });
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
      message: 'ÄÃ£ reset BÆ°á»›c 5: xÃ³a thÃ´ng tin há»p, biÃªn báº£n, lá»‹ch sá»­ & deadline bÆ°á»›c 5.',
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
  return res.json({ message: 'ÄÃ£ reset BÆ°á»›c 4A vá» tráº¡ng thÃ¡i ban Ä‘áº§u (tháº©m Ä‘á»‹nh láº¡i tá»« Ä‘áº§u).', status: 'ASSIGNED' });
});

// NghiÃªn cá»©u viÃªn ná»™p láº¡i há»“ sÆ¡ sau khi ThÆ° kÃ½ yÃªu cáº§u bá»• sung (BÆ°á»›c 2) â€” chá»‰ cáº­p nháº­t tráº¡ng thÃ¡i (khÃ´ng file). Náº¿u cÃ³ file bá»• sung thÃ¬ dÃ¹ng POST /supplement.
app.post('/api/cap-vien/submissions/:id/resubmit', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chá»‰ Ä‘Æ°á»£c ná»™p láº¡i khi ThÆ° kÃ½ Ä‘Ã£ yÃªu cáº§u bá»• sung (tráº¡ng thÃ¡i Cáº§n bá»• sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chá»‰ chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p láº¡i há»“ sÆ¡' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_resubmit', req.user.id, 'researcher', 'NghiÃªn cá»©u viÃªn ná»™p láº¡i há»“ sÆ¡ (khÃ´ng file bá»• sung)');
  console.log('[API] cap-vien resubmit â€” submission ' + id);
  return res.json({ message: 'ÄÃ£ ghi nháº­n ná»™p láº¡i há»“ sÆ¡. ThÆ° kÃ½ sáº½ kiá»ƒm tra vÃ  nháº¥n Há»£p lá»‡ hoáº·c YÃªu cáº§u bá»• sung.', status: 'SUBMITTED' });
});

// Ná»™p há»“ sÆ¡ bá»• sung (BÆ°á»›c 2 â€” váº«n trong quy trÃ¬nh BÆ°á»›c 2): upload file(s), lÆ°u bÃªn dÆ°á»›i há»“ sÆ¡ gá»‘c (revisionRound tÄƒng), chuyá»ƒn status vá» SUBMITTED
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
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chá»‰ Ä‘Æ°á»£c ná»™p há»“ sÆ¡ bá»• sung khi ThÆ° kÃ½ Ä‘Ã£ yÃªu cáº§u bá»• sung (tráº¡ng thÃ¡i Cáº§n bá»• sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chá»‰ chá»§ nhiá»‡m Ä‘á» tÃ i hoáº·c Admin má»›i Ä‘Æ°á»£c ná»™p há»“ sÆ¡ bá»• sung' });
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
  insertCapVienStep2History(id, 'researcher_supplement', req.user.id, 'researcher', uploadedFiles.length > 0 ? `Ná»™p há»“ sÆ¡ bá»• sung láº§n ${nextRound} (${uploadedFiles.length} file)` : 'Ná»™p há»“ sÆ¡ bá»• sung');
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
  console.log('[API] cap-vien supplement â€” submission ' + id + ', round ' + nextRound + ', files: ' + uploadedFiles.length);
  return res.json({
    message: uploadedFiles.length > 0
      ? 'ÄÃ£ ghi nháº­n há»“ sÆ¡ bá»• sung (láº§n ' + nextRound + '). QuÃ¡ trÃ¬nh váº«n á»Ÿ BÆ°á»›c 2. ThÆ° kÃ½ sáº½ kiá»ƒm tra vÃ  nháº¥n Há»£p lá»‡ hoáº·c YÃªu cáº§u bá»• sung.'
      : 'ÄÃ£ ghi nháº­n. ThÆ° kÃ½ sáº½ kiá»ƒm tra vÃ  nháº¥n Há»£p lá»‡ hoáº·c YÃªu cáº§u bá»• sung.',
    status: 'SUBMITTED',
    supplementRound: nextRound,
    filesCount: uploadedFiles.length
  });
});

app.get('/api/cap-vien/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n táº£i há»“ sÆ¡ nÃ y' });
  }
  const files = db.prepare('SELECT path, originalName FROM cap_vien_submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y file há»“ sÆ¡' });
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
  if (!id || !fileId) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡' });
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n táº£i file nÃ y' });
  const file = db.prepare('SELECT id, path, originalName FROM cap_vien_submission_files WHERE id = ? AND submissionId = ?').get(fileId, id);
  if (!file || !file.path) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y file' });
  return safeDownload(res, file.path, file.originalName);
});

app.delete('/api/cap-vien/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡' });
  try {
    deleteCapVienSubmissionCascade(id);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'INVALID_CAP_VIEN_SUBMISSION_ID') return res.status(400).json({ message: 'ID há»“ sÆ¡ khÃ´ng há»£p lá»‡.' });
    if (msg === 'CAP_VIEN_SUBMISSION_NOT_FOUND') return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y há»“ sÆ¡.' });
    console.error('[cap-vien/submissions DELETE]', msg || e);
    return res.status(500).json({ message: 'KhÃ´ng thá»ƒ xÃ³a há»“ sÆ¡. ' + msg });
  }
  return res.json({ message: 'ÄÃ£ xÃ³a há»“ sÆ¡ Ä‘á» tÃ i cáº¥p Viá»‡n vÃ  dá»¯ liá»‡u liÃªn quan (dashboard, tiáº¿n trÃ¬nh, file).' });
});

// Admin: danh sÃ¡ch user (khÃ´ng tráº£ hash password; cÃ³ cá» activated)
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

// Admin: nháº­t kÃ½ Ä‘Äƒng nháº­p / truy cáº­p / hÃ nh Ä‘á»™ng (báº£ng user_activity_log)
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

// Admin: thÃªm tÃ i khoáº£n má»›i hoáº·c cáº­p nháº­t há» tÃªn + vai trÃ² (gÃµ há» tÃªn, email, chá»n vai trÃ²)
app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, password, academicTitle } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p email' });
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡.' });
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || 'researcher').toLowerCase().trim();
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trÃ² khÃ´ng há»£p lá»‡. Vui lÃ²ng khá»Ÿi Ä‘á»™ng láº¡i server (node server.js) vÃ  thá»­ láº¡i.' });
  if (councilRoles.includes(r) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chá»‰ email @sci.edu.vn má»›i Ä‘Æ°á»£c gÃ¡n vai trÃ² Chá»§ tá»‹ch, ThÆ° kÃ½, ThÃ nh viÃªn Há»™i Ä‘á»“ng' });
  }
  if (councilRoles.includes(r) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c cáº¥p vai trÃ² thÃ nh viÃªn Há»™i Ä‘á»“ng KHCN.' });
  }
  if (BUDGET_TEAM_ROLES.includes(r) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c cáº¥p vai trÃ² Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh.' });
  }
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  const acadTitle = (academicTitle || '').trim() || null;
  const oldRole = existing ? (existing.role || '').toLowerCase() : '';
  const promotingToAdmin = r === 'admin' && oldRole !== 'admin';
  const demotingFromAdmin = oldRole === 'admin' && r !== 'admin';
  if (promotingToAdmin && !reqIsMasterAdmin(req)) {
    return res.status(403).json({
      message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c thÃªm tÃ i khoáº£n má»›i vá»›i vai trÃ² Admin hoáº·c nÃ¢ng user lÃªn Admin.',
    });
  }
  if (demotingFromAdmin && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c gá»¡ quyá»n Admin khá»i tÃ i khoáº£n.' });
  }
  if (demotingFromAdmin && userEmailIsMasterAdmin(em)) {
    return res.status(400).json({ message: 'KhÃ´ng thá»ƒ gá»¡ quyá»n Master Admin há»‡ thá»‘ng.' });
  }
  if (existing) {
    db.prepare('UPDATE users SET fullname = ?, role = ?, academicTitle = ? WHERE email = ?').run((fullname || '').trim(), r, acadTitle, em);
    return res.json({ message: 'ÄÃ£ cáº­p nháº­t há» tÃªn vÃ  vai trÃ² cho ' + em });
  }
  const plainPassword = (password || '').trim();
  if (plainPassword.length > 0 && plainPassword.length < 6) {
    return res.status(400).json({
      message:
        'Máº­t kháº©u tá»‘i thiá»ƒu 6 kÃ½ tá»±, hoáº·c Ä‘á»ƒ trá»‘ng Ä‘á»ƒ táº¡o tÃ i khoáº£n chÆ°a kÃ­ch hoáº¡t (user tá»± Ä‘áº·t máº­t kháº©u qua trang ÄÄƒng kÃ½ @sci.edu.vn).',
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
    return res.status(201).json({ message: 'ÄÃ£ thÃªm tÃ i khoáº£n vá»›i máº­t kháº©u do báº¡n Ä‘áº·t.', activated: true });
  }
  // Äá»ƒ trá»‘ng máº­t kháº©u: tÃ i khoáº£n chÆ°a kÃ­ch hoáº¡t (sentinel '' do cá»™t password thÆ°á»ng NOT NULL)
  db.prepare('INSERT INTO users (email, password, fullname, role, academicTitle) VALUES (?, ?, ?, ?, ?)').run(
    em,
    '',
    (fullname || '').trim(),
    r,
    acadTitle
  );
  return res.status(201).json({
    message:
      'ÄÃ£ thÃªm tÃ i khoáº£n. NgÆ°á»i dÃ¹ng cáº§n vÃ o trang ÄÄƒng kÃ½ (@sci.edu.vn) Ä‘á»ƒ Ä‘áº·t máº­t kháº©u vÃ  kÃ­ch hoáº¡t.',
    activated: false,
  });
});

// Admin: Ä‘Æ°a tÃ i khoáº£n vá» chÆ°a kÃ­ch hoáº¡t (xÃ³a máº­t kháº©u Ä‘Äƒng nháº­p; khÃ´ng Ã¡p dá»¥ng Admin)
app.post('/api/admin/reset-user-password', authMiddleware, adminOnly, (req, res) => {
  const userId = parseInt(req.body && req.body.userId, 10);
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ message: 'userId khÃ´ng há»£p lá»‡' });
  }
  const row = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
  if (!row) {
    return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  }
  if ((row.role || '').toLowerCase() === 'admin') {
    return res.status(400).json({ message: 'KhÃ´ng thá»ƒ reset máº­t kháº©u tÃ i khoáº£n Admin' });
  }
  if (Number(row.id) === Number(req.user.id)) {
    return res.status(400).json({ message: 'KhÃ´ng thá»ƒ reset chÃ­nh tÃ i khoáº£n Ä‘ang Ä‘Äƒng nháº­p' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run('', userId);
  return res.json({
    message: 'ÄÃ£ reset. User cáº§n Ä‘Äƒng kÃ½ láº¡i (trang ÄÄƒng kÃ½ @sci.edu.vn) Ä‘á»ƒ Ä‘áº·t máº­t kháº©u má»›i.',
  });
});

// Admin: gá»­i email thÃ´ng bÃ¡o cáº¥p vai trÃ² tá»›i Ä‘á»‹a chá»‰ email
app.post('/api/admin/users/send-role-email', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, tempPassword } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p email' });
  const roleLabel = ROLE_LABELS[role] || role;
  let fullnameToUse = (fullname || '').trim();
  if (!fullnameToUse) {
    const row = db.prepare('SELECT fullname FROM users WHERE email = ?').get(em);
    if (row && row.fullname) fullnameToUse = row.fullname;
  }
  await sendRoleAssignmentEmail(em, fullnameToUse, role || 'researcher', tempPassword || null);
  if (!transporter) {
    return res.status(503).json({ message: 'ChÆ°a cáº¥u hÃ¬nh SMTP. KhÃ´ng thá»ƒ gá»­i email. Xem README_BACKEND.md.' });
  }
  return res.json({ message: 'ÄÃ£ gá»­i email thÃ´ng bÃ¡o Ä‘áº¿n ' + em });
});

// Admin: danh sÃ¡ch ngÆ°á»i nháº­n email thÃ´ng bÃ¡o (Admin thÃªm/xÃ³a; khi cÃ³ danh sÃ¡ch nÃ y thÃ¬ má»i thÃ´ng bÃ¡o gá»­i tá»›i Ä‘Ã¢y)
app.get('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients ORDER BY id').all();
    return res.json({ recipients: rows || [] });
  } catch (e) {
    return res.json({ recipients: [] });
  }
});

// ========== Thá»‘ng kÃª trang chá»§ (sá»‘ liá»‡u tháº­t tá»« cÃ¡c module) ==========
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
      else if (isCancelled) { /* bo qua de tai huy */ }
      else if (isPastEnd) missionMini.overdue += 1;
      else missionMini.inProgress += 1;
    }
  } catch (e) {
    missions = dbCount('SELECT COUNT(*) as c FROM missions');
  }
  /**
   * NhÃ¢n lá»±c KHCN: Ä‘áº¿m báº£ng `personnel` chá»‰ khi module Ä‘Æ°á»£c báº­t trÃªn trang chá»§.
   * Module chÆ°a triá»ƒn khai (enabled = 0) â†’ null Ä‘á»ƒ trÃ¡nh hiá»ƒn thá»‹ 0 gÃ¢y hiá»ƒu nháº§m.
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
   * TÃ i sáº£n trÃ­ tuá»‡: sá»‘ thá»±c tá»« cÃ´ng bá»‘ loáº¡i "Báº±ng sÃ¡ng cháº¿ / GPHI" (publications.pub_type = 'patent'),
   * cÃ¹ng nguá»“n dá»¯ liá»‡u vá»›i module CÃ´ng bá»‘ khoa há»c â€” chá»‰ khi module Â«ipÂ» Ä‘Æ°á»£c báº­t; táº¯t â†’ null (khÃ´ng hiá»ƒn thá»‹ 0).
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
  /** Tháº» module Â«CÃ´ng bá»‘ KHCNÂ» â€” Ä‘á»“ng bá»™ logic lá»c vá»›i module (khÃ´ng tÃ­nh retracted) */
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
  // CRD Lab Booking â€” truy váº¥n trá»±c tiáº¿p tá»« báº£ng CRD (Ä‘á»“ng bá»™ vá»›i tháº» module trÃªn trang chá»§)
  const crdMachines = dbCount('SELECT COUNT(*) as c FROM crd_machines');
  /** Lá»‹ch cÃ²n hiá»‡u lá»±c: tá»« ngÃ y hÃ´m nay trá»Ÿ Ä‘i, khÃ´ng tÃ­nh Ä‘Ã£ há»§y */
  const crdActiveBookings = dbCount(
    `SELECT COUNT(*) as c FROM crd_bookings
     WHERE COALESCE(NULLIF(TRIM(status), ''), 'confirmed') != 'cancelled'
     AND date >= date('now')`
  );
  /** NgÆ°á»i cÃ³ há»“ sÆ¡ CRD cÃ²n Ä‘Æ°á»£c Ä‘áº·t lá»‹ch (chÆ°a gá»¡ quyá»n, chÆ°a bá»‹ khoÃ¡) */
  const crdActivePersons = dbCount(
    `SELECT COUNT(*) as c FROM crd_persons
     WHERE COALESCE(crd_access_revoked, 0) = 0 AND COALESCE(is_banned, 0) = 0`
  );
  const facilities = {
    activeBookings: crdActiveBookings,
    machines: crdMachines,
    activeUsers: crdActivePersons,
  };
  /** Tháº» module Â«Há»£p tÃ¡cÂ» â€” láº¥y sá»‘ liá»‡u trá»±c tiáº¿p tá»« dá»¯ liá»‡u module Ä‘á»‘i tÃ¡c */
  let cooperationMini = { doi_tac: 0, trong_nuoc: 0, quoc_te: 0 };
  try {
    const { stats, total } = cooperationComputePartnerStats();
    cooperationMini = {
      doi_tac: total || 0,
      trong_nuoc: stats.trong_nuoc || 0,
      quoc_te: stats.quoc_te || 0,
    };
  } catch (e) {
    /* báº£ng há»£p tÃ¡c chÆ°a cÃ³ hoáº·c lá»—i */
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
    /* báº£ng DMS chÆ°a cÃ³ */
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
    /* báº£ng Equipment chÆ°a cÃ³ */
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
    /* báº£ng document workflow chÆ°a cÃ³ */
  }
  /** Tháº» module Â«Há»™i Ä‘á»“ng Ä‘áº¡o Ä‘á»©c trÃªn Ä‘á»™ng váº­tÂ» â€” Ä‘á»“ng bá»™ tráº¡ng thÃ¡i vá»›i /api/submissions (SCI-ACE) */
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
    /* báº£ng submissions (SCI-ACE) chÆ°a cÃ³ */
  }
  const sampleStorageMini = require('./routes/nganHangTeBaoKhangThe').miniStats(db);
  const capVienMini = require('./modules/de-tai-cap-vien/eofficeMount').miniStats();
  return res.json({
    missions, missionMini, capVienMini, personnel, ip,
    publications, publicationMini, cooperation, cooperationMini,
    facilities, dmsMini, equipmentMini, sampleStorageMini, documentWorkflowMini, aceMini,
  });
});

// ========== Nhiá»‡m vá»¥ KHCN (Dashboard): trÃ­ch xuáº¥t thá»‘ng kÃª + danh sÃ¡ch tÃ¬m kiáº¿m ==========
syncMissionsFromCapVien();

// NhÃ³m lÃµi (thá»‘ng kÃª, danh sÃ¡ch, Ä‘Äƒng kÃ½ má»›i) Ä‘Ã£ tÃ¡ch sang routes/missions/core.js.
// Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨: pháº£i trÆ°á»›c '/api/missions/:id' bÃªn dÆ°á»›i, vÃ¬ handler Ä‘Ã³
// tráº£ 400 Â«ID khÃ´ng há»£p lá»‡Â» vÃ  khÃ´ng gá»i next() â€” '/missions/stats' Ä‘Äƒng kÃ½ sau nÃ³
// sáº½ cháº¿t im láº·ng.
app.use('/api', require('./routes/missions/core')({
  db,
  authMiddleware,
  transporter,
  PORT,
  syncMissionsFromCapVien,
  getSmtpFrom,
  getNotificationEmails,
}));

// Há»“ sÆ¡ Ä‘Äƒng kÃ½ + duyá»‡t BÆ°á»›c 2â€“3 Ä‘Ã£ tÃ¡ch sang routes/missions/hoSo.js.
// Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨: váº«n pháº£i trÆ°á»›c '/api/missions/:id' bÃªn dÆ°á»›i.
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

// Duyá»‡t BÆ°á»›c 4a/4b/5/6 Ä‘Ã£ tÃ¡ch sang routes/missions/pheDuyet.js.
// Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨: váº«n pháº£i trÆ°á»›c '/api/missions/:id' bÃªn dÆ°á»›i.
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

// Danh sÃ¡ch chá» CT HÄ xÃ©t duyá»‡t Ä‘Ã£ tÃ¡ch sang routes/missions/choXetDuyet.js.
// Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨ â€” pháº£i trÆ°á»›c missionsExport vÃ  missionsChiTiet bÃªn dÆ°á»›i.
app.use('/api', require('./routes/missions/choXetDuyet')({
  db,
  authMiddleware,
  roleIsAny,
}));

// Admin / PhÃ²ng KHCN: cáº­p nháº­t nhiá»‡m vá»¥ (Ä‘á» tÃ i) â€” tráº¡ng thÃ¡i cÃ³ thá»ƒ lÃ  mÃ£ chuáº©n hoáº·c chuá»—i tá»± do
app.put('/api/admin/missions/:id', authMiddleware, adminOrPhongKhcnMissionEditor, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» tÃ i.' });
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
  if (updates.length === 0) return res.status(400).json({ message: 'KhÃ´ng cÃ³ trÆ°á»ng nÃ o Ä‘á»ƒ cáº­p nháº­t.' });
  params.push(id);
  db.prepare('UPDATE missions SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget FROM missions WHERE id = ?').get(id);
  return res.json({ message: 'ÄÃ£ cáº­p nháº­t Ä‘á» tÃ i.', mission: updated });
});

// Master Admin: xÃ³a nhiá»‡m vá»¥ â€” náº¿u Ä‘á»“ng bá»™ tá»« cáº¥p Viá»‡n thÃ¬ xÃ³a luÃ´n há»“ sÆ¡ + tiáº¿n trÃ¬nh + file trÃªn toÃ n há»‡ thá»‘ng
app.delete('/api/admin/missions/:id', authMiddleware, masterAdminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT id, code, title, source_type, source_id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» tÃ i.' });
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
    return res.status(500).json({ message: 'KhÃ´ng thá»ƒ xÃ³a Ä‘á» tÃ i (lá»—i cÆ¡ sá»Ÿ dá»¯ liá»‡u). ' + msg });
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
    /* khÃ´ng cháº·n pháº£n há»“i */
  }
  const tail = isCapVien ? ' (Ä‘Ã£ gá»¡ khá»i dashboard, theo dÃµi tiáº¿n trÃ¬nh vÃ  há»“ sÆ¡ cáº¥p Viá»‡n)' : '';
  return res.json({ message: 'ÄÃ£ xÃ³a Ä‘á» tÃ i "' + (row.code || '') + '" khá»i há»‡ thá»‘ng.' + tail, deletedId: id });
});

// CSV helper: escape field for CSV (quote if contains comma, newline or quote)
function csvEscape(s) {
  if (s == null) return '';
  const str = String(s).trim();
  if (/[,"\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// Xuáº¥t dá»¯ liá»‡u nhiá»‡m vá»¥ (CSV / Excel / bÃ¡o cÃ¡o thá»‘ng kÃª) â€” xem routes/missions/export.js.
// Pháº£i mount TRÆ¯á»šC handler '/api/missions/:id' bÃªn dÆ°á»›i, náº¿u khÃ´ng 'export',
// 'export-excel', 'report-excel'â€¦ sáº½ bá»‹ báº¯t nháº§m thÃ nh :id.
app.use('/api', require('./routes/missions/export')({
  db,
  authMiddleware,
  adminOnly,
  csvEscape,
  syncMissionsFromCapVien,
  insertUserActivityLog,
}));

// Chi tiáº¿t Ä‘á» tÃ i + há»“ sÆ¡ ngoÃ i Viá»‡n + file sáº£n pháº©m Ä‘Ã£ tÃ¡ch sang
// routes/missions/chiTiet.js. Router nÃ y chá»©a '/missions/:id' nÃªn Báº®T BUá»˜C mount
// SAU missionsCore, missionsChoXetDuyet vÃ  missionsExport á»Ÿ trÃªn â€” náº¿u khÃ´ng,
// '/api/missions/export', '/stats', '/cho-ct-hd-*' sáº½ bá»‹ :id nuá»‘t thÃ nh 400.
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

// Máº«u há»“ sÆ¡ Ä‘Äƒng kÃ½ Ä‘á» tÃ i ngoÃ i Viá»‡n â€” Admin upload, User download
const TEMPLATE_TYPES = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong'];
const TEMPLATE_LABELS = { thuyet_minh_chi_tiet: 'Máº«u Thuyáº¿t minh chi tiáº¿t', van_ban_xin_phep_vien_truong: 'Máº«u VÄƒn báº£n xin phÃ©p Viá»‡n trÆ°á»Ÿng' };

// Máº«u há»“ sÆ¡ Ä‘Äƒng kÃ½ Ä‘á» tÃ i ngoÃ i Viá»‡n â€” xem routes/missions/templates.js.
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

// Máº«u há»“ sÆ¡ SCI-ACE (Há»™i Ä‘á»“ng Ä‘áº¡o Ä‘á»©c trÃªn Ä‘á»™ng váº­t) â€” Admin/ThÆ° kÃ½ Há»™i Ä‘á»“ng upload, má»i ngÆ°á»i Ä‘Äƒng nháº­p Ä‘Æ°á»£c download
const ACE_TEMPLATE_DEFS = [
  { type: 'nhom1_muc_luc', group: 1, label: 'Má»¥c lá»¥c Há»‡ thá»‘ng' },
  { type: 'nhom1_huong_dan_tong_hop', group: 1, label: 'HÆ°á»›ng dáº«n Tá»•ng há»£p' },
  { type: 'nhom1_huong_dan_thao_tac', group: 1, label: 'HÆ°á»›ng dáº«n Thao tÃ¡c Äá»™ng váº­t' },
  { type: 'nhom1_quy_che', group: 1, label: 'Quy cháº¿ Há»™i Ä‘á»“ng' },
  { type: 'sci_ace_01', group: 2, label: 'SCI-ACE-01: ÄÆ¡n Ä‘á» nghá»‹ xÃ©t duyá»‡t' },
  { type: 'sci_ace_02', group: 2, label: 'SCI-ACE-02: Phiáº¿u thuyáº¿t minh Ä‘á» tÃ i' },
  { type: 'sci_ace_03', group: 2, label: 'SCI-ACE-03: BÃ¡o cÃ¡o tuÃ¢n thá»§ nguyÃªn táº¯c 3R' },
  { type: 'sci_ace_04', group: 2, label: 'SCI-ACE-04: BÃ¡o cÃ¡o giáº£i trÃ¬nh tiáº¿p thu' },
  { type: 'sci_ace_06', group: 2, label: 'SCI-ACE-06: BÃ¡o cÃ¡o thay Ä‘á»•i káº¿ hoáº¡ch' },
  { type: 'sci_ace_07', group: 2, label: 'SCI-ACE-07: BÃ¡o cÃ¡o káº¿t quáº£ tuÃ¢n thá»§' },
  { type: 'sci_ace_pdg', group: 3, label: 'SCI-ACE-PÄG: Phiáº¿u nháº­n xÃ©t thÃ nh viÃªn Há»™i Ä‘á»“ng' },
  { type: 'sci_ace_05', group: 3, label: 'SCI-ACE-05: BiÃªn báº£n há»p Há»™i Ä‘á»“ng' },
  { type: 'sci_ace_qd_vn', group: 3, label: 'Quyáº¿t Ä‘á»‹nh phÃª duyá»‡t (Tiáº¿ng Viá»‡t)' },
  { type: 'sci_ace_qd_en', group: 3, label: 'Decision (English)' },
];
const ACE_TEMPLATE_TYPES = ACE_TEMPLATE_DEFS.map((d) => d.type);
const ACE_TEMPLATE_BY_TYPE = {};
ACE_TEMPLATE_DEFS.forEach((d) => { ACE_TEMPLATE_BY_TYPE[d.type] = d; });

/** Admin hoáº·c ThÆ° kÃ½ Há»™i Ä‘á»“ng (KHCN/SCI-ACE dÃ¹ng chung role) má»›i Ä‘Æ°á»£c cáº­p nháº­t máº«u há»“ sÆ¡ SCI-ACE. */
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
  if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loáº¡i máº«u khÃ´ng há»£p lá»‡' });
  const row = db.prepare('SELECT template_type, original_name, path FROM ace_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'ChÆ°a cÃ³ máº«u nÃ y' });
  const templatesRoot = path.resolve(uploadDir, 'ace-templates');
  const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
  if (!pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath)) {
    return res.status(403).json({ message: 'ÄÆ°á»ng dáº«n file máº«u khÃ´ng há»£p lá»‡' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File khÃ´ng tá»“n táº¡i' });
  setContentDisposition(res, row.original_name || 'download');
  return res.sendFile(fullPath);
});

app.post(
  '/api/admin/ace-templates',
  authMiddleware,
  (req, res, next) => {
    if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c ThÆ° kÃ½ Há»™i Ä‘á»“ng má»›i Ä‘Æ°á»£c cáº­p nháº­t máº«u.' });
    next();
  },
  upload.single('file'),
  (req, res) => {
    const type = (req.body.template_type || '').trim();
    if (!ACE_TEMPLATE_TYPES.includes(type)) {
      try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'template_type khÃ´ng há»£p lá»‡' });
    }
    if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lÃ²ng chá»n file Ä‘á»ƒ upload' });
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!['pdf', 'doc', 'docx'].includes(ext)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'Chá»‰ cháº¥p nháº­n PDF, Word (.doc, .docx)' });
    }
    const destDir = path.join(uploadDir, 'ace-templates');
    fs.mkdirSync(destDir, { recursive: true });
    const finalName = type + '_' + Date.now() + '.' + ext;
    const destPath = path.join(destDir, finalName);
    fs.copyFileSync(req.file.path, destPath);
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    db.prepare("INSERT OR REPLACE INTO ace_templates (template_type, original_name, path, updated_at) VALUES (?, ?, ?, datetime('now'))").run(type, req.file.originalname || finalName, finalName);
    const row = db.prepare('SELECT template_type, original_name, updated_at FROM ace_templates WHERE template_type = ?').get(type);
    return res.status(201).json({ message: 'ÄÃ£ cáº­p nháº­t máº«u ' + (ACE_TEMPLATE_BY_TYPE[type] ? ACE_TEMPLATE_BY_TYPE[type].label : type), template: row });
  }
);

app.delete('/api/admin/ace-templates/:type', authMiddleware, (req, res) => {
  if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'Chá»‰ Admin hoáº·c ThÆ° kÃ½ Há»™i Ä‘á»“ng má»›i Ä‘Æ°á»£c xÃ³a máº«u.' });
  const type = (req.params.type || '').trim();
  if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loáº¡i máº«u khÃ´ng há»£p lá»‡' });
  const row = db.prepare('SELECT path FROM ace_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng cÃ³ file Ä‘á»ƒ xÃ³a' });
  try {
    const templatesRoot = path.resolve(uploadDir, 'ace-templates');
    const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
    if (pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath) && fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
    db.prepare('DELETE FROM ace_templates WHERE template_type = ?').run(type);
    return res.json({ ok: true, message: 'ÄÃ£ xÃ³a máº«u' });
  } catch (e) {
    console.error('[ace-templates delete]', e);
    return res.status(500).json({ message: 'Lá»—i xÃ³a' });
  }
});

// Import CSV hoáº·c Excel (.xlsx): cáº­p nháº­t/thÃªm Ä‘á» tÃ i vÃ o missions (Admin)
app.post('/api/admin/missions/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file || !req.file.path) {
    return res.status(400).json({ message: 'Vui lÃ²ng chá»n file CSV hoáº·c Excel (.xlsx) Ä‘á»ƒ import.' });
  }
  const isExcel = (req.file.originalname || '').toLowerCase().endsWith('.xlsx');
  let headerCells = [];
  let dataRows = [];

  if (isExcel) {
    try {
      const buf = fs.readFileSync(req.file.path);
      const workbook = XLSX.read(buf, { type: 'buffer', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(400).json({ message: 'File Excel khÃ´ng cÃ³ sheet nÃ o.' });
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      if (!rawRows.length) return res.status(400).json({ message: 'File Excel trá»‘ng.' });
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
      return res.status(400).json({ message: 'KhÃ´ng Ä‘á»c Ä‘Æ°á»£c file Excel. Báº¡n cÃ³ thá»ƒ lÆ°u láº¡i dÆ°á»›i dáº¡ng CSV (UTF-8) vÃ  thá»­ import CSV.' });
    }
  } else {
    let raw = '';
    if (fs.existsSync(req.file.path)) {
      raw = (fs.readFileSync(req.file.path, 'utf8') || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    if (!raw || raw.trim().length === 0) {
      return res.status(400).json({ message: 'File trá»‘ng hoáº·c khÃ´ng Ä‘á»c Ä‘Æ°á»£c.' });
    }
    let lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines[0] && lines[0].toLowerCase() === 'sep=,') lines = lines.slice(1);
    let delim = ',';
    if (lines[0] && /^sep=;/i.test(lines[0])) { lines = lines.slice(1); delim = ';'; }
    if (lines.length < 2) {
      return res.status(400).json({ message: 'File CSV cáº§n cÃ³ Ã­t nháº¥t dÃ²ng tiÃªu Ä‘á» vÃ  má»™t dÃ²ng dá»¯ liá»‡u.' });
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
    if (code.length > 80 || code.indexOf('Cáº¥p') >= 0 || code.indexOf('Tráº¡ng thÃ¡i') >= 0 || code.indexOf('GHI CHÃš') >= 0) continue;
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
    message: 'Import xong. ÄÃ£ thÃªm ' + inserted + ' Ä‘á» tÃ i, cáº­p nháº­t ' + updated + ' Ä‘á» tÃ i. Dashboard sáº½ hiá»ƒn thá»‹ sá»‘ liá»‡u má»›i.',
    inserted,
    updated
  });
});

// Admin: ThÃªm thá»§ cÃ´ng 1 Ä‘á» tÃ i vÃ o báº£ng missions (upsert theo code)
app.post('/api/admin/missions/manual', authMiddleware, adminOnly, (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '').trim();
  const title = String(body.title || '').trim();
  const principal = String(body.principal || '').trim() || null;
  const level = String(body.level || '').trim().toLowerCase();
  const statusResolved = resolveMissionStatusInput(body.status != null && body.status !== '' ? body.status : 'planning');

  if (!code) return res.status(400).json({ message: 'Thiáº¿u mÃ£ Ä‘á» tÃ i (code).' });
  if (!title) return res.status(400).json({ message: 'Thiáº¿u tÃªn Ä‘á» tÃ i (title).' });
  if (!['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'].includes(level)) {
    return res.status(400).json({ message: 'Cáº¥p Ä‘á» tÃ i khÃ´ng há»£p lá»‡. HÃ£y chá»n: national | ministry | university | school | coe | first | institute.' });
  }
  if (!statusResolved) {
    return res.status(400).json({ message: 'Tráº¡ng thÃ¡i khÃ´ng há»£p lá»‡ (quÃ¡ dÃ i hoáº·c kÃ½ tá»± khÃ´ng Ä‘Æ°á»£c phÃ©p).' });
  }

  const normalizeDate = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return s.slice(0, 10);
    // cháº¥p nháº­n DD/MM/YYYY hoáº·c MM/DD/YYYY Ä‘á»ƒ Ä‘á»¡ sai khi admin nháº­p tay
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
      return res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t Ä‘á» tÃ i.', id: existing.id, updated: true });
    }

    db.prepare(
      `INSERT INTO missions
        (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'manual')`
    ).run(code, title, principal, level, statusResolved, start_date, end_date, progress, budget);
    const id = db.prepare('SELECT id FROM missions WHERE code=? ORDER BY id DESC LIMIT 1').get(code).id;
    return res.status(201).json({ ok: true, message: 'ÄÃ£ thÃªm Ä‘á» tÃ i thá»§ cÃ´ng.', id, updated: false });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i thÃªm thá»§ cÃ´ng: ' + (e.message || String(e)) });
  }
});

// Admin: cáº¥u hÃ¬nh báº­t/táº¯t module trÃªn trang chá»§
app.get('/api/admin/homepage-modules', authMiddleware, adminOnly, (req, res) => {
  // Náº¿u báº£ng trá»‘ng thÃ¬ seed máº·c Ä‘á»‹nh
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

// Pháº£i khai bÃ¡o TRÆ¯á»šC /:code â€” náº¿u khÃ´ng PUT .../reorder bá»‹ khá»›p :code=reorder vÃ  chÃ¨n dÃ²ng sai vÃ o DB
app.put('/api/admin/homepage-modules/reorder', authMiddleware, adminOnly, (req, res) => {
  const order = req.body && Array.isArray(req.body.order) ? req.body.order.map(c => String(c || '').trim()).filter(Boolean) : [];
  const expected = HOMEPAGE_MODULES_DEFAULT.map(m => m.code);
  if (order.length !== expected.length) {
    return res.status(400).json({ message: 'Danh sÃ¡ch thá»© tá»± pháº£i Ä‘á»§ ' + expected.length + ' module.' });
  }
  const set = new Set(order);
  if (!expected.every(c => set.has(c))) {
    return res.status(400).json({ message: 'Thá»© tá»± module khÃ´ng há»£p lá»‡ (thiáº¿u hoáº·c trÃ¹ng mÃ£).' });
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
  return res.json({ message: 'ÄÃ£ lÆ°u thá»© tá»± hiá»ƒn thá»‹ module trÃªn Trang chá»§.' });
});

app.put('/api/admin/homepage-modules/:code', authMiddleware, adminOnly, (req, res) => {
  const code = (req.params.code || '').trim();
  if (!code) return res.status(400).json({ message: 'Thiáº¿u mÃ£ module' });
  if (!HOMEPAGE_MODULES_DEFAULT.some(m => m.code === code)) {
    return res.status(400).json({ message: 'MÃ£ module khÃ´ng há»£p lá»‡.' });
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
  return res.json({ message: 'ÄÃ£ cáº­p nháº­t cáº¥u hÃ¬nh module.', module: row });
});

// Public: cáº¥u hÃ¬nh module cho trang chá»§ (khÃ´ng cáº§n Ä‘Äƒng nháº­p)
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
    } catch (e) { /* giá»¯ rows tá»« DB */ }
  }
  return res.json({ modules: rows });
});

// TiÃªu chuáº©n há»‡ thá»‘ng (ISO9001...) â€” hiá»ƒn thá»‹ trÃªn header trang chá»§; Admin cÃ³ thá»ƒ sá»­a/xÃ³a
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
  return res.json({ message: label ? 'ÄÃ£ lÆ°u tiÃªu chuáº©n hiá»ƒn thá»‹.' : 'ÄÃ£ xÃ³a dÃ²ng tiÃªu chuáº©n (sáº½ khÃ´ng hiá»ƒn thá»‹ trÃªn Trang chá»§).', label: label });
});

app.post('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p email' });
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡.' });
  try {
    db.prepare('INSERT INTO notification_recipients (email, fullname) VALUES (?, ?)').run(em, (fullname || '').trim() || null);
    const row = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'ÄÃ£ thÃªm ngÆ°á»i nháº­n thÃ´ng bÃ¡o.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email nÃ y Ä‘Ã£ cÃ³ trong danh sÃ¡ch.' });
    return res.status(500).json({ message: 'Lá»—i thÃªm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡' });
  try {
    const r = db.prepare('DELETE FROM notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y báº£n ghi.' });
    return res.json({ message: 'ÄÃ£ xÃ³a khá»i danh sÃ¡ch nháº­n thÃ´ng bÃ¡o.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i xÃ³a: ' + (e.message || '') });
  }
});

// ========== Module Há»£p tÃ¡c quá»‘c táº¿: danh sÃ¡ch email nháº­n thÃ´ng bÃ¡o (Ä‘á» xuáº¥t Ä‘oÃ n ra, Ä‘oÃ n vÃ o, ...) â€” chá»‰ Admin ==========
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
  if (!em) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p email.' });
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡.' });
  const topicsVal = (topics === 'all' || (typeof topics === 'string' && topics.trim() === 'all')) ? 'all' : (Array.isArray(topics) ? topics.filter(Boolean).join(',') : (typeof topics === 'string' ? topics.trim() : 'all'));
  const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
  try {
    db.prepare('INSERT INTO cooperation_notification_recipients (email, fullname, topics, role) VALUES (?, ?, ?, ?)').run(em, (fullname || '').trim() || null, topicsVal || 'all', roleVal);
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'ÄÃ£ thÃªm ngÆ°á»i nháº­n thÃ´ng bÃ¡o.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email nÃ y Ä‘Ã£ cÃ³ trong danh sÃ¡ch.' });
    return res.status(500).json({ message: 'Lá»—i thÃªm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  try {
    const r = db.prepare('DELETE FROM cooperation_notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y báº£n ghi.' });
    return res.json({ message: 'ÄÃ£ xÃ³a khá»i danh sÃ¡ch nháº­n thÃ´ng bÃ¡o.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i xÃ³a: ' + (e.message || '') });
  }
});

app.patch('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role, fullname, topics } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row0 = db.prepare('SELECT id FROM cooperation_notification_recipients WHERE id = ?').get(id);
  if (!row0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y báº£n ghi.' });
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃ´ng cÃ³ trÆ°á»ng nÃ o Ä‘á»ƒ cáº­p nháº­t (role, fullname, topics).' });
  vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_notification_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE id = ?').get(id);
    return res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t.', recipient: row });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// Cáº£nh bÃ¡o thá»a thuáº­n Ä‘Ã£ kÃ½ â€” trÆ°á»›c/sau háº¿t háº¡n (topic thoa_thuan_het_han)
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
      return res.status(400).json({ message: 'months pháº£i lÃ  sá»‘ tá»« 1 Ä‘áº¿n 36.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_expiry_alert_months', String(m));
    updates.push('months');
  }
  if (body.post_expiry_max_emails != null) {
    const n = parseInt(body.post_expiry_max_emails, 10);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      return res.status(400).json({ message: 'post_expiry_max_emails pháº£i tá»« 0 (khÃ´ng gá»­i) Ä‘áº¿n 20.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_max_emails', String(n));
    updates.push('post_expiry_max_emails');
  }
  if (body.post_expiry_min_days != null) {
    const d = parseInt(body.post_expiry_min_days, 10);
    if (!Number.isFinite(d) || d < 1 || d > 90) {
      return res.status(400).json({ message: 'post_expiry_min_days pháº£i tá»« 1 Ä‘áº¿n 90.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_min_days', String(d));
    updates.push('post_expiry_min_days');
  }
  if (!updates.length) {
    return res.status(400).json({ message: 'Gá»­i Ã­t nháº¥t má»™t trÆ°á»ng: months, post_expiry_max_emails, post_expiry_min_days.' });
  }
  try {
    return res.json({
      ok: true,
      message: 'ÄÃ£ lÆ°u cáº¥u hÃ¬nh cáº£nh bÃ¡o thá»a thuáº­n.',
      months: coopGetThoaThuanExpiryMonths(),
      post_expiry_max_emails: coopGetThoaThuanPostExpiryMaxEmails(),
      post_expiry_min_days: coopGetThoaThuanPostExpiryMinDays()
    });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i lÆ°u cáº¥u hÃ¬nh.' });
  }
});

app.post('/api/admin/cooperation/thoa-thuan/run-expiry-check', authMiddleware, adminOnly, (req, res) => {
  coopRunThoaThuanExpiryAlerts()
    .then((r) => res.json({ ok: true, ...r }))
    .catch((e) => res.status(500).json({ message: 'ÄÃ£ xáº£y ra lá»—i. Vui lÃ²ng thá»­ láº¡i sau.' }));
});

// Gá»­i Ä‘á» xuáº¥t Thá»a thuáº­n (MOU): lÆ°u vÃ o DB + gá»­i email tá»›i danh sÃ¡ch nháº­n thÃ´ng bÃ¡o (topic mou hoáº·c all)
app.post('/api/cooperation/mou/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'NgÆ°á»i dÃ¹ng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const loaiThoaThuan = (body.loai_thoa_thuan || body.loaiThoaThuan || '').trim() || 'â€”';
  const tenDoiTac = (body.ten_doi_tac || body.tenDoiTac || '').trim() || 'â€”';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || 'â€”';
  const thoiHanNam = (body.thoi_han_nam != null && body.thoi_han_nam !== '') ? String(body.thoi_han_nam) : 'â€”';
  const giaTriTaiChinh = (body.gia_tri_tai_chinh || body.giaTriTaiChinh || '').trim() || 'â€”';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || 'â€”';
  const noiDungHopTac = (body.noi_dung_hop_tac || body.noiDungHopTac || '').trim() || 'â€”';
  const { to: toList, cc: ccList } = getCooperationRecipientsSplit('mou');
  const allRecipients = [...toList, ...ccList];
  if (allRecipients.length === 0) {
    return res.status(400).json({
      message: 'ChÆ°a cÃ³ email nháº­n thÃ´ng bÃ¡o Ä‘á» xuáº¥t Thá»a thuáº­n. Admin vui lÃ²ng thÃªm trong Quáº£n trá»‹ Há»£p tÃ¡c Quá»‘c táº¿ â†’ Danh sÃ¡ch email (chá»n topic MOU).',
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
    return res.status(500).json({ message: 'Lá»—i lÆ°u Ä‘á» xuáº¥t: ' + (e.message || ''), sent: 0 });
  }
  try {
    if (newRowId) coopAddHistory('mou', newRowId, 1, 'gui', 'Ná»™p Ä‘á» xuáº¥t Thá»a thuáº­n', user, null);
  } catch (e) {}
  const maDeXuatMou = newRowId ? coopGenMa('mou', newRowId) : '';
  try {
    if (newRowId && maDeXuatMou) db.prepare('UPDATE cooperation_mou_de_xuat SET ma_de_xuat=? WHERE id=?').run(maDeXuatMou, newRowId);
  } catch (e) {}
  const subject = '[Há»£p tÃ¡c QT] Äá» xuáº¥t Thá»a thuáº­n má»›i: ' + tenDoiTac + ' â€” ' + submittedBy;
  const textBody = 'KÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng,\n\nPhÃ²ng KHCN&QHÄN trÃ¢n trá»ng bÃ¡o cÃ¡o: ' + submittedBy + ' (' + submittedByEmail + ') Ä‘Ã£ gá»­i Ä‘á» xuáº¥t Thá»a thuáº­n há»£p tÃ¡c quá»‘c táº¿ má»›i lÃªn PhÃ²ng Ä‘á»ƒ tháº©m Ä‘á»‹nh vÃ  trÃ¬nh Viá»‡n trÆ°á»Ÿng.\n\nThÃ´ng tin Ä‘á» xuáº¥t:\n- MÃ£: ' + maDeXuatMou + '\n- Loáº¡i thá»a thuáº­n: ' + loaiThoaThuan + '\n- Äá»‘i tÃ¡c: ' + tenDoiTac + '\n- Quá»‘c gia: ' + quocGia + '\n- Thá»i háº¡n (nÄƒm): ' + thoiHanNam + '\n- GiÃ¡ trá»‹ tÃ i chÃ­nh: ' + giaTriTaiChinh + '\n- ÄÆ¡n vá»‹ Ä‘á» xuáº¥t: ' + donViDeXuat + '\n- Ná»™i dung há»£p tÃ¡c: ' + noiDungHopTac + '\n\nKÃ­nh mong Viá»‡n trÆ°á»Ÿng xem xÃ©t vÃ  chá»‰ Ä‘áº¡o. PhÃ²ng KHCN&QHÄN sáº½ tháº©m Ä‘á»‹nh vÃ  bÃ¡o cÃ¡o chi tiáº¿t khi cÃ³ káº¿t quáº£.\n\nTrÃ¢n trá»ng.';
  const htmlBody = '<p style="margin-bottom:16px;"><strong>KÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng,</strong></p><p>PhÃ²ng KHCN&amp;QHÄN trÃ¢n trá»ng bÃ¡o cÃ¡o: <strong>' + submittedBy + '</strong> (' + submittedByEmail + ') Ä‘Ã£ gá»­i Ä‘á» xuáº¥t Thá»a thuáº­n há»£p tÃ¡c quá»‘c táº¿ má»›i lÃªn PhÃ²ng Ä‘á»ƒ tháº©m Ä‘á»‹nh vÃ  trÃ¬nh Viá»‡n trÆ°á»Ÿng.</p><p><strong>ThÃ´ng tin Ä‘á» xuáº¥t:</strong></p><table border="1" cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;"><tr style="background:#f8fafc;"><td style="font-weight:600;width:40%;">MÃ£ Ä‘á» xuáº¥t</td><td>' + maDeXuatMou + '</td></tr><tr><td style="font-weight:600;">Loáº¡i thá»a thuáº­n</td><td>' + loaiThoaThuan + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Äá»‘i tÃ¡c</td><td>' + tenDoiTac + '</td></tr><tr><td style="font-weight:600;">Quá»‘c gia</td><td>' + quocGia + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Thá»i háº¡n (nÄƒm)</td><td>' + thoiHanNam + '</td></tr><tr><td style="font-weight:600;">GiÃ¡ trá»‹ tÃ i chÃ­nh</td><td>' + giaTriTaiChinh + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">ÄÆ¡n vá»‹ Ä‘á» xuáº¥t</td><td>' + donViDeXuat + '</td></tr><tr><td style="font-weight:600;">Ná»™i dung há»£p tÃ¡c</td><td>' + noiDungHopTac.replace(/\n/g, '<br>') + '</td></tr></table><p style="margin-top:16px;">KÃ­nh mong Viá»‡n trÆ°á»Ÿng xem xÃ©t vÃ  chá»‰ Ä‘áº¡o. PhÃ²ng KHCN&amp;QHÄN sáº½ tháº©m Ä‘á»‹nh vÃ  bÃ¡o cÃ¡o chi tiáº¿t khi cÃ³ káº¿t quáº£.</p><p>TrÃ¢n trá»ng.</p>';
  if (!transporter) {
    return res.json({ message: 'ÄÃ£ lÆ°u Ä‘á» xuáº¥t. Há»‡ thá»‘ng chÆ°a cáº¥u hÃ¬nh SMTP nÃªn chÆ°a gá»­i Ä‘Æ°á»£c email thÃ´ng bÃ¡o.', sent: 0, ma_de_xuat: maDeXuatMou, id: newRowId || null });
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
    res.json({ message: 'ÄÃ£ gá»­i Ä‘á» xuáº¥t Thá»a thuáº­n tá»›i PhÃ²ng KHCN&QHÄN. Email Ä‘Ã£ gá»­i tá»›i Viá»‡n trÆ°á»Ÿng (KÃ­nh gá»­i) vÃ  CC ' + allRecipients.length + ' Ä‘á»‹a chá»‰.', sent: allRecipients.length, ma_de_xuat: maDeXuatMou, id: newRowId || null });
  }).catch(err => {
    console.error('[Email] Gá»­i thÃ´ng bÃ¡o Ä‘á» xuáº¥t MOU lá»—i:', err.message);
    res.status(500).json({ message: 'Gá»­i email tháº¥t báº¡i: ' + (err.message || 'Lá»—i há»‡ thá»‘ng.'), sent: 0 });
  });
});

// Helper: Admin hoáº·c Viá»‡n trÆ°á»Ÿng (email trong cooperation_notification_recipients vá»›i role=vien_truong)
function vienTruongOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i cÃ³ quyá»n nÃ y' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i cÃ³ quyá»n nÃ y' });
}

// Helper: Admin, P.KHCN (users.role) hoáº·c Viá»‡n trÆ°á»Ÿng â€” dÃ¹ng cho má»¥c QUáº¢N LÃ
function canSeeQuanLySection(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'Chá»‰ Admin, PhÃ²ng KHCN hoáº·c Viá»‡n trÆ°á»Ÿng má»›i cÃ³ quyá»n nÃ y' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'Chá»‰ Admin, PhÃ²ng KHCN hoáº·c Viá»‡n trÆ°á»Ÿng má»›i cÃ³ quyá»n nÃ y' });
}

// Chi tiáº¿t Ä‘á» xuáº¥t (MOU hoáº·c ÄoÃ n ra) â€” user pháº£i lÃ  ngÆ°á»i gá»­i hoáº·c admin/vien_truong
app.get('/api/cooperation/de-xuat-chi-tiet/:source/:id', authMiddleware, (req, res) => {
  const source = (req.params.source || '').toLowerCase();
  const id = parseInt(req.params.id, 10);
  if (!id || !['mou', 'doan_ra', 'doan_vao'].includes(source)) {
    return res.status(400).json({ message: 'Nguá»“n hoáº·c ID khÃ´ng há»£p lá»‡' });
  }
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const year = new Date().getFullYear();
  try {
    if (source === 'mou') {
      const r = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'KhÃ´ng cÃ³ quyá»n xem Ä‘á» xuáº¥t nÃ y' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'yeu_cau_bo_sung' ? 2 : 1);
      return res.json({
        source: 'mou',
        id: r.id,
        ma_de_xuat: r.ma_de_xuat || coopGenMa('mou', r.id),
        title: 'Äá» xuáº¥t MOU â€” ' + (r.ten_doi_tac || 'â€”') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
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
        nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN'
      });
    }
    if (source === 'doan_ra') {
      const r = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'KhÃ´ng cÃ³ quyá»n xem Ä‘á» xuáº¥t nÃ y' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'dang_chuan_bi' ? 2 : 1);
      return res.json({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ÄX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'ÄÄƒng kÃ½ ÄoÃ n ra â€” ' + (r.muc_dich || r.quoc_gia || 'â€”'),
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
        nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN'
      });
    }
    if (source === 'doan_vao') {
      const r = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        const pk = roleIsAny(req, ['phong_khcn']);
        if (!vt && !pk) return res.status(403).json({ message: 'KhÃ´ng cÃ³ quyá»n xem Ä‘á» xuáº¥t nÃ y' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : 1);
      return res.json({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'ÄX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'ÄÄƒng kÃ½ ÄoÃ n vÃ o â€” ' + (r.muc_dich || 'â€”') + ' â€” ' + (r.don_vi_de_xuat || 'â€”'),
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
        nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN'
      });
    }
  } catch (e) {
    console.error('[API] de-xuat-chi-tiet error:', e.message);
    return res.status(500).json({ message: 'Lá»—i há»‡ thá»‘ng' });
  }
  return res.status(400).json({ message: 'Nguá»“n khÃ´ng há»£p lá»‡' });
});

// Kiá»ƒm tra user cÃ³ quyá»n phÃª duyá»‡t Ä‘á» xuáº¥t (Admin hoáº·c Viá»‡n trÆ°á»Ÿng)
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

// Sá»‘ lÆ°á»£ng Ä‘á» xuáº¥t chá» P.KHCN vs Viá»‡n trÆ°á»Ÿng + quyá»n xem má»¥c QUáº¢N LÃ (Admin, P.KHCN, Viá»‡n trÆ°á»Ÿng)
app.get('/api/cooperation/quan-ly-stats', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  const email = (req.user.email || '').trim().toLowerCase();
  let canSeeQuanLy = role === 'admin' || roleIsAny(req, ['phong_khcn']);
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

// CÃ¡c Ä‘á» xuáº¥t chá» P.KHCN tháº©m Ä‘á»‹nh (MOU dang_tham_dinh + ÄoÃ n vÃ o cho_tham_dinh) â€” Admin, P.KHCN, Viá»‡n trÆ°á»Ÿng
app.get('/api/cooperation/de-xuat-cho-phong-khcn', authMiddleware, canSeeQuanLySection, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ÄX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Äá» xuáº¥t MOU â€” ' + (r.ten_doi_tac || 'â€”') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
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
        ma_de_xuat: 'ÄX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'ÄÄƒng kÃ½ ÄoÃ n vÃ o â€” ' + (r.muc_dich || 'â€”') + ' â€” ' + (r.don_vi_de_xuat || 'â€”'),
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

// CÃ¡c Ä‘á» xuáº¥t chá» Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t (ÄoÃ n ra cho_vt_duyet + HTQT cho_vt_phe_duyet) â€” Admin, Viá»‡n trÆ°á»Ÿng
app.get('/api/cooperation/de-xuat-cho-vien-truong', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\' ORDER BY created_at ASC').all();
    for (const r of doans || []) {
      list.push({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ÄX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'ÄÄƒng kÃ½ ÄoÃ n ra â€” ' + (r.muc_dich || r.quoc_gia || 'â€”'),
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
        ma_de_xuat: 'ÄX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'ÄÄƒng kÃ½ ÄoÃ n vÃ o â€” ' + (r.muc_dich || 'â€”') + ' â€” ' + (r.don_vi_de_xuat || 'â€”'),
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

// CÃ¡c Ä‘á» xuáº¥t chá» duyá»‡t â€” chá»‰ Admin vÃ  Viá»‡n trÆ°á»Ÿng (tá»•ng há»£p, giá»¯ tÆ°Æ¡ng thÃ­ch)
app.get('/api/cooperation/de-xuat-cho-duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'ÄX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Äá» xuáº¥t MOU â€” ' + (r.ten_doi_tac || 'â€”') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
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
        ma_de_xuat: 'ÄX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'ÄÄƒng kÃ½ ÄoÃ n ra â€” ' + (r.muc_dich || r.quoc_gia || 'â€”'),
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

// Tháº©m Ä‘á»‹nh ÄoÃ n vÃ o â€” P.KHCN / Admin (action Ä‘á»“ng bá»™ vá»›i module-hoatac-quocte: duyet_len_vt | yeu_cau_bo_sung | tu_choi)
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
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet', 'cho_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chá»‰ xá»­ lÃ½ Ä‘Æ°á»£c Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN. Náº¿u Ä‘ang yÃªu cáº§u bá»• sung, ngÆ°á»i gá»­i cáº§n ná»™p láº¡i há»“ sÆ¡ trÆ°á»›c.' });
    }
    const newStatus = action === 'duyet_len_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'duyet_len_vt' ? 'PhÃ²ng KHCN tháº©m Ä‘á»‹nh â€” TrÃ¬nh Viá»‡n trÆ°á»Ÿng' : action === 'tu_choi' ? 'PhÃ²ng KHCN tá»« chá»‘i' : 'PhÃ²ng KHCN yÃªu cáº§u bá»• sung';
    db.prepare("UPDATE cooperation_doan_vao SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, req.user.id || null, id);
    coopAddHistory('doan_vao', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_vao', row, id, 'phong', note).catch(err => console.error('[Email tu_choi doan_vao]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${row.ma_de_xuat || coopGenMa('doan_vao', id)}] Cáº­p nháº­t ÄoÃ n vÃ o â€” ${label}`,
          html: coopBuildEmail('Cáº­p nháº­t Äá» xuáº¥t ÄoÃ n vÃ o', 'Äá» xuáº¥t ÄoÃ n vÃ o cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c PhÃ²ng KHCN&amp;QHÄN xá»­ lÃ½.',
            [['MÃ£', row.ma_de_xuat || coopGenMa('doan_vao', id)], ['Tráº¡ng thÃ¡i má»›i', STATUS_LABELS_COOP[newStatus] || newStatus], ['Ã kiáº¿n PhÃ²ng KHCN', note || 'â€”']], 'TrÃ¢n trá»ng.'),
          text: `${row.ma_de_xuat} â€” ${label}. Ã kiáº¿n: ${note || 'â€”'}` });
      }
    }
    if (action === 'duyet_len_vt') {
      const recip = coopGetRecipients('doan_vao');
      coopSendMail({ to: recip.to, cc: recip.cc,
        subject: `[Há»£p tÃ¡c QT] TrÃ¬nh duyá»‡t ÄoÃ n vÃ o â€” ${row.ma_de_xuat || coopGenMa('doan_vao', id)}`,
        html: coopBuildEmail('Äá» xuáº¥t ÄoÃ n vÃ o cáº§n Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t', 'PhÃ²ng KHCN&amp;QHÄN Ä‘Ã£ tháº©m Ä‘á»‹nh vÃ  trÃ¬nh Viá»‡n trÆ°á»Ÿng:',
          [['MÃ£', row.ma_de_xuat || coopGenMa('doan_vao', id)], ['NgÆ°á»i gá»­i', row.submitted_by_name || row.submitted_by_email], ['Má»¥c Ä‘Ã­ch', row.muc_dich || 'â€”'], ['ÄÆ¡n vá»‹', row.don_vi_de_xuat || 'â€”'], ['Ã kiáº¿n PhÃ²ng', note || 'â€”']],
          'TrÃ¢n trá»ng,<br/>PhÃ²ng KHCN&QHÄN', (process.env.BASE_URL || 'http://localhost:' + PORT) + '/module-hoatac-quocte.html'),
        text: `TrÃ¬nh duyá»‡t ÄoÃ n vÃ o ${row.ma_de_xuat}.` });
    }
    return res.json({ ok: true, message: label, status: newStatus });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// PhÃª duyá»‡t/Tá»« chá»‘i ÄoÃ n vÃ o â€” Viá»‡n trÆ°á»Ÿng hoáº·c Admin â€” cho ÄoÃ n vÃ o cho_ky_duyet
app.put('/api/cooperation/doan-vao/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoáº·c action khÃ´ng há»£p lá»‡. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if ((row.status || '').toLowerCase() !== 'cho_ky_duyet') {
      return res.status(400).json({ message: 'Chá»‰ phÃª duyá»‡t Ä‘Æ°á»£c Ä‘á» xuáº¥t Ä‘ang chá» Viá»‡n trÆ°á»Ÿng.' });
    }
    const r = db.prepare('UPDATE cooperation_doan_vao SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateDoanVaoVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_vao] ÄÃ£ phÃª duyá»‡t (legacy) nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx) má»™t láº§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_vao] Auto Word sau duyet legacy:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('doan_vao', id, 3, 'tu_choi', 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('doan_vao', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi doan_vao]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'ÄÃ£ phÃª duyá»‡t Ä‘á» xuáº¥t ÄoÃ n vÃ o.' : 'ÄÃ£ tá»« chá»‘i Ä‘á» xuáº¥t ÄoÃ n vÃ o.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// Tháº©m Ä‘á»‹nh MOU â€” P.KHCN / Admin (Ä‘á»“ng bá»™ vá»›i giao diá»‡n: duyet_len_vt â†’ chá» Viá»‡n trÆ°á»Ÿng, khÃ´ng pháº£i da_duyet)
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
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet', 'dang_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chá»‰ xá»­ lÃ½ Ä‘Æ°á»£c Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN. Náº¿u Ä‘ang yÃªu cáº§u bá»• sung, ngÆ°á»i gá»­i cáº§n ná»™p láº¡i há»“ sÆ¡ trÆ°á»›c.' });
    }
    const newStatus = action === 'duyet_len_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'duyet_len_vt' ? 'PhÃ²ng KHCN tháº©m Ä‘á»‹nh â€” TrÃ¬nh Viá»‡n trÆ°á»Ÿng' : action === 'tu_choi' ? 'PhÃ²ng KHCN tá»« chá»‘i' : 'PhÃ²ng KHCN yÃªu cáº§u bá»• sung';
    db.prepare("UPDATE cooperation_mou_de_xuat SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, req.user.id || null, id);
    coopAddHistory('mou', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('mou', row, id, 'phong', note).catch(err => console.error('[Email tu_choi mou]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${row.ma_de_xuat || coopGenMa('mou', id)}] Cáº­p nháº­t MOU â€” ${label}`,
          html: coopBuildEmail('Cáº­p nháº­t Äá» xuáº¥t MOU', 'Äá» xuáº¥t cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c PhÃ²ng KHCN&amp;QHÄN xá»­ lÃ½.',
            [['MÃ£', row.ma_de_xuat || coopGenMa('mou', id)], ['Tráº¡ng thÃ¡i má»›i', STATUS_LABELS_COOP[newStatus] || newStatus], ['Ã kiáº¿n PhÃ²ng KHCN', note || 'â€”']], 'TrÃ¢n trá»ng.'),
          text: `${row.ma_de_xuat} â€” ${label}. Ã kiáº¿n: ${note || 'â€”'}` });
      }
    }
    if (action === 'duyet_len_vt') {
      const recip = coopGetRecipients('mou');
      coopSendMail({ to: recip.to, cc: recip.cc,
        subject: `[Há»£p tÃ¡c QT] TrÃ¬nh duyá»‡t MOU â€” ${row.ma_de_xuat || coopGenMa('mou', id)}`,
        html: coopBuildEmail('Äá» xuáº¥t MOU cáº§n Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t', 'PhÃ²ng KHCN&amp;QHÄN Ä‘Ã£ tháº©m Ä‘á»‹nh vÃ  trÃ¬nh Viá»‡n trÆ°á»Ÿng:',
          [['MÃ£', row.ma_de_xuat || coopGenMa('mou', id)], ['NgÆ°á»i gá»­i', row.submitted_by_name || row.submitted_by_email], ['Äá»‘i tÃ¡c', row.ten_doi_tac || 'â€”'], ['Ã kiáº¿n PhÃ²ng', note || 'â€”']],
          'TrÃ¢n trá»ng,<br/>PhÃ²ng KHCN&QHÄN', (process.env.BASE_URL || 'http://localhost:' + PORT) + '/module-hoatac-quocte.html'),
        text: `TrÃ¬nh duyá»‡t MOU ${row.ma_de_xuat}.` });
    }
    return res.json({ ok: true, message: label, status: newStatus });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// PhÃª duyá»‡t/Tá»« chá»‘i MOU â€” Admin hoáº·c Viá»‡n trÆ°á»Ÿng
app.put('/api/cooperation/mou/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoáº·c action khÃ´ng há»£p lá»‡. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    const r = db.prepare('UPDATE cooperation_mou_de_xuat SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateMouVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[mou] legacy duyet: chÆ°a cÃ³ máº«u Word â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx) má»™t láº§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[mou] Auto Word legacy duyet:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('mou', id, 3, 'tu_choi', 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('mou', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi mou]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'ÄÃ£ phÃª duyá»‡t Ä‘á» xuáº¥t MOU.' : 'ÄÃ£ tá»« chá»‘i Ä‘á» xuáº¥t MOU.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// PhÃª duyá»‡t/Tá»« chá»‘i ÄoÃ n ra â€” Admin hoáº·c Viá»‡n trÆ°á»Ÿng
app.put('/api/cooperation/doan-ra/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoáº·c action khÃ´ng há»£p lá»‡. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\'), coop_reminder_last_at = NULL WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateDoanRaVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_ra] ÄÃ£ phÃª duyá»‡t (legacy) nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx) má»™t láº§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_ra] Auto Word sau duyet legacy:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('doan_ra', id, 3, 'tu_choi', 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('doan_ra', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi doan_ra]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'ÄÃ£ phÃª duyá»‡t Ä‘á» xuáº¥t ÄoÃ n ra.' : 'ÄÃ£ tá»« chá»‘i Ä‘á» xuáº¥t ÄoÃ n ra.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// ========== HTQT Äá»€ XUáº¤T YTNN (ChÆ°Æ¡ng VII Quy cháº¿ KHCN-ÄMST SCI 2026) ==========
function canAccessHtqtDeXuat(req, row) {
  const role = (req.user.role || '').toLowerCase();
  const email = (req.user.email || '').trim().toLowerCase();
  if (role === 'admin') return true;
  if (roleIsAny(req, ['phong_khcn'])) return true;
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
  if (l === 'hoat_dong_khcn') return 'PhÃª duyá»‡t tiáº¿p nháº­n vÃ  giao PhÃ²ng KHCN cáº¥p mÃ£ dá»± Ã¡n (Äiá»u 62, 64)';
  if (l === 'tai_tro_vien_tro') return 'XÃ¡c nháº­n Ä‘á»ƒ trÃ¬nh TrÆ°á»ng ÄHKHTN phÃª duyá»‡t (Äiá»u 64)';
  if (l === 'dich_vu_khcn') return 'PhÃª duyá»‡t triá»ƒn khai theo quy trÃ¬nh dá»‹ch vá»¥ (Äiá»u 64)';
  return 'PhÃª duyá»‡t theo quy Ä‘á»‹nh';
}

// GET Äá» xuáº¥t YTNN chi tiáº¿t â€” vien_truong, admin, phong_khcn, chu_nhiem
app.get('/api/htqt/de-xuat/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    if (!canAccessHtqtDeXuat(req, row)) return res.status(403).json({ message: 'KhÃ´ng cÃ³ quyá»n xem Ä‘á» xuáº¥t nÃ y' });
    const files = db.prepare('SELECT id, loai_file, ten_file, duong_dan, uploaded_by_id, uploaded_at FROM htqt_de_xuat_files WHERE de_xuat_id = ? ORDER BY id').all(id);
    const history = db.prepare('SELECT id, action, performed_by_name, performed_at, note FROM htqt_de_xuat_history WHERE de_xuat_id = ? ORDER BY performed_at DESC').all(id);
    const phi = phiQuanLyTheoLoaiHinh(row.loai_hinh, row.kinh_phi_vnd);
    const coNgÆ°á»¡ngKinhPhi = (row.kinh_phi_vnd || 0) > 500000000;
    const coNgÆ°á»¡ngThoiGian = (row.thoi_gian_thang || 0) > 60;
    const filesBatBuoc = ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'];
    const filesCo = (files || []).map(f => (f.loai_file || '').toLowerCase());
    const thieuFile = filesBatBuoc.filter(loai => !filesCo.includes(loai));
    const coThieuHoSo = thieuFile.length > 0;
    const chuaPhanLoai = !row.loai_hinh || !row.loai_hinh.trim();
    const co = { NGÆ¯á» NG_KINH_PHI: coNgÆ°á»¡ngKinhPhi, NGÆ¯á» NG_THOI_GIAN: coNgÆ°á»¡ngThoiGian, CHUA_PHAN_LOAI: chuaPhanLoai, THIEU_HO_SO: coThieuHoSo };
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
    return res.status(500).json({ message: 'Lá»—i há»‡ thá»‘ng' });
  }
});

// POST PhÃª duyá»‡t â€” vien_truong hoáº·c admin
app.post('/api/htqt/de-xuat/:id/phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { y_kien, ngay_ky, so_van_ban } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isAdmin) {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i Ä‘Æ°á»£c phÃª duyá»‡t' });
    } catch (e) {
      return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i Ä‘Æ°á»£c phÃª duyá»‡t' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    const stl = (row.status || '').toLowerCase();
    if (stl !== 'cho_vt_phe_duyet' && stl !== 'cho_vt_duyet') return res.status(400).json({ message: 'Tráº¡ng thÃ¡i khÃ´ng cho phÃ©p phÃª duyá»‡t' });
    if (!row.loai_hinh) return res.status(400).json({ message: 'ChÆ°a phÃ¢n loáº¡i loáº¡i hÃ¬nh' });
    const ngayKy = (ngay_ky || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    db.prepare('UPDATE htqt_de_xuat SET status = \'da_duyet\', vt_y_kien = ?, vt_ngay_ky = ?, vt_so_van_ban = ?, vt_nguoi_ky_id = ?, vt_xu_ly_id = ?, vt_xu_ly_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .run(y_kien || null, ngayKy, so_van_ban || null, req.user.id, req.user.id, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'phe_duyet', req.user.id, req.user.fullname || req.user.email, y_kien || '');
    try {
      const gen = coopTryAutoGenerateYtnnVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[htqt legacy] ÄÃ£ phÃª duyá»‡t YTNN nhÆ°ng chÆ°a cÃ³ máº«u Word â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx).');
      }
    } catch (e) {}
    return res.json({ message: 'ÄÃ£ phÃª duyá»‡t Ä‘á» xuáº¥t.', status: 'da_duyet' });
  } catch (e) {
    console.error('[API] phe-duyet error:', e.message);
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// POST YÃªu cáº§u bá»• sung â€” vien_truong, admin
app.post('/api/htqt/de-xuat/:id/yeu-cau-bo-sung', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { noi_dung, han_bo_sung, gui_den } = req.body || {};
  if (!noi_dung || (noi_dung || '').trim().length < 20) return res.status(400).json({ message: 'Ná»™i dung yÃªu cáº§u tá»‘i thiá»ƒu 20 kÃ½ tá»±' });
  if (!han_bo_sung) return res.status(400).json({ message: 'Háº¡n bá»• sung báº¯t buá»™c' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'yeu_cau_bo_sung\', updated_at = datetime(\'now\') WHERE id = ?').run(id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'yeu_cau_bo_sung', req.user.id, req.user.fullname || req.user.email, noi_dung.trim(), JSON.stringify({ han_bo_sung, gui_den: gui_den || [] }));
    return res.json({ message: 'ÄÃ£ gá»­i yÃªu cáº§u bá»• sung.', status: 'yeu_cau_bo_sung' });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// POST KhÃ´ng phÃª duyá»‡t â€” vien_truong hoáº·c admin
app.post('/api/htqt/de-xuat/:id/khong-phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ly_do } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  if (!ly_do || (ly_do || '').trim().length < 30) return res.status(400).json({ message: 'LÃ½ do tá»‘i thiá»ƒu 30 kÃ½ tá»±' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i Ä‘Æ°á»£c thá»±c hiá»‡n' });
    } catch (e) {
      return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i Ä‘Æ°á»£c thá»±c hiá»‡n' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'tu_choi\', ly_do_khong_duyet = ?, updated_at = datetime(\'now\') WHERE id = ?').run(ly_do.trim(), id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'khong_phe_duyet', req.user.id, req.user.fullname || req.user.email, ly_do.trim());
    return res.json({ message: 'ÄÃ£ ghi nháº­n khÃ´ng phÃª duyá»‡t.', status: 'tu_choi' });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// PATCH Admin cáº­p nháº­t â€” admin only
app.patch('/api/htqt/de-xuat/:id/admin', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ma_de_xuat, nguoi_phu_trach_id, muc_do_uu_tien, ghi_chu_noi_bo, trang_thai, loai_hinh } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡' });
  try {
    const updates = [];
    const params = [];
    if (ma_de_xuat != null) { updates.push('ma_de_xuat = ?'); params.push(ma_de_xuat); }
    if (nguoi_phu_trach_id != null) { updates.push('nguoi_phu_trach_id = ?'); params.push(nguoi_phu_trach_id); }
    if (muc_do_uu_tien != null) { updates.push('muc_do_uu_tien = ?'); params.push(muc_do_uu_tien); }
    if (ghi_chu_noi_bo != null) { updates.push('ghi_chu_noi_bo = ?'); params.push(ghi_chu_noi_bo); }
    if (trang_thai != null) { updates.push('status = ?'); params.push(trang_thai); }
    if (loai_hinh != null) { updates.push('loai_hinh = ?'); params.push(loai_hinh); }
    if (updates.length === 0) return res.status(400).json({ message: 'KhÃ´ng cÃ³ trÆ°á»ng nÃ o cáº­p nháº­t' });
    params.push(id);
    db.prepare('UPDATE htqt_de_xuat SET ' + updates.join(', ') + ', updated_at = datetime(\'now\') WHERE id = ?').run(...params);
    return res.json({ message: 'ÄÃ£ cáº­p nháº­t.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// POST Táº¡o Ä‘á» xuáº¥t YTNN (demo / PhÃ²ng KHCN) â€” Ä‘á»ƒ cÃ³ dá»¯ liá»‡u test
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
      body.ten || 'Äá» xuáº¥t tiáº¿p nháº­n tÃ i chÃ­nh YTNN máº«u',
      body.mo_ta || 'MÃ´ táº£ tÃ³m táº¯t Ä‘á» xuáº¥t há»£p tÃ¡c quá»‘c táº¿.',
      body.doi_tac_ten || 'Äáº¡i há»c Kyoto',
      body.doi_tac_quoc_gia || 'Nháº­t Báº£n',
      body.chu_nhiem_ten || user.fullname || 'Chá»§ nhiá»‡m',
      body.chu_nhiem_hoc_vi || 'TS.',
      body.chu_nhiem_don_vi || 'PhÃ²ng Lab',
      body.ngay_bat_dau || (year + '-04-01'),
      body.ngay_ket_thuc || (year + '-12-31'),
      body.thoi_gian_thang || 9,
      body.kinh_phi_vnd || 300000000,
      body.loai_hinh || 'hoat_dong_khcn',
      body.to_trinh_phong_khcn || 'PhÃ²ng KHCN&QHÄN Ä‘á» nghá»‹ Viá»‡n trÆ°á»Ÿng xem xÃ©t phÃª duyá»‡t Ä‘á» xuáº¥t tiáº¿p nháº­n tÃ i chÃ­nh YTNN theo Äiá»u 62, 63, 64 Quy cháº¿ KHCN-ÄMST SCI 2026.',
      body.status || 'cho_vt_duyet',
      body.ngay_tiep_nhan || new Date().toISOString().slice(0, 10),
      body.han_xu_ly_vt || (() => { const d = new Date(); d.setDate(d.getDate() + 5); return d.toISOString().slice(0, 10); })(),
      user.email || '',
      user.fullname || '',
      user.id || null
    );
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    const ma = body.ma_de_xuat || ('ÄX-' + year + '-' + String(id).padStart(4, '0'));
    db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat = ? WHERE id = ?').run(ma, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'tao_moi', user.id, user.fullname || user.email, 'Táº¡o Ä‘á» xuáº¥t');
    ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'].forEach(function(loai) {
      try {
        db.prepare('INSERT INTO htqt_de_xuat_files (de_xuat_id, loai_file, ten_file, uploaded_by_id) VALUES (?, ?, ?, ?)')
          .run(id, loai, loai.replace(/_/g, ' ') + '.pdf', user.id);
      } catch (e) {}
    });
    return res.json({ message: 'ÄÃ£ táº¡o Ä‘á» xuáº¥t.', id, ma_de_xuat: ma });
  } catch (e) {
    console.error('[API] htqt/de-xuat create error:', e.message);
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// ThÃªm htqt_de_xuat vÃ o danh sÃ¡ch chá» duyá»‡t
function addHtqtToChoDuyetList(list, year) {
  try {
    const rows = db.prepare('SELECT id, ten, chu_nhiem_ten, loai_hinh, status, created_at, ngay_tiep_nhan FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\') ORDER BY created_at ASC').all();
    for (const r of rows || []) {
      list.push({
        source: 'htqt',
        id: r.id,
        ma_de_xuat: r.ma_de_xuat || ('ÄX-' + year + '-' + String(r.id).padStart(4, '0')),
        title: (r.ten || 'â€”') + (r.chu_nhiem_ten ? ' â€” ' + r.chu_nhiem_ten : ''),
        submitted_by: r.chu_nhiem_ten || 'â€”',
        ngay_gui: (r.ngay_tiep_nhan || r.created_at || '').slice(0, 10),
        status: r.status,
        loai_hinh: r.loai_hinh
      });
    }
  } catch (e) {}
}

// Äá» xuáº¥t cá»§a tÃ´i â€” danh sÃ¡ch Ä‘á» xuáº¥t user Ä‘Ã£ gá»­i (MOU, ÄoÃ n ra)
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
        ma_de_xuat: 'ÄX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Äá» xuáº¥t MOU â€” ' + (r.ten_doi_tac || 'â€”') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'dang_tham_dinh',
        step: r.status === 'dang_tham_dinh' ? 1 : (r.status === 'da_duyet' ? 4 : 2),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN'
      });
    }
    const doans = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, status, created_at FROM cooperation_doan_ra WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
    for (const r of doans || []) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      list.push({
        source: 'doan_ra',
        loai: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'ÄX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'ÄÄƒng kÃ½ ÄoÃ n ra â€” ' + (r.muc_dich || r.quoc_gia || 'â€”') + (r.quoc_gia ? ', ' + r.quoc_gia : '') + ' â€” ' + soTV + ' thÃ nh viÃªn',
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'cho_phong_duyet',
        step: r.status === 'da_duyet' ? 4 : (r.status === 'tu_choi' ? 4 : r.status === 'dang_chuan_bi' ? 2 : 1),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN'
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
          ma_de_xuat: 'ÄX-' + year + '-V' + String(r.id).padStart(4, '0'),
          title: 'ÄÄƒng kÃ½ ÄoÃ n vÃ o â€” ' + (r.muc_dich || 'â€”') + ' â€” ' + (r.don_vi_de_xuat || 'â€”'),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_tham_dinh',
          step,
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN'
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
          title: 'Äá» tÃ i cÃ³ yáº¿u tá»‘ nÆ°á»›c ngoÃ i â€” ' + (r.ten || 'â€”'),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_phong_duyet',
          step: 1,
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN'
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
          draft: 'NhÃ¡p',
          submitted: 'Chá» PhÃ²ng KHCN',
          khcn_reviewing: 'PhÃ²ng Ä‘ang xem xÃ©t',
          khcn_approved: 'Chá» Viá»‡n trÆ°á»Ÿng',
          director_reviewing: 'Viá»‡n trÆ°á»Ÿng Ä‘ang xem xÃ©t',
          director_approved: 'ÄÃ£ phÃª duyá»‡t',
          director_rejected: 'Viá»‡n trÆ°á»Ÿng tá»« chá»‘i',
          khcn_rejected: 'PhÃ²ng KHCN tá»« chá»‘i',
          completed: 'ÄÃ£ ná»™p minh chá»©ng',
        };
        for (const r of hn || []) {
          list.push({
            source: 'hnht',
            loai: 'hnht',
            id: r.id,
            ma_de_xuat: r.submission_code || '',
            title: 'HN/HT â€” ' + (r.conf_name || 'â€”'),
            ngay_gui: (r.created_at || '').slice(0, 10),
            status: r.status || 'draft',
            status_label: HN_ST[r.status] || r.status,
            step: 1,
            yeu_cau_bo_sung: null,
            han_phan_hoi: null,
            nguoi_xu_ly: 'PhÃ²ng KHCN&QHÄN',
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

// Gá»­i Ä‘á» xuáº¥t ÄoÃ n ra: lÆ°u vÃ o DB + gá»­i email tá»›i danh sÃ¡ch nháº­n thÃ´ng bÃ¡o (topic doan_ra hoáº·c all)
app.post('/api/cooperation/doan-ra/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'NgÆ°á»i dÃ¹ng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || 'â€”';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || 'â€”';
  const ngayDi = (body.ngay_di || body.ngayDi || '').trim() || 'â€”';
  const ngayVe = (body.ngay_ve || body.ngayVe || '').trim() || 'â€”';
  const thanhVien = (body.thanh_vien || body.thanhVien || '').trim() || 'â€”';
  const nguonKinhPhi = (body.nguon_kinh_phi || body.nguonKinhPhi || '').trim() || 'â€”';
  const duToan = (body.du_toan != null && body.du_toan !== '') ? String(body.du_toan) : 'â€”';
  const toList = getCooperationRecipients('doan_ra');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'ChÆ°a cÃ³ email nháº­n thÃ´ng bÃ¡o ÄoÃ n ra. Admin vui lÃ²ng thÃªm trong Quáº£n trá»‹ module Há»£p tÃ¡c Quá»‘c táº¿.',
      sent: 0
    });
  }
  try {
    db.prepare(
      `INSERT INTO cooperation_doan_ra (submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_phong_duyet')`
    ).run(submittedByEmail, submittedBy, mucDich, quocGia, ngayDi, ngayVe, thanhVien, nguonKinhPhi, duToan);
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i lÆ°u Ä‘á» xuáº¥t: ' + (e.message || ''), sent: 0 });
  }
  const newRowId = (db.prepare('SELECT last_insert_rowid() as id').get() || {}).id;
  try {
    if (newRowId) coopAddHistory('doan_ra', newRowId, 1, 'gui', 'Ná»™p Ä‘á» xuáº¥t ÄoÃ n ra', user, null);
  } catch (e) {}
  /* Pháº£i dÃ¹ng newRowId: sau coopAddHistory, last_insert_rowid() lÃ  id báº£ng coop_history, khÃ´ng pháº£i cooperation_doan_ra â†’ UPDATE ma sai, mÃ£ khÃ´ng lÆ°u */
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
  const subjectFormal = '[Há»£p tÃ¡c QT] KÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng: Äá» xuáº¥t Ä‘Äƒng kÃ½ ÄoÃ n ra cÃ´ng tÃ¡c nÆ°á»›c ngoÃ i â€” ' + maDeXuat;
  const introFormal = 'KÃ­nh gá»­i <strong>Viá»‡n trÆ°á»Ÿng</strong> xem xÃ©t chá»‰ Ä‘áº¡o; <strong>PhÃ²ng KHCN&amp;QHÄN</strong> vÃ  cÃ¡c Ä‘Æ¡n vá»‹ liÃªn quan Ä‘Æ°á»£c CC Ä‘á»ƒ phá»‘i há»£p tháº©m Ä‘á»‹nh theo quy Ä‘á»‹nh. Äá» xuáº¥t do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gá»­i trÃªn Há»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c.';
  const htmlFormal = coopBuildEmail(
    'ThÃ´ng bÃ¡o Ä‘á» xuáº¥t ÄoÃ n ra cÃ´ng tÃ¡c nÆ°á»›c ngoÃ i',
    introFormal,
    [['MÃ£ Ä‘á» xuáº¥t', maDeXuat], ['Má»¥c Ä‘Ã­ch', mucDich], ['Quá»‘c gia / Äá»‹a Ä‘iá»ƒm', quocGia], ['NgÃ y Ä‘i', ngayDi], ['NgÃ y vá»', ngayVe], ['ThÃ nh viÃªn Ä‘oÃ n', thanhVien.replace(/\n/g, '<br>')], ['Nguá»“n kinh phÃ­', nguonKinhPhi], ['Dá»± toÃ¡n (VND)', duToan]],
    'TrÃ¢n trá»ng kÃ­nh gá»­i,<br/>Há»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c<br/><span style="font-size:12px;color:#64748b">(ThÃ´ng bÃ¡o tá»± Ä‘á»™ng tá»« há»‡ thá»‘ng)</span>',
    moduleLink
  );
  const textFormal = 'KÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng (CC PhÃ²ng KHCN&QHÄN vÃ  cÃ¡c Ä‘á»‹a chá»‰ nháº­n thÃ´ng bÃ¡o theo cáº¥u hÃ¬nh),\n\n' +
    'Äá» xuáº¥t Ä‘Äƒng kÃ½ ÄoÃ n ra cÃ´ng tÃ¡c nÆ°á»›c ngoÃ i.\nMÃ£: ' + maDeXuat + '\nNgÆ°á»i gá»­i: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
    'Má»¥c Ä‘Ã­ch: ' + mucDich + '\nQuá»‘c gia/Äá»‹a Ä‘iá»ƒm: ' + quocGia + '\nNgÃ y Ä‘i: ' + ngayDi + '\nNgÃ y vá»: ' + ngayVe + '\n' +
    'Dá»± toÃ¡n (VND): ' + duToan + '\n\nXem chi tiáº¿t: ' + moduleLink + '\n\nTrÃ¢n trá»ng kÃ­nh gá»­i,\nHá»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c';
  if (!transporter) {
    return res.json({ message: 'ÄÃ£ lÆ°u Ä‘á» xuáº¥t. Há»‡ thá»‘ng chÆ°a cáº¥u hÃ¬nh SMTP nÃªn chÆ°a gá»­i Ä‘Æ°á»£c email thÃ´ng bÃ¡o.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
  }
  coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
    .then(() => {
      const n = toMail.length + ccMail.length;
      res.json({ message: 'ÄÃ£ gá»­i Ä‘á» xuáº¥t ÄoÃ n ra. Email kÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng (CC PhÃ²ng KHCN vÃ  cÃ¡c Ä‘á»‹a chá»‰ nháº­n thÃ´ng bÃ¡o theo cáº¥u hÃ¬nh).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
    })
    .catch(err => {
    console.error('[Email] Gá»­i thÃ´ng bÃ¡o ÄoÃ n ra lá»—i:', err.message);
    res.status(500).json({ message: 'Gá»­i email tháº¥t báº¡i: ' + (err.message || 'Lá»—i há»‡ thá»‘ng.'), sent: 0 });
  });
});

// Gá»­i Ä‘á» xuáº¥t ÄoÃ n vÃ o â€” Ä‘á»“ng bá»™ quy trÃ¬nh & mÃ£ vá»›i ÄoÃ n ra (cho_phong_duyet â†’ tháº©m Ä‘á»‹nh â†’ VT)
app.post('/api/cooperation/doan-vao/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'NgÆ°á»i dÃ¹ng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || 'â€”';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || 'â€”';
  const ngayDen = (body.ngay_den || body.ngayDen || '').trim() || 'â€”';
  const ngayRoiDi = (body.ngay_roi_di || body.ngayRoiDi || '').trim() || 'â€”';
  const thanhPhanDoan = (body.thanh_phan_doan || body.thanhPhanDoan || '').trim() || 'â€”';
  const noiDungLamViec = (body.noi_dung_lam_viec || body.noiDungLamViec || '').trim() || 'â€”';
  const kinhPhiNguon = (body.kinh_phi_nguon || body.kinhPhiNguon || '').trim() || 'â€”';
  const hoTroVisa = (body.ho_tro_visa || body.hoTroVisa || '').trim() || 'â€”';
  const toList = getCooperationRecipients('doan_vao');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'ChÆ°a cÃ³ email nháº­n thÃ´ng bÃ¡o ÄoÃ n vÃ o. Admin vui lÃ²ng thÃªm trong Quáº£n trá»‹ Há»£p tÃ¡c Quá»‘c táº¿ â†’ Danh sÃ¡ch email (chá»n topic ÄoÃ n vÃ o).',
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
    return res.status(500).json({ message: 'Lá»—i lÆ°u Ä‘á» xuáº¥t: ' + (e.message || ''), sent: 0 });
  }
  try {
    if (newRowId) coopAddHistory('doan_vao', newRowId, 1, 'gui', 'Ná»™p Ä‘á» xuáº¥t ÄoÃ n vÃ o', user, null);
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
  const subjectFormal = '[Há»£p tÃ¡c QT] KÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng: Äá» xuáº¥t tiáº¿p nháº­n ÄoÃ n vÃ o â€” ' + maDeXuat;
  const introFormal = 'KÃ­nh gá»­i <strong>Viá»‡n trÆ°á»Ÿng</strong> xem xÃ©t chá»‰ Ä‘áº¡o; <strong>PhÃ²ng KHCN&amp;QHÄN</strong> vÃ  cÃ¡c Ä‘Æ¡n vá»‹ liÃªn quan Ä‘Æ°á»£c CC Ä‘á»ƒ phá»‘i há»£p tháº©m Ä‘á»‹nh theo quy Ä‘á»‹nh. Äá» xuáº¥t do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gá»­i trÃªn Há»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c.';
  const htmlFormal = coopBuildEmail(
    'ThÃ´ng bÃ¡o Ä‘á» xuáº¥t tiáº¿p nháº­n ÄoÃ n vÃ o (Ä‘oÃ n khÃ¡ch quá»‘c táº¿)',
    introFormal,
    [['MÃ£ Ä‘á» xuáº¥t', maDeXuat], ['Má»¥c Ä‘Ã­ch', mucDich], ['ÄÆ¡n vá»‹ Ä‘á» xuáº¥t tiáº¿p nháº­n', donViDeXuat], ['NgÃ y Ä‘áº¿n', ngayDen], ['NgÃ y rá»i Ä‘i', ngayRoiDi], ['ThÃ nh pháº§n Ä‘oÃ n khÃ¡ch', thanhPhanDoan.replace(/\n/g, '<br>')], ['Ná»™i dung lÃ m viá»‡c', noiDungLamViec.replace(/\n/g, '<br>')], ['Kinh phÃ­ Ä‘Ã³n tiáº¿p', kinhPhiNguon], ['Há»— trá»£ visa / nháº­p cáº£nh', hoTroVisa]],
    'TrÃ¢n trá»ng kÃ­nh gá»­i,<br/>Há»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c<br/><span style="font-size:12px;color:#64748b">(ThÃ´ng bÃ¡o tá»± Ä‘á»™ng tá»« há»‡ thá»‘ng)</span>',
    moduleLink
  );
  const textFormal = 'KÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng (CC PhÃ²ng KHCN&QHÄN vÃ  cÃ¡c Ä‘á»‹a chá»‰ nháº­n thÃ´ng bÃ¡o theo cáº¥u hÃ¬nh),\n\n' +
    'Äá» xuáº¥t tiáº¿p nháº­n ÄoÃ n vÃ o.\nMÃ£: ' + maDeXuat + '\nNgÆ°á»i gá»­i: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
    'Má»¥c Ä‘Ã­ch: ' + mucDich + '\nÄÆ¡n vá»‹: ' + donViDeXuat + '\nNgÃ y Ä‘áº¿n: ' + ngayDen + '\nNgÃ y rá»i: ' + ngayRoiDi + '\n' +
    'ThÃ nh pháº§n: ' + thanhPhanDoan + '\n\nXem chi tiáº¿t: ' + moduleLink + '\n\nTrÃ¢n trá»ng kÃ­nh gá»­i,\nHá»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c';
  if (!transporter) {
    return res.json({ message: 'ÄÃ£ lÆ°u Ä‘á» xuáº¥t. Há»‡ thá»‘ng chÆ°a cáº¥u hÃ¬nh SMTP nÃªn chÆ°a gá»­i Ä‘Æ°á»£c email thÃ´ng bÃ¡o.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
  }
  coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
    .then(() => {
      const n = toMail.length + ccMail.length;
      res.json({ message: 'ÄÃ£ gá»­i Ä‘á» xuáº¥t ÄoÃ n vÃ o. Email kÃ­nh gá»­i Viá»‡n trÆ°á»Ÿng (CC PhÃ²ng KHCN vÃ  cÃ¡c Ä‘á»‹a chá»‰ nháº­n thÃ´ng bÃ¡o theo cáº¥u hÃ¬nh).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
    })
    .catch(err => {
    console.error('[Email] Gá»­i thÃ´ng bÃ¡o ÄoÃ n vÃ o lá»—i:', err.message);
    res.status(500).json({ message: 'Gá»­i email tháº¥t báº¡i: ' + (err.message || 'Lá»—i há»‡ thá»‘ng.'), sent: 0 });
  });
});

// Danh sÃ¡ch Ä‘á» xuáº¥t ÄoÃ n ra (dá»¯ liá»‡u tháº­t, quÃ¡ trÃ¬nh xá»­ lÃ½)
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

// Danh sÃ¡ch Ä‘á» xuáº¥t ÄoÃ n vÃ o (Ä‘á»“ng bá»™ vá»›i báº£ng "Ä‘Ã£ gá»­i" trÃªn giao diá»‡n â€” giá»‘ng ÄoÃ n ra)
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

// Danh sÃ¡ch Ä‘á» xuáº¥t Thá»a thuáº­n / MOU (giá»‘ng ÄoÃ n ra â€” báº£ng Â«Ä‘Ã£ gá»­iÂ» trÃªn module)
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

// Admin: cáº­p nháº­t tráº¡ng thÃ¡i Ä‘á» xuáº¥t ÄoÃ n ra (quÃ¡ trÃ¬nh xá»­ lÃ½)
app.put('/api/admin/cooperation/doan-ra/:id/status', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = (req.body && req.body.status) ? String(req.body.status).trim() : '';
  const allowed = ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung', 'cho_ky_duyet', 'dang_chuan_bi', 'da_duyet', 'tu_choi', 'ket_thuc_boi_nguoi_nop'];
  if (!id || !allowed.includes(status)) {
    return res.status(400).json({ message: 'ID hoáº·c tráº¡ng thÃ¡i khÃ´ng há»£p lá»‡. Tráº¡ng thÃ¡i: cho_phong_duyet | cho_vt_duyet | yeu_cau_bo_sung | da_duyet | tu_choi | ket_thuc_boi_nguoi_nop | â€¦' });
  }
  try {
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\'), coop_reminder_last_at = NULL WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
    if (status === 'da_duyet') {
      coopTryAutoGenerateDoanRaVanBan(id);
    }
    return res.json({ message: 'ÄÃ£ cáº­p nháº­t tráº¡ng thÃ¡i.', status });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
});

// Tá»•ng quan Há»£p tÃ¡c Quá»‘c táº¿ â€” sá»‘ liá»‡u tháº­t cho dashboard
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
        title: r.ten || (r.doi_tac + ' sáº¯p háº¿t háº¡n'),
        deadline: r.het_han || 'â€”',
        status: 'sap_het_han',
        statusLabel: 'Sáº¯p háº¿t háº¡n',
        action: 'thoathuan'
      });
    }
    for (const r of (doanRa || []).filter(x => ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung'].includes((x.status || '').toLowerCase()))) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      const st = (r.status || '').toLowerCase();
      const stLabel = st === 'cho_vt_duyet' ? 'Chá» Viá»‡n trÆ°á»Ÿng' : st === 'cho_phong_duyet' ? 'Chá» PhÃ²ng KHCN' : 'YÃªu cáº§u bá»• sung';
      pendingItems.push({
        type: 'doan_ra',
        typeLabel: 'ÄoÃ n ra',
        title: (r.muc_dich || r.quoc_gia || 'ÄoÃ n ra') + ' â€” ' + soTV + ' thÃ nh viÃªn',
        deadline: r.ngay_di || 'â€”',
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
        typeLabel: 'Äá» xuáº¥t MOU',
        title: 'MOU vá»›i ' + (r.ten_doi_tac || 'â€”'),
        deadline: 'â€”',
        status: 'dang_tham_dinh',
        statusLabel: 'Äang tháº©m Ä‘á»‹nh',
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
          typeLabel: 'Äá» xuáº¥t YTNN',
          title: (r.ten || 'â€”') + (r.chu_nhiem_ten ? ' â€” ' + r.chu_nhiem_ten : ''),
          deadline: r.han_xu_ly_vt || 'â€”',
          status: r.status || 'cho_vt_duyet',
          statusLabel: 'Chá» phÃª duyá»‡t',
          action: 'de-xuat-cho-duyet',
          source: 'htqt',
          id: r.id
        });
      }
    } catch (e) {}
    pendingItems.sort((a, b) => {
      if (a.deadline === 'â€”' && b.deadline === 'â€”') return 0;
      if (a.deadline === 'â€”') return 1;
      if (b.deadline === 'â€”') return -1;
      return String(a.deadline).localeCompare(String(b.deadline));
    });
    const formatTongKinhPhi = (v) => {
      if (v >= 1e9) return (v / 1e9).toFixed(1) + ' tá»·';
      if (v >= 1e6) return (v / 1e6).toFixed(0) + ' triá»‡u';
      return v ? String(Math.round(v)) : 'â€”';
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
      stats: { total_doi_tac: 0, mou_hieu_luc: 0, mou_sap_het_han: 0, de_tai_dang_chay: 0, de_tai_cho_duyet: 0, de_xuat_cho_duyet: 0, tong_kinh_phi: 0, tong_kinh_phi_formatted: 'â€”', so_quoc_gia: 0 },
      pending_items: []
    });
  }
});

/** Äá»‘i tÃ¡c há»£p tÃ¡c â€” cÃ¹ng logic vá»›i GET /api/cooperation/doi-tac (dÃ¹ng cho trang chá»§ + module) */
function cooperationComputePartnerStats() {
  const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac FROM cooperation_thoa_thuan').all();
  const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status FROM cooperation_mou_de_xuat').all();
  let missions = [];
  try {
    missions = db.prepare('SELECT id, cooperating_units, status FROM missions WHERE cooperating_units IS NOT NULL AND cooperating_units != \'\'').all();
  } catch (e) { /* báº£ng missions cÃ³ thá»ƒ chÆ°a cÃ³ cá»™t */ }
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
    if (q.includes('viá»‡t nam') || q.includes('viet nam') || q.includes('vn')) return 'trong_nuoc';
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

// Danh sÃ¡ch Äá»‘i tÃ¡c Quá»‘c táº¿ â€” tá»•ng há»£p tá»« thá»a thuáº­n, Ä‘á» xuáº¥t MOU, dá»± Ã¡n (missions)
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

// Danh sÃ¡ch Thá»a thuáº­n (MOU, MOA, HÄ KH&CN, LOI)
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
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  try {
    const row = db.prepare(
      `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
              no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
       FROM cooperation_thoa_thuan WHERE id = ?`
    ).get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y thá»a thuáº­n.' });
    return res.json({ ok: true, item: row });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + e.message });
  }
});

function parseDownloadFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function sendCooperationScanFile(res, storedPath, originalName, forceDownload) {
  const checked = normalizeAndCheckDownloadPath(storedPath);
  if (checked.err === 403) return res.status(403).send('Truy cáº­p bá»‹ tá»« chá»‘i');
  if (checked.err) return res.status(404).send('File khÃ´ng tá»“n táº¡i');

  const displayName = String(originalName || path.basename(checked.norm) || 'scan.pdf').trim() || 'scan.pdf';
  const fallbackName = displayName.replace(/["\\\r\n]/g, '_');
  const encodedName = encodeURIComponent(displayName);
  const disposition = forceDownload ? 'attachment' : 'inline';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
  );
  return res.sendFile(checked.norm);
}

// Xem / táº£i báº£n scan thá»a thuáº­n qua API cÃ³ auth (khÃ´ng má»Ÿ trá»±c tiáº¿p /uploads/*)
app.get('/api/cooperation/thoa-thuan/:id/scan', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  try {
    const row = db.prepare('SELECT scan_file_path, scan_file_name FROM cooperation_thoa_thuan WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y thá»a thuáº­n.' });
    return sendCooperationScanFile(res, row.scan_file_path, row.scan_file_name, parseDownloadFlag(req.query.download));
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + e.message });
  }
});

// Xem / táº£i vÄƒn báº£n káº¿t thÃºc thá»a thuáº­n qua API cÃ³ auth
app.get('/api/cooperation/thoa-thuan/:id/termination-scan', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  try {
    const row = db
      .prepare('SELECT termination_scan_path, termination_scan_name FROM cooperation_thoa_thuan WHERE id = ?')
      .get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y thá»a thuáº­n.' });
    return sendCooperationScanFile(
      res,
      row.termination_scan_path,
      row.termination_scan_name,
      parseDownloadFlag(req.query.download)
    );
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + e.message });
  }
});


// Admin / P.KHCN: xÃ³a thá»a thuáº­n
app.delete('/api/admin/cooperation/thoa-thuan/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  try {
    const r = db.prepare('DELETE FROM cooperation_thoa_thuan WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    return res.json({ ok: true, message: 'ÄÃ£ xÃ³a thá»a thuáº­n.' });
  } catch(e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

// P.KHCN / Admin: sá»­a thá»a thuáº­n (staff notes, open-ended flag, core fields)
app.put('/api/admin/cooperation/thoa-thuan/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  let prev;
  try {
    prev = db.prepare('SELECT * FROM cooperation_thoa_thuan WHERE id=?').get(id);
  } catch (e) {}
  if (!prev) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
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
        return res.status(400).json({ message: 'ÄÃ£ ghi nháº­n káº¿t thÃºc; khÃ´ng thá»ƒ chuyá»ƒn láº¡i sang khÃ´ng thá»i háº¡n cá»‘ Ä‘á»‹nh qua form nÃ y.' });
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
        return res.status(400).json({ message: 'Thá»i háº¡n cá»‘ Ä‘á»‹nh cáº§n cÃ³ ngÃ y háº¿t hiá»‡u lá»±c (het_han, YYYY-MM-DD).' });
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃ´ng cÃ³ gÃ¬ cáº­p nháº­t.' });
  sets.push("updated_at=datetime('now','localtime')");
  vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_thoa_thuan SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    return res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t.' });
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + e.message });
  }
});

// P.KHCN/Admin: thÃªm thá»a thuáº­n + upload scan
app.post('/api/cooperation/thoa-thuan', authMiddleware, coopPhongOrAdmin, (req, res) => {
  uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload file tháº¥t báº¡i' });
    const { ten, doi_tac, loai, het_han, ngay_ky, thoi_han_nam, quoc_gia, loai_doi_tac, staff_notes } = req.body || {};
    const tenTrim = (ten || '').trim();
    const doiTacTrim = (doi_tac || '').trim();
    const loaiTrim = (loai || '').trim();
    if (!tenTrim || !doiTacTrim || !loaiTrim) {
      return res.status(400).json({ message: 'Thiáº¿u TÃªn thá»a thuáº­n, Äá»‘i tÃ¡c hoáº·c Loáº¡i' });
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
        return res.status(400).json({ message: 'Vui lÃ²ng nháº­p NgÃ y kÃ½ (thá»i háº¡n khÃ´ng cá»‘ Ä‘á»‹nh váº«n cáº§n ngÃ y kÃ½ Ä‘á»ƒ há»“ sÆ¡).' });
      }
      hetHanVal = null;
      noFixedTermInt = 1;
    } else {
      if (nk && thnRaw !== '' && Number.isFinite(thn)) {
        const computed = thoaThuanHetHanFromSigningYears(nk, thn);
        if (!computed) {
          return res.status(400).json({ message: 'NgÃ y kÃ½ hoáº·c thá»i háº¡n hiá»‡u lá»±c (nÄƒm) khÃ´ng há»£p lá»‡.' });
        }
        hetHanVal = computed;
      } else {
        hetHanVal = (het_han || '').trim() || null;
      }
      if (!hetHanVal) {
        return res.status(400).json({ message: 'Vui lÃ²ng nháº­p NgÃ y kÃ½ vÃ  Thá»i háº¡n hiá»‡u lá»±c (nÄƒm), hoáº·c chá»n KhÃ´ng cÃ³ thá»i háº¡n cá»‘ Ä‘á»‹nh.' });
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
      return res.status(201).json({ message: 'ÄÃ£ thÃªm thá»a thuáº­n.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
    }
  });
});

// P.KHCN / Admin: record agreement termination date + optional termination document
app.post('/api/cooperation/thoa-thuan/:id/terminate', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  uploadHtqtThoaThuanTermination.single('termination_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload termination file failed' });
    const termRaw = String((req.body && req.body.terminated_at) || '').trim();
    if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(termRaw)) {
      return res.status(400).json({ message: 'Vui lÃ²ng nháº­p ngÃ y káº¿t thÃºc (YYYY-MM-DD).' });
    }
    let prev;
    try {
      prev = db.prepare(
        'SELECT id, termination_scan_path, termination_scan_name, termination_uploaded_at FROM cooperation_thoa_thuan WHERE id = ?'
      ).get(id);
    } catch (e) {
      return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
    }
    if (!prev) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y thá»a thuáº­n.' });
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
      return res.json({ ok: true, message: 'ÄÃ£ ghi nháº­n káº¿t thÃºc thá»a thuáº­n.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
    }
  });
});

// P.KHCN / Admin: replace main agreement scan (PDF/DOCX/image)
app.post('/api/cooperation/thoa-thuan/:id/agreement-scan', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  let exists;
  try {
    exists = db.prepare('SELECT id FROM cooperation_thoa_thuan WHERE id = ?').get(id);
  } catch (e) {
    return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
  }
  if (!exists) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y thá»a thuáº­n.' });
  uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload failed' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file báº£n scan.' });
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
      return res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t báº£n scan.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lá»—i: ' + (e.message || '') });
    }
  });
});

// Admin: cáº­p nháº­t vai trÃ². Cáº¥p / gá»¡ vai trÃ² Admin chá»‰ Master Admin; khÃ´ng gá»¡ Ä‘Æ°á»£c Master.
app.put('/api/admin/users/role', authMiddleware, adminOnly, (req, res) => {
  const { email, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail && role !== 'admin') {
    return res.status(400).json({ message: 'Báº¡n khÃ´ng thá»ƒ tá»± háº¡ vai trÃ² cá»§a chÃ­nh mÃ¬nh' });
  }
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  if (!allowed.includes(role)) {
    return res.status(400).json({ message: 'Vai trÃ² khÃ´ng há»£p lá»‡' });
  }
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  const targetRow = db.prepare('SELECT role FROM users WHERE email = ?').get(em);
  if (!targetRow) {
    return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  }
  const prevRole = (targetRow.role || '').toLowerCase();
  const newRole = (role || '').toLowerCase();
  if ((councilRoles.includes(prevRole) || councilRoles.includes(newRole)) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c sá»­a vai trÃ² thÃ nh viÃªn Há»™i Ä‘á»“ng KHCN.' });
  }
  if ((BUDGET_TEAM_ROLES.includes(prevRole) || BUDGET_TEAM_ROLES.includes(newRole)) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c sá»­a vai trÃ² Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh.' });
  }
  if (newRole === 'admin' && prevRole !== 'admin' && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c cáº¥p vai trÃ² Admin.' });
  }
  if (prevRole === 'admin' && newRole !== 'admin') {
    if (!reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c gá»¡ quyá»n Admin.' });
    }
    if (userEmailIsMasterAdmin(em)) {
      return res.status(400).json({ message: 'KhÃ´ng thá»ƒ gá»¡ quyá»n Master Admin há»‡ thá»‘ng.' });
    }
  }
  if (councilRoles.includes(role) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chá»‰ tÃ i khoáº£n cÃ³ Ä‘uÃ´i @sci.edu.vn má»›i Ä‘Æ°á»£c gÃ¡n vai trÃ² Chá»§ tá»‹ch, ThÆ° kÃ½, ThÃ nh viÃªn Há»™i Ä‘á»“ng' });
  }
  const r = db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, em);
  if (r.changes === 0) {
    return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  }
  return res.json({ message: 'ÄÃ£ cáº­p nháº­t vai trÃ²' });
});

// Admin: xem vai trÃ² HÄKHCN "phá»¥" (council_role_grants) â€” KHÃ”NG Ä‘á»¥ng users.role. DÃ¹ng khi 1 ngÆ°á»i
// vá»«a cáº§n giá»¯ vai trÃ² há»‡ thá»‘ng (vd Viá»‡n trÆ°á»Ÿng, PhÃ²ng KHCN) vá»«a tham gia Há»™i Ä‘á»“ng KHCN (vd Chá»§ tá»‹ch HÄ).
app.get('/api/admin/council-role-grants', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT g.id, g.user_id, g.role, g.granted_at, u.email, u.fullname, u.role AS system_role
         FROM council_role_grants g JOIN users u ON u.id = g.user_id
         ORDER BY u.fullname, u.email, g.role`
      )
      .all();
    return res.json({ ok: true, data: rows });
  } catch (e) {
    return res.status(500).json({ message: 'KhÃ´ng táº£i Ä‘Æ°á»£c danh sÃ¡ch.' });
  }
});

// Admin: thay toÃ n bá»™ táº­p vai trÃ² HÄKHCN phá»¥ cá»§a 1 user (body: { roles: string[] }).
// Chá»‰ Master Admin â€” cÃ¹ng má»©c báº£o vá»‡ nhÆ° /api/admin/users/role Ä‘á»‘i vá»›i council role.
app.put('/api/admin/council-role-grants/:userId', authMiddleware, adminOnly, (req, res) => {
  if (!reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c cáº¥p vai trÃ² Há»™i Ä‘á»“ng KHCN.' });
  }
  const userId = parseInt(req.params.userId, 10);
  if (!userId) return res.status(400).json({ message: 'userId khÃ´ng há»£p lá»‡' });
  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  const em = String(user.email || '').trim().toLowerCase();
  if (!em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'Chá»‰ tÃ i khoáº£n cÃ³ Ä‘uÃ´i @sci.edu.vn má»›i Ä‘Æ°á»£c gÃ¡n vai trÃ² Há»™i Ä‘á»“ng KHCN' });
  }
  const requested = Array.isArray(req.body && req.body.roles) ? req.body.roles : [];
  const roles = Array.from(
    new Set(requested.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean))
  );
  const invalid = roles.filter((r) => !COUNCIL_ROLE_TOKENS.includes(r));
  if (invalid.length) {
    return res.status(400).json({ message: 'Vai trÃ² khÃ´ng há»£p lá»‡: ' + invalid.join(', ') });
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM council_role_grants WHERE user_id = ?').run(userId);
    const ins = db.prepare(
      'INSERT INTO council_role_grants (user_id, role, granted_by_id) VALUES (?, ?, ?)'
    );
    roles.forEach((r) => ins.run(userId, r, req.user.id || null));
  });
  tx();
  return res.json({ ok: true, roles });
});

// Admin: danh sÃ¡ch Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh (Tá»• trÆ°á»Ÿng, ThÃ nh viÃªn)
app.get('/api/admin/budget-appraisal-team', authMiddleware, adminOnly, (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT u.id, u.email, u.fullname, u.academicTitle, u.role, u.createdAt FROM users u
       LEFT JOIN council_role_grants g ON g.user_id = u.id
       WHERE u.role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc')
          OR g.role IN ('totruong_tham_dinh_tc','thanh_vien_tham_dinh_tc')
       ORDER BY u.role, u.fullname, u.email`
    )
    .all();
  return res.json({ members: rows });
});

// Admin: cáº­p nháº­t thÃ nh viÃªn Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh (há» tÃªn, há»c hÃ m há»c vá»‹, vai trÃ²) â€” chá»‰ Master Admin,
// cÃ¹ng má»©c báº£o vá»‡ nhÆ° sá»­a vai trÃ² HÄKHCN.
app.put('/api/admin/budget-appraisal-team', authMiddleware, adminOnly, masterAdminOnly, (req, res) => {
  const { email, fullname, academicTitle, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃ²ng nháº­p email' });
  const allowed = ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || '').toLowerCase();
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trÃ² pháº£i lÃ  Tá»• trÆ°á»Ÿng hoáº·c ThÃ nh viÃªn Tá»• tháº©m Ä‘á»‹nh TC' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!existing) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n. ThÃªm qua form bÃªn trÃªn trÆ°á»›c.' });
  db.prepare('UPDATE users SET fullname = ?, academicTitle = ?, role = ? WHERE email = ?')
    .run((fullname || '').trim(), (academicTitle || '').trim() || null, r, em);
  return res.json({ message: 'ÄÃ£ cáº­p nháº­t thÃ´ng tin thÃ nh viÃªn Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh.' });
});

// Admin: xÃ³a thÃ nh viÃªn khá»i Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh (chuyá»ƒn vai trÃ² vá» NghiÃªn cá»©u viÃªn) â€” chá»‰ Master Admin.
app.delete('/api/admin/budget-appraisal-team/:email', authMiddleware, adminOnly, masterAdminOnly, (req, res) => {
  const em = decodeURIComponent(req.params.email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  if (!['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(row.role)) {
    return res.status(400).json({ message: 'NgÆ°á»i nÃ y khÃ´ng pháº£i thÃ nh viÃªn Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh' });
  }
  db.prepare('UPDATE users SET role = ?, academicTitle = NULL WHERE email = ?').run('researcher', em);
  return res.json({ message: 'ÄÃ£ xÃ³a khá»i Tá»• tháº©m Ä‘á»‹nh tÃ i chÃ­nh. TÃ i khoáº£n chuyá»ƒn thÃ nh NghiÃªn cá»©u viÃªn.' });
});

// Admin: Ä‘áº·t máº­t kháº©u má»›i (â‰¥6 kÃ½ tá»±), hoáº·c Ä‘Æ°a vá» chÆ°a kÃ­ch hoáº¡t náº¿u Ä‘á»ƒ trá»‘ng (khÃ´ng cÃ²n sinh random máº·c Ä‘á»‹nh â€” trÃ¡nh nháº§m vá»›i â€œchÆ°a kÃ­ch hoáº¡tâ€)
app.put('/api/admin/users/:email/password', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  const newPassword = (req.body?.newPassword ?? '').toString().trim();
  const wantRandomTemp = !!(req.body && req.body.generateRandomTemp === true);

  if (!newPassword || newPassword.length < 6) {
    if (wantRandomTemp) {
      const temp = crypto.randomBytes(8).toString('hex');
      const hash = await bcrypt.hash(temp, 10);
      db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
      return res.json({
        message: 'ÄÃ£ cáº¥p máº­t kháº©u táº¡m ngáº«u nhiÃªn.',
        tempPassword: temp,
      });
    }
    if ((row.role || '').toLowerCase() === 'admin') {
      return res.status(400).json({ message: 'KhÃ´ng thá»ƒ Ä‘Æ°a tÃ i khoáº£n Admin vá» chÆ°a kÃ­ch hoáº¡t qua API nÃ y.' });
    }
    const selfEm = (req.user.email || '').toLowerCase();
    if (em === selfEm) {
      return res.status(400).json({ message: 'KhÃ´ng thá»ƒ Ä‘Æ°a chÃ­nh tÃ i khoáº£n Ä‘ang Ä‘Äƒng nháº­p vá» chÆ°a kÃ­ch hoáº¡t.' });
    }
    db.prepare('UPDATE users SET password = ? WHERE email = ?').run('', em);
    return res.json({
      message: 'ÄÃ£ Ä‘Æ°a tÃ i khoáº£n vá» chÆ°a kÃ­ch hoáº¡t. User vÃ o trang ÄÄƒng kÃ½ (@sci.edu.vn) Ä‘á»ƒ Ä‘áº·t máº­t kháº©u.',
      activated: false,
    });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
  return res.json({
    message: 'ÄÃ£ cáº¥p láº¡i máº­t kháº©u. Gá»­i máº­t kháº©u táº¡m cho thÃ nh viÃªn qua email náº¿u cáº§n.',
    tempPassword: newPassword,
  });
});

// Admin: khÃ³a / má»Ÿ khÃ³a Ä‘Äƒng nháº­p (ban nick)
app.put('/api/admin/users/:email/banned', authMiddleware, adminOnly, (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  const banned = !!(req.body && req.body.banned);
  if (!em) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) {
    return res.status(400).json({ message: 'KhÃ´ng thá»ƒ khÃ³a hoáº·c má»Ÿ khÃ³a tÃ i khoáº£n cá»§a chÃ­nh mÃ¬nh' });
  }
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  db.prepare('UPDATE users SET is_banned = ? WHERE email = ?').run(banned ? 1 : 0, em);
  return res.json({ message: banned ? 'ÄÃ£ khÃ³a tÃ i khoáº£n (khÃ´ng Ä‘Äƒng nháº­p Ä‘Æ°á»£c).' : 'ÄÃ£ má»Ÿ khÃ³a tÃ i khoáº£n.' });
});

// Admin: xÃ³a tÃ i khoáº£n thÃ nh viÃªn (chá»‰ khi khÃ´ng cÃ³ há»“ sÆ¡ Ä‘Ã£ ná»™p)
app.delete('/api/admin/users/:email', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) return res.status(400).json({ message: 'Báº¡n khÃ´ng thá»ƒ xÃ³a tÃ i khoáº£n cá»§a chÃ­nh mÃ¬nh' });
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  const hasCapVien = db.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  if (hasSubs || hasCapVien) {
    return res.status(400).json({ message: 'KhÃ´ng thá»ƒ xÃ³a: thÃ nh viÃªn nÃ y Ä‘Ã£ cÃ³ há»“ sÆ¡ ná»™p trong há»‡ thá»‘ng. CÃ³ thá»ƒ chuyá»ƒn vai trÃ² vá» NghiÃªn cá»©u viÃªn thay vÃ¬ xÃ³a.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  return res.json({ message: 'ÄÃ£ xÃ³a tÃ i khoáº£n.' });
});

// Master Admin: xÃ³a thÃ nh viÃªn Há»™i Ä‘á»“ng KHCN (chu_tich/thu_ky/thanh_vien)
app.delete('/api/admin/council-members/:email', authMiddleware, adminOnly, (req, res) => {
  if (!reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'Chá»‰ Master Admin má»›i Ä‘Æ°á»£c xÃ³a thÃ nh viÃªn Há»™i Ä‘á»“ng KHCN.' });
  }
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃ´ng há»£p lá»‡' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) return res.status(400).json({ message: 'Báº¡n khÃ´ng thá»ƒ tá»± xÃ³a tÃ i khoáº£n cá»§a chÃ­nh mÃ¬nh' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y tÃ i khoáº£n' });
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (!councilRoles.includes((row.role || '').toLowerCase())) {
    return res.status(400).json({ message: 'TÃ i khoáº£n nÃ y khÃ´ng pháº£i thÃ nh viÃªn Há»™i Ä‘á»“ng KHCN.' });
  }
  const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  const hasCapVien = db.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  if (hasSubs || hasCapVien) {
    return res.status(400).json({ message: 'KhÃ´ng thá»ƒ xÃ³a: thÃ nh viÃªn nÃ y Ä‘Ã£ cÃ³ há»“ sÆ¡ ná»™p trong há»‡ thá»‘ng.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  return res.json({ message: 'ÄÃ£ xÃ³a thÃ nh viÃªn Há»™i Ä‘á»“ng KHCN.' });
});

// Khá»Ÿi táº¡o Admin máº·c Ä‘á»‹nh (ADMIN_EMAIL) náº¿u chÆ°a cÃ³ â€” Ä‘á»“ng bá»™ Ä‘á»ƒ trÃ¡nh race khi Ä‘Äƒng nháº­p ngay sau khá»Ÿi Ä‘á»™ng
const adminExists = db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(ADMIN_EMAIL.toLowerCase());
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(
    ADMIN_EMAIL.toLowerCase(),
    hash,
    'Admin',
    'admin'
  );
  console.log('ÄÃ£ táº¡o tÃ i khoáº£n Admin máº·c Ä‘á»‹nh: ' + ADMIN_EMAIL + ' / máº­t kháº©u: admin123 (vui lÃ²ng Ä‘á»•i sau)');
}
// LuÃ´n Ä‘áº£m báº£o super-admin cÃ³ role admin (phÃ²ng trÆ°á»ng há»£p bá»‹ Ä‘á»•i role trong DB)
try {
  const r = db
    .prepare("UPDATE users SET role = 'admin' WHERE lower(trim(email)) = ? AND lower(trim(role)) != 'admin'")
    .run(ADMIN_EMAIL.toLowerCase());
  if (r.changes > 0) console.log('[Admin] ÄÃ£ khÃ´i phá»¥c vai trÃ² admin cho ' + ADMIN_EMAIL);
} catch (e) { /* ignore */ }
// Äá»“ng bá»™: sinhnguyen@sci.edu.vn = NCV (researcher), khÃ´ng admin; tÃªn hiá»ƒn thá»‹ Ä‘áº§y Ä‘á»§ Â«Nguyá»…n TrÆ°á»ng SinhÂ»
try {
  const r = db
    .prepare(
      `UPDATE users SET
         role = 'researcher',
         fullname = CASE
           WHEN lower(trim(coalesce(fullname, ''))) IN ('admin', 'administrator', 'quáº£n trá»‹', 'quan tri', 'sinh') THEN 'Nguyá»…n TrÆ°á»ng Sinh'
           WHEN trim(coalesce(fullname, '')) = '' THEN 'Nguyá»…n TrÆ°á»ng Sinh'
           ELSE fullname
         END
       WHERE lower(trim(email)) = ?`
    )
    .run('sinhnguyen@sci.edu.vn');
  if (r.changes > 0) {
    console.log('[Users] ÄÃ£ Ä‘á»“ng bá»™ sinhnguyen@sci.edu.vn â†’ researcher (tÃªn: Nguyá»…n TrÆ°á»ng Sinh).');
  }
} catch (e) {
  /* ignore */
}

// Backfill gd5 history cho há»“ sÆ¡ cÅ© Ä‘Ã£ cÃ³ meeting result
try {
  const subsWithMeeting = db.prepare('SELECT id, meetingDecisionAt, meetingDecisionById, status FROM submissions WHERE meetingDecisionAt IS NOT NULL').all();
  subsWithMeeting.forEach(s => {
    const hasHistory = db.prepare('SELECT 1 FROM submission_gd5_history WHERE submissionId = ?').get(s.id);
    if (!hasHistory) {
      const label = s.status === 'CONDITIONAL' ? 'Cháº¥p thuáº­n cÃ³ Ä‘iá»u kiá»‡n' : (s.status === 'APPROVED' ? 'Cháº¥p thuáº­n' : 'KhÃ´ng cháº¥p thuáº­n');
      const mf = db.prepare("SELECT originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(s.id);
      insertGd5History(s.id, 'meeting_result', s.meetingDecisionById, 'meeting_minutes', mf ? mf.originalName : null, label);
    }
  });
} catch (e) { /* ignore */ }

// CRD Lab Booking: náº¿u chÆ°a cÃ³ thÆ° má»¥c crd-lab-booking vá»›i index.html thÃ¬ tráº£ trang placeholder (trÃ¡nh "Cannot GET")
const crdLabBookingPath = path.join(__dirname, 'crd-lab-booking', 'index.html');
app.get('/crd-lab-booking', (req, res) => res.redirect(302, '/crd-lab-booking/'));
app.get('/crd-lab-booking/', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.type('html').send(
    '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>CRD Lab Booking</title></head><body style="font-family:Segoe UI;padding:40px;text-align:center;">' +
    '<h1>ðŸ¢ CRD Lab Booking</h1><p>á»¨ng dá»¥ng sáº½ hiá»ƒn thá»‹ táº¡i Ä‘Ã¢y khi báº¡n build dá»± Ã¡n React ra thÆ° má»¥c <code>crd-lab-booking/</code>.</p>' +
    '<p><a href="/crd-lab-booking.html">Trang thÃ´ng tin</a> Â· <a href="/index.html">Trang chá»§</a></p></body></html>'
  );
});
app.get('/crd-lab-booking/index.html', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.redirect(302, '/crd-lab-booking.html');
});

// Phá»¥c vá»¥ file tÄ©nh (HTML, CSS, v.v.) â€” sau táº¥t cáº£ route API
// Tráº£ 404 JSON cho API khÃ´ng tá»“n táº¡i (trÃ¡nh HTML "Cannot POST/GET")

// ============================================================
// Bá»” SUNG MODULE Há»¢P TÃC QUá»C Táº¾
// ============================================================
// ROUTE /api/me â€” ThÃ´ng tin user hiá»‡n táº¡i (HTML má»›i cáº§n route nÃ y)
// ============================================================
app.get('/api/me', authMiddleware, (req, res) => {
  try {
    const user = req.user || {};
    const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(user.id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const out = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
    out.isMasterAdmin = userEmailIsMasterAdmin(out.email);
    return res.json(out);
  } catch(e) {
    return res.json(req.user || {});
  }
});

// â”€â”€â”€ API Ä‘áº·t lá»‹ch thiáº¿t bá»‹ CRD (SQLite: crd_*) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function crdEnsurePersonForAppUser(reqUser) {
  const pid = 'u_app_' + reqUser.id;
  const existing = db.prepare('SELECT id, crd_access_revoked FROM crd_persons WHERE id = ?').get(pid);
  if (existing) {
    if (Number(existing.crd_access_revoked) === 1) return null;
    /* Há»“ sÆ¡ cÅ© cÃ³ thá»ƒ thiáº¿u user_id â€” Ä‘á»“ng bá»™ Ä‘á»ƒ API (email thÃ´ng bÃ¡o, v.v.) hoáº¡t Ä‘á»™ng */
    const uidRow = db.prepare('SELECT user_id FROM crd_persons WHERE id = ?').get(pid);
    if (uidRow && uidRow.user_id == null) {
      try {
        db.prepare('UPDATE crd_persons SET user_id = ? WHERE id = ?').run(reqUser.id, pid);
      } catch (_) { /* ignore náº¿u DB cÅ© khÃ´ng cÃ³ cá»™t */ }
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

// Äáº·t lá»‹ch CRD â€” pháº§n ngÆ°á»i dÃ¹ng thÆ°á»ng (9 endpoint) Ä‘Ã£ tÃ¡ch sang routes/crd/nguoiDung.js.
// Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨.
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

// Äáº·t lá»‹ch CRD â€” quáº£n trá»‹ snapshot, thÃ´ng bÃ¡o phÃ²ng lab, thiáº¿t bá»‹ (9 endpoint) Ä‘Ã£ tÃ¡ch sang
// routes/crd/quanTriThietBi.js. Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨: váº«n trÆ°á»›c nhÃ³m quáº£n trá»‹ há»“ sÆ¡ CRD bÃªn dÆ°á»›i.
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

// Äáº·t lá»‹ch CRD â€” quáº£n trá»‹ há»“ sÆ¡ CRD, tÃ i khoáº£n, vai trÃ², lá»‹ch (12 endpoint) Ä‘Ã£ tÃ¡ch sang
// routes/crd/quanTriNguoiDung.js. Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨.
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

/** PhÃ¢n tÃ­ch sá»­ dá»¥ng thiáº¿t bá»‹ CRD â€” routes/equipmentAnalytics.js (entry: server.js, khÃ´ng dÃ¹ng app.js) */
try {
  const createEquipmentAnalyticsRouter = require('./routes/equipmentAnalytics');
  app.use('/api/equipment-analytics', authMiddleware, adminOnly, createEquipmentAnalyticsRouter({ db }));
  console.log('[CRD] ÄÃ£ mount /api/equipment-analytics (admin)');
} catch (e) {
  console.warn('[CRD] KhÃ´ng mount equipment-analytics:', e.message);
}

/** Quáº£n trá»‹ thiáº¿t bá»‹ (há»“ sÆ¡, PDF, video, QR) â€” db/equipment_schema.sql */
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
  /* Ä‘Ã£ cÃ³ cá»™t */
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
      /* Ä‘Ã£ cÃ³ cá»™t */
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
        subject: opts.subject || 'ThÃ´ng bÃ¡o thiáº¿t bá»‹',
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
  console.log('[EQUIP] ÄÃ£ mount /api/equipment');
} catch (e) {
  console.warn('[EQUIP] KhÃ´ng mount equipment:', e.message);
}

/** NgÃ¢n hÃ ng Táº¿ bÃ o & KhÃ¡ng thá»ƒ â€” routes/nganHangTeBaoKhangThe.js (báº£ng nhm_*, chuyá»ƒn hÆ°á»›ng Ä‘á»‹a chá»‰ cÅ©, API) */
try {
  require('./routes/nganHangTeBaoKhangThe').mount(app, { db, authMiddleware, insertUserActivityLog, baseUrl: process.env.BASE_URL || '', nhacTuDong: true, mailSend: (o) => (transporter ? transporter.sendMail({ from: getSmtpFrom(), ...o }) : Promise.reject(new Error('mail_not_configured'))) });
  console.log('[NGAN-HANG] ÄÃ£ mount /api/ngan-hang-te-bao-khang-the');
} catch (e) {
  console.warn('[NGAN-HANG] KhÃ´ng mount ngan-hang-te-bao-khang-the:', e.message);
}

/** Quy trÃ¬nh ban hÃ nh vÄƒn báº£n hÃ nh chÃ­nh ná»™i bá»™ (9 bÆ°á»›c) */
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
        subject: opts.subject || 'ThÃ´ng bÃ¡o quy trÃ¬nh vÄƒn báº£n',
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
  // Alias tÆ°Æ¡ng thÃ­ch ngÆ°á»£c cho bundle React cÅ© (trÆ°á»›c khi Ä‘á»•i prefix /api/admin -> /api/docflow-admin).
  // Chá»‰ báº¯c cáº§u nhá»¯ng path KHÃ”NG Ä‘á»¥ng vá»›i cÃ¡c handler /api/admin/* cÃ³ sáºµn cá»§a server.js (Ä‘áº·c biá»‡t
  // KHÃ”NG Ä‘á»¥ng /api/admin/users â€” handler cÅ© tráº£ schema khÃ¡c, sáº½ bá»‹ phÃ¡ náº¿u alias).
  //
  // Middleware nÃ y rewrite req.url trÆ°á»›c khi cháº¡m internalWorkflowRouter, nÃªn pháº£i Ä‘á»©ng TRÆ¯á»šC
  // `app.use('/api', internalWorkflowRouter)` bÃªn dÆ°á»›i.
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
          '[DOCFLOW] Client gá»i /api/admin/* (bundle React cÅ©) â€” Ä‘Ã£ alias sang /api/docflow-admin/*.\n' +
            '          Triá»ƒn khai bundle má»›i: git pull + restart Node (server sáº½ auto rebuild dist).'
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
  console.log('[DOCFLOW] ÄÃ£ mount /api/documents, /api/attachments, /api/units, /api/dashboard/stats, /api/docflow-admin/*');
  console.log('[DOCFLOW] Alias sáºµn sÃ ng cho bundle cÅ©: /api/admin/{module|module-*|dashboard|units|audit-logs|email-notifications|document-types} -> /api/docflow-admin/*');
} catch (e) {
  console.warn('[DOCFLOW] KhÃ´ng mount internal documents workflow:', e.message);
}

/** Báº£ng dashboard_permissions (migrations/004_dashboard_permissions.sql) */
try {
  const dashPermSql = path.join(__dirname, 'migrations', '004_dashboard_permissions.sql');
  if (fs.existsSync(dashPermSql)) {
    db.exec(fs.readFileSync(dashPermSql, 'utf8'));
  }
} catch (e) {
  console.warn('[migrations/004_dashboard_permissions]', e.message);
}

/** Nháº­t kÃ½ truy cáº­p dashboard (migrations/005_dashboard_access_log.sql) */
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

/** CRUD quyá»n xem dashboard â€” routes/dashboardPermissions.js */
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
  console.log('[DASH] ÄÃ£ mount /api/dashboard-perms');
} catch (e) {
  console.warn('[DASH] KhÃ´ng mount dashboard-perms:', e.message);
}

/** Quáº£n lÃ½ tÃ i liá»‡u & há»“ sÆ¡ (hÃ nh chÃ­nh) â€” /api/dms */
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
  console.log('[DMS] ÄÃ£ mount /api/dms');
} catch (e) {
  console.warn('[DMS] KhÃ´ng mount /api/dms:', e.message);
}

/** Thá»‘ng kÃª cÃ´ng bá»‘ â€” theo chÃ­nh sÃ¡ch pub_analytics (whitelist / ná»™i bá»™ / STIMS / public) */
try {
  const createPublicationAnalyticsRouter = require('./routes/publicationAnalytics');
  const { createCheckPubAnalyticsAccess } = require('./middleware/pubAnalyticsAccess');
  const checkPubAnalytics = createCheckPubAnalyticsAccess(db, {
    isUserMasterAdmin: (u) => userEmailIsMasterAdmin(u && u.email),
  });
  app.use('/api/pub-analytics', optionalAuthMiddleware, checkPubAnalytics, createPublicationAnalyticsRouter({ db }));
  console.log('[PUB] ÄÃ£ mount /api/pub-analytics (chÃ­nh sÃ¡ch truy cáº­p dashboard)');
} catch (e) {
  console.warn('[PUB] KhÃ´ng mount pub-analytics:', e.message);
}

/** Dev (Master Admin): cáº¥u hÃ¬nh chÃ­nh sÃ¡ch truy cáº­p dashboard phÃ¢n tÃ­ch cÃ´ng bá»‘ */
app.get('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
  try {
    const { getPubAnalyticsSettings } = require('./middleware/pubAnalyticsAccess');
    const s = getPubAnalyticsSettings(db);
    return res.json({ ok: true, mode: s.mode, email_suffix: s.emailSuffix });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Lá»—i' });
  }
});

app.put('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
  try {
    const allowed = ['whitelist', 'internal_domain', 'stims_all', 'public'];
    const raw = req.body && req.body.mode != null ? String(req.body.mode).trim().toLowerCase() : '';
    if (!allowed.includes(raw)) {
      return res.status(400).json({ ok: false, error: 'mode khÃ´ng há»£p lá»‡' });
    }
    let suffix = req.body && req.body.email_suffix != null ? String(req.body.email_suffix).trim().toLowerCase() : '@sci.edu.vn';
    if (suffix && !suffix.startsWith('@')) suffix = '@' + suffix;
    if (suffix.length < 2 || suffix.length > 80) {
      return res.status(400).json({ ok: false, error: 'email_suffix khÃ´ng há»£p lá»‡' });
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
    return res.status(500).json({ ok: false, error: 'Lá»—i' });
  }
});

/** TÃ¬m user (autocomplete phÃ¢n quyá»n dashboard) â€” chá»‰ Admin */
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
    return res.status(500).json({ ok: false, success: false, error: 'Lá»—i' });
  }
});

// Äáº·t lá»‹ch CRD â€” kiá»ƒm duyá»‡t tin, email-notif, khiáº¿u náº¡i admin (5 endpoint) Ä‘Ã£ tÃ¡ch sang
// routes/crd/kiemDuyetThongBao.js. Mount ÄÃšNG Táº I Vá»Š TRÃ CÅ¨.
app.use('/api', require('./routes/crd/kiemDuyetThongBao')({
  authMiddleware,
  db,
  crdEnsurePersonForAppUser,
  CRD_BROADCAST_TO_ID,
  crdPersonHasModeratorSlot,
  adminOnly,
}));

// Bá»” SUNG MODULE Há»¢P TÃC QUá»C Táº¾ â€” CÃC ROUTE & TÃNH NÄ‚NG Má»šI
// CÃ¡c route CÅ¨ giá»¯ nguyÃªn phÃ­a trÃªn â€” file nÃ y CHá»ˆ THÃŠM route má»›i
// ============================================================

// --- Táº¡o báº£ng lá»‹ch sá»­ thao tÃ¡c (náº¿u chÆ°a cÃ³) ---
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

// --- ThÃªm cá»™t má»›i vÃ o cÃ¡c báº£ng hiá»‡n cÃ³ (migration an toÃ n) ---
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
// ThÃªm cá»™t cho htqt_de_xuat (Ä‘á»“ng bá»™ quy trÃ¬nh vá»›i ÄoÃ n ra / MOU: ghi chÃº, phÃª duyá»‡t, Word)
[['note_phong','TEXT'],['note_vt','TEXT'],['phong_xu_ly_id','INTEGER'],['phong_xu_ly_at','TEXT'],
 ['vt_xu_ly_id','INTEGER'],['vt_xu_ly_at','TEXT'],
 ['van_ban_word_path','TEXT'],['van_ban_word_original_name','TEXT'],['van_ban_word_uploaded_at','TEXT']].forEach(([col,type]) => {
  try { db.prepare(`ALTER TABLE htqt_de_xuat ADD COLUMN ${col} ${type}`).run(); } catch(e) {}
});

// --- Báº£ng Sá»± kiá»‡n Quá»‘c táº¿ (má»›i) ---
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

// --- Migrate status cÅ© sang má»›i (an toÃ n, khÃ´ng phÃ¡ dá»¯ liá»‡u) ---
try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_phong_duyet' WHERE status='cho_tham_dinh'").run(); } catch(e) {}
try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_vt_duyet' WHERE status='cho_ky_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE cooperation_mou_de_xuat SET status='cho_phong_duyet' WHERE status='dang_tham_dinh'").run(); } catch(e) {}
// ÄoÃ n ra: tráº¡ng thÃ¡i cÅ© cho_ky_duyet (nháº§m vá»›i VT) â†’ chá» PhÃ²ng KHCN tháº©m Ä‘á»‹nh trÆ°á»›c
try { db.prepare("UPDATE cooperation_doan_ra SET status='cho_phong_duyet' WHERE lower(trim(status))='cho_ky_duyet'").run(); } catch(e) {}
// YTNN: Ä‘á»“ng bá»™ tÃªn tráº¡ng thÃ¡i vá»›i ÄoÃ n ra / MOU (cho_phong_duyet â†’ cho_vt_duyet â†’ da_duyet / tu_choi)
try { db.prepare("UPDATE htqt_de_xuat SET status='cho_phong_duyet' WHERE status='cho_phan_loai'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='cho_vt_duyet' WHERE status='cho_vt_phe_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='da_duyet' WHERE status='da_phe_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='tu_choi' WHERE status='khong_phe_duyet'").run(); } catch(e) {}

// --- Táº¡o mÃ£ Ä‘á»‹nh danh cho Ä‘á» xuáº¥t chÆ°a cÃ³ mÃ£ ---
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
        const ma = `ÄX-${year}-${prefix}${String(r.id).padStart(4,'0')}`;
        db.prepare(`UPDATE ${table} SET ma_de_xuat=? WHERE id=?`).run(ma, r.id);
      });
    } catch(e) {}
  });
})();

// Cá»™t nháº¯c ná»™i bá»™ (khÃ´ng hiá»ƒn thá»‹ trÃªn giao diá»‡n ngÆ°á»i ná»™p Ä‘á» xuáº¥t)
['cooperation_doan_ra', 'cooperation_doan_vao', 'cooperation_mou_de_xuat', 'htqt_de_xuat'].forEach(tbl => {
  try { db.prepare(`ALTER TABLE ${tbl} ADD COLUMN coop_reminder_last_at TEXT`).run(); } catch (e) { /* Ä‘Ã£ cÃ³ */ }
});

// ============================================================
// HELPER FUNCTIONS Má»šI
// ============================================================

function coopGenMa(loai, id) {
  const year = new Date().getFullYear();
  const prefix = { doan_ra:'DR', doan_vao:'DV', mou:'MU', ytnn:'YT', su_kien:'SK' }[loai] || 'XX';
  return `ÄX-${year}-${prefix}${String(id).padStart(4,'0')}`;
}

function coopAddHistory(loai, de_xuat_id, buoc, action, action_label, user, note) {
  try {
    db.prepare(`
      INSERT INTO coop_history (loai, de_xuat_id, buoc, action, action_label, performed_by_id, performed_by_name, performed_by_role, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(loai, de_xuat_id, buoc, action, action_label || action,
      (user && user.id) || null,
      (user && (user.fullname || user.email)) || 'Há»‡ thá»‘ng',
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

/** TO = Viá»‡n trÆ°á»Ÿng (role trong cooperation_notification_recipients), CC = email nháº­n cÃ¹ng topic + user role phong_khcn. KhÃ´ng cÃ³ VT thÃ¬ láº¥y ngÆ°á»i Ä‘áº§u CC lÃ m TO. */
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
    .then(() => console.log('[Email HTQT] ÄÃ£ gá»­i:', subject))
    .catch(err => {
      console.error('[Email HTQT] Lá»—i:', err.message);
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

/** TrÆ°á»›c háº¡n: má»™t email trong khoáº£ng N thÃ¡ng cuá»‘i. Sau háº¡n: tá»‘i Ä‘a M email, cÃ¡ch nhau Ã­t nháº¥t D ngÃ y. */
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
    console.warn('[ThoaThuanExpiry] KhÃ´ng cÃ³ ngÆ°á»i nháº­n (topic thoa_thuan_het_han hoáº·c all). Cáº¥u hÃ¬nh táº¡i Quáº£n trá»‹ Há»£p tÃ¡c QT.');
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
    return { sent: 0, error: 'ÄÃ£ xáº£y ra lá»—i. Vui lÃ²ng thá»­ láº¡i sau.' };
  }

  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const link = baseUrl + '/module-hoatac-quocte.html';
  let sentPre = 0;
  let sentPost = 0;

  for (const row of rows || []) {
    const exp = coopParseYmdDate(row.het_han);
    if (!exp) continue;
    const expDay = coopDateAtMidnight(exp);

    // --- Sau ngÃ y háº¿t háº¡n (Ä‘Ã£ quÃ¡ háº¡n lá»‹ch, tráº¡ng thÃ¡i váº«n hiá»‡u lá»±c/sáº¯p háº¿t háº¡n) ---
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
      const subject = '[Há»£p tÃ¡c QT] Thá»a thuáº­n Ä‘Ã£ quÃ¡ háº¡n hiá»‡u lá»±c â€” nháº¯c ' + nextNum + '/' + postMax + ' â€” ' + String(row.ten || 'â€”').slice(0, 100);
      const html = coopBuildEmail(
        'Thá»a thuáº­n Ä‘Ã£ quÃ¡ ngÃ y háº¿t hiá»‡u lá»±c',
        `NgÃ y háº¿t hiá»‡u lá»±c Ä‘Ã£ qua; tráº¡ng thÃ¡i trÃªn há»‡ thá»‘ng váº«n lÃ  <strong>Hiá»‡u lá»±c / Sáº¯p háº¿t háº¡n</strong>. ÄÃ¢y lÃ  email nháº¯c <strong>sau háº¿t háº¡n</strong> láº§n <strong>${nextNum}</strong> trong tá»‘i Ä‘a <strong>${postMax}</strong> láº§n (cÃ¡ch nhau Ã­t nháº¥t <strong>${postMinDays}</strong> ngÃ y). Vui lÃ²ng gia háº¡n, kÃ½ láº¡i hoáº·c Ä‘á»•i tráº¡ng thÃ¡i thÃ nh <strong>Háº¿t háº¡n</strong>.`,
        [
          ['TÃªn thá»a thuáº­n', row.ten],
          ['Äá»‘i tÃ¡c', row.doi_tac],
          ['Loáº¡i', row.loai],
          ['Quá»‘c gia', row.quoc_gia || 'â€”'],
          ['NgÃ y háº¿t hiá»‡u lá»±c (Ä‘Ã£ qua)', coopFmtDateVN(row.het_han)],
          ['Tráº¡ng thÃ¡i hiá»‡n táº¡i', row.trang_thai || 'â€”'],
          ['Láº§n nháº¯c sau háº¿t háº¡n', nextNum + ' / ' + postMax]
        ],
        'TrÃ¢n trá»ng,<br/>Há»‡ thá»‘ng tá»± Ä‘á»™ng â€” Há»£p tÃ¡c Quá»‘c táº¿',
        link
      );
      const text = `Thá»a thuáº­n Ä‘Ã£ quÃ¡ háº¡n (nháº¯c ${nextNum}/${postMax})\n${row.ten}\nHáº¿t háº¡n: ${coopFmtDateVN(row.het_han)}\n${link}`;

      try {
        await coopSendMail({ to, cc: cc.length ? cc : undefined, subject, html, text });
        db.prepare(`UPDATE cooperation_thoa_thuan SET post_expiry_alert_count=?, last_post_expiry_alert_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(nextNum, row.id);
        sentPost++;
      } catch (e) {
        console.error('[ThoaThuanExpiry] Gá»­i sau háº¡n lá»—i id=', row.id, e.message);
      }
      continue;
    }

    // --- TrÆ°á»›c / trong khoáº£ng N thÃ¡ng cuá»‘i (chÆ°a quÃ¡ ngÃ y háº¿t háº¡n) ---
    if (row.expiry_alert_sent_at) continue;
    const thr = coopAddCalendarMonths(expDay, -months);
    if (t0 < coopDateAtMidnight(thr) || t0 > expDay) continue;

    const subject = '[Há»£p tÃ¡c QT] Cáº£nh bÃ¡o: Thá»a thuáº­n sáº¯p Ä‘áº¿n háº¡n hiá»‡u lá»±c â€” ' + String(row.ten || 'â€”').slice(0, 120);
    const html = coopBuildEmail(
      'Thá»a thuáº­n trong khoáº£ng cáº£nh bÃ¡o háº¿t háº¡n',
      `Thá»a thuáº­n sau Ä‘Ã¢y Ä‘ang trong khoáº£ng <strong>${months} thÃ¡ng</strong> cuá»‘i trÆ°á»›c ngÃ y háº¿t hiá»‡u lá»±c (theo cáº¥u hÃ¬nh Quáº£n trá»‹ Há»£p tÃ¡c quá»‘c táº¿). Vui lÃ²ng xem xÃ©t gia háº¡n hoáº·c cáº­p nháº­t tráº¡ng thÃ¡i trÃªn há»‡ thá»‘ng.`,
      [
        ['TÃªn thá»a thuáº­n', row.ten],
        ['Äá»‘i tÃ¡c', row.doi_tac],
        ['Loáº¡i', row.loai],
        ['Quá»‘c gia', row.quoc_gia || 'â€”'],
        ['NgÃ y háº¿t hiá»‡u lá»±c', coopFmtDateVN(row.het_han)],
        ['Tráº¡ng thÃ¡i', row.trang_thai || 'â€”']
      ],
      'TrÃ¢n trá»ng,<br/>Há»‡ thá»‘ng tá»± Ä‘á»™ng â€” Há»£p tÃ¡c Quá»‘c táº¿',
      link
    );
    const text = `Cáº£nh bÃ¡o thá»a thuáº­n sáº¯p háº¿t hiá»‡u lá»±c\n${row.ten}\nÄá»‘i tÃ¡c: ${row.doi_tac}\nHáº¿t háº¡n: ${coopFmtDateVN(row.het_han)}\n${link}`;

    try {
      await coopSendMail({ to, cc: cc.length ? cc : undefined, subject, html, text });
      db.prepare(`UPDATE cooperation_thoa_thuan SET expiry_alert_sent_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(row.id);
      sentPre++;
    } catch (e) {
      console.error('[ThoaThuanExpiry] Gá»­i lá»—i id=', row.id, e.message);
    }
  }
  const sent = sentPre + sentPost;
  if (sent) console.log('[ThoaThuanExpiry] ÄÃ£ gá»­i', sent, 'email (trÆ°á»›c háº¡n:', sentPre, ', sau háº¡n:', sentPost, ').');
  return { sent, sent_pre: sentPre, sent_post: sentPost, checked: (rows || []).length };
}

function coopBuildEmail(title, intro, rows, footer, link) {
  const rowsHtml = rows.map(([k,v]) =>
    `<tr><td style="font-weight:600;width:38%;background:#f8fafc;padding:8px 12px;border:1px solid #e2e8f0">${k}</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${(v||'â€”').toString().replace(/\n/g,'<br>')}</td></tr>`
  ).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:660px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1e40af,#1a6fb5);padding:20px 28px">
      <div style="color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">Viá»‡n Táº¿ bÃ o gá»‘c â€” SCI</div>
      <h1 style="color:#fff;margin:0;font-size:17px;font-weight:700">${title}</h1>
    </div>
    <div style="padding:20px 28px">
      <p style="color:#374151;margin-bottom:14px">${intro}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${rowsHtml}</table>
      ${link ? `<p><a href="${link}" style="display:inline-block;background:#1e40af;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:600">Xem chi tiáº¿t &amp; xá»­ lÃ½ â†’</a></p>` : ''}
      <p style="color:#6b7280;font-size:13px;margin-top:16px;border-top:1px solid #e5e7eb;padding-top:14px">${footer || 'TrÃ¢n trá»ng,<br/>Há»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c'}</p>
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
  console.log('[HNHT] ÄÃ£ mount /api/conference-registrations');
} catch (e) {
  console.warn('[HNHT] KhÃ´ng mount conference-registrations:', e.message);
}

function coopFmtDate(s) {
  if (!s) return 'â€”';
  const d = String(s).slice(0,10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
}

const STATUS_LABELS_COOP = {
  cho_phong_duyet:  'Chá» PhÃ²ng KHCN tháº©m Ä‘á»‹nh',
  cho_phan_loai:    'Chá» PhÃ²ng KHCN phÃ¢n loáº¡i',
  yeu_cau_bo_sung:  'YÃªu cáº§u bá»• sung há»“ sÆ¡',
  cho_vt_duyet:     'Chá» Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t',
  cho_vt_phe_duyet: 'Chá» Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t',
  da_duyet:         'ÄÃ£ phÃª duyá»‡t',
  da_phe_duyet:     'ÄÃ£ phÃª duyá»‡t',
  tu_choi:          'KhÃ´ng phÃª duyá»‡t',
  khong_phe_duyet:  'KhÃ´ng phÃª duyá»‡t',
  hoan_thanh:       'HoÃ n thÃ nh',
  ket_thuc_boi_nguoi_nop: 'ÄÃ£ káº¿t thÃºc (ngÆ°á»i gá»­i khÃ´ng ná»™p láº¡i)',
  // legacy
  dang_tham_dinh:   'Chá» PhÃ²ng KHCN tháº©m Ä‘á»‹nh',
  cho_ky_duyet:     'Chá» Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t',
  cho_tham_dinh:    'Chá» PhÃ²ng KHCN tháº©m Ä‘á»‹nh',
};

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
  if (!s) return 'â€”';
  const d = String(s).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(s).slice(0, 10);
}

function coopDaysLabelDoanRa(ngayDi, ngayVe) {
  try {
    const a = new Date(String(ngayDi).slice(0, 10));
    const b = new Date(String(ngayVe).slice(0, 10));
    const n = Math.round((b - a) / 86400000) + 1;
    if (isNaN(n) || n < 1) return 'â€”';
    return `${n} ngÃ y`;
  } catch (e) {
    return 'â€”';
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
      const dash = line.match(/^(.+?)\s*[â€“â€”-]\s*(.+)$/);
      if (dash) {
        ho_ten = dash[1].trim();
        chuc_vu = dash[2].trim();
      }
    }
    const ho = ho_ten || line;
    const cv = chuc_vu || 'ThÃ nh viÃªn';
    out.push({
      stt,
      ho_ten: ho,
      chuc_vu: cv,
      hoTen: ho,
      chucVu: cv,
      ho_ten_chuc_vu: cv ? `${ho} â€” ${cv}` : ho
    });
  }
  if (!out.length) out.push({ stt: '1', ho_ten: 'â€”', chuc_vu: 'â€”', hoTen: 'â€”', chucVu: 'â€”', ho_ten_chuc_vu: 'â€”' });
  return out;
}

/** KhÃ´ng Ä‘iá»n chá»¯ kÃ½ khi tÃªn chá»‰ lÃ  tÃ i khoáº£n test (trÃ¡nh â€œAdminâ€ in trÃªn máº«u). */
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || 'â€”';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'â€”' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  let duToanStr = 'â€”';
  if (row.du_toan != null && String(row.du_toan).trim() !== '') {
    const s = String(row.du_toan).trim();
    duToanStr = /(usd|vnd|vnÄ‘|Ä‘á»“ng|\bÄ‘\b)/i.test(s) ? s : `${s} VND`;
  }
  const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'â€”';
  const ma = row.ma_de_xuat || coopGenMa('doan_ra', row.id);
  const tieuDeToTrinh = (row.muc_dich || '').trim() || 'Tá» trÃ¬nh v/v Ä‘oÃ n cÃ´ng tÃ¡c nÆ°á»›c ngoÃ i';
  const tpHcmNgay = 'TP. Há»“ ChÃ­ Minh, ngÃ y ' + ngayPheDuyet;
  const thanhVienList = coopParseThanhVienDoanRa(row.thanh_vien);
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    quoc_gia: row.quoc_gia || 'â€”',
    muc_dich: row.muc_dich || 'â€”',
    ngay_di: coopFmtDateVN(row.ngay_di),
    ngay_ve: coopFmtDateVN(row.ngay_ve),
    tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_di, row.ngay_ve),
    nguon_kinh_phi: row.nguon_kinh_phi || 'â€”',
    du_toan: duToanStr,
    du_toan_vnd: duToanStr,
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ÄÃƒ PHÃŠ DUYá»†T' : (STATUS_LABELS_COOP[row.status] || row.status || 'â€”'),
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
    nguoi_nhan_to_trinh: 'Viá»‡n trÆ°á»Ÿng Viá»‡n Táº¿ bÃ o gá»‘c',
    can_cu_trinh_bay: 'Theo quy Ä‘á»‹nh cá»§a Viá»‡n vÃ  Quy cháº¿ quáº£n lÃ½ KHCN-ÄMST, tÃ´i Ä‘á» nghá»‹ Viá»‡n trÆ°á»Ÿng xem xÃ©t vÃ  phÃª duyá»‡t Ä‘á» xuáº¥t nhÆ° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    so_ngay: core.tong_thoi_gian,
    du_toan_usd: duToanStr,
    danh_sach_thanh_vien: (row.thanh_vien || '').trim() ? String(row.thanh_vien).trim() : 'â€”',
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'â€”'
  });
}

const CAN_CU_DOAN_RA_DAY_DU = 'Theo quy Ä‘á»‹nh cá»§a Viá»‡n vÃ  Quy cháº¿ quáº£n lÃ½ KHCN-ÄMST, tÃ´i Ä‘á» nghá»‹ Viá»‡n trÆ°á»Ÿng xem xÃ©t vÃ  phÃª duyá»‡t Ä‘á» xuáº¥t nhÆ° sau:';

/**
 * Má»™t sá»‘ máº«u .docx váº«n gÃµ sáºµn chá»¯ (khÃ´ng chá»‰ placeholder) â€” docxtemplater khÃ´ng ghi Ä‘Ã¨.
 * Háº­u xá»­ lÃ½ XML trong file Ä‘Ã£ merge Ä‘á»ƒ Ä‘á»“ng bá»™ lá»i kÃ­nh gá»­i, cÄƒn cá»©, vÃ  bá» chá»¯ kÃ½ "Admin" test.
 */
function coopPostProcessDoanRaDocxBuffer(buf) {
  try {
    const zip = new PizZip(buf);
    const rePath = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;
    for (const p of Object.keys(zip.files)) {
      if (!rePath.test(p) || zip.files[p].dir) continue;
      let xml = zip.file(p).asText();
      if (!xml) continue;
      xml = xml.replace(/Ban GiÃ¡m hiá»‡u\s*\/\s*/g, '');
      xml = xml.replace(
        /<w:t([^>]*)>(Theo quy Ä‘á»‹nh cá»§a Viá»‡n vÃ  Quy cháº¿ quáº£n lÃ½ KHCN-ÄMST\.)<\/w:t>/g,
        (m, attrs) => {
          if (m.includes('tÃ´i Ä‘á» nghá»‹')) return m;
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
    throw new Error('ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh (menu trong chi tiáº¿t ÄoÃ n ra).');
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
 * Sinh file Word tá»« máº«u Tá» trÃ¬nh ÄoÃ n ra (má»™t file .docx chung cho loáº¡i Ä‘á» xuáº¥t nÃ y) vÃ  ghi vÃ o van_ban_word_*.
 * DÃ¹ng sau khi phÃª duyá»‡t Ä‘á»ƒ ngÆ°á»i gá»­i khÃ´ng pháº£i chá» Admin.
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
    return { ok: false, skipped: 'error', message: 'ÄÃ£ xáº£y ra lá»—i. Vui lÃ²ng thá»­ láº¡i sau.' };
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || 'â€”';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'â€”' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const kinhPhiStr = (row.kinh_phi_nguon != null && String(row.kinh_phi_nguon).trim()) ? String(row.kinh_phi_nguon).trim() : 'â€”';
  const ma = row.ma_de_xuat || coopGenMa('doan_vao', row.id);
  const tieuDeToTrinh = (row.muc_dich || '').trim() || 'Tá» trÃ¬nh v/v tiáº¿p nháº­n Ä‘oÃ n khÃ¡ch quá»‘c táº¿';
  const tpHcmNgay = 'TP. Há»“ ChÃ­ Minh, ngÃ y ' + ngayPheDuyet;
  const noiParts = [row.noi_dung_lam_viec, row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'â€”';
  const thanhVienParsed = coopParseThanhVienDoanRa(row.thanh_phan_doan);
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    quoc_gia: row.don_vi_de_xuat || 'â€”',
    don_vi_de_xuat: row.don_vi_de_xuat || 'â€”',
    muc_dich: row.muc_dich || 'â€”',
    ngay_den: coopFmtDateVN(row.ngay_den),
    ngay_roi_di: coopFmtDateVN(row.ngay_roi_di),
    ngay_di: coopFmtDateVN(row.ngay_den),
    ngay_ve: coopFmtDateVN(row.ngay_roi_di),
    tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_den, row.ngay_roi_di),
    nguon_kinh_phi: kinhPhiStr,
    du_toan: kinhPhiStr,
    du_toan_vnd: kinhPhiStr,
    ho_tro_visa: row.ho_tro_visa || 'â€”',
    noi_dung_lam_viec: row.noi_dung_lam_viec || 'â€”',
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ÄÃƒ PHÃŠ DUYá»†T' : (STATUS_LABELS_COOP[row.status] || row.status || 'â€”'),
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
    nguoi_nhan_to_trinh: 'Viá»‡n trÆ°á»Ÿng Viá»‡n Táº¿ bÃ o gá»‘c',
    can_cu_trinh_bay: 'Theo quy Ä‘á»‹nh cá»§a Viá»‡n vÃ  Quy cháº¿ quáº£n lÃ½ KHCN-ÄMST, tÃ´i Ä‘á» nghá»‹ Viá»‡n trÆ°á»Ÿng xem xÃ©t vÃ  phÃª duyá»‡t Ä‘á» xuáº¥t tiáº¿p nháº­n Ä‘oÃ n khÃ¡ch/quá»‘c táº¿ nhÆ° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    so_ngay: core.tong_thoi_gian,
    du_toan_usd: kinhPhiStr,
    danh_sach_thanh_vien: (row.thanh_phan_doan || '').trim() ? String(row.thanh_phan_doan).trim() : 'â€”',
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'â€”'
  });
}

function coopMergeDoanVaoDocx(row) {
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh ÄoÃ n vÃ o (menu trong chi tiáº¿t Ä‘á» xuáº¥t).');
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
    return { ok: false, skipped: 'error', message: 'ÄÃ£ xáº£y ra lá»—i. Vui lÃ²ng thá»­ láº¡i sau.' };
  }
}

/** Báº£n merge tá»± sinh cÃ³ Ä‘Æ°á»ng dáº«n chá»©a `_to_trinh_`. File admin táº£i tay thay tháº¿ khÃ´ng cÃ³ â€” khÃ´ng tá»± ghÃ©p Ä‘Ã¨. */
function coopVanBanIsAutoMergedOutput(relPath) {
  return !!(relPath && String(relPath).includes('_to_trinh_'));
}

/**
 * Äá» xuáº¥t Ä‘Ã£ phÃª duyá»‡t: sinh láº§n Ä‘áº§u náº¿u chÆ°a cÃ³ file.
 * Náº¿u Ä‘Ã£ cÃ³ báº£n tá»± sinh vÃ  máº«u `to-trinh-template.docx` má»›i hÆ¡n file merge â†’ ghÃ©p láº¡i (Ä‘á»•i máº«u [1] khÃ´ng cáº§n báº¥m Sinh láº¡i thá»§ cÃ´ng).
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || 'â€”';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'â€”' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const ma = row.ma_de_xuat || coopGenMa('mou', row.id);
  const loaiTT = (row.loai_thoa_thuan || '').trim();
  const tenDt = (row.ten_doi_tac || '').trim();
  const tieuDeToTrinh = [loaiTT, tenDt].filter(Boolean).join(' â€” ') || 'Tá» trÃ¬nh v/v Ä‘á» xuáº¥t Thá»a thuáº­n há»£p tÃ¡c';
  const tpHcmNgay = 'TP. Há»“ ChÃ­ Minh, ngÃ y ' + ngayPheDuyet;
  const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'â€”';
  const thoiHanStr = (row.thoi_han_nam != null && String(row.thoi_han_nam).trim() !== '') ? String(row.thoi_han_nam).trim() : 'â€”';
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    loai_thoa_thuan: row.loai_thoa_thuan || 'â€”',
    ten_doi_tac: row.ten_doi_tac || 'â€”',
    quoc_gia: row.quoc_gia || 'â€”',
    thoi_han_nam: thoiHanStr,
    gia_tri_tai_chinh: row.gia_tri_tai_chinh || 'â€”',
    don_vi_de_xuat: row.don_vi_de_xuat || 'â€”',
    noi_dung_hop_tac: row.noi_dung_hop_tac || 'â€”',
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ÄÃƒ PHÃŠ DUYá»†T' : (STATUS_LABELS_COOP[row.status] || row.status || 'â€”'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay
  };
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    nguoi_nhan_to_trinh: 'Viá»‡n trÆ°á»Ÿng Viá»‡n Táº¿ bÃ o gá»‘c',
    can_cu_trinh_bay: 'Theo quy Ä‘á»‹nh cá»§a Viá»‡n vÃ  Quy cháº¿ quáº£n lÃ½ KHCN-ÄMST, tÃ´i Ä‘á» nghá»‹ Viá»‡n trÆ°á»Ÿng xem xÃ©t vÃ  phÃª duyá»‡t Ä‘á» xuáº¥t kÃ½ káº¿t thá»a thuáº­n há»£p tÃ¡c nhÆ° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'â€”'
  });
}

function coopMergeMouDocx(row) {
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh Thá»a thuáº­n/MOU (menu trong chi tiáº¿t Ä‘á» xuáº¥t).');
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
    return { ok: false, skipped: 'error', message: 'ÄÃ£ xáº£y ra lá»—i. Vui lÃ²ng thá»­ láº¡i sau.' };
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || nguoiPheDuyetRaw || 'â€”';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'â€”' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const ma = row.ma_de_xuat || coopGenMa('ytnn', row.id);
  const tenDeTai = (row.ten || '').trim();
  const tenDt = (row.doi_tac_ten || '').trim();
  // Máº«u thÆ°á»ng gÃµ "V/v {tieu_de_to_trinh}" â€” khÃ´ng láº·p chá»¯ "Tá» trÃ¬nh v/v" trong giÃ¡ trá»‹
  const tieuDeToTrinh = tenDeTai
    ? ('Ä‘á» xuáº¥t Ä‘á» tÃ i YTNN â€” ' + tenDeTai)
    : 'Ä‘á» xuáº¥t Ä‘á» tÃ i cÃ³ yáº¿u tá»‘ nÆ°á»›c ngoÃ i';
  const tpHcmNgay = 'TP. Há»“ ChÃ­ Minh, ngÃ y ' + ngayPheDuyet;
  const noiParts = [row.mo_ta, row.ghi_chu_noi_bo, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'â€”';
  const moTaGoc = (row.mo_ta && String(row.mo_ta).trim()) ? String(row.mo_ta).trim() : '';
  const moTaMotDong = moTaGoc ? moTaGoc.replace(/\s+/g, ' ') : 'â€”';
  const donViTien = ((row.don_vi_tien_te != null && String(row.don_vi_tien_te).trim()) ? String(row.don_vi_tien_te).trim() : 'VNÄ');
  let kinhPhiSo = 'â€”';
  if (row.kinh_phi != null && String(row.kinh_phi).trim() !== '') {
    const n = Number(row.kinh_phi);
    kinhPhiSo = Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : String(row.kinh_phi).trim();
  }
  let kinhPhiStr = 'â€”';
  if (kinhPhiSo !== 'â€”') kinhPhiStr = `${kinhPhiSo} ${donViTien}`;
  const qgDt = row.doi_tac_quoc_gia || 'â€”';
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    ten_de_tai: tenDeTai || 'â€”',
    ten_doi_tac: tenDt || 'â€”',
    ten_to_chuc_doi_tac: tenDt || 'â€”',
    quoc_gia: qgDt,
    quoc_gia_doi_tac: qgDt,
    nguoi_dai_dien_doi_tac: (row.doi_tac_nguoi_dai_dien && String(row.doi_tac_nguoi_dai_dien).trim()) ? String(row.doi_tac_nguoi_dai_dien).trim() : 'â€”',
    website_doi_tac: (row.doi_tac_website && String(row.doi_tac_website).trim()) ? String(row.doi_tac_website).trim() : 'â€”',
    loai_hinh: row.loai_hinh || 'â€”',
    hinh_thuc_hop_tac: row.hinh_thuc_hop_tac || 'â€”',
    chu_nhiem: row.chu_nhiem_ten || 'â€”',
    chu_nhiem_de_tai: row.chu_nhiem_ten || 'â€”',
    chu_nhiem_hoc_vi: row.chu_nhiem_hoc_vi || 'â€”',
    hoc_ham_hoc_vi: row.chu_nhiem_hoc_vi || 'â€”',
    chu_nhiem_don_vi: row.chu_nhiem_don_vi || 'â€”',
    don_vi_chu_nhiem: row.chu_nhiem_don_vi || 'â€”',
    kinh_phi: kinhPhiSo,
    don_vi_tien_te: donViTien,
    ngay_bat_dau: coopFmtDateVN(row.ngay_bat_dau),
    ngay_ket_thuc: coopFmtDateVN(row.ngay_ket_thuc),
    thoi_gian_thang: row.thoi_gian_thang != null && String(row.thoi_gian_thang).trim() !== '' ? String(row.thoi_gian_thang).trim() : 'â€”',
    mo_ta: moTaMotDong,
    mo_ta_de_tai: moTaGoc || 'â€”',
    noi_dung_hop_tac: moTaGoc || 'â€”',
    gia_tri_tai_chinh: kinhPhiStr,
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ÄÃƒ PHÃŠ DUYá»†T' : (STATUS_LABELS_COOP[row.status] || row.status || 'â€”'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay
  };
  const tenVtHienThi = nguoiPheDuyetKy || nguoiPheDuyetRaw || 'â€”';
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    loai_thoa_thuan: core.loai_hinh,
    thoi_han_nam: core.thoi_gian_thang,
    don_vi_de_xuat: core.chu_nhiem_don_vi,
    nguoi_nhan_to_trinh: 'Viá»‡n trÆ°á»Ÿng Viá»‡n Táº¿ bÃ o gá»‘c',
    can_cu_trinh_bay: 'Theo quy Ä‘á»‹nh cá»§a Viá»‡n vÃ  Quy cháº¿ quáº£n lÃ½ KHCN-ÄMST, tÃ´i Ä‘á» nghá»‹ Viá»‡n trÆ°á»Ÿng xem xÃ©t vÃ  phÃª duyá»‡t Ä‘á» xuáº¥t tiáº¿p nháº­n Ä‘á» tÃ i cÃ³ yáº¿u tá»‘ nÆ°á»›c ngoÃ i nhÆ° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: tenVtHienThi,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'â€”'
  });
}

function coopMergeYtnnDocx(row) {
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh Äá» tÃ i YTNN (menu trong chi tiáº¿t Ä‘á» xuáº¥t).');
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
    return { ok: false, skipped: 'error', message: 'ÄÃ£ xáº£y ra lá»—i. Vui lÃ²ng thá»­ láº¡i sau.' };
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

// Middleware phÃ¢n quyá»n má»›i
function coopPhongOrAdmin(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) return next();
  return res.status(403).json({ message: 'Chá»‰ PhÃ²ng KHCN hoáº·c Admin má»›i cÃ³ quyá»n nÃ y.' });
}
function coopVTOrAdmin(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  if (coopIsVienTruong(email)) return next();
  return res.status(403).json({ message: 'Chá»‰ Viá»‡n trÆ°á»Ÿng hoáº·c Admin má»›i cÃ³ quyá»n nÃ y.' });
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

/** Chá»‰ Quáº£n trá»‹ viá»‡n, PhÃ²ng KHCN, Viá»‡n trÆ°á»Ÿng â€” Dashboard tá»•ng thá»ƒ khÃ´ng dÃ nh cho user thÆ°á»ng */
function coopDashboardViewer(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  if (role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email)) return next();
  return res.status(403).json({ message: 'Chá»‰ Quáº£n trá»‹ viá»‡n, PhÃ²ng KHCN hoáº·c Viá»‡n trÆ°á»Ÿng má»›i xem Ä‘Æ°á»£c Dashboard.' });
}

// Badge sidebar â€” má»i user Ä‘Äƒng nháº­p (khÃ´ng lá»™ thá»‘ng kÃª há»‡ thá»‘ng)
app.get('/api/cooperation/sidebar-badges', authMiddleware, (req, res) => {
  try {
    const role = (req.user.role || '').toLowerCase();
    const email = (req.user.email || '').trim().toLowerCase();
    const isManager = role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email);

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
    if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) {
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
    if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) {
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
      su_kien_tong: safeCount("SELECT COUNT(*) AS c FROM cooperation_su_kien"),
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
      su_kien_tong: 0,
      hnht_cho_phong: 0,
      hnht_sap_dien_ra: 0,
      hnht_minh_chung_qua_han: 0,
      doi_tac_tong: 0,
      thoa_thuan_tong: 0,
    });
  }
});

// ============================================================
// ROUTE Má»šI â€” DASHBOARD STATS (giÃ¡m sÃ¡t toÃ n há»‡ thá»‘ng â€” chá»‰ lÃ£nh Ä‘áº¡o / P.KHCN)
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
      is_phong_khcn: role === 'admin' || roleIsAny(req, ['phong_khcn']),
      is_vien_truong: role === 'admin' || coopIsVienTruong(email),
      is_admin: role === 'admin',
    });
  } catch (e) {
    return res.status(500).json({ message: 'KhÃ´ng táº£i Ä‘Æ°á»£c Dashboard.' });
  }
});

// HTQT dashboard (EJS) â€” /ytnn/dashboard, /ytnn/api/dashboard/*
try {
  const createYtnnRouter = require('./routes/ytnn');
  app.use('/ytnn', authMiddleware, createYtnnRouter({ db, coopDashboardViewer }));
} catch (e) {
  console.warn('[ytnn] KhÃ´ng mount router /ytnn:', e.message);
}
app.use('/api/bao-cao-phong', authMiddleware, require('./routes/baoCaoPhong')({ db, uploadsRoot: appPaths.uploadsRoot(), baseUrl: process.env.BASE_URL || '', nhacTuDong: true, mailSend: (o) => (transporter ? transporter.sendMail({ from: getSmtpFrom(), ...o }) : Promise.reject(new Error('mail_not_configured'))) })); // BÃ¡o cÃ¡o phÃ²ng ban: xem routes/baoCaoPhong.js
app.use('/api/mysign', authMiddleware, require('./routes/mysign')({ db, uploadsRoot: appPaths.uploadsRoot() })); // KÃ½ sá»‘ MySign dÃ¹ng chung: xem services/mysign/

// ============================================================
// ROUTE Má»šI â€” CHá»œ PHÃ’NG KHCN Xá»¬ LÃ
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
            submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'â€”',
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
          title: 'ÄÄƒng kÃ½ HN/HT â€” ' + (r.conf_name || 'â€”'),
          status: r.status,
          status_label:
            r.status === 'khcn_reviewing' ? 'PhÃ²ng Ä‘ang xem xÃ©t' : 'Chá» PhÃ²ng KHCN',
          submitted_by_name: r.uname || r.uemail || 'â€”',
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
// ROUTE Má»šI â€” CHá»œ VIá»†N TRÆ¯á»žNG DUYá»†T
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
            submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'â€”',
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
          title: 'ÄÄƒng kÃ½ HN/HT â€” ' + (r.conf_name || 'â€”'),
          status: r.status,
          status_label: r.status === 'director_reviewing' ? 'Viá»‡n trÆ°á»Ÿng Ä‘ang xem xÃ©t' : 'Chá» Viá»‡n trÆ°á»Ÿng',
          submitted_by_name: r.uname || r.uemail || 'â€”',
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
// ROUTE Má»šI â€” Táº¤T Cáº¢ Äá»€ XUáº¤T (manager)
// ============================================================
app.get('/api/cooperation/tat-ca-de-xuat', authMiddleware, (req, res) => {
  if (!coopIsManager(req)) return res.status(403).json({ message: 'KhÃ´ng cÃ³ quyá»n.' });
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
      // `status` nháº­n 1 giÃ¡ trá»‹ hoáº·c danh sÃ¡ch ngÄƒn báº±ng dáº¥u pháº©y â€” cÃ¡c Ã´ trÃªn
      // Dashboard gá»™p nhiá»u tráº¡ng thÃ¡i (vd "Äang xá»­ lÃ½") nÃªn cáº§n lá»c theo nhÃ³m.
      const statusList = String(status || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (statusList.length) {
        sql += ` WHERE status IN (${statusList.map(() => '?').join(',')})`;
        params.push(...statusList);
      }
      sql += ' ORDER BY created_at DESC';
      db.prepare(sql).all(...params).forEach(r => list.push({
        loai: loai_key, id: r.id, ma_de_xuat: r.ma_de_xuat || coopGenMa(loai_key, r.id),
        title: coopBuildTitle(loai_key, r), status: r.status,
        status_label: STATUS_LABELS_COOP[r.status] || r.status,
        submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'â€”',
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
          title: 'ÄÄƒng kÃ½ HN/HT â€” ' + (r.conf_name || 'â€”'),
          status: r.status,
          status_label: r.status,
          submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'â€”',
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
// ROUTE Má»šI â€” CHI TIáº¾T + Lá»ŠCH Sá»¬
// ============================================================
app.get('/api/cooperation/chi-tiet/:loai/:id', authMiddleware, (req, res) => {
  const loai = req.params.loai;
  const id = parseInt(req.params.id, 10);
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const isManager = coopIsManager(req);
  const tableMap = { doan_ra:'cooperation_doan_ra', doan_vao:'cooperation_doan_vao', mou:'cooperation_mou_de_xuat', ytnn:'htqt_de_xuat' };
  const table = tableMap[loai];
  if (!table || !id) return res.status(400).json({ message: 'Loáº¡i hoáº·c ID khÃ´ng há»£p lá»‡.' });
  try {
    let r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!r) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
    if (!isManager && (r.submitted_by_email||'').trim().toLowerCase() !== userEmail) {
      return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n xem Ä‘á» xuáº¥t nÃ y.' });
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
  } catch(e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

// ============================================================
// ÄOÃ€N RA â€” VÄƒn báº£n Word kÃ½ báº£n cá»©ng (Admin upload; NCV / PhÃ²ng / VT táº£i)
// ============================================================
app.post('/api/admin/cooperation/doan-ra/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ upload vÄƒn báº£n Word sau khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  uploadHtqtDoanRa.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .doc hoáº·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkDoanRaVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u vÄƒn báº£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/doan-ra/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
  coopUnlinkDoanRaVanBanFile(row);
  db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'ÄÃ£ xÃ³a file vÄƒn báº£n.' });
});

app.get('/api/cooperation/doan-ra/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  let row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ táº£i Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!coopCanDownloadDoanRaVanBan(req, row)) {
    return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n táº£i file nÃ y.' });
  }
  row = coopEnsureFreshDoanRaVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÆ°a cÃ³ vÄƒn báº£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-doan-ra'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'ÄÆ°á»ng dáº«n file khÃ´ng há»£p lá»‡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃ´ng cÃ²n trÃªn mÃ¡y chá»§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-doan-ra.docx');
});

app.post('/api/admin/cooperation/doan-ra/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplate.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .docx (máº«u Tá» trÃ¬nh ÄoÃ n ra, cÃ³ placeholder {ma_so}, {quoc_gia}, â€¦).' });
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u máº«u Tá» trÃ¬nh ÄoÃ n ra (.docx).' });
  });
});

app.get('/api/admin/cooperation/doan-ra/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÆ°a cÃ³ file máº«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  const gen = coopTryAutoGenerateDoanRaVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh (menu trong chi tiáº¿t ÄoÃ n ra).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] doan_ra', gen.message);
    return res.status(400).json({ message: gen.message || 'Lá»—i khi ghÃ©p Word.' });
  }
  return res.json({ ok: true, message: 'ÄÃ£ sinh file Word tá»« máº«u vÃ  dá»¯ liá»‡u Ä‘á» xuáº¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// ÄOÃ€N VÃ€O â€” VÄƒn báº£n Word / máº«u Tá» trÃ¬nh (mirror ÄoÃ n ra)
// ============================================================
app.post('/api/admin/cooperation/doan-vao/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ upload vÄƒn báº£n Word sau khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  uploadHtqtDoanVao.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .doc hoáº·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkDoanVaoVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u vÄƒn báº£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/doan-vao/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
  coopUnlinkDoanVaoVanBanFile(row);
  db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'ÄÃ£ xÃ³a file vÄƒn báº£n.' });
});

app.get('/api/cooperation/doan-vao/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  let row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ táº£i Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!coopCanDownloadDoanVaoVanBan(req, row)) {
    return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n táº£i file nÃ y.' });
  }
  row = coopEnsureFreshDoanVaoVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÆ°a cÃ³ vÄƒn báº£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-doan-vao'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'ÄÆ°á»ng dáº«n file khÃ´ng há»£p lá»‡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃ´ng cÃ²n trÃªn mÃ¡y chá»§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-doan-vao.docx');
});

app.post('/api/admin/cooperation/doan-vao/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateDoanVao.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .docx (máº«u Tá» trÃ¬nh ÄoÃ n vÃ o, cÃ³ placeholder {ma_so}, {don_vi_de_xuat}, â€¦).' });
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u máº«u Tá» trÃ¬nh ÄoÃ n vÃ o (.docx).' });
  });
});

app.get('/api/admin/cooperation/doan-vao/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÆ°a cÃ³ file máº«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  const gen = coopTryAutoGenerateDoanVaoVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh (menu trong chi tiáº¿t ÄoÃ n vÃ o).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] doan_vao', gen.message);
    return res.status(400).json({ message: gen.message || 'Lá»—i khi ghÃ©p Word.' });
  }
  return res.json({ ok: true, message: 'ÄÃ£ sinh file Word tá»« máº«u vÃ  dá»¯ liá»‡u Ä‘á» xuáº¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// THá»ŽA THUáº¬N / MOU â€” VÄƒn báº£n Word / máº«u Tá» trÃ¬nh (mirror ÄoÃ n ra & ÄoÃ n vÃ o)
// ============================================================
app.post('/api/admin/cooperation/mou/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ upload vÄƒn báº£n Word sau khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  uploadHtqtMou.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .doc hoáº·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkMouVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u vÄƒn báº£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/mou/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
  coopUnlinkMouVanBanFile(row);
  db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'ÄÃ£ xÃ³a file vÄƒn báº£n.' });
});

app.get('/api/cooperation/mou/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  let row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ táº£i Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!coopCanDownloadMouVanBan(req, row)) {
    return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n táº£i file nÃ y.' });
  }
  row = coopEnsureFreshMouVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÆ°a cÃ³ vÄƒn báº£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-mou'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'ÄÆ°á»ng dáº«n file khÃ´ng há»£p lá»‡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃ´ng cÃ²n trÃªn mÃ¡y chá»§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-mou.docx');
});

app.post('/api/admin/cooperation/mou/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateMou.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .docx (máº«u Tá» trÃ¬nh Thá»a thuáº­n/MOU, cÃ³ placeholder {ma_so}, {ten_doi_tac}, â€¦).' });
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u máº«u Tá» trÃ¬nh Äá» xuáº¥t Thá»a thuáº­n (.docx).' });
  });
});

app.get('/api/admin/cooperation/mou/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÆ°a cÃ³ file máº«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  const gen = coopTryAutoGenerateMouVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh (menu trong chi tiáº¿t Äá» xuáº¥t Thá»a thuáº­n).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] mou', gen.message);
    return res.status(400).json({ message: gen.message || 'Lá»—i khi ghÃ©p Word.' });
  }
  return res.json({ ok: true, message: 'ÄÃ£ sinh file Word tá»« máº«u vÃ  dá»¯ liá»‡u Ä‘á» xuáº¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// Äá»€ TÃ€I YTNN â€” VÄƒn báº£n Word / máº«u Tá» trÃ¬nh (mirror MOU)
// ============================================================
app.post('/api/admin/cooperation/ytnn/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ upload vÄƒn báº£n Word sau khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  uploadHtqtYtnn.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .doc hoáº·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkYtnnVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u vÄƒn báº£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/ytnn/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
  coopUnlinkYtnnVanBanFile(row);
  db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'ÄÃ£ xÃ³a file vÄƒn báº£n.' });
});

app.get('/api/cooperation/ytnn/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  let row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ táº£i Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!coopCanDownloadYtnnVanBan(req, row)) {
    return res.status(403).json({ message: 'Báº¡n khÃ´ng cÃ³ quyá»n táº£i file nÃ y.' });
  }
  row = coopEnsureFreshYtnnVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÆ°a cÃ³ vÄƒn báº£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-ytnn'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'ÄÆ°á»ng dáº«n file khÃ´ng há»£p lá»‡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃ´ng cÃ²n trÃªn mÃ¡y chá»§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-ytnn.docx');
});

app.post('/api/admin/cooperation/ytnn/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateYtnn.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Lá»—i upload' });
    if (!req.file) return res.status(400).json({ message: 'Chá»n file .docx (máº«u Tá» trÃ¬nh YTNN: {ma_so}, {ten_de_tai}, {mo_ta_de_tai}, {ten_to_chuc_doi_tac}, {quoc_gia_doi_tac}, {chu_nhiem_de_tai}, {hoc_ham_hoc_vi}, {don_vi_chu_nhiem}, {kinh_phi}, {don_vi_tien_te}, {tieu_de_to_trinh}, {nguoi_phe_duyet}, â€¦).' });
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u máº«u Tá» trÃ¬nh Äá» tÃ i YTNN (.docx).' });
  });
});

app.get('/api/admin/cooperation/ytnn/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÆ°a cÃ³ file máº«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y Ä‘á» xuáº¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  const gen = coopTryAutoGenerateYtnnVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÆ°a cÃ³ file máº«u .docx. Admin vui lÃ²ng táº£i lÃªn máº«u Tá» trÃ¬nh (menu trong chi tiáº¿t Äá» tÃ i YTNN).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'Chá»‰ sinh tá» trÃ¬nh khi Ä‘á» xuáº¥t Ä‘Ã£ Ä‘Æ°á»£c phÃª duyá»‡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] ytnn', gen.message);
    return res.status(400).json({ message: gen.message || 'Lá»—i khi ghÃ©p Word.' });
  }
  return res.json({ ok: true, message: 'ÄÃ£ sinh file Word tá»« máº«u vÃ  dá»¯ liá»‡u Ä‘á» xuáº¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// ROUTE Má»šI â€” Lá»ŠCH Sá»¬ THAO TÃC
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
// ROUTE Má»šI â€” ÄOÃ€N RA: THáº¨M Äá»ŠNH (PhÃ²ng KHCN â†’ bÆ°á»›c 2)
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
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chá»‰ tháº©m Ä‘á»‹nh khi Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN. Náº¿u Ä‘ang yÃªu cáº§u bá»• sung, ngÆ°á»i gá»­i cáº§n ná»™p láº¡i há»“ sÆ¡ trÆ°á»›c.' });
    }
    const newStatus = action==='duyet_len_vt' ? 'cho_vt_duyet' : action==='tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action==='duyet_len_vt' ? 'PhÃ²ng KHCN tháº©m Ä‘á»‹nh â€” TrÃ¬nh Viá»‡n trÆ°á»Ÿng' : action==='tu_choi' ? 'PhÃ²ng KHCN tá»« chá»‘i' : 'PhÃ²ng KHCN yÃªu cáº§u bá»• sung';
    db.prepare("UPDATE cooperation_doan_ra SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_ra', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_ra', row, id, 'phong', note).catch(err => console.error('[Email tu_choi doan_ra]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
        subject:`[${row.ma_de_xuat||coopGenMa('doan_ra',id)}] Cáº­p nháº­t ÄoÃ n ra â€” ${label}`,
        html: coopBuildEmail('Cáº­p nháº­t Äá» xuáº¥t ÄoÃ n ra', `Äá» xuáº¥t ÄoÃ n ra cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c PhÃ²ng KHCN&amp;QHÄN xá»­ lÃ½.`,
          [['MÃ£',row.ma_de_xuat||coopGenMa('doan_ra',id)],['Tráº¡ng thÃ¡i má»›i',STATUS_LABELS_COOP[newStatus]||newStatus],['Ã kiáº¿n PhÃ²ng KHCN',note||'â€”']], 'TrÃ¢n trá»ng.'),
        text:`${row.ma_de_xuat} â€” ${label}. Ã kiáº¿n: ${note||'â€”'}` });
      }
    }
    if (action==='duyet_len_vt') {
      const recip = coopGetRecipients('doan_ra');
      coopSendMail({ to:recip.to, cc:recip.cc,
        subject:`[Há»£p tÃ¡c QT] TrÃ¬nh duyá»‡t ÄoÃ n ra â€” ${row.ma_de_xuat||coopGenMa('doan_ra',id)}`,
        html: coopBuildEmail('Äá» xuáº¥t ÄoÃ n ra cáº§n Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t','PhÃ²ng KHCN&amp;QHÄN Ä‘Ã£ tháº©m Ä‘á»‹nh vÃ  trÃ¬nh Viá»‡n trÆ°á»Ÿng:',
          [['MÃ£',row.ma_de_xuat||coopGenMa('doan_ra',id)],['NgÆ°á»i gá»­i',row.submitted_by_name||row.submitted_by_email],['Quá»‘c gia',row.quoc_gia],['NgÃ y Ä‘i',coopFmtDate(row.ngay_di)],['Ã kiáº¿n PhÃ²ng',note||'â€”']],
          'TrÃ¢n trá»ng,<br/>PhÃ²ng KHCN&QHÄN', (process.env.BASE_URL||'http://localhost:'+PORT)+'/module-hoatac-quocte.html'),
        text:`TrÃ¬nh duyá»‡t ÄoÃ n ra ${row.ma_de_xuat}.` });
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

// ============================================================
// ROUTE Má»šI â€” ÄOÃ€N RA: PHÃŠ DUYá»†T (Viá»‡n trÆ°á»Ÿng â†’ bÆ°á»›c 3)
// ============================================================
app.put('/api/cooperation/doan-ra/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet') {
      return res.status(400).json({ message: 'Chá»‰ phÃª duyá»‡t Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang á»Ÿ bÆ°á»›c chá» Viá»‡n trÆ°á»Ÿng (Ä‘Ã£ qua PhÃ²ng KHCN).' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ phÃª duyá»‡t' : action==='tu_choi' ? 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t' : 'Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung';
    db.prepare("UPDATE cooperation_doan_ra SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_ra', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateDoanRaVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_ra] ÄÃ£ phÃª duyá»‡t nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx) má»™t láº§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_ra] Auto Word sau phÃª duyá»‡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('doan_ra'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung â€” ÄoÃ n ra`,
          html: coopBuildEmail('Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung há»“ sÆ¡ (ÄoÃ n ra)',
            'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ cÃ³ Ã½ kiáº¿n yÃªu cáº§u bá»• sung. <strong>PhÃ²ng KHCN&amp;QHÄN</strong> Ä‘Æ°á»£c CC Ä‘á»ƒ phá»‘i há»£p theo dÃµi.',
            [['MÃ£', ma], ['Ná»™i dung Ã½ kiáº¿n', note || 'â€”']], 'TrÃ¢n trá»ng.'),
          text: `${ma} â€” Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung. Ã kiáº¿n: ${note || 'â€”'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_ra', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi doan_ra]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${ma}] Káº¿t quáº£ phÃª duyá»‡t ÄoÃ n ra`,
          html: coopBuildEmail('Káº¿t quáº£ phÃª duyá»‡t ÄoÃ n ra', 'Äá» xuáº¥t cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c Viá»‡n trÆ°á»Ÿng xem xÃ©t.',
            [['MÃ£', ma], ['Káº¿t quáº£', label], ['Ã kiáº¿n', note || 'â€”']], 'TrÃ¢n trá»ng.'),
          text: `${row.ma_de_xuat} â€” ${label}. Ã kiáº¿n: ${note || 'â€”'}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

// ============================================================
// ROUTE Má»šI â€” ÄOÃ€N VÃ€O: PHÃŠ DUYá»†T (Viá»‡n trÆ°á»Ÿng)
// ============================================================
app.put('/api/cooperation/doan-vao/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet' && st !== 'cho_ky_duyet') {
      return res.status(400).json({ message: 'Chá»‰ phÃª duyá»‡t Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang chá» Viá»‡n trÆ°á»Ÿng.' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ phÃª duyá»‡t' : action==='tu_choi' ? 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t' : 'Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung';
    db.prepare("UPDATE cooperation_doan_vao SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_vao', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateDoanVaoVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_vao] ÄÃ£ phÃª duyá»‡t nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx) má»™t láº§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_vao] Auto Word sau phÃª duyá»‡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('doan_vao'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung â€” ÄoÃ n vÃ o`,
          html: coopBuildEmail('Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung há»“ sÆ¡ (ÄoÃ n vÃ o)',
            'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ cÃ³ Ã½ kiáº¿n yÃªu cáº§u bá»• sung. <strong>PhÃ²ng KHCN&amp;QHÄN</strong> Ä‘Æ°á»£c CC Ä‘á»ƒ phá»‘i há»£p theo dÃµi.',
            [['MÃ£', ma], ['Ná»™i dung Ã½ kiáº¿n', note || 'â€”']], 'TrÃ¢n trá»ng.'),
          text: `${ma} â€” YCBS Viá»‡n trÆ°á»Ÿng. Ã kiáº¿n: ${note || 'â€”'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_vao', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi doan_vao]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] Káº¿t quáº£ phÃª duyá»‡t ÄoÃ n vÃ o`,
        html: coopBuildEmail('Káº¿t quáº£ phÃª duyá»‡t ÄoÃ n vÃ o','Äá» xuáº¥t cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c Viá»‡n trÆ°á»Ÿng xem xÃ©t.',
            [['MÃ£',ma],['Káº¿t quáº£',label],['Ã kiáº¿n',note||'â€”']],'TrÃ¢n trá»ng.'),
        text:`${row.ma_de_xuat} â€” ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

// ============================================================
// ROUTE Má»šI â€” MOU: PHÃŠ DUYá»†T (Viá»‡n trÆ°á»Ÿng)
// ============================================================
app.put('/api/cooperation/mou/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note, so_van_ban, ngay_ky } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet') {
      return res.status(400).json({ message: 'Chá»‰ phÃª duyá»‡t Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang chá» Viá»‡n trÆ°á»Ÿng.' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ phÃª duyá»‡t' : action==='tu_choi' ? 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t' : 'Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung';
    db.prepare("UPDATE cooperation_mou_de_xuat SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('mou', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateMouVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[mou] ÄÃ£ phÃª duyá»‡t nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx) má»™t láº§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[mou] Auto Word sau phÃª duyá»‡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('mou', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('mou'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung â€” MOU`,
          html: coopBuildEmail('Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung há»“ sÆ¡ (MOU/Thá»a thuáº­n)',
            'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ cÃ³ Ã½ kiáº¿n yÃªu cáº§u bá»• sung. <strong>PhÃ²ng KHCN&amp;QHÄN</strong> Ä‘Æ°á»£c CC Ä‘á»ƒ phá»‘i há»£p theo dÃµi.',
            [['MÃ£', ma], ['Äá»‘i tÃ¡c', row.ten_doi_tac || 'â€”'], ['Ná»™i dung Ã½ kiáº¿n', note || 'â€”']], 'TrÃ¢n trá»ng.'),
          text: `${ma} â€” YCBS Viá»‡n trÆ°á»Ÿng. Ã kiáº¿n: ${note || 'â€”'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('mou', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi mou]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] Káº¿t quáº£ phÃª duyá»‡t MOU`,
        html: coopBuildEmail('Káº¿t quáº£ phÃª duyá»‡t Thá»a thuáº­n MOU','Äá» xuáº¥t cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c Viá»‡n trÆ°á»Ÿng xem xÃ©t.',
            [['MÃ£',ma],['Äá»‘i tÃ¡c',row.ten_doi_tac||'â€”'],['Káº¿t quáº£',label],['Sá»‘ vÄƒn báº£n',so_van_ban||'â€”'],['Ã kiáº¿n',note||'â€”']],'TrÃ¢n trá»ng.'),
        text:`${row.ma_de_xuat} â€” ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

// ============================================================
// ROUTE Má»šI â€” YTNN: SUBMIT, LIST, THáº¨M Äá»ŠNH, PHÃŠ DUYá»†T
// ============================================================
app.post('/api/cooperation/ytnn/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  const ten = (body.ten || '').trim();
  if (!ten) return res.status(400).json({ message: 'Thiáº¿u: TÃªn Ä‘á» tÃ i.' });
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
      body.kinh_phi||null, body.don_vi_tien_te||'VNÄ', body.loai_hinh||'');
    const newId = result.lastInsertRowid;
    const ma = coopGenMa('ytnn', newId);
    db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat=? WHERE id=?').run(ma, newId);
    coopAddHistory('ytnn', newId, 1, 'submitted', 'Gá»­i Ä‘á» xuáº¥t Äá» tÃ i YTNN', user, 'Äá» xuáº¥t tiáº¿p nháº­n Ä‘á» tÃ i cÃ³ yáº¿u tá»‘ nÆ°á»›c ngoÃ i');
    const recip = coopGetRecipients('ytnn');
    coopSendMail({ to:recip.to, cc:recip.cc,
      subject:`[Há»£p tÃ¡c QT] Äá» xuáº¥t YTNN má»›i â€” ${ma} â€” ${ten}`,
      html: coopBuildEmail('Äá» tÃ i YTNN má»›i cáº§n phÃ¢n loáº¡i & tháº©m Ä‘á»‹nh', `<strong>${user.fullname||user.email}</strong> gá»­i Ä‘á» xuáº¥t Ä‘á» tÃ i YTNN.`,
        [['MÃ£',ma],['TÃªn',ten],['Äá»‘i tÃ¡c',body.doi_tac_ten||'â€”'],['Quá»‘c gia',body.doi_tac_quoc_gia||'â€”'],['Chá»§ nhiá»‡m',body.chu_nhiem_ten||user.fullname||'â€”']],
        'TrÃ¢n trá»ng.', (process.env.BASE_URL||'http://localhost:'+PORT)+'/module-hoatac-quocte.html'),
      text:`[${ma}] Äá» xuáº¥t YTNN "${ten}" tá»« ${user.email}.` });
    return res.json({ ok:true, message:`ÄÃ£ gá»­i! MÃ£: ${ma}`, ma_de_xuat:ma, id:newId });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
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
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phan_loai', 'cho_phong_duyet', 'dang_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'Chá»‰ tháº©m Ä‘á»‹nh khi Ä‘á» xuáº¥t Ä‘ang chá» PhÃ²ng KHCN. Náº¿u Ä‘ang yÃªu cáº§u bá»• sung, ngÆ°á»i gá»­i cáº§n ná»™p láº¡i há»“ sÆ¡ trÆ°á»›c.' });
    }
    const newStatus = action === 'chuyen_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'chuyen_vt' ? 'PhÃ²ng KHCN tháº©m Ä‘á»‹nh â€” TrÃ¬nh Viá»‡n trÆ°á»Ÿng' : action === 'tu_choi' ? 'PhÃ²ng KHCN tá»« chá»‘i' : 'PhÃ²ng KHCN yÃªu cáº§u bá»• sung';
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
        subject:`[${row.ma_de_xuat||coopGenMa('ytnn',id)}] YTNN â€” ${label}`,
        html: coopBuildEmail('Cáº­p nháº­t Äá» tÃ i YTNN','Äá» xuáº¥t cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c PhÃ²ng KHCN xá»­ lÃ½.',
          [['MÃ£',row.ma_de_xuat||coopGenMa('ytnn',id)],['Tráº¡ng thÃ¡i',STATUS_LABELS_COOP[newStatus]||newStatus],['Ã kiáº¿n',note||'â€”']],'TrÃ¢n trá»ng.'),
        text:`${row.ma_de_xuat} â€” ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

app.put('/api/cooperation/ytnn/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note, vt_so_van_ban, vt_ngay_ky } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung','da_phe_duyet','khong_phe_duyet'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet' && st !== 'cho_vt_phe_duyet') {
      return res.status(400).json({ message: 'Chá»‰ phÃª duyá»‡t Ä‘Æ°á»£c khi Ä‘á» xuáº¥t Ä‘ang chá» Viá»‡n trÆ°á»Ÿng.' });
    }
    const act = (action === 'da_phe_duyet') ? 'da_duyet' : (action === 'khong_phe_duyet') ? 'tu_choi' : action;
    const newStatus = act === 'yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : act;
    const label = act === 'da_duyet' ? 'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ phÃª duyá»‡t' : act === 'tu_choi' ? 'Viá»‡n trÆ°á»Ÿng khÃ´ng phÃª duyá»‡t' : 'Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung';
    db.prepare("UPDATE htqt_de_xuat SET status=?, note_vt=?, vt_y_kien=?, vt_so_van_ban=?, vt_ngay_ky=?, vt_nguoi_ky_id=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, note || null, vt_so_van_ban || null, vt_ngay_ky || null, req.user.id || null, req.user.id || null, id);
    coopAddHistory('ytnn', id, 3, act, label, req.user, note);
    if (act === 'da_duyet') {
      const gen = coopTryAutoGenerateYtnnVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[ytnn] ÄÃ£ phÃª duyá»‡t nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng â€” Admin cáº§n táº£i máº«u Tá» trÃ¬nh (.docx) má»™t láº§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[ytnn] Auto Word sau phÃª duyá»‡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('ytnn'), row.submitted_by_email);
      if (act === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung â€” YTNN`,
          html: coopBuildEmail('Viá»‡n trÆ°á»Ÿng yÃªu cáº§u bá»• sung há»“ sÆ¡ (Äá» tÃ i YTNN)',
            'Viá»‡n trÆ°á»Ÿng Ä‘Ã£ cÃ³ Ã½ kiáº¿n yÃªu cáº§u bá»• sung. <strong>PhÃ²ng KHCN&amp;QHÄN</strong> Ä‘Æ°á»£c CC Ä‘á»ƒ phá»‘i há»£p theo dÃµi.',
            [['MÃ£', ma], ['TÃªn Ä‘á» tÃ i', row.ten || 'â€”'], ['Ná»™i dung Ã½ kiáº¿n', note || 'â€”']], 'TrÃ¢n trá»ng.'),
          text: `${ma} â€” YCBS Viá»‡n trÆ°á»Ÿng. Ã kiáº¿n: ${note || 'â€”'}` });
      } else if (act === 'tu_choi') {
        coopSendMailTuChoi('ytnn', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi ytnn]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] Káº¿t quáº£ phÃª duyá»‡t YTNN`,
        html: coopBuildEmail('Káº¿t quáº£ phÃª duyá»‡t Äá» tÃ i YTNN','Äá» xuáº¥t cá»§a báº¡n Ä‘Ã£ Ä‘Æ°á»£c Viá»‡n trÆ°á»Ÿng xem xÃ©t.',
            [['MÃ£',ma],['TÃªn',row.ten],['Káº¿t quáº£',label],['Sá»‘ VB',vt_so_van_ban||'â€”'],['Ã kiáº¿n',note||'â€”']],'TrÃ¢n trá»ng.'),
        text:`${row.ma_de_xuat} â€” ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

// NgÆ°á»i gá»­i: chá»‰nh sá»­a / ná»™p láº¡i / káº¿t thÃºc (giá»¯ mÃ£ & lá»‹ch sá»­; chá»‰ admin xÃ³a báº£n ghi)
function coopNopLaiStatusForLoai(loai) {
  return 'cho_phong_duyet';
}

app.put('/api/cooperation/doan-ra/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ chá»‰nh sá»­a khi Ä‘á» xuáº¥t Ä‘ang á»Ÿ tráº¡ng thÃ¡i yÃªu cáº§u bá»• sung.' });
    }
    const muc_dich = b.muc_dich != null ? String(b.muc_dich) : row.muc_dich;
    const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia || '').trim() : row.quoc_gia;
    const ngay_di = b.ngay_di != null ? String(b.ngay_di || '').trim() : row.ngay_di;
    const ngay_ve = b.ngay_ve != null ? String(b.ngay_ve || '').trim() : row.ngay_ve;
    const thanh_vien = b.thanh_vien != null ? String(b.thanh_vien) : row.thanh_vien;
    const nguon_kinh_phi = b.nguon_kinh_phi != null ? String(b.nguon_kinh_phi) : row.nguon_kinh_phi;
    const du_toan = b.du_toan != null && b.du_toan !== '' ? String(b.du_toan) : row.du_toan;
    if (!quoc_gia || !ngay_di || !ngay_ve || !thanh_vien) {
      return res.status(400).json({ message: 'Vui lÃ²ng Ä‘iá»n Ä‘á»§: Quá»‘c gia, NgÃ y Ä‘i, NgÃ y vá», ThÃ nh viÃªn Ä‘oÃ n.' });
    }
    db.prepare(`UPDATE cooperation_doan_ra SET muc_dich=?, quoc_gia=?, ngay_di=?, ngay_ve=?, thanh_vien=?, nguon_kinh_phi=?, du_toan=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, id);
    coopAddHistory('doan_ra', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÆ°á»i gá»­i cáº­p nháº­t ná»™i dung Ä‘á» xuáº¥t', req.user, null);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u chá»‰nh sá»­a.' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/doan-ra/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ ná»™p láº¡i khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('doan_ra');
    db.prepare(`UPDATE cooperation_doan_ra SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('doan_ra', id, 2, 'nop_lai', 'Ná»™p láº¡i há»“ sÆ¡ â€” chá» PhÃ²ng KHCN tháº©m Ä‘á»‹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_ra', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡ â€” ÄoÃ n ra â€” ${ma}`,
      html: coopBuildEmail('Ná»™p láº¡i há»“ sÆ¡ (ÄoÃ n ra)', `NgÆ°á»i gá»­i <strong>${coopEscHtml(row.submitted_by_name || row.submitted_by_email)}</strong> Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡ theo yÃªu cáº§u bá»• sung. Äá» xuáº¥t quay láº¡i bÆ°á»›c <strong>PhÃ²ng KHCN tháº©m Ä‘á»‹nh</strong>, sau Ä‘Ã³ trÃ¬nh Viá»‡n trÆ°á»Ÿng.`,
        [['MÃ£', ma], ['NgÆ°á»i gá»­i', row.submitted_by_name || row.submitted_by_email]], 'TrÃ¢n trá»ng.', modUrl),
      text: `Ná»™p láº¡i ÄoÃ n ra ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai doan_ra]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ná»™p láº¡i. PhÃ²ng KHCN sáº½ tháº©m Ä‘á»‹nh láº¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/doan-ra/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ káº¿t thÃºc khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    db.prepare(`UPDATE cooperation_doan_ra SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('doan_ra', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÆ°á»i gá»­i káº¿t thÃºc Ä‘á» xuáº¥t (khÃ´ng ná»™p láº¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_ra', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ káº¿t thÃºc Ä‘á» xuáº¥t â€” ÄoÃ n ra â€” ${ma}`,
      html: coopBuildEmail('Káº¿t thÃºc Ä‘á» xuáº¥t (thÃ´ng bÃ¡o)', `NgÆ°á»i gá»­i Ä‘Ã£ <strong>chá»§ Ä‘á»™ng káº¿t thÃºc</strong> Ä‘á» xuáº¥t, khÃ´ng tiáº¿p tá»¥c ná»™p láº¡i há»“ sÆ¡. Há»“ sÆ¡ Ä‘Æ°á»£c lÆ°u trong há»‡ thá»‘ng.`,
        [['MÃ£', ma], ['NgÆ°á»i gá»­i', row.submitted_by_name || row.submitted_by_email]], 'TrÃ¢n trá»ng.', modUrl),
      text: `Káº¿t thÃºc Ä‘á» xuáº¥t ÄoÃ n ra ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc doan_ra]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ghi nháº­n káº¿t thÃºc Ä‘á» xuáº¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.put('/api/cooperation/doan-vao/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ chá»‰nh sá»­a khi Ä‘á» xuáº¥t Ä‘ang á»Ÿ tráº¡ng thÃ¡i yÃªu cáº§u bá»• sung.' });
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
      return res.status(400).json({ message: 'Vui lÃ²ng Ä‘iá»n Ä‘á»§: ÄÆ¡n vá»‹ Ä‘á» xuáº¥t, NgÃ y Ä‘áº¿n, ThÃ nh pháº§n Ä‘oÃ n.' });
    }
    db.prepare(`UPDATE cooperation_doan_vao SET muc_dich=?, don_vi_de_xuat=?, ngay_den=?, ngay_roi_di=?, thanh_phan_doan=?, noi_dung_lam_viec=?, kinh_phi_nguon=?, ho_tro_visa=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, noi_dung_lam_viec, kinh_phi_nguon, ho_tro_visa, id);
    coopAddHistory('doan_vao', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÆ°á»i gá»­i cáº­p nháº­t ná»™i dung Ä‘á» xuáº¥t', req.user, null);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u chá»‰nh sá»­a.' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/doan-vao/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ ná»™p láº¡i khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('doan_vao');
    db.prepare(`UPDATE cooperation_doan_vao SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('doan_vao', id, 2, 'nop_lai', 'Ná»™p láº¡i há»“ sÆ¡ â€” chá» PhÃ²ng KHCN tháº©m Ä‘á»‹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_vao', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡ â€” ÄoÃ n vÃ o â€” ${ma}`,
      html: coopBuildEmail('Ná»™p láº¡i há»“ sÆ¡ (ÄoÃ n vÃ o)', `NgÆ°á»i gá»­i Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡. Äá» xuáº¥t quay láº¡i bÆ°á»›c <strong>PhÃ²ng KHCN tháº©m Ä‘á»‹nh</strong>, sau Ä‘Ã³ trÃ¬nh Viá»‡n trÆ°á»Ÿng.`,
        [['MÃ£', ma]], 'TrÃ¢n trá»ng.', modUrl),
      text: `Ná»™p láº¡i ÄoÃ n vÃ o ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai doan_vao]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ná»™p láº¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/doan-vao/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ káº¿t thÃºc khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    db.prepare(`UPDATE cooperation_doan_vao SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('doan_vao', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÆ°á»i gá»­i káº¿t thÃºc Ä‘á» xuáº¥t (khÃ´ng ná»™p láº¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_vao', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ káº¿t thÃºc Ä‘á» xuáº¥t â€” ÄoÃ n vÃ o â€” ${ma}`,
      html: coopBuildEmail('Káº¿t thÃºc Ä‘á» xuáº¥t (thÃ´ng bÃ¡o)', `NgÆ°á»i gá»­i Ä‘Ã£ chá»§ Ä‘á»™ng káº¿t thÃºc Ä‘á» xuáº¥t, khÃ´ng tiáº¿p tá»¥c ná»™p láº¡i.`,
        [['MÃ£', ma]], 'TrÃ¢n trá»ng.', modUrl),
      text: `Káº¿t thÃºc ÄoÃ n vÃ o ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc doan_vao]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ghi nháº­n káº¿t thÃºc Ä‘á» xuáº¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.put('/api/cooperation/mou/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ chá»‰nh sá»­a khi Ä‘á» xuáº¥t Ä‘ang á»Ÿ tráº¡ng thÃ¡i yÃªu cáº§u bá»• sung.' });
    }
    const loai_thoa_thuan = b.loai_thoa_thuan != null ? String(b.loai_thoa_thuan) : row.loai_thoa_thuan;
    const ten_doi_tac = b.ten_doi_tac != null ? String(b.ten_doi_tac || '').trim() : row.ten_doi_tac;
    const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia) : row.quoc_gia;
    const thoi_han_nam = b.thoi_han_nam != null && b.thoi_han_nam !== '' ? String(b.thoi_han_nam) : row.thoi_han_nam;
    const gia_tri_tai_chinh = b.gia_tri_tai_chinh != null ? String(b.gia_tri_tai_chinh) : row.gia_tri_tai_chinh;
    const don_vi_de_xuat = b.don_vi_de_xuat != null ? String(b.don_vi_de_xuat) : row.don_vi_de_xuat;
    const noi_dung_hop_tac = b.noi_dung_hop_tac != null ? String(b.noi_dung_hop_tac) : row.noi_dung_hop_tac;
    if (!ten_doi_tac || !noi_dung_hop_tac) {
      return res.status(400).json({ message: 'Vui lÃ²ng Ä‘iá»n Ä‘á»‘i tÃ¡c vÃ  ná»™i dung há»£p tÃ¡c.' });
    }
    db.prepare(`UPDATE cooperation_mou_de_xuat SET loai_thoa_thuan=?, ten_doi_tac=?, quoc_gia=?, thoi_han_nam=?, gia_tri_tai_chinh=?, don_vi_de_xuat=?, noi_dung_hop_tac=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, noi_dung_hop_tac, id);
    coopAddHistory('mou', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÆ°á»i gá»­i cáº­p nháº­t ná»™i dung Ä‘á» xuáº¥t', req.user, null);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u chá»‰nh sá»­a.' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/mou/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ ná»™p láº¡i khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('mou');
    db.prepare(`UPDATE cooperation_mou_de_xuat SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('mou', id, 2, 'nop_lai', 'Ná»™p láº¡i há»“ sÆ¡ â€” chá» PhÃ²ng KHCN tháº©m Ä‘á»‹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('mou', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('mou', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡ â€” MOU â€” ${ma}`,
      html: coopBuildEmail('Ná»™p láº¡i há»“ sÆ¡ (MOU)', `NgÆ°á»i gá»­i Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡. Äá» xuáº¥t quay láº¡i bÆ°á»›c <strong>PhÃ²ng KHCN tháº©m Ä‘á»‹nh</strong>, sau Ä‘Ã³ trÃ¬nh Viá»‡n trÆ°á»Ÿng.`,
        [['MÃ£', ma]], 'TrÃ¢n trá»ng.', modUrl),
      text: `Ná»™p láº¡i MOU ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai mou]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ná»™p láº¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/mou/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ káº¿t thÃºc khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    db.prepare(`UPDATE cooperation_mou_de_xuat SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('mou', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÆ°á»i gá»­i káº¿t thÃºc Ä‘á» xuáº¥t (khÃ´ng ná»™p láº¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('mou', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('mou', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ káº¿t thÃºc Ä‘á» xuáº¥t â€” MOU â€” ${ma}`,
      html: coopBuildEmail('Káº¿t thÃºc Ä‘á» xuáº¥t (thÃ´ng bÃ¡o)', `NgÆ°á»i gá»­i Ä‘Ã£ chá»§ Ä‘á»™ng káº¿t thÃºc Ä‘á» xuáº¥t.`,
        [['MÃ£', ma]], 'TrÃ¢n trá»ng.', modUrl),
      text: `Káº¿t thÃºc MOU ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc mou]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ghi nháº­n káº¿t thÃºc Ä‘á» xuáº¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.put('/api/cooperation/ytnn/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ chá»‰nh sá»­a khi Ä‘á» xuáº¥t Ä‘ang á»Ÿ tráº¡ng thÃ¡i yÃªu cáº§u bá»• sung.' });
    }
    const ten = b.ten != null ? String(b.ten || '').trim() : row.ten;
    if (!ten) return res.status(400).json({ message: 'Thiáº¿u tÃªn Ä‘á» tÃ i.' });
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
    coopAddHistory('ytnn', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÆ°á»i gá»­i cáº­p nháº­t ná»™i dung Ä‘á» xuáº¥t', req.user, null);
    return res.json({ ok: true, message: 'ÄÃ£ lÆ°u chá»‰nh sá»­a.' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/ytnn/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ ná»™p láº¡i khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('ytnn');
    db.prepare(`UPDATE htqt_de_xuat SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('ytnn', id, 2, 'nop_lai', 'Ná»™p láº¡i há»“ sÆ¡ â€” chá» PhÃ²ng KHCN phÃ¢n loáº¡i & tháº©m Ä‘á»‹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('ytnn', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡ â€” YTNN â€” ${ma}`,
      html: coopBuildEmail('Ná»™p láº¡i há»“ sÆ¡ (YTNN)', `NgÆ°á»i gá»­i Ä‘Ã£ ná»™p láº¡i há»“ sÆ¡. Äá» xuáº¥t quay láº¡i bÆ°á»›c <strong>PhÃ²ng KHCN</strong>, sau Ä‘Ã³ trÃ¬nh Viá»‡n trÆ°á»Ÿng.`,
        [['MÃ£', ma], ['TÃªn', row.ten || 'â€”']], 'TrÃ¢n trá»ng.', modUrl),
      text: `Ná»™p láº¡i YTNN ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai ytnn]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ná»™p láº¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

app.post('/api/cooperation/ytnn/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'Chá»‰ káº¿t thÃºc khi Ä‘á» xuáº¥t Ä‘ang yÃªu cáº§u bá»• sung.' });
    }
    db.prepare(`UPDATE htqt_de_xuat SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('ytnn', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÆ°á»i gá»­i káº¿t thÃºc Ä‘á» xuáº¥t (khÃ´ng ná»™p láº¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('ytnn', {
      submitterEmail: row.submitted_by_email,
      subject: `[Há»£p tÃ¡c QT] NgÆ°á»i gá»­i Ä‘Ã£ káº¿t thÃºc Ä‘á» xuáº¥t â€” YTNN â€” ${ma}`,
      html: coopBuildEmail('Káº¿t thÃºc Ä‘á» xuáº¥t (thÃ´ng bÃ¡o)', `NgÆ°á»i gá»­i Ä‘Ã£ chá»§ Ä‘á»™ng káº¿t thÃºc Ä‘á» xuáº¥t.`,
        [['MÃ£', ma]], 'TrÃ¢n trá»ng.', modUrl),
      text: `Káº¿t thÃºc YTNN ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc ytnn]', err.message));
    return res.json({ ok: true, message: 'ÄÃ£ ghi nháº­n káº¿t thÃºc Ä‘á» xuáº¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i: ' + e.message }); }
});

// ============================================================
// ROUTE Má»šI â€” Sá»° KIá»†N QUá»C Táº¾
// ============================================================
app.post('/api/cooperation/su-kien', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  if (!body.tieu_de || !body.ngay_bat_dau) return res.status(400).json({ message: 'Thiáº¿u TiÃªu Ä‘á» vÃ  NgÃ y báº¯t Ä‘áº§u.' });
  try {
    const result = db.prepare(`
      INSERT INTO cooperation_su_kien (tieu_de, mo_ta, loai_su_kien, quoc_gia, dia_diem, ngay_bat_dau, ngay_ket_thuc, don_vi_to_chuc, link_su_kien, han_dang_ky, kinh_phi_tham_du, ghi_chu, tags, status, created_by_id, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(body.tieu_de, body.mo_ta||'', body.loai_su_kien||'hoi_thao', body.quoc_gia||'', body.dia_diem||'',
      body.ngay_bat_dau, body.ngay_ket_thuc||'', body.don_vi_to_chuc||'',
      body.link_su_kien||'', body.han_dang_ky||'', body.kinh_phi_tham_du||'',
      body.ghi_chu||'', body.tags||'', body.status||'sap_dien_ra',
      user.id||null, user.fullname||user.email||'');
    return res.json({ ok:true, message:'ÄÃ£ táº¡o sá»± kiá»‡n!', id: result.lastInsertRowid });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃ´ng cÃ³ gÃ¬ cáº­p nháº­t.' });
  sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_su_kien SET ${sets.join(',')} WHERE id=?`).run(...vals);
    return res.json({ ok:true, message:'ÄÃ£ cáº­p nháº­t.' });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

app.delete('/api/admin/cooperation/su-kien/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM cooperation_su_kien WHERE id=?').run(parseInt(req.params.id,10));
    return res.json({ ok:true, message:'ÄÃ£ xÃ³a sá»± kiá»‡n.' });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

// ============================================================
// ROUTE Má»šI â€” EVENTS WORKFLOW
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
  return String(((row && row.c) || 0) + 1) + '/SCI-KHCN&QHÄN';
}
function eventStatusTransitionError(ev, toStatus) {
  const from = eventNormStatus(ev.trang_thai);
  const to = eventNormStatus(toStatus);
  if (!(EVENT_TRANSITIONS[from] || []).includes(to)) return 'KhÃ´ng Ä‘Ãºng thá»© tá»± chuyá»ƒn tráº¡ng thÃ¡i.';
  if (to === 'da_duoc_phep') {
    const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file = 'quyet_dinh_cho_phep' LIMIT 1").get(ev.id);
    if (!has) return 'Cáº§n upload Quyáº¿t Ä‘á»‹nh cho phÃ©p trÆ°á»›c khi chuyá»ƒn tráº¡ng thÃ¡i nÃ y.';
  }
  if (to === 'da_bao_cao') {
    const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file IN ('bao_cao_su_kien','quyet_dinh_bao_cao') LIMIT 1").get(ev.id);
    if (!has) return 'Cáº§n upload BÃ¡o cÃ¡o cÃ³ dáº¥u Ä‘á» trÆ°á»›c khi chuyá»ƒn tráº¡ng thÃ¡i nÃ y.';
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
    if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Chá»‰ nháº­n PDF, DOC, DOCX, JPG, PNG'));
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
  } catch (e) { return res.status(500).json({ message: 'Lá»—i táº£i danh sÃ¡ch sá»± kiá»‡n: ' + e.message }); }
});
app.post('/api/events', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const b = req.body || {};
  if (!String(b.tieu_de || '').trim() || !String(b.ngay_bat_dau || '').trim()) return res.status(400).json({ message: 'Thiáº¿u TÃªn sá»± kiá»‡n hoáº·c NgÃ y báº¯t Ä‘áº§u.' });
  try {
    const so = String(b.so_van_ban || '').trim() || eventGenSoVanBan();
    const ins = db.prepare(`INSERT INTO events (so_van_ban,tieu_de,loai,don_vi_to_chuc,hinh_thuc,link_su_kien,dia_diem,quy_mo,lich_trinh,muc_tieu,thanh_phan_tham_du,kinh_phi_du_kien,nguon_kinh_phi,ngay_bat_dau,ngay_ket_thuc,han_dang_ky,nguoi_tao,trang_thai,nguoi_phu_trach,phu_trach_lien_he,ghi_chu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(so, b.tieu_de || '', b.loai || 'Há»™i tháº£o', b.don_vi_to_chuc || '', b.hinh_thuc || '', b.link_su_kien || '', b.dia_diem || '', b.quy_mo ? Number(b.quy_mo) : null, JSON.stringify(b.lich_trinh || []), b.muc_tieu || '', b.thanh_phan_tham_du || '', b.kinh_phi_du_kien ? Number(b.kinh_phi_du_kien) : 0, b.nguon_kinh_phi || '', b.ngay_bat_dau || '', b.ngay_ket_thuc || '', b.han_dang_ky || '', req.user.fullname || req.user.email || '', eventNormStatus(b.trang_thai || 'draft'), b.nguoi_phu_trach || '', b.phu_trach_lien_he || '', b.ghi_chu || '');
    const id = Number(ins.lastInsertRowid);
    db.prepare('INSERT INTO event_status_history (event_id, from_status, to_status, note, changed_by_id, changed_by_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, null, eventNormStatus(b.trang_thai || 'draft'), 'Táº¡o sá»± kiá»‡n', req.user.id || null, req.user.fullname || req.user.email || '');
    return res.status(201).json({ ok: true, id, so_van_ban: so });
  } catch (e) { return res.status(500).json({ message: 'Lá»—i táº¡o sá»± kiá»‡n: ' + e.message }); }
});
app.get('/api/events/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡' });
  const event = eventGetById(id);
  if (!event) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y sá»± kiá»‡n' });
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃ´ng cÃ³ gÃ¬ cáº­p nháº­t.' });
  vals.push(id);
  const r = db.prepare(`UPDATE events SET ${sets.join(',')} WHERE id = ? AND deleted_at IS NULL`).run(...vals);
  if (!r.changes) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y sá»± kiá»‡n' });
  return res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t.' });
});
app.delete('/api/events/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃ´ng há»£p lá»‡' });
  db.prepare("UPDATE events SET deleted_at = datetime('now','localtime') WHERE id = ?").run(id);
  return res.json({ ok: true, message: 'ÄÃ£ xÃ³a sá»± kiá»‡n.' });
});
app.patch('/api/events/:id/status', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const to = eventNormStatus((req.body || {}).to_status);
  const note = String((req.body || {}).note || '').slice(0, 2000);
  const ev = eventGetById(id);
  if (!ev) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y sá»± kiá»‡n' });
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
  if (!eventGetById(id)) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y sá»± kiá»‡n' });
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
    if (err) return res.status(400).json({ message: 'Upload tháº¥t báº¡i' });
    const id = parseInt(req.params.id, 10);
    if (!eventGetById(id)) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y sá»± kiá»‡n' });
    const loai = String((req.body || {}).loai_file || 'khac');
    const moTa = (req.body || {}).mo_ta ? String(req.body.mo_ta).slice(0, 2000) : null;
    const out = [];
    for (const f of req.files || []) {
      const rel = path.join('uploads', 'events', String(id), f.filename).replace(/\\/g, '/');
      const tenFile = fixFilenameEncoding(f.originalname) || f.filename;
      const ins = db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, loai, tenFile, rel, moTa, req.user.fullname || req.user.email || '');
      out.push({ id: Number(ins.lastInsertRowid), ten_file: tenFile, duong_dan: rel, loai_file: loai });
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
  if (!row) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y file' });
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
      return res.status(400).json({ message: 'Thiáº¿u template Word: templates/events/to_trinh_xin_phep.docx. Vui lÃ²ng Ä‘áº·t Ä‘Ãºng file máº«u Ä‘á»ƒ xuáº¥t Ä‘Ãºng Ä‘á»‹nh dáº¡ng.' });
    }
    const id = parseInt(req.params.id, 10);
    const ev = eventGetById(id);
    if (!ev) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y sá»± kiá»‡n' });
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
    db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'to_trinh_xin_phep', fn, rel, 'Word tá» trÃ¬nh sinh tá»± Ä‘á»™ng', req.user.fullname || req.user.email || '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    setContentDisposition(res, fn);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ message: 'Lá»—i xuáº¥t Word: ' + e.message }); }
});
app.post('/api/events/:id/export/bao-cao', authMiddleware, coopPhongOrAdmin, async (req, res) => {
  try {
    const tpl = path.join(__dirname, 'templates', 'events', 'bao_cao_su_kien.docx');
    if (!fs.existsSync(tpl)) {
      return res.status(400).json({ message: 'Thiáº¿u template Word: templates/events/bao_cao_su_kien.docx. Vui lÃ²ng Ä‘áº·t Ä‘Ãºng file máº«u Ä‘á»ƒ xuáº¥t Ä‘Ãºng Ä‘á»‹nh dáº¡ng.' });
    }
    const id = parseInt(req.params.id, 10);
    const ev = eventGetById(id);
    if (!ev) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y sá»± kiá»‡n' });
    const sessions = eventGetSessions(id);
    const data = { tieu_de: ev.tieu_de || '', ngay_bat_dau: ev.ngay_bat_dau || '', ngay_ket_thuc: ev.ngay_ket_thuc || '', so_nguoi_tham_du_thuc_te: ev.so_nguoi_tham_du_thuc_te || '', ket_qua_su_kien: ev.ket_qua_su_kien || '', de_xuat_kien_nghi: ev.de_xuat_kien_nghi || '', bai_hoc_kinh_nghiem: ev.bai_hoc_kinh_nghiem || '', uu_diem: ev.uu_diem || '', han_che: ev.han_che || '', lich_trinh: sessions };
    const buf = await buildEventReportDocBuffer(data);
    const fn = 'bao_cao_su_kien_' + id + '_' + Date.now() + '.docx';
    const dir = path.join(uploadDir, 'events', String(id)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fn), buf);
    const rel = path.join('uploads', 'events', String(id), fn).replace(/\\/g, '/');
    db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'bao_cao_su_kien', fn, rel, 'Word bÃ¡o cÃ¡o sinh tá»± Ä‘á»™ng', req.user.fullname || req.user.email || '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    setContentDisposition(res, fn);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ message: 'Lá»—i xuáº¥t Word: ' + e.message }); }
});

// ============================================================
// ROUTE Má»šI â€” ADMIN: Sá»¬A/XÃ“A Äá»€ XUáº¤T
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
    if (!sets.length) return res.status(400).json({ message:'KhÃ´ng cÃ³ gÃ¬ cáº­p nháº­t.' });
    sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
    try {
      const r = db.prepare(`UPDATE ${tbl} SET ${sets.join(',')} WHERE id=?`).run(...vals);
      if (r.changes===0) return res.status(404).json({ message:'KhÃ´ng tÃ¬m tháº¥y.' });
      coopAddHistory(loai, id, 0, 'admin_edit', 'Admin chá»‰nh sá»­a', req.user, JSON.stringify(body));
      if (ep === 'mou' && String(body.status || '').toLowerCase() === 'da_duyet') {
        try {
          const gen = coopTryAutoGenerateMouVanBan(id);
          if (!gen.ok && gen.skipped === 'no_template') {
            console.warn('[mou] Admin Ä‘áº·t tráº¡ng thÃ¡i ÄÃ£ phÃª duyá»‡t nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng.');
          } else if (!gen.ok && gen.skipped === 'error') {
            console.error('[mou] Auto Word sau admin cáº­p nháº­t:', gen.message);
          }
        } catch (e) {}
      }
      return res.json({ ok:true, message:'ÄÃ£ cáº­p nháº­t.' });
    } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
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
      return res.json({ ok:true, message:'ÄÃ£ xÃ³a.' });
    } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
  });
});

// admin ytnn
app.put('/api/admin/cooperation/ytnn/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const { sets, vals } = coopAdminUpdateSetsFromBody(body, COOP_ADMIN_COLS_YTNN);
  if (!sets.length) return res.status(400).json({ message:'KhÃ´ng cÃ³ gÃ¬ cáº­p nháº­t.' });
  sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
  try {
    const r = db.prepare(`UPDATE htqt_de_xuat SET ${sets.join(',')} WHERE id=?`).run(...vals);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃ´ng tÃ¬m tháº¥y.' });
    coopAddHistory('ytnn', id, 0, 'admin_edit', 'Admin chá»‰nh sá»­a', req.user, JSON.stringify(body));
    if (String(body.status || '').toLowerCase() === 'da_duyet') {
      try {
        const gen = coopTryAutoGenerateYtnnVanBan(id);
        if (!gen.ok && gen.skipped === 'no_template') {
          console.warn('[ytnn] Admin Ä‘áº·t tráº¡ng thÃ¡i ÄÃ£ phÃª duyá»‡t nhÆ°ng chÆ°a cÃ³ máº«u Word trÃªn há»‡ thá»‘ng.');
        } else if (!gen.ok && gen.skipped === 'error') {
          console.error('[ytnn] Auto Word sau admin cáº­p nháº­t:', gen.message);
        }
      } catch (e) {}
    }
    return res.json({ ok:true, message:'ÄÃ£ cáº­p nháº­t.' });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});
app.delete('/api/admin/cooperation/ytnn/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (row) coopUnlinkYtnnVanBanFile(row);
    db.prepare('DELETE FROM htqt_de_xuat WHERE id=?').run(id);
    try { db.prepare('DELETE FROM coop_history WHERE loai=? AND de_xuat_id=?').run('ytnn', id); } catch(e) {}
    return res.json({ ok:true, message:'ÄÃ£ xÃ³a.' });
  } catch(e) { return res.status(500).json({ message:'Lá»—i: '+e.message }); }
});

// ============================================================
// HELPER: build title cho list view
// ============================================================
function coopBuildTitle(loai, r) {
  if (loai==='doan_ra') return `ÄoÃ n ra â€” ${r.quoc_gia||'â€”'}${r.muc_dich?' ('+r.muc_dich+')':''}`;
  if (loai==='doan_vao') return `ÄoÃ n vÃ o â€” ${r.muc_dich||r.don_vi_de_xuat||'â€”'}`;
  if (loai==='mou') return `MOU â€” ${r.ten_doi_tac||'â€”'}${r.quoc_gia?', '+r.quoc_gia:''}`;
  if (loai==='ytnn') return `Äá» tÃ i cÃ³ yáº¿u tá»‘ nÆ°á»›c ngoÃ i â€” ${r.ten||'â€”'}`;
  return 'â€”';
}

console.log('[Cooperation] âœ… CÃ¡c route Há»£p tÃ¡c Quá»‘c táº¿ má»›i Ä‘Ã£ Ä‘Æ°á»£c Ä‘Äƒng kÃ½.');
// TÃ­ch há»£p Sub-App Quáº£n lÃ½ Äá» tÃ i Cáº¥p Viá»‡n chuyÃªn biá»‡t táº¡i /de-tai-cap-vien/
require('./modules/de-tai-cap-vien/eofficeMount').mount(app, { db, jwt, JWT_SECRET, getTokenFromReq, userIdIsBanned, clearAuthCookie, userEmailIsMasterAdmin });
// LÆ°u Ã½: middleware 404 cho /api pháº£i Ä‘Äƒng kÃ½ SAU mountSciKhcnPublicationsRouters()
// (enrich, journal-metrics, â€¦). Náº¿u Ä‘áº·t trÆ°á»›c, má»i /api/enrich/* sáº½ 404.

// Serve dang-nhap.html vá»›i script inject: sau login redirect vá» trang pending
app.get('/dang-nhap.html', (req, res) => {
  const filePath = path.join(__dirname, 'dang-nhap.html');
  if (!fs.existsSync(filePath)) return res.status(404).send('KhÃ´ng tÃ¬m tháº¥y trang Ä‘Äƒng nháº­p');
  let html = fs.readFileSync(filePath, 'utf8');
  const injectScript = `
<script>
// HTQT Login Hook: sau khi Ä‘Äƒng nháº­p thÃ nh cÃ´ng, redirect vá» trang pending
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
  // Inject trÆ°á»›c </body>
  if (html.includes('</body>')) {
    html = html.replace('</body>', injectScript + '\n</body>');
  } else {
    html = html + injectScript;
  }
  res.type('html').send(html);
});

// Chá»‰ cho phÃ©p khÃ¡ch (chÆ°a Ä‘Äƒng nháº­p) xem trang chá»§ vÃ  cÃ¡c trang Ä‘Äƒng nháº­p/Ä‘Äƒng kÃ½/quÃªn máº­t kháº©u; cÃ¡c trang .html khÃ¡c cáº§n cookie JWT há»£p lá»‡.
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

/** ÄÆ°á»ng dáº«n khÃ´ng Ä‘uÃ´i .html â€” ÄÄƒng kÃ½ HN/HT */
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
      // vai trÃ² chá»‰ dÃ¹ng má»™t sá»‘ module (crd_user, sinh_vien): chá»‰ má»Ÿ cÃ¡c trang cá»§a module Ä‘Ã³ (services/vaiTroHanChe.js)
      if (!userIdIsBanned(payload0.id) && !vaiTroHanChe.trangHtmlDuocPhep(payload0.role, reqPath)) {
        return res.redirect(302, vaiTroHanChe.trangMacDinh(payload0.role));
      }
    } catch (e) {
      /* token lá»—i â€” xá»­ lÃ½ bÆ°á»›c dÆ°á»›i */
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

/** KhÃ´ng cho táº£i source / cáº¥u hÃ¬nh qua static (trÆ°á»›c Ä‘Ã¢y chá»‰ .html cÃ³ auth). */
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

/** Chart.js phá»¥c vá»¥ ná»™i bá»™: CSP chá»‰ cho script-src 'self', náº¡p tá»« CDN sáº½ bá»‹ cháº·n.
 *  GÃ³i npm chá»‰ cÃ³ dist/chart.umd.js (Ä‘Ã£ minify) â€” khÃ´ng cÃ³ chart.umd.min.js nhÆ° URL
 *  jsDelivr dÃ¹ng trÆ°á»›c Ä‘Ã¢y (jsDelivr tá»± minify khi file .min.js khÃ´ng tá»“n táº¡i). */
app.get('/public/vendor/chart.umd.js', (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  } catch (e) {
    return res.status(404).send('chart.js bundle not found');
  }
});

/** pdf.js phá»¥c vá»¥ ná»™i bá»™ (CSP chá»‰ cho script-src 'self'): chá»‰ hai tá»‡p dÃ¹ng Ä‘á»ƒ xem trÆ°á»›c PDF khi Ä‘áº·t khung chá»¯ kÃ½ sá»‘ (public/js/kysoViTri.js). */
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

  // Giá»›i háº¡n tá»•ng thá»i gian spawnSync Ä‘á»ƒ khÃ´ng cháº·n app.listen vÃ´ háº¡n náº¿u npm treo
  // (máº¡ng cháº­m, lockfile há»ng, postinstall hook stuck). QuÃ¡ giá» -> SIGTERM child, server
  // váº«n khá»Ÿi Ä‘á»™ng Ä‘Æ°á»£c vá»›i bundle cÅ© (náº¿u cÃ³) thay vÃ¬ zombie khÃ´ng listen.
  const DEFAULT_AUTO_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
  const parsedTimeout = Number.parseInt(String(process.env.ADMIN_UI_AUTO_BUILD_TIMEOUT_MS || ''), 10);
  const perStepTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_AUTO_BUILD_TIMEOUT_MS;
  const fmtTimeout = `${Math.round(perStepTimeoutMs / 1000)}s`;

  console.log(
    `[ADMIN UI] ${triggerReason || 'dist missing'} -> attempting auto build (npm install + npm run build; timeout=${fmtTimeout}/step)`
  );

  function describeSpawnFailure(label, result) {
    if (result && result.signal) return `${label}: process bá»‹ kill bá»Ÿi ${result.signal} (cÃ³ thá»ƒ do timeout=${fmtTimeout})`;
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
 * So sÃ¡nh mtime cá»§a thÆ° má»¥c source React vá»›i dist/index.html Ä‘á»ƒ nháº­n biáº¿t khi
 * ngÆ°á»i váº­n hÃ nh Ä‘Ã£ `git pull` code má»›i nhÆ°ng chÆ°a rebuild bundle. Náº¿u phÃ¡t hiá»‡n
 * source má»›i hÆ¡n dist thÃ¬ tá»± Ä‘á»™ng rebuild khi khá»Ÿi Ä‘á»™ng (trá»« khi táº¯t báº±ng env).
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
// Public status endpoint (khÃ´ng Ä‘i qua namespace /api Ä‘á»ƒ trÃ¡nh bá»‹ auth middleware cháº·n).
app.get('/admin-ui-status', (req, res) => {
  return sendAdminUiStatus(res);
});
// Giá»¯ endpoint cÅ© Ä‘á»ƒ tÆ°Æ¡ng thÃ­ch náº¿u mÃ´i trÆ°á»ng khÃ´ng cháº·n /api.
app.get('/api/admin-ui-status', (req, res) => {
  return sendAdminUiStatus(res);
});

app.use(
  express.static(__dirname, {
    /** Táº¯t ETag/Last-Modified â€” náº¿u khÃ´ng, trÃ¬nh duyá»‡t váº«n nháº­n 304 dÃ¹ cÃ³ Cache-Control (file HTML cÅ©). */
    etag: false,
    lastModified: false,
    /** TrÃ¡nh cache HTML; cÃ¡c file khÃ¡c váº«n táº£i láº¡i Ä‘áº§y Ä‘á»§ khi khÃ´ng cÃ²n 304. */
    setHeaders(res, filePath) {
      const lower = String(filePath || '').toLowerCase().replace(/\\/g, '/');
      // CÃ¡c file JS cá»§a module DMS Ä‘ang sá»­a Ä‘á»•i thÆ°á»ng xuyÃªn â€” náº¿u cache nhÆ° file tÄ©nh thÃ´ng
      // thÆ°á»ng, trÃ¬nh duyá»‡t cÃ³ thá»ƒ cháº¡y báº£n cÅ© dÃ¹ HTML Ä‘Ã£ táº£i báº£n má»›i (tab/nÃºt má»›i hiá»‡n ra
      // nhÆ°ng báº¥m khÃ´ng pháº£n á»©ng vÃ¬ JS xá»­ lÃ½ váº«n lÃ  báº£n trÆ°á»›c Ä‘Ã³).
      const isNoCacheJs = /\/js\/dms-(records-app|admin-page)\.js$/.test(lower);
      if (lower.endsWith('.html') || isNoCacheJs) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  })
);

/** Äá»§ Ä‘iá»u kiá»‡n nháº¯c: â‰¥3 ngÃ y ká»ƒ tá»« cáº­p nháº­t há»“ sÆ¡; láº§n nháº¯c sau cÃ¡ch láº§n trÆ°á»›c â‰¥3 ngÃ y (chá»‰ gá»­i ná»™i bá»™, khÃ´ng hiá»‡n cho ngÆ°á»i ná»™p Ä‘á» xuáº¥t). */
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

/** Nháº¯c email theo tá»«ng há»“ sÆ¡ tá»›i PhÃ²ng KHCN hoáº·c Viá»‡n trÆ°á»Ÿng (tÃ¹y bÆ°á»›c Ä‘ang treo). */
function sendCoopStaleStepReminders() {
  if (!transporter) return;
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const moduleUrl = baseUrl + '/module-hoatac-quocte.html';
  const cfg = [
    { table: 'cooperation_doan_ra', topic: 'doan_ra', label: 'ÄoÃ n ra',
      phongStatuses: ['cho_phong_duyet'],
      vtStatuses: ['cho_vt_duyet'] },
    { table: 'cooperation_doan_vao', topic: 'doan_vao', label: 'ÄoÃ n vÃ o',
      phongStatuses: ['cho_phong_duyet', 'cho_tham_dinh', 'dang_tham_dinh'],
      vtStatuses: ['cho_vt_duyet', 'cho_ky_duyet'] },
    { table: 'cooperation_mou_de_xuat', topic: 'mou', label: 'Thá»a thuáº­n/MOU',
      phongStatuses: ['cho_phong_duyet', 'dang_tham_dinh'],
      vtStatuses: ['cho_vt_duyet'] },
    { table: 'htqt_de_xuat', topic: 'ytnn', label: 'Äá» tÃ i YTNN',
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
      const stepLabel = waitPhong ? 'chá» PhÃ²ng KHCN&QHÄN tháº©m Ä‘á»‹nh / xá»­ lÃ½' : 'chá» Viá»‡n trÆ°á»Ÿng phÃª duyá»‡t';
      const subject = `[HTQT â€” ná»™i bá»™] Nháº¯c xá»­ lÃ½: ${T.label} ${ma} â€” ${waitPhong ? 'PhÃ²ng KHCN' : 'Viá»‡n trÆ°á»Ÿng'}`;
      const intro = `KÃ­nh gá»­i QuÃ½ Ã”ng/BÃ ,<br/><br/>Há»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c xin nháº¯c (ná»™i bá»™): Ä‘á» xuáº¥t <strong>${coopEscHtml(T.label)}</strong>, mÃ£ <strong>${coopEscHtml(ma)}</strong>, hiá»‡n <strong>${stepLabel}</strong>. Äá» nghá»‹ xem xÃ©t xá»­ lÃ½ theo quy Ä‘á»‹nh.`;
      const stLabel = STATUS_LABELS_COOP[st] || st;
      const html = coopBuildEmail('Nháº¯c xá»­ lÃ½ Ä‘á» xuáº¥t (ná»™i bá»™)', intro, [['MÃ£', ma], ['Tráº¡ng thÃ¡i', stLabel]], 'TrÃ¢n trá»ng,<br/>Há»‡ thá»‘ng Quáº£n lÃ½ Há»£p tÃ¡c Quá»‘c táº¿ â€” Viá»‡n Táº¿ bÃ o gá»‘c', moduleUrl);
      const text = `KÃ­nh gá»­i,\n\nNháº¯c ná»™i bá»™ xá»­ lÃ½: ${T.label} â€” mÃ£ ${ma}.\nTráº¡ng thÃ¡i: ${stLabel}.\n${moduleUrl}\n`;
      coopSendMail({ to, subject, html, text })
        .then(() => {
          try {
            db.prepare(`UPDATE ${T.table} SET coop_reminder_last_at = datetime('now') WHERE id = ?`).run(row.id);
          } catch (e2) { console.error('[CoopReminder] Lá»—i cáº­p nháº­t:', e2.message); }
        })
        .catch(err => console.error('[CoopReminder] Gá»­i lá»—i:', err.message));
    }
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
setInterval(sendCoopStaleStepReminders, ONE_DAY_MS);
setTimeout(sendCoopStaleStepReminders, 60 * 60 * 1000);

/** Nháº¯c ná»™p minh chá»©ng HN/HT: sau conf_end_date + 15 ngÃ y, gá»­i má»™t láº§n (evidence_reminder_sent_at). Cháº¡y khi giá» mÃ¡y chá»§ = 8. */
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
            console.error('[HNHT reminder] Lá»—i cáº­p nháº­t:', e2.message);
          }
        })
        .catch((err) => console.error('[HNHT reminder] Gá»­i lá»—i:', err.message));
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
      if (r && r.sent > 0) console.log('[ThoaThuanExpiry] HoÃ n táº¥t: Ä‘Ã£ gá»­i', r.sent, 'email.');
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
        message: 'Enrichment hoÃ n táº¥t',
        stats,
      });
    } catch (e) {
      console.error('[enrich/trigger]', e);
      return res.status(500).json({ message: 'Lá»—i enrichment' });
    }
  });

  app.get('/api/enrich/stats', authMiddleware, async (req, res) => {
    try {
      const stats = await enrichService.getEnrichmentStats();
      return res.json(stats);
    } catch (e) {
      console.error('[enrich/stats]', e);
      return res.status(500).json({ message: 'Lá»—i thá»‘ng kÃª enrichment' });
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
        if (err) return res.status(400).json({ message: 'Upload tháº¥t báº¡i' });
        next();
      });
    },
    async (req, res) => {
      try {
        const year = parseInt(req.body?.year, 10);
        if (!Number.isFinite(year) || year < 1900 || year > 2100) {
          return res.status(400).json({ message: 'NÄƒm SJR khÃ´ng há»£p lá»‡ (1900â€“2100)' });
        }
        const buf = req.file?.buffer;
        if (!buf || !buf.length) {
          return res.status(400).json({ message: 'Vui lÃ²ng chá»n file CSV (tÃªn field: file)' });
        }
        const csvText = buf.toString('utf8');
        const result = await importScimagoCsvToJournalMetrics(db, csvText, year);
        return res.json({
          message: `Import SJR ${year}: ${result.ok} dÃ²ng OK, ${result.fail} lá»—i/bá» qua (tá»•ng ${result.total} dÃ²ng CSV)`,
          ...result,
        });
      } catch (e) {
        console.error('[sjr-csv-import]', e);
        return res.status(500).json({ message: 'Lá»—i import SJR' });
      }
    }
  );

  app.post('/api/admin/journal-metrics/update-if', authMiddleware, adminOnly, (req, res) => {
    try {
      const issnNorm = normalizeIssnJournalMetricsInput(req.body?.issn);
      if (!issnNorm || !/^\d{4}-[\dX]{4}$/i.test(issnNorm)) {
        return res.status(400).json({ message: 'ISSN pháº£i Ä‘Ãºng Ä‘á»‹nh dáº¡ng XXXX-XXXX' });
      }
      const year = parseInt(req.body?.year, 10);
      if (!Number.isFinite(year) || year < 1900 || year > 2100) {
        return res.status(400).json({ message: 'NÄƒm khÃ´ng há»£p lá»‡ (1900â€“2100)' });
      }
      const jcrIf = Number(req.body?.jcr_if);
      if (!Number.isFinite(jcrIf) || jcrIf <= 0) {
        return res.status(400).json({ message: 'jcr_if pháº£i lÃ  sá»‘ dÆ°Æ¡ng' });
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
          message: 'KhÃ´ng tÃ¬m tháº¥y báº£n ghi journal_metrics khá»›p ISSN vÃ  nÄƒm SJR',
        });
      }
      return res.json({ ok: true, message: 'ÄÃ£ cáº­p nháº­t JCR IF', changes });
    } catch (e) {
      console.error('[journal-metrics/update-if]', e);
      return res.status(500).json({ message: 'Lá»—i CSDL' });
    }
  });

  // CÃ´ng bá»‘ khoa há»c â€” 5 endpoint bá»• sung Ä‘Ã£ tÃ¡ch sang routes/publications/boSung.js.
  // PHáº¢I mount trÆ°á»›c app.use('/api/publications', pubMod.publicationsRouter) Ä‘á»ƒ khÃ´ng bá»‹ :id nuá»‘t.
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

  // â”€â”€ CÃ´ng táº¯c Harvest (báº­t/táº¯t tá»« giao diá»‡n) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Nguá»“n sá»± tháº­t Ä‘áº·t táº¡i Ä‘Ã¢y (sci-ace.db) chá»© khÃ´ng á»Ÿ module con: module con
  // dÃ¹ng DB riÃªng (sci_khcn.db), trong khi cÃ´ng táº¯c pháº£i cháº·n Ä‘Æ°á»£c cáº£ hai lá»‘i
  // vÃ o â€” POST /api/orcid/harvest vÃ  GET /api/orcid/harvest/stream (SSE).
  // Máº·c Ä‘á»‹nh Táº®T: sau khi deploy hoáº·c khá»Ÿi Ä‘á»™ng láº¡i, harvest khÃ´ng tá»± cháº¡y.
  const ORCID_HARVEST_KEY = 'orcid_harvest_enabled';

  function isOrcidHarvestEnabled() {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(ORCID_HARVEST_KEY);
      return !!row && String(row.value) === '1';
    } catch (e) {
      // KhÃ´ng Ä‘á»c Ä‘Æ°á»£c tráº¡ng thÃ¡i â†’ coi nhÆ° táº¯t; an toÃ n hÆ¡n lÃ  Ä‘á»ƒ cháº¡y ngoÃ i kiá»ƒm soÃ¡t.
      console.error('[orcid-harvest] KhÃ´ng Ä‘á»c Ä‘Æ°á»£c cÃ´ng táº¯c:', e && e.message ? e.message : e);
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
      console.error('[orcid-harvest] KhÃ´ng lÆ°u Ä‘Æ°á»£c cÃ´ng táº¯c:', e && e.message ? e.message : e);
      return res.status(500).json({ ok: false, message: 'KhÃ´ng lÆ°u Ä‘Æ°á»£c tráº¡ng thÃ¡i Harvest.' });
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
      `[orcid-harvest] ${enabled ? 'Báº¬T' : 'Táº®T'} bá»Ÿi ${(req.user && req.user.email) || 'khÃ´ng rÃµ'}`
    );
    return res.json({ ok: true, enabled });
  });

  // Cháº·n khi cÃ´ng táº¯c táº¯t. ÄÄƒng kÃ½ theo Ä‘Ãºng tá»«ng route (khÃ´ng dÃ¹ng tiá»n tá»‘
  // '/api/orcid/harvest') Ä‘á»ƒ khÃ´ng vÃ´ tÃ¬nh cháº·n luÃ´n hai route /enabled á»Ÿ trÃªn.
  function requireHarvestEnabled(req, res, next) {
    if (isOrcidHarvestEnabled()) return next();
    const message = 'Chá»©c nÄƒng Harvest Ä‘ang Táº®T. Báº­t cÃ´ng táº¯c á»Ÿ trang ORCID Auto-Harvest trÆ°á»›c khi quÃ©t.';
    // SSE: client lÃ  EventSource, chá»‰ hiá»ƒu Ä‘Æ°á»£c thÃ´ng bÃ¡o qua chÃ­nh luá»“ng sá»± kiá»‡n.
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

  // Khá»‘i "Quáº£n lÃ½ nghiÃªn cá»©u viÃªn (ORCID)" vÃ  "Duyá»‡t import" trÃªn trang Quáº£n lÃ½
  // cÃ´ng bá»‘ lÃ  thao tÃ¡c cá»§a riÃªng Admin. Router con (module sci-khcn-publications)
  // khÃ´ng cÃ³ lá»›p phÃ¢n quyá»n nÃ o, nÃªn cháº·n táº¡i Ä‘Ã¢y TRÆ¯á»šC khi mount â€” giao diá»‡n Ä‘Ã£
  // áº©n báº±ng .pub-admin-only, nhÆ°ng lá»›p áº©n Ä‘Ã³ dá»±a trÃªn localStorage nÃªn khÃ´ng Ä‘á»§.
  // Chá»‰ khoÃ¡ thao tÃ¡c GHI; GET danh sÃ¡ch váº«n Ä‘á»ƒ nguyÃªn cho trang Auto-Harvest.
  app.post('/api/orcid/researchers', authMiddleware, masterAdminOnly);
  app.delete('/api/orcid/researchers/:id', authMiddleware, masterAdminOnly);
  app.post('/api/orcid/queue/:id/approve', authMiddleware, adminOnly);
  app.post('/api/orcid/queue/:id/reject', authMiddleware, adminOnly);
  app.post('/api/orcid/queue/approve-all', authMiddleware, adminOnly);

  app.use('/api/orcid', orcidMod.orcidRouter);
  app.use('/api/doi', doiMod.doiRouter);
  console.log('[SCI-KHCN] ÄÃ£ mount /api/publications, /api/orcid, /api/doi');
}

(async () => {
  try {
    await mountSciKhcnPublicationsRouters();
  } catch (e) {
    console.error('[SCI-KHCN] KhÃ´ng mount Ä‘Æ°á»£c publications module:', e.message);
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
        'KhÃ´ng tÃ¬m tháº¥y API: ' +
        req.method +
        ' ' +
        p +
        '. Náº¿u vá»«a cáº­p nháº­t code, hÃ£y khá»Ÿi Ä‘á»™ng láº¡i server (Ctrl+C rá»“i node server.js).',
    });
  });

  const bindHost =
    process.env.BIND_HOST != null && String(process.env.BIND_HOST).trim() !== ''
      ? String(process.env.BIND_HOST).trim()
      : undefined;
  function onListen() {
    const hostLabel = bindHost || '(máº·c Ä‘á»‹nh Node)';
    console.log('SCI-ACE server láº¯ng nghe PORT=' + PORT + ' host=' + hostLabel);
    console.log('Kiá»ƒm tra káº¿t ná»‘i: http://127.0.0.1:' + PORT + '/api/health');
    console.log(`[clock] TZ=${process.env.TZ} (Vietnam civil time / ICT; override with TZ in .env)`);
    logServerTimeDriftVsGoogle();
    if (transporter) console.log('SMTP Ä‘Ã£ cáº¥u hÃ¬nh â€” email thÃ´ng bÃ¡o sáº½ gá»­i khi cÃ³ sá»± kiá»‡n (ná»™p há»“ sÆ¡, yÃªu cáº§u bá»• sung, káº¿t quáº£ há»p...)');
    else console.log('ChÆ°a cáº¥u hÃ¬nh SMTP â€” kiá»ƒm tra file .env (SMTP_HOST, SMTP_USER, SMTP_PASS). Email thÃ´ng bÃ¡o sáº½ khÃ´ng gá»­i.');
    console.log('Email nháº¯c nhá»Ÿ duyá»‡t Ä‘á» xuáº¥t: má»—i 3 ngÃ y (phong cÃ¡ch hÃ nh chÃ­nh nhÃ  nÆ°á»›c)');
    try {
      startWorker();
    } catch (e) {
      console.error('[EnrichWorker] KhÃ´ng khá»Ÿi Ä‘á»™ng Ä‘Æ°á»£c:', e.message || e);
    }
  }
  const httpServer = bindHost ? app.listen(PORT, bindHost, onListen) : app.listen(PORT, onListen);
  // Xá»­ lÃ½ tÆ°á»ng minh lá»—i bind (EADDRINUSE, EACCES...): log + exit(1) Ä‘á»ƒ PM2/systemd
  // restart sáº¡ch, trÃ¡nh tráº¡ng thÃ¡i zombie "process cÃ²n sá»‘ng nhÆ°ng khÃ´ng listen"
  // do uncaughtException handler máº·c Ä‘á»‹nh chá»‰ log.
  httpServer.on('error', (err) => {
    const code = err && err.code ? err.code : '(unknown-code)';
    if (code === 'EADDRINUSE') {
      console.error(
        `[FATAL] KhÃ´ng bind Ä‘Æ°á»£c PORT=${PORT} (EADDRINUSE): má»™t tiáº¿n trÃ¬nh khÃ¡c Ä‘Ã£ chiáº¿m port.\n` +
          `        Kill tiáº¿n trÃ¬nh cÅ© rá»“i thá»­ láº¡i. TrÃªn Windows: netstat -ano | findstr :${PORT}\n` +
          `        TrÃªn Linux: lsof -i :${PORT}`
      );
    } else if (code === 'EACCES') {
      console.error(
        `[FATAL] KhÃ´ng cÃ³ quyá»n bind PORT=${PORT} (EACCES). DÃ¹ng port >1024 hoáº·c cháº¡y vá»›i quyá»n phÃ¹ há»£p.`
      );
    } else {
      console.error('[FATAL] app.listen error:', code, err && err.stack ? err.stack : err);
    }
    process.exit(1);
  });
})();
