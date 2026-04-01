/**
 * Migration Script: SQLite → Turso (Local Daemon)
 * Chuyển toàn bộ dữ liệu từ SQLite sang Turso local database
 * 
 * Cách sử dụng:
 *   1. Cài Turso CLI: https://turso.tech/install
 *   2. Chạy local daemon:   turso dev --port 8080
 *   3. Cấu hình .env:   DATABASE_URL=turso://localhost:8080/sci-ace
 *                       TURSO_MODE=turso-local
 *   4. Chạy migration: npm run migrate:turso
 *   5. Khởi động app:  npm start
 */

const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '.env' });

const SQLITE_PATH = path.join(__dirname, '..', 'data', 'sci-ace.db');
const TURSO_MODE = process.env.TURSO_MODE || 'local';
const TURSO_URL = process.env.DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.DATABASE_AUTH_TOKEN || '';
const TURSO_LOCAL_HOST = process.env.TURSO_LOCAL_HOST || '127.0.0.1';
const TURSO_LOCAL_PORT = parseInt(process.env.TURSO_PORT || '8080', 10);

async function migrate() {
  console.log('========================================');
  console.log('   Migration: SQLite → Turso');
  console.log('========================================\n');

  const isLocal = TURSO_MODE === 'turso-local';

  // Kiểm tra file SQLite
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error(`❌ Lỗi: Không tìm thấy file SQLite tại: ${SQLITE_PATH}`);
    process.exit(1);
  }

  console.log(`📂 SQLite: ${SQLITE_PATH}`);
  console.log(`☁️  Turso:  ${isLocal ? `Local Daemon (${TURSO_LOCAL_HOST}:${TURSO_LOCAL_PORT})` : TURSO_URL}\n`);

  // Kết nối SQLite
  console.log('🔄 Đang kết nối SQLite...');
  const sqliteDb = new Database(SQLITE_PATH, { readonly: true });

  // Kết nối Turso
  console.log('🔄 Đang kết nối Turso...');
  let tursoDb;
  if (isLocal) {
    // Local: dùng @libsql/client trỏ local HTTP
    tursoDb = createClient({
      url: `http://${TURSO_LOCAL_HOST}:${TURSO_LOCAL_PORT}`,
      authToken: '',
    });
  } else {
    // Remote: dùng URL + token
    tursoDb = createClient({
      url: TURSO_URL,
      authToken: TURSO_AUTH_TOKEN,
    });
  }

  // Lấy danh sách bảng
  console.log('📋 Đang đọc danh sách bảng...');
  const tables = sqliteDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();

  console.log(`✅ Tìm thấy ${tables.length} bảng\n`);

  let totalTables = 0;
  let totalRows = 0;

  for (const table of tables) {
    const tableName = table.name;
    totalTables++;

    if (tableName.includes('sqlite_')) continue;

    console.log(`\n📦 Đang migrate bảng: ${tableName}`);

    try {
      const schemaRows = sqliteDb
        .prepare(`PRAGMA table_info('${tableName}')`)
        .all();

      if (schemaRows.length === 0) {
        console.log(`   ⚠️  Bỏ qua bảng trống`);
        continue;
      }

      const data = sqliteDb.prepare(`SELECT * FROM '${tableName}'`).all();
      console.log(`   📊 ${data.length} dòng dữ liệu`);

      if (data.length === 0) {
        const columns = schemaRows.map(col => `${mapCol(col.name, col.type)}`).join(', ');
        await tursoDb.execute(`CREATE TABLE IF NOT EXISTS "${tableName}" (${columns})`);
        console.log(`   ✅ Đã tạo bảng (không có dữ liệu)`);
        continue;
      }

      const columnNames = schemaRows.map(col => col.name);
      const placeholders = columnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO "${tableName}" (${columnNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

      // Batch insert: collect rows first, then batch to Turso
      let batchSize = 50;
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        const batchValues = [];

        for (const row of batch) {
          const values = columnNames.map(col => {
            const val = row[col];
            if (val === null || val === undefined) return null;
            if (typeof val === 'object') return JSON.stringify(val);
            return val;
          });
          batchValues.push(values);
        }

        // Gửi batch: dùng executeBatch nếu local, loop nếu remote
        for (let b = 0; b < batchValues.length; b++) {
          try {
            await tursoDb.execute({ sql: insertSql, args: batchValues[b] });
          } catch (err) {
            if (!err.message.includes('UNIQUE constraint')) throw err;
          }
        }

        console.log(`   ⏳ Đã insert ${Math.min(i + batchSize, data.length)}/${data.length} dòng`);
      }

      totalRows += data.length;
      console.log(`   ✅ Hoàn tất`);
    } catch (err) {
      console.error(`   ❌ Lỗi: ${err.message}`);

      try {
        console.log(`   🔄 Thử tạo bảng mới...`);
        await tursoDb.execute(`DROP TABLE IF EXISTS "${tableName}"`);

        const sampleRow = sqliteDb.prepare(`SELECT * FROM "${tableName}" LIMIT 1`).get();
        if (sampleRow) {
          const columns = Object.keys(sampleRow).map(col => {
            const val = sampleRow[col];
            let type = 'TEXT';
            if (typeof val === 'number' && Number.isInteger(val)) type = 'INTEGER';
            else if (typeof val === 'number') type = 'REAL';
            return `"${col}" ${type}`;
          }).join(', ');

          await tursoDb.execute(`CREATE TABLE "${tableName}" (${columns})`);

          const allData = sqliteDb.prepare(`SELECT * FROM '${tableName}'`).all();
          const columnNames = Object.keys(sampleRow);
          const placeholders = columnNames.map(() => '?').join(', ');
          const insertSql = `INSERT INTO "${tableName}" (${columnNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

          for (const row of allData) {
            const values = columnNames.map(col => row[col]);
            await tursoDb.execute({ sql: insertSql, args: values });
          }

          console.log(`   ✅ Đã tạo và insert ${allData.length} dòng`);
          totalRows += allData.length;
        }
      } catch (retryErr) {
        console.error(`   ❌ Retry thất bại: ${retryErr.message}`);
      }
    }
  }

  sqliteDb.close();

  console.log('\n========================================');
  console.log('   Migration Hoàn Tất!');
  console.log('========================================');
  console.log(`📊 Tổng kết:`);
  console.log(`   - Bảng đã migrate: ${totalTables}`);
  console.log(`   - Dòng dữ liệu: ${totalRows}`);
  console.log(`\n🌐 Database Turso: ${isLocal ? `Local Daemon` : TURSO_URL}`);
  console.log('\n✅ Bây giờ bạn có thể chạy:');
  console.log('   npm start');
  console.log('   (với DATABASE_URL và TURSO_MODE=turso-local trong .env)');
  console.log('========================================\n');
}

/**
 * Map SQLite column type sang Turso type
 */
function mapCol(name, sqliteType) {
  const type = (sqliteType || 'TEXT').toUpperCase();
  if (type.includes('INT') || type.includes('INTEGER')) return `"${name}" INTEGER`;
  if (type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE')) return `"${name}" REAL`;
  if (type.includes('BLOB')) return `"${name}" BLOB`;
  if (type.includes('BOOLEAN')) return `"${name}" INTEGER`;
  return `"${name}" TEXT`;
}

migrate().catch(err => {
  console.error('❌ Migration thất bại:', err);
  process.exit(1);
});
