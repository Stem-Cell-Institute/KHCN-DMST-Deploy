/**
 * Service Quản lý Dự toán, Khóa Hạn mức (Quota) & Đối chiếu Tiến độ Thực tế vs Dự toán (Budget vs. Actual)
 */
const db = require('../db/db');
const projectService = require('./projectService');

let schemaEnsured = false;

async function ensureBudgetSupplySchema() {
  if (schemaEnsured) return;
  try {
    const budgetCols = await db.all('PRAGMA table_info(nckh_budget_items)');
    const bNames = new Set(budgetCols.map(c => c.name));
    if (!bNames.has('category')) {
      await db.run("ALTER TABLE nckh_budget_items ADD COLUMN category TEXT DEFAULT 'Hóa chất & Vật tư'");
    }
    if (!bNames.has('original_quantity')) {
      await db.run('ALTER TABLE nckh_budget_items ADD COLUMN original_quantity REAL');
    }
    if (!bNames.has('original_unit_price')) {
      await db.run('ALTER TABLE nckh_budget_items ADD COLUMN original_unit_price REAL');
    }
    if (!bNames.has('updated_at')) {
      await db.run('ALTER TABLE nckh_budget_items ADD COLUMN updated_at TEXT');
    }

    const supplyCols = await db.all('PRAGMA table_info(nckh_supplies)');
    const sNames = new Set(supplyCols.map(c => c.name));
    if (!sNames.has('unit_price')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN unit_price REAL DEFAULT 0');
    }
    if (!sNames.has('actual_unit_price')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN actual_unit_price REAL DEFAULT 0');
    }
    if (!sNames.has('actual_total_cost')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN actual_total_cost REAL DEFAULT 0');
    }
    if (!sNames.has('over_budget_qty')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN over_budget_qty REAL DEFAULT 0');
    }
    if (!sNames.has('khcn_approval_status')) {
      await db.run("ALTER TABLE nckh_supplies ADD COLUMN khcn_approval_status TEXT DEFAULT 'PENDING'");
    }
    if (!sNames.has('khcn_approved_by')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN khcn_approved_by TEXT');
    }
    if (!sNames.has('khcn_approved_at')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN khcn_approved_at TEXT');
    }
    if (!sNames.has('pi_confirmed_received')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN pi_confirmed_received INTEGER DEFAULT 0');
    }
    if (!sNames.has('pi_confirmed_at')) {
      await db.run('ALTER TABLE nckh_supplies ADD COLUMN pi_confirmed_at TEXT');
    }

    const adjCols = await db.all('PRAGMA table_info(nckh_budget_adjustments)');
    const aNames = new Set(adjCols.map(c => c.name));
    if (!aNames.has('item_changes_json')) {
      await db.run('ALTER TABLE nckh_budget_adjustments ADD COLUMN item_changes_json TEXT');
    }

    const projCols = await db.all('PRAGMA table_info(nckh_projects)');
    const pNames = new Set(projCols.map(c => c.name));
    if (!pNames.has('budget_approval_status')) {
      await db.run("ALTER TABLE nckh_projects ADD COLUMN budget_approval_status TEXT DEFAULT 'DRAFT'");
    }
    if (!pNames.has('budget_locked_at')) {
      await db.run('ALTER TABLE nckh_projects ADD COLUMN budget_locked_at TEXT');
    }
    if (!pNames.has('budget_locked_by')) {
      await db.run('ALTER TABLE nckh_projects ADD COLUMN budget_locked_by TEXT');
    }
    if (!pNames.has('budget_approval_doc_id')) {
      await db.run('ALTER TABLE nckh_projects ADD COLUMN budget_approval_doc_id INTEGER');
    }

    schemaEnsured = true;
  } catch (err) {
    console.warn('ensureBudgetSupplySchema warning:', err.message);
  }
}

/**
 * Tính toán toàn bộ KPI Dự toán vs Thực tế, Quota từng hạng mục, Trạng thái pháp lý mộc đỏ và Cảnh báo tiến độ lệch pha
 */
