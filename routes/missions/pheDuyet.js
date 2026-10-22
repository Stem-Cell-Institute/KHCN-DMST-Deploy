'use strict';

/**
 * Nhiệm vụ KHCN — duyệt Bước 4a, 4b, 5 và 6 (xét chọn tại Viện, gửi Bộ, phê duyệt
 * chính thức, ký hợp đồng). 13 endpoint.
 *
 * Tách khỏi server.js (Đợt 1.3 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Không sửa một dòng logic nào — chỉ đổi `app.` thành `router.` ở 13 dòng khai báo.
 *
 * `chuTichOrThuyKyOrAdmin` được định nghĩa NGAY TRONG file này (nó vốn nằm giữa khối
 * code cũ, chỉ dùng cho đúng một endpoint ket-qua-hop), nên nó nhận `roleIsAny` từ
 * tham số factory thay vì từ phạm vi module của server.js.
 *
 * ⚠️ NỢ KỸ THUẬT #9 — hai endpoint dưới đây chỉ có `authMiddleware`, KHÔNG kiểm vai
 * trò và KHÔNG kiểm chủ nhiệm đề tài:
 *     POST /api/missions/:id/buoc4a/cn-upload-thuyet-minh-chinh-sua
 *     POST /api/missions/:id/buoc5/upload-thuyet-minh
 * Bất kỳ tài khoản đã đăng nhập nào — kể cả `crd_user` (tài khoản ngoài chỉ để đặt
 * lịch phòng thí nghiệm) — đều gọi được cho mission id bất kỳ. Chúng được di chuyển
 * NGUYÊN TRẠNG ở đợt này vì refactor không được đổi hành vi; bản vá cần một quyết định
 * nghiệp vụ (ai được upload?) và `missions.principal` là tên dạng chuỗi chứ không phải
 * khóa ngoại tới `users`, nên không vá được bằng một middleware. Xem readme/
 * REFACTOR-PROGRESS.md mục #9.
 */

const express = require('express');

