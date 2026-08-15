#!/usr/bin/env node
/**
 * scripts/route-inventory.js
 *
 * Liệt kê TOÀN BỘ route mà server thực sự đăng ký, để so sánh trước/sau mỗi đợt
 * tách server.js. Đây là lưới an toàn cơ học của quá trình refactor:
 *
 *   node scripts/route-inventory.js > /tmp/routes-before.txt
 *   ... tách route ...
 *   node scripts/route-inventory.js > /tmp/routes-after.txt
 *   diff /tmp/routes-before.txt /tmp/routes-after.txt      # PHẢI rỗng
 *
 * Khác với đọc code bằng grep: script này lấy danh sách từ chính bảng định tuyến
 * của Express sau khi server khởi động xong, nên bắt được cả route đăng ký động,
 * route nằm trong router con, và bắt được cả THAY ĐỔI THỨ TỰ đăng ký — thứ quyết
 * định route `/api/x/abc` hay `/api/x/:id` được khớp trước.
 *
 * Cách hoạt động:
 *   1. Tiến trình cha tạo hộp cát (bản sao DB, thư mục upload tạm) giống
 *      tests/helpers/testServer.js, KHÔNG đụng dữ liệu thật.
 *   2. Spawn `node -r <chính file này> server.js`. Khi được nạp bằng -r, file này
 *      thay express trong require.cache bằng bản bọc, chặn app.listen (không mở
 *      cổng nào) và dump bảng định tuyến ngay tại thời điểm server gọi listen —
 *      tức là sau khi mọi route đã đăng ký.
 *   3. Tiến trình cha in kết quả ra stdout.
 *
 * An toàn: không bind cổng, không gửi email, không ghi vào data/ hay uploads/.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE_ROOT = path.resolve(__dirname, '..');
const OUT_ENV = 'ROUTE_INVENTORY_OUT';

// ───────────────────────────────────────────────────────────────────────────
// CHẾ ĐỘ CON: được nạp bằng `node -r scripts/route-inventory.js server.js`
// ───────────────────────────────────────────────────────────────────────────

if (process.env[OUT_ENV]) {
  installExpressHook();
} else {
  main();
}

function installExpressHook() {
  const expressPath = require.resolve('express', { paths: [CODE_ROOT] });
  const realExpress = require(expressPath);

  let capturedApp = null;
  let dumped = false;

  function fakeExpress(...args) {
    const app = realExpress(...args);
    if (!capturedApp) capturedApp = app;

    // Chặn listen: không mở cổng, và đây là mốc "mọi route đã đăng ký xong".
    app.listen = function stubbedListen() {
      // Hoãn một nhịp để các app.use() gọi đồng bộ ngay sau listen (nếu có) kịp chạy.
      setImmediate(() => {
        if (dumped) return;
        dumped = true;
        try {
          writeInventory(app);
        } catch (err) {
          fs.writeFileSync(
            process.env[OUT_ENV],
            'LỖI khi dump bảng định tuyến: ' + (err && err.stack ? err.stack : err)
          );
        }
        process.exit(0);
      });
      return stubHttpServer();
    };

    return app;
  }

  Object.assign(fakeExpress, realExpress);
  require.cache[expressPath].exports = fakeExpress;

  // Lưới an toàn: nếu server chết trước khi gọi listen, vẫn ghi ra thứ đang có.
  process.on('exit', () => {
    if (!dumped && capturedApp) {
      dumped = true;
      try {
        writeInventory(capturedApp, '(server thoát trước khi listen — danh sách có thể thiếu)');
      } catch (_) {
        /* hết đường, để tiến trình cha báo lỗi */
      }
    }
  });
}

