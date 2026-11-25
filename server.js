/**
 * Backend SCI-ACE
 * - Ã„ÂÃ„Æ’ng kÃƒÂ½ (@sci.edu.vn) + Ã„â€˜Ã„Æ’ng kÃƒÂ½ chÃ¡Â»â€° module CRD (mÃ¡Â»Âi email khÃƒÂ¡c, role crd_user)
 * - NÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ (upload), gÃ¡Â»Â­i email thÃƒÂ´ng bÃƒÂ¡o HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
 * - HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng xem/tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡
 * - Master Admin = tÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p cÃƒÂ³ email trÃƒÂ¹ng ADMIN_EMAIL (hÃ¡ÂºÂ±ng sÃ¡Â»â€˜ trong file). CÃ¡ÂºÂ¥p/gÃ¡Â»Â¡ vai trÃƒÂ² Admin; Admin phÃ¡Â»Â¥: quyÃ¡Â»Ân admin API nhÃ†Â°ng khÃƒÂ´ng cÃ¡ÂºÂ¥p/gÃ¡Â»Â¡ Admin.
 * 
 * Database: HÃ¡Â»â€” trÃ¡Â»Â£ SQLite (local) vÃƒÂ  Turso (Cloudflare)
 * - Local: SÃ¡Â»Â­ dÃ¡Â»Â¥ng better-sqlite3
 * - Cloudflare: SÃ¡Â»Â­ dÃ¡Â»Â¥ng @libsql/client qua ./lib/db-bridge.js
 */
try { require('dotenv').config({ path: '.env' }); } catch (_) {}
/**
 * Civil time for Vietnam (ICT, UTC+7, no DST). Matches how Google services show "local time" for VN.
 * Set TZ in .env to override. Does not replace OS NTP Ã¢â‚¬â€ sync the host clock if drift is large.
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

// Database - tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng chÃ¡Â»Ân SQLite hoÃ¡ÂºÂ·c Turso dÃ¡Â»Â±a trÃƒÂªn .env
// SÃ¡Â»Â­ dÃ¡Â»Â¥ng ./lib/db-bridge.js thay vÃƒÂ¬ better-sqlite3 trÃ¡Â»Â±c tiÃ¡ÂºÂ¿p
const db = require('./lib/db-bridge');
const {
  CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
  isAllowedTaskCode,
} = require('./lib/capVienPublicTemplatesCatalog');

const app = express();
const PORT = process.env.PORT || 3000;

const BYTES_PER_MB = 1024 * 1024;
/** application/json Ã¢â‚¬â€ khÃƒÂ´ng ÃƒÂ¡p dÃ¡Â»Â¥ng multipart/form-data (multer tÃ¡Â»Â± Ã„â€˜Ã¡Â»Âc stream, khÃƒÂ´ng qua express.json). */
const BODY_JSON_LIMIT_STR =
  process.env.BODY_JSON_LIMIT != null && String(process.env.BODY_JSON_LIMIT).trim() !== ''
    ? String(process.env.BODY_JSON_LIMIT).trim()
    : '12mb';
/** KÃƒÂ­ch thÃ†Â°Ã¡Â»â€ºc tÃ¡Â»Â«ng file upload (multipart). Ã„ÂÃ¡Â»â„¢c lÃ¡ÂºÂ­p vÃ¡Â»â€ºi BODY_JSON_LIMIT_STR. */
const UPLOAD_FILE_BYTES_SUBMISSION = 20 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_SJR_CSV = 60 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_CAP_PUBLIC_TEMPLATE = 80 * BYTES_PER_MB;
const UPLOAD_FILE_BYTES_CAP_VIEN = 200 * BYTES_PER_MB;
/** TrÃ†Â°Ã¡Â»Âng text khÃƒÂ´ng phÃ¡ÂºÂ£i file trong multipart (mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh multer 1MB). Ã„ÂÃ¡Â»â€œng bÃ¡Â»â„¢ mÃ¡Â»Â©c vÃ¡Â»â€ºi body JSON mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh. */
const MULTIPART_MAX_FIELD_BYTES = 12 * BYTES_PER_MB;

// Sau reverse proxy (Nginx/Traefik) trÃƒÂªn Ubuntu/container: TRUST_PROXY=1 Ã„â€˜Ã¡Â»Æ’ req.ip / req.secure Ã„â€˜ÃƒÂºng
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

// LÃ¡Â»â€”i khÃƒÂ´ng bÃ¡ÂºÂ¯t Ã„â€˜Ã†Â°Ã¡Â»Â£c trong async / callback Ã¢â‚¬â€ log Ã„â€˜Ã¡Â»Æ’ vÃ¡ÂºÂ­n hÃƒÂ nh (PM2/Docker) cÃƒÂ²n dÃ¡ÂºÂ¥u vÃ¡ÂºÂ¿t.
// uncaughtException: trÃ¡ÂºÂ¡ng thÃƒÂ¡i process khÃƒÂ´ng an toÃƒÂ n; nhiÃ¡Â»Âu nÃ†Â¡i gÃ¡Â»Âi process.exit(1) sau log Ã„â€˜Ã¡Â»Æ’ tiÃ¡ÂºÂ¿n trÃƒÂ¬nh giÃƒÂ¡m sÃƒÂ¡t tÃ¡Â»Â± restart.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.stack || reason : reason);
});

// GiÃ¡Â»â€ºi hÃ¡ÂºÂ¡n tÃ¡Â»â€˜c Ã„â€˜Ã¡Â»â„¢ toÃƒÂ n bÃ¡Â»â„¢ /api/* trÃ†Â°Ã¡Â»â€ºc express.json Ã¢â‚¬â€ giÃ¡ÂºÂ£m nguy cÃ†Â¡ flood body JSON (RAM/CPU).
(function mountApiRateLimitEarly() {
  const windowMs = Math.max(1000, parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '900000', 10) || 900000);
  const max = Math.max(1, parseInt(process.env.API_RATE_LIMIT_MAX || '400', 10) || 400);
  function getRateLimitKey(req) {
    // Ã†Â¯u tiÃƒÂªn tÃƒÂ¡ch theo user Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh dÃ¡Â»â€œn toÃƒÂ n bÃ¡Â»â„¢ request theo 1 IP/proxy.
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

    // Fallback cho khÃƒÂ¡ch chÃ†Â°a Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p: dÃƒÂ¹ng IP (Ã†Â°u tiÃƒÂªn IP client tÃ¡Â»Â« proxy nÃ¡ÂºÂ¿u cÃƒÂ³).
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
    message: { message: 'QuÃƒÂ¡ nhiÃ¡Â»Âu yÃƒÂªu cÃ¡ÂºÂ§u tÃ¡Â»â€ºi API, vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' },
  });
  app.use('/api', apiRateLimiter);
})();

// Route kiÃ¡Â»Æ’m tra sÃ¡Â»â€ºm nhÃ¡ÂºÂ¥t (trÃ†Â°Ã¡Â»â€ºc middleware)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend Ã„â€˜ang chÃ¡ÂºÂ¡y' });
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
          `[clock] OS clock differs from Google HTTP Date by ~${skewSec}s. Sync system time (Windows: Settings Ã¢â€ â€™ Time & language) or NTP. Application TZ=${process.env.TZ}`
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

// Favicon: trÃ¡ÂºÂ£ 204 Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh 404 trong Console khi trÃƒÂ¬nh duyÃ¡Â»â€¡t tÃ¡Â»Â± gÃ¡Â»Âi /favicon.ico
app.get('/favicon.ico', (req, res) => {
  const favPath = path.join(__dirname, 'favicon.ico');
  if (fs.existsSync(favPath)) return res.sendFile(favPath);
  res.status(204).end();
});

// Route phÃ¡Â»Â¥c vÃ¡Â»Â¥ logo (Ã„â€˜Ã†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n tuyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»â€˜i, trÃƒÂ¡nh lÃ¡Â»â€”i khi mÃ¡Â»Å¸ qua server)
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
  console.error('[FATAL] JWT_SECRET chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥u hÃƒÂ¬nh trong mÃƒÂ´i trÃ†Â°Ã¡Â»Âng (.env hoÃ¡ÂºÂ·c biÃ¡ÂºÂ¿n hÃ¡Â»â€¡ thÃ¡Â»â€˜ng). DÃ¡Â»Â«ng Ã¡Â»Â©ng dÃ¡Â»Â¥ng.');
  process.exit(1);
}
const ALLOWED_EMAIL_DOMAIN = '@sci.edu.vn';
/**
 * KiÃ¡Â»Æ’m tra Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng email an toÃƒÂ n trÃ†Â°Ã¡Â»â€ºc khi lÃ†Â°u vÃƒÂ o users.email Ã¢â‚¬â€ chÃ¡ÂºÂ·n khoÃ¡ÂºÂ£ng trÃ¡ÂºÂ¯ng/kÃƒÂ½ tÃ¡Â»Â± Ã„â€˜iÃ¡Â»Âu
 * khiÃ¡Â»Æ’n (\r \n \t...) Ã„â€˜Ã¡Â»Æ’ email khÃƒÂ´ng thÃ¡Â»Æ’ dÃƒÂ¹ng lÃƒÂ m vector chÃƒÂ¨n header khi truyÃ¡Â»Ân cho nodemailer
 * (CRLF/SMTP header injection), vÃƒÂ¬ email lÃ†Â°u trong DB sÃ¡ÂºÂ½ Ã„â€˜Ã†Â°Ã¡Â»Â£c dÃƒÂ¹ng lÃ¡ÂºÂ¡i Ã¡Â»Å¸ rÃ¡ÂºÂ¥t nhiÃ¡Â»Âu chÃ¡Â»â€” gÃ¡Â»Â­i mail.
 */
function isSafeEmailFormat(str) {
  const s = String(str || '');
  if (s.length > 190) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}
/** ChÃ¡Â»â€° dÃƒÂ¹ng Ã„â€˜Ã¡ÂºÂ·t lÃ¡Â»â€¹ch thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹ CRD Ã¢â‚¬â€ JWT cÃƒÂ³ role nÃƒÂ y chÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡Â»Âi /api/crd/* (+ me, logout, health). */
const CRD_ONLY_USER_ROLE = 'crd_user';
/** GiÃƒÂ¡ trÃ¡Â»â€¹ Ã„â€˜Ã¡ÂºÂ·c biÃ¡Â»â€¡t: tin nhÃ¡ÂºÂ¯n gÃ¡Â»Â­i tÃ¡Â»â€ºi mÃ¡Â»Âi ngÃ†Â°Ã¡Â»Âi trong module CRD (kÃƒÂªnh chung). */
const CRD_BROADCAST_TO_ID = '__crd_broadcast__';
/** Email Master Admin (nhÃƒÂ  phÃƒÂ¡t triÃ¡Â»Æ’n): toÃƒÂ n quyÃ¡Â»Ân cÃ¡ÂºÂ¥p / gÃ¡Â»Â¡ vai trÃƒÂ² Admin. Admin khÃƒÂ¡c chÃ¡Â»â€° lÃƒÂ  Admin thÃ†Â°Ã¡Â»Âng. */
const ADMIN_EMAIL = 'ntsinh0409@gmail.com';

// Database Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c khÃ¡Â»Å¸i tÃ¡ÂºÂ¡o tÃ¡Â»Â« ./lib/db-bridge.js (dÃƒÂ²ng trÃƒÂªn)
// db-bridge tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng chÃ¡Â»Ân SQLite (local) hoÃ¡ÂºÂ·c Turso (Cloudflare) dÃ¡Â»Â±a trÃƒÂªn DATABASE_URL trong .env

// ThÃ†Â° mÃ¡Â»Â¥c dÃ¡Â»Â¯ liÃ¡Â»â€¡u (DB + upload): mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh cÃ¡ÂºÂ¡nh code; production Ã„â€˜Ã¡ÂºÂ·t APP_DATA_DIR Ã„â€˜Ã¡Â»Æ’ tÃƒÂ¡ch khÃ¡Â»Âi mÃƒÂ£ nguÃ¡Â»â€œn
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

// --- GiÃ¡Â»â€ºi hÃ¡ÂºÂ¡n Ã„â€˜Ã†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n khi xÃƒÂ³a file/thÃ†Â° mÃ¡Â»Â¥c (chÃ¡Â»â€˜ng path traversal / xÃƒÂ³a nhÃ¡ÂºÂ§m mÃƒÂ£ nguÃ¡Â»â€œn) ---
const RESOLVED_UPLOADS_ROOT = path.resolve(uploadDir);
const RESOLVED_CAP_VIEN_UPLOADS_ROOT = path.resolve(uploadDirCapVien);

/**
 * ChuÃ¡Â»â€”i Ã„â€˜Ã†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n lÃ†Â°u trong CSDL Ã¢â€ â€™ file thÃ¡ÂºÂ­t trÃƒÂªn Ã„â€˜Ã„Â©a.
 * HÃ¡Â»â€” trÃ¡Â»Â£ tiÃ¡Â»Ân tÃ¡Â»â€˜ uploads/ vÃƒÂ  uploads-cap-vien/ (cÃ…Â©: relative tÃ¡Â»Â« thÃ†Â° mÃ¡Â»Â¥c code).
 * LÃ†Â°u ÃƒÂ½: bÃ¡ÂºÂ£n cÃ…Â© dÃƒÂ¹ng path.relative(__dirname, file) nÃƒÂªn cÃƒÂ³ thÃ¡Â»Æ’ lÃƒÂ 
 * "data/uploads-cap-vien/..." Ã¢â‚¬â€ phÃ¡ÂºÂ£i nhÃ¡ÂºÂ­n diÃ¡Â»â€¡n uploads-cap-vien/ Ã¡Â»Å¸ bÃ¡ÂºÂ¥t kÃ¡Â»Â³ vÃ¡Â»â€¹ trÃƒÂ­ nÃƒÂ o trong chuÃ¡Â»â€”i.
 * TÃ†Â°Ã†Â¡ng tÃ¡Â»Â± vÃ¡Â»â€ºi uploads/ (vd. data/uploads/htqt-...) khi APP_DATA_DIR tÃƒÂ¡ch khÃ¡Â»Âi thÃ†Â° mÃ¡Â»Â¥c code.
 * - uploads-cap-vien: cÃƒÂ³ thÃ¡Â»Æ’ xuÃ¡ÂºÂ¥t hiÃ¡Â»â€¡n Ã¡Â»Å¸ Ã„â€˜Ã¡ÂºÂ§u chuÃ¡Â»â€”i hoÃ¡ÂºÂ·c sau ../ (code /opt/app, file Ã¡Â»Å¸ APP_DATA_DIR).
 * - public-templates/...: lÃ†Â°u mÃ¡Â»â€ºi (relative tÃ¡Â»â€ºi uploads-cap-vien).
 * - uploads/: thÃ†Â° mÃ¡Â»Â¥c upload chung (missions, htqt, Ã¢â‚¬Â¦).
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
  // Legacy: mÃ¡Â»â„¢t sÃ¡Â»â€˜ bÃ¡ÂºÂ£n ghi sai chÃ¡Â»â€° cÃƒÂ²n nhÃƒÂ¡nh public-templates/... (resolve cÃ…Â© gÃ¡ÂºÂ¯n nhÃ¡ÂºÂ§m uploads/)
  if (n.startsWith('public-templates/')) {
    return path.normalize(path.resolve(uploadDirCapVien, n));
  }

  if (n.startsWith('uploads/')) {
    return path.normalize(path.resolve(uploadDir, n.slice('uploads/'.length)));
  }
  return path.normalize(path.resolve(uploadDir, n));
}

/** File vÃ¡Â»Â«a ghi dÃ†Â°Ã¡Â»â€ºi uploadDir Ã¢â€ â€™ chuÃ¡Â»â€”i lÃ†Â°u CSDL dÃ¡ÂºÂ¡ng uploads/... (khÃƒÂ´ng phÃ¡Â»Â¥ thuÃ¡Â»â„¢c __dirname / APP_DATA_DIR). */
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

/** KiÃ¡Â»Æ’m tra path tÃ¡Â»Â« DB trÃ†Â°Ã¡Â»â€ºc khi res.download (defense-in-depth). TrÃ¡ÂºÂ£ { norm } hoÃ¡ÂºÂ·c { err: 403|404 }. */
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
  if (r.err === 403) return res.status(403).json({ message: 'Truy cÃ¡ÂºÂ­p bÃ¡Â»â€¹ tÃ¡Â»Â« chÃ¡Â»â€˜i' });
  if (r.err) return res.status(404).json({ message: 'File khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i' });
  return res.download(r.norm, downloadName);
}

/** ChuÃ¡ÂºÂ©n bÃ¡Â»â€¹ danh sÃƒÂ¡ch file cho ZIP; Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i lÃ¡Â»â€”i thÃƒÂ¬ trÃ¡ÂºÂ£ null. */
function prepareDownloadFileList(res, files) {
  const out = [];
  for (let i = 0; i < (files || []).length; i++) {
    const f = files[i];
    const r = normalizeAndCheckDownloadPath(f && f.path);
    if (r.err === 403) {
      res.status(403).json({ message: 'Truy cÃ¡ÂºÂ­p bÃ¡Â»â€¹ tÃ¡Â»Â« chÃ¡Â»â€˜i' });
      return null;
    }
    if (r.err) {
      res.status(404).json({ message: 'File khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i' });
      return null;
    }
    out.push({ norm: r.norm, originalName: f.originalName });
  }
  return out;
}

/** ChÃ¡Â»â€° file trong uploads/missions/<missionId>/ (Ã„â€˜ÃƒÂºng cÃƒÂ¡ch lÃ†Â°u khi upload). */
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

/** ChÃ¡Â»â€° thÃ†Â° mÃ¡Â»Â¥c .../submission_<id>/ nÃ¡ÂºÂ±m trong uploads/ Ã¢â‚¬â€ trÃƒÂ¡nh rmSync nhÃ¡ÂºÂ§m project root. */
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

// Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n: cÃƒÂ¹ng file sci-ace.db (gom DB). File de-tai-cap-vien.db cÃ…Â© Ã„â€˜Ã†Â°Ã¡Â»Â£c migrate mÃ¡Â»â„¢t lÃ¡ÂºÂ§n khi khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng.
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
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewNote TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedAt TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN reviewedById INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN revisionRound INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedById INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedByRole TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submission_files ADD COLUMN uploadedAt TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
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
try { db.prepare('ALTER TABLE users ADD COLUMN academicTitle TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try {
  db.prepare('UPDATE users SET password_support_hint = NULL WHERE password_support_hint IS NOT NULL').run();
} catch (e) { /* khÃƒÂ´ng cÃƒÂ³ cÃ¡Â»â„¢t password_support_hint */ }
try {
  db.exec('ALTER TABLE users DROP COLUMN password_support_hint');
} catch (e) { /* SQLite < 3.35 hoÃ¡ÂºÂ·c cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ xÃƒÂ³a / chÃ†Â°a tÃ¡Â»Â«ng cÃƒÂ³ */ }

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ CRD Lab Booking (Ã„â€˜Ã¡ÂºÂ·t lÃ¡Â»â€¹ch thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

/** null nÃ¡ÂºÂ¿u Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ©p dÃƒÂ¹ng CRD; chuÃ¡Â»â€”i lÃƒÂ½ do nÃ¡ÂºÂ¿u bÃ¡Â»â€¹ chÃ¡ÂºÂ·n */
function crdPersonBlockedForUse(personId) {
  if (!personId) return 'KhÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh ngÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng CRD';
  const row = db.prepare('SELECT is_banned, crd_access_revoked FROM crd_persons WHERE id = ?').get(personId);
  if (!row) return 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡ CRD';
  if (Number(row.crd_access_revoked) === 1) return 'HÃ¡Â»â€œ sÃ†Â¡ CRD Ã„â€˜ÃƒÂ£ bÃ¡Â»â€¹ gÃ¡Â»Â¡. LiÃƒÂªn hÃ¡Â»â€¡ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ Ã„â€˜Ã¡Â»Æ’ kÃƒÂ­ch hoÃ¡ÂºÂ¡t lÃ¡ÂºÂ¡i.';
  if (Number(row.is_banned) === 1) return 'TÃƒÂ i khoÃ¡ÂºÂ£n CRD Ã„â€˜ang bÃ¡Â»â€¹ tÃ¡ÂºÂ¡m khoÃƒÂ¡.';
  return null;
}

/** NgÃ†Â°Ã¡Â»Âi cÃƒÂ³ vai trÃƒÂ² CRD gÃ¡ÂºÂ¯n cÃ¡Â»Â QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ (vd Admin CRD) Ã¢â‚¬â€ dÃƒÂ¹ng kiÃ¡Â»Æ’m duyÃ¡Â»â€¡t kÃƒÂªnh chung */
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
    ['m1', 'SEM-7000', 'KÃƒÂ­nh hiÃ¡Â»Æ’n vi Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­ quÃƒÂ©t', 'Lab A-01', '#667eea', 8, 20, 4, 'Scanning Electron Microscope', 1],
    ['m2', 'XRD-Pro', 'MÃƒÂ¡y nhiÃ¡Â»â€¦u xÃ¡ÂºÂ¡ tia X', 'Lab A-02', '#764ba2', 7, 22, 6, 'X-Ray Diffractometer', 2],
    ['m3', 'FTIR-4000', 'MÃƒÂ¡y quang phÃ¡Â»â€¢ hÃ¡Â»â€œng ngoÃ¡ÂºÂ¡i', 'Lab B-01', '#4caf88', 8, 18, 3, 'FTIR', 3],
    ['m4', 'TEM-HiRes', 'KÃƒÂ­nh hiÃ¡Â»Æ’n vi Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­ truyÃ¡Â»Ân qua', 'Lab B-02', '#f5a623', 9, 17, 2, 'TEM', 4],
    ['m5', 'Rheometer-AR', 'MÃƒÂ¡y Ã„â€˜o lÃ†Â°u biÃ¡ÂºÂ¿n', 'Lab C-01', '#e05c6a', 8, 20, 5, 'Rheometer', 5]
  ].forEach(row => insM.run(...row));
  const insP = db.prepare('INSERT INTO crd_persons (id,name,email,role,avatar) VALUES (?,?,?,?,?)');
  [
    ['u_admin', 'Admin CRD', 'admin@crd.edu.vn', 'admin', 'A'],
    ['u1', 'NguyÃ¡Â»â€¦n Minh Khoa', 'khoa@crd.edu.vn', 'user', 'K'],
    ['u2', 'TrÃ¡ÂºÂ§n ThÃ¡Â»â€¹ Lan', 'lan@crd.edu.vn', 'user', 'L'],
    ['u3', 'LÃƒÂª VÃ„Æ’n HÃƒÂ¹ng', 'hung@crd.edu.vn', 'user', 'H']
  ].forEach(row => insP.run(...row));
  const insB = db.prepare(
    'INSERT INTO crd_bookings (id,machine_id,person_id,date,start_h,end_h,purpose,status) VALUES (?,?,?,?,?,?,?,?)'
  );
  insB.run('b1', 'm1', 'u1', todayStr, 9, 11, 'PhÃƒÂ¢n tÃƒÂ­ch vÃ¡ÂºÂ­t liÃ¡Â»â€¡u nano', 'confirmed');
  insB.run('b2', 'm2', 'u2', todayStr, 13, 16, 'PhÃƒÂ¢n tÃƒÂ­ch cÃ¡ÂºÂ¥u trÃƒÂºc tinh thÃ¡Â»Æ’', 'confirmed');
  insB.run('b3', 'm3', 'u3', todayStr, 10, 12, 'NghiÃƒÂªn cÃ¡Â»Â©u polymer', 'confirmed');
  const ts = Date.now();
  db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
    'c1', 'u1', 'u2', 'b2', 'ChÃƒÂ o bÃ¡ÂºÂ¡n, mÃƒÂ¬nh cÃ¡ÂºÂ§n dÃƒÂ¹ng XRD lÃƒÂºc 14hÃ¢â‚¬â€œ15h, bÃ¡ÂºÂ¡n cÃƒÂ³ thÃ¡Â»Æ’ dÃ¡Â»Âi sang 15h khÃƒÂ´ng?', ts - 3600000, 0
  );
  db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,?)').run(
    'c2', 'u2', 'u1', 'b2', 'MÃƒÂ¬nh xem lÃ¡ÂºÂ¡i lÃ¡Â»â€¹ch nhÃƒÂ©.', ts - 1800000, 1
  );
  console.log('[CRD] Ã„ÂÃƒÂ£ seed dÃ¡Â»Â¯ liÃ¡Â»â€¡u mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã¡ÂºÂ·t lÃ¡Â»â€¹ch thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹.');
}
try {
  crdSeedIfEmpty();
} catch (e) {
  console.warn('[CRD] Seed:', e.message);
}

/** Ã„ÂÃ¡ÂºÂ·t lÃ¡Â»â€¹ch theo bÃ†Â°Ã¡Â»â€ºc 30 phÃƒÂºt Ã¢â‚¬â€ migrate bÃ¡ÂºÂ£ng cÃ…Â© INTEGER Ã¢â€ â€™ REAL */
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
    console.log('[CRD] Ã„ÂÃƒÂ£ migrate crd_bookings.start_h/end_h Ã¢â€ â€™ REAL (hÃ¡Â»â€” trÃ¡Â»Â£ 30 phÃƒÂºt)');
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
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}

/**
 * Cho phÃƒÂ©p ALTER ... ADD COLUMN chÃ¡Â»â€° vÃ¡Â»â€ºi (bÃ¡ÂºÂ£ng, cÃ¡Â»â„¢t, Ã„â€˜Ã¡Â»â€¹nh nghÃ„Â©a kiÃ¡Â»Æ’u) Ã„â€˜ÃƒÂ£ khai bÃƒÂ¡o Ã¢â‚¬â€ trÃƒÂ¡nh SQL injection nÃ¡ÂºÂ¿u sau nÃƒÂ y gÃ¡Â»Âi tÃ¡Â»Â« input.
 * Khi thÃƒÂªm migration cÃ¡Â»â„¢t mÃ¡Â»â€ºi: bÃ¡Â»â€¢ sung Map tÃ†Â°Ã†Â¡ng Ã¡Â»Â©ng bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi.
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
    console.warn(`[CRD] Ensure column: bÃ¡ÂºÂ£ng khÃƒÂ´ng nÃ¡ÂºÂ±m trong whitelist: ${tableName}`);
    return false;
  }
  const allowedDefs = byTable.get(col);
  if (!allowedDefs || !allowedDefs.has(def)) {
    console.warn(
      `[CRD] Ensure column: cÃ¡Â»â„¢t hoÃ¡ÂºÂ·c kiÃ¡Â»Æ’u SQL khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ©p: ${table}.${col} Ã¢â‚¬â€ "${def}"`
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
    console.warn('[CRD] Ensure column: tÃƒÂªn bÃ¡ÂºÂ£ng/cÃ¡Â»â„¢t khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (chÃ¡Â»â€° chÃ¡Â»Â¯, sÃ¡Â»â€˜, gÃ¡ÂºÂ¡ch dÃ†Â°Ã¡Â»â€ºi).');
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
  // SQLite chÃ¡Â»â€° cho phÃƒÂ©p default kiÃ¡Â»Æ’u hÃ¡ÂºÂ±ng sÃ¡Â»â€˜ khi dÃƒÂ¹ng ALTER TABLE ADD COLUMN.
  // VÃ¡Â»â€ºi datetime('now',...) sÃ¡ÂºÂ½ fail => thÃƒÂªm cÃ¡Â»â„¢t TEXT trÃ¡Â»â€˜ng rÃ¡Â»â€œi update sau.
  'TEXT'
);

crdEnsureColumn(
  'crd_bookings',
  'research_group',
  'TEXT'
);

// NÃ¡ÂºÂ¿u bÃ¡ÂºÂ£ng Ã„â€˜ÃƒÂ£ cÃƒÂ³ created_at (dÃ¡ÂºÂ¡ng TEXT) nhÃ†Â°ng dÃ¡Â»Â¯ liÃ¡Â»â€¡u cÃ…Â© chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c set, ta Ã„â€˜iÃ¡Â»Ân giÃƒÂ¡ trÃ¡Â»â€¹ hiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i.
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
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
try {
  db.prepare('ALTER TABLE crd_persons ADD COLUMN crd_access_revoked INTEGER DEFAULT 0').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
try {
  db.prepare('ALTER TABLE crd_persons ADD COLUMN user_id INTEGER').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
try {
  db.prepare('ALTER TABLE users ADD COLUMN is_disabled INTEGER DEFAULT 0').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
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
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
/** CRD Ã¢â‚¬â€ giÃ¡Â»Â tÃƒÂ­ch lÃ…Â©y & nhÃ¡ÂºÂ­t kÃƒÂ½ bÃ¡ÂºÂ£o trÃƒÂ¬ (migrations/003_crd_maintenance_and_utilization.sql) */
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN accumulated_hours REAL DEFAULT 0').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_threshold_hours REAL DEFAULT 500').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN last_maintenance_date TEXT').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
try {
  db.prepare('ALTER TABLE crd_machines ADD COLUMN maintenance_notes TEXT').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
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
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
}
/** Map: personId Ã¢â€ â€™ [timestamp] cho rate-limiting gÃ¡Â»Â­i tin kÃƒÂªnh chung */
const crdBroadcastRateMap = new Map(); // cleared when server restarts (in-memory)
const CRD_BROADCAST_RATE_MS = 30_000;  // tÃ¡Â»â€˜i thiÃ¡Â»Æ’u 30 giÃƒÂ¢y giÃ¡Â»Â¯a 2 lÃ¡ÂºÂ§n gÃ¡Â»Â­i
const CRD_BROADCAST_RATE_BURST = 3;     // cho phÃƒÂ©p burst 3 tin trÃ†Â°Ã¡Â»â€ºc khi ÃƒÂ¡p rate

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
      label: `KÃ¡Â»Â³ ${i + 1} (${c} thÃƒÂ¡ng)`,
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

/** SÃ¡Â»â€˜ ngÃƒÂ y thÃ¡Â»Â±c tÃ¡ÂºÂ¿ (mÃ¡Â»Å¸ bÃ†Â°Ã¡Â»â€ºc Ã¢â€ â€™ hoÃƒÂ n thÃƒÂ nh / Ã„â€˜Ã¡ÂºÂ¿n hiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i) Ã¢â‚¬â€ tÃ¡Â»Â« lÃ¡Â»â€¹ch sÃ¡Â»Â­ + deadline + trÃ¡ÂºÂ¡ng thÃƒÂ¡i */
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

  // BÃ†Â°Ã¡Â»â€ºc 1 Ã¢â‚¬â€ mÃ¡Â»Å¸: tÃ¡ÂºÂ¡o hÃ¡Â»â€œ sÃ†Â¡; Ã„â€˜ÃƒÂ³ng: nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡
  const s1o = dlOpened('1') || row.createdAt;
  let s1c = pickFirst('1', ['researcher_submit']);
  if (!s1c && st !== 'SUBMITTED' && st !== 'NEED_REVISION') {
    s1c = pickFirst('2', null) || row.createdAt;
  }
  const step1Done = !!s1c || (st !== 'SUBMITTED' && st !== 'NEED_REVISION');
  out['1'] = pack(s1o, s1c, step1Done);

  // BÃ†Â°Ã¡Â»â€ºc 2
  const s2o = dlOpened('2') || s1c || row.createdAt;
  const step2Done = ['VALIDATED', 'ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
  let s2c = pickLast('2', ['secretary_approve']);
  if (!s2c && step2Done && row.reviewedAt && st !== 'NEED_REVISION') s2c = row.reviewedAt;
  if (st === 'NEED_REVISION' || st === 'SUBMITTED') {
    out['2'] = pack(s2o, null, false);
  } else {
    out['2'] = pack(s2o, s2c, step2Done);
  }

  // BÃ†Â°Ã¡Â»â€ºc 3
  const s3o = dlOpened('3') || s2c || s2o;
  let s3c = pickLast('3', ['chairman_assign']);
  if (!s3c && row.assignedAt) s3c = row.assignedAt;
  const step3Done = ['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED', 'IN_MEETING', 'CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(st);
  out['3'] = pack(s3o, s3c, step3Done);

  // BÃ†Â°Ã¡Â»â€ºc 4 Ã¢â‚¬â€ Ã„â€˜ÃƒÂ³ng: lÃ¡ÂºÂ§n PB2 hoÃƒÂ n thÃƒÂ nh (reviewer_complete thÃ¡Â»Â© 2 theo thÃ¡Â»Âi gian)
  const s4o = dlOpened('4') || s3c || s3o;
  const rcTimes = pickAll('4', 'reviewer_complete').sort();
  let s4c = rcTimes.length >= 2 ? rcTimes[1] : null;
  const bothPb = !!(row.step_4_reviewer1_done && row.step_4_reviewer2_done);
  if (!s4c && bothPb && rcTimes.length === 1) s4c = rcTimes[0];
  out['4'] = pack(s4o, s4c, bothPb);

  // BÃ†Â°Ã¡Â»â€ºc 4A
  const s4aO = dlOpened('4a') || pickFirst('4a', ['budget_upload']) || s3c || s3o;
  let s4aC = pickLast('4a', ['budget_approve']);
  const step4aDone = String(row.budget_4a_status || '').toLowerCase() === 'approved';
  if (!s4aC && step4aDone && row.budget_4a_approved_at) s4aC = row.budget_4a_approved_at;
  out['4a'] = pack(s4aO, s4aC, step4aDone);

  // BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ mÃ¡Â»Å¸: sau khi Ã„â€˜Ã¡Â»Â§ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n (max PB2 xong & phÃƒÂª duyÃ¡Â»â€¡t 4A) hoÃ¡ÂºÂ·c deadline / sÃ¡Â»Â± kiÃ¡Â»â€¡n Ã„â€˜Ã¡ÂºÂ§u bÃ†Â°Ã¡Â»â€ºc 5
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
    /* bÃ¡ÂºÂ£ng cÃƒÂ³ thÃ¡Â»Æ’ chÃ†Â°a tÃ¡ÂºÂ¡o trÃƒÂªn DB cÃ¡Â»Â±c cÃ…Â© */
  }

  return out;
}

try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedReviewerIds TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedAt TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN assignedById INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_status TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_round INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('UPDATE cap_vien_submissions SET budget_4a_round = 1 WHERE COALESCE(budget_4a_round, 0) < 1').run(); } catch (e) { /* bÃ¡Â»Â qua */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_note TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_revision_requested_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN budget_4a_approved_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer1_done INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step_4_reviewer2_done INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN code TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN options_checked TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_location TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_attendance TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_documents TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_vote_result TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_decision TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_event_time TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_hd_meeting_updated_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_status TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_round INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('UPDATE cap_vien_submissions SET step5_council_revision_round = 0 WHERE step5_council_revision_round IS NULL').run(); } catch (e) { /* bÃ¡Â»Â qua */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_note TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step5_council_revision_requested_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_so_qd TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_kinh_phi TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_thoi_gian TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_phi_quan_ly TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step6_meta_updated_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_so_hd TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_hieu_luc TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step7_meta_updated_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_ma_dao_duc TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_hieu_luc TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_so_quyet_dinh TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_meta_updated_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_completed INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8_waived INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_completed INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step8a_waived INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
// BÃ†Â°Ã¡Â»â€ºc 9: danh mÃ¡Â»Â¥c hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â° Ã„â€˜ÃƒÂ£ "khoÃƒÂ¡" (sÃ¡Â»â€˜ liÃ¡Â»â€¡u chÃƒÂ­nh thÃ¡Â»Â©c Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡Â»â€˜i sÃƒÂ¡nh dÃ¡Â»Â± toÃƒÂ¡n, xem cap_vien_step9_supply_item).
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
try { db.prepare('ALTER TABLE cap_vien_submissions ADD COLUMN step9_supply_locked_by INTEGER').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }

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
  -- BÃ†Â°Ã¡Â»â€ºc 9 (ThÃ¡Â»Â±c hiÃ¡Â»â€¡n Ã„â€˜Ã¡Â»Â tÃƒÂ i): mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng do ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m/Admin tÃ¡Â»Â± khai bÃƒÂ¡o (thay vÃƒÂ¬ 3 mÃ¡Â»â€˜c cÃ¡Â»â€˜ Ã„â€˜Ã¡Â»â€¹nh trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y).
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
  -- Danh mÃ¡Â»Â¥c hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â° dÃ¡Â»Â± toÃƒÂ¡n (BÃ†Â°Ã¡Â»â€ºc 9). TrÃ†Â°Ã¡Â»â€ºc khi cap_vien_submissions.step9_supply_locked_at
  -- Ã„â€˜Ã†Â°Ã¡Â»Â£c set, ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m/Admin cÃƒÂ²n sÃ¡Â»Â­a/xÃƒÂ³a tÃ¡Â»Â± do; sau khi khoÃƒÂ¡, approvedQty lÃƒÂ  sÃ¡Â»â€˜ liÃ¡Â»â€¡u chÃƒÂ­nh thÃ¡Â»Â©c Ã„â€˜Ã¡Â»Æ’
  -- Ã„â€˜Ã¡Â»â€˜i sÃƒÂ¡nh vÃ¡Â»â€ºi cÃƒÂ¡c Ã„â€˜Ã¡Â»Â£t cÃ¡ÂºÂ¥p phÃƒÂ¡t (cap_vien_step9_supply_issuance).
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
  -- Ã„ÂÃ¡Â»Â£t cÃ¡ÂºÂ¥p phÃƒÂ¡t cho tÃ¡Â»Â«ng item Ã¢â‚¬â€ 'requested' do ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m/Admin Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹, chÃ¡Â»â€° Admin/PhÃƒÂ²ng KHCN/ThÃ†Â° kÃƒÂ½
  -- mÃ¡Â»â€ºi chuyÃ¡Â»Æ’n sang 'confirmed' (trÃ¡Â»Â« vÃƒÂ o approvedQty) hoÃ¡ÂºÂ·c 'rejected'.
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
  -- BÃ†Â°Ã¡Â»â€ºc 11: Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh (nhÃƒÂ¢n sÃ¡Â»Â±/kÃ¡ÂºÂ¿ hoÃ¡ÂºÂ¡ch/dÃ¡Â»Â± toÃƒÂ¡n/gia hÃ¡ÂºÂ¡n) Ã¢â‚¬â€ quy trÃƒÂ¬nh 2 cÃ¡ÂºÂ¥p:
  -- ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m nÃ¡Â»â„¢p -> PhÃƒÂ²ng KHCN xem xÃƒÂ©t (yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung/trÃƒÂ¬nh lÃƒÂªn/tÃ¡Â»Â« chÃ¡Â»â€˜i thÃ¡ÂºÂ³ng) -> ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng duyÃ¡Â»â€¡t/khÃƒÂ´ng duyÃ¡Â»â€¡t.
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
  db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run('kinh_phi_vien', 'Kinh phÃƒÂ­ tÃ¡Â»Â« ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c', 0, 2);
})();

// BÃ¡ÂºÂ£ng danh mÃ¡Â»Â¥c hÃ¡ÂºÂ¡ng mÃ¡Â»Â¥c Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (admin quÃ¡ÂºÂ£n trÃ¡Â»â€¹)
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
    const lv = [['stem-cell', 'TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c', 1], ['biotechnology', 'CÃƒÂ´ng nghÃ¡Â»â€¡ sinh hÃ¡Â»Âc', 2], ['medicine', 'Y sinh hÃ¡Â»Âc', 3], ['other', 'KhÃƒÂ¡c', 4]];
    lv.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_linh_vuc (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasLdt = db.prepare('SELECT id FROM cap_vien_loai_de_tai LIMIT 1').get();
  if (!hasLdt) {
    const ldt = [['research', 'Ã„ÂÃ¡Â»Â tÃƒÂ i nghiÃƒÂªn cÃ¡Â»Â©u', 1], ['project', 'DÃ¡Â»Â± ÃƒÂ¡n', 2], ['program', 'ChÃ†Â°Ã†Â¡ng trÃƒÂ¬nh', 3]];
    ldt.forEach(([c, l, o]) => db.prepare('INSERT INTO cap_vien_loai_de_tai (code, label, sort_order) VALUES (?, ?, ?)').run(c, l, o));
  }
  const hasKm = db.prepare('SELECT id FROM cap_vien_khoan_muc_chi LIMIT 1').get();
  if (!hasKm) {
    const km = [
      ['1', 'Chi thÃƒÂ¹ lao cho cÃƒÂ¡n bÃ¡Â»â„¢ khoa hÃ¡Â»Âc', null, 1],
      ['1.1', 'ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i', '1', 2],
      ['1.2', 'ThÃƒÂ nh viÃƒÂªn chÃƒÂ­nh', '1', 3],
      ['1.3', 'KÃ¡Â»Â¹ thuÃ¡ÂºÂ­t viÃƒÂªn/TrÃ¡Â»Â£ lÃƒÂ½', '1', 4],
      ['2', 'Chi mua vÃ¡ÂºÂ­t tÃ†Â°, nguyÃƒÂªn liÃ¡Â»â€¡u', null, 5],
      ['2.1', 'HÃƒÂ³a chÃ¡ÂºÂ¥t', '2', 6],
      ['2.2', 'Sinh phÃ¡ÂºÂ©m', '2', 7],
      ['2.3', 'DÃ¡Â»Â¥ng cÃ¡Â»Â¥ thÃƒÂ­ nghiÃ¡Â»â€¡m tiÃƒÂªu hao', '2', 8],
      ['3', 'Chi mua sÃ¡ÂºÂ¯m, sÃ¡Â»Â­a chÃ¡Â»Â¯a tÃƒÂ i sÃ¡ÂºÂ£n cÃ¡Â»â€˜ Ã„â€˜Ã¡Â»â€¹nh', null, 9],
      ['3.1', 'ThiÃ¡ÂºÂ¿t bÃ¡Â»â€¹', '3', 10],
      ['3.2', 'PhÃ¡ÂºÂ§n mÃ¡Â»Âm', '3', 11],
      ['4', 'Chi hÃ¡Â»â„¢i nghÃ¡Â»â€¹, hÃ¡Â»â„¢i thÃ¡ÂºÂ£o, cÃƒÂ´ng tÃƒÂ¡c phÃƒÂ­', null, 12],
      ['4.1', 'HÃ¡Â»â„¢i nghÃ¡Â»â€¹, hÃ¡Â»â„¢i thÃ¡ÂºÂ£o khoa hÃ¡Â»Âc', '4', 13],
      ['4.2', 'CÃƒÂ´ng tÃƒÂ¡c phÃƒÂ­ trong nÃ†Â°Ã¡Â»â€ºc', '4', 14],
      ['4.3', 'CÃƒÂ´ng tÃƒÂ¡c phÃƒÂ­ nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i', '4', 15],
      ['5', 'Chi thuÃƒÂª ngoÃƒÂ i', null, 16],
      ['5.1', 'ThuÃƒÂª chuyÃƒÂªn gia', '5', 17],
      ['5.2', 'ThuÃƒÂª dÃ¡Â»â€¹ch vÃ¡Â»Â¥ phÃƒÂ¢n tÃƒÂ­ch', '5', 18],
      ['6', 'Chi khÃƒÂ¡c', null, 19],
      ['6.1', 'Chi phÃƒÂ­ quÃ¡ÂºÂ£n lÃƒÂ½ chung (tÃ¡Â»â€˜i Ã„â€˜a 5%)', '6', 20],
      ['6.2', 'Chi phÃƒÂ­ in Ã¡ÂºÂ¥n, vÃ„Æ’n phÃƒÂ²ng phÃ¡ÂºÂ©m', '6', 21]
    ];
    km.forEach(([c, l, p, o]) => db.prepare('INSERT INTO cap_vien_khoan_muc_chi (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(c, l, p, o));
  }
})();

(function migrateLegacyCapVienIntoMainDb() {
  if (!fs.existsSync(legacyCapVienDbPath)) return;
  const mainSubCount = db.prepare('SELECT COUNT(*) AS n FROM cap_vien_submissions').get().n;
  if (mainSubCount > 0) return;
  
  // Legacy database chÃ¡Â»â€° Ã„â€˜Ã¡Â»Âc tÃ¡Â»Â« file local, luÃƒÂ´n dÃƒÂ¹ng better-sqlite3
  let legacyDb;
  try {
    const LegacyDatabase = require('better-sqlite3');
    legacyDb = new LegacyDatabase(legacyCapVienDbPath, { readonly: true });
  } catch (e) {
    console.warn('[DB] KhÃƒÂ´ng mÃ¡Â»Å¸ Ã„â€˜Ã†Â°Ã¡Â»Â£c de-tai-cap-vien.db Ã„â€˜Ã¡Â»Æ’ gom vÃƒÂ o sci-ace.db:', e.message);
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
    console.log('[DB] Ã„ÂÃƒÂ£ gom dÃ¡Â»Â¯ liÃ¡Â»â€¡u Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n tÃ¡Â»Â« de-tai-cap-vien.db vÃƒÂ o sci-ace.db. File cÃ…Â© Ã„â€˜Ã¡Â»â€¢i tÃƒÂªn:', path.basename(bakPath));
  } catch (e) {
    try { db.prepare('DETACH DATABASE capvien_legacy').run(); } catch (_) {}
    console.error('[DB] Gom de-tai-cap-vien.db thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i:', e.message || e);
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
      insertCapVienHistory(sub.id, '1', 'researcher_submit', sub.submittedById, 'researcher', 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', sub.createdAt);
    }
    const hasStep2 = db.prepare('SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = ? LIMIT 1').get(sub.id, '2');
    if (!hasStep2 && sub.reviewedAt && sub.reviewedById) {
      const u = db.prepare('SELECT fullname, role FROM users WHERE id = ?').get(sub.reviewedById);
      const performedByName = u ? (u.fullname || '') : '';
      const role = (u && u.role === 'admin') ? 'admin' : 'secretary';
      const actionType = (sub.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
      const note = sub.reviewNote || (actionType === 'secretary_approve' ? 'HÃ¡Â»Â£p lÃ¡Â»â€¡' : null);
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
      insertCapVienHistory(sub.id, '3', 'chairman_assign', sub.assignedById, 'chairman', 'PhÃƒÂ¢n cÃƒÂ´ng 2 phÃ¡ÂºÂ£n biÃ¡Â»â€¡n: ' + names.join(', '), sub.assignedAt);
    }
  }
})();

  try {
    db.prepare("ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'SUBMITTED'").run();
  } catch (e) { /* column Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewNote TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewedAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN reviewedById INTEGER').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedReviewerIds TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignedById INTEGER').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN assignNote TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submission_files ADD COLUMN uploadedAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingNote TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN meetingDecisionById INTEGER').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalSubmittedById INTEGER').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN conditionalApprovedById INTEGER').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN decisionIssuedById INTEGER').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
  try {
    db.prepare('ALTER TABLE submissions ADD COLUMN completedAt TEXT').run();
  } catch (e) { /* Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
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

// BÃ¡ÂºÂ£ng nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ KHCN (dashboard): trÃƒÂ­ch xuÃ¡ÂºÂ¥t tÃ¡Â»Â« Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃƒÂ¡c cÃ¡ÂºÂ¥p, Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ tÃ¡Â»Â« cap_vien
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

// BÃ†Â°Ã¡Â»â€ºc 4 NhÃƒÂ¡nh A Ã¢â‚¬â€ XÃƒÂ©t chÃ¡Â»Ân tÃ¡ÂºÂ¡i ViÃ¡Â»â€¡n & gÃ¡Â»Â­i BÃ¡Â»â„¢
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

// BÃ†Â°Ã¡Â»â€ºc 4 NhÃƒÂ¡nh B Ã¢â‚¬â€ NÃ¡Â»â„¢p cÃ†Â¡ quan ngoÃƒÂ i
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

// LÃ¡Â»â€¹ch sÃ¡Â»Â­ Ã„â€˜Ã¡Â»â€¢i nhÃƒÂ¡nh (reset vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 3)
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

// LÃ¡Â»â€¹ch sÃ¡Â»Â­ hÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng cÃƒÂ¡c bÃ†Â°Ã¡Â»â€ºc (generic)
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

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ChÃ¡Â»Â phÃƒÂª duyÃ¡Â»â€¡t chÃƒÂ­nh thÃ¡Â»Â©c & hoÃƒÂ n chÃ¡Â»â€°nh thuyÃ¡ÂºÂ¿t minh
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

// BÃ†Â°Ã¡Â»â€ºc 6 Ã¢â‚¬â€ KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng
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

// BÃ¡ÂºÂ£ng placeholder cho thÃ¡Â»â€˜ng kÃƒÂª trang chÃ¡Â»Â§ (khi cÃƒÂ³ module tÃ†Â°Ã†Â¡ng Ã¡Â»Â©ng sÃ¡ÂºÂ½ thÃƒÂªm cÃ¡Â»â„¢t vÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u)
db.exec(`CREATE TABLE IF NOT EXISTS personnel (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS ip_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
db.exec(`CREATE TABLE IF NOT EXISTS publications (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')))`);
try {
  db.prepare('ALTER TABLE publications ADD COLUMN import_source TEXT DEFAULT NULL').run();
} catch (e) {
  /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */
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
  try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN topics TEXT DEFAULT \'all\'').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
  try { db.prepare('ALTER TABLE cooperation_notification_recipients ADD COLUMN role TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN quoc_gia TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
  try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN loai_doi_tac TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }

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
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN expiry_alert_sent_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN post_expiry_alert_count INTEGER DEFAULT 0').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN last_post_expiry_alert_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_path TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_file_name TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }
try { db.prepare('ALTER TABLE cooperation_thoa_thuan ADD COLUMN scan_uploaded_at TEXT').run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */ }

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

// Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n tÃƒÂ i chÃƒÂ­nh YTNN (ChÃ†Â°Ã†Â¡ng VII Quy chÃ¡ÂºÂ¿ KHCN-Ã„ÂMST SCI 2026)
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
    don_vi_tien_te TEXT DEFAULT 'VNÃ„Â',
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
  // ChÃ¡Â»â€° dÃ¡Â»Ân missions_hidden Ã‚Â«mÃ¡Â»â€œ cÃƒÂ´iÃ‚Â» (hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ khÃƒÂ´ng cÃƒÂ²n trong cap_vien_submissions).
  // KHÃƒâ€NG xÃƒÂ³a Ã¡ÂºÂ©n cho hÃ¡Â»â€œ sÃ†Â¡ vÃ¡ÂºÂ«n tÃ¡Â»â€œn tÃ¡ÂºÂ¡i Ã¢â‚¬â€ nÃ¡ÂºÂ¿u khÃƒÂ´ng, sau khi Admin xÃƒÂ³a nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ khÃ¡Â»Âi dashboard
  // (ghi missions_hidden), mÃ¡Â»â€”i lÃ¡ÂºÂ§n GET /api/missions sÃ¡ÂºÂ½ gÃ¡Â»Â¡ Ã¡ÂºÂ©n vÃƒÂ  INSERT lÃ¡ÂºÂ¡i missions tÃ¡Â»Â« cap_vien (lÃ¡Â»â€”i Ã‚Â«Ã„â€˜ÃƒÂ£ xÃƒÂ³a mÃƒÂ  vÃ¡ÂºÂ«n hiÃ¡Â»â€¡nÃ‚Â»).
  // KhÃƒÂ´i phÃ¡Â»Â¥c Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§ tÃ¡Â»Â« nguÃ¡Â»â€œn: POST /api/admin/missions/sync-from-cap-vien (xÃƒÂ³a toÃƒÂ n bÃ¡Â»â„¢ missions_hidden cap_vien).
  try {
    db.prepare(
      `DELETE FROM missions_hidden WHERE source_type = 'cap_vien' AND source_id NOT IN (SELECT id FROM cap_vien_submissions)`
    ).run();
  } catch (e) {
    /* bÃ¡ÂºÂ£ng cÃƒÂ³ thÃ¡Â»Æ’ chÃ†Â°a cÃƒÂ³ */
  }
  const rows = db.prepare('SELECT id, title, submittedById, status, createdAt, code FROM cap_vien_submissions').all();
  const hidden = new Set(
    db.prepare("SELECT source_type || ':' || source_id AS k FROM missions_hidden").all().map(r => r.k)
  );
  // ÃƒÂnh xÃ¡ÂºÂ¡ Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§ 10 trÃ¡ÂºÂ¡ng thÃƒÂ¡i thÃ¡ÂºÂ­t cÃ¡Â»Â§a cap_vien_submissions (9-step) sang mÃƒÂ£ trÃ¡ÂºÂ¡ng thÃƒÂ¡i nhiÃ¡Â»â€¡m vÃ¡Â»Â¥
  // KHCN Ã„â€˜ÃƒÂ£ cÃƒÂ³ sÃ¡ÂºÂµn nhÃƒÂ£n tiÃ¡ÂºÂ¿ng ViÃ¡Â»â€¡t (MISSION_STATUS_SEARCH_LABELS / getStatusText trong quan-ly-de-tai-co-so.html).
  // TrÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y ASSIGNED vÃƒÂ  CONTRACTED bÃ¡Â»â€¹ thiÃ¡ÂºÂ¿u trong map Ã¢â€ â€™ rÃ†Â¡i vÃ¡Â»Â default 'planning' (Ã‚Â«LÃ¡ÂºÂ­p kÃ¡ÂºÂ¿ hoÃ¡ÂºÂ¡chÃ‚Â»),
  // khiÃ¡ÂºÂ¿n hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ kÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng (gÃ¡ÂºÂ§n cuÃ¡Â»â€˜i quy trÃƒÂ¬nh) hiÃ¡Â»Æ’n thÃ¡Â»â€¹ nhÃ†Â° vÃ¡Â»Â«a mÃ¡Â»â€ºi nÃ¡Â»â„¢p; REJECTED cÃ…Â©ng bÃ¡Â»â€¹ gÃ¡Â»â„¢p
  // nhÃ¡ÂºÂ§m vÃƒÂ o 'planning' thay vÃƒÂ¬ trÃ¡ÂºÂ¡ng thÃƒÂ¡i tÃ¡Â»Â« chÃ¡Â»â€˜i riÃƒÂªng.
  const statusMap = {
    SUBMITTED: 'planning',              // MÃ¡Â»â€ºi nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡
    NEED_REVISION: 'planning',          // ThÃ†Â° kÃƒÂ½ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡
    VALIDATED: 'planning',              // HÃ¡Â»â€œ sÃ†Â¡ hÃ¡Â»Â£p lÃ¡Â»â€¡, chÃ¡Â»Â phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n
    // DÃƒÂ¹ng 'cho_vien_xet_chon' (khÃƒÂ´ng phÃ¡ÂºÂ£i 'review') vÃƒÂ¬ sidebar quan-ly-de-tai-co-so.html gÃ¡Â»â„¢p
    // 'review' vÃƒÂ o nhÃƒÂ³m "NghiÃ¡Â»â€¡m thu" (nghiÃ¡Â»â€¡m thu cuÃ¡Â»â€˜i) Ã¢â‚¬â€ trong khi 3 trÃ¡ÂºÂ¡ng thÃƒÂ¡i nÃƒÂ y thÃ¡Â»Â±c chÃ¡ÂºÂ¥t lÃƒÂ 
    // "Ã„â€˜ang chÃ¡Â»Â HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng ViÃ¡Â»â€¡n xÃƒÂ©t/hÃ¡Â»Âp", Ã„â€˜ÃƒÂºng nghÃ„Â©a nhÃƒÂ³m "ChÃ¡Â»Â xÃƒÂ©t duyÃ¡Â»â€¡t".
    ASSIGNED: 'cho_vien_xet_chon',      // Ã„ÂÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã¢â‚¬â€ Ã„â€˜ang thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh
    REVIEWED: 'cho_vien_xet_chon',      // PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n xong, chÃ¡Â»Â hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN
    IN_MEETING: 'cho_vien_xet_chon',    // Ã„Âang hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN
    CONDITIONAL: 'da_phe_duyet',        // HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng thÃƒÂ´ng qua (cÃƒÂ³ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n), chÃ¡Â»Â cÃ¡ÂºÂ¥p QÃ„Â chÃƒÂ­nh thÃ¡Â»Â©c
    APPROVED: 'cho_ky_hop_dong',        // Ã„ÂÃƒÂ£ cÃƒÂ³ QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t, chÃ¡Â»Â kÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng
    CONTRACTED: 'dang_thuc_hien',       // Ã„ÂÃƒÂ£ kÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng Ã¢â‚¬â€ Ã„â€˜ang triÃ¡Â»Æ’n khai thÃ¡Â»Â±c hiÃ¡Â»â€¡n
    REJECTED: 'khong_duoc_phe_duyet',   // BÃ¡Â»â€¹ tÃ¡Â»Â« chÃ¡Â»â€˜i / dÃ¡Â»Â«ng quy trÃƒÂ¬nh
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
 * XÃƒÂ³a Ã„â€˜Ã¡Â»Â tÃƒÂ i khÃ¡Â»Âi dashboard vÃƒÂ  mÃ¡Â»Âi bÃ¡ÂºÂ£n ghi phÃ¡Â»Â¥ thuÃ¡Â»â„¢c (SQLite foreign_keys = ON).
 * ThÃ¡Â»Â© tÃ¡Â»Â±: bÃ¡ÂºÂ£ng tham chiÃ¡ÂºÂ¿u missions(id) trÃ†Â°Ã¡Â»â€ºc, cuÃ¡Â»â€˜i cÃƒÂ¹ng missions.
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
    /* bÃ¡ÂºÂ£ng cÃƒÂ³ thÃ¡Â»Æ’ chÃ†Â°a tÃ¡Â»â€œn tÃ¡ÂºÂ¡i trÃƒÂªn DB cÃ…Â© */
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
      /* bÃ¡Â»Â qua file khÃƒÂ´ng xÃƒÂ³a Ã„â€˜Ã†Â°Ã¡Â»Â£c */
    }
  }
}

function resolveCapVienUploadRoot() {
  return path.resolve(uploadDirCapVien);
}

/** ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n Ã„â€˜Ã†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n nÃ¡ÂºÂ±m trong uploads-cap-vien Ã¢â‚¬â€ trÃƒÂ¡nh xÃƒÂ³a nhÃ¡ÂºÂ§m mÃƒÂ£ nguÃ¡Â»â€œn (server.js, Ã¢â‚¬Â¦). */
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
 * XÃƒÂ³a hoÃƒÂ n toÃƒÂ n mÃ¡Â»â„¢t hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n khÃ¡Â»Âi toÃƒÂ n hÃ¡Â»â€¡ thÃ¡Â»â€˜ng:
 * Ã¢â‚¬â€ mÃ¡Â»Âi missions (dashboard) trÃ¡Â»Â tÃ¡Â»â€ºi cap_vien + source_id (cascade buoc*, missions_filesÃ¢â‚¬Â¦)
 * Ã¢â‚¬â€ missions_hidden, bÃ¡ÂºÂ£ng cap_vien (file, lÃ¡Â»â€¹ch sÃ¡Â»Â­, deadline, submission)
 * Ã¢â‚¬â€ thÃ†Â° mÃ¡Â»Â¥c upload trÃƒÂªn Ã„â€˜Ã„Â©a (nÃ¡ÂºÂ¿u cÃƒÂ³)
 * DÃƒÂ¹ng cho Admin: nÃƒÂºt XÃƒÂ³a Ã¡Â»Å¸ QuÃ¡ÂºÂ£n lÃƒÂ½ nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ vÃƒÂ  DELETE /api/cap-vien/submissions/:id
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

// SÃ¡Â»Â­a tÃƒÂªn file bÃ¡Â»â€¹ bÃ¡Â»Æ’ dÃ¡ÂºÂ¥u: trÃƒÂ¬nh duyÃ¡Â»â€¡t gÃ¡Â»Â­i UTF-8 nhÃ†Â°ng Node Ã„â€˜Ã¡Â»Âc header theo Latin-1 Ã¢â€ â€™ chuyÃ¡Â»Æ’n lÃ¡ÂºÂ¡i UTF-8
function fixFilenameEncoding(name) {
  if (!name || typeof name !== 'string') return name || '';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

// TÃƒÂªn thÃ†Â° mÃ¡Â»Â¥c an toÃƒÂ n tÃ¡Â»Â« hÃ¡Â»Â tÃƒÂªn (loÃ¡ÂºÂ¡i bÃ¡Â»Â kÃƒÂ½ tÃ¡Â»Â± Ã„â€˜Ã¡ÂºÂ·c biÃ¡Â»â€¡t, khoÃ¡ÂºÂ£ng trÃ¡ÂºÂ¯ng Ã¢â€ â€™ gÃ¡ÂºÂ¡ch dÃ†Â°Ã¡Â»â€ºi)
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

// Multer: lÃ†Â°u file tÃ¡ÂºÂ¡m, sau khi tÃ¡ÂºÂ¡o submission sÃ¡ÂºÂ½ chuyÃ¡Â»Æ’n vÃƒÂ o uploads/<HÃ¡Â»Â tÃƒÂªn NCV>/submission_<id>/
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

/** Upload CSV SCImago (memory) Ã¢â‚¬â€ POST /api/admin/sjr-csv-import */
const uploadSjrCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_FILE_BYTES_SJR_CSV, fieldSize: MULTIPART_MAX_FIELD_BYTES },
});

// Multer cho Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (thÃ†Â° mÃ¡Â»Â¥c riÃƒÂªng)
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

/** MÃ¡ÂºÂ«u hÃ¡Â»â€œ sÃ†Â¡ cÃƒÂ´ng khai (trang tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n) Ã¢â‚¬â€ mÃ¡Â»Âi Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng, tÃ¡Â»â€˜i Ã„â€˜a 80MB */
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
      return cb(new Error('ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n file .doc hoÃ¡ÂºÂ·c .docx'));
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
      return cb(new Error('MÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh merge chÃ¡Â»â€° hÃ¡Â»â€” trÃ¡Â»Â£ Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng .docx'));
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
      return cb(new Error('ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n file .doc hoÃ¡ÂºÂ·c .docx'));
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
      return cb(new Error('MÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh merge chÃ¡Â»â€° hÃ¡Â»â€” trÃ¡Â»Â£ Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng .docx'));
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
      return cb(new Error('ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n file .doc hoÃ¡ÂºÂ·c .docx'));
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
      return cb(new Error('MÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh merge chÃ¡Â»â€° hÃ¡Â»â€” trÃ¡Â»Â£ Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng .docx'));
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
      return cb(new Error('ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n file .doc hoÃ¡ÂºÂ·c .docx'));
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
    if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('Scan chÃ¡Â»â€° nhÃ¡ÂºÂ­n PDF, DOC, DOCX, JPG, PNG'));
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
      return cb(new Error('MÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh merge chÃ¡Â»â€° hÃ¡Â»â€” trÃ¡Â»Â£ Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng .docx'));
    }
    cb(null, true);
  }
});

// CÃ¡ÂºÂ¥u hÃƒÂ¬nh mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh cho cÃƒÂ¡c module trÃƒÂªn trang chÃ¡Â»Â§
const HOMEPAGE_MODULES_DEFAULT = [
  { code: 'missions', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ KHCN', enabled: 1 },
  { code: 'cap_vien', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n', enabled: 1 },
  { code: 'ethics_ace', label: 'HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c trÃƒÂªn Ã„â€˜Ã¡Â»â„¢ng vÃ¡ÂºÂ­t (SCI-ACE)', enabled: 1 },
  { code: 'personnel', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ NhÃƒÂ¢n lÃ¡Â»Â±c KHCN', enabled: 0 },
  { code: 'ip', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ TÃƒÂ i sÃ¡ÂºÂ£n TrÃƒÂ­ tuÃ¡Â»â€¡', enabled: 0 },
  { code: 'finance', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ TÃƒÂ i chÃƒÂ­nh KHCN', enabled: 0 },
  { code: 'publications', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ CÃƒÂ´ng bÃ¡Â»â€˜ Khoa hÃ¡Â»Âc', enabled: 0 },
  { code: 'cooperation', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c', enabled: 1 },
  { code: 'equipment_stims', label: 'QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹', enabled: 1 },
  { code: 'sample_storage', label: 'NgÃƒÂ¢n hÃƒÂ ng TÃ¡ÂºÂ¿ bÃƒÂ o & KhÃƒÂ¡ng thÃ¡Â»Æ’', enabled: 1 },
  { code: 'tech_transfer', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ ChuyÃ¡Â»Æ’n giao CÃƒÂ´ng nghÃ¡Â»â€¡', enabled: 0 },
  { code: 'facilities', label: 'CRD Lab Booking', enabled: 1 },
  { code: 'ethics_integrity', label: 'Ã„ÂÃ¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c vÃƒÂ  LiÃƒÂªm chÃƒÂ­nh khoa hÃ¡Â»Âc', enabled: 0 },
  { code: 'reward', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ Khen thÃ†Â°Ã¡Â»Å¸ng & Ã„ÂÃƒÂ¡nh giÃƒÂ¡', enabled: 0 },
  { code: 'dms', label: 'QuÃ¡ÂºÂ£n lÃƒÂ½ tÃƒÂ i liÃ¡Â»â€¡u & hÃ¡Â»â€œ sÃ†Â¡ (HÃƒÂ nh chÃƒÂ­nh)', enabled: 1 },
  { code: 'document_workflow', label: 'Quy trÃƒÂ¬nh vÃ„Æ’n bÃ¡ÂºÂ£n nÃ¡Â»â„¢i bÃ¡Â»â„¢', enabled: 1 },
  { code: 'department_reports', label: 'BÃƒÂ¡o cÃƒÂ¡o phÃƒÂ²ng ban', enabled: 1 },
];

(function migrateHomepageModuleSortOrder() {
  try {
    db.prepare('ALTER TABLE homepage_modules ADD COLUMN sort_order INTEGER DEFAULT 0').run();
  } catch (e) { /* cÃ¡Â»â„¢t Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i */ }
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

/** XÃƒÂ³a dÃƒÂ²ng homepage_modules sai (vd. code=reorder do route /:code nuÃ¡Â»â€˜t path /reorder) vÃƒÂ  sÃ¡Â»Â­a JSON homepage_module_order */
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

/** NÃ¡Â»â€˜i mÃƒÂ£ document_workflow vÃƒÂ o JSON thÃ¡Â»Â© tÃ¡Â»Â± cÃ…Â© (13 mÃƒÂ£) Ã„â€˜Ã¡Â»Æ’ kÃƒÂ©o thÃ¡ÂºÂ£ admin khÃƒÂ´ng lÃ¡Â»â€”i */
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

/** BÃ¡Â»â€¢ sung dÃƒÂ²ng homepage_modules mÃ¡Â»â€ºi (sau khi mÃ¡Â»Å¸ rÃ¡Â»â„¢ng HOMEPAGE_MODULES_DEFAULT) */
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

/** Module QuÃ¡ÂºÂ£n lÃƒÂ½ tÃƒÂ i liÃ¡Â»â€¡u & hÃ¡Â»â€œ sÃ†Â¡ (DMS / hÃƒÂ nh chÃƒÂ­nh) */
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
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN external_scan_link TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN import_sheet TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN external_word_link TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_location TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_copy_type TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_sheet_count INTEGER').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN physical_page_count INTEGER').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN retention_until TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN destruction_eligible_date TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN parent_case_ref TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN template_id INTEGER').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_code TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_at TEXT').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
}
try {
  db.prepare('ALTER TABLE dms_documents ADD COLUMN digitized_by_id INTEGER REFERENCES users(id)').run();
} catch (e) {
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */
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
/** NgÃ†Â°Ã¡Â»Âi Ã„â€˜ÃƒÂ£ cÃƒÂ³ vai trÃƒÂ² module trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y Ã¢â€ â€™ tÃ¡Â»Â± thÃƒÂªm vÃƒÂ o danh sÃƒÂ¡ch mÃ¡Â»Å¸ truy cÃ¡ÂºÂ­p (mÃ¡Â»â„¢t lÃ¡ÂºÂ§n). */
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
/** NgÃ†Â°Ã¡Â»Âi Ã„â€˜ÃƒÂ£ mÃ¡Â»Å¸ truy cÃ¡ÂºÂ­p module nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ dÃƒÂ²ng dms_user_roles Ã¢â€ â€™ mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh viewer (mÃ¡Â»â„¢t lÃ¡ÂºÂ§n). */
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
    const r1 = ins.run(null, 'VÃ„Æ’n bÃ¡ÂºÂ£n phÃƒÂ¡p lÃƒÂ½ nÃ¡Â»â„¢i bÃ¡Â»â„¢', 1);
    const p1 = r1.lastInsertRowid;
    ins.run(p1, 'QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh', 1);
    ins.run(p1, 'Quy chÃ¡ÂºÂ¿ / Quy Ã„â€˜Ã¡Â»â€¹nh', 2);
    ins.run(null, 'HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng & ThÃ¡Â»Âa thuÃ¡ÂºÂ­n', 2);
    ins.run(null, 'HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i KHCN', 3);
    ins.run(null, 'BiÃƒÂªn bÃ¡ÂºÂ£n & TÃ¡Â»Â trÃƒÂ¬nh', 4);
    ins.run(null, 'KÃ¡ÂºÂ¿ hoÃ¡ÂºÂ¡ch & CÃƒÂ´ng vÃ„Æ’n', 5);
    const tins = db.prepare(
      'INSERT INTO dms_document_types (name, code, sort_order, is_active) VALUES (?, ?, ?, 1)'
    );
    tins.run('Quy chÃ¡ÂºÂ¿ nÃ¡Â»â„¢i bÃ¡Â»â„¢', 'quy_che', 1);
    tins.run('QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh', 'quyet_dinh', 2);
    tins.run('HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng', 'hop_dong', 3);
    tins.run('BiÃƒÂªn bÃ¡ÂºÂ£n', 'bien_ban', 4);
    tins.run('CÃƒÂ´ng vÃ„Æ’n', 'cong_van', 5);
    const tagIns = db.prepare('INSERT OR IGNORE INTO dms_tags (name, color, sort_order) VALUES (?, ?, ?)');
    tagIns.run('KHCN', '#2563eb', 1);
    tagIns.run('TSTT / IP', '#7c3aed', 2);
    tagIns.run('NhÃƒÂ¢n sÃ¡Â»Â±', '#0891b2', 3);
    tagIns.run('TÃƒÂ i chÃƒÂ­nh', '#047857', 4);
    tagIns.run('PhÃƒÂ¡p lÃƒÂ½', '#b45309', 5);
  } catch (e) {
    console.warn('[DB] seedDmsCatalogIfEmpty:', e.message || e);
  }
})();

/** GÃƒÂ¡n category_id xuÃ¡Â»â€˜ng mÃ¡Â»Â¥c con khi bÃ¡ÂºÂ£n ghi Ã„â€˜ang Ã¡Â»Å¸ danh mÃ¡Â»Â¥c cÃ¡ÂºÂ¥p trÃƒÂªn nhÃ†Â°ng loÃ¡ÂºÂ¡i tÃƒÂ i liÃ¡Â»â€¡u trÃƒÂ¹ng tÃƒÂªn mÃ¡Â»Â¥c con (VD: nhÃƒÂ³m Ã‚Â«VÃ„Æ’n bÃ¡ÂºÂ£nÃ¢â‚¬Â¦Ã‚Â» + loÃ¡ÂºÂ¡i Ã‚Â«QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nhÃ‚Â» Ã¢â€ â€™ mÃ¡Â»Â¥c QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh). Idempotent mÃ¡Â»â€”i lÃ¡ÂºÂ§n khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng. */
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

// Email (cÃ¡ÂºÂ¥u hÃƒÂ¬nh qua biÃ¡ÂºÂ¿n mÃƒÂ´i trÃ†Â°Ã¡Â»Âng)
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

/** From gÃ¡Â»Â­i SMTP: cÃƒÂ³ tÃƒÂªn hiÃ¡Â»Æ’n thÃ¡Â»â€¹ (trÃƒÂ¡nh Gmail hiÃ¡Â»â€¡n chÃ¡Â»â€° local-part nhÃ†Â° ntsinh0409). SMTP_FROM cÃƒÂ³ thÃ¡Â»Æ’: Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° email; "TÃƒÂªn" <email>; hoÃ¡ÂºÂ·c chÃ¡Â»â€° tÃƒÂªn (khÃƒÂ´ng cÃƒÂ³ @) Ã¢â€ â€™ dÃƒÂ¹ng cÃƒÂ¹ng SMTP_USER lÃƒÂ m Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€°. SMTP_FROM_NAME: tÃƒÂªn mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh khi SMTP_FROM lÃƒÂ  email thuÃ¡ÂºÂ§n. */
function getSmtpFrom() {
  const raw = (process.env.SMTP_FROM || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  if (raw.includes('<') && raw.includes('>')) {
    return raw;
  }
  // ChÃ¡Â»â€° tÃƒÂªn hiÃ¡Â»Æ’n thÃ¡Â»â€¹, vÃƒÂ­ dÃ¡Â»Â¥ STIMS SCI Ã¢â‚¬â€ gÃ¡Â»Â­i tÃ¡Â»Â« Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° SMTP_USER
  if (raw && !raw.includes('@')) {
    if (!user) return undefined;
    return { name: raw, address: user };
  }
  const address = (raw.includes('@') ? raw : user) || '';
  if (!address) return undefined;
  const name = (process.env.SMTP_FROM_NAME || 'HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ­ KHCN&Ã„ÂMST SCI').trim();
  if (!name) return address;
  return { name, address };
}

function getCouncilEmails() {
  return emailsWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']);
}

/** Email cÃ¡Â»Â§a mÃ¡Â»Âi user cÃƒÂ³ role PhÃƒÂ²ng KHCN Ã¢â‚¬â€ dÃƒÂ¹ng lÃƒÂ m ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n (TO) khi nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi, vÃƒÂ  CC khi thÃƒÂ´ng bÃƒÂ¡o kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ duyÃ¡Â»â€¡t (Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n). */
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

// Danh sÃƒÂ¡ch email nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o: Ã†Â°u tiÃƒÂªn bÃ¡ÂºÂ£ng notification_recipients (Admin quÃ¡ÂºÂ£n lÃƒÂ½), khÃƒÂ´ng cÃƒÂ³ thÃƒÂ¬ NOTIFICATION_EMAILS, rÃ¡Â»â€œi HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng trong DB
function getNotificationEmails(notificationKey) {
  const resolvedKey = notificationKey || 'generic_council_notice';
  let baseList = [];
  try {
    const rows = db.prepare('SELECT email FROM notification_recipients ORDER BY id').all();
    if (rows && rows.length > 0) {
      baseList = rows.map(r => (r.email || '').trim().toLowerCase()).filter(Boolean);
      return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
    }
  } catch (e) { /* bÃ¡ÂºÂ£ng chÃ†Â°a cÃƒÂ³ */ }
  const envList = (process.env.NOTIFICATION_EMAILS || '').trim();
  if (envList) {
    baseList = envList.split(/[,;]/).map(e => e.trim().toLowerCase()).filter(Boolean);
    return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
  }
  baseList = getCouncilEmails();
  return applyCouncilMemberControlToRecipients(applyChairmanControlToRecipients(baseList, resolvedKey), resolvedKey);
}

// Module HÃ¡Â»Â£p tÃƒÂ¡c quÃ¡Â»â€˜c tÃ¡ÂºÂ¿: lÃ¡ÂºÂ¥y email nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o theo topic (doan_ra, mou, ...) hoÃ¡ÂºÂ·c 'all'
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

// TrÃ¡ÂºÂ£ vÃ¡Â»Â { to: [email ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng], cc: [cÃƒÂ¡c email khÃƒÂ¡c] } Ã¢â‚¬â€ dÃƒÂ¹ng cho email MOU (KÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng, CC nhÃ¡Â»Â¯ng ngÃ†Â°Ã¡Â»Âi cÃƒÂ²n lÃ¡ÂºÂ¡i)
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

/** Email PhÃƒÂ²ng KHCN + ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n theo topic (khÃƒÂ´ng gÃ¡Â»â€œm ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng) Ã¢â‚¬â€ dÃƒÂ¹ng cho nhÃ¡ÂºÂ¯c viÃ¡Â»â€¡c theo tÃ¡Â»Â«ng loÃ¡ÂºÂ¡i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t */
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

/** ThÃƒÂ´ng bÃƒÂ¡o tÃ¡Â»â€ºi PhÃƒÂ²ng KHCN (TO), CC ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã¢â‚¬â€ khi ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i / kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t */
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
    console.warn('[coopNotifyPhongToCcVt] KhÃƒÂ´ng cÃƒÂ³ ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n TO:', topic);
    return Promise.resolve();
  }
  cc = [...new Set(cc)].filter(e => to.indexOf(e) < 0);
  return coopSendMail({ to, cc: cc.length ? cc : undefined, subject: opts.subject, html: opts.html, text: opts.text });
}

function coopAssertSubmitter(req, row) {
  const e = (req.user && req.user.email || '').trim().toLowerCase();
  const se = (row.submitted_by_email || '').trim().toLowerCase();
  if (!se || e !== se) return { ok: false, message: 'ChÃ¡Â»â€° ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t mÃ¡Â»â€ºi thÃ¡Â»Â±c hiÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c thao tÃƒÂ¡c nÃƒÂ y.' };
  return { ok: true };
}

/** TÃ¡Â»Â« chÃ¡Â»â€˜i (PhÃƒÂ²ng hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng): email ngÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p Ã¢â‚¬â€ quy trÃƒÂ¬nh kÃ¡ÂºÂ¿t thÃƒÂºc; hÃ¡Â»â€œ sÃ†Â¡ & coop_history giÃ¡Â»Â¯ nguyÃƒÂªn; chÃ¡Â»â€° admin xÃƒÂ³a. */
function coopSendMailTuChoi(loaiKey, row, id, who, note) {
  if (!row || !row.submitted_by_email) return Promise.resolve();
  const ma = row.ma_de_xuat || coopGenMa(loaiKey, id);
  const whoLabel = who === 'phong' ? 'PhÃƒÂ²ng KHCN&QHÃ„ÂN' : 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng';
  const titleByLoai = { doan_ra: 'Ã„ÂoÃƒÂ n ra', doan_vao: 'Ã„ÂoÃƒÂ n vÃƒÂ o', mou: 'MOU / ThÃ¡Â»Âa thuÃ¡ÂºÂ­n', ytnn: 'Ã„ÂÃ¡Â»Â tÃƒÂ i cÃƒÂ³ yÃ¡ÂºÂ¿u tÃ¡Â»â€˜ nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i' };
  const t = titleByLoai[loaiKey] || 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t';
  const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
  const subj = `[HÃ¡Â»Â£p tÃƒÂ¡c QT] TÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã¢â‚¬â€ ${t} Ã¢â‚¬â€ ${ma}`;
  const intro = `<strong>${whoLabel}</strong> Ã„â€˜ÃƒÂ£ <strong>tÃ¡Â»Â« chÃ¡Â»â€˜i</strong> Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t. <strong>Quy trÃƒÂ¬nh xÃ¡Â»Â­ lÃƒÂ½ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nÃƒÂ y Ã„â€˜ÃƒÂ£ kÃ¡ÂºÂ¿t thÃƒÂºc.</strong> DÃ¡Â»Â¯ liÃ¡Â»â€¡u vÃƒÂ  lÃ¡Â»â€¹ch sÃ¡Â»Â­ thao tÃƒÂ¡c vÃ¡ÂºÂ«n Ã„â€˜Ã†Â°Ã¡Â»Â£c lÃ†Â°u trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng; chÃ¡Â»â€° QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ viÃƒÂªn cÃƒÂ³ thÃ¡Â»Æ’ xÃƒÂ³a bÃ¡ÂºÂ£n ghi nÃ¡ÂºÂ¿u cÃ¡ÂºÂ§n.`;
  return coopSendMail({
    to: [row.submitted_by_email],
    subject: subj,
    html: coopBuildEmail(`ThÃƒÂ´ng bÃƒÂ¡o tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (${t})`, intro,
      [['MÃƒÂ£', ma], ['ÃƒÂ kiÃ¡ÂºÂ¿n / lÃƒÂ½ do', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
    text: `${whoLabel} Ã„â€˜ÃƒÂ£ tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ${ma}. Quy trÃƒÂ¬nh kÃ¡ÂºÂ¿t thÃƒÂºc. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}\n${modUrl}`
  });
}

function sendNotificationToCouncil(submissionTitle, submittedByEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) {
    if (!transporter) console.log('[Email] BÃ¡Â»Â qua: chÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh SMTP (kiÃ¡Â»Æ’m tra file .env cÃƒÂ³ SMTP_HOST, SMTP_USER)');
    else console.log('[Email] BÃ¡Â»Â qua: chÃ†Â°a cÃƒÂ³ ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n (thÃƒÂªm trong QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ Ã¢â€ â€™ Danh sÃƒÂ¡ch ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n email)');
    return Promise.resolve();
  }
  console.log('[Email] GÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o hÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi tÃ¡Â»â€ºi: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject: '[SCI-ACE] HÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p: ' + submissionTitle,
    text: 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn ' + submittedByEmail + ' vÃ¡Â»Â«a nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃƒÂ o khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡Â»Æ’ xem vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡.',
    html: '<p>NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn <strong>' + submittedByEmail + '</strong> vÃ¡Â»Â«a nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡: <strong>' + submissionTitle + '</strong>.</p><p>Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃƒÂ o <a href="' + (process.env.BASE_URL || 'http://localhost:' + PORT) + '/hoi-dong.html">khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> Ã„â€˜Ã¡Â»Æ’ xem vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡.</p>'
  }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i:', err.message));
}

/** ThÃƒÂ´ng bÃƒÂ¡o tÃ¡Â»â€ºi HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng khi NCV nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ sau khi ThÃ†Â° kÃƒÂ½ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung (GÃ„Â3). */
function sendResubmitEmail(submissionTitle, submittedByEmail) {
  const toList = getNotificationEmails();
  if (!transporter || toList.length === 0) return Promise.resolve();
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject: '[SCI-ACE] HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i sau bÃ¡Â»â€¢ sung: ' + submissionTitle,
    text: 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn ' + submittedByEmail + ' Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ (sau khi Ã„â€˜Ã†Â°Ã¡Â»Â£c yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung): ' + submissionTitle + '. Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃƒÂ o khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡Â»Æ’ kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i.',
    html: '<p>NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn <strong>' + submittedByEmail + '</strong> Ã„â€˜ÃƒÂ£ <strong>nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i</strong> hÃ¡Â»â€œ sÃ†Â¡ (sau khi Ã„â€˜Ã†Â°Ã¡Â»Â£c yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung): <strong>' + submissionTitle + '</strong>.</p><p>Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃƒÂ o <a href="' + (process.env.BASE_URL || 'http://localhost:' + PORT) + '/hoi-dong.html">khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> Ã„â€˜Ã¡Â»Æ’ kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i.</p>'
  }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i:', err.message));
}

/** GÃ¡Â»Â­i email thÃƒÂ´ng bÃƒÂ¡o tin nhÃ¡ÂºÂ¯n mÃ¡Â»â€ºi trÃƒÂªn kÃƒÂªnh chung CRD cho ngÃ†Â°Ã¡Â»Âi Ã„â€˜ÃƒÂ£ bÃ¡ÂºÂ­t thÃƒÂ´ng bÃƒÂ¡o */
function crdSendBroadcastEmailNotification(senderPersonId, message, ts) {
  if (!transporter) {
    console.log('[CRD broadcast] BÃ¡Â»Â qua email: chÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh SMTP');
    return Promise.resolve();
  }
  const sender = db.prepare('SELECT name, email FROM crd_persons WHERE id = ?').get(senderPersonId);
  if (!sender) return Promise.resolve();
  const senderName = sender.name || sender.email || 'NgÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng CRD';
  const senderEmail = sender.email || '';

  // LÃ¡ÂºÂ¥y user_id cÃ¡Â»Â§a ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh notify chÃƒÂ­nh mÃƒÂ¬nh
  const senderRow = db.prepare('SELECT user_id FROM crd_persons WHERE id = ?').get(senderPersonId);
  const senderUserId = senderRow && senderRow.user_id != null ? Number(senderRow.user_id) : null;

  // LÃ¡ÂºÂ¥y danh sÃƒÂ¡ch user cÃƒÂ³ crd_email_notif = 1 vÃƒÂ  khÃƒÂ´ng phÃ¡ÂºÂ£i chÃƒÂ­nh mÃƒÂ¬nh
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
    console.log('[CRD broadcast] KhÃƒÂ´ng cÃƒÂ³ ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n email thÃƒÂ´ng bÃƒÂ¡o');
    return Promise.resolve();
  }

  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const chatUrl = baseUrl + '/crd-booking-v2.html';
  const preview = message.length > 120 ? message.substring(0, 120) + 'Ã¢â‚¬Â¦' : message;
  const dateStr = new Date(ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const subject = '[SCI-ACE CRD] Tin nhÃ¡ÂºÂ¯n mÃ¡Â»â€ºi trÃƒÂªn KÃƒÂªnh chung Ã¢â‚¬â€ ' + (new Date(ts)).toLocaleDateString('vi-VN');

  const htmlParts = recipients.map(r => {
    const name = r.fullname || r.email || 'bÃ¡ÂºÂ¡n';
    return '<li style="margin-bottom:4px;"><a href="mailto:' + r.email + '">' + name + '</a> &lt;' + r.email + '&gt;</li>';
  }).join('');

  const html = `
<p>Xin chÃƒÂ o,</p>
<p><strong>${senderName}</strong> vÃ¡Â»Â«a gÃ¡Â»Â­i mÃ¡Â»â„¢t tin nhÃ¡ÂºÂ¯n mÃ¡Â»â€ºi trÃƒÂªn <strong>KÃƒÂªnh chung CRD</strong>:</p>
<blockquote style="border-left:4px solid #667eea;margin:12px 0;padding:8px 16px;background:#f8f9ff;color:#333;">
  <em>${preview.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</em>
</blockquote>
<p><strong>NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i:</strong> ${senderName}${senderEmail ? ' (' + senderEmail + ')' : ''}<br>
<strong>ThÃ¡Â»Âi gian:</strong> ${dateStr}</p>
<p>Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃƒÂ o <a href="${chatUrl}">Khu vÃ¡Â»Â±c CRD</a> Ã„â€˜Ã¡Â»Æ’ xem toÃƒÂ n bÃ¡Â»â„¢ tin nhÃ¡ÂºÂ¯n vÃƒÂ  phÃ¡ÂºÂ£n hÃ¡Â»â€œi.</p>
<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">
<p style="font-size:12px;color:#888;">
  BÃ¡ÂºÂ¡n nhÃ¡ÂºÂ­n Ã„â€˜Ã†Â°Ã¡Â»Â£c email nÃƒÂ y vÃƒÂ¬ Ã„â€˜ÃƒÂ£ bÃ¡ÂºÂ­t thÃƒÂ´ng bÃƒÂ¡o CRD trong cÃƒÂ i Ã„â€˜Ã¡ÂºÂ·t tÃƒÂ i khoÃ¡ÂºÂ£n.<br>
  Ã„ÂÃ¡Â»Æ’ tÃ¡ÂºÂ¯t thÃƒÂ´ng bÃƒÂ¡o, vui lÃƒÂ²ng liÃƒÂªn hÃ¡Â»â€¡ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ hoÃ¡ÂºÂ·c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t trong <strong>QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ Ã¢â€ â€™ NgÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng Ã¢â€ â€™ TÃƒÂ i khoÃ¡ÂºÂ£n HÃ¡Â»â€¡ thÃ¡Â»â€˜ng</strong>.
</p>`;

  return transporter.sendMail({
    from: getSmtpFrom(),
    to: recipients.map(r => r.email).join(', '),
    subject,
    html
  }).then(() => {
    console.log('[CRD broadcast] Ã„ÂÃƒÂ£ gÃ¡Â»Â­i email thÃƒÂ´ng bÃƒÂ¡o tÃ¡Â»â€ºi ' + recipients.length + ' ngÃ†Â°Ã¡Â»Âi');
  }).catch(err => {
    console.error('[CRD broadcast email] LÃ¡Â»â€”i:', err.message);
  });
}

// Helper: thÃƒÂ´ng tin bÃ†Â°Ã¡Â»â€ºc hiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i / sÃ¡ÂºÂ¯p tÃ¡Â»â€ºi / ngÃ†Â°Ã¡Â»Âi duyÃ¡Â»â€¡t theo status (Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n)
function getCapVienStepInfo(status) {
  const s = (status || 'SUBMITTED').toUpperCase();
  const map = {
    SUBMITTED: { current: 'BÃ†Â°Ã¡Â»â€ºc 1: NÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh)', next: 'BÃ†Â°Ã¡Â»â€ºc 2: KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh', who: 'ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN' },
    NEED_REVISION: { current: 'BÃ†Â°Ã¡Â»â€ºc 2: KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh (Ã„â€˜ang chÃ¡Â»Â hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung)', next: 'BÃ†Â°Ã¡Â»â€ºc 2: KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh', who: 'ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN' },
    VALIDATED: { current: 'BÃ†Â°Ã¡Â»â€ºc 2: KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh (Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh)', next: 'BÃ†Â°Ã¡Â»â€ºc 3: PhÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n', who: 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN' },
    ASSIGNED: { current: 'BÃ†Â°Ã¡Â»â€ºc 3: PhÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n (Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh)', next: 'BÃ†Â°Ã¡Â»â€ºc 4: Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n', who: '2 PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n' },
    UNDER_REVIEW: { current: 'BÃ†Â°Ã¡Â»â€ºc 4: Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n (Ã„â€˜ang thÃ¡Â»Â±c hiÃ¡Â»â€¡n)', next: 'BÃ†Â°Ã¡Â»â€ºc 4: Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n', who: '2 PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n' },
    REVIEWED: { current: 'BÃ†Â°Ã¡Â»â€ºc 4: Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n (Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh)', next: 'BÃ†Â°Ã¡Â»â€ºc 5: HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n', who: 'HÃ„ÂKHCN' },
    IN_MEETING: { current: 'BÃ†Â°Ã¡Â»â€ºc 5: HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (Ã„â€˜ang thÃ¡Â»Â±c hiÃ¡Â»â€¡n)', next: 'BÃ†Â°Ã¡Â»â€ºc 5: HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng', who: 'HÃ„ÂKHCN' },
    CONDITIONAL: { current: 'BÃ†Â°Ã¡Â»â€ºc 5: HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (Ã„â€˜ÃƒÂ£ hÃ¡Â»Âp)', next: 'BÃ†Â°Ã¡Â»â€ºc 6: CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t', who: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng' },
    APPROVED: { current: 'BÃ†Â°Ã¡Â»â€ºc 6: CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t (Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh)', next: 'BÃ†Â°Ã¡Â»â€ºc 7: KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng thÃ¡Â»Â±c hiÃ¡Â»â€¡n', who: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng & ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m' },
    CONTRACTED: { current: 'BÃ†Â°Ã¡Â»â€ºc 7: KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng (Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh)', next: 'BÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo theo quy Ã„â€˜Ã¡Â»â€¹nh', who: 'Ã¢â‚¬â€' },
    IMPLEMENTATION: { current: 'Ã„Âang thÃ¡Â»Â±c hiÃ¡Â»â€¡n Ã„â€˜Ã¡Â»Â tÃƒÂ i', next: 'BÃƒÂ¡o cÃƒÂ¡o tiÃ¡ÂºÂ¿n Ã„â€˜Ã¡Â»â„¢ / NghiÃ¡Â»â€¡m thu', who: 'Ã¢â‚¬â€' },
    COMPLETED: { current: 'Ã„ÂÃƒÂ£ hoÃƒÂ n thÃƒÂ nh', next: 'Ã¢â‚¬â€', who: 'Ã¢â‚¬â€' },
    REJECTED: { current: 'Ã„ÂÃƒÂ£ dÃ¡Â»Â«ng/tÃ¡Â»Â« chÃ¡Â»â€˜i', next: 'Ã¢â‚¬â€', who: 'Ã¢â‚¬â€' }
  };
  return map[s] || map.SUBMITTED;
}

// Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n: gÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o khi cÃƒÂ³ hÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi nÃ¡Â»â„¢p
function sendCapVienNewSubmissionEmail(opts) {
  const { submissionId, submissionTitle, submittedByEmail, submittedByName, createdAt, status } = opts;
  // Ã†Â¯u tiÃƒÂªn gÃ¡Â»Â­i thÃ¡ÂºÂ³ng tÃ¡Â»â€ºi PhÃƒÂ²ng KHCN (ngÃ†Â°Ã¡Â»Âi xÃ¡Â»Â­ lÃƒÂ½ BÃ†Â°Ã¡Â»â€ºc 2); nÃ¡ÂºÂ¿u chÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh role phong_khcn thÃƒÂ¬ fallback vÃ¡Â»Â danh sÃƒÂ¡ch thÃƒÂ´ng bÃƒÂ¡o cÃ…Â©.
  let toList = getPhongKhcnEmails();
  if (!toList.length) toList = getNotificationEmails('cap_vien_new_submission');
  if (!transporter || toList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn');
  const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : 'Ã¢â‚¬â€';

  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: HÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p: ' + (submissionTitle || '');
  const text =
    'KÃƒÂ­nh gÃ¡Â»Â­i PhÃƒÂ²ng Khoa hÃ¡Â»Âc vÃƒÂ  CÃƒÂ´ng nghÃ¡Â»â€¡,\n\n' +
    'HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c cÃƒÂ³ ghi nhÃ¡ÂºÂ­n hÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi Ã„â€˜Ã„Æ’ng kÃƒÂ­ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TBG do ' + submitterLabel + ' nÃ¡Â»â„¢p.\n\n' +
    'ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:\n- TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n- NgÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- NgÃƒÂ y nÃ¡Â»â„¢p: ' + dateStr + '\n\n' +
    'Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (theo dÃƒÂµi vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡): ' + councilUrl + '\n\n' +
    'HiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i: ' + stepInfo.current + '\n' +
    'SÃ¡ÂºÂ¯p tÃ¡Â»â€ºi: ' + stepInfo.next + '\n' +
    'ChÃ¡Â»Â duyÃ¡Â»â€¡t bÃ¡Â»Å¸i: ' + stepInfo.who + '\n\n' +
    'TrÃƒÂ¢n trÃ¡Â»Âng.';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i PhÃƒÂ²ng Khoa hÃ¡Â»Âc vÃƒÂ  CÃƒÂ´ng nghÃ¡Â»â€¡,</p>' +
    '<p>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c cÃƒÂ³ ghi nhÃ¡ÂºÂ­n hÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi Ã„â€˜Ã„Æ’ng kÃƒÂ­ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> nÃ¡Â»â„¢p.</p>' +
    '<p><strong>ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:</strong></p>' +
    '<ul style="margin:0.5em 0">' +
    '<li>TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
    '<li>NgÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
    '<li>NgÃƒÂ y nÃ¡Â»â„¢p: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
    '</ul>' +
    '<p>Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡Â»Æ’ theo dÃƒÂµi vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡:</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
    '<p><strong>HiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
    '<strong>SÃ¡ÂºÂ¯p tÃ¡Â»â€ºi:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
    '<strong>ChÃ¡Â»Â duyÃ¡Â»â€¡t bÃ¡Â»Å¸i:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng.</p>' +
    '</div>';

  console.log('[Email] GÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (hÃ¡Â»â€œ sÃ†Â¡ mÃ¡Â»â€ºi) tÃ¡Â»â€ºi: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n):', err.message));
}

// Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n Ã¢â‚¬â€ BÃ†Â°Ã¡Â»â€ºc 2: YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â‚¬â€ gÃ¡Â»Â­i nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn (chÃƒÂ­nh) + thÃƒÂ´ng bÃƒÂ¡o HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (phÃ¡Â»Â¥)
function sendCapVienStep2RevisionEmail(submissionTitle, researcherEmail, note, secretaryName, submissionId, researcherName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const resubmitUrl = baseUrl + '/nop-de-tai-cap-vien.html?resubmit=' + (submissionId || '');
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const researcherLabel = (researcherName && researcherName.trim()) ? researcherName.trim() : (researcherEmail || 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn');
  const secLabel = (secretaryName && secretaryName.trim()) ? secretaryName.trim() : 'ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN';
  const noteEsc = String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const noteBlock = note ? '<p><strong>NÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung:</strong></p><p style="white-space:pre-wrap;background:#fff8e1;padding:12px;border-radius:8px">' + noteEsc + '</p>' : '';

  const promises = [];
  if (!transporter) return Promise.all(promises);

  // Email chÃƒÂ­nh: nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn Ã¢â‚¬â€ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡
  if (researcherEmail) {
    const subjectRes = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ (BÃ†Â°Ã¡Â»â€ºc 2): ' + (submissionTitle || '');
    const textRes =
      'KÃƒÂ­nh gÃ¡Â»Â­i ' + researcherLabel + ',\n\n' +
      'ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN Ã„â€˜ÃƒÂ£ kiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n cÃ¡Â»Â§a bÃ¡ÂºÂ¡n vÃƒÂ  yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.\n\n' +
      'NÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung:\n' + (note || '') + '\n\n' +
      'ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n\n' +
      'BÃ¡ÂºÂ¡n cÃ¡ÂºÂ§n chÃ¡Â»â€°nh sÃ¡Â»Â­a vÃƒÂ  bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ theo nÃ¡Â»â„¢i dung trÃƒÂªn, sau Ã„â€˜ÃƒÂ³ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ qua hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.\n\n' +
      'NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡: ' + resubmitUrl + '\nTheo dÃƒÂµi Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + timelineUrl + '\n\n' +
      'TrÃƒÂ¢n trÃ¡Â»Âng,\nHÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n';
    const htmlRes =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃƒÂ­nh gÃ¡Â»Â­i <strong>' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
      '<p>ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN Ã„â€˜ÃƒÂ£ kiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n cÃ¡Â»Â§a bÃ¡ÂºÂ¡n vÃƒÂ  yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.</p>' +
      noteBlock +
      '<p><strong>ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
      '<p>BÃ¡ÂºÂ¡n cÃ¡ÂºÂ§n chÃ¡Â»â€°nh sÃ¡Â»Â­a vÃƒÂ  bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ theo nÃ¡Â»â„¢i dung trÃƒÂªn, sau Ã„â€˜ÃƒÂ³ <strong>nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡</strong> qua hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.</p>' +
      '<p><a href="' + resubmitUrl + '" style="color:#1565c0">NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡</a> &nbsp;|&nbsp; <a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi Ã„â€˜Ã¡Â»Â tÃƒÂ i</a></p>' +
      '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: researcherEmail,
      subject: subjectRes,
      text: textRes,
      html: htmlRes
    }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â€ â€™ NCV):', err.message)));
  }

  // Email phÃ¡Â»Â¥: thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã¢â‚¬â€ thÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Æ’ nÃ¡ÂºÂ¯m thÃƒÂ´ng tin
  const councilList = getNotificationEmails('cap_vien_step2_revision_notice');
  if (councilList.length > 0) {
    const subjectCouncil = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c] (ThÃƒÂ´ng bÃƒÂ¡o) ThÃ†Â° kÃƒÂ½ Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡: ' + (submissionTitle || '');
    const textCouncil =
      'ThÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Æ’ cÃƒÂ¡c thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng nÃ¡ÂºÂ¯m thÃƒÂ´ng tin:\n\n' +
      'ThÃ†Â° kÃƒÂ½ ' + secLabel + ' Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ cho Ã„â€˜Ã¡Â»Â tÃƒÂ i Ã‚Â«' + (submissionTitle || '') + 'Ã‚Â», do nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn ' + (researcherLabel + ' (' + (researcherEmail || '') + ')') + ' nÃ¡Â»â„¢p.\n\n' +
      'NÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung:\n' + (note || '') + '\n\n' +
      'Theo dÃƒÂµi Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + timelineUrl;
    const htmlCouncil =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p><strong>ThÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Æ’ cÃƒÂ¡c thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng nÃ¡ÂºÂ¯m thÃƒÂ´ng tin</strong></p>' +
      '<p>ThÃ†Â° kÃƒÂ½ <strong>' + (secLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ cho Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>, do nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn ' + (researcherLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(researcherEmail || '').replace(/</g, '&lt;')) + ') nÃ¡Â»â„¢p.</p>' +
      noteBlock +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</a></p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: councilList.join(', '),
      subject: subjectCouncil,
      text: textCouncil,
      html: htmlCouncil
    }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â€ â€™ HÃ„Â):', err.message)));
  }
  return Promise.all(promises);
}

// Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n Ã¢â‚¬â€ BÃ†Â°Ã¡Â»â€ºc 2 Ã„â€˜ÃƒÂ£ HÃ¡Â»Â£p lÃ¡Â»â€¡: gÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o (1) nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn, (2) thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
function sendCapVienStep2ValidatedEmail(opts) {
  const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, reviewedByName, hasSupplement } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn');
  const stepInfo = getCapVienStepInfo(status || 'VALIDATED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : 'Ã¢â‚¬â€';
  const reviewedLabel = (reviewedByName && reviewedByName.trim()) ? reviewedByName.trim() : 'ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN';
  const supplementPhrase = hasSupplement ? ' sau khi nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡' : '';

  const promises = [];

  // (1) Email chÃƒÂ­nh: NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn Ã¢â‚¬â€ thÃƒÂ´ng bÃƒÂ¡o hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ hÃ¡Â»Â£p lÃ¡Â»â€¡, chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 3
  if (submittedByEmail) {
    const subjectRes = hasSupplement
      ? '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: HÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c kiÃ¡Â»Æ’m tra hÃ¡Â»Â£p lÃ¡Â»â€¡ (BÃ†Â°Ã¡Â»â€ºc 2): ' + (submissionTitle || '')
      : '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: HÃ¡Â»â€œ sÃ†Â¡ cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c kiÃ¡Â»Æ’m tra hÃ¡Â»Â£p lÃ¡Â»â€¡ (BÃ†Â°Ã¡Â»â€ºc 2): ' + (submissionTitle || '');
    const textRes =
      'KÃƒÂ­nh gÃ¡Â»Â­i ' + submitterLabel + ',\n\n' +
      'ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN Ã„â€˜ÃƒÂ£ kiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n cÃ¡Â»Â§a bÃ¡ÂºÂ¡n' + (hasSupplement ? ' (bao gÃ¡Â»â€œm hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung)' : '') + ' vÃƒÂ  Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u HÃ¡Â»Â£p lÃ¡Â»â€¡' + supplementPhrase + ' (BÃ†Â°Ã¡Â»â€ºc 2 Ã¢â‚¬â€œ KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh).\n\n' +
      'HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 3 (PhÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n).\n\n' +
      'ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\nNgÃƒÂ y nÃ¡Â»â„¢p: ' + dateStr + '\n\n' +
      'Theo dÃƒÂµi Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + timelineUrl + '\n\n' +
      'TrÃƒÂ¢n trÃ¡Â»Âng,\nHÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n';
    const htmlRes =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃƒÂ­nh gÃ¡Â»Â­i <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>,</p>' +
      '<p>ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN (' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ') Ã„â€˜ÃƒÂ£ kiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n cÃ¡Â»Â§a bÃ¡ÂºÂ¡n' + (hasSupplement ? ' (bao gÃ¡Â»â€œm hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung)' : '') + ' vÃƒÂ  Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u <strong>HÃ¡Â»Â£p lÃ¡Â»â€¡' + (supplementPhrase.replace(/</g, '&lt;')) + '</strong> (BÃ†Â°Ã¡Â»â€ºc 2 Ã¢â‚¬â€œ KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh).</p>' +
      '<p>HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang <strong>BÃ†Â°Ã¡Â»â€ºc 3: PhÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n</strong>.</p>' +
      '<p><strong>ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:</strong> ' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '<br>NgÃƒÂ y nÃ¡Â»â„¢p: ' + (String(dateStr).replace(/</g, '&lt;')) + '</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</a></p>' +
      '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: submittedByEmail,
      subject: subjectRes,
      text: textRes,
      html: htmlRes
    }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (BÃ†Â°Ã¡Â»â€ºc 2 HÃ¡Â»Â£p lÃ¡Â»â€¡ Ã¢â€ â€™ NCV):', err.message)));
  }

  // (2) Email phÃ¡Â»Â¥: ThÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã¢â‚¬â€ thÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Æ’ nÃ¡ÂºÂ¯m thÃƒÂ´ng tin
  const toList = getNotificationEmails('cap_vien_step2_validated_notice');
  if (toList.length > 0) {
    const subjectCouncil = hasSupplement
      ? '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: HÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c kiÃ¡Â»Æ’m tra hÃ¡Â»Â£p lÃ¡Â»â€¡ (BÃ†Â°Ã¡Â»â€ºc 2): ' + (submissionTitle || '')
      : '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c kiÃ¡Â»Æ’m tra hÃ¡Â»Â£p lÃ¡Â»â€¡ (BÃ†Â°Ã¡Â»â€ºc 2): ' + (submissionTitle || '');
    const textCouncil =
      'KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,\n\n' +
      'HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c thÃƒÂ´ng bÃƒÂ¡o: hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TBG do ' + submitterLabel + ' nÃ¡Â»â„¢p Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c ' + reviewedLabel + ' kiÃ¡Â»Æ’m tra vÃƒÂ  Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u HÃ¡Â»Â£p lÃ¡Â»â€¡' + supplementPhrase + ' (BÃ†Â°Ã¡Â»â€ºc 2 Ã¢â‚¬â€œ KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh).\n\n' +
      'ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:\n- TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n- NgÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- NgÃƒÂ y nÃ¡Â»â„¢p: ' + dateStr + '\n\n' +
      'Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (theo dÃƒÂµi vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡): ' + councilUrl + '\n\n' +
      'HiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i: ' + stepInfo.current + '\n' +
      'SÃ¡ÂºÂ¯p tÃ¡Â»â€ºi: ' + stepInfo.next + '\n' +
      'ChÃ¡Â»Â duyÃ¡Â»â€¡t bÃ¡Â»Å¸i: ' + stepInfo.who + '\n\n' +
      'TrÃƒÂ¢n trÃ¡Â»Âng.';
    const htmlCouncil =
      '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
      '<p>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c thÃƒÂ´ng bÃƒÂ¡o: hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TBG do <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> nÃ¡Â»â„¢p Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c <strong>' + (reviewedLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> kiÃ¡Â»Æ’m tra vÃƒÂ  Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u <strong>HÃ¡Â»Â£p lÃ¡Â»â€¡' + (supplementPhrase.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> (BÃ†Â°Ã¡Â»â€ºc 2 Ã¢â‚¬â€œ KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ hÃƒÂ nh chÃƒÂ­nh).</p>' +
      '<p><strong>ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:</strong></p>' +
      '<ul style="margin:0.5em 0">' +
      '<li>TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
      '<li>NgÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
      '<li>NgÃƒÂ y nÃ¡Â»â„¢p: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
      '</ul>' +
      '<p>Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡Â»Æ’ theo dÃƒÂµi vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡:</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
      '<p><strong>HiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
      '<strong>SÃ¡ÂºÂ¯p tÃ¡Â»â€ºi:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
      '<strong>ChÃ¡Â»Â duyÃ¡Â»â€¡t bÃ¡Â»Å¸i:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
      '<p>TrÃƒÂ¢n trÃ¡Â»Âng.</p>' +
      '</div>';
    console.log('[Email] GÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (BÃ†Â°Ã¡Â»â€ºc 2 HÃ¡Â»Â£p lÃ¡Â»â€¡) Ã¢â€ â€™ NCV + HÃ„Â: ' + (submittedByEmail || '') + ', ' + toList.join(', '));
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject: subjectCouncil,
      text: textCouncil,
      html: htmlCouncil
    }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (BÃ†Â°Ã¡Â»â€ºc 2 HÃ¡Â»Â£p lÃ¡Â»â€¡ Ã¢â€ â€™ HÃ„Â):', err.message)));
  }
  return Promise.all(promises);
}

// Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n Ã¢â‚¬â€ NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung: gÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡ÂºÂ¿n cÃƒÂ¡c thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
function sendCapVienSupplementSubmittedEmail(opts) {
  const { submissionTitle, submittedByEmail, submittedByName, createdAt, status, supplementRound } = opts;
  const toList = getNotificationEmails('cap_vien_supplement_submitted_notice');
  if (!transporter || toList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const submitterLabel = (submittedByName && submittedByName.trim()) ? submittedByName.trim() : (submittedByEmail || 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn');
  const stepInfo = getCapVienStepInfo(status || 'SUBMITTED');
  const dateStr = createdAt ? (typeof createdAt === 'string' ? createdAt : new Date(createdAt).toISOString()).replace('T', ' ').substring(0, 19) : 'Ã¢â‚¬â€';
  const roundText = (supplementRound != null && supplementRound >= 1) ? ' (lÃ¡ÂºÂ§n bÃ¡Â»â€¢ sung thÃ¡Â»Â© ' + supplementRound + ')' : '';

  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung' + roundText + ': ' + (submissionTitle || '');
  const text =
    'KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,\n\n' +
    'HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c thÃƒÂ´ng bÃƒÂ¡o: nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn ' + submitterLabel + ' Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung cho Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TBG' + roundText + '.\n\n' +
    'ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:\n- TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n- NgÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p: ' + submitterLabel + ' (' + (submittedByEmail || '') + ')\n- NgÃƒÂ y nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ gÃ¡Â»â€˜c: ' + dateStr + '\n\n' +
    'Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (theo dÃƒÂµi vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡): ' + councilUrl + '\n\n' +
    'HiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i: ' + stepInfo.current + '\n' +
    'SÃ¡ÂºÂ¯p tÃ¡Â»â€ºi: ' + stepInfo.next + '\n' +
    'ChÃ¡Â»Â duyÃ¡Â»â€¡t bÃ¡Â»Å¸i: ' + stepInfo.who + '\n\n' +
    'TrÃƒÂ¢n trÃ¡Â»Âng.';

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
    '<p>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c thÃƒÂ´ng bÃƒÂ¡o: nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn <strong>' + (submitterLabel.replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung cho Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TBG' + (roundText.replace(/</g, '&lt;')) + '.</p>' +
    '<p><strong>ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â tÃƒÂ i:</strong></p>' +
    '<ul style="margin:0.5em 0">' +
    '<li>TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong></li>' +
    '<li>NgÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p: ' + (String(submitterLabel).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ' (' + (String(submittedByEmail || '').replace(/</g, '&lt;')) + ')</li>' +
    '<li>NgÃƒÂ y nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ gÃ¡Â»â€˜c: ' + (String(dateStr).replace(/</g, '&lt;')) + '</li>' +
    '</ul>' +
    '<p>Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡Â»Æ’ theo dÃƒÂµi vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡:</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">' + councilUrl + '</a></p>' +
    '<p><strong>HiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i:</strong> ' + (stepInfo.current.replace(/</g, '&lt;')) + '<br>' +
    '<strong>SÃ¡ÂºÂ¯p tÃ¡Â»â€ºi:</strong> ' + (stepInfo.next.replace(/</g, '&lt;')) + '<br>' +
    '<strong>ChÃ¡Â»Â duyÃ¡Â»â€¡t bÃ¡Â»Å¸i:</strong> ' + (stepInfo.who.replace(/</g, '&lt;')) + '</p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng.</p>' +
    '</div>';

  console.log('[Email] GÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (NCV Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung) tÃ¡Â»â€ºi: ' + toList.join(', '));
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toList.join(', '),
    subject,
    text,
    html
  }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (NCV nÃ¡Â»â„¢p bÃ¡Â»â€¢ sung):', err.message));
}

// Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n Ã¢â‚¬â€ BÃ†Â°Ã¡Â»â€ºc 3: ChÃ¡Â»Â§ tÃ¡Â»â€¹ch phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã¢â‚¬â€ gÃ¡Â»Â­i Ã„â€˜Ã¡ÂºÂ¿n tÃ¡Â»Â«ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n + toÃƒÂ n HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
function sendCapVienStep3AssignEmail(submissionTitle, chairmanName, reviewerEmails, reviewerNames, submissionId) {
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const councilUrl = baseUrl + '/hoi-dong-de-tai-cap-vien.html';
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const reviewersList = reviewerNames && reviewerNames.length ? reviewerNames.join(', ') : (reviewerEmails && reviewerEmails.length ? reviewerEmails.join(', ') : '');
  const htmlAll = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
    '<p>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN <strong>' + (chairmanName || 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n cho hÃ¡Â»â€œ sÃ†Â¡: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p><strong>PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng:</strong> ' + (String(reviewersList).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
    '<p>Giai Ã„â€˜oÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ chuyÃ¡Â»Æ’n sang <strong>BÃ†Â°Ã¡Â»â€ºc 4 Ã¢â‚¬â€œ Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n</strong>. CÃƒÂ¡c thÃƒÂ nh viÃƒÂªn Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng cÃ¡ÂºÂ§n hoÃƒÂ n thÃƒÂ nh phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡ (SCI-TASK-06).</p>' +
    '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const textAll = 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n cho hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n: ' + reviewersList + '. Giai Ã„â€˜oÃ¡ÂºÂ¡n chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 4. ' + baseUrl;
  const promises = [];
  reviewerEmails.forEach((email, i) => {
    const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
    const htmlYou = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃƒÂ­nh gÃ¡Â»Â­i ' + (String(name || email).replace(/</g, '&lt;').replace(/>/g, '&gt;')) + ',</p>' +
      '<p>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN <strong>' + (chairmanName || 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng <strong>bÃ¡ÂºÂ¡n</strong> lÃƒÂ m phÃ¡ÂºÂ£n biÃ¡Â»â€¡n cho hÃ¡Â»â€œ sÃ†Â¡: <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
      '<p>BÃ¡ÂºÂ¡n vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃƒÂ  hoÃƒÂ n thÃƒÂ nh phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡ (SCI-TASK-06) theo quy Ã„â€˜Ã¡Â»â€¹nh.</p>' +
      '<p><a href="' + councilUrl + '" style="color:#1565c0">Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> | <a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
      '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: email,
      subject: '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ¡ÂºÂ¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n: ' + submissionTitle,
      text: 'BÃ¡ÂºÂ¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. ' + baseUrl,
      html: htmlYou
    }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã¢â€ â€™ PB):', err.message)));
  });
  const toList = getNotificationEmails('cap_vien_step3_assign_notice');
  if (toList.length > 0) {
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: toList.join(', '),
      subject: '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: ChÃ¡Â»Â§ tÃ¡Â»â€¹ch Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n (BÃ†Â°Ã¡Â»â€ºc 3): ' + submissionTitle,
      text: textAll,
      html: htmlAll
    }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã¢â€ â€™ HÃ„Â):', err.message)));
  }
  return Promise.all(promises);
}

// BÃ†Â°Ã¡Â»â€ºc 3Ã¢â€ â€™4: Ngay sau khi ChÃ¡Â»Â§ tÃ¡Â»â€¹ch phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã¢â‚¬â€ gÃ¡Â»Â­i TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh (to), CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng khoa hÃ¡Â»Âc
function sendCapVienStep4aNotifyBudgetTeamEmail(opts) {
  const { submissionTitle, submissionId } = opts;
  if (!transporter) return Promise.resolve();
  const budgetTeamEmails = getBudgetTeamEmails();
  const councilList = getNotificationEmails('cap_vien_step4a_budget_cc_notice');
  if (!budgetTeamEmails || budgetTeamEmails.length === 0) {
    console.log('[Email] BÃ¡Â»Â qua gÃ¡Â»Â­i TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh: chÃ†Â°a cÃƒÂ³ thÃƒÂ nh viÃƒÂªn TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh trong hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.');
    return Promise.resolve();
  }
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: ThÃƒÂ´ng bÃƒÂ¡o thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n (BÃ†Â°Ã¡Â»â€ºc 4A) Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh,</p>' +
    '<p>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c trÃƒÂ¢n trÃ¡Â»Âng thÃƒÂ´ng bÃƒÂ¡o: Ã„ÂÃ¡Â»Â tÃƒÂ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 3 (PhÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n) vÃƒÂ  chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 4.</p>' +
    '<p>Ã„ÂÃ¡Â»Â nghÃ¡Â»â€¹ TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh thÃ¡Â»Â±c hiÃ¡Â»â€¡n thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n theo quy Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  nÃ¡Â»â„¢p phiÃ¡ÂºÂ¿u thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh (SCI-BUDGET-01, SCI-BUDGET-02) Ã„â€˜ÃƒÂºng hÃ¡ÂºÂ¡n.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh Ã„â€˜Ã¡Â»Â tÃƒÂ i</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'ThÃƒÂ´ng bÃƒÂ¡o thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n: ' + submissionTitle + '. Ã„ÂÃ¡Â»Â nghÃ¡Â»â€¹ TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh thÃ¡Â»Â±c hiÃ¡Â»â€¡n thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh theo quy Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  nÃ¡Â»â„¢p Ã„â€˜ÃƒÂºng hÃ¡ÂºÂ¡n. ' + timelineUrl;
  const promises = [];
  promises.push(transporter.sendMail({
    from: getSmtpFrom(),
    to: budgetTeamEmails.join(', '),
    cc: councilList && councilList.length > 0 ? councilList.join(', ') : undefined,
    subject,
    text,
    html
  }).catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (thÃƒÂ´ng bÃƒÂ¡o TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh 4A):', err.message)));
  return Promise.all(promises);
}

// BÃ†Â°Ã¡Â»â€ºc 4A: TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â‚¬â€ gÃ¡Â»Â­i ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m (to), CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
function sendCapVienBudgetRevisionRequestEmail(opts) {
  const { submissionTitle, researcherEmail, researcherName, note, requestedByName, submissionId, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a dÃ¡Â»Â± toÃƒÂ¡n Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i,</p>' +
    '<p>TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh Ã„â€˜ÃƒÂ£ xem xÃƒÂ©t dÃ¡Â»Â± toÃƒÂ¡n cÃ¡Â»Â§a Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> vÃƒÂ  yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a nhÃ†Â° sau:</p>' +
    '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + (String(note || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</p>' +
    '<p><strong>NgÃ†Â°Ã¡Â»Âi yÃƒÂªu cÃ¡ÂºÂ§u:</strong> ' + (String(requestedByName || '').replace(/</g, '&lt;')) + '</p>' +
    '<p>QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p hÃ¡Â»â€¡ thÃ¡Â»â€˜ng, truy cÃ¡ÂºÂ­p trang theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh vÃƒÂ  nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i tÃƒÂ i liÃ¡Â»â€¡u tÃƒÂ i chÃƒÂ­nh Ã„â€˜ÃƒÂ£ chÃ¡Â»â€°nh sÃ¡Â»Â­a (PhiÃ¡ÂºÂ¿u thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh SCI-BUDGET-01 vÃƒÂ  TÃ¡Â»Â trÃƒÂ¬nh SCI-BUDGET-02).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh Ã„â€˜Ã¡Â»Â tÃƒÂ i</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung dÃ¡Â»Â± toÃƒÂ¡n: ' + submissionTitle + '\n\nNÃ¡Â»â„¢i dung: ' + (note || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung dÃ¡Â»Â± toÃƒÂ¡n Ã¢â€ â€™ NCV):', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC] ' + subject, text, html })
      .catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung dÃ¡Â»Â± toÃƒÂ¡n Ã¢â€ â€™ HÃ„Â):', err.message)));
  }
  return Promise.all(promises);
}

// BÃ†Â°Ã¡Â»â€ºc 4A: NCV nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â‚¬â€ thÃƒÂ´ng bÃƒÂ¡o HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
function sendCapVienBudgetRevisedSubmittedEmail(opts) {
  const { submissionTitle, researcherName, submissionId, councilList } = opts;
  if (!transporter || !councilList || councilList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u tÃƒÂ i chÃƒÂ­nh chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
    '<p>ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + (String(researcherName || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u tÃƒÂ i chÃƒÂ­nh Ã„â€˜ÃƒÂ£ chÃ¡Â»â€°nh sÃ¡Â»Â­a cho Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p>TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh sÃ¡ÂºÂ½ kiÃ¡Â»Æ’m tra vÃƒÂ  phÃƒÂª duyÃ¡Â»â€¡t hoÃ¡ÂºÂ·c yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung tiÃ¡ÂºÂ¿p.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u tÃƒÂ i chÃƒÂ­nh chÃ¡Â»â€°nh sÃ¡Â»Â­a: ' + submissionTitle + '. ' + timelineUrl;
  return transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
    .catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (NCV nÃ¡Â»â„¢p chÃ¡Â»â€°nh sÃ¡Â»Â­a dÃ¡Â»Â± toÃƒÂ¡n):', err.message));
}

// BÃ†Â°Ã¡Â»â€ºc 4A: TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t Ã¢â‚¬â€ gÃ¡Â»Â­i ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m + HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
function sendCapVienBudgetApprovedEmail(opts) {
  const { submissionTitle, researcherEmail, researcherName, approvedByName, submissionId, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: DÃ¡Â»Â± toÃƒÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh xong Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
    '<p>TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh Ã„â€˜ÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t dÃ¡Â»Â± toÃƒÂ¡n cho Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong>.</p>' +
    '<p><strong>NgÃ†Â°Ã¡Â»Âi phÃƒÂª duyÃ¡Â»â€¡t:</strong> ' + (String(approvedByName || '').replace(/</g, '&lt;')) + '</p>' +
    '<p>LÃ†Â°u ÃƒÂ½: BÃ†Â°Ã¡Â»â€ºc 4 (Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n) vÃƒÂ  BÃ†Â°Ã¡Â»â€ºc 4A (ThÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n) thÃ¡Â»Â±c hiÃ¡Â»â€¡n song song. Ã„ÂÃ¡Â»Â tÃƒÂ i sÃ¡ÂºÂ½ chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 5 (HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng) khi cÃ¡ÂºÂ£ hai bÃ†Â°Ã¡Â»â€ºc Ã„â€˜Ã¡Â»Âu hoÃƒÂ n thÃƒÂ nh.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'DÃ¡Â»Â± toÃƒÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh xong: ' + submissionTitle + '. ' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (phÃƒÂª duyÃ¡Â»â€¡t dÃ¡Â»Â± toÃƒÂ¡n Ã¢â€ â€™ NCV):', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (phÃƒÂª duyÃ¡Â»â€¡t dÃ¡Â»Â± toÃƒÂ¡n Ã¢â€ â€™ HÃ„Â):', err.message)));
  }
  return Promise.all(promises);
}

// BÃ†Â°Ã¡Â»â€ºc 4 & 4A Ã„â€˜Ã¡Â»Âu hoÃƒÂ n thÃƒÂ nh Ã¢â€ â€™ chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ thÃƒÂ´ng bÃƒÂ¡o HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (vÃ„Æ’n phong trang trÃ¡Â»Âng)
function sendCapVienStep5ReadyEmail(opts) {
  const { submissionTitle, submissionId } = opts;
  if (!transporter) return Promise.resolve();
  const councilList = getNotificationEmails('cap_vien_step5_ready_notice');
  if (!councilList || councilList.length === 0) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const timelineUrl = baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: Ã„ÂÃ¡Â»Â tÃƒÂ i Ã„â€˜ÃƒÂ£ sÃ¡ÂºÂµn sÃƒÂ ng HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (BÃ†Â°Ã¡Â»â€ºc 5) Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc vÃƒÂ  CÃƒÂ´ng nghÃ¡Â»â€¡ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c,</p>' +
    '<p>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ KHCN&Ã„ÂMST trÃƒÂ¢n trÃ¡Â»Âng thÃƒÂ´ng bÃƒÂ¡o: Ã„ÂÃ¡Â»Â tÃƒÂ i <strong>' + (String(submissionTitle || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')) + '</strong> Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 4 (Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n) vÃƒÂ  BÃ†Â°Ã¡Â»â€ºc 4A (ThÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n).</p>' +
    '<p>Ã„ÂÃ¡Â»Â tÃƒÂ i hiÃ¡Â»â€¡n Ã„â€˜ÃƒÂ£ sÃ¡ÂºÂµn sÃƒÂ ng chuyÃ¡Â»Æ’n sang <strong>BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€œ HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n</strong> Ã„â€˜Ã¡Â»Æ’ xem xÃƒÂ©t vÃƒÂ  biÃ¡Â»Æ’u quyÃ¡ÂºÂ¿t.</p>' +
    '<p>KÃƒÂ­nh mong QuÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng sÃ¡ÂºÂ¯p xÃ¡ÂºÂ¿p thÃ¡Â»Âi gian vÃƒÂ  tham dÃ¡Â»Â± phiÃƒÂªn hÃ¡Â»Âp theo quy Ã„â€˜Ã¡Â»â€¹nh.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh Ã„â€˜Ã¡Â»Â tÃƒÂ i</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng kÃƒÂ­nh chÃƒÂ o,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n Ã¢â‚¬â€œ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c</p></div>';
  const text = 'Ã„ÂÃ¡Â»Â tÃƒÂ i Ã„â€˜ÃƒÂ£ sÃ¡ÂºÂµn sÃƒÂ ng HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (BÃ†Â°Ã¡Â»â€ºc 5): ' + submissionTitle + '. ' + timelineUrl;
  return transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
    .catch(err => console.error('[Email] LÃ¡Â»â€”i gÃ¡Â»Â­i (chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 5):', err.message));
}

/** Link chi tiÃ¡ÂºÂ¿t tiÃ¡ÂºÂ¿n trÃƒÂ¬nh Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n Ã¢â‚¬â€ BÃ†Â°Ã¡Â»â€ºc 5 */
function capVienStep5DetailUrl(submissionId) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  return baseUrl + '/theo-doi-de-tai-cap-vien-chi-tiet.html?id=' + (submissionId || '');
}
function capVienEmailEsc(s) {
  return String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ThÃ†Â° kÃƒÂ½ HÃ„Â: yÃƒÂªu cÃ¡ÂºÂ§u ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m chÃ¡Â»â€°nh sÃ¡Â»Â­a theo gÃƒÂ³p ÃƒÂ½ (BÃ†Â°Ã¡Â»â€ºc 5)
function sendCapVienStep5SecretaryRevisionRequestEmail(opts) {
  const { submissionTitle, submissionId, round, note, requestedByName, researcherEmail, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ YÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a hÃ¡Â»â€œ sÃ†Â¡ (vÃƒÂ²ng ' + round + ') Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m / QuÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
    '<p><strong>BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN:</strong> Ã„ÂÃ¡Â»Â tÃƒÂ i <strong>' + t + '</strong> Ã¢â‚¬â€ ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i <strong>yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a</strong> theo gÃƒÂ³p ÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng <strong>(vÃƒÂ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>NÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u:</strong></p>' +
    '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + capVienEmailEsc(note) + '</p>' +
    '<p><strong>NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i yÃƒÂªu cÃ¡ÂºÂ§u:</strong> ' + capVienEmailEsc(requestedByName) + '</p>' +
    '<p><strong>ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo:</strong> <strong>ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i</strong> Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p hÃ¡Â»â€¡ thÃ¡Â»â€˜ng, mÃ¡Â»Å¸ tiÃ¡ÂºÂ¿n trÃƒÂ¬nh vÃƒÂ  <strong>nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a</strong>. <strong>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN</strong> cÃƒÂ¹ng cÃƒÂ¡c thÃƒÂ nh viÃƒÂªn liÃƒÂªn quan theo dÃƒÂµi cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh (BÃ†Â°Ã¡Â»â€ºc 5)</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ YÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a (vÃƒÂ²ng ' + round + '): ' + submissionTitle + '\n\n' + (note || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â€ â€™ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng] ' + subject, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â€ â€™ HÃ„Â:', err.message)));
  }
  return Promise.all(promises);
}

// ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â‚¬â€ chÃ¡Â»Â ChÃ¡Â»Â§ tÃ¡Â»â€¹ch xem xÃƒÂ©t
function sendCapVienStep5RevisionUploadedEmail(opts) {
  const { submissionTitle, submissionId, round, fileCount, uploaderName, councilList, researcherEmail } = opts;
  if (!transporter || !councilList || councilList.length === 0) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a (vÃƒÂ²ng ' + round + ') Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ ChÃ¡Â»Â§ tÃ¡Â»â€¹ch / ThÃ†Â° kÃƒÂ½ / ThÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
    '<p><strong>' + capVienEmailEsc(uploaderName) + '</strong> Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p <strong>' + fileCount + '</strong> tÃ¡Â»â€¡p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a cho Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + t + '</strong> <strong>(vÃƒÂ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo:</strong> <strong>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN</strong> xem xÃƒÂ©t trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng: <strong>thÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a</strong> hoÃ¡ÂºÂ·c <strong>yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p</strong>.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">MÃ¡Â»Å¸ tiÃ¡ÂºÂ¿n trÃƒÂ¬nh BÃ†Â°Ã¡Â»â€ºc 5</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a (vÃƒÂ²ng ' + round + '): ' + submissionTitle + '. ' + timelineUrl;
  const re = (researcherEmail || '').trim().toLowerCase();
  const researcherInCouncil = re && councilList.some(e => (e || '').trim().toLowerCase() === re);
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: councilList.join(', '),
    cc: (researcherEmail && !researcherInCouncil) ? researcherEmail : undefined,
    subject,
    text,
    html
  }).catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 nÃ¡Â»â„¢p chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â€ â€™ HÃ„Â:', err.message));
}

// ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„Â: yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p
function sendCapVienStep5ChairRequestMoreEmail(opts) {
  const { submissionTitle, submissionId, round, note, chairName, researcherEmail, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ YÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p (vÃƒÂ²ng ' + round + ') Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m / QuÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng,</p>' +
    '<p><strong>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN</strong> (' + capVienEmailEsc(chairName) + ') Ã„â€˜ÃƒÂ£ <strong>yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p</strong> Ã„â€˜Ã¡Â»â€˜i vÃ¡Â»â€ºi Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + t + '</strong> <strong>(vÃƒÂ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>NÃ¡Â»â„¢i dung gÃƒÂ³p ÃƒÂ½:</strong></p>' +
    '<p style="background:#fff8e1;padding:12px;border-radius:8px;white-space:pre-wrap">' + capVienEmailEsc(note) + '</p>' +
    '<p><strong>ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo:</strong> <strong>ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i</strong> cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t hÃ¡Â»â€œ sÃ†Â¡ theo gÃƒÂ³p ÃƒÂ½ vÃƒÂ  <strong>nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i</strong> trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh BÃ†Â°Ã¡Â»â€ºc 5</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ YÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p (vÃƒÂ²ng ' + round + '): ' + submissionTitle + '\n\n' + (note || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p Ã¢â€ â€™ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: '[CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng] ' + subject, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p Ã¢â€ â€™ HÃ„Â:', err.message)));
  }
  return Promise.all(promises);
}

// ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„Â: thÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a (kÃ¡ÂºÂ¿t thÃƒÂºc vÃƒÂ²ng)
function sendCapVienStep5ChairApprovedRevisionEmail(opts) {
  const { submissionTitle, submissionId, round, chairName, researcherEmail, researcherName, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ Ã„ÂÃƒÂ£ thÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a (vÃƒÂ²ng ' + round + ') Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p><strong>BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN:</strong> Ã„ÂÃ¡Â»Â tÃƒÂ i <strong>' + t + '</strong> Ã¢â‚¬â€ <strong>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN</strong> (' + capVienEmailEsc(chairName) + ') Ã„â€˜ÃƒÂ£ <strong>thÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a</strong> <strong>(vÃƒÂ²ng ' + round + ')</strong>.</p>' +
    '<p><strong>ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo:</strong> ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng cÃƒÂ³ thÃ¡Â»Æ’ tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c cÃƒÂ¡c thao tÃƒÂ¡c BÃ†Â°Ã¡Â»â€ºc 5 trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng (cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin hÃ¡Â»Âp, biÃƒÂªn bÃ¡ÂºÂ£n, ghi nhÃ¡ÂºÂ­n <strong>HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN thÃƒÂ´ng qua</strong> chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 6 khi Ã„â€˜Ã¡Â»Â§ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n).</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ThÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a (vÃƒÂ²ng ' + round + '): ' + submissionTitle + '. ' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    const htmlCn = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃƒÂ­nh gÃ¡Â»Â­i ' + capVienEmailEsc(researcherName || 'QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m') + ',</p>' +
      '<p>BÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + t + '</strong> <strong>(vÃƒÂ²ng ' + round + ')</strong> Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c <strong>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN</strong> thÃƒÂ´ng qua.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
      '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text: text + '\n(ThÃƒÂ´ng bÃƒÂ¡o tÃ¡Â»â€ºi ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m)', html: htmlCn })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 thÃƒÂ´ng qua chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â€ â€™ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 thÃƒÂ´ng qua chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã¢â€ â€™ HÃ„Â:', err.message)));
  }
  return Promise.all(promises);
}

// Ghi nhÃ¡ÂºÂ­n HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN thÃƒÂ´ng qua Ã¢â€ â€™ chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 6
function sendCapVienStep5CouncilPassedEmail(opts) {
  const { submissionTitle, submissionId, researcherEmail, researcherName, councilList, recordedByName } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 hoÃƒÂ n tÃ¡ÂºÂ¥t Ã¢â‚¬â€ ChuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 6 (CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh) Ã¢â‚¬â€ ' + (submissionTitle || '');
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
    '<p><strong>HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN thÃƒÂ´ng qua</strong> Ã„â€˜Ã¡Â»â€˜i vÃ¡Â»â€ºi Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + t + '</strong> Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c ghi nhÃ¡ÂºÂ­n trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng' + (recordedByName ? ' (bÃ¡Â»Å¸i ' + capVienEmailEsc(recordedByName) + ')' : '') + '.</p>' +
    '<p>HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang <strong>BÃ†Â°Ã¡Â»â€ºc 6 Ã¢â‚¬â€ CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t</strong>. KÃƒÂ­nh mÃ¡Â»Âi cÃƒÂ¡c Ã„â€˜Ã¡Â»â€œng chÃƒÂ­ cÃƒÂ³ trÃƒÂ¡ch nhiÃ¡Â»â€¡m theo dÃƒÂµi vÃƒÂ  thÃ¡Â»Â±c hiÃ¡Â»â€¡n bÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo.</p>' +
    '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh Ã„â€˜Ã¡Â»Â tÃƒÂ i</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const text = 'BÃ†Â°Ã¡Â»â€ºc 5 hoÃƒÂ n tÃ¡ÂºÂ¥t Ã¢â‚¬â€ chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 6: ' + submissionTitle + '. ' + timelineUrl;
  const promises = [];
  if (researcherEmail) {
    const htmlCn = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' +
      '<p>KÃƒÂ­nh gÃ¡Â»Â­i ' + capVienEmailEsc(researcherName || 'QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m') + ',</p>' +
      '<p>Ã„ÂÃ¡Â»Â tÃƒÂ i <strong>' + t + '</strong> Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c <strong>ghi nhÃ¡ÂºÂ­n HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN thÃƒÂ´ng qua</strong> vÃƒÂ  chuyÃ¡Â»Æ’n sang <strong>BÃ†Â°Ã¡Â»â€ºc 6</strong>.</p>' +
      '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
      '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject, text, html: htmlCn })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 thÃƒÂ´ng qua HÃ„Â Ã¢â€ â€™ CN:', err.message)));
  }
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 thÃƒÂ´ng qua HÃ„Â Ã¢â€ â€™ HÃ„Â:', err.message)));
  }
  return Promise.all(promises);
}

/** BÃ†Â°Ã¡Â»â€ºc 6 hoÃƒÂ n thÃƒÂ nh Ã¢â‚¬â€ email trÃ¡Â»â€¹nh trÃ¡Â»Âng: TO ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m, CC thÃƒÂ nh viÃƒÂªn nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o HÃ„Â (notification_recipients / HÃ„Â trong DB) */
function sendCapVienStep6CompletedEmail(opts) {
  const { submissionTitle, submissionId, researcherEmail, researcherName, soQd, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const sq = capVienEmailEsc(soQd || 'Ã¢â‚¬â€');
  const subject = 'THÃƒâ€NG BÃƒÂO HÃƒâ‚¬NH CHÃƒÂNH Ã¢â‚¬â€ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c: HoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 6 (CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t) Ã¢â‚¬â€ ' + (submissionTitle || '');
  const wrapOpen = '<div style="font-family:\'Times New Roman\',Times,Georgia,serif;font-size:15px;max-width:680px;line-height:1.6;color:#1a1a1a">';
  const wrapClose = '</div>';
  const htmlBody =
    '<p style="margin:0 0 14px 0;text-align:justify">CÃ„Æ’n cÃ¡Â»Â© quy trÃƒÂ¬nh quÃ¡ÂºÂ£n lÃƒÂ½ nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ khoa hÃ¡Â»Âc vÃƒÂ  cÃƒÂ´ng nghÃ¡Â»â€¡ cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n; HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ Ã„â€˜Ã¡Â»Â tÃƒÂ i xin <strong>trÃƒÂ¢n trÃ¡Â»Âng thÃƒÂ´ng bÃƒÂ¡o</strong> Ã„â€˜Ã¡Â»Æ’ QuÃƒÂ½ Ã„â€˜Ã¡Â»â€œng chÃƒÂ­ biÃ¡ÂºÂ¿t, chÃ¡Â»Â§ Ã„â€˜Ã¡Â»â„¢ng triÃ¡Â»Æ’n khai cÃƒÂ¡c viÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo theo thÃ¡ÂºÂ©m quyÃ¡Â»Ân:</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top;width:36%"><strong>NÃ¡Â»â„¢i dung thÃƒÂ´ng bÃƒÂ¡o</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top">' +
    'Ã„ÂÃƒÂ£ <strong>hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 6 Ã¢â‚¬â€ CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â tÃƒÂ i</strong> trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­.' +
    '</td></tr><tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">' + t + '</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>SÃ¡Â»â€˜ / kÃƒÂ½ hiÃ¡Â»â€¡u QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh</strong><br><span style="font-size:12px;color:#546e7a">(Ã„â€˜ÃƒÂ£ ghi nhÃ¡ÂºÂ­n)</span></td><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>' + sq + '</strong></td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ­nh kÃƒÂ¨m</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">BÃ¡ÂºÂ£n QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh <strong>tiÃ¡ÂºÂ¿ng ViÃ¡Â»â€¡t</strong> vÃƒÂ  <strong>tiÃ¡ÂºÂ¿ng Anh</strong> (bÃ¡ÂºÂ£n scan) Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c lÃ†Â°u trong hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­; QuÃƒÂ½ Ã„â€˜Ã¡Â»â€œng chÃƒÂ­ Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã„â€˜Ã¡Â»Æ’ tra cÃ¡Â»Â©u, tÃ¡ÂºÂ£i vÃ¡Â»Â khi cÃ¡ÂºÂ§n.</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">ChuyÃ¡Â»Æ’n sang <strong>BÃ†Â°Ã¡Â»â€ºc 7 Ã¢â‚¬â€ KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng thÃ¡Â»Â±c hiÃ¡Â»â€¡n</strong>. Ã„ÂÃ¡Â»Â nghÃ¡Â»â€¹ <strong>ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m</strong> phÃ¡Â»â€˜i hÃ¡Â»Â£p chÃ¡ÂºÂ·t chÃ¡ÂºÂ½ vÃ¡Â»â€ºi <strong>PhÃƒÂ²ng Khoa hÃ¡Â»Âc vÃƒÂ  CÃƒÂ´ng nghÃ¡Â»â€¡</strong> vÃƒÂ  cÃƒÂ¡c bÃ¡Â»â„¢ phÃ¡ÂºÂ­n liÃƒÂªn quan Ã„â€˜Ã¡Â»Æ’ chuÃ¡ÂºÂ©n bÃ¡Â»â€¹, rÃƒÂ  soÃƒÂ¡t vÃƒÂ  tiÃ¡ÂºÂ¿n hÃƒÂ nh kÃƒÂ½ kÃ¡ÂºÂ¿t hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng Ã„â€˜ÃƒÂºng tiÃ¡ÂºÂ¿n Ã„â€˜Ã¡Â»â„¢; <strong>HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN ViÃ¡Â»â€¡n</strong> tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c theo dÃƒÂµi, phÃ¡Â»â€˜i hÃ¡Â»Â£p khi cÃ¡ÂºÂ§n thiÃ¡ÂºÂ¿t.</td></tr></table>' +
    '<p style="margin:14px 0 8px 0"><strong>Ã„ÂÃ†Â°Ã¡Â»Âng link theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh:</strong> <a href="' + timelineUrl + '" style="color:#0d47a1">' + timelineUrl + '</a></p>' +
    '<p style="margin:16px 0 0 0;text-align:justify;font-size:13px;color:#455a64"><em>VÃ„Æ’n bÃ¡ÂºÂ£n Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡Â»Â­i tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng tÃ¡Â»Â« HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n nhÃ¡ÂºÂ±m phÃ¡Â»Â¥c vÃ¡Â»Â¥ cÃƒÂ´ng tÃƒÂ¡c hÃƒÂ nh chÃƒÂ­nh vÃƒÂ  lÃ†Â°u vÃ¡ÂºÂ¿t trao Ã„â€˜Ã¡Â»â€¢i.</em></p>' +
    '<p style="margin:20px 0 0 0"><strong>TrÃƒÂ¢n trÃ¡Â»Âng thÃƒÂ´ng bÃƒÂ¡o.</strong></p>';
  const salutationCn = '<p style="margin:0 0 6px 0"><strong>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m' + (researcherName ? ' ' + capVienEmailEsc(researcherName) : '') + ',</strong></p>' +
    '<p style="margin:0 0 12px 0">cc QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n.</p>';
  const salutationHdOnly = '<p style="margin:0 0 12px 0"><strong>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n,</strong></p>';
  const htmlForChuNhiem = wrapOpen + salutationCn + htmlBody + wrapClose;
  const htmlForHdOnly = wrapOpen + salutationHdOnly + htmlBody + wrapClose;
  const text =
    'THÃƒâ€NG BÃƒÂO HÃƒâ‚¬NH CHÃƒÂNH Ã¢â‚¬â€ HoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 6 (CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t).\n' +
    'KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m' + (researcherName ? ' ' + String(researcherName).trim() : '') + ',\n' +
    'cc QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n.\n\n' +
    'Ã„ÂÃ¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n' +
    'SÃ¡Â»â€˜ QÃ„Â ghi nhÃ¡ÂºÂ­n: ' + (soQd || 'Ã¢â‚¬â€') + '\n' +
    'ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo: BÃ†Â°Ã¡Â»â€ºc 7 Ã¢â‚¬â€ KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng thÃ¡Â»Â±c hiÃ¡Â»â€¡n.\n' +
    'Xem tiÃ¡ÂºÂ¿n trÃƒÂ¬nh: ' + timelineUrl;

  const rEmail = String(researcherEmail || '').trim().toLowerCase();
  if (!rEmail) {
    console.warn('[Email] BÃ†Â°Ã¡Â»â€ºc 6 hoÃƒÂ n thÃƒÂ nh: khÃƒÂ´ng cÃƒÂ³ email ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m, chÃ¡Â»â€° gÃ¡Â»Â­i HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng nÃ¡ÂºÂ¿u cÃƒÂ³.');
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
    }).catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 6 hoÃƒÂ n thÃƒÂ nh Ã¢â€ â€™ CN+CC:', err.message)));
  } else if (ccList.length > 0) {
    const textHd =
      'THÃƒâ€NG BÃƒÂO HÃƒâ‚¬NH CHÃƒÂNH Ã¢â‚¬â€ HoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 6 (CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t).\n' +
      'KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n.\n\n' +
      'Ã„ÂÃ¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n' +
      'SÃ¡Â»â€˜ QÃ„Â ghi nhÃ¡ÂºÂ­n: ' + (soQd || 'Ã¢â‚¬â€') + '\n' +
      'ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo: BÃ†Â°Ã¡Â»â€ºc 7 Ã¢â‚¬â€ KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng thÃ¡Â»Â±c hiÃ¡Â»â€¡n.\n' +
      'Xem tiÃ¡ÂºÂ¿n trÃƒÂ¬nh: ' + timelineUrl;
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: ccList.join(', '),
      subject,
      text: textHd + '\n\n(KhÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã†Â°Ã¡Â»Â£c email ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã¢â‚¬â€ chÃ¡Â»â€° gÃ¡Â»Â­i HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng.)',
      html: '<p><em>(KhÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã†Â°Ã¡Â»Â£c email ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã¢â‚¬â€ gÃ¡Â»Â­i danh sÃƒÂ¡ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng nhÃ¡ÂºÂ­n TO.)</em></p>' + htmlForHdOnly
    }).catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 6 hoÃƒÂ n thÃƒÂ nh Ã¢â€ â€™ HÃ„Â only:', err.message)));
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

/** BÃ†Â°Ã¡Â»â€ºc 7 hoÃƒÂ n thÃƒÂ nh Ã¢â‚¬â€ email hÃƒÂ nh chÃƒÂ­nh (TO ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m, CC nhÃ†Â° BÃ†Â°Ã¡Â»â€ºc 6); cÃƒÂ³ thÃ¡Â»Æ’ tÃ¡ÂºÂ¯t trong QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ */
function sendCapVienStep7CompletedEmail(opts) {
  const { submissionTitle, submissionId, researcherEmail, researcherName, councilList } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const t = capVienEmailEsc(submissionTitle);
  const subject = 'THÃƒâ€NG BÃƒÂO HÃƒâ‚¬NH CHÃƒÂNH Ã¢â‚¬â€ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c: HoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 (KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN) Ã¢â‚¬â€ ' + (submissionTitle || '');
  const wrapOpen = '<div style="font-family:\'Times New Roman\',Times,Georgia,serif;font-size:15px;max-width:680px;line-height:1.6;color:#1a1a1a">';
  const wrapClose = '</div>';
  const htmlBody =
    '<p style="margin:0 0 14px 0;text-align:justify">CÃ„Æ’n cÃ¡Â»Â© quy trÃƒÂ¬nh quÃ¡ÂºÂ£n lÃƒÂ½ nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ khoa hÃ¡Â»Âc vÃƒÂ  cÃƒÂ´ng nghÃ¡Â»â€¡ cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n; HÃ¡Â»â€¡ thÃ¡Â»â€˜ng quÃ¡ÂºÂ£n lÃƒÂ½ Ã„â€˜Ã¡Â»Â tÃƒÂ i xin <strong>trÃƒÂ¢n trÃ¡Â»Âng thÃƒÂ´ng bÃƒÂ¡o</strong> Ã„â€˜Ã¡Â»Æ’ QuÃƒÂ½ Ã„â€˜Ã¡Â»â€œng chÃƒÂ­ biÃ¡ÂºÂ¿t, chÃ¡Â»Â§ Ã„â€˜Ã¡Â»â„¢ng triÃ¡Â»Æ’n khai cÃƒÂ¡c viÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo theo thÃ¡ÂºÂ©m quyÃ¡Â»Ân:</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px"><tr><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top;width:36%"><strong>NÃ¡Â»â„¢i dung thÃƒÂ´ng bÃƒÂ¡o</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px;vertical-align:top">' +
    'Ã„ÂÃƒÂ£ <strong>hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 Ã¢â‚¬â€ KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng thÃ¡Â»Â±c hiÃ¡Â»â€¡n</strong> (ghi nhÃ¡ÂºÂ­n trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­). <strong>PhÃƒÂ²ng Khoa hÃ¡Â»Âc vÃƒÂ  CÃƒÂ´ng nghÃ¡Â»â€¡</strong> Ã„â€˜ÃƒÂ£ lÃ†Â°u <strong>HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN</strong> (bÃ¡ÂºÂ£n Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­) vÃƒÂ o hÃ¡Â»â€œ sÃ†Â¡.' +
    '</td></tr><tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">' + t + '</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ­nh kÃƒÂ¨m</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">BÃ¡ÂºÂ£n <strong>HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN</strong> Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c lÃ†Â°u trong hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­; QuÃƒÂ½ Ã„â€˜Ã¡Â»â€œng chÃƒÂ­ Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã„â€˜Ã¡Â»Æ’ tra cÃ¡Â»Â©u, tÃ¡ÂºÂ£i vÃ¡Â»Â khi cÃ¡ÂºÂ§n.</td></tr>' +
    '<tr><td style="border:1px solid #90a4ae;padding:10px 12px"><strong>ViÃ¡Â»â€¡c tiÃ¡ÂºÂ¿p theo</strong></td><td style="border:1px solid #90a4ae;padding:10px 12px">CÃƒÂ¡c bÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo theo quy trÃƒÂ¬nh (vÃƒÂ­ dÃ¡Â»Â¥ <strong>BÃ†Â°Ã¡Â»â€ºc 8 Ã¢â‚¬â€ Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c</strong> vÃƒÂ  triÃ¡Â»Æ’n khai thÃ¡Â»Â±c hiÃ¡Â»â€¡n). Ã„ÂÃ¡Â»Â nghÃ¡Â»â€¹ <strong>ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m</strong> vÃƒÂ  cÃƒÂ¡c Ã„â€˜Ã†Â¡n vÃ¡Â»â€¹ liÃƒÂªn quan tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c phÃ¡Â»â€˜i hÃ¡Â»Â£p vÃ¡Â»â€ºi <strong>PhÃƒÂ²ng KHCN</strong>; <strong>HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN ViÃ¡Â»â€¡n</strong> tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c theo dÃƒÂµi khi cÃ¡ÂºÂ§n.</td></tr></table>' +
    '<p style="margin:14px 0 8px 0"><strong>Ã„ÂÃ†Â°Ã¡Â»Âng link theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh:</strong> <a href="' + timelineUrl + '" style="color:#0d47a1">' + timelineUrl + '</a></p>' +
    '<p style="margin:16px 0 0 0;text-align:justify;font-size:13px;color:#455a64"><em>VÃ„Æ’n bÃ¡ÂºÂ£n Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡Â»Â­i tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng tÃ¡Â»Â« HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n nhÃ¡ÂºÂ±m phÃ¡Â»Â¥c vÃ¡Â»Â¥ cÃƒÂ´ng tÃƒÂ¡c hÃƒÂ nh chÃƒÂ­nh vÃƒÂ  lÃ†Â°u vÃ¡ÂºÂ¿t trao Ã„â€˜Ã¡Â»â€¢i.</em></p>' +
    '<p style="margin:20px 0 0 0"><strong>TrÃƒÂ¢n trÃ¡Â»Âng thÃƒÂ´ng bÃƒÂ¡o.</strong></p>';
  const salutationCn = '<p style="margin:0 0 6px 0"><strong>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m' + (researcherName ? ' ' + capVienEmailEsc(researcherName) : '') + ',</strong></p>' +
    '<p style="margin:0 0 12px 0">cc QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n.</p>';
  const salutationHdOnly = '<p style="margin:0 0 12px 0"><strong>KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n,</strong></p>';
  const htmlForChuNhiem = wrapOpen + salutationCn + htmlBody + wrapClose;
  const htmlForHdOnly = wrapOpen + salutationHdOnly + htmlBody + wrapClose;
  const text =
    'THÃƒâ€NG BÃƒÂO HÃƒâ‚¬NH CHÃƒÂNH Ã¢â‚¬â€ HoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 (KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN).\n' +
    'KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m' + (researcherName ? ' ' + String(researcherName).trim() : '') + ',\n' +
    'cc QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n.\n\n' +
    'Ã„ÂÃ¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n' +
    'NÃ¡Â»â„¢i dung: Ã„ÂÃƒÂ£ hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7; HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN Ã„â€˜ÃƒÂ£ lÃ†Â°u trong hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜iÃ¡Â»â€¡n tÃ¡Â»Â­.\n' +
    'Xem tiÃ¡ÂºÂ¿n trÃƒÂ¬nh: ' + timelineUrl;

  const rEmail = String(researcherEmail || '').trim().toLowerCase();
  if (!rEmail) {
    console.warn('[Email] BÃ†Â°Ã¡Â»â€ºc 7 hoÃƒÂ n thÃƒÂ nh: khÃƒÂ´ng cÃƒÂ³ email ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m, chÃ¡Â»â€° gÃ¡Â»Â­i HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng nÃ¡ÂºÂ¿u cÃƒÂ³.');
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
    }).catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 7 hoÃƒÂ n thÃƒÂ nh Ã¢â€ â€™ CN+CC:', err.message)));
  } else if (ccList.length > 0) {
    const textHd =
      'THÃƒâ€NG BÃƒÂO HÃƒâ‚¬NH CHÃƒÂNH Ã¢â‚¬â€ HoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 (KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN).\n' +
      'KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ thÃ¡ÂºÂ§y cÃƒÂ´ thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Khoa hÃ¡Â»Âc ViÃ¡Â»â€¡n.\n\n' +
      'Ã„ÂÃ¡Â»Â tÃƒÂ i: ' + (submissionTitle || '') + '\n' +
      'Xem tiÃ¡ÂºÂ¿n trÃƒÂ¬nh: ' + timelineUrl;
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: ccList.join(', '),
      subject,
      text: textHd + '\n\n(KhÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã†Â°Ã¡Â»Â£c email ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã¢â‚¬â€ chÃ¡Â»â€° gÃ¡Â»Â­i HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng.)',
      html: '<p><em>(KhÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã†Â°Ã¡Â»Â£c email ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã¢â‚¬â€ gÃ¡Â»Â­i danh sÃƒÂ¡ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng nhÃ¡ÂºÂ­n TO.)</em></p>' + htmlForHdOnly
    }).catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 7 hoÃƒÂ n thÃƒÂ nh Ã¢â€ â€™ HÃ„Â only:', err.message)));
  }
  return Promise.all(promises);
}

// CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin hÃ¡Â»Âp / biÃƒÂªn bÃ¡ÂºÂ£n / tÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m (thÃƒÂ´ng bÃƒÂ¡o chung)
function sendCapVienStep5SecretaryActivityEmail(opts) {
  const { submissionTitle, submissionId, subjectLine, bodyHtml, bodyText, councilList, researcherEmail } = opts;
  if (!transporter) return Promise.resolve();
  const timelineUrl = capVienStep5DetailUrl(submissionId);
  const suffix = '<p><a href="' + timelineUrl + '" style="color:#1565c0">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh BÃ†Â°Ã¡Â»â€ºc 5</a></p><p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n</p></div>';
  const html = '<div style="font-family:Arial,sans-serif;max-width:620px;line-height:1.6">' + bodyHtml + suffix;
  const text = (bodyText || '') + '\n\n' + timelineUrl;
  const promises = [];
  if (councilList && councilList.length > 0) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: councilList.join(', '), subject: subjectLine, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng ThÃ†Â° kÃƒÂ½ Ã¢â€ â€™ HÃ„Â:', err.message)));
  }
  if (researcherEmail) {
    promises.push(transporter.sendMail({ from: getSmtpFrom(), to: researcherEmail, subject: '[ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m] ' + subjectLine, text, html })
      .catch(err => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 5 hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng Ã¢â€ â€™ CN:', err.message)));
  }
  return Promise.all(promises);
}

function sendStage3ResultEmail(submissionTitle, submittedByEmail, decision, comment, reviewerName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const decisionLabels = { pass: 'HÃ¡Â»Â£p lÃ¡Â»â€¡ (chuyÃ¡Â»Æ’n GÃ„Â4)', reject: 'KhÃƒÂ´ng chÃ¡ÂºÂ¥p thuÃ¡ÂºÂ­n', need_supplement: 'YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡', need_revision: 'YÃƒÂªu cÃ¡ÂºÂ§u sÃ¡Â»Â­a hÃ¡Â»â€œ sÃ†Â¡' };
  const label = decisionLabels[decision] || decision;
  const commentBlock = comment ? '<p><strong>NhÃ¡ÂºÂ­n xÃƒÂ©t / YÃƒÂªu cÃ¡ÂºÂ§u:</strong></p><p>' + String(comment).replace(/\n/g, '<br>') + '</p>' : '';
  const needRevisionNote = (decision === 'need_supplement' || decision === 'need_revision')
    ? '<p><strong>BÃ¡ÂºÂ¡n cÃ¡ÂºÂ§n chÃ¡Â»â€°nh sÃ¡Â»Â­a vÃƒÂ  bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ theo nhÃ¡ÂºÂ­n xÃƒÂ©t trÃƒÂªn, sau Ã„â€˜ÃƒÂ³ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i tÃ¡ÂºÂ¡i mÃ¡Â»Â¥c <a href="' + baseUrl + '/ho-so-cua-toi.html">HÃ¡Â»â€œ sÃ†Â¡ cÃ¡Â»Â§a tÃƒÂ´i</a>.</strong></p>'
    : '';
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ kiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ (GÃ„Â3) tÃ¡ÂºÂ¡i HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE.</p>' +
    '<p><strong>HÃ¡Â»â€œ sÃ†Â¡:</strong> ' + submissionTitle + '</p>' +
    '<p><strong>NgÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p:</strong> ' + submittedByEmail + '</p>' +
    '<p><strong>KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£:</strong> ' + label + '</p>' +
    (reviewerName ? '<p><strong>NgÃ†Â°Ã¡Â»Âi kiÃ¡Â»Æ’m tra:</strong> ' + reviewerName + '</p>' : '') +
    commentBlock +
    needRevisionNote +
    '<p>Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p <a href="' + baseUrl + '/hoi-dong.html">Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> hoÃ¡ÂºÂ·c <a href="' + baseUrl + '/ho-so-cua-toi.html">HÃ¡Â»â€œ sÃ†Â¡ cÃ¡Â»Â§a tÃƒÂ´i</a> Ã„â€˜Ã¡Â»Æ’ xem chi tiÃ¡ÂºÂ¿t.</p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p></div>';
  const needRevisionText = (decision === 'need_supplement' || decision === 'need_revision')
    ? '\n\nBÃ¡ÂºÂ¡n cÃ¡ÂºÂ§n chÃ¡Â»â€°nh sÃ¡Â»Â­a vÃƒÂ  bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ theo nhÃ¡ÂºÂ­n xÃƒÂ©t trÃƒÂªn, sau Ã„â€˜ÃƒÂ³ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i tÃ¡ÂºÂ¡i HÃ¡Â»â€œ sÃ†Â¡ cÃ¡Â»Â§a tÃƒÂ´i.'
    : '';
  const text = 'KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ kiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡ (GÃ„Â3): ' + submissionTitle + '\nKÃ¡ÂºÂ¿t quÃ¡ÂºÂ£: ' + label + (comment ? '\nNhÃ¡ÂºÂ­n xÃƒÂ©t: ' + comment : '') + needRevisionText + '\n\n' + baseUrl;
  const promises = [];
  if (transporter) {
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: submittedByEmail,
      subject: '[SCI-ACE] KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ kiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
      text,
      html
    }).catch(err => console.error('Email to researcher:', err.message)));
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] ThÃ†Â° kÃƒÂ½ Ã„â€˜ÃƒÂ£ xÃ¡Â»Â­ lÃƒÂ½ GÃ„Â3 Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
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
  const noteBlock = note ? '<p><strong>Ghi chÃƒÂº:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
  const htmlAll = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng <strong>' + (chairmanName || 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch') + '</strong> Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n cho hÃ¡Â»â€œ sÃ†Â¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p><strong>PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng:</strong> ' + reviewersList + '</p>' +
    noteBlock +
    '<p>Giai Ã„â€˜oÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ chuyÃ¡Â»Æ’n sang <strong>GÃ„Â5 Ã¢â‚¬â€œ Ã„ÂÃƒÂ¡nh giÃƒÂ¡ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n</strong>. CÃƒÂ¡c thÃƒÂ nh viÃƒÂªn Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng cÃ¡ÂºÂ§n upload phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡ (SCI-ACE-PÃ„ÂG).</p>' +
    '<p>Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p <a href="' + baseUrl + '/hoi-dong.html">Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> hoÃ¡ÂºÂ·c <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a> Ã„â€˜Ã¡Â»Æ’ xem chi tiÃ¡ÂºÂ¿t.</p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p></div>';
  const textAll = 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n cho hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n: ' + reviewersList + '. Giai Ã„â€˜oÃ¡ÂºÂ¡n chuyÃ¡Â»Æ’n sang GÃ„Â5. ' + baseUrl;
  const promises = [];
  if (transporter) {
    reviewerEmails.forEach((email, i) => {
      const name = reviewerNames && reviewerNames[i] ? reviewerNames[i] : '';
      const htmlYou = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
        '<p>KÃƒÂ­nh gÃ¡Â»Â­i ' + (name || email) + ',</p>' +
        '<p>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng <strong>' + (chairmanName || 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch') + '</strong> Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng <strong>bÃ¡ÂºÂ¡n</strong> lÃƒÂ m phÃ¡ÂºÂ£n biÃ¡Â»â€¡n cho hÃ¡Â»â€œ sÃ†Â¡: <strong>' + submissionTitle + '</strong>.</p>' +
        noteBlock +
        '<p>BÃ¡ÂºÂ¡n vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃƒÂ  thÃ¡Â»Â±c hiÃ¡Â»â€¡n Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡ (GÃ„Â5), upload phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡ SCI-ACE-PÃ„ÂG theo quy Ã„â€˜Ã¡Â»â€¹nh.</p>' +
        '<p><a href="' + baseUrl + '/hoi-dong.html">Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> | <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a></p>' +
        '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p></div>';
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: email,
        subject: '[SCI-ACE] BÃ¡ÂºÂ¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n: ' + submissionTitle,
        text: 'BÃ¡ÂºÂ¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. ' + baseUrl,
        html: htmlYou
      }).catch(err => console.error('Email to reviewer:', err.message)));
    });
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] ChÃ¡Â»Â§ tÃ¡Â»â€¹ch Ã„â€˜ÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n (GÃ„Â4) Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
        text: textAll,
        html: htmlAll
      }).catch(err => console.error('Email to council GÃ„Â4:', err.message)));
    }
  }
  return Promise.all(promises);
}

function sendDecisionIssuedEmail(submissionTitle, submittedByEmail, trackUrl) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const url = trackUrl || baseUrl + '/theo-doi-ho-so.html';
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜ÃƒÂ£ cÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh (SCI-ACE-QÃ„Â) cho hÃ¡Â»â€œ sÃ†Â¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh cÃƒÂ³ bÃ¡ÂºÂ£n tiÃ¡ÂºÂ¿ng ViÃ¡Â»â€¡t vÃƒÂ  tiÃ¡ÂºÂ¿ng Anh. Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Ã„â€˜Ã¡Â»Æ’ tÃ¡ÂºÂ£i vÃ¡Â»Â.</p>' +
    '<p><a href="' + url + '">Xem chi tiÃ¡ÂºÂ¿t vÃƒÂ  tÃ¡ÂºÂ£i QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p></div>';
  const text = 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh cho hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Ã„â€˜Ã¡Â»Æ’ tÃ¡ÂºÂ£i: ' + url;
  const promises = [];
  if (transporter) {
    if (submittedByEmail) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: submittedByEmail,
        subject: '[SCI-ACE] Ã„ÂÃƒÂ£ cÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email decision to NCV:', err.message)));
    }
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] Ã„ÂÃƒÂ£ cÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email decision to council:', err.message)));
    }
  }
  return Promise.all(promises);
}

// GÃ„Â5 (HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng): ThÃƒÂ´ng bÃƒÂ¡o kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ hÃ¡Â»Âp cho nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn vÃƒÂ  toÃƒÂ n thÃ¡Â»Æ’ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
function sendMeetingResultEmail(submissionTitle, submittedByEmail, decision, note, secretaryName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const decisionLabels = { approved: 'ChÃ¡ÂºÂ¥p thuÃ¡ÂºÂ­n', conditional: 'ChÃ¡ÂºÂ¥p thuÃ¡ÂºÂ­n cÃƒÂ³ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n', rejected: 'KhÃƒÂ´ng chÃ¡ÂºÂ¥p thuÃ¡ÂºÂ­n' };
  const label = decisionLabels[decision] || decision;
  const noteBlock = note ? '<p><strong>Ghi chÃƒÂº:</strong> ' + String(note).replace(/\n/g, '<br>') + '</p>' : '';
  const nextStep = decision === 'rejected'
    ? 'Quy trÃƒÂ¬nh xÃƒÂ©t duyÃ¡Â»â€¡t kÃ¡ÂºÂ¿t thÃƒÂºc tÃ¡ÂºÂ¡i Ã„â€˜ÃƒÂ¢y.'
    : (decision === 'approved' ? 'HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang giai Ã„â€˜oÃ¡ÂºÂ¡n CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh (SCI-ACE-QÃ„Â).' : 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn cÃ¡ÂºÂ§n nÃ¡Â»â„¢p bÃ¡ÂºÂ£n giÃ¡ÂºÂ£i trÃƒÂ¬nh SCI-ACE-04, sau Ã„â€˜ÃƒÂ³ ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng xem xÃƒÂ©t thÃƒÂ´ng qua.');
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (GÃ„Â5) tÃ¡ÂºÂ¡i HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE.</p>' +
    '<p><strong>HÃ¡Â»â€œ sÃ†Â¡:</strong> ' + submissionTitle + '</p>' +
    '<p><strong>KÃ¡ÂºÂ¿t luÃ¡ÂºÂ­n HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng:</strong> ' + label + '</p>' +
    (secretaryName ? '<p><strong>NgÃ†Â°Ã¡Â»Âi ghi nhÃ¡ÂºÂ­n:</strong> ' + secretaryName + '</p>' : '') +
    noteBlock +
    '<p><strong>BÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo:</strong> ' + nextStep + '</p>' +
    '<p>Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p <a href="' + baseUrl + '/theo-doi-ho-so.html">Theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh</a> hoÃ¡ÂºÂ·c <a href="' + baseUrl + '/hoi-dong.html">Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> Ã„â€˜Ã¡Â»Æ’ xem chi tiÃ¡ÂºÂ¿t.</p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p></div>';
  const text = 'KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (GÃ„Â5): ' + submissionTitle + '\nKÃ¡ÂºÂ¿t luÃ¡ÂºÂ­n: ' + label + '\n' + nextStep + (note ? '\nGhi chÃƒÂº: ' + note : '') + '\n\n' + baseUrl;
  const promises = [];
  if (transporter) {
    if (submittedByEmail) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: submittedByEmail,
        subject: '[SCI-ACE] KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
        text,
        html
      }).catch(err => console.error('Email meeting result to researcher:', err.message)));
    }
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] ThÃ†Â° kÃƒÂ½ Ã„â€˜ÃƒÂ£ ghi nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ hÃ¡Â»Âp (GÃ„Â5) Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
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
    '<p>NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn <strong>' + (submittedByName || 'NCV') + '</strong> Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p bÃ¡ÂºÂ£n giÃ¡ÂºÂ£i trÃƒÂ¬nh SCI-ACE-04 cho hÃ¡Â»â€œ sÃ†Â¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng vÃƒÂ  cÃƒÂ¡c thÃƒÂ nh viÃƒÂªn vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Ã„â€˜Ã¡Â»Æ’ tÃ¡ÂºÂ£i file vÃƒÂ  xem xÃƒÂ©t. Sau Ã„â€˜ÃƒÂ³ ChÃ¡Â»Â§ tÃ¡Â»â€¹ch sÃ¡ÂºÂ½ quyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh ThÃƒÂ´ng qua hoÃ¡ÂºÂ·c KhÃƒÂ´ng thÃƒÂ´ng qua.</p>' +
    '<p><a href="' + trackUrl + '">Xem chi tiÃ¡ÂºÂ¿t vÃƒÂ  tÃ¡ÂºÂ£i file giÃ¡ÂºÂ£i trÃƒÂ¬nh</a></p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p></div>';
  const text = 'NCV Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p SCI-ACE-04 cho hÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Ã„â€˜Ã¡Â»Æ’ xem xÃƒÂ©t: ' + trackUrl;
  const councilList = getNotificationEmails();
  if (!transporter || councilList.length === 0) return Promise.resolve();
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: councilList.join(', '),
    subject: '[SCI-ACE] NCV Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p bÃ¡ÂºÂ£n giÃ¡ÂºÂ£i trÃƒÂ¬nh SCI-ACE-04 Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
    text,
    html
  }).catch(err => console.error('Email conditional submit to council:', err.message));
}

function sendConditionalRejectEmail(submissionTitle, submittedByEmail, chairmanName) {
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng <strong>' + (chairmanName || 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch') + '</strong> chÃ†Â°a thÃƒÂ´ng qua bÃ¡ÂºÂ£n giÃ¡ÂºÂ£i trÃƒÂ¬nh SCI-ACE-04 cho hÃ¡Â»â€œ sÃ†Â¡: <strong>' + submissionTitle + '</strong>.</p>' +
    '<p>NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn vui lÃƒÂ²ng nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i tÃƒÂ i liÃ¡Â»â€¡u giÃ¡ÂºÂ£i trÃƒÂ¬nh (SCI-ACE-04) theo yÃƒÂªu cÃ¡ÂºÂ§u. Sau khi nÃ¡Â»â„¢p, ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng sÃ¡ÂºÂ½ xem xÃƒÂ©t lÃ¡ÂºÂ¡i.</p>' +
    '<p>Vui lÃƒÂ²ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p <a href="' + baseUrl + '/hoi-dong.html">Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</a> hoÃ¡ÂºÂ·c <a href="' + baseUrl + '/ho-so-cua-toi.html">HÃ¡Â»â€œ sÃ†Â¡ cÃ¡Â»Â§a tÃƒÂ´i</a> Ã„â€˜Ã¡Â»Æ’ xem chi tiÃ¡ÂºÂ¿t.</p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p></div>';
  const text = 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch chÃ†Â°a thÃƒÂ´ng qua bÃ¡ÂºÂ£n giÃ¡ÂºÂ£i trÃƒÂ¬nh SCI-ACE-04. NCV cÃ¡ÂºÂ§n nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i. HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle + '. ' + baseUrl;
  const promises = [];
  if (transporter) {
    promises.push(transporter.sendMail({
      from: getSmtpFrom(),
      to: submittedByEmail,
      subject: '[SCI-ACE] ChÃ†Â°a thÃƒÂ´ng qua bÃ¡ÂºÂ£n giÃ¡ÂºÂ£i trÃƒÂ¬nh Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
      text,
      html
    }).catch(err => console.error('Email to NCV conditional reject:', err.message)));
    const councilList = getNotificationEmails();
    if (councilList.length > 0) {
      promises.push(transporter.sendMail({
        from: getSmtpFrom(),
        to: councilList.join(', '),
        subject: '[SCI-ACE] ChÃ¡Â»Â§ tÃ¡Â»â€¹ch chÃ†Â°a thÃƒÂ´ng qua bÃ¡ÂºÂ£n giÃ¡ÂºÂ£i trÃƒÂ¬nh Ã¢â‚¬â€œ HÃ¡Â»â€œ sÃ†Â¡: ' + submissionTitle,
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
    subject: '[SCI-ACE] Ã„ÂÃ¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u',
    text: 'BÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u Ã„â€˜Ã¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u. MÃ¡Â»Å¸ link sau trong 1 giÃ¡Â»Â Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u mÃ¡Â»â€ºi: ' + resetUrl,
    html: '<p>BÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u Ã„â€˜Ã¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u.</p><p>NhÃ¡ÂºÂ¥n vÃƒÂ o link sau Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u mÃ¡Â»â€ºi (link cÃƒÂ³ hiÃ¡Â»â€¡u lÃ¡Â»Â±c trong <strong>1 giÃ¡Â»Â</strong>):</p><p><a href="' + resetUrl + '">' + resetUrl + '</a></p><p>NÃ¡ÂºÂ¿u bÃ¡ÂºÂ¡n khÃƒÂ´ng yÃƒÂªu cÃ¡ÂºÂ§u, hÃƒÂ£y bÃ¡Â»Â qua email nÃƒÂ y.</p>'
  }).catch(err => console.error('Email reset error:', err.message));
}

const ROLE_LABELS = { chu_tich: 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch', thu_ky: 'ThÃ†Â° kÃƒÂ½', thanh_vien: 'ThÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng', researcher: 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn', admin: 'Admin', phong_khcn: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN', vien_truong: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng', totruong_tham_dinh_tc: 'TÃ¡Â»â€¢ trÃ†Â°Ã¡Â»Å¸ng TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh TC', thanh_vien_tham_dinh_tc: 'ThÃƒÂ nh viÃƒÂªn TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh TC' };

function sendRoleAssignmentEmail(toEmail, fullname, role, tempPassword) {
  if (!transporter) return Promise.resolve();
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const loginUrl = baseUrl + '/dang-nhap.html';
  const roleLabel = ROLE_LABELS[role] || role;
  const greeting = fullname ? 'KÃƒÂ­nh gÃ¡Â»Â­i ' + fullname + ',' : 'KÃƒÂ­nh gÃ¡Â»Â­i,';
  let passwordBlock = '';
  if (tempPassword) {
    passwordBlock = '<p><strong>MÃ¡ÂºÂ­t khÃ¡ÂºÂ©u tÃ¡ÂºÂ¡m Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p lÃ¡ÂºÂ§n Ã„â€˜Ã¡ÂºÂ§u:</strong> <code style="background:#f0f0f0;padding:4px 8px;">' + tempPassword + '</code></p><p>BÃ¡ÂºÂ¡n nÃƒÂªn Ã„â€˜Ã¡Â»â€¢i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u sau khi Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p (dÃƒÂ¹ng chÃ¡Â»Â©c nÃ„Æ’ng <strong>QuÃƒÂªn mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u</strong> trÃƒÂªn trang Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p nÃ¡ÂºÂ¿u cÃ¡ÂºÂ§n Ã„â€˜Ã¡ÂºÂ·t lÃ¡ÂºÂ¡i).</p>';
  } else {
    passwordBlock = '<p>NÃ¡ÂºÂ¿u bÃ¡ÂºÂ¡n chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u hoÃ¡ÂºÂ·c quÃƒÂªn mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u, vui lÃƒÂ²ng dÃƒÂ¹ng chÃ¡Â»Â©c nÃ„Æ’ng <strong>QuÃƒÂªn mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u</strong> trÃƒÂªn trang Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p.</p>';
  }
  const html = '<div style="font-family: Arial, sans-serif; max-width: 600px;">' +
    '<p>' + greeting + '</p>' +
    '<p>BÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p vai trÃƒÂ² <strong>' + roleLabel + '</strong> trong HÃ¡Â»â€¡ thÃ¡Â»â€˜ng HÃ¡Â»â€œ sÃ†Â¡ Ã„ÂÃ¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c NghiÃƒÂªn cÃ¡Â»Â©u Ã„ÂÃ¡Â»â„¢ng vÃ¡ÂºÂ­t (SCI-ACE), ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c, TrÃ†Â°Ã¡Â»Âng Ã„ÂÃ¡ÂºÂ¡i hÃ¡Â»Âc Khoa hÃ¡Â»Âc TÃ¡Â»Â± nhiÃƒÂªn, Ã„ÂHQG-HCM.</p>' +
    '<p><strong>ThÃƒÂ´ng tin Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p:</strong></p>' +
    '<p>Ã¢â‚¬Â¢ Email: ' + toEmail + '</p>' +
    passwordBlock +
    '<p><strong>Link Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p:</strong> <a href="' + loginUrl + '">' + loginUrl + '</a></p>' +
    '<p>Sau khi Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p, thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng cÃƒÂ³ thÃ¡Â»Æ’ vÃƒÂ o <strong>Khu vÃ¡Â»Â±c HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng</strong> Ã„â€˜Ã¡Â»Æ’ xem vÃƒÂ  tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡ nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p.</p>' +
    '<p>TrÃƒÂ¢n trÃ¡Â»Âng,<br>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE</p>' +
    '</div>';
  const text = greeting + '\n\nBÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p vai trÃƒÂ² ' + roleLabel + ' trong HÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE.\n\nThÃƒÂ´ng tin Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p:\nÃ¢â‚¬Â¢ Email: ' + toEmail + '\n' + (tempPassword ? 'Ã¢â‚¬Â¢ MÃ¡ÂºÂ­t khÃ¡ÂºÂ©u tÃ¡ÂºÂ¡m: ' + tempPassword + '\n' : '') + '\nLink Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p: ' + loginUrl + '\n\nTrÃƒÂ¢n trÃ¡Â»Âng,\nHÃ¡Â»â€¡ thÃ¡Â»â€˜ng SCI-ACE';
  return transporter.sendMail({
    from: getSmtpFrom(),
    to: toEmail,
    subject: '[SCI-ACE] BÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p vai trÃƒÂ² trong HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„ÂÃ¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c',
    text,
    html
  }).catch(err => console.error('Email role assignment error:', err.message));
}

/** ChuÃ¡ÂºÂ©n hoÃƒÂ¡ origin cho so khÃ¡Â»â€ºp (scheme + host + port, khÃƒÂ´ng path). */
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
    '[FATAL] Production: danh sÃƒÂ¡ch CORS rÃ¡Â»â€”ng. Ã„ÂÃ¡ÂºÂ·t BASE_URL vÃƒÂ /hoÃ¡ÂºÂ·c CORS_ORIGINS (cÃƒÂ¡c origin cÃƒÂ¡ch nhau bÃ¡ÂºÂ±ng dÃ¡ÂºÂ¥u phÃ¡ÂºÂ©y, vÃƒÂ­ dÃ¡Â»Â¥ https://app.example.com,https://admin.example.com).'
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

// Middleware (static Ã„â€˜Ã¡ÂºÂ·t sau API Ã„â€˜Ã¡Â»Æ’ /api/* luÃƒÂ´n do API xÃ¡Â»Â­ lÃƒÂ½)
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
// BibTeX lÃ¡Â»â€ºn (JSON) cÃ¡ÂºÂ§n > 100kb mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh cÃ¡Â»Â§a Express Ã¢â‚¬â€ khÃƒÂ´ng liÃƒÂªn quan giÃ¡Â»â€ºi hÃ¡ÂºÂ¡n file cÃ¡Â»Â§a multer (multipart).
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

/** JWT tÃ¡Â»Â« Authorization: Bearer, cookie HttpOnly, hoÃ¡ÂºÂ·c ?token= (EventSource khÃƒÂ´ng gÃ¡Â»Â­i header). */
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

/** Ghi nhÃ¡ÂºÂ­t kÃƒÂ½ hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng (Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p, truy cÃ¡ÂºÂ­p trang, v.v.). KhÃƒÂ´ng throw. */
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

// Vai trÃƒÂ² HÃ„ÂKHCN (chu_tich/thu_ky/thanh_vien/totruong_tham_dinh_tc/thanh_vien_tham_dinh_tc) vÃƒÂ  PhÃƒÂ²ng
// KHCN (phong_khcn) cÃƒÂ³ thÃ¡Â»Æ’ Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p THÃƒÅ M cho mÃ¡Â»â„¢t user qua bÃ¡ÂºÂ£ng council_role_grants, tÃƒÂ¡ch biÃ¡Â»â€¡t khÃ¡Â»Âi
// users.role (vai trÃƒÂ² hÃ¡Â»â€¡ thÃ¡Â»â€˜ng, vd vien_truong/admin) Ã¢â‚¬â€ Ã„â€˜Ã¡Â»Æ’ 1 ngÃ†Â°Ã¡Â»Âi vÃ¡Â»Â«a giÃ¡Â»Â¯ vai trÃƒÂ² hÃ¡Â»â€¡ thÃ¡Â»â€˜ng khÃƒÂ¡c vÃ¡Â»Â«a
// kiÃƒÂªm nhiÃ¡Â»â€¡m HÃ„ÂKHCN/PhÃƒÂ²ng KHCN mÃƒÂ  khÃƒÂ´ng bÃ¡Â»â€¹ ghi Ã„â€˜ÃƒÂ¨ mÃ¡ÂºÂ¥t vai trÃƒÂ² nÃƒÂ o. Xem module-hoi-dong-khcn admin panel.
const COUNCIL_ROLE_TOKENS = ['chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc', 'phong_khcn'];

// Vai trÃƒÂ² TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh Ã¢â‚¬â€ cÃƒÂ¹ng mÃ¡Â»Â©c bÃ¡ÂºÂ£o vÃ¡Â»â€¡ "chÃ¡Â»â€° Master Admin" nhÃ†Â° vai trÃƒÂ² HÃ„ÂKHCN
// (councilRoles) Ã¡Â»Å¸ cÃƒÂ¡c route cÃ¡ÂºÂ¥p/sÃ¡Â»Â­a/xÃƒÂ³a vai trÃƒÂ² bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi.
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

/** Set cÃƒÂ¡c role "hiÃ¡Â»â€¡u lÃ¡Â»Â±c" cÃ¡Â»Â§a 1 user object {id, role}: role hÃ¡Â»â€¡ thÃ¡Â»â€˜ng + mÃ¡Â»Âi council_role_grants. */
function userEffectiveRoleSet(user) {
  if (!user) return new Set();
  const base = String(user.role || '').trim().toLowerCase();
  const set = new Set(base ? [base] : []);
  getCouncilRoleGrants(user.id).forEach((r) => set.add(r));
  return set;
}

/** NhÃ†Â° trÃƒÂªn nhÃ†Â°ng nhÃ¡ÂºÂ­n req (req.user) Ã¢â‚¬â€ cache trÃƒÂªn req Ã„â€˜Ã¡Â»Æ’ khÃ¡Â»Âi query lÃ¡ÂºÂ¡i nhiÃ¡Â»Âu lÃ¡ÂºÂ§n / request. */
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

/** email cÃ¡Â»Â§a mÃ¡Â»Âi user cÃƒÂ³ 1 trong cÃƒÂ¡c role (role hÃ¡Â»â€¡ thÃ¡Â»â€˜ng HOÃ¡ÂºÂ¶C council_role_grants), khÃƒÂ´ng trÃƒÂ¹ng lÃ¡ÂºÂ·p. */
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

/** id/email/fullname/role cÃ¡Â»Â§a mÃ¡Â»Âi user cÃƒÂ³ 1 trong cÃƒÂ¡c role (role hÃ¡Â»â€¡ thÃ¡Â»â€˜ng HOÃ¡ÂºÂ¶C council_role_grants). */
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
    return res.status(401).json({ message: 'ChÃ†Â°a Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (userIdIsBanned(payload.id)) {
      return res.status(403).json({ message: 'TÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜ÃƒÂ£ bÃ¡Â»â€¹ khÃƒÂ³a. Vui lÃƒÂ²ng liÃƒÂªn hÃ¡Â»â€¡ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ viÃƒÂªn.' });
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
      /* giÃ¡Â»Â¯ payload JWT nÃ¡ÂºÂ¿u DB lÃ¡Â»â€”i */
    }
    req.user = reqUser;
    // vai trÃƒÂ² chÃ¡Â»â€° dÃƒÂ¹ng mÃ¡Â»â„¢t sÃ¡Â»â€˜ module (crd_user, sinh_vien): xem services/vaiTroHanChe.js; kiÃ¡Â»Æ’m cÃ¡ÂºÂ£ vai trÃƒÂ² trong token lÃ¡ÂºÂ«n trong DB
    const p = (req.originalUrl || req.url || '').split('?')[0];
    const loiVaiTro = vaiTroHanChe.kiemTraApi(payload.role, p) || vaiTroHanChe.kiemTraApi(reqUser.role, p);
    if (loiVaiTro) return res.status(403).json({ message: loiVaiTro });
    next();
  } catch (e) {
    return res.status(401).json({ message: 'PhiÃƒÂªn Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n' });
  }
}

/** JWT tuÃ¡Â»Â³ chÃ¡Â»Ân Ã¢â‚¬â€ khÃƒÂ´ng cÃƒÂ³ token thÃƒÂ¬ req.user = null (dÃƒÂ¹ng cho chÃ¡ÂºÂ¿ Ã„â€˜Ã¡Â»â„¢ public / kiÃ¡Â»Æ’m tra quyÃ¡Â»Ân). */
function optionalAuthMiddleware(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (userIdIsBanned(payload.id)) {
      return res.status(403).json({ message: 'TÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜ÃƒÂ£ bÃ¡Â»â€¹ khÃƒÂ³a. Vui lÃƒÂ²ng liÃƒÂªn hÃ¡Â»â€¡ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ viÃƒÂªn.' });
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

/** GET .../dashboard-perms/:id/check dÃƒÂ¹ng optional auth (public analytics cÃƒÂ³ thÃ¡Â»Æ’ khÃƒÂ´ng cÃ¡ÂºÂ§n Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p). */
function authUnlessDashboardPermCheck(req, res, next) {
  if (req.method === 'GET' && /^\/[^/]+\/check\/?$/.test(req.path || '')) {
    return optionalAuthMiddleware(req, res, next);
  }
  return authMiddleware(req, res, next);
}

function thuyKyOrAdmin(req, res, next) {
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
  }
  next();
}

function chuTichOrAdmin(req, res, next) {
  if (!roleIsAny(req, ['admin', 'chu_tich'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
  }
  next();
}

function adminOnly(req, res, next) {
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
  }
  next();
}

function userEmailIsMasterAdmin(email) {
  return (email || '').trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

/**
 * Master Admin = email trÃƒÂ¹ng ADMIN_EMAIL (hÃ¡ÂºÂ±ng sÃ¡Â»â€˜ / cÃ¡ÂºÂ¥u hÃƒÂ¬nh triÃ¡Â»Æ’n khai).
 * KhÃƒÂ´ng bÃ¡ÂºÂ¯t buÃ¡Â»â„¢c role === 'admin' trong JWT/DB: trÃƒÂ¡nh mÃ¡ÂºÂ¥t toÃƒÂ n bÃ¡Â»â„¢ quyÃ¡Â»Ân Master
 * (module ThiÃ¡ÂºÂ¿t bÃ¡Â»â€¹, cÃ¡ÂºÂ¥p Admin, Ã¢â‚¬Â¦) khi tÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜Ã¡Â»â€¢i vai trÃƒÂ² hoÃ¡ÂºÂ·c dÃ¡Â»Â¯ liÃ¡Â»â€¡u role lÃ¡Â»â€¡ch.
 */
function reqIsMasterAdmin(req) {
  if (!req || !req.user) return false;
  return userEmailIsMasterAdmin(req.user.email);
}

function masterAdminOnly(req, res, next) {
  if (!reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃ¡Â»Â±c hiÃ¡Â»â€¡n thao tÃƒÂ¡c nÃƒÂ y.' });
  }
  next();
}

/** Admin (role) hoÃ¡ÂºÂ·c Master Admin (email) Ã¢â‚¬â€ dÃƒÂ¹ng cho tÃƒÂ¬m user, phÃƒÂ¢n quyÃ¡Â»Ân dashboard, v.v. */
function adminOrMasterAdminApi(req, res, next) {
  if ((req.user.role || '').toLowerCase() === 'admin') return next();
  if (reqIsMasterAdmin(req)) return next();
  return res.status(403).json({ ok: false, success: false, error: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c Master Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
}

function adminOrPhongKhcn(req, res, next) {
  if (!roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
  }
  next();
}

/** ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN Ã¢â‚¬â€ dÃƒÂ¹ng cho sÃ¡Â»Â­a Ã„â€˜Ã¡Â»Â tÃƒÂ i trÃƒÂªn dashboard (khÃƒÂ´ng gÃ¡Â»â€œm thÃ†Â° kÃƒÂ½). */
function adminOrPhongKhcnMissionEditor(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && role !== 'phong_khcn') {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„â€˜Ã¡Â»Â tÃƒÂ i qua giao diÃ¡Â»â€¡n nÃƒÂ y.' });
  }
  next();
}

/** ChuÃ¡Â»â€”i trÃ¡ÂºÂ¡ng thÃƒÂ¡i tÃ¡Â»Â± do (khÃƒÂ´ng thuÃ¡Â»â„¢c mÃƒÂ£ enum): bÃ¡Â»Â kÃƒÂ½ tÃ¡Â»Â± Ã„â€˜iÃ¡Â»Âu khiÃ¡Â»Æ’n / <>. */
function sanitizeMissionStatusFreeText(s) {
  const t = String(s || '')
    .trim()
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f<>]/g, '')
    .slice(0, 200);
  return t || null;
}

/** MÃƒÂ£ trÃ¡ÂºÂ¡ng thÃƒÂ¡i chuÃ¡ÂºÂ©n (dropdown). GiÃƒÂ¡ trÃ¡Â»â€¹ khÃƒÂ¡c cÃƒÂ³ thÃ¡Â»Æ’ lÃ†Â°u nÃ¡ÂºÂ¿u lÃƒÂ  vÃ„Æ’n bÃ¡ÂºÂ£n tÃ¡Â»Â± do (sau khi sanitize). */
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

/** ChuÃ¡ÂºÂ©n hÃƒÂ³a tÃƒÂªn Ã„â€˜Ã¡Â»Æ’ so khÃ¡Â»â€ºp chÃ¡Â»Â§ nhiÃ¡Â»â€¡m (bÃ¡Â»Â hÃ¡Â»Âc hÃƒÂ m viÃ¡ÂºÂ¿t tÃ¡ÂºÂ¯t thÃ†Â°Ã¡Â»Âng gÃ¡ÂºÂ·p Ã¡Â»Å¸ Ã„â€˜Ã¡ÂºÂ§u chuÃ¡Â»â€”i). */
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

/** So khÃ¡Â»â€ºp trÃ†Â°Ã¡Â»Âng principal cÃ¡Â»Â§a missions vÃ¡Â»â€ºi user Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p (fullname / email). */
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

/** Admin xem Ã„â€˜Ã†Â°Ã¡Â»Â£c mÃ¡Â»Âi Ã„â€˜Ã¡Â»Â tÃƒÂ i; user thÃ†Â°Ã¡Â»Âng chÃ¡Â»â€° Ã„â€˜Ã¡Â»Â tÃƒÂ i mÃƒÂ¬nh lÃƒÂ  chÃ¡Â»Â§ nhiÃ¡Â»â€¡m (theo trÃ†Â°Ã¡Â»Âng principal). */
function canUserAccessMissionHoSoNgoai(req, missionRow) {
  if (!missionRow) return false;
  if (!req.user) return false;
  if ((req.user.role || '').toLowerCase() === 'admin') return true;
  return missionPrincipalMatchesUser(missionRow.principal, req.user);
}

/** QuyÃ¡Â»Ân xem chi tiÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»Â tÃƒÂ i: nhÃƒÂ³m xÃ¡Â»Â­ lÃƒÂ½ nghiÃ¡Â»â€¡p vÃ¡Â»Â¥ + admin; user thÃ†Â°Ã¡Â»Âng chÃ¡Â»â€° xem Ã„â€˜Ã¡Â»Â tÃƒÂ i mÃƒÂ¬nh phÃ¡Â»Â¥ trÃƒÂ¡ch. */
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

/** Ã„ÂÃƒÂ£ cÃƒÂ³ mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p (Ã„â€˜ÃƒÂ£ kÃƒÂ­ch hoÃ¡ÂºÂ¡t). CÃ¡Â»â„¢t password cÃƒÂ³ thÃ¡Â»Æ’ NOT NULL nÃƒÂªn dÃƒÂ¹ng '' lÃƒÂ m sentinel Ã¢â‚¬Å“chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡tÃ¢â‚¬Â. */
function userHasLoginPassword(pw) {
  return pw != null && String(pw).trim().length > 0;
}

// Ã„ÂÃ„Æ’ng kÃƒÂ½ (chÃ¡Â»â€° @sci.edu.vn) cÃƒÂ³ XÃƒÂC MINH email: gÃ¡Â»Â­i liÃƒÂªn kÃ¡ÂºÂ¿t dÃƒÂ¹ng mÃ¡Â»â„¢t lÃ¡ÂºÂ§n, mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u Ã„â€˜Ã¡ÂºÂ·t SAU khi xÃƒÂ¡c minh. Xem routes/dangKy.js
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

// Ã„ÂÃ„Æ’ng nhÃ¡ÂºÂ­p
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof password !== 'string' || !password || password.length > 128) {
    return res.status(400).json({ message: 'MÃ¡ÂºÂ­t khÃ¡ÂºÂ©u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
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
    return res.status(401).json({ message: 'Email hoÃ¡ÂºÂ·c mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u khÃƒÂ´ng Ã„â€˜ÃƒÂºng' });
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
    return res.status(403).json({ message: 'TÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜ÃƒÂ£ bÃ¡Â»â€¹ khÃƒÂ³a. Vui lÃƒÂ²ng liÃƒÂªn hÃ¡Â»â€¡ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ viÃƒÂªn.' });
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
        'TÃƒÂ i khoÃ¡ÂºÂ£n chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t. Vui lÃƒÂ²ng mÃ¡Â»Å¸ trang Ã„ÂÃ„Æ’ng kÃƒÂ½, nhÃ¡ÂºÂ­p cÃƒÂ¹ng email @sci.edu.vn vÃƒÂ  Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u lÃ¡ÂºÂ§n Ã„â€˜Ã¡ÂºÂ§u.',
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
    return res.status(401).json({ message: 'Email hoÃ¡ÂºÂ·c mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u khÃƒÂ´ng Ã„â€˜ÃƒÂºng' });
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
        /* token hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n Ã¢â‚¬â€ khÃƒÂ´ng ghi logout */
      }
    }
  } catch (_) {}
  clearAuthCookie(res);
  return res.json({ ok: true });
});

// Client ghi nhÃ¡ÂºÂ­n mÃ¡Â»Å¸ trang / hÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng (Ã„â€˜ÃƒÂ£ Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p). Module CRD-only cÃ…Â©ng Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ©p (whitelist API).
app.post('/api/activity/track', authMiddleware, (req, res) => {
  const b = req.body || {};
  const action = String(b.action || 'page_view').slice(0, 120);
  const moduleName = b.module != null ? String(b.module).slice(0, 120) : '';
  const pathStr = b.path != null ? String(b.path).slice(0, 500) : '';
  const detail = b.detail != null ? String(b.detail).slice(0, 2000) : null;
  if (!moduleName.trim() && !pathStr.trim()) {
    return res.status(400).json({ message: 'CÃ¡ÂºÂ§n ÃƒÂ­t nhÃ¡ÂºÂ¥t module hoÃ¡ÂºÂ·c path' });
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

// Ã„ÂÃ„Æ’ng kÃƒÂ½ cÃƒÂ´ng khai cho module CRD (1 endpoint) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/crd/dangKyCongKhai.js.
// Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨.
app.use('/api', require('./routes/crd/dangKyCongKhai')({
  ALLOWED_EMAIL_DOMAIN,
  CRD_ONLY_USER_ROLE,
  bcrypt,
  db,
  jwt,
  JWT_SECRET,
  setAuthCookie, emailSinhVienDangCho: (em) => require('./services/nganHangTeBaoKhangTheSinhVien').emailDuocDangKy(db, em),
}));

/** email (chuÃ¡ÂºÂ©n hoÃƒÂ¡) Ã¢â€ â€™ thÃ¡Â»Âi Ã„â€˜iÃ¡Â»Æ’m gÃ¡Â»Â­i mail quÃƒÂªn mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u gÃ¡ÂºÂ§n nhÃ¡ÂºÂ¥t Ã¢â‚¬â€ chÃ¡Â»â€˜ng email bomb SMTP */
const forgotPasswordLastSentByEmail = new Map();
const FORGOT_PASSWORD_COOLDOWN_MS = 60_000;

// QuÃƒÂªn mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u: gÃ¡Â»Â­i email chÃ¡Â»Â©a link Ã„â€˜Ã¡ÂºÂ·t lÃ¡ÂºÂ¡i (chÃ¡Â»â€° tÃƒÂ i khoÃ¡ÂºÂ£n tÃ¡Â»â€œn tÃ¡ÂºÂ¡i, khÃƒÂ´ng tiÃ¡ÂºÂ¿t lÃ¡Â»â„¢)
app.post('/api/forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p email' });
  }
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!row) {
    return res.json({ message: 'NÃ¡ÂºÂ¿u email tÃ¡Â»â€œn tÃ¡ÂºÂ¡i trong hÃ¡Â»â€¡ thÃ¡Â»â€˜ng, bÃ¡ÂºÂ¡n sÃ¡ÂºÂ½ nhÃ¡ÂºÂ­n Ã„â€˜Ã†Â°Ã¡Â»Â£c hÃ†Â°Ã¡Â»â€ºng dÃ¡ÂºÂ«n Ã„â€˜Ã¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u qua email.' });
  }
  const now = Date.now();
  const last = forgotPasswordLastSentByEmail.get(email) || 0;
  if (now - last < FORGOT_PASSWORD_COOLDOWN_MS) {
    return res.status(429).json({ message: 'Vui lÃƒÂ²ng Ã„â€˜Ã¡Â»Â£i 1 phÃƒÂºt trÃ†Â°Ã¡Â»â€ºc khi gÃ¡Â»Â­i lÃ¡ÂºÂ¡i.' });
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
    return res.status(503).json({ message: 'KhÃƒÂ´ng gÃ¡Â»Â­i Ã„â€˜Ã†Â°Ã¡Â»Â£c email lÃƒÂºc nÃƒÂ y. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' });
  }
  return res.json({ message: 'NÃ¡ÂºÂ¿u email tÃ¡Â»â€œn tÃ¡ÂºÂ¡i trong hÃ¡Â»â€¡ thÃ¡Â»â€˜ng, bÃ¡ÂºÂ¡n sÃ¡ÂºÂ½ nhÃ¡ÂºÂ­n Ã„â€˜Ã†Â°Ã¡Â»Â£c hÃ†Â°Ã¡Â»â€ºng dÃ¡ÂºÂ«n Ã„â€˜Ã¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u qua email.' });
});

// Ã„ÂÃ¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u (sau khi nhÃ¡ÂºÂ¥n link trong email)
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ message: 'Link khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u mÃ¡Â»â€ºi ÃƒÂ­t nhÃ¡ÂºÂ¥t 6 kÃƒÂ½ tÃ¡Â»Â±' });
  }
  const row = db.prepare("SELECT email FROM password_reset_tokens WHERE token = ? AND datetime(expiresAt) > datetime('now')").get(token);
  if (!row) {
    return res.status(400).json({ message: 'Link Ã„â€˜ÃƒÂ£ hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n hoÃ¡ÂºÂ·c khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. Vui lÃƒÂ²ng yÃƒÂªu cÃ¡ÂºÂ§u quÃƒÂªn mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u lÃ¡ÂºÂ¡i.' });
  }
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, row.email);
  db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
  return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã¡ÂºÂ·t lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u thÃƒÂ nh cÃƒÂ´ng. BÃ¡ÂºÂ¡n cÃƒÂ³ thÃ¡Â»Æ’ Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p bÃ¡ÂºÂ±ng mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u mÃ¡Â»â€ºi.' });
});

// HÃ¡Â»â€œ sÃ†Â¡ SCI-ACE Ã¢â‚¬â€ nhÃƒÂ³m cÃ†Â¡ bÃ¡ÂºÂ£n (4 endpoint: nÃ¡Â»â„¢p, danh sÃƒÂ¡ch, danh sÃƒÂ¡ch HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng, chi tiÃ¡ÂºÂ¿t) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/submissions/hoSoCoBan.js.
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

// HÃ¡Â»â€œ sÃ†Â¡ SCI-ACE Ã¢â‚¬â€ GÃ„Â6 & GÃ„Â7 (7 endpoint: cÃƒÂ³ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n, hÃ¡Â»Âp, cÃ¡ÂºÂ¥p QÃ„Â, bÃƒÂ¡o cÃƒÂ¡o) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/submissions/nghiemThuVaQuyetDinh.js.
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

// HÃ¡Â»â€œ sÃ†Â¡ SCI-ACE Ã¢â‚¬â€ tÃ¡ÂºÂ£i file, GÃ„Â3/GÃ„Â4/GÃ„Â5, download & xÃƒÂ³a (10 endpoint) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/submissions/kiemTraPhanBien.js.
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

// ========== API Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (NhiÃ¡Â»â€¡m vÃ¡Â»Â¥ KHCN cÃ¡ÂºÂ¥p cÃ†Â¡ sÃ¡Â»Å¸) Ã¢â‚¬â€ DB vÃƒÂ  upload riÃƒÂªng ==========
app.post('/api/cap-vien/submissions', authMiddleware, uploadCapVien.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p tÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i / mÃƒÂ£ hÃ¡Â»â€œ sÃ†Â¡' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'CÃ¡ÂºÂ§n Ã„â€˜Ã¡Â»Â§ 3 file: ThuyÃ¡ÂºÂ¿t minh, KÃ¡ÂºÂ¿ hoÃ¡ÂºÂ¡ch, TÃƒÂ i liÃ¡Â»â€¡u bÃ¡Â»â€¢ sung' });
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
      // KhÃ¡Â»Å¸i tÃ¡ÂºÂ¡o bÃ¡Â»â„¢ Ã„â€˜Ã¡ÂºÂ¿m tÃ¡Â»Â« mÃƒÂ£ lÃ¡Â»â€ºn nhÃ¡ÂºÂ¥t Ã„â€˜ang cÃƒÂ³ trong nÃ„Æ’m, trÃƒÂ¡nh cÃ¡ÂºÂ¥p lÃ¡ÂºÂ¡i sÃ¡Â»â€˜ cÃ…Â© sau khi hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¹ xÃƒÂ³a.
      const maxRow = db.prepare(
        "SELECT MAX(CAST(SUBSTR(code, -3) AS INTEGER)) AS maxSeq FROM cap_vien_submissions WHERE code LIKE '%-' || ? || '-%'"
      ).get(String(year));
      db.prepare('INSERT INTO cap_vien_code_sequences (year, seq) VALUES (?, ?)').run(year, (maxRow && maxRow.maxSeq) || 0);
    }
    // BÃ¡Â»â„¢ Ã„â€˜Ã¡ÂºÂ¿m chÃ¡Â»â€° tÃ„Æ’ng, khÃƒÂ´ng bao giÃ¡Â»Â giÃ¡ÂºÂ£m theo COUNT(*) Ã¢â‚¬â€ nhÃ¡Â»Â Ã„â€˜ÃƒÂ³ mÃƒÂ£ khÃƒÂ´ng bÃ¡Â»â€¹ trÃƒÂ¹ng khi cÃƒÂ³ hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¹ xÃƒÂ³a Ã¡Â»Å¸ giÃ¡Â»Â¯a.
    db.prepare('UPDATE cap_vien_code_sequences SET seq = seq + 1 WHERE year = ?').run(year);
    const seq = db.prepare('SELECT seq FROM cap_vien_code_sequences WHERE year = ?').get(year).seq;
    const baseCode = 'DTSCI-' + year + '-' + String(seq).padStart(3, '0');
    // SÃ¡ÂºÂ¯p theo sort_order Ã„â€˜Ã¡Â»Æ’ thÃ¡Â»Â© tÃ¡Â»Â± nhÃƒÂ£n trong mÃƒÂ£ luÃƒÂ´n nhÃ¡ÂºÂ¥t quÃƒÂ¡n (khÃƒÂ´ng phÃ¡Â»Â¥ thuÃ¡Â»â„¢c thÃ¡Â»Â© tÃ¡Â»Â± client gÃ¡Â»Â­i lÃƒÂªn).
    const optsWithAffect = db.prepare('SELECT code FROM cap_vien_submission_options WHERE affects_code = 1 ORDER BY sort_order ASC, id ASC').all();
    const affectCodes = optsWithAffect.map(r => (r.code || '').toUpperCase()).filter(Boolean);
    const checkedAffectSet = new Set(optionsChecked.map(c => (c || '').toUpperCase()));
    // GÃ¡Â»â„¢p TÃ¡ÂºÂ¤T CÃ¡ÂºÂ¢ cÃƒÂ¡c ÃƒÂ´ "Ã¡ÂºÂ¢nh hÃ†Â°Ã¡Â»Å¸ng mÃƒÂ£ sÃ¡Â»â€˜" Ã„â€˜ÃƒÂ£ tick vÃƒÂ o mÃƒÂ£ Ã¢â‚¬â€ trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y chÃ¡Â»â€° lÃ¡ÂºÂ¥y ÃƒÂ´ Ã„â€˜Ã¡ÂºÂ§u tiÃƒÂªn, cÃƒÂ¡c ÃƒÂ´ cÃƒÂ²n lÃ¡ÂºÂ¡i bÃ¡Â»â€¹ bÃ¡Â»Â sÃƒÂ³t.
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
  insertCapVienHistory(id, '1', 'researcher_submit', req.user.id, 'researcher', 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', row ? row.createdAt : null);
  sendCapVienNewSubmissionEmail({
    submissionId: id,
    submissionTitle: title,
    submittedByEmail: req.user.email,
    submittedByName: req.user.fullname,
    createdAt: row ? row.createdAt : null,
    status: row ? row.status : 'SUBMITTED'
  });
  return res.status(201).json({ id, message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n thÃƒÂ nh cÃƒÂ´ng' });
});

// Ãƒâ€ Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u khi nÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (CoE, Kinh phÃƒÂ­ ViÃ¡Â»â€¡n...) Ã¢â‚¬â€ public Ã„â€˜Ã¡Â»Æ’ form hiÃ¡Â»Æ’n thÃ¡Â»â€¹
app.get('/api/cap-vien/submission-options', (req, res) => {
  const rows = db.prepare('SELECT id, code, label, affects_code FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});

// Danh mÃ¡Â»Â¥c hÃ¡ÂºÂ¡ng mÃ¡Â»Â¥c (public, dÃƒÂ¹ng trong form nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡)
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

// Ã¢â€â‚¬Ã¢â€â‚¬ MÃ¡ÂºÂ«u hÃ¡Â»â€œ sÃ†Â¡ cÃƒÂ´ng khai (trang tai-mau-ho-so-de-tai-cap-vien) Ã¢â‚¬â€ Admin upload; mÃ¡Â»Âi ngÃ†Â°Ã¡Â»Âi tÃ¡ÂºÂ£i khi Ã„â€˜ÃƒÂ£ cÃƒÂ³ file Ã¢â€â‚¬Ã¢â€â‚¬
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
    return res.status(500).json({ message: 'LÃ¡Â»â€”i CSDL' });
  }
});

app.get('/api/cap-vien/public-templates/:taskCode/file', (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(404).json({ message: 'MÃƒÂ£ mÃ¡ÂºÂ«u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  }
  const row = db.prepare('SELECT stored_path, original_name FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u cho mÃƒÂ£ nÃƒÂ y. Vui lÃƒÂ²ng liÃƒÂªn hÃ¡Â»â€¡ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ hoÃ¡ÂºÂ·c thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' });
  }
  const abs = resolveStoredFileFromDb(row.stored_path);
  const baseDir = path.resolve(capVienPublicTemplatesFsDir);
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs) || !fs.existsSync(abs)) {
    return res.status(404).json({ message: 'File khÃƒÂ´ng cÃƒÂ²n trÃƒÂªn mÃƒÂ¡y chÃ¡Â»Â§' });
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
      return res.status(400).json({ message: 'MÃƒÂ£ mÃ¡ÂºÂ«u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    }
    const f = req.file;
    if (!f) {
      return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u file (form field: file)' });
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
      return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t mÃ¡ÂºÂ«u', taskCode, originalName: orig });
    } catch (e) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch (_) {}
      console.error('[public-templates upload]', e);
      return res.status(500).json({ message: 'LÃ¡Â»â€”i lÃ†Â°u' });
    }
  }
);

app.delete('/api/cap-vien/public-templates/:taskCode', authMiddleware, adminOnly, (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(400).json({ message: 'MÃƒÂ£ mÃ¡ÂºÂ«u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  }
  const row = db.prepare('SELECT stored_path FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ file Ã„â€˜Ã¡Â»Æ’ xÃƒÂ³a' });
  }
  try {
    const p = resolveCapVienPublicTemplateStoredFileForUnlink(row.stored_path);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
    db.prepare('DELETE FROM cap_vien_public_template_files WHERE task_code = ?').run(taskCode);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a mÃ¡ÂºÂ«u' });
  } catch (e) {
    console.error('[public-templates delete]', e);
    return res.status(500).json({ message: 'LÃ¡Â»â€”i xÃƒÂ³a' });
  }
});

// Admin: CRUD ÃƒÂ´ Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u
app.get('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});
app.post('/api/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
  const { code, label, affects_code } = req.body || {};
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '') || codeStr;
  if (!codeStr) return res.status(400).json({ message: 'MÃƒÂ£ option khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng' });
  try {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cap_vien_submission_options').get();
    const nextOrder = (maxOrder && maxOrder.m != null ? maxOrder.m : 0) + 1;
    db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, affects_code ? 1 : 0, nextOrder);
    const row = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE code = ?').get(codeStr);
    return res.status(201).json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm ÃƒÂ´ Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u', option: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'MÃƒÂ£ option Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i' });
    throw e;
  }
});
app.put('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { code, label, affects_code, sort_order } = req.body || {};
  const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y option' });
  const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
  const labelStr = (label != null ? String(label).trim() : '');
  const updates = [];
  const params = [];
  if (codeStr !== '') { updates.push('code = ?'); params.push(codeStr); }
  if (labelStr !== '') { updates.push('label = ?'); params.push(labelStr); }
  if (affects_code !== undefined) { updates.push('affects_code = ?'); params.push(affects_code ? 1 : 0); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10) || 0); }
  if (updates.length === 0) return res.json({ message: 'KhÃƒÂ´ng cÃƒÂ³ thay Ã„â€˜Ã¡Â»â€¢i' });
  params.push(id);
  db.prepare('UPDATE cap_vien_submission_options SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE id = ?').get(id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t', option: updated });
});
app.delete('/api/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y option' });
  db.prepare('DELETE FROM cap_vien_submission_options WHERE id = ?').run(id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a ÃƒÂ´ Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u' });
});

// Admin: CRUD LÃ„Â©nh vÃ¡Â»Â±c KHCN
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
    if (!codeStr) return res.status(400).json({ message: 'MÃƒÂ£ khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng' });
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ' + table).get();
    try {
      if (tableName === 'khoan_muc_chi') {
        db.prepare('INSERT INTO ' + table + ' (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, (parent_code || '').trim() || null, (maxOrder.m || 0) + 1);
      } else {
        db.prepare('INSERT INTO ' + table + ' (code, label, sort_order) VALUES (?, ?, ?)').run(codeStr, labelStr, (maxOrder.m || 0) + 1);
      }
      const row = db.prepare('SELECT * FROM ' + table + ' WHERE code = ?').get(codeStr);
      return res.json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm ' + singularLabel, item: row });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'MÃƒÂ£ Ã„â€˜ÃƒÂ£ tÃ¡Â»â€œn tÃ¡ÂºÂ¡i' });
      throw e;
    }
  });
  app.put('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { code, label, parent_code, sort_order } = req.body || {};
    const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y' });
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
    return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t', item: updated });
  });
  app.delete('/api/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y' });
    db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id);
    return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a ' + singularLabel });
  });
}
crudCapVienTable('linh_vuc', 'lÃ„Â©nh vÃ¡Â»Â±c');
crudCapVienTable('loai_de_tai', 'loÃ¡ÂºÂ¡i Ã„â€˜Ã¡Â»Â tÃƒÂ i');
crudCapVienTable('don_vi', 'Ã„â€˜Ã†Â¡n vÃ¡Â»â€¹');
crudCapVienTable('khoan_muc_chi', 'khoÃ¡ÂºÂ£n mÃ¡Â»Â¥c chi');

// Admin: Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ KHCN tÃ¡Â»Â« Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n
app.post('/api/admin/missions/sync-from-cap-vien', authMiddleware, adminOnly, (req, res) => {
  // GÃ¡Â»Â¡ trÃ¡ÂºÂ¡ng thÃƒÂ¡i Ã‚Â«Ã¡ÂºÂ©n khÃ¡Â»Âi dashboardÃ‚Â» (missions_hidden) Ã„â€˜Ã¡Â»Æ’ cÃƒÂ¡c hÃ¡Â»â€œ sÃ†Â¡ cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n cÃƒÂ²n tÃ¡Â»â€œn tÃ¡ÂºÂ¡i Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ lÃ¡ÂºÂ¡i.
  // Ã¡ÂºÂ¨n chÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c ghi khi Admin xÃƒÂ³a Ã„â€˜Ã¡Â»Â tÃƒÂ i Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ tÃ¡Â»Â« cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n khÃ¡Â»Âi bÃ¡ÂºÂ£ng Ã¢â‚¬â€ nÃƒÂºt Ã„ÂÃ¡Â»â€œng bÃ¡Â»â„¢ = khÃƒÂ´i phÃ¡Â»Â¥c theo nguÃ¡Â»â€œn.
  try {
    db.prepare("DELETE FROM missions_hidden WHERE source_type = 'cap_vien'").run();
  } catch (e) {
    /* bÃ¡ÂºÂ£ng cÃƒÂ³ thÃ¡Â»Æ’ chÃ†Â°a tÃ¡Â»â€œn tÃ¡ÂºÂ¡i trÃƒÂªn DB rÃ¡ÂºÂ¥t cÃ…Â© */
  }
  syncMissionsFromCapVien();
  const count = db.prepare('SELECT COUNT(*) AS n FROM missions WHERE source_type = ?').get('cap_vien');
  return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ KHCN tÃ¡Â»Â« Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n.', count: count.n });
});

// Admin: danh sÃƒÂ¡ch Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§, cho quÃ¡ÂºÂ£n trÃ¡Â»â€¹)
app.get('/api/admin/cap-vien/submissions', authMiddleware, adminOnly, (req, res) => {
  const rows = db.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
  rows.forEach(r => {
    const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
    r.submittedByName = u ? u.fullname : null;
  });
  return res.json({ submissions: rows });
});

// Admin: sÃ¡Â»Â­a mÃƒÂ£ Ã„â€˜Ã¡Â»Â tÃƒÂ i (trÃ†Â°Ã¡Â»Âng hÃ¡Â»Â£p cÃ¡ÂºÂ§n thiÃ¡ÂºÂ¿t)
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
  return res.json({ message: on ? 'Ã„ÂÃƒÂ£ bÃ¡ÂºÂ­t gÃ¡Â»Â­i email khi hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7.' : 'Ã„ÂÃƒÂ£ tÃ¡ÂºÂ¯t gÃ¡Â»Â­i email khi hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7.', enabled: on });
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u cÃ¡ÂºÂ¥u hÃƒÂ¬nh email cho ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN.', controls: merged });
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u cÃ¡ÂºÂ¥u hÃƒÂ¬nh email cho thÃƒÂ nh viÃƒÂªn HÃ„ÂKHCN (ngoÃƒÂ i ChÃ¡Â»Â§ tÃ¡Â»â€¹ch).', controls: merged });
});

app.put('/api/admin/cap-vien/submissions/:id/code', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const newCode = (req.body && req.body.code != null) ? String(req.body.code).trim() : '';
  const row = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if (!newCode) return res.status(400).json({ message: 'MÃƒÂ£ Ã„â€˜Ã¡Â»Â tÃƒÂ i khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng' });
  db.prepare('UPDATE cap_vien_submissions SET code = ? WHERE id = ?').run(newCode, id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t mÃƒÂ£ Ã„â€˜Ã¡Â»Â tÃƒÂ i', code: newCode });
});

/** Xem mÃ¡Â»Âi hÃ¡Â»â€œ sÃ†Â¡ cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n (danh sÃƒÂ¡ch + chi tiÃ¡ÂºÂ¿t + tÃ¡ÂºÂ£i): Admin, ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng, P.KHCN, HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (kÃ¡Â»Æ’ cÃ¡ÂºÂ£
 * role Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p qua council_role_grants). ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m chÃ¡Â»â€° hÃ¡Â»â€œ sÃ†Â¡ cÃ¡Â»Â§a mÃƒÂ¬nh. */
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
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const row = db.prepare(`SELECT id, title, submittedBy, submittedById, status, createdAt, code, options_checked, reviewNote, reviewedAt, reviewedById, assignedReviewerIds, assignedAt, assignedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round, budget_4a_revision_note, budget_4a_revision_requested_at, budget_4a_revision_requested_by, budget_4a_approved_at, budget_4a_approved_by, step_4_reviewer1_done, step_4_reviewer2_done, step5_hd_meeting_location, step5_hd_meeting_attendance, step5_hd_meeting_documents, step5_hd_meeting_vote_result, step5_hd_meeting_decision, step5_hd_meeting_event_time, step5_hd_meeting_updated_at, step5_hd_meeting_updated_by, step5_council_revision_status, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_note, step5_council_revision_requested_at, step5_council_revision_requested_by, step6_so_qd, step6_kinh_phi, step6_thoi_gian, step6_phi_quan_ly, step6_meta_updated_at, step6_meta_updated_by, step7_so_hd, step7_hieu_luc, step7_meta_updated_at, step7_meta_updated_by, step8_ma_dao_duc, step8_hieu_luc, step8_so_quyet_dinh, step8_meta_updated_at, step8_meta_updated_by, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived, COALESCE(step8a_completed, 0) AS step8a_completed, COALESCE(step8a_waived, 0) AS step8a_waived, step9_supply_locked_at, step9_supply_locked_by FROM cap_vien_submissions WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân xem hÃ¡Â»â€œ sÃ†Â¡ nÃƒÂ y' });
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
      const note = row.reviewNote || (actionType === 'secretary_approve' ? 'HÃ¡Â»Â£p lÃ¡Â»â€¡' : null);
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
      reviewerNames = ids.map(rid => { const r = reviewers.find(x => x.id === rid); return r ? (r.fullname || r.email || '') : 'Ã¢â‚¬â€'; });
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

/** BÃ†Â°Ã¡Â»â€ºc 6 Ã¢â‚¬â€ PhÃƒÂ²ng KHCN / ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN / Admin: lÃ†Â°u SÃ¡Â»â€˜ QÃ„Â, kinh phÃƒÂ­, thÃ¡Â»Âi gian, phÃƒÂ­ QL (chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã„â€˜Ã†Â°Ã¡Â»Â£c nhiÃ¡Â»Âu lÃ¡ÂºÂ§n) */
app.put('/api/cap-vien/submissions/:id/steps/6/decision-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'HÃ¡Â»â€œ sÃ†Â¡ chÃ†Â°a Ã„â€˜Ã¡ÂºÂ¿n bÃ†Â°Ã¡Â»â€ºc CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh (BÃ†Â°Ã¡Â»â€ºc 6).' });
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
  insertCapVienHistory(id, '6', 'step6_meta_update', req.user.id, roleDb, 'CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh (SÃ¡Â»â€˜ QÃ„Â, kinh phÃƒÂ­, thÃ¡Â»Âi gian, phÃƒÂ­ QL)');
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u thÃƒÂ´ng tin QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh.', updatedAt });
});

function capVienStep7ContractMetaAllowedStatus(statusRaw) {
  const s = (statusRaw || '').toUpperCase();
  return s === 'APPROVED' || s === 'CONTRACTED';
}

/** BÃ†Â°Ã¡Â»â€ºc 7 Ã¢â‚¬â€ PhÃƒÂ²ng KHCN / ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN / Admin: lÃ†Â°u SÃ¡Â»â€˜ HÃ„Â, HiÃ¡Â»â€¡u lÃ¡Â»Â±c hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng */
app.put('/api/cap-vien/submissions/:id/steps/7/contract-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if (!capVienStep7ContractMetaAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„â€˜Ã†Â°Ã¡Â»Â£c khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 7 (APPROVED) hoÃ¡ÂºÂ·c vÃ¡Â»Â«a hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 (CONTRACTED).' });
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
  insertCapVienHistory(id, '7', 'step7_contract_meta_update', req.user.id, roleDb, 'CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng (SÃ¡Â»â€˜ HÃ„Â, HiÃ¡Â»â€¡u lÃ¡Â»Â±c)');
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u thÃƒÂ´ng tin HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng.', updatedAt });
});

/** BÃ†Â°Ã¡Â»â€ºc 6 Ã¢â‚¬â€ upload / thay thÃ¡ÂºÂ¿ file QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh VN & EN (cÃƒÂ³ thÃ¡Â»Æ’ chÃ¡Â»â€° gÃ¡Â»Â­i mÃ¡Â»â„¢t phÃƒÂ­a) */
app.post('/api/cap-vien/submissions/:id/steps/6/upload-decision', authMiddleware, (req, res, next) => {
  uploadCapVien.fields([
    { name: 'decision_vn', maxCount: 1 },
    { name: 'decision_en', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'DÃ¡Â»Â¯ liÃ¡Â»â€¡u file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡') });
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c upload QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'HÃ¡Â»â€œ sÃ†Â¡ chÃ†Â°a Ã„â€˜Ã¡ÂºÂ¿n bÃ†Â°Ã¡Â»â€ºc CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh (BÃ†Â°Ã¡Â»â€ºc 6).' });
  }
  const files = req.files || {};
  const fileVn = files.decision_vn && files.decision_vn[0] ? files.decision_vn[0] : null;
  const fileEn = files.decision_en && files.decision_en[0] ? files.decision_en[0] : null;
  if (!fileVn && !fileEn) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân ÃƒÂ­t nhÃ¡ÂºÂ¥t mÃ¡Â»â„¢t file (QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh VN hoÃ¡ÂºÂ·c EN).' });
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
      throw new Error('File ' + tag + ': chÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n PDF hoÃ¡ÂºÂ·c Word.');
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
    return res.status(400).json({ message: 'LÃ¡Â»â€”i lÃ†Â°u file' });
  }
  insertCapVienHistory(id, '6', 'step6_decision_upload', req.user.id, roleDb, 'Upload QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh: ' + saved.join(', '));
  console.log('[API] cap-vien step 6 upload-decision Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u file QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ o hÃ¡Â»â€œ sÃ†Â¡.', files: saved });
});

/** BÃ†Â°Ã¡Â»â€ºc 7 Ã¢â‚¬â€ PhÃƒÂ²ng KHCN / ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN / Admin: upload / thay thÃ¡ÂºÂ¿ HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN */
app.post('/api/cap-vien/submissions/:id/steps/7/upload-contract', authMiddleware, uploadCapVien.single('step7_hop_dong_khcn'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c upload HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if ((sub.status || '').toUpperCase() !== 'APPROVED') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° upload HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 7 (trÃ¡ÂºÂ¡ng thÃƒÂ¡i APPROVED).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN (PDF hoÃ¡ÂºÂ·c Word).' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n file PDF hoÃ¡ÂºÂ·c Word.' });
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
  insertCapVienHistory(id, '7', 'step7_contract_upload', req.user.id, roleDb, 'Upload HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN: ' + storedName);
  console.log('[API] cap-vien step 7 upload-contract Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN vÃƒÂ o hÃ¡Â»â€œ sÃ†Â¡.', fileName: storedName });
});

function capVienStep8EthicsAllowedRow(sub) {
  if (!sub) return false;
  if ((sub.status || '').toUpperCase() !== 'CONTRACTED') return false;
  if (sub.step8_waived === 1 || sub.step8_waived === true) return false;
  return !(sub.step8_completed === 1 || sub.step8_completed === true);
}

/** BÃ†Â°Ã¡Â»â€ºc 8 Ã¢â‚¬â€ PhÃƒÂ²ng KHCN / ThÃ†Â° kÃƒÂ½ / Admin: lÃ†Â°u MÃƒÂ£ Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c, HiÃ¡Â»â€¡u lÃ¡Â»Â±c, SÃ¡Â»â€˜/kÃƒÂ½ hiÃ¡Â»â€¡u QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh */
app.put('/api/cap-vien/submissions/:id/steps/8/ethics-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, status, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„â€˜Ã†Â°Ã¡Â»Â£c khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ kÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng (CONTRACTED), BÃ†Â°Ã¡Â»â€ºc 8 chÃ†Â°a hoÃƒÂ n thÃƒÂ nh vÃƒÂ  chÃ†Â°a bÃ¡Â»â€¹ bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t.' });
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
  insertCapVienHistory(id, '8', 'step8_ethics_meta_update', req.user.id, roleDb, 'CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin Ã„â€˜Ã„Æ’ng kÃƒÂ½ Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c (mÃƒÂ£, hiÃ¡Â»â€¡u lÃ¡Â»Â±c, QÃ„Â)');
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u thÃƒÂ´ng tin Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c.', updatedAt });
});

/** BÃ†Â°Ã¡Â»â€ºc 8 Ã¢â‚¬â€ upload QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c (1 file) */
app.post('/api/cap-vien/submissions/:id/steps/8/upload-ethics-decision', authMiddleware, uploadCapVien.single('step8_ethics_quyet_dinh'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c upload QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° upload khi hÃ¡Â»â€œ sÃ†Â¡ Ã¡Â»Å¸ CONTRACTED, BÃ†Â°Ã¡Â»â€ºc 8 chÃ†Â°a hoÃƒÂ n thÃƒÂ nh vÃƒÂ  chÃ†Â°a bÃ¡Â»â€¹ bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t.' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c.' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n PDF hoÃ¡ÂºÂ·c Word.' });
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
  insertCapVienHistory(id, '8', 'step8_ethics_upload', req.user.id, roleDb, 'Upload QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c: ' + storedName);
  console.log('[API] cap-vien step 8 upload-ethics Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c vÃƒÂ o hÃ¡Â»â€œ sÃ†Â¡.', fileName: storedName });
});

function capVienPeriodicReportUploadAllowed(sub, user) {
  const st = (sub.status || '').toUpperCase();
  if (!['IMPLEMENTATION', 'COMPLETED'].includes(st)) return false;
  if (userHasAnyRole(user, ['admin', 'phong_khcn', 'thu_ky'])) return true;
  return sub.submittedById === user.id;
}

/** NCV / P.KHCN / ThÃ†Â° kÃƒÂ½ / Admin: upload bÃƒÂ¡o cÃƒÂ¡o gÃ¡ÂºÂ¯n mÃ¡Â»â„¢t kÃ¡Â»Â³ */
app.post(
  '/api/cap-vien/submissions/:id/periodic-report/period/:periodId/upload',
  authMiddleware,
  uploadCapVien.single('periodic_report_file'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const periodId = parseInt(req.params.periodId, 10);
    if (!id || !periodId) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    const sub = db.prepare('SELECT id, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
    if (!capVienPeriodicReportUploadAllowed(sub, req.user)) {
      return res.status(403).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân upload bÃƒÂ¡o cÃƒÂ¡o Ã„â€˜Ã¡Â»â€¹nh kÃ¡Â»Â³ cho hÃ¡Â»â€œ sÃ†Â¡ nÃƒÂ y.' });
    }
    const per = db.prepare(
      `SELECT id, submissionId, status, primaryFileId FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`
    ).get(periodId, id);
    if (!per) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y kÃ¡Â»Â³ bÃƒÂ¡o cÃƒÂ¡o' });
    const stLow = String(per.status || '').toLowerCase();
    if (stLow === 'waived' || stLow === 'bypassed') {
      return res.status(400).json({ message: 'KÃ¡Â»Â³ nÃƒÂ y Ã„â€˜ÃƒÂ£ bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t / bypass Ã¢â‚¬â€ khÃƒÂ´ng upload.' });
    }
    const file = req.file;
    if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file (PDF/Word).' });
    const allowedExt = ['.pdf', '.doc', '.docx'];
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (!allowedExt.includes(ext)) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n PDF hoÃ¡ÂºÂ·c Word.' });
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
    insertCapVienHistory(id, '10', 'periodic_report_upload', req.user.id, roleDb, 'NÃ¡Â»â„¢p bÃƒÂ¡o cÃƒÂ¡o Ã„â€˜Ã¡Â»â€¹nh kÃ¡Â»Â³: ' + storedName + ' (kÃ¡Â»Â³ #' + periodId + ')');
    return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u bÃƒÂ¡o cÃƒÂ¡o cho kÃ¡Â»Â³ Ã„â€˜Ã†Â°Ã¡Â»Â£c chÃ¡Â»Ân.', fileId: newId, periodId });
  }
);

/** Admin: cÃƒÂ´ng cÃ¡Â»Â¥ bÃƒÂ¡o cÃƒÂ¡o Ã„â€˜Ã¡Â»â€¹nh kÃ¡Â»Â³ Ã¢â‚¬â€ body { action, payload } */
app.post('/api/cap-vien/submissions/:id/periodic-report/admin', authMiddleware, (req, res) => {
  if (String(req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c dÃƒÂ¹ng cÃƒÂ´ng cÃ¡Â»Â¥ nÃƒÂ y.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT * FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
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
      insertCapVienHistory(id, '10', 'periodic_report_config', req.user.id, 'admin', `CÃ¡ÂºÂ¥u hÃƒÂ¬nh BC Ã„â€˜Ã¡Â»â€¹nh kÃ¡Â»Â³: ${cycleMonths} thÃƒÂ¡ng, neo ${anchorType}`);
      return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u cÃ¡ÂºÂ¥u hÃƒÂ¬nh chu kÃ¡Â»Â³ bÃƒÂ¡o cÃƒÂ¡o.', action: 'set_cycle' });
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
      if (!anchorIso) return res.status(400).json({ message: 'KhÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã†Â°Ã¡Â»Â£c mÃ¡Â»â€˜c neo (thiÃ¡ÂºÂ¿u ngÃƒÂ y / lÃ¡Â»â€¹ch sÃ¡Â»Â­ BÃ†Â°Ã¡Â»â€ºc 7).' });
      const periodCount = Math.max(1, Math.min(48, parseInt(payload.periodCount, 10) || Math.min(12, Math.ceil(36 / cycleMonths))));
      const preview = capVienBuildPeriodicSchedule(anchorIso, cycleMonths, periodCount);
      return res.json({ message: 'Preview lÃ¡Â»â€¹ch kÃ¡Â»Â³ (chÃ†Â°a lÃ†Â°u).', preview, anchorIso, action: 'preview_schedule' });
    }

    if (action === 'apply_recalc') {
      const forceWipe = !!payload.forceWipe;
      const cfg = db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (!cfg) return res.status(400).json({ message: 'ChÃ†Â°a cÃƒÂ³ cÃ¡ÂºÂ¥u hÃƒÂ¬nh. DÃƒÂ¹ng set_cycle trÃ†Â°Ã¡Â»â€ºc.' });
      const locked = db.prepare(
        `SELECT COUNT(1) AS n FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL AND primaryFileId IS NOT NULL`
      ).get(id);
      if ((locked.n || 0) > 0 && !forceWipe) {
        return res.status(400).json({
          message: 'Ã„ÂÃƒÂ£ cÃƒÂ³ kÃ¡Â»Â³ Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p file. TruyÃ¡Â»Ân payload.forceWipe = true Ã„â€˜Ã¡Â»Æ’ xÃƒÂ³a toÃƒÂ n bÃ¡Â»â„¢ kÃ¡Â»Â³ vÃƒÂ  tÃ¡ÂºÂ¡o lÃ¡ÂºÂ¡i (nguy hiÃ¡Â»Æ’m).'
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
      insertCapVienHistory(id, '10', 'periodic_report_recalc', req.user.id, 'admin', 'TÃƒÂ­nh lÃ¡ÂºÂ¡i lÃ¡Â»â€¹ch cÃƒÂ¡c kÃ¡Â»Â³ bÃƒÂ¡o cÃƒÂ¡o Ã„â€˜Ã¡Â»â€¹nh kÃ¡Â»Â³');
      return res.json({ message: 'Ã„ÂÃƒÂ£ tÃ¡ÂºÂ¡o lÃ¡ÂºÂ¡i danh sÃƒÂ¡ch kÃ¡Â»Â³ bÃƒÂ¡o cÃƒÂ¡o.', action: 'apply_recalc' });
    }

    if (action === 'insert_period') {
      const dueAt = String(payload.dueAt || '').trim();
      if (!dueAt) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u dueAt (ISO).' });
      const label = String(payload.label || '').trim() || null;
      const maxS = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL`).get(id);
      const seq = (maxS.m || 0) + 1;
      const periodStart = String(payload.periodStart || dueAt).trim();
      db.prepare(
        `INSERT INTO cap_vien_periodic_report_period (submissionId, seq, label, periodStart, periodEnd, dueAt, status, createdAt) VALUES (?,?,?,?, NULL, ?, 'pending', ?)`
      ).run(id, seq, label, periodStart, dueAt, now);
      const row = db.prepare(`SELECT id FROM cap_vien_periodic_report_period WHERE submissionId = ? AND seq = ? AND deletedAt IS NULL`).get(id, seq);
      log('insert_period', row.id, { seq, dueAt, label }, null);
      return res.json({ message: 'Ã„ÂÃƒÂ£ chÃƒÂ¨n kÃ¡Â»Â³ mÃ¡Â»â€ºi.', periodId: row.id, action: 'insert_period' });
    }

    if (action === 'delete_period') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u periodId' });
      const per = db
        .prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`)
        .get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y kÃ¡Â»Â³' });
      if (per.primaryFileId) return res.status(400).json({ message: 'KÃ¡Â»Â³ Ã„â€˜ÃƒÂ£ cÃƒÂ³ file Ã¢â‚¬â€ khÃƒÂ´ng xÃƒÂ³a.' });
      const stLow = String(per.status || '').toLowerCase();
      if (stLow === 'submitted') return res.status(400).json({ message: 'KÃ¡Â»Â³ Ã„â€˜ÃƒÂ£ submitted Ã¢â‚¬â€ khÃƒÂ´ng xÃƒÂ³a.' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET deletedAt = ? WHERE id = ?`).run(now, periodId);
      log('delete_period', periodId, { seq: per.seq }, null);
      return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a kÃ¡Â»Â³ (soft).', action: 'delete_period' });
    }

    if (action === 'waive_period') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'CÃ¡ÂºÂ§n periodId vÃƒÂ  note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y kÃ¡Â»Â³' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'waived', waivedAt = ?, waivedById = ?, waiveNote = ?, primaryFileId = NULL, submittedAt = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('waive_period', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_waive', req.user.id, 'admin', 'BÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t kÃ¡Â»Â³ BC: ' + note);
      return res.json({ message: 'Ã„ÂÃƒÂ£ bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t kÃ¡Â»Â³.', action: 'waive_period' });
    }

    if (action === 'bypass_submit') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'CÃ¡ÂºÂ§n periodId vÃƒÂ  note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y kÃ¡Â»Â³' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'bypassed', bypassedAt = ?, bypassedById = ?, bypassNote = ?, submittedAt = NULL, primaryFileId = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('bypass_submit', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_bypass', req.user.id, 'admin', 'Bypass nÃ¡Â»â„¢p kÃ¡Â»Â³ BC: ' + note);
      return res.json({ message: 'Ã„ÂÃƒÂ£ bypass kÃ¡Â»Â³ (Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u hoÃƒÂ n thÃƒÂ nh khÃƒÂ´ng file).', action: 'bypass_submit' });
    }

    if (action === 'detach_file') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u periodId' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y kÃ¡Â»Â³' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(periodId);
      db.prepare(`UPDATE cap_vien_periodic_report_period_file SET detachedAt = ? WHERE periodId = ? AND detachedAt IS NULL`).run(now, periodId);
      log('detach_file', periodId, {}, null);
      return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â¡ file khÃ¡Â»Âi kÃ¡Â»Â³ (kÃ¡Â»Â³ vÃ¡Â»Â pending).', action: 'detach_file' });
    }

    if (action === 'move_file') {
      const fromPeriodId = parseInt(payload.fromPeriodId, 10);
      const toPeriodId = parseInt(payload.toPeriodId, 10);
      if (!fromPeriodId || !toPeriodId) return res.status(400).json({ message: 'CÃ¡ÂºÂ§n fromPeriodId vÃƒÂ  toPeriodId' });
      const fromP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(fromPeriodId, id);
      const toP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(toPeriodId, id);
      if (!fromP || !toP) return res.status(404).json({ message: 'KÃ¡Â»Â³ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
      const fid = fromP.primaryFileId;
      if (!fid) return res.status(400).json({ message: 'KÃ¡Â»Â³ nguÃ¡Â»â€œn khÃƒÂ´ng cÃƒÂ³ file' });
      if (toP.primaryFileId) return res.status(400).json({ message: 'KÃ¡Â»Â³ Ã„â€˜ÃƒÂ­ch Ã„â€˜ÃƒÂ£ cÃƒÂ³ file' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(fromPeriodId);
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET primaryFileId = ?, status = 'submitted', submittedAt = ? WHERE id = ?`
      ).run(fid, now, toPeriodId);
      log('move_file', toPeriodId, { fromPeriodId, toPeriodId, fileId: fid }, null);
      return res.json({ message: 'Ã„ÂÃƒÂ£ chuyÃ¡Â»Æ’n file sang kÃ¡Â»Â³ Ã„â€˜ÃƒÂ­ch.', action: 'move_file' });
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
      return res.json({ message: 'Ã„ÂÃƒÂ£ bÃ¡ÂºÂ­t Ã„â€˜ÃƒÂ³ng bÃ„Æ’ng hÃ¡ÂºÂ¡n (cÃ¡Â»Â hÃ¡Â»â€¡ thÃ¡Â»â€˜ng).', action: 'freeze_deadlines' });
    }

    if (action === 'unfreeze_deadlines') {
      db.prepare(
        `UPDATE cap_vien_periodic_report_config SET pauseReportClock = 0, pausedUntil = NULL, pauseReason = NULL, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
      ).run(now, req.user.id, id);
      log('unfreeze_deadlines', null, {}, null);
      return res.json({ message: 'Ã„ÂÃƒÂ£ tÃ¡ÂºÂ¯t Ã„â€˜ÃƒÂ³ng bÃ„Æ’ng.', action: 'unfreeze_deadlines' });
    }

    if (action === 'resend_reminder') {
      const periodId = payload.periodId ? parseInt(payload.periodId, 10) : null;
      log('resend_reminder', periodId || null, {}, payload.note || null);
      return res.json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n yÃƒÂªu cÃ¡ÂºÂ§u nhÃ¡ÂºÂ¯c (tÃƒÂ­ch hÃ¡Â»Â£p email cÃƒÂ³ thÃ¡Â»Æ’ bÃ¡Â»â€¢ sung sau).', action: 'resend_reminder' });
    }

    return res.status(400).json({ message: 'action khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡: ' + action });
  } catch (err) {
    if (err && err.message === 'NO_ANCHOR') {
      return res.status(400).json({ message: 'KhÃƒÂ´ng xÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã†Â°Ã¡Â»Â£c mÃ¡Â»â€˜c neo lÃ¡Â»â€¹ch.' });
    }
    console.error('[periodic-report admin]', err);
    return res.status(500).json({ message: 'LÃ¡Â»â€”i server' });
  }
});

// Admin (dev): Ã„â€˜Ã¡ÂºÂ·t/cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t deadline cho tÃ¡Â»Â«ng bÃ†Â°Ã¡Â»â€ºc
app.put('/api/cap-vien/submissions/:id/steps/:step/deadline', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepId = String(req.params.step || '').trim();
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  if (!stepId) return res.status(400).json({ message: 'Step khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  if ((req.user.role || '').toLowerCase() !== 'admin') return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡ÂºÂ·t deadline' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });

  const body = req.body || {};
  const clear = !!body.clear;
  if (clear) {
    db.prepare('DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').run(id, stepId);
    return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a deadline cho bÃ†Â°Ã¡Â»â€ºc ' + stepId, stepId, cleared: true });
  }

  const existing = db.prepare('SELECT openedAt FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = ?').get(id, stepId);
  const openedAt = existing && existing.openedAt ? existing.openedAt : new Date().toISOString();
  let durationDays = body.durationDays != null ? parseInt(body.durationDays, 10) : null;
  let dueAt = null;
  if (body.dueAt) {
    const d = new Date(body.dueAt);
    if (isNaN(d.getTime())) return res.status(400).json({ message: 'dueAt khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    dueAt = d.toISOString();
  } else {
    if (!Number.isFinite(durationDays) || durationDays <= 0) return res.status(400).json({ message: 'durationDays phÃ¡ÂºÂ£i > 0' });
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t deadline bÃ†Â°Ã¡Â»â€ºc ' + stepId, stepId, openedAt, dueAt, durationDays, updatedAt });
});

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN / Admin: cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN (hiÃ¡Â»Æ’n thÃ¡Â»â€¹ trÃƒÂªn timeline)
app.put('/api/cap-vien/submissions/:id/steps/5/hd-meeting', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin hÃ¡Â»Âp.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
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
  insertCapVienHistory(id, '5', 'hd_meeting_info_update', req.user.id, role === 'admin' ? 'admin' : 'secretary', 'CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin hÃ¡Â»Âp HÃ„Â KHCN', updatedAt);
  const subMeta = db.prepare('SELECT title, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  const researcherH = subMeta && subMeta.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(subMeta.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: subMeta ? subMeta.title : '',
    submissionId: id,
    subjectLine: '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin hÃ¡Â»Âp HÃ„Â KHCN Ã¢â‚¬â€ ' + (subMeta ? subMeta.title : ''),
    bodyHtml: '<p><strong>ThÃƒÂ´ng tin hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN</strong> cÃ¡Â»Â§a Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + capVienEmailEsc(subMeta ? subMeta.title : '') + '</strong> Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.</p><p>KÃƒÂ­nh mÃ¡Â»Âi ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m vÃƒÂ  cÃƒÂ¡c thÃƒÂ nh viÃƒÂªn liÃƒÂªn quan xem chi tiÃ¡ÂºÂ¿t tÃ¡ÂºÂ¡i BÃ†Â°Ã¡Â»â€ºc 5.</p>',
    bodyText: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin hÃ¡Â»Âp HÃ„Â KHCN Ã¢â‚¬â€ ' + (subMeta ? subMeta.title : ''),
    councilList: getNotificationEmails(),
    researcherEmail: researcherH ? researcherH.email : null
  });
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u thÃƒÂ´ng tin hÃ¡Â»Âp HÃ„Â KHCN.', updatedAt });
});

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN / Admin: upload biÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp HÃ„Â KHCN (lÃ†Â°u file + lÃ¡Â»â€¹ch sÃ¡Â»Â­)
app.post('/api/cap-vien/submissions/:id/steps/5/upload-minutes', authMiddleware, (req, res, next) => {
  uploadCapVien.single('bien_ban_hop')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'DÃ¡Â»Â¯ liÃ¡Â»â€¡u file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p biÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° nÃ¡Â»â„¢p biÃƒÂªn bÃ¡ÂºÂ£n khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ Ã„â€˜Ã¡ÂºÂ¿n BÃ†Â°Ã¡Â»â€ºc 5 (sau BÃ†Â°Ã¡Â»â€ºc 4 & 4A), hoÃ¡ÂºÂ·c Ã„â€˜ang Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i sau hÃ¡Â»Âp (CONDITIONAL).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file biÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp (PDF, Word).' });

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

  const note = 'Upload biÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp HÃ„Â KHCN: ' + storedName;
  insertCapVienHistory(id, '5', 'step5_bien_ban_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-minutes Ã¢â‚¬â€ submission ' + id);
  const researcherBb = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ Ã„ÂÃƒÂ£ upload biÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp HÃ„Â Ã¢â‚¬â€ ' + sub.title,
    bodyHtml: '<p><strong>BiÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN</strong> (file: ' + capVienEmailEsc(storedName) + ') cho Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + capVienEmailEsc(sub.title) + '</strong> Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c lÃ†Â°u trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.</p>',
    bodyText: 'Ã„ÂÃƒÂ£ upload biÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp HÃ„Â Ã¢â‚¬â€ ' + sub.title + ' Ã¢â‚¬â€ ' + storedName,
    councilList: getNotificationEmails(),
    researcherEmail: researcherBb ? researcherBb.email : null
  });
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u biÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp vÃƒÂ o hÃ¡Â»â€œ sÃ†Â¡.', fileName: storedName });
});

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ThÃ†Â° kÃƒÂ½ / Admin: upload thÃƒÂªm tÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m (nhÃ¡ÂºÂ­n xÃƒÂ©t UV HÃ„Â, v.v.) Ã¢â‚¬â€ khÃƒÂ´ng thay thÃ¡ÂºÂ¿ biÃƒÂªn bÃ¡ÂºÂ£n chÃƒÂ­nh
app.post('/api/cap-vien/submissions/:id/steps/5/upload-step5-extras', authMiddleware, (req, res, next) => {
  uploadCapVien.array('step5_extra_files', 30)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'DÃ¡Â»Â¯ liÃ¡Â»â€¡u file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 5 (REVIEWED / IN_MEETING / CONDITIONAL).' });
  }
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân ÃƒÂ­t nhÃ¡ÂºÂ¥t mÃ¡Â»â„¢t file.' });

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
    return res.status(400).json({ message: 'KhÃƒÂ´ng lÃ†Â°u Ã„â€˜Ã†Â°Ã¡Â»Â£c file nÃƒÂ o.' });
  }
  const note = 'TÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m BÃ†Â°Ã¡Â»â€ºc 5: ' + savedNames.join(', ');
  insertCapVienHistory(id, '5', 'step5_extra_file_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-step5-extras Ã¢â‚¬â€ submission ' + id + ', count ' + savedNames.length);
  const researcherEx = sub.submittedById ? db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c]: BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ TÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m mÃ¡Â»â€ºi (' + savedNames.length + ') Ã¢â‚¬â€ ' + sub.title,
    bodyHtml: '<p>Ã„ÂÃƒÂ£ bÃ¡Â»â€¢ sung <strong>' + savedNames.length + '</strong> tÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m tÃ¡ÂºÂ¡i BÃ†Â°Ã¡Â»â€ºc 5 cho Ã„â€˜Ã¡Â»Â tÃƒÂ i <strong>' + capVienEmailEsc(sub.title) + '</strong>: ' + capVienEmailEsc(savedNames.join(', ')) + '.</p>',
    bodyText: 'TÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ' + sub.title + ': ' + savedNames.join(', '),
    councilList: getNotificationEmails(),
    researcherEmail: researcherEx ? researcherEx.email : null
  });
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u ' + savedNames.length + ' tÃƒÂ i liÃ¡Â»â€¡u kÃƒÂ¨m.', fileNames: savedNames });
});

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ThÃ†Â° kÃƒÂ½ / Admin: yÃƒÂªu cÃ¡ÂºÂ§u ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m chÃ¡Â»â€°nh sÃ¡Â»Â­a theo gÃƒÂ³p ÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (mÃ¡Â»Å¸ vÃƒÂ²ng lÃ¡ÂºÂ·p)
app.post('/api/cap-vien/submissions/:id/steps/5/council-request-revision', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi gÃ¡Â»Â­i yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a nÃƒÂ y.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° ÃƒÂ¡p dÃ¡Â»Â¥ng khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 5 (trÃ¡ÂºÂ¡ng thÃƒÂ¡i REVIEWED hoÃ¡ÂºÂ·c IN_MEETING).' });
  }
  const revSt = (sub.step5_council_revision_status || '').trim();
  if (revSt === 'waiting_researcher') {
    return res.status(400).json({ message: 'Ã„Âang chÃ¡Â»Â ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a. HoÃƒÂ n tÃ¡ÂºÂ¥t vÃƒÂ²ng nÃƒÂ y trÃ†Â°Ã¡Â»â€ºc khi gÃ¡Â»Â­i yÃƒÂªu cÃ¡ÂºÂ§u mÃ¡Â»â€ºi.' });
  }
  if (revSt === 'waiting_chair') {
    return res.status(400).json({ message: 'Ã„Âang chÃ¡Â»Â ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN xem xÃƒÂ©t bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
  }
  const body = req.body || {};
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p nÃ¡Â»â„¢i dung gÃƒÂ³p ÃƒÂ½ / yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
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
  insertCapVienHistory(id, '5', 'step5_council_request_revision', req.user.id, roleDb, '[VÃƒÂ²ng ' + nextRound + '] ' + note, requestedAt);
  console.log('[API] cap-vien step 5 council-request-revision Ã¢â‚¬â€ submission ' + id + ', round ' + nextRound);
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tÃ¡Â»â€ºi ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m (vÃƒÂ²ng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m / Admin: nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a theo gÃƒÂ³p ÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng
app.post('/api/cap-vien/submissions/:id/steps/5/council-revision-upload', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'DÃ¡Â»Â¯ liÃ¡Â»â€¡u file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_researcher') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p khi HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a (Ã„â€˜ang chÃ¡Â»Â ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m).' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
  }
  const fList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!fList.length) {
    return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân ÃƒÂ­t nhÃ¡ÂºÂ¥t mÃ¡Â»â„¢t file.' });
  }
  const round = sub.step5_council_revision_round || 1;
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const ts = Date.now();
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i' : 'Admin';
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
  insertCapVienHistory(id, '5', 'step5_council_revision_upload', req.user.id, uploaderRole, uploaderRoleLabel + ' nÃ¡Â»â„¢p ' + fList.length + ' file (vÃƒÂ²ng ' + round + ')', uploadedAt);
  console.log('[API] cap-vien step 5 council-revision-upload Ã¢â‚¬â€ submission ' + id + ', round ' + round);
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a. ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN sÃ¡ÂºÂ½ thÃƒÂ´ng qua hoÃ¡ÂºÂ·c yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p.', status: 'waiting_chair', round });
});

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN / ThÃ†Â° kÃƒÂ½ / Admin: thÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a hoÃ¡ÂºÂ·c yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p
app.post('/api/cap-vien/submissions/:id/steps/5/council-revision-chair', authMiddleware, (req, res) => {
  if (!roleIsAny(req, ['admin', 'chu_tich', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN, ThÃ†Â° kÃƒÂ½ hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi thÃ¡Â»Â±c hiÃ¡Â»â€¡n bÃ†Â°Ã¡Â»â€ºc nÃƒÂ y.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_chair') {
    return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a Ã„â€˜ang chÃ¡Â»Â ChÃ¡Â»Â§ tÃ¡Â»â€¹ch xem xÃƒÂ©t.' });
  }
  const body = req.body || {};
  const action = String(body.action || '').toLowerCase().trim();
  if (!['approve', 'request_more'].includes(action)) {
    return res.status(400).json({ message: 'action phÃ¡ÂºÂ£i lÃƒÂ  approve hoÃ¡ÂºÂ·c request_more' });
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
    insertCapVienHistory(id, '5', 'step5_chair_approve_revision', req.user.id, roleDb, 'ChÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n hÃ¡Â»â€œ sÃ†Â¡ chÃ¡Â»â€°nh sÃ¡Â»Â­a (vÃƒÂ²ng ' + roundAp + ')', performedAt);
    console.log('[API] cap-vien step 5 council-revision-chair approve Ã¢â‚¬â€ submission ' + id);
    sendCapVienStep5ChairApprovedRevisionEmail({
      submissionTitle: sub.title,
      submissionId: id,
      round: roundAp,
      chairName: chairOrActorName,
      researcherEmail: researcherCh ? researcherCh.email : null,
      researcherName: researcherCh ? researcherCh.fullname : null,
      councilList: getNotificationEmails('cap_vien_step5_chair_approved_notice')
    });
    return res.json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a. CÃƒÂ³ thÃ¡Â»Æ’ tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c quy trÃƒÂ¬nh BÃ†Â°Ã¡Â»â€ºc 5 (ghi nhÃ¡ÂºÂ­n thÃƒÂ´ng qua HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng hoÃ¡ÂºÂ·c yÃƒÂªu cÃ¡ÂºÂ§u vÃƒÂ²ng mÃ¡Â»â€ºi).', status: null });
  }
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p gÃƒÂ³p ÃƒÂ½ khi yÃƒÂªu cÃ¡ÂºÂ§u chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p.' });
  const nextRound = (sub.step5_council_revision_round || 1) + 1;
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_council_revision_round = ?,
    step5_council_revision_status = 'waiting_researcher',
    step5_council_revision_note = ?,
    step5_council_revision_requested_at = ?,
    step5_council_revision_requested_by = ?
    WHERE id = ?`).run(nextRound, note, performedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'step5_chair_request_more_revision', req.user.id, roleDb, '[VÃƒÂ²ng ' + nextRound + '] ' + note, performedAt);
  console.log('[API] cap-vien step 5 council-revision-chair request_more Ã¢â‚¬â€ submission ' + id + ', round ' + nextRound);
  sendCapVienStep5ChairRequestMoreEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round: nextRound,
    note,
    chairName: chairOrActorName,
    researcherEmail: researcherCh ? researcherCh.email : null,
    councilList: getNotificationEmails('cap_vien_step5_chair_request_more_notice')
  });
  return res.json({ message: 'Ã„ÂÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m chÃ¡Â»â€°nh sÃ¡Â»Â­a tiÃ¡ÂºÂ¿p (vÃƒÂ²ng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ ThÃ†Â° kÃƒÂ½ / Admin: ghi nhÃ¡ÂºÂ­n HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN thÃƒÂ´ng qua Ã¢â€ â€™ chuyÃ¡Â»Æ’n trÃ¡ÂºÂ¡ng thÃƒÂ¡i sang BÃ†Â°Ã¡Â»â€ºc 6 (CONDITIONAL)
app.post('/api/cap-vien/submissions/:id/steps/5/council-pass', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi ghi nhÃ¡ÂºÂ­n thÃƒÂ´ng qua HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, step5_council_revision_status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° ghi nhÃ¡ÂºÂ­n thÃƒÂ´ng qua khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 5 (REVIEWED / IN_MEETING).' });
  }
  if (sub.step5_council_revision_status) {
    return res.status(400).json({ message: 'Ã„Âang cÃƒÂ³ vÃƒÂ²ng chÃ¡Â»â€°nh sÃ¡Â»Â­a theo gÃƒÂ³p ÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng chÃ†Â°a Ã„â€˜ÃƒÂ³ng. ChÃ¡Â»Â ChÃ¡Â»Â§ tÃ¡Â»â€¹ch thÃƒÂ´ng qua bÃ¡ÂºÂ£n chÃ¡Â»â€°nh sÃ¡Â»Â­a hoÃ¡ÂºÂ·c hoÃƒÂ n tÃ¡ÂºÂ¥t vÃƒÂ²ng nÃƒÂ y.' });
  }
  const performedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'secretary';
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
  insertCapVienHistory(id, '5', 'step5_council_pass_hd', req.user.id, roleDb, 'Ghi nhÃ¡ÂºÂ­n HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN thÃƒÂ´ng qua Ã¢â‚¬â€ chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 6', performedAt);
  console.log('[API] cap-vien step 5 council-pass Ã¢â‚¬â€ submission ' + id);
  const researcherPass = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5CouncilPassedEmail({
    submissionTitle: sub.title,
    submissionId: id,
    researcherEmail: researcherPass ? researcherPass.email : null,
    researcherName: researcherPass ? researcherPass.fullname : null,
    councilList: getNotificationEmails('cap_vien_step5_council_passed_notice'),
    recordedByName: req.user.fullname || req.user.email
  });
  return res.json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN thÃƒÂ´ng qua. HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 6 (CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t).', status: 'CONDITIONAL' });
});

// Danh sÃƒÂ¡ch thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN (ChÃ¡Â»Â§ tÃ¡Â»â€¹ch, ThÃ†Â° kÃƒÂ½, ThÃƒÂ nh viÃƒÂªn) Ã¢â‚¬â€ Ã„â€˜Ã¡Â»Æ’ ChÃ¡Â»Â§ tÃ¡Â»â€¹ch phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n
app.get('/api/cap-vien/council', authMiddleware, (req, res) => {
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi xem Ã„â€˜Ã†Â°Ã¡Â»Â£c danh sÃƒÂ¡ch' });
  const rows = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']);
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname || r.email || '',
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Admin' : (r.role === 'chu_tich' ? 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN' : r.role === 'thu_ky' ? 'ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN' : 'ThÃƒÂ nh viÃƒÂªn HÃ„ÂKHCN')
  }));
  return res.json({ council });
});

// BÃ†Â°Ã¡Â»â€ºc quy trÃƒÂ¬nh Ã„ÂÃ¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n: ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN Ã¢â‚¬â€ BÃ†Â°Ã¡Â»â€ºc 2 (KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡): Ã„ÂÃƒÂ¡nh dÃ¡ÂºÂ¥u HÃ¡Â»Â£p lÃ¡Â»â€¡ / YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung
app.post('/api/cap-vien/submissions/:id/steps/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = req.params.step;
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedBy, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const role = req.user.role;
  const isSecretaryOrAdmin = roleIsAny(req, ['admin', 'thu_ky']);
  if (step === '2') {
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const currentStatus = sub.status || 'SUBMITTED';
    const roleLower = (role || '').toLowerCase();

    // ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2 Ã„â€˜Ã¡Â»Æ’ kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i
    if (action === 'revert') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2 (kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i)' });
      }
      if (currentStatus === 'SUBMITTED') {
        return res.status(400).json({ message: 'HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 2, khÃƒÂ´ng cÃ¡ÂºÂ§n Ã„â€˜Ã†Â°a vÃ¡Â»Â' });
      }
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
        .run('SUBMITTED', id);
      insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2 Ã„â€˜Ã¡Â»Æ’ kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i');
      console.log('[API] cap-vien step 2 revert Ã¢â‚¬â€ submission ' + id);
      return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2. ThÃ†Â° kÃƒÂ½ cÃƒÂ³ thÃ¡Â»Æ’ nhÃ¡ÂºÂ¥n HÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung lÃ¡ÂºÂ¡i.', status: 'SUBMITTED' });
    }

    if (!isSecretaryOrAdmin) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃ¡Â»Â±c hiÃ¡Â»â€¡n BÃ†Â°Ã¡Â»â€ºc 2 (KiÃ¡Â»Æ’m tra hÃ¡Â»â€œ sÃ†Â¡)' });
    }
    if (currentStatus !== 'SUBMITTED') {
      return res.status(400).json({ message: 'HÃ¡Â»â€œ sÃ†Â¡ nÃƒÂ y Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃ¡Â»Â­ lÃƒÂ½ tÃ¡ÂºÂ¡i BÃ†Â°Ã¡Â»â€ºc 2. ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi cÃƒÂ³ thÃ¡Â»Æ’ Ã„â€˜Ã†Â°a vÃ¡Â»Â Ã„â€˜Ã¡Â»Æ’ kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i.' });
    }
    if (action === 'approve') {
      const reviewedAt = new Date().toISOString();
      const note = (payload.note || '').trim();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('VALIDATED', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_approve', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note || 'HÃ¡Â»Â£p lÃ¡Â»â€¡');
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
      console.log('[API] cap-vien step 2 approve Ã¢â‚¬â€ submission ' + id);
      return res.json({ message: 'Ã„ÂÃƒÂ£ HÃ¡Â»Â£p lÃ¡Â»â€¡. HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 3.', status: 'VALIDATED' });
    }
    if (action === 'request_revision') {
      const note = (payload.note || '').trim();
      if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p nÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung' });
      const reviewedAt = new Date().toISOString();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('NEED_REVISION', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_request_revision', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note);
      const secretaryName = (req.user.fullname || req.user.email || 'ThÃ†Â° kÃƒÂ½').toString();
      const rowSub = db.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
      const researcherName = rowSub && rowSub.submittedById ? (db.prepare('SELECT fullname FROM users WHERE id = ?').get(rowSub.submittedById) || {}).fullname : null;
      sendCapVienStep2RevisionEmail(sub.title, sub.submittedBy || null, note, secretaryName, id, researcherName);
      console.log('[API] cap-vien step 2 request_revision Ã¢â‚¬â€ submission ' + id);
      return res.json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. NÃ¡Â»â„¢i dung Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn vÃƒÂ  thÃƒÂ´ng bÃƒÂ¡o cho HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng.', status: 'NEED_REVISION' });
    }
    return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. DÃƒÂ¹ng action: approve, request_revision hoÃ¡ÂºÂ·c revert (chÃ¡Â»â€° Admin)' });
  }
  if (step === '3') {
    const isChairmanOrAdmin = roleIsAny(req, ['admin', 'chu_tich']);
    if (!isChairmanOrAdmin) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n' });
    }
    if ((sub.status || '') !== 'VALIDATED') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° cÃƒÂ³ thÃ¡Â»Æ’ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ HÃ¡Â»Â£p lÃ¡Â»â€¡ (BÃ†Â°Ã¡Â»â€ºc 2 xong)' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'assign') {
      return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. DÃƒÂ¹ng action: assign' });
    }
    let reviewerIds = (payload.reviewerIds || body.reviewerIds || []).map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
    if (payload.reviewer1 && payload.reviewer2) {
      reviewerIds = [parseInt(payload.reviewer1, 10), parseInt(payload.reviewer2, 10)].filter(rid => rid > 0);
    }
    reviewerIds = [...new Set(reviewerIds)];
    if (reviewerIds.length < 2) {
      return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân Ã„â€˜Ã¡Â»Â§ 2 phÃ¡ÂºÂ£n biÃ¡Â»â€¡n tÃ¡Â»Â« danh sÃƒÂ¡ch thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng' });
    }
    const councilIds = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']).map((r) => r.id);
    const invalid = reviewerIds.filter(rid => !councilIds.includes(rid));
    if (invalid.length > 0) {
      return res.status(400).json({ message: 'TÃ¡ÂºÂ¥t cÃ¡ÂºÂ£ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n phÃ¡ÂºÂ£i lÃƒÂ  thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (ChÃ¡Â»Â§ tÃ¡Â»â€¹ch, ThÃ†Â° kÃƒÂ½, ThÃƒÂ nh viÃƒÂªn HÃ„ÂKHCN)' });
    }
    const assignedAt = new Date().toISOString();
    db.prepare('UPDATE cap_vien_submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ? WHERE id = ?')
      .run('ASSIGNED', JSON.stringify(reviewerIds), assignedAt, req.user.id, id);
    const reviewerNamesArr = db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '');
    insertCapVienHistory(id, '3', 'chairman_assign', req.user.id, role === 'admin' ? 'admin' : 'chairman', 'PhÃƒÂ¢n cÃƒÂ´ng 2 phÃ¡ÂºÂ£n biÃ¡Â»â€¡n: ' + reviewerNamesArr.join(', '));
    const chairmanName = (req.user.fullname || req.user.email || 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch').toString();
    const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
    const reviewerEmails = reviewers.map(r => r.email);
    const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
    sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
    sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
    console.log('[API] cap-vien step 3 assign Ã¢â‚¬â€ submission ' + id + ', reviewers: ' + reviewerIds.join(','));
    return res.json({ message: 'Ã„ÂÃƒÂ£ phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n. Email Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡ÂºÂ¿n cÃƒÂ¡c phÃ¡ÂºÂ£n biÃ¡Â»â€¡n, HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng vÃƒÂ  TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh.', status: 'ASSIGNED' });
  }
  if (step === '6') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 6 (QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const sub6 = db.prepare('SELECT id, status, step6_so_qd FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub6) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
    if (action !== 'approve') {
      return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. DÃƒÂ¹ng action: approve' });
    }
    if ((sub6.status || '').toUpperCase() !== 'CONDITIONAL') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 7 khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 6 (trÃ¡ÂºÂ¡ng thÃƒÂ¡i sau BÃ†Â°Ã¡Â»â€ºc 5 Ã¢â‚¬â€ CONDITIONAL).' });
    }
    if (!String(sub6.step6_so_qd || '').trim()) {
      return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p vÃƒÂ  lÃ†Â°u SÃ¡Â»â€˜ QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh (mÃ¡Â»Â¥c BÃ†Â°Ã¡Â»â€ºc 6) trÃ†Â°Ã¡Â»â€ºc khi hoÃƒÂ n tÃ¡ÂºÂ¥t.' });
    }
    const hasVn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_vn' LIMIT 1").get(id);
    const hasEn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_en' LIMIT 1").get(id);
    if (!hasVn || !hasEn) {
      return res.status(400).json({ message: 'CÃ¡ÂºÂ§n upload Ã„â€˜Ã¡Â»Â§ file QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh tiÃ¡ÂºÂ¿ng ViÃ¡Â»â€¡t vÃƒÂ  tiÃ¡ÂºÂ¿ng Anh trÃ†Â°Ã¡Â»â€ºc khi hoÃƒÂ n tÃ¡ÂºÂ¥t BÃ†Â°Ã¡Â»â€ºc 6.' });
    }
    const rowMail = db.prepare(`SELECT s.title, s.submittedBy, s.submittedById, s.step6_so_qd,
      u.email AS ownerEmail, u.fullname AS ownerName
      FROM cap_vien_submissions s
      LEFT JOIN users u ON u.id = s.submittedById
      WHERE s.id = ?`).get(id);
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('APPROVED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '6', 'step6_complete', req.user.id, roleDb, 'Ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€ chuyÃ¡Â»Æ’n BÃ†Â°Ã¡Â»â€ºc 7');
    console.log('[API] cap-vien step 6 approve Ã¢â‚¬â€ submission ' + id);
    const researcherEmail = ((rowMail && rowMail.ownerEmail) || (rowMail && rowMail.submittedBy) || '').trim();
    sendCapVienStep6CompletedEmail({
      submissionTitle: rowMail ? rowMail.title : '',
      submissionId: id,
      researcherEmail,
      researcherName: rowMail ? rowMail.ownerName : null,
      soQd: rowMail ? rowMail.step6_so_qd : sub6.step6_so_qd,
      // CC cÃ¡ÂºÂ£ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN lÃ¡ÂºÂ«n PhÃƒÂ²ng KHCN (PhÃƒÂ²ng KHCN lÃƒÂ  nÃ†Â¡i Ã„â€˜ÃƒÂ£ nhÃ¡ÂºÂ­n hÃ¡Â»â€œ sÃ†Â¡ nÃ¡Â»â„¢p mÃ¡Â»â€ºi, cÃ¡ÂºÂ§n biÃ¡ÂºÂ¿t kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ duyÃ¡Â»â€¡t cuÃ¡Â»â€˜i cÃƒÂ¹ng)
      councilList: Array.from(new Set([
        ...getNotificationEmails('cap_vien_step6_completed_notice'),
        ...getPhongKhcnEmails()
      ]))
    }).catch((err) => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 6 hoÃƒÂ n thÃƒÂ nh:', err && err.message));
    return res.json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 6. HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 7 (KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng). Ã„ÂÃƒÂ£ gÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o hÃƒÂ nh chÃƒÂ­nh tÃ¡Â»â€ºi ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m (CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN & PhÃƒÂ²ng KHCN).', status: 'APPROVED' });
  }
  if (step === '7') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 (HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'complete' && action !== 'confirm_signed') {
      return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. DÃƒÂ¹ng action: complete' });
    }
    const sub7 = db.prepare('SELECT id, status, title, submittedBy, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub7) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
    if ((sub7.status || '').toUpperCase() !== 'APPROVED') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i APPROVED (sau BÃ†Â°Ã¡Â»â€ºc 6).' });
    }
    const hasContract = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step7_hop_dong_khcn' LIMIT 1").get(id);
    if (!hasContract) {
      return res.status(400).json({ message: 'CÃ¡ÂºÂ§n upload HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN vÃƒÂ o hÃ¡Â»â€œ sÃ†Â¡ trÃ†Â°Ã¡Â»â€ºc khi nhÃ¡ÂºÂ¥n HoÃƒÂ n thÃƒÂ nh.' });
    }
    const sendMail = getCapVienStep7EmailOnComplete();
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONTRACTED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '7', 'step7_complete', req.user.id, roleDb, 'Ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7 Ã¢â‚¬â€ HÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng KHCN; chuyÃ¡Â»Æ’n bÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo');
    console.log('[API] cap-vien step 7 complete Ã¢â‚¬â€ submission ' + id + ', email=' + sendMail);
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
      }).catch((err) => console.error('[Email] BÃ†Â°Ã¡Â»â€ºc 7 hoÃƒÂ n thÃƒÂ nh:', err && err.message));
    }
    const msg = sendMail
      ? 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7. HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang bÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo (Ã„â€˜Ã„Æ’ng kÃƒÂ½ Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c / tÃ¡ÂºÂ¡m Ã¡Â»Â©ngÃ¢â‚¬Â¦). Ã„ÂÃƒÂ£ gÃ¡Â»Â­i email thÃƒÂ´ng bÃƒÂ¡o hÃƒÂ nh chÃƒÂ­nh tÃ¡Â»â€ºi ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m (CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o).'
      : 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 7. HÃ¡Â»â€œ sÃ†Â¡ chuyÃ¡Â»Æ’n sang bÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo. (Admin Ã„â€˜ÃƒÂ£ tÃ¡ÂºÂ¯t gÃ¡Â»Â­i email tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng.)';
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
    if (!sub8) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
    if ((sub8.status || '').toUpperCase() !== 'CONTRACTED') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° thao tÃƒÂ¡c BÃ†Â°Ã¡Â»â€ºc 8 khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ kÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng (CONTRACTED).' });
    }
    if (action === 'admin_bypass') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c bypass BÃ†Â°Ã¡Â»â€ºc 8 (Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u hoÃƒÂ n thÃƒÂ nh thÃ¡Â»Â§ cÃƒÂ´ng).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'BÃ†Â°Ã¡Â»â€ºc 8 Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1, step8_waived = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_bypass', req.user.id, 'admin', 'Admin bypass BÃ†Â°Ã¡Â»â€ºc 8 Ã¢â‚¬â€ hoÃƒÂ n thÃƒÂ nh khÃƒÂ´ng qua Ã„â€˜Ã¡Â»Â§ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n thÃƒÂ´ng thÃ†Â°Ã¡Â»Âng');
      console.log('[API] cap-vien step 8 admin_bypass Ã¢â‚¬â€ submission ' + id);
      return res.json({ message: 'Ã„ÂÃƒÂ£ bypass BÃ†Â°Ã¡Â»â€ºc 8 (Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u hoÃƒÂ n thÃƒÂ nh).', status: 'CONTRACTED' });
    }
    if (action === 'admin_waive') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t BÃ†Â°Ã¡Â»â€ºc 8 (khÃƒÂ´ng ÃƒÂ¡p dÃ¡Â»Â¥ng cho Ã„â€˜Ã¡Â»Â tÃƒÂ i nÃƒÂ y).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'Ã„ÂÃƒÂ£ hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 8; khÃƒÂ´ng thÃ¡Â»Æ’ bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t. CÃƒÂ³ thÃ¡Â»Æ’ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 7 (Admin) nÃ¡ÂºÂ¿u cÃ¡ÂºÂ§n lÃƒÂ m lÃ¡ÂºÂ¡i.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_waived = 1, step8_completed = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_waive', req.user.id, 'admin', 'Admin bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t BÃ†Â°Ã¡Â»â€ºc 8 Ã¢â‚¬â€ Ã„â€˜Ã„Æ’ng kÃƒÂ½ Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c khÃƒÂ´ng ÃƒÂ¡p dÃ¡Â»Â¥ng cho Ã„â€˜Ã¡Â»Â tÃƒÂ i nÃƒÂ y');
      console.log('[API] cap-vien step 8 admin_waive Ã¢â‚¬â€ submission ' + id);
      return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u BÃ†Â°Ã¡Â»â€ºc 8 khÃƒÂ´ng ÃƒÂ¡p dÃ¡Â»Â¥ng cho Ã„â€˜Ã¡Â»Â tÃƒÂ i nÃƒÂ y.', status: 'CONTRACTED' });
    }
    if (action !== 'complete') {
      return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. DÃƒÂ¹ng: complete, admin_bypass, admin_waive (Admin).' });
    }
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN, ThÃ†Â° kÃƒÂ½ HÃ„ÂKHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 8 (Ã„ÂÃ¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c).' });
    }
    if (sub8.step8_waived === 1 || sub8.step8_waived === true) {
      return res.status(400).json({ message: 'BÃ†Â°Ã¡Â»â€ºc 8 Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u khÃƒÂ´ng ÃƒÂ¡p dÃ¡Â»Â¥ng (bÃ¡ÂºÂ¥t hoÃ¡ÂºÂ¡t).' });
    }
    if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
      return res.status(400).json({ message: 'BÃ†Â°Ã¡Â»â€ºc 8 Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜ÃƒÂ¡nh dÃ¡ÂºÂ¥u hoÃƒÂ n thÃƒÂ nh trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ³.' });
    }
    if (!String(sub8.step8_ma_dao_duc || '').trim()) {
      return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p vÃƒÂ  lÃ†Â°u MÃƒÂ£ Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c trÃ†Â°Ã¡Â»â€ºc khi hoÃƒÂ n tÃ¡ÂºÂ¥t BÃ†Â°Ã¡Â»â€ºc 8.' });
    }
    const hasEthicsFile = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step8_ethics_quyet_dinh' LIMIT 1").get(id);
    if (!hasEthicsFile) {
      return res.status(400).json({ message: 'CÃ¡ÂºÂ§n upload QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c trÃ†Â°Ã¡Â»â€ºc khi hoÃƒÂ n tÃ¡ÂºÂ¥t BÃ†Â°Ã¡Â»â€ºc 8.' });
    }
    db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1 WHERE id = ?').run(id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '8', 'step8_complete', req.user.id, roleDb, 'HoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 8 Ã¢â‚¬â€ Ã„ÂÃ„Æ’ng kÃƒÂ½/CÃ¡ÂºÂ¥p mÃƒÂ£ Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c');
    console.log('[API] cap-vien step 8 complete Ã¢â‚¬â€ submission ' + id);
    return res.json({
      message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh BÃ†Â°Ã¡Â»â€ºc 8. CÃƒÂ³ thÃ¡Â»Æ’ tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c cÃƒÂ¡c bÃ†Â°Ã¡Â»â€ºc tiÃ¡ÂºÂ¿p theo theo quy trÃƒÂ¬nh (BÃ†Â°Ã¡Â»â€ºc 9 trÃ¡Â»Å¸ Ã„â€˜i).',
      status: 'CONTRACTED'
    });
  }
  if (step === '8a') {
    return res.status(410).json({ message: 'BÃ†Â°Ã¡Â»â€ºc 8A Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡Â»Â¡ khÃ¡Â»Âi quy trÃƒÂ¬nh; khÃƒÂ´ng cÃƒÂ²n thao tÃƒÂ¡c tÃ¡ÂºÂ¡i endpoint nÃƒÂ y.' });
  }
  if (step === '9') {
    const isOwner = sub.submittedById === req.user.id;
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c khai bÃƒÂ¡o mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng BÃ†Â°Ã¡Â»â€ºc 9.' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const nowIso = new Date().toISOString();
    const historyRole = isOwner ? 'researcher' : 'admin';

    if (action === 'add_milestone') {
      const title = String(payload.title || '').trim();
      if (!title) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p tÃƒÂªn mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng' });
      const eventDate = payload.eventDate ? String(payload.eventDate).trim() : null;
      const note = payload.note ? String(payload.note).trim() : null;
      const maxRow = db.prepare('SELECT COALESCE(MAX(sortOrder), 0) AS m FROM cap_vien_step9_milestone WHERE submissionId = ? AND deletedAt IS NULL').get(id);
      const sortOrder = (maxRow.m || 0) + 1;
      const ins = db.prepare(
        'INSERT INTO cap_vien_step9_milestone (submissionId, title, status, eventDate, note, sortOrder, createdAt, createdById) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, title, 'planned', eventDate, note, sortOrder, nowIso, req.user.id);
      insertCapVienHistory(id, '9', 'milestone_add', req.user.id, historyRole, 'ThÃƒÂªm mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng: ' + title);
      return res.json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng.', milestoneId: ins.lastInsertRowid });
    }

    if (action === 'update_milestone') {
      const milestoneId = parseInt(payload.milestoneId, 10);
      if (!milestoneId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u milestoneId' });
      const m = db.prepare('SELECT id, title FROM cap_vien_step9_milestone WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(milestoneId, id);
      if (!m) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng' });
      const allowedStatus = ['planned', 'in_progress', 'done'];
      const updates = [];
      const params = [];
      if (payload.title !== undefined) {
        const t = String(payload.title || '').trim();
        if (!t) return res.status(400).json({ message: 'TÃƒÂªn mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng' });
        updates.push('title = ?'); params.push(t);
      }
      if (payload.eventDate !== undefined) { updates.push('eventDate = ?'); params.push(payload.eventDate ? String(payload.eventDate).trim() : null); }
      if (payload.note !== undefined) { updates.push('note = ?'); params.push(payload.note ? String(payload.note).trim() : null); }
      if (payload.status !== undefined) {
        const st = String(payload.status || '').toLowerCase().trim();
        if (!allowedStatus.includes(st)) return res.status(400).json({ message: 'TrÃ¡ÂºÂ¡ng thÃƒÂ¡i khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (planned/in_progress/done)' });
        updates.push('status = ?'); params.push(st);
      }
      if (!updates.length) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ trÃ†Â°Ã¡Â»Âng nÃƒÂ o Ã„â€˜Ã¡Â»Æ’ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t' });
      updates.push('updatedAt = ?', 'updatedById = ?');
      params.push(nowIso, req.user.id, milestoneId);
      db.prepare('UPDATE cap_vien_step9_milestone SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
      insertCapVienHistory(id, '9', 'milestone_update', req.user.id, historyRole, 'CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng: ' + m.title);
      return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng.' });
    }

    if (action === 'delete_milestone') {
      const milestoneId = parseInt(payload.milestoneId, 10);
      if (!milestoneId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u milestoneId' });
      const m = db.prepare('SELECT id, title FROM cap_vien_step9_milestone WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(milestoneId, id);
      if (!m) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng' });
      db.prepare('UPDATE cap_vien_step9_milestone SET deletedAt = ? WHERE id = ?').run(nowIso, milestoneId);
      insertCapVienHistory(id, '9', 'milestone_delete', req.user.id, historyRole, 'XÃƒÂ³a mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng: ' + m.title);
      return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a mÃ¡Â»â€˜c hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng.' });
    }

    return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. DÃƒÂ¹ng action: add_milestone, update_milestone hoÃ¡ÂºÂ·c delete_milestone' });
  }
  return res.status(404).json({ message: 'BÃ†Â°Ã¡Â»â€ºc ' + step + ' chÃ†Â°a Ã„â€˜Ã†Â°Ã¡Â»Â£c triÃ¡Â»Æ’n khai tÃ¡ÂºÂ¡i backend' });
});

// BÃ†Â°Ã¡Â»â€ºc 9 Ã¢â‚¬â€ HoÃƒÂ¡ chÃ¡ÂºÂ¥t, vÃ¡ÂºÂ­t tÃ†Â°: danh mÃ¡Â»Â¥c dÃ¡Â»Â± toÃƒÂ¡n (ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m/Admin khai bÃƒÂ¡o, Admin/PhÃƒÂ²ng KHCN khoÃƒÂ¡ lÃ¡ÂºÂ¡i lÃƒÂ m
// sÃ¡Â»â€˜ liÃ¡Â»â€¡u chÃƒÂ­nh thÃ¡Â»Â©c) + cÃ¡ÂºÂ¥p phÃƒÂ¡t theo Ã„â€˜Ã¡Â»Â£t (ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m/Admin Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹, Admin/PhÃƒÂ²ng KHCN xÃƒÂ¡c nhÃ¡ÂºÂ­n/tÃ¡Â»Â« chÃ¡Â»â€˜i,
// khÃƒÂ´ng cho vÃ†Â°Ã¡Â»Â£t approvedQty). Route riÃƒÂªng (khÃƒÂ´ng dÃƒÂ¹ng chung dispatcher steps/:step Ã¡Â»Å¸ trÃƒÂªn) vÃƒÂ¬ action
// lock_catalog/confirm_issuance/reject_issuance cÃ¡ÂºÂ§n thÃƒÂªm vai trÃƒÂ² PhÃƒÂ²ng KHCN, khÃƒÂ¡c gate owner||admin cÃ¡Â»Â§a
// milestone.
app.post('/api/cap-vien/submissions/:id/step9-supply/action', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, submittedById, budget_4a_status, step9_supply_locked_at FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
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
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c khai bÃƒÂ¡o hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°.' });
    if (locked) return res.status(400).json({ message: 'Danh mÃ¡Â»Â¥c Ã„â€˜ÃƒÂ£ khoÃƒÂ¡, khÃƒÂ´ng thÃ¡Â»Æ’ thÃƒÂªm mÃ¡Â»Â¥c mÃ¡Â»â€ºi.' });
    const name = String(payload.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p tÃƒÂªn hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°' });
    const unit = payload.unit ? String(payload.unit).trim() : null;
    const approvedQty = Number(payload.approvedQty);
    if (!isFinite(approvedQty) || approvedQty < 0) return res.status(400).json({ message: 'SÃ¡Â»â€˜ lÃ†Â°Ã¡Â»Â£ng duyÃ¡Â»â€¡t khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    const approvedAmount = (payload.approvedAmount !== undefined && payload.approvedAmount !== null && payload.approvedAmount !== '') ? Number(payload.approvedAmount) : null;
    const note = payload.note ? String(payload.note).trim() : null;
    const ins = db.prepare(
      'INSERT INTO cap_vien_step9_supply_item (submissionId, name, unit, approvedQty, approvedAmount, note, createdAt, createdById) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, unit, approvedQty, approvedAmount, note, nowIso, req.user.id);
    insertCapVienHistory(id, '9', 'supply_add_item', req.user.id, ownerHistoryRole, 'ThÃƒÂªm hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°: ' + name);
    return res.json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°.', itemId: ins.lastInsertRowid });
  }

  if (action === 'update_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c sÃ¡Â»Â­a hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°.' });
    if (locked) return res.status(400).json({ message: 'Danh mÃ¡Â»Â¥c Ã„â€˜ÃƒÂ£ khoÃƒÂ¡, khÃƒÂ´ng thÃ¡Â»Æ’ sÃ¡Â»Â­a.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y mÃ¡Â»Â¥c' });
    const updates = [];
    const params = [];
    if (payload.name !== undefined) {
      const n = String(payload.name || '').trim();
      if (!n) return res.status(400).json({ message: 'TÃƒÂªn khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng' });
      updates.push('name = ?'); params.push(n);
    }
    if (payload.unit !== undefined) { updates.push('unit = ?'); params.push(payload.unit ? String(payload.unit).trim() : null); }
    if (payload.approvedQty !== undefined) {
      const q = Number(payload.approvedQty);
      if (!isFinite(q) || q < 0) return res.status(400).json({ message: 'SÃ¡Â»â€˜ lÃ†Â°Ã¡Â»Â£ng duyÃ¡Â»â€¡t khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
      updates.push('approvedQty = ?'); params.push(q);
    }
    if (payload.approvedAmount !== undefined) {
      const a = (payload.approvedAmount !== null && payload.approvedAmount !== '') ? Number(payload.approvedAmount) : null;
      updates.push('approvedAmount = ?'); params.push(a);
    }
    if (payload.note !== undefined) { updates.push('note = ?'); params.push(payload.note ? String(payload.note).trim() : null); }
    if (!updates.length) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ trÃ†Â°Ã¡Â»Âng nÃƒÂ o Ã„â€˜Ã¡Â»Æ’ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t' });
    updates.push('updatedAt = ?', 'updatedById = ?');
    params.push(nowIso, req.user.id, itemId);
    db.prepare('UPDATE cap_vien_step9_supply_item SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  }

  if (action === 'delete_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ³a hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°.' });
    if (locked) return res.status(400).json({ message: 'Danh mÃ¡Â»Â¥c Ã„â€˜ÃƒÂ£ khoÃƒÂ¡, khÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y mÃ¡Â»Â¥c' });
    db.prepare('UPDATE cap_vien_step9_supply_item SET deletedAt = ? WHERE id = ?').run(nowIso, itemId);
    return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a.' });
  }

  if (action === 'lock_catalog') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c khoÃƒÂ¡ danh mÃ¡Â»Â¥c.' });
    if (locked) return res.status(400).json({ message: 'Danh mÃ¡Â»Â¥c Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c khoÃƒÂ¡ trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ³.' });
    if (String(sub.budget_4a_status || '').toLowerCase() !== 'approved') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° khoÃƒÂ¡ Ã„â€˜Ã†Â°Ã¡Â»Â£c khi BÃ†Â°Ã¡Â»â€ºc 4A (ThÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n) Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c duyÃ¡Â»â€¡t.' });
    }
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM cap_vien_step9_supply_item WHERE submissionId = ? AND deletedAt IS NULL').get(id);
    if (!cnt.c) return res.status(400).json({ message: 'Danh mÃ¡Â»Â¥c Ã„â€˜ang trÃ¡Â»â€˜ng, chÃ†Â°a cÃƒÂ³ mÃ¡Â»Â¥c nÃƒÂ o Ã„â€˜Ã¡Â»Æ’ khoÃƒÂ¡.' });
    db.prepare('UPDATE cap_vien_submissions SET step9_supply_locked_at = ?, step9_supply_locked_by = ? WHERE id = ?').run(nowIso, req.user.id, id);
    insertCapVienHistory(id, '9', 'supply_lock_catalog', req.user.id, staffHistoryRole, 'KhoÃƒÂ¡ danh mÃ¡Â»Â¥c hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â° (' + cnt.c + ' mÃ¡Â»Â¥c)');
    return res.json({ message: 'Ã„ÂÃƒÂ£ khoÃƒÂ¡ danh mÃ¡Â»Â¥c hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°.' });
  }

  if (action === 'unlock_catalog') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c mÃ¡Â»Å¸ khoÃƒÂ¡ danh mÃ¡Â»Â¥c.' });
    if (!locked) return res.status(400).json({ message: 'Danh mÃ¡Â»Â¥c chÃ†Â°a khoÃƒÂ¡.' });
    db.prepare('UPDATE cap_vien_submissions SET step9_supply_locked_at = NULL, step9_supply_locked_by = NULL WHERE id = ?').run(id);
    insertCapVienHistory(id, '9', 'supply_unlock_catalog', req.user.id, staffHistoryRole, 'MÃ¡Â»Å¸ khoÃƒÂ¡ danh mÃ¡Â»Â¥c hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â° Ã„â€˜Ã¡Â»Æ’ ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t lÃ¡ÂºÂ¡i');
    return res.json({ message: 'Ã„ÂÃƒÂ£ mÃ¡Â»Å¸ khoÃƒÂ¡ danh mÃ¡Â»Â¥c hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â°.' });
  }

  if (action === 'request_issuance') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ cÃ¡ÂºÂ¥p phÃƒÂ¡t.' });
    if (!locked) return res.status(400).json({ message: 'Danh mÃ¡Â»Â¥c chÃ†Â°a khoÃƒÂ¡, chÃ†Â°a thÃ¡Â»Æ’ Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ cÃ¡ÂºÂ¥p phÃƒÂ¡t.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y mÃ¡Â»Â¥c' });
    const qty = Number(payload.qty);
    if (!isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'SÃ¡Â»â€˜ lÃ†Â°Ã¡Â»Â£ng Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    const already = confirmedQtyForItem(itemId);
    if (already + qty > item.approvedQty + 1e-9) {
      return res.status(400).json({ message: 'VÃ†Â°Ã¡Â»Â£t quÃƒÂ¡ sÃ¡Â»â€˜ lÃ†Â°Ã¡Â»Â£ng Ã„â€˜ÃƒÂ£ duyÃ¡Â»â€¡t (cÃƒÂ²n lÃ¡ÂºÂ¡i ' + (item.approvedQty - already) + ' ' + (item.unit || '') + ').' });
    }
    const issuedDate = payload.issuedDate ? String(payload.issuedDate).trim() : null;
    const note = payload.note ? String(payload.note).trim() : null;
    const ins = db.prepare(
      'INSERT INTO cap_vien_step9_supply_issuance (itemId, submissionId, qty, issuedDate, note, status, requestedById, requestedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(itemId, id, qty, issuedDate, note, 'requested', req.user.id, nowIso);
    insertCapVienHistory(id, '9', 'supply_request_issuance', req.user.id, ownerHistoryRole, 'Ã„ÂÃ¡Â»Â nghÃ¡Â»â€¹ cÃ¡ÂºÂ¥p ' + qty + ' ' + (item.unit || '') + ' ' + item.name);
    return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ cÃ¡ÂºÂ¥p phÃƒÂ¡t, chÃ¡Â»Â PhÃƒÂ²ng KHCN xÃƒÂ¡c nhÃ¡ÂºÂ­n.', issuanceId: ins.lastInsertRowid });
  }

  if (action === 'delete_issuance') {
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u issuanceId' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â£t cÃ¡ÂºÂ¥p' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'ChÃ¡Â»â€° xÃƒÂ³a Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ Ã„â€˜ang chÃ¡Â»Â xÃƒÂ¡c nhÃ¡ÂºÂ­n.' });
    if (!isAdmin && iss.requestedById !== req.user.id) return res.status(403).json({ message: 'ChÃ¡Â»â€° ngÃ†Â°Ã¡Â»Âi Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ³a Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ nÃƒÂ y.' });
    db.prepare('DELETE FROM cap_vien_step9_supply_issuance WHERE id = ?').run(issuanceId);
    return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ cÃ¡ÂºÂ¥p phÃƒÂ¡t.' });
  }

  if (action === 'confirm_issuance') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ¡c nhÃ¡ÂºÂ­n cÃ¡ÂºÂ¥p phÃƒÂ¡t.' });
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u issuanceId' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â£t cÃ¡ÂºÂ¥p' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Ã„ÂÃ¡Â»Â£t cÃ¡ÂºÂ¥p nÃƒÂ y Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃ¡Â»Â­ lÃƒÂ½.' });
    const item = getItem(iss.itemId);
    if (!item) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y mÃ¡Â»Â¥c hoÃƒÂ¡ chÃ¡ÂºÂ¥t/vÃ¡ÂºÂ­t tÃ†Â° liÃƒÂªn quan' });
    const already = confirmedQtyForItem(iss.itemId);
    if (already + iss.qty > item.approvedQty + 1e-9) {
      return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ¡c nhÃ¡ÂºÂ­n Ã¢â‚¬â€ tÃ¡Â»â€¢ng Ã„â€˜ÃƒÂ£ cÃ¡ÂºÂ¥p sÃ¡ÂºÂ½ vÃ†Â°Ã¡Â»Â£t sÃ¡Â»â€˜ lÃ†Â°Ã¡Â»Â£ng Ã„â€˜ÃƒÂ£ duyÃ¡Â»â€¡t (cÃƒÂ²n lÃ¡ÂºÂ¡i ' + (item.approvedQty - already) + ' ' + (item.unit || '') + ').' });
    }
    db.prepare('UPDATE cap_vien_step9_supply_issuance SET status = ?, decidedById = ?, decidedAt = ? WHERE id = ?').run('confirmed', req.user.id, nowIso, issuanceId);
    insertCapVienHistory(id, '9', 'supply_confirm_issuance', req.user.id, staffHistoryRole, 'XÃƒÂ¡c nhÃ¡ÂºÂ­n cÃ¡ÂºÂ¥p ' + iss.qty + ' ' + (item.unit || '') + ' ' + item.name);
    return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ¡c nhÃ¡ÂºÂ­n cÃ¡ÂºÂ¥p phÃƒÂ¡t.' });
  }

  if (action === 'reject_issuance') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c tÃ¡Â»Â« chÃ¡Â»â€˜i cÃ¡ÂºÂ¥p phÃƒÂ¡t.' });
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u issuanceId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p lÃƒÂ½ do tÃ¡Â»Â« chÃ¡Â»â€˜i' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â£t cÃ¡ÂºÂ¥p' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Ã„ÂÃ¡Â»Â£t cÃ¡ÂºÂ¥p nÃƒÂ y Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃ¡Â»Â­ lÃƒÂ½.' });
    db.prepare('UPDATE cap_vien_step9_supply_issuance SET status = ?, decidedById = ?, decidedAt = ?, decisionNote = ? WHERE id = ?').run('rejected', req.user.id, nowIso, note, issuanceId);
    insertCapVienHistory(id, '9', 'supply_reject_issuance', req.user.id, staffHistoryRole, 'TÃ¡Â»Â« chÃ¡Â»â€˜i cÃ¡ÂºÂ¥p phÃƒÂ¡t: ' + note);
    return res.json({ message: 'Ã„ÂÃƒÂ£ tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ cÃ¡ÂºÂ¥p phÃƒÂ¡t.' });
  }

  return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
});

// BÃ†Â°Ã¡Â»â€ºc 11: Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh (nhÃƒÂ¢n sÃ¡Â»Â±/kÃ¡ÂºÂ¿ hoÃ¡ÂºÂ¡ch/dÃ¡Â»Â± toÃƒÂ¡n/gia hÃ¡ÂºÂ¡n) Ã¢â‚¬â€ 2 cÃ¡ÂºÂ¥p PhÃƒÂ²ng KHCN -> ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.
app.post('/api/cap-vien/submissions/:id/step11-adjustment/action', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
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
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh.' });
    if (getOpenAdjustmentRequest()) return res.status(400).json({ message: 'Ã„ÂÃƒÂ£ cÃƒÂ³ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh Ã„â€˜ang xÃ¡Â»Â­ lÃƒÂ½, vui lÃƒÂ²ng chÃ¡Â»Â hoÃƒÂ n tÃ¡ÂºÂ¥t trÃ†Â°Ã¡Â»â€ºc khi nÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t mÃ¡Â»â€ºi.' });
    const type = String(payload.type || '').toLowerCase().trim();
    if (!ALLOWED_ADJUSTMENT_TYPES.includes(type)) return res.status(400).json({ message: 'LoÃ¡ÂºÂ¡i Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    const content = String(payload.content || '').trim();
    if (!content) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    const ins = db.prepare(
      'INSERT INTO cap_vien_step11_adjustment_request (submissionId, type, content, status, requestedById, requestedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, type, content, 'submitted', req.user.id, nowIso);
    insertCapVienHistory(id, '11', 'adjustment_submit_request', req.user.id, ownerHistoryRole, 'NÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh (' + type + ')');
    return res.json({ message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh, chÃ¡Â»Â PhÃƒÂ²ng KHCN xem xÃƒÂ©t.', requestId: ins.lastInsertRowid });
  }

  if (action === 'update_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c sÃ¡Â»Â­a Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (r.status !== 'khcn_need_revision') return res.status(400).json({ message: 'ChÃ¡Â»â€° sÃ¡Â»Â­a Ã„â€˜Ã†Â°Ã¡Â»Â£c khi PhÃƒÂ²ng KHCN yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    const updates = [];
    const params = [];
    if (payload.type !== undefined) {
      const t = String(payload.type || '').toLowerCase().trim();
      if (!ALLOWED_ADJUSTMENT_TYPES.includes(t)) return res.status(400).json({ message: 'LoÃ¡ÂºÂ¡i Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
      updates.push('type = ?'); params.push(t);
    }
    if (payload.content !== undefined) {
      const c = String(payload.content || '').trim();
      if (!c) return res.status(400).json({ message: 'NÃ¡Â»â„¢i dung khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng' });
      updates.push('content = ?'); params.push(c);
    }
    updates.push('status = ?'); params.push('submitted');
    params.push(requestId);
    db.prepare('UPDATE cap_vien_step11_adjustment_request SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    insertCapVienHistory(id, '11', 'adjustment_update_request', req.user.id, ownerHistoryRole, 'NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh sau khi bÃ¡Â»â€¢ sung');
    return res.json({ message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t, chÃ¡Â»Â PhÃƒÂ²ng KHCN xem xÃƒÂ©t.' });
  }

  if (action === 'withdraw_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c rÃƒÂºt Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'ChÃ¡Â»â€° rÃƒÂºt Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN xem xÃƒÂ©t lÃ¡ÂºÂ§n Ã„â€˜Ã¡ÂºÂ§u.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected' WHERE id = ?").run(requestId);
    insertCapVienHistory(id, '11', 'adjustment_withdraw_request', req.user.id, ownerHistoryRole, 'RÃƒÂºt Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh');
    return res.json({ message: 'Ã„ÂÃƒÂ£ rÃƒÂºt Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  }

  if (action === 'khcn_request_revision') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p nÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'ChÃ¡Â»â€° xÃ¡Â»Â­ lÃƒÂ½ Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN xem xÃƒÂ©t.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'khcn_need_revision', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_request_revision', req.user.id, actorRole, 'YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh: ' + note);
    return res.json({ message: 'Ã„ÂÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m bÃ¡Â»â€¢ sung Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  }

  if (action === 'khcn_forward') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'ChÃ¡Â»â€° trÃƒÂ¬nh Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN xem xÃƒÂ©t.' });
    const note = payload.note ? String(payload.note).trim() : null;
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'khcn_forwarded', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_forward', req.user.id, actorRole, 'TrÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh');
    return res.json({ message: 'Ã„ÂÃƒÂ£ trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t.' });
  }

  if (action === 'khcn_reject') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c PhÃƒÂ²ng KHCN mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c tÃ¡Â»Â« chÃ¡Â»â€˜i.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p lÃƒÂ½ do tÃ¡Â»Â« chÃ¡Â»â€˜i' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'ChÃ¡Â»â€° tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN xem xÃƒÂ©t.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_reject', req.user.id, actorRole, 'PhÃƒÂ²ng KHCN tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t: ' + note);
    return res.json({ message: 'Ã„ÂÃƒÂ£ tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  }

  if (action === 'director_approve') {
    if (!isDirectorOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (r.status !== 'khcn_forwarded') return res.status(400).json({ message: 'ChÃ¡Â»â€° phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã†Â°Ã¡Â»Â£c khi PhÃƒÂ²ng KHCN Ã„â€˜ÃƒÂ£ trÃƒÂ¬nh.' });
    const note = payload.note ? String(payload.note).trim() : null;
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'approved', directorNote = ?, directorDecidedById = ?, directorDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_director_approve', req.user.id, actorRole, 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh');
    return res.json({ message: 'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜iÃ¡Â»Âu chÃ¡Â»â€°nh.' });
  }

  if (action === 'director_reject') {
    if (!isDirectorOrAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c tÃ¡Â»Â« chÃ¡Â»â€˜i.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p lÃƒÂ½ do khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (r.status !== 'khcn_forwarded') return res.status(400).json({ message: 'ChÃ¡Â»â€° xÃ¡Â»Â­ lÃƒÂ½ Ã„â€˜Ã†Â°Ã¡Â»Â£c khi PhÃƒÂ²ng KHCN Ã„â€˜ÃƒÂ£ trÃƒÂ¬nh.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected', directorNote = ?, directorDecidedById = ?, directorDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_director_reject', req.user.id, actorRole, 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t: ' + note);
    return res.json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t.' });
  }

  return res.status(400).json({ message: 'HÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
});

// BÃ†Â°Ã¡Â»â€ºc 4: PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n upload phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡ (slot 1 hoÃ¡ÂºÂ·c 2) - upload KHONG tu dong "hoan thanh"
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-upload', authMiddleware, uploadCapVien.single('phieu_danh_gia'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.body.slot || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoÃ¡ÂºÂ·c slot khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (slot: 1 hoÃ¡ÂºÂ·c 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° thao tÃƒÂ¡c Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c upload phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡' });
  const file = req.file || req.files?.phieu_danh_gia?.[0];
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡ (PDF hoÃ¡ÂºÂ·c Word)' });

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

  insertCapVienHistory(id, '4', 'reviewer_upload', req.user.id, 'reviewer', 'PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + ' upload phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡');
  console.log('[API] cap-vien step 4 reviewer-upload slot ' + slot + ' Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ upload phiÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ¡nh giÃƒÂ¡. Vui lÃƒÂ²ng nhÃ¡ÂºÂ¥n "HoÃƒÂ n thÃƒÂ nh phÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + '" sau khi kiÃ¡Â»Æ’m tra.', slot });
});

// BÃ†Â°Ã¡Â»â€ºc 4: PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n xÃƒÂ¡c nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh slot
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-complete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoÃ¡ÂºÂ·c slot khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (slot: 1 hoÃ¡ÂºÂ·c 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° thao tÃƒÂ¡c Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ¡c nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh' });

  const hasFile = db.prepare('SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!hasFile) return res.status(400).json({ message: 'PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + ' chÃ†Â°a upload file. Vui lÃƒÂ²ng upload trÃ†Â°Ã¡Â»â€ºc khi nhÃ¡ÂºÂ¥n hoÃƒÂ n thÃƒÂ nh.' });

  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 1 WHERE id = ?').run(id);
  insertCapVienHistory(id, '4', 'reviewer_complete', req.user.id, 'reviewer', 'PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + ' xÃƒÂ¡c nhÃ¡ÂºÂ­n hoÃƒÂ n thÃƒÂ nh');

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
    message: bothDone ? 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n: cÃ¡ÂºÂ£ 2 phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜ÃƒÂ£ hoÃƒÂ n thÃƒÂ nh.' : ('Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n: phÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + ' hoÃƒÂ n thÃƒÂ nh.'),
    slot,
    bothDone,
    step5Ready: bothDone && budgetApproved
  });
});

// BÃ†Â°Ã¡Â»â€ºc 4: XÃƒÂ³a file phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜Ã¡Â»Æ’ upload lÃ¡ÂºÂ¡i
app.post('/api/cap-vien/submissions/:id/steps/4/reviewer-delete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoÃ¡ÂºÂ·c slot khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (slot: 1 hoÃ¡ÂºÂ·c 2)' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° thao tÃƒÂ¡c Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ³a file phÃ¡ÂºÂ£n biÃ¡Â»â€¡n' });

  const row = db.prepare('SELECT id, path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!row) return res.status(400).json({ message: 'ChÃ†Â°a cÃƒÂ³ file phÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + ' Ã„â€˜Ã¡Â»Æ’ xÃƒÂ³a' });
  db.prepare('DELETE FROM cap_vien_submission_files WHERE id = ?').run(row.id);
  if (row.path) safeUnlinkCapVienStoredFile(row.path);
  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('REVIEWED', 'UNDER_REVIEW', id);
  insertCapVienHistory(id, '4', 'reviewer_delete', req.user.id, 'reviewer', 'XÃƒÂ³a file phÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + ' Ã„â€˜Ã¡Â»Æ’ upload lÃ¡ÂºÂ¡i');
  return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a file phÃ¡ÂºÂ£n biÃ¡Â»â€¡n ' + slot + '. BÃ¡ÂºÂ¡n cÃƒÂ³ thÃ¡Â»Æ’ upload lÃ¡ÂºÂ¡i vÃƒÂ  nhÃ¡ÂºÂ¥n hoÃƒÂ n thÃƒÂ nh.', slot });
});

// BÃ†Â°Ã¡Â»â€ºc 4A: NÃ¡Â»â„¢p phiÃ¡ÂºÂ¿u thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n Ã¢â‚¬â€ upload 2 file (budget_phieu_tham_dinh, budget_to_trinh)
app.post('/api/cap-vien/submissions/:id/steps/4a/upload', authMiddleware, uploadCapVien.fields([
  { name: 'budget_phieu_tham_dinh', maxCount: 1 },
  { name: 'budget_to_trinh', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isCouncilOrAdmin) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng, TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p phiÃ¡ÂºÂ¿u thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n' });
  }
  const files = req.files || {};
  const f1 = files.budget_phieu_tham_dinh && files.budget_phieu_tham_dinh[0];
  const f2 = files.budget_to_trinh && files.budget_to_trinh[0];
  if (!f1 || !f2) {
    return res.status(400).json({ message: 'Vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn Ã„â€˜Ã¡Â»Â§ 2 file: PhiÃ¡ÂºÂ¿u thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh (SCI-BUDGET-01) vÃƒÂ  TÃ¡Â»Â trÃƒÂ¬nh (SCI-BUDGET-02)' });
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
  insertCapVienHistory(id, '4a', 'budget_upload', req.user.id, roleLabel, 'NÃ¡Â»â„¢p phiÃ¡ÂºÂ¿u thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n (vÃƒÂ²ng ' + (sub.budget_4a_round || 1) + '): SCI-BUDGET-01, SCI-BUDGET-02');
  console.log('[API] cap-vien step 4a upload Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p phiÃ¡ÂºÂ¿u thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh dÃ¡Â»Â± toÃƒÂ¡n. ThÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng cÃƒÂ³ thÃ¡Â»Æ’ tÃ¡ÂºÂ£i file ngay.', files: ['budget_phieu_tham_dinh', 'budget_to_trinh'] });
});

// BÃ†Â°Ã¡Â»â€ºc 4A: TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a dÃ¡Â»Â± toÃƒÂ¡n Ã¢â‚¬â€ comment + file upload
app.post('/api/cap-vien/submissions/:id/steps/4a/request-revision', authMiddleware, uploadCapVien.fields([
  { name: 'revision_files', maxCount: 10 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const role = req.user.role;
  const isBudgetTeam = roleIsAny(req, ['admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isBudgetTeam) return res.status(403).json({ message: 'ChÃ¡Â»â€° TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung dÃ¡Â»Â± toÃƒÂ¡n' });
  const note = (req.body.note || req.body.comment || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p nÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a' });
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
      .get(id, '[VÃƒÂ²ng ' + currentRound + ']%');
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
  insertCapVienHistory(id, '4a', 'budget_request_revision', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', '[VÃƒÂ²ng ' + nextRound + '] ' + note);
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisionRequestEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, note, requestedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a request-revision Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. Email Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡ÂºÂ¿n ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m vÃƒÂ  CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng.', status: 'need_revision' });
});

// BÃ†Â°Ã¡Â»â€ºc 4A: NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn (ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m) nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i tÃƒÂ i liÃ¡Â»â€¡u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a theo yÃƒÂªu cÃ¡ÂºÂ§u
app.post('/api/cap-vien/submissions/:id/steps/4a/upload-revised', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'DÃ¡Â»Â¯ liÃ¡Â»â€¡u file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if ((sub.budget_4a_status || '') !== 'need_revision') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u chÃ¡Â»â€°nh sÃ¡Â»Â­a khi TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung (BÃ†Â°Ã¡Â»â€ºc 4A)' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'ChÃ¡Â»â€° ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u chÃ¡Â»â€°nh sÃ¡Â»Â­a' });
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i' : 'Admin';
  const revisedList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!revisedList.length) {
    return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân ÃƒÂ­t nhÃ¡ÂºÂ¥t 1 file tÃƒÂ i liÃ¡Â»â€¡u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
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
  insertCapVienHistory(id, '4a', 'researcher_upload_revised', req.user.id, uploaderRole, uploaderRoleLabel + ' nÃ¡Â»â„¢p ' + revisedList.length + ' file tÃƒÂ i liÃ¡Â»â€¡u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a (vÃƒÂ²ng ' + round + ')');
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisedSubmittedEmail({ submissionTitle: sub.title, researcherName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a upload-revised Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u bÃ¡Â»â€¢ sung/chÃ¡Â»â€°nh sÃ¡Â»Â­a. TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh sÃ¡ÂºÂ½ kiÃ¡Â»Æ’m tra vÃƒÂ  phÃƒÂª duyÃ¡Â»â€¡t hoÃ¡ÂºÂ·c yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung tiÃ¡ÂºÂ¿p.' });
});

// BÃ†Â°Ã¡Â»â€ºc 4A: TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t dÃ¡Â»Â± toÃƒÂ¡n
app.post('/api/cap-vien/submissions/:id/steps/4a/approve', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const role = req.user.role;
  const isBudgetTeam = roleIsAny(req, ['admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isBudgetTeam) return res.status(403).json({ message: 'ChÃ¡Â»â€° TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t dÃ¡Â»Â± toÃƒÂ¡n' });
  const roundNow = sub.budget_4a_round || 1;
  const cntBudget = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh')").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const cntRevised = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName LIKE 'budget_revised_attachment_%'").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const hasBudgetPair = !!cntBudget && Number(cntBudget.c || 0) >= 2;
  const hasRevisedAttachments = !!cntRevised && Number(cntRevised.c || 0) > 0;
  if (!hasBudgetPair && !hasRevisedAttachments) {
    return res.status(400).json({ message: 'ChÃ†Â°a cÃƒÂ³ tÃƒÂ i liÃ¡Â»â€¡u Ã„â€˜Ã¡Â»Æ’ phÃƒÂª duyÃ¡Â»â€¡t Ã¡Â»Å¸ vÃƒÂ²ng hiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i. Vui lÃƒÂ²ng nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh hoÃ¡ÂºÂ·c chÃ¡Â»Â ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m nÃ¡Â»â„¢p tÃƒÂ i liÃ¡Â»â€¡u bÃ¡Â»â€¢ sung.' });
  }
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_approved_at = ?, budget_4a_approved_by = ? WHERE id = ?')
    .run('approved', approvedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_approve', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', 'TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t dÃ¡Â»Â± toÃƒÂ¡n');
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
  console.log('[API] cap-vien step 4a approve Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t dÃ¡Â»Â± toÃƒÂ¡n. Email Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡ÂºÂ¿n ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m vÃƒÂ  HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng.' + (step4Done ? ' BÃ†Â°Ã¡Â»â€ºc 4 vÃƒÂ  4A Ã„â€˜Ã¡Â»Âu hoÃƒÂ n thÃƒÂ nh, Ã„â€˜ÃƒÂ£ chuyÃ¡Â»Æ’n sang BÃ†Â°Ã¡Â»â€ºc 5.' : ' Ã„Âang chÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 4 (PhÃ¡ÂºÂ£n biÃ¡Â»â€¡n) hoÃƒÂ n thÃƒÂ nh.'), status: 'approved', step5Ready: step4Done });
});

// Admin: GÃ¡Â»Â­i lÃ¡ÂºÂ¡i email BÃ†Â°Ã¡Â»â€ºc 4 (phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã¢â€ â€™ phÃ¡ÂºÂ£n biÃ¡Â»â€¡n + HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng) Ã¢â‚¬â€ dÃƒÂ¹ng khi Ã„â€˜ÃƒÂ£ qua bÃ†Â°Ã¡Â»â€ºc 3Ã¢â€ â€™4 nhÃ†Â°ng email chÃ†Â°a gÃ¡Â»Â­i
app.post('/api/cap-vien/submissions/:id/send-step4-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, assignedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° gÃ¡Â»Â­i Ã„â€˜Ã†Â°Ã¡Â»Â£c email BÃ†Â°Ã¡Â»â€ºc 4 khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ qua BÃ†Â°Ã¡Â»â€ºc 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  if (reviewerIds.length < 2) return res.status(400).json({ message: 'HÃ¡Â»â€œ sÃ†Â¡ chÃ†Â°a cÃƒÂ³ Ã„â€˜Ã¡Â»Â§ 2 phÃ¡ÂºÂ£n biÃ¡Â»â€¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ¢n cÃƒÂ´ng' });
  const chairmanRow = sub.assignedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(sub.assignedById) : null;
  const chairmanName = (chairmanRow && (chairmanRow.fullname || chairmanRow.email)) || 'ChÃ¡Â»Â§ tÃ¡Â»â€¹ch';
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
  const reviewerEmails = reviewers.map(r => r.email).filter(Boolean);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
  console.log('[API] cap-vien admin send-step4-email Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i email BÃ†Â°Ã¡Â»â€ºc 4 Ã„â€˜Ã¡ÂºÂ¿n cÃƒÂ¡c phÃ¡ÂºÂ£n biÃ¡Â»â€¡n vÃƒÂ  HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng.' });
});

// Admin: GÃ¡Â»Â­i lÃ¡ÂºÂ¡i email BÃ†Â°Ã¡Â»â€ºc 4A (thÃƒÂ´ng bÃƒÂ¡o TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh, CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng) Ã¢â‚¬â€ dÃƒÂ¹ng khi Ã„â€˜ÃƒÂ£ qua bÃ†Â°Ã¡Â»â€ºc 3Ã¢â€ â€™4 nhÃ†Â°ng email chÃ†Â°a gÃ¡Â»Â­i
app.post('/api/cap-vien/submissions/:id/send-step4a-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° gÃ¡Â»Â­i Ã„â€˜Ã†Â°Ã¡Â»Â£c email BÃ†Â°Ã¡Â»â€ºc 4A khi hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ qua BÃ†Â°Ã¡Â»â€ºc 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
  console.log('[API] cap-vien admin send-step4a-email Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i email BÃ†Â°Ã¡Â»â€ºc 4A Ã„â€˜Ã¡ÂºÂ¿n TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh (CC HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng).' });
});

// Admin Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2 (route riÃƒÂªng Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡ÂºÂ£m bÃ¡ÂºÂ£o revert luÃƒÂ´n hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng)
app.post('/api/cap-vien/submissions/:id/revert-to-step-2', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2 (kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const currentStatus = sub.status || 'SUBMITTED';
  if (currentStatus === 'SUBMITTED') {
    return res.status(400).json({ message: 'HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ang Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 2, khÃƒÂ´ng cÃ¡ÂºÂ§n Ã„â€˜Ã†Â°a vÃ¡Â»Â' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
    .run('SUBMITTED', id);
  insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2 Ã„â€˜Ã¡Â»Æ’ kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i');
  console.log('[API] cap-vien revert-to-step-2 Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2. ThÃ†Â° kÃƒÂ½ cÃƒÂ³ thÃ¡Â»Æ’ nhÃ¡ÂºÂ¥n HÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung lÃ¡ÂºÂ¡i.', status: 'SUBMITTED' });
});

// Admin Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â bÃ†Â°Ã¡Â»â€ºc trÃ†Â°Ã¡Â»â€ºc (3, 4, 5, 6, 7) Ã¢â‚¬â€ nÃƒÂºt "Ã„ÂÃ†Â°a vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc N (Admin)"
app.post('/api/cap-vien/submissions/:id/revert-to-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = parseInt(req.params.step, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  if (isNaN(step) || step < 2 || step > 7) return res.status(400).json({ message: 'BÃ†Â°Ã¡Â»â€ºc phÃ¡ÂºÂ£i tÃ¡Â»Â« 2 Ã„â€˜Ã¡ÂºÂ¿n 7' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â bÃ†Â°Ã¡Â»â€ºc trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ³' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });

  if (step === 2) {
    db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?').run('SUBMITTED', id);
    insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2');
    return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 2.', status: 'SUBMITTED' });
  }

  const clearStep4And4a = () => {
    db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL WHERE id = ?').run(id);
  };

  if (step === 3) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('VALIDATED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 3 Ã¢â‚¬â€ submission ' + id);
    return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 3 (PhÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n).', status: 'VALIDATED' });
  }

  if (step === 4) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('ASSIGNED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 4 Ã¢â‚¬â€ submission ' + id);
    return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 4 & 4A.', status: 'ASSIGNED' });
  }

  if (step === 5) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 5 (HÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng).', status: 'REVIEWED' });
  }

  if (step === 6) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
    return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 6 (CÃ¡ÂºÂ¥p QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh).', status: 'CONDITIONAL' });
  }

  if (step === 7) {
    db.prepare(`UPDATE cap_vien_submissions SET status = ?, step8_completed = 0, step8_waived = 0,
      step8a_completed = 0, step8a_waived = 0 WHERE id = ?`).run('APPROVED', id);
    return res.json({ message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a hÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â BÃ†Â°Ã¡Â»â€ºc 7 (KÃƒÂ½ hÃ¡Â»Â£p Ã„â€˜Ã¡Â»â€œng).', status: 'APPROVED' });
  }

  return res.status(400).json({ message: 'BÃ†Â°Ã¡Â»â€ºc khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
});

// Dev-only tiÃ¡Â»â€¡n ÃƒÂ­ch: reset BÃ†Â°Ã¡Â»â€ºc 2 / 3 / 4 / 4A / 5 vÃ¡Â»Â trÃ¡ÂºÂ¡ng thÃƒÂ¡i ban Ã„â€˜Ã¡ÂºÂ§u
app.post('/api/cap-vien/submissions/:id/dev-reset-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepKey = String(req.params.step || '').toLowerCase();
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  if (!['2', '3', '4', '4a', '5'].includes(stepKey)) return res.status(400).json({ message: 'ChÃ¡Â»â€° hÃ¡Â»â€” trÃ¡Â»Â£ reset bÃ†Â°Ã¡Â»â€ºc 2, 3, 4, 4A hoÃ¡ÂºÂ·c 5' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c reset bÃ†Â°Ã¡Â»â€ºc (dev)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });

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
    return res.json({ message: 'Ã„ÂÃƒÂ£ reset BÃ†Â°Ã¡Â»â€ºc 2 (vÃƒÂ  dÃ¡Â»Ân dÃ¡Â»Â¯ liÃ¡Â»â€¡u thÃ¡Â»Â­ BÃ†Â°Ã¡Â»â€ºc 3Ã¢â‚¬â€œ4Ã¢â‚¬â€œ4A). HÃ¡Â»â€œ sÃ†Â¡ vÃ¡Â»Â SUBMITTED, chÃ¡Â»Â ThÃ†Â° kÃƒÂ½ kiÃ¡Â»Æ’m tra lÃ¡ÂºÂ¡i.', status: 'SUBMITTED' });
  }

  if (stepKey === '3') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'Ã„ÂÃƒÂ£ reset BÃ†Â°Ã¡Â»â€ºc 3 vÃ¡Â»Â trÃ¡ÂºÂ¡ng thÃƒÂ¡i ban Ã„â€˜Ã¡ÂºÂ§u (chÃ¡Â»Â phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n).', status: 'VALIDATED' });
  }

  if (stepKey === '4') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName IN ('reviewer_phieu_1','reviewer_phieu_2')").run(id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'Ã„ÂÃƒÂ£ reset BÃ†Â°Ã¡Â»â€ºc 4 vÃ¡Â»Â trÃ¡ÂºÂ¡ng thÃƒÂ¡i ban Ã„â€˜Ã¡ÂºÂ§u (chÃ¡Â»Â phÃƒÂ¢n cÃƒÂ´ng phÃ¡ÂºÂ£n biÃ¡Â»â€¡n).', status: 'VALIDATED' });
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
      message: 'Ã„ÂÃƒÂ£ reset BÃ†Â°Ã¡Â»â€ºc 5: xÃƒÂ³a thÃƒÂ´ng tin hÃ¡Â»Âp, biÃƒÂªn bÃ¡ÂºÂ£n, lÃ¡Â»â€¹ch sÃ¡Â»Â­ & deadline bÃ†Â°Ã¡Â»â€ºc 5.',
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ reset BÃ†Â°Ã¡Â»â€ºc 4A vÃ¡Â»Â trÃ¡ÂºÂ¡ng thÃƒÂ¡i ban Ã„â€˜Ã¡ÂºÂ§u (thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh lÃ¡ÂºÂ¡i tÃ¡Â»Â« Ã„â€˜Ã¡ÂºÂ§u).', status: 'ASSIGNED' });
});

// NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ sau khi ThÃ†Â° kÃƒÂ½ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung (BÃ†Â°Ã¡Â»â€ºc 2) Ã¢â‚¬â€ chÃ¡Â»â€° cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t trÃ¡ÂºÂ¡ng thÃƒÂ¡i (khÃƒÂ´ng file). NÃ¡ÂºÂ¿u cÃƒÂ³ file bÃ¡Â»â€¢ sung thÃƒÂ¬ dÃƒÂ¹ng POST /supplement.
app.post('/api/cap-vien/submissions/:id/resubmit', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i khi ThÃ†Â° kÃƒÂ½ Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung (trÃ¡ÂºÂ¡ng thÃƒÂ¡i CÃ¡ÂºÂ§n bÃ¡Â»â€¢ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° chÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_resubmit', req.user.id, 'researcher', 'NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ (khÃƒÂ´ng file bÃ¡Â»â€¢ sung)');
  console.log('[API] cap-vien resubmit Ã¢â‚¬â€ submission ' + id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡. ThÃ†Â° kÃƒÂ½ sÃ¡ÂºÂ½ kiÃ¡Â»Æ’m tra vÃƒÂ  nhÃ¡ÂºÂ¥n HÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.', status: 'SUBMITTED' });
});

// NÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung (BÃ†Â°Ã¡Â»â€ºc 2 Ã¢â‚¬â€ vÃ¡ÂºÂ«n trong quy trÃƒÂ¬nh BÃ†Â°Ã¡Â»â€ºc 2): upload file(s), lÃ†Â°u bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi hÃ¡Â»â€œ sÃ†Â¡ gÃ¡Â»â€˜c (revisionRound tÃ„Æ’ng), chuyÃ¡Â»Æ’n status vÃ¡Â»Â SUBMITTED
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
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung khi ThÃ†Â° kÃƒÂ½ Ã„â€˜ÃƒÂ£ yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung (trÃ¡ÂºÂ¡ng thÃƒÂ¡i CÃ¡ÂºÂ§n bÃ¡Â»â€¢ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° chÃ¡Â»Â§ nhiÃ¡Â»â€¡m Ã„â€˜Ã¡Â»Â tÃƒÂ i hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung' });
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
  insertCapVienStep2History(id, 'researcher_supplement', req.user.id, 'researcher', uploadedFiles.length > 0 ? `NÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung lÃ¡ÂºÂ§n ${nextRound} (${uploadedFiles.length} file)` : 'NÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung');
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
  console.log('[API] cap-vien supplement Ã¢â‚¬â€ submission ' + id + ', round ' + nextRound + ', files: ' + uploadedFiles.length);
  return res.json({
    message: uploadedFiles.length > 0
      ? 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n hÃ¡Â»â€œ sÃ†Â¡ bÃ¡Â»â€¢ sung (lÃ¡ÂºÂ§n ' + nextRound + '). QuÃƒÂ¡ trÃƒÂ¬nh vÃ¡ÂºÂ«n Ã¡Â»Å¸ BÃ†Â°Ã¡Â»â€ºc 2. ThÃ†Â° kÃƒÂ½ sÃ¡ÂºÂ½ kiÃ¡Â»Æ’m tra vÃƒÂ  nhÃ¡ÂºÂ¥n HÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.'
      : 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n. ThÃ†Â° kÃƒÂ½ sÃ¡ÂºÂ½ kiÃ¡Â»Æ’m tra vÃƒÂ  nhÃ¡ÂºÂ¥n HÃ¡Â»Â£p lÃ¡Â»â€¡ hoÃ¡ÂºÂ·c YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.',
    status: 'SUBMITTED',
    supplementRound: nextRound,
    filesCount: uploadedFiles.length
  });
});

app.get('/api/cap-vien/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân tÃ¡ÂºÂ£i hÃ¡Â»â€œ sÃ†Â¡ nÃƒÂ y' });
  }
  const files = db.prepare('SELECT path, originalName FROM cap_vien_submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y file hÃ¡Â»â€œ sÃ†Â¡' });
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
  if (!id || !fileId) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân tÃ¡ÂºÂ£i file nÃƒÂ y' });
  const file = db.prepare('SELECT id, path, originalName FROM cap_vien_submission_files WHERE id = ? AND submissionId = ?').get(fileId, id);
  if (!file || !file.path) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y file' });
  return safeDownload(res, file.path, file.originalName);
});

app.delete('/api/cap-vien/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  try {
    deleteCapVienSubmissionCascade(id);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'INVALID_CAP_VIEN_SUBMISSION_ID') return res.status(400).json({ message: 'ID hÃ¡Â»â€œ sÃ†Â¡ khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
    if (msg === 'CAP_VIEN_SUBMISSION_NOT_FOUND') return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y hÃ¡Â»â€œ sÃ†Â¡.' });
    console.error('[cap-vien/submissions DELETE]', msg || e);
    return res.status(500).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a hÃ¡Â»â€œ sÃ†Â¡. ' + msg });
  }
  return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n vÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u liÃƒÂªn quan (dashboard, tiÃ¡ÂºÂ¿n trÃƒÂ¬nh, file).' });
});

// Admin: danh sÃƒÂ¡ch user (khÃƒÂ´ng trÃ¡ÂºÂ£ hash password; cÃƒÂ³ cÃ¡Â»Â activated)
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

// Admin: nhÃ¡ÂºÂ­t kÃƒÂ½ Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p / truy cÃ¡ÂºÂ­p / hÃƒÂ nh Ã„â€˜Ã¡Â»â„¢ng (bÃ¡ÂºÂ£ng user_activity_log)
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

// Admin: thÃƒÂªm tÃƒÂ i khoÃ¡ÂºÂ£n mÃ¡Â»â€ºi hoÃ¡ÂºÂ·c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t hÃ¡Â»Â tÃƒÂªn + vai trÃƒÂ² (gÃƒÂµ hÃ¡Â»Â tÃƒÂªn, email, chÃ¡Â»Ân vai trÃƒÂ²)
app.post('/api/admin/users', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, password, academicTitle } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p email' });
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || 'researcher').toLowerCase().trim();
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trÃƒÂ² khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. Vui lÃƒÂ²ng khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng lÃ¡ÂºÂ¡i server (node server.js) vÃƒÂ  thÃ¡Â»Â­ lÃ¡ÂºÂ¡i.' });
  if (councilRoles.includes(r) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° email @sci.edu.vn mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃƒÂ¡n vai trÃƒÂ² ChÃ¡Â»Â§ tÃ¡Â»â€¹ch, ThÃ†Â° kÃƒÂ½, ThÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng' });
  }
  if (councilRoles.includes(r) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p vai trÃƒÂ² thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN.' });
  }
  if (BUDGET_TEAM_ROLES.includes(r) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p vai trÃƒÂ² TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh.' });
  }
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  const acadTitle = (academicTitle || '').trim() || null;
  const oldRole = existing ? (existing.role || '').toLowerCase() : '';
  const promotingToAdmin = r === 'admin' && oldRole !== 'admin';
  const demotingFromAdmin = oldRole === 'admin' && r !== 'admin';
  if (promotingToAdmin && !reqIsMasterAdmin(req)) {
    return res.status(403).json({
      message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃƒÂªm tÃƒÂ i khoÃ¡ÂºÂ£n mÃ¡Â»â€ºi vÃ¡Â»â€ºi vai trÃƒÂ² Admin hoÃ¡ÂºÂ·c nÃƒÂ¢ng user lÃƒÂªn Admin.',
    });
  }
  if (demotingFromAdmin && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡Â»Â¡ quyÃ¡Â»Ân Admin khÃ¡Â»Âi tÃƒÂ i khoÃ¡ÂºÂ£n.' });
  }
  if (demotingFromAdmin && userEmailIsMasterAdmin(em)) {
    return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ gÃ¡Â»Â¡ quyÃ¡Â»Ân Master Admin hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.' });
  }
  if (existing) {
    db.prepare('UPDATE users SET fullname = ?, role = ?, academicTitle = ? WHERE email = ?').run((fullname || '').trim(), r, acadTitle, em);
    return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t hÃ¡Â»Â tÃƒÂªn vÃƒÂ  vai trÃƒÂ² cho ' + em });
  }
  const plainPassword = (password || '').trim();
  if (plainPassword.length > 0 && plainPassword.length < 6) {
    return res.status(400).json({
      message:
        'MÃ¡ÂºÂ­t khÃ¡ÂºÂ©u tÃ¡Â»â€˜i thiÃ¡Â»Æ’u 6 kÃƒÂ½ tÃ¡Â»Â±, hoÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng Ã„â€˜Ã¡Â»Æ’ tÃ¡ÂºÂ¡o tÃƒÂ i khoÃ¡ÂºÂ£n chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t (user tÃ¡Â»Â± Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u qua trang Ã„ÂÃ„Æ’ng kÃƒÂ½ @sci.edu.vn).',
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
    return res.status(201).json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm tÃƒÂ i khoÃ¡ÂºÂ£n vÃ¡Â»â€ºi mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u do bÃ¡ÂºÂ¡n Ã„â€˜Ã¡ÂºÂ·t.', activated: true });
  }
  // Ã„ÂÃ¡Â»Æ’ trÃ¡Â»â€˜ng mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u: tÃƒÂ i khoÃ¡ÂºÂ£n chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t (sentinel '' do cÃ¡Â»â„¢t password thÃ†Â°Ã¡Â»Âng NOT NULL)
  db.prepare('INSERT INTO users (email, password, fullname, role, academicTitle) VALUES (?, ?, ?, ?, ?)').run(
    em,
    '',
    (fullname || '').trim(),
    r,
    acadTitle
  );
  return res.status(201).json({
    message:
      'Ã„ÂÃƒÂ£ thÃƒÂªm tÃƒÂ i khoÃ¡ÂºÂ£n. NgÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng cÃ¡ÂºÂ§n vÃƒÂ o trang Ã„ÂÃ„Æ’ng kÃƒÂ½ (@sci.edu.vn) Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u vÃƒÂ  kÃƒÂ­ch hoÃ¡ÂºÂ¡t.',
    activated: false,
  });
});

// Admin: Ã„â€˜Ã†Â°a tÃƒÂ i khoÃ¡ÂºÂ£n vÃ¡Â»Â chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t (xÃƒÂ³a mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p; khÃƒÂ´ng ÃƒÂ¡p dÃ¡Â»Â¥ng Admin)
app.post('/api/admin/reset-user-password', authMiddleware, adminOnly, (req, res) => {
  const userId = parseInt(req.body && req.body.userId, 10);
  if (!userId || Number.isNaN(userId)) {
    return res.status(400).json({ message: 'userId khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  }
  const row = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
  if (!row) {
    return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  }
  if ((row.role || '').toLowerCase() === 'admin') {
    return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ reset mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u tÃƒÂ i khoÃ¡ÂºÂ£n Admin' });
  }
  if (Number(row.id) === Number(req.user.id)) {
    return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ reset chÃƒÂ­nh tÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜ang Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run('', userId);
  return res.json({
    message: 'Ã„ÂÃƒÂ£ reset. User cÃ¡ÂºÂ§n Ã„â€˜Ã„Æ’ng kÃƒÂ½ lÃ¡ÂºÂ¡i (trang Ã„ÂÃ„Æ’ng kÃƒÂ½ @sci.edu.vn) Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u mÃ¡Â»â€ºi.',
  });
});

// Admin: gÃ¡Â»Â­i email thÃƒÂ´ng bÃƒÂ¡o cÃ¡ÂºÂ¥p vai trÃƒÂ² tÃ¡Â»â€ºi Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° email
app.post('/api/admin/users/send-role-email', authMiddleware, adminOnly, async (req, res) => {
  const { email, fullname, role, tempPassword } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p email' });
  const roleLabel = ROLE_LABELS[role] || role;
  let fullnameToUse = (fullname || '').trim();
  if (!fullnameToUse) {
    const row = db.prepare('SELECT fullname FROM users WHERE email = ?').get(em);
    if (row && row.fullname) fullnameToUse = row.fullname;
  }
  await sendRoleAssignmentEmail(em, fullnameToUse, role || 'researcher', tempPassword || null);
  if (!transporter) {
    return res.status(503).json({ message: 'ChÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh SMTP. KhÃƒÂ´ng thÃ¡Â»Æ’ gÃ¡Â»Â­i email. Xem README_BACKEND.md.' });
  }
  return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i email thÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡ÂºÂ¿n ' + em });
});

// Admin: danh sÃƒÂ¡ch ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n email thÃƒÂ´ng bÃƒÂ¡o (Admin thÃƒÂªm/xÃƒÂ³a; khi cÃƒÂ³ danh sÃƒÂ¡ch nÃƒÂ y thÃƒÂ¬ mÃ¡Â»Âi thÃƒÂ´ng bÃƒÂ¡o gÃ¡Â»Â­i tÃ¡Â»â€ºi Ã„â€˜ÃƒÂ¢y)
app.get('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients ORDER BY id').all();
    return res.json({ recipients: rows || [] });
  } catch (e) {
    return res.json({ recipients: [] });
  }
});

// ========== ThÃ¡Â»â€˜ng kÃƒÂª trang chÃ¡Â»Â§ (sÃ¡Â»â€˜ liÃ¡Â»â€¡u thÃ¡ÂºÂ­t tÃ¡Â»Â« cÃƒÂ¡c module) ==========
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
   * NhÃƒÂ¢n lÃ¡Â»Â±c KHCN: Ã„â€˜Ã¡ÂºÂ¿m bÃ¡ÂºÂ£ng `personnel` chÃ¡Â»â€° khi module Ã„â€˜Ã†Â°Ã¡Â»Â£c bÃ¡ÂºÂ­t trÃƒÂªn trang chÃ¡Â»Â§.
   * Module chÃ†Â°a triÃ¡Â»Æ’n khai (enabled = 0) Ã¢â€ â€™ null Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh hiÃ¡Â»Æ’n thÃ¡Â»â€¹ 0 gÃƒÂ¢y hiÃ¡Â»Æ’u nhÃ¡ÂºÂ§m.
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
   * TÃƒÂ i sÃ¡ÂºÂ£n trÃƒÂ­ tuÃ¡Â»â€¡: sÃ¡Â»â€˜ thÃ¡Â»Â±c tÃ¡Â»Â« cÃƒÂ´ng bÃ¡Â»â€˜ loÃ¡ÂºÂ¡i "BÃ¡ÂºÂ±ng sÃƒÂ¡ng chÃ¡ÂºÂ¿ / GPHI" (publications.pub_type = 'patent'),
   * cÃƒÂ¹ng nguÃ¡Â»â€œn dÃ¡Â»Â¯ liÃ¡Â»â€¡u vÃ¡Â»â€ºi module CÃƒÂ´ng bÃ¡Â»â€˜ khoa hÃ¡Â»Âc Ã¢â‚¬â€ chÃ¡Â»â€° khi module Ã‚Â«ipÃ‚Â» Ã„â€˜Ã†Â°Ã¡Â»Â£c bÃ¡ÂºÂ­t; tÃ¡ÂºÂ¯t Ã¢â€ â€™ null (khÃƒÂ´ng hiÃ¡Â»Æ’n thÃ¡Â»â€¹ 0).
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
  /** ThÃ¡ÂºÂ» module Ã‚Â«CÃƒÂ´ng bÃ¡Â»â€˜ KHCNÃ‚Â» Ã¢â‚¬â€ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ logic lÃ¡Â»Âc vÃ¡Â»â€ºi module (khÃƒÂ´ng tÃƒÂ­nh retracted) */
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
  // CRD Lab Booking Ã¢â‚¬â€ truy vÃ¡ÂºÂ¥n trÃ¡Â»Â±c tiÃ¡ÂºÂ¿p tÃ¡Â»Â« bÃ¡ÂºÂ£ng CRD (Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ vÃ¡Â»â€ºi thÃ¡ÂºÂ» module trÃƒÂªn trang chÃ¡Â»Â§)
  const crdMachines = dbCount('SELECT COUNT(*) as c FROM crd_machines');
  /** LÃ¡Â»â€¹ch cÃƒÂ²n hiÃ¡Â»â€¡u lÃ¡Â»Â±c: tÃ¡Â»Â« ngÃƒÂ y hÃƒÂ´m nay trÃ¡Â»Å¸ Ã„â€˜i, khÃƒÂ´ng tÃƒÂ­nh Ã„â€˜ÃƒÂ£ hÃ¡Â»Â§y */
  const crdActiveBookings = dbCount(
    `SELECT COUNT(*) as c FROM crd_bookings
     WHERE COALESCE(NULLIF(TRIM(status), ''), 'confirmed') != 'cancelled'
     AND date >= date('now')`
  );
  /** NgÃ†Â°Ã¡Â»Âi cÃƒÂ³ hÃ¡Â»â€œ sÃ†Â¡ CRD cÃƒÂ²n Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡ÂºÂ·t lÃ¡Â»â€¹ch (chÃ†Â°a gÃ¡Â»Â¡ quyÃ¡Â»Ân, chÃ†Â°a bÃ¡Â»â€¹ khoÃƒÂ¡) */
  const crdActivePersons = dbCount(
    `SELECT COUNT(*) as c FROM crd_persons
     WHERE COALESCE(crd_access_revoked, 0) = 0 AND COALESCE(is_banned, 0) = 0`
  );
  const facilities = {
    activeBookings: crdActiveBookings,
    machines: crdMachines,
    activeUsers: crdActivePersons,
  };
  /** ThÃ¡ÂºÂ» module Ã‚Â«HÃ¡Â»Â£p tÃƒÂ¡cÃ‚Â» Ã¢â‚¬â€ lÃ¡ÂºÂ¥y sÃ¡Â»â€˜ liÃ¡Â»â€¡u trÃ¡Â»Â±c tiÃ¡ÂºÂ¿p tÃ¡Â»Â« dÃ¡Â»Â¯ liÃ¡Â»â€¡u module Ã„â€˜Ã¡Â»â€˜i tÃƒÂ¡c */
  let cooperationMini = { doi_tac: 0, trong_nuoc: 0, quoc_te: 0 };
  try {
    const { stats, total } = cooperationComputePartnerStats();
    cooperationMini = {
      doi_tac: total || 0,
      trong_nuoc: stats.trong_nuoc || 0,
      quoc_te: stats.quoc_te || 0,
    };
  } catch (e) {
    /* bÃ¡ÂºÂ£ng hÃ¡Â»Â£p tÃƒÂ¡c chÃ†Â°a cÃƒÂ³ hoÃ¡ÂºÂ·c lÃ¡Â»â€”i */
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
    /* bÃ¡ÂºÂ£ng DMS chÃ†Â°a cÃƒÂ³ */
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
    /* bÃ¡ÂºÂ£ng Equipment chÃ†Â°a cÃƒÂ³ */
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
    /* bÃ¡ÂºÂ£ng document workflow chÃ†Â°a cÃƒÂ³ */
  }
  /** ThÃ¡ÂºÂ» module Ã‚Â«HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c trÃƒÂªn Ã„â€˜Ã¡Â»â„¢ng vÃ¡ÂºÂ­tÃ‚Â» Ã¢â‚¬â€ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ trÃ¡ÂºÂ¡ng thÃƒÂ¡i vÃ¡Â»â€ºi /api/submissions (SCI-ACE) */
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
    /* bÃ¡ÂºÂ£ng submissions (SCI-ACE) chÃ†Â°a cÃƒÂ³ */
  }
  const sampleStorageMini = require('./routes/nganHangTeBaoKhangThe').miniStats(db);
  const capVienMini = require('./modules/de-tai-cap-vien/eofficeMount').miniStats();
  return res.json({
    missions, missionMini, capVienMini, personnel, ip,
    publications, publicationMini, cooperation, cooperationMini,
    facilities, dmsMini, equipmentMini, sampleStorageMini, documentWorkflowMini, aceMini,
  });
});

// ========== NhiÃ¡Â»â€¡m vÃ¡Â»Â¥ KHCN (Dashboard): trÃƒÂ­ch xuÃ¡ÂºÂ¥t thÃ¡Â»â€˜ng kÃƒÂª + danh sÃƒÂ¡ch tÃƒÂ¬m kiÃ¡ÂºÂ¿m ==========
syncMissionsFromCapVien();

// NhÃƒÂ³m lÃƒÂµi (thÃ¡Â»â€˜ng kÃƒÂª, danh sÃƒÂ¡ch, Ã„â€˜Ã„Æ’ng kÃƒÂ½ mÃ¡Â»â€ºi) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/missions/core.js.
// Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨: phÃ¡ÂºÂ£i trÃ†Â°Ã¡Â»â€ºc '/api/missions/:id' bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi, vÃƒÂ¬ handler Ã„â€˜ÃƒÂ³
// trÃ¡ÂºÂ£ 400 Ã‚Â«ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡Ã‚Â» vÃƒÂ  khÃƒÂ´ng gÃ¡Â»Âi next() Ã¢â‚¬â€ '/missions/stats' Ã„â€˜Ã„Æ’ng kÃƒÂ½ sau nÃƒÂ³
// sÃ¡ÂºÂ½ chÃ¡ÂºÂ¿t im lÃ¡ÂºÂ·ng.
app.use('/api', require('./routes/missions/core')({
  db,
  authMiddleware,
  transporter,
  PORT,
  syncMissionsFromCapVien,
  getSmtpFrom,
  getNotificationEmails,
}));

// HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã„Æ’ng kÃƒÂ½ + duyÃ¡Â»â€¡t BÃ†Â°Ã¡Â»â€ºc 2Ã¢â‚¬â€œ3 Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/missions/hoSo.js.
// Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨: vÃ¡ÂºÂ«n phÃ¡ÂºÂ£i trÃ†Â°Ã¡Â»â€ºc '/api/missions/:id' bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi.
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

// DuyÃ¡Â»â€¡t BÃ†Â°Ã¡Â»â€ºc 4a/4b/5/6 Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/missions/pheDuyet.js.
// Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨: vÃ¡ÂºÂ«n phÃ¡ÂºÂ£i trÃ†Â°Ã¡Â»â€ºc '/api/missions/:id' bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi.
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

// Danh sÃƒÂ¡ch chÃ¡Â»Â CT HÃ„Â xÃƒÂ©t duyÃ¡Â»â€¡t Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/missions/choXetDuyet.js.
// Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨ Ã¢â‚¬â€ phÃ¡ÂºÂ£i trÃ†Â°Ã¡Â»â€ºc missionsExport vÃƒÂ  missionsChiTiet bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi.
app.use('/api', require('./routes/missions/choXetDuyet')({
  db,
  authMiddleware,
  roleIsAny,
}));

// Admin / PhÃƒÂ²ng KHCN: cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ (Ã„â€˜Ã¡Â»Â tÃƒÂ i) Ã¢â‚¬â€ trÃ¡ÂºÂ¡ng thÃƒÂ¡i cÃƒÂ³ thÃ¡Â»Æ’ lÃƒÂ  mÃƒÂ£ chuÃ¡ÂºÂ©n hoÃ¡ÂºÂ·c chuÃ¡Â»â€”i tÃ¡Â»Â± do
app.put('/api/admin/missions/:id', authMiddleware, adminOrPhongKhcnMissionEditor, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â tÃƒÂ i.' });
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
  if (updates.length === 0) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ trÃ†Â°Ã¡Â»Âng nÃƒÂ o Ã„â€˜Ã¡Â»Æ’ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  params.push(id);
  db.prepare('UPDATE missions SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
  const updated = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget FROM missions WHERE id = ?').get(id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„â€˜Ã¡Â»Â tÃƒÂ i.', mission: updated });
});

// Master Admin: xÃƒÂ³a nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ Ã¢â‚¬â€ nÃ¡ÂºÂ¿u Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ tÃ¡Â»Â« cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n thÃƒÂ¬ xÃƒÂ³a luÃƒÂ´n hÃ¡Â»â€œ sÃ†Â¡ + tiÃ¡ÂºÂ¿n trÃƒÂ¬nh + file trÃƒÂªn toÃƒÂ n hÃ¡Â»â€¡ thÃ¡Â»â€˜ng
app.delete('/api/admin/missions/:id', authMiddleware, masterAdminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT id, code, title, source_type, source_id FROM missions WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â tÃƒÂ i.' });
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
    return res.status(500).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a Ã„â€˜Ã¡Â»Â tÃƒÂ i (lÃ¡Â»â€”i cÃ†Â¡ sÃ¡Â»Å¸ dÃ¡Â»Â¯ liÃ¡Â»â€¡u). ' + msg });
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
    /* khÃƒÂ´ng chÃ¡ÂºÂ·n phÃ¡ÂºÂ£n hÃ¡Â»â€œi */
  }
  const tail = isCapVien ? ' (Ã„â€˜ÃƒÂ£ gÃ¡Â»Â¡ khÃ¡Â»Âi dashboard, theo dÃƒÂµi tiÃ¡ÂºÂ¿n trÃƒÂ¬nh vÃƒÂ  hÃ¡Â»â€œ sÃ†Â¡ cÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n)' : '';
  return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a Ã„â€˜Ã¡Â»Â tÃƒÂ i "' + (row.code || '') + '" khÃ¡Â»Âi hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.' + tail, deletedId: id });
});

// CSV helper: escape field for CSV (quote if contains comma, newline or quote)
function csvEscape(s) {
  if (s == null) return '';
  const str = String(s).trim();
  if (/[,"\n\r]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

// XuÃ¡ÂºÂ¥t dÃ¡Â»Â¯ liÃ¡Â»â€¡u nhiÃ¡Â»â€¡m vÃ¡Â»Â¥ (CSV / Excel / bÃƒÂ¡o cÃƒÂ¡o thÃ¡Â»â€˜ng kÃƒÂª) Ã¢â‚¬â€ xem routes/missions/export.js.
// PhÃ¡ÂºÂ£i mount TRÃ†Â¯Ã¡Â»Å¡C handler '/api/missions/:id' bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi, nÃ¡ÂºÂ¿u khÃƒÂ´ng 'export',
// 'export-excel', 'report-excel'Ã¢â‚¬Â¦ sÃ¡ÂºÂ½ bÃ¡Â»â€¹ bÃ¡ÂºÂ¯t nhÃ¡ÂºÂ§m thÃƒÂ nh :id.
app.use('/api', require('./routes/missions/export')({
  db,
  authMiddleware,
  adminOnly,
  csvEscape,
  syncMissionsFromCapVien,
  insertUserActivityLog,
}));

// Chi tiÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»Â tÃƒÂ i + hÃ¡Â»â€œ sÃ†Â¡ ngoÃƒÂ i ViÃ¡Â»â€¡n + file sÃ¡ÂºÂ£n phÃ¡ÂºÂ©m Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang
// routes/missions/chiTiet.js. Router nÃƒÂ y chÃ¡Â»Â©a '/missions/:id' nÃƒÂªn BÃ¡ÂºÂ®T BUÃ¡Â»ËœC mount
// SAU missionsCore, missionsChoXetDuyet vÃƒÂ  missionsExport Ã¡Â»Å¸ trÃƒÂªn Ã¢â‚¬â€ nÃ¡ÂºÂ¿u khÃƒÂ´ng,
// '/api/missions/export', '/stats', '/cho-ct-hd-*' sÃ¡ÂºÂ½ bÃ¡Â»â€¹ :id nuÃ¡Â»â€˜t thÃƒÂ nh 400.
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

// MÃ¡ÂºÂ«u hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã„Æ’ng kÃƒÂ½ Ã„â€˜Ã¡Â»Â tÃƒÂ i ngoÃƒÂ i ViÃ¡Â»â€¡n Ã¢â‚¬â€ Admin upload, User download
const TEMPLATE_TYPES = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong'];
const TEMPLATE_LABELS = { thuyet_minh_chi_tiet: 'MÃ¡ÂºÂ«u ThuyÃ¡ÂºÂ¿t minh chi tiÃ¡ÂºÂ¿t', van_ban_xin_phep_vien_truong: 'MÃ¡ÂºÂ«u VÃ„Æ’n bÃ¡ÂºÂ£n xin phÃƒÂ©p ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng' };

// MÃ¡ÂºÂ«u hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã„Æ’ng kÃƒÂ½ Ã„â€˜Ã¡Â»Â tÃƒÂ i ngoÃƒÂ i ViÃ¡Â»â€¡n Ã¢â‚¬â€ xem routes/missions/templates.js.
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

// MÃ¡ÂºÂ«u hÃ¡Â»â€œ sÃ†Â¡ SCI-ACE (HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng Ã„â€˜Ã¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â©c trÃƒÂªn Ã„â€˜Ã¡Â»â„¢ng vÃ¡ÂºÂ­t) Ã¢â‚¬â€ Admin/ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng upload, mÃ¡Â»Âi ngÃ†Â°Ã¡Â»Âi Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Ã„â€˜Ã†Â°Ã¡Â»Â£c download
const ACE_TEMPLATE_DEFS = [
  { type: 'nhom1_muc_luc', group: 1, label: 'MÃ¡Â»Â¥c lÃ¡Â»Â¥c HÃ¡Â»â€¡ thÃ¡Â»â€˜ng' },
  { type: 'nhom1_huong_dan_tong_hop', group: 1, label: 'HÃ†Â°Ã¡Â»â€ºng dÃ¡ÂºÂ«n TÃ¡Â»â€¢ng hÃ¡Â»Â£p' },
  { type: 'nhom1_huong_dan_thao_tac', group: 1, label: 'HÃ†Â°Ã¡Â»â€ºng dÃ¡ÂºÂ«n Thao tÃƒÂ¡c Ã„ÂÃ¡Â»â„¢ng vÃ¡ÂºÂ­t' },
  { type: 'nhom1_quy_che', group: 1, label: 'Quy chÃ¡ÂºÂ¿ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng' },
  { type: 'sci_ace_01', group: 2, label: 'SCI-ACE-01: Ã„ÂÃ†Â¡n Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ xÃƒÂ©t duyÃ¡Â»â€¡t' },
  { type: 'sci_ace_02', group: 2, label: 'SCI-ACE-02: PhiÃ¡ÂºÂ¿u thuyÃ¡ÂºÂ¿t minh Ã„â€˜Ã¡Â»Â tÃƒÂ i' },
  { type: 'sci_ace_03', group: 2, label: 'SCI-ACE-03: BÃƒÂ¡o cÃƒÂ¡o tuÃƒÂ¢n thÃ¡Â»Â§ nguyÃƒÂªn tÃ¡ÂºÂ¯c 3R' },
  { type: 'sci_ace_04', group: 2, label: 'SCI-ACE-04: BÃƒÂ¡o cÃƒÂ¡o giÃ¡ÂºÂ£i trÃƒÂ¬nh tiÃ¡ÂºÂ¿p thu' },
  { type: 'sci_ace_06', group: 2, label: 'SCI-ACE-06: BÃƒÂ¡o cÃƒÂ¡o thay Ã„â€˜Ã¡Â»â€¢i kÃ¡ÂºÂ¿ hoÃ¡ÂºÂ¡ch' },
  { type: 'sci_ace_07', group: 2, label: 'SCI-ACE-07: BÃƒÂ¡o cÃƒÂ¡o kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ tuÃƒÂ¢n thÃ¡Â»Â§' },
  { type: 'sci_ace_pdg', group: 3, label: 'SCI-ACE-PÃ„ÂG: PhiÃ¡ÂºÂ¿u nhÃ¡ÂºÂ­n xÃƒÂ©t thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng' },
  { type: 'sci_ace_05', group: 3, label: 'SCI-ACE-05: BiÃƒÂªn bÃ¡ÂºÂ£n hÃ¡Â»Âp HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng' },
  { type: 'sci_ace_qd_vn', group: 3, label: 'QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh phÃƒÂª duyÃ¡Â»â€¡t (TiÃ¡ÂºÂ¿ng ViÃ¡Â»â€¡t)' },
  { type: 'sci_ace_qd_en', group: 3, label: 'Decision (English)' },
];
const ACE_TEMPLATE_TYPES = ACE_TEMPLATE_DEFS.map((d) => d.type);
const ACE_TEMPLATE_BY_TYPE = {};
ACE_TEMPLATE_DEFS.forEach((d) => { ACE_TEMPLATE_BY_TYPE[d.type] = d; });

/** Admin hoÃ¡ÂºÂ·c ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng (KHCN/SCI-ACE dÃƒÂ¹ng chung role) mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t mÃ¡ÂºÂ«u hÃ¡Â»â€œ sÃ†Â¡ SCI-ACE. */
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
  if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'LoÃ¡ÂºÂ¡i mÃ¡ÂºÂ«u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const row = db.prepare('SELECT template_type, original_name, path FROM ace_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u nÃƒÂ y' });
  const templatesRoot = path.resolve(uploadDir, 'ace-templates');
  const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
  if (!pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath)) {
    return res.status(403).json({ message: 'Ã„ÂÃ†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n file mÃ¡ÂºÂ«u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i' });
  setContentDisposition(res, row.original_name || 'download');
  return res.sendFile(fullPath);
});

app.post(
  '/api/admin/ace-templates',
  authMiddleware,
  (req, res, next) => {
    if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t mÃ¡ÂºÂ«u.' });
    next();
  },
  upload.single('file'),
  (req, res) => {
    const type = (req.body.template_type || '').trim();
    if (!ACE_TEMPLATE_TYPES.includes(type)) {
      try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'template_type khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    }
    if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file Ã„â€˜Ã¡Â»Æ’ upload' });
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!['pdf', 'doc', 'docx'].includes(ext)) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n PDF, Word (.doc, .docx)' });
    }
    const destDir = path.join(uploadDir, 'ace-templates');
    fs.mkdirSync(destDir, { recursive: true });
    const finalName = type + '_' + Date.now() + '.' + ext;
    const destPath = path.join(destDir, finalName);
    fs.copyFileSync(req.file.path, destPath);
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    db.prepare("INSERT OR REPLACE INTO ace_templates (template_type, original_name, path, updated_at) VALUES (?, ?, ?, datetime('now'))").run(type, req.file.originalname || finalName, finalName);
    const row = db.prepare('SELECT template_type, original_name, updated_at FROM ace_templates WHERE template_type = ?').get(type);
    return res.status(201).json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t mÃ¡ÂºÂ«u ' + (ACE_TEMPLATE_BY_TYPE[type] ? ACE_TEMPLATE_BY_TYPE[type].label : type), template: row });
  }
);

app.delete('/api/admin/ace-templates/:type', authMiddleware, (req, res) => {
  if (!aceCanManageTemplates(req)) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin hoÃ¡ÂºÂ·c ThÃ†Â° kÃƒÂ½ HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ³a mÃ¡ÂºÂ«u.' });
  const type = (req.params.type || '').trim();
  if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'LoÃ¡ÂºÂ¡i mÃ¡ÂºÂ«u khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const row = db.prepare('SELECT path FROM ace_templates WHERE template_type = ?').get(type);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ file Ã„â€˜Ã¡Â»Æ’ xÃƒÂ³a' });
  try {
    const templatesRoot = path.resolve(uploadDir, 'ace-templates');
    const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
    if (pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath) && fs.existsSync(fullPath)) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
    }
    db.prepare('DELETE FROM ace_templates WHERE template_type = ?').run(type);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a mÃ¡ÂºÂ«u' });
  } catch (e) {
    console.error('[ace-templates delete]', e);
    return res.status(500).json({ message: 'LÃ¡Â»â€”i xÃƒÂ³a' });
  }
});

// Import CSV hoÃ¡ÂºÂ·c Excel (.xlsx): cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t/thÃƒÂªm Ã„â€˜Ã¡Â»Â tÃƒÂ i vÃƒÂ o missions (Admin)
app.post('/api/admin/missions/import', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
  if (!req.file || !req.file.path) {
    return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file CSV hoÃ¡ÂºÂ·c Excel (.xlsx) Ã„â€˜Ã¡Â»Æ’ import.' });
  }
  const isExcel = (req.file.originalname || '').toLowerCase().endsWith('.xlsx');
  let headerCells = [];
  let dataRows = [];

  if (isExcel) {
    try {
      const buf = fs.readFileSync(req.file.path);
      const workbook = XLSX.read(buf, { type: 'buffer', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(400).json({ message: 'File Excel khÃƒÂ´ng cÃƒÂ³ sheet nÃƒÂ o.' });
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      if (!rawRows.length) return res.status(400).json({ message: 'File Excel trÃ¡Â»â€˜ng.' });
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
      return res.status(400).json({ message: 'KhÃƒÂ´ng Ã„â€˜Ã¡Â»Âc Ã„â€˜Ã†Â°Ã¡Â»Â£c file Excel. BÃ¡ÂºÂ¡n cÃƒÂ³ thÃ¡Â»Æ’ lÃ†Â°u lÃ¡ÂºÂ¡i dÃ†Â°Ã¡Â»â€ºi dÃ¡ÂºÂ¡ng CSV (UTF-8) vÃƒÂ  thÃ¡Â»Â­ import CSV.' });
    }
  } else {
    let raw = '';
    if (fs.existsSync(req.file.path)) {
      raw = (fs.readFileSync(req.file.path, 'utf8') || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    }
    if (!raw || raw.trim().length === 0) {
      return res.status(400).json({ message: 'File trÃ¡Â»â€˜ng hoÃ¡ÂºÂ·c khÃƒÂ´ng Ã„â€˜Ã¡Â»Âc Ã„â€˜Ã†Â°Ã¡Â»Â£c.' });
    }
    let lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines[0] && lines[0].toLowerCase() === 'sep=,') lines = lines.slice(1);
    let delim = ',';
    if (lines[0] && /^sep=;/i.test(lines[0])) { lines = lines.slice(1); delim = ';'; }
    if (lines.length < 2) {
      return res.status(400).json({ message: 'File CSV cÃ¡ÂºÂ§n cÃƒÂ³ ÃƒÂ­t nhÃ¡ÂºÂ¥t dÃƒÂ²ng tiÃƒÂªu Ã„â€˜Ã¡Â»Â vÃƒÂ  mÃ¡Â»â„¢t dÃƒÂ²ng dÃ¡Â»Â¯ liÃ¡Â»â€¡u.' });
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
    if (code.length > 80 || code.indexOf('CÃ¡ÂºÂ¥p') >= 0 || code.indexOf('TrÃ¡ÂºÂ¡ng thÃƒÂ¡i') >= 0 || code.indexOf('GHI CHÃƒÅ¡') >= 0) continue;
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
    message: 'Import xong. Ã„ÂÃƒÂ£ thÃƒÂªm ' + inserted + ' Ã„â€˜Ã¡Â»Â tÃƒÂ i, cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t ' + updated + ' Ã„â€˜Ã¡Â»Â tÃƒÂ i. Dashboard sÃ¡ÂºÂ½ hiÃ¡Â»Æ’n thÃ¡Â»â€¹ sÃ¡Â»â€˜ liÃ¡Â»â€¡u mÃ¡Â»â€ºi.',
    inserted,
    updated
  });
});

// Admin: ThÃƒÂªm thÃ¡Â»Â§ cÃƒÂ´ng 1 Ã„â€˜Ã¡Â»Â tÃƒÂ i vÃƒÂ o bÃ¡ÂºÂ£ng missions (upsert theo code)
app.post('/api/admin/missions/manual', authMiddleware, adminOnly, (req, res) => {
  const body = req.body || {};
  const code = String(body.code || '').trim();
  const title = String(body.title || '').trim();
  const principal = String(body.principal || '').trim() || null;
  const level = String(body.level || '').trim().toLowerCase();
  const statusResolved = resolveMissionStatusInput(body.status != null && body.status !== '' ? body.status : 'planning');

  if (!code) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u mÃƒÂ£ Ã„â€˜Ã¡Â»Â tÃƒÂ i (code).' });
  if (!title) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u tÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i (title).' });
  if (!['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'].includes(level)) {
    return res.status(400).json({ message: 'CÃ¡ÂºÂ¥p Ã„â€˜Ã¡Â»Â tÃƒÂ i khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. HÃƒÂ£y chÃ¡Â»Ân: national | ministry | university | school | coe | first | institute.' });
  }
  if (!statusResolved) {
    return res.status(400).json({ message: 'TrÃ¡ÂºÂ¡ng thÃƒÂ¡i khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (quÃƒÂ¡ dÃƒÂ i hoÃ¡ÂºÂ·c kÃƒÂ½ tÃ¡Â»Â± khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂ©p).' });
  }

  const normalizeDate = (v) => {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return s.slice(0, 10);
    // chÃ¡ÂºÂ¥p nhÃ¡ÂºÂ­n DD/MM/YYYY hoÃ¡ÂºÂ·c MM/DD/YYYY Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡Â»Â¡ sai khi admin nhÃ¡ÂºÂ­p tay
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
      return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„â€˜Ã¡Â»Â tÃƒÂ i.', id: existing.id, updated: true });
    }

    db.prepare(
      `INSERT INTO missions
        (code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'manual')`
    ).run(code, title, principal, level, statusResolved, start_date, end_date, progress, budget);
    const id = db.prepare('SELECT id FROM missions WHERE code=? ORDER BY id DESC LIMIT 1').get(code).id;
    return res.status(201).json({ ok: true, message: 'Ã„ÂÃƒÂ£ thÃƒÂªm Ã„â€˜Ã¡Â»Â tÃƒÂ i thÃ¡Â»Â§ cÃƒÂ´ng.', id, updated: false });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i thÃƒÂªm thÃ¡Â»Â§ cÃƒÂ´ng: ' + (e.message || String(e)) });
  }
});

// Admin: cÃ¡ÂºÂ¥u hÃƒÂ¬nh bÃ¡ÂºÂ­t/tÃ¡ÂºÂ¯t module trÃƒÂªn trang chÃ¡Â»Â§
app.get('/api/admin/homepage-modules', authMiddleware, adminOnly, (req, res) => {
  // NÃ¡ÂºÂ¿u bÃ¡ÂºÂ£ng trÃ¡Â»â€˜ng thÃƒÂ¬ seed mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh
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

// PhÃ¡ÂºÂ£i khai bÃƒÂ¡o TRÃ†Â¯Ã¡Â»Å¡C /:code Ã¢â‚¬â€ nÃ¡ÂºÂ¿u khÃƒÂ´ng PUT .../reorder bÃ¡Â»â€¹ khÃ¡Â»â€ºp :code=reorder vÃƒÂ  chÃƒÂ¨n dÃƒÂ²ng sai vÃƒÂ o DB
app.put('/api/admin/homepage-modules/reorder', authMiddleware, adminOnly, (req, res) => {
  const order = req.body && Array.isArray(req.body.order) ? req.body.order.map(c => String(c || '').trim()).filter(Boolean) : [];
  const expected = HOMEPAGE_MODULES_DEFAULT.map(m => m.code);
  if (order.length !== expected.length) {
    return res.status(400).json({ message: 'Danh sÃƒÂ¡ch thÃ¡Â»Â© tÃ¡Â»Â± phÃ¡ÂºÂ£i Ã„â€˜Ã¡Â»Â§ ' + expected.length + ' module.' });
  }
  const set = new Set(order);
  if (!expected.every(c => set.has(c))) {
    return res.status(400).json({ message: 'ThÃ¡Â»Â© tÃ¡Â»Â± module khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (thiÃ¡ÂºÂ¿u hoÃ¡ÂºÂ·c trÃƒÂ¹ng mÃƒÂ£).' });
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u thÃ¡Â»Â© tÃ¡Â»Â± hiÃ¡Â»Æ’n thÃ¡Â»â€¹ module trÃƒÂªn Trang chÃ¡Â»Â§.' });
});

app.put('/api/admin/homepage-modules/:code', authMiddleware, adminOnly, (req, res) => {
  const code = (req.params.code || '').trim();
  if (!code) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u mÃƒÂ£ module' });
  if (!HOMEPAGE_MODULES_DEFAULT.some(m => m.code === code)) {
    return res.status(400).json({ message: 'MÃƒÂ£ module khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
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
  return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t cÃ¡ÂºÂ¥u hÃƒÂ¬nh module.', module: row });
});

// Public: cÃ¡ÂºÂ¥u hÃƒÂ¬nh module cho trang chÃ¡Â»Â§ (khÃƒÂ´ng cÃ¡ÂºÂ§n Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p)
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
    } catch (e) { /* giÃ¡Â»Â¯ rows tÃ¡Â»Â« DB */ }
  }
  return res.json({ modules: rows });
});

// TiÃƒÂªu chuÃ¡ÂºÂ©n hÃ¡Â»â€¡ thÃ¡Â»â€˜ng (ISO9001...) Ã¢â‚¬â€ hiÃ¡Â»Æ’n thÃ¡Â»â€¹ trÃƒÂªn header trang chÃ¡Â»Â§; Admin cÃƒÂ³ thÃ¡Â»Æ’ sÃ¡Â»Â­a/xÃƒÂ³a
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
  return res.json({ message: label ? 'Ã„ÂÃƒÂ£ lÃ†Â°u tiÃƒÂªu chuÃ¡ÂºÂ©n hiÃ¡Â»Æ’n thÃ¡Â»â€¹.' : 'Ã„ÂÃƒÂ£ xÃƒÂ³a dÃƒÂ²ng tiÃƒÂªu chuÃ¡ÂºÂ©n (sÃ¡ÂºÂ½ khÃƒÂ´ng hiÃ¡Â»Æ’n thÃ¡Â»â€¹ trÃƒÂªn Trang chÃ¡Â»Â§).', label: label });
});

app.post('/api/admin/notification-recipients', authMiddleware, adminOnly, (req, res) => {
  const { email, fullname } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p email' });
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  try {
    db.prepare('INSERT INTO notification_recipients (email, fullname) VALUES (?, ?)').run(em, (fullname || '').trim() || null);
    const row = db.prepare('SELECT id, email, fullname, createdAt FROM notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email nÃƒÂ y Ã„â€˜ÃƒÂ£ cÃƒÂ³ trong danh sÃƒÂ¡ch.' });
    return res.status(500).json({ message: 'LÃ¡Â»â€”i thÃƒÂªm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  try {
    const r = db.prepare('DELETE FROM notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y bÃ¡ÂºÂ£n ghi.' });
    return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a khÃ¡Â»Âi danh sÃƒÂ¡ch nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o.' });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i xÃƒÂ³a: ' + (e.message || '') });
  }
});

// ========== Module HÃ¡Â»Â£p tÃƒÂ¡c quÃ¡Â»â€˜c tÃ¡ÂºÂ¿: danh sÃƒÂ¡ch email nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o (Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜oÃƒÂ n ra, Ã„â€˜oÃƒÂ n vÃƒÂ o, ...) Ã¢â‚¬â€ chÃ¡Â»â€° Admin ==========
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
  if (!em) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p email.' });
  if (!isSafeEmailFormat(em)) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const topicsVal = (topics === 'all' || (typeof topics === 'string' && topics.trim() === 'all')) ? 'all' : (Array.isArray(topics) ? topics.filter(Boolean).join(',') : (typeof topics === 'string' ? topics.trim() : 'all'));
  const roleVal = (role === 'vien_truong' || (typeof role === 'string' && role.trim().toLowerCase() === 'vien_truong')) ? 'vien_truong' : null;
  try {
    db.prepare('INSERT INTO cooperation_notification_recipients (email, fullname, topics, role) VALUES (?, ?, ?, ?)').run(em, (fullname || '').trim() || null, topicsVal || 'all', roleVal);
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE email = ?').get(em);
    return res.status(201).json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o.', recipient: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Email nÃƒÂ y Ã„â€˜ÃƒÂ£ cÃƒÂ³ trong danh sÃƒÂ¡ch.' });
    return res.status(500).json({ message: 'LÃ¡Â»â€”i thÃƒÂªm: ' + (e.message || '') });
  }
});

app.delete('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  try {
    const r = db.prepare('DELETE FROM cooperation_notification_recipients WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y bÃ¡ÂºÂ£n ghi.' });
    return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a khÃ¡Â»Âi danh sÃƒÂ¡ch nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o.' });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i xÃƒÂ³a: ' + (e.message || '') });
  }
});

app.patch('/api/admin/cooperation/notification-recipients/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { role, fullname, topics } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row0 = db.prepare('SELECT id FROM cooperation_notification_recipients WHERE id = ?').get(id);
  if (!row0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y bÃ¡ÂºÂ£n ghi.' });
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ trÃ†Â°Ã¡Â»Âng nÃƒÂ o Ã„â€˜Ã¡Â»Æ’ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t (role, fullname, topics).' });
  vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_notification_recipients SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    const row = db.prepare('SELECT id, email, fullname, topics, role, createdAt FROM cooperation_notification_recipients WHERE id = ?').get(id);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.', recipient: row });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// CÃ¡ÂºÂ£nh bÃƒÂ¡o thÃ¡Â»Âa thuÃ¡ÂºÂ­n Ã„â€˜ÃƒÂ£ kÃƒÂ½ Ã¢â‚¬â€ trÃ†Â°Ã¡Â»â€ºc/sau hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n (topic thoa_thuan_het_han)
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
      return res.status(400).json({ message: 'months phÃ¡ÂºÂ£i lÃƒÂ  sÃ¡Â»â€˜ tÃ¡Â»Â« 1 Ã„â€˜Ã¡ÂºÂ¿n 36.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_expiry_alert_months', String(m));
    updates.push('months');
  }
  if (body.post_expiry_max_emails != null) {
    const n = parseInt(body.post_expiry_max_emails, 10);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      return res.status(400).json({ message: 'post_expiry_max_emails phÃ¡ÂºÂ£i tÃ¡Â»Â« 0 (khÃƒÂ´ng gÃ¡Â»Â­i) Ã„â€˜Ã¡ÂºÂ¿n 20.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_max_emails', String(n));
    updates.push('post_expiry_max_emails');
  }
  if (body.post_expiry_min_days != null) {
    const d = parseInt(body.post_expiry_min_days, 10);
    if (!Number.isFinite(d) || d < 1 || d > 90) {
      return res.status(400).json({ message: 'post_expiry_min_days phÃ¡ÂºÂ£i tÃ¡Â»Â« 1 Ã„â€˜Ã¡ÂºÂ¿n 90.' });
    }
    db.prepare('INSERT OR REPLACE INTO cooperation_settings (key, value) VALUES (?, ?)').run('thoa_thuan_post_expiry_min_days', String(d));
    updates.push('post_expiry_min_days');
  }
  if (!updates.length) {
    return res.status(400).json({ message: 'GÃ¡Â»Â­i ÃƒÂ­t nhÃ¡ÂºÂ¥t mÃ¡Â»â„¢t trÃ†Â°Ã¡Â»Âng: months, post_expiry_max_emails, post_expiry_min_days.' });
  }
  try {
    return res.json({
      ok: true,
      message: 'Ã„ÂÃƒÂ£ lÃ†Â°u cÃ¡ÂºÂ¥u hÃƒÂ¬nh cÃ¡ÂºÂ£nh bÃƒÂ¡o thÃ¡Â»Âa thuÃ¡ÂºÂ­n.',
      months: coopGetThoaThuanExpiryMonths(),
      post_expiry_max_emails: coopGetThoaThuanPostExpiryMaxEmails(),
      post_expiry_min_days: coopGetThoaThuanPostExpiryMinDays()
    });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i lÃ†Â°u cÃ¡ÂºÂ¥u hÃƒÂ¬nh.' });
  }
});

app.post('/api/admin/cooperation/thoa-thuan/run-expiry-check', authMiddleware, adminOnly, (req, res) => {
  coopRunThoaThuanExpiryAlerts()
    .then((r) => res.json({ ok: true, ...r }))
    .catch((e) => res.status(500).json({ message: 'Ã„ÂÃƒÂ£ xÃ¡ÂºÂ£y ra lÃ¡Â»â€”i. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' }));
});

// GÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n (MOU): lÃ†Â°u vÃƒÂ o DB + gÃ¡Â»Â­i email tÃ¡Â»â€ºi danh sÃƒÂ¡ch nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o (topic mou hoÃ¡ÂºÂ·c all)
app.post('/api/cooperation/mou/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'NgÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const loaiThoaThuan = (body.loai_thoa_thuan || body.loaiThoaThuan || '').trim() || 'Ã¢â‚¬â€';
  const tenDoiTac = (body.ten_doi_tac || body.tenDoiTac || '').trim() || 'Ã¢â‚¬â€';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || 'Ã¢â‚¬â€';
  const thoiHanNam = (body.thoi_han_nam != null && body.thoi_han_nam !== '') ? String(body.thoi_han_nam) : 'Ã¢â‚¬â€';
  const giaTriTaiChinh = (body.gia_tri_tai_chinh || body.giaTriTaiChinh || '').trim() || 'Ã¢â‚¬â€';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || 'Ã¢â‚¬â€';
  const noiDungHopTac = (body.noi_dung_hop_tac || body.noiDungHopTac || '').trim() || 'Ã¢â‚¬â€';
  const { to: toList, cc: ccList } = getCooperationRecipientsSplit('mou');
  const allRecipients = [...toList, ...ccList];
  if (allRecipients.length === 0) {
    return res.status(400).json({
      message: 'ChÃ†Â°a cÃƒÂ³ email nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n. Admin vui lÃƒÂ²ng thÃƒÂªm trong QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â€ â€™ Danh sÃƒÂ¡ch email (chÃ¡Â»Ân topic MOU).',
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
    return res.status(500).json({ message: 'LÃ¡Â»â€”i lÃ†Â°u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t: ' + (e.message || ''), sent: 0 });
  }
  try {
    if (newRowId) coopAddHistory('mou', newRowId, 1, 'gui', 'NÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n', user, null);
  } catch (e) {}
  const maDeXuatMou = newRowId ? coopGenMa('mou', newRowId) : '';
  try {
    if (newRowId && maDeXuatMou) db.prepare('UPDATE cooperation_mou_de_xuat SET ma_de_xuat=? WHERE id=?').run(maDeXuatMou, newRowId);
  } catch (e) {}
  const subject = '[HÃ¡Â»Â£p tÃƒÂ¡c QT] Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n mÃ¡Â»â€ºi: ' + tenDoiTac + ' Ã¢â‚¬â€ ' + submittedBy;
  const textBody = 'KÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng,\n\nPhÃƒÂ²ng KHCN&QHÃ„ÂN trÃƒÂ¢n trÃ¡Â»Âng bÃƒÂ¡o cÃƒÂ¡o: ' + submittedBy + ' (' + submittedByEmail + ') Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n hÃ¡Â»Â£p tÃƒÂ¡c quÃ¡Â»â€˜c tÃ¡ÂºÂ¿ mÃ¡Â»â€ºi lÃƒÂªn PhÃƒÂ²ng Ã„â€˜Ã¡Â»Æ’ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.\n\nThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t:\n- MÃƒÂ£: ' + maDeXuatMou + '\n- LoÃ¡ÂºÂ¡i thÃ¡Â»Âa thuÃ¡ÂºÂ­n: ' + loaiThoaThuan + '\n- Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c: ' + tenDoiTac + '\n- QuÃ¡Â»â€˜c gia: ' + quocGia + '\n- ThÃ¡Â»Âi hÃ¡ÂºÂ¡n (nÃ„Æ’m): ' + thoiHanNam + '\n- GiÃƒÂ¡ trÃ¡Â»â€¹ tÃƒÂ i chÃƒÂ­nh: ' + giaTriTaiChinh + '\n- Ã„ÂÃ†Â¡n vÃ¡Â»â€¹ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t: ' + donViDeXuat + '\n- NÃ¡Â»â„¢i dung hÃ¡Â»Â£p tÃƒÂ¡c: ' + noiDungHopTac + '\n\nKÃƒÂ­nh mong ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t vÃƒÂ  chÃ¡Â»â€° Ã„â€˜Ã¡ÂºÂ¡o. PhÃƒÂ²ng KHCN&QHÃ„ÂN sÃ¡ÂºÂ½ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  bÃƒÂ¡o cÃƒÂ¡o chi tiÃ¡ÂºÂ¿t khi cÃƒÂ³ kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£.\n\nTrÃƒÂ¢n trÃ¡Â»Âng.';
  const htmlBody = '<p style="margin-bottom:16px;"><strong>KÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng,</strong></p><p>PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN trÃƒÂ¢n trÃ¡Â»Âng bÃƒÂ¡o cÃƒÂ¡o: <strong>' + submittedBy + '</strong> (' + submittedByEmail + ') Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n hÃ¡Â»Â£p tÃƒÂ¡c quÃ¡Â»â€˜c tÃ¡ÂºÂ¿ mÃ¡Â»â€ºi lÃƒÂªn PhÃƒÂ²ng Ã„â€˜Ã¡Â»Æ’ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.</p><p><strong>ThÃƒÂ´ng tin Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t:</strong></p><table border="1" cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;"><tr style="background:#f8fafc;"><td style="font-weight:600;width:40%;">MÃƒÂ£ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t</td><td>' + maDeXuatMou + '</td></tr><tr><td style="font-weight:600;">LoÃ¡ÂºÂ¡i thÃ¡Â»Âa thuÃ¡ÂºÂ­n</td><td>' + loaiThoaThuan + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c</td><td>' + tenDoiTac + '</td></tr><tr><td style="font-weight:600;">QuÃ¡Â»â€˜c gia</td><td>' + quocGia + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">ThÃ¡Â»Âi hÃ¡ÂºÂ¡n (nÃ„Æ’m)</td><td>' + thoiHanNam + '</td></tr><tr><td style="font-weight:600;">GiÃƒÂ¡ trÃ¡Â»â€¹ tÃƒÂ i chÃƒÂ­nh</td><td>' + giaTriTaiChinh + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Ã„ÂÃ†Â¡n vÃ¡Â»â€¹ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t</td><td>' + donViDeXuat + '</td></tr><tr><td style="font-weight:600;">NÃ¡Â»â„¢i dung hÃ¡Â»Â£p tÃƒÂ¡c</td><td>' + noiDungHopTac.replace(/\n/g, '<br>') + '</td></tr></table><p style="margin-top:16px;">KÃƒÂ­nh mong ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t vÃƒÂ  chÃ¡Â»â€° Ã„â€˜Ã¡ÂºÂ¡o. PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN sÃ¡ÂºÂ½ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  bÃƒÂ¡o cÃƒÂ¡o chi tiÃ¡ÂºÂ¿t khi cÃƒÂ³ kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£.</p><p>TrÃƒÂ¢n trÃ¡Â»Âng.</p>';
  if (!transporter) {
    return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t. HÃ¡Â»â€¡ thÃ¡Â»â€˜ng chÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh SMTP nÃƒÂªn chÃ†Â°a gÃ¡Â»Â­i Ã„â€˜Ã†Â°Ã¡Â»Â£c email thÃƒÂ´ng bÃƒÂ¡o.', sent: 0, ma_de_xuat: maDeXuatMou, id: newRowId || null });
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
    res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n tÃ¡Â»â€ºi PhÃƒÂ²ng KHCN&QHÃ„ÂN. Email Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i tÃ¡Â»â€ºi ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (KÃƒÂ­nh gÃ¡Â»Â­i) vÃƒÂ  CC ' + allRecipients.length + ' Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€°.', sent: allRecipients.length, ma_de_xuat: maDeXuatMou, id: newRowId || null });
  }).catch(err => {
    console.error('[Email] GÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t MOU lÃ¡Â»â€”i:', err.message);
    res.status(500).json({ message: 'GÃ¡Â»Â­i email thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'LÃ¡Â»â€”i hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.'), sent: 0 });
  });
});

// Helper: Admin hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (email trong cooperation_notification_recipients vÃ¡Â»â€ºi role=vien_truong)
function vienTruongOrAdmin(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
}

// Helper: Admin, P.KHCN (users.role) hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã¢â‚¬â€ dÃƒÂ¹ng cho mÃ¡Â»Â¥c QUÃ¡ÂºÂ¢N LÃƒÂ
function canSeeQuanLySection(req, res, next) {
  const role = (req.user.role || '').toLowerCase();
  if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) return next();
  const email = (req.user.email || '').trim().toLowerCase();
  if (!email) return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin, PhÃƒÂ²ng KHCN hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
  try {
    const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
    if (r) return next();
  } catch (e) {}
  return res.status(403).json({ message: 'ChÃ¡Â»â€° Admin, PhÃƒÂ²ng KHCN hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y' });
}

// Chi tiÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (MOU hoÃ¡ÂºÂ·c Ã„ÂoÃƒÂ n ra) Ã¢â‚¬â€ user phÃ¡ÂºÂ£i lÃƒÂ  ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i hoÃ¡ÂºÂ·c admin/vien_truong
app.get('/api/cooperation/de-xuat-chi-tiet/:source/:id', authMiddleware, (req, res) => {
  const source = (req.params.source || '').toLowerCase();
  const id = parseInt(req.params.id, 10);
  if (!id || !['mou', 'doan_ra', 'doan_vao'].includes(source)) {
    return res.status(400).json({ message: 'NguÃ¡Â»â€œn hoÃ¡ÂºÂ·c ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  }
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const year = new Date().getFullYear();
  try {
    if (source === 'mou') {
      const r = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân xem Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nÃƒÂ y' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'yeu_cau_bo_sung' ? 2 : 1);
      return res.json({
        source: 'mou',
        id: r.id,
        ma_de_xuat: r.ma_de_xuat || coopGenMa('mou', r.id),
        title: 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t MOU Ã¢â‚¬â€ ' + (r.ten_doi_tac || 'Ã¢â‚¬â€') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
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
        nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN'
      });
    }
    if (source === 'doan_ra') {
      const r = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân xem Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nÃƒÂ y' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'dang_chuan_bi' ? 2 : 1);
      return res.json({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'Ã„ÂX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ' + (r.muc_dich || r.quoc_gia || 'Ã¢â‚¬â€'),
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
        nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN'
      });
    }
    if (source === 'doan_vao') {
      const r = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
      if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
      const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
      if (submitterEmail !== userEmail && req.user.role !== 'admin') {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        const pk = roleIsAny(req, ['phong_khcn']);
        if (!vt && !pk) return res.status(403).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân xem Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nÃƒÂ y' });
      }
      const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : 1);
      return res.json({
        source: 'doan_vao',
        id: r.id,
        ma_de_xuat: 'Ã„ÂX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ' + (r.muc_dich || 'Ã¢â‚¬â€') + ' Ã¢â‚¬â€ ' + (r.don_vi_de_xuat || 'Ã¢â‚¬â€'),
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
        nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN'
      });
    }
  } catch (e) {
    console.error('[API] de-xuat-chi-tiet error:', e.message);
    return res.status(500).json({ message: 'LÃ¡Â»â€”i hÃ¡Â»â€¡ thÃ¡Â»â€˜ng' });
  }
  return res.status(400).json({ message: 'NguÃ¡Â»â€œn khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
});

// KiÃ¡Â»Æ’m tra user cÃƒÂ³ quyÃ¡Â»Ân phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (Admin hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng)
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

// SÃ¡Â»â€˜ lÃ†Â°Ã¡Â»Â£ng Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t chÃ¡Â»Â P.KHCN vs ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng + quyÃ¡Â»Ân xem mÃ¡Â»Â¥c QUÃ¡ÂºÂ¢N LÃƒÂ (Admin, P.KHCN, ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng)
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

// CÃƒÂ¡c Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t chÃ¡Â»Â P.KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh (MOU dang_tham_dinh + Ã„ÂoÃƒÂ n vÃƒÂ o cho_tham_dinh) Ã¢â‚¬â€ Admin, P.KHCN, ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng
app.get('/api/cooperation/de-xuat-cho-phong-khcn', authMiddleware, canSeeQuanLySection, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'Ã„ÂX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t MOU Ã¢â‚¬â€ ' + (r.ten_doi_tac || 'Ã¢â‚¬â€') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
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
        ma_de_xuat: 'Ã„ÂX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ' + (r.muc_dich || 'Ã¢â‚¬â€') + ' Ã¢â‚¬â€ ' + (r.don_vi_de_xuat || 'Ã¢â‚¬â€'),
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

// CÃƒÂ¡c Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t (Ã„ÂoÃƒÂ n ra cho_vt_duyet + HTQT cho_vt_phe_duyet) Ã¢â‚¬â€ Admin, ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng
app.get('/api/cooperation/de-xuat-cho-vien-truong', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\' ORDER BY created_at ASC').all();
    for (const r of doans || []) {
      list.push({
        source: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'Ã„ÂX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ' + (r.muc_dich || r.quoc_gia || 'Ã¢â‚¬â€'),
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
        ma_de_xuat: 'Ã„ÂX-' + year + '-V' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ' + (r.muc_dich || 'Ã¢â‚¬â€') + ' Ã¢â‚¬â€ ' + (r.don_vi_de_xuat || 'Ã¢â‚¬â€'),
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

// CÃƒÂ¡c Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t chÃ¡Â»Â duyÃ¡Â»â€¡t Ã¢â‚¬â€ chÃ¡Â»â€° Admin vÃƒÂ  ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (tÃ¡Â»â€¢ng hÃ¡Â»Â£p, giÃ¡Â»Â¯ tÃ†Â°Ã†Â¡ng thÃƒÂ­ch)
app.get('/api/cooperation/de-xuat-cho-duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const year = new Date().getFullYear();
  const list = [];
  try {
    const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
    for (const r of mous || []) {
      list.push({
        source: 'mou',
        id: r.id,
        ma_de_xuat: 'Ã„ÂX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t MOU Ã¢â‚¬â€ ' + (r.ten_doi_tac || 'Ã¢â‚¬â€') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
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
        ma_de_xuat: 'Ã„ÂX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ' + (r.muc_dich || r.quoc_gia || 'Ã¢â‚¬â€'),
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

// ThÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ P.KHCN / Admin (action Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ vÃ¡Â»â€ºi module-hoatac-quocte: duyet_len_vt | yeu_cau_bo_sung | tu_choi)
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
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet', 'cho_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° xÃ¡Â»Â­ lÃƒÂ½ Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN. NÃ¡ÂºÂ¿u Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung, ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ§n nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ trÃ†Â°Ã¡Â»â€ºc.' });
    }
    const newStatus = action === 'duyet_len_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'duyet_len_vt' ? 'PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€ TrÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng' : action === 'tu_choi' ? 'PhÃƒÂ²ng KHCN tÃ¡Â»Â« chÃ¡Â»â€˜i' : 'PhÃƒÂ²ng KHCN yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
    db.prepare("UPDATE cooperation_doan_vao SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, req.user.id || null, id);
    coopAddHistory('doan_vao', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_vao', row, id, 'phong', note).catch(err => console.error('[Email tu_choi doan_vao]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${row.ma_de_xuat || coopGenMa('doan_vao', id)}] CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ${label}`,
          html: coopBuildEmail('CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o', 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN xÃ¡Â»Â­ lÃƒÂ½.',
            [['MÃƒÂ£', row.ma_de_xuat || coopGenMa('doan_vao', id)], ['TrÃ¡ÂºÂ¡ng thÃƒÂ¡i mÃ¡Â»â€ºi', STATUS_LABELS_COOP[newStatus] || newStatus], ['ÃƒÂ kiÃ¡ÂºÂ¿n PhÃƒÂ²ng KHCN', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
          text: `${row.ma_de_xuat} Ã¢â‚¬â€ ${label}. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}` });
      }
    }
    if (action === 'duyet_len_vt') {
      const recip = coopGetRecipients('doan_vao');
      coopSendMail({ to: recip.to, cc: recip.cc,
        subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] TrÃƒÂ¬nh duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ${row.ma_de_xuat || coopGenMa('doan_vao', id)}`,
        html: coopBuildEmail('Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o cÃ¡ÂºÂ§n ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t', 'PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN Ã„â€˜ÃƒÂ£ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng:',
          [['MÃƒÂ£', row.ma_de_xuat || coopGenMa('doan_vao', id)], ['NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i', row.submitted_by_name || row.submitted_by_email], ['MÃ¡Â»Â¥c Ã„â€˜ÃƒÂ­ch', row.muc_dich || 'Ã¢â‚¬â€'], ['Ã„ÂÃ†Â¡n vÃ¡Â»â€¹', row.don_vi_de_xuat || 'Ã¢â‚¬â€'], ['ÃƒÂ kiÃ¡ÂºÂ¿n PhÃƒÂ²ng', note || 'Ã¢â‚¬â€']],
          'TrÃƒÂ¢n trÃ¡Â»Âng,<br/>PhÃƒÂ²ng KHCN&QHÃ„ÂN', (process.env.BASE_URL || 'http://localhost:' + PORT) + '/module-hoatac-quocte.html'),
        text: `TrÃƒÂ¬nh duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n vÃƒÂ o ${row.ma_de_xuat}.` });
    }
    return res.json({ ok: true, message: label, status: newStatus });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// PhÃƒÂª duyÃ¡Â»â€¡t/TÃ¡Â»Â« chÃ¡Â»â€˜i Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin Ã¢â‚¬â€ cho Ã„ÂoÃƒÂ n vÃƒÂ o cho_ky_duyet
app.put('/api/cooperation/doan-vao/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoÃ¡ÂºÂ·c action khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if ((row.status || '').toLowerCase() !== 'cho_ky_duyet') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.' });
    }
    const r = db.prepare('UPDATE cooperation_doan_vao SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateDoanVaoVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_vao] Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t (legacy) nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx) mÃ¡Â»â„¢t lÃ¡ÂºÂ§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_vao] Auto Word sau duyet legacy:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('doan_vao', id, 3, 'tu_choi', 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('doan_vao', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi doan_vao]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o.' : 'Ã„ÂÃƒÂ£ tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o.', status });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// ThÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh MOU Ã¢â‚¬â€ P.KHCN / Admin (Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ vÃ¡Â»â€ºi giao diÃ¡Â»â€¡n: duyet_len_vt Ã¢â€ â€™ chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng, khÃƒÂ´ng phÃ¡ÂºÂ£i da_duyet)
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
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet', 'dang_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° xÃ¡Â»Â­ lÃƒÂ½ Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN. NÃ¡ÂºÂ¿u Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung, ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ§n nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ trÃ†Â°Ã¡Â»â€ºc.' });
    }
    const newStatus = action === 'duyet_len_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'duyet_len_vt' ? 'PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€ TrÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng' : action === 'tu_choi' ? 'PhÃƒÂ²ng KHCN tÃ¡Â»Â« chÃ¡Â»â€˜i' : 'PhÃƒÂ²ng KHCN yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
    db.prepare("UPDATE cooperation_mou_de_xuat SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, req.user.id || null, id);
    coopAddHistory('mou', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('mou', row, id, 'phong', note).catch(err => console.error('[Email tu_choi mou]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${row.ma_de_xuat || coopGenMa('mou', id)}] CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t MOU Ã¢â‚¬â€ ${label}`,
          html: coopBuildEmail('CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t MOU', 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN xÃ¡Â»Â­ lÃƒÂ½.',
            [['MÃƒÂ£', row.ma_de_xuat || coopGenMa('mou', id)], ['TrÃ¡ÂºÂ¡ng thÃƒÂ¡i mÃ¡Â»â€ºi', STATUS_LABELS_COOP[newStatus] || newStatus], ['ÃƒÂ kiÃ¡ÂºÂ¿n PhÃƒÂ²ng KHCN', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
          text: `${row.ma_de_xuat} Ã¢â‚¬â€ ${label}. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}` });
      }
    }
    if (action === 'duyet_len_vt') {
      const recip = coopGetRecipients('mou');
      coopSendMail({ to: recip.to, cc: recip.cc,
        subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] TrÃƒÂ¬nh duyÃ¡Â»â€¡t MOU Ã¢â‚¬â€ ${row.ma_de_xuat || coopGenMa('mou', id)}`,
        html: coopBuildEmail('Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t MOU cÃ¡ÂºÂ§n ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t', 'PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN Ã„â€˜ÃƒÂ£ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng:',
          [['MÃƒÂ£', row.ma_de_xuat || coopGenMa('mou', id)], ['NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i', row.submitted_by_name || row.submitted_by_email], ['Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c', row.ten_doi_tac || 'Ã¢â‚¬â€'], ['ÃƒÂ kiÃ¡ÂºÂ¿n PhÃƒÂ²ng', note || 'Ã¢â‚¬â€']],
          'TrÃƒÂ¢n trÃ¡Â»Âng,<br/>PhÃƒÂ²ng KHCN&QHÃ„ÂN', (process.env.BASE_URL || 'http://localhost:' + PORT) + '/module-hoatac-quocte.html'),
        text: `TrÃƒÂ¬nh duyÃ¡Â»â€¡t MOU ${row.ma_de_xuat}.` });
    }
    return res.json({ ok: true, message: label, status: newStatus });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// PhÃƒÂª duyÃ¡Â»â€¡t/TÃ¡Â»Â« chÃ¡Â»â€˜i MOU Ã¢â‚¬â€ Admin hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng
app.put('/api/cooperation/mou/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoÃ¡ÂºÂ·c action khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    const r = db.prepare('UPDATE cooperation_mou_de_xuat SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateMouVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[mou] legacy duyet: chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx) mÃ¡Â»â„¢t lÃ¡ÂºÂ§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[mou] Auto Word legacy duyet:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('mou', id, 3, 'tu_choi', 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('mou', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi mou]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t MOU.' : 'Ã„ÂÃƒÂ£ tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t MOU.', status });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// PhÃƒÂª duyÃ¡Â»â€¡t/TÃ¡Â»Â« chÃ¡Â»â€˜i Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ Admin hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng
app.put('/api/cooperation/doan-ra/:id/duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = (req.body && req.body.action) ? String(req.body.action).trim().toLowerCase() : '';
  const note = (req.body && req.body.note != null) ? String(req.body.note) : '';
  if (!id || !['duyet', 'tu_choi'].includes(action)) {
    return res.status(400).json({ message: 'ID hoÃ¡ÂºÂ·c action khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. Action: duyet | tu_choi' });
  }
  const status = action === 'duyet' ? 'da_duyet' : 'tu_choi';
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\'), coop_reminder_last_at = NULL WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (action === 'duyet') {
      const gen = coopTryAutoGenerateDoanRaVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_ra] Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t (legacy) nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx) mÃ¡Â»â„¢t lÃ¡ÂºÂ§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_ra] Auto Word sau duyet legacy:', gen.message);
      }
    }
    if (action === 'tu_choi') {
      coopAddHistory('doan_ra', id, 3, 'tu_choi', 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t', req.user, note || null);
      if (row.submitted_by_email) {
        coopSendMailTuChoi('doan_ra', row, id, 'vt', note).catch(err => console.error('[Email legacy duyet tu_choi doan_ra]', err.message));
      }
    }
    return res.json({ message: action === 'duyet' ? 'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra.' : 'Ã„ÂÃƒÂ£ tÃ¡Â»Â« chÃ¡Â»â€˜i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra.', status });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// ========== HTQT Ã„ÂÃ¡Â»â‚¬ XUÃ¡ÂºÂ¤T YTNN (ChÃ†Â°Ã†Â¡ng VII Quy chÃ¡ÂºÂ¿ KHCN-Ã„ÂMST SCI 2026) ==========
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
  if (l === 'hoat_dong_khcn') return 'PhÃƒÂª duyÃ¡Â»â€¡t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n vÃƒÂ  giao PhÃƒÂ²ng KHCN cÃ¡ÂºÂ¥p mÃƒÂ£ dÃ¡Â»Â± ÃƒÂ¡n (Ã„ÂiÃ¡Â»Âu 62, 64)';
  if (l === 'tai_tro_vien_tro') return 'XÃƒÂ¡c nhÃ¡ÂºÂ­n Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¬nh TrÃ†Â°Ã¡Â»Âng Ã„ÂHKHTN phÃƒÂª duyÃ¡Â»â€¡t (Ã„ÂiÃ¡Â»Âu 64)';
  if (l === 'dich_vu_khcn') return 'PhÃƒÂª duyÃ¡Â»â€¡t triÃ¡Â»Æ’n khai theo quy trÃƒÂ¬nh dÃ¡Â»â€¹ch vÃ¡Â»Â¥ (Ã„ÂiÃ¡Â»Âu 64)';
  return 'PhÃƒÂª duyÃ¡Â»â€¡t theo quy Ã„â€˜Ã¡Â»â€¹nh';
}

// GET Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t YTNN chi tiÃ¡ÂºÂ¿t Ã¢â‚¬â€ vien_truong, admin, phong_khcn, chu_nhiem
app.get('/api/htqt/de-xuat/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    if (!canAccessHtqtDeXuat(req, row)) return res.status(403).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân xem Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nÃƒÂ y' });
    const files = db.prepare('SELECT id, loai_file, ten_file, duong_dan, uploaded_by_id, uploaded_at FROM htqt_de_xuat_files WHERE de_xuat_id = ? ORDER BY id').all(id);
    const history = db.prepare('SELECT id, action, performed_by_name, performed_at, note FROM htqt_de_xuat_history WHERE de_xuat_id = ? ORDER BY performed_at DESC').all(id);
    const phi = phiQuanLyTheoLoaiHinh(row.loai_hinh, row.kinh_phi_vnd);
    const coNgÃ†Â°Ã¡Â»Â¡ngKinhPhi = (row.kinh_phi_vnd || 0) > 500000000;
    const coNgÃ†Â°Ã¡Â»Â¡ngThoiGian = (row.thoi_gian_thang || 0) > 60;
    const filesBatBuoc = ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'];
    const filesCo = (files || []).map(f => (f.loai_file || '').toLowerCase());
    const thieuFile = filesBatBuoc.filter(loai => !filesCo.includes(loai));
    const coThieuHoSo = thieuFile.length > 0;
    const chuaPhanLoai = !row.loai_hinh || !row.loai_hinh.trim();
    const co = { NGÃ†Â¯Ã¡Â»Â NG_KINH_PHI: coNgÃ†Â°Ã¡Â»Â¡ngKinhPhi, NGÃ†Â¯Ã¡Â»Â NG_THOI_GIAN: coNgÃ†Â°Ã¡Â»Â¡ngThoiGian, CHUA_PHAN_LOAI: chuaPhanLoai, THIEU_HO_SO: coThieuHoSo };
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
    return res.status(500).json({ message: 'LÃ¡Â»â€”i hÃ¡Â»â€¡ thÃ¡Â»â€˜ng' });
  }
});

// POST PhÃƒÂª duyÃ¡Â»â€¡t Ã¢â‚¬â€ vien_truong hoÃ¡ÂºÂ·c admin
app.post('/api/htqt/de-xuat/:id/phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { y_kien, ngay_ky, so_van_ban } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isAdmin) {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t' });
    } catch (e) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    const stl = (row.status || '').toLowerCase();
    if (stl !== 'cho_vt_phe_duyet' && stl !== 'cho_vt_duyet') return res.status(400).json({ message: 'TrÃ¡ÂºÂ¡ng thÃƒÂ¡i khÃƒÂ´ng cho phÃƒÂ©p phÃƒÂª duyÃ¡Â»â€¡t' });
    if (!row.loai_hinh) return res.status(400).json({ message: 'ChÃ†Â°a phÃƒÂ¢n loÃ¡ÂºÂ¡i loÃ¡ÂºÂ¡i hÃƒÂ¬nh' });
    const ngayKy = (ngay_ky || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    db.prepare('UPDATE htqt_de_xuat SET status = \'da_duyet\', vt_y_kien = ?, vt_ngay_ky = ?, vt_so_van_ban = ?, vt_nguoi_ky_id = ?, vt_xu_ly_id = ?, vt_xu_ly_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .run(y_kien || null, ngayKy, so_van_ban || null, req.user.id, req.user.id, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'phe_duyet', req.user.id, req.user.fullname || req.user.email, y_kien || '');
    try {
      const gen = coopTryAutoGenerateYtnnVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[htqt legacy] Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t YTNN nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx).');
      }
    } catch (e) {}
    return res.json({ message: 'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', status: 'da_duyet' });
  } catch (e) {
    console.error('[API] phe-duyet error:', e.message);
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// POST YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â‚¬â€ vien_truong, admin
app.post('/api/htqt/de-xuat/:id/yeu-cau-bo-sung', authMiddleware, vienTruongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { noi_dung, han_bo_sung, gui_den } = req.body || {};
  if (!noi_dung || (noi_dung || '').trim().length < 20) return res.status(400).json({ message: 'NÃ¡Â»â„¢i dung yÃƒÂªu cÃ¡ÂºÂ§u tÃ¡Â»â€˜i thiÃ¡Â»Æ’u 20 kÃƒÂ½ tÃ¡Â»Â±' });
  if (!han_bo_sung) return res.status(400).json({ message: 'HÃ¡ÂºÂ¡n bÃ¡Â»â€¢ sung bÃ¡ÂºÂ¯t buÃ¡Â»â„¢c' });
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'yeu_cau_bo_sung\', updated_at = datetime(\'now\') WHERE id = ?').run(id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'yeu_cau_bo_sung', req.user.id, req.user.fullname || req.user.email, noi_dung.trim(), JSON.stringify({ han_bo_sung, gui_den: gui_den || [] }));
    return res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.', status: 'yeu_cau_bo_sung' });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// POST KhÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t Ã¢â‚¬â€ vien_truong hoÃ¡ÂºÂ·c admin
app.post('/api/htqt/de-xuat/:id/khong-phe-duyet', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ly_do } = req.body || {};
  const userEmail = (req.user.email || '').trim().toLowerCase();
  if (!ly_do || (ly_do || '').trim().length < 30) return res.status(400).json({ message: 'LÃƒÂ½ do tÃ¡Â»â€˜i thiÃ¡Â»Æ’u 30 kÃƒÂ½ tÃ¡Â»Â±' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
      if (!vt) return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃ¡Â»Â±c hiÃ¡Â»â€¡n' });
    } catch (e) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃ¡Â»Â±c hiÃ¡Â»â€¡n' });
    }
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t' });
    db.prepare('UPDATE htqt_de_xuat SET status = \'tu_choi\', ly_do_khong_duyet = ?, updated_at = datetime(\'now\') WHERE id = ?').run(ly_do.trim(), id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'khong_phe_duyet', req.user.id, req.user.fullname || req.user.email, ly_do.trim());
    return res.json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t.', status: 'tu_choi' });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// PATCH Admin cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã¢â‚¬â€ admin only
app.patch('/api/htqt/de-xuat/:id/admin', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { ma_de_xuat, nguoi_phu_trach_id, muc_do_uu_tien, ghi_chu_noi_bo, trang_thai, loai_hinh } = req.body || {};
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  try {
    const updates = [];
    const params = [];
    if (ma_de_xuat != null) { updates.push('ma_de_xuat = ?'); params.push(ma_de_xuat); }
    if (nguoi_phu_trach_id != null) { updates.push('nguoi_phu_trach_id = ?'); params.push(nguoi_phu_trach_id); }
    if (muc_do_uu_tien != null) { updates.push('muc_do_uu_tien = ?'); params.push(muc_do_uu_tien); }
    if (ghi_chu_noi_bo != null) { updates.push('ghi_chu_noi_bo = ?'); params.push(ghi_chu_noi_bo); }
    if (trang_thai != null) { updates.push('status = ?'); params.push(trang_thai); }
    if (loai_hinh != null) { updates.push('loai_hinh = ?'); params.push(loai_hinh); }
    if (updates.length === 0) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ trÃ†Â°Ã¡Â»Âng nÃƒÂ o cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t' });
    params.push(id);
    db.prepare('UPDATE htqt_de_xuat SET ' + updates.join(', ') + ', updated_at = datetime(\'now\') WHERE id = ?').run(...params);
    return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// POST TÃ¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t YTNN (demo / PhÃƒÂ²ng KHCN) Ã¢â‚¬â€ Ã„â€˜Ã¡Â»Æ’ cÃƒÂ³ dÃ¡Â»Â¯ liÃ¡Â»â€¡u test
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
      body.ten || 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n tÃƒÂ i chÃƒÂ­nh YTNN mÃ¡ÂºÂ«u',
      body.mo_ta || 'MÃƒÂ´ tÃ¡ÂºÂ£ tÃƒÂ³m tÃ¡ÂºÂ¯t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t hÃ¡Â»Â£p tÃƒÂ¡c quÃ¡Â»â€˜c tÃ¡ÂºÂ¿.',
      body.doi_tac_ten || 'Ã„ÂÃ¡ÂºÂ¡i hÃ¡Â»Âc Kyoto',
      body.doi_tac_quoc_gia || 'NhÃ¡ÂºÂ­t BÃ¡ÂºÂ£n',
      body.chu_nhiem_ten || user.fullname || 'ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m',
      body.chu_nhiem_hoc_vi || 'TS.',
      body.chu_nhiem_don_vi || 'PhÃƒÂ²ng Lab',
      body.ngay_bat_dau || (year + '-04-01'),
      body.ngay_ket_thuc || (year + '-12-31'),
      body.thoi_gian_thang || 9,
      body.kinh_phi_vnd || 300000000,
      body.loai_hinh || 'hoat_dong_khcn',
      body.to_trinh_phong_khcn || 'PhÃƒÂ²ng KHCN&QHÃ„ÂN Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n tÃƒÂ i chÃƒÂ­nh YTNN theo Ã„ÂiÃ¡Â»Âu 62, 63, 64 Quy chÃ¡ÂºÂ¿ KHCN-Ã„ÂMST SCI 2026.',
      body.status || 'cho_vt_duyet',
      body.ngay_tiep_nhan || new Date().toISOString().slice(0, 10),
      body.han_xu_ly_vt || (() => { const d = new Date(); d.setDate(d.getDate() + 5); return d.toISOString().slice(0, 10); })(),
      user.email || '',
      user.fullname || '',
      user.id || null
    );
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
    const ma = body.ma_de_xuat || ('Ã„ÂX-' + year + '-' + String(id).padStart(4, '0'));
    db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat = ? WHERE id = ?').run(ma, id);
    db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'tao_moi', user.id, user.fullname || user.email, 'TÃ¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t');
    ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'].forEach(function(loai) {
      try {
        db.prepare('INSERT INTO htqt_de_xuat_files (de_xuat_id, loai_file, ten_file, uploaded_by_id) VALUES (?, ?, ?, ?)')
          .run(id, loai, loai.replace(/_/g, ' ') + '.pdf', user.id);
      } catch (e) {}
    });
    return res.json({ message: 'Ã„ÂÃƒÂ£ tÃ¡ÂºÂ¡o Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', id, ma_de_xuat: ma });
  } catch (e) {
    console.error('[API] htqt/de-xuat create error:', e.message);
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// ThÃƒÂªm htqt_de_xuat vÃƒÂ o danh sÃƒÂ¡ch chÃ¡Â»Â duyÃ¡Â»â€¡t
function addHtqtToChoDuyetList(list, year) {
  try {
    const rows = db.prepare('SELECT id, ten, chu_nhiem_ten, loai_hinh, status, created_at, ngay_tiep_nhan FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\') ORDER BY created_at ASC').all();
    for (const r of rows || []) {
      list.push({
        source: 'htqt',
        id: r.id,
        ma_de_xuat: r.ma_de_xuat || ('Ã„ÂX-' + year + '-' + String(r.id).padStart(4, '0')),
        title: (r.ten || 'Ã¢â‚¬â€') + (r.chu_nhiem_ten ? ' Ã¢â‚¬â€ ' + r.chu_nhiem_ten : ''),
        submitted_by: r.chu_nhiem_ten || 'Ã¢â‚¬â€',
        ngay_gui: (r.ngay_tiep_nhan || r.created_at || '').slice(0, 10),
        status: r.status,
        loai_hinh: r.loai_hinh
      });
    }
  } catch (e) {}
}

// Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t cÃ¡Â»Â§a tÃƒÂ´i Ã¢â‚¬â€ danh sÃƒÂ¡ch Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t user Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i (MOU, Ã„ÂoÃƒÂ n ra)
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
        ma_de_xuat: 'Ã„ÂX-' + year + '-M' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t MOU Ã¢â‚¬â€ ' + (r.ten_doi_tac || 'Ã¢â‚¬â€') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'dang_tham_dinh',
        step: r.status === 'dang_tham_dinh' ? 1 : (r.status === 'da_duyet' ? 4 : 2),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN'
      });
    }
    const doans = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, status, created_at FROM cooperation_doan_ra WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
    for (const r of doans || []) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      list.push({
        source: 'doan_ra',
        loai: 'doan_ra',
        id: r.id,
        ma_de_xuat: 'Ã„ÂX-' + year + '-D' + String(r.id).padStart(4, '0'),
        title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ' + (r.muc_dich || r.quoc_gia || 'Ã¢â‚¬â€') + (r.quoc_gia ? ', ' + r.quoc_gia : '') + ' Ã¢â‚¬â€ ' + soTV + ' thÃƒÂ nh viÃƒÂªn',
        ngay_gui: (r.created_at || '').slice(0, 10),
        status: r.status || 'cho_phong_duyet',
        step: r.status === 'da_duyet' ? 4 : (r.status === 'tu_choi' ? 4 : r.status === 'dang_chuan_bi' ? 2 : 1),
        yeu_cau_bo_sung: null,
        han_phan_hoi: null,
        nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN'
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
          ma_de_xuat: 'Ã„ÂX-' + year + '-V' + String(r.id).padStart(4, '0'),
          title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ' + (r.muc_dich || 'Ã¢â‚¬â€') + ' Ã¢â‚¬â€ ' + (r.don_vi_de_xuat || 'Ã¢â‚¬â€'),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_tham_dinh',
          step,
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN'
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
          title: 'Ã„ÂÃ¡Â»Â tÃƒÂ i cÃƒÂ³ yÃ¡ÂºÂ¿u tÃ¡Â»â€˜ nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i Ã¢â‚¬â€ ' + (r.ten || 'Ã¢â‚¬â€'),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_phong_duyet',
          step: 1,
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN'
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
          draft: 'NhÃƒÂ¡p',
          submitted: 'ChÃ¡Â»Â PhÃƒÂ²ng KHCN',
          khcn_reviewing: 'PhÃƒÂ²ng Ã„â€˜ang xem xÃƒÂ©t',
          khcn_approved: 'ChÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng',
          director_reviewing: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ang xem xÃƒÂ©t',
          director_approved: 'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t',
          director_rejected: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng tÃ¡Â»Â« chÃ¡Â»â€˜i',
          khcn_rejected: 'PhÃƒÂ²ng KHCN tÃ¡Â»Â« chÃ¡Â»â€˜i',
          completed: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p minh chÃ¡Â»Â©ng',
        };
        for (const r of hn || []) {
          list.push({
            source: 'hnht',
            loai: 'hnht',
            id: r.id,
            ma_de_xuat: r.submission_code || '',
            title: 'HN/HT Ã¢â‚¬â€ ' + (r.conf_name || 'Ã¢â‚¬â€'),
            ngay_gui: (r.created_at || '').slice(0, 10),
            status: r.status || 'draft',
            status_label: HN_ST[r.status] || r.status,
            step: 1,
            yeu_cau_bo_sung: null,
            han_phan_hoi: null,
            nguoi_xu_ly: 'PhÃƒÂ²ng KHCN&QHÃ„ÂN',
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

// GÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra: lÃ†Â°u vÃƒÂ o DB + gÃ¡Â»Â­i email tÃ¡Â»â€ºi danh sÃƒÂ¡ch nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o (topic doan_ra hoÃ¡ÂºÂ·c all)
app.post('/api/cooperation/doan-ra/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'NgÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || 'Ã¢â‚¬â€';
  const quocGia = (body.quoc_gia || body.quocGia || '').trim() || 'Ã¢â‚¬â€';
  const ngayDi = (body.ngay_di || body.ngayDi || '').trim() || 'Ã¢â‚¬â€';
  const ngayVe = (body.ngay_ve || body.ngayVe || '').trim() || 'Ã¢â‚¬â€';
  const thanhVien = (body.thanh_vien || body.thanhVien || '').trim() || 'Ã¢â‚¬â€';
  const nguonKinhPhi = (body.nguon_kinh_phi || body.nguonKinhPhi || '').trim() || 'Ã¢â‚¬â€';
  const duToan = (body.du_toan != null && body.du_toan !== '') ? String(body.du_toan) : 'Ã¢â‚¬â€';
  const toList = getCooperationRecipients('doan_ra');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'ChÃ†Â°a cÃƒÂ³ email nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o Ã„ÂoÃƒÂ n ra. Admin vui lÃƒÂ²ng thÃƒÂªm trong QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ module HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿.',
      sent: 0
    });
  }
  try {
    db.prepare(
      `INSERT INTO cooperation_doan_ra (submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_phong_duyet')`
    ).run(submittedByEmail, submittedBy, mucDich, quocGia, ngayDi, ngayVe, thanhVien, nguonKinhPhi, duToan);
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i lÃ†Â°u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t: ' + (e.message || ''), sent: 0 });
  }
  const newRowId = (db.prepare('SELECT last_insert_rowid() as id').get() || {}).id;
  try {
    if (newRowId) coopAddHistory('doan_ra', newRowId, 1, 'gui', 'NÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra', user, null);
  } catch (e) {}
  /* PhÃ¡ÂºÂ£i dÃƒÂ¹ng newRowId: sau coopAddHistory, last_insert_rowid() lÃƒÂ  id bÃ¡ÂºÂ£ng coop_history, khÃƒÂ´ng phÃ¡ÂºÂ£i cooperation_doan_ra Ã¢â€ â€™ UPDATE ma sai, mÃƒÂ£ khÃƒÂ´ng lÃ†Â°u */
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
  const subjectFormal = '[HÃ¡Â»Â£p tÃƒÂ¡c QT] KÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng: Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜Ã„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n ra cÃƒÂ´ng tÃƒÂ¡c nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i Ã¢â‚¬â€ ' + maDeXuat;
  const introFormal = 'KÃƒÂ­nh gÃ¡Â»Â­i <strong>ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng</strong> xem xÃƒÂ©t chÃ¡Â»â€° Ã„â€˜Ã¡ÂºÂ¡o; <strong>PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN</strong> vÃƒÂ  cÃƒÂ¡c Ã„â€˜Ã†Â¡n vÃ¡Â»â€¹ liÃƒÂªn quan Ã„â€˜Ã†Â°Ã¡Â»Â£c CC Ã„â€˜Ã¡Â»Æ’ phÃ¡Â»â€˜i hÃ¡Â»Â£p thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh theo quy Ã„â€˜Ã¡Â»â€¹nh. Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gÃ¡Â»Â­i trÃƒÂªn HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c.';
  const htmlFormal = coopBuildEmail(
    'ThÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra cÃƒÂ´ng tÃƒÂ¡c nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i',
    introFormal,
    [['MÃƒÂ£ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', maDeXuat], ['MÃ¡Â»Â¥c Ã„â€˜ÃƒÂ­ch', mucDich], ['QuÃ¡Â»â€˜c gia / Ã„ÂÃ¡Â»â€¹a Ã„â€˜iÃ¡Â»Æ’m', quocGia], ['NgÃƒÂ y Ã„â€˜i', ngayDi], ['NgÃƒÂ y vÃ¡Â»Â', ngayVe], ['ThÃƒÂ nh viÃƒÂªn Ã„â€˜oÃƒÂ n', thanhVien.replace(/\n/g, '<br>')], ['NguÃ¡Â»â€œn kinh phÃƒÂ­', nguonKinhPhi], ['DÃ¡Â»Â± toÃƒÂ¡n (VND)', duToan]],
    'TrÃƒÂ¢n trÃ¡Â»Âng kÃƒÂ­nh gÃ¡Â»Â­i,<br/>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c<br/><span style="font-size:12px;color:#64748b">(ThÃƒÂ´ng bÃƒÂ¡o tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng tÃ¡Â»Â« hÃ¡Â»â€¡ thÃ¡Â»â€˜ng)</span>',
    moduleLink
  );
  const textFormal = 'KÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (CC PhÃƒÂ²ng KHCN&QHÃ„ÂN vÃƒÂ  cÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o theo cÃ¡ÂºÂ¥u hÃƒÂ¬nh),\n\n' +
    'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜Ã„Æ’ng kÃƒÂ½ Ã„ÂoÃƒÂ n ra cÃƒÂ´ng tÃƒÂ¡c nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i.\nMÃƒÂ£: ' + maDeXuat + '\nNgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
    'MÃ¡Â»Â¥c Ã„â€˜ÃƒÂ­ch: ' + mucDich + '\nQuÃ¡Â»â€˜c gia/Ã„ÂÃ¡Â»â€¹a Ã„â€˜iÃ¡Â»Æ’m: ' + quocGia + '\nNgÃƒÂ y Ã„â€˜i: ' + ngayDi + '\nNgÃƒÂ y vÃ¡Â»Â: ' + ngayVe + '\n' +
    'DÃ¡Â»Â± toÃƒÂ¡n (VND): ' + duToan + '\n\nXem chi tiÃ¡ÂºÂ¿t: ' + moduleLink + '\n\nTrÃƒÂ¢n trÃ¡Â»Âng kÃƒÂ­nh gÃ¡Â»Â­i,\nHÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c';
  if (!transporter) {
    return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t. HÃ¡Â»â€¡ thÃ¡Â»â€˜ng chÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh SMTP nÃƒÂªn chÃ†Â°a gÃ¡Â»Â­i Ã„â€˜Ã†Â°Ã¡Â»Â£c email thÃƒÂ´ng bÃƒÂ¡o.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
  }
  coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
    .then(() => {
      const n = toMail.length + ccMail.length;
      res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra. Email kÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (CC PhÃƒÂ²ng KHCN vÃƒÂ  cÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o theo cÃ¡ÂºÂ¥u hÃƒÂ¬nh).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
    })
    .catch(err => {
    console.error('[Email] GÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o Ã„ÂoÃƒÂ n ra lÃ¡Â»â€”i:', err.message);
    res.status(500).json({ message: 'GÃ¡Â»Â­i email thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'LÃ¡Â»â€”i hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.'), sent: 0 });
  });
});

// GÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ quy trÃƒÂ¬nh & mÃƒÂ£ vÃ¡Â»â€ºi Ã„ÂoÃƒÂ n ra (cho_phong_duyet Ã¢â€ â€™ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh Ã¢â€ â€™ VT)
app.post('/api/cooperation/doan-vao/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const submittedBy = (user.fullname || user.email || 'NgÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng').trim();
  const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
  const body = req.body || {};
  const mucDich = (body.muc_dich || body.mucDich || '').trim() || 'Ã¢â‚¬â€';
  const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || 'Ã¢â‚¬â€';
  const ngayDen = (body.ngay_den || body.ngayDen || '').trim() || 'Ã¢â‚¬â€';
  const ngayRoiDi = (body.ngay_roi_di || body.ngayRoiDi || '').trim() || 'Ã¢â‚¬â€';
  const thanhPhanDoan = (body.thanh_phan_doan || body.thanhPhanDoan || '').trim() || 'Ã¢â‚¬â€';
  const noiDungLamViec = (body.noi_dung_lam_viec || body.noiDungLamViec || '').trim() || 'Ã¢â‚¬â€';
  const kinhPhiNguon = (body.kinh_phi_nguon || body.kinhPhiNguon || '').trim() || 'Ã¢â‚¬â€';
  const hoTroVisa = (body.ho_tro_visa || body.hoTroVisa || '').trim() || 'Ã¢â‚¬â€';
  const toList = getCooperationRecipients('doan_vao');
  if (toList.length === 0) {
    return res.status(400).json({
      message: 'ChÃ†Â°a cÃƒÂ³ email nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o Ã„ÂoÃƒÂ n vÃƒÂ o. Admin vui lÃƒÂ²ng thÃƒÂªm trong QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â€ â€™ Danh sÃƒÂ¡ch email (chÃ¡Â»Ân topic Ã„ÂoÃƒÂ n vÃƒÂ o).',
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
    return res.status(500).json({ message: 'LÃ¡Â»â€”i lÃ†Â°u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t: ' + (e.message || ''), sent: 0 });
  }
  try {
    if (newRowId) coopAddHistory('doan_vao', newRowId, 1, 'gui', 'NÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o', user, null);
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
  const subjectFormal = '[HÃ¡Â»Â£p tÃƒÂ¡c QT] KÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng: Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ' + maDeXuat;
  const introFormal = 'KÃƒÂ­nh gÃ¡Â»Â­i <strong>ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng</strong> xem xÃƒÂ©t chÃ¡Â»â€° Ã„â€˜Ã¡ÂºÂ¡o; <strong>PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN</strong> vÃƒÂ  cÃƒÂ¡c Ã„â€˜Ã†Â¡n vÃ¡Â»â€¹ liÃƒÂªn quan Ã„â€˜Ã†Â°Ã¡Â»Â£c CC Ã„â€˜Ã¡Â»Æ’ phÃ¡Â»â€˜i hÃ¡Â»Â£p thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh theo quy Ã„â€˜Ã¡Â»â€¹nh. Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gÃ¡Â»Â­i trÃƒÂªn HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c.';
  const htmlFormal = coopBuildEmail(
    'ThÃƒÂ´ng bÃƒÂ¡o Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n Ã„ÂoÃƒÂ n vÃƒÂ o (Ã„â€˜oÃƒÂ n khÃƒÂ¡ch quÃ¡Â»â€˜c tÃ¡ÂºÂ¿)',
    introFormal,
    [['MÃƒÂ£ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', maDeXuat], ['MÃ¡Â»Â¥c Ã„â€˜ÃƒÂ­ch', mucDich], ['Ã„ÂÃ†Â¡n vÃ¡Â»â€¹ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n', donViDeXuat], ['NgÃƒÂ y Ã„â€˜Ã¡ÂºÂ¿n', ngayDen], ['NgÃƒÂ y rÃ¡Â»Âi Ã„â€˜i', ngayRoiDi], ['ThÃƒÂ nh phÃ¡ÂºÂ§n Ã„â€˜oÃƒÂ n khÃƒÂ¡ch', thanhPhanDoan.replace(/\n/g, '<br>')], ['NÃ¡Â»â„¢i dung lÃƒÂ m viÃ¡Â»â€¡c', noiDungLamViec.replace(/\n/g, '<br>')], ['Kinh phÃƒÂ­ Ã„â€˜ÃƒÂ³n tiÃ¡ÂºÂ¿p', kinhPhiNguon], ['HÃ¡Â»â€” trÃ¡Â»Â£ visa / nhÃ¡ÂºÂ­p cÃ¡ÂºÂ£nh', hoTroVisa]],
    'TrÃƒÂ¢n trÃ¡Â»Âng kÃƒÂ­nh gÃ¡Â»Â­i,<br/>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c<br/><span style="font-size:12px;color:#64748b">(ThÃƒÂ´ng bÃƒÂ¡o tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng tÃ¡Â»Â« hÃ¡Â»â€¡ thÃ¡Â»â€˜ng)</span>',
    moduleLink
  );
  const textFormal = 'KÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (CC PhÃƒÂ²ng KHCN&QHÃ„ÂN vÃƒÂ  cÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o theo cÃ¡ÂºÂ¥u hÃƒÂ¬nh),\n\n' +
    'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n Ã„ÂoÃƒÂ n vÃƒÂ o.\nMÃƒÂ£: ' + maDeXuat + '\nNgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
    'MÃ¡Â»Â¥c Ã„â€˜ÃƒÂ­ch: ' + mucDich + '\nÃ„ÂÃ†Â¡n vÃ¡Â»â€¹: ' + donViDeXuat + '\nNgÃƒÂ y Ã„â€˜Ã¡ÂºÂ¿n: ' + ngayDen + '\nNgÃƒÂ y rÃ¡Â»Âi: ' + ngayRoiDi + '\n' +
    'ThÃƒÂ nh phÃ¡ÂºÂ§n: ' + thanhPhanDoan + '\n\nXem chi tiÃ¡ÂºÂ¿t: ' + moduleLink + '\n\nTrÃƒÂ¢n trÃ¡Â»Âng kÃƒÂ­nh gÃ¡Â»Â­i,\nHÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c';
  if (!transporter) {
    return res.json({ message: 'Ã„ÂÃƒÂ£ lÃ†Â°u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t. HÃ¡Â»â€¡ thÃ¡Â»â€˜ng chÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh SMTP nÃƒÂªn chÃ†Â°a gÃ¡Â»Â­i Ã„â€˜Ã†Â°Ã¡Â»Â£c email thÃƒÂ´ng bÃƒÂ¡o.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
  }
  coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
    .then(() => {
      const n = toMail.length + ccMail.length;
      res.json({ message: 'Ã„ÂÃƒÂ£ gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o. Email kÃƒÂ­nh gÃ¡Â»Â­i ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (CC PhÃƒÂ²ng KHCN vÃƒÂ  cÃƒÂ¡c Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° nhÃ¡ÂºÂ­n thÃƒÂ´ng bÃƒÂ¡o theo cÃ¡ÂºÂ¥u hÃƒÂ¬nh).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
    })
    .catch(err => {
    console.error('[Email] GÃ¡Â»Â­i thÃƒÂ´ng bÃƒÂ¡o Ã„ÂoÃƒÂ n vÃƒÂ o lÃ¡Â»â€”i:', err.message);
    res.status(500).json({ message: 'GÃ¡Â»Â­i email thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i: ' + (err.message || 'LÃ¡Â»â€”i hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.'), sent: 0 });
  });
});

// Danh sÃƒÂ¡ch Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra (dÃ¡Â»Â¯ liÃ¡Â»â€¡u thÃ¡ÂºÂ­t, quÃƒÂ¡ trÃƒÂ¬nh xÃ¡Â»Â­ lÃƒÂ½)
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

// Danh sÃƒÂ¡ch Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n vÃƒÂ o (Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ vÃ¡Â»â€ºi bÃ¡ÂºÂ£ng "Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i" trÃƒÂªn giao diÃ¡Â»â€¡n Ã¢â‚¬â€ giÃ¡Â»â€˜ng Ã„ÂoÃƒÂ n ra)
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

// Danh sÃƒÂ¡ch Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n / MOU (giÃ¡Â»â€˜ng Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ bÃ¡ÂºÂ£ng Ã‚Â«Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­iÃ‚Â» trÃƒÂªn module)
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

// Admin: cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t trÃ¡ÂºÂ¡ng thÃƒÂ¡i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra (quÃƒÂ¡ trÃƒÂ¬nh xÃ¡Â»Â­ lÃƒÂ½)
app.put('/api/admin/cooperation/doan-ra/:id/status', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = (req.body && req.body.status) ? String(req.body.status).trim() : '';
  const allowed = ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung', 'cho_ky_duyet', 'dang_chuan_bi', 'da_duyet', 'tu_choi', 'ket_thuc_boi_nguoi_nop'];
  if (!id || !allowed.includes(status)) {
    return res.status(400).json({ message: 'ID hoÃ¡ÂºÂ·c trÃ¡ÂºÂ¡ng thÃƒÂ¡i khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡. TrÃ¡ÂºÂ¡ng thÃƒÂ¡i: cho_phong_duyet | cho_vt_duyet | yeu_cau_bo_sung | da_duyet | tu_choi | ket_thuc_boi_nguoi_nop | Ã¢â‚¬Â¦' });
  }
  try {
    const r = db.prepare('UPDATE cooperation_doan_ra SET status = ?, updated_at = datetime(\'now\'), coop_reminder_last_at = NULL WHERE id = ?').run(status, id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
    if (status === 'da_duyet') {
      coopTryAutoGenerateDoanRaVanBan(id);
    }
    return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t trÃ¡ÂºÂ¡ng thÃƒÂ¡i.', status });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
});

// TÃ¡Â»â€¢ng quan HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ sÃ¡Â»â€˜ liÃ¡Â»â€¡u thÃ¡ÂºÂ­t cho dashboard
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
        title: r.ten || (r.doi_tac + ' sÃ¡ÂºÂ¯p hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n'),
        deadline: r.het_han || 'Ã¢â‚¬â€',
        status: 'sap_het_han',
        statusLabel: 'SÃ¡ÂºÂ¯p hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n',
        action: 'thoathuan'
      });
    }
    for (const r of (doanRa || []).filter(x => ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung'].includes((x.status || '').toLowerCase()))) {
      const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
      const st = (r.status || '').toLowerCase();
      const stLabel = st === 'cho_vt_duyet' ? 'ChÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng' : st === 'cho_phong_duyet' ? 'ChÃ¡Â»Â PhÃƒÂ²ng KHCN' : 'YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
      pendingItems.push({
        type: 'doan_ra',
        typeLabel: 'Ã„ÂoÃƒÂ n ra',
        title: (r.muc_dich || r.quoc_gia || 'Ã„ÂoÃƒÂ n ra') + ' Ã¢â‚¬â€ ' + soTV + ' thÃƒÂ nh viÃƒÂªn',
        deadline: r.ngay_di || 'Ã¢â‚¬â€',
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
        typeLabel: 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t MOU',
        title: 'MOU vÃ¡Â»â€ºi ' + (r.ten_doi_tac || 'Ã¢â‚¬â€'),
        deadline: 'Ã¢â‚¬â€',
        status: 'dang_tham_dinh',
        statusLabel: 'Ã„Âang thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh',
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
          typeLabel: 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t YTNN',
          title: (r.ten || 'Ã¢â‚¬â€') + (r.chu_nhiem_ten ? ' Ã¢â‚¬â€ ' + r.chu_nhiem_ten : ''),
          deadline: r.han_xu_ly_vt || 'Ã¢â‚¬â€',
          status: r.status || 'cho_vt_duyet',
          statusLabel: 'ChÃ¡Â»Â phÃƒÂª duyÃ¡Â»â€¡t',
          action: 'de-xuat-cho-duyet',
          source: 'htqt',
          id: r.id
        });
      }
    } catch (e) {}
    pendingItems.sort((a, b) => {
      if (a.deadline === 'Ã¢â‚¬â€' && b.deadline === 'Ã¢â‚¬â€') return 0;
      if (a.deadline === 'Ã¢â‚¬â€') return 1;
      if (b.deadline === 'Ã¢â‚¬â€') return -1;
      return String(a.deadline).localeCompare(String(b.deadline));
    });
    const formatTongKinhPhi = (v) => {
      if (v >= 1e9) return (v / 1e9).toFixed(1) + ' tÃ¡Â»Â·';
      if (v >= 1e6) return (v / 1e6).toFixed(0) + ' triÃ¡Â»â€¡u';
      return v ? String(Math.round(v)) : 'Ã¢â‚¬â€';
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
      stats: { total_doi_tac: 0, mou_hieu_luc: 0, mou_sap_het_han: 0, de_tai_dang_chay: 0, de_tai_cho_duyet: 0, de_xuat_cho_duyet: 0, tong_kinh_phi: 0, tong_kinh_phi_formatted: 'Ã¢â‚¬â€', so_quoc_gia: 0 },
      pending_items: []
    });
  }
});

/** Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c hÃ¡Â»Â£p tÃƒÂ¡c Ã¢â‚¬â€ cÃƒÂ¹ng logic vÃ¡Â»â€ºi GET /api/cooperation/doi-tac (dÃƒÂ¹ng cho trang chÃ¡Â»Â§ + module) */
function cooperationComputePartnerStats() {
  const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac FROM cooperation_thoa_thuan').all();
  const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status FROM cooperation_mou_de_xuat').all();
  let missions = [];
  try {
    missions = db.prepare('SELECT id, cooperating_units, status FROM missions WHERE cooperating_units IS NOT NULL AND cooperating_units != \'\'').all();
  } catch (e) { /* bÃ¡ÂºÂ£ng missions cÃƒÂ³ thÃ¡Â»Æ’ chÃ†Â°a cÃƒÂ³ cÃ¡Â»â„¢t */ }
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
    if (q.includes('viÃ¡Â»â€¡t nam') || q.includes('viet nam') || q.includes('vn')) return 'trong_nuoc';
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

// Danh sÃƒÂ¡ch Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ tÃ¡Â»â€¢ng hÃ¡Â»Â£p tÃ¡Â»Â« thÃ¡Â»Âa thuÃ¡ÂºÂ­n, Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t MOU, dÃ¡Â»Â± ÃƒÂ¡n (missions)
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

// Danh sÃƒÂ¡ch ThÃ¡Â»Âa thuÃ¡ÂºÂ­n (MOU, MOA, HÃ„Â KH&CN, LOI)
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
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  try {
    const row = db.prepare(
      `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
              no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
       FROM cooperation_thoa_thuan WHERE id = ?`
    ).get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y thÃ¡Â»Âa thuÃ¡ÂºÂ­n.' });
    return res.json({ ok: true, item: row });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message });
  }
});

function parseDownloadFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function sendCooperationScanFile(res, storedPath, originalName, forceDownload) {
  const checked = normalizeAndCheckDownloadPath(storedPath);
  if (checked.err === 403) return res.status(403).send('Truy cÃ¡ÂºÂ­p bÃ¡Â»â€¹ tÃ¡Â»Â« chÃ¡Â»â€˜i');
  if (checked.err) return res.status(404).send('File khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i');

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

// Xem / tÃ¡ÂºÂ£i bÃ¡ÂºÂ£n scan thÃ¡Â»Âa thuÃ¡ÂºÂ­n qua API cÃƒÂ³ auth (khÃƒÂ´ng mÃ¡Â»Å¸ trÃ¡Â»Â±c tiÃ¡ÂºÂ¿p /uploads/*)
app.get('/api/cooperation/thoa-thuan/:id/scan', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  try {
    const row = db.prepare('SELECT scan_file_path, scan_file_name FROM cooperation_thoa_thuan WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y thÃ¡Â»Âa thuÃ¡ÂºÂ­n.' });
    return sendCooperationScanFile(res, row.scan_file_path, row.scan_file_name, parseDownloadFlag(req.query.download));
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message });
  }
});

// Xem / tÃ¡ÂºÂ£i vÃ„Æ’n bÃ¡ÂºÂ£n kÃ¡ÂºÂ¿t thÃƒÂºc thÃ¡Â»Âa thuÃ¡ÂºÂ­n qua API cÃƒÂ³ auth
app.get('/api/cooperation/thoa-thuan/:id/termination-scan', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  try {
    const row = db
      .prepare('SELECT termination_scan_path, termination_scan_name FROM cooperation_thoa_thuan WHERE id = ?')
      .get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y thÃ¡Â»Âa thuÃ¡ÂºÂ­n.' });
    return sendCooperationScanFile(
      res,
      row.termination_scan_path,
      row.termination_scan_name,
      parseDownloadFlag(req.query.download)
    );
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message });
  }
});


// Admin / P.KHCN: xÃƒÂ³a thÃ¡Â»Âa thuÃ¡ÂºÂ­n
app.delete('/api/admin/cooperation/thoa-thuan/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  try {
    const r = db.prepare('DELETE FROM cooperation_thoa_thuan WHERE id = ?').run(id);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a thÃ¡Â»Âa thuÃ¡ÂºÂ­n.' });
  } catch(e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

// P.KHCN / Admin: sÃ¡Â»Â­a thÃ¡Â»Âa thuÃ¡ÂºÂ­n (staff notes, open-ended flag, core fields)
app.put('/api/admin/cooperation/thoa-thuan/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  let prev;
  try {
    prev = db.prepare('SELECT * FROM cooperation_thoa_thuan WHERE id=?').get(id);
  } catch (e) {}
  if (!prev) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
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
        return res.status(400).json({ message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t thÃƒÂºc; khÃƒÂ´ng thÃ¡Â»Æ’ chuyÃ¡Â»Æ’n lÃ¡ÂºÂ¡i sang khÃƒÂ´ng thÃ¡Â»Âi hÃ¡ÂºÂ¡n cÃ¡Â»â€˜ Ã„â€˜Ã¡Â»â€¹nh qua form nÃƒÂ y.' });
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
        return res.status(400).json({ message: 'ThÃ¡Â»Âi hÃ¡ÂºÂ¡n cÃ¡Â»â€˜ Ã„â€˜Ã¡Â»â€¹nh cÃ¡ÂºÂ§n cÃƒÂ³ ngÃƒÂ y hÃ¡ÂºÂ¿t hiÃ¡Â»â€¡u lÃ¡Â»Â±c (het_han, YYYY-MM-DD).' });
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ gÃƒÂ¬ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  sets.push("updated_at=datetime('now','localtime')");
  vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_thoa_thuan SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message });
  }
});

// P.KHCN/Admin: thÃƒÂªm thÃ¡Â»Âa thuÃ¡ÂºÂ­n + upload scan
app.post('/api/cooperation/thoa-thuan', authMiddleware, coopPhongOrAdmin, (req, res) => {
  uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload file thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i' });
    const { ten, doi_tac, loai, het_han, ngay_ky, thoi_han_nam, quoc_gia, loai_doi_tac, staff_notes } = req.body || {};
    const tenTrim = (ten || '').trim();
    const doiTacTrim = (doi_tac || '').trim();
    const loaiTrim = (loai || '').trim();
    if (!tenTrim || !doiTacTrim || !loaiTrim) {
      return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u TÃƒÂªn thÃ¡Â»Âa thuÃ¡ÂºÂ­n, Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c hoÃ¡ÂºÂ·c LoÃ¡ÂºÂ¡i' });
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
        return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p NgÃƒÂ y kÃƒÂ½ (thÃ¡Â»Âi hÃ¡ÂºÂ¡n khÃƒÂ´ng cÃ¡Â»â€˜ Ã„â€˜Ã¡Â»â€¹nh vÃ¡ÂºÂ«n cÃ¡ÂºÂ§n ngÃƒÂ y kÃƒÂ½ Ã„â€˜Ã¡Â»Æ’ hÃ¡Â»â€œ sÃ†Â¡).' });
      }
      hetHanVal = null;
      noFixedTermInt = 1;
    } else {
      if (nk && thnRaw !== '' && Number.isFinite(thn)) {
        const computed = thoaThuanHetHanFromSigningYears(nk, thn);
        if (!computed) {
          return res.status(400).json({ message: 'NgÃƒÂ y kÃƒÂ½ hoÃ¡ÂºÂ·c thÃ¡Â»Âi hÃ¡ÂºÂ¡n hiÃ¡Â»â€¡u lÃ¡Â»Â±c (nÃ„Æ’m) khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
        }
        hetHanVal = computed;
      } else {
        hetHanVal = (het_han || '').trim() || null;
      }
      if (!hetHanVal) {
        return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p NgÃƒÂ y kÃƒÂ½ vÃƒÂ  ThÃ¡Â»Âi hÃ¡ÂºÂ¡n hiÃ¡Â»â€¡u lÃ¡Â»Â±c (nÃ„Æ’m), hoÃ¡ÂºÂ·c chÃ¡Â»Ân KhÃƒÂ´ng cÃƒÂ³ thÃ¡Â»Âi hÃ¡ÂºÂ¡n cÃ¡Â»â€˜ Ã„â€˜Ã¡Â»â€¹nh.' });
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
      return res.status(201).json({ message: 'Ã„ÂÃƒÂ£ thÃƒÂªm thÃ¡Â»Âa thuÃ¡ÂºÂ­n.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
    }
  });
});

// P.KHCN / Admin: record agreement termination date + optional termination document
app.post('/api/cooperation/thoa-thuan/:id/terminate', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  uploadHtqtThoaThuanTermination.single('termination_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload termination file failed' });
    const termRaw = String((req.body && req.body.terminated_at) || '').trim();
    if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(termRaw)) {
      return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p ngÃƒÂ y kÃ¡ÂºÂ¿t thÃƒÂºc (YYYY-MM-DD).' });
    }
    let prev;
    try {
      prev = db.prepare(
        'SELECT id, termination_scan_path, termination_scan_name, termination_uploaded_at FROM cooperation_thoa_thuan WHERE id = ?'
      ).get(id);
    } catch (e) {
      return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
    }
    if (!prev) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y thÃ¡Â»Âa thuÃ¡ÂºÂ­n.' });
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
      return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t thÃƒÂºc thÃ¡Â»Âa thuÃ¡ÂºÂ­n.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
    }
  });
});

// P.KHCN / Admin: replace main agreement scan (PDF/DOCX/image)
app.post('/api/cooperation/thoa-thuan/:id/agreement-scan', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  let exists;
  try {
    exists = db.prepare('SELECT id FROM cooperation_thoa_thuan WHERE id = ?').get(id);
  } catch (e) {
    return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
  }
  if (!exists) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y thÃ¡Â»Âa thuÃ¡ÂºÂ­n.' });
  uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload failed' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file bÃ¡ÂºÂ£n scan.' });
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
      return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t bÃ¡ÂºÂ£n scan.', item: row });
    } catch (e) {
      return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + (e.message || '') });
    }
  });
});

// Admin: cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t vai trÃƒÂ². CÃ¡ÂºÂ¥p / gÃ¡Â»Â¡ vai trÃƒÂ² Admin chÃ¡Â»â€° Master Admin; khÃƒÂ´ng gÃ¡Â»Â¡ Ã„â€˜Ã†Â°Ã¡Â»Â£c Master.
app.put('/api/admin/users/role', authMiddleware, adminOnly, (req, res) => {
  const { email, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail && role !== 'admin') {
    return res.status(400).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng thÃ¡Â»Æ’ tÃ¡Â»Â± hÃ¡ÂºÂ¡ vai trÃƒÂ² cÃ¡Â»Â§a chÃƒÂ­nh mÃƒÂ¬nh' });
  }
  const allowed = ['researcher', 'thanh_vien', 'thu_ky', 'chu_tich', 'admin', 'phong_khcn', 'vien_truong', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  if (!allowed.includes(role)) {
    return res.status(400).json({ message: 'Vai trÃƒÂ² khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  }
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  const targetRow = db.prepare('SELECT role FROM users WHERE email = ?').get(em);
  if (!targetRow) {
    return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  }
  const prevRole = (targetRow.role || '').toLowerCase();
  const newRole = (role || '').toLowerCase();
  if ((councilRoles.includes(prevRole) || councilRoles.includes(newRole)) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c sÃ¡Â»Â­a vai trÃƒÂ² thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN.' });
  }
  if ((BUDGET_TEAM_ROLES.includes(prevRole) || BUDGET_TEAM_ROLES.includes(newRole)) && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c sÃ¡Â»Â­a vai trÃƒÂ² TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh.' });
  }
  if (newRole === 'admin' && prevRole !== 'admin' && !reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p vai trÃƒÂ² Admin.' });
  }
  if (prevRole === 'admin' && newRole !== 'admin') {
    if (!reqIsMasterAdmin(req)) {
      return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡Â»Â¡ quyÃ¡Â»Ân Admin.' });
    }
    if (userEmailIsMasterAdmin(em)) {
      return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ gÃ¡Â»Â¡ quyÃ¡Â»Ân Master Admin hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.' });
    }
  }
  if (councilRoles.includes(role) && !em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° tÃƒÂ i khoÃ¡ÂºÂ£n cÃƒÂ³ Ã„â€˜uÃƒÂ´i @sci.edu.vn mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃƒÂ¡n vai trÃƒÂ² ChÃ¡Â»Â§ tÃ¡Â»â€¹ch, ThÃ†Â° kÃƒÂ½, ThÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng' });
  }
  const r = db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, em);
  if (r.changes === 0) {
    return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  }
  return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t vai trÃƒÂ²' });
});

// Admin: xem vai trÃƒÂ² HÃ„ÂKHCN "phÃ¡Â»Â¥" (council_role_grants) Ã¢â‚¬â€ KHÃƒâ€NG Ã„â€˜Ã¡Â»Â¥ng users.role. DÃƒÂ¹ng khi 1 ngÃ†Â°Ã¡Â»Âi
// vÃ¡Â»Â«a cÃ¡ÂºÂ§n giÃ¡Â»Â¯ vai trÃƒÂ² hÃ¡Â»â€¡ thÃ¡Â»â€˜ng (vd ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng, PhÃƒÂ²ng KHCN) vÃ¡Â»Â«a tham gia HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN (vd ChÃ¡Â»Â§ tÃ¡Â»â€¹ch HÃ„Â).
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
    return res.status(500).json({ message: 'KhÃƒÂ´ng tÃ¡ÂºÂ£i Ã„â€˜Ã†Â°Ã¡Â»Â£c danh sÃƒÂ¡ch.' });
  }
});

// Admin: thay toÃƒÂ n bÃ¡Â»â„¢ tÃ¡ÂºÂ­p vai trÃƒÂ² HÃ„ÂKHCN phÃ¡Â»Â¥ cÃ¡Â»Â§a 1 user (body: { roles: string[] }).
// ChÃ¡Â»â€° Master Admin Ã¢â‚¬â€ cÃƒÂ¹ng mÃ¡Â»Â©c bÃ¡ÂºÂ£o vÃ¡Â»â€¡ nhÃ†Â° /api/admin/users/role Ã„â€˜Ã¡Â»â€˜i vÃ¡Â»â€ºi council role.
app.put('/api/admin/council-role-grants/:userId', authMiddleware, adminOnly, (req, res) => {
  if (!reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¥p vai trÃƒÂ² HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN.' });
  }
  const userId = parseInt(req.params.userId, 10);
  if (!userId) return res.status(400).json({ message: 'userId khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  const em = String(user.email || '').trim().toLowerCase();
  if (!em.endsWith(ALLOWED_EMAIL_DOMAIN)) {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° tÃƒÂ i khoÃ¡ÂºÂ£n cÃƒÂ³ Ã„â€˜uÃƒÂ´i @sci.edu.vn mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃƒÂ¡n vai trÃƒÂ² HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN' });
  }
  const requested = Array.isArray(req.body && req.body.roles) ? req.body.roles : [];
  const roles = Array.from(
    new Set(requested.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean))
  );
  const invalid = roles.filter((r) => !COUNCIL_ROLE_TOKENS.includes(r));
  if (invalid.length) {
    return res.status(400).json({ message: 'Vai trÃƒÂ² khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡: ' + invalid.join(', ') });
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

// Admin: danh sÃƒÂ¡ch TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh (TÃ¡Â»â€¢ trÃ†Â°Ã¡Â»Å¸ng, ThÃƒÂ nh viÃƒÂªn)
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

// Admin: cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ nh viÃƒÂªn TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh (hÃ¡Â»Â tÃƒÂªn, hÃ¡Â»Âc hÃƒÂ m hÃ¡Â»Âc vÃ¡Â»â€¹, vai trÃƒÂ²) Ã¢â‚¬â€ chÃ¡Â»â€° Master Admin,
// cÃƒÂ¹ng mÃ¡Â»Â©c bÃ¡ÂºÂ£o vÃ¡Â»â€¡ nhÃ†Â° sÃ¡Â»Â­a vai trÃƒÂ² HÃ„ÂKHCN.
app.put('/api/admin/budget-appraisal-team', authMiddleware, adminOnly, masterAdminOnly, (req, res) => {
  const { email, fullname, academicTitle, role } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Vui lÃƒÂ²ng nhÃ¡ÂºÂ­p email' });
  const allowed = ['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'];
  const r = (role || '').toLowerCase();
  if (!allowed.includes(r)) return res.status(400).json({ message: 'Vai trÃƒÂ² phÃ¡ÂºÂ£i lÃƒÂ  TÃ¡Â»â€¢ trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c ThÃƒÂ nh viÃƒÂªn TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh TC' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!existing) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n. ThÃƒÂªm qua form bÃƒÂªn trÃƒÂªn trÃ†Â°Ã¡Â»â€ºc.' });
  db.prepare('UPDATE users SET fullname = ?, academicTitle = ?, role = ? WHERE email = ?')
    .run((fullname || '').trim(), (academicTitle || '').trim() || null, r, em);
  return res.json({ message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t thÃƒÂ´ng tin thÃƒÂ nh viÃƒÂªn TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh.' });
});

// Admin: xÃƒÂ³a thÃƒÂ nh viÃƒÂªn khÃ¡Â»Âi TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh (chuyÃ¡Â»Æ’n vai trÃƒÂ² vÃ¡Â»Â NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn) Ã¢â‚¬â€ chÃ¡Â»â€° Master Admin.
app.delete('/api/admin/budget-appraisal-team/:email', authMiddleware, adminOnly, masterAdminOnly, (req, res) => {
  const em = decodeURIComponent(req.params.email || '').trim().toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  if (!['totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc'].includes(row.role)) {
    return res.status(400).json({ message: 'NgÃ†Â°Ã¡Â»Âi nÃƒÂ y khÃƒÂ´ng phÃ¡ÂºÂ£i thÃƒÂ nh viÃƒÂªn TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh' });
  }
  db.prepare('UPDATE users SET role = ?, academicTitle = NULL WHERE email = ?').run('researcher', em);
  return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a khÃ¡Â»Âi TÃ¡Â»â€¢ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh tÃƒÂ i chÃƒÂ­nh. TÃƒÂ i khoÃ¡ÂºÂ£n chuyÃ¡Â»Æ’n thÃƒÂ nh NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn.' });
});

// Admin: Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u mÃ¡Â»â€ºi (Ã¢â€°Â¥6 kÃƒÂ½ tÃ¡Â»Â±), hoÃ¡ÂºÂ·c Ã„â€˜Ã†Â°a vÃ¡Â»Â chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t nÃ¡ÂºÂ¿u Ã„â€˜Ã¡Â»Æ’ trÃ¡Â»â€˜ng (khÃƒÂ´ng cÃƒÂ²n sinh random mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€ trÃƒÂ¡nh nhÃ¡ÂºÂ§m vÃ¡Â»â€ºi Ã¢â‚¬Å“chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡tÃ¢â‚¬Â)
app.put('/api/admin/users/:email/password', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  const newPassword = (req.body?.newPassword ?? '').toString().trim();
  const wantRandomTemp = !!(req.body && req.body.generateRandomTemp === true);

  if (!newPassword || newPassword.length < 6) {
    if (wantRandomTemp) {
      const temp = crypto.randomBytes(8).toString('hex');
      const hash = await bcrypt.hash(temp, 10);
      db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
      return res.json({
        message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ¥p mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u tÃ¡ÂºÂ¡m ngÃ¡ÂºÂ«u nhiÃƒÂªn.',
        tempPassword: temp,
      });
    }
    if ((row.role || '').toLowerCase() === 'admin') {
      return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ Ã„â€˜Ã†Â°a tÃƒÂ i khoÃ¡ÂºÂ£n Admin vÃ¡Â»Â chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t qua API nÃƒÂ y.' });
    }
    const selfEm = (req.user.email || '').toLowerCase();
    if (em === selfEm) {
      return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ Ã„â€˜Ã†Â°a chÃƒÂ­nh tÃƒÂ i khoÃ¡ÂºÂ£n Ã„â€˜ang Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p vÃ¡Â»Â chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t.' });
    }
    db.prepare('UPDATE users SET password = ? WHERE email = ?').run('', em);
    return res.json({
      message: 'Ã„ÂÃƒÂ£ Ã„â€˜Ã†Â°a tÃƒÂ i khoÃ¡ÂºÂ£n vÃ¡Â»Â chÃ†Â°a kÃƒÂ­ch hoÃ¡ÂºÂ¡t. User vÃƒÂ o trang Ã„ÂÃ„Æ’ng kÃƒÂ½ (@sci.edu.vn) Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡ÂºÂ·t mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u.',
      activated: false,
    });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, em);
  return res.json({
    message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ¥p lÃ¡ÂºÂ¡i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u. GÃ¡Â»Â­i mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u tÃ¡ÂºÂ¡m cho thÃƒÂ nh viÃƒÂªn qua email nÃ¡ÂºÂ¿u cÃ¡ÂºÂ§n.',
    tempPassword: newPassword,
  });
});

// Admin: khÃƒÂ³a / mÃ¡Â»Å¸ khÃƒÂ³a Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p (ban nick)
app.put('/api/admin/users/:email/banned', authMiddleware, adminOnly, (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  const banned = !!(req.body && req.body.banned);
  if (!em) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) {
    return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ khÃƒÂ³a hoÃ¡ÂºÂ·c mÃ¡Â»Å¸ khÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n cÃ¡Â»Â§a chÃƒÂ­nh mÃƒÂ¬nh' });
  }
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  db.prepare('UPDATE users SET is_banned = ? WHERE email = ?').run(banned ? 1 : 0, em);
  return res.json({ message: banned ? 'Ã„ÂÃƒÂ£ khÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n (khÃƒÂ´ng Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p Ã„â€˜Ã†Â°Ã¡Â»Â£c).' : 'Ã„ÂÃƒÂ£ mÃ¡Â»Å¸ khÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n.' });
});

// Admin: xÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n thÃƒÂ nh viÃƒÂªn (chÃ¡Â»â€° khi khÃƒÂ´ng cÃƒÂ³ hÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p)
app.delete('/api/admin/users/:email', authMiddleware, adminOnly, async (req, res) => {
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) return res.status(400).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n cÃ¡Â»Â§a chÃƒÂ­nh mÃƒÂ¬nh' });
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  const hasCapVien = db.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  if (hasSubs || hasCapVien) {
    return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a: thÃƒÂ nh viÃƒÂªn nÃƒÂ y Ã„â€˜ÃƒÂ£ cÃƒÂ³ hÃ¡Â»â€œ sÃ†Â¡ nÃ¡Â»â„¢p trong hÃ¡Â»â€¡ thÃ¡Â»â€˜ng. CÃƒÂ³ thÃ¡Â»Æ’ chuyÃ¡Â»Æ’n vai trÃƒÂ² vÃ¡Â»Â NghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn thay vÃƒÂ¬ xÃƒÂ³a.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n.' });
});

// Master Admin: xÃƒÂ³a thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN (chu_tich/thu_ky/thanh_vien)
app.delete('/api/admin/council-members/:email', authMiddleware, adminOnly, (req, res) => {
  if (!reqIsMasterAdmin(req)) {
    return res.status(403).json({ message: 'ChÃ¡Â»â€° Master Admin mÃ¡Â»â€ºi Ã„â€˜Ã†Â°Ã¡Â»Â£c xÃƒÂ³a thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN.' });
  }
  const em = decodeURIComponent((req.params.email || '').trim()).toLowerCase();
  if (!em) return res.status(400).json({ message: 'Email khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const currentEmail = (req.user.email || '').toLowerCase();
  if (em === currentEmail) return res.status(400).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng thÃ¡Â»Æ’ tÃ¡Â»Â± xÃƒÂ³a tÃƒÂ i khoÃ¡ÂºÂ£n cÃ¡Â»Â§a chÃƒÂ­nh mÃƒÂ¬nh' });
  const row = db.prepare('SELECT id, role FROM users WHERE email = ?').get(em);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y tÃƒÂ i khoÃ¡ÂºÂ£n' });
  const councilRoles = ['chu_tich', 'thu_ky', 'thanh_vien'];
  if (!councilRoles.includes((row.role || '').toLowerCase())) {
    return res.status(400).json({ message: 'TÃƒÂ i khoÃ¡ÂºÂ£n nÃƒÂ y khÃƒÂ´ng phÃ¡ÂºÂ£i thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN.' });
  }
  const hasSubs = db.prepare('SELECT 1 FROM submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  const hasCapVien = db.prepare('SELECT 1 FROM cap_vien_submissions WHERE submittedById = ? LIMIT 1').get(row.id);
  if (hasSubs || hasCapVien) {
    return res.status(400).json({ message: 'KhÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a: thÃƒÂ nh viÃƒÂªn nÃƒÂ y Ã„â€˜ÃƒÂ£ cÃƒÂ³ hÃ¡Â»â€œ sÃ†Â¡ nÃ¡Â»â„¢p trong hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
  return res.json({ message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a thÃƒÂ nh viÃƒÂªn HÃ¡Â»â„¢i Ã„â€˜Ã¡Â»â€œng KHCN.' });
});

// KhÃ¡Â»Å¸i tÃ¡ÂºÂ¡o Admin mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh (ADMIN_EMAIL) nÃ¡ÂºÂ¿u chÃ†Â°a cÃƒÂ³ Ã¢â‚¬â€ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh race khi Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p ngay sau khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng
const adminExists = db.prepare('SELECT 1 FROM users WHERE lower(trim(email)) = ?').get(ADMIN_EMAIL.toLowerCase());
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(
    ADMIN_EMAIL.toLowerCase(),
    hash,
    'Admin',
    'admin'
  );
  console.log('Ã„ÂÃƒÂ£ tÃ¡ÂºÂ¡o tÃƒÂ i khoÃ¡ÂºÂ£n Admin mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh: ' + ADMIN_EMAIL + ' / mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u: admin123 (vui lÃƒÂ²ng Ã„â€˜Ã¡Â»â€¢i sau)');
}
// LuÃƒÂ´n Ã„â€˜Ã¡ÂºÂ£m bÃ¡ÂºÂ£o super-admin cÃƒÂ³ role admin (phÃƒÂ²ng trÃ†Â°Ã¡Â»Âng hÃ¡Â»Â£p bÃ¡Â»â€¹ Ã„â€˜Ã¡Â»â€¢i role trong DB)
try {
  const r = db
    .prepare("UPDATE users SET role = 'admin' WHERE lower(trim(email)) = ? AND lower(trim(role)) != 'admin'")
    .run(ADMIN_EMAIL.toLowerCase());
  if (r.changes > 0) console.log('[Admin] Ã„ÂÃƒÂ£ khÃƒÂ´i phÃ¡Â»Â¥c vai trÃƒÂ² admin cho ' + ADMIN_EMAIL);
} catch (e) { /* ignore */ }
// Ã„ÂÃ¡Â»â€œng bÃ¡Â»â„¢: sinhnguyen@sci.edu.vn = NCV (researcher), khÃƒÂ´ng admin; tÃƒÂªn hiÃ¡Â»Æ’n thÃ¡Â»â€¹ Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§ Ã‚Â«NguyÃ¡Â»â€¦n TrÃ†Â°Ã¡Â»Âng SinhÃ‚Â»
try {
  const r = db
    .prepare(
      `UPDATE users SET
         role = 'researcher',
         fullname = CASE
           WHEN lower(trim(coalesce(fullname, ''))) IN ('admin', 'administrator', 'quÃ¡ÂºÂ£n trÃ¡Â»â€¹', 'quan tri', 'sinh') THEN 'NguyÃ¡Â»â€¦n TrÃ†Â°Ã¡Â»Âng Sinh'
           WHEN trim(coalesce(fullname, '')) = '' THEN 'NguyÃ¡Â»â€¦n TrÃ†Â°Ã¡Â»Âng Sinh'
           ELSE fullname
         END
       WHERE lower(trim(email)) = ?`
    )
    .run('sinhnguyen@sci.edu.vn');
  if (r.changes > 0) {
    console.log('[Users] Ã„ÂÃƒÂ£ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ sinhnguyen@sci.edu.vn Ã¢â€ â€™ researcher (tÃƒÂªn: NguyÃ¡Â»â€¦n TrÃ†Â°Ã¡Â»Âng Sinh).');
  }
} catch (e) {
  /* ignore */
}

// Backfill gd5 history cho hÃ¡Â»â€œ sÃ†Â¡ cÃ…Â© Ã„â€˜ÃƒÂ£ cÃƒÂ³ meeting result
try {
  const subsWithMeeting = db.prepare('SELECT id, meetingDecisionAt, meetingDecisionById, status FROM submissions WHERE meetingDecisionAt IS NOT NULL').all();
  subsWithMeeting.forEach(s => {
    const hasHistory = db.prepare('SELECT 1 FROM submission_gd5_history WHERE submissionId = ?').get(s.id);
    if (!hasHistory) {
      const label = s.status === 'CONDITIONAL' ? 'ChÃ¡ÂºÂ¥p thuÃ¡ÂºÂ­n cÃƒÂ³ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n' : (s.status === 'APPROVED' ? 'ChÃ¡ÂºÂ¥p thuÃ¡ÂºÂ­n' : 'KhÃƒÂ´ng chÃ¡ÂºÂ¥p thuÃ¡ÂºÂ­n');
      const mf = db.prepare("SELECT originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(s.id);
      insertGd5History(s.id, 'meeting_result', s.meetingDecisionById, 'meeting_minutes', mf ? mf.originalName : null, label);
    }
  });
} catch (e) { /* ignore */ }

// CRD Lab Booking: nÃ¡ÂºÂ¿u chÃ†Â°a cÃƒÂ³ thÃ†Â° mÃ¡Â»Â¥c crd-lab-booking vÃ¡Â»â€ºi index.html thÃƒÂ¬ trÃ¡ÂºÂ£ trang placeholder (trÃƒÂ¡nh "Cannot GET")
const crdLabBookingPath = path.join(__dirname, 'crd-lab-booking', 'index.html');
app.get('/crd-lab-booking', (req, res) => res.redirect(302, '/crd-lab-booking/'));
app.get('/crd-lab-booking/', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.type('html').send(
    '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>CRD Lab Booking</title></head><body style="font-family:Segoe UI;padding:40px;text-align:center;">' +
    '<h1>Ã°Å¸ÂÂ¢ CRD Lab Booking</h1><p>Ã¡Â»Â¨ng dÃ¡Â»Â¥ng sÃ¡ÂºÂ½ hiÃ¡Â»Æ’n thÃ¡Â»â€¹ tÃ¡ÂºÂ¡i Ã„â€˜ÃƒÂ¢y khi bÃ¡ÂºÂ¡n build dÃ¡Â»Â± ÃƒÂ¡n React ra thÃ†Â° mÃ¡Â»Â¥c <code>crd-lab-booking/</code>.</p>' +
    '<p><a href="/crd-lab-booking.html">Trang thÃƒÂ´ng tin</a> Ã‚Â· <a href="/index.html">Trang chÃ¡Â»Â§</a></p></body></html>'
  );
});
app.get('/crd-lab-booking/index.html', (req, res) => {
  if (fs.existsSync(crdLabBookingPath)) return res.sendFile(crdLabBookingPath);
  res.redirect(302, '/crd-lab-booking.html');
});

// PhÃ¡Â»Â¥c vÃ¡Â»Â¥ file tÃ„Â©nh (HTML, CSS, v.v.) Ã¢â‚¬â€ sau tÃ¡ÂºÂ¥t cÃ¡ÂºÂ£ route API
// TrÃ¡ÂºÂ£ 404 JSON cho API khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i (trÃƒÂ¡nh HTML "Cannot POST/GET")

// ============================================================
// BÃ¡Â»â€ SUNG MODULE HÃ¡Â»Â¢P TÃƒÂC QUÃ¡Â»ÂC TÃ¡ÂºÂ¾
// ============================================================
// ROUTE /api/me Ã¢â‚¬â€ ThÃƒÂ´ng tin user hiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i (HTML mÃ¡Â»â€ºi cÃ¡ÂºÂ§n route nÃƒÂ y)
// ============================================================
app.get('/api/me', authMiddleware, (req, res) => {
  try {
    const user = req.user || {};
    const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(user.id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const out = { id: row.id, email: row.email, fullname: row.fullname, role: row.role };
    out.isMasterAdmin = userEmailIsMasterAdmin(out.email);
    return res.json(out);
  } catch(e) {
    return res.json(req.user || {});
  }
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ API Ã„â€˜Ã¡ÂºÂ·t lÃ¡Â»â€¹ch thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹ CRD (SQLite: crd_*) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function crdEnsurePersonForAppUser(reqUser) {
  const pid = 'u_app_' + reqUser.id;
  const existing = db.prepare('SELECT id, crd_access_revoked FROM crd_persons WHERE id = ?').get(pid);
  if (existing) {
    if (Number(existing.crd_access_revoked) === 1) return null;
    /* HÃ¡Â»â€œ sÃ†Â¡ cÃ…Â© cÃƒÂ³ thÃ¡Â»Æ’ thiÃ¡ÂºÂ¿u user_id Ã¢â‚¬â€ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ Ã„â€˜Ã¡Â»Æ’ API (email thÃƒÂ´ng bÃƒÂ¡o, v.v.) hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng */
    const uidRow = db.prepare('SELECT user_id FROM crd_persons WHERE id = ?').get(pid);
    if (uidRow && uidRow.user_id == null) {
      try {
        db.prepare('UPDATE crd_persons SET user_id = ? WHERE id = ?').run(reqUser.id, pid);
      } catch (_) { /* ignore nÃ¡ÂºÂ¿u DB cÃ…Â© khÃƒÂ´ng cÃƒÂ³ cÃ¡Â»â„¢t */ }
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

// Ã„ÂÃ¡ÂºÂ·t lÃ¡Â»â€¹ch CRD Ã¢â‚¬â€ phÃ¡ÂºÂ§n ngÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng thÃ†Â°Ã¡Â»Âng (9 endpoint) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/crd/nguoiDung.js.
// Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨.
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

// Ã„ÂÃ¡ÂºÂ·t lÃ¡Â»â€¹ch CRD Ã¢â‚¬â€ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ snapshot, thÃƒÂ´ng bÃƒÂ¡o phÃƒÂ²ng lab, thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹ (9 endpoint) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang
// routes/crd/quanTriThietBi.js. Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨: vÃ¡ÂºÂ«n trÃ†Â°Ã¡Â»â€ºc nhÃƒÂ³m quÃ¡ÂºÂ£n trÃ¡Â»â€¹ hÃ¡Â»â€œ sÃ†Â¡ CRD bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi.
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

// Ã„ÂÃ¡ÂºÂ·t lÃ¡Â»â€¹ch CRD Ã¢â‚¬â€ quÃ¡ÂºÂ£n trÃ¡Â»â€¹ hÃ¡Â»â€œ sÃ†Â¡ CRD, tÃƒÂ i khoÃ¡ÂºÂ£n, vai trÃƒÂ², lÃ¡Â»â€¹ch (12 endpoint) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang
// routes/crd/quanTriNguoiDung.js. Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨.
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

/** PhÃƒÂ¢n tÃƒÂ­ch sÃ¡Â»Â­ dÃ¡Â»Â¥ng thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹ CRD Ã¢â‚¬â€ routes/equipmentAnalytics.js (entry: server.js, khÃƒÂ´ng dÃƒÂ¹ng app.js) */
try {
  const createEquipmentAnalyticsRouter = require('./routes/equipmentAnalytics');
  app.use('/api/equipment-analytics', authMiddleware, adminOnly, createEquipmentAnalyticsRouter({ db }));
  console.log('[CRD] Ã„ÂÃƒÂ£ mount /api/equipment-analytics (admin)');
} catch (e) {
  console.warn('[CRD] KhÃƒÂ´ng mount equipment-analytics:', e.message);
}

/** QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹ (hÃ¡Â»â€œ sÃ†Â¡, PDF, video, QR) Ã¢â‚¬â€ db/equipment_schema.sql */
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
  /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */
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
      /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ cÃ¡Â»â„¢t */
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
        subject: opts.subject || 'ThÃƒÂ´ng bÃƒÂ¡o thiÃ¡ÂºÂ¿t bÃ¡Â»â€¹',
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
  console.log('[EQUIP] Ã„ÂÃƒÂ£ mount /api/equipment');
} catch (e) {
  console.warn('[EQUIP] KhÃƒÂ´ng mount equipment:', e.message);
}

/** NgÃƒÂ¢n hÃƒÂ ng TÃ¡ÂºÂ¿ bÃƒÂ o & KhÃƒÂ¡ng thÃ¡Â»Æ’ Ã¢â‚¬â€ routes/nganHangTeBaoKhangThe.js (bÃ¡ÂºÂ£ng nhm_*, chuyÃ¡Â»Æ’n hÃ†Â°Ã¡Â»â€ºng Ã„â€˜Ã¡Â»â€¹a chÃ¡Â»â€° cÃ…Â©, API) */
try {
  require('./routes/nganHangTeBaoKhangThe').mount(app, { db, authMiddleware, insertUserActivityLog, baseUrl: process.env.BASE_URL || '', nhacTuDong: true, mailSend: (o) => (transporter ? transporter.sendMail({ from: getSmtpFrom(), ...o }) : Promise.reject(new Error('mail_not_configured'))) });
  console.log('[NGAN-HANG] Ã„ÂÃƒÂ£ mount /api/ngan-hang-te-bao-khang-the');
} catch (e) {
  console.warn('[NGAN-HANG] KhÃƒÂ´ng mount ngan-hang-te-bao-khang-the:', e.message);
}

/** Quy trÃƒÂ¬nh ban hÃƒÂ nh vÃ„Æ’n bÃ¡ÂºÂ£n hÃƒÂ nh chÃƒÂ­nh nÃ¡Â»â„¢i bÃ¡Â»â„¢ (9 bÃ†Â°Ã¡Â»â€ºc) */
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
        subject: opts.subject || 'ThÃƒÂ´ng bÃƒÂ¡o quy trÃƒÂ¬nh vÃ„Æ’n bÃ¡ÂºÂ£n',
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
  // Alias tÃ†Â°Ã†Â¡ng thÃƒÂ­ch ngÃ†Â°Ã¡Â»Â£c cho bundle React cÃ…Â© (trÃ†Â°Ã¡Â»â€ºc khi Ã„â€˜Ã¡Â»â€¢i prefix /api/admin -> /api/docflow-admin).
  // ChÃ¡Â»â€° bÃ¡ÂºÂ¯c cÃ¡ÂºÂ§u nhÃ¡Â»Â¯ng path KHÃƒâ€NG Ã„â€˜Ã¡Â»Â¥ng vÃ¡Â»â€ºi cÃƒÂ¡c handler /api/admin/* cÃƒÂ³ sÃ¡ÂºÂµn cÃ¡Â»Â§a server.js (Ã„â€˜Ã¡ÂºÂ·c biÃ¡Â»â€¡t
  // KHÃƒâ€NG Ã„â€˜Ã¡Â»Â¥ng /api/admin/users Ã¢â‚¬â€ handler cÃ…Â© trÃ¡ÂºÂ£ schema khÃƒÂ¡c, sÃ¡ÂºÂ½ bÃ¡Â»â€¹ phÃƒÂ¡ nÃ¡ÂºÂ¿u alias).
  //
  // Middleware nÃƒÂ y rewrite req.url trÃ†Â°Ã¡Â»â€ºc khi chÃ¡ÂºÂ¡m internalWorkflowRouter, nÃƒÂªn phÃ¡ÂºÂ£i Ã„â€˜Ã¡Â»Â©ng TRÃ†Â¯Ã¡Â»Å¡C
  // `app.use('/api', internalWorkflowRouter)` bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi.
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
          '[DOCFLOW] Client gÃ¡Â»Âi /api/admin/* (bundle React cÃ…Â©) Ã¢â‚¬â€ Ã„â€˜ÃƒÂ£ alias sang /api/docflow-admin/*.\n' +
            '          TriÃ¡Â»Æ’n khai bundle mÃ¡Â»â€ºi: git pull + restart Node (server sÃ¡ÂºÂ½ auto rebuild dist).'
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
  console.log('[DOCFLOW] Ã„ÂÃƒÂ£ mount /api/documents, /api/attachments, /api/units, /api/dashboard/stats, /api/docflow-admin/*');
  console.log('[DOCFLOW] Alias sÃ¡ÂºÂµn sÃƒÂ ng cho bundle cÃ…Â©: /api/admin/{module|module-*|dashboard|units|audit-logs|email-notifications|document-types} -> /api/docflow-admin/*');
} catch (e) {
  console.warn('[DOCFLOW] KhÃƒÂ´ng mount internal documents workflow:', e.message);
}

/** BÃ¡ÂºÂ£ng dashboard_permissions (migrations/004_dashboard_permissions.sql) */
try {
  const dashPermSql = path.join(__dirname, 'migrations', '004_dashboard_permissions.sql');
  if (fs.existsSync(dashPermSql)) {
    db.exec(fs.readFileSync(dashPermSql, 'utf8'));
  }
} catch (e) {
  console.warn('[migrations/004_dashboard_permissions]', e.message);
}

/** NhÃ¡ÂºÂ­t kÃƒÂ½ truy cÃ¡ÂºÂ­p dashboard (migrations/005_dashboard_access_log.sql) */
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

/** CRUD quyÃ¡Â»Ân xem dashboard Ã¢â‚¬â€ routes/dashboardPermissions.js */
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
  console.log('[DASH] Ã„ÂÃƒÂ£ mount /api/dashboard-perms');
} catch (e) {
  console.warn('[DASH] KhÃƒÂ´ng mount dashboard-perms:', e.message);
}

/** QuÃ¡ÂºÂ£n lÃƒÂ½ tÃƒÂ i liÃ¡Â»â€¡u & hÃ¡Â»â€œ sÃ†Â¡ (hÃƒÂ nh chÃƒÂ­nh) Ã¢â‚¬â€ /api/dms */
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
  console.log('[DMS] Ã„ÂÃƒÂ£ mount /api/dms');
} catch (e) {
  console.warn('[DMS] KhÃƒÂ´ng mount /api/dms:', e.message);
}

/** ThÃ¡Â»â€˜ng kÃƒÂª cÃƒÂ´ng bÃ¡Â»â€˜ Ã¢â‚¬â€ theo chÃƒÂ­nh sÃƒÂ¡ch pub_analytics (whitelist / nÃ¡Â»â„¢i bÃ¡Â»â„¢ / STIMS / public) */
try {
  const createPublicationAnalyticsRouter = require('./routes/publicationAnalytics');
  const { createCheckPubAnalyticsAccess } = require('./middleware/pubAnalyticsAccess');
  const checkPubAnalytics = createCheckPubAnalyticsAccess(db, {
    isUserMasterAdmin: (u) => userEmailIsMasterAdmin(u && u.email),
  });
  app.use('/api/pub-analytics', optionalAuthMiddleware, checkPubAnalytics, createPublicationAnalyticsRouter({ db }));
  console.log('[PUB] Ã„ÂÃƒÂ£ mount /api/pub-analytics (chÃƒÂ­nh sÃƒÂ¡ch truy cÃ¡ÂºÂ­p dashboard)');
} catch (e) {
  console.warn('[PUB] KhÃƒÂ´ng mount pub-analytics:', e.message);
}

/** Dev (Master Admin): cÃ¡ÂºÂ¥u hÃƒÂ¬nh chÃƒÂ­nh sÃƒÂ¡ch truy cÃ¡ÂºÂ­p dashboard phÃƒÂ¢n tÃƒÂ­ch cÃƒÂ´ng bÃ¡Â»â€˜ */
app.get('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
  try {
    const { getPubAnalyticsSettings } = require('./middleware/pubAnalyticsAccess');
    const s = getPubAnalyticsSettings(db);
    return res.json({ ok: true, mode: s.mode, email_suffix: s.emailSuffix });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'LÃ¡Â»â€”i' });
  }
});

app.put('/api/dev/pub-analytics-access', authMiddleware, adminOrMasterAdminApi, (req, res) => {
  try {
    const allowed = ['whitelist', 'internal_domain', 'stims_all', 'public'];
    const raw = req.body && req.body.mode != null ? String(req.body.mode).trim().toLowerCase() : '';
    if (!allowed.includes(raw)) {
      return res.status(400).json({ ok: false, error: 'mode khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
    }
    let suffix = req.body && req.body.email_suffix != null ? String(req.body.email_suffix).trim().toLowerCase() : '@sci.edu.vn';
    if (suffix && !suffix.startsWith('@')) suffix = '@' + suffix;
    if (suffix.length < 2 || suffix.length > 80) {
      return res.status(400).json({ ok: false, error: 'email_suffix khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
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
    return res.status(500).json({ ok: false, error: 'LÃ¡Â»â€”i' });
  }
});

/** TÃƒÂ¬m user (autocomplete phÃƒÂ¢n quyÃ¡Â»Ân dashboard) Ã¢â‚¬â€ chÃ¡Â»â€° Admin */
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
    return res.status(500).json({ ok: false, success: false, error: 'LÃ¡Â»â€”i' });
  }
});

// Ã„ÂÃ¡ÂºÂ·t lÃ¡Â»â€¹ch CRD Ã¢â‚¬â€ kiÃ¡Â»Æ’m duyÃ¡Â»â€¡t tin, email-notif, khiÃ¡ÂºÂ¿u nÃ¡ÂºÂ¡i admin (5 endpoint) Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang
// routes/crd/kiemDuyetThongBao.js. Mount Ã„ÂÃƒÅ¡NG TÃ¡ÂºÂ I VÃ¡Â»Å  TRÃƒÂ CÃ…Â¨.
app.use('/api', require('./routes/crd/kiemDuyetThongBao')({
  authMiddleware,
  db,
  crdEnsurePersonForAppUser,
  CRD_BROADCAST_TO_ID,
  crdPersonHasModeratorSlot,
  adminOnly,
}));

// BÃ¡Â»â€ SUNG MODULE HÃ¡Â»Â¢P TÃƒÂC QUÃ¡Â»ÂC TÃ¡ÂºÂ¾ Ã¢â‚¬â€ CÃƒÂC ROUTE & TÃƒÂNH NÃ„â€šNG MÃ¡Â»Å¡I
// CÃƒÂ¡c route CÃ…Â¨ giÃ¡Â»Â¯ nguyÃƒÂªn phÃƒÂ­a trÃƒÂªn Ã¢â‚¬â€ file nÃƒÂ y CHÃ¡Â»Ë† THÃƒÅ M route mÃ¡Â»â€ºi
// ============================================================

// --- TÃ¡ÂºÂ¡o bÃ¡ÂºÂ£ng lÃ¡Â»â€¹ch sÃ¡Â»Â­ thao tÃƒÂ¡c (nÃ¡ÂºÂ¿u chÃ†Â°a cÃƒÂ³) ---
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

// --- ThÃƒÂªm cÃ¡Â»â„¢t mÃ¡Â»â€ºi vÃƒÂ o cÃƒÂ¡c bÃ¡ÂºÂ£ng hiÃ¡Â»â€¡n cÃƒÂ³ (migration an toÃƒÂ n) ---
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
// ThÃƒÂªm cÃ¡Â»â„¢t cho htqt_de_xuat (Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ quy trÃƒÂ¬nh vÃ¡Â»â€ºi Ã„ÂoÃƒÂ n ra / MOU: ghi chÃƒÂº, phÃƒÂª duyÃ¡Â»â€¡t, Word)
[['note_phong','TEXT'],['note_vt','TEXT'],['phong_xu_ly_id','INTEGER'],['phong_xu_ly_at','TEXT'],
 ['vt_xu_ly_id','INTEGER'],['vt_xu_ly_at','TEXT'],
 ['van_ban_word_path','TEXT'],['van_ban_word_original_name','TEXT'],['van_ban_word_uploaded_at','TEXT']].forEach(([col,type]) => {
  try { db.prepare(`ALTER TABLE htqt_de_xuat ADD COLUMN ${col} ${type}`).run(); } catch(e) {}
});

// --- BÃ¡ÂºÂ£ng SÃ¡Â»Â± kiÃ¡Â»â€¡n QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ (mÃ¡Â»â€ºi) ---
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

// --- Migrate status cÃ…Â© sang mÃ¡Â»â€ºi (an toÃƒÂ n, khÃƒÂ´ng phÃƒÂ¡ dÃ¡Â»Â¯ liÃ¡Â»â€¡u) ---
try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_phong_duyet' WHERE status='cho_tham_dinh'").run(); } catch(e) {}
try { db.prepare("UPDATE cooperation_doan_vao SET status='cho_vt_duyet' WHERE status='cho_ky_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE cooperation_mou_de_xuat SET status='cho_phong_duyet' WHERE status='dang_tham_dinh'").run(); } catch(e) {}
// Ã„ÂoÃƒÂ n ra: trÃ¡ÂºÂ¡ng thÃƒÂ¡i cÃ…Â© cho_ky_duyet (nhÃ¡ÂºÂ§m vÃ¡Â»â€ºi VT) Ã¢â€ â€™ chÃ¡Â»Â PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh trÃ†Â°Ã¡Â»â€ºc
try { db.prepare("UPDATE cooperation_doan_ra SET status='cho_phong_duyet' WHERE lower(trim(status))='cho_ky_duyet'").run(); } catch(e) {}
// YTNN: Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ tÃƒÂªn trÃ¡ÂºÂ¡ng thÃƒÂ¡i vÃ¡Â»â€ºi Ã„ÂoÃƒÂ n ra / MOU (cho_phong_duyet Ã¢â€ â€™ cho_vt_duyet Ã¢â€ â€™ da_duyet / tu_choi)
try { db.prepare("UPDATE htqt_de_xuat SET status='cho_phong_duyet' WHERE status='cho_phan_loai'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='cho_vt_duyet' WHERE status='cho_vt_phe_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='da_duyet' WHERE status='da_phe_duyet'").run(); } catch(e) {}
try { db.prepare("UPDATE htqt_de_xuat SET status='tu_choi' WHERE status='khong_phe_duyet'").run(); } catch(e) {}

// --- TÃ¡ÂºÂ¡o mÃƒÂ£ Ã„â€˜Ã¡Â»â€¹nh danh cho Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t chÃ†Â°a cÃƒÂ³ mÃƒÂ£ ---
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
        const ma = `Ã„ÂX-${year}-${prefix}${String(r.id).padStart(4,'0')}`;
        db.prepare(`UPDATE ${table} SET ma_de_xuat=? WHERE id=?`).run(ma, r.id);
      });
    } catch(e) {}
  });
})();

// CÃ¡Â»â„¢t nhÃ¡ÂºÂ¯c nÃ¡Â»â„¢i bÃ¡Â»â„¢ (khÃƒÂ´ng hiÃ¡Â»Æ’n thÃ¡Â»â€¹ trÃƒÂªn giao diÃ¡Â»â€¡n ngÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t)
['cooperation_doan_ra', 'cooperation_doan_vao', 'cooperation_mou_de_xuat', 'htqt_de_xuat'].forEach(tbl => {
  try { db.prepare(`ALTER TABLE ${tbl} ADD COLUMN coop_reminder_last_at TEXT`).run(); } catch (e) { /* Ã„â€˜ÃƒÂ£ cÃƒÂ³ */ }
});

// ============================================================
// HELPER FUNCTIONS MÃ¡Â»Å¡I
// ============================================================

function coopGenMa(loai, id) {
  const year = new Date().getFullYear();
  const prefix = { doan_ra:'DR', doan_vao:'DV', mou:'MU', ytnn:'YT', su_kien:'SK' }[loai] || 'XX';
  return `Ã„ÂX-${year}-${prefix}${String(id).padStart(4,'0')}`;
}

function coopAddHistory(loai, de_xuat_id, buoc, action, action_label, user, note) {
  try {
    db.prepare(`
      INSERT INTO coop_history (loai, de_xuat_id, buoc, action, action_label, performed_by_id, performed_by_name, performed_by_role, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(loai, de_xuat_id, buoc, action, action_label || action,
      (user && user.id) || null,
      (user && (user.fullname || user.email)) || 'HÃ¡Â»â€¡ thÃ¡Â»â€˜ng',
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

/** TO = ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (role trong cooperation_notification_recipients), CC = email nhÃ¡ÂºÂ­n cÃƒÂ¹ng topic + user role phong_khcn. KhÃƒÂ´ng cÃƒÂ³ VT thÃƒÂ¬ lÃ¡ÂºÂ¥y ngÃ†Â°Ã¡Â»Âi Ã„â€˜Ã¡ÂºÂ§u CC lÃƒÂ m TO. */
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
    .then(() => console.log('[Email HTQT] Ã„ÂÃƒÂ£ gÃ¡Â»Â­i:', subject))
    .catch(err => {
      console.error('[Email HTQT] LÃ¡Â»â€”i:', err.message);
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

/** TrÃ†Â°Ã¡Â»â€ºc hÃ¡ÂºÂ¡n: mÃ¡Â»â„¢t email trong khoÃ¡ÂºÂ£ng N thÃƒÂ¡ng cuÃ¡Â»â€˜i. Sau hÃ¡ÂºÂ¡n: tÃ¡Â»â€˜i Ã„â€˜a M email, cÃƒÂ¡ch nhau ÃƒÂ­t nhÃ¡ÂºÂ¥t D ngÃƒÂ y. */
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
    console.warn('[ThoaThuanExpiry] KhÃƒÂ´ng cÃƒÂ³ ngÃ†Â°Ã¡Â»Âi nhÃ¡ÂºÂ­n (topic thoa_thuan_het_han hoÃ¡ÂºÂ·c all). CÃ¡ÂºÂ¥u hÃƒÂ¬nh tÃ¡ÂºÂ¡i QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ HÃ¡Â»Â£p tÃƒÂ¡c QT.');
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
    return { sent: 0, error: 'Ã„ÂÃƒÂ£ xÃ¡ÂºÂ£y ra lÃ¡Â»â€”i. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' };
  }

  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const link = baseUrl + '/module-hoatac-quocte.html';
  let sentPre = 0;
  let sentPost = 0;

  for (const row of rows || []) {
    const exp = coopParseYmdDate(row.het_han);
    if (!exp) continue;
    const expDay = coopDateAtMidnight(exp);

    // --- Sau ngÃƒÂ y hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n (Ã„â€˜ÃƒÂ£ quÃƒÂ¡ hÃ¡ÂºÂ¡n lÃ¡Â»â€¹ch, trÃ¡ÂºÂ¡ng thÃƒÂ¡i vÃ¡ÂºÂ«n hiÃ¡Â»â€¡u lÃ¡Â»Â±c/sÃ¡ÂºÂ¯p hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n) ---
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
      const subject = '[HÃ¡Â»Â£p tÃƒÂ¡c QT] ThÃ¡Â»Âa thuÃ¡ÂºÂ­n Ã„â€˜ÃƒÂ£ quÃƒÂ¡ hÃ¡ÂºÂ¡n hiÃ¡Â»â€¡u lÃ¡Â»Â±c Ã¢â‚¬â€ nhÃ¡ÂºÂ¯c ' + nextNum + '/' + postMax + ' Ã¢â‚¬â€ ' + String(row.ten || 'Ã¢â‚¬â€').slice(0, 100);
      const html = coopBuildEmail(
        'ThÃ¡Â»Âa thuÃ¡ÂºÂ­n Ã„â€˜ÃƒÂ£ quÃƒÂ¡ ngÃƒÂ y hÃ¡ÂºÂ¿t hiÃ¡Â»â€¡u lÃ¡Â»Â±c',
        `NgÃƒÂ y hÃ¡ÂºÂ¿t hiÃ¡Â»â€¡u lÃ¡Â»Â±c Ã„â€˜ÃƒÂ£ qua; trÃ¡ÂºÂ¡ng thÃƒÂ¡i trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng vÃ¡ÂºÂ«n lÃƒÂ  <strong>HiÃ¡Â»â€¡u lÃ¡Â»Â±c / SÃ¡ÂºÂ¯p hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n</strong>. Ã„ÂÃƒÂ¢y lÃƒÂ  email nhÃ¡ÂºÂ¯c <strong>sau hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n</strong> lÃ¡ÂºÂ§n <strong>${nextNum}</strong> trong tÃ¡Â»â€˜i Ã„â€˜a <strong>${postMax}</strong> lÃ¡ÂºÂ§n (cÃƒÂ¡ch nhau ÃƒÂ­t nhÃ¡ÂºÂ¥t <strong>${postMinDays}</strong> ngÃƒÂ y). Vui lÃƒÂ²ng gia hÃ¡ÂºÂ¡n, kÃƒÂ½ lÃ¡ÂºÂ¡i hoÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¢i trÃ¡ÂºÂ¡ng thÃƒÂ¡i thÃƒÂ nh <strong>HÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n</strong>.`,
        [
          ['TÃƒÂªn thÃ¡Â»Âa thuÃ¡ÂºÂ­n', row.ten],
          ['Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c', row.doi_tac],
          ['LoÃ¡ÂºÂ¡i', row.loai],
          ['QuÃ¡Â»â€˜c gia', row.quoc_gia || 'Ã¢â‚¬â€'],
          ['NgÃƒÂ y hÃ¡ÂºÂ¿t hiÃ¡Â»â€¡u lÃ¡Â»Â±c (Ã„â€˜ÃƒÂ£ qua)', coopFmtDateVN(row.het_han)],
          ['TrÃ¡ÂºÂ¡ng thÃƒÂ¡i hiÃ¡Â»â€¡n tÃ¡ÂºÂ¡i', row.trang_thai || 'Ã¢â‚¬â€'],
          ['LÃ¡ÂºÂ§n nhÃ¡ÂºÂ¯c sau hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n', nextNum + ' / ' + postMax]
        ],
        'TrÃƒÂ¢n trÃ¡Â»Âng,<br/>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng Ã¢â‚¬â€ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿',
        link
      );
      const text = `ThÃ¡Â»Âa thuÃ¡ÂºÂ­n Ã„â€˜ÃƒÂ£ quÃƒÂ¡ hÃ¡ÂºÂ¡n (nhÃ¡ÂºÂ¯c ${nextNum}/${postMax})\n${row.ten}\nHÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n: ${coopFmtDateVN(row.het_han)}\n${link}`;

      try {
        await coopSendMail({ to, cc: cc.length ? cc : undefined, subject, html, text });
        db.prepare(`UPDATE cooperation_thoa_thuan SET post_expiry_alert_count=?, last_post_expiry_alert_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(nextNum, row.id);
        sentPost++;
      } catch (e) {
        console.error('[ThoaThuanExpiry] GÃ¡Â»Â­i sau hÃ¡ÂºÂ¡n lÃ¡Â»â€”i id=', row.id, e.message);
      }
      continue;
    }

    // --- TrÃ†Â°Ã¡Â»â€ºc / trong khoÃ¡ÂºÂ£ng N thÃƒÂ¡ng cuÃ¡Â»â€˜i (chÃ†Â°a quÃƒÂ¡ ngÃƒÂ y hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n) ---
    if (row.expiry_alert_sent_at) continue;
    const thr = coopAddCalendarMonths(expDay, -months);
    if (t0 < coopDateAtMidnight(thr) || t0 > expDay) continue;

    const subject = '[HÃ¡Â»Â£p tÃƒÂ¡c QT] CÃ¡ÂºÂ£nh bÃƒÂ¡o: ThÃ¡Â»Âa thuÃ¡ÂºÂ­n sÃ¡ÂºÂ¯p Ã„â€˜Ã¡ÂºÂ¿n hÃ¡ÂºÂ¡n hiÃ¡Â»â€¡u lÃ¡Â»Â±c Ã¢â‚¬â€ ' + String(row.ten || 'Ã¢â‚¬â€').slice(0, 120);
    const html = coopBuildEmail(
      'ThÃ¡Â»Âa thuÃ¡ÂºÂ­n trong khoÃ¡ÂºÂ£ng cÃ¡ÂºÂ£nh bÃƒÂ¡o hÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n',
      `ThÃ¡Â»Âa thuÃ¡ÂºÂ­n sau Ã„â€˜ÃƒÂ¢y Ã„â€˜ang trong khoÃ¡ÂºÂ£ng <strong>${months} thÃƒÂ¡ng</strong> cuÃ¡Â»â€˜i trÃ†Â°Ã¡Â»â€ºc ngÃƒÂ y hÃ¡ÂºÂ¿t hiÃ¡Â»â€¡u lÃ¡Â»Â±c (theo cÃ¡ÂºÂ¥u hÃƒÂ¬nh QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ HÃ¡Â»Â£p tÃƒÂ¡c quÃ¡Â»â€˜c tÃ¡ÂºÂ¿). Vui lÃƒÂ²ng xem xÃƒÂ©t gia hÃ¡ÂºÂ¡n hoÃ¡ÂºÂ·c cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t trÃ¡ÂºÂ¡ng thÃƒÂ¡i trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.`,
      [
        ['TÃƒÂªn thÃ¡Â»Âa thuÃ¡ÂºÂ­n', row.ten],
        ['Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c', row.doi_tac],
        ['LoÃ¡ÂºÂ¡i', row.loai],
        ['QuÃ¡Â»â€˜c gia', row.quoc_gia || 'Ã¢â‚¬â€'],
        ['NgÃƒÂ y hÃ¡ÂºÂ¿t hiÃ¡Â»â€¡u lÃ¡Â»Â±c', coopFmtDateVN(row.het_han)],
        ['TrÃ¡ÂºÂ¡ng thÃƒÂ¡i', row.trang_thai || 'Ã¢â‚¬â€']
      ],
      'TrÃƒÂ¢n trÃ¡Â»Âng,<br/>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng Ã¢â‚¬â€ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿',
      link
    );
    const text = `CÃ¡ÂºÂ£nh bÃƒÂ¡o thÃ¡Â»Âa thuÃ¡ÂºÂ­n sÃ¡ÂºÂ¯p hÃ¡ÂºÂ¿t hiÃ¡Â»â€¡u lÃ¡Â»Â±c\n${row.ten}\nÃ„ÂÃ¡Â»â€˜i tÃƒÂ¡c: ${row.doi_tac}\nHÃ¡ÂºÂ¿t hÃ¡ÂºÂ¡n: ${coopFmtDateVN(row.het_han)}\n${link}`;

    try {
      await coopSendMail({ to, cc: cc.length ? cc : undefined, subject, html, text });
      db.prepare(`UPDATE cooperation_thoa_thuan SET expiry_alert_sent_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(row.id);
      sentPre++;
    } catch (e) {
      console.error('[ThoaThuanExpiry] GÃ¡Â»Â­i lÃ¡Â»â€”i id=', row.id, e.message);
    }
  }
  const sent = sentPre + sentPost;
  if (sent) console.log('[ThoaThuanExpiry] Ã„ÂÃƒÂ£ gÃ¡Â»Â­i', sent, 'email (trÃ†Â°Ã¡Â»â€ºc hÃ¡ÂºÂ¡n:', sentPre, ', sau hÃ¡ÂºÂ¡n:', sentPost, ').');
  return { sent, sent_pre: sentPre, sent_post: sentPost, checked: (rows || []).length };
}

function coopBuildEmail(title, intro, rows, footer, link) {
  const rowsHtml = rows.map(([k,v]) =>
    `<tr><td style="font-weight:600;width:38%;background:#f8fafc;padding:8px 12px;border:1px solid #e2e8f0">${k}</td><td style="padding:8px 12px;border:1px solid #e2e8f0">${(v||'Ã¢â‚¬â€').toString().replace(/\n/g,'<br>')}</td></tr>`
  ).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:660px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#1e40af,#1a6fb5);padding:20px 28px">
      <div style="color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px">ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c Ã¢â‚¬â€ SCI</div>
      <h1 style="color:#fff;margin:0;font-size:17px;font-weight:700">${title}</h1>
    </div>
    <div style="padding:20px 28px">
      <p style="color:#374151;margin-bottom:14px">${intro}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">${rowsHtml}</table>
      ${link ? `<p><a href="${link}" style="display:inline-block;background:#1e40af;color:#fff;padding:9px 18px;border-radius:6px;text-decoration:none;font-weight:600">Xem chi tiÃ¡ÂºÂ¿t &amp; xÃ¡Â»Â­ lÃƒÂ½ Ã¢â€ â€™</a></p>` : ''}
      <p style="color:#6b7280;font-size:13px;margin-top:16px;border-top:1px solid #e5e7eb;padding-top:14px">${footer || 'TrÃƒÂ¢n trÃ¡Â»Âng,<br/>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c'}</p>
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
  console.log('[HNHT] Ã„ÂÃƒÂ£ mount /api/conference-registrations');
} catch (e) {
  console.warn('[HNHT] KhÃƒÂ´ng mount conference-registrations:', e.message);
}

function coopFmtDate(s) {
  if (!s) return 'Ã¢â‚¬â€';
  const d = String(s).slice(0,10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
}

const STATUS_LABELS_COOP = {
  cho_phong_duyet:  'ChÃ¡Â»Â PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh',
  cho_phan_loai:    'ChÃ¡Â»Â PhÃƒÂ²ng KHCN phÃƒÂ¢n loÃ¡ÂºÂ¡i',
  yeu_cau_bo_sung:  'YÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡',
  cho_vt_duyet:     'ChÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t',
  cho_vt_phe_duyet: 'ChÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t',
  da_duyet:         'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t',
  da_phe_duyet:     'Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t',
  tu_choi:          'KhÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t',
  khong_phe_duyet:  'KhÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t',
  hoan_thanh:       'HoÃƒÂ n thÃƒÂ nh',
  ket_thuc_boi_nguoi_nop: 'Ã„ÂÃƒÂ£ kÃ¡ÂºÂ¿t thÃƒÂºc (ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i khÃƒÂ´ng nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i)',
  // legacy
  dang_tham_dinh:   'ChÃ¡Â»Â PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh',
  cho_ky_duyet:     'ChÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t',
  cho_tham_dinh:    'ChÃ¡Â»Â PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh',
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
  if (!s) return 'Ã¢â‚¬â€';
  const d = String(s).slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : String(s).slice(0, 10);
}

function coopDaysLabelDoanRa(ngayDi, ngayVe) {
  try {
    const a = new Date(String(ngayDi).slice(0, 10));
    const b = new Date(String(ngayVe).slice(0, 10));
    const n = Math.round((b - a) / 86400000) + 1;
    if (isNaN(n) || n < 1) return 'Ã¢â‚¬â€';
    return `${n} ngÃƒÂ y`;
  } catch (e) {
    return 'Ã¢â‚¬â€';
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
      const dash = line.match(/^(.+?)\s*[Ã¢â‚¬â€œÃ¢â‚¬â€-]\s*(.+)$/);
      if (dash) {
        ho_ten = dash[1].trim();
        chuc_vu = dash[2].trim();
      }
    }
    const ho = ho_ten || line;
    const cv = chuc_vu || 'ThÃƒÂ nh viÃƒÂªn';
    out.push({
      stt,
      ho_ten: ho,
      chuc_vu: cv,
      hoTen: ho,
      chucVu: cv,
      ho_ten_chuc_vu: cv ? `${ho} Ã¢â‚¬â€ ${cv}` : ho
    });
  }
  if (!out.length) out.push({ stt: '1', ho_ten: 'Ã¢â‚¬â€', chuc_vu: 'Ã¢â‚¬â€', hoTen: 'Ã¢â‚¬â€', chucVu: 'Ã¢â‚¬â€', ho_ten_chuc_vu: 'Ã¢â‚¬â€' });
  return out;
}

/** KhÃƒÂ´ng Ã„â€˜iÃ¡Â»Ân chÃ¡Â»Â¯ kÃƒÂ½ khi tÃƒÂªn chÃ¡Â»â€° lÃƒÂ  tÃƒÂ i khoÃ¡ÂºÂ£n test (trÃƒÂ¡nh Ã¢â‚¬Å“AdminÃ¢â‚¬Â in trÃƒÂªn mÃ¡ÂºÂ«u). */
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || 'Ã¢â‚¬â€';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'Ã¢â‚¬â€' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  let duToanStr = 'Ã¢â‚¬â€';
  if (row.du_toan != null && String(row.du_toan).trim() !== '') {
    const s = String(row.du_toan).trim();
    duToanStr = /(usd|vnd|vnÃ„â€˜|Ã„â€˜Ã¡Â»â€œng|\bÃ„â€˜\b)/i.test(s) ? s : `${s} VND`;
  }
  const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'Ã¢â‚¬â€';
  const ma = row.ma_de_xuat || coopGenMa('doan_ra', row.id);
  const tieuDeToTrinh = (row.muc_dich || '').trim() || 'TÃ¡Â»Â trÃƒÂ¬nh v/v Ã„â€˜oÃƒÂ n cÃƒÂ´ng tÃƒÂ¡c nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i';
  const tpHcmNgay = 'TP. HÃ¡Â»â€œ ChÃƒÂ­ Minh, ngÃƒÂ y ' + ngayPheDuyet;
  const thanhVienList = coopParseThanhVienDoanRa(row.thanh_vien);
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    quoc_gia: row.quoc_gia || 'Ã¢â‚¬â€',
    muc_dich: row.muc_dich || 'Ã¢â‚¬â€',
    ngay_di: coopFmtDateVN(row.ngay_di),
    ngay_ve: coopFmtDateVN(row.ngay_ve),
    tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_di, row.ngay_ve),
    nguon_kinh_phi: row.nguon_kinh_phi || 'Ã¢â‚¬â€',
    du_toan: duToanStr,
    du_toan_vnd: duToanStr,
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'Ã„ÂÃƒÆ’ PHÃƒÅ  DUYÃ¡Â»â€ T' : (STATUS_LABELS_COOP[row.status] || row.status || 'Ã¢â‚¬â€'),
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
    nguoi_nhan_to_trinh: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c',
    can_cu_trinh_bay: 'Theo quy Ã„â€˜Ã¡Â»â€¹nh cÃ¡Â»Â§a ViÃ¡Â»â€¡n vÃƒÂ  Quy chÃ¡ÂºÂ¿ quÃ¡ÂºÂ£n lÃƒÂ½ KHCN-Ã„ÂMST, tÃƒÂ´i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t vÃƒÂ  phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nhÃ†Â° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    so_ngay: core.tong_thoi_gian,
    du_toan_usd: duToanStr,
    danh_sach_thanh_vien: (row.thanh_vien || '').trim() ? String(row.thanh_vien).trim() : 'Ã¢â‚¬â€',
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'Ã¢â‚¬â€'
  });
}

const CAN_CU_DOAN_RA_DAY_DU = 'Theo quy Ã„â€˜Ã¡Â»â€¹nh cÃ¡Â»Â§a ViÃ¡Â»â€¡n vÃƒÂ  Quy chÃ¡ÂºÂ¿ quÃ¡ÂºÂ£n lÃƒÂ½ KHCN-Ã„ÂMST, tÃƒÂ´i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t vÃƒÂ  phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nhÃ†Â° sau:';

/**
 * MÃ¡Â»â„¢t sÃ¡Â»â€˜ mÃ¡ÂºÂ«u .docx vÃ¡ÂºÂ«n gÃƒÂµ sÃ¡ÂºÂµn chÃ¡Â»Â¯ (khÃƒÂ´ng chÃ¡Â»â€° placeholder) Ã¢â‚¬â€ docxtemplater khÃƒÂ´ng ghi Ã„â€˜ÃƒÂ¨.
 * HÃ¡ÂºÂ­u xÃ¡Â»Â­ lÃƒÂ½ XML trong file Ã„â€˜ÃƒÂ£ merge Ã„â€˜Ã¡Â»Æ’ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ lÃ¡Â»Âi kÃƒÂ­nh gÃ¡Â»Â­i, cÃ„Æ’n cÃ¡Â»Â©, vÃƒÂ  bÃ¡Â»Â chÃ¡Â»Â¯ kÃƒÂ½ "Admin" test.
 */
function coopPostProcessDoanRaDocxBuffer(buf) {
  try {
    const zip = new PizZip(buf);
    const rePath = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;
    for (const p of Object.keys(zip.files)) {
      if (!rePath.test(p) || zip.files[p].dir) continue;
      let xml = zip.file(p).asText();
      if (!xml) continue;
      xml = xml.replace(/Ban GiÃƒÂ¡m hiÃ¡Â»â€¡u\s*\/\s*/g, '');
      xml = xml.replace(
        /<w:t([^>]*)>(Theo quy Ã„â€˜Ã¡Â»â€¹nh cÃ¡Â»Â§a ViÃ¡Â»â€¡n vÃƒÂ  Quy chÃ¡ÂºÂ¿ quÃ¡ÂºÂ£n lÃƒÂ½ KHCN-Ã„ÂMST\.)<\/w:t>/g,
        (m, attrs) => {
          if (m.includes('tÃƒÂ´i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹')) return m;
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
    throw new Error('ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (menu trong chi tiÃ¡ÂºÂ¿t Ã„ÂoÃƒÂ n ra).');
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
 * Sinh file Word tÃ¡Â»Â« mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂoÃƒÂ n ra (mÃ¡Â»â„¢t file .docx chung cho loÃ¡ÂºÂ¡i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nÃƒÂ y) vÃƒÂ  ghi vÃƒÂ o van_ban_word_*.
 * DÃƒÂ¹ng sau khi phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Æ’ ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i khÃƒÂ´ng phÃ¡ÂºÂ£i chÃ¡Â»Â Admin.
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
    return { ok: false, skipped: 'error', message: 'Ã„ÂÃƒÂ£ xÃ¡ÂºÂ£y ra lÃ¡Â»â€”i. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' };
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || 'Ã¢â‚¬â€';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'Ã¢â‚¬â€' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const kinhPhiStr = (row.kinh_phi_nguon != null && String(row.kinh_phi_nguon).trim()) ? String(row.kinh_phi_nguon).trim() : 'Ã¢â‚¬â€';
  const ma = row.ma_de_xuat || coopGenMa('doan_vao', row.id);
  const tieuDeToTrinh = (row.muc_dich || '').trim() || 'TÃ¡Â»Â trÃƒÂ¬nh v/v tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n Ã„â€˜oÃƒÂ n khÃƒÂ¡ch quÃ¡Â»â€˜c tÃ¡ÂºÂ¿';
  const tpHcmNgay = 'TP. HÃ¡Â»â€œ ChÃƒÂ­ Minh, ngÃƒÂ y ' + ngayPheDuyet;
  const noiParts = [row.noi_dung_lam_viec, row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'Ã¢â‚¬â€';
  const thanhVienParsed = coopParseThanhVienDoanRa(row.thanh_phan_doan);
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    quoc_gia: row.don_vi_de_xuat || 'Ã¢â‚¬â€',
    don_vi_de_xuat: row.don_vi_de_xuat || 'Ã¢â‚¬â€',
    muc_dich: row.muc_dich || 'Ã¢â‚¬â€',
    ngay_den: coopFmtDateVN(row.ngay_den),
    ngay_roi_di: coopFmtDateVN(row.ngay_roi_di),
    ngay_di: coopFmtDateVN(row.ngay_den),
    ngay_ve: coopFmtDateVN(row.ngay_roi_di),
    tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_den, row.ngay_roi_di),
    nguon_kinh_phi: kinhPhiStr,
    du_toan: kinhPhiStr,
    du_toan_vnd: kinhPhiStr,
    ho_tro_visa: row.ho_tro_visa || 'Ã¢â‚¬â€',
    noi_dung_lam_viec: row.noi_dung_lam_viec || 'Ã¢â‚¬â€',
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'Ã„ÂÃƒÆ’ PHÃƒÅ  DUYÃ¡Â»â€ T' : (STATUS_LABELS_COOP[row.status] || row.status || 'Ã¢â‚¬â€'),
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
    nguoi_nhan_to_trinh: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c',
    can_cu_trinh_bay: 'Theo quy Ã„â€˜Ã¡Â»â€¹nh cÃ¡Â»Â§a ViÃ¡Â»â€¡n vÃƒÂ  Quy chÃ¡ÂºÂ¿ quÃ¡ÂºÂ£n lÃƒÂ½ KHCN-Ã„ÂMST, tÃƒÂ´i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t vÃƒÂ  phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n Ã„â€˜oÃƒÂ n khÃƒÂ¡ch/quÃ¡Â»â€˜c tÃ¡ÂºÂ¿ nhÃ†Â° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    so_ngay: core.tong_thoi_gian,
    du_toan_usd: kinhPhiStr,
    danh_sach_thanh_vien: (row.thanh_phan_doan || '').trim() ? String(row.thanh_phan_doan).trim() : 'Ã¢â‚¬â€',
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'Ã¢â‚¬â€'
  });
}

function coopMergeDoanVaoDocx(row) {
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂoÃƒÂ n vÃƒÂ o (menu trong chi tiÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t).');
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
    return { ok: false, skipped: 'error', message: 'Ã„ÂÃƒÂ£ xÃ¡ÂºÂ£y ra lÃ¡Â»â€”i. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' };
  }
}

/** BÃ¡ÂºÂ£n merge tÃ¡Â»Â± sinh cÃƒÂ³ Ã„â€˜Ã†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n chÃ¡Â»Â©a `_to_trinh_`. File admin tÃ¡ÂºÂ£i tay thay thÃ¡ÂºÂ¿ khÃƒÂ´ng cÃƒÂ³ Ã¢â‚¬â€ khÃƒÂ´ng tÃ¡Â»Â± ghÃƒÂ©p Ã„â€˜ÃƒÂ¨. */
function coopVanBanIsAutoMergedOutput(relPath) {
  return !!(relPath && String(relPath).includes('_to_trinh_'));
}

/**
 * Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t: sinh lÃ¡ÂºÂ§n Ã„â€˜Ã¡ÂºÂ§u nÃ¡ÂºÂ¿u chÃ†Â°a cÃƒÂ³ file.
 * NÃ¡ÂºÂ¿u Ã„â€˜ÃƒÂ£ cÃƒÂ³ bÃ¡ÂºÂ£n tÃ¡Â»Â± sinh vÃƒÂ  mÃ¡ÂºÂ«u `to-trinh-template.docx` mÃ¡Â»â€ºi hÃ†Â¡n file merge Ã¢â€ â€™ ghÃƒÂ©p lÃ¡ÂºÂ¡i (Ã„â€˜Ã¡Â»â€¢i mÃ¡ÂºÂ«u [1] khÃƒÂ´ng cÃ¡ÂºÂ§n bÃ¡ÂºÂ¥m Sinh lÃ¡ÂºÂ¡i thÃ¡Â»Â§ cÃƒÂ´ng).
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || 'Ã¢â‚¬â€';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'Ã¢â‚¬â€' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const ma = row.ma_de_xuat || coopGenMa('mou', row.id);
  const loaiTT = (row.loai_thoa_thuan || '').trim();
  const tenDt = (row.ten_doi_tac || '').trim();
  const tieuDeToTrinh = [loaiTT, tenDt].filter(Boolean).join(' Ã¢â‚¬â€ ') || 'TÃ¡Â»Â trÃƒÂ¬nh v/v Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n hÃ¡Â»Â£p tÃƒÂ¡c';
  const tpHcmNgay = 'TP. HÃ¡Â»â€œ ChÃƒÂ­ Minh, ngÃƒÂ y ' + ngayPheDuyet;
  const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'Ã¢â‚¬â€';
  const thoiHanStr = (row.thoi_han_nam != null && String(row.thoi_han_nam).trim() !== '') ? String(row.thoi_han_nam).trim() : 'Ã¢â‚¬â€';
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    loai_thoa_thuan: row.loai_thoa_thuan || 'Ã¢â‚¬â€',
    ten_doi_tac: row.ten_doi_tac || 'Ã¢â‚¬â€',
    quoc_gia: row.quoc_gia || 'Ã¢â‚¬â€',
    thoi_han_nam: thoiHanStr,
    gia_tri_tai_chinh: row.gia_tri_tai_chinh || 'Ã¢â‚¬â€',
    don_vi_de_xuat: row.don_vi_de_xuat || 'Ã¢â‚¬â€',
    noi_dung_hop_tac: row.noi_dung_hop_tac || 'Ã¢â‚¬â€',
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'Ã„ÂÃƒÆ’ PHÃƒÅ  DUYÃ¡Â»â€ T' : (STATUS_LABELS_COOP[row.status] || row.status || 'Ã¢â‚¬â€'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay
  };
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    nguoi_nhan_to_trinh: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c',
    can_cu_trinh_bay: 'Theo quy Ã„â€˜Ã¡Â»â€¹nh cÃ¡Â»Â§a ViÃ¡Â»â€¡n vÃƒÂ  Quy chÃ¡ÂºÂ¿ quÃ¡ÂºÂ£n lÃƒÂ½ KHCN-Ã„ÂMST, tÃƒÂ´i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t vÃƒÂ  phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t kÃƒÂ½ kÃ¡ÂºÂ¿t thÃ¡Â»Âa thuÃ¡ÂºÂ­n hÃ¡Â»Â£p tÃƒÂ¡c nhÃ†Â° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: nguoiPheDuyetKy,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'Ã¢â‚¬â€'
  });
}

function coopMergeMouDocx(row) {
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh ThÃ¡Â»Âa thuÃ¡ÂºÂ­n/MOU (menu trong chi tiÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t).');
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
    return { ok: false, skipped: 'error', message: 'Ã„ÂÃƒÂ£ xÃ¡ÂºÂ£y ra lÃ¡Â»â€”i. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' };
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
  const nguoiPheDuyetBang = nguoiPheDuyetKy || nguoiPheDuyetRaw || 'Ã¢â‚¬â€';
  const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
  const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
  const ngayPheDuyet = coopFmtDateVN(approvalDate) !== 'Ã¢â‚¬â€' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
  const ma = row.ma_de_xuat || coopGenMa('ytnn', row.id);
  const tenDeTai = (row.ten || '').trim();
  const tenDt = (row.doi_tac_ten || '').trim();
  // MÃ¡ÂºÂ«u thÃ†Â°Ã¡Â»Âng gÃƒÂµ "V/v {tieu_de_to_trinh}" Ã¢â‚¬â€ khÃƒÂ´ng lÃ¡ÂºÂ·p chÃ¡Â»Â¯ "TÃ¡Â»Â trÃƒÂ¬nh v/v" trong giÃƒÂ¡ trÃ¡Â»â€¹
  const tieuDeToTrinh = tenDeTai
    ? ('Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜Ã¡Â»Â tÃƒÂ i YTNN Ã¢â‚¬â€ ' + tenDeTai)
    : 'Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃƒÂ³ yÃ¡ÂºÂ¿u tÃ¡Â»â€˜ nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i';
  const tpHcmNgay = 'TP. HÃ¡Â»â€œ ChÃƒÂ­ Minh, ngÃƒÂ y ' + ngayPheDuyet;
  const noiParts = [row.mo_ta, row.ghi_chu_noi_bo, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
  const noiDung = noiParts.length ? noiParts.join('\n') : 'Ã¢â‚¬â€';
  const moTaGoc = (row.mo_ta && String(row.mo_ta).trim()) ? String(row.mo_ta).trim() : '';
  const moTaMotDong = moTaGoc ? moTaGoc.replace(/\s+/g, ' ') : 'Ã¢â‚¬â€';
  const donViTien = ((row.don_vi_tien_te != null && String(row.don_vi_tien_te).trim()) ? String(row.don_vi_tien_te).trim() : 'VNÃ„Â');
  let kinhPhiSo = 'Ã¢â‚¬â€';
  if (row.kinh_phi != null && String(row.kinh_phi).trim() !== '') {
    const n = Number(row.kinh_phi);
    kinhPhiSo = Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : String(row.kinh_phi).trim();
  }
  let kinhPhiStr = 'Ã¢â‚¬â€';
  if (kinhPhiSo !== 'Ã¢â‚¬â€') kinhPhiStr = `${kinhPhiSo} ${donViTien}`;
  const qgDt = row.doi_tac_quoc_gia || 'Ã¢â‚¬â€';
  const core = {
    ma_so: ma,
    ngay_to_trinh: coopFmtDateVN(row.created_at),
    ten_de_tai: tenDeTai || 'Ã¢â‚¬â€',
    ten_doi_tac: tenDt || 'Ã¢â‚¬â€',
    ten_to_chuc_doi_tac: tenDt || 'Ã¢â‚¬â€',
    quoc_gia: qgDt,
    quoc_gia_doi_tac: qgDt,
    nguoi_dai_dien_doi_tac: (row.doi_tac_nguoi_dai_dien && String(row.doi_tac_nguoi_dai_dien).trim()) ? String(row.doi_tac_nguoi_dai_dien).trim() : 'Ã¢â‚¬â€',
    website_doi_tac: (row.doi_tac_website && String(row.doi_tac_website).trim()) ? String(row.doi_tac_website).trim() : 'Ã¢â‚¬â€',
    loai_hinh: row.loai_hinh || 'Ã¢â‚¬â€',
    hinh_thuc_hop_tac: row.hinh_thuc_hop_tac || 'Ã¢â‚¬â€',
    chu_nhiem: row.chu_nhiem_ten || 'Ã¢â‚¬â€',
    chu_nhiem_de_tai: row.chu_nhiem_ten || 'Ã¢â‚¬â€',
    chu_nhiem_hoc_vi: row.chu_nhiem_hoc_vi || 'Ã¢â‚¬â€',
    hoc_ham_hoc_vi: row.chu_nhiem_hoc_vi || 'Ã¢â‚¬â€',
    chu_nhiem_don_vi: row.chu_nhiem_don_vi || 'Ã¢â‚¬â€',
    don_vi_chu_nhiem: row.chu_nhiem_don_vi || 'Ã¢â‚¬â€',
    kinh_phi: kinhPhiSo,
    don_vi_tien_te: donViTien,
    ngay_bat_dau: coopFmtDateVN(row.ngay_bat_dau),
    ngay_ket_thuc: coopFmtDateVN(row.ngay_ket_thuc),
    thoi_gian_thang: row.thoi_gian_thang != null && String(row.thoi_gian_thang).trim() !== '' ? String(row.thoi_gian_thang).trim() : 'Ã¢â‚¬â€',
    mo_ta: moTaMotDong,
    mo_ta_de_tai: moTaGoc || 'Ã¢â‚¬â€',
    noi_dung_hop_tac: moTaGoc || 'Ã¢â‚¬â€',
    gia_tri_tai_chinh: kinhPhiStr,
    noi_dung_bo_sung: noiDung,
    trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'Ã„ÂÃƒÆ’ PHÃƒÅ  DUYÃ¡Â»â€ T' : (STATUS_LABELS_COOP[row.status] || row.status || 'Ã¢â‚¬â€'),
    ngay_phe_duyet: ngayPheDuyet,
    nguoi_phe_duyet: nguoiPheDuyetBang,
    nguoi_de_xuat: nguoiDeXuatKy,
    tp_hcm_ngay: tpHcmNgay
  };
  const tenVtHienThi = nguoiPheDuyetKy || nguoiPheDuyetRaw || 'Ã¢â‚¬â€';
  return Object.assign({}, core, {
    ma_de_xuat: ma,
    ngay_lap: core.ngay_to_trinh,
    tieu_de_to_trinh: tieuDeToTrinh,
    loai_thoa_thuan: core.loai_hinh,
    thoi_han_nam: core.thoi_gian_thang,
    don_vi_de_xuat: core.chu_nhiem_don_vi,
    nguoi_nhan_to_trinh: 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c',
    can_cu_trinh_bay: 'Theo quy Ã„â€˜Ã¡Â»â€¹nh cÃ¡Â»Â§a ViÃ¡Â»â€¡n vÃƒÂ  Quy chÃ¡ÂºÂ¿ quÃ¡ÂºÂ£n lÃƒÂ½ KHCN-Ã„ÂMST, tÃƒÂ´i Ã„â€˜Ã¡Â»Â nghÃ¡Â»â€¹ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t vÃƒÂ  phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃƒÂ³ yÃ¡ÂºÂ¿u tÃ¡Â»â€˜ nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i nhÃ†Â° sau:',
    quoc_gia_dia_diem: core.quoc_gia,
    ghi_chu: noiDung,
    ngay_duyet: ngayPheDuyet,
    ten_vien_truong: tenVtHienThi,
    thanh_pho_ngay: tpHcmNgay,
    chuc_vu_de_xuat: 'Ã¢â‚¬â€'
  });
}

function coopMergeYtnnDocx(row) {
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) {
    throw new Error('ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN (menu trong chi tiÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t).');
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
    return { ok: false, skipped: 'error', message: 'Ã„ÂÃƒÂ£ xÃ¡ÂºÂ£y ra lÃ¡Â»â€”i. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i sau.' };
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

// Middleware phÃƒÂ¢n quyÃ¡Â»Ân mÃ¡Â»â€ºi
function coopPhongOrAdmin(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) return next();
  return res.status(403).json({ message: 'ChÃ¡Â»â€° PhÃƒÂ²ng KHCN hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y.' });
}
function coopVTOrAdmin(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  if (role === 'admin') return next();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  if (coopIsVienTruong(email)) return next();
  return res.status(403).json({ message: 'ChÃ¡Â»â€° ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng hoÃ¡ÂºÂ·c Admin mÃ¡Â»â€ºi cÃƒÂ³ quyÃ¡Â»Ân nÃƒÂ y.' });
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

/** ChÃ¡Â»â€° QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ viÃ¡Â»â€¡n, PhÃƒÂ²ng KHCN, ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã¢â‚¬â€ Dashboard tÃ¡Â»â€¢ng thÃ¡Â»Æ’ khÃƒÂ´ng dÃƒÂ nh cho user thÃ†Â°Ã¡Â»Âng */
function coopDashboardViewer(req, res, next) {
  const role = (req.user && req.user.role || '').toLowerCase();
  const email = (req.user && req.user.email || '').trim().toLowerCase();
  if (role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email)) return next();
  return res.status(403).json({ message: 'ChÃ¡Â»â€° QuÃ¡ÂºÂ£n trÃ¡Â»â€¹ viÃ¡Â»â€¡n, PhÃƒÂ²ng KHCN hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng mÃ¡Â»â€ºi xem Ã„â€˜Ã†Â°Ã¡Â»Â£c Dashboard.' });
}

// Badge sidebar Ã¢â‚¬â€ mÃ¡Â»Âi user Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p (khÃƒÂ´ng lÃ¡Â»â„¢ thÃ¡Â»â€˜ng kÃƒÂª hÃ¡Â»â€¡ thÃ¡Â»â€˜ng)
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
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ DASHBOARD STATS (giÃƒÂ¡m sÃƒÂ¡t toÃƒÂ n hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã¢â‚¬â€ chÃ¡Â»â€° lÃƒÂ£nh Ã„â€˜Ã¡ÂºÂ¡o / P.KHCN)
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
    return res.status(500).json({ message: 'KhÃƒÂ´ng tÃ¡ÂºÂ£i Ã„â€˜Ã†Â°Ã¡Â»Â£c Dashboard.' });
  }
});

// HTQT dashboard (EJS) Ã¢â‚¬â€ /ytnn/dashboard, /ytnn/api/dashboard/*
try {
  const createYtnnRouter = require('./routes/ytnn');
  app.use('/ytnn', authMiddleware, createYtnnRouter({ db, coopDashboardViewer }));
} catch (e) {
  console.warn('[ytnn] KhÃƒÂ´ng mount router /ytnn:', e.message);
}
app.use('/api/bao-cao-phong', authMiddleware, require('./routes/baoCaoPhong')({ db, uploadsRoot: appPaths.uploadsRoot(), baseUrl: process.env.BASE_URL || '', nhacTuDong: true, mailSend: (o) => (transporter ? transporter.sendMail({ from: getSmtpFrom(), ...o }) : Promise.reject(new Error('mail_not_configured'))) })); // BÃƒÂ¡o cÃƒÂ¡o phÃƒÂ²ng ban: xem routes/baoCaoPhong.js
app.use('/api/mysign', authMiddleware, require('./routes/mysign')({ db, uploadsRoot: appPaths.uploadsRoot() })); // KÃƒÂ½ sÃ¡Â»â€˜ MySign dÃƒÂ¹ng chung: xem services/mysign/

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ CHÃ¡Â»Å“ PHÃƒâ€™NG KHCN XÃ¡Â»Â¬ LÃƒÂ
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
            submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'Ã¢â‚¬â€',
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
          title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ HN/HT Ã¢â‚¬â€ ' + (r.conf_name || 'Ã¢â‚¬â€'),
          status: r.status,
          status_label:
            r.status === 'khcn_reviewing' ? 'PhÃƒÂ²ng Ã„â€˜ang xem xÃƒÂ©t' : 'ChÃ¡Â»Â PhÃƒÂ²ng KHCN',
          submitted_by_name: r.uname || r.uemail || 'Ã¢â‚¬â€',
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
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ CHÃ¡Â»Å“ VIÃ¡Â»â€ N TRÃ†Â¯Ã¡Â»Å¾NG DUYÃ¡Â»â€ T
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
            submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'Ã¢â‚¬â€',
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
          title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ HN/HT Ã¢â‚¬â€ ' + (r.conf_name || 'Ã¢â‚¬â€'),
          status: r.status,
          status_label: r.status === 'director_reviewing' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ang xem xÃƒÂ©t' : 'ChÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng',
          submitted_by_name: r.uname || r.uemail || 'Ã¢â‚¬â€',
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
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ TÃ¡ÂºÂ¤T CÃ¡ÂºÂ¢ Ã„ÂÃ¡Â»â‚¬ XUÃ¡ÂºÂ¤T (manager)
// ============================================================
app.get('/api/cooperation/tat-ca-de-xuat', authMiddleware, (req, res) => {
  if (!coopIsManager(req)) return res.status(403).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân.' });
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
      // `status` nhÃ¡ÂºÂ­n 1 giÃƒÂ¡ trÃ¡Â»â€¹ hoÃ¡ÂºÂ·c danh sÃƒÂ¡ch ngÃ„Æ’n bÃ¡ÂºÂ±ng dÃ¡ÂºÂ¥u phÃ¡ÂºÂ©y Ã¢â‚¬â€ cÃƒÂ¡c ÃƒÂ´ trÃƒÂªn
      // Dashboard gÃ¡Â»â„¢p nhiÃ¡Â»Âu trÃ¡ÂºÂ¡ng thÃƒÂ¡i (vd "Ã„Âang xÃ¡Â»Â­ lÃƒÂ½") nÃƒÂªn cÃ¡ÂºÂ§n lÃ¡Â»Âc theo nhÃƒÂ³m.
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
        submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'Ã¢â‚¬â€',
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
          title: 'Ã„ÂÃ„Æ’ng kÃƒÂ½ HN/HT Ã¢â‚¬â€ ' + (r.conf_name || 'Ã¢â‚¬â€'),
          status: r.status,
          status_label: r.status,
          submitted_by_name: r.submitted_by_name || r.submitted_by_email || 'Ã¢â‚¬â€',
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
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ CHI TIÃ¡ÂºÂ¾T + LÃ¡Â»Å CH SÃ¡Â»Â¬
// ============================================================
app.get('/api/cooperation/chi-tiet/:loai/:id', authMiddleware, (req, res) => {
  const loai = req.params.loai;
  const id = parseInt(req.params.id, 10);
  const userEmail = (req.user.email || '').trim().toLowerCase();
  const isManager = coopIsManager(req);
  const tableMap = { doan_ra:'cooperation_doan_ra', doan_vao:'cooperation_doan_vao', mou:'cooperation_mou_de_xuat', ytnn:'htqt_de_xuat' };
  const table = tableMap[loai];
  if (!table || !id) return res.status(400).json({ message: 'LoÃ¡ÂºÂ¡i hoÃ¡ÂºÂ·c ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  try {
    let r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!r) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
    if (!isManager && (r.submitted_by_email||'').trim().toLowerCase() !== userEmail) {
      return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân xem Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t nÃƒÂ y.' });
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
  } catch(e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

// ============================================================
// Ã„ÂOÃƒâ‚¬N RA Ã¢â‚¬â€ VÃ„Æ’n bÃ¡ÂºÂ£n Word kÃƒÂ½ bÃ¡ÂºÂ£n cÃ¡Â»Â©ng (Admin upload; NCV / PhÃƒÂ²ng / VT tÃ¡ÂºÂ£i)
// ============================================================
app.post('/api/admin/cooperation/doan-ra/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° upload vÃ„Æ’n bÃ¡ÂºÂ£n Word sau khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  uploadHtqtDoanRa.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .doc hoÃ¡ÂºÂ·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkDoanRaVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u vÃ„Æ’n bÃ¡ÂºÂ£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/doan-ra/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
  coopUnlinkDoanRaVanBanFile(row);
  db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a file vÃ„Æ’n bÃ¡ÂºÂ£n.' });
});

app.get('/api/cooperation/doan-ra/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  let row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° tÃ¡ÂºÂ£i Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!coopCanDownloadDoanRaVanBan(req, row)) {
    return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân tÃ¡ÂºÂ£i file nÃƒÂ y.' });
  }
  row = coopEnsureFreshDoanRaVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ vÃ„Æ’n bÃ¡ÂºÂ£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-doan-ra'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'Ã„ÂÃ†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃƒÂ´ng cÃƒÂ²n trÃƒÂªn mÃƒÂ¡y chÃ¡Â»Â§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-doan-ra.docx');
});

app.post('/api/admin/cooperation/doan-ra/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplate.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .docx (mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂoÃƒÂ n ra, cÃƒÂ³ placeholder {ma_so}, {quoc_gia}, Ã¢â‚¬Â¦).' });
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂoÃƒÂ n ra (.docx).' });
  });
});

app.get('/api/admin/cooperation/doan-ra/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  const gen = coopTryAutoGenerateDoanRaVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (menu trong chi tiÃ¡ÂºÂ¿t Ã„ÂoÃƒÂ n ra).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] doan_ra', gen.message);
    return res.status(400).json({ message: gen.message || 'LÃ¡Â»â€”i khi ghÃƒÂ©p Word.' });
  }
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ sinh file Word tÃ¡Â»Â« mÃ¡ÂºÂ«u vÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// Ã„ÂOÃƒâ‚¬N VÃƒâ‚¬O Ã¢â‚¬â€ VÃ„Æ’n bÃ¡ÂºÂ£n Word / mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (mirror Ã„ÂoÃƒÂ n ra)
// ============================================================
app.post('/api/admin/cooperation/doan-vao/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° upload vÃ„Æ’n bÃ¡ÂºÂ£n Word sau khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  uploadHtqtDoanVao.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .doc hoÃ¡ÂºÂ·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkDoanVaoVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u vÃ„Æ’n bÃ¡ÂºÂ£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/doan-vao/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
  coopUnlinkDoanVaoVanBanFile(row);
  db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a file vÃ„Æ’n bÃ¡ÂºÂ£n.' });
});

app.get('/api/cooperation/doan-vao/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  let row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° tÃ¡ÂºÂ£i Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!coopCanDownloadDoanVaoVanBan(req, row)) {
    return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân tÃ¡ÂºÂ£i file nÃƒÂ y.' });
  }
  row = coopEnsureFreshDoanVaoVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ vÃ„Æ’n bÃ¡ÂºÂ£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-doan-vao'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'Ã„ÂÃ†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃƒÂ´ng cÃƒÂ²n trÃƒÂªn mÃƒÂ¡y chÃ¡Â»Â§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-doan-vao.docx');
});

app.post('/api/admin/cooperation/doan-vao/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateDoanVao.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .docx (mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂoÃƒÂ n vÃƒÂ o, cÃƒÂ³ placeholder {ma_so}, {don_vi_de_xuat}, Ã¢â‚¬Â¦).' });
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂoÃƒÂ n vÃƒÂ o (.docx).' });
  });
});

app.get('/api/admin/cooperation/doan-vao/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  const gen = coopTryAutoGenerateDoanVaoVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (menu trong chi tiÃ¡ÂºÂ¿t Ã„ÂoÃƒÂ n vÃƒÂ o).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] doan_vao', gen.message);
    return res.status(400).json({ message: gen.message || 'LÃ¡Â»â€”i khi ghÃƒÂ©p Word.' });
  }
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ sinh file Word tÃ¡Â»Â« mÃ¡ÂºÂ«u vÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// THÃ¡Â»Å½A THUÃ¡ÂºÂ¬N / MOU Ã¢â‚¬â€ VÃ„Æ’n bÃ¡ÂºÂ£n Word / mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (mirror Ã„ÂoÃƒÂ n ra & Ã„ÂoÃƒÂ n vÃƒÂ o)
// ============================================================
app.post('/api/admin/cooperation/mou/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° upload vÃ„Æ’n bÃ¡ÂºÂ£n Word sau khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  uploadHtqtMou.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .doc hoÃ¡ÂºÂ·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkMouVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u vÃ„Æ’n bÃ¡ÂºÂ£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/mou/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
  coopUnlinkMouVanBanFile(row);
  db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a file vÃ„Æ’n bÃ¡ÂºÂ£n.' });
});

app.get('/api/cooperation/mou/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  let row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° tÃ¡ÂºÂ£i Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!coopCanDownloadMouVanBan(req, row)) {
    return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân tÃ¡ÂºÂ£i file nÃƒÂ y.' });
  }
  row = coopEnsureFreshMouVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ vÃ„Æ’n bÃ¡ÂºÂ£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-mou'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'Ã„ÂÃ†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃƒÂ´ng cÃƒÂ²n trÃƒÂªn mÃƒÂ¡y chÃ¡Â»Â§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-mou.docx');
});

app.post('/api/admin/cooperation/mou/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateMou.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .docx (mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh ThÃ¡Â»Âa thuÃ¡ÂºÂ­n/MOU, cÃƒÂ³ placeholder {ma_so}, {ten_doi_tac}, Ã¢â‚¬Â¦).' });
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n (.docx).' });
  });
});

app.get('/api/admin/cooperation/mou/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  const gen = coopTryAutoGenerateMouVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (menu trong chi tiÃ¡ÂºÂ¿t Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] mou', gen.message);
    return res.status(400).json({ message: gen.message || 'LÃ¡Â»â€”i khi ghÃƒÂ©p Word.' });
  }
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ sinh file Word tÃ¡Â»Â« mÃ¡ÂºÂ«u vÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// Ã„ÂÃ¡Â»â‚¬ TÃƒâ‚¬I YTNN Ã¢â‚¬â€ VÃ„Æ’n bÃ¡ÂºÂ£n Word / mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (mirror MOU)
// ============================================================
app.post('/api/admin/cooperation/ytnn/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° upload vÃ„Æ’n bÃ¡ÂºÂ£n Word sau khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  uploadHtqtYtnn.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .doc hoÃ¡ÂºÂ·c .docx.' });
    const rel = storedUploadsPathForDatabase(req.file.path);
    coopUnlinkYtnnVanBanFile(row);
    const orig = (req.file.originalname || 'van-ban.docx').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
      .run(rel, orig, id);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u vÃ„Æ’n bÃ¡ÂºÂ£n Word.', van_ban_word_original_name: orig });
  });
});

app.delete('/api/admin/cooperation/ytnn/:id/van-ban-word', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
  coopUnlinkYtnnVanBanFile(row);
  db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=NULL, van_ban_word_original_name=NULL, van_ban_word_uploaded_at=NULL, updated_at=datetime('now','localtime') WHERE id=?`).run(id);
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a file vÃ„Æ’n bÃ¡ÂºÂ£n.' });
});

app.get('/api/cooperation/ytnn/:id/van-ban-word', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  let row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° tÃ¡ÂºÂ£i Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!coopCanDownloadYtnnVanBan(req, row)) {
    return res.status(403).json({ message: 'BÃ¡ÂºÂ¡n khÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân tÃ¡ÂºÂ£i file nÃƒÂ y.' });
  }
  row = coopEnsureFreshYtnnVanBan(id);
  if (!row || !row.van_ban_word_path) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ vÃ„Æ’n bÃ¡ÂºÂ£n Word.' });
  const abs = resolveStoredFileFromDb(row.van_ban_word_path);
  const baseDir = path.resolve(path.join(uploadDir, 'htqt-ytnn'));
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs)) {
    return res.status(400).json({ message: 'Ã„ÂÃ†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n file khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ message: 'File khÃƒÂ´ng cÃƒÂ²n trÃƒÂªn mÃƒÂ¡y chÃ¡Â»Â§.' });
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.download(abs, row.van_ban_word_original_name || 'van-ban-ytnn.docx');
});

app.post('/api/admin/cooperation/ytnn/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  uploadToTrinhTemplateYtnn.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'LÃ¡Â»â€”i upload' });
    if (!req.file) return res.status(400).json({ message: 'ChÃ¡Â»Ân file .docx (mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh YTNN: {ma_so}, {ten_de_tai}, {mo_ta_de_tai}, {ten_to_chuc_doi_tac}, {quoc_gia_doi_tac}, {chu_nhiem_de_tai}, {hoc_ham_hoc_vi}, {don_vi_chu_nhiem}, {kinh_phi}, {don_vi_tien_te}, {tieu_de_to_trinh}, {nguoi_phe_duyet}, Ã¢â‚¬Â¦).' });
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN (.docx).' });
  });
});

app.get('/api/admin/cooperation/ytnn/to-trinh-template', authMiddleware, adminOnly, (req, res) => {
  if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) return res.status(404).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u.' });
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
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡.' });
  const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.' });
  if ((row.status || '').toLowerCase() !== 'da_duyet') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  const gen = coopTryAutoGenerateYtnnVanBan(id);
  if (gen.skipped === 'no_template') {
    return res.status(400).json({ message: 'ChÃ†Â°a cÃƒÂ³ file mÃ¡ÂºÂ«u .docx. Admin vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃƒÂªn mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (menu trong chi tiÃ¡ÂºÂ¿t Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN).' });
  }
  if (gen.skipped === 'not_approved') {
    return res.status(400).json({ message: 'ChÃ¡Â»â€° sinh tÃ¡Â»Â trÃƒÂ¬nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c phÃƒÂª duyÃ¡Â»â€¡t.' });
  }
  if (!gen.ok) {
    console.error('[merge] ytnn', gen.message);
    return res.status(400).json({ message: gen.message || 'LÃ¡Â»â€”i khi ghÃƒÂ©p Word.' });
  }
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ sinh file Word tÃ¡Â»Â« mÃ¡ÂºÂ«u vÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', van_ban_word_original_name: gen.outName });
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ LÃ¡Â»Å CH SÃ¡Â»Â¬ THAO TÃƒÂC
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
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ Ã„ÂOÃƒâ‚¬N RA: THÃ¡ÂºÂ¨M Ã„ÂÃ¡Â»Å NH (PhÃƒÂ²ng KHCN Ã¢â€ â€™ bÃ†Â°Ã¡Â»â€ºc 2)
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
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phong_duyet'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN. NÃ¡ÂºÂ¿u Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung, ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ§n nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ trÃ†Â°Ã¡Â»â€ºc.' });
    }
    const newStatus = action==='duyet_len_vt' ? 'cho_vt_duyet' : action==='tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action==='duyet_len_vt' ? 'PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€ TrÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng' : action==='tu_choi' ? 'PhÃƒÂ²ng KHCN tÃ¡Â»Â« chÃ¡Â»â€˜i' : 'PhÃƒÂ²ng KHCN yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
    db.prepare("UPDATE cooperation_doan_ra SET status=?, note_phong=?, phong_xu_ly_id=?, phong_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_ra', id, 2, action, label, req.user, note);
    if (row.submitted_by_email) {
      if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_ra', row, id, 'phong', note).catch(err => console.error('[Email tu_choi doan_ra]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
        subject:`[${row.ma_de_xuat||coopGenMa('doan_ra',id)}] CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ${label}`,
        html: coopBuildEmail('CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra', `Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN xÃ¡Â»Â­ lÃƒÂ½.`,
          [['MÃƒÂ£',row.ma_de_xuat||coopGenMa('doan_ra',id)],['TrÃ¡ÂºÂ¡ng thÃƒÂ¡i mÃ¡Â»â€ºi',STATUS_LABELS_COOP[newStatus]||newStatus],['ÃƒÂ kiÃ¡ÂºÂ¿n PhÃƒÂ²ng KHCN',note||'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
        text:`${row.ma_de_xuat} Ã¢â‚¬â€ ${label}. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note||'Ã¢â‚¬â€'}` });
      }
    }
    if (action==='duyet_len_vt') {
      const recip = coopGetRecipients('doan_ra');
      coopSendMail({ to:recip.to, cc:recip.cc,
        subject:`[HÃ¡Â»Â£p tÃƒÂ¡c QT] TrÃƒÂ¬nh duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ${row.ma_de_xuat||coopGenMa('doan_ra',id)}`,
        html: coopBuildEmail('Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra cÃ¡ÂºÂ§n ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t','PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN Ã„â€˜ÃƒÂ£ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh vÃƒÂ  trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng:',
          [['MÃƒÂ£',row.ma_de_xuat||coopGenMa('doan_ra',id)],['NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i',row.submitted_by_name||row.submitted_by_email],['QuÃ¡Â»â€˜c gia',row.quoc_gia],['NgÃƒÂ y Ã„â€˜i',coopFmtDate(row.ngay_di)],['ÃƒÂ kiÃ¡ÂºÂ¿n PhÃƒÂ²ng',note||'Ã¢â‚¬â€']],
          'TrÃƒÂ¢n trÃ¡Â»Âng,<br/>PhÃƒÂ²ng KHCN&QHÃ„ÂN', (process.env.BASE_URL||'http://localhost:'+PORT)+'/module-hoatac-quocte.html'),
        text:`TrÃƒÂ¬nh duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n ra ${row.ma_de_xuat}.` });
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ Ã„ÂOÃƒâ‚¬N RA: PHÃƒÅ  DUYÃ¡Â»â€ T (ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã¢â€ â€™ bÃ†Â°Ã¡Â»â€ºc 3)
// ============================================================
app.put('/api/cooperation/doan-ra/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang Ã¡Â»Å¸ bÃ†Â°Ã¡Â»â€ºc chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (Ã„â€˜ÃƒÂ£ qua PhÃƒÂ²ng KHCN).' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t' : action==='tu_choi' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t' : 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
    db.prepare("UPDATE cooperation_doan_ra SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_ra', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateDoanRaVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_ra] Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx) mÃ¡Â»â„¢t lÃ¡ÂºÂ§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_ra] Auto Word sau phÃƒÂª duyÃ¡Â»â€¡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('doan_ra'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â‚¬â€ Ã„ÂoÃƒÂ n ra`,
          html: coopBuildEmail('ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ (Ã„ÂoÃƒÂ n ra)',
            'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ cÃƒÂ³ ÃƒÂ½ kiÃ¡ÂºÂ¿n yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. <strong>PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN</strong> Ã„â€˜Ã†Â°Ã¡Â»Â£c CC Ã„â€˜Ã¡Â»Æ’ phÃ¡Â»â€˜i hÃ¡Â»Â£p theo dÃƒÂµi.',
            [['MÃƒÂ£', ma], ['NÃ¡Â»â„¢i dung ÃƒÂ½ kiÃ¡ÂºÂ¿n', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
          text: `${ma} Ã¢â‚¬â€ ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_ra', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi doan_ra]', err.message));
      } else {
        coopSendMail({ to: [row.submitted_by_email],
          subject: `[${ma}] KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n ra`,
          html: coopBuildEmail('KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n ra', 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t.',
            [['MÃƒÂ£', ma], ['KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£', label], ['ÃƒÂ kiÃ¡ÂºÂ¿n', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
          text: `${row.ma_de_xuat} Ã¢â‚¬â€ ${label}. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ Ã„ÂOÃƒâ‚¬N VÃƒâ‚¬O: PHÃƒÅ  DUYÃ¡Â»â€ T (ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng)
// ============================================================
app.put('/api/cooperation/doan-vao/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet' && st !== 'cho_ky_duyet') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t' : action==='tu_choi' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t' : 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
    db.prepare("UPDATE cooperation_doan_vao SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('doan_vao', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateDoanVaoVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[doan_vao] Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx) mÃ¡Â»â„¢t lÃ¡ÂºÂ§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[doan_vao] Auto Word sau phÃƒÂª duyÃ¡Â»â€¡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('doan_vao'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â‚¬â€ Ã„ÂoÃƒÂ n vÃƒÂ o`,
          html: coopBuildEmail('ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ (Ã„ÂoÃƒÂ n vÃƒÂ o)',
            'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ cÃƒÂ³ ÃƒÂ½ kiÃ¡ÂºÂ¿n yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. <strong>PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN</strong> Ã„â€˜Ã†Â°Ã¡Â»Â£c CC Ã„â€˜Ã¡Â»Æ’ phÃ¡Â»â€˜i hÃ¡Â»Â£p theo dÃƒÂµi.',
            [['MÃƒÂ£', ma], ['NÃ¡Â»â„¢i dung ÃƒÂ½ kiÃ¡ÂºÂ¿n', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
          text: `${ma} Ã¢â‚¬â€ YCBS ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('doan_vao', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi doan_vao]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n vÃƒÂ o`,
        html: coopBuildEmail('KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„ÂoÃƒÂ n vÃƒÂ o','Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t.',
            [['MÃƒÂ£',ma],['KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£',label],['ÃƒÂ kiÃ¡ÂºÂ¿n',note||'Ã¢â‚¬â€']],'TrÃƒÂ¢n trÃ¡Â»Âng.'),
        text:`${row.ma_de_xuat} Ã¢â‚¬â€ ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ MOU: PHÃƒÅ  DUYÃ¡Â»â€ T (ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng)
// ============================================================
app.put('/api/cooperation/mou/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note, so_van_ban, ngay_ky } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.' });
    }
    const newStatus = action==='yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : action;
    const label = action==='da_duyet' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t' : action==='tu_choi' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t' : 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
    db.prepare("UPDATE cooperation_mou_de_xuat SET status=?, note_vt=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note||null, req.user.id||null, id);
    coopAddHistory('mou', id, 3, action, label, req.user, note);
    if (action === 'da_duyet') {
      const gen = coopTryAutoGenerateMouVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[mou] Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx) mÃ¡Â»â„¢t lÃ¡ÂºÂ§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[mou] Auto Word sau phÃƒÂª duyÃ¡Â»â€¡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('mou', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('mou'), row.submitted_by_email);
      if (action === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â‚¬â€ MOU`,
          html: coopBuildEmail('ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ (MOU/ThÃ¡Â»Âa thuÃ¡ÂºÂ­n)',
            'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ cÃƒÂ³ ÃƒÂ½ kiÃ¡ÂºÂ¿n yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. <strong>PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN</strong> Ã„â€˜Ã†Â°Ã¡Â»Â£c CC Ã„â€˜Ã¡Â»Æ’ phÃ¡Â»â€˜i hÃ¡Â»Â£p theo dÃƒÂµi.',
            [['MÃƒÂ£', ma], ['Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c', row.ten_doi_tac || 'Ã¢â‚¬â€'], ['NÃ¡Â»â„¢i dung ÃƒÂ½ kiÃ¡ÂºÂ¿n', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
          text: `${ma} Ã¢â‚¬â€ YCBS ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}` });
      } else if (action === 'tu_choi') {
        coopSendMailTuChoi('mou', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi mou]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t MOU`,
        html: coopBuildEmail('KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t ThÃ¡Â»Âa thuÃ¡ÂºÂ­n MOU','Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t.',
            [['MÃƒÂ£',ma],['Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c',row.ten_doi_tac||'Ã¢â‚¬â€'],['KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£',label],['SÃ¡Â»â€˜ vÃ„Æ’n bÃ¡ÂºÂ£n',so_van_ban||'Ã¢â‚¬â€'],['ÃƒÂ kiÃ¡ÂºÂ¿n',note||'Ã¢â‚¬â€']],'TrÃƒÂ¢n trÃ¡Â»Âng.'),
        text:`${row.ma_de_xuat} Ã¢â‚¬â€ ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ YTNN: SUBMIT, LIST, THÃ¡ÂºÂ¨M Ã„ÂÃ¡Â»Å NH, PHÃƒÅ  DUYÃ¡Â»â€ T
// ============================================================
app.post('/api/cooperation/ytnn/submit', authMiddleware, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  const ten = (body.ten || '').trim();
  if (!ten) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u: TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i.' });
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
      body.kinh_phi||null, body.don_vi_tien_te||'VNÃ„Â', body.loai_hinh||'');
    const newId = result.lastInsertRowid;
    const ma = coopGenMa('ytnn', newId);
    db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat=? WHERE id=?').run(ma, newId);
    coopAddHistory('ytnn', newId, 1, 'submitted', 'GÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN', user, 'Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t tiÃ¡ÂºÂ¿p nhÃ¡ÂºÂ­n Ã„â€˜Ã¡Â»Â tÃƒÂ i cÃƒÂ³ yÃ¡ÂºÂ¿u tÃ¡Â»â€˜ nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i');
    const recip = coopGetRecipients('ytnn');
    coopSendMail({ to:recip.to, cc:recip.cc,
      subject:`[HÃ¡Â»Â£p tÃƒÂ¡c QT] Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t YTNN mÃ¡Â»â€ºi Ã¢â‚¬â€ ${ma} Ã¢â‚¬â€ ${ten}`,
      html: coopBuildEmail('Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN mÃ¡Â»â€ºi cÃ¡ÂºÂ§n phÃƒÂ¢n loÃ¡ÂºÂ¡i & thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh', `<strong>${user.fullname||user.email}</strong> gÃ¡Â»Â­i Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜Ã¡Â»Â tÃƒÂ i YTNN.`,
        [['MÃƒÂ£',ma],['TÃƒÂªn',ten],['Ã„ÂÃ¡Â»â€˜i tÃƒÂ¡c',body.doi_tac_ten||'Ã¢â‚¬â€'],['QuÃ¡Â»â€˜c gia',body.doi_tac_quoc_gia||'Ã¢â‚¬â€'],['ChÃ¡Â»Â§ nhiÃ¡Â»â€¡m',body.chu_nhiem_ten||user.fullname||'Ã¢â‚¬â€']],
        'TrÃƒÂ¢n trÃ¡Â»Âng.', (process.env.BASE_URL||'http://localhost:'+PORT)+'/module-hoatac-quocte.html'),
      text:`[${ma}] Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t YTNN "${ten}" tÃ¡Â»Â« ${user.email}.` });
    return res.json({ ok:true, message:`Ã„ÂÃƒÂ£ gÃ¡Â»Â­i! MÃƒÂ£: ${ma}`, ma_de_xuat:ma, id:newId });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
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
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    const pendingPhong = ['cho_phan_loai', 'cho_phong_duyet', 'dang_tham_dinh'];
    if (pendingPhong.indexOf(st) < 0) {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â PhÃƒÂ²ng KHCN. NÃ¡ÂºÂ¿u Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung, ngÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ§n nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ trÃ†Â°Ã¡Â»â€ºc.' });
    }
    const newStatus = action === 'chuyen_vt' ? 'cho_vt_duyet' : action === 'tu_choi' ? 'tu_choi' : 'yeu_cau_bo_sung';
    const label = action === 'chuyen_vt' ? 'PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh Ã¢â‚¬â€ TrÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng' : action === 'tu_choi' ? 'PhÃƒÂ²ng KHCN tÃ¡Â»Â« chÃ¡Â»â€˜i' : 'PhÃƒÂ²ng KHCN yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
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
        subject:`[${row.ma_de_xuat||coopGenMa('ytnn',id)}] YTNN Ã¢â‚¬â€ ${label}`,
        html: coopBuildEmail('CÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN','Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c PhÃƒÂ²ng KHCN xÃ¡Â»Â­ lÃƒÂ½.',
          [['MÃƒÂ£',row.ma_de_xuat||coopGenMa('ytnn',id)],['TrÃ¡ÂºÂ¡ng thÃƒÂ¡i',STATUS_LABELS_COOP[newStatus]||newStatus],['ÃƒÂ kiÃ¡ÂºÂ¿n',note||'Ã¢â‚¬â€']],'TrÃƒÂ¢n trÃ¡Â»Âng.'),
        text:`${row.ma_de_xuat} Ã¢â‚¬â€ ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

app.put('/api/cooperation/ytnn/:id/phe-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { action, note, vt_so_van_ban, vt_ngay_ky } = req.body || {};
  if (!id || !['da_duyet','tu_choi','yeu_cau_bo_sung','da_phe_duyet','khong_phe_duyet'].includes(action)) {
    return res.status(400).json({ message: 'Action: da_duyet | tu_choi | yeu_cau_bo_sung' });
  }
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const st = (row.status || '').toLowerCase().trim();
    if (st !== 'cho_vt_duyet' && st !== 'cho_vt_phe_duyet') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° phÃƒÂª duyÃ¡Â»â€¡t Ã„â€˜Ã†Â°Ã¡Â»Â£c khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.' });
    }
    const act = (action === 'da_phe_duyet') ? 'da_duyet' : (action === 'khong_phe_duyet') ? 'tu_choi' : action;
    const newStatus = act === 'yeu_cau_bo_sung' ? 'yeu_cau_bo_sung' : act;
    const label = act === 'da_duyet' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t' : act === 'tu_choi' ? 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng khÃƒÂ´ng phÃƒÂª duyÃ¡Â»â€¡t' : 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung';
    db.prepare("UPDATE htqt_de_xuat SET status=?, note_vt=?, vt_y_kien=?, vt_so_van_ban=?, vt_ngay_ky=?, vt_nguoi_ky_id=?, vt_xu_ly_id=?, vt_xu_ly_at=datetime('now','localtime'), updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?")
      .run(newStatus, note || null, note || null, vt_so_van_ban || null, vt_ngay_ky || null, req.user.id || null, req.user.id || null, id);
    coopAddHistory('ytnn', id, 3, act, label, req.user, note);
    if (act === 'da_duyet') {
      const gen = coopTryAutoGenerateYtnnVanBan(id);
      if (!gen.ok && gen.skipped === 'no_template') {
        console.warn('[ytnn] Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng Ã¢â‚¬â€ Admin cÃ¡ÂºÂ§n tÃ¡ÂºÂ£i mÃ¡ÂºÂ«u TÃ¡Â»Â trÃƒÂ¬nh (.docx) mÃ¡Â»â„¢t lÃ¡ÂºÂ§n.');
      } else if (!gen.ok && gen.skipped === 'error') {
        console.error('[ytnn] Auto Word sau phÃƒÂª duyÃ¡Â»â€¡t:', gen.message);
      }
    }
    if (row.submitted_by_email) {
      const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
      const ccPhong = coopEmailListMinus(coopEmailsPhongKhcnForTopic('ytnn'), row.submitted_by_email);
      if (act === 'yeu_cau_bo_sung') {
        coopSendMail({ to: [row.submitted_by_email], cc: ccPhong.length ? ccPhong : undefined,
          subject: `[${ma}] ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung Ã¢â‚¬â€ YTNN`,
          html: coopBuildEmail('ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung hÃ¡Â»â€œ sÃ†Â¡ (Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN)',
            'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ£ cÃƒÂ³ ÃƒÂ½ kiÃ¡ÂºÂ¿n yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. <strong>PhÃƒÂ²ng KHCN&amp;QHÃ„ÂN</strong> Ã„â€˜Ã†Â°Ã¡Â»Â£c CC Ã„â€˜Ã¡Â»Æ’ phÃ¡Â»â€˜i hÃ¡Â»Â£p theo dÃƒÂµi.',
            [['MÃƒÂ£', ma], ['TÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i', row.ten || 'Ã¢â‚¬â€'], ['NÃ¡Â»â„¢i dung ÃƒÂ½ kiÃ¡ÂºÂ¿n', note || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.'),
          text: `${ma} Ã¢â‚¬â€ YCBS ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng. ÃƒÂ kiÃ¡ÂºÂ¿n: ${note || 'Ã¢â‚¬â€'}` });
      } else if (act === 'tu_choi') {
        coopSendMailTuChoi('ytnn', row, id, 'vt', note).catch(err => console.error('[Email VT tu_choi ytnn]', err.message));
      } else {
      coopSendMail({ to:[row.submitted_by_email],
          subject:`[${ma}] KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t YTNN`,
        html: coopBuildEmail('KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ phÃƒÂª duyÃ¡Â»â€¡t Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN','Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t cÃ¡Â»Â§a bÃ¡ÂºÂ¡n Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng xem xÃƒÂ©t.',
            [['MÃƒÂ£',ma],['TÃƒÂªn',row.ten],['KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£',label],['SÃ¡Â»â€˜ VB',vt_so_van_ban||'Ã¢â‚¬â€'],['ÃƒÂ kiÃ¡ÂºÂ¿n',note||'Ã¢â‚¬â€']],'TrÃƒÂ¢n trÃ¡Â»Âng.'),
        text:`${row.ma_de_xuat} Ã¢â‚¬â€ ${label}` });
      }
    }
    return res.json({ ok:true, message:label, status:newStatus });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

// NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i: chÃ¡Â»â€°nh sÃ¡Â»Â­a / nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i / kÃ¡ÂºÂ¿t thÃƒÂºc (giÃ¡Â»Â¯ mÃƒÂ£ & lÃ¡Â»â€¹ch sÃ¡Â»Â­; chÃ¡Â»â€° admin xÃƒÂ³a bÃ¡ÂºÂ£n ghi)
function coopNopLaiStatusForLoai(loai) {
  return 'cho_phong_duyet';
}

app.put('/api/cooperation/doan-ra/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡Â»â€°nh sÃ¡Â»Â­a khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    const muc_dich = b.muc_dich != null ? String(b.muc_dich) : row.muc_dich;
    const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia || '').trim() : row.quoc_gia;
    const ngay_di = b.ngay_di != null ? String(b.ngay_di || '').trim() : row.ngay_di;
    const ngay_ve = b.ngay_ve != null ? String(b.ngay_ve || '').trim() : row.ngay_ve;
    const thanh_vien = b.thanh_vien != null ? String(b.thanh_vien) : row.thanh_vien;
    const nguon_kinh_phi = b.nguon_kinh_phi != null ? String(b.nguon_kinh_phi) : row.nguon_kinh_phi;
    const du_toan = b.du_toan != null && b.du_toan !== '' ? String(b.du_toan) : row.du_toan;
    if (!quoc_gia || !ngay_di || !ngay_ve || !thanh_vien) {
      return res.status(400).json({ message: 'Vui lÃƒÂ²ng Ã„â€˜iÃ¡Â»Ân Ã„â€˜Ã¡Â»Â§: QuÃ¡Â»â€˜c gia, NgÃƒÂ y Ã„â€˜i, NgÃƒÂ y vÃ¡Â»Â, ThÃƒÂ nh viÃƒÂªn Ã„â€˜oÃƒÂ n.' });
    }
    db.prepare(`UPDATE cooperation_doan_ra SET muc_dich=?, quoc_gia=?, ngay_di=?, ngay_ve=?, thanh_vien=?, nguon_kinh_phi=?, du_toan=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, id);
    coopAddHistory('doan_ra', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', req.user, null);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/doan-ra/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('doan_ra');
    db.prepare(`UPDATE cooperation_doan_ra SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('doan_ra', id, 2, 'nop_lai', 'NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ chÃ¡Â»Â PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_ra', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ (Ã„ÂoÃƒÂ n ra)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i <strong>${coopEscHtml(row.submitted_by_name || row.submitted_by_email)}</strong> Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ theo yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung. Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t quay lÃ¡ÂºÂ¡i bÃ†Â°Ã¡Â»â€ºc <strong>PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh</strong>, sau Ã„â€˜ÃƒÂ³ trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.`,
        [['MÃƒÂ£', ma], ['NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i', row.submitted_by_name || row.submitted_by_email]], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i Ã„ÂoÃƒÂ n ra ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai doan_ra]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i. PhÃƒÂ²ng KHCN sÃ¡ÂºÂ½ thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh lÃ¡ÂºÂ¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/doan-ra/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° kÃ¡ÂºÂ¿t thÃƒÂºc khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    db.prepare(`UPDATE cooperation_doan_ra SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('doan_ra', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (khÃƒÂ´ng nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_ra', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_ra', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã¢â‚¬â€ Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('KÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (thÃƒÂ´ng bÃƒÂ¡o)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ <strong>chÃ¡Â»Â§ Ã„â€˜Ã¡Â»â„¢ng kÃ¡ÂºÂ¿t thÃƒÂºc</strong> Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t, khÃƒÂ´ng tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡. HÃ¡Â»â€œ sÃ†Â¡ Ã„â€˜Ã†Â°Ã¡Â»Â£c lÃ†Â°u trong hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.`,
        [['MÃƒÂ£', ma], ['NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i', row.submitted_by_name || row.submitted_by_email]], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `KÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„ÂoÃƒÂ n ra ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc doan_ra]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.put('/api/cooperation/doan-vao/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡Â»â€°nh sÃ¡Â»Â­a khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
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
      return res.status(400).json({ message: 'Vui lÃƒÂ²ng Ã„â€˜iÃ¡Â»Ân Ã„â€˜Ã¡Â»Â§: Ã„ÂÃ†Â¡n vÃ¡Â»â€¹ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t, NgÃƒÂ y Ã„â€˜Ã¡ÂºÂ¿n, ThÃƒÂ nh phÃ¡ÂºÂ§n Ã„â€˜oÃƒÂ n.' });
    }
    db.prepare(`UPDATE cooperation_doan_vao SET muc_dich=?, don_vi_de_xuat=?, ngay_den=?, ngay_roi_di=?, thanh_phan_doan=?, noi_dung_lam_viec=?, kinh_phi_nguon=?, ho_tro_visa=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, noi_dung_lam_viec, kinh_phi_nguon, ho_tro_visa, id);
    coopAddHistory('doan_vao', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', req.user, null);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/doan-vao/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('doan_vao');
    db.prepare(`UPDATE cooperation_doan_vao SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('doan_vao', id, 2, 'nop_lai', 'NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ chÃ¡Â»Â PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_vao', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ (Ã„ÂoÃƒÂ n vÃƒÂ o)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡. Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t quay lÃ¡ÂºÂ¡i bÃ†Â°Ã¡Â»â€ºc <strong>PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh</strong>, sau Ã„â€˜ÃƒÂ³ trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.`,
        [['MÃƒÂ£', ma]], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i Ã„ÂoÃƒÂ n vÃƒÂ o ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai doan_vao]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/doan-vao/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° kÃ¡ÂºÂ¿t thÃƒÂºc khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    db.prepare(`UPDATE cooperation_doan_vao SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('doan_vao', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (khÃƒÂ´ng nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('doan_vao', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('doan_vao', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã¢â‚¬â€ Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('KÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (thÃƒÂ´ng bÃƒÂ¡o)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ chÃ¡Â»Â§ Ã„â€˜Ã¡Â»â„¢ng kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t, khÃƒÂ´ng tiÃ¡ÂºÂ¿p tÃ¡Â»Â¥c nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i.`,
        [['MÃƒÂ£', ma]], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `KÃ¡ÂºÂ¿t thÃƒÂºc Ã„ÂoÃƒÂ n vÃƒÂ o ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc doan_vao]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.put('/api/cooperation/mou/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡Â»â€°nh sÃ¡Â»Â­a khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    const loai_thoa_thuan = b.loai_thoa_thuan != null ? String(b.loai_thoa_thuan) : row.loai_thoa_thuan;
    const ten_doi_tac = b.ten_doi_tac != null ? String(b.ten_doi_tac || '').trim() : row.ten_doi_tac;
    const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia) : row.quoc_gia;
    const thoi_han_nam = b.thoi_han_nam != null && b.thoi_han_nam !== '' ? String(b.thoi_han_nam) : row.thoi_han_nam;
    const gia_tri_tai_chinh = b.gia_tri_tai_chinh != null ? String(b.gia_tri_tai_chinh) : row.gia_tri_tai_chinh;
    const don_vi_de_xuat = b.don_vi_de_xuat != null ? String(b.don_vi_de_xuat) : row.don_vi_de_xuat;
    const noi_dung_hop_tac = b.noi_dung_hop_tac != null ? String(b.noi_dung_hop_tac) : row.noi_dung_hop_tac;
    if (!ten_doi_tac || !noi_dung_hop_tac) {
      return res.status(400).json({ message: 'Vui lÃƒÂ²ng Ã„â€˜iÃ¡Â»Ân Ã„â€˜Ã¡Â»â€˜i tÃƒÂ¡c vÃƒÂ  nÃ¡Â»â„¢i dung hÃ¡Â»Â£p tÃƒÂ¡c.' });
    }
    db.prepare(`UPDATE cooperation_mou_de_xuat SET loai_thoa_thuan=?, ten_doi_tac=?, quoc_gia=?, thoi_han_nam=?, gia_tri_tai_chinh=?, don_vi_de_xuat=?, noi_dung_hop_tac=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
      .run(loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, noi_dung_hop_tac, id);
    coopAddHistory('mou', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', req.user, null);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/mou/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('mou');
    db.prepare(`UPDATE cooperation_mou_de_xuat SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('mou', id, 2, 'nop_lai', 'NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ chÃ¡Â»Â PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('mou', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('mou', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ MOU Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ (MOU)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡. Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t quay lÃ¡ÂºÂ¡i bÃ†Â°Ã¡Â»â€ºc <strong>PhÃƒÂ²ng KHCN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh</strong>, sau Ã„â€˜ÃƒÂ³ trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.`,
        [['MÃƒÂ£', ma]], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i MOU ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai mou]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/mou/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° kÃ¡ÂºÂ¿t thÃƒÂºc khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    db.prepare(`UPDATE cooperation_mou_de_xuat SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('mou', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (khÃƒÂ´ng nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('mou', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('mou', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã¢â‚¬â€ MOU Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('KÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (thÃƒÂ´ng bÃƒÂ¡o)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ chÃ¡Â»Â§ Ã„â€˜Ã¡Â»â„¢ng kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.`,
        [['MÃƒÂ£', ma]], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `KÃ¡ÂºÂ¿t thÃƒÂºc MOU ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc mou]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.put('/api/cooperation/ytnn/:id/cap-nhat-boi-nguoi-nop', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° chÃ¡Â»â€°nh sÃ¡Â»Â­a khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang Ã¡Â»Å¸ trÃ¡ÂºÂ¡ng thÃƒÂ¡i yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    const ten = b.ten != null ? String(b.ten || '').trim() : row.ten;
    if (!ten) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u tÃƒÂªn Ã„â€˜Ã¡Â»Â tÃƒÂ i.' });
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
    coopAddHistory('ytnn', id, 1, 'cap_nhat_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t nÃ¡Â»â„¢i dung Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t', req.user, null);
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ lÃ†Â°u chÃ¡Â»â€°nh sÃ¡Â»Â­a.' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/ytnn/:id/nop-lai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    const stNew = coopNopLaiStatusForLoai('ytnn');
    db.prepare(`UPDATE htqt_de_xuat SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
    coopAddHistory('ytnn', id, 2, 'nop_lai', 'NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ chÃ¡Â»Â PhÃƒÂ²ng KHCN phÃƒÂ¢n loÃ¡ÂºÂ¡i & thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('ytnn', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ Ã¢â‚¬â€ YTNN Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡ (YTNN)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i hÃ¡Â»â€œ sÃ†Â¡. Ã„ÂÃ¡Â»Â xuÃ¡ÂºÂ¥t quay lÃ¡ÂºÂ¡i bÃ†Â°Ã¡Â»â€ºc <strong>PhÃƒÂ²ng KHCN</strong>, sau Ã„â€˜ÃƒÂ³ trÃƒÂ¬nh ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng.`,
        [['MÃƒÂ£', ma], ['TÃƒÂªn', row.ten || 'Ã¢â‚¬â€']], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `NÃ¡Â»â„¢p lÃ¡ÂºÂ¡i YTNN ${ma}. ${modUrl}`
    }).catch(err => console.error('[nop-lai ytnn]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i.', status: stNew });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

app.post('/api/cooperation/ytnn/:id/ket-thuc', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    const a = coopAssertSubmitter(req, row);
    if (!a.ok) return res.status(403).json({ message: a.message });
    if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
      return res.status(400).json({ message: 'ChÃ¡Â»â€° kÃ¡ÂºÂ¿t thÃƒÂºc khi Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã„â€˜ang yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung.' });
    }
    db.prepare(`UPDATE htqt_de_xuat SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
    coopAddHistory('ytnn', id, 3, 'ket_thuc_boi_nguoi_nop', 'NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (khÃƒÂ´ng nÃ¡Â»â„¢p lÃ¡ÂºÂ¡i)', req.user, null);
    const ma = row.ma_de_xuat || coopGenMa('ytnn', id);
    const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
    coopNotifyPhongToCcVt('ytnn', {
      submitterEmail: row.submitted_by_email,
      subject: `[HÃ¡Â»Â£p tÃƒÂ¡c QT] NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t Ã¢â‚¬â€ YTNN Ã¢â‚¬â€ ${ma}`,
      html: coopBuildEmail('KÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (thÃƒÂ´ng bÃƒÂ¡o)', `NgÃ†Â°Ã¡Â»Âi gÃ¡Â»Â­i Ã„â€˜ÃƒÂ£ chÃ¡Â»Â§ Ã„â€˜Ã¡Â»â„¢ng kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.`,
        [['MÃƒÂ£', ma]], 'TrÃƒÂ¢n trÃ¡Â»Âng.', modUrl),
      text: `KÃ¡ÂºÂ¿t thÃƒÂºc YTNN ${ma}. ${modUrl}`
    }).catch(err => console.error('[ket-thuc ytnn]', err.message));
    return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ ghi nhÃ¡ÂºÂ­n kÃ¡ÂºÂ¿t thÃƒÂºc Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t.', status: 'ket_thuc_boi_nguoi_nop' });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i: ' + e.message }); }
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ SÃ¡Â»Â° KIÃ¡Â»â€ N QUÃ¡Â»ÂC TÃ¡ÂºÂ¾
// ============================================================
app.post('/api/cooperation/su-kien', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const user = req.user || {};
  const body = req.body || {};
  if (!body.tieu_de || !body.ngay_bat_dau) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u TiÃƒÂªu Ã„â€˜Ã¡Â»Â vÃƒÂ  NgÃƒÂ y bÃ¡ÂºÂ¯t Ã„â€˜Ã¡ÂºÂ§u.' });
  try {
    const result = db.prepare(`
      INSERT INTO cooperation_su_kien (tieu_de, mo_ta, loai_su_kien, quoc_gia, dia_diem, ngay_bat_dau, ngay_ket_thuc, don_vi_to_chuc, link_su_kien, han_dang_ky, kinh_phi_tham_du, ghi_chu, tags, status, created_by_id, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(body.tieu_de, body.mo_ta||'', body.loai_su_kien||'hoi_thao', body.quoc_gia||'', body.dia_diem||'',
      body.ngay_bat_dau, body.ngay_ket_thuc||'', body.don_vi_to_chuc||'',
      body.link_su_kien||'', body.han_dang_ky||'', body.kinh_phi_tham_du||'',
      body.ghi_chu||'', body.tags||'', body.status||'sap_dien_ra',
      user.id||null, user.fullname||user.email||'');
    return res.json({ ok:true, message:'Ã„ÂÃƒÂ£ tÃ¡ÂºÂ¡o sÃ¡Â»Â± kiÃ¡Â»â€¡n!', id: result.lastInsertRowid });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ gÃƒÂ¬ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
  try {
    db.prepare(`UPDATE cooperation_su_kien SET ${sets.join(',')} WHERE id=?`).run(...vals);
    return res.json({ ok:true, message:'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

app.delete('/api/admin/cooperation/su-kien/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM cooperation_su_kien WHERE id=?').run(parseInt(req.params.id,10));
    return res.json({ ok:true, message:'Ã„ÂÃƒÂ£ xÃƒÂ³a sÃ¡Â»Â± kiÃ¡Â»â€¡n.' });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ EVENTS WORKFLOW
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
  return String(((row && row.c) || 0) + 1) + '/SCI-KHCN&QHÃ„ÂN';
}
function eventStatusTransitionError(ev, toStatus) {
  const from = eventNormStatus(ev.trang_thai);
  const to = eventNormStatus(toStatus);
  if (!(EVENT_TRANSITIONS[from] || []).includes(to)) return 'KhÃƒÂ´ng Ã„â€˜ÃƒÂºng thÃ¡Â»Â© tÃ¡Â»Â± chuyÃ¡Â»Æ’n trÃ¡ÂºÂ¡ng thÃƒÂ¡i.';
  if (to === 'da_duoc_phep') {
    const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file = 'quyet_dinh_cho_phep' LIMIT 1").get(ev.id);
    if (!has) return 'CÃ¡ÂºÂ§n upload QuyÃ¡ÂºÂ¿t Ã„â€˜Ã¡Â»â€¹nh cho phÃƒÂ©p trÃ†Â°Ã¡Â»â€ºc khi chuyÃ¡Â»Æ’n trÃ¡ÂºÂ¡ng thÃƒÂ¡i nÃƒÂ y.';
  }
  if (to === 'da_bao_cao') {
    const has = db.prepare("SELECT 1 FROM event_files WHERE event_id = ? AND loai_file IN ('bao_cao_su_kien','quyet_dinh_bao_cao') LIMIT 1").get(ev.id);
    if (!has) return 'CÃ¡ÂºÂ§n upload BÃƒÂ¡o cÃƒÂ¡o cÃƒÂ³ dÃ¡ÂºÂ¥u Ã„â€˜Ã¡Â»Â trÃ†Â°Ã¡Â»â€ºc khi chuyÃ¡Â»Æ’n trÃ¡ÂºÂ¡ng thÃƒÂ¡i nÃƒÂ y.';
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
    if (!/\.(pdf|doc|docx|jpg|jpeg|png)$/i.test(n)) return cb(new Error('ChÃ¡Â»â€° nhÃ¡ÂºÂ­n PDF, DOC, DOCX, JPG, PNG'));
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
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i tÃ¡ÂºÂ£i danh sÃƒÂ¡ch sÃ¡Â»Â± kiÃ¡Â»â€¡n: ' + e.message }); }
});
app.post('/api/events', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const b = req.body || {};
  if (!String(b.tieu_de || '').trim() || !String(b.ngay_bat_dau || '').trim()) return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u TÃƒÂªn sÃ¡Â»Â± kiÃ¡Â»â€¡n hoÃ¡ÂºÂ·c NgÃƒÂ y bÃ¡ÂºÂ¯t Ã„â€˜Ã¡ÂºÂ§u.' });
  try {
    const so = String(b.so_van_ban || '').trim() || eventGenSoVanBan();
    const ins = db.prepare(`INSERT INTO events (so_van_ban,tieu_de,loai,don_vi_to_chuc,hinh_thuc,link_su_kien,dia_diem,quy_mo,lich_trinh,muc_tieu,thanh_phan_tham_du,kinh_phi_du_kien,nguon_kinh_phi,ngay_bat_dau,ngay_ket_thuc,han_dang_ky,nguoi_tao,trang_thai,nguoi_phu_trach,phu_trach_lien_he,ghi_chu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(so, b.tieu_de || '', b.loai || 'HÃ¡Â»â„¢i thÃ¡ÂºÂ£o', b.don_vi_to_chuc || '', b.hinh_thuc || '', b.link_su_kien || '', b.dia_diem || '', b.quy_mo ? Number(b.quy_mo) : null, JSON.stringify(b.lich_trinh || []), b.muc_tieu || '', b.thanh_phan_tham_du || '', b.kinh_phi_du_kien ? Number(b.kinh_phi_du_kien) : 0, b.nguon_kinh_phi || '', b.ngay_bat_dau || '', b.ngay_ket_thuc || '', b.han_dang_ky || '', req.user.fullname || req.user.email || '', eventNormStatus(b.trang_thai || 'draft'), b.nguoi_phu_trach || '', b.phu_trach_lien_he || '', b.ghi_chu || '');
    const id = Number(ins.lastInsertRowid);
    db.prepare('INSERT INTO event_status_history (event_id, from_status, to_status, note, changed_by_id, changed_by_name) VALUES (?, ?, ?, ?, ?, ?)').run(id, null, eventNormStatus(b.trang_thai || 'draft'), 'TÃ¡ÂºÂ¡o sÃ¡Â»Â± kiÃ¡Â»â€¡n', req.user.id || null, req.user.fullname || req.user.email || '');
    return res.status(201).json({ ok: true, id, so_van_ban: so });
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i tÃ¡ÂºÂ¡o sÃ¡Â»Â± kiÃ¡Â»â€¡n: ' + e.message }); }
});
app.get('/api/events/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  const event = eventGetById(id);
  if (!event) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y sÃ¡Â»Â± kiÃ¡Â»â€¡n' });
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
  if (!sets.length) return res.status(400).json({ message: 'KhÃƒÂ´ng cÃƒÂ³ gÃƒÂ¬ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  vals.push(id);
  const r = db.prepare(`UPDATE events SET ${sets.join(',')} WHERE id = ? AND deleted_at IS NULL`).run(...vals);
  if (!r.changes) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y sÃ¡Â»Â± kiÃ¡Â»â€¡n' });
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
});
app.delete('/api/events/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡' });
  db.prepare("UPDATE events SET deleted_at = datetime('now','localtime') WHERE id = ?").run(id);
  return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ xÃƒÂ³a sÃ¡Â»Â± kiÃ¡Â»â€¡n.' });
});
app.patch('/api/events/:id/status', authMiddleware, coopPhongOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const to = eventNormStatus((req.body || {}).to_status);
  const note = String((req.body || {}).note || '').slice(0, 2000);
  const ev = eventGetById(id);
  if (!ev) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y sÃ¡Â»Â± kiÃ¡Â»â€¡n' });
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
  if (!eventGetById(id)) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y sÃ¡Â»Â± kiÃ¡Â»â€¡n' });
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
    if (err) return res.status(400).json({ message: 'Upload thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i' });
    const id = parseInt(req.params.id, 10);
    if (!eventGetById(id)) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y sÃ¡Â»Â± kiÃ¡Â»â€¡n' });
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
  if (!row) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y file' });
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
      return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u template Word: templates/events/to_trinh_xin_phep.docx. Vui lÃƒÂ²ng Ã„â€˜Ã¡ÂºÂ·t Ã„â€˜ÃƒÂºng file mÃ¡ÂºÂ«u Ã„â€˜Ã¡Â»Æ’ xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂºng Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng.' });
    }
    const id = parseInt(req.params.id, 10);
    const ev = eventGetById(id);
    if (!ev) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y sÃ¡Â»Â± kiÃ¡Â»â€¡n' });
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
    db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'to_trinh_xin_phep', fn, rel, 'Word tÃ¡Â»Â trÃƒÂ¬nh sinh tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng', req.user.fullname || req.user.email || '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    setContentDisposition(res, fn);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i xuÃ¡ÂºÂ¥t Word: ' + e.message }); }
});
app.post('/api/events/:id/export/bao-cao', authMiddleware, coopPhongOrAdmin, async (req, res) => {
  try {
    const tpl = path.join(__dirname, 'templates', 'events', 'bao_cao_su_kien.docx');
    if (!fs.existsSync(tpl)) {
      return res.status(400).json({ message: 'ThiÃ¡ÂºÂ¿u template Word: templates/events/bao_cao_su_kien.docx. Vui lÃƒÂ²ng Ã„â€˜Ã¡ÂºÂ·t Ã„â€˜ÃƒÂºng file mÃ¡ÂºÂ«u Ã„â€˜Ã¡Â»Æ’ xuÃ¡ÂºÂ¥t Ã„â€˜ÃƒÂºng Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng.' });
    }
    const id = parseInt(req.params.id, 10);
    const ev = eventGetById(id);
    if (!ev) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y sÃ¡Â»Â± kiÃ¡Â»â€¡n' });
    const sessions = eventGetSessions(id);
    const data = { tieu_de: ev.tieu_de || '', ngay_bat_dau: ev.ngay_bat_dau || '', ngay_ket_thuc: ev.ngay_ket_thuc || '', so_nguoi_tham_du_thuc_te: ev.so_nguoi_tham_du_thuc_te || '', ket_qua_su_kien: ev.ket_qua_su_kien || '', de_xuat_kien_nghi: ev.de_xuat_kien_nghi || '', bai_hoc_kinh_nghiem: ev.bai_hoc_kinh_nghiem || '', uu_diem: ev.uu_diem || '', han_che: ev.han_che || '', lich_trinh: sessions };
    const buf = await buildEventReportDocBuffer(data);
    const fn = 'bao_cao_su_kien_' + id + '_' + Date.now() + '.docx';
    const dir = path.join(uploadDir, 'events', String(id)); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fn), buf);
    const rel = path.join('uploads', 'events', String(id), fn).replace(/\\/g, '/');
    db.prepare('INSERT INTO event_files (event_id, loai_file, ten_file, duong_dan, mo_ta, nguoi_upload) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'bao_cao_su_kien', fn, rel, 'Word bÃƒÂ¡o cÃƒÂ¡o sinh tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng', req.user.fullname || req.user.email || '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    setContentDisposition(res, fn);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ message: 'LÃ¡Â»â€”i xuÃ¡ÂºÂ¥t Word: ' + e.message }); }
});

// ============================================================
// ROUTE MÃ¡Â»Å¡I Ã¢â‚¬â€ ADMIN: SÃ¡Â»Â¬A/XÃƒâ€œA Ã„ÂÃ¡Â»â‚¬ XUÃ¡ÂºÂ¤T
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
    if (!sets.length) return res.status(400).json({ message:'KhÃƒÂ´ng cÃƒÂ³ gÃƒÂ¬ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
    sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
    try {
      const r = db.prepare(`UPDATE ${tbl} SET ${sets.join(',')} WHERE id=?`).run(...vals);
      if (r.changes===0) return res.status(404).json({ message:'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
      coopAddHistory(loai, id, 0, 'admin_edit', 'Admin chÃ¡Â»â€°nh sÃ¡Â»Â­a', req.user, JSON.stringify(body));
      if (ep === 'mou' && String(body.status || '').toLowerCase() === 'da_duyet') {
        try {
          const gen = coopTryAutoGenerateMouVanBan(id);
          if (!gen.ok && gen.skipped === 'no_template') {
            console.warn('[mou] Admin Ã„â€˜Ã¡ÂºÂ·t trÃ¡ÂºÂ¡ng thÃƒÂ¡i Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.');
          } else if (!gen.ok && gen.skipped === 'error') {
            console.error('[mou] Auto Word sau admin cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t:', gen.message);
          }
        } catch (e) {}
      }
      return res.json({ ok:true, message:'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
    } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
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
      return res.json({ ok:true, message:'Ã„ÂÃƒÂ£ xÃƒÂ³a.' });
    } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
  });
});

// admin ytnn
app.put('/api/admin/cooperation/ytnn/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const { sets, vals } = coopAdminUpdateSetsFromBody(body, COOP_ADMIN_COLS_YTNN);
  if (!sets.length) return res.status(400).json({ message:'KhÃƒÂ´ng cÃƒÂ³ gÃƒÂ¬ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
  try {
    const r = db.prepare(`UPDATE htqt_de_xuat SET ${sets.join(',')} WHERE id=?`).run(...vals);
    if (r.changes === 0) return res.status(404).json({ message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y.' });
    coopAddHistory('ytnn', id, 0, 'admin_edit', 'Admin chÃ¡Â»â€°nh sÃ¡Â»Â­a', req.user, JSON.stringify(body));
    if (String(body.status || '').toLowerCase() === 'da_duyet') {
      try {
        const gen = coopTryAutoGenerateYtnnVanBan(id);
        if (!gen.ok && gen.skipped === 'no_template') {
          console.warn('[ytnn] Admin Ã„â€˜Ã¡ÂºÂ·t trÃ¡ÂºÂ¡ng thÃƒÂ¡i Ã„ÂÃƒÂ£ phÃƒÂª duyÃ¡Â»â€¡t nhÃ†Â°ng chÃ†Â°a cÃƒÂ³ mÃ¡ÂºÂ«u Word trÃƒÂªn hÃ¡Â»â€¡ thÃ¡Â»â€˜ng.');
        } else if (!gen.ok && gen.skipped === 'error') {
          console.error('[ytnn] Auto Word sau admin cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t:', gen.message);
        }
      } catch (e) {}
    }
    return res.json({ ok:true, message:'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t.' });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});
app.delete('/api/admin/cooperation/ytnn/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
    if (row) coopUnlinkYtnnVanBanFile(row);
    db.prepare('DELETE FROM htqt_de_xuat WHERE id=?').run(id);
    try { db.prepare('DELETE FROM coop_history WHERE loai=? AND de_xuat_id=?').run('ytnn', id); } catch(e) {}
    return res.json({ ok:true, message:'Ã„ÂÃƒÂ£ xÃƒÂ³a.' });
  } catch(e) { return res.status(500).json({ message:'LÃ¡Â»â€”i: '+e.message }); }
});

// ============================================================
// HELPER: build title cho list view
// ============================================================
function coopBuildTitle(loai, r) {
  if (loai==='doan_ra') return `Ã„ÂoÃƒÂ n ra Ã¢â‚¬â€ ${r.quoc_gia||'Ã¢â‚¬â€'}${r.muc_dich?' ('+r.muc_dich+')':''}`;
  if (loai==='doan_vao') return `Ã„ÂoÃƒÂ n vÃƒÂ o Ã¢â‚¬â€ ${r.muc_dich||r.don_vi_de_xuat||'Ã¢â‚¬â€'}`;
  if (loai==='mou') return `MOU Ã¢â‚¬â€ ${r.ten_doi_tac||'Ã¢â‚¬â€'}${r.quoc_gia?', '+r.quoc_gia:''}`;
  if (loai==='ytnn') return `Ã„ÂÃ¡Â»Â tÃƒÂ i cÃƒÂ³ yÃ¡ÂºÂ¿u tÃ¡Â»â€˜ nÃ†Â°Ã¡Â»â€ºc ngoÃƒÂ i Ã¢â‚¬â€ ${r.ten||'Ã¢â‚¬â€'}`;
  return 'Ã¢â‚¬â€';
}

console.log('[Cooperation] Ã¢Å“â€¦ CÃƒÂ¡c route HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ mÃ¡Â»â€ºi Ã„â€˜ÃƒÂ£ Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã„â€˜Ã„Æ’ng kÃƒÂ½.');
// TÃƒÂ­ch hÃ¡Â»Â£p Sub-App QuÃ¡ÂºÂ£n lÃƒÂ½ Ã„ÂÃ¡Â»Â tÃƒÂ i CÃ¡ÂºÂ¥p ViÃ¡Â»â€¡n chuyÃƒÂªn biÃ¡Â»â€¡t tÃ¡ÂºÂ¡i /de-tai-cap-vien/
require('./modules/de-tai-cap-vien/eofficeMount').mount(app, { db, jwt, JWT_SECRET, getTokenFromReq, userIdIsBanned, clearAuthCookie, userEmailIsMasterAdmin, transporter, getSmtpFrom });
// LÃ†Â°u ÃƒÂ½: middleware 404 cho /api phÃ¡ÂºÂ£i Ã„â€˜Ã„Æ’ng kÃƒÂ½ SAU mountSciKhcnPublicationsRouters()
// (enrich, journal-metrics, Ã¢â‚¬Â¦). NÃ¡ÂºÂ¿u Ã„â€˜Ã¡ÂºÂ·t trÃ†Â°Ã¡Â»â€ºc, mÃ¡Â»Âi /api/enrich/* sÃ¡ÂºÂ½ 404.

// Serve dang-nhap.html vÃ¡Â»â€ºi script inject: sau login redirect vÃ¡Â»Â trang pending
app.get('/dang-nhap.html', (req, res) => {
  const filePath = path.join(__dirname, 'dang-nhap.html');
  if (!fs.existsSync(filePath)) return res.status(404).send('KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y trang Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p');
  let html = fs.readFileSync(filePath, 'utf8');
  const injectScript = `
<script>
// HTQT Login Hook: sau khi Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p thÃƒÂ nh cÃƒÂ´ng, redirect vÃ¡Â»Â trang pending
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
  // Inject trÃ†Â°Ã¡Â»â€ºc </body>
  if (html.includes('</body>')) {
    html = html.replace('</body>', injectScript + '\n</body>');
  } else {
    html = html + injectScript;
  }
  res.type('html').send(html);
});

// ChÃ¡Â»â€° cho phÃƒÂ©p khÃƒÂ¡ch (chÃ†Â°a Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p) xem trang chÃ¡Â»Â§ vÃƒÂ  cÃƒÂ¡c trang Ã„â€˜Ã„Æ’ng nhÃ¡ÂºÂ­p/Ã„â€˜Ã„Æ’ng kÃƒÂ½/quÃƒÂªn mÃ¡ÂºÂ­t khÃ¡ÂºÂ©u; cÃƒÂ¡c trang .html khÃƒÂ¡c cÃ¡ÂºÂ§n cookie JWT hÃ¡Â»Â£p lÃ¡Â»â€¡.
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

/** Ã„ÂÃ†Â°Ã¡Â»Âng dÃ¡ÂºÂ«n khÃƒÂ´ng Ã„â€˜uÃƒÂ´i .html Ã¢â‚¬â€ Ã„ÂÃ„Æ’ng kÃƒÂ½ HN/HT */
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
      // vai trÃƒÂ² chÃ¡Â»â€° dÃƒÂ¹ng mÃ¡Â»â„¢t sÃ¡Â»â€˜ module (crd_user, sinh_vien): chÃ¡Â»â€° mÃ¡Â»Å¸ cÃƒÂ¡c trang cÃ¡Â»Â§a module Ã„â€˜ÃƒÂ³ (services/vaiTroHanChe.js)
      if (!userIdIsBanned(payload0.id) && !vaiTroHanChe.trangHtmlDuocPhep(payload0.role, reqPath)) {
        return res.redirect(302, vaiTroHanChe.trangMacDinh(payload0.role));
      }
    } catch (e) {
      /* token lÃ¡Â»â€”i Ã¢â‚¬â€ xÃ¡Â»Â­ lÃƒÂ½ bÃ†Â°Ã¡Â»â€ºc dÃ†Â°Ã¡Â»â€ºi */
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

/** KhÃƒÂ´ng cho tÃ¡ÂºÂ£i source / cÃ¡ÂºÂ¥u hÃƒÂ¬nh qua static (trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y chÃ¡Â»â€° .html cÃƒÂ³ auth). */
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

/** Chart.js phÃ¡Â»Â¥c vÃ¡Â»Â¥ nÃ¡Â»â„¢i bÃ¡Â»â„¢: CSP chÃ¡Â»â€° cho script-src 'self', nÃ¡ÂºÂ¡p tÃ¡Â»Â« CDN sÃ¡ÂºÂ½ bÃ¡Â»â€¹ chÃ¡ÂºÂ·n.
 *  GÃƒÂ³i npm chÃ¡Â»â€° cÃƒÂ³ dist/chart.umd.js (Ã„â€˜ÃƒÂ£ minify) Ã¢â‚¬â€ khÃƒÂ´ng cÃƒÂ³ chart.umd.min.js nhÃ†Â° URL
 *  jsDelivr dÃƒÂ¹ng trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y (jsDelivr tÃ¡Â»Â± minify khi file .min.js khÃƒÂ´ng tÃ¡Â»â€œn tÃ¡ÂºÂ¡i). */
app.get('/public/vendor/chart.umd.js', (req, res) => {
  try {
    return res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  } catch (e) {
    return res.status(404).send('chart.js bundle not found');
  }
});

/** pdf.js phÃ¡Â»Â¥c vÃ¡Â»Â¥ nÃ¡Â»â„¢i bÃ¡Â»â„¢ (CSP chÃ¡Â»â€° cho script-src 'self'): chÃ¡Â»â€° hai tÃ¡Â»â€¡p dÃƒÂ¹ng Ã„â€˜Ã¡Â»Æ’ xem trÃ†Â°Ã¡Â»â€ºc PDF khi Ã„â€˜Ã¡ÂºÂ·t khung chÃ¡Â»Â¯ kÃƒÂ½ sÃ¡Â»â€˜ (public/js/kysoViTri.js). */
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

  // GiÃ¡Â»â€ºi hÃ¡ÂºÂ¡n tÃ¡Â»â€¢ng thÃ¡Â»Âi gian spawnSync Ã„â€˜Ã¡Â»Æ’ khÃƒÂ´ng chÃ¡ÂºÂ·n app.listen vÃƒÂ´ hÃ¡ÂºÂ¡n nÃ¡ÂºÂ¿u npm treo
  // (mÃ¡ÂºÂ¡ng chÃ¡ÂºÂ­m, lockfile hÃ¡Â»Âng, postinstall hook stuck). QuÃƒÂ¡ giÃ¡Â»Â -> SIGTERM child, server
  // vÃ¡ÂºÂ«n khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng Ã„â€˜Ã†Â°Ã¡Â»Â£c vÃ¡Â»â€ºi bundle cÃ…Â© (nÃ¡ÂºÂ¿u cÃƒÂ³) thay vÃƒÂ¬ zombie khÃƒÂ´ng listen.
  const DEFAULT_AUTO_BUILD_TIMEOUT_MS = 10 * 60 * 1000;
  const parsedTimeout = Number.parseInt(String(process.env.ADMIN_UI_AUTO_BUILD_TIMEOUT_MS || ''), 10);
  const perStepTimeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_AUTO_BUILD_TIMEOUT_MS;
  const fmtTimeout = `${Math.round(perStepTimeoutMs / 1000)}s`;

  console.log(
    `[ADMIN UI] ${triggerReason || 'dist missing'} -> attempting auto build (npm install + npm run build; timeout=${fmtTimeout}/step)`
  );

  function describeSpawnFailure(label, result) {
    if (result && result.signal) return `${label}: process bÃ¡Â»â€¹ kill bÃ¡Â»Å¸i ${result.signal} (cÃƒÂ³ thÃ¡Â»Æ’ do timeout=${fmtTimeout})`;
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
 * So sÃƒÂ¡nh mtime cÃ¡Â»Â§a thÃ†Â° mÃ¡Â»Â¥c source React vÃ¡Â»â€ºi dist/index.html Ã„â€˜Ã¡Â»Æ’ nhÃ¡ÂºÂ­n biÃ¡ÂºÂ¿t khi
 * ngÃ†Â°Ã¡Â»Âi vÃ¡ÂºÂ­n hÃƒÂ nh Ã„â€˜ÃƒÂ£ `git pull` code mÃ¡Â»â€ºi nhÃ†Â°ng chÃ†Â°a rebuild bundle. NÃ¡ÂºÂ¿u phÃƒÂ¡t hiÃ¡Â»â€¡n
 * source mÃ¡Â»â€ºi hÃ†Â¡n dist thÃƒÂ¬ tÃ¡Â»Â± Ã„â€˜Ã¡Â»â„¢ng rebuild khi khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng (trÃ¡Â»Â« khi tÃ¡ÂºÂ¯t bÃ¡ÂºÂ±ng env).
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
// Public status endpoint (khÃƒÂ´ng Ã„â€˜i qua namespace /api Ã„â€˜Ã¡Â»Æ’ trÃƒÂ¡nh bÃ¡Â»â€¹ auth middleware chÃ¡ÂºÂ·n).
app.get('/admin-ui-status', (req, res) => {
  return sendAdminUiStatus(res);
});
// GiÃ¡Â»Â¯ endpoint cÃ…Â© Ã„â€˜Ã¡Â»Æ’ tÃ†Â°Ã†Â¡ng thÃƒÂ­ch nÃ¡ÂºÂ¿u mÃƒÂ´i trÃ†Â°Ã¡Â»Âng khÃƒÂ´ng chÃ¡ÂºÂ·n /api.
app.get('/api/admin-ui-status', (req, res) => {
  return sendAdminUiStatus(res);
});

app.use(
  express.static(__dirname, {
    /** TÃ¡ÂºÂ¯t ETag/Last-Modified Ã¢â‚¬â€ nÃ¡ÂºÂ¿u khÃƒÂ´ng, trÃƒÂ¬nh duyÃ¡Â»â€¡t vÃ¡ÂºÂ«n nhÃ¡ÂºÂ­n 304 dÃƒÂ¹ cÃƒÂ³ Cache-Control (file HTML cÃ…Â©). */
    etag: false,
    lastModified: false,
    /** TrÃƒÂ¡nh cache HTML; cÃƒÂ¡c file khÃƒÂ¡c vÃ¡ÂºÂ«n tÃ¡ÂºÂ£i lÃ¡ÂºÂ¡i Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§ khi khÃƒÂ´ng cÃƒÂ²n 304. */
    setHeaders(res, filePath) {
      const lower = String(filePath || '').toLowerCase().replace(/\\/g, '/');
      // CÃƒÂ¡c file JS cÃ¡Â»Â§a module DMS Ã„â€˜ang sÃ¡Â»Â­a Ã„â€˜Ã¡Â»â€¢i thÃ†Â°Ã¡Â»Âng xuyÃƒÂªn Ã¢â‚¬â€ nÃ¡ÂºÂ¿u cache nhÃ†Â° file tÃ„Â©nh thÃƒÂ´ng
      // thÃ†Â°Ã¡Â»Âng, trÃƒÂ¬nh duyÃ¡Â»â€¡t cÃƒÂ³ thÃ¡Â»Æ’ chÃ¡ÂºÂ¡y bÃ¡ÂºÂ£n cÃ…Â© dÃƒÂ¹ HTML Ã„â€˜ÃƒÂ£ tÃ¡ÂºÂ£i bÃ¡ÂºÂ£n mÃ¡Â»â€ºi (tab/nÃƒÂºt mÃ¡Â»â€ºi hiÃ¡Â»â€¡n ra
      // nhÃ†Â°ng bÃ¡ÂºÂ¥m khÃƒÂ´ng phÃ¡ÂºÂ£n Ã¡Â»Â©ng vÃƒÂ¬ JS xÃ¡Â»Â­ lÃƒÂ½ vÃ¡ÂºÂ«n lÃƒÂ  bÃ¡ÂºÂ£n trÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ³).
      const isNoCacheJs = /\/js\/dms-(records-app|admin-page)\.js$/.test(lower);
      if (lower.endsWith('.html') || isNoCacheJs) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  })
);

/** Ã„ÂÃ¡Â»Â§ Ã„â€˜iÃ¡Â»Âu kiÃ¡Â»â€¡n nhÃ¡ÂºÂ¯c: Ã¢â€°Â¥3 ngÃƒÂ y kÃ¡Â»Æ’ tÃ¡Â»Â« cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t hÃ¡Â»â€œ sÃ†Â¡; lÃ¡ÂºÂ§n nhÃ¡ÂºÂ¯c sau cÃƒÂ¡ch lÃ¡ÂºÂ§n trÃ†Â°Ã¡Â»â€ºc Ã¢â€°Â¥3 ngÃƒÂ y (chÃ¡Â»â€° gÃ¡Â»Â­i nÃ¡Â»â„¢i bÃ¡Â»â„¢, khÃƒÂ´ng hiÃ¡Â»â€¡n cho ngÃ†Â°Ã¡Â»Âi nÃ¡Â»â„¢p Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t). */
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

/** NhÃ¡ÂºÂ¯c email theo tÃ¡Â»Â«ng hÃ¡Â»â€œ sÃ†Â¡ tÃ¡Â»â€ºi PhÃƒÂ²ng KHCN hoÃ¡ÂºÂ·c ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng (tÃƒÂ¹y bÃ†Â°Ã¡Â»â€ºc Ã„â€˜ang treo). */
function sendCoopStaleStepReminders() {
  if (!transporter) return;
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const moduleUrl = baseUrl + '/module-hoatac-quocte.html';
  const cfg = [
    { table: 'cooperation_doan_ra', topic: 'doan_ra', label: 'Ã„ÂoÃƒÂ n ra',
      phongStatuses: ['cho_phong_duyet'],
      vtStatuses: ['cho_vt_duyet'] },
    { table: 'cooperation_doan_vao', topic: 'doan_vao', label: 'Ã„ÂoÃƒÂ n vÃƒÂ o',
      phongStatuses: ['cho_phong_duyet', 'cho_tham_dinh', 'dang_tham_dinh'],
      vtStatuses: ['cho_vt_duyet', 'cho_ky_duyet'] },
    { table: 'cooperation_mou_de_xuat', topic: 'mou', label: 'ThÃ¡Â»Âa thuÃ¡ÂºÂ­n/MOU',
      phongStatuses: ['cho_phong_duyet', 'dang_tham_dinh'],
      vtStatuses: ['cho_vt_duyet'] },
    { table: 'htqt_de_xuat', topic: 'ytnn', label: 'Ã„ÂÃ¡Â»Â tÃƒÂ i YTNN',
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
      const stepLabel = waitPhong ? 'chÃ¡Â»Â PhÃƒÂ²ng KHCN&QHÃ„ÂN thÃ¡ÂºÂ©m Ã„â€˜Ã¡Â»â€¹nh / xÃ¡Â»Â­ lÃƒÂ½' : 'chÃ¡Â»Â ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng phÃƒÂª duyÃ¡Â»â€¡t';
      const subject = `[HTQT Ã¢â‚¬â€ nÃ¡Â»â„¢i bÃ¡Â»â„¢] NhÃ¡ÂºÂ¯c xÃ¡Â»Â­ lÃƒÂ½: ${T.label} ${ma} Ã¢â‚¬â€ ${waitPhong ? 'PhÃƒÂ²ng KHCN' : 'ViÃ¡Â»â€¡n trÃ†Â°Ã¡Â»Å¸ng'}`;
      const intro = `KÃƒÂ­nh gÃ¡Â»Â­i QuÃƒÂ½ Ãƒâ€ng/BÃƒÂ ,<br/><br/>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c xin nhÃ¡ÂºÂ¯c (nÃ¡Â»â„¢i bÃ¡Â»â„¢): Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t <strong>${coopEscHtml(T.label)}</strong>, mÃƒÂ£ <strong>${coopEscHtml(ma)}</strong>, hiÃ¡Â»â€¡n <strong>${stepLabel}</strong>. Ã„ÂÃ¡Â»Â nghÃ¡Â»â€¹ xem xÃƒÂ©t xÃ¡Â»Â­ lÃƒÂ½ theo quy Ã„â€˜Ã¡Â»â€¹nh.`;
      const stLabel = STATUS_LABELS_COOP[st] || st;
      const html = coopBuildEmail('NhÃ¡ÂºÂ¯c xÃ¡Â»Â­ lÃƒÂ½ Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t (nÃ¡Â»â„¢i bÃ¡Â»â„¢)', intro, [['MÃƒÂ£', ma], ['TrÃ¡ÂºÂ¡ng thÃƒÂ¡i', stLabel]], 'TrÃƒÂ¢n trÃ¡Â»Âng,<br/>HÃ¡Â»â€¡ thÃ¡Â»â€˜ng QuÃ¡ÂºÂ£n lÃƒÂ½ HÃ¡Â»Â£p tÃƒÂ¡c QuÃ¡Â»â€˜c tÃ¡ÂºÂ¿ Ã¢â‚¬â€ ViÃ¡Â»â€¡n TÃ¡ÂºÂ¿ bÃƒÂ o gÃ¡Â»â€˜c', moduleUrl);
      const text = `KÃƒÂ­nh gÃ¡Â»Â­i,\n\nNhÃ¡ÂºÂ¯c nÃ¡Â»â„¢i bÃ¡Â»â„¢ xÃ¡Â»Â­ lÃƒÂ½: ${T.label} Ã¢â‚¬â€ mÃƒÂ£ ${ma}.\nTrÃ¡ÂºÂ¡ng thÃƒÂ¡i: ${stLabel}.\n${moduleUrl}\n`;
      coopSendMail({ to, subject, html, text })
        .then(() => {
          try {
            db.prepare(`UPDATE ${T.table} SET coop_reminder_last_at = datetime('now') WHERE id = ?`).run(row.id);
          } catch (e2) { console.error('[CoopReminder] LÃ¡Â»â€”i cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t:', e2.message); }
        })
        .catch(err => console.error('[CoopReminder] GÃ¡Â»Â­i lÃ¡Â»â€”i:', err.message));
    }
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
setInterval(sendCoopStaleStepReminders, ONE_DAY_MS);
setTimeout(sendCoopStaleStepReminders, 60 * 60 * 1000);

/** NhÃ¡ÂºÂ¯c nÃ¡Â»â„¢p minh chÃ¡Â»Â©ng HN/HT: sau conf_end_date + 15 ngÃƒÂ y, gÃ¡Â»Â­i mÃ¡Â»â„¢t lÃ¡ÂºÂ§n (evidence_reminder_sent_at). ChÃ¡ÂºÂ¡y khi giÃ¡Â»Â mÃƒÂ¡y chÃ¡Â»Â§ = 8. */
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
            console.error('[HNHT reminder] LÃ¡Â»â€”i cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t:', e2.message);
          }
        })
        .catch((err) => console.error('[HNHT reminder] GÃ¡Â»Â­i lÃ¡Â»â€”i:', err.message));
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
      if (r && r.sent > 0) console.log('[ThoaThuanExpiry] HoÃƒÂ n tÃ¡ÂºÂ¥t: Ã„â€˜ÃƒÂ£ gÃ¡Â»Â­i', r.sent, 'email.');
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
        message: 'Enrichment hoÃƒÂ n tÃ¡ÂºÂ¥t',
        stats,
      });
    } catch (e) {
      console.error('[enrich/trigger]', e);
      return res.status(500).json({ message: 'LÃ¡Â»â€”i enrichment' });
    }
  });

  app.get('/api/enrich/stats', authMiddleware, async (req, res) => {
    try {
      const stats = await enrichService.getEnrichmentStats();
      return res.json(stats);
    } catch (e) {
      console.error('[enrich/stats]', e);
      return res.status(500).json({ message: 'LÃ¡Â»â€”i thÃ¡Â»â€˜ng kÃƒÂª enrichment' });
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
        if (err) return res.status(400).json({ message: 'Upload thÃ¡ÂºÂ¥t bÃ¡ÂºÂ¡i' });
        next();
      });
    },
    async (req, res) => {
      try {
        const year = parseInt(req.body?.year, 10);
        if (!Number.isFinite(year) || year < 1900 || year > 2100) {
          return res.status(400).json({ message: 'NÃ„Æ’m SJR khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (1900Ã¢â‚¬â€œ2100)' });
        }
        const buf = req.file?.buffer;
        if (!buf || !buf.length) {
          return res.status(400).json({ message: 'Vui lÃƒÂ²ng chÃ¡Â»Ân file CSV (tÃƒÂªn field: file)' });
        }
        const csvText = buf.toString('utf8');
        const result = await importScimagoCsvToJournalMetrics(db, csvText, year);
        return res.json({
          message: `Import SJR ${year}: ${result.ok} dÃƒÂ²ng OK, ${result.fail} lÃ¡Â»â€”i/bÃ¡Â»Â qua (tÃ¡Â»â€¢ng ${result.total} dÃƒÂ²ng CSV)`,
          ...result,
        });
      } catch (e) {
        console.error('[sjr-csv-import]', e);
        return res.status(500).json({ message: 'LÃ¡Â»â€”i import SJR' });
      }
    }
  );

  app.post('/api/admin/journal-metrics/update-if', authMiddleware, adminOnly, (req, res) => {
    try {
      const issnNorm = normalizeIssnJournalMetricsInput(req.body?.issn);
      if (!issnNorm || !/^\d{4}-[\dX]{4}$/i.test(issnNorm)) {
        return res.status(400).json({ message: 'ISSN phÃ¡ÂºÂ£i Ã„â€˜ÃƒÂºng Ã„â€˜Ã¡Â»â€¹nh dÃ¡ÂºÂ¡ng XXXX-XXXX' });
      }
      const year = parseInt(req.body?.year, 10);
      if (!Number.isFinite(year) || year < 1900 || year > 2100) {
        return res.status(400).json({ message: 'NÃ„Æ’m khÃƒÂ´ng hÃ¡Â»Â£p lÃ¡Â»â€¡ (1900Ã¢â‚¬â€œ2100)' });
      }
      const jcrIf = Number(req.body?.jcr_if);
      if (!Number.isFinite(jcrIf) || jcrIf <= 0) {
        return res.status(400).json({ message: 'jcr_if phÃ¡ÂºÂ£i lÃƒÂ  sÃ¡Â»â€˜ dÃ†Â°Ã†Â¡ng' });
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
          message: 'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y bÃ¡ÂºÂ£n ghi journal_metrics khÃ¡Â»â€ºp ISSN vÃƒÂ  nÃ„Æ’m SJR',
        });
      }
      return res.json({ ok: true, message: 'Ã„ÂÃƒÂ£ cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t JCR IF', changes });
    } catch (e) {
      console.error('[journal-metrics/update-if]', e);
      return res.status(500).json({ message: 'LÃ¡Â»â€”i CSDL' });
    }
  });

  // CÃƒÂ´ng bÃ¡Â»â€˜ khoa hÃ¡Â»Âc Ã¢â‚¬â€ 5 endpoint bÃ¡Â»â€¢ sung Ã„â€˜ÃƒÂ£ tÃƒÂ¡ch sang routes/publications/boSung.js.
  // PHÃ¡ÂºÂ¢I mount trÃ†Â°Ã¡Â»â€ºc app.use('/api/publications', pubMod.publicationsRouter) Ã„â€˜Ã¡Â»Æ’ khÃƒÂ´ng bÃ¡Â»â€¹ :id nuÃ¡Â»â€˜t.
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

  // Ã¢â€â‚¬Ã¢â€â‚¬ CÃƒÂ´ng tÃ¡ÂºÂ¯c Harvest (bÃ¡ÂºÂ­t/tÃ¡ÂºÂ¯t tÃ¡Â»Â« giao diÃ¡Â»â€¡n) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // NguÃ¡Â»â€œn sÃ¡Â»Â± thÃ¡ÂºÂ­t Ã„â€˜Ã¡ÂºÂ·t tÃ¡ÂºÂ¡i Ã„â€˜ÃƒÂ¢y (sci-ace.db) chÃ¡Â»Â© khÃƒÂ´ng Ã¡Â»Å¸ module con: module con
  // dÃƒÂ¹ng DB riÃƒÂªng (sci_khcn.db), trong khi cÃƒÂ´ng tÃ¡ÂºÂ¯c phÃ¡ÂºÂ£i chÃ¡ÂºÂ·n Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ£ hai lÃ¡Â»â€˜i
  // vÃƒÂ o Ã¢â‚¬â€ POST /api/orcid/harvest vÃƒÂ  GET /api/orcid/harvest/stream (SSE).
  // MÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh TÃ¡ÂºÂ®T: sau khi deploy hoÃ¡ÂºÂ·c khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng lÃ¡ÂºÂ¡i, harvest khÃƒÂ´ng tÃ¡Â»Â± chÃ¡ÂºÂ¡y.
  const ORCID_HARVEST_KEY = 'orcid_harvest_enabled';

  function isOrcidHarvestEnabled() {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(ORCID_HARVEST_KEY);
      return !!row && String(row.value) === '1';
    } catch (e) {
      // KhÃƒÂ´ng Ã„â€˜Ã¡Â»Âc Ã„â€˜Ã†Â°Ã¡Â»Â£c trÃ¡ÂºÂ¡ng thÃƒÂ¡i Ã¢â€ â€™ coi nhÃ†Â° tÃ¡ÂºÂ¯t; an toÃƒÂ n hÃ†Â¡n lÃƒÂ  Ã„â€˜Ã¡Â»Æ’ chÃ¡ÂºÂ¡y ngoÃƒÂ i kiÃ¡Â»Æ’m soÃƒÂ¡t.
      console.error('[orcid-harvest] KhÃƒÂ´ng Ã„â€˜Ã¡Â»Âc Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃƒÂ´ng tÃ¡ÂºÂ¯c:', e && e.message ? e.message : e);
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
      console.error('[orcid-harvest] KhÃƒÂ´ng lÃ†Â°u Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃƒÂ´ng tÃ¡ÂºÂ¯c:', e && e.message ? e.message : e);
      return res.status(500).json({ ok: false, message: 'KhÃƒÂ´ng lÃ†Â°u Ã„â€˜Ã†Â°Ã¡Â»Â£c trÃ¡ÂºÂ¡ng thÃƒÂ¡i Harvest.' });
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
      `[orcid-harvest] ${enabled ? 'BÃ¡ÂºÂ¬T' : 'TÃ¡ÂºÂ®T'} bÃ¡Â»Å¸i ${(req.user && req.user.email) || 'khÃƒÂ´ng rÃƒÂµ'}`
    );
    return res.json({ ok: true, enabled });
  });

  // ChÃ¡ÂºÂ·n khi cÃƒÂ´ng tÃ¡ÂºÂ¯c tÃ¡ÂºÂ¯t. Ã„ÂÃ„Æ’ng kÃƒÂ½ theo Ã„â€˜ÃƒÂºng tÃ¡Â»Â«ng route (khÃƒÂ´ng dÃƒÂ¹ng tiÃ¡Â»Ân tÃ¡Â»â€˜
  // '/api/orcid/harvest') Ã„â€˜Ã¡Â»Æ’ khÃƒÂ´ng vÃƒÂ´ tÃƒÂ¬nh chÃ¡ÂºÂ·n luÃƒÂ´n hai route /enabled Ã¡Â»Å¸ trÃƒÂªn.
  function requireHarvestEnabled(req, res, next) {
    if (isOrcidHarvestEnabled()) return next();
    const message = 'ChÃ¡Â»Â©c nÃ„Æ’ng Harvest Ã„â€˜ang TÃ¡ÂºÂ®T. BÃ¡ÂºÂ­t cÃƒÂ´ng tÃ¡ÂºÂ¯c Ã¡Â»Å¸ trang ORCID Auto-Harvest trÃ†Â°Ã¡Â»â€ºc khi quÃƒÂ©t.';
    // SSE: client lÃƒÂ  EventSource, chÃ¡Â»â€° hiÃ¡Â»Æ’u Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃƒÂ´ng bÃƒÂ¡o qua chÃƒÂ­nh luÃ¡Â»â€œng sÃ¡Â»Â± kiÃ¡Â»â€¡n.
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

  // KhÃ¡Â»â€˜i "QuÃ¡ÂºÂ£n lÃƒÂ½ nghiÃƒÂªn cÃ¡Â»Â©u viÃƒÂªn (ORCID)" vÃƒÂ  "DuyÃ¡Â»â€¡t import" trÃƒÂªn trang QuÃ¡ÂºÂ£n lÃƒÂ½
  // cÃƒÂ´ng bÃ¡Â»â€˜ lÃƒÂ  thao tÃƒÂ¡c cÃ¡Â»Â§a riÃƒÂªng Admin. Router con (module sci-khcn-publications)
  // khÃƒÂ´ng cÃƒÂ³ lÃ¡Â»â€ºp phÃƒÂ¢n quyÃ¡Â»Ân nÃƒÂ o, nÃƒÂªn chÃ¡ÂºÂ·n tÃ¡ÂºÂ¡i Ã„â€˜ÃƒÂ¢y TRÃ†Â¯Ã¡Â»Å¡C khi mount Ã¢â‚¬â€ giao diÃ¡Â»â€¡n Ã„â€˜ÃƒÂ£
  // Ã¡ÂºÂ©n bÃ¡ÂºÂ±ng .pub-admin-only, nhÃ†Â°ng lÃ¡Â»â€ºp Ã¡ÂºÂ©n Ã„â€˜ÃƒÂ³ dÃ¡Â»Â±a trÃƒÂªn localStorage nÃƒÂªn khÃƒÂ´ng Ã„â€˜Ã¡Â»Â§.
  // ChÃ¡Â»â€° khoÃƒÂ¡ thao tÃƒÂ¡c GHI; GET danh sÃƒÂ¡ch vÃ¡ÂºÂ«n Ã„â€˜Ã¡Â»Æ’ nguyÃƒÂªn cho trang Auto-Harvest.
  app.post('/api/orcid/researchers', authMiddleware, masterAdminOnly);
  app.delete('/api/orcid/researchers/:id', authMiddleware, masterAdminOnly);
  app.post('/api/orcid/queue/:id/approve', authMiddleware, adminOnly);
  app.post('/api/orcid/queue/:id/reject', authMiddleware, adminOnly);
  app.post('/api/orcid/queue/approve-all', authMiddleware, adminOnly);

  app.use('/api/orcid', orcidMod.orcidRouter);
  app.use('/api/doi', doiMod.doiRouter);
  console.log('[SCI-KHCN] Ã„ÂÃƒÂ£ mount /api/publications, /api/orcid, /api/doi');
}

(async () => {
  try {
    await mountSciKhcnPublicationsRouters();
  } catch (e) {
    console.error('[SCI-KHCN] KhÃƒÂ´ng mount Ã„â€˜Ã†Â°Ã¡Â»Â£c publications module:', e.message);
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
        'KhÃƒÂ´ng tÃƒÂ¬m thÃ¡ÂºÂ¥y API: ' +
        req.method +
        ' ' +
        p +
        '. NÃ¡ÂºÂ¿u vÃ¡Â»Â«a cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t code, hÃƒÂ£y khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng lÃ¡ÂºÂ¡i server (Ctrl+C rÃ¡Â»â€œi node server.js).',
    });
  });

  const bindHost =
    process.env.BIND_HOST != null && String(process.env.BIND_HOST).trim() !== ''
      ? String(process.env.BIND_HOST).trim()
      : undefined;
  function onListen() {
    const hostLabel = bindHost || '(mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh Node)';
    console.log('SCI-ACE server lÃ¡ÂºÂ¯ng nghe PORT=' + PORT + ' host=' + hostLabel);
    console.log('KiÃ¡Â»Æ’m tra kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i: http://127.0.0.1:' + PORT + '/api/health');
    console.log(`[clock] TZ=${process.env.TZ} (Vietnam civil time / ICT; override with TZ in .env)`);
    logServerTimeDriftVsGoogle();
    if (transporter) console.log('SMTP Ã„â€˜ÃƒÂ£ cÃ¡ÂºÂ¥u hÃƒÂ¬nh Ã¢â‚¬â€ email thÃƒÂ´ng bÃƒÂ¡o sÃ¡ÂºÂ½ gÃ¡Â»Â­i khi cÃƒÂ³ sÃ¡Â»Â± kiÃ¡Â»â€¡n (nÃ¡Â»â„¢p hÃ¡Â»â€œ sÃ†Â¡, yÃƒÂªu cÃ¡ÂºÂ§u bÃ¡Â»â€¢ sung, kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ hÃ¡Â»Âp...)');
    else console.log('ChÃ†Â°a cÃ¡ÂºÂ¥u hÃƒÂ¬nh SMTP Ã¢â‚¬â€ kiÃ¡Â»Æ’m tra file .env (SMTP_HOST, SMTP_USER, SMTP_PASS). Email thÃƒÂ´ng bÃƒÂ¡o sÃ¡ÂºÂ½ khÃƒÂ´ng gÃ¡Â»Â­i.');
    console.log('Email nhÃ¡ÂºÂ¯c nhÃ¡Â»Å¸ duyÃ¡Â»â€¡t Ã„â€˜Ã¡Â»Â xuÃ¡ÂºÂ¥t: mÃ¡Â»â€”i 3 ngÃƒÂ y (phong cÃƒÂ¡ch hÃƒÂ nh chÃƒÂ­nh nhÃƒÂ  nÃ†Â°Ã¡Â»â€ºc)');
    try {
      startWorker();
    } catch (e) {
      console.error('[EnrichWorker] KhÃƒÂ´ng khÃ¡Â»Å¸i Ã„â€˜Ã¡Â»â„¢ng Ã„â€˜Ã†Â°Ã¡Â»Â£c:', e.message || e);
    }
  }
  const httpServer = bindHost ? app.listen(PORT, bindHost, onListen) : app.listen(PORT, onListen);
  // XÃ¡Â»Â­ lÃƒÂ½ tÃ†Â°Ã¡Â»Âng minh lÃ¡Â»â€”i bind (EADDRINUSE, EACCES...): log + exit(1) Ã„â€˜Ã¡Â»Æ’ PM2/systemd
  // restart sÃ¡ÂºÂ¡ch, trÃƒÂ¡nh trÃ¡ÂºÂ¡ng thÃƒÂ¡i zombie "process cÃƒÂ²n sÃ¡Â»â€˜ng nhÃ†Â°ng khÃƒÂ´ng listen"
  // do uncaughtException handler mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh chÃ¡Â»â€° log.
  httpServer.on('error', (err) => {
    const code = err && err.code ? err.code : '(unknown-code)';
    if (code === 'EADDRINUSE') {
      console.error(
        `[FATAL] KhÃƒÂ´ng bind Ã„â€˜Ã†Â°Ã¡Â»Â£c PORT=${PORT} (EADDRINUSE): mÃ¡Â»â„¢t tiÃ¡ÂºÂ¿n trÃƒÂ¬nh khÃƒÂ¡c Ã„â€˜ÃƒÂ£ chiÃ¡ÂºÂ¿m port.\n` +
          `        Kill tiÃ¡ÂºÂ¿n trÃƒÂ¬nh cÃ…Â© rÃ¡Â»â€œi thÃ¡Â»Â­ lÃ¡ÂºÂ¡i. TrÃƒÂªn Windows: netstat -ano | findstr :${PORT}\n` +
          `        TrÃƒÂªn Linux: lsof -i :${PORT}`
      );
    } else if (code === 'EACCES') {
      console.error(
        `[FATAL] KhÃƒÂ´ng cÃƒÂ³ quyÃ¡Â»Ân bind PORT=${PORT} (EACCES). DÃƒÂ¹ng port >1024 hoÃ¡ÂºÂ·c chÃ¡ÂºÂ¡y vÃ¡Â»â€ºi quyÃ¡Â»Ân phÃƒÂ¹ hÃ¡Â»Â£p.`
      );
    } else {
      console.error('[FATAL] app.listen error:', code, err && err.stack ? err.stack : err);
    }
    process.exit(1);
  });
})();
