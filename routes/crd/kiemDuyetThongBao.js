'use strict';

/**
 * Đặt lịch thiết bị CRD — kiểm duyệt tin nhắn, thông báo email của chính mình, và xử lý khiếu nại.
 * 5 endpoint.
 *
 * Tách khỏi server.js (Đợt 2.2 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi. Không sửa một
 * dòng logic nào — chỉ đổi `app.` thành `router.` và bỏ tiền tố `/api` ở 5 dòng khai báo (router được
 * mount ở '/api'). Hàm phụ `crdEmailNotifUserId` đi cùng vì chỉ hai route email-notif dùng nó.
 *
 * ⚠️ `DELETE /crd/admin/chats/:id` có đường dẫn `admin` nhưng KHÔNG qua `adminOnly`: việc kiểm quyền
 * nằm TRONG handler (Admin hệ thống; hoặc người có vai trò CRD gắn cờ quản trị, với tin kênh chung).
 * Đừng thay bằng middleware `adminOnly` — sẽ chặn nhầm người kiểm duyệt CRD. Đã có test canh.
 *
 * Các hàm CRD dùng chung (crd*) VẪN nằm trong server.js và được truyền qua tham số factory.
 *
 * Lưới an toàn: tests/crd.test.js.
 */

const express = require('express');

module.exports = function createCrdKiemDuyetThongBaoRouter({
  authMiddleware,
  db,
  crdEnsurePersonForAppUser,
  CRD_BROADCAST_TO_ID,
  crdPersonHasModeratorSlot,
  adminOnly,
}) {
const router = express.Router();
router.delete('/crd/admin/chats/:id', authMiddleware, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const isSysAdmin = (req.user.role || '').toLowerCase() === 'admin';
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    const isBroadcast = row.to_id === CRD_BROADCAST_TO_ID;
    if (isBroadcast) {
      if (!isSysAdmin && !crdPersonHasModeratorSlot(mePersonId)) {
        return res.status(403).json({
          message: 'Chỉ quản trị hệ thống hoặc tài khoản có vai trò Admin CRD mới xóa được tin kênh chung.'
        });
      }
    } else if (!isSysAdmin) {
      return res.status(403).json({ message: 'Chỉ quản trị hệ thống mới xóa được tin nhắn riêng.' });
    }
    db.prepare('UPDATE crd_chats SET is_deleted = 1 WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

/**
 * Cài đặt email CRD (bảng users) gắn với tài khoản đăng nhập JWT — không phụ thuộc cột crd_persons.user_id.
 * (Cột user_id trên hồ sơ CRD chỉ là bản sao; trước đây thiếu cột dễ gây hiểu nhầm "Không liên kết tài khoản"
 * dù đã đăng nhập.)
 */
function crdEmailNotifUserId(req) {
  const mePersonId = crdEnsurePersonForAppUser(req.user);
  if (!mePersonId) return { error: 'Không xác định người dùng CRD' };
  const uid = Number(req.user && req.user.id);
  if (!Number.isFinite(uid)) return { error: 'Không xác định tài khoản đăng nhập' };
  try {
    db.prepare('UPDATE crd_persons SET user_id = ? WHERE id = ? AND (user_id IS NULL OR user_id = ?)').run(
      uid,
      mePersonId,
      uid
    );
  } catch (_) {
    /* ignore nếu DB cũ */
  }
  return { uid };
}

/** Toggle thông báo email CRD cho chính mình */
router.put('/crd/email-notif', authMiddleware, (req, res) => {
  try {
    const r = crdEmailNotifUserId(req);
    if (r.error) return res.status(403).json({ message: r.error });
    const val = req.body && req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : 1;
    db.prepare('UPDATE users SET crd_email_notif = ? WHERE id = ?').run(val, r.uid);
    return res.json({ ok: true, enabled: val === 1 });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

/** Lấy trạng thái thông báo email CRD của chính mình */
router.get('/crd/email-notif', authMiddleware, (req, res) => {
  try {
    const r = crdEmailNotifUserId(req);
    if (r.error) return res.status(403).json({ message: r.error });
    const row = db.prepare('SELECT crd_email_notif FROM users WHERE id = ?').get(r.uid);
    return res.json({ enabled: row && Number(row.crd_email_notif) === 1 });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/admin/complaints/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const row = db.prepare('SELECT * FROM crd_complaints WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    const b = req.body || {};
    const status = (b.status || row.status || 'open').trim();
    const adminNote = b.adminNote !== undefined ? String(b.adminNote) : row.admin_note;
    const allowed = ['open', 'in_review', 'resolved', 'rejected'];
    if (!allowed.includes(status)) return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
    db.prepare('UPDATE crd_complaints SET status=?, admin_note=? WHERE id=?').run(status, adminNote || '', id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.delete('/crd/admin/complaints/:id', authMiddleware, adminOnly, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
    const r = db.prepare('DELETE FROM crd_complaints WHERE id = ?').run(id);
    if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

return router;
};
