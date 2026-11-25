const express = require('express');
const router = express.Router();
const db = require('../db/db');
const projectService = require('../services/projectService');
const config = require('../config/config');

let isSchemaEnsured = false;

async function ensureExtensionSchema() {
  if (isSchemaEnsured) return;
  const colsToAdd = [
    'ALTER TABLE nckh_extensions ADD COLUMN khcn_notes TEXT',
    'ALTER TABLE nckh_extensions ADD COLUMN director_opinion TEXT',
    'ALTER TABLE nckh_extensions ADD COLUMN reviewed_by TEXT',
    'ALTER TABLE nckh_extensions ADD COLUMN reviewed_at TEXT'
  ];
  for (const sql of colsToAdd) {
    try {
      await db.run(sql);
    } catch (e) {
      // Cột đã tồn tại
    }
  }

  // Làm sạch các bản ghi gia hạn bị tự động gán số QĐ giả lập "QĐ-GH-..." khi chưa có tệp Quyết định thực tế
  try {
    const autoRows = await db.all(`
      SELECT e.* FROM nckh_extensions e
      WHERE e.status = 'APPROVED' AND e.decision_number LIKE 'QĐ-GH-%'
    `);
    for (const r of autoRows) {
      const qdKey = `QD_GIA_HAN_${r.extension_num || 1}`;
      const hasRealQdDoc = await db.get(
        `SELECT id FROM nckh_documents WHERE project_id = ? AND (doc_type = ? OR (stage = 6 AND title LIKE '%Quyết định%')) LIMIT 1`,
        [r.project_id, qdKey]
      );
      if (!hasRealQdDoc) {
        await db.run(`
          UPDATE nckh_extensions
          SET status = 'PENDING', decision_number = NULL, decision_date = NULL
          WHERE id = ?
        `, [r.id]);
        await reconcileProjectExtensionState(r.project_id);
      }
    }
  } catch (e) {
    console.warn('Extension auto-row cleanup notice:', e.message);
  }

  isSchemaEnsured = true;
}

/**
 * Đồng bộ hóa trạng thái Gia hạn thực tế của Đề tài:
 * - Chỉ những đợt gia hạn có status = 'APPROVED' (đã được Viện trưởng ký QĐ phê duyệt) mới được cộng vào extension_count và current_end_date.
 * - Tự động liên kết request_file_id (Đơn xin gia hạn) và decision_file_id (Quyết định gia hạn) với kho văn bản Giai đoạn 6.
 */
