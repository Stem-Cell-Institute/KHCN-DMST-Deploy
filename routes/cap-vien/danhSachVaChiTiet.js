'use strict';

/**
 * Đề tài cấp Viện — danh sách và chi tiết hồ sơ (2 endpoint).
 *
 *   GET /api/cap-vien/submissions
 *   GET /api/cap-vien/submissions/:id
 *
 * Tách khỏi server.js (Đợt 4.2 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');

module.exports = function createCapVienDanhSachVaChiTietRouter({
  db,
  authMiddleware,
  capVienRoleSeesAllSubmissions,
  computeCapVienStepActualStats,
  getCapVienPeriodicReportBundle,
}) {
const router = express.Router();

router.get('/cap-vien/submissions', authMiddleware, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache');
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  if (isCouncilOrAdmin) {
    const rows = db.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
    rows.forEach(r => {
      const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
      r.submittedByName = u ? u.fullname : null;
    });
    return res.json(rows);
  }
  const rows = db.prepare('SELECT id, title, submittedBy, status, createdAt, code FROM cap_vien_submissions WHERE submittedById = ? ORDER BY createdAt DESC').all(req.user.id);
  return res.json(rows);
});

router.get('/cap-vien/submissions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const row = db.prepare(`SELECT id, title, submittedBy, submittedById, status, createdAt, code, options_checked, reviewNote, reviewedAt, reviewedById, assignedReviewerIds, assignedAt, assignedById, budget_4a_status, CASE WHEN COALESCE(budget_4a_round, 0) < 1 THEN 1 ELSE budget_4a_round END AS budget_4a_round, budget_4a_revision_note, budget_4a_revision_requested_at, budget_4a_revision_requested_by, budget_4a_approved_at, budget_4a_approved_by, step_4_reviewer1_done, step_4_reviewer2_done, step5_hd_meeting_location, step5_hd_meeting_attendance, step5_hd_meeting_documents, step5_hd_meeting_vote_result, step5_hd_meeting_decision, step5_hd_meeting_event_time, step5_hd_meeting_updated_at, step5_hd_meeting_updated_by, step5_council_revision_status, COALESCE(step5_council_revision_round, 0) AS step5_council_revision_round, step5_council_revision_note, step5_council_revision_requested_at, step5_council_revision_requested_by, step6_so_qd, step6_kinh_phi, step6_thoi_gian, step6_phi_quan_ly, step6_meta_updated_at, step6_meta_updated_by, step7_so_hd, step7_hieu_luc, step7_meta_updated_at, step7_meta_updated_by, step8_ma_dao_duc, step8_hieu_luc, step8_so_quyet_dinh, step8_meta_updated_at, step8_meta_updated_by, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived, COALESCE(step8a_completed, 0) AS step8a_completed, COALESCE(step8a_waived, 0) AS step8a_waived, step9_supply_locked_at, step9_supply_locked_by FROM cap_vien_submissions WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const role = req.user.role;
  const isCouncilOrAdmin = capVienRoleSeesAllSubmissions(req);
  const isOwner = row.submittedById === req.user.id;
  if (!isCouncilOrAdmin && !isOwner) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ này' });
  }
  const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.submittedById);
  const files = db.prepare('SELECT id, fieldName, originalName, path, COALESCE(revisionRound, 0) AS revisionRound, uploadedById, uploadedByRole, uploadedAt FROM cap_vien_submission_files WHERE submissionId = ? ORDER BY revisionRound ASC, id ASC').all(id);
  const stepDeadlinesRows = db.prepare('SELECT stepId, openedAt, dueAt, durationDays, updatedById, updatedAt FROM cap_vien_step_deadlines WHERE submissionId = ?').all(id);
  const stepDeadlines = {};
  stepDeadlinesRows.forEach(r => { stepDeadlines[r.stepId] = r; });
  const reviewedBy = (row.reviewedById != null) ? db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.reviewedById) : null;
  const allHistory = db.prepare('SELECT stepId, actionType, performedAt, performedById, performedByName, performedByRole, note FROM cap_vien_submission_history WHERE submissionId = ? ORDER BY performedAt ASC').all(id);
  const stepHistory = {};
  allHistory.forEach(h => {
    if (!stepHistory[h.stepId]) stepHistory[h.stepId] = [];
    stepHistory[h.stepId].push({ actionType: h.actionType, performedAt: h.performedAt, performedById: h.performedById, performedByName: h.performedByName, performedByRole: h.performedByRole, note: h.note });
  });
  let step2History = (stepHistory['2'] || []);
  if (step2History.length === 0) {
    const legacy = db.prepare('SELECT actionType, performedAt, performedById, performedByName, performedByRole, note FROM cap_vien_step2_history WHERE submissionId = ? ORDER BY performedAt ASC').all(id);
    if (legacy.length) step2History = legacy;
    else if (row.reviewedAt && row.reviewedById) {
      const actionType = (row.status || '').toUpperCase() === 'VALIDATED' ? 'secretary_approve' : 'secretary_request_revision';
      const note = row.reviewNote || (actionType === 'secretary_approve' ? 'Hợp lệ' : null);
      const revUser = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.reviewedById);
      step2History = [{ actionType, performedAt: row.reviewedAt, performedById: row.reviewedById, performedByName: revUser ? revUser.fullname : '', performedByRole: 'secretary', note }];
    }
  }
  stepHistory['2'] = step2History;
  let assignedBy = null;
  let reviewerNames = [];
  if (row.assignedById) assignedBy = db.prepare('SELECT fullname FROM users WHERE id = ?').get(row.assignedById);
  if (row.assignedReviewerIds) {
    try {
      const ids = JSON.parse(row.assignedReviewerIds);
      const reviewers = db.prepare('SELECT id, fullname, email FROM users WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids);
      reviewerNames = ids.map(rid => { const r = reviewers.find(x => x.id === rid); return r ? (r.fullname || r.email || '') : '—'; });
    } catch (e) {}
  }
  let displayCode = row.code;
  if (!displayCode && row.id) {
    const y = (row.createdAt || '').toString().slice(0, 4) || new Date().getFullYear();
    displayCode = 'DTSCI-' + y + '-' + String(row.id).padStart(3, '0');
  }
  let step5HdMeetingUpdatedByName = null;
  if (row.step5_hd_meeting_updated_by != null) {
    const u5 = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step5_hd_meeting_updated_by);
    if (u5) step5HdMeetingUpdatedByName = u5.fullname || u5.email || null;
  }
  let step5CouncilRevisionRequestedByName = null;
  if (row.step5_council_revision_requested_by != null) {
    const uRev = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step5_council_revision_requested_by);
    if (uRev) step5CouncilRevisionRequestedByName = uRev.fullname || uRev.email || null;
  }
  let step6MetaUpdatedByName = null;
  if (row.step6_meta_updated_by != null) {
    const u6m = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step6_meta_updated_by);
    if (u6m) step6MetaUpdatedByName = u6m.fullname || u6m.email || null;
  }
  let step7MetaUpdatedByName = null;
  if (row.step7_meta_updated_by != null) {
    const u7m = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step7_meta_updated_by);
    if (u7m) step7MetaUpdatedByName = u7m.fullname || u7m.email || null;
  }
  let step8MetaUpdatedByName = null;
  if (row.step8_meta_updated_by != null) {
    const u8m = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step8_meta_updated_by);
    if (u8m) step8MetaUpdatedByName = u8m.fullname || u8m.email || null;
  }
  const stepActualStats = computeCapVienStepActualStats(row, stepHistory, stepDeadlines);
  let periodicReport = null;
  try {
    periodicReport = getCapVienPeriodicReportBundle(id, true, role);
  } catch (e) {
    periodicReport = { config: null, periods: [], primaryFiles: {}, adminLog: [] };
  }
  const step9Milestones = db.prepare(
    'SELECT id, title, status, eventDate, note, sortOrder, createdAt, createdById, updatedAt FROM cap_vien_step9_milestone WHERE submissionId = ? AND deletedAt IS NULL ORDER BY sortOrder ASC, id ASC'
  ).all(id);
  const step9SupplyItemsRaw = db.prepare(
    'SELECT id, name, unit, approvedQty, approvedAmount, note, createdAt FROM cap_vien_step9_supply_item WHERE submissionId = ? AND deletedAt IS NULL ORDER BY id ASC'
  ).all(id);
  const step9SupplyIssuancesRaw = db.prepare(
    `SELECT si.id, si.itemId, si.qty, si.issuedDate, si.note, si.status, si.requestedAt, si.decidedAt, si.decisionNote,
            ru.fullname AS requestedByName, du.fullname AS decidedByName
     FROM cap_vien_step9_supply_issuance si
     LEFT JOIN users ru ON ru.id = si.requestedById
     LEFT JOIN users du ON du.id = si.decidedById
     WHERE si.submissionId = ? ORDER BY si.id ASC`
  ).all(id);
  const step9SupplyItems = step9SupplyItemsRaw.map((it) => {
    const issuances = step9SupplyIssuancesRaw.filter((s) => s.itemId === it.id);
    const issuedQty = issuances.filter((s) => s.status === 'confirmed').reduce((sum, s) => sum + (s.qty || 0), 0);
    return { ...it, issuances, issuedQty, remainingQty: it.approvedQty - issuedQty };
  });
  let step9SupplyLockedByName = null;
  if (row.step9_supply_locked_by != null) {
    const u9 = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.step9_supply_locked_by);
    if (u9) step9SupplyLockedByName = u9.fullname || u9.email || null;
  }
  const step11AdjustmentRequests = db.prepare(
    `SELECT ar.id, ar.type, ar.content, ar.status, ar.requestedAt, ar.khcnNote, ar.khcnDecidedAt, ar.directorNote, ar.directorDecidedAt,
            reqU.fullname AS requestedByName, khcnU.fullname AS khcnDecidedByName, dirU.fullname AS directorDecidedByName
     FROM cap_vien_step11_adjustment_request ar
     LEFT JOIN users reqU ON reqU.id = ar.requestedById
     LEFT JOIN users khcnU ON khcnU.id = ar.khcnDecidedById
     LEFT JOIN users dirU ON dirU.id = ar.directorDecidedById
     WHERE ar.submissionId = ? ORDER BY ar.id DESC`
  ).all(id);
  return res.json({
    ...row,
    code: displayCode,
    step5HdMeetingUpdatedByName,
    step5CouncilRevisionRequestedByName,
    step6MetaUpdatedByName,
    step7MetaUpdatedByName,
    step8MetaUpdatedByName,
    step9SupplyLockedByName,
    submittedByName: u ? u.fullname : null,
    reviewedByName: reviewedBy ? reviewedBy.fullname : null,
    assignedByName: assignedBy ? assignedBy.fullname : null,
    reviewerNames,
    files,
    stepDeadlines,
    step2History,
    stepHistory,
    stepActualStats,
    periodicReport,
    step9Milestones,
    step9SupplyItems,
    step11AdjustmentRequests
  });
});

return router;
};
