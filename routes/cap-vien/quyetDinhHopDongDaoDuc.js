'use strict';

/**
 * Đề tài cấp Viện — Bước 6 (Quyết định phê duyệt), Bước 7 (Hợp đồng KHCN),
 * Bước 8 (Đăng ký đạo đức) (6 endpoint).
 *
 *   PUT  /api/cap-vien/submissions/:id/steps/6/decision-meta
 *   PUT  /api/cap-vien/submissions/:id/steps/7/contract-meta
 *   POST /api/cap-vien/submissions/:id/steps/6/upload-decision
 *   POST /api/cap-vien/submissions/:id/steps/7/upload-contract
 *   PUT  /api/cap-vien/submissions/:id/steps/8/ethics-meta
 *   POST /api/cap-vien/submissions/:id/steps/8/upload-ethics-decision
 *
 * Tách khỏi server.js (Đợt 4.3 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành `router.`.
 *
 * Lưới an toàn: tests/capVien.test.js.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createCapVienQuyetDinhHopDongDaoDucRouter({
  db,
  authMiddleware,
  uploadCapVien,
  uploadDirCapVien,
  capVienStep6CanEdit,
  capVienStep6HistoryRoleDb,
  insertCapVienHistory,
  safeUnlinkCapVienStoredFile,
  fixFilenameEncoding,
}) {
const router = express.Router();

function capVienStep6DecisionAllowedStatus(st) {
  const s = String(st || '').toUpperCase();
  return ['CONDITIONAL', 'APPROVED', 'CONTRACTED', 'IMPLEMENTATION', 'COMPLETED'].includes(s);
}

/** Bước 6 — Phòng KHCN / Thư ký HĐKHCN / Admin: lưu Số QĐ, kinh phí, thời gian, phí QL (chỉnh sửa được nhiều lần) */
router.put('/cap-vien/submissions/:id/steps/6/decision-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin Quyết định.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Hồ sơ chưa đến bước Cấp Quyết định (Bước 6).' });
  }
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const soQd = norm(b.soQd !== undefined ? b.soQd : b.step6_so_qd);
  const kinhPhi = norm(b.kinhPhi !== undefined ? b.kinhPhi : b.step6_kinh_phi);
  const thoiGian = norm(b.thoiGian !== undefined ? b.thoiGian : b.step6_thoi_gian);
  const phiQuanLy = norm(b.phiQuanLy !== undefined ? b.phiQuanLy : b.step6_phi_quan_ly);
  const updatedAt = new Date().toISOString();
  const roleDb = capVienStep6HistoryRoleDb(role);
  db.prepare(`UPDATE cap_vien_submissions SET
    step6_so_qd = ?, step6_kinh_phi = ?, step6_thoi_gian = ?, step6_phi_quan_ly = ?,
    step6_meta_updated_at = ?, step6_meta_updated_by = ?
    WHERE id = ?`).run(soQd, kinhPhi, thoiGian, phiQuanLy, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '6', 'step6_meta_update', req.user.id, roleDb, 'Cập nhật thông tin Quyết định (Số QĐ, kinh phí, thời gian, phí QL)');
  return res.json({ message: 'Đã lưu thông tin Quyết định.', updatedAt });
});

function capVienStep7ContractMetaAllowedStatus(statusRaw) {
  const s = (statusRaw || '').toUpperCase();
  return s === 'APPROVED' || s === 'CONTRACTED';
}

/** Bước 7 — Phòng KHCN / Thư ký HĐKHCN / Admin: lưu Số HĐ, Hiệu lực hợp đồng */
router.put('/cap-vien/submissions/:id/steps/7/contract-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin Hợp đồng.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep7ContractMetaAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Chỉ cập nhật được khi hồ sơ đang ở Bước 7 (APPROVED) hoặc vừa hoàn thành Bước 7 (CONTRACTED).' });
  }
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const soHd = norm(b.soHd !== undefined ? b.soHd : b.step7_so_hd);
  const hieuLuc = norm(b.hieuLuc !== undefined ? b.hieuLuc : b.step7_hieu_luc);
  const updatedAt = new Date().toISOString();
  const roleDb = capVienStep6HistoryRoleDb(role);
  db.prepare(`UPDATE cap_vien_submissions SET
    step7_so_hd = ?, step7_hieu_luc = ?,
    step7_meta_updated_at = ?, step7_meta_updated_by = ?
    WHERE id = ?`).run(soHd, hieuLuc, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '7', 'step7_contract_meta_update', req.user.id, roleDb, 'Cập nhật thông tin Hợp đồng (Số HĐ, Hiệu lực)');
  return res.json({ message: 'Đã lưu thông tin Hợp đồng.', updatedAt });
});

