/**
 * Xuất dữ liệu nhiệm vụ KHCN — /api/missions/export*, /api/missions/report-excel
 *
 * Tách khỏi server.js, giữ nguyên hành vi từng endpoint (đường dẫn, tham số,
 * header, thông báo lỗi). Bộ test khói tests/smoke.test.js phủ cả 4 endpoint này.
 *
 * LƯU Ý THỨ TỰ: router phải được mount TRƯỚC handler '/api/missions/:id' trong
 * server.js, nếu không 'export', 'report-excel'… sẽ bị bắt nhầm thành :id.
 */

const express = require('express');
const XLSX = require('xlsx');
const { buildMissionReportBuffer } = require('../services/missionReportBuilder');

const MISSION_CSV_HEADER = 'code,title,principal,level,status,start_date,end_date,progress,budget';
const MISSION_SELECT_BASIC =
  'SELECT code, title, principal, level, status, start_date, end_date, progress, budget FROM missions ORDER BY start_date DESC, id DESC';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function parseYear(v) {
  const n = parseInt(String(v || '').trim(), 10);
  return Number.isFinite(n) && n >= 1900 && n <= 2200 ? n : null;
}

function parseList(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {object} deps
 * @param {object}   deps.db
 * @param {Function} deps.authMiddleware
 * @param {Function} deps.adminOnly
 * @param {Function} deps.csvEscape
 * @param {Function} deps.syncMissionsFromCapVien
 * @param {Function} deps.insertUserActivityLog
 */
module.exports = function createMissionsExportRouter({
  db,
  authMiddleware,
  adminOnly,
  csvEscape,
  syncMissionsFromCapVien,
  insertUserActivityLog,
}) {
  const router = express.Router();
  const adminGuard = [authMiddleware, adminOnly];

  // Mẫu nhập liệu — chỉ phục vụ luồng Import của Admin nên khoá cùng mức /export.
  // Tải bằng thẻ <a href> nên không gửi được header Authorization; getTokenFromReq
  // đọc thêm cookie auth_token (đặt khi đăng nhập) nên link vẫn tải được.
  router.get('/missions/export-template', ...adminGuard, (req, res) => {
    const note =
      'GHI CHÚ (dòng này bỏ qua khi import): Mỗi dòng = 1 nhiệm vụ. Cấp: national|ministry|university|school|institute. Trạng thái: planning|cho_vien_xet_chon|cho_bo_tham_dinh|cho_ngoai_xet_chon|cho_phe_duyet_ngoai|da_phe_duyet|cho_ky_hop_dong|dang_thuc_hien|xin_dieu_chinh|cho_nghiem_thu_co_so|nghiem_thu_trung_gian|cho_nghiem_thu_bo_nn|nghiem_thu_tong_ket|hoan_thien_sau_nghiem_thu|thanh_ly_hop_dong|hoan_thanh|khong_duoc_phe_duyet. Ngày: YYYY-MM-DD';
    const sample1 =
      'DT-2025-001,Nghiên cứu ứng dụng tế bào gốc trong điều trị,TS. Nguyễn Văn A,institute,ongoing,2025-01-15,2027-12-31,35,500000000';
    const sample2 =
      'DT-2025-002,Phát triển công nghệ nuôi cấy tế bào gốc,PGS.TS. Trần Thị B,ministry,approved,2025-03-01,2026-12-31,0,2500000000';
    const sample3 =
      'DT-2024-010,Xây dựng ngân hàng tế bào gốc tiêu chuẩn GMP,TS. Lê Văn C,institute,review,2024-06-01,2025-05-31,90,1500000000';
    const csv =
      '﻿sep=,\n' + MISSION_CSV_HEADER + '\n' + csvEscape(note) + ',,,,,,,\n' + sample1 + '\n' + sample2 + '\n' + sample3 + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mau_nhap_lieu_nhiem_vu_khcn.csv"');
    return res.send(csv);
  });

  // Export số liệu từ dashboard (Admin)
  router.get('/missions/export', ...adminGuard, (req, res) => {
    syncMissionsFromCapVien();
    const rows = db.prepare(MISSION_SELECT_BASIC).all();
    const lines = [MISSION_CSV_HEADER].concat(
      rows.map((r) =>
        [
          csvEscape(r.code),
          csvEscape(r.title),
          csvEscape(r.principal),
          csvEscape(r.level),
          csvEscape(r.status),
          csvEscape(r.start_date),
          csvEscape(r.end_date),
          r.progress != null ? r.progress : '',
          r.budget != null ? r.budget : '',
        ].join(',')
      )
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="so_lieu_nhiem_vu_khcn_' + todayStamp() + '.csv"');
    return res.send('﻿sep=,\n' + lines.join('\n'));
  });

  // Export Excel (.xlsx) — hỗ trợ tiếng Việt đầy đủ (không bị vỡ font)
  router.get('/missions/export-excel', ...adminGuard, (req, res) => {
    try {
      syncMissionsFromCapVien();
      const rows = db.prepare(MISSION_SELECT_BASIC).all();
      const data = rows.map((r) => ({
        code: r.code || '',
        title: r.title || '',
        principal: r.principal || '',
        level: r.level || '',
        status: r.status || '',
        start_date: r.start_date || '',
        end_date: r.end_date || '',
        progress: r.progress != null ? r.progress : '',
        budget: r.budget != null ? r.budget : '',
      }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Nhiệm vụ KHCN');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Disposition', 'attachment; filename="so_lieu_nhiem_vu_khcn_' + todayStamp() + '.xlsx"');
      return res.send(buf);
    } catch (err) {
      console.error('[Export Excel]', err);
      return res.status(500).json({ message: 'Lỗi xuất Excel: ' + (err.message || 'Không xác định') });
    }
  });

  /**
   * Báo cáo thống kê nhiệm vụ (.xlsx) — lọc theo khoảng năm / cấp / trạng thái.
   * Năm lấy theo năm bắt đầu (start_date); bản ghi thiếu start_date chỉ xuất hiện
   * khi không đặt bộ lọc năm.
   */
  router.get('/missions/report-excel', ...adminGuard, async (req, res) => {
    try {
      syncMissionsFromCapVien();

      let fromYear = parseYear(req.query.fromYear);
      let toYear = parseYear(req.query.toYear);
      if (fromYear && toYear && fromYear > toYear) [fromYear, toYear] = [toYear, fromYear];
      const levels = parseList(req.query.levels);
      const statuses = parseList(req.query.statuses);

      const where = [];
      const params = [];
      if (fromYear != null) {
        where.push("start_date IS NOT NULL AND TRIM(start_date) <> '' AND CAST(substr(start_date,1,4) AS INTEGER) >= ?");
        params.push(fromYear);
      }
      if (toYear != null) {
        where.push("start_date IS NOT NULL AND TRIM(start_date) <> '' AND CAST(substr(start_date,1,4) AS INTEGER) <= ?");
        params.push(toYear);
      }
      if (levels.length) {
        where.push(`level IN (${levels.map(() => '?').join(',')})`);
        params.push(...levels);
      }
      if (statuses.length) {
        where.push(`status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }

      const sql =
        'SELECT code, title, principal, level, status, start_date, end_date, progress, budget, ' +
        'managing_agency, contract_number, funding_source, field, mission_type ' +
        'FROM missions' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY level, start_date, code';
      const rows = db.prepare(sql).all(...params);

      const buf = await buildMissionReportBuffer({
        rows,
        filters: { fromYear, toYear, levels, statuses },
        generatedBy: (req.user && (req.user.fullname || req.user.email)) || '',
      });

      const span = fromYear != null || toYear != null ? `_${fromYear || 'dau'}-${toYear || 'nay'}` : '';
      const filename = `bao_cao_nhiem_vu_khcn${span}_${todayStamp()}.xlsx`;

      insertUserActivityLog(req, {
        userId: req.user && req.user.id,
        email: req.user && req.user.email,
        action: 'missions_report_export',
        module: 'missions',
        path: req.originalUrl || '/api/missions/report-excel',
        detail: JSON.stringify({
          at: new Date().toISOString(),
          count: rows.length,
          fromYear,
          toYear,
          levels,
          statuses,
        }),
      });

      res.setHeader('Content-Type', XLSX_MIME);
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      // Cho phép giao diện đọc số bản ghi đã xuất (fetch chỉ thấy header nằm trong danh sách này).
      res.setHeader('X-Mission-Count', String(rows.length));
      res.setHeader('Access-Control-Expose-Headers', 'X-Mission-Count, Content-Disposition');
      return res.send(Buffer.from(buf));
    } catch (err) {
      console.error('[Missions report]', err);
      return res.status(500).json({ message: 'Lỗi xuất báo cáo: ' + (err.message || 'Không xác định') });
    }
  });

  return router;
};
