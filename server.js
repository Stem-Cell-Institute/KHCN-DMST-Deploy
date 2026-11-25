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
const express = require('express');
const rateLimitLib = require('express-rate-limit');
const rateLimit = rateLimitLib.rateLimit || rateLimitLib;
const ipKeyGenerator =
  rateLimitLib.ipKeyGenerator ||
  ((ip) => {
    const raw = String(ip || '').trim();
    return raw || 'unknown';
  });
const { startWorker } = require(path.join(__dirname, 'services', 'enrichmentWorker.js'));

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
require('./bootstrap/appSetup')({ app, ipKeyGenerator, rateLimit, rootDir: __dirname });

// Route kiểm tra sớm nhất (trước middleware)
const { logServerTimeDriftVsGoogle } = require('./routes/core/healthVaTime')({ app, rootDir: __dirname });

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
const {
  adminOnly,
  authMiddleware,
  insertUserActivityLog,
  masterAdminOnly,
  transporter,
  uploadSjrCsv,
} = require('./bootstrap/mountAllRoutes')({
  ADMIN_EMAIL,
  ALLOWED_EMAIL_DOMAIN,
  BODY_JSON_LIMIT_STR,
  CRD_BROADCAST_TO_ID,
  CRD_ONLY_USER_ROLE,
  JWT_SECRET,
  MULTIPART_MAX_FIELD_BYTES,
  PORT,
  UPLOAD_FILE_BYTES_CAP_PUBLIC_TEMPLATE,
  UPLOAD_FILE_BYTES_CAP_VIEN,
  UPLOAD_FILE_BYTES_SJR_CSV,
  UPLOAD_FILE_BYTES_SUBMISSION,
  app,
  isSafeEmailFormat,
  rootDir: __dirname,
});
require('./bootstrap/startServer')({
  PORT,
  adminOnly,
  app,
  authMiddleware,
  insertUserActivityLog,
  logServerTimeDriftVsGoogle,
  masterAdminOnly,
  startWorker,
  transporter,
  uploadSjrCsv,
  rootDir: __dirname,
});
