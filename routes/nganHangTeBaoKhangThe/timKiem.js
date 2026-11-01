'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — tìm mẫu xuyên kho và xuất danh sách kiểm kê CSV. 2 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Route tĩnh `/tubes/search`, `/tubes/export.csv` phải đứng TRƯỚC mọi route `/tubes/:id...` (router này
 * được nối trước mau.js).
 */

const express = require('express');
const { HOLDING, toInt, TRANG_THAI_VN } = require('../../services/nganHangTeBaoKhangThe');

const TRANG_THAI_HOP_LE = Object.keys(TRANG_THAI_VN);
const GIOI_HAN_XUAT = 20000;

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Chống chèn công thức khi mở CSV bằng Excel: ô bắt đầu bằng = + - @ hoặc tab thì thêm dấu nháy đơn. */
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = function createTimKiemRouter(ctx) {
  const { db, requireManage, canEditTube, audit, fail, taoTraDuongDan } = ctx;
  const router = express.Router();

  /** Đọc bộ lọc từ query string -> [{where, params}, lỗi]. */
  function docBoLoc(req) {
    const q = req.query || {};
    const where = ['t.deleted_at IS NULL'];
    const params = [];
    const tt = typeof q.status === 'string' ? q.status : '';
    if (tt === 'all') {
      // mọi trạng thái, kể cả đã rã đông / hủy
    } else if (tt) {
      if (!TRANG_THAI_HOP_LE.includes(tt)) return [null, 'Trạng thái lọc không hợp lệ.'];
      where.push('t.status = ?');
      params.push(tt);
    } else {
      where.push(`t.status IN ${HOLDING}`);
    }
    const tuKhoa = typeof q.q === 'string' ? q.q.trim().slice(0, 100) : '';
    if (tuKhoa) {
      const like = '%' + escapeLike(tuKhoa) + '%';
      where.push(
        `(t.name LIKE ? ESCAPE '\\' OR t.barcode LIKE ? ESCAPE '\\' OR t.project LIKE ? ESCAPE '\\'
          OR t.passage LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\')`
      );
      params.push(like, like, like, like, like);
    }
    if (q.sample_type_id != null && q.sample_type_id !== '') {
      const id = toInt(q.sample_type_id);
      if (id == null) return [null, 'Loại mẫu lọc không hợp lệ.'];
      where.push('t.sample_type_id = ?');
      params.push(id);
    }
    if (q.owner != null && q.owner !== '') {
      const id = q.owner === 'me' ? req.user.id : toInt(q.owner);
      if (id == null) return [null, 'Người sở hữu lọc không hợp lệ.'];
      where.push('t.owner_user_id = ?');
      params.push(id);
    }
    if (q.box_id != null && q.box_id !== '') {
      const id = toInt(q.box_id);
      if (id == null) return [null, 'Hộp lọc không hợp lệ.'];
      where.push('t.box_id = ?');
      params.push(id);
    }
    return [{ where: where.join(' AND '), params }, null];
  }

  const CHON = `SELECT t.id, t.name, t.barcode, t.status, t.passage, t.cell_count, t.volume_ml, t.freeze_date, t.project, t.notes,
                       t.row_no, t.col_no, t.box_id, t.sample_type_id, t.owner_user_id, t.updated_at,
                       s.name AS sample_type_name, b.code AS box_code, b.name AS box_name, b.container_id,
                       (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = t.owner_user_id) AS owner_name
                FROM nhm_tubes t
                LEFT JOIN nhm_sample_types s ON s.id = t.sample_type_id
                LEFT JOIN nhm_boxes b ON b.id = t.box_id`;

  router.get('/tubes/search', (req, res) => {
    const [loc, loi] = docBoLoc(req);
    if (loi) return fail(res, 400, loi);
    const limit = Math.min(Math.max(toInt(req.query.limit) || 50, 1), 200);
    const offset = Math.max(toInt(req.query.offset) || 0, 0);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM nhm_tubes t WHERE ${loc.where}`).get(...loc.params).c;
    const rows = db
      .prepare(`${CHON} WHERE ${loc.where} ORDER BY t.name COLLATE NOCASE, t.id LIMIT ? OFFSET ?`)
      .all(...loc.params, limit, offset);
    const duongDan = taoTraDuongDan();
    res.json({
      total,
      limit,
      offset,
      items: rows.map((r) => ({ ...r, path: r.container_id ? duongDan(r.container_id) : [], can_edit: canEditTube(req, r) })),
    });
  });

  // Xuất danh sách kiểm kê: chỉ quản lý (toàn bộ kho, có người sở hữu).
  router.get('/tubes/export.csv', requireManage, (req, res) => {
    const [loc, loi] = docBoLoc(req);
    if (loi) return fail(res, 400, loi);
    const rows = db
      .prepare(`${CHON} WHERE ${loc.where} ORDER BY b.code, t.row_no, t.col_no, t.id LIMIT ?`)
      .all(...loc.params, GIOI_HAN_XUAT);
    const duongDan = taoTraDuongDan();
    const dau = ['Mã nội bộ', 'Tên mẫu', 'Mã vạch', 'Loại mẫu', 'Passage', 'Số tế bào', 'Thể tích (mL)', 'Ngày đông lạnh', 'Đề tài',
      'Trạng thái', 'Vị trí lưu trữ', 'Mã hộp', 'Ô', 'Người sở hữu', 'Ghi chú'];
    const dong = rows.map((r) => [
      r.id, r.name, r.barcode, r.sample_type_name, r.passage, r.cell_count, r.volume_ml, r.freeze_date, r.project,
      TRANG_THAI_VN[r.status] || r.status, r.container_id ? duongDan(r.container_id).join(' › ') : '', r.box_code,
      r.row_no ? String.fromCharCode(64 + r.row_no) + r.col_no : '', r.owner_name, r.notes,
    ]);
    const csv = '﻿' + [dau, ...dong].map((d) => d.map(csvCell).join(',')).join('\r\n') + '\r\n';
    audit(req, 'tube_export', `${rows.length} mẫu`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ngan-hang-te-bao-khang-the.csv"');
    res.send(csv);
  });

  return router;
};
