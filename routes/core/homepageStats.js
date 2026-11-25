/**
 * Route tổng hợp số liệu trang chủ (/api/homepage-stats).
 *
 * Tách khỏi server.js (Đợt 7 của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 */

const jwt = require('jsonwebtoken');
const db = require('../../lib/db-bridge');

module.exports = function mountHomepageStatsRoute({
  JWT_SECRET,
  app,
  cooperationComputePartnerStats,
  getTokenFromReq,
  syncMissionsFromCapVien,
  userIdIsBanned,
}) {
  function dbCount(sql) {
    try {
      const row = db.prepare(sql).get();
      if (!row || row.c == null) return 0;
      const n = Number(row.c);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    } catch (e) {
      return 0;
    }
  }

  app.get('/api/homepage-stats', (req, res) => {
    syncMissionsFromCapVien();
    const capVienMod = require('../../modules/de-tai-cap-vien/eofficeMount');
    /** Thẻ module «Nhiệm vụ KHCN» — cùng quy tắc với /api/missions/stats (bao gồm đề tài cấp Viện từ module riêng) */
    let missions = 0;
    const missionMini = { inProgress: 0, completed: 0, overdue: 0 };
    try {
      const mRows = capVienMod.mergeCapVienModuleMissions(db.prepare('SELECT code, status, end_date FROM missions').all());
      missions = mRows.length;
      const now = new Date().toISOString().slice(0, 10);
      for (const m of mRows || []) {
        const st = (m.status || 'planning').toLowerCase();
        const isCompleted = st === 'completed' || st === 'hoan_thanh' || st === 'thanh_ly_hop_dong';
        const isCancelled = st === 'khong_duoc_phe_duyet' || st === 'dung_khong_dat_dot';
        const ed = m.end_date ? String(m.end_date).slice(0, 10) : '';
        const isPastEnd = ed && ed < now;
        if (isCompleted) missionMini.completed += 1;
        else if (isCancelled) { /* không tính quá hạn / đang thực hiện */ }
        else if (isPastEnd) missionMini.overdue += 1;
        else missionMini.inProgress += 1;
      }
    } catch (e) {
      missions = dbCount('SELECT COUNT(*) as c FROM missions');
    }
    /**
     * Nhân lực KHCN: đếm bảng `personnel` chỉ khi module được bật trên trang chủ.
     * Module chưa triển khai (enabled = 0) → null để tránh hiển thị 0 gây hiểu nhầm.
     */
    let personnel = null;
    try {
      const hm = db
        .prepare('SELECT COALESCE(enabled, 0) AS en FROM homepage_modules WHERE code = ?')
        .get('personnel');
      if (hm && Number(hm.en) === 1) {
        personnel = dbCount('SELECT COUNT(*) as c FROM personnel');
      }
    } catch (e) {
      personnel = null;
    }
    /**
     * Tài sản trí tuệ: số thực từ công bố loại "Bằng sáng chế / GPHI" (publications.pub_type = 'patent'),
     * cùng nguồn dữ liệu với module Công bố khoa học — chỉ khi module «ip» được bật; tắt → null (không hiển thị 0).
     */
    let ip = null;
    try {
      const hmIp = db
        .prepare('SELECT COALESCE(enabled, 0) AS en FROM homepage_modules WHERE code = ?')
        .get('ip');
      if (hmIp && Number(hmIp.en) === 1) {
        ip = dbCount(
          "SELECT COUNT(*) as c FROM publications WHERE COALESCE(status, '') != 'retracted' AND pub_type = 'patent'"
        );
      }
    } catch (e) {
      ip = null;
    }
    const publications = dbCount(
      "SELECT COUNT(*) as c FROM publications WHERE COALESCE(status, '') != 'retracted'"
    );
    /** Thẻ module «Công bố KHCN» — đồng bộ logic lọc với module (không tính retracted) */
    const publicationMini = {
      indexedScopusWos: dbCount(
        `SELECT COUNT(*) as c FROM publications
       WHERE COALESCE(status, '') != 'retracted'
       AND (
         LOWER(COALESCE(index_db, '')) LIKE '%scopus%'
         OR LOWER(COALESCE(index_db, '')) LIKE '%web of science%'
         OR LOWER(COALESCE(index_db, '')) LIKE '%wos%'
       )`
      ),
      conferences: dbCount(
        `SELECT COUNT(*) as c FROM publications
       WHERE COALESCE(status, '') != 'retracted' AND pub_type = 'conference'`
      ),
      books: dbCount(
        `SELECT COUNT(*) as c FROM publications
       WHERE COALESCE(status, '') != 'retracted' AND pub_type IN ('book_chapter', 'book')`
      ),
    };
    const cooperation =
      dbCount('SELECT COUNT(*) as c FROM cooperation_doan_ra') +
      dbCount('SELECT COUNT(*) as c FROM cooperation_doan_vao') +
      dbCount('SELECT COUNT(*) as c FROM cooperation_mou_de_xuat') +
      dbCount('SELECT COUNT(*) as c FROM htqt_de_xuat') +
      dbCount('SELECT COUNT(*) as c FROM cooperation_thoa_thuan') +
      dbCount('SELECT COUNT(*) as c FROM cooperation_su_kien');
    // CRD Lab Booking — truy vấn trực tiếp từ bảng CRD (đồng bộ với thẻ module trên trang chủ)
    const crdMachines = dbCount('SELECT COUNT(*) as c FROM crd_machines');
    /** Lịch còn hiệu lực: từ ngày hôm nay trở đi, không tính đã hủy */
    const crdActiveBookings = dbCount(
      `SELECT COUNT(*) as c FROM crd_bookings
     WHERE COALESCE(NULLIF(TRIM(status), ''), 'confirmed') != 'cancelled'
     AND date >= date('now')`
    );
    /** Người có hồ sơ CRD còn được đặt lịch (chưa gỡ quyền, chưa bị khoá) */
    const crdActivePersons = dbCount(
      `SELECT COUNT(*) as c FROM crd_persons
     WHERE COALESCE(crd_access_revoked, 0) = 0 AND COALESCE(is_banned, 0) = 0`
    );
    const facilities = {
      activeBookings: crdActiveBookings,
      machines: crdMachines,
      activeUsers: crdActivePersons,
    };
    /** Thẻ module «Hợp tác» — lấy số liệu trực tiếp từ dữ liệu module đối tác */
    let cooperationMini = { doi_tac: 0, trong_nuoc: 0, quoc_te: 0 };
    try {
      const { stats, total } = cooperationComputePartnerStats();
      cooperationMini = {
        doi_tac: total || 0,
        trong_nuoc: stats.trong_nuoc || 0,
        quoc_te: stats.quoc_te || 0,
      };
    } catch (e) {
      /* bảng hợp tác chưa có hoặc lỗi */
    }
    let dmsMini = { total: 0, active: 0, expiringSoon: 0, expired: 0 };
    try {
      const now = new Date().toISOString().slice(0, 10);
      const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      dmsMini.total = db.prepare('SELECT COUNT(*) AS c FROM dms_documents').get().c;
      dmsMini.active = db
        .prepare(`SELECT COUNT(*) AS c FROM dms_documents WHERE lower(status) = 'active'`)
        .get().c;
      dmsMini.expired = db
        .prepare(
          `SELECT COUNT(*) AS c FROM dms_documents WHERE lower(status) IN ('expired','revoked')`
        )
        .get().c;
      dmsMini.expiringSoon = db
        .prepare(
          `SELECT COUNT(*) AS c FROM dms_documents
         WHERE lower(status) = 'active' AND valid_until IS NOT NULL AND TRIM(valid_until) != ''
           AND date(valid_until) >= date(?) AND date(valid_until) <= date(?)`
        )
        .get(now, soon).c;
    } catch (e) {
      /* bảng DMS chưa có */
    }
    let equipmentMini = { profiles: 0, documents: 0, notifications: 0 };
    try {
      equipmentMini.profiles = db.prepare(`SELECT COUNT(*) AS c FROM equipments`).get().c;
      equipmentMini.documents = db
        .prepare(
          `SELECT COUNT(*) AS c
         FROM equipment_documents
         WHERE COALESCE(is_disabled, 0) = 0
           AND (is_current IS NULL OR is_current = 1)`
        )
        .get().c;
      let notifUserId = null;
      try {
        const tok = getTokenFromReq(req);
        if (tok) {
          const p = jwt.verify(tok, JWT_SECRET);
          if (p && p.id != null && !userIdIsBanned(p.id)) notifUserId = Number(p.id);
        }
      } catch (_) {
        notifUserId = null;
      }
      if (notifUserId != null) {
        equipmentMini.notifications = db
          .prepare(
            `SELECT COUNT(*) AS c
           FROM app_notifications
           WHERE user_id = ?
             AND module = 'equipment'
             AND event_type = 'equip_incident'
             AND read_at IS NULL`
          )
          .get(notifUserId).c;
      } else {
        equipmentMini.notifications = 0;
      }
    } catch (e) {
      /* bảng Equipment chưa có */
    }
    let documentWorkflowMini = { inProgress: 0, completed: 0, overdue: 0 };
    try {
      documentWorkflowMini.inProgress = db
        .prepare(
          `SELECT COUNT(*) AS c
         FROM documents
         WHERE deleted_at IS NULL
           AND status IN ('pending','in_progress')
           AND current_step BETWEEN 1 AND 8`
        )
        .get().c;
      documentWorkflowMini.completed = db
        .prepare(
          `SELECT COUNT(*) AS c
         FROM documents
         WHERE deleted_at IS NULL
           AND (status = 'archived' OR current_step >= 9)`
        )
        .get().c;
      documentWorkflowMini.overdue = db
        .prepare(
          `SELECT COUNT(*) AS c
         FROM documents
         WHERE deleted_at IS NULL
           AND assignment_deadline IS NOT NULL
           AND assignment_deadline < date('now')
           AND current_step BETWEEN 2 AND 7
           AND status IN ('pending', 'in_progress')`
        )
        .get().c;
    } catch (e) {
      /* bảng document workflow chưa có */
    }
    /** Thẻ module «Hội đồng đạo đức trên động vật» — đồng bộ trạng thái với /api/submissions (SCI-ACE) */
    let aceMini = { total: 0, inReview: 0, approved: 0 };
    try {
      aceMini.total = dbCount('SELECT COUNT(*) as c FROM submissions');
      aceMini.inReview = dbCount(
        "SELECT COUNT(*) as c FROM submissions WHERE COALESCE(status, 'SUBMITTED') IN ('SUBMITTED','VALIDATED','NEED_REVISION','UNDER_REVIEW','IN_MEETING','CONDITIONAL')"
      );
      aceMini.approved = dbCount(
        "SELECT COUNT(*) as c FROM submissions WHERE status IN ('APPROVED','IMPLEMENTATION','COMPLETED')"
      );
    } catch (e) {
      /* bảng submissions (SCI-ACE) chưa có */
    }
    const sampleStorageMini = require('../nganHangTeBaoKhangThe').miniStats(db);
    const capVienMini = require('../../modules/de-tai-cap-vien/eofficeMount').miniStats();
    return res.json({
      missions, missionMini, capVienMini, personnel, ip,
      publications, publicationMini, cooperation, cooperationMini,
      facilities, dmsMini, equipmentMini, sampleStorageMini, documentWorkflowMini, aceMini,
    });
  });
};
