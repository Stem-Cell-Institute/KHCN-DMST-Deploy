/**
 * Database Abstraction Layer - Hỗ trợ cả SQLite (better-sqlite3) và Turso (libsql)
 * 
 * Mục đích: Cho phép sử dụng SQLite khi phát triển local và chuyển sang Turso khi deploy lên Cloudflare
 * 
 * Usage:
 *   const db = require('./lib/database');
 *   const results = db.all('SELECT * FROM users');
 *   const user = db.get('SELECT * FROM users WHERE id = ?', [id]);
 *   const info = db.run('INSERT INTO users (email) VALUES (?)', [email]);
 */

const path = require('path');
const fs = require('fs');
const config = require('./config');

// Lazy-load drivers
let sqlite3 = null;
let libsql = null;
let db = null;

/**
 * Khởi tạo kết nối database
 * @returns {Object} Database connection
 */
function initDatabase() {
  if (db) return db;
  
  if (config.isTurso()) {
    // Sử dụng Turso (libsql)
    console.log('[DB] Kết nối Turso:', config.turso.url);
    libsql = require('@libsql/client');
    db = libsql.createClient({
      url: config.turso.url,
      authToken: config.turso.authToken,
    });
    console.log('[DB] Đã kết nối Turso thành công');
  } else {
    // Sử dụng SQLite local (better-sqlite3)
    console.log('[DB] Kết nối SQLite:', config.sqlite.path);
    sqlite3 = require('better-sqlite3');
    
    // Đảm bảo thư mục data tồn tại
    const dbDir = path.dirname(config.sqlite.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    db = new sqlite3(config.sqlite.path, { 
      verbose: process.env.DEBUG ? console.log : null 
    });
    
    // Enable foreign keys
    db.pragma('foreign_keys = ON');
    console.log('[DB] Đã kết nối SQLite thành công');
  }
  
  return db;
}

/**
 * Execute a query and return all rows
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Array} Array of rows
 */
function all(sql, params = []) {
  const database = initDatabase();
  
  if (config.isTurso()) {
    return database.execute({ sql, args: params }).then(result => result.rows);
  } else {
    const stmt = database.prepare(sql);
    return params.length > 0 ? stmt.all(...params) : stmt.all();
  }
}

/**
 * Execute a query and return first row
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Object|null} First row or null
 */
function get(sql, params = []) {
  const database = initDatabase();
  
  if (config.isTurso()) {
    return database.execute({ sql, args: params }).then(result => result.rows[0] || null);
  } else {
    const stmt = database.prepare(sql);
    return params.length > 0 ? stmt.get(...params) : stmt.get();
  }
}

/**
 * Execute a statement (INSERT, UPDATE, DELETE)
 * @param {string} sql - SQL statement
 * @param {Array} params - Query parameters
 * @returns {Object} Result info (lastInsertRowid, changes)
 */
function run(sql, params = []) {
  const database = initDatabase();
  
  if (config.isTurso()) {
    return database.execute({ sql, args: params }).then(result => ({
      lastInsertRowid: result.lastInsertRowid,
      changes: result.rowsAffected,
    }));
  } else {
    const stmt = database.prepare(sql);
    return params.length > 0 ? stmt.run(...params) : stmt.run();
  }
}

/**
 * Execute multiple statements in a transaction
 * @param {Function} callback - Callback receives db object
 */
function transaction(callback) {
  const database = initDatabase();
  
  if (config.isTurso()) {
    // Turso uses executeMany for transactions
    return database.executeMultiple(callback.toString());
  } else {
    return database.transaction(callback)();
  }
}

/**
 * Execute raw SQL (for schema creation, etc.)
 * @param {string} sql - SQL statement
 */
function exec(sql) {
  const database = initDatabase();
  
  if (config.isTurso()) {
    return database.execute(sql);
  } else {
    return database.exec(sql);
  }
}

/**
 * Get the underlying database connection (advanced usage)
 * @returns {Object} Raw database connection
 */
function getConnection() {
  return initDatabase();
}

/**
 * Close database connection
 */
function close() {
  if (db && config.isSQLite()) {
    db.close();
    db = null;
  }
}

/**
 * Check if database is connected
 * @returns {boolean}
 */
function isConnected() {
  return db !== null;
}

// Export API
module.exports = {
  all,
  get,
  run,
  exec,
  transaction,
  getConnection,
  close,
  isConnected,
  initDatabase,
  config,
};

// Also export constructor for prepared statements (SQLite only)
module.exports.Database = sqlite3 ? sqlite3.Database : null;
