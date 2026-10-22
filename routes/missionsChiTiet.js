'use strict';

/**
 * Nhiệm vụ KHCN — chi tiết đề tài, hồ sơ ngoài Viện và file sản phẩm. 9 endpoint.
 *
 *   GET  /api/missions/by-code/:code
 *   GET  /api/missions/:id
 *   POST /api/missions/:id/files
 *   GET|POST /api/missions/:id/ho-so-ngoai
 *   GET  /api/missions/:id/ho-so-ngoai/:fileId/download
 *   GET|POST /api/missions/:id/san-pham-files
 *   GET  /api/missions/:id/san-pham-files/:fileId/download
 *
 * Tách khỏi server.js (Đợt 1.4). Không sửa logic — chỉ đổi `app.` thành `router.`.
 *
 * ⚠️ FILE NÀY CHỨA '/missions/:id' — handler nguy hiểm nhất của cả module.
 * Nó trả 400 «ID không hợp lệ» và KHÔNG gọi next(), nên mọi route có segment chữ sau
 * /api/missions/ mà đăng ký SAU nó sẽ chết im lặng: không phải 404 mà là 400, rất khó
 * truy. Router này PHẢI mount SAU: missionsCore (/missions/stats), missionsChoXetDuyet
 * (/missions/cho-ct-hd-*) và missionsExport (/missions/export*). Đừng gộp nó với các
 * router đó, và đừng dời điểm mount lên trên.
 *
 * ⚠️ NỢ KỸ THUẬT #10 — `GET /missions/by-code/:code` KHÔNG có authMiddleware, trong khi
 * '/missions/:id' ngay dưới thì có. Nó trả về TOÀN BỘ bản ghi đề tài gồm budget,
 * approved_budget, disbursed_budget, contract_number, funding_source. Mã đề tài sinh
 * theo mẫu 'DT-<2 chữ>-<năm>-<4 số>' nên dò được. Di chuyển NGUYÊN TRẠNG ở đợt này vì
 * refactor không được đổi hành vi; có test ghim hiện trạng. Xem readme/
 * REFACTOR-PROGRESS.md mục #10 — ở đó ghi cả bằng chứng cho thấy bản vá là an toàn.
 */

const express = require('express');

