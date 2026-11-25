const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db/db');
const projectService = require('../services/projectService');
const { ensureBudgetSupplySchema, computeProjectBudgetAnalytics } = require('../services/budgetSupplyService');
const { parseBudgetFile } = require('../services/excelParserService');
const { logFromRequest } = require('../services/activityLogService');

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ==========================================
// 0. PHÂN TÍCH DỰ TOÁN VS THỰC TẾ (BUDGET VS ACTUAL ANALYTICS)
// ==========================================
router.get('/analytics/:projectId', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const { projectId } = req.params;
    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }
    const budgetItems = await db.all('SELECT * FROM nckh_budget_items WHERE project_id = ? ORDER BY id ASC', [projectId]);
    const supplies = await db.all('SELECT * FROM nckh_supplies WHERE project_id = ? ORDER BY id DESC', [projectId]);
    const documents = await db.all('SELECT * FROM nckh_documents WHERE project_id = ? ORDER BY id DESC', [projectId]);

    const analytics = computeProjectBudgetAnalytics(project, budgetItems, supplies, documents);
    res.json({ success: true, data: analytics });
  } catch (err) {
    console.error('Error computing budget analytics:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 1. QUẢN LÝ DỰ TOÁN ĐÃ DUYỆT (BUDGET ITEMS)
// ==========================================

// GET /api/supplies/budget/:projectId - Danh mục dự toán đã duyệt của đề tài (kèm quota)
router.get('/budget/:projectId', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const { projectId } = req.params;
    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    const items = await db.all('SELECT * FROM nckh_budget_items WHERE project_id = ? ORDER BY id ASC', [projectId]);
    const supplies = await db.all('SELECT * FROM nckh_supplies WHERE project_id = ? ORDER BY id DESC', [projectId]);
    const analytics = computeProjectBudgetAnalytics(project || {}, items, supplies);

    res.json({ success: true, data: analytics.budget_items, summary: analytics.summary });
  } catch (err) {
    console.error('Error fetching budget items:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper kiểm tra khóa Dự toán gốc (Baseline Lock)
async function assertBudgetNotLocked(projectId) {
  const proj = await db.get('SELECT budget_approval_status FROM nckh_projects WHERE id = ?', [projectId]);
  if (proj && proj.budget_approval_status === 'LOCKED') {
    const err = new Error('Dự toán gốc đã được CHỐT & KHÓA theo bản phê duyệt có dấu mộc đỏ của Viện trưởng. Không thể sửa tay trực tiếp — mọi thay đổi bắt buộc phải lập Tờ trình Điều chỉnh dự toán.');
    err.statusCode = 403;
    throw err;
  }
}

// POST /api/supplies/budget/:projectId/lock - Chốt & Khóa Dự toán gốc theo bản scan có dấu mộc đỏ
router.post('/budget/:projectId/lock', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'VIEN_TRUONG'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Chỉ P. KH&CN, P. TC-Cung ứng hoặc Viện trưởng mới có quyền Chốt & Khóa dự toán đã duyệt.' });
    }
    const { projectId } = req.params;
    const { doc_id } = req.body || {};

    let redSealDoc = null;
    if (doc_id) {
      redSealDoc = await db.get('SELECT * FROM nckh_documents WHERE id = ? AND project_id = ?', [doc_id, projectId]);
    }
    if (!redSealDoc) {
      redSealDoc = await db.get("SELECT * FROM nckh_documents WHERE project_id = ? AND doc_type = 'DU_TOAN_DA_DUYET' ORDER BY id DESC LIMIT 1", [projectId]);
    }
    if (!redSealDoc) {
      return res.status(400).json({
        success: false,
        error: 'Chưa có Bản scan Dự toán kinh phí đã phê duyệt có dấu mộc đỏ (DU_TOAN_DA_DUYET). Vui lòng tải lên tệp PDF mộc đỏ trước khi Chốt & Khóa.'
      });
    }

    // Kiểm tra khớp tổng tiền giữa bảng Soft-copy (nckh_budget_items) và Tổng kinh phí phê duyệt trên QĐ
    const proj = await db.get('SELECT budget_total, budget_revised FROM nckh_projects WHERE id = ?', [projectId]);
    const aggRow = await db.get('SELECT COUNT(*) as cnt, COALESCE(SUM(total_price), 0) as sum_total FROM nckh_budget_items WHERE project_id = ?', [projectId]);
    const itemCount = Number(aggRow?.cnt) || 0;
    const sumItems = Math.round(Number(aggRow?.sum_total) || 0);
    const approvedBudget = Math.round(Number(proj?.budget_revised || proj?.budget_total || 0));

    if (itemCount === 0) {
      return res.status(400).json({
        success: false,
        error: 'Bảng số liệu dự toán chi tiết (soft-copy) đang trống. Vui lòng nhập, dán từ Excel hoặc Import BM02 khớp với bản mộc đỏ trước khi Chốt & Khóa.'
      });
    }

    const diff = sumItems - approvedBudget;
    if (approvedBudget > 0 && Math.abs(diff) > 1000 && !req.body?.confirm_mismatch) {
      return res.status(400).json({
        success: false,
        mismatch: true,
        sum_items: sumItems,
        approved_budget: approvedBudget,
        diff,
        error: `Tổng bảng soft-copy (${sumItems.toLocaleString('vi-VN')} đ) đang lệch ${(diff > 0 ? '+' : '') + diff.toLocaleString('vi-VN')} đ so với Tổng kinh phí phê duyệt (${approvedBudget.toLocaleString('vi-VN')} đ). Vui lòng mở màn hình Đối chiếu 2 cột để rà soát khớp 100% trước khi Chốt & Khóa.`
      });
    }

    const lockerName = req.user?.fullname || role;
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const todayISO = nowStr.slice(0, 10);

    await db.run(
      `UPDATE nckh_projects
       SET budget_approval_status = 'LOCKED',
           budget_locked_at = ?,
           budget_locked_by = ?,
           budget_approval_doc_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nowStr, lockerName, redSealDoc.id, projectId]
    );

    // Đồng bộ khóa VERIFIED cho DU_TOAN_DA_DUYET trong bảng kiểm toán
    await db.run(
      `INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes)
       VALUES (?, 'DU_TOAN_DA_DUYET', 'VERIFIED', ?, ?, ?)
       ON CONFLICT(project_id, doc_key) DO UPDATE SET
         status = 'VERIFIED',
         verified_by = excluded.verified_by,
         verified_at = excluded.verified_at,
         notes = excluded.notes,
         updated_at = CURRENT_TIMESTAMP`,
      [projectId, lockerName, todayISO, `Đã đối chiếu bản mộc đỏ (${redSealDoc.file_name}) và chốt khóa bảng dự toán chi tiết`]
    );

    await logFromRequest(req, {
      action: 'LOCK_BUDGET_BASELINE',
      entityType: 'PROJECT',
      entityId: Number(projectId),
      projectId: Number(projectId),
      summary: `Chốt & Khóa dự toán gốc theo bản scan mộc đỏ (${redSealDoc.file_name})`
    });

    res.json({
      success: true,
      message: 'Đã Chốt & Khóa Dự toán gốc theo bản phê duyệt có dấu mộc đỏ. Mọi thay đổi từ nay bắt buộc thực hiện qua quy trình Điều chỉnh dự toán.',
      data: { locked_by: lockerName, locked_at: nowStr, doc_id: redSealDoc.id }
    });
  } catch (err) {
    console.error('Error locking budget baseline:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/supplies/budget/:projectId/unlock - Mở khóa Dự toán gốc (chỉ Admin / P. KH&CN khi cần hiệu đính sai sót nhập liệu)
router.post('/budget/:projectId/unlock', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['SUPER_ADMIN', 'PHONG_KHCN'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Chỉ Admin hoặc Phòng KH&CN mới có quyền mở khóa dự toán gốc.' });
    }
    const { projectId } = req.params;
    const { reason } = req.body || {};

    await db.run(
      `UPDATE nckh_projects SET budget_approval_status = 'DRAFT', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [projectId]
    );

    await logFromRequest(req, {
      action: 'UNLOCK_BUDGET_BASELINE',
      entityType: 'PROJECT',
      entityId: Number(projectId),
      projectId: Number(projectId),
      summary: `Mở khóa bảng dự toán gốc${reason ? ` — Lý do: ${reason}` : ''}`
    });

    res.json({ success: true, message: 'Đã mở khóa bảng dự toán để hiệu đính. Nhớ bấm Chốt & Khóa lại sau khi hoàn tất.' });
  } catch (err) {
    console.error('Error unlocking budget baseline:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/supplies/budget/:projectId - Thêm mục hàng vào dự toán đã duyệt
router.post('/budget/:projectId', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const { projectId } = req.params;
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'VIEN_TRUONG', 'CHU_NHIEM'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Vai trò hiện tại không có quyền thêm hạng mục dự toán.' });
    }
    await assertBudgetNotLocked(projectId);

    const { category, item_name, specification, unit, approved_quantity, unit_price, notes } = req.body;
    if (!item_name || !String(item_name).trim()) {
      return res.status(400).json({ success: false, error: 'Tên hàng hóa/hóa chất không được để trống' });
    }

    const qty = Number(approved_quantity) || 0;
    const price = Number(unit_price) || 0;
    const totalPrice = Math.round(qty * price);

    const rs = await db.run(`
      INSERT INTO nckh_budget_items (
        project_id, category, item_name, specification, unit,
        approved_quantity, original_quantity, unit_price, original_unit_price, total_price, notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [
      projectId,
      (category || 'Hóa chất & Vật tư').trim(),
      String(item_name).trim(),
      specification || '',
      unit || '',
      qty,
      qty,
      price,
      price,
      totalPrice,
      notes || ''
    ]);

    await logFromRequest(req, {
      action: 'ADD_BUDGET_ITEM',
      entityType: 'BUDGET_ITEM',
      entityId: rs.lastInsertRowid,
      projectId: Number(projectId),
      summary: `Thêm hạng mục dự toán: ${String(item_name).trim()} (${qty} ${unit || ''}, ${totalPrice.toLocaleString('vi-VN')} đ)`
    });

    res.json({
      success: true,
      message: 'Thêm mục dự toán thành công',
      id: rs.lastInsertRowid
    });
  } catch (err) {
    console.error('Error adding budget item:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// PUT /api/supplies/budget/item/:itemId - Sửa hạng mục dự toán
router.put('/budget/item/:itemId', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'VIEN_TRUONG'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Chỉ P. KH&CN, P. TC-Cung ứng hoặc Lãnh đạo mới được sửa hạng mục dự toán đã duyệt.' });
    }

    const { itemId } = req.params;
    const existing = await db.get('SELECT * FROM nckh_budget_items WHERE id = ?', [itemId]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy hạng mục dự toán' });
    }
    await assertBudgetNotLocked(existing.project_id);

    const { category, item_name, specification, unit, approved_quantity, unit_price, notes } = req.body;
    const qty = approved_quantity !== undefined ? Number(approved_quantity) : Number(existing.approved_quantity);
    const price = unit_price !== undefined ? Number(unit_price) : Number(existing.unit_price);
    const totalPrice = Math.round(qty * price);

    await db.run(`
      UPDATE nckh_budget_items SET
        category = COALESCE(?, category),
        item_name = COALESCE(?, item_name),
        specification = COALESCE(?, specification),
        unit = COALESCE(?, unit),
        approved_quantity = ?,
        unit_price = ?,
        total_price = ?,
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      category !== undefined ? String(category).trim() : null,
      item_name !== undefined ? String(item_name).trim() : null,
      specification !== undefined ? specification : null,
      unit !== undefined ? unit : null,
      qty,
      price,
      totalPrice,
      notes !== undefined ? notes : null,
      itemId
    ]);

    res.json({ success: true, message: 'Cập nhật hạng mục dự toán thành công' });
  } catch (err) {
    console.error('Error updating budget item:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// DELETE /api/supplies/budget/item/:itemId - Xóa hạng mục dự toán
router.delete('/budget/item/:itemId', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Chỉ P. KH&CN, P. TC-Cung ứng hoặc Admin mới được xóa hạng mục dự toán.' });
    }

    const { itemId } = req.params;
    const existing = await db.get('SELECT * FROM nckh_budget_items WHERE id = ?', [itemId]);
    if (existing) {
      await assertBudgetNotLocked(existing.project_id);
    }
    const linked = await db.get('SELECT COUNT(*) as cnt FROM nckh_supplies WHERE budget_item_id = ?', [itemId]);
    if (linked && linked.cnt > 0) {
      return res.status(400).json({
        success: false,
        error: `Không thể xóa vì đã có ${linked.cnt} dòng cấp phát vật tư liên kết với hạng mục này.`
      });
    }

    await db.run('DELETE FROM nckh_budget_items WHERE id = ?', [itemId]);
    res.json({ success: true, message: 'Đã xóa hạng mục dự toán' });
  } catch (err) {
    console.error('Error deleting budget item:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// POST /api/supplies/budget/:projectId/import-excel - Import nhanh danh mục dự toán từ Excel (.xlsx) / CSV (BM02)
router.post('/budget/:projectId/import-excel', excelUpload.single('file'), async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['SUPER_ADMIN', 'PHONG_KHCN', 'PHONG_TC_CU', 'VIEN_TRUONG', 'CHU_NHIEM'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Vai trò hiện tại không có quyền Import dự toán.' });
    }

    const { projectId } = req.params;
    const mode = (req.body.mode || 'preview').toLowerCase(); // preview | append | replace
    if (mode !== 'preview') {
      await assertBudgetNotLocked(projectId);
    }

    let items = [];
    if (req.file && req.file.buffer) {
      items = parseBudgetFile(req.file.buffer, req.file.originalname);
    } else if (req.body.items_json) {
      items = JSON.parse(req.body.items_json);
    } else {
      return res.status(400).json({ success: false, error: 'Vui lòng chọn tệp Excel (.xlsx) hoặc CSV theo mẫu BM02' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Không đọc được hạng mục dự toán nào từ tệp. Hãy đảm bảo bảng có cột Tên hàng hóa, Số lượng và/hoặc Đơn giá.'
      });
    }

    const totalValue = items.reduce((s, it) => s + (Number(it.total_price) || 0), 0);

    if (mode === 'preview') {
      return res.json({
        success: true,
        mode: 'preview',
        count: items.length,
        total_value: totalValue,
        items
      });
    }

    if (mode === 'replace') {
      // Unlink supplies before replacing unlinked items, or delete only unlinked
      const linkedCheck = await db.get('SELECT COUNT(*) as cnt FROM nckh_supplies WHERE project_id = ? AND budget_item_id IS NOT NULL', [projectId]);
      if (linkedCheck && linkedCheck.cnt > 0) {
        await db.run('UPDATE nckh_supplies SET budget_item_id = NULL WHERE project_id = ?', [projectId]);
      }
      await db.run('DELETE FROM nckh_budget_items WHERE project_id = ?', [projectId]);
    }

    let inserted = 0;
    for (const it of items) {
      if (!it.item_name || !String(it.item_name).trim()) continue;
      const qty = Number(it.approved_quantity) || 0;
      const price = Number(it.unit_price) || 0;
      const total = Number(it.total_price) || Math.round(qty * price);
      await db.run(`
        INSERT INTO nckh_budget_items (
          project_id, category, item_name, specification, unit,
          approved_quantity, original_quantity, unit_price, original_unit_price, total_price, notes, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [
        projectId,
        it.category || 'Hóa chất & Vật tư',
        String(it.item_name).trim(),
        it.specification || '',
        it.unit || '',
        qty,
        qty,
        price,
        price,
        total,
        it.notes || ''
      ]);
      inserted++;
    }

    await logFromRequest(req, {
      action: 'IMPORT_BUDGET_EXCEL',
      entityType: 'BUDGET_ITEM',
      projectId: Number(projectId),
      summary: `Import ${inserted} hạng mục dự toán từ tệp (${mode === 'replace' ? 'thay thế toàn bộ' : 'bổ sung'}), tổng ${totalValue.toLocaleString('vi-VN')} đ`
    });

    res.json({
      success: true,
      message: `Đã nhập thành công ${inserted} hạng mục dự toán (Tổng: ${totalValue.toLocaleString('vi-VN')} đ).`,
      inserted,
      total_value: totalValue
    });
  } catch (err) {
    console.error('Error importing Excel budget:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.statusCode === 403 ? err.message : ('Lỗi đọc tệp Excel: ' + err.message) });
  }
});

// ==============================================================
// 2. QUẢN LÝ CẤP PHÁT HÓA CHẤT / VẬT TƯ (SUPPLIES ALLOCATION)
// ==============================================================

// GET /api/supplies/project/:projectId - Danh sách hóa chất xin cấp của đề tài
router.get('/project/:projectId', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const { projectId } = req.params;
    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    const budgetItems = await db.all('SELECT * FROM nckh_budget_items WHERE project_id = ? ORDER BY id ASC', [projectId]);
    const supplies = await db.all('SELECT * FROM nckh_supplies WHERE project_id = ? ORDER BY id DESC', [projectId]);
    const analytics = computeProjectBudgetAnalytics(project || {}, budgetItems, supplies);

    res.json({ success: true, data: analytics.supplies, analytics });
  } catch (err) {
    console.error('Error fetching supplies:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/supplies/project/:projectId - Chủ nhiệm gửi danh sách xin cấp phát hóa chất/vật tư (kèm kiểm tra Quota tự động)
router.post('/project/:projectId', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Chỉ Chủ nhiệm đề tài hoặc P. KH&CN mới được lập đề xuất cấp phát vật tư.' });
    }

    const { projectId } = req.params;
    const { item_name, specification, unit, requested_quantity, budget_item_id, unit_price, notes } = req.body;

    if (!item_name || !requested_quantity || Number(requested_quantity) <= 0) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập tên hàng hóa và số lượng xin cấp (> 0)' });
    }

    const todayISO = projectService.formatDateISO(new Date());
    const qty = Number(requested_quantity);

    // Kiểm tra đối chiếu dự toán & trừ lùi hạn mức (Quota)
    let budgetCheck = 'Ngoài dự toán';
    let overBudgetQty = 0;
    let refUnitPrice = Number(unit_price) || 0;
    let khcnStatus = 'PENDING';
    let warningMsg = null;

    if (budget_item_id) {
      const bItem = await db.get('SELECT * FROM nckh_budget_items WHERE id = ? AND project_id = ?', [budget_item_id, projectId]);
      if (bItem) {
        refUnitPrice = refUnitPrice > 0 ? refUnitPrice : (Number(bItem.unit_price) || 0);
        const prevRow = await db.get(
          `SELECT COALESCE(SUM(requested_quantity), 0) as prev_qty
           FROM nckh_supplies
           WHERE project_id = ? AND budget_item_id = ? AND COALESCE(khcn_approval_status, 'PENDING') != 'REJECTED'`,
          [projectId, budget_item_id]
        );
        const prevQty = Number(prevRow?.prev_qty) || 0;
        const approvedQty = Number(bItem.approved_quantity) || 0;
        const newTotalRequested = prevQty + qty;

        if (newTotalRequested > approvedQty) {
          overBudgetQty = Number((newTotalRequested - approvedQty).toFixed(2));
          budgetCheck = 'Vượt định mức';
          khcnStatus = 'FLAGGED';
          warningMsg = `Cảnh báo: Đề xuất vượt định mức dự toán +${overBudgetQty} ${bItem.unit || unit || ''} (Duyệt: ${approvedQty}, Lũy kế xin: ${newTotalRequested}). Yêu cầu vẫn được ghi nhận và gắn cờ đỏ để P. KH&CN / Viện trưởng xem xét.`;
        } else {
          budgetCheck = 'Trong dự toán';
        }
      }
    } else {
      khcnStatus = 'FLAGGED';
      warningMsg = 'Cảnh báo: Hạng mục nằm NGOÀI DỰ TOÁN đã duyệt. Yêu cầu được gắn cờ để P. KH&CN / Viện trưởng xem xét.';
    }

    const rs = await db.run(`
      INSERT INTO nckh_supplies (
        project_id, budget_item_id, item_name, specification, unit,
        requested_quantity, request_date, budget_check_status, over_budget_qty,
        unit_price, actual_unit_price, actual_total_cost,
        stock_status, received_quantity, remaining_quantity, fulfillment_status,
        khcn_approval_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'Chưa kiểm kho', 0, ?, 'Chưa cấp', ?, ?)
    `, [
      projectId,
      budget_item_id || null,
      String(item_name).trim(),
      specification || '',
      unit || '',
      qty,
      todayISO,
      budgetCheck,
      overBudgetQty,
      refUnitPrice,
      qty,
      khcnStatus,
      notes || ''
    ]);

    await logFromRequest(req, {
      action: 'REQUEST_SUPPLY',
      entityType: 'SUPPLY',
      entityId: rs.lastInsertRowid,
      projectId: Number(projectId),
      summary: `Đề xuất cấp phát: ${String(item_name).trim()} (${qty} ${unit || ''}) — ${budgetCheck}${overBudgetQty > 0 ? ` (+${overBudgetQty})` : ''}`,
      details: { budget_item_id: budget_item_id || null, budget_check_status: budgetCheck, over_budget_qty: overBudgetQty }
    });

    res.json({
      success: true,
      message: warningMsg || 'Gửi yêu cầu cấp phát thành công (Trong hạn mức dự toán).',
      warning: warningMsg,
      budget_check_status: budgetCheck,
      over_budget_qty: overBudgetQty,
      id: rs.lastInsertRowid
    });
  } catch (err) {
    console.error('Error requesting supplies:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/supplies/:id - CẬP NHẬT TÌNH TRẠNG CẤP PHÁT, GIÁ THỰC CHI, DUYỆT KHCN & XÁC NHẬN CHỦ NHIỆM (THEO RBAC)
router.put('/:id', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const { id } = req.params;
    const supply = await db.get('SELECT * FROM nckh_supplies WHERE id = ?', [id]);
    if (!supply) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy mục hàng' });
    }

    const role = req.user?.role || 'PHONG_KHCN';
    const actorName = req.user?.fullname || role;
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

    const {
      action_mode, // optional: 'PI_CONFIRM' | 'KHCN_APPROVE' | 'WAREHOUSE_UPDATE'
      budget_item_id,
      khcn_approval_status,
      stock_status,
      received_quantity,
      remaining_quantity,
      fulfillment_status,
      purchasing_status,
      actual_unit_price,
      actual_total_cost,
      receiver_name,
      received_date,
      misa_order_id,
      misa_link,
      proof_file_path,
      pi_confirmed_received,
      notes
    } = req.body;

    // 1. Chủ nhiệm xác nhận đã nhận hàng
    if (action_mode === 'PI_CONFIRM' || (role === 'CHU_NHIEM' && pi_confirmed_received !== undefined)) {
      if (!['CHU_NHIEM', 'SUPER_ADMIN', 'PHONG_KHCN'].includes(role)) {
        return res.status(403).json({ success: false, error: 'Không có quyền xác nhận nhận hàng.' });
      }
      const confirmedVal = pi_confirmed_received ? 1 : 0;
      await db.run(
        `UPDATE nckh_supplies SET pi_confirmed_received = ?, pi_confirmed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [confirmedVal, confirmedVal ? nowStr : null, id]
      );
      await logFromRequest(req, {
        action: 'PI_CONFIRM_SUPPLY',
        entityType: 'SUPPLY',
        entityId: Number(id),
        projectId: supply.project_id,
        summary: `${confirmedVal ? 'Xác nhận đã nhận' : 'Bỏ xác nhận nhận'} vật tư: ${supply.item_name}`
      });
      return res.json({ success: true, message: confirmedVal ? 'Chủ nhiệm đã xác nhận nhận hàng thành công.' : 'Đã cập nhật trạng thái xác nhận.' });
    }

    // Kiểm tra quyền chung cho chỉnh sửa kho / tài chính / duyệt KH&CN
    const canKhcnApprove = ['PHONG_KHCN', 'VIEN_TRUONG', 'SUPER_ADMIN'].includes(role);
    const canWarehouseOrFinance = ['THU_KHO', 'PHONG_TC_CU', 'PHONG_KHCN', 'SUPER_ADMIN'].includes(role);

    if (!canKhcnApprove && !canWarehouseOrFinance) {
      return res.status(403).json({ success: false, error: `Vai trò ${role} không có quyền cập nhật dòng cấp phát vật tư.` });
    }

    // Xử lý liên kết lại budget_item_id nếu P. KHCN / TC-CU gán lại vào dự toán
    let nextBudgetItemId = supply.budget_item_id;
    let nextBudgetCheck = supply.budget_check_status;
    let nextOverQty = Number(supply.over_budget_qty) || 0;
    let nextRefUnitPrice = Number(supply.unit_price) || 0;

    if (budget_item_id !== undefined && canWarehouseOrFinance) {
      nextBudgetItemId = budget_item_id ? Number(budget_item_id) : null;
      if (nextBudgetItemId) {
        const bItem = await db.get('SELECT * FROM nckh_budget_items WHERE id = ? AND project_id = ?', [nextBudgetItemId, supply.project_id]);
        if (bItem) {
          nextRefUnitPrice = Number(bItem.unit_price) || nextRefUnitPrice;
          const otherRow = await db.get(
            `SELECT COALESCE(SUM(requested_quantity), 0) as prev_qty
             FROM nckh_supplies
             WHERE project_id = ? AND budget_item_id = ? AND id != ? AND COALESCE(khcn_approval_status, 'PENDING') != 'REJECTED'`,
            [supply.project_id, nextBudgetItemId, id]
          );
          const totalReq = (Number(otherRow?.prev_qty) || 0) + (Number(supply.requested_quantity) || 0);
          if (totalReq > Number(bItem.approved_quantity || 0)) {
            nextOverQty = Number((totalReq - Number(bItem.approved_quantity || 0)).toFixed(2));
            nextBudgetCheck = 'Vượt định mức';
          } else {
            nextOverQty = 0;
            nextBudgetCheck = 'Trong dự toán';
          }
        }
      } else {
        nextBudgetCheck = 'Ngoài dự toán';
        nextOverQty = 0;
      }
    }

    // Duyệt chuyên môn P. KHCN
    let nextKhcnStatus = supply.khcn_approval_status || 'PENDING';
    let nextKhcnBy = supply.khcn_approved_by;
    let nextKhcnAt = supply.khcn_approved_at;
    if (khcn_approval_status !== undefined && canKhcnApprove) {
      nextKhcnStatus = khcn_approval_status;
      nextKhcnBy = actorName;
      nextKhcnAt = nowStr;
    }

    const reqQty = Number(supply.requested_quantity) || 0;
    const recQty = (received_quantity !== undefined && canWarehouseOrFinance)
      ? Number(received_quantity)
      : (Number(supply.received_quantity) || 0);

    const remQty = (remaining_quantity !== undefined && canWarehouseOrFinance)
      ? Number(remaining_quantity)
      : Math.max(0, Number((reqQty - recQty).toFixed(2)));

    let autoFulfillment = (fulfillment_status !== undefined && canWarehouseOrFinance)
      ? fulfillment_status
      : supply.fulfillment_status;
    if (!autoFulfillment || (received_quantity !== undefined && !fulfillment_status)) {
      autoFulfillment = recQty >= reqQty ? 'Đã nhận đủ' : (recQty > 0 ? 'Chưa nhận đủ' : 'Chưa cấp');
    }

    // Tính giá trị thực chi
    const nextActualUnitPrice = (actual_unit_price !== undefined && canWarehouseOrFinance)
      ? (Number(actual_unit_price) || 0)
      : (Number(supply.actual_unit_price) || 0);

    let nextActualTotalCost = Number(supply.actual_total_cost) || 0;
    if (actual_total_cost !== undefined && canWarehouseOrFinance && Number(actual_total_cost) > 0) {
      nextActualTotalCost = Number(actual_total_cost);
    } else if ((actual_unit_price !== undefined || received_quantity !== undefined) && canWarehouseOrFinance) {
      const effPrice = nextActualUnitPrice > 0 ? nextActualUnitPrice : nextRefUnitPrice;
      nextActualTotalCost = Math.round(recQty * effPrice);
    }

    await db.run(`
      UPDATE nckh_supplies SET
        budget_item_id = ?,
        budget_check_status = ?,
        over_budget_qty = ?,
        unit_price = ?,
        actual_unit_price = ?,
        actual_total_cost = ?,
        khcn_approval_status = ?,
        khcn_approved_by = ?,
        khcn_approved_at = ?,
        stock_status = COALESCE(?, stock_status),
        received_quantity = ?,
        remaining_quantity = ?,
        fulfillment_status = ?,
        purchasing_status = COALESCE(?, purchasing_status),
        receiver_name = COALESCE(?, receiver_name),
        received_date = COALESCE(?, received_date),
        misa_order_id = COALESCE(?, misa_order_id),
        misa_link = COALESCE(?, misa_link),
        proof_file_path = COALESCE(?, proof_file_path),
        notes = COALESCE(?, notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      nextBudgetItemId,
      nextBudgetCheck,
      nextOverQty,
      nextRefUnitPrice,
      nextActualUnitPrice,
      nextActualTotalCost,
      nextKhcnStatus,
      nextKhcnBy,
      nextKhcnAt,
      canWarehouseOrFinance ? stock_status : null,
      recQty,
      remQty,
      autoFulfillment,
      canWarehouseOrFinance ? purchasing_status : null,
      canWarehouseOrFinance ? receiver_name : null,
      canWarehouseOrFinance ? received_date : null,
      canWarehouseOrFinance ? misa_order_id : null,
      canWarehouseOrFinance ? misa_link : null,
      canWarehouseOrFinance ? proof_file_path : null,
      notes !== undefined ? notes : null,
      id
    ]);

    await logFromRequest(req, {
      action: 'UPDATE_SUPPLY',
      entityType: 'SUPPLY',
      entityId: Number(id),
      projectId: supply.project_id,
      summary: `Cập nhật cấp phát "${supply.item_name}": SL nhận ${recQty}/${reqQty}, Thực chi ${nextActualTotalCost.toLocaleString('vi-VN')} đ, Duyệt KHCN: ${nextKhcnStatus}`
    });

    res.json({
      success: true,
      message: 'Cập nhật tình trạng cấp phát thành công',
      data: {
        id,
        received_quantity: recQty,
        remaining_quantity: remQty,
        fulfillment_status: autoFulfillment,
        actual_unit_price: nextActualUnitPrice,
        actual_total_cost: nextActualTotalCost,
        khcn_approval_status: nextKhcnStatus,
        budget_check_status: nextBudgetCheck
      }
    });
  } catch (err) {
    console.error('Error updating supply status:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/supplies/:id - Xóa dòng đề xuất cấp phát chưa nhận hàng
router.delete('/:id', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const role = req.user?.role || 'PHONG_KHCN';
    if (!['CHU_NHIEM', 'PHONG_KHCN', 'SUPER_ADMIN'].includes(role)) {
      return res.status(403).json({ success: false, error: 'Không có quyền xóa đề xuất cấp phát.' });
    }
    const { id } = req.params;
    const supply = await db.get('SELECT * FROM nckh_supplies WHERE id = ?', [id]);
    if (!supply) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy mục hàng' });
    }
    if (Number(supply.received_quantity) > 0 && role !== 'SUPER_ADMIN') {
      return res.status(400).json({ success: false, error: 'Không thể xóa mục hàng đã phát sinh số lượng cấp phát thực tế.' });
    }
    await db.run('DELETE FROM nckh_supplies WHERE id = ?', [id]);
    res.json({ success: true, message: 'Đã xóa dòng đề xuất cấp phát' });
  } catch (err) {
    console.error('Error deleting supply:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/supplies/overview/all - Xem tổng quan cấp phát hóa chất của tất cả các đề tài
router.get('/overview/all', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const { fulfillment, stock } = req.query;

    let sql = `
      SELECT s.*, p.code as project_code, p.title as project_title, p.leader_name
      FROM nckh_supplies s
      JOIN nckh_projects p ON s.project_id = p.id
      WHERE 1=1
    `;
    const args = [];

    if (fulfillment) {
      sql += ' AND s.fulfillment_status = ?';
      args.push(fulfillment);
    }
    if (stock) {
      sql += ' AND s.stock_status = ?';
      args.push(stock);
    }

    sql += ' ORDER BY s.id DESC LIMIT 300';

    const supplies = await db.all(sql, args);
    res.json({ success: true, total: supplies.length, data: supplies });
  } catch (err) {
    console.error('Error in supplies overview:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
