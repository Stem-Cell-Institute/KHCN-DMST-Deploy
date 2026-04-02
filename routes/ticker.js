/**
 * Ticker Thông Báo — API + trang admin EJS
 */
const express = require('express');

const ALLOWED_SPEEDS = new Set([10, 20, 30, 40, 50, 60, 70, 80]);
const FONT_MIN = 11;
const FONT_MAX = 20;
const HEX6 = /^#[0-9a-fA-F]{6}$/;

function slugifyLabel(label) {
  const raw = String(label || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return raw || 'loai';
}

function validateContent(content) {
  const t = String(content || '').trim();
  if (!t) return { ok: false, message: 'Nội dung không được để trống' };
  if (t.length > 500) return { ok: false, message: 'Nội dung tối đa 500 ký tự' };
  return { ok: true, value: t };
}

function validateLink(link) {
  if (link == null || String(link).trim() === '') return { ok: true, value: null };
  const u = String(link).trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, message: 'Liên kết phải bắt đầu bằng http:// hoặc https://' };
  return { ok: true, value: u };
}

function validateColor(c, field) {
  if (!HEX6.test(String(c || '').trim())) {
    return { ok: false, message: `${field} phải là mã màu dạng #RRGGBB` };
  }
  return { ok: true, value: String(c).trim() };
}

