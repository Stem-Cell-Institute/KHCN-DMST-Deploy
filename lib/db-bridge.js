/**
 * Database Bridge - Kết nối server.js với database abstraction
 *
 * Module này cung cấp interface thống nhất cho SQLite và Turso.
 * Hai chế độ Turso được hỗ trợ:
 *   1. Turso Local Daemon (khuyến nghị): giao tiếp sync HTTP với `sqld` (libsql-server)
 *      → Binary: https://github.com/tursodatabase/libsql/releases → sqld
 *      → API đồng bộ, không cần sửa server.js, KHÔNG cần await
 *   2. Turso Remote (async): giao tiếp bất đồng bộ với cloud
 *      → Cần refactor server.js sang async/await
 *
 * Cách sử dụng (giữ nguyên như better-sqlite3):
 *   db.prepare(sql).run(...params)
 *   db.prepare(sql).get(...params)
 *   db.prepare(sql).all(...params)
 *   db.exec(sql)
 *   db.transaction(fn)
 *   db.pragma(pragma)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

try { require('dotenv').config({ path: '.env' }); } catch (_) {}

const appPaths = require('./appPaths');

const TURSO_MODE = process.env.TURSO_MODE || 'local'; // 'local' | 'remote'
const tursoUrl = process.env.DATABASE_URL || '';
const tursoToken = process.env.DATABASE_AUTH_TOKEN || '';
const TURSO_LOCAL_HOST = process.env.TURSO_LOCAL_HOST || '127.0.0.1';
const TURSO_LOCAL_PORT = parseInt(process.env.TURSO_PORT || '8080', 10);

const isTurso = () => {
  const url = tursoUrl.toLowerCase();
  return url.includes('libsql://') || url.includes('turso://') || url.includes('wss://') || url.includes('ws://');
};

const sqlitePath = appPaths.sqliteFilePath();

// ============================================
// SQLite Bridge (Synchronous - better-sqlite3)
// ============================================
class SQLiteBridge {
  constructor(dbPath) {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, {
      verbose: process.env.DEBUG ? console.log : null
    });
    this.db.pragma('foreign_keys = ON');
    console.log('[DB-Bridge] SQLite đã kết nối:', dbPath);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  transaction(fn) {
    return this.db.transaction(fn);
  }

  pragma(pragma) {
    return this.db.pragma(pragma);
  }

  close() {
    this.db.close();
  }

  get native() {
    return this.db;
  }
}

// ============================================
// Turso Local Bridge (Synchronous HTTP → local sqld server)
// sqld (libsql-server) chạy HTTP server cục bộ.
// Binary: https://github.com/tursodatabase/libsql/releases → sqld
// Ví dụ: sqld --port 8080 --db-path ./data/sci-ace.db
// Dùng sync execSync (curl) để gọi HTTP — KHÔNG cần await.
// ============================================
class TursoLocalBridge {
  constructor(host, port, dbName) {
    this.host = host;
    this.port = port;
    this.dbName = dbName;
    this._connected = false;
    console.log(`[DB-Bridge] Turso Local Daemon: http://${host}:${port} (db=${dbName})`);
  }

  _httpRequest(method, sql, args = []) {
    const body = JSON.stringify({ sql, args });
    const options = {
      hostname: this.host,
      port: this.port,
      path: '/v1/pipeline',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from daemon: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _syncExec(method, sql, args = []) {
    // Dùng http.request đồng bộ (blocking) — Node.js hỗ trợ!
    // Đây là synchronous HTTP trong Node (không phải async).
    const body = JSON.stringify({ sql, args });
    const options = {
      hostname: this.host,
      port: this.port,
      path: '/v1/pipeline',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const result = http.request(options, (res) => {
      // Xử lý response... (nhưng ở đây chúng ta dùng blocking approach)
    });

    // Cách thực sự sync: dùng sync version
    // Node.js http.request KHÔNG có sync version thuần.
    // Chúng ta dùng ffiulate/mutex approach: gọi sync via child_process exec
    const { execSync } = require('child_process');
    const curlCmd = `curl -s -X POST http://${this.host}:${this.port}/v1/pipeline ` +
      `-H "Content-Type: application/json" -d ${JSON.stringify(body)}`;
    const raw = execSync(curlCmd, { encoding: 'utf8', timeout: 30000 });
    return JSON.parse(raw);
  }

  prepare(sql) {
    const self = this;
    return {
      _sql: sql,
      _params: [],

      run(...params) {
        try {
          const res = self._syncExec('POST', sql, params);
          const r = res.results && res.results[0];
          return {
            changes: r ? r.rows_affected : 0,
            lastInsertRowid: r && r.last_insert_rowid ? Number(r.last_insert_rowid) : 0,
          };
        } catch (e) {
          throw new Error(`[Turso Local] ${e.message}\n  SQL: ${sql}`);
        }
      },

      get(...params) {
        try {
          const res = self._syncExec('POST', sql, params);
          const rows = res.results && res.results[0] && res.results[0].rows;
          return rows && rows.length > 0 ? rows[0] : null;
        } catch (e) {
          throw new Error(`[Turso Local] ${e.message}\n  SQL: ${sql}`);
        }
      },

      all(...params) {
        try {
          const res = self._syncExec('POST', sql, params);
          const rows = res.results && res.results[0] && res.results[0].rows;
          return rows || [];
        } catch (e) {
          throw new Error(`[Turso Local] ${e.message}\n  SQL: ${sql}`);
        }
      },
    };
  }

  exec(sql) {
    try {
      // Multi-statement: gửi từng câu
      const statements = sql.split(';').filter(s => s.trim());
      for (const stmt of statements) {
        if (!stmt.trim()) continue;
        this._syncExec('POST', stmt.trim(), []);
      }
    } catch (e) {
      throw new Error(`[Turso Local exec] ${e.message}\n  SQL: ${sql.slice(0, 100)}`);
    }
  }

  transaction(fn) {
    const self = this;
    return function () {
      // Wrap để gọi fn() đồng bộ
      try {
        self._syncExec('POST', 'BEGIN TRANSACTION', []);
        fn();
        self._syncExec('POST', 'COMMIT', []);
      } catch (e) {
        try { self._syncExec('POST', 'ROLLBACK', []); } catch (_) {}
        throw e;
      }
    };
  }

  pragma(pragma) {
    return this.prepare(`PRAGMA ${pragma}`).all();
  }

  close() {
    // Local daemon không cần close từ client
  }

  get native() {
    return null;
  }
}

// ============================================
// Turso Remote Bridge (Asynchronous - @libsql/client)
// Chỉ dùng khi server.js đã được refactor sang async/await.
// ============================================
class TursoRemoteBridge {
  constructor(url, authToken) {
    this.client = null;
    this.url = url;
    this.authToken = authToken;
    this._initPromise = null;
    this._init();
  }

  _init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const { createClient } = require('@libsql/client');
      this.client = createClient({ url: this.url, authToken: this.authToken });
      console.log('[DB-Bridge] Turso Remote đã kết nối:', this.url);
      return this.client;
    })();
    return this._initPromise;
  }

  async _ensure() {
    await this._initPromise;
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        return self._ensure().then(() =>
          self.client.execute({ sql, args: params })
        ).then(r => ({
          changes: r.rowsAffected,
          lastInsertRowid: typeof r.lastInsertRowid === 'bigint'
            ? Number(r.lastInsertRowid) : r.lastInsertRowid,
        }));
      },
      get(...params) {
        return self._ensure().then(() =>
          self.client.execute({ sql, args: params })
        ).then(r => r.rows[0] || null);
      },
      all(...params) {
        return self._ensure().then(() =>
          self.client.execute({ sql, args: params })
        ).then(r => r.rows);
      },
    };
  }

  async exec(sql) {
    await this._ensure();
    return this.client.execute(sql);
  }

  async transaction(fn) {
    await this._ensure();
    return fn();
  }

  async pragma(pragma) {
    await this._ensure();
    return this.client.execute(`PRAGMA ${pragma}`);
  }

  async close() {
    this.client = null;
  }

  get native() {
    return this.client;
  }
}

// ============================================
// Database Factory
// ============================================
let dbInstance = null;

function createDatabase(options = {}) {
  const forceMode = options.mode; // 'sqlite' | 'turso-local' | 'turso-remote'

  if (forceMode === 'sqlite') {
    console.log('[DB-Bridge] Mode: SQLite (forced)');
    return new SQLiteBridge(options.path || sqlitePath);
  }

  if (forceMode === 'turso-local') {
    console.log('[DB-Bridge] Mode: Turso Local (forced)');
    return new TursoLocalBridge(
      options.host || TURSO_LOCAL_HOST,
      options.port || TURSO_LOCAL_PORT,
      options.dbName || 'sci-ace'
    );
  }

  if (forceMode === 'turso-remote') {
    console.log('[DB-Bridge] Mode: Turso Remote (forced)');
    return new TursoRemoteBridge(options.url || tursoUrl, options.token || tursoToken);
  }

  // Auto detect
  if (TURSO_MODE === 'turso-remote' || (isTurso() && TURSO_MODE !== 'turso-local')) {
    console.log('[DB-Bridge] Mode: Turso Remote (auto-detect)');
    return new TursoRemoteBridge(tursoUrl, tursoToken);
  }

  if (TURSO_MODE === 'turso-local' || isTurso()) {
    console.log('[DB-Bridge] Mode: Turso Local (auto-detect)');
    return new TursoLocalBridge(TURSO_LOCAL_HOST, TURSO_LOCAL_PORT, 'sci-ace');
  }

  console.log('[DB-Bridge] Mode: SQLite (auto-detect)');
  return new SQLiteBridge(sqlitePath);
}

dbInstance = createDatabase();

module.exports = dbInstance;
module.exports.SQLiteBridge = SQLiteBridge;
module.exports.TursoLocalBridge = TursoLocalBridge;
module.exports.TursoRemoteBridge = TursoRemoteBridge;
module.exports.createDatabase = createDatabase;

module.exports.config = {
  isTurso: isTurso(),
  tursoMode: TURSO_MODE,
  sqlitePath,
  tursoUrl,
  tursoHasToken: !!tursoToken,
  tursoLocalAddr: `${TURSO_LOCAL_HOST}:${TURSO_LOCAL_PORT}`,
};
