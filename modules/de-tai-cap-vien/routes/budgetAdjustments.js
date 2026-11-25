const express = require('express');
const router = express.Router({ mergeParams: true });
const db = require('../db/db');
const projectService = require('../services/projectService');
const { callService } = require('../services/callService');
const { DEMO_PROFILES } = require('../config/roles');
const { ensureBudgetSupplySchema } = require('../services/budgetSupplyService');

// 1. Lấy danh sách lịch sử các lần điều chỉnh dự toán của 1 đề tài
router.get('/', async (req, res) => {
  try {
    const projectId = req.params.id;
    const adjustments = await db.all(
      `SELECT ba.*, 
              d_req.file_name as request_file_name, d_req.stored_path as request_file_path,
              d_dec.file_name as decision_file_name, d_dec.stored_path as decision_file_path
       FROM nckh_budget_adjustments ba
       LEFT JOIN nckh_documents d_req ON ba.request_file_id = d_req.id
       LEFT JOIN nckh_documents d_dec ON ba.decision_file_id = d_dec.id
       WHERE ba.project_id = ?
       ORDER BY ba.adjustment_num DESC, ba.id DESC`,
      [projectId]
    );

    const project = await db.get('SELECT id, code, title, budget_total, budget_revised FROM nckh_projects WHERE id = ?', [projectId]);

    res.json({
      success: true,
      data: {
        project,
        adjustments,
        total_adjustments: adjustments.length,
        has_approved_adjustment: adjustments.some(a => a.status === 'APPROVED')
      }
    });
  } catch (err) {
    console.error('Lỗi lấy danh sách điều chỉnh dự toán:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper kiểm tra không cho giảm định mức hạng mục thấp hơn số lượng đã cấp phát thực tế
async function validateItemChangesAgainstReceived(projectId, changes) {
  if (!Array.isArray(changes) || changes.length === 0) return;
  for (const ch of changes) {
    if (ch.action === 'UPDATE' && ch.budget_item_id && ch.new_quantity !== undefined) {
      const bItem = await db.get('SELECT id, item_name, unit FROM nckh_budget_items WHERE id = ? AND project_id = ?', [ch.budget_item_id, projectId]);
      if (!bItem) continue;
      const recRow = await db.get(
        `SELECT COALESCE(SUM(received_quantity), 0) as total_rec
         FROM nckh_supplies
         WHERE project_id = ? AND budget_item_id = ? AND COALESCE(khcn_approval_status, 'PENDING') != 'REJECTED'`,
        [projectId, ch.budget_item_id]
      );
      const totalRec = Number(recRow?.total_rec) || 0;
      const newQty = Number(ch.new_quantity) || 0;
      if (newQty < totalRec) {
        const err = new Error(
          `Không thể điều chỉnh giảm "${bItem.item_name}" xuống ${newQty} ${bItem.unit || ''} vì đề tài đã cấp phát thực tế ${totalRec} ${bItem.unit || ''}.`
        );
        err.statusCode = 400;
        throw err;
      }
    }
  }
}

// 2. BƯỚC 1: Chủ nhiệm đề tài nộp Tờ trình / Đơn xin điều chỉnh dự toán
router.post('/', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const projectId = req.params.id;
    const { new_budget, reason, proposal_details, item_changes, request_file_id } = req.body;

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, error: 'Vui lòng cung cấp lý do điều chỉnh dự toán' });
    }

    const oldBudget = project.budget_revised || project.budget_total || 0;
    const parsedNewBudget = parseFloat(new_budget);
    const effectiveNewBudget = isNaN(parsedNewBudget) ? oldBudget : parsedNewBudget;
    const diff = effectiveNewBudget - oldBudget;

    // Chuẩn hóa & kiểm tra an toàn danh sách thay đổi chi tiết từng hạng mục dự toán
    let itemChangesArr = [];
    if (Array.isArray(item_changes) && item_changes.length > 0) {
      itemChangesArr = item_changes;
    } else if (typeof item_changes === 'string' && item_changes.trim()) {
      try { itemChangesArr = JSON.parse(item_changes); } catch (_) {}
    }
    await validateItemChangesAgainstReceived(projectId, itemChangesArr);
    const itemChangesJson = itemChangesArr.length > 0 ? JSON.stringify(itemChangesArr) : null;

    // Đếm số lần điều chỉnh trước đó
    const countRow = await db.get('SELECT COUNT(*) as cnt FROM nckh_budget_adjustments WHERE project_id = ?', [projectId]);
    const nextNum = (countRow?.cnt || 0) + 1;
    const today = new Date().toISOString().slice(0, 10);

    // Liên kết với tệp Tờ trình thật đã tải lên (nếu có), không tạo tệp ảo
    let linkedRequestFileId = request_file_id ? Number(request_file_id) : null;
    if (!linkedRequestFileId) {
      const latestDon = await db.get(
        "SELECT id FROM nckh_documents WHERE project_id = ? AND doc_type = 'DON_DIEU_CHINH_DU_TOAN' ORDER BY id DESC LIMIT 1",
        [projectId]
      );
      if (latestDon) linkedRequestFileId = latestDon.id;
    }

    // 2. Tạo bản ghi yêu cầu điều chỉnh dự toán
    const adjResult = await db.run(
      `INSERT INTO nckh_budget_adjustments 
       (project_id, adjustment_num, old_budget, new_budget, difference_amount, reason, proposal_details, item_changes_json, request_date, status, request_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        projectId,
        nextNum,
        oldBudget,
        effectiveNewBudget,
        diff,
        reason.trim(),
        proposal_details || (diff === 0 ? 'Điều chuyển cơ cấu nội bộ danh mục vật tư/hóa chất (không làm thay đổi tổng dự toán)' : 'Điều chỉnh danh mục hóa chất/vật tư phục vụ nghiên cứu'),
        itemChangesJson,
        today,
        linkedRequestFileId
      ]
    );

    // 3. Tự động bắn Email thông báo cho Phòng KHCN vào Bàn làm việc thẩm tra
    try {
      const khcnProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_KHCN') || { fullname: 'Phòng KHCN & ĐN', email: 'khcn@sci.edu.vn' };
      const diffFormatted = (diff >= 0 ? '+' : '') + diff.toLocaleString('vi-VN') + ' đ';
      await callService.sendNotification({
        eventType: 'NEW_BUDGET_ADJUSTMENT_REQUEST',
        recipientRole: 'PHONG_KHCN',
        recipientEmail: khcnProfile.email,
        recipientName: khcnProfile.fullname,
        subject: `[Bàn làm việc KHCN] Yêu cầu thẩm tra Điều chỉnh Dự toán Lần ${nextNum} - Đề tài: ${project.code}`,
        bodyHtml: `<p>Chủ nhiệm đề tài <strong>${project.leader_name}</strong> vừa gửi Tờ trình điều chỉnh dự toán Lần ${nextNum} cho đề tài <strong>${project.code}</strong> (${Number(oldBudget).toLocaleString('vi-VN')} đ &rarr; ${Number(effectiveNewBudget).toLocaleString('vi-VN')} đ, chênh lệch ${diffFormatted}). Lý do: ${reason.trim()}</p>`,
        actionUrl: `/chi-tiet.html?id=${projectId}&tab=tab-supplies`,
        relatedProjectId: projectId
      });
    } catch (eMailErr) {
      console.warn('Lỗi gửi email thông báo điều chỉnh dự toán:', eMailErr.message);
    }

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'SUBMIT_BUDGET_ADJUSTMENT',
      entityType: 'BUDGET_ADJUSTMENT',
      entityId: adjResult.lastInsertRowid,
      projectId: Number(projectId),
      summary: `Nộp tờ trình điều chỉnh dự toán Lần ${nextNum} (${Number(oldBudget).toLocaleString('vi-VN')} -> ${Number(effectiveNewBudget).toLocaleString('vi-VN')} đ)`,
      details: { adjustment_num: nextNum, old_budget: oldBudget, new_budget: effectiveNewBudget, reason: reason.trim() }
    });

    res.json({
      success: true,
      message: `Đã nộp thành công Tờ trình đề xuất điều chỉnh dự toán (Lần ${nextNum}). Đang chờ Phòng KHCN thẩm tra chuyên môn.`,
      data: {
        adjustment_id: adjResult.lastInsertRowid,
        adjustment_num: nextNum,
        old_budget: oldBudget,
        new_budget: effectiveNewBudget,
        difference_amount: diff
      }
    });
  } catch (err) {
    console.error('Lỗi nộp yêu cầu điều chỉnh dự toán:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

// 3. BƯỚC 2: Phòng KHCN thẩm tra chuyên môn và điều kiện pháp lý
router.post('/:adjId/khcn-review', async (req, res) => {
  try {
    const { adjId, id: projectId } = req.params;
    const { opinion, status } = req.body; // status: 'KHCN_REVIEWED' hoặc 'REJECTED'

    const adj = await db.get('SELECT * FROM nckh_budget_adjustments WHERE id = ? AND project_id = ?', [adjId, projectId]);
    if (!adj) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy yêu cầu điều chỉnh dự toán' });
    }

    const reviewedStatus = status === 'REJECTED' ? 'REJECTED' : 'KHCN_REVIEWED';
    const reviewerName = req.user?.fullname || 'Chuyên viên P. KHCN & ĐN';
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);

    await db.run(
      `UPDATE nckh_budget_adjustments 
       SET status = ?, khcn_opinion = ?, khcn_reviewed_by = ?, khcn_reviewed_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [reviewedStatus, opinion || 'Đã thẩm tra tính hợp lý về mặt khoa học kỹ thuật, kính trình Viện trưởng xem xét phê duyệt', reviewerName, nowStr, adjId]
    );

    // 3. Gửi email thông báo cho Viện trưởng (nếu đạt) hoặc Chủ nhiệm (nếu yêu cầu sửa)
    try {
      const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
      const diffVal = Number(adj.difference_amount || 0);
      const diffFormatted = (diffVal >= 0 ? '+' : '') + diffVal.toLocaleString('vi-VN') + ' đ';
      if (reviewedStatus === 'KHCN_REVIEWED') {
        const directorProfile = DEMO_PROFILES.find(p => p.role === 'VIEN_TRUONG') || { fullname: 'Viện trưởng', email: 'pvphuc@sci.edu.vn' };
        await callService.sendNotification({
          eventType: 'BUDGET_ADJUSTMENT_KHCN_REVIEWED',
          recipientRole: 'VIEN_TRUONG',
          recipientEmail: directorProfile.email,
          recipientName: directorProfile.fullname,
          subject: `[Trình Viện trưởng] Phê duyệt Điều chỉnh Dự toán Lần ${adj.adjustment_num} - Đề tài: ${project?.code || projectId}`,
          bodyHtml: `<p>Phòng KH&CN đã thẩm tra Tờ trình điều chỉnh dự toán Lần ${adj.adjustment_num} của đề tài <strong>${project?.code || ''}</strong> (${Number(adj.old_budget).toLocaleString('vi-VN')} đ &rarr; ${Number(adj.new_budget).toLocaleString('vi-VN')} đ, chênh lệch ${diffFormatted}). Kính trình Viện trưởng xem xét phê duyệt.</p>`,
          actionUrl: `/chi-tiet.html?id=${projectId}&tab=tab-supplies`,
          relatedProjectId: projectId
        });
      }
    } catch (eMailErr) {
      console.warn('Lỗi gửi email thông báo thẩm tra điều chỉnh dự toán:', eMailErr.message);
    }

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'KHCN_REVIEW_BUDGET_ADJUSTMENT',
      entityType: 'BUDGET_ADJUSTMENT',
      entityId: Number(adjId),
      projectId: Number(projectId),
      summary: `P. KHCN thẩm tra điều chỉnh dự toán #${adjId} -> ${reviewedStatus}`,
      details: { status: reviewedStatus }
    });

    res.json({
      success: true,
      message: reviewedStatus === 'KHCN_REVIEWED' 
        ? 'Phòng KHCN đã thẩm tra và thông qua đề xuất điều chỉnh dự toán. Đã chuyển hồ sơ trình Viện trưởng phê duyệt.'
        : 'Phòng KHCN đã từ chối hoặc yêu cầu điều chỉnh lại tờ trình dự toán.',
      data: {
        status: reviewedStatus,
        reviewed_by: reviewerName
      }
    });
  } catch (err) {
    console.error('Lỗi thẩm tra điều chỉnh dự toán P. KHCN:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. BƯỚC 3 & 4: Viện trưởng phê duyệt (BẮT BUỘC CÓ BẢN SCAN QUYẾT ĐỊNH DẤU MỘC ĐỎ) & CẬP NHẬT HỆ THỐNG TOÀN DIỆN
router.post('/:adjId/approve', async (req, res) => {
  try {
    await ensureBudgetSupplySchema();
    const { adjId, id: projectId } = req.params;
    const { decision_number, decision_date, director_decision, decision_file_id } = req.body;

    const adj = await db.get('SELECT * FROM nckh_budget_adjustments WHERE id = ? AND project_id = ?', [adjId, projectId]);
    if (!adj) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy yêu cầu điều chỉnh dự toán' });
    }

    const project = await db.get('SELECT * FROM nckh_projects WHERE id = ?', [projectId]);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Không tìm thấy đề tài' });
    }

    if (!decision_number || !String(decision_number).trim()) {
      return res.status(400).json({ success: false, error: 'Bắt buộc nhập Số Quyết định điều chỉnh dự toán.' });
    }

    // A. Kiểm tra bắt buộc có tệp scan Quyết định điều chỉnh dự toán thật (mộc đỏ) trong nckh_documents
    let decisionDoc = null;
    if (decision_file_id) {
      decisionDoc = await db.get('SELECT * FROM nckh_documents WHERE id = ? AND project_id = ?', [decision_file_id, projectId]);
    }
    if (!decisionDoc) {
      decisionDoc = await db.get(
        "SELECT * FROM nckh_documents WHERE project_id = ? AND doc_type = 'QD_DIEU_CHINH_DU_TOAN' ORDER BY id DESC LIMIT 1",
        [projectId]
      );
    }
    if (!decisionDoc) {
      return res.status(400).json({
        success: false,
        error: 'Bắt buộc tải lên Bản scan Quyết định điều chỉnh dự toán có chữ ký Viện trưởng & dấu mộc đỏ (PDF) trước khi phê duyệt kích hoạt số liệu mới.'
      });
    }

    // Kiểm tra lại an toàn số lượng đã cấp thực tế trước khi đồng bộ hạng mục
    let parsedChanges = [];
    if (adj.item_changes_json) {
      try {
        parsedChanges = JSON.parse(adj.item_changes_json);
        await validateItemChangesAgainstReceived(projectId, parsedChanges);
      } catch (valErr) {
        if (valErr.statusCode === 400) throw valErr;
      }
    }

    const decNumber = String(decision_number).trim();
    const decDate = decision_date || new Date().toISOString().slice(0, 10);
    const approverName = req.user?.fullname || 'GS.TS. Phạm Văn Phúc (Viện trưởng)';
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const decisionFileId = decisionDoc.id;

    // B. Cập nhật bản ghi nckh_budget_adjustments -> APPROVED
    await db.run(
      `UPDATE nckh_budget_adjustments 
       SET status = 'APPROVED', 
           decision_number = ?, 
           decision_date = ?, 
           director_decision = ?, 
           approved_by = ?, 
           approved_at = ?,
           decision_file_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [decNumber, decDate, director_decision || 'Đồng ý phê duyệt điều chỉnh dự toán theo đề xuất của Phòng KHCN', approverName, nowStr, decisionFileId, adjId]
    );

    // C. Cập nhật bảng đề tài nckh_projects:
    // Cập nhật budget_revised, nhưng GIỮ NGUYÊN budget_total (gốc) để kiểm toán đối chiếu
    const updatedNotes = (project.notes ? project.notes + ' • ' : '') + `Đã điều chỉnh dự toán theo QĐ số ${decNumber} (${new Date().toLocaleDateString('vi-VN')})`;
    await db.run(
      `UPDATE nckh_projects 
       SET budget_revised = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [adj.new_budget, updatedNotes, projectId]
    );

    // C2. Đồng bộ tự động các thay đổi hạng mục chi tiết xuống bảng nckh_budget_items (nếu có item_changes_json)
    await ensureBudgetSupplySchema();
    let syncedItemsCount = 0;
    if (adj.item_changes_json) {
      try {
        const changes = JSON.parse(adj.item_changes_json);
        if (Array.isArray(changes)) {
          for (const ch of changes) {
            if (ch.action === 'UPDATE' && ch.budget_item_id) {
              const existingItem = await db.get('SELECT * FROM nckh_budget_items WHERE id = ? AND project_id = ?', [ch.budget_item_id, projectId]);
              if (existingItem) {
                const nextQty = ch.new_quantity !== undefined ? Number(ch.new_quantity) : Number(existingItem.approved_quantity);
                const nextPrice = ch.new_unit_price !== undefined ? Number(ch.new_unit_price) : Number(existingItem.unit_price);
                const nextTotal = Math.round(nextQty * nextPrice);
                const origQty = existingItem.original_quantity !== null && existingItem.original_quantity !== undefined
                  ? existingItem.original_quantity : existingItem.approved_quantity;
                const origPrice = existingItem.original_unit_price !== null && existingItem.original_unit_price !== undefined
                  ? existingItem.original_unit_price : existingItem.unit_price;
                await db.run(
                  `UPDATE nckh_budget_items
                   SET approved_quantity = ?, unit_price = ?, total_price = ?,
                       original_quantity = ?, original_unit_price = ?,
                       notes = COALESCE(notes, '') || ?, updated_at = CURRENT_TIMESTAMP
                   WHERE id = ?`,
                  [nextQty, nextPrice, nextTotal, origQty, origPrice, ` [ĐC theo QĐ ${decNumber}]`, ch.budget_item_id]
                );
                syncedItemsCount++;
              }
            } else if (ch.action === 'ADD' && ch.item_name) {
              const qty = Number(ch.new_quantity) || 1;
              const price = Number(ch.new_unit_price) || 0;
              await db.run(
                `INSERT INTO nckh_budget_items (
                  project_id, category, item_name, specification, unit,
                  approved_quantity, original_quantity, unit_price, original_unit_price, total_price, notes, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [
                  projectId,
                  ch.category || 'Bổ sung điều chỉnh dự toán',
                  String(ch.item_name).trim(),
                  ch.specification || '',
                  ch.unit || '',
                  qty,
                  0,
                  price,
                  0,
                  Math.round(qty * price),
                  `Bổ sung theo QĐ ${decNumber}`
                ]
              );
              syncedItemsCount++;
            }
          }
        }
      } catch (syncErr) {
        console.warn('Lỗi đồng bộ item_changes_json khi phê duyệt điều chỉnh dự toán:', syncErr.message);
      }
    }

    // D. Cập nhật Danh mục Kiểm toán (Audit Checklist) -> VERIFIED (đã có bản scan mộc đỏ thật)
    await db.run(
      `INSERT INTO nckh_audit_checklist (project_id, doc_key, status, verified_by, verified_at, notes)
       VALUES (?, 'QD_DIEU_CHINH_DU_TOAN', 'VERIFIED', ?, ?, ?)
       ON CONFLICT(project_id, doc_key) DO UPDATE SET
         status = 'VERIFIED',
         verified_by = excluded.verified_by,
         verified_at = excluded.verified_at,
         notes = excluded.notes,
         updated_at = CURRENT_TIMESTAMP`,
      [projectId, approverName, decDate, `Đã có Quyết định điều chỉnh dự toán mộc đỏ số ${decNumber} (${decisionDoc.file_name})`]
    );

    // E. Gửi email thông báo cho P. TC-Cung ứng
    try {
      const tcProfile = DEMO_PROFILES.find(p => p.role === 'PHONG_TC_CU') || { fullname: 'Phòng TC-Cung ứng', email: 'p.khtc@sci.edu.vn' };
      const diffVal = Number(adj.difference_amount || 0);
      const diffFormatted = (diffVal >= 0 ? '+' : '') + diffVal.toLocaleString('vi-VN') + ' đ';
      await callService.sendNotification({
        eventType: 'BUDGET_ADJUSTMENT_APPROVED',
        recipientRole: 'PHONG_TC_CU',
        recipientEmail: tcProfile.email,
        recipientName: tcProfile.fullname,
        subject: `[Đã phê duyệt] QĐ Điều chỉnh Dự toán số ${decNumber} - Đề tài: ${project.code}`,
        bodyHtml: `<p>Viện trưởng đã phê duyệt Quyết định điều chỉnh dự toán số <strong>${decNumber}</strong> cho đề tài <strong>${project.code}</strong> (${Number(adj.old_budget).toLocaleString('vi-VN')} đ &rarr; ${Number(adj.new_budget).toLocaleString('vi-VN')} đ, chênh lệch ${diffFormatted}). Đã đồng bộ ${syncedItemsCount} hạng mục dự toán.</p>`,
        actionUrl: `/chi-tiet.html?id=${projectId}&tab=tab-supplies`,
        relatedProjectId: projectId
      });
    } catch (eMailErr) {
      console.warn('Lỗi gửi email thông báo phê duyệt điều chỉnh dự toán:', eMailErr.message);
    }

    const { logFromRequest } = require('../services/activityLogService');
    await logFromRequest(req, {
      action: 'APPROVE_BUDGET_ADJUSTMENT',
      entityType: 'BUDGET_ADJUSTMENT',
      entityId: Number(adjId),
      projectId: Number(projectId),
      summary: `Viện trưởng phê duyệt điều chỉnh dự toán QĐ ${decNumber} (${Number(adj.old_budget).toLocaleString('vi-VN')} -> ${Number(adj.new_budget).toLocaleString('vi-VN')} đ)`,
      details: { decision_number: decNumber, decision_date: decDate, new_budget: adj.new_budget }
    });

    res.json({
      success: true,
      message: `Viện trưởng đã phê duyệt thành công Quyết định điều chỉnh dự toán số ${decNumber}. Hệ thống đã tự động cập nhật ngân sách hiện hành, bổ sung hồ sơ pháp lý số hóa và đồng bộ sang danh mục kiểm toán.`,
      data: {
        project_id: projectId,
        decision_number: decNumber,
        decision_date: decDate,
        old_budget: adj.old_budget,
        new_budget: adj.new_budget,
        difference_amount: adj.difference_amount,
        approved_by: approverName
      }
    });
  } catch (err) {
    console.error('Lỗi Viện trưởng phê duyệt điều chỉnh dự toán:', err);
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

module.exports = router;
