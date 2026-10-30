'use strict';

/**
 * Đặt lịch thiết bị CRD — phần dành cho người dùng thường: trạng thái, đặt/sửa/hủy lịch, chat,
 * khiếu nại. 9 endpoint, chỉ cần đăng nhập (tài khoản crd_user cũng dùng được).
 *
 * Tách khỏi server.js (Đợt 2.1 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi. Không sửa một
 * dòng logic nào — chỉ đổi `app.` thành `router.` và bỏ tiền tố `/api` ở 9 dòng khai báo (router được
 * mount ở '/api').
 *
 * Các hàm và hằng CRD dùng chung (crd*, CRD_*) VẪN nằm trong server.js — chúng còn được dùng ở chỗ khác
 * (chỗ khởi tạo bảng, nhóm quản trị CRD chưa tách) — nên được truyền vào qua tham số factory. Riêng
 * `crdBroadcastRateMap` là TRẠNG THÁI TRONG BỘ NHỚ (giới hạn tốc độ kênh chung): phải luôn là MỘT bản
 * duy nhất, nên cũng truyền từ server.js chứ không khai báo lại ở đây.
 *
 * Lưới an toàn: tests/crd.test.js (xem readme/REFACTOR-PROGRESS.md mục "Lưới an toàn theo miền").
 */

const express = require('express');

module.exports = function createCrdNguoiDungRouter({
  authMiddleware,
  crdEnsurePersonForAppUser,
  crdPersonBlockedForUse,
  crdGetStateForUser,
  crdIsHalfHourMark,
  db,
  crdBookingOverlaps,
  crypto,
  crdBookingToClient,
  CRD_BROADCAST_TO_ID,
  crdBroadcastRateMap,
  CRD_BROADCAST_RATE_MS,
  CRD_BROADCAST_RATE_BURST,
  crdSendBroadcastEmailNotification,
  crdChatToClient,
}) {
const router = express.Router();
router.get('/crd/state', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) {
      return res.status(403).json({
        message: 'Hồ sơ CRD chưa có hoặc đã bị gỡ khỏi module. Liên hệ quản trị để được cấp lại quyền.'
      });
    }
    const block = crdPersonBlockedForUse(mePersonId);
    if (block) return res.status(403).json({ message: block });
    return res.json(crdGetStateForUser(req.user, mePersonId));
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi CRD' });
  }
});

