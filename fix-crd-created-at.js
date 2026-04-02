const Database = require('better-sqlite3');

const db = new Database('data/sci-ace.db');

const cols = db.prepare('PRAGMA table_info(crd_bookings)').all();
const hasCreatedAt = (cols || []).some((c) => String(c.name) === 'created_at');

if (!hasCreatedAt) {
  db.prepare('ALTER TABLE crd_bookings ADD COLUMN created_at TEXT').run();
  console.log('[fix] Added column crd_bookings.created_at');
} else {
  console.log('[fix] Column crd_bookings.created_at already exists');
}

const before = db
  .prepare("SELECT COUNT(*) AS c FROM crd_bookings WHERE created_at IS NULL OR trim(created_at) = ''")
  .get();

db.prepare("UPDATE crd_bookings SET created_at = datetime('now','localtime') WHERE created_at IS NULL OR trim(created_at) = ''").run();

const after = db
  .prepare("SELECT COUNT(*) AS c FROM crd_bookings WHERE created_at IS NULL OR trim(created_at) = ''")
  .get();

console.log(`[fix] created_at empty rows: ${before.c} -> ${after.c}`);

