'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — yêu cầu lấy mẫu của người khác. 9 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 *   gửi → [chủ mẫu | trưởng nhóm | Trưởng CIPP | quản lý] duyệt / từ chối → quản lý giao → quản lý nhận lại
 *
 * Đường duyệt và quy tắc chuyển lên quản lý: services/nganHangTeBaoKhangTheYeuCau.js.
 * Quản lý module và admin luôn xử lý được; nếu không phải người duyệt ở cấp hiện tại thì là «xử lý thay» và BẮT BUỘC có lý do.
 * Không ai duyệt được yêu cầu của chính mình. Mọi bước ghi vào lịch sử của mẫu; email chạy nền, không làm hỏng thao tác chính.
 */

const express = require('express');
const { toInt, toStr } = require('../../services/nganHangTeBaoKhangThe');

const CHU_KY_QUET_MS = 30 * 60 * 1000;

module.exports = function createYeuCauRouter(ctx) {
  const { db, canManage, audit, fail, logMove, thongBao, guiNen, moTaViTri, nguoiDung, YeuCau } = ctx;
  const router = express.Router();
  const ten = (u) => (u ? u.fullname || u.email : '(không rõ)');

  const SELECT = `SELECT y.*, t.name AS mau_ten, t.box_id, t.row_no, t.col_no, t.status AS mau_status, t.owner_user_id, t.chu_loai, t.nhom_id,
                         (SELECT ten FROM nhm_nhom WHERE id = t.nhom_id) AS nhom_ten,
                         (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = y.nguoi_gui_id) AS nguoi_gui_ten,
                         (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = t.owner_user_id) AS chu_ten,
                         (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = y.xu_ly_boi) AS xu_ly_ten
                  FROM nhm_yeu_cau y JOIN nhm_tubes t ON t.id = y.tube_id`;

  const taiMau = (id) => db.prepare('SELECT * FROM nhm_tubes WHERE id = ?').get(id);

  /** Người dùng này duyệt được yêu cầu ở CẤP HIỆN TẠI không (được chỉ định, chưa tính quản lý xử lý thay)? */
  function laNguoiDuyet(req, yc, tube) {
    return YeuCau.nguoiDuyetHienTai(db, yc, tube).some((u) => u.id === req.user.id);
  }

  /** {coTheXuLy, thay} cho một yêu cầu đang chờ duyệt. */
  function quyenXuLy(req, yc, tube) {
    if (yc.nguoi_gui_id === req.user.id) return { coTheXuLy: false, thay: false };
    const dungCap = laNguoiDuyet(req, yc, tube);
    if (dungCap) return { coTheXuLy: true, thay: false };
    if (canManage(req)) return { coTheXuLy: true, thay: yc.cap !== 'quan_ly' };
    return { coTheXuLy: false, thay: false };
  }

  function dinhDang(req, y) {
    const tube = { owner_user_id: y.owner_user_id, nhom_id: y.nhom_id, box_id: y.box_id };
    const cho = y.trang_thai === 'cho_duyet';
    const q = cho ? quyenXuLy(req, y, tube) : { coTheXuLy: false, thay: false };
    return {
      id: y.id, tube_id: y.tube_id, mau_ten: y.mau_ten, mau_status: y.mau_status, vi_tri: moTaViTri(y.box_id, y.row_no, y.col_no),
      nguoi_gui_id: y.nguoi_gui_id, nguoi_gui_ten: y.nguoi_gui_ten, chu_ten: y.chu_ten, nhom_ten: y.nhom_ten, chu_loai: y.chu_loai,
      ly_do: y.ly_do, cap: y.cap, cap_ten: YeuCau.CAP_VN[y.cap], trang_thai: y.trang_thai, han_phan_hoi: y.han_phan_hoi,
      leo_thang_luc: y.leo_thang_luc, xu_ly_ten: y.xu_ly_ten, xu_ly_luc: y.xu_ly_luc, xu_ly_thay: !!y.xu_ly_thay, ly_do_xu_ly: y.ly_do_xu_ly,
      created_at: y.created_at,
      co_the_xu_ly: q.coTheXuLy, can_ly_do: q.coTheXuLy && q.thay, // xử lý thay: phải có lý do
      co_the_huy: y.nguoi_gui_id === req.user.id && (y.trang_thai === 'cho_duyet' || y.trang_thai === 'da_duyet'),
      co_the_giao: canManage(req) && y.trang_thai === 'da_duyet',
      co_the_nhan_lai: canManage(req) && y.trang_thai === 'da_giao',
    };
  }

  // ---------- gửi yêu cầu ----------

  router.post('/tubes/:id/requests', (req, res) => {
    const id = toInt(req.params.id);
    const tube = id && db.prepare('SELECT * FROM nhm_tubes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!tube) return fail(res, 404, 'Không tìm thấy mẫu.');
    const hs = db.prepare('SELECT trang_thai FROM nhm_ho_so WHERE user_id = ?').get(req.user.id);
    if (hs && hs.trang_thai === 'da_roi_di') return fail(res, 403, 'Hồ sơ của bạn được đánh dấu đã rời đi. Liên hệ quản lý module.');
    if (tube.owner_user_id === req.user.id) return fail(res, 400, 'Đây là mẫu của bạn: dùng «Lấy ra» thay vì gửi yêu cầu.');
    if (tube.status !== 'in_storage') return fail(res, 409, 'Chỉ xin được mẫu đang lưu kho.');
    if (db.prepare("SELECT 1 FROM nhm_vu_viec WHERE tube_id = ? AND trang_thai IN ('mo','cho_chu_xac_nhan')").get(id)) {
      return fail(res, 409, 'Mẫu này đang bị báo nghi mất, chưa xin lấy được.');
    }
    if (db.prepare("SELECT 1 FROM nhm_yeu_cau WHERE tube_id = ? AND trang_thai IN ('cho_duyet','da_duyet','da_giao')").get(id)) {
      return fail(res, 409, 'Mẫu này đang có một yêu cầu khác chưa xong.');
    }
    const lyDo = toStr((req.body || {}).ly_do, 500);
    if (!lyDo) return fail(res, 400, 'Hãy ghi lý do / mục đích xin mẫu.');
    const { cap, nguoiDuyet } = YeuCau.xacDinhCap(db, tube, req.user.id);
    const han = YeuCau.sauNgay(YeuCau.HAN.PHAN_HOI_NGAY);
    const yeuCauId = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO nhm_yeu_cau (tube_id, nguoi_gui_id, ly_do, cap, han_phan_hoi) VALUES (?, ?, ?, ?, ?)')
        .run(id, req.user.id, lyDo, cap, han);
      logMove(id, 'yc_gui', null, null, req.user.id, `Yêu cầu #${info.lastInsertRowid} (${YeuCau.CAP_VN[cap]} duyệt): ${lyDo}`);
      return Number(info.lastInsertRowid);
    })();
    audit(req, 'request_create', `#${yeuCauId} mẫu id=${id} ${tube.name} → cấp ${cap}`);
    const yc = { id: yeuCauId, cap, ly_do: lyDo };
    guiNen(thongBao.yeuCauMoi({ yc, tube, nguoiGui: nguoiDung(req.user.id), duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no), nguoiDuyet }));
    res.status(201).json({ id: yeuCauId, cap, cap_ten: YeuCau.CAP_VN[cap], han_phan_hoi: han });
  });

  // ---------- danh sách ----------

  /**
   * view=mine   yêu cầu tôi gửi
   * view=inbox  yêu cầu tôi cần xử lý (người duyệt cấp hiện tại; quản lý thấy cả yêu cầu đã duyệt chờ giao / đã giao chờ nhận lại)
   * view=all    mọi yêu cầu (chỉ quản lý)
   */
  router.get('/requests', (req, res) => {
    const view = req.query.view === 'inbox' || req.query.view === 'all' ? req.query.view : 'mine';
    if (view === 'all' && !canManage(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới xem được mọi yêu cầu.');
    const dongMo = "y.trang_thai IN ('cho_duyet','da_duyet','da_giao')";
    let rows;
    if (view === 'mine') rows = db.prepare(`${SELECT} WHERE y.nguoi_gui_id = ? ORDER BY y.id DESC LIMIT 200`).all(req.user.id);
    else if (view === 'all') rows = db.prepare(`${SELECT} ORDER BY y.id DESC LIMIT 500`).all();
    else rows = db.prepare(`${SELECT} WHERE ${dongMo} ORDER BY y.id DESC LIMIT 500`).all();
    let items = rows.map((y) => dinhDang(req, y));
    if (view === 'inbox') items = items.filter((x) => x.co_the_xu_ly || x.co_the_giao || x.co_the_nhan_lai);
    res.json({ requests: items });
  });

  // ---------- xử lý ----------

  function layYeuCau(req, res) {
    const id = toInt(req.params.id);
    const y = id && db.prepare(`${SELECT} WHERE y.id = ?`).get(id);
    if (!y) {
      fail(res, 404, 'Không tìm thấy yêu cầu.');
      return null;
    }
    return y;
  }

  /** Dùng chung cho duyệt / từ chối. */
  function xuLy(req, res, ketQua) {
    const y = layYeuCau(req, res);
    if (!y) return;
    const tube = taiMau(y.tube_id);
    if (y.trang_thai !== 'cho_duyet') return fail(res, 409, 'Yêu cầu này đã được xử lý.');
    if (y.nguoi_gui_id === req.user.id) return fail(res, 403, 'Bạn không thể tự xử lý yêu cầu của chính mình.');
    const q = quyenXuLy(req, y, tube);
    if (!q.coTheXuLy) return fail(res, 403, 'Bạn không phải người duyệt yêu cầu này.');
    const lyDo = toStr((req.body || {}).ly_do, 500);
    if (q.thay && (!lyDo || lyDo.length < 5)) return fail(res, 400, 'Xử lý thay người duyệt phải ghi lý do (ít nhất 5 ký tự).');
    if (ketQua === 'tu_choi' && !lyDo) return fail(res, 400, 'Từ chối phải ghi lý do.');
    db.transaction(() => {
      db.prepare(
        `UPDATE nhm_yeu_cau SET trang_thai = ?, xu_ly_boi = ?, xu_ly_luc = datetime('now'), xu_ly_thay = ?, ly_do_xu_ly = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(ketQua === 'duyet' ? 'da_duyet' : 'tu_choi', req.user.id, q.thay ? 1 : 0, lyDo, y.id);
      logMove(y.tube_id, ketQua === 'duyet' ? 'yc_duyet' : 'yc_tu_choi', null, null, req.user.id,
        `Yêu cầu #${y.id} của ${y.nguoi_gui_ten}${q.thay ? ` — xử lý thay ${YeuCau.CAP_VN[y.cap]}` : ''}${lyDo ? ': ' + lyDo : ''}`);
    })();
    audit(req, ketQua === 'duyet' ? 'request_approve' : 'request_reject', `#${y.id} mẫu id=${y.tube_id}${q.thay ? ' (xử lý thay)' : ''}${lyDo ? ' — ' + lyDo : ''}`);
    const moi = { ...y, ly_do_xu_ly: lyDo };
    const nguoiXuLy = nguoiDung(req.user.id);
    const duongDan = moTaViTri(tube.box_id, tube.row_no, tube.col_no);
    const nguoiGui = nguoiDung(y.nguoi_gui_id);
    guiNen(ketQua === 'duyet'
      ? thongBao.yeuCauDaDuyet({ yc: moi, tube, nguoiGui, nguoiXuLy, duongDan, xuLyThay: q.thay })
      : thongBao.yeuCauTuChoi({ yc: moi, tube, nguoiGui, nguoiXuLy, duongDan }));
    res.json({ ok: true, trang_thai: ketQua === 'duyet' ? 'da_duyet' : 'tu_choi', xu_ly_thay: q.thay });
  }

  router.post('/requests/:id/approve', (req, res) => xuLy(req, res, 'duyet'));
  router.post('/requests/:id/reject', (req, res) => xuLy(req, res, 'tu_choi'));

  router.post('/requests/:id/cancel', (req, res) => {
    const y = layYeuCau(req, res);
    if (!y) return;
    if (y.nguoi_gui_id !== req.user.id) return fail(res, 403, 'Chỉ người gửi mới hủy được yêu cầu.');
    if (y.trang_thai !== 'cho_duyet' && y.trang_thai !== 'da_duyet') return fail(res, 409, 'Yêu cầu này không còn hủy được.');
    db.transaction(() => {
      db.prepare("UPDATE nhm_yeu_cau SET trang_thai = 'da_huy', xu_ly_boi = ?, xu_ly_luc = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(req.user.id, y.id);
      logMove(y.tube_id, 'yc_huy', null, null, req.user.id, `Người gửi hủy yêu cầu #${y.id}`);
    })();
    audit(req, 'request_cancel', `#${y.id} mẫu id=${y.tube_id}`);
    res.json({ ok: true });
  });

  // Quản lý giao mẫu cho người xin (mẫu chuyển «đã lấy ra»), rồi nhận lại
  router.post('/requests/:id/deliver', (req, res) => {
    if (!canManage(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới giao mẫu.');
    const y = layYeuCau(req, res);
    if (!y) return;
    if (y.trang_thai !== 'da_duyet') return fail(res, 409, 'Chỉ giao được mẫu của yêu cầu đã duyệt.');
    const tube = taiMau(y.tube_id);
    if (tube.status !== 'in_storage') return fail(res, 409, 'Mẫu không còn ở trạng thái đang lưu kho.');
    db.transaction(() => {
      db.prepare("UPDATE nhm_tubes SET status = 'checked_out', updated_at = datetime('now') WHERE id = ?").run(y.tube_id);
      db.prepare("UPDATE nhm_yeu_cau SET trang_thai = 'da_giao', updated_at = datetime('now') WHERE id = ?").run(y.id);
      logMove(y.tube_id, 'giao', tube.box_id ? tube : null, null, req.user.id, `Giao cho ${y.nguoi_gui_ten} (yêu cầu #${y.id})`);
    })();
    audit(req, 'request_deliver', `#${y.id} mẫu id=${y.tube_id} → ${y.nguoi_gui_ten}`);
    guiNen(thongBao.yeuCauGiaoTra({ tube, nguoiGui: nguoiDung(y.nguoi_gui_id), nguoiXuLy: nguoiDung(req.user.id), duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no), hanhDong: 'giao' }));
    res.json({ ok: true });
  });

  router.post('/requests/:id/return', (req, res) => {
    if (!canManage(req)) return fail(res, 403, 'Chỉ Admin hoặc Quản lý module mới nhận lại mẫu.');
    const y = layYeuCau(req, res);
    if (!y) return;
    if (y.trang_thai !== 'da_giao') return fail(res, 409, 'Chỉ nhận lại được mẫu đang giao.');
    const tube = taiMau(y.tube_id);
    db.transaction(() => {
      db.prepare("UPDATE nhm_tubes SET status = 'in_storage', updated_at = datetime('now') WHERE id = ?").run(y.tube_id);
      db.prepare("UPDATE nhm_yeu_cau SET trang_thai = 'da_tra', updated_at = datetime('now') WHERE id = ?").run(y.id);
      logMove(y.tube_id, 'tra', null, tube.box_id ? tube : null, req.user.id, `Nhận lại từ ${y.nguoi_gui_ten} (yêu cầu #${y.id})`);
    })();
    audit(req, 'request_return', `#${y.id} mẫu id=${y.tube_id}`);
    guiNen(thongBao.yeuCauGiaoTra({ tube, nguoiGui: nguoiDung(y.nguoi_gui_id), nguoiXuLy: nguoiDung(req.user.id), duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no), hanhDong: 'tra' }));
    res.json({ ok: true });
  });

  // ---------- tự chuyển cấp khi quá hạn, và định tuyến lại khi người duyệt rời đi ----------

  /** Chuyển lên quản lý các yêu cầu cấp dưới đã quá hạn phản hồi. `ms` để test điều khiển được thời gian. */
  async function quetQuaHan(ms = Date.now()) {
    const hanNay = YeuCau.bayGio(ms);
    const ds = db.prepare(`${SELECT} WHERE y.trang_thai = 'cho_duyet' AND y.cap <> 'quan_ly' AND y.han_phan_hoi <= ?`).all(hanNay);
    let leoThang = 0;
    for (const y of ds) {
      const ok = db.transaction(() => {
        const r = db
          .prepare("UPDATE nhm_yeu_cau SET cap = 'quan_ly', leo_thang_luc = datetime('now'), updated_at = datetime('now') WHERE id = ? AND trang_thai = 'cho_duyet' AND cap = ?")
          .run(y.id, y.cap);
        if (!r.changes) return false;
        logMove(y.tube_id, 'yc_leo_thang', null, null, null, `Yêu cầu #${y.id}: ${YeuCau.CAP_VN[y.cap]} quá hạn phản hồi ${YeuCau.HAN.PHAN_HOI_NGAY} ngày, chuyển quản lý module`);
        return true;
      })();
      if (!ok) continue;
      leoThang++;
      const tube = taiMau(y.tube_id);
      guiNen(thongBao.yeuCauLeoThang({ yc: { ...y, cap: 'quan_ly' }, tube, nguoiGui: nguoiDung(y.nguoi_gui_id), duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no), capCu: y.cap }));
    }
    return { leoThang };
  }

  /** Tính lại cấp duyệt của các yêu cầu đang chờ (chủ mẫu / trưởng nhóm vừa rời đi, nhóm đổi trưởng nhóm...). */
  function dinhTuyenLai() {
    const ds = db.prepare(`${SELECT} WHERE y.trang_thai = 'cho_duyet'`).all();
    let doi = 0;
    for (const y of ds) {
      const tube = taiMau(y.tube_id);
      const moi = YeuCau.xacDinhCap(db, tube, y.nguoi_gui_id);
      if (moi.cap === y.cap) continue;
      db.transaction(() => {
        db.prepare("UPDATE nhm_yeu_cau SET cap = ?, han_phan_hoi = ?, updated_at = datetime('now') WHERE id = ? AND trang_thai = 'cho_duyet'").run(moi.cap, YeuCau.sauNgay(YeuCau.HAN.PHAN_HOI_NGAY), y.id);
        logMove(y.tube_id, 'yc_dinh_tuyen_lai', null, null, null, `Yêu cầu #${y.id}: ${YeuCau.CAP_VN[y.cap]} → ${YeuCau.CAP_VN[moi.cap]} (người duyệt thay đổi)`);
      })();
      doi++;
      guiNen(thongBao.yeuCauMoi({ yc: { ...y, cap: moi.cap }, tube, nguoiGui: nguoiDung(y.nguoi_gui_id), duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no), nguoiDuyet: moi.nguoiDuyet }));
    }
    return doi;
  }

  ctx.quetQuaHan = quetQuaHan;
  ctx.dinhTuyenLai = dinhTuyenLai;
  ctx.CHU_KY_QUET_MS = CHU_KY_QUET_MS;
  ctx.dinhDangYeuCau = dinhDang;
  ctx.demYeuCau = (req) => {
    const mine = db.prepare("SELECT COUNT(*) AS c FROM nhm_yeu_cau WHERE nguoi_gui_id = ? AND trang_thai IN ('cho_duyet','da_duyet','da_giao')").get(req.user.id).c;
    const inbox = db.prepare(`${SELECT} WHERE y.trang_thai IN ('cho_duyet','da_duyet','da_giao')`).all().map((y) => dinhDang(req, y)).filter((x) => x.co_the_xu_ly || x.co_the_giao || x.co_the_nhan_lai).length;
    return { mine, inbox };
  };

  return router;
};