/** Bước 6 — upload / thay thế file Quyết định VN & EN (có thể chỉ gửi một phía) */
router.post('/cap-vien/submissions/:id/steps/6/upload-decision', authMiddleware, (req, res, next) => {
  uploadCapVien.fields([
    { name: 'decision_vn', maxCount: 1 },
    { name: 'decision_en', maxCount: 1 }
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ message: 'Upload thất bại: ' + (err.message || 'Dữ liệu file không hợp lệ') });
    next();
  });
}, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được upload Quyết định.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep6DecisionAllowedStatus(sub.status)) {
    return res.status(400).json({ message: 'Hồ sơ chưa đến bước Cấp Quyết định (Bước 6).' });
  }
  const files = req.files || {};
  const fileVn = files.decision_vn && files.decision_vn[0] ? files.decision_vn[0] : null;
  const fileEn = files.decision_en && files.decision_en[0] ? files.decision_en[0] : null;
  if (!fileVn && !fileEn) return res.status(400).json({ message: 'Vui lòng chọn ít nhất một file (Quyết định VN hoặc EN).' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const roleDb = capVienStep6HistoryRoleDb(role);
  const uploadedAt = new Date().toISOString();
  const saved = [];
  function saveSlot(file, fieldName, tag) {
    if (!file || !file.path) return;
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    if (!allowedExt.includes(ext)) {
      try { fs.unlinkSync(file.path); } catch (_) {}
      throw new Error('File ' + tag + ': chỉ chấp nhận PDF hoặc Word.');
    }
    const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
    db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
    if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);
    const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
    const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
    try { fs.renameSync(file.path, newPath); } catch (e) { try { fs.copyFileSync(file.path, newPath); } catch (_) {} }
    db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
    saved.push(storedName);
  }
  try {
    saveSlot(fileVn, 'step6_decision_vn', 'VN');
    saveSlot(fileEn, 'step6_decision_en', 'EN');
  } catch (e) {
    return res.status(400).json({ message: 'Lỗi lưu file' });
  }
  insertCapVienHistory(id, '6', 'step6_decision_upload', req.user.id, roleDb, 'Upload Quyết định: ' + saved.join(', '));
  console.log('[API] cap-vien step 6 upload-decision — submission ' + id);
  return res.json({ message: 'Đã lưu file Quyết định vào hồ sơ.', files: saved });
});

/** Bước 7 — Phòng KHCN / Thư ký HĐKHCN / Admin: upload / thay thế Hợp đồng KHCN */
router.post('/cap-vien/submissions/:id/steps/7/upload-contract', authMiddleware, uploadCapVien.single('step7_hop_dong_khcn'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được upload Hợp đồng KHCN.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if ((sub.status || '').toUpperCase() !== 'APPROVED') {
    return res.status(400).json({ message: 'Chỉ upload Hợp đồng KHCN khi hồ sơ đang ở Bước 7 (trạng thái APPROVED).' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file Hợp đồng KHCN (PDF hoặc Word).' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận file PDF hoặc Word.' });
  }
  const fieldName = 'step7_hop_dong_khcn';
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const roleDb = capVienStep6HistoryRoleDb(role);
  const uploadedAt = new Date().toISOString();
  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);
  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
  try {
    fs.renameSync(file.path, newPath);
  } catch (e) {
    try { fs.copyFileSync(file.path, newPath); } catch (_) {}
  }
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
  insertCapVienHistory(id, '7', 'step7_contract_upload', req.user.id, roleDb, 'Upload Hợp đồng KHCN: ' + storedName);
  console.log('[API] cap-vien step 7 upload-contract — submission ' + id);
  return res.json({ message: 'Đã lưu Hợp đồng KHCN vào hồ sơ.', fileName: storedName });
});

function capVienStep8EthicsAllowedRow(sub) {
  if (!sub) return false;
  if ((sub.status || '').toUpperCase() !== 'CONTRACTED') return false;
  if (sub.step8_waived === 1 || sub.step8_waived === true) return false;
  return !(sub.step8_completed === 1 || sub.step8_completed === true);
}

