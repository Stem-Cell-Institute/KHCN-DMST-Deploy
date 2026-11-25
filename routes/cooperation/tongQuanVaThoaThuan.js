'use strict';

/**
 * Hợp tác quốc tế — Tổng quan, Đối tác & Đọc/tải scan Thỏa thuận (6 endpoint).
 *
 *   GET /api/cooperation/overview
 *   GET /api/cooperation/doi-tac
 *   GET /api/cooperation/thoa-thuan
 *   GET /api/cooperation/thoa-thuan/:id
 *   GET /api/cooperation/thoa-thuan/:id/scan
 *   GET /api/cooperation/thoa-thuan/:id/termination-scan
 *
 * Tách khỏi server.js (Đợt 5.6 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');
const path = require('path');

function parseDownloadFlag(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

module.exports = function createCoopTongQuanVaThoaThuanRouter({
  db,
  authMiddleware,
  cooperationComputePartnerStats,
  normalizeAndCheckDownloadPath,
}) {
  const router = express.Router();

  function sendCooperationScanFile(res, storedPath, originalName, forceDownload) {
    const checked = normalizeAndCheckDownloadPath(storedPath);
    if (checked.err === 403) return res.status(403).send('Truy cập bị từ chối');
    if (checked.err) return res.status(404).send('File không tồn tại');

    const displayName = String(originalName || path.basename(checked.norm) || 'scan.pdf').trim() || 'scan.pdf';
    const fallbackName = displayName.replace(/["\\\r\n]/g, '_');
    const encodedName = encodeURIComponent(displayName);
    const disposition = forceDownload ? 'attachment' : 'inline';

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
    );
    return res.sendFile(checked.norm);
  }

  // Tổng quan Hợp tác Quốc tế — số liệu thật cho dashboard
  router.get('/cooperation/overview', (req, res) => {
    try {
      const thoaThuans = db.prepare('SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia FROM cooperation_thoa_thuan').all();
      const mouDeXuats = db.prepare('SELECT id, ten_doi_tac, quoc_gia, created_at FROM cooperation_mou_de_xuat').all();
      const doanRa = db.prepare('SELECT id, muc_dich, quoc_gia, thanh_vien, ngay_di, ngay_ve, status, created_at FROM cooperation_doan_ra').all();
      let missions = [];
      try {
        missions = db.prepare('SELECT id, code, title, status, end_date, approved_budget, cooperating_units FROM missions').all();
      } catch (e) {}
      const mouHieuLuc = (thoaThuans || []).filter(r => (r.trang_thai || '').toLowerCase() === 'hieu_luc').length;
      const mouSapHetHan = (thoaThuans || []).filter(r => (r.trang_thai || '').toLowerCase() === 'sap_het_han').length;
      const deXuatChoDuyet = (mouDeXuats || []).length + (doanRa || []).filter(r => ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung'].includes((r.status || '').toLowerCase())).length;
      const deTaiDangChay = (missions || []).filter(m => ['ongoing', 'approved', 'implementation'].includes((m.status || '').toLowerCase())).length;
      const deTaiChoDuyet = (missions || []).filter(m => ['planning', 'submitted'].includes((m.status || '').toLowerCase())).length;
      let tongKinhPhi = 0;
      try {
        const r = db.prepare('SELECT COALESCE(SUM(approved_budget), 0) AS s FROM missions WHERE approved_budget IS NOT NULL AND approved_budget > 0').get();
        tongKinhPhi = (r && r.s) ? r.s : 0;
      } catch (e) {}
      const partnerMap = new Map();
      for (const r of thoaThuans || []) {
        const k = (r.doi_tac || '').trim().toLowerCase();
        if (k) partnerMap.set(k, true);
      }
      for (const r of mouDeXuats || []) {
        const k = (r.ten_doi_tac || '').trim().toLowerCase();
        if (k) partnerMap.set(k, true);
      }
      const countries = new Set();
      for (const r of thoaThuans || []) { if (r.quoc_gia) countries.add((r.quoc_gia || '').trim()); }
      for (const r of mouDeXuats || []) { if (r.quoc_gia) countries.add((r.quoc_gia || '').trim()); }
      const pendingItems = [];
      for (const r of (thoaThuans || []).filter(x => (x.trang_thai || '').toLowerCase() === 'sap_het_han')) {
        pendingItems.push({
          type: 'mou',
          typeLabel: 'MOU',
          title: r.ten || (r.doi_tac + ' sắp hết hạn'),
          deadline: r.het_han || '—',
          status: 'sap_het_han',
          statusLabel: 'Sắp hết hạn',
          action: 'thoathuan'
        });
      }
      for (const r of (doanRa || []).filter(x => ['cho_phong_duyet', 'cho_vt_duyet', 'yeu_cau_bo_sung'].includes((x.status || '').toLowerCase()))) {
        const soTV = (r.thanh_vien || '').split(/\n/).filter(s => s.trim()).length || 1;
        const st = (r.status || '').toLowerCase();
        const stLabel = st === 'cho_vt_duyet' ? 'Chờ Viện trưởng' : st === 'cho_phong_duyet' ? 'Chờ Phòng KHCN' : 'Yêu cầu bổ sung';
        pendingItems.push({
          type: 'doan_ra',
          typeLabel: 'Đoàn ra',
          title: (r.muc_dich || r.quoc_gia || 'Đoàn ra') + ' — ' + soTV + ' thành viên',
          deadline: r.ngay_di || '—',
          status: st || 'cho_phong_duyet',
          statusLabel: stLabel,
          action: 'doan-ra',
          source: 'doan_ra',
          id: r.id
        });
      }
      for (const r of mouDeXuats || []) {
        pendingItems.push({
          type: 'mou_de_xuat',
          typeLabel: 'Đề xuất MOU',
          title: 'MOU với ' + (r.ten_doi_tac || '—'),
          deadline: '—',
          status: 'dang_tham_dinh',
          statusLabel: 'Đang thẩm định',
          action: 'thoathuan',
          source: 'mou',
          id: r.id
        });
      }
      try {
        const htqtRows = db.prepare('SELECT id, ten, chu_nhiem_ten, status, han_xu_ly_vt FROM htqt_de_xuat WHERE lower(trim(status)) IN (\'cho_vt_phe_duyet\',\'cho_vt_duyet\')').all();
        for (const r of htqtRows || []) {
          pendingItems.push({
            type: 'de_tai_yttn',
            typeLabel: 'Đề xuất YTNN',
            title: (r.ten || '—') + (r.chu_nhiem_ten ? ' — ' + r.chu_nhiem_ten : ''),
            deadline: r.han_xu_ly_vt || '—',
            status: r.status || 'cho_vt_duyet',
            statusLabel: 'Chờ phê duyệt',
            action: 'de-xuat-cho-duyet',
            source: 'htqt',
            id: r.id
          });
        }
      } catch (e) {}
      pendingItems.sort((a, b) => {
        if (a.deadline === '—' && b.deadline === '—') return 0;
        if (a.deadline === '—') return 1;
        if (b.deadline === '—') return -1;
        return String(a.deadline).localeCompare(String(b.deadline));
      });
      const formatTongKinhPhi = (v) => {
        if (v >= 1e9) return (v / 1e9).toFixed(1) + ' tỷ';
        if (v >= 1e6) return (v / 1e6).toFixed(0) + ' triệu';
        return v ? String(Math.round(v)) : '—';
      };
      return res.json({
        stats: {
          total_doi_tac: partnerMap.size,
          mou_hieu_luc: mouHieuLuc,
          mou_sap_het_han: mouSapHetHan,
          de_tai_dang_chay: deTaiDangChay,
          de_tai_cho_duyet: deTaiChoDuyet,
          de_xuat_cho_duyet: deXuatChoDuyet,
          tong_kinh_phi: tongKinhPhi,
          tong_kinh_phi_formatted: formatTongKinhPhi(tongKinhPhi),
          so_quoc_gia: countries.size
        },
        pending_items: pendingItems.slice(0, 10)
      });
    } catch (e) {
      console.error('[API] cooperation/overview error:', e.message);
      return res.json({
        stats: { total_doi_tac: 0, mou_hieu_luc: 0, mou_sap_het_han: 0, de_tai_dang_chay: 0, de_tai_cho_duyet: 0, de_xuat_cho_duyet: 0, tong_kinh_phi: 0, tong_kinh_phi_formatted: '—', so_quoc_gia: 0 },
        pending_items: []
      });
    }
  });

  // Danh sách Đối tác Quốc tế — tổng hợp từ thỏa thuận, đề xuất MOU, dự án (missions)
  router.get('/cooperation/doi-tac', (req, res) => {
    try {
      const { partners, stats, total } = cooperationComputePartnerStats();
      return res.json({ partners, stats, total });
    } catch (e) {
      console.error('[API] cooperation/doi-tac error:', e.message);
      return res.json({ partners: [], stats: { quoc_te: 0, trong_nuoc: 0, doanh_nghiep: 0, dia_phuong: 0, so_quoc_gia: 0 }, total: 0 });
    }
  });

  // Danh sách Thỏa thuận (MOU, MOA, HĐ KH&CN, LOI)
  router.get('/cooperation/thoa-thuan', (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at,
                no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
         FROM cooperation_thoa_thuan ORDER BY trang_thai ASC, het_han ASC, id DESC`
      ).all();
      return res.json({ list: rows || [] });
    } catch (e) {
      return res.json({ list: [] });
    }
  });

  router.get('/cooperation/thoa-thuan/:id', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    try {
      const row = db.prepare(
        `SELECT id, ten, doi_tac, loai, het_han, trang_thai, quoc_gia, loai_doi_tac, scan_file_path, scan_file_name, scan_uploaded_at, created_at, updated_at,
                no_fixed_term, staff_notes, terminated_at, termination_scan_path, termination_scan_name, termination_uploaded_at
         FROM cooperation_thoa_thuan WHERE id = ?`
      ).get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
      return res.json({ ok: true, item: row });
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + e.message });
    }
  });

  // Xem / tải bản scan thỏa thuận qua API có auth (không mở trực tiếp /uploads/*)
  router.get('/cooperation/thoa-thuan/:id/scan', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    try {
      const row = db.prepare('SELECT scan_file_path, scan_file_name FROM cooperation_thoa_thuan WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
      return sendCooperationScanFile(res, row.scan_file_path, row.scan_file_name, parseDownloadFlag(req.query.download));
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + e.message });
    }
  });

  // Xem / tải văn bản kết thúc thỏa thuận qua API có auth
  router.get('/cooperation/thoa-thuan/:id/termination-scan', authMiddleware, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ message: 'ID không hợp lệ.' });
    try {
      const row = db
        .prepare('SELECT termination_scan_path, termination_scan_name FROM cooperation_thoa_thuan WHERE id = ?')
        .get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy thỏa thuận.' });
      return sendCooperationScanFile(
        res,
        row.termination_scan_path,
        row.termination_scan_name,
        parseDownloadFlag(req.query.download)
      );
    } catch (e) {
      return res.status(500).json({ message: 'Lỗi: ' + e.message });
    }
  });

  return router;
};
