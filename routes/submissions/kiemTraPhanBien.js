'use strict';

/**
 * Hồ sơ SCI-ACE (Hội đồng Đạo đức) — tải file, GĐ3 (kiểm tra/nộp lại), GĐ4 (phân công/reset),
 * GĐ5 (file phản biện) và tải/xóa hồ sơ (10 endpoint).
 *
 *   GET    /api/submissions/:id/file/:fieldName
 *   PUT    /api/submissions/:id/review
 *   POST   /api/submissions/:id/resubmit
 *   PUT    /api/submissions/:id/assign-reviewers
 *   PUT    /api/submissions/:id/reset-gd4
 *   GET    /api/submissions/:id/review-files
 *   GET    /api/submissions/:id/review-file/:slot
 *   POST   /api/submissions/:id/review-upload
 *   GET    /api/submissions/:id/download
 *   DELETE /api/submissions/:id
 *
 * Tách khỏi server.js (Đợt 3.3 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint: đường dẫn, tham số, mã trạng thái, thông báo lỗi. Không sửa một dòng
 * logic nào — chỉ cắt–dán và đổi `app.` thành `router.` (mount ở '/api').
 *
 * Lưới an toàn: tests/submissions.test.js (xem readme/REFACTOR-PROGRESS.md).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSubmissionsKiemTraPhanBienRouter({
  db,
  authMiddleware,
  adminOnly,
  upload,
  uploadDir,
  roleIsAny,
  usersWithAnyRole,
  safeDownload,
  prepareDownloadFileList,
  resolveGdSubmissionDirForRmSync,
  fixFilenameEncoding,
  insertGd5History,
  sendStage3ResultEmail,
  sendResubmitEmail,
  sendStage4AssignmentEmail,
}) {
const router = express.Router();

// Tải một file trong hồ sơ (theo fieldName): Hội đồng/Admin hoặc chủ hồ sơ
router.get('/submissions/:id/file/:fieldName', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fieldName = (req.params.fieldName || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!id || !fieldName) return res.status(400).json({ message: 'Tham số không hợp lệ' });
  const sub = db.prepare('SELECT id, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file này' });
  }
  const row = db.prepare('SELECT path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = ?').get(id, fieldName);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  return safeDownload(res, row.path, row.originalName || fieldName);
});

// Thư ký Hội đồng xử lý GĐ3 (kiểm tra hồ sơ): pass / reject / need_supplement / need_revision
router.put('/submissions/:id/review', authMiddleware, (req, res) => {
  console.log('[API] PUT /api/submissions/' + req.params.id + '/review');
  const role = req.user.role;
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedBy, status FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || 'SUBMITTED') !== 'SUBMITTED') {
    return res.status(400).json({ message: 'Hồ sơ này đã được xử lý tại GĐ3 trước đó' });
  }
  const { decision, comment } = req.body || {};
  const valid = ['pass', 'reject', 'need_supplement', 'need_revision'];
  if (!decision || !valid.includes(decision)) {
    return res.status(400).json({ message: 'Vui lòng chọn: pass, reject, need_supplement hoặc need_revision' });
  }
  const statusMap = { pass: 'VALIDATED', reject: 'REJECTED', need_supplement: 'NEED_REVISION', need_revision: 'NEED_REVISION' };
  const newStatus = statusMap[decision];
  const reviewedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, reviewNote = ?, reviewedAt = ?, reviewedById = ? WHERE id = ?')
    .run(newStatus, (comment || '').trim(), reviewedAt, req.user.id, id);
  const reviewerName = (req.user.fullname || req.user.email || 'Thư ký').toString();
  sendStage3ResultEmail(sub.title, sub.submittedBy, decision, (comment || '').trim(), reviewerName);
  return res.json({ message: 'Đã cập nhật kết quả kiểm tra. Email đã gửi đến nghiên cứu viên và Hội đồng.', status: newStatus });
});

// GĐ3: Nghiên cứu viên nộp lại hồ sơ sau khi Thư ký yêu cầu bổ sung (NEED_REVISION) — có thể thay file SCI-ACE-01/02/03, quay lại SUBMITTED để Thư ký kiểm tra lại
router.post('/submissions/:id/resubmit', authMiddleware, upload.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 }
]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedBy, submittedById, status FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chỉ có thể nộp lại khi hồ sơ đang ở trạng thái Cần bổ sung' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp lại' });
  }
  const files = req.files || {};
  const allowedExt = ['.pdf', '.docx', '.doc'];
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const replaceFile = (fieldName, file) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (!allowedExt.includes(ext)) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      return { ok: false, fieldName };
    }
    const originalName = fixFilenameEncoding(file.originalname || '') || (fieldName + ext);
    const finalPath = path.join(finalDir, fieldName + ext);
    try { fs.renameSync(file.path, finalPath); } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    const existing = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = ?').get(id, fieldName);
    if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
      try { fs.unlinkSync(existing.path); } catch (_) {}
    }
    db.prepare('DELETE FROM submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
    db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)')
      .run(id, fieldName, originalName, finalPath, new Date().toISOString());
    return { ok: true, fieldName, originalName };
  };
  const replacedFields = [];
  for (const fieldName of ['sci_ace_01', 'sci_ace_02', 'sci_ace_03']) {
    const f = files[fieldName] && files[fieldName][0];
    if (!f || !f.path) continue;
    const result = replaceFile(fieldName, f);
    if (!result.ok) {
      return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word cho ' + fieldName.toUpperCase().replace('_', '-') });
    }
    replacedFields.push(result.originalName);
  }
  const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
  db.prepare('UPDATE submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?').run('SUBMITTED', id);
  insertGd5History(
    id,
    'resubmit',
    req.user.id,
    null,
    replacedFields.length ? replacedFields.join(', ') : null,
    note || 'Nghiên cứu viên nộp lại hồ sơ sau khi bổ sung' + (replacedFields.length ? ' (đã thay ' + replacedFields.length + ' file)' : '')
  );
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  sendResubmitEmail(sub.title, sub.submittedBy);
  console.log('[API] POST /api/submissions/' + id + '/resubmit — NCV đã nộp lại hồ sơ');
  return res.json({ message: 'Đã nộp lại hồ sơ. Thư ký sẽ kiểm tra lại.', status: 'SUBMITTED' });
});

// Chủ tịch Hội đồng phân công phản biện (GĐ4): ≥2 thành viên, lưu lịch sử, gửi email cho phản biện và toàn Hội đồng
router.put('/submissions/:id/assign-reviewers', authMiddleware, (req, res) => {
  console.log('[API] PUT /api/submissions/' + req.params.id + '/assign-reviewers');
  const role = req.user.role;
  if (!roleIsAny(req, ['admin', 'chu_tich'])) {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được phân công phản biện' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedBy, submittedById, status FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'VALIDATED') {
    return res.status(400).json({ message: 'Chỉ có thể phân công phản biện khi hồ sơ ở trạng thái Đã kiểm tra (chờ phân công)' });
  }
  let reviewerIds = req.body && req.body.reviewerIds;
  if (!Array.isArray(reviewerIds)) reviewerIds = [];
  reviewerIds = reviewerIds.map(rid => parseInt(rid, 10)).filter(rid => rid > 0);
  const uniqueIds = [...new Set(reviewerIds)];
  if (uniqueIds.length < 2) {
    return res.status(400).json({ message: 'Vui lòng chọn ít nhất 2 phản biện (thành viên Hội đồng)' });
  }
  const councilIds = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']).map((r) => r.id);
  const invalid = uniqueIds.filter(uid => !councilIds.includes(uid));
  if (invalid.length > 0) {
    return res.status(400).json({ message: 'Tất cả phản biện phải là thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên) hoặc Admin' });
  }
  // Chống xung đột lợi ích: người nộp hồ sơ không được là phản biện của chính hồ sơ mình
  if (sub.submittedById != null && uniqueIds.includes(sub.submittedById)) {
    return res.status(400).json({ message: 'Không thể chọn người nộp hồ sơ làm phản biện cho chính hồ sơ của mình (xung đột lợi ích).' });
  }
  const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
  const assignedAt = new Date().toISOString();
  db.prepare(
    'UPDATE submissions SET status = ?, assignedReviewerIds = ?, assignedAt = ?, assignedById = ?, assignNote = ? WHERE id = ?'
  ).run('UNDER_REVIEW', JSON.stringify(uniqueIds), assignedAt, req.user.id, note, id);
  const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
  const reviewers = db.prepare('SELECT id, email, fullname FROM users WHERE id IN (' + uniqueIds.map(() => '?').join(',') + ')').all(...uniqueIds);
  const reviewerEmails = reviewers.map(r => r.email);
  const reviewerNames = reviewers.map(r => r.fullname || r.email || '');
  sendStage4AssignmentEmail(sub.title, chairmanName, reviewerEmails, reviewerNames, note);
  return res.json({
    message: 'Đã phân công phản biện. Email đã gửi đến các phản biện và toàn thể Hội đồng. Giai đoạn chuyển sang GĐ5.',
    status: 'UNDER_REVIEW'
  });
});

// Admin: đưa hồ sơ về GĐ4 để Chủ tịch phân công lại phản biện (khi Chủ tịch yêu cầu điều chỉnh)
router.put('/submissions/:id/reset-gd4', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, assignedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const status = sub.status || '';
  if (status !== 'UNDER_REVIEW') {
    return res.status(400).json({ message: 'Chỉ có thể đưa về GĐ4 khi hồ sơ đang ở giai đoạn Đang đánh giá (GĐ5). Trạng thái hiện tại: ' + status });
  }
  // Dọn file phản biện GĐ5 (nếu có phản biện cũ đã nộp trước khi reset) — tránh việc phản biện MỚI được phân công sau này
  // bị tính nhầm là "đã nộp" dựa trên file rác của phản biện CŨ, khiến hệ thống tự chuyển sang GĐ6 khi thực ra chưa đủ 2 người mới nộp.
  const staleReviewFiles = db.prepare(
    "SELECT fieldName, path FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
  ).all(id);
  staleReviewFiles.forEach((f) => {
    if (f.path && fs.existsSync(f.path)) { try { fs.unlinkSync(f.path); } catch (_) {} }
  });
  db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')").run(id);
  db.prepare(
    'UPDATE submissions SET status = ?, assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, assignNote = NULL WHERE id = ?'
  ).run('VALIDATED', id);
  insertGd5History(id, 'reset_gd4', req.user.id, null, null, 'Admin đưa hồ sơ về GĐ4' + (staleReviewFiles.length ? ' (đã xóa ' + staleReviewFiles.length + ' file phản biện cũ)' : ''));
  console.log('[API] PUT /api/submissions/' + id + '/reset-gd4 — đã đưa về GĐ4, xóa ' + staleReviewFiles.length + ' file phản biện cũ');
  return res.json({
    message: 'Đã đưa hồ sơ về GĐ4. Chủ tịch Hội đồng có thể vào trang theo dõi và thực hiện lại phân công phản biện.',
    status: 'VALIDATED'
  });
});

// GĐ5: Danh sách file phản biện (2 slot) — để hiển thị / tải
router.get('/submissions/:id/review-files', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  let reviewerIdsCheck = [];
  try { reviewerIdsCheck = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const isAssignedReviewer = reviewerIdsCheck.includes(req.user.id);
  if (!isCouncilOrAdmin && !isAssignedReviewer) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc phản biện được phân công mới xem được' });
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const reviewers = reviewerIds.length
    ? db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + reviewerIds.map(() => '?').join(',') + ')').all(...reviewerIds)
    : [];
  const files = db.prepare(
    "SELECT fieldName, originalName, path FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
  ).all(id);
  const fileBySlot = {};
  files.forEach(f => { fileBySlot[f.fieldName] = f; });
  const result = [1, 2].map(slot => {
    const reviewerId = reviewerIds[slot - 1];
    const u = reviewers.find(r => r.id === reviewerId);
    const f = fileBySlot['gd5_review_' + slot];
    return {
      slot,
      reviewerId: reviewerId || null,
      reviewerName: u ? (u.fullname || u.email || '') : '—',
      originalName: f ? f.originalName : null,
      hasFile: !!f
    };
  });
  return res.json({ reviewFiles: result });
});

// GĐ5: Tải file phản biện (slot 1 hoặc 2)
router.get('/submissions/:id/review-file/:slot', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const slot = parseInt(req.params.slot, 10);
  if (!id || slot < 1 || slot > 2) return res.status(400).json({ message: 'Tham số không hợp lệ' });
  const sub = db.prepare('SELECT id, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  const isReviewerForSlot = reviewerIds[slot - 1] === req.user.id;
  if (!isCouncilOrAdmin && !isReviewerForSlot) return res.status(403).json({ message: 'Không có quyền tải file này' });
  const row = db.prepare(
    'SELECT path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = ?'
  ).get(id, 'gd5_review_' + slot);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file phản biện' });
  return safeDownload(res, row.path, row.originalName || 'phản biện ' + slot + '.pdf');
});

// GĐ5: Phản biện upload file đánh giá (PDF/docx có chữ ký hoặc bản scan)
router.post('/submissions/:id/review-upload', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, assignedReviewerIds FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'UNDER_REVIEW') {
    return res.status(400).json({ message: 'Chỉ có thể nộp file phản biện khi hồ sơ đang ở GĐ5 (Đang đánh giá)' });
  }
  let reviewerIds = [];
  try { reviewerIds = sub.assignedReviewerIds ? JSON.parse(sub.assignedReviewerIds) : []; } catch (e) {}
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  const bodySlot = req.body.slot != null ? parseInt(req.body.slot, 10) : NaN;
  const slotIndex = reviewerIds.indexOf(req.user.id);
  let slot;
  if (isAdmin && (bodySlot === 1 || bodySlot === 2)) {
    slot = bodySlot;
  } else if (slotIndex !== -1) {
    slot = slotIndex + 1;
  } else {
    return res.status(403).json({ message: 'Chỉ phản biện được phân công hoặc Admin mới được nộp file đánh giá. Admin cần chọn đúng ô slot 1 hoặc 2.' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file (PDF hoặc docx)' });
  const rawName = file.originalname || '';
  const originalName = fixFilenameEncoding(rawName) || path.basename(file.path);
  const ext = (path.extname(originalName) || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word (docx/doc)' });
  }
  const existing = db.prepare(
    'SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = ?'
  ).get(id, 'gd5_review_' + slot);
  let finalPath = file.path;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  if (firstFile && firstFile.path) {
    const finalDir = path.dirname(firstFile.path);
    const safeName = 'gd5_review_' + slot + ext;
    finalPath = path.join(finalDir, safeName);
    fs.mkdirSync(finalDir, { recursive: true });
    try {
      fs.renameSync(file.path, finalPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
  }
  if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  const uploadedAt = new Date().toISOString();
  db.prepare('DELETE FROM submission_files WHERE submissionId = ? AND fieldName = ?').run(id, 'gd5_review_' + slot);
  db.prepare(
    'INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)'
  ).run(id, 'gd5_review_' + slot, originalName, finalPath, uploadedAt);
  const bothDone = db.prepare(
    "SELECT 1 FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
  ).all(id);
  if (bothDone.length >= 2) {
    db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run('IN_MEETING', id);
    console.log('[API] Cả 2 phản biện đã nộp — chuyển hồ sơ ' + id + ' sang GĐ6 (IN_MEETING)');
  }
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
  }
  console.log('[API] POST /api/submissions/' + id + '/review-upload — slot ' + slot);
  return res.json({
    message: bothDone.length >= 2
      ? 'Đã nộp file đánh giá. Cả 2 phản biện đã nộp xong — hồ sơ chuyển sang GĐ6 (Họp Hội đồng).'
      : 'Đã nộp file đánh giá phản biện. Các thành viên Hội đồng có thể xem và tải file.',
    slot,
    originalName,
    status: bothDone.length >= 2 ? 'IN_MEETING' : undefined
  });
});

// Tải hồ sơ: Nghiên cứu viên chỉ tải được hồ sơ của mình; Hội đồng/Admin tải được mọi hồ sơ (không cho sửa)
router.get('/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db.prepare('SELECT id, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ này' });
  }
  const files = db.prepare('SELECT path, originalName FROM submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'Không tìm thấy file hồ sơ' });
  const prepared = prepareDownloadFileList(res, files);
  if (!prepared) return;
  if (prepared.length === 1) return res.download(prepared[0].norm, prepared[0].originalName);
  try {
    const archiver = require('archiver');
    res.attachment('ho-so-' + id + '.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    prepared.forEach((p) => archive.file(p.norm, { name: p.originalName }));
    archive.finalize();
  } catch (e) {
    return res.download(prepared[0].norm, prepared[0].originalName);
  }
});

// Xóa hồ sơ: chỉ Admin
router.delete('/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const files = db.prepare('SELECT path FROM submission_files WHERE submissionId = ?').all(id);
  const submissionDir = files.length > 0 ? resolveGdSubmissionDirForRmSync(id, files[0].path) : null;
  db.transaction(() => {
    db.prepare('DELETE FROM submission_files WHERE submissionId = ?').run(id);
    try { db.prepare('DELETE FROM submission_gd5_history WHERE submissionId = ?').run(id); } catch (e) { /* bảng có thể chưa tồn tại ở DB cũ */ }
    db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  })();
  if (submissionDir && fs.existsSync(submissionDir)) {
    try { fs.rmSync(submissionDir, { recursive: true }); } catch (e) { /* ignore */ }
  }
  return res.json({ message: 'Đã xóa hồ sơ' });
});

return router;
};
