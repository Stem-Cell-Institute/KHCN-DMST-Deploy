'use strict';

/**
 * HTQT Đề xuất YTNN (Chương VII Quy chế KHCN-ĐMST SCI 2026) — 6 endpoint /api/htqt/de-xuat/*.
 *
 * Tách khỏi server.js (Đợt 5.2 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');

function phiQuanLyTheoLoaiHinh(loaiHinh, kinhPhiVnd) {
  const k = (kinhPhiVnd || 0);
  if ((loaiHinh || '').toLowerCase() === 'hoat_dong_khcn') return { pct: 8, vnd: k * 0.08 };
  if ((loaiHinh || '').toLowerCase() === 'dich_vu_khcn') return { pct: 13, vnd: k * 0.13 };
  if ((loaiHinh || '').toLowerCase() === 'tai_tro_vien_tro') return { pct: 3, vnd: k * 0.03 };
  return { pct: 0, vnd: 0 };
}

function deNghiVtTheoLoaiHinh(loaiHinh) {
  const l = (loaiHinh || '').toLowerCase();
  if (l === 'hoat_dong_khcn') return 'Phê duyệt tiếp nhận và giao Phòng KHCN cấp mã dự án (Điều 62, 64)';
  if (l === 'tai_tro_vien_tro') return 'Xác nhận để trình Trường ĐHKHTN phê duyệt (Điều 64)';
  if (l === 'dich_vu_khcn') return 'Phê duyệt triển khai theo quy trình dịch vụ (Điều 64)';
  return 'Phê duyệt theo quy định';
}

module.exports = function createHtqtRouter({
  db,
  authMiddleware,
  adminOnly,
  roleIsAny,
  vienTruongOrAdmin,
  coopTryAutoGenerateYtnnVanBan,
}) {
  const router = express.Router();

  function canAccessHtqtDeXuat(req, row) {
    const role = (req.user.role || '').toLowerCase();
    const email = (req.user.email || '').trim().toLowerCase();
    if (role === 'admin') return true;
    if (roleIsAny(req, ['phong_khcn'])) return true;
    try {
      const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
      if (vt) return true;
    } catch (e) {}
    if (row && row.submitted_by_email && (row.submitted_by_email || '').trim().toLowerCase() === email) return true;
    if (row && row.submitted_by_id === req.user.id) return true;
    return false;
  }

  // GET Đề xuất YTNN chi tiết — vien_truong, admin, phong_khcn, chu_nhiem
  router.get('/htqt/de-xuat/:id', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
    try {
      const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      if (!canAccessHtqtDeXuat(req, row)) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
      const files = db.prepare('SELECT id, loai_file, ten_file, duong_dan, uploaded_by_id, uploaded_at FROM htqt_de_xuat_files WHERE de_xuat_id = ? ORDER BY id').all(id);
      const history = db.prepare('SELECT id, action, performed_by_name, performed_at, note FROM htqt_de_xuat_history WHERE de_xuat_id = ? ORDER BY performed_at DESC').all(id);
      const phi = phiQuanLyTheoLoaiHinh(row.loai_hinh, row.kinh_phi_vnd);
      const coNgưỡngKinhPhi = (row.kinh_phi_vnd || 0) > 500000000;
      const coNgưỡngThoiGian = (row.thoi_gian_thang || 0) > 60;
      const filesBatBuoc = ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'];
      const filesCo = (files || []).map(f => (f.loai_file || '').toLowerCase());
      const thieuFile = filesBatBuoc.filter(loai => !filesCo.includes(loai));
      const coThieuHoSo = thieuFile.length > 0;
      const chuaPhanLoai = !row.loai_hinh || !row.loai_hinh.trim();
      const co = { NGƯỠNG_KINH_PHI: coNgưỡngKinhPhi, NGƯỠNG_THOI_GIAN: coNgưỡngThoiGian, CHUA_PHAN_LOAI: chuaPhanLoai, THIEU_HO_SO: coThieuHoSo };
      const canPheDuyet = (row.status === 'cho_vt_phe_duyet' || row.status === 'cho_vt_duyet') && !chuaPhanLoai && !coThieuHoSo;
      const deNghiVt = row.de_nghi_vt || deNghiVtTheoLoaiHinh(row.loai_hinh);
      return res.json({
        ...row,
        files: files || [],
        history: history || [],
        phi_quan_ly: phi,
        co_canh_bao: co,
        can_phe_duyet: canPheDuyet,
        de_nghi_vt: deNghiVt,
        thieu_file: thieuFile
      });
    } catch (e) {
      console.error('[API] htqt/de-xuat error:', e.message);
      return res.status(500).json({ message: 'Lỗi hệ thống' });
    }
  });

  // POST Phê duyệt — vien_truong hoặc admin
  router.post('/htqt/de-xuat/:id/phe-duyet', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { y_kien, ngay_ky, so_van_ban } = req.body || {};
    const userEmail = (req.user.email || '').trim().toLowerCase();
    const isAdmin = (req.user.role || '').toLowerCase() === 'admin';
    if (!isAdmin) {
      try {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được phê duyệt' });
      } catch (e) {
        return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được phê duyệt' });
      }
    }
    try {
      const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      const stl = (row.status || '').toLowerCase();
      if (stl !== 'cho_vt_phe_duyet' && stl !== 'cho_vt_duyet') return res.status(400).json({ message: 'Trạng thái không cho phép phê duyệt' });
      if (!row.loai_hinh) return res.status(400).json({ message: 'Chưa phân loại loại hình' });
      const ngayKy = (ngay_ky || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
      db.prepare('UPDATE htqt_de_xuat SET status = \'da_duyet\', vt_y_kien = ?, vt_ngay_ky = ?, vt_so_van_ban = ?, vt_nguoi_ky_id = ?, vt_xu_ly_id = ?, vt_xu_ly_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
        .run(y_kien || null, ngayKy, so_van_ban || null, req.user.id, req.user.id, id);
      db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'phe_duyet', req.user.id, req.user.fullname || req.user.email, y_kien || '');
      try {
        const gen = coopTryAutoGenerateYtnnVanBan(id);
        if (!gen.ok && gen.skipped === 'no_template') {
          console.warn('[htqt legacy] Đã phê duyệt YTNN nhưng chưa có mẫu Word — Admin cần tải mẫu Tờ trình (.docx).');
        }
      } catch (e) {}
      return res.json({ message: 'Đã phê duyệt đề xuất.', status: 'da_duyet' });
    } catch (e) {
      console.error('[API] phe-duyet error:', e.message);
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });

  // POST Yêu cầu bổ sung — vien_truong, admin
  router.post('/htqt/de-xuat/:id/yeu-cau-bo-sung', authMiddleware, vienTruongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { noi_dung, han_bo_sung, gui_den } = req.body || {};
    if (!noi_dung || (noi_dung || '').trim().length < 20) return res.status(400).json({ message: 'Nội dung yêu cầu tối thiểu 20 ký tự' });
    if (!han_bo_sung) return res.status(400).json({ message: 'Hạn bổ sung bắt buộc' });
    try {
      const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      db.prepare('UPDATE htqt_de_xuat SET status = \'yeu_cau_bo_sung\', updated_at = datetime(\'now\') WHERE id = ?').run(id);
      db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note, metadata) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, 'yeu_cau_bo_sung', req.user.id, req.user.fullname || req.user.email, noi_dung.trim(), JSON.stringify({ han_bo_sung, gui_den: gui_den || [] }));
      return res.json({ message: 'Đã gửi yêu cầu bổ sung.', status: 'yeu_cau_bo_sung' });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });

  // POST Không phê duyệt — vien_truong hoặc admin
  router.post('/htqt/de-xuat/:id/khong-phe-duyet', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { ly_do } = req.body || {};
    const userEmail = (req.user.email || '').trim().toLowerCase();
    if (!ly_do || (ly_do || '').trim().length < 30) return res.status(400).json({ message: 'Lý do tối thiểu 30 ký tự' });
    if ((req.user.role || '').toLowerCase() !== 'admin') {
      try {
        const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
        if (!vt) return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được thực hiện' });
      } catch (e) {
        return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới được thực hiện' });
      }
    }
    try {
      const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
      db.prepare('UPDATE htqt_de_xuat SET status = \'tu_choi\', ly_do_khong_duyet = ?, updated_at = datetime(\'now\') WHERE id = ?').run(ly_do.trim(), id);
      db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'khong_phe_duyet', req.user.id, req.user.fullname || req.user.email, ly_do.trim());
      return res.json({ message: 'Đã ghi nhận không phê duyệt.', status: 'tu_choi' });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });

  // PATCH Admin cập nhật — admin only
  router.patch('/htqt/de-xuat/:id/admin', authMiddleware, adminOnly, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { ma_de_xuat, nguoi_phu_trach_id, muc_do_uu_tien, ghi_chu_noi_bo, trang_thai, loai_hinh } = req.body || {};
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
    try {
      const updates = [];
      const params = [];
      if (ma_de_xuat != null) { updates.push('ma_de_xuat = ?'); params.push(ma_de_xuat); }
      if (nguoi_phu_trach_id != null) { updates.push('nguoi_phu_trach_id = ?'); params.push(nguoi_phu_trach_id); }
      if (muc_do_uu_tien != null) { updates.push('muc_do_uu_tien = ?'); params.push(muc_do_uu_tien); }
      if (ghi_chu_noi_bo != null) { updates.push('ghi_chu_noi_bo = ?'); params.push(ghi_chu_noi_bo); }
      if (trang_thai != null) { updates.push('status = ?'); params.push(trang_thai); }
      if (loai_hinh != null) { updates.push('loai_hinh = ?'); params.push(loai_hinh); }
      if (updates.length === 0) return res.status(400).json({ message: 'Không có trường nào cập nhật' });
      params.push(id);
      db.prepare('UPDATE htqt_de_xuat SET ' + updates.join(', ') + ', updated_at = datetime(\'now\') WHERE id = ?').run(...params);
      return res.json({ message: 'Đã cập nhật.' });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });

  // POST Tạo đề xuất YTNN (demo / Phòng KHCN) — để có dữ liệu test
  router.post('/htqt/de-xuat', authMiddleware, (req, res) => {
    const user = req.user || {};
    const body = req.body || {};
    const year = new Date().getFullYear();
    try {
      db.prepare(`
        INSERT INTO htqt_de_xuat (ten, mo_ta, doi_tac_ten, doi_tac_quoc_gia, chu_nhiem_ten, chu_nhiem_hoc_vi, chu_nhiem_don_vi,
          ngay_bat_dau, ngay_ket_thuc, thoi_gian_thang, kinh_phi_vnd, loai_hinh, to_trinh_phong_khcn, status, ngay_tiep_nhan, han_xu_ly_vt,
          submitted_by_email, submitted_by_name, submitted_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        body.ten || 'Đề xuất tiếp nhận tài chính YTNN mẫu',
        body.mo_ta || 'Mô tả tóm tắt đề xuất hợp tác quốc tế.',
        body.doi_tac_ten || 'Đại học Kyoto',
        body.doi_tac_quoc_gia || 'Nhật Bản',
        body.chu_nhiem_ten || user.fullname || 'Chủ nhiệm',
        body.chu_nhiem_hoc_vi || 'TS.',
        body.chu_nhiem_don_vi || 'Phòng Lab',
        body.ngay_bat_dau || (year + '-04-01'),
        body.ngay_ket_thuc || (year + '-12-31'),
        body.thoi_gian_thang || 9,
        body.kinh_phi_vnd || 300000000,
        body.loai_hinh || 'hoat_dong_khcn',
        body.to_trinh_phong_khcn || 'Phòng KHCN&QHĐN đề nghị Viện trưởng xem xét phê duyệt đề xuất tiếp nhận tài chính YTNN theo Điều 62, 63, 64 Quy chế KHCN-ĐMST SCI 2026.',
        body.status || 'cho_vt_duyet',
        body.ngay_tiep_nhan || new Date().toISOString().slice(0, 10),
        body.han_xu_ly_vt || (() => { const d = new Date(); d.setDate(d.getDate() + 5); return d.toISOString().slice(0, 10); })(),
        user.email || '',
        user.fullname || '',
        user.id || null
      );
      const id = db.prepare('SELECT last_insert_rowid() as id').get().id;
      const ma = body.ma_de_xuat || ('ĐX-' + year + '-' + String(id).padStart(4, '0'));
      db.prepare('UPDATE htqt_de_xuat SET ma_de_xuat = ? WHERE id = ?').run(ma, id);
      db.prepare('INSERT INTO htqt_de_xuat_history (de_xuat_id, action, performed_by_id, performed_by_name, note) VALUES (?, ?, ?, ?, ?)')
        .run(id, 'tao_moi', user.id, user.fullname || user.email, 'Tạo đề xuất');
      ['thuyet_minh', 'van_ban_doi_tac', 'ly_lich_cn', 'y_kien_to_phan_loai'].forEach(function (loai) {
        try {
          db.prepare('INSERT INTO htqt_de_xuat_files (de_xuat_id, loai_file, ten_file, uploaded_by_id) VALUES (?, ?, ?, ?)')
            .run(id, loai, loai.replace(/_/g, ' ') + '.pdf', user.id);
        } catch (e) {}
      });
      return res.json({ message: 'Đã tạo đề xuất.', id, ma_de_xuat: ma });
    } catch (e) {
      console.error('[API] htqt/de-xuat create error:', e.message);
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
  });

  return router;
};
