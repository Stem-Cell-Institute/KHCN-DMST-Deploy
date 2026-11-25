const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { logFromRequest } = require('../services/activityLogService');

// GET /api/researchers - Danh sách tất cả nhà khoa học (hợp nhất từ nckh_researchers & nckh_projects)
router.get('/', async (req, res) => {
  try {
    const profiles = await db.all('SELECT * FROM nckh_researchers ORDER BY full_name ASC');
    const projLeaders = await db.all(
      `SELECT leader_name, MAX(research_group) AS research_group, COUNT(*) AS project_count
       FROM nckh_projects
       WHERE leader_name IS NOT NULL AND TRIM(leader_name) != ''
       GROUP BY leader_name
       ORDER BY leader_name ASC`
    );

    const map = new Map();
    profiles.forEach(p => {
      map.set(p.full_name.trim(), { ...p, project_count: 0, has_ecv: true });
    });

    projLeaders.forEach(l => {
      const name = l.leader_name.trim();
      if (map.has(name)) {
        const cur = map.get(name);
        cur.project_count = l.project_count;
        if (!cur.research_group) cur.research_group = l.research_group;
      } else {
        map.set(name, {
          full_name: name,
          academic_title: '',
          research_group: l.research_group || '',
          project_count: l.project_count,
          has_ecv: false
        });
      }
    });

    res.json({ success: true, data: Array.from(map.values()) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/researchers/ecv?name=... - Lấy hồ sơ e-CV động (kèm Đề tài & Sản phẩm KHCN)
router.get('/ecv', async (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) {
      return res.status(400).json({ success: false, error: 'Thiếu tham số tên nhà khoa học (name).' });
    }

    const profile = await db.get('SELECT * FROM nckh_researchers WHERE full_name = ?', [name]);
    const projects = await db.all(
      `SELECT id, code, title, category, research_group, budget_total, decision_date,
              COALESCE(current_end_date, base_end_date) AS end_date, status, final_evaluation
       FROM nckh_projects
       WHERE leader_name = ?
       ORDER BY decision_date DESC, id DESC`,
      [name]
    );

    const projectIds = projects.map(p => p.id);
    let products = [];
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => '?').join(',');
      products = await db.all(
        `SELECT pr.*, p.code AS project_code
         FROM nckh_products pr
         JOIN nckh_projects p ON pr.project_id = p.id
         WHERE pr.project_id IN (${placeholders})
         ORDER BY pr.publish_year DESC, pr.id DESC`,
        projectIds
      );
    }

    const stats = {
      total_projects: projects.length,
      completed_projects: projects.filter(p => p.status === 'COMPLETED').length,
      in_progress_projects: projects.filter(p => p.status === 'IN_PROGRESS').length,
      total_budget: projects.reduce((s, p) => s + Number(p.budget_total || 0), 0),
      total_products: products.length,
      papers_count: products.filter(pr => pr.product_type === 'PAPER').length,
      patents_count: products.filter(pr => pr.product_type === 'PATENT').length,
      trainings_count: products.filter(pr => pr.product_type === 'TRAINING').length
    };

    res.json({
      success: true,
      data: {
        profile: profile || {
          full_name: name,
          academic_title: '',
          research_group: projects[0]?.research_group || '',
          email: '',
          phone: '',
          position_title: 'Chủ nhiệm đề tài / Nghiên cứu viên',
          orcid: '',
          google_scholar_url: '',
          scopus_id: '',
          specialization: '',
          education_history: '',
          work_history: '',
          awards: ''
        },
        projects,
        products,
        stats
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/researchers/ecv - Tạo hoặc cập nhật thông tin e-CV nhà khoa học
router.post('/ecv', async (req, res) => {
  try {
    const {
      full_name,
      academic_title = '',
      email = '',
      phone = '',
      research_group = '',
      position_title = '',
      orcid = '',
      google_scholar_url = '',
      scopus_id = '',
      specialization = '',
      education_history = '',
      work_history = '',
      awards = ''
    } = req.body || {};

    if (!full_name || !String(full_name).trim()) {
      return res.status(400).json({ success: false, error: 'Họ và tên nhà khoa học không được để trống.' });
    }

    const cleanName = String(full_name).trim();
    await db.run(
      `INSERT INTO nckh_researchers (
        full_name, academic_title, email, phone, research_group, position_title,
        orcid, google_scholar_url, scopus_id, specialization, education_history, work_history, awards, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(full_name) DO UPDATE SET
        academic_title = excluded.academic_title,
        email = excluded.email,
        phone = excluded.phone,
        research_group = excluded.research_group,
        position_title = excluded.position_title,
        orcid = excluded.orcid,
        google_scholar_url = excluded.google_scholar_url,
        scopus_id = excluded.scopus_id,
        specialization = excluded.specialization,
        education_history = excluded.education_history,
        work_history = excluded.work_history,
        awards = excluded.awards,
        updated_at = CURRENT_TIMESTAMP`,
      [
        cleanName, academic_title, email, phone, research_group, position_title,
        orcid, google_scholar_url, scopus_id, specialization, education_history, work_history, awards
      ]
    );

    await logFromRequest(req, {
      action: 'UPDATE_ECV',
      entityType: 'RESEARCHER',
      summary: `Cập nhật hồ sơ e-CV nhà khoa học: ${cleanName}`,
      details: { orcid, academic_title, research_group }
    });

    res.json({ success: true, message: `Đã lưu hồ sơ e-CV của ${cleanName}.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
