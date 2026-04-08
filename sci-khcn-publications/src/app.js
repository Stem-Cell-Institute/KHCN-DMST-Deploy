/**
 * SCI-KHCN — Publication Management Backend
 * Entry point: src/app.js
 *
 * Stack: Node.js + Express + better-sqlite3 (dev) / @neondatabase/serverless (prod)
 * Deploy: Cloudflare Tunnel → khcn-dmst.sci.edu.vn
 *
 * Để tích hợp vào Cursor:
 *  1. Copy toàn bộ thư mục src/ vào project KHCN của bạn
 *  2. Chạy: npm install (xem package.json)
 *  3. Copy .env.example → .env và điền các API key
 *  4. Mount router vào app chính: app.use('/api/publications', publicationsRouter)
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { publicationsRouter } from './routes/publications.js';
import { orcidRouter } from './routes/orcid.js';
import { doiRouter } from './routes/doi.js';
import { errorHandler } from './middleware/errorHandler.js';
import { initDB } from './db/index.js';
import { publicationsAuthMiddleware } from './middleware/publicationsAuthMiddleware.js';
import { listResearchers } from './lib/trustScoring.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware cơ bản ──────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '12mb' }));

// Rate limiting — bảo vệ các endpoint gọi API bên ngoài
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 phút
  max: 100,                    // 100 req / 15 phút / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' },
});
app.use('/api/', apiLimiter);

app.get('/api/researchers/list-for-disambiguation', publicationsAuthMiddleware, (req, res) => {
  try {
    res.json({ success: true, researchers: listResearchers() });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || String(e) });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/publications', publicationsRouter);   // CRUD công bố
app.use('/api/orcid',        orcidRouter);          // ORCID harvest
app.use('/api/doi',          doiRouter);            // DOI fetch / Crossref

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'sci-khcn-publications', ts: new Date().toISOString() });
});

// ── Error handler (phải đặt cuối) ─────────────────────────────────────────────
app.use(errorHandler);

// ── Khởi động ─────────────────────────────────────────────────────────────────
(async () => {
  await initDB();
  app.listen(PORT, () => {
    console.log(`[SCI-KHCN] Publications API running on port ${PORT}`);
    console.log(`[SCI-KHCN] ENV: ${process.env.NODE_ENV || 'development'}`);
  });
})();

export default app;
