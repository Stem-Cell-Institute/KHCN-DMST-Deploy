'use strict';

/**
 * Hợp tác quốc tế — Danh sách chờ xử lý & Chi tiết đề xuất (4 endpoint).
 *
 *   GET /api/cooperation/cho-phong-xu-ly
 *   GET /api/cooperation/cho-vt-duyet
 *   GET /api/cooperation/tat-ca-de-xuat
 *   GET /api/cooperation/chi-tiet/:loai/:id
 *
 * Tách khỏi server.js (Đợt 5.8b của readme/KE-HOACH-REFACTOR.md), giữ NGUYÊN hành vi.
 * Lưới an toàn: tests/cooperationHtqtEvents.test.js.
 */

const express = require('express');
const fs = require('fs');

module.exports = function createCoopDanhSachVaChiTietRouter({
  db,
  authMiddleware,
  coopPhongOrAdmin,
  coopVTOrAdmin,
  coopIsManager,
  coopGenMa,
  coopBuildTitle,
  STATUS_LABELS_COOP,
  coopEnsureFreshDoanRaVanBan,
  coopEnsureFreshDoanVaoVanBan,
  coopEnsureFreshMouVanBan,
  coopEnsureFreshYtnnVanBan,
  DOAN_RA_TO_TRINH_TEMPLATE_PATH,
  DOAN_VAO_TO_TRINH_TEMPLATE_PATH,
  MOU_TO_TRINH_TEMPLATE_PATH,
  YTNN_TO_TRINH_TEMPLATE_PATH,
}) {
  const router = express.Router();

  // ROUTE MỚI — CHỜ PHÒNG KHCN XỬ LÝ
  router.get('/cooperation/cho-phong-xu-ly', authMiddleware, coopPhongOrAdmin, (req, res) => {
    try {
      const list = [];
      const tables = [
        { table: 'cooperation_doan_ra', loai: 'doan_ra', statuses: ['cho_phong_duyet'] },
        { table: 'cooperation_doan_vao', loai: 'doan_vao', statuses: ['cho_phong_duyet', 'cho_tham_dinh'] },
        { table: 'cooperation_mou_de_xuat', loai: 'mou', statuses: ['cho_phong_duyet', 'dang_tham_dinh'] },
        { table: 'htqt_de_xuat', loai: 'ytnn', statuses: ['cho_phan_loai', 'cho_phong_duyet', 'dang_tham_dinh'] },
      ];
      for (const { table, loai, statuses } of tables) {
        try {
          const ph = statuses.map(() => '?').join(',');
          const rows = db.prepare(`SELECT * FROM ${table} WHERE status IN (${ph}) ORDER BY created_at ASC`).all(...statuses);
          rows.forEach(r => {
            const ma = r.ma_de_xuat || coopGenMa(loai, r.id);
            const st = r.status || '';
            list.push({
              loai, id: r.id, ma_de_xuat: ma,
              title: coopBuildTitle(loai, r),
              status: st, status_label: STATUS_LABELS_COOP[st] || st,
              submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
              submitted_by_email: r.submitted_by_email,
              created_at: (r.created_at || '').slice(0, 10),
              note_phong: r.note_phong || null,
            });
          });
        } catch (e) {}
      }
      try {
        const hnRows = db
          .prepare(
            `SELECT r.*, u.fullname AS uname, u.email AS uemail FROM conference_registrations r
             JOIN users u ON u.id = r.submitted_by_user_id
             WHERE r.status IN ('submitted','khcn_reviewing') ORDER BY r.created_at ASC`
          )
          .all();
        for (const r of hnRows || []) {
          list.push({
            loai: 'hnht',
            id: r.id,
            ma_de_xuat: r.submission_code || '',
            title: 'Đăng ký HN/HT — ' + (r.conf_name || '—'),
            status: r.status,
            status_label:
              r.status === 'khcn_reviewing' ? 'Phòng đang xem xét' : 'Chờ Phòng KHCN',
            submitted_by_name: r.uname || r.uemail || '—',
            submitted_by_email: r.uemail,
            created_at: (r.created_at || '').slice(0, 10),
            note_phong: r.khcn_comment || null,
          });
        }
      } catch (eh) {}
      list.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      return res.json({ list, tong: list.length });
    } catch (e) { return res.json({ list: [], tong: 0 }); }
  });

  // ROUTE MỚI — CHỜ VIỆN TRƯỞNG DUYỆT
  router.get('/cooperation/cho-vt-duyet', authMiddleware, coopVTOrAdmin, (req, res) => {
    try {
      const list = [];
      const tables = [
        { table: 'cooperation_doan_ra', loai: 'doan_ra', status: 'cho_vt_duyet' },
        { table: 'cooperation_doan_vao', loai: 'doan_vao', status: 'cho_vt_duyet' },
        { table: 'cooperation_mou_de_xuat', loai: 'mou', status: 'cho_vt_duyet' },
        { table: 'htqt_de_xuat', loai: 'ytnn', status: 'cho_vt_duyet' },
      ];
      for (const { table, loai, status } of tables) {
        try {
          const rows = table === 'htqt_de_xuat'
            ? db.prepare(`SELECT * FROM htqt_de_xuat WHERE status IN ('cho_vt_duyet','cho_vt_phe_duyet') ORDER BY created_at ASC`).all()
            : db.prepare(`SELECT * FROM ${table} WHERE status=? ORDER BY created_at ASC`).all(status);
          rows
            .forEach(r => list.push({
              loai, id: r.id, ma_de_xuat: r.ma_de_xuat || coopGenMa(loai, r.id),
              title: coopBuildTitle(loai, r), status: r.status,
              status_label: STATUS_LABELS_COOP[r.status] || r.status,
              submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
              submitted_by_email: r.submitted_by_email,
              created_at: (r.created_at || '').slice(0, 10),
              note_phong: r.note_phong || null,
            }));
        } catch (e) {}
      }
      try {
        const hnRows = db
          .prepare(
            `SELECT r.*, u.fullname AS uname, u.email AS uemail FROM conference_registrations r
             JOIN users u ON u.id = r.submitted_by_user_id
             WHERE r.status IN ('khcn_approved','director_reviewing') ORDER BY r.created_at ASC`
          )
          .all();
        for (const r of hnRows || []) {
          list.push({
            loai: 'hnht',
            id: r.id,
            ma_de_xuat: r.submission_code || '',
            title: 'Đăng ký HN/HT — ' + (r.conf_name || '—'),
            status: r.status,
            status_label: r.status === 'director_reviewing' ? 'Viện trưởng đang xem xét' : 'Chờ Viện trưởng',
            submitted_by_name: r.uname || r.uemail || '—',
            submitted_by_email: r.uemail,
            created_at: (r.created_at || '').slice(0, 10),
            note_phong: r.khcn_comment || null,
          });
        }
      } catch (eh) {}
      list.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      return res.json({ list, tong: list.length });
    } catch (e) { return res.json({ list: [], tong: 0 }); }
  });

  // ROUTE MỚI — TẤT CẢ ĐỀ XUẤT (manager)
  router.get('/cooperation/tat-ca-de-xuat', authMiddleware, (req, res) => {
    if (!coopIsManager(req)) return res.status(403).json({ message: 'Không có quyền.' });
    const { loai, status } = req.query;
    const list = [];
    const tables = [
      { table: 'cooperation_doan_ra', loai_key: 'doan_ra' },
      { table: 'cooperation_doan_vao', loai_key: 'doan_vao' },
      { table: 'cooperation_mou_de_xuat', loai_key: 'mou' },
      { table: 'htqt_de_xuat', loai_key: 'ytnn' },
    ].filter(t => !loai || t.loai_key === loai);
    for (const { table, loai_key } of tables) {
      try {
        let sql = `SELECT * FROM ${table}`;
        const params = [];
        // `status` nhận 1 giá trị hoặc danh sách ngăn bằng dấu phẩy — các ô trên
        // Dashboard gộp nhiều trạng thái (vd "Đang xử lý") nên cần lọc theo nhóm.
        const statusList = String(status || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (statusList.length) {
          sql += ` WHERE status IN (${statusList.map(() => '?').join(',')})`;
          params.push(...statusList);
        }
        sql += ' ORDER BY created_at DESC';
        db.prepare(sql).all(...params).forEach(r => list.push({
          loai: loai_key, id: r.id, ma_de_xuat: r.ma_de_xuat || coopGenMa(loai_key, r.id),
          title: coopBuildTitle(loai_key, r), status: r.status,
          status_label: STATUS_LABELS_COOP[r.status] || r.status,
          submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
          submitted_by_email: r.submitted_by_email,
          created_at: (r.created_at || '').slice(0, 10),
        }));
      } catch (e) {}
    }
    if (!loai || loai === 'hnht') {
      try {
        let sql = `SELECT r.*, u.fullname AS submitted_by_name, u.email AS submitted_by_email
          FROM conference_registrations r JOIN users u ON u.id = r.submitted_by_user_id WHERE r.status != 'cancelled'`;
        const params = [];
        if (status) {
          sql += ' AND r.status = ?';
          params.push(status);
        }
        sql += ' ORDER BY r.created_at DESC';
        db.prepare(sql).all(...params).forEach((r) =>
          list.push({
            loai: 'hnht',
            id: r.id,
            ma_de_xuat: r.submission_code || '',
            title: 'Đăng ký HN/HT — ' + (r.conf_name || '—'),
            status: r.status,
            status_label: r.status,
            submitted_by_name: r.submitted_by_name || r.submitted_by_email || '—',
            submitted_by_email: r.submitted_by_email,
            created_at: (r.created_at || '').slice(0, 10),
          })
        );
      } catch (eh) {}
    }
    list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    return res.json({ list: list.slice(offset, offset + limit), tong: list.length, page });
  });

  // ROUTE MỚI — CHI TIẾT + LỊCH SỬ
  router.get('/cooperation/chi-tiet/:loai/:id', authMiddleware, (req, res) => {
    const loai = req.params.loai;
    const id = parseInt(req.params.id, 10);
    const userEmail = (req.user.email || '').trim().toLowerCase();
    const isManager = coopIsManager(req);
    const tableMap = { doan_ra: 'cooperation_doan_ra', doan_vao: 'cooperation_doan_vao', mou: 'cooperation_mou_de_xuat', ytnn: 'htqt_de_xuat' };
    const table = tableMap[loai];
    if (!table || !id) return res.status(400).json({ message: 'Loại hoặc ID không hợp lệ.' });
    try {
      let r = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      if (!r) return res.status(404).json({ message: 'Không tìm thấy đề xuất.' });
      if (!isManager && (r.submitted_by_email || '').trim().toLowerCase() !== userEmail) {
        return res.status(403).json({ message: 'Bạn không có quyền xem đề xuất này.' });
      }
      const ensureFns = {
        doan_ra: coopEnsureFreshDoanRaVanBan,
        doan_vao: coopEnsureFreshDoanVaoVanBan,
        mou: coopEnsureFreshMouVanBan,
        ytnn: coopEnsureFreshYtnnVanBan,
      };
      const templatePaths = {
        doan_ra: DOAN_RA_TO_TRINH_TEMPLATE_PATH,
        doan_vao: DOAN_VAO_TO_TRINH_TEMPLATE_PATH,
        mou: MOU_TO_TRINH_TEMPLATE_PATH,
        ytnn: YTNN_TO_TRINH_TEMPLATE_PATH,
      };
      if (r && (r.status || '').toLowerCase() === 'da_duyet') {
        try {
          const nr = ensureFns[loai](id);
          if (nr) r = nr;
        } catch (e) {}
      }
      const history = (() => { try { return db.prepare("SELECT * FROM coop_history WHERE loai=? AND de_xuat_id=? ORDER BY performed_at ASC").all(loai, id); } catch (e) { return []; } })();
      const dataOut = Object.assign({}, r);
      delete dataOut.van_ban_word_path;
      dataOut.has_van_ban_word = !!(r.van_ban_word_path);
      dataOut.van_ban_word_original_name = r.van_ban_word_original_name || null;
      dataOut.van_ban_word_uploaded_at = r.van_ban_word_uploaded_at || null;
      try {
        dataOut.has_to_trinh_template = fs.existsSync(templatePaths[loai]);
      } catch (e) {
        dataOut.has_to_trinh_template = false;
      }
      return res.json({ data: dataOut, loai, status_label: STATUS_LABELS_COOP[r.status] || r.status, history, is_manager: isManager });
    } catch (e) { return res.status(500).json({ message: 'Lỗi: ' + e.message }); }
  });

  return router;
};
