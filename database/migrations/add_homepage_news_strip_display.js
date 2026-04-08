/**
 * Homepage horizontal TIN TỨC strip: display settings (parity with ticker_settings).
 * @param {import('better-sqlite3').Database} db
 */
function runHomepageNewsStripDisplayMigration(db) {
  const cols = [
    ['content_font_size', 'ALTER TABLE homepage_sidebar_rss_settings ADD COLUMN content_font_size INTEGER NOT NULL DEFAULT 13'],
    [
      'content_text_color',
      "ALTER TABLE homepage_sidebar_rss_settings ADD COLUMN content_text_color TEXT NOT NULL DEFAULT '#1e293b'",
    ],
    ['visible_logged_in', 'ALTER TABLE homepage_sidebar_rss_settings ADD COLUMN visible_logged_in INTEGER NOT NULL DEFAULT 1'],
    ['visible_guest', 'ALTER TABLE homepage_sidebar_rss_settings ADD COLUMN visible_guest INTEGER NOT NULL DEFAULT 1'],
    ['links_enabled', 'ALTER TABLE homepage_sidebar_rss_settings ADD COLUMN links_enabled INTEGER NOT NULL DEFAULT 1'],
    ['hover_pause', 'ALTER TABLE homepage_sidebar_rss_settings ADD COLUMN hover_pause INTEGER NOT NULL DEFAULT 1'],
  ];
  for (let i = 0; i < cols.length; i++) {
    const name = cols[i][0];
    const sql = cols[i][1];
    try {
      db.prepare(`SELECT ${name} FROM homepage_sidebar_rss_settings WHERE id = 1`).get();
    } catch (_) {
      db.exec(sql);
    }
  }
}

module.exports = runHomepageNewsStripDisplayMigration;