module.exports = function createMissionsPheDuyetRouter({
  db,
  authMiddleware,
  thuyKyOrAdmin,
  transporter,
  upload,
  PORT,
  roleIsAny,
  getNotificationEmails,
  getSmtpFrom,
}) {
const router = express.Router();

// ========== BƯỚC 4 NHÁNH A — Xét chọn tại Viện & gửi Bộ ==========

// Sub-bước ① — Lên lịch họp HĐ
router.post('/missions/:id/buoc4a/len-lich', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const { hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu } = req.body || {};
  if (!hop_ngay || !hop_hinh_thuc) return res.status(400).json({ message: 'Thiếu ngày giờ họp hoặc hình thức họp' });
  const ids = Array.isArray(thanh_phan_ids) ? thanh_phan_ids : (typeof thanh_phan_ids === 'string' ? JSON.parse(thanh_phan_ids || '[]') : []);
  if (ids.length < 2) return res.status(400).json({ message: 'Cần ít nhất 2 thành viên Hội đồng' });
  const hopDate = new Date(hop_ngay);
  const now = new Date();
  if (hopDate.getTime() - now.getTime() < 2 * 60 * 60 * 1000) return res.status(400).json({ message: 'Ngày giờ họp phải sau ít nhất 2 giờ' });
  const thanhPhanJson = JSON.stringify(ids);
  let row;
  try {
    row = db.prepare('SELECT id FROM buoc4a WHERE mission_id = ?').get(id);
  } catch (e) {
    row = null;
  }
  const nowStr = new Date().toISOString();
  if (row) {
    db.prepare('UPDATE buoc4a SET hop_trang_thai = ?, hop_ngay = ?, hop_hinh_thuc = ?, hop_dia_diem = ?, hop_link = ?, thanh_phan_ids = ?, ghi_chu = ?, updated_at = ? WHERE mission_id = ?')
      .run('da_len_lich', hop_ngay, hop_hinh_thuc || null, hop_dia_diem || null, hop_link || null, thanhPhanJson, ghi_chu || null, nowStr, id);
  } else {
    db.prepare('INSERT INTO buoc4a (mission_id, hop_trang_thai, hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'da_len_lich', hop_ngay, hop_hinh_thuc, hop_dia_diem || null, hop_link || null, thanhPhanJson, ghi_chu || null);
  }
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)')
    .run(id, '1', 'len_lich', userId, JSON.stringify({ hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const timelineUrl = baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id;
    const subject = '[Đề tài ngoài Viện] Lịch họp HĐ chuyên ngành: ' + (mission.title || '');
    const hinhThuc = hop_hinh_thuc === 'offline' ? 'Offline' : hop_hinh_thuc === 'online' ? 'Online' : 'Hybrid';
    const diaDiem = hop_hinh_thuc === 'offline' ? (hop_dia_diem || '—') : (hop_link || '—');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Lịch họp HĐ chuyên ngành đã được lên.</p><p><strong>Ngày giờ:</strong> ' + hop_ngay + '</p><p><strong>Hình thức:</strong> ' + hinhThuc + '</p><p><strong>Địa điểm/Link:</strong> ' + (diaDiem || '').replace(/</g, '&lt;') + '</p><p><a href="' + timelineUrl + '" style="color:#1565c0">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lên lịch họp và gửi thông báo.', hop_trang_thai: 'da_len_lich' });
});

// Sub-bước ① — Chỉnh lịch (chỉ khi hop_ngay > now + 1 giờ)
router.patch('/missions/:id/buoc4a/chinh-lich', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT hop_ngay, hop_trang_thai FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hop_trang_thai || '') !== 'da_len_lich') return res.status(400).json({ message: 'Chưa lên lịch hoặc không thể chỉnh' });
  const hopDate = new Date(b4a.hop_ngay);
  if (hopDate.getTime() - Date.now() < 60 * 60 * 1000) return res.status(400).json({ message: 'Không thể chỉnh lịch khi còn dưới 1 giờ' });
  const { hop_ngay, hop_hinh_thuc, hop_dia_diem, hop_link, thanh_phan_ids, ghi_chu } = req.body || {};
  const updates = []; const params = [];
  if (hop_ngay) { updates.push('hop_ngay = ?'); params.push(hop_ngay); }
  if (hop_hinh_thuc) { updates.push('hop_hinh_thuc = ?'); params.push(hop_hinh_thuc); }
  if (hop_dia_diem !== undefined) { updates.push('hop_dia_diem = ?'); params.push(hop_dia_diem || null); }
  if (hop_link !== undefined) { updates.push('hop_link = ?'); params.push(hop_link || null); }
  if (thanh_phan_ids) { const ids = Array.isArray(thanh_phan_ids) ? thanh_phan_ids : JSON.parse(thanh_phan_ids || '[]'); if (ids.length >= 2) { updates.push('thanh_phan_ids = ?'); params.push(JSON.stringify(ids)); } }
  if (ghi_chu !== undefined) { updates.push('ghi_chu = ?'); params.push(ghi_chu || null); }
  if (updates.length === 0) return res.status(400).json({ message: 'Không có thay đổi' });
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE buoc4a SET ' + updates.join(', ') + ', updated_at = ? WHERE mission_id = ?').run(...params);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '1', 'chinh_lich', userId, JSON.stringify(req.body));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Lịch họp đã thay đổi: ' + (mission.title || '');
    const html = '<p>Lịch họp HĐ chuyên ngành cho đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã được cập nhật.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã cập nhật lịch họp.' });
});

