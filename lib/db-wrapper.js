/**
 * Database Wrapper - Cung cấp interface thống nhất cho cả SQLite và Turso
 * 
 * Lớp này wrap better-sqlite3 và @libsql/client để có cùng API,
 * cho phép server.js sử dụng mà không cần thay đổi nhiều code.
 * 
 * Usage:
 *   const { Database } = require('./lib/db-wrapper');
 *   const db = new Database();
 *   
 *   // Tương thích với better-sqlite3 API
 *   db.prepare(sql).run(...params);
 *   db.prepare(sql).get(...params);
 *   db.prepare(sql).all(...params);
 *   db.exec(sql);
 *   db.transaction(fn)();
 */

const path = require('path');
const fs = require('fs');

// Load environment variables
try { require('dotenv').config({ path: '.env' }); } catch (_) {}

const config = {
  // Kiểm tra xem có phải Turso không
  isTurso: () => {
    const url = process.env.DATABASE_URL || '';
    return url.includes('libsql://') || url.includes('wss://') || url.includes('ws://');
  },
  
  sqlite: {
    path: path.join(__dirname, '..', 'data', process.env.SQLITE_FILENAME || 'sci-ace.db'),
  },
  
  turso: {
    url: process.env.DATABASE_URL || '',
    authToken: process.env.DATABASE_AUTH_TOKEN || '',
  }
};

/**
 * SQLite Wrapper - tương thích với better-sqlite3 API
 */
class SQLiteWrapper {
  constructor(dbPath) {
    const Database = require('better-sqlite3');
    this.db = new Database(dbPath, { 
      verbose: process.env.DEBUG ? console.log : null 
    });
    this.db.pragma('foreign_keys = ON');
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

/**
 * Turso Wrapper - cung cấp API tương tự better-sqlite3
 */
class TursoWrapper {
  constructor(url, authToken) {
    this.client = null;
    this.url = url;
    this.authToken = authToken;
  }
  
  async init() {
    if (!this.client) {
      const { createClient } = require('@libsql/client');
      this.client = createClient({
        url: this.url,
        authToken: this.authToken,
      });
    }
    return this.client;
  }
  
  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        return self.client.execute({ sql, args: params }).then(r => ({
          changes: r.rowsAffected,
          lastInsertRowid: BigInt(r.lastInsertRowid || 0),
        }));
      },
      get(...params) {
        return self.client.execute({ sql, args: params }).then(r => r.rows[0] || null);
      },
      all(...params) {
        return self.client.execute({ sql, args: params }).then(r => r.rows);
      }
    };
  }
  
  exec(sql) {
    return this.client.execute(sql);
  }
  
  transaction(fn) {
    const self = this;
    return function() {
      // Turso hỗ trợ transactions qua batch
      return self.client.batch([fn.toString()], 'write');
    };
  }
  
  pragma(pragma) {
    return this.client.execute(`PRAGMA ${pragma}`);
  }
  
  async close() {
    // Turso client không cần close
  }
  
  get native() {
    return this.client;
  }
}

/**
 * Database Factory - tạo database wrapper dựa trên cấu hình
 */
class Database {
  constructor(options = {}) {
    this.isTurso = options.isTurso !== undefined ? options.isTurso : config.isTurso();
    this.wrapper = null;
    this._dbPath = options.dbPath || config.sqlite.path;
    this._url = options.url || config.turso.url;
    this._authToken = options.authToken || config.turso.authToken;
  }
  
  async init() {
    if (this.isTurso) {
      console.log('[DB] Kết nối Turso:', this._url);
      this.wrapper = new TursoWrapper(this._url, this._authToken);
      await this.wrapper.init();
      console.log('[DB] Đã kết nối Turso thành công');
    } else {
      console.log('[DB] Kết nối SQLite:', this._dbPath);
      const dbDir = path.dirname(this._dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      this.wrapper = new SQLiteWrapper(this._dbPath);
      console.log('[DB] Đã kết nối SQLite thành công');
    }
    return this;
  }
  
  prepare(sql) {
    return this.wrapper.prepare(sql);
  }
  
  exec(sql) {
    return this.wrapper.exec(sql);
  }
  
  transaction(fn) {
    return this.wrapper.transaction(fn);
  }
  
  pragma(pragma) {
    return this.wrapper.pragma(pragma);
  }
  
  close() {
    return this.wrapper.close();
  }
  
  get native() {
    return this.wrapper.native;
  }
  
  // Sync init cho SQLite
  initSync() {
    if (!this.isTurso) {
      console.log('[DB] Kết nối SQLite:', this._dbPath);
      const dbDir = path.dirname(this._dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      this.wrapper = new SQLiteWrapper(this._dbPath);
      console.log('[DB] Đã kết nối SQLite thành công');
    } else {
      throw new Error('initSync chỉ hỗ trợ cho SQLite. Sử dụng await init() cho Turso.');
    }
    return this;
  }
}

// Singleton instance
let dbInstance = null;

/**
 * Get or create database instance
 */
function getDatabase(options = {}) {
  if (!dbInstance) {
    dbInstance = new Database(options);
  }
  return dbInstance;
}

/**
 * Reset database instance (for testing)
 */
function resetDatabase() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {}
    dbInstance = null;
  }
}

module.exports = {
  Database,
  getDatabase,
  resetDatabase,
  SQLiteWrapper,
  TursoWrapper,
  config,
};
