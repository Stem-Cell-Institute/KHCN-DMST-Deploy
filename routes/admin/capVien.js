'use strict';

/**
 * Quản trị Đề tài cấp Viện & đồng bộ nhiệm vụ KHCN (28 endpoint).
 *
 *   /api/admin/cap-vien/submission-options*
 *   /api/admin/cap-vien/{linh_vuc,loai_de_tai,don_vi,khoan_muc_chi}*
 *   /api/admin/missions/sync-from-cap-vien
 *   /api/admin/cap-vien/submissions*
 *   /api/admin/cap-vien/settings/*
 *
 * Tách khỏi server.js (Đợt 6.1 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/admin.test.js.
 */

const express = require('express');

module.exports = function createAdminCapVienRouter({
  db,
  authMiddleware,
  adminOnly,
  syncMissionsFromCapVien,
  getCapVienStep7EmailOnComplete,
  getChairmanEmailControls,
  CHAIRMAN_EMAIL_CONTROL_KEY,
  CHAIRMAN_EMAIL_CONTROL_DEFAULTS,
  getCouncilMemberEmailControls,
  COUNCIL_MEMBER_EMAIL_CONTROL_KEY,
  COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS,
}) {
  const router = express.Router();

  // Admin: CRUD ô đánh dấu
  router.get('/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
    const rows = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
    return res.json({ options: rows || [] });
  });

  router.post('/admin/cap-vien/submission-options', authMiddleware, adminOnly, (req, res) => {
    const { code, label, affects_code } = req.body || {};
    const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
    const labelStr = (label != null ? String(label).trim() : '') || codeStr;
    if (!codeStr) return res.status(400).json({ message: 'Mã option không được để trống' });
    try {
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cap_vien_submission_options').get();
      const nextOrder = (maxOrder && maxOrder.m != null ? maxOrder.m : 0) + 1;
      db.prepare('INSERT INTO cap_vien_submission_options (code, label, affects_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, affects_code ? 1 : 0, nextOrder);
      const row = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE code = ?').get(codeStr);
      return res.status(201).json({ message: 'Đã thêm ô đánh dấu', option: row });
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(400).json({ message: 'Mã option đã tồn tại' });
      throw e;
    }
  });

  router.put('/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { code, label, affects_code, sort_order } = req.body || {};
    const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy option' });
    const codeStr = (code != null ? String(code).trim() : '').replace(/\s+/g, '_');
    const labelStr = (label != null ? String(label).trim() : '');
    const updates = [];
    const params = [];
    if (codeStr !== '') { updates.push('code = ?'); params.push(codeStr); }
    if (labelStr !== '') { updates.push('label = ?'); params.push(labelStr); }
    if (affects_code !== undefined) { updates.push('affects_code = ?'); params.push(affects_code ? 1 : 0); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10) || 0); }
    if (updates.length === 0) return res.json({ message: 'Không có thay đổi' });
    params.push(id);
    db.prepare('UPDATE cap_vien_submission_options SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
    const updated = db.prepare('SELECT id, code, label, affects_code, sort_order FROM cap_vien_submission_options WHERE id = ?').get(id);
    return res.json({ message: 'Đã cập nhật', option: updated });
  });

  router.delete('/admin/cap-vien/submission-options/:id', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT id FROM cap_vien_submission_options WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy option' });
    db.prepare('DELETE FROM cap_vien_submission_options WHERE id = ?').run(id);
    return res.json({ message: 'Đã xóa ô đánh dấu' });
  });

  // Admin: CRUD danh mục cấp Viện
  function crudCapVienTable(tableName, singularLabel) {
    const table = 'cap_vien_' + tableName;
    router.get('/admin/cap-vien/' + tableName, authMiddleware, adminOnly, (req, res) => {
      const rows = db.prepare('SELECT id, code, label, sort_order' + (tableName === 'khoan_muc_chi' ? ', parent_code' : '') + ' FROM ' + table + ' ORDER BY sort_order ASC, id ASC').all();
      return res.json({ items: rows });
    });
    router.post('/admin/cap-vien/' + tableName, authMiddleware, adminOnly, (req, res) => {
      const { code, label, parent_code } = req.body || {};
      const codeStr = (code || '').toString().trim().replace(/\s+/g, '_');
      const labelStr = (label || codeStr || '').toString().trim();
      if (!codeStr) return res.status(400).json({ message: 'Mã không được để trống' });
      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM ' + table).get();
      try {
        if (tableName === 'khoan_muc_chi') {
          db.prepare('INSERT INTO ' + table + ' (code, label, parent_code, sort_order) VALUES (?, ?, ?, ?)').run(codeStr, labelStr, (parent_code || '').trim() || null, (maxOrder.m || 0) + 1);
        } else {
          db.prepare('INSERT INTO ' + table + ' (code, label, sort_order) VALUES (?, ?, ?)').run(codeStr, labelStr, (maxOrder.m || 0) + 1);
        }
        const row = db.prepare('SELECT * FROM ' + table + ' WHERE code = ?').get(codeStr);
        return res.json({ message: 'Đã thêm ' + singularLabel, item: row });
      } catch (e) {
        if (e.message && e.message.includes('UNIQUE')) return res.status(400).json({ message: 'Mã đã tồn tại' });
        throw e;
      }
    });
    router.put('/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
      const id = parseInt(req.params.id, 10);
      const { code, label, parent_code, sort_order } = req.body || {};
      const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      const updates = [];
      const params = [];
      if (code != null) { updates.push('code = ?'); params.push(String(code).trim().replace(/\s+/g, '_')); }
      if (label != null) { updates.push('label = ?'); params.push(String(label).trim()); }
      if (parent_code !== undefined && tableName === 'khoan_muc_chi') { updates.push('parent_code = ?'); params.push((parent_code || '').trim() || null); }
      if (sort_order != null) { updates.push('sort_order = ?'); params.push(parseInt(sort_order, 10)); }
      if (updates.length) {
        params.push(id);
        db.prepare('UPDATE ' + table + ' SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);
      }
      const updated = db.prepare('SELECT * FROM ' + table + ' WHERE id = ?').get(id);
      return res.json({ message: 'Đã cập nhật', item: updated });
    });
    router.delete('/admin/cap-vien/' + tableName + '/:id', authMiddleware, adminOnly, (req, res) => {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      db.prepare('DELETE FROM ' + table + ' WHERE id = ?').run(id);
      return res.json({ message: 'Đã xóa ' + singularLabel });
    });
  }
  crudCapVienTable('linh_vuc', 'lĩnh vực');
  crudCapVienTable('loai_de_tai', 'loại đề tài');
  crudCapVienTable('don_vi', 'đơn vị');
  crudCapVienTable('khoan_muc_chi', 'khoản mục chi');

  // Admin: đồng bộ nhiệm vụ KHCN từ đề tài cấp Viện
  router.post('/admin/missions/sync-from-cap-vien', authMiddleware, adminOnly, (req, res) => {
    try {
      db.prepare("DELETE FROM missions_hidden WHERE source_type = 'cap_vien'").run();
    } catch (e) {
      /* bảng có thể chưa tồn tại trên DB rất cũ */
    }
    syncMissionsFromCapVien();
    const count = db.prepare('SELECT COUNT(*) AS n FROM missions WHERE source_type = ?').get('cap_vien');
    return res.json({ message: 'Đã đồng bộ nhiệm vụ KHCN từ đề tài cấp Viện.', count: count.n });
  });

  // Admin: danh sách đề tài cấp Viện (đầy đủ, cho quản trị)
  router.get('/admin/cap-vien/submissions', authMiddleware, adminOnly, (req, res) => {
    const rows = db.prepare('SELECT id, title, submittedBy, submittedById, status, createdAt, code FROM cap_vien_submissions ORDER BY createdAt DESC').all();
    rows.forEach(r => {
      const u = db.prepare('SELECT fullname FROM users WHERE id = ?').get(r.submittedById);
      r.submittedByName = u ? u.fullname : null;
    });
    return res.json({ submissions: rows });
  });

  // Admin: cài đặt email cấp Viện & sửa mã đề tài
  router.get('/admin/cap-vien/settings/step7-complete-email', authMiddleware, adminOnly, (req, res) => {
    return res.json({ enabled: getCapVienStep7EmailOnComplete() });
  });

  router.put('/admin/cap-vien/settings/step7-complete-email', authMiddleware, adminOnly, (req, res) => {
    const body = req.body || {};
    const raw = body.enabled !== undefined ? body.enabled : body.sendEmail;
    const on = raw === true || raw === 1 || String(raw).toLowerCase() === 'true' || String(raw) === '1';
    const val = on ? '1' : '0';
    db.prepare('INSERT INTO cooperation_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('cap_vien_step7_complete_send_email', val);
    return res.json({ message: on ? 'Đã bật gửi email khi hoàn thành Bước 7.' : 'Đã tắt gửi email khi hoàn thành Bước 7.', enabled: on });
  });

  router.get('/admin/cap-vien/settings/chairman-email-controls', authMiddleware, adminOnly, (req, res) => {
    return res.json({ controls: getChairmanEmailControls(), defaults: CHAIRMAN_EMAIL_CONTROL_DEFAULTS });
  });

  router.put('/admin/cap-vien/settings/chairman-email-controls', authMiddleware, adminOnly, (req, res) => {
    const incoming = (req.body && req.body.controls && typeof req.body.controls === 'object') ? req.body.controls : {};
    const merged = Object.assign({}, CHAIRMAN_EMAIL_CONTROL_DEFAULTS);
    Object.keys(merged).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(incoming, k)) merged[k] = !!incoming[k];
    });
    db.prepare('INSERT INTO cooperation_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(CHAIRMAN_EMAIL_CONTROL_KEY, JSON.stringify(merged));
    return res.json({ message: 'Đã lưu cấu hình email cho Chủ tịch HĐKHCN.', controls: merged });
  });

  router.get('/admin/cap-vien/settings/council-member-email-controls', authMiddleware, adminOnly, (req, res) => {
    return res.json({ controls: getCouncilMemberEmailControls(), defaults: COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS });
  });

  router.put('/admin/cap-vien/settings/council-member-email-controls', authMiddleware, adminOnly, (req, res) => {
    const incoming = (req.body && req.body.controls && typeof req.body.controls === 'object') ? req.body.controls : {};
    const merged = Object.assign({}, COUNCIL_MEMBER_EMAIL_CONTROL_DEFAULTS);
    Object.keys(merged).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(incoming, k)) merged[k] = !!incoming[k];
    });
    db.prepare('INSERT INTO cooperation_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(COUNCIL_MEMBER_EMAIL_CONTROL_KEY, JSON.stringify(merged));
    return res.json({ message: 'Đã lưu cấu hình email cho thành viên HĐKHCN (ngoài Chủ tịch).', controls: merged });
  });

  router.put('/admin/cap-vien/submissions/:id/code', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const newCode = (req.body && req.body.code != null) ? String(req.body.code).trim() : '';
    const row = db.prepare('SELECT id FROM cap_vien_submissions WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
    if (!newCode) return res.status(400).json({ message: 'Mã đề tài không được để trống' });
    db.prepare('UPDATE cap_vien_submissions SET code = ? WHERE id = ?').run(newCode, id);
    return res.json({ message: 'Đã cập nhật mã đề tài', code: newCode });
  });

  return router;
};
