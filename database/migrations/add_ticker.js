/**
 * Migration: Ticker Thông Báo — tạo bảng + seed mặc định.
 * Idempotent: gọi mỗi lần khởi động (CREATE IF NOT EXISTS + INSERT OR IGNORE).
 * @param {import('better-sqlite3').Database} db
 */
function runTickerMigration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticker_settings (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      is_visible   INTEGER NOT NULL DEFAULT 1,
      speed        INTEGER NOT NULL DEFAULT 30,
      links_enabled INTEGER NOT NULL DEFAULT 1,
      hover_pause  INTEGER NOT NULL DEFAULT 1,
      content_font_size INTEGER NOT NULL DEFAULT 13,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO ticker_settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS ticker_categories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL,
      bg_color   TEXT NOT NULL DEFAULT '#ede9fe',
      fg_color   TEXT NOT NULL DEFAULT '#5b21b6',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO ticker_categories (key,label,bg_color,fg_color,sort_order)
    VALUES
      ('pub',   'Công bố', '#ede9fe','#5b21b6', 1),
      ('news',  'Tin tức', '#d1fae5','#065f46', 2),
      ('event', 'Sự kiện', '#fff7ed','#9a3412', 3);

    CREATE TABLE IF NOT EXISTS ticker_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES ticker_categories(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      link        TEXT,
      is_active   INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  try {
    db.prepare('SELECT content_font_size FROM ticker_settings WHERE id = 1').get();
  } catch (_) {
    db.exec('ALTER TABLE ticker_settings ADD COLUMN content_font_size INTEGER NOT NULL DEFAULT 13');
  }
}

module.exports = runTickerMigration;
