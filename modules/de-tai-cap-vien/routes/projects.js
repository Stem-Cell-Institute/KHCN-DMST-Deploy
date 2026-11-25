const express = require('express');
const router = express.Router();
const db = require('../db/db');
const projectService = require('../services/projectService');
const auditService = require('../services/auditService');
const ownershipService = require('../services/ownershipService');
const { ensureBudgetSupplySchema, computeProjectBudgetAnalytics } = require('../services/budgetSupplyService');

// GET /api/projects/action-center - Dữ liệu bàn làm việc chuyên môn cho Phòng KH&CN
router.get('/action-center', async (req, res) => {
  try {
    // 1. Hồ sơ đề xuất mới nộp chờ sơ duyệt
    let pendingProposals = [];
    try {
      pendingProposals = await db.all(`
        SELECT p.id, p.proposal_code, p.title, p.leader_name, p.research_group, p.submitted_at, p.budget_proposed
        FROM nckh_proposals p
        WHERE p.status = 'SUBMITTED'
        ORDER BY p.id DESC
      `);
    } catch (e) {
      console.warn('nckh_proposals table check:', e.message);
    }

    // 2. Đề tài đang thực hiện và kiểm tra tình trạng thiếu văn bản minh chứng
    const rawProjects = await db.all('SELECT * FROM nckh_projects ORDER BY id DESC');
    const allDocs = await db.all('SELECT project_id, doc_type, stage FROM nckh_documents');
    const docMap = new Map();
    allDocs.forEach(d => {
      if (!docMap.has(d.project_id)) docMap.set(d.project_id, []);
      docMap.get(d.project_id).push(d);
    });

    const missingLegalDocs = [];
    const urgentDeadlines = [];

    rawProjects.forEach(p => {
      const evalStatus = projectService.evaluateStatus(p);
      const docs = docMap.get(p.id) || [];
      const hasContract = docs.some(d => d.doc_type === 'HOP_DONG' || (d.stage === 'KHOI_DONG' && d.doc_type !== 'THUYET_MINH'));
      const hasDecision = !!p.decision_number;

      // Cảnh báo thiếu văn bản pháp lý (Hợp đồng scan hoặc Quyết định giao nhiệm vụ)
      if (p.status !== 'COMPLETED' && p.status !== 'CANCELLED' && (!hasDecision || docs.length < 3)) {
        missingLegalDocs.push({
          id: p.id,
          code: p.code,
          title: p.title,
          leader_name: p.leader_name,
          research_group: p.research_group,
          decision_number: p.decision_number || 'Chưa nhập',
          docs_count: docs.length,
          status_color: evalStatus.status_color
        });
      }

      // Đề tài cần đôn đốc hạn (Đỏ - Quá hạn hoặc Vàng - Sắp hết hạn <= 30 ngày)
      if (evalStatus.status_color === 'RED' || evalStatus.status_color === 'YELLOW') {
        urgentDeadlines.push({
          id: p.id,
          code: p.code,
          title: p.title,
          leader_name: p.leader_name,
          current_end_date_vn: evalStatus.effective_end_date_vn,
          days_remaining: evalStatus.days_remaining,
          status_color: evalStatus.status_color,
          status_label: evalStatus.status_label
        });
      }
    });

    // 3. Tờ trình điều chỉnh dự toán chờ thẩm định
    let pendingAdjustments = [];
    try {
      pendingAdjustments = await db.all(`
        SELECT a.*, p.code as project_code, p.title as project_title, p.leader_name
        FROM nckh_budget_adjustments a
        JOIN nckh_projects p ON a.project_id = p.id
        WHERE a.status = 'PENDING'
      `);
    } catch (e) {
      console.warn('nckh_budget_adjustments check:', e.message);
    }

    res.json({
      success: true,
      data: {
        pending_proposals: pendingProposals,
        missing_legal_docs: missingLegalDocs,
        urgent_deadlines: urgentDeadlines,
        pending_adjustments: pendingAdjustments,
        summary: {
          pending_proposals_cnt: pendingProposals.length,
          missing_legal_docs_cnt: missingLegalDocs.length,
          urgent_deadlines_cnt: urgentDeadlines.length,
          pending_adjustments_cnt: pendingAdjustments.length
        }
      }
    });
  } catch (err) {
    console.error('Error in /api/projects/action-center:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects - Lấy danh sách đề tài kèm tính toán màu cảnh báo
router.get('/', async (req, res) => {
  try {
    const { year, group, leader, color, q, extended } = req.query;

    let sql = 'SELECT * FROM nckh_projects WHERE 1=1';
    const args = [];

    const isRestricted = ownershipService.isRestrictedToOwnProjects(req.user);

    if (group) {
      sql += ' AND research_group = ?';
      args.push(group);
    }
    if (leader && !isRestricted) {
      sql += ' AND leader_name LIKE ?';
      args.push(`%${leader}%`);
    }
    if (q) {
      sql += ' AND (code LIKE ? OR title LIKE ? OR leader_name LIKE ?)';
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }

    sql += ' ORDER BY id DESC';

    let rawProjects = await db.all(sql, args);
    if (isRestricted) {
      rawProjects = ownershipService.filterProjectsForUser(rawProjects, req.user);
    }

    // Lấy thông tin gia hạn mới nhất cho các đề tài để hiển thị chi tiết hạn mới & số QĐ
    const allExtensions = await db.all(`
      SELECT * FROM nckh_extensions ORDER BY extension_num DESC, id DESC
    `);
    const extMap = new Map();
    allExtensions.forEach(ext => {
      if (!extMap.has(ext.project_id)) {
        extMap.set(ext.project_id, {
          ...ext,
          decision_date_vn: projectService.formatDateVN(projectService.parseDate(ext.decision_date)),
          new_end_date_vn: projectService.formatDateVN(projectService.parseDate(ext.new_end_date)),
          previous_end_date_vn: projectService.formatDateVN(projectService.parseDate(ext.previous_end_date)),
          request_date_vn: projectService.formatDateVN(projectService.parseDate(ext.request_date))
        });
      }
    });

    // Lấy thông tin tài liệu, báo cáo, vật tư, checklist, điều chỉnh để tính nhanh tiến độ hồ sơ
    const allDocs = await db.all('SELECT * FROM nckh_documents ORDER BY stage ASC, id DESC');
    const allReps = await db.all('SELECT * FROM nckh_periodic_reports ORDER BY period_num ASC');
    const allSupplies = await db.all('SELECT * FROM nckh_supplies ORDER BY id DESC');
    const allOverrides = await db.all('SELECT * FROM nckh_audit_checklist');
    const allAdjustments = await db.all('SELECT * FROM nckh_budget_adjustments ORDER BY adjustment_num ASC');

    const docsByProj = new Map();
    allDocs.forEach(d => { if (!docsByProj.has(d.project_id)) docsByProj.set(d.project_id, []); docsByProj.get(d.project_id).push(d); });
    const repsByProj = new Map();
    allReps.forEach(r => { if (!repsByProj.has(r.project_id)) repsByProj.set(r.project_id, []); repsByProj.get(r.project_id).push(r); });
    const suppByProj = new Map();
    allSupplies.forEach(s => { if (!suppByProj.has(s.project_id)) suppByProj.set(s.project_id, []); suppByProj.get(s.project_id).push(s); });
    const ovrByProj = new Map();
    allOverrides.forEach(o => { if (!ovrByProj.has(o.project_id)) ovrByProj.set(o.project_id, []); ovrByProj.get(o.project_id).push(o); });
    const adjByProj = new Map();
    allAdjustments.forEach(a => { if (!adjByProj.has(a.project_id)) adjByProj.set(a.project_id, []); adjByProj.get(a.project_id).push(a); });
    const extListByProj = new Map();
    allExtensions.forEach(e => { if (!extListByProj.has(e.project_id)) extListByProj.set(e.project_id, []); extListByProj.get(e.project_id).push(e); });

    // Tính toán trạng thái và màu sắc hạn cho từng đề tài
    let projects = rawProjects.map(p => {
      const evaluation = projectService.evaluateStatus(p);
      const latestExt = extMap.get(p.id) || null;
      const pWithEval = {
        ...p,
        ...evaluation,
        decision_date_vn: projectService.formatDateVN(projectService.parseDate(p.decision_date)),
        base_end_date_vn: projectService.formatDateVN(projectService.parseDate(p.base_end_date)),
        current_end_date_vn: projectService.formatDateVN(projectService.parseDate(p.current_end_date || p.base_end_date)),
        budget_total_formatted: Number(p.budget_total || 0).toLocaleString('vi-VN') + ' đ',
        latest_extension: latestExt
      };

      const audit = auditService.evaluateProjectAudit(
        pWithEval,
        docsByProj.get(p.id) || [],
        extListByProj.get(p.id) || [],
        repsByProj.get(p.id) || [],
        suppByProj.get(p.id) || [],
        ovrByProj.get(p.id) || [],
        adjByProj.get(p.id) || []
      );

      return {
        ...pWithEval,
        audit_summary: {
          completed_count: audit.completed_count,
          total_required: audit.total_required,
          missing_count: audit.missing_count,
          percentage: audit.percentage,
          missing_list: audit.missing_list
        }
      };
    });

    // Lọc theo năm quyết định hoặc năm nộp (nếu có param year)
    if (year) {
      projects = projects.filter(p => {
        const dStr = p.decision_date || p.submission_date || p.code || '';
        return dStr.includes(year) || dStr.includes(`/${year.slice(-2)}`);
      });
    }

    // Lọc theo màu cảnh báo (GREEN, YELLOW, RED, BLUE, GRAY, hoặc EXTENDED)
    if (color) {
      if (color.toUpperCase() === 'EXTENDED') {
        projects = projects.filter(p => (p.extension_count || 0) > 0);
      } else {
        projects = projects.filter(p => p.status_color === color.toUpperCase());
      }
    }

    // Lọc riêng đề tài đã gia hạn
    if (extended === 'true' || extended === '1') {
      projects = projects.filter(p => (p.extension_count || 0) > 0);
    }

    // Sắp xếp ưu tiên: Báo đỏ (Quá hạn) -> Báo vàng (Sắp hết hạn) -> Xanh (Đúng hạn) -> Đã xong
    const priority = { RED: 1, YELLOW: 2, GREEN: 3, BLUE: 4, GRAY: 5 };
    projects.sort((a, b) => (priority[a.status_color] || 99) - (priority[b.status_color] || 99));

    res.json({
      success: true,
      total: projects.length,
      data: projects
    });
  } catch (err) {
    console.error('Error in GET /api/projects:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects/stats - Thống kê KPI tổng quan
router.get('/stats', async (req, res) => {
  try {
    const { leader } = req.query;
    let rawProjects = await db.all('SELECT * FROM nckh_projects');
    if (ownershipService.isRestrictedToOwnProjects(req.user)) {
      rawProjects = ownershipService.filterProjectsForUser(rawProjects, req.user);
    } else if (leader) {
      rawProjects = rawProjects.filter(p => (p.leader_name || '').toLowerCase().includes(leader.toLowerCase()));
    }
    
    let greenCount = 0;
    let yellowCount = 0;
    let redCount = 0;
    let completedCount = 0;
    let cancelledCount = 0;
    let extendedCount = 0;
    let totalBudget = 0;

    rawProjects.forEach(p => {
      const evalStatus = projectService.evaluateStatus(p);
      if (evalStatus.status_color === 'RED') redCount++;
      else if (evalStatus.status_color === 'YELLOW') yellowCount++;
      else if (evalStatus.status_color === 'GREEN') greenCount++;
      else if (evalStatus.status_color === 'BLUE') completedCount++;
      else if (evalStatus.status_color === 'GRAY') cancelledCount++;

      if ((p.extension_count || 0) > 0) extendedCount++;
      totalBudget += Number(p.budget_total || 0);
    });

    // Lấy danh sách nhóm nghiên cứu và số lượng
    const groups = await db.all(`
      SELECT research_group, COUNT(*) as count 
      FROM nckh_projects 
      WHERE research_group IS NOT NULL AND research_group != '' 
      GROUP BY research_group 
      ORDER BY count DESC
    `);

    res.json({
      success: true,
      stats: {
        total_projects: rawProjects.length,
        green_count: greenCount,
        yellow_count: yellowCount,
        red_count: redCount,
        completed_count: completedCount,
        cancelled_count: cancelledCount,
        extended_count: extendedCount,
        total_budget: totalBudget,
        total_budget_formatted: totalBudget.toLocaleString('vi-VN') + ' đ',
        groups
      }
    });
  } catch (err) {
    console.error('Error in GET /api/projects/stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects/:id - Chi tiết 360 độ đề tài
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let project = null;

    if (isNaN(id)) {
      project = await db.get('SELECT * FROM nckh_projects WHERE code = ?', [id]);
    } else {
      project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [id]);
    }

    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }
    if (ownershipService.isRestrictedToOwnProjects(req.user) && !ownershipService.isProjectOwnedByUser(project, req.user)) {
      return res.status(403).json({ success: false, error: 'Bạn chỉ được xem đề tài do mình làm Chủ nhiệm.' });
    }

    const pId = project.id;
    try {
      const extensionsRoute = require('./extensions');
      if (extensionsRoute.ensureExtensionSchema) await extensionsRoute.ensureExtensionSchema();
      if (extensionsRoute.reconcileProjectExtensionState) {
        await extensionsRoute.reconcileProjectExtensionState(pId);
        project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [pId]);
      }
    } catch (e) {
      console.warn('Reconcile extension state warning:', e.message);
    }

    const evaluation = projectService.evaluateStatus(project);

    // Lấy các thực thể liên quan
    const rawDocuments = await db.all('SELECT * FROM nckh_documents WHERE project_id = ? ORDER BY stage ASC, id DESC', [pId]);
    const documents = rawDocuments.map(d => ({
      ...d,
      uploaded_at_vn: projectService.formatDateVN(projectService.parseDate(d.uploaded_at)) || d.uploaded_at || ''
    }));

    const rawReports = await db.all('SELECT * FROM nckh_periodic_reports WHERE project_id = ? ORDER BY period_num ASC', [pId]);
    const reports = rawReports.map(r => ({
      ...r,
      due_date_vn: projectService.formatDateVN(projectService.parseDate(r.due_date)) || r.due_date || '',
      submitted_date_vn: projectService.formatDateVN(projectService.parseDate(r.submitted_date)) || r.submitted_date || '',
      evaluated_at_vn: projectService.formatDateVN(projectService.parseDate(r.evaluated_at)) || r.evaluated_at || ''
    }));

    const rawExtensions = await db.all('SELECT * FROM nckh_extensions WHERE project_id = ? ORDER BY extension_num ASC', [pId]);
    const extensions = rawExtensions.map(e => ({
      ...e,
      decision_date_vn: projectService.formatDateVN(projectService.parseDate(e.decision_date)),
      new_end_date_vn: projectService.formatDateVN(projectService.parseDate(e.new_end_date)),
      previous_end_date_vn: projectService.formatDateVN(projectService.parseDate(e.previous_end_date)),
      request_date_vn: projectService.formatDateVN(projectService.parseDate(e.request_date))
    }));
    await ensureBudgetSupplySchema();
    const budgetItems = await db.all('SELECT * FROM nckh_budget_items WHERE project_id = ? ORDER BY id ASC', [pId]);
    const supplies = await db.all('SELECT * FROM nckh_supplies WHERE project_id = ? ORDER BY id DESC', [pId]);
    const budgetAnalytics = computeProjectBudgetAnalytics(project, budgetItems, supplies, documents);
    const rawOverrides = await db.all('SELECT * FROM nckh_audit_checklist WHERE project_id = ?', [pId]);
    const overrides = rawOverrides.map(o => ({
      ...o,
      verified_at_vn: projectService.formatDateVN(projectService.parseDate(o.verified_at)) || o.verified_at || ''
    }));
    const rawAdjustments = await db.all('SELECT * FROM nckh_budget_adjustments WHERE project_id = ? ORDER BY adjustment_num ASC', [pId]);
    const adjustments = rawAdjustments.map(a => ({
      ...a,
      request_date_vn: projectService.formatDateVN(projectService.parseDate(a.request_date)) || a.request_date || '',
      decision_date_vn: projectService.formatDateVN(projectService.parseDate(a.decision_date)) || a.decision_date || '',
      khcn_reviewed_at_vn: projectService.formatDateVN(projectService.parseDate(a.khcn_reviewed_at)) || a.khcn_reviewed_at || ''
    }));

    // Lấy hồ sơ đề xuất gốc (nếu đề tài được chuyển đổi từ nckh_proposals)
    let proposal = null;
    let proposalFiles = [];
    try {
      proposal = await db.get(
        'SELECT * FROM nckh_proposals WHERE converted_project_id = ? OR title = ? ORDER BY id DESC LIMIT 1',
        [pId, project.title]
      );
      if (proposal) {
        proposalFiles = await db.all('SELECT * FROM nckh_proposal_files WHERE proposal_id = ?', [proposal.id]);
        proposal = {
          ...proposal,
          submitted_at_vn: projectService.formatDateVN(projectService.parseDate(proposal.submitted_at)) || proposal.submitted_at || '',
          khcn_verified_at_vn: projectService.formatDateVN(projectService.parseDate(proposal.khcn_verified_at)) || proposal.khcn_verified_at || '',
          council_date_vn: projectService.formatDateVN(projectService.parseDate(proposal.council_date)) || proposal.council_date || '',
          director_approved_at_vn: projectService.formatDateVN(projectService.parseDate(proposal.director_approved_at)) || proposal.director_approved_at || '',
          files: proposalFiles
        };
      }
    } catch (e) {}

    const pWithEval = {
      ...project,
      ...evaluation,
      submission_date_vn: projectService.formatDateVN(projectService.parseDate(project.submission_date || (proposal && proposal.submitted_at))),
      council_date_vn: projectService.formatDateVN(projectService.parseDate(project.council_date || (proposal && proposal.council_date))),
      decision_date_vn: projectService.formatDateVN(projectService.parseDate(project.decision_date)),
      base_end_date_vn: projectService.formatDateVN(projectService.parseDate(project.base_end_date)),
      current_end_date_vn: projectService.formatDateVN(projectService.parseDate(project.current_end_date || project.base_end_date)),
      budget_total_formatted: Number(project.budget_total || 0).toLocaleString('vi-VN') + ' đ',
    };

    const audit = auditService.evaluateProjectAudit(pWithEval, documents, extensions, reports, supplies, overrides, adjustments);

    // Thống kê nhanh cấp phát hóa chất
    let totalSupplies = supplies.length;
    let fullyFulfilled = supplies.filter(s => s.fulfillment_status === 'Đã nhận đủ').length;
    let inStock = supplies.filter(s => (s.stock_status || '').includes('kho')).length;

    res.json({
      success: true,
      data: {
        ...pWithEval,
        proposal,
        documents,
        reports,
        extensions,
        budget_items: budgetAnalytics.budget_items,
        budget_adjustments: adjustments,
        audit_overrides: overrides,
        supplies: budgetAnalytics.supplies,
        budget_analytics: budgetAnalytics,
        audit,
        supplies_summary: {
          total: totalSupplies,
          fully_fulfilled: fullyFulfilled,
          in_stock: inStock
        }
      }
    });
  } catch (err) {
    console.error('Error in GET /api/projects/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/projects - Tạo mới đề tài
router.post('/', async (req, res) => {
  try {
    const {
      code,
      title,
      leader_name,
      leader_email,
      members,
      category,
      research_group,
      budget_total,
      decision_number,
      decision_date,
      duration_months = 12,
      notes
    } = req.body;

    if (!code || !title || !leader_name) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ Mã đề tài, Tên đề tài và Chủ nhiệm' });
    }

    // Tính toán ngày hết hạn gốc và ngày hết hạn hiện tại
    const endDates = projectService.calculateEndDates(decision_date, duration_months, 0);

    const rs = await db.run(`
      INSERT INTO nckh_projects (
        code, title, leader_name, leader_email, members, category, research_group, 
        budget_total, decision_number, decision_date, duration_months,
        base_end_date, current_end_date, extension_count, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'IN_PROGRESS', ?)
    `, [
      code.trim(),
      title.trim(),
      leader_name.trim(),
      leader_email ? String(leader_email).trim().toLowerCase() : null,
      members || '',
      category || 'Cơ bản',
      research_group || '',
      Number(budget_total) || 0,
      decision_number || '',
      decision_date ? projectService.formatDateISO(projectService.parseDate(decision_date)) : null,
      Number(duration_months) || 12,
      endDates.base_end_date,
      endDates.current_end_date,
      notes || ''
    ]);

    const newProjectId = rs.lastInsertRowid;

    // Tự động khởi tạo các mốc Báo cáo định kỳ 6 tháng/lần
    if (decision_date) {
      const milestones = projectService.generateReportMilestones(decision_date, Number(duration_months) || 12);
      for (const m of milestones) {
        await db.run(`
          INSERT INTO nckh_periodic_reports (project_id, period_num, due_date, status)
          VALUES (?, ?, ?, 'PENDING')
        `, [newProjectId, m.period_num, m.due_date]);
      }
    }

    res.json({
      success: true,
      message: 'Tạo mới đề tài thành công',
      projectId: newProjectId
    });
  } catch (err) {
    console.error('Error in POST /api/projects:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/projects/:id - Cập nhật đề tài
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [id]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }
    if (ownershipService.isRestrictedToOwnProjects(req.user) && !ownershipService.isProjectOwnedByUser(project, req.user)) {
      return res.status(403).json({ success: false, error: 'Bạn chỉ được xem đề tài do mình làm Chủ nhiệm.' });
    }

    const {
      title,
      leader_name,
      leader_email,
      members,
      category,
      research_group,
      budget_total,
      decision_number,
      decision_date,
      duration_months,
      final_evaluation,
      status,
      notes
    } = req.body;

    const newDecisionDate = decision_date ? projectService.formatDateISO(projectService.parseDate(decision_date)) : project.decision_date;
    const newDuration = duration_months ? Number(duration_months) : project.duration_months;
    const extCount = project.extension_count || 0;

    const endDates = projectService.calculateEndDates(newDecisionDate, newDuration, extCount);

    await db.run(`
      UPDATE nckh_projects SET
        title = COALESCE(?, title),
        leader_name = COALESCE(?, leader_name),
        leader_email = COALESCE(?, leader_email),
        members = COALESCE(?, members),
        category = COALESCE(?, category),
        research_group = COALESCE(?, research_group),
        budget_total = COALESCE(?, budget_total),
        decision_number = COALESCE(?, decision_number),
        decision_date = ?,
        duration_months = ?,
        base_end_date = ?,
        current_end_date = ?,
        final_evaluation = COALESCE(?, final_evaluation),
        status = COALESCE(?, status),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      title,
      leader_name,
      leader_email !== undefined ? (leader_email ? String(leader_email).trim().toLowerCase() : '') : null,
      members,
      category,
      research_group,
      budget_total !== undefined ? Number(budget_total) : null,
      decision_number,
      newDecisionDate,
      newDuration,
      endDates.base_end_date,
      endDates.current_end_date,
      final_evaluation,
      status,
      notes,
      id
    ]);

    res.json({ success: true, message: 'Cập nhật đề tài thành công' });
    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'UPDATE_PROJECT',
      entityType: 'PROJECT',
      entityId: Number(id),
      projectId: Number(id),
      summary: `Cập nhật thông tin đề tài #${id} (${title || ''})`,
      details: { status, final_evaluation, budget_total }
    });
  } catch (err) {
    console.error('Error in PUT /api/projects/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects/scheduler/status - Xem trạng thái & cấu hình chu kỳ quét hạn
router.get('/scheduler/status', (req, res) => {
  const schedulerService = require('../services/schedulerService');
  res.json({ success: true, data: schedulerService.getStatus() });
});

// POST /api/projects/scheduler/config - Chỉnh chu kỳ quét hạn (intervalHours, runAtHour, enabled)
router.post('/scheduler/config', async (req, res) => {
  try {
    const userRole = req.user?.role || 'PHONG_KHCN';
    if (!['PHONG_KHCN', 'VIEN_TRUONG', 'SUPER_ADMIN'].includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: 'Chỉ Phòng KHCN, Viện trưởng hoặc Admin mới có quyền chỉnh lịch quét hạn.'
      });
    }
    const schedulerService = require('../services/schedulerService');
    const { enabled, intervalHours, runAtHour } = req.body || {};
    const status = schedulerService.updateSchedule({ enabled, intervalHours, runAtHour });

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'UPDATE_SCHEDULER_CONFIG',
      entityType: 'SYSTEM',
      summary: `Cập nhật lịch quét hạn: ${status.config.enabled ? 'Bật' : 'Tắt'}, chu kỳ ${status.config.intervalHours}h, giờ chạy ${status.config.runAtHour >= 0 ? status.config.runAtHour + ':00' : 'Theo interval'}`,
      details: status.config
    });

    res.json({ success: true, data: status, message: 'Đã cập nhật chu kỳ quét hạn tự động.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/projects/run-deadline-check - Phòng KHCN kích hoạt quét hạn & bắn email nhắc việc ngay
router.post('/run-deadline-check', async (req, res) => {
  try {
    const schedulerService = require('../services/schedulerService');
    const stats = await schedulerService.scanAndSendDeadlineAlerts('MANUAL');
    res.json({
      success: true,
      data: stats,
      message: `Đã hoàn tất quét hạn ${stats.scanned_count} đề tài. Phát ${stats.total_emails_sent} email cảnh báo (30D: ${stats.alerts_30d}, 15D: ${stats.alerts_15d}, 7D: ${stats.alerts_7d}, Quá hạn: ${stats.alerts_overdue}).`
    });
  } catch (err) {
    console.error('Error in POST /api/projects/run-deadline-check:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects/:id/activity-logs - Lấy nhật ký hoạt động của riêng một đề tài
router.get('/:id/activity-logs', async (req, res) => {
  try {
    const { getActivityLogs } = require('../services/activityLogService');
    const logs = await getActivityLogs({
      projectId: req.params.id,
      limit: req.query.limit || 50,
      offset: req.query.offset || 0
    });
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects/:id/export-autofill/:docKey - Tự động điền dữ liệu đề tài vào biểu mẫu chuẩn NĐ 30 & Viện TBG
router.get('/:id/export-autofill/:docKey', async (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const fs = require('fs');

  const { id, docKey } = req.params;
  const recordId = req.query.recordId || req.query.adjId || req.query.extId || req.query.reportId || '';
  const project = await db.get('SELECT code FROM nckh_projects WHERE id = ?', [id]);
  if (!project) return res.status(404).send('Không tìm thấy đề tài');

  const safeCode = project.code.replace(/[\/\\:]/g, '_');
  const tmpFileName = `${safeCode}_${docKey}_${Date.now()}.docx`;
  const tmpPath = path.join(__dirname, '..', 'uploads', tmpFileName);
  const scriptPath = path.join(__dirname, '..', 'scripts', 'export_autofill_doc.py');

  const pyArgs = [scriptPath, String(id), String(docKey), tmpPath];
  if (recordId) pyArgs.push(String(recordId));

  execFile('python', pyArgs, (error, stdout, stderr) => {
    if (error) {
      console.error('Lỗi sinh file tự động điền:', error, stderr);
      return res.status(500).send('Lỗi sinh file tự động: ' + error.message);
    }

    if (!fs.existsSync(tmpPath)) {
      return res.status(500).send('Không tạo được file mẫu');
    }

    const downloadName = `${safeCode}_${docKey}_DienSan.docx`;
    const { logFromRequest } = require('../services/activityLogService');
    logFromRequest(req, {
      action: 'EXPORT_AUTOFILL_DOC',
      entityType: 'DOCUMENT',
      projectId: Number(id),
      summary: `Xuất biểu mẫu tự động điền ${docKey} cho đề tài ${project.code}`,
      details: { docKey, recordId: recordId || null }
    });
    res.download(tmpPath, downloadName, (err) => {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (e) {}
    });
  });
});

module.exports = router;