module.exports = function createMissionsChiTietRouter({
  db,
  authMiddleware,
  upload,
  uploadDir,
  syncMissionsFromCapVien,
  canUserAccessMissionDetail,
  canUserAccessMissionHoSoNgoai,
  normalizeAndCheckDownloadPath,
}) {
const router = express.Router();

router.get('/missions/by-code/:code', (req, res) => {
  const code = (req.params.code || '').trim();
  if (!code) return res.status(400).json({ message: 'Mã đề tài không hợp lệ' });
  syncMissionsFromCapVien();
  const row = db.prepare('SELECT id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units, mission_type, field, objectives FROM missions WHERE code = ?').get(code);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  return res.json(row);
});

router.get('/missions/:id', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  syncMissionsFromCapVien();
  const colsBase = 'id, code, title, principal, level, status, start_date, end_date, progress, budget, source_id, source_type, managing_agency, contract_number, funding_source, approved_budget, disbursed_budget, disbursement_year, cooperating_units, mission_type, field, objectives, created_at, buoc3_trang_thai, buoc3_nguoi_xet_duyet_id, buoc3_ngay_gui, buoc3_ngay_phan_hoi, buoc3_ket_qua, buoc3_dieu_kien, buoc3_nhan_xet_khoa_hoc, buoc3_nhan_xet_kha_thi, buoc3_nhan_xet_dinh_huong, buoc3_nhan_xet_nang_luc, buoc3_ly_do_tu_choi, buoc3_lan_xet_thu, nhanh, lan_phan_nhanh';
  const cols = colsBase + ', principal_hoc_vi, principal_don_vi, principal_orcid';
  let row;
  try {
    row = db.prepare('SELECT ' + cols + ' FROM missions WHERE id = ?').get(id);
    if (!row && (req.query.code || '').trim()) row = db.prepare('SELECT ' + cols + ' FROM missions WHERE code = ?').get((req.query.code || '').trim());
  } catch (e) {
    row = db.prepare('SELECT ' + colsBase + ' FROM missions WHERE id = ?').get(id);
    if (!row && (req.query.code || '').trim()) row = db.prepare('SELECT ' + colsBase + ' FROM missions WHERE code = ?').get((req.query.code || '').trim());
    if (row) row.principal_hoc_vi = row.principal_don_vi = row.principal_orcid = null;
  }
  if (!row) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionDetail(req, row)) {
    return res.status(403).json({ message: 'Bạn không có quyền xem chi tiết đề tài này.' });
  }
  try {
    const lichSu = db.prepare('SELECT id, lan_xet, nguoi_xet_id, ngay_xet, ket_qua, nhan_xet_json, dieu_kien, ly_do_tu_choi FROM lich_su_buoc3 WHERE mission_id = ? ORDER BY lan_xet ASC').all(id);
    row.lich_su_buoc3 = lichSu.map(ls => {
      const reviewer = ls.nguoi_xet_id ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(ls.nguoi_xet_id) : null;
      return {
        lan_xet: ls.lan_xet,
        ngay_xet: ls.ngay_xet,
        nguoi_xet: reviewer ? (reviewer.fullname || reviewer.email || '') : '—',
        ket_qua: ls.ket_qua,
        nhan_xet_json: ls.nhan_xet_json,
        dieu_kien: ls.dieu_kien,
        ly_do_tu_choi: ls.ly_do_tu_choi
      };
    });
  } catch (e) {
    row.lich_su_buoc3 = [];
  }
  try {
    const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
    if (b4a) row.buoc4a = b4a;
  } catch (e) {
    row.buoc4a = null;
  }
  try {
    const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
    if (b4b) row.buoc4b = b4b;
  } catch (e) {
    row.buoc4b = null;
  }
  try {
    const b5 = db.prepare('SELECT * FROM buoc5 WHERE mission_id = ?').get(id);
    if (b5) row.buoc5 = b5;
  } catch (e) {
    row.buoc5 = null;
  }
  try {
    const tmLs = db.prepare('SELECT id, file_id, phien_ban, ghi_chu, created_at FROM buoc5_thuyet_minh_ls WHERE mission_id = ? ORDER BY created_at DESC').all(id);
    if (tmLs && tmLs.length > 0) row.buoc5_thuyet_minh_ls = tmLs;
  } catch (e) {
    row.buoc5_thuyet_minh_ls = [];
  }
  try {
    const b6 = db.prepare('SELECT * FROM buoc6 WHERE mission_id = ?').get(id);
    if (b6) row.buoc6 = b6;
  } catch (e) {
    row.buoc6 = null;
  }
  try {
    const doiNhanh = db.prepare('SELECT id, nhanh_cu, nhanh_moi, cap_cu, cap_moi, ly_do, reset_boi, reset_luc, buoc4_snapshot FROM lich_su_doi_nhanh WHERE mission_id = ? ORDER BY reset_luc DESC').all(id);
    row.lich_su_doi_nhanh = doiNhanh.map(d => {
      const u = d.reset_boi ? db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(d.reset_boi) : null;
      return {
        id: d.id,
        nhanh_cu: d.nhanh_cu,
        nhanh_moi: d.nhanh_moi,
        cap_cu: d.cap_cu,
        cap_moi: d.cap_moi,
        ly_do: d.ly_do,
        reset_boi: u ? (u.fullname || u.email || '') : '—',
        reset_luc: d.reset_luc,
        buoc4_snapshot: d.buoc4_snapshot
      };
    });
  } catch (e) {
    row.lich_su_doi_nhanh = [];
  }
  return res.json(row);
});

