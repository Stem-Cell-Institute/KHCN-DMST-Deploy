'use strict';

/**
 * Nhiệm vụ KHCN — hồ sơ đăng ký và duyệt Bước 2–3.
 *
 *   GET  /api/missions/:id/files
 *   GET  /api/missions/:id/cn-info
 *   GET  /api/missions/:id/files/:fileId/download
 *   GET  /api/missions/:id/files/:fileId/view
 *   POST /api/missions/:id/step2-approve | step2-request-supplement | step2-reject
 *   POST /api/missions/:id/step3-submit | step3-confirm-4a | step3-confirm-4b
 *   POST /api/missions/:id/step3-request-revision | step3-stop
 *   POST /api/missions/:id/reset-ve-buoc3
 *
 * Tách khỏi server.js (Đợt 1.2 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi
 * từng endpoint. Không sửa một dòng logic nào — chỉ cắt–dán và đổi `app.` thành
 * `router.` ở đúng 13 dòng khai báo.
 *
 * BA MIDDLEWARE VAI TRÒ khác nhau trong nhóm này, đừng nhầm lẫn khi sửa:
 *   thuyKyOrAdmin    — admin, thu_ky            (step2-*, step3-confirm-*, step3-stop…)
 *   chuTichOrAdmin   — admin, chu_tich          (step3-submit)
 *   adminOrPhongKhcn — admin, phong_khcn, thu_ky (reset-ve-buoc3)
 * Bộ test khói phủ ranh giới phân quyền của cả 9 endpoint POST bằng token
 * vien_truong (bị cả ba từ chối).
 *
 * Mọi phụ thuộc truyền vào đều được định nghĩa trong server.js TRƯỚC điểm mount
 * (`transporter` ở dòng ~3412), nên truyền theo giá trị là an toàn. Nếu sau này mount
 * sớm hơn thì phải đổi sang truyền getter.
 */

const express = require('express');

module.exports = function createMissionsHoSoRouter({
  db,
  authMiddleware,
  thuyKyOrAdmin,
  chuTichOrAdmin,
  adminOrPhongKhcn,
  transporter,
  PORT,
  canUserAccessMissionHoSoNgoai,
  computeNhanhFromLevel,
  getChairmanEmail,
  getNotificationEmails,
  getSmtpFrom,
  isChairmanEmailEnabled,
  normalizeAndCheckDownloadPath,
}) {
const router = express.Router();

// Danh sách file đăng ký (Thuyết minh, Văn bản xin phép)
router.get('/missions/:id/files', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const rows = db.prepare('SELECT id, field_name, original_name, path, created_at FROM missions_files WHERE mission_id = ? ORDER BY created_at ASC').all(id);
  return res.json({ files: rows });
});

// Thông tin CN + nhiệm vụ đang thực hiện + cảnh báo Điều 10 (cho trang CT HĐ xét duyệt)
router.get('/missions/:id/cn-info', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  let mission = db.prepare('SELECT id, principal, level FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  try {
    const ext = db.prepare('SELECT principal_hoc_vi, principal_don_vi, principal_orcid FROM missions WHERE id = ?').get(id);
    if (ext) {
      mission.principal_hoc_vi = ext.principal_hoc_vi || '';
      mission.principal_don_vi = ext.principal_don_vi || '';
      mission.principal_orcid = ext.principal_orcid || '';
    }
  } catch (e) {
    mission.principal_hoc_vi = mission.principal_don_vi = mission.principal_orcid = '';
  }
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const principal = (mission.principal || '').trim();
  const ongoingStatuses = ['cho_vien_xet_chon', 'cho_ct_hd_xet_duyet', 'buoc4a', 'buoc4b', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_phe_duyet_ngoai', 'da_phe_duyet', 'approved', 'cho_ky_hop_dong', 'dang_thuc_hien', 'ongoing', 'xin_dieu_chinh', 'cho_nghiem_thu_co_so', 'nghiem_thu_trung_gian', 'review', 'cho_nghiem_thu_bo_nn', 'nghiem_thu_tong_ket', 'hoan_thien_sau_nghiem_thu', 'thanh_ly_hop_dong'];
  const ongoing = principal ? db.prepare(
    'SELECT id, code, title, level, status FROM missions WHERE id != ? AND LOWER(TRIM(principal)) = LOWER(?) AND status IN (' + ongoingStatuses.map(() => '?').join(',') + ') ORDER BY start_date DESC'
  ).all(id, principal, ...ongoingStatuses) : [];
  const nationalCount = ongoing.filter(m => (m.level || '').toLowerCase() === 'national').length;
  const totalCount = ongoing.length;
  const warningNational = nationalCount >= 1;
  const warningMaxCount = totalCount >= 3;
  return res.json({
    principal: mission.principal || '',
    principal_hoc_vi: mission.principal_hoc_vi || '',
    principal_don_vi: mission.principal_don_vi || '',
    principal_orcid: mission.principal_orcid || '',
    level: mission.level || '',
    ongoing,
    warning_dieu10_national: warningNational,
    warning_dieu10_max: warningMaxCount
  });
});

