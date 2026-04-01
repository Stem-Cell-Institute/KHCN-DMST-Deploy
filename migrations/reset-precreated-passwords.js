/**
 * Migration một lần: đưa tài khoản được admin tạo trước (vai trò đặc biệt)
 * về trạng thái chưa kích hoạt — xóa mật khẩu đăng nhập để user tự đặt qua /api/register.
 *
 * Không đổi: id, email, fullname, role, các cột khác.
 * Không reset: admin, researcher, crd_user (tài khoản tự đăng ký / chỉ CRD).
 *
 * Cột password trong schema là NOT NULL → thường dùng '' làm sentinel;
 * nếu DB cho phép NULL, có thể dùng NULL (script thử NULL trước).
 *
 * Chạy: npm run migrate:reset-precreated
 */

const path = require('path');
const Database = require('better-sqlite3');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}

const sqlitePath = path.join(__dirname, '..', 'data', process.env.SQLITE_FILENAME || 'sci-ace.db');

const WHERE_ROLES =
  "lower(trim(coalesce(role,''))) NOT IN ('admin', 'researcher', 'crd_user')";

function main() {
  console.log('[migrate:reset-precreated] File DB:', sqlitePath);
  const db = new Database(sqlitePath);
  db.pragma('foreign_keys = ON');

  const selectEmails = db.prepare(
    `SELECT id, email, role FROM users WHERE ${WHERE_ROLES} AND (
      password IS NOT NULL AND trim(coalesce(password,'')) != ''
    )`
  );

  const rows = selectEmails.all();
  if (rows.length === 0) {
    console.log('[migrate:reset-precreated] Không có tài khoản nào cần reset (hoặc đã trống mật khẩu).');
    db.close();
    return;
  }

  console.log('[migrate:reset-precreated] Sẽ reset mật khẩu cho', rows.length, 'tài khoản:');
  rows.forEach((r) => console.log('  -', r.email, '(' + r.role + ', id=' + r.id + ')'));

  let usedNull = false;
  try {
    const upd = db.prepare(
      `UPDATE users SET password = NULL, password_support_hint = NULL WHERE ${WHERE_ROLES}`
    );
    const info = upd.run();
    usedNull = true;
    console.log('[migrate:reset-precreated] Đã UPDATE (password = NULL), số dòng:', info.changes);
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes('NOT NULL') || e.code === 'SQLITE_CONSTRAINT_NOTNULL' || msg.includes('constraint')) {
      console.log('[migrate:reset-precreated] Không ghi được NULL → dùng chuỗi rỗng làm sentinel (NOT NULL).');
      const upd = db.prepare(
        `UPDATE users SET password = '', password_support_hint = NULL WHERE ${WHERE_ROLES}`
      );
      const info = upd.run();
      console.log('[migrate:reset-precreated] Đã UPDATE (password = \'\'), số dòng:', info.changes);
    } else {
      db.close();
      throw e;
    }
  }

  if (usedNull) {
    console.log('[migrate:reset-precreated] Danh sách email đã reset (NULL):');
  } else {
    console.log('[migrate:reset-precreated] Danh sách email đã reset (sentinel rỗng):');
  }
  rows.forEach((r) => console.log('  ', r.email));

  db.close();
  console.log('[migrate:reset-precreated] Xong.');
}

main();
