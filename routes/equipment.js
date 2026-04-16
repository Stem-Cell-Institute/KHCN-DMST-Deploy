/**
 * API Quản trị Thiết bị — mount tại /api/equipment
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const QRCode = require('qrcode');
const { checkEquipmentDocAccess } = require('../middleware/checkEquipmentDocAccess');
const {
  registerEquipmentPart2,
  maintenanceBadgeForRow,
  reviewStatus,
  generateEquipmentCode,
  extractYoutubeId,
  detectPlatformFromUrl,
  notifyEquipmentStakeholders,
} = require('./equipmentPart2');

const PDF_MIME = 'application/pdf';
const UPLOAD_MAX = 20 * 1024 * 1024;

function parseEquipmentId(param) {
  const id = parseInt(param, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function canManageEquipment(req) {
  const r = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  return r === 'admin' || r === 'manager' || r === 'phong_khcn';
}

function isResearcher(req) {
  return String(req.user && req.user.role ? req.user.role : '').toLowerCase() === 'researcher';
}

function requireManage(req, res, next) {
  if (!canManageEquipment(req)) {
    return res.status(403).json({ message: 'Chỉ Admin / Manager / Phòng KHCN mới có quyền thao tác này.' });
  }
  next();
}

function canUploadEquipmentMedia(req, eq) {
  if (!eq) return false;
  if (canManageEquipment(req)) return true;
  if (Number(eq.created_by) !== Number(req.user && req.user.id)) return false;
  return ['draft', 'rejected'].includes(reviewStatus(eq));
}

function validateVideoUrl(url, platform) {
  const u = String(url || '').trim();
  if (!u) return false;
  const low = u.toLowerCase();
  if (platform === 'youtube') {
    return (
      /youtube\.com\/watch\?/i.test(u) ||
      /youtu\.be\//i.test(u) ||
      /youtube\.com\/shorts\//i.test(u)
    );
  }
  if (platform === 'drive') {
    return /drive\.google\.com/i.test(u);
  }
  if (platform === 'internal') {
    return /^https?:\/\//i.test(u) || low.startsWith('/');
  }
  return false;
}

function stripVietnameseForCode(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeEquipmentCodeField(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  const m = raw.match(/^([0-3])(?:\s*[:\-].*)?$/);
  if (m) return m[1];
  const key = stripVietnameseForCode(raw).replace(/[^a-z0-9]+/g, ' ').trim();
  const map = {
    'chua ghi so ke toan': '0',
    'da ghi so ke toan': '1',
    'khong phai ghi so ke toan': '2',
    'khong co nhu cau su dung': '3',
    'con su dung duoc dang su dung dung muc dich': '0',
    'con su dung duoc dang su dung khong dung muc dich': '1',
    'con su dung duoc khong co nhu cau su dung': '2',
    'hong khong su dung duoc': '3',
  };
  if (map[key] != null) return map[key];
  if (key.includes('chua ghi so ke toan')) return '0';
  if (key.includes('da ghi so ke toan')) return '1';
  if (key.includes('khong phai ghi so ke toan')) return '2';
  if (key.includes('khong co nhu cau su dung')) return '3';
  if (key.includes('hong') && key.includes('khong su dung duoc')) return '3';
  if (key.includes('khong dung muc dich')) return '1';
  if (key.includes('dung muc dich')) return '0';
  return null;
}

function publicProfileUrl(req, equipmentId) {
  const envBase = (process.env.BASE_URL || '').replace(/\/$/, '');
  const host = req.get('host');
  const proto = req.protocol || 'http';
  const base = envBase || `${proto}://${host}`;
  return `${base}/public/equipment/public.html?id=${equipmentId}`;
}

function createOptionalAuth(deps) {
  const { db, getTokenFromReq, jwt, JWT_SECRET, userIdIsBanned } = deps;
  return function optionalAuth(req, res, next) {
    const token = getTokenFromReq(req);
    if (!token) {
      req.user = null;
      return next();
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (userIdIsBanned && userIdIsBanned(payload.id)) {
        req.user = null;
        return next();
      }
      let reqUser = payload;
      try {
        const row = db.prepare('SELECT id, email, fullname, role, department_id FROM users WHERE id = ?').get(payload.id);
        if (row) {
          reqUser = {
            id: row.id,
            email: row.email,
            fullname: row.fullname,
            role: row.role,
            department_id: row.department_id,
          };
        }
      } catch (_) {}
      req.user = reqUser;
      next();
    } catch (_) {
      req.user = null;
      next();
    }
  };
}

function canViewEquipmentDetail(req, row, db) {
  if (!row) return { ok: false, status: 404 };
  if (canManageEquipment(req)) return { ok: true };
  const rs = reviewStatus(row);
  if (['draft', 'pending_review'].includes(rs) && Number(row.created_by) !== Number(req.user && req.user.id)) {
    return { ok: false, status: 404 };
  }
  if (row.status === 'retired') return { ok: false, status: 404 };
  if (isResearcher(req)) {
    if (row.profile_visibility !== 'public') return { ok: false, status: 403 };
    return { ok: true };
  }
  const vis = String(row.profile_visibility || 'institute');
  if (vis === 'public' || vis === 'institute') return { ok: true };
  if (vis === 'internal') {
    let userDept = req.user.department_id;
    if (userDept == null) {
      try {
        const u = db.prepare('SELECT department_id FROM users WHERE id = ?').get(req.user.id);
        if (u) userDept = u.department_id;
      } catch (_) {}
    }
    if (userDept != null && row.department_id != null && String(userDept) === String(row.department_id)) {
      return { ok: true };
    }
    return { ok: false, status: 403 };
  }
  return { ok: true };
}

function filterDocumentsForRequest(req, docs, equipmentRow, db) {
  return (docs || []).filter((d) => {
    if (d.is_disabled && !canManageEquipment(req)) return false;
    const cur = d.is_current == null || Number(d.is_current) === 1;
    if (!cur && !canManageEquipment(req)) return false;
    const { ok } = checkEquipmentDocAccess(req, d, equipmentRow, db);
    return ok;
  });
}

function filterVideosForRequest(req, videos, equipmentRow, db) {
  return (videos || []).filter((v) => {
    const { ok } = checkEquipmentDocAccess(req, v, equipmentRow, db);
    return ok;
  });
}

module.exports = function createEquipmentRouter(deps) {
  const {
    db,
    authMiddleware,
    adminOnly,
    isMasterAdmin,
    getTokenFromReq,
    jwt,
    JWT_SECRET,
    userIdIsBanned,
    uploadsEquipmentRoot,
    uploadsRoot,
  } = deps;
  const isMasterAdminReq =
    isMasterAdmin ||
    function (req) {
      return String(req.user && req.user.role ? req.user.role : '').toLowerCase() === 'admin';
    };
  const adminOnlyMw =
    adminOnly ||
    function (req, res, next) {
      if ((req.user && String(req.user.role || '').toLowerCase()) !== 'admin') {
        return res.status(403).json({ message: 'Chỉ Admin' });
      }
      next();
    };
  const uploadsRootResolved = uploadsRoot || path.join(uploadsEquipmentRoot, '..');
  const optionalAuth = createOptionalAuth({ db, getTokenFromReq, jwt, JWT_SECRET, userIdIsBanned });
  const router = express.Router();

  db.exec(`
    CREATE TABLE IF NOT EXISTS equipment_module_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS equipment_module_user_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      module_role TEXT NOT NULL DEFAULT 'viewer' CHECK(module_role IN ('viewer','manager')),
      view_scope TEXT NOT NULL DEFAULT 'institute' CHECK(view_scope IN ('inherit','public','institute','allowlist')),
      can_manage_categories INTEGER NOT NULL DEFAULT 0,
      can_manage_departments INTEGER NOT NULL DEFAULT 0,
      can_manage_public_content INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  function migrateEquipmentModuleUserAccessTable() {
    try {
      const t = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='equipment_module_user_access'`).get();
      if (!t || !t.sql) return;
      const sql = String(t.sql);
      if (sql.includes("'manager'")) return;
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE __eq_access_new (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        module_role TEXT NOT NULL DEFAULT 'viewer' CHECK(module_role IN ('viewer','manager')),
        view_scope TEXT NOT NULL DEFAULT 'institute' CHECK(view_scope IN ('inherit','public','institute','allowlist')),
        can_manage_categories INTEGER NOT NULL DEFAULT 0,
        can_manage_departments INTEGER NOT NULL DEFAULT 0,
        can_manage_public_content INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        updated_by INTEGER REFERENCES users(id),
        updated_at TEXT DEFAULT (datetime('now'))
      );`);
      const rows = db.prepare(`SELECT * FROM equipment_module_user_access`).all();
      const ins = db.prepare(
        `INSERT INTO __eq_access_new (user_id, module_role, view_scope, can_manage_categories, can_manage_departments, can_manage_public_content, note, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`
      );
      for (const r of rows) {
        let mr = String(r.module_role || 'viewer').toLowerCase();
        if (mr === 'editor' || mr === 'admin') mr = 'manager';
        else mr = 'viewer';
        ins.run(
          r.user_id,
          mr,
          r.view_scope,
          r.can_manage_categories,
          r.can_manage_departments,
          r.can_manage_public_content,
          r.note,
          r.updated_by,
          r.updated_at
        );
      }
      db.exec(`DROP TABLE equipment_module_user_access`);
      db.exec(`ALTER TABLE __eq_access_new RENAME TO equipment_module_user_access`);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}
      console.warn('[EQUIP] migrateEquipmentModuleUserAccessTable:', e.message);
    }
  }
  migrateEquipmentModuleUserAccessTable();

  db.prepare(
    `INSERT OR IGNORE INTO equipment_module_settings(setting_key, setting_value) VALUES ('access_mode', 'public')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO equipment_module_settings(setting_key, setting_value)
     VALUES ('public_fields', '["name","model","department_id","location","status","documents","videos"]')`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO equipment_module_settings(setting_key, setting_value)
     VALUES ('viewer_visible_fields', '["equipment_code","name","asset_group","model","serial_number","manufacturer","purchase_year","purchase_value","asset_type_code","year_in_use","unit_name","quantity_book","quantity_actual","quantity_diff","remaining_value","utilization_note","condition_note","disaster_impact_note","construction_asset_note","usage_count_note","land_attached_note","asset_note","department_id","manager_id","location","status","profile_visibility","created_at","updated_at","published_at","last_maintenance_date","next_maintenance_date","calibration_due_date","specs_json"]')`
  ).run();
  db.prepare(`INSERT OR IGNORE INTO equipment_module_settings(setting_key, setting_value) VALUES ('incident_emails_new', '[]')`).run();
  db.prepare(`INSERT OR IGNORE INTO equipment_module_settings(setting_key, setting_value) VALUES ('incident_emails_resolved', '[]')`).run();
  db.prepare(`INSERT OR IGNORE INTO equipment_module_settings(setting_key, setting_value) VALUES ('public_incident_reports', '1')`).run();

  function migrateEquipmentIncidentsForPublicReports() {
    try {
      const cols = db.prepare(`PRAGMA table_info(equipment_incidents)`).all();
      if (!cols || !cols.length) return;
      const names = new Set(cols.map((c) => c.name));
      if (names.has('incident_source')) return;
      const copyCols = [
        'id',
        'equipment_id',
        'reported_by',
        'report_date',
        'description',
        'severity',
        'photo_paths',
        'assigned_to',
        'status',
        'resolution_note',
        'resolved_at',
        'cost',
        'repair_type',
        'created_at',
      ].filter((c) => names.has(c));
      if (!copyCols.length) return;
      const sel = copyCols.join(', ');
      db.exec('BEGIN IMMEDIATE');
      db.exec(`CREATE TABLE __eq_inc_mig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id INTEGER NOT NULL REFERENCES equipments(id) ON DELETE CASCADE,
        reported_by INTEGER REFERENCES users(id),
        report_date TEXT DEFAULT (datetime('now')),
        description TEXT NOT NULL,
        severity TEXT NOT NULL,
        photo_paths TEXT,
        assigned_to INTEGER REFERENCES users(id),
        status TEXT NOT NULL DEFAULT 'reported',
        resolution_note TEXT,
        resolved_at TEXT,
        cost REAL,
        repair_type TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        reporter_display TEXT,
        reporter_email TEXT,
        reporter_phone TEXT,
        reporter_ip TEXT,
        incident_source TEXT DEFAULT 'user',
        vendor_note TEXT,
        invoice_ref TEXT,
        proposal_ref TEXT,
        resolution_attachment_paths TEXT
      )`);
      db.exec(`INSERT INTO __eq_inc_mig (${sel}) SELECT ${sel} FROM equipment_incidents`);
      db.exec(`DROP TABLE equipment_incidents`);
      db.exec(`ALTER TABLE __eq_inc_mig RENAME TO equipment_incidents`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_eq_inc_eq ON equipment_incidents(equipment_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_eq_inc_status ON equipment_incidents(status)`);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}
      console.warn('[EQUIP] migrate equipment_incidents:', e.message);
    }
  }
  migrateEquipmentIncidentsForPublicReports();

  function parseJsonEmailList(settingKey) {
    try {
      const row = db.prepare(`SELECT setting_value FROM equipment_module_settings WHERE setting_key = ?`).get(settingKey);
      const raw = row && row.setting_value != null ? String(row.setting_value) : '[]';
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const out = [];
      const seen = new Set();
      for (const x of arr) {
        const e = String(x || '')
          .trim()
          .toLowerCase();
        if (!emailRe.test(e) || seen.has(e)) continue;
        seen.add(e);
        out.push(e);
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  function publicIncidentReportsEnabled() {
    try {
      const row = db.prepare(`SELECT setting_value FROM equipment_module_settings WHERE setting_key = 'public_incident_reports'`).get();
      if (!row || row.setting_value == null) return true;
      return String(row.setting_value).trim() !== '0';
    } catch (_) {
      return true;
    }
  }

  function computePublicIncidentAllowed(eq, equipmentId) {
    if (!eq || eq.status === 'retired' || !publicIncidentReportsEnabled()) return false;
    const rs = reviewStatus(eq);
    if (rs !== 'approved') return false;
    const docsAll = db
      .prepare(
        `SELECT is_disabled, is_current, access_level FROM equipment_documents WHERE equipment_id = ? ORDER BY created_at DESC`
      )
      .all(equipmentId);
    const hasPublicDoc = (docsAll || []).some((d) => {
      if (d.is_disabled) return false;
      const cur = d.is_current == null || Number(d.is_current) === 1;
      if (!cur) return false;
      return String(d.access_level || '').toLowerCase() === 'public';
    });
    return hasPublicDoc;
  }

  function normalizeAccessMode(mode) {
    const m = String(mode || '').trim().toLowerCase();
    if (m === 'allowlist') return 'allowlist';
    if (m === 'sci_only') return 'sci_only';
    // Legacy value: "institute" (Nội bộ viện) => map to sci_only.
    if (m === 'institute') return 'sci_only';
    return 'public';
  }

  function moduleAccessMode() {
    try {
      const row = db
        .prepare(`SELECT setting_value FROM equipment_module_settings WHERE setting_key = 'access_mode'`)
        .get();
      return normalizeAccessMode(row && row.setting_value ? row.setting_value : 'public');
    } catch (_) {
      return 'public';
    }
  }

  function canAccessModule(req) {
    if (!req || !req.user) return false;
    if (isMasterAdminReq(req)) return true;
    const mode = moduleAccessMode();
    if (mode === 'public') return true;
    if (mode === 'sci_only') {
      const email = String((req.user && req.user.email) || '').trim().toLowerCase();
      return email.endsWith('@sci.edu.vn');
    }
    try {
      const row = db
        .prepare(`SELECT 1 AS ok FROM equipment_module_user_access WHERE user_id = ? LIMIT 1`)
        .get(req.user.id);
      return !!row;
    } catch (_) {
      return false;
    }
  }

  function moduleAdminCaps(req) {
    const out = {
      isMaster: isMasterAdminReq(req),
      canManageDepartments: false,
      canManagePublicContent: false,
      canConfigureViewerFields: false,
    };
    if (out.isMaster) {
      out.canManageDepartments = true;
      out.canManagePublicContent = true;
      out.canConfigureViewerFields = true;
      return out;
    }
    try {
      const row = db
        .prepare(
          `SELECT module_role, can_manage_departments, can_manage_public_content
           FROM equipment_module_user_access WHERE user_id = ?`
        )
        .get(req.user.id);
      if (!row) return out;
      const isManager = String(row.module_role || '') === 'manager';
      out.canManageDepartments = isManager || Number(row.can_manage_departments) === 1;
      out.canManagePublicContent = isManager || Number(row.can_manage_public_content) === 1;
      out.canConfigureViewerFields = isManager;
      return out;
    } catch (_) {
      return out;
    }
  }

  function canModuleManagerOrMaster(req) {
    const caps = moduleAdminCaps(req);
    return !!(caps && (caps.isMaster || caps.canConfigureViewerFields));
  }

  function requireModuleMaster(req, res, next) {
    if (!isMasterAdminReq(req)) {
      return res.status(403).json({ message: 'Chỉ Master Admin mới dùng được công cụ này.' });
    }
    next();
  }

  function requireModuleViewer(req, res, next) {
    if (!canAccessModule(req)) {
      return res.status(403).json({ message: 'Bạn chưa được cấp quyền truy cập module Thiết bị.' });
    }
    next();
  }

  function requireDepartmentManager(req, res, next) {
    const caps = moduleAdminCaps(req);
    if (!caps.canManageDepartments) {
      return res.status(403).json({ message: 'Bạn không có quyền quản lý phòng thí nghiệm trong module.' });
    }
    next();
  }

  function viewerFieldDefs() {
    return [
      { key: 'equipment_code', label: 'Mã thiết bị' },
      { key: 'name', label: 'Tên thiết bị' },
      { key: 'asset_group', label: 'Loại tài sản' },
      { key: 'model', label: 'Model' },
      { key: 'serial_number', label: 'Serial' },
      { key: 'manufacturer', label: 'Nhà sản xuất' },
      { key: 'purchase_year', label: 'Năm mua' },
      { key: 'purchase_value', label: 'Giá trị mua' },
      { key: 'asset_type_code', label: 'Mã loại tài sản' },
      { key: 'year_in_use', label: 'Năm đưa vào sử dụng' },
      { key: 'unit_name', label: 'Đơn vị tính' },
      { key: 'quantity_book', label: 'Theo sổ kế toán' },
      { key: 'quantity_actual', label: 'Theo thực tế kiểm kê' },
      { key: 'quantity_diff', label: 'Chênh lệch' },
      { key: 'remaining_value', label: 'GTCL' },
      { key: 'utilization_note', label: 'Tình hình khai thác' },
      { key: 'condition_note', label: 'Tình trạng tài sản' },
      { key: 'disaster_impact_note', label: 'Ảnh hưởng thiên tai' },
      { key: 'construction_asset_note', label: 'Tài sản công trình' },
      { key: 'usage_count_note', label: 'Số lần (nếu có)' },
      { key: 'land_attached_note', label: 'Tài sản gắn liền với đất' },
      { key: 'asset_note', label: 'Ghi chú tài sản' },
      { key: 'department_id', label: 'Phòng/Lab' },
      { key: 'manager_id', label: 'Cán bộ phụ trách' },
      { key: 'location', label: 'Vị trí' },
      { key: 'status', label: 'Trạng thái' },
      { key: 'profile_visibility', label: 'Hiển thị hồ sơ' },
      { key: 'created_at', label: 'Ngày tạo' },
      { key: 'updated_at', label: 'Ngày cập nhật' },
      { key: 'published_at', label: 'Ngày xuất bản' },
      { key: 'last_maintenance_date', label: 'Lần bảo trì gần nhất' },
      { key: 'next_maintenance_date', label: 'Hạn bảo trì tiếp theo' },
      { key: 'calibration_due_date', label: 'Hạn kiểm định' },
      { key: 'specs_json', label: 'Thông số kỹ thuật' },
    ];
  }

  function parseViewerVisibleFields() {
    const defs = viewerFieldDefs();
    const allowed = new Set(defs.map((d) => d.key));
    try {
      const row = db
        .prepare(`SELECT setting_value FROM equipment_module_settings WHERE setting_key = 'viewer_visible_fields'`)
        .get();
      const raw = row && row.setting_value != null ? String(row.setting_value) : '[]';
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return defs.map((d) => d.key);
      const out = [];
      const seen = new Set();
      for (const x of arr) {
        const k = String(x || '').trim();
        if (!allowed.has(k) || seen.has(k)) continue;
        seen.add(k);
        out.push(k);
      }
      return out.length ? out : defs.map((d) => d.key);
    } catch (_) {
      return defs.map((d) => d.key);
    }
  }

  router.get('/module/me', authMiddleware, (req, res) => {
    try {
      const accessMode = moduleAccessMode();
      const canAccess = canAccessModule(req);
      const caps = moduleAdminCaps(req);
      let assignment = db
        .prepare(
          `SELECT module_role, view_scope, can_manage_categories, can_manage_departments, can_manage_public_content
           FROM equipment_module_user_access WHERE user_id = ?`
        )
        .get(req.user.id);
      if (!assignment && accessMode === 'public') {
        assignment = {
          module_role: 'viewer',
          view_scope: 'inherit',
          can_manage_categories: 0,
          can_manage_departments: 0,
          can_manage_public_content: 0,
        };
      }
      res.json({
        ok: true,
        data: {
          accessMode,
          canAccess,
          isMasterAdmin: isMasterAdminReq(req),
          assignment: assignment || null,
          capabilities: caps,
        },
      });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Không tải được thông tin quyền module.' });
    }
  });

  function requirePermissionsBootstrapAccess(req, res, next) {
    if (!canAccessModule(req)) {
      return res.status(403).json({ message: 'Bạn chưa được cấp quyền truy cập module Thiết bị.' });
    }
    const caps = moduleAdminCaps(req);
    const master = isMasterAdminReq(req);
    if (
      !master &&
      !caps.canManageDepartments &&
      !caps.canManagePublicContent &&
      !caps.canConfigureViewerFields
    ) {
      return res.status(403).json({ message: 'Bạn không có quyền vào trang quản trị module.' });
    }
    next();
  }

  router.get('/module/admin/bootstrap', authMiddleware, requirePermissionsBootstrapAccess, (req, res) => {
    try {
      const master = isMasterAdminReq(req);
      const caps = moduleAdminCaps(req);
      const departments = db
        .prepare(`SELECT id, code, name, sort_order FROM equipment_departments ORDER BY sort_order ASC, name ASC`)
        .all();
      if (!master) {
        const visibleFields = parseViewerVisibleFields();
        return res.json({
          ok: true,
          data: {
            isMasterAdmin: false,
            capabilities: caps,
            policy: null,
            viewerFieldPolicy: {
              defs: viewerFieldDefs(),
              visibleFields,
            },
            users: [],
            assignments: [],
            departments,
          },
        });
      }

      const accessMode = moduleAccessMode();
      const fieldsRow = db
        .prepare(`SELECT setting_value FROM equipment_module_settings WHERE setting_key = 'public_fields'`)
        .get();
      let publicFields = [];
      try {
        publicFields = JSON.parse(String(fieldsRow && fieldsRow.setting_value ? fieldsRow.setting_value : '[]'));
      } catch (_) {
        publicFields = [];
      }
      const incidentEmailsNew = parseJsonEmailList('incident_emails_new');
      const incidentEmailsResolved = parseJsonEmailList('incident_emails_resolved');
      const publicIncidentReports = publicIncidentReportsEnabled();
      const visibleFields = parseViewerVisibleFields();
      const users = db
        .prepare(
          `SELECT id, email, fullname, role, department_id
           FROM users
           WHERE COALESCE(is_banned,0)=0
           ORDER BY fullname COLLATE NOCASE, email COLLATE NOCASE
           LIMIT 1200`
        )
        .all();
      const assignments = db
        .prepare(
          `SELECT a.user_id, a.module_role, a.view_scope, a.can_manage_categories, a.can_manage_departments,
                  a.can_manage_public_content, a.note, a.updated_at, u.email, u.fullname, u.role
           FROM equipment_module_user_access a
           LEFT JOIN users u ON u.id = a.user_id
           ORDER BY a.updated_at DESC, a.user_id DESC`
        )
        .all();
      res.json({
        ok: true,
        data: {
          isMasterAdmin: true,
          capabilities: caps,
          policy: {
            accessMode,
            publicFields,
            incidentEmailsNew,
            incidentEmailsResolved,
            publicIncidentReports,
          },
          viewerFieldPolicy: {
            defs: viewerFieldDefs(),
            visibleFields,
          },
          users,
          assignments,
          departments,
        },
      });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi tải cấu hình module' });
    }
  });

  router.put('/module/admin/policy', authMiddleware, requireModuleMaster, express.json(), (req, res) => {
    try {
      const b = req.body || {};
      const mode = String(b.accessMode || '').trim();
      const modeNorm = normalizeAccessMode(mode);
      const allowModes = ['public', 'sci_only', 'allowlist'];
      if (!allowModes.includes(modeNorm)) {
        return res.status(400).json({ message: 'accessMode không hợp lệ' });
      }
      const allowedFields = [
        'name',
        'model',
        'serial_number',
        'manufacturer',
        'department_id',
        'location',
        'status',
        'documents',
        'videos',
        'maintenance',
      ];
      const pf = Array.isArray(b.publicFields)
        ? b.publicFields
            .map((x) => String(x || '').trim())
            .filter((x) => allowedFields.includes(x))
        : [];
      db.prepare(
        `INSERT INTO equipment_module_settings(setting_key, setting_value, updated_by, updated_at)
         VALUES ('access_mode', ?, ?, datetime('now'))
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value=excluded.setting_value, updated_by=excluded.updated_by, updated_at=datetime('now')`
      ).run(modeNorm, req.user.id);
      db.prepare(
        `INSERT INTO equipment_module_settings(setting_key, setting_value, updated_by, updated_at)
         VALUES ('public_fields', ?, ?, datetime('now'))
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value=excluded.setting_value, updated_by=excluded.updated_by, updated_at=datetime('now')`
      ).run(JSON.stringify(pf), req.user.id);

      function emailsFromBody(val) {
        const raw = val != null ? String(val) : '';
        const parts = raw
          .split(/[\n,;]+/)
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean);
        const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const out = [];
        const seen = new Set();
        for (const e of parts) {
          if (!emailRe.test(e) || seen.has(e)) continue;
          seen.add(e);
          out.push(e);
        }
        return out;
      }
      const uniq = (arr) => {
        const s = new Set();
        const o = [];
        for (const x of arr || []) {
          if (!x || s.has(x)) continue;
          s.add(x);
          o.push(x);
        }
        return o;
      };
      if (b.incidentEmailsNew !== undefined || b.incidentEmailsNewText !== undefined) {
        const newMails = Array.isArray(b.incidentEmailsNew)
          ? b.incidentEmailsNew.map((x) => String(x || '').trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
          : emailsFromBody(b.incidentEmailsNewText != null ? b.incidentEmailsNewText : b.incidentEmailsNew);
        const newList = uniq(newMails);
        db.prepare(
          `INSERT INTO equipment_module_settings(setting_key, setting_value, updated_by, updated_at)
           VALUES ('incident_emails_new', ?, ?, datetime('now'))
           ON CONFLICT(setting_key) DO UPDATE SET
             setting_value=excluded.setting_value, updated_by=excluded.updated_by, updated_at=datetime('now')`
        ).run(JSON.stringify(newList), req.user.id);
      }
      if (b.incidentEmailsResolved !== undefined || b.incidentEmailsResolvedText !== undefined) {
        const resMails = Array.isArray(b.incidentEmailsResolved)
          ? b.incidentEmailsResolved.map((x) => String(x || '').trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
          : emailsFromBody(b.incidentEmailsResolvedText != null ? b.incidentEmailsResolvedText : b.incidentEmailsResolved);
        const resList = uniq(resMails);
        db.prepare(
          `INSERT INTO equipment_module_settings(setting_key, setting_value, updated_by, updated_at)
           VALUES ('incident_emails_resolved', ?, ?, datetime('now'))
           ON CONFLICT(setting_key) DO UPDATE SET
             setting_value=excluded.setting_value, updated_by=excluded.updated_by, updated_at=datetime('now')`
        ).run(JSON.stringify(resList), req.user.id);
      }
      if (b.publicIncidentReports != null) {
        const on = b.publicIncidentReports === true || b.publicIncidentReports === 1 || String(b.publicIncidentReports).toLowerCase() === 'true';
        db.prepare(
          `INSERT INTO equipment_module_settings(setting_key, setting_value, updated_by, updated_at)
           VALUES ('public_incident_reports', ?, ?, datetime('now'))
           ON CONFLICT(setting_key) DO UPDATE SET
             setting_value=excluded.setting_value, updated_by=excluded.updated_by, updated_at=datetime('now')`
        ).run(on ? '1' : '0', req.user.id);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Không lưu được chính sách module' });
    }
  });

  router.put('/module/admin/viewer-fields', authMiddleware, requireModuleViewer, express.json(), (req, res) => {
    try {
      const caps = moduleAdminCaps(req);
      if (!caps.isMaster && !caps.canConfigureViewerFields) {
        return res.status(403).json({ message: 'Chỉ Module Manager trở lên mới chỉnh được quyền xem của Viewer.' });
      }
      const defs = viewerFieldDefs();
      const allowed = new Set(defs.map((d) => d.key));
      const b = req.body || {};
      const incoming = Array.isArray(b.visibleFields) ? b.visibleFields : [];
      const seen = new Set();
      const out = [];
      for (const x of incoming) {
        const k = String(x || '').trim();
        if (!allowed.has(k) || seen.has(k)) continue;
        seen.add(k);
        out.push(k);
      }
      db.prepare(
        `INSERT INTO equipment_module_settings(setting_key, setting_value, updated_by, updated_at)
         VALUES ('viewer_visible_fields', ?, ?, datetime('now'))
         ON CONFLICT(setting_key) DO UPDATE SET
           setting_value=excluded.setting_value, updated_by=excluded.updated_by, updated_at=datetime('now')`
      ).run(JSON.stringify(out), req.user.id);
      return res.json({ ok: true, visibleFields: out });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không lưu được cấu hình trường xem của Viewer.' });
    }
  });

  router.put('/module/admin/user/:userId', authMiddleware, requireModuleMaster, express.json(), (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ message: 'userId không hợp lệ' });
      }
      const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
      if (!user) return res.status(404).json({ message: 'Không tìm thấy user' });
      const b = req.body || {};
      const moduleRole = String(b.moduleRole || 'viewer');
      const viewScope = String(b.viewScope || 'inherit');
      if (!['viewer', 'manager'].includes(moduleRole)) {
        return res.status(400).json({ message: 'moduleRole không hợp lệ' });
      }
      if (!['inherit', 'public', 'institute', 'allowlist'].includes(viewScope)) {
        return res.status(400).json({ message: 'viewScope không hợp lệ' });
      }
      db.prepare(
        `INSERT INTO equipment_module_user_access(
           user_id, module_role, view_scope, can_manage_categories, can_manage_departments, can_manage_public_content, note, updated_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           module_role=excluded.module_role,
           view_scope=excluded.view_scope,
           can_manage_categories=excluded.can_manage_categories,
           can_manage_departments=excluded.can_manage_departments,
           can_manage_public_content=excluded.can_manage_public_content,
           note=excluded.note,
           updated_by=excluded.updated_by,
           updated_at=datetime('now')`
      ).run(
        userId,
        moduleRole,
        viewScope,
        0,
        b.canManageDepartments ? 1 : 0,
        b.canManagePublicContent ? 1 : 0,
        b.note ? String(b.note).slice(0, 500) : null,
        req.user.id
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Không lưu được phân quyền user' });
    }
  });

  router.delete('/module/admin/user/:userId', authMiddleware, requireModuleMaster, (req, res) => {
    try {
      const userId = parseInt(req.params.userId, 10);
      if (!Number.isFinite(userId) || userId <= 0) {
        return res.status(400).json({ message: 'userId không hợp lệ' });
      }
      db.prepare(`DELETE FROM equipment_module_user_access WHERE user_id = ?`).run(userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Không xoá được phân quyền user' });
    }
  });

  router.post('/module/admin/departments', authMiddleware, requireDepartmentManager, express.json(), (req, res) => {
    try {
      const b = req.body || {};
      const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
      const name = String(b.name || '').trim().slice(0, 120);
      const sortOrder = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : 0;
      if (!code || !name) return res.status(400).json({ message: 'Thiếu code hoặc name' });
      db.prepare(`INSERT INTO equipment_departments(code, name, sort_order) VALUES (?, ?, ?)`).run(code, name, sortOrder);
      res.json({ ok: true });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(409).json({ message: 'Mã phòng/lab đã tồn tại' });
      }
      res.status(500).json({ message: e.message || 'Không thêm được phòng/lab' });
    }
  });

  router.patch('/module/admin/departments/:id', authMiddleware, requireDepartmentManager, express.json(), (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'ID không hợp lệ' });
      const cur = db.prepare(`SELECT id, code, name, sort_order FROM equipment_departments WHERE id = ?`).get(id);
      if (!cur) return res.status(404).json({ message: 'Không tìm thấy phòng/lab' });
      const b = req.body || {};
      const code = b.code != null ? String(b.code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24) : cur.code;
      const name = b.name != null ? String(b.name).trim().slice(0, 120) : cur.name;
      const sortOrder = b.sortOrder != null ? Number(b.sortOrder) : cur.sort_order;
      if (!code || !name) return res.status(400).json({ message: 'code/name không hợp lệ' });
      db.prepare(`UPDATE equipment_departments SET code = ?, name = ?, sort_order = ? WHERE id = ?`).run(
        code,
        name,
        Number.isFinite(sortOrder) ? sortOrder : 0,
        id
      );
      res.json({ ok: true });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(409).json({ message: 'Mã phòng/lab đã tồn tại' });
      }
      res.status(500).json({ message: e.message || 'Không cập nhật được phòng/lab' });
    }
  });

  router.delete('/module/admin/departments/:id', authMiddleware, requireDepartmentManager, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: 'ID không hợp lệ' });
      const inUse = db.prepare(`SELECT COUNT(*) AS c FROM equipments WHERE department_id = (SELECT code FROM equipment_departments WHERE id = ?)`).get(id);
      if (inUse && Number(inUse.c) > 0) {
        return res.status(409).json({ message: 'Đang có thiết bị thuộc phòng/lab này, chưa thể xoá.' });
      }
      db.prepare(`DELETE FROM equipment_departments WHERE id = ?`).run(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Không xoá được phòng/lab' });
    }
  });

  registerEquipmentPart2(router, {
    db,
    authMiddleware,
    adminOnly: adminOnlyMw,
    optionalAuth,
    uploadsEquipmentRoot,
    uploadsRootResolved,
    canViewEquipmentDetail,
    checkEquipmentDocAccess,
    publicProfileUrl,
    filterDocumentsForRequest,
    filterVideosForRequest,
    requireModuleViewer,
    equipmentMailSend: deps.equipmentMailSend || null,
    publicIncidentAllowedForEquipment: computePublicIncidentAllowed,
    incidentEmailsNew: () => parseJsonEmailList('incident_emails_new'),
    incidentEmailsResolved: () => parseJsonEmailList('incident_emails_resolved'),
  });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const id = parseEquipmentId(req.params.id);
      if (!id) return cb(new Error('invalid_equipment'));
      const dir = path.join(uploadsEquipmentRoot, String(id), 'docs');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ts = Date.now();
      const base = String(file.originalname || 'file.pdf').replace(/[^\w.\-()\s\u00C0-\u024F]/gi, '_');
      cb(null, `${ts}_${base}`);
    },
  });

  const uploadPdf = multer({
    storage,
    limits: { fileSize: UPLOAD_MAX, fieldSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== PDF_MIME) {
        return cb(new Error('Chỉ chấp nhận file PDF (application/pdf).'));
      }
      cb(null, true);
    },
  });

  /** Danh sách + phân trang */
  router.get('/', authMiddleware, requireModuleViewer, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = 20;
      const offset = (page - 1) * limit;
      const status = req.query.status ? String(req.query.status).trim() : '';
      const department_id = req.query.department_id != null ? String(req.query.department_id).trim() : '';
      const asset_group = req.query.asset_group != null ? String(req.query.asset_group).trim() : '';

      const where = ['1=1'];
      const params = [];
      if (status && ['active', 'maintenance', 'broken', 'retired'].includes(status)) {
        where.push('e.status = ?');
        params.push(status);
      }
      if (department_id) {
        where.push('e.department_id = ?');
        params.push(department_id);
      }
      if (asset_group) {
        where.push('lower(COALESCE(e.asset_group, \'\')) LIKE ?');
        params.push('%' + asset_group.toLowerCase().replace(/[%_]/g, '') + '%');
      }

      const role = String(req.user.role || '').toLowerCase();
      const manage = canManageEquipment(req);
      const uid = req.user.id;
      const accessMode = moduleAccessMode();
      if (!manage) {
        where.push("e.status != 'retired'");
        if (accessMode !== 'public') {
          if (role === 'researcher') {
            where.push(
              `(e.created_by = ? OR (
                (e.review_status IS NULL OR e.review_status = 'approved') AND e.profile_visibility = 'public'
              ))`
            );
            params.push(uid);
          } else {
            where.push(
              `(e.created_by = ? OR (
                (e.review_status IS NULL OR e.review_status = 'approved') AND (
                  e.profile_visibility IN ('public','institute')
                  OR (
                    e.profile_visibility = 'internal'
                    AND e.department_id IS NOT NULL
                    AND e.department_id = (SELECT department_id FROM users WHERE id = ?)
                  )
                )
              ))`
            );
            params.push(uid, uid);
          }
        }
      }

      const whereSql = where.join(' AND ');
      const countRow = db.prepare(`SELECT COUNT(*) AS c FROM equipments e WHERE ${whereSql}`).get(...params);
      const total = countRow ? countRow.c : 0;
      const rows = db
        .prepare(
          `SELECT e.* FROM equipments e WHERE ${whereSql} ORDER BY e.updated_at DESC, e.id DESC LIMIT ? OFFSET ?`
        )
        .all(...params, limit, offset);

      const data = rows.map((r) => {
        const b = maintenanceBadgeForRow(r);
        return { ...r, maintenance_badge: b };
      });

      res.json({
        ok: true,
        data,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (e) {
      console.error('[equipment list]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/stats/overview', authMiddleware, requireModuleViewer, (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status).trim() : '';
      const department_id = req.query.department_id != null ? String(req.query.department_id).trim() : '';
      const asset_group = req.query.asset_group != null ? String(req.query.asset_group).trim() : '';
      const q = String(req.query.q || '').trim().slice(0, 200);

      const where = ['1=1'];
      const params = [];
      if (status && ['active', 'maintenance', 'broken', 'retired'].includes(status)) {
        where.push('e.status = ?');
        params.push(status);
      }
      if (department_id) {
        where.push('e.department_id = ?');
        params.push(department_id);
      }
      if (asset_group) {
        where.push("lower(COALESCE(e.asset_group, '')) LIKE ?");
        params.push('%' + asset_group.toLowerCase().replace(/[%_]/g, '') + '%');
      }
      if (q) {
        const like = '%' + q.toLowerCase().replace(/[%_]/g, '') + '%';
        where.push(`(
          lower(COALESCE(e.equipment_code,'')) LIKE ?
          OR lower(COALESCE(e.name,'')) LIKE ?
          OR lower(COALESCE(e.asset_group,'')) LIKE ?
          OR lower(COALESCE(e.model,'')) LIKE ?
          OR lower(COALESCE(e.serial_number,'')) LIKE ?
          OR lower(COALESCE(e.manufacturer,'')) LIKE ?
          OR lower(COALESCE(e.department_id,'')) LIKE ?
          OR lower(COALESCE(e.location,'')) LIKE ?
          OR lower(COALESCE(e.profile_visibility,'')) LIKE ?
          OR lower(COALESCE(e.status,'')) LIKE ?
          OR lower(COALESCE(e.asset_type_code,'')) LIKE ?
          OR lower(COALESCE(e.unit_name,'')) LIKE ?
          OR lower(COALESCE(e.utilization_note,'')) LIKE ?
          OR lower(COALESCE(e.condition_note,'')) LIKE ?
          OR lower(COALESCE(e.disaster_impact_note,'')) LIKE ?
          OR lower(COALESCE(e.construction_asset_note,'')) LIKE ?
          OR lower(COALESCE(e.usage_count_note,'')) LIKE ?
          OR lower(COALESCE(e.land_attached_note,'')) LIKE ?
          OR lower(COALESCE(e.asset_note,'')) LIKE ?
          OR lower(COALESCE(CAST(e.purchase_year AS TEXT),'')) LIKE ?
          OR lower(COALESCE(CAST(e.purchase_value AS TEXT),'')) LIKE ?
          OR lower(COALESCE(CAST(e.year_in_use AS TEXT),'')) LIKE ?
          OR lower(COALESCE(CAST(e.quantity_book AS TEXT),'')) LIKE ?
          OR lower(COALESCE(CAST(e.quantity_actual AS TEXT),'')) LIKE ?
          OR lower(COALESCE(CAST(e.quantity_diff AS TEXT),'')) LIKE ?
          OR lower(COALESCE(CAST(e.remaining_value AS TEXT),'')) LIKE ?
        )`);
        for (let i = 0; i < 26; i++) params.push(like);
      }

      const role = String(req.user.role || '').toLowerCase();
      const manage = canManageEquipment(req);
      const uid = req.user.id;
      const accessMode = moduleAccessMode();
      if (!manage) {
        where.push("e.status != 'retired'");
        if (accessMode !== 'public') {
          if (role === 'researcher') {
            where.push(
              `(e.created_by = ? OR (
                (e.review_status IS NULL OR e.review_status = 'approved') AND e.profile_visibility = 'public'
              ))`
            );
            params.push(uid);
          } else {
            where.push(
              `(e.created_by = ? OR (
                (e.review_status IS NULL OR e.review_status = 'approved') AND (
                  e.profile_visibility IN ('public','institute')
                  OR (
                    e.profile_visibility = 'internal'
                    AND e.department_id IS NOT NULL
                    AND e.department_id = (SELECT department_id FROM users WHERE id = ?)
                  )
                )
              ))`
            );
            params.push(uid, uid);
          }
        }
      }

      const whereSql = where.join(' AND ');
      const row = db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN e.status = 'active' THEN 1 ELSE 0 END) AS activeCount,
             SUM(CASE WHEN e.status IN ('maintenance','broken') THEN 1 ELSE 0 END) AS riskCount,
             SUM(CASE WHEN e.profile_visibility = 'public' THEN 1 ELSE 0 END) AS publicCount
           FROM equipments e
           WHERE ${whereSql}`
        )
        .get(...params);

      return res.json({
        ok: true,
        data: {
          total: Number((row && row.total) || 0),
          activeCount: Number((row && row.activeCount) || 0),
          riskCount: Number((row && row.riskCount) || 0),
          publicCount: Number((row && row.publicCount) || 0),
        },
      });
    } catch (e) {
      console.error('[equipment stats overview]', e);
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Tìm kiếm */
  router.get('/search', authMiddleware, requireModuleViewer, (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 200);
      const asset_group = String(req.query.asset_group || '').trim().slice(0, 200);
      if (q.length < 1) {
        return res.json({ ok: true, data: [] });
      }
      const safe = q.replace(/[%_]/g, '');
      const like = `%${safe.toLowerCase()}%`;
      const role = String(req.user.role || '').toLowerCase();
      const manage = canManageEquipment(req);
      let extra = '';
      const uid = req.user.id;
      const searchTail = [];
      const accessMode = moduleAccessMode();
      if (!manage) {
        extra = " AND e.status != 'retired' ";
        if (accessMode !== 'public') {
          if (role === 'researcher') {
            extra +=
              " AND (e.created_by = ? OR ((e.review_status IS NULL OR e.review_status = 'approved') AND e.profile_visibility = 'public')) ";
            searchTail.push(uid);
          } else {
            extra +=
              " AND (e.created_by = ? OR ((e.review_status IS NULL OR e.review_status = 'approved') AND ( e.profile_visibility IN ('public','institute') OR (e.profile_visibility = 'internal' AND e.department_id IS NOT NULL AND e.department_id = (SELECT department_id FROM users WHERE id = ?)) ))) ";
            searchTail.push(uid, uid);
          }
        }
      }
      if (asset_group) {
        extra += ' AND lower(COALESCE(e.asset_group, \'\')) LIKE ? ';
        searchTail.push('%' + asset_group.toLowerCase().replace(/[%_]/g, '') + '%');
      }
      const rows = db
        .prepare(
          `SELECT e.id, e.equipment_code, e.name, e.asset_group, e.model, e.serial_number, e.status, e.profile_visibility
           FROM equipments e
           WHERE (
            lower(COALESCE(e.equipment_code,'')) LIKE ?
            OR lower(COALESCE(e.name,'')) LIKE ?
            OR lower(COALESCE(e.asset_group,'')) LIKE ?
            OR lower(COALESCE(e.model,'')) LIKE ?
            OR lower(COALESCE(e.serial_number,'')) LIKE ?
            OR lower(COALESCE(e.manufacturer,'')) LIKE ?
            OR lower(COALESCE(e.department_id,'')) LIKE ?
            OR lower(COALESCE(e.location,'')) LIKE ?
            OR lower(COALESCE(e.profile_visibility,'')) LIKE ?
            OR lower(COALESCE(e.status,'')) LIKE ?
            OR lower(COALESCE(e.asset_type_code,'')) LIKE ?
            OR lower(COALESCE(e.unit_name,'')) LIKE ?
            OR lower(COALESCE(e.utilization_note,'')) LIKE ?
            OR lower(COALESCE(e.condition_note,'')) LIKE ?
            OR lower(COALESCE(e.disaster_impact_note,'')) LIKE ?
            OR lower(COALESCE(e.construction_asset_note,'')) LIKE ?
            OR lower(COALESCE(e.usage_count_note,'')) LIKE ?
            OR lower(COALESCE(e.land_attached_note,'')) LIKE ?
            OR lower(COALESCE(e.asset_note,'')) LIKE ?
            OR lower(COALESCE(CAST(e.purchase_year AS TEXT),'')) LIKE ?
            OR lower(COALESCE(CAST(e.purchase_value AS TEXT),'')) LIKE ?
            OR lower(COALESCE(CAST(e.year_in_use AS TEXT),'')) LIKE ?
            OR lower(COALESCE(CAST(e.quantity_book AS TEXT),'')) LIKE ?
            OR lower(COALESCE(CAST(e.quantity_actual AS TEXT),'')) LIKE ?
            OR lower(COALESCE(CAST(e.quantity_diff AS TEXT),'')) LIKE ?
            OR lower(COALESCE(CAST(e.remaining_value AS TEXT),'')) LIKE ?
           ) ${extra}
           ORDER BY e.name COLLATE NOCASE
           LIMIT 40`
        )
        .all(
          like, // equipment_code
          like, // name
          like, // asset_group
          like, // model
          like, // serial_number
          like, // manufacturer
          like, // department_id
          like, // location
          like, // profile_visibility
          like, // status
          like, // asset_type_code
          like, // unit_name
          like, // utilization_note
          like, // condition_note
          like, // disaster_impact_note
          like, // construction_asset_note
          like, // usage_count_note
          like, // land_attached_note
          like, // asset_note
          like, // purchase_year
          like, // purchase_value
          like, // year_in_use
          like, // quantity_book
          like, // quantity_actual
          like, // quantity_diff
          like, // remaining_value
          ...searchTail
        );
      res.json({ ok: true, data: rows });
    } catch (e) {
      console.error('[equipment search]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/export/ids', authMiddleware, requireModuleViewer, (req, res) => {
    try {
      if (!canModuleManagerOrMaster(req)) {
        return res.status(403).json({ message: 'Chỉ Module Manager trở lên mới xuất dữ liệu.' });
      }
      const status = req.query.status ? String(req.query.status).trim() : '';
      const department_id = req.query.department_id != null ? String(req.query.department_id).trim() : '';
      const asset_group = req.query.asset_group != null ? String(req.query.asset_group).trim() : '';

      const where = ['1=1'];
      const params = [];
      if (status && ['active', 'maintenance', 'broken', 'retired'].includes(status)) {
        where.push('e.status = ?');
        params.push(status);
      }
      if (department_id) {
        where.push('e.department_id = ?');
        params.push(department_id);
      }
      if (asset_group) {
        where.push('lower(COALESCE(e.asset_group, \'\')) LIKE ?');
        params.push('%' + asset_group.toLowerCase().replace(/[%_]/g, '') + '%');
      }

      const rows = db
        .prepare(`SELECT e.id FROM equipments e WHERE ${where.join(' AND ')} ORDER BY e.updated_at DESC, e.id DESC LIMIT 5000`)
        .all(...params);
      return res.json({ ok: true, ids: (rows || []).map((r) => Number(r.id)).filter((x) => Number.isFinite(x) && x > 0) });
    } catch (e) {
      return res.status(500).json({ message: e.message || 'Không lấy được danh sách ID để xuất.' });
    }
  });

  router.post('/export/selected', authMiddleware, requireModuleViewer, express.json(), async (req, res) => {
    try {
      if (!canModuleManagerOrMaster(req)) {
        return res.status(403).json({ message: 'Chỉ Module Manager trở lên mới xuất dữ liệu.' });
      }
      const b = req.body || {};
      const rawIds = Array.isArray(b.ids) ? b.ids : [];
      const ids = [];
      const seen = new Set();
      rawIds.forEach((x) => {
        const n = parseInt(x, 10);
        if (!Number.isFinite(n) || n <= 0 || seen.has(n)) return;
        seen.add(n);
        ids.push(n);
      });
      if (!ids.length) {
        return res.status(400).json({ message: 'Danh sách thiết bị cần xuất đang trống.' });
      }
      if (ids.length > 5000) {
        return res.status(400).json({ message: 'Vượt quá giới hạn 5000 thiết bị/lần xuất.' });
      }
      const ExcelJS = require('exceljs');
      const ph = ids.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT
             e.id, e.equipment_code, e.name, e.asset_group, e.model, e.serial_number, e.manufacturer,
             e.purchase_year, e.purchase_value, e.department_id, e.location, e.status, e.profile_visibility,
             e.asset_type_code, e.year_in_use, e.unit_name, e.quantity_book, e.quantity_actual, e.quantity_diff,
             e.remaining_value, e.utilization_note, e.condition_note, e.disaster_impact_note,
             e.construction_asset_note, e.usage_count_note, e.land_attached_note, e.asset_note,
             e.created_at, e.updated_at,
             u.fullname AS manager_name
           FROM equipments e
           LEFT JOIN users u ON u.id = e.manager_id
           WHERE e.id IN (${ph})
           ORDER BY e.updated_at DESC, e.id DESC`
        )
        .all(...ids);
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Thiet_bi_da_chon');
      ws.addRow([
        'ID',
        'Mã thiết bị',
        'Tên thiết bị',
        'Loại',
        'Model',
        'Serial',
        'Nhà sản xuất',
        'Năm mua',
        'Giá trị mua',
        'Mã loại tài sản',
        'Năm đưa vào sử dụng',
        'Đơn vị tính',
        'Theo sổ kế toán',
        'Theo thực tế kiểm kê',
        'Chênh lệch',
        'GTCL',
        'Tình hình khai thác',
        'Tình trạng tài sản',
        'Ảnh hưởng thiên tai',
        'Tài sản công trình',
        'Số lần',
        'Tài sản gắn với đất',
        'Ghi chú',
        'Phòng/Lab',
        'Cán bộ phụ trách',
        'Vị trí',
        'Trạng thái',
        'Hiển thị',
        'Ngày tạo',
        'Ngày cập nhật',
      ]);
      rows.forEach((r) => {
        ws.addRow([
          r.id,
          r.equipment_code,
          r.name,
          r.asset_group,
          r.model,
          r.serial_number,
          r.manufacturer,
          r.purchase_year,
          r.purchase_value,
          r.asset_type_code,
          r.year_in_use,
          r.unit_name,
          r.quantity_book,
          r.quantity_actual,
          r.quantity_diff,
          r.remaining_value,
          r.utilization_note,
          r.condition_note,
          r.disaster_impact_note,
          r.construction_asset_note,
          r.usage_count_note,
          r.land_attached_note,
          r.asset_note,
          r.department_id,
          r.manager_name,
          r.location,
          r.status,
          r.profile_visibility,
          r.created_at,
          r.updated_at,
        ]);
      });
      ws.columns.forEach((col) => {
        col.width = 18;
      });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="equipment-selected-${stamp}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    } catch (e) {
      console.error('[equipment export selected]', e);
      return res.status(500).json({ message: e.message || 'Không xuất được file Excel.' });
    }
  });

  /** QR PNG */
  router.get('/:id/qr', optionalAuth, async (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const row = db.prepare('SELECT id FROM equipments WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      const url = publicProfileUrl(req, id);
      const buf = await QRCode.toBuffer(url, { type: 'png', width: 256, margin: 2 });
      res.setHeader('Content-Type', 'image/png');
      // QR only depends on equipment id/public URL, safe to cache to reduce repeated list requests.
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return res.send(buf);
    } catch (e) {
      console.error('[equipment qr]', e);
      return res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** JSON hồ sơ công khai */
  router.get('/:id/public', optionalAuth, (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      if (!eq || eq.status === 'retired') {
        return res.status(404).json({ message: 'Không tìm thấy hồ sơ công khai' });
      }

      const docsAll = db
        .prepare(
          `SELECT id, doc_type, title, version, notes, access_level, created_at, is_disabled, is_current, supersedes_id FROM equipment_documents
           WHERE equipment_id = ? ORDER BY created_at DESC`
        )
        .all(id);
      const vidsAll = db
        .prepare(
          `SELECT id, title, video_url, platform, description, access_level, created_at, thumbnail_url FROM equipment_videos
           WHERE equipment_id = ? ORDER BY created_at DESC`
        )
        .all(id);

      const docsForAnon = (docsAll || []).filter((d) => {
        if (d.is_disabled) return false;
        const cur = d.is_current == null || Number(d.is_current) === 1;
        if (!cur) return false;
        return String(d.access_level || '').toLowerCase() === 'public';
      });
      const vidsForAnon = (vidsAll || []).filter((v) => String(v.access_level || '').toLowerCase() === 'public');
      const docsVisible = filterDocumentsForRequest(req, docsAll, eq, db);
      const vidsVisible = filterVideosForRequest(req, vidsAll, eq, db);

      const rs = reviewStatus(eq);
      const publicIncidentAllowed = computePublicIncidentAllowed(eq, id);
      if (!req.user) {
        const vis = String(eq.profile_visibility || '').toLowerCase();
        if (rs !== 'approved' || vis !== 'public') {
          return res.status(404).json({ message: 'Hồ sơ không công khai' });
        }
        return res.json({
          ok: true,
          equipment: eq,
          documents: docsForAnon,
          videos: vidsForAnon,
          qr_data_url: null,
          public_incident_allowed: publicIncidentAllowed,
        });
      }

      if (req.user) {
        const detailCheck = canViewEquipmentDetail(req, eq, db);
        if (!detailCheck.ok) {
          return res.status(detailCheck.status).json({ message: 'Không có quyền xem' });
        }
      }

      res.json({
        ok: true,
        equipment: eq,
        documents: docsVisible,
        videos: vidsVisible,
        public_incident_allowed: publicIncidentAllowed,
      });
    } catch (e) {
      console.error('[equipment public]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Chi tiết (đã đăng nhập) */
  router.get('/:id', authMiddleware, requireModuleViewer, (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      const check = canViewEquipmentDetail(req, eq, db);
      if (!check.ok) {
        return res.status(check.status).json({ message: check.message || 'Không có quyền xem' });
      }
      const documents = db
        .prepare(
          `SELECT d.*, u.fullname AS uploaded_by_name FROM equipment_documents d
           LEFT JOIN users u ON u.id = d.uploaded_by
           WHERE d.equipment_id = ? ORDER BY d.created_at DESC`
        )
        .all(id);
      const videos = db
        .prepare(
          `SELECT v.*, u.fullname AS added_by_name FROM equipment_videos v
           LEFT JOIN users u ON u.id = v.added_by
           WHERE v.equipment_id = ? ORDER BY v.created_at DESC`
        )
        .all(id);
      const statusLogs = canManageEquipment(req) || !isResearcher(req)
        ? db
            .prepare(
              `SELECT l.*, u.fullname AS changed_by_name FROM equipment_status_logs l
               LEFT JOIN users u ON u.id = l.changed_by
               WHERE l.equipment_id = ? ORDER BY l.changed_at DESC LIMIT 200`
            )
            .all(id)
        : [];
      const docLogs = canManageEquipment(req)
        ? db
            .prepare(
              `SELECT l.*, u.fullname AS performed_by_name FROM equipment_document_logs l
               LEFT JOIN users u ON u.id = l.performed_by
               WHERE l.equipment_id = ? ORDER BY l.performed_at DESC LIMIT 200`
            )
            .all(id)
        : [];
      let maintenance = [];
      let incidents = [];
      const viewerVisible = new Set(parseViewerVisibleFields());
      try {
        maintenance = db
          .prepare(
            `SELECT m.*, u.fullname AS performed_by_name FROM equipment_maintenance m
             LEFT JOIN users u ON u.id = m.performed_by WHERE m.equipment_id = ? ORDER BY m.id DESC`
          )
          .all(id);
      } catch (_) {}
      try {
        incidents = db
          .prepare(
            `SELECT i.*,
              COALESCE(NULLIF(TRIM(i.reporter_display), ''), rb.fullname,
                CASE WHEN IFNULL(i.incident_source, 'user') = 'public' THEN 'Ẩn danh (QR)' ELSE NULL END
              ) AS reported_by_name,
              asg.fullname AS assigned_to_name
             FROM equipment_incidents i
             LEFT JOIN users rb ON rb.id = i.reported_by
             LEFT JOIN users asg ON asg.id = i.assigned_to
             WHERE i.equipment_id = ? ORDER BY i.id DESC LIMIT 100`
          )
          .all(id);
      } catch (_) {}

      const eqOut = { ...eq };
      if (!canManageEquipment(req)) {
        const defs = viewerFieldDefs();
        defs.forEach((d) => {
          if (!viewerVisible.has(d.key)) eqOut[d.key] = null;
        });
      }

      res.json({
        ok: true,
        equipment: eqOut,
        documents: filterDocumentsForRequest(req, documents, eq, db),
        documentsAll: canManageEquipment(req) ? documents : undefined,
        videos: filterVideosForRequest(req, videos, eq, db),
        statusLogs,
        documentLogs: docLogs,
        maintenance,
        incidents,
        maintenanceBadge: maintenanceBadgeForRow(eq),
        canManage: canManageEquipment(req),
        canUploadDocuments: canUploadEquipmentMedia(req, eq),
        isAdmin: String(req.user.role || '').toLowerCase() === 'admin',
      });
    } catch (e) {
      console.error('[equipment get]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.post('/', authMiddleware, requireModuleViewer, express.json(), (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim();
      const model = String(b.model || '').trim();
      if (!name || !model) {
        return res.status(400).json({ message: 'Thiếu tên hoặc model thiết bị (bắt buộc)' });
      }
      const deptCode = String(b.department_id || 'SCI').trim().toUpperCase().slice(0, 16) || 'SCI';
      const yearRaw = b.purchase_year != null ? parseInt(b.purchase_year, 10) : new Date().getFullYear();
      const year = Number.isFinite(yearRaw) ? yearRaw : new Date().getFullYear();
      let equipment_code = String(b.equipment_code || '').trim();
      if (!equipment_code) {
        equipment_code = generateEquipmentCode(db, deptCode, year);
      }
      const profile_visibility = ['public', 'institute', 'internal'].includes(String(b.profile_visibility))
        ? String(b.profile_visibility)
        : 'institute';
      const manager_id = b.manager_id != null && b.manager_id !== '' ? parseInt(b.manager_id, 10) : null;
      let review_status = 'draft';
      if (
        canManageEquipment(req) &&
        b.review_status &&
        ['draft', 'pending_review', 'approved', 'rejected'].includes(String(b.review_status))
      ) {
        review_status = String(b.review_status);
      }
      const created_by = req.user.id;
      const utilizationNoteNorm = normalizeEquipmentCodeField(b.utilization_note);
      const conditionNoteNorm = normalizeEquipmentCodeField(b.condition_note);
      const r = db
        .prepare(
          `INSERT INTO equipments (
            equipment_code, name, asset_group, model, serial_number, manufacturer, purchase_year, purchase_value,
            department_id, manager_id, location, specs_json, status, profile_visibility, review_status, created_by,
            asset_type_code, year_in_use, unit_name, quantity_book, quantity_actual, quantity_diff, remaining_value,
            utilization_note, condition_note, disaster_impact_note, construction_asset_note, usage_count_note,
            land_attached_note, asset_note
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          equipment_code,
          name,
          b.asset_group != null ? String(b.asset_group) : null,
          model,
          b.serial_number != null ? String(b.serial_number) : null,
          b.manufacturer != null ? String(b.manufacturer) : null,
          b.purchase_year != null ? parseInt(b.purchase_year, 10) : null,
          b.purchase_value != null ? Number(b.purchase_value) : null,
          b.department_id != null ? String(b.department_id) : null,
          Number.isFinite(manager_id) ? manager_id : null,
          b.location != null ? String(b.location) : null,
          b.specs_json != null ? (typeof b.specs_json === 'string' ? b.specs_json : JSON.stringify(b.specs_json)) : null,
          ['active', 'maintenance', 'broken', 'retired'].includes(String(b.status)) ? String(b.status) : 'active',
          profile_visibility,
          review_status,
          created_by,
          b.asset_type_code != null ? String(b.asset_type_code) : null,
          b.year_in_use != null ? parseInt(b.year_in_use, 10) : null,
          b.unit_name != null ? String(b.unit_name) : null,
          b.quantity_book != null ? Number(b.quantity_book) : null,
          b.quantity_actual != null ? Number(b.quantity_actual) : null,
          b.quantity_diff != null ? Number(b.quantity_diff) : null,
          b.remaining_value != null ? Number(b.remaining_value) : null,
          utilizationNoteNorm,
          conditionNoteNorm,
          b.disaster_impact_note != null ? String(b.disaster_impact_note) : null,
          b.construction_asset_note != null ? String(b.construction_asset_note) : null,
          b.usage_count_note != null ? String(b.usage_count_note) : null,
          b.land_attached_note != null ? String(b.land_attached_note) : null,
          b.asset_note != null ? String(b.asset_note) : null
        );
      const newId = r.lastInsertRowid;
      const row = db.prepare('SELECT * FROM equipments WHERE id = ?').get(newId);
      res.status(201).json({ ok: true, equipment: row });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(409).json({ message: 'Mã thiết bị đã tồn tại' });
      }
      console.error('[equipment create]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.put('/:id', authMiddleware, requireModuleViewer, express.json(), (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const cur = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!canManageEquipment(req)) {
        if (Number(cur.created_by) !== Number(req.user.id)) {
          return res.status(403).json({ message: 'Chỉ người tạo hoặc quản trị mới sửa được' });
        }
        const rs = reviewStatus(cur);
        if (!['draft', 'rejected'].includes(rs)) {
          return res.status(403).json({ message: 'Chỉ sửa được hồ sơ ở trạng thái nháp hoặc bị trả về' });
        }
      }
      const b = req.body || {};
      const equipment_code = String(b.equipment_code || cur.equipment_code).trim();
      const name = String(b.name || cur.name).trim();
      const profile_visibility = ['public', 'institute', 'internal'].includes(String(b.profile_visibility))
        ? String(b.profile_visibility)
        : cur.profile_visibility;
      const manager_id = b.manager_id != null && b.manager_id !== '' ? parseInt(b.manager_id, 10) : cur.manager_id;
      const utilizationNoteNorm =
        b.utilization_note !== undefined
          ? normalizeEquipmentCodeField(b.utilization_note)
          : cur.utilization_note;
      const conditionNoteNorm =
        b.condition_note !== undefined
          ? normalizeEquipmentCodeField(b.condition_note)
          : cur.condition_note;
      db.prepare(
        `UPDATE equipments SET
          equipment_code=?, name=?, asset_group=?, model=?, serial_number=?, manufacturer=?, purchase_year=?, purchase_value=?,
          department_id=?, manager_id=?, location=?, specs_json=?, status=?, profile_visibility=?,
          asset_type_code=?, year_in_use=?, unit_name=?, quantity_book=?, quantity_actual=?, quantity_diff=?,
          remaining_value=?, utilization_note=?, condition_note=?, disaster_impact_note=?, construction_asset_note=?,
          usage_count_note=?, land_attached_note=?, asset_note=?,
          updated_at=datetime('now')
        WHERE id=?`
      ).run(
        equipment_code,
        name,
        b.asset_group !== undefined ? (b.asset_group != null ? String(b.asset_group) : null) : cur.asset_group,
        b.model !== undefined ? (b.model != null ? String(b.model) : null) : cur.model,
        b.serial_number !== undefined ? (b.serial_number != null ? String(b.serial_number) : null) : cur.serial_number,
        b.manufacturer !== undefined ? (b.manufacturer != null ? String(b.manufacturer) : null) : cur.manufacturer,
        b.purchase_year !== undefined ? (b.purchase_year != null ? parseInt(b.purchase_year, 10) : null) : cur.purchase_year,
        b.purchase_value !== undefined ? (b.purchase_value != null ? Number(b.purchase_value) : null) : cur.purchase_value,
        b.department_id !== undefined ? (b.department_id != null ? String(b.department_id) : null) : cur.department_id,
        Number.isFinite(manager_id) ? manager_id : null,
        b.location !== undefined ? (b.location != null ? String(b.location) : null) : cur.location,
        b.specs_json !== undefined
          ? typeof b.specs_json === 'string'
            ? b.specs_json
            : JSON.stringify(b.specs_json)
          : cur.specs_json,
        b.status && ['active', 'maintenance', 'broken', 'retired'].includes(String(b.status)) ? String(b.status) : cur.status,
        profile_visibility,
        b.asset_type_code !== undefined ? (b.asset_type_code != null ? String(b.asset_type_code) : null) : cur.asset_type_code,
        b.year_in_use !== undefined ? (b.year_in_use != null ? parseInt(b.year_in_use, 10) : null) : cur.year_in_use,
        b.unit_name !== undefined ? (b.unit_name != null ? String(b.unit_name) : null) : cur.unit_name,
        b.quantity_book !== undefined ? (b.quantity_book != null ? Number(b.quantity_book) : null) : cur.quantity_book,
        b.quantity_actual !== undefined ? (b.quantity_actual != null ? Number(b.quantity_actual) : null) : cur.quantity_actual,
        b.quantity_diff !== undefined ? (b.quantity_diff != null ? Number(b.quantity_diff) : null) : cur.quantity_diff,
        b.remaining_value !== undefined ? (b.remaining_value != null ? Number(b.remaining_value) : null) : cur.remaining_value,
        utilizationNoteNorm,
        conditionNoteNorm,
        b.disaster_impact_note !== undefined
          ? (b.disaster_impact_note != null ? String(b.disaster_impact_note) : null)
          : cur.disaster_impact_note,
        b.construction_asset_note !== undefined
          ? (b.construction_asset_note != null ? String(b.construction_asset_note) : null)
          : cur.construction_asset_note,
        b.usage_count_note !== undefined ? (b.usage_count_note != null ? String(b.usage_count_note) : null) : cur.usage_count_note,
        b.land_attached_note !== undefined
          ? (b.land_attached_note != null ? String(b.land_attached_note) : null)
          : cur.land_attached_note,
        b.asset_note !== undefined ? (b.asset_note != null ? String(b.asset_note) : null) : cur.asset_note,
        id
      );
      const row = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      res.json({ ok: true, equipment: row });
    } catch (e) {
      if (String(e.message || '').includes('UNIQUE')) {
        return res.status(409).json({ message: 'Mã thiết bị đã tồn tại' });
      }
      console.error('[equipment put]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.patch('/:id/status', authMiddleware, requireModuleViewer, requireManage, express.json(), (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const cur = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ message: 'Không tìm thấy' });
      const newStatus = String(req.body && req.body.status ? req.body.status : '').trim();
      if (!['active', 'maintenance', 'broken', 'retired'].includes(newStatus)) {
        return res.status(400).json({ message: 'Trạng thái không hợp lệ' });
      }
      const note = req.body && req.body.note != null ? String(req.body.note).slice(0, 2000) : null;
      db.prepare(`UPDATE equipments SET status=?, updated_at=datetime('now') WHERE id=?`).run(newStatus, id);
      db.prepare(
        `INSERT INTO equipment_status_logs (equipment_id, old_status, new_status, changed_by, note)
         VALUES (?,?,?,?,?)`
      ).run(id, cur.status, newStatus, req.user.id, note);
      const row = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      res.json({ ok: true, equipment: row });
    } catch (e) {
      console.error('[equipment status]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.delete('/:id', authMiddleware, requireModuleViewer, requireManage, (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const cur = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      if (!cur) return res.status(404).json({ message: 'Không tìm thấy' });
      const doDelete = db.transaction((equipmentId) => {
        // Rely on ON DELETE CASCADE for dependent tables (documents, videos, incidents, logs...).
        const row = db.prepare(`DELETE FROM equipments WHERE id = ?`).run(equipmentId);
        return row && Number(row.changes || 0) > 0;
      });
      const deleted = doDelete(id);
      if (!deleted) return res.status(404).json({ message: 'Không tìm thấy' });
      res.json({ ok: true, deleted: true });
    } catch (e) {
      console.error('[equipment delete]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Upload PDF */
  router.post('/:id/documents', authMiddleware, requireModuleViewer, (req, res, next) => {
    const eid = parseEquipmentId(req.params.id);
    if (!eid) return res.status(400).json({ message: 'ID không hợp lệ' });
    const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(eid);
    if (!eq) return res.status(404).json({ message: 'Không tìm thấy thiết bị' });
    if (!canUploadEquipmentMedia(req, eq)) {
      return res.status(403).json({ message: 'Không có quyền tải tài liệu lên hồ sơ này' });
    }
    next();
  }, (req, res) => {
    uploadPdf.single('file')(req, res, (err) => {
      if (err) {
        const msg = err.message || 'Lỗi upload';
        return res.status(400).json({ message: msg });
      }
      try {
        const id = parseEquipmentId(req.params.id);
        if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
        const eq = db.prepare('SELECT id FROM equipments WHERE id = ?').get(id);
        if (!eq) return res.status(404).json({ message: 'Không tìm thấy thiết bị' });
        const doc_type = String(req.body && req.body.doc_type ? req.body.doc_type : '').trim();
        if (!['sop', 'technical', 'safety', 'warranty', 'calibration'].includes(doc_type)) {
          return res.status(400).json({ message: 'doc_type không hợp lệ' });
        }
        const title = String(req.body && req.body.title ? req.body.title : '').trim() || 'Tài liệu';
        const version = req.body && req.body.version != null ? String(req.body.version).slice(0, 64) : null;
        const notes = req.body && req.body.notes != null ? String(req.body.notes).slice(0, 4000) : null;
        const access_level = ['internal', 'institute', 'public'].includes(String(req.body && req.body.access_level))
          ? String(req.body.access_level)
          : 'internal';
        if (!req.file) return res.status(400).json({ message: 'Thiếu file PDF' });

        const relPath = path
          .join('equipment', String(id), 'docs', req.file.filename)
          .replace(/\\/g, '/');
        const abs = req.file.path;
        const st = fs.statSync(abs);

        const ins = db
          .prepare(
            `INSERT INTO equipment_documents (
              equipment_id, doc_type, title, file_path, file_size, version, notes, access_level, uploaded_by, is_disabled, is_current
            ) VALUES (?,?,?,?,?,?,?,?,?,0,1)`
          )
          .run(id, doc_type, title, relPath, st.size, version, notes, access_level, req.user.id);
        const docId = ins.lastInsertRowid;
        db.prepare(
          `INSERT INTO equipment_document_logs (equipment_id, document_id, action, performed_by, note)
           VALUES (?,?,?,?,?)`
        ).run(id, docId, 'add', req.user.id, null);
        db.prepare(`UPDATE equipments SET updated_at=datetime('now') WHERE id=?`).run(id);
        const eqRow = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
        notifyEquipmentStakeholders(
          db,
          eqRow,
          'equip_doc_add',
          'Tài liệu mới trên thiết bị',
          title,
          `/public/equipment/detail.html?id=${id}`
        );

        const doc = db.prepare('SELECT * FROM equipment_documents WHERE id = ?').get(docId);
        res.status(201).json({ ok: true, document: doc });
      } catch (e) {
        console.error('[equipment doc upload]', e);
        res.status(500).json({ message: e.message || 'Lỗi' });
      }
    });
  });

  router.put('/:id/documents/:docId', authMiddleware, requireModuleViewer, requireManage, express.json(), (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      const docId = parseEquipmentId(req.params.docId);
      if (!id || !docId) return res.status(400).json({ message: 'ID không hợp lệ' });
      const doc = db.prepare('SELECT * FROM equipment_documents WHERE id = ? AND equipment_id = ?').get(docId, id);
      if (!doc) return res.status(404).json({ message: 'Không tìm thấy tài liệu' });
      const b = req.body || {};
      const doc_type = b.doc_type && ['sop', 'technical', 'safety', 'warranty', 'calibration'].includes(String(b.doc_type))
        ? String(b.doc_type)
        : doc.doc_type;
      const title = b.title != null ? String(b.title).trim() : doc.title;
      const version = b.version !== undefined ? (b.version != null ? String(b.version).slice(0, 64) : null) : doc.version;
      const notes = b.notes !== undefined ? (b.notes != null ? String(b.notes).slice(0, 4000) : null) : doc.notes;
      const access_level =
        b.access_level && ['internal', 'institute', 'public'].includes(String(b.access_level))
          ? String(b.access_level)
          : doc.access_level;
      db.prepare(
        `UPDATE equipment_documents SET doc_type=?, title=?, version=?, notes=?, access_level=? WHERE id=?`
      ).run(doc_type, title, version, notes, access_level, docId);
      db.prepare(`UPDATE equipments SET updated_at=datetime('now') WHERE id=?`).run(id);
      const eqN = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      notifyEquipmentStakeholders(
        db,
        eqN,
        'equip_doc_meta',
        'Cập nhật metadata tài liệu',
        title,
        `/public/equipment/detail.html?id=${id}`
      );
      const row = db.prepare('SELECT * FROM equipment_documents WHERE id = ?').get(docId);
      res.json({ ok: true, document: row });
    } catch (e) {
      console.error('[equipment doc put]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.patch('/:id/documents/:docId/disable', authMiddleware, requireModuleViewer, requireManage, express.json(), (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      const docId = parseEquipmentId(req.params.docId);
      if (!id || !docId) return res.status(400).json({ message: 'ID không hợp lệ' });
      const doc = db.prepare('SELECT * FROM equipment_documents WHERE id = ? AND equipment_id = ?').get(docId, id);
      if (!doc) return res.status(404).json({ message: 'Không tìm thấy tài liệu' });
      db.prepare('UPDATE equipment_documents SET is_disabled = 1 WHERE id = ?').run(docId);
      const note = req.body && req.body.note != null ? String(req.body.note).slice(0, 2000) : null;
      db.prepare(
        `INSERT INTO equipment_document_logs (equipment_id, document_id, action, performed_by, note)
         VALUES (?,?,?,?,?)`
      ).run(id, docId, 'disable', req.user.id, note);
      db.prepare(`UPDATE equipments SET updated_at=datetime('now') WHERE id=?`).run(id);
      const eqRow = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      notifyEquipmentStakeholders(
        db,
        eqRow,
        'equip_doc_disable',
        'Tài liệu thiết bị đã vô hiệu hóa',
        doc.title || '',
        `/public/equipment/detail.html?id=${id}`
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('[equipment doc disable]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/:id/documents/:docId/download', optionalAuth, (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      const docId = parseEquipmentId(req.params.docId);
      if (!id || !docId) return res.status(400).json({ message: 'ID không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      if (!eq) return res.status(404).json({ message: 'Không tìm thấy' });
      const doc = db.prepare('SELECT * FROM equipment_documents WHERE id = ? AND equipment_id = ?').get(docId, id);
      if (!doc) return res.status(404).json({ message: 'Không tìm thấy' });
      if (doc.is_disabled && !canManageEquipment(req)) {
        return res.status(404).json({ message: 'Tài liệu đã bị vô hiệu hóa' });
      }
      if (!req.user) {
        if (eq.status === 'retired') return res.status(404).json({ message: 'Không tìm thấy' });
        if (String(doc.access_level || '').toLowerCase() !== 'public') {
          return res.status(401).json({ message: 'Vui lòng đăng nhập để tải tài liệu' });
        }
      } else {
        const view = canViewEquipmentDetail(req, eq, db);
        if (!view.ok) return res.status(view.status).json({ message: 'Không có quyền' });
      }
      const acc = checkEquipmentDocAccess(req, doc, eq, db);
      if (!acc.ok) {
        return res.status(acc.status || 403).json({ message: 'Không có quyền tải tài liệu này' });
      }
      const rel = String(doc.file_path || '').replace(/\\/g, '/');
      const abs = path.join(uploadsRootResolved, rel);
      const normalized = path.normalize(abs);
      const rootNorm = path.normalize(uploadsRootResolved);
      if (!normalized.startsWith(rootNorm) || !fs.existsSync(normalized)) {
        return res.status(404).json({ message: 'File không tồn tại trên máy chủ' });
      }
      res.setHeader('Content-Type', PDF_MIME);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(normalized))}"`);
      return res.sendFile(normalized);
    } catch (e) {
      console.error('[equipment download]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Videos */
  router.post('/:id/videos', authMiddleware, requireModuleViewer, express.json(), (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      if (!eq) return res.status(404).json({ message: 'Không tìm thấy' });
      if (!canUploadEquipmentMedia(req, eq)) {
        return res.status(403).json({ message: 'Không có quyền thêm video' });
      }
      const b = req.body || {};
      const title = String(b.title || '').trim();
      const video_url = String(b.video_url || '').trim();
      let platform = String(b.platform || '').trim().toLowerCase();
      if (!platform) platform = detectPlatformFromUrl(video_url);
      if (!title || !video_url || !['youtube', 'drive', 'internal'].includes(platform)) {
        return res.status(400).json({ message: 'Thiếu thông tin hoặc platform không hợp lệ' });
      }
      if (!validateVideoUrl(video_url, platform)) {
        return res.status(400).json({ message: 'URL không khớp nền tảng (YouTube / Drive / nội bộ)' });
      }
      const access_level = ['internal', 'institute', 'public'].includes(String(b.access_level))
        ? String(b.access_level)
        : 'internal';
      const description = b.description != null ? String(b.description).slice(0, 4000) : null;
      let thumbnail_url = null;
      if (platform === 'youtube') {
        const yid = extractYoutubeId(video_url);
        if (yid) thumbnail_url = `https://img.youtube.com/vi/${yid}/mqdefault.jpg`;
      }
      const ins = db
        .prepare(
          `INSERT INTO equipment_videos (equipment_id, title, video_url, platform, description, access_level, added_by, thumbnail_url)
           VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(id, title, video_url, platform, description, access_level, req.user.id, thumbnail_url);
      db.prepare(`UPDATE equipments SET updated_at=datetime('now') WHERE id=?`).run(id);
      const row = db.prepare('SELECT * FROM equipment_videos WHERE id = ?').get(ins.lastInsertRowid);
      res.status(201).json({ ok: true, video: row });
    } catch (e) {
      console.error('[equipment video post]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.put('/:id/videos/:videoId', authMiddleware, requireModuleViewer, requireManage, express.json(), (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      const vid = parseEquipmentId(req.params.videoId);
      if (!id || !vid) return res.status(400).json({ message: 'ID không hợp lệ' });
      const cur = db.prepare('SELECT * FROM equipment_videos WHERE id = ? AND equipment_id = ?').get(vid, id);
      if (!cur) return res.status(404).json({ message: 'Không tìm thấy' });
      const b = req.body || {};
      const title = b.title != null ? String(b.title).trim() : cur.title;
      const video_url = b.video_url != null ? String(b.video_url).trim() : cur.video_url;
      const platform = b.platform && ['youtube', 'drive', 'internal'].includes(String(b.platform)) ? String(b.platform) : cur.platform;
      if (!validateVideoUrl(video_url, platform)) {
        return res.status(400).json({ message: 'URL không khớp nền tảng' });
      }
      const description = b.description !== undefined ? (b.description != null ? String(b.description).slice(0, 4000) : null) : cur.description;
      const access_level =
        b.access_level && ['internal', 'institute', 'public'].includes(String(b.access_level))
          ? String(b.access_level)
          : cur.access_level;
      let thumbnail_url = cur.thumbnail_url;
      if (platform === 'youtube') {
        const yid = extractYoutubeId(video_url);
        thumbnail_url = yid ? `https://img.youtube.com/vi/${yid}/mqdefault.jpg` : null;
      } else if (platform === 'drive') {
        thumbnail_url = null;
      }
      db.prepare(
        `UPDATE equipment_videos SET title=?, video_url=?, platform=?, description=?, access_level=?, thumbnail_url=? WHERE id=?`
      ).run(title, video_url, platform, description, access_level, thumbnail_url, vid);
      const row = db.prepare('SELECT * FROM equipment_videos WHERE id = ?').get(vid);
      res.json({ ok: true, video: row });
    } catch (e) {
      console.error('[equipment video put]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.delete('/:id/videos/:videoId', authMiddleware, requireModuleViewer, requireManage, (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      const vid = parseEquipmentId(req.params.videoId);
      if (!id || !vid) return res.status(400).json({ message: 'ID không hợp lệ' });
      const r = db.prepare('DELETE FROM equipment_videos WHERE id = ? AND equipment_id = ?').run(vid, id);
      if (!r.changes) return res.status(404).json({ message: 'Không tìm thấy' });
      db.prepare(`UPDATE equipments SET updated_at=datetime('now') WHERE id=?`).run(id);
      res.json({ ok: true });
    } catch (e) {
      console.error('[equipment video delete]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  return router;
};
