'use strict';

/**
 * Đề tài cấp Viện — Bước 4 (phản biện), Bước 4A (thẩm định dự toán) và gửi lại email (9 endpoint).
 *
 *   POST /api/cap-vien/submissions/:id/steps/4/reviewer-upload
 *   POST /api/cap-vien/submissions/:id/steps/4/reviewer-complete
 *   POST /api/cap-vien/submissions/:id/steps/4/reviewer-delete
 *   POST /api/cap-vien/submissions/:id/steps/4a/upload
 *   POST /api/cap-vien/submissions/:id/steps/4a/request-revision
 *   POST /api/cap-vien/submissions/:id/steps/4a/upload-revised
 *   POST /api/cap-vien/submissions/:id/steps/4a/approve
 *   POST /api/cap-vien/submissions/:id/send-step4-email
 *   POST /api/cap-vien/submissions/:id/send-step4a-email
 *
 * Tách khỏi server.js (Đợt 4.8 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createCapVienPhanBienVaDuToanRouter({
  db,
  authMiddleware,
  adminOnly,
  uploadCapVien,
  uploadDirCapVien,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
  insertCapVienHistory,
  sendCapVienStep5ReadyEmail,
  roleIsAny,
  getNotificationEmails,
  sendCapVienBudgetRevisionRequestEmail,
  sendCapVienBudgetRevisedSubmittedEmail,
  sendCapVienBudgetApprovedEmail,
  sendCapVienStep3AssignEmail,
  sendCapVienStep4aNotifyBudgetTeamEmail,
}) {
const router = express.Router();

// Bước 4: Phản biện upload phiếu đánh giá (slot 1 hoặc 2) - upload KHONG tu dong "hoan thanh"
router.post('/cap-vien/submissions/:id/steps/4/reviewer-upload', authMiddleware, uploadCapVien.single('phieu_danh_gia'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.body.slot || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được upload phiếu đánh giá' });
  const file = req.file || req.files?.phieu_danh_gia?.[0];
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file phiếu đánh giá (PDF hoặc Word)' });

  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, 'reviewer_phieu_' + slot);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);

  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, 'reviewer_' + slot + '_' + Date.now() + path.extname(storedName || '.pdf'));
  try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)')
    .run(id, 'reviewer_phieu_' + slot, storedName, newPath);

  // Upload moi/ghi de thi phai nhan "Hoan thanh" lai
  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('ASSIGNED', 'UNDER_REVIEW', id);

  insertCapVienHistory(id, '4', 'reviewer_upload', req.user.id, 'reviewer', 'Phản biện ' + slot + ' upload phiếu đánh giá');
  console.log('[API] cap-vien step 4 reviewer-upload slot ' + slot + ' — submission ' + id);
  return res.json({ message: 'Đã upload phiếu đánh giá. Vui lòng nhấn "Hoàn thành phản biện ' + slot + '" sau khi kiểm tra.', slot });
});

// Bước 4: Phản biện xác nhận hoàn thành slot
router.post('/cap-vien/submissions/:id/steps/4/reviewer-complete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được xác nhận hoàn thành' });

  const hasFile = db.prepare('SELECT id FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!hasFile) return res.status(400).json({ message: 'Phản biện ' + slot + ' chưa upload file. Vui lòng upload trước khi nhấn hoàn thành.' });

  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 1 WHERE id = ?').run(id);
  insertCapVienHistory(id, '4', 'reviewer_complete', req.user.id, 'reviewer', 'Phản biện ' + slot + ' xác nhận hoàn thành');

  const doneRow = db.prepare('SELECT step_4_reviewer1_done, step_4_reviewer2_done, budget_4a_status FROM cap_vien_submissions WHERE id = ?').get(id);
  const bothDone = !!(doneRow && doneRow.step_4_reviewer1_done && doneRow.step_4_reviewer2_done);
  const budgetApproved = !!(doneRow && doneRow.budget_4a_status === 'approved');
  if (bothDone && budgetApproved) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    sendCapVienStep5ReadyEmail({ submissionTitle: sub.title, submissionId: id });
  } else {
    db.prepare('UPDATE cap_vien_submissions SET status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
      .run('ASSIGNED', 'UNDER_REVIEW', id);
  }

  return res.json({
    message: bothDone ? 'Đã ghi nhận: cả 2 phản biện đã hoàn thành.' : ('Đã ghi nhận: phản biện ' + slot + ' hoàn thành.'),
    slot,
    bothDone,
    step5Ready: bothDone && budgetApproved
  });
});

// Bước 4: Xóa file phản biện để upload lại
router.post('/cap-vien/submissions/:id/steps/4/reviewer-delete', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt((req.body && req.body.slot) || req.query.slot || '0', 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'ID hoặc slot không hợp lệ (slot: 1 hoặc 2)' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ thao tác được ở Bước 4 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  const reviewerId = reviewerIds[slot - 1];
  const isReviewer = reviewerId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isReviewer && !isAdmin) return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được xóa file phản biện' });

  const row = db.prepare('SELECT id, path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, 'reviewer_phieu_' + slot);
  if (!row) return res.status(400).json({ message: 'Chưa có file phản biện ' + slot + ' để xóa' });
  db.prepare('DELETE FROM cap_vien_submission_files WHERE id = ?').run(row.id);
  if (row.path) safeUnlinkCapVienStoredFile(row.path);
  db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer' + slot + '_done = 0, status = CASE WHEN status = ? THEN ? ELSE status END WHERE id = ?')
    .run('REVIEWED', 'UNDER_REVIEW', id);
  insertCapVienHistory(id, '4', 'reviewer_delete', req.user.id, 'reviewer', 'Xóa file phản biện ' + slot + ' để upload lại');
  return res.json({ message: 'Đã xóa file phản biện ' + slot + '. Bạn có thể upload lại và nhấn hoàn thành.', slot });
});

// Bước 4A: Nộp phiếu thẩm định dự toán — upload 2 file (budget_phieu_tham_dinh, budget_to_trinh)
router.post('/cap-vien/submissions/:id/steps/4a/upload', authMiddleware, uploadCapVien.fields([
  { name: 'budget_phieu_tham_dinh', maxCount: 1 },
  { name: 'budget_to_trinh', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isCouncilOrAdmin) {
    return res.status(403).json({ message: 'Chỉ thành viên Hội đồng, Tổ thẩm định tài chính hoặc Admin mới được nộp phiếu thẩm định dự toán' });
  }
  const files = req.files || {};
  const f1 = files.budget_phieu_tham_dinh && files.budget_phieu_tham_dinh[0];
  const f2 = files.budget_to_trinh && files.budget_to_trinh[0];
  if (!f1 || !f2) {
    return res.status(400).json({ message: 'Vui lòng tải lên đủ 2 file: Phiếu thẩm định (SCI-BUDGET-01) và Tờ trình (SCI-BUDGET-02)' });
  }
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const BUDGET_FIELDS = [
    { field: 'budget_phieu_tham_dinh', file: f1 },
    { field: 'budget_to_trinh', file: f2 }
  ];
  db.transaction(() => {
    for (const { field, file } of BUDGET_FIELDS) {
      const ext = path.extname(file.originalname) || '.pdf';
      const storedName = 'budget_' + field + '_' + Date.now() + ext;
      const newPath = path.join(baseDir, storedName);
      fs.renameSync(file.path, newPath);
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, field, file.originalname, newPath, sub.budget_4a_round || 1, req.user.id, role, new Date().toISOString());
    }
  })();
  const roleLabel = role === 'totruong_tham_dinh_tc' ? 'totruong_tham_dinh' : (role === 'thanh_vien_tham_dinh_tc' ? 'thanh_vien_tham_dinh' : role);
  insertCapVienHistory(id, '4a', 'budget_upload', req.user.id, roleLabel, 'Nộp phiếu thẩm định dự toán (vòng ' + (sub.budget_4a_round || 1) + '): SCI-BUDGET-01, SCI-BUDGET-02');
  console.log('[API] cap-vien step 4a upload — submission ' + id);
  return res.json({ message: 'Đã nộp phiếu thẩm định dự toán. Thành viên Hội đồng có thể tải file ngay.', files: ['budget_phieu_tham_dinh', 'budget_to_trinh'] });
});

// Bước 4A: Tổ thẩm định yêu cầu bổ sung/chỉnh sửa dự toán — comment + file upload
router.post('/cap-vien/submissions/:id/steps/4a/request-revision', authMiddleware, uploadCapVien.fields([
  { name: 'revision_files', maxCount: 10 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isBudgetTeam = roleIsAny(req, ['admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chỉ Tổ thẩm định tài chính hoặc Admin mới được yêu cầu bổ sung dự toán' });
  const note = (req.body.note || req.body.comment || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung yêu cầu bổ sung/chỉnh sửa' });
  const files = req.files || {};
  const fList = files.revision_files || [];
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const ts = Date.now();
  const currentRound = sub.budget_4a_round || 1;
  let targetRound = currentRound;
  if ((sub.budget_4a_status || '') !== 'need_revision') {
    const hasRequestInCurrentRound = !!db.prepare("SELECT 1 FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4a' AND actionType = 'budget_request_revision' AND note LIKE ? LIMIT 1")
      .get(id, '[Vòng ' + currentRound + ']%');
    if (hasRequestInCurrentRound) targetRound = currentRound + 1;
  }
  let idx = 0;
  for (const f of fList) {
    if (!f || !f.path) continue;
    const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    const newPath = path.join(baseDir, 'budget_revision_req_' + ts + '_' + idx + '_' + (storedName || '').replace(/[^a-zA-Z0-9._-]/g, '_'));
    try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'budget_revision_request_' + ts + '_' + idx, storedName, newPath, targetRound, req.user.id, role, new Date().toISOString());
    idx++;
  }
  const requestedAt = new Date().toISOString();
  const nextRound = targetRound;
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_round = ?, budget_4a_revision_note = ?, budget_4a_revision_requested_at = ?, budget_4a_revision_requested_by = ? WHERE id = ?')
    .run('need_revision', nextRound, note, requestedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_request_revision', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', '[Vòng ' + nextRound + '] ' + note);
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisionRequestEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, note, requestedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a request-revision — submission ' + id);
  return res.json({ message: 'Đã gửi yêu cầu bổ sung. Email đã gửi đến Chủ nhiệm và CC Hội đồng.', status: 'need_revision' });
});

// Bước 4A: Nghiên cứu viên (Chủ nhiệm) nộp lại tài liệu bổ sung/chỉnh sửa theo yêu cầu
router.post('/cap-vien/submissions/:id/steps/4a/upload-revised', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.budget_4a_status || '') !== 'need_revision') {
    return res.status(400).json({ message: 'Chỉ được nộp tài liệu chỉnh sửa khi Tổ thẩm định đã yêu cầu bổ sung (Bước 4A)' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được nộp tài liệu chỉnh sửa' });
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'Chủ nhiệm đề tài' : 'Admin';
  const revisedList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!revisedList.length) {
    return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 file tài liệu bổ sung/chỉnh sửa.' });
  }
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const round = sub.budget_4a_round || 1;
  const ts = Date.now();
  db.transaction(() => {
    let idx = 0;
    for (const file of revisedList) {
      const ext = path.extname(file.originalname) || '.pdf';
      const field = 'budget_revised_attachment_' + round + '_' + ts + '_' + idx;
      const storedName = 'budget_revised_attachment_' + round + '_' + ts + '_' + idx + ext;
      const newPath = path.join(baseDir, storedName);
      fs.renameSync(file.path, newPath);
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, field, file.originalname, newPath, round, req.user.id, uploaderRole, new Date().toISOString());
      idx++;
    }
  })();
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = ? WHERE id = ?')
    .run(null, id);
  insertCapVienHistory(id, '4a', 'researcher_upload_revised', req.user.id, uploaderRole, uploaderRoleLabel + ' nộp ' + revisedList.length + ' file tài liệu bổ sung/chỉnh sửa (vòng ' + round + ')');
  const councilList = getNotificationEmails();
  sendCapVienBudgetRevisedSubmittedEmail({ submissionTitle: sub.title, researcherName: req.user.fullname || req.user.email, submissionId: id, councilList });
  console.log('[API] cap-vien step 4a upload-revised — submission ' + id);
  return res.json({ message: 'Đã nộp tài liệu bổ sung/chỉnh sửa. Tổ thẩm định sẽ kiểm tra và phê duyệt hoặc yêu cầu bổ sung tiếp.' });
});

// Bước 4A: Tổ thẩm định phê duyệt dự toán
router.post('/cap-vien/submissions/:id/steps/4a/approve', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isBudgetTeam = roleIsAny(req, ['admin', 'totruong_tham_dinh_tc', 'thanh_vien_tham_dinh_tc']);
  if (!isBudgetTeam) return res.status(403).json({ message: 'Chỉ Tổ thẩm định tài chính hoặc Admin mới được phê duyệt dự toán' });
  const roundNow = sub.budget_4a_round || 1;
  const cntBudget = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh')").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const cntRevised = db.prepare("SELECT COUNT(1) AS c FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound IN (?, ?) AND fieldName LIKE 'budget_revised_attachment_%'").get(id, roundNow, roundNow === 1 ? 0 : -1);
  const hasBudgetPair = !!cntBudget && Number(cntBudget.c || 0) >= 2;
  const hasRevisedAttachments = !!cntRevised && Number(cntRevised.c || 0) > 0;
  if (!hasBudgetPair && !hasRevisedAttachments) {
    return res.status(400).json({ message: 'Chưa có tài liệu để phê duyệt ở vòng hiện tại. Vui lòng nộp hồ sơ thẩm định hoặc chờ Chủ nhiệm nộp tài liệu bổ sung.' });
  }
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = ?, budget_4a_approved_at = ?, budget_4a_approved_by = ? WHERE id = ?')
    .run('approved', approvedAt, req.user.id, id);
  insertCapVienHistory(id, '4a', 'budget_approve', req.user.id, role === 'admin' ? 'admin' : 'totruong_tham_dinh', 'Tổ thẩm định phê duyệt dự toán');
  const researcher = db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById);
  const councilList = getNotificationEmails();
  sendCapVienBudgetApprovedEmail({ submissionTitle: sub.title, researcherEmail: researcher ? researcher.email : null, researcherName: researcher ? researcher.fullname : null, approvedByName: req.user.fullname || req.user.email, submissionId: id, councilList });
  const step4Done = (() => {
    const r = db.prepare('SELECT step_4_reviewer1_done, step_4_reviewer2_done FROM cap_vien_submissions WHERE id = ?').get(id);
    return r && r.step_4_reviewer1_done && r.step_4_reviewer2_done;
  })();
  if (step4Done) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    sendCapVienStep5ReadyEmail({ submissionTitle: sub.title, submissionId: id });
  }
  console.log('[API] cap-vien step 4a approve — submission ' + id);
  return res.json({ message: 'Đã phê duyệt dự toán. Email đã gửi đến Chủ nhiệm và Hội đồng.' + (step4Done ? ' Bước 4 và 4A đều hoàn thành, đã chuyển sang Bước 5.' : ' Đang chờ Bước 4 (Phản biện) hoàn thành.'), status: 'approved', step5Ready: step4Done });
});

// Admin: Gửi lại email Bước 4 (phân công phản biện → phản biện + Hội đồng) — dùng khi đã qua bước 3→4 nhưng email chưa gửi
router.post('/cap-vien/submissions/:id/send-step4-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, assignedReviewerIds, assignedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ gửi được email Bước 4 khi hồ sơ đã qua Bước 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  let reviewerIds = [];
  try { reviewerIds = JSON.parse(sub.assignedReviewerIds || '[]'); } catch (e) {}
  if (reviewerIds.length < 2) return res.status(400).json({ message: 'Hồ sơ chưa có đủ 2 phản biện được phân công' });
  const chairmanRow = sub.assignedById ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(sub.assignedById) : null;
  const chairmanName = (chairmanRow && (chairmanRow.fullname || chairmanRow.email)) || 'Chủ tịch';
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds);
  const reviewerEmails = reviewers.map(r => r.email).filter(Boolean);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendCapVienStep3AssignEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, id);
  console.log('[API] cap-vien admin send-step4-email — submission ' + id);
  return res.json({ message: 'Đã gửi email Bước 4 đến các phản biện và Hội đồng.' });
});

// Admin: Gửi lại email Bước 4A (thông báo Tổ thẩm định tài chính, CC Hội đồng) — dùng khi đã qua bước 3→4 nhưng email chưa gửi
router.post('/cap-vien/submissions/:id/send-step4a-email', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['ASSIGNED', 'UNDER_REVIEW', 'REVIEWED'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ gửi được email Bước 4A khi hồ sơ đã qua Bước 3 (ASSIGNED/UNDER_REVIEW/REVIEWED)' });
  }
  sendCapVienStep4aNotifyBudgetTeamEmail({ submissionTitle: sub.title, submissionId: id });
  console.log('[API] cap-vien admin send-step4a-email — submission ' + id);
  return res.json({ message: 'Đã gửi email Bước 4A đến Tổ thẩm định tài chính (CC Hội đồng).' });
});

return router;
};