// Sub-bước ② — Kết quả họp HĐ (CT HĐ hoặc Phòng KHCN)
function chuTichOrThuyKyOrAdmin(req, res, next) {
  if (!roleIsAny(req, ['admin', 'chu_tich', 'thu_ky'])) return res.status(403).json({ message: 'Chỉ CT HĐ KHCN hoặc Phòng KHCN mới có quyền này' });
  next();
}
router.post('/missions/:id/buoc4a/ket-qua-hop', authMiddleware, chuTichOrThuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hop_trang_thai || '') !== 'da_len_lich') return res.status(400).json({ message: 'Chưa lên lịch họp' });
  if (b4a.hd_ket_luan) return res.status(400).json({ message: 'Đã lưu kết quả họp, không thể sửa' });
  const { ngay_hop_thuc_te, ket_luan, noi_dung_chinh_sua, han_chinh_sua, ly_do, nhan_xet, bien_ban_file_id } = req.body || {};
  if (!ket_luan || !bien_ban_file_id) return res.status(400).json({ message: 'Thiếu kết luận hoặc biên bản họp' });
  const validKetLuan = ['thong_qua', 'thong_qua_co_chinh_sua', 'khong_thong_qua'];
  if (!validKetLuan.includes(ket_luan)) return res.status(400).json({ message: 'Kết luận không hợp lệ' });
  if (ket_luan === 'thong_qua_co_chinh_sua' && (!noi_dung_chinh_sua || !han_chinh_sua)) return res.status(400).json({ message: 'Thông qua có chỉnh sửa cần nội dung và hạn' });
  if (ket_luan === 'khong_thong_qua' && !ly_do) return res.status(400).json({ message: 'Không thông qua cần lý do' });
  const ngayHop = ngay_hop_thuc_te || b4a.hop_ngay;
  db.prepare('UPDATE buoc4a SET ngay_hop_thuc_te = ?, hd_ket_luan = ?, noi_dung_chinh_sua = ?, han_chinh_sua = ?, ly_do = ?, nhan_xet = ?, bien_ban_file_id = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
    .run(ngayHop, ket_luan, noi_dung_chinh_sua || null, han_chinh_sua || null, ly_do || null, nhan_xet || null, bien_ban_file_id, 'da_hop', new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '2', 'ket_qua_hop', userId, JSON.stringify({ ket_luan }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Kết quả họp HĐ: ' + (mission.title || '');
    const kqLabel = ket_luan === 'thong_qua' ? 'Thông qua' : ket_luan === 'thong_qua_co_chinh_sua' ? 'Thông qua — yêu cầu chỉnh sửa' : 'Không thông qua';
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Kết quả họp HĐ: <strong>' + kqLabel + '</strong></p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lưu kết quả họp.', hd_ket_luan: ket_luan });
});

// Sub-bước ③ — Gửi Bộ
router.post('/missions/:id/buoc4a/gui-bo', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh, level FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a) return res.status(400).json({ message: 'Chưa có dữ liệu bước 4A' });
  const kl = b4a.hd_ket_luan || '';
  if (kl === 'khong_thong_qua') return res.status(400).json({ message: 'HĐ không thông qua — không thể gửi Bộ' });
  if (kl === 'thong_qua_co_chinh_sua' && !b4a.thuyet_minh_chinh_sua_ok) return res.status(400).json({ message: 'Chờ CN upload thuyết minh chỉnh sửa và Phòng KHCN xác nhận' });
  const { co_quan_nhan, danh_muc_file_id, ngay_gui, hinh_thuc_gui, nguoi_nhan, ghi_chu } = req.body || {};
  if (!co_quan_nhan || !danh_muc_file_id || !ngay_gui) return res.status(400).json({ message: 'Thiếu cơ quan nhận, file danh mục hoặc ngày gửi' });
  db.prepare('UPDATE buoc4a SET co_quan_nhan = ?, danh_muc_file_id = ?, ngay_gui = ?, hinh_thuc_gui = ?, nguoi_nhan = ?, gui_ghi_chu = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
    .run(co_quan_nhan, danh_muc_file_id, ngay_gui, hinh_thuc_gui || null, nguoi_nhan || null, ghi_chu || null, 'da_gui_bo', new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '3', 'gui_bo', userId, JSON.stringify({ co_quan_nhan, ngay_gui }));
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã gửi danh mục lên Bộ: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> — Danh mục đã gửi ' + (co_quan_nhan || '').replace(/</g, '&lt;') + ' ngày ' + ngay_gui + '.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận gửi lên Bộ.', trang_thai: 'da_gui_bo' });
});

