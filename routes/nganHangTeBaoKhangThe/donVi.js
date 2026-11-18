'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — đơn vị quản lý thiết bị (Cellbank, hoặc đơn vị khác). 4 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Thiết bị gắn với một đơn vị thì mọi yêu cầu lấy mẫu phải được NGƯỜI DUYỆT CỦA ĐƠN VỊ đồng ý; thiết bị không gắn đơn vị là Public.
 * Ngân hàng kháng thể chỉ có đơn vị AntibodyBank: người duyệt luôn là Viện trưởng (vai trò vien_truong, không gán tay), quản lý
 * ngân hàng kháng thể (vai trò quan_ly có phạm vi khang_the) theo dõi và giao mẫu.
 * Gán người duyệt là trao quyền quyết định nên CHỈ ADMIN tạo / sửa / xóa đơn vị (cùng quy tắc cấp vai trò). Quản lý module xem được
 * danh sách để chọn đơn vị khi tạo thiết bị. Đường duyệt: services/nganHangTeBaoKhangTheYeuCau.js.
 */

const express = require('express');
const { toInt, toStr, isUniqueError } = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createDonViRouter(ctx) {
  const { db, requireManage, requireAdmin, audit, fail, YeuCau } = ctx;
  const router = express.Router();

  const MA_MAC_DINH = ['cellbank', 'antibodybank']; // đơn vị có sẵn của mỗi ngân hàng: không xóa được

  /** Tài khoản chọn làm người duyệt: có thật, không bị khóa, không phải tài khoản chỉ dùng Đặt lịch thiết bị. */
  function nguoiHopLe(id) {
    const u = id && db.prepare('SELECT id, fullname, email, role, is_banned FROM users WHERE id = ?').get(id);
    if (!u || Number(u.is_banned) === 1 || ['crd_user', 'sinh_vien'].includes(String(u.role || '').toLowerCase())) return null;
    return u;
  }
  const tenNguoi = (u) => (u ? u.fullname || u.email : '(không rõ)');

  function dinhDang(dv) {
    if (dv.ngan_hang === 'khang_the') {
      const nguoi = (r) => ({ user_id: r.id, ten: r.fullname || r.email || '(không rõ)', email: r.email });
      return {
        id: dv.id, ma: dv.ma, ten: dv.ten, mo_ta: dv.mo_ta, mac_dinh: MA_MAC_DINH.includes(dv.ma), chi_vien_truong: true,
        vai_tro_duyet: 'vien_truong', nguoi_duyet: [], nguoi_theo_vai_tro: YeuCau.nguoiDuyetDonVi(db, dv).map(nguoi),
        quan_ly: YeuCau.quanLyModule(db, 'khang_the').map(nguoi),
        so_thiet_bi: db.prepare('SELECT COUNT(*) AS c FROM nhm_containers WHERE don_vi_id = ? AND deleted_at IS NULL').get(dv.id).c,
      };
    }
    const duyet = db
      .prepare(
        `SELECT d.user_id, u.fullname, u.email FROM nhm_don_vi_duyet d LEFT JOIN users u ON u.id = d.user_id
         WHERE d.don_vi_id = ? ORDER BY u.fullname`
      )
      .all(dv.id)
      .map((r) => ({ user_id: r.user_id, ten: r.fullname || r.email || '(không rõ)', email: r.email }));
    const theoVaiTro = dv.vai_tro_duyet
      ? db
          .prepare(
            `SELECT r.user_id, u.fullname, u.email FROM nhm_vai_tro r LEFT JOIN users u ON u.id = r.user_id
             WHERE r.vai_tro = ? ORDER BY u.fullname`
          )
          .all(dv.vai_tro_duyet)
          .map((r) => ({ user_id: r.user_id, ten: r.fullname || r.email || '(không rõ)', email: r.email }))
      : [];
    return {
      id: dv.id, ma: dv.ma, ten: dv.ten, mo_ta: dv.mo_ta, mac_dinh: MA_MAC_DINH.includes(dv.ma),
      vai_tro_duyet: dv.vai_tro_duyet, nguoi_duyet: duyet, nguoi_theo_vai_tro: theoVaiTro,
      so_thiet_bi: db.prepare('SELECT COUNT(*) AS c FROM nhm_containers WHERE don_vi_id = ? AND deleted_at IS NULL').get(dv.id).c,
    };
  }

  /** Đọc danh sách người duyệt từ body → [mảng id, lỗi]. */
  function docNguoiDuyet(body) {
    if (!('nguoi_duyet' in body)) return [null, null];
    if (!Array.isArray(body.nguoi_duyet) || body.nguoi_duyet.length > 20) return [null, 'Danh sách người duyệt không hợp lệ (tối đa 20 người).'];
    const ids = [];
    for (const x of body.nguoi_duyet) {
      const id = toInt(x);
      if (!nguoiHopLe(id)) return [null, 'Có người duyệt không tồn tại hoặc không dùng được module (tài khoản bị khóa, chỉ Đặt lịch, hoặc sinh viên).'];
      if (!ids.includes(id)) ids.push(id);
    }
    return [ids, null];
  }

  router.get('/units', requireManage, (req, res) => {
    res.json({ units: db.prepare("SELECT * FROM nhm_don_vi WHERE ngan_hang = ? ORDER BY (ma IN ('cellbank','antibodybank')) DESC, ten").all(req.nganHang).map(dinhDang) });
  });

  router.post('/units', requireAdmin, (req, res) => {
    if (req.nganHang === 'khang_the') return fail(res, 400, 'Ngân hàng kháng thể chỉ có một đơn vị quản lý: AntibodyBank.');
    const body = req.body || {};
    const ten = toStr(body.ten, 100);
    if (!ten) return fail(res, 400, 'Thiếu tên đơn vị.');
    const [ids, loi] = docNguoiDuyet(body);
    if (loi) return fail(res, 400, loi);
    try {
      const id = db.transaction(() => {
        const info = db
          .prepare('INSERT INTO nhm_don_vi (ma, ten, mo_ta, ngan_hang, created_by) VALUES (?, ?, ?, ?, ?)')
          .run('dv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ten, toStr(body.mo_ta, 500), req.nganHang, req.user.id);
        const dvId = Number(info.lastInsertRowid);
        for (const uid of ids || []) db.prepare('INSERT INTO nhm_don_vi_duyet (don_vi_id, user_id, granted_by) VALUES (?, ?, ?)').run(dvId, uid, req.user.id);
        return dvId;
      })();
      audit(req, 'unit_create', `id=${id} ${ten}; người duyệt: ${(ids || []).map((x) => tenNguoi(nguoiHopLe(x))).join(', ') || '(chưa có)'}`);
      res.status(201).json({ id });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Đã có đơn vị trùng tên.');
      throw e;
    }
  });

  router.patch('/units/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_don_vi WHERE id = ? AND ngan_hang = ?').get(id, req.nganHang);
    if (!cur) return fail(res, 404, 'Không tìm thấy đơn vị.');
    const body = req.body || {};
    if (cur.ngan_hang === 'khang_the' && 'nguoi_duyet' in body) return fail(res, 400, 'Người duyệt của AntibodyBank luôn là Viện trưởng (cấp ở tab Vai trò), không gán tay.');
    const [ids, loi] = docNguoiDuyet(body);
    if (loi) return fail(res, 400, loi);
    const ten = 'ten' in body ? toStr(body.ten, 100) : cur.ten;
    if (!ten) return fail(res, 400, 'Tên đơn vị không được để trống.');
    const moTa = 'mo_ta' in body ? toStr(body.mo_ta, 500) : cur.mo_ta;
    try {
      db.transaction(() => {
        db.prepare("UPDATE nhm_don_vi SET ten = ?, mo_ta = ?, updated_at = datetime('now') WHERE id = ?").run(ten, moTa, id);
        if (ids) {
          db.prepare('DELETE FROM nhm_don_vi_duyet WHERE don_vi_id = ?').run(id);
          for (const uid of ids) db.prepare('INSERT INTO nhm_don_vi_duyet (don_vi_id, user_id, granted_by) VALUES (?, ?, ?)').run(id, uid, req.user.id);
        }
      })();
      audit(req, 'unit_update', `id=${id} ${ten}${ids ? '; người duyệt: ' + (ids.map((x) => tenNguoi(nguoiHopLe(x))).join(', ') || '(chưa có)') : ''}`);
      res.json({ ok: true });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Đã có đơn vị trùng tên.');
      throw e;
    }
  });

  router.delete('/units/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_don_vi WHERE id = ? AND ngan_hang = ?').get(id, req.nganHang);
    if (!cur) return fail(res, 404, 'Không tìm thấy đơn vị.');
    if (MA_MAC_DINH.includes(cur.ma)) return fail(res, 400, 'Không xóa được đơn vị có sẵn của ngân hàng (Cellbank, AntibodyBank).');
    const dung = db.prepare('SELECT COUNT(*) AS c FROM nhm_containers WHERE don_vi_id = ? AND deleted_at IS NULL').get(id).c;
    if (dung > 0) return fail(res, 409, `Không xóa được: còn ${dung} thiết bị thuộc đơn vị này. Hãy chuyển các thiết bị sang đơn vị khác hoặc Public trước.`);
    db.transaction(() => {
      db.prepare('DELETE FROM nhm_don_vi_duyet WHERE don_vi_id = ?').run(id);
      db.prepare('DELETE FROM nhm_don_vi WHERE id = ?').run(id);
    })();
    audit(req, 'unit_delete', `id=${id} ${cur.ten}`);
    res.json({ ok: true });
  });

  ctx.donViCuaHop = (boxId) => YeuCau.donViCuaHop(db, boxId);
  return router;
};
