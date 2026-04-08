/**

 * Multi-source RSS + optional HTML (CSS selectors) for homepage sidebar.

 */

const { fetchFeedXml, parseFeedXml, normalizeInputUrl } = require('../services/rssFeedUtils');

const { fetchHtmlPage, parseHtmlListItems } = require('../services/htmlScrapeFeedUtils');



const CACHE_MS = 3 * 60 * 1000;

const PER_SOURCE_CAP = 10;

const MERGED_CAP = 48;

const SCROLL_MIN = 0;

const SCROLL_MAX = 300;

const SELECTOR_MAX_LEN = 400;

const FONT_MIN = 10;

const FONT_MAX = 28;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;



let cache = { at: 0, payload: null, cacheKey: '' };

/** Avoid stacking background RSS rebuilds when many clients hit stale cache. */
let rssBgRefreshing = false;



function clampScrollSec(n) {

  const x = parseInt(n, 10);

  if (Number.isNaN(x)) return 50;

  return Math.min(SCROLL_MAX, Math.max(SCROLL_MIN, x));

}



function getSettingsRow(db) {

  return db

    .prepare(

      `SELECT scroll_duration_sec, content_font_size, content_text_color,

       visible_logged_in, visible_guest, links_enabled, hover_pause

       FROM homepage_sidebar_rss_settings WHERE id = 1`

    )

    .get();

}

function publicNewsStripFields(row) {

  const r = row || {};

  const fz = Math.min(FONT_MAX, Math.max(FONT_MIN, parseInt(r.content_font_size, 10) || 13));

  const tc = String(r.content_text_color || '').trim();

  return {

    scrollDurationSec: clampScrollSec(r.scroll_duration_sec),

    contentFontSize: fz,

    contentTextColor: HEX_COLOR.test(tc) ? tc : '#1e293b',

    visibleLoggedIn: Number(r.visible_logged_in) !== 0 ? 1 : 0,

    visibleGuest: Number(r.visible_guest) !== 0 ? 1 : 0,

    linksEnabled: Number(r.links_enabled) !== 0 ? 1 : 0,

    hoverPause: Number(r.hover_pause) !== 0 ? 1 : 0,

  };

}

function mergePublicNewsPayload(db, itemsPayload) {

  const row = getSettingsRow(db);

  const disp = publicNewsStripFields(row);

  return {

    items: (itemsPayload && itemsPayload.items) || [],

    ...disp,

  };

}



function sourceSelectSql() {

  return `SELECT id, feed_url, label, enabled, sort_order,

    COALESCE(NULLIF(TRIM(source_type), ''), 'rss') AS source_type,

    scrape_item_selector, scrape_title_selector, scrape_link_selector, scrape_date_selector

   FROM homepage_sidebar_rss_sources`;

}



function buildCacheKey(rows, scrollSec) {

  return JSON.stringify({

    s: (rows || []).map((r) => [

      r.id,

      r.feed_url,

      r.label,

      r.enabled,

      r.sort_order,

      r.source_type || 'rss',

      r.scrape_item_selector || '',

      r.scrape_title_selector || '',

      r.scrape_link_selector || '',

      r.scrape_date_selector || '',

    ]),

    scroll: scrollSec,

  });

}



function clampSelector(s) {

  const t = String(s || '').trim();

  if (!t) return '';

  return t.slice(0, SELECTOR_MAX_LEN);

}



async function itemsFromSource(src) {

  const label = String(src.label || '').trim() || 'Nguồn';

  const st = String(src.source_type || 'rss').toLowerCase();



  if (st === 'html') {

    const pageUrl = normalizeInputUrl(src.feed_url);

    if (!pageUrl) return [];

    const html = await fetchHtmlPage(pageUrl);

    if (!html) return [];

    const parsed = parseHtmlListItems(

      pageUrl,

      html,

      {

        itemSelector: src.scrape_item_selector || '',

        titleSelector: src.scrape_title_selector || '',

        linkSelector: src.scrape_link_selector || '',

        dateSelector: src.scrape_date_selector || '',

      },

      PER_SOURCE_CAP

    );

    return parsed.map((it) => ({

      title: it.title,

      link: it.link,

      pubDate: it.pubDate,

      pubDateMs: it.pubDateMs,

      sourceLabel: label,

    }));

  }



  const got = await fetchFeedXml(src.feed_url);

  if (!got) return [];

  const parsed = parseFeedXml(got.xml, PER_SOURCE_CAP);

  return parsed.map((it) => ({

    title: it.title,

    link: it.link,

    pubDate: it.pubDate,

    pubDateMs: it.pubDateMs,

    sourceLabel: label,

  }));

}



