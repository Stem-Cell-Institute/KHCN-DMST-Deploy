/**
 * Optional HTML scrape for homepage sidebar sources (CSS selectors per item).
 * @param {import('better-sqlite3').Database} db
 */
function runHomepageSidebarRssHtmlScrapeMigration(db) {
  const alters = [
    "ALTER TABLE homepage_sidebar_rss_sources ADD COLUMN source_type TEXT NOT NULL DEFAULT 'rss'",
    'ALTER TABLE homepage_sidebar_rss_sources ADD COLUMN scrape_item_selector TEXT',
    'ALTER TABLE homepage_sidebar_rss_sources ADD COLUMN scrape_title_selector TEXT',
    'ALTER TABLE homepage_sidebar_rss_sources ADD COLUMN scrape_link_selector TEXT',
    'ALTER TABLE homepage_sidebar_rss_sources ADD COLUMN scrape_date_selector TEXT',
  ];
  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch (e) {
      /* column already exists */
    }
  }
}

module.exports = runHomepageSidebarRssHtmlScrapeMigration;
