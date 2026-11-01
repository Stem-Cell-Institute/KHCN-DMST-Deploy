'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — tìm mẫu xuyên kho và xuất danh sách kiểm kê CSV. 2 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Từ khóa `q` khớp với MỌI thông tin về mẫu (tên, đề tài, passage, ghi chú, ngày, số tế bào, thể tích, loại mẫu,
 * trạng thái, loại chủ, nhóm, trưởng nhóm, người sở hữu, hộp, đường dẫn tủ › ngăn › giá, ô). So khớp bỏ dấu và không
 * phân biệt hoa thường («de tai» ra «Đề tài»); nhiều từ thì mẫu phải khớp TẤT CẢ các từ (mỗi từ ở một trường bất kỳ).
 * Lọc theo từ khóa làm trong bộ nhớ vì SQLite LIKE không bỏ dấu tiếng Việt; số mẫu của một viện đủ nhỏ để việc này nhanh.
 *
 * Route tĩnh `/tubes/search`, `/tubes/export.csv` phải đứng TRƯỚC mọi route `/tubes/:id...` (router này
 * được nối trước mau.js).
 */

const express = require('express');
const { HOLDING, toInt, chuanHoaTen, LOAI_CHU, LOAI_CHU_VN, TRANG_THAI_VN } = require('../../services/nganHangTeBaoKhangThe');

const TRANG_THAI_HOP_LE = Object.keys(TRANG_THAI_VN);
const GIOI_HAN_XUAT = 20000;
const GIOI_HAN_QUET = 100000;

/** Chống chèn công thức khi mở CSV bằng Excel: ô bắt đầu bằng = + - @ hoặc tab thì thêm dấu nháy đơn. */
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const nhanO = (r, c) => (r ? String.fromCharCode(64 + r) + c : '');

module.exports = function createTimKiemRouter(ctx) {
  const { db, requireManage, canEditTube, audit, fail, taoTraDuongDan } = ctx;
  const router = express.Router();

  /** Đọc bộ lọc từ query string -> [{where, params, tuKhoa}, lỗi]. */
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
    for (const [khoa, cot, nhan] of [['sample_type_id', 't.sample_type_id', 'Loại mẫu'], ['box_id', 't.box_id', 'Hộp'], ['nhom_id', 't.nhom_id', 'Nhóm']]) {
      if (q[khoa] != null && q[khoa] !== '') {
        const id = toInt(q[khoa]);
        if (id == null) return [null, `${nhan} lọc không hợp lệ.`];
        where.push(`${cot} = ?`);
        params.push(id);
      }
    }
    if (q.chu_loai != null && q.chu_loai !== '') {
      if (!LOAI_CHU.includes(q.chu_loai)) return [null, 'Loại chủ mẫu lọc không hợp lệ.'];
      where.push('t.chu_loai = ?');
      params.push(q.chu_loai);
    }
    if (q.owner != null && q.owner !== '') {
      const id = q.owner === 'me' ? req.user.id : toInt(q.owner);
      if (id == null) return [null, 'Người sở hữu lọc không hợp lệ.'];
      where.push('t.owner_user_id = ?');
      params.push(id);
    }
    const tuKhoa = chuanHoaTen(typeof q.q === 'string' ? q.q.slice(0, 100) : '').split(' ').filter(Boolean);
    return [{ where: where.join(' AND '), params, tuKhoa }, null];
  }

  const CHON = `SELECT t.id, t.name, t.status, t.passage, t.cell_count, t.volume_ml, t.freeze_date, t.project, t.notes,
                       t.row_no, t.col_no, t.box_id, t.sample_type_id, t.owner_user_id, t.updated_at, t.chu_loai, t.nhom_id,
                       s.name AS sample_type_name, b.code AS box_code, b.name AS box_name, b.container_id,
                       g.ten AS nhom_ten,
                       (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = g.truong_user_id) AS truong_ten,
                       (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = t.owner_user_id) AS owner_name,
                       (SELECT email FROM users WHERE id = t.owner_user_id) AS owner_email
                FROM nhm_tubes t
                LEFT JOIN nhm_sample_types s ON s.id = t.sample_type_id
                LEFT JOIN nhm_boxes b ON b.id = t.box_id
                LEFT JOIN nhm_nhom g ON g.id = t.nhom_id`;

  /** Lấy các mẫu khớp bộ lọc SQL rồi lọc theo từ khóa; trả về cả đường dẫn đầy đủ. */
  function timMau(loc, sapXep) {
    const duongDan = taoTraDuongDan();
    let rows = db
      .prepare(`${CHON} WHERE ${loc.where} ORDER BY ${sapXep} LIMIT ?`)
      .all(...loc.params, GIOI_HAN_QUET)
      .map((r) => ({ ...r, path: r.container_id ? duongDan(r.container_id) : [] }));
    if (loc.tuKhoa.length) {
      rows = rows.filter((r) => {
        const kho = chuanHoaTen(
          [
            r.id, r.name, r.project, r.passage, r.notes, r.freeze_date, r.cell_count, r.volume_ml, r.sample_type_name,
            TRANG_THAI_VN[r.status], LOAI_CHU_VN[r.chu_loai], r.nhom_ten, r.truong_ten, r.owner_name, r.owner_email,
            r.box_code, r.box_name, r.path.join(' '), nhanO(r.row_no, r.col_no),
          ].join(' ')
        );
        return loc.tuKhoa.every((tu) => kho.includes(tu));
      });
    }
    return rows;
  }

  router.get('/tubes/search', (req, res) => {
    const [loc, loi] = docBoLoc(req);
    if (loi) return fail(res, 400, loi);
    const limit = Math.min(Math.max(toInt(req.query.limit) || 50, 1), 200);
    const offset = Math.max(toInt(req.query.offset) || 0, 0);
    const rows = timMau(loc, 't.name COLLATE NOCASE, t.id');
    res.json({
      total: rows.length,
      limit,
      offset,
      items: rows.slice(offset, offset + limit).map((r) => ({ ...r, can_edit: canEditTube(req, r) })),
    });
  });

  // Xuất danh sách kiểm kê: chỉ quản lý (toàn bộ kho, có người sở hữu).
  router.get('/tubes/export.csv', requireManage, (req, res) => {
    const [loc, loi] = docBoLoc(req);
    if (loi) return fail(res, 400, loi);
    const rows = timMau(loc, 'b.code, t.row_no, t.col_no, t.id').slice(0, GIOI_HAN_XUAT);
    const dau = ['Mã nội bộ', 'Tên mẫu', 'Loại mẫu', 'Passage', 'Số tế bào', 'Thể tích (mL)', 'Ngày đông lạnh', 'Đề tài', 'Trạng thái',
      'Loại chủ mẫu', 'Nhóm nghiên cứu', 'Trưởng nhóm', 'Vị trí lưu trữ', 'Mã hộp', 'Ô', 'Người sở hữu', 'Ghi chú'];
    const dong = rows.map((r) => [
      r.id, r.name, r.sample_type_name, r.passage, r.cell_count, r.volume_ml, r.freeze_date, r.project,
      TRANG_THAI_VN[r.status] || r.status, LOAI_CHU_VN[r.chu_loai] || '', r.nhom_ten, r.truong_ten, r.path.join(' › '), r.box_code,
      nhanO(r.row_no, r.col_no), r.owner_name, r.notes,
    ]);
    const csv = '﻿' + [dau, ...dong].map((d) => d.map(csvCell).join(',')).join('\r\n') + '\r\n';
    audit(req, 'tube_export', `${rows.length} mẫu`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ngan-hang-te-bao-khang-the.csv"');
    res.send(csv);
  });

  return router;
};
