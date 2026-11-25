'use strict';

/**
 * Đề tài cấp Viện — đưa về bước trước, reset bước (dev), nộp lại/bổ sung,
 * tải file/hồ sơ và xóa hồ sơ (8 endpoint).
 *
 *   POST   /api/cap-vien/submissions/:id/revert-to-step-2
 *   POST   /api/cap-vien/submissions/:id/revert-to-step/:step
 *   POST   /api/cap-vien/submissions/:id/dev-reset-step/:step
 *   POST   /api/cap-vien/submissions/:id/resubmit
 *   POST   /api/cap-vien/submissions/:id/supplement
 *   GET    /api/cap-vien/submissions/:id/download
 *   GET    /api/cap-vien/submissions/:id/files/:fileId/download
 *   DELETE /api/cap-vien/submissions/:id
 *
 * Tách khỏi server.js (Đợt 4.9 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createCapVienBoSungTaiVaXoaRouter({
  db,
  authMiddleware,
  adminOnly,
  uploadCapVien,
  uploadDirCapVien,
  insertCapVienStep2History,
  safeUnlinkCapVienStoredFile,
  sanitizeFolderName,
  fixFilenameEncoding,
  sendCapVienSupplementSubmittedEmail,
  capVienRoleSeesAllSubmissions,
  prepareDownloadFileList,
  safeDownload,
  deleteCapVienSubmissionCascade,
}) {
const router = express.Router();

// Admin đưa hồ sơ về Bước 2 (route riêng để đảm bảo revert luôn hoạt động)
router.post('/cap-vien/submissions/:id/revert-to-step-2', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về Bước 2 (kiểm tra lại)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const currentStatus = sub.status || 'SUBMITTED';
  if (currentStatus === 'SUBMITTED') {
    return res.status(400).json({ message: 'Hồ sơ đang ở Bước 2, không cần đưa về' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?')
    .run('SUBMITTED', id);
  insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2 để kiểm tra lại');
  console.log('[API] cap-vien revert-to-step-2 — submission ' + id);
  return res.json({ message: 'Đã đưa hồ sơ về Bước 2. Thư ký có thể nhấn Hợp lệ hoặc Yêu cầu bổ sung lại.', status: 'SUBMITTED' });
});

// Admin đưa hồ sơ về bước trước (3, 4, 5, 6, 7) — nút "Đưa về Bước N (Admin)"
router.post('/cap-vien/submissions/:id/revert-to-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const step = parseInt(req.params.step, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  if (isNaN(step) || step < 2 || step > 7) return res.status(400).json({ message: 'Bước phải từ 2 đến 7' });
  const roleLower = (req.user.role || '').toLowerCase();
  if (roleLower !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được đưa hồ sơ về bước trước đó' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });

  if (step === 2) {
    db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL WHERE id = ?').run('SUBMITTED', id);
    insertCapVienStep2History(id, 'admin_revert', req.user.id, 'admin', 'Admin đưa hồ sơ về Bước 2');
    return res.json({ message: 'Đã đưa hồ sơ về Bước 2.', status: 'SUBMITTED' });
  }

  const clearStep4And4a = () => {
    db.prepare('UPDATE cap_vien_submissions SET step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL WHERE id = ?').run(id);
  };

  if (step === 3) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('VALIDATED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 3 — submission ' + id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 3 (Phân công phản biện).', status: 'VALIDATED' });
  }

  if (step === 4) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('ASSIGNED', id);
    clearStep4And4a();
    console.log('[API] cap-vien revert-to-step 4 — submission ' + id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 4 & 4A.', status: 'ASSIGNED' });
  }

  if (step === 5) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('REVIEWED', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 5 (Họp Hội đồng).', status: 'REVIEWED' });
  }

  if (step === 6) {
    db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 6 (Cấp Quyết định).', status: 'CONDITIONAL' });
  }

  if (step === 7) {
    db.prepare(`UPDATE cap_vien_submissions SET status = ?, step8_completed = 0, step8_waived = 0,
      step8a_completed = 0, step8a_waived = 0 WHERE id = ?`).run('APPROVED', id);
    return res.json({ message: 'Đã đưa hồ sơ về Bước 7 (Ký hợp đồng).', status: 'APPROVED' });
  }

  return res.status(400).json({ message: 'Bước không hợp lệ' });
});

// Dev-only tiện ích: reset Bước 2 / 3 / 4 / 4A / 5 về trạng thái ban đầu
router.post('/cap-vien/submissions/:id/dev-reset-step/:step', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const stepKey = String(req.params.step || '').toLowerCase();
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  if (!['2', '3', '4', '4a', '5'].includes(stepKey)) return res.status(400).json({ message: 'Chỉ hỗ trợ reset bước 2, 3, 4, 4A hoặc 5' });
  if ((req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được reset bước (dev)' });
  }
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });

  if (stepKey === '2') {
    db.transaction(() => {
      db.prepare('UPDATE cap_vien_submissions SET status = ?, reviewNote = NULL, reviewedAt = NULL, reviewedById = NULL, assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL WHERE id = ?')
        .run('SUBMITTED', id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId IN ('2','3','4','4a')").run(id);
      db.prepare('DELETE FROM cap_vien_step2_history WHERE submissionId = ?').run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND COALESCE(revisionRound, 0) > 0").run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName IN ('reviewer_phieu_1','reviewer_phieu_2')").run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND (fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh') OR fieldName LIKE 'budget_revision_request_%')").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId IN ('2','3','4','4a')").run(id);
    })();
    return res.json({ message: 'Đã reset Bước 2 (và dọn dữ liệu thử Bước 3–4–4A). Hồ sơ về SUBMITTED, chờ Thư ký kiểm tra lại.', status: 'SUBMITTED' });
  }

  if (stepKey === '3') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '3'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'Đã reset Bước 3 về trạng thái ban đầu (chờ phân công phản biện).', status: 'VALIDATED' });
  }

  if (stepKey === '4') {
    db.transaction(() => {
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName IN ('reviewer_phieu_1','reviewer_phieu_2')").run(id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '4'").run(id);
      db.prepare('UPDATE cap_vien_submissions SET assignedReviewerIds = NULL, assignedAt = NULL, assignedById = NULL, step_4_reviewer1_done = 0, step_4_reviewer2_done = 0, status = ? WHERE id = ?')
        .run('VALIDATED', id);
    })();
    return res.json({ message: 'Đã reset Bước 4 về trạng thái ban đầu (chờ phân công phản biện).', status: 'VALIDATED' });
  }

  if (stepKey === '5') {
    const step5MinutesField = 'step5_bien_ban_hop_hd';
    const rows = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').all(id, step5MinutesField);
    const extraRows = db.prepare("SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_hd_extra_%'").all(id);
    const revRows = db.prepare("SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_council_revision_f_%'").all(id);
    const st = String(sub.status || '').toUpperCase();
    const newStatus = (st === 'IN_MEETING' || st === 'CONDITIONAL') ? 'REVIEWED' : (sub.status || 'SUBMITTED');
    db.transaction(() => {
      rows.forEach((r) => {
        if (r.path) safeUnlinkCapVienStoredFile(r.path);
      });
      extraRows.forEach((r) => {
        if (r.path) safeUnlinkCapVienStoredFile(r.path);
      });
      revRows.forEach((r) => {
        if (r.path) safeUnlinkCapVienStoredFile(r.path);
      });
      db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, step5MinutesField);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_hd_extra_%'").run(id);
      db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName LIKE 'step5_council_revision_f_%'").run(id);
      db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '5'").run(id);
      db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '5'").run(id);
      db.prepare(`UPDATE cap_vien_submissions SET
        step5_hd_meeting_location = NULL,
        step5_hd_meeting_attendance = NULL,
        step5_hd_meeting_documents = NULL,
        step5_hd_meeting_vote_result = NULL,
        step5_hd_meeting_decision = NULL,
        step5_hd_meeting_event_time = NULL,
        step5_hd_meeting_updated_at = NULL,
        step5_hd_meeting_updated_by = NULL,
        step5_council_revision_status = NULL,
        step5_council_revision_round = 0,
        step5_council_revision_note = NULL,
        step5_council_revision_requested_at = NULL,
        step5_council_revision_requested_by = NULL,
        status = ?
      WHERE id = ?`).run(newStatus, id);
    })();
    return res.json({
      message: 'Đã reset Bước 5: xóa thông tin họp, biên bản, lịch sử & deadline bước 5.',
      status: newStatus
    });
  }

  db.transaction(() => {
    db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND (fieldName IN ('budget_phieu_tham_dinh','budget_to_trinh') OR fieldName LIKE 'budget_revision_request_%')").run(id);
    db.prepare("DELETE FROM cap_vien_submission_history WHERE submissionId = ? AND stepId = '4a'").run(id);
    db.prepare("DELETE FROM cap_vien_step_deadlines WHERE submissionId = ? AND stepId = '4a'").run(id);
    db.prepare('UPDATE cap_vien_submissions SET budget_4a_status = NULL, budget_4a_round = 1, budget_4a_revision_note = NULL, budget_4a_revision_requested_at = NULL, budget_4a_revision_requested_by = NULL, budget_4a_approved_at = NULL, budget_4a_approved_by = NULL, status = ? WHERE id = ?')
      .run('ASSIGNED', id);
  })();
  return res.json({ message: 'Đã reset Bước 4A về trạng thái ban đầu (thẩm định lại từ đầu).', status: 'ASSIGNED' });
});

// Nghiên cứu viên nộp lại hồ sơ sau khi Thư ký yêu cầu bổ sung (Bước 2) — chỉ cập nhật trạng thái (không file). Nếu có file bổ sung thì dùng POST /supplement.
router.post('/cap-vien/submissions/:id/resubmit', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chỉ được nộp lại khi Thư ký đã yêu cầu bổ sung (trạng thái Cần bổ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ chủ nhiệm đề tài hoặc Admin mới được nộp lại hồ sơ' });
  }
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_resubmit', req.user.id, 'researcher', 'Nghiên cứu viên nộp lại hồ sơ (không file bổ sung)');
  console.log('[API] cap-vien resubmit — submission ' + id);
  return res.json({ message: 'Đã ghi nhận nộp lại hồ sơ. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.', status: 'SUBMITTED' });
});

// Nộp hồ sơ bổ sung (Bước 2 — vẫn trong quy trình Bước 2): upload file(s), lưu bên dưới hồ sơ gốc (revisionRound tăng), chuyển status về SUBMITTED
router.post('/cap-vien/submissions/:id/supplement', authMiddleware, (req, res, next) => {
  uploadCapVien.array('supplement', 20)(req, res, (err) => {
    if (err) {
      req.files = [];
      req._uploadDirCapVien = null;
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '') !== 'NEED_REVISION') {
    return res.status(400).json({ message: 'Chỉ được nộp hồ sơ bổ sung khi Thư ký đã yêu cầu bổ sung (trạng thái Cần bổ sung)' });
  }
  const isOwner = sub.submittedById === req.user.id;
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ chủ nhiệm đề tài hoặc Admin mới được nộp hồ sơ bổ sung' });
  }
  const uploadedFiles = req.files && Array.isArray(req.files) ? req.files : [];
  const nextRound = (db.prepare('SELECT COALESCE(MAX(revisionRound), 0) + 1 AS r FROM cap_vien_submission_files WHERE submissionId = ?').get(id) || {}).r || 1;
  let submissionDir = null;
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  if (firstExisting && firstExisting.path) submissionDir = path.dirname(firstExisting.path);
  if (!submissionDir && uploadedFiles.length > 0) {
    const researcherFolder = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]) + '_' + req.user.id;
    submissionDir = path.join(uploadDirCapVien, researcherFolder, 'submission_' + id);
    fs.mkdirSync(submissionDir, { recursive: true });
  }
  const move = (f, index) => {
    if (!f || !f.path) return;
    const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    const newPath = path.join(submissionDir, 'supplement_' + nextRound + '_' + index + '_' + (storedName || '').replace(/[^a-zA-Z0-9._-]/g, '_'));
    try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'supplement_' + index, storedName, newPath, nextRound);
  };
  uploadedFiles.forEach((f, i) => move(f, i));
  const tempDir = req._uploadDirCapVien;
  if (tempDir && fs.existsSync(tempDir)) { try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {} }
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('SUBMITTED', id);
  insertCapVienStep2History(id, 'researcher_supplement', req.user.id, 'researcher', uploadedFiles.length > 0 ? `Nộp hồ sơ bổ sung lần ${nextRound} (${uploadedFiles.length} file)` : 'Nộp hồ sơ bổ sung');
  const row = db.prepare('SELECT submittedBy, submittedById, createdAt FROM cap_vien_submissions WHERE id = ?').get(id);
  const u = row && row.submittedById ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById) : null;
  sendCapVienSupplementSubmittedEmail({
    submissionTitle: sub.title,
    submittedByEmail: (row && row.submittedBy) || null,
    submittedByName: u ? u.fullname : null,
    createdAt: row ? row.createdAt : null,
    status: 'SUBMITTED',
    supplementRound: nextRound
  });
  console.log('[API] cap-vien supplement — submission ' + id + ', round ' + nextRound + ', files: ' + uploadedFiles.length);
  return res.json({
    message: uploadedFiles.length > 0
      ? 'Đã ghi nhận hồ sơ bổ sung (lần ' + nextRound + '). Quá trình vẫn ở Bước 2. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.'
      : 'Đã ghi nhận. Thư ký sẽ kiểm tra và nhấn Hợp lệ hoặc Yêu cầu bổ sung.',
    status: 'SUBMITTED',
    supplementRound: nextRound,
    filesCount: uploadedFiles.length
  });
});

router.get('/cap-vien/submissions/:id/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ này' });
  }
  const files = db.prepare('SELECT path, originalName FROM cap_vien_submission_files WHERE submissionId = ?').all(id);
  if (files.length === 0) return res.status(404).json({ message: 'Không tìm thấy file hồ sơ' });
  const preparedCv = prepareDownloadFileList(res, files);
  if (!preparedCv) return;
  if (preparedCv.length === 1) return res.download(preparedCv[0].norm, preparedCv[0].originalName);
  try {
    const archiver = require('archiver');
    res.attachment('ho-so-cap-vien-' + id + '.zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);
    preparedCv.forEach((p) => archive.file(p.norm, { name: p.originalName }));
    archive.finalize();
  } catch (e) {
    return res.download(preparedCv[0].norm, preparedCv[0].originalName);
  }
});

router.get('/cap-vien/submissions/:id/files/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const sub = db.prepare('SELECT id, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = sub.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) return res.status(403).json({ message: 'Bạn không có quyền tải file này' });
  const file = db.prepare('SELECT id, path, originalName FROM cap_vien_submission_files WHERE id = ? AND submissionId = ?').get(fileId, id);
  if (!file || !file.path) return res.status(404).json({ message: 'Không tìm thấy file' });
  return safeDownload(res, file.path, file.originalName);
});

router.delete('/cap-vien/submissions/:id', authMiddleware, adminOnly, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  try {
    deleteCapVienSubmissionCascade(id);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'INVALID_CAP_VIEN_SUBMISSION_ID') return res.status(400).json({ message: 'ID hồ sơ không hợp lệ.' });
    if (msg === 'CAP_VIEN_SUBMISSION_NOT_FOUND') return res.status(404).json({ message: 'Không tìm thấy hồ sơ.' });
    console.error('[cap-vien/submissions DELETE]', msg || e);
    return res.status(500).json({ message: 'Không thể xóa hồ sơ. ' + msg });
  }
  return res.json({ message: 'Đã xóa hồ sơ đề tài cấp Viện và dữ liệu liên quan (dashboard, tiến trình, file).' });
});

return router;
};
