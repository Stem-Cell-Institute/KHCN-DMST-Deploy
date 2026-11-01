'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — mẫu lưu trữ (ống đông lạnh, kháng thể, sinh phẩm...): thêm, sửa, di chuyển,
 * xóa, lịch sử. 5 endpoint. Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 *
 * Phân quyền (chủ ý): mọi người đã đăng nhập được THÊM mẫu; sửa / di chuyển / xóa chỉ chủ sở hữu hoặc quản lý.
 */

const express = require('express');
const {
  HOLDING, toInt, toStr, parseSo, parseNgay, isUniqueError, layThayDoi, moTaThayDoi, thayDoiJson,
} = require('../../services/nganHangTeBaoKhangThe');

// Vòng đời mẫu: hành động -> trạng thái được đi từ đâu, đi tới đâu.
// in_storage <-> checked_out giữ nguyên ô (mẫu chỉ ra ngoài tạm); thawed / discarded nhả ô trong hộp
// (HOLDING không còn chứa chúng nên chỉ mục duy nhất ux_nhm_tube_position tự nhả).
const CHUYEN_TRANG_THAI = {
  checkout: { tu: ['in_storage'], den: 'checked_out', loi: 'Chỉ lấy ra được mẫu đang lưu kho.' },
  checkin: { tu: ['checked_out'], den: 'in_storage', loi: 'Chỉ trả lại được mẫu đang được lấy ra.' },
  thaw: { tu: ['in_storage', 'checked_out'], den: 'thawed', loi: 'Chỉ rã đông được mẫu đang lưu kho hoặc đang được lấy ra.' },
  discard: { tu: ['in_storage', 'checked_out', 'thawed'], den: 'discarded', loi: 'Mẫu này đã được hủy.' },
};

module.exports = function createMauRouter(ctx) {
  const { db, canEditTube, requireManage, audit, fail, logMove } = ctx;
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
    if ('barcode' in body) out.barcode = toStr(body.barcode, 100);
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
  function checkPosition(boxId, row, col, ignoreTubeId) {
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
    return null;
  }

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
    try {
      const id = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO nhm_tubes (barcode, box_id, row_no, col_no, sample_type_id, name, passage, cell_count, volume_ml,
                                    freeze_date, owner_user_id, project, notes, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            t.barcode ?? null, boxId, row, col, t.sample_type_id ?? null, t.name, t.passage ?? null, t.cell_count ?? null,
            t.volume_ml ?? null, t.freeze_date ?? null, req.user.id, t.project ?? null, t.notes ?? null, req.user.id
          );
        const tubeId = Number(info.lastInsertRowid);
        logMove(tubeId, 'store', null, { box_id: boxId, row_no: row, col_no: col }, req.user.id, null);
        return tubeId;
      })();
      audit(req, 'tube_create', `id=${id} box=${boxId} r${row}c${col}`);
      res.status(201).json({ id });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Vị trí đã có mẫu hoặc mã vạch đã tồn tại.');
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
    const [t, loi] = readTubeBody(req.body || {});
    if (loi) return fail(res, 400, loi);
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
    try {
      db.transaction(() => {
        db.prepare(`UPDATE nhm_tubes SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...cols.map((c) => t[c]),
          id
        );
        logMove(id, 'edit', null, null, req.user.id, thayDoiJson(hienThi));
      })();
      audit(req, 'tube_update', `id=${id} ${moTaThayDoi(hienThi)}`);
      res.json({ ok: true, changed: cols.length });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã vạch đã tồn tại.');
      throw e;
    }
  });

  router.post('/tubes/:id/move', (req, res) => {
    const id = toInt(req.params.id);
    const cur = loadTube(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy mẫu.');
    if (!canEditTube(req, cur)) return fail(res, 403, 'Chỉ người sở hữu hoặc quản lý mới được di chuyển mẫu này.');
    if (cur.status === 'checked_out') return fail(res, 409, 'Mẫu đang được lấy ra: hãy trả lại trước khi di chuyển.');
    if (cur.status !== 'in_storage') return fail(res, 409, 'Mẫu đã rã đông hoặc đã hủy, không còn trong hộp để di chuyển.');
    const boxId = toInt((req.body || {}).box_id);
    const row = toInt((req.body || {}).row_no);
    const col = toInt((req.body || {}).col_no);
    if (boxId === cur.box_id && row === cur.row_no && col === cur.col_no) return fail(res, 400, 'Mẫu đang ở đúng vị trí này.');
    const bad = checkPosition(boxId, row, col, id);
    if (bad) return fail(res, bad.status, bad.message);
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
    db.transaction(() => {
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
      if (!rule.tu.includes(cur.status)) return fail(res, 409, rule.loi);
      const note = toStr((req.body || {}).note, 500);
      db.transaction(() => {
        db.prepare("UPDATE nhm_tubes SET status = ?, updated_at = datetime('now') WHERE id = ?").run(rule.den, id);
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