router.get('/missions/:id/files/:fileId/download', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền tải hồ sơ đề tài này.' });
  }
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_files WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const checked = normalizeAndCheckDownloadPath(row.path);
  if (checked.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (checked.err) return res.status(404).json({ message: 'File không tồn tại' });
  setContentDisposition(res, row.original_name || 'download');
  return res.sendFile(checked.norm);
});

// Xem file inline (PDF viewer) — cần token trong URL hoặc cookie
router.get('/missions/:id/files/:fileId/view', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fileId = parseInt(req.params.fileId, 10);
  if (!id || !fileId) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if (!canUserAccessMissionHoSoNgoai(req, mission)) {
    return res.status(403).json({ message: 'Bạn không có quyền xem hồ sơ đề tài này.' });
  }
  const row = db.prepare('SELECT id, mission_id, original_name, path FROM missions_files WHERE id = ? AND mission_id = ?').get(fileId, id);
  if (!row) return res.status(404).json({ message: 'Không tìm thấy file' });
  const checked = normalizeAndCheckDownloadPath(row.path);
  if (checked.err === 403) return res.status(403).json({ message: 'Truy cập bị từ chối' });
  if (checked.err) return res.status(404).json({ message: 'File không tồn tại' });
  const ext = (row.original_name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    setContentDisposition(res, row.original_name || 'view.pdf', { inline: true });
  }
  return res.sendFile(checked.norm);
});

// Bước 2 — Thư ký/Admin: Hồ sơ hợp lệ → chuyển sang Bước 3 (Chờ CT HĐ KHCN xét duyệt)
router.post('/missions/:id/step2-approve', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, level, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2 (Phòng KHCN kiểm tra)' });
  }
  const now = new Date().toISOString();
  const nhanh = computeNhanhFromLevel(mission.level);
  db.prepare(`UPDATE missions SET status = ?, buoc3_trang_thai = ?, buoc3_ngay_gui = ?, nhanh = ? WHERE id = ?`).run('cho_ct_hd_xet_duyet', 'cho_xet_duyet', now, nhanh, id);
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const chairmanEmail = getChairmanEmail();
  const reviewUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/ct-hd-xet-duyet-de-tai.html?id=' + id;
  if (transporter && chairmanEmail && isChairmanEmailEnabled('ngoai_vien_step2_to_chairman')) {
    const subject = '[Đề tài ngoài Viện] Có 1 đề tài chờ anh/chị xét duyệt: ' + (mission.title || '');
    const text = 'Phòng KHCN&QHĐN đã xác nhận hồ sơ hợp lệ. Có 1 đề tài chờ anh/chị xét duyệt: "' + (mission.title || '') + '" (Chủ nhiệm: ' + (mission.principal || '') + '). Vào xem và điền phiếu nhận xét: ' + reviewUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã xác nhận hồ sơ hợp lệ.</p><p><strong>Có 1 đề tài chờ anh/chị xét duyệt:</strong> ' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + ' (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p><p>Vui lòng vào xem thuyết minh và điền phiếu nhận xét.</p><p><a href="' + reviewUrl + '" style="color:#1565c0;font-weight:600">Vào trang xét duyệt</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: chairmanEmail, subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Phòng KHCN đã chuyển lên Bước 3: ' + (mission.title || '');
    const html = '<p>Phòng KHCN&QHĐN đã xác nhận hồ sơ hợp lệ. Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> đã chuyển sang <strong>Bước 3 — Chờ CT HĐ KHCN xét duyệt</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 3 (Chờ CT HĐ xét duyệt). Email đã gửi đến Chủ tịch Hội đồng.', status: 'cho_ct_hd_xet_duyet' });
});

