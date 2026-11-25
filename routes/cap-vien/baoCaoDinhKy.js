'use strict';

/**
 * Đề tài cấp Viện — báo cáo định kỳ (upload theo kỳ & công cụ quản trị kỳ) (2 endpoint).
 *
 *   POST /api/cap-vien/submissions/:id/periodic-report/period/:periodId/upload
 *   POST /api/cap-vien/submissions/:id/periodic-report/admin
 *
 * Tách khỏi server.js (Đợt 4.4 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createCapVienBaoCaoDinhKyRouter({
  db,
  authMiddleware,
  uploadCapVien,
  uploadDirCapVien,
  userHasAnyRole,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
  insertCapVienHistory,
  capVienPeriodicFlatFromStepHistory,
  insertCapVienPeriodicAdminLog,
  capVienResolvePeriodicAnchor,
  capVienBuildPeriodicSchedule,
}) {
const router = express.Router();

function capVienPeriodicReportUploadAllowed(sub, user) {
  const st = (sub.status || '').toUpperCase();
  if (!['IMPLEMENTATION', 'COMPLETED'].includes(st)) return false;
  if (userHasAnyRole(user, ['admin', 'phong_khcn', 'thu_ky'])) return true;
  return sub.submittedById === user.id;
}

/** NCV / P.KHCN / Thư ký / Admin: upload báo cáo gắn một kỳ */
router.post(
  '/cap-vien/submissions/:id/periodic-report/period/:periodId/upload',
  authMiddleware,
  uploadCapVien.single('periodic_report_file'),
  (req, res) => {
    const id = parseInt(req.params.id, 10);
    const periodId = parseInt(req.params.periodId, 10);
    if (!id || !periodId) return res.status(400).json({ message: 'ID không hợp lệ' });
    const sub = db.prepare('SELECT id, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if (!capVienPeriodicReportUploadAllowed(sub, req.user)) {
      return res.status(403).json({ message: 'Không có quyền upload báo cáo định kỳ cho hồ sơ này.' });
    }
    const per = db.prepare(
      `SELECT id, submissionId, status, primaryFileId FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`
    ).get(periodId, id);
    if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ báo cáo' });
    const stLow = String(per.status || '').toLowerCase();
    if (stLow === 'waived' || stLow === 'bypassed') {
      return res.status(400).json({ message: 'Kỳ này đã bất hoạt / bypass — không upload.' });
    }
    const file = req.file;
    if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file (PDF/Word).' });
    const allowedExt = ['.pdf', '.doc', '.docx'];
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (!allowedExt.includes(ext)) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      return res.status(400).json({ message: 'Chỉ chấp nhận PDF hoặc Word.' });
    }
    const fieldName = 'periodic_report_p' + periodId;
    const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
    const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    const roleDb = (req.user.role || '').toLowerCase() === 'admin' ? 'admin' : (req.user.role || '');
    const uploadedAt = new Date().toISOString();
    const oldF = db.prepare('SELECT id, path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
    if (oldF) {
      db.prepare('DELETE FROM cap_vien_submission_files WHERE id = ?').run(oldF.id);
      if (oldF.path) safeUnlinkCapVienStoredFile(oldF.path);
    }
    const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
    const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
    try {
      fs.renameSync(file.path, newPath);
    } catch (e) {
      try { fs.copyFileSync(file.path, newPath); } catch (_) {}
    }
    const insFile = db.prepare(
      'INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
    );
    const info = insFile.run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
    const newId = info.lastInsertRowid;
    db.prepare(
      `UPDATE cap_vien_periodic_report_period SET status = 'submitted', submittedAt = ?, primaryFileId = ?, waivedAt = NULL, waivedById = NULL, waiveNote = NULL, bypassedAt = NULL, bypassedById = NULL, bypassNote = NULL WHERE id = ?`
    ).run(uploadedAt, newId, periodId);
    insertCapVienHistory(id, '10', 'periodic_report_upload', req.user.id, roleDb, 'Nộp báo cáo định kỳ: ' + storedName + ' (kỳ #' + periodId + ')');
    return res.json({ message: 'Đã lưu báo cáo cho kỳ được chọn.', fileId: newId, periodId });
  }
);

