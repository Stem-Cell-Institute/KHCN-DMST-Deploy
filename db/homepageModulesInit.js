/**
 * Cấu hình mặc định và migration thứ tự các module trên Trang chủ.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../lib/db-bridge');

module.exports = function initHomepageModules() {
  const HOMEPAGE_MODULES_DEFAULT = [
    { code: 'missions', label: 'Quản lý nhiệm vụ KHCN', enabled: 1 },
    { code: 'cap_vien', label: 'Quản lý đề tài cấp Viện', enabled: 1 },
    { code: 'ethics_ace', label: 'Hội đồng đạo đức trên động vật (SCI-ACE)', enabled: 1 },
    { code: 'personnel', label: 'Quản lý Nhân lực KHCN', enabled: 0 },
    { code: 'ip', label: 'Quản lý Tài sản Trí tuệ', enabled: 0 },
    { code: 'finance', label: 'Quản lý Tài chính KHCN', enabled: 0 },
    { code: 'publications', label: 'Quản lý Công bố Khoa học', enabled: 0 },
    { code: 'cooperation', label: 'Quản lý Hợp tác', enabled: 1 },
    { code: 'equipment_stims', label: 'Quản trị thiết bị', enabled: 1 },
    { code: 'sample_storage', label: 'Ngân hàng Tế bào & Kháng thể', enabled: 1 },
    { code: 'tech_transfer', label: 'Quản lý Chuyển giao Công nghệ', enabled: 0 },
    { code: 'facilities', label: 'CRD Lab Booking', enabled: 1 },
    { code: 'ethics_integrity', label: 'Đạo đức và Liêm chính khoa học', enabled: 0 },
    { code: 'reward', label: 'Quản lý Khen thưởng & Đánh giá', enabled: 0 },
    { code: 'dms', label: 'Quản lý tài liệu & hồ sơ (Hành chính)', enabled: 1 },
    { code: 'document_workflow', label: 'Quy trình văn bản nội bộ', enabled: 1 },
    { code: 'department_reports', label: 'Báo cáo phòng ban', enabled: 1 },
  ];

  (function migrateHomepageModuleSortOrder() {
    try {
      db.prepare('ALTER TABLE homepage_modules ADD COLUMN sort_order INTEGER DEFAULT 0').run();
    } catch (e) { /* cột đã tồn tại */ }
    const flag = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_modules_sort_migrated');
    if (flag && flag.value === '1') return;
    try {
      HOMEPAGE_MODULES_DEFAULT.forEach((m, i) => {
        db.prepare('INSERT OR IGNORE INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)').run(m.code, m.label, m.enabled ? 1 : 0, i);
        db.prepare('UPDATE homepage_modules SET sort_order = ? WHERE code = ?').run(i, m.code);
      });
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_modules_sort_migrated', '1');
    } catch (e) {
      console.warn('[DB] migrateHomepageModuleSortOrder:', e.message || e);
    }
  })();

  (function migrateHomepageModuleOrderJson() {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
      if (row && row.value && String(row.value).trim()) return;
      const rowsFull = db.prepare('SELECT code, sort_order FROM homepage_modules ORDER BY sort_order, code').all();
      if (!rowsFull || rowsFull.length < HOMEPAGE_MODULES_DEFAULT.length) return;
      const distinct = new Set(rowsFull.map(r => r.sort_order ?? 0)).size;
      const codes =
        distinct <= 1
          ? HOMEPAGE_MODULES_DEFAULT.map(m => m.code)
          : rowsFull.map(r => r.code);
      db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_module_order', JSON.stringify(codes));
    } catch (e) {
      console.warn('[DB] migrateHomepageModuleOrderJson:', e.message || e);
    }
  })();

  /** Xóa dòng homepage_modules sai (vd. code=reorder do route /:code nuốt path /reorder) và sửa JSON homepage_module_order */
  (function repairHomepageModulesCorruption() {
    try {
      const expectedList = HOMEPAGE_MODULES_DEFAULT.map(m => m.code);
      const expectedCodes = new Set(expectedList);
      const allCodes = db.prepare('SELECT code FROM homepage_modules').all();
      allCodes.forEach(r => {
        if (!expectedCodes.has(r.code)) {
          db.prepare('DELETE FROM homepage_modules WHERE code = ?').run(r.code);
        }
      });
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
      if (!row || row.value == null || String(row.value).trim() === '') return;
      let parsed;
      try {
        parsed = JSON.parse(row.value);
      } catch (e) {
        db.prepare('DELETE FROM system_settings WHERE key = ?').run('homepage_module_order');
        return;
      }
      if (!Array.isArray(parsed)) {
        db.prepare('DELETE FROM system_settings WHERE key = ?').run('homepage_module_order');
        return;
      }
      const filtered = [];
      const seen = new Set();
      parsed.forEach(c => {
        const code = String(c || '').trim();
        if (expectedCodes.has(code) && !seen.has(code)) {
          seen.add(code);
          filtered.push(code);
        }
      });
      expectedList.forEach(code => {
        if (!seen.has(code)) filtered.push(code);
      });
      if (JSON.stringify(parsed) !== JSON.stringify(filtered)) {
        db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run('homepage_module_order', JSON.stringify(filtered));
      }
    } catch (e) {
      console.warn('[DB] repairHomepageModulesCorruption:', e.message || e);
    }
  })();

  /** Nối mã document_workflow vào JSON thứ tự cũ (13 mã) để kéo thả admin không lỗi */
  (function migrateHomepageModuleOrderAddDocumentWorkflow() {
    try {
      const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
      if (!row || row.value == null || String(row.value).trim() === '') return;
      let parsed;
      try {
        parsed = JSON.parse(row.value);
      } catch (e) {
        return;
      }
      if (!Array.isArray(parsed) || parsed.includes('document_workflow')) return;
      if (parsed.length !== HOMEPAGE_MODULES_DEFAULT.length - 1) return;
      const idx = parsed.indexOf('dms');
      if (idx >= 0) parsed.splice(idx + 1, 0, 'document_workflow');
      else parsed.push('document_workflow');
      if (parsed.length === HOMEPAGE_MODULES_DEFAULT.length) {
        db.prepare('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)').run(
          'homepage_module_order',
          JSON.stringify(parsed)
        );
      }
    } catch (e) {
      console.warn('[DB] migrateHomepageModuleOrderAddDocumentWorkflow:', e.message || e);
    }
  })();

  /** Bổ sung dòng homepage_modules mới (sau khi mở rộng HOMEPAGE_MODULES_DEFAULT) */
  (function ensureAllHomepageModulesExist() {
    try {
      let next =
        (db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM homepage_modules').get() || {}).m;
      next = Number(next);
      if (!Number.isFinite(next)) next = -1;
      next += 1;
      HOMEPAGE_MODULES_DEFAULT.forEach((m) => {
        const ex = db.prepare('SELECT code FROM homepage_modules WHERE code = ?').get(m.code);
        if (!ex) {
          db.prepare(
            'INSERT INTO homepage_modules (code, label, enabled, sort_order) VALUES (?, ?, ?, ?)'
          ).run(m.code, m.label, m.enabled ? 1 : 0, next);
          next += 1;
        }
      });
    } catch (e) {
      console.warn('[DB] ensureAllHomepageModulesExist:', e.message || e);
    }
  })();

  return { HOMEPAGE_MODULES_DEFAULT };
};
