'use strict';

/**
 * Hợp tác quốc tế — Thêm, chấm dứt & cập nhật scan Thỏa thuận (3 endpoint).
 *
 *   POST /api/cooperation/thoa-thuan
 *   POST /api/cooperation/thoa-thuan/:id/terminate
 *   POST /api/cooperation/thoa-thuan/:id/agreement-scan
 *
 * Tách khỏi server.js (Đợt 5.7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');
const path = require('path');

module.exports = function createCoopThoaThuanCapNhatRouter({
  db,
  authMiddleware,
  coopPhongOrAdmin,
  uploadHtqtThoaThuanScan,
  uploadHtqtThoaThuanTermination,
  thoaThuanParseOpenEndedFlag,
  thoaThuanAutoStatusByExpiry,
  thoaThuanHetHanFromSigningYears,
}) {
  const router = express.Router();

  // P.KHCN/Admin: thêm thỏa thuận + upload scan
  router.post('/cooperation/thoa-thuan', authMiddleware, coopPhongOrAdmin, (req, res) => {
    uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
      if (err) return res.status(400).json({ message: 'Upload file thất bại' });
      const { ten, doi_tac, loai, het_han, ngay_ky, thoi_han_nam, quoc_gia, loai_doi_tac, staff_notes } = req.body || {};
      const tenTrim = (ten || '').trim();
      const doiTacTrim = (doi_tac || '').trim();
      const loaiTrim = (loai || '').trim();
      if (!tenTrim || !doiTacTrim || !loaiTrim) {
        return res.status(400).json({ message: 'Thiếu Tên thỏa thuận, Đối tác hoặc Loại' });
      }
      const noFixedTerm = thoaThuanParseOpenEndedFlag(req.body && req.body.no_fixed_term);
      const staffNotesVal = String(staff_notes || '').trim() || null;
      const nk = String(ngay_ky || '').trim();
      const thnRaw = String(thoi_han_nam != null ? thoi_han_nam : '').trim();
      const thn = parseInt(thnRaw, 10);
      let hetHanVal = null;
      let noFixedTermInt = 0;
      if (noFixedTerm) {
        if (!nk) {
          return res.status(400).json({ message: 'Vui lòng nhập Ngày ký (thời hạn không cố định vẫn cần ngày ký để hồ sơ).' });
        }
        hetHanVal = null;
        noFixedTermInt = 1;
      } else {
        if (nk && thnRaw !== '' && Number.isFinite(thn)) {
          const computed = thoaThuanHetHanFromSigningYears(nk, thn);
          if (!computed) {
            return res.status(400).json({ message: 'Ngày ký hoặc thời hạn hiệu lực (năm) không hợp lệ.' });
          }
          hetHanVal = computed;
        } else {
          hetHanVal = (het_han || '').trim() || null;
        }
        if (!hetHanVal) {
          return res.status(400).json({ message: 'Vui lòng nhập Ngày ký và Thời hạn hiệu lực (năm), hoặc chọn Không có thời hạn cố định.' });
        }
      }
      const trangThai = noFixedTerm ? 'hieu_luc' : thoaThuanAutoStatusByExpiry(hetHanVal);
      const quocGiaVal = (quoc_gia || '').trim() || null;
      const loaiValDt = ['quoc_te', 'trong_nuoc', 'doanh_nghiep', 'dia_phuong'].includes((loai_doi_tac || '').trim()) ? loai_doi_tac.trim() : null;
      const scanPath = req.file ? path.join('uploads', 'htqt-thoa-thuan', req.file.filename).replace(/\\/g, '/') : null;
      const scanName = req.file ? (req.file.originalname || req.file.filename) : null;
      try {
        db.prepare(
          `INSERT INTO cooperation_thoa_thuan (ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, no_fixed_term, staff_notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          tenTrim, doiTacTrim, loaiTrim, hetHanVal, trangThai, quocGiaVal, loaiValDt, scanPath, scanName,
          scanPath ? new Date().toISOString() : null, noFixedTermInt, staffNotesVal
        );
        const row = db.prepare(
          `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at,
                  no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
           FROM cooperation_thoa_thuan WHERE id = last_insert_rowid()`
        ).get();
        return res.status(201).json({ message: 'Đã thêm thỏa thuận.', item: row });
      } catch (e) {
        return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
      }
    });
  });

  // P.KHCN / Admin: record agreement termination date + optional termination document
  router.post('/cooperation/thoa-thuan/:id/terminate', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    uploadHtqtThoaThuanTermination.single('termination_file')(req, res, (err) => {
      if (err) return res.status(400).json({ message: 'Upload termination file failed' });
      const termRaw = String((req.body && req.body.terminated_at) || '').trim();
      if (!/^(\d{4})-(\d{2})-(\d{2})$/.test(termRaw)) {
        return res.status(400).json({ message: 'Vui lòng nhập ngày kết thúc (YYYY-MM-DD).' });
      }
      let prev;
      try {
        prev = db.prepare(
          'SELECT id, termination_scan_path, termination_scan_name, termination_uploaded_at FROM cooperation_thoa_thuan WHERE id = ?'
        ).get(id);
      } catch (e) {
        return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
      }
      if (!prev) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
      const termPath = req.file ? path.join('uploads', 'htqt-thoa-thuan', req.file.filename).replace(/\\/g, '/') : null;
      const termName = req.file ? (req.file.originalname || req.file.filename) : null;
      const termUploaded = req.file ? new Date().toISOString() : null;
      const finalPath = termPath || prev.termination_scan_path || null;
      const finalName = termName || prev.termination_scan_name || null;
      const finalUploaded = termUploaded || (finalPath && prev.termination_uploaded_at) || (finalPath ? new Date().toISOString() : null);
      try {
        db.prepare(
          `UPDATE cooperation_thoa_thuan SET
            terminated_at = ?, het_han = ?, trang_thai = 'het_han',
            termination_scan_path = ?, termination_scan_name = ?, termination_uploaded_at = ?,
            expiry_alert_sent_at = NULL, post_expiry_alert_count = 0, last_post_expiry_alert_at = NULL,
            updated_at = datetime('now','localtime')
           WHERE id = ?`
        ).run(termRaw, termRaw, finalPath, finalName, finalUploaded, id);
        const row = db.prepare(
          `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
                  no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
           FROM cooperation_thoa_thuan WHERE id = ?`
        ).get(id);
        return res.json({ ok: true, message: 'Đã ghi nhận kết thúc thỏa thuận.', item: row });
      } catch (e) {
        return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
      }
    });
  });

  // P.KHCN / Admin: replace main agreement scan (PDF/DOCX/image)
  router.post('/cooperation/thoa-thuan/:id/agreement-scan', authMiddleware, coopPhongOrAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    let exists;
    try {
      exists = db.prepare('SELECT id FROM cooperation_thoa_thuan WHERE id = ?').get(id);
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
    }
    if (!exists) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
    uploadHtqtThoaThuanScan.single('scan_file')(req, res, (err) => {
      if (err) return res.status(400).json({ message: 'Upload failed' });
      if (!req.file) return res.status(400).json({ message: 'Chọn file bản scan.' });
      const scanPath = path.join('uploads', 'htqt-thoa-thuan', req.file.filename).replace(/\\/g, '/');
      const scanName = req.file.originalname || req.file.filename;
      try {
        db.prepare(
          `UPDATE cooperation_thoa_thuan SET scan_file_path = ?, scan_file_name = ?, scan_uploaded_at = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(scanPath, scanName, new Date().toISOString(), id);
        const row = db.prepare(
          `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
                  no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
           FROM cooperation_thoa_thuan WHERE id = ?`
        ).get(id);
        return res.json({ ok: true, message: 'Đã cập nhật bản scan.', item: row });
      } catch (e) {
        return res.status(500).json({ message: 'Lỗi: ' + (e.message || '') });
      }
    });
  });

  return router;
};