async function buildMergedPayload(db) {

  const settings = getSettingsRow(db);

  const scrollDurationSec = clampScrollSec(settings && settings.scroll_duration_sec);

  const sources = db

    .prepare(

      `${sourceSelectSql()}

       WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`

    )

    .all();



  const chunks = await Promise.all(sources.map((src) => itemsFromSource(src)));

  const allItems = chunks.flat();



  allItems.sort((a, b) => (b.pubDateMs || 0) - (a.pubDateMs || 0));

  const items = allItems.slice(0, MERGED_CAP);



  return {

    items,

    scrollDurationSec,

  };

}



module.exports = function registerHomepageSidebarRss(app, deps) {

  const { db, authMiddleware, adminOnly } = deps;

  /** DB-only: full TIN TỨC strip settings (no RSS fetch — fast). */
  app.get('/api/homepage-sidebar-rss/config', (req, res) => {
    try {
      const settings = getSettingsRow(db);
      res.set('Cache-Control', 'no-store');
      res.json(publicNewsStripFields(settings));
    } catch (e) {
      res.set('Cache-Control', 'no-store');
      res.json(publicNewsStripFields(null));
    }
  });

  app.get('/api/homepage-sidebar-rss', async (req, res) => {

    try {

      res.set('Cache-Control', 'no-store');

      const settings = getSettingsRow(db);

      const scrollDurationSec = clampScrollSec(settings && settings.scroll_duration_sec);

      const sources = db

        .prepare(

          `${sourceSelectSql()}

           WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`

        )

        .all();

      const key = buildCacheKey(sources, scrollDurationSec);

      const now = Date.now();

      if (cache.payload && cache.cacheKey === key && now - cache.at < CACHE_MS) {

        return res.json({ ...mergePublicNewsPayload(db, cache.payload), cached: true });

      }

      // Same sources/settings but cache expired: respond immediately (fast F5), refresh in background.
      if (cache.payload && cache.cacheKey === key) {
        res.json({ ...mergePublicNewsPayload(db, cache.payload), cached: true, stale: true });
        if (!rssBgRefreshing) {
          rssBgRefreshing = true;
          buildMergedPayload(db)
            .then((payload) => {
              cache = { at: Date.now(), payload, cacheKey: key };
            })
            .catch(() => {})
            .finally(() => {
              rssBgRefreshing = false;
            });
        }
        return;
      }

      const payload = await buildMergedPayload(db);

      cache = { at: now, payload, cacheKey: key };

      return res.json({ ...mergePublicNewsPayload(db, payload), cached: false });

    } catch (e) {

      if (cache.payload) {

        return res.json({ ...mergePublicNewsPayload(db, cache.payload), stale: true });

      }

      return res.status(500).json({ message: e.message || 'RSS error' });

    }

  });



  /** Legacy JSON shape (no per-item sourceLabel) for older clients */

  app.get('/api/nafosted-feed', async (req, res) => {

    try {

      const settings = getSettingsRow(db);

      const scrollDurationSec = clampScrollSec(settings && settings.scroll_duration_sec);

      const sources = db

        .prepare(

          `${sourceSelectSql()}

           WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`

        )

        .all();

      const key = buildCacheKey(sources, scrollDurationSec);

      const now = Date.now();

      let payload;

      const hit = cache.payload && cache.cacheKey === key && now - cache.at < CACHE_MS;

      if (hit) {

        payload = cache.payload;

      } else {

        payload = await buildMergedPayload(db);

        cache = { at: now, payload, cacheKey: key };

      }

      const items = (payload.items || []).map((it) => ({

        title: it.title,

        link: it.link,

        pubDate: it.pubDate,

      }));

      return res.json({

        homeUrl: 'https://nafosted.gov.vn/',

        feedUrl: 'https://nafosted.gov.vn/feed/',

        items,

        scrollDurationSec: payload.scrollDurationSec,

        cached: hit,

      });

    } catch (e) {

      return res.status(502).json({ message: e.message || 'Feed error' });

    }

  });



  app.get('/api/admin/homepage-sidebar-rss/sources', authMiddleware, adminOnly, (req, res) => {

    try {

      const rows = db

        .prepare(

          `${sourceSelectSql()} ORDER BY sort_order ASC, id ASC`

        )

        .all();

      const st = getSettingsRow(db);

      res.json({

        sources: rows,

        ...publicNewsStripFields(st),

      });

    } catch (e) {

      res.status(500).json({ message: e.message || 'DB error' });

    }

  });



  app.post('/api/admin/homepage-sidebar-rss/sources', authMiddleware, adminOnly, (req, res) => {

    try {

      const body = req.body || {};

      const feed_url = normalizeInputUrl(body.feed_url);

      const label = String(body.label || '').trim().slice(0, 120);

      if (!feed_url) {

        return res.status(400).json({ message: 'URL không hợp lệ (cần http/https).' });

      }

      if (!label) {

        return res.status(400).json({ message: 'Tên nguồn (nhãn) không được để trống.' });

      }



      const source_type = String(body.source_type || 'rss').toLowerCase() === 'html' ? 'html' : 'rss';

      let scrape_item_selector = null;

      let scrape_title_selector = null;

      let scrape_link_selector = null;

      let scrape_date_selector = null;



      if (source_type === 'html') {

        scrape_item_selector = clampSelector(body.scrape_item_selector);

        scrape_title_selector = clampSelector(body.scrape_title_selector);

        scrape_link_selector = clampSelector(body.scrape_link_selector) || null;

        scrape_date_selector = clampSelector(body.scrape_date_selector) || null;

        if (!scrape_item_selector || !scrape_title_selector) {

          return res.status(400).json({

            message:

              'Chế độ HTML: nhập CSS selector cho ô tin (item) và vùng tiêu đề (trong mỗi ô).',

          });

        }

      }



      const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM homepage_sidebar_rss_sources').get();

      const sort_order = maxRow && typeof maxRow.n === 'number' ? maxRow.n : 0;



      let info;

      try {

        info = db

          .prepare(

            `INSERT INTO homepage_sidebar_rss_sources (

              feed_url, label, enabled, sort_order,

              source_type, scrape_item_selector, scrape_title_selector, scrape_link_selector, scrape_date_selector

            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`

          )

          .run(

            feed_url,

            label,

            sort_order,

            source_type,

            scrape_item_selector,

            scrape_title_selector,

            scrape_link_selector,

            scrape_date_selector

          );

      } catch (e) {

        if ((e.message || '').includes('no such column')) {

          return res.status(500).json({

            message:

              'CSDL chưa có cột scrape (chạy migration add_homepage_sidebar_rss_html_scrape) hoặc khởi động lại server.',

          });

        }

        throw e;

      }



      cache = { at: 0, payload: null, cacheKey: '' };

      res.json({ success: true, id: info.lastInsertRowid });

    } catch (e) {

      res.status(500).json({ message: e.message || 'DB error' });

    }

  });



  app.delete('/api/admin/homepage-sidebar-rss/sources/:id', authMiddleware, adminOnly, (req, res) => {

    try {

      const id = parseInt(req.params.id, 10);

      if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

      const r = db.prepare('DELETE FROM homepage_sidebar_rss_sources WHERE id = ?').run(id);

      cache = { at: 0, payload: null, cacheKey: '' };

      res.json({ success: true, changes: r.changes });

    } catch (e) {

      res.status(500).json({ message: e.message || 'DB error' });

    }

  });



  app.put('/api/admin/homepage-sidebar-rss/settings', authMiddleware, adminOnly, (req, res) => {

    try {

      db.prepare('INSERT OR IGNORE INTO homepage_sidebar_rss_settings (id) VALUES (1)').run();

      const row = getSettingsRow(db);

      if (!row) {

        return res.status(500).json({ message: 'Không đọc được cấu hình thanh tin' });

      }

      const b = req.body || {};

      let scroll = clampScrollSec(row.scroll_duration_sec);

      if (b.scroll_duration_sec != null || b.scrollDurationSec != null) {

        scroll = clampScrollSec(

          b.scroll_duration_sec != null ? b.scroll_duration_sec : b.scrollDurationSec

        );

      }

      let fz = Math.min(FONT_MAX, Math.max(FONT_MIN, parseInt(row.content_font_size, 10) || 13));

      if (b.content_font_size != null) {

        const n = parseInt(b.content_font_size, 10);

        if (Number.isNaN(n) || n < FONT_MIN || n > FONT_MAX) {

          return res.status(400).json({ message: `Cỡ chữ phải từ ${FONT_MIN} đến ${FONT_MAX} (px)` });

        }

        fz = n;

      }

      if (b.contentFontSize != null) {

        const n = parseInt(b.contentFontSize, 10);

        if (Number.isNaN(n) || n < FONT_MIN || n > FONT_MAX) {

          return res.status(400).json({ message: `Cỡ chữ phải từ ${FONT_MIN} đến ${FONT_MAX} (px)` });

        }

        fz = n;

      }

      let color = HEX_COLOR.test(String(row.content_text_color || '').trim())

        ? String(row.content_text_color).trim()

        : '#1e293b';

      if (b.content_text_color != null) {

        const c = String(b.content_text_color || '').trim();

        if (!HEX_COLOR.test(c)) {

          return res.status(400).json({ message: 'Màu chữ phải dạng #RRGGBB' });

        }

        color = c;

      }

      if (b.contentTextColor != null) {

        const c = String(b.contentTextColor || '').trim();

        if (!HEX_COLOR.test(c)) {

          return res.status(400).json({ message: 'Màu chữ phải dạng #RRGGBB' });

        }

        color = c;

      }

      let vl = Number(row.visible_logged_in) !== 0 ? 1 : 0;

      let vg = Number(row.visible_guest) !== 0 ? 1 : 0;

      let le = Number(row.links_enabled) !== 0 ? 1 : 0;

      let hp = Number(row.hover_pause) !== 0 ? 1 : 0;

      if (b.visible_logged_in !== undefined) vl = b.visible_logged_in ? 1 : 0;

      if (b.visible_guest !== undefined) vg = b.visible_guest ? 1 : 0;

      if (b.links_enabled !== undefined) le = b.links_enabled ? 1 : 0;

      if (b.hover_pause !== undefined) hp = b.hover_pause ? 1 : 0;

      if (b.visibleLoggedIn !== undefined) vl = b.visibleLoggedIn ? 1 : 0;

      if (b.visibleGuest !== undefined) vg = b.visibleGuest ? 1 : 0;

      if (b.linksEnabled !== undefined) le = b.linksEnabled ? 1 : 0;

      if (b.hoverPause !== undefined) hp = b.hoverPause ? 1 : 0;

      db

        .prepare(

          `UPDATE homepage_sidebar_rss_settings SET

           scroll_duration_sec = ?, content_font_size = ?, content_text_color = ?,

           visible_logged_in = ?, visible_guest = ?, links_enabled = ?, hover_pause = ?,

           updated_at = datetime('now') WHERE id = 1`

        )

        .run(scroll, fz, color, vl, vg, le, hp);

      cache = { at: 0, payload: null, cacheKey: '' };

      const out = publicNewsStripFields(getSettingsRow(db));

      res.json({ success: true, ...out });

    } catch (e) {

      res.status(500).json({ message: e.message || 'DB error' });

    }

  });

};

