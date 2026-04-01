/**
 * Database Status Checker - Kiểm tra trạng thái kết nối database
 * 
 * Cách sử dụng:
 *   npm run db:status
 */

const Database = require('better-sqlite3');
const { createClient } = require('@libsql/client');
const path = require('path');
require('dotenv').config({ path: '.env' });

async function checkStatus() {
  console.log('========================================');
  console.log('   Database Status Checker');
  console.log('========================================\n');

  const isTurso = (process.env.DATABASE_URL || '').includes('libsql://');
  const sqlitePath = path.join(__dirname, '..', 'data', process.env.SQLITE_FILENAME || 'sci-ace.db');
  
  console.log(`📊 Chế độ: ${isTurso ? '☁️  Turso' : '💾 SQLite Local'}\n`);

  // Kiểm tra SQLite
  console.log('📂 SQLite:');
  const fs = require('fs');
  if (fs.existsSync(sqlitePath)) {
    const stats = fs.statSync(sqlitePath);
    const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`   ✅ File tồn tại: ${sqlitePath}`);
    console.log(`   📦 Kích thước: ${sizeMB} MB`);
    
    try {
      const db = new Database(sqlitePath, { readonly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      const totalRows = tables.reduce((sum, t) => {
        try {
          const count = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get().c;
          return sum + count;
        } catch { return sum; }
      }, 0);
      
      console.log(`   📋 Số bảng: ${tables.length}`);
      console.log(`   📊 Tổng số dòng: ${totalRows.toLocaleString()}`);
      
      // Top 5 bảng lớn nhất
      console.log(`\n   📈 Top 5 bảng lớn nhất:`);
      const topTables = tables.map(t => {
        try {
          return { name: t.name, count: db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get().c };
        } catch { return { name: t.name, count: 0 }; }
      }).sort((a, b) => b.count - a.count).slice(0, 5);
      
      topTables.forEach((t, i) => {
        console.log(`      ${i + 1}. ${t.name}: ${t.count.toLocaleString()} dòng`);
      });
      
      db.close();
    } catch (err) {
      console.log(`   ❌ Lỗi đọc database: ${err.message}`);
    }
  } else {
    console.log(`   ⚠️  File không tồn tại: ${sqlitePath}`);
  }

  // Kiểm tra Turso nếu có cấu hình
  if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('libsql://')) {
    console.log(`\n☁️  Turso:`);
    console.log(`   URL: ${process.env.DATABASE_URL}`);
    console.log(`   Token: ${process.env.DATABASE_AUTH_TOKEN ? '✅ Đã cấu hình' : '❌ Chưa cấu hình'}`);
    
    try {
      const turso = createClient({
        url: process.env.DATABASE_URL,
        authToken: process.env.DATABASE_AUTH_TOKEN || '',
      });
      
      const result = await turso.execute('SELECT 1 as test');
      console.log(`   ✅ Kết nối thành công`);
      
      // Lấy thông tin bảng
      const tables = await turso.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      );
      console.log(`   📋 Số bảng: ${tables.rows.length}`);
      
      let totalRows = 0;
      for (const t of tables.rows) {
        try {
          const count = await turso.execute(`SELECT COUNT(*) as c FROM "${t.name}"`);
          totalRows += count.rows[0]?.c || 0;
        } catch {}
      }
      console.log(`   📊 Tổng số dòng: ${totalRows.toLocaleString()}`);
      
    } catch (err) {
      console.log(`   ❌ Lỗi kết nối: ${err.message}`);
    }
  } else {
    console.log(`\n☁️  Turso: ⚠️  Chưa cấu hình (xem .env.example)`);
  }

  // Hướng dẫn
  console.log('\n========================================');
  console.log('   Hướng dẫn');
  console.log('========================================');
  console.log('\n🔄 Chuyển sang Turso:');
  console.log('   1. Cài Turso CLI: npm i -g @turso/cli');
  console.log('   2. Tạo database: turso db create sci-ace');
  console.log('   3. Lấy URL: turso db show sci-ace');
  console.log('   4. Tạo token: turso db tokens create sci-ace');
  console.log('   5. Cập nhật .env');
  console.log('   6. Chạy migration: npm run migrate:turso');
  console.log('\n========================================\n');
}

checkStatus().catch(console.error);
