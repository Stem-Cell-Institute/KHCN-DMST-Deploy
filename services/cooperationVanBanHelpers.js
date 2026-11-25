/**
 * Helper xử lý Word, file đính kèm và thống kê dashboard cho module Hợp tác Quốc tế.
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const path = require('path');
const fs = require('fs');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const db = require('../lib/db-bridge');

module.exports = function createCooperationVanBanHelpers({
  DOAN_RA_TO_TRINH_TEMPLATE_PATH,
  DOAN_VAO_TO_TRINH_TEMPLATE_PATH,
  MOU_TO_TRINH_TEMPLATE_PATH,
  STATUS_LABELS_COOP,
  YTNN_TO_TRINH_TEMPLATE_PATH,
  coopFmtDateVN,
  coopGenMa,
  coopIsVienTruong,
  resolveCoopVanBanWordFileForUnlink,
  resolveStoredFileFromDb,
  roleIsAny,
}) {
  function coopFmtDate(s) {
    if (!s) return '—';
    const d = String(s).slice(0,10).split('-');
    return d.length === 3 ? `${d[2]}/${d[1]}/${d[0]}` : s;
  }

  function coopIsManager(req) {
    const role = (req.user && req.user.role || '').toLowerCase();
    const email = (req.user && req.user.email || '').trim().toLowerCase();
    return role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email);
  }

  function coopCanDownloadDoanRaVanBan(req, row) {
    if (!row || !row.van_ban_word_path) return false;
    const role = (req.user && req.user.role || '').toLowerCase();
    if (role === 'admin') return true;
    if (roleIsAny(req, ['phong_khcn'])) return true;
    const email = (req.user && req.user.email || '').trim().toLowerCase();
    if (email && (row.submitted_by_email || '').trim().toLowerCase() === email) return true;
    if (coopIsVienTruong(email)) return true;
    return false;
  }

  function coopUnlinkDoanRaVanBanFile(row) {
    if (!row || !row.van_ban_word_path) return;
    try {
      const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
      if (abs) fs.unlinkSync(abs);
    } catch (e) {}
  }

  function coopCanDownloadDoanVaoVanBan(req, row) {
    return coopCanDownloadDoanRaVanBan(req, row);
  }

  function coopUnlinkDoanVaoVanBanFile(row) {
    if (!row || !row.van_ban_word_path) return;
    try {
      const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
      if (abs) fs.unlinkSync(abs);
    } catch (e) {}
  }

  function coopCanDownloadMouVanBan(req, row) {
    return coopCanDownloadDoanRaVanBan(req, row);
  }

  function coopUnlinkMouVanBanFile(row) {
    if (!row || !row.van_ban_word_path) return;
    try {
      const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
      if (abs) fs.unlinkSync(abs);
    } catch (e) {}
  }

  function coopCanDownloadYtnnVanBan(req, row) {
    return coopCanDownloadDoanRaVanBan(req, row);
  }

  function coopUnlinkYtnnVanBanFile(row) {
    if (!row || !row.van_ban_word_path) return;
    try {
      const abs = resolveCoopVanBanWordFileForUnlink(row.van_ban_word_path);
      if (abs) fs.unlinkSync(abs);
    } catch (e) {}
  }


  function coopDaysLabelDoanRa(ngayDi, ngayVe) {
    try {
      const a = new Date(String(ngayDi).slice(0, 10));
      const b = new Date(String(ngayVe).slice(0, 10));
      const n = Math.round((b - a) / 86400000) + 1;
      if (isNaN(n) || n < 1) return '—';
      return `${n} ngày`;
    } catch (e) {
      return '—';
    }
  }

  function coopParseThanhVienDoanRa(text) {
    const raw = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      let line = raw[i];
      let stt = String(i + 1);
      let ho_ten = line;
      let chuc_vu = '';
      const num = line.match(/^(\d+)[\.\)]\s*(.+)$/);
      if (num) {
        stt = num[1];
        line = num[2].trim();
      }
      const parts = line.split('|').map(s => s.trim());
      if (parts.length >= 2) {
        ho_ten = parts[0];
        chuc_vu = parts.slice(1).join(' | ');
      } else {
        const dash = line.match(/^(.+?)\s*[–—-]\s*(.+)$/);
        if (dash) {
          ho_ten = dash[1].trim();
          chuc_vu = dash[2].trim();
        }
      }
      const ho = ho_ten || line;
      const cv = chuc_vu || 'Thành viên';
      out.push({
        stt,
        ho_ten: ho,
        chuc_vu: cv,
        hoTen: ho,
        chucVu: cv,
        ho_ten_chuc_vu: cv ? `${ho} — ${cv}` : ho
      });
    }
    if (!out.length) out.push({ stt: '1', ho_ten: '—', chuc_vu: '—', hoTen: '—', chucVu: '—', ho_ten_chuc_vu: '—' });
    return out;
  }

  /** Không điền chữ ký khi tên chỉ là tài khoản test (tránh “Admin” in trên mẫu). */
  function coopMergePersonLine(name, email) {
    const raw = ((name || '').trim() || (email || '').trim());
    if (!raw) return '';
    if (/^admin$/i.test(raw)) return '';
    if (/^admin@/i.test(raw)) return '';
    return raw;
  }

  function coopBuildDoanRaMergeData(row) {
    let nguoiPheDuyetKy = '';
    try {
      if (row.vt_xu_ly_id) {
        const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.vt_xu_ly_id);
        if (u) nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
      }
    } catch (e) {}
    const nguoiPheDuyetBang = nguoiPheDuyetKy || '—';
    const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
    const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
    const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
    let duToanStr = '—';
    if (row.du_toan != null && String(row.du_toan).trim() !== '') {
      const s = String(row.du_toan).trim();
      duToanStr = /(usd|vnd|vnđ|đồng|\bđ\b)/i.test(s) ? s : `${s} VND`;
    }
    const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
    const noiDung = noiParts.length ? noiParts.join('\n') : '—';
    const ma = row.ma_de_xuat || coopGenMa('doan_ra', row.id);
    const tieuDeToTrinh = (row.muc_dich || '').trim() || 'Tờ trình v/v đoàn công tác nước ngoài';
    const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
    const thanhVienList = coopParseThanhVienDoanRa(row.thanh_vien);
    const core = {
      ma_so: ma,
      ngay_to_trinh: coopFmtDateVN(row.created_at),
      quoc_gia: row.quoc_gia || '—',
      muc_dich: row.muc_dich || '—',
      ngay_di: coopFmtDateVN(row.ngay_di),
      ngay_ve: coopFmtDateVN(row.ngay_ve),
      tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_di, row.ngay_ve),
      nguon_kinh_phi: row.nguon_kinh_phi || '—',
      du_toan: duToanStr,
      du_toan_vnd: duToanStr,
      noi_dung_bo_sung: noiDung,
      trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
      ngay_phe_duyet: ngayPheDuyet,
      nguoi_phe_duyet: nguoiPheDuyetBang,
      nguoi_de_xuat: nguoiDeXuatKy,
      tp_hcm_ngay: tpHcmNgay,
      thanh_vien: thanhVienList,
      thanh_phan: thanhVienList,
      thanhPhan: thanhVienList
    };
    return Object.assign({}, core, {
      ma_de_xuat: ma,
      ngay_lap: core.ngay_to_trinh,
      tieu_de_to_trinh: tieuDeToTrinh,
      nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
      can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất như sau:',
      quoc_gia_dia_diem: core.quoc_gia,
      so_ngay: core.tong_thoi_gian,
      du_toan_usd: duToanStr,
      danh_sach_thanh_vien: (row.thanh_vien || '').trim() ? String(row.thanh_vien).trim() : '—',
      ghi_chu: noiDung,
      ngay_duyet: ngayPheDuyet,
      ten_vien_truong: nguoiPheDuyetKy,
      thanh_pho_ngay: tpHcmNgay,
      chuc_vu_de_xuat: '—'
    });
  }

  const CAN_CU_DOAN_RA_DAY_DU = 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất như sau:';

  /**
   * Một số mẫu .docx vẫn gõ sẵn chữ (không chỉ placeholder) — docxtemplater không ghi đè.
   * Hậu xử lý XML trong file đã merge để đồng bộ lời kính gửi, căn cứ, và bỏ chữ ký "Admin" test.
   */
  function coopPostProcessDoanRaDocxBuffer(buf) {
    try {
      const zip = new PizZip(buf);
      const rePath = /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;
      for (const p of Object.keys(zip.files)) {
        if (!rePath.test(p) || zip.files[p].dir) continue;
        let xml = zip.file(p).asText();
        if (!xml) continue;
        xml = xml.replace(/Ban Giám hiệu\s*\/\s*/g, '');
        xml = xml.replace(
          /<w:t([^>]*)>(Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST\.)<\/w:t>/g,
          (m, attrs) => {
            if (m.includes('tôi đề nghị')) return m;
            return `<w:t${attrs}>${CAN_CU_DOAN_RA_DAY_DU}</w:t>`;
          }
        );
        xml = xml.replace(/<w:t([^>]*)>Admin<\/w:t>/g, '<w:t$1></w:t>');
        zip.file(p, xml);
      }
      return zip.generate({ type: 'nodebuffer' });
    } catch (e) {
      console.warn('[doan_ra] post-process docx:', e.message);
      return buf;
    }
  }

  function coopMergeDoanRaDocx(row) {
    if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) {
      throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình (menu trong chi tiết Đoàn ra).');
    }
    const content = fs.readFileSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH);
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: function () { return ''; }
    });
    doc.render(coopBuildDoanRaMergeData(row));
    let out = doc.getZip().generate({ type: 'nodebuffer' });
    out = coopPostProcessDoanRaDocxBuffer(out);
    return out;
  }

  /**
   * Sinh file Word từ mẫu Tờ trình Đoàn ra (một file .docx chung cho loại đề xuất này) và ghi vào van_ban_word_*.
   * Dùng sau khi phê duyệt để người gửi không phải chờ Admin.
   */
  function coopTryAutoGenerateDoanRaVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return { ok: false, skipped: 'bad_id' };
    if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) {
      return { ok: false, skipped: 'no_template' };
    }
    try {
      const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(nid);
      if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
        return { ok: false, skipped: 'not_approved' };
      }
      const buf = coopMergeDoanRaDocx(row);
      coopUnlinkDoanRaVanBanFile(row);
      const safeMa = (row.ma_de_xuat || 'doan-ra-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
      const outName = `To-trinh-${safeMa}.docx`;
      const outRel = path.join('uploads', 'htqt-doan-ra', 'doan_ra_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
      const abs = resolveStoredFileFromDb(outRel);
      try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
      fs.writeFileSync(abs, buf);
      db.prepare(`UPDATE cooperation_doan_ra SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
        .run(outRel, outName, nid);
      return { ok: true, outName };
    } catch (e) {
      console.error('[doan_ra] auto Word:', e);
      return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
    }
  }

  function coopBuildDoanVaoMergeData(row) {
    let nguoiPheDuyetKy = '';
    try {
      if (row.vt_xu_ly_id) {
        const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.vt_xu_ly_id);
        if (u) nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
      }
    } catch (e) {}
    const nguoiPheDuyetBang = nguoiPheDuyetKy || '—';
    const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
    const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
    const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
    const kinhPhiStr = (row.kinh_phi_nguon != null && String(row.kinh_phi_nguon).trim()) ? String(row.kinh_phi_nguon).trim() : '—';
    const ma = row.ma_de_xuat || coopGenMa('doan_vao', row.id);
    const tieuDeToTrinh = (row.muc_dich || '').trim() || 'Tờ trình v/v tiếp nhận đoàn khách quốc tế';
    const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
    const noiParts = [row.noi_dung_lam_viec, row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
    const noiDung = noiParts.length ? noiParts.join('\n') : '—';
    const thanhVienParsed = coopParseThanhVienDoanRa(row.thanh_phan_doan);
    const core = {
      ma_so: ma,
      ngay_to_trinh: coopFmtDateVN(row.created_at),
      quoc_gia: row.don_vi_de_xuat || '—',
      don_vi_de_xuat: row.don_vi_de_xuat || '—',
      muc_dich: row.muc_dich || '—',
      ngay_den: coopFmtDateVN(row.ngay_den),
      ngay_roi_di: coopFmtDateVN(row.ngay_roi_di),
      ngay_di: coopFmtDateVN(row.ngay_den),
      ngay_ve: coopFmtDateVN(row.ngay_roi_di),
      tong_thoi_gian: coopDaysLabelDoanRa(row.ngay_den, row.ngay_roi_di),
      nguon_kinh_phi: kinhPhiStr,
      du_toan: kinhPhiStr,
      du_toan_vnd: kinhPhiStr,
      ho_tro_visa: row.ho_tro_visa || '—',
      noi_dung_lam_viec: row.noi_dung_lam_viec || '—',
      noi_dung_bo_sung: noiDung,
      trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
      ngay_phe_duyet: ngayPheDuyet,
      nguoi_phe_duyet: nguoiPheDuyetBang,
      nguoi_de_xuat: nguoiDeXuatKy,
      tp_hcm_ngay: tpHcmNgay,
      thanh_vien: thanhVienParsed,
      thanh_phan: thanhVienParsed,
      thanhPhan: thanhVienParsed
    };
    return Object.assign({}, core, {
      ma_de_xuat: ma,
      ngay_lap: core.ngay_to_trinh,
      tieu_de_to_trinh: tieuDeToTrinh,
      nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
      can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất tiếp nhận đoàn khách/quốc tế như sau:',
      quoc_gia_dia_diem: core.quoc_gia,
      so_ngay: core.tong_thoi_gian,
      du_toan_usd: kinhPhiStr,
      danh_sach_thanh_vien: (row.thanh_phan_doan || '').trim() ? String(row.thanh_phan_doan).trim() : '—',
      ghi_chu: noiDung,
      ngay_duyet: ngayPheDuyet,
      ten_vien_truong: nguoiPheDuyetKy,
      thanh_pho_ngay: tpHcmNgay,
      chuc_vu_de_xuat: '—'
    });
  }

  function coopMergeDoanVaoDocx(row) {
    if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) {
      throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình Đoàn vào (menu trong chi tiết đề xuất).');
    }
    const content = fs.readFileSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH);
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: function () { return ''; }
    });
    doc.render(coopBuildDoanVaoMergeData(row));
    let out = doc.getZip().generate({ type: 'nodebuffer' });
    out = coopPostProcessDoanRaDocxBuffer(out);
    return out;
  }

  function coopTryAutoGenerateDoanVaoVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return { ok: false, skipped: 'bad_id' };
    if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) {
      return { ok: false, skipped: 'no_template' };
    }
    try {
      const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(nid);
      if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
        return { ok: false, skipped: 'not_approved' };
      }
      const buf = coopMergeDoanVaoDocx(row);
      coopUnlinkDoanVaoVanBanFile(row);
      const safeMa = (row.ma_de_xuat || 'doan-vao-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
      const outName = `To-trinh-${safeMa}.docx`;
      const outRel = path.join('uploads', 'htqt-doan-vao', 'doan_vao_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
      const abs = resolveStoredFileFromDb(outRel);
      try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
      fs.writeFileSync(abs, buf);
      db.prepare(`UPDATE cooperation_doan_vao SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
        .run(outRel, outName, nid);
      return { ok: true, outName };
    } catch (e) {
      console.error('[doan_vao] auto Word:', e);
      return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
    }
  }

  /** Bản merge tự sinh có đường dẫn chứa `_to_trinh_`. File admin tải tay thay thế không có — không tự ghép đè. */
  function coopVanBanIsAutoMergedOutput(relPath) {
    return !!(relPath && String(relPath).includes('_to_trinh_'));
  }

  /**
   * Đề xuất đã phê duyệt: sinh lần đầu nếu chưa có file.
   * Nếu đã có bản tự sinh và mẫu `to-trinh-template.docx` mới hơn file merge → ghép lại (đổi mẫu [1] không cần bấm Sinh lại thủ công).
   */
  function coopEnsureFreshDoanRaVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return null;
    const row = db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
    if (!fs.existsSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH)) return row;
    let tplMs = 0;
    try { tplMs = fs.statSync(DOAN_RA_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
    let shouldRegen = false;
    if (!row.van_ban_word_path) {
      shouldRegen = true;
    } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
      const abs = resolveStoredFileFromDb(row.van_ban_word_path);
      if (!abs || !fs.existsSync(abs)) {
        shouldRegen = true;
      } else {
        try {
          if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
        } catch (e) {}
      }
    }
    if (!shouldRegen) return row;
    try {
      const gen = coopTryAutoGenerateDoanRaVanBan(nid);
      if (gen && gen.ok) return db.prepare('SELECT * FROM cooperation_doan_ra WHERE id=?').get(nid);
    } catch (e) {}
    return row;
  }

  function coopEnsureFreshDoanVaoVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return null;
    const row = db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
    if (!fs.existsSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH)) return row;
    let tplMs = 0;
    try { tplMs = fs.statSync(DOAN_VAO_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
    let shouldRegen = false;
    if (!row.van_ban_word_path) {
      shouldRegen = true;
    } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
      const abs = resolveStoredFileFromDb(row.van_ban_word_path);
      if (!abs || !fs.existsSync(abs)) {
        shouldRegen = true;
      } else {
        try {
          if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
        } catch (e) {}
      }
    }
    if (!shouldRegen) return row;
    try {
      const gen = coopTryAutoGenerateDoanVaoVanBan(nid);
      if (gen && gen.ok) return db.prepare('SELECT * FROM cooperation_doan_vao WHERE id=?').get(nid);
    } catch (e) {}
    return row;
  }

  function coopBuildMouMergeData(row) {
    let nguoiPheDuyetKy = '';
    try {
      if (row.vt_xu_ly_id) {
        const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(row.vt_xu_ly_id);
        if (u) nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
      }
    } catch (e) {}
    const nguoiPheDuyetBang = nguoiPheDuyetKy || '—';
    const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
    const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
    const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
    const ma = row.ma_de_xuat || coopGenMa('mou', row.id);
    const loaiTT = (row.loai_thoa_thuan || '').trim();
    const tenDt = (row.ten_doi_tac || '').trim();
    const tieuDeToTrinh = [loaiTT, tenDt].filter(Boolean).join(' — ') || 'Tờ trình v/v đề xuất Thỏa thuận hợp tác';
    const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
    const noiParts = [row.ghi_chu, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
    const noiDung = noiParts.length ? noiParts.join('\n') : '—';
    const thoiHanStr = (row.thoi_han_nam != null && String(row.thoi_han_nam).trim() !== '') ? String(row.thoi_han_nam).trim() : '—';
    const core = {
      ma_so: ma,
      ngay_to_trinh: coopFmtDateVN(row.created_at),
      loai_thoa_thuan: row.loai_thoa_thuan || '—',
      ten_doi_tac: row.ten_doi_tac || '—',
      quoc_gia: row.quoc_gia || '—',
      thoi_han_nam: thoiHanStr,
      gia_tri_tai_chinh: row.gia_tri_tai_chinh || '—',
      don_vi_de_xuat: row.don_vi_de_xuat || '—',
      noi_dung_hop_tac: row.noi_dung_hop_tac || '—',
      noi_dung_bo_sung: noiDung,
      trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
      ngay_phe_duyet: ngayPheDuyet,
      nguoi_phe_duyet: nguoiPheDuyetBang,
      nguoi_de_xuat: nguoiDeXuatKy,
      tp_hcm_ngay: tpHcmNgay
    };
    return Object.assign({}, core, {
      ma_de_xuat: ma,
      ngay_lap: core.ngay_to_trinh,
      tieu_de_to_trinh: tieuDeToTrinh,
      nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
      can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất ký kết thỏa thuận hợp tác như sau:',
      quoc_gia_dia_diem: core.quoc_gia,
      ghi_chu: noiDung,
      ngay_duyet: ngayPheDuyet,
      ten_vien_truong: nguoiPheDuyetKy,
      thanh_pho_ngay: tpHcmNgay,
      chuc_vu_de_xuat: '—'
    });
  }

  function coopMergeMouDocx(row) {
    if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) {
      throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình Thỏa thuận/MOU (menu trong chi tiết đề xuất).');
    }
    const content = fs.readFileSync(MOU_TO_TRINH_TEMPLATE_PATH);
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: function () { return ''; }
    });
    doc.render(coopBuildMouMergeData(row));
    let out = doc.getZip().generate({ type: 'nodebuffer' });
    out = coopPostProcessDoanRaDocxBuffer(out);
    return out;
  }

  function coopTryAutoGenerateMouVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return { ok: false, skipped: 'bad_id' };
    if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) {
      return { ok: false, skipped: 'no_template' };
    }
    try {
      const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(nid);
      if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
        return { ok: false, skipped: 'not_approved' };
      }
      const buf = coopMergeMouDocx(row);
      coopUnlinkMouVanBanFile(row);
      const safeMa = (row.ma_de_xuat || 'mou-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
      const outName = `To-trinh-${safeMa}.docx`;
      const outRel = path.join('uploads', 'htqt-mou', 'mou_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
      const abs = resolveStoredFileFromDb(outRel);
      try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
      fs.writeFileSync(abs, buf);
      db.prepare(`UPDATE cooperation_mou_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
        .run(outRel, outName, nid);
      return { ok: true, outName };
    } catch (e) {
      console.error('[mou] auto Word:', e);
      return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
    }
  }

  function coopEnsureFreshMouVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return null;
    const row = db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
    if (!fs.existsSync(MOU_TO_TRINH_TEMPLATE_PATH)) return row;
    let tplMs = 0;
    try { tplMs = fs.statSync(MOU_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
    let shouldRegen = false;
    if (!row.van_ban_word_path) {
      shouldRegen = true;
    } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
      const abs = resolveStoredFileFromDb(row.van_ban_word_path);
      if (!abs || !fs.existsSync(abs)) {
        shouldRegen = true;
      } else {
        try {
          if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
        } catch (e) {}
      }
    }
    if (!shouldRegen) return row;
    try {
      const gen = coopTryAutoGenerateMouVanBan(nid);
      if (gen && gen.ok) return db.prepare('SELECT * FROM cooperation_mou_de_xuat WHERE id=?').get(nid);
    } catch (e) {}
    return row;
  }

  function coopBuildYtnnMergeData(row) {
    let nguoiPheDuyetKy = '';
    let nguoiPheDuyetRaw = '';
    try {
      const uid = row.vt_xu_ly_id || row.vt_nguoi_ky_id;
      if (uid) {
        const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(uid);
        if (u) {
          nguoiPheDuyetRaw = (u.fullname || u.email || '').trim();
          nguoiPheDuyetKy = coopMergePersonLine(u.fullname, u.email);
        }
      }
    } catch (e) {}
    const nguoiPheDuyetBang = nguoiPheDuyetKy || nguoiPheDuyetRaw || '—';
    const nguoiDeXuatKy = coopMergePersonLine(row.submitted_by_name, row.submitted_by_email);
    const approvalDate = row.vt_xu_ly_at || row.updated_at || '';
    const ngayPheDuyet = coopFmtDateVN(approvalDate) !== '—' ? coopFmtDateVN(approvalDate) : coopFmtDateVN(new Date().toISOString());
    const ma = row.ma_de_xuat || coopGenMa('ytnn', row.id);
    const tenDeTai = (row.ten || '').trim();
    const tenDt = (row.doi_tac_ten || '').trim();
    // Mẫu thường gõ "V/v {tieu_de_to_trinh}" — không lặp chữ "Tờ trình v/v" trong giá trị
    const tieuDeToTrinh = tenDeTai
      ? ('đề xuất đề tài YTNN — ' + tenDeTai)
      : 'đề xuất đề tài có yếu tố nước ngoài';
    const tpHcmNgay = 'TP. Hồ Chí Minh, ngày ' + ngayPheDuyet;
    const noiParts = [row.mo_ta, row.ghi_chu_noi_bo, row.note_vt, row.note_phong].filter(x => x && String(x).trim());
    const noiDung = noiParts.length ? noiParts.join('\n') : '—';
    const moTaGoc = (row.mo_ta && String(row.mo_ta).trim()) ? String(row.mo_ta).trim() : '';
    const moTaMotDong = moTaGoc ? moTaGoc.replace(/\s+/g, ' ') : '—';
    const donViTien = ((row.don_vi_tien_te != null && String(row.don_vi_tien_te).trim()) ? String(row.don_vi_tien_te).trim() : 'VNĐ');
    let kinhPhiSo = '—';
    if (row.kinh_phi != null && String(row.kinh_phi).trim() !== '') {
      const n = Number(row.kinh_phi);
      kinhPhiSo = Number.isFinite(n) ? String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.') : String(row.kinh_phi).trim();
    }
    let kinhPhiStr = '—';
    if (kinhPhiSo !== '—') kinhPhiStr = `${kinhPhiSo} ${donViTien}`;
    const qgDt = row.doi_tac_quoc_gia || '—';
    const core = {
      ma_so: ma,
      ngay_to_trinh: coopFmtDateVN(row.created_at),
      ten_de_tai: tenDeTai || '—',
      ten_doi_tac: tenDt || '—',
      ten_to_chuc_doi_tac: tenDt || '—',
      quoc_gia: qgDt,
      quoc_gia_doi_tac: qgDt,
      nguoi_dai_dien_doi_tac: (row.doi_tac_nguoi_dai_dien && String(row.doi_tac_nguoi_dai_dien).trim()) ? String(row.doi_tac_nguoi_dai_dien).trim() : '—',
      website_doi_tac: (row.doi_tac_website && String(row.doi_tac_website).trim()) ? String(row.doi_tac_website).trim() : '—',
      loai_hinh: row.loai_hinh || '—',
      hinh_thuc_hop_tac: row.hinh_thuc_hop_tac || '—',
      chu_nhiem: row.chu_nhiem_ten || '—',
      chu_nhiem_de_tai: row.chu_nhiem_ten || '—',
      chu_nhiem_hoc_vi: row.chu_nhiem_hoc_vi || '—',
      hoc_ham_hoc_vi: row.chu_nhiem_hoc_vi || '—',
      chu_nhiem_don_vi: row.chu_nhiem_don_vi || '—',
      don_vi_chu_nhiem: row.chu_nhiem_don_vi || '—',
      kinh_phi: kinhPhiSo,
      don_vi_tien_te: donViTien,
      ngay_bat_dau: coopFmtDateVN(row.ngay_bat_dau),
      ngay_ket_thuc: coopFmtDateVN(row.ngay_ket_thuc),
      thoi_gian_thang: row.thoi_gian_thang != null && String(row.thoi_gian_thang).trim() !== '' ? String(row.thoi_gian_thang).trim() : '—',
      mo_ta: moTaMotDong,
      mo_ta_de_tai: moTaGoc || '—',
      noi_dung_hop_tac: moTaGoc || '—',
      gia_tri_tai_chinh: kinhPhiStr,
      noi_dung_bo_sung: noiDung,
      trang_thai_phe_duyet: (row.status === 'da_duyet') ? 'ĐÃ PHÊ DUYỆT' : (STATUS_LABELS_COOP[row.status] || row.status || '—'),
      ngay_phe_duyet: ngayPheDuyet,
      nguoi_phe_duyet: nguoiPheDuyetBang,
      nguoi_de_xuat: nguoiDeXuatKy,
      tp_hcm_ngay: tpHcmNgay
    };
    const tenVtHienThi = nguoiPheDuyetKy || nguoiPheDuyetRaw || '—';
    return Object.assign({}, core, {
      ma_de_xuat: ma,
      ngay_lap: core.ngay_to_trinh,
      tieu_de_to_trinh: tieuDeToTrinh,
      loai_thoa_thuan: core.loai_hinh,
      thoi_han_nam: core.thoi_gian_thang,
      don_vi_de_xuat: core.chu_nhiem_don_vi,
      nguoi_nhan_to_trinh: 'Viện trưởng Viện Tế bào gốc',
      can_cu_trinh_bay: 'Theo quy định của Viện và Quy chế quản lý KHCN-ĐMST, tôi đề nghị Viện trưởng xem xét và phê duyệt đề xuất tiếp nhận đề tài có yếu tố nước ngoài như sau:',
      quoc_gia_dia_diem: core.quoc_gia,
      ghi_chu: noiDung,
      ngay_duyet: ngayPheDuyet,
      ten_vien_truong: tenVtHienThi,
      thanh_pho_ngay: tpHcmNgay,
      chuc_vu_de_xuat: '—'
    });
  }

  function coopMergeYtnnDocx(row) {
    if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) {
      throw new Error('Chưa có file mẫu .docx. Admin vui lòng tải lên mẫu Tờ trình Đề tài YTNN (menu trong chi tiết đề xuất).');
    }
    const content = fs.readFileSync(YTNN_TO_TRINH_TEMPLATE_PATH);
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: function () { return ''; }
    });
    doc.render(coopBuildYtnnMergeData(row));
    let out = doc.getZip().generate({ type: 'nodebuffer' });
    out = coopPostProcessDoanRaDocxBuffer(out);
    return out;
  }

  function coopTryAutoGenerateYtnnVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return { ok: false, skipped: 'bad_id' };
    if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) {
      return { ok: false, skipped: 'no_template' };
    }
    try {
      const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(nid);
      if (!row || (row.status || '').toLowerCase() !== 'da_duyet') {
        return { ok: false, skipped: 'not_approved' };
      }
      const buf = coopMergeYtnnDocx(row);
      coopUnlinkYtnnVanBanFile(row);
      const safeMa = (row.ma_de_xuat || 'ytnn-' + nid).replace(/[^a-zA-Z0-9._\u00C0-\u024F-]/g, '_');
      const outName = `To-trinh-${safeMa}.docx`;
      const outRel = path.join('uploads', 'htqt-ytnn', 'ytnn_' + nid + '_to_trinh_' + Date.now() + '.docx').replace(/\\/g, '/');
      const abs = resolveStoredFileFromDb(outRel);
      try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) {}
      fs.writeFileSync(abs, buf);
      db.prepare(`UPDATE htqt_de_xuat SET van_ban_word_path=?, van_ban_word_original_name=?, van_ban_word_uploaded_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`)
        .run(outRel, outName, nid);
      return { ok: true, outName };
    } catch (e) {
      console.error('[ytnn] auto Word:', e);
      return { ok: false, skipped: 'error', message: 'Đã xảy ra lỗi. Vui lòng thử lại sau.' };
    }
  }

  function coopEnsureFreshYtnnVanBan(id) {
    const nid = parseInt(id, 10);
    if (!nid) return null;
    const row = db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(nid);
    if (!row || (row.status || '').toLowerCase() !== 'da_duyet') return row;
    if (!fs.existsSync(YTNN_TO_TRINH_TEMPLATE_PATH)) return row;
    let tplMs = 0;
    try { tplMs = fs.statSync(YTNN_TO_TRINH_TEMPLATE_PATH).mtimeMs; } catch (e) { return row; }
    let shouldRegen = false;
    if (!row.van_ban_word_path) {
      shouldRegen = true;
    } else if (coopVanBanIsAutoMergedOutput(row.van_ban_word_path)) {
      const abs = resolveStoredFileFromDb(row.van_ban_word_path);
      if (!abs || !fs.existsSync(abs)) {
        shouldRegen = true;
      } else {
        try {
          if (tplMs > fs.statSync(abs).mtimeMs) shouldRegen = true;
        } catch (e) {}
      }
    }
    if (!shouldRegen) return row;
    try {
      const gen = coopTryAutoGenerateYtnnVanBan(nid);
      if (gen && gen.ok) return db.prepare('SELECT * FROM htqt_de_xuat WHERE id=?').get(nid);
    } catch (e) {}
    return row;
  }

  // Middleware phân quyền mới
  function coopPhongOrAdmin(req, res, next) {
    const role = (req.user && req.user.role || '').toLowerCase();
    if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) return next();
    return res.status(403).json({ message: 'Chỉ Phòng KHCN hoặc Admin mới có quyền này.' });
  }
  function coopVTOrAdmin(req, res, next) {
    const role = (req.user && req.user.role || '').toLowerCase();
    if (role === 'admin') return next();
    const email = (req.user && req.user.email || '').trim().toLowerCase();
    if (coopIsVienTruong(email)) return next();
    return res.status(403).json({ message: 'Chỉ Viện trưởng hoặc Admin mới có quyền này.' });
  }

  const COOP_DASH_TABLES = ['cooperation_doan_ra', 'cooperation_doan_vao', 'cooperation_mou_de_xuat', 'htqt_de_xuat'];
  const COOP_PENDING_STATUSES = new Set([
    'dang_tham_dinh', 'cho_ky_duyet', 'cho_tham_dinh', 'cho_phong_duyet', 'cho_vt_duyet', 'cho_vt_phe_duyet',
    'yeu_cau_bo_sung', 'cho_phan_loai', 'dang_chuan_bi'
  ]);

  function coopDashGroupByStatus(table, emailLower) {
    try {
      const sql = emailLower
        ? `SELECT lower(trim(COALESCE(status,''))) AS st, COUNT(*) AS c FROM ${table} WHERE lower(trim(submitted_by_email)) = ? GROUP BY lower(trim(COALESCE(status,'')))`
        : `SELECT lower(trim(COALESCE(status,''))) AS st, COUNT(*) AS c FROM ${table} GROUP BY lower(trim(COALESCE(status,'')))`;
      return emailLower ? db.prepare(sql).all(emailLower) : db.prepare(sql).all();
    } catch (e) {
      return [];
    }
  }

  function coopDashGroupByMonth(table, emailLower) {
    try {
      const sql = emailLower
        ? `SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS c FROM ${table} WHERE created_at IS NOT NULL AND trim(CAST(created_at AS TEXT)) != '' AND lower(trim(submitted_by_email)) = ? GROUP BY ym HAVING ym IS NOT NULL AND length(ym) >= 7`
        : `SELECT strftime('%Y-%m', created_at) AS ym, COUNT(*) AS c FROM ${table} WHERE created_at IS NOT NULL AND trim(CAST(created_at AS TEXT)) != '' GROUP BY ym HAVING ym IS NOT NULL AND length(ym) >= 7`;
      return emailLower ? db.prepare(sql).all(emailLower) : db.prepare(sql).all();
    } catch (e) {
      return [];
    }
  }

  function coopDashMergeStatusBuckets(emailLower) {
    const merged = {};
    for (const t of COOP_DASH_TABLES) {
      for (const r of coopDashGroupByStatus(t, emailLower)) {
        const st = (r.st || '').toLowerCase();
        merged[st] = (merged[st] || 0) + (r.c || 0);
      }
    }
    const by = { dang_xu_ly: 0, da_phe_duyet: 0, tu_choi: 0, ket_thuc: 0, khac: 0 };
    for (const st of Object.keys(merged)) {
      const n = merged[st] || 0;
      if (!st) {
        by.khac += n;
        continue;
      }
      if (st === 'da_duyet' || st === 'da_phe_duyet' || st === 'hoan_thanh') by.da_phe_duyet += n;
      else if (st === 'tu_choi' || st === 'khong_phe_duyet') by.tu_choi += n;
      else if (st.indexOf('ket_thuc') >= 0) by.ket_thuc += n;
      else if (COOP_PENDING_STATUSES.has(st)) by.dang_xu_ly += n;
      else by.khac += n;
    }
    return by;
  }

  function coopDashLast12MonthsKeys() {
    const keys = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return keys;
  }

  function coopDashSeries12m(emailLower) {
    const acc = {};
    for (const t of COOP_DASH_TABLES) {
      for (const r of coopDashGroupByMonth(t, emailLower)) {
        const ym = r.ym;
        if (!ym || String(ym).length < 7) continue;
        acc[ym] = (acc[ym] || 0) + (r.c || 0);
      }
    }
    return coopDashLast12MonthsKeys().map(month => ({ month, total: acc[month] || 0 }));
  }

  /** Chỉ Quản trị viện, Phòng KHCN, Viện trưởng — Dashboard tổng thể không dành cho user thường */
  function coopDashboardViewer(req, res, next) {
    const role = (req.user && req.user.role || '').toLowerCase();
    const email = (req.user && req.user.email || '').trim().toLowerCase();
    if (role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email)) return next();
    return res.status(403).json({ message: 'Chỉ Quản trị viện, Phòng KHCN hoặc Viện trưởng mới xem được Dashboard.' });
  }

  function coopBuildTitle(loai, r) {
    if (loai==='doan_ra') return `Đoàn ra — ${r.quoc_gia||'—'}${r.muc_dich?' ('+r.muc_dich+')':''}`;
    if (loai==='doan_vao') return `Đoàn vào — ${r.muc_dich||r.don_vi_de_xuat||'—'}`;
    if (loai==='mou') return `MOU — ${r.ten_doi_tac||'—'}${r.quoc_gia?', '+r.quoc_gia:''}`;
    if (loai==='ytnn') return `Đề tài có yếu tố nước ngoài — ${r.ten||'—'}`;
    return '—';
  }

  return {
    coopBuildTitle,
    coopCanDownloadDoanRaVanBan,
    coopCanDownloadDoanVaoVanBan,
    coopCanDownloadMouVanBan,
    coopCanDownloadYtnnVanBan,
    coopDashMergeStatusBuckets,
    coopDashSeries12m,
    coopDashboardViewer,
    coopEnsureFreshDoanRaVanBan,
    coopEnsureFreshDoanVaoVanBan,
    coopEnsureFreshMouVanBan,
    coopEnsureFreshYtnnVanBan,
    coopFmtDate,
    coopIsManager,
    coopPhongOrAdmin,
    coopTryAutoGenerateDoanRaVanBan,
    coopTryAutoGenerateDoanVaoVanBan,
    coopTryAutoGenerateMouVanBan,
    coopTryAutoGenerateYtnnVanBan,
    coopUnlinkDoanRaVanBanFile,
    coopUnlinkDoanVaoVanBanFile,
    coopUnlinkMouVanBanFile,
    coopUnlinkYtnnVanBanFile,
    coopVTOrAdmin,
  };
};
