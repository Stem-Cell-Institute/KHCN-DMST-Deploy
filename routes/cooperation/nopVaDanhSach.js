'use strict';

/**
 * Hợp tác quốc tế — Đề xuất của tôi, nộp & danh sách Đoàn ra / Đoàn vào / MOU (6 endpoint).
 *
 *   GET  /api/cooperation/de-xuat-cua-toi
 *   POST /api/cooperation/doan-ra/submit
 *   POST /api/cooperation/doan-vao/submit
 *   GET  /api/cooperation/doan-ra
 *   GET  /api/cooperation/doan-vao
 *   GET  /api/cooperation/mou
 *
 * Tách khỏi server.js (Đợt 5.5 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');

module.exports = function createCoopNopVaDanhSachRouter({
  db,
  PORT,
  authMiddleware,
  getCooperationRecipients,
  coopAddHistory,
  coopGenMa,
  coopGetRecipients,
  coopEscHtml,
  coopBuildEmail,
  coopSendMail,
  transporter,
}) {
  const router = express.Router();

  // Đề xuất của tôi — danh sách đề xuất user đã gửi (MOU, Đoàn ra)
  router.get('/cooperation/de-xuat-cua-toi', authMiddleware, (req, res) => {
    const user = req.user || {};
    const email = (user.email || '').trim().toLowerCase();
    if (!email) return res.json({ list: [], cho_duyet: 0 });
    const year = new Date().getFullYear();
    const list = [];
    try {
      const mous = db.prepare('SELECT id, ten_doi_tac, quoc_gia, loai_thoa_thuan, status, created_at FROM cooperation_mou_de_xuat WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
      for (const r of mous || []) {
        list.push({
          source: 'mou',
          loai: 'mou',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-M' + String(r.id).padStart(4, '0'),
          title: 'Đề xuất MOU — ' + (r.ten_doi_tac || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : ''),
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'dang_tham_dinh',
          step: r.status === 'dang_tham_dinh' ? 1 : (r.status === 'da_duyet' ? 4 : 2),
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
      const doans = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, status, created_at FROM cooperation_doan_ra WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
      for (const r of doans || []) {
        const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
        list.push({
          source: 'doan_ra',
          loai: 'doan_ra',
          id: r.id,
          ma_de_xuat: 'ĐX-' + year + '-D' + String(r.id).padStart(4, '0'),
          title: 'Đăng ký Đoàn ra — ' + (r.muc_dich || r.quoc_gia || '—') + (r.quoc_gia ? ', ' + r.quoc_gia : '') + ' — ' + soTV + ' thành viên',
          ngay_gui: (r.created_at || '').slice(0, 10),
          status: r.status || 'cho_phong_duyet',
          step: r.status === 'da_duyet' ? 4 : (r.status === 'tu_choi' ? 4 : r.status === 'dang_chuan_bi' ? 2 : 1),
          yeu_cau_bo_sung: null,
          han_phan_hoi: null,
          nguoi_xu_ly: 'Phòng KHCN&QHĐN'
        });
      }
      try {
        const doanVao = db.prepare('SELECT id, muc_dich, don_vi_de_xuat, thanh_phan_doan, status, created_at FROM cooperation_doan_vao WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
        for (const r of doanVao || []) {
          const st = (r.status || 'cho_tham_dinh').toLowerCase();
          const step = st === 'da_duyet' || st === 'tu_choi' ? 4 : (st === 'cho_ky_duyet' ? 3 : 2);
          list.push({
            source: 'doan_vao',
            loai: 'doan_vao',
            id: r.id,
            ma_de_xuat: 'ĐX-' + year + '-V' + String(r.id).padStart(4, '0'),
            title: 'Đăng ký Đoàn vào — ' + (r.muc_dich || '—') + ' — ' + (r.don_vi_de_xuat || '—'),
            ngay_gui: (r.created_at || '').slice(0, 10),
            status: r.status || 'cho_tham_dinh',
            step,
            yeu_cau_bo_sung: null,
            han_phan_hoi: null,
            nguoi_xu_ly: 'Phòng KHCN&QHĐN'
          });
        }
      } catch (ev) {}
      try {
        const ytnns = db.prepare('SELECT id, ten, status, created_at, ma_de_xuat FROM htqt_de_xuat WHERE lower(trim(submitted_by_email)) = ? ORDER BY created_at DESC').all(email);
        for (const r of ytnns || []) {
          list.push({
            source: 'ytnn',
            loai: 'ytnn',
            id: r.id,
            ma_de_xuat: r.ma_de_xuat || coopGenMa('ytnn', r.id),
            ten: r.ten,
            title: 'Đề tài có yếu tố nước ngoài — ' + (r.ten || '—'),
            ngay_gui: (r.created_at || '').slice(0, 10),
            status: r.status || 'cho_phong_duyet',
            step: 1,
            yeu_cau_bo_sung: null,
            han_phan_hoi: null,
            nguoi_xu_ly: 'Phòng KHCN&QHĐN'
          });
        }
      } catch (ey) {}
      try {
        const uidRow = db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email);
        if (uidRow && uidRow.id != null) {
          const hn = db
            .prepare(
              `SELECT id, submission_code, conf_name, status, created_at FROM conference_registrations
               WHERE submitted_by_user_id = ? AND status != 'cancelled' ORDER BY created_at DESC`
            )
            .all(uidRow.id);
          const HN_ST = {
            draft: 'Nháp',
            submitted: 'Chờ Phòng KHCN',
            khcn_reviewing: 'Phòng đang xem xét',
            khcn_approved: 'Chờ Viện trưởng',
            director_reviewing: 'Viện trưởng đang xem xét',
            director_approved: 'Đã phê duyệt',
            director_rejected: 'Viện trưởng từ chối',
            khcn_rejected: 'Phòng KHCN từ chối',
            completed: 'Đã nộp minh chứng',
          };
          for (const r of hn || []) {
            list.push({
              source: 'hnht',
              loai: 'hnht',
              id: r.id,
              ma_de_xuat: r.submission_code || '',
              title: 'HN/HT — ' + (r.conf_name || '—'),
              ngay_gui: (r.created_at || '').slice(0, 10),
              status: r.status || 'draft',
              status_label: HN_ST[r.status] || r.status,
              step: 1,
              yeu_cau_bo_sung: null,
              han_phan_hoi: null,
              nguoi_xu_ly: 'Phòng KHCN&QHĐN',
            });
          }
        }
      } catch (eh) {}
    } catch (e) {
      console.error('[API] de-xuat-cua-toi error:', e.message);
    }
    list.sort((a, b) => (b.ngay_gui || '').localeCompare(a.ngay_gui || ''));
    const choDuyet = list.filter(function (x) {
      var s = (x.status || '').toLowerCase();
      if (x.loai === 'hnht') {
        return (
          ['submitted', 'khcn_reviewing', 'khcn_approved', 'director_reviewing', 'khcn_rejected', 'director_rejected'].indexOf(s) >= 0
        );
      }
      return ['dang_tham_dinh', 'cho_ky_duyet', 'cho_tham_dinh', 'cho_phong_duyet', 'cho_vt_duyet', 'cho_vt_phe_duyet', 'yeu_cau_bo_sung', 'cho_phan_loai'].indexOf(s) >= 0;
    }).length;
    return res.json({ list, cho_duyet: choDuyet });
  });

  // Gửi đề xuất Đoàn ra: lưu vào DB + gửi email tới danh sách nhận thông báo (topic doan_ra hoặc all)
  router.post('/cooperation/doan-ra/submit', authMiddleware, (req, res) => {
    const user = req.user || {};
    const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
    const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
    const body = req.body || {};
    const mucDich = (body.muc_dich || body.mucDich || '').trim() || '—';
    const quocGia = (body.quoc_gia || body.quocGia || '').trim() || '—';
    const ngayDi = (body.ngay_di || body.ngayDi || '').trim() || '—';
    const ngayVe = (body.ngay_ve || body.ngayVe || '').trim() || '—';
    const thanhVien = (body.thanh_vien || body.thanhVien || '').trim() || '—';
    const nguonKinhPhi = (body.nguon_kinh_phi || body.nguonKinhPhi || '').trim() || '—';
    const duToan = (body.du_toan != null && body.du_toan !== '') ? String(body.du_toan) : '—';
    const toList = getCooperationRecipients('doan_ra');
    if (toList.length === 0) {
      return res.status(400).json({
        message: 'Chưa có email nhận thông báo Đoàn ra. Admin vui lòng thêm trong Quản trị module Hợp tác Quốc tế.',
        sent: 0
      });
    }
    try {
      db.prepare(
        `INSERT INTO cooperation_doan_ra (submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_phong_duyet')`
      ).run(submittedByEmail, submittedBy, mucDich, quocGia, ngayDi, ngayVe, thanhVien, nguonKinhPhi, duToan);
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
    }
    const newRowId = (db.prepare('SELECT last_insert_rowid() as id').get() || {}).id;
    try {
      if (newRowId) coopAddHistory('doan_ra', newRowId, 1, 'gui', 'Nộp đề xuất Đoàn ra', user, null);
    } catch (e) {}
    /* Phải dùng newRowId: sau coopAddHistory, last_insert_rowid() là id bảng coop_history, không phải cooperation_doan_ra → UPDATE ma sai, mã không lưu */
    const maDeXuat = newRowId ? coopGenMa('doan_ra', newRowId) : '';
    try {
      if (newRowId && maDeXuat) db.prepare('UPDATE cooperation_doan_ra SET ma_de_xuat=? WHERE id=?').run(maDeXuat, newRowId);
    } catch (e) {}
    const submittedId = newRowId || null;
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const moduleLink = baseUrl + '/module-hoatac-quocte.html';
    const recip = coopGetRecipients('doan_ra');
    let toMail = (recip.to || []).slice();
    let ccMail = (recip.cc || []).slice();
    if (toMail.length === 0 && (recip.all || []).length) {
      toMail = [recip.all[0]];
      ccMail = recip.all.slice(1);
    }
    if (toMail.length === 0 && toList.length) {
      toMail = toList.slice();
    }
    const subjectFormal = '[Hợp tác QT] Kính gửi Viện trưởng: Đề xuất đăng ký Đoàn ra công tác nước ngoài — ' + maDeXuat;
    const introFormal = 'Kính gửi <strong>Viện trưởng</strong> xem xét chỉ đạo; <strong>Phòng KHCN&amp;QHĐN</strong> và các đơn vị liên quan được CC để phối hợp thẩm định theo quy định. Đề xuất do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gửi trên Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc.';
    const htmlFormal = coopBuildEmail(
      'Thông báo đề xuất Đoàn ra công tác nước ngoài',
      introFormal,
      [['Mã đề xuất', maDeXuat], ['Mục đích', mucDich], ['Quốc gia / Địa điểm', quocGia], ['Ngày đi', ngayDi], ['Ngày về', ngayVe], ['Thành viên đoàn', thanhVien.replace(/\n/g, '<br>')], ['Nguồn kinh phí', nguonKinhPhi], ['Dự toán (VND)', duToan]],
      'Trân trọng kính gửi,<br/>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc<br/><span style="font-size:12px;color:#64748b">(Thông báo tự động từ hệ thống)</span>',
      moduleLink
    );
    const textFormal = 'Kính gửi Viện trưởng (CC Phòng KHCN&QHĐN và các địa chỉ nhận thông báo theo cấu hình),\n\n' +
      'Đề xuất đăng ký Đoàn ra công tác nước ngoài.\nMã: ' + maDeXuat + '\nNgười gửi: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
      'Mục đích: ' + mucDich + '\nQuốc gia/Địa điểm: ' + quocGia + '\nNgày đi: ' + ngayDi + '\nNgày về: ' + ngayVe + '\n' +
      'Dự toán (VND): ' + duToan + '\n\nXem chi tiết: ' + moduleLink + '\n\nTrân trọng kính gửi,\nHệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc';
    if (!transporter) {
      return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
    }
    coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
      .then(() => {
        const n = toMail.length + ccMail.length;
        res.json({ message: 'Đã gửi đề xuất Đoàn ra. Email kính gửi Viện trưởng (CC Phòng KHCN và các địa chỉ nhận thông báo theo cấu hình).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
      })
      .catch(err => {
        console.error('[Email] Gửi thông báo Đoàn ra lỗi:', err.message);
        res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
      });
  });

  // Gửi đề xuất Đoàn vào — đồng bộ quy trình & mã với Đoàn ra (cho_phong_duyet → thẩm định → VT)
  router.post('/cooperation/doan-vao/submit', authMiddleware, (req, res) => {
    const user = req.user || {};
    const submittedBy = (user.fullname || user.email || 'Người dùng').trim();
    const submittedByEmail = (user.email || '').trim() || 'noreply@sci.edu.vn';
    const body = req.body || {};
    const mucDich = (body.muc_dich || body.mucDich || '').trim() || '—';
    const donViDeXuat = (body.don_vi_de_xuat || body.donViDeXuat || '').trim() || '—';
    const ngayDen = (body.ngay_den || body.ngayDen || '').trim() || '—';
    const ngayRoiDi = (body.ngay_roi_di || body.ngayRoiDi || '').trim() || '—';
    const thanhPhanDoan = (body.thanh_phan_doan || body.thanhPhanDoan || '').trim() || '—';
    const noiDungLamViec = (body.noi_dung_lam_viec || body.noiDungLamViec || '').trim() || '—';
    const kinhPhiNguon = (body.kinh_phi_nguon || body.kinhPhiNguon || '').trim() || '—';
    const hoTroVisa = (body.ho_tro_visa || body.hoTroVisa || '').trim() || '—';
    const toList = getCooperationRecipients('doan_vao');
    if (toList.length === 0) {
      return res.status(400).json({
        message: 'Chưa có email nhận thông báo Đoàn vào. Admin vui lòng thêm trong Quản trị Hợp tác Quốc tế → Danh sách email (chọn topic Đoàn vào).',
        sent: 0
      });
    }
    let newRowId;
    try {
      db.prepare(
        `INSERT INTO cooperation_doan_vao (submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, noi_dung_lam_viec, kinh_phi_nguon, ho_tro_visa, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cho_phong_duyet')`
      ).run(submittedByEmail, submittedBy, mucDich, donViDeXuat, ngayDen, ngayRoiDi, thanhPhanDoan, noiDungLamViec, kinhPhiNguon, hoTroVisa);
      newRowId = (db.prepare('SELECT last_insert_rowid() as id').get() || {}).id;
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi lưu đề xuất: ' + (e.message || ''), sent: 0 });
    }
    try {
      if (newRowId) coopAddHistory('doan_vao', newRowId, 1, 'gui', 'Nộp đề xuất Đoàn vào', user, null);
    } catch (e) {}
    const maDeXuat = newRowId ? coopGenMa('doan_vao', newRowId) : '';
    try {
      if (newRowId && maDeXuat) db.prepare('UPDATE cooperation_doan_vao SET ma_de_xuat=? WHERE id=?').run(maDeXuat, newRowId);
    } catch (e) {}
    const submittedId = newRowId || null;
    const baseUrl = process.env.BASE_URL || ('http://localhost:' + PORT);
    const moduleLink = baseUrl + '/module-hoatac-quocte.html';
    const recip = coopGetRecipients('doan_vao');
    let toMail = (recip.to || []).slice();
    let ccMail = (recip.cc || []).slice();
    if (toMail.length === 0 && (recip.all || []).length) {
      toMail = [recip.all[0]];
      ccMail = recip.all.slice(1);
    }
    if (toMail.length === 0 && toList.length) {
      toMail = toList.slice();
    }
    const subjectFormal = '[Hợp tác QT] Kính gửi Viện trưởng: Đề xuất tiếp nhận Đoàn vào — ' + maDeXuat;
    const introFormal = 'Kính gửi <strong>Viện trưởng</strong> xem xét chỉ đạo; <strong>Phòng KHCN&amp;QHĐN</strong> và các đơn vị liên quan được CC để phối hợp thẩm định theo quy định. Đề xuất do <strong>' + coopEscHtml(submittedBy) + '</strong> (' + coopEscHtml(submittedByEmail) + ') gửi trên Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc.';
    const htmlFormal = coopBuildEmail(
      'Thông báo đề xuất tiếp nhận Đoàn vào (đoàn khách quốc tế)',
      introFormal,
      [['Mã đề xuất', maDeXuat], ['Mục đích', mucDich], ['Đơn vị đề xuất tiếp nhận', donViDeXuat], ['Ngày đến', ngayDen], ['Ngày rời đi', ngayRoiDi], ['Thành phần đoàn khách', thanhPhanDoan.replace(/\n/g, '<br>')], ['Nội dung làm việc', noiDungLamViec.replace(/\n/g, '<br>')], ['Kinh phí đón tiếp', kinhPhiNguon], ['Hỗ trợ visa / nhập cảnh', hoTroVisa]],
      'Trân trọng kính gửi,<br/>Hệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc<br/><span style="font-size:12px;color:#64748b">(Thông báo tự động từ hệ thống)</span>',
      moduleLink
    );
    const textFormal = 'Kính gửi Viện trưởng (CC Phòng KHCN&QHĐN và các địa chỉ nhận thông báo theo cấu hình),\n\n' +
      'Đề xuất tiếp nhận Đoàn vào.\nMã: ' + maDeXuat + '\nNgười gửi: ' + submittedBy + ' (' + submittedByEmail + ')\n' +
      'Mục đích: ' + mucDich + '\nĐơn vị: ' + donViDeXuat + '\nNgày đến: ' + ngayDen + '\nNgày rời: ' + ngayRoiDi + '\n' +
      'Thành phần: ' + thanhPhanDoan + '\n\nXem chi tiết: ' + moduleLink + '\n\nTrân trọng kính gửi,\nHệ thống Quản lý Hợp tác Quốc tế — Viện Tế bào gốc';
    if (!transporter) {
      return res.json({ message: 'Đã lưu đề xuất. Hệ thống chưa cấu hình SMTP nên chưa gửi được email thông báo.', sent: 0, ma_de_xuat: maDeXuat, id: submittedId });
    }
    coopSendMail({ to: toMail, cc: ccMail.length ? ccMail : undefined, subject: subjectFormal, html: htmlFormal, text: textFormal })
      .then(() => {
        const n = toMail.length + ccMail.length;
        res.json({ message: 'Đã gửi đề xuất Đoàn vào. Email kính gửi Viện trưởng (CC Phòng KHCN và các địa chỉ nhận thông báo theo cấu hình).', sent: n, ma_de_xuat: maDeXuat, id: submittedId });
      })
      .catch(err => {
        console.error('[Email] Gửi thông báo Đoàn vào lỗi:', err.message);
        res.status(500).json({ message: 'Gửi email thất bại: ' + (err.message || 'Lỗi hệ thống.'), sent: 0 });
      });
  });

  // Danh sách đề xuất Đoàn ra (dữ liệu thật, quá trình xử lý)
  router.get('/cooperation/doan-ra', authMiddleware, (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT id, ma_de_xuat, submitted_by_email, submitted_by_name, muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, status, created_at FROM cooperation_doan_ra ORDER BY created_at DESC`
      ).all();
      return res.json({ list: rows || [] });
    } catch (e) {
      return res.json({ list: [] });
    }
  });

  // Danh sách đề xuất Đoàn vào (đồng bộ với bảng "đã gửi" trên giao diện — giống Đoàn ra)
  router.get('/cooperation/doan-vao', authMiddleware, (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT id, ma_de_xuat, submitted_by_email, submitted_by_name, muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, status, created_at FROM cooperation_doan_vao ORDER BY created_at DESC`
      ).all();
      return res.json({ list: rows || [] });
    } catch (e) {
      return res.json({ list: [] });
    }
  });

  // Danh sách đề xuất Thỏa thuận / MOU (giống Đoàn ra — bảng «đã gửi» trên module)
  router.get('/cooperation/mou', authMiddleware, (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT id, ma_de_xuat, submitted_by_email, submitted_by_name, loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, status, created_at FROM cooperation_mou_de_xuat ORDER BY created_at DESC`
      ).all();
      return res.json({ list: rows || [] });
    } catch (e) {
      return res.json({ list: [] });
    }
  });

  return router;
};