// Sub-bước ④ — Kết quả thẩm định từ Bộ
router.post('/missions/:id/buoc4a/ket-qua-bo', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  if ((mission.nhanh || '') !== 'A') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh A' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.trang_thai || '') !== 'da_gui_bo') return res.status(400).json({ message: 'Chưa gửi Bộ' });
  const { ngay_nhan, ket_qua, noi_dung_yc, han_yc, ly_do, van_ban_file_id, ghi_chu } = req.body || {};
  if (!ngay_nhan || !ket_qua) return res.status(400).json({ message: 'Thiếu ngày nhận hoặc kết quả' });
  const validKq = ['lot', 'yeu_cau_chinh_sua', 'khong_lot'];
  if (!validKq.includes(ket_qua)) return res.status(400).json({ message: 'Kết quả không hợp lệ' });
  if (ket_qua === 'yeu_cau_chinh_sua' && (!noi_dung_yc || !han_yc)) return res.status(400).json({ message: 'Yêu cầu chỉnh sửa cần nội dung và hạn' });
  db.prepare('UPDATE buoc4a SET ngay_nhan_ket_qua = ?, ket_qua_bo = ?, bo_noi_dung_yc = ?, bo_han_yc = ?, bo_ly_do = ?, van_ban_bo_file_id = ?, ket_qua_ghi_chu = ?, updated_at = ? WHERE mission_id = ?')
    .run(ngay_nhan, ket_qua, noi_dung_yc || null, han_yc || null, ly_do || null, van_ban_file_id || null, ghi_chu || null, new Date().toISOString(), id);
  const userId = req.user && req.user.id;
  db.prepare('INSERT INTO lich_su_buoc4a (mission_id, sub_buoc, action, user_id, data_snapshot) VALUES (?, ?, ?, ?, ?)').run(id, '4', 'ket_qua_bo', userId, JSON.stringify({ ket_qua }));
  if (ket_qua === 'lot') {
    db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('lot_danh_muc', id);
  } else if (ket_qua === 'khong_lot') {
    db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('khong_lot', id);
  }
  return res.json({ success: true, message: 'Đã lưu kết quả thẩm định.', ket_qua_bo: ket_qua });
});

// Chuyển sang Bước 5 (khi lọt danh mục)
router.post('/missions/:id/buoc4a/chuyen-buoc5', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.ket_qua_bo || '') !== 'lot') return res.status(400).json({ message: 'Chưa lọt danh mục' });
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_phe_duyet_chinh_thuc', id);
  db.prepare('UPDATE buoc4a SET trang_thai = ? WHERE mission_id = ?').run('hoan_thanh', id);
  try { db.prepare('INSERT INTO buoc5 (mission_id) VALUES (?)').run(id); } catch (e) {}
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Chuyển Bước 5: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã lọt danh mục — chuyển sang Bước 5 (Chờ phê duyệt chính thức).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã chuyển sang Bước 5.', status: 'cho_phe_duyet_chinh_thuc' });
});

// CN upload thuyết minh chỉnh sửa (khi HĐ yêu cầu)
router.post('/missions/:id/buoc4a/cn-upload-thuyet-minh-chinh-sua', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hd_ket_luan || '') !== 'thong_qua_co_chinh_sua') return res.status(400).json({ message: 'Không trong trạng thái yêu cầu chỉnh sửa' });
  const han = b4a.han_chinh_sua ? new Date(b4a.han_chinh_sua) : null;
  if (han && Date.now() > han.getTime()) return res.status(400).json({ message: 'Đã quá hạn nộp' });
  const { file_id } = req.body || {};
  if (!file_id) return res.status(400).json({ message: 'Thiếu file_id' });
  db.prepare('UPDATE buoc4a SET thuyet_minh_chinh_sua_ok = 1, updated_at = ? WHERE mission_id = ?').run(new Date().toISOString(), id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const mission = db.prepare('SELECT title FROM missions WHERE id = ?').get(id);
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] CN đã nộp thuyết minh chỉnh sửa: ' + (mission ? mission.title : '');
    const html = '<p>Chủ nhiệm đã upload thuyết minh chỉnh sửa. Vui lòng xác nhận để mở khóa gửi Bộ.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã lưu thuyết minh chỉnh sửa.' });
});