module.exports = function createTickerRouter(deps) {
  const {
    db,
    authMiddleware,
    jwt,
    JWT_SECRET,
    getTokenFromReq,
    userIdIsBanned,
    clearAuthCookie,
  } = deps;

  const router = express.Router();

  /** Giống adminOnly nhưng JSON đúng chuẩn { success, message } cho module ticker */
  function adminTickerOnly(req, res, next) {
    if (!req.user || (req.user.role || '').toLowerCase() !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    next();
  }

  function requireAdminHtml(req, res, next) {
    const token = getTokenFromReq(req);
    if (!token) {
      return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent('/admin/ticker'));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (userIdIsBanned(payload.id)) {
        clearAuthCookie(res);
        return res.redirect(302, '/dang-nhap.html?banned=1');
      }
      let reqUser = payload;
      try {
        const row = db.prepare('SELECT id, email, fullname, role FROM users WHERE id = ?').get(payload.id);
        if (row) {
          reqUser = {
            id: row.id,
            email: row.email,
            fullname: row.fullname,
            role: row.role,
          };
        }
      } catch (_) {
        /* giữ payload */
      }
      if ((reqUser.role || '').toLowerCase() !== 'admin') {
        return res
          .status(403)
          .send(
            '<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Không có quyền</title></head><body><p>Chỉ Admin mới truy cập được trang này.</p><p><a href="/index.html">Trang chủ</a></p></body></html>'
          );
      }
      req.user = reqUser;
      next();
    } catch (e) {
      return res.redirect(302, '/dang-nhap.html?returnUrl=' + encodeURIComponent('/admin/ticker'));
    }
  }

  function loadSettings() {
    return db
      .prepare(
        'SELECT id, is_visible, speed, links_enabled, hover_pause, content_font_size, updated_at FROM ticker_settings WHERE id = 1'
      )
      .get();
  }

  function loadCategoriesAll() {
    return db
      .prepare(
        'SELECT id, key, label, bg_color, fg_color, sort_order, created_at FROM ticker_categories ORDER BY sort_order ASC, id ASC'
      )
      .all();
  }

  function loadItemsAdmin(activeOnly) {
    let sql = `
      SELECT i.id, i.category_id, i.content, i.link, i.is_active, i.sort_order, i.created_by, i.created_at, i.updated_at,
             c.key AS cat_key, c.label AS cat_label, c.bg_color AS cat_bg, c.fg_color AS cat_fg
      FROM ticker_items i
      JOIN ticker_categories c ON c.id = i.category_id
    `;
    if (activeOnly) sql += ' WHERE i.is_active = 1';
    sql += ' ORDER BY i.sort_order ASC, i.id ASC';
    return db.prepare(sql).all();
  }

  /** GET /api/ticker/public */
  router.get('/api/ticker/public', (req, res) => {
    try {
      const settingsRow = loadSettings();
      if (!settingsRow) {
        return res.status(500).json({ success: false, message: 'Thiếu cấu hình ticker' });
      }
      const settings = {
        is_visible: Number(settingsRow.is_visible),
        speed: Number(settingsRow.speed),
        links_enabled: Number(settingsRow.links_enabled),
        hover_pause: Number(settingsRow.hover_pause),
        content_font_size: Math.min(
          FONT_MAX,
          Math.max(FONT_MIN, Number(settingsRow.content_font_size) || 13)
        ),
      };
      const rows = db
        .prepare(
          `SELECT i.id, i.content, i.link, c.key, c.label, c.bg_color, c.fg_color
           FROM ticker_items i
           JOIN ticker_categories c ON c.id = i.category_id
           WHERE i.is_active = 1
           ORDER BY i.sort_order ASC, i.id ASC`
        )
        .all();
      const items = rows.map((r) => ({
        id: r.id,
        content: r.content,
        link: r.link,
        category: {
          key: r.key,
          label: r.label,
          bg_color: r.bg_color,
          fg_color: r.fg_color,
        },
      }));
      return res.json({
        success: true,
        data: { settings, items },
      });
    } catch (e) {
      console.error('[ticker/public]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** GET /api/ticker/settings */
  router.get('/api/ticker/settings', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const row = loadSettings();
      if (!row) return res.status(500).json({ success: false, message: 'Thiếu cấu hình' });
      return res.json({
        success: true,
        data: {
          id: row.id,
          is_visible: Number(row.is_visible),
          speed: Number(row.speed),
          links_enabled: Number(row.links_enabled),
          hover_pause: Number(row.hover_pause),
          content_font_size: Math.min(FONT_MAX, Math.max(FONT_MIN, Number(row.content_font_size) || 13)),
          updated_at: row.updated_at,
        },
      });
    } catch (e) {
      console.error('[ticker/settings GET]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** PUT /api/ticker/settings */
  router.put('/api/ticker/settings', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const b = req.body || {};
      const updates = [];
      const params = [];

      if (b.is_visible !== undefined) {
        updates.push('is_visible = ?');
        params.push(b.is_visible ? 1 : 0);
      }
      if (b.speed !== undefined) {
        const s = parseInt(b.speed, 10);
        if (!ALLOWED_SPEEDS.has(s)) {
          return res.status(400).json({
            success: false,
            message: 'Tốc độ phải là một trong: 10,20,30,40,50,60,70,80',
          });
        }
        updates.push('speed = ?');
        params.push(s);
      }
      if (b.links_enabled !== undefined) {
        updates.push('links_enabled = ?');
        params.push(b.links_enabled ? 1 : 0);
      }
      if (b.hover_pause !== undefined) {
        updates.push('hover_pause = ?');
        params.push(b.hover_pause ? 1 : 0);
      }
      if (b.content_font_size !== undefined) {
        const fz = parseInt(b.content_font_size, 10);
        if (Number.isNaN(fz) || fz < FONT_MIN || fz > FONT_MAX) {
          return res.status(400).json({
            success: false,
            message: `Cỡ chữ phải từ ${FONT_MIN} đến ${FONT_MAX} (px)`,
          });
        }
        updates.push('content_font_size = ?');
        params.push(fz);
      }
      if (!updates.length) {
        return res.status(400).json({ success: false, message: 'Không có trường hợp lệ để cập nhật' });
      }
      updates.push("updated_at = datetime('now')");
      const sql = `UPDATE ticker_settings SET ${updates.join(', ')} WHERE id = 1`;
      db.prepare(sql).run(...params);
      const row = loadSettings();
      return res.json({
        success: true,
        data: {
          id: row.id,
          is_visible: Number(row.is_visible),
          speed: Number(row.speed),
          links_enabled: Number(row.links_enabled),
          hover_pause: Number(row.hover_pause),
          content_font_size: Math.min(FONT_MAX, Math.max(FONT_MIN, Number(row.content_font_size) || 13)),
          updated_at: row.updated_at,
        },
      });
    } catch (e) {
      console.error('[ticker/settings PUT]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** GET /api/ticker/categories */
  router.get('/api/ticker/categories', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const list = loadCategoriesAll();
      return res.json({ success: true, data: list });
    } catch (e) {
      console.error('[ticker/categories GET]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** POST /api/ticker/categories */
  router.post('/api/ticker/categories', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const b = req.body || {};
      const label = String(b.label || '').trim();
      if (!label) return res.status(400).json({ success: false, message: 'Tên loại là bắt buộc' });
      const bg = validateColor(b.bg_color, 'Màu nền');
      if (!bg.ok) return res.status(400).json({ success: false, message: bg.message });
      const fg = validateColor(b.fg_color, 'Màu chữ');
      if (!fg.ok) return res.status(400).json({ success: false, message: fg.message });

      let key = `${slugifyLabel(label)}_${Date.now()}`;
      const exists = db.prepare('SELECT 1 FROM ticker_categories WHERE key = ?').get(key);
      if (exists) {
        key = `${slugifyLabel(label)}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      }
      const maxSo = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ticker_categories').get();
      const sort_order = (maxSo && maxSo.m != null ? Number(maxSo.m) : 0) + 1;
      const r = db
        .prepare(
          'INSERT INTO ticker_categories (key, label, bg_color, fg_color, sort_order) VALUES (?, ?, ?, ?, ?)'
        )
        .run(key, label, bg.value, fg.value, sort_order);
      const row = db.prepare('SELECT * FROM ticker_categories WHERE id = ?').get(r.lastInsertRowid);
      return res.json({ success: true, data: row });
    } catch (e) {
      console.error('[ticker/categories POST]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** DELETE /api/ticker/categories/:id */
  router.delete('/api/ticker/categories/:id', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
      const cnt = db.prepare('SELECT COUNT(*) AS n FROM ticker_categories').get();
      if (cnt && Number(cnt.n) <= 1) {
        return res.status(400).json({ success: false, message: 'Không thể xóa loại cuối cùng' });
      }
      const r = db.prepare('DELETE FROM ticker_categories WHERE id = ?').run(id);
      if (r.changes === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy loại' });
      return res.json({ success: true, data: { id } });
    } catch (e) {
      console.error('[ticker/categories DELETE]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** GET /api/ticker/items */
  router.get('/api/ticker/items', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const active = req.query.active;
      const activeOnly = active === '1' || active === 'true';
      const list = loadItemsAdmin(activeOnly).map((r) => ({
        id: r.id,
        category_id: r.category_id,
        content: r.content,
        link: r.link,
        is_active: Number(r.is_active),
        sort_order: r.sort_order,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
        category: {
          key: r.cat_key,
          label: r.cat_label,
          bg_color: r.cat_bg,
          fg_color: r.cat_fg,
        },
      }));
      return res.json({ success: true, data: list });
    } catch (e) {
      console.error('[ticker/items GET]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** POST /api/ticker/items */
  router.post('/api/ticker/items', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const b = req.body || {};
      const category_id = parseInt(b.category_id, 10);
      if (!category_id) return res.status(400).json({ success: false, message: 'category_id là bắt buộc' });
      const cv = validateContent(b.content);
      if (!cv.ok) return res.status(400).json({ success: false, message: cv.message });
      const lv = validateLink(b.link);
      if (!lv.ok) return res.status(400).json({ success: false, message: lv.message });
      const cat = db.prepare('SELECT id FROM ticker_categories WHERE id = ?').get(category_id);
      if (!cat) return res.status(400).json({ success: false, message: 'Loại thông báo không tồn tại' });
      const is_active = b.is_active === undefined || b.is_active === null ? 1 : b.is_active ? 1 : 0;
      const uid = req.user && req.user.id != null ? req.user.id : null;
      const ins = db
        .prepare(
          `INSERT INTO ticker_items (category_id, content, link, is_active, created_by)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(category_id, cv.value, lv.value, is_active, uid);
      const row = db
        .prepare(
          `SELECT i.id, i.category_id, i.content, i.link, i.is_active, i.sort_order, i.created_by, i.created_at, i.updated_at,
                  c.key AS cat_key, c.label AS cat_label, c.bg_color AS cat_bg, c.fg_color AS cat_fg
           FROM ticker_items i JOIN ticker_categories c ON c.id = i.category_id WHERE i.id = ?`
        )
        .get(ins.lastInsertRowid);
      const data = {
        id: row.id,
        category_id: row.category_id,
        content: row.content,
        link: row.link,
        is_active: Number(row.is_active),
        sort_order: row.sort_order,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        category: {
          key: row.cat_key,
          label: row.cat_label,
          bg_color: row.cat_bg,
          fg_color: row.cat_fg,
        },
      };
      return res.json({ success: true, data });
    } catch (e) {
      console.error('[ticker/items POST]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** PATCH /api/ticker/items/:id */
  router.patch('/api/ticker/items/:id', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
      const existing = db.prepare('SELECT id FROM ticker_items WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ success: false, message: 'Không tìm thấy tin' });
      const b = req.body || {};
      const sets = [];
      const params = [];
      if (b.content !== undefined) {
        const cv = validateContent(b.content);
        if (!cv.ok) return res.status(400).json({ success: false, message: cv.message });
        sets.push('content = ?');
        params.push(cv.value);
      }
      if (b.link !== undefined) {
        const lv = validateLink(b.link);
        if (!lv.ok) return res.status(400).json({ success: false, message: lv.message });
        sets.push('link = ?');
        params.push(lv.value);
      }
      if (b.is_active !== undefined) {
        sets.push('is_active = ?');
        params.push(b.is_active ? 1 : 0);
      }
      if (b.category_id !== undefined) {
        const cid = parseInt(b.category_id, 10);
        if (!cid) return res.status(400).json({ success: false, message: 'category_id không hợp lệ' });
        const cat = db.prepare('SELECT id FROM ticker_categories WHERE id = ?').get(cid);
        if (!cat) return res.status(400).json({ success: false, message: 'Loại thông báo không tồn tại' });
        sets.push('category_id = ?');
        params.push(cid);
      }
      if (!sets.length) return res.status(400).json({ success: false, message: 'Không có trường để cập nhật' });
      sets.push("updated_at = datetime('now')");
      params.push(id);
      db.prepare(`UPDATE ticker_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const row = db
        .prepare(
          `SELECT i.id, i.category_id, i.content, i.link, i.is_active, i.sort_order, i.created_by, i.created_at, i.updated_at,
                  c.key AS cat_key, c.label AS cat_label, c.bg_color AS cat_bg, c.fg_color AS cat_fg
           FROM ticker_items i JOIN ticker_categories c ON c.id = i.category_id WHERE i.id = ?`
        )
        .get(id);
      const data = {
        id: row.id,
        category_id: row.category_id,
        content: row.content,
        link: row.link,
        is_active: Number(row.is_active),
        sort_order: row.sort_order,
        created_by: row.created_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        category: {
          key: row.cat_key,
          label: row.cat_label,
          bg_color: row.cat_bg,
          fg_color: row.cat_fg,
        },
      };
      return res.json({ success: true, data });
    } catch (e) {
      console.error('[ticker/items PATCH]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** DELETE /api/ticker/items/:id */
  router.delete('/api/ticker/items/:id', authMiddleware, adminTickerOnly, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
      const r = db.prepare('DELETE FROM ticker_items WHERE id = ?').run(id);
      if (r.changes === 0) return res.status(404).json({ success: false, message: 'Không tìm thấy tin' });
      return res.json({ success: true, data: { id } });
    } catch (e) {
      console.error('[ticker/items DELETE]', e);
      return res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
    }
  });

  /** GET /admin/ticker */
  router.get('/admin/ticker', requireAdminHtml, (req, res) => {
    try {
      const settings = loadSettings();
      const categories = loadCategoriesAll();
      const items = loadItemsAdmin(false).map((r) => ({
        id: r.id,
        category_id: r.category_id,
        content: r.content,
        link: r.link,
        is_active: Number(r.is_active),
        sort_order: r.sort_order,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
        category: {
          key: r.cat_key,
          label: r.cat_label,
          bg_color: r.cat_bg,
          fg_color: r.cat_fg,
        },
      }));
      return res.render('admin/ticker', {
        title: 'Ticker Thông Báo',
        user: req.user,
        settings,
        categories,
        items,
      });
    } catch (e) {
      console.error('[admin/ticker render]', e);
      return res.status(500).send('Lỗi máy chủ');
    }
  });

  return router;
};