// Bước 2 — Thư ký/Admin: Yêu cầu bổ sung (hồ sơ vẫn ở bước 2)
router.post('/missions/:id/step2-request-supplement', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2' });
  }
  const note = (req.body && req.body.note) ? String(req.body.note).trim() : '';
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Yêu cầu bổ sung hồ sơ: ' + (mission.title || '');
    const noteBlock = note ? '<p><strong>Nội dung yêu cầu bổ sung:</strong></p><p>' + note.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' : '';
    const text = 'Phòng KHCN&QHĐN đã yêu cầu bổ sung hồ sơ cho đề tài "' + (mission.title || '') + '". ' + (note ? 'Nội dung: ' + note : '') + ' Xem: ' + timelineUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã yêu cầu bổ sung hồ sơ cho đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p>' + noteBlock + '<p>Hồ sơ vẫn ở bước 2. Chủ nhiệm cần bổ sung theo yêu cầu.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình đề tài</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã gửi yêu cầu bổ sung. Email đã gửi đến Chủ nhiệm và Hội đồng.' });
});

// Bước 2 — Thư ký/Admin: Từ chối
router.post('/missions/:id/step2-reject', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.status || '') !== 'cho_vien_xet_chon') {
    return res.status(400).json({ message: 'Chỉ thực hiện khi đề tài đang ở bước 2' });
  }
  const reason = (req.body && req.body.reason) ? String(req.body.reason).trim() : '';
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('khong_duoc_phe_duyet', id);
  const actor = (req.user.fullname || req.user.email || 'Thư ký').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề xuất không được chấp thuận: ' + (mission.title || '');
    const reasonBlock = reason ? '<p><strong>Lý do:</strong></p><p>' + reason.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>' : '';
    const text = 'Phòng KHCN&QHĐN đã từ chối đề xuất "' + (mission.title || '') + '". ' + (reason ? 'Lý do: ' + reason : '') + ' Xem: ' + timelineUrl;
    const html = '<p>Phòng KHCN&QHĐN (' + actor + ') đã từ chối đề xuất đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ').</p>' + reasonBlock + '<p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình đề tài</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text, html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã từ chối đề xuất. Email đã gửi đến Hội đồng.', status: 'khong_duoc_phe_duyet' });
});

