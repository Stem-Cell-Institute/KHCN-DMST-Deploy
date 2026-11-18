'use strict';

/**
 * Hồ sơ SCI-ACE (Hội đồng Đạo đức) — nhóm cơ bản: nộp hồ sơ, danh sách, danh sách Hội đồng, chi tiết.
 *
 *   POST /api/submissions
 *   GET  /api/submissions
 *   GET  /api/users/council
 *   GET  /api/submissions/:id
 *
 * Tách khỏi server.js (Đợt 3.1 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint: đường dẫn, tham số, mã trạng thái, thông báo lỗi. Không sửa một dòng
 * logic nào — chỉ cắt–dán và đổi `app.` thành `router.` (mount ở '/api').
 *
 * Lưới an toàn: tests/submissions.test.js (xem readme/REFACTOR-PROGRESS.md).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSubmissionsHoSoCoBanRouter({
  db,
  authMiddleware,
  upload,
  uploadDir,
  sanitizeFolderName,
  fixFilenameEncoding,
  sendNotificationToCouncil,
  roleIsAny,
  usersWithAnyRole,
  ROLE_LABELS,
}) {
const router = express.Router();

// Nộp hồ sơ (upload)
router.post('/submissions', authMiddleware, upload.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đề tài / mã hồ sơ' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'Lần đầu nộp cần đủ 3 file: SCI-ACE-01, SCI-ACE-02, SCI-ACE-03' });
  }
  const run = db.transaction(() => {
    const sub = db.prepare('INSERT INTO submissions (title, submittedBy, submittedById) VALUES (?, ?, ?)').run(title, req.user.email, req.user.id);
    const subId = sub.lastInsertRowid;
    const researcherName = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]);
    const researcherFolder = researcherName + '_' + req.user.id;
    const finalDir = path.join(uploadDir, researcherFolder, 'submission_' + subId);
    fs.mkdirSync(finalDir, { recursive: true });
    const move = (f, fieldName) => {
      if (!f || !f.path) return;
      const newPath = path.join(finalDir, path.basename(f.path));
      try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
      const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
      db.prepare('INSERT INTO submission_files (submissionId, fieldName, originalName, path) VALUES (?, ?, ?, ?)').run(subId, fieldName, storedName, newPath);
    };
    move(f01, 'sci_ace_01');
    move(f02, 'sci_ace_02');
    move(f03, 'sci_ace_03');
    (files.attachments || []).forEach((f, i) => move(f, 'attachment_' + i));
    const tempDir = req._uploadDir;
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
    }
    sendNotificationToCouncil(title, req.user.email);
    return subId;
  })();
  const id = Number(run);
  return res.status(201).json({ id, message: 'Đã gửi hồ sơ thành công' });
});

// Danh sách hồ sơ: Nghiên cứu viên chỉ thấy hồ sơ của mình; Hội đồng/Admin thấy tất cả (kèm họ tên NCV)
router.get('/submissions', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache');
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  if (isCouncilOrAdmin) {
    const rows = db.prepare(`
      SELECT s.id, s.title, s.submittedBy, s.submittedById, s.createdAt, u.fullname AS submittedByName
      FROM submissions s
      LEFT JOIN users u ON s.submittedById = u.id
      ORDER BY s.createdAt DESC
    `).all();
    console.log('[API] GET /api/submissions (list) → ' + rows.length + ' hồ sơ, ids: ' + rows.map(r => r.id).join(', '));
    return res.json(rows);
  }
  if (role === 'researcher') {
    const rows = db.prepare('SELECT id, title, submittedBy, status, createdAt FROM submissions WHERE submittedById = ? ORDER BY createdAt DESC').all(req.user.id);
    return res.json(rows);
  }
  return res.status(403).json({ message: 'Bạn không có quyền xem danh sách hồ sơ' });
});

// Danh sách thành viên Hội đồng (Chủ tịch, Thư ký, Thành viên, Admin) — dùng cho form phân công GĐ4. Admin hiển thị vai trò "Ủy viên Hội đồng".
router.get('/users/council', authMiddleware, (req, res) => {
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc Admin mới xem được danh sách này' });
  const rows = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']);
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname,
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Ủy viên Hội đồng' : (ROLE_LABELS[r.role] || r.role)
  }));
  return res.json({ council });
});

// Chi tiết một hồ sơ (để trang theo dõi tiến trình): cùng quyền xem như danh sách
router.get('/submissions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  console.log('[API] GET /api/submissions/' + id + ' — request received');
  try {
  res.set('Cache-Control', 'no-store, no-cache');
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const row = db.prepare(`
    SELECT s.id, s.title, s.submittedBy, s.submittedById, s.status, s.createdAt, s.reviewNote, s.reviewedAt, s.reviewedById,
      s.assignedReviewerIds, s.assignedAt, s.assignedById, s.assignNote,
      s.meetingNote, s.meetingDecisionAt, s.meetingDecisionById,
      s.conditionalSubmittedAt, s.conditionalSubmittedById, s.conditionalApprovedAt, s.conditionalApprovedById,
      u.fullname AS submittedByName, reviewer.fullname AS reviewedByName, chairman.fullname AS assignedByName,
      meetingUser.fullname AS meetingDecisionByName,
      condSubUser.fullname AS conditionalSubmittedByName,
      condApproveUser.fullname AS conditionalApprovedByName
    FROM submissions s
    LEFT JOIN users u ON s.submittedById = u.id
    LEFT JOIN users reviewer ON s.reviewedById = reviewer.id
    LEFT JOIN users chairman ON s.assignedById = chairman.id
    LEFT JOIN users meetingUser ON s.meetingDecisionById = meetingUser.id
    LEFT JOIN users condSubUser ON s.conditionalSubmittedById = condSubUser.id
    LEFT JOIN users condApproveUser ON s.conditionalApprovedById = condApproveUser.id
    WHERE s.id = ?
  `).get(id);
  if (!row) {
    console.log('[API] GET /api/submissions/' + id + ' → 404 (không có trong DB)');
    return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  }
  const role = req.user.role;
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này' });
  }
  let assignedReviewerNames = [];
  try {
    const ids = row.assignedReviewerIds ? JSON.parse(row.assignedReviewerIds) : [];
    if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const users = db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + placeholders + ')').all(...ids);
      assignedReviewerNames = ids.map(uid => {
        const u = users.find(r => r.id === uid);
        return u ? (u.fullname || u.email || '') : '';
      });
    }
  } catch (e) { /* ignore */ }
  let gd5ReviewHistory = [];
  try {
    const ids = row.assignedReviewerIds ? JSON.parse(row.assignedReviewerIds) : [];
    const gd5Files = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName IN ('gd5_review_1','gd5_review_2')"
    ).all(id);
    const bySlot = {};
    gd5Files.forEach(f => { bySlot[f.fieldName] = f; });
    gd5ReviewHistory = [1, 2].map(slot => {
      const f = bySlot['gd5_review_' + slot];
      const reviewerName = assignedReviewerNames && assignedReviewerNames[slot - 1] ? assignedReviewerNames[slot - 1] : 'Phản biện ' + slot;
      return {
        slot,
        reviewerName,
        originalName: f ? f.originalName : null,
        uploadedAt: f ? f.uploadedAt : null
      };
    });
  } catch (e) { /* ignore */ }
  const submissionFiles = db.prepare(
    `SELECT fieldName, originalName FROM submission_files WHERE submissionId = ? 
     AND fieldName NOT IN ('gd5_review_1','gd5_review_2','meeting_minutes','conditional_sci_ace_04','decision_vn','decision_en') 
     AND fieldName NOT LIKE 'report_periodic_%' AND fieldName <> 'report_final' 
     ORDER BY fieldName`
  ).all(id);
  const meetingMinutesFile = db.prepare(
    "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'meeting_minutes'"
  ).get(id);
  const conditionalFile = db.prepare(
    "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'conditional_sci_ace_04'"
  ).get(id);
  let decisionIssuedAt = null;
  let decisionVnFile = null;
  let decisionEnFile = null;
  try {
    const decRow = db.prepare('SELECT decisionIssuedAt FROM submissions WHERE id = ?').get(id);
    if (decRow) decisionIssuedAt = decRow.decisionIssuedAt;
    decisionVnFile = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'decision_vn'"
    ).get(id);
    decisionEnFile = db.prepare(
      "SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'decision_en'"
    ).get(id);
  } catch (e) { /* decision columns/files might not exist yet */ }
  let gd5History = [];
  try {
    gd5History = db.prepare(
      'SELECT id, actionType, performedAt, performedByName, fileFieldName, originalFileName, label FROM submission_gd5_history WHERE submissionId = ? ORDER BY performedAt ASC'
    ).all(id);
  } catch (e) { /* table might not exist yet */ }
  const status = row.status || 'SUBMITTED';
  return res.json({
    id: row.id,
    title: row.title,
    submittedBy: row.submittedBy,
    submittedByName: row.submittedByName || null,
    status,
    createdAt: row.createdAt,
    reviewNote: row.reviewNote || null,
    reviewedAt: row.reviewedAt || null,
    reviewedByName: row.reviewedByName || null,
    assignedReviewerIds: row.assignedReviewerIds || null,
    assignedAt: row.assignedAt || null,
    assignedById: row.assignedById || null,
    assignedByName: row.assignedByName || null,
    assignNote: row.assignNote || null,
    assignedReviewerNames: assignedReviewerNames.length ? assignedReviewerNames : null,
    gd5ReviewHistory,
    submissionFiles,
    meetingNote: row.meetingNote || null,
    meetingDecisionAt: row.meetingDecisionAt || null,
    meetingDecisionByName: row.meetingDecisionByName || null,
    meetingMinutes: meetingMinutesFile ? { originalName: meetingMinutesFile.originalName, uploadedAt: meetingMinutesFile.uploadedAt } : null,
    conditionalSubmittedAt: row.conditionalSubmittedAt || null,
    conditionalSubmittedByName: row.conditionalSubmittedByName || null,
    conditionalApprovedAt: row.conditionalApprovedAt || null,
    conditionalApprovedByName: row.conditionalApprovedByName || null,
    conditionalFile: conditionalFile ? { originalName: conditionalFile.originalName, uploadedAt: conditionalFile.uploadedAt } : null,
    decisionVn: decisionVnFile ? { originalName: decisionVnFile.originalName, uploadedAt: decisionVnFile.uploadedAt } : null,
    decisionEn: decisionEnFile ? { originalName: decisionEnFile.originalName, uploadedAt: decisionEnFile.uploadedAt } : null,
    decisionIssuedAt: decisionIssuedAt || null,
    gd5History: gd5History || [],
    reportPeriodicFiles: (() => { try { return db.prepare("SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName LIKE 'report_periodic_%' ORDER BY fieldName").all(id); } catch (e) { return []; } })(),
    reportFinalFile: (() => { try { return db.prepare("SELECT fieldName, originalName, uploadedAt FROM submission_files WHERE submissionId = ? AND fieldName = 'report_final'").get(id) || null; } catch (e) { return null; } })(),
    completedAt: (() => { try { const r = db.prepare('SELECT completedAt FROM submissions WHERE id = ?').get(id); return r ? r.completedAt : null; } catch (e) { return null; } })()
  });
  } catch (err) {
    console.error('[API] GET /api/submissions/' + (req.params.id) + ' error:', err);
    return res.status(500).json({ message: 'Lỗi máy chủ: ' + (err.message || 'Không xác định') });
  }
});

return router;
};
