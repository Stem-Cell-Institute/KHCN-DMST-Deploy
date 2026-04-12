/**
 * Đường dẫn dữ liệu có thể ghi (SQLite, uploads) — tách khỏi thư mục code để deploy an toàn.
 *
 * Mặc định (dev): giữ hành vi cũ — data/ và uploads/ nằm cạnh server.js.
 *
 * Production: đặt APP_DATA_DIR trỏ tới thư mục riêng (vd. /var/lib/khcn-dmst), backup/rsync
 * chỉ thay code; không đè lên DB và file upload.
 *
 * Biến môi trường (tùy chọn):
 *   APP_DATA_DIR       — thư mục gốc dữ liệu: chứa sci-ace.db, uploads/, uploads-cap-vien/
 *   SQLITE_PATH        — đường dẫn tuyệt đối file SQLite (ghi đè mọi quy tắc khác cho file DB)
 *   SQLITE_DATA_DIR    — thư mục chứa file DB (mặc định tên file = SQLITE_FILENAME hoặc sci-ace.db)
 *   SQLITE_FILENAME    — tên file trong SQLITE_DATA_DIR hoặc APP_DATA_DIR
 *   UPLOADS_DIR        — thư mục uploads chính (GĐ, missions, events, htqt, dms…)
 *   UPLOADS_CAP_VIEN_DIR — thư mục uploads đề tài cấp Viện
 */

const path = require('path');

try {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') });
} catch (_) {}

const CODE_ROOT = path.resolve(__dirname, '..');

function trimmedEnv(name) {
  const v = process.env[name];
  if (v == null) return '';
  const s = String(v).trim();
  return s;
}

function resolveAppDataDir() {
  const s = trimmedEnv('APP_DATA_DIR');
  return s ? path.resolve(s) : null;
}

const _appDataDir = resolveAppDataDir();

function sqliteDataDir() {
  const explicit = trimmedEnv('SQLITE_DATA_DIR');
  if (explicit) return path.resolve(explicit);
  if (_appDataDir) return _appDataDir;
  return path.join(CODE_ROOT, 'data');
}

function sqliteFilePath() {
  const fullPath = trimmedEnv('SQLITE_PATH');
  if (fullPath) return path.resolve(fullPath);
  const dir = sqliteDataDir();
  const name = trimmedEnv('SQLITE_FILENAME') || 'sci-ace.db';
  return path.join(dir, name);
}

function uploadsRoot() {
  const explicit = trimmedEnv('UPLOADS_DIR');
  if (explicit) return path.resolve(explicit);
  if (_appDataDir) return path.join(_appDataDir, 'uploads');
  return path.join(CODE_ROOT, 'uploads');
}

function uploadsCapVienRoot() {
  const explicit = trimmedEnv('UPLOADS_CAP_VIEN_DIR');
  if (explicit) return path.resolve(explicit);
  if (_appDataDir) return path.join(_appDataDir, 'uploads-cap-vien');
  return path.join(CODE_ROOT, 'uploads-cap-vien');
}

function capVienPublicTemplatesDir() {
  return path.join(uploadsCapVienRoot(), 'public-templates');
}

function dmsUploadsDir() {
  return path.join(uploadsRoot(), 'dms');
}

module.exports = {
  CODE_ROOT,
  /** Thư mục APP_DATA_DIR nếu đã cấu hình, ngược lại null */
  appDataDir: _appDataDir,
  sqliteDataDir,
  sqliteFilePath,
  uploadsRoot,
  uploadsCapVienRoot,
  capVienPublicTemplatesDir,
  dmsUploadsDir,
};
