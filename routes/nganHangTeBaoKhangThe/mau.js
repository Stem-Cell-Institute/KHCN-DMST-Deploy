'use strict';

/**
 * Ngân hàng Tế bào & Kháng thể — mẫu lưu trữ (ống đông lạnh, kháng thể, sinh phẩm...): thêm, sửa, di chuyển,
 * xóa, lịch sử. 5 endpoint. Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Phân quyền (chủ ý): mọi người đã đăng nhập được THÊM mẫu; sửa / di chuyển / xóa chỉ chủ sở hữu hoặc quản lý.
 */

const express = require('express');
const {
  HOLDING, LOAI_CHU, LOAI_CHU_VN, toInt, toStr, parseSo, parseNgay, isUniqueError, layThayDoi, moTaThayDoi, thayDoiJson,
} = require('../../services/nganHangTeBaoKhangThe');

// Vòng đời mẫu: hành động -> trạng thái được đi từ đâu, đi tới đâu.
// in_storage <-> checked_out giữ nguyên ô (mẫu chỉ ra ngoài tạm); thawed / discarded nhả ô trong hộp
// (HOLDING không còn chứa chúng nên chỉ mục duy nhất ux_nhm_tube_position tự nhả).
const CHUYEN_TRANG_THAI = {
  checkout: { tu: ['in_storage'], den: 'checked_out', loi: 'Chỉ lấy ra được mẫu đang lưu kho.', nhan: 'mục đích sử dụng' },
  checkin: { tu: ['checked_out'], den: 'in_storage', loi: 'Chỉ trả lại được mẫu đang được lấy ra.', nhan: 'tình trạng khi trả (còn lại bao nhiêu, có vấn đề gì không)' },
  thaw: { tu: ['in_storage', 'checked_out'], den: 'thawed', loi: 'Chỉ rã đông được mẫu đang lưu kho hoặc đang được lấy ra.', nhan: 'mục đích rã đông' },
  discard: { tu: ['in_storage', 'checked_out', 'thawed'], den: 'discarded', loi: 'Mẫu này đã được hủy.', nhan: 'lý do hủy' },
};