/** http.Server giả — đủ để server.js gắn handler lỗi mà không bind cổng. */
function stubHttpServer() {
  return {
    on() {
      return this;
    },
    once() {
      return this;
    },
    close(cb) {
      if (cb) cb();
      return this;
    },
    address() {
      return { address: '127.0.0.1', family: 'IPv4', port: 0 };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Duyệt bảng định tuyến của Express 4
// ───────────────────────────────────────────────────────────────────────────

/**
 * Khôi phục tiền tố mount từ regexp của layer.
 * `app.use('/api/crd', router)` sinh regexp có source `^\/api\/crd\/?(?=\/|$)`.
 */
function decodeMountPath(layer) {
  const re = layer.regexp;
  if (!re) return '';
  if (re.fast_slash) return ''; // app.use(router) — mount tại '/'

  let src = re.source;
  src = src
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '') // đuôi \/?(?=\/|$)
    .replace(/\$$/, '');

  // Tham số động: (?:([^\/]+?)) -> :tên, lấy tên theo thứ tự trong layer.keys
  const keys = Array.isArray(layer.keys) ? layer.keys.slice() : [];
  src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => {
    const k = keys.shift();
    return ':' + (k && k.name != null ? k.name : '?');
  });

  src = src.replace(/\\\//g, '/').replace(/\\\./g, '.');

  // Không giải mã được hết -> trả nguyên source để diff vẫn phát hiện thay đổi.
  if (/[\\(\[\+\?]/.test(src)) return '<regexp:' + re.source + '>';
  return src;
}

function joinPath(prefix, sub) {
  const a = String(prefix || '').replace(/\/+$/, '');
  const b = String(sub || '');
  if (!b || b === '/') return a || '/';
  return a + (b.startsWith('/') ? b : '/' + b);
}

/**
 * Duyệt đệ quy stack, trả về mảng { order, method, path } theo ĐÚNG thứ tự đăng ký.
 */
function collectRoutes(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods || {})
        .filter((m) => m !== '_all')
        .map((m) => m.toUpperCase())
        .sort();
      for (const p of paths) {
        for (const m of methods) {
          out.push({ order: out.length, method: m, path: joinPath(prefix, p) });
        }
      }
    } else if (layer.name === 'router' && layer.handle && Array.isArray(layer.handle.stack)) {
      collectRoutes(layer.handle.stack, joinPath(prefix, decodeMountPath(layer)), out);
    }
  }
  return out;
}

function buildInventory(app) {
  const router = app._router || (app.router && app.router.stack ? app.router : null);
  if (!router || !Array.isArray(router.stack)) {
    throw new Error('Không đọc được app._router.stack — kiểm tra phiên bản Express.');
  }
  return collectRoutes(router.stack, '', []);
}

function writeInventory(app, note) {
  const routes = buildInventory(app);

  const lines = [];
  lines.push('# Bảng định tuyến — ' + routes.length + ' route');
  if (note) lines.push('# ' + note);
  lines.push('# Cột: <thứ tự đăng ký>  <METHOD>  <đường dẫn>');
  lines.push('# Thứ tự CÓ Ý NGHĨA: route đăng ký trước được khớp trước.');
  lines.push('');
  for (const r of routes) {
    lines.push(String(r.order).padStart(4, '0') + '  ' + r.method.padEnd(7) + '  ' + r.path);
  }
  lines.push('');

  // Tổng hợp theo tiền tố — để thấy nhanh đợt tách đã chuyển nhóm nào.
  const byPrefix = new Map();
  for (const r of routes) {
    const m = /^(\/[^/]+(?:\/[^/]+)?)/.exec(r.path);
    const key = m ? m[1] : r.path;
    byPrefix.set(key, (byPrefix.get(key) || 0) + 1);
  }
  lines.push('# ── Tổng hợp theo tiền tố ──');
  for (const [k, v] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push('# ' + String(v).padStart(4) + '  ' + k);
  }

  fs.writeFileSync(process.env[OUT_ENV], lines.join('\n') + '\n', 'utf8');
}

// ───────────────────────────────────────────────────────────────────────────
// CHẾ ĐỘ CHA
// ───────────────────────────────────────────────────────────────────────────

function main() {
  const { spawnSync } = require('child_process');

  try {
    require(path.join(CODE_ROOT, 'node_modules', 'dotenv')).config({
      path: path.join(CODE_ROOT, '.env'),
    });
  } catch (_) {
    /* không có .env cũng chạy được nếu biến môi trường đã đặt sẵn */
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'khcn-routes-'));
  const outFile = path.join(sandbox, 'inventory.txt');

  // Bản sao DB — server.js chạy migration lúc khởi động, không cho đụng dữ liệu thật.
  const sourceDb = path.join(CODE_ROOT, 'data', 'sci-ace.db');
  let dbPath = null;
  if (fs.existsSync(sourceDb)) {
    dbPath = path.join(sandbox, 'inventory.db');
    fs.copyFileSync(sourceDb, dbPath);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(sourceDb + suffix)) fs.copyFileSync(sourceDb + suffix, dbPath + suffix);
    }
  }

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '0', // không dùng tới: app.listen đã bị chặn
    APP_DATA_DIR: sandbox, // uploads đi vào hộp cát
    SMTP_HOST: '', // không tạo transporter => không gửi email
    SMTP_USER: '',
    SMTP_PASS: '',
    [OUT_ENV]: outFile,
  };
  if (dbPath) env.SQLITE_PATH = dbPath;

  const res = spawnSync(process.execPath, ['-r', __filename, path.join(CODE_ROOT, 'server.js')], {
    cwd: CODE_ROOT,
    env,
    encoding: 'utf8',
    timeout: 120000,
  });

  if (!fs.existsSync(outFile)) {
    process.stderr.write(
      'Không tạo được bảng định tuyến. Log server:\n' +
        (res.stdout || '') +
        (res.stderr || '') +
        (res.error ? '\n' + res.error.message : '') +
        '\n'
    );
    cleanup(sandbox);
    process.exit(1);
  }

  process.stdout.write(fs.readFileSync(outFile, 'utf8'));
  cleanup(sandbox);
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* thư mục tạm, để OS dọn */
  }
}