// Phòng KHCN xác nhận thuyết minh chỉnh sửa
router.post('/missions/:id/buoc4a/xac-nhan-thuyet-minh-chinh-sua', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const b4a = db.prepare('SELECT * FROM buoc4a WHERE mission_id = ?').get(id);
  if (!b4a || (b4a.hd_ket_luan || '') !== 'thong_qua_co_chinh_sua') return res.status(400).json({ message: 'Không trong trạng thái yêu cầu chỉnh sửa' });
  db.prepare('UPDATE buoc4a SET thuyet_minh_chinh_sua_ok = 1, updated_at = ? WHERE mission_id = ?').run(new Date().toISOString(), id);
  return res.json({ success: true, message: 'Đã xác nhận. Sub-bước 3 mở khóa.' });
});

// ========== BƯỚC 4 NHÁNH B ==========
router.post('/missions/:id/buoc4b/nop-ho-so', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.nhanh || '') !== 'B') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh B' });
  const { co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop, ma_ho_so, ghi_chu } = req.body || {};
  if (!co_quan_nhan || !han_nop || !ngay_nop_thuc_te) return res.status(400).json({ message: 'Thiếu cơ quan nhận, hạn nộp hoặc ngày nộp thực tế' });
  let row = db.prepare('SELECT id FROM buoc4b WHERE mission_id = ?').get(id);
  const nowStr = new Date().toISOString();
  if (row) {
    db.prepare('UPDATE buoc4b SET co_quan_nhan = ?, han_nop = ?, ngay_nop_thuc_te = ?, hinh_thuc_nop = ?, ma_ho_so = ?, ghi_chu = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
      .run(co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop || null, ma_ho_so || null, ghi_chu || null, 'da_nop', nowStr, id);
  } else {
    db.prepare('INSERT INTO buoc4b (mission_id, co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop, ma_ho_so, ghi_chu, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, co_quan_nhan, han_nop, ngay_nop_thuc_te, hinh_thuc_nop || null, ma_ho_so || null, ghi_chu || null, 'da_nop');
  }
  db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_ngoai_xet_chon', id);
  return res.json({ success: true, message: 'Đã xác nhận nộp hồ sơ.', trang_thai: 'da_nop' });
});

