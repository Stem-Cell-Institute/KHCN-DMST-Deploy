/**
 * Cấu hình trust proxy, EJS views, handler lỗi process toàn cục và rate-limiter sớm cho /api.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const jwt = require('jsonwebtoken');

module.exports = function setupExpressApp({ app, ipKeyGenerator, rateLimit, rootDir }) {
  (function applyTrustProxy() {
    const raw = process.env.TRUST_PROXY;
    if (raw == null || String(raw).trim() === '' || raw === '0' || String(raw).toLowerCase() === 'false') {
      return;
    }
    const n = parseInt(raw, 10);
    app.set('trust proxy', Number.isFinite(n) && n > 0 ? n : 1);
  })();
  app.set('views', path.join(rootDir, 'views'));
  app.set('view engine', 'ejs');

  // Lỗi không bắt được trong async / callback — log để vận hành (PM2/Docker) còn dấu vết.
  // uncaughtException: trạng thái process không an toàn; nhiều nơi gọi process.exit(1) sau log để tiến trình giám sát tự restart.
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection:', reason instanceof Error ? reason.stack || reason : reason);
  });

  // Giới hạn tốc độ toàn bộ /api/* trước express.json — giảm nguy cơ flood body JSON (RAM/CPU).
  (function mountApiRateLimitEarly() {
    const windowMs = Math.max(1000, parseInt(process.env.API_RATE_LIMIT_WINDOW_MS || '900000', 10) || 900000);
    const max = Math.max(1, parseInt(process.env.API_RATE_LIMIT_MAX || '400', 10) || 400);
    function getRateLimitKey(req) {
      // Ưu tiên tách theo user đăng nhập để tránh dồn toàn bộ request theo 1 IP/proxy.
      const auth = String(req.headers.authorization || '').trim();
      if (auth.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim();
        if (token) {
          try {
            const payload = jwt.decode(token) || {};
            const userKey = payload.uid || payload.userId || payload.id || payload.email || payload.sub;
            if (userKey != null && String(userKey).trim() !== '') {
              return `user:${String(userKey).trim().toLowerCase()}`;
            }
          } catch (_) {}
        }
      }

      // Fallback cho khách chưa đăng nhập: dùng IP (ưu tiên IP client từ proxy nếu có).
      const xff = String(req.headers['x-forwarded-for'] || '').trim();
      const firstForwardedIp = xff ? xff.split(',')[0].trim() : '';
      const ip = firstForwardedIp || req.ip || req.socket?.remoteAddress || 'unknown';
      return `ip:${ipKeyGenerator(ip)}`;
    }
    const apiRateLimiter = rateLimit({
      windowMs,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: getRateLimitKey,
      message: { message: 'Quá nhiều yêu cầu tới API, vui lòng thử lại sau.' },
    });
    app.use('/api', apiRateLimiter);
  })();
};
