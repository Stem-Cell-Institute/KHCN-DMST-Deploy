/**
 * Route /api/health, /api/server-time (kèm kiểm tra trôi giờ), /favicon.ico và logo Viện.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');

module.exports = function mountHealthAndTimeRoutes({ app, rootDir }) {
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, message: 'Backend đang chạy' });
  });

  /** Compare OS clock to Google edge HTTP Date (UTC reference). Does not change system time. */
  function logServerTimeDriftVsGoogle() {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    fetch('https://www.google.com', { method: 'HEAD', signal: c.signal })
      .then((r) => {
        clearTimeout(t);
        const dh = r.headers.get('date');
        if (!dh) return;
        const skewSec = Math.round((new Date(dh).getTime() - Date.now()) / 1000);
        if (Math.abs(skewSec) > 120) {
          console.warn(
            `[clock] OS clock differs from Google HTTP Date by ~${skewSec}s. Sync system time (Windows: Settings → Time & language) or NTP. Application TZ=${process.env.TZ}`
          );
        }
      })
      .catch(() => {
        clearTimeout(t);
      });
  }

  // Public: server wall clock vs Google HTTP Date (for diagnostics; ICT via TZ)
  app.get('/api/server-time', async (req, res) => {
    const tz = process.env.TZ || 'Asia/Ho_Chi_Minh';
    const payload = {
      timezone: tz,
      serverUtcIso: new Date().toISOString(),
      vietnamWallClock: new Date().toLocaleString('vi-VN', {
        timeZone: tz,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    };
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 6000);
      const r = await fetch('https://www.google.com', { method: 'HEAD', signal: c.signal });
      clearTimeout(t);
      const dh = r.headers.get('date');
      if (dh) {
        const g = new Date(dh);
        payload.googleHttpDateHeader = dh;
        payload.googleUtcIso = g.toISOString();
        payload.skewSecondsVsGoogle = Math.round((g.getTime() - Date.now()) / 1000);
      }
    } catch (e) {
      payload.googleReferenceError = String(e.message || 'unavailable');
    }
    res.set('Cache-Control', 'no-store');
    res.json(payload);
  });

  // Favicon: trả 204 để tránh 404 trong Console khi trình duyệt tự gọi /favicon.ico
  app.get('/favicon.ico', (req, res) => {
    const favPath = path.join(rootDir, 'favicon.ico');
    if (fs.existsSync(favPath)) return res.sendFile(favPath);
    res.status(204).end();
  });

  // Route phục vụ logo (đường dẫn tuyệt đối, tránh lỗi khi mở qua server)
  const logoPath = path.join(rootDir, 'images', 'logo-vien-te-bao-goc.png');
  app.get('/images/logo-vien-te-bao-goc.png', (req, res) => {
    if (fs.existsSync(logoPath)) {
      res.sendFile(logoPath);
    } else {
      res.status(404).send('Logo not found');
    }
  });

  return { logServerTimeDriftVsGoogle };
};
