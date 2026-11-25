'use strict';

/**
 * Đề tài cấp Viện — nhóm nộp hồ sơ mới, danh mục công khai và mẫu hồ sơ công khai (10 endpoint).
 *
 *   POST   /api/cap-vien/submissions
 *   GET    /api/cap-vien/submission-options
 *   GET    /api/cap-vien/linh-vuc
 *   GET    /api/cap-vien/loai-de-tai
 *   GET    /api/cap-vien/don-vi
 *   GET    /api/cap-vien/khoan-muc-chi
 *   GET    /api/cap-vien/public-templates
 *   GET    /api/cap-vien/public-templates/:taskCode/file
 *   POST   /api/cap-vien/public-templates/:taskCode
 *   DELETE /api/cap-vien/public-templates/:taskCode
 *
 * Tách khỏi server.js (Đợt 4.1 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint: đường dẫn, tham số, mã trạng thái, thông báo lỗi. Không sửa một dòng
 * logic nào — chỉ cắt–dán và đổi `app.` thành `router.` (mount ở '/api').
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createCapVienNopHoSoVaDanhMucRouter({
  db,
  authMiddleware,
  adminOnly,
  uploadCapVien,
  uploadCapVienPublicTemplate,
  uploadDirCapVien,
  sanitizeFolderName,
  fixFilenameEncoding,
  insertCapVienHistory,
  sendCapVienNewSubmissionEmail,
  CAP_VIEN_PUBLIC_TEMPLATE_CATALOG,
  isAllowedTaskCode,
  resolveStoredFileFromDb,
  capVienPublicTemplatesFsDir,
  pathIsStrictlyInsideResolvedRoot,
  resolveCapVienPublicTemplateStoredFileForUnlink,
  appRootDir,
}) {
const router = express.Router();

router.post('/cap-vien/submissions', authMiddleware, uploadCapVien.fields([
  { name: 'sci_ace_01', maxCount: 1 },
  { name: 'sci_ace_02', maxCount: 1 },
  { name: 'sci_ace_03', maxCount: 1 },
  { name: 'attachments', maxCount: 10 }
]), (req, res) => {
  const title = (req.body.title || req.body.titleDisplay || '').trim();
  if (!title) {
    return res.status(400).json({ message: 'Vui lòng nhập tên đề tài / mã hồ sơ' });
  }
  const files = req.files || {};
  const f01 = files.sci_ace_01 && files.sci_ace_01[0];
  const f02 = files.sci_ace_02 && files.sci_ace_02[0];
  const f03 = files.sci_ace_03 && files.sci_ace_03[0];
  if (!f01 || !f02 || !f03) {
    return res.status(400).json({ message: 'Cần đủ 3 file: Thuyết minh, Kế hoạch, Tài liệu bổ sung' });
  }
  let optionsChecked = [];
  try {
    const raw = req.body.options_checked;
    if (raw) optionsChecked = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw || '[]') : []);
  } catch (e) { optionsChecked = []; }
  if (!Array.isArray(optionsChecked)) optionsChecked = [];

  const run = db.transaction(() => {
    const year = new Date().getFullYear();
    let seqRow = db.prepare('SELECT seq FROM cap_vien_code_sequences WHERE year = ?').get(year);
    if (!seqRow) {
      // Khởi tạo bộ đếm từ mã lớn nhất đang có trong năm, tránh cấp lại số cũ sau khi hồ sơ bị xóa.
      const maxRow = db.prepare(
        "SELECT MAX(CAST(SUBSTR(code, -3) AS INTEGER)) AS maxSeq FROM cap_vien_submissions WHERE code LIKE '%-' || ? || '-%'"
      ).get(String(year));
      db.prepare('INSERT INTO cap_vien_code_sequences (year, seq) VALUES (?, ?)').run(year, (maxRow && maxRow.maxSeq) || 0);
    }
    // Bộ đếm chỉ tăng, không bao giờ giảm theo COUNT(*) — nhờ đó mã không bị trùng khi có hồ sơ bị xóa ở giữa.
    db.prepare('UPDATE cap_vien_code_sequences SET seq = seq + 1 WHERE year = ?').run(year);
    const seq = db.prepare('SELECT seq FROM cap_vien_code_sequences WHERE year = ?').get(year).seq;
    const baseCode = 'DTSCI-' + year + '-' + String(seq).padStart(3, '0');
    // Sắp theo sort_order để thứ tự nhãn trong mã luôn nhất quán (không phụ thuộc thứ tự client gửi lên).
    const optsWithAffect = db.prepare('SELECT code FROM cap_vien_submission_options WHERE affects_code = 1 ORDER BY sort_order ASC, id ASC').all();
    const affectCodes = optsWithAffect.map(r => (r.code || '').toUpperCase()).filter(Boolean);
    const checkedAffectSet = new Set(optionsChecked.map(c => (c || '').toUpperCase()));
    // Gộp TẤT CẢ các ô "Ảnh hưởng mã số" đã tick vào mã — trước đây chỉ lấy ô đầu tiên, các ô còn lại bị bỏ sót.
    const checkedAffect = affectCodes.filter(c => checkedAffectSet.has(c));
    let code = baseCode;
    if (checkedAffect.length > 0) {
      const suffix = checkedAffect.join('-');
      code = 'DTSCI-' + suffix + '-' + year + '-' + String(seq).padStart(3, '0');
    }
    const optionsCheckedJson = JSON.stringify(optionsChecked);
    const sub = db.prepare('INSERT INTO cap_vien_submissions (title, submittedBy, submittedById, code, options_checked) VALUES (?, ?, ?, ?, ?)').run(title, req.user.email, req.user.id, code, optionsCheckedJson);
    const subId = sub.lastInsertRowid;
    const researcherName = sanitizeFolderName(req.user.fullname) || sanitizeFolderName(req.user.email.split('@')[0]);
    const researcherFolder = researcherName + '_' + req.user.id;
    const finalDir = path.join(uploadDirCapVien, researcherFolder, 'submission_' + subId);
    fs.mkdirSync(finalDir, { recursive: true });
    const move = (f, fieldName) => {
      if (!f || !f.path) return;
      const newPath = path.join(finalDir, path.basename(f.path));
      try { fs.renameSync(f.path, newPath); } catch (e) { try { fs.copyFileSync(f.path, newPath); } catch (_) {} }
      const storedName = fixFilenameEncoding(f.originalname) || path.basename(f.path);
      db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound) VALUES (?, ?, ?, ?, 0)').run(subId, fieldName, storedName, newPath);
    };
    move(f01, 'thuyet_minh');
    move(f02, 'ke_hoach');
    move(f03, 'tai_lieu_bo_sung');
    (files.attachments || []).forEach((f, i) => move(f, 'attachment_' + i));
    const tempDir = req._uploadDirCapVien;
    if (tempDir && fs.existsSync(tempDir)) {
      try { fs.rmSync(tempDir, { recursive: true }); } catch (_) {}
    }
    return subId;
  })();
  const id = Number(run);
  const row = db.prepare('SELECT createdAt, status FROM cap_vien_submissions WHERE id = ?').get(id);
  insertCapVienHistory(id, '1', 'researcher_submit', req.user.id, 'researcher', 'Nghiên cứu viên nộp hồ sơ đề xuất', row ? row.createdAt : null);
  sendCapVienNewSubmissionEmail({
    submissionId: id,
    submissionTitle: title,
    submittedByEmail: req.user.email,
    submittedByName: req.user.fullname,
    createdAt: row ? row.createdAt : null,
    status: row ? row.status : 'SUBMITTED'
  });
  return res.status(201).json({ id, message: 'Đã gửi hồ sơ đề tài cấp Viện thành công' });
});

// Ô đánh dấu khi nộp đề tài cấp Viện (CoE, Kinh phí Viện...) — public để form hiển thị
router.get('/cap-vien/submission-options', (req, res) => {
  const rows = db.prepare('SELECT id, code, label, affects_code FROM cap_vien_submission_options ORDER BY sort_order ASC, id ASC').all();
  return res.json({ options: rows || [] });
});

// Danh mục hạng mục (public, dùng trong form nộp hồ sơ)
router.get('/cap-vien/linh-vuc', (req, res) => {
  const rows = db.prepare('SELECT id, code, label FROM cap_vien_linh_vuc ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
router.get('/cap-vien/loai-de-tai', (req, res) => {
  const rows = db.prepare('SELECT id, code, label FROM cap_vien_loai_de_tai ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
router.get('/cap-vien/don-vi', (req, res) => {
  const rows = db.prepare('SELECT id, code, label FROM cap_vien_don_vi ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});
router.get('/cap-vien/khoan-muc-chi', (req, res) => {
  const rows = db.prepare('SELECT id, code, label, parent_code FROM cap_vien_khoan_muc_chi ORDER BY sort_order ASC, id ASC').all();
  return res.json({ items: rows || [] });
});

// ── Mẫu hồ sơ công khai (trang tai-mau-ho-so-de-tai-cap-vien) — Admin upload; mọi người tải khi đã có file ──
router.get('/cap-vien/public-templates', (req, res) => {
  try {
    const rows = db.prepare('SELECT task_code, original_name, uploaded_at FROM cap_vien_public_template_files').all();
    const byCode = new Map((rows || []).map((r) => [r.task_code, r]));
    const tasks = CAP_VIEN_PUBLIC_TEMPLATE_CATALOG.map((item) => {
      const row = byCode.get(item.code);
      return {
        taskCode: item.code,
        label: item.label,
        hasFile: !!row,
        originalName: row ? row.original_name : null,
        uploadedAt: row ? row.uploaded_at : null,
      };
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ tasks });
  } catch (e) {
    console.error('[public-templates list]', e);
    return res.status(500).json({ message: 'Lỗi CSDL' });
  }
});

router.get('/cap-vien/public-templates/:taskCode/file', (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(404).json({ message: 'Mã mẫu không hợp lệ' });
  }
  const row = db.prepare('SELECT stored_path, original_name FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'Chưa có file mẫu cho mã này. Vui lòng liên hệ quản trị hoặc thử lại sau.' });
  }
  const abs = resolveStoredFileFromDb(row.stored_path);
  const baseDir = path.resolve(capVienPublicTemplatesFsDir);
  if (!abs || !pathIsStrictlyInsideResolvedRoot(baseDir, abs) || !fs.existsSync(abs)) {
    return res.status(404).json({ message: 'File không còn trên máy chủ' });
  }
  res.set('Cache-Control', 'no-store');
  return res.download(abs, row.original_name || path.basename(abs));
});

router.post(
  '/cap-vien/public-templates/:taskCode',
  authMiddleware,
  adminOnly,
  uploadCapVienPublicTemplate.single('file'),
  (req, res) => {
    const taskCode = (req.params.taskCode || '').trim();
    if (!isAllowedTaskCode(taskCode)) {
      return res.status(400).json({ message: 'Mã mẫu không hợp lệ' });
    }
    const f = req.file;
    if (!f) {
      return res.status(400).json({ message: 'Thiếu file (form field: file)' });
    }
    const relWithinCapVien = path.relative(uploadDirCapVien, f.path);
    const relStored =
      !relWithinCapVien.startsWith('..') && !path.isAbsolute(relWithinCapVien)
        ? 'uploads-cap-vien/' + relWithinCapVien.split(path.sep).join('/')
        : path.relative(appRootDir, f.path).split(path.sep).join('/');
    const orig = fixFilenameEncoding(f.originalname) || path.basename(f.path);
    try {
      const prev = db.prepare('SELECT stored_path FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
      if (prev && prev.stored_path) {
        const oldAbs = resolveCapVienPublicTemplateStoredFileForUnlink(prev.stored_path);
        if (oldAbs) {
          try {
            fs.unlinkSync(oldAbs);
          } catch (_) {}
        }
      }
      db.prepare(
        `INSERT INTO cap_vien_public_template_files (task_code, stored_path, original_name, uploaded_at, uploaded_by_id)
         VALUES (?, ?, ?, datetime('now'), ?)
         ON CONFLICT(task_code) DO UPDATE SET
           stored_path = excluded.stored_path,
           original_name = excluded.original_name,
           uploaded_at = excluded.uploaded_at,
           uploaded_by_id = excluded.uploaded_by_id`
      ).run(taskCode, relStored, orig, req.user.id);
      return res.json({ ok: true, message: 'Đã cập nhật mẫu', taskCode, originalName: orig });
    } catch (e) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch (_) {}
      console.error('[public-templates upload]', e);
      return res.status(500).json({ message: 'Lỗi lưu' });
    }
  }
);

router.delete('/cap-vien/public-templates/:taskCode', authMiddleware, adminOnly, (req, res) => {
  const taskCode = (req.params.taskCode || '').trim();
  if (!isAllowedTaskCode(taskCode)) {
    return res.status(400).json({ message: 'Mã mẫu không hợp lệ' });
  }
  const row = db.prepare('SELECT stored_path FROM cap_vien_public_template_files WHERE task_code = ?').get(taskCode);
  if (!row) {
    return res.status(404).json({ message: 'Không có file để xóa' });
  }
  try {
    const p = resolveCapVienPublicTemplateStoredFileForUnlink(row.stored_path);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    }
    db.prepare('DELETE FROM cap_vien_public_template_files WHERE task_code = ?').run(taskCode);
    return res.json({ ok: true, message: 'Đã xóa mẫu' });
  } catch (e) {
    console.error('[public-templates delete]', e);
    return res.status(500).json({ message: 'Lỗi xóa' });
  }
});

return router;
};
