/**
 * src/middleware/errorHandler.js
 * Global error handler — đặt cuối cùng trong app.js
 */

export function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Lỗi máy chủ nội bộ';

  // Không log chi tiết lỗi ra prod để bảo mật
  if (process.env.NODE_ENV !== 'production') {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err);
  } else {
    console.error(`[ERROR] ${req.method} ${req.path}: ${message}`);
  }

  res.status(status).json({
    ok:      false,
    error:   message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}
