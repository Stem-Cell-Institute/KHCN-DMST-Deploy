/**
 * Fetch and parse RSS 2.0 / Atom feeds (server-side proxy).
 */
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function normalizeInputUrl(raw) {
  const u = String(raw || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    return new URL(u).href;
  } catch {
    return null;
  }
}

/** true nếu IP thuộc dải private/loopback/link-local (kể cả 169.254.169.254 metadata của cloud). */
function isPrivateOrReservedIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 10 || a === 0 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (type === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateOrReservedIp(lower.slice(7));
    return false;
  }
  return true;
}

/**
 * Chặn SSRF: từ chối URL không phải http(s), hoặc trỏ tới host nội bộ/loopback/link-local
 * (kể cả khi tên miền resolve ra IP nội bộ). Ném lỗi nếu URL không an toàn để fetch.
 */
async function assertPublicHttpUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (!/^https?:$/i.test(u.protocol)) throw new Error('BLOCKED_PROTOCOL');
  const hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('BLOCKED_HOST');
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error('BLOCKED_HOST');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new Error('BLOCKED_HOST');
  }
}

function candidateFeedUrls(inputUrl) {
  let u;
  try {
    u = new URL(inputUrl);
  } catch {
    return [inputUrl];
  }
  const origin = u.origin;
  const path = (u.pathname || '').replace(/\/+$/, '');
  const basePage = inputUrl.split('#')[0].trim();
  const out = new Set();
  out.add(basePage);
  const looksLikeFeed =
    /\/feed\/?$/i.test(path) ||
    /\.xml(\?|$)/i.test(basePage) ||
    /\/rss\/?$/i.test(path) ||
    /type=rss/i.test(basePage);
  if (!looksLikeFeed) {
    out.add(`${origin}/feed/`);
    out.add(`${origin}/feed`);
    try {
      out.add(new URL('feed/', basePage.endsWith('/') ? basePage : `${basePage}/`).href);
    } catch (_) {}
  }
  return [...out];
}

function parsePubDateMs(pubDateStr) {
  if (!pubDateStr) return 0;
  const t = Date.parse(pubDateStr);
  return Number.isNaN(t) ? 0 : t;
}

function parseRss2Items(xml, maxItems) {
  const $ = cheerio.load(xml, { xml: true });
  const items = [];
  $('item').each((_, el) => {
    if (items.length >= maxItems) return false;
    const $el = $(el);
    const title = $el.find('title').first().text().replace(/\s+/g, ' ').trim();
    let link = $el.find('link').first().text().trim();
    if (!link) link = $el.find('link').first().attr('href') || '';
    const pubDate = $el.find('pubDate').first().text().trim();
    if (title && link) {
      items.push({
        title,
        link,
        pubDate: pubDate || null,
        pubDateMs: parsePubDateMs(pubDate),
      });
    }
    return undefined;
  });
  return items;
}

function parseAtomItems(xml, maxItems) {
  const $ = cheerio.load(xml, { xml: true });
  const items = [];
  $('feed entry').each((_, el) => {
    if (items.length >= maxItems) return false;
    const $el = $(el);
    const title = $el.find('title').first().text().replace(/\s+/g, ' ').trim();
    let link = $el.find('link[href]').first().attr('href') || '';
    if (!link) link = $el.find('content').first().text().trim() || '';
    const updated = $el.find('updated').first().text().trim();
    const published = $el.find('published').first().text().trim();
    const pubDate = updated || published || null;
    if (title && link) {
      items.push({
        title,
        link,
        pubDate,
        pubDateMs: parsePubDateMs(pubDate),
      });
    }
    return undefined;
  });
  return items;
}

function parseFeedXml(xml, maxItems) {
  const s = String(xml || '').trim();
  if (!s) return [];
  if (/<feed[\s>]/i.test(s) && /<entry[\s>]/i.test(s)) {
    return parseAtomItems(s, maxItems);
  }
  return parseRss2Items(s, maxItems);
}

async function fetchWithTimeout(url, ms) {
  await assertPublicHttpUrl(url);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    return r;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Try several URL candidates until one returns parseable RSS/Atom.
 * @returns {{ xml: string, resolvedUrl: string } | null}
 */
async function fetchFeedXml(inputUrl) {
  const normalized = normalizeInputUrl(inputUrl);
  if (!normalized) return null;
  const candidates = candidateFeedUrls(normalized).slice(0, 3);
  for (const url of candidates) {
    try {
      const r = await fetchWithTimeout(url, 9000);
      if (!r.ok) continue;
      const text = await r.text();
      if (!text || text.length < 80) continue;
      if (!/<rss[\s>]|<feed[\s>]/i.test(text)) continue;
      return { xml: text, resolvedUrl: url };
    } catch (_) {
      /* try next */
    }
  }
  return null;
}

module.exports = {
  normalizeInputUrl,
  candidateFeedUrls,
  parseFeedXml,
  fetchFeedXml,
  assertPublicHttpUrl,
  BROWSER_UA,
};
