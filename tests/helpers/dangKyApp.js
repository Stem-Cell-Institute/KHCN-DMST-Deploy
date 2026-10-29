/**
 * tests/helpers/dangKyApp.js
 * Dựng luồng đăng ký có xác minh email trong CÙNG tiến trình test, không cần server STIMS đầy đủ:
 *   - router THẬT (routes/dangKy.js) + dịch vụ THẬT (services/xacMinhEmail.js), bcrypt và jwt THẬT
 *   - DB :memory: chỉ có bảng users với đúng các cột đăng ký đụng tới → không đụng data/sci-ace.db
 *   - hộp thư GIẢ: mọi email định gửi được ghi vào `ung.thu`; test có thể đặt `ung.cheDoMail` để giả lỗi SMTP
 *   - `tuyChon.coSmtp = false` giả lập SMTP chưa cấu hình (mailSend = null, như server.js khi thiếu SMTP_*)
 */

const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const express = require(path.join(ROOT, 'node_modules', 'express'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
const createDangKyRouter = require(path.join(ROOT, 'routes', 'dangKy'));

const JWT_SECRET = 'bi-mat-chi-dung-trong-test';

async function dungUngDung(tuyChon = {}) {
  const db = new Database(':memory:');
  // Khớp lược đồ thật ở server.js: password TEXT NOT NULL ('' = tài khoản tạo sẵn chưa kích hoạt).
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    fullname TEXT,
    role TEXT DEFAULT 'researcher',
    is_banned INTEGER DEFAULT 0
  )`);

  const ung = { db, thu: [], cheDoMail: null, bcrypt, jwt, JWT_SECRET };
  const coSmtp = tuyChon.coSmtp !== false;
  const mailSend = coSmtp
    ? async (o) => {
        if (ung.cheDoMail) return ung.cheDoMail(o);
        ung.thu.push(o);
        return { ok: true };
      }
    : null;

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api/register',
    createDangKyRouter({
      db,
      mailSend,
      baseUrl: 'https://eoffice.test/',
      bcrypt,
      jwt,
      JWT_SECRET,
      setAuthCookie: (res, token) => res.append('Set-Cookie', 'auth_token=' + encodeURIComponent(token) + '; HttpOnly'),
      userEmailIsMasterAdmin: (e) => e === 'master@sci.edu.vn',
      isSafeEmailFormat: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s)) && String(s).length <= 190,
      allowedDomain: '@sci.edu.vn',
      gioiHanGuiThu: tuyChon.gioiHanGuiThu || { windowMs: 3600 * 1000, max: 1000 },
    })
  );
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  ung.goi = async (duong, body) => {
    const r = await fetch(base + '/api/register' + duong, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let d = null;
    try { d = await r.json(); } catch (_) { /* không phải JSON */ }
    return { s: r.status, d, cookie: r.headers.get('set-cookie') };
  };
  ung.dangKy = (email, fullname = 'Nguyễn Văn Thử', them = {}) => ung.goi('', { email, fullname, ...them });

  /** Lấy mã thô từ liên kết trong thư gần nhất gửi tới `email`. */
  ung.maTuThu = (email) => {
    const t = [...ung.thu].reverse().find((x) => x.to === email);
    const m = t && /#token=([a-f0-9]{64})/.exec(t.text);
    return m ? m[1] : null;
  };
  ung.user = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  ung.taoSan = (email, vaiTro = 'thu_ky', fullname = 'Tài khoản tạo sẵn') =>
    db.prepare("INSERT INTO users (email, password, fullname, role) VALUES (?, '', ?, ?)").run(email, fullname, vaiTro);
  ung.soHang = () => db.prepare('SELECT COUNT(*) AS n FROM email_verifications').get().n;
  /** Lùi thời điểm tạo của mọi mã của `email` để qua được khoảng cách 60 giây. */
  ung.lui = (email, ms) => {
    const rows = db.prepare('SELECT id, created_at FROM email_verifications WHERE email = ?').all(email);
    for (const r of rows) {
      db.prepare('UPDATE email_verifications SET created_at = ? WHERE id = ?').run(new Date(Date.parse(r.created_at) - ms).toISOString(), r.id);
    }
  };

  ung.dung = async () => {
    await new Promise((r) => server.close(r));
    db.close();
  };
  return ung;
}

module.exports = { dungUngDung, JWT_SECRET };
