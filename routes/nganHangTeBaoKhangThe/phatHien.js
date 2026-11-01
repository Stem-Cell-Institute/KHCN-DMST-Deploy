'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — hai tình huống ở thiết bị CÔNG KHAI mà phần mềm không ngăn được ngoài đời thật:
 *
 *   1. Mẫu CÓ THẬT trong ô nhưng KHÔNG có thông tin (người dùng tự để vào, không khai báo)  → «phát hiện»
 *      quản lý đánh dấu ô → NHẮC chủ mẫu trước → chủ mẫu nhận và khai báo → hết hạn chờ thì quản lý mới được bỏ mẫu.
 *   2. Mẫu CÓ trong sổ nhưng KHÔNG thấy trong ô (bị lấy không xin phép)                       → «vụ việc nghi mất»
 *      chủ mẫu báo hoặc quản lý kiểm kê hộp → ai đã lấy có thể tự nhận → chủ mẫu xác nhận (tính vào số lần vi phạm) →
 *      hết hạn không ai nhận thì quản lý chốt thất lạc.
 *
 * 18 endpoint. Hạn chờ nằm ở services/nganHangTeBaoKhangTheYeuCau.js (layHan). Mọi bước ghi lịch sử (của ô cho «phát hiện»,
 * của mẫu cho «nghi mất»); email chạy nền.
 */