// Upload file đăng ký (Thuyết minh chi tiết, Văn bản xin phép Viện trưởng) — missions_files
router.post('/missions/:id/files', authMiddleware, upload.single('file'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!req.file || !req.file.path) return res.status(400).json({ message: 'Vui lòng chọn file để upload' });
  const fieldName = (req.body.field_name || '').trim();
  const allowedFields = ['thuyet_minh_chi_tiet', 'van_ban_xin_phep_vien_truong', 'buoc4a_bien_ban', 'buoc4a_danh_muc', 'buoc4a_van_ban_bo', 'buoc4a_thuyet_minh_chinh_sua', 'buoc4b_tai_lieu', 'buoc5_thuyet_minh', 'buoc5_qd_phe_duyet', 'buoc6_hd_ngoai', 'buoc6_hd_noi_bo'];
  if (!allowedFields.includes(fieldName)) return res.status(400).json({ message: 'field_name không hợp lệ' });
  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  const allowedExt = ['pdf', 'doc', 'docx'];
  if (!allowedExt.includes(ext)) return res.status(400).json({ message: 'Chỉ chấp nhận file PDF, Word (.doc, .docx)' });
  const destDir = path.join(uploadDir, 'missions', String(id));
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = Date.now() + '_' + (req.file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const destPath = path.join(destDir, finalName);
  fs.copyFileSync(req.file.path, destPath);
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  const relPath = path.join('missions', String(id), finalName);
  db.prepare('INSERT INTO missions_files (mission_id, field_name, original_name, path) VALUES (?, ?, ?, ?)').run(id, fieldName, req.file.originalname || finalName, relPath);
  const row = db.prepare('SELECT id, field_name, original_name, path, created_at FROM missions_files WHERE id = last_insert_rowid()').get();
  return res.status(201).json({ message: 'Đã lưu file.', file: row });
});

router.get('/missions/:id/ho-so-ngoai', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ đề tài này.' });
  }
  const rows = db.prepare('SELECT id, original_name, path, submission_date, note, created_at FROM missions_ho_so_ngoai WHERE mission_id = ? ORDER BY submission_date DESC, created_at DESC').all(id);
  return res.json({ files: rows });
});

router.post('/missions/:id/ho-so-ngoai', authMiddleware, upload.fields([{ name: 'files', maxCount: 20 }, { name: 'file', maxCount: 1 }]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Chỉ Admin hoặc Chủ nhiệm đề tài mới được nộp hồ sơ.' });
  }
  const files = []
    .concat((req.files && Array.isArray(req.files.files)) ? req.files.files : [])
    .concat((req.files && Array.isArray(req.files.file)) ? req.files.file : []);
  if (files.length === 0) return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 file để upload' });
  const allowed = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'zip', 'rar', '7z'];
  for (const f of files) {
    const ext = (f.originalname || '').split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      return res.status(400).json({ message: 'Chỉ chấp nhận tài liệu: PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP/RAR/7Z' });
    }
  }
  const destDir = path.join(uploadDir, 'missions', String(id));
  fs.mkdirSync(destDir, { recursive: true });
  const submissionDate = (req.body.submission_date || '').trim() || null;
  const note = (req.body.note || '').trim() || null;
  const insertStmt = db.prepare('INSERT INTO missions_ho_so_ngoai (mission_id, original_name, path, submission_date, note) VALUES (?, ?, ?, ?, ?)');
  const getLastStmt = db.prepare('SELECT id, original_name, path, submission_date, note, created_at FROM missions_ho_so_ngoai WHERE id = last_insert_rowid()');
  const savedRows = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const finalName = Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 8) + '_' + (f.originalname || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const destPath = path.join(destDir, finalName);
    fs.copyFileSync(f.path, destPath);
    try { fs.unlinkSync(f.path); } catch (_) {}
    const relPath = path.join('missions', String(id), finalName);
    insertStmt.run(id, f.originalname || finalName, relPath, submissionDate, note);
    savedRows.push(getLastStmt.get());
  }
  return res.status(201).json({
    message: 'Đã lưu ' + savedRows.length + ' hồ sơ nộp cơ quan ngoài',
    files: savedRows
  });
});

