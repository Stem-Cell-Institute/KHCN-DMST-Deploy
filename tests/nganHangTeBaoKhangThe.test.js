'use strict';

// Test độc lập cho module Ngân hàng tế bào & Kháng thể: DB trong bộ nhớ + đăng nhập giả, không cần data/sci-ace.db.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const Database = require('better-sqlite3');
const createRouter = require('../routes/nganHangTeBaoKhangThe');

const USERS = {
  admin: { id: 1, email: 'admin@sci.edu.vn', role: 'admin' },
  manager: { id: 2, email: 'manager@sci.edu.vn', role: 'manager' },
  alice: { id: 3, email: 'alice@sci.edu.vn', role: 'researcher' },
  bob: { id: 4, email: 'bob@sci.edu.vn', role: 'researcher' },
};

let server;
let base;
let db;

test.before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, fullname TEXT)');
  for (const u of Object.values(USERS)) db.prepare('INSERT INTO users (id, fullname) VALUES (?, ?)').run(u.id, u.email);
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'ngan_hang_te_bao_khang_the_schema.sql'), 'utf8'));
  // chạy lần 2 để chắc chắn schema idempotent
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'ngan_hang_te_bao_khang_the_schema.sql'), 'utf8'));

  const app = express();
  app.use(express.json());
  const fakeAuth = (req, res, next) => {
    const u = USERS[req.headers['x-test-user']];
    if (!u) return res.status(401).json({ message: 'Chưa đăng nhập' });
    req.user = u;
    next();
  };
  app.use('/api/ngan-hang-te-bao-khang-the', createRouter({ db, authMiddleware: fakeAuth }));
  await new Promise((r) => {
    server = http.createServer(app).listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${server.address().port}/api/ngan-hang-te-bao-khang-the`;
});

test.after(() => {
  server.close();
  db.close();
});

async function api(user, method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {}
  return { status: res.status, json };
}

let ids = {};

test('bắt buộc đăng nhập', async () => {
  assert.equal((await api(null, 'GET', '/tree')).status, 401);
  assert.equal((await api(null, 'POST', '/tubes', {})).status, 401);
});

test('meta có dữ liệu mặc định và cờ canManage theo vai trò', async () => {
  const m = await api('manager', 'GET', '/meta');
  assert.equal(m.status, 200);
  assert.equal(m.json.canManage, true);
  assert.ok(m.json.containerTypes.length >= 5);
  assert.ok(m.json.boxTemplates.some((t) => t.rows === 9 && t.cols === 9));
  assert.equal((await api('alice', 'GET', '/meta')).json.canManage, false);
  ids.type = m.json.containerTypes[0].id;
  ids.tpl99 = m.json.boxTemplates.find((t) => t.rows === 9 && t.cols === 9).id;
});

test('chỉ quản lý được tạo vật chứa; researcher bị 403', async () => {
  const r = await api('alice', 'POST', '/containers', { name: 'Tủ X', type_id: ids.type });
  assert.equal(r.status, 403);
  const ok = await api('manager', 'POST', '/containers', { name: 'Tủ A', type_id: ids.type });
  assert.equal(ok.status, 201);
  ids.freezer = ok.json.id;
  const shelf = await api('manager', 'POST', '/containers', { name: 'Ngăn 1', type_id: ids.type, parent_id: ids.freezer });
  ids.shelf = shelf.json.id;
  const rack = await api('manager', 'POST', '/containers', { name: 'Giá 1', type_id: ids.type, parent_id: ids.shelf });
  ids.rack = rack.json.id;
  assert.equal(rack.status, 201);
});

test('không tạo vật chứa thiếu tên / loại sai / cha không tồn tại', async () => {
  assert.equal((await api('manager', 'POST', '/containers', { type_id: ids.type })).status, 400);
  assert.equal((await api('manager', 'POST', '/containers', { name: 'x', type_id: 99999 })).status, 400);
  assert.equal((await api('manager', 'POST', '/containers', { name: 'x', type_id: ids.type, parent_id: 99999 })).status, 400);
});

test('mã vật chứa trùng bị 409', async () => {
  const a = await api('manager', 'POST', '/containers', { name: 'Tủ B', type_id: ids.type, code: 'DUP-1' });
  assert.equal(a.status, 201);
  const b = await api('manager', 'POST', '/containers', { name: 'Tủ C', type_id: ids.type, code: 'DUP-1' });
  assert.equal(b.status, 409);
});

test('không chuyển vật chứa vào chính nó hoặc con cháu (chống vòng)', async () => {
  const self = await api('manager', 'PATCH', `/containers/${ids.freezer}`, { parent_id: ids.freezer });
  assert.equal(self.status, 400);
  const child = await api('manager', 'PATCH', `/containers/${ids.freezer}`, { parent_id: ids.rack });
  assert.equal(child.status, 400);
});

test('tạo hộp từ mẫu, tạo hàng loạt, kích thước sai bị từ chối', async () => {
  const one = await api('manager', 'POST', '/boxes', { container_id: ids.rack, template_id: ids.tpl99, name: 'Hộp HEK' });
  assert.equal(one.status, 201);
  ids.box = one.json.ids[0];
  const bulk = await api('manager', 'POST', '/boxes', { container_id: ids.rack, template_id: ids.tpl99, name: 'Lô', count: 3 });
  assert.equal(bulk.json.ids.length, 3);
  ids.box2 = bulk.json.ids[0];
  assert.equal((await api('manager', 'POST', '/boxes', { container_id: ids.rack, rows: 30, cols: 5 })).status, 400);
  assert.equal((await api('manager', 'POST', '/boxes', { container_id: ids.rack, template_id: ids.tpl99, count: 99 })).status, 400);
  assert.equal((await api('alice', 'POST', '/boxes', { container_id: ids.rack, template_id: ids.tpl99 })).status, 403);
  const tree = await api('alice', 'GET', '/tree');
  assert.equal(tree.json.containers.length, 4); // Tủ A, Ngăn 1, Giá 1, Tủ B (Tủ C bị từ chối vì trùng mã)
  assert.equal(tree.json.boxes.length, 4);
});

test('thêm ống: kiểm tra vị trí trong lưới và vị trí trống', async () => {
  const t1 = await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 1, col_no: 1, name: 'HEK293 P12', barcode: 'BC-1' });
  assert.equal(t1.status, 201);
  ids.tubeA = t1.json.id;
  assert.equal((await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 1, col_no: 1, name: 'trùng' })).status, 409);
  assert.equal((await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 10, col_no: 1, name: 'ngoài' })).status, 400);
  assert.equal((await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 0, col_no: 1, name: 'ngoài' })).status, 400);
  assert.equal((await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 2, col_no: 2 })).status, 400);
  assert.equal((await api('alice', 'POST', '/tubes', { box_id: 99999, row_no: 1, col_no: 1, name: 'x' })).status, 400);
  assert.equal((await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 2, col_no: 2, name: 'trùng mã vạch', barcode: 'BC-1' })).status, 409);
});

test('hộp trả về ống, đường dẫn và quyền sửa theo chủ sở hữu', async () => {
  const asAlice = await api('alice', 'GET', `/boxes/${ids.box}`);
  assert.deepEqual(asAlice.json.path, ['Tủ A', 'Ngăn 1', 'Giá 1']);
  assert.equal(asAlice.json.tubes.length, 1);
  assert.equal(asAlice.json.tubes[0].can_edit, true);
  assert.equal(asAlice.json.tubes[0].owner_name, 'alice@sci.edu.vn');
  assert.equal((await api('bob', 'GET', `/boxes/${ids.box}`)).json.tubes[0].can_edit, false);
  assert.equal((await api('manager', 'GET', `/boxes/${ids.box}`)).json.tubes[0].can_edit, true);
});

test('chỉ chủ sở hữu hoặc quản lý được sửa / di chuyển / xóa ống', async () => {
  assert.equal((await api('bob', 'PATCH', `/tubes/${ids.tubeA}`, { name: 'hack' })).status, 403);
  assert.equal((await api('bob', 'POST', `/tubes/${ids.tubeA}/move`, { box_id: ids.box, row_no: 5, col_no: 5 })).status, 403);
  assert.equal((await api('bob', 'DELETE', `/tubes/${ids.tubeA}`)).status, 403);
  assert.equal((await api('alice', 'PATCH', `/tubes/${ids.tubeA}`, { passage: 'P13' })).status, 200);
  assert.equal((await api('manager', 'PATCH', `/tubes/${ids.tubeA}`, { volume_ml: 1.5 })).status, 200);
  assert.equal((await api('alice', 'PATCH', `/tubes/${ids.tubeA}`, { name: '' })).status, 400);
});

test('di chuyển ống: vị trí bị chiếm → 409, vị trí trống → ghi nhật ký', async () => {
  const t2 = await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 1, col_no: 2, name: 'Ống 2' });
  ids.tubeB = t2.json.id;
  assert.equal((await api('alice', 'POST', `/tubes/${ids.tubeB}/move`, { box_id: ids.box, row_no: 1, col_no: 1 })).status, 409);
  assert.equal((await api('alice', 'POST', `/tubes/${ids.tubeB}/move`, { box_id: ids.box, row_no: 99, col_no: 1 })).status, 400);
  const ok = await api('alice', 'POST', `/tubes/${ids.tubeB}/move`, { box_id: ids.box2, row_no: 3, col_no: 4 });
  assert.equal(ok.status, 200);
  // ô cũ đã trống: có thể đặt ống mới vào
  assert.equal((await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 1, col_no: 2, name: 'Ống 3' })).status, 201);
  const h = await api('alice', 'GET', `/tubes/${ids.tubeB}/history`);
  assert.deepEqual(h.json.history.map((x) => x.action), ['move', 'store']);
  assert.equal(h.json.history[0].to_row, 3);
  assert.equal(h.json.history[0].user_name, 'alice@sci.edu.vn');
});

test('không thu nhỏ hộp khi có ống nằm ngoài kích thước mới', async () => {
  await api('alice', 'POST', '/tubes', { box_id: ids.box, row_no: 9, col_no: 9, name: 'Góc' });
  assert.equal((await api('manager', 'PATCH', `/boxes/${ids.box}`, { rows: 5, cols: 5 })).status, 409);
  assert.equal((await api('manager', 'PATCH', `/boxes/${ids.box}`, { name: 'Đổi tên' })).status, 200);
});

test('không xóa hộp / vật chứa khi còn ống; xóa được sau khi lấy ống ra', async () => {
  assert.equal((await api('manager', 'DELETE', `/boxes/${ids.box}`)).status, 409);
  const blocked = await api('manager', 'DELETE', `/containers/${ids.freezer}`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.message, /mẫu/);
  const rows = await api('manager', 'GET', `/boxes/${ids.box}`);
  for (const t of rows.json.tubes) assert.equal((await api('manager', 'DELETE', `/tubes/${t.id}`)).status, 200);
  const box2 = await api('manager', 'GET', `/boxes/${ids.box2}`);
  for (const t of box2.json.tubes) assert.equal((await api('manager', 'DELETE', `/tubes/${t.id}`)).status, 200);
  const del = await api('manager', 'DELETE', `/containers/${ids.freezer}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.containers, 3);
  assert.equal(del.json.boxes, 4);
  const tree = await api('alice', 'GET', '/tree');
  assert.ok(!tree.json.containers.some((c) => c.id === ids.freezer));
  assert.equal(tree.json.boxes.length, 0);
  assert.equal((await api('alice', 'GET', `/boxes/${ids.box}`)).status, 404);
});

test('ống đã xóa không còn giữ chỗ và nhật ký vẫn được lưu', async () => {
  const h = await api('alice', 'GET', `/tubes/${ids.tubeA}/history`);
  assert.equal(h.status, 200);
  assert.equal(h.json.history[0].action, 'delete');
});
