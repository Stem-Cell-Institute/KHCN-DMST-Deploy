const express = require('express');
const router = express.Router();
const db = require('../db/db');
const auditService = require('../services/auditService');
const projectService = require('../services/projectService');
const reportGenerator = require('../services/reportGenerator');
const ownershipService = require('../services/ownershipService');

// Helper lấy toàn bộ dữ liệu audit cho các đề tài (tự lọc theo chủ sở hữu nếu là CHU_NHIEM)
async function loadAuditData(projectId = null, user = null) {
  let projectSql = 'SELECT * FROM nckh_projects';
  const args = [];
  if (projectId) {
    projectSql += ' WHERE id = ?';
    args.push(projectId);
  } else {
    projectSql += ' ORDER BY id DESC';
  }

  let rawProjects = await db.all(projectSql, args);
  if (user && ownershipService.isRestrictedToOwnProjects(user)) {
    rawProjects = ownershipService.filterProjectsForUser(rawProjects, user);
  }
  const allDocs = await db.all('SELECT * FROM nckh_documents ORDER BY stage ASC, id DESC');
  const allExts = await db.all('SELECT * FROM nckh_extensions ORDER BY extension_num ASC');
  const allReps = await db.all('SELECT * FROM nckh_periodic_reports ORDER BY period_num ASC');
  const allSupplies = await db.all('SELECT * FROM nckh_supplies ORDER BY id DESC');
  const allOverrides = await db.all('SELECT * FROM nckh_audit_checklist');
  const allAdjustments = await db.all('SELECT * FROM nckh_budget_adjustments ORDER BY adjustment_num ASC');

  // Nhóm theo project_id
  const docsByProj = new Map();
  allDocs.forEach(d => {
    if (!docsByProj.has(d.project_id)) docsByProj.set(d.project_id, []);
    docsByProj.get(d.project_id).push(d);
  });

  const extsByProj = new Map();
  allExts.forEach(e => {
    if (!extsByProj.has(e.project_id)) extsByProj.set(e.project_id, []);
    extsByProj.get(e.project_id).push(e);
  });

  const repsByProj = new Map();
  allReps.forEach(r => {
    if (!repsByProj.has(r.project_id)) repsByProj.set(r.project_id, []);
    repsByProj.get(r.project_id).push(r);
  });

  const suppliesByProj = new Map();
  allSupplies.forEach(s => {
    if (!suppliesByProj.has(s.project_id)) suppliesByProj.set(s.project_id, []);
    suppliesByProj.get(s.project_id).push(s);
  });

  const overridesByProj = new Map();
  allOverrides.forEach(o => {
    if (!overridesByProj.has(o.project_id)) overridesByProj.set(o.project_id, []);
    overridesByProj.get(o.project_id).push(o);
  });

  const adjustmentsByProj = new Map();
  allAdjustments.forEach(a => {
    if (!adjustmentsByProj.has(a.project_id)) adjustmentsByProj.set(a.project_id, []);
    adjustmentsByProj.get(a.project_id).push(a);
  });

  return rawProjects.map(p => {
    const evaluation = projectService.evaluateStatus(p);
    const pWithEval = {
      ...p,
      ...evaluation,
      decision_date_vn: projectService.formatDateVN(projectService.parseDate(p.decision_date)),
      current_end_date_vn: projectService.formatDateVN(projectService.parseDate(p.current_end_date || p.base_end_date)),
      base_end_date_vn: projectService.formatDateVN(projectService.parseDate(p.base_end_date)),
      budget_total_formatted: Number(p.budget_total || 0).toLocaleString('vi-VN') + ' đ'
    };

    const docs = docsByProj.get(p.id) || [];
    const exts = extsByProj.get(p.id) || [];
    const reps = repsByProj.get(p.id) || [];
    const supp = suppliesByProj.get(p.id) || [];
    const ovr = overridesByProj.get(p.id) || [];
    const adjs = adjustmentsByProj.get(p.id) || [];

    const audit = auditService.evaluateProjectAudit(pWithEval, docs, exts, reps, supp, ovr, adjs);
    return {
      ...pWithEval,
      audit
    };
  });
}

