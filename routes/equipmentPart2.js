/**
 * Equipment module — Prompt 2: stats, bảo trì, sự cố, thông báo, thay thế tài liệu.
 * Gắn vào router TRƯỚC các route GET /:id đơn (chỉ một segment).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const QRCode = require('qrcode');

const PDF_MIME = 'application/pdf';
const UPLOAD_MAX = 20 * 1024 * 1024;
const IMG_MAX = 5 * 1024 * 1024;

function parseEquipmentId(param) {
  const id = parseInt(param, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function parseMaintId(param) {
  return parseEquipmentId(param);
}

function parseIncidentId(param) {
  return parseEquipmentId(param);
}

function canManageEquipment(req) {
  const r = String(req.user && req.user.role ? req.user.role : '').toLowerCase();
  return r === 'admin' || r === 'manager' || r === 'phong_khcn';
}

function isAdmin(req) {
  return String(req.user && req.user.role ? req.user.role : '').toLowerCase() === 'admin';
}

function isResearcher(req) {
  return String(req.user && req.user.role ? req.user.role : '').toLowerCase() === 'researcher';
}

function insertNotification(db, userId, eventType, title, body, link) {
  if (!userId) return;
  try {
    db.prepare(
      `INSERT INTO app_notifications (user_id, module, event_type, title, body, link) VALUES (?,?,?,?,?,?)`
    ).run(userId, 'equipment', String(eventType).slice(0, 80), title, body || null, link || null);
  } catch (e) {
    console.warn('[app_notifications]', e.message);
  }
}

function notifyAdmins(db, eventType, title, body, link) {
  try {
    const rows = db.prepare(`SELECT id FROM users WHERE lower(trim(role)) = 'admin'`).all();
    (rows || []).forEach((r) => insertNotification(db, r.id, eventType, title, body, link));
  } catch (_) {}
}

function notifyUserId(db, uid, eventType, title, body, link) {
  insertNotification(db, uid, eventType, title, body, link);
}

function notifyEquipmentStakeholders(db, eq, eventType, title, body, link) {
  if (eq && eq.manager_id) notifyUserId(db, eq.manager_id, eventType, title, body, link);
  if (eq && eq.created_by && eq.created_by !== eq.manager_id) {
    notifyUserId(db, eq.created_by, eventType, title, body, link);
  }
}

function notifyDeptManagers(db, departmentId, eventType, title, body, link) {
  if (departmentId == null || String(departmentId).trim() === '') return;
  try {
    const rows = db
      .prepare(
        `SELECT id FROM users WHERE department_id = ? AND lower(trim(role)) IN ('manager','phong_khcn','admin')`
      )
      .all(String(departmentId));
    const seen = new Set();
    (rows || []).forEach((r) => {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        insertNotification(db, r.id, eventType, title, body, link);
      }
    });
  } catch (_) {}
}

function notifyEquipmentModuleAccessUsers(db, eventType, title, body, link) {
  try {
    const rows = db.prepare(`SELECT user_id FROM equipment_module_user_access`).all();
    const seen = new Set();
    (rows || []).forEach((r) => {
      const uid = r && r.user_id;
      if (!uid || seen.has(uid)) return;
      seen.add(uid);
      insertNotification(db, uid, eventType, title, body, link);
    });
  } catch (_) {}
}

function equipmentClientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  if (xf) return xf.slice(0, 80);
  return String(req.ip || (req.connection && req.connection.remoteAddress) || 'unknown').slice(0, 80);
}

const publicIncidentBuckets = new Map();
function allowPublicIncidentPost(ip) {
  const max = 10;
  const windowMs = 60 * 60 * 1000;
  const now = Date.now();
  const k = ip || 'unknown';
  let b = publicIncidentBuckets.get(k);
  if (!b || b.resetAt < now) {
    b = { n: 0, resetAt: now + windowMs };
    publicIncidentBuckets.set(k, b);
  }
  if (b.n >= max) return false;
  b.n += 1;
  return true;
}

function daysUntilIsoDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const m = dateStr.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m)) return null;
  const t = new Date(m + 'T12:00:00').getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
}

function maintenanceBadgeForRow(eq) {
  const candidates = [eq.next_maintenance_date, eq.calibration_due_date].filter(Boolean);
  let minDays = null;
  for (const d of candidates) {
    const du = daysUntilIsoDate(d);
    if (du == null) continue;
    if (minDays == null || du < minDays) minDays = du;
  }
  if (minDays == null) return null;
  if (minDays < 0) return { kind: 'overdue', label: 'Quá hạn bảo trì' };
  if (minDays <= 30) return { kind: 'due_soon', label: 'Sắp đến hạn' };
  return null;
}

function generateEquipmentCode(db, deptCode, year) {
  const dc = String(deptCode || 'SCI')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 16) || 'SCI';
  const y = Number.isFinite(year) ? year : new Date().getFullYear();
  const prefix = `${dc}-${y}-`;
  const row = db.prepare(`SELECT equipment_code FROM equipments WHERE equipment_code LIKE ? ORDER BY equipment_code DESC LIMIT 1`).get(`${prefix}%`);
  let n = 1;
  if (row && row.equipment_code && String(row.equipment_code).startsWith(prefix)) {
    const tail = String(row.equipment_code).slice(prefix.length);
    const num = parseInt(tail, 10);
    if (Number.isFinite(num)) n = num + 1;
  }
  return prefix + String(n).padStart(4, '0');
}

function extractYoutubeId(url) {
  const u = String(url || '');
  const m = u.match(/(?:youtu\.be\/|v=|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{6,})/);
  return m ? m[1] : null;
}

function detectPlatformFromUrl(url) {
  const s = String(url || '').toLowerCase();
  if (/youtu\.be|youtube\.com/.test(s)) return 'youtube';
  if (/drive\.google\.com/.test(s)) return 'drive';
  return 'internal';
}

function registerEquipmentPart2(router, deps) {
  const {
    db,
    authMiddleware,
    adminOnly,
    optionalAuth,
    uploadsEquipmentRoot,
    uploadsRootResolved,
    canViewEquipmentDetail,
    checkEquipmentDocAccess,
    publicProfileUrl,
    filterDocumentsForRequest,
    filterVideosForRequest,
    requireModuleViewer,
    equipmentMailSend,
    publicIncidentAllowedForEquipment,
    incidentEmailsNew,
    incidentEmailsResolved,
  } = deps;
  const moduleViewerMw = requireModuleViewer || ((req, res, next) => next());
  const mailSend = typeof equipmentMailSend === 'function' ? equipmentMailSend : null;
  const emailsNewFn = typeof incidentEmailsNew === 'function' ? incidentEmailsNew : () => [];
  const emailsResolvedFn = typeof incidentEmailsResolved === 'function' ? incidentEmailsResolved : () => [];
  const publicGateFn = typeof publicIncidentAllowedForEquipment === 'function' ? publicIncidentAllowedForEquipment : () => false;

  function canManageEquipmentIncidents(req) {
    if (canManageEquipment(req)) return true;
    if (!req || !req.user || !req.user.id) return false;
    try {
      const row = db
        .prepare(`SELECT module_role FROM equipment_module_user_access WHERE user_id = ?`)
        .get(req.user.id);
      if (!row) return false;
      const moduleRole = String(row.module_role || '').trim().toLowerCase();
      return moduleRole === 'manager' || moduleRole === 'editor' || moduleRole === 'admin';
    } catch (_) {
      return false;
    }
  }

  const storageReplace = multer.diskStorage({
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
      cb(null, `r_${ts}_${base}`);
    },
  });

  const uploadPdfReplace = multer({
    storage: storageReplace,
    limits: { fileSize: UPLOAD_MAX },
    fileFilter: (req, file, cb) => {
      if (file.mimetype !== PDF_MIME) return cb(new Error('Chỉ chấp nhận PDF'));
      cb(null, true);
    },
  });

  const incidentStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const eqId = parseEquipmentId(req.params.id);
      if (!eqId) return cb(new Error('invalid_equipment'));
      const tmp = path.join(uploadsEquipmentRoot, String(eqId), 'incidents', '_tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      fs.mkdirSync(tmp, { recursive: true });
      cb(null, tmp);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '_' + String(file.originalname || 'img').replace(/[^\w.-]/g, '_'));
    },
  });

  const incidentUpload = multer({
    storage: incidentStorage,
    limits: { fileSize: IMG_MAX, files: 5 },
    fileFilter: (req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
      cb(ok ? null : new Error('Chỉ JPG/PNG/WebP'), ok);
    },
  });

  const resolutionStorage = multer.diskStorage({
    destination: (req, file, cb) => {
      const eqId = parseEquipmentId(req.params.id);
      const incId = parseIncidentId(req.params.incidentId);
      if (!eqId || !incId) return cb(new Error('invalid_ids'));
      const dir = path.join(uploadsEquipmentRoot, String(eqId), 'incidents', String(incId), 'resolution');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      cb(null, Date.now() + '_' + String(file.originalname || 'file').replace(/[^\w.-]/g, '_'));
    },
  });
  const resolutionUpload = multer({
    storage: resolutionStorage,
    limits: { fileSize: 12 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
      const ok = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype);
      cb(ok ? null : new Error('Chỉ JPG/PNG/WebP/PDF'), ok);
    },
  });

  function resolveBodyMiddleware(req, res, next) {
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('multipart/form-data')) {
      return resolutionUpload.array('resolution_files', 10)(req, res, (err) => {
        if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
        next();
      });
    }
    return express.json()(req, res, next);
  }

  /** Danh mục phòng / lab */
  router.get('/departments', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const rows = db
        .prepare('SELECT id, code, name, sort_order FROM equipment_departments ORDER BY sort_order ASC, name ASC')
        .all();
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** User cho dropdown cán bộ phụ trách */
  router.get('/users-options', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const rows = db
        .prepare(
          `SELECT id, email, fullname, role, department_id FROM users
           WHERE COALESCE(is_banned,0)=0 AND (password IS NOT NULL AND trim(password) != '')
           ORDER BY fullname COLLATE NOCASE
           LIMIT 500`
        )
        .all();
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Sinh mã thiết bị: [MÃ_PHÒNG]-[NĂM]-[NNNN] */
  router.get('/next-code', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const dept = String(req.query.department_code || req.query.dept || '').trim().toUpperCase().slice(0, 16);
      const year = parseInt(req.query.year || new Date().getFullYear(), 10);
      if (!dept || !Number.isFinite(year)) {
        return res.status(400).json({ message: 'Thiếu department_code hoặc year' });
      }
      const prefix = `${dept}-${year}-`;
      const row = db
        .prepare(`SELECT equipment_code FROM equipments WHERE equipment_code LIKE ? ORDER BY equipment_code DESC LIMIT 1`)
        .get(prefix + '%');
      let n = 1;
      if (row && row.equipment_code && String(row.equipment_code).startsWith(prefix)) {
        const tail = String(row.equipment_code).slice(prefix.length);
        const num = parseInt(tail, 10);
        if (Number.isFinite(num)) n = num + 1;
      }
      const code = prefix + String(n).padStart(4, '0');
      res.json({ ok: true, equipment_code: code });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  function equipmentDetailLink(eqId) {
    const base = (process.env.BASE_URL || '').replace(/\/$/, '');
    return `${base || ''}/public/equipment/detail.html?id=${eqId}`;
  }

  function sendNewIncidentEmail(eq, incId, payload) {
    const to = emailsNewFn();
    if (!mailSend || !to.length) return Promise.resolve();
    const p = payload && typeof payload === 'object' ? payload : { description: payload };
    const snippet = String(p.description || '').trim().slice(0, 1200);
    const sev = String(p.severity || '').toLowerCase();
    const sevLabel =
      { low: 'Nhẹ', medium: 'Trung bình', high: 'Nghiêm trọng', critical: 'Khẩn cấp' }[sev] || (p.severity ? String(p.severity) : 'Không xác định');
    const reporter = p.reporterDisplay ? String(p.reporterDisplay) : p.source === 'public' ? 'Người dùng ẩn danh (QR công khai)' : 'Người dùng hệ thống';
    const reporterEmail = p.reporterEmail ? String(p.reporterEmail) : 'Không cung cấp';
    const reporterPhone = p.reporterPhone ? String(p.reporterPhone) : 'Không cung cấp';
    const detailUrl = equipmentDetailLink(eq.id);
    const imageUrls = Array.isArray(p.imagePaths)
      ? p.imagePaths
          .filter(Boolean)
          .map((x) => String(x).replace(/\\/g, '/'))
          .map((x) => (x.startsWith('http://') || x.startsWith('https://') ? x : `${(process.env.BASE_URL || '').replace(/\/$/, '')}/uploads/${x}`))
      : [];
    const esc = (s) =>
      String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
    const subj = `[STIMS Thiết bị] Báo cáo sự cố mới — ${eq.equipment_code} (#${incId})`;
    const text =
      `Kính gửi Phòng Quản trị thiết bị và cơ sở vật chất,\n\n` +
      `Hệ thống STIMS thông báo có báo cáo sự cố thiết bị mới như sau:\n` +
      `- Thiết bị: ${eq.name} (${eq.equipment_code})\n` +
      `- ID sự cố: #${incId}\n` +
      `- Mức độ: ${sevLabel}\n` +
      `- Người báo cáo: ${reporter}\n` +
      `- Email liên hệ: ${reporterEmail}\n` +
      `- Số điện thoại: ${reporterPhone}\n\n` +
      `Nội dung sự cố:\n${snippet || '(Không có mô tả)'}\n\n` +
      (imageUrls.length
        ? `Hình ảnh đính kèm:\n${imageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n\n`
        : '') +
      `Vui lòng truy cập liên kết sau để xem chi tiết và xử lý:\n${detailUrl}\n\n` +
      `Trân trọng,\nHệ thống STIMS`;
    const html =
      `<p>Kính gửi <strong>Phòng Quản trị thiết bị và cơ sở vật chất</strong>,</p>` +
      `<p>Hệ thống STIMS thông báo có <strong>báo cáo sự cố thiết bị mới</strong> như sau:</p>` +
      `<ul>` +
      `<li><strong>Thiết bị:</strong> ${esc(eq.name)} — <code>${esc(eq.equipment_code)}</code></li>` +
      `<li><strong>ID sự cố:</strong> #${esc(incId)}</li>` +
      `<li><strong>Mức độ:</strong> ${esc(sevLabel)}</li>` +
      `<li><strong>Người báo cáo:</strong> ${esc(reporter)}</li>` +
      `<li><strong>Email liên hệ:</strong> ${esc(reporterEmail)}</li>` +
      `<li><strong>Số điện thoại:</strong> ${esc(reporterPhone)}</li>` +
      `</ul>` +
      `<p><strong>Nội dung sự cố:</strong></p>` +
      `<div style="white-space:pre-wrap;border:1px solid #e5e7eb;padding:10px;border-radius:8px;background:#f8fafc;">${esc(
        snippet || '(Không có mô tả)'
      )}</div>` +
      (imageUrls.length
        ? `<p><strong>Hình ảnh đính kèm:</strong></p><ol>${imageUrls
            .map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></li>`)
            .join('')}</ol>`
        : '') +
      `<p>Vui lòng truy cập liên kết sau để xem chi tiết và xử lý:</p>` +
      `<p><a href="${esc(detailUrl)}">Mở trang thiết bị</a></p>` +
      `<p>Trân trọng,<br/>Hệ thống STIMS</p>`;
    return mailSend({ to, subject: subj, text, html });
  }

  function sendResolvedIncidentEmail(eq, incId, payload) {
    const merged = [...emailsResolvedFn(), ...emailsNewFn()];
    const to = Array.from(new Set(merged.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean)));
    if (!mailSend) return Promise.resolve({ ok: false, reason: 'mail_not_configured' });
    if (!to.length) return Promise.resolve({ ok: false, reason: 'no_recipients' });
    console.log('[EQUIP resolved-mail] recipients=', to.join(', '), 'incident=#' + incId);
    const p = payload && typeof payload === 'object' ? payload : { resolution_note: payload };
    const sn = String(p.resolution_note || '').trim().slice(0, 2000);
    const resolver = p.resolved_by ? String(p.resolved_by) : 'Không xác định';
    const resolvedAt = p.resolved_at ? String(p.resolved_at) : 'Vừa cập nhật';
    const detailUrl = equipmentDetailLink(eq.id);
    const attachmentUrls = Array.isArray(p.resolution_attachment_paths)
      ? p.resolution_attachment_paths
          .filter(Boolean)
          .map((x) => String(x).replace(/\\/g, '/'))
          .map((x) => (x.startsWith('http://') || x.startsWith('https://') ? x : `${(process.env.BASE_URL || '').replace(/\/$/, '')}/uploads/${x}`))
      : [];
    const esc = (s) =>
      String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
    const subj = `[STIMS Thiết bị] Thông báo đã xử lý sự cố — ${eq.equipment_code} (#${incId})`;
    const text =
      `Kính gửi Phòng Quản trị thiết bị và cơ sở vật chất,\n\n` +
      `Hệ thống STIMS thông báo sự cố thiết bị đã được xử lý, thông tin như sau:\n` +
      `- Thiết bị: ${eq.name} (${eq.equipment_code})\n` +
      `- ID sự cố: #${incId}\n` +
      `- Kết quả: Đã xử lý\n` +
      `- Người xử lý: ${resolver}\n` +
      `- Thời điểm hoàn tất: ${resolvedAt}\n\n` +
      `Nội dung xử lý:\n${sn || '(Không có ghi chú xử lý)'}\n\n` +
      `Thông tin bổ sung:\n` +
      `- Chi phí: ${p.cost != null && p.cost !== '' ? String(p.cost) : 'Không cập nhật'}\n` +
      `- Loại sửa: ${p.repair_type ? String(p.repair_type) : 'Không cập nhật'}\n` +
      `- Nhà thầu / công ty: ${p.vendor_note ? String(p.vendor_note) : 'Không cập nhật'}\n` +
      `- Hóa đơn / chứng từ: ${p.invoice_ref ? String(p.invoice_ref) : 'Không cập nhật'}\n` +
      `- Tờ trình / đề xuất: ${p.proposal_ref ? String(p.proposal_ref) : 'Không cập nhật'}\n\n` +
      (attachmentUrls.length
        ? `Đính kèm xử lý:\n${attachmentUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n\n`
        : '') +
      `Vui lòng truy cập liên kết sau để xem chi tiết hồ sơ thiết bị:\n${detailUrl}\n\n` +
      `Trân trọng,\nHệ thống STIMS`;
    const html =
      `<p>Kính gửi <strong>Phòng Quản trị thiết bị và cơ sở vật chất</strong>,</p>` +
      `<p>Hệ thống STIMS thông báo <strong>sự cố thiết bị đã được xử lý</strong>, thông tin như sau:</p>` +
      `<ul>` +
      `<li><strong>Thiết bị:</strong> ${esc(eq.name)} — <code>${esc(eq.equipment_code)}</code></li>` +
      `<li><strong>ID sự cố:</strong> #${esc(incId)}</li>` +
      `<li><strong>Kết quả:</strong> Đã xử lý</li>` +
      `<li><strong>Người xử lý:</strong> ${esc(resolver)}</li>` +
      `<li><strong>Thời điểm hoàn tất:</strong> ${esc(resolvedAt)}</li>` +
      `</ul>` +
      `<p><strong>Nội dung xử lý:</strong></p>` +
      `<div style="white-space:pre-wrap;border:1px solid #e5e7eb;padding:10px;border-radius:8px;background:#f8fafc;">${esc(
        sn || '(Không có ghi chú xử lý)'
      )}</div>` +
      `<p><strong>Thông tin bổ sung:</strong></p>` +
      `<ul>` +
      `<li><strong>Chi phí:</strong> ${esc(p.cost != null && p.cost !== '' ? String(p.cost) : 'Không cập nhật')}</li>` +
      `<li><strong>Loại sửa:</strong> ${esc(p.repair_type || 'Không cập nhật')}</li>` +
      `<li><strong>Nhà thầu / công ty:</strong> ${esc(p.vendor_note || 'Không cập nhật')}</li>` +
      `<li><strong>Hóa đơn / chứng từ:</strong> ${esc(p.invoice_ref || 'Không cập nhật')}</li>` +
      `<li><strong>Tờ trình / đề xuất:</strong> ${esc(p.proposal_ref || 'Không cập nhật')}</li>` +
      `</ul>` +
      (attachmentUrls.length
        ? `<p><strong>Đính kèm xử lý:</strong></p><ol>${attachmentUrls
            .map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a></li>`)
            .join('')}</ol>`
        : '') +
      `<p>Vui lòng truy cập liên kết sau để xem chi tiết hồ sơ thiết bị:</p>` +
      `<p><a href="${esc(detailUrl)}">Mở trang thiết bị</a></p>` +
      `<p>Trân trọng,<br/>Hệ thống STIMS</p>`;
    return Promise.resolve(mailSend({ to, subject: subj, text, html }))
      .then((r) => (r && typeof r === 'object' ? r : { ok: true }))
      .catch((e) => ({ ok: false, reason: 'send_failed', error: e && e.message ? e.message : 'send_failed' }));
  }

  router.post('/:id/public-incidents', (req, res) => {
    incidentUpload.array('photos', 5)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || 'Lỗi upload ảnh' });
      }
      try {
        const ip = equipmentClientIp(req);
        if (!allowPublicIncidentPost(ip)) {
          return res.status(429).json({ message: 'Quá nhiều báo cáo từ địa chỉ này. Thử lại sau một giờ.' });
        }
        const honeypot = String((req.body && req.body.website) || '').trim();
        if (honeypot) {
          return res.status(400).json({ message: 'Từ chối' });
        }
        const eqId = parseEquipmentId(req.params.id);
        if (!eqId) return res.status(400).json({ message: 'ID không hợp lệ' });
        const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(eqId);
        if (!eq || !publicGateFn(eq, eqId)) {
          return res.status(404).json({ message: 'Không thể gửi báo cáo cho hồ sơ này' });
        }
        const description = String((req.body && req.body.description) || '').trim();
        const severity = String((req.body && req.body.severity) || '').trim().toLowerCase();
        const extra = req.body && req.body.extra_note != null ? String(req.body.extra_note).slice(0, 2000) : null;
        const reporter_display = String((req.body && req.body.reporter_name) || '').trim().slice(0, 120) || null;
        const reporter_email = String((req.body && req.body.reporter_email) || '').trim().slice(0, 120) || null;
        const reporter_phone = String((req.body && req.body.reporter_phone) || '').trim().slice(0, 64) || null;
        if (!description) return res.status(400).json({ message: 'Thiếu mô tả sự cố' });
        if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
          return res.status(400).json({ message: 'Mức độ không hợp lệ' });
        }
        const ins = db
          .prepare(
            `INSERT INTO equipment_incidents (
              equipment_id, reported_by, description, severity, status, photo_paths,
              reporter_display, reporter_email, reporter_phone, reporter_ip, incident_source
            ) VALUES (?, NULL, ?, ?, 'reported', ?, ?, ?, ?, ?, 'public')`
          )
          .run(
            eqId,
            description + (extra ? '\n' + extra : ''),
            severity,
            '[]',
            reporter_display,
            reporter_email,
            reporter_phone,
            ip
          );
        const incId = ins.lastInsertRowid;

        let tmpDir = null;
        if (req.files && req.files.length) {
          tmpDir = path.dirname(req.files[0].path);
        }
        const finalDir = path.join(uploadsEquipmentRoot, String(eqId), 'incidents', String(incId));
        const relPaths = [];
        if (tmpDir && fs.existsSync(tmpDir)) {
          fs.mkdirSync(path.dirname(finalDir), { recursive: true });
          try {
            fs.renameSync(tmpDir, finalDir);
          } catch (e) {
            fs.cpSync(tmpDir, finalDir, { recursive: true });
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
          for (const f of req.files || []) {
            const base = path.basename(f.path);
            const rel = path.join('equipment', String(eqId), 'incidents', String(incId), base).replace(/\\/g, '/');
            relPaths.push(rel);
          }
        }
        db.prepare(`UPDATE equipment_incidents SET photo_paths = ? WHERE id = ?`).run(JSON.stringify(relPaths), incId);

        if (severity === 'high' || severity === 'critical') {
          if (eq.status !== 'broken') {
            db.prepare(`UPDATE equipments SET status = 'broken', updated_at = datetime('now') WHERE id = ?`).run(eqId);
            db.prepare(
              `INSERT INTO equipment_status_logs (equipment_id, old_status, new_status, changed_by, note) VALUES (?,?,?,?,?)`
            ).run(eqId, eq.status, 'broken', null, 'Tự động: sự cố mức cao (báo QR)');
          }
        }

        notifyAdmins(
          db,
          'equip_incident',
          'Báo cáo sự cố thiết bị (QR)',
          `${eq.equipment_code} — #${incId} — ${description.slice(0, 120)}`,
          `/public/equipment/detail.html?id=${eqId}`
        );
        notifyDeptManagers(
          db,
          eq.department_id,
          'equip_incident',
          'Sự cố thiết bị (phòng bạn)',
          eq.equipment_code,
          `/public/equipment/detail.html?id=${eqId}`
        );
        notifyEquipmentModuleAccessUsers(
          db,
          'equip_incident',
          'Sự cố thiết bị (module)',
          `${eq.equipment_code} — #${incId} — ${description.slice(0, 120)}`,
          `/public/equipment/detail.html?id=${eqId}`
        );
        sendNewIncidentEmail(eq, incId, {
          description,
          severity,
          reporterDisplay: reporter_display,
          reporterEmail: reporter_email,
          reporterPhone: reporter_phone,
          source: 'public',
          imagePaths: relPaths,
        }).catch(() => {});

        res.status(201).json({ ok: true, id: incId });
      } catch (e) {
        console.error('[public incident create]', e);
        res.status(500).json({ message: e.message || 'Lỗi' });
      }
    });
  });

  router.get('/notifications', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
      const rows = db
        .prepare(
          `SELECT id, event_type, title, body, link, read_at, created_at FROM app_notifications
           WHERE user_id = ? AND module = 'equipment' ORDER BY id DESC LIMIT ?`
        )
        .all(req.user.id, limit);
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.patch('/notifications/:nid/read', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const nid = parseInt(req.params.nid, 10);
      if (!Number.isFinite(nid)) return res.status(400).json({ message: 'ID không hợp lệ' });
      db.prepare(
        `UPDATE app_notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND module = 'equipment'`
      ).run(nid, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/stats/summary', authMiddleware, moduleViewerMw, (req, res) => {
    if (!canManageEquipment(req)) {
      return res.status(403).json({ message: 'Không có quyền xem thống kê' });
    }
    try {
      const total = db.prepare(`SELECT COUNT(*) AS c FROM equipments WHERE status != 'retired'`).get().c;
      const byStatus = db
        .prepare(`SELECT status, COUNT(*) AS c FROM equipments GROUP BY status`)
        .all();
      const byDept = db
        .prepare(
          `SELECT COALESCE(department_id,'(Không gán)') AS department_id, COUNT(*) AS c FROM equipments WHERE status != 'retired' GROUP BY department_id`
        )
        .all();
      res.json({ ok: true, total, byStatus, byDept });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/stats/upcoming-maintenance', authMiddleware, moduleViewerMw, (req, res) => {
    if (!canManageEquipment(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    try {
      const rows = db
        .prepare(
          `SELECT id, equipment_code, name, department_id, next_maintenance_date, calibration_due_date, status
           FROM equipments WHERE status NOT IN ('retired')`
        )
        .all();
      const now = Date.now();
      const msDay = 86400000;
      const out = [];
      for (const r of rows) {
        for (const fld of ['next_maintenance_date', 'calibration_due_date']) {
          const d = r[fld];
          if (!d || typeof d !== 'string') continue;
          const m = d.slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(m)) continue;
          const t = new Date(m + 'T12:00:00').getTime();
          if (Number.isNaN(t)) continue;
          const du = Math.round((t - now) / msDay);
          if (du >= 0 && du <= days) {
            out.push({ ...r, _field: fld, _due: m, _daysLeft: du });
            break;
          }
        }
      }
      out.sort((a, b) => (a._daysLeft !== b._daysLeft ? a._daysLeft - b._daysLeft : a.id - b.id));
      res.json({ ok: true, data: out });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/stats/open-incidents', authMiddleware, moduleViewerMw, (req, res) => {
    if (!canManageEquipment(req)) {
      return res.status(403).json({ message: 'Không có quyền' });
    }
    try {
      const rows = db
        .prepare(
          `SELECT i.id, i.equipment_id, i.status, i.severity, i.report_date, e.equipment_code, e.name
           FROM equipment_incidents i
           JOIN equipments e ON e.id = i.equipment_id
           WHERE i.status NOT IN ('resolved','closed')
           ORDER BY i.id DESC
           LIMIT 200`
        )
        .all();
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/stats/export', authMiddleware, moduleViewerMw, async (req, res) => {
    if (!canManageEquipment(req)) {
      return res.status(403).json({ message: 'Không có quyền xuất' });
    }
    try {
      const ExcelJS = require('exceljs');
      const rows = db
        .prepare(
          `SELECT e.equipment_code, e.name, e.asset_group, e.model, e.serial_number, e.department_id, e.manager_id, e.purchase_year, e.purchase_value, e.status, e.next_maintenance_date,
                  e.asset_type_code, e.year_in_use, e.unit_name, e.quantity_book, e.quantity_actual, e.quantity_diff,
                  e.remaining_value, e.utilization_note, e.condition_note, e.disaster_impact_note, e.construction_asset_note,
                  e.usage_count_note, e.land_attached_note, e.asset_note,
                  u.fullname AS manager_name
           FROM equipments e LEFT JOIN users u ON u.id = e.manager_id
           ORDER BY e.id ASC`
        )
        .all();
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Thiet_bi');
      ws.addRow([
        'Mã',
        'Tên',
        'Loại',
        'Model',
        'Serial',
        'Phòng',
        'Cán bộ',
        'Năm mua',
        'Giá trị',
        'Trạng thái',
        'Hạn bảo trì',
        'Mã loại tài sản',
        'Năm đưa vào sử dụng',
        'Đơn vị tính',
        'Theo sổ kế toán',
        'Theo thực tế kiểm kê',
        'Chênh lệch',
        'GTCL',
        'Tình hình khai thác sử dụng',
        'Tình trạng tài sản',
        'Ảnh hưởng thiên tai',
        'Tài sản công trình',
        'Số lần',
        'TS gắn liền với đất',
        'Ghi chú',
      ]);
      for (const r of rows) {
        ws.addRow([
          r.equipment_code,
          r.name,
          r.asset_group,
          r.model,
          r.serial_number,
          r.department_id,
          r.manager_name,
          r.purchase_year,
          r.purchase_value,
          r.status,
          r.next_maintenance_date,
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
        ]);
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="equipment-export.xlsx"');
      await wb.xlsx.write(res);
      res.end();
    } catch (e) {
      console.error('[equipment export]', e);
      if (!res.headersSent) res.status(500).json({ message: e.message || 'Lỗi xuất Excel' });
    }
  });

  router.get('/:id/qr-data', optionalAuth, async (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const row = db.prepare('SELECT id FROM equipments WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ message: 'Không tìm thấy' });
      const url = publicProfileUrl(req, id);
      const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 });
      res.json({ ok: true, dataUrl, url });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Bảo trì */
  router.get('/:id/maintenance', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      const chk = canViewEquipmentDetail(req, eq, db);
      if (!chk.ok) return res.status(chk.status).json({ message: 'Không có quyền' });
      const rows = db
        .prepare(
          `SELECT m.*, u.fullname AS performed_by_name FROM equipment_maintenance m
           LEFT JOIN users u ON u.id = m.performed_by
           WHERE m.equipment_id = ? ORDER BY m.id DESC`
        )
        .all(id);
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.post('/:id/maintenance', authMiddleware, moduleViewerMw, express.json(), (req, res) => {
    if (!canManageEquipment(req)) return res.status(403).json({ message: 'Không có quyền' });
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      if (!eq) return res.status(404).json({ message: 'Không tìm thấy' });
      const b = req.body || {};
      const maintenance_type = String(b.maintenance_type || '').trim();
      if (!['periodic', 'calibration', 'repair'].includes(maintenance_type)) {
        return res.status(400).json({ message: 'Loại bảo trì không hợp lệ' });
      }
      const scheduled_date = b.scheduled_date != null ? String(b.scheduled_date).slice(0, 10) : null;
      const result_note = b.result_note != null ? String(b.result_note).slice(0, 4000) : null;
      const ins = db
        .prepare(
          `INSERT INTO equipment_maintenance (equipment_id, maintenance_type, scheduled_date, result_note, performed_by)
           VALUES (?,?,?,?,?)`
        )
        .run(id, maintenance_type, scheduled_date, result_note, req.user.id);
      db.prepare(`UPDATE equipments SET updated_at = datetime('now') WHERE id = ?`).run(id);
      if (maintenance_type === 'periodic' && scheduled_date) {
        db.prepare(`UPDATE equipments SET next_maintenance_date = ? WHERE id = ?`).run(scheduled_date, id);
      }
      if (maintenance_type === 'calibration' && scheduled_date) {
        db.prepare(`UPDATE equipments SET calibration_due_date = ? WHERE id = ?`).run(scheduled_date, id);
      }
      notifyEquipmentStakeholders(
        db,
        eq,
        'equip_maint_scheduled',
        'Lịch bảo trì / kiểm định',
        maintenance_type + ' — ' + (scheduled_date || ''),
        `/public/equipment/detail.html?id=${id}`
      );
      res.status(201).json({ ok: true, id: ins.lastInsertRowid });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.put('/:id/maintenance/:maintenanceId', authMiddleware, moduleViewerMw, express.json(), (req, res) => {
    if (!canManageEquipment(req)) return res.status(403).json({ message: 'Không có quyền' });
    try {
      const eqId = parseEquipmentId(req.params.id);
      const mid = parseMaintId(req.params.maintenanceId);
      if (!eqId || !mid) return res.status(400).json({ message: 'ID không hợp lệ' });
      const m = db.prepare('SELECT * FROM equipment_maintenance WHERE id = ? AND equipment_id = ?').get(mid, eqId);
      if (!m) return res.status(404).json({ message: 'Không tìm thấy' });
      const b = req.body || {};
      const completed_date = b.completed_date != null ? String(b.completed_date).slice(0, 10) : null;
      const result_note = b.result_note != null ? String(b.result_note).slice(0, 4000) : m.result_note;
      const cost = b.cost != null ? Number(b.cost) : m.cost;
      const next_due_date = b.next_due_date != null ? String(b.next_due_date).slice(0, 10) : null;
      const performed_by = b.performed_by != null ? parseInt(b.performed_by, 10) : req.user.id;
      db.prepare(
        `UPDATE equipment_maintenance SET completed_date = ?, result_note = ?, cost = ?, next_due_date = ?, performed_by = ? WHERE id = ?`
      ).run(completed_date, result_note, cost, next_due_date, Number.isFinite(performed_by) ? performed_by : req.user.id, mid);
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(eqId);
      if (completed_date) {
        db.prepare(`UPDATE equipments SET last_maintenance_date = ?, updated_at = datetime('now') WHERE id = ?`).run(completed_date, eqId);
      }
      if (next_due_date) {
        if (m.maintenance_type === 'periodic') {
          db.prepare(`UPDATE equipments SET next_maintenance_date = ? WHERE id = ?`).run(next_due_date, eqId);
        }
        if (m.maintenance_type === 'calibration') {
          db.prepare(`UPDATE equipments SET calibration_due_date = ? WHERE id = ?`).run(next_due_date, eqId);
        }
      }
      if (eq && eq.status === 'maintenance' && completed_date) {
        db.prepare(`UPDATE equipments SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(eqId);
        db.prepare(
          `INSERT INTO equipment_status_logs (equipment_id, old_status, new_status, changed_by, note) VALUES (?,?,?,?,?)`
        ).run(eqId, 'maintenance', 'active', req.user.id, 'Hoàn thành bảo trì');
      }
      const eq2 = db.prepare('SELECT * FROM equipments WHERE id = ?').get(eqId);
      notifyEquipmentStakeholders(
        db,
        eq2,
        'equip_maint_done',
        'Đã ghi nhận hoàn thành bảo trì',
        eq2.equipment_code,
        `/public/equipment/detail.html?id=${eqId}`
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Sự cố */
  router.get('/:id/incidents', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const id = parseEquipmentId(req.params.id);
      if (!id) return res.status(400).json({ message: 'ID không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
      const chk = canViewEquipmentDetail(req, eq, db);
      if (!chk.ok) return res.status(chk.status).json({ message: 'Không có quyền' });
      const st = req.query.status ? String(req.query.status).trim() : '';
      let sql =
        `SELECT i.*,
          COALESCE(NULLIF(TRIM(i.reporter_display), ''), rb.fullname,
            CASE WHEN IFNULL(i.incident_source, 'user') = 'public' THEN 'Ẩn danh (QR)' ELSE NULL END
          ) AS reported_by_name,
          asg.fullname AS assigned_to_name
         FROM equipment_incidents i
         LEFT JOIN users rb ON rb.id = i.reported_by
         LEFT JOIN users asg ON asg.id = i.assigned_to
         WHERE i.equipment_id = ?`;
      const params = [id];
      if (st && ['reported', 'assigned', 'in_progress', 'resolved', 'closed'].includes(st)) {
        sql += ' AND i.status = ?';
        params.push(st);
      }
      sql += ' ORDER BY i.id DESC';
      const rows = db.prepare(sql).all(...params);
      res.json({ ok: true, data: rows });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.post('/:id/incidents', authMiddleware, moduleViewerMw, (req, res) => {
    incidentUpload.array('photos', 5)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: err.message || 'Lỗi upload ảnh' });
      }
      try {
        const eqId = parseEquipmentId(req.params.id);
        if (!eqId) return res.status(400).json({ message: 'ID không hợp lệ' });
        const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(eqId);
        const chk = canViewEquipmentDetail(req, eq, db);
        if (!chk.ok) return res.status(chk.status).json({ message: 'Không có quyền' });
        const description = String((req.body && req.body.description) || '').trim();
        const severity = String((req.body && req.body.severity) || '').trim().toLowerCase();
        const extra = req.body && req.body.extra_note != null ? String(req.body.extra_note).slice(0, 2000) : null;
        if (!description) return res.status(400).json({ message: 'Thiếu mô tả sự cố' });
        if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
          return res.status(400).json({ message: 'Mức độ không hợp lệ' });
        }
        const ins = db
          .prepare(
            `INSERT INTO equipment_incidents (equipment_id, reported_by, description, severity, status, photo_paths, incident_source)
             VALUES (?,?,?,?, 'reported', ?, 'user')`
          )
          .run(eqId, req.user.id, description + (extra ? '\n' + extra : ''), severity, '[]');
        const incId = ins.lastInsertRowid;

        let tmpDir = null;
        if (req.files && req.files.length) {
          tmpDir = path.dirname(req.files[0].path);
        }
        const finalDir = path.join(uploadsEquipmentRoot, String(eqId), 'incidents', String(incId));
        const relPaths = [];
        if (tmpDir && fs.existsSync(tmpDir)) {
          fs.mkdirSync(path.dirname(finalDir), { recursive: true });
          try {
            fs.renameSync(tmpDir, finalDir);
          } catch (e) {
            fs.cpSync(tmpDir, finalDir, { recursive: true });
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
          for (const f of req.files || []) {
            const base = path.basename(f.path);
            const rel = path.join('equipment', String(eqId), 'incidents', String(incId), base).replace(/\\/g, '/');
            relPaths.push(rel);
          }
        }
        db.prepare(`UPDATE equipment_incidents SET photo_paths = ? WHERE id = ?`).run(JSON.stringify(relPaths), incId);

        if (severity === 'high' || severity === 'critical') {
          if (eq.status !== 'broken') {
            db.prepare(`UPDATE equipments SET status = 'broken', updated_at = datetime('now') WHERE id = ?`).run(eqId);
            db.prepare(
              `INSERT INTO equipment_status_logs (equipment_id, old_status, new_status, changed_by, note) VALUES (?,?,?,?,?)`
            ).run(eqId, eq.status, 'broken', req.user.id, 'Tự động: sự cố mức cao');
          }
        }

        notifyAdmins(
          db,
          'equip_incident',
          'Báo cáo sự cố thiết bị',
          `${eq.equipment_code} — #${incId} — ${description.slice(0, 120)}`,
          `/public/equipment/detail.html?id=${eqId}`
        );
        notifyDeptManagers(
          db,
          eq.department_id,
          'equip_incident',
          'Sự cố thiết bị (phòng bạn)',
          eq.equipment_code,
          `/public/equipment/detail.html?id=${eqId}`
        );
        notifyEquipmentModuleAccessUsers(
          db,
          'equip_incident',
          'Sự cố thiết bị (module)',
          `${eq.equipment_code} — #${incId} — ${description.slice(0, 120)}`,
          `/public/equipment/detail.html?id=${eqId}`
        );
        sendNewIncidentEmail(eq, incId, {
          description,
          severity,
          reporterDisplay: req.user && req.user.fullname ? req.user.fullname : null,
          reporterEmail: req.user && req.user.email ? req.user.email : null,
          reporterPhone: null,
          source: 'user',
          imagePaths: relPaths,
        }).catch(() => {});

        res.status(201).json({ ok: true, id: incId });
      } catch (e) {
        console.error('[incident create]', e);
        res.status(500).json({ message: e.message || 'Lỗi' });
      }
    });
  });

  router.patch('/:id/incidents/:incidentId/assign', authMiddleware, moduleViewerMw, express.json(), (req, res) => {
    if (!canManageEquipmentIncidents(req)) return res.status(403).json({ message: 'Không có quyền' });
    try {
      const eqId = parseEquipmentId(req.params.id);
      const incId = parseIncidentId(req.params.incidentId);
      if (!eqId || !incId) return res.status(400).json({ message: 'ID không hợp lệ' });
      const inc = db.prepare('SELECT * FROM equipment_incidents WHERE id = ? AND equipment_id = ?').get(incId, eqId);
      if (!inc) return res.status(404).json({ message: 'Không tìm thấy' });
      const assigned_to = parseInt(req.body && req.body.assigned_to, 10);
      if (!Number.isFinite(assigned_to)) return res.status(400).json({ message: 'assigned_to không hợp lệ' });
      db.prepare(`UPDATE equipment_incidents SET assigned_to = ?, status = 'assigned' WHERE id = ?`).run(assigned_to, incId);
      notifyUserId(
        db,
        assigned_to,
        'equip_incident_assign',
        'Bạn được phân công xử lý sự cố thiết bị',
        'equipment #' + eqId,
        `/public/equipment/detail.html?id=${eqId}`
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.patch('/:id/incidents/:incidentId/resolve', authMiddleware, moduleViewerMw, resolveBodyMiddleware, async (req, res) => {
    if (!canManageEquipmentIncidents(req)) return res.status(403).json({ message: 'Không có quyền' });
    try {
      const eqId = parseEquipmentId(req.params.id);
      const incId = parseIncidentId(req.params.incidentId);
      if (!eqId || !incId) return res.status(400).json({ message: 'ID không hợp lệ' });
      const inc = db.prepare('SELECT * FROM equipment_incidents WHERE id = ? AND equipment_id = ?').get(incId, eqId);
      if (!inc) return res.status(404).json({ message: 'Không tìm thấy' });
      const b = req.body || {};
      const resolution_note = String(b.resolution_note || '').trim();
      if (!resolution_note) return res.status(400).json({ message: 'Thiếu ghi chú xử lý' });
      const cost = b.cost != null && String(b.cost).trim() !== '' ? Number(b.cost) : null;
      const repair_type = b.repair_type && ['internal', 'external'].includes(String(b.repair_type)) ? String(b.repair_type) : null;
      const vendor_note = b.vendor_note != null ? String(b.vendor_note).slice(0, 2000) : null;
      const invoice_ref = b.invoice_ref != null ? String(b.invoice_ref).slice(0, 500) : null;
      const proposal_ref = b.proposal_ref != null ? String(b.proposal_ref).slice(0, 500) : null;

      let prevPaths = [];
      try {
        prevPaths = inc.resolution_attachment_paths ? JSON.parse(inc.resolution_attachment_paths) : [];
      } catch (_) {
        prevPaths = [];
      }
      if (!Array.isArray(prevPaths)) prevPaths = [];
      const addPaths = [];
      for (const f of req.files || []) {
        const base = path.basename(f.path);
        const rel = path.join('equipment', String(eqId), 'incidents', String(incId), 'resolution', base).replace(/\\/g, '/');
        addPaths.push(rel);
      }
      const mergedPathArr = [...prevPaths, ...addPaths];
      const mergedPaths = JSON.stringify(mergedPathArr);

      db.prepare(
        `UPDATE equipment_incidents SET status = 'resolved', resolution_note = ?, resolved_at = datetime('now'), cost = ?, repair_type = ?,
         vendor_note = ?, invoice_ref = ?, proposal_ref = ?, resolution_attachment_paths = ?
         WHERE id = ?`
      ).run(resolution_note, cost, repair_type, vendor_note, invoice_ref, proposal_ref, mergedPaths, incId);
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(eqId);
      if (eq && eq.status === 'broken') {
        db.prepare(`UPDATE equipments SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(eqId);
        db.prepare(
          `INSERT INTO equipment_status_logs (equipment_id, old_status, new_status, changed_by, note) VALUES (?,?,?,?,?)`
        ).run(eqId, 'broken', 'active', req.user.id, 'Sự cố đã xử lý');
      }
      if (inc.reported_by) {
      notifyUserId(
        db,
        inc.reported_by,
        'equip_incident_resolved',
        'Sự cố thiết bị đã được xử lý',
        resolution_note.slice(0, 160),
        `/public/equipment/detail.html?id=${eqId}`
      );
      }
      notifyEquipmentModuleAccessUsers(
        db,
        'equip_incident_resolved',
        'Sự cố đã xử lý (module)',
        `${eq && eq.equipment_code ? eq.equipment_code : ''} #${incId}`,
        `/public/equipment/detail.html?id=${eqId}`
      );
      notifyAdmins(db, 'equip_incident_resolved', 'Sự cố thiết bị đã xử lý', `${eq.equipment_code} — #${incId}`, `/public/equipment/detail.html?id=${eqId}`);
      db.prepare(
        `UPDATE app_notifications
         SET read_at = COALESCE(read_at, datetime('now'))
         WHERE module = 'equipment' AND event_type = 'equip_incident' AND body LIKE ?`
      ).run(`%#${incId}%`);
      const latestInc = db.prepare('SELECT resolved_at FROM equipment_incidents WHERE id = ?').get(incId);
      const mailResult = await sendResolvedIncidentEmail(eq, incId, {
        resolution_note,
        resolved_by: req.user && req.user.fullname ? req.user.fullname : req.user && req.user.email ? req.user.email : null,
        resolved_at: latestInc && latestInc.resolved_at ? latestInc.resolved_at : null,
        cost,
        repair_type,
        vendor_note,
        invoice_ref,
        proposal_ref,
        resolution_attachment_paths: mergedPathArr,
      });
      res.json({
        ok: true,
        emailSent: !!(mailResult && mailResult.ok),
        emailReason: mailResult && mailResult.reason ? String(mailResult.reason) : null,
      });
    } catch (e) {
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  router.get('/:id/incidents/:incidentId/attachment/:kind/:seq', authMiddleware, moduleViewerMw, (req, res) => {
    try {
      const eqId = parseEquipmentId(req.params.id);
      const incId = parseIncidentId(req.params.incidentId);
      const seq = parseInt(req.params.seq, 10);
      const kind = String(req.params.kind || '').toLowerCase();
      if (!eqId || !incId || !Number.isFinite(seq) || seq < 0) {
        return res.status(400).json({ message: 'Tham số không hợp lệ' });
      }
      if (!['report', 'resolve'].includes(kind)) return res.status(400).json({ message: 'kind không hợp lệ' });
      const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(eqId);
      const chk = canViewEquipmentDetail(req, eq, db);
      if (!chk.ok) return res.status(chk.status).json({ message: 'Không có quyền' });
      const inc = db.prepare('SELECT * FROM equipment_incidents WHERE id = ? AND equipment_id = ?').get(incId, eqId);
      if (!inc) return res.status(404).json({ message: 'Không tìm thấy' });
      let arr = [];
      try {
        const raw = kind === 'resolve' ? inc.resolution_attachment_paths : inc.photo_paths;
        arr = raw ? JSON.parse(raw) : [];
      } catch (_) {
        arr = [];
      }
      if (!Array.isArray(arr)) arr = [];
      const rel = arr[seq];
      if (!rel || typeof rel !== 'string') return res.status(404).json({ message: 'Không có file' });
      const relNorm = rel.replace(/\\/g, '/').replace(/^\//, '');
      const abs = path.join(uploadsRootResolved, relNorm);
      const normalized = path.normalize(abs);
      const rootNorm = path.normalize(uploadsRootResolved);
      if (!normalized.startsWith(rootNorm) || !fs.existsSync(normalized)) {
        return res.status(404).json({ message: 'File không tồn tại' });
      }
      const ext = path.extname(normalized).toLowerCase();
      const ct =
        ext === '.pdf'
          ? 'application/pdf'
          : ext === '.png'
            ? 'image/png'
            : ext === '.webp'
              ? 'image/webp'
              : 'image/jpeg';
      res.setHeader('Content-Type', ct);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(normalized))}"`);
      return res.sendFile(normalized);
    } catch (e) {
      console.error('[incident attachment]', e);
      res.status(500).json({ message: e.message || 'Lỗi' });
    }
  });

  /** Thay thế phiên bản tài liệu */
  router.post(
    '/:id/documents/:docId/replace',
    authMiddleware,
    moduleViewerMw,
    (req, res, next) => {
      if (!canManageEquipment(req)) return res.status(403).json({ message: 'Không có quyền' });
      if (!parseEquipmentId(req.params.id) || !parseEquipmentId(req.params.docId)) {
        return res.status(400).json({ message: 'ID không hợp lệ' });
      }
      next();
    },
    (req, res) => {
      uploadPdfReplace.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ message: err.message || 'Lỗi upload' });
        try {
          const id = parseEquipmentId(req.params.id);
          const oldId = parseEquipmentId(req.params.docId);
          const old = db.prepare('SELECT * FROM equipment_documents WHERE id = ? AND equipment_id = ?').get(oldId, id);
          if (!old) return res.status(404).json({ message: 'Không tìm thấy tài liệu gốc' });
          if (!req.file) return res.status(400).json({ message: 'Thiếu file PDF' });
          const relPath = path.join('equipment', String(id), 'docs', req.file.filename).replace(/\\/g, '/');
          const st = fs.statSync(req.file.path);
          const title = String((req.body && req.body.title) || old.title).trim();
          const version = req.body && req.body.version != null ? String(req.body.version).slice(0, 64) : old.version;
          const notes = req.body && req.body.notes != null ? String(req.body.notes).slice(0, 4000) : old.notes;
          const access_level = ['internal', 'institute', 'public'].includes(String(req.body && req.body.access_level))
            ? String(req.body.access_level)
            : old.access_level;

          db.prepare(`UPDATE equipment_documents SET is_current = 0 WHERE id = ?`).run(oldId);
          const ins = db
            .prepare(
              `INSERT INTO equipment_documents (
                equipment_id, doc_type, title, file_path, file_size, version, notes, access_level, uploaded_by, is_disabled, is_current, supersedes_id
              ) VALUES (?,?,?,?,?,?,?,?,?,0,1,?)`
            )
            .run(
              id,
              old.doc_type,
              title,
              relPath,
              st.size,
              version,
              notes,
              access_level,
              req.user.id,
              oldId
            );
          const newDocId = ins.lastInsertRowid;
          db.prepare(
            `INSERT INTO equipment_document_logs (equipment_id, document_id, action, performed_by, note)
             VALUES (?,?,?,?,?)`
          ).run(id, newDocId, 'replace', req.user.id, 'Thay thế từ doc #' + oldId);
          db.prepare(`UPDATE equipments SET updated_at = datetime('now') WHERE id = ?`).run(id);
          const eq = db.prepare('SELECT * FROM equipments WHERE id = ?').get(id);
          notifyEquipmentStakeholders(
            db,
            eq,
            'equip_doc_replace',
            'Tài liệu thiết bị được thay phiên bản',
            title,
            `/public/equipment/detail.html?id=${id}`
          );
          const doc = db.prepare('SELECT * FROM equipment_documents WHERE id = ?').get(newDocId);
          res.status(201).json({ ok: true, document: doc });
        } catch (e) {
          console.error('[doc replace]', e);
          res.status(500).json({ message: e.message || 'Lỗi' });
        }
      });
    }
  );
}

module.exports = {
  registerEquipmentPart2,
  maintenanceBadgeForRow,
  daysUntilIsoDate,
  extractYoutubeId,
  detectPlatformFromUrl,
  notifyEquipmentStakeholders,
  notifyAdmins,
  generateEquipmentCode,
};