// Bước 3 — CT HĐ KHCN: Submit phiếu nhận xét
router.post('/missions/:id/step3-submit', authMiddleware, chuTichOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, code, title, principal, level, status, buoc3_trang_thai, buoc3_lan_xet_thu FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'cho_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài không ở trạng thái chờ xét duyệt' });
  }
  const body = req.body || {};
  const ketQua = (body.ket_qua || '').trim();
  const validKetQua = ['dong_y', 'dong_y_co_dieu_kien', 'khong_dong_y'];
  if (!validKetQua.includes(ketQua)) return res.status(400).json({ message: 'Kết luận phải là: dong_y, dong_y_co_dieu_kien, hoặc khong_dong_y' });
  const nhanXetKhoaHoc = (body.nhan_xet_khoa_hoc || '').trim();
  const nhanXetKhaThi = (body.nhan_xet_kha_thi || '').trim();
  const nhanXetDinhHuong = (body.nhan_xet_dinh_huong || '').trim();
  const nhanXetNangLuc = (body.nhan_xet_nang_luc || '').trim();
  if (!nhanXetKhoaHoc || !nhanXetKhaThi || !nhanXetDinhHuong || !nhanXetNangLuc) {
    return res.status(400).json({ message: 'Vui lòng điền đủ 4 mục nhận xét' });
  }
  if (ketQua === 'dong_y_co_dieu_kien') {
    const dieuKien = (body.dieu_kien || '').trim();
    if (!dieuKien) return res.status(400).json({ message: 'Đồng ý có điều kiện cần ghi rõ điều kiện' });
  }
  if (ketQua === 'khong_dong_y') {
    const lyDo = (body.ly_do_tu_choi || '').trim();
    if (!lyDo) return res.status(400).json({ message: 'Không đồng ý cần ghi rõ lý do' });
  }
  const now = new Date().toISOString();
  const lanXet = (mission.buoc3_lan_xet_thu || 1);
  const dieuKien = (body.dieu_kien || '').trim() || null;
  const lyDoTuChoi = (body.ly_do_tu_choi || '').trim() || null;
  const nhanXetJson = JSON.stringify({ nhan_xet_khoa_hoc: nhanXetKhoaHoc, nhan_xet_kha_thi: nhanXetKhaThi, nhan_xet_dinh_huong: nhanXetDinhHuong, nhan_xet_nang_luc: nhanXetNangLuc });
  db.prepare(`UPDATE missions SET buoc3_trang_thai = ?, buoc3_ngay_phan_hoi = ?, buoc3_nguoi_xet_duyet_id = ?, buoc3_ket_qua = ?, buoc3_dieu_kien = ?, buoc3_ly_do_tu_choi = ?, buoc3_nhan_xet_khoa_hoc = ?, buoc3_nhan_xet_kha_thi = ?, buoc3_nhan_xet_dinh_huong = ?, buoc3_nhan_xet_nang_luc = ? WHERE id = ?`).run('da_xet_duyet', now, req.user.id, ketQua, dieuKien, lyDoTuChoi, nhanXetKhoaHoc, nhanXetKhaThi, nhanXetDinhHuong, nhanXetNangLuc, id);
  db.prepare('INSERT INTO lich_su_buoc3 (mission_id, lan_xet, nguoi_xet_id, ngay_xet, ket_qua, nhan_xet_json, dieu_kien, ly_do_tu_choi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, lanXet, req.user.id, now, ketQua, nhanXetJson, dieuKien, lyDoTuChoi);
  const actor = (req.user.fullname || req.user.email || 'CT HĐ').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const ketQuaLabels = { dong_y: 'Đồng ý', dong_y_co_dieu_kien: 'Đồng ý có điều kiện', khong_dong_y: 'Không đồng ý' };
    const subject = ketQua === 'khong_dong_y' ? '[Đề tài ngoài Viện] CT HĐ yêu cầu chỉnh sửa / từ chối: ' + (mission.title || '') : '[Đề tài ngoài Viện] CT HĐ đã đồng ý — chờ xác nhận chuyển bước 4: ' + (mission.title || '');
    const html = ketQua === 'khong_dong_y'
      ? '<p>CT HĐ KHCN (' + actor + ') đã ' + (ketQuaLabels[ketQua] || ketQua) + ' đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p><p>Vui lòng xử lý.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>'
      : '<p>CT HĐ KHCN (' + actor + ') đã ' + (ketQuaLabels[ketQua] || ketQua) + ' đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong>.</p><p>Vui lòng xác nhận chuyển bước 4.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã gửi phiếu nhận xét. Email đã gửi đến Phòng KHCN.', buoc3_ket_qua: ketQua });
});

// Bước 3 — Phòng KHCN: Xác nhận chuyển bước 4A (Nhánh A)
router.post('/missions/:id/step3-confirm-4a', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, buoc3_trang_thai, buoc3_ket_qua, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua === 'khong_dong_y') {
    return res.status(400).json({ message: 'CT HĐ không đồng ý — không thể chuyển bước 4' });
  }
  if ((mission.nhanh || '') !== 'A') {
    return res.status(400).json({ message: 'Đề tài thuộc Nhánh B — dùng nút chuyển bước 4B' });
  }
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('buoc4a', 'hoan_thanh', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài đã được duyệt nội bộ — chuyển Bước 4A: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được duyệt nội bộ, chuyển sang <strong>Bước 4A</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 4A. Email đã gửi đến Chủ nhiệm và Hội đồng.', status: 'buoc4a' });
});

