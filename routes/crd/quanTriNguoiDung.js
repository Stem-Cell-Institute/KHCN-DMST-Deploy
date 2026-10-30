'use strict';

/**
 * Đặt lịch thiết bị CRD — quản trị người dùng và lịch: hồ sơ CRD (4), tài khoản hệ thống (3), vai trò
 * CRD (3), và lịch đặt (2). 12 endpoint, chỉ Admin hệ thống (adminOnly).
 *
 * Tách khỏi server.js (Đợt 2.3 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi. Không sửa một
 * dòng logic nào — chỉ đổi `app.` thành `router.` và bỏ tiền tố `/api` ở 12 dòng khai báo (router được
 * mount ở '/api'). Đây là PR cuối của Đợt 2: sau đó server.js không còn route /api/crd nào.
 *
 * Hành vi cần giữ (đều có test canh trong tests/crd.test.js):
 *  - Xóa hồ sơ CRD gắn tài khoản (id bắt đầu `u_app_`) KHÔNG xóa hồ sơ mà chỉ GỠ quyền, để hồ sơ không
 *    tự tạo lại khi người đó đăng nhập; hồ sơ tạo tay thì xóa hẳn.
 *  - Vai trò mặc định `user` và `admin` bị bảo vệ: không xóa được, và cờ quản trị bị ép cố định.
 *  - Đặt lại mật khẩu băm bằng bcrypt và cắt khoảng trắng đầu/cuối.
 *
 * Các hàm CRD dùng chung (crd*) VẪN nằm trong server.js và được truyền qua tham số factory.
 *
 * Lưới an toàn: tests/crd.test.js.
 */

const express = require('express');