router.post('/missions/:id/buoc4b/ket-qua', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, nhanh FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.nhanh || '') !== 'B') return res.status(400).json({ message: 'Đề tài không thuộc Nhánh B' });
  const b4b = db.prepare('SELECT * FROM buoc4b WHERE mission_id = ?').get(id);
  if (!b4b || (b4b.trang_thai || '') !== 'da_nop') return res.status(400).json({ message: 'Chưa nộp hồ sơ' });
  const { ket_qua, noi_dung_yc, han_yc, ly_do, van_ban_file_id } = req.body || {};
  if (!ket_qua) return res.status(400).json({ message: 'Thiếu kết quả' });
  const validKq = ['duoc_tuyen_chon', 'yeu_cau_chinh_sua', 'khong_duoc'];
  if (!validKq.includes(ket_qua)) return res.status(400).json({ message: 'Kết quả không hợp lệ' });
  if (ket_qua === 'yeu_cau_chinh_sua' && (!noi_dung_yc || !han_yc)) return res.status(400).json({ message: 'Yêu cầu chỉnh sửa cần nội dung và hạn' });
  db.prepare('UPDATE buoc4b SET ket_qua = ?, noi_dung_yc = ?, han_yc = ?, ly_do = ?, van_ban_file_id = ?, updated_at = ? WHERE mission_id = ?')
    .run(ket_qua, noi_dung_yc || null, han_yc || null, ly_do || null, van_ban_file_id || null, new Date().toISOString(), id);
  if (ket_qua === 'duoc_tuyen_chon') {
    db.prepare('UPDATE missions SET status = ? WHERE id = ?').run('cho_phe_duyet_chinh_thuc', id);
    const existing = db.prepare('SELECT id FROM buoc5 WHERE mission_id = ?').get(id);
    if (!existing) db.prepare('INSERT INTO buoc5 (mission_id) VALUES (?)').run(id);
    const toList = getNotificationEmails();
    let principalEmail = null;
    const m = db.prepare('SELECT source_type, source_id FROM missions WHERE id = ?').get(id);
    if (m && m.source_type === 'cap_vien' && m.source_id) {
      const sub = db.prepare('SELECT submittedById FROM cap_vien_submissions WHERE id = ?').get(m.source_id);
      if (sub && sub.submittedById) {
        const u = db.prepare('SELECT email FROM users WHERE id = ?').get(sub.submittedById);
        if (u && u.email) principalEmail = u.email.trim().toLowerCase();
      }
    }
    const recipients = new Set(toList.map(e => e.trim().toLowerCase()));
    if (principalEmail) recipients.add(principalEmail);
    if (transporter && recipients.size > 0) {
      const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
      const subject = '[Đề tài ngoài Viện] Đề tài được tuyển chọn — chuyển Bước 5: ' + (mission.title || '');
      const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> (Chủ nhiệm: ' + (mission.principal || '').replace(/</g, '&lt;') + ') đã được cơ quan ngoài tuyển chọn — chuyển sang Bước 5 (Chờ phê duyệt chính thức & hoàn chỉnh thuyết minh).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
      transporter.sendMail({ from: getSmtpFrom(), to: Array.from(recipients).join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
    }
  }
  return res.json({ success: true, message: 'Đã lưu kết quả.', ket_qua });
});

// ========== BƯỚC 5 ==========
router.post('/missions/:id/buoc5/upload-thuyet-minh', authMiddleware, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, status FROM missions WHERE id = ?').get(id);
  if (!mission || !['cho_phe_duyet_chinh_thuc', 'da_phe_duyet'].includes(mission.status)) return res.status(400).json({ message: 'Đề tài không ở Bước 5' });
  const { file_id, phien_ban, ghi_chu_thay_doi } = req.body || {};
  if (!file_id) return res.status(400).json({ message: 'Thiếu file_id' });
  db.prepare('INSERT INTO buoc5_thuyet_minh_ls (mission_id, file_id, phien_ban, ghi_chu, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, file_id, phien_ban || null, ghi_chu_thay_doi || null, req.user && req.user.id);
  return res.json({ success: true, message: 'Đã lưu thuyết minh hoàn chỉnh.' });
});

router.post('/missions/:id/buoc5/nhan-quyet-dinh', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal FROM missions WHERE id = ?').get(id);
  if (!mission) return res.status(404).json({ message: 'Không tìm thấy đề tài' });
  const { so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc, kinh_phi, thoi_gian_bd, thoi_gian_kt } = req.body || {};
  if (!so_qd || !ngay_ky || !co_quan_ky || !file_id || kinh_phi == null || !thoi_gian_bd || !thoi_gian_kt) return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
  const existing = db.prepare('SELECT id FROM buoc5 WHERE mission_id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE buoc5 SET so_qd = ?, ngay_ky_qd = ?, co_quan_ky = ?, qd_file_id = ?, ma_de_tai_chinh_thuc = ?, kinh_phi = ?, thoi_gian_bd = ?, thoi_gian_kt = ?, trang_thai = ?, updated_at = ? WHERE mission_id = ?')
      .run(so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc || null, parseFloat(kinh_phi), thoi_gian_bd, thoi_gian_kt, 'hoan_thanh', new Date().toISOString(), id);
  } else {
    db.prepare('INSERT INTO buoc5 (mission_id, so_qd, ngay_ky_qd, co_quan_ky, qd_file_id, ma_de_tai_chinh_thuc, kinh_phi, thoi_gian_bd, thoi_gian_kt, trang_thai) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, so_qd, ngay_ky, co_quan_ky, file_id, ma_de_tai_chinh_thuc || null, parseFloat(kinh_phi), thoi_gian_bd, thoi_gian_kt, 'hoan_thanh');
  }
  db.prepare('UPDATE missions SET status = ?, approved_budget = ? WHERE id = ?').run('cho_ky_hop_dong', parseFloat(kinh_phi), id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã có QĐ phê duyệt: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã được phê duyệt chính thức. Chuyển sang Bước 6 (Ký hợp đồng).</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận QĐ phê duyệt. Chuyển Bước 6.', status: 'cho_ky_hop_dong' });
});

