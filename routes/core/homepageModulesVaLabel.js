/**
 * Route công khai cấu hình module trang chủ (/api/homepage-modules) và nhãn tiêu chuẩn (/api/settings/standard-label).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const db = require('../../lib/db-bridge');

module.exports = function mountHomepageModulesAndLabelRoutes({ HOMEPAGE_MODULES_DEFAULT, app }) {
  app.get('/api/homepage-modules', (req, res) => {
    let rows = db.prepare('SELECT code, enabled, sort_order FROM homepage_modules ORDER BY sort_order, code').all();
    if (!rows || rows.length === 0) {
      rows = HOMEPAGE_MODULES_DEFAULT.map((m, i) => ({ code: m.code, enabled: m.enabled ? 1 : 0, sort_order: i }));
      return res.json({ modules: rows });
    }
    const expectedCodes = new Set(HOMEPAGE_MODULES_DEFAULT.map(m => m.code));
    const orderRow = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('homepage_module_order');
    if (orderRow && orderRow.value) {
      try {
        const parsed = JSON.parse(orderRow.value);
        if (Array.isArray(parsed) && parsed.length === HOMEPAGE_MODULES_DEFAULT.length && parsed.every(c => expectedCodes.has(c))) {
          const byCode = {};
          rows.forEach(r => { byCode[r.code] = r; });
          rows = parsed.map((code, i) => {
            const r = byCode[code];
            return { code, enabled: r ? r.enabled : 1, sort_order: i };
          });
        }
      } catch (e) { /* giữ rows từ DB */ }
    }
    return res.json({ modules: rows });
  });

  // Tiêu chuẩn hệ thống (ISO9001...) — hiển thị trên header trang chủ; Admin có thể sửa/xóa
  app.get('/api/settings/standard-label', (req, res) => {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('standard_label');
    const value = (row && row.value != null) ? String(row.value).trim() : null;
    return res.json({ label: value === '' ? '' : (value || 'ISO9001') });
  });
};