router.post('/crd/bookings', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không tạo được hồ sơ người dùng CRD hoặc quyền đã bị gỡ' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const { machineId, date, startH, endH, purpose, researchGroup } = req.body || {};
    const mid = (machineId || '').trim();
    const d = (date || '').trim();
    const sh = Number(startH);
    const eh = Number(endH);
    const pur = (purpose || '').trim();
    const rg = (researchGroup != null ? String(researchGroup) : '').trim();
    if (!mid || !d || !Number.isFinite(sh) || !Number.isFinite(eh)) {
      return res.status(400).json({ message: 'Thiếu thông tin đặt lịch' });
    }
    if (eh <= sh) return res.status(400).json({ message: 'Giờ kết thúc phải sau giờ bắt đầu' });
    if (!crdIsHalfHourMark(sh) || !crdIsHalfHourMark(eh)) {
      return res.status(400).json({ message: 'Giờ đặt phải theo bước 30 phút (VD: 8:00, 8:30)' });
    }
    if (!pur) return res.status(400).json({ message: 'Vui lòng nhập mục đích sử dụng' });
    if (!rg) return res.status(400).json({ message: 'Vui lòng nhập tên nhóm nghiên cứu' });
    const m = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(mid);
    if (!m) return res.status(404).json({ message: 'Không tìm thấy thiết bị' });
    if (sh < m.avail_from || eh > m.avail_to) {
      return res.status(400).json({ message: `Thiết bị chỉ mở đặt lịch ${m.avail_from}:00–${m.avail_to}:00` });
    }
    if (eh - sh > m.max_hours) {
      return res.status(400).json({ message: `Tối đa ${m.max_hours} giờ mỗi lần đặt` });
    }
    if (crdBookingOverlaps(mid, d, sh, eh, null)) {
      return res.status(409).json({ message: 'Khung giờ này đã có người đặt' });
    }
    const id = 'b_' + crypto.randomBytes(6).toString('hex');
    // created_at: không phụ thuộc vào cột này để tránh lỗi migration schema
    // (vẫn có thể hiển thị/track theo created_at nếu cột tồn tại ở DB).
    db.prepare(
      'INSERT INTO crd_bookings (id,machine_id,person_id,date,start_h,end_h,purpose,status,research_group) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(id, mid, mePersonId, d, sh, eh, pur, 'confirmed', rg);
    return res.status(201).json({ booking: crdBookingToClient(db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.delete('/crd/bookings/:id', authMiddleware, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy lịch' });
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!isAdmin) {
      if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người dùng CRD' });
      const blk = crdPersonBlockedForUse(mePersonId);
      if (blk) return res.status(403).json({ message: blk });
    }
    if (!isAdmin && row.person_id !== mePersonId) {
      return res.status(403).json({ message: 'Chỉ huỷ được lịch của chính mình' });
    }
    db.prepare('DELETE FROM crd_bookings WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/bookings/:id', authMiddleware, (req, res) => {
  try {
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy lịch' });
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!isAdmin) {
      if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người dùng CRD' });
      const blk = crdPersonBlockedForUse(mePersonId);
      if (blk) return res.status(403).json({ message: blk });
    }
    if (!isAdmin && row.person_id !== mePersonId) {
      return res.status(403).json({ message: 'Chỉ sửa được lịch của chính mình' });
    }
    const b = req.body || {};
    const startH = b.startH !== undefined ? Number(b.startH) : row.start_h;
    const endH   = b.endH   !== undefined ? Number(b.endH)   : row.end_h;
    const purpose     = b.purpose     !== undefined ? String(b.purpose || '').trim()     : row.purpose || '';
    const researchGroup = b.researchGroup !== undefined ? String(b.researchGroup || '').trim() : (row.research_group != null ? String(row.research_group) : '');
    if (!Number.isFinite(startH) || !Number.isFinite(endH)) {
      return res.status(400).json({ message: 'Giờ không hợp lệ' });
    }
    if (endH <= startH) return res.status(400).json({ message: 'Giờ kết thúc phải sau giờ bắt đầu' });
    if (!crdIsHalfHourMark(startH) || !crdIsHalfHourMark(endH)) {
      return res.status(400).json({ message: 'Giờ phải theo bước 30 phút' });
    }
    if (!researchGroup) return res.status(400).json({ message: 'Vui lòng nhập tên nhóm nghiên cứu' });
    if (!purpose) return res.status(400).json({ message: 'Vui lòng nhập mục đích sử dụng' });
    const m = db.prepare('SELECT * FROM crd_machines WHERE id = ?').get(row.machine_id);
    if (!m) return res.status(400).json({ message: 'Thiết bị không tồn tại' });
    if (endH - startH > m.max_hours) return res.status(400).json({ message: `Tối đa ${m.max_hours} giờ/lần đặt` });
    if (startH < m.avail_from || endH > m.avail_to) {
      return res.status(400).json({ message: `Máy chỉ hoạt động ${m.avail_from}:00–${m.avail_to}:00` });
    }
    if (crdBookingOverlaps(row.machine_id, row.date, startH, endH, id)) {
      return res.status(409).json({ message: 'Trùng lịch với booking khác' });
    }
    db.prepare(
      `UPDATE crd_bookings SET start_h=?, end_h=?, purpose=?, research_group=?, updated_at=datetime('now') WHERE id=?`
    ).run(startH, endH, purpose, researchGroup, id);
    return res.json({ booking: crdBookingToClient(db.prepare('SELECT * FROM crd_bookings WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.post('/crd/chats', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người gửi hoặc quyền CRD đã bị gỡ' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const { toId, bookingId, msg } = req.body || {};
    const to = (toId || '').trim();
    const message = (msg || '').trim();
    if (!to || !message) return res.status(400).json({ message: 'Thiếu nội dung hoặc người nhận' });
    if (message.length > 4000) return res.status(400).json({ message: 'Tin nhắn quá dài (tối đa 4000 ký tự)' });
    if (to === mePersonId) return res.status(400).json({ message: 'Không thể gửi cho chính mình' });
    /* ── Kênh chung: mọi người trong CRD đều đọc được ── */
    if (to === CRD_BROADCAST_TO_ID) {
      /* ── Rate limiting ── */
      const now = Date.now();
      if (!crdBroadcastRateMap.has(mePersonId)) crdBroadcastRateMap.set(mePersonId, []);
      const times = crdBroadcastRateMap.get(mePersonId).filter(t => now - t < CRD_BROADCAST_RATE_MS);
      crdBroadcastRateMap.set(mePersonId, times);
      if (times.length >= CRD_BROADCAST_RATE_BURST) {
        const waitSec = Math.ceil((CRD_BROADCAST_RATE_MS - (now - times[0])) / 1000);
        return res.status(429).json({
          message: `Vui lòng chờ ${waitSec}s trước khi gửi tin tiếp theo trên kênh chung.`,
          retryAfter: waitSec
        });
      }
      crdBroadcastRateMap.get(mePersonId).push(now);

      const bk = bookingId ? (bookingId || '').trim() : null;
      if (bk) {
        const b = db.prepare('SELECT id, person_id FROM crd_bookings WHERE id = ?').get(bk);
        if (!b) return res.status(400).json({ message: 'Booking không tồn tại' });
        if (String(b.person_id) !== String(mePersonId)) {
          return res.status(403).json({ message: 'Chỉ được đính kèm booking của chính mình trên kênh chung' });
        }
      }
      const id = 'c_' + crypto.randomBytes(6).toString('hex');
      const ts = Date.now();
      db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,0)').run(
        id,
        mePersonId,
        CRD_BROADCAST_TO_ID,
        bk,
        message,
        ts
      );
      /* ── Gửi email notification cho người đã bật thông báo (không chờ) ── */
      crdSendBroadcastEmailNotification(mePersonId, message, ts).catch(e =>
        console.error('[CRD broadcast email]:', e.message)
      );
      return res.status(201).json({ chat: crdChatToClient(db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id)) });
    }
    const peer = db.prepare('SELECT id, is_banned, crd_access_revoked FROM crd_persons WHERE id = ?').get(to);
    if (!peer) return res.status(404).json({ message: 'Người nhận không tồn tại' });
    if (Number(peer.crd_access_revoked) === 1) return res.status(400).json({ message: 'Người nhận không còn trong module CRD' });
    if (Number(peer.is_banned) === 1) return res.status(400).json({ message: 'Không thể nhắn tới tài khoản đang bị khoá' });
    const bk = bookingId ? (bookingId || '').trim() : null;
    if (bk) {
      const b = db.prepare('SELECT id FROM crd_bookings WHERE id = ?').get(bk);
      if (!b) return res.status(400).json({ message: 'Booking không tồn tại' });
    }
    const id = 'c_' + crypto.randomBytes(6).toString('hex');
    const ts = Date.now();
    db.prepare('INSERT INTO crd_chats (id,from_id,to_id,booking_id,msg,ts,read_flag) VALUES (?,?,?,?,?,?,0)').run(
      id,
      mePersonId,
      to,
      bk,
      message,
      ts
    );
    return res.status(201).json({ chat: crdChatToClient(db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id)) });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/chats/:id/read', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định người dùng CRD' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const id = (req.params.id || '').trim();
    const row = db.prepare('SELECT * FROM crd_chats WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
    if (row.to_id !== mePersonId) return res.status(403).json({ message: 'Không có quyền' });
    db.prepare('UPDATE crd_chats SET read_flag = 1 WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.put('/crd/chats/mark-thread-read', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định người dùng CRD' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const fromId = ((req.body || {}).fromId || '').trim();
    if (!fromId) return res.status(400).json({ message: 'Thiếu fromId' });
    db.prepare(
      'UPDATE crd_chats SET read_flag = 1 WHERE from_id = ? AND to_id = ? AND read_flag = 0'
    ).run(fromId, mePersonId);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

/** Đánh dấu đã đọc kênh chung (theo mốc thời gian tin mới nhất lúc mở kênh). */
router.put('/crd/chats/broadcast-read', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định người dùng CRD' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const row = db
      .prepare('SELECT MAX(ts) AS m FROM crd_chats WHERE to_id = ?')
      .get(CRD_BROADCAST_TO_ID);
    const ts = row && row.m != null ? Number(row.m) : Date.now();
    db.prepare(
      'INSERT INTO crd_broadcast_read (person_id, last_read_ts) VALUES (?, ?) ON CONFLICT(person_id) DO UPDATE SET last_read_ts = excluded.last_read_ts'
    ).run(mePersonId, ts);
    return res.json({ ok: true, broadcastLastRead: ts });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

router.post('/crd/complaints', authMiddleware, (req, res) => {
  try {
    const mePersonId = crdEnsurePersonForAppUser(req.user);
    if (!mePersonId) return res.status(403).json({ message: 'Không xác định được người gửi hoặc quyền CRD đã bị gỡ' });
    const blk = crdPersonBlockedForUse(mePersonId);
    if (blk) return res.status(403).json({ message: blk });
    const { subject, body, againstId, bookingId } = req.body || {};
    const sub = (subject || '').trim();
    const bod = (body || '').trim();
    if (!sub || !bod) return res.status(400).json({ message: 'Vui lòng nhập tiêu đề và nội dung' });
    const ag = (againstId || '').trim() || null;
    const bk = (bookingId || '').trim() || null;
    const r = db
      .prepare(
        'INSERT INTO crd_complaints (reporter_id, against_id, booking_id, subject, body, status) VALUES (?,?,?,?,?,?)'
      )
      .run(mePersonId, ag, bk, sub, bod, 'open');
    return res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    return res.status(500).json({ message: 'Lỗi' });
  }
});

return router;
};
