const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { logFromRequest } = require('../services/activityLogService');

async function getOrCreateAcceptance(projectId) {
  let row = await db.get('SELECT * FROM nckh_acceptances WHERE project_id = ?', [projectId]);
  if (!row) {
    await db.run(
      `INSERT INTO nckh_acceptances (project_id, stage_status) VALUES (?, 'DRAFT')`,
      [projectId]
    );
    row = await db.get('SELECT * FROM nckh_acceptances WHERE project_id = ?', [projectId]);
  }
  return row;
}

// GET /api/acceptances - Danh sách hồ sơ nghiệm thu - thanh lý toàn Viện
router.get('/', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT a.*, p.code AS project_code, p.title AS project_title, p.leader_name,
              p.research_group, p.budget_total, p.status AS project_status, p.current_end_date
       FROM nckh_acceptances a
       JOIN nckh_projects p ON a.project_id = p.id
       ORDER BY a.updated_at DESC, a.id DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/acceptances/project/:projectId - Chi tiết hồ sơ nghiệm thu & điều kiện tiền kiểm
router.get('/project/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });
    }

    const acceptance = await db.get('SELECT * FROM nckh_acceptances WHERE project_id = ?', [projectId]);
    const products = await db.all('SELECT * FROM nckh_products WHERE project_id = ?', [projectId]);
    const reports = await db.all('SELECT id, period_num, status FROM nckh_periodic_reports WHERE project_id = ?', [projectId]);
    const docs = await db.all('SELECT doc_type FROM nckh_documents WHERE project_id = ?', [projectId]);

    const preconditions = {
      products_count: products.length,
      verified_products_count: products.filter(p => !!p.verified_at).length,
      approved_reports_count: reports.filter(r => r.status === 'APPROVED').length,
      total_reports_count: reports.length,
      has_final_report_doc: docs.some(d => (d.doc_type || '').includes('TONG_KET'))
    };

    res.json({
      success: true,
      data: acceptance || { project_id: Number(projectId), stage_status: 'DRAFT' },
      preconditions
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1. Chủ nhiệm nộp Đơn đề nghị nghiệm thu
router.post('/project/:projectId/request', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { request_date } = req.body || {};
    const project = await db.get('SELECT id, code FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });

    await getOrCreateAcceptance(projectId);
    const reqDate = request_date || new Date().toISOString().slice(0, 10);
    const actor = req.user?.fullname || 'Chủ nhiệm đề tài';

    await db.run(
      `UPDATE nckh_acceptances
       SET stage_status = 'REQUESTED', request_date = ?, requested_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?`,
      [reqDate, actor, projectId]
    );

    await logFromRequest(req, {
      action: 'ACCEPTANCE_REQUEST',
      entityType: 'ACCEPTANCE',
      projectId: Number(projectId),
      summary: `Nộp Đơn đề nghị nghiệm thu đề tài ${project.code}`
    });

    res.json({ success: true, message: 'Đã nộp Đơn đề nghị nghiệm thu. Chờ Phòng KHCN kiểm tra điều kiện.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. P. KHCN kiểm tra đủ điều kiện nghiệm thu
router.post('/project/:projectId/khcn-check', async (req, res) => {
  try {
    const userRole = req.user?.role || 'PHONG_KHCN';
    if (!['PHONG_KHCN', 'SUPER_ADMIN', 'VIEN_TRUONG'].includes(userRole)) {
      return res.status(403).json({ success: false, error: 'Chỉ Phòng KHCN mới có quyền kiểm tra điều kiện nghiệm thu.' });
    }
    const { projectId } = req.params;
    const { khcn_notes = '' } = req.body || {};
    const project = await db.get('SELECT id, code FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });

    await getOrCreateAcceptance(projectId);
    const checker = req.user?.fullname || 'Phòng KHCN';
    const now = new Date().toISOString();

    await db.run(
      `UPDATE nckh_acceptances
       SET stage_status = 'KHCN_CHECKED', khcn_checked_by = ?, khcn_checked_at = ?, khcn_notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?`,
      [checker, now, khcn_notes, projectId]
    );

    await logFromRequest(req, {
      action: 'ACCEPTANCE_KHCN_CHECK',
      entityType: 'ACCEPTANCE',
      projectId: Number(projectId),
      summary: `P. KHCN xác nhận đủ điều kiện nghiệm thu đề tài ${project.code}`,
      details: { khcn_notes }
    });

    res.json({ success: true, message: 'Đã xác nhận đề tài đủ điều kiện lập Hội đồng nghiệm thu.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Lập lịch hoặc ghi nhận kết quả Hội đồng nghiệm thu
router.post('/project/:projectId/council', async (req, res) => {
  try {
    const userRole = req.user?.role || 'PHONG_KHCN';
    if (!['PHONG_KHCN', 'SUPER_ADMIN', 'VIEN_TRUONG'].includes(userRole)) {
      return res.status(403).json({ success: false, error: 'Chỉ Phòng KHCN hoặc Viện trưởng mới có quyền cập nhật Hội đồng nghiệm thu.' });
    }
    const { projectId } = req.params;
    const {
      council_date,
      council_location = '',
      council_chair = '',
      council_members = '',
      council_score = null,
      council_rating = '',
      council_conclusion = ''
    } = req.body || {};

    const project = await db.get('SELECT id, code FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });

    await getOrCreateAcceptance(projectId);
    const hasResult = council_score !== null && council_score !== '' || !!council_rating;
    const nextStage = hasResult ? 'COUNCIL_EVALUATED' : 'COUNCIL_SCHEDULED';

    await db.run(
      `UPDATE nckh_acceptances
       SET stage_status = ?, council_date = ?, council_location = ?, council_chair = ?,
           council_members = ?, council_score = ?, council_rating = ?, council_conclusion = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?`,
      [
        nextStage,
        council_date || null,
        council_location,
        council_chair,
        council_members,
        council_score !== null && council_score !== '' ? Number(council_score) : null,
        council_rating,
        council_conclusion,
        projectId
      ]
    );

    if (hasResult) {
      await db.run(
        `INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
         VALUES (?, 'BB_NGHIEM_THU', 'VERIFIED', ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(project_id, doc_key) DO UPDATE SET
           status = 'VERIFIED', verified_by = excluded.verified_by, verified_at = CURRENT_TIMESTAMP, notes = excluded.notes`,
        [projectId, req.user?.fullname || 'Phòng KHCN', `Kết quả HĐ: ${council_rating} (${council_score || '--'} điểm)`]
      );
    }

    await logFromRequest(req, {
      action: hasResult ? 'ACCEPTANCE_COUNCIL_EVALUATED' : 'ACCEPTANCE_COUNCIL_SCHEDULED',
      entityType: 'ACCEPTANCE',
      projectId: Number(projectId),
      summary: hasResult
        ? `Ghi nhận kết quả Hội đồng nghiệm thu ${project.code}: ${council_rating} (${council_score || '--'}đ)`
        : `Lập lịch Hội đồng nghiệm thu ${project.code} ngày ${council_date || ''}`,
      details: { council_date, council_score, council_rating }
    });

    res.json({
      success: true,
      message: hasResult ? 'Đã lưu kết quả đánh giá của Hội đồng nghiệm thu.' : 'Đã lập lịch Hội đồng nghiệm thu.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Chủ nhiệm nộp Bản giải trình tiếp thu sau họp Hội đồng
router.post('/project/:projectId/revision', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { revision_summary = '' } = req.body || {};
    const project = await db.get('SELECT id, code FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });

    await getOrCreateAcceptance(projectId);
    const now = new Date().toISOString();

    await db.run(
      `UPDATE nckh_acceptances
       SET stage_status = 'REVISION_SUBMITTED', revision_summary = ?, revision_submitted_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?`,
      [revision_summary, now, projectId]
    );

    await logFromRequest(req, {
      action: 'ACCEPTANCE_REVISION_SUBMITTED',
      entityType: 'ACCEPTANCE',
      projectId: Number(projectId),
      summary: `Nộp Bản giải trình tiếp thu sau họp Hội đồng (${project.code})`,
      details: { revision_summary }
    });

    res.json({ success: true, message: 'Đã ghi nhận Bản giải trình tiếp thu chỉnh sửa sau nghiệm thu.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Viện trưởng ký Quyết định công nhận kết quả nghiệm thu
router.post('/project/:projectId/recognize', async (req, res) => {
  try {
    const userRole = req.user?.role || 'PHONG_KHCN';
    if (!['VIEN_TRUONG', 'PHONG_KHCN', 'SUPER_ADMIN'].includes(userRole)) {
      return res.status(403).json({ success: false, error: 'Chỉ Viện trưởng hoặc Phòng KHCN mới có quyền ban hành QĐ công nhận.' });
    }
    const { projectId } = req.params;
    const { recognition_decision_number, recognition_decision_date } = req.body || {};
    if (!recognition_decision_number) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập Số Quyết định công nhận kết quả.' });
    }

    const project = await db.get('SELECT id, code FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });

    await getOrCreateAcceptance(projectId);
    const decDate = recognition_decision_date || new Date().toISOString().slice(0, 10);

    await db.run(
      `UPDATE nckh_acceptances
       SET stage_status = 'RECOGNIZED', recognition_decision_number = ?, recognition_decision_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?`,
      [recognition_decision_number, decDate, projectId]
    );

    await db.run(
      `INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
       VALUES (?, 'QD_CONG_NHAN', 'VERIFIED', ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, doc_key) DO UPDATE SET
         status = 'VERIFIED', verified_by = excluded.verified_by, verified_at = CURRENT_TIMESTAMP, notes = excluded.notes`,
      [projectId, req.user?.fullname || 'Viện trưởng', `QĐ số ${recognition_decision_number} ngày ${decDate}`]
    );

    await logFromRequest(req, {
      action: 'ACCEPTANCE_RECOGNIZED',
      entityType: 'ACCEPTANCE',
      projectId: Number(projectId),
      summary: `Ban hành QĐ công nhận kết quả ${project.code} (Số ${recognition_decision_number})`,
      details: { recognition_decision_number, recognition_decision_date: decDate }
    });

    res.json({ success: true, message: 'Đã ghi nhận Quyết định công nhận kết quả nghiệm thu.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Thanh lý Hợp đồng khép kín (Hoàn tất hoặc Chấm dứt/Hủy đề tài)
router.post('/project/:projectId/liquidate', async (req, res) => {
  try {
    const userRole = req.user?.role || 'PHONG_KHCN';
    if (!['VIEN_TRUONG', 'PHONG_KHCN', 'PHONG_TC_CU', 'SUPER_ADMIN'].includes(userRole)) {
      return res.status(403).json({ success: false, error: 'Không có quyền thực hiện thanh lý hợp đồng.' });
    }
    const { projectId } = req.params;
    const {
      liquidation_date,
      liquidation_settled_amount = 0,
      liquidation_refund_amount = 0,
      liquidation_notes = '',
      outcome = 'COMPLETED' // 'COMPLETED' | 'CANCELLED'
    } = req.body || {};

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });

    await getOrCreateAcceptance(projectId);
    const liqDate = liquidation_date || new Date().toISOString().slice(0, 10);
    const isCancel = String(outcome).toUpperCase() === 'CANCELLED';
    const nextStage = isCancel ? 'CANCELLED_LIQUIDATION' : 'LIQUIDATED';
    const nextProjStatus = isCancel ? 'CANCELLED' : 'COMPLETED';
    const finalEval = isCancel ? 'Hủy đề tài / Thanh lý chấm dứt' : 'Đã nghiệm thu & Thanh lý';

    await db.run(
      `UPDATE nckh_acceptances
       SET stage_status = ?, liquidation_date = ?, liquidation_settled_amount = ?,
           liquidation_refund_amount = ?, liquidation_notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?`,
      [
        nextStage,
        liqDate,
        Number(liquidation_settled_amount) || 0,
        Number(liquidation_refund_amount) || 0,
        liquidation_notes,
        projectId
      ]
    );

    await db.run(
      `UPDATE nckh_projects
       SET status = ?, final_evaluation = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextProjStatus, finalEval, projectId]
    );

    await db.run(
      `INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
       VALUES (?, 'BB_THANH_LY', 'VERIFIED', ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, doc_key) DO UPDATE SET
         status = 'VERIFIED', verified_by = excluded.verified_by, verified_at = CURRENT_TIMESTAMP, notes = excluded.notes`,
      [projectId, req.user?.fullname || 'Phòng KHCN', `Thanh lý ngày ${liqDate} (${finalEval})`]
    );

    await logFromRequest(req, {
      action: 'ACCEPTANCE_LIQUIDATED',
      entityType: 'ACCEPTANCE',
      projectId: Number(projectId),
      summary: `Hoàn tất Thanh lý Hợp đồng đề tài ${project.code} (${finalEval})`,
      details: { liqDate, liquidation_settled_amount, liquidation_refund_amount, outcome: nextProjStatus }
    });

    res.json({
      success: true,
      message: `Đã hoàn tất thanh lý hợp đồng và cập nhật trạng thái đề tài sang ${nextProjStatus}.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
