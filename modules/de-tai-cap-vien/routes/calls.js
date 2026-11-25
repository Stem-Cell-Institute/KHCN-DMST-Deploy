// Router API Quản lý Đợt Kêu gọi Đề tài & Nộp Hồ sơ Đề xuất Cuốn chiếu
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db/db');
const config = require('../config/config');
const { callService, OFFICIAL_FORMS } = require('../services/callService');
const projectService = require('../services/projectService');

// Cấu hình Multer upload hồ sơ đề xuất
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(config.UPLOAD_DIR, 'proposals');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1E6)}${ext}`;
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

// 1. GET /api/calls/current - Lấy thông tin đợt kêu gọi đang mở & danh mục biểu mẫu chuẩn
router.get('/current', async (req, res) => {
  try {
    const call = await callService.ensureDefaultCall();
    const proposalsCount = await db.get(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) as approved_count FROM nckh_proposals WHERE call_id = ?`,
      [call.id]
    );

    res.json({
      success: true,
      data: {
        call,
        stats: {
          total_proposals: proposalsCount?.total || 0,
          approved_proposals: proposalsCount?.approved_count || 0
        },
        forms: OFFICIAL_FORMS
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. POST /api/calls/:id/toggle-active - Phòng KHCN đóng/mở đợt (khi Viện dừng hoặc tiếp tục tổ chức)
router.post('/:id/toggle-active', async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, close_reason } = req.body;
    const call = await db.get('SELECT * FROM nckh_calls WHERE id = ?', [id]);
    if (!call) return res.status(404).json({ success: false, error: 'Không tìm thấy đợt' });

    const newActive = is_active ? 1 : 0;
    const now = new Date().toISOString();

    await db.run(`
      UPDATE nckh_calls SET
        is_active = ?,
        close_reason = ?,
        closed_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [newActive, newActive ? null : (close_reason || 'Viện tạm dừng tổ chức đề tài cấp cơ sở'), newActive ? null : now, id]);

    let sentCount = 0;
    if (newActive === 1) {
      const updatedCall = await db.get('SELECT * FROM nckh_calls WHERE id = ?', [id]);
      sentCount = await callService.broadcastCallOpenNotification(updatedCall);
    }

    res.json({
      success: true,
      sent_count: sentCount,
      message: newActive
        ? `Đã mở đợt tiếp nhận hồ sơ thành công và tự động phát email thông báo đến ${sentCount} Nhà khoa học & Chủ nhiệm đề tài toàn Viện!`
        : 'Đã đóng đợt tiếp nhận hồ sơ do Viện tạm dừng tổ chức'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2b. POST /api/calls/:id/broadcast-announcement - Phát email thông báo mở đợt đến toàn Viện chủ động
router.post('/:id/broadcast-announcement', async (req, res) => {
  try {
    const { id } = req.params;
    const call = await db.get('SELECT * FROM nckh_calls WHERE id = ?', [id]);
    if (!call) return res.status(404).json({ success: false, error: 'Không tìm thấy đợt' });

    const sentCount = await callService.broadcastCallOpenNotification(call);
    res.json({
      success: true,
      sent_count: sentCount,
      message: `Đã phát email thông báo chính thức đến ${sentCount} Nhà khoa học & Chủ nhiệm đề tài toàn Viện thành công!`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. GET /api/calls/proposals - Lấy danh sách các hồ sơ đề xuất nộp cuốn chiếu
router.get('/proposals', async (req, res) => {
  try {
    const { status, leader, q } = req.query;
    let sql = `
      SELECT p.*, c.call_code, c.title as call_title
      FROM nckh_proposals p
      LEFT JOIN nckh_calls c ON p.call_id = c.id
      WHERE 1=1
    `;
    const args = [];

    if (status) {
      sql += ' AND p.status = ?';
      args.push(status);
    }
    if (leader) {
      sql += ' AND p.leader_name LIKE ?';
      args.push(`%${leader}%`);
    }
    if (q) {
      sql += ' AND (p.proposal_code LIKE ? OR p.title LIKE ? OR p.leader_name LIKE ?)';
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY p.id DESC';

    const proposals = await db.all(sql, args);
    const files = await db.all('SELECT * FROM nckh_proposal_files');
    const fileMap = new Map();
    files.forEach(f => {
      if (!fileMap.has(f.proposal_id)) fileMap.set(f.proposal_id, []);
      fileMap.get(f.proposal_id).push(f);
    });

    const data = proposals.map(p => ({
      ...p,
      budget_proposed_formatted: Number(p.budget_proposed || 0).toLocaleString('vi-VN') + ' đ',
      submitted_at_vn: p.submitted_at ? new Date(p.submitted_at).toLocaleString('vi-VN') : '',
      files: fileMap.get(p.id) || []
    }));

    res.json({ success: true, total: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. POST /api/calls/proposals - Chủ nhiệm Nộp hồ sơ Đề xuất (Kèm file Thuyết minh, Dự toán)
router.post('/proposals', upload.fields([
  { name: 'thuyet_minh_file', maxCount: 1 },
  { name: 'du_toan_file', maxCount: 1 },
  { name: 'ly_lich_file', maxCount: 1 }
]), async (req, res) => {
  try {
    const call = await callService.ensureDefaultCall();
    if (!call.is_active) {
      return res.status(400).json({
        success: false,
        error: 'Đợt kêu gọi đề tài hiện đang tạm dừng đóng do Viện không tổ chức. Không thể tiếp nhận hồ sơ mới.'
      });
    }

    const {
      title,
      leader_name,
      leader_email,
      research_group,
      members,
      duration_months = 12,
      budget_proposed = 50000000,
      summary_target
    } = req.body;

    if (!title || !leader_name) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ Tên đề tài và Họ tên Chủ nhiệm' });
    }

    // Tự động sinh mã tiếp nhận hồ sơ: DX-2025.xxx
    const countRow = await db.get('SELECT COUNT(*) as count FROM nckh_proposals');
    const seq = String((countRow?.count || 0) + 1).padStart(3, '0');
    const proposalCode = `DX-${call.year}.${seq}`;

    const rs = await db.run(`
      INSERT INTO nckh_proposals (
        call_id, proposal_code, title, leader_name, leader_email,
        research_group, members, duration_months, budget_proposed,
        summary_target, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED')
    `, [
      call.id,
      proposalCode,
      title.trim(),
      leader_name.trim(),
      leader_email || '',
      research_group || 'Stem Cell Biology',
      members || '',
      Number(duration_months) || 12,
      Number(budget_proposed) || 0,
      summary_target || ''
    ]);

    const newProposalId = rs.lastInsertRowid;

    // Lưu các file đính kèm
    if (req.files) {
      if (req.files.thuyet_minh_file && req.files.thuyet_minh_file[0]) {
        const f = req.files.thuyet_minh_file[0];
        await db.run(`
          INSERT INTO nckh_proposal_files (proposal_id, file_type, file_name, stored_path, file_size)
          VALUES (?, 'THUYET_MINH', ?, ?, ?)
        `, [newProposalId, f.originalname, path.relative(config.UPLOAD_DIR, f.path).replace(/\\/g, '/'), f.size]);
      }
      if (req.files.du_toan_file && req.files.du_toan_file[0]) {
        const f = req.files.du_toan_file[0];
        await db.run(`
          INSERT INTO nckh_proposal_files (proposal_id, file_type, file_name, stored_path, file_size)
          VALUES (?, 'DU_TOAN', ?, ?, ?)
        `, [newProposalId, f.originalname, path.relative(config.UPLOAD_DIR, f.path).replace(/\\/g, '/'), f.size]);
      }
      if (req.files.ly_lich_file && req.files.ly_lich_file[0]) {
        const f = req.files.ly_lich_file[0];
        await db.run(`
          INSERT INTO nckh_proposal_files (proposal_id, file_type, file_name, stored_path, file_size)
          VALUES (?, 'LY_LICH_KH', ?, ?, ?)
        `, [newProposalId, f.originalname, path.relative(config.UPLOAD_DIR, f.path).replace(/\\/g, '/'), f.size]);
      }
    }

    const proposal = await db.get('SELECT * FROM nckh_proposals WHERE id = ?', [newProposalId]);

    // KÍCH HOẠT QUY TRÌNH CUỐN CHIẾU NGAY: Gửi email xác nhận tiếp nhận cho Chủ nhiệm & Thông báo Phòng KHCN
    await callService.triggerProposalWorkflowEmails(proposal, 'SUBMITTED');

    res.json({
      success: true,
      message: `Đã nộp hồ sơ thành công! Hệ thống đã tiếp nhận và kích hoạt quy trình thẩm tra với Mã hồ sơ: ${proposalCode}`,
      proposalId: newProposalId,
      proposalCode
    });
  } catch (err) {
    console.error('Lỗi nộp hồ sơ đề xuất:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. POST /api/calls/proposals/:id/schedule-council - Phòng KHCN thẩm tra đạt & Lên lịch họp Hội đồng xét duyệt
router.post('/proposals/:id/schedule-council', async (req, res) => {
  try {
    const { id } = req.params;
    const { council_date, khcn_notes } = req.body;

    const proposal = await db.get('SELECT * FROM nckh_proposals WHERE id = ?', [id]);
    if (!proposal) return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ' });

    await db.run(`
      UPDATE nckh_proposals SET
        status = 'COUNCIL_REVIEW',
        council_date = ?,
        khcn_notes = ?,
        khcn_verified_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [council_date || new Date().toISOString().slice(0, 10), khcn_notes || 'Hồ sơ Thuyết minh và Dự toán hợp lệ, chuyển Hội đồng xét duyệt.', id]);

    const updated = await db.get('SELECT * FROM nckh_proposals WHERE id = ?', [id]);
    // Gửi email thông báo lịch Hội đồng cho Chủ nhiệm & Trình Viện trưởng
    await callService.triggerProposalWorkflowEmails(updated, 'COUNCIL_SCHEDULED', { council_date });

    res.json({
      success: true,
      message: 'Đã lên lịch Hội đồng xét duyệt và tự động gửi thư mời qua Email cho Chủ nhiệm đề tài.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. POST /api/calls/proposals/:id/approve - Viện trưởng Phê duyệt Đạt & Tự động Sinh Đề tài Chính thức
router.post('/proposals/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      decision_number,
      decision_date,
      budget_approved,
      council_score,
      council_notes,
      director_decision
    } = req.body;

    const proposal = await db.get('SELECT * FROM nckh_proposals WHERE id = ?', [id]);
    if (!proposal) return res.status(404).json({ success: false, error: 'Không tìm thấy hồ sơ' });

    const decDate = decision_date || new Date().toISOString().slice(0, 10);
    const finalBudget = budget_approved !== undefined ? Number(budget_approved) : Number(proposal.budget_proposed || 50000000);
    const decNumber = decision_number || `QĐ-SCI.${callService.year || '25'}/${id}`;

    // Tính toán hạn thực hiện
    const endDates = projectService.calculateEndDates(decDate, proposal.duration_months || 12, 0);

    // Tự động sinh mã đề tài chính thức: NCKH-SCI.xx/25
    const projCount = await db.get('SELECT COUNT(*) as c FROM nckh_projects');
    const projSeq = String((projCount?.c || 0) + 1).padStart(2, '0');
    const yrSuffix = (new Date().getFullYear()).toString().slice(-2);
    const projectCode = `NCKH-SCI.${projSeq}/${yrSuffix}`;

    // Tạo đề tài chính thức vào nckh_projects
    const projRes = await db.run(`
      INSERT INTO nckh_projects (
        code, title, leader_name, members, category, research_group,
        budget_total, decision_number, decision_date, duration_months,
        base_end_date, current_end_date, extension_count, status, notes
      ) VALUES (?, ?, ?, ?, 'Cơ bản', ?, ?, ?, ?, ?, ?, ?, 0, 'IN_PROGRESS', ?)
    `, [
      projectCode,
      proposal.title,
      proposal.leader_name,
      proposal.members || '',
      proposal.research_group || 'Stem Cell Biology',
      finalBudget,
      decNumber,
      decDate,
      proposal.duration_months || 12,
      endDates.base_end_date,
      endDates.current_end_date,
      `Được chuyển đổi từ Hồ sơ đề xuất trúng tuyển ${proposal.proposal_code}. ${director_decision || ''}`
    ]);

    const newProjectId = projRes.lastInsertRowid;

    // Chuyển các file Thuyết minh/Dự toán sang nckh_documents của đề tài chính thức
    const files = await db.all('SELECT * FROM nckh_proposal_files WHERE proposal_id = ?', [id]);
    for (const f of files) {
      const docType = f.file_type === 'DU_TOAN' ? 'DU_TOAN_DA_DUYET' : 'THUYET_MINH';
      const stage = f.file_type === 'DU_TOAN' ? 3 : 1;
      await db.run(`
        INSERT INTO nckh_documents (
          project_id, stage, doc_type, title, file_name, stored_path, file_size, uploaded_by, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        newProjectId,
        stage,
        docType,
        `${f.file_type === 'DU_TOAN' ? 'Dự toán kinh phí' : 'Thuyết minh đề tài'} - ${proposal.title}`,
        f.file_name,
        f.stored_path,
        f.file_size,
        proposal.leader_name,
        `Chuyển đổi từ hồ sơ đề xuất ${proposal.proposal_code}`
      ]);

      // Đồng bộ sang checklist kiểm toán
      await db.run(`
        INSERT INTO nckh_audit_checklist (project_id, doc_key, status, notes)
        VALUES (?, ?, 'UPLOADED', 'Tự động đồng bộ từ hồ sơ đề xuất ban đầu')
        ON CONFLICT(project_id, doc_key) DO UPDATE SET status = 'UPLOADED', updated_at = CURRENT_TIMESTAMP
      `, [newProjectId, docType]);
    }

    // Tự động sinh mốc báo cáo 6 tháng
    const milestones = projectService.generateReportMilestones(decDate, proposal.duration_months || 12);
    for (const m of milestones) {
      await db.run(`
        INSERT INTO nckh_periodic_reports (project_id, period_num, due_date, status)
        VALUES (?, ?, ?, 'PENDING')
      `, [newProjectId, m.period_num, m.due_date]);
    }

    // Cập nhật trạng thái hồ sơ đề xuất sang APPROVED
    await db.run(`
      UPDATE nckh_proposals SET
        status = 'APPROVED',
        council_score = ?,
        council_result = 'Đạt',
        council_notes = ?,
        director_decision = ?,
        director_approved_at = CURRENT_TIMESTAMP,
        converted_project_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [council_score || 85, council_notes || 'Hội đồng thống nhất thông qua đề tài.', director_decision || 'Viện trưởng phê duyệt giao nhiệm vụ.', newProjectId, id]);

    const updated = await db.get('SELECT * FROM nckh_proposals WHERE id = ?', [id]);
    // Kích hoạt chuỗi Email thông báo Chúc mừng Chủ nhiệm & Báo Phòng TC-CU chuẩn bị Hợp đồng
    await callService.triggerProposalWorkflowEmails(updated, 'APPROVED', {
      decision_number: decNumber,
      budget: finalBudget,
      projectId: newProjectId
    });

    res.json({
      success: true,
      message: `Đã phê duyệt đề tài thành công! Hệ thống đã tạo Đề tài chính thức: ${projectCode} và thông báo Email cho các bộ phận.`,
      projectId: newProjectId,
      projectCode
    });
  } catch (err) {
    console.error('Lỗi phê duyệt đề tài:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. GET /api/calls/email-logs - Xem nhật ký gửi email thông báo
router.get('/email-logs', async (req, res) => {
  try {
    const logs = await db.all('SELECT * FROM nckh_email_logs ORDER BY id DESC LIMIT 50');
    res.json({ success: true, total: logs.length, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. GET /api/calls/download-template/:formCode - Tải file mẫu chuẩn NĐ 30 & Viện TBG
router.get('/download-template/:formCode', (req, res) => {
  const { formCode } = req.params;
  const form = OFFICIAL_FORMS.find(f => f.code === formCode);
  if (!form || !form.file_name) {
    return res.status(404).send('Không tìm thấy biểu mẫu');
  }
  const filePath = path.join(__dirname, '..', 'Bieu_mau_chuan_Nghi_dinh_30', form.file_name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File biểu mẫu chưa được khởi tạo');
  }
  res.download(filePath, form.file_name);
});

module.exports = router;