// ========== BƯỚC 6 ==========
router.post('/missions/:id/buoc6/ky-hop-dong', authMiddleware, thuyKyOrAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || isNaN(id)) return res.status(400).json({ message: 'ID không hợp lệ' });
  const mission = db.prepare('SELECT id, title, principal, status FROM missions WHERE id = ?').get(id);
  if (!mission || (mission.status || '') !== 'cho_ky_hop_dong') return res.status(400).json({ message: 'Đề tài chưa ở Bước 6' });
  const { so_hd_ngoai, ngay_ky_ngoai, gia_tri_hd, file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi_quan_ly } = req.body || {};
  if (!so_hd_ngoai || !ngay_ky_ngoai || gia_tri_hd == null || !file_hd_ngoai_id || !so_hd_noi_bo || !ngay_ky_noi_bo || !file_hd_noi_bo_id) return res.status(400).json({ message: 'Thiếu thông tin hợp đồng' });
  const phi = phi_quan_ly != null ? parseFloat(phi_quan_ly) : (parseFloat(gia_tri_hd) || 0) * 0.03;
  try {
    db.prepare('INSERT INTO buoc6 (mission_id, so_hd_ngoai, ngay_ky_ngoai, gia_tri_hd, file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi_quan_ly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, so_hd_ngoai, ngay_ky_ngoai, parseFloat(gia_tri_hd), file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi);
  } catch (e) {
    db.prepare('UPDATE buoc6 SET so_hd_ngoai = ?, ngay_ky_ngoai = ?, gia_tri_hd = ?, file_hd_ngoai_id = ?, so_hd_noi_bo = ?, ngay_ky_noi_bo = ?, file_hd_noi_bo_id = ?, phi_quan_ly = ?, updated_at = ? WHERE mission_id = ?')
      .run(so_hd_ngoai, ngay_ky_ngoai, parseFloat(gia_tri_hd), file_hd_ngoai_id, so_hd_noi_bo, ngay_ky_noi_bo, file_hd_noi_bo_id, phi, new Date().toISOString(), id);
  }
  db.prepare('UPDATE missions SET status = ?, start_date = ? WHERE id = ?').run('dang_thuc_hien', ngay_ky_ngoai, id);
  const toList = getNotificationEmails();
  if (transporter && toList.length > 0) {
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const subject = '[Đề tài ngoài Viện] Đã ký hợp đồng — bắt đầu thực hiện: ' + (mission.title || '');
    const html = '<p>Đề tài <strong>' + (mission.title || '').replace(/</g, '&lt;') + '</strong> đã ký hợp đồng — bắt đầu thực hiện.</p><p><a href="' + baseUrl + '/theo-doi-de-tai-ngoai-vien-chi-tiet.html?id=' + id + '">Xem tiến trình</a></p>';
    transporter.sendMail({ from: getSmtpFrom(), to: toList.join(', '), subject, text: html.replace(/<[^>]+>/g, ''), html }).catch(err => console.error('[Email]', err.message));
  }
  return res.json({ success: true, message: 'Đã xác nhận ký hợp đồng. Đề tài bắt đầu thực hiện.', status: 'dang_thuc_hien' });
});

return router;
};
