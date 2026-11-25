'use strict';

/**
 * Hợp tác quốc tế — Người nộp cập nhật / nộp lại / kết thúc (4 loại) & Sự kiện hợp tác (15 endpoint).
 *
 *   PUT/POST /api/cooperation/{doan-ra,doan-vao,mou,ytnn}/:id/{cap-nhat-boi-nguoi-nop,nop-lai,ket-thuc}
 *   POST/GET/PUT /api/cooperation/su-kien(/:id)
 *
 * Tách khỏi server.js (Đợt 5.11 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');

function coopNopLaiStatusForLoai() {
  return 'cho_phong_duyet';
}

module.exports = function createCoopNopLaiVaSuKienRouter({
  db,
  PORT,
  authMiddleware,
  coopPhongOrAdmin,
  coopAssertSubmitter,
  coopAddHistory,
  coopGenMa,
  coopEscHtml,
  coopBuildEmail,
  coopNotifyPhongToCcVt,
}) {
  const router = express.Router();

  const capNhatHandlers = {
    doan_ra: (req, res) => {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      try {
        const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(id);
        if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
        const a = coopAssertSubmitter(req, row);
        if (!a.ok) return res.status(403).json({ message: a.message });
        if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
          return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
        }
        const muc_dich = b.muc_dich != null ? String(b.muc_dich) : row.muc_dich;
        const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia || '').trim() : row.quoc_gia;
        const ngay_di = b.ngay_di != null ? String(b.ngay_di || '').trim() : row.ngay_di;
        const ngay_ve = b.ngay_ve != null ? String(b.ngay_ve || '').trim() : row.ngay_ve;
        const thanh_vien = b.thanh_vien != null ? String(b.thanh_vien) : row.thanh_vien;
        const nguon_kinh_phi = b.nguon_kinh_phi != null ? String(b.nguon_kinh_phi) : row.nguon_kinh_phi;
        const du_toan = b.du_toan != null && b.du_toan !== '' ? String(b.du_toan) : row.du_toan;
        if (!quoc_gia || !ngay_di || !ngay_ve || !thanh_vien) {
          return res.status(400).json({ message: 'Vui lòng điền đủ: Quốc gia, Ngày đi, Ngày về, Thành viên đoàn.' });
        }
        db.prepare(`UPDATE cooperation_doan_ra SET muc_dich=?, quoc_gia=?, ngay_di=?, ngay_ve=?, thanh_vien=?, nguon_kinh_phi=?, du_toan=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
          .run(muc_dich, quoc_gia, ngay_di, ngay_ve, thanh_vien, nguon_kinh_phi, du_toan, id);
        coopAddHistory('doan_ra', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
        return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
      } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
    },
    doan_vao: (req, res) => {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      try {
        const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(id);
        if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
        const a = coopAssertSubmitter(req, row);
        if (!a.ok) return res.status(403).json({ message: a.message });
        if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
          return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
        }
        const muc_dich = b.muc_dich != null ? String(b.muc_dich) : row.muc_dich;
        const don_vi_de_xuat = b.don_vi_de_xuat != null ? String(b.don_vi_de_xuat || '').trim() : row.don_vi_de_xuat;
        const ngay_den = b.ngay_den != null ? String(b.ngay_den || '').trim() : row.ngay_den;
        const ngay_roi_di = b.ngay_roi_di != null ? String(b.ngay_roi_di || '').trim() : row.ngay_roi_di;
        const thanh_phan_doan = b.thanh_phan_doan != null ? String(b.thanh_phan_doan) : row.thanh_phan_doan;
        const noi_dung_lam_viec = b.noi_dung_lam_viec != null ? String(b.noi_dung_lam_viec) : row.noi_dung_lam_viec;
        const kinh_phi_nguon = b.kinh_phi_nguon != null ? String(b.kinh_phi_nguon) : row.kinh_phi_nguon;
        const ho_tro_visa = b.ho_tro_visa != null ? String(b.ho_tro_visa) : row.ho_tro_visa;
        if (!don_vi_de_xuat || !ngay_den || !thanh_phan_doan) {
          return res.status(400).json({ message: 'Vui lòng điền đủ: Đơn vị đề xuất, Ngày đến, Thành phần đoàn.' });
        }
        db.prepare(`UPDATE cooperation_doan_vao SET muc_dich=?, don_vi_de_xuat=?, ngay_den=?, ngay_roi_di=?, thanh_phan_doan=?, noi_dung_lam_viec=?, kinh_phi_nguon=?, ho_tro_visa=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
          .run(muc_dich, don_vi_de_xuat, ngay_den, ngay_roi_di, thanh_phan_doan, noi_dung_lam_viec, kinh_phi_nguon, ho_tro_visa, id);
        coopAddHistory('doan_vao', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
        return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
      } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
    },
    mou: (req, res) => {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      try {
        const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(id);
        if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
        const a = coopAssertSubmitter(req, row);
        if (!a.ok) return res.status(403).json({ message: a.message });
        if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
          return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
        }
        const loai_thoa_thuan = b.loai_thoa_thuan != null ? String(b.loai_thoa_thuan) : row.loai_thoa_thuan;
        const ten_doi_tac = b.ten_doi_tac != null ? String(b.ten_doi_tac || '').trim() : row.ten_doi_tac;
        const quoc_gia = b.quoc_gia != null ? String(b.quoc_gia) : row.quoc_gia;
        const thoi_han_nam = b.thoi_han_nam != null && b.thoi_han_nam !== '' ? String(b.thoi_han_nam) : row.thoi_han_nam;
        const gia_tri_tai_chinh = b.gia_tri_tai_chinh != null ? String(b.gia_tri_tai_chinh) : row.gia_tri_tai_chinh;
        const don_vi_de_xuat = b.don_vi_de_xuat != null ? String(b.don_vi_de_xuat) : row.don_vi_de_xuat;
        const noi_dung_hop_tac = b.noi_dung_hop_tac != null ? String(b.noi_dung_hop_tac) : row.noi_dung_hop_tac;
        if (!ten_doi_tac || !noi_dung_hop_tac) {
          return res.status(400).json({ message: 'Vui lòng điền đối tác và nội dung hợp tác.' });
        }
        db.prepare(`UPDATE cooperation_mou_de_xuat SET loai_thoa_thuan=?, ten_doi_tac=?, quoc_gia=?, thoi_han_nam=?, gia_tri_tai_chinh=?, don_vi_de_xuat=?, noi_dung_hop_tac=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
          .run(loai_thoa_thuan, ten_doi_tac, quoc_gia, thoi_han_nam, gia_tri_tai_chinh, don_vi_de_xuat, noi_dung_hop_tac, id);
        coopAddHistory('mou', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
        return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
      } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
    },
    ytnn: (req, res) => {
      const id = parseInt(req.params.id, 10);
      const b = req.body || {};
      try {
        const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(id);
        if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
        const a = coopAssertSubmitter(req, row);
        if (!a.ok) return res.status(403).json({ message: a.message });
        if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
          return res.status(400).json({ message: 'Chỉ chỉnh sửa khi đề xuất đang ở trạng thái yêu cầu bổ sung.' });
        }
        const ten = b.ten != null ? String(b.ten || '').trim() : row.ten;
        if (!ten) return res.status(400).json({ message: 'Thiếu tên đề tài.' });
        const mo_ta = b.mo_ta != null ? String(b.mo_ta) : row.mo_ta;
        const doi_tac_ten = b.doi_tac_ten != null ? String(b.doi_tac_ten) : row.doi_tac_ten;
        const doi_tac_quoc_gia = b.doi_tac_quoc_gia != null ? String(b.doi_tac_quoc_gia) : row.doi_tac_quoc_gia;
        const doi_tac_nguoi_dai_dien = b.doi_tac_nguoi_dai_dien != null ? String(b.doi_tac_nguoi_dai_dien) : row.doi_tac_nguoi_dai_dien;
        const doi_tac_website = b.doi_tac_website != null ? String(b.doi_tac_website) : row.doi_tac_website;
        const hinh_thuc_hop_tac = b.hinh_thuc_hop_tac != null ? String(b.hinh_thuc_hop_tac) : row.hinh_thuc_hop_tac;
        const chu_nhiem_ten = b.chu_nhiem_ten != null ? String(b.chu_nhiem_ten) : row.chu_nhiem_ten;
        const chu_nhiem_hoc_vi = b.chu_nhiem_hoc_vi != null ? String(b.chu_nhiem_hoc_vi) : row.chu_nhiem_hoc_vi;
        const chu_nhiem_don_vi = b.chu_nhiem_don_vi != null ? String(b.chu_nhiem_don_vi) : row.chu_nhiem_don_vi;
        const ngay_bat_dau = b.ngay_bat_dau != null ? String(b.ngay_bat_dau) : row.ngay_bat_dau;
        const ngay_ket_thuc = b.ngay_ket_thuc != null ? String(b.ngay_ket_thuc) : row.ngay_ket_thuc;
        let kinh_phi = row.kinh_phi;
        if (b.kinh_phi != null && b.kinh_phi !== '') {
          const n = parseFloat(b.kinh_phi);
          kinh_phi = Number.isFinite(n) ? n : row.kinh_phi;
        }
        const don_vi_tien_te = b.don_vi_tien_te != null ? String(b.don_vi_tien_te) : row.don_vi_tien_te;
        const loai_hinh = b.loai_hinh != null ? String(b.loai_hinh) : row.loai_hinh;
        db.prepare(`UPDATE htqt_de_xuat SET ten=?, mo_ta=?, doi_tac_ten=?, doi_tac_quoc_gia=?, doi_tac_nguoi_dai_dien=?, doi_tac_website=?, hinh_thuc_hop_tac=?, chu_nhiem_ten=?, chu_nhiem_hoc_vi=?, chu_nhiem_don_vi=?, ngay_bat_dau=?, ngay_ket_thuc=?, kinh_phi=?, don_vi_tien_te=?, loai_hinh=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`)
          .run(ten, mo_ta, doi_tac_ten, doi_tac_quoc_gia, doi_tac_nguoi_dai_dien, doi_tac_website, hinh_thuc_hop_tac, chu_nhiem_ten, chu_nhiem_hoc_vi, chu_nhiem_don_vi, ngay_bat_dau, ngay_ket_thuc, kinh_phi, don_vi_tien_te, loai_hinh, id);
        coopAddHistory('ytnn', id, 1, 'cap_nhat_boi_nguoi_nop', 'Người gửi cập nhật nội dung đề xuất', req.user, null);
        return res.json({ ok: true, message: 'Đã lưu chỉnh sửa.' });
      } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
    },
  };

  // --- Cập nhật / Nộp lại / Kết thúc (giữ đúng thứ tự cho từng loại) ---
  const submitterActionConfigs = [
    { slug: 'doan-ra', loai: 'doan_ra', table: 'cooperation_doan_ra', label: 'Đoàn ra', nopLaiMsg: 'Đã nộp lại. Phòng KHCN sẽ thẩm định lại.' },
    { slug: 'doan-vao', loai: 'doan_vao', table: 'cooperation_doan_vao', label: 'Đoàn vào', nopLaiMsg: 'Đã nộp lại.' },
    { slug: 'mou', loai: 'mou', table: 'cooperation_mou_de_xuat', label: 'MOU', nopLaiMsg: 'Đã nộp lại.' },
    { slug: 'ytnn', loai: 'ytnn', table: 'htqt_de_xuat', label: 'YTNN', nopLaiMsg: 'Đã nộp lại.' },
  ];

  for (const cfg of submitterActionConfigs) {
    router.put(`/cooperation/${cfg.slug}/:id/cap-nhat-boi-nguoi-nop`, authMiddleware, capNhatHandlers[cfg.loai]);
    router.post(`/cooperation/${cfg.slug}/:id/nop-lai`, authMiddleware, (req, res) => {
      const id = parseInt(req.params.id, 10);
      try {
        const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(id);
        if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
        const a = coopAssertSubmitter(req, row);
        if (!a.ok) return res.status(403).json({ message: a.message });
        if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
          return res.status(400).json({ message: 'Chỉ nộp lại khi đề xuất đang yêu cầu bổ sung.' });
        }
        const stNew = coopNopLaiStatusForLoai(cfg.loai);
        db.prepare(`UPDATE ${cfg.table} SET status=?, updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(stNew, id);
        const histText = cfg.loai === 'ytnn' ? 'Nộp lại hồ sơ — chờ Phòng KHCN phân loại & thẩm định' : 'Nộp lại hồ sơ — chờ Phòng KHCN thẩm định';
        coopAddHistory(cfg.loai, id, 2, 'nop_lai', histText, req.user, null);
        const ma = row.ma_de_xuat || coopGenMa(cfg.loai, id);
        const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
        coopNotifyPhongToCcVt(cfg.loai, {
          submitterEmail: row.submitted_by_email,
          subject: `[Hợp tác QT] Người gửi đã nộp lại hồ sơ — ${cfg.label} — ${ma}`,
          html: coopBuildEmail(`Nộp lại hồ sơ (${cfg.label})`, `Người gửi <strong>${coopEscHtml(row.submitted_by_name || row.submitted_by_email)}</strong> đã nộp lại hồ sơ theo yêu cầu bổ sung. Đề xuất quay lại bước <strong>Phòng KHCN thẩm định</strong>, sau đó trình Viện trưởng.`,
            [['Mã', ma], ['Người gửi', row.submitted_by_name || row.submitted_by_email]], 'Trân trọng.', modUrl),
          text: `Nộp lại ${cfg.label} ${ma}. ${modUrl}`
        }).catch(err => console.error(`[nop-lai ${cfg.loai}]`, err.message));
        return res.json({ ok: true, message: cfg.nopLaiMsg, status: stNew });
      } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
    });

    router.post(`/cooperation/${cfg.slug}/:id/ket-thuc`, authMiddleware, (req, res) => {
      const id = parseInt(req.params.id, 10);
      try {
        const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(id);
        if (!row) return res.status(404).json({ message: 'Không tìm thấy.' });
        const a = coopAssertSubmitter(req, row);
        if (!a.ok) return res.status(403).json({ message: a.message });
        if ((row.status || '').toLowerCase() !== 'yeu_cau_bo_sung') {
          return res.status(400).json({ message: 'Chỉ kết thúc khi đề xuất đang yêu cầu bổ sung.' });
        }
        db.prepare(`UPDATE ${cfg.table} SET status='ket_thuc_boi_nguoi_nop', updated_at=datetime('now','localtime'), coop_reminder_last_at=NULL WHERE id=?`).run(id);
        coopAddHistory(cfg.loai, id, 3, 'ket_thuc_boi_nguoi_nop', 'Người gửi kết thúc đề xuất (không nộp lại)', req.user, null);
        const ma = row.ma_de_xuat || coopGenMa(cfg.loai, id);
        const modUrl = (process.env.BASE_URL || ('http://localhost:' + PORT)) + '/module-hoatac-quocte.html';
        coopNotifyPhongToCcVt(cfg.loai, {
          submitterEmail: row.submitted_by_email,
          subject: `[Hợp tác QT] Người gửi đã kết thúc đề xuất — ${cfg.label} — ${ma}`,
          html: coopBuildEmail('Kết thúc đề xuất (thông báo)', `Người gửi đã <strong>chủ động kết thúc</strong> đề xuất, không tiếp tục nộp lại hồ sơ. Hồ sơ được lưu trong hệ thống.`,
            [['Mã', ma], ['Người gửi', row.submitted_by_name || row.submitted_by_email]], 'Trân trọng.', modUrl),
          text: `Kết thúc ${cfg.label} ${ma}. ${modUrl}`
        }).catch(err => console.error(`[ket-thuc ${cfg.loai}]`, err.message));
        return res.json({ ok: true, message: 'Đã ghi nhận kết thúc đề xuất.', status: 'ket_thuc_boi_nguoi_nop' });
      } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
    });
  }

  // ROUTE MỚI — SỰ KIỆN QUỐC TẾ
  router.post('/cooperation/su-kien', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const user = req.user || {};
    const body = req.body || {};
    if (!body.tieu_de || !body.ngay_bat_dau) return res.status(400).json({ message: 'Thiếu Tiêu đề và Ngày bắt đầu.' });
    try {
      const result = db.prepare(`
        INSERT INTO cooperation_su_kien (tieu_de, mo_ta, loai_su_kien, quoc_gia, dia_diem, ngay_bat_dau, ngay_ket_thuc, don_vi_to_chuc, link_su_kien, han_dang_ky, kinh_phi_tham_du, ghi_chu, tags, status, created_by_id, created_by_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(body.tieu_de, body.mo_ta || '', body.loai_su_kien || 'hoi_thao', body.quoc_gia || '', body.dia_diem || '',
        body.ngay_bat_dau, body.ngay_ket_thuc || '', body.don_vi_to_chuc || '',
        body.link_su_kien || '', body.han_dang_ky || '', body.kinh_phi_tham_du || '',
        body.ghi_chu || '', body.tags || '', body.status || 'sap_dien_ra',
        user.id || null, user.fullname || user.email || '');
      return res.json({ ok: true, message: 'Đã tạo sự kiện!', id: result.lastInsertRowid });
    } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
  });

  router.get('/cooperation/su-kien', (req, res) => {
    try {
      const { status } = req.query;
      const rows = status
        ? db.prepare("SELECT * FROM cooperation_su_kien WHERE status=? ORDER BY ngay_bat_dau ASC").all(status)
        : db.prepare("SELECT * FROM cooperation_su_kien ORDER BY ngay_bat_dau DESC").all();
      return res.json({ list: rows });
    } catch (e) { return res.json({ list: [] }); }
  });

  router.put('/cooperation/su-kien/:id', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const body = req.body || {};
    const allowed = ['tieu_de', 'mo_ta', 'loai_su_kien', 'quoc_gia', 'dia_diem', 'ngay_bat_dau', 'ngay_ket_thuc', 'don_vi_to_chuc', 'link_su_kien', 'han_dang_ky', 'kinh_phi_tham_du', 'ghi_chu', 'tags', 'status'];
    const sets = [], vals = [];
    for (const k of allowed) { if (body[k] !== undefined) { sets.push(`${k}=?`); vals.push(body[k]); } }
    if (!sets.length) return res.status(400).json({ message: 'Không có gì cập nhật.' });
    sets.push("updated_at=datetime('now','localtime')"); vals.push(id);
    try {
      db.prepare(`UPDATE cooperation_su_kien SET ${sets.join(',')} WHERE id=?`).run(...vals);
      return res.json({ ok: true, message: 'Đã cập nhật.' });
    } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
  });

  return router;
};