const express = require('express');
const { HOLDING, toInt, toStr, isUniqueError } = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createPhatHienRouter(ctx) {
  const { db, canManage, laAdmin, canEditTube, requireManage, audit, fail, logMove, thongBao, guiNen, moTaViTri, nguoiDung, nhanNguoi, YeuCau } = ctx;
  const router = express.Router();
  const ten = (u) => (u ? u.fullname || u.email : '(không rõ)');
  const hanDen = (s) => String(s || '') <= YeuCau.bayGio();

  // ═══ 1. MẪU CHƯA KHAI BÁO ═══════════════════════════════════════════════════════════════════════════════════════

  function ghiLs(phId, action, userId, note) {
    db.prepare('INSERT INTO nhm_phat_hien_ls (phat_hien_id, action, user_id, user_label, note) VALUES (?, ?, ?, ?, ?)').run(phId, action, userId || null, nhanNguoi(userId), note || null);
  }

  const SELECT_PH = `SELECT p.*, b.code AS box_code,
                            (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = p.nghi_user_id) AS nghi_ten,
                            (SELECT ten FROM nhm_nhom WHERE id = p.nghi_nhom_id) AS nghi_nhom_ten,
                            (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = p.nguoi_phat_hien_id) AS phat_hien_ten
                     FROM nhm_phat_hien p JOIN nhm_boxes b ON b.id = p.box_id`;

  /** Ngày sớm nhất quản lý được bỏ mẫu: lần nhắc ĐẦU + hạn bỏ mẫu (cấu hình); chưa nhắc thì chưa có. */
  function hanBo(p) {
    if (!p.nhac_dau_luc) return null;
    const t = new Date(p.nhac_dau_luc.replace(' ', 'T') + 'Z').getTime();
    return YeuCau.sauNgay(YeuCau.layHan(db).CHO_BO_NGAY, t);
  }

  function dinhDangPh(req, p) {
    const han = hanBo(p);
    const mo = p.trang_thai === 'cho_chu_mau';
    return {
      id: p.id, box_id: p.box_id, box_code: p.box_code, row_no: p.row_no, col_no: p.col_no, vi_tri: moTaViTri(p.box_id, p.row_no, p.col_no),
      mo_ta: p.mo_ta, nghi_ten: p.nghi_ten, nghi_nhom_ten: p.nghi_nhom_ten, phat_hien_ten: p.phat_hien_ten, trang_thai: p.trang_thai,
      nhac_lan: p.nhac_lan, nhac_dau_luc: p.nhac_dau_luc, nhac_cuoi_luc: p.nhac_cuoi_luc, han_bo: han, created_at: p.created_at,
      tube_id: p.tube_id, bo_som: !!p.bo_som, ly_do_xu_ly: p.ly_do_xu_ly,
      // quản lý bỏ được khi đã nhắc và hết hạn chờ; admin bỏ sớm hơn được
      co_the_bo: mo && canManage(req) && !!han && (hanDen(han) || laAdmin(req)),
      bo_som_duoc: mo && canManage(req) && !!han && !hanDen(han) && laAdmin(req),
    };
  }

  router.post('/findings', requireManage, (req, res) => {
    const body = req.body || {};
    const boxId = toInt(body.box_id);
    const row = toInt(body.row_no);
    const col = toInt(body.col_no);
    const moTa = toStr(body.mo_ta, 500);
    if (!moTa) return fail(res, 400, 'Mô tả mẫu (chữ trên ống, màu nắp, hộp con...) là bắt buộc.');
    const box = boxId && db.prepare('SELECT id, rows, cols FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(boxId);
    if (!box) return fail(res, 400, 'Hộp không tồn tại.');
    if (!row || !col || row < 1 || row > box.rows || col < 1 || col > box.cols) return fail(res, 400, 'Vị trí nằm ngoài lưới của hộp.');
    if (ctx.hopTrongCellbank(boxId)) return fail(res, 400, 'Thiết bị này có đơn vị quản lý (mẫu chỉ ra vào qua yêu cầu được duyệt), không dùng chức năng này.');
    if (db.prepare(`SELECT 1 FROM nhm_tubes WHERE box_id = ? AND row_no = ? AND col_no = ? AND deleted_at IS NULL AND status IN ${HOLDING}`).get(boxId, row, col)) {
      return fail(res, 409, 'Ô này đã có mẫu trong sổ.');
    }
    const nghiUser = body.nghi_user_id == null || body.nghi_user_id === '' ? null : toInt(body.nghi_user_id);
    if (nghiUser != null && !nguoiDung(nghiUser)) return fail(res, 400, 'Người được gợi ý là chủ mẫu không tồn tại.');
    const nghiNhom = body.nghi_nhom_id == null || body.nghi_nhom_id === '' ? null : toInt(body.nghi_nhom_id);
    if (nghiNhom != null && !db.prepare('SELECT 1 FROM nhm_nhom WHERE id = ?').get(nghiNhom)) return fail(res, 400, 'Nhóm được gợi ý là chủ mẫu không tồn tại.');
    try {
      const id = db.transaction(() => {
        const info = db
          .prepare('INSERT INTO nhm_phat_hien (box_id, row_no, col_no, mo_ta, nghi_user_id, nghi_nhom_id, nguoi_phat_hien_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(boxId, row, col, moTa, nghiUser, nghiNhom, req.user.id);
        ghiLs(info.lastInsertRowid, 'phat_hien', req.user.id, moTa);
        return Number(info.lastInsertRowid);
      })();
      audit(req, 'finding_create', `#${id} ${moTaViTri(boxId, row, col)}: ${moTa}`);
      res.status(201).json({ id });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Ô này đã được đánh dấu mẫu chưa khai báo.');
      throw e;
    }
  });

  router.get('/findings', (req, res) => {
    const tatCa = req.query.status === 'all' && canManage(req);
    const rows = db.prepare(`${SELECT_PH} ${tatCa ? '' : "WHERE p.trang_thai = 'cho_chu_mau'"} ORDER BY p.id DESC LIMIT 300`).all();
    res.json({ findings: rows.map((p) => dinhDangPh(req, p)) });
  });

  router.get('/findings/:id', (req, res) => {
    const id = toInt(req.params.id);
    const p = id && db.prepare(`${SELECT_PH} WHERE p.id = ?`).get(id);
    if (!p) return fail(res, 404, 'Không tìm thấy mục phát hiện.');
    const lichSu = db.prepare('SELECT action, user_label, note, at FROM nhm_phat_hien_ls WHERE phat_hien_id = ? ORDER BY id DESC').all(id);
    res.json({ finding: dinhDangPh(req, p), history: lichSu });
  });

  /** Những người được nhắc: người nghi là chủ + trưởng nhóm của họ; hoặc nhóm nghi: trưởng nhóm + thành viên đang hoạt động. */
  function nguoiNhacCua(p) {
    const ds = [];
    const them = (u) => u && ds.push(u);
    if (p.nghi_user_id) {
      them(YeuCau.nguoiConHoatDong(db, p.nghi_user_id));
      const hs = db.prepare('SELECT nhom_id FROM nhm_ho_so WHERE user_id = ?').get(p.nghi_user_id);
      if (hs && hs.nhom_id) them(YeuCau.truongNhomHieuLuc(db, hs.nhom_id));
    }
    if (p.nghi_nhom_id) {
      them(YeuCau.truongNhomHieuLuc(db, p.nghi_nhom_id));
      db.prepare("SELECT user_id FROM nhm_ho_so WHERE nhom_id = ? AND trang_thai = 'dang_hoat_dong'").all(p.nghi_nhom_id).forEach((r) => them(YeuCau.nguoiConHoatDong(db, r.user_id)));
    }
    return ds;
  }

  router.post('/findings/:id/remind', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const p = id && db.prepare(`${SELECT_PH} WHERE p.id = ?`).get(id);
    if (!p) return fail(res, 404, 'Không tìm thấy mục phát hiện.');
    if (p.trang_thai !== 'cho_chu_mau') return fail(res, 409, 'Mục này đã được xử lý.');
    const ds = nguoiNhacCua(p);
    db.transaction(() => {
      db.prepare(
        `UPDATE nhm_phat_hien SET nhac_lan = nhac_lan + 1, nhac_dau_luc = COALESCE(nhac_dau_luc, datetime('now')), nhac_cuoi_luc = datetime('now') WHERE id = ?`
      ).run(id);
      ghiLs(id, 'nhac', req.user.id, ds.length ? `Gửi email tới ${ds.map(ten).join(', ')}` : 'Không biết chủ mẫu: nhắc trên bảng «Mẫu chưa khai báo»');
    })();
    audit(req, 'finding_remind', `#${id} ${moTaViTri(p.box_id, p.row_no, p.col_no)} → ${ds.length} người`);
    const moi = db.prepare('SELECT * FROM nhm_phat_hien WHERE id = ?').get(id);
    guiNen(thongBao.nhacKhaiBao({ ph: p, nguoiNhan: ds, duongDan: moTaViTri(p.box_id, p.row_no, p.col_no), nguoiNhac: nguoiDung(req.user.id), lanThu: moi.nhac_lan }));
    res.json({ ok: true, nhac_lan: moi.nhac_lan, nguoi_nhan: ds.length, han_bo: hanBo(moi) });
  });

  // Chủ mẫu nhận và khai báo: tạo bản ghi mẫu NGAY tại ô, người nhận là chủ sở hữu
  router.post('/findings/:id/claim', (req, res) => {
    const id = toInt(req.params.id);
    const p = id && db.prepare(`${SELECT_PH} WHERE p.id = ?`).get(id);
    if (!p) return fail(res, 404, 'Không tìm thấy mục phát hiện.');
    if (p.trang_thai !== 'cho_chu_mau') return fail(res, 409, 'Mẫu này đã được nhận hoặc xử lý.');
    const kit = ctx.tubeKit;
    const body = req.body || {};
    const [t, loi] = kit.readTubeBody(body);
    if (loi) return fail(res, 400, loi);
    if (!t.name) return fail(res, 400, 'Thiếu tên mẫu.');
    if (t.sample_type_id != null && !db.prepare('SELECT 1 FROM nhm_sample_types WHERE id = ?').get(t.sample_type_id)) return fail(res, 400, 'Loại mẫu không hợp lệ.');
    const chu = kit.xacDinhChuMau(req, body);
    if (chu.loi) return fail(res, chu.status, chu.loi);
    const bad = kit.checkPosition(p.box_id, p.row_no, p.col_no, 0, id);
    if (bad) return fail(res, bad.status, bad.message);
    const tubeId = db.transaction(() => {
      const tid = kit.insertTube(t, chu, p.box_id, p.row_no, p.col_no, req.user.id);
      db.prepare("UPDATE nhm_phat_hien SET trang_thai = 'da_khai_bao', tube_id = ?, xu_ly_boi = ?, xu_ly_luc = datetime('now') WHERE id = ?").run(tid, req.user.id, id);
      logMove(tid, 'khai_bao_bo_sung', null, null, req.user.id, `Khai báo bổ sung mẫu từng bị đánh dấu chưa khai báo (#${id}: ${p.mo_ta})`);
      ghiLs(id, 'da_khai_bao', req.user.id, `Mẫu #${tid} «${t.name}»`);
      return tid;
    })();
    audit(req, 'finding_claim', `#${id} → mẫu id=${tubeId} ${t.name}`);
    guiNen(thongBao.daKhaiBao({ ph: p, tube: { name: t.name }, nguoiKhai: nguoiDung(req.user.id), duongDan: moTaViTri(p.box_id, p.row_no, p.col_no) }));
    res.status(201).json({ ok: true, tube_id: tubeId });
  });

  // Bỏ mẫu: chỉ sau khi ĐÃ nhắc và hết hạn chờ; admin bỏ sớm hơn được nhưng ghi rõ «bỏ sớm»
  router.post('/findings/:id/discard', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const p = id && db.prepare(`${SELECT_PH} WHERE p.id = ?`).get(id);
    if (!p) return fail(res, 404, 'Không tìm thấy mục phát hiện.');
    if (p.trang_thai !== 'cho_chu_mau') return fail(res, 409, 'Mục này đã được xử lý.');
    const lyDo = toStr((req.body || {}).ly_do, 500);
    if (!lyDo || lyDo.length < 5) return fail(res, 400, 'Phải ghi lý do bỏ mẫu (ít nhất 5 ký tự).');
    if (!p.nhac_lan) return fail(res, 409, 'Việc đầu tiên là nhắc chủ mẫu cập nhật thông tin: hãy bấm «Nhắc chủ mẫu» trước khi bỏ mẫu.');
    const han = hanBo(p);
    const som = !hanDen(han);
    if (som && !laAdmin(req)) return fail(res, 409, `Chưa hết hạn chờ: chỉ bỏ mẫu được từ ${han} (UTC), ${YeuCau.layHan(db).CHO_BO_NGAY} ngày sau lần nhắc đầu tiên.`);
    db.transaction(() => {
      db.prepare("UPDATE nhm_phat_hien SET trang_thai = 'da_bo', xu_ly_boi = ?, xu_ly_luc = datetime('now'), bo_som = ?, ly_do_xu_ly = ? WHERE id = ?").run(req.user.id, som ? 1 : 0, lyDo, id);
      ghiLs(id, som ? 'da_bo_som' : 'da_bo', req.user.id, lyDo);
    })();
    audit(req, 'finding_discard', `#${id} ${moTaViTri(p.box_id, p.row_no, p.col_no)}${som ? ' (bỏ sớm, admin)' : ''}: ${lyDo}`);
    res.json({ ok: true, bo_som: som });
  });

  router.post('/findings/:id/cancel', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const p = id && db.prepare(`${SELECT_PH} WHERE p.id = ?`).get(id);
    if (!p) return fail(res, 404, 'Không tìm thấy mục phát hiện.');
    if (p.trang_thai !== 'cho_chu_mau') return fail(res, 409, 'Mục này đã được xử lý.');
    const lyDo = toStr((req.body || {}).ly_do, 500) || 'Đánh dấu nhầm';
    db.transaction(() => {
      db.prepare("UPDATE nhm_phat_hien SET trang_thai = 'da_huy', xu_ly_boi = ?, xu_ly_luc = datetime('now'), ly_do_xu_ly = ? WHERE id = ?").run(req.user.id, lyDo, id);
      ghiLs(id, 'da_huy', req.user.id, lyDo);
    })();
    audit(req, 'finding_cancel', `#${id}: ${lyDo}`);
    res.json({ ok: true });
  });

  // ═══ 2. MẪU NGHI MẤT / BỊ LẤY KHÔNG XIN PHÉP ═══════════════════════════════════════════════════════════════════

  const taiMau = (id) => db.prepare('SELECT * FROM nhm_tubes WHERE id = ? AND deleted_at IS NULL').get(id);
  const laTruongNhomCua = (req, tube) => {
    const t = YeuCau.truongNhomHieuLuc(db, tube.nhom_id);
    return !!t && t.id === req.user.id;
  };
  /** Người có quyền xử lý vụ việc của mẫu: chủ mẫu, trưởng nhóm có hiệu lực (mẫu sinh viên / chủ đã rời đi), quản lý. */
  const coQuyenVuViec = (req, tube) => canEditTube(req, tube) || laTruongNhomCua(req, tube);

  const SELECT_VV = `SELECT v.*, t.name AS mau_ten, t.box_id, t.row_no, t.col_no, t.owner_user_id, t.nhom_id, t.chu_loai, t.status AS mau_status,
                            (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = v.nguoi_bao_id) AS nguoi_bao_ten,
                            (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = v.nguoi_nhan_id) AS nguoi_nhan_ten,
                            (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = t.owner_user_id) AS chu_ten
                     FROM nhm_vu_viec v JOIN nhm_tubes t ON t.id = v.tube_id`;

  function dinhDangVv(req, v) {
    const tube = { owner_user_id: v.owner_user_id, nhom_id: v.nhom_id };
    const mo = v.trang_thai === 'mo' || v.trang_thai === 'cho_chu_xac_nhan';
    const quyen = coQuyenVuViec(req, tube);
    return {
      id: v.id, tube_id: v.tube_id, mau_ten: v.mau_ten, vi_tri: moTaViTri(v.box_id, v.row_no, v.col_no), chu_ten: v.chu_ten, nguon: v.nguon,
      mo_ta: v.mo_ta, trang_thai: v.trang_thai, nguoi_bao_ten: v.nguoi_bao_ten, nguoi_nhan_ten: v.nguoi_nhan_ten, nhan_ghi_chu: v.nhan_ghi_chu,
      han_nhan: v.han_nhan, created_at: v.created_at, ly_do_xu_ly: v.ly_do_xu_ly,
      co_the_nhan_lay: v.trang_thai === 'mo' && v.owner_user_id !== req.user.id,
      co_the_xac_nhan: v.trang_thai === 'cho_chu_xac_nhan' && quyen && v.nguoi_nhan_id !== req.user.id,
      co_the_tim_thay: mo && quyen,
      co_the_tu_lay: mo && v.owner_user_id === req.user.id,
      co_the_chot_that_lac: mo && canManage(req) && (hanDen(v.han_nhan) || laAdmin(req)),
    };
  }

  router.post('/tubes/:id/report-missing', (req, res) => {
    const id = toInt(req.params.id);
    const tube = id && taiMau(id);
    if (!tube) return fail(res, 404, 'Không tìm thấy mẫu.');
    if (!coQuyenVuViec(req, tube)) return fail(res, 403, 'Chỉ chủ mẫu, trưởng nhóm hoặc quản lý mới báo mẫu không còn ở vị trí.');
    if (tube.status !== 'in_storage') return fail(res, 409, 'Chỉ báo mất được mẫu đang ghi là lưu kho.');
    const moTa = toStr((req.body || {}).mo_ta, 500);
    try {
      const vvId = db.transaction(() => {
        const info = db
          .prepare('INSERT INTO nhm_vu_viec (tube_id, nguon, nguoi_bao_id, mo_ta, han_nhan) VALUES (?, ?, ?, ?, ?)')
          .run(id, tube.owner_user_id === req.user.id ? 'chu_mau' : 'quan_ly', req.user.id, moTa, YeuCau.sauNgay(YeuCau.layHan(db).CHO_NHAN_NGAY));
        logMove(id, 'bao_mat', tube.box_id ? tube : null, null, req.user.id, `Vụ việc #${info.lastInsertRowid}: báo mẫu không còn ở vị trí${moTa ? ' — ' + moTa : ''}`);
        return Number(info.lastInsertRowid);
      })();
      audit(req, 'incident_report', `#${vvId} mẫu id=${id} ${tube.name}`);
      guiNen(thongBao.nghiMat({ vv: { nguon: 'chu_mau', mo_ta: moTa }, tube, nguoiBao: nguoiDung(req.user.id), duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no) }));
      res.status(201).json({ id: vvId });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mẫu này đã có vụ việc đang mở.');
      throw e;
    }
  });

  router.get('/incidents', (req, res) => {
    const tatCa = req.query.status === 'all' && canManage(req);
    const rows = db.prepare(`${SELECT_VV} ${tatCa ? '' : "WHERE v.trang_thai IN ('mo','cho_chu_xac_nhan')"} ORDER BY v.id DESC LIMIT 300`).all();
    res.json({ incidents: rows.map((v) => dinhDangVv(req, v)) });
  });

  function layVv(req, res) {
    const id = toInt(req.params.id);
    const v = id && db.prepare(`${SELECT_VV} WHERE v.id = ?`).get(id);
    if (!v) {
      fail(res, 404, 'Không tìm thấy vụ việc.');
      return null;
    }
    return v;
  }

  // «Tôi đã lấy mẫu này» — người lấy tự nhận
  router.post('/incidents/:id/taken', (req, res) => {
    const v = layVv(req, res);
    if (!v) return;
    if (v.trang_thai !== 'mo') return fail(res, 409, 'Vụ việc này không còn nhận người lấy.');
    if (v.owner_user_id === req.user.id) return fail(res, 400, 'Đây là mẫu của bạn.');
    const ghiChu = toStr((req.body || {}).ghi_chu, 500);
    db.transaction(() => {
      db.prepare("UPDATE nhm_vu_viec SET trang_thai = 'cho_chu_xac_nhan', nguoi_nhan_id = ?, nhan_luc = datetime('now'), nhan_ghi_chu = ? WHERE id = ?").run(req.user.id, ghiChu, v.id);
      logMove(v.tube_id, 'nguoi_nhan_lay', null, null, req.user.id, `Vụ việc #${v.id}: ${ten(nguoiDung(req.user.id))} cho biết đã lấy mẫu${ghiChu ? ' — ' + ghiChu : ''}`);
    })();
    audit(req, 'incident_taken', `#${v.id} mẫu id=${v.tube_id}`);
    guiNen(thongBao.nguoiNhanLay({ vv: { ...v, nhan_ghi_chu: ghiChu }, tube: taiMau(v.tube_id), nguoiNhan: nguoiDung(req.user.id), duongDan: moTaViTri(v.box_id, v.row_no, v.col_no) }));
    res.json({ ok: true });
  });

  // Chủ mẫu (hoặc trưởng nhóm / quản lý) xác nhận có người lấy → mẫu chuyển «đã lấy ra», ghi nhận vi phạm
  router.post('/incidents/:id/confirm', (req, res) => {
    const v = layVv(req, res);
    if (!v) return;
    const tube = taiMau(v.tube_id);
    if (!tube || !coQuyenVuViec(req, tube)) return fail(res, 403, 'Chỉ chủ mẫu, trưởng nhóm hoặc quản lý mới xác nhận được.');
    if (v.trang_thai !== 'cho_chu_xac_nhan') return fail(res, 409, 'Chưa có người nhận đã lấy mẫu để xác nhận.');
    if (v.nguoi_nhan_id === req.user.id) return fail(res, 403, 'Người nhận không thể tự xác nhận.');
    db.transaction(() => {
      db.prepare("UPDATE nhm_vu_viec SET trang_thai = 'da_xac_nhan_lay', xu_ly_boi = ?, xu_ly_luc = datetime('now') WHERE id = ?").run(req.user.id, v.id);
      db.prepare("UPDATE nhm_tubes SET status = 'checked_out', updated_at = datetime('now') WHERE id = ?").run(v.tube_id);
      logMove(v.tube_id, 'xac_nhan_lay', null, null, req.user.id, `Vụ việc #${v.id}: xác nhận ${v.nguoi_nhan_ten} đã lấy mẫu không qua yêu cầu`);
    })();
    audit(req, 'incident_confirm', `#${v.id} mẫu id=${v.tube_id} người lấy ${v.nguoi_nhan_ten}`);
    res.json({ ok: true });
  });

  // Chủ mẫu không đồng ý lời nhận: vụ việc mở lại
  router.post('/incidents/:id/reject', (req, res) => {
    const v = layVv(req, res);
    if (!v) return;
    const tube = taiMau(v.tube_id);
    if (!tube || !coQuyenVuViec(req, tube)) return fail(res, 403, 'Chỉ chủ mẫu, trưởng nhóm hoặc quản lý mới từ chối được.');
    if (v.trang_thai !== 'cho_chu_xac_nhan') return fail(res, 409, 'Chưa có lời nhận nào để từ chối.');
    const lyDo = toStr((req.body || {}).ly_do, 500);
    db.transaction(() => {
      db.prepare("UPDATE nhm_vu_viec SET trang_thai = 'mo', nguoi_nhan_id = NULL, nhan_luc = NULL, nhan_ghi_chu = NULL WHERE id = ?").run(v.id);
      logMove(v.tube_id, 'tu_choi_nhan', null, null, req.user.id, `Vụ việc #${v.id}: không đồng ý lời nhận của ${v.nguoi_nhan_ten}${lyDo ? ' — ' + lyDo : ''}`);
    })();
    audit(req, 'incident_reject', `#${v.id} mẫu id=${v.tube_id}`);
    res.json({ ok: true });
  });

  // «Chính tôi đã lấy mẫu của mình»: chủ mẫu khai bổ sung thao tác (bắt buộc ghi mục đích); mẫu chuyển «đã lấy ra», vụ việc đóng, KHÔNG tính vi phạm
  router.post('/incidents/:id/self-taken', (req, res) => {
    const v = layVv(req, res);
    if (!v) return;
    if (v.owner_user_id !== req.user.id) return fail(res, 403, 'Chỉ chủ mẫu mới khai mình đã tự lấy mẫu.');
    if (v.trang_thai !== 'mo' && v.trang_thai !== 'cho_chu_xac_nhan') return fail(res, 409, 'Vụ việc này đã đóng.');
    const note = toStr((req.body || {}).note, 500);
    if (!note || note.length < 3) return fail(res, 400, 'Phải ghi thông tin thao tác: mục đích bạn đã lấy mẫu.');
    db.transaction(() => {
      db.prepare("UPDATE nhm_vu_viec SET trang_thai = 'da_tim_thay', xu_ly_boi = ?, xu_ly_luc = datetime('now'), ly_do_xu_ly = ? WHERE id = ?").run(req.user.id, 'Chủ mẫu tự lấy: ' + note, v.id);
      db.prepare("UPDATE nhm_tubes SET status = 'checked_out', updated_at = datetime('now') WHERE id = ? AND status = 'in_storage'").run(v.tube_id);
      logMove(v.tube_id, 'chu_tu_lay', null, null, req.user.id, 'Vụ việc #' + v.id + ': chủ mẫu khai đã tự lấy mẫu — ' + note);
    })();
    audit(req, 'incident_self_taken', '#' + v.id + ' mẫu id=' + v.tube_id + ' — ' + note);
    res.json({ ok: true });
  });

  router.post('/incidents/:id/found', (req, res) => {
    const v = layVv(req, res);
    if (!v) return;
    const tube = taiMau(v.tube_id);
    if (!tube || !coQuyenVuViec(req, tube)) return fail(res, 403, 'Chỉ chủ mẫu, trưởng nhóm hoặc quản lý mới đóng được.');
    if (v.trang_thai !== 'mo' && v.trang_thai !== 'cho_chu_xac_nhan') return fail(res, 409, 'Vụ việc này đã đóng.');
    db.transaction(() => {
      db.prepare("UPDATE nhm_vu_viec SET trang_thai = 'da_tim_thay', xu_ly_boi = ?, xu_ly_luc = datetime('now') WHERE id = ?").run(req.user.id, v.id);
      logMove(v.tube_id, 'tim_thay', null, null, req.user.id, `Vụ việc #${v.id}: đã tìm thấy mẫu`);
    })();
    audit(req, 'incident_found', `#${v.id} mẫu id=${v.tube_id}`);
    res.json({ ok: true });
  });

  router.post('/incidents/:id/lost', requireManage, (req, res) => {
    const v = layVv(req, res);
    if (!v) return;
    if (v.trang_thai !== 'mo' && v.trang_thai !== 'cho_chu_xac_nhan') return fail(res, 409, 'Vụ việc này đã đóng.');
    const lyDo = toStr((req.body || {}).ly_do, 500);
    if (!lyDo || lyDo.length < 5) return fail(res, 400, 'Phải ghi lý do chốt thất lạc (ít nhất 5 ký tự).');
    const som = !hanDen(v.han_nhan);
    if (som && !laAdmin(req)) return fail(res, 409, `Chưa hết hạn chờ người nhận: chỉ chốt thất lạc được từ ${v.han_nhan} (UTC), ${YeuCau.layHan(db).CHO_NHAN_NGAY} ngày sau khi báo.`);
    const tube = taiMau(v.tube_id);
    db.transaction(() => {
      db.prepare("UPDATE nhm_vu_viec SET trang_thai = 'that_lac', xu_ly_boi = ?, xu_ly_luc = datetime('now'), ly_do_xu_ly = ? WHERE id = ?").run(req.user.id, lyDo, v.id);
      db.prepare("UPDATE nhm_tubes SET status = 'discarded', updated_at = datetime('now') WHERE id = ?").run(v.tube_id);
      db.prepare("UPDATE nhm_yeu_cau SET trang_thai = 'da_huy', ly_do_xu_ly = 'Mẫu thất lạc', updated_at = datetime('now') WHERE tube_id = ? AND trang_thai IN ('cho_duyet','da_duyet')").run(v.tube_id);
      logMove(v.tube_id, 'that_lac', tube.box_id ? tube : null, null, req.user.id, `Vụ việc #${v.id}: chốt thất lạc${som ? ' (sớm, admin)' : ''} — ${lyDo}`);
    })();
    audit(req, 'incident_lost', `#${v.id} mẫu id=${v.tube_id}${som ? ' (sớm)' : ''}: ${lyDo}`);
    guiNen(thongBao.thatLac({ vv: { ...v, ly_do_xu_ly: lyDo }, tube, nguoiXuLy: nguoiDung(req.user.id), duongDan: moTaViTri(tube.box_id, tube.row_no, tube.col_no) }));
    res.json({ ok: true });
  });

  router.post('/incidents/:id/cancel', (req, res) => {
    const v = layVv(req, res);
    if (!v) return;
    const tube = taiMau(v.tube_id);
    if (!tube || !coQuyenVuViec(req, tube)) return fail(res, 403, 'Chỉ chủ mẫu, trưởng nhóm hoặc quản lý mới hủy được.');
    if (v.trang_thai !== 'mo') return fail(res, 409, 'Chỉ hủy được vụ việc chưa có người nhận.');
    db.transaction(() => {
      db.prepare("UPDATE nhm_vu_viec SET trang_thai = 'da_huy', xu_ly_boi = ?, xu_ly_luc = datetime('now') WHERE id = ?").run(req.user.id, v.id);
      logMove(v.tube_id, 'huy_bao_mat', null, null, req.user.id, `Vụ việc #${v.id}: báo nhầm`);
    })();
    audit(req, 'incident_cancel', `#${v.id} mẫu id=${v.tube_id}`);
    res.json({ ok: true });
  });

  // Số lần «lấy không xin phép» đã được chủ mẫu xác nhận, theo người lấy — để quản lý nhắc nhở / báo trưởng nhóm
  router.get('/violations', requireManage, (req, res) => {
    const rows = db
      .prepare(
        `SELECT v.nguoi_nhan_id AS user_id, COUNT(*) AS so_lan, MAX(v.xu_ly_luc) AS gan_nhat,
                (SELECT COALESCE(NULLIF(fullname, ''), email) FROM users WHERE id = v.nguoi_nhan_id) AS ten,
                (SELECT g.ten FROM nhm_ho_so h JOIN nhm_nhom g ON g.id = h.nhom_id WHERE h.user_id = v.nguoi_nhan_id) AS nhom_ten
         FROM nhm_vu_viec v WHERE v.trang_thai = 'da_xac_nhan_lay' AND v.nguoi_nhan_id IS NOT NULL
         GROUP BY v.nguoi_nhan_id ORDER BY so_lan DESC, gan_nhat DESC`
      )
      .all();
    res.json({ violations: rows });
  });

  // ── Kiểm kê hộp: đối chiếu sổ với thực tế ──
  router.post('/boxes/:id/audit', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const box = id && db.prepare('SELECT id, code FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!box) return fail(res, 404, 'Không tìm thấy hộp.');
    const body = req.body || {};
    const ids = (a) => (Array.isArray(a) ? a.map(toInt) : null);
    const thay = ids(body.thay);
    const khongThay = ids(body.khong_thay);
    if (!thay || !khongThay || thay.includes(null) || khongThay.includes(null)) return fail(res, 400, 'Danh sách mẫu thấy / không thấy không hợp lệ.');
    if (thay.some((x) => khongThay.includes(x))) return fail(res, 400, 'Một mẫu không thể vừa thấy vừa không thấy.');
    const trongHop = new Map(
      db.prepare(`SELECT * FROM nhm_tubes WHERE box_id = ? AND deleted_at IS NULL AND status = 'in_storage'`).all(id).map((t) => [t.id, t])
    );
    for (const x of thay.concat(khongThay)) if (!trongHop.has(x)) return fail(res, 400, `Mẫu id=${x} không phải mẫu đang lưu kho của hộp này.`);
    const moVu = [];
    db.transaction(() => {
      for (const x of thay) {
        db.prepare("UPDATE nhm_tubes SET thay_luc = datetime('now') WHERE id = ?").run(x);
        logMove(x, 'kiem_ke_thay', null, null, req.user.id, `Kiểm kê hộp ${box.code}: có mặt`);
      }
      for (const x of khongThay) {
        const t = trongHop.get(x);
        if (db.prepare("SELECT 1 FROM nhm_vu_viec WHERE tube_id = ? AND trang_thai IN ('mo','cho_chu_xac_nhan')").get(x)) continue; // đã có vụ việc
        const info = db
          .prepare("INSERT INTO nhm_vu_viec (tube_id, nguon, nguoi_bao_id, mo_ta, han_nhan) VALUES (?, 'kiem_ke', ?, ?, ?)")
          .run(x, req.user.id, `Kiểm kê hộp ${box.code}: không thấy mẫu${t.thay_luc ? '; lần cuối thấy ' + t.thay_luc + ' (UTC)' : ''}`, YeuCau.sauNgay(YeuCau.layHan(db).CHO_NHAN_NGAY));
        logMove(x, 'kiem_ke_khong_thay', t.box_id ? t : null, null, req.user.id, `Kiểm kê hộp ${box.code}: không thấy mẫu — vụ việc #${info.lastInsertRowid}${t.thay_luc ? '; lần cuối thấy ' + t.thay_luc + ' (UTC)' : ''}`);
        moVu.push({ vvId: Number(info.lastInsertRowid), tube: t });
      }
    })();
    audit(req, 'box_audit', `hộp ${box.code}: ${thay.length} có mặt, ${khongThay.length} không thấy`);
    for (const m of moVu) guiNen(thongBao.nghiMat({ vv: { nguon: 'kiem_ke', mo_ta: `Kiểm kê hộp ${box.code}` }, tube: m.tube, nguoiBao: nguoiDung(req.user.id), duongDan: moTaViTri(m.tube.box_id, m.tube.row_no, m.tube.col_no) }));
    res.json({ ok: true, thay: thay.length, khong_thay: khongThay.length, vu_viec_moi: moVu.length });
  });

  return router;
};
