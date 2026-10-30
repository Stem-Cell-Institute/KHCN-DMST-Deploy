'use strict';

/**
 * Đặt lịch thiết bị CRD — quản trị: ảnh chụp toàn bộ trạng thái (snapshot), thông báo của phòng lab,
 * và thiết bị. 9 endpoint, chỉ Admin hệ thống (adminOnly).
 *
 * Tách khỏi server.js (Đợt 2.2 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi. Không sửa một
 * dòng logic nào — chỉ đổi `app.` thành `router.` và bỏ tiền tố `/api` ở 9 dòng khai báo (router được
 * mount ở '/api').
 *
 * ⚠️ THỨ TỰ TRONG FILE NÀY CÓ Ý NGHĨA: `PUT /crd/admin/machines/reorder` phải đứng TRƯỚC
 * `PUT /crd/admin/machines/:id`, nếu không `:id` sẽ nuốt chữ "reorder". Đã có test canh
 * (tests/crd.test.js, "sắp xếp lại") và đã kiểm bằng đột biến đảo thứ tự. Đừng sắp xếp lại các handler.
 *
 * Các hàm CRD dùng chung (crd*) VẪN nằm trong server.js và được truyền qua tham số factory.
 *
 * Lưới an toàn: tests/crd.test.js.
 */

const express = require('express');

