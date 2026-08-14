/**
 * Mẫu hồ sơ đăng ký đề tài ngoài Viện — /api/missions-templates,
 * /api/admin/missions-templates
 *
 * Tách khỏi server.js, giữ nguyên hành vi từng endpoint. Bộ test khói phủ
 * endpoint danh sách; hai endpoint còn lại giữ nguyên logic đường dẫn và
 * phân quyền như bản cũ.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { setContentDisposition } = require('../lib/filenames');

const ALLOWED_EXT = ['pdf', 'doc', 'docx'];

/**
 * @param {object} deps
 * @param {object}   deps.db
 * @param {Function} deps.authMiddleware
 * @param {Function} deps.adminOnly
 * @param {object}   deps.upload                      instance multer đã cấu hình
 * @param {string}   deps.uploadDir                   thư mục uploads gốc
 * @param {string[]} deps.templateTypes               mã loại mẫu hợp lệ
 * @param {object}   deps.templateLabels              nhãn hiển thị theo mã
 * @param {Function} deps.pathIsStrictlyInsideResolvedRoot  chặn path traversal
 */
module.exports = function createMissionsTemplatesRouter({
  db,
  authMiddleware,
  adminOnly,
  upload,
  uploadDir,
  templateTypes,
  templateLabels,
  pathIsStrictlyInsideResolvedRoot,
}) {
  const router = express.Router();
  const templatesRoot = () => path.resolve(uploadDir, 'templates');

  router.get('/missions-templates', (req, res) => {
    const rows = db.prepare('SELECT template_type, original_name, updated_at FROM missions_templates').all();
    return res.json({ templates: rows });
  });

  router.get('/missions-templates/:type/download', authMiddleware, (req, res) => {
    const type = (req.params.type || '').trim();
    if (!templateTypes.includes(type)) return res.status(400).json({ message: 'Loại mẫu không hợp lệ' });
    const row = db
      .prepare('SELECT template_type, original_name, path FROM missions_templates WHERE template_type = ?')
      .get(type);
    if (!row) return res.status(404).json({ message: 'Chưa có mẫu này' });
    const root = templatesRoot();
    const fullPath = path.resolve(root, String(row.path || '').trim());
    if (!pathIsStrictlyInsideResolvedRoot(root, fullPath)) {
      return res.status(403).json({ message: 'Đường dẫn file mẫu không hợp lệ' });
    }
    if (!fs.existsSync(fullPath)) return res.status(404).json({ message: 'File không tồn tại' });
    setContentDisposition(res, row.original_name || 'download');
    return res.sendFile(fullPath);
  });

  router.post('/admin/missions-templates', authMiddleware, adminOnly, upload.single('file'), (req, res) => {
    const type = (req.body.template_type || '').trim();
    if (!templateTypes.includes(type)) {
      return res
        .status(400)
        .json({ message: 'template_type phải là: thuyet_minh_chi_tiet hoặc van_ban_xin_phep_vien_truong' });
    }
    if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
    const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận PDF, Word (.doc, .docx)' });

    const destDir = path.join(uploadDir, 'templates');
    fs.mkdirSync(destDir, { recursive: true });
    const finalName = type + '_' + Date.now() + '.' + ext;
    fs.copyFileSync(req.file.path, path.join(destDir, finalName));
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    db.prepare(
      "INSERT OR REPLACE INTO missions_templates (template_type, original_name, path, updated_at) VALUES (?, ?, ?, datetime('now'))"
    ).run(type, req.file.originalname || finalName, finalName);
    const row = db
      .prepare('SELECT template_type, original_name, updated_at FROM missions_templates WHERE template_type = ?')
      .get(type);
    return res.status(201).json({ message: 'Đã cập nhật mẫu ' + (templateLabels[type] || type), template: row });
  });

  return router;
};
