'use strict';

/**
 * Ngân hàng tế bào & Kháng thể — danh mục, cây kho, vị trí lưu trữ (tủ/ngăn/giá) và hộp. 9 endpoint.
 * Mount tại /api/ngan-hang-te-bao-khang-the (xem index.js).
 */

const express = require('express');
const {
  HOLDING, LOAI_CHU_VN, toInt, toStr, parseSo, placeholders, isUniqueError, layThayDoi, moTaThayDoi,
} = require('../../services/nganHangTeBaoKhangThe');

module.exports = function createKhoLuuTruRouter(ctx) {
  const { db, laAdmin, canManage, canEditTube, requireManage, audit, fail, subtreeIds, duongDan, activeTubeCountInBoxes, nextCode, logMove } = ctx;
  const router = express.Router();

  // ---------- Danh mục & cây ----------

  router.get('/meta', (req, res) => {
    res.json({
      canManage: canManage(req),
      isAdmin: laAdmin(req),
      loaiChu: LOAI_CHU_VN,
      containerTypes: db.prepare('SELECT * FROM nhm_container_types ORDER BY sort_order, name').all(),
      boxTemplates: db.prepare('SELECT * FROM nhm_box_templates ORDER BY rows, cols, name').all(),
      sampleTypes: db.prepare('SELECT * FROM nhm_sample_types ORDER BY name').all(),
    });
  });

  router.get('/tree', (req, res) => {
    const containers = db
      .prepare(
        `SELECT c.id, c.parent_id, c.type_id, c.code, c.name, c.temperature_c, c.location_note, c.sort_order, c.notes, c.quan_ly_boi,
                t.name AS type_name
         FROM nhm_containers c JOIN nhm_container_types t ON t.id = c.type_id
         WHERE c.deleted_at IS NULL ORDER BY c.sort_order, c.name`
      )
      .all();
    const boxes = db
      .prepare(
        `SELECT b.id, b.container_id, b.template_id, b.rows, b.cols, b.code, b.name, b.notes,
                (SELECT COUNT(*) FROM nhm_tubes x
                  WHERE x.box_id = b.id AND x.deleted_at IS NULL AND x.status IN ${HOLDING}) AS tube_count
         FROM nhm_boxes b WHERE b.deleted_at IS NULL ORDER BY b.code`
      )
      .all();
    // vị trí con thừa hưởng quan_ly_boi của thiết bị gốc
    const byId = new Map(containers.map((c) => [c.id, c]));
    const goc = (c) => {
      for (let i = 0; c.parent_id != null && byId.has(c.parent_id) && i < 50; i++) c = byId.get(c.parent_id);
      return c;
    };
    for (const c of containers) c.quan_ly_boi = goc(c).quan_ly_boi;
    res.json({ containers, boxes });
  });

  // ---------- Vị trí lưu trữ ----------

  /** Trả [giá trị, lỗi]; lỗi là câu báo 400 hoặc null. */
  function readContainerBody(body, partial) {
    const out = {};
    let error = null;
    if (!partial || 'name' in body) out.name = toStr(body.name, 200);
    if (!partial || 'type_id' in body) out.type_id = toInt(body.type_id);
    if ('parent_id' in body) out.parent_id = body.parent_id == null || body.parent_id === '' ? null : toInt(body.parent_id);
    if ('code' in body) out.code = toStr(body.code, 60);
    if ('temperature_c' in body) {
      const r = parseSo(body.temperature_c, { min: -273, max: 100, label: 'Nhiệt độ' });
      if (r.error) error = r.error;
      else out.temperature_c = r.value;
    }
    if ('location_note' in body) out.location_note = toStr(body.location_note, 300);
    if ('notes' in body) out.notes = toStr(body.notes, 2000);
    if ('quan_ly_boi' in body) {
      if (!['cong_khai', 'cellbank'].includes(body.quan_ly_boi)) error = 'Kiểu quản lý thiết bị không hợp lệ (công khai hoặc Cellbank).';
      else out.quan_ly_boi = body.quan_ly_boi;
    }
    if ('sort_order' in body) {
      out.sort_order = body.sort_order == null || body.sort_order === '' ? 0 : toInt(body.sort_order);
      if (out.sort_order == null) error = 'Thứ tự sắp xếp phải là số nguyên.';
    }
    return [out, error];
  }

  router.post('/containers', requireManage, (req, res) => {
    const [b, loi] = readContainerBody(req.body || {}, false);
    if (loi) return fail(res, 400, loi);
    if (!b.name) return fail(res, 400, 'Thiếu tên vị trí lưu trữ.');
    if (b.type_id == null || !db.prepare('SELECT 1 FROM nhm_container_types WHERE id = ?').get(b.type_id)) {
      return fail(res, 400, 'Loại vị trí lưu trữ không hợp lệ.');
    }
    if (b.parent_id != null && !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(b.parent_id)) {
      return fail(res, 400, 'Vị trí lưu trữ cha không tồn tại.');
    }
    if (b.parent_id != null && 'quan_ly_boi' in b) return fail(res, 400, 'Chỉ thiết bị gốc mới chọn được kiểu quản lý; vị trí con thừa hưởng từ thiết bị gốc.');
    try {
      const code = b.code || nextCode('nhm_containers', 'VC-');
      const info = db
        .prepare(
          `INSERT INTO nhm_containers (parent_id, type_id, code, name, temperature_c, location_note, sort_order, notes, quan_ly_boi, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(b.parent_id ?? null, b.type_id, code, b.name, b.temperature_c ?? null, b.location_note ?? null, b.sort_order || 0, b.notes ?? null, b.quan_ly_boi || 'cong_khai', req.user.id);
      audit(req, 'container_create', `id=${info.lastInsertRowid} ${b.name}`);
      res.status(201).json({ id: Number(info.lastInsertRowid), code });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã vị trí lưu trữ đã tồn tại.');
      throw e;
    }
  });

  router.patch('/containers/:id', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy vị trí lưu trữ.');
    const [b, loi] = readContainerBody(req.body || {}, true);
    if (loi) return fail(res, 400, loi);
    if ('name' in b && !b.name) return fail(res, 400, 'Tên vị trí lưu trữ không được để trống.');
    if ('type_id' in b && (b.type_id == null || !db.prepare('SELECT 1 FROM nhm_container_types WHERE id = ?').get(b.type_id))) {
      return fail(res, 400, 'Loại vị trí lưu trữ không hợp lệ.');
    }
    if ('parent_id' in b && b.parent_id != null) {
      if (!db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(b.parent_id)) {
        return fail(res, 400, 'Vị trí lưu trữ cha không tồn tại.');
      }
      if (subtreeIds(id).includes(b.parent_id)) return fail(res, 400, 'Không thể chuyển vị trí lưu trữ vào chính nó hoặc vị trí lưu trữ con.');
    }
    if ('code' in b && !b.code) return fail(res, 400, 'Mã vị trí lưu trữ không được để trống.');
    const chaMoi = 'parent_id' in b ? b.parent_id : cur.parent_id;
    if ('quan_ly_boi' in b && chaMoi != null) return fail(res, 400, 'Chỉ thiết bị gốc mới chọn được kiểu quản lý; vị trí con thừa hưởng từ thiết bị gốc.');
    if (!Object.keys(b).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    const thayDoi = layThayDoi(cur, b);
    const cols = Object.keys(thayDoi);
    if (!cols.length) return res.json({ ok: true, changed: 0 });
    try {
      db.prepare(`UPDATE nhm_containers SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...cols.map((c) => b[c]),
        id
      );
      audit(req, 'container_update', `id=${id} ${cur.name}: ${moTaThayDoi(thayDoi)}`);
      res.json({ ok: true, changed: cols.length });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã vị trí lưu trữ đã tồn tại.');
      throw e;
    }
  });

  router.delete('/containers/:id', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT id, name FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy vị trí lưu trữ.');
    const ids = subtreeIds(id);
    const boxIds = db
      .prepare(`SELECT id FROM nhm_boxes WHERE deleted_at IS NULL AND container_id IN (${placeholders(ids.length)})`)
      .all(...ids)
      .map((r) => r.id);
    const tubes = activeTubeCountInBoxes(boxIds);
    if (tubes > 0) {
      return fail(res, 409, `Không thể xóa: còn ${tubes} mẫu bên trong. Hãy chuyển hoặc xóa các mẫu trước.`);
    }
    db.transaction(() => {
      db.prepare(`UPDATE nhm_containers SET deleted_at = datetime('now') WHERE id IN (${placeholders(ids.length)})`).run(...ids);
      if (boxIds.length) {
        db.prepare(`UPDATE nhm_boxes SET deleted_at = datetime('now') WHERE id IN (${placeholders(boxIds.length)})`).run(...boxIds);
      }
    })();
    audit(req, 'container_delete', `id=${id} ${cur.name} (${ids.length} vị trí lưu trữ, ${boxIds.length} hộp)`);
    res.json({ ok: true, containers: ids.length, boxes: boxIds.length });
  });

  // ---------- Hộp ----------

  router.post('/boxes', requireManage, (req, res) => {
    const body = req.body || {};
    const containerId = toInt(body.container_id);
    if (!containerId || !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(containerId)) {
      return fail(res, 400, 'Vị trí lưu trữ không tồn tại.');
    }
    let rows = toInt(body.rows);
    let cols = toInt(body.cols);
    const templateId = body.template_id == null || body.template_id === '' ? null : toInt(body.template_id);
    if (templateId != null) {
      const t = db.prepare('SELECT rows, cols FROM nhm_box_templates WHERE id = ?').get(templateId);
      if (!t) return fail(res, 400, 'Mẫu hộp không tồn tại.');
      rows = t.rows;
      cols = t.cols;
    }
    if (!rows || !cols || rows < 1 || rows > 26 || cols < 1 || cols > 30) {
      return fail(res, 400, 'Kích thước hộp không hợp lệ (1–26 hàng, 1–30 cột).');
    }
    const count = body.count == null ? 1 : toInt(body.count);
    if (!count || count < 1 || count > 50) return fail(res, 400, 'Số lượng hộp phải từ 1 đến 50.');
    const baseName = toStr(body.name, 150);
    const customCode = toStr(body.code, 60);
    if (customCode && count > 1) return fail(res, 400, 'Không đặt mã tùy chỉnh khi tạo nhiều hộp cùng lúc.');
    try {
      const created = db.transaction(() => {
        const ids = [];
        for (let i = 0; i < count; i++) {
          const code = customCode || nextCode('nhm_boxes', 'HOP-');
          const name = baseName ? (count > 1 ? `${baseName} ${i + 1}` : baseName) : null;
          const info = db
            .prepare(
              `INSERT INTO nhm_boxes (container_id, template_id, rows, cols, code, name, notes, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(containerId, templateId, rows, cols, code, name, toStr(body.notes, 2000), req.user.id);
          ids.push(Number(info.lastInsertRowid));
        }
        return ids;
      })();
      audit(req, 'box_create', `container=${containerId} ids=${created.join(',')}`);
      res.status(201).json({ ids: created });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã hộp đã tồn tại.');
      throw e;
    }
  });

  router.get('/boxes/:id', (req, res) => {
    const id = toInt(req.params.id);
    const box = id && db.prepare('SELECT * FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!box) return fail(res, 404, 'Không tìm thấy hộp.');
    const path = duongDan(box.container_id);
    const tubes = db
      .prepare(
        `SELECT t.id, t.row_no, t.col_no, t.name, t.passage, t.cell_count, t.volume_ml, t.freeze_date,
                t.project, t.status, t.notes, t.owner_user_id, t.sample_type_id, s.name AS sample_type_name,
                t.chu_loai, t.nhom_id, (SELECT ten FROM nhm_nhom WHERE id = t.nhom_id) AS nhom_ten,
                (SELECT fullname FROM users WHERE id = t.owner_user_id) AS owner_name
         FROM nhm_tubes t LEFT JOIN nhm_sample_types s ON s.id = t.sample_type_id
         WHERE t.box_id = ? AND t.deleted_at IS NULL AND t.status IN ${HOLDING}`
      )
      .all(id);
    res.json({ box, path, tubes: tubes.map((t) => ({ ...t, can_edit: canEditTube(req, t) })) });
  });

  router.patch('/boxes/:id', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT * FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy hộp.');
    const body = req.body || {};
    const upd = {};
    if ('name' in body) upd.name = toStr(body.name, 150);
    if ('notes' in body) upd.notes = toStr(body.notes, 2000);
    if ('code' in body) {
      upd.code = toStr(body.code, 60);
      if (!upd.code) return fail(res, 400, 'Mã hộp không được để trống.');
    }
    if ('container_id' in body) {
      const cid = toInt(body.container_id);
      if (!cid || !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(cid)) {
        return fail(res, 400, 'Vị trí lưu trữ không tồn tại.');
      }
      upd.container_id = cid;
    }
    if ('rows' in body || 'cols' in body) {
      const rows = 'rows' in body ? toInt(body.rows) : cur.rows;
      const cols = 'cols' in body ? toInt(body.cols) : cur.cols;
      if (!rows || !cols || rows < 1 || rows > 26 || cols < 1 || cols > 30) return fail(res, 400, 'Kích thước hộp không hợp lệ.');
      const outside = db
        .prepare(
          `SELECT COUNT(*) AS c FROM nhm_tubes
           WHERE box_id = ? AND deleted_at IS NULL AND status IN ${HOLDING} AND (row_no > ? OR col_no > ?)`
        )
        .get(id, rows, cols).c;
      if (outside > 0) return fail(res, 409, `Không thể thu nhỏ hộp: ${outside} mẫu nằm ngoài kích thước mới.`);
      upd.rows = rows;
      upd.cols = cols;
      // Kích thước không còn khớp mẫu hộp đã chọn thì bỏ liên kết mẫu, để template_id không nói sai.
      if (cur.template_id != null) {
        const tpl = db.prepare('SELECT rows, cols FROM nhm_box_templates WHERE id = ?').get(cur.template_id);
        if (!tpl || tpl.rows !== rows || tpl.cols !== cols) upd.template_id = null;
      }
    }
    if (!Object.keys(upd).length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    const thayDoi = layThayDoi(cur, upd);
    const cols = Object.keys(thayDoi);
    if (!cols.length) return res.json({ ok: true, changed: 0 });
    try {
      db.transaction(() => {
        db.prepare(`UPDATE nhm_boxes SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...cols.map((c) => upd[c]),
          id
        );
        // Hộp đổi chỗ hoặc đổi mã: ghi vào lịch sử của từng mẫu đang nằm trong hộp, để xem lịch sử mẫu
        // vẫn biết mẫu đã theo hộp sang tủ khác.
        const moi = { ...cur, ...upd };
        let note = null;
        let action = null;
        if (thayDoi.container_id) {
          action = 'box_move';
          note = `Hộp ${moi.code}: ${duongDan(cur.container_id).join(' › ')} → ${duongDan(upd.container_id).join(' › ')}`;
        } else if (thayDoi.code) {
          action = 'box_edit';
          note = `Mã hộp: ${cur.code} → ${moi.code}`;
        }
        if (action) {
          const tubes = db
            .prepare(`SELECT id FROM nhm_tubes WHERE box_id = ? AND deleted_at IS NULL AND status IN ${HOLDING}`)
            .all(id);
          for (const t of tubes) logMove(t.id, action, null, null, req.user.id, note);
        }
      })();
      const hienThi = { ...thayDoi };
      if (hienThi.container_id) hienThi.container_id = hienThi.container_id.map((v) => duongDan(v).join(' › '));
      audit(req, 'box_update', `id=${id} ${cur.code}: ${moTaThayDoi(hienThi)}`);
      res.json({ ok: true, changed: cols.length });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã hộp đã tồn tại.');
      throw e;
    }
  });

  router.delete('/boxes/:id', requireManage, (req, res) => {
    const id = toInt(req.params.id);
    const cur = id && db.prepare('SELECT id, code FROM nhm_boxes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cur) return fail(res, 404, 'Không tìm thấy hộp.');
    const tubes = activeTubeCountInBoxes([id]);
    if (tubes > 0) return fail(res, 409, `Không thể xóa: hộp còn ${tubes} mẫu.`);
    db.prepare("UPDATE nhm_boxes SET deleted_at = datetime('now') WHERE id = ?").run(id);
    audit(req, 'box_delete', `id=${id} ${cur.code}`);
    res.json({ ok: true });
  });

  return router;
};
