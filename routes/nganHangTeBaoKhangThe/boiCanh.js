'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — bối cảnh dùng chung cho các router con: phân quyền, ghi nhật ký
 * hoạt động, ghi lịch sử mẫu, sinh mã. Mỗi router con nhận cùng một đối tượng này.
 */

const { HOLDING, placeholders, NGAN_HANG, NGAN_HANG_MAC_DINH } = require('../../services/nganHangTeBaoKhangThe');
const YeuCau = require('../../services/nganHangTeBaoKhangTheYeuCau');
const { taoThongBao } = require('../../services/nganHangTeBaoKhangTheThongBao');

function taoBoiCanh(deps) {
  const { db, insertUserActivityLog, mailSend, baseUrl } = deps;
  const thongBao = taoThongBao({ db, mailSend, baseUrl });
  /** Thư báo chạy NỀN: không chờ, không để lỗi (SMTP, mạng…) làm hỏng thao tác chính đã thành công. */
  const guiNen = (p) => Promise.resolve(p).catch((e) => console.warn('[ngan-hang] thông báo lỗi:', e && e.message));

  // ---------- Phân quyền ----------
  // Admin (users.role = 'admin'): toàn quyền, và là người DUY NHẤT cấp / gỡ vai trò module.
  // Vai trò trong module (bảng nhm_vai_tro, KHÔNG dùng users.role): quan_ly, truong_cellbank.
  // Mọi người dùng đã đăng nhập khác: tìm mẫu, thêm mẫu vào thiết bị công khai, sửa mẫu của mình.

  function laAdmin(req) {
    return String((req.user && req.user.role) || '').toLowerCase() === 'admin';
  }

  /**
   * Ngân hàng đang dùng cho yêu cầu này: header X-Ngan-Hang hoặc ?nh= ('te_bao' | 'khang_the'); không gửi thì mặc định ngân hàng tế bào.
   * Mọi dữ liệu của ngân hàng còn lại bị ẩn (xem tapAn) và vai trò quản lý chỉ tính trong ngân hàng này.
   */
  function datNganHang(req, res, next) {
    const v = String(req.headers['x-ngan-hang'] || (req.query && req.query.nh) || '').trim();
    if (v && !NGAN_HANG[v]) return fail(res, 400, 'Ngân hàng không hợp lệ (te_bao hoặc khang_the).');
    req.nganHang = v || NGAN_HANG_MAC_DINH;
    next();
  }

  /** Tập vai trò module của người đang gọi TRONG ngân hàng hiện tại (vai trò không ghi phạm vi = cả hai); đọc DB một lần cho mỗi request. */
  function vaiTroModule(req) {
    if (!req._nhmVaiTro) {
      const nh = req.nganHang || NGAN_HANG_MAC_DINH;
      req._nhmVaiTro = new Set(
        req.user
          ? db.prepare('SELECT vai_tro, ngan_hang FROM nhm_vai_tro WHERE user_id = ?').all(req.user.id).filter((r) => r.ngan_hang == null || r.ngan_hang === nh).map((r) => r.vai_tro)
          : []
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

  /** Người duyệt của đơn vị quản lý thiết bị chứa hộp (vd Viện trưởng, Trưởng CIPP với Cellbank): là cấp quản lý của thiết bị đó. */
  function quanLyDonVi(req, boxId) {
    const dv = boxId && YeuCau.donViCuaHop(db, boxId);
    return !!dv && YeuCau.nguoiDuyetDonVi(db, dv).some((u) => u.id === req.user.id);
  }

  /** Thiết bị có đơn vị quản lý mà người này KHÔNG phải quản lý module / người duyệt của đơn vị: chỉ được gửi yêu cầu, không tự thêm / lấy mẫu. */
  function biChanDonVi(req, boxId) {
    return !!boxId && YeuCau.hopTrongCellbank(db, boxId) && !canManage(req) && !quanLyDonVi(req, boxId);
  }

  // ---------- Thiết bị RIÊNG (Viện trưởng) ----------
  // Chủ (vai trò vien_truong, đặt ở nhm_vai_tro) tạo thiết bị riêng: CHỈ chủ và admin thấy thiết bị đó, vị trí con, hộp, mẫu bên trong.
  // Mọi người khác (kể cả quản lý module) gặp 404 như thể không tồn tại, và dữ liệu không lọt vào danh sách / tìm kiếm / xuất / số đếm.

  function laVienTruong(req) {
    return vaiTroModule(req).has('vien_truong');
  }

  /** Chủ của thiết bị riêng chứa vị trí này (null nếu không phải thiết bị riêng). */
  function chuRiengCuaViTri(containerId) {
    const g = containerId != null ? YeuCau.gocCuaViTri(db, containerId) : null;
    return g && g.rieng_user_id != null ? g.rieng_user_id : null;
  }

  function chuRiengCuaHop(boxId) {
    const b = boxId != null ? db.prepare('SELECT container_id FROM nhm_boxes WHERE id = ?').get(boxId) : null;
    return b ? chuRiengCuaViTri(b.container_id) : null;
  }

  /**
   * Quản lý module / admin, hoặc chủ thiết bị: được thêm, sửa, xóa thiết bị / Rack / hộp ở đó. Chủ = người đang giữ thiết bị riêng,
   * hoặc Viện trưởng đã TẠO thiết bị (vẫn giữ quyền sau khi chuyển sang Public / đơn vị, để đổi lại được).
   */
  function quyenViTri(req, containerId) {
    if (canManage(req)) return true;
    const g = containerId != null ? YeuCau.gocCuaViTri(db, containerId) : null;
    return !!g && (g.rieng_user_id === req.user.id || (g.created_by === req.user.id && laVienTruong(req)));
  }

  /**
   * Vị trí và hộp BỊ ẨN với người này: (1) mọi thiết bị của ngân hàng KHÔNG đang dùng, kể cả với admin; (2) thiết bị riêng của người khác
   * (admin thấy). Tính một lần cho mỗi yêu cầu.
   */
  function tapAn(req) {
    if (req._nhmAn) return req._nhmAn;
    const an = { containers: new Set(), boxes: new Set() };
    const nh = req.nganHang || NGAN_HANG_MAC_DINH;
    const goc =
      'WITH RECURSIVE t(id) AS (SELECT id FROM nhm_containers WHERE parent_id IS NULL AND (ngan_hang <> ? OR (? = 0 AND rieng_user_id IS NOT NULL AND rieng_user_id <> ?)) ' +
      'UNION SELECT c.id FROM nhm_containers c JOIN t ON c.parent_id = t.id)';
    const tham = [nh, laAdmin(req) ? 1 : 0, req.user.id];
    for (const r of db.prepare(goc + ' SELECT id FROM t').all(...tham)) an.containers.add(r.id);
    for (const r of db.prepare(goc + ' SELECT id FROM nhm_boxes WHERE container_id IN (SELECT id FROM t)').all(...tham)) an.boxes.add(r.id);
    req._nhmAn = an;
    return an;
  }

  /** Điều kiện SQL loại các hộp bị ẩn; col là cột chứa id hộp (có thể NULL). id lấy từ DB, là số nên nối thẳng vào câu lệnh. */
  function dkKhongAn(req, col) {
    const ids = [...tapAn(req).boxes];
    return ids.length ? `(${col} IS NULL OR ${col} NOT IN (${ids.join(',')}))` : '1=1';
  }

  /** Chặn truy cập trực tiếp theo id (đường dẫn và các id trong body) tới dữ liệu bị ẩn: trả 404 giống như không có. */
  function chanDuLieuRieng(req, res, next) {
    const an = tapAn(req);
    if (!an.containers.size) return next();
    const khongThay = () => fail(res, 404, 'Không tìm thấy.');
    const m = /^\/(containers|boxes|tubes|requests|findings|incidents)\/(\d+)(?:\/|$)/.exec(req.path);
    if (m) {
      const id = Number(m[2]);
      let boxId = null;
      if (m[1] === 'containers') {
        if (an.containers.has(id)) return khongThay();
      } else if (m[1] === 'boxes') boxId = id;
      else if (m[1] === 'tubes') boxId = (db.prepare('SELECT box_id FROM nhm_tubes WHERE id = ?').get(id) || {}).box_id;
      else if (m[1] === 'requests') boxId = (db.prepare('SELECT t.box_id FROM nhm_yeu_cau y JOIN nhm_tubes t ON t.id = y.tube_id WHERE y.id = ?').get(id) || {}).box_id;
      else if (m[1] === 'findings') boxId = (db.prepare('SELECT box_id FROM nhm_phat_hien WHERE id = ?').get(id) || {}).box_id;
      else boxId = (db.prepare('SELECT t.box_id FROM nhm_vu_viec v JOIN nhm_tubes t ON t.id = v.tube_id WHERE v.id = ?').get(id) || {}).box_id;
      if (boxId != null && an.boxes.has(boxId)) return khongThay();
    }
    const b = req.body;
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      for (const k of ['box_id', 'container_id', 'parent_id']) {
        const v = Number(b[k]);
        if (b[k] != null && Number.isInteger(v) && (k === 'box_id' ? an.boxes.has(v) : an.containers.has(v))) return khongThay();
      }
    }
    next();
  }

  function canEditTube(req, tube) {
    return canManage(req) || (tube.owner_user_id != null && tube.owner_user_id === req.user.id) || (tube.box_id != null && (quanLyDonVi(req, tube.box_id) || chuRiengCuaHop(tube.box_id) === req.user.id));
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

  /** Hộp nằm trong thiết bị do Cellbank quản lý? */
  function hopTrongCellbank(boxId) {
    return YeuCau.hopTrongCellbank(db, boxId);
  }

  /** «Tủ › Ngăn › Giá › HOP-0001 › A1» — để ghi vào email và danh sách. */
  function moTaViTri(boxId, row, col) {
    const b = boxId && db.prepare('SELECT code, container_id FROM nhm_boxes WHERE id = ?').get(boxId);
    if (!b) return '';
    return duongDan(b.container_id).concat([b.code]).concat(row ? [String.fromCharCode(64 + row) + col] : []).join(' › ');
  }

  /** Người dùng (id) → {id, fullname, email}. */
  function nguoiDung(id) {
    return (id && db.prepare('SELECT id, fullname, email FROM users WHERE id = ?').get(id)) || null;
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

  return { db, laAdmin, vaiTroModule, laTruongCellbank, requireAdmin, hopTrongCellbank, quanLyDonVi, biChanDonVi, datNganHang, laVienTruong, chuRiengCuaViTri, chuRiengCuaHop, quyenViTri, tapAn, dkKhongAn, chanDuLieuRieng, logNhieuMau, thongBao, guiNen, moTaViTri, nguoiDung, nhanNguoi, YeuCau, canManage, requireManage, canEditTube, audit, fail, subtreeIds, duongDan, taoTraDuongDan, activeTubeCountInBoxes, nextCode, logMove };
}

module.exports = taoBoiCanh;
