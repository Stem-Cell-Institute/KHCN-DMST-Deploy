'use strict';

/**
 * Quản trị sửa/xóa Nhiệm vụ KHCN (2 endpoint).
 *
 *   PUT    /api/admin/missions/:id
 *   DELETE /api/admin/missions/:id
 *
 * Tách khỏi server.js (Đợt 6.3a của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');

module.exports = function createAdminMissionsQuanTriRouter({
  db,
  authMiddleware,
  adminOrPhongKhcnMissionEditor,
  masterAdminOnly,
  resolveMissionStatusInput,
  deleteCapVienSubmissionCascade,
  deleteMissionCascade,
  insertUserActivityLog,
}) {
  const router = express.Router();

  // Admin / Phòng KHCN: cập nhật nhiệm vụ (đề tài)
  router.put('/admin/missions/:id', authMiddleware, adminOrPhongKhcnMissionEditor, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });
    const row = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài.' });
    const { code, title, principal, principal_hoc_vi, principal_don_vi, principal_orcid, level, status, start_date, end_date, progress, budget, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units } = req.body || {};
    const updates = [];
    const params = [];
    if (code != null && String(code).trim()) { updates.push('code = ?'); params.push(String(code).trim()); }
    if (title != null) { updates.push('title = ?'); params.push(String(title).trim()); }
    if (principal !== undefined) { updates.push('principal = ?'); params.push(principal != null ? String(principal).trim() : null); }
    if (principal_hoc_vi !== undefined) { try { updates.push('principal_hoc_vi = ?'); params.push(principal_hoc_vi != null ? String(principal_hoc_vi).trim() : null); } catch (e) {} }
    if (principal_don_vi !== undefined) { try { updates.push('principal_don_vi = ?'); params.push(principal_don_vi != null ? String(principal_don_vi).trim() : null); } catch (e) {} }
    if (principal_orcid !== undefined) { try { updates.push('principal_orcid = ?'); params.push(principal_orcid != null ? String(principal_orcid).trim() : null); } catch (e) {} }
    if (level != null && ['national', 'ministry', 'university', 'school', 'coe', 'first', 'institute'].includes(level)) { updates.push('level = ?'); params.push(level); }
    if (status != null) {
      const resolved = resolveMissionStatusInput(status);
      if (resolved) {
        updates.push('status = ?');
        params.push(resolved);
      }
    }
    if (start_date != null) { updates.push('start_date = ?'); params.push(String(start_date).trim() || null); }
    if (end_date != null) { updates.push('end_date = ?'); params.push(String(end_date).trim() || null); }
    if (progress != null && !isNaN(parseInt(progress, 10))) { updates.push('progress = ?'); params.push(Math.min(100, Math.max(0, parseInt(progress, 10)))); }
    if (budget !== undefined) { updates.push('budget = ?'); params.push(budget != null && !isNaN(parseFloat(budget)) ? parseFloat(budget) : null); }
    if (managing_agency !== undefined) { updates.push('managing_agency = ?'); params.push((managing_agency || '').trim() || null); }
    if (contract_number !== undefined) { updates.push('contract_number = ?'); params.push((contract_number || '').trim() || null); }
    if (funding_source !== undefined) { updates.push('funding_source = ?'); params.push((funding_source || '').trim() || null); }
    if (approved_budget !== undefined) { updates.push('approved_budget = ?'); params.push(approved_budget != null && !isNaN(parseFloat(approved_budget)) ? parseFloat(approved_budget) : null); }
    if (disbursed_budget !== undefined) { updates.push('disbursed_budget = ?'); params.push(disbursed_budget != null && !isNaN(parseFloat(disbursed_budget)) ? parseFloat(disbursed_budget) : null); }
    if (disbursement_year !== undefined) { updates.push('disbursement_year = ?'); params.push((disbursement_year || '').trim() || null); }
    if (cooperating_units !== undefined) { updates.push('cooperating_units = ?'); params.push((cooperating_units || '').trim() || null); }
    if (updates.length === 0) return res.status(400).json({ message: 'Không có trường nào để cập nhật.' });
    params.push(id);
    db.prepare('UPDATE missions SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    const updated = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget FROM missions WHERE id = ?').get(id);
    return res.json({ message: 'Đã cập nhật đề tài.', mission: updated });
  });

  // Master Admin: xóa nhiệm vụ — nếu đồng bộ từ cấp Viện thì xóa luôn hồ sơ + tiến trình + file
  router.delete('/admin/missions/:id', authMiddleware, masterAdminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ.' });
    const row = db.prepare('SELECT id, code, title, source_type, source_id FROM missions WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài.' });
    const isCapVien = String(row.source_type || '').toLowerCase() === 'cap_vien' && row.source_id != null;
    try {
      if (isCapVien) {
        deleteCapVienSubmissionCascade(row.source_id);
      } else {
        deleteMissionCascade(id);
      }
    } catch (e) {
      const msg = e && e.message ? String(e.message) : '';
      console.error('[admin/missions DELETE]', msg || e);
      return res.status(500).json({ message: 'Không thể xóa đề tài (lỗi cơ sở dữ liệu). ' + msg });
    }
    try {
      insertUserActivityLog(req, {
        userId: req.user.id,
        email: req.user.email,
        action: isCapVien ? 'admin_delete_cap_vien_submission_and_missions' : 'admin_delete_mission',
        module: 'missions_dashboard',
        path: '/api/admin/missions/' + id,
        detail: JSON.stringify({
          code: row.code || '',
          title: (row.title || '').slice(0, 500),
          source_type: row.source_type || null,
          source_id: row.source_id != null ? row.source_id : null,
          cascade_cap_vien: !!isCapVien,
        }),
      });
    } catch (eLog) {
      /* không chặn phản hồi */
    }
    const tail = isCapVien ? ' (đã gỡ khỏi dashboard, theo dõi tiến trình và hồ sơ cấp Viện)' : '';
    return res.json({ message: 'Đã xóa đề tài "' + (row.code || '') + '" khỏi hệ thống.' + tail, deletedId: id });
  });

  return router;
};
