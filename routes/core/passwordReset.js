/**
 * Route quên mật khẩu và đặt lại mật khẩu (/api/forgot-password, /api/reset-password).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../lib/db-bridge');

module.exports = function mountPasswordResetRoutes({ app, sendPasswordResetEmail }) {
  const forgotPasswordLastSentByEmail = new Map();
  const FORGOT_PASSWORD_COOLDOWN_MS = 60_000;

  // Quên mật khẩu: gửi email chứa link đặt lại (chỉ tài khoản tồn tại, không tiết lộ)
  app.post('/api/forgot-password', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: 'Vui lòng nhập email' });
    }
    const row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (!row) {
      return res.json({ message: 'Nếu email tồn tại trong hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu qua email.' });
    }
    const now = Date.now();
    const last = forgotPasswordLastSentByEmail.get(email) || 0;
    if (now - last < FORGOT_PASSWORD_COOLDOWN_MS) {
      return res.status(429).json({ message: 'Vui lòng đợi 1 phút trước khi gửi lại.' });
    }
    forgotPasswordLastSentByEmail.set(email, now);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM password_reset_tokens WHERE email = ?').run(email);
    db.prepare('INSERT INTO password_reset_tokens (token, email, expiresAt) VALUES (?, ?, ?)').run(token, email, expiresAt);
    try {
      await sendPasswordResetEmail(email, token);
    } catch (err) {
      forgotPasswordLastSentByEmail.delete(email);
      console.error('[forgot-password] SMTP:', err && err.message ? err.message : err);
      return res.status(503).json({ message: 'Không gửi được email lúc này. Vui lòng thử lại sau.' });
    }
    return res.json({ message: 'Nếu email tồn tại trong hệ thống, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu qua email.' });
  });

  // Đặt lại mật khẩu (sau khi nhấn link trong email)
  app.post('/api/reset-password', async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password || password.length < 6) {
      return res.status(400).json({ message: 'Link không hợp lệ hoặc mật khẩu mới ít nhất 6 ký tự' });
    }
    const row = db.prepare("SELECT email FROM password_reset_tokens WHERE token = ? AND datetime(expiresAt) > datetime('now')").get(token);
    if (!row) {
      return res.status(400).json({ message: 'Link đã hết hạn hoặc không hợp lệ. Vui lòng yêu cầu quên mật khẩu lại.' });
    }
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, row.email);
    db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
    return res.json({ message: 'Đã đặt lại mật khẩu thành công. Bạn có thể đăng nhập bằng mật khẩu mới.' });
  });
};
