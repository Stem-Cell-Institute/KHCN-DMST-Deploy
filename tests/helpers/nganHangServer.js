'use strict';

// Dựng router Ngân hàng tế bào & Kháng thể với DB trong bộ nhớ + đăng nhập giả (header x-test-user).
// Dùng cho các file tests/nganHangTeBaoKhangThe*.test.js; không cần data/sci-ace.db.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const createRouter = require('../../routes/nganHangTeBaoKhangThe');

const USERS = {
  admin: { id: 1, email: 'admin@sci.edu.vn', role: 'admin' },
  manager: { id: 2, email: 'manager@sci.edu.vn', role: 'manager' },
  alice: { id: 3, email: 'alice@sci.edu.vn', role: 'researcher' },
  bob: { id: 4, email: 'bob@sci.edu.vn', role: 'researcher' },
  sv: { id: 5, email: 'sv@sci.edu.vn', role: 'researcher' }, // sinh viên, KHÔNG có hồ sơ
  truong: { id: 6, email: 'truong@sci.edu.vn', role: 'researcher' }, // trưởng nhóm
  cellbank: { id: 7, email: 'cellbank@sci.edu.vn', role: 'researcher' }, // Trưởng CIPP
};

async function dungServer() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, fullname TEXT, email TEXT, role TEXT, is_banned INTEGER DEFAULT 0)');
  for (const u of Object.values(USERS)) db.prepare('INSERT INTO users (id, fullname, email, role) VALUES (?, ?, ?, ?)').run(u.id, u.email, u.email, u.role);
  db.prepare("INSERT INTO users (id, fullname, email, is_banned) VALUES (9, 'Bị khóa', 'locked@sci.edu.vn', 1)").run();
  db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'ngan_hang_te_bao_khang_the_schema.sql'), 'utf8'));
  // Vai trò module: manager là quản lý module (users.role = 'manager' KHÔNG tự cho quyền), cellbank là Trưởng CIPP.
  db.prepare("INSERT INTO nhm_vai_tro (user_id, vai_tro) VALUES (2, 'quan_ly'), (7, 'truong_cellbank')").run();
  // alice và bob có hồ sơ «cán bộ» (không cần nhóm) để các test thêm mẫu không phải khai loại chủ.
  db.prepare("INSERT INTO nhm_ho_so (user_id, loai) VALUES (3, 'can_bo'), (4, 'can_bo')").run();

  const auditLog = [];
  const mails = []; // thư đã gửi (mailSend giả)
  const app = express();
  app.use(express.json());
  const fakeAuth = (req, res, next) => {
    const u = USERS[req.headers['x-test-user']];
    if (!u) return res.status(401).json({ message: 'Chưa đăng nhập' });
    req.user = u;
    next();
  };
  const router = createRouter({
    db,
    authMiddleware: fakeAuth,
    insertUserActivityLog: (req, row) => auditLog.push(row),
    baseUrl: 'https://eoffice.test',
    mailSend: async (o) => {
      if (ret.mailLoi) throw new Error('smtp hỏng (giả lập)');
      mails.push(o);
    },
  });
  app.use('/api/ngan-hang-te-bao-khang-the', router);
  const server = await new Promise((r) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/ngan-hang-te-bao-khang-the`;

  async function api(user, method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = Buffer.from(await res.arrayBuffer()).toString('utf8'); // giữ nguyên BOM nếu có
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Tạo sẵn 1 tủ + 1 hộp 9x9; trả id để test dùng. */
  async function taoKho() {
    const meta = (await api('manager', 'GET', '/meta')).json;
    const type = meta.containerTypes[0].id;
    const tpl99 = meta.boxTemplates.find((t) => t.rows === 9 && t.cols === 9).id;
    const f = await api('manager', 'POST', '/containers', { name: 'Tủ test', type_id: type });
    const b = await api('manager', 'POST', '/boxes', { container_id: f.json.id, template_id: tpl99, name: 'Hộp test', count: 2 });
    return { type, tpl99, container: f.json.id, box: b.json.ids[0], box2: b.json.ids[1], meta };
  }

  const ret = {
    mailLoi: false, // bật để giả lập SMTP hỏng
    api,
    base,
    db,
    auditLog,
    mails,
    router,
    taoKho,
    USERS,
    async dong() {
      server.close();
      db.close();
    },
  };
  return ret;
}

module.exports = { dungServer, USERS };
