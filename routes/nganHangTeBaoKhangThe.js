/**
 * API Ngân hàng tế bào & Kháng thể — mount tại /api/ngan-hang-te-bao-khang-the
 * Vị trí lưu trữ (tủ/bình → ngăn → giá) → hộp (lưới hàng x cột) → mẫu (ống đông lạnh, kháng thể, sinh phẩm...).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const MANAGE_ROLES = new Set(['admin', 'manager', 'phong_khcn']);
const HOLDING = "('in_storage','checked_out')";
const MODULE_LABEL = 'Ngân hàng tế bào & Kháng thể';
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'ngan_hang_te_bao_khang_the_schema.sql');
// Địa chỉ rút gọn + các tên cũ (để liên kết đã gửi vẫn dùng được)
const LEGACY_PATHS = [
  '/ngan-hang-te-bao-khang-the',
  '/ngan-hang-te-bao-khang-the.html',
  '/kho-mau-sinh-pham',
  '/kho-mau-sinh-pham.html',
  '/public/kho-mau-sinh-pham/index.html',
  '/ngan-hang-mau',
  '/ngan-hang-mau.html',
  '/nganhangmau.html',
];

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function toStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

function isUniqueError(e) {
  return !!(e && /UNIQUE constraint/i.test(String(e.message || '')));
}

function createNganHangMauRouter(deps) {
  const { db, authMiddleware, insertUserActivityLog } = deps;
  const router = express.Router();
  router.use(authMiddleware);

  function canManage(req) {
    return MANAGE_ROLES.has(String((req.user && req.user.role) || '').toLowerCase());
  }

  function requireManage(req, res, next) {
    if (!canManage(req)) {
      return res.status(403).json({ message: 'Chỉ Admin / Manager / Phòng KHCN mới có quyền thao tác này.' });
    }
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
      action: 'kmsp_' + action,
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

  function activeTubeCountInBoxes(boxIds) {
    if (!boxIds.length) return 0;
    return db
      .prepare(
        `SELECT COUNT(*) AS c FROM nhm_tubes
         WHERE deleted_at IS NULL AND status IN ${HOLDING} AND box_id IN (${placeholders(boxIds.length)})`
      )
      .get(...boxIds).c;
  }

  function nextCode(table, prefix) {
    const n = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS n FROM ${table}`).get().n;
    return prefix + String(n).padStart(4, '0');
  }

  function logMove(tubeId, action, from, to, userId, note) {
    db.prepare(
      `INSERT INTO nhm_movements (tube_id, action, from_box_id, from_row, from_col, to_box_id, to_row, to_col, user_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      note || null
    );
  }

  // ---------- Danh mục & cây ----------

  router.get('/meta', (req, res) => {
    res.json({
      canManage: canManage(req),
      containerTypes: db.prepare('SELECT * FROM nhm_container_types ORDER BY sort_order, name').all(),
      boxTemplates: db.prepare('SELECT * FROM nhm_box_templates ORDER BY rows, cols, name').all(),
      sampleTypes: db.prepare('SELECT * FROM nhm_sample_types ORDER BY name').all(),
    });
  });

  router.get('/tree', (req, res) => {
    const containers = db
      .prepare(
        `SELECT c.id, c.parent_id, c.type_id, c.code, c.name, c.temperature_c, c.location_note, c.sort_order, c.notes,
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
    res.json({ containers, boxes });
  });

  // ---------- Vị trí lưu trữ ----------

  function readContainerBody(body, partial) {
    const out = {};
    if (!partial || 'name' in body) out.name = toStr(body.name, 200);
    if (!partial || 'type_id' in body) out.type_id = toInt(body.type_id);
    if ('parent_id' in body) out.parent_id = body.parent_id == null || body.parent_id === '' ? null : toInt(body.parent_id);
    if ('code' in body) out.code = toStr(body.code, 60);
    if ('temperature_c' in body) out.temperature_c = toNum(body.temperature_c);
    if ('location_note' in body) out.location_note = toStr(body.location_note, 300);
    if ('notes' in body) out.notes = toStr(body.notes, 2000);
    if ('sort_order' in body) out.sort_order = toInt(body.sort_order) || 0;
    return out;
  }

  router.post('/containers', requireManage, (req, res) => {
    const b = readContainerBody(req.body || {}, false);
    if (!b.name) return fail(res, 400, 'Thiếu tên vị trí lưu trữ.');
    if (b.type_id == null || !db.prepare('SELECT 1 FROM nhm_container_types WHERE id = ?').get(b.type_id)) {
      return fail(res, 400, 'Loại vị trí lưu trữ không hợp lệ.');
    }
    if (b.parent_id != null && !db.prepare('SELECT 1 FROM nhm_containers WHERE id = ? AND deleted_at IS NULL').get(b.parent_id)) {
      return fail(res, 400, 'Vị trí lưu trữ cha không tồn tại.');
    }
    try {
      const code = b.code || nextCode('nhm_containers', 'VC-');
      const info = db
        .prepare(
          `INSERT INTO nhm_containers (parent_id, type_id, code, name, temperature_c, location_note, sort_order, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(b.parent_id ?? null, b.type_id, code, b.name, b.temperature_c ?? null, b.location_note ?? null, b.sort_order || 0, b.notes ?? null, req.user.id);
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
    const b = readContainerBody(req.body || {}, true);
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
    const cols = Object.keys(b);
    if (!cols.length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    try {
      db.prepare(`UPDATE nhm_containers SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...cols.map((c) => b[c]),
        id
      );
      audit(req, 'container_update', `id=${id}`);
      res.json({ ok: true });
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
    const containers = db.prepare('SELECT id, parent_id, name FROM nhm_containers WHERE deleted_at IS NULL').all();
    const byId = new Map(containers.map((c) => [c.id, c]));
    const path = [];
    for (let c = byId.get(box.container_id); c && path.length < 50; c = byId.get(c.parent_id)) path.unshift(c.name);
    const tubes = db
      .prepare(
        `SELECT t.id, t.barcode, t.row_no, t.col_no, t.name, t.passage, t.cell_count, t.volume_ml, t.freeze_date,
                t.project, t.status, t.notes, t.owner_user_id, t.sample_type_id, s.name AS sample_type_name,
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
    }
    const cols = Object.keys(upd);
    if (!cols.length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    try {
      db.prepare(`UPDATE nhm_boxes SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
        ...cols.map((c) => upd[c]),
        id
      );
      audit(req, 'box_update', `id=${id}`);
      res.json({ ok: true });
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

  // ---------- Mẫu ----------

  function readTubeBody(body) {
    const out = {};
    if ('name' in body) out.name = toStr(body.name, 200);
    if ('barcode' in body) out.barcode = toStr(body.barcode, 100);
    if ('sample_type_id' in body) out.sample_type_id = body.sample_type_id == null || body.sample_type_id === '' ? null : toInt(body.sample_type_id);
    if ('passage' in body) out.passage = toStr(body.passage, 50);
    if ('cell_count' in body) out.cell_count = toNum(body.cell_count);
    if ('volume_ml' in body) out.volume_ml = toNum(body.volume_ml);
    if ('freeze_date' in body) out.freeze_date = toStr(body.freeze_date, 10);
    if ('project' in body) out.project = toStr(body.project, 200);
    if ('notes' in body) out.notes = toStr(body.notes, 2000);
    return out;
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
    const t = readTubeBody(body);
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
    const t = readTubeBody(req.body || {});
    if ('name' in t && !t.name) return fail(res, 400, 'Tên mẫu không được để trống.');
    if (t.sample_type_id != null && !db.prepare('SELECT 1 FROM nhm_sample_types WHERE id = ?').get(t.sample_type_id)) {
      return fail(res, 400, 'Loại mẫu không hợp lệ.');
    }
    const cols = Object.keys(t);
    if (!cols.length) return fail(res, 400, 'Không có dữ liệu cần cập nhật.');
    try {
      db.transaction(() => {
        db.prepare(`UPDATE nhm_tubes SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(
          ...cols.map((c) => t[c]),
          id
        );
        logMove(id, 'edit', null, null, req.user.id, cols.join(','));
      })();
      audit(req, 'tube_update', `id=${id}`);
      res.json({ ok: true });
    } catch (e) {
      if (isUniqueError(e)) return fail(res, 409, 'Mã vạch đã tồn tại.');
      throw e;
    }
  });

  router.post('/tubes/:id/move', (req, res) => {
    const id = toInt(req.params.id);
    const cur = loadTube(id);
    if (!cur || cur.status === 'discarded') return fail(res, 404, 'Không tìm thấy mẫu.');
    if (!canEditTube(req, cur)) return fail(res, 403, 'Chỉ người sở hữu hoặc quản lý mới được di chuyển mẫu này.');
    const boxId = toInt((req.body || {}).box_id);
    const row = toInt((req.body || {}).row_no);
    const col = toInt((req.body || {}).col_no);
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
}

/** Số liệu thẻ module trên trang chủ; bảng chưa có thì trả 0. */
function miniStats(db) {
  const count = (sql) => {
    try {
      return Number(db.prepare(sql).get().c) || 0;
    } catch (e) {
      return 0;
    }
  };
  return {
    containers: count('SELECT COUNT(*) AS c FROM nhm_containers WHERE deleted_at IS NULL'),
    boxes: count('SELECT COUNT(*) AS c FROM nhm_boxes WHERE deleted_at IS NULL'),
    samples: count(`SELECT COUNT(*) AS c FROM nhm_tubes WHERE deleted_at IS NULL AND status IN ${HOLDING}`),
  };
}

/** Tạo bảng nhm_*, chuyển hướng địa chỉ cũ, đồng bộ nhãn trang chủ và mount API — gọi từ server.js. */
function mount(app, deps) {
  const { db } = deps;
  if (fs.existsSync(SCHEMA_PATH)) db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  app.get(LEGACY_PATHS, (req, res) => res.redirect(302, '/public/ngan-hang-te-bao-khang-the/index.html'));
  // Đồng bộ tên hiển thị cho cơ sở dữ liệu đã có dòng homepage_modules từ tên cũ
  db.prepare("UPDATE homepage_modules SET label = ? WHERE code = 'sample_storage' AND label <> ?").run(MODULE_LABEL, MODULE_LABEL);
  app.use('/api/ngan-hang-te-bao-khang-the', createNganHangMauRouter(deps));
}

module.exports = createNganHangMauRouter;
module.exports.miniStats = miniStats;
module.exports.mount = mount;