// GET /api/audit/summary - Thống kê KPI & Thống kê thiếu/đủ theo từng loại văn bản toàn Viện
router.get('/summary', async (req, res) => {
  try {
    let evaluatedProjects = await loadAuditData(null, req.user);
    const { leader } = req.query;

    if (leader) {
      const lLow = leader.toLowerCase().trim();
      evaluatedProjects = evaluatedProjects.filter(p => (p.leader_name || '').toLowerCase().includes(lLow));
    }

    let totalProjects = evaluatedProjects.length;
    let fullAuditReady = 0;
    let missingLiquidation = 0;
    let extendedNeedsDocs = 0;
    let missingBasicDocs = 0;
    let sumPercentage = 0;

    // Thống kê theo từng loại văn bản trên toàn Viện
    const criteriaStatsMap = new Map();
    auditService.AUDIT_CRITERIA.forEach(c => {
      criteriaStatsMap.set(c.key, {
        key: c.key,
        name: c.name,
        short_name: c.short_name,
        stage: c.stage,
        group: c.group,
        owner_role: c.owner_role,
        owner_label: c.owner_label,
        icon: c.icon,
        submitted_count: 0,
        missing_count: 0,
        not_required_count: 0
      });
    });

    evaluatedProjects.forEach(p => {
      sumPercentage += p.audit.percentage;
      if (p.audit.percentage === 100) fullAuditReady++;
      if (p.audit.audit_status === 'MISSING_LIQUIDATION' || (p.audit.is_completed && p.audit.missing_for_liquidation.length > 0)) {
        missingLiquidation++;
      }
      if (p.audit.is_extended) {
        extendedNeedsDocs++;
      }
      if (p.audit.missing_list.some(m => m.includes('Thuyết minh') || m.includes('Dự toán') || m.includes('Hợp đồng'))) {
        missingBasicDocs++;
      }

      p.audit.items.forEach(item => {
        const st = criteriaStatsMap.get(item.key);
        if (!st) return;
        if (item.status === 'UPLOADED' || item.status === 'VERIFIED') {
          st.submitted_count++;
        } else if (item.status === 'MISSING') {
          st.missing_count++;
        } else {
          st.not_required_count++;
        }
      });
    });

    const avgCompliance = totalProjects > 0 ? Math.round(sumPercentage / totalProjects) : 0;

    res.json({
      success: true,
      data: {
        total_projects: totalProjects,
        full_audit_ready: fullAuditReady,
        missing_liquidation: missingLiquidation,
        extended_needs_docs: extendedNeedsDocs,
        missing_basic_docs: missingBasicDocs,
        avg_compliance: avgCompliance,
        criteria_breakdown: Array.from(criteriaStatsMap.values())
      }
    });
  } catch (err) {
    console.error('Error in GET /api/audit/summary:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/audit/export-html - Xuất file Báo cáo Kiểm toán dạng HTML độc lập
router.get('/export-html', async (req, res) => {
  try {
    const list = await loadAuditData(null, req.user);
    let totalProjects = list.length;
    let fullAuditReady = 0;
    let missingLiquidation = 0;
    let extendedNeedsDocs = 0;
    let sumPercentage = 0;

    list.forEach(p => {
      sumPercentage += p.audit.percentage;
      if (p.audit.percentage === 100) fullAuditReady++;
      if (p.audit.audit_status === 'MISSING_LIQUIDATION' || (p.audit.is_completed && p.audit.missing_for_liquidation.length > 0)) {
        missingLiquidation++;
      }
      if (p.audit.is_extended) {
        extendedNeedsDocs++;
      }
    });

    const summary = {
      total_projects: totalProjects,
      full_audit_ready: fullAuditReady,
      missing_liquidation: missingLiquidation,
      extended_needs_docs: extendedNeedsDocs,
      avg_compliance: totalProjects > 0 ? Math.round(sumPercentage / totalProjects) : 0
    };

    const htmlContent = reportGenerator.generateAuditHtmlReport(list, summary);

    if (req.query.download === '1' || req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="Bao_cao_kiem_toan_ho_so_de_tai_SCI_${new Date().toISOString().slice(0, 10)}.html"`);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlContent);
  } catch (err) {
    console.error('Error in GET /api/audit/export-html:', err);
    res.status(500).send('Lỗi sinh báo cáo HTML: ' + err.message);
  }
});

// GET /api/audit/projects - Danh sách ma trận hồ sơ kiểm toán tất cả đề tài
router.get('/projects', async (req, res) => {
  try {
    const { status, group, q, missing_key, leader } = req.query;
    let list = await loadAuditData(null, req.user);

    // Lọc theo Chủ nhiệm đề tài (chỉ áp dụng cho vai trò quản lý; CHU_NHIEM đã khóa cứng trong loadAuditData)
    if (leader && !ownershipService.isRestrictedToOwnProjects(req.user)) {
      const lLow = leader.toLowerCase().trim();
      list = list.filter(p => (p.leader_name || '').toLowerCase().includes(lLow));
    }

    // Lọc theo nhóm nghiên cứu
    if (group) {
      list = list.filter(p => p.research_group === group);
    }

    // Lọc theo từ khóa tìm kiếm
    if (q) {
      const qLow = q.toLowerCase();
      list = list.filter(p => 
        (p.code || '').toLowerCase().includes(qLow) ||
        (p.title || '').toLowerCase().includes(qLow) ||
        (p.leader_name || '').toLowerCase().includes(qLow)
      );
    }

    // Lọc theo loại văn bản cụ thể đang thiếu (missing_key)
    if (missing_key) {
      list = list.filter(p =>
        p.audit.items.some(i => i.key === missing_key && i.status === 'MISSING')
      );
    }

    // Lọc theo trạng thái kiểm toán
    if (status) {
      if (status === 'READY') {
        list = list.filter(p => p.audit.percentage === 100);
      } else if (status === 'MISSING_LIQUIDATION') {
        list = list.filter(p => p.audit.audit_status === 'MISSING_LIQUIDATION' || (p.audit.is_completed && p.audit.missing_for_liquidation.length > 0));
      } else if (status === 'EXTENDED') {
        list = list.filter(p => p.audit.is_extended);
      } else if (status === 'COMPLETED') {
        list = list.filter(p => p.audit.is_completed);
      } else if (status === 'INCOMPLETE') {
        list = list.filter(p => p.audit.percentage < 100);
      }
    }

    // Sắp xếp ưu tiên: Các đề tài thiếu hồ sơ thanh lý / đã gia hạn lên đầu
    list.sort((a, b) => a.audit.percentage - b.audit.percentage);

    res.json({
      success: true,
      total: list.length,
      data: list
    });
  } catch (err) {
    console.error('Error in GET /api/audit/projects:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/audit/projects/:id - Chi tiết 18 hạng mục kiểm toán của 1 đề tài
router.get('/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const list = await loadAuditData(id, req.user);
    if (!list || list.length === 0) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }

    res.json({
      success: true,
      data: list[0]
    });
  } catch (err) {
    console.error('Error in GET /api/audit/projects/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/audit/verify - Cán bộ P. KHCN đánh dấu xác thực bản cứng / ghi chú kiểm toán
router.post('/verify', async (req, res) => {
  try {
    const { project_id, doc_key, status = 'VERIFIED', notes = '' } = req.body;
    if (!project_id || !doc_key) {
      return res.status(400).json({ success: false, error: 'Thiếu project_id hoặc doc_key' });
    }

    const userRole = req.user?.role || 'PHONG_KHCN';
    if (!['PHONG_KHCN', 'SUPER_ADMIN', 'PHONG_TCHC', 'PHONG_TC_CU'].includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: 'Phân quyền: Chỉ Phòng KHCN (hoặc P. TC-HC / P. TC-Cung ứng / Admin) mới có thẩm quyền xác thực hồ sơ bản cứng lưu trữ.'
      });
    }

    const verifiedBy = req.user ? `${req.user.fullname} (${req.user.role_info?.short_name || userRole})` : 'Chuyên viên P. KHCN';
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, doc_key) DO UPDATE SET
        status = excluded.status,
        verified_by = excluded.verified_by,
        verified_at = excluded.verified_at,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `, [project_id, doc_key, status, verifiedBy, now, notes, now]);

    res.json({
      success: true,
      message: status === 'VERIFIED'
        ? 'Đã xác thực hồ sơ giấy bản cứng thành công!'
        : 'Đã cập nhật lại trạng thái hồ sơ!'
    });

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'VERIFY_AUDIT_DOC',
      entityType: 'AUDIT',
      projectId: Number(project_id),
      summary: `Cập nhật kiểm toán hồ sơ [${doc_key}] -> ${status}`,
      details: { doc_key, status, notes }
    });
  } catch (err) {
    console.error('Error in POST /api/audit/verify:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/audit/activity-logs - Truy vấn nhật ký hoạt động toàn hệ thống
router.get('/activity-logs', async (req, res) => {
  try {
    const { getActivityLogs } = require('../services/activityLogService');
    const { projectId, entityType, action, limit, offset } = req.query;
    const logs = await getActivityLogs({ projectId, entityType, action, limit, offset });
    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Error in GET /api/audit/activity-logs:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