// Bước 3 — Phòng KHCN: Xác nhận chuyển bước 4B (Nhánh B)
router.post('/missions/:id/step3-confirm-4b', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, buoc3_trang_thai, buoc3_ket_qua, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua === 'khong_dong_y') {
    return res.status(400).json({ message: 'CT HĐ không đồng ý — không thể chuyển bước 4' });
  }
  if ((mission.nhanh || '') !== 'B') {
    return res.status(400).json({ message: 'Đề tài thuộc Nhánh A — dùng nút chuyển bước 4A' });
  }
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('buoc4b', 'hoan_thanh', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài đã được duyệt nội bộ — chuyển Bước 4B: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được duyệt nội bộ, chuyển sang <strong>Bước 4B</strong>.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển sang Bước 4B. Email đã gửi đến Chủ nhiệm và Hội đồng.', status: 'buoc4b' });
});

// Bước 3 — Phòng KHCN: Yêu cầu CN chỉnh sửa và nộp lại (chỉ khi lần 1)
router.post('/missions/:id/step3-request-revision', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, buoc3_trang_thai, buoc3_ket_qua, buoc3_lan_xet_thu FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.buoc3_trang_thai || '') !== 'da_xet_duyet') {
    return res.status(400).json({ message: 'Đề tài chưa được CT HĐ xét duyệt' });
  }
  if (mission.buoc3_ket_qua !== 'khong_dong_y') {
    return res.status(400).json({ message: 'Chỉ áp dụng khi CT HĐ không đồng ý' });
  }
  const lanXet = mission.buoc3_lan_xet_thu || 1;
  if (lanXet >= 2) {
    return res.status(400).json({ message: 'Đã xét lần 2 — không thể yêu cầu chỉnh sửa thêm. Dùng "Dừng hồ sơ đợt này".' });
  }
  db.prepare('UPDATE missions SET buoc3_trang_thai = ?, buoc3_lan_xet_thu = ?, buoc3_nguoi_xet_duyet_id = NULL, buoc3_ngay_phan_hoi = NULL, buoc3_ket_qua = NULL, buoc3_dieu_kien = NULL, buoc3_ly_do_tu_choi = NULL, buoc3_nhan_xet_khoa_hoc = NULL, buoc3_nhan_xet_kha_thi = NULL, buoc3_nhan_xet_dinh_huong = NULL, buoc3_nhan_xet_nang_luc = NULL WHERE id = ?').run('cho_xet_duyet', 2, id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Yêu cầu chỉnh sửa thuyết minh: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') — CT HĐ yêu cầu chỉnh sửa. Vui lòng cập nhật thuyết minh và nộp lại.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã yêu cầu CN chỉnh sửa và nộp lại. Email đã gửi.', buoc3_trang_thai: 'cho_xet_duyet' });
});

// Bước 3 — Phòng KHCN: Dừng hồ sơ đợt này
router.post('/missions/:id/step3-stop', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  db.prepare('UPDATE missions SET status = ?, buoc3_trang_thai = ? WHERE id = ?').run('dung_khong_dat_dot', 'tu_choi', id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Đề tài dừng xét duyệt đợt này: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã dừng xét duyệt đợt này.</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã dừng hồ sơ đợt này.', status: 'dung_khong_dat_dot' });
});

