'use strict';

/**
 * Hợp tác quốc tế — nộp MOU, thống kê quản lý & danh sách đề xuất chờ duyệt (7 endpoint).
 *
 *   POST /api/cooperation/mou/submit
 *   GET  /api/cooperation/de-xuat-chi-tiet/:source/:id
 *   GET  /api/cooperation/can-approve
 *   GET  /api/cooperation/quan-ly-stats
 *   GET  /api/cooperation/de-xuat-cho-phong-khcn
 *   GET  /api/cooperation/de-xuat-cho-vien-truong
 *   GET  /api/cooperation/de-xuat-cho-duyet
 *
 * Tách khỏi server.js (Đợt 5.3 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');

module.exports = function createCoopQuanLyDeXuatRouter({
  db,
  authMiddleware,
  roleIsAny,
  vienTruongOrAdmin,
  canSeeQuanLySection,
  getCooperationRecipientsSplit,
  coopAddHistory,
  coopGenMa,
  transporter,
  getSmtpFrom,
}) {
  const router = express.Router();

  function addHtqtToChoDuyetList(list, year) {
    try {
      const rows = db.prepare('SELECT id, ten, chu_nhiem_ten, loai_hinh, status, created_at, ngay_tiep_nhan FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\') ORDER BY created_at ASC').all();
      for (const r of rows || []) {
        list.push({
          source: 'htqt',
          id: r.id,
          ma_de_xuat: r.ma_de_xuat || ('ĐX-' + year + '-' + String(r.id).padStart(4, '0')),
          title: (r.ten || '—') + (r.chu_nhiem_ten ? ' — ' + r.chu_nhiem_ten : ''),
          submitted_by: r.chu_nhiem_ten || '—',
          ngay_gui: (r.ngay_tiep_nhan || r.created_at || '').slice(0, 10),
          status: r.status,
          loai_hinh: r.loai_hinh
        });
      }
    } catch (e) {}
  }

  // Gửi đề xuất Thỏa thuận (MOU): lưu vào DB + gửi email tới danh sách nhận thông báo (topic mou hoặc all)
  router.post('/cooperation/mou/submit', authMiddleware, (req, res) => {
    const user = req.user || {};
    const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
    const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
    const body = req.body || {};
    const loaiThoaThuan = (body.loai_thoa_thuan || body.loaiThoaThuan || '').trim() || '—';
    const tenDoiTac = (body.ten_doi_tac || body.tenDoiTac || '').trim() || '—';
    const quocGia = (body.quoc_gia || body.quocGia || '').trim() || '—';
    const thoiHanNam = (body.thoi_han_nam != null && body.thoi_han_nam !== '') ? String(body.thoi_han_nam) : '—';
    const giaTriTaiChinh = (body.gia_tri_tai_chinh || body.giaTriTaiChinh || '').trim() || '—';
    const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || '—';
    const noiDungHopTac = (body.noi_dung_hop_tac || body.noiDungHopTac || '').trim() || '—';
    const { to: toList, cc: ccList } = getCooperationRecipientsSplit('mou');
    const allRecipients = [...toList, ...ccList];
    if (allRecipients.length === 0) {
      return res.status(400).json({
        message: 'Chưa có email nhận thông báo đề xuất Thỏa thuận. Admin vui lòng thêm trong Quản trị Hợp tác Quốc tế → Danh sách email (chọn topic MOU).',
        sent: 0
      });
    }
    let newRowId;
    try {
      const ins = db.prepare(
        `INSERT INTO cooperation_mou_de_xuat (submitted_by_email, submitted_by_name, loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, noi_dung_hop_tac, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dang_tham_dinh')`
      ).run(submittedByEmail, submittedBy, loaiThoaThuan, tenDoiTac, quocGia, thoiHanNam, giaTriTaiChinh, donViDeXuat, noiDungHopTac);
      newRowId = ins.lastInsertRowid;
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
    }
    try {
      if (newRowId) coopAddHistory('mou', newRowId, 1, 'gui', 'Nộp đề xuất Thỏa thuận', user, null);
    } catch (e) {}
    const maDeXuatMou = newRowId ? coopGenMa('mou', newRowId) : '';
    try {
      if (newRowId && maDeXuatMou) db.prepare('UPDATE cooperation_mou_de_xuat SET ma_de_xuat=? WHERE id=?').run(maDeXuatMou, newRowId);
    } catch (e) {}
    const subject = '[Hợp tác QT] Đề xuất Thỏa thuận mới: ' + tenDoiTac + ' — ' + submittedBy;
    const textBody = 'Kính gửi Viện trưởng,\n\nPhòng KHCN&QHĐN trân trọng báo cáo: ' + submittedBy + ' (' + submittedByEmail + ') đã gửi đề xuất Thỏa thuận hợp tác quốc tế mới lên Phòng để thẩm định và trình Viện trưởng.\n\nThông tin đề xuất:\n- Mã: ' + maDeXuatMou + '\n- Loại thỏa thuận: ' + loaiThoaThuan + '\n- Đối tác: ' + tenDoiTac + '\n- Quốc gia: ' + quocGia + '\n- Thời hạn (năm): ' + thoiHanNam + '\n- Giá trị tài chính: ' + giaTriTaiChinh + '\n- Đơn vị đề xuất: ' + donViDeXuat + '\n- Nội dung hợp tác: ' + noiDungHopTac + '\n\nKính mong Viện trưởng xem xét và chỉ đạo. Phòng KHCN&QHĐN sẽ thẩm định và báo cáo chi tiết khi có kết quả.\n\nTrân trọng.';
    const htmlBody = '<p style="margin-bottom:16px;"><strong>Kính gửi Viện trưởng,</strong></p><p>Phòng KHCN&amp;QHĐN trân trọng báo cáo: <strong>' + submittedBy + '</strong> (' + submittedByEmail + ') đã gửi đề xuất Thỏa thuận hợp tác quốc tế mới lên Phòng để thẩm định và trình Viện trưởng.</p><p><strong>Thông tin đề xuất:</strong></p><table border="1" cellpadding="10" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;"><tr style="background:#f8fafc;"><td style="font-weight:600;width:40%;">Mã đề xuất</td><td>' + maDeXuatMou + '</td></tr><tr><td style="font-weight:600;">Loại thỏa thuận</td><td>' + loaiThoaThuan + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Đối tác</td><td>' + tenDoiTac + '</td></tr><tr><td style="font-weight:600;">Quốc gia</td><td>' + quocGia + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Thời hạn (năm)</td><td>' + thoiHanNam + '</td></tr><tr><td style="font-weight:600;">Giá trị tài chính</td><td>' + giaTriTaiChinh + '</td></tr><tr style="background:#f8fafc;"><td style="font-weight:600;">Đơn vị đề xuất</td><td>' + donViDeXuat + '</td></tr><tr><td style="font-weight:600;">Nội dung hợp tác</td><td>' + noiDungHopTac.replace(/\n/g, '<br>') + '</td></tr></table><p style="margin-top:16px;">Kính mong Viện trưởng xem xét và chỉ đạo. Phòng KHCN&amp;QHĐN sẽ thẩm định và báo cáo chi tiết khi có kết quả.</p><p>Trân trọng.</p>';
    if (!transporter) {
      return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuatMou, id: newRowId || null });
    }
    const mailOpts = {
      from: getSmtpFrom(),
      to: toList.length > 0 ? toList.join(', ') : ccList[0],
      subject,
      text: textBody,
      html: htmlBody
    };
    if (ccList.length > 0 && toList.length > 0) mailOpts.cc = ccList.join(', ');
    else if (toList.length === 0 && ccList.length > 1) mailOpts.cc = ccList.slice(1).join(', ');
    transporter.sendMail(mailOpts).then(() => {
      res.json({ message: 'Đã gửi đề xuất Thỏa thuận tới Phòng KHCN&QHĐN. Email đã gửi tới Viện trưởng (Kính gửi) và CC ' + allRecipients.length + ' địa chỉ.', sent: allRecipients.length, ma_de_xuat: maDeXuatMou, id: newRowId || null });
    }).catch(err => {
      console.error('[Email] Gửi thông báo đề xuất MOU lỗi:', err.message);
      res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
    });
  });

  // Chi tiết đề xuất (MOU hoặc Đoàn ra) — user phải là người gửi hoặc admin/vien_truong
  router.get('/cooperation/de-xuat-chi-tiet/:source/:id', authMiddleware, (req, res) => {
    const source = (req.params.source || '').toLowerCase();
    const id = parseInt(req.params.id, 10);
    if (!id || !['mou', 'doan_ra', 'doan_vao'].includes(source)) {
      return res.status(400).json({ message: 'Nguồn hoặc ID không hợp lệ' });
    }
    const userEmail = (req.user.email || '').trim().toLowerCase();
    const year = new Date().getFullYear();
    try {
      if (source === 'mou') {
        const r = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id = ?').get(id);
        if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
        const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
        if (submitterEmail !== userEmail && req.user.role !== 'admin') {
          const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
          if (!vt) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
        }
        const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'yeu_cau_bo_sung' ? 2 : 1);
        return res.json({
          source: 'mou',
          id: r.id,
          ma_de_xuat: r.ma_de_xuat || coopGenMa('mou', r.id),
          title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
          loai_thoa_thuan: r.loai_thoa_thuan,
          ten_doi_tac: r.ten_doi_tac,
          quoc_gia: r.quoc_gia,
          thoi_han_nam: r.thoi_han_nam,
          gia_tri_tai_chinh: r.gia_tri_tai_chinh,
          don_vi_de_xuat: r.don_vi_de_xuat,
          noi_dung_hop_tac: r.noi_dung_hop_tac,
          submitted_by_email: r.submitted_by_email,
          submitted_by_name: r.submitted_by_name,
          status: r.status || 'dang_tham_dinh',
          step,
          ngay_gui: (r.created_at || '').slice(0, 10),
          ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
      if (source === 'doan_ra') {
        const r = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id = ?').get(id);
        if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
        const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
        if (submitterEmail !== userEmail && req.user.role !== 'admin') {
          const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
          if (!vt) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
        }
        const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : (r.status || '') === 'dang_chuan_bi' ? 2 : 1);
        return res.json({
          source: 'doan_ra',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
          muc_dich: r.muc_dich,
          quoc_gia: r.quoc_gia,
          ngay_di: r.ngay_di,
          ngay_ve: r.ngay_ve,
          thanh_vien: r.thanh_vien,
          nguon_kinh_phi: r.nguon_kinh_phi,
          du_toan: r.du_toan,
          submitted_by_email: r.submitted_by_email,
          submitted_by_name: r.submitted_by_name,
          status: r.status || 'cho_phong_duyet',
          step,
          ngay_gui: (r.created_at || '').slice(0, 10),
          ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
      if (source === 'doan_vao') {
        const r = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id = ?').get(id);
        if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất' });
        const submitterEmail = (r.submitted_by_email || '').trim().toLowerCase();
        if (submitterEmail !== userEmail && req.user.role !== 'admin') {
          const vt = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(userEmail);
          const pk = roleIsAny(req, ['phong_khcn']);
          if (!vt && !pk) return res.status(403).json({ message: 'Không có quyền xem đề xuất này' });
        }
        const step = (r.status || '') === 'da_duyet' ? 4 : ((r.status || '') === 'tu_choi' ? 4 : 1);
        return res.json({
          source: 'doan_vao',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
          muc_dich: r.muc_dich,
          don_vi_de_xuat: r.don_vi_de_xuat,
          ngay_den: r.ngay_den,
          ngay_roi_di: r.ngay_roi_di,
          thanh_phan_doan: r.thanh_phan_doan,
          noi_dung_lam_viec: r.noi_dung_lam_viec,
          kinh_phi_nguon: r.kinh_phi_nguon,
          ho_tro_visa: r.ho_tro_visa,
          submitted_by_email: r.submitted_by_email,
          submitted_by_name: r.submitted_by_name,
          status: r.status || 'cho_tham_dinh',
          step,
          ngay_gui: (r.created_at || '').slice(0, 10),
          ngay_cap_nhat: (r.updated_at || '').slice(0, 10),
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
    } catch (e) {
      console.error('[API] de-xuat-chi-tiet error:', e.message);
      return res.status(500).json({ message: 'Lỗi hệ thống' });
    }
    return res.status(400).json({ message: 'Nguồn không hợp lệ' });
  });

  // Kiểm tra user có quyền phê duyệt đề xuất (Admin hoặc Viện trưởng)
  router.get('/cooperation/can-approve', authMiddleware, (req, res) => {
    const role = (req.user.role || '').toLowerCase();
    if (role === 'admin') return res.json({ canApprove: true });
    const email = (req.user.email || '').trim().toLowerCase();
    if (!email) return res.json({ canApprove: false });
    try {
      const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
      return res.json({ canApprove: !!r });
    } catch (e) {
      return res.json({ canApprove: false });
    }
  });

  // Số lượng đề xuất chờ P.KHCN vs Viện trưởng + quyền xem mục QUẢN LÝ (Admin, P.KHCN, Viện trưởng)
  router.get('/cooperation/quan-ly-stats', authMiddleware, (req, res) => {
    const role = (req.user.role || '').toLowerCase();
    const email = (req.user.email || '').trim().toLowerCase();
    let canSeeQuanLy = role === 'admin' || roleIsAny(req, ['phong_khcn']);
    if (!canSeeQuanLy && email) {
      try {
        const r = db.prepare('SELECT 1 FROM cooperation_notification_recipients WHERE lower(trim(email)) = ? AND lower(trim(role)) = \'vien_truong\'').get(email);
        canSeeQuanLy = !!r;
      } catch (e) {}
    }
    let choPhongKhcn = 0, choVienTruong = 0;
    if (canSeeQuanLy) {
      try {
        const m = db.prepare('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\'').get();
        let mouCount = (m && m.c) || 0;
        let doanVaoCount = 0;
        try {
          const dv = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_tham_dinh\'').get();
          doanVaoCount = (dv && dv.c) || 0;
        } catch (e) {}
        choPhongKhcn = mouCount + doanVaoCount;
        const d = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\'').get();
        const dCount = (d && d.c) || 0;
        let doanVaoVtCount = 0;
        try {
          const dv = db.prepare('SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_ky_duyet\'').get();
          doanVaoVtCount = (dv && dv.c) || 0;
        } catch (e) {}
        let htqtCount = 0;
        try {
          const h = db.prepare('SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\')').get();
          htqtCount = (h && h.c) || 0;
        } catch (e) {}
        choVienTruong = dCount + doanVaoVtCount + htqtCount;
      } catch (e) {}
    }
    return res.json({ canSeeQuanLy, choPhongKhcn, choVienTruong });
  });

  // Các đề xuất chờ P.KHCN thẩm định (MOU dang_tham_dinh + Đoàn vào cho_tham_dinh) — Admin, P.KHCN, Viện trưởng
  router.get('/cooperation/de-xuat-cho-phong-khcn', authMiddleware, canSeeQuanLySection, (req, res) => {
    const year = new Date().getFullYear();
    const list = [];
    try {
      const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
      for (const r of mous || []) {
        list.push({
          source: 'mou',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
          title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
          submitted_by: r.submitted_by_name || r.submitted_by_email,
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status
        });
      }
      const doanVao = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_tham_dinh\' ORDER BY created_at ASC').all();
      for (const r of doanVao || []) {
        list.push({
          source: 'doan_vao',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
          submitted_by: r.submitted_by_name || r.submitted_by_email,
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status
        });
      }
    } catch (e) {
      console.error('[API] de-xuat-cho-phong-khcn error:', e.message);
    }
    list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
    return res.json({ list });
  });

  // Các đề xuất chờ Viện trưởng phê duyệt (Đoàn ra cho_vt_duyet + HTQT cho_vt_phe_duyet) — Admin, Viện trưởng
  router.get('/cooperation/de-xuat-cho-vien-truong', authMiddleware, vienTruongOrAdmin, (req, res) => {
    const year = new Date().getFullYear();
    const list = [];
    try {
      const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\' ORDER BY created_at ASC').all();
      for (const r of doans || []) {
        list.push({
          source: 'doan_ra',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
          submitted_by: r.submitted_by_name || r.submitted_by_email,
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status
        });
      }
      const doanVao = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(status)) = \'cho_ky_duyet\' ORDER BY created_at ASC').all();
      for (const r of doanVao || []) {
        list.push({
          source: 'doan_vao',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
          submitted_by: r.submitted_by_name || r.submitted_by_email,
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status
        });
      }
      addHtqtToChoDuyetList(list, year);
    } catch (e) {
      console.error('[API] de-xuat-cho-vien-truong error:', e.message);
    }
    list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
    return res.json({ list });
  });

  // Các đề xuất chờ duyệt — chỉ Admin và Viện trưởng (tổng hợp, giữ tương thích)
  router.get('/cooperation/de-xuat-cho-duyet', authMiddleware, vienTruongOrAdmin, (req, res) => {
    const year = new Date().getFullYear();
    const list = [];
    try {
      const mous = db.prepare('SELECT id, submitted_by_email, submitted_by_name, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(status)) = \'dang_tham_dinh\' ORDER BY created_at ASC').all();
      for (const r of mous || []) {
        list.push({
          source: 'mou',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
          title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
          submitted_by: r.submitted_by_name || r.submitted_by_email,
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status
        });
      }
      const doans = db.prepare('SELECT id, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, status, created_at FROM cooperation_doan_ra WHERE lower(trim(status)) = \'cho_vt_duyet\' ORDER BY created_at ASC').all();
      for (const r of doans || []) {
        list.push({
          source: 'doan_ra',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—'),
          submitted_by: r.submitted_by_name || r.submitted_by_email,
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status
        });
      }
      addHtqtToChoDuyetList(list, year);
    } catch (e) {
      console.error('[API] de-xuat-cho-duyet error:', e.message);
    }
    list.sort((a, b) => (a.ngay_gui || '').localeCompare(b.ngay_gui || ''));
    return res.json({ list });
  });

  return router;
};
