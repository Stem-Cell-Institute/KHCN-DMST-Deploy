const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { logFromRequest } = require('../services/activityLogService');

const ALLOWED_TYPES = ['PAPER', 'PATENT', 'TRAINING', 'OTHER'];
const ALLOWED_STATUSES = ['REGISTERED', 'SUBMITTED', 'ACCEPTED', 'PUBLISHED'];

// GET /api/products - Danh sách sản phẩm KHCN toàn Viện (có lọc & thống kê)
router.get('/', async (req, res) => {
  try {
    const { projectId, productType, status, year } = req.query;
    const conditions = [];
    const args = [];

    if (projectId) {
      conditions.push('pr.project_id = ?');
      args.push(Number(projectId));
    }
    if (productType && ALLOWED_TYPES.includes(String(productType).toUpperCase())) {
      conditions.push('pr.product_type = ?');
      args.push(String(productType).toUpperCase());
    }
    if (status && ALLOWED_STATUSES.includes(String(status).toUpperCase())) {
      conditions.push('pr.status = ?');
      args.push(String(status).toUpperCase());
    }
    if (year) {
      conditions.push('pr.publish_year = ?');
      args.push(Number(year));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const items = await db.all(
      `SELECT pr.*, p.code AS project_code, p.title AS project_title, p.leader_name, p.research_group
       FROM nckh_products pr
       JOIN nckh_projects p ON pr.project_id = p.id
       ${whereClause}
       ORDER BY pr.publish_year DESC, pr.id DESC`,
      args
    );

    const summary = {
      total: items.length,
      papers: items.filter(i => i.product_type === 'PAPER').length,
      patents: items.filter(i => i.product_type === 'PATENT').length,
      trainings: items.filter(i => i.product_type === 'TRAINING').length,
      others: items.filter(i => i.product_type === 'OTHER').length,
      verified: items.filter(i => !!i.verified_at).length,
      published: items.filter(i => i.status === 'PUBLISHED' || i.status === 'ACCEPTED').length
    };

    res.json({ success: true, data: items, summary });
  } catch (err) {
    console.error('Error in GET /api/products:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/products/project/:projectId - Sản phẩm KHCN của một đề tài
router.get('/project/:projectId', async (req, res) => {
  try {
    const items = await db.all(
      `SELECT * FROM nckh_products WHERE project_id = ? ORDER BY publish_year DESC, id DESC`,
      [req.params.projectId]
    );
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products - Thêm sản phẩm KHCN mới cho đề tài
router.post('/', async (req, res) => {
  try {
    const {
      project_id,
      product_type = 'PAPER',
      title,
      authors_or_trainee = '',
      venue_or_degree = '',
      quartile_or_rank = '',
      doi_or_code = '',
      publish_year = new Date().getFullYear(),
      status = 'REGISTERED',
      evidence_file_id = null,
      notes = ''
    } = req.body;

    if (!project_id || !title || !String(title).trim()) {
      return res.status(400).json({ success: false, error: 'Thiếu project_id hoặc tên sản phẩm KHCN.' });
    }

    const typeUpper = String(product_type).toUpperCase();
    if (!ALLOWED_TYPES.includes(typeUpper)) {
      return res.status(400).json({ success: false, error: 'Loại sản phẩm không hợp lệ (PAPER, PATENT, TRAINING, OTHER).' });
    }

    const statusUpper = ALLOWED_STATUSES.includes(String(status).toUpperCase())
      ? String(status).toUpperCase()
      : 'REGISTERED';

    const project = await db.get('SELECT id, code FROM nckh_projects WHERE id = ?', [project_id]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài.' });
    }

    const rs = await db.run(
      `INSERT INTO nckh_products (
        project_id, product_type, title, authors_or_trainee, venue_or_degree,
        quartile_or_rank, doi_or_code, publish_year, status, evidence_file_id, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(project_id),
        typeUpper,
        String(title).trim(),
        authors_or_trainee,
        venue_or_degree,
        quartile_or_rank,
        doi_or_code,
        publish_year ? Number(publish_year) : null,
        statusUpper,
        evidence_file_id || null,
        notes
      ]
    );

    await logFromRequest(req, {
      action: 'ADD_PRODUCT',
      entityType: 'PRODUCT',
      entityId: rs.lastInsertRowid,
      projectId: Number(project_id),
      summary: `Khai báo sản phẩm KHCN [${typeUpper}] cho đề tài ${project.code}: ${String(title).trim()}`,
      details: { product_type: typeUpper, status: statusUpper, doi_or_code }
    });

    res.json({ success: true, id: rs.lastInsertRowid, message: 'Đã thêm sản phẩm KHCN vào kho dữ liệu.' });
  } catch (err) {
    console.error('Error in POST /api/products:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/products/:id - Cập nhật hoặc P. KHCN xác thực sản phẩm
router.put('/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT * FROM nckh_products WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy sản phẩm KHCN.' });
    }

    const {
      product_type = existing.product_type,
      title = existing.title,
      authors_or_trainee = existing.authors_or_trainee,
      venue_or_degree = existing.venue_or_degree,
      quartile_or_rank = existing.quartile_or_rank,
      doi_or_code = existing.doi_or_code,
      publish_year = existing.publish_year,
      status = existing.status,
      notes = existing.notes,
      verify = false
    } = req.body;

    let verifiedBy = existing.verified_by;
    let verifiedAt = existing.verified_at;
    if (verify) {
      const userRole = req.user?.role || 'PHONG_KHCN';
      if (!['PHONG_KHCN', 'VIEN_TRUONG', 'SUPER_ADMIN'].includes(userRole)) {
        return res.status(403).json({ success: false, error: 'Chỉ Phòng KHCN hoặc Viện trưởng mới có quyền xác thực sản phẩm.' });
      }
      verifiedBy = req.user?.fullname || 'Phòng KHCN';
      verifiedAt = new Date().toISOString();

      // Đồng bộ sang checklist kiểm toán SAN_PHAM_KHCN
      await db.run(
        `INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes, updated_at)
         VALUES (?, 'SAN_PHAM_KHCN', 'VERIFIED', ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(project_id, doc_key) DO UPDATE SET
           status = 'VERIFIED',
           verified_by = excluded.verified_by,
           verified_at = excluded.verified_at,
           updated_at = CURRENT_TIMESTAMP`,
        [existing.project_id, verifiedBy, verifiedAt, `Đã xác thực sản phẩm: ${title}`]
      );
    }

    await db.run(
      `UPDATE nckh_products SET
        product_type = ?, title = ?, authors_or_trainee = ?, venue_or_degree = ?,
        quartile_or_rank = ?, doi_or_code = ?, publish_year = ?, status = ?, notes = ?,
        verified_by = ?, verified_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        product_type,
        title,
        authors_or_trainee,
        venue_or_degree,
        quartile_or_rank,
        doi_or_code,
        publish_year ? Number(publish_year) : null,
        status,
        notes,
        verifiedBy,
        verifiedAt,
        req.params.id
      ]
    );

    await logFromRequest(req, {
      action: verify ? 'VERIFY_PRODUCT' : 'UPDATE_PRODUCT',
      entityType: 'PRODUCT',
      entityId: Number(req.params.id),
      projectId: Number(existing.project_id),
      summary: verify
        ? `Xác thực sản phẩm KHCN #${req.params.id}: ${title}`
        : `Cập nhật sản phẩm KHCN #${req.params.id}: ${title}`,
      details: { status, verified: !!verify }
    });

    res.json({ success: true, message: verify ? 'Đã xác thực sản phẩm KHCN!' : 'Đã cập nhật sản phẩm KHCN.' });
  } catch (err) {
    console.error('Error in PUT /api/products/:id:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/products/:id
router.delete('/:id', async (req, res) => {
  try {
    const existing = await db.get('SELECT * FROM nckh_products WHERE id = ?', [req.params.id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy sản phẩm KHCN.' });
    }
    await db.run('DELETE FROM nckh_products WHERE id = ?', [req.params.id]);
    await logFromRequest(req, {
      action: 'DELETE_PRODUCT',
      entityType: 'PRODUCT',
      entityId: Number(req.params.id),
      projectId: Number(existing.project_id),
      summary: `Xóa sản phẩm KHCN: ${existing.title}`
    });
    res.json({ success: true, message: 'Đã xóa sản phẩm KHCN.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
