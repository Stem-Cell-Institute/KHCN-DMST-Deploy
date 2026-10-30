'use strict';

/**
 * tests/helpers/users.js
 * Thêm tài khoản vào DB HỘP CÁT của server test (không đụng dữ liệu thật) và ký token cho họ.
 *
 * Vai trò ở DB quyết định quyền (authMiddleware đọc lại vai trò từ DB mỗi request), còn token chỉ
 * mang id. Riêng `crd_user` thì authMiddleware còn đọc vai trò TRONG TOKEN để chặn mọi đường dẫn
 * ngoài /api/crd/ — nên token và DB phải cùng vai trò.
 */

const path = require('path');

const CODE_ROOT = path.resolve(__dirname, '..', '..');
let seq = 0;

/**
 * @param srv    kết quả của startTestServer() (cần srv.dbPath)
 * @param opts   { fullname, role }
 * @returns      { id, email, token, personId } — personId là id hồ sơ CRD sẽ được tạo cho họ
 */
function addUser(srv, { fullname, role }) {
  const Database = require(path.join(CODE_ROOT, 'node_modules', 'better-sqlite3'));
  const jwt = require(path.join(CODE_ROOT, 'node_modules', 'jsonwebtoken'));
  const email = 'test-' + Date.now().toString(36) + '-' + (++seq) + '-' + Math.floor(Math.random() * 1e6) + '@sci.edu.vn';
  const db = new Database(srv.dbPath);
  let id;
  try {
    id = Number(db.prepare('INSERT INTO users (email, password, fullname, role) VALUES (?, ?, ?, ?)').run(email, 'x', fullname, role).lastInsertRowid);
  } finally {
    db.close();
  }
  const token = jwt.sign({ id, email, role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  return { id, email, token, personId: 'u_app_' + id };
}

module.exports = { addUser };