router.get('/missions/:id/ho-so-ngoai/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ đề tài này.' });
  }
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_ho_so_ngoai WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const checked = normalizeAndCheckDownloadPath(row.path);
  if (checked.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (checked.err) return res.status(404).json({ message: 'File không tồn tại' });
  const originalName = (row.original_name || 'download').replace(/[\r\n]/g, '').trim() || 'download';
  const fallbackName = originalName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(originalName)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fallbackName + '"; filename*=UTF-8\'\'' + encodedName);
  return res.sendFile(checked.norm);
});

router.get('/missions/:id/san-pham-files', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionDetail(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền xem sản phẩm của đề tài này.' });
  }
  const rows = db.prepare(
    "SELECT id, original_name, path, created_at FROM missions_files WHERE mission_id = ? AND field_name = 'san_pham_upload' ORDER BY created_at DESC, id DESC"
  ).all(id);
  return res.json({ files: rows });
});

router.post('/missions/:id/san-pham-files', authMiddleware, upload.fields([{ name: 'files', maxCount: 20 }, { name: 'file', maxCount: 1 }]), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Chỉ Admin hoặc Chủ nhiệm đề tài mới được upload sản phẩm.' });
  }
  const files = []
    .concat((req.files && Array.isArray(req.files.files)) ? req.files.files : [])
    .concat((req.files && Array.isArray(req.files.file)) ? req.files.file : []);
  if (files.length === 0) return res.status(400).json({ message: 'Vui lòng chọn ít nhất 1 file để upload' });
  const allowed = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'zip', 'rar', '7z'];
  for (const f of files) {
    const ext = (f.originalname || '').split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      return res.status(400).json({ message: 'Chỉ chấp nhận tài liệu: PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP/RAR/7Z' });
    }
  }
  const destDir = path.join(uploadDir, 'missions', String(id), 'san-pham');
  fs.mkdirSync(destDir, { recursive: true });
  const insertStmt = db.prepare('INSERT INTO missions_files (mission_id, field_name, original_name, path) VALUES (?, ?, ?, ?)');
  const getLastStmt = db.prepare('SELECT id, field_name, original_name, path, created_at FROM missions_files WHERE id = last_insert_rowid()');
  const savedRows = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const finalName = Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 8) + '_' + (f.originalname || 'file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const destPath = path.join(destDir, finalName);
    fs.copyFileSync(f.path, destPath);
    try { fs.unlinkSync(f.path); } catch (_) {}
    const relPath = path.join('missions', String(id), 'san-pham', finalName);
    insertStmt.run(id, 'san_pham_upload', f.originalname || finalName, relPath);
    savedRows.push(getLastStmt.get());
  }
  return res.status(201).json({
    message: 'Đã lưu ' + savedRows.length + ' file sản phẩm',
    files: savedRows
  });
});

router.get('/missions/:id/san-pham-files/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionDetail(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải file sản phẩm của đề tài này.' });
  }
  const row = db.prepare(
    "SELECT id, mission_id, original_name, path FROM missions_files WHERE id = ? AND mission_id = ? AND field_name = 'san_pham_upload'"
  ).get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const checked = normalizeAndCheckDownloadPath(row.path);
  if (checked.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (checked.err) return res.status(404).json({ message: 'File không tồn tại' });
  const originalName = (row.original_name || 'download').replace(/[\r\n]/g, '').trim() || 'download';
  const fallbackName = originalName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encodedName = encodeURIComponent(originalName)
    .replace(/['()]/g, escape)
    .replace(/\*/g, '%2A');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fallbackName + '"; filename*=UTF-8\'\'' + encodedName);
  return res.sendFile(checked.norm);
});

return router;
};
