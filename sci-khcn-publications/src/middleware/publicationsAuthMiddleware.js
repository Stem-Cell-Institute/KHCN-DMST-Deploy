/**
 * Xác thực JWT giống server.js: Bearer, cookie auth_token, hoặc ?token=
 * (module publications độc lập, không import được authMiddleware từ server CJS).
 */

import jwt from 'jsonwebtoken';

/** Cùng giá trị mặc định như server.js — tránh 500 khi .env chưa có JWT_SECRET */
const JWT_SECRET_DEFAULT = 'sci-ace-secret-change-in-production';

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    try {
      return decodeURIComponent(p.slice(idx + 1).trim());
    } catch {
      return p.slice(idx + 1).trim();
    }
  }
  return null;
}

function getTokenFromReq(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const c = getCookie(req, 'auth_token');
  if (c) return c;
  const q = req.query && req.query.token;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return null;
}

export function publicationsAuthMiddleware(req, res, next) {
  const secret = process.env.JWT_SECRET || JWT_SECRET_DEFAULT;
  const token = getTokenFromReq(req);
  if (!token) {
    return res.status(401).json({ message: 'Chưa đăng nhập' });
  }
  try {
    req.user = jwt.verify(token, secret);
    next();
  } catch {
    return res.status(401).json({ message: 'Phiên đăng nhập hết hạn' });
  }
}
