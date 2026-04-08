/**
 * Homepage right column: multi-source RSS + scroll duration (admin).
 * @param {import('better-sqlite3').Database} db
 */
function runHomepageSidebarRssMigration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS homepage_sidebar_rss_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      scroll_duration_sec INTEGER NOT NULL DEFAULT 50,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO homepage_sidebar_rss_settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS homepage_sidebar_rss_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_url TEXT NOT NULL,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const n = db.prepare('SELECT COUNT(*) AS c FROM homepage_sidebar_rss_sources').get();
  if (n && n.c === 0) {
    db.prepare(
      `INSERT INTO homepage_sidebar_rss_sources (feed_url, label, enabled, sort_order)
       VALUES (?, ?, 1, 0)`
    ).run('https://nafosted.gov.vn/feed/', 'NAFOSTED');
  }
}

module.exports = runHomepageSidebarRssMigration;
