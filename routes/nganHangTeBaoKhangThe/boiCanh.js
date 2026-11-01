'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — bối cảnh dùng chung cho các router con: phân quyền, ghi nhật ký
 * hoạt động, ghi lịch sử mẫu, sinh mã. Mỗi router con nhận cùng một đối tượng này.
 */

const { HOLDING, placeholders } = require('../../services/nganHangTeBaoKhangThe');

function taoBoiCanh(deps) {
  const { db, insertUserActivityLog } = deps;

  // ---------- Phân quyền ----------
  // Admin (users.role = 'admin'): toàn quyền, và là người DUY NHẤT cấp / gỡ vai trò module.
  // Vai trò trong module (bảng nhm_vai_tro, KHÔNG dùng users.role): quan_ly, truong_cellbank.
  // Mọi người dùng đã đăng nhập khác: tìm mẫu, thêm mẫu vào thiết bị công khai, sửa mẫu của mình.

  function laAdmin(req) {
    return String((req.user && req.user.role) || '').toLowerCase() === 'admin';
  }

  /** Tập vai trò module của người đang gọi; đọc DB một lần cho mỗi request. */
  function vaiTroModule(req) {
    if (!req._nhmVaiTro) {
      req._nhmVaiTro = new Set(
        req.user ? db.prepare('SELECT vai_tro FROM nhm_vai_tro WHERE user_id = ?').all(req.user.id).map((r) => r.vai_tro) : []
      );
    }
    return req._nhmVaiTro;
  }

  function canManage(req) {
    return laAdmin(req) || vaiTroModule(req).has('quan_ly');
  }

  function laTruongCellbank(req) {
    return vaiTroModule(req).has('truong_cellbank');
  }

  function requireManage(req, res, next) {
    if (!canManage(req)) {
      return res.status(403).json({ message: 'Chỉ Admin hoặc Quản lý module mới có quyền thao tác này.' });
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (!laAdmin(req)) return res.status(403).json({ message: 'Chỉ Admin mới có quyền thao tác này.' });
    next();
  }

  function canEditTube(req, tube) {
    return canManage(req) || (tube.owner_user_id != null && tube.owner_user_id === req.user.id);
  }

  function audit(req, action, detail) {
    if (typeof insertUserActivityLog !== 'function') return;
    insertUserActivityLog(req, {
      userId: req.user && req.user.id,
      email: req.user && req.user.email,
      action: 'nhm_' + action,
      module: 'ngan_hang_te_bao_khang_the',
      path: req.originalUrl,
      detail,
    });
  }

  function fail(res, status, message) {
    return res.status(status).json({ message });
  }

  function allContainers() {
    return db.prepare('SELECT id, parent_id FROM nhm_containers WHERE deleted_at IS NULL').all();
  }

  /** id của container và mọi container con cháu. */
  function subtreeIds(rootId) {
    const rows = allContainers();
    const out = [rootId];
    for (let i = 0; i < out.length; i++) {
      for (const r of rows) if (r.parent_id === out[i] && !out.includes(r.id)) out.push(r.id);
    }
    return out;
  }

  /** Trả hàm containerId -> ['Tủ A', 'Ngăn 1', 'Giá 1']; đọc cây một lần, dùng cho nhiều hộp. */
  function taoTraDuongDan() {
    const rows = db.prepare('SELECT id, parent_id, name FROM nhm_containers WHERE deleted_at IS NULL').all();
    const byId = new Map(rows.map((c) => [c.id, c]));
    return (containerId) => {
      const path = [];
      for (let c = byId.get(containerId); c && path.length < 50; c = byId.get(c.parent_id)) path.unshift(c.name);
      return path;
    };
  }

  /** Tên từ gốc tới vị trí lưu trữ, vd ['Tủ A', 'Ngăn 1', 'Giá 1']. */
  function duongDan(containerId) {
    return taoTraDuongDan()(containerId);
  }

  /** Thiết bị GỐC chứa vị trí lưu trữ này (đi ngược parent_id). */
  function thietBiGoc(containerId) {
    let cur = db.prepare('SELECT id, parent_id, quan_ly_boi FROM nhm_containers WHERE id = ?').get(containerId);
    for (let i = 0; cur && cur.parent_id != null && i < 50; i++) {
      cur = db.prepare('SELECT id, parent_id, quan_ly_boi FROM nhm_containers WHERE id = ?').get(cur.parent_id);
    }
    return cur || null;
  }

  /** Hộp nằm trong thiết bị do Cellbank quản lý? */
  function hopTrongCellbank(boxId) {
    const box = boxId && db.prepare('SELECT container_id FROM nhm_boxes WHERE id = ?').get(boxId);
    const goc = box && thietBiGoc(box.container_id);
    return !!goc && goc.quan_ly_boi === 'cellbank';
  }

  function activeTubeCountInBoxes(boxIds) {
    if (!boxIds.length) return 0;
    return db
      .prepare(
        `SELECT COUNT(*) AS c FROM nhm_tubes
         WHERE deleted_at IS NULL AND status IN ${HOLDING} AND box_id IN (${placeholders(boxIds.length)})`
      )
      .get(...boxIds).c;
  }

  /** Mã tự sinh kế tiếp; bỏ qua mã đã bị người dùng đặt tay (tránh 409 khó hiểu và rollback cả lô). */
  function nextCode(table, prefix) {
    let n = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`).get().n;
    for (;;) {
      const code = prefix + String(n).padStart(4, '0');
      if (!db.prepare(`SELECT 1 FROM ${table} WHERE code = ? AND deleted_at IS NULL`).get(code)) return code;
      n++;
    }
  }

  /** Tên người thao tác tại thời điểm ghi lịch sử (lịch sử vẫn đọc được khi tài khoản đổi tên / bị xóa). */
  function nhanNguoi(userId) {
    if (!userId) return null;
    const u = db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(userId);
    return u ? u.fullname || u.email || null : null;
  }

  function logMove(tubeId, action, from, to, userId, note) {
    db.prepare(
      `INSERT INTO nhm_movements (tube_id, action, from_box_id, from_row, from_col, to_box_id, to_row, to_col, user_id, user_label, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tubeId,
      action,
      from ? from.box_id : null,
      from ? from.row_no : null,
      from ? from.col_no : null,
      to ? to.box_id : null,
      to ? to.row_no : null,
      to ? to.col_no : null,
      userId || null,
      nhanNguoi(userId),
      note || null
    );
  }

  /** Ghi cùng một dòng lịch sử cho nhiều mẫu (nhóm đổi trưởng nhóm, hộp đổi chỗ, người rời đi...). */
  function logNhieuMau(tubeIds, action, userId, note) {
    for (const id of tubeIds) logMove(id, action, null, null, userId, note);
  }

  return { db, laAdmin, vaiTroModule, laTruongCellbank, requireAdmin, thietBiGoc, hopTrongCellbank, logNhieuMau, canManage, requireManage, canEditTube, audit, fail, subtreeIds, duongDan, taoTraDuongDan, activeTubeCountInBoxes, nextCode, logMove };
}

module.exports = taoBoiCanh;
