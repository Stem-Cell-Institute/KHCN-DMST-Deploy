/**
 * Route công khai & tải biểu mẫu ACE (/api/ace-templates*).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const { decodeUploadedFilename, setContentDisposition } = require('../../lib/filenames');
const db = require('../../lib/db-bridge');

module.exports = function mountAceTemplatesRoutes({
  app,
  authMiddleware,
  pathIsStrictlyInsideResolvedRoot,
  roleIsAny,
  uploadDir,
}) {
  const ACE_TEMPLATE_DEFS = [
    { type: 'nhom1_muc_luc', group: 1, label: 'Mục lục Hệ thống' },
    { type: 'nhom1_huong_dan_tong_hop', group: 1, label: 'Hướng dẫn Tổng hợp' },
    { type: 'nhom1_huong_dan_thao_tac', group: 1, label: 'Hướng dẫn Thao tác Động vật' },
    { type: 'nhom1_quy_che', group: 1, label: 'Quy chế Hội đồng' },
    { type: 'sci_ace_01', group: 2, label: 'SCI-ACE-01: Đơn đề nghị xét duyệt' },
    { type: 'sci_ace_02', group: 2, label: 'SCI-ACE-02: Phiếu thuyết minh đề tài' },
    { type: 'sci_ace_03', group: 2, label: 'SCI-ACE-03: Báo cáo tuân thủ nguyên tắc 3R' },
    { type: 'sci_ace_04', group: 2, label: 'SCI-ACE-04: Báo cáo giải trình tiếp thu' },
    { type: 'sci_ace_06', group: 2, label: 'SCI-ACE-06: Báo cáo thay đổi kế hoạch' },
    { type: 'sci_ace_07', group: 2, label: 'SCI-ACE-07: Báo cáo kết quả tuân thủ' },
    { type: 'sci_ace_pdg', group: 3, label: 'SCI-ACE-PĐG: Phiếu nhận xét thành viên Hội đồng' },
    { type: 'sci_ace_05', group: 3, label: 'SCI-ACE-05: Biên bản họp Hội đồng' },
    { type: 'sci_ace_qd_vn', group: 3, label: 'Quyết định phê duyệt (Tiếng Việt)' },
    { type: 'sci_ace_qd_en', group: 3, label: 'Decision (English)' },
  ];
  const ACE_TEMPLATE_TYPES = ACE_TEMPLATE_DEFS.map((d) => d.type);
  const ACE_TEMPLATE_BY_TYPE = {};
  ACE_TEMPLATE_DEFS.forEach((d) => { ACE_TEMPLATE_BY_TYPE[d.type] = d; });

  /** Admin hoặc Thư ký Hội đồng (KHCN/SCI-ACE dùng chung role) mới được cập nhật mẫu hồ sơ SCI-ACE. */
  function aceCanManageTemplates(req) {
    return roleIsAny(req, ['admin', 'thu_ky']);
  }

  app.get('/api/ace-templates', (req, res) => {
    const rows = db.prepare('SELECT template_type, original_name, updated_at FROM ace_templates').all();
    const byType = {};
    rows.forEach((r) => { byType[r.template_type] = r; });
    const templates = ACE_TEMPLATE_DEFS.map((d) => ({
      type: d.type,
      group: d.group,
      label: d.label,
      original_name: byType[d.type] ? byType[d.type].original_name : null,
      updated_at: byType[d.type] ? byType[d.type].updated_at : null,
      has_file: !!byType[d.type],
    }));
    return res.json({ templates });
  });

  app.get('/api/ace-templates/can-manage', authMiddleware, (req, res) => {
    return res.json({ canManage: aceCanManageTemplates(req) });
  });

  app.get('/api/ace-templates/:type/download', authMiddleware, (req, res) => {
    const type = (req.params.type || '').trim();
    if (!ACE_TEMPLATE_TYPES.includes(type)) return res.status(400).json({ message: 'Loại mẫu không hợp lệ' });
    const row = db.prepare('SELECT template_type, original_name, path FROM ace_templates WHERE template_type = ?').get(type);
    if (!row) return res.status(404).json({ message: 'Chưa có mẫu này' });
    const templatesRoot = path.resolve(uploadDir, 'ace-templates');
    const fullPath = path.resolve(templatesRoot, String(row.path || '').trim());
    if (!pathIsStrictlyInsideResolvedRoot(templatesRoot, fullPath)) {
      return res.status(403).json({ message: 'Đường dẫn file mẫu không hợp lệ' });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
    setContentDisposition(res, row.original_name || 'download');
    return res.sendFile(fullPath);
  });

  return { ACE_TEMPLATE_BY_TYPE, ACE_TEMPLATE_TYPES, aceCanManageTemplates };
};
