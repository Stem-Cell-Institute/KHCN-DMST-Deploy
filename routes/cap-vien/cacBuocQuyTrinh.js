'use strict';

/**
 * Đề tài cấp Viện — bộ điều phối các bước quy trình: Bước 2, 3, 6, 7, 8, 8a, 9 (1 endpoint).
 *
 *   POST /api/cap-vien/submissions/:id/steps/:step
 *
 * Tách khỏi server.js (Đợt 4.6 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');

module.exports = function createCapVienCacBuocQuyTrinhRouter({
  db,
  authMiddleware,
  roleIsAny,
  insertCapVienStep2History,
  sendCapVienStep2ValidatedEmail,
  sendCapVienStep2RevisionEmail,
  usersWithAnyRole,
  insertCapVienHistory,
  sendCapVienStep3AssignEmail,
  sendCapVienStep4aNotifyBudgetTeamEmail,
  capVienStep6CanEdit,
  capVienStep6HistoryRoleDb,
  sendCapVienStep6CompletedEmail,
  getNotificationEmails,
  getPhongKhcnEmails,
  getCapVienStep7EmailOnComplete,
  sendCapVienStep7CompletedEmail,
}) {
const router = express.Router();

// Bước quy trình Đề tài cấp Viện: Thư ký HĐKHCN — Bước 2 (Kiểm tra hồ sơ): Đánh dấu Hợp lệ / Yêu cầu bổ sung
router.post('/cap-vien/submissions/:id/steps/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = req.params.step;
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isSecretaryOrAdmin = roleIsAny(req, ['admin', 'thu_ky']);
  if (step === '2') {
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const currentStatus = sub.status || 'SUBMITTED';
    const roleLower = (role || '').toLowerCase();

    // Chỉ Admin mới được đưa hồ sơ về Bước 2 để kiểm tra lại
    if (action === 'revert') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về Bước 2 (kiểm tra lại)' });
      }
      if (currentStatus === 'SUBMITTED') {
        return res.status(400).json({ message: 'Hồ sơ đang ở Bước 2, không cần đưa về' });
      }
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
        .run('SUBMITTED', id);
      insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2 để kiểm tra lại');
      console.log('[API] cap-vien step 2 revert — submission ' + id);
      return res.json({ message: 'Đã đưa hồ sơ về Bước 2. Thư ký có thể nhấn Hợp lệ hoặc Yêu cầu bổ sung lại.', status: 'SUBMITTED' });
    }

    if (!isSecretaryOrAdmin) {
      return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được thực hiện Bước 2 (Kiểm tra hồ sơ)' });
    }
    if (currentStatus !== 'SUBMITTED') {
      return res.status(400).json({ message: 'Hồ sơ này đã được xử lý tại Bước 2. Chỉ Admin mới có thể đưa về để kiểm tra lại.' });
    }
    if (action === 'approve') {
      const reviewedAt = new Date().toISOString();
      const note = (payload.note || '').trim();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('VALIDATED', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_approve', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note || 'Hợp lệ');
      const row = db.prepare('SELECT submittedBy, submittedById, createdAt FROM cap_vien_submissions WHERE id = ?').get(id);
      const u = row && row.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById) : null;
      const hasSupplement = (db.prepare('SELECT 1 FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound > 0 LIMIT 1').get(id) || null) != null;
      sendCapVienStep2ValidatedEmail({
        submissionTitle: sub.title,
        submittedByEmail: (row && row.submittedBy) || sub.submittedBy,
        submittedByName: u ? u.fullname : null,
        createdAt: row ? row.createdAt : null,
        status: 'VALIDATED',
        reviewedByName: req.user.fullname || req.user.email,
        hasSupplement
      });
      console.log('[API] cap-vien step 2 approve — submission ' + id);
      return res.json({ message: 'Đã Hợp lệ. Hồ sơ chuyển sang Bước 3.', status: 'VALIDATED' });
    }
    if (action === 'request_revision') {
      const note = (payload.note || '').trim();
      if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung yêu cầu bổ sung' });
      const reviewedAt = new Date().toISOString();
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
        .run('NEED_REVISION', note, reviewedAt, req.user.id, id);
      insertCapVienStep2History(id, 'secretary_request_revision', req.user.id, req.user.role === 'admin' ? 'admin' : 'secretary', note);
      const secretaryName = (req.user.fullname || req.user.email || 'Thư ký').toString();
      const rowSub = db.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
      const researcherName = rowSub && rowSub.submittedById ? (db.prepare('SELECT fullname FROM users WHERE id = ?').get(rowSub.submittedById) || {}).fullname : null;
      sendCapVienStep2RevisionEmail(sub.title, sub.submittedBy || null, note, secretaryName, id, researcherName);
      console.log('[API] cap-vien step 2 request_revision — submission ' + id);
      return res.json({ message: 'Đã ghi nhận yêu cầu bổ sung. Nội dung đã gửi nghiên cứu viên và thông báo cho Hội đồng.', status: 'NEED_REVISION' });
    }
    return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: approve, request_revision hoặc revert (chỉ Admin)' });
  }
  if (step === '3') {
    const isChairmanOrAdmin = roleIsAny(req, ['admin', 'chu_tich']);
    if (!isChairmanOrAdmin) {
      return res.status(403).json({ message: 'Chỉ Chủ tịch HĐKHCN hoặc Admin mới được phân công phản biện' });
    }
    if ((sub.status || '') !== 'VALIDATED') {
      return res.status(400).json({ message: 'Chỉ có thể phân công phản biện khi hồ sơ đã Hợp lệ (Bước 2 xong)' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'assign') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: assign' });
    }
    let reviewerIds = (payload.reviewerIds || body.reviewerIds || []).map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
    if (payload.reviewer1 && payload.reviewer2) {
      reviewerIds = [parseInt(payload.reviewer1, 10), parseInt(payload.reviewer2, 10)].filter(rid => rid > 0);
    }
    reviewerIds = [...new Set(reviewerIds)];
    if (reviewerIds.length < 2) {
      return res.status(400).json({ message: 'Vui lòng chọn đủ 2 phản biện từ danh sách thành viên Hội đồng' });
    }
    const councilIds = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']).map((r) => r.id);
    const invalid = reviewerIds.filter(rid => !councilIds.includes(rid));
    if (invalid.length > 0) {
      return res.status(400).json({ message: 'Tất cả phản biện phải là thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên HĐKHCN)' });
    }
    const assignedAt = new Date().toISOString();
    db.prepare('UPDATE cap_vien_submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ? WHERE id = ?')
      .run('ASSIGNED', JSON.stringify(reviewerIds), assignedAt, req.user.id, id);
    const reviewerNamesArr = db.prepare('SELECT fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds).map(r => r.fullname || '');
    insertCapVienHistory(id, '3', 'chairman_assign', req.user.id, role === 'admin' ? 'admin' : 'chairman', 'Phân công 2 phản biện: ' + reviewerNamesArr.join(', '));
    const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
    const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
    const reviewerEmails = reviewers.map(r => r.email);
    const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
    sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
    sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
    console.log('[API] cap-vien step 3 assign — submission ' + id + ', reviewers: ' + reviewerIds.join(','));
    return res.json({ message: 'Đã phân công phản biện. Email đã gửi đến các phản biện, Hội đồng và Tổ thẩm định tài chính.', status: 'ASSIGNED' });
  }
  if (step === '6') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới ghi nhận hoàn thành Bước 6 (Quyết định).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const sub6 = db.prepare('SELECT id, status, step6_so_qd FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub6) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if (action !== 'approve') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: approve' });
    }
    if ((sub6.status || '').toUpperCase() !== 'CONDITIONAL') {
      return res.status(400).json({ message: 'Chỉ chuyển Bước 7 khi hồ sơ đang ở Bước 6 (trạng thái sau Bước 5 — CONDITIONAL).' });
    }
    if (!String(sub6.step6_so_qd || '').trim()) {
      return res.status(400).json({ message: 'Vui lòng nhập và lưu Số Quyết định (mục Bước 6) trước khi hoàn tất.' });
    }
    const hasVn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_vn' LIMIT 1").get(id);
    const hasEn = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step6_decision_en' LIMIT 1").get(id);
    if (!hasVn || !hasEn) {
      return res.status(400).json({ message: 'Cần upload đủ file Quyết định tiếng Việt và tiếng Anh trước khi hoàn tất Bước 6.' });
    }
    const rowMail = db.prepare(`SELECT s.title, s.submittedBy, s.submittedById, s.step6_so_qd,
      u.email AS ownerEmail, u.fullname AS ownerName
      FROM cap_vien_submissions s
      LEFT JOIN users u ON u.id = s.submittedById
      WHERE s.id = ?`).get(id);
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('APPROVED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '6', 'step6_complete', req.user.id, roleDb, 'Ghi nhận hoàn thành Cấp Quyết định — chuyển Bước 7');
    console.log('[API] cap-vien step 6 approve — submission ' + id);
    const researcherEmail = ((rowMail && rowMail.ownerEmail) || (rowMail && rowMail.submittedBy) || '').trim();
    sendCapVienStep6CompletedEmail({
      submissionTitle: rowMail ? rowMail.title : '',
      submissionId: id,
      researcherEmail,
      researcherName: rowMail ? rowMail.ownerName : null,
      soQd: rowMail ? rowMail.step6_so_qd : sub6.step6_so_qd,
      // CC cả Hội đồng KHCN lẫn Phòng KHCN (Phòng KHCN là nơi đã nhận hồ sơ nộp mới, cần biết kết quả duyệt cuối cùng)
      councilList: Array.from(new Set([
        ...getNotificationEmails('cap_vien_step6_completed_notice'),
        ...getPhongKhcnEmails()
      ]))
    }).catch((err) => console.error('[Email] Bước 6 hoàn thành:', err && err.message));
    return res.json({ message: 'Đã ghi nhận hoàn thành Bước 6. Hồ sơ chuyển sang Bước 7 (Ký hợp đồng). Đã gửi thông báo hành chính tới Chủ nhiệm (CC Hội đồng KHCN & Phòng KHCN).', status: 'APPROVED' });
  }
  if (step === '7') {
    const roleLower = (role || '').toLowerCase();
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới ghi nhận hoàn thành Bước 7 (Hợp đồng KHCN).' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    if (action !== 'complete' && action !== 'confirm_signed') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: complete' });
    }
    const sub7 = db.prepare('SELECT id, status, title, submittedBy, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub7) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if ((sub7.status || '').toUpperCase() !== 'APPROVED') {
      return res.status(400).json({ message: 'Chỉ hoàn thành Bước 7 khi hồ sơ đang ở trạng thái APPROVED (sau Bước 6).' });
    }
    const hasContract = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step7_hop_dong_khcn' LIMIT 1").get(id);
    if (!hasContract) {
      return res.status(400).json({ message: 'Cần upload Hợp đồng KHCN vào hồ sơ trước khi nhấn Hoàn thành.' });
    }
    const sendMail = getCapVienStep7EmailOnComplete();
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONTRACTED', id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '7', 'step7_complete', req.user.id, roleDb, 'Ghi nhận hoàn thành Bước 7 — Hợp đồng KHCN; chuyển bước tiếp theo');
    console.log('[API] cap-vien step 7 complete — submission ' + id + ', email=' + sendMail);
    const rowMail = db.prepare(`SELECT s.title, s.submittedBy, s.submittedById, u.email AS ownerEmail, u.fullname AS ownerName
      FROM cap_vien_submissions s
      LEFT JOIN users u ON u.id = s.submittedById
      WHERE s.id = ?`).get(id);
    const researcherEmail = ((rowMail && rowMail.ownerEmail) || (rowMail && rowMail.submittedBy) || '').trim();
    if (sendMail) {
      sendCapVienStep7CompletedEmail({
        submissionTitle: rowMail ? rowMail.title : '',
        submissionId: id,
        researcherEmail,
        researcherName: rowMail ? rowMail.ownerName : null,
        councilList: getNotificationEmails('cap_vien_step7_completed_notice')
      }).catch((err) => console.error('[Email] Bước 7 hoàn thành:', err && err.message));
    }
    const msg = sendMail
      ? 'Đã ghi nhận hoàn thành Bước 7. Hồ sơ chuyển sang bước tiếp theo (đăng ký đạo đức / tạm ứng…). Đã gửi email thông báo hành chính tới Chủ nhiệm (CC Hội đồng KHCN nhận thông báo).'
      : 'Đã ghi nhận hoàn thành Bước 7. Hồ sơ chuyển sang bước tiếp theo. (Admin đã tắt gửi email tự động.)';
    return res.json({ message: msg, status: 'CONTRACTED', emailSent: !!sendMail });
  }
  if (step === '8') {
    const roleLower = (role || '').toLowerCase();
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const sub8 = db.prepare(`SELECT id, status, step8_ma_dao_duc,
      COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived
      FROM cap_vien_submissions WHERE id = ?`).get(id);
    if (!sub8) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if ((sub8.status || '').toUpperCase() !== 'CONTRACTED') {
      return res.status(400).json({ message: 'Chỉ thao tác Bước 8 khi hồ sơ đã ký hợp đồng (CONTRACTED).' });
    }
    if (action === 'admin_bypass') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin mới được bypass Bước 8 (đánh dấu hoàn thành thủ công).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'Bước 8 đã hoàn thành.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1, step8_waived = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_bypass', req.user.id, 'admin', 'Admin bypass Bước 8 — hoàn thành không qua đủ điều kiện thông thường');
      console.log('[API] cap-vien step 8 admin_bypass — submission ' + id);
      return res.json({ message: 'Đã bypass Bước 8 (đánh dấu hoàn thành).', status: 'CONTRACTED' });
    }
    if (action === 'admin_waive') {
      if (roleLower !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin mới được bất hoạt Bước 8 (không áp dụng cho đề tài này).' });
      }
      if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
        return res.status(400).json({ message: 'Đã hoàn thành Bước 8; không thể bất hoạt. Có thể đưa hồ sơ về Bước 7 (Admin) nếu cần làm lại.' });
      }
      db.prepare('UPDATE cap_vien_submissions SET step8_waived = 1, step8_completed = 0 WHERE id = ?').run(id);
      insertCapVienHistory(id, '8', 'step8_admin_waive', req.user.id, 'admin', 'Admin bất hoạt Bước 8 — đăng ký đạo đức không áp dụng cho đề tài này');
      console.log('[API] cap-vien step 8 admin_waive — submission ' + id);
      return res.json({ message: 'Đã đánh dấu Bước 8 không áp dụng cho đề tài này.', status: 'CONTRACTED' });
    }
    if (action !== 'complete') {
      return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng: complete, admin_bypass, admin_waive (Admin).' });
    }
    if (!capVienStep6CanEdit(req)) {
      return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới ghi nhận hoàn thành Bước 8 (Đạo đức).' });
    }
    if (sub8.step8_waived === 1 || sub8.step8_waived === true) {
      return res.status(400).json({ message: 'Bước 8 đã được đánh dấu không áp dụng (bất hoạt).' });
    }
    if (sub8.step8_completed === 1 || sub8.step8_completed === true) {
      return res.status(400).json({ message: 'Bước 8 đã được đánh dấu hoàn thành trước đó.' });
    }
    if (!String(sub8.step8_ma_dao_duc || '').trim()) {
      return res.status(400).json({ message: 'Vui lòng nhập và lưu Mã đạo đức trước khi hoàn tất Bước 8.' });
    }
    const hasEthicsFile = db.prepare("SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = 'step8_ethics_quyet_dinh' LIMIT 1").get(id);
    if (!hasEthicsFile) {
      return res.status(400).json({ message: 'Cần upload Quyết định đạo đức trước khi hoàn tất Bước 8.' });
    }
    db.prepare('UPDATE cap_vien_submissions SET step8_completed = 1 WHERE id = ?').run(id);
    const roleDb = capVienStep6HistoryRoleDb(roleLower);
    insertCapVienHistory(id, '8', 'step8_complete', req.user.id, roleDb, 'Hoàn thành Bước 8 — Đăng ký/Cấp mã đạo đức');
    console.log('[API] cap-vien step 8 complete — submission ' + id);
    return res.json({
      message: 'Đã ghi nhận hoàn thành Bước 8. Có thể tiếp tục các bước tiếp theo theo quy trình (Bước 9 trở đi).',
      status: 'CONTRACTED'
    });
  }
  if (step === '8a') {
    return res.status(410).json({ message: 'Bước 8A đã được gỡ khỏi quy trình; không còn thao tác tại endpoint này.' });
  }
  if (step === '9') {
    const isOwner = sub.submittedById === req.user.id;
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được khai báo mốc hoạt động Bước 9.' });
    }
    const body = req.body || {};
    const payload = body.payload || {};
    const actionRaw = body.action || payload.action || '';
    const action = String(actionRaw).toLowerCase().trim();
    const nowIso = new Date().toISOString();
    const historyRole = isOwner ? 'researcher' : 'admin';

    if (action === 'add_milestone') {
      const title = String(payload.title || '').trim();
      if (!title) return res.status(400).json({ message: 'Vui lòng nhập tên mốc hoạt động' });
      const eventDate = payload.eventDate ? String(payload.eventDate).trim() : null;
      const note = payload.note ? String(payload.note).trim() : null;
      const maxRow = db.prepare('SELECT COALESCE(MAX(sortOrder), 0) AS m FROM cap_vien_step9_milestone WHERE submissionId = ? AND deletedAt IS NULL').get(id);
      const sortOrder = (maxRow.m || 0) + 1;
      const ins = db.prepare(
        'INSERT INTO cap_vien_step9_milestone (submissionId, title, status, eventDate, note, sortOrder, createdAt, createdById) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, title, 'planned', eventDate, note, sortOrder, nowIso, req.user.id);
      insertCapVienHistory(id, '9', 'milestone_add', req.user.id, historyRole, 'Thêm mốc hoạt động: ' + title);
      return res.json({ message: 'Đã thêm mốc hoạt động.', milestoneId: ins.lastInsertRowid });
    }

    if (action === 'update_milestone') {
      const milestoneId = parseInt(payload.milestoneId, 10);
      if (!milestoneId) return res.status(400).json({ message: 'Thiếu milestoneId' });
      const m = db.prepare('SELECT id, title FROM cap_vien_step9_milestone WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(milestoneId, id);
      if (!m) return res.status(404).json({ message: 'Không tìm thấy mốc hoạt động' });
      const allowedStatus = ['planned', 'in_progress', 'done'];
      const updates = [];
      const params = [];
      if (payload.title !== undefined) {
        const t = String(payload.title || '').trim();
        if (!t) return res.status(400).json({ message: 'Tên mốc hoạt động không được để trống' });
        updates.push('title = ?'); params.push(t);
      }
      if (payload.eventDate !== undefined) { updates.push('eventDate = ?'); params.push(payload.eventDate ? String(payload.eventDate).trim() : null); }
      if (payload.note !== undefined) { updates.push('note = ?'); params.push(payload.note ? String(payload.note).trim() : null); }
      if (payload.status !== undefined) {
        const st = String(payload.status || '').toLowerCase().trim();
        if (!allowedStatus.includes(st)) return res.status(400).json({ message: 'Trạng thái không hợp lệ (planned/in_progress/done)' });
        updates.push('status = ?'); params.push(st);
      }
      if (!updates.length) return res.status(400).json({ message: 'Không có trường nào để cập nhật' });
      updates.push('updatedAt = ?', 'updatedById = ?');
      params.push(nowIso, req.user.id, milestoneId);
      db.prepare('UPDATE cap_vien_step9_milestone SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
      insertCapVienHistory(id, '9', 'milestone_update', req.user.id, historyRole, 'Cập nhật mốc hoạt động: ' + m.title);
      return res.json({ message: 'Đã cập nhật mốc hoạt động.' });
    }

    if (action === 'delete_milestone') {
      const milestoneId = parseInt(payload.milestoneId, 10);
      if (!milestoneId) return res.status(400).json({ message: 'Thiếu milestoneId' });
      const m = db.prepare('SELECT id, title FROM cap_vien_step9_milestone WHERE id = ? AND submissionId = ? AND deletedAt IS NULL').get(milestoneId, id);
      if (!m) return res.status(404).json({ message: 'Không tìm thấy mốc hoạt động' });
      db.prepare('UPDATE cap_vien_step9_milestone SET deletedAt = ? WHERE id = ?').run(nowIso, milestoneId);
      insertCapVienHistory(id, '9', 'milestone_delete', req.user.id, historyRole, 'Xóa mốc hoạt động: ' + m.title);
      return res.json({ message: 'Đã xóa mốc hoạt động.' });
    }

    return res.status(400).json({ message: 'Hành động không hợp lệ. Dùng action: add_milestone, update_milestone hoặc delete_milestone' });
  }
  return res.status(404).json({ message: 'Bước ' + step + ' chưa được triển khai tại backend' });
});

return router;
};