/** Admin: công cụ báo cáo định kỳ — body { action, payload } */
router.post('/cap-vien/submissions/:id/periodic-report/admin', authMiddleware, (req, res) => {
  if (String(req.user.role || '').toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Chỉ Admin mới được dùng công cụ này.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT * FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  const body = req.body || {};
  const payload = body.payload || {};
  const action = String(body.action || payload.action || '').toLowerCase().trim();
  const now = new Date().toISOString();

  const histRows = db.prepare(
    `SELECT stepId, actionType, performedAt FROM cap_vien_submission_history WHERE submissionId = ? ORDER BY performedAt ASC`
  ).all(id);
  const stepHistory = {};
  for (const h of histRows) {
    if (!stepHistory[h.stepId]) stepHistory[h.stepId] = [];
    stepHistory[h.stepId].push({ actionType: h.actionType, performedAt: h.performedAt });
  }
  const flat = capVienPeriodicFlatFromStepHistory(stepHistory);

  const log = (type, periodId, pobj, note) => {
    insertCapVienPeriodicAdminLog(id, periodId, type, req.user, pobj, note);
  };

  try {
    if (action === 'set_cycle') {
      const cycleMonths = Math.max(1, Math.min(24, parseInt(payload.cycleMonths, 10) || 6));
      const anchorType = String(payload.anchorType || 'post_step7').trim() || 'post_step7';
      const anchorAt = payload.anchorAt ? String(payload.anchorAt).trim() : null;
      const dueOffsetDays = Math.max(-60, Math.min(120, parseInt(payload.dueOffsetDays, 10) || 0));
      const ex = db.prepare('SELECT submissionId FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (ex) {
        db.prepare(
          `UPDATE cap_vien_periodic_report_config SET cycleMonths = ?, anchorType = ?, anchorAt = ?, dueOffsetDays = ?, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
        ).run(cycleMonths, anchorType, anchorAt || null, dueOffsetDays, now, req.user.id, id);
      } else {
        db.prepare(
          `INSERT INTO cap_vien_periodic_report_config (submissionId, cycleMonths, anchorType, anchorAt, dueRule, dueOffsetDays, timezone, pauseReportClock, updatedAt, updatedById)
           VALUES (?,?,?,?, 'end_of_period', ?, 'Asia/Ho_Chi_Minh', 0, ?, ?)`
        ).run(id, cycleMonths, anchorType, anchorAt || null, dueOffsetDays, now, req.user.id);
      }
      log('set_cycle', null, { cycleMonths, anchorType, anchorAt, dueOffsetDays }, null);
      insertCapVienHistory(id, '10', 'periodic_report_config', req.user.id, 'admin', `Cấu hình BC định kỳ: ${cycleMonths} tháng, neo ${anchorType}`);
      return res.json({ message: 'Đã lưu cấu hình chu kỳ báo cáo.', action: 'set_cycle' });
    }

    if (action === 'preview_schedule') {
      const cfg =
        db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id) || {
          cycleMonths: parseInt(payload.cycleMonths, 10) || 6,
          anchorType: String(payload.anchorType || 'post_step7'),
          anchorAt: payload.anchorAt || null
        };
      const cycleMonths = Math.max(1, Math.min(24, parseInt(payload.cycleMonths || cfg.cycleMonths, 10) || 6));
      const anchorType = String(payload.anchorType || cfg.anchorType || 'post_step7');
      const anchorIso = capVienResolvePeriodicAnchor(id, sub, anchorType, payload.anchorAt || cfg.anchorAt, flat);
      if (!anchorIso) return res.status(400).json({ message: 'Không xác định được mốc neo (thiếu ngày / lịch sử Bước 7).' });
      const periodCount = Math.max(1, Math.min(48, parseInt(payload.periodCount, 10) || Math.min(12, Math.ceil(36 / cycleMonths))));
      const preview = capVienBuildPeriodicSchedule(anchorIso, cycleMonths, periodCount);
      return res.json({ message: 'Preview lịch kỳ (chưa lưu).', preview, anchorIso, action: 'preview_schedule' });
    }

    if (action === 'apply_recalc') {
      const forceWipe = !!payload.forceWipe;
      const cfg = db.prepare('SELECT * FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (!cfg) return res.status(400).json({ message: 'Chưa có cấu hình. Dùng set_cycle trước.' });
      const locked = db.prepare(
        `SELECT COUNT(1) AS n FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL AND primaryFileId IS NOT NULL`
      ).get(id);
      if ((locked.n || 0) > 0 && !forceWipe) {
        return res.status(400).json({
          message: 'Đã có kỳ đã nộp file. Truyền payload.forceWipe = true để xóa toàn bộ kỳ và tạo lại (nguy hiểm).'
        });
      }
      db.transaction(() => {
        const ids = db.prepare(`SELECT id FROM cap_vien_periodic_report_period WHERE submissionId = ?`).all(id).map((r) => r.id);
        for (const pid of ids) {
          db.prepare('DELETE FROM cap_vien_periodic_report_period_file WHERE periodId = ?').run(pid);
        }
        db.prepare('DELETE FROM cap_vien_periodic_report_period WHERE submissionId = ?').run(id);
        const anchorIso = capVienResolvePeriodicAnchor(id, sub, cfg.anchorType, cfg.anchorAt, flat);
        if (!anchorIso) throw new Error('NO_ANCHOR');
        const periodCount = Math.max(1, Math.min(48, parseInt(payload.periodCount, 10) || Math.min(12, Math.ceil(36 / cfg.cycleMonths))));
        const rows = capVienBuildPeriodicSchedule(anchorIso, cfg.cycleMonths, periodCount);
        const ins = db.prepare(
          `INSERT INTO cap_vien_periodic_report_period (submissionId, seq, label, periodStart, periodEnd, dueAt, status, createdAt) VALUES (?,?,?,?,?,?, 'pending', ?)`
        );
        for (const r of rows) {
          ins.run(id, r.seq, r.label, r.periodStart, r.periodEnd, r.dueAt, now);
        }
      })();
      log('apply_recalc', null, { forceWipe, periodCount: payload.periodCount }, null);
      insertCapVienHistory(id, '10', 'periodic_report_recalc', req.user.id, 'admin', 'Tính lại lịch các kỳ báo cáo định kỳ');
      return res.json({ message: 'Đã tạo lại danh sách kỳ báo cáo.', action: 'apply_recalc' });
    }

    if (action === 'insert_period') {
      const dueAt = String(payload.dueAt || '').trim();
      if (!dueAt) return res.status(400).json({ message: 'Thiếu dueAt (ISO).' });
      const label = String(payload.label || '').trim() || null;
      const maxS = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM cap_vien_periodic_report_period WHERE submissionId = ? AND deletedAt IS NULL`).get(id);
      const seq = (maxS.m || 0) + 1;
      const periodStart = String(payload.periodStart || dueAt).trim();
      db.prepare(
        `INSERT INTO cap_vien_periodic_report_period (submissionId, seq, label, periodStart, periodEnd, dueAt, status, createdAt) VALUES (?,?,?,?, NULL, ?, 'pending', ?)`
      ).run(id, seq, label, periodStart, dueAt, now);
      const row = db.prepare(`SELECT id FROM cap_vien_periodic_report_period WHERE submissionId = ? AND seq = ? AND deletedAt IS NULL`).get(id, seq);
      log('insert_period', row.id, { seq, dueAt, label }, null);
      return res.json({ message: 'Đã chèn kỳ mới.', periodId: row.id, action: 'insert_period' });
    }

    if (action === 'delete_period') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'Thiếu periodId' });
      const per = db
        .prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`)
        .get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      if (per.primaryFileId) return res.status(400).json({ message: 'Kỳ đã có file — không xóa.' });
      const stLow = String(per.status || '').toLowerCase();
      if (stLow === 'submitted') return res.status(400).json({ message: 'Kỳ đã submitted — không xóa.' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET deletedAt = ? WHERE id = ?`).run(now, periodId);
      log('delete_period', periodId, { seq: per.seq }, null);
      return res.json({ message: 'Đã xóa kỳ (soft).', action: 'delete_period' });
    }

    if (action === 'waive_period') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'Cần periodId và note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'waived', waivedAt = ?, waivedById = ?, waiveNote = ?, primaryFileId = NULL, submittedAt = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('waive_period', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_waive', req.user.id, 'admin', 'Bất hoạt kỳ BC: ' + note);
      return res.json({ message: 'Đã bất hoạt kỳ.', action: 'waive_period' });
    }

    if (action === 'bypass_submit') {
      const periodId = parseInt(payload.periodId, 10);
      const note = String(payload.note || '').trim();
      if (!periodId || !note) return res.status(400).json({ message: 'Cần periodId và note.' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET status = 'bypassed', bypassedAt = ?, bypassedById = ?, bypassNote = ?, submittedAt = NULL, primaryFileId = NULL WHERE id = ?`
      ).run(now, req.user.id, note, periodId);
      log('bypass_submit', periodId, { note }, null);
      insertCapVienHistory(id, '10', 'periodic_report_bypass', req.user.id, 'admin', 'Bypass nộp kỳ BC: ' + note);
      return res.json({ message: 'Đã bypass kỳ (đánh dấu hoàn thành không file).', action: 'bypass_submit' });
    }

    if (action === 'detach_file') {
      const periodId = parseInt(payload.periodId, 10);
      if (!periodId) return res.status(400).json({ message: 'Thiếu periodId' });
      const per = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(periodId, id);
      if (!per) return res.status(404).json({ message: 'Không tìm thấy kỳ' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(periodId);
      db.prepare(`UPDATE cap_vien_periodic_report_period_file SET detachedAt = ? WHERE periodId = ? AND detachedAt IS NULL`).run(now, periodId);
      log('detach_file', periodId, {}, null);
      return res.json({ message: 'Đã gỡ file khỏi kỳ (kỳ về pending).', action: 'detach_file' });
    }

    if (action === 'move_file') {
      const fromPeriodId = parseInt(payload.fromPeriodId, 10);
      const toPeriodId = parseInt(payload.toPeriodId, 10);
      if (!fromPeriodId || !toPeriodId) return res.status(400).json({ message: 'Cần fromPeriodId và toPeriodId' });
      const fromP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(fromPeriodId, id);
      const toP = db.prepare(`SELECT * FROM cap_vien_periodic_report_period WHERE id = ? AND submissionId = ? AND deletedAt IS NULL`).get(toPeriodId, id);
      if (!fromP || !toP) return res.status(404).json({ message: 'Kỳ không hợp lệ' });
      const fid = fromP.primaryFileId;
      if (!fid) return res.status(400).json({ message: 'Kỳ nguồn không có file' });
      if (toP.primaryFileId) return res.status(400).json({ message: 'Kỳ đích đã có file' });
      db.prepare(`UPDATE cap_vien_periodic_report_period SET primaryFileId = NULL, status = 'pending', submittedAt = NULL WHERE id = ?`).run(fromPeriodId);
      db.prepare(
        `UPDATE cap_vien_periodic_report_period SET primaryFileId = ?, status = 'submitted', submittedAt = ? WHERE id = ?`
      ).run(fid, now, toPeriodId);
      log('move_file', toPeriodId, { fromPeriodId, toPeriodId, fileId: fid }, null);
      return res.json({ message: 'Đã chuyển file sang kỳ đích.', action: 'move_file' });
    }

    if (action === 'freeze_deadlines') {
      const until = String(payload.pausedUntil || '').trim() || null;
      const reason = String(payload.pauseReason || '').trim() || 'freeze';
      const exF = db.prepare('SELECT submissionId FROM cap_vien_periodic_report_config WHERE submissionId = ?').get(id);
      if (exF) {
        db.prepare(
          `UPDATE cap_vien_periodic_report_config SET pauseReportClock = 1, pausedUntil = ?, pauseReason = ?, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
        ).run(until, reason, now, req.user.id, id);
      } else {
        db.prepare(
          `INSERT INTO cap_vien_periodic_report_config (submissionId, cycleMonths, anchorType, dueRule, dueOffsetDays, timezone, pauseReportClock, pausedUntil, pauseReason, updatedAt, updatedById)
           VALUES (?, 6, 'post_step7', 'end_of_period', 0, 'Asia/Ho_Chi_Minh', 1, ?, ?, ?, ?)`
        ).run(id, until, reason, now, req.user.id);
      }
      log('freeze_deadlines', null, { until, reason }, null);
      return res.json({ message: 'Đã bật đóng băng hạn (cờ hệ thống).', action: 'freeze_deadlines' });
    }

    if (action === 'unfreeze_deadlines') {
      db.prepare(
        `UPDATE cap_vien_periodic_report_config SET pauseReportClock = 0, pausedUntil = NULL, pauseReason = NULL, updatedAt = ?, updatedById = ? WHERE submissionId = ?`
      ).run(now, req.user.id, id);
      log('unfreeze_deadlines', null, {}, null);
      return res.json({ message: 'Đã tắt đóng băng.', action: 'unfreeze_deadlines' });
    }

    if (action === 'resend_reminder') {
      const periodId = payload.periodId ? parseInt(payload.periodId, 10) : null;
      log('resend_reminder', periodId || null, {}, payload.note || null);
      return res.json({ message: 'Đã ghi nhận yêu cầu nhắc (tích hợp email có thể bổ sung sau).', action: 'resend_reminder' });
    }

    return res.status(400).json({ message: 'action không hợp lệ: ' + action });
  } catch (err) {
    if (err && err.message === 'NO_ANCHOR') {
      return res.status(400).json({ message: 'Không xác định được mốc neo lịch.' });
    }
    console.error('[periodic-report admin]', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

return router;
};