module.exports = function createMauRouter(ctx) {
  const { db, canManage, canEditTube, requireManage, biChanDonVi, audit, fail, logMove } = ctx;
  const router = express.Router();

  /** Trả [giá trị, lỗi]; lỗi là câu báo 400 hoặc null. */
  function readTubeBody(body) {
    const out = {};
    let error = null;
    const so = (key, label) => {
      if (!(key in body)) return;
      const r = parseSo(body[key], { min: 0, max: 1e15, label });
      if (r.error) error = error || r.error;
      else out[key] = r.value;
    };
    if ('name' in body) out.name = toStr(body.name, 200);
    if ('sample_type_id' in body) out.sample_type_id = body.sample_type_id == null || body.sample_type_id === '' ? null : toInt(body.sample_type_id);
    if ('passage' in body) out.passage = toStr(body.passage, 50);
    so('cell_count', 'Số tế bào');
    so('volume_ml', 'Thể tích');
    if ('freeze_date' in body) {
      const r = parseNgay(body.freeze_date, 'Ngày đông lạnh');
      if (r.error) error = error || r.error;
      else out.freeze_date = r.value;
    }
    if ('project' in body) out.project = toStr(body.project, 200);
    if ('notes' in body) out.notes = toStr(body.notes, 2000);
    return [out, error];
  }

  /** Kiểm tra hộp tồn tại, vị trí trong lưới và còn trống. Trả về lỗi hoặc null. */
  function checkPosition(boxId, row, col, ignoreTubeId, ignoreFindingId) {
    const box = boxId && db.prepare('SELECT id, rows, cols FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(boxId);
    if (!box) return { status: 400, message: 'Hộp không tồn tại.' };
    if (!row || !col || row < 1 || row > box.rows || col < 1 || col > box.cols) {
      return { status: 400, message: 'Vị trí nằm ngoài lưới của hộp.' };
    }
    const taken = db
      .prepare(
        `SELECT id FROM nhm_tubes WHERE box_id = ? AND row_no = ? AND col_no = ?
         AND deleted_at IS NULL AND status IN ${HOLDING} AND id <> ?`
      )
      .get(boxId, row, col, ignoreTubeId || 0);
    if (taken) return { status: 409, message: 'Vị trí này đã có mẫu khác.' };
    const phatHien = db
      .prepare("SELECT id FROM nhm_phat_hien WHERE box_id = ? AND row_no = ? AND col_no = ? AND trang_thai = 'cho_chu_mau' AND id <> ?")
      .get(boxId, row, col, ignoreFindingId || 0);
    if (phatHien) return { status: 409, message: 'Ô này đang có mẫu chưa khai báo chờ chủ mẫu nhận. Nếu là mẫu của bạn, hãy nhận mẫu đó.' };
    return null;
  }

  /**
   * Loại chủ mẫu + nhóm nghiên cứu của mẫu sắp thêm. Hồ sơ thành viên (quản lý gán) quyết định nếu có; người chưa
   * có hồ sơ tự khai trong body (chu_loai, nhom_id — nhóm mới thì gọi POST /groups/propose trước).
   * Trả { chu_loai, nhom_id } hoặc { loi, status }.
   */
  function xacDinhChuMau(req, body) {
    const hs = db.prepare('SELECT * FROM nhm_ho_so WHERE user_id = ?').get(req.user.id);
    if (hs && hs.trang_thai === 'da_roi_di') {
      return { status: 403, loi: 'Hồ sơ của bạn được đánh dấu đã rời đi, không thêm mẫu được. Liên hệ quản lý module.' };
    }
    const loai = hs ? hs.loai : body.chu_loai;
    if (!LOAI_CHU.includes(loai)) {
      return { status: 400, loi: 'Chọn loại chủ mẫu (sinh viên, nghiên cứu viên hoặc cán bộ).' };
    }
    let nhomId = 'nhom_id' in body && body.nhom_id !== '' && body.nhom_id != null ? toInt(body.nhom_id) : hs ? hs.nhom_id : null;
    if (loai === 'sinh_vien' && hs && hs.nhom_id && nhomId !== hs.nhom_id) {
      return { status: 400, loi: 'Sinh viên chỉ thêm mẫu cho nhóm nghiên cứu của mình.' };
    }
    if (loai !== 'can_bo' && nhomId == null) return { status: 400, loi: 'Chọn nhóm nghiên cứu của mẫu.' };
    if (nhomId != null) {
      const g = db.prepare("SELECT * FROM nhm_nhom WHERE id = ? AND trang_thai <> 'giai_the'").get(nhomId);
      if (!g) return { status: 400, loi: 'Nhóm nghiên cứu không tồn tại hoặc đã giải thể.' };
      if (loai === 'sinh_vien' && !g.truong_user_id) {
        return { status: 400, loi: 'Nhóm này chưa có trưởng nhóm: sinh viên cần chọn trưởng nhóm khi đề xuất nhóm.' };
      }
    }
    return { chu_loai: loai, nhom_id: nhomId };
  }

  // thiết bị có đơn vị quản lý (Cellbank hoặc đơn vị khác): người dùng thường không tự thêm / lấy mẫu, phải gửi yêu cầu
  const tenDonVi = (boxId) => (ctx.donViCuaHop && (ctx.donViCuaHop(boxId) || {}).ten) || 'đơn vị quản lý';
  const loiThem = (boxId) => `Thiết bị này do ${tenDonVi(boxId)} quản lý: chỉ quản lý module hoặc người duyệt của đơn vị mới thêm hoặc di chuyển mẫu vào. Hãy dùng chức năng yêu cầu.`;
  function chanCellbank(req, res, tube) {
    if (biChanDonVi(req, tube.box_id)) {
      fail(res, 403, `Mẫu nằm trong thiết bị do ${tenDonVi(tube.box_id)} quản lý: chỉ quản lý module hoặc người duyệt của đơn vị mới thao tác được. Hãy dùng chức năng yêu cầu.`);
      return true;
    }
    return false;
  }

  /** Thêm một mẫu vào ô và ghi dòng «Nhập kho» vào lịch sử. Gọi trong transaction. */
  function insertTube(t, chu, boxId, row, col, userId) {
    const info = db
      .prepare(
        `INSERT INTO nhm_tubes (box_id, row_no, col_no, sample_type_id, name, passage, cell_count, volume_ml,
                                freeze_date, owner_user_id, project, notes, created_by, chu_loai, nhom_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        boxId, row, col, t.sample_type_id ?? null, t.name, t.passage ?? null, t.cell_count ?? null,
        t.volume_ml ?? null, t.freeze_date ?? null, userId, t.project ?? null, t.notes ?? null, userId, chu.chu_loai, chu.nhom_id
      );
    const tubeId = Number(info.lastInsertRowid);
    logMove(tubeId, 'store', null, { box_id: boxId, row_no: row, col_no: col }, userId, null);
    // sinh viên mới kích hoạt chưa có nhóm: nhóm chọn ở mẫu đầu tiên trở thành nhóm trong hồ sơ
    if (chu.chu_loai === 'sinh_vien' && chu.nhom_id) {
      db.prepare("UPDATE nhm_ho_so SET nhom_id = ?, updated_at = datetime('now') WHERE user_id = ? AND loai = 'sinh_vien' AND nhom_id IS NULL").run(chu.nhom_id, userId);
    }
    return tubeId;
  }

  // Thêm nhiều mẫu cùng lô vào các ô liên tiếp (theo hàng, từ ô bắt đầu). Tất cả hoặc không: một ô bị chiếm
  // hoặc vượt lưới thì không thêm mẫu nào.
  router.post('/tubes/bulk', (req, res) => {
    const body = req.body || {};
    const boxId = toInt(body.box_id);
    const row = toInt(body.row_no);
    const col = toInt(body.col_no);
    const count = toInt(body.count);
    if (!count || count < 1 || count > 100) return fail(res, 400, 'Số lượng mẫu phải từ 1 đến 100.');
    const [t, loi] = readTubeBody(body);
    if (loi) return fail(res, 400, loi);
    if (!t.name) return fail(res, 400, 'Thiếu tên mẫu.');
    if (t.sample_type_id != null && !db.prepare('SELECT 1 FROM nhm_sample_types WHERE id = ?').get(t.sample_type_id)) {
      return fail(res, 400, 'Loại mẫu không hợp lệ.');
    }
    const first = checkPosition(boxId, row, col);
    if (first) return fail(res, first.status, first.message);
    const chu = xacDinhChuMau(req, body);
    if (chu.loi) return fail(res, chu.status, chu.loi);
    if (biChanDonVi(req, boxId)) return fail(res, 403, loiThem(boxId));
    const hop = db.prepare('SELECT rows, cols FROM nhm_boxes WHERE id = ?').get(boxId);
    const oCan = [];
    for (let i = 0, r = row, c = col; i < count; i++) {
      if (r > hop.rows) return fail(res, 400, `Không đủ chỗ: hộp chỉ còn ${i} ô tính từ ô bắt đầu, cần ${count}.`);
      const bad = checkPosition(boxId, r, c);
      if (bad) return fail(res, bad.status, `${bad.message} (ô ${String.fromCharCode(64 + r)}${c}).`);
      oCan.push([r, c]);
      c++;
      if (c > hop.cols) { c = 1; r++; }
    }
    try {
      const ids = db.transaction(() =>
        oCan.map(([r, c]) => insertTube(t, chu, boxId, r, c, req.user.id))
      )();
      audit(req, 'tube_bulk_create', `box=${boxId} ${ids.length} mẫu "${t.name}" từ r${row}c${col}`);
      res.status(201).json({ ids });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Một ô vừa có người khác đặt mẫu vào. Hãy thử lại.');
      throw e;
    }
  });

  router.post('/tubes', (req, res) => {
    const body = req.body || {};
    const boxId = toInt(body.box_id);
    const row = toInt(body.row_no);
    const col = toInt(body.col_no);
    const [t, loi] = readTubeBody(body);
    if (loi) return fail(res, 400, loi);
    if (!t.name) return fail(res, 400, 'Thiếu tên mẫu.');
    if (t.sample_type_id != null && !db.prepare('SELECT 1 FROM nhm_sample_types WHERE id = ?').get(t.sample_type_id)) {
      return fail(res, 400, 'Loại mẫu không hợp lệ.');
    }
    const bad = checkPosition(boxId, row, col);
    if (bad) return fail(res, bad.status, bad.message);
    const chu = xacDinhChuMau(req, body);
    if (chu.loi) return fail(res, chu.status, chu.loi);
    if (biChanDonVi(req, boxId)) return fail(res, 403, loiThem(boxId));
    try {
      const id = db.transaction(() => insertTube(t, chu, boxId, row, col, req.user.id))();
      audit(req, 'tube_create', `id=${id} box=${boxId} r${row}c${col}`);
      res.status(201).json({ id });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Vị trí này đã có mẫu khác.');
      throw e;
    }
  });

  function loadTube(id) {
    return id && db.prepare('SELECT * FROM nhm_tubes WHERE id = ? AND deleted_at IS NULL').get(id);
  }

  router.patch('/tubes/:id', (req, res) => {
    const id = toInt(req.params.id);
    const cur = loadTube(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy mẫu.');
    if (!canEditTube(req, cur)) return fail(res, 403, 'Chỉ người sở hữu hoặc quản lý mới được sửa mẫu này.');
    const body = req.body || {};
    const [t, loi] = readTubeBody(body);
    if (loi) return fail(res, 400, loi);
    // Loại chủ và nhóm quyết định ai duyệt yêu cầu về mẫu: chỉ quản lý đổi được
    if ('chu_loai' in body || 'nhom_id' in body) {
      if (!canManage(req)) return fail(res, 403, 'Chỉ quản lý module mới đổi được loại chủ mẫu và nhóm nghiên cứu.');
      if ('chu_loai' in body) {
        if (body.chu_loai !== null && !LOAI_CHU.includes(body.chu_loai)) return fail(res, 400, 'Loại chủ mẫu không hợp lệ.');
        t.chu_loai = body.chu_loai;
      }
      if ('nhom_id' in body) {
        const n = body.nhom_id === null || body.nhom_id === '' ? null : toInt(body.nhom_id);
        if (n != null && !db.prepare("SELECT 1 FROM nhm_nhom WHERE id = ? AND trang_thai <> 'giai_the'").get(n)) {
          return fail(res, 400, 'Nhóm nghiên cứu không tồn tại hoặc đã giải thể.');
        }
        t.nhom_id = n;
      }
    }
    if ('name' in t && !t.name) return fail(res, 400, 'Tên mẫu không được để trống.');
    if (t.sample_type_id != null && !db.prepare('SELECT 1 FROM nhm_sample_types WHERE id = ?').get(t.sample_type_id)) {
      return fail(res, 400, 'Loại mẫu không hợp lệ.');
    }
    if (!Object.keys(t).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    const thayDoi = layThayDoi(cur, t);
    const cols = Object.keys(thayDoi);
    if (!cols.length) return res.json({ ok: true, changed: 0 });
    // Lịch sử ghi GIÁ TRỊ cũ → mới (loại mẫu ghi tên chứ không ghi id)
    const hienThi = { ...thayDoi };
    if (hienThi.sample_type_id) {
      const ten = (v) => (v == null ? null : (db.prepare('SELECT name FROM nhm_sample_types WHERE id = ?').get(v) || {}).name || v);
      hienThi.sample_type_id = hienThi.sample_type_id.map(ten);
    }
    if (hienThi.nhom_id) {
      hienThi.nhom_id = hienThi.nhom_id.map((v) => (v == null ? null : (db.prepare('SELECT ten FROM nhm_nhom WHERE id = ?').get(v) || {}).ten || v));
    }
    if (hienThi.chu_loai) hienThi.chu_loai = hienThi.chu_loai.map((v) => (v == null ? null : LOAI_CHU_VN[v] || v));
    db.transaction(() => {
      db.prepare(`UPDATE nhm_tubes SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...cols.map((c) => t[c]),
        id
      );
      logMove(id, 'edit', null, null, req.user.id, thayDoiJson(hienThi));
    })();
    audit(req, 'tube_update', `id=${id} ${moTaThayDoi(hienThi)}`);
    res.json({ ok: true, changed: cols.length });
  });

  router.post('/tubes/:id/move', (req, res) => {
    const id = toInt(req.params.id);
    const cur = loadTube(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy mẫu.');
    if (!canEditTube(req, cur)) return fail(res, 403, 'Chỉ người sở hữu hoặc quản lý mới được di chuyển mẫu này.');
    if (chanCellbank(req, res, cur)) return;
    if (cur.status === 'checked_out') return fail(res, 409, 'Mẫu đang được lấy ra: hãy trả lại trước khi di chuyển.');
    if (cur.status !== 'in_storage') return fail(res, 409, 'Mẫu đã rã đông hoặc đã hủy, không còn trong hộp để di chuyển.');
    const boxId = toInt((req.body || {}).box_id);
    const row = toInt((req.body || {}).row_no);
    const col = toInt((req.body || {}).col_no);
    if (boxId === cur.box_id && row === cur.row_no && col === cur.col_no) return fail(res, 400, 'Mẫu đang ở đúng vị trí này.');
    const bad = checkPosition(boxId, row, col, id);
    if (bad) return fail(res, bad.status, bad.message);
    if (biChanDonVi(req, boxId)) return fail(res, 403, loiThem(boxId));
    try {
      db.transaction(() => {
        db.prepare("UPDATE nhm_tubes SET box_id = ?, row_no = ?, col_no = ?, updated_at = datetime('now') WHERE id = ?").run(boxId, row, col, id);
        logMove(id, 'move', cur, { box_id: boxId, row_no: row, col_no: col }, req.user.id, null);
      })();
      audit(req, 'tube_move', `id=${id} -> box=${boxId} r${row}c${col}`);
      res.json({ ok: true });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Vị trí này đã có mẫu khác.');
      throw e;
    }
  });

  router.delete('/tubes/:id', (req, res) => {
    const id = toInt(req.params.id);
    const cur = loadTube(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy mẫu.');
    if (!canEditTube(req, cur)) return fail(res, 403, 'Chỉ người sở hữu hoặc quản lý mới được xóa mẫu này.');
    if (chanCellbank(req, res, cur)) return;
    db.transaction(() => {
      db.prepare("UPDATE nhm_yeu_cau SET trang_thai = 'da_huy', ly_do_xu_ly = 'Mẫu đã bị xóa', updated_at = datetime('now') WHERE tube_id = ? AND trang_thai IN ('cho_duyet','da_duyet')").run(id);
      db.prepare("UPDATE nhm_tubes SET deleted_at = datetime('now') WHERE id = ?").run(id);
      logMove(id, 'delete', cur, null, req.user.id, null);
    })();
    audit(req, 'tube_delete', `id=${id} ${cur.name}`);
    res.json({ ok: true });
  });

  // Lấy ra / trả lại / rã đông / hủy: đổi trạng thái và ghi lịch sử. Người sở hữu hoặc quản lý.
  Object.keys(CHUYEN_TRANG_THAI).forEach((hanhDong) => {
    const rule = CHUYEN_TRANG_THAI[hanhDong];
    router.post(`/tubes/:id/${hanhDong}`, (req, res) => {
      const id = toInt(req.params.id);
      const cur = loadTube(id);
      if (!cur) return fail(res, 404, 'Không tìm thấy mẫu.');
      if (!canEditTube(req, cur)) return fail(res, 403, 'Chỉ người sở hữu hoặc quản lý mới được thao tác trên mẫu này.');
      if (chanCellbank(req, res, cur)) return;
      if (!rule.tu.includes(cur.status)) return fail(res, 409, rule.loi);
      // Chủ mẫu tự lấy mẫu của mình thì không cần ai duyệt, nhưng PHẢI khai thông tin thao tác: lịch sử và nhật ký cần biết vì sao mẫu rời khỏi kho
      const note = toStr((req.body || {}).note, 500);
      if (!note || note.length < 3) return fail(res, 400, 'Phải ghi thông tin thao tác: ' + rule.nhan + '.');
      db.transaction(() => {
        db.prepare("UPDATE nhm_tubes SET status = ?, updated_at = datetime('now') WHERE id = ?").run(rule.den, id);
        // mẫu đang giao cho người xin mà được trả / dùng hết / hủy thì yêu cầu kết thúc; yêu cầu chờ duyệt thì đóng lại
        db.prepare("UPDATE nhm_yeu_cau SET trang_thai = 'da_tra', updated_at = datetime('now') WHERE tube_id = ? AND trang_thai = 'da_giao'").run(id);
        if (rule.den === 'thawed' || rule.den === 'discarded') {
          db.prepare("UPDATE nhm_yeu_cau SET trang_thai = 'da_huy', ly_do_xu_ly = 'Mẫu đã rã đông / hủy', updated_at = datetime('now') WHERE tube_id = ? AND trang_thai IN ('cho_duyet','da_duyet')").run(id);
        }
        logMove(id, hanhDong, cur.box_id ? cur : null, null, req.user.id, note);
      })();
      audit(req, `tube_${hanhDong}`, `id=${id} ${cur.name}${note ? ' — ' + note : ''}`);
      res.json({ ok: true, status: rule.den });
    });
  });

  // Danh sách người nhận khi chuyển quyền sở hữu: chỉ quản lý, bỏ tài khoản bị khóa.
  router.get('/users', requireManage, (req, res) => {
    res.json({
      users: db.prepare('SELECT id, fullname, email FROM users WHERE COALESCE(is_banned, 0) = 0 ORDER BY fullname, email').all(),
    });
  });

  // Chuyển quyền sở hữu mẫu (người nghỉ việc, bàn giao đề tài): chỉ quản lý.
  router.post('/tubes/:id/transfer', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = loadTube(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy mẫu.');
    const toUser = toInt((req.body || {}).owner_user_id);
    const nguoi = toUser && db.prepare('SELECT id, fullname, email FROM users WHERE id = ?').get(toUser);
    if (!nguoi) return fail(res, 400, 'Người nhận không tồn tại.');
    if (nguoi.id === cur.owner_user_id) return fail(res, 400, 'Người này đã là chủ sở hữu.');
    const cu = cur.owner_user_id && db.prepare('SELECT fullname, email FROM users WHERE id = ?').get(cur.owner_user_id);
    const ten = (u) => (u ? u.fullname || u.email : '(không rõ)');
    db.transaction(() => {
      db.prepare("UPDATE nhm_tubes SET owner_user_id = ?, updated_at = datetime('now') WHERE id = ?").run(nguoi.id, id);
      logMove(id, 'transfer', null, null, req.user.id, `${ten(cu)} → ${ten(nguoi)}`);
    })();
    audit(req, 'tube_transfer', `id=${id} ${ten(cu)} → ${ten(nguoi)}`);
    res.json({ ok: true });
  });

  // Cho router phát hiện / yêu cầu dùng lại cùng cách đọc, kiểm tra và thêm mẫu
  ctx.tubeKit = { readTubeBody, xacDinhChuMau, insertTube, checkPosition };

  router.get('/tubes/:id/history', (req, res) => {
    const id = toInt(req.params.id);
    const tube = id && db.prepare('SELECT id, name FROM nhm_tubes WHERE id = ?').get(id);
    if (!tube) return fail(res, 404, 'Không tìm thấy mẫu.');
    const rows = db
      .prepare(
        `SELECT m.*, (SELECT fullname FROM users WHERE id = m.user_id) AS user_name,
                (SELECT code FROM nhm_boxes WHERE id = m.from_box_id) AS from_box_code,
                (SELECT code FROM nhm_boxes WHERE id = m.to_box_id) AS to_box_code
         FROM nhm_movements m WHERE m.tube_id = ? ORDER BY m.id DESC`
      )
      .all(id);
    res.json({ tube, history: rows });
  });

  return router;
};