async function reconcileProjectExtensionState(projectId) {
  const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
  if (!project) return null;

  const extensions = await db.all(
    'SELECT * FROM nckh_extensions WHERE project_id = ? ORDER BY extension_num ASC, id ASC',
    [projectId]
  );
  const docs = await db.all(
    'SELECT * FROM nckh_documents WHERE project_id = ? AND stage = 6 ORDER BY id DESC',
    [projectId]
  );

  for (const ext of extensions) {
    const num = ext.extension_num || 1;
    const reqDocKey = `DON_GIA_HAN_${num}`;
    const decDocKey = `QD_GIA_HAN_${num}`;

    const matchedReqDoc = docs.find(d =>
      d.doc_type === reqDocKey ||
      (num === 1 && d.doc_type === 'DON_GIA_HAN') ||
      (d.title && d.title.toLowerCase().includes('đơn') && (num === 2 ? d.title.toLowerCase().includes('lần 2') : !d.title.toLowerCase().includes('lần 2')))
    );
    const matchedDecDoc = docs.find(d =>
      d.doc_type === decDocKey ||
      (num === 1 && d.doc_type === 'QD_GIA_HAN') ||
      (d.title && d.title.toLowerCase().includes('quyết định') && (num === 2 ? d.title.toLowerCase().includes('lần 2') : !d.title.toLowerCase().includes('lần 2')))
    );

    const newReqFileId = matchedReqDoc ? matchedReqDoc.id : null;
    const newDecFileId = matchedDecDoc ? matchedDecDoc.id : null;

    if (ext.request_file_id !== newReqFileId || ext.decision_file_id !== newDecFileId) {
      await db.run(
        'UPDATE nckh_extensions SET request_file_id = ?, decision_file_id = ? WHERE id = ?',
        [newReqFileId, newDecFileId, ext.id]
      );
      ext.request_file_id = newReqFileId;
      ext.decision_file_id = newDecFileId;
    }
  }

  // Chỉ tính các đợt đã được Viện trưởng phê duyệt chính thức (APPROVED)
  const approvedExts = extensions.filter(e => e.status === 'APPROVED');
  const approvedCount = Math.min(config.MAX_EXTENSIONS, approvedExts.length);

  // Tính lại hạn hoàn thành chính thức dựa trên hạn gốc + số lần gia hạn ĐÃ DUYỆT
  let baseDateObj = projectService.parseDate(project.base_end_date);
  if (!baseDateObj && project.decision_date) {
    const decDateObj = projectService.parseDate(project.decision_date);
    if (decDateObj) {
      baseDateObj = projectService.addMonths(decDateObj, Number(project.duration_months) || 12);
    }
  }

  let effectiveEndDateISO = project.base_end_date;
  if (approvedCount > 0) {
    const lastApproved = approvedExts[approvedExts.length - 1];
    if (lastApproved && lastApproved.new_end_date) {
      effectiveEndDateISO = lastApproved.new_end_date;
    } else if (baseDateObj) {
      effectiveEndDateISO = projectService.formatDateISO(
        projectService.addMonths(baseDateObj, approvedCount * config.EXTENSION_MONTHS)
      );
    }
  } else if (baseDateObj) {
    effectiveEndDateISO = projectService.formatDateISO(baseDateObj);
  }

  if (Number(project.extension_count || 0) !== approvedCount || project.current_end_date !== effectiveEndDateISO) {
    await db.run(`
      UPDATE nckh_projects
      SET extension_count = ?, current_end_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [approvedCount, effectiveEndDateISO, projectId]);
  }

  // Đồng bộ các kỳ báo cáo định kỳ 6 tháng: nếu một đợt gia hạn chưa được duyệt mà trước đó lỡ sinh kỳ báo cáo thừa (chưa nộp) thì thu hồi
  const maxExpectedPeriods = Math.floor(((Number(project.duration_months) || 12) + (approvedCount * config.EXTENSION_MONTHS)) / config.REPORT_CYCLE_MONTHS);
  await db.run(`
    DELETE FROM nckh_periodic_reports
    WHERE project_id = ? AND period_num > ? AND status = 'PENDING' AND report_file_id IS NULL
  `, [projectId, maxExpectedPeriods]);

  return {
    approved_count: approvedCount,
    current_end_date: effectiveEndDateISO,
    extensions
  };
}

// GET /api/extensions/project/:projectId - Lấy lịch sử gia hạn của đề tài
router.get('/project/:projectId', async (req, res) => {
  try {
    await ensureExtensionSchema();
    const { projectId } = req.params;
    const state = await reconcileProjectExtensionState(projectId);
    res.json({ success: true, data: state ? state.extensions : [] });
  } catch (err) {
    console.error('Error in GET /api/extensions:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/extensions/:projectId - Bước 1: Chủ nhiệm (hoặc P. KH&CN) lập đề xuất xin gia hạn (Khởi tạo hồ sơ PENDING, CHƯA cộng hạn đề tài)
router.post('/:projectId', async (req, res) => {
  try {
    await ensureExtensionSchema();
    const { projectId } = req.params;
    const { reason, request_date } = req.body;

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }

    await reconcileProjectExtensionState(projectId);
    const updatedProject = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    const approvedExtCount = updatedProject.extension_count || 0;

    // 1. Kiểm tra quy tắc khống chế gia hạn: TỐI ĐA 2 LẦN ĐÃ DUYỆT
    if (approvedExtCount >= config.MAX_EXTENSIONS) {
      return res.status(400).json({
        success: false,
        error: `Đề tài đã được phê duyệt gia hạn đủ ${config.MAX_EXTENSIONS} lần (tối đa). Quy định không cho phép gia hạn lần thứ 3.`
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập lý do đề nghị gia hạn và nội dung công việc cần hoàn thiện.' });
    }

    // Kiểm tra xem có đợt đề xuất nào đang ở trạng thái PENDING hoặc REVISION_NEEDED không
    const existingPending = await db.get(`
      SELECT * FROM nckh_extensions
      WHERE project_id = ? AND status IN ('PENDING', 'REVISION_NEEDED')
      ORDER BY id DESC LIMIT 1
    `, [projectId]);

    const prevEndDateStr = updatedProject.current_end_date || updatedProject.base_end_date;
    const prevEndDate = projectService.parseDate(prevEndDateStr) || new Date();
    const proposedEndDate = projectService.addMonths(prevEndDate, config.EXTENSION_MONTHS);
    const proposedEndDateISO = projectService.formatDateISO(proposedEndDate);
    const reqDateISO = request_date
      ? projectService.formatDateISO(projectService.parseDate(request_date))
      : projectService.formatDateISO(new Date());

    if (existingPending) {
      await db.run(`
        UPDATE nckh_extensions
        SET reason = ?, request_date = ?, previous_end_date = ?, new_end_date = ?, status = 'PENDING'
        WHERE id = ?
      `, [
        reason.trim(),
        reqDateISO,
        projectService.formatDateISO(prevEndDate),
        proposedEndDateISO,
        existingPending.id
      ]);
      await reconcileProjectExtensionState(projectId);
      return res.json({
        success: true,
        message: `Đã cập nhật nội dung Đề xuất gia hạn Lần ${existingPending.extension_num}. Vui lòng tải mẫu Đơn (.docx), ký xác nhận và tải bản scan Đơn có chữ ký lên hệ thống để Phòng KH&CN trình Viện trưởng.`,
        extension_id: existingPending.id,
        extension_num: existingPending.extension_num,
        proposed_end_date_vn: projectService.formatDateVN(proposedEndDate)
      });
    }

    const nextExtNum = approvedExtCount + 1;

    // 2. Ghi vào bảng nckh_extensions với trạng thái PENDING (Đang trình đề xuất, CHƯA có Số QĐ và CHƯA đổi hạn đề tài)
    const rs = await db.run(`
      INSERT INTO nckh_extensions (
        project_id, extension_num, months_added, previous_end_date, 
        new_end_date, request_date, reason, decision_number, decision_date, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'PENDING')
    `, [
      projectId,
      nextExtNum,
      config.EXTENSION_MONTHS,
      projectService.formatDateISO(prevEndDate),
      proposedEndDateISO,
      reqDateISO,
      reason.trim()
    ]);

    await reconcileProjectExtensionState(projectId);

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'SUBMIT_EXTENSION',
      entityType: 'EXTENSION',
      entityId: rs.lastInsertRowid,
      projectId: Number(projectId),
      summary: `Nộp đề xuất gia hạn Lần ${nextExtNum} cho đề tài ${project.code}`,
      details: { extension_num: nextExtNum, reason: reason.trim(), proposed_end_date: proposedEndDateISO }
    });

    res.json({
      success: true,
      message: `Đã khởi tạo Đề xuất gia hạn Lần ${nextExtNum} (Hạn dự kiến nếu được duyệt: ${projectService.formatDateVN(proposedEndDate)}). Hạn hiện tại của đề tài chỉ thay đổi sau khi Viện trưởng ký Quyết định phê duyệt và P. KH&CN tải lên bản scan có dấu mộc đỏ.`,
      extension_id: rs.lastInsertRowid,
      extension_num: nextExtNum,
      proposed_end_date: proposedEndDateISO,
      proposed_end_date_vn: projectService.formatDateVN(proposedEndDate)
    });
  } catch (err) {
    console.error('Error in POST /api/extensions:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/extensions/item/:extId - Xử lý quy trình Gia hạn theo Vai trò (Sửa đề xuất / Yêu cầu bổ sung / Viện trưởng Phê duyệt hoặc Từ chối)
router.put('/item/:extId', async (req, res) => {
  try {
    await ensureExtensionSchema();
    const { extId } = req.params;
    const {
      action_type, // 'UPDATE_REQUEST' | 'REVISION_NEEDED' | 'APPROVED' | 'REJECTED' | 'REVERT_TO_PENDING'
      reason,
      request_date,
      decision_number,
      decision_date,
      khcn_notes,
      director_opinion,
      reviewed_by
    } = req.body;

    const ext = await db.get('SELECT * FROM nckh_extensions WHERE id = ?', [extId]);
    if (!ext) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ đề xuất gia hạn' });
    }

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [ext.project_id]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }

    const nowISO = projectService.formatDateISO(new Date());
    const reviewerLabel = reviewed_by || 'Phòng KH&CN';

    // KỊCH BẢN 1: Chủ nhiệm (hoặc P. KH&CN) cập nhật lại Lý do đề nghị gia hạn / Ngày làm đơn
    if (action_type === 'UPDATE_REQUEST') {
      if (!reason || !reason.trim()) {
        return res.status(400).json({ success: false, error: 'Vui lòng nhập lý do đề nghị gia hạn' });
      }
      const reqDateISO = request_date
        ? projectService.formatDateISO(projectService.parseDate(request_date))
        : ext.request_date;

      const nextStatus = ext.status === 'REVISION_NEEDED' ? 'PENDING' : ext.status;
      await db.run(`
        UPDATE nckh_extensions
        SET reason = ?, request_date = ?, status = ?
        WHERE id = ?
      `, [reason.trim(), reqDateISO, nextStatus, extId]);

      await reconcileProjectExtensionState(ext.project_id);
      const { logFromRequest } = require('../services/activityLogService');
      await logFromRequest(req, {
        action: 'UPDATE_EXTENSION_REQUEST',
        entityType: 'EXTENSION',
        entityId: Number(extId),
        projectId: Number(ext.project_id),
        summary: `Cập nhật lý do gia hạn Lần ${ext.extension_num} (${project.code})`,
        details: { reason: reason.trim() }
      });
      return res.json({
        success: true,
        message: 'Đã cập nhật nội dung Đơn đề nghị gia hạn.'
      });
    }

    // KỊCH BẢN 2: Phòng KH&CN yêu cầu Chủ nhiệm bổ sung / hoàn thiện hồ sơ trước khi trình Viện trưởng
    if (action_type === 'REVISION_NEEDED') {
      if (!khcn_notes || !khcn_notes.trim()) {
        return res.status(400).json({ success: false, error: 'Vui lòng nhập nội dung yêu cầu Chủ nhiệm bổ sung / chỉnh sửa.' });
      }
      await db.run(`
        UPDATE nckh_extensions
        SET status = 'REVISION_NEEDED',
            khcn_notes = ?,
            reviewed_by = ?,
            reviewed_at = ?
        WHERE id = ?
      `, [khcn_notes.trim(), reviewerLabel, nowISO, extId]);

      await reconcileProjectExtensionState(ext.project_id);
      const { logFromRequest } = require('../services/activityLogService');
      await logFromRequest(req, {
        action: 'REVISION_NEEDED_EXTENSION',
        entityType: 'EXTENSION',
        entityId: Number(extId),
        projectId: Number(ext.project_id),
        summary: `Yêu cầu bổ sung hồ sơ gia hạn Lần ${ext.extension_num} (${project.code})`,
        details: { khcn_notes: khcn_notes.trim() }
      });
      return res.json({
        success: true,
        message: 'Đã chuyển trạng thái sang "Yêu cầu bổ sung hồ sơ gia hạn" để Chủ nhiệm đề tài hoàn thiện.'
      });
    }

    // KỊCH BẢN 3: Viện trưởng KHÔNG PHÊ DUYỆT (Từ chối đơn xin gia hạn)
    if (action_type === 'REJECTED') {
      if (!director_opinion || !director_opinion.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Vui lòng nhập Lý do Viện trưởng không phê duyệt / Ý kiến chỉ đạo để lưu hồ sơ và thông báo cho Chủ nhiệm đề tài.'
        });
      }
      const decDateISO = decision_date
        ? projectService.formatDateISO(projectService.parseDate(decision_date))
        : nowISO;

      await db.run(`
        UPDATE nckh_extensions
        SET status = 'REJECTED',
            decision_number = ?,
            decision_date = ?,
            director_opinion = ?,
            khcn_notes = COALESCE(?, khcn_notes),
            reviewed_by = ?,
            reviewed_at = ?
        WHERE id = ?
      `, [
        decision_number ? decision_number.trim() : null,
        decDateISO,
        director_opinion.trim(),
        khcn_notes ? khcn_notes.trim() : null,
        reviewerLabel,
        nowISO,
        extId
      ]);

      await reconcileProjectExtensionState(ext.project_id);
      const { logFromRequest } = require('../services/activityLogService');
      await logFromRequest(req, {
        action: 'REJECT_EXTENSION',
        entityType: 'EXTENSION',
        entityId: Number(extId),
        projectId: Number(ext.project_id),
        summary: `Không phê duyệt gia hạn Lần ${ext.extension_num} (${project.code})`,
        details: { director_opinion: director_opinion.trim() }
      });
      return res.json({
        success: true,
        message: `Đã ghi nhận kết quả: Viện trưởng KHÔNG phê duyệt đề xuất gia hạn Lần ${ext.extension_num}. Hạn hoàn thành của đề tài giữ nguyên như cũ.`
      });
    }

    // KỊCH BẢN 4: Viện trưởng ĐỒNG Ý PHÊ DUYỆT & Ban hành Quyết định gia hạn có dấu mộc đỏ
    if (action_type === 'APPROVED') {
      if (!decision_number || !decision_number.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Bắt buộc nhập Số Quyết định cho phép gia hạn do Viện trưởng ký (VD: 45/QĐ-TBG).'
        });
      }
      if (!decision_date) {
        return res.status(400).json({
          success: false,
          error: 'Bắt buộc chọn Ngày ký Quyết định gia hạn thực tế.'
        });
      }

      await reconcileProjectExtensionState(ext.project_id);
      const refreshedExt = await db.get('SELECT * FROM nckh_extensions WHERE id = ?', [extId]);
      if (!refreshedExt.decision_file_id) {
        return res.status(400).json({
          success: false,
          error: `Bắt buộc đính kèm bản scan Quyết định cho phép gia hạn Lần ${ext.extension_num} (có chữ ký Viện trưởng & dấu mộc đỏ) trước khi xác nhận hoàn tất phê duyệt.`
        });
      }

      const decDateISO = projectService.formatDateISO(projectService.parseDate(decision_date));

      await db.run(`
        UPDATE nckh_extensions
        SET status = 'APPROVED',
            decision_number = ?,
            decision_date = ?,
            director_opinion = COALESCE(?, director_opinion),
            khcn_notes = COALESCE(?, khcn_notes),
            reviewed_by = ?,
            reviewed_at = ?
        WHERE id = ?
      `, [
        decision_number.trim(),
        decDateISO,
        director_opinion ? director_opinion.trim() : 'Viện trưởng đồng ý phê duyệt gia hạn thời gian thực hiện đề tài (+06 tháng).',
        khcn_notes ? khcn_notes.trim() : null,
        reviewerLabel,
        nowISO,
        extId
      ]);

      // Đánh dấu Quyết định gia hạn ở Giai đoạn 6 là Đã duyệt bản chính (VERIFIED)
      const qdKey = `QD_GIA_HAN_${ext.extension_num || 1}`;
      await db.run(`
        INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
        VALUES (?, ?, 'VERIFIED', ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(project_id, doc_key) DO UPDATE SET
          status = 'VERIFIED',
          verified_by = excluded.verified_by,
          verified_at = excluded.verified_at,
          notes = excluded.notes,
          updated_at = CURRENT_TIMESTAMP
      `, [
        ext.project_id,
        qdKey,
        reviewerLabel,
        nowISO,
        `Quyết định gia hạn số ${decision_number.trim()} ký ngày ${projectService.formatDateVN(projectService.parseDate(decDateISO))}`
      ]);

      const state = await reconcileProjectExtensionState(ext.project_id);

      // Sinh kỳ Báo cáo định kỳ 6 tháng tiếp theo nếu chưa có
      const nextPeriodNum = Math.floor(((Number(project.duration_months) || 12) + ((state ? state.approved_count : 1) * config.EXTENSION_MONTHS)) / config.REPORT_CYCLE_MONTHS);
      const existingRep = await db.get(
        'SELECT id FROM nckh_periodic_reports WHERE project_id = ? AND period_num = ?',
        [ext.project_id, nextPeriodNum]
      );
      if (!existingRep) {
        await db.run(`
          INSERT INTO nckh_periodic_reports (project_id, period_num, due_date, status)
          VALUES (?, ?, ?, 'PENDING')
        `, [ext.project_id, nextPeriodNum, ext.new_end_date]);
      }

      const { logFromRequest } = require('../services/activityLogService');
      await logFromRequest(req, {
        action: 'APPROVE_EXTENSION',
        entityType: 'EXTENSION',
        entityId: Number(extId),
        projectId: Number(ext.project_id),
        summary: `Phê duyệt gia hạn Lần ${ext.extension_num} (${project.code}) - QĐ ${decision_number.trim()}`,
        details: { decision_number: decision_number.trim(), decision_date: decDateISO, new_end_date: ext.new_end_date }
      });

      return res.json({
        success: true,
        message: `Đã phê duyệt chính thức Gia hạn Lần ${ext.extension_num} theo Quyết định số ${decision_number.trim()}! Hạn hoàn thành mới của đề tài: ${projectService.formatDateVN(projectService.parseDate(ext.new_end_date))}.`
      });
    }

    // KỊCH BẢN 5: Phòng KH&CN mở khóa / trả lại trạng thái Đang chờ xử lý (PENDING) nếu khai báo nhầm
    if (action_type === 'REVERT_TO_PENDING') {
      await db.run(`
        UPDATE nckh_extensions
        SET status = 'PENDING',
            decision_number = NULL,
            decision_date = NULL,
            reviewed_by = ?,
            reviewed_at = ?
        WHERE id = ?
      `, [reviewerLabel, nowISO, extId]);

      await reconcileProjectExtensionState(ext.project_id);
      const { logFromRequest } = require('../services/activityLogService');
      await logFromRequest(req, {
        action: 'REVERT_EXTENSION_TO_PENDING',
        entityType: 'EXTENSION',
        entityId: Number(extId),
        projectId: Number(ext.project_id),
        summary: `Mở khóa / Đưa gia hạn Lần ${ext.extension_num} (${project.code}) về trạng thái chờ duyệt`,
        details: { previous_status: ext.status }
      });
      return res.json({
        success: true,
        message: `Đã đưa đợt đề xuất gia hạn Lần ${ext.extension_num} về trạng thái "Đang trình đề xuất (Chờ phê duyệt)" và khôi phục lại hạn hoàn thành trước đó của đề tài.`
      });
    }

    return res.status(400).json({ success: false, error: 'Loại thao tác xử lý gia hạn không hợp lệ.' });
  } catch (err) {
    console.error('Error in PUT /api/extensions/item/:extId:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/extensions/item/:extId - Hủy đề xuất (khi chưa duyệt) hoặc Gỡ bỏ bản ghi gia hạn tạo nhầm (P. KH&CN)
router.delete('/item/:extId', async (req, res) => {
  try {
    await ensureExtensionSchema();
    const { extId } = req.params;
    const ext = await db.get('SELECT * FROM nckh_extensions WHERE id = ?', [extId]);
    if (!ext) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy bản ghi đề xuất gia hạn' });
    }

    await db.run('DELETE FROM nckh_extensions WHERE id = ?', [extId]);
    await reconcileProjectExtensionState(ext.project_id);

    res.json({
      success: true,
      message: `Đã hủy / gỡ bỏ đề xuất gia hạn Lần ${ext.extension_num} và đồng bộ lại thời hạn thực hiện của đề tài.`
    });
  } catch (err) {
    console.error('Error in DELETE /api/extensions/item/:extId:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.reconcileProjectExtensionState = reconcileProjectExtensionState;
router.ensureExtensionSchema = ensureExtensionSchema;

module.exports = router;
