/**
 * Module Quản lý tài liệu & hồ sơ (giấy tờ hành chính) — /api/dms/*
 * RBAC: admin hệ thống toàn quyền module; manager / uploader / viewer trong dms_user_roles.
 * Gán vai trò module (dms_user_roles): chỉ Master Admin; chỉ cho user đã có trong dms_module_access.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');
const XLSX = require('xlsx');
const {
  DMS_NO_FILE,
  parseWorkbookBuffer,
  countDuplicateSummary,
  runQuyetDinhImport,
} = require('./dmsQuyetDinhImport');

let QRCode;
try {
  QRCode = require('qrcode');
} catch (_) {
  QRCode = null;
}

const DMS_ROLES = ['manager', 'uploader', 'viewer'];

function userHasDmsModuleAccess(db, user) {
  if (!user || user.id == null) return false;
  const sys = String(user.role || '').toLowerCase();
  if (sys === 'admin') return true;
  try {
    const row = db.prepare('SELECT 1 AS x FROM dms_module_access WHERE user_id = ?').get(user.id);
    return !!(row && row.x);
  } catch (_) {
    return false;
  }
}

function getDmsModuleRole(db, user) {
  const sys = String(user && user.role || '').toLowerCase();
  if (sys === 'admin') return 'admin';
  if (!userHasDmsModuleAccess(db, user)) return null;
  try {
    const row = db.prepare('SELECT role FROM dms_user_roles WHERE user_id = ?').get(user.id);
    return row && row.role ? String(row.role) : null;
  } catch (_) {
    return null;
  }
}

function permFlags(role, sysAdmin, masterAdmin, accessListed) {
  const r = role || null;
  const isSysAdmin = !!sysAdmin;
  return {
    role: r,
    canView: !!r,
    canUpload: r === 'admin' || r === 'manager' || r === 'uploader',
    canManageCatalog: r === 'admin' || r === 'manager',
    canManageAllDocs: r === 'admin' || r === 'manager',
    canAssignRoles: !!masterAdmin,
    isSysAdmin,
    isMasterAdmin: !!masterAdmin,
    dmsAccessListed: !!accessListed,
  };
}

function requireDmsView(db) {
  return (req, res, next) => {
    const sys = String(req.user.role || '').toLowerCase();
    if (sys === 'admin') {
      req.dmsRole = 'admin';
      return next();
    }
    if (!userHasDmsModuleAccess(db, req.user)) {
      return res.status(403).json({
        ok: false,
        message:
          'Bạn chưa nằm trong danh sách được mở truy cập module Tài liệu & hồ sơ. Liên hệ Master Admin.',
      });
    }
    let r = null;
    try {
      const row = db.prepare('SELECT role FROM dms_user_roles WHERE user_id = ?').get(req.user.id);
      r = row && row.role ? String(row.role) : null;
    } catch (_) {}
    if (!r) {
      return res.status(403).json({
        ok: false,
        message:
          'Tài khoản đã được mở truy cập module nhưng chưa được gán vai trò (Quản lý / Tải lên / Chỉ xem). Liên hệ Master Admin.',
      });
    }
    req.dmsRole = r;
    next();
  };
}

function requireDmsUpload(db) {
  return (req, res, next) => {
    const role = getDmsModuleRole(db, req.user);
    if (!role || !['admin', 'manager', 'uploader'].includes(role)) {
      return res.status(403).json({ ok: false, message: 'Không có quyền tải lên tài liệu.' });
    }
    req.dmsRole = role;
    next();
  };
}

function requireDmsCatalog(db) {
  return (req, res, next) => {
    const role = getDmsModuleRole(db, req.user);
    if (!role || !['admin', 'manager'].includes(role)) {
      return res.status(403).json({ ok: false, message: 'Chỉ Quản lý module hoặc Admin mới chỉnh danh mục.' });
    }
    req.dmsRole = role;
    next();
  };
}

function requireDmsManageDocs(db) {
  return (req, res, next) => {
    const role = getDmsModuleRole(db, req.user);
    if (!role || !['admin', 'manager'].includes(role)) {
      return res.status(403).json({ ok: false, message: 'Không có quyền thao tác hàng loạt / xóa tài liệu người khác.' });
    }
    req.dmsRole = role;
    next();
  };
}

function canEditDocument(role, doc, userId) {
  if (role === 'admin' || role === 'manager') return true;
  if (role === 'uploader' && doc && Number(doc.uploaded_by_id) === Number(userId)) return true;
  return false;
}

function canDeleteDocument(role, doc, userId) {
  if (role === 'admin' || role === 'manager') return true;
  if (role === 'uploader' && doc && Number(doc.uploaded_by_id) === Number(userId)) {
    return String(doc.status || '').toLowerCase() === 'draft';
  }
  return false;
}

function categorySubtreeIds(db, rootId) {
  if (rootId == null || rootId === '' || rootId === 'all') return null;
  const id = Number(rootId);
  if (!Number.isFinite(id)) return [];
  try {
    const rows = db
      .prepare(
        `WITH RECURSIVE sub AS (
           SELECT id FROM dms_categories WHERE id = ? AND COALESCE(is_active,1) = 1
           UNION ALL
           SELECT c.id FROM dms_categories c JOIN sub s ON c.parent_id = s.id
           WHERE COALESCE(c.is_active,1) = 1
         ) SELECT id FROM sub`
      )
      .all(id);
    return rows.map((r) => r.id);
  } catch (_) {
    return [id];
  }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = function createDmsRecordsRouter({
  db,
  adminOnly,
  masterAdminOnly,
  isMasterAdmin,
  uploadsDir,
}) {
  const router = express.Router();
  const dmsDir = uploadsDir || path.join(__dirname, '..', 'uploads', 'dms');
  fs.mkdirSync(dmsDir, { recursive: true });
  const dmsDirResolved = path.resolve(dmsDir);
  function resolveDmsStoredFileForUnlink(filePath) {
    if (!filePath || filePath === DMS_NO_FILE) return null;
    const full = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(dmsDir, path.basename(filePath));
    const norm = path.normalize(full);
    const rel = path.relative(dmsDirResolved, norm);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try {
      if (!fs.existsSync(norm) || !fs.statSync(norm).isFile()) return null;
    } catch (_) {
      return null;
    }
    return norm;
  }

  const storage = multer.diskStorage({
    destination: function (_req, _file, cb) {
      cb(null, dmsDir);
    },
    filename: function (_req, file, cb) {
      const ext = path.extname(file.originalname || '') || '';
      const base = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      cb(null, base + ext);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 80 * 1024 * 1024 },
  });
  const uploadXlsx = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 35 * 1024 * 1024 },
    fileFilter(_req, file, cb) {
      const n = (file.originalname || '').toLowerCase();
      if (!/\.(xlsx|xls)$/i.test(n)) {
        return cb(new Error('Chỉ chấp nhận .xlsx hoặc .xls'));
      }
      cb(null, true);
    },
  });

  const needView = requireDmsView(db);
  const needUpload = requireDmsUpload(db);
  const needCatalog = requireDmsCatalog(db);
  const needManageDocs = requireDmsManageDocs(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS dms_document_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      original_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      uploaded_by_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(document_id) REFERENCES dms_documents(id) ON DELETE CASCADE
    );
  `);

  function parseBodyInt(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }

  router.get('/me', (req, res) => {
    const sysAdmin = String(req.user.role || '').toLowerCase() === 'admin';
    const accessListed = sysAdmin || userHasDmsModuleAccess(db, req.user);
    const role = getDmsModuleRole(db, req.user);
    const master =
      typeof isMasterAdmin === 'function' ? !!isMasterAdmin(req) : false;
    res.json({
      ok: true,
      userId: req.user.id,
      ...permFlags(role, sysAdmin, master, accessListed),
    });
  });

  router.get('/stats', needView, (req, res) => {
    try {
      const now = todayStr();
      const soon = addDaysStr(30);
      const total = db.prepare('SELECT COUNT(*) AS c FROM dms_documents').get().c;
      const active = db
        .prepare(`SELECT COUNT(*) AS c FROM dms_documents WHERE lower(status) = 'active'`)
        .get().c;
      const draft = db
        .prepare(`SELECT COUNT(*) AS c FROM dms_documents WHERE lower(status) = 'draft'`)
        .get().c;
      const expired = db
        .prepare(
          `SELECT COUNT(*) AS c FROM dms_documents WHERE lower(status) IN ('expired','revoked')`
        )
        .get().c;
      const expiringSoon = db
        .prepare(
          `SELECT COUNT(*) AS c FROM dms_documents
           WHERE lower(status) = 'active' AND valid_until IS NOT NULL AND TRIM(valid_until) != ''
             AND date(valid_until) >= date(?) AND date(valid_until) <= date(?)`
        )
        .get(now, soon).c;
      const dup = countDuplicateSummary(db);
      const missingPdf = db
        .prepare(
          `SELECT COUNT(*) AS c FROM dms_documents
           WHERE file_path IS NULL OR TRIM(COALESCE(file_path,'')) = '' OR file_path = ?`
        )
        .get(DMS_NO_FILE).c;
      const scanOnly = db
        .prepare(
          `SELECT COUNT(*) AS c FROM dms_documents
           WHERE (file_path IS NULL OR file_path = ?) AND TRIM(COALESCE(external_scan_link,'')) != ''`
        )
        .get(DMS_NO_FILE).c;
      const destructionAlertHorizon = addDaysStr(90);
      const destructionAlert = db
        .prepare(
          `SELECT COUNT(*) AS c FROM dms_documents
           WHERE destruction_eligible_date IS NOT NULL AND TRIM(destruction_eligible_date) != ''
             AND date(destruction_eligible_date) <= date(?)`
        )
        .get(destructionAlertHorizon).c;
      const outOnLoan = db
        .prepare(
          `SELECT COUNT(DISTINCT document_id) AS c FROM dms_document_loans WHERE returned_at IS NULL`
        )
        .get().c;

      let templatesTotal = 0;
      let templatesActive = 0;
      let templatesDraft = 0;
      let templatesRetired = 0;
      let documentsWithTemplate = 0;
      try {
        templatesTotal = db.prepare('SELECT COUNT(*) AS c FROM dms_templates').get().c;
        templatesActive = db
          .prepare(`SELECT COUNT(*) AS c FROM dms_templates WHERE lower(trim(COALESCE(status,''))) = 'active'`)
          .get().c;
        templatesDraft = db
          .prepare(`SELECT COUNT(*) AS c FROM dms_templates WHERE lower(trim(COALESCE(status,''))) = 'draft'`)
          .get().c;
        templatesRetired = db
          .prepare(`SELECT COUNT(*) AS c FROM dms_templates WHERE lower(trim(COALESCE(status,''))) = 'retired'`)
          .get().c;
        documentsWithTemplate = db
          .prepare('SELECT COUNT(*) AS c FROM dms_documents WHERE template_id IS NOT NULL')
          .get().c;
      } catch (te) {
        console.warn('[dms/stats] template counts:', te.message);
      }

      res.json({
        ok: true,
        total,
        active,
        draft,
        expired,
        expiringSoon,
        duplicateGroups: dup.duplicateGroups,
        documentsInDuplicateGroups: dup.documentsInDuplicateGroups,
        missingPdf,
        scanOnly,
        destructionAlert,
        outOnLoan,
        templatesTotal,
        templatesActive,
        templatesDraft,
        templatesRetired,
        documentsWithTemplate,
      });
    } catch (e) {
      console.error('[dms/stats]', e);
      res.status(500).json({ ok: false, message: e.message || 'Lỗi' });
    }
  });

  router.get('/categories', needView, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, parent_id, name, sort_order, is_active FROM dms_categories
           ORDER BY COALESCE(parent_id, -1), sort_order, id`
        )
        .all();
      const counts = {};
      for (const c of rows) {
        const sub = categorySubtreeIds(db, c.id);
        if (!sub || !sub.length) {
          counts[c.id] = 0;
          continue;
        }
        const ph = sub.map(() => '?').join(',');
        const cntRow = db
          .prepare(`SELECT COUNT(*) AS c FROM dms_documents WHERE category_id IN (${ph})`)
          .get(...sub);
        counts[c.id] = cntRow ? cntRow.c : 0;
      }
      res.json({ ok: true, categories: rows, counts });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/categories', needCatalog, (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, message: 'Thiếu tên danh mục' });
      const parentId =
        req.body.parent_id != null && req.body.parent_id !== ''
          ? Number(req.body.parent_id)
          : null;
      const sortOrder = Number(req.body.sort_order) || 0;
      const r = db
        .prepare(
          `INSERT INTO dms_categories (parent_id, name, sort_order, is_active) VALUES (?, ?, ?, 1)`
        )
        .run(Number.isFinite(parentId) ? parentId : null, name, sortOrder);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.patch('/categories/:id', needCatalog, (req, res) => {
    try {
      const id = Number(req.params.id);
      const name = req.body.name != null ? String(req.body.name).trim() : null;
      const sortOrder = req.body.sort_order != null ? Number(req.body.sort_order) : null;
      const isActive = req.body.is_active != null ? (req.body.is_active ? 1 : 0) : null;
      const cur = db.prepare('SELECT * FROM dms_categories WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      db.prepare(
        `UPDATE dms_categories SET
           name = COALESCE(?, name),
           sort_order = COALESCE(?, sort_order),
           is_active = COALESCE(?, is_active)
         WHERE id = ?`
      ).run(name || null, Number.isFinite(sortOrder) ? sortOrder : null, isActive, id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.delete('/categories/:id', needCatalog, (req, res) => {
    try {
      const id = Number(req.params.id);
      const child = db.prepare('SELECT id FROM dms_categories WHERE parent_id = ? LIMIT 1').get(id);
      if (child) return res.status(400).json({ ok: false, message: 'Còn danh mục con — không xóa được.' });
      const used = db.prepare('SELECT id FROM dms_documents WHERE category_id = ? LIMIT 1').get(id);
      if (used) return res.status(400).json({ ok: false, message: 'Đang có tài liệu — không xóa được.' });
      db.prepare('DELETE FROM dms_categories WHERE id = ?').run(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/document-types', needView, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, name, code, sort_order, is_active FROM dms_document_types ORDER BY sort_order, id`
        )
        .all();
      res.json({ ok: true, types: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/document-types', needCatalog, (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, message: 'Thiếu tên loại' });
      const code = req.body.code != null ? String(req.body.code).trim() : null;
      const sortOrder = Number(req.body.sort_order) || 0;
      const r = db
        .prepare(
          `INSERT INTO dms_document_types (name, code, sort_order, is_active) VALUES (?, ?, ?, 1)`
        )
        .run(name, code, sortOrder);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.patch('/document-types/:id', needCatalog, (req, res) => {
    try {
      const id = Number(req.params.id);
      const cur = db.prepare('SELECT * FROM dms_document_types WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const name =
        req.body.name != null ? String(req.body.name).trim() || cur.name : cur.name;
      const code = req.body.code !== undefined ? String(req.body.code || '').trim() || null : cur.code;
      const sortOrder =
        req.body.sort_order != null && Number.isFinite(Number(req.body.sort_order))
          ? Number(req.body.sort_order)
          : cur.sort_order;
      const isActive =
        req.body.is_active != null ? (req.body.is_active ? 1 : 0) : cur.is_active;
      db.prepare(
        `UPDATE dms_document_types SET name = ?, code = ?, sort_order = ?, is_active = ? WHERE id = ?`
      ).run(name, code, sortOrder, isActive, id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.delete('/document-types/:id', needCatalog, (req, res) => {
    try {
      const id = Number(req.params.id);
      const used = db.prepare('SELECT id FROM dms_documents WHERE document_type_id = ? LIMIT 1').get(id);
      if (used) return res.status(400).json({ ok: false, message: 'Đang được dùng — không xóa.' });
      db.prepare('DELETE FROM dms_document_types WHERE id = ?').run(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/tags', needView, (req, res) => {
    try {
      const rows = db.prepare(`SELECT id, name, color, sort_order FROM dms_tags ORDER BY sort_order, name`).all();
      res.json({ ok: true, tags: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/tags', needCatalog, (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, message: 'Thiếu tên thẻ' });
      const color = String(req.body.color || '#64748b').trim();
      const sortOrder = Number(req.body.sort_order) || 0;
      const r = db.prepare(`INSERT INTO dms_tags (name, color, sort_order) VALUES (?, ?, ?)`).run(
        name,
        color,
        sortOrder
      );
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(400).json({ ok: false, message: 'Tên thẻ đã tồn tại' });
      }
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.patch('/tags/:id', needCatalog, (req, res) => {
    try {
      const id = Number(req.params.id);
      const name = req.body.name != null ? String(req.body.name).trim() : null;
      const color = req.body.color != null ? String(req.body.color).trim() : null;
      const sortOrder = req.body.sort_order != null ? Number(req.body.sort_order) : null;
      db.prepare(
        `UPDATE dms_tags SET
           name = COALESCE(NULLIF(?, ''), name),
           color = COALESCE(NULLIF(?, ''), color),
           sort_order = COALESCE(?, sort_order)
         WHERE id = ?`
      ).run(name || '', color || '', Number.isFinite(sortOrder) ? sortOrder : null, id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.delete('/tags/:id', needCatalog, (req, res) => {
    try {
      const id = Number(req.params.id);
      db.prepare('DELETE FROM dms_document_tags WHERE tag_id = ?').run(id);
      db.prepare('DELETE FROM dms_tags WHERE id = ?').run(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  /** Mẫu biểu / template — định danh kiểm soát (ISO / quản lý hồ sơ): mã, phiên bản, phân loại, lưu trữ… */
  router.get('/templates', needView, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT t.*,
            (SELECT COUNT(*) FROM dms_documents d WHERE d.template_id = t.id) AS document_count
           FROM dms_templates t
           ORDER BY COALESCE(t.sort_order, 0), lower(t.name), t.id`
        )
        .all();
      res.json({ ok: true, templates: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/templates', needCatalog, express.json(), (req, res) => {
    try {
      const code = String(req.body.code || '').trim();
      const name = String(req.body.name || '').trim();
      if (!code) return res.status(400).json({ ok: false, message: 'Thiếu mã mẫu biểu (code).' });
      if (!name) return res.status(400).json({ ok: false, message: 'Thiếu tên mẫu biểu.' });
      const version = String(req.body.version || '1.0').trim() || '1.0';
      const status = String(req.body.status || 'active').toLowerCase();
      const st = ['draft', 'active', 'retired'].includes(status) ? status : 'active';
      const recordKind = String(req.body.record_kind || 'record').toLowerCase();
      const rk = ['document', 'record'].includes(recordKind) ? recordKind : 'record';
      const description = req.body.description != null ? String(req.body.description).trim() || null : null;
      const retentionPolicy =
        req.body.retention_policy != null ? String(req.body.retention_policy).trim() || null : null;
      const mediumNotes = req.body.medium_notes != null ? String(req.body.medium_notes).trim() || null : null;
      const owningUnit = req.body.owning_unit != null ? String(req.body.owning_unit).trim() || null : null;
      const effectiveFrom =
        req.body.effective_from != null ? String(req.body.effective_from || '').trim() || null : null;
      const effectiveUntil =
        req.body.effective_until != null ? String(req.body.effective_until || '').trim() || null : null;
      const blankFormUrl =
        req.body.blank_form_url != null ? String(req.body.blank_form_url || '').trim() || null : null;
      let supersededById = null;
      if (req.body.superseded_by_id != null && req.body.superseded_by_id !== '') {
        const sid = Number(req.body.superseded_by_id);
        if (Number.isFinite(sid) && sid > 0) {
          const ex = db.prepare('SELECT id FROM dms_templates WHERE id = ?').get(sid);
          if (ex) supersededById = sid;
        }
      }
      const sortOrder = Number(req.body.sort_order) || 0;
      const isActive = req.body.is_active != null ? (req.body.is_active ? 1 : 0) : 1;
      const r = db
        .prepare(
          `INSERT INTO dms_templates (
            code, name, version, status, record_kind, description, retention_policy, medium_notes,
            owning_unit, effective_from, effective_until, blank_form_url, superseded_by_id,
            sort_order, is_active, created_by_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          code,
          name,
          version,
          st,
          rk,
          description,
          retentionPolicy,
          mediumNotes,
          owningUnit,
          effectiveFrom,
          effectiveUntil,
          blankFormUrl,
          supersededById,
          sortOrder,
          isActive,
          req.user.id
        );
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(400).json({ ok: false, message: 'Mã mẫu biểu (code) đã tồn tại.' });
      }
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.patch('/templates/:id', needCatalog, express.json(), (req, res) => {
    try {
      const id = Number(req.params.id);
      const cur = db.prepare('SELECT * FROM dms_templates WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ ok: false, message: 'Không tìm thấy mẫu biểu.' });
      const code = req.body.code != null ? String(req.body.code).trim() || cur.code : cur.code;
      const name = req.body.name != null ? String(req.body.name).trim() || cur.name : cur.name;
      const version = req.body.version != null ? String(req.body.version).trim() || cur.version : cur.version;
      let status = cur.status;
      if (req.body.status != null) {
        const s = String(req.body.status).toLowerCase();
        if (['draft', 'active', 'retired'].includes(s)) status = s;
      }
      let recordKind = cur.record_kind || 'record';
      if (req.body.record_kind != null) {
        const rk = String(req.body.record_kind).toLowerCase();
        if (['document', 'record'].includes(rk)) recordKind = rk;
      }
      const description =
        req.body.description !== undefined
          ? String(req.body.description || '').trim() || null
          : cur.description;
      const retentionPolicy =
        req.body.retention_policy !== undefined
          ? String(req.body.retention_policy || '').trim() || null
          : cur.retention_policy;
      const mediumNotes =
        req.body.medium_notes !== undefined
          ? String(req.body.medium_notes || '').trim() || null
          : cur.medium_notes;
      const owningUnit =
        req.body.owning_unit !== undefined
          ? String(req.body.owning_unit || '').trim() || null
          : cur.owning_unit;
      const effectiveFrom =
        req.body.effective_from !== undefined
          ? String(req.body.effective_from || '').trim() || null
          : cur.effective_from;
      const effectiveUntil =
        req.body.effective_until !== undefined
          ? String(req.body.effective_until || '').trim() || null
          : cur.effective_until;
      const blankFormUrl =
        req.body.blank_form_url !== undefined
          ? String(req.body.blank_form_url || '').trim() || null
          : cur.blank_form_url;
      let supersededById = cur.superseded_by_id;
      if (req.body.superseded_by_id !== undefined) {
        if (req.body.superseded_by_id === null || req.body.superseded_by_id === '') {
          supersededById = null;
        } else {
          const sid = Number(req.body.superseded_by_id);
          if (Number.isFinite(sid) && sid > 0 && sid !== id) {
            const ex = db.prepare('SELECT id FROM dms_templates WHERE id = ?').get(sid);
            if (ex) supersededById = sid;
          }
        }
      }
      const sortOrder =
        req.body.sort_order != null && Number.isFinite(Number(req.body.sort_order))
          ? Number(req.body.sort_order)
          : cur.sort_order;
      const isActive = req.body.is_active != null ? (req.body.is_active ? 1 : 0) : cur.is_active;
      db.prepare(
        `UPDATE dms_templates SET
          code = ?, name = ?, version = ?, status = ?, record_kind = ?,
          description = ?, retention_policy = ?, medium_notes = ?, owning_unit = ?,
          effective_from = ?, effective_until = ?, blank_form_url = ?, superseded_by_id = ?,
          sort_order = ?, is_active = ?, updated_at = datetime('now','localtime')
        WHERE id = ?`
      ).run(
        code,
        name,
        version,
        status,
        recordKind,
        description,
        retentionPolicy,
        mediumNotes,
        owningUnit,
        effectiveFrom,
        effectiveUntil,
        blankFormUrl,
        supersededById,
        sortOrder,
        isActive,
        id
      );
      res.json({ ok: true });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(400).json({ ok: false, message: 'Mã mẫu biểu (code) đã tồn tại.' });
      }
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.delete('/templates/:id', needCatalog, (req, res) => {
    try {
      const id = Number(req.params.id);
      const used = db.prepare('SELECT id FROM dms_documents WHERE template_id = ? LIMIT 1').get(id);
      if (used) {
        return res.status(400).json({
          ok: false,
          message: 'Còn tài liệu đang gắn mẫu này — gỡ mẫu khỏi tài liệu trước khi xóa.',
        });
      }
      db.prepare('DELETE FROM dms_templates WHERE id = ?').run(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  function dmsDocListFromClause() {
    return `FROM dms_documents d
      LEFT JOIN dms_templates tpl ON tpl.id = d.template_id`;
  }

  function validateDmsTemplateId(raw) {
    if (raw === undefined || raw === null || raw === '') return { ok: true, id: null };
    const id = Number(raw);
    if (!Number.isFinite(id) || id <= 0) return { ok: false, message: 'Mã mẫu biểu (template) không hợp lệ.' };
    const row = db.prepare('SELECT id FROM dms_templates WHERE id = ?').get(id);
    if (!row) return { ok: false, message: 'Không tồn tại mẫu biểu với ID đã chọn.' };
    return { ok: true, id };
  }

  function buildDocumentListQuery(filters) {
    const {
      q,
      categoryId,
      status,
      year,
      docTypeId,
      templateId,
      hasTemplate,
      tagIds,
      quick,
      sort,
      duplicatesOnly,
      documentId,
    } = filters;
    const params = [];
    let where = '1=1';

    if (documentId != null && documentId !== '') {
      const did = Number(documentId);
      if (Number.isFinite(did) && did > 0) {
        where += ' AND d.id = ?';
        params.push(did);
      }
    }

    if (duplicatesOnly) {
      where += ` AND d.id IN (
        SELECT d2.id FROM dms_documents d2
        INNER JOIN (
          SELECT lower(trim(COALESCE(ref_number,''))) AS r, issue_date AS idate
          FROM dms_documents
          WHERE COALESCE(trim(ref_number), '') != '' AND COALESCE(trim(issue_date), '') != ''
          GROUP BY lower(trim(COALESCE(ref_number,''))), issue_date
          HAVING COUNT(*) > 1
        ) dup ON lower(trim(COALESCE(d2.ref_number,''))) = dup.r AND d2.issue_date = dup.idate
      )`;
    }

    if (q && String(q).trim()) {
      const like = `%${String(q).trim().toLowerCase().replace(/%/g, '').slice(0, 120)}%`;
      where += ` AND (
        lower(COALESCE(d.title,'')) LIKE ?
        OR lower(COALESCE(d.ref_number,'')) LIKE ?
        OR lower(COALESCE(d.notes,'')) LIKE ?
        OR lower(COALESCE(d.issuing_unit,'')) LIKE ?
        OR lower(COALESCE(d.external_scan_link,'')) LIKE ?
        OR lower(COALESCE(d.external_word_link,'')) LIKE ?
        OR lower(COALESCE(tpl.code,'')) LIKE ?
        OR lower(COALESCE(tpl.name,'')) LIKE ?
      )`;
      params.push(like, like, like, like, like, like, like, like);
    }

    if (categoryId != null && categoryId !== '' && categoryId !== 'all') {
      const ids = categorySubtreeIds(db, categoryId);
      if (ids && ids.length) {
        where += ` AND d.category_id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
      } else if (Array.isArray(ids) && ids.length === 0) {
        where += ' AND 1=0';
      }
    }

    if (docTypeId != null && docTypeId !== '') {
      where += ' AND d.document_type_id = ?';
      params.push(Number(docTypeId));
    }

    if (templateId != null && templateId !== '') {
      const tid = Number(templateId);
      if (Number.isFinite(tid) && tid > 0) {
        where += ' AND d.template_id = ?';
        params.push(tid);
      }
    }

    const ht = hasTemplate != null ? String(hasTemplate).trim() : '';
    if (ht === '1') {
      where += ' AND d.template_id IS NOT NULL';
    } else if (ht === '0') {
      where += ' AND d.template_id IS NULL';
    }

    if (status && String(status).toLowerCase() !== 'all') {
      where += ' AND lower(d.status) = ?';
      params.push(String(status).toLowerCase());
    }

    if (quick) {
      const qk = String(quick).toLowerCase();
      if (qk === 'active') where += ` AND lower(d.status) = 'active'`;
      else if (qk === 'draft') where += ` AND lower(d.status) = 'draft'`;
      else if (qk === 'expired_revoked')
        where += ` AND lower(d.status) IN ('expired','revoked')`;
    }

    if (year != null && String(year).trim() && String(year) !== 'all') {
      const y = String(year).slice(0, 4);
      if (/^\d{4}$/.test(y)) {
        where += ` AND (
          strftime('%Y', COALESCE(d.issue_date, d.uploaded_at)) = ?
        )`;
        params.push(y);
      }
    }

    if (tagIds && tagIds.length) {
      const placeholders = tagIds.map(() => '?').join(',');
      where += ` AND d.id IN (
        SELECT document_id FROM dms_document_tags WHERE tag_id IN (${placeholders})
      )`;
      params.push(...tagIds);
    }

    const fileMode = filters.fileMode != null ? String(filters.fileMode).toLowerCase() : '';
    if (fileMode === 'missing_pdf') {
      where += ` AND (d.file_path IS NULL OR TRIM(COALESCE(d.file_path,'')) = '' OR d.file_path = ?)`;
      params.push(DMS_NO_FILE);
    } else if (fileMode === 'scan_only') {
      where += ` AND (d.file_path IS NULL OR d.file_path = ?) AND TRIM(COALESCE(d.external_scan_link,'')) != ''`;
      params.push(DMS_NO_FILE);
    }

    if (filters.retentionAlert) {
      const horizon = addDaysStr(90);
      where += ` AND d.destruction_eligible_date IS NOT NULL AND TRIM(d.destruction_eligible_date) != ''
        AND date(d.destruction_eligible_date) <= date(?)`;
      params.push(horizon);
    }

    if (filters.outOnLoan) {
      where += ` AND EXISTS (
        SELECT 1 FROM dms_document_loans L WHERE L.document_id = d.id AND L.returned_at IS NULL
      )`;
    }

    let orderBy = 'd.uploaded_at DESC';
    if (sort === 'issue_date') orderBy = 'd.issue_date DESC, d.id DESC';
    if (sort === 'title') orderBy = 'd.title COLLATE NOCASE ASC';
    if (sort === 'valid_until') orderBy = 'd.valid_until ASC, d.id DESC';

    return { where, params, orderBy };
  }

  router.get('/duplicates-summary', needView, (req, res) => {
    try {
      res.json({ ok: true, ...countDuplicateSummary(db) });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  function handleXlsxUpload(req, res, next) {
    uploadXlsx.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, message: err.message || String(err) });
      next();
    });
  }

  router.post('/import/excel-preview', needUpload, handleXlsxUpload, (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ ok: false, message: 'Thiếu file Excel (.xlsx / .xls)' });
      }
      const parsed = parseWorkbookBuffer(req.file.buffer);
      const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
      const documentTypeId = req.body.document_type_id ? Number(req.body.document_type_id) : null;
      const defaultStatus = String(req.body.default_status || 'active').toLowerCase();
      const dry = runQuyetDinhImport(db, parsed, {
        userId: req.user.id,
        categoryId,
        documentTypeId,
        defaultStatus,
        dryRun: true,
      });
      res.json({
        ok: true,
        preview: true,
        parseErrors: parsed.errors,
        sheetSummary: parsed.sheets.map((s) => ({ name: s.name, headerRow: s.headerRow, dataRows: s.rowCount })),
        wouldImport: dry.imported,
        wouldSkipDb: dry.skippedDbDuplicate,
        wouldSkipBatch: dry.skippedBatchDuplicate,
        parseRowErrors: dry.errors,
        details: dry.details,
      });
    } catch (e) {
      console.error('[dms import preview]', e);
      res.status(500).json({ ok: false, message: e.message || 'Lỗi đọc Excel' });
    }
  });

  router.post('/import/excel', needUpload, handleXlsxUpload, (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ ok: false, message: 'Thiếu file Excel (.xlsx / .xls)' });
      }
      const parsed = parseWorkbookBuffer(req.file.buffer);
      if (parsed.errors.length && !parsed.sheets.length) {
        return res.status(400).json({
          ok: false,
          message: 'Không đọc được sheet hợp lệ',
          parseErrors: parsed.errors,
        });
      }
      const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
      const documentTypeId = req.body.document_type_id ? Number(req.body.document_type_id) : null;
      const defaultStatus = String(req.body.default_status || 'active').toLowerCase();
      const result = runQuyetDinhImport(db, parsed, {
        userId: req.user.id,
        categoryId,
        documentTypeId,
        defaultStatus,
        dryRun: false,
      });
      res.json({
        ok: true,
        imported: result.imported,
        skippedDbDuplicate: result.skippedDbDuplicate,
        skippedBatchDuplicate: result.skippedBatchDuplicate,
        parseErrors: parsed.errors,
        rowErrors: result.errors,
        details: result.details,
        message: `Đã nhập ${result.imported} dòng. Bỏ qua ${result.skippedDbDuplicate} trùng CSDL, ${result.skippedBatchDuplicate} trùng trong file.`,
      });
    } catch (e) {
      console.error('[dms import excel]', e);
      res.status(500).json({ ok: false, message: e.message || 'Lỗi import' });
    }
  });

  router.post('/documents/bulk-delete', needManageDocs, express.json(), (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => Number(x)).filter((n) => n > 0) : [];
      if (!ids.length) return res.status(400).json({ ok: false, message: 'Thiếu danh sách' });
      const sel = db.prepare('SELECT * FROM dms_documents WHERE id = ?');
      const del = db.prepare('DELETE FROM dms_documents WHERE id = ?');
      for (const id of ids) {
        const doc = sel.get(id);
        if (!doc) continue;
        const abs = resolveDmsStoredFileForUnlink(doc.file_path);
        del.run(id);
        try {
          if (abs) fs.unlinkSync(abs);
        } catch (_) {}
      }
      res.json({ ok: true, deleted: ids.length });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/documents/bulk-move', needManageDocs, express.json(), (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => Number(x)).filter((n) => n > 0) : [];
      const categoryId = req.body.category_id != null ? Number(req.body.category_id) : null;
      if (!ids.length) return res.status(400).json({ ok: false, message: 'Thiếu danh sách' });
      const stmt = db.prepare(
        `UPDATE dms_documents SET category_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`
      );
      for (const id of ids) {
        stmt.run(Number.isFinite(categoryId) ? categoryId : null, id);
      }
      res.json({ ok: true, moved: ids.length });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/documents/bulk-download', needView, express.json(), (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => Number(x)).filter((n) => n > 0) : [];
      if (!ids.length) return res.status(400).json({ ok: false, message: 'Thiếu danh sách' });
      if (ids.length > 50) return res.status(400).json({ ok: false, message: 'Tối đa 50 tệp mỗi lần' });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="tai-lieu-stims.zip"');
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err) => {
        console.error('[dms zip]', err);
        if (!res.headersSent) res.status(500).end();
      });
      archive.pipe(res);

      const sel = db.prepare('SELECT id, file_path, original_name FROM dms_documents WHERE id = ?');
      const usedNames = {};
      for (const id of ids) {
        const doc = sel.get(id);
        if (!doc) continue;
        const abs = path.isAbsolute(doc.file_path)
          ? doc.file_path
          : path.join(dmsDir, path.basename(doc.file_path));
        if (!doc.file_path || doc.file_path === DMS_NO_FILE || !fs.existsSync(abs)) continue;
        let base = (doc.original_name || `file_${id}`).replace(/[/\\?%*:|"<>]/g, '_');
        if (usedNames[base]) {
          const ext = path.extname(base);
          const stem = path.basename(base, ext);
          usedNames[base] += 1;
          base = `${stem}_${usedNames[base]}${ext}`;
        } else {
          usedNames[base] = 1;
        }
        archive.file(abs, { name: base });
      }
      archive.finalize();
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/documents/:id/label.html', needView, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const row = db
        .prepare(
          `SELECT id, title, ref_number, physical_location, physical_copy_type FROM dms_documents WHERE id = ?`
        )
        .get(id);
      if (!row) return res.status(404).send('Không tìm thấy');
      const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
      const host = req.get('host') || '';
      const listUrl = `${proto}://${host}/tai-lieu-hanh-chinh.html?highlightDoc=${encodeURIComponent(String(id))}`;
      let qrDataUrl = '';
      if (QRCode) {
        try {
          qrDataUrl = await QRCode.toDataURL(listUrl, { width: 160, margin: 1, errorCorrectionLevel: 'M' });
        } catch (err) {
          console.error('[dms label qr]', err);
        }
      }
      const esc = (s) =>
        String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/"/g, '&quot;');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><title>Nhãn DMS #${id}</title>
<style>
body{font-family:system-ui,sans-serif;padding:16px;max-width:420px;}
.box{border:2px solid #333;padding:12px;display:inline-block;}
h1{font-size:15px;margin:0 0 8px;font-weight:600;}
.mono{font-family:ui-monospace,monospace;font-size:12px;line-height:1.4;}
</style></head><body>
<p><button type="button" onclick="window.print()">In nhãn</button></p>
<div class="box">
  ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR" width="160" height="160"><br>` : '<p class="mono">(Cài qrcode trên máy chủ để có QR)</p>'}
  <h1>${esc(row.title || 'Tài liệu')}</h1>
  <div class="mono">ID hệ thống: ${id}</div>
  ${row.ref_number ? `<div class="mono">Số hiệu: ${esc(row.ref_number)}</div>` : ''}
  ${row.physical_location ? `<div class="mono">Vị trí kho: ${esc(row.physical_location)}</div>` : ''}
  ${row.physical_copy_type ? `<div class="mono">Bản giấy: ${esc(row.physical_copy_type)}</div>` : ''}
</div>
<p class="mono" style="font-size:10px;word-break:break-all;margin-top:10px;">${esc(listUrl)}</p>
</body></html>`);
    } catch (e) {
      console.error('[dms label]', e);
      res.status(500).send(e.message || 'Lỗi');
    }
  });

  router.get('/documents/:id/physical-bundle', needView, (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const loans = db
        .prepare(`SELECT * FROM dms_document_loans WHERE document_id = ? ORDER BY id DESC`)
        .all(id);
      const handovers = db
        .prepare(
          `SELECT h.*, u.fullname AS creator_name FROM dms_document_handovers h
           LEFT JOIN users u ON u.id = h.created_by_id
           WHERE h.document_id = ? ORDER BY h.id DESC`
        )
        .all(id);
      const activeLoan = loans.find((l) => !l.returned_at) || null;
      res.json({ ok: true, document: doc, loans, handovers, activeLoan });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/documents/:id/loans', needUpload, express.json(), (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = db.prepare('SELECT id FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const borrower = String(req.body.borrower_name || '').trim();
      if (!borrower) return res.status(400).json({ ok: false, message: 'Thiếu tên người mượn' });
      const reason = String(req.body.reason || '').trim() || null;
      const dueAt = String(req.body.due_at || '').trim() || null;
      const notes = String(req.body.notes || '').trim() || null;
      const open = db
        .prepare('SELECT id FROM dms_document_loans WHERE document_id = ? AND returned_at IS NULL')
        .get(id);
      if (open) {
        return res.status(400).json({
          ok: false,
          message: 'Hồ sơ đang có phiếu mượn chưa trả. Ghi nhận trả trước khi mượn tiếp.',
        });
      }
      const r = db
        .prepare(
          `INSERT INTO dms_document_loans (document_id, borrower_name, reason, due_at, created_by_id, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, borrower, reason, dueAt, req.user.id, notes);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/documents/:id/loans/:loanId/return', needUpload, express.json(), (req, res) => {
    try {
      const id = Number(req.params.id);
      const loanId = Number(req.params.loanId);
      const row = db.prepare('SELECT * FROM dms_document_loans WHERE id = ? AND document_id = ?').get(loanId, id);
      if (!row) return res.status(404).json({ ok: false, message: 'Không tìm thấy phiếu' });
      if (row.returned_at) return res.json({ ok: true, already: true });
      const returnedAt = String(req.body.returned_at || '').trim() || null;
      db.prepare(
        `UPDATE dms_document_loans SET returned_at = COALESCE(?, datetime('now','localtime')) WHERE id = ?`
      ).run(returnedAt || null, loanId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/documents/:id/handovers', needUpload, express.json(), (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = db.prepare('SELECT id FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const fromP = String(req.body.from_party || '').trim();
      const toP = String(req.body.to_party || '').trim();
      if (!fromP || !toP) return res.status(400).json({ ok: false, message: 'Cần bên giao và bên nhận' });
      const notes = String(req.body.notes || '').trim() || null;
      const r = db
        .prepare(
          `INSERT INTO dms_document_handovers (document_id, from_party, to_party, notes, created_by_id)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(id, fromP, toP, notes, req.user.id);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/inventory/sessions', needManageDocs, express.json(), (req, res) => {
    try {
      const name =
        String(req.body.name || '').trim() ||
        `Kiểm kê ${new Date().toISOString().slice(0, 10)}`;
      const notes = String(req.body.notes || '').trim() || null;
      const r = db
        .prepare(`INSERT INTO dms_inventory_sessions (name, notes, started_by_id) VALUES (?, ?, ?)`)
        .run(name, notes, req.user.id);
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/inventory/sessions', needView, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT s.*, u.fullname AS starter_name,
            (SELECT COUNT(*) FROM dms_inventory_items i WHERE i.session_id = s.id) AS item_count
           FROM dms_inventory_sessions s
           LEFT JOIN users u ON u.id = s.started_by_id
           ORDER BY s.id DESC LIMIT 80`
        )
        .all();
      res.json({ ok: true, sessions: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/inventory/sessions/:sid', needView, (req, res) => {
    try {
      const sid = Number(req.params.sid);
      const s = db.prepare('SELECT * FROM dms_inventory_sessions WHERE id = ?').get(sid);
      if (!s) return res.status(404).json({ ok: false, message: 'Không tìm thấy phiên' });
      const items = db
        .prepare(
          `SELECT i.*, d.title, d.ref_number, d.physical_location AS doc_location
           FROM dms_inventory_items i
           JOIN dms_documents d ON d.id = i.document_id
           WHERE i.session_id = ?
           ORDER BY i.id DESC`
        )
        .all(sid);
      res.json({ ok: true, session: s, items });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/inventory/sessions/:sid/items', needManageDocs, express.json(), (req, res) => {
    try {
      const sid = Number(req.params.sid);
      const sess = db.prepare('SELECT * FROM dms_inventory_sessions WHERE id = ?').get(sid);
      if (!sess) return res.status(404).json({ ok: false, message: 'Không tìm thấy phiên' });
      if (sess.closed_at) return res.status(400).json({ ok: false, message: 'Phiên đã đóng' });
      const documentId = Number(req.body.document_id);
      const status = String(req.body.status || 'ok').toLowerCase();
      const allowed = ['ok', 'missing', 'wrong_location'];
      const st = allowed.includes(status) ? status : 'ok';
      const locFound = String(req.body.physical_location_found || '').trim() || null;
      const notes = String(req.body.notes || '').trim() || null;
      if (!Number.isFinite(documentId) || documentId <= 0) {
        return res.status(400).json({ ok: false, message: 'document_id không hợp lệ' });
      }
      const doc = db.prepare('SELECT id FROM dms_documents WHERE id = ?').get(documentId);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy tài liệu' });
      db.prepare(
        `INSERT INTO dms_inventory_items (session_id, document_id, status, physical_location_found, notes, checked_by_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, document_id) DO UPDATE SET
           status = excluded.status,
           physical_location_found = excluded.physical_location_found,
           notes = excluded.notes,
           checked_at = datetime('now','localtime'),
           checked_by_id = excluded.checked_by_id`
      ).run(sid, documentId, st, locFound, notes, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.patch('/inventory/sessions/:sid/close', needManageDocs, (req, res) => {
    try {
      const sid = Number(req.params.sid);
      const sess = db.prepare('SELECT * FROM dms_inventory_sessions WHERE id = ?').get(sid);
      if (!sess) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      db.prepare(`UPDATE dms_inventory_sessions SET closed_at = datetime('now','localtime') WHERE id = ?`).run(sid);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/documents', needView, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 30));
      const offset = (page - 1) * limit;
      const tagIds = String(req.query.tag_ids || '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);

      const docFrom = dmsDocListFromClause();
      const { where, params, orderBy } = buildDocumentListQuery({
        q: req.query.q,
        categoryId: req.query.category_id,
        status: req.query.status,
        year: req.query.year,
        docTypeId: req.query.document_type_id,
        templateId: req.query.template_id,
        hasTemplate: req.query.has_template,
        tagIds,
        quick: req.query.quick,
        sort: req.query.sort,
        duplicatesOnly: String(req.query.duplicates_only || '') === '1' || String(req.query.duplicates_only || '').toLowerCase() === 'true',
        fileMode: req.query.file_mode,
        retentionAlert: String(req.query.retention_alert || '') === '1',
        outOnLoan: String(req.query.out_on_loan || '') === '1',
        documentId: req.query.document_id,
      });

      const countRow = db.prepare(`SELECT COUNT(*) AS c ${docFrom} WHERE ${where}`).get(...params);
      const total = countRow.c;
      const rows = db
        .prepare(
          `SELECT d.*, u.fullname AS uploader_name, u.email AS uploader_email,
            dt.name AS document_type_name,
            c.name AS category_name,
            tpl.code AS template_code,
            tpl.name AS template_name,
            tpl.version AS template_version,
            tpl.status AS template_status,
            tpl.record_kind AS template_record_kind,
            (SELECT COUNT(*) FROM dms_document_loans L WHERE L.document_id = d.id AND L.returned_at IS NULL) AS open_loan_count
           ${docFrom}
           LEFT JOIN users u ON u.id = d.uploaded_by_id
           LEFT JOIN dms_document_types dt ON dt.id = d.document_type_id
           LEFT JOIN dms_categories c ON c.id = d.category_id
           WHERE ${where}
           ORDER BY ${orderBy}
           LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset);

      const ids = rows.map((r) => r.id);
      const tagMap = {};
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const trows = db
          .prepare(
            `SELECT dt.document_id, t.id, t.name, t.color
             FROM dms_document_tags dt
             JOIN dms_tags t ON t.id = dt.tag_id
             WHERE dt.document_id IN (${ph})`
          )
          .all(...ids);
        for (const tr of trows) {
          if (!tagMap[tr.document_id]) tagMap[tr.document_id] = [];
          tagMap[tr.document_id].push({ id: tr.id, name: tr.name, color: tr.color });
        }
      }

      const list = rows.map((r) => ({
        ...r,
        tags: tagMap[r.id] || [],
      }));

      res.json({ ok: true, documents: list, total, page, limit });
    } catch (e) {
      console.error('[dms/documents]', e);
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.patch('/documents/:id/public', needManageDocs, express.json(), (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ ok: false, message: 'ID tài liệu không hợp lệ' });
      }
      const doc = db.prepare('SELECT id FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const raw = req.body && req.body.is_public;
      const isPublic =
        raw === true ||
        raw === 1 ||
        String(raw).toLowerCase() === 'true' ||
        String(raw) === '1'
          ? 1
          : 0;
      db.prepare(
        `UPDATE dms_documents SET is_public = ?, updated_at = datetime('now','localtime') WHERE id = ?`
      ).run(isPublic, id);
      res.json({ ok: true, id, is_public: isPublic });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/documents/:id', needView, (req, res) => {
    try {
      const id = Number(req.params.id);
      const row = db
        .prepare(
          `SELECT d.*, u.fullname AS uploader_name,
            tpl.code AS template_code,
            tpl.name AS template_name,
            tpl.version AS template_version,
            tpl.status AS template_status,
            tpl.record_kind AS template_record_kind,
            tpl.description AS template_description,
            tpl.retention_policy AS template_retention_policy,
            tpl.medium_notes AS template_medium_notes,
            tpl.owning_unit AS template_owning_unit,
            tpl.effective_from AS template_effective_from,
            tpl.effective_until AS template_effective_until,
            tpl.blank_form_url AS template_blank_form_url
           FROM dms_documents d
           LEFT JOIN users u ON u.id = d.uploaded_by_id
           LEFT JOIN dms_templates tpl ON tpl.id = d.template_id
           WHERE d.id = ?`
        )
        .get(id);
      if (!row) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const tags = db
        .prepare(
          `SELECT t.id, t.name, t.color FROM dms_document_tags dt
           JOIN dms_tags t ON t.id = dt.tag_id WHERE dt.document_id = ?`
        )
        .all(id);
      const attachments = db
        .prepare(
          `SELECT id, document_id, original_name, file_size, mime_type, created_at
           FROM dms_document_attachments
           WHERE document_id = ?
           ORDER BY id DESC`
        )
        .all(id);
      res.json({ ok: true, document: { ...row, tags, attachments } });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/documents/:id/attachments', needUpload, upload.array('files', 20), (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const role = getDmsModuleRole(db, req.user);
      if (!canEditDocument(role, doc, req.user.id)) {
        return res.status(403).json({ ok: false, message: 'Không có quyền thêm file cho tài liệu này' });
      }
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) return res.status(400).json({ ok: false, message: 'Chưa chọn file để tải lên' });
      const ins = db.prepare(
        `INSERT INTO dms_document_attachments
          (document_id, file_path, original_name, file_size, mime_type, uploaded_by_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const ids = [];
      for (const f of files) {
        const r = ins.run(id, f.filename, f.originalname || null, f.size || null, f.mimetype || null, req.user.id);
        ids.push(Number(r.lastInsertRowid));
      }
      res.json({ ok: true, uploaded: ids.length, ids });
    } catch (e) {
      const files = Array.isArray(req.files) ? req.files : [];
      for (const f of files) {
        try {
          if (f && f.path) fs.unlinkSync(f.path);
        } catch (_) {}
      }
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/documents/:id/attachments/:attachmentId/file', needView, (req, res) => {
    try {
      const id = Number(req.params.id);
      const attachmentId = Number(req.params.attachmentId);
      const row = db
        .prepare(
          `SELECT id, document_id, file_path, original_name, mime_type
           FROM dms_document_attachments
           WHERE id = ? AND document_id = ?`
        )
        .get(attachmentId, id);
      if (!row) return res.status(404).send('Not found');
      const abs = path.isAbsolute(row.file_path) ? row.file_path : path.join(dmsDir, path.basename(row.file_path));
      if (!fs.existsSync(abs)) return res.status(404).send('File missing');
      if (row.mime_type) res.setHeader('Content-Type', row.mime_type);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(row.original_name || 'attachment')}"`
      );
      return res.sendFile(abs);
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  router.delete('/documents/:id/attachments/:attachmentId', needUpload, (req, res) => {
    try {
      const id = Number(req.params.id);
      const attachmentId = Number(req.params.attachmentId);
      const doc = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy tài liệu' });
      const role = getDmsModuleRole(db, req.user);
      if (!canEditDocument(role, doc, req.user.id)) {
        return res.status(403).json({ ok: false, message: 'Không có quyền xóa file đính kèm' });
      }
      const row = db
        .prepare(
          `SELECT id, document_id, file_path
           FROM dms_document_attachments
           WHERE id = ? AND document_id = ?`
        )
        .get(attachmentId, id);
      if (!row) return res.status(404).json({ ok: false, message: 'Không tìm thấy file đính kèm' });
      const abs = resolveDmsStoredFileForUnlink(row.file_path);
      db.prepare('DELETE FROM dms_document_attachments WHERE id = ? AND document_id = ?').run(attachmentId, id);
      try {
        if (abs) fs.unlinkSync(abs);
      } catch (_) {}
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/documents/:id/file', needView, (req, res) => {
    try {
      const id = Number(req.params.id);
      const row = db.prepare('SELECT file_path, original_name, mime_type FROM dms_documents WHERE id = ?').get(id);
      if (!row) return res.status(404).send('Not found');
      if (!row.file_path || row.file_path === DMS_NO_FILE) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res
          .status(404)
          .send(
            'Tài liệu chưa có file PDF đính kèm trên hệ thống. Kiểm tra cột Link scan trong Excel hoặc tải file lên khi sửa hồ sơ.'
          );
      }
      const abs = path.isAbsolute(row.file_path) ? row.file_path : path.join(dmsDir, path.basename(row.file_path));
      if (!fs.existsSync(abs)) return res.status(404).send('File missing');
      if (row.mime_type) res.setHeader('Content-Type', row.mime_type);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(row.original_name || 'file')}"`
      );
      return res.sendFile(abs);
    } catch (e) {
      res.status(500).send(e.message);
    }
  });

  function syncDocumentTags(documentId, tagIds) {
    db.prepare('DELETE FROM dms_document_tags WHERE document_id = ?').run(documentId);
    const ins = db.prepare('INSERT INTO dms_document_tags (document_id, tag_id) VALUES (?, ?)');
    for (const tid of tagIds) {
      if (Number.isFinite(tid) && tid > 0) ins.run(documentId, tid);
    }
  }

  router.post('/documents', needUpload, upload.single('file'), (req, res) => {
    try {
      const refNumber = String(req.body.ref_number || '').trim() || null;
      const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
      const documentTypeId = req.body.document_type_id ? Number(req.body.document_type_id) : null;
      const status = String(req.body.status || 'draft').toLowerCase();
      const allowed = ['active', 'draft', 'expired', 'revoked'];
      const st = allowed.includes(status) ? status : 'draft';
      const issueDate = String(req.body.issue_date || '').trim() || null;
      const validUntil = String(req.body.valid_until || '').trim() || null;
      const notes = String(req.body.notes || '').trim() || null;
      const issuingUnit = String(req.body.issuing_unit || '').trim() || null;
      const externalScanLink = String(req.body.external_scan_link || '').trim() || null;
      const externalWordLink = String(req.body.external_word_link || '').trim() || null;
      let tagIds = [];
      try {
        const raw = req.body.tag_ids;
        if (raw) tagIds = JSON.parse(raw);
      } catch (_) {}
      if (!Array.isArray(tagIds)) tagIds = [];

      const physicalLocation = String(req.body.physical_location || '').trim() || null;
      const physicalCopyType = String(req.body.physical_copy_type || '').trim() || null;
      const physicalSheetCount = parseBodyInt(req.body.physical_sheet_count);
      const physicalPageCount = parseBodyInt(req.body.physical_page_count);
      const retentionUntil = String(req.body.retention_until || '').trim() || null;
      const destructionEligibleDate = String(req.body.destruction_eligible_date || '').trim() || null;
      const parentCaseRef = String(req.body.parent_case_ref || '').trim() || null;

      const tplCheck = validateDmsTemplateId(req.body.template_id);
      if (!tplCheck.ok) return res.status(400).json({ ok: false, message: tplCheck.message });
      const templateId = tplCheck.id;

      let title = String(req.body.title || '').trim();
      if (req.file) {
        title = title || req.file.originalname;
        const relPath = req.file.filename;
        const r = db
          .prepare(
            `INSERT INTO dms_documents (
            title, ref_number, category_id, document_type_id, status,
            issue_date, valid_until, file_path, original_name, file_size, mime_type, notes,
            issuing_unit, external_scan_link, external_word_link,
            physical_location, physical_copy_type, physical_sheet_count, physical_page_count,
            retention_until, destruction_eligible_date, parent_case_ref,
            import_sheet, template_id, uploaded_by_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
          )
          .run(
            title,
            refNumber,
            Number.isFinite(categoryId) ? categoryId : null,
            Number.isFinite(documentTypeId) ? documentTypeId : null,
            st,
            issueDate,
            validUntil,
            relPath,
            req.file.originalname,
            req.file.size,
            req.file.mimetype || null,
            notes,
            issuingUnit,
            externalScanLink,
            externalWordLink,
            physicalLocation,
            physicalCopyType,
            physicalSheetCount,
            physicalPageCount,
            retentionUntil,
            destructionEligibleDate,
            parentCaseRef,
            templateId,
            req.user.id
          );
        const newId = r.lastInsertRowid;
        syncDocumentTags(
          newId,
          tagIds.map((x) => Number(x)).filter((n) => Number.isFinite(n))
        );
        return res.json({ ok: true, id: newId });
      }

      if (!title) {
        return res.status(400).json({ ok: false, message: 'Cần tiêu đề hoặc file đính kèm' });
      }
      const origHint =
        String(req.body.original_name_hint || '').trim() ||
        externalScanLink ||
        '(Chưa có file đính kèm)';
      const r = db
        .prepare(
          `INSERT INTO dms_documents (
            title, ref_number, category_id, document_type_id, status,
            issue_date, valid_until, file_path, original_name, file_size, mime_type, notes,
            issuing_unit, external_scan_link, external_word_link,
            physical_location, physical_copy_type, physical_sheet_count, physical_page_count,
            retention_until, destruction_eligible_date, parent_case_ref,
            import_sheet, template_id, uploaded_by_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          title,
          refNumber,
          Number.isFinite(categoryId) ? categoryId : null,
          Number.isFinite(documentTypeId) ? documentTypeId : null,
          st,
          issueDate,
          validUntil,
          DMS_NO_FILE,
          origHint,
          notes,
          issuingUnit,
          externalScanLink,
          externalWordLink,
          physicalLocation,
          physicalCopyType,
          physicalSheetCount,
          physicalPageCount,
          retentionUntil,
          destructionEligibleDate,
          parentCaseRef,
          templateId,
          req.user.id
        );
      const newId = r.lastInsertRowid;
      syncDocumentTags(
        newId,
        tagIds.map((x) => Number(x)).filter((n) => Number.isFinite(n))
      );
      res.json({ ok: true, id: newId });
    } catch (e) {
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (_) {}
      }
      console.error('[dms/documents POST]', e);
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.patch('/documents/:id', needUpload, (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const role = getDmsModuleRole(db, req.user);
      if (!canEditDocument(role, doc, req.user.id)) {
        return res.status(403).json({ ok: false, message: 'Không có quyền sửa tài liệu này' });
      }

      const title = req.body.title != null ? String(req.body.title).trim() : null;
      const refNumber = req.body.ref_number !== undefined ? String(req.body.ref_number || '').trim() : undefined;
      const categoryId = req.body.category_id !== undefined ? Number(req.body.category_id) : undefined;
      const documentTypeId =
        req.body.document_type_id !== undefined ? Number(req.body.document_type_id) : undefined;
      const status = req.body.status != null ? String(req.body.status).toLowerCase() : null;
      const issueDate = req.body.issue_date !== undefined ? String(req.body.issue_date || '').trim() : undefined;
      const validUntil = req.body.valid_until !== undefined ? String(req.body.valid_until || '').trim() : undefined;
      const notes = req.body.notes !== undefined ? String(req.body.notes || '').trim() : undefined;

      let tagIds;
      if (req.body.tag_ids !== undefined) {
        try {
          tagIds = JSON.parse(req.body.tag_ids);
        } catch (_) {
          tagIds = [];
        }
      }

      const allowed = ['active', 'draft', 'expired', 'revoked'];
      const st = status && allowed.includes(status) ? status : null;

      db.prepare(
        `UPDATE dms_documents SET
           title = COALESCE(?, title),
           ref_number = CASE WHEN ? THEN ? ELSE ref_number END,
           category_id = CASE WHEN ? THEN ? ELSE category_id END,
           document_type_id = CASE WHEN ? THEN ? ELSE document_type_id END,
           status = COALESCE(?, status),
           issue_date = CASE WHEN ? THEN ? ELSE issue_date END,
           valid_until = CASE WHEN ? THEN ? ELSE valid_until END,
           notes = CASE WHEN ? THEN ? ELSE notes END,
           updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(
        title,
        refNumber !== undefined ? 1 : 0,
        refNumber !== undefined ? refNumber || null : null,
        categoryId !== undefined ? 1 : 0,
        categoryId !== undefined && Number.isFinite(categoryId) ? categoryId : null,
        documentTypeId !== undefined ? 1 : 0,
        documentTypeId !== undefined && Number.isFinite(documentTypeId) ? documentTypeId : null,
        st,
        issueDate !== undefined ? 1 : 0,
        issueDate !== undefined ? issueDate || null : null,
        validUntil !== undefined ? 1 : 0,
        validUntil !== undefined ? validUntil || null : null,
        notes !== undefined ? 1 : 0,
        notes !== undefined ? notes || null : null,
        id
      );

      if (req.body.issuing_unit !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET issuing_unit = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.issuing_unit || '').trim() || null, id);
      }
      if (req.body.external_scan_link !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET external_scan_link = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.external_scan_link || '').trim() || null, id);
      }
      if (req.body.external_word_link !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET external_word_link = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.external_word_link || '').trim() || null, id);
      }
      if (req.body.physical_location !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET physical_location = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.physical_location || '').trim() || null, id);
      }
      if (req.body.physical_copy_type !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET physical_copy_type = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.physical_copy_type || '').trim() || null, id);
      }
      if (req.body.physical_sheet_count !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET physical_sheet_count = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(parseBodyInt(req.body.physical_sheet_count), id);
      }
      if (req.body.physical_page_count !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET physical_page_count = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(parseBodyInt(req.body.physical_page_count), id);
      }
      if (req.body.retention_until !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET retention_until = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.retention_until || '').trim() || null, id);
      }
      if (req.body.destruction_eligible_date !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET destruction_eligible_date = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.destruction_eligible_date || '').trim() || null, id);
      }
      if (req.body.parent_case_ref !== undefined) {
        db.prepare(
          `UPDATE dms_documents SET parent_case_ref = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(String(req.body.parent_case_ref || '').trim() || null, id);
      }
      if (req.body.template_id !== undefined) {
        const tplCheck = validateDmsTemplateId(
          req.body.template_id === '' || req.body.template_id === null ? null : req.body.template_id
        );
        if (!tplCheck.ok) return res.status(400).json({ ok: false, message: tplCheck.message });
        db.prepare(
          `UPDATE dms_documents SET template_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(tplCheck.id, id);
      }

      if (Array.isArray(tagIds)) {
        syncDocumentTags(
          id,
          tagIds.map((x) => Number(x)).filter((n) => Number.isFinite(n))
        );
      }

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.delete('/documents/:id', needUpload, (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = db.prepare('SELECT * FROM dms_documents WHERE id = ?').get(id);
      if (!doc) return res.status(404).json({ ok: false, message: 'Không tìm thấy' });
      const role = getDmsModuleRole(db, req.user);
      if (!canDeleteDocument(role, doc, req.user.id)) {
        return res.status(403).json({ ok: false, message: 'Không có quyền xóa' });
      }
      const abs = resolveDmsStoredFileForUnlink(doc.file_path);
      db.prepare('DELETE FROM dms_documents WHERE id = ?').run(id);
      try {
        if (abs) fs.unlinkSync(abs);
      } catch (_) {}
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/export.xlsx', needView, (req, res) => {
    try {
      const tagIds = String(req.query.tag_ids || '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      const docFrom = dmsDocListFromClause();
      const { where, params, orderBy } = buildDocumentListQuery({
        q: req.query.q,
        categoryId: req.query.category_id,
        status: req.query.status,
        year: req.query.year,
        docTypeId: req.query.document_type_id,
        templateId: req.query.template_id,
        hasTemplate: req.query.has_template,
        tagIds,
        quick: req.query.quick,
        sort: req.query.sort,
        duplicatesOnly: String(req.query.duplicates_only || '') === '1',
        fileMode: req.query.file_mode,
        retentionAlert: String(req.query.retention_alert || '') === '1',
        outOnLoan: String(req.query.out_on_loan || '') === '1',
        documentId: req.query.document_id,
      });

      const rows = db
        .prepare(
          `SELECT d.title, d.ref_number, d.status, d.issue_date, d.valid_until, d.uploaded_at,
            u.fullname AS uploader, dt.name AS loai, c.name AS danh_muc, d.original_name, d.file_size,
            d.issuing_unit, d.external_scan_link, d.external_word_link, d.import_sheet,
            d.physical_location, d.physical_copy_type, d.physical_sheet_count, d.physical_page_count,
            d.retention_until, d.destruction_eligible_date, d.parent_case_ref, d.file_path,
            tpl.code AS template_code, tpl.name AS template_name, tpl.version AS template_version,
            tpl.record_kind AS template_record_kind
           ${docFrom}
           LEFT JOIN users u ON u.id = d.uploaded_by_id
           LEFT JOIN dms_document_types dt ON dt.id = d.document_type_id
           LEFT JOIN dms_categories c ON c.id = d.category_id
           WHERE ${where}
           ORDER BY ${orderBy}`
        )
        .all(...params);

      const sheet = rows.map((r) => ({
        'Tên tài liệu': r.title,
        'Số hiệu': r.ref_number,
        'Mã mẫu biểu': r.template_code || '',
        'Tên mẫu biểu': r.template_name || '',
        'Phiên bản mẫu': r.template_version || '',
        'Loại ISO (doc/record)': r.template_record_kind || '',
        'Loại': r.loai,
        'Danh mục': r.danh_muc,
        'Trạng thái': r.status,
        'Ngày ban hành': r.issue_date,
        'Hiệu lực đến': r.valid_until,
        'ĐV ban hành': r.issuing_unit,
        'Link scan': r.external_scan_link,
        'Link Word': r.external_word_link,
        'Vị trí kho (giấy)': r.physical_location,
        'Bản gốc/sao': r.physical_copy_type,
        'Số tờ': r.physical_sheet_count,
        'Số trang': r.physical_page_count,
        'Bảo quản đến': r.retention_until,
        'Đủ ĐK tiêu hủy': r.destruction_eligible_date,
        'Liên kết hồ sơ gốc': r.parent_case_ref,
        'Có PDF server': r.file_path && r.file_path !== DMS_NO_FILE ? 'Có' : 'Không',
        'Sheet import': r.import_sheet,
        'Ngày tải lên': r.uploaded_at,
        'Người tải': r.uploader,
        'Tên file': r.original_name,
        'Dung lượng': r.file_size,
      }));

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(sheet);
      XLSX.utils.book_append_sheet(wb, ws, 'Tai lieu');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="tai-lieu-hanh-chinh.xlsx"');
      res.send(Buffer.from(buf));
    } catch (e) {
      console.error('[dms export]', e);
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.get('/reports/summary.xlsx', needView, (req, res) => {
    try {
      const byUnit = db
        .prepare(
          `SELECT COALESCE(NULLIF(TRIM(issuing_unit), ''), '(Chưa ghi đơn vị)') AS don_vi, COUNT(*) AS so_luong
           FROM dms_documents GROUP BY don_vi ORDER BY so_luong DESC`
        )
        .all();
      const byYear = db
        .prepare(
          `SELECT COALESCE(strftime('%Y', COALESCE(issue_date, uploaded_at)), '(Không rõ)') AS nam,
            COUNT(*) AS so_luong
           FROM dms_documents GROUP BY nam ORDER BY nam DESC`
        )
        .all();
      const byType = db
        .prepare(
          `SELECT COALESCE(dt.name, '(Chưa gán loại)') AS loai, COUNT(*) AS so_luong
           FROM dms_documents d
           LEFT JOIN dms_document_types dt ON dt.id = d.document_type_id
           GROUP BY loai ORDER BY so_luong DESC`
        )
        .all();
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byUnit), 'Theo don vi');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byYear), 'Theo nam');
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byType), 'Theo loai');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="dms-bao-cao-tong-hop.xlsx"');
      res.send(Buffer.from(buf));
    } catch (e) {
      console.error('[dms summary]', e);
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  /** Chỉ Master Admin phân quyền module (trùng ADMIN_EMAIL). */
  router.get('/admin/module-users', masterAdminOnly, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT r.user_id, r.role, r.granted_at, r.granted_by, u.fullname, u.email, u.role AS system_role
           FROM dms_user_roles r
           JOIN users u ON u.id = r.user_id
           ORDER BY u.fullname COLLATE NOCASE`
        )
        .all();
      res.json({ ok: true, users: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/admin/module-users', masterAdminOnly, express.json(), (req, res) => {
    try {
      const userId = Number(req.body.user_id);
      const role = String(req.body.role || '').toLowerCase();
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ ok: false, message: 'user_id không hợp lệ' });
      }
      if (!DMS_ROLES.includes(role)) {
        return res.status(400).json({ ok: false, message: 'role phải là manager | uploader | viewer' });
      }
      const u = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy user' });
      const acc = db.prepare('SELECT 1 AS x FROM dms_module_access WHERE user_id = ?').get(userId);
      if (!acc) {
        return res.status(400).json({
          ok: false,
          message:
            'Chỉ gán vai trò cho tài khoản đã có trong «Danh sách được mở truy cập module». Thêm người dùng vào danh sách đó trước.',
        });
      }
      db.prepare(
        `INSERT INTO dms_user_roles (user_id, role, granted_by, granted_at)
         VALUES (?, ?, ?, datetime('now','localtime'))
         ON CONFLICT(user_id) DO UPDATE SET
           role = excluded.role,
           granted_by = excluded.granted_by,
           granted_at = excluded.granted_at`
      ).run(userId, role, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.delete('/admin/module-users/:userId', masterAdminOnly, (req, res) => {
    try {
      const userId = Number(req.params.userId);
      db.prepare('DELETE FROM dms_user_roles WHERE user_id = ?').run(userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  /** Danh sách được mở truy cập nội dung module (trước khi gán vai trò). */
  router.get('/admin/module-access', masterAdminOnly, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT a.user_id, a.granted_at, a.granted_by, u.fullname, u.email, u.role AS system_role,
                  r.role AS module_role
           FROM dms_module_access a
           JOIN users u ON u.id = a.user_id
           LEFT JOIN dms_user_roles r ON r.user_id = a.user_id
           ORDER BY u.fullname COLLATE NOCASE`
        )
        .all();
      res.json({ ok: true, users: rows });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.post('/admin/module-access', masterAdminOnly, express.json(), (req, res) => {
    try {
      if (req.body && req.body.disable_all_institute === true) {
        const suffix = String((req.body && req.body.email_suffix) || '@sci.edu.vn')
          .trim()
          .toLowerCase();
        const likePattern = '%' + (suffix.startsWith('@') ? suffix : '@' + suffix);
        const ids = db
          .prepare(
            `SELECT id FROM users
             WHERE lower(trim(COALESCE(email,''))) LIKE ?`
          )
          .all(likePattern)
          .map((x) => Number(x.id))
          .filter((x) => Number.isFinite(x) && x > 0);
        if (!ids.length) {
          return res.json({ ok: true, removed: 0, message: 'Không có tài khoản nội viện để gỡ.' });
        }
        const marks = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM dms_user_roles WHERE user_id IN (${marks})`).run(...ids);
        const info = db.prepare(`DELETE FROM dms_module_access WHERE user_id IN (${marks})`).run(...ids);
        const removed = Number(info.changes) || 0;
        return res.json({
          ok: true,
          removed,
          message: removed
            ? `Đã tắt thêm toàn viện và gỡ ${removed} tài khoản nội viện khỏi danh sách truy cập module.`
            : 'Không có tài khoản nội viện nào trong danh sách truy cập để gỡ.',
        });
      }
      if (req.body && req.body.all_institute === true) {
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO dms_module_access (user_id, granted_by, granted_at)
             SELECT id, ?, datetime('now','localtime') FROM users
             WHERE COALESCE(is_banned, 0) = 0`
          )
          .run(req.user.id);
        const added = Number(info.changes) || 0;
        db.prepare(
          `INSERT OR IGNORE INTO dms_user_roles (user_id, role, granted_by, granted_at)
           SELECT a.user_id, 'viewer', ?, datetime('now','localtime')
           FROM dms_module_access a
           LEFT JOIN dms_user_roles r ON r.user_id = a.user_id
           WHERE r.user_id IS NULL`
        ).run(req.user.id);
        return res.json({
          ok: true,
          added,
          message: added
            ? `Đã thêm ${added} tài khoản (mặc định vai trò module: chỉ xem).`
            : 'Không có tài khoản mới (đã có trong danh sách hoặc không hợp lệ). Người chưa có vai trò đã được gán «chỉ xem» nếu cần.',
        });
      }
      const userId = Number(req.body.user_id);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ ok: false, message: 'user_id không hợp lệ' });
      }
      const u = db.prepare('SELECT id FROM users WHERE id = ? AND COALESCE(is_banned,0)=0').get(userId);
      if (!u) return res.status(404).json({ ok: false, message: 'Không tìm thấy user hoặc tài khoản đang bị khóa' });
      db.prepare(
        `INSERT OR IGNORE INTO dms_module_access (user_id, granted_by, granted_at)
         VALUES (?, ?, datetime('now','localtime'))`
      ).run(userId, req.user.id);
      const row = db.prepare('SELECT 1 AS x FROM dms_module_access WHERE user_id = ?').get(userId);
      if (!row) {
        return res.status(500).json({ ok: false, message: 'Không thể thêm vào danh sách' });
      }
      db.prepare(
        `INSERT OR IGNORE INTO dms_user_roles (user_id, role, granted_by, granted_at)
         VALUES (?, 'viewer', ?, datetime('now','localtime'))`
      ).run(userId, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  router.delete('/admin/module-access/:userId', masterAdminOnly, (req, res) => {
    try {
      const userId = Number(req.params.userId);
      db.prepare('DELETE FROM dms_user_roles WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM dms_module_access WHERE user_id = ?').run(userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

  return router;
};
