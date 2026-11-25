'use strict';

/**
 * Đề tài cấp Viện — Bước 9 (hoá chất, vật tư) & Bước 11 (đề xuất điều chỉnh) (2 endpoint).
 *
 *   POST /api/cap-vien/submissions/:id/step9-supply/action
 *   POST /api/cap-vien/submissions/:id/step11-adjustment/action
 *
 * Tách khỏi server.js (Đợt 4.7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');

module.exports = function createCapVienVatTuVaDieuChinhRouter({
  db,
  authMiddleware,
  roleIsAny,
  capVienStep6HistoryRoleDb,
  insertCapVienHistory,
}) {
const router = express.Router();

// Bước 9 — Hoá chất, vật tư: danh mục dự toán (Chủ nhiệm/Admin khai báo, Admin/Phòng KHCN khoá lại làm
// số liệu chính thức) + cấp phát theo đợt (Chủ nhiệm/Admin đề nghị, Admin/Phòng KHCN xác nhận/từ chối,
// không cho vượt approvedQty). Route riêng (không dùng chung dispatcher steps/:step ở trên) vì action
// lock_catalog/confirm_issuance/reject_issuance cần thêm vai trò Phòng KHCN, khác gate owner||admin của
// milestone.
router.post('/cap-vien/submissions/:id/step9-supply/action', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, submittedById, budget_4a_status, step9_supply_locked_at FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  const isPhongKhcnOrAdmin = roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky']);
  const ownerHistoryRole = isOwner ? 'researcher' : 'admin';
  const staffHistoryRole = capVienStep6HistoryRoleDb(req.user.role);
  const body = req.body || {};
  const payload = body.payload || {};
  const actionRaw = body.action || payload.action || '';
  const action = String(actionRaw).toLowerCase().trim();
  const nowIso = new Date().toISOString();
  const locked = !!sub.step9_supply_locked_at;

  function getItem(itemId) {
    return db.prepare('SELECT * FROM cap_vien_step9_supply_item WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(itemId, id);
  }
  function confirmedQtyForItem(itemId) {
    const r = db.prepare("SELECT COALESCE(SUM(qty), 0) AS s FROM cap_vien_step9_supply_issuance WHERE itemId = ? AND status = 'confirmed'").get(itemId);
    return r.s || 0;
  }

  if (action === 'add_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được khai báo hoá chất/vật tư.' });
    if (locked) return res.status(400).json({ message: 'Danh mục đã khoá, không thể thêm mục mới.' });
    const name = String(payload.name || '').trim();
    if (!name) return res.status(400).json({ message: 'Vui lòng nhập tên hoá chất/vật tư' });
    const unit = payload.unit ? String(payload.unit).trim() : null;
    const approvedQty = Number(payload.approvedQty);
    if (!isFinite(approvedQty) || approvedQty < 0) return res.status(400).json({ message: 'Số lượng duyệt không hợp lệ' });
    const approvedAmount = (payload.approvedAmount !== undefined && payload.approvedAmount !== null && payload.approvedAmount !== '') ? Number(payload.approvedAmount) : null;
    const note = payload.note ? String(payload.note).trim() : null;
    const ins = db.prepare(
      'INSERT INTO cap_vien_step9_supply_item (submissionId, name, unit, approvedQty, approvedAmount, note, createdAt, createdById) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, name, unit, approvedQty, approvedAmount, note, nowIso, req.user.id);
    insertCapVienHistory(id, '9', 'supply_add_item', req.user.id, ownerHistoryRole, 'Thêm hoá chất/vật tư: ' + name);
    return res.json({ message: 'Đã thêm hoá chất/vật tư.', itemId: ins.lastInsertRowid });
  }

  if (action === 'update_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được sửa hoá chất/vật tư.' });
    if (locked) return res.status(400).json({ message: 'Danh mục đã khoá, không thể sửa.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'Thiếu itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy mục' });
    const updates = [];
    const params = [];
    if (payload.name !== undefined) {
      const n = String(payload.name || '').trim();
      if (!n) return res.status(400).json({ message: 'Tên không được để trống' });
      updates.push('name = ?'); params.push(n);
    }
    if (payload.unit !== undefined) { updates.push('unit = ?'); params.push(payload.unit ? String(payload.unit).trim() : null); }
    if (payload.approvedQty !== undefined) {
      const q = Number(payload.approvedQty);
      if (!isFinite(q) || q < 0) return res.status(400).json({ message: 'Số lượng duyệt không hợp lệ' });
      updates.push('approvedQty = ?'); params.push(q);
    }
    if (payload.approvedAmount !== undefined) {
      const a = (payload.approvedAmount !== null && payload.approvedAmount !== '') ? Number(payload.approvedAmount) : null;
      updates.push('approvedAmount = ?'); params.push(a);
    }
    if (payload.note !== undefined) { updates.push('note = ?'); params.push(payload.note ? String(payload.note).trim() : null); }
    if (!updates.length) return res.status(400).json({ message: 'Không có trường nào để cập nhật' });
    updates.push('updatedAt = ?', 'updatedById = ?');
    params.push(nowIso, req.user.id, itemId);
    db.prepare('UPDATE cap_vien_step9_supply_item SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    return res.json({ message: 'Đã cập nhật.' });
  }

  if (action === 'delete_item') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được xóa hoá chất/vật tư.' });
    if (locked) return res.status(400).json({ message: 'Danh mục đã khoá, không thể xóa.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'Thiếu itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy mục' });
    db.prepare('UPDATE cap_vien_step9_supply_item SET deletedAt = ? WHERE id = ?').run(nowIso, itemId);
    return res.json({ message: 'Đã xóa.' });
  }

  if (action === 'lock_catalog') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được khoá danh mục.' });
    if (locked) return res.status(400).json({ message: 'Danh mục đã được khoá trước đó.' });
    if (String(sub.budget_4a_status || '').toLowerCase() !== 'approved') {
      return res.status(400).json({ message: 'Chỉ khoá được khi Bước 4A (Thẩm định dự toán) đã được duyệt.' });
    }
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM cap_vien_step9_supply_item WHERE submissionId = ? AND deletedAt IS NULL').get(id);
    if (!cnt.c) return res.status(400).json({ message: 'Danh mục đang trống, chưa có mục nào để khoá.' });
    db.prepare('UPDATE cap_vien_submissions SET step9_supply_locked_at = ?, step9_supply_locked_by = ? WHERE id = ?').run(nowIso, req.user.id, id);
    insertCapVienHistory(id, '9', 'supply_lock_catalog', req.user.id, staffHistoryRole, 'Khoá danh mục hoá chất/vật tư (' + cnt.c + ' mục)');
    return res.json({ message: 'Đã khoá danh mục hoá chất/vật tư.' });
  }

  if (action === 'unlock_catalog') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được mở khoá danh mục.' });
    if (!locked) return res.status(400).json({ message: 'Danh mục chưa khoá.' });
    db.prepare('UPDATE cap_vien_submissions SET step9_supply_locked_at = NULL, step9_supply_locked_by = NULL WHERE id = ?').run(id);
    insertCapVienHistory(id, '9', 'supply_unlock_catalog', req.user.id, staffHistoryRole, 'Mở khoá danh mục hoá chất/vật tư để Chủ nhiệm cập nhật lại');
    return res.json({ message: 'Đã mở khoá danh mục hoá chất/vật tư.' });
  }

  if (action === 'request_issuance') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được đề nghị cấp phát.' });
    if (!locked) return res.status(400).json({ message: 'Danh mục chưa khoá, chưa thể đề nghị cấp phát.' });
    const itemId = parseInt(payload.itemId, 10);
    if (!itemId) return res.status(400).json({ message: 'Thiếu itemId' });
    const item = getItem(itemId);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy mục' });
    const qty = Number(payload.qty);
    if (!isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'Số lượng đề nghị không hợp lệ' });
    const already = confirmedQtyForItem(itemId);
    if (already + qty > item.approvedQty + 1e-9) {
      return res.status(400).json({ message: 'Vượt quá số lượng đã duyệt (còn lại ' + (item.approvedQty - already) + ' ' + (item.unit || '') + ').' });
    }
    const issuedDate = payload.issuedDate ? String(payload.issuedDate).trim() : null;
    const note = payload.note ? String(payload.note).trim() : null;
    const ins = db.prepare(
      'INSERT INTO cap_vien_step9_supply_issuance (itemId, submissionId, qty, issuedDate, note, status, requestedById, requestedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(itemId, id, qty, issuedDate, note, 'requested', req.user.id, nowIso);
    insertCapVienHistory(id, '9', 'supply_request_issuance', req.user.id, ownerHistoryRole, 'Đề nghị cấp ' + qty + ' ' + (item.unit || '') + ' ' + item.name);
    return res.json({ message: 'Đã gửi đề nghị cấp phát, chờ Phòng KHCN xác nhận.', issuanceId: ins.lastInsertRowid });
  }

  if (action === 'delete_issuance') {
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'Thiếu issuanceId' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'Không tìm thấy đợt cấp' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Chỉ xóa được đề nghị đang chờ xác nhận.' });
    if (!isAdmin && iss.requestedById !== req.user.id) return res.status(403).json({ message: 'Chỉ người đề nghị hoặc Admin mới được xóa đề nghị này.' });
    db.prepare('DELETE FROM cap_vien_step9_supply_issuance WHERE id = ?').run(issuanceId);
    return res.json({ message: 'Đã xóa đề nghị cấp phát.' });
  }

  if (action === 'confirm_issuance') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được xác nhận cấp phát.' });
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'Thiếu issuanceId' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'Không tìm thấy đợt cấp' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Đợt cấp này đã được xử lý.' });
    const item = getItem(iss.itemId);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy mục hoá chất/vật tư liên quan' });
    const already = confirmedQtyForItem(iss.itemId);
    if (already + iss.qty > item.approvedQty + 1e-9) {
      return res.status(400).json({ message: 'Không thể xác nhận — tổng đã cấp sẽ vượt số lượng đã duyệt (còn lại ' + (item.approvedQty - already) + ' ' + (item.unit || '') + ').' });
    }
    db.prepare('UPDATE cap_vien_step9_supply_issuance SET status = ?, decidedById = ?, decidedAt = ? WHERE id = ?').run('confirmed', req.user.id, nowIso, issuanceId);
    insertCapVienHistory(id, '9', 'supply_confirm_issuance', req.user.id, staffHistoryRole, 'Xác nhận cấp ' + iss.qty + ' ' + (item.unit || '') + ' ' + item.name);
    return res.json({ message: 'Đã xác nhận cấp phát.' });
  }

  if (action === 'reject_issuance') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được từ chối cấp phát.' });
    const issuanceId = parseInt(payload.issuanceId, 10);
    if (!issuanceId) return res.status(400).json({ message: 'Thiếu issuanceId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lòng nhập lý do từ chối' });
    const iss = db.prepare('SELECT * FROM cap_vien_step9_supply_issuance WHERE id = ? AND submissionId = ?').get(issuanceId, id);
    if (!iss) return res.status(404).json({ message: 'Không tìm thấy đợt cấp' });
    if (iss.status !== 'requested') return res.status(400).json({ message: 'Đợt cấp này đã được xử lý.' });
    db.prepare('UPDATE cap_vien_step9_supply_issuance SET status = ?, decidedById = ?, decidedAt = ?, decisionNote = ? WHERE id = ?').run('rejected', req.user.id, nowIso, note, issuanceId);
    insertCapVienHistory(id, '9', 'supply_reject_issuance', req.user.id, staffHistoryRole, 'Từ chối cấp phát: ' + note);
    return res.json({ message: 'Đã từ chối đề nghị cấp phát.' });
  }

  return res.status(400).json({ message: 'Hành động không hợp lệ.' });
});

// Bước 11: đề xuất điều chỉnh (nhân sự/kế hoạch/dự toán/gia hạn) — 2 cấp Phòng KHCN -> Viện trưởng.
router.post('/cap-vien/submissions/:id/step11-adjustment/action', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  const isPhongKhcnOrAdmin = roleIsAny(req, ['admin', 'phong_khcn', 'thu_ky']);
  const isDirectorOrAdmin = roleIsAny(req, ['admin', 'vien_truong']);
  const actorRole = (req.user.role || '').toLowerCase() || 'admin';
  const ownerHistoryRole = isOwner ? 'researcher' : 'admin';
  const body = req.body || {};
  const payload = body.payload || {};
  const actionRaw = body.action || payload.action || '';
  const action = String(actionRaw).toLowerCase().trim();
  const nowIso = new Date().toISOString();
  const ALLOWED_ADJUSTMENT_TYPES = ['nhan_su', 'ke_hoach', 'du_toan', 'gia_han', 'khac'];

  function getOpenAdjustmentRequest() {
    return db.prepare("SELECT id FROM cap_vien_step11_adjustment_request WHERE submissionId = ? AND status NOT IN ('approved','rejected') ORDER BY id DESC LIMIT 1").get(id);
  }
  function getAdjustmentRequest(requestId) {
    return db.prepare('SELECT * FROM cap_vien_step11_adjustment_request WHERE id = ? AND submissionId = ?').get(requestId, id);
  }

  if (action === 'submit_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được nộp đề xuất điều chỉnh.' });
    if (getOpenAdjustmentRequest()) return res.status(400).json({ message: 'Đã có đề xuất điều chỉnh đang xử lý, vui lòng chờ hoàn tất trước khi nộp đề xuất mới.' });
    const type = String(payload.type || '').toLowerCase().trim();
    if (!ALLOWED_ADJUSTMENT_TYPES.includes(type)) return res.status(400).json({ message: 'Loại điều chỉnh không hợp lệ' });
    const content = String(payload.content || '').trim();
    if (!content) return res.status(400).json({ message: 'Vui lòng nhập nội dung đề xuất' });
    const ins = db.prepare(
      'INSERT INTO cap_vien_step11_adjustment_request (submissionId, type, content, status, requestedById, requestedAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, type, content, 'submitted', req.user.id, nowIso);
    insertCapVienHistory(id, '11', 'adjustment_submit_request', req.user.id, ownerHistoryRole, 'Nộp đề xuất điều chỉnh (' + type + ')');
    return res.json({ message: 'Đã nộp đề xuất điều chỉnh, chờ Phòng KHCN xem xét.', requestId: ins.lastInsertRowid });
  }

  if (action === 'update_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được sửa đề xuất.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiếu requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (r.status !== 'khcn_need_revision') return res.status(400).json({ message: 'Chỉ sửa được khi Phòng KHCN yêu cầu bổ sung.' });
    const updates = [];
    const params = [];
    if (payload.type !== undefined) {
      const t = String(payload.type || '').toLowerCase().trim();
      if (!ALLOWED_ADJUSTMENT_TYPES.includes(t)) return res.status(400).json({ message: 'Loại điều chỉnh không hợp lệ' });
      updates.push('type = ?'); params.push(t);
    }
    if (payload.content !== undefined) {
      const c = String(payload.content || '').trim();
      if (!c) return res.status(400).json({ message: 'Nội dung không được để trống' });
      updates.push('content = ?'); params.push(c);
    }
    updates.push('status = ?'); params.push('submitted');
    params.push(requestId);
    db.prepare('UPDATE cap_vien_step11_adjustment_request SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    insertCapVienHistory(id, '11', 'adjustment_update_request', req.user.id, ownerHistoryRole, 'Nộp lại đề xuất điều chỉnh sau khi bổ sung');
    return res.json({ message: 'Đã nộp lại đề xuất, chờ Phòng KHCN xem xét.' });
  }

  if (action === 'withdraw_request') {
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được rút đề xuất.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiếu requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chỉ rút được khi đề xuất đang chờ Phòng KHCN xem xét lần đầu.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected' WHERE id = ?").run(requestId);
    insertCapVienHistory(id, '11', 'adjustment_withdraw_request', req.user.id, ownerHistoryRole, 'Rút đề xuất điều chỉnh');
    return res.json({ message: 'Đã rút đề xuất.' });
  }

  if (action === 'khcn_request_revision') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được yêu cầu bổ sung.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiếu requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung yêu cầu bổ sung' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chỉ xử lý được khi đề xuất đang chờ Phòng KHCN xem xét.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'khcn_need_revision', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_request_revision', req.user.id, actorRole, 'Yêu cầu bổ sung đề xuất điều chỉnh: ' + note);
    return res.json({ message: 'Đã yêu cầu Chủ nhiệm bổ sung đề xuất.' });
  }

  if (action === 'khcn_forward') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được trình Viện trưởng.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiếu requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chỉ trình được khi đề xuất đang chờ Phòng KHCN xem xét.' });
    const note = payload.note ? String(payload.note).trim() : null;
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'khcn_forwarded', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_forward', req.user.id, actorRole, 'Trình Viện trưởng phê duyệt đề xuất điều chỉnh');
    return res.json({ message: 'Đã trình Viện trưởng phê duyệt.' });
  }

  if (action === 'khcn_reject') {
    if (!isPhongKhcnOrAdmin) return res.status(403).json({ message: 'Chỉ Admin hoặc Phòng KHCN mới được từ chối.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiếu requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lòng nhập lý do từ chối' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (r.status !== 'submitted') return res.status(400).json({ message: 'Chỉ từ chối được khi đề xuất đang chờ Phòng KHCN xem xét.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected', khcnNote = ?, khcnDecidedById = ?, khcnDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_khcn_reject', req.user.id, actorRole, 'Phòng KHCN từ chối đề xuất: ' + note);
    return res.json({ message: 'Đã từ chối đề xuất.' });
  }

  if (action === 'director_approve') {
    if (!isDirectorOrAdmin) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được phê duyệt.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiếu requestId' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (r.status !== 'khcn_forwarded') return res.status(400).json({ message: 'Chỉ phê duyệt được khi Phòng KHCN đã trình.' });
    const note = payload.note ? String(payload.note).trim() : null;
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'approved', directorNote = ?, directorDecidedById = ?, directorDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_director_approve', req.user.id, actorRole, 'Viện trưởng phê duyệt đề xuất điều chỉnh');
    return res.json({ message: 'Đã phê duyệt đề xuất điều chỉnh.' });
  }

  if (action === 'director_reject') {
    if (!isDirectorOrAdmin) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được từ chối.' });
    const requestId = parseInt(payload.requestId, 10);
    if (!requestId) return res.status(400).json({ message: 'Thiếu requestId' });
    const note = String(payload.note || '').trim();
    if (!note) return res.status(400).json({ message: 'Vui lòng nhập lý do không phê duyệt' });
    const r = getAdjustmentRequest(requestId);
    if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
    if (r.status !== 'khcn_forwarded') return res.status(400).json({ message: 'Chỉ xử lý được khi Phòng KHCN đã trình.' });
    db.prepare("UPDATE cap_vien_step11_adjustment_request SET status = 'rejected', directorNote = ?, directorDecidedById = ?, directorDecidedAt = ? WHERE id = ?").run(note, req.user.id, nowIso, requestId);
    insertCapVienHistory(id, '11', 'adjustment_director_reject', req.user.id, actorRole, 'Viện trưởng không phê duyệt: ' + note);
    return res.json({ message: 'Đã ghi nhận Viện trưởng không phê duyệt.' });
  }

  return res.status(400).json({ message: 'Hành động không hợp lệ.' });
});

return router;
};
