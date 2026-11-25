/**
 * Cấu hình Helmet security headers, CORS allowlist và express.json body limit.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

module.exports = function mountSecurityAndCors({ BODY_JSON_LIMIT_STR, PORT, app }) {
  function normalizeCorsOriginValue(s) {
    const t = String(s || '').trim();
    if (!t) return '';
    try {
      const u = new URL(t);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return `${u.protocol}//${u.host}`;
    } catch {
      return '';
    }
  }

  function buildCorsOriginAllowlist() {
    const allow = new Set();
    const add = (raw) => {
      const n = normalizeCorsOriginValue(raw);
      if (n) allow.add(n);
    };
    const corsOriginsEnv = process.env.CORS_ORIGINS;
    if (corsOriginsEnv != null && String(corsOriginsEnv).trim()) {
      String(corsOriginsEnv)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach(add);
    }
    if (process.env.BASE_URL != null && String(process.env.BASE_URL).trim()) {
      add(process.env.BASE_URL);
    }
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    if (!isProd) {
      const p = String(PORT);
      add(`http://localhost:${p}`);
      add(`http://127.0.0.1:${p}`);
      add('http://localhost:3000');
      add('http://127.0.0.1:3000');
    }
    return allow;
  }

  const CORS_ORIGIN_ALLOWLIST = buildCorsOriginAllowlist();
  (function assertCorsConfiguredInProduction() {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    if (!isProd || CORS_ORIGIN_ALLOWLIST.size > 0) return;
    console.error(
      '[FATAL] Production: danh sách CORS rỗng. Đặt BASE_URL và/hoặc CORS_ORIGINS (các origin cách nhau bằng dấu phẩy, ví dụ https://app.example.com,https://admin.example.com).'
    );
    process.exit(1);
  })();

  function corsOriginCallback(origin, callback) {
    if (!origin) return callback(null, true);
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    if (!isProd && origin === 'null') return callback(null, true);
    const n = normalizeCorsOriginValue(origin);
    if (n && CORS_ORIGIN_ALLOWLIST.has(n)) return callback(null, origin);
    return callback(null, false);
  }

  // Middleware (static đặt sau API để /api/* luôn do API xử lý)
  (function mountSecurityHeaders() {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    app.use(
      helmet({
        crossOriginEmbedderPolicy: false,
        strictTransportSecurity: isProd ? undefined : false,
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'self'"],
            objectSrc: ["'none'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https:', 'http:'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
            fontSrc: ["'self'", 'https:', 'data:'],
            connectSrc: ["'self'", 'https:', 'wss:', 'http:', 'ws:'],
            frameSrc: ["'self'", 'https:', 'http:'],
            upgradeInsecureRequests: isProd ? [] : null,
          },
        },
      })
    );
  })();
  app.use(cors({ origin: corsOriginCallback }));
  // BibTeX lớn (JSON) cần > 100kb mặc định của Express — không liên quan giới hạn file của multer (multipart).
  app.use(express.json({ limit: BODY_JSON_LIMIT_STR }));
};