// Reset về Bước 3 & đổi nhánh (chỉ admin, phong_khcn)
const BUOC4_STATUSES = ['buoc4a', 'buoc4b', 'cho_bo_tham_dinh', 'cho_ngoai_xet_chon', 'cho_phe_duyet_ngoai'];
router.post('/missions/:id/reset-ve-buoc3', authMiddleware, adminOrPhongKhcn, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, nhanh, level, lan_phan_nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const { ly_do, nhanh_moi, cap_moi } = req.body || {};
  const lyDoTrim = (ly_do || '').trim();
  if (lyDoTrim.length < 20) return res.status(400).json({ message: 'Lý do thay đổi phải có ít nhất 20 ký tự' });
  if (!nhanh_moi || !['A', 'B'].includes(nhanh_moi)) return res.status(400).json({ message: 'Nhánh mới không hợp lệ' });
  if (!cap_moi || typeof cap_moi !== 'string') return res.status(400).json({ message: 'Cấp đề tài mới không hợp lệ' });
  if (BUOC4_STATUSES.indexOf(mission.status || '') < 0) {
    return res.status(403).json({ message: 'Chỉ được reset khi đề tài đang ở Bước 4. Đã có QĐ phê duyệt thì không cho reset.' });
  }
  const b5 = db.prepare('SELECT id, trang_thai FROM buoc5 WHERE mission_id = ?').get(id);
  if (b5 && (b5.trang_thai || '') === 'hoan_thanh') {
    return res.status(403).json({ message: 'Đề tài đã có QĐ phê duyệt — không cho reset.' });
  }
  const nhanhCu = mission.nhanh || 'A';
  const capCu = mission.level || '';
  const now = new Date().toISOString();
  const lanPhanNhanh = (mission.lan_phan_nhanh || 1) + 1;
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
  const buoc4Snapshot = JSON.stringify({ buoc4a: b4a || null, buoc4b: b4b || null });
  db.prepare('INSERT INTO lich_su_doi_nhanh (mission_id, nhanh_cu, nhanh_moi, cap_cu, cap_moi, ly_do, reset_boi, reset_luc, buoc4_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, nhanhCu, nhanh_moi, capCu, cap_moi, lyDoTrim, req.user.id, now, buoc4Snapshot);
  db.prepare('UPDATE missions SET nhanh = ?, level = ?, status = ?, buoc3_trang_thai = ?, buoc3_nguoi_xet_duyet_id = NULL, buoc3_ngay_phan_hoi = NULL, buoc3_ket_qua = NULL, buoc3_dieu_kien = NULL, buoc3_ly_do_tu_choi = NULL, buoc3_nhan_xet_khoa_hoc = NULL, buoc3_nhan_xet_kha_thi = NULL, buoc3_nhan_xet_dinh_huong = NULL, buoc3_nhan_xet_nang_luc = NULL, lan_phan_nhanh = ? WHERE id = ?').run(nhanh_moi, cap_moi, 'cho_ct_hd_xet_duyet', 'cho_xet_duyet', lanPhanNhanh, id);
  if (b4a) db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('da_reset', id);
  if (b4b) db.prepare('UPDATE buoc4b SET trang_thai = ? WHERE mission_id = ?').run('da_reset', id);
  db.prepare('INSERT INTO lich_su_buoc (mission_id, action, user_id, timestamp, note) VALUES (?, ?, ?, ?, ?)').run(id, 'reset_ve_buoc3', req.user.id, now, lyDoTrim);
  const nhanhLabel = nhanh_moi === 'A' ? 'Nhánh A — Bộ GD/ĐHQG/Trường' : 'Nhánh B — Nhà nước/NAFOSTED';
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const resetByName = (req.user.fullname || req.user.email || 'Admin').toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const subject = '[Đề tài ngoài Viện] Đề tài được chuyển lại Bước 3 để phân nhánh lại: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</strong> được chuyển lại Bước 3 để phân nhánh lại.</p><p><strong>Lý do:</strong> ' + lyDoTrim.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p><p><strong>Nhánh mới:</strong> ' + nhanhLabel + '</p><p>Reset bởi: ' + resetByName + '</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ message: 'Đã chuyển lại Bước 3 và đổi nhánh.', status: 'cho_ct_hd_xet_duyet', nhanh: nhanh_moi, level: cap_moi, lan_phan_nhanh: lanPhanNhanh });
});

return router;
};
