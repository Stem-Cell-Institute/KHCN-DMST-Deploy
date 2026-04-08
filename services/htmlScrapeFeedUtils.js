/**
 * Fetch HTML page and extract list items via CSS selectors (Cheerio).
 * Used when RSS/Atom is not available for a site.
 */
const cheerio = require('cheerio');
const { BROWSER_UA } = require('./rssFeedUtils');

const MAX_HTML_CHARS = 2 * 1024 * 1024;
const FETCH_MS = 12000;

async function fetchHtmlPage(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_MS);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text || text.length > MAX_HTML_CHARS) return null;
    return text;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} pageUrl Absolute page URL (for resolving relative links)
 * @param {string} html
 * @param {{ itemSelector: string, titleSelector: string, linkSelector?: string, dateSelector?: string }} rules
 * @param {number} maxItems
 * @returns {{ title: string, link: string, pubDate: string|null, pubDateMs: number }[]}
 */
function parseHtmlListItems(pageUrl, html, rules, maxItems) {
  const itemSel = String(rules.itemSelector || '').trim();
  const titleSel = String(rules.titleSelector || '').trim();
  const linkSel = String(rules.linkSelector || '').trim();
  const dateSel = String(rules.dateSelector || '').trim();
  const cap = Math.min(Math.max(1, maxItems || 10), 50);
  if (!itemSel || !titleSel || !html) return [];

  let $;
  try {
    $ = cheerio.load(html, { decodeEntities: true });
  } catch (_) {
    return [];
  }

  const items = [];
  try {
    $(itemSel).each((_, el) => {
      if (items.length >= cap) return false;
      const $item = $(el);
      const titleNode =
        titleSel === '_root' || titleSel === '_self' ? $item : $item.find(titleSel).first();
      if (!titleNode.length) return undefined;

      let title = titleNode.text().replace(/\s+/g, ' ').trim();
      let link = '';

      if (linkSel && linkSel !== '_root' && linkSel !== '_self') {
        const $lnk = $item.find(linkSel).first();
        link = ($lnk.attr('href') || '').trim();
      }
      if (!link && (linkSel === '_self' || linkSel === '_root') && $item.is('a')) {
        link = ($item.attr('href') || '').trim();
      }
      if (!link && titleNode.is('a')) {
        link = (titleNode.attr('href') || '').trim();
      }
      if (!link) {
        const $fa = $item.find('a[href]').first();
        link = ($fa.attr('href') || '').trim();
      }

      if (!title && link) title = link;
      if (!title || !link) return undefined;

      try {
        link = new URL(link, pageUrl).href;
      } catch (_) {
        return undefined;
      }
      if (!/^https?:\/\//i.test(link)) return undefined;

      let pubDate = null;
      let pubDateMs = 0;
      if (dateSel) {
        const $d =
          dateSel === '_self' || dateSel === '_root' ? $item : $item.find(dateSel).first();
        if ($d.length) {
          const iso = ($d.attr && $d.attr('datetime')) ? String($d.attr('datetime')).trim() : '';
          if (iso) {
            pubDate = iso;
            const parsed = Date.parse(iso);
            pubDateMs = Number.isNaN(parsed) ? 0 : parsed;
          } else {
            const raw = $d.text().replace(/\s+/g, ' ').trim();
            if (raw) {
              pubDate = raw;
              const parsed = Date.parse(raw);
              pubDateMs = Number.isNaN(parsed) ? 0 : parsed;
            }
          }
        }
      }

      items.push({
        title,
        link,
        pubDate,
        pubDateMs,
      });
      return undefined;
    });
  } catch (_) {
    return items;
  }

  return items;
}

module.exports = {
  fetchHtmlPage,
  parseHtmlListItems,
};
