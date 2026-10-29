/**
 * tests/helpers/baoCaoPhongApp.js
 * Dựng module Báo cáo phòng ban trong CÙNG tiến trình test, không cần server STIMS đầy đủ:
 *   - router THẬT (routes/baoCaoPhong.js), lược đồ THẬT (services/baoCaoPhongSchema.js)
 *   - DB :memory: chỉ có bảng users tối thiểu → không đụng data/sci-ace.db, chạy được ở CI không có DB
 *   - xác thực GIẢ: header x-nguoi-dung = id người dùng (authMiddleware thật nằm ở server.js)
 *   - hộp thư GIẢ: mọi email module định gửi được ghi vào `ung.thu` để test soi người nhận/nội dung
 *   - thư mục tệp tải lên là thư mục tạm riêng, dọn sau mỗi lần chạy
 *
 * Vì sao có helper này bên cạnh tests/helpers/testServer.js: test email và tải tệp cần soi kết quả
 * bên trong (thư đã gửi cho ai, tệp nằm ở đâu trên đĩa), điều không làm được qua một server riêng.
 * Phần phân quyền theo vai trò users.role/authMiddleware vẫn do tests/baoCaoPhong.test.js phủ.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const express = require(path.join(ROOT, 'node_modules', 'express'));
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
const createBaoCaoPhongRouter = require(path.join(ROOT, 'routes', 'baoCaoPhong'));

/** Người dùng tổng hợp. role là vai trò CHUNG của hệ thống (users.role), không phải vai trò trong module. */
const NGUOI_DUNG = [
  { id: 1, email: 'admin@thu.local', fullname: 'Quản Trị', role: 'admin' },
  { id: 2, email: 'quanly@thu.local', fullname: 'Nguyễn Quản Lý', role: 'researcher' },
  { id: 3, email: 'vientruong@thu.local', fullname: 'Phạm Viện Trưởng', role: 'researcher' },
  { id: 4, email: 'tpa@thu.local', fullname: 'Trần Trưởng Phòng A', role: 'researcher' },
  { id: 5, email: 'tpb@thu.local', fullname: 'Lê Trưởng Phòng B', role: 'researcher' },
  { id: 6, email: 'ngoai@thu.local', fullname: 'Hoàng Người Ngoài', role: 'researcher' },
  // Có vai trò CHUNG vien_truong nhưng KHÔNG được gán gì trong module: không được có quyền ở đây.
  { id: 7, email: 'vtchung@thu.local', fullname: 'Vũ Viện Trưởng Chung', role: 'vien_truong' },
];

async function dungUngDung(tuyChon = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, fullname TEXT, role TEXT)');
  for (const u of NGUOI_DUNG) db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(u.id, u.email, u.fullname, u.role);

  const uploadsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcp-tep-'));
  const ung = {
    db,
    uploadsRoot,
    thu: [], // các email đã "gửi"
    cheDoMail: tuyChon.mailSend || null, // test có thể thay bằng hàm ném lỗi
    NGUOI_DUNG,
    nguoi: NGUOI_DUNG.map((u) => ({ ...u })), // bản riêng của app này: dangKy() thêm người dùng mới vào đây
  };

  const mailSend = async (o) => {
    if (ung.cheDoMail) return ung.cheDoMail(o);
    ung.thu.push(o);
    return { ok: true };
  };

  const router = createBaoCaoPhongRouter({ db, mailSend, uploadsRoot, baseUrl: 'https://eoffice.test' });
  ung.nhacHan = router.nhacHan; // bộ nhắc hạn: test gọi chayMotLan(thờiGian) trực tiếp, không bật hẹn giờ

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    '/api/bao-cao-phong',
    (req, res, next) => {
      const u = ung.nguoi.find((x) => x.id === Number(req.headers['x-nguoi-dung']));
      if (!u) return res.status(401).json({ message: 'Chưa đăng nhập' });
      req.user = { id: u.id, email: u.email, fullname: u.fullname, role: u.role };
      next();
    },
    router
  );

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  ung.base = 'http://127.0.0.1:' + server.address().port;

  /** Gọi API với tư cách người dùng `uid`. Trả Response gốc của fetch. */
  ung.goi = (uid, metodo, duong, body) =>
    fetch(ung.base + '/api/bao-cao-phong' + duong, {
      method: metodo,
      headers: { ...(uid ? { 'x-nguoi-dung': String(uid) } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  ung.json = async (uid, metodo, duong, body) => {
    const r = await ung.goi(uid, metodo, duong, body);
    let d = null;
    try { d = await r.json(); } catch (_) { /* không phải JSON */ }
    return { s: r.status, d };
  };
  /** Tải tệp lên (multipart). noiDung là Buffer. */
  ung.taiTep = async (uid, duong, tenTep, noiDung, truong = 'tep') => {
    const f = new FormData();
    f.append(truong, new Blob([noiDung]), tenTep);
    const r = await fetch(ung.base + '/api/bao-cao-phong' + duong, { method: 'POST', headers: uid ? { 'x-nguoi-dung': String(uid) } : {}, body: f });
    let d = null;
    try { d = await r.json(); } catch (_) { /* không phải JSON */ }
    return { s: r.status, d };
  };

  /** Email được gửi NỀN (không chờ), nên test phải chờ nó đến. Chờ tối đa ~1 giây. */
  ung.doiThu = async (n) => {
    for (let i = 0; i < 50 && ung.thu.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    return ung.thu.length;
  };

  /** Mô phỏng người dùng ĐĂNG KÝ tài khoản mới (hệ thống thật không xác minh email khi đăng ký). Trả về id. */
  ung.dangKy = (email, fullname) => {
    const id = Number(db.prepare('INSERT INTO users (email, fullname, role) VALUES (?,?,?)').run(email, fullname || email, 'researcher').lastInsertRowid);
    ung.nguoi.push({ id, email, fullname: fullname || email, role: 'researcher' });
    return id;
  };

  ung.dung = async () => {
    await new Promise((r) => server.close(r));
    db.close();
    fs.rmSync(uploadsRoot, { recursive: true, force: true });
  };

  return ung;
}

/** PDF tối thiểu nhưng đúng chữ ký %PDF, đủ để qua kiểm tra định dạng. */
const PDF_MAU = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

module.exports = { dungUngDung, NGUOI_DUNG, PDF_MAU };
