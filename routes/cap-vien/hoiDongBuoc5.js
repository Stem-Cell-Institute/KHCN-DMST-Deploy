'use strict';

/**
 * Đề tài cấp Viện — Bước 5 (họp Hội đồng KHCN, biên bản, tài liệu kèm, vòng chỉnh sửa,
 * thông qua) & danh sách thành viên Hội đồng KHCN (8 endpoint).
 *
 *   PUT  /api/cap-vien/submissions/:id/steps/5/hd-meeting
 *   POST /api/cap-vien/submissions/:id/steps/5/upload-minutes
 *   POST /api/cap-vien/submissions/:id/steps/5/upload-step5-extras
 *   POST /api/cap-vien/submissions/:id/steps/5/council-request-revision
 *   POST /api/cap-vien/submissions/:id/steps/5/council-revision-upload
 *   POST /api/cap-vien/submissions/:id/steps/5/council-revision-chair
 *   POST /api/cap-vien/submissions/:id/steps/5/council-pass
 *   GET  /api/cap-vien/council
 *
 * Tách khỏi server.js (Đợt 4.5 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createCapVienHoiDongBuoc5Router({
  db,
  authMiddleware,
  roleIsAny,
  roleIs,
  uploadCapVien,
  uploadDirCapVien,
  insertCapVienHistory,
  sendCapVienStep5SecretaryActivityEmail,
  sendCapVienStep5SecretaryRevisionRequestEmail,
  sendCapVienStep5RevisionUploadedEmail,
  sendCapVienStep5ChairApprovedRevisionEmail,
  sendCapVienStep5ChairRequestMoreEmail,
  sendCapVienStep5CouncilPassedEmail,
  capVienEmailEsc,
  getNotificationEmails,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
  usersWithAnyRole,
}) {
const router = express.Router();

// Bước 5 — Thư ký HĐKHCN / Admin: cập nhật thông tin họp Hội đồng KHCN (hiển thị trên timeline)
router.put('/cap-vien/submissions/:id/steps/5/hd-meeting', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin họp.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const location = norm(b.location);
  const attendance = norm(b.attendance);
  const documents = norm(b.documents);
  const voteResult = norm(b.voteResult);
  const decision = norm(b.decision);
  const eventTime = norm(b.eventTime);
  const updatedAt = new Date().toISOString();
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_hd_meeting_location = ?,
    step5_hd_meeting_attendance = ?,
    step5_hd_meeting_documents = ?,
    step5_hd_meeting_vote_result = ?,
    step5_hd_meeting_decision = ?,
    step5_hd_meeting_event_time = ?,
    step5_hd_meeting_updated_at = ?,
    step5_hd_meeting_updated_by = ?
    WHERE id = ?`).run(location, attendance, documents, voteResult, decision, eventTime, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'hd_meeting_info_update', req.user.id, role === 'admin' ? 'admin' : 'secretary', 'Cập nhật thông tin họp HĐ KHCN', updatedAt);
  const subMeta = db.prepare('SELECT title, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  const researcherH = subMeta && subMeta.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(subMeta.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: subMeta ? subMeta.title : '',
    submissionId: id,
    subjectLine: '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Cập nhật thông tin họp HĐ KHCN — ' + (subMeta ? subMeta.title : ''),
    bodyHtml: '<p><strong>Thông tin họp Hội đồng KHCN</strong> của đề tài <strong>' + capVienEmailEsc(subMeta ? subMeta.title : '') + '</strong> đã được cập nhật trên hệ thống.</p><p>Kính mời Chủ nhiệm và các thành viên liên quan xem chi tiết tại Bước 5.</p>',
    bodyText: 'Đã cập nhật thông tin họp HĐ KHCN — ' + (subMeta ? subMeta.title : ''),
    councilList: getNotificationEmails(),
    researcherEmail: researcherH ? researcherH.email : null
  });
  return res.json({ message: 'Đã lưu thông tin họp HĐ KHCN.', updatedAt });
});

// Bước 5 — Thư ký HĐKHCN / Admin: upload biên bản họp HĐ KHCN (lưu file + lịch sử)
router.post('/cap-vien/submissions/:id/steps/5/upload-minutes', authMiddleware, (req, res, next) => {
  uploadCapVien.single('bien_ban_hop')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được nộp biên bản họp.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'Chỉ nộp biên bản khi hồ sơ đã đến Bước 5 (sau Bước 4 & 4A), hoặc đang ở trạng thái sau họp (CONDITIONAL).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file biên bản họp (PDF, Word).' });

  const step5MinutesField = 'step5_bien_ban_hop_hd';
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, step5MinutesField);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, step5MinutesField);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);

  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, 'step5_bien_ban_' + Date.now() + path.extname(storedName || '.pdf'));
  try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }

  const uploadedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'thu_ky';
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, step5MinutesField, storedName, newPath, req.user.id, roleDb, uploadedAt);

  const note = 'Upload biên bản họp HĐ KHCN: ' + storedName;
  insertCapVienHistory(id, '5', 'step5_bien_ban_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-minutes — submission ' + id);
  const researcherBb = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Đã upload biên bản họp HĐ — ' + sub.title,
    bodyHtml: '<p><strong>Biên bản họp Hội đồng KHCN</strong> (file: ' + capVienEmailEsc(storedName) + ') cho đề tài <strong>' + capVienEmailEsc(sub.title) + '</strong> đã được lưu trên hệ thống.</p>',
    bodyText: 'Đã upload biên bản họp HĐ — ' + sub.title + ' — ' + storedName,
    councilList: getNotificationEmails(),
    researcherEmail: researcherBb ? researcherBb.email : null
  });
  return res.json({ message: 'Đã lưu biên bản họp vào hồ sơ.', fileName: storedName });
});

// Bước 5 — Thư ký / Admin: upload thêm tài liệu kèm (nhận xét UV HĐ, v.v.) — không thay thế biên bản chính
router.post('/cap-vien/submissions/:id/steps/5/upload-step5-extras', authMiddleware, (req, res, next) => {
  uploadCapVien.array('step5_extra_files', 30)(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới được nộp tài liệu kèm.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  const allowedStatus = ['REVIEWED', 'IN_MEETING', 'CONDITIONAL'];
  if (!allowedStatus.includes(st)) {
    return res.status(400).json({ message: 'Chỉ nộp tài liệu khi hồ sơ đang ở Bước 5 (REVIEWED / IN_MEETING / CONDITIONAL).' });
  }
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ message: 'Vui lòng chọn ít nhất một file.' });

  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  const roleDb = role === 'admin' ? 'admin' : 'thu_ky';
  const uploadedAt = new Date().toISOString();
  const ts = Date.now();
  const savedNames = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file || !file.path) continue;
    const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
    const fieldName = 'step5_hd_extra_' + ts + '_' + i;
    const newPath = path.join(baseDir, fieldName + path.extname(storedName || '.pdf'));
    try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
    savedNames.push(storedName);
  }

  if (!savedNames.length) {
    return res.status(400).json({ message: 'Không lưu được file nào.' });
  }
  const note = 'Tài liệu kèm Bước 5: ' + savedNames.join(', ');
  insertCapVienHistory(id, '5', 'step5_extra_file_upload', req.user.id, roleDb, note, uploadedAt);
  console.log('[API] cap-vien step 5 upload-step5-extras — submission ' + id + ', count ' + savedNames.length);
  const researcherEx = sub.submittedById ? db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryActivityEmail({
    submissionTitle: sub.title,
    submissionId: id,
    subjectLine: '[Đề tài cấp Viện Tế bào gốc]: Bước 5 — Tài liệu kèm mới (' + savedNames.length + ') — ' + sub.title,
    bodyHtml: '<p>Đã bổ sung <strong>' + savedNames.length + '</strong> tài liệu kèm tại Bước 5 cho đề tài <strong>' + capVienEmailEsc(sub.title) + '</strong>: ' + capVienEmailEsc(savedNames.join(', ')) + '.</p>',
    bodyText: 'Tài liệu kèm Bước 5 — ' + sub.title + ': ' + savedNames.join(', '),
    councilList: getNotificationEmails(),
    researcherEmail: researcherEx ? researcherEx.email : null
  });
  return res.json({ message: 'Đã lưu ' + savedNames.length + ' tài liệu kèm.', fileNames: savedNames });
});

// Bước 5 — Thư ký / Admin: yêu cầu Chủ nhiệm chỉnh sửa theo góp ý Hội đồng (mở vòng lặp)
router.post('/cap-vien/submissions/:id/steps/5/council-request-revision', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới gửi yêu cầu chỉnh sửa này.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ áp dụng khi hồ sơ đang ở Bước 5 (trạng thái REVIEWED hoặc IN_MEETING).' });
  }
  const revSt = (sub.step5_council_revision_status || '').trim();
  if (revSt === 'waiting_researcher') {
    return res.status(400).json({ message: 'Đang chờ Chủ nhiệm nộp hồ sơ chỉnh sửa. Hoàn tất vòng này trước khi gửi yêu cầu mới.' });
  }
  if (revSt === 'waiting_chair') {
    return res.status(400).json({ message: 'Đang chờ Chủ tịch HĐKHCN xem xét bản chỉnh sửa.' });
  }
  const body = req.body || {};
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lòng nhập nội dung góp ý / yêu cầu chỉnh sửa.' });
  const nextRound = (sub.step5_council_revision_round || 0) + 1;
  const requestedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'secretary';
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_council_revision_round = ?,
    step5_council_revision_status = 'waiting_researcher',
    step5_council_revision_note = ?,
    step5_council_revision_requested_at = ?,
    step5_council_revision_requested_by = ?
    WHERE id = ?`).run(nextRound, note, requestedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'step5_council_request_revision', req.user.id, roleDb, '[Vòng ' + nextRound + '] ' + note, requestedAt);
  console.log('[API] cap-vien step 5 council-request-revision — submission ' + id + ', round ' + nextRound);
  const researcherR = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5SecretaryRevisionRequestEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round: nextRound,
    note,
    requestedByName: req.user.fullname || req.user.email,
    researcherEmail: researcherR ? researcherR.email : null,
    councilList: getNotificationEmails('cap_vien_step5_secretary_revision_notice')
  });
  return res.json({ message: 'Đã gửi yêu cầu chỉnh sửa tới Chủ nhiệm (vòng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// Bước 5 — Chủ nhiệm / Admin: nộp hồ sơ chỉnh sửa theo góp ý Hội đồng
router.post('/cap-vien/submissions/:id/steps/5/council-revision-upload', authMiddleware, (req, res, next) => {
  uploadCapVien.any()(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    }
    next();
  });
}, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_researcher') {
    return res.status(400).json({ message: 'Chỉ được nộp khi Hội đồng đã gửi yêu cầu chỉnh sửa (đang chờ Chủ nhiệm).' });
  }
  const isOwner = Number(sub.submittedById) === Number(req.user.id);
  const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
  if (!isOwner && !isAdmin) {
    return res.status(403).json({ message: 'Chỉ Chủ nhiệm đề tài hoặc Admin mới được nộp hồ sơ chỉnh sửa.' });
  }
  const fList = Array.isArray(req.files) ? req.files.filter(f => f && f.path) : [];
  if (!fList.length) {
    return res.status(400).json({ message: 'Vui lòng chọn ít nhất một file.' });
  }
  const round = sub.step5_council_revision_round || 1;
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting && firstExisting.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const ts = Date.now();
  const uploaderRole = isOwner ? 'researcher' : 'admin';
  const uploaderRoleLabel = isOwner ? 'Chủ nhiệm đề tài' : 'Admin';
  const uploadedAt = new Date().toISOString();
  const prevRows = db.prepare("SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound = ? AND fieldName LIKE 'step5_council_revision_f_%'").all(id, round);
  db.transaction(() => {
    prevRows.forEach((r) => {
      if (r.path) safeUnlinkCapVienStoredFile(r.path);
    });
    db.prepare("DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND revisionRound = ? AND fieldName LIKE 'step5_council_revision_f_%'").run(id, round);
    let idx = 0;
    for (const file of fList) {
      const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
      const safeBase = (storedName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newPath = path.join(baseDir, 'step5_council_rev_' + round + '_' + ts + '_' + idx + '_' + safeBase);
      try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
      const fieldName = 'step5_council_revision_f_' + round + '_' + ts + '_' + idx;
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, fieldName, storedName, newPath, round, req.user.id, uploaderRole, uploadedAt);
      idx++;
    }
    db.prepare("UPDATE cap_vien_submissions SET step5_council_revision_status = 'waiting_chair' WHERE id = ?").run(id);
  })();
  insertCapVienHistory(id, '5', 'step5_council_revision_upload', req.user.id, uploaderRole, uploaderRoleLabel + ' nộp ' + fList.length + ' file (vòng ' + round + ')', uploadedAt);
  console.log('[API] cap-vien step 5 council-revision-upload — submission ' + id + ', round ' + round);
  const researcherUp = sub.submittedById ? db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5RevisionUploadedEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round,
    fileCount: fList.length,
    uploaderName: req.user.fullname || req.user.email || uploaderRoleLabel,
    councilList: getNotificationEmails('cap_vien_step5_revision_uploaded_notice'),
    researcherEmail: researcherUp ? researcherUp.email : null
  });
  return res.json({ message: 'Đã lưu hồ sơ chỉnh sửa. Chủ tịch HĐKHCN sẽ thông qua hoặc yêu cầu chỉnh sửa tiếp.', status: 'waiting_chair', round });
});

// Bước 5 — Chủ tịch HĐKHCN / Thư ký / Admin: thông qua bản chỉnh sửa hoặc yêu cầu chỉnh sửa tiếp
router.post('/cap-vien/submissions/:id/steps/5/council-revision-chair', authMiddleware, (req, res) => {
  if (!roleIsAny(req, ['admin', 'chu_tich', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Chủ tịch HĐKHCN, Thư ký hoặc Admin mới thực hiện bước này.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, submittedById, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.step5_council_revision_status || '') !== 'waiting_chair') {
    return res.status(400).json({ message: 'Không có bản chỉnh sửa đang chờ Chủ tịch xem xét.' });
  }
  const body = req.body || {};
  const action = String(body.action || '').toLowerCase().trim();
  if (!['approve', 'request_more'].includes(action)) {
    return res.status(400).json({ message: 'action phải là approve hoặc request_more' });
  }
  const performedAt = new Date().toISOString();
  const roleDb = roleIs(req, 'admin') ? 'admin' : (roleIs(req, 'thu_ky') ? 'secretary' : 'chu_tich');
  const chairOrActorName = req.user.fullname || req.user.email;
  const researcherCh = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  if (action === 'approve') {
    const roundAp = sub.step5_council_revision_round || 1;
    db.prepare(`UPDATE cap_vien_submissions SET
      step5_council_revision_status = NULL,
      step5_council_revision_note = NULL,
      step5_council_revision_requested_at = NULL,
      step5_council_revision_requested_by = NULL
      WHERE id = ?`).run(id);
    insertCapVienHistory(id, '5', 'step5_chair_approve_revision', req.user.id, roleDb, 'Chấp nhận hồ sơ chỉnh sửa (vòng ' + roundAp + ')', performedAt);
    console.log('[API] cap-vien step 5 council-revision-chair approve — submission ' + id);
    sendCapVienStep5ChairApprovedRevisionEmail({
      submissionTitle: sub.title,
      submissionId: id,
      round: roundAp,
      chairName: chairOrActorName,
      researcherEmail: researcherCh ? researcherCh.email : null,
      researcherName: researcherCh ? researcherCh.fullname : null,
      councilList: getNotificationEmails('cap_vien_step5_chair_approved_notice')
    });
    return res.json({ message: 'Đã thông qua bản chỉnh sửa. Có thể tiếp tục quy trình Bước 5 (ghi nhận thông qua Hội đồng hoặc yêu cầu vòng mới).', status: null });
  }
  const note = String(body.note || '').trim();
  if (!note) return res.status(400).json({ message: 'Vui lòng nhập góp ý khi yêu cầu chỉnh sửa tiếp.' });
  const nextRound = (sub.step5_council_revision_round || 1) + 1;
  db.prepare(`UPDATE cap_vien_submissions SET
    step5_council_revision_round = ?,
    step5_council_revision_status = 'waiting_researcher',
    step5_council_revision_note = ?,
    step5_council_revision_requested_at = ?,
    step5_council_revision_requested_by = ?
    WHERE id = ?`).run(nextRound, note, performedAt, req.user.id, id);
  insertCapVienHistory(id, '5', 'step5_chair_request_more_revision', req.user.id, roleDb, '[Vòng ' + nextRound + '] ' + note, performedAt);
  console.log('[API] cap-vien step 5 council-revision-chair request_more — submission ' + id + ', round ' + nextRound);
  sendCapVienStep5ChairRequestMoreEmail({
    submissionTitle: sub.title,
    submissionId: id,
    round: nextRound,
    note,
    chairName: chairOrActorName,
    researcherEmail: researcherCh ? researcherCh.email : null,
    councilList: getNotificationEmails('cap_vien_step5_chair_request_more_notice')
  });
  return res.json({ message: 'Đã yêu cầu Chủ nhiệm chỉnh sửa tiếp (vòng ' + nextRound + ').', round: nextRound, status: 'waiting_researcher' });
});

// Bước 5 — Thư ký / Admin: ghi nhận Hội đồng KHCN thông qua → chuyển trạng thái sang Bước 6 (CONDITIONAL)
router.post('/cap-vien/submissions/:id/steps/5/council-pass', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!roleIsAny(req, ['admin', 'thu_ky'])) {
    return res.status(403).json({ message: 'Chỉ Thư ký HĐKHCN hoặc Admin mới ghi nhận thông qua Hội đồng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, step5_council_revision_status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const st = (sub.status || '').toUpperCase();
  if (!['REVIEWED', 'IN_MEETING'].includes(st)) {
    return res.status(400).json({ message: 'Chỉ ghi nhận thông qua khi hồ sơ đang ở Bước 5 (REVIEWED / IN_MEETING).' });
  }
  if (sub.step5_council_revision_status) {
    return res.status(400).json({ message: 'Đang có vòng chỉnh sửa theo góp ý Hội đồng chưa đóng. Chờ Chủ tịch thông qua bản chỉnh sửa hoặc hoàn tất vòng này.' });
  }
  const performedAt = new Date().toISOString();
  const roleDb = role === 'admin' ? 'admin' : 'secretary';
  db.prepare('UPDATE cap_vien_submissions SET status = ? WHERE id = ?').run('CONDITIONAL', id);
  insertCapVienHistory(id, '5', 'step5_council_pass_hd', req.user.id, roleDb, 'Ghi nhận Hội đồng KHCN thông qua — chuyển sang Bước 6', performedAt);
  console.log('[API] cap-vien step 5 council-pass — submission ' + id);
  const researcherPass = sub.submittedById ? db.prepare('SELECT email, fullname FROM users WHERE id = ?').get(sub.submittedById) : null;
  sendCapVienStep5CouncilPassedEmail({
    submissionTitle: sub.title,
    submissionId: id,
    researcherEmail: researcherPass ? researcherPass.email : null,
    researcherName: researcherPass ? researcherPass.fullname : null,
    councilList: getNotificationEmails('cap_vien_step5_council_passed_notice'),
    recordedByName: req.user.fullname || req.user.email
  });
  return res.json({ message: 'Đã ghi nhận Hội đồng KHCN thông qua. Hồ sơ chuyển sang Bước 6 (Cấp Quyết định phê duyệt).', status: 'CONDITIONAL' });
});

// Danh sách thành viên Hội đồng KHCN (Chủ tịch, Thư ký, Thành viên) — để Chủ tịch phân công phản biện
router.get('/cap-vien/council', authMiddleware, (req, res) => {
  const isCouncilOrAdmin = roleIsAny(req, ['admin', 'chu_tich', 'thu_ky', 'thanh_vien']);
  if (!isCouncilOrAdmin) return res.status(403).json({ message: 'Chỉ thành viên Hội đồng hoặc Admin mới xem được danh sách' });
  const rows = usersWithAnyRole(['chu_tich', 'thu_ky', 'thanh_vien', 'admin']);
  const council = rows.map(r => ({
    id: r.id,
    email: r.email,
    fullname: r.fullname || r.email || '',
    role: r.role,
    roleDisplay: r.role === 'admin' ? 'Admin' : (r.role === 'chu_tich' ? 'Chủ tịch HĐKHCN' : r.role === 'thu_ky' ? 'Thư ký HĐKHCN' : 'Thành viên HĐKHCN')
  }));
  return res.json({ council });
});

return router;
};
