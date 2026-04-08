/**
 * src/routes/orcid.js
 * Routes cho ORCID Harvest
 *
 * GET  /api/orcid/researchers         — Danh sách NCV có ORCID
 * POST /api/orcid/researchers         — Thêm / cập nhật NCV
 * DELETE /api/orcid/researchers/:id   — Xóa NCV
 *
 * GET  /api/orcid/harvest/stream      — Bắt đầu harvest, trả về SSE (real-time progress)
 * POST /api/orcid/harvest             — Trên server.js (JWT + adminOnly). Body tuỳ chọn: { fullNames[], researcherIds[], orcidIds[] } để chỉ quét một số NCV
 * GET  /api/orcid/queue               — Lấy danh sách công bố chờ duyệt
 * POST /api/orcid/queue/:id/approve   — Duyệt (import vào publications)
 * POST /api/orcid/queue/:id/reject    — Từ chối
 *
 * SSE (Server-Sent Events) cho phép frontend nhận progress theo từng NCV
 * mà không cần WebSocket — dùng EventSource trên browser là đủ.
 */

import { Router } from 'express';
import {
  runHarvestSession,
  approveQueueItem,
  rejectQueueItem,
  getResearchers,
  upsertResearcher,
  deleteResearcher,
} from '../services/orcidService.js';
import { getDB } from '../db/index.js';

export const orcidRouter = Router();

// ── Researcher CRUD ───────────────────────────────────────────────────────────

// GET /api/orcid/researchers
orcidRouter.get('/researchers', async (_req, res, next) => {
  try {
    const list = await getResearchers();
    res.json({ ok: true, data: list });
  } catch (err) { next(err); }
});

// POST /api/orcid/researchers
// Body: { full_name, orcid_id, department, position, is_active }
orcidRouter.post('/researchers', async (req, res, next) => {
  try {
    const { full_name, orcid_id, department, position, is_active } = req.body;
    if (!full_name || !orcid_id) {
      return res.status(400).json({ ok: false, error: 'Cần có full_name và orcid_id' });
    }
    // Validate định dạng ORCID iD
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid_id)) {
      return res.status(400).json({ ok: false, error: 'ORCID iD không đúng định dạng' });
    }
    await upsertResearcher({ full_name, orcid_id, department, position, is_active });
    res.json({ ok: true, message: `Đã lưu ${full_name}` });
  } catch (err) { next(err); }
});

// DELETE /api/orcid/researchers/:id
orcidRouter.delete('/researchers/:id', async (req, res, next) => {
  try {
    await deleteResearcher(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Harvest với SSE ───────────────────────────────────────────────────────────

/**
 * GET /api/orcid/harvest/stream
 *
 * Phía frontend (JavaScript):
 *   const es = new EventSource('/api/orcid/harvest/stream');
 *   es.onmessage = (e) => {
 *     const event = JSON.parse(e.data);
 *     // event.type: 'researcher_start' | 'researcher_done' | 'session_complete' | 'error'
 *   };
 *   es.addEventListener('done', () => es.close());
 *
 * Mỗi event gửi 1 JSON object với trường `type` để frontend xử lý.
 */
orcidRouter.get('/harvest/stream', async (req, res) => {
  // Thiết lập SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // tắt buffering nginx/Cloudflare
  res.flushHeaders();

  // Helper gửi SSE event
  const send = (data) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // flush nếu có (Express 5 / compression middleware)
    if (typeof res.flush === 'function') res.flush();
  };

  // Keepalive ping 20s/lần để tránh proxy timeout
  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20000);

  const ac = new AbortController();
  const { signal } = ac;
  const onReqClose = () => {
    if (!res.writableEnded) ac.abort();
  };
  req.on('close', onReqClose);

  try {
    send({ type: 'session_start', ts: new Date().toISOString() });

    await runHarvestSession({
      onProgress: (event) => send(event),
      signal,
    });
    // session_complete / session_aborted đã gửi trong runHarvestSession (onProgress)
  } catch (err) {
    if (err.name !== 'AbortError' && !signal.aborted) {
      send({ type: 'error', message: err.message });
    }
  } finally {
    req.off('close', onReqClose);
    clearInterval(keepalive);
    try {
      res.write(`event: done\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    } catch (_) { /* ignore */ }
    res.end();
  }
});

// POST /api/orcid/harvest — đăng ký trên server.js (authMiddleware + adminOnly) trước khi mount router.

// ── Queue management ──────────────────────────────────────────────────────────

// GET /api/orcid/queue?status=pending
orcidRouter.get('/queue', async (req, res, next) => {
  try {
    const db = await getDB();
    const status = req.query.status || 'pending';
    const rows = await queryAll(db,
      `SELECT * FROM publication_queue
       WHERE status = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [status]
    );
    // Parse JSON fields cho frontend
    const data = rows.map(row => ({
      ...row,
      raw_data:      row.raw_data      ? JSON.parse(row.raw_data)      : null,
      enriched_data: row.enriched_data ? JSON.parse(row.enriched_data) : null,
    }));
    res.json({ ok: true, data, total: data.length });
  } catch (err) { next(err); }
});

// POST /api/orcid/queue/:id/approve
// Body (tùy chọn): các field muốn override trước khi import
//   { quartile: "Q1", impact_factor: 7.3, index_db: "Scopus,WoS", sci_authors: "Nguyễn A", project_code: "B2024-01" }
orcidRouter.post('/queue/:id/approve', async (req, res, next) => {
  try {
    const queueId = Number(req.params.id);
    const adminId = req.user?.id || 1; // TODO: lấy từ session/JWT thực
    const overrides = req.body || {};
    const result = await approveQueueItem(queueId, adminId, overrides);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// POST /api/orcid/queue/:id/reject
orcidRouter.post('/queue/:id/reject', async (req, res, next) => {
  try {
    const queueId = Number(req.params.id);
    const adminId = req.user?.id || 1;
    await rejectQueueItem(queueId, adminId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/orcid/queue/approve-all
// Import tất cả pending items một lúc
orcidRouter.post('/queue/approve-all', async (req, res, next) => {
  try {
    const db = await getDB();
    const adminId = req.user?.id || 1;
    const pending = await queryAll(db,
      `SELECT id FROM publication_queue WHERE status = 'pending'`
    );
    const results = [];
    for (const item of pending) {
      try {
        const r = await approveQueueItem(item.id, adminId, {});
        results.push({ id: item.id, ...r });
      } catch (e) {
        results.push({ id: item.id, error: e.message });
      }
    }
    res.json({ ok: true, imported: results.filter(r => !r.error).length, results });
  } catch (err) { next(err); }
});

// ── Helper ────────────────────────────────────────────────────────────────────
async function queryAll(db, sql, params = []) {
  if (db.__isSQLite) return db.prepare(sql).all(...params);
  const result = await db(sql, params);
  return result.rows || result;
}