module.exports = function createCrdQuanTriNguoiDungRouter({
  authMiddleware,
  adminOnly,
  crypto,
  crdRoleSlugValid,
  db,
  crdPersonToUser,
  bcrypt,
  crdRoleDefsToClient,
  crdIsHalfHourMark,
  crdBookingOverlaps,
  crdBookingToClient,
}) {
const router = express.Router();
router.post('/crd/admin/persons', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Tên bắt buộc' });
    const id = (b.id && String(b.id).trim()) || 'u_' + crypto.randomBytes(5).toString('hex');
    const email = (b.email || '').trim().toLowerCase() || null;
    const roleRaw = String(b.role || 'user')
      .trim()
      .toLowerCase();
    if (!crdRoleSlugValid(roleRaw)) return res.status(400).json({ message: 'Vai trò không hợp lệ (chưa có trong danh sách vai trò CRD)' });
    const role = roleRaw;
    const avatar = (b.avatar || name[0] || '?').toString().slice(0, 2).toUpperCase();
    db.prepare('INSERT INTO crd_persons (id,name,email,role,avatar) VALUES (?,?,?,?,?)').run(id, name, email, role, avatar);
    return res.status(201).json({ user: crdPersonToUser(db.prepare('SELECT * FROM crd_persons WHERE id = ?').get(id)) });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ message: 'ID đã tồn tại' });
    }
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/admin/persons/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_persons WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name).trim() : row.name;
    const email = b.email !== undefined ? String(b.email).trim().toLowerCase() : row.email;
    let role = row.role;
    if (b.role !== undefined) {
      const roleRaw = String(b.role).trim().toLowerCase();
      if (!crdRoleSlugValid(roleRaw)) return res.status(400).json({ message: 'Vai trò không hợp lệ' });
      role = roleRaw;
    }
    const avatar = b.avatar !== undefined ? String(b.avatar).trim().slice(0, 2) : row.avatar;
    let isBanned = Number(row.is_banned) === 1 ? 1 : 0;
    if (b.isBanned !== undefined) isBanned = b.isBanned ? 1 : 0;
    let crdAccessRevoked = Number(row.crd_access_revoked) === 1 ? 1 : 0;
    if (b.crdAccessRevoked !== undefined) crdAccessRevoked = b.crdAccessRevoked ? 1 : 0;
    if (!name) return res.status(400).json({ message: 'Tên không được để trống' });
    db.prepare(
      `UPDATE crd_persons SET name=?, email=?, role=?, avatar=?, is_banned=?, crd_access_revoked=?, updated_at=datetime('now') WHERE id=?`
    ).run(name, email || null, role, avatar || '?', isBanned, crdAccessRevoked, id);
    return res.json({ user: crdPersonToUser(db.prepare('SELECT * FROM crd_persons WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.delete('/crd/admin/persons/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT id FROM crd_persons WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    db.prepare('DELETE FROM crd_bookings WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM crd_chats WHERE from_id = ? OR to_id = ?').run(id, id);
    if (String(id).startsWith('u_app_')) {
      db.prepare('UPDATE crd_persons SET crd_access_revoked=1, is_banned=0, updated_at=datetime(\'now\') WHERE id=?').run(id);
      return res.json({ ok: true, revoked: true, message: 'Đã gỡ quyền CRD (hồ sơ giữ lại để không tự tạo lại khi đăng nhập)' });
    }
    db.prepare('DELETE FROM crd_persons WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.get('/crd/admin/persons/:id/stats', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT id FROM crd_persons WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy người dùng CRD' });
    const statusCond = `COALESCE(NULLIF(TRIM(status), ''), 'confirmed') != 'cancelled'`;
    const total = db
      .prepare(
        `SELECT COUNT(*) AS c, COALESCE(SUM(end_h - start_h), 0) AS h FROM crd_bookings WHERE person_id = ? AND ${statusCond}`
      )
      .get(id);
    const byM = db
      .prepare(
        `SELECT machine_id, COUNT(*) AS c, COALESCE(SUM(end_h - start_h), 0) AS h
         FROM crd_bookings WHERE person_id = ? AND ${statusCond} GROUP BY machine_id ORDER BY h DESC`
      )
      .all(id);
    const machines = db.prepare('SELECT id, name FROM crd_machines').all();
    const nameById = {};
    for (const m of machines) nameById[m.id] = m.name || m.id;
    const byMachine = (byM || []).map((r) => ({
      machineId: r.machine_id,
      machineName: nameById[r.machine_id] || r.machine_id,
      bookings: r.c,
      hours: Math.round(Number(r.h) * 100) / 100
    }));
    const totalHours = Math.round(Number(total.h) * 100) / 100;
    return res.json({
      personId: id,
      totalBookings: total.c,
      totalHours,
      byMachine
    });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

/* ── Toàn bộ tài khoản users kèm trạng thái CRD ─────────────────────────── */
router.get('/crd/admin/users', authMiddleware, adminOnly, (req, res) => {
  try {
    const sysUsers = db.prepare('SELECT * FROM users ORDER BY createdAt DESC').all();
    // Map userId → crd_persons
    const crdByUserId = {};
    db.prepare('SELECT * FROM crd_persons').all().forEach(p => {
      if (p.user_id) crdByUserId[p.user_id] = p;
    });
    const result = sysUsers.map(u => {
      const crd = crdByUserId[u.id] || null;
      return {
        // Thông tin hệ thống
        id: u.id,
        email: u.email,
        fullname: u.fullname || '',
        role: u.role || 'researcher',
        createdAt: u.created_at,
        isDisabled: Number(u.is_disabled || 0) === 1,
        // Thông tin CRD (null = chưa vào module)
        crd: crd ? {
          personId: crd.id,
          personName: crd.name,
          personRole: crd.role || 'user',
          personAvatar: crd.avatar || '?',
          isBanned: Number(crd.is_banned) === 1,
          crdAccessRevoked: Number(crd.crd_access_revoked) === 1,
          syncedFromApp: String(crd.id).startsWith('u_app_'),
          isInVien: !!(u.email || '').toLowerCase().endsWith('@sci.edu.vn'),
        } : null,
      };
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/admin/users/:id/disable', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || !Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const newVal = Number(row.is_disabled || 0) === 1 ? 0 : 1;
    db.prepare('UPDATE users SET is_disabled = ? WHERE id = ?').run(newVal, id);
    return res.json({ ok: true, isDisabled: newVal === 1, message: newVal ? 'Đã vô hiệu hoá tài khoản' : 'Đã kích hoạt lại tài khoản' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.post('/crd/admin/users/:id/reset-password', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || !Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy tài khoản' });
    const newPass = String(req.body.password || '').trim();
    if (!newPass || newPass.length < 6) return res.status(400).json({ message: 'Mật khẩu mới ít nhất 6 ký tự' });
    if (newPass.length > 128) return res.status(400).json({ message: 'Mật khẩu quá dài (tối đa 128 ký tự)' });
    const hash = bcrypt.hashSync(newPass, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
    return res.json({ ok: true, message: 'Đã đặt lại mật khẩu thành công' });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.post('/crd/admin/role-defs', authMiddleware, adminOnly, (req, res) => {
  try {
    const b = req.body || {};
    const slug = String(b.slug || '')
      .trim()
      .toLowerCase();
    const label = String(b.label || '').trim();
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(slug)) {
      return res.status(400).json({ message: 'Mã vai trò: chữ thường, số, gạch dưới; bắt đầu bằng chữ cái' });
    }
    if (!label) return res.status(400).json({ message: 'Nhập tên hiển thị' });
    const exists = db.prepare('SELECT 1 FROM crd_role_defs WHERE slug = ?').get(slug);
    if (exists) return res.status(409).json({ message: 'Mã vai trò đã tồn tại' });
    const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 999;
    const isAdm = b.isAdminSlot ? 1 : 0;
    if (slug === 'user' && isAdm) return res.status(400).json({ message: 'Vai trò user không thể đánh dấu quản trị' });
    db.prepare('INSERT INTO crd_role_defs (slug, label, sort_order, is_admin_slot) VALUES (?,?,?,?)').run(
      slug,
      label,
      sortOrder,
      isAdm
    );
    return res.status(201).json({ crdRoles: crdRoleDefsToClient() });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/admin/role-defs/:slug', authMiddleware, adminOnly, (req, res) => {
  try {
    const slug = String(req.params.slug || '')
      .trim()
      .toLowerCase();
    const row = db.prepare('SELECT * FROM crd_role_defs WHERE slug = ?').get(slug);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy vai trò' });
    const b = req.body || {};
    const label = b.label !== undefined ? String(b.label).trim() : row.label;
    let sortOrder = b.sortOrder !== undefined ? Number(b.sortOrder) : row.sort_order;
    if (!Number.isFinite(sortOrder)) sortOrder = row.sort_order;
    let isAdm = b.isAdminSlot !== undefined ? (b.isAdminSlot ? 1 : 0) : row.is_admin_slot;
    if (slug === 'user') isAdm = 0;
    if (slug === 'admin') isAdm = 1;
    if (!label) return res.status(400).json({ message: 'Tên hiển thị không được trống' });
    db.prepare('UPDATE crd_role_defs SET label=?, sort_order=?, is_admin_slot=? WHERE slug=?').run(label, sortOrder, isAdm, slug);
    return res.json({ crdRoles: crdRoleDefsToClient() });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.delete('/crd/admin/role-defs/:slug', authMiddleware, adminOnly, (req, res) => {
  try {
    const slug = String(req.params.slug || '')
      .trim()
      .toLowerCase();
    if (slug === 'user' || slug === 'admin') {
      return res.status(400).json({ message: 'Không xóa được vai trò mặc định user / admin' });
    }
    const row = db.prepare('SELECT 1 FROM crd_role_defs WHERE slug = ?').get(slug);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const n = db.prepare('SELECT COUNT(*) AS c FROM crd_persons WHERE role = ?').get(slug);
    if (n && n.c > 0) return res.status(400).json({ message: 'Còn người dùng đang gán vai trò này — đổi vai trò họ trước khi xóa' });
    db.prepare('DELETE FROM crd_role_defs WHERE slug = ?').run(slug);
    return res.json({ crdRoles: crdRoleDefsToClient() });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/admin/bookings/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const machineId = b.machineId !== undefined ? String(b.machineId).trim() : row.machine_id;
    const personId = b.userId !== undefined ? String(b.userId).trim() : row.person_id;
    const date = b.date !== undefined ? String(b.date).trim() : row.date;
    const startH = b.startH !== undefined ? Number(b.startH) : row.start_h;
    const endH = b.endH !== undefined ? Number(b.endH) : row.end_h;
    const purpose = b.purpose !== undefined ? String(b.purpose) : row.purpose;
    const researchGroup =
      b.researchGroup !== undefined ? String(b.researchGroup || '').trim() : row.research_group != null ? String(row.research_group) : '';
    const status = b.status !== undefined ? String(b.status) : row.status;
    const m = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(machineId);
    if (!m) return res.status(400).json({ message: 'Thiết bị không tồn tại' });
    const p = db.prepare('SELECT id FROM crd_persons WHERE id = ?').get(personId);
    if (!p) return res.status(400).json({ message: 'Người dùng CRD không tồn tại' });
    if (endH <= startH) return res.status(400).json({ message: 'Giờ kết thúc phải sau giờ bắt đầu' });
    if (!crdIsHalfHourMark(startH) || !crdIsHalfHourMark(endH)) {
      return res.status(400).json({ message: 'Giờ đặt phải theo bước 30 phút (VD: 8:00, 8:30)' });
    }
    if (startH < m.avail_from || endH > m.avail_to) {
      return res.status(400).json({ message: 'Ngoài khung giờ mở của thiết bị' });
    }
    if (endH - startH > m.max_hours) {
      return res.status(400).json({ message: `Vượt tối đa ${m.max_hours} giờ` });
    }
    if (crdBookingOverlaps(machineId, date, startH, endH, id)) {
      return res.status(409).json({ message: 'Trùng lịch với booking khác' });
    }
    db.prepare(
      `UPDATE crd_bookings SET machine_id=?, person_id=?, date=?, start_h=?, end_h=?, purpose=?, research_group=?, status=?, updated_at=datetime('now') WHERE id=?`
    ).run(machineId, personId, date, startH, endH, purpose || '', researchGroup || '', status || 'confirmed', id);
    return res.json({ booking: crdBookingToClient(db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.delete('/crd/admin/bookings/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const r = db.prepare('DELETE FROM crd_bookings WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

return router;
};
