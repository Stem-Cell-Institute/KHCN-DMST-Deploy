const express = require('express');
const router = express.Router();
const db = require('../db/db');
const projectService = require('../services/projectService');
const { callService } = require('../services/callService');
const { DEMO_PROFILES } = require('../config/roles');

// GET /api/reports/project/:projectId - Danh sách các đợt nộp báo cáo định kỳ 6 tháng
router.get('/project/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const reports = await db.all(`
      SELECT r.*, 
             doc_rep.file_name as report_file_name, doc_rep.stored_path as report_stored_path,
             doc_evi.file_name as evidence_file_name, doc_evi.stored_path as evidence_stored_path
      FROM nckh_periodic_reports r
      LEFT JOIN nckh_documents doc_rep ON r.report_file_id = doc_rep.id
      LEFT JOIN nckh_documents doc_evi ON r.evidence_file_id = doc_evi.id
      WHERE r.project_id = ?
      ORDER BY r.period_num ASC
    `, [projectId]);

    const formatted = reports.map(r => ({
      ...r,
      due_date_vn: projectService.formatDateVN(projectService.parseDate(r.due_date)),
      submitted_date_vn: r.submitted_date ? projectService.formatDateVN(projectService.parseDate(r.submitted_date)) : ''
    }));

    res.json({ success: true, data: formatted });
  } catch (err) {
    console.error('Error fetching reports:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/reports/:id/submit - Chủ nhiệm nộp Báo cáo tiến độ định kỳ 6 tháng
router.post('/:id/submit', async (req, res) => {
  try {
    const { id } = req.params;
    const { progress_summary, progress_percent, report_file_id, evidence_file_id } = req.body;

    const report = await db.get('SELECT * FROM nckh_periodic_reports WHERE id = ?', [id]);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy kỳ báo cáo' });
    }

    const todayISO = projectService.formatDateISO(new Date());

    await db.run(`
      UPDATE nckh_periodic_reports SET
        submitted_date = ?,
        status = 'SUBMITTED',
        progress_summary = ?,
        progress_percent = ?,
        report_file_id = COALESCE(?, report_file_id),
        evidence_file_id = COALESCE(?, evidence_file_id)
      WHERE id = ?
    `, [
      todayISO,
      progress_summary || '',
      Number(progress_percent) || 0,
      report_file_id || null,
      evidence_file_id || null,
      id
    ]);

    // Tự động bắn email thông báo cho Phòng KHCN vào Bàn làm việc thẩm tra
    try {
      const project = await db.get('SELECT id, code, title, leader_name FROM nckh_projects WHERE id = ?', [report.project_id]);
      const khcnProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_KHCN') || { fullname: 'Phòng KHCN & ĐN', email: 'khcn@sci.edu.vn' };
      if (project) {
        await callService.sendNotification({
          eventType: 'NEW_PERIODIC_REPORT_SUBMITTED',
          recipientRole: 'PHONG_KHCN',
          recipientEmail: khcnProfile.email,
          recipientName: khcnProfile.fullname,
          subject: `[Bàn làm việc KHCN] Đã nộp Báo cáo Tiến độ Đợt ${report.period_num} - Đề tài: ${project.code}`,
          bodyHtml: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #334155;">
              <h3 style="color: #0284c7;">Thông báo Nộp Báo cáo Tiến độ Định kỳ</h3>
              <p>Kính gửi <strong>Chuyên viên Phòng KHCN & ĐN</strong>,</p>
              <p>Chủ nhiệm đề tài <strong>${project.leader_name}</strong> vừa nộp Báo cáo tiến độ định kỳ 6 tháng (Đợt ${report.period_num}) cho đề tài <strong>${project.code}</strong>:</p>
              <ul style="line-height: 1.8;">
                <li><strong>Tên đề tài:</strong> ${project.title}</li>
                <li><strong>Khối lượng hoàn thành:</strong> ${Number(progress_percent) || 0}%</li>
                <li><strong>Tóm tắt tiến độ:</strong> ${progress_summary || 'Đã nộp báo cáo đợt ' + report.period_num}</li>
              </ul>
              <p>Đề nghị Phòng KHCN truy cập Bàn làm việc để thẩm tra và xác nhận tiến độ:</p>
              <p><a href="http://localhost:3005/ban-lam-viec-khcn.html" style="display: inline-block; background: #0284c7; color: white; padding: 8px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">Mở Bàn làm việc P. KHCN &rarr;</a></p>
            </div>
          `,
          actionUrl: `/ban-lam-viec-khcn.html`,
          relatedProjectId: project.id
        });
      }
    } catch (eMailErr) {
      console.warn('Lỗi gửi email nộp báo cáo:', eMailErr.message);
    }

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'SUBMIT_REPORT',
      entityType: 'REPORT',
      entityId: Number(id),
      projectId: Number(report.project_id),
      summary: `Nộp báo cáo định kỳ 6 tháng (Kỳ ${report.period_num}) - Tiến độ ${progress_percent || 0}%`,
      details: { period_num: report.period_num, progress_percent, progress_summary }
    });

    res.json({
      success: true,
      message: 'Nộp báo cáo định kỳ 6 tháng thành công',
      submitted_date: todayISO
    });
  } catch (err) {
    console.error('Error submitting report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/reports/:id/evaluate - P. KHCN thẩm định / đánh giá báo cáo
router.put('/:id/evaluate', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, khcn_evaluation } = req.body; // status: 'APPROVED' hoặc 'REVISION_NEEDED'

    const report = await db.get('SELECT * FROM nckh_periodic_reports WHERE id = ?', [id]);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy kỳ báo cáo' });
    }

    const todayISO = projectService.formatDateISO(new Date());

    await db.run(`
      UPDATE nckh_periodic_reports SET
        status = ?,
        khcn_evaluation = ?,
        evaluated_by = ?,
        evaluated_at = ?
      WHERE id = ?
    `, [
      status || 'APPROVED',
      khcn_evaluation || '',
      req.user?.fullname || 'Cán bộ P. KHCN',
      todayISO,
      id
    ]);

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'EVALUATE_REPORT',
      entityType: 'REPORT',
      entityId: Number(id),
      projectId: Number(report.project_id),
      summary: `Đánh giá báo cáo Kỳ ${report.period_num} -> ${status || 'APPROVED'}`,
      details: { status: status || 'APPROVED', khcn_evaluation }
    });

    res.json({
      success: true,
      message: 'Đánh giá báo cáo thành công',
      status
    });
  } catch (err) {
    console.error('Error evaluating report:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
