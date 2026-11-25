/**
 * Gắn các router của module con sci-khcn-publications (công bố, ORCID, DOI, enrich, journal-metrics) vào app.
 * Hàm mountSciKhcnPublicationsRouters() được gọi một lần khi khởi động.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const db = require('../lib/db-bridge');

module.exports = function createSciKhcnPublicationsMount({
  adminOnly,
  app,
  authMiddleware,
  insertUserActivityLog,
  masterAdminOnly,
  uploadSjrCsv,
  rootDir,
}) {
  async function mountSciKhcnPublicationsRouters() {
    const moduleBase = path.join(rootDir, 'sci-khcn-publications', 'src');
    const toUrl = (p) => pathToFileURL(p).href;
    const [pubMod, orcidMod, doiMod, dbMod, authPubMod, trustMod] = await Promise.all([
      import(toUrl(path.join(moduleBase, 'routes', 'publications.js'))),
      import(toUrl(path.join(moduleBase, 'routes', 'orcid.js'))),
      import(toUrl(path.join(moduleBase, 'routes', 'doi.js'))),
      import(toUrl(path.join(moduleBase, 'db', 'index.js'))),
      import(toUrl(path.join(moduleBase, 'middleware', 'publicationsAuthMiddleware.js'))),
      import(toUrl(path.join(moduleBase, 'lib', 'trustScoring.js'))),
    ]);

    if (dbMod && typeof dbMod.initDB === 'function') {
      await dbMod.initDB();
    }

    const enrichService = require(path.join(rootDir, 'services', 'enrichmentService.js'));

    function normalizeIssnJournalMetricsInput(raw) {
      if (raw == null || String(raw).trim() === '') return null;
      const compact = String(raw).replace(/[^0-9Xx]/g, '');
      if (compact.length !== 8) return null;
      return `${compact.slice(0, 4)}-${compact.slice(4).toUpperCase()}`;
    }

    app.post('/api/enrich/trigger', authMiddleware, adminOnly, async (req, res) => {
      try {
        const publicationIds = Array.isArray(req.body?.publicationIds) ? req.body.publicationIds : [];
        const stats = await enrichService.enrichPublicationBatch(publicationIds);
        return res.json({
          message: 'Enrichment hoàn tất',
          stats,
        });
      } catch (e) {
        console.error('[enrich/trigger]', e);
        return res.status(500).json({ message: 'Lỗi enrichment' });
      }
    });

    app.get('/api/enrich/stats', authMiddleware, async (req, res) => {
      try {
        const stats = await enrichService.getEnrichmentStats();
        return res.json(stats);
      } catch (e) {
        console.error('[enrich/stats]', e);
        return res.status(500).json({ message: 'Lỗi thống kê enrichment' });
      }
    });

    if (typeof pubMod.mountEnrichmentStatsSse === 'function') {
      pubMod.mountEnrichmentStatsSse(app, authMiddleware, () => enrichService.getEnrichmentStats());
    }

    const { importScimagoCsvToJournalMetrics } = require(path.join(rootDir, 'lib', 'sjr-csv-import'));
    app.post(
      '/api/admin/sjr-csv-import',
      authMiddleware,
      masterAdminOnly,
      (req, res, next) => {
        uploadSjrCsv.single('file')(req, res, (err) => {
          if (err) return res.status(400).json({ message: 'Upload thất bại' });
          next();
        });
      },
      async (req, res) => {
        try {
          const year = parseInt(req.body?.year, 10);
          if (!Number.isFinite(year) || year < 1900 || year > 2100) {
            return res.status(400).json({ message: 'Năm SJR không hợp lệ (1900–2100)' });
          }
          const buf = req.file?.buffer;
          if (!buf || !buf.length) {
            return res.status(400).json({ message: 'Vui lòng chọn file CSV (tên field: file)' });
          }
          const csvText = buf.toString('utf8');
          const result = await importScimagoCsvToJournalMetrics(db, csvText, year);
          return res.json({
            message: `Import SJR ${year}: ${result.ok} dòng OK, ${result.fail} lỗi/bỏ qua (tổng ${result.total} dòng CSV)`,
            ...result,
          });
        } catch (e) {
          console.error('[sjr-csv-import]', e);
          return res.status(500).json({ message: 'Lỗi import SJR' });
        }
      }
    );

    // Quản trị journal_metrics (cập nhật thủ công JCR IF) — đã tách sang routes/admin/journalMetrics.js (Đợt 6.4)
    app.use('/api', require('../routes/admin/journalMetrics')({
      db,
      authMiddleware,
      adminOnly,
      normalizeIssnJournalMetricsInput,
    }));

    // Công bố khoa học — 5 endpoint bổ sung đã tách sang routes/publications/boSung.js.
    // PHẢI mount trước app.use('/api/publications', pubMod.publicationsRouter) để không bị :id nuốt.
    app.use('/api', require('../routes/publications/boSung')({
      db,
      authMiddleware,
      adminOnly,
      masterAdminOnly,
      authPubMod,
      trustMod,
      insertUserActivityLog,
    }));

    app.use('/api/publications', pubMod.publicationsRouter);

    // ── Công tắc Harvest (bật/tắt từ giao diện) ─────────────────────────────────
    // Nguồn sự thật đặt tại đây (sci-ace.db) chứ không ở module con: module con
    // dùng DB riêng (sci_khcn.db), trong khi công tắc phải chặn được cả hai lối
    // vào — POST /api/orcid/harvest và GET /api/orcid/harvest/stream (SSE).
    // Mặc định TẮT: sau khi deploy hoặc khởi động lại, harvest không tự chạy.
    const ORCID_HARVEST_KEY = 'orcid_harvest_enabled';

    function isOrcidHarvestEnabled() {
      try {
        const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(ORCID_HARVEST_KEY);
        return !!row && String(row.value) === '1';
      } catch (e) {
        // Không đọc được trạng thái → coi như tắt; an toàn hơn là để chạy ngoài kiểm soát.
        console.error('[orcid-harvest] Không đọc được công tắc:', e && e.message ? e.message : e);
        return false;
      }
    }

    app.get('/api/orcid/harvest/enabled', authMiddleware, (req, res) => {
      res.json({ ok: true, enabled: isOrcidHarvestEnabled() });
    });

    app.post('/api/orcid/harvest/enabled', authMiddleware, adminOnly, (req, res) => {
      const raw = req.body && typeof req.body === 'object' ? req.body.enabled : undefined;
      const enabled = raw === true || raw === 1 || String(raw) === 'true' || String(raw) === '1';
      try {
        db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)')
          .run(ORCID_HARVEST_KEY, enabled ? '1' : '0');
      } catch (e) {
        console.error('[orcid-harvest] Không lưu được công tắc:', e && e.message ? e.message : e);
        return res.status(500).json({ ok: false, message: 'Không lưu được trạng thái Harvest.' });
      }
      insertUserActivityLog(req, {
        userId: req.user && req.user.id,
        email: req.user && req.user.email,
        action: enabled ? 'orcid_harvest_enabled' : 'orcid_harvest_disabled',
        module: 'publications',
        path: req.originalUrl || '/api/orcid/harvest/enabled',
        detail: JSON.stringify({ at: new Date().toISOString(), enabled })
      });
      console.log(
        `[orcid-harvest] ${enabled ? 'BẬT' : 'TẮT'} bởi ${(req.user && req.user.email) || 'không rõ'}`
      );
      return res.json({ ok: true, enabled });
    });

    // Chặn khi công tắc tắt. Đăng ký theo đúng từng route (không dùng tiền tố
    // '/api/orcid/harvest') để không vô tình chặn luôn hai route /enabled ở trên.
    function requireHarvestEnabled(req, res, next) {
      if (isOrcidHarvestEnabled()) return next();
      const message = 'Chức năng Harvest đang TẮT. Bật công tắc ở trang ORCID Auto-Harvest trước khi quét.';
      // SSE: client là EventSource, chỉ hiểu được thông báo qua chính luồng sự kiện.
      if (String(req.headers.accept || '').includes('text/event-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ ok: false })}\n\n`);
        return res.end();
      }
      return res.status(423).json({ ok: false, success: false, message });
    }
    app.get('/api/orcid/harvest/stream', requireHarvestEnabled);
    app.post('/api/orcid/harvest', requireHarvestEnabled);

    const orcidServiceUrl = toUrl(path.join(moduleBase, 'services', 'orcidService.js'));
    app.post('/api/orcid/harvest', authMiddleware, adminOnly, async (req, res, next) => {
      try {
        const { runHarvestSession } = await import(orcidServiceUrl);
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const opts = {};
        if (Array.isArray(body.researcherIds) && body.researcherIds.length) {
          opts.researcherIds = body.researcherIds;
        }
        if (Array.isArray(body.orcidIds) && body.orcidIds.length) {
          opts.orcidIds = body.orcidIds.map((s) => String(s).trim()).filter(Boolean);
        }
        if (Array.isArray(body.fullNames) && body.fullNames.length) {
          opts.fullNames = body.fullNames.map((s) => String(s).trim()).filter(Boolean);
        }
        const result = await runHarvestSession(opts);
        return res.json({ ok: true, success: true, data: result?.data || {}, ...result });
      } catch (e) {
        return next(e);
      }
    });

    // Khối "Quản lý nghiên cứu viên (ORCID)" và "Duyệt import" trên trang Quản lý
    // công bố là thao tác của riêng Admin. Router con (module sci-khcn-publications)
    // không có lớp phân quyền nào, nên chặn tại đây TRƯỚC khi mount — giao diện đã
    // ẩn bằng .pub-admin-only, nhưng lớp ẩn đó dựa trên localStorage nên không đủ.
    // Chỉ khoá thao tác GHI; GET danh sách vẫn để nguyên cho trang Auto-Harvest.
    app.post('/api/orcid/researchers', authMiddleware, masterAdminOnly);
    app.delete('/api/orcid/researchers/:id', authMiddleware, masterAdminOnly);
    app.post('/api/orcid/queue/:id/approve', authMiddleware, adminOnly);
    app.post('/api/orcid/queue/:id/reject', authMiddleware, adminOnly);
    app.post('/api/orcid/queue/approve-all', authMiddleware, adminOnly);

    app.use('/api/orcid', orcidMod.orcidRouter);
    app.use('/api/doi', doiMod.doiRouter);
    console.log('[SCI-KHCN] Đã mount /api/publications, /api/orcid, /api/doi');
  }

  return { mountSciKhcnPublicationsRouters };
};