function computeProjectBudgetAnalytics(project, budgetItems = [], supplies = [], documents = []) {
  const budgetMap = new Map();
  budgetItems.forEach(b => {
    budgetMap.set(Number(b.id), {
      ...b,
      approved_quantity: Number(b.approved_quantity) || 0,
      unit_price: Number(b.unit_price) || 0,
      total_price: Number(b.total_price) || ((Number(b.approved_quantity) || 0) * (Number(b.unit_price) || 0)),
      total_requested_qty: 0,
      total_received_qty: 0,
      actual_spent: 0,
      committed_cost: 0,
      supply_count: 0,
      over_quota_requests: 0
    });
  });

  let totalCommittedAmount = 0;
  let totalActualDisbursed = 0;
  let overBudgetCount = 0;
  let outsideBudgetCount = 0;
  let pendingKhcnCount = 0;
  let unfulfilledCount = 0;
  let totalRequestedQtyAll = 0;
  let totalReceivedQtyAll = 0;

  const enrichedSupplies = supplies.map(s => {
    const reqQty = Number(s.requested_quantity) || 0;
    const recQty = Number(s.received_quantity) || 0;
    const linkedBudget = s.budget_item_id ? budgetMap.get(Number(s.budget_item_id)) : null;
    const isRejected = s.khcn_approval_status === 'REJECTED';

    const refUnitPrice = Number(s.unit_price) || (linkedBudget ? linkedBudget.unit_price : 0);
    const actualUnitPrice = Number(s.actual_unit_price) || 0;
    const effectiveUnitPrice = actualUnitPrice > 0 ? actualUnitPrice : refUnitPrice;

    const estimatedCost = Math.round(reqQty * effectiveUnitPrice);
    const actualTotalCost = Number(s.actual_total_cost) > 0
      ? Number(s.actual_total_cost)
      : Math.round(recQty * effectiveUnitPrice);

    const priceVariance = (actualUnitPrice > 0 && refUnitPrice > 0)
      ? Math.round((actualUnitPrice - refUnitPrice) * recQty)
      : 0;

    if (!isRejected) {
      totalCommittedAmount += estimatedCost;
      totalActualDisbursed += actualTotalCost;
      totalRequestedQtyAll += reqQty;
      totalReceivedQtyAll += Math.min(recQty, reqQty);

      if (linkedBudget) {
        linkedBudget.total_requested_qty += reqQty;
        linkedBudget.total_received_qty += recQty;
        linkedBudget.actual_spent += actualTotalCost;
        linkedBudget.committed_cost += estimatedCost;
        linkedBudget.supply_count += 1;
      }
    }

    const checkStatus = s.budget_check_status || (linkedBudget ? 'Trong dự toán' : 'Ngoài dự toán');
    if (!isRejected) {
      if (checkStatus === 'Vượt định mức' || Number(s.over_budget_qty) > 0) {
        overBudgetCount++;
        if (linkedBudget) linkedBudget.over_quota_requests++;
      } else if (checkStatus === 'Ngoài dự toán' || !linkedBudget) {
        outsideBudgetCount++;
      }
    }

    if ((s.khcn_approval_status || 'PENDING') === 'PENDING') {
      pendingKhcnCount++;
    }
    if (!isRejected && s.fulfillment_status !== 'Đã nhận đủ') {
      unfulfilledCount++;
    }

    return {
      ...s,
      quota_quantity: linkedBudget ? linkedBudget.approved_quantity : null,
      budget_item_name: linkedBudget ? linkedBudget.item_name : null,
      unit_price: refUnitPrice,
      actual_unit_price: actualUnitPrice,
      estimated_cost: estimatedCost,
      actual_total_cost: actualTotalCost,
      price_variance: priceVariance,
      khcn_approval_status: s.khcn_approval_status || 'PENDING'
    };
  });

  // Finalize enriched budget items with quota status
  let budgetItemsTotalValue = 0;
  let totalApprovedQtyAll = 0;
  let totalBudgetReceivedQtyAll = 0;
  let overQuotaItemsCount = 0;

  const enrichedBudgetItems = Array.from(budgetMap.values()).map(item => {
    budgetItemsTotalValue += item.total_price;
    totalApprovedQtyAll += item.approved_quantity;
    totalBudgetReceivedQtyAll += Math.min(item.total_received_qty, item.approved_quantity);

    const remainingQuota = Number((item.approved_quantity - item.total_requested_qty).toFixed(2));
    const remainingToReceive = Number(Math.max(0, item.approved_quantity - item.total_received_qty).toFixed(2));
    const requestPct = item.approved_quantity > 0 ? Math.round((item.total_requested_qty / item.approved_quantity) * 100) : 0;
    const fulfillmentPct = item.approved_quantity > 0 ? Math.round((item.total_received_qty / item.approved_quantity) * 100) : 0;

    let quotaStatus = 'OK';
    if (item.total_requested_qty > item.approved_quantity || item.total_received_qty > item.approved_quantity) {
      quotaStatus = 'OVER_QUOTA';
      overQuotaItemsCount++;
    } else if (item.approved_quantity > 0 && item.total_requested_qty >= item.approved_quantity) {
      quotaStatus = 'EXHAUSTED';
    } else if (requestPct >= 85) {
      quotaStatus = 'NEAR_LIMIT';
    }

    return {
      ...item,
      remaining_quota_qty: remainingQuota,
      remaining_to_receive_qty: remainingToReceive,
      request_pct: requestPct,
      fulfillment_pct: fulfillmentPct,
      quota_status: quotaStatus
    };
  });

  const baseBudget = Number(project?.budget_total) || 0;
  const revisedBudget = project?.budget_revised ? Number(project.budget_revised) : null;
  const effectiveBudget = revisedBudget || baseBudget || budgetItemsTotalValue || 0;
  const remainingBudget = effectiveBudget - totalActualDisbursed;
  const disbursementPct = effectiveBudget > 0 ? Math.round((totalActualDisbursed / effectiveBudget) * 1000) / 10 : 0;
  const committedPct = effectiveBudget > 0 ? Math.round((totalCommittedAmount / effectiveBudget) * 1000) / 10 : 0;

  // Supply fulfillment progress (%)
  let supplyProgressPct = 0;
  if (totalRequestedQtyAll > 0) {
    supplyProgressPct = Math.round((totalReceivedQtyAll / totalRequestedQtyAll) * 100);
  } else if (totalApprovedQtyAll > 0) {
    supplyProgressPct = Math.round((totalBudgetReceivedQtyAll / totalApprovedQtyAll) * 100);
  }

  // Time elapsed progress (%)
  let timeElapsedPct = 0;
  const startDate = projectService.parseDate(project?.decision_date);
  const endDate = projectService.parseDate(project?.current_end_date || project?.base_end_date);
  if (startDate && endDate && endDate.getTime() > startDate.getTime()) {
    const now = new Date();
    const totalMs = endDate.getTime() - startDate.getTime();
    const elapsedMs = now.getTime() - startDate.getTime();
    timeElapsedPct = Math.max(0, Math.min(100, Math.round((elapsedMs / totalMs) * 100)));
  }

  // Pace & Risk Alerts
  const alerts = [];
  if (effectiveBudget > 0 && totalActualDisbursed > effectiveBudget) {
    alerts.push({
      level: 'RED',
      code: 'OVER_TOTAL_BUDGET',
      message: `Tổng thực chi (${totalActualDisbursed.toLocaleString('vi-VN')} đ) đã VƯỢT dự toán hiệu lực (${effectiveBudget.toLocaleString('vi-VN')} đ) là ${(totalActualDisbursed - effectiveBudget).toLocaleString('vi-VN')} đ!`
    });
  } else if (effectiveBudget > 0 && totalCommittedAmount > effectiveBudget) {
    alerts.push({
      level: 'YELLOW',
      code: 'COMMITTED_OVER_BUDGET',
      message: `Tổng giá trị đề xuất cấp phát (${totalCommittedAmount.toLocaleString('vi-VN')} đ) vượt dự toán hiệu lực. Cần rà soát hoặc lập Tờ trình điều chỉnh dự toán.`
    });
  }

  if (overQuotaItemsCount > 0 || overBudgetCount > 0) {
    alerts.push({
      level: 'RED',
      code: 'OVER_ITEM_QUOTA',
      message: `Có ${Math.max(overQuotaItemsCount, overBudgetCount)} hạng mục/yêu cầu VƯỢT ĐỊNH MỨC số lượng dự toán đã duyệt. Cần P. KH&CN / Viện trưởng xem xét.`
    });
  }

  if (outsideBudgetCount > 0) {
    alerts.push({
      level: 'YELLOW',
      code: 'OUTSIDE_BUDGET_ITEMS',
      message: `Có ${outsideBudgetCount} dòng đề xuất vật tư NGOÀI DỰ TOÁN (hoặc chưa liên kết với danh mục dự toán).`
    });
  }

  if (effectiveBudget > 0 && disbursementPct >= 80 && timeElapsedPct > 0 && timeElapsedPct < 50) {
    alerts.push({
      level: 'YELLOW',
      code: 'FAST_BURN_RATE',
      message: `Tốc độ giải ngân nhanh (${disbursementPct}% dự toán) trong khi mới qua ${timeElapsedPct}% thời gian thực hiện — lưu ý cân đối kinh phí giai đoạn sau.`
    });
  }

  const isCompleted = (project?.status || '').toUpperCase() === 'COMPLETED' || (project?.final_evaluation || '').toLowerCase().includes('nghiệm thu');
  if (!isCompleted && timeElapsedPct >= 50 && supplyProgressPct < 30 && (enrichedBudgetItems.length > 0 || enrichedSupplies.length > 0)) {
    alerts.push({
      level: 'YELLOW',
      code: 'SLOW_SUPPLY_PROGRESS',
      message: `Đề tài đã qua ${timeElapsedPct}% thời gian nhưng tiến độ nhận vật tư mới đạt ${supplyProgressPct}% — nguy cơ chậm tiến độ nghiên cứu.`
    });
  }

  if (budgetItemsTotalValue > 0 && effectiveBudget > 0 && Math.abs(budgetItemsTotalValue - effectiveBudget) > 1000) {
    alerts.push({
      level: 'INFO',
      code: 'BUDGET_DETAIL_MISMATCH',
      message: `Tổng danh mục dự toán chi tiết (${budgetItemsTotalValue.toLocaleString('vi-VN')} đ) đang chênh lệch so với tổng kinh phí phê duyệt (${effectiveBudget.toLocaleString('vi-VN')} đ).`
    });
  }

  // Kiểm tra văn bản Dự toán có dấu mộc đỏ & Trạng thái Chốt khóa (Baseline Lock)
  const docList = Array.isArray(documents) ? documents : [];
  let redSealDoc = null;
  if (project?.budget_approval_doc_id) {
    redSealDoc = docList.find(d => Number(d.id) === Number(project.budget_approval_doc_id)) || null;
  }
  if (!redSealDoc) {
    redSealDoc = docList.find(d => d.doc_type === 'DU_TOAN_DA_DUYET') || null;
  }
  const isBudgetLocked = (project?.budget_approval_status || 'DRAFT') === 'LOCKED';
  const hasRedSealDoc = Boolean(redSealDoc);

  if (!hasRedSealDoc) {
    alerts.unshift({
      level: 'YELLOW',
      code: 'MISSING_RED_SEAL_BUDGET',
      message: 'Chưa tải lên Bản scan Dự toán kinh phí đã phê duyệt có dấu mộc đỏ (DU_TOAN_DA_DUYET). Cần tải lên bản mộc đỏ và Chốt khóa dự toán để làm căn cứ cấp phát.'
    });
  } else if (!isBudgetLocked) {
    alerts.unshift({
      level: 'INFO',
      code: 'BUDGET_NOT_LOCKED',
      message: 'Đã có Bản scan Dự toán phê duyệt nhưng bảng số liệu dự toán chi tiết chưa được Chốt & Khóa (Baseline Lock). P. KH&CN nên bấm "Chốt & Khóa dự toán gốc" để ngăn chỉnh sửa tự do.'
    });
  }

  return {
    legal_status: {
      budget_approval_status: isBudgetLocked ? 'LOCKED' : 'DRAFT',
      is_locked: isBudgetLocked,
      locked_by: project?.budget_locked_by || null,
      locked_at: project?.budget_locked_at || null,
      has_red_seal_doc: hasRedSealDoc,
      red_seal_doc: redSealDoc ? {
        id: redSealDoc.id,
        title: redSealDoc.title,
        file_name: redSealDoc.file_name,
        file_size: redSealDoc.file_size,
        uploaded_by: redSealDoc.uploaded_by,
        uploaded_at: redSealDoc.uploaded_at
      } : null
    },
    summary: {
      base_budget: baseBudget,
      revised_budget: revisedBudget,
      effective_budget: effectiveBudget,
      budget_items_total: budgetItemsTotalValue,
      committed_amount: totalCommittedAmount,
      actual_disbursed: totalActualDisbursed,
      remaining_budget: remainingBudget,
      disbursement_pct: disbursementPct,
      committed_pct: committedPct,
      supply_progress_pct: supplyProgressPct,
      time_elapsed_pct: timeElapsedPct,
      total_budget_items: enrichedBudgetItems.length,
      total_supplies: enrichedSupplies.length,
      fully_fulfilled: enrichedSupplies.filter(s => s.fulfillment_status === 'Đã nhận đủ').length,
      unfulfilled_count: unfulfilledCount,
      over_budget_count: overBudgetCount,
      over_quota_items_count: overQuotaItemsCount,
      outside_budget_count: outsideBudgetCount,
      pending_khcn_count: pendingKhcnCount
    },
    alerts,
    budget_items: enrichedBudgetItems,
    supplies: enrichedSupplies
  };
}

module.exports = {
  ensureBudgetSupplySchema,
  computeProjectBudgetAnalytics
};