/** Bước 8 — Phòng KHCN / Thư ký / Admin: lưu Mã đạo đức, Hiệu lực, Số/ký hiệu Quyết định */
router.put('/cap-vien/submissions/:id/steps/8/ethics-meta', authMiddleware, (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được cập nhật thông tin đạo đức.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, status, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'Chỉ cập nhật được khi hồ sơ đã ký hợp đồng (CONTRACTED), Bước 8 chưa hoàn thành và chưa bị bất hoạt.' });
  }
  const b = req.body || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  const ma = norm(b.maDaoDuc !== undefined ? b.maDaoDuc : b.step8_ma_dao_duc);
  const hieuLuc = norm(b.hieuLuc !== undefined ? b.hieuLuc : b.step8_hieu_luc);
  const soQd = norm(b.soQuyetDinh !== undefined ? b.soQuyetDinh : b.step8_so_quyet_dinh);
  const updatedAt = new Date().toISOString();
  const roleDb = capVienStep6HistoryRoleDb(role);
  db.prepare(`UPDATE cap_vien_submissions SET
    step8_ma_dao_duc = ?, step8_hieu_luc = ?, step8_so_quyet_dinh = ?,
    step8_meta_updated_at = ?, step8_meta_updated_by = ?
    WHERE id = ?`).run(ma, hieuLuc, soQd, updatedAt, req.user.id, id);
  insertCapVienHistory(id, '8', 'step8_ethics_meta_update', req.user.id, roleDb, 'Cập nhật thông tin đăng ký đạo đức (mã, hiệu lực, QĐ)');
  return res.json({ message: 'Đã lưu thông tin đạo đức.', updatedAt });
});

/** Bước 8 — upload Quyết định đạo đức (1 file) */
router.post('/cap-vien/submissions/:id/steps/8/upload-ethics-decision', authMiddleware, uploadCapVien.single('step8_ethics_quyet_dinh'), (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  if (!capVienStep6CanEdit(req)) {
    return res.status(403).json({ message: 'Chỉ Phòng KHCN, Thư ký HĐKHCN hoặc Admin mới được upload Quyết định đạo đức.' });
  }
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ message: 'ID hồ sơ không hợp lệ' });
  const sub = db.prepare('SELECT id, title, status, submittedById, COALESCE(step8_completed, 0) AS step8_completed, COALESCE(step8_waived, 0) AS step8_waived FROM cap_vien_submissions WHERE id = ?').get(id);
  if (!sub) return res.status(404).json({ message: 'Không tìm thấy hồ sơ' });
  if (!capVienStep8EthicsAllowedRow(sub)) {
    return res.status(400).json({ message: 'Chỉ upload khi hồ sơ ở CONTRACTED, Bước 8 chưa hoàn thành và chưa bị bất hoạt.' });
  }
  const file = req.file;
  if (!file || !file.path) return res.status(400).json({ message: 'Vui lòng chọn file Quyết định đạo đức.' });
  const allowedExt = ['.pdf', '.doc', '.docx'];
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (!allowedExt.includes(ext)) {
    try { fs.unlinkSync(file.path); } catch (_) {}
    return res.status(400).json({ message: 'Chỉ chấp nhận PDF hoặc Word.' });
  }
  const fieldName = 'step8_ethics_quyet_dinh';
  const firstExisting = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? LIMIT 1').get(id);
  const baseDir = firstExisting?.path ? path.dirname(firstExisting.path) : path.join(uploadDirCapVien, 'researcher_' + (sub.submittedById || 0), 'submission_' + id);
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const roleDb = capVienStep6HistoryRoleDb(role);
  const uploadedAt = new Date().toISOString();
  const oldFile = db.prepare('SELECT path FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ? LIMIT 1').get(id, fieldName);
  db.prepare('DELETE FROM cap_vien_submission_files WHERE submissionId = ? AND fieldName = ?').run(id, fieldName);
  if (oldFile && oldFile.path) safeUnlinkCapVienStoredFile(oldFile.path);
  const storedName = fixFilenameEncoding(file.originalname) || path.basename(file.path);
  const newPath = path.join(baseDir, fieldName + '_' + Date.now() + (ext || '.pdf'));
  try {
    fs.renameSync(file.path, newPath);
  } catch (e) {
    try { fs.copyFileSync(file.path, newPath); } catch (_) {}
  }
  db.prepare('INSERT INTO cap_vien_submission_files (submissionId, fieldName, originalName, path, revisionRound, uploadedById, uploadedByRole, uploadedAt) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, fieldName, storedName, newPath, req.user.id, roleDb, uploadedAt);
  insertCapVienHistory(id, '8', 'step8_ethics_upload', req.user.id, roleDb, 'Upload Quyết định đạo đức: ' + storedName);
  console.log('[API] cap-vien step 8 upload-ethics — submission ' + id);
  return res.json({ message: 'Đã lưu Quyết định đạo đức vào hồ sơ.', fileName: storedName });
});

return router;
};
