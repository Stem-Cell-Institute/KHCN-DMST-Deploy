'use strict';

/**
 * Hồ sơ SCI-ACE (Hội đồng Đạo đức) — GĐ6 & GĐ7: chấp thuận có điều kiện, kết quả họp,
 * cấp Quyết định, báo cáo định kỳ và báo cáo kết thúc (7 endpoint).
 *
 *   POST /api/submissions/:id/conditional-submit
 *   PUT  /api/submissions/:id/conditional-approve
 *   PUT  /api/submissions/:id/conditional-reject
 *   PUT  /api/submissions/:id/meeting-result
 *   PUT  /api/submissions/:id/issue-decision
 *   POST /api/submissions/:id/report-periodic
 *   POST /api/submissions/:id/report-final
 *
 * Tách khỏi server.js (Đợt 3.2 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint: đường dẫn, tham số, mã trạng thái, thông báo lỗi. Không sửa một dòng
 * logic nào — chỉ cắt–dán và đổi `app.` thành `router.` (mount ở '/api').
 *
 * Lưới an toàn: tests/submissions.test.js (xem readme/REFACTOR-PROGRESS.md).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSubmissionsNghiemThuVaQuyetDinhRouter({
  db,
  authMiddleware,
  upload,
  uploadDir,
  fixFilenameEncoding,
  insertGd5History,
  sendConditionalSubmitEmail,
  roleIsAny,
  sendConditionalRejectEmail,
  sendMeetingResultEmail,
  PORT,
  sendDecisionIssuedEmail,
}) {
const router = express.Router();

// Chấp thuận có điều kiện: NCV nộp SCI-ACE-04
router.post('/submissions/:id/conditional-submit', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể nộp SCI-ACE-04 khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp SCI-ACE-04' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file SCI-ACE-04 (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const rawName = file.originalname || '';
  const originalName = fixFilenameEncoding(rawName) || 'sci-ace-04-' + id + ext;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const finalPath = path.join(finalDir, 'conditional_sci_ace_04' + ext);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").get(id);
  if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  const uploadedAt = new Date().toISOString();
  db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(id);
  db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'conditional_sci_ace_04', ?, ?, ?)")
    .run(id, originalName, finalPath, uploadedAt);
  db.prepare('UPDATE submissions SET conditionalSubmittedAt = ?, conditionalSubmittedById = ? WHERE id = ?')
    .run(uploadedAt, req.user.id, id);
  insertGd5History(id, 'conditional_upload', req.user.id, 'conditional_sci_ace_04', originalName, 'NCV nộp SCI-ACE-04');
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  const subForEmail = db.prepare('SELECT title FROM submissions WHERE id = ?').get(id);
  const performerName = (req.user.fullname || req.user.email || 'Nghiên cứu viên').toString();
  sendConditionalSubmitEmail(subForEmail ? subForEmail.title : 'Hồ sơ #' + id, performerName, id);
  console.log('[API] POST /api/submissions/' + id + '/conditional-submit — NCV đã nộp SCI-ACE-04');
  return res.json({ message: 'Đã nộp SCI-ACE-04. Chủ tịch Hội đồng sẽ xem xét và thông qua.' });
});

// Chấp thuận có điều kiện: Chủ tịch thông qua sau khi NCV đã nộp SCI-ACE-04
router.put('/submissions/:id/conditional-approve', authMiddleware, (req, res) => {
  const role = req.user.role;
  if (!roleIsAny(req, ['admin', 'chu_tich'])) {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được thông qua' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, conditionalSubmittedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể thông qua khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  if (!sub.conditionalSubmittedAt) {
    return res.status(400).json({ message: 'Nghiên cứu viên chưa nộp SCI-ACE-04. Vui lòng chờ NCV nộp trước khi thông qua.' });
  }
  const approvedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, conditionalApprovedAt = ?, conditionalApprovedById = ? WHERE id = ?')
    .run('APPROVED', approvedAt, req.user.id, id);
  insertGd5History(id, 'conditional_approve', req.user.id, null, null, 'Chủ tịch thông qua');
  console.log('[API] PUT /api/submissions/' + id + '/conditional-approve — Chủ tịch đã thông qua');
  return res.json({ message: 'Đã thông qua. Hồ sơ chuyển sang giai đoạn Cấp Quyết định.' });
});

// Chấp thuận có điều kiện: Chủ tịch không thông qua → gửi email NCV + Hội đồng, xóa bản nộp để NCV nộp lại
router.put('/submissions/:id/conditional-reject', authMiddleware, (req, res) => {
  const role = req.user.role;
  if (!roleIsAny(req, ['admin', 'chu_tich'])) {
    return res.status(403).json({ message: 'Chỉ Chủ tịch Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy, conditionalSubmittedAt FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'CONDITIONAL') {
    return res.status(400).json({ message: 'Chỉ có thể không thông qua khi hồ sơ ở trạng thái Chấp thuận có điều kiện' });
  }
  if (!sub.conditionalSubmittedAt) {
    return res.status(400).json({ message: 'Chưa có bản giải trình nào để xem xét.' });
  }
  const fileRow = db.prepare("SELECT id, path, originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").get(id);
  if (fileRow && fileRow.path && fs.existsSync(fileRow.path)) {
    const versionCount = db.prepare("SELECT COUNT(*) as c FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'conditional_sci_ace_04_v%'").get(id);
    const nextVer = (versionCount.c || 0) + 1;
    const newFieldName = 'conditional_sci_ace_04_v' + nextVer;
    const ext = path.extname(fileRow.path) || '.pdf';
    const newPath = path.join(path.dirname(fileRow.path), newFieldName + ext);
    try { fs.renameSync(fileRow.path, newPath); } catch (_) {
      try { fs.copyFileSync(fileRow.path, newPath); fs.unlinkSync(fileRow.path); } catch (__) {}
    }
    db.prepare("UPDATE submission_files SET fieldName = ?, path = ? WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(newFieldName, newPath, id);
    insertGd5History(id, 'conditional_reject', req.user.id, newFieldName, fileRow.originalName, 'Chủ tịch không thông qua (lần ' + nextVer + ')');
  } else {
    db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'").run(id);
    insertGd5History(id, 'conditional_reject', req.user.id, null, null, 'Chủ tịch không thông qua');
  }
  db.prepare('UPDATE submissions SET conditionalSubmittedAt = NULL, conditionalSubmittedById = NULL WHERE id = ?').run(id);
  const chairmanName = (req.user.fullname || req.user.email || 'Chủ tịch').toString();
  sendConditionalRejectEmail(sub.title, sub.submittedBy, chairmanName);
  console.log('[API] PUT /api/submissions/' + id + '/conditional-reject — Chủ tịch chưa thông qua');
  return res.json({ message: 'Đã gửi thông báo đến NCV và Hội đồng. NCV cần nộp lại SCI-ACE-04.' });
});

// GĐ5 (Họp Hội đồng): Thư ký upload biên bản + chọn kết luận (Chấp thuận / Có điều kiện / Không chấp thuận)
router.put('/submissions/:id/meeting-result', authMiddleware, upload.single('file'), (req, res) => {
  const role = req.user.role;
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được thực hiện thao tác này' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IN_MEETING') {
    return res.status(400).json({ message: 'Chỉ có thể ghi nhận kết quả họp khi hồ sơ đang ở giai đoạn Họp Hội đồng' });
  }
  const decision = (req.body.decision || '').toLowerCase();
  if (!['approved', 'conditional', 'rejected'].includes(decision)) {
    return res.status(400).json({ message: 'Vui lòng chọn: Chấp thuận, Có điều kiện, hoặc Không chấp thuận' });
  }
  const note = (req.body.note || '').trim();
  const statusMap = { approved: 'APPROVED', conditional: 'CONDITIONAL', rejected: 'REJECTED' };
  const newStatus = statusMap[decision];
  const file = req.file;
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  if (file && file.path) {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase() || '.pdf';
    const rawName = file.originalname || '';
    const originalName = fixFilenameEncoding(rawName) || 'bien-ban-hop-' + id + ext;
    const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
    const finalPath = path.join(finalDir, 'meeting_minutes' + safeExt);
    try {
      fs.renameSync(file.path, finalPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(id);
    if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) {
      try { fs.unlinkSync(existing.path); } catch (_) {}
    }
    const uploadedAt = new Date().toISOString();
    db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").run(id);
    db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'meeting_minutes', ?, ?, ?)")
      .run(id, originalName, finalPath, uploadedAt);
  }
  const meetingDecisionAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, meetingNote = ?, meetingDecisionAt = ?, meetingDecisionById = ? WHERE id = ?')
    .run(newStatus, note, meetingDecisionAt, req.user.id, id);
  const meetingFile = db.prepare("SELECT fieldName, originalName FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'").get(id);
  insertGd5History(id, 'meeting_result', req.user.id, meetingFile ? 'meeting_minutes' : null, meetingFile ? meetingFile.originalName : null, newStatus === 'CONDITIONAL' ? 'Chấp thuận có điều kiện' : (newStatus === 'APPROVED' ? 'Chấp thuận' : 'Không chấp thuận'));
  const secretaryName = (req.user.fullname || req.user.email || 'Thư ký').toString();
  sendMeetingResultEmail(sub.title, sub.submittedBy || null, decision, note, secretaryName);
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
  }
  const msg = decision === 'rejected'
    ? 'Đã ghi nhận: Không chấp thuận. Email đã gửi đến nghiên cứu viên và Hội đồng.'
    : (decision === 'approved' ? 'Đã ghi nhận: Chấp thuận. Email đã gửi đến nghiên cứu viên và Hội đồng. Chuyển sang giai đoạn Cấp Quyết định.' : 'Đã ghi nhận: Chấp thuận có điều kiện. Email đã gửi đến nghiên cứu viên và Hội đồng.');
  console.log('[API] PUT /api/submissions/' + id + '/meeting-result — ' + newStatus);
  return res.json({ message: msg, status: newStatus });
});

// GĐ6 (Cấp Quyết định): Thư ký upload Quyết định VN + EN, chuyển sang IMPLEMENTATION
router.put('/submissions/:id/issue-decision', authMiddleware, upload.fields([
  { name: 'decision_vn', maxCount: 1 },
  { name: 'decision_en', maxCount: 1 }
]), (req, res) => {
  const role = req.user.role;
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký Hội đồng hoặc Admin mới được cấp Quyết định' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedBy FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'APPROVED') {
    return res.status(400).json({ message: 'Chỉ có thể cấp Quyết định khi hồ sơ đã được Hội đồng chấp thuận (trạng thái Đã phê duyệt)' });
  }
  const files = req.files || {};
  const fileVn = (files.decision_vn && files.decision_vn[0]) ? files.decision_vn[0] : null;
  const fileEn = (files.decision_en && files.decision_en[0]) ? files.decision_en[0] : null;
  if (!fileVn || !fileVn.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định tiếng Việt' });
  if (!fileEn || !fileEn.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định tiếng Anh' });
  const allowedExt = ['.pdf', '.docx', '.doc'];
  const extVn = (path.extname(fileVn.originalname || '') || '').toLowerCase();
  const extEn = (path.extname(fileEn.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(extVn)) { try { fs.unlinkSync(fileVn.path); } catch (_) {}; return res.status(400).json({ message: 'File Quyết định tiếng Việt: chỉ chấp nhận PDF hoặc Word' }); }
  if (!allowedExt.includes(extEn)) { try { fs.unlinkSync(fileEn.path); } catch (_) {}; return res.status(400).json({ message: 'File Quyết định tiếng Anh: chỉ chấp nhận PDF hoặc Word' }); }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const saveFile = (file, fieldName, defaultName) => {
    const ext = (path.extname(file.originalname || '') || '').toLowerCase() || '.pdf';
    const originalName = fixFilenameEncoding(file.originalname || '') || defaultName + ext;
    const safeExt = allowedExt.includes(ext) ? ext : '.pdf';
    const finalPath = path.join(finalDir, fieldName + safeExt);
    try { fs.renameSync(file.path, finalPath); } catch (e) {
      try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
      try { fs.unlinkSync(file.path); } catch (_) {}
    }
    const existing = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = ?').get(id, fieldName);
    if (existing && existing.path !== finalPath && fs.existsSync(existing.path)) { try { fs.unlinkSync(existing.path); } catch (_) {} }
    db.prepare('DELETE FROM submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
    db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)')
      .run(id, fieldName, originalName, finalPath, new Date().toISOString());
  };
  saveFile(fileVn, 'decision_vn', 'quyet-dinh-vn');
  saveFile(fileEn, 'decision_en', 'quyet-dinh-en');
  const issuedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, decisionIssuedAt = ?, decisionIssuedById = ? WHERE id = ?')
    .run('IMPLEMENTATION', issuedAt, req.user.id, id);
  const tempDir = req._uploadDir;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
  const trackUrl = baseUrl + '/theo-doi-ho-so.html?id=' + id;
  sendDecisionIssuedEmail(sub.title, sub.submittedBy, trackUrl);
  console.log('[API] PUT /api/submissions/' + id + '/issue-decision — Đã cấp Quyết định');
  return res.json({ message: 'Đã cấp Quyết định. Email đã gửi đến NCV và Hội đồng.', status: 'IMPLEMENTATION' });
});

// GĐ7: NCV upload báo cáo định kỳ (SCI-ACE-07 định kỳ)
router.post('/submissions/:id/report-periodic', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IMPLEMENTATION') {
    return res.status(400).json({ message: 'Chỉ có thể nộp báo cáo định kỳ khi hồ sơ đang ở giai đoạn Thực hiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp báo cáo định kỳ' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file báo cáo định kỳ (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const count = db.prepare("SELECT COUNT(*) as c FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'report_periodic_%'").get(id);
  const slot = (count.c || 0) + 1;
  const fieldName = 'report_periodic_' + slot;
  const originalName = fixFilenameEncoding(file.originalname || '') || 'bao-cao-dinh-ky-' + slot + ext;
  const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
  const finalPath = path.join(finalDir, fieldName + safeExt);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, ?, ?, ?, ?)')
    .run(id, fieldName, originalName, finalPath, new Date().toISOString());
  console.log('[API] POST /api/submissions/' + id + '/report-periodic — Đã nộp báo cáo định kỳ #' + slot);
  return res.json({ message: 'Đã nộp báo cáo định kỳ.', fieldName, slot });
});

// GĐ7: NCV upload báo cáo kết thúc (SCI-ACE-07 kết thúc) → chuyển sang COMPLETED
router.post('/submissions/:id/report-final', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, submittedById FROM submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'IMPLEMENTATION') {
    return res.status(400).json({ message: 'Chỉ có thể nộp báo cáo kết thúc khi hồ sơ đang ở giai đoạn Thực hiện' });
  }
  const isSubmitter = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSubmitter && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ nghiên cứu viên nộp hồ sơ hoặc Admin mới được nộp báo cáo kết thúc' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file báo cáo kết thúc (PDF hoặc Word)' });
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!['.pdf', '.docx', '.doc'].includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word' });
  }
  const firstFile = db.prepare('SELECT path FROM submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const finalDir = firstFile && firstFile.path ? path.dirname(firstFile.path) : path.join(uploadDir, 'submission_' + id);
  fs.mkdirSync(finalDir, { recursive: true });
  const existing = db.prepare("SELECT path FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").get(id);
  if (existing && existing.path && fs.existsSync(existing.path)) {
    try { fs.unlinkSync(existing.path); } catch (_) {}
  }
  db.prepare("DELETE FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").run(id);
  const originalName = fixFilenameEncoding(file.originalname || '') || 'bao-cao-ket-thuc.pdf';
  const safeExt = ['.pdf', '.docx', '.doc'].includes(ext) ? ext : '.pdf';
  const finalPath = path.join(finalDir, 'report_final' + safeExt);
  try { fs.renameSync(file.path, finalPath); } catch (e) {
    try { fs.copyFileSync(file.path, finalPath); } catch (_) {}
    try { fs.unlinkSync(file.path); } catch (_) {}
  }
  db.prepare("INSERT INTO submission_files (submissionId, fieldName, originalName, path, uploadedAt) VALUES (?, 'report_final', ?, ?, ?)")
    .run(id, originalName, finalPath, new Date().toISOString());
  const completedAt = new Date().toISOString();
  db.prepare('UPDATE submissions SET status = ?, completedAt = ? WHERE id = ?').run('COMPLETED', completedAt, id);
  console.log('[API] POST /api/submissions/' + id + '/report-final — Đã nộp báo cáo kết thúc, hồ sơ hoàn thành');
  return res.json({ message: 'Đã nộp báo cáo kết thúc. Hồ sơ đã hoàn thành.', status: 'COMPLETED' });
});

return router;
};
