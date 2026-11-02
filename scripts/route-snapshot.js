#!/usr/bin/env node
'use strict';

/**
 * scripts/route-snapshot.js
 * Chụp "ảnh" hành vi của TOÀN BỘ route: gọi từng route với 3 danh tính (không token / Admin / nghiên
 * cứu viên) và ghi lại mã trạng thái + dấu vân tay nội dung. So hai ảnh bằng scripts/route-compare.js.
 *
 * Dùng cho refactor (xem §4 readme/KE-HOACH-REFACTOR.md): chụp TRƯỚC khi cắt–dán, chụp SAU, so hai ảnh.
 * Khác route-inventory.js (chỉ liệt kê route có tồn tại): ảnh này bắt được cả việc route còn đó nhưng
 * đổi quyền (401 → 200), đổi mã lỗi, hoặc trả nội dung khác.
 *
 *   node scripts/route-snapshot.js <file-ra.json> [--port 3201]
 *   npm run route:snapshot -- <file-ra.json>
 *
 * An toàn: chạy trên server HỘP CÁT với BẢN SAO DB (tests/helpers/testServer.js), không đụng dữ liệu
 * thật, không gửi email. Cần data/sci-ace.db và JWT_SECRET trong .env như `npm test`.
 *
 * Giới hạn (cố ý): chỉ gọi route GET với đủ 3 danh tính; route ghi (POST/PUT/PATCH/DELETE) chỉ gọi
 * KHÔNG token để kiểm cổng đăng nhập — gọi route ghi bằng Admin sẽ làm đổi dữ liệu. Logic nghiệp vụ
 * của route ghi phải có test riêng (xem tests/crd.test.js làm mẫu). Ảnh này là lưới đầu vào, không
 * thay cho test nghiệp vụ.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Route có tác dụng phụ nặng hoặc không bao giờ kết thúc — không gọi.
const SKIP = /(logout|restart|shutdown|harvest|purge|backup|wipe|reset-all|truncate|send-test|test-email|import|upload|sync)/i;
const TIMEOUT_MS = 8000;
const PASSES = 2; // chạy 2 lượt để nhận diện phản hồi tự đổi theo thời gian

function parseArgs(argv) {
  const out = { file: null, port: Number(process.env.TEST_PORT_SNAPSHOT || 3201) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    else if (!out.file) out.file = argv[i];
  }
  return out;
}

function listRoutes() {
  const inv = execFileSync(process.execPath, [path.join(__dirname, 'route-inventory.js')], { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
  const routes = [];
  for (const line of inv.split(/\r?\n/)) {
    const m = line.match(/^\d{4}\s+(\S+)\s+(\S+)/);
    if (m) routes.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  return routes;
}

/** :id → 1, :code → mã mẫu, * → x. Giữ nguyên đường dẫn thật để dễ đối chiếu. */
function concretize(p) {
  return p
    .replace(/\(([^)]*)\)/g, '')
    .replace(/:code\b/g, 'DT-XX-2026-0001')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '1')
    .replace(/\*/g, 'x');
}

/** Làm mờ phần đổi theo thời gian trước khi băm, để hai lần gọi liền nhau thường cho cùng dấu vân tay. */
function fingerprint(text) {
  const t = String(text)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ts>')
    .replace(/\d{13}/g, '<ms>');
  return crypto.createHash('sha1').update(t).digest('hex').slice(0, 10) + ':' + t.length;
}

async function hit(baseUrl, method, p, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (method !== 'GET' && method !== 'HEAD') { headers['Content-Type'] = 'application/json'; init.body = '{}'; }
  try {
    const r = await fetch(baseUrl + p, init);
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    const text = /json|text|html|javascript|css|xml/.test(ct);
    return { s: r.status, ct, f: text ? fingerprint(buf.toString('utf8')) : 'bin:' + buf.length };
  } catch (e) {
    return { s: 'TIMEOUT', ct: '', f: 'timeout' }; // vd luồng SSE không bao giờ kết thúc — nhất quán giữa hai lần chụp
  }
}

async function sweep(srv, jobs, tokens) {
  const results = {};
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const j = jobs[i++];
      results[j.key] = await hit(srv.baseUrl, j.method, j.p, tokens[j.k]);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('Dùng: node scripts/route-snapshot.js <file-ra.json> [--port 3201]');
    process.exit(2);
  }
  const { startTestServer } = require(path.join(ROOT, 'tests', 'helpers', 'testServer.js'));
  const srv = await startTestServer({ port: args.port, env: { API_RATE_LIMIT_MAX: '1000000' } });
  try {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
    const db = new Database(srv.dbPath, { readonly: true });
    const researcher = db.prepare("SELECT id, email, role FROM users WHERE lower(role) = 'researcher' ORDER BY id DESC LIMIT 1").get();
    db.close();
    if (!researcher) throw new Error('DB không có tài khoản researcher nào để chụp.');
    const tokens = {
      none: null,
      admin: srv.tokens.admin,
      researcher: jwt.sign({ id: researcher.id, email: researcher.email, role: researcher.role }, process.env.JWT_SECRET, { expiresIn: '1h' }),
    };

    const routes = listRoutes();
    const jobs = [];
    for (const r of routes) {
      if (SKIP.test(r.path)) continue;
      const p = concretize(r.path);
      if (r.method === 'GET') {
        for (const k of ['none', 'admin', 'researcher']) jobs.push({ key: `${r.method} ${r.path} [${k}]`, method: r.method, p, k });
      } else {
        jobs.push({ key: `${r.method} ${r.path} [none]`, method: r.method, p, k: 'none' });
      }
    }

    const passes = [];
    for (let n = 0; n < PASSES; n++) passes.push(await sweep(srv, jobs, tokens));

    // Mục nào dấu vân tay khác nhau giữa hai lượt trên CÙNG một bản code → tự đổi theo thời gian, đánh dấu volatile.
    const results = {};
    let volatile = 0;
    for (const j of jobs) {
      const a = passes[0][j.key];
      const b = passes[1][j.key];
      const entry = { ...a };
      if (a.s !== b.s) { entry.s = 'UNSTABLE'; entry.f = 'status-doi'; entry.volatile = true; volatile++; }
      else if (a.f !== b.f) { entry.volatile = true; volatile++; }
      results[j.key] = entry;
    }

    let commit = null;
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch (_) { /* không có git */ }
    const out = {
      meta: { commit, node: process.version, createdAt: new Date().toISOString(), routes: routes.length, requests: jobs.length, volatile },
      results,
    };
    fs.writeFileSync(args.file, JSON.stringify(out, null, 1));

    const dist = {};
    for (const v of Object.values(results)) dist[v.s] = (dist[v.s] || 0) + 1;
    console.log(`route: ${routes.length} | yêu cầu mỗi lượt: ${jobs.length} | lượt: ${PASSES} | tự đổi theo thời gian: ${volatile}`);
    console.log('phân bố mã:', JSON.stringify(dist));
    console.log('đã ghi:', args.file);
  } finally {
    await srv.stop();
  }
}

main().catch((e) => { console.error('LỖI route-snapshot:', e.stack || e.message); process.exit(1); });
