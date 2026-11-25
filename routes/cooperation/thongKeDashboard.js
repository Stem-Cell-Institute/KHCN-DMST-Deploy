'use strict';

/**
 * Hợp tác quốc tế — Badge sidebar & Thống kê Dashboard (2 endpoint).
 *
 *   GET /api/cooperation/sidebar-badges
 *   GET /api/cooperation/dashboard-stats
 *
 * Tách khỏi server.js (Đợt 5.8a của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');

module.exports = function createCoopThongKeDashboardRouter({
  db,
  authMiddleware,
  roleIsAny,
  coopIsVienTruong,
  coopDashboardViewer,
  cooperationComputePartnerStats,
  coopDashMergeStatusBuckets,
  coopDashSeries12m,
}) {
  const router = express.Router();

  // Badge sidebar — mọi user đăng nhập (không lộ thống kê hệ thống)
  router.get('/cooperation/sidebar-badges', authMiddleware, (req, res) => {
    try {
      const role = (req.user.role || '').toLowerCase();
      const email = (req.user.email || '').trim().toLowerCase();
      const isManager = role === 'admin' || roleIsAny(req, ['phong_khcn']) || coopIsVienTruong(email);

      const safeCount = (sql, ...params) => {
        try { return (db.prepare(sql).get(...params) || {}).c || 0; } catch (e) { return 0; }
      };

      let my_doan_ra = 0;
      let my_doan_vao = 0;
      let my_mou = 0;
      let my_ytnn = 0;
      let my_hnht = 0;
      if (email) {
        my_doan_ra = safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE lower(trim(submitted_by_email))=?", email);
        my_doan_vao = safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE lower(trim(submitted_by_email))=?", email);
        my_mou = safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE lower(trim(submitted_by_email))=?", email);
        my_ytnn = safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE lower(trim(submitted_by_email))=?", email);
      }
      try {
        const uid = email ? db.prepare('SELECT id FROM users WHERE lower(trim(email)) = ?').get(email) : null;
        if (uid && uid.id != null) {
          my_hnht = safeCount(
            "SELECT COUNT(*) AS c FROM conference_registrations WHERE submitted_by_user_id = ? AND status != 'cancelled'",
            uid.id
          );
        }
      } catch (_) {}
      const de_xuat_cua_toi = my_doan_ra + my_doan_vao + my_mou + my_ytnn + my_hnht;

      let cho_phong = 0;
      let cho_vt = 0;
      let tat_ca_tong = 0;
      if (isManager) {
        cho_phong =
          safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status IN ('cho_phong_duyet')")
          + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status IN ('cho_phong_duyet','cho_tham_dinh')")
          + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status IN ('cho_phong_duyet','dang_tham_dinh')")
          + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_phong_duyet','cho_phan_loai','dang_tham_dinh')")
          + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')");
        cho_vt =
          safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status='cho_vt_duyet'")
          + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status='cho_vt_duyet'")
          + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status='cho_vt_duyet'")
          + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_vt_duyet','cho_vt_phe_duyet')")
          + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('khcn_approved','director_reviewing')");
        tat_ca_tong =
          safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra")
          + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao")
          + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat")
          + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat")
          + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status != 'cancelled'");
      }

      let hnht_cho_phong = 0;
      let hnht_sap_dien_ra = 0;
      let hnht_minh_chung_qua_han = 0;
      if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) {
        hnht_cho_phong = safeCount(
          "SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')"
        );
        hnht_sap_dien_ra = safeCount(
          `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
           AND julianday(conf_start_date) >= julianday('now')
           AND julianday(conf_start_date) <= julianday('now','+30 days')`
        );
        hnht_minh_chung_qua_han = safeCount(
          `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
           AND julianday('now') - julianday(conf_end_date) > 15`
        );
      }

      let doi_tac_tong = 0;
      let thoa_thuan_tong = 0;
      if (role === 'admin' || roleIsAny(req, ['phong_khcn'])) {
        thoa_thuan_tong = safeCount('SELECT COUNT(*) AS c FROM cooperation_thoa_thuan');
        try {
          doi_tac_tong = cooperationComputePartnerStats().total || 0;
        } catch (_) {
          doi_tac_tong = 0;
        }
      }

      return res.json({
        de_xuat_cua_toi,
        my_doan_ra,
        my_doan_vao,
        my_mou,
        my_ytnn,
        my_hnht,
        cho_phong_duyet: cho_phong,
        cho_vt_duyet: cho_vt,
        tat_ca_tong,
        su_kien_tong: safeCount("SELECT COUNT(*) AS c FROM cooperation_su_kien"),
        hnht_cho_phong,
        hnht_sap_dien_ra,
        hnht_minh_chung_qua_han,
        doi_tac_tong,
        thoa_thuan_tong,
      });
    } catch (e) {
      return res.json({
        de_xuat_cua_toi: 0,
        my_doan_ra: 0,
        my_doan_vao: 0,
        my_mou: 0,
        my_ytnn: 0,
        my_hnht: 0,
        cho_phong_duyet: 0,
        cho_vt_duyet: 0,
        tat_ca_tong: 0,
        su_kien_tong: 0,
        hnht_cho_phong: 0,
        hnht_sap_dien_ra: 0,
        hnht_minh_chung_qua_han: 0,
        doi_tac_tong: 0,
        thoa_thuan_tong: 0,
      });
    }
  });

  // ROUTE MỚI — DASHBOARD STATS (giám sát toàn hệ thống — chỉ lãnh đạo / P.KHCN)
  router.get('/cooperation/dashboard-stats', authMiddleware, coopDashboardViewer, (req, res) => {
    try {
      const role = (req.user.role || '').toLowerCase();
      const email = (req.user.email || '').trim().toLowerCase();

      const safeCount = (sql, ...params) => {
        try { return (db.prepare(sql).get(...params) || {}).c || 0; } catch (e) { return 0; }
      };

      const cho_phong =
        safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status IN ('cho_phong_duyet')")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status IN ('cho_phong_duyet','cho_tham_dinh')")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status IN ('cho_phong_duyet','dang_tham_dinh')")
        + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_phong_duyet','cho_phan_loai','dang_tham_dinh')")
        + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')");

      const cho_vt =
        safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra WHERE status='cho_vt_duyet'")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao WHERE status='cho_vt_duyet'")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat WHERE status='cho_vt_duyet'")
        + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat WHERE status IN ('cho_vt_duyet','cho_vt_phe_duyet')")
        + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('khcn_approved','director_reviewing')");

      const tat_ca_tong =
        safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_ra")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_doan_vao")
        + safeCount("SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat")
        + safeCount("SELECT COUNT(*) AS c FROM htqt_de_xuat")
        + safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status != 'cancelled'");

      const by_loai = {
        doan_ra: safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_ra'),
        doan_vao: safeCount('SELECT COUNT(*) AS c FROM cooperation_doan_vao'),
        mou: safeCount('SELECT COUNT(*) AS c FROM cooperation_mou_de_xuat'),
        ytnn: safeCount('SELECT COUNT(*) AS c FROM htqt_de_xuat'),
        hnht: safeCount("SELECT COUNT(*) AS c FROM conference_registrations WHERE status != 'cancelled'"),
      };

      const hnht_cho_phong = safeCount(
        "SELECT COUNT(*) AS c FROM conference_registrations WHERE status IN ('submitted','khcn_reviewing')"
      );
      const hnht_sap_dien_ra = safeCount(
        `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
         AND julianday(conf_start_date) >= julianday('now')
         AND julianday(conf_start_date) <= julianday('now', '+30 days')`
      );
      const hnht_minh_chung_qua_han = safeCount(
        `SELECT COUNT(*) AS c FROM conference_registrations WHERE status = 'director_approved'
         AND julianday('now') - julianday(conf_end_date) > 15`
      );
      const by_status = coopDashMergeStatusBuckets(null);
      const series_12m = coopDashSeries12m(null);

      return res.json({
        cho_phong_duyet: cho_phong,
        cho_vt_duyet: cho_vt,
        tat_ca_tong,
        su_kien_sap_dien_ra: safeCount("SELECT COUNT(*) AS c FROM cooperation_su_kien WHERE status='sap_dien_ra'"),
        mou_hieu_luc: safeCount("SELECT COUNT(*) AS c FROM cooperation_thoa_thuan WHERE trang_thai='hieu_luc'"),
        by_loai,
        by_status,
        series_12m,
        hnht_cho_phong,
        hnht_sap_dien_ra,
        hnht_minh_chung_qua_han,
        generated_at: new Date().toISOString(),
        is_phong_khcn: role === 'admin' || roleIsAny(req, ['phong_khcn']),
        is_vien_truong: role === 'admin' || coopIsVienTruong(email),
        is_admin: role === 'admin',
      });
    } catch (e) {
      return res.status(500).json({ message: 'Không tải được Dashboard.' });
    }
  });

  return router;
};
