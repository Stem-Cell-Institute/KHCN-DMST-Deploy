/**
 * Mount module công bố sci-khcn-publications, middleware 404 cho /api và khởi động HTTP server.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

module.exports = function startServer({
  PORT,
  adminOnly,
  app,
  authMiddleware,
  insertUserActivityLog,
  logServerTimeDriftVsGoogle,
  masterAdminOnly,
  startWorker,
  transporter,
  uploadSjrCsv,
  rootDir,
}) {
  const { mountSciKhcnPublicationsRouters } = require('./sciKhcnPublications')({
    adminOnly,
    app,
    authMiddleware,
    insertUserActivityLog,
    masterAdminOnly,
    uploadSjrCsv,
    rootDir: rootDir,
  });

  (async () => {
    try {
      await mountSciKhcnPublicationsRouters();
    } catch (e) {
      console.error('[SCI-KHCN] Không mount được publications module:', e.message);
    }

    app.use('/api', (req, res, next) => {
      if (
        req.path.startsWith('/publications') ||
        req.path.startsWith('/orcid') ||
        req.path.startsWith('/doi')
      ) {
        return next();
      }
      const p = req.originalUrl || req.url || req.path;
      res.status(404).json({
        message:
          'Không tìm thấy API: ' +
          req.method +
          ' ' +
          p +
          '. Nếu vừa cập nhật code, hãy khởi động lại server (Ctrl+C rồi node server.js).',
      });
    });

    const bindHost =
      process.env.BIND_HOST != null && String(process.env.BIND_HOST).trim() !== ''
        ? String(process.env.BIND_HOST).trim()
        : undefined;
    function onListen() {
      const hostLabel = bindHost || '(mặc định Node)';
      console.log('SCI-ACE server lắng nghe PORT=' + PORT + ' host=' + hostLabel);
      console.log('Kiểm tra kết nối: http://127.0.0.1:' + PORT + '/api/health');
      console.log(`[clock] TZ=${process.env.TZ} (Vietnam civil time / ICT; override with TZ in .env)`);
      logServerTimeDriftVsGoogle();
      if (transporter) console.log('SMTP đã cấu hình — email thông báo sẽ gửi khi có sự kiện (nộp hồ sơ, yêu cầu bổ sung, kết quả họp...)');
      else console.log('Chưa cấu hình SMTP — kiểm tra file .env (SMTP_HOST, SMTP_USER, SMTP_PASS). Email thông báo sẽ không gửi.');
      console.log('Email nhắc nhở duyệt đề xuất: mỗi 3 ngày (phong cách hành chính nhà nước)');
      try {
        startWorker();
      } catch (e) {
        console.error('[EnrichWorker] Không khởi động được:', e.message || e);
      }
    }
    const httpServer = bindHost ? app.listen(PORT, bindHost, onListen) : app.listen(PORT, onListen);
    // Xử lý tường minh lỗi bind (EADDRINUSE, EACCES...): log + exit(1) để PM2/systemd
    // restart sạch, tránh trạng thái zombie "process còn sống nhưng không listen"
    // do uncaughtException handler mặc định chỉ log.
    httpServer.on('error', (err) => {
      const code = err && err.code ? err.code : '(unknown-code)';
      if (code === 'EADDRINUSE') {
        console.error(
          `[FATAL] Không bind được PORT=${PORT} (EADDRINUSE): một tiến trình khác đã chiếm port.\n` +
            `        Kill tiến trình cũ rồi thử lại. Trên Windows: netstat -ano | findstr :${PORT}\n` +
            `        Trên Linux: lsof -i :${PORT}`
        );
      } else if (code === 'EACCES') {
        console.error(
          `[FATAL] Không có quyền bind PORT=${PORT} (EACCES). Dùng port >1024 hoặc chạy với quyền phù hợp.`
        );
      } else {
        console.error('[FATAL] app.listen error:', code, err && err.stack ? err.stack : err);
      }
      process.exit(1);
    });
  })();
};
