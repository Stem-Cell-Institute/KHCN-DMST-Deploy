/**
 * Database Configuration - Hỗ trợ cả SQLite (local) và Turso (production/Cloudflare)
 * 
 * Cách sử dụng:
 * - Development local: DATABASE_URL sẽ là file SQLite local
 * - Production/Cloudflare: DATABASE_URL sẽ là Turso database URL
 * 
 * Ví dụ .env:
 *   # SQLite local (mặc định)
 *   DATABASE_URL=file:./data/sci-ace.db
 *   
 *   # Turso production
 *   DATABASE_URL=libsql://sci-ace-demo.turso.io
 *   DATABASE_AUTH_TOKEN=turso_token_của_bạn
 */

const path = require('path');

// Load environment variables
try { require('dotenv').config({ path: '.env' }); } catch (_) {}

const config = {
  // Xác định loại database
  isTurso: () => {
    const url = process.env.DATABASE_URL || '';
    return url.includes('libsql://') || url.includes('wss://') || url.includes('ws://');
  },
  
  isSQLite: () => !config.isTurso(),
  
  // Cấu hình SQLite (local development)
  sqlite: {
    path: path.join(__dirname, '..', 'data', process.env.SQLITE_FILENAME || 'sci-ace.db'),
  },
  
  // Cấu hình Turso (production/Cloudflare)
  turso: {
    url: process.env.DATABASE_URL || '',
    authToken: process.env.DATABASE_AUTH_TOKEN || '',
  },
  
  // Cổng kết nối mặc định
  port: parseInt(process.env.PORT || '3000', 10),
};

module.exports = config;