module.exports = function createCrdQuanTriThietBiRouter({
  authMiddleware,
  adminOnly,
  crdGetStateForUser,
  db,
  crdLabAnnouncementsAll,
  crypto,
  crdAnnouncementToClient,
  crdLabAnnouncementsActive,
  crdMachineToClient,
}) {
const router = express.Router();
router.get('/crd/admin/snapshot', authMiddleware, adminOnly, (req, res) => {
  try {
    const base = crdGetStateForUser(req.user);
    const complaints = db
      .prepare('SELECT * FROM crd_complaints ORDER BY id DESC')
      .all()
      .map(c => ({
        id: c.id,
        reporterId: c.reporter_id,
        againstId: c.against_id || null,
        bookingId: c.booking_id || null,
        subject: c.subject,
        body: c.body,
        status: c.status,
        adminNote: c.admin_note || '',
        createdAt: c.created_at
      }));
    return res.json({ ...base, complaints });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.get('/crd/admin/lab-announcements', authMiddleware, adminOnly, (req, res) => {
  try {
    return res.json({ announcements: crdLabAnnouncementsAll() });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.post('/crd/admin/lab-announcements', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const title = (b.title != null ? String(b.title) : '').trim();
    const bodyText = (b.body != null ? String(b.body) : '').trim();
    if (!title && !bodyText) {
      return res.status(400).json({ message: 'Vui lòng nhập tiêu đề hoặc nội dung thông báo' });
    }
    let sortOrder = b.sortOrder !== undefined ? Number(b.sortOrder) : 0;
    if (!Number.isFinite(sortOrder)) sortOrder = 0;
    const isActive = b.isActive === false || b.isActive === 0 ? 0 : 1;
    const id = 'la_' + crypto.randomBytes(6).toString('hex');
    db.prepare(
      `INSERT INTO crd_lab_announcements (id, title, body, sort_order, is_active, updated_at)
       VALUES (?,?,?,?,?, datetime('now','localtime'))`
    ).run(id, title, bodyText, sortOrder, isActive);
    const row = db.prepare('SELECT * FROM crd_lab_announcements WHERE id = ?').get(id);
    return res.status(201).json({
      announcement: crdAnnouncementToClient(row),
      labAnnouncements: crdLabAnnouncementsActive()
    });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/admin/lab-announcements/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_lab_announcements WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy thông báo' });
    const b = req.body || {};
    const title = b.title !== undefined ? String(b.title).trim() : row.title || '';
    const bodyText = b.body !== undefined ? String(b.body) : row.body || '';
    let sortOrder = b.sortOrder !== undefined ? Number(b.sortOrder) : row.sort_order;
    let isActive =
      b.isActive !== undefined ? (b.isActive === false || b.isActive === 0 ? 0 : 1) : row.is_active;
    if (!Number.isFinite(sortOrder)) sortOrder = 0;
    if (!title.trim() && !String(bodyText || '').trim()) {
      return res.status(400).json({ message: 'Tiêu đề và nội dung không được để trống cùng lúc' });
    }
    db.prepare(
      `UPDATE crd_lab_announcements SET title=?, body=?, sort_order=?, is_active=?,
       updated_at=datetime('now','localtime') WHERE id=?`
    ).run(title, bodyText, sortOrder, isActive, id);
    return res.json({
      announcement: crdAnnouncementToClient(db.prepare('SELECT * FROM crd_lab_announcements WHERE id = ?').get(id)),
      labAnnouncements: crdLabAnnouncementsActive()
    });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.delete('/crd/admin/lab-announcements/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const r = db.prepare('DELETE FROM crd_lab_announcements WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy thông báo' });
    return res.json({ ok: true, labAnnouncements: crdLabAnnouncementsActive() });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.post('/crd/admin/machines', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Tên thiết bị bắt buộc' });
    const id = (b.id && String(b.id).trim()) || 'm_' + crypto.randomBytes(5).toString('hex');
    const type = (b.type || '').trim() || '';
    const location = (b.location || '').trim() || '';
    const color = (b.color || '#667eea').trim();
    const availFrom = Math.max(0, Math.min(23, Number(b.availFrom) || 8));
    const availTo = Math.max(1, Math.min(24, Number(b.availTo) || 20));
    const maxHours = Math.max(1, Math.min(24, Number(b.maxHours) || 4));
    const description = (b.desc || b.description || '').trim();
    const sort_order = Number(b.sort_order) || 0;
    if (availTo <= availFrom) return res.status(400).json({ message: 'availTo phải lớn hơn availFrom' });
    db.prepare(
      `INSERT INTO crd_machines (id,name,type,location,color,avail_from,avail_to,max_hours,description,sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(id, name, type, location, color, availFrom, availTo, maxHours, description, sort_order);
    return res.status(201).json({ machine: crdMachineToClient(db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(id)) });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ message: 'ID thiết bị đã tồn tại' });
    }
    return res.status(500).json({ message: 'Lỗi' });
  }
});

/** Body: { orderedIds: string[] } — đủ mọi id thiết bị, đúng thứ tự hiển thị */
router.put('/crd/admin/machines/reorder', authMiddleware, adminOnly, (req, res) => {
  try {
    const raw = req.body && req.body.orderedIds;
    if (!Array.isArray(raw) || !raw.length) {
      return res.status(400).json({ message: 'orderedIds phải là mảng id thiết bị' });
    }
    const orderedIds = raw.map((x) => String(x || '').trim()).filter(Boolean);
    const uniq = new Set(orderedIds);
    if (uniq.size !== orderedIds.length) {
      return res.status(400).json({ message: 'Trùng ID trong orderedIds' });
    }
    const existing = db.prepare('SELECT id FROM crd_machines').all().map((r) => r.id);
    if (orderedIds.length !== existing.length) {
      return res.status(400).json({ message: 'Số thiết bị không khớp với máy chủ' });
    }
    const es = new Set(existing);
    for (const id of orderedIds) {
      if (!es.has(id)) return res.status(400).json({ message: 'Có ID không tồn tại trong orderedIds' });
    }

    const upd = db.prepare(
      "UPDATE crd_machines SET sort_order = ?, updated_at = datetime('now') WHERE id = ?"
    );
    const tx = db.transaction(() => {
      orderedIds.forEach((id, i) => upd.run(i, id));
    });
    tx();
    const machines = db
      .prepare('SELECT * FROM crd_machines ORDER BY sort_order ASC, name ASC')
      .all()
      .map(crdMachineToClient);
    return res.json({ machines });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/admin/machines/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const name = (b.name !== undefined ? String(b.name) : row.name).trim();
    if (!name) return res.status(400).json({ message: 'Tên thiết bị bắt buộc' });
    const type = b.type !== undefined ? String(b.type) : row.type;
    const location = b.location !== undefined ? String(b.location) : row.location;
    const color = b.color !== undefined ? String(b.color) : row.color;
    let availFrom = b.availFrom !== undefined ? Number(b.availFrom) : row.avail_from;
    let availTo = b.availTo !== undefined ? Number(b.availTo) : row.avail_to;
    let maxHours = b.maxHours !== undefined ? Number(b.maxHours) : row.max_hours;
    const description = b.desc !== undefined ? String(b.desc) : b.description !== undefined ? String(b.description) : row.description;
    let sortOrder = b.sort_order !== undefined ? Number(b.sort_order) : row.sort_order;
    if (!Number.isFinite(sortOrder)) sortOrder = 0;
    availFrom = Math.max(0, Math.min(23, availFrom));
    availTo = Math.max(1, Math.min(24, availTo));
    maxHours = Math.max(1, Math.min(24, maxHours));
    if (availTo <= availFrom) return res.status(400).json({ message: 'availTo phải lớn hơn availFrom' });
    db.prepare(
      `UPDATE crd_machines SET name=?, type=?, location=?, color=?, avail_from=?, avail_to=?, max_hours=?, description=?, sort_order=?, updated_at=datetime('now') WHERE id=?`
    ).run(name, type, location, color, availFrom, availTo, maxHours, description || '', sortOrder, id);
    return res.json({ machine: crdMachineToClient(db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.delete('/crd/admin/machines/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT id FROM crd_machines WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    db.prepare('DELETE FROM crd_bookings WHERE machine_id = ?').run(id);
    db.prepare('DELETE FROM crd_machines WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

return router;
};
