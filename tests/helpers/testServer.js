/**
 * tests/helpers/testServer.js
 * Khởi động server trong môi trường CÔ LẬP để chạy test khói.
 *
 * Bảo đảm an toàn (quan trọng — test chạy trên máy có dữ liệu thật):
 *   - DB: bản sao trong thư mục tạm, KHÔNG đụng data/sci-ace.db
 *   - Uploads: APP_DATA_DIR trỏ vào thư mục tạm, test không ghi vào uploads/ thật
 *   - SMTP: để rỗng => transporter = null => KHÔNG gửi email nào
 *   - Cổng riêng, không đụng server đang chạy
 *
 * Không gọi API bên ngoài: harvest ORCID/NCBI mặc định TẮT (công tắc trong
 * system_settings), và không test nào bật nó lên.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CODE_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_DB = path.join(CODE_ROOT, 'data', 'sci-ace.db');
const PORT = Number(process.env.TEST_PORT || 3199);

function sandboxDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'khcn-test-'));
}

/** Bản sao DB để test ghi thoải mái mà không ảnh hưởng dữ liệu thật. */
function copyDatabase(destDir) {
  if (!fs.existsSync(SOURCE_DB)) return null;
  const dest = path.join(destDir, 'test.db');
  fs.copyFileSync(SOURCE_DB, dest);
  for (const suffix of ['-wal', '-shm']) {
    const extra = SOURCE_DB + suffix;
    if (fs.existsSync(extra)) fs.copyFileSync(extra, dest + suffix);
  }
  return dest;
}

async function waitForHealth(baseUrl, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('Server không sẵn sàng trong ' + timeoutMs + 'ms: ' + (lastErr && lastErr.message));
}

/**
 * Lấy một tài khoản admin và một tài khoản KHÔNG phải admin từ DB test,
 * rồi ký JWT tương ứng. Không hard-code id để test không vỡ khi dữ liệu đổi.
 */
function mintTokens(dbPath, jwtSecret) {
  const Database = require(path.join(CODE_ROOT, 'node_modules', 'better-sqlite3'));
  const jwt = require(path.join(CODE_ROOT, 'node_modules', 'jsonwebtoken'));
  const db = new Database(dbPath);

  const admin = db.prepare("SELECT id, email, role FROM users WHERE lower(role) = 'admin' LIMIT 1").get();
  let plain = db.prepare("SELECT id, email, role FROM users WHERE lower(role) <> 'admin' LIMIT 1").get();

  // Cần một tài khoản vai trò vien_truong để kiểm tra ranh giới quyền.
  let director = db.prepare("SELECT id, email, role FROM users WHERE lower(role) = 'vien_truong' LIMIT 1").get();
  if (!director && plain) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('vien_truong', plain.id);
    director = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(plain.id);
    plain = db.prepare("SELECT id, email, role FROM users WHERE lower(role) NOT IN ('admin','vien_truong') LIMIT 1").get();
  }
  db.close();

  const sign = (u) => (u ? jwt.sign({ id: u.id, email: u.email, role: u.role }, jwtSecret, { expiresIn: '1h' }) : null);
  return {
    admin: sign(admin),
    director: sign(director),
    plain: sign(plain),
    users: { admin, director, plain },
  };
}

/** Khởi động server test. Trả về { baseUrl, tokens, stop() }. */
async function startTestServer() {
  require(path.join(CODE_ROOT, 'node_modules', 'dotenv')).config({ path: path.join(CODE_ROOT, '.env') });
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('Thiếu JWT_SECRET trong .env — không ký được token test.');

  const dir = sandboxDir();
  const dbPath = copyDatabase(dir);
  if (!dbPath) throw new Error('Không tìm thấy data/sci-ace.db để tạo bản sao test.');

  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    BASE_URL: 'http://127.0.0.1:' + PORT,
    APP_DATA_DIR: dir,        // uploads + dữ liệu đều nằm trong hộp cát
    SQLITE_PATH: dbPath,
    SMTP_HOST: '',            // rỗng => không tạo transporter => không gửi mail
    SMTP_USER: '',
    SMTP_PASS: '',
    TEST_PORT: String(PORT),
  };

  const child = spawn(process.execPath, [path.join(CODE_ROOT, 'server.js')], {
    cwd: CODE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  const baseUrl = 'http://127.0.0.1:' + PORT;
  try {
    await waitForHealth(baseUrl);
  } catch (e) {
    child.kill();
    throw new Error(e.message + '\n--- log server ---\n' + logs.join(''));
  }

  const tokens = mintTokens(dbPath, jwtSecret);

  return {
    baseUrl,
    tokens,
    dbPath,
    logs,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

/** fetch kèm token, không ném lỗi theo status. */
async function call(baseUrl, pathname, { token, method = 'GET', body, headers } = {}) {
  const h = { ...(headers || {}) };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(baseUrl + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  return res;
}

module.exports = { startTestServer, call, PORT };
