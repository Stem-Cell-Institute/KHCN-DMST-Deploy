'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — vai trò trong module, nhóm nghiên cứu, hồ sơ thành viên, tìm người. 14 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Ai làm được gì:
 *   - Cấp / gỡ vai trò (quản lý module, Trưởng CIPP): CHỈ admin.
 *   - Tạo / sửa / gộp nhóm, gán hồ sơ thành viên (loại, nhóm, đã rời đi): admin và quản lý module.
 *   - Mọi người dùng: xem danh sách nhóm, đề xuất nhóm mới khi thêm mẫu, xác nhận / từ chối việc mình được ghi là
 *     trưởng nhóm, tìm người theo tên.
 *
 * Trưởng nhóm là một TÀI KHOẢN (để hệ thống gửi email duyệt yêu cầu), không phải tên gõ tay. Nhóm do người dùng
 * đề xuất ở trạng thái «chờ xác nhận» và người được ghi phải tự xác nhận; chưa xác nhận thì yêu cầu về mẫu của
 * nhóm đó đi thẳng tới quản lý module (xem readme/MODULE-NGAN-HANG-TE-BAO-KHANG-THE.md).
 */

const express = require('express');
const {
  HOLDING, VAI_TRO_MODULE, LOAI_CHU, LOAI_CHU_VN, chuanHoaTen, toInt, toStr, isUniqueError, layThayDoi, moTaThayDoi,
} = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createThanhVienRouter(ctx) {
  const { db, laAdmin, vaiTroModule, laTruongCellbank, canManage, requireManage, requireAdmin, audit, fail, logNhieuMau } = ctx;
  const router = express.Router();

  /** Tài khoản dùng được trong module: có thật, không bị khóa, không phải tài khoản chỉ dùng CRD. */
  function nguoiHopLe(id) {
    const u = id && db.prepare('SELECT id, fullname, email, role, is_banned FROM users WHERE id = ?').get(id);
    if (!u || Number(u.is_banned) === 1 || String(u.role || '').toLowerCase() === 'crd_user') return null;
    return u;
  }
  const tenNguoi = (id) => {
    const u = id && db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(id);
    return u ? u.fullname || u.email : id ? '(không rõ)' : '(chưa có)';
  };
  const mauCuaNhom = (nhomId) =>
    db.prepare(`SELECT id FROM nhm_tubes WHERE nhom_id = ? AND deleted_at IS NULL AND status IN ${HOLDING}`).all(nhomId).map((r) => r.id);

  const SELECT_NHOM = `SELECT g.*, (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = g.truong_user_id) AS truong_ten,
                              (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = g.de_xuat_boi) AS de_xuat_ten,
                              (SELECT COUNT(*) FROM nhm_ho_so h WHERE h.nhom_id = g.id AND h.trang_thai = 'dang_hoat_dong') AS so_thanh_vien,
                              (SELECT COUNT(*) FROM nhm_tubes t WHERE t.nhom_id = g.id AND t.deleted_at IS NULL AND t.status IN ${HOLDING}) AS so_mau
                       FROM nhm_nhom g`;

  // ---------- Tôi là ai ----------

  router.get('/me', (req, res) => {
    const hoSo = db
      .prepare(
        `SELECT h.*, g.ten AS nhom_ten FROM nhm_ho_so h LEFT JOIN nhm_nhom g ON g.id = h.nhom_id WHERE h.user_id = ?`
      )
      .get(req.user.id);
    const choXacNhan = db
      .prepare(`${SELECT_NHOM} WHERE g.truong_user_id = ? AND g.truong_xac_nhan = 0 AND g.trang_thai <> 'giai_the'`)
      .all(req.user.id);
    res.json({
      id: req.user.id,
      email: req.user.email,
      laAdmin: laAdmin(req),
      canManage: canManage(req),
      laTruongCellbank: laTruongCellbank(req),
      vaiTro: [...vaiTroModule(req)],
      hoSo: hoSo || null,
      nhomChoXacNhan: choXacNhan,
      yeuCau: ctx.demYeuCau ? ctx.demYeuCau(req) : { mine: 0, inbox: 0 },
      phatHienMo: db.prepare("SELECT COUNT(*) AS c FROM nhm_phat_hien WHERE trang_thai = 'cho_chu_mau'").get().c,
      vuViecMo: db.prepare("SELECT COUNT(*) AS c FROM nhm_vu_viec WHERE trang_thai IN ('mo','cho_chu_xac_nhan')").get().c,
    });
  });

  // ---------- Vai trò trong module (chỉ admin cấp / gỡ) ----------

  router.get('/roles', requireManage, (req, res) => {
    res.json({
      roles: db
        .prepare(
          `SELECT r.id, r.user_id, r.vai_tro, r.created_at, u.fullname, u.email
           FROM nhm_vai_tro r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.vai_tro, u.fullname`
        )
        .all(),
    });
  });

  router.post('/roles', requireAdmin, (req, res) => {
    const userId = toInt((req.body || {}).user_id);
    const vaiTro = (req.body || {}).vai_tro;
    if (!VAI_TRO_MODULE.includes(vaiTro)) return fail(res, 400, 'Vai trò không hợp lệ.');
    if (!nguoiHopLe(userId)) return fail(res, 400, 'Người dùng không tồn tại hoặc không dùng được module.');
    try {
      const info = db.prepare('INSERT INTO nhm_vai_tro (user_id, vai_tro, granted_by) VALUES (?, ?, ?)').run(userId, vaiTro, req.user.id);
      audit(req, 'role_grant', `${vaiTro} cho ${tenNguoi(userId)} (id=${userId})`);
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Người này đã có vai trò đó.');
      throw e;
    }
  });

  router.delete('/roles/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_vai_tro WHERE id = ?').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy vai trò.');
    db.prepare('DELETE FROM nhm_vai_tro WHERE id = ?').run(id);
    audit(req, 'role_revoke', `${cur.vai_tro} của ${tenNguoi(cur.user_id)} (id=${cur.user_id})`);
    res.json({ ok: true });
  });

  // ---------- Tìm người (chọn trưởng nhóm, người nhận...) ----------

  router.get('/users/search', (req, res) => {
    const q = chuanHoaTen(typeof req.query.q === 'string' ? req.query.q.slice(0, 60) : '');
    if (q.length < 2) return fail(res, 400, 'Gõ ít nhất 2 ký tự để tìm.');
    const ds = db
      .prepare(
        "SELECT id, fullname, email FROM users WHERE COALESCE(is_banned, 0) = 0 AND LOWER(COALESCE(role, '')) <> 'crd_user'"
      )
      .all()
      .filter((u) => chuanHoaTen(`${u.fullname || ''} ${u.email || ''}`).includes(q))
      .slice(0, 10);
    res.json({ users: ds });
  });

  // ---------- Nhóm nghiên cứu ----------

  router.get('/groups', (req, res) => {
    const tatCa = req.query.all === '1' && canManage(req);
    const rows = db.prepare(`${SELECT_NHOM} ${tatCa ? '' : "WHERE g.trang_thai <> 'giai_the'"} ORDER BY g.ten COLLATE NOCASE`).all();
    res.json({ groups: rows });
  });

  // Người dùng đề xuất nhóm khi thêm mẫu mà chưa có nhóm trong danh sách. Trùng tên (không phân biệt dấu / hoa
  // thường) thì dùng lại nhóm cũ, không tạo bản sao.
  router.post('/groups/propose', (req, res) => {
    const body = req.body || {};
    const ten = toStr(body.ten, 120);
    if (!ten) return fail(res, 400, 'Thiếu tên nhóm nghiên cứu.');
    const khoa = chuanHoaTen(ten);
    const co = db.prepare("SELECT id FROM nhm_nhom WHERE ten_khoa = ? AND trang_thai <> 'giai_the'").get(khoa);
    if (co) return res.json({ id: co.id, daCo: true });
    const truong = toInt(body.truong_user_id);
    if (!truong) return fail(res, 400, 'Chọn trưởng nhóm từ danh sách tài khoản.');
    if (!nguoiHopLe(truong)) return fail(res, 400, 'Trưởng nhóm không tồn tại hoặc không dùng được module.');
    const hs = db.prepare('SELECT loai FROM nhm_ho_so WHERE user_id = ?').get(req.user.id);
    if (truong === req.user.id && hs && hs.loai === 'sinh_vien') {
      return fail(res, 400, 'Sinh viên không thể tự là trưởng nhóm của chính mình.');
    }
    const tuXacNhan = truong === req.user.id ? 1 : 0; // tự ghi mình là trưởng nhóm thì coi như đã xác nhận
    const info = db
      .prepare(
        `INSERT INTO nhm_nhom (ten, ten_khoa, truong_user_id, truong_xac_nhan, trang_thai, de_xuat_boi) VALUES (?, ?, ?, ?, 'cho_xac_nhan', ?)`
      )
      .run(ten, khoa, truong, tuXacNhan, req.user.id);
    audit(req, 'group_propose', `id=${info.lastInsertRowid} ${ten}, trưởng nhóm ${tenNguoi(truong)}`);
    res.status(201).json({ id: Number(info.lastInsertRowid), daCo: false });
  });

  router.post('/groups', requireManage, (req, res) => {
    const body = req.body || {};
    const ten = toStr(body.ten, 120);
    if (!ten) return fail(res, 400, 'Thiếu tên nhóm nghiên cứu.');
    const truong = body.truong_user_id == null || body.truong_user_id === '' ? null : toInt(body.truong_user_id);
    if (truong != null && !nguoiHopLe(truong)) return fail(res, 400, 'Trưởng nhóm không tồn tại hoặc không dùng được module.');
    try {
      // quản lý tạo thì coi như đã kiểm: nhóm đã xác nhận, trưởng nhóm đã xác nhận
      const info = db
        .prepare(
          `INSERT INTO nhm_nhom (ten, ten_khoa, truong_user_id, truong_xac_nhan, trang_thai, ghi_chu, de_xuat_boi)
           VALUES (?, ?, ?, ?, 'da_xac_nhan', ?, ?)`
        )
        .run(ten, chuanHoaTen(ten), truong, truong ? 1 : 0, toStr(body.ghi_chu, 500), req.user.id);
      audit(req, 'group_create', `id=${info.lastInsertRowid} ${ten}, trưởng nhóm ${tenNguoi(truong)}`);
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Đã có nhóm trùng tên.');
      throw e;
    }
  });

  router.patch('/groups/:id', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_nhom WHERE id = ?').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy nhóm.');
    const body = req.body || {};
    const upd = {};
    if ('ten' in body) {
      upd.ten = toStr(body.ten, 120);
      if (!upd.ten) return fail(res, 400, 'Tên nhóm không được để trống.');
      upd.ten_khoa = chuanHoaTen(upd.ten);
    }
    if ('truong_user_id' in body) {
      const t = body.truong_user_id == null || body.truong_user_id === '' ? null : toInt(body.truong_user_id);
      if (t != null && !nguoiHopLe(t)) return fail(res, 400, 'Trưởng nhóm không tồn tại hoặc không dùng được module.');
      upd.truong_user_id = t;
      // đổi trưởng nhóm thì phải xác nhận lại, trừ khi quản lý xác nhận thay
      if (t !== cur.truong_user_id) upd.truong_xac_nhan = t && body.truong_xac_nhan ? 1 : 0;
    } else if ('truong_xac_nhan' in body && cur.truong_user_id) {
      upd.truong_xac_nhan = body.truong_xac_nhan ? 1 : 0;
    }
    if ('trang_thai' in body) {
      if (!['cho_xac_nhan', 'da_xac_nhan', 'giai_the'].includes(body.trang_thai)) return fail(res, 400, 'Trạng thái nhóm không hợp lệ.');
      upd.trang_thai = body.trang_thai;
    }
    if ('ghi_chu' in body) upd.ghi_chu = toStr(body.ghi_chu, 500);
    if (!Object.keys(upd).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    const thayDoi = layThayDoi(cur, upd);
    delete thayDoi.ten_khoa;
    const cols = Object.keys(upd).filter((c) => c === 'ten_khoa' || thayDoi[c]);
    if (!Object.keys(thayDoi).length) return res.json({ ok: true, changed: 0 });
    try {
      db.transaction(() => {
        db.prepare(`UPDATE nhm_nhom SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...cols.map((c) => upd[c]),
          id
        );
        // Nhóm đổi tên / trưởng nhóm / giải thể ảnh hưởng tới người duyệt yêu cầu mẫu: ghi vào lịch sử từng mẫu của nhóm
        const hienThi = { ...thayDoi };
        if (hienThi.truong_user_id) hienThi.truong_user_id = hienThi.truong_user_id.map(tenNguoi);
        const hanhDong = thayDoi.trang_thai && upd.trang_thai === 'giai_the' ? 'nhom_giai_the' : 'nhom_doi';
        logNhieuMau(mauCuaNhom(id), hanhDong, req.user.id, `Nhóm «${cur.ten}»: ${moTaThayDoi(hienThi)}`);
        thayDoi._hienThi = hienThi;
      })();
      if (ctx.dinhTuyenLai) ctx.dinhTuyenLai();
      audit(req, 'group_update', `id=${id} ${cur.ten}: ${moTaThayDoi(thayDoi._hienThi)}`);
      res.json({ ok: true, changed: cols.length });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Đã có nhóm trùng tên.');
      throw e;
    }
  });

  // Người được ghi là trưởng nhóm tự xác nhận (hoặc quản lý xác nhận thay)
  router.post('/groups/:id/confirm-leader', (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare("SELECT * FROM nhm_nhom WHERE id = ? AND trang_thai <> 'giai_the'").get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy nhóm.');
    if (!cur.truong_user_id) return fail(res, 409, 'Nhóm chưa có trưởng nhóm.');
    if (cur.truong_user_id !== req.user.id && !canManage(req)) return fail(res, 403, 'Chỉ người được ghi là trưởng nhóm hoặc quản lý mới xác nhận được.');
    if (cur.truong_xac_nhan) return res.json({ ok: true, changed: 0 });
    db.transaction(() => {
      db.prepare("UPDATE nhm_nhom SET truong_xac_nhan = 1, updated_at = datetime('now') WHERE id = ?").run(id);
      logNhieuMau(mauCuaNhom(id), 'nhom_truong_xac_nhan', req.user.id, `Nhóm «${cur.ten}»: ${tenNguoi(cur.truong_user_id)} xác nhận là trưởng nhóm`);
    })();
    if (ctx.dinhTuyenLai) ctx.dinhTuyenLai();
    audit(req, 'group_confirm_leader', `id=${id} ${cur.ten}: ${tenNguoi(cur.truong_user_id)}${cur.truong_user_id !== req.user.id ? ' (quản lý xác nhận thay)' : ''}`);
    res.json({ ok: true, changed: 1 });
  });

  // «Tôi không phải trưởng nhóm này»: nhóm trở lại chưa có trưởng nhóm, quản lý sẽ gán người khác
  router.post('/groups/:id/decline-leader', (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare("SELECT * FROM nhm_nhom WHERE id = ? AND trang_thai <> 'giai_the'").get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy nhóm.');
    if (cur.truong_user_id !== req.user.id) return fail(res, 403, 'Chỉ người được ghi là trưởng nhóm mới từ chối được.');
    db.transaction(() => {
      db.prepare("UPDATE nhm_nhom SET truong_user_id = NULL, truong_xac_nhan = 0, updated_at = datetime('now') WHERE id = ?").run(id);
      logNhieuMau(mauCuaNhom(id), 'nhom_truong_tu_choi', req.user.id, `Nhóm «${cur.ten}»: ${tenNguoi(req.user.id)} từ chối là trưởng nhóm`);
    })();
    if (ctx.dinhTuyenLai) ctx.dinhTuyenLai();
    audit(req, 'group_decline_leader', `id=${id} ${cur.ten}: ${tenNguoi(req.user.id)}`);
    res.json({ ok: true });
  });

  // Gộp nhóm trùng: mẫu và hồ sơ của nhóm nguồn chuyển sang nhóm đích, nhóm nguồn giải thể
  router.post('/groups/:id/merge', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const dich = toInt((req.body || {}).into_id);
    const nguon = id && db.prepare('SELECT * FROM nhm_nhom WHERE id = ?').get(id);
    const dichNhom = dich && db.prepare("SELECT * FROM nhm_nhom WHERE id = ? AND trang_thai <> 'giai_the'").get(dich);
    if (!nguon) return fail(res, 404, 'Không tìm thấy nhóm.');
    if (!dichNhom) return fail(res, 400, 'Nhóm đích không tồn tại hoặc đã giải thể.');
    if (nguon.id === dichNhom.id) return fail(res, 400, 'Không thể gộp nhóm vào chính nó.');
    const mau = mauCuaNhom(id);
    db.transaction(() => {
      db.prepare('UPDATE nhm_tubes SET nhom_id = ? WHERE nhom_id = ?').run(dich, id);
      db.prepare('UPDATE nhm_ho_so SET nhom_id = ? WHERE nhom_id = ?').run(dich, id);
      db.prepare("UPDATE nhm_nhom SET trang_thai = 'giai_the', ghi_chu = ?, updated_at = datetime('now') WHERE id = ?").run(`Đã gộp vào «${dichNhom.ten}»`, id);
      logNhieuMau(mau, 'nhom_gop', req.user.id, `Nhóm «${nguon.ten}» gộp vào «${dichNhom.ten}»`);
    })();
    audit(req, 'group_merge', `«${nguon.ten}» (id=${id}) → «${dichNhom.ten}» (id=${dich}), ${mau.length} mẫu`);
    res.json({ ok: true, mau: mau.length });
  });

  // ---------- Hồ sơ thành viên (loại + nhóm) do quản lý gán ----------

  router.get('/profiles', requireManage, (req, res) => {
    res.json({
      profiles: db
        .prepare(
          `SELECT h.user_id, h.loai, h.nhom_id, h.trang_thai, h.updated_at, u.fullname, u.email, g.ten AS nhom_ten
           FROM nhm_ho_so h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN nhm_nhom g ON g.id = h.nhom_id
           ORDER BY u.fullname COLLATE NOCASE`
        )
        .all(),
    });
  });

  router.put('/profiles/:userId', requireManage, (req, res) => {
    const userId = toInt(req.params.userId);
    const u = userId && db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!u) return fail(res, 404, 'Không tìm thấy người dùng.');
    const body = req.body || {};
    const cur = db.prepare('SELECT * FROM nhm_ho_so WHERE user_id = ?').get(userId);
    const loai = 'loai' in body ? body.loai : cur && cur.loai;
    if (!LOAI_CHU.includes(loai)) return fail(res, 400, 'Loại thành viên không hợp lệ (sinh viên, nghiên cứu viên, cán bộ).');
    const nhomId = 'nhom_id' in body ? (body.nhom_id == null || body.nhom_id === '' ? null : toInt(body.nhom_id)) : cur ? cur.nhom_id : null;
    if (nhomId != null && !db.prepare("SELECT 1 FROM nhm_nhom WHERE id = ? AND trang_thai <> 'giai_the'").get(nhomId)) {
      return fail(res, 400, 'Nhóm không tồn tại hoặc đã giải thể.');
    }
    if (loai !== 'can_bo' && nhomId == null) return fail(res, 400, 'Sinh viên và nghiên cứu viên phải thuộc một nhóm nghiên cứu.');
    const trangThai = 'trang_thai' in body ? body.trang_thai : cur ? cur.trang_thai : 'dang_hoat_dong';
    if (!['dang_hoat_dong', 'da_roi_di'].includes(trangThai)) return fail(res, 400, 'Trạng thái không hợp lệ.');
    db.transaction(() => {
      db.prepare(
        `INSERT INTO nhm_ho_so (user_id, loai, nhom_id, trang_thai, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET loai = excluded.loai, nhom_id = excluded.nhom_id, trang_thai = excluded.trang_thai,
                                            updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).run(userId, loai, nhomId, trangThai, req.user.id);
      // Người sở hữu rời đi / quay lại: ghi vào lịch sử mọi mẫu của họ (ai sẽ duyệt yêu cầu phụ thuộc vào đây)
      const truoc = cur ? cur.trang_thai : 'dang_hoat_dong';
      if (truoc !== trangThai) {
        const mau = db
          .prepare(`SELECT id FROM nhm_tubes WHERE owner_user_id = ? AND deleted_at IS NULL AND status IN ${HOLDING}`)
          .all(userId)
          .map((r) => r.id);
        logNhieuMau(
          mau,
          trangThai === 'da_roi_di' ? 'chu_roi_di' : 'chu_tro_lai',
          req.user.id,
          `${tenNguoi(userId)} ${trangThai === 'da_roi_di' ? 'đã rời đi (ra trường / nghỉ việc)' : 'hoạt động trở lại'}`
        );
      }
    })();
    if (ctx.dinhTuyenLai) ctx.dinhTuyenLai();
    audit(req, 'profile_set', `${tenNguoi(userId)} (id=${userId}): ${LOAI_CHU_VN[loai]}, nhóm ${nhomId || '—'}, ${trangThai}`);
    res.json({ ok: true });
  });

  return router;
};
