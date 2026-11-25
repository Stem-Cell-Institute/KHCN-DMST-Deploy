const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

// Ensure data directory exists
const dbFile = config.DB_URL.replace(/^file:/, '');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

const client = createClient({
  url: config.DB_URL
});

// Helper to sanitize undefined values to null for SQLite compatibility
function sanitizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map(v => (v === undefined ? null : v));
}

// Helper wrapper to provide standard database access methods
const db = {
  client,

  // Execute raw SQL script (e.g. schema.sql)
  async exec(sql) {
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
  },

  // Query multiple rows (SELECT ...)
  async all(sql, args = []) {
    const rs = await client.execute({ sql, args: sanitizeArgs(args) });
    const cols = rs.columns;
    return rs.rows.map(row => {
      const obj = {};
      cols.forEach((col, idx) => {
        obj[col] = row[idx];
      });
      return obj;
    });
  },

  // Query single row (SELECT ... LIMIT 1)
  async get(sql, args = []) {
    const rows = await this.all(sql, args);
    return rows.length > 0 ? rows[0] : null;
  },

  // Run INSERT / UPDATE / DELETE
  async run(sql, args = []) {
    const rs = await client.execute({ sql, args: sanitizeArgs(args) });
    return {
      lastInsertRowid: rs.lastInsertRowid ? Number(rs.lastInsertRowid) : null,
      rowsAffected: rs.rowsAffected || 0
    };
  },

  // Initialize schema
  async initSchema() {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf-8');
      await this.exec(sql);
      // Bổ sung cột leader_email cho bảng nckh_projects nếu DB cũ chưa có (giữ nguyên toàn bộ dữ liệu hiện có)
      const cols = await this.all('PRAGMA table_info(nckh_projects)');
      if (!cols.some(c => c.name === 'leader_email')) {
        await this.run('ALTER TABLE nckh_projects ADD COLUMN leader_email TEXT');
      }
      console.log('✅ SQLite Schema initialized successfully at:', config.DB_URL);
    }
  }
};

module.exports = db;
